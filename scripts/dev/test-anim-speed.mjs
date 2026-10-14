#!/usr/bin/env node
// Headless locomotion-clip test (no browser):
//  1. clip timing: the Low_* clips in chars/<name>/model.glb keep the i3a durations (seconds, 30 fps keys) and the
//     stride per cycle measured from the stance foot matches CLIP_STRIDE in src/game/charAnim.ts (+-25 %);
//  2. sync: for PB speeds (pbConfig PB_CHARA) and the bots' speeds, locomotionGait() drives the legs so the stance
//     foot moves at the actor's speed (no slow-motion legs / sliding).
//
//   node scripts/dev/test-anim-speed.mjs [chars/<name>/model.glb]    # exit 0 = pass

import { tool } from './lib/tools.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { posedMesh } = await tool('export-anim.mjs');
const { readGLB } = await tool('i3r2/skin-glb.mjs');
import { CLIP_STRIDE, locomotionGait } from '../../src/game/charAnim.ts';
import { PB_CHARA } from '../../src/gameplay/pbConfig.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(HERE, '../../public/assets/chars/swat_male/model.glb');
const { J, read } = readGLB(file);
let fail = 0;
const check = (ok, msg) => { if (!ok) fail++; console.log(`${ok ? '  ok ' : '  FAIL'} ${msg}`); };

const dur = {};
console.log('1. clip duration / stride per cycle (stance-foot speed x duration)');
for (const [g, clipGait] of [['walk', 'Stand_Walk'], ['run', 'Stand_Move'], ['sit', 'Sit_Move']]) for (const d of ['Front', 'Back', 'Left', 'Right']) {
  const name = `Low_${clipGait}${d}`, a = J.animations.find((x) => x.name === name);
  if (!a) { check(false, `${name} missing`); continue; }
  let T = 0, keys = 0;
  for (const s of a.samplers) { const t = read(s.input); if (t[t.length - 1] > T) { T = t[t.length - 1]; keys = t.length; } }
  if (d === 'Front') dur[g] = T;
  const N = 160, feet = [[], []];
  for (let i = 0; i <= N; i++) { const { jointPos: j } = posedMesh(file, name, (T * i) / N); feet[0].push(j['L Foot']); feet[1].push(j['R Foot']); }
  const sp = [];
  for (const P of feet) {
    const ymin = Math.min(...P.map((p) => p[1]));
    for (let i = 0; i < N; i++) if (P[i][1] < ymin + 0.012) sp.push(Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][2] - P[i][2]) / (T / N));
  }
  sp.sort((x, y) => x - y);
  const stride = sp[sp.length >> 1] * T, want = CLIP_STRIDE[g][d];
  const fps = (keys - 1) / T;
  check(Math.abs(stride / want - 1) < 0.25 && Math.abs(fps - 30) < 1,
    `${name.padEnd(20)} dur ${T.toFixed(3)} s (${fps.toFixed(1)} fps keys) stride ${stride.toFixed(2)} m, CLIP_STRIDE ${want} -> natural ${(want / T).toFixed(2)} m/s`);
}

console.log('2. leg sync at actor speeds (foot speed = cycles/s x blended stride)');
const C = PB_CHARA;
const cases = [
  ['PB run front', C.run.front, 0, false], ['PB run side (strafe)', 0, C.run.side, false], ['PB run back', -C.run.back, 0, false],
  ['PB Shift-walk front', C.walk.front, 0, false], ['bot patrol (bots.ts 4.2)', 4.2, 0, false],
  ['bot combat strafe (bots.ts 2.6)', 0, 2.6, false], ['bot crouch (MovementConfig 1.4)', 0, 1.4, true], ['PB crouch front ~50 %', 3.25, 0, true],
];
for (const [label, vf, vr, crouch] of cases) {
  const speed = Math.hypot(vf, vr), g = locomotionGait(vf, vr, crouch, dur);
  const blend = (k) => Object.entries(g.weights).reduce((a, [d, w]) => a + w * CLIP_STRIDE[k][d], 0);
  const stride = crouch ? blend('sit') : blend('walk') * (1 - g.runB) + blend('run') * g.runB;
  const foot = g.cyclesPerSec * stride;
  const nat = crouch ? 1 / dur.sit : (1 - g.runB) / dur.walk + g.runB / dur.run;
  const clamped = g.cyclesPerSec >= nat * 2.5 - 1e-6;
  // old charAnim: ref speed lerp(2.6, 4.5) / 1.4 crouch, rate clamp 0.5..1.6
  const oldRunB = crouch ? 1 : Math.min(1, Math.max(0, (speed - 2.6) / 1.9));
  const oldRef = crouch ? 1.4 : 2.6 + 1.9 * oldRunB, oldRate = Math.min(1.6, Math.max(0.5, speed / oldRef));
  const oldCyc = oldRate / (crouch ? dur.sit : dur.walk + (dur.run - dur.walk) * oldRunB);
  const oldFoot = oldCyc * (crouch ? blend('sit') : blend('walk') * (1 - oldRunB) + blend('run') * oldRunB);
  check(clamped ? foot < speed : Math.abs(foot / speed - 1) < 0.02,
    `${label.padEnd(32)} ${speed.toFixed(2)} m/s: runB ${g.runB.toFixed(2)} ${g.cyclesPerSec.toFixed(2)} cyc/s -> feet ${foot.toFixed(2)} m/s` +
    `${clamped ? ' (cadence capped at 2.5x, feet slide)' : ''} | old: feet ${oldFoot.toFixed(2)} m/s (${Math.round((oldFoot / speed) * 100)} %)`);
}
process.exit(fail ? 1 : 0);
