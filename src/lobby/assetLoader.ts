// On-demand GLTF loader for weapon/character models, by itemId, with a LOD/full choice and an in-memory
// LRU cache. Owner: ? "Assets 3D leves". Does not touch src/game/*,
// src/weapons/* or src/main.ts — wires this into the lobby preview and the match loadout.
//
// Full-res weapons are ~650MB and characters ~130MB total: the lobby must
// never fetch the catalog index's models, only the single item a screen actually shows, and prefer the
// `models_lod` mirror (256px textures, pb-extract-tools asset-lod/build.mjs) unless the caller asks for full quality.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { registerModelCompressedTextures } from "../render/compressedTex";
import { resolveChara } from "../game/loadout.ts"; // pure (type-only imports): the match's itemId -> char fallback
import { jsonOnce } from "../jsonOnce.ts";

export type Lod = "lod" | "full";

export interface WeaponAsset {
  gltf: THREE.Group;
  /** Bone node used as the grip origin, snapped to the character's hand dummy. */
  gripNode: THREE.Object3D | null;
  /** Bone node at the muzzle, used for muzzle flash / tracer origin. */
  muzzleNode: THREE.Object3D | null;
}

export interface CharaAsset {
  gltf: THREE.Group;
  /** First-person arms model (1PV), loaded alongside the third-person body. */
  arms: THREE.Group | null;
  /** 3PV clips: the model's own, or those of its `clipsFrom` char (skins share the 63-bone skeleton) */
  clips: THREE.AnimationClip[];
  /** chars/index.json entry actually loaded (itemIds without a model fall back like the match: loadout.ts resolveChara) */
  name: string;
  /** char whose skeleton/poses this one uses (`clipsFrom`, else itself): swat_male | swat_female | ... */
  skeleton: string;
}

interface WeaponIndexEntry {
  id: string;
  file: string;
  itemId: number;
  itemIds?: number[];
  grip?: string;
  muzzle?: string;
}
interface CharaIndexEntry {
  name: string;
  id?: string;
  model: string;
  arms1pv?: { model: string };
  itemId: number;
  itemIds?: number[];
  team?: string;
  clipsFrom?: string | null;
}
interface WeaponIndex { weapons: WeaponIndexEntry[] }
interface CharaIndex { chars: CharaIndexEntry[] }

const WEAPONS_BASE = "/assets/weapons/models";
const CHARS_BASE = "/assets/chars";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`assetLoader: ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

// The catalog indexes (which itemId maps to which file) are small JSON, fetched once and cached forever
// (not counted against the model LRU below) -- this is metadata, not the ~MB-sized GLB/PNG payloads.
// The weapon index is jsonOnce: the same file as worldModel's models/index.json (1.7 MB, one fetch + parse for both).
let charaIndexPromise: Promise<CharaIndex> | null = null;
function weaponIndex(): Promise<WeaponIndex> {
  return jsonOnce<WeaponIndex>(`${WEAPONS_BASE}/index.json`);
}
function charaIndex(): Promise<CharaIndex> {
  return (charaIndexPromise ??= fetchJson<CharaIndex>(`${CHARS_BASE}/index.json`));
}

// ---- LRU cache of loaded GLTF scenes (by cache key = kind + itemId + lod) --------------------------------
interface CacheEntry {
  value: WeaponAsset | CharaAsset;
  bytes: number; // rough weight for eviction bookkeeping, not a real memory measurement
}
const gltfLoader = registerModelCompressedTextures(new GLTFLoader());
const cache = new Map<string, CacheEntry>(); // insertion order = LRU order (Map preserves it)
let maxEntries = 24;

function touch(key: string): void {
  const e = cache.get(key);
  if (!e) return;
  cache.delete(key);
  cache.set(key, e); // re-insert at the end = most-recently-used
}

function evictIfNeeded(): void {
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const e = cache.get(oldestKey);
    disposeAsset(e?.value);
    cache.delete(oldestKey);
  }
}

function disposeAsset(v: WeaponAsset | CharaAsset | undefined): void {
  if (!v) return;
  const roots = "arms" in v ? [v.gltf, v.arms].filter((x): x is THREE.Group => !!x) : [v.gltf];
  for (const root of roots) {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if ((mesh as any).isMesh) {
        mesh.geometry?.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          if (!m) continue;
          for (const key of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap"] as const) {
            (m as any)[key]?.dispose?.();
          }
          m.dispose();
        }
      }
    });
  }
}

function loadGLTFFull(url: string): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> {
  return new Promise((resolve, reject) => {
    gltfLoader.load(url, (gltf) => resolve(gltf), undefined, reject);
  });
}
function loadGLTF(url: string): Promise<THREE.Group> {
  return loadGLTFFull(url).then((g) => g.scene);
}

// Loads in flight by cache key: a prefetch (preview.ts prefetchModels) and the click on the same model share one download
const inflight = new Map<string, Promise<WeaponAsset | CharaAsset>>();
function once<T extends WeaponAsset | CharaAsset>(key: string, load: () => Promise<T>): Promise<T> {
  let p = inflight.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/** Clips of a chars/index.json entry by name, kept like the indexes (keyframes only, the scene is dropped). */
const clipsByName = new Map<string, Promise<THREE.AnimationClip[]>>();
function charaClips(list: CharaIndexEntry[], name: string, lod: Lod): Promise<THREE.AnimationClip[]> {
  const key = `${name}:${lod}`;
  let p = clipsByName.get(key);
  if (!p) {
    const e = list.find((c) => c.name === name);
    const base = lod === "lod" ? `${CHARS_BASE}/models_lod` : CHARS_BASE;
    p = e ? loadGLTFFull(`${base}/${e.model}`).then((g) => g.animations, () => []) : Promise.resolve([]);
    clipsByName.set(key, p);
  }
  return p;
}

/** Team of a character itemId (601xxx red, 602xxx blue). */
export const charaTeamOf = (itemId: number): 0 | 1 => (Math.floor(itemId / 1000) % 10 === 2 ? 1 : 0);

function findNode(root: THREE.Object3D, name: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!found && o.name === name) found = o;
  });
  return found;
}

/**
 * Loads a weapon model by itemId. `lod: "lod"` (default) fetches the low-res mirror for lobby/preview use;
 * `lod: "full"` fetches the same asset the match uses. Throws if the itemId isn't in weapons/models/index.json
 * (callers in server-driven flows should already know the itemId exists; this is not a "missing asset" fallback).
 */
export async function loadWeaponAsset(itemId: number, lod: Lod = "lod"): Promise<WeaponAsset> {
  const key = `weapon:${itemId}:${lod}`;
  const hit = cache.get(key);
  if (hit) { touch(key); return hit.value as WeaponAsset; }

  return once(key, async () => {
    const idx = await weaponIndex();
    const entry = idx.weapons.find((w) => w.itemId === itemId || w.itemIds?.includes(itemId));
    if (!entry) throw new Error(`assetLoader: no weapon indexed for itemId ${itemId}`);

    const base = lod === "lod" ? `${WEAPONS_BASE}/models_lod` : WEAPONS_BASE;
    const gltf = await loadGLTF(`${base}/${entry.file}`);
    const value: WeaponAsset = {
      gltf,
      gripNode: entry.grip ? findNode(gltf, entry.grip) : findNode(gltf, "GunDummy"),
      muzzleNode: entry.muzzle ? findNode(gltf, entry.muzzle) : findNode(gltf, "FXDummy"),
    };
    cache.set(key, { value, bytes: 1 });
    evictIfNeeded();
    return value;
  });
}

/**
 * Loads a character (body + 1PV arms) by itemId (chara_red_side / chara_blue_side). `lod: "lod"` (default) is
 * for the lobby/inventory preview; `lod: "full"` is what the match uses.
 */
export async function loadCharaAsset(itemId: number, lod: Lod = "lod"): Promise<CharaAsset> {
  const key = `chara:${itemId}:${lod}`;
  const hit = cache.get(key);
  if (hit) { touch(key); return hit.value as CharaAsset; }

  return once(key, async () => {
    const idx = await charaIndex();
    const r = resolveChara(idx.chars, itemId, charaTeamOf(itemId));
    const entry = r.entry;
    if (!entry) throw new Error(`assetLoader: no character indexed for itemId ${itemId}`);
    if (r.source !== "itemId") console.info(`[assetLoader] chara ${itemId}: no model, ${r.source} fallback ${entry.name}`);

    const base = lod === "lod" ? `${CHARS_BASE}/models_lod` : CHARS_BASE;
    const full = await loadGLTFFull(`${base}/${entry.model}`);
    const gltf = full.scene;
    const arms = entry.arms1pv?.model ? await loadGLTF(`${base}/${entry.arms1pv.model}`) : null;
    const clips = full.animations.length || !entry.clipsFrom ? full.animations : await charaClips(idx.chars, entry.clipsFrom, lod);
    const value: CharaAsset = { gltf, arms, clips, name: entry.name, skeleton: entry.clipsFrom || entry.name };
    cache.set(key, { value, bytes: 1 });
    evictIfNeeded();
    return value;
  });
}

/** Drops one cached entry early (e.g. a preview screen closing), without waiting for LRU eviction. */
export function releaseAsset(kind: "weapon" | "chara", itemId: number, lod: Lod = "lod"): void {
  const key = `${kind}:${itemId}:${lod}`;
  const e = cache.get(key);
  if (!e) return;
  disposeAsset(e.value);
  cache.delete(key);
}
