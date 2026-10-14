// Live E2E of the room rules: user limit (create / edit / full room refuses the join, never the observer slots 16-17),
// map limit clamp (Crack Down = 8) and the password set / clear from the settings window (ROOM_CHANGE_ROOMINFO_REQ extension).
//   node --experimental-transform-types src/net/test/roomrules.live.ts [--gw ws://127.0.0.1:8090] [--api http://127.0.0.1:8090]
// Needs Postgres and server running. Exit 0 = pass.
import { AuthClient, gameTargetForServer } from "../authClient.ts";
import { GameClient, GameError } from "../gameClient.ts";
import { RoomClient } from "../roomClient.ts";
import { collectEnterPushes } from "../metaGame.ts";
import { fetchAuthMeta } from "../metaAuth.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const GW = arg("--gw", "ws://127.0.0.1:8090");
const API = arg("--api", "http://127.0.0.1:8090");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => { checks.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };

async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  for (let t = 0; t < ms; t += 50) { if (cond()) return true; await sleep(50); }
  return cond();
}

async function enter(username: string): Promise<GameClient> {
  const res = await fetch(`${API}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "rules-test-pw1" }) });
  const body = (await res.json()) as { token?: string; error?: string };
  if (res.status !== 201 || !body.token) throw new Error(`register ${username}: ${res.status} ${body.error ?? ""}`);
  console.log("enter", username);
  const auth = new AuthClient(GW);
  const mac = crypto.getRandomValues(new Uint8Array(6));
  mac[0] = (mac[0] & 0xfe) | 2;
  const login = await auth.connectAndLogin({ token: Uint8Array.from(Buffer.from(body.token, "base64")), mac });
  if (!login.ok) throw new Error(`${username}: login ${login.errorName}`);
  await fetchAuthMeta(auth.conn);
  const server = (await auth.getServers()).find((s) => s.index > 0)!;
  await auth.leave();
  const game = new GameClient(gameTargetForServer(server), GW);
  const connect = game.conn.connect.bind(game.conn);
  let pushes: Promise<unknown> | null = null;
  game.conn.connect = async (...a) => { const i = await connect(...a); pushes = collectEnterPushes(game.conn).done; return i; };
  await game.enter(login.username, login.playerId, server.index);
  await pushes;
  await game.selectChannel(0);
  await game.enterLobby();
  return game;
}

/** join result: the slot, or the error code */
async function tryJoin(rc: RoomClient, roomId: number, pwd = ""): Promise<{ slot: number } | { code: number }> {
  try { return { slot: await rc.join(roomId, pwd) }; } catch (e) { if (e instanceof GameError) return { code: e.code }; throw e; }
}
const hex = (r: { slot: number } | { code: number }) => ("slot" in r ? `slot ${r.slot}` : `0x${(r.code >>> 0).toString(16)}`);

async function main(): Promise<void> {
  const sfx = `${Date.now() % 1e7}`;
  const gA = await enter(`rra${sfx}`); await sleep(3000);
  const gB = await enter(`rrb${sfx}`); await sleep(3000);
  const gC = await enter(`rrc${sfx}`);
  const A = new RoomClient(gA), B = new RoomClient(gB), C = new RoomClient(gC);

  // 1. room of 2: the third player is refused (never put in the observer slot 16/17)
  const room = await A.create({ name: `rules ${sfx.slice(-4)}`, mapId: 4, slots: 2 });
  check("create: slot count 2", room.slotCount === 2, String(room.slotCount));
  const b = await tryJoin(B, room.roomId);
  check("2nd player joins a slot < 16", "slot" in b && b.slot < 16, hex(b));
  const c1 = await tryJoin(C, room.roomId);
  check("3rd player refused on a full room (ROOM_JOIN 0x80001003)", "code" in c1 && (c1.code >>> 0) === 0x80001003, hex(c1));

  // 2. settings window: raise the limit -> the third player fits, in a normal slot
  A.changeRoomInfo({ slots: 4 });
  check("edit: slot count 4 echoed", await waitFor(() => A.room?.slotCount === 4), String(A.room?.slotCount));
  const c2 = await tryJoin(C, room.roomId);
  check("edit: 3rd player joins after the limit went up", "slot" in c2 && c2.slot < 16, hex(c2));
  await C.leave();

  // 3. lower it again: empty slots close, nobody is kicked
  A.changeRoomInfo({ slots: 2 });
  check("edit: slot count back to 2", await waitFor(() => A.room?.slotCount === 2), String(A.room?.slotCount));
  const c3 = await tryJoin(C, room.roomId);
  check("edit: 3rd player refused again", "code" in c3 && (c3.code >>> 0) === 0x80001003, hex(c3));
  check("edit: the two players stay", A.slots[0].nick !== "" && A.slots[1].nick !== "", A.slots.slice(0, 3).map((s) => s.nick).join(","));

  // 4. password from the settings window
  A.changeRoomInfo({ slots: 4, password: "1234" });
  check("password set: flag bit 4", await waitFor(() => ((A.room?.opts?.flag ?? 0) & 4) !== 0), String(A.room?.opts?.flag));
  const p0 = await tryJoin(C, room.roomId, "");
  check("password set: join without it refused (0x80001005)", "code" in p0 && (p0.code >>> 0) === 0x80001005, hex(p0));
  const p1 = await tryJoin(C, room.roomId, "9999");
  check("password set: wrong password refused", "code" in p1 && (p1.code >>> 0) === 0x80001005, hex(p1));
  const p2 = await tryJoin(C, room.roomId, "1234");
  check("password set: right password joins", "slot" in p2, hex(p2));
  await C.leave();
  A.changeRoomInfo({ slots: 4 }); // no password field: keeps it
  await sleep(400);
  const p3 = await tryJoin(C, room.roomId, "");
  check("edit without a password field keeps the password", "code" in p3 && (p3.code >>> 0) === 0x80001005, hex(p3));
  A.changeRoomInfo({ slots: 4, password: "" });
  check("password cleared: flag bit 4 off", await waitFor(() => ((A.room?.opts?.flag ?? 0) & 4) === 0), String(A.room?.opts?.flag));
  const p4 = await tryJoin(C, room.roomId, "");
  check("password cleared: join without it works", "slot" in p4, hex(p4));

  // 5. map limit: Crack Down (id 9) holds 8 even when 16 is asked
  for (const rc of [A, B, C]) { await rc.leave().catch(() => {}); }
  const r9 = await B.create({ name: `lim ${sfx.slice(-4)}`, mapId: 9, slots: 16 });
  check("map limit: Crack Down clamps 16 -> 8", r9.slotCount === 8, String(r9.slotCount));
  B.changeRoomInfo({ slots: 16 });
  await sleep(500);
  check("map limit: edit to 16 stays 8", B.room?.slotCount === 8, String(B.room?.slotCount));
  await B.leave().catch(() => {});

  for (const rc of [A, B, C]) rc.dispose();
  for (const g of [gA, gB, gC]) g.close();
  const failed = checks.filter((x) => !x.ok);
  console.log(failed.length ? `\nRESULT: FAIL - ${failed.map((x) => x.name).join("; ")}` : `\nRESULT: PASS - ${checks.length} checks`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
