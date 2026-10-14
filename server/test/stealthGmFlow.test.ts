// A hidden GM (F8 "Entrar nas salas invisível": ROOM_JOIN_REQ stealth byte, seat 16 / 17) through the real packet flow of a room
// battle: join, READY (mode 0 and 2), the leader's start, LOADING_START, PRESTART, STARTBATTLE, the round spawn and RESPAWN.
// The GM must stay an observer (specGM) in its observer seat, and nothing about its seat may reach the normal accounts.
//   node --test test/stealthGmFlow.test.ts
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db.ts";
import { loadMaps, RoomModel, RoomState, SlotState } from "../src/game/roomModel.ts";
import { Account } from "../src/shared/account.ts";
import * as rp from "../src/game/roomPackets.ts";
import { handleJoinRoom, handleLoadingStart, handlePreStartBattle, handleReadyBattle, handleRespawn, handleStartBattle } from "../src/game/roomHandlers.ts";
import { PacketReader, PacketWriter } from "../../src/net/packet.ts";
import type { ChannelModel } from "../src/game/channel.ts";
import type { GameClient } from "../src/game/gameServer.ts";
import { opOf, u32 } from "./fakeRoom.ts";

// system_map_matches / system_map_rules: map 4 (limit 16) under rule 0, so getMapLimit answers as with the real DB
const q = (pool as unknown as { query: unknown }).query;
(pool as unknown as { query: unknown }).query = async (sql: string) => ({
  rows: sql.includes("system_map_matches") ? [{ map_id: 4, mode_id: 1, map_limit: 16, tag: 0, name: "teste" }]
    : sql.includes("system_map_rules") ? [{ mode_id: 1, rule: 0, stage_options: 1, conditions: 4, name: "teste" }] : [],
});
await loadMaps();
after(() => { (pool as unknown as { query: unknown }).query = q; });

interface Sent { to: bigint; op: number; bytes: Uint8Array }
const GM_PID = 900n;
const BOMB = 8, TDM = 4;

function world(roomType = TDM, balance = 0) {
  const sent: Sent[] = [];
  const accounts: Account[] = [];
  const svc = {
    getAccount: (pid: bigint) => accounts.find((a) => a.playerId === pid) ?? null,
    send: (a: Account, b: Uint8Array) => { sent.push({ to: a.playerId, op: opOf(b), bytes: b }); },
    updateStatus: async () => {},
  };
  let room: RoomModel | null = null;
  const ch = { id: 0, type: 0, serverId: 1, lobbyPlayers: [] as Account[], rooms: [], getRoom: (id: number) => (room && id === room.roomId ? room : null) } as unknown as ChannelModel;
  const r = room = new RoomModel(3, ch, svc);
  r.buildSlotInfo = (hide) => rp.slotInfoAck(r, hide);
  r.buildRoomInfo = () => rp.changeRoomInfoAck(r);
  Object.assign(r, { name: "sala", mapId: 4, rule: 0, stage: 1, roomType, killTime: 0x13, weaponsFlag: 0x1ff, balanceType: balance, countdownIG: 0 });
  r.generateSeed();
  const clients = new Map<bigint, GameClient>();
  const mk = (pid: bigint, nick: string, gm = false) => {
    const a = new Account();
    Object.assign(a, { playerId: pid, nickname: nick, rank: 10, access: gm ? 100 : 0, isOnline: true });
    a.last.readyBattle = 0;
    const c = { player: a, session: { send: (b: Uint8Array) => sent.push({ to: pid, op: opOf(b), bytes: b }), sendText: () => {} }, channelOf: () => ch };
    a.connection = c;
    accounts.push(a);
    clients.set(pid, c as unknown as GameClient);
    return a;
  };
  const L = mk(100n, "Leader");
  r.addPlayer(L); r.leader = L.slotId; r.leaderName = L.nickname;
  const join = (a: Account, stealth: boolean) => handleJoinRoom(clients.get(a.playerId)!, new PacketReader(new PacketWriter().writeD(r.roomId).writeS("", 4).writeC(0).writeC(stealth ? 1 : 0).toBytes(), 0));
  const P1 = mk(101n, "P1"), P2 = mk(102n, "P2"), GM = mk(GM_PID, "StaffGM", true);
  join(P1, false); join(P2, false); join(GM, true);
  const ready = (a: Account, mode = 0) => { a.last.readyBattle = 0; handleReadyBattle(clients.get(a.playerId)!, new PacketReader(new PacketWriter().writeC(mode).writeD(0).toBytes(), 0)); };
  const loading = (a: Account) => handleLoadingStart(clients.get(a.playerId)!, new PacketReader(new PacketWriter().writeC(4).writeS("test", 4).toBytes(), 0));
  const preStart = (a: Account) => handlePreStartBattle(clients.get(a.playerId)!, new PacketReader(new PacketWriter().writeC(r.mapId).writeC(r.rule).writeC(r.stage).writeC(r.roomType).toBytes(), 0));
  const startBattle = (a: Account) => handleStartBattle(clients.get(a.playerId)!);
  const respawn = (a: Account) => handleRespawn(clients.get(a.playerId)!, new PacketReader(new Uint8Array(160), 0));
  const normal = () => accounts.filter((a) => !a.isGM());
  /** packets to normal accounts that name the GM's seat (slot-one 3588 / start-battle 5132 / respawn 5138 / team balance 3622) */
  const leaks = (seat: number) => sent.filter((x) => x.to !== GM_PID && (
    (x.op === 5138 && u32(x.bytes, 2) === seat) || (x.op === 5132 && x.bytes[x.bytes.length - 1] === seat) || x.op === 3622
    || (x.op === 3588 && x.bytes[4] === seat)));
  return { r, sent, L, P1, P2, GM, ready, loading, preStart, startBattle, respawn, normal, leaks };
}

/** LOADING_START (leader first), PRESTART, STARTBATTLE for everyone in LOAD, then the round spawn timer */
function runToBattle(w: ReturnType<typeof world>) {
  const inLoad = [w.L, w.P1, w.P2, w.GM].filter((a) => w.r.slots[a.slotId].state === SlotState.LOAD);
  for (const a of inLoad) w.loading(a);
  for (const a of inLoad) w.preStart(a);
  for (const a of inLoad) w.startBattle(a);
  mock.timers.tick(10);
}

for (const mode of [0, 2]) {
  test(`hidden GM READY (mode ${mode}) with the others, leader starts: observer seat, specGM, never a combatant`, () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    try {
      const w = world();
      const gs = w.r.slots[w.GM.slotId];
      assert.ok(w.GM.slotId === 16 || w.GM.slotId === 17, `GM seated at ${w.GM.slotId}`);
      assert.deepEqual([gs.stealth, gs.specGM], [true, true]);
      w.ready(w.P1); w.ready(w.P2); w.ready(w.GM, mode);
      assert.equal(gs.state, SlotState.READY);
      assert.equal(gs.specGM, true, "READY keeps specGM whatever mode the client sent");
      w.ready(w.L); // TDM: no countdown, startBattle at once
      assert.equal(w.r.state, RoomState.LOADING);
      assert.equal(w.GM.slotId, gs.id, "the start does not move the GM out of its seat");
      assert.equal(gs.state, SlotState.LOAD);
      const start = w.sent.filter((x) => x.op === 5127);
      assert.ok(start.some((x) => x.to === GM_PID), "the GM gets START_GAME");
      runToBattle(w);
      assert.equal(w.r.state, RoomState.BATTLE);
      assert.equal(gs.state, SlotState.BATTLE);
      assert.equal(gs.specGM, true, "specGM survives LOAD / PRESTART / STARTBATTLE / round spawn");
      for (const a of [w.L, w.P1, w.P2, w.GM]) w.respawn(a);
      assert.equal(gs.specGM, true);
      assert.deepEqual(w.leaks(gs.id).map((x) => `${x.op}->${x.to}`), [], "nothing about the GM seat reaches a normal account");
      assert.ok(w.sent.some((x) => x.to === GM_PID && x.op === 5138 && u32(x.bytes, 2) === gs.id), "the GM's own first RESPAWN_ACK goes to the GM only");
    } finally { mock.timers.reset(); }
  });
}

test("hidden GM READY races the leader's start (room already LOADING, team balance on): stays in the observer seat", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const w = world(TDM, 1); // BalanceType Count
    const seat = w.GM.slotId;
    w.ready(w.P1); w.ready(w.P2);
    w.ready(w.L); // leader starts before the GM's READY lands: 2 FR (leader, P2) vs 1 CT (P1) -> the joiner path balances
    assert.equal(w.r.state, RoomState.LOADING);
    w.ready(w.GM, 2);
    const gs = w.r.slots[w.GM.slotId];
    assert.equal(w.GM.slotId, seat, "the late READY must not team-balance the GM into a combatant seat");
    assert.deepEqual([gs.stealth, gs.specGM, gs.state], [true, true, SlotState.LOAD]);
    runToBattle(w);
    assert.equal(gs.specGM, true);
    assert.deepEqual(w.leaks(seat).map((x) => `${x.op}->${x.to}`), [], "no 3622 / 3588 / 5132 about the GM to a normal account");
  } finally { mock.timers.reset(); }
});

test("Bomb: the 5153 ROUND_START slots flag carries the GM seat (C# GetSlotsFlag): the client must not read it as 'plays the round'", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const w = world(BOMB);
    w.ready(w.P1); w.ready(w.P2); w.ready(w.GM, 2);
    w.ready(w.L); // Bomb has a countdown
    mock.timers.tick(5300);
    assert.equal(w.r.state, RoomState.LOADING);
    runToBattle(w);
    const rs = w.sent.filter((x) => x.op === 5153 && x.to === GM_PID);
    assert.ok(rs.length >= 1, "the GM gets ROUND_START");
    const flag = u32(rs[0].bytes, 2 + 1 + 4);
    assert.equal((flag >>> w.GM.slotId) & 1, 1, "the GM's bit is set: in-round state comes from the room, not from specGM");
    assert.equal(w.r.slots[w.GM.slotId].specGM, true);
  } finally { mock.timers.reset(); }
});
