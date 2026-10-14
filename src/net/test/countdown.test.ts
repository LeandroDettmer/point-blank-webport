// BATTLE_START_COUNTDOWN_ACK 5126 on the client: RoomClient hands the byte to onCountdown signed like the exe (255 = -1 StopByHost,
// 254 = -2 StopByPlayer), and the leader's start() resolves on it ("countdown") instead of waiting for START_GAME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PacketReader, PacketWriter } from "../packet.ts";
import { RoomClient, RoomOp } from "../roomClient.ts";

type Listener = (op: number, r: PacketReader) => void;
function fakeGame() {
  const listeners = new Set<Listener>();
  const sent: number[] = [];
  const conn = {
    on(fn: Listener) { listeners.add(fn); return () => listeners.delete(fn); },
    send(op: number) { sent.push(op); },
  };
  /** server packet: [H opcode][body], one fresh reader per listener like PbConnection */
  const push = (op: number, body: PacketWriter) => {
    const payload = new PacketWriter().writeH(op).writeB(body.toBytes()).toBytes();
    for (const fn of [...listeners]) fn(op, new PacketReader(payload, 2));
  };
  return { game: { conn } as never, push, sent };
}

test("5126 reaches onCountdown signed: 5, 255 -> -1, 254 -> -2", () => {
  const { game, push } = fakeGame();
  const room = new RoomClient(game);
  const got: number[] = [];
  room.onCountdown = (n) => got.push(n);
  for (const b of [5, 255, 254]) push(RoomOp.BATTLE_START_COUNTDOWN_ACK, new PacketWriter().writeC(b));
  assert.deepEqual(got, [5, -1, -2]);
  room.dispose();
});

test("leader start(): READYBATTLE out, resolves 'countdown' on 5126, 'game' on START_GAME", async () => {
  const { game, push, sent } = fakeGame();
  const room = new RoomClient(game);
  const cd = room.start();
  assert.deepEqual(sent, [RoomOp.BATTLE_READYBATTLE_REQ]);
  push(RoomOp.BATTLE_START_COUNTDOWN_ACK, new PacketWriter().writeC(5));
  assert.equal(await cd, "countdown");
  const tdm = room.start();
  push(RoomOp.BATTLE_START_GAME_ACK, new PacketWriter().writeD(0));
  assert.equal(await tdm, "game");
  room.dispose();
});
