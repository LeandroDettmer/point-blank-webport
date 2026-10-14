// Live check of the Cross clan menu's requests (pages/clan.ts) against the real server (Docker + server), no browser:
// two brand-new accounts; A makes a clan, B asks to join, A accepts, B sees the clan, A changes the notice, B leaves, A dissolves.
// Also the create rule (B has no rank / gold: 0x8000104a). Usage (stack up: npm run dev:all):
//   node src/net/test/clanMenu.live.ts [--gw ws://127.0.0.1:8090] [--api http://127.0.0.1:8090]
import { execFileSync } from "node:child_process";
import { AuthClient, gameTargetForServer } from "../authClient.ts";
import { GameClient } from "../gameClient.ts";
import { collectEnterPushes, type EnterPushes } from "../metaGame.ts";
import { ClanClient, ClanErr, type ClanEvent, type ClanReply } from "../clanClient.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const GW = arg("--gw", "ws://127.0.0.1:8090");
const API = arg("--api", "http://127.0.0.1:8090");
const t0 = Date.now();
const log = (who: string, msg: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s [${who}] ${msg}`);
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => { results.push({ name, ok, detail }); log(ok ? "PASS" : "FAIL", `${name}: ${detail}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  if (!r.ok) throw new Error(`${what}: err 0x${(r.err >>> 0).toString(16)}`);
  return r.data as T;
};

async function main(): Promise<void> {
  const tag = Date.now().toString(36).slice(-6);
  const nameA = `ca${tag}`, nameB = `cb${tag}`, clanName = `Clan${tag}`;
  const tokenA = await account(nameA), tokenB = await account(nameB);
  sql(`UPDATE accounts SET rank=15, gold=25000 WHERE username='${nameA}'`);
  const A = await enter("A", tokenA), B = await enter("B", tokenB);

  const low = await B.clan.create("NoRank" + tag, "");
  check("create rule: B without rank/gold", !low.ok && low.err === ClanErr.CREATE_CONDITION, `err 0x${(low.err >>> 0).toString(16)}`);

  // the server refuses a clan without an emblem (create: logo 0 -> 0x80000000); a random one avoids the "logo already used" refusal
  const created = ok(await A.clan.create(clanName, "intro live", 1 + Math.floor(Math.random() * 0xfffffff)), "A create");
  check("A creates clan", created.id > 0 && created.name === clanName, `id ${created.id} name ${created.name}`);
  const cid = created.id;

  const eA = ok(await A.clan.enter(), "A enter");
  check("A is leader after create", eA.clanId === cid && eA.access === 1, `clanId ${eA.clanId} access ${eA.access}`);

  const d0 = ok(await A.clan.detail(cid), "A detail");
  check("detail: name, owner, intro", d0.name === clanName && d0.info === "intro live", `${d0.name} / ${d0.info}`);

  const eB0 = ok(await B.clan.enter(), "B enter");
  check("B outside before join", eB0.clanId === 0 && eB0.access === 0 && eB0.list !== null, `clanId ${eB0.clanId} access ${eB0.access}`);

  ok(await B.clan.requestJoin(cid, "quero entrar"), "B requestJoin");
  const eB1 = ok(await B.clan.enter(), "B enter pending");
  check("B pending request", eB1.clanId === cid && eB1.access === 0, `clanId ${eB1.clanId} access ${eB1.access}`);

  const reqs = ok(await A.clan.requestList(0), "A requestList");
  check("A sees B's request", reqs.requests.some((q) => q.playerId === B.playerId), `${reqs.requests.length} request(s)`);

  const acc = ok(await A.clan.accept([B.playerId]), "A accept");
  check("A accepts B", acc.count === 1, `count ${acc.count}`);
  await sleep(300);
  check("B gets 824 accept result", B.events.some((e) => e.type === "accept-result" && e.clan.id === cid), `events ${B.events.map((e) => e.type).join(",")}`);

  const eB2 = ok(await B.clan.enter(), "B enter member");
  check("B is member", eB2.clanId === cid && eB2.access === 3, `clanId ${eB2.clanId} access ${eB2.access}`);

  const mem = ok(await A.clan.memberList(0), "A memberList");
  check("A sees 2 members", mem.members.length === 2 && mem.members.some((m) => m.playerId === B.playerId), `${mem.members.length} member(s)`);

  ok(await A.clan.replaceNotice("aviso live"), "A notice");
  const d1 = ok(await A.clan.detail(cid), "A detail after notice");
  check("notice saved", d1.news === "aviso live", `news "${d1.news}"`);

  const denied = await B.clan.replaceNotice("sem permissao");
  check("member cannot write notice", !denied.ok, `err 0x${(denied.err >>> 0).toString(16)}`);

  ok(await B.clan.secede(), "B secede");
  const eB3 = ok(await B.clan.enter(), "B enter after secede");
  check("B left the clan", eB3.clanId === 0 && eB3.access === 0, `clanId ${eB3.clanId}`);

  ok(await A.clan.close(), "A close");
  const eA2 = ok(await A.clan.enter(), "A enter after close");
  check("clan dissolved", eA2.clanId === 0, `clanId ${eA2.clanId}`);

  for (const s of [A, B]) s.game.conn.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
  if (bad.length) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error("FATAL", e); process.exit(1); });
