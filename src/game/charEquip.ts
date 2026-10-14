// Head accessories on a character (PB 2017 client assets, pb-extract-tools export-headgear.mjs -> public/assets/equip/index.json):
// default helmet, head item (class 7), mask (class 8) and beret (class 27), attached to the chara's HelmetPointDummy.
// Rules (2017 client, see the exporter header): every accessory scene is rooted at "HelmetDummy" = its origin, which
// snaps to HelmetPointDummy (child of bone "Head"). A beret, or a head item whose mesh is "Model_Helmet" (hats,
// helmets), is drawn INSTEAD of the default helmet (beret first); masks are worn under the helmet (the face slot wins
// over a head-slot mask). Each item has one GLB per character family (index.charas[<chars name>].family); an item
// without a GLB for the family is not drawn (never another family's fit). No costume exception (Cross exe): every
// character's helmet slot falls back to its family Helmet, GetResNameHead 0x56b230 (case Helmet 0x56b302: the item's
// res name, else "Helmet" 0x56b318) and the equip preload 0x56b590 ("Equip/%s/%s_%s.I3CHR" 0xb4cabc, every family 1..0x2a)
// never branch on a character flag; the Cross pef has no PartsList / ResDftPartSkin (the 3.123 costume rule).
// Pure three + fetch, no DOM: shared by src/game/charModel.ts (match: bots, remotes, local shadow) and the lobby
// preview (src/lobby/screens/preview3d.ts). Equipment of match actors comes from BATTLE_RESPAWN_ACK 5138
// (parts[0] head, parts[1] face, beret), recorded per actor id by watchRespawnEquip().
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { registerModelCompressedTextures } from "../render/compressedTex";
import { noteActorEquip, type HeadEquip } from "./actorEquip";

export type { HeadEquip } from "./actorEquip";
export { actorEquip, actorHasBeret, actorHasHelmet, actorHelmetDefense, actorHeadgearOn, clearActorEquip, noteActorEquip, noteBotEquip } from "./actorEquip";

interface EquipEntry { cat: string; replacesHelmet: boolean; files: Record<string, string> }
export interface EquipIndex {
  attach: string;
  /** helmet = the chara's default helmet entry */
  charas: Record<string, { family: string; helmet: string }>;
  entries: Record<string, EquipEntry>;
  items: Record<string, { key: string; slot: "head" | "face" | "beret" }>;
}

const BASE = "/assets/equip";
let index: EquipIndex | null = null;
let loading: Promise<EquipIndex | null> | null = null;

/** Tests / Node: the parsed index (null = no accessories). */
export function setEquipIndex(j: EquipIndex | null): void { index = j; loading = Promise.resolve(j); }

export function loadEquipIndex(): Promise<EquipIndex | null> {
  return (loading ??= fetch(`${BASE}/index.json`)
    .then((r) => (r.ok ? (r.json() as Promise<EquipIndex>) : null))
    .then((j) => (index = j))
    .catch(() => null));
}

export const equipKey = (e: HeadEquip | null | undefined): string => `${e?.head ?? 0}/${e?.face ?? 0}/${e?.beret ?? 0}`;

interface Picked { helmet: string | null; beret: boolean; mask: string | null; head: string | null }

function pick(ix: EquipIndex, charaName: string, eq: HeadEquip | null | undefined): Picked | null {
  const ch = ix.charas[charaName];
  if (!ch) return null;
  const item = (id?: number) => {
    const it = id ? ix.items[String(id)] : undefined;
    const e = it ? ix.entries[it.key] : undefined;
    return e?.files[ch.family] ? e : null;
  };
  const beret = item(eq?.beret), head = item(eq?.head), face = item(eq?.face);
  const helmetSlot = beret ?? (head?.replacesHelmet ? head : null);
  const mask = face ?? (head && !head.replacesHelmet ? head : null);
  // a mask on the head takes the default hat off (it clipped through the mask); a beret / hat item stays
  const own = ix.entries[ch.helmet] ?? ix.entries.helmet_default;
  const helmet = helmetSlot ?? (mask ? null : own);
  return { helmet: helmet?.files[ch.family] ?? null, beret: !!beret, mask: mask ? mask.files[ch.family] : null, head: head ? head.files[ch.family] : null };
}

/** GLB paths (relative to /assets/equip) drawn on `charaName` for `eq`, in attach order. Pure. */
export function headgearFiles(ix: EquipIndex, charaName: string, eq: HeadEquip | null | undefined): string[] {
  const p = pick(ix, charaName, eq);
  if (!p) return [];
  return [p.helmet, p.mask].filter((f): f is string => !!f);
}

/**
 * The GLB that pops off on HELMET PROTECTION: the equipped head item (class 7) when it is drawn on the character, else
 * the helmet-slot GLB (chara default helmet). null = nothing drawn to pop (a beret holds the slot and no head item shows). Pure.
 */
export function helmetFile(ix: EquipIndex, charaName: string, eq: HeadEquip | null | undefined): string | null {
  const p = pick(ix, charaName, eq);
  if (!p) return null;
  if (p.head && (p.head === p.helmet || p.head === p.mask)) return p.head;
  return p.helmet; // a beret holds the helmet slot: it pops off like a helmet on a headshot
}

const loader = registerModelCompressedTextures(new GLTFLoader());
const glbCache = new Map<string, Promise<THREE.Group | null>>();

/** Death clips move a skinned body about this far (m) from its bind pose. */
const CULL_REACH = 2;

/**
 * Re-enables frustum culling on a character mesh. A SkinnedMesh is culled by its bind-pose sphere, so that sphere is
 * grown by CULL_REACH (kept in mesh-local units through the world scale) to cover every animation; rigid meshes
 * follow their node, so their geometry bounds are right. Call after `root.updateMatrixWorld(true)`; clones keep the sphere.
 */
export function keepCharaCulling(o: THREE.Object3D): void {
  const m = o as THREE.SkinnedMesh;
  if (!m.isMesh) return;
  if (m.isSkinnedMesh) {
    m.computeBoundingSphere();
    const s = m.boundingSphere;
    if (!s) return; // no sphere: stay drawn
    s.radius += CULL_REACH / (m.matrixWorld.getMaxScaleOnAxis() || 1);
  }
  m.frustumCulled = true;
}

/** The accessory's i3-space content (AxisRotate stripped, HelmetDummy at the origin), cached per file. */
function template(file: string): Promise<THREE.Group | null> {
  let p = glbCache.get(file);
  if (!p) {
    p = loader.loadAsync(`${BASE}/${file}`).then((gltf) => {
      const axis = gltf.scene.children.length === 1 && !(gltf.scene.children[0] as THREE.Mesh).isMesh ? gltf.scene.children[0] : gltf.scene;
      const g = new THREE.Group();
      g.name = `equip:${file}`;
      for (const c of [...axis.children]) g.add(c);
      g.updateMatrixWorld(true);
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) { m.castShadow = true; keepCharaCulling(m); }
      });
      return g;
    }, (err) => { console.warn(`[equip] ${file} failed`, err); return null; });
    glbCache.set(file, p);
  }
  return p;
}

/**
 * Attaches the head accessories of `eq` to `model` (a chars/index.json GLB instance named `charaName`): fresh clones
 * parented to HelmetPointDummy. Returns the attached objects (remove them to change the equipment); [] when the chara
 * has no HelmetPointDummy / no accessory data.
 */
export async function attachHeadgear(model: THREE.Object3D, charaName: string, eq: HeadEquip | null | undefined): Promise<THREE.Object3D[]> {
  const ix = index ?? (await loadEquipIndex());
  if (!ix) return [];
  const dummy = model.getObjectByName(ix.attach || "HelmetPointDummy");
  if (!dummy) return [];
  const files = headgearFiles(ix, charaName, eq);
  // userData.helmet marks the accessory CharVisual.setHelmet toggles (equipped and not popped off). The chara's own
  // default helmet is not an item: no Head item = no helmet roll (0x5425e0) and nothing to pop, so it stays on the head.
  // Without this gate a default character (parts[0] 0) spawned bare-headed: actorHeadgearOn() is false for it.
  const helmet = eq?.head || eq?.beret ? helmetFile(ix, charaName, eq) : null;
  const tpls = await Promise.all(files.map(template));
  const out: THREE.Object3D[] = [];
  for (const [i, t] of tpls.entries()) {
    if (!t) continue;
    const o = t.clone(true);
    o.userData.helmet = !!helmet && files[i] === helmet;
    dummy.add(o);
    out.push(o);
  }
  return out;
}

/** Match preload: the head accessory GLBs `charaName` wears with `eq` (and the helmet that pops off), into the template cache. */
export async function preloadHeadgear(charaName: string, eq: HeadEquip | null | undefined): Promise<THREE.Group[]> {
  const ix = index ?? (await loadEquipIndex());
  if (!ix) return [];
  const files = new Set([...headgearFiles(ix, charaName, eq), helmetFile(ix, charaName, eq)].filter((f): f is string => !!f));
  return (await Promise.all([...files].map(template))).filter((g): g is THREE.Group => !!g);
}

/** A fresh copy of the helmet `charaName` wears with `eq` (the dropped helmet), null = none. */
export async function loadHelmetModel(charaName: string, eq: HeadEquip | null | undefined): Promise<THREE.Object3D | null> {
  const ix = index ?? (await loadEquipIndex());
  const file = ix ? helmetFile(ix, charaName, eq) : null;
  const t = file ? await template(file) : null;
  return t ? t.clone(true) : null;
}

// ---- match: equipment per actor from BATTLE_RESPAWN_ACK (the map lives in actorEquip.ts) --------------------------

/** The part of RoomClient this needs (src/net/roomClient.ts onRespawnAck, src/net/metaGame.ts RespawnAck). */
export interface RespawnAckSource {
  onRespawnAck: ((a: { slot: number; parts: number[]; beret: number }) => void) | null;
  /** USER_EQUIPMENT 3667 that arrived before the chain below existed */
  replayEquip?(): void;
}

const watched = new WeakSet<object>();

/** Chains the room's 5138 handler (once per room): records head/face/beret per actor (`slot<N>`, src/net/battle.ts slotId). */
export function watchRespawnEquip(room: RespawnAckSource | null | undefined): void {
  if (!room || watched.has(room)) return;
  watched.add(room);
  const prev = room.onRespawnAck;
  room.onRespawnAck = (a) => {
    prev?.(a);
    noteActorEquip(`slot${a.slot}`, { head: a.parts[0] || 0, face: a.parts[1] || 0, beret: a.beret || 0 });
  };
  room.replayEquip?.();
}
