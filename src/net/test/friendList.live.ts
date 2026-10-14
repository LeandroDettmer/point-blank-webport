// Live check of the Cross Comunidade friend list (friendClient.ts) against the real server (Docker + server), no browser:
// two brand-new accounts in the lobby. A asks B by nick (1811), B's list gets the pending request (1815 insert, state 2),
// A's gets it as sent (state 1); A cannot accept its own request (1816 -> 1817, server rule: only a received request);
// B accepts (1816 -> 1815 accept + update); A sees B as a friend online in the lobby (status state 5, channel); A deletes B
// (1820 -> 1821): B's entry turns offline and A's list loses the row. Last step (Convidar): A leads a room and invites B
// (877 by lobby session id) and B gets the room-invite push (3077). A and B log in on different game servers by default
// (--server-a 1, --server-b 3): the pushes must cross servers. Usage (stack up: npm run dev:all):
//   node src/net/test/friendList.live.ts [--gw ws://127.0.0.1:8090] [--api http://127.0.0.1:8090] [--server-a 1] [--server-b 3]
// Exit 0 = pass. Both lists are FriendList instances on each Game connection (the page uses the singleton `friendList`;
// two accounts in one process need two instances).
import { execSync } from "node:child_process";
import { AuthClient, gameTargetForServer } from "../authClient.ts";
import { GameClient } from "../gameClient.ts";
import { collectEnterPushes, type EnterPushes } from "../metaGame.ts";
import { FriendList, FriendState, type FriendEntry, acceptFriend, deleteFriend, findUser, friendList, requestFriend, sendFindLobby } from "../friendClient.ts";
import { ClanClient, type ClanRoomInvite } from "../clanClient.ts";
import { RoomClient } from "../roomClient.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const GW = arg("--gw", "ws://127.0.0.1:8090");
const API = arg("--api", "http://127.0.0.1:8090");
const t0 = Date.now();
const log = (who: string, msg: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s [${who}] ${msg}`);
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => { results.push({ name, ok, detail }); log(ok ? "PASS" : "FAIL", `${name}: ${detail}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;
// game server index (system_servers id) of A and B: different by default, so the test covers the cross-server path
const SERVER_A = Number(arg("--server-a", "1")), SERVER_B = Number(arg("--server-b", "3"));

async function account(username: string): Promise<Uint8Array> {
  const res = await fetch(`${API}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "friend-live-pw1" }) });
  const body = (await res.json()) as { token?: string; error?: string };
  if (res.status !== 201 || !body.token) throw new Error(`register ${username}: ${res.status} ${body.error ?? ""}`);
  return Uint8Array.from(Buffer.from(body.token, "base64"));
}

interface Session { game: GameClient; list: FriendList; nick: string }

async function enter(who: string, token: Uint8Array, serverIndex: number): Promise<Session> {
  await sleep(1200); // the auth drops a 2nd login from the same IP within 1 s (authServer.ts handleLogin)
  const auth = new AuthClient(GW);
  const mac = crypto.getRandomValues(new Uint8Array(6));
  mac[0] = (mac[0] & 0xfe) | 2;
  const login = await auth.connectAndLogin({ token, mac });
  if (!login.ok) throw new Error(`${who}: login ${login.errorName}`);
  const servers = await auth.getServers();
  const server = servers.find((s) => s.index === serverIndex);
  if (!server) throw new Error(`${who}: server ${serverIndex} not in the Auth list (${servers.map((s) => s.index).join(",")})`);
  await auth.leave();
  const game = new GameClient(gameTargetForServer(server), GW);
  let pushes: Promise<EnterPushes> | null = null;
  const connect = game.conn.connect.bind(game.conn);
  game.conn.connect = async (...a) => { const i = await connect(...a); pushes = collectEnterPushes(game.conn).done; return i; };
  await game.enter(login.username, login.playerId, server.index);
  await pushes!;
  await game.selectChannel(0);
  await game.enterLobby();
  const list = new FriendList();
  list.attach(game.conn);
  log(who, `in lobby as ${login.username}`);
  return { game, list, nick: login.username };
}

/** waits until `fn` is true (the pushes arrive after the request's ack) */
async function until(fn: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(50); }
  return fn();
}

const top = (status: number) => status >>> 28;

async function main(): Promise<void> {
  const tag = Date.now().toString(36).slice(-6);
  const nameA = `fa${tag}`, nameB = `fb${tag}`;
  const tokenA = await account(nameA), tokenB = await account(nameB);
  // the clan server (channels of type Clan) lets in only an account with a clan (CHANNEL_REQUIREMENT): give B any clan row.
  // The friend flow does not use the clan itself.
  if (SERVER_B === 3) execSync(`docker exec pb-postgres-local psql -U postgres -d pb -q -c "UPDATE accounts SET clan_id=(SELECT max(id) FROM system_clan) WHERE nickname='${nameB}'"`);
  // A and B log in on different game servers: the friend and note pushes must cross them (the live tests used to put both on one)
  const A = await enter("A", tokenA, SERVER_A), B = await enter("B", tokenB, SERVER_B);

  // 1. A asks B by nick
  const sent = await requestFriend(A.game.conn, B.nick);
  check("A asks B by nick", sent === 0, `err ${hex(sent)}`);
  check("B's list gets the request as received", await until(() => B.list.list.some((f) => f?.nick === A.nick && top(f.status) === FriendState.RECEIVED)), `B list ${B.list.list.map((f) => f ? `${f.nick}:${top(f.status)}` : "-").join(",")}`);
  check("A's list gets it as sent", await until(() => A.list.list.some((f) => f?.nick === B.nick && top(f.status) === FriendState.SENT)), `A list ${A.list.list.map((f) => f ? `${f.nick}:${top(f.status)}` : "-").join(",")}`);

  // 2. A cannot accept its own request (server: only a received request, state 2)
  const idxB = A.list.list.findIndex((f) => f?.nick === B.nick);
  const selfAccept = await acceptFriend(A.game.conn, idxB);
  check("A cannot accept its own request", selfAccept === 0x80000000, `err ${hex(selfAccept)}`);

  // 3. B accepts: both lists are friends; A sees B online in the lobby (state 5 + channel)
  const idxA = B.list.list.findIndex((f) => f?.nick === A.nick);
  const acc = await acceptFriend(B.game.conn, idxA);
  check("B accepts A", acc === 0, `err ${hex(acc)}`);
  const accepted = (f: FriendEntry | undefined, nick: string) => !!f && f.nick === nick && top(f.status) !== FriendState.SENT && top(f.status) !== FriendState.RECEIVED;
  check("B's list: A is a friend", await until(() => accepted(B.list.list[idxA], A.nick)), `B row ${hex(B.list.list[idxA]?.status ?? 0)}`);
  check("A's list: B is a friend, online in the lobby (state 5 + channel)", await until(() => { const f = A.list.list[idxB]; return accepted(f, B.nick) && top(f!.status) === FriendState.LOBBY; }), `A row ${hex(A.list.list[idxB]?.status ?? 0)}`);

  // 3b. the login list: A leaves the game (the server refuses a 2nd login while one is in), a fresh Auth session of A
  // (2320 GET_OPTION -> 1810) fills the singleton the page reads
  A.game.conn.close();
  await sleep(1500);
  const auth = new AuthClient(GW);
  const mac = crypto.getRandomValues(new Uint8Array(6));
  mac[0] = (mac[0] & 0xfe) | 2;
  const login = await auth.connectAndLogin({ token: tokenA, mac });
  if (!login.ok) throw new Error(`A auth again: ${login.errorName}`);
  await auth.fetchMeta();
  const fromLogin = friendList.list.find((f) => f?.nick === B.nick);
  check("login list (1810) has B as a friend", !!fromLogin && top(fromLogin.status) !== FriendState.SENT && top(fromLogin.status) !== FriendState.RECEIVED, `row ${hex(fromLogin?.status ?? 0)} of ${friendList.list.length}`);
  auth.conn.close();
  const idxBLogin = friendList.list.findIndex((f) => f?.nick === B.nick);
  const A2 = await enter("A2", tokenA, SERVER_A);
  friendList.attach(A2.game.conn); // the singleton the page uses: 1815 changes on this Game connection

  // 4. A deletes B (from the login list): B's entry goes offline, A's row is gone. The server drops a delete sent under 1 s
  // after the account is built (friendDelete throttle, as the C# GetDuration check): wait it out
  await sleep(1500);
  const del = await deleteFriend(A2.game.conn, idxBLogin);
  check("A deletes B", del === 0, `err ${hex(del)}`);
  check("A's list loses B", await until(() => !friendList.list.some((f) => f?.nick === B.nick)), `A list length ${friendList.list.length}`);
  check("B's list: A offline (removed)", await until(() => { const f = B.list.list[idxA]; return !!f && top(f.status) === FriendState.OFFLINE; }), `B row ${hex(B.list.list[idxA]?.status ?? 0)}`);

  // 5. Convidar (the friend card's cmInvite): A leads a room and invites B, a lobby user of the same channel, by session id
  // (877 from the lobby list, app.ts inviteFriend); B gets the room invite push (3077) with A's nick and the room's password.
  // Same game server only: the lobby list holds the players of one server, so a cross-server B is not in A's list.
  if (SERVER_A !== SERVER_B) log("5", "room invite skipped: A and B are on different game servers (the lobby list is per server)");
  else {
    await sleep(1200);
    const room = await new RoomClient(A2.game).create({ name: `cv${tag}` });
    await sleep(1200);
    const got: { inv?: ClanRoomInvite } = {};
    const clanB = new ClanClient(B.game.conn);
    const offB = clanB.on((ev) => { if (ev.type === "room-invite") got.inv = ev.invite; });
    const page = await A2.game.getRoomList();
    const bRow = page?.players.find((p) => p.nickname === B.nick);
    check("lobby list has B with a session id", !!bRow, `B row ${bRow ? hex(bRow.sessionId) : "none"}`);
    if (bRow) new ClanClient(A2.game.conn).roomInvite(bRow.sessionId);
    check("B gets the room invite (3077) from A", await until(() => got.inv?.nick === A2.nick && got.inv.roomId === room.roomId), `invite ${got.inv ? `${got.inv.nick} room ${got.inv.roomId}` : "none"}`);
    offB();
  }

  // 6. Buscar (nick not a friend, not in the lobby list): the client sends 297 + nick (sendFindLobby). The server ignores 297
  // (unhandled opcode, no reply), so the connection must survive it: the next 2426 (findUser, B exists) still answers
  sendFindLobby(A2.game.conn, B.nick);
  const alive = await findUser(A2.game.conn, B.nick);
  check("Buscar sends 297 and the connection survives (next 2426 answered)", alive, `2426 after 297: ${alive}`);

  for (const s of [A2, B]) { s.list.detach(); s.game.conn.close(); }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
