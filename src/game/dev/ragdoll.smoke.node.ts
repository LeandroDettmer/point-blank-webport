// Node smoke test: death ragdoll (game/ragdoll.ts) on a real character skeleton (chars/swat_male/model.glb + ragdoll.json from
// pb-extract-tools export-ragdoll.mjs): 20 bodies / 19 joints, the shot pushes along the bullet (ByDefault 0x572340 velocity), joints
// hold, the body lands on the floor without NaN, a blast throws it up (0x571eb0), release puts the bones back.
//   npx esbuild src/game/dev/ragdoll.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/rd.mjs && node <tmp>/rd.mjs
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { RagdollSystem, type DeathHit } from "../ragdoll";

let fails = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`);
};

const CHAR = path.resolve("public/assets/chars/swat_male");
const rd = JSON.parse(fs.readFileSync(path.join(CHAR, "ragdoll.json"), "utf8"));

/** the GLB's node tree as three objects (skin joints = Bones) + an object holding the Skeleton, like GLTFLoader */
function loadSkeleton(): THREE.Object3D {
  const b = fs.readFileSync(path.join(CHAR, "model.glb"));
  const jl = b.readUInt32LE(12);
  const J = JSON.parse(b.toString("utf8", 20, 20 + jl));
  const bin = b.subarray(20 + jl + 8);
  const skin = J.skins[0];
  const joints = new Set<number>(skin.joints);
  const objs = J.nodes.map((n: any, i: number) => {
    const o = joints.has(i) ? new THREE.Bone() : new THREE.Object3D();
    o.name = n.name ?? "";
    if (n.matrix) new THREE.Matrix4().fromArray(n.matrix).decompose(o.position, o.quaternion, o.scale);
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    return o;
  });
  J.nodes.forEach((n: any, i: number) => (n.children ?? []).forEach((c: number) => objs[i].add(objs[c])));
  const root = new THREE.Group();
  for (const i of J.scenes[0].nodes) root.add(objs[i]);
  const acc = J.accessors[skin.inverseBindMatrices], view = J.bufferViews[acc.bufferView];
  const f = new Float32Array(bin.buffer, bin.byteOffset + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0), acc.count * 16);
  const inv = skin.joints.map((_: number, k: number) => new THREE.Matrix4().fromArray(f, k * 16));
  const holder = new THREE.Object3D() as THREE.Object3D & { skeleton: THREE.Skeleton };
  holder.skeleton = new THREE.Skeleton(skin.joints.map((j: number) => objs[j]), inv);
  root.add(holder);
  return root;
}

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = 1 / 60;
world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.5, 50).setTranslation(0, -0.5, 0)); // floor at y 0
const sys = new RagdollSystem(world, RAPIER);

const wp = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
const run = (s: number) => { for (let i = 0; i < s * 60; i++) { world.step(); sys.update(); } };

// ---- 1. shot in the chest from the front (bullet travelling -Z), AK-47-like: Damage 35, ASSAULT (class 3)
const model = loadSkeleton();
model.updateMatrixWorld(true);
const bone = (n: string) => model.getObjectByName(n)!;
const restSpine = bone("Spine2").quaternion.clone();
const chest = wp(bone("Spine2"));
const root0 = wp(bone("Root"));
check("bind pose stands", wp(bone("Head")).y > 1.3, `head y ${wp(bone("Head")).y.toFixed(2)}`);
const hit: DeathHit = { dir: new THREE.Vector3(0, 0, -1), point: chest.clone(), head: false, damage: 35, classType: 3, explosion: false };
const r = sys.spawn(model, rd, hit)!;
check("20 bodies, 19 joints", r?.parts.length === 20 && world.impulseJoints.len() === 19, `${r?.parts.length} / ${world.impulseJoints.len()}`);
const sp2 = r.parts.find((p) => p.def.bone === "Spine2")!;
const v0 = sp2.body.linvel();
// F = (35 * 0.77 * 0.3 + 35 * 0.1 + 30) * 3.8; v = F * LinearForce 0.32 * SimTime 1.2
const want = (35 * 0.77 * 0.3 + 35 * 0.1 + 30) * 3.8 * 0.32 * 1.2;
check("hit body velocity = exe ByDefault", Math.abs(Math.hypot(v0.x, v0.y, v0.z) - want) < 0.05 && v0.z < 0, `${Math.hypot(v0.x, v0.y, v0.z).toFixed(2)} vs ${want.toFixed(2)}`);
const sp1 = r.parts.find((p) => p.def.bone === "Spine1")!.body.linvel();
check("parent gets half (0x571e20)", Math.abs(sp1.z - v0.z / 2) < 2, `${sp1.z.toFixed(2)} vs ${(v0.z / 2).toFixed(2)}`);
run(4);
const pts = r.parts.map((p) => wp(p.bone));
check("no NaN", pts.every((p) => Number.isFinite(p.x + p.y + p.z)));
// joints hold: the child bone's origin stays at the parent's anchor
let worst = 0;
for (const p of r.parts) {
  const j = p.def.joint;
  if (!j) continue;
  const par = bone(p.def.parent!);
  const a = new THREE.Vector3(...j.anchor[0]).applyMatrix4(par.matrixWorld);
  worst = Math.max(worst, a.distanceTo(wp(p.bone)));
}
check("joints hold (< 5 cm)", worst < 0.05, `worst ${worst.toFixed(3)} m`);
const head = wp(bone("Head"));
check("lies on the floor", head.y < 0.6 && Math.min(...pts.map((p) => p.y)) > -0.15, `head y ${head.y.toFixed(2)}, lowest ${Math.min(...pts.map((p) => p.y)).toFixed(2)}`);
const moved = root0.z - wp(bone("Root")).z;
check("pushed along the bullet", moved > 0.2, `root moved ${moved.toFixed(2)} m along -Z`);
run(4);
check("comes to rest (sleeps)", r.parts.every((p) => p.body.isSleeping()), `${r.parts.filter((p) => p.body.isSleeping()).length}/20 asleep`);
const nBodies = world.bodies.len();
sys.release(r);
check("release removes the bodies", world.bodies.len() === nBodies - 20 && world.impulseJoints.len() === 0, `${world.bodies.len()} bodies, ${world.impulseJoints.len()} joints`);
check("release puts the death pose back", bone("Spine2").quaternion.angleTo(restSpine) < 1e-4);

// ---- 2. grenade blast from the side: thrown up and away (0x571eb0: dir * 3 + up 3 * 1.4)
const m2 = loadSkeleton();
m2.position.set(5, 0, 0);
m2.updateMatrixWorld(true);
const r2 = sys.spawn(m2, rd, { dir: new THREE.Vector3(1, 0, 0), point: new THREE.Vector3(5, 1, 0), head: false, damage: 100, classType: 7, explosion: true })!;
const rv = r2.parts.find((p) => p.def.part === 1)!.body.linvel();
check("blast: root up and away, x1.7", Math.abs(rv.y - 3 * 1.4 * 1.7 * 1.2) < 0.01 && Math.abs(rv.x - 3 * 1.7 * 1.2) < 0.01, `v (${rv.x.toFixed(2)}, ${rv.y.toFixed(2)})`);
run(3);
const pts2 = r2.parts.map((p) => wp(p.bone));
check("blast: lands, no NaN", pts2.every((p) => Number.isFinite(p.y) && p.y > -0.15) && wp(m2.getObjectByName("Root")!).x > 5.3, `root x ${wp(m2.getObjectByName("Root")!).x.toFixed(2)}`);

// ---- 3. cap: one per slot (16), the oldest is let go
for (let i = 0; i < 16; i++) { const m = loadSkeleton(); m.position.set(-5, 0, i * 2); m.updateMatrixWorld(true); sys.spawn(m, rd, null); }
check("at most 16 ragdolls", sys.count === 16, `${sys.count}`);
sys.clear();
check("clear frees the world", world.bodies.len() === 0, `${world.bodies.len()} bodies left`);

console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
