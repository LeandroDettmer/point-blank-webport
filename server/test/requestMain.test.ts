// ROOM_REQUEST_MAIN_REQ (3611) in the ready room: majority (all / 2 + 1) takes the leadership; a GM takes it at once.
//   node --test test/requestMain.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { handleRequestMain } from "../src/game/roomHandlers.ts";
import { RoomState, SlotState } from "../src/game/roomModel.ts";
import type { GameClient } from "../src/game/gameServer.ts";
import { pool } from "../src/db.ts";
import { battleRoom, u32 } from "./fakeRoom.ts";

after(async () => { await pool.end(); });

const clientOf = (a: ReturnType<typeof battleRoom>["accounts"][number]) => {
  const c = a.connection as unknown as GameClient;
  (c as unknown as { player: unknown }).player = a;
  return c;
};
const ready = (n: number) => {
  const f = battleRoom(n);
  f.room.state = RoomState.READY;
  for (const s of f.room.slots) if (s.playerId > 0n) s.state = SlotState.NORMAL;
  return f;
};

test("3611: each vote is announced (3612 {slot}); the majority takes the leader (3616 + SLOTINFO)", () => {
  const f = ready(4); // need 4 / 2 + 1 = 3
  handleRequestMain(clientOf(f.accounts[2]));
  assert.equal(f.ops(3612).length, 4);
  assert.equal(u32(f.ops(3612)[0].bytes, 2), 2);
  handleRequestMain(clientOf(f.accounts[2])); // the same player again does not count twice
  assert.equal(f.room.requestRoomMaster.length, 1);
  handleRequestMain(clientOf(f.accounts[1]));
  assert.equal(f.room.leader, 0);
  handleRequestMain(clientOf(f.accounts[3]));
  assert.equal(f.room.leader, 3, "the one who asked last tipped the majority");
  assert.equal(u32(f.ops(3616)[0].bytes, 2), 3);
  assert.deepEqual(f.room.requestRoomMaster, []);
});

test("3611: the leader is ignored, a GM takes over at once, outside READY only a GM can", () => {
  const f = ready(4);
  handleRequestMain(clientOf(f.accounts[0]));
  assert.equal(f.sent.length, 0);
  (f.accounts[1] as unknown as { isGM: () => boolean }).isGM = () => true;
  handleRequestMain(clientOf(f.accounts[1]));
  assert.equal(f.room.leader, 1);
  const g = ready(4);
  g.room.state = RoomState.BATTLE;
  handleRequestMain(clientOf(g.accounts[2]));
  assert.equal(g.room.leader, 0, "a player cannot ask in battle (the in-battle vote is 9010)");
  (g.accounts[2] as unknown as { isGM: () => boolean }).isGM = () => true;
  handleRequestMain(clientOf(g.accounts[2]));
  assert.equal(g.room.leader, 2, "GM in battle: leader moves and 5149 tells the P2P layer");
  assert.equal(g.ops(5149).length > 0 || g.room.slots.every((s) => s.state < SlotState.RENDEZVOUS), true);
});
