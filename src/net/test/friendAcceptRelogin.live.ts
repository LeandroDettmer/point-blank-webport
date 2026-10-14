// Live check of the Comunidade accept (1816 by list index) after a relogin, against the real server (Docker + server).
// The user's case: A asks B by nick in session 1; both log out; both log in again (Auth 2320 -> 1810 fills the singleton
// `friendList` the page reads, then the Game enter); B accepts A at the index of its login list (what community.ts sends).
// Then A's list must show B as a friend and the DB rows must both be state 0.
// --extra N: N more accounts ask B in session 1 while B is online (the server appends each row to B's in-memory list, the
// DB keeps id order); B accepts one of them at its live index before the logout, so the relogin list is the DB order.
// --room 1: B leads a room before the accept (A's row must show the room). --server-a / --server-b: 1 vs 3 = cross-server.
// Usage (stack up: npm run dev:all):
//   node src/net/test/friendAcceptRelogin.live.ts [--gw ws://127.0.0.1:8090] [--api http://127.0.0.1:8090] [--server-a 1] [--server-b 3] [--room 0|1] [--extra 0]
// Exit 0 = pass.
import { execSync } from "node:child_process";
import { AuthClient, gameTargetForServer } from "../authClient.ts";
import { GameClient } from "../gameClient.ts";
import { collectEnterPushes, type EnterPushes } from "../metaGame.ts";
import { FriendList, FriendState, type FriendEntry, acceptFriend, friendList, requestFriend } from "../friendClient.ts";
import { RoomClient } from "../roomClient.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const GW = arg("--gw", "ws://127.0.0.1:8090");
const API = arg("--api", "http://127.0.0.1:8090");
const SERVER_A = Number(arg("--server-a", "1")), SERVER_B = Number(arg("--server-b", "3"));
const ROOM = arg("--room", "0") === "1";
const EXTRA = Number(arg("--extra", "0"));
const t0 = Date.now();
const log = (who: string, msg: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s [${who}] ${msg}`);
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => { results.push({ name, ok, detail }); log(ok ? "PASS" : "FAIL", `${name}: ${detail}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;
const top = (status: number) => status >>> 28;
const isPending = (f: FriendEntry | undefined) => !!f && (top(f.status) === FriendState.SENT || top(f.status) === FriendState.RECEIVED);
const show = (l: FriendEntry[]) => l.map((f) => f ? `${f.nick}:${hex(f.status)}` : "-").join(" ");

interface Player { who: string; token: Uint8Array; server: number; nick: string; game: GameClient | null; login: FriendEntry[]; list: FriendList }

async function account(username: string): Promise<Uint8Array> {
  const res = await fetch(`${API}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "friend-live-pw1" }) });
  const body = (await res.json()) as { token?: string; error?: string };
  if (res.status !== 201 || !body.token) throw new Error(`register ${username}: ${res.status} ${body.error ?? ""}`);
  return Uint8Array.from(Buffer.from(body.token, "base64"));
}

/** one login as the page does it: Auth 2320 (the 1810 list goes to the singleton `friendList`), then the Game enter */
async function logIn(p: Player): Promise<void> {
  await sleep(1200); // the auth drops a 2nd login from the same IP within 1 s (authServer.ts handleLogin)
  const auth = new AuthClient(GW);
  const mac = crypto.getRandomValues(new Uint8Array(6));
  mac[0] = (mac[0] & 0xfe) | 2;
  const login = await auth.connectAndLogin({ token: p.token, mac });
  if (!login.ok) throw new Error(`${p.who}: login ${login.errorName}`);
  await auth.fetchMeta();
  p.login = friendList.list.slice();
  const server = (await auth.getServers()).find((s) => s.index === p.server);
  if (!server) throw new Error(`${p.who}: server ${p.server} not in the Auth list`);
  await auth.leave();
  const game = new GameClient(gameTargetForServer(server), GW);
  let pushes: Promise<EnterPushes> | null = null;
  const connect = game.conn.connect.bind(game.conn);
  game.conn.connect = async (...a) => { const i = await connect(...a); pushes = collectEnterPushes(game.conn).done; return i; };
  await game.enter(login.username, login.playerId, server.index);
  await pushes!;
  await game.selectChannel(0);
  await game.enterLobby();
  p.game = game;
  p.nick = login.username;
  p.list = new FriendList();
  p.list.attach(game.conn);
  await sleep(1100); // the server refuses a friend request sent < 1 s after the account is built (friendInvite throttle, 0x80001037)
  log(p.who, `in lobby as ${login.username}, login list: ${show(p.login)}`);
}

async function logOut(p: Player): Promise<void> {
  p.list.detach();
  p.game?.conn.close();
  p.game = null;
}

/** waits until `fn` is true (the pushes arrive after the request's ack) */
async function until(fn: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(50); }
  return fn();
}

const dbState = (a: string, b: string): string => execSync(
  `docker exec pb-postgres-local psql -U postgres -d pb -tA -c "SELECT f.state || ',' || f.removed FROM player_friends f JOIN accounts x ON x.player_id=f.owner_id JOIN accounts y ON y.player_id=f.id WHERE x.nickname='${a}' AND y.nickname='${b}'"`,
  { encoding: "utf8" }).trim();

async function main(): Promise<void> {
  const tag = Date.now().toString(36).slice(-6);
  const mk = async (who: string, name: string, server: number): Promise<Player> => ({ who, token: await account(name), server, nick: "", game: null, login: [], list: new FriendList() });
  const A = await mk("A", `ra${tag}`, SERVER_A);
  const B = await mk("B", `rb${tag}`, SERVER_B);
  // the clan server lets in only an account with a clan: give B one (as friendList.live.ts does on server 3)
  if (SERVER_B === 3) execSync(`docker exec pb-postgres-local psql -U postgres -d pb -q -c "UPDATE accounts SET clan_id=(SELECT max(id) FROM system_clan) WHERE nickname='rb${tag}'"`);

  // Session 1: B is online first. The extra requesters ask first and A last, so B's live list appends them in request order
  // while the DB keeps id order (A has the smaller id: created before the extras)
  await logIn(B);
  for (let i = 0; i < EXTRA; i++) {
    const X = await mk(`X${i}`, `rx${i}${tag}`, SERVER_A);
    await logIn(X);
    check(`session 1: X${i} asks B`, (await requestFriend(X.game!.conn, B.nick)) === 0, `request from ${X.nick}`);
    await logOut(X);
  }
  await logIn(A);
  const sent = await requestFriend(A.game!.conn, B.nick);
  check("session 1: A asks B", sent === 0, `request to ${B.nick}, err ${hex(sent)}`);
  const received = () => B.list.list.filter((f) => !!f && top(f.status) === FriendState.RECEIVED).length;
  await until(() => received() === 1 + EXTRA);
  check("session 1: B's live list has every request", received() === 1 + EXTRA, `B live list: ${show(B.list.list)}`);
  if (EXTRA > 0) {
    const liveX = B.list.list.findIndex((f) => !!f && top(f.status) === FriendState.RECEIVED && f.nick !== A.nick);
    const liveAcc = await acceptFriend(B.game!.conn, liveX);
    check("session 1: B accepts an extra at its live index", liveAcc === 0, `index ${liveX}, err ${hex(liveAcc)}`);
  }
  await logOut(A);
  await logOut(B);

  // Session 2: both log in again; the login lists come from the DB (id order)
  await logIn(A);
  await logIn(B);
  const idxB = B.login.findIndex((f) => f?.nick === A.nick);
  check("relogin: B's login list has A as received (state 2)", idxB >= 0 && top(B.login[idxB]!.status) === FriendState.RECEIVED, `index ${idxB}, list: ${show(B.login)}`);
  check("relogin: A's login list has B as sent (state 1)", A.login.some((f) => f?.nick === B.nick && top(f.status) === FriendState.SENT), `A login list: ${show(A.login)}`);
  // with ROOM, B leads a room first (A then sees B in a room, Cross state 6)
  if (ROOM) {
    await sleep(1200);
    await new RoomClient(B.game!).create({ name: `ar${tag}` });
    await sleep(800);
  }
  // B accepts at the index of its own login list (community.ts: r.idx of friendList.list)
  const acc = await acceptFriend(B.game!.conn, idxB);
  check("B accepts A after relogin (1816)", acc === 0, `err ${hex(acc)} (index ${idxB})`);
  check("B's live list: A is a friend", await until(() => { const f = B.list.list[idxB]; return !!f && f.nick === A.nick && !isPending(f); }), `B row ${hex(B.list.list[idxB]?.status ?? 0)}`);
  const idxA = A.login.findIndex((f) => f?.nick === B.nick);
  const want = ROOM ? FriendState.ROOM : FriendState.LOBBY;
  check(`A's live list: B shows state ${ROOM ? "8 (room)" : "5 (lobby)"}`, await until(() => { const f = A.list.list[idxA]; return !!f && f.nick === B.nick && top(f.status) === want; }), `A row ${hex(A.list.list[idxA]?.status ?? 0)} at ${idxA}, A list: ${show(A.list.list)}`);
  check("DB: both rows state 0, not removed", await until(() => dbState(A.nick, B.nick) === "0,false" && dbState(B.nick, A.nick) === "0,false", 1000), `A->B ${dbState(A.nick, B.nick)}, B->A ${dbState(B.nick, A.nick)}`);
  // relogin again: the accepted pair survives and the login list shows both as friends
  await logOut(A);
  await logOut(B);
  await logIn(A);
  const fa = A.login.find((f) => f?.nick === B.nick);
  check("second relogin: A's login list has B as a friend", !!fa && !isPending(fa), `row ${hex(fa?.status ?? 0)}`);
  await logOut(A);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed (servers ${SERVER_A}/${SERVER_B}, room ${ROOM ? 1 : 0}, extra ${EXTRA})`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
