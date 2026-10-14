// Headless bot-KCC benchmark: 16 capsules wander on a real map collision; per-call ms of computeColliderMovement by setup variant.
//   node scripts/dev/bench-bot-kcc.mjs [map] [--merge]   (default nstation; --merge = one trimesh per extras.material like the game's buildStaticColliders, which groups by surface code)
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tool } from './lib/tools.mjs';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RAPIER = (await import(pathToFileURL(path.join(ROOT, 'node_modules/@dimforge/rapier3d-compat/rapier.es.js')).href)).default;
const { readGLB } = await tool('i3r2/skin-glb.mjs');

const MAP = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || 'nstation';
const MERGE = process.argv.includes('--merge');
const ACTOR = (0x0002 << 16) | 0xffff, KCC_QUERY = (0xffff << 16) | 0x0003, HIT = (0x0004 << 16) | 0x0001;
await RAPIER.init();

function build(sensors) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const { J, read } = readGLB(path.join(ROOT, `public/assets/maps/${MAP}/collision.glb`));
  let tris = 0;
  const groups = new Map();
  for (const n of J.nodes) { if (n.mesh == null) continue; for (const p of J.meshes[n.mesh].primitives) {
    const P = Float32Array.from(read(p.attributes.POSITION));
    const I = p.indices != null ? Uint32Array.from(read(p.indices)) : Uint32Array.from({ length: P.length / 3 }, (_, i) => i);
    tris += I.length / 3;
    if (MERGE) { const k = n.extras?.material ?? '', g = groups.get(k) ?? { P: [], I: [] }; const o = g.P.length / 3; for (const v of P) g.P.push(v); for (const i of I) g.I.push(i + o); groups.set(k, g); continue; }
    world.createCollider(RAPIER.ColliderDesc.trimesh(P, I), world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
  } }
  for (const g of groups.values()) world.createCollider(RAPIER.ColliderDesc.trimesh(Float32Array.from(g.P), Uint32Array.from(g.I)), world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
  world.step();
  return { world, tris };
}

function run(label, opt) {
  const { world, tris } = build();
  // spawn points: probe a grid downward for floor
  const spawns = [];
  for (let x = -40; x <= 40 && spawns.length < 16; x += 7) for (let z = -40; z <= 40 && spawns.length < 16; z += 7) {
    const h = world.castRay(new RAPIER.Ray({ x, y: 50, z }, { x: 0, y: -1, z: 0 }), 100, true);
    if (h) spawns.push({ x, y: 50 - h.timeOfImpact + 1.0, z });
  }
  const bots = spawns.map((s) => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(s.x, s.y, s.z));
    const col = world.createCollider(RAPIER.ColliderDesc.capsule(0.55, 0.3).setCollisionGroups(ACTOR), body);
    const kcc = world.createCharacterController(0.02);
    kcc.setMaxSlopeClimbAngle(45 * Math.PI / 180);
    if (opt.autostep) kcc.enableAutostep(0.35, 0.3, true);
    if (opt.snap) kcc.enableSnapToGround(0.3);
    return { body, col, kcc, vx: 0, vz: 0, vy: 0, yaw: Math.random() * 6.28 };
  });
  if (opt.sensors) {
    for (let i = 0; i < bots.length * 20; i++) world.createCollider(RAPIER.ColliderDesc.cuboid(0.1, 0.2, 0.1).setSensor(true).setCollisionGroups(HIT).setTranslation(spawns[i % spawns.length].x, spawns[i % spawns.length].y, spawns[i % spawns.length].z));
  }
  const dt = 1 / 60, N = 600;
  let tot = 0, calls = 0, ncol = 0;
  for (let f = 0; f < N; f++) {
    for (const b of bots) {
      if (f % 60 === 0) b.yaw += (Math.random() - 0.5) * 3;
      b.vx = -Math.sin(b.yaw) * 4; b.vz = -Math.cos(b.yaw) * 4; b.vy -= 9.81 * dt;
      const t0 = performance.now();
      b.kcc.computeColliderMovement(b.col, { x: b.vx * dt, y: b.vy * dt, z: b.vz * dt }, undefined, KCC_QUERY);
      const m = b.kcc.computedMovement();
      const g = b.kcc.computedGrounded();
      for (let i = 0, n = b.kcc.numComputedCollisions(); i < n; i++) { b.kcc.computedCollision(i); ncol++; }
      tot += performance.now() - t0; calls++;
      if (g && b.vy < 0) b.vy = 0;
      const p = b.body.translation();
      b.body.setNextKinematicTranslation({ x: p.x + m.x, y: p.y + m.y, z: p.z + m.z });
      if (Math.abs(m.x) < 1e-4 && Math.abs(m.z) < 1e-4) b.yaw += 1.5;
    }
    world.timestep = dt; world.step();
  }
  console.log(`${label.padEnd(34)} ${MAP} tris=${tris}  ${(tot / calls * 1000).toFixed(0)} us/call  -> ${(tot / N).toFixed(2)} ms/frame for ${bots.length} bots  (collisions/call ${(ncol / calls).toFixed(1)})`);
}

// Before/after of the 30 Hz staggered bot step (src/game/bots.ts stepPhysics): same wander at each render rate, KCC every frame vs fixed 1/30 steps.
//   node scripts/dev/bench-bot-kcc.mjs <map> --step   -> distance walked per second (must match +-5%) and KCC ms/frame
function runStep(frameHz, physHz) {
  const { world } = build();
  const spawns = [];
  for (let x = -40; x <= 40 && spawns.length < 16; x += 7) for (let z = -40; z <= 40 && spawns.length < 16; z += 7) {
    const h = world.castRay(new RAPIER.Ray({ x, y: 50, z }, { x: 0, y: -1, z: 0 }), 100, true);
    if (h) spawns.push({ x, y: 50 - h.timeOfImpact + 1.0, z });
  }
  let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const bots = spawns.map((s, i) => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(s.x, s.y, s.z));
    const col = world.createCollider(RAPIER.ColliderDesc.capsule(0.55, 0.3).setCollisionGroups(ACTOR), body);
    const kcc = world.createCharacterController(0.02);
    kcc.setMaxSlopeClimbAngle(45 * Math.PI / 180); kcc.enableAutostep(0.35, 0.3, true); kcc.enableSnapToGround(0.3);
    return { body, col, kcc, vx: 0, vz: 0, vy: 0, yaw: rnd() * 6.28, acc: (i * 0.618 % 1) / 30, dist: 0 };
  });
  const dt = 1 / frameHz, STEP = physHz ? 1 / physHz : dt, N = Math.round(frameHz * 10);
  let tot = 0, calls = 0;
  for (let f = 0; f < N; f++) {
    for (const b of bots) {
      if (f % frameHz === 0) b.yaw += (rnd() - 0.5) * 3;
      b.acc += dt;
      const n = physHz ? Math.min(3, Math.floor(b.acc / STEP)) : 1;
      if (!n) continue;
      if (physHz) b.acc = Math.min(b.acc - n * STEP, STEP);
      const sdt = physHz ? n * STEP : dt;
      b.vx = -Math.sin(b.yaw) * 4; b.vz = -Math.cos(b.yaw) * 4; b.vy -= 9.81 * sdt;
      const t0 = performance.now();
      b.kcc.computeColliderMovement(b.col, { x: b.vx * sdt, y: b.vy * sdt, z: b.vz * sdt }, undefined, KCC_QUERY);
      tot += performance.now() - t0; calls++;
      const m = b.kcc.computedMovement();
      if (b.kcc.computedGrounded() && b.vy < 0) b.vy = 0;
      const p = b.body.nextTranslation();
      b.body.setNextKinematicTranslation({ x: p.x + m.x, y: p.y + m.y, z: p.z + m.z });
      b.dist += Math.hypot(m.x, m.z);
      if (Math.abs(m.x) < 1e-4 && Math.abs(m.z) < 1e-4) b.yaw += 1.5;
    }
    world.timestep = dt; world.step();
  }
  const d = bots.reduce((s, b) => s + b.dist, 0) / bots.length / 10;
  console.log(`${MAP} frame ${frameHz} Hz, KCC ${physHz ? physHz + ' Hz fixed' : 'every frame'}: ${d.toFixed(2)} m/s per bot, ${(tot / N).toFixed(2)} ms/frame, ${(calls / N / bots.length).toFixed(2)} calls/bot/frame`);
}
if (process.argv.includes('--step')) {
  for (const hz of [60, 144]) { runStep(hz, 0); runStep(hz, 30); }
  process.exit(0);
}

run('autostep+snap (current)', { autostep: true, snap: true });
run('autostep+snap + 320 sensors', { autostep: true, snap: true, sensors: true });
run('snap only', { autostep: false, snap: true });
run('autostep only', { autostep: true, snap: false });
run('neither', { autostep: false, snap: false });
