// Node smoke test: Clube da Luta bare fist (BAREFIST_ID 323001). The original has no fist model (Weapon_Barefist_Knuckle
// Hull01 is empty), so the 1PV arms must stay up and swing on their own; before the fix setWeapon hid the rig when the
// model came back null. Real WeaponSystem + Viewmodel; the arms GLB is a fake rig (hand dummy + one clip), no weapon GLB.
//   npx esbuild src/weapons/dev/barefistArms.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/ba.mjs && node <tmp>/ba.mjs
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { WeaponSystem } from "../WeaponSystem";
import { BAREFIST_ID } from "../../game/respawnSelect";

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
g.location = { search: "" };
const PUB = path.resolve("public");
g.fetch = async (url: string) => {
  const p = path.join(PUB, String(url).replace(/^\//, ""));
  if (!fs.existsSync(p)) return new Response("", { status: 404 });
  return new Response(fs.readFileSync(p), { headers: { "content-type": url.endsWith(".json") ? "application/json" : "application/octet-stream" } });
};

// arms GLB: fake rig (hand dummy + one clip); weapon GLBs fail (the fist has none anyway)
GLTFLoader.prototype.loadAsync = function (url: string) {
  return new Promise((resolve, reject) => {
    if (!url.endsWith("arms_1pv.glb")) return reject(new Error("no weapon model in the smoke"));
    const scene = new THREE.Group();
    const hand = new THREE.Object3D();
    hand.name = "WeaponPointDummyRight";
    scene.add(hand);
    resolve({ scene, animations: [new THREE.AnimationClip("assault/Idle", 1, [])] } as never);
  });
} as never;
const flush = () => new Promise((r) => setTimeout(r, 20));

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
  const ws = new WeaponSystem({ scene, camera, world, RAPIER, audioListener: any, resolveTarget: () => null, loadout: {} });
  await ws.ready;
  const vm = ws.viewmodel as unknown as { rig: { root: THREE.Object3D } | null; rigActive: boolean; rigWeapon: THREE.Object3D | null };
  await flush();

  const fist = ws.db.def(BAREFIST_ID);
  check("fixture: 323001 is the melee fist (KNIFE family, no two-hand)", !!fist && fist.family === "KNIFE" && fist.id === BAREFIST_ID, JSON.stringify({ family: fist?.family, id: fist?.id }));
  ws.observe({ id: BAREFIST_ID, team: 1 });
  await flush();
  await flush();
  check("arms rig built", !!vm.rig);
  check("bare fist: arms visible, rig active", !!vm.rig && vm.rig.root.visible === true && vm.rigActive === true, `visible ${vm.rig?.root.visible} active ${vm.rigActive}`);
  check("bare fist: no weapon object in the hand", vm.rigWeapon === null, String(vm.rigWeapon?.name));

  console.log(fails ? `\n${fails} FAILED` : "\nall ok");
  process.exit(fails ? 1 : 0);
})();
