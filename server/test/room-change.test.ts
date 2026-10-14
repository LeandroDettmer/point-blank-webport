// Offline round trip of ROOM_CHANGE_ROOMINFO_REQ (3640): the client (src/net/roomClient.ts) parses a 3601 room block
// written by this server, builds the 3640 body from it, and the server's readChangeRoomInfo reads back the changed
// fields plus the untouched option half (random maps, leader addr, kill cam...) exactly as echoed.
//   node --test test/room-change.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PacketReader } from "../../src/net/packet.ts";
import { buildChangeRoomInfoBody, parseRoomInfoBlock } from "../../src/net/roomClient.ts";
import { roomInfoBlock } from "../src/game/roomPackets.ts";
import { readChangeRoomInfo } from "../src/game/roomHandlers.ts";
import type { RoomModel } from "../src/game/roomModel.ts";

const randomMaps = Uint8Array.from({ length: 24 }, (_, i) => i + 1);
const fakeRoom = {
  roomId: 7, name: "sala do teste", mapId: 4, rule: 0, stage: 1, roomType: 4, state: 1, ping: 3, weaponsFlag: 0x1ff, newInt: 77,
  leaderName: "Leader", killTime: 0x63, limit: 1, watchRuleFlag: 2, balanceType: 1, randomMaps, leaderAddr: Uint8Array.of(10, 0, 0, 9), killCam: 1,
  getCountPlayers: () => 3, getVisiblePlayers: () => 3, getSlotCount: () => 16, getFlag: () => 0x40,
} as unknown as RoomModel;

test("3601 block -> client summary keeps the option half", () => {
  const s = parseRoomInfoBlock(new PacketReader(roomInfoBlock(fakeRoom)));
  assert.equal(s.name, "sala do teste");
  assert.equal(s.killTime, 0x63);
  assert.ok(s.opts);
  assert.deepEqual([...s.opts!.randomMaps], [...randomMaps]);
  assert.deepEqual([...s.opts!.leaderAddr], [10, 0, 0, 9]);
  assert.equal(s.opts!.killCam, 1);
  assert.equal(s.opts!.newInt, 77);
});

test("client 3640 body is read back by the server with the leader's changes applied", () => {
  const s = parseRoomInfoBlock(new PacketReader(roomInfoBlock(fakeRoom)));
  const body = buildChangeRoomInfoBody(s, { mapId: 9, stage: 96, weaponsFlag: 79, killTime: 0x62, name: "sniper" }, null).toBytes();
  const q = readChangeRoomInfo(new PacketReader(body));
  assert.equal(q.name, "sniper");
  assert.equal(q.mapId, 9);
  assert.equal(q.rule, 0);
  assert.equal(q.stage, 96);
  assert.equal(q.roomType, 4);
  assert.equal(q.weaponsFlag, 79);
  assert.equal(q.killTime, 0x62);
  assert.equal(q.slotCount, 16);
  assert.equal(q.leaderName, "Leader");
  assert.equal(q.ping, 3);
  assert.equal(q.newInt, 77);
  assert.equal(q.stageFlag, 0x40);
  assert.equal(q.limit, 1);
  assert.equal(q.watchRuleFlag, 2);
  assert.equal(q.balance, 1);
  assert.deepEqual([...q.randomMaps], [...randomMaps]);
  assert.deepEqual([...q.leaderAddr], [10, 0, 0, 9]);
  assert.equal(q.killCam, 1);
  // D + U46 + 8C + H D H D H + U66 + D + C C H + B24 + C + B4 + C + H + C C = 180
  assert.equal(body.length, 180, "C# Read() consumes exactly 180 bytes");
});

test("AI count / level ride at the end of the body", () => {
  const s = parseRoomInfoBlock(new PacketReader(roomInfoBlock(fakeRoom)));
  const q = readChangeRoomInfo(new PacketReader(buildChangeRoomInfoBody(s, { stage: 2, ai: { count: 6, level: 4 } }, null).toBytes()));
  assert.equal(q.stage, 2);
  assert.equal(q.aiCount, 6);
  assert.equal(q.aiLevel, 4);
});
