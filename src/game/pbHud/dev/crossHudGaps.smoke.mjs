#!/usr/bin/env node
// Smoke for items 1, 2, 3, 5, 6, 9 (pure layout / state; no DOM).
//   node --experimental-transform-types src/game/pbHud/dev/crossHudGaps.smoke.mjs
import assert from "node:assert/strict";
import { tabLayout, stageY0 } from "../crossScore.ts";
import { ChainBanners, KILL_MARKS, markSprite } from "../killmarks.ts";
import { charaLayout } from "../charaPanel.ts";

// 9: Y0 = 18 for stage types 4 / 13 / 45 (CHud 0x708e00), else 0
assert.deepEqual([4, 13, 45, 2, 1, 0].map(stageY0), [18, 18, 18, 0, 0, 0]);

// 6: TAB column headers, exe set (CHUD_Score 0x72ee19..0x72f2a5): ORDER, CLAN, RANK, NICK, KILL, DEATH, per team
const d = { rows: [], score: [0, 0], myTeam: 0 };
const W = 1024, H = 768, BX = (W >> 1) - 387, BR = (H >> 1) - 300; // header base = rows base (exe 0x72e831, +0x51 at 0x72ee5d)
const heads = tabLayout(d, W, H).texts.filter((t) => t.y === BR + 81);
assert.equal(heads.length, 12, "6 headers per team");
const red = heads.filter((t) => t.x < BX + 375), blue = heads.filter((t) => t.x >= BX + 375);
assert.deepEqual(red.map((t) => t.text), ["Rank", "Clã", "Nível", "Apelido", "KILL", "DEATH"]);
assert.deepEqual(blue.map((t) => t.text), ["Rank", "Clã", "Nível", "Apelido", "KILL", "DEATH"]);
assert.deepEqual(red.map((t) => [t.x - BX, t.w]), [[18, 29], [47, 28], [76, 28], [103, 165], [265, 39], [300, 55]]);
assert.deepEqual(blue.map((t) => [t.x - BX, t.w]), [[393, 29], [422, 28], [451, 28], [478, 165], [640, 39], [675, 55]]);
for (const t of heads) assert.equal(t.h, 25);
// no two headers of a team overlap as text: centred, ~6 px per glyph at Arial 10 (rects of KILL / DEATH share 7 px, the text does not)
const ext = (t) => { const c = t.x + t.w / 2, hw = (t.text.length * 6) / 2; return [c - hw, c + hw]; };
for (const row of [red, blue]) for (let i = 1; i < row.length; i++) assert.ok(ext(row[i - 1])[1] <= ext(row[i])[0], `header ${row[i].text} overlaps`);

// 1: mission banners are CChainKills cells (kill_message1, 512x102 grid cell holding the art) and go through the same queue
const ms = markSprite(KILL_MARKS.missionStart);
assert.equal(ms.sheet, 1);
const cb = new ChainBanners();
assert.ok(cb.push(ms));
const f = cb.update(0.016, W, H);
assert.equal(f.sheet, 1);
assert.deepEqual([f.cellX, f.cellY], [512, 0], "cell of MISSION START");
assert.ok(f.alpha === 255 && f.w > 512, "born at scale 2.5");

// 3: dual-wield 2nd ammo gauge (SetDualGage 0x728270): one gauge at (W-103, H-52) for a single gun; dual = right gauge
// (W-102, H-54) + left gauge (W-103, H-49), the gun that fires next is bright (dim = SetColor 0xa0 on the other)
const ammoOf = (l) => l.boxes.filter((b) => b.uv[0] === 155 || b.uv[0] === 157).map((b) => [b.x, b.y, b.w, b.dim ?? false]);
const dOf = (dual) => ({ hp: 100, maxHp: 100, armor: 0, helmet: false, grenades: null, weapon: { name: "P", slot: 1, ammo: 5, reserve: 60, melee: false, reloading: false, reloadProgress: 0, dual } });
const flags = () => ({ helmetSeen: false, throwShown: false });
const W3 = 1024, H3 = 768;
assert.deepEqual(ammoOf(charaLayout(dOf(undefined), W3, H3, flags())), [[W3 - 103, H3 - 52, 84, false], [W3 - 103, H3 - 52, 20, false]]);
assert.deepEqual(ammoOf(charaLayout(dOf({ left: false }), W3, H3, flags())),
  [[W3 - 102, H3 - 54, 84, false], [W3 - 102, H3 - 54, 20, false], [W3 - 103, H3 - 49, 84, true], [W3 - 103, H3 - 49, 20, true]]);
assert.deepEqual(ammoOf(charaLayout(dOf({ left: true }), W3, H3, flags())).map((r) => r[3]), [true, true, false, false], "left gun bright");

console.log("crossHudGaps smoke: OK");
