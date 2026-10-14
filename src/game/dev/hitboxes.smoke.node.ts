// Node smoke test for per-bone hitboxes (charModel.getBoneHitboxes / boneHitboxWorld), no browser.
// Builds the bone hierarchy straight from a real character GLB's glTF node graph (translation/rotation/
// scale + extras only, no mesh/skin/texture parsing needed), tags it with the same hitboxDefs the game
// reads from public/assets/chars/index.json, then casts a ray straight down through the head bone and
// checks the closest OBB hit is the "head" zone.
//
//   npx esbuild src/game/dev/hitboxes.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/hb.mjs && node <tmp>/hb.mjs
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import { boneHitboxWorld, getBoneHitboxes } from "../charModel";

let fails = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`);
};

interface GlbNode {
  name?: string;
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  matrix?: number[];
  children?: number[];
}

function parseGLB(buf: Buffer): { nodes: GlbNode[]; sceneRoots: number[] } {
  const length = buf.readUInt32LE(8);
  let off = 12;
  let json: { nodes?: GlbNode[]; scenes?: { nodes: number[] }[] } | null = null;
  while (off < length) {
    const clen = buf.readUInt32LE(off);
    const ctype = buf.readUInt32LE(off + 4);
    if (ctype === 0x4e4f534a) json = JSON.parse(buf.subarray(off + 8, off + 8 + clen).toString("utf8"));
    off += 8 + clen;
  }
  if (!json) throw new Error("GLB has no JSON chunk");
  return { nodes: json.nodes ?? [], sceneRoots: json.scenes?.[0]?.nodes ?? [] };
}

function buildNode(nodes: GlbNode[], idx: number): THREE.Object3D {
  const n = nodes[idx];
  const o = new THREE.Object3D();
  o.name = n.name ?? `node${idx}`;
  if (n.matrix) {
    new THREE.Matrix4().fromArray(n.matrix).decompose(o.position, o.quaternion, o.scale);
  } else {
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
  }
  for (const c of n.children ?? []) o.add(buildNode(nodes, c));
  return o;
}

/** Ray/OBB slab test in the box's local frame; returns the entry distance or null. */
function rayVsOBB(origin: THREE.Vector3, dir: THREE.Vector3, center: THREE.Vector3, quat: THREE.Quaternion, half: THREE.Vector3): number | null {
  const inv = quat.clone().invert();
  const lo = origin.clone().sub(center).applyQuaternion(inv);
  const ld = dir.clone().applyQuaternion(inv);
  let tmin = -Infinity, tmax = Infinity;
  for (const axis of ["x", "y", "z"] as const) {
    const o = lo[axis], d = ld[axis], h = half[axis];
    if (Math.abs(d) < 1e-9) {
      if (o < -h || o > h) return null;
      continue;
    }
    let t1 = (-h - o) / d, t2 = (h - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin >= 0 ? tmin : tmax >= 0 ? tmax : null;
}

const PUB = path.resolve("public");
const manifest = JSON.parse(fs.readFileSync(path.join(PUB, "assets/chars/index.json"), "utf8"));
const entry = manifest.chars[0] as { name: string; model: string; hitboxes: unknown[] };
check("manifest has 20 hitbox defs", Array.isArray(entry.hitboxes) && entry.hitboxes.length === 20, String(entry.hitboxes?.length));

const buf = fs.readFileSync(path.join(PUB, "assets/chars", entry.model));
const { nodes, sceneRoots } = parseGLB(buf);
const scene = new THREE.Group();
for (const r of sceneRoots) scene.add(buildNode(nodes, r));
scene.userData.hitboxDefs = entry.hitboxes;
scene.updateMatrixWorld(true);

const hbs = getBoneHitboxes(scene);
check(`getBoneHitboxes resolves all ${entry.hitboxes.length} bones`, hbs.length === entry.hitboxes.length, String(hbs.length));
const head = hbs.find((h) => h.zone === "head");
check("a head-zone hitbox exists", !!head, JSON.stringify(hbs.map((h) => h.zone)));

if (head) {
  const c = new THREE.Vector3(), q = new THREE.Quaternion(), half = new THREE.Vector3();
  boneHitboxWorld(head, c, q, half);
  check("head sits well above the feet (y > 1.4m)", c.y > 1.4, c.y.toFixed(3));

  // Ray straight down through the head box center; closest OBB along it should be the head.
  const origin = c.clone().setY(c.y + 2);
  const dir = new THREE.Vector3(0, -1, 0);
  let best: { zone: string; t: number } | null = null;
  const c2 = new THREE.Vector3(), q2 = new THREE.Quaternion(), half2 = new THREE.Vector3();
  for (const hb of hbs) {
    boneHitboxWorld(hb, c2, q2, half2);
    const t = rayVsOBB(origin, dir, c2, q2, half2);
    if (t !== null && (!best || t < best.t)) best = { zone: hb.zone, t };
  }
  check("ray through the head returns zone head", best?.zone === "head", JSON.stringify(best));
}

console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
