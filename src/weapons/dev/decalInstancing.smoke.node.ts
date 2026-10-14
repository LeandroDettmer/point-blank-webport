// Node smoke: frozen bullet holes are drawn instanced (1 mesh per look, not per hole) and eviction keeps <= MAX_DECAL_FX.
//   npx esbuild src/weapons/dev/decalInstancing.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/di.mjs && node <tmp>/di.mjs
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
const n = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3(0, -1, 0);
const surf = Object.keys(d.effects).filter((k) => k.startsWith("Hmk_Ar_") && d.effects[k].particles.some((p: any) => p.life >= 1e6)).map((k) => k.slice(7));
check("has persistent Hmk_Ar_*", surf.length > 0, surf.join(","));
const s = surf.includes("Cm") ? "Cm" : surf[0];
const meshes = () => { let m = 0; scene.traverse((o) => { if ((o as any).isMesh) m++; }); return m; };
let inst = 0; const countInst = () => { inst = 0; scene.traverse((o) => { if ((o as any).isInstancedMesh) inst += (o as THREE.InstancedMesh).count; }); return inst; };

for (let i = 0; i < 40; i++) fx.impact(new THREE.Vector3(i, 0, 0), n, true, s, dir);
for (let t = 0; t < 120; t++) fx.update(1 / 60); // 2 s: flash layers still alive, holes already baked
const holes = countInst();
check("holes baked into instances", holes > 0, `${holes} instances in ${fx.decalMeshCount} batch meshes`);
check("40 holes -> far fewer drawable meshes than holes", fx.decalMeshCount > 0 && fx.decalMeshCount < 10, `${fx.decalMeshCount} meshes`);
check("scene mesh total small", meshes() < 40, `${meshes()} meshes`);

for (let i = 0; i < 500; i++) { fx.impact(new THREE.Vector3(i, 0, 5), n, true, s, dir); if (i % 10 === 0) fx.update(1 / 60); }
for (let t = 0; t < 120; t++) fx.update(1 / 60);
const perHole = holes / 40;
check("eviction: instances <= MAX_DECAL_FX * layers", countInst() <= 96 * Math.ceil(perHole), `${countInst()} instances, ${perHole}/hole`);
check("still few meshes after churn", fx.decalMeshCount < 20, `${fx.decalMeshCount}`);
console.log(fails ? `${fails} FAIL` : "all ok");
process.exit(fails ? 1 : 0);
