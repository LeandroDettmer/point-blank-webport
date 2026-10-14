// Battle chat model (game/battleChatModel.ts): line colours, markup, "/" commands, 5 s aging of the closed box (exe 2017).
// node --experimental-transform-types src/game/dev/battleChat.smoke.node.ts
import assert from "node:assert/strict";
import { ChatClient, type ChatLine } from "../../net/chatClient.ts";
import { PacketReader, PacketWriter } from "../../net/packet.ts";
import {
  AGE_S, ChatAging, IDLE_LINES, TAB_MODES, backAt, chatLayout, comboNext, maxBack, NICK_COLORS, formatLine, parseChatCommand, parseMarkup, tabX,
  thumbTop,
} from "../battleChatModel.ts";

const L = (o: Partial<ChatLine>): ChatLine => ({ kind: "all", nick: "Ana", gm: false, color: 0, text: "oi", time: 0, ...o });

// lines: "[nick] text", nick colour from the 11-entry table, text by channel
assert.equal(NICK_COLORS.length, 11);
let s = formatLine(L({ color: 3 }));
assert.deepEqual(s.map((x) => x.text), ["[Ana] ", "oi"]);
assert.equal(s[0].color, "rgb(255,211,3)");
assert.equal(s[1].color, "rgb(255,255,255)");
s = formatLine(L({ kind: "team" }));
assert.deepEqual(s.map((x) => x.color), ["rgb(98,180,253)", "rgb(98,180,253)"]);
s = formatLine(L({ gm: true }), { gm: "GM" });
assert.equal(s[0].text, "[GM Ana] ");
assert.equal(s[0].color, "rgb(247,200,60)");
s = formatLine(L({ kind: "whisper" }));
assert.deepEqual(s, [{ text: "[Ana] oi", color: "rgb(237,86,250)" }]);
s = formatLine(L({ kind: "whisper", to: "Bia" }));
assert.equal(s[0].text, "[To:Bia] oi");
// server line keeps its markup
s = formatLine(L({ kind: "system", nick: "", text: "{col:255,120,0,255}ola{/col} fim" }));
assert.deepEqual(s, [{ text: "ola", color: "rgb(255,120,0)" }, { text: " fim", color: null }]);
assert.deepEqual(parseMarkup("a{col: 98, 180, 253, 255}b{/col}c").map((x) => x.text), ["a", "b", "c"]);
// text is never markup of HTML
assert.equal(formatLine(L({ text: "<b>x</b>" }))[1].text, "<b>x</b>");

// commands (STR_TBL_CHAT_HOTKEY_*)
assert.deepEqual(parseChatCommand("/w Bia oi tudo bem"), { kind: "whisper", nick: "Bia", text: "oi tudo bem" });
assert.deepEqual(parseChatCommand("/PM \"Bia Lu\" oi"), { kind: "whisper", nick: "Bia Lu", text: "oi" });
assert.deepEqual(parseChatCommand("/r ok"), { kind: "reply", text: "ok" });
assert.deepEqual(parseChatCommand("/resp ok"), { kind: "reply", text: "ok" });
assert.deepEqual(parseChatCommand("/T avançar"), { kind: "team", text: "avançar" });
assert.deepEqual(parseChatCommand("/c"), { kind: "clear" });
assert.deepEqual(parseChatCommand("/apagar"), { kind: "clear" });
assert.deepEqual(parseChatCommand("/ajuda"), { kind: "help" });
assert.equal(parseChatCommand("/bloquear x"), null);
assert.equal(parseChatCommand("oi"), null);

// aging: 8 lines at most, one drops every 5 s (no fade), timer restarts
const a = new ChatAging();
for (let i = 0; i < 10; i++) a.push();
assert.equal(a.count, 10);
assert.equal(a.shown(), IDLE_LINES);
a.tick(AGE_S - 0.1);
assert.equal(a.count, 10);
a.tick(0.2);
assert.equal(a.count, 9);
a.tick(AGE_S - 0.5);
assert.equal(a.count, 9);
a.tick(1);
assert.equal(a.count, 8);
for (let i = 0; i < 20; i++) a.tick(AGE_S + 0.01);
assert.equal(a.count, 0);
a.tick(100);
assert.equal(a.count, 0, "no line: the timer does not run");
for (let i = 0; i < 150; i++) a.push();
assert.equal(a.count, 100, "history ring of 100");
// layout (Cross exe 0x8c26e0): window at x 11, y 768 - 195 (design px, scale H/768), 403 x 157; footer = input bar at y 135..157
for (const [W, H] of [[1280, 720], [1920, 1080], [1366, 768]]) {
  const l = chatLayout(W, H), s = H / 768;
  assert.equal(l.scale, s);
  assert.equal(l.x, 11 * s);
  assert.equal(l.y, 573 * s);
  const bottom = l.y + 157 * l.scale;
  assert.equal(H - bottom, 38 * s, `window bottom ${38}px above the screen edge at ${W}x${H}`);
}
// channel tabs (exe 0x8c3d6d..0x8c3e15 hit-test, 0x8c7f60 SetChannel): Todos / Time / Clã / PM at 42 px pitch from x 1
assert.deepEqual(TAB_MODES, ["all", "team", "clan", "whisper"]);
assert.deepEqual([0, 1, 2, 3].map(tabX), [1, 43, 85, 127]);
// combo click: all -> team -> clan -> all
assert.equal(comboNext("all"), "team");
assert.equal(comboNext("team"), "clan");
assert.equal(comboNext("clan"), "all");
assert.equal(comboNext("whisper"), "all");
// clan lines: clan green text, the nick in its nick colour (not team blue)
s = formatLine(L({ kind: "clan", color: 3 }));
assert.deepEqual(s.map((x) => x.color), ["rgb(255,211,3)", "rgb(80,255,60)"]);
// history scroll (exe 0x8c2970): top page = lines - 8 back; thumb 21..112 (track 91), newest page at the bottom
assert.equal(maxBack(108), 100);
assert.equal(maxBack(3), 0);
assert.equal(thumbTop(0, 100), 112);
assert.equal(thumbTop(100, 100), 21);
assert.equal(thumbTop(5, 0), 112, "no history: thumb at the bottom, no division by zero");
assert.equal(backAt(112, 100), 0);
assert.equal(backAt(21, 100), 100);
assert.equal(backAt(66.5, 100), 50);
assert.equal(backAt(500, 100), 0, "dragged past the track: clamped");
assert.equal(backAt(-40, 100), 100);
// clan send (854: H 5, H len, U text) and receive (855: C len, U nick, C gm, C colour, C len, U text) through the chat client
{
  const sent: { op: number; bytes: Uint8Array }[] = [];
  let feed: ((op: number, r: PacketReader) => void) | null = null;
  const conn = {
    on(fn: (op: number, r: PacketReader) => void) { feed = fn; return () => {}; },
    send(op: number, body: PacketWriter | Uint8Array) { sent.push({ op, bytes: body instanceof PacketWriter ? body.toBytes() : body }); },
  };
  const c = new ChatClient();
  c.attach(conn as never);
  assert.equal(c.sendClan("oi clã"), true);
  const r = new PacketReader(sent[0].bytes);
  assert.equal(sent[0].op, 854);
  assert.equal(r.readH(), 5);
  assert.equal(r.readU(r.readH() * 2), "oi clã");
  assert.equal(c.sendClan("   "), false, "empty clan line is not sent");
  feed!(855, new PacketReader(new PacketWriter(64).writeC(4).writeU("Ana", 8).writeC(0).writeC(3).writeC(3).writeU("oi", 6).toBytes()));
  const got = c.history().at(-1)!;
  assert.deepEqual([got.kind, got.nick, got.gm, got.color, got.text], ["clan", "Ana", false, 3, "oi"]);
}
console.log("battleChat smoke ok");
