// Node smoke test: Q (last weapon), QQ bolt cancel and quick scope on the real WeaponSystem (no browser).
//   npx esbuild src/weapons/dev/qqQuickScope.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/qq.mjs && node <tmp>/qq.mjs
// Exe rules:
//   Q = Cmd_ChangeWeapon(last slot) (ProcessWeapon 0xa23639); the last slot is the current one at every swap (0xa13620).
//   A swap drops a pending / running LoadBullet (flag 0x80000 cleared at 0xa1383c): shot -> Q -> Q -> fire after Change.
//   Zoom is dropped by the swap (0x78a930 -> _Idle_Camera) and has to be pressed again.
//   Quick scope: RMB sets chara state 9 at once; the bullets use the crosshair value b0 at the shot (0x7e8400), which moves
//   to the zoomed posture target over ContractTime * SpeedFactor (sin ease, 0x7e8100), or at once on a FastZoom weapon's
//   fresh zoom (weapon +0x668, 0x6150c0). The 0.15 s FOV tween does not enter the spread.
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { WeaponSystem } from "../WeaponSystem";
import type { WeaponInput } from "../types";

const any: any = new Proxy(function () {}, {
  get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : k === "then" ? undefined : any),
  apply: () => any,
  construct: () => any,
  set: () => true,
});
const g = globalThis as any;
g.document = any;
g.window = any;
g.AudioContext = any;
g.innerWidth = 1600;
g.innerHeight = 900;
g.Image = any;
const PUB = path.resolve("public");
g.fetch = async (url: string) => {
  const p = path.join(PUB, url.replace(/^\//, ""));
  if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  const buf = fs.readFileSync(p);
  return { ok: true, status: 200, json: async () => JSON.parse(buf.toString("utf8")), arrayBuffer: async () => buf.buffer };
};

let fails = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`);
};

(async () => {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 300);
  scene.add(camera);
  const HZ = 60, dt = 1 / HZ;
  const mk = async (primary: number) => {
    const ws = new WeaponSystem({ scene, camera, world, RAPIER, viewmodel: false, audioListener: any, resolveTarget: () => null,
      loadout: { primary, secondary: 202022 }, applyLook: () => {} });
    await ws.ready;
    ws.rng = () => 0.5;
    let t = 0;
    const shots: number[] = [];
    ws.onFire((e) => { if (e.kind === "bullet") shots.push(t); });
    const W = ws as any;
    const step = (inp: Partial<WeaponInput> = {}) => {
      for (const s of W.slots) if (s && s.def.family !== "KNIFE" && s.def.family !== "GRENADE") s.reserve = 99;
      ws.update(dt, { fire: false, aim: false, grounded: true, speed: 0, ...inp });
      t += dt;
    };
    for (let i = 0; i < HZ * 2; i++) step(); // initial draw + settle
    return { ws, W, step, shots, now: () => t };
  };
  const frames = (s: number) => Math.round(s * HZ);

  // ---- Q: last weapon -------------------------------------------------------
  {
    const { W, step } = await mk(105030);
    check("start on the primary", W.cur === 0);
    step({ slot: 1 });
    for (let i = 0; i < frames(1); i++) step();
    check("1 -> 2: on the pistol", W.cur === 1);
    step({ lastWeapon: true });
    check("Q -> back to the primary (last slot)", W.cur === 0);
    step({ lastWeapon: true });
    check("Q again -> pistol (the last slot follows every swap)", W.cur === 1);
  }

  // ---- QQ: time from a CheyTac shot to the next one ---------------------------
  const lines: string[] = [];
  const shotToShot = async (label: string, plan: (step: (i?: Partial<WeaponInput>) => void) => void) => {
    const { step, shots, now, W } = await mk(105030);
    const def = W.slots[0].def;
    step({ fire: true });
    step();
    const t0 = shots[0];
    plan(step);
    let k = 0;
    while (shots.length < 2 && k++ < frames(4)) step({ fire: k % 2 === 1 }); // fastest clicking
    const gap = shots[1] - t0;
    lines.push(`${label}: shot -> next shot ${(gap * 1000).toFixed(0)} ms, zoom after ${W.zoomOn ? "on" : "off"}`);
    return { gap, def, now };
  };
  const plain = await shotToShot("no QQ (bolt LoadBullet)", () => {});
  const qq = await shotToShot("QQ (Q +1 frame, Q +3 frames)", (step) => { step({ lastWeapon: true }); step(); step({ lastWeapon: true }); });
  const qqLate = await shotToShot("QQ late (Q +1 frame, Q after the pistol drew, +0.75 s)", (step) => {
    step({ lastWeapon: true });
    for (let i = 0; i < frames(0.75); i++) step();
    step({ lastWeapon: true });
  });
  console.log(lines.join("\n"));
  const lbt = plain.def.params.loadBulletTime!, chg = plain.def.params.changeTime;
  check("no QQ: next shot after LoadBulletTime", Math.abs(plain.gap - lbt) <= 2 * dt + 1e-6, `${plain.gap.toFixed(3)} vs ${lbt}`);
  check("QQ: next shot after ~3 frames + the sniper Change (bolt dropped)", Math.abs(qq.gap - (3 * dt + chg)) <= 3 * dt + 1e-6,
    `${qq.gap.toFixed(3)} vs ${(3 * dt + chg).toFixed(3)} (Change ${chg})`);
  check("QQ beats the bolt", qq.gap < plain.gap, `${(plain.gap - qq.gap).toFixed(3)} s saved`);
  check("late QQ: pistol draw time is spent too", qqLate.gap > qq.gap);

  // ---- quick scope: spread of the bullet vs time since RMB ---------------------
  const qs = async (id: number, label: string, fresh: boolean) => {
    const out: string[] = [];
    for (const d of [0, 1 / HZ, 0.05, 0.1, 0.15, 0.3, 0.6]) {
      const { ws, W, step } = await mk(id);
      if (!fresh) { // a zoomed shot less than 1 s ago: weapon +0x66c < 1 -> no FastZoom flag
        step({ aim: true }); for (let i = 0; i < frames(0.6); i++) step();
        step({ fire: true }); step();
        // RMB steps the scope levels (0x78bdb0) until it turns the zoom off
        for (let k = 0; k < 4 && W.zoomOn; k++) { step({ aim: true }); step(); }
        for (let i = 0; i < frames(0.5); i++) step(); // FireDelay passes, the crosshair expands back; 0x66c stays < 1 s
      }
      ws.trace = [];
      const nd = Math.round(d * HZ);
      if (nd === 0) step({ aim: true, fire: true });
      else { step({ aim: true }); for (let i = 1; i < nd; i++) step(); step({ fire: true }); }
      const tr = ws.trace![0];
      out.push(`${(d * 1000).toFixed(0).padStart(3)} ms: dev ${tr ? tr.dev.toFixed(3) : "-"}°`);
      if (d === 0.6) { const c = W.slots[0].def.params.spread.cross; out.push(`  (unzoomed target ${(c.min + c.min * c.stand + c.noZoom).toFixed(3)}°, zoomed ${(c.min + c.min * c.stand + c.min * c.zoom).toFixed(3)}°, ContractTime*SpeedFactor ${(c.contractTime * c.speedFactor).toFixed(3)} s, FastZoom ${W.slots[0].def.pb?.fastZoom ? 1 : 0})`); }
    }
    console.log(`QS ${label}:\n  ` + out.join("\n  "));
    return out;
  };
  await qs(105030, "CheyTac (no FastZoom)", true);
  await qs(105002, "HK-PSG1 (FastZoom), fresh zoom", true);
  await qs(105002, "HK-PSG1 (FastZoom), zoomed shot < 1 s before", false);

  console.log(fails ? `\n${fails} FAILED` : "\nall ok");
  process.exit(fails ? 1 : 0);
})();
