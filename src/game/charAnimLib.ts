import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { CharAnimator, UpperClass } from "./charAnim";

/*
 * 3rd-person animation library exported from the PB character AI (pb-extract-tools export-anim3pv.mjs ->
 * public/assets/chars/swat_male/anim3pv/): per weapon AI (weapon.pef LinkedToCharaAI) the clip, blend-in time and
 * duration of each upper state (Idle/Move/Attack/LoadMagazine/LoadBullet/Change/..., AttackIdle and Zoom stances),
 * plus the 8-direction Lower states. Bundles are fetched lazily, one per clip folder.
 *
 *   bindWeaponAnim(visual.anim, "K-2")   // after visual.setWeapon(...): the upper body uses K-2's own clips
 */

export interface AnimState {
  /** clip key: path under Chara/SWAT_Male/3PV/ without extension, e.g. "AssultRifle/AK47/Up_Reload" */
  clip: string;
  /** i3AIState blend-in time, seconds */
  blend: number;
  /** i3AIState duration, seconds */
  dur: number;
  loop: boolean;
}
export type StateTable = Record<string, AnimState>;
export interface AnimAI {
  group: string;
  weapon: string;
  driver: string;
  stances: { AttackIdle?: StateTable; Zoom?: StateTable };
}
export interface Anim3pvIndex {
  lower: { Stand: StateTable; Sit: StateTable };
  ai: Record<string, AnimAI>;
  /** AI key "<Group>/<Weapon>" (Upper/3PV tree) -> tables */
  /** weapons.json item id -> AI key */
  weapons: Record<string, string>;
  /** norm(weapons.json name) -> AI */
  names: Record<string, string>;
  /** weapons.json item id -> weapon.pef _ZoomType (only weapons whose AI has a Zoom stance) */
  zoomType: Record<string, number>;
  /** clip key -> bundle file */
  bundles: Record<string, string>;
  /** set by loadAnim3pv: which chars/<skel>/anim3pv this index was read from */
  skel?: string;
}

/**
 * Weapons whose pef AI has no 3PV tree (FAMAS, L115A1, AKS74U, Taurus...) and unknown weapons use the basic PB
 * weapon of their class. [RECRIADO] the choice of fallback AI (PB would not render them without their AI).
 */
export const CLASS_FALLBACK_AI: Record<UpperClass, string> = {
  assault: "AssaultRifle/K-2",
  smg: "SMG/K-1",
  sniper: "SniperRifle/SSG69",
  shotgun: "ShotGun/870MCS",
  handgun: "HandGun/K5",
  knife: "Knife/M-7",
};

const baseOf = (skel: string): string => `/assets/chars/${skel}/anim3pv`;
const indexP = new Map<string, Promise<Anim3pvIndex | null>>();
/** bundle key: skeleton + file (male and female libs have same file names) */
const bundleP = new Map<string, Promise<Map<string, THREE.AnimationClip>>>();

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** `skel`: chars/<skel>/anim3pv. The match uses swat_male; the lobby showroom the char's own skeleton (swat_female has its own poses). */
export function loadAnim3pv(skel = "swat_male"): Promise<Anim3pvIndex | null> {
  let p = indexP.get(skel);
  if (!p) {
    p = fetch(`${baseOf(skel)}/index.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Anim3pvIndex>) : null))
      .then((ix) => { if (ix) ix.skel = skel; return ix; })
      .catch(() => null);
    indexP.set(skel, p);
  }
  return p;
}

/** Pure: AI name for a weapon id/name (null = not in the table). */
export function aiForWeapon(ix: Anim3pvIndex, key: string | number, cls: UpperClass): string {
  const k = String(key);
  const hit = ix.weapons[k] ?? ix.names[norm(k)];
  // dual-wield AIs (DualHandGun/..., DualSMG/...) have Left*/Right* layers instead of Idle: bindWeaponAnim merges them
  const A = hit ? ix.ai[hit]?.stances.AttackIdle : undefined;
  if (A?.Idle || (A?.RightIdle && A.LeftIdle)) return hit!;
  const fb = CLASS_FALLBACK_AI[cls];
  return ix.ai[fb] ? fb : Object.keys(ix.ai)[0];
}

/** Pure: every clip key an AI (both stances) and the lower table need. */
export function clipsFor(ix: Anim3pvIndex, ai: string | null): string[] {
  const keys = new Set<string>();
  for (const S of Object.values(ix.lower)) for (const s of Object.values(S)) keys.add(s.clip);
  const a = ai ? ix.ai[ai] : null;
  // UI_* states (lobby showroom, uiIdleFor) are not part of the match: skip their bundles
  if (a) for (const S of Object.values(a.stances)) for (const [n, s] of Object.entries(S ?? {})) if (!n.startsWith("UI_")) keys.add(s.clip);
  return [...keys];
}

/** Lobby showroom clips of a weapon AI (full skeleton): `stand` loops, `variants` (UI_IdleA/B) play in between, `change` = weapon swap. */
export interface UiIdle { stand: AnimState; variants: AnimState[]; change: AnimState | null }
export function uiIdleFor(ix: Anim3pvIndex, ai: string): UiIdle | null {
  const A = ix.ai[ai]?.stances.AttackIdle;
  const stand = A?.UI_Idle_Stand;
  if (!A || !stand?.clip) return null;
  return { stand, variants: [A.UI_IdleA, A.UI_IdleB].filter((s): s is AnimState => !!s?.clip), change: A.UI_Idle_Change?.clip ? A.UI_Idle_Change : null };
}

/** file name of a weapon folder's family UI bundle (pb-extract-tools export-ui-idle.mjs uiFile) */
const uiFile = (folder: string): string => folder.replace(/[^a-z0-9_.-]/g, "_");
const uiIdleP = new Map<string, Promise<Map<string, THREE.AnimationClip>>>();
/**
 * UI_IdleA/B of a character family (chars/<family>/ui_idle/<weapon folder>.glb, pb-extract-tools export-ui-idle.mjs): clips named by
 * the lower-cased key "<weapon folder>/ui/ui_idlea". Empty when the family has none for that weapon folder.
 */
export function loadFamilyUiIdle(family: string, clipKey: string): Promise<Map<string, THREE.AnimationClip>> {
  const folder = clipKey.toLowerCase().replace(/\/ui\/ui_idle[ab]$/, "");
  const url = `/assets/chars/${family}/ui_idle/${uiFile(folder)}.glb`;
  let p = uiIdleP.get(url);
  if (!p) {
    p = new GLTFLoader().loadAsync(url).then((g) => new Map(g.animations.map((c) => [c.name, c] as const))).catch(() => new Map<string, THREE.AnimationClip>());
    uiIdleP.set(url, p);
  }
  return p;
}

function loadBundle(skel: string, file: string): Promise<Map<string, THREE.AnimationClip>> {
  const key = `${skel}/${file}`;
  let p = bundleP.get(key);
  if (!p) {
    p = new GLTFLoader()
      .loadAsync(`${baseOf(skel)}/${file}`)
      .then((g) => new Map(g.animations.map((c) => [c.name, c] as const)))
      .catch((err) => {
        console.warn(`[anim3pv] ${file} failed`, err);
        return new Map<string, THREE.AnimationClip>();
      });
    bundleP.set(key, p);
  }
  return p;
}

export async function loadClips(ix: Anim3pvIndex, keys: string[]): Promise<Map<string, THREE.AnimationClip>> {
  const files = [...new Set(keys.map((k) => ix.bundles[k]).filter(Boolean))];
  const maps = await Promise.all(files.map((f) => loadBundle(ix.skel ?? "swat_male", f)));
  const out = new Map<string, THREE.AnimationClip>();
  for (const m of maps) for (const [k, c] of m) if (keys.includes(k)) out.set(k, c);
  return out;
}

/**
 * One clip from the two layers of a dual-wield state: every track of `primary` + the tracks of `secondary` on nodes
 * `primary` does not key. The Left* clips key the trunk + the LEFT arm, Right* the same trunk + the RIGHT arm
 * (pb-extract-tools export-anim1pv.mjs / export-anim3pv.mjs DUAL_STATES), so the pair is the whole upper body; the trunk comes
 * from the side that acts (its recoil). Duration = primary's (a longer secondary loop is sampled over that span).
 * Shared by the 1PV viewmodel (weapons/viewmodel.ts dual1pv) and the 3PV animator (dualTables).
 */
export function dualClip(name: string, primary: THREE.AnimationClip, secondary: THREE.AnimationClip): THREE.AnimationClip {
  const node = (t: THREE.KeyframeTrack) => t.name.slice(0, t.name.lastIndexOf("."));
  const own = new Set(primary.tracks.map((t) => t.name));
  const keyed = new Set(primary.tracks.map(node));
  const tracks = [...primary.tracks.map((t) => t.clone())];
  for (const t of secondary.tracks) if (!keyed.has(node(t)) && !own.has(t.name)) tracks.push(t.clone());
  return new THREE.AnimationClip(name, primary.duration, tracks);
}

/**
 * Dual-wield 3PV AI (CGameCharaAnimControl::PlayUpperDual: LeftIdle/RightIdle, LeftMove/RightMove,
 * LeftAttack/RightAttack, one LoadMagazine + Change keying both arms) as the animator's single-layer states, same
 * merge as the 1PV side: Idle = RightIdle+LeftIdle, Move = RightMove+LeftMove, Attack = RightAttack (+LeftIdle),
 * AttackLeft = LeftAttack (+RightIdle), AttackBoth = RightAttack+LeftAttack (DualSMG). Adds the merged clips to
 * `clips`; returns the AI unchanged when it is not dual.
 */
export function dualTables(ai: AnimAI, clips: Map<string, THREE.AnimationClip>, aiName: string): AnimAI {
  const A = ai.stances.AttackIdle;
  if (!A || A.Idle || !A.RightIdle || !A.LeftIdle) return ai;
  const out: StateTable = { ...A };
  const make = (st: string, pri: string, sec: string) => {
    const a = A[pri] && clips.get(A[pri].clip), b = A[sec] && clips.get(A[sec].clip);
    if (!a) return;
    const key = `dual:${aiName}/${st}`;
    clips.set(key, b ? dualClip(key, a, b) : a);
    out[st] = { ...A[pri], clip: key };
  };
  make("Idle", "RightIdle", "LeftIdle");
  make("Move", A.RightMove ? "RightMove" : "RightIdle", A.LeftMove ? "LeftMove" : "LeftIdle");
  make("Attack", "RightAttack", "LeftIdle");
  make("AttackLeft", "LeftAttack", "RightIdle");
  make("AttackBoth", "RightAttack", "LeftAttack");
  return { ...ai, stances: { ...ai.stances, AttackIdle: out } };
}

/** Match preload: the 3PV bundles of a weapon's AI (what bindWeaponAnim downloads on the first actor that holds it). */
export async function preloadWeaponAnim3pv(key: string | number, cls: UpperClass, skel = "swat_male"): Promise<void> {
  const ix = await loadAnim3pv(skel);
  if (ix) await loadClips(ix, clipsFor(ix, aiForWeapon(ix, key, cls)));
}

const bindTok = new WeakMap<CharAnimator, number>();

/**
 * Give an animator the PB tables + clips for a weapon. Resolves after the clips are bound (the animator keeps its
 * model.glb clips until then). Safe to call on every weapon switch; a newer call wins.
 */
export async function bindWeaponAnim(anim: CharAnimator | null | undefined, key: string | number, cls?: UpperClass, skel = "swat_male"): Promise<string | null> {
  if (!anim) return null;
  const tok = (bindTok.get(anim) ?? 0) + 1;
  bindTok.set(anim, tok);
  const male = await loadAnim3pv();
  const ix = skel === "swat_male" ? male : ((await loadAnim3pv(skel)) ?? male); // family without a library: the male poses
  if (!ix) return null;
  const ai = aiForWeapon(ix, key, cls ?? anim.upperClass);
  const need = clipsFor(ix, ai);
  const clips = await loadClips(ix, need);
  // a clip the family library lacks falls back to the male one (same 63-bone skeleton) [INFERIDO]
  if (male && ix !== male) for (const [k, c] of await loadClips(male, need.filter((n) => !clips.has(n)))) clips.set(k, c);
  if (bindTok.get(anim) !== tok) return null;
  const id = ix.weapons[String(key)] ? String(key) : Object.keys(ix.weapons).find((k) => ix.weapons[k] === ai);
  anim.useTables(ix.lower, dualTables(ix.ai[ai], clips, ai), ai, clips, id !== undefined ? ix.zoomType[id] ?? 0 : undefined);
  return ai;
}
