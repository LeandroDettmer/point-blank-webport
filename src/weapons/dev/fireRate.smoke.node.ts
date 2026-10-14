// Node smoke test: measured rate of fire of the real WeaponSystem vs 1 / FireDelay (exe cadence 0x9d0910).
//   npx esbuild src/weapons/dev/fireRate.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/fr.mjs && node <tmp>/fr.mjs
// Auto: trigger held 4 s. Semi / bolt / pump: a click every other frame (fastest possible clicking). Ammo is topped up
// every frame so reloads never interrupt. Expected: auto -> 1/(FireDelay + 1 frame) (remainder carried 0x9d0bb9, plus the
// idle-state frame 0x9d0240 that adds no dt); click-per-shot -> floor(delay*hz) + 2 frames per shot.
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { WeaponSystem } from "../WeaponSystem";
import type { SlotIndex } from "../types";

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

// AUG A3, K-2, AK-47, P90 MC, P90 Ext, Kriss S.V, MP5K, Ultimax-100, CheyTac, 870MCS, Colt45, Desert Eagle, Taurus 454SS Scope Cobra (semi + NeedToLoadBullet, no LoadBulletTime: LoadBullet clip 0.7667 gates spam clicks)
const IDS = [103028, 103004, 103002, 104010, 104011, 104012, 104001, 110011, 105030, 106001, 202022, 202001, 202073];

(async () => {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 300);
  scene.add(camera);
  const ws = new WeaponSystem({ scene, camera, world, RAPIER, viewmodel: false, audioListener: any, resolveTarget: () => null, loadout: {} });
  await ws.ready;
  const shots: number[] = [];
  let t = 0;
  ws.onFire((e) => { if (e.kind === "bullet") shots.push(t); });
  const W = ws as any;
  const rows: string[] = ["| weapon | mode | FireDelay | expected /s @60 | measured @60 | expected /s @144 | measured @144 |", "|---|---|---|---|---|---|---|"];
  for (const id of IDS) {
    const def = ws.db.def(id);
    if (!def) { check(`def ${id}`, false, "missing"); continue; }
    const cells: string[] = [];
    for (const hz of [60, 144]) {
      ws.equip(id);
      const slot = (Math.min(4, Math.max(1, def.slot)) - 1) as SlotIndex;
      const dt = 1 / hz;
      const step = (fire: boolean) => {
        const s = W.slots[slot];
        if (s) { s.ammo = def.loadedBullet; s.reserve = 999; }
        ws.update(dt, { fire, aim: false, grounded: true, slot: slot === W.cur ? null : slot });
        t += dt;
      };
      for (let i = 0; i < hz * 2; i++) step(false); // draw + settle
      shots.length = 0;
      const hold = def.fireMode === "auto";
      const frames = Math.round(hz * 4);
      for (let i = 0; i < frames; i++) step(hold ? true : i % 2 === 0);
      for (let i = 0; i < hz; i++) step(false);
      const rate = shots.length > 1 ? (shots.length - 1) / (shots[shots.length - 1] - shots[0]) : 0;
      const delay = Math.min(3, Math.max(0.06, def.fireDelay));
      // bolt / pump: the LoadBullet cycle (max(FireDelay, LoadBulletTime)) gates the next shot (nextFire)
      const cycle = def.params.loadBulletTime !== undefined ? Math.max(delay, def.params.loadBulletTime) : delay;
      // frames between shots: the shot frame starts the timer at dt, it ends the Fire state on the first frame with
      // timer > delay (strict), the idle frame after it adds no dt and the shot lands on the next one (0x9d0910 / 0x9d0240).
      // The LoadBullet gate is time >= nextFire; a press can only land on an even frame.
      let expClick = def.params.loadBulletTime !== undefined ? hz / (2 * Math.ceil(Math.ceil(cycle * hz - 1e-6) / 2))
        : hz / (Math.floor(cycle * hz + 1e-9) + 2);
      // held auto: the remainder is carried, so one shot every delay + the idle frame
      if (hold) expClick = 1 / (delay + 1 / hz);
      cells.push(expClick.toFixed(2), rate.toFixed(2));
      check(`${def.name} @${hz} Hz`, Math.abs(rate - expClick) / expClick < 0.03, `${rate.toFixed(2)}/s vs ${expClick.toFixed(2)} (1/FireDelay ${(1 / def.fireDelay).toFixed(2)})`);
    }
    rows.push(`| ${def.name} (${id}) | ${def.fireMode} | ${def.fireDelay}${def.params.loadBulletTime !== undefined ? ` (LoadBullet ${def.params.loadBulletTime})` : ""} | ${cells[0]} | ${cells[1]} | ${cells[2]} | ${cells[3]} |`);
  }
  console.log(rows.join("\n"));
  console.log(fails ? `\n${fails} FAILED` : "\nall ok");
  process.exit(fails ? 1 : 0);
})();
