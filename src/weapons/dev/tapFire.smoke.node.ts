// Node smoke test: bullets per single mouse click (held for N ms) of the real WeaponSystem, per refresh rate.
//   npx esbuild src/weapons/dev/tapFire.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/tf.mjs --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);" && cp <tmp>/tf.mjs ./.tf.tmp.mjs && node ./.tf.tmp.mjs
// (extensionless imports: plain --experimental-transform-types fails, same as fireRate.smoke)
// Input mirrors game.ts:1995 (fire = button held at frame time). A click shorter than one frame never reaches update()
// (Input.mouse add+delete between two frames), so a frame count of 0 is reported as "lost".
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

// K-2 (auto), AK-47 (auto), Colt45 (semi), Desert Eagle (semi), MP5K (auto)
const IDS = [103004, 103002, 202022, 202001, 104012];
const HZ = [60, 144, 240];
const MS = [50, 80, 100, 130, 160];
let fails = 0;

(async () => {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 300);
  scene.add(camera);
  const ws = new WeaponSystem({ scene, camera, world, RAPIER, viewmodel: false, audioListener: any, resolveTarget: () => null, loadout: {} });
  await ws.ready;
  let n = 0;
  ws.onFire((e) => { if (e.kind === "bullet") n++; });
  const W = ws as any;
  const rows = ["| weapon | mode | delay | Hz | " + MS.map((m) => m + "ms").join(" | ") + " |", "|---|---|---|---|" + MS.map(() => "---").join("|") + "|"];
  for (const id of IDS) {
    const def = ws.db.def(id);
    if (!def) { console.log(`FAIL def ${id} missing`); fails++; continue; }
    const slot = (Math.min(4, Math.max(1, def.slot)) - 1) as SlotIndex;
    const delay = Math.min(3, Math.max(0.06, def.fireDelay));
    for (const hz of HZ) {
      const dt = 1 / hz;
      ws.equip(id);
      const step = (fire: boolean) => {
        const s = W.slots[slot];
        if (s) { s.ammo = def.loadedBullet; s.reserve = 999; }
        ws.update(dt, { fire, aim: false, grounded: true, slot: slot === W.cur ? null : slot });
      };
      for (let i = 0; i < hz * 2; i++) step(false);
      const cells: string[] = [];
      for (const ms of MS) {
        const frames = Math.round((ms / 1000) * hz); // frames the button is seen down
        n = 0;
        for (let i = 0; i < frames; i++) step(true);
        for (let i = 0; i < hz; i++) step(false); // release + settle 1 s
        cells.push(String(n));
        // sanity: semi never gives 2 bullets for one held press
        if (def.fireMode !== "auto" && n > 1) { fails++; console.log(`FAIL ${def.name} ${hz}Hz ${ms}ms: ${n} bullets, semi`); }
      }
      rows.push(`| ${def.name} | ${def.fireMode} | ${delay.toFixed(4)} | ${hz} | ${cells.join(" | ")} |`);
    }
  }
  console.log(rows.join("\n"));
  console.log(fails ? `\n${fails} FAILED` : "\nall ok");
  process.exit(fails ? 1 : 0);
})();
