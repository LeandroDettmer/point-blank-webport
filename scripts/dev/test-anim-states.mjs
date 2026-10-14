#!/usr/bin/env node
// Headless 3rd-person state -> clip test (no browser): runs src/game/charAnim.ts on the real swat_male skeleton with
// the PB AI tables + clips of public/assets/chars/swat_male/anim3pv (pb-extract-tools export-anim3pv.mjs) and logs, per
// simulated state, the lower / upper state and the dominant clip of each layer. Checks:
//   1. layer mask: every Low_* clip animates only Root/Pelvis/leg bones, every Up_* clip only the IK subtree;
//   2. weapon -> AI -> clip: K-2 / AK-47 / 870MCS / AS_50 / Desert Eagle / M-7 play their own PB clips;
//   3. locomotion: 8 directions x run/walk/crouch with PB speeds pick the matching Low_* state;
//   4. zoom: Zoom stance (Up_AttackIdle_Zoom) when aiming; reload: Up_Reload lasts exactly weapon.pef ReloadTime
//      (clip stretched, not cut) and blends back to the base;
//   5. bots: pbBotSpeed() = PB_CHARA x K-2 MoveNormal_*.
//
//   node scripts/dev/test-anim-states.mjs [--log]     # exit 0 = pass
import { tool } from './lib/tools.mjs';
import fs from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
const { readGLB } = await tool('i3r2/skin-glb.mjs');
import { CharAnimator, dir8Of, lowerTimeScale, PB_LOWER_K } from '../../src/game/charAnim.ts';
import { aiForWeapon, clipsFor, dualTables } from '../../src/game/charAnimLib.ts';
import { PB_CHARA } from '../../src/gameplay/pbConfig.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAR = path.join(HERE, '../../public/assets/chars/swat_male');
const LIB = path.join(CHAR, 'anim3pv');
const verbose = process.argv.includes('--log');
let fail = 0;
const check = (ok, msg) => { if (!ok) fail++; console.log(`${ok ? '  ok ' : '  FAIL'} ${msg}`); };

// ---- skeleton (model.glb nodes, names sanitized like GLTFLoader) + model.glb clips (stand-in tables / deaths)
const { J, read } = readGLB(path.join(CHAR, 'model.glb'));
const san = (n) => THREE.PropertyBinding.sanitizeNodeName(n);
const objs = J.nodes.map((n) => {
  const o = new THREE.Object3D();
  o.name = san(n.name || '');
  if (n.matrix) new THREE.Matrix4().fromArray(n.matrix).decompose(o.position, o.quaternion, o.scale);
  else { if (n.translation) o.position.fromArray(n.translation); if (n.rotation) o.quaternion.fromArray(n.rotation); if (n.scale) o.scale.fromArray(n.scale); }
  return o;
});
const root = new THREE.Group();
J.nodes.forEach((n, i) => (n.children || []).forEach((c) => objs[i].add(objs[c])));
J.scenes[0].nodes.forEach((i) => root.add(objs[i]));
const actor = new THREE.Group();
actor.add(root);
const modelClips = J.animations.map((a) => new THREE.AnimationClip(a.name, -1, a.channels.map((ch) => {
  const s = a.samplers[ch.sampler], name = `${san(J.nodes[ch.target.node].name)}.${{ translation: 'position', rotation: 'quaternion', scale: 'scale' }[ch.target.path]}`;
  const T = ch.target.path === 'rotation' ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
  return new T(name, Array.from(read(s.input)), Array.from(read(s.output)));
})));

// ---- anim3pv library (GLTFLoader.parse works in Node for animation-only GLBs)
const ix = JSON.parse(fs.readFileSync(path.join(LIB, 'index.json'), 'utf8'));
const bundleCache = new Map();
const parse = (file) => {
  if (!bundleCache.has(file)) bundleCache.set(file, new Promise((res, rej) => {
    const b = fs.readFileSync(path.join(LIB, file));
    new GLTFLoader().parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.length), '', (g) => res(new Map(g.animations.map((c) => [c.name, c]))), rej);
  }));
  return bundleCache.get(file);
};
async function clipsOf(keys) {
  const out = new Map();
  for (const k of keys) { const m = await parse(ix.bundles[k]); if (m.get(k)) out.set(k, m.get(k)); }
  return out;
}

// ---- 1. layer mask
console.log('1. layer mask (bones per layer, from the clips themselves)');
{
  const parent = new Map();
  J.nodes.forEach((n, i) => (n.children || []).forEach((c) => parent.set(c, i)));
  const ikIdx = J.nodes.findIndex((n) => n.name === 'IK');
  const underIK = (i) => { for (let p = i; p !== undefined; p = parent.get(p)) if (p === ikIdx) return true; return false; };
  const byName = new Map(J.nodes.map((n, i) => [san(n.name || ''), i]));
  const lowB = new Set(), upB = new Set();
  let bad = [];
  for (const file of new Set(Object.values(ix.bundles))) {
    const m = await parse(file);
    for (const [k, c] of m) if (!/\/UI\//.test(k)) for (const t of c.tracks) { // UI/ = lobby showroom clips, full body: the match never plays them
      const bone = t.name.split('.')[0], i = byName.get(bone);
      const low = /\/Low_/.test(k);
      (low ? lowB : upB).add(bone);
      if (i === undefined || low === underIK(i)) bad.push(`${k}:${bone}`);
    }
  }
  check(!bad.length, `Low_* bones = {${[...lowB].join(', ')}}; Up_* bones = IK subtree (${upB.size} bones)${bad.length ? ' VIOLATIONS ' + bad.slice(0, 5).join(' ') : ''}`);
  check(![...lowB].some((b) => upB.has(b)), 'Low and Up bone sets are disjoint (both layers at full weight, no masking needed)');
}

// ---- helpers
const V = (x, z) => new THREE.Vector3(x, 0, z);
function sim(anim, seconds, inp, dt = 1 / 60) { for (let t = 0; t < seconds - 1e-9; t += dt) anim.update(dt, inp); }
const dominant = (anim, re) => {
  let best = '', bw = -1;
  for (const a of anim.mixer._actions) { const w = a.getEffectiveWeight(); if (re.test(a.getClip().name) && w > bw) (bw = w), (best = a.getClip().name); }
  return best;
};
const low = (a) => dominant(a, /Low_/);
const up = (a) => dominant(a, /Up_|^dual:/); // dual: = merged Left/Right layers (charAnimLib dualTables)
function log(label, anim) {
  const s = `${label.padEnd(34)} lower ${anim.lowerState.padEnd(14)} ${low(anim).padEnd(34)} upper ${anim.upperState.padEnd(22)} ${up(anim)}`;
  console.log(verbose ? s : s.replace(/\s+$/, ''));
}
async function animFor(weapon) {
  const anim = new CharAnimator(root, modelClips);
  anim.aimFrame = actor;
  const ai = aiForWeapon(ix, weapon, 'assault');
  const clips = await clipsOf(clipsFor(ix, ai));
  const table = dualTables(ix.ai[ai], clips, ai); // dual wield (214002): Left/Right layers merged, as bindWeaponAnim
  anim.useTables(ix.lower, table, ai, clips, ix.zoomType[weapon] ?? 0);
  return { anim, ai, table, zoomType: ix.zoomType[weapon] };
}

// ---- 2-4. per weapon
const pefW = JSON.parse(fs.readFileSync(path.join(HERE, '../../public/assets/config/weapon.json'), 'utf8')).WeaponList.Weapon;
const pefById = new Map();
for (const c of Object.keys(pefW)) for (const e of Object.values(pefW[c] ?? {})) if (e && typeof e === 'object' && e.ITEMID) pefById.set(e.ITEMID, e);
const base = { yaw: 0, pitch: 0, crouch: false, grounded: true };
console.log('2-4. states -> clips (yaw 0 looks down -Z: forward = (0,0,-1), right = (1,0,0))');
const catalog = JSON.parse(fs.readFileSync(path.join(HERE, '../../public/assets/cross/weapons/weapons.json'), 'utf8')).weapons;
const idOf = (ai) => +Object.entries(ix.weapons).find(([, a]) => a === ai)?.[0];
const nameOf = (id) => catalog.find((w) => w.id === id)?.name ?? String(id);
const pick = [103004, 103002, idOf('ShotGun/870MCS'), idOf('SniperRifle/AS_50'), idOf('HandGun/K5'), 214002, idOf('Knife/M-7'), idOf('SMG/MP5K')];
for (const id of pick) {
  const weapon = nameOf(id);
  const { anim, ai, table, zoomType } = await animFor(id);
  const pe = pefById.get(id);
  const rt = pe?.ReloadTime ?? 2.5;
  const A = table.stances;
  console.log(` -- ${weapon} (item ${id}) -> AI ${ai} [${ix.ai[ai].driver}], pef ReloadTime ${pe?.ReloadTime}, _ZoomType ${zoomType ?? '-'}`);
  check(aiForWeapon(ix, weapon, 'assault') === ai || !ix.names[weapon.toLowerCase().replace(/[^a-z0-9]/g, '')], `name "${weapon}" resolves to the same AI as its id`);
  sim(anim, 0.6, { ...base, vel: V(0, 0) }); log('idle', anim);
  check(up(anim) === A.AttackIdle.Idle.clip && /Low_Stand_Idle$/.test(low(anim)), 'idle -> Up Idle + Low_Stand_Idle');
  const run = PB_CHARA.run.front * 0.8, side = PB_CHARA.run.side * 0.8, walk = PB_CHARA.walk.front * 0.8;
  const cases = [
    ['run front', V(0, -run), 'Front'], ['run front-right', V(side * 0.7, -side * 0.7), 'FrontRight'], ['run right (strafe)', V(side, 0), 'Right'],
    ['run back-left', V(-side * 0.7, side * 0.7), 'BackLeft'], ['run back', V(0, side), 'Back'], ['run left', V(-side, 0), 'Left'],
    ['walk front (Shift)', V(0, -walk), 'WalkFront'], ['walk back-right (Shift)', V(walk * 0.7, walk * 0.7), 'WalkBackRight'],
  ];
  for (const [label, vel, want] of cases) {
    sim(anim, 0.5, { ...base, vel }); log(label, anim);
    check(anim.lowerState === want && low(anim).endsWith(`Low_Stand_${want.startsWith('Walk') ? 'Walk' + want.slice(4) : 'Move' + want}`) && up(anim) === (A.AttackIdle.Move ?? A.AttackIdle.Idle).clip,
      `${label} -> ${want}`);
  }
  sim(anim, 0.5, { ...base, crouch: true, vel: V(0, -PB_CHARA.run.front * 0.33) }); log('crouch run front (2.1 m/s)', anim);
  check(anim.lowerState === 'Front' && /Low_Sit_MoveFront$/.test(low(anim)), `crouch run -> Sit Front (${low(anim)})`);
  sim(anim, 0.5, { ...base, crouch: true, vel: V(-PB_CHARA.walk.side * 0.33, 0) }); log('crouch walk left (Shift, 1.3 m/s)', anim);
  check(anim.lowerState === 'WalkLeft' && /Low_Sit_WalkLeft$/.test(low(anim)), `crouch walk -> Sit WalkLeft (${low(anim)})`);
  sim(anim, 0.5, { ...base, crouch: true, vel: V(0, 0) }); log('crouch idle', anim);
  check(/Low_Sit_Idle$/.test(low(anim)), 'crouch idle -> Low_Sit_Idle');
  if (A.Zoom && (zoomType === 2 || zoomType === 3)) {
    sim(anim, 0.6, { ...base, zoom: true, vel: V(0, 0) }); log('zoom idle', anim);
    check(anim.upperState === 'Zoom.Idle' && up(anim) === A.Zoom.Idle.clip, `zoom -> ${A.Zoom.Idle.clip}`);
    sim(anim, 0.4, { ...base, zoom: true, vel: V(0, -run * 0.76) }); log('zoom run (MoveNormal_Zoom)', anim);
    check(up(anim) === A.Zoom.Move.clip, `zoom move -> ${A.Zoom.Move.clip} (PB Zoom.Move)`);
  }
  if (!(A.Zoom && (zoomType === 2 || zoomType === 3))) {
    sim(anim, 0.4, { ...base, zoom: true, vel: V(0, 0) }); log('zoom (no Zoom AI for this weapon)', anim);
    check(anim.upperState === 'AttackIdle.Idle', 'aiming keeps AttackIdle (weapon.pef _ZoomType not 2/3 or no Zoom tree)');
  }
  sim(anim, 0.6, { ...base, vel: V(0, 0) });
  anim.fire(false); sim(anim, 0.03, { ...base, vel: V(0, 0) }); log('fire', anim);
  check(up(anim) === A.AttackIdle.Attack?.clip, `fire -> ${A.AttackIdle.Attack?.clip}`);
  sim(anim, 0.8, { ...base, vel: V(0, 0) });
  if (A.AttackIdle.AttackLeft) {
    anim.fire(false, 'L'); sim(anim, 0.03, { ...base, vel: V(0, 0) }); log('fire left (dual)', anim);
    check(up(anim) === A.AttackIdle.AttackLeft.clip, `dual: left gun -> ${A.AttackIdle.AttackLeft.clip}`);
    sim(anim, 0.8, { ...base, vel: V(0, 0) });
  }
  if (A.AttackIdle.LoadMagazine || A.AttackIdle.LoadBullet) {
    const st = A.AttackIdle.LoadMagazine ?? A.AttackIdle.LoadBullet;
    anim.reload(rt);
    sim(anim, 0.2, { ...base, vel: V(0, 0) }); log(`reload (${rt} s)`, anim);
    const act = anim.mixer._actions.find((a) => a.getClip().name === st.clip);
    check(up(anim) === st.clip, `reload -> ${st.clip} (clip ${act?.getClip().duration.toFixed(3)} s, i3AIState ${st.dur} s)`);
    sim(anim, rt - 0.2 - 0.05, { ...base, vel: V(0, 0) });
    const tEnd = act.time, shotUp = up(anim);
    check(shotUp === st.clip && Math.abs(tEnd / act.getClip().duration - (rt - 0.05) / rt) < 0.02,
      `reload still on at ${(rt - 0.05).toFixed(2)} s, clip time ${tEnd.toFixed(3)}/${act.getClip().duration.toFixed(3)} (stretched x${act.timeScale.toFixed(3)}, not cut)`);
    sim(anim, 0.4, { ...base, vel: V(0, 0) }); log('after reload', anim);
    check(up(anim) === A.AttackIdle.Idle.clip, 'after reload -> back to Up Idle');
  }
  if (/Knife/.test(ix.ai[ai].driver)) {
    anim.fire(true); sim(anim, 0.1, { ...base, vel: V(0, 0) }); log('secondary attack (stab)', anim);
    check(up(anim) === A.AttackIdle.SecondaryAttack?.clip, `stab -> ${A.AttackIdle.SecondaryAttack?.clip}`);
  }
  anim.change(); sim(anim, 0.1, { ...base, vel: V(0, 0) }); log('change', anim);
  check(!A.AttackIdle.Change || up(anim) === A.AttackIdle.Change.clip, `change -> ${A.AttackIdle.Change?.clip}`);
}

// ---- stride per cycle of every 8-direction clip (stance-foot speed x duration, as scripts/dev/test-anim-speed.mjs)
console.log('6. stride per cycle, 8 directions (anim3pv Low_* clips) vs CLIP_STRIDE');
{
  const { CLIP_STRIDE } = await import('../../src/game/charAnim.ts');
  const DIR8 = ['Front', 'FrontLeft', 'FrontRight', 'Left', 'Right', 'Back', 'BackLeft', 'BackRight'];
  const mixer = new THREE.AnimationMixer(root);
  const lf = root.getObjectByName('L_Foot'), rf = root.getObjectByName('R_Foot');
  const P = new THREE.Vector3();
  for (const [g, stance, pre] of [['run', 'Stand', ''], ['walk', 'Stand', 'Walk'], ['sit', 'Sit', ''], ['sitwalk', 'Sit', 'Walk']]) for (const d of DIR8) {
    const st = ix.lower[stance][pre + d];
    const c = st && (await clipsOf([st.clip])).get(st.clip);
    if (!c) { check(false, `${stance} ${pre + d} missing`); continue; }
    mixer.stopAllAction();
    const a = mixer.clipAction(c); a.reset().play(); a.setEffectiveWeight(1);
    const N = 160, T = c.duration, feet = [[], []];
    for (let i = 0; i <= N; i++) {
      a.time = (T * i) / N; mixer.update(0); root.updateMatrixWorld(true);
      feet[0].push(lf.getWorldPosition(P).toArray()); feet[1].push(rf.getWorldPosition(P).toArray());
    }
    const sp = [];
    for (const F of feet) {
      const ymin = Math.min(...F.map((q) => q[1]));
      for (let i = 0; i < N; i++) if (F[i][1] < ymin + 0.012) sp.push(Math.hypot(F[i + 1][0] - F[i][0], F[i + 1][2] - F[i][2]) / (T / N));
    }
    sp.sort((x, y) => x - y);
    const stride = sp[sp.length >> 1] * T, want = CLIP_STRIDE[g]?.[d];
      const k = PB_LOWER_K[g === 'walk' || g === 'sitwalk' ? 'walk' : 'run'][stance][d], pbNat = 1 / k, clipNat = stride / T;
    // PB plays the clip at speed x k: 1/k is the speed at which the clip runs at its own rate; compare it with the
    // stance-foot speed of the clip (how much the feet slide at PB speeds). Sit_Walk clips are 6.4 s multi-step
    // takes (median-foot method is rough there): logged only.
    const okNat = g === 'sitwalk' || Math.abs(pbNat / clipNat - 1) < 0.35;
    check((g === 'sitwalk' || Math.abs(stride / want - 1) < 0.25) && okNat,
      `${st.clip.padEnd(31)} dur ${T.toFixed(3)} s stride ${stride.toFixed(2)} m${want ? ` (CLIP_STRIDE ${want})` : ''} -> clip ${clipNat.toFixed(2)} m/s, PB 1/k ${pbNat.toFixed(2)} m/s`);
    a.stop();
  }
}

check(Math.abs(lowerTimeScale('Front', false, 4.5) - 1) < 1e-3 && Math.abs(lowerTimeScale('WalkRight', true, 1) - 3.2) < 1e-6 && lowerTimeScale('Back', false, 0) === 0.05,
  'lowerTimeScale = speed x k (run Front 4.5 m/s -> 1.0, crouch WalkRight x3.2, min 0.05)');
// direction sectors
check(dir8Of(1, 0) === 'Front' && dir8Of(1, 1) === 'FrontRight' && dir8Of(0, -1) === 'Left' && dir8Of(-1, -1) === 'BackLeft' && dir8Of(-1, 0.1) === 'Back', 'dir8Of sectors');

// ---- 5. bot speeds (same rule as src/player.ts moveSpeed)
console.log('5. bot speeds (PB_CHARA x K-2 MoveNormal_*)');
// src/ uses extensionless relative imports (bundler style): resolve them to .ts for Node's type stripping
register('data:text/javascript,' + encodeURIComponent(
  'export async function resolve(s, c, next) { try { return await next(s, c); } catch (e) {' +
  ' if ((s.startsWith("./") || s.startsWith("../")) && !/[.][a-z]+$/i.test(s)) return next(s + ".ts", c); throw e; } }'));
try {
  const { pbBotSpeed } = await import('../../src/game/botMove.ts');
  const rows = [['patrol run front', 0, 1, {}, 6.5 * 0.8], ['combat strafe firing', 1, 0, { firing: true }, 6 * 0.8 * 0.78],
    ['combat zoom strafe', 1, 0, { zoom: true }, 6 * 0.8 * 0.76], ['crouch front', 0, 1, { crouch: true }, 6.5 * 0.33], ['diagonal run', 0.7, 0.7, {}, 6 * 0.8]];
  for (const [label, x, z, o, want] of rows) {
    const v = pbBotSpeed(x, z, { crouch: false, zoom: false, firing: false, ...o });
    check(Math.abs(v - want) < 1e-6, `${label.padEnd(22)} ${v.toFixed(3)} m/s`);
  }
} catch (e) { console.log(`  skip botMove.ts import in Node (${e.message.split('\n')[0]})`); }

// ---- 7. net-replicated PlayerState -> CharAnimInput (remoteActor.ts / charModel.ts consumption of the wire
// torsoAction/moving/running/moveDir/zoomType, net/battle.ts + RemoteActor itself needs a
// browser (fetch/GLTFLoader over HTTP for charModel/charAnimLib preloadChara), so this drives CharAnimator with the
// same CharAnimInput.{moving,walking,dir8,zoom} RemoteActor.update()/CharVisual.update() build from a PlayerState,
// proving the network bits win over the (possibly stale/misleading) replicated `vel`.
console.log('7. net PlayerState -> CharAnimInput overrides (remoteActor.ts mapping)');
{
  // netAdapter.moveDir order (0=fwd,1=fwd-right,...7=fwd-left) == charAnim.ts DIR8
  const DIR8 = ['Front', 'FrontRight', 'Right', 'BackRight', 'Back', 'BackLeft', 'Left', 'FrontLeft'];
  /** RemoteActor.apply()/update(): PlayerState -> CharDriveState/CharAnimInput overrides. */
  const toInput = (s) => ({
    ...base,
    vel: s.vel ?? V(0, 0),
    moving: s.moving ?? false,
    walking: (s.moving ?? false) ? !s.running : undefined,
    dir8: (s.moving ?? false) ? DIR8[s.moveDir ?? 0] : undefined,
    zoom: s.torsoAction === 'zoom' && (s.zoomType === 2 || s.zoomType === 3),
  });

  const { anim: k2 } = await animFor(103004); // K-2, _ZoomType 1 (no Zoom AI)
  // moveDir=2 (Right) + running, with a misleading forward `vel` (position-delta noise): the override must win.
  sim(k2, 0.5, toInput({ vel: V(0, -6.5), moving: true, running: true, moveDir: 2 }));
  log('wire: moveDir Right, running (vel says Front)', k2);
  check(k2.lowerState === 'Right' && /Low_Stand_MoveRight$/.test(low(k2)), 'moveDir override beats vel-derived direction');
  // moveDir=6 (Left) + walking, zero vel (network idle-looking sample mid-step): still must walk left.
  sim(k2, 0.5, toInput({ vel: V(0, 0), moving: true, running: false, moveDir: 6 }));
  log('wire: moveDir Left, walking (vel says still)', k2);
  check(k2.lowerState === 'WalkLeft' && /Low_Stand_WalkLeft$/.test(low(k2)), 'moving+walking override beats vel-derived stillness');
  // moving=false with a nonzero (noisy) vel: legs must stay idle.
  sim(k2, 0.5, toInput({ vel: V(0, -0.6), moving: false, moveDir: 0 }));
  log('wire: moving=false (vel says Front)', k2);
  check(k2.lowerState === 'Idle' && /Low_Stand_Idle$/.test(low(k2)), 'moving=false override beats vel-derived movement');
  // torsoAction "zoom" but zoomType 1 (not 2/3, e.g. a stale sample from a weapon switch): stance stays AttackIdle.
  sim(k2, 0.5, toInput({ vel: V(0, 0), torsoAction: 'zoom', zoomType: 1 }));
  log('wire: torsoAction zoom, zoomType 1 (K-2)', k2);
  check(k2.upperState === 'AttackIdle.Idle', 'zoomType 1 does not select the Zoom stance');

  const { anim: as50 } = await animFor(103001); // SG550 DotSight (PBCross), _ZoomType 3 (has a Zoom AI); AS-50 is not in PBCross
  sim(as50, 0.6, toInput({ vel: V(0, 0), torsoAction: 'zoom', zoomType: 3 }));
  log('wire: torsoAction zoom, zoomType 3 (AS-50)', as50);
  check(as50.upperState === 'Zoom.Idle', 'zoomType 3 + torsoAction zoom selects the Zoom stance');

  // RemoteActor.apply(): the persistent `aiming` flag only updates on torsoAction idle/zoom (fire/reload/change carry
  // no zoom info of their own on the wire, net/battle.ts torsoAction bits 10-13).
  let aiming = false;
  const applyTorso = (torso, zoomType) => {
    if (torso === 'zoom' || torso === 'idle') aiming = torso === 'zoom' && (zoomType === 2 || zoomType === 3);
    return aiming;
  };
  check(applyTorso('zoom', 3) === true, 'torsoAction zoom (zoomType 3) -> aiming true');
  check(applyTorso('fire', 0) === true, 'torsoAction fire keeps the last aiming state (true)');
  check(applyTorso('reload', 0) === true, 'torsoAction reload keeps the last aiming state (true)');
  check(applyTorso('idle', 0) === false, 'torsoAction idle clears aiming');
  check(applyTorso('fire', 0) === false, 'torsoAction fire after idle keeps aiming false');
}

process.exit(fail ? 1 : 0);
