#!/usr/bin/env node
// Smoke test for src/game/pbHud/killStars.ts (CChainKills star animation, constants from PointBlank.exe 2017 0x7bc940).
//   node --experimental-transform-types src/game/pbHud/dev/killStars.smoke.mjs
import assert from "node:assert/strict";
import { KillStars, starCell, MAX_STARS } from "../killStars.ts";

const W = 1024, H = 768, DT = 1 / 60;
const run = (k, sec) => { let f; for (let t = 0; t < sec; t += DT) f = k.update(DT, W, H); return f; };

// cells of Hud.i3i: silver row y 337, gold row y 393, 52 x 56
assert.deepEqual(starCell(0), { x: 199, y: 337, w: 52, h: 56 });
assert.deepEqual(starCell(3), { x: 355, y: 337, w: 52, h: 56 });
assert.deepEqual(starCell(4), { x: 199, y: 393, w: 52, h: 56 });

// birth: huge, transparent, at the top-left corner (W/2 - 26, H/2 - 140), no crest yet
let k = new KillStars();
k.add(1);
let f = k.update(DT, W, H);
assert.equal(f.stars.length, 1);
assert.equal(f.stars[0].x, 512 - 26);
assert.equal(f.stars[0].y, 384 - 140);
assert.ok(f.stars[0].w > 400 && f.stars[0].alpha < 20, "starts big and faint");
assert.equal(f.crest, null, "the crest waits for alpha > 80");

// the crest shows around 0.16 s, the star is stamped at 52 x 56 / alpha 200 at 0.4 s
f = run(k, 0.25);
assert.ok(f.crest && f.crest.alpha > 0, "crest visible at 0.25 s");
assert.ok(f.stars[0].w < 60 && f.stars[0].alpha > 80, "star almost stamped at 0.25 s");
f = run(k, 0.25);
assert.ok(f.stars[0].alpha <= 200 || f.stars[0].y > 384 - 140, "star left the stamp state by 0.5 s");

// resting star: right-aligned at x = W - 183 - 52, y = H - 65, 52 x 56, alpha 255, crest gone
f = run(k, 1.0);
assert.equal(f.crest, null, "crest is gone");
assert.deepEqual([f.stars[0].x, f.stars[0].y, f.stars[0].w, f.stars[0].h, f.stars[0].alpha], [W - 235, H - 65, 52, 56, 255]);
assert.equal(f.stars[0].kind, 1);

// 3 stars: slots W - 183 - 52 * 3 + 52 * i
k.add(0); k.add(4);
f = run(k, 1.5);
assert.deepEqual(f.stars.map((s) => s.x), [W - 183 - 156, W - 183 - 104, W - 183 - 52]);
assert.deepEqual(f.stars.map((s) => s.kind), [1, 0, 4]);

// number next to the star when the event had several victims
k.reset();
k.add(0, 1); k.bumpLast();
f = run(k, 2);
assert.equal(f.stars[0].count, 2, "2 victims -> the number 2");

// at most 9 stars; the 10th drops the oldest and starts its own animation
k.reset();
for (let i = 0; i < 12; i++) { k.add(i & 7); run(k, 2); }
f = run(k, 1);
assert.equal(f.stars.length, MAX_STARS);
assert.deepEqual(f.stars.map((s) => s.kind), [3, 4, 5, 6, 7, 0, 1, 2, 3].map((v, i) => (3 + i) & 7), "the newest 9 of the ring");
assert.equal(f.stars[8].x, W - 183 - 52);

// reset (own death / round start) empties everything
k.reset();
assert.equal(k.update(DT, W, H).stars.length, 0);

// 16:9 design (dw 1365 x 768): positions follow the real width
k = new KillStars();
k.add(0);
for (let t = 0; t < 2; t += DT) f = k.update(DT, 1365, 768);
assert.equal(f.stars[0].x, 1365 - 235);

console.log("killStars smoke: OK");
