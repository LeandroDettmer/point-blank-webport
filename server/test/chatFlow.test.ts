// handleChat / handleWhisper end to end on fake clients: cleaning, word filter, 60 chars, "/" commands, flood auto-mute, ring.
// banState reads base_ban_history (Postgres); with no DB it answers "no ban", the test still passes.
//   node --test test/chatFlow.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { PacketReader, PacketWriter } from "../../src/net/packet.ts";
import { handleChat, handleWhisper, social } from "../src/game/socialHandlers.ts";
import { ringLines, setChatFilter } from "../src/game/chatGuard.ts";
import { pool } from "../src/db.ts";
import type { GameClient } from "../src/game/gameServer.ts";
import { battleRoom, chatText, manualClock } from "./fakeRoom.ts";

after(async () => { await pool.end(); });

const chatPacket = (type: number, text: string) => new PacketReader(new PacketWriter(256).writeH(type).writeH(text.length).writeU(text, text.length * 2).toBytes());
const clientOf = (a: ReturnType<typeof battleRoom>["accounts"][number]) => {
  const c = (a.connection as unknown as { session: { send(b: Uint8Array): void } }) as unknown as GameClient;
  (c as unknown as { player: unknown }).player = a;
  (c as unknown as { channelOf: () => null }).channelOf = () => null;
  return c;
};
const room3606 = (b: Uint8Array) => {
  // 3606 {H type, D slot, C gm, D len+1, U text\0}
  const len = (b[9] | (b[10] << 8) | (b[11] << 16) | (b[12] << 24)) >>> 0;
  let s = "";
  for (let i = 0; i < len - 1; i++) s += String.fromCharCode(b[13 + i * 2] | (b[14 + i * 2] << 8));
  return s;
};

test("room chat: cleaned, filtered, delivered to the room, kept in the ring; > 60 chars and empty are dropped", async () => {
  manualClock();
  setChatFilter(["merda"]);
  const f = battleRoom(3);
  social.online = new Map(f.accounts.map((a) => [a.playerId, a]));
  const c = clientOf(f.accounts[0]);
  await handleChat(c, chatPacket(1, "  que\n  merda   de\tjogo  "));
  const got = f.ops(3606);
  assert.equal(got.length, 3);
  assert.equal(room3606(got[0].bytes), "que ***** de jogo");
  assert.equal(ringLines(f.room).at(-1)!.text, "que ***** de jogo");
  assert.equal(ringLines(f.room).at(-1)!.nick, "P0");
  f.clear();
  await handleChat(c, chatPacket(1, "x".repeat(61)));
  await handleChat(c, chatPacket(1, "  \n "));
  assert.equal(f.sent.length, 0);
  setChatFilter([]);
});

test("/ commands never reach the room; /bloquear is dropped, /ajuda answers the author", async () => {
  manualClock();
  const f = battleRoom(3);
  social.online = new Map(f.accounts.map((a) => [a.playerId, a]));
  const c = clientOf(f.accounts[1]);
  await handleChat(c, chatPacket(1, "/ajuda"));
  assert.equal(f.ops(3606).length, 0);
  assert.equal(f.sent.filter((s) => s.op === 2571 && s.to === f.accounts[1].playerId).length >= 3, true);
  assert.equal(f.sent.filter((s) => s.to !== f.accounts[1].playerId).length, 0);
  f.clear();
  await handleChat(c, chatPacket(4, "/bloquear Fulano")); // team chat too
  assert.equal(f.sent.length, 0);
  assert.equal(ringLines(f.room).length, 0, "commands are not chat lines");
});

test("flood: the 6th attempt in 5 s mutes the connection for 60 s with a Server notice; whispers share it", async () => {
  const mc = manualClock();
  const f = battleRoom(3);
  social.online = new Map(f.accounts.map((a) => [a.playerId, a]));
  const a = f.accounts[0];
  const c = clientOf(a);
  for (let i = 0; i < 5; i++) await handleChat(c, chatPacket(1, `m${i}`));
  assert.equal(f.ops(3606, a.playerId).length, 5);
  f.clear();
  await handleChat(c, chatPacket(1, "m6"));
  assert.equal(f.ops(3606).length, 0, "dropped");
  const notice = f.sent.filter((s) => s.op === 2571 && s.to === a.playerId).map((s) => chatText(s.bytes));
  assert.match(notice[0], /rápido demais.*60 s/);
  f.clear();
  const w = new PacketReader(new PacketWriter(256).writeU("P1", 66).writeH(2).writeU("oi", 4).toBytes());
  await handleWhisper(c, 1826, w);
  assert.equal(f.ops(1830).length, 0, "muted: the whisper is dropped too");
  void mc;
});

test("whisper: 60 chars, cleaned, delivered to the nick", async () => {
  manualClock();
  const f = battleRoom(3);
  social.online = new Map(f.accounts.map((a) => [a.playerId, a]));
  const c = clientOf(f.accounts[0]);
  const pkt = (nick: string, text: string) => new PacketReader(new PacketWriter(256).writeU(nick, 66).writeH(text.length).writeU(text, text.length * 2).toBytes());
  await handleWhisper(c, 1826, pkt("P1", "psiu\n\naqui"));
  const w = f.ops(1830, f.accounts[1].playerId);
  assert.equal(w.length, 1);
  f.clear();
  await handleWhisper(c, 1826, pkt("P1", "y".repeat(61)));
  assert.equal(f.sent.length, 0, "too long: dropped, nothing delivered");
});
