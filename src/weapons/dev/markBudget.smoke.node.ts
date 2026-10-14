// Node smoke: transient layers of Hmk_* bullet-mark effects (GlowSource etc.) stay under MAX_TRANSIENT_MARK_FX (effects.ts) during a burst.
//   npx esbuild src/weapons/dev/markBudget.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/mb.mjs && node <tmp>/mb.mjs
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import { WeaponEffects, setFxTextureLoader } from "../effects";
import { setWeaponFx } from "../sights";

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

let fails = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`);
};

const d = JSON.parse(fs.readFileSync(path.resolve("public/assets/weapons/fx/weaponfx.json"), "utf8"));
setFxTextureLoader(() => new THREE.Texture());
setWeaponFx(d, "/assets/weapons/fx");
const scene = new THREE.Scene();
const fx = new WeaponEffects(scene);
fx.setWeapon(0, "AR");
const surf = Object.keys(d.effects).filter((n) => n.startsWith("Hmk_Ar_")).map((n) => n.slice(7));
const transient = surf.filter((s) => d.effects[`Hmk_Ar_${s}`].particles.some((p: any) => p.life < 1e6 && p.type !== "decal") && d.effects[`Hmk_Ar_${s}`].particles.some((p: any) => p.life >= 1e6));
check("has a transient Hmk_Ar_* effect to test", transient.length > 0, transient.join(","));

let max = 0, shots = 0, maxMeshes = 0;
const n = new THREE.Vector3(0, 1, 0);
for (let t = 0; t < 600; t++) { // 10 s at 60 Hz, 3 shooters x 12 shots/s
  if (t % 5 === 0) for (let s = 0; s < 3; s++, shots++)
    fx.impact(new THREE.Vector3(Math.random() * 10, 0, Math.random() * 10), n, true, transient[shots % transient.length], new THREE.Vector3(0, -1, 0));
  fx.update(1 / 60);
  max = Math.max(max, fx.transientMarkCount);
  let m = 0; scene.traverse((o) => { if ((o as any).isMesh) m++; }); maxMeshes = Math.max(maxMeshes, m);
}
check("transient Hmk_* alive never above the ceiling and reached it", max <= 40 && max >= 30, `max ${max} after ${shots} impacts`);
// instant burst, no update in between
for (let i = 0; i < 500; i++) fx.impact(new THREE.Vector3(i, 0, 0), n, true, transient[0], new THREE.Vector3(0, -1, 0));
check("500 impacts in one frame stay <= 40", fx.transientMarkCount <= 40, `${fx.transientMarkCount}`);
check("burst really draws quads (not vacuous)", maxMeshes > 0, `peak meshes ${maxMeshes}`);
console.log(fails ? `${fails} FAIL` : "all ok");
process.exit(fails ? 1 : 0);
