// Node smoke for the Designation movement effects (Player.titleMove): move / jump / accel / fall by the
// formulas, zeros = plain character.
//   npx esbuild src/game/dev/titleMove.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/tm.mjs && node <tmp>/tm.mjs
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { PB_CHARA, PB_CHARA_GLOBAL, pbFallDamage } from "../../gameplay/pbConfig";
import { Player, fallDamage } from "../../player";
import type { Input } from "../input";

let fails = 0;
const check = (n: string, ok: boolean, i = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${n}${i ? "  " + i : ""}`); };
const near = (a: number, b: number, e = 1e-3) => Math.abs(a - b) <= e;
const C = PB_CHARA, G = PB_CHARA_GLOBAL;

await RAPIER.init();
function rig() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(200, 0.5, 200).setTranslation(0, -0.5, 0), world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
  const down = new Set<string>(), pressed = new Set<string>();
  const input = { lookDX: 0, lookDY: 0, key: (c: string) => down.has(c), keyPressed: (c: string) => pressed.has(c) } as unknown as Input;
  const p = new Player(world, RAPIER, new THREE.PerspectiveCamera(), new THREE.Vector3(0, 0, 0), input);
  p.teleportFeet(new THREE.Vector3(0, 0, 0), 0);
  const dt = 1 / 60, feet = new THREE.Vector3();
  const step = (n = 1) => { for (let i = 0; i < n; i++) { p.update(dt, { move: true, look: false }); world.timestep = dt; world.step(); pressed.clear(); } };
  step(60);
  return { p, down, pressed, step, feet, dt };
}

// move: RUN front + move
{
  const r = rig();
  check("move 0: front run speed", near(r.p.moveSpeed(0, 1), C.run.front));
  r.p.titleMove.move = 0.5;
  check("move +0.5: front run + 0.5", near(r.p.moveSpeed(0, 1), C.run.front + 0.5));
  r.p.titleMove.move = -1;
  check("move -1: side run - 1", near(r.p.moveSpeed(1, 0), C.run.side - 1));
}
// accel: time to 90 % of speed
{
  const t90 = (add: number) => {
    const r = rig(); r.p.titleMove.accel = add; r.down.add("KeyW");
    for (let i = 1; i < 120; i++) { r.step(); if (r.p.speedRatio() * C.run.front >= 0.9 * C.run.front) return i * r.dt; }
    return Infinity;
  };
  const a = t90(0), f = t90(-0.1), s = t90(0.2);
  check("accel: -0.1 s ramps faster, +0.2 s slower", f < a && a < s, `${f.toFixed(3)} < ${a.toFixed(3)} < ${s.toFixed(3)}`);
}
// jump apex
{
  const apexOf = (add: number) => {
    const r = rig(); r.p.titleMove.jump = add;
    const base = r.p.getFeet(r.feet).y; let apex = 0;
    r.pressed.add("Space"); r.down.add("Space"); r.step();
    for (let i = 0; i < 200 && !r.p.isGrounded(); i++) { r.step(); apex = Math.max(apex, r.p.getFeet(r.feet).y - base); }
    return apex;
  };
  const a0 = apexOf(0), a1 = apexOf(0.3);
  check("jump 0: apex 0.85 m", near(a0, 0.85, 0.03), a0.toFixed(3));
  check("jump +0.3: apex = (1 + 0.3) * 0.85", near(a1, 1.3 * 0.85, 0.04), a1.toFixed(3));
}
// fall damage threshold
{
  const h = G.fallDamageMinHeight + 0.2;
  check("fall 0: = pbFallDamage", fallDamage(h) === pbFallDamage(h, C.hp) && fallDamage(h) > 0);
  check("fall +0.5: no damage below min+0.5", fallDamage(h, 0.5) === 0 && fallDamage(G.fallDamageMinHeight + 0.6, 0.5) > 0);
  check("fall -0.5: damage 0.5 m earlier", fallDamage(G.fallDamageMinHeight - 0.3, -0.5) > 0 && pbFallDamage(G.fallDamageMinHeight - 0.3, C.hp) === 0);
  const r = rig(); r.p.titleMove.fall = 0.5;
  check("Player.fallDamage uses titleMove.fall", r.p.fallDamage(h) === 0);
}
console.log(fails ? `${fails} FAIL` : "all ok");
process.exit(fails ? 1 : 0);
