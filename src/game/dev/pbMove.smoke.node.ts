// Node smoke for the exe-2017 movement / jump / grenade-fuse / TDM rules (no browser):
//   pure math of src/gameplay/pbMove.ts, the real Player on a flat Rapier floor (jump apex, landing, JumpDelay,
//   crouch jump, accel / release), K-400 fuse from weapons.json, Match team-kill and kill-limit rules.
//
//   npx esbuild src/game/dev/pbMove.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/pm.mjs && node <tmp>/pm.mjs
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { PB_CHARA, PB_CAPSULE } from "../../gameplay/pbConfig";
import {
  newAccelState, pbAccelStep, pbCanJump, pbFallK, pbHitSlow, pbJumpFactor, pbJumpRiseY, pbJumpStart,
} from "../../gameplay/pbMove";
import { Player } from "../../player";
import { Match } from "../match";
import { buildParams } from "../../weapons/data";
import type { Input } from "../input";
import type { Actor, Team } from "../types";

let fails = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`);
};
const near = (a: number, b: number, e = 1e-3) => Math.abs(a - b) <= e;
const C = PB_CHARA;

// ---- accel integrator
function runAccel(hz: number, secs: number, input: (t: number) => [number, number], max = C.run.front) {
  const s = newAccelState(), dt = 1 / hz;
  let dist = 0;
  const samples: { t: number; v: number }[] = [];
  for (let i = 0, n = Math.round(secs * hz); i < n; i++) {
    const [x, z] = input(i * dt);
    pbAccelStep(s, x, z, max, dt, false, C);
    dist += Math.hypot(s.vx, s.vz) * dt;
    samples.push({ t: (i + 1) * dt, v: Math.hypot(s.vx, s.vz) });
  }
  return { s, dist, samples };
}
{
  const r60 = runAccel(60, 0.1, () => [0, 1]);
  check("accel: 0.1 s from rest = sin(pi/4) x 6.5", near(r60.samples.at(-1)!.v, Math.sin(Math.PI / 4) * 6.5, 0.02), `${r60.samples.at(-1)!.v.toFixed(3)}`);
  const full = runAccel(60, 0.25, () => [0, 1]);
  check("accel: full RUN speed after AccelerationTime", near(full.samples.at(-1)!.v, 6.5, 1e-6));
  const t90 = (hz: number) => runAccel(hz, 0.3, () => [0, 1]).samples.find((p) => p.v >= 0.9 * 6.5)!.t;
  check("accel: frame-rate independent ramp (60 vs 144 Hz)", Math.abs(t90(60) - t90(144)) < 0.02, `${t90(60).toFixed(3)} / ${t90(144).toFixed(3)} s`);
  const stop = (hz: number) => runAccel(hz, 1, (t) => (t < 0.5 ? [0, 1] : [0, 0]));
  const s60 = stop(60), s144 = stop(144);
  const stopT = (r: ReturnType<typeof stop>) => r.samples.find((p) => p.t > 0.5 && p.v === 0)!.t - 0.5;
  check("release: stops within AccelerationTime", stopT(s60) <= C.accelerationTime + 1.5 / 60 && stopT(s144) <= C.accelerationTime + 1.5 / 144,
    `${stopT(s60).toFixed(3)} / ${stopT(s144).toFixed(3)} s`);
  const slide = (r: ReturnType<typeof stop>) => r.samples.filter((p) => p.t > 0.5).reduce((d, p, i, a) => d + p.v * (i ? p.t - a[i - 1].t : p.t - 0.5), 0);
  check("release: slide distance 60 vs 144 Hz within 15 %", Math.abs(slide(s60) - slide(s144)) / slide(s60) < 0.15,
    `${slide(s60).toFixed(3)} / ${slide(s144).toFixed(3)} m`);
  const rev = runAccel(60, 1, (t) => (t < 0.5 ? [0, 1] : [0, -1]));
  const zero = rev.samples.find((p) => p.t > 0.5 && p.v < 0.05)!;
  check("reverse: speed passes 0 in ~AccelerationTime/2", zero.t - 0.5 < C.accelerationTime / 2 + 0.05, `${(zero.t - 0.5).toFixed(3)} s`);
  check("reverse: ends at full speed the other way", rev.s.vz < -6.4, `vz ${rev.s.vz.toFixed(2)}`);
  // in the air: momentum kept, t frozen
  const air = newAccelState(); air.vz = 6.5; air.t = C.accelerationTime;
  for (let i = 0; i < 30; i++) pbAccelStep(air, 0, 0, 6.5, 1 / 60, true, C);
  check("air: no input keeps the take-off velocity", near(air.vz, 6.5, 1e-9));
}

// ---- jump math
check("jump factor: long rest (r > 1) = 1 - Rate = 0.85", near(pbJumpFactor(10, C), 0.85));
check("jump factor: r < 0.3 = 0.55, 0.3..0.6 = 0.7, 0.6..1 = 1",
  near(pbJumpFactor(0.1, C), 0.55) && near(pbJumpFactor(0.2, C), 0.7) && near(pbJumpFactor(0.4, C), 1));
check("JumpDelay 0.06 gates a re-jump", !pbCanJump(0.03, C) && pbCanJump(0.07, C));
{
  const j = pbJumpStart(10, false, Infinity, C);
  check("normal jump: apex 0.85 m, rise 0.234 s", near(j.height, 0.85) && near(j.halfTime, 0.55 * 0.85 / 2), `${j.height} m ${j.halfTime.toFixed(4)} s`);
  check("rise: sine curve reaches the apex at halfTime", near(pbJumpRiseY(j, j.halfTime), j.height) && near(pbJumpRiseY(j, j.halfTime / 2), j.height * Math.SQRT1_2));
  const cj = pbJumpStart(10, true, Infinity, C), cj2 = pbJumpStart(10, false, 0.3, C), nj = pbJumpStart(10, false, 0.6, C);
  check("crouch jump: crouched or < ClunchJumpCheckTime after standing up", cj.crouchJump && cj2.crouchJump && !nj.crouchJump && near(cj.height, 1.15 * 0.85));
  check("fall K = JumpHeight/(JumpTime/2)^2 = 13.22", near(pbFallK(C), 1 / 0.275 ** 2, 1e-6), pbFallK(C).toFixed(3));
  check("hit slowdown: AcidPol per-part SpeedReduction all 0 -> none", ["body", "arm", "hand", "leg", "foot", "head"].every((p) => pbHitSlow(p as never, C) === null));
}

// ---- real Player on a flat floor
await RAPIER.init();
{
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(200, 0.5, 200).setTranslation(0, -0.5, 0), world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
  const down = new Set<string>(), pressed = new Set<string>();
  const input = { lookDX: 0, lookDY: 0, key: (c: string) => down.has(c), keyPressed: (c: string) => pressed.has(c) } as unknown as Input;
  const cam = new THREE.PerspectiveCamera();
  const p = new Player(world, RAPIER, cam, new THREE.Vector3(0, 0, 0), input);
  p.teleportFeet(new THREE.Vector3(0, 0, 0), 0);
  const feet = new THREE.Vector3();
  const dt = 1 / 60;
  const step = (n = 1) => { for (let i = 0; i < n; i++) { const l = p.update(dt, { move: true, look: false }); world.timestep = dt; world.step(); pressed.clear(); if (l) lastLanding = l; } };
  let lastLanding = 0;
  step(60);
  check("player settles on the floor", p.isGrounded() && Math.abs(p.getFeet(feet).y) < 0.05, `feet ${feet.y.toFixed(3)}`);
  // run forward: full speed after AccelerationTime
  down.add("KeyW"); step(15);
  check("player: RUN 6.5 m/s x MoveNormal after the ramp", Math.abs(p.speedRatio() * C.run.front - C.run.front) < 0.05, `${(p.speedRatio() * C.run.front).toFixed(2)} m/s`);
  down.delete("KeyW"); step(20);
  check("player: stops after release", p.speedRatio() === 0);
  // jump after a long rest: apex 0.85 m
  step(60);
  const base0 = p.getFeet(feet).y;
  pressed.add("Space"); down.add("Space");
  let apex = 0, frames = 0;
  step(1);
  while (!p.isGrounded() && frames < 200) { step(1); frames++; apex = Math.max(apex, p.getFeet(feet).y - base0); }
  down.delete("Space");
  const air = (frames + 1) * dt;
  check("player jump: apex = 0.85 m (JumpPenaltyRate tier r > 1)", Math.abs(apex - 0.85) < 0.03, `${apex.toFixed(3)} m`);
  const expectAir = 0.55 * 0.85 / 2 + Math.sqrt(0.85 / pbFallK(C));
  check("player jump: air time = rise + sqrt(H/K)", Math.abs(air - expectAir) < 0.05, `${air.toFixed(3)} s (exe ${expectAir.toFixed(3)} s)`);
  check("player jump: no fall damage", lastLanding === 0 || lastLanding < 1);
  // immediate re-jump is blocked by JumpDelay
  pressed.add("Space"); step(1);
  check("player: re-jump on the landing frame blocked by JumpDelay", p.isGrounded());
  // 0.4 s after landing: full height tier (1.0)
  step(Math.round(0.4 / dt) - 1);
  pressed.add("Space"); step(1);
  apex = 0; frames = 0;
  while (!p.isGrounded() && frames < 200) { step(1); frames++; apex = Math.max(apex, p.getFeet(feet).y); }
  check("player: jump 0.4 s after landing reaches the full JumpHeight 1 m", Math.abs(apex - 1) < 0.03, `${apex.toFixed(3)} m`);
  // crouch jump
  step(60);
  down.add("ControlLeft"); step(20);
  const base = p.getFeet(feet).y;
  pressed.add("Space"); step(1);
  apex = 0; frames = 0;
  while (!p.isGrounded() && frames < 200) { step(1); frames++; apex = Math.max(apex, p.getFeet(feet).y - base); }
  down.delete("ControlLeft");
  check("player: crouched jump = ClunchJumpHeight x 0.85", Math.abs(apex - 1.15 * 0.85) < 0.04 && frames > 5, `${apex.toFixed(3)} m`);
  void PB_CAPSULE;
}

// ---- grenade fuse
{
  const w = JSON.parse(fs.readFileSync(path.resolve("public/assets/cross/weapons/weapons.json"), "utf8"));
  const list = (Array.isArray(w) ? w : w.weapons ?? Object.values(w)) as { id: number; pb?: never }[];
  const k400 = list.find((x) => x.id === 407001)!;
  const params = buildParams("GRENADE", k400 as never, k400.pb);
  check("K-400 fuse = pef Explosion_Time 0.9 s", params.fuse === 0.9, `${params.fuse}`);
}

// ---- TDM rules
{
  const mk = (id: string, team: Team) => ({ id, name: id, team, alive: true, kind: "bot" } as unknown as Actor);
  const m = new Match({ mode: "TDM", killLimit: 3, timeLimit: 600, countdown: 0, respawnDelay: 5, spawnProtect: 4, endScreen: 8 });
  const r1 = mk("r1", 0), r2 = mk("r2", 0), b1 = mk("b1", 1);
  [r1, r2, b1].forEach((a) => m.addActor(a));
  m.update(0.01);
  const kill = (k: Actor | null, v: Actor) => m.registerKill({ killer: k, victim: v, weapon: "K-2", headshot: false, time: 0 });
  kill(r1, r2); kill(b1, b1); kill(null, r1);
  check("TDM: team kill / suicide / fall score nothing", m.score[0] === 0 && m.score[1] === 0 && m.rows().find((r) => r.id === "r1")!.kills === 0);
  check("TDM: every death counts", m.rows().find((r) => r.id === "r2")!.deaths === 1 && m.rows().find((r) => r.id === "b1")!.deaths === 1);
  kill(r1, b1); kill(r1, b1); kill(r1, b1);
  check("TDM: kill limit reached (>=) ends the battle, more kills wins", m.phase === "ended" && m.winner === 0);
}

console.log(fails ? `\n${fails} FAILED` : "\nall ok");
process.exitCode = fails ? 1 : 0;
