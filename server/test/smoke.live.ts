// Minimal live smoke of the TS servers (no browser): account-api login -> TS Auth (+ meta 2316/2318/2320) ->
// TS Game USER_ENTER -> channel -> lobby (2588) -> create room (3593) -> second player joins (3586) + ready.
//   node --experimental-transform-types --no-warnings server/test/smoke.live.ts --gw ws://127.0.0.1:8192
import { AuthClient, gameTargetForServer } from "../../src/net/authClient.ts";
import { GameClient } from "../../src/net/gameClient.ts";
import { RoomClient, WIRE_READY } from "../../src/net/roomClient.ts";
import { buyGoods, createChara, buildDeleteChara, parseDeleteChara } from "../../src/net/metaGame.ts";
import { PacketWriter } from "../../src/net/packet.ts";
import { pool } from "../src/db.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const GW = arg("--gw", "ws://127.0.0.1:8192");
const API = GW.replace(/^ws/, "http");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok: string[] = [];
const step = (s: string) => { ok.push(s); console.log(`ok ${s}`); };

async function account(username: string): Promise<Uint8Array> {
  const post = (p: string) => fetch(`${API}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "smoke-pw-1" }) });
  let res = await post("/api/register");
  if (res.status === 409) res = await post("/api/login");
  const b = (await res.json()) as { token: string };
  return Uint8Array.from(Buffer.from(b.token, "base64"));
}

async function enter(tag: string, prep?: (pid: bigint) => Promise<unknown>) {
  const token = await account(`smk${tag}${Date.now().toString(36).slice(-5)}`);
  const auth = new AuthClient(GW);
  const mac = crypto.getRandomValues(new Uint8Array(6)); mac[0] = (mac[0] & 0xfe) | 2;
  const login = await auth.connectAndLogin({ token, mac, width: 1280, height: 720 });
  if (!login.ok) throw new Error(`login ${login.errorName}`);
  step(`${tag} login pid ${login.playerId}`);
  const meta = await auth.fetchMeta();
  step(`${tag} auth meta: ${meta.inventory ? meta.inventory.items?.length ?? "?" : "no"} inventory items, 2453 ${meta.charaInfoRaw ? meta.charaInfoRaw.length + "b" : "missing"}`);
  const servers = await auth.getServers();
  const server = servers.find((s) => s.index > 0)!;
  await auth.leave();
  if (prep) await prep(login.playerId);
  const game = new GameClient(gameTargetForServer(server), GW);
  await game.enter(login.username, login.playerId, server.index);
  step(`${tag} USER_ENTER`);
  await game.selectChannel(0);
  await game.enterLobby();
  step(`${tag} channel + lobby`);
  return { game, room: new RoomClient(game), nick: login.username };
}

// A is a GM with rank 20 (GM commands, clan creation needs MinCreateRank 15); set in the DB before the Game USER_ENTER loads it
const A = await enter("a", (pid) => pool.query(`UPDATE accounts SET rank=20, access_level=100 WHERE player_id=$1`, [String(pid)]));
{ // F3: inventory, shop catalog, buy, activate ("Usar")
  const conn = A.game.conn;
  await sleep(1100); // Account.LastInventoryEnter starts at USER_ENTER: requests within 1 s are ignored
  const inv = conn.waitFor(3330, 3000); conn.send(3329); await inv; const invL = conn.waitFor(3332, 3000); await sleep(1100); conn.send(3331); await invL;
  step("A inventory enter/leave 3330/3332");
  const cat = conn.waitFor(1041, 10000); conn.send(1025, new PacketWriter().zeros(32)); await sleep(50);
  conn.send(1029, new PacketWriter().zeros(32)); await cat;
  step("A shop 1029 -> catalog burst up to 1041");
  const { result, deltas } = await buyGoods(conn, [{ goodId: 10300358, buyType: 2 }]);
  const item = deltas[0]?.items[0];
  step(`A buy 1045 -> 3334 + 1047 ok=${result.ok} gold ${result.gold} item ${item?.itemId} obj ${item?.objectId}`);
  if (item) {
    const eq = conn.waitFor(6150, 3000); conn.send(1050, new PacketWriter().writeD(item.objectId).writeC(0));
    const r = await eq; step(`A activate 1050 -> 6150 err 0x${r.readD().toString(16)}`);
  }
  // F4: buy a new character (6145 -> 3334 -> 6146), then delete it (6151 -> 6152 + 2453)
  const ch = await createChara(conn, 60100704, 2, "Smoke");
  step(`A create chara 6145 -> 6146 error 0x${(ch.error >>> 0).toString(16)} slot ${ch.slot}`);
  if (ch.error === 0) {
    const del = conn.waitFor(6152, 3000), info = conn.waitFor(2453, 3000);
    conn.send(6151, buildDeleteChara(ch.slot));
    const d = parseDeleteChara(await del); await info;
    step(`A delete chara 6151 -> 6152 error 0x${(d.error >>> 0).toString(16)} + 2453`);
  }
}
await sleep(1500);
let bPid = 0n;
const B = await enter("b", async (pid) => { bPid = pid; });
{ // F5: lobby chat, friend invite, note, quest list, clan list/enter
  const a = A.game.conn, b = B.game.conn;
  const u = (w: PacketWriter, t: string) => { for (let i = 0; i < t.length; i++) w.writeH(t.charCodeAt(i)); return w; };
  const fr = b.waitFor(1815, 3000), fa = a.waitFor(1815, 3000);
  a.send(1811, new PacketWriter().writeU(B.nick, 66)); await Promise.all([fr, fa]); step("friend invite 1811 -> 1815 to A and B");
  const nr = b.waitFor(1931, 3000), na = a.waitFor(1922, 3000);
  a.send(1921, u(u(new PacketWriter().writeC(B.nick.length).writeC(2), B.nick), "oi")); const [, ack] = await Promise.all([nr, na]);
  step(`note 1921 -> 1931 to B, 1922 err 0x${ack.readD().toString(16)}`);
  const chat = b.waitFor(2571, 3000); await sleep(1100);
  a.send(2384, u(new PacketWriter().writeH(1).writeH(5), "hello")); await chat; step("lobby chat 2384 -> 2571 to B");
  const qa = a.waitFor(8710, 3000); a.send(8709, new PacketWriter().zeros(16)); await qa; step("quest list 8709 -> 8710");
  const cl = a.waitFor(1000, 3000); a.send(997, new PacketWriter().writeC(0).writeC(0).writeC(0).writeC(0)); await cl; step("clan list 997 -> 1000");
  const ce = a.waitFor(770, 3000); a.send(769); await ce; step("clan enter 769 -> 770");
}
{ // missions (cards), season pass, random boxes, GM commands, clan ops
  const a = A.game.conn, b = B.game.conn;
  const u = (w: PacketWriter, t: string) => { for (let i = 0; i < t.length; i++) w.writeH(t.charCodeAt(i)); return w; };
  const e32 = (r: { readD(): number }) => (r.readD() >>> 0).toString(16);
  const rb = a.waitFor(2501, 5000); a.send(2500, new PacketWriter().writeC(0).zeros(33)); const r1 = await rb;
  step(`random box list 2500 -> 2501 total ${r1.readD()} bytes`);
  const sp = a.waitFor(8455, 3000); a.send(8454); const s1 = await sp; s1.readH(); step(`season pass buy 8454 -> 8455 err 0x${e32(s1)}`);
  const sp2 = a.waitFor(8455, 3000); a.send(8454); const s2 = await sp2; s2.readH(); step(`season pass again -> 8455 err 0x${e32(s2)} (ALREADY)`);
  const m1 = a.waitFor(2365, 3000); a.send(2364, new PacketWriter().writeC(15).writeC(0)); step(`A buy card set 15 -> 2365 err 0x${e32(await m1)}`);
  const m2 = b.waitFor(2365, 3000); b.send(2364, new PacketWriter().writeC(1).writeC(0)); step(`B buy card set 1 -> 2365 err 0x${e32(await m2)}`);
  const chat = (t: string) => a.send(2384, u(new PacketWriter().writeH(1).writeH(t.length), t));
  await sleep(1100);
  const g1 = a.waitFor(2571, 3000), g1b = a.waitFor(3079, 3000); chat(":help"); await Promise.all([g1, g1b]); step("GM :help -> 2571 Server + 3079 list");
  await sleep(1100);
  const g2 = b.waitFor(3079, 3000); chat(":sendmsg player smoke says hi"); await g2; step("GM :sendmsg player -> 3079 to B");
  await sleep(1100);
  const g3 = b.waitFor(1061, 3000); chat(`:player gift gold 10 ${B.nick}`); await g3; step("GM :player gift gold -> 1061 to B");
  // clan: condition, create, join request, context/list, accept, edit, page chat, commissions, note, deport, close
  const cc = a.waitFor(917, 3000); a.send(916); await cc; step("clan 916 -> 917 condition");
  const cr = a.waitFor(807, 3000); a.send(806, new PacketWriter().writeD(0).writeU(`smk${Date.now() % 100000}`, 34).writeU("smoke clan", 510).writeD(0));
  const crr = await cr; const cerr = crr.readD() >>> 0, clanId = crr.readD(); step(`clan create 806 -> 807 err 0x${cerr.toString(16)} id ${clanId}`);
  const ja = b.waitFor(811, 3000); b.send(810, new PacketWriter().writeD(clanId)); step(`clan 810 -> 811 err 0x${e32(await ja)}`);
  const jr = b.waitFor(813, 3000); b.send(812, u(new PacketWriter().writeD(clanId).writeC(2), "oi")); step(`B join request 812 -> 813 err 0x${e32(await jr)}`);
  const rc = a.waitFor(817, 3000); a.send(816); step(`clan 816 -> 817 err 0x${e32(await rc)}`);
  const rl = a.waitFor(819, 3000); a.send(818, new PacketWriter().writeC(0)); const rlr = await rl; step(`clan 818 -> 819 err 0x${e32(rlr)} page ${rlr.readC()} count ${rlr.readC()}`);
  const ac = a.waitFor(823, 3000), acb = b.waitFor(824, 3000); a.send(822, new PacketWriter().writeC(1).writeQ(bPid));
  step(`clan accept 822 -> 823 = ${(await ac).readD()} + 824 to B`); await acb;
  const nt = a.waitFor(859, 3000); a.send(858, u(new PacketWriter().writeC(6), "notice")); step(`clan notice 858 -> 859 err 0x${e32(await nt)}`);
  const it = a.waitFor(861, 3000); a.send(860, u(new PacketWriter().writeC(5), "intro")); step(`clan intro 860 -> 861 err 0x${e32(await it)}`);
  const mg = a.waitFor(869, 3000); a.send(868, new PacketWriter().writeC(0).writeC(0).writeC(0).writeC(0).writeC(0)); step(`clan management 868 -> 869 err 0x${e32(await mg)}`);
  const mk = a.waitFor(857, 3000); a.send(856, new PacketWriter().writeD(0x01020304)); step(`clan mark 856 -> 857 err 0x${e32(await mk)}`);
  await sleep(1100);
  const pc = b.waitFor(887, 3000); a.send(886, u(new PacketWriter().writeH(8).writeH(4), "page")); await pc; step("clan page chat 886 -> 887 to B");
  const st = a.waitFor(837, 3000); a.send(836, new PacketWriter().writeC(1).writeQ(bPid)); step(`clan staff 836 -> 837 = ${(await st).readD()}`);
  const rg = a.waitFor(840, 3000); a.send(839, new PacketWriter().writeC(1).writeQ(bPid)); step(`clan regular 839 -> 840 = ${(await rg).readD()}`);
  const cn = a.waitFor(893, 3000); a.send(892, u(new PacketWriter().writeC(0).writeC(4), "note")); step(`clan note 892 -> 893 = ${(await cn).readD()}`);
  const dp = a.waitFor(831, 3000), dpb = b.waitFor(832, 3000); a.send(830, new PacketWriter().writeC(1).writeQ(bPid)); step(`clan deport 830 -> 831 = ${(await dp).readD()} + 832 to B`); await dpb;
  const cl = a.waitFor(809, 3000); a.send(808); step(`clan close 808 -> 809 err 0x${e32(await cl)}`);
}
await sleep(4200);
const room = await A.room.create({ name: `smoke ${Date.now() % 1000}`, slots: 8, killTime: 0x60 });
step(`A create room #${room.roomId} map ${room.mapId}`);
const bSlot = await B.room.join(room.roomId);
step(`B join slot ${bSlot}`);
const ready = new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error("timeout READY")), 5000); A.room.onChange = () => { if (A.room.slots[bSlot].state === WIRE_READY) { clearTimeout(t); res(); } }; });
B.room.ready();
await ready;
step("B ready seen by A");
{ // TCP-only match: kill -> 2359 QUEST_CHANGE (A KILL, B DEATH), TIMERSYNC 0 -> ENDBATTLE + season 8456/8451/8450
  const seen = { a: new Map<number, number>(), b: new Map<number, number>() };
  const offA = A.game.conn.on((op) => seen.a.set(op, (seen.a.get(op) ?? 0) + 1)), offB = B.game.conn.on((op) => seen.b.set(op, (seen.b.get(op) ?? 0) + 1));
  A.room.onChange = null;
  const bStart = new Promise<void>((res) => { B.room.onStartGame = res; });
  await A.room.start(); await bStart;
  await A.room.loadingStart(); await B.room.loadingStart();
  await A.room.preStart(); await B.room.preStart();
  const ba = new Promise<void>((res) => { A.room.onBattleStart = res; }), bb = new Promise<void>((res) => { B.room.onBattleStart = res; });
  A.room.startBattle(); B.room.startBattle();
  await Promise.all([ba, bb]);
  await A.room.respawn(); await B.room.respawn();
  step("battle started (TCP)");
  const death = new Promise<void>((res) => { B.room.onDeath = () => res(); });
  A.room.reportKill(bSlot, 100003004, false);
  await death; await sleep(300);
  step(`kill -> DEATH_ACK; 2359 QUEST_CHANGE A x${seen.a.get(2359) ?? 0} B x${seen.b.get(2359) ?? 0}`);
  const end = new Promise<void>((res) => { A.room.onEndBattle = () => res(); });
  A.room.timerSync(0);
  await end; await sleep(1500);
  step(`ENDBATTLE; A season 8456 x${seen.a.get(8456) ?? 0} 8451 x${seen.a.get(8451) ?? 0} 8450 x${seen.a.get(8450) ?? 0}`);
  offA(); offB();
  if (!seen.a.get(2359) || !seen.b.get(2359) || !seen.a.get(8450)) throw new Error("missing mission/season pushes");
}
console.log(`SMOKE PASS (${ok.length} steps)`);
process.exit(0);
