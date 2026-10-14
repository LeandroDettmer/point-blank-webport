#!/usr/bin/env node
// Rule smoke test for src/game/pbHud/killmarks.ts (no DOM): CChainKills::Kill 0x7baab0's banner pick + the server's kill flags
//. One banner per kill; Double/Triple/Chain Killer count the kills of the life (2nd /
// 3rd / 4th and later), no time window; Chain Headshot / Chain Slugger are the 2nd kill of the same kind in a row; Chain
// Stopper = the victim had more than 3 kills; Piercing Shot / Mass Kill = several victims of one shot; and the star cell.
//   node --experimental-transform-types src/game/pbHud/dev/killmarks.smoke.mjs
import assert from "node:assert/strict";
import { initStreak, onDeath, onKill, starVariant, KILL_MARKS, KM, markSprite, ChainBanners, CHAIN_BANNER, ShotKills } from "../killmarks.ts";

const ev = (extra = {}) => ({ headshot: false, melee: false, multi: false, mass: false, victimStreak: 0, isRevenge: false, ...extra });
const kill = (s, extra) => onKill(s, ev(extra));
const id = (r) => r.marks.map((m) => m.id).join(",");

// kills of the life: 1st plain, 2nd Double, 3rd Triple, 4th and later Chain Killer (no time window)
let s = initStreak();
assert.equal(id(kill(s)), "kill");
assert.equal(id(kill(s)), "doubleKill");
assert.equal(id(kill(s)), "tripleKill");
assert.equal(id(kill(s)), "chainKiller");
assert.equal(id(kill(s)), "chainKiller", "5th stays Chain Killer");
onDeath(s);
assert.equal(s.kills, 0, "death starts a new life");
assert.equal(id(kill(s)), "kill", "first kill of the new life");

// headshots: 1st Headshot, 2nd in a row Chain Headshot; a plain kill in between breaks the run
s = initStreak();
assert.equal(id(kill(s, { headshot: true })), "headshot");
assert.equal(id(kill(s, { headshot: true })), "chainHeadshot");
assert.equal(id(kill(s, { headshot: true })), "chainHeadshot");
kill(s);
assert.equal(id(kill(s, { headshot: true })), "headshot", "run broken by a plain kill");
// a descriptor beats the life tier: a headshot on the 4th kill is HEAD SHOT, not Chain Killer
s = initStreak();
for (let i = 0; i < 3; i++) kill(s);
assert.equal(id(kill(s, { headshot: true })), "headshot", "flags come before the kills-this-life tier");

// melee: the 2nd knife kill in a row is Chain Slugger; the 1st has no descriptor (life tier / plain kill)
s = initStreak();
assert.equal(id(kill(s, { melee: true })), "kill");
assert.equal(id(kill(s, { melee: true })), "chainSlugger");
kill(s, { headshot: true });
assert.equal(id(kill(s, { melee: true })), "chainKiller", "a headshot between broke the knife run: no Chain Slugger, the 4th kill of the life is Chain Killer");

// several victims: Piercing Shot, or Mass Kill for a blast / shotgun; it does not touch the headshot/knife runs
s = initStreak();
kill(s, { headshot: true });
assert.equal(id(kill(s, { multi: true })), "piercing");
assert.equal(id(kill(s, { multi: true, mass: true })), "massKill");
assert.equal(id(kill(s, { headshot: true })), "chainHeadshot", "the multi-victim kills did not break the headshot run");

// one grenade kills two (ShotKills: the original sends both in ONE death packet, KillsCount 2, death type BOOM -> MassKill;
// CChainKills::Kill 0x7b05c0 runs once for the packet). Here the 2nd kill of the same blast id is the multi one (hud.ts lets
// its banner replace the 1st), with boom -> Mass Kill + MV_Ann_MassKill
{
  const sk = new ShotKills();
  sk.hit("A", 7, true);
  sk.hit("A", 7, true); // head line + IK line of the same blast
  sk.hit("B", 7, true);
  const a = sk.kill("A"), b = sk.kill("B");
  assert.deepEqual(a, { multi: false, boom: true }, "1st victim of the blast");
  assert.deepEqual(b, { multi: true, boom: true }, "2nd victim of the same blast = multi");
  const st = initStreak();
  kill(st, { multi: a.multi, mass: a.boom });
  const r = kill(st, { multi: b.multi, mass: b.boom });
  assert.equal(id(r), "massKill", "2 victims of one grenade: MASS KILL (ranks above Double Kill)");
  assert.equal(r.marks[0].sound, "massKill");
  assert.ok(r.flags & KM.MassKill);
  // one bullet through two: Piercing Shot; two separate grenades: no multi (Double Kill by the life tier)
  sk.hit("C", 8); sk.hit("D", 8);
  sk.kill("C");
  assert.deepEqual(sk.kill("D"), { multi: true, boom: false });
  sk.hit("E", 9, true); sk.hit("F", 10, true);
  assert.equal(sk.kill("E").multi || sk.kill("F").multi, false, "different blasts are not one packet");
  // a knife hit (no id) drops the old blast: the later kill is a single one
  sk.hit("G", 11, true); sk.hit("H", 11, true); sk.kill("G"); sk.hit("H", undefined);
  assert.equal(sk.kill("H").multi, false);
  // the killer's own frag is not counted (RoomDeath: KillsCount - suicide): the thrower is never passed to kill()
}

// Chain Stopper: the victim had > 3 kills
s = initStreak();
assert.equal(id(kill(s, { victimStreak: 3 })), "kill");
assert.equal(id(kill(s, { victimStreak: 4 })), "chainStopper");
assert.ok(kill(initStreak(), { victimStreak: 9 }).flags & KM.ChainStopper);

// revenge only replaces the plain kill
s = initStreak();
assert.equal(id(kill(s, { isRevenge: true })), "revenge");
assert.equal(id(kill(s, { isRevenge: true })), "doubleKill");

// star cells: 0 plain, 1 headshot (hollow), knife 3 (plain) / 2 (hollow), +4 gold for Chain Stopper
assert.equal(starVariant(0), 0);
assert.equal(starVariant(KM.Headshot), 1);
assert.equal(starVariant(KM.ChainHeadshot), 1);
assert.equal(starVariant(KM.ChainSlugger), 3);
assert.equal(starVariant(0, true), 3);
assert.equal(starVariant(KM.Headshot, true), 2);
assert.equal(starVariant(KM.ChainStopper), 4);
assert.equal(starVariant(KM.Headshot | KM.ChainStopper), 5);
assert.equal(starVariant(KM.ChainSlugger | KM.ChainStopper), 7);
s = initStreak();
assert.equal(kill(s, { headshot: true, victimStreak: 5 }).star, 5);

// every banner mark carries its real kill_message.i3i cell inside the 1024x1024 sheet
for (const k of ["headshot", "piercing", "doubleKill", "tripleKill", "massKill", "chainKiller", "chainStopper", "chainHeadshot", "chainSlugger", "helmetProtection"]) {
  const sp = KILL_MARKS[k].sprite;
  assert.ok(sp && sp.x >= 0 && sp.y >= 0 && sp.x + sp.w <= 1024 && sp.y + sp.h <= 1024, `${k} has a sprite cell inside the sheet`);
}
for (let i = 0; i < 40; i++) assert.equal(kill(s, { headshot: i % 2 === 0, multi: i % 7 === 0 }).marks.length, 1, "never more than one mark");

// banner art: Cross = same cell on kill_message.png; mission banners (kill_message1, identical in Cross) keep sheet 1
assert.equal(markSprite(KILL_MARKS.headshot).sheet, "cross");
assert.equal(markSprite(KILL_MARKS.headshot).y, KILL_MARKS.headshot.sprite.y);
assert.equal(markSprite(KILL_MARKS.missionStart).sheet, 1);
assert.equal(markSprite(KILL_MARKS.kill), undefined, "plain kill: voice only");
// mission banner cell = the 512 x 102 grid cell holding its art (CChainKills uv col*512, row*102; 0x7b17b1)
const cellOf = (s) => ({ cx: Math.floor((s.x + s.w / 2) / 512) * 512, cy: Math.floor((s.y + s.h / 2) / 102) * 102 });
assert.deepEqual([cellOf(KILL_MARKS.missionStart.sprite).cx, cellOf(KILL_MARKS.missionStart.sprite).cy], [512, 0]);
assert.deepEqual([cellOf(KILL_MARKS.missionSuccess.sprite).cx, cellOf(KILL_MARKS.missionSuccess.sprite).cy], [0, 102]);
assert.deepEqual([cellOf(KILL_MARKS.gameOver.sprite).cx, cellOf(KILL_MARKS.gameOver.sprite).cy], [512, 102]);

// CChainKills banner (0x7b1280 / 0x7b1bc0): whole 512x102 cell, born at scale 2.5, 25/s down to 1, holds 1 s, fades 255 in 1/3 s
const dt = 1 / 60, W = 1024, H = 768;
const cb = new ChainBanners();
assert.equal(cb.update(dt, W, H), null);
cb.push(markSprite(KILL_MARKS.tripleKill));
let f = cb.update(dt, W, H);
assert.deepEqual([f.cellX, f.cellY, f.w, f.h, f.alpha, f.sheet], [0, 204, 512 * 2.5, 102 * 2.5, 255, "cross"], "triple kill = cell (0, 2), scale 2.5");
assert.equal(f.x + f.w / 2, W / 2 - 245 + 256, "scaled around the cell centre");
for (let i = 0; i < 10; i++) f = cb.update(dt, W, H);
assert.deepEqual([f.x, f.y, f.w, f.h], [W / 2 - 245, H / 2 - 256, 512, 102], "settled at scale 1 at (W/2 - 245, H/2 - 256)");
let t = 11 * dt;
while (t < 0.99) { f = cb.update(dt, W, H); t += dt; }
assert.equal(f.alpha, 255, "full alpha for the 1 s hold");
let frames = 0;
while ((f = cb.update(dt, W, H))) frames++;
assert.ok(frames >= 20 && frames <= 23, `fade ~1/3 s (${frames} frames)`);
// queue: a 2nd banner waits for the 1st one's 1 s, then replaces it at once; at most 5 wait
cb.push(markSprite(KILL_MARKS.doubleKill));
cb.update(dt, W, H);
cb.push(markSprite(KILL_MARKS.chainKiller));
for (t = dt; t < 0.98; t += dt) assert.equal(cb.update(dt, W, H).cellY, 102, "double kill holds");
for (let i = 0; i < 3; i++) f = cb.update(dt, W, H);
assert.deepEqual([f.cellY, f.alpha], [0, 255], "chain killer replaced it after 1 s");
const q = new ChainBanners();
for (let i = 0; i < CHAIN_BANNER.maxQueued; i++) assert.ok(q.push(KILL_MARKS.headshot.sprite));
assert.equal(q.push(KILL_MARKS.headshot.sprite), false, "6th waiting banner refused");

console.log("killmarks smoke: OK");
