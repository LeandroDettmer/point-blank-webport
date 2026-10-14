// Destroy (Sabotagem) round rules, 5166 GENERATOR_INFO_REQ (roomHandlers.ts handleGeneratorInfo): bars and slot damage set, 5167 to the
// battle, bar1 0 → CT, bar2 0 → FR, no swap flip, other room types ignored.   node --test test/destroyGenerator.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleGeneratorInfo } from "../src/game/roomHandlers.ts";
import { PacketReader, PacketWriter } from "../../src/net/packet.ts";
import { RoomCondition } from "../src/game/roomModel.ts";
import { battleRoom } from "./fakeRoom.ts";
import type { GameClient } from "../src/game/gameServer.ts";

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);

function send(f: ReturnType<typeof battleRoom>, slot: number, bar1: number, bar2: number, dmg: number[]): void {
  const w = new PacketWriter(64).writeH(bar1).writeH(bar2);
  for (let i = 0; i < 18; i++) w.writeH(dmg[i] ?? 0);
  handleGeneratorInfo({ player: f.accounts[slot] } as unknown as GameClient, new PacketReader(w.toBytes()));
}

test("5166 sets bars and slot damage, answers 5167 (42 bytes) to the battle", () => {
  const f = battleRoom(2);
  f.room.roomType = RoomCondition.Destroy; f.room.mapId = 17; f.room.killTime = 0x13;
  const dmg = Array.from({ length: 18 }, (_, i) => (i === 0 ? 1200 : 0));
  send(f, 0, 5400, 6000, dmg);
  const ack = f.ops(5167);
  assert.equal(ack.length, 2, "5167 to both fighters");
  assert.equal(ack[0].bytes.length, 2 + 2 + 2 + 18 * 2, "5167 body: H bar1, H bar2, 18 x H DamageBar1");
  assert.equal(u16(ack[0].bytes, 2), 5400); assert.equal(u16(ack[0].bytes, 4), 6000); assert.equal(u16(ack[0].bytes, 6), 1200);
  assert.equal(f.room.slots[0].damageBar1, 1200);
  assert.equal(f.room.slots[0].earnedEXP, 2, "EarnedEXP = DamageBar1 / 600");
  assert.equal(f.ops(5155).length, 0, "no round end while both bars are up");
  f.room.stopTimers();
});

test("bar1 0 ends the round for CT (5155 Normal = 5), rounds +1 for CT", () => {
  const f = battleRoom(2);
  f.room.roomType = RoomCondition.Destroy; f.room.mapId = 17; f.room.killTime = 0x13;
  send(f, 1, 0, 6000, new Array(18).fill(0));
  assert.equal(f.room.ctRounds, 1); assert.equal(f.room.frRounds, 0);
  const end = f.ops(5155);
  assert.equal(end.length, 2);
  assert.equal(end[0].bytes[2], 1, "winner CT");
  assert.equal(end[0].bytes[3], 5, "motive Normal");
  f.room.stopTimers();
});

test("bar2 0 ends the round for FR, no swap flip (5166 path)", () => {
  const f = battleRoom(2);
  f.room.roomType = RoomCondition.Destroy; f.room.mapId = 17; f.room.killTime = 0x13; f.room.swapRound = true;
  send(f, 0, 6000, 0, new Array(18).fill(0));
  assert.equal(f.room.frRounds, 1); assert.equal(f.room.ctRounds, 0);
  assert.equal(f.ops(5155)[0].bytes[2], 0, "winner FR");
  f.room.stopTimers();
});

test("only Destroy takes 5166: a Bomb room drops it", () => {
  const f = battleRoom(2);
  f.room.roomType = RoomCondition.Bomb; f.room.mapId = 17; f.room.killTime = 0x13;
  send(f, 0, 0, 0, new Array(18).fill(0));
  assert.equal(f.ops(5167).length, 0);
  assert.equal(f.ops(5155).length, 0);
  assert.equal(f.room.ctRounds + f.room.frRounds, 0);
});
