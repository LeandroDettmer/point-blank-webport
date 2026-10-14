// Bomb Mission planted / defused by an AI seat (roomHandlers.ts isBotSeat): the leader of an AI room asks in the bot's slot,
// the same 5156 / 5158 -> 5157 / 5159 + round end path as a human.   node --test test/botBomb.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBombInstall, handleBombUninstall } from "../src/game/roomHandlers.ts";
import { PacketReader, PacketWriter } from "../../src/net/packet.ts";
import { battleRoom, u32, type Fixture } from "./fakeRoom.ts";
import type { GameClient } from "../src/game/gameServer.ts";

const BOT = 15;
const install = (f: Fixture, from: number, slot: number) => handleBombInstall({ player: f.accounts[from] } as unknown as GameClient,
  new PacketReader(new PacketWriter(24).writeD(slot).writeC(1).writeD(0).writeT(3).writeT(0.5).writeT(-4).toBytes()));
const uninstall = (f: Fixture, from: number, slot: number) => handleBombUninstall({ player: f.accounts[from] } as unknown as GameClient,
  new PacketReader(new PacketWriter(8).writeD(slot).toBytes()));
const aiBomb = (stage: number): Fixture => {
  const f = battleRoom(2);
  f.room.stage = stage; f.room.roomType = 8; f.room.killTime = 0x13; f.room.leader = 0;
  return f;
};
const done = (f: Fixture) => { f.room.stopTimers(); f.room.stopBomb(); };

test("the leader of an AI room plants in a bot's slot: 5157 to everybody with that slot, the server fuse starts", () => {
  const f = aiBomb(2);
  install(f, 0, BOT);
  const acks = f.ops(5157);
  assert.equal(acks.length, 2, "both humans get the ACK");
  assert.equal(u32(acks[0].bytes, 2), BOT, "ACK names the bot slot");
  assert.equal(f.room.activeC4, true);
  assert.equal(f.room.bombSlot, BOT);
  assert.ok(f.room.bombEndAt - Date.now() > 41000, "fuse = 42 s from the plant");
  done(f);
});

test("the bot's defuse: 5159 with its slot, the round ends for the defenders (5155 motive 3)", () => {
  const f = aiBomb(2);
  install(f, 0, BOT);
  f.clear();
  uninstall(f, 0, 14);
  assert.equal(f.ops(5159).length, 2);
  assert.equal(u32(f.ops(5159)[0].bytes, 2), 14);
  assert.equal(f.ops(5155).length, 2, "the round-end ACK reaches both");
  assert.equal(f.room.ctRounds, 1, "the defenders (CT) score the round");
  assert.equal(f.room.activeC4, false);
  done(f);
});

test("only the leader speaks for a bot, and only in an AI room, and never for a seat a player holds", () => {
  const notLeader = aiBomb(2);
  install(notLeader, 1, BOT);
  assert.equal(notLeader.ops(5157).length, 0, "a guest cannot plant for a bot");
  assert.equal(notLeader.room.activeC4, false);

  const noAi = aiBomb(1);
  install(noAi, 0, BOT);
  assert.equal(noAi.ops(5157).length, 0, "no AI in this room: an empty seat plants nothing");

  const humanSeat = aiBomb(2);
  humanSeat.room.slots[BOT].playerId = 777n; // a (disconnected-state) player owns it: not an AI seat
  install(humanSeat, 0, BOT);
  assert.equal(humanSeat.ops(5157).length, 0);
  [notLeader, noAi, humanSeat].forEach(done);
});

test("a second plant while the C4 is down is ignored (a retry after a dropped request)", () => {
  const f = aiBomb(2);
  install(f, 0, BOT);
  install(f, 0, 13);
  assert.equal(f.ops(5157).length, 2, "one ACK per human, not two");
  assert.equal(f.room.bombSlot, BOT);
  done(f);
});
