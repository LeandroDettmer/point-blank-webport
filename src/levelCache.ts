import * as THREE from "three";
import type { GLTF, GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/**
 * Per-map cache of what a match rebuilt from the network every time: the parsed visual / prop GLBs
 * (geometry + decoded textures) and the collision arrays. The second match on the same map loads nothing; the Rapier world,
 * the prop instances and every per-match object are still built fresh (props start intact, handles stay per world).
 * A different map releases the previous one (geometry, materials, textures) before the new one loads.
 *
 * Shared entries are read-only: callers take `cloneGltf` (shares geometry / materials / textures, own node tree).
 */

export const levelCacheStats = { loads: 0, hits: 0, releases: 0 };

interface Entry {
  p: Promise<unknown>;
  /** the resolved value (levelCacheOwned reads the geometry / materials / textures it holds) */
  v?: unknown;
  dispose?: (v: never) => void;
}

let scope = "";
const entries = new Map<string, Entry>();

/** Call before loading a map: a different key frees the cached previous one. */
export function levelCacheScope(key: string): void {
  if (key === scope) return;
  releaseLevelCache();
  scope = key;
}

/** One load per key and scope; a failed load is retried next call. */
export function cachedOnce<T>(key: string, make: () => Promise<T>, dispose?: (v: T) => void): Promise<T> {
  const e = entries.get(key);
  if (e) {
    levelCacheStats.hits++;
    return e.p as Promise<T>;
  }
  levelCacheStats.loads++;
  const p = make();
  const entry: Entry = { p, dispose: dispose as Entry["dispose"] };
  p.then((v) => { entry.v = v; }, () => { if (entries.get(key) === entry) entries.delete(key); });
  entries.set(key, entry);
  return p;
}

/** The shared (never put in a scene) GLTF of `url`. */
export function loadGltfShared(loader: GLTFLoader, url: string): Promise<GLTF> {
  return cachedOnce(`gltf:${url}`, () => loader.loadAsync(url), disposeGltf);
}

/** An independent node tree over the shared geometry / materials / textures (animations are immutable clips). */
export function cloneGltf(g: GLTF): GLTF {
  return { ...g, scene: g.scene.clone(true) };
}

const TEX_KEYS = ["map", "lightMap", "aoMap", "emissiveMap", "bumpMap", "normalMap", "displacementMap", "roughnessMap", "metalnessMap", "alphaMap", "envMap"];

/** every texture a material reads: its own maps and, for ShaderMaterials, the texture uniforms */
export function texturesOfMaterial(m: THREE.Material): THREE.Texture[] {
  const out: THREE.Texture[] = [];
  for (const k of TEX_KEYS) { const t = (m as unknown as Record<string, THREE.Texture | null | undefined>)[k]; if (t) out.push(t); }
  for (const v of Object.values((m as THREE.ShaderMaterial).uniforms ?? {})) if ((v.value as THREE.Texture | null)?.isTexture) out.push(v.value as THREE.Texture);
  return out;
}

function disposeMaterial(m: THREE.Material): void {
  for (const t of texturesOfMaterial(m)) t.dispose();
  m.dispose();
}

/** Frees the GPU side (if any) of a loaded GLTF's geometry, materials and textures. */
export function disposeGltf(g: GLTF): void {
  g.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) disposeMaterial(m);
  });
}

/**
 * What the cache holds right now (geometry, materials, textures of the shared GLTFs + the collision debug geometry). A match end
 * (render/sharedRenderer.ts releaseMatch) disposes everything of its scene except this: the renderer is kept between matches,
 * so these stay uploaded to the GPU for the next match on the same map. Built per call (applyBakedLightmaps swaps the
 * materials of a cached scene after it loaded).
 */
export function levelCacheOwned(): { has(o: object): boolean } {
  const owned = new WeakSet<object>();
  for (const e of entries.values()) {
    const v = e.v as { scene?: THREE.Object3D; meshes?: { geom?: object }[] } | undefined;
    if (!v) continue;
    v.scene?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      owned.add(mesh.geometry);
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        owned.add(m);
        for (const t of texturesOfMaterial(m)) owned.add(t);
      }
    });
    for (const m of v.meshes ?? []) if (m.geom) owned.add(m.geom);
  }
  return owned;
}

export function releaseLevelCache(): void {
  for (const e of entries.values()) {
    void e.p.then((v) => e.dispose?.(v as never), () => {});
  }
  if (entries.size) levelCacheStats.releases++;
  entries.clear();
  scope = "";
}
