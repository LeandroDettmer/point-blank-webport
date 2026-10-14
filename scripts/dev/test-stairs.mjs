#!/usr/bin/env node
// Headless stair test (no browser): Rapier + the NStation 2017 collision, the player's capsule / KCC setup / wall
// slide (src/gameplay/kcc.ts, PB_CAPSULE) and the player's ground movement (RUN 6.5 m/s, AccelerationTime ramp,
// jump gravity) from src/player.ts. Walks forward ~2 s from the foot of each real staircase at several frame rates;
// the feet must end within 0.1 m of the top floor.
//
//   node scripts/dev/test-stairs.mjs            # exit 0 = every staircase climbed at every dt
//
// Stairs measured from collision.glb (risers 0.17-0.22 m, treads 0.37-0.40 m): spawn stairs -0.75 -> 0.27 at z +-33,
// platform stairs 0.27 -> 1.29 (z +-28.3..29.8, z +-11.2..12.7, x 6.3..7.9 split by a rail at z 5.45..5.72).

import { tool } from './lib/tools.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import RAPIER from '@dimforge/rapier3d-compat';
const { readGLB } = await tool('i3r2/skin-glb.mjs');
import { PB_CAPSULE, PB_CHARA, jumpBallistics } from '../../src/gameplay/pbConfig.ts';
import { KCC_GROUND_PUSH, configurePbKcc, slideOffWalls, touchedGround } from '../../src/gameplay/kcc.ts';
import { newAccelState, pbAccelStep, pbFallK } from '../../src/gameplay/pbMove.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COL = path.join(HERE, '../../public/assets/maps/nstation/collision.glb');
const ACTOR = (0x0002 << 16) | 0xffff, KCC_QUERY = (0xffff << 16) | 0x0003; // src/game/types.ts

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const { J, read } = readGLB(COL);
for (const n of J.nodes) for (const p of J.meshes[n.mesh].primitives) {
  const P = Float32Array.from(read(p.attributes.POSITION));
  const I = p.indices != null ? Uint32Array.from(read(p.indices)) : Uint32Array.from({ length: P.length / 3 }, (_, i) => i);
  world.createCollider(RAPIER.ColliderDesc.trimesh(P, I), world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
}
world.step();

void jumpBallistics;
const K = pbFallK(PB_CHARA), R = PB_CAPSULE.radius, HH = PB_CAPSULE.halfHeightStand;
const speed = PB_CHARA.run.front;

// stopAtTop: for the descend test below, break as soon as the top floor is reached (grounded, within 0.05 m) and
// report that state instead of running the full `secs`, so descend() can start from the real top of the flight.
function climb([x, y, z], [dx, dz], dt, secs = 2, stopAtTop = null) {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y + HH + R + 0.05, z));
  const col = world.createCollider(RAPIER.ColliderDesc.capsule(HH, R).setCollisionGroups(ACTOR), body);
  const kcc = world.createCharacterController(0.02); // src/player.ts
  configurePbKcc(kcc, PB_CAPSULE);
  world.step();
  const v = { x: 0, y: 0, z: 0 }, a = newAccelState();
  let grounded = false, fallT = 0, fallPrev = 0;
  let airborneFrames = 0, fallDamageEvents = 0, maxLanding = 0, takeoffY = y;
  const n = Math.round(secs / dt);
  let i = 0;
  for (; i < n; i++) {
    const go = i * dt > 0.2; // settle on the floor first
    pbAccelStep(a, go ? dx : 0, go ? dz : 0, speed, dt, !grounded, PB_CHARA); // src/player.ts
    v.x = a.vx; v.z = a.vz;
    let dy;
    if (grounded) dy = KCC_GROUND_PUSH * dt * 60;
    else { fallT += dt; const drop = K * fallT * fallT; dy = fallPrev - drop; fallPrev = drop; }
    v.y = dy / dt;
    const pos = body.translation();
    const wasGrounded = grounded;
    kcc.computeColliderMovement(col, { x: v.x * dt, y: v.y * dt, z: v.z * dt }, undefined, KCC_QUERY);
    let m = kcc.computedMovement();
    const onGround = () => kcc.computedGrounded() || touchedGround(kcc, PB_CAPSULE.maxSlopeClimbDeg);
    grounded = onGround();
    // Mirrors src/player.ts: descent-only fallback when the primary query (autostep needs it intact to climb) lost
    // the ground, re-querying from the same start with the resolved x/z but a full step-height search down, so a
    // fast running descent re-touches the next tread even when enableSnapToGround(0.3) alone misses it.
    if (!grounded && wasGrounded) {
      kcc.computeColliderMovement(col, { x: m.x, y: -PB_CAPSULE.maxStepHeight, z: m.z }, undefined, KCC_QUERY);
      if (onGround()) { m = kcc.computedMovement(); grounded = true; }
    }
    slideOffWalls(kcc, v, pos.y - HH - R, PB_CAPSULE.maxStepHeight);
    a.vx = v.x; a.vz = v.z;
    const feetY = pos.y - HH - R + m.y;
    if (grounded) {
      if (!wasGrounded && go && fallT > 0.1) { fallDamageEvents++; maxLanding = Math.max(maxLanding, Math.abs(takeoffY - feetY)); }
      takeoffY = feetY; fallT = fallPrev = 0; v.y = 0;
    } else if (go) airborneFrames++;
    body.setNextKinematicTranslation({ x: pos.x + m.x, y: pos.y + m.y, z: pos.z + m.z });
    world.timestep = dt;
    world.step();
    if (stopAtTop != null && grounded && feetY > stopAtTop - 0.05) { i++; break; }
  }
  const t = body.translation();
  world.removeCharacterController(kcc);
  world.removeRigidBody(body);
  return { x: t.x, feetY: t.y - HH - R, z: t.z, frames: i, airborneFrames, fallDamageEvents, maxLanding };
}

const STAIRS = [
  ['spawn stairs z+33 (+x)', [-6.0, -0.75, 33], [1, 0], 0.27],
  ['spawn stairs z-33 (+x)', [-6.0, -0.75, -33], [1, 0], 0.27],
  ['platform stairs x-1 z+29 (-z)', [-1, 0.27, 31.0], [0, -1], 1.29],
  ['platform stairs x10 z-29 (+z)', [10, 0.27, -31.0], [0, 1], 1.29],
  ['platform stairs x-8.5 z+12 (+z)', [-8.5, 0.27, 9.8], [0, 1], 1.29],
  ['platform stairs x6.3 z3.5 (+x)', [5.2, 0.27, 3.5], [1, 0], 1.29],
];
let fail = 0;
console.log(`PB_CAPSULE r ${R} hh ${HH} step ${PB_CAPSULE.maxStepHeight} slope ${PB_CAPSULE.maxSlopeClimbDeg}deg, run ${speed} m/s`);
for (const hz of [20, 30, 60, 144, 240]) {
  const res = STAIRS.map(([name, from, dir, top]) => {
    const e = climb(from, dir, 1 / hz);
    const ok = e.feetY > top - 0.1;
    if (!ok) { fail++; console.log(`  FAIL ${hz} Hz ${name}: feet y ${e.feetY.toFixed(3)} (top ${top}) at x ${e.x.toFixed(2)} z ${e.z.toFixed(2)}`); }
    return ok;
  });
  console.log(`${String(hz).padStart(3)} Hz: ${res.filter(Boolean).length}/${res.length} staircases climbed`);
}

// Descend: climb to the real top of each flight (stopAtTop), then walk back down it and check the capsule stays
// grounded (no fall-damage-worthy landing, no lingering air time) the whole way, per 's ledge rule.
for (const hz of [60, 144, 240]) {
  const dt = 1 / hz;
  const res = STAIRS.map(([name, from, dir, top]) => {
    const up = climb(from, dir, dt, 3, top);
    const down = climb([up.x, up.feetY, up.z], [-dir[0], -dir[1]], dt, up.frames * dt + 0.3);
    const ok = down.feetY < from[1] + 0.15 && down.fallDamageEvents === 0;
    if (!ok) {
      fail++;
      console.log(`  FAIL ${hz} Hz descend ${name}: feet y ${down.feetY.toFixed(3)} (bottom ${from[1]}) air ${down.airborneFrames} fallDamageEvents ${down.fallDamageEvents} maxLanding ${down.maxLanding.toFixed(3)}`);
    }
    return ok;
  });
  console.log(`${String(hz).padStart(3)} Hz: ${res.filter(Boolean).length}/${res.length} staircases descended`);
}
process.exit(fail ? 1 : 0);
