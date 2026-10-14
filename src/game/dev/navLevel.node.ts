// Node harness (no browser, no GL): the production map path of a match -- buildRealLevel (static colliders, props, glass panes),
// loadMapMeta (respawns = nav seeds) and NavGraph -- fed from public/assets through a GLB reader instead of GLTFLoader.
// Used by pb-extract-tools bake-navgraph.mjs and the level cache / navgraph smokes (scripts/dev/test-level-cache.mjs, scripts/dev/test-navgraph.mjs).
// The caller registers the extensionless-.ts resolve hook (pb-extract-tools lib/nodeTs.mjs) before importing this file's dynamic imports.
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";

export const PUBLIC = path.resolve(import.meta.dirname, "../../../public");

const MIME: Record<string, string> = { ".json": "application/json", ".glb": "model/gltf-binary", ".bin": "application/octet-stream" };

/** window / fetch / storage stubs for the modules the level path imports; fetch serves public/ (404 for a missing file) */
export function installNodeEnv(): void {
  const g = globalThis as Record<string, unknown>;
  g.window = g.window ?? { location: { search: "", href: "http://localhost/" }, innerWidth: 1280, innerHeight: 720, addEventListener() {}, devicePixelRatio: 1 };
  g.document = g.document ?? { getElementById: () => null, addEventListener() {}, createElement: () => ({ style: {} }) };
  g.localStorage = g.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {} };
  g.fetch = async (url: string) => {
    const p = path.join(PUBLIC, String(url).replace(/^\//, ""));
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return new Response("not found", { status: 404 });
    return new Response(fs.readFileSync(p), { headers: { "content-type": MIME[path.extname(p)] ?? "application/octet-stream" } });
  };
}

const NCOMP: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const ARR: Record<number, { new (b: ArrayBuffer): ArrayLike<number> }> = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };

interface GlbJson {
  scene?: number;
  scenes: { nodes: number[] }[];
  nodes: { name?: string; mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes?: { name?: string; primitives: { attributes: { POSITION: number }; indices?: number }[] }[];
  accessors: { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string }[];
  bufferViews: { byteOffset?: number; byteLength: number }[];
}

/** geometry-only scene of a GLB (positions + indices, node transforms): all the collision / prop-collider code reads */
function glbScene(file: string): THREE.Group {
  const g = fs.readFileSync(file);
  const jl = g.readUInt32LE(12);
  const J = JSON.parse(g.toString("utf8", 20, 20 + jl)) as GlbJson;
  const bo = 20 + jl;
  const bin = g.subarray(bo + 8, bo + 8 + g.readUInt32LE(bo));
  const read = (ai: number): ArrayLike<number> => {
    const a = J.accessors[ai], v = J.bufferViews[a.bufferView], T = ARR[a.componentType];
    const n = a.count * NCOMP[a.type];
    const o = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    return new T(bin.buffer.slice(bin.byteOffset + o, bin.byteOffset + o + n * (T as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT));
  };
  const build = (ni: number): THREE.Object3D => {
    const n = J.nodes[ni];
    const obj = new THREE.Group();
    obj.name = n.name ?? "";
    if (n.matrix) obj.matrix.fromArray(n.matrix).decompose(obj.position, obj.quaternion, obj.scale);
    else {
      if (n.translation) obj.position.fromArray(n.translation);
      if (n.rotation) obj.quaternion.fromArray(n.rotation);
      if (n.scale) obj.scale.fromArray(n.scale);
    }
    if (n.mesh !== undefined) {
      const m = J.meshes![n.mesh];
      m.primitives.forEach((p, k) => {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(read(p.attributes.POSITION)), 3));
        if (p.indices !== undefined) geom.setIndex(new THREE.BufferAttribute(Uint32Array.from(read(p.indices)), 1));
        const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
        mesh.name = m.primitives.length === 1 ? (n.name ?? m.name ?? "") : `${m.name ?? n.name ?? ""}_${k}`;
        obj.add(mesh);
      });
      // GLTFLoader puts a single-primitive mesh on the node itself: same names / transforms for the collision shapes
      if (m.primitives.length === 1) {
        const mesh = obj.children[obj.children.length - 1] as THREE.Mesh;
        obj.remove(mesh);
        mesh.position.copy(obj.position);
        mesh.quaternion.copy(obj.quaternion);
        mesh.scale.copy(obj.scale);
        for (const c of n.children ?? []) mesh.add(build(c));
        return mesh;
      }
    }
    for (const c of n.children ?? []) obj.add(build(c));
    return obj;
  };
  const root = new THREE.Group();
  for (const ni of J.scenes[J.scene ?? 0].nodes) root.add(build(ni));
  return root;
}

export interface NodeLoader {
  loads: string[];
  loadAsync(url: string): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>;
  register(ext: unknown): NodeLoader; // GLTFLoader.register: extensions are not run here
}

/** GLTFLoader stand-in: counts every load; the (huge, texture-only for these checks) visual.glb is an empty scene */
export function glbLoader(): NodeLoader {
  const loader: NodeLoader = {
    loads: [],
    register() {
      return loader;
    },
    async loadAsync(url) {
      loader.loads.push(url);
      if (/visual\.glb$/.test(url)) return { scene: new THREE.Group(), animations: [] };
      const f = path.join(PUBLIC, url.replace(/^\//, ""));
      if (!fs.existsSync(f)) throw new Error(`${url}: not found`);
      return { scene: glbScene(f), animations: [] };
    },
  };
  return loader;
}

/** map ids the game offers (index.json passing the check) */
export async function availableMaps(): Promise<string[]> {
  const { loadMapIndex, AVAILABLE_MAPS } = await import("../../config.ts");
  await loadMapIndex();
  return [...AVAILABLE_MAPS];
}

export interface NodeLevel {
  map: string;
  world: RAPIER.World;
  R: typeof RAPIER;
  level: Awaited<ReturnType<typeof import("../../realLevel.ts").buildRealLevel>>;
  meta: Awaited<ReturnType<typeof import("../spawns.ts").loadMapMeta>>;
  loader: NodeLoader;
}

/** What Game.create's inputs are for `map` (a fresh Rapier world each call, as every match). */
export async function buildNodeLevel(map: string, loader: NodeLoader = glbLoader()): Promise<NodeLevel> {
  const { setCurrentMap, AssetPaths } = await import("../../config.ts");
  const { buildRealLevel } = await import("../../realLevel.ts");
  const { loadMapMeta } = await import("../spawns.ts");
  await RAPIER.init();
  setCurrentMap(map);
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const level = await buildRealLevel(world, RAPIER, true, loader as never);
  const meta = await loadMapMeta(AssetPaths.collisionJson, level.spawn);
  world.step(); // the query pipeline sees the fresh trimeshes, as Game.create does before NavGraph
  return { map, world, R: RAPIER, level, meta: meta as NodeLevel["meta"], loader };
}
