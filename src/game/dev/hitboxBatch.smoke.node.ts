// Node smoke: HitColliders.sync's batched refresh (visual root updateWorldMatrix(true, true) once + boneHitboxWorld(..., false))
// gives the SAME hitbox transforms as the old per-hitbox updateWorldMatrix(true, false), on a posed real character skeleton.
//
//   npx esbuild src/game/dev/hitboxBatch.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/hbb.mjs && node <tmp>/hbb.mjs
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import { boneHitboxWorld, getBoneHitboxes } from "../charModel";

interface GlbNode { name?: string; translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[]; children?: number[] }
function parseGLB(buf: Buffer): { nodes: GlbNode[]; roots: number[] } {
  let off = 12, json: { nodes?: GlbNode[]; scenes?: { nodes: number[] }[] } | null = null;
  while (off < buf.readUInt32LE(8)) {
    const clen = buf.readUInt32LE(off);
    if (buf.readUInt32LE(off + 4) === 0x4e4f534a) json = JSON.parse(buf.subarray(off + 8, off + 8 + clen).toString("utf8"));
    off += 8 + clen;
  }
  return { nodes: json?.nodes ?? [], roots: json?.scenes?.[0]?.nodes ?? [] };
}
function build(nodes: GlbNode[], i: number): THREE.Object3D {
  const n = nodes[i], o = new THREE.Object3D();
  o.name = n.name ?? `node${i}`;
  if (n.matrix) new THREE.Matrix4().fromArray(n.matrix).decompose(o.position, o.quaternion, o.scale);
  else { if (n.translation) o.position.fromArray(n.translation); if (n.rotation) o.quaternion.fromArray(n.rotation); if (n.scale) o.scale.fromArray(n.scale); }
  for (const c of n.children ?? []) o.add(build(nodes, c));
  return o;
}

const PUB = path.resolve("public");
const entry = JSON.parse(fs.readFileSync(path.join(PUB, "assets/chars/index.json"), "utf8")).chars[0] as { model: string; hitboxes: unknown[] };
const { nodes, roots } = parseGLB(fs.readFileSync(path.join(PUB, "assets/chars", entry.model)));
const scene = new THREE.Group();
for (const r of roots) scene.add(build(nodes, r));
scene.userData.hitboxDefs = entry.hitboxes;
const actor = new THREE.Group(); // like CharVisual.root: moved / rotated every frame
actor.add(scene);
const hbs = getBoneHitboxes(actor);

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5;
let fails = 0, worst = 0;
for (let frame = 0; frame < 50; frame++) {
  actor.position.set(rnd() * 50, rnd() * 5, rnd() * 50);
  actor.rotation.y = rnd() * 6;
  actor.traverse((o) => { if (o !== actor && o.name) { o.rotation.x += rnd() * 0.3; o.rotation.z += rnd() * 0.3; } });
  const a = hbs.map(() => ({ c: new THREE.Vector3(), q: new THREE.Quaternion() }));
  for (let i = 0; i < hbs.length; i++) boneHitboxWorld(hbs[i], a[i].c, a[i].q); // old path
  actor.traverse((o) => o.matrixWorld.identity()); // forget the old result
  actor.updateWorldMatrix(true, true); // new path: once
  for (let i = 0; i < hbs.length; i++) {
    const c = new THREE.Vector3(), q = new THREE.Quaternion();
    boneHitboxWorld(hbs[i], c, q, undefined, false);
    worst = Math.max(worst, c.distanceTo(a[i].c), Math.abs(q.x - a[i].q.x) + Math.abs(q.y - a[i].q.y) + Math.abs(q.z - a[i].q.z) + Math.abs(q.w - a[i].q.w));
  }
}
const ok = hbs.length === 20 && worst === 0;
if (!ok) fails++;
console.log(`${ok ? "ok  " : "FAIL"} ${hbs.length} hitboxes x 50 poses: max centre/quat difference ${worst}`);
process.exit(fails ? 1 : 0);
