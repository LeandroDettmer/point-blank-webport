// Live check of the clan roster and the user menu against the real server (Docker + server), no browser: three brand-new
// accounts. A (rank 15, gold) makes a clan; A invites B (staff invite, 2426 -> 888 -> 889, B accepts 890); B (regular member)
// tries to invite C and is refused by the authority rule (clanHandlers.ts handleInvite, staff = clanAccess 1|2 or owner);
// A invites C and kicks it (deport); A makes B the new owner (commissionMaster: B access 1, A staff 2); B whispers A (PM,
// 1826 -> 1830); B adds A as a friend (1811). Usage (stack up: npm run dev:all):
//   node src/net/test/clanRoster.live.ts [--gw ws://127.0.0.1:8090] [--api http://127.0.0.1:8090]
// Exit 0 = pass.
import { execFileSync } from "node:child_process";
import { AuthClient, gameTargetForServer } from "../authClient.ts";
import { GameClient } from "../gameClient.ts";
import { collectEnterPushes, type EnterPushes } from "../metaGame.ts";
import { ClanClient, type ClanEvent, type ClanReply } from "../clanClient.ts";
import { findUser, requestFriend } from "../friendClient.ts";
import { PacketWriter } from "../packet.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const GW = arg("--gw", "ws://127.0.0.1:8090");
const API = arg("--api", "http://127.0.0.1:8090");
const t0 = Date.now();
const log = (who: string, msg: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s [${who}] ${msg}`);
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => { results.push({ name, ok, detail }); log(ok ? "PASS" : "FAIL", `${name}: ${detail}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;
const AUTHORITY_REFUSED = 0x80000000;
const PM_ACK = 1830, PM_REQ = 1826;

function sql(q: string): void {
  execFileSync("docker", ["exec", "pb-postgres-local", "psql", "-U", "postgres", "-d", "pb", "-At", "-c", q], { encoding: "utf8" });
}

async function account(username: string): Promise<Uint8Array> {
  const res = await fetch(`${API}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "clan-live-pw1" }) });
  const body = (await res.json()) as { token?: string; error?: string };
  if (res.status !== 201 || !body.token) throw new Error(`register ${username}: ${res.status} ${body.error ?? ""}`);
  return Uint8Array.from(Buffer.from(body.token, "base64"));
}

interface Session { game: GameClient; clan: ClanClient; events: ClanEvent[]; username: string; playerId: bigint }

async function enter(who: string, token: Uint8Array): Promise<Session> {
  await sleep(1200); // the auth drops a 2nd login from the same IP within 1 s (authServer.ts handleLogin)
  const auth = new AuthClient(GW);
  const mac = crypto.getRandomValues(new Uint8Array(6));
  mac[0] = (mac[0] & 0xfe) | 2;
  const login = await auth.connectAndLogin({ token, mac });
  if (!login.ok) throw new Error(`${who}: login ${login.errorName}`);
  const servers = await auth.getServers();
  const server = servers.find((s) => s.index > 0)!;
  await auth.leave();
  const game = new GameClient(gameTargetForServer(server), GW);
  let pushes: Promise<EnterPushes> | null = null;
  const connect = game.conn.connect.bind(game.conn);
  game.conn.connect = async (...a) => { const i = await connect(...a); pushes = collectEnterPushes(game.conn).done; return i; };
  await game.enter(login.username, login.playerId, server.index);
  await pushes!;
  await game.selectChannel(0);
  await game.enterLobby();
  const clan = new ClanClient(game.conn);
  const events: ClanEvent[] = [];
  clan.on((ev) => events.push(ev));
  log(who, `in lobby as ${login.username}`);
  return { game, clan, events, username: login.username, playerId: BigInt(login.playerId) };
}

const ok = <T>(r: ClanReply<T>, what: string): T => {
  if (!r.ok) throw new Error(`${what}: err ${hex(r.err)}`);
  return r.data as T;
};

async function main(): Promise<void> {
  const tag = Date.now().toString(36).slice(-6);
  const nameA = `ra${tag}`, nameB = `rb${tag}`, nameC = `rc${tag}`, clanName = `Roster${tag}`;
  const tokenA = await account(nameA), tokenB = await account(nameB), tokenC = await account(nameC);
  // before the logins: the server keeps the account in memory from login (commission needs the target's rank > 10)
  sql(`UPDATE accounts SET rank=15, gold=25000 WHERE username='${nameA}'`);
  sql(`UPDATE accounts SET rank=15 WHERE username='${nameB}'`);
  const A = await enter("A", tokenA), B = await enter("B", tokenB), C = await enter("C", tokenC);

  const created = ok(await A.clan.create(clanName, "roster live", 1 + Math.floor(Math.random() * 0xfffffff)), "A create");
  const cid = created.id;
  check("A creates clan", cid > 0, `id ${cid}`);

  // invite (staff): 2426 finds B by nick (sets findPlayer), 888 -> 889 with the result; B accepts (890)
  check("A finds B by nick", await findUser(A.game.conn, nameB), nameB);
  const invB = await A.clan.invite();
  check("staff A invites B (889 ok)", invB.ok, `err ${hex(invB.err)}`);
  const accB = await B.clan.inviteAccept(cid, true);
  check("B accepts the invite", accB.ok, `err ${hex(accB.err)}`);
  const eB = ok(await B.clan.enter(), "B enter");
  check("B is a member (access 3)", eB.clanId === cid && eB.access === 3, `clanId ${eB.clanId} access ${eB.access}`);

  // authority: B is a regular member, so the invite is refused (0x80000000) even for a clanless target
  check("B finds C by nick", await findUser(B.game.conn, nameC), nameC);
  const badInv = await B.clan.invite();
  check("regular member B cannot invite C", !badInv.ok && badInv.err === AUTHORITY_REFUSED, `err ${hex(badInv.err)}`);

  // kick: A invites C (staff), C accepts, A deports C (2426 is limited to 1 per second per player: profileHandlers.ts)
  await sleep(1100);
  check("A finds C by nick",await findUser(A.game.conn, nameC), nameC);
  ok(await A.clan.invite(), "A invites C");
  ok(await C.clan.inviteAccept(cid, true), "C accepts");
  const eC = ok(await C.clan.enter(), "C enter");
  check("C is a member", eC.clanId === cid, `clanId ${eC.clanId}`);
  const kick = ok(await A.clan.deport([C.playerId]), "A deports C");
  check("A kicks C (count 1)", kick.count === 1, `count ${kick.count}`);
  const eC2 = ok(await C.clan.enter(), "C enter after kick");
  check("C is out after the kick", eC2.clanId === 0, `clanId ${eC2.clanId}`);

  // new owner: the owner passes the clan to a staff member with rank > 10 (clanHandlers.ts handleCommissionMaster); A drops to staff
  ok(await A.clan.commissionStaff([B.playerId]), "A makes B staff");
  ok(await A.clan.commissionMaster(B.playerId), "A makes B owner");
  const eA = ok(await A.clan.enter(), "A enter after new owner");
  const eB2 = ok(await B.clan.enter(), "B enter after new owner");
  check("B is the new owner (access 1)", eB2.clanId === cid && eB2.access === 1, `B access ${eB2.access}`);
  check("A is staff now (access 2)", eA.clanId === cid && eA.access === 2, `A access ${eA.access}`);

  // PM: B whispers A (1826 -> 1830 at A)
  const pmText = `oi ${tag}`;
  const pmGot = A.game.conn.waitFor(PM_ACK, 5000);
  B.game.conn.send(PM_REQ, new PacketWriter(96 + pmText.length * 2).writeU(nameA, 66).writeH(pmText.length).writeU(pmText, pmText.length * 2));
  const pm = await pmGot.then(() => true).catch(() => false);
  check("B whispers A (1830 at A)", pm, pm ? `text "${pmText}"` : "no 1830");

  // add friend: B adds A (1811); A's list gets it
  const add = await requestFriend(B.game.conn, nameA);
  check("B adds A as friend (0)", add === 0, `err ${hex(add)}`);

  for (const s of [A, B, C]) s.game.conn.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
  if (bad.length) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error("FATAL", e); process.exit(1); });
