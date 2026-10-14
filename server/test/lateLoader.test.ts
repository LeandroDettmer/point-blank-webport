// STARTBATTLE spawn gate with a late loader (roomHandlers.ts handleStartBattle): the round must not start while a player of
// the other team is still loading. Bomb 2 FR (TR) vs 1 CT, leader FR. Public channel (type 1) and clan channel (type 4).
//   node --test test/lateLoader.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomState, SlotState } from "../src/game/roomModel.ts";
import { handleStartBattle } from "../src/game/roomHandlers.ts";
import { battleRoom, type Fixture } from "./fakeRoom.ts";
import type { GameClient } from "../src/game/gameServer.ts";

const BOMB = 8, TR_LEADER = 0, TR_2 = 2, CT = 1;

/** 2 TR (slots 0, 2) PRESTART, CT (slot 1) in `ctState`; room PRE_BATTLE, leader slot 0 */
function lateRoom(channelType: number, ctState: number): Fixture {
  const f = battleRoom(3);
  const r = f.room;
  (r.channel as unknown as { type: number }).type = channelType;
  r.state = RoomState.PRE_BATTLE; r.roomType = BOMB; r.leader = TR_LEADER;
  r.buildRoomInfo = () => Uint8Array.of(0x11, 0x0e);
  r.slots.forEach((s, i) => {
    if (i < 3) { s.state = i === CT ? ctState : SlotState.PRESTART; s.playerId = f.accounts[i].playerId; } else s.state = SlotState.CLOSE;
  });
  return f;
}
const startBattle = (f: Fixture, slot: number) => handleStartBattle({ player: f.accounts[slot], session: { send: () => {} } } as unknown as GameClient);
const spawnScheduled = (f: Fixture) => f.room.preMatchTimer !== null;
const done = (f: Fixture) => { if (f.room.preMatchTimer) clearTimeout(f.room.preMatchTimer); f.room.preMatchTimer = null; };

for (const channelType of [1, 4]) {
  test(`channel ${channelType}: both TRs ready, CT still loading -> no spawn, round waits for the CT`, () => {
    const f = lateRoom(channelType, SlotState.LOAD);
    startBattle(f, TR_LEADER);
    startBattle(f, TR_2);
    assert.equal(f.room.slots[TR_2].state, SlotState.BATTLE_READY);
    assert.equal(spawnScheduled(f), false, "no spawn with the CT still loading");
    assert.equal(f.room.state, RoomState.PRE_BATTLE);
    done(f);
  });

  test(`channel ${channelType}: CT loads last -> spawn after the CT's STARTBATTLE`, () => {
    const f = lateRoom(channelType, SlotState.PRESTART);
    startBattle(f, TR_LEADER);
    startBattle(f, TR_2);
    assert.equal(spawnScheduled(f), false, "CT in PRESTART is not ready yet");
    startBattle(f, CT);
    assert.equal(spawnScheduled(f), true, "all three ready: spawn");
    done(f);
  });
}
