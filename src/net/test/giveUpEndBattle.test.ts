// GIVEUP_BATTLE in a Bomb 1v1 (server roomHandlers.ts leaveEndBattlePVP): the one who stayed gets 5140 ENDBATTLE with the result
// table. RoomClient hands it on as onEndBattle (winner + exp / gold per slot), which boot.ts passes to game.showFinal.
// Body built like server roomPackets.ts endBattleAck: D slotFlag, C winner, 378 B result (exp u16 x18 @0, gold u16 x18 @36).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PacketReader } from "../packet.ts";
import { RoomClient, RoomOp } from "../roomClient.ts";

type Listener = (op: number, r: PacketReader) => void;

test("5140 after a give-up (1v1 bomb): winner + exp / gold reach onEndBattle", () => {
  let listener: Listener | null = null;
  const game = { conn: { on: (cb: Listener) => { listener = cb; return () => {}; }, send: () => {} } };
  const rc = new RoomClient(game as never) as unknown as { room: unknown; onEndBattle: ((e: { winner: number; exp?: number[]; gold?: number[] }) => void) | null };
  rc.room = { roomType: 8 }; // Bomb: the 5140 layout of mode 2 (round scores + zeros)
  const seen: { winner: number; exp?: number[]; gold?: number[] }[] = [];
  rc.onEndBattle = (e) => seen.push(e);
  const body = new Uint8Array(4 + 1 + 378);
  const v = new DataView(body.buffer);
  v.setUint32(0, 0x3, true); // slotFlag
  body[4] = 0; // winner FR
  v.setUint16(5 + 0 * 2, 2250, true); // slot 0 (the one who stayed) exp
  v.setUint16(5 + 36 + 0 * 2, 1125, true); // gold
  listener!(RoomOp.BATTLE_ENDBATTLE_ACK, new PacketReader(body));
  assert.equal(seen.length, 1, "onEndBattle called once");
  const got = seen[0];
  assert.equal(got.winner, 0);
  assert.equal(got.exp?.length, 18);
  assert.equal(got.exp![0], 2250, "exp[slot] for boot.ts showFinal");
  assert.equal(got.gold![0], 1125, "gold[slot] for boot.ts showFinal");
});
