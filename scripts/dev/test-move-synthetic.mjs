#!/usr/bin/env node
// Headless movement test on synthetic geometry (no map assets needed): a trimesh floor, an 8-step staircase (risers
// 0.17 / 0.20 / 0.22 m, treads 0.38 m, the NStation 2017 range) and a box, with the player's KCC setup and ground move
// from src/player.ts (same loop as scripts/dev/test-stairs.mjs). Checks, at 30-240 Hz:
//   - climbing: no "stumble" (frames under 3 m/s horizontal while running up) and the top is reached in time;
//   - descending and running on the flat: never airborne (a false air frame freezes the accel and resets JumpDelay);
//   - jumping onto a 0.9 m box lands on it;
//   - a standing jump goes through the Downtown bomb-site window (0.90 m sill, 1.634 m opening).
//
//   node scripts/dev/test-move-synthetic.mjs      # exit 0 = pass
import RAPIER from '@dimforge/rapier3d-compat';
import { PB_CAPSULE, PB_CHARA } from '../../src/gameplay/pbConfig.ts';
import { KCC_GROUND_PUSH, configurePbKcc, slideOffWalls, touchedGround } from '../../src/gameplay/kcc.ts';
import { newAccelState, pbAccelStep, pbCanJump, pbFallK, pbJumpRiseY, pbJumpStart } from '../../src/gameplay/pbMove.ts';

await RAPIER.init();
const ACTOR = (0x0002 << 16) | 0xffff, KCC_QUERY = (0xffff << 16) | 0x0003; // src/game/types.ts
const R = PB_CAPSULE.radius, HH = PB_CAPSULE.halfHeightStand, K = pbFallK(PB_CHARA);
const TREAD = 0.38, STEPS = 8;

function boxTris(x0, y0, z0, x1, y1, z1, P, I) {
  const b = P.length / 3;
  for (const [x, y, z] of [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]) P.push(x, y, z);
  for (const t of [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]) I.push(b + t);
}
function trimeshWorld(P, I) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.trimesh(Float32Array.from(P), Uint32Array.from(I)), world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
  world.step();
  return world;
}
/** floor top at y 0; stairs up along +x from x 0 (z -2..2); box x -6..-5, z 5..6 */
function makeWorld(riser, box = 0.9) {
  const P = [], I = [];
  boxTris(-20, -1, -20, 20, 0, 20, P, I);
  for (let s = 1; s <= STEPS; s++) boxTris((s - 1) * TREAD, 0, -2, 20, s * riser, 2, P, I);
  boxTris(-6, 0, 5, -5, box, 6, P, I);
  return trimeshWorld(P, I);
}
/**
 * Broken window next to Downtown bomb site A, as measured on the map collision (street floor 5.445 -> y 0): sill 0.90,
 * opening 1.634 m tall and 2.8 m wide, wall 0.2 m thick (x 10..10.2), floor inside at 0.166.
 */
function makeWindowWorld() {
  const P = [], I = [];
  boxTris(-20, -1, -20, 10, 0, 20, P, I);
  boxTris(10.2, -1, -20, 20, 0.166, 20, P, I);
  boxTris(10, -1, -20, 10.2, 0.9, 20, P, I);
  boxTris(10, 2.534, -20, 10.2, 4, 20, P, I);
  boxTris(10, 0.9, -20, 10.2, 2.534, -1.4, P, I);
  boxTris(10, 0.9, 1.4, 10.2, 2.534, 20, P, I);
  return trimeshWorld(P, I);
}

/** src/player.ts ground / jump / fall step (move part only), running along `dir` after 0.2 s */
function run(world, { from, dir, dt, secs = 2.5, jumpAt = -1 }) {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(from[0], from[1] + HH + R + 0.05, from[2]));
  const col = world.createCollider(RAPIER.ColliderDesc.capsule(HH, R).setCollisionGroups(ACTOR), body);
  const kcc = world.createCharacterController(0.02);
  configurePbKcc(kcc, PB_CAPSULE);
  world.step();
  const a = newAccelState(), v = { x: 0, y: 0, z: 0 };
  let grounded = false, jump = null, jumpT = 0, jumpY0 = 0, fallT = 0, fallPrev = 0, sinceLanding = 9;
  const onGround = () => kcc.computedGrounded() || touchedGround(kcc, PB_CAPSULE.maxSlopeClimbDeg);
  const log = [];
  for (let i = 0, n = Math.round(secs / dt); i < n; i++) {
    const t = i * dt, go = t > 0.2, pos = body.translation(), feetNow = pos.y - HH - R;
    sinceLanding += dt;
    pbAccelStep(a, go ? dir[0] : 0, go ? dir[1] : 0, PB_CHARA.run.front, dt, !grounded || jump !== null, PB_CHARA);
    v.x = a.vx; v.z = a.vz;
    if (grounded && !jump && jumpAt >= 0 && t >= jumpAt && pbCanJump(sinceLanding, PB_CHARA)) {
      jump = pbJumpStart(sinceLanding, false, 9, PB_CHARA); jumpT = 0; jumpY0 = feetNow; jumpAt = -1;
    }
    let dy = 0, apex = false;
    if (jump) {
      if (jumpT > 0 && jumpT + dt > jump.halfTime) apex = true;
      else { jumpT += dt; dy = Math.max(0, jumpY0 + pbJumpRiseY(jump, jumpT) - feetNow); }
    }
    if (apex) { jump = null; fallT = fallPrev = 0; }
    if (!jump) {
      if (grounded && !apex) dy = KCC_GROUND_PUSH * dt * 60;
      else { fallT += dt; const drop = K * fallT * fallT; dy = fallPrev - drop; fallPrev = drop; }
    }
    const wasGrounded = grounded;
    const desired = { x: v.x * dt, y: dy, z: v.z * dt };
    kcc.computeColliderMovement(col, desired, undefined, KCC_QUERY);
    let m = kcc.computedMovement();
    const rising = jump !== null && desired.y > 0;
    grounded = onGround() && !rising;
    if (rising && m.y < desired.y * 0.5) { jump = null; fallT = fallPrev = 0; }
    if (!grounded && wasGrounded && !jump) {
      kcc.computeColliderMovement(col, { x: m.x, y: -PB_CAPSULE.maxStepHeight, z: m.z }, undefined, KCC_QUERY);
      if (onGround()) { m = kcc.computedMovement(); grounded = true; }
    }
    slideOffWalls(kcc, v, feetNow, PB_CAPSULE.maxStepHeight);
    a.vx = v.x; a.vz = v.z;
    if (grounded) { if (!wasGrounded) sinceLanding = 0; fallT = fallPrev = 0; }
    body.setNextKinematicTranslation({ x: pos.x + m.x, y: pos.y + m.y, z: pos.z + m.z });
    world.timestep = dt;
    world.step();
    log.push({ t, x: pos.x + m.x, feet: feetNow + m.y, h: Math.hypot(m.x, m.z) / dt, grounded });
  }
  world.removeCharacterController(kcc);
  world.removeRigidBody(body);
  return log;
}

let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log('  FAIL', msg); } };
for (const hz of [30, 60, 144, 240]) {
  const dt = 1 / hz;
  const out = [];
  for (const riser of [0.17, 0.2, 0.22]) {
    const w = makeWorld(riser), top = STEPS * riser;
    const up = run(w, { from: [-2, 0, 0], dir: [1, 0], dt });
    const climb = up.filter((e) => e.t > 0.45 && e.x > -0.6 && e.feet < top - 0.02);
    const slow = climb.filter((e) => e.h < 3).length;
    const at = up.find((e) => e.feet > top - 0.05)?.t;
    check(slow <= 5, `${hz} Hz riser ${riser}: ${slow} stumble frames (< 3 m/s) climbing`);
    check(at !== undefined && at < 1.15, `${hz} Hz riser ${riser}: top reached at ${at?.toFixed(2)} s`);
    const down = run(w, { from: [4.5, top, 0], dir: [-1, 0], dt }).filter((e) => e.t > 0.45);
    const air = down.filter((e) => !e.grounded).length;
    check(air === 0 && down.at(-1).feet < 0.1, `${hz} Hz riser ${riser}: ${air} airborne frames descending`);
    out.push(`riser ${riser}: up ${slow} slow, top ${at?.toFixed(2)} s; down air ${air}`);
  }
  const w = makeWorld(0.2);
  const flat = run(w, { from: [-9, 0, -8], dir: [1, 0], dt, secs: 1.5 }).filter((e) => e.t > 0.3);
  const flatAir = flat.filter((e) => !e.grounded).length;
  check(flatAir === 0, `${hz} Hz flat: ${flatAir} airborne frames`);
  const box = run(w, { from: [-9, 0, 5.5], dir: [1, 0], dt, jumpAt: 0.45, secs: 1.2 });
  const onBox = box.some((e) => e.x > -6 && e.x < -5 && e.grounded && e.feet > 0.85);
  check(onBox, `${hz} Hz: jump onto the 0.9 m box did not land on it`);
  // standing jump through the window (the exe's 1.43 m controller fits the 1.634 m opening, a 1.9 m one never did)
  const ww = makeWindowWorld();
  const win = [0.45, 0.5, 0.55].filter((jumpAt) => run(ww, { from: [7, 0, 0], dir: [1, 0], dt, jumpAt, secs: 1.6 }).at(-1).x > 10.6).length;
  check(win === 3, `${hz} Hz: standing jump through the window passed ${win}/3`);
  console.log(`${String(hz).padStart(3)} Hz  ${out.join(' | ')} | flat air ${flatAir} | box ${onBox ? 'ok' : 'miss'} | window ${win}/3`);
}
process.exit(fail ? 1 : 0);
