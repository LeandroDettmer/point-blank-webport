// Live check of Visitar (lobby/core/controller.ts visitRoom / visitOtherChannel, the Comunidade menu gates in
// lobby/screensCross/contextMenu.ts) against the real server (Docker + server), no browser. The page logic is driven
// node-side: the port's steps (drop the Game session, log in again, enter the friend's server + channel, wait for the room
// in the lobby list, join it) with the same calls. Accounts: V (visitor) and O (owner), friends from the start.
// Stages: L lobby friend (not visitable, exe FRIEND_IN_THE_ROOM; menu PM + Convidar); S same channel (O makes a room on
// channel 0, V sees ROOM with its location and joins it); X other channel (V leaves the room, O moves to channel 1 and makes a
// room, V sees it on channel 1, V's visit logs in again on channel 1 (5.6 s: the reconnect's first delay, the Auth throttle
// per IP) and joins it). Usage (stack up: npm run dev:all):
//   node src/net/test/visitRoom.live.ts [--gw ws://127.0.0.1:8090] [--api http://127.0.0.1:8090]
// Exit 0 = pass.
import { AuthClient, gameTargetForServer } from "../authClient.ts";
import { GameClient } from "../gameClient.ts";
import { collectEnterPushes, type EnterPushes } from "../metaGame.ts";
import { CrossState, FriendList, acceptFriend, crossState, friendLocation, requestFriend, type FriendEntry } from "../friendClient.ts";
import { RoomClient } from "../roomClient.ts";
import { CMC, friendMenuItems } from "../../lobby/screensCross/contextMenu.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const GW = arg("--gw", "ws://127.0.0.1:8090");
const API = arg("--api", "http://127.0.0.1:8090");
const t0 = Date.now();
const log = (who: string, msg: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s [${who}] ${msg}`);
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => { results.push({ name, ok, detail }); log(ok ? "PASS" : "FAIL", `${name}: ${detail}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function account(username: string): Promise<Uint8Array> {
  const res = await fetch(`${API}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "visit-live-pw1" }) });
  const body = (await res.json()) as { token?: string; error?: string };
  if (res.status !== 201 || !body.token) throw new Error(`register ${username}: ${res.status} ${body.error ?? ""}`);
  return Uint8Array.from(Buffer.from(body.token, "base64"));
}

interface Session { game: GameClient; list: FriendList; nick: string; server: number; channel: number; channels: number }

/** Auth login, server list, Game enter, channel, lobby (friendList.live.ts enter, with the channel as a parameter) */
async function enter(who: string, token: Uint8Array, channel: number, waitMs = 1200): Promise<Session> {
  await sleep(waitMs); // the auth drops a 2nd login from the same IP within 1 s (authServer.ts handleLogin)
  const auth = new AuthClient(GW);
  const mac = crypto.getRandomValues(new Uint8Array(6));
  mac[0] = (mac[0] & 0xfe) | 2;
  const login = await auth.connectAndLogin({ token, mac });
  if (!login.ok) throw new Error(`${who}: login ${login.errorName}`);
  const server = (await auth.getServers()).find((s) => s.index > 0)!;
  const channels = server.channelTypes.length; // the lobby's channel count (controller.pickServer)
  await auth.leave();
  const game = new GameClient(gameTargetForServer(server), GW);
  let pushes: Promise<EnterPushes> | null = null;
  const connect = game.conn.connect.bind(game.conn);
  game.conn.connect = async (...a) => { const i = await connect(...a); pushes = collectEnterPushes(game.conn).done; return i; };
  await game.enter(login.username, login.playerId, server.index);
  await pushes!;
  await game.selectChannel(channel);
  await game.enterLobby();
  const list = new FriendList();
  list.attach(game.conn);
  log(who, `in lobby as ${login.username}, server ${server.index} channel ${channel}`);
  return { game, list, nick: login.username, server: server.index, channel, channels };
}

/** waits until `fn` is true (the friend pushes arrive after the request's ack) */
async function until(fn: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(50); }
  return fn();
}

/** controller.visitOtherChannel without the page: drop the Game session (teardown), log in again on the friend's channel
 * (reconnect's first delay), wait for the room in the lobby list (the lobby polling), join it (joinRoomById) */
async function visitChannel(V: Session, token: Uint8Array, status: number): Promise<{ next: Session; joined: boolean; seen: boolean }> {
  const { server, channel, room } = friendLocation(status);
  V.list.detach();
  V.game.conn.close();
  await sleep(5600);
  const next = await enter("V2", token, channel, 0);
  await sleep(1100); // the server ignores a request under 1 s after the connect
  let seen = false;
  for (let end = Date.now() + 6000; Date.now() < end && !seen;) {
    const page = await next.game.getRoomList(1200).catch(() => null);
    seen = !!page?.rooms.some((r) => r.roomId === room);
    if (!seen) await sleep(300);
  }
  if (next.server !== server) return { next, joined: false, seen: false };
  let joined = false;
  if (seen) joined = await new RoomClient(next.game).join(room).then(() => true, () => false);
  return { next, joined, seen };
}

async function main(): Promise<void> {
  const tag = Date.now().toString(36).slice(-6);
  const nameV = `vv${tag}`, nameO = `vo${tag}`;
  const tokenV = await account(nameV), tokenO = await account(nameO);
  const V = await enter("V", tokenV, 0);
  const O = await enter("O", tokenO, 0);
  check("server has channel 2 (index 1) to switch to", V.channels >= 2, `${V.channels} channels`);

  // friends: V asks O, O accepts (friendList.live.ts steps 1 and 3)
  const sent = await requestFriend(V.game.conn, O.nick);
  check("V asks O", sent === 0, `err ${hex(sent)}`);
  const gotReq = await until(() => O.list.list.some((f) => f?.nick === V.nick));
  const idxOinV = O.list.list.findIndex((f) => f?.nick === V.nick);
  const acc = gotReq ? await acceptFriend(O.game.conn, idxOinV) : -1;
  check("O accepts V", acc === 0, `err ${hex(acc)}`);
  const row = (): FriendEntry | undefined => V.list.list.find((f) => f?.nick === O.nick) ?? undefined;

  // L: O in the lobby (channel 0). V's row is state 5 (lobby): not visitable, menu PM + Convidar
  const lobbyOk = await until(() => { const f = row(); return !!f && crossState(f.status) === CrossState.LOBBY; });
  check("L: V sees O in the lobby (state 5)", lobbyOk, `row ${hex(row()?.status ?? 0)}`);
  const fl = row();
  const lobbyState = crossState(fl?.status ?? 0);
  check("L: lobby friend not visitable (gate: state must be 6, else FRIEND_IN_THE_ROOM)", lobbyState !== CrossState.ROOM, `state ${lobbyState}`);
  check("L: menu PM + Convidar (lobby, me in lobby)", same(friendMenuItems(lobbyState, true), [CMC.WHISPER, CMC.INVITE]), `${friendMenuItems(lobbyState, true)}`);

  // S: O makes a room on channel 0; V sees it (room state 6, location = server, channel 0, room id); V joins it
  const room0 = await new RoomClient(O.game).create({ name: `vs${tag}` });
  const sameOk = await until(() => { const f = row(); return !!f && crossState(f.status) === CrossState.ROOM && friendLocation(f.status).room === room0.roomId; });
  const loc0 = friendLocation(row()?.status ?? 0);
  check("S: V sees O in its room (state 6, location)", sameOk, `row ${hex(row()?.status ?? 0)} vs room ${room0.roomId}`);
  check("S: location = my server, channel 0", loc0.server === V.server && loc0.channel === 0, `srv ${loc0.server} ch ${loc0.channel}`);
  check("S: menu PM + Convidar + Buscar (room, me in lobby)", same(friendMenuItems(CrossState.ROOM, true), [CMC.WHISPER, CMC.INVITE, CMC.FIND_OUT]), `${friendMenuItems(CrossState.ROOM, true)}`);
  const vr0 = new RoomClient(V.game);
  const joined0 = await vr0.join(loc0.room).then(() => true, (e) => { log("V", `join: ${e}`); return false; });
  check("S: visit joins the room on the same channel", joined0, `room ${loc0.room}`);
  await vr0.leave();
  await sleep(800);

  // X: O leaves its room and moves to channel 1 (its own Game session), makes a room there; V sees channel 1
  O.list.detach();
  O.game.conn.close();
  const O2 = await enter("O2", tokenO, 1);
  const room1 = await new RoomClient(O2.game).create({ name: `vx${tag}` });
  const otherOk = await until(() => { const f = row(); return !!f && crossState(f.status) === CrossState.ROOM && friendLocation(f.status).channel === 1; });
  const loc1 = friendLocation(row()?.status ?? 0);
  check("X: V sees O's room on channel 1", otherOk && loc1.room === room1.roomId, `srv ${loc1.server} ch ${loc1.channel} room ${loc1.room} vs ${room1.roomId}`);

  // X: V's visit: switch channel (drop, log in again, channel 1) and join the room
  const v = await visitChannel(V, tokenV, row()?.status ?? 0);
  check("X: V's visit finds the room in channel 1's lobby list", v.seen, `seen ${v.seen}`);
  check("X: visit switches channel and joins the room", v.joined && v.next.channel === 1, `joined ${v.joined} channel ${v.next.channel}`);

  for (const s of [v.next, O2]) { s.list.detach(); s.game.conn.close(); }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
