// Node smoke: merging the map shapes into one collider per surface + terrain (src/mapCollision.ts) keeps every raycast hit:
// distance, normal, surface code, terrain entry, original shape and front/back side (hitSide), against one collider per shape.
// Real collision.glb + surfaces.json of each map given (default helispot breedingnest airport tutorial); skips maps not on disk.
//   npx esbuild src/weapons/dev/mapMerge.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/mm.mjs && node <tmp>/mm.mjs [map ...]
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import RAPIER from "@dimforge/rapier3d-compat";
import { buildStaticColliders, type StaticShape } from "../../mapCollision";
import {
  clearColliderShapes, hitShapeId, hitSide, registerColliderShape, registerColliderTriangles, setSurfaceTable, surfaceOfCollider,
  terrainOfCollider,
} from "../effects";

const g = globalThis as any;
g.self = g;
let fails = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`);
};

async function shapesOf(map: string): Promise<StaticShape[]> {
  const buf = fs.readFileSync(path.resolve("public/assets/maps", map, "collision.glb"));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf: any = await new Promise((res, rej) => new GLTFLoader().parse(ab, "", res, rej));
  const out: StaticShape[] = [];
  gltf.scene.traverse((obj: THREE.Object3D) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const geom = obj.geometry, pos = geom.getAttribute("position");
    obj.updateWorldMatrix(true, false);
    const vertices = new Float32Array(pos.count * 3), v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
      vertices.set([v.x, v.y, v.z], i * 3);
    }
    const indices = geom.index ? Uint32Array.from(geom.index.array as ArrayLike<number>) : Uint32Array.from({ length: pos.count }, (_, i) => i);
    out.push({ name: obj.name, index: out.length, vertices, indices });
  });
  return out;
}

function rng(seed: number) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

(async () => {
  await RAPIER.init();
  const maps = process.argv.slice(2).length ? process.argv.slice(2) : ["helispot", "breedingnest", "airport", "tutorial"];
  for (const map of maps) {
    const dir = path.resolve("public/assets/maps", map);
    if (!fs.existsSync(path.join(dir, "collision.glb"))) { console.log(`skip ${map}`); continue; }
    setSurfaceTable(fs.existsSync(path.join(dir, "surfaces.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "surfaces.json"), "utf8")) : null);
    const shapes = await shapesOf(map);
    // the walk of realLevel.ts: TH_ / GLASS_ shapes stay walk shapes
    for (const s of shapes) if (/^(TH_|GLASS)/i.test(s.name)) s.walk = true;

    // ---- before: one collider per shape ----
    clearColliderShapes();
    const A = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const shapeOfA = new Map<number, number>();
    for (const s of shapes) {
      const c = A.createCollider(RAPIER.ColliderDesc.trimesh(s.vertices, s.indices), A.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
      registerColliderShape(c.handle, s.name, s.index);
      if (s.walk ?? /(^WR_|TH_)/i.test(s.name)) registerColliderTriangles(c.handle, s.indices.length / 3);
      shapeOfA.set(c.handle, s.index);
    }
    A.step();
    const rays = rng(12345), N = 6000, probes: { o: any; d: any }[] = [];
    for (let i = 0; i < N; i++) {
      const s = shapes[Math.floor(rays() * shapes.length)], v = Math.floor(rays() * (s.vertices.length / 3));
      const o = { x: s.vertices[v * 3] + (rays() - 0.5) * 6, y: s.vertices[v * 3 + 1] + 0.2 + rays() * 3, z: s.vertices[v * 3 + 2] + (rays() - 0.5) * 6 };
      const d = new THREE.Vector3(rays() - 0.5, (rays() - 0.5) * 0.8, rays() - 0.5).normalize();
      probes.push({ o, d: { x: d.x, y: d.y, z: d.z } });
    }
    const cast = (w: RAPIER.World, shapeId: (h: number, f: number | undefined) => number) => probes.map((p) => {
      const h = w.castRayAndGetNormal(new RAPIER.Ray(p.o, p.d), 300, true);
      if (!h) return null;
      const t = terrainOfCollider(h.collider.handle);
      return { toi: h.timeOfImpact, n: h.normal, surf: surfaceOfCollider(h.collider.handle), terrain: t && `${t.type}/${t.thickness}`,
        shape: shapeId(h.collider.handle, h.featureId), side: hitSide(h.collider.handle, h.featureId) };
    });
    const before = cast(A, (h) => shapeOfA.get(h) ?? -1);
    const collA = A.colliders.len();
    const t0 = performance.now(); for (let i = 0; i < 200; i++) A.step(); const stepA = (performance.now() - t0) / 200;

    // ---- after: merged ----
    clearColliderShapes();
    const B = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const cols = buildStaticColliders(B, RAPIER, shapes);
    B.step();
    const shapeOfB = (h: number, f: number | undefined) => { const id = hitShapeId(h, f); return Number(id.split(":")[1] ?? -1); };
    const after = cast(B, shapeOfB);
    const t1 = performance.now(); for (let i = 0; i < 200; i++) B.step(); const stepB = (performance.now() - t1) / 200;

    let hits = 0, bad = 0, ties = 0, sample = "";
    for (let i = 0; i < N; i++) {
      const a = before[i], b = after[i];
      if (!a || !b) { if (!!a !== !!b) { bad++; sample ||= `ray ${i}: hit ${!!a} -> ${!!b}`; } continue; }
      hits++;
      const sameGeo = Math.abs(a.toi - b.toi) < 1e-4 && Math.abs(a.n.x - b.n.x) < 1e-4 && Math.abs(a.n.y - b.n.y) < 1e-4 && Math.abs(a.n.z - b.n.z) < 1e-4;
      const same = sameGeo && a.surf === b.surf && a.terrain === b.terrain && a.side === b.side && a.shape === b.shape;
      if (!same) {
        if (Math.abs(a.toi - b.toi) < 1e-4 && a.surf === b.surf && a.terrain === b.terrain) ties++; // coincident faces of two shapes
        else { bad++; sample ||= `ray ${i}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`; }
      }
    }
    console.log(`${map}: shapes ${shapes.length}, colliders ${collA} -> ${cols.length}, step ${stepA.toFixed(3)} -> ${stepB.toFixed(3)} ms, ${hits}/${N} rays hit, ${ties} ties`);
    check(`${map}: every ray gives the same distance / normal / surface / terrain`, bad === 0, sample);
    check(`${map}: fewer colliders`, cols.length < collA || shapes.length <= 2);
    A.free(); B.free();
  }
  process.exit(fails ? 1 : 0);
})();
