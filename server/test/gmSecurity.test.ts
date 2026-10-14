// GM / moderation hardening: /signal admission, room password byte, hidden GM observer
// seat, :player quoted targets, bug report budget.
//   node --test test/gmSecurity.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import { PacketReader, PacketWriter } from "../../src/net/packet.ts";
import { pool } from "../src/db.ts";
import { RoomState, SlotState } from "../src/game/roomModel.ts";
import { handleChangeLeader, handleChangeSlot, handleJoinRoom } from "../src/game/roomHandlers.ts";
import { resolveNick } from "../src/game/playerCommands.ts";
import { BUG_ERR, BUG_GLOBAL_PER_HOUR, bugBudget, saveBugReport } from "../src/game/bugReports.ts";
import { gm, loadPermissions, serverCommands } from "../src/game/gmCommands.ts";
import { loadProfileData, titlesTable } from "../src/game/profileHandlers.ts";
import { PlayerTitles } from "../src/shared/models.ts";
import { EventEmitter } from "node:events";
import { handleSignal, signalGate, signalKey } from "../src/web/signal.ts";
import { mintSignalTicket } from "../src/web/signalTicket.ts";
import type { GameClient } from "../src/game/gameServer.ts";
import type { Account } from "../src/shared/account.ts";
import { battleRoom, chatText, fakeAccount, u32, type Sent } from "./fakeRoom.ts";

after(async () => { await pool.end(); });

/** 3 humans in BATTLE (slot 0 leads) + a GM hidden in an observer seat. */
function withHiddenGm() {
  const f = battleRoom(3);
  const g = fakeAccount(900, "StaffGM", f.sent, { gm: true });
  (f.accounts as unknown[]).push(g);
  f.room.slots[16].state = SlotState.EMPTY; f.room.slots[17].state = SlotState.EMPTY;
  assert.ok(f.room.addStealthPlayer(g) >= 16);
  return { ...f, g };
}
const client = (p: Account, sent: Sent[], extra: Record<string, unknown> = {}) =>
  ({ player: p, session: { send: (b: Uint8Array) => sent.push({ to: p.playerId, op: b[0] | (b[1] << 8), bytes: b }) }, ...extra }) as unknown as GameClient;

// ----/signal admission -----------------------------------------------------------------------------------------

test("maySignal: only slots of the running match, the host role only for the leader", () => {
  const { room, g, accounts } = withHiddenGm();
  const pid = (slot: number) => room.slots[slot].playerId;
  assert.equal(room.maySignal("guest", 1, pid(1)), true);
  assert.equal(room.maySignal("guest", 1, accounts[2].playerId), false, "another account's ticket for that slot");
  assert.equal(room.maySignal("host", 0, pid(0)), true, "the leader hosts");
  assert.equal(room.maySignal("host", 1, pid(1)), false, "a guest slot never hosts");
  assert.equal(room.maySignal("guest", 5, 0n), false, "empty slot");
  assert.equal(room.maySignal("guest", g.slotId === 16 ? 17 : 16, 0n), false, "the free observer seat");
  assert.equal(room.maySignal("guest", g.slotId, g.playerId), false, "the hidden GM before it loads");
  room.slots[g.slotId].state = SlotState.LOAD;
  assert.equal(room.maySignal("guest", g.slotId, g.playerId), true, "the hidden GM once in the match");
  room.state = RoomState.READY;
  assert.equal(room.maySignal("guest", 1, pid(1)), false, "no match running");
});

test("handleSignal: a slot the Game server does not admit is closed with 4004 before joining", () => {
  const { room, accounts } = withHiddenGm();
  const key = signalKey(room.uniqueRoomId, room.seed);
  signalGate.allow = (k, role, slot, pid) => k === key && room.maySignal(role, slot, pid);
  try {
    const open = (role: string, slot: number, pid: bigint) => {
      let code = 0;
      const ws = new EventEmitter() as EventEmitter & { OPEN: number; readyState: number; close: (c: number) => void; send: () => void };
      Object.assign(ws, { OPEN: 1, readyState: 1, close: (c: number) => { code ||= c; }, send: () => {} });
      handleSignal(ws as unknown as WebSocket, new URL(`http://x/signal?room=${key}&role=${role}&slot=${slot}`), () => {});
      ws.emit("message", JSON.stringify({ t: "auth", ticket: mintSignalTicket(key, slot, pid) }), false);
      return code;
    };
    assert.equal(open("guest", 17, 999n), 4004, "stranger in the free observer seat");
    assert.equal(open("host", 2, accounts[2].playerId), 4004, "host role from a non-leader");
    assert.equal(open("guest", 2, accounts[1].playerId), 4004, "another player's ticket for slot 2");
    assert.equal(open("guest", 2, accounts[2].playerId), 0, "a player of the match gets in");
  } finally { signalGate.allow = null; }
});

// ----the "bypass" byte of ROOM_JOIN_REQ ------------------------------------------------------------------------

test("join: the bypass byte no longer skips the room password", () => {
  const f = battleRoom(2);
  f.room.state = RoomState.READY;
  f.room.password = "abcd";
  const p = fakeAccount(500, "Intruder", f.sent);
  const ch = { getRoom: (id: number) => (id === f.room.roomId ? f.room : null), lobbyPlayers: [] };
  const c = client(p, f.sent, { channelOf: () => ch });
  for (const bypass of [0, 1]) {
    f.clear();
    handleJoinRoom(c, new PacketReader(new PacketWriter().writeD(f.room.roomId).writeS("zzzz", 4).writeC(bypass).writeC(0).toBytes(), 0));
    const ack = f.ops(3586, p.playerId);
    assert.equal(ack.length, 1);
    assert.equal(u32(ack[0].bytes, 4), 0x80001005, `bypass=${bypass}: wrong password refused`);
    assert.equal(p.room, null);
  }
});

// ----the hidden GM observer seat -------------------------------------------------------------------------------

test("a normal leader can neither kick nor close the hidden GM seat, nor hand it the leadership", () => {
  const f = withHiddenGm();
  const leader = f.accounts[0];
  f.room.state = RoomState.READY;
  f.clear();
  handleChangeSlot(client(leader, f.sent), new PacketReader(new PacketWriter().writeD(f.g.slotId).toBytes(), 0));
  assert.equal(f.room.slots[f.g.slotId].playerId, f.g.playerId, "still seated");
  assert.equal(f.ops(3075, f.g.playerId).length, 0, "no kick notice");
  assert.equal(u32(f.ops(3605, leader.playerId)[0].bytes, 2), 0, "answered like an empty seat");
  f.clear();
  handleChangeLeader(client(leader, f.sent), new PacketReader(new PacketWriter().writeD(f.g.slotId).toBytes(), 0));
  assert.equal(f.room.leader, 0);
  assert.equal(u32(f.ops(3616, leader.playerId)[0].bytes, 2), 0x80000000);
});

test("nick resolution: a normal account never matches (or lists) the hidden GM; a GM does", () => {
  const f = withHiddenGm();
  const r = resolveNick(f.accounts[1], "Sta", true);
  assert.ok("err" in r && !r.err.includes("StaffGM"), "prefix of the hidden GM: not found");
  f.accounts[2].nickname = "Stark";
  const amb = resolveNick(f.accounts[1], "St", true);
  assert.ok("acc" in amb && amb.acc.nickname === "Stark", "the only visible match, no ambiguity naming the GM");
  const other = fakeAccount(901, "OtherGM", f.sent, { gm: true });
  other.room = f.room; other.slotId = 3;
  f.room.slots[3].playerId = other.playerId; f.room.slots[3].state = SlotState.NORMAL;
  (f.accounts as unknown[]).push(other);
  const seen = resolveNick(other, "Staff", true);
  assert.ok("acc" in seen && seen.acc.playerId === f.g.playerId);
});

// ----bug report budget -----------------------------------------------------------------------------------------

test("bug reports: the server-wide hourly budget refuses before any database work", async () => {
  const saved = bugBudget.times.splice(0);
  const t0 = 5_000_000;
  bugBudget.now = () => t0;
  try {
    for (let i = 0; i < BUG_GLOBAL_PER_HOUR; i++) bugBudget.times.push(t0 - i);
    bugBudget.times.reverse();
    const p = fakeAccount(9100000501, "Bugger", []);
    assert.equal((await saveBugReport(p, "tela preta", "{}")).err, BUG_ERR.limit);
    assert.equal(bugBudget.times.length, BUG_GLOBAL_PER_HOUR, "a refused report takes nothing from the budget");
  } finally {
    bugBudget.times.splice(0, bugBudget.times.length, ...saved);
    bugBudget.now = () => Date.now();
  }
});

// ----:player targets -------------------------------------------------------------------------------------------

test(":player: a quoted number is a nick, a bare number is a UID (needs the permission tables)", async (t) => {
  try { await loadPermissions(); } catch { t.skip("no database"); return; }
  const sent: Sent[] = [];
  const me = Object.assign(fakeAccount(902, "BossGM", sent, { gm: true }), { access: 100 });
  const calls: string[] = [];
  const keep = { byPid: gm.byPid, byNick: gm.byNick, accessOf: gm.accessOf };
  gm.byPid = async (x) => { calls.push(`pid:${x}`); return null; };
  gm.byNick = async (x) => { calls.push(`nick:${x}`); return null; };
  gm.accessOf = async () => 100; // the fake account has no row
  try {
    if (!(await serverCommands(me, ":player ban normal 3 1001"))) { t.skip("level 100 lacks gamemastercommand in this database"); return; }
    await serverCommands(me, ":player ban normal 3 \"1001\"");
    await serverCommands(me, ":player kick \"1001\"");
    await serverCommands(me, ":player gift gold 5 \"Evil Alice\"");
    assert.deepEqual(calls, ["pid:1001", "nick:1001", "nick:1001", "nick:Evil Alice"]);
    assert.ok(sent.map((x) => chatText(x.bytes)).some((l) => l.includes("Nickname: Evil Alice")));
  } finally { Object.assign(gm, keep); }
});

// ----access read per command -----------------------------------------------------------------------------------

test("a GM demoted in the DB loses the commands at the next one, 1 read per command (needs the permission tables)", async (t) => {
  try { await loadPermissions(); } catch { t.skip("no database"); return; }
  const me = Object.assign(fakeAccount(903, "ExGM", [], { gm: true }), { access: 100 });
  const keep = { byNick: gm.byNick, accessOf: gm.accessOf };
  let level: number | null = 100, reads = 0;
  gm.byNick = async () => null;
  gm.accessOf = async () => { reads++; return level; };
  try {
    if (!(await serverCommands(me, ":player kick \"Nobody\""))) { t.skip("level 100 lacks gamemastercommand in this database"); return; }
    assert.equal(reads, 1);
    level = 0;
    assert.equal(await serverCommands(me, ":player kick \"Nobody\""), false, "demoted: the line is plain chat again");
    assert.equal(me.access, 0);
    assert.equal(reads, 2);
    assert.equal(await serverCommands(me, ":player kick \"Nobody\""), false);
    assert.equal(reads, 2, "without the permission in memory no query is made");
    assert.equal(await serverCommands(me, "hello"), false);
    me.access = 100; level = null;
    assert.equal(await serverCommands(me, ":player kick \"Nobody\""), false, "no account row: fail closed");
  } finally { Object.assign(gm, keep); }
});

// ---- :player title <nick|uid> ----------------------------------------------------------------------------------------

test(":player title: unlocks every title of an online target (2383 + chat) and of an offline one, refuses a higher access (needs the DB)", async (t) => {
  try { await loadPermissions(); await loadProfileData(); } catch { t.skip("no database"); return; }
  if (titlesTable().size === 0) { t.skip("no system_titles rows"); return; }
  const sent: Sent[] = [];
  const me = Object.assign(fakeAccount(904, "TitleGM", sent, { gm: true }), { access: 100 });
  const mk = (pid: number, nick: string, online: boolean) => {
    const a = Object.assign(fakeAccount(pid, nick, sent), { title: new PlayerTitles(), access: 0 });
    if (!online) (a as unknown as { connection: null }).connection = null;
    return a;
  };
  const on = mk(905, "OnlineTgt", true), off = mk(906, "OfflineTgt", false), boss = Object.assign(mk(907, "BossTgt", true), { access: 101 });
  const keep = { byPid: gm.byPid, byNick: gm.byNick, accessOf: gm.accessOf };
  const all = [on, off, boss];
  gm.byNick = async (n) => all.find((a) => a.nickname === n) ?? null;
  gm.byPid = async (x) => all.find((a) => a.playerId === x) ?? null;
  gm.accessOf = async () => 100;
  try {
    if (!(await serverCommands(me, ":player title OnlineTgt"))) { t.skip("level 100 lacks gamemastercommand in this database"); return; }
    const want = [...titlesTable().values()].reduce((f, m) => f | m.flag, 0n);
    assert.equal(on.title.flags & want, want);
    assert.equal(sent.filter((x) => x.to === on.playerId && x.op === 2383).length, 1, "titles packet to the target");
    assert.ok(sent.filter((x) => x.to === on.playerId && x.op === 2571).some((x) => chatText(x.bytes).includes("TitleGM")), "Server chat line to the target");
    sent.length = 0;
    await serverCommands(me, ":player title OfflineTgt");
    assert.equal(off.title.flags & want, want, "offline: flags set for the save");
    assert.equal(sent.filter((x) => x.to === off.playerId).length, 0, "offline: nothing sent");
    assert.ok(sent.some((x) => x.to === me.playerId && chatText(x.bytes).includes("offline")));
    sent.length = 0;
    await serverCommands(me, ":player title BossTgt");
    assert.equal(boss.title.flags, 0n, "higher access untouched");
    await serverCommands(me, ":player title Nobody");
    assert.ok(sent.map((x) => chatText(x.bytes)).some((l) => l.includes("Nickname: Nobody")));
  } finally { Object.assign(gm, keep); }
});
