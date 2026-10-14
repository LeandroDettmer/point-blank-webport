import type RAPIER from "@dimforge/rapier3d-compat";
import { registerColliderGroup, registerColliderShape, shapeGroupKey } from "./weapons/effects";

/** one collision.glb mesh (= collision.json shapes[i]) in world space */
export interface StaticShape {
  name: string;
  index: number;
  vertices: Float32Array;
  indices: Uint32Array;
  /** one-sided walk for bullets; default by name (WALK) */
  walk?: boolean;
}

/** walk shapes (WR_ wires, ND_TH_ boards): bullets cross them one-sided (effects.ts hitSide) */
const WALK = /(^WR_|TH_)/i;

/**
 * Merges the map shapes that share a surface code + terrain entry (surfaces.json) into one fixed trimesh each.
 * A collider per shape made Rapier's `step` / KCC / raycasts pay per collider (328 in provence); the geometry is the same.
 * Bullet rules still see per-shape data: each merged collider registers its triangle ranges (effects.ts registerColliderGroup),
 * so surface / terrain / one-sided walk / "same wall" resolve per original shape. Needs the surface table loaded.
 * Returns the colliders built.
 */
export function buildStaticColliders(world: RAPIER.World, R: typeof RAPIER, shapes: StaticShape[]): RAPIER.Collider[] {
  const groups = new Map<string, StaticShape[]>();
  for (const s of shapes) {
    const k = shapeGroupKey(s.name, s.index);
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }
  const out: RAPIER.Collider[] = [];
  for (const members of groups.values()) {
    let nv = 0, ni = 0;
    for (const s of members) { nv += s.vertices.length; ni += s.indices.length; }
    const vertices = new Float32Array(nv);
    const indices = new Uint32Array(ni);
    const ranges: { start: number; end: number; index: number; walk: boolean }[] = [];
    let vo = 0, io = 0;
    for (const s of members) {
      vertices.set(s.vertices, vo);
      const base = vo / 3;
      for (let i = 0; i < s.indices.length; i++) indices[io + i] = s.indices[i] + base;
      ranges.push({ start: io / 3, end: (io + s.indices.length) / 3, index: s.index, walk: s.walk ?? WALK.test(s.name) });
      vo += s.vertices.length;
      io += s.indices.length;
    }
    try {
      const c = world.createCollider(R.ColliderDesc.trimesh(vertices, indices), world.createRigidBody(R.RigidBodyDesc.fixed()));
      registerColliderShape(c.handle, members[0].name, members[0].index);
      registerColliderGroup(c.handle, indices.length / 3, ranges);
      out.push(c);
    } catch (err) {
      console.warn("Failed to build merged trimesh collider for", members[0].name, err);
    }
  }
  return out;
}
