// Bomb Mission wipe with a GM observer in the room (roomHandlers.ts checkBombWipe): the observer seat 16 is team FR by id but on no
// side, so the last FR death must still end the round.   node --test test/bombWipeGm.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleDeath } from "../src/game/roomHandlers.ts";
import { PacketReader, PacketWriter } from "../../src/net/packet.ts";
import { SlotState } from "../src/game/roomModel.ts";
import { battleRoom } from "./fakeRoom.ts";
import type { GameClient } from "../src/game/gameServer.ts";

test("CT kills the last FR with a GM watching from seat 16: round ends for CT (5155)", () => {
  const f = battleRoom(2);
  f.room.roomType = 8; f.room.killTime = 0x13;
  const gm = f.room.slots[16];
  gm.playerId = 900n; gm.state = SlotState.BATTLE; gm.specGM = true;
  // 1 frag: killer slot 1 (CT) -> victim slot 0 (FR), body hit, assist = killer
  const pkt = new PacketWriter(64).writeC(0).writeC(1).writeC(1).writeD(100003).writeT(0).writeT(0).writeT(0).writeC(0).writeC(0)
    .writeC(0).writeC(1).writeC(0x10).writeH(0).writeC(0).writeT(0).writeT(0).writeT(0).writeC(1).writeB(new Uint8Array(4)).toBytes();
  handleDeath({ player: f.accounts[1] } as unknown as GameClient, new PacketReader(pkt));
  assert.equal(f.ops(5155).length, 2, "round-end ACK to both fighters");
  assert.equal(f.room.ctRounds, 1);
  f.room.stopTimers(); f.room.stopBomb();
});
