#!/usr/bin/env node
// Rule smoke test for src/game/pbHud/revengePanel.ts (no DOM): CHud::RecordRevenge 0x747270 (kills +1 / deaths on -1, the
// record of the foe), the 4 s panel timer of CHud::Update / 0x747ae0 (active only while shown), and the layout of
// 0x73a319 / 0x73a460 (bar at cx-192, H-255, texts at H-245 / H-225; red foe on the left, blue me on the right; the larger count yellow).
//   node --experimental-transform-types src/game/pbHud/dev/revengePanel.smoke.mjs
import assert from "node:assert/strict";
import { RevengeBook, REVENGE_SHOW_S, revengeLayout } from "../revengePanel.ts";

const foe = { id: "7", name: "Foe" };
const book = new RevengeBook();

// nothing recorded: no panel
assert.equal(book.visible, false);
assert.equal(book.current, null);

// I kill the foe (+1), then the foe kills me (-1), then I kill again
book.record(foe, "Me", 1);
assert.equal(book.visible, false, "a kill only counts: the panel is for the victim (exe 0x74757f)");
assert.deepEqual({ kills: book.current.kills, deaths: book.current.deaths }, { kills: 1, deaths: 0 });
book.record(foe, "Me", -1);
book.record(foe, "Me", 1);
assert.deepEqual({ kills: book.current.kills, deaths: book.current.deaths, foe: book.current.foe, me: book.current.me }, { kills: 2, deaths: 1, foe: "Foe", me: "Me" });

// the timer restarts with each record and the panel goes off at REVENGE_SHOW_S
book.tick(REVENGE_SHOW_S - 0.5);
assert.equal(book.visible, true, "still up before 4 s");
book.record(foe, "Me", -1);
book.tick(REVENGE_SHOW_S - 0.5);
assert.equal(book.visible, true, "a new record restarts the timer");
book.tick(0.5);
assert.equal(book.visible, false, "off at 4 s");
assert.equal(book.current.deaths, 2, "the record stays for the next event");
book.tick(10);
assert.equal(book.visible, false, "tick does nothing while off");

// second foe: the panel shows the latest record, each foe keeps its own counts
const other = { id: "9", name: "Other" };
book.record(other, "Me", 1);
assert.equal(book.current.foe, "Other");
assert.deepEqual({ kills: book.current.kills, deaths: book.current.deaths }, { kills: 1, deaths: 0 });

// layout (W 1024, H 768): cx = 512
const L = revengeLayout({ foe: "Foe", me: "Me", kills: 3, deaths: 1 }, 1024, 768);
assert.deepEqual(L.boxes, [{ x: 320, y: 513, w: 383, h: 84, tex: "Hud2.png", uv: [324, 409, 707, 493] }]);
const [fn, mn, fd, mk] = L.texts;
assert.deepEqual([fn.text, fn.x, fn.y, fn.w, fn.h, fn.color], ["Foe", 327, 523, 169, 16, [252, 88, 88]]);
assert.deepEqual([mn.text, mn.x, mn.color], ["Me", 522, [67, 182, 243]]);
assert.deepEqual([fd.text, fd.x, fd.y, fd.color], ["1", 327, 543, [255, 255, 255]]);
assert.deepEqual([mk.text, mk.x, mk.color], ["3", 522, [255, 200, 100]], "the larger count yellow");
const tie = revengeLayout({ foe: "a", me: "b", kills: 2, deaths: 2 }, 1024, 768).texts;
assert.deepEqual([tie[2].color, tie[3].color], [[255, 255, 255], [255, 255, 255]], "equal: both white");
const lead = revengeLayout({ foe: "a", me: "b", kills: 0, deaths: 2 }, 1024, 768).texts;
assert.deepEqual([lead[2].color, lead[3].color], [[255, 200, 100], [255, 255, 255]], "foe ahead: foe yellow");

book.clear();
assert.equal(book.current, null);
console.log("revengePanel smoke ok");
