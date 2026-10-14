// BATTLE_START_COUNTDOWN_ACK 5126 (C byte, CountDownEnum: 5 Start, 254 StopByPlayer, 255 StopByHost): the leader's start in a
// countdown mode (Bomb) sends 5, and every cancel path sends 254 / 255 with the room back to READY.
//   node --test test/countdown.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db.ts";
import { RoomState, SlotState, Team, loadMaps } from "../src/game/roomModel.ts";
import { handleReadyBattle, removePlayer, stopCountDownBySlot } from "../src/game/roomHandlers.ts";
import { PacketReader, PacketWriter } from "../../src/net/packet.ts";
import { battleRoom, type Fixture } from "./fakeRoom.ts";
import type { Account } from "../src/shared/account.ts";

const BOMB = 8, BOMB_RULE = 3, MAP = 4;

before(async () => {
  // system_map_matches / system_map_rules without Postgres: one Bomb match on map 4 (16 players), nothing else touches the pool
  (pool as unknown as { query: (sql: string) => Promise<{ rows: unknown[] }> }).query = async (sql: string) => ({
    rows: sql.includes("system_map_matches") ? [{ map_id: MAP, mode_id: 2, map_limit: 16, tag: 0, name: "test" }]
      : sql.includes("system_map_rules") ? [{ mode_id: 2, rule: BOMB_RULE, stage_options: 1, conditions: BOMB, name: "bomb" }] : [],
  });
  await loadMaps();
});

/** Bomb room in READY: leader P0 (FR) NORMAL, guests P1 (CT), P2 (FR), P3 (CT) READY; everybody equipped. */
function bombRoom(): Fixture {
  const f = battleRoom(4);
  const r = f.room;
  r.state = RoomState.READY;
  r.mapId = MAP; r.rule = BOMB_RULE; r.stage = 1; r.roomType = BOMB;
  r.buildRoomInfo = () => Uint8Array.of(0x11, 0x0e);
  r.buildSlotInfo = () => Uint8Array.of(0x13, 0x0e);
  r.slots.forEach((s, i) => { if (i < 4) { s.state = i === 0 ? SlotState.NORMAL : SlotState.READY; s.equipment = {} as never; } });
  return f;
}

const ready = (a: Account) => handleReadyBattle({ player: a, session: { send: () => {} } } as never, new PacketReader(new PacketWriter().writeC(0).toBytes(), 0));
/** the 5126 bytes each player got, in order */
const countdowns = (f: Fixture) => f.ops(5126).map((x) => ({ to: Number(x.to), type: x.bytes[2] }));
const toAll = (f: Fixture, type: number) => f.accounts.every((a) => countdowns(f).some((c) => c.to === Number(a.playerId) && c.type === type));

test("leader start in a countdown mode: 5126 type 5 to everyone, room COUNTDOWN", () => {
  const f = bombRoom();
  ready(f.accounts[0]);
  assert.equal(f.room.state, RoomState.COUNTDOWN);
  assert.ok(toAll(f, 5), JSON.stringify(countdowns(f)));
  assert.equal(f.room.slots[0].state, SlotState.READY);
  assert.ok(f.room.countdownTimer, "server timer runs");
  ready(f.accounts[0]); // cancel, clears the timer
});

test("leader presses start again: 5126 type 255 (StopByHost), room READY, leader NORMAL", () => {
  const f = bombRoom();
  ready(f.accounts[0]);
  f.clear();
  ready(f.accounts[0]);
  assert.equal(f.room.state, RoomState.READY);
  assert.ok(toAll(f, 255), JSON.stringify(countdowns(f)));
  assert.equal(f.room.slots[0].state, SlotState.NORMAL);
  assert.equal(f.room.countdownTimer, null);
});

test("the last READY enemy unreadies: 5126 type 254 (StopByPlayer)", () => {
  const f = bombRoom();
  f.room.slots[3].state = SlotState.NORMAL; // CT: only P1 is READY
  ready(f.accounts[0]);
  assert.equal(f.room.state, RoomState.COUNTDOWN);
  f.clear();
  ready(f.accounts[1]);
  assert.equal(f.room.getPlayingPlayers(Team.CT, SlotState.READY, 0), 0);
  assert.equal(f.room.state, RoomState.READY);
  assert.ok(toAll(f, 254), JSON.stringify(countdowns(f)));
  assert.equal(f.room.slots[0].state, SlotState.NORMAL);
  assert.equal(f.room.countdownTimer, null);
});

test("an enemy unreadies while another stays READY: the countdown goes on", () => {
  const f = bombRoom();
  ready(f.accounts[0]);
  f.clear();
  ready(f.accounts[1]); // P3 (CT) still READY
  assert.equal(f.room.state, RoomState.COUNTDOWN);
  assert.equal(countdowns(f).length, 0);
  ready(f.accounts[0]);
});

test("the leader leaves: 5126 type 255 to the others", () => {
  const f = bombRoom();
  ready(f.accounts[0]);
  f.clear();
  removePlayer(f.room, f.accounts[0], true);
  assert.equal(f.room.state, RoomState.READY);
  assert.equal(f.room.countdownTimer, null);
  assert.ok(countdowns(f).some((c) => c.type === 255), JSON.stringify(countdowns(f)));
});

test("the last READY player of a team leaves: 5126 type 254", () => {
  const f = bombRoom();
  f.room.slots[3].state = SlotState.NORMAL;
  ready(f.accounts[0]);
  f.clear();
  removePlayer(f.room, f.accounts[1], true);
  assert.equal(f.room.state, RoomState.READY);
  assert.equal(f.room.countdownTimer, null);
  assert.ok(countdowns(f).some((c) => c.type === 254), JSON.stringify(countdowns(f)));
});

test("leader opens shop / inventory during the countdown (StopCountDown(SlotId)): 5126 type 255", () => {
  const f = bombRoom();
  ready(f.accounts[0]);
  f.clear();
  f.room.changeSlotState(0, SlotState.SHOP, false);
  stopCountDownBySlot(f.room, 0);
  assert.equal(f.room.state, RoomState.READY);
  assert.ok(toAll(f, 255), JSON.stringify(countdowns(f)));
  assert.equal(f.room.countdownTimer, null);
  stopCountDownBySlot(f.room, 0); // outside COUNTDOWN: nothing more goes out
  assert.equal(countdowns(f).length, f.accounts.length);
});

test("TDM has no countdown: the leader's start goes straight to LOADING (no 5126)", () => {
  const f = bombRoom();
  f.room.roomType = 4;
  for (const a of f.accounts) (a as unknown as { mission: { clone(): unknown } }).mission = { clone: () => ({}) };
  ready(f.accounts[0]);
  assert.equal(countdowns(f).length, 0);
  assert.equal(f.room.state, RoomState.LOADING);
  f.room.stopTimers?.();
});
