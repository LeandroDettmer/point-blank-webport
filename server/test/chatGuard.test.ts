// Chat hardening (chatGuard.ts): cleaning, word filter, per-connection flood with the 60 s auto-mute, the per-room ring cleared at battle end.
//   node --test test/chatGuard.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FLOOD_MUTE_MS, RING_SIZE, cleanChatText, filterChatText, floodCheck, ringClear, ringLines, ringPush, setChatFilter, tokenize,
} from "../src/game/chatGuard.ts";
import { battleEndHooks } from "../src/game/roomModel.ts";
import { battleRoom } from "./fakeRoom.ts";

test("cleanChatText: control chars, line breaks, bidi / zero-width out; spaces collapse", () => {
  assert.equal(cleanChatText("  oi\n\nmundo\t\tx  "), "oi mundo x");
  assert.equal(cleanChatText("a\u0000b\u0007c"), "a b c");
  assert.equal(cleanChatText("a\u202eb\u200bc"), "a b c");
  assert.equal(cleanChatText("<img src=x onerror=alert(1)>"), "<img src=x onerror=alert(1)>", "markup is left for the client (textContent), not mangled");
  assert.equal(cleanChatText("\n\t "), "");
});

test("word filter: whole words, case and accent blind, masked with *", () => {
  setChatFilter(["merda", "Filho da Puta", "Ação"]);
  assert.equal(filterChatText("que MERDA de jogo"), "que ***** de jogo");
  assert.equal(filterChatText("filho da puta!"), "*************!");
  assert.equal(filterChatText("acao boa"), "**** boa");
  assert.equal(filterChatText("merdas e amerdado"), "merdas e amerdado", "inside a longer word is not a match");
  assert.equal(filterChatText("tudo certo"), "tudo certo");
  setChatFilter([]);
  assert.equal(filterChatText("merda"), "merda");
});

test("flood: 5 messages in 5 s pass, the 6th mutes the connection for 60 s", () => {
  const conn = {};
  const t0 = 10_000;
  for (let i = 0; i < 5; i++) assert.equal(floodCheck(conn, t0 + i * 900).ok, true, `message ${i + 1}`);
  const r = floodCheck(conn, t0 + 4500);
  assert.deepEqual([r.ok, r.justMuted, r.notice, r.mutedFor], [false, true, true, 60]);
  const during = floodCheck(conn, t0 + 6000);
  assert.deepEqual([during.ok, during.justMuted, during.notice], [false, false, false], "notice only once per 5 s");
  assert.equal(floodCheck(conn, t0 + 9600).notice, true);
  assert.equal(floodCheck(conn, t0 + 4500 + FLOOD_MUTE_MS - 1).ok, false);
  assert.equal(floodCheck(conn, t0 + 4500 + FLOOD_MUTE_MS + 1).ok, true, "free after 60 s");
  // a normal pace never trips it
  const slow = {};
  for (let i = 0; i < 40; i++) assert.equal(floodCheck(slow, 1_000_000 + i * 1100).ok, true);
  // another connection is not affected
  assert.equal(floodCheck({}, t0 + 5000).ok, true);
});

test("ring: last 50 lines per room, memory only, cleared when the battle ends", () => {
  const f = battleRoom(2);
  for (let i = 0; i < 60; i++) ringPush(f.room, { t: i, slot: 0, nick: "P0", type: 1, text: `m${i}` });
  const all = ringLines(f.room);
  assert.equal(all.length, RING_SIZE);
  assert.equal(all[0].text, "m10");
  assert.equal(all.at(-1)!.text, "m59");
  assert.equal(ringLines(f.room, 3).map((l) => l.text).join(), "m57,m58,m59");
  const other = battleRoom(2);
  assert.equal(ringLines(other.room).length, 0, "rooms do not share a ring");
  for (const h of battleEndHooks) h(f.room);
  assert.equal(ringLines(f.room).length, 0);
  ringClear(f.room);
});

test("tokenize: quotes keep spaces, unclosed quote runs to the end", () => {
  assert.deepEqual(tokenize(`a "b c" d`).map((t) => t.value), ["a", "b c", "d"]);
  assert.deepEqual(tokenize(`"sem fim`).map((t) => t.value), ["sem fim"]);
  assert.deepEqual(tokenize("  x   y ").map((t) => t.value), ["x", "y"]);
});
