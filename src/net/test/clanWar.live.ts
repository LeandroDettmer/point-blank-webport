// Live check of the clan-war teams (etapa A) against the real server (Docker + server), no browser: two brand-new accounts in
// one clan. A (leader) makes the clan, B joins it, A creates a team, B joins the team, A's max per 1 is refused with 2 seated,
// B leaves, A sets max 1, B's join is refused (full), A lists the team. Usage (stack up: npm run dev:all):
//   node src/net/test/clanWar.live.ts [--gw ws://127.0.0.1:8090] [--api http://127.0.0.1:8090]
import { execFileSync } from "node:child_process";
import { AuthClient, gameTargetForServer } from "../authClient.ts";
import { GameClient } from "../gameClient.ts";
import { collectEnterPushes, type EnterPushes } from "../metaGame.ts";
import { ClanClient, type ClanReply } from "../clanClient.ts";
import { ClanWarClient, ClanWarErr, type ClanWarEvent, type ClanWarReply, type TeamRoster } from "../clanWarClient.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const GW = arg("--gw", "ws://127.0.0.1:8090");
const API = arg("--api", "http://127.0.0.1:8090");
const t0 = Date.now();
const log = (who: string, msg: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s [${who}] ${msg}`);
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => { results.push({ name, ok, detail }); log(ok ? "PASS" : "FAIL", `${name}: ${detail}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (v: number) => `0x${(v >>> 0).toString(16)}`;

function sql(q: string): void {
  execFileSync("docker", ["exec", "pb-postgres-local", "psql", "-U", "postgres", "-d", "pb", "-At", "-c", q], { encoding: "utf8" });
}

async function account(username: string): Promise<Uint8Array> {
  const res = await fetch(`${API}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "clanwar-live-pw1" }) });
  const body = (await res.json()) as { token?: string; error?: string };
  if (res.status !== 201 || !body.token) throw new Error(`register ${username}: ${res.status} ${body.error ?? ""}`);
  return Uint8Array.from(Buffer.from(body.token, "base64"));
}

interface Session { game: GameClient; clan: ClanClient; team: ClanWarClient; teamEvents: ClanWarEvent[]; username: string; playerId: bigint }

// system_servers: server 3 is the Clan server (system_channels type Clan, ids 0..9); clan channels need clanId != 0 at select
const PUBLIC_SERVER = 1, PUBLIC_CHANNEL = 0, CLAN_SERVER = 3, CLAN_CHANNEL = 0;

async function enter(who: string, token: Uint8Array, serverIndex: number, channelId: number): Promise<Session> {
  await sleep(1200); // the auth drops a 2nd login from the same IP within 1 s (authServer.ts handleLogin)
  const auth = new AuthClient(GW);
  const mac = crypto.getRandomValues(new Uint8Array(6));
  mac[0] = (mac[0] & 0xfe) | 2;
  const login = await auth.connectAndLogin({ token, mac });
  if (!login.ok) throw new Error(`${who}: login ${login.errorName}`);
  const servers = await auth.getServers();
  const server = servers.find((s) => s.index === serverIndex)!;
  await auth.leave();
  const game = new GameClient(gameTargetForServer(server), GW);
  let pushes: Promise<EnterPushes> | null = null;
  const connect = game.conn.connect.bind(game.conn);
  game.conn.connect = async (...a) => { const i = await connect(...a); pushes = collectEnterPushes(game.conn).done; return i; };
  await game.enter(login.username, login.playerId, server.index);
  await pushes!;
  await game.selectChannel(channelId);
  await game.enterLobby();
  const clan = new ClanClient(game.conn);
  const team = new ClanWarClient(game.conn);
  const teamEvents: ClanWarEvent[] = [];
  team.on((ev) => teamEvents.push(ev));
  log(who, `in lobby as ${login.username}`);
  return { game, clan, team, teamEvents, username: login.username, playerId: BigInt(login.playerId) };
}

const ok = <T>(r: ClanReply<T> | ClanWarReply<T>, what: string): T => {
  if (!r.ok) throw new Error(`${what}: err ${hex(r.err)}`);
  return r.data as T;
};
const lastRoster = (s: Session): TeamRoster | null => {
  const ev = [...s.teamEvents].reverse().find((e) => e.type === "roster");
  return ev?.type === "roster" ? ev.roster : null;
};

async function main(): Promise<void> {
  const tag = Date.now().toString(36).slice(-6);
  const nameA = `wa${tag}`, nameB = `wb${tag}`, clanName = `War${tag}`;
  const tokenA = await account(nameA), tokenB = await account(nameB);
  sql(`UPDATE accounts SET rank=15, gold=25000 WHERE username='${nameA}'`);
  let A = await enter("A", tokenA, PUBLIC_SERVER, PUBLIC_CHANNEL), B = await enter("B", tokenB, PUBLIC_SERVER, PUBLIC_CHANNEL);

  const created = ok(await A.clan.create(clanName, "guerra live"), "A create clan");
  const cid = created.id;
  ok(await B.clan.requestJoin(cid, "quero entrar"), "B requestJoin");
  ok(await A.clan.accept([B.playerId]), "A accept B");
  await sleep(300);
  const eB = ok(await B.clan.enter(), "B enter member");
  check("setup: B is a member of the clan", eB.clanId === cid && eB.access === 3, `clanId ${eB.clanId} access ${eB.access}`);

  // the clan channel needs the clan: reconnect both on server 3 now that the membership is stored
  for (const s of [A, B]) s.game.conn.close();
  await sleep(1500);
  A = await enter("A", tokenA, CLAN_SERVER, CLAN_CHANNEL);
  B = await enter("B", tokenB, CLAN_SERVER, CLAN_CHANNEL);

  const t = ok(await A.team.create(8), "A create team");
  check("create: A's team, 1 seated, capacity 8", t.count === 1 && t.capacity === 8, JSON.stringify({ matchId: t.matchId, squad: t.squad, count: t.count }));

  await sleep(200);
  const rA = lastRoster(A);
  check("create: A gets roster push (1 member)", rA?.members.length === 1 && rA.localSeat === 0, `members ${rA?.members.length} localSeat ${rA?.localSeat}`);

  const list1 = ok(await B.team.list(), "B list");
  const seen = list1.teams.find((x) => x.matchId === t.matchId);
  check("list: B sees A's team (total 1)", !!seen && list1.total === 1, `teams ${list1.teams.length} total ${list1.total} pages ${list1.pages}`);

  const roster = ok(await B.team.join(t.matchId), "B join team");
  check("join: B seated in 2nd seat, leader A", roster.count === 2 && roster.localSeat === 1 && roster.leader === 0 && roster.clanName === clanName, `count ${roster.count} localSeat ${roster.localSeat} leader ${roster.leader}`);
  await sleep(200);
  check("join: A gets roster push (2 members)", lastRoster(A)?.members.length === 2, `members ${lastRoster(A)?.members.length}`);

  const tooSmall = await A.team.setMaxPer(1);
  check("max per 1 refused with 2 seated", !tooSmall.ok && tooSmall.err === ClanWarErr.FAIL, hex(tooSmall.err));

  const left = ok(await B.team.leave(), "B leave");
  check("leave: B out, team stays (leftSeat 1, leader 0)", left.disbanded === false && left.leftSeat === 1 && left.leaderSeat === 0, JSON.stringify(left));
  await sleep(200);

  const max1 = ok(await A.team.setMaxPer(1), "A max 1");
  check("max per 1 accepted with 1 seated", max1 === 1, `max ${max1}`);

  const full = await B.team.join(t.matchId);
  check("join refused: team full at max 1", !full.ok && full.err === ClanWarErr.FAIL, hex(full.err));

  const list2 = ok(await A.team.list(), "A list");
  const after = list2.teams.find((x) => x.matchId === t.matchId);
  check("list: A sees capacity 1, count 1", after?.capacity === 1 && after.count === 1, JSON.stringify(after));

  const gone = ok(await A.team.leave(), "A leave");
  check("leave: last member disbands the team", gone.disbanded === true && gone.leaderSeat === -1, JSON.stringify(gone));
  const list3 = ok(await A.team.list(), "A list after disband");
  check("list: empty after disband", list3.total === 0 && list3.teams.length === 0, `total ${list3.total}`);

  ok(await A.clan.close(), "A close clan");

  for (const s of [A, B]) s.game.conn.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
  if (bad.length) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error("FATAL", e); process.exit(1); });
