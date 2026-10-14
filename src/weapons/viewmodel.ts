import { setC4Lcd } from "./c4Lcd";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { registerModelCompressedTextures } from "../render/compressedTex";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { loadLodFirst } from "../assetLod";
import { jsonOnce } from "../jsonOnce";
import type { Family, WeaponDef } from "./types";
import { createWeaponModel, type WeaponModelInstance } from "./worldModel";
import type { WeaponAnimator } from "./weaponAnim";
import { PB_VIEWER_MTL, pbCharaMaterial } from "../render/pbLighting";
import { PB_FPS_CAMERA, pbLive } from "../gameplay/pbConfig";
import { resolveChara } from "../game/loadout";
import { dualClip } from "../game/charAnimLib";
import { BAREFIST_ID } from "../game/respawnSelect";
import { DUAL_GRENADE_TIMES, isDualGrenade, throwKind, throwableBaseId } from "./throwables";

// First-person weapon.
//  * Rig mode (default): original 1PV arms (public/assets/chars/<char>/arms_1pv.glb, path from chars/index.json
//    "arms1pv") + the equipped weapon model (worldModel.ts) parented to the arms' WeaponPointDummyRight (GunDummy
//    grip). Clips PER WEAPON from the 2017 PB character AI (pb-extract-tools export-anim1pv.mjs -> chars/<clipsFrom>/anim1pv/,
//    fetched lazily for the equipped weapon): weapon.pef LinkedToCharaAI -> Upper/1PV/<Group>/<Weapon> states
//    Idle, Move, Attack/AttackBurst, LoadMagazine (reload), Change (draw), knife Attack/Attack2/SecondaryAttack,
//    grenade Attack (throw) and, for _ZoomType 2|3, the Zoom stance (Idle/Move/Attack). E.g. AUG A3 Gold ->
//    AssaultRifle/AUG-A3 -> 1PV/AssultRifle3/{Common/AttackIdle, AUG-A3/Attack_Semi, AUG-A3/Reload, ...}.
//    Until those load (or without them) the arms GLB's own assault/handgun/knife clips are used. Driven by the
//    calls WeaponSystem already makes: fireKick() -> Attack, meleeSwing() -> knife attack, reloadT -> LoadMagazine
//    clip time (scale = i3AIState dur / ReloadTime, exe-2017 OnActionLoadMagazine 0xa0cd50), setWeapon()+switchT
//    -> Change clip time, throwT -> grenade Attack. Muzzle = the weapon's FXDummy.
//  * Fallback: weapon model alone, or nothing when no GLB exists (?arms=0 forces weapon-only).
// The viewmodel is drawn last with a depth clear in front of it, so it never clips into walls.

/** crossfade (s) between a knife swing and the swing that restarts it */
const MELEE_BLEND = 0.12;
const HIP = new THREE.Vector3(0.16, -0.17, -0.34);
const ADS = new THREE.Vector3(0, -0.115, -0.28);
/** 1PV camera in the arms GLB (three space, model faces +Z, character right = -X), exe-2017 CGameCamera_FPS 0x689980:
 *  eye = Neck (bone 6) + FPSCamPos, looking along the character's forward with no extra pitch (the view turns with
 *  yaw/pitch only, never with the Neck/Head orientation). ArmsRig recomputes it from the class' AttackIdle Neck; this
 *  default is swat_male (Neck 0.0059/1.5089/-0.0005 + AcidPol FPSCamPos). */
const EYE = new THREE.Vector3(0.0059 - 0.00565, 1.5089 + 0.1392, -0.0005 + 0.029);

const _feet = new THREE.Vector3();
/**
 * A gun / knife / grenade in each hand: dual-wield AIs (DualHandGun / DualSMG / DualShotGun), WeaponDualKnife (one arms
 * set, NET_Fire 0x64ab80 animates both knives) and WeaponDualGrenade (K-413, left grenade +0xa5ec on the left dummy
 * 0x632510). WeaponDual::AttachNode 0x648440: the left weapon goes on WeaponPointDummyLeft, same model, not mirrored.
 * WeaponKnuckle (pef ClassMeta, AutoFireCount 2 + AttackTimeA2): one knuckle per fist. Its pack has <State>_<Gender>_Left /
 * _Right for Idle / Change / AttackA / AttackB like the DualKnife packs. [INFERIDO] attach path not read in the exe.
 */
export function wieldsTwo(w: { id: number; className?: string }, pb: Weapon1pv | null): boolean {
  return !!pb?.dual || w.className === "DualKnife" || (w.className === "Knuckle" && w.id !== BAREFIST_ID) || isDualGrenade(w.id);
}

type ArmsClass = "assault" | "handgun" | "knife";
const armsClassOf = (f: Family): ArmsClass | null =>
  f === "HG" ? "handgun" : f === "KNIFE" ? "knife" : f === "GRENADE" ? null : "assault";

// ---- shared 1PV arms asset ----
interface ArmsAsset {
  scene: THREE.Object3D;
  clips: THREE.AnimationClip[];
  /** base URL of the per-weapon 1PV library of the char the clips come from (chars/<clipsFrom>/anim1pv) */
  anim1pv: string;
}
let armsP: Promise<ArmsAsset | null> | null = null;
let armsChara: { itemId: number; team: 0 | 1 } | null = null;
/** observer: the watched player has no known character (bot / not yet synced): the arms of THAT team's basic character, not the URL / local side's */
let armsTeamFallback: 0 | 1 | null = null;
/**
 * 1PV arms of the local player's equipped character (itemId, ?): call before the WeaponSystem / Viewmodel is created.
 * resolveChara (game/loadout.ts): no model for the itemId -> the side's basic character. ?charArms= still wins.
 */
export function getViewmodelChara(): { itemId: number; team: 0 | 1 } | null {
  return armsChara;
}
export function setViewmodelChara(itemId: number | null | undefined, team: 0 | 1): void {
  const next = itemId ? { itemId, team } : null;
  if (next?.itemId === armsChara?.itemId && next?.team === armsChara?.team) return;
  armsChara = next;
  armsP = null; // the next Viewmodel loads the new arms
}
function loadArms(): Promise<ArmsAsset | null> {
  armsP ??= (async () => {
    const p = new URLSearchParams(location.search);
    if (p.get("arms") === "0") return null;
    // arms of the local character (?charArms=<name> > setViewmodelChara itemId > ?charRed/?charBlue > the side's
    // basic character, loadout.ts resolveChara > first char of the team);
    // skins without clips borrow the 1PV clips of their "clipsFrom" char (swat_male / swat_female)
    type Entry = { name: string; team?: string; family?: string; arms1pv?: { model?: string }; clipsFrom?: string | null; itemId?: number | null; itemIds?: number[] | null };
    let url = "/assets/chars/swat_male/arms_1pv.glb", clipsUrl: string | null = null, anim1pv = "/assets/chars/swat_male/anim1pv";
    try {
      {
        const list = (await jsonOnce<{ chars?: Entry[] }>("/assets/chars/index.json")).chars?.filter((x) => x.arms1pv?.model) ?? [];
        const team = armsChara ? (armsChara.team ? "blue" : "red") : armsTeamFallback !== null ? (armsTeamFallback ? "blue" : "red") : p.get("team")?.toLowerCase().startsWith("b") ? "blue" : "red";
        const want = p.get("charArms") ?? (armsChara || armsTeamFallback !== null ? null : p.get(team === "blue" ? "charBlue" : "charRed"));
        const c = list.find((x) => x.name === want) ??
          resolveChara(list, armsChara?.itemId, armsChara?.team ?? (team === "blue" ? 1 : 0)).entry ??
          list.find((x) => x.team === team) ?? list[0];
        if (!c) return null;
        pbLive.fpsFamily = c.family === "female" ? "female" : "male";
        url = `/assets/chars/${c.arms1pv!.model}`;
        const src = c.clipsFrom ? list.find((x) => x.name === c.clipsFrom) : null;
        anim1pv = `/assets/chars/${src?.name ?? c.name}/anim1pv`;
        if (src && src !== c) clipsUrl = `/assets/chars/${src.arms1pv!.model}`;
      }
    } catch {
      /* default path */
    }
    try {
      const loader = registerModelCompressedTextures(new GLTFLoader());
      const gltf = await loadLodFirst(loader, url);
      let clips = gltf.animations;
      if (!clips.length && clipsUrl) clips = (await loadLodFirst(loader, clipsUrl).catch(() => null))?.animations ?? [];
      if (!clips.length) return null; // no 1PV animation -> weapon-only / procedural
      console.info(`[viewmodel] arms ${url} (${clips.length} clips${clipsUrl ? ` from ${clipsUrl}` : ""})`);
      return { scene: gltf.scene, clips, anim1pv };
    } catch {
      return null;
    }
  })();
  return armsP;
}

// ---- per-weapon 1PV library (pb-extract-tools export-anim1pv.mjs) ----
export interface State1pv {
  /** clip key: path under Chara/<Name>/1PV/ without extension, e.g. "AssultRifle3/AUG-A3/Reload" */
  clip: string;
  /** i3AIState blend-in time (s) */
  blend: number;
  /** i3AIState duration (s) */
  dur: number;
  loop: boolean;
}
export type Table1pv = Record<string, State1pv>;
export interface Anim1pvIndex {
  ai: Record<string, { group: string; weapon: string; stances: { AttackIdle?: Table1pv; Zoom?: Table1pv } }>;
  /** weapons.json item id -> AI key "<Group>/<Weapon>" */
  weapons: Record<string, string>;
  names: Record<string, string>;
  /** item id -> weapon.pef _ZoomType */
  zoomType: Record<string, number>;
  /** item id -> why it uses a substitute AI ([RECRIADO]) */
  fallback: Record<string, string>;
  /** clip key -> bundle file */
  bundles: Record<string, string>;
}
export interface Weapon1pv {
  ai: string;
  /** dual-wield AI (DualHandGun / DualSMG / DualShotGun): Idle / Move / Attack / AttackLeft are merged Left+Right layers */
  dual?: boolean;
  A: Table1pv;
  /** Zoom stance, only for weapon.pef _ZoomType 2|3 (_CharaChangeAIContext 0xa1beb0, same rule as 3PV) */
  Z: Table1pv | null;
  clips: Map<string, THREE.AnimationClip>;
}
/**
 * [RECRIADO] AI for weapons without their own 1PV tree in the 2017 I3CHR (unknown ids): the basic PB weapon of the
 * family. Keep in sync with pb-extract-tools export-anim1pv.mjs CLASS_FALLBACK.
 */
export const CLASS_FALLBACK_1PV: Record<Family, string> = {
  AR: "AssaultRifle/K-2", SMG: "SMG/K-1", MG: "MG/RPD", SR: "SniperRifle/SSG69", SG: "ShotGun/870MCS", HG: "HandGun/K5",
  KNIFE: "Knife/M-7", GRENADE: "Throwing/K-400", OTHER: "AssaultRifle/K-2",
};
const normKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const index1pv = new Map<string, Promise<Anim1pvIndex | null>>();
const bundle1pv = new Map<string, Promise<Map<string, THREE.AnimationClip>>>();

function loadIndex1pv(base: string): Promise<Anim1pvIndex | null> {
  let p = index1pv.get(base);
  if (!p) {
    p = fetch(`${base}/index.json`)
      .then((r) => (r.ok && (r.headers.get("content-type") ?? "").includes("json") ? (r.json() as Promise<Anim1pvIndex>) : null))
      .catch(() => null);
    index1pv.set(base, p);
  }
  return p;
}

function loadBundle1pv(url: string): Promise<Map<string, THREE.AnimationClip>> {
  let p = bundle1pv.get(url);
  if (!p) {
    p = new GLTFLoader()
      .loadAsync(url)
      .then((g) => new Map(g.animations.map((c) => [c.name, c] as const)))
      .catch((err) => {
        console.warn(`[viewmodel] ${url} failed`, err);
        return new Map<string, THREE.AnimationClip>();
      });
    bundle1pv.set(url, p);
  }
  return p;
}

/** Pure: 1PV AI of a weapon (pef LinkedToCharaAI resolved by the exporter, else the family's basic weapon). */
export function ai1pvFor(ix: Anim1pvIndex, w: { id: number; name: string; family: Family }): string | null {
  // items weapons.json lacks (C-5 PBWC2016 407053) use their class base AI (throwables.ts: Throwing/C5, not the K-400)
  const hit = ix.weapons[String(w.id)] ?? ix.weapons[String(throwableBaseId(w.id))] ?? ix.names[normKey(w.name)];
  const A = hit ? ix.ai[hit]?.stances.AttackIdle : undefined;
  if (A?.Idle || (A?.LeftIdle && A?.RightIdle)) return hit!;
  const fb = CLASS_FALLBACK_1PV[w.family];
  return ix.ai[fb]?.stances.AttackIdle?.Idle ? fb : null;
}

/** Tables + clips of the equipped weapon (only its bundles are downloaded). null = keep the arms GLB clips. */
export async function loadWeapon1pv(base: string, w: { id: number; name: string; family: Family }): Promise<Weapon1pv | null> {
  const ix = await loadIndex1pv(base);
  if (!ix) return null;
  const ai = ai1pvFor(ix, w);
  if (!ai) return null;
  const st = ix.ai[ai].stances, zt = ix.zoomType[String(w.id)];
  const A = st.AttackIdle!, Z = (zt === 2 || zt === 3) && st.Zoom?.Idle ? st.Zoom : null;
  const keys = new Set([...Object.values(A), ...Object.values(Z ?? {})].map((s) => s.clip));
  const files = [...new Set([...keys].map((k) => ix.bundles[k]).filter(Boolean))];
  const maps = await Promise.all(files.map((f) => loadBundle1pv(`${base}/${f}`)));
  const clips = new Map<string, THREE.AnimationClip>();
  for (const m of maps) for (const [k, c] of m) if (keys.has(k)) clips.set(k, c);
  if (A.LeftIdle && A.RightIdle && !A.Idle) return dual1pv(ai, A, clips);
  if (!clips.get(A.Idle.clip)) return null;
  return { ai, A, Z, clips };
}

/**
 * Match preload: the local character's arms (setViewmodelChara first) and the 1PV clips of these weapons, into the shared
 * caches the Viewmodel reads (setWeapon only loads the weapon in hand: the first swap to the pistol waited for 4 GLBs).
 */
export async function preloadViewmodel(defs: { id: number; name: string; family: Family }[]): Promise<void> {
  const a = await loadArms();
  if (a) await Promise.all(defs.map((w) => loadWeapon1pv(a.anim1pv, w).catch(() => null)));
}

/** Dual-wield layer merge: game/charAnimLib.ts dualClip (shared with the 3PV animator). */
export { dualClip };

/**
 * Dual-wield 1PV (DualHandGun/DesertEagle: LeftIdle/RightIdle, LeftMove/RightMove, LeftAttack/RightAttack, one
 * LoadMagazine + Change keying both arms): the viewmodel's single-layer states are built from merged pairs -
 * Idle = RightIdle+LeftIdle, Move = RightMove+LeftMove, Attack = RightAttack (+LeftIdle), AttackLeft = LeftAttack
 * (+RightIdle). WeaponSystem alternates the hands per shot (Viewmodel.fireKick(left)).
 */
function dual1pv(ai: string, A: Table1pv, clips: Map<string, THREE.AnimationClip>): Weapon1pv | null {
  const c = (st: string) => (A[st] ? clips.get(A[st].clip) : undefined);
  const out: Table1pv = { ...A };
  const make = (st: string, pri: string, sec: string) => {
    const a = c(pri), b = c(sec);
    if (!a) return;
    const key = `dual:${ai}/${st}`;
    clips.set(key, b ? dualClip(key, a, b) : a);
    out[st] = { ...A[pri], clip: key };
  };
  make("Idle", "RightIdle", "LeftIdle");
  make("Move", A.RightMove ? "RightMove" : "RightIdle", A.LeftMove ? "LeftMove" : "LeftIdle");
  make("Attack", "RightAttack", "LeftIdle");
  make("AttackLeft", "LeftAttack", "RightIdle");
  make("AttackBoth", "RightAttack", "LeftAttack"); // DualSMG: both guns fire each shot (arms: both attacks, 0xa0b977)
  if (A.RightJumpStart && A.LeftJumpStart) make("JumpStart", "RightJumpStart", "LeftJumpStart");
  if (A.RightJumpEnd && A.LeftJumpEnd) make("JumpEnd", "RightJumpEnd", "LeftJumpEnd");
  if (!out.Idle || !clips.get(out.Idle.clip)) return null;
  return { ai, A: out, Z: null, clips, dual: true };
}

// The viewmodel is lit like the chara it belongs to: the PB Phong_D_Dir_ shader with the map's
// directional light + ambient and the local player's light-volume material colour (PB_VIEWER_MTL).
/** Makes an object render as part of the viewmodel pass (after the world, after the depth clear). */
function toViewmodelPass(o: THREE.Object3D): void {
  o.traverse((n) => {
    const m = n as THREE.Mesh;
    if (!m.isMesh) return;
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = false;
    const conv = (mm: THREE.Material) => {
      if (mm.userData.vm) return mm;
      const c = pbCharaMaterial(mm, PB_VIEWER_MTL);
      c.transparent = true; // transparent queue renders after all world geometry (incl. world transparents)
      c.userData.vm = true;
      return c;
    };
    m.material = Array.isArray(m.material) ? m.material.map(conv) : conv(m.material);
  });
}

class ArmsRig {
  readonly root = new THREE.Group(); // camera space; model under a 180° flip so +Z faces -Z
  readonly mixer: THREE.AnimationMixer;
  readonly hand: THREE.Object3D | null;
  /** WeaponPointDummyLeft: the weapon's parent during left-hand states (weaponAnim.ts leftGrip) */
  readonly handL: THREE.Object3D | null;
  private clips = new Map<string, THREE.AnimationClip>();
  private base: {
    idle?: THREE.AnimationAction; move?: THREE.AnimationAction; zoom?: THREE.AnimationAction; zoomMove?: THREE.AnimationAction;
  } = {};
  private shot: THREE.AnimationAction | null = null;
  private shotZoom = false;
  private driven: THREE.AnimationAction | null = null; // reload/change: time set from WeaponSystem progress
  /** i3AIState duration of the driven state (clip duration in class mode) */
  drivenDur = 0;
  cls: ArmsClass = "assault";
  /** per-weapon PB tables (null = class clips of the arms GLB) */
  pb: Weapon1pv | null = null;
  current = "";
  onClip: ((name: string) => void) | null = null;
  private moveW = 0;
  private zoomW = 0;
  private zoomOn = false;
  private flip: THREE.Group;
  private model: THREE.Object3D;
  private neck: THREE.Object3D | null;

  constructor(asset: ArmsAsset) {
    const model = SkeletonUtils.clone(asset.scene);
    toViewmodelPass(model);
    const flip = new THREE.Group();
    flip.rotation.y = Math.PI;
    flip.position.set(EYE.x, -EYE.y, EYE.z); // after the flip: eye -> origin
    flip.add(model);
    this.root.add(flip);
    this.flip = flip;
    this.model = model;
    this.neck = model.getObjectByName("Neck") ?? null;
    this.mixer = new THREE.AnimationMixer(model);
    for (const c of asset.clips) this.clips.set(c.name, c);
    this.hand = model.getObjectByName("WeaponPointDummyRight") ?? model.getObjectByName("R_Hand") ?? null;
    this.handL = model.getObjectByName("WeaponPointDummyLeft") ?? null;
  }

  private find(re: RegExp, cls = this.cls): THREE.AnimationClip | null {
    for (const [k, c] of this.clips) if (k.startsWith(`${cls}/`) && re.test(k.slice(cls.length + 1))) return c;
    return null;
  }

  /** PB state of the equipped weapon's AttackIdle (or Zoom) stance with its clip. */
  private st(name: string, zoom = false): { c: THREE.AnimationClip; s: State1pv } | null {
    const T = zoom && this.pb?.Z ? this.pb.Z : this.pb?.A;
    const s = T?.[name];
    const c = s ? this.pb!.clips.get(s.clip) : undefined;
    return s && c ? { c, s } : null;
  }

  /** i3AIState duration of a state of the equipped weapon's table (null without PB tables) */
  stateDur(name: string): number | null {
    const x = this.st(name);
    return x ? (x.s.dur > 0 ? x.s.dur : x.c.duration) : null;
  }

  has(kind: "reload" | "change"): boolean {
    if (this.pb) return !!this.st(kind === "reload" ? "LoadMagazine" : "Change");
    return !!(kind === "reload" ? this.find(/(^|\/)Reload(_A)?$/i) : this.find(/(^|\/)Change$/i));
  }

  /** Class clips of the arms GLB (fallback while / when the weapon's PB tables are not available). */
  setClass(cls: ArmsClass): void {
    this.cls = cls;
    this.pb = null;
    this.startBase();
  }

  /** The equipped weapon's own 1PV tables (loadWeapon1pv). */
  usePB(pb: Weapon1pv): void {
    this.pb = pb;
    this.startBase();
  }

  private startBase(): void {
    this.mixer.stopAllAction();
    this.shot = this.driven = null;
    const taken: THREE.AnimationClip[] = [];
    const act = (c: THREE.AnimationClip | null | undefined) => {
      if (!c || taken.includes(c)) return undefined; // one action per clip (Zoom.Move is often Zoom.Idle's clip)
      taken.push(c);
      const a = this.mixer.clipAction(c);
      a.reset().setEffectiveWeight(0).play();
      return a;
    };
    if (this.pb) {
      const z = !!this.pb.Z;
      this.base = {
        idle: act(this.st("Idle")?.c), move: act(this.st("Move")?.c),
        zoom: z ? act(this.st("Idle", true)?.c) : undefined, zoomMove: z ? act(this.st("Move", true)?.c) : undefined,
      };
    } else {
      this.base = { idle: act(this.find(/^AttackIdle$/i)), move: act(this.find(/^Move_AttackIdle$/i)), zoom: act(this.find(/^AttackIdle_Zoom$/i)) };
    }
    this.base.idle?.setEffectiveWeight(1);
    this.mixer.update(0);
    this.mountEye();
  }

  /** Puts the camera (root origin) at Neck + FPSCamPos of the current pose, every frame: CGameCamera_FPS 0x689980 reads
   *  the animated Neck world position. Most upper clips hold the Neck still, but the sniper LoadMagazine / LoadBullet
   *  (SSG69 / L115A1 / Cheytac Reload, ReloadC) shift it ~2.5 cm: a once-per-class eye left the arms off the view.
   *  Only the position: the view never turns with the Neck. */
  private mountEye(): void {
    if (!this.neck) return;
    this.model.updateWorldMatrix(true, true);
    const n = this.model.worldToLocal(this.neck.getWorldPosition(new THREE.Vector3()));
    const c = PB_FPS_CAMERA.fpsCamPos[pbLive.fpsFamily]; // view space: x right, y up, z -forward
    const eye = n.add(new THREE.Vector3(-c[0], c[1], -c[2]));
    this.flip.position.set(eye.x, -eye.y, eye.z);
  }

  /** a one-shot / driven state whose clip is also a base stance (AUG Zoom.Attack = AttackIdle_Zoom) gets its own
   *  action: sharing the looping base action turned the stance LoopOnce */
  private own(c: THREE.AnimationClip): THREE.AnimationClip {
    const b = this.base;
    if (![b.idle, b.move, b.zoom, b.zoomMove].some((a) => a?.getClip() === c)) return c;
    let d = this.dup.get(c);
    if (!d) this.dup.set(c, (d = c.clone()));
    return d;
  }
  private dup = new Map<THREE.AnimationClip, THREE.AnimationClip>();
  /** one-shot fade-in weight, set by hand (a fadeIn interpolant runs one frame ahead of the base weights: sum < 1) */
  private shotW = 1;
  /** the running one-shot stays on its last frame (grenade AttackReady) */
  private shotHold = false;

  /** seconds the running one-shot takes to fade in / the one it replaces takes to fade out (a gun shot: ~2 frames) */
  private shotRamp = 0.03;

  private oneShot(c: THREE.AnimationClip | null | undefined, timeScale = 1, zoom = this.zoomOn, blend = 0): boolean {
    if (!c) return false;
    this.shotHold = false;
    this.driven?.stop();
    this.driven = null;
    const a = this.mixer.clipAction(this.own(c));
    this.shotRamp = blend > 0 ? blend : 0.03;
    if (this.shot && this.shot !== a) this.shot.fadeOut(blend > 0 ? blend : 0.05);
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    // held on its last frame and faded out by update(): a LoopOnce action that ends is disabled inside mixer.update,
    // so that frame blended the arms' bind pose in (the weapon "blinked" on every shot)
    a.clampWhenFinished = true;
    a.timeScale = timeScale;
    if (this.shot !== a) this.shotW = 0; // re-fire of the same state: instant restart
    a.setEffectiveWeight(this.shotW).play();
    this.shot = a;
    this.shotZoom = zoom;
    this.onClip?.(c.name);
    return true;
  }

  /**
   * Bolt cycle after a shot (NeedToLoadBullet: OnLoadBullet 0xa14ef0, the Fire state of bolt rifles is the 1-frame
   * idle.i3a so LoadBullet follows the shot): the hip table's LoadBullet (L115A1 / SSG69 ReloadC) over `time` s.
   * The hip stance: the shot drops the zoom (0xa14ef0 _Idle_Camera), which would cancel a Zoom-table one-shot.
   */
  loadBullet(time: number): boolean {
    if (!this.pb) return false;
    const x = this.st("LoadBullet");
    return !!x && this.oneShot(x.c, x.c.duration / Math.max(0.05, time), false);
  }

  /** ExtensionActivate / ExtensionDeactivate (silencer on / off, weapon.pef _Extension Silencer), stretched over `duration` s */
  extAnim(on: boolean, duration: number): boolean {
    const x = this.st(on ? "ExtensionActivate" : "ExtensionDeactivate");
    return !!x && this.oneShot(x.c, x.c.duration / Math.max(0.05, duration), false);
  }

  /** Attack state; AttackBurst for burst-mode weapons [RECRIADO: the exe rule between the two is not decoded]. */
  fire(semi: boolean, burst: boolean, left: boolean | "both" = false): void {
    if (this.pb) {
      if (left && this.pb.dual) {
        this.oneShot(this.st(left === "both" ? "AttackBoth" : "AttackLeft")?.c ?? this.st("Attack")?.c);
        return;
      }
      this.oneShot(((burst ? this.st("AttackBurst", this.zoomOn) : null) ?? this.st("Attack", this.zoomOn))?.c);
      return;
    }
    const c = semi ? this.find(/(^|\/)Attack_Semi$/i) ?? this.find(/^Attack$/i) : this.find(/^Attack$/i) ?? this.find(/(^|\/)Attack_Burst$/i);
    this.oneShot(c);
  }

  /** Bomb Mission C4: the Install clip (the Mission/C4 AI's Attack state, 5.667 s) while the plant is held; `on` false drops it back to the stance */
  plant(on: boolean): void {
    if (on) {
      if (!this.shot) this.oneShot(this.st("Attack")?.c);
    } else if (this.shot) {
      this.shot.fadeOut(0.1);
      this.shot = null;
    }
  }

  /**
   * knife: LMB = the AI's Attack state (Attack_A, M-7 0.5 s; pef AttackTimeA1 0.18 is the hit inside it), RMB = SecondaryAttack
   * (Attack_Stab 1 s; AttackTimeB1 0.31). Real time: a swing restarts at FireDelay (0.4 s) and cuts the clip's tail, as a
   * restarted i3AIState does. The old LMB alternation with Attack2 was invented: that clip (Attack_B) lasts 0.167 s, less than
   * the A1 hit time, so it is no full swing; it stays unused [INFERIDO: the exe's use of Attack2 is not decoded].
   */
  melee(heavy: boolean, _interval = 0, _dual = false): void {
    if (this.pb) {
      const x = heavy ? this.st("SecondaryAttack") : this.st("Attack");
      if (this.swing(x?.c)) return;
    }
    const c = (heavy ? this.find(/(^|\/)Attack_Stab$/i) : this.find(/(^|\/)Attack_A$/i)) ?? this.find(/^Attack(_A)?$/i);
    this.swing(c);
  }

  /**
   * A swing started while the previous one still runs (FireDelay 0.55 s vs the 1.13 s Attack_A of the Kukri / Fang Blade):
   * the old pose fades into the new swing over MELEE_BLEND on a second copy of the clip, instead of the same action snapping
   * back to frame 0 (that read as the swing being cancelled). Gun shots keep the instant restart. [INFERIDO]
   */
  private swing(c: THREE.AnimationClip | null | undefined): boolean {
    if (!c) return false;
    const cur = this.shot?.getClip();
    if (!cur || this.shotHold || (cur !== c && cur !== this.swingAlt.get(c))) return this.oneShot(c);
    let alt = this.swingAlt.get(c);
    if (!alt) this.swingAlt.set(c, (alt = c.clone()));
    return this.oneShot(cur === c ? alt : c, 1, this.zoomOn, MELEE_BLEND);
  }
  private swingAlt = new Map<THREE.AnimationClip, THREE.AnimationClip>();

  /**
   * grenade throw: the Throwing AI's Attack state (K-400: THROW/Common/AttackC), real time. C5: the brick's throw is
   * SecondaryAttack (c5/Common/Attack_A, 1 s = the brick pack's C5_BOMB_ATTACK_A 1 s) and Attack (Attack_B, 0.667 s = the
   * bomb trigger's C5_SWITCH_ATTACK_B) is the press of the detonator [INFERIDO: pairing by clip length]
   */
  throwAnim(secondary = false): boolean {
    return this.oneShot((secondary ? this.st("SecondaryAttack") : null)?.c ?? this.st("Attack")?.c);
  }

  /** bomb trigger press (C5 detonator in the hand) */
  pressAnim(): boolean {
    return this.oneShot(this.st("Attack")?.c);
  }

  /**
   * grenade pin pull: the Throwing AI's AttackReady (K-400 THROW/Common/AttackA, 0.333 s; WeaponGrenade::FireReady
   * 0x630b80), played once and held on its last frame (no fade back to Idle) until throwAnim replaces it
   */
  readyAnim(): boolean {
    const ok = this.oneShot(this.st("AttackReady")?.c);
    this.shotHold = ok;
    return ok;
  }

  /** the running one-shot is a reaction (jump / hit): a shot, reload or draw replaces it, never the other way round */
  private reacting: THREE.AnimationAction | null = null;

  /**
   * JumpStart / JumpEnd / Damage<side>A of the weapon's own AI (the arms' clips; the 3PV upper ones are the idle pose).
   * Skipped while a shot (not another reaction) or a driven reload / draw runs. Zoom stance: its own table first.
   */
  reaction(...states: string[]): boolean {
    if (!this.pb || this.driven || (this.shot && this.shot !== this.reacting)) return false;
    for (const n of states) {
      const x = this.st(n, this.zoomOn) ?? this.st(n);
      if (!x || !this.oneShot(x.c, 1, this.zoomOn, x.s.blend)) continue;
      this.reacting = this.shot;
      return true;
    }
    return false;
  }

  /** the AI has a LoadMagazineReady arm clip (shotgun reload opening) */
  hasReady(): boolean {
    return !!this.st("LoadMagazineReady");
  }

  /** Start a clip whose time is driven by progress (reload/change). Returns false when the class lacks it. */
  drive(kind: "reload" | "change", state?: string): boolean {
    let c: THREE.AnimationClip | null | undefined, dur = 0;
    if (this.pb) {
      const x = this.st(state ?? (kind === "reload" ? "LoadMagazine" : "Change"));
      c = x?.c;
      dur = x ? (x.s.dur > 0 ? Math.min(x.s.dur, x.c.duration) : x.c.duration) : 0;
    } else {
      c = kind === "reload" ? this.find(/(^|\/)Reload(_A)?$/i) : this.find(/(^|\/)Change$/i);
      dur = c?.duration ?? 0;
    }
    if (!c) return false;
    this.shot?.stop();
    this.shot = null;
    if (this.driven) this.driven.stop();
    const a = this.mixer.clipAction(this.own(c));
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.timeScale = 0;
    a.setEffectiveWeight(1).play();
    this.driven = a;
    this.drivenDur = dur;
    this.onClip?.(c.name);
    return true;
  }

  /** driven clip at progress 0..1 of the state duration */
  setDriven(progress: number): void {
    this.setDrivenTime(THREE.MathUtils.clamp(progress, 0, 1) * this.drivenDur);
  }

  /** driven clip at `t` seconds of clip time */
  setDrivenTime(t: number): void {
    if (!this.driven) return;
    this.driven.time = THREE.MathUtils.clamp(t, 0, this.driven.getClip().duration * 0.999);
  }

  endDriven(): void {
    if (!this.driven) return;
    this.driven.fadeOut(0.12);
    this.driven = null;
  }

  update(dt: number, moving: boolean, zoom: boolean): void {
    const k = 1 - Math.exp(-10 * dt);
    const { idle, move, zoom: z, zoomMove: zm } = this.base;
    this.zoomOn = zoom && !!z;
    // a zoom-stance one-shot (AUG Zoom.Attack = AttackIdle_Zoom, 2 s) must not hold the zoom pose after un-zooming
    if (this.shot && this.shotZoom !== this.zoomOn) {
      this.shot.fadeOut(0.1);
      this.shot = null;
    }
    this.moveW += ((moving ? 1 : 0) - this.moveW) * k;
    this.zoomW += ((this.zoomOn ? 1 : 0) - this.zoomW) * k;
    if (this.shot && !this.shotHold && this.shot.time >= this.shot.getClip().duration - 1e-4) {
      this.shot.fadeOut(0.05); // finished: back to the stance (the fading action only adds weight above 1)
      this.shot = null;
    }
    if (this.shot) {
      this.shotW = Math.min(1, this.shotW + dt / this.shotRamp);
      this.shot.setEffectiveWeight(this.shotW);
    }
    const over = this.driven ? 1 : this.shot ? this.shotW : 0;
    const rest = 1 - over;
    const zw = z ? this.zoomW : 0;
    // the hip Move only plays un-zoomed; the Zoom stance has its own Move (K-1 MOVE_ZOOMIDLE) or keeps its Idle
    const mw = move ? this.moveW * (1 - zw) : 0, zmw = zm ? this.moveW * zw : 0;
    idle?.setEffectiveWeight(Math.max(0, 1 - mw - zw) * rest + 1e-4);
    move?.setEffectiveWeight(mw * rest);
    z?.setEffectiveWeight((zw - zmw) * rest);
    zm?.setEffectiveWeight(zmw * rest);
    this.mixer.update(dt);
    this.mountEye(); // the eye follows the animated Neck (sniper Reload / ReloadC move it ~2.5 cm)
    const name = this.driven?.getClip().name ?? this.shot?.getClip().name ??
      (zw > 0.5 ? (zmw > zw / 2 ? zm : z)?.getClip().name : mw > 0.5 ? move?.getClip().name : idle?.getClip().name) ?? "";
    if (name !== this.current) {
      this.current = name;
      this.onClip?.(name);
    }
  }
}

const animLog = typeof location !== "undefined" && new URLSearchParams(location.search).has("animlog");

export class Viewmodel {
  readonly group = new THREE.Group();
  private holder = new THREE.Group();
  private current: THREE.Object3D | null = null;
  readonly muzzle = new THREE.Object3D();
  private eject = new THREE.Object3D();
  /** dual wield: FXDummy / EmptyCartridgeFXDummy of the LEFT-hand gun (WeaponPointDummyLeft) */
  readonly muzzleL = new THREE.Object3D();
  private ejectL = new THREE.Object3D();
  /** the equipped weapon is dual-wield with a gun mounted in each hand */
  dual = false;
  /** hand of the current / last shot (dual): muzzle, eject and Attack state follow it */
  side: "R" | "L" = "R";
  private rigWeaponL: THREE.Object3D | null = null;
  /** FXLaserSightDummy of the mounted model (laser.ts beam), null when absent */
  laserDummy: THREE.Object3D | null = null;
  private base: string;
  private family: Family = "AR";
  private semi = false;
  private burst = false;
  private aimingNow = false;
  private token = 0;
  private anim1pv = "";
  private rig: ArmsRig | null = null;
  private rigActive = false;
  private rigWeapon: THREE.Object3D | null = null;
  private raising = false;
  private reloadingClip = false;
  private lastReloadT = -1;

  // animation state
  private t = 0;
  private bobPhase = 0;
  private sway = new THREE.Vector2();
  private lastYaw = 0;
  private lastPitch = 0;
  private kick = 0;
  private kickVel = 0;
  private adsT = 0;
  private swing = 0;
  private swingHeavy = false;
  switchT = 1; // 0 = lowered, 1 = raised
  reloadT = -1; // -1 idle, 0..1 progress
  /** WeaponSystem pbReloadScale (Quick Change Reload: 1.25): the LoadMagazine state runs over ReloadTime / scale */
  reloadScale = 1;
  throwT = -1;
  /** grenade pin out (WeaponSystem flag 8): the Throwing AI's AttackReady, held on its last frame until the release */
  throwReady = false;
  private lastThrowReady = false;
  /** length of the running throw (s): WeaponSystem sets it from throwDuration() */
  throwTotal = 1;
  hidden = false;

  constructor(camera: THREE.Camera, base: string) {
    this.base = base;
    this.group.add(this.holder);
    camera.add(this.group);
    this.group.renderOrder = 10;
    // depth clear right before the viewmodel pass: first object of the (transparent) viewmodel group
    const clear = new THREE.Mesh(
      new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, 0, -1, 0.001, 0, -1, 0, 0.001, -1], 3)),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false, transparent: true })
    );
    clear.frustumCulled = false;
    clear.renderOrder = -1000;
    clear.onBeforeRender = (renderer) => renderer.clearDepth();
    this.group.add(clear);
    this.buildRig();
  }

  /** last buildRig: an older arms load that finishes after a newer one is dropped */
  private rigTok = 0;

  private buildRig(): void {
    const tok = ++this.rigTok;
    void loadArms().then((a) => {
      // a spectate target's arms still loading when the respawn asks for the own ones back (setArms) used to land last and
      // stay on screen for the whole next round (a bot's basic character, its clips' hand height)
      if (!a || tok !== this.rigTok) return;
      if (this.rig) { this.holder.remove(this.rig.root); this.rigActive = false; this.rigWeapon = null; }
      this.rig = new ArmsRig(a);
      this.anim1pv = a.anim1pv;
      if (animLog) this.rig.onClip = (n) => console.info(`[anim] 1pv: ${n}`);
      this.holder.add(this.rig.root);
      this.rig.root.visible = false;
      if (this.lastDef) this.setWeapon(this.lastDef, this.observing, this.noDraw); // observing: the rebuilt arms of the new target must mount too
    });
  }

  /** Observer mode: the arms of another character (skin), or the own ones back (setViewmodelChara + rebuild). */
  setArms(c: { itemId: number; team: 0 | 1 } | null, team: 0 | 1 | null): void {
    const before = armsChara, beforeTeam = armsTeamFallback;
    setViewmodelChara(c?.itemId, c?.team ?? team ?? 0);
    armsTeamFallback = c ? null : team; // no skin known: the basic character of the watched team (null = the local side again)
    if (armsChara?.itemId === before?.itemId && armsChara?.team === before?.team && !!armsChara === !!before && armsTeamFallback === beforeTeam) return;
    armsP = null;
    this.buildRig();
  }

  private lastDef: WeaponDef | null = null;

  /** Name of the 1PV clip currently dominant ("" in procedural mode). */
  get activeClip(): string {
    return this.rigActive && this.rig ? this.rig.current : "";
  }

  /** Bomb Mission C4: hold the plant (Install clip on the arms) / release */
  plantHold(on: boolean): void {
    if (this.rigActive) this.rig?.plant(on);
    if (!on) this.plantProgress(null);
  }

  /** the C4 in hand: its LCD follows the install progress (null = display off) */
  plantProgress(p: number | null): void {
    const root = this.rigWeapon ?? this.current;
    if (root) setC4Lcd(root, p === null ? 1 : 1 + Math.min(5, Math.floor(p * 6)));
  }

  /** C5 detonator pressed */
  pressTrigger(): void {
    if (this.rigActive) this.rig?.pressAnim();
  }

  /** Observer mode: the arms show another player's weapon; the own slot changes (respawn menu, equip) must not touch them */
  observing = false;

  /** the mounted weapon is shown as it is held (observer: a new target / view): no equip Change clip on mount */
  private noDraw = false;

  setWeapon(w: WeaponDef, force = false, noDraw = false): void {
    if (this.observing && !force) return;
    this.noDraw = noDraw;
    const tok = ++this.token;
    this.lastDef = w;
    this.family = w.family;
    this.semi = w.fireMode === "semi" || w.fireMode === "bolt" || w.fireMode === "pump";
    this.burst = w.fireMode === "burst";
    this.raising = true;
    const cls = armsClassOf(w.family);
    const grenade = w.family === "GRENADE";
    const wantRig = !!this.rig && (!!cls || grenade);
    // the PB arms stay up (old weapon hidden) while the next weapon loads: in rig mode `current` is always null, so the
    // old test mounted the procedural placeholder on every switch (seen after a grenade throw -> previous weapon)
    const keepRig = this.rigActive && wantRig;
    // no invented model: nothing is drawn until the real arms + weapon GLB are mounted
    if (keepRig) {
      if (this.rigWeapon) this.rigWeapon.visible = false;
    } else this.detachCurrent();
    // the weapon's model (grenades by item id: K-400 -> k_400.glb) + its own 1PV tables, fetched for this weapon only
    const pbP = wantRig && this.anim1pv ? loadWeapon1pv(this.anim1pv, w).catch(() => null) : Promise.resolve(null);
    // a failed model load must still end in something in the hand: the old weapon was hidden above (keepRig)
    // C5: the hand holds the bomb trigger; the brick (projectile model) is only shown during the throw clip
    const model = createWeaponModel(w.id ?? w.name, w.family, { grenade }).catch((e) => { console.warn(`[viewmodel] weapon ${w.id}`, e); return null; });
    // bare fist: the original has no weapon model (Weapon_Barefist_Knuckle Hull01 empty), so the arms alone hold it
    const bare = w.id === BAREFIST_ID;
    void Promise.all([model, pbP]).then(([inst, pb]) => {
      if (tok !== this.token) return;
      if (animLog) console.info(`[anim] 1pv ${w.id} ${w.name}: ${pb ? pb.ai : `class clips (${cls})`}`);
      if ((inst || bare) && wantRig && this.rig?.hand && (cls || pb)) this.mountRig(inst, cls ?? "assault", pb);
      else if (inst && !grenade) this.mountWeaponOnly(inst);
      else if (keepRig) this.detachCurrent(); // nothing to show on the arms
    });
  }

  private detachCurrent(): void {
    if (this.current) this.current.removeFromParent();
    this.current = null;
    if (this.rigWeapon) this.rigWeapon.removeFromParent();
    this.rigWeapon = null;
    if (this.rigWeaponL) this.rigWeaponL.removeFromParent();
    this.rigWeaponL = null;
    this.rigBrick?.removeFromParent();
    this.rigBrick = null;
    this.dual = false;
    this.side = "R";
    if (this.rig) this.rig.root.visible = false;
    this.rigActive = false;
    this.wAnim = null;
    this.wAnimL = null;
    this.wChangingL = false;
    this.wReloadL = -1;
    this.wReloadingL = false;
    this.wAnimTok++;
  }

  /** Weapon GLB without arms: three-space model (barrel +Z) turned to face -Z, grip at the old hip anchor. */
  private mountWeaponOnly(inst: WeaponModelInstance) {
    this.detachCurrent();
    toViewmodelPass(inst.object);
    const ax = new THREE.Group();
    ax.matrixAutoUpdate = false;
    ax.matrix.copy(inst.axis);
    ax.add(inst.object);
    const g = new THREE.Group();
    g.rotation.y = Math.PI;
    g.position.set(0, -0.02, 0.12);
    g.add(ax);
    this.current = g;
    this.holder.add(g);
    this.attachMarkers(inst);
    this.bindWeaponAnim(inst);
  }

  /** `inst` null = bare hands (the bare fist): the arms play the weapon's clips with nothing in the hand */
  private mountRig(inst: WeaponModelInstance | null, cls: ArmsClass, pb: Weapon1pv | null) {
    const rig = this.rig!;
    this.detachCurrent();
    if (inst) {
      toViewmodelPass(inst.object);
      rig.hand!.add(inst.object);
      this.rigWeapon = inst.object;
    }
    if (this.lastDef && throwKind(this.lastDef) === "c5") this.mountBrick(this.lastDef);
    rig.root.visible = true;
    this.rigActive = true;
    if (pb) rig.usePB(pb);
    else rig.setClass(cls);
    this.reloadingClip = false;
    this.lastReloadT = -1;
    this.autoDraw = -1;
    this.raising = true;
    this.raiseSawLow = false;
    if (!inst) return;
    this.attachMarkers(inst);
    this.bindWeaponAnim(inst);
    if (this.lastDef && wieldsTwo(this.lastDef, pb) && rig.handL) this.mountLeft(inst);
  }

  /** C5: the brick (C5.I3S) the throw clip carries in the hand; the bomb trigger is hidden meanwhile */
  private rigBrick: THREE.Object3D | null = null;
  private mountBrick(w: WeaponDef): void {
    const tok = this.token;
    void createWeaponModel(w.id ?? w.name, w.family, { grenade: true, projectile: true }).then((b) => {
      if (!b || tok !== this.token || !this.rigActive || !this.rig?.hand) return;
      toViewmodelPass(b.object);
      b.object.visible = false;
      this.rig.hand.add(b.object);
      this.rigBrick = b.object;
    });
  }

  /**
   * Dual wield: a second instance of the weapon's model on the arms' WeaponPointDummyLeft (the chara's left weapon
   * point, CGameCharaWeaponContext +0x274), same i3 space as the right one - the dummy's own frame turns it into the
   * left hand. Both guns stay visible; muzzle / shell of each hand are separate markers.
   */
  private mountLeft(inst: WeaponModelInstance): void {
    const tok = this.token, w = this.lastDef;
    if (!w) return;
    void createWeaponModel(w.id ?? w.name, w.family, { grenade: w.family === "GRENADE" }).then((l) => {
      if (!l || tok !== this.token || !this.rigActive || !this.rig?.handL) return;
      toViewmodelPass(l.object);
      this.rig.handL.add(l.object);
      this.rigWeaponL = l.object;
      this.dual = true;
      this.muzzleL.position.set(0, 0, 0);
      this.ejectL.position.set(0, 0, 0);
      (l.muzzle ?? l.object).add(this.muzzleL);
      (l.eject ?? l.object).add(this.ejectL);
      void inst; // the right instance keeps the weapon animator (slide / magazine)
      // each blade plays its own Change clip (dual_left_change / dual_right_change): the flip of the draw; dual guns
      // (Uzi, Scorpion Vz61: LoadMag1PV_DualGun_Left / _Right, 3.87 s each) reload both guns with their own clip
      void l.animator("1pv").then((a) => {
        if (!a || tok !== this.token) return;
        a.hand = "L";
        a.gender = pbLive.fpsFamily === "female" ? "female" : "male";
        this.wAnimL = a;
      });
    });
  }

  private attachMarkers(inst: WeaponModelInstance) {
    this.laserDummy = inst.object.getObjectByName("FXLaserSightDummy") ?? null;
    this.muzzle.position.set(0, 0, 0);
    this.eject.position.set(0, 0, 0);
    (inst.muzzle ?? inst.object).add(this.muzzle);
    (inst.eject ?? inst.object).add(this.eject);
  }

  /** FXDummy of the hand that fires (dual: `side`) */
  get muzzleNode(): THREE.Object3D {
    return this.dual && this.side === "L" ? this.muzzleL : this.muzzle;
  }
  muzzleWorld(out = new THREE.Vector3()): THREE.Vector3 {
    return this.muzzleNode.getWorldPosition(out);
  }
  /** EmptyCartridgeFXDummy marker (shell effect frame) */
  get ejectNode(): THREE.Object3D {
    return this.dual && this.side === "L" ? this.ejectL : this.eject;
  }
  ejectWorld(out = new THREE.Vector3()): THREE.Vector3 {
    return this.ejectNode.getWorldPosition(out);
  }

  /**
   * `left`: dual wield - true = the left gun fires (LeftAttack layer, Right idle), "both" = both guns (DualSMG).
   * The right gun's own clip (slide) plays on right / both shots.
   */
  fireKick(strength: number, left: boolean | "both" = false): void {
    this.side = this.dual && left === true ? "L" : "R";
    this.kickVel += strength * (this.rigActive ? 0.35 : 1);
    if (this.rigActive && this.family !== "KNIFE" && this.family !== "GRENADE") this.rig!.fire(this.semi, this.burst, left);
    if (left !== true) this.wAnim?.fire(this.fireCycle());
    if (left) this.wAnimL?.fire(this.fireCycle()); // left / both: the left pistol's own slide clip
  }
  /** silencer state of the equipped slot (WeaponSystem sets it every frame; the toggle clips are started by toggleSilencer) */
  silencerWanted = false;
  toggleSilencer(on: boolean, duration: number): void {
    this.silencerWanted = on;
    if (this.rigActive) this.rig!.extAnim(on, duration);
    this.wAnim?.setExt(on, true, duration);
  }
  /** bolt rifles: LoadBullet on the arms and on the weapon (bolt) over the LoadBulletTime cycle, scoped shots too */
  loadBullet(): void {
    const t = (this.lastDef?.params.loadBulletTime ?? 0) / this.reloadScale;
    if (t <= 0) return;
    if (this.rigActive) this.rig!.loadBullet(t);
    this.wAnim?.play("loadBullet", t);
  }

  /** the Throwing AI's Attack state length (K-400 AttackC 1 s, K-413 1.667 s); null without the PB tables */
  throwDuration(secondary = false): number | null {
    return this.rigActive ? (secondary ? this.rig?.stateDur("SecondaryAttack") : null) ?? this.rig?.stateDur("Attack") ?? null : null;
  }

  /** Kunai thrown: the blade of that hand is not in it until the swing ends */
  hideBlade(left: boolean, secs: number): void {
    const w = left ? this.rigWeaponL : this.rigWeapon;
    if (!w) return;
    w.visible = false;
    this.bladeBack[left ? 1 : 0] = secs;
  }
  private bladeBack = [0, 0];

  meleeSwing(heavy: boolean, interval = 0, dual = false): void {
    if (dual) {
      // each blade plays its own swing clip (LMB AttackA, RMB AttackB): it turns the blade in the hand (Kunai right:
      // Idle q(-.56,-.43,-.56,.43) -> q(.48,-.53,.47,.52) at 0.13 s). Without it the blade kept its Idle pose under the swinging arm.
      const k = heavy ? "attackB" : "attackA";
      this.wAnim?.play(k);
      this.wAnimL?.play(k);
    }
    if (this.rigActive && this.family === "KNIFE") {
      this.rig!.melee(heavy, interval, dual);
      return;
    }
    this.swing = 1;
    this.swingHeavy = heavy;
  }

  /** hit on the local player: the arms' DamageFrontLeftA / FrontRightA / BackA (charAnim.hurt picks the same way for 3PV) [INFERIDO] */
  hurt(from: "FrontLeft" | "FrontRight" | "Back"): void {
    if (this.rigActive) this.rig!.reaction(`Damage${from}A`, "DamageFrontLeftA", "DamageBackA");
  }
  private airT = 0;
  private jumped = false;
  /**
   * JumpStart once the feet have left the ground for 0.12 s, JumpEnd on the landing after 0.25 s in the air: the same
   * thresholds as the 3PV lower body (charAnim.update). [INFERIDO]: the exe's trigger for the arms' states is not decoded
   * (OnActionJumpStart 0xa0a670 only starts the physics jump).
   */
  private updateJump(dt: number, grounded: boolean): void {
    if (grounded) {
      if (this.airT > 0.25) this.rig?.reaction("JumpEnd");
      this.airT = 0;
      this.jumped = false;
      return;
    }
    this.airT += dt;
    if (!this.jumped && this.airT > 0.12) {
      this.jumped = true;
      this.rig?.reaction("JumpStart");
    }
  }

  update(dt: number, camera: THREE.Camera, speed: number, grounded: boolean, aiming: boolean): void {
    this.t += dt;
    if (this.rigActive && this.rig) this.updateJump(dt, grounded);
    for (let i = 0; i < 2; i++) {
      if (this.bladeBack[i] > 0 && (this.bladeBack[i] -= dt) <= 0) { const w = i ? this.rigWeaponL : this.rigWeapon; if (w) w.visible = true; }
    }
    PB_VIEWER_MTL.update(camera.getWorldPosition(_feet).setY(_feet.y - EYE.y), dt); // light volume at the player's feet
    this.group.visible = !this.hidden;
    // sway from look delta
    const yaw = camera.rotation.y, pitch = camera.rotation.x;
    let dy = yaw - this.lastYaw;
    if (dy > Math.PI) dy -= Math.PI * 2;
    if (dy < -Math.PI) dy += Math.PI * 2;
    const dp = pitch - this.lastPitch;
    this.lastYaw = yaw;
    this.lastPitch = pitch;
    const k = aiming ? 0.25 : 1;
    this.sway.x = THREE.MathUtils.damp(this.sway.x, THREE.MathUtils.clamp(-dy * 2.2, -0.06, 0.06) * k, 10, dt);
    this.sway.y = THREE.MathUtils.damp(this.sway.y, THREE.MathUtils.clamp(-dp * 2.2, -0.05, 0.05) * k, 10, dt);
    // bob
    const moving = grounded && speed > 0.3;
    this.bobPhase += dt * (moving ? 4 + speed * 1.6 : 1.2);
    const bobAmp = (moving ? Math.min(1, speed / 4.5) * 0.012 : 0.0015) * (aiming ? 0.3 : 1);
    const bobX = Math.cos(this.bobPhase) * bobAmp;
    const bobY = Math.abs(Math.sin(this.bobPhase)) * bobAmp * 1.4;
    // recoil spring
    this.kickVel -= this.kick * 180 * dt;
    this.kickVel *= Math.exp(-18 * dt);
    this.kick += this.kickVel * dt;
    this.updateWeaponAnim(dt);

    if (this.rigActive && this.rig) {
      this.updateRig(dt, moving, aiming);
      return;
    }

    // ads
    this.adsT = THREE.MathUtils.damp(this.adsT, aiming && this.family !== "KNIFE" && this.family !== "GRENADE" ? 1 : 0, 14, dt);
    const pos = HIP.clone().lerp(ADS, this.adsT);
    if (this.family === "KNIFE") pos.set(0.14, -0.15, -0.3);
    if (this.family === "GRENADE") pos.set(0.14, -0.15, -0.3);
    pos.x += bobX + this.sway.x;
    pos.y += bobY + this.sway.y - (1 - this.switchT) * 0.3;
    pos.z += this.kick * 0.06;
    let rx = this.kick * 0.25 - (1 - this.switchT) * 0.8, ry = this.sway.x * 2, rz = 0;
    // reload: dip + roll
    if (this.reloadT >= 0) {
      const r = Math.sin(Math.min(1, this.reloadT) * Math.PI);
      pos.y -= r * 0.08;
      rx -= r * 0.5;
      rz += r * 0.6;
    }
    // melee swing
    if (this.swing > 0) {
      this.swing = Math.max(0, this.swing - dt * (this.swingHeavy ? 2.2 : 4));
      const s = Math.sin((1 - this.swing) * Math.PI);
      if (this.swingHeavy) {
        pos.z -= s * 0.18;
        rx -= s * 0.3;
      } else {
        pos.x -= s * 0.22;
        ry += s * 1.2;
        rz -= s * 0.5;
      }
    }
    if (this.throwT >= 0) {
      const s = Math.sin(Math.min(1, this.throwT) * Math.PI);
      pos.y += s * 0.12;
      pos.z -= s * 0.2;
      rx += s * 0.9;
    }
    this.holder.position.copy(pos);
    this.holder.rotation.set(rx, ry, rz);
  }

  private updateRig(dt: number, moving: boolean, aiming: boolean): void {
    const rig = this.rig!;
    // reload: clip time follows WeaponSystem progress; classes without a reload clip get the procedural dip
    let dipY = 0, dipRx = 0, dipRz = 0;
    if (this.reloadT >= 0) {
      if (this.lastReloadT < 0) {
        this.autoDraw = -1;
        this.reloadElapsed = 0;
        // shell-by-shell reload with a LoadMagazineReady clip (M1887, UTS-15, Cerberus, WaterGun): the opening plays over
        // WeaponSystem's 0.3 s lead-in, then LoadMagazine per shell [INFERIDO]
        this.readyPhase = !!this.lastDef?.params.reloadPerShell && rig.hasReady();
        this.reloadingClip = rig.drive("reload", this.readyPhase ? "LoadMagazineReady" : undefined);
        if (this.readyPhase && !this.reloadingClip) this.readyPhase = false;
      } else this.reloadElapsed += dt;
      if (this.readyPhase && this.reloadElapsed >= 0.3) {
        this.readyPhase = false;
        this.reloadingClip = rig.drive("reload");
      }
      if (this.reloadingClip && rig.pb) rig.setDrivenTime(this.readyPhase ? (this.reloadElapsed / 0.3) * rig.drivenDur : this.reloadClipTime(rig.drivenDur));
      else if (this.reloadingClip) rig.setDriven(this.reloadT);
      else {
        const r = Math.sin(Math.min(1, this.reloadT) * Math.PI);
        dipY -= r * 0.08;
        dipRx -= r * 0.5;
        dipRz += r * 0.6;
      }
    } else if (this.lastReloadT >= 0) {
      if (this.reloadingClip) rig.endDriven();
      this.reloadingClip = false;
    }
    this.lastReloadT = this.reloadT;
    // grenade: the Throwing AI's Attack (throw) clip from the press; the grenade leaves the hand at the release
    // (weapon.pef AttackTimeA1 = WeaponSystem throwDelay), the rig shows it again on the next equip
    if (this.family === "GRENADE") {
      if (this.throwT >= 0 && this.lastThrowT < 0) {
        this.autoDraw = -1;
        rig.throwAnim(!!this.lastDef && throwKind(this.lastDef) === "c5");
      }
      // WeaponDualGrenade hides the right grenade at its release (t > 0.4) and the left child at t > 1.233 (0x632370)
      const t = this.throwT >= 0 ? this.throwT * this.throwTotal : -1;
      const two = !!this.rigWeaponL;
      const relR = two ? DUAL_GRENADE_TIMES[0] : Math.max(0, (this.lastDef?.params.throwDelay ?? 0.1) - 0.05);
      if (this.throwReady && !this.lastThrowReady) {
        this.autoDraw = -1;
        rig.readyAnim();
      }
      this.lastThrowReady = this.throwReady;
      if (this.rigBrick) {
        // C5 throw: the brick until its release, nothing in the hand after it, then the bomb trigger again
        this.rigBrick.visible = t >= 0 && t < relR;
        if (this.rigWeapon) this.rigWeapon.visible = t < 0;
      } else if (this.rigWeapon) this.rigWeapon.visible = !(t >= 0 && t >= relR);
      if (this.rigWeaponL) this.rigWeaponL.visible = !(t >= 0 && t >= DUAL_GRENADE_TIMES[1]);
    }
    this.lastThrowT = this.throwT;
    // switch: lowering is procedural, raising plays the class' Change (draw) clip
    let lower = 0;
    if (this.raising && !this.reloadingClip) {
      if (this.switchT < 0.999) {
        // WeaponSystem raise phase: draw clip time = raise progress
        if (!this.raiseSawLow) rig.drive("change");
        this.raiseSawLow = true;
        rig.setDriven(this.switchT);
      } else {
        this.raising = false;
        if (this.raiseSawLow) rig.endDriven();
        else if (!this.noDraw && rig.drive("change")) this.autoDraw = 0; // equip without a switch (spawn / keepAmmo): real time
      }
    }
    if (this.autoDraw >= 0 && !this.reloadingClip) {
      this.autoDraw += dt / Math.max(0.05, rig.drivenDur || 0.667);
      rig.setDriven(this.autoDraw);
      if (this.autoDraw >= 1) {
        this.autoDraw = -1;
        rig.endDriven();
      }
    }
    if (!this.raising && this.switchT < 1) lower = 1 - this.switchT; // lowering the old weapon
    rig.update(dt, moving, aiming && this.family !== "KNIFE");
    // The PB arms are rigid to the view (they hang from the same Neck as the camera): no look sway, no procedural bob
    // (the walk bob is the Neck motion of the camera, src/player.ts) and no procedural kick (the Attack clip plays).
    this.holder.position.set(0, -lower * 0.3 + dipY, 0);
    this.holder.rotation.set(-lower * 0.8 + dipRx, 0, dipRz);
  }

  /**
   * Reload clip time, exe-2017 OnActionLoadMagazine 0xa0cd50: the LoadMagazine state plays at scale
   * i3AIState dur / weapon.pef ReloadTime (AUG: Reload.i3a 2.5 s over ReloadTime 2.5 s). Shell-by-shell weapons
   * replay it for each shell (ReloadTime per shell, after WeaponSystem's 0.3 s lead-in).
   */
  private reloadClipTime(dur: number, elapsed = this.reloadElapsed): number {
    const p = this.lastDef?.params;
    const rt = Math.max(0.05, (p?.reloadTime ?? dur) / this.reloadScale);
    if (p?.reloadPerShell) {
      const e = elapsed - 0.3;
      return e <= 0 ? 0 : ((e % rt) * dur) / rt;
    }
    return (elapsed * dur) / rt;
  }

  private readyPhase = false;
  private autoDraw = -1;
  private raiseSawLow = false;
  private reloadElapsed = 0;
  private lastThrowT = -1;

  // ---- the weapon's own clips (weaponAnim.ts): magazine / slide / pump in sync with the arms' states ----
  private wAnim: WeaponAnimator | null = null;
  private wAnimTok = 0;
  private wReloadT = -1;
  private wReloadElapsed = 0;
  private wReloading = false;
  private wChanging = false;
  /** DualKnife: the left blade's own animator (Change_Left), driven with the right one */
  private wAnimL: WeaponAnimator | null = null;
  private wChangingL = false;
  private wReloadL = -1;
  private wReloadingL = false;

  private bindWeaponAnim(inst: WeaponModelInstance): void {
    const tok = ++this.wAnimTok;
    this.wReloadT = -1;
    this.wReloading = this.wChanging = false;
    void inst.animator("1pv").then((a) => {
      if (tok !== this.wAnimTok) return;
      if (a) a.gender = pbLive.fpsFamily === "female" ? "female" : "male";
      this.wAnim = a;
      a?.syncExt(this.silencerWanted);
      if (a && animLog) console.info(`[anim] weapon ${a.set.id}: ${Object.keys(a.set.states).join(", ")}`);
    });
  }

  /** shotguns fit Fire into the shot interval (WeaponShotGun::_OnPlayWeaponFireAnim 0x624c40); others: real time */
  private fireCycle(): number | undefined {
    const d = this.lastDef;
    if (!d || d.family !== "SG") return undefined;
    return Math.max(d.fireDelay, (d.params.loadBulletTime ?? 0) / this.reloadScale);
  }

  /**
   * LoadMag: clip time = reload elapsed * anim duration / ReloadTime (exe 0x611980, same scale as the arms'
   * LoadMagazine; shotguns replay it per shell), Change: the raise progress, Fire: one-shot from fireKick().
   */
  private updateWeaponAnim(dt: number): void {
    const a = this.wAnim;
    if (!a) return;
    a.syncExt(this.silencerWanted);
    if (this.reloadT >= 0) {
      if (this.wReloadT < 0) {
        this.wReloadElapsed = 0;
        this.wChanging = false;
        this.wReloading = a.drive("reload");
      } else this.wReloadElapsed += dt;
      if (this.wReloading) a.setTime(this.reloadClipTime(a.duration, this.wReloadElapsed));
    } else if (this.wReloadT >= 0 && this.wReloading) {
      a.end();
      this.wReloading = false;
    }
    this.wReloadT = this.reloadT;
    if (!this.wReloading) {
      if (this.raising && this.switchT < 0.999) {
        if (!this.wChanging) this.wChanging = a.drive("change");
        if (this.wChanging) a.setProgress(this.switchT);
      } else if (this.wChanging) {
        a.end();
        this.wChanging = false;
      }
    }
    a.update(dt);
    const aL = this.wAnimL;
    if (aL) {
      // dual guns: the left gun plays its own reload clip in step with the right one
      if (this.reloadT >= 0) {
        if (this.wReloadL < 0) {
          this.wChangingL = false;
          this.wReloadingL = aL.drive("reload");
        }
        if (this.wReloadingL) aL.setTime(this.reloadClipTime(aL.duration, this.wReloadElapsed));
      } else if (this.wReloadingL) {
        aL.end();
        this.wReloadingL = false;
      }
      this.wReloadL = this.reloadT;
      if (!this.wReloadingL) {
        if (this.raising && this.switchT < 0.999) {
          if (!this.wChangingL) this.wChangingL = aL.drive("change");
          if (this.wChangingL) aL.setProgress(this.switchT);
        } else if (this.wChangingL) {
          aL.end();
          this.wChangingL = false;
        }
      }
      aL.update(dt);
    }
    // ChangeAttachHand 0x613f00: LoadMag / LoadBullet states authored for the left hand carry the weapon there
    const rig = this.rig, w = this.rigWeapon;
    if (this.rigActive && rig && w && !this.rigWeaponL) {
      const want = a.leftHand && rig.handL ? rig.handL : rig.hand;
      if (want && w.parent !== want) want.add(w);
    }
  }

  /** clip of the weapon's running state ("" = Idle / none) - headless validation */
  get weaponClip(): string {
    return this.wAnim?.current ?? "";
  }
  /** the weapon's animator (headless render / tests) */
  get weaponAnimator(): WeaponAnimator | null {
    return this.wAnim;
  }
}
