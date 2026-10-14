// AI room start rule (readyCounts) and re-entry seat (RoomModel.addPlayer + removePlayer lastSeat).   node --test test/aiRoomSeat.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readyCounts, removePlayer } from "../src/game/roomHandlers.ts";
import { SlotState, RoomState } from "../src/game/roomModel.ts";
import { battleRoom } from "./fakeRoom.ts";

/** AI room (stage 2), leader in slot 0 (team FR), `ready` guests READY on the leader's team (slots 2, 4, 6...). */
const aiRoom = (ready: number) => {
  const f = battleRoom(1 + ready);
  f.room.stage = 2; f.room.state = RoomState.READY;
  f.accounts.forEach((a, i) => { const s = f.room.slots[i]; s.state = SlotState.NORMAL; s.playerId = 0n; s.playerId = a.playerId; });
  // seat guests on the leader's team: 0 (leader), 2, 4, 6
  const seats = [0, 2, 4, 6];
  f.room.slots.forEach((s) => { s.playerId = 0n; s.state = SlotState.EMPTY; });
  f.accounts.forEach((a, i) => { const s = f.room.slots[seats[i]]; s.playerId = a.playerId; a.slotId = s.id; s.state = i === 0 ? SlotState.NORMAL : SlotState.READY; });
  return f;
};

for (const n of [1, 2, 3]) {
  test(`AI room, ${n} humans ready on the leader's team: no enemy needed, the leader's click starts it`, () => {
    const f = aiRoom(n);
    assert.equal(readyCounts(f.room).enemies, 0);
  });
}

test("a versus room with 2 ready keeps the 1v1 shortcut (enemies = 1)", () => {
  const f = aiRoom(2);
  f.room.stage = 1;
  assert.equal(readyCounts(f.room).enemies, 1);
});

test("re-entry: the player who left the match gets the same seat back, else a free seat of the same team", () => {
  const f = battleRoom(6); // slots 0..5, teams 0 1 0 1 0 1
  for (const a of f.accounts) Object.assign(a, { statistic: {}, exp: 0, gold: 0, status: { roomId: 0, buffer: new Uint8Array(4) } });
  const me = f.accounts[4], free = (i: number) => { f.room.slots[i].state = SlotState.EMPTY; f.room.slots[i].playerId = 0n; };
  removePlayer(f.room, me, true);
  assert.equal(f.room.lastSeat.get(me.playerId), 4);
  free(1); free(2); // lower seats open up meanwhile, one per team
  assert.equal(f.room.addPlayer(me), 4, "same slot when free");
  f.room.slots[4].state = SlotState.BATTLE; // back in the match
  removePlayer(f.room, me, true);
  f.room.slots[4].playerId = 999n; f.room.slots[4].state = SlotState.NORMAL; // seat taken meanwhile
  const seat = f.room.addPlayer(me);
  assert.equal(seat, 2, "free seat of the same team (team 0), not slot 1 (team 1)");
  assert.ok(!f.room.lastSeat.has(me.playerId), "memory consumed");
});

test("a new player (no memory) still gets the first free seat", () => {
  const f = battleRoom(2);
  f.room.slots[0].state = SlotState.EMPTY; f.room.slots[0].playerId = 0n;
  assert.equal(f.room.addPlayer(f.accounts[0]), 0);
});
