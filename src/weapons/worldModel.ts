import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { registerModelCompressedTextures } from "../render/compressedTex";
import { loadLodFirst } from "../assetLod";
import { jsonOnce } from "../jsonOnce";
import { isServerThrowable, pack2017Id, throwableBaseId } from "./throwables";
import type { Family } from "./types";
import { BAREFIST_ID } from "../game/respawnSelect";
import { loadWeaponAnimSet, WeaponAnimator, type WeaponView } from "./weaponAnim";

/*
 * Original PB weapon models (public/assets/weapons/models/<file>.glb, pb-extract-tools export-model.mjs).
 * Each GLB is  AxisRotate (i3 -> three axes)  >  GunDummy (grip, origin)  >  meshes + dummies (FXDummy = muzzle,
 * EmptyCartridgeFXDummy = shell eject, LHandGunDummy = support hand). Character GLBs share the same i3 frame under
 * their own AxisRotate, so a weapon is attached by parenting the i3-space content (AxisRotate's children) to the
 * character's WeaponPointDummyRight node — no extra rotation needed.
 *
 * Model choice: weapon name ("AK-47 SOPMOD", "Desert Eagle GRS", or a numeric id resolved through weapons.json)
 * -> best token match against models/index.json ids; otherwise the family's default model (prefers textured).
 */

export interface WeaponModelEntry {
  id: string;
  kind: string; // rifle | smg | shotgun | pistol | knife | sniper | mg ...
  file: string;
  textured?: boolean;
  muzzle?: string;
  grip?: string;
  /** Weapon.pef ITEMIDs rendered by this model (skins share one model) */
  itemIds?: number[];
}

export interface WeaponModelInstance {
  /** i3-space content: parent it to a WeaponPointDummy* node (or any grip frame). */
  object: THREE.Group;
  /** FXDummy (muzzle) and EmptyCartridgeFXDummy (eject); null if the model lacks them. */
  muzzle: THREE.Object3D | null;
  eject: THREE.Object3D | null;
  entry: WeaponModelEntry;
  /** i3 -> three transform (the stripped AxisRotate; a mirror, det -1). Parent `object` under a group with this
   *  matrix to get three space: grip at 0, barrel +Z */
  axis: THREE.Matrix4;
  /** The weapon's own clips (magazine, slide, pump: weaponAnim.ts) bound to this instance; null = none exported. */
  animator(view: WeaponView): Promise<WeaponAnimator | null>;
}

const BASE = "/assets/weapons";
const loader = registerModelCompressedTextures(new GLTFLoader());
let indexP: Promise<WeaponModelEntry[]> | null = null;
let statsP: Promise<{ fam: Map<string, Family>; names: Map<string, string>; cls: Map<string, string> }> | null = null;
const glbCache = new Map<string, Promise<THREE.Group | null>>();

const FAMILY_KINDS: Record<Family, string[]> = {
  AR: ["rifle", "assault", "mg", "sniper", "smg"],
  SMG: ["smg", "rifle"],
  MG: ["mg", "rifle"],
  SR: ["sniper", "rifle"],
  SG: ["shotgun", "rifle"],
  HG: ["pistol", "handgun"],
  KNIFE: ["knife"],
  GRENADE: ["grenade"],
  OTHER: ["rifle"],
};

export const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export function loadWeaponModelIndex(): Promise<WeaponModelEntry[]> {
  indexP ??= fetchJson<{ weapons?: WeaponModelEntry[] }>(`${BASE}/models/index.json`).then((j) =>
    Array.isArray(j?.weapons) ? j!.weapons.filter((w) => w && w.id && w.file) : []
  );
  return indexP;
}

/** weapons.json: name/id -> family (and className), so name-only callers (bots, net PlayerState.weapon) still get one. */
function loadWeaponStats(): Promise<{ fam: Map<string, Family>; names: Map<string, string>; cls: Map<string, string> }> {
  statsP ??= jsonOnce<{ weapons?: { id: number; name: string; family: Family; className?: string; pb?: { base?: string } }[] }>("/assets/cross/weapons/weapons.json").catch(() => null).then((j) => {
    const fam = new Map<string, Family>(), names = new Map<string, string>(), cls = new Map<string, string>();
    for (const w of j?.weapons ?? []) {
      fam.set(String(w.id), w.family);
      names.set(String(w.id), w.name);
      if (!fam.has(norm(w.name))) fam.set(norm(w.name), w.family);
      if (w.className) {
        // Kunai 301107: a Knife whose pef block copies Dual/Dual_Kunai (data.ts dualKnifeAlias)
        const c = w.className === "Knife" && /^Dual\/Dual_(\w*Knife|Kunai)/i.test(w.pb?.base ?? "") ? "DualKnife" : w.className;
        cls.set(String(w.id), c);
        if (!cls.has(norm(w.name))) cls.set(norm(w.name), c);
      }
    }
    return { fam, names, cls };
  });
  return statsP;
}

/**
 * How a dual weapon fires (weapon.json className): DualHandGun / DualShotgun (WeaponDualHandGun, WeaponCrossFire HK45
 * [INFERRED same]) alternate the hands, DualSMG (WeaponDualSMG / DualUzi) fires both guns each shot ([INFERIDO] 2
 * rounds per shot, see WeaponSystem shoot()); null = one gun.
 */
export function dualFire(def: { className?: string }): "alt" | "both" | null {
  return def.className === "DualHandGun" || def.className === "DualShotgun" ? "alt" : def.className === "DualSMG" ? "both" : null;
}

/** dualFire for a weapon name / id (3rd-person models: bots, remote players). */
export async function weaponDualFire(key: string | number): Promise<"alt" | "both" | "melee" | null> {
  const cls = (await loadWeaponStats()).cls;
  const className = cls.get(String(key)) ?? cls.get(norm(String(key)));
  // DualKnife (Bone Knife, Kunai): a blade in each hand (WeaponDual::AttachNode), the upper Attack moves both arms
  // Knuckle: one per fist (pack states _Left / _Right, see viewmodel.wieldsTwo)
  return className === "DualKnife" || className === "Knuckle" ? "melee" : dualFire({ className });
}

/** Best-effort family for a weapon name/id ("K-2" -> AR, "Desert Eagle" -> HG). */
export async function weaponFamily(key: string | number, fallback: Family = "AR"): Promise<Family> {
  const fams = (await loadWeaponStats()).fam;
  const k = String(key);
  const f = fams.get(k) ?? fams.get(norm(k));
  if (f) return f;
  const n = norm(k);
  if (/knife|m7|kukri|axe|dagger|machete|fang|keris|amok/.test(n)) return "KNIFE";
  if (/eagle|glock|p99|mk23|colt|revolver|pistol|c5|r8/.test(n)) return "HG";
  if (/grenade|smoke|flash|k400|c4/.test(n)) return "GRENADE";
  return fallback;
}

/** Pure resolver: which models/index.json entry represents this weapon. */
export function pickWeaponModel(list: WeaponModelEntry[], name: string, family: Family): WeaponModelEntry | null {
  const n = norm(name);
  if (n) {
    const exact = list.find((e) => norm(e.id) === n);
    if (exact) return exact;
    // Tokens shared by the whole family (e.g. "aug", "a3") never single out a skin: a candidate only counts as a
    // real match if it scores above what those shared tokens alone would give, otherwise many skins tie and picking
    // the first is an arbitrary wrong skin (103193 "AUG A3 LionFlame" has no exported glb -> was landing on
    // aug_a3_blue). Ties at the best score are therefore ambiguous and fall through to the family default below.
    let best: WeaponModelEntry | null = null, bestScore = 0, tied: WeaponModelEntry[] = [];
    for (const e of list) {
      const toks = e.id.toLowerCase().split(/[_\-\s]+/).filter(Boolean);
      if (!toks.length || !n.startsWith(norm(toks[0]))) continue;
      // tokens under 3 chars ("a3", "g", "e"...) are too common to mean anything: they never contribute a point,
      // so a skin only outscores its siblings by actually naming part of it (e.g. "grs", "blue").
      const score = toks.reduce((s, t) => s + (t.length >= 3 && n.includes(norm(t)) ? t.length : 0), 0) + (e.textured ? 0.5 : 0);
      if (score > bestScore) (best = e), (bestScore = score), (tied = [e]);
      else if (score === bestScore && best) tied.push(e);
    }
    if (best && tied.length <= 1) return best;
    // Skins of the same gun tie (e.g. 23 l115a1_* for an unexported L115A1 skin): use that gun's BASE model (fewest
    // id tokens, e.g. "l115a1"), never the family default, which is a different weapon.
    if (tied.length > 1) {
      const tokCount = (e: WeaponModelEntry) => e.id.split(/[_\-\s]+/).filter(Boolean).length;
      const base = [...tied].sort((a, b) => tokCount(a) - tokCount(b) || Number(!!b.textured) - Number(!!a.textured))[0];
      if (base) return base;
    }
  }
  for (const kind of FAMILY_KINDS[family] ?? []) {
    const of = list.filter((e) => e.kind === kind);
    const e = of.find((x) => x.textured) ?? of[0];
    if (e) return e;
  }
  return null;
}

function loadGlb(entry: WeaponModelEntry): Promise<THREE.Group | null> {
  let p = glbCache.get(entry.file);
  if (p) { glbCache.delete(entry.file); glbCache.set(entry.file, p); } // LRU touch
  if (!p) {
    // ponytail: LRU without dispose (live instances keep their meshes; an evicted unreferenced model is left to GC),
    // bounds what the shop prefetch (lobby/screensCross/preview.ts) keeps resident while paging 700+ weapons
    if (glbCache.size >= 64) glbCache.delete(glbCache.keys().next().value!);
    p = loadLodFirst(loader, `${BASE}/models/${entry.file}`)
      .then((gltf) => {
        // strip AxisRotate: keep its children (i3 space, grip at origin)
        const axis = gltf.scene.children.length === 1 && !(gltf.scene.children[0] as THREE.Mesh).isMesh ? gltf.scene.children[0] : gltf.scene;
        const g = new THREE.Group();
        g.name = `weapon:${entry.id}`;
        axis.updateMatrix();
        g.userData.axis = axis === gltf.scene ? new THREE.Matrix4() : axis.matrix.clone();
        for (const c of [...axis.children]) g.add(c);
        g.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) m.castShadow = true;
          // sharper oblique views of the small maps (the Cheytac scope is a 256 px psg-1_diff in every client's pack)
          if (m.isMesh) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
            const map = (mat as THREE.MeshStandardMaterial).map;
            if (map) { map.anisotropy = 16; map.userData.pbAnisoFixed = true; } // exempt from the Gráficos aniso (compressedTex.ts)
          }
        });
        // Model_Vol = the loose round of the magazine-fed snipers (Cheytac, Hecate II, Taclite): every reload clip parks its
        // Vol_AniDummy beside the receiver (one static key), so it hung in the air next to the gun. The exe's visibility rule
        // for it is not decoded [INFERIDO]: hidden.
        g.traverse((o) => { if (o.name === "Model_Vol" || o.name === "Vol_AniDummy") o.visible = false; });
        return g;
      })
      .catch((err) => {
        console.warn(`[weapons] model ${entry.file} failed`, err);
        return null;
      });
    glbCache.set(entry.file, p);
  }
  return p;
}

/**
 * Fresh instance of the weapon model for `key` (name or numeric id). `family` is a hint; when omitted it is looked
 * up in weapons.json. Resolves null for grenades (unless `opts.grenade`: 1PV hand / thrown projectile, K-400 ->
 * models/k_400.glb; `projectile`: the thing that flies / is planted, i.e. the C5 brick <id>_bomb.glb instead of the bomb-trigger
 * the hand holds after the throw, pb-extract-tools export-c5-bomb.mjs) / no model available (callers keep their placeholder).
 */
export async function createWeaponModel(key: string | number, family?: Family, opts: { grenade?: boolean; projectile?: boolean } = {}): Promise<WeaponModelInstance | null> {
  const [list, stats] = await Promise.all([loadWeaponModelIndex(), loadWeaponStats()]);
  let name = String(key);
  let id = /^\d+$/.test(name) ? +name : null;
  // exact weapons.json name -> itemId first, so a name never falls to the fuzzy picker ("M-7" matched a sword)
  if (id === null) for (const [sid, n] of stats.names) if (n === name) { id = +sid; break; }
  if (id !== null) {
    family ??= stats.fam.get(name);
    name = stats.names.get(name) ?? "";
  }
  const fam = family ?? (await weaponFamily(name));
  if (fam === "GRENADE" && !opts.grenade) return null;
  // bare fist: no model. Weapon_Barefist_Knuckle's Hull01 VA has 0 valid vertices of 536 (every position 0, header
  // radius 0), so the exe draws no fist; without this guard pickWeaponModel would land on the Brass Knuckle glb
  if (id === BAREFIST_ID) return null;
  // server throwables are numbered differently in the 2017 packs (throwables.ts ROWS: 407053 is WaterBomb there)
  const packId = id !== null && isServerThrowable(id) ? pack2017Id(id) || pack2017Id(throwableBaseId(id)) || null : id;
  let entry = (packId !== null ? list.find((e) => e.itemIds?.includes(packId)) : undefined) ?? pickWeaponModel(list, name, fam);
  if (!entry) return null;
  if (opts.projectile) entry = list.find((e) => e.id === `${entry!.id}_bomb`) ?? entry;
  const tpl = await loadGlb(entry);
  if (!tpl) return null;
  const object = tpl.clone(true);
  return {
    object,
    muzzle: object.getObjectByName(entry.muzzle ?? "FXDummy") ?? null,
    eject: object.getObjectByName("EmptyCartridgeFXDummy") ?? null,
    entry,
    axis: (tpl.userData.axis as THREE.Matrix4 | undefined)?.clone() ?? new THREE.Matrix4(),
    animator: (view) => loadWeaponAnimSet(entry.id).then((set) => (set ? new WeaponAnimator(object, set, view) : null)),
  };
}
