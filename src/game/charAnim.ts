import * as THREE from "three";

/*
 * Layered 3rd-person animation driven by the PB character AI tables (pb-extract-tools export-anim3pv.mjs, loaded by
 * charAnimLib.ts; until then the model.glb clips stand in with the same state names):
 *   Lower (Root, Pelvis, legs)        Stand|Sit x state: Idle, 8 directions run (Front, FrontLeft, ..., BackRight) or
 *                                     walk (Walk<dir>), JumpStart/JumpEnd. One state at a time; a state change
 *                                     cross-fades over the new state's i3AIState blend time (0.2 s locomotion).
 *   Upper (IK subtree: spine, arms,   per weapon AI (weapon.pef LinkedToCharaAI) x stance AttackIdle | Zoom:
 *          head, Pivot)               base Idle / Move + one-shots Attack, SecondaryAttack, LoadMagazine (reload),
 *                                     LoadBullet (pump/bolt), Change, Damage*, each with its blend-in time.
 *   Stand_Death* / Sit_Death*         full body, replaces both layers.
 * Body split (exe-2017 CGameCharaAnimContext::BindBoneList 0x8100e0): Lower = 10 bones Root, Pelvis, L/R Thigh,
 * Calf, Foot, Toe; Upper = 51 bones Spine1..3, Neck, Head, clavicles, arms, hands, fingers, twists. IK and Pivot
 * are in neither list (no layer time scale); the Up_*.i3a clips carry them, so here they follow the upper clip.
 * The clips themselves respect the split (every Low_*.i3a animates exactly the 10 lower bones), so the layers never
 * fight over a bone and both run at full weight. Vertical aim is added after the mixer (IK + Spine1..3, 1/4 each).
 */

export type UpperClass = "assault" | "smg" | "sniper" | "shotgun" | "handgun" | "knife";

export interface CharAnimInput {
  /** world-space velocity, m/s */
  vel: THREE.Vector3;
  /** actor yaw (game convention: 0 looks down -Z) */
  yaw: number;
  /** look pitch, radians, + = up */
  pitch: number;
  crouch: boolean;
  grounded: boolean;
  zoom?: boolean;
  /** MST WALK (Shift). Omitted: inferred from the speed (walkRunThreshold) */
  walking?: boolean;
  /** legs in motion. Omitted: inferred from |vel| (remote players: network `moving` bit, more reliable than the
   *  position-delta `vel` at low speed / across an interpolation step) */
  moving?: boolean;
  /** 8-way lower-body direction, actor frame. Omitted: inferred from vel (remote players: network `moveDir`) */
  dir8?: Dir8;
}

/** one i3AIState: clip key, blend-in (s), duration (s) */
export interface AnimState {
  clip: string;
  blend: number;
  dur: number;
  loop: boolean;
}
export type StateTable = Record<string, AnimState>;
export interface LowerTables {
  Stand: StateTable;
  Sit: StateTable;
}
export interface UpperAI {
  driver: string;
  stances: { AttackIdle?: StateTable; Zoom?: StateTable };
}

const DIRS = ["Front", "Back", "Left", "Right"] as const;
type Dir = (typeof DIRS)[number];
export const DIR8 = ["Front", "FrontRight", "Right", "BackRight", "Back", "BackLeft", "Left", "FrontLeft"] as const;
export type Dir8 = (typeof DIR8)[number];
/** exe-2017 0x7e8570: the look pitch (rho + recoil) x 0.25 rotates each of IK, Spine1, Spine2, Spine3 around the
 *  character's right axis (Neck/Head untouched for humans) */
const AIM_BONES = ["IK", "Spine1", "Spine2", "Spine3"];

/**
 * Ground distance covered per locomotion cycle (m) = stance-foot speed x clip duration, measured on the swat_male
 * Low_* clips (i3a keys are seconds, 30 fps; Stand_Walk 1.067 s, Stand_Move 0.667 s, Sit_Move 1.6 s). Natural speeds:
 * walk ~1.3-1.7, run ~3.1-4.4, sit ~0.9-1.0 m/s. Left/Right averaged (the mirrored clips measure ~25 % apart).
 * Per-direction values measured on the anim3pv clips (node scripts/dev/test-anim-states.mjs, section 6). Only the legacy
 * 4-direction blend (locomotionGait, scripts/dev/test-anim-speed.mjs) uses them; the animator follows PB_LOWER_K.
 */
export const CLIP_STRIDE: Record<"walk" | "run" | "sit", Record<Dir8, number>> = {
  walk: { Front: 1.35, Back: 1.64, Left: 1.65, Right: 2.03, FrontLeft: 1.64, FrontRight: 1.81, BackLeft: 1.83, BackRight: 1.56 },
  run: { Front: 2.93, Back: 2.08, Left: 1.98, Right: 2.9, FrontLeft: 2.24, FrontRight: 2.5, BackLeft: 2.46, BackRight: 1.79 },
  sit: { Front: 1.36, Back: 1.6, Left: 1.55, Right: 1.71, FrontLeft: 1.24, FrontRight: 1.75, BackLeft: 1.76, BackRight: 1.56 },
};
/** leg cadence stays within these multiples of the clip's own rate (beyond that the feet slide instead) */
const RATE_MIN = 0.4, RATE_MAX = 2.5;

/**
 * PB lower time scale: scale = horizontal speed (m/s, distance moved this frame / dt) x k[direction], min 0.05 run /
 * 0.01 walk (exe-2017 CGameCharaActionControl3PV run 0xa0e110 / walk 0xa0e520, from OnActionRunLower 0xa0fd60 /
 * OnActionWalkLower 0xa101f0). 1/k = the speed at which the clip plays at its own rate (run Front 4.5 m/s).
 */
export const PB_LOWER_K: Record<"run" | "walk", Record<"Stand" | "Sit", Record<Dir8, number>>> = {
  run: {
    Stand: { Front: 0.2222, FrontLeft: 0.2222, FrontRight: 0.2564, Left: 0.303, Right: 0.2222, Back: 0.303, BackLeft: 0.3333, BackRight: 0.3333 },
    Sit: { Front: 0.8888, FrontLeft: 1.0, FrontRight: 0.7272, Left: 0.8, Right: 0.8, Back: 0.8888, BackLeft: 0.8, BackRight: 0.8888 },
  },
  walk: {
    Stand: { Front: 0.5925, FrontLeft: 0.5925, FrontRight: 0.5333, Left: 0.5925, Right: 0.4444, Back: 0.6666, BackLeft: 0.5925, BackRight: 0.5925 },
    Sit: { Front: 3.5555, FrontLeft: 4, FrontRight: 2.909, Left: 3.5555, Right: 3.2, Back: 3.5555, BackLeft: 3.5555, BackRight: 3.5555 },
  },
};

/**
 * Walk (Shift, MST WALK) vs run when the caller does not say: midpoint of the PB walk and run speeds of the default
 * soldier (pbConfig PB_CHARA front 4.2 / 6.5) x the K-2 MoveNormal_Stand 80 % = 4.28 m/s; crouched x Sit/Stand
 * (33/80), zoomed x MoveNormal_Zoom 76 %. [RECRIADO] PB knows the MST from the key state; remote players do not
 * replicate it (src/net/battle.ts), so the speed decides.
 */
export const WALK_RUN_THRESHOLD = 0.5 * (4.2 + 6.5) * 0.8; // Cross SWAT_Male WalkFrontMove 4.2 (was 4.15)
export function walkRunThreshold(crouch: boolean, zoom: boolean): number {
  return WALK_RUN_THRESHOLD * (crouch ? 33 / 80 : 1) * (zoom ? 0.76 : 1);
}
/** below this the lower body idles (m/s) */
const MOVE_EPS = 0.3;

export interface GaitDurations { walk: number; run: number; sit: number }

/**
 * PB 8-way direction from the velocity in the actor frame (vf forward, vr right): the key-state directions of
 * CGameCharaMoveContext (z forward, x right; diagonal when both keys) map to 45 degree sectors of the velocity.
 */
export function dir8Of(vf: number, vr: number): Dir8 {
  const a = Math.atan2(vr, vf); // 0 = front, +pi/2 = right
  const i = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return DIR8[i];
}

/** Legacy 4-way weights (kept for scripts/dev/test-anim-speed.mjs). */
function dir4Weights(vf: number, vr: number): Record<Dir, number> {
  const DIR_VEC: Record<Dir, [number, number]> = { Front: [1, 0], Back: [-1, 0], Left: [0, -1], Right: [0, 1] };
  const speed = Math.hypot(vf, vr);
  const weights: Record<Dir, number> = { Front: 0, Back: 0, Left: 0, Right: 0 };
  if (speed > 0.05) {
    let sum = 0;
    for (const d of DIRS) sum += weights[d] = Math.max(0, (vf / speed) * DIR_VEC[d][0] + (vr / speed) * DIR_VEC[d][1]);
    for (const d of DIRS) weights[d] /= sum || 1;
  } else weights.Front = 1;
  return weights;
}

/**
 * Legacy 4-direction blend + cadence (scripts/dev/test-anim-speed.mjs compares against it). The animator itself uses
 * lowerTimeScale() with one PB state at a time.
 */
export function locomotionGait(
  vf: number, vr: number, crouch: boolean, dur: GaitDurations
): { weights: Record<Dir, number>; runB: number; cyclesPerSec: number } {
  const speed = Math.hypot(vf, vr);
  const weights = dir4Weights(vf, vr);
  const stride = (g: keyof typeof CLIP_STRIDE) => DIRS.reduce((a, d) => a + weights[d] * CLIP_STRIDE[g][d], 0);
  const sW = stride("walk"), sR = stride("run");
  const vW = sW / dur.walk, vR = sR / dur.run;
  const runB = crouch ? 1 : THREE.MathUtils.clamp((speed - vW) / (vR - vW), 0, 1);
  const s = crouch ? stride("sit") : THREE.MathUtils.lerp(sW, sR, runB);
  const nat = crouch ? 1 / dur.sit : THREE.MathUtils.lerp(1 / dur.walk, 1 / dur.run, runB);
  const cyclesPerSec = speed > 0.05 ? THREE.MathUtils.clamp(speed / s, nat * RATE_MIN, nat * RATE_MAX) : nat;
  return { weights, runB, cyclesPerSec };
}

/** PB lower time scale for one locomotion state ("Front", "WalkBackLeft", ...) at a horizontal speed (m/s). */
export function lowerTimeScale(state: string, crouch: boolean, speed: number): number {
  const walk = state.startsWith("Walk");
  const k = PB_LOWER_K[walk ? "walk" : "run"][crouch ? "Sit" : "Stand"][(walk ? state.slice(4) : state) as Dir8];
  if (k === undefined) return 1;
  return Math.max(walk ? 0.01 : 0.05, speed * k);
}

/** Weapon family (weapons/types Family) -> PB upper-body class. */
export function upperClassOf(family: string | undefined): UpperClass {
  switch (family) {
    case "HG":
      return "handgun";
    case "KNIFE":
      return "knife";
    case "SMG":
      return "smg";
    case "SR":
      return "sniper";
    case "SG":
      return "shotgun";
    case "GRENADE":
      return "handgun";
    default:
      return "assault";
  }
}

/** i3 AIDriverCharaUpper_<driver> -> class (for setClass() arriving after a bound AI). */
export function classOfDriver(driver: string): UpperClass {
  if (/^ShotGun|^Revolver/.test(driver)) return "shotgun";
  if (/^SniperRifle/.test(driver)) return "sniper";
  if (/^SMG/.test(driver)) return "smg";
  if (/HandGun|^CIC|^CrossFire/.test(driver)) return "handgun";
  if (/Knife/.test(driver)) return "knife";
  return "assault";
}

/**
 * Stand-in tables built from the model.glb clips (4 directions, assault/handgun/knife folders) so the animator runs
 * before / without the anim3pv library. Blend times = the PB values of the same states (lower 0.2, Idle 0.3,
 * Move 0.2, Attack 0.05, reload 0.1, Change 0).
 */
export function fallbackTables(clips: Map<string, THREE.AnimationClip>, cls: UpperClass): { lower: LowerTables; upper: UpperAI } {
  const st = (clip: string, blend: number, loop: boolean): AnimState | null => {
    const c = clips.get(clip);
    return c ? { clip, blend, dur: c.duration, loop } : null;
  };
  const put = (t: StateTable, k: string, s: AnimState | null) => {
    if (s) t[k] = s;
  };
  const lower: LowerTables = { Stand: {}, Sit: {} };
  for (const stance of ["Stand", "Sit"] as const) {
    const T = lower[stance];
    put(T, "Idle", st(`Low_${stance}_Idle`, 0.2, true));
    for (const d of DIRS) {
      put(T, d, st(`Low_${stance}_Move${d}`, 0.2, true));
      put(T, `Walk${d}`, st(`Low_${stance}_Walk${d}`, 0.2, true));
    }
    put(T, "JumpStart", st("Low_JumpStart", 0.1, false));
    put(T, "JumpEnd", st(stance === "Stand" ? "Low_JumpEnd" : "Low_Sit_Idle", 0.1, false));
  }
  const folder = cls === "handgun" || cls === "knife" ? cls : "assault";
  const find = (name: string): string | null => {
    const re = new RegExp(`^${folder}/(?:[^/]+/)?Up_${name}$`, "i");
    for (const k of clips.keys()) if (re.test(k)) return k;
    if (folder !== "assault") for (const k of clips.keys()) if (new RegExp(`^assault/(?:[^/]+/)?Up_${name}$`, "i").test(k)) return k;
    return null;
  };
  const up = (name: string, blend: number, loop: boolean) => {
    const k = find(name);
    return k ? st(k, blend, loop) : null;
  };
  const A: StateTable = {}, Z: StateTable = {};
  put(A, "Idle", up("AttackIdle", 0.3, true));
  put(A, "Move", up("Move_AttackIdle", 0.2, true));
  put(A, "Attack", up("Attack", 0.05, false));
  put(A, "SecondaryAttack", up("AttackStab", 0.05, false));
  put(A, "LoadMagazine", up("Reload", 0.1, false));
  put(A, "LoadBullet", up("Reload", 0.1, false));
  put(A, "Change", up("Change", 0, false));
  put(A, "DamageFrontLeftA", up("DamageFrontLeftA", 0.05, false));
  put(A, "DamageBackA", up("DamageBackA", 0.05, false));
  if (folder === "assault") {
    put(Z, "Idle", up("AttackIdle_Zoom", 0.3, true));
    put(Z, "Move", up("AttackIdle_Zoom", 0.2, true));
    put(Z, "Attack", up("Attack_Zoom", 0.05, false));
    put(Z, "LoadMagazine", A.LoadMagazine ?? null);
    put(Z, "LoadBullet", A.LoadBullet ?? null);
  }
  return { lower, upper: { driver: "model.glb", stances: Object.keys(Z).length ? { AttackIdle: A, Zoom: Z } : { AttackIdle: A } } };
}

interface Track {
  action: THREE.AnimationAction;
  key: string;
  layer: "low" | "up" | "shot";
  loop: boolean;
  w: number;
  target: number;
  /** weight change per second (1 / blend) */
  rate: number;
}

interface OneShot {
  track: Track;
  state: string;
  until: number;
  fadeOut: number;
}

const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _axis = new THREE.Vector3();
const _local = new THREE.Vector3();

export class CharAnimator {
  readonly mixer: THREE.AnimationMixer;
  private clips = new Map<string, THREE.AnimationClip>();
  private tracks = new Map<string, Track>();
  private lowerT: LowerTables;
  private upperT: UpperAI;
  /** AI name of the bound weapon tables (null = model.glb stand-in) */
  private aiName: string | null = null;
  /** weapon.pef _ZoomType 2|3 selects the Zoom AI when aiming (_CharaChangeAIContext 0xa1beb0) */
  private zoomAI = true;
  private cls: UpperClass = "assault";
  private lowState = "";
  private lowKey = "";
  private upStance: "AttackIdle" | "Zoom" = "AttackIdle";
  private upState = "";
  private upKey = "";
  private oneShot: OneShot | null = null;
  private death: THREE.AnimationAction | null = null;
  private t = 0;
  private phase = 0;
  private airTime = 0;
  private landT = 0;
  private wasGrounded = true;
  private aimBones: THREE.Object3D[] = [];
  /** un-aimed local rotations: the mixer only rewrites a bone when its mixed value changes, so the aim offset
   *  must be undone before every mixer.update or it accumulates on static poses */
  private aimRest: THREE.Quaternion[] = [];
  private aimApplied = false;
  private pitch = 0;
  /** actor frame for the aim axis (defaults to the mixer root's parent) */
  aimFrame: THREE.Object3D | null = null;
  /** names of the clips currently weighted > 0.05, for debugging / headless validation */
  readonly active: string[] = [];
  /** debug hook: called whenever the dominant low/up/one-shot clip changes ("Stand.FrontLeft -> clip") */
  onState: ((layer: "low" | "up" | "shot" | "death", clip: string) => void) | null = null;

  readonly root: THREE.Object3D;

  // plain field (no parameter property) so Node's type stripping can load this file (tools/test-anim-*.mjs)
  constructor(root: THREE.Object3D, clips: THREE.AnimationClip[]) {
    this.root = root;
    this.mixer = new THREE.AnimationMixer(root);
    for (const c of clips) this.clips.set(c.name, c);
    for (const n of AIM_BONES) {
      const b = root.getObjectByName(n);
      if (b) this.aimBones.push(b);
    }
    const fb = fallbackTables(this.clips, "assault");
    this.lowerT = fb.lower;
    this.upperT = fb.upper;
  }

  static hasLayers(clips: THREE.AnimationClip[]): boolean {
    return clips.some((c) => c.name === "Low_Stand_Idle") && clips.some((c) => /Up_AttackIdle$/.test(c.name));
  }

  get upperClass(): UpperClass {
    return this.cls;
  }
  /** bound weapon AI (weapon.pef LinkedToCharaAI), null while on the model.glb stand-in */
  get weaponAI(): string | null {
    return this.aiName;
  }
  /** weapon.pef _ZoomType 2|3 (has its own Zoom stance): gates the `zoom` input and the wire zoomType */
  get zoomCapable(): boolean {
    return this.zoomAI;
  }
  /** current lower / upper state names (headless validation) */
  get lowerState(): string {
    return this.lowState;
  }
  get upperState(): string {
    return this.oneShot ? this.oneShot.state : `${this.upStance}.${this.upState}`;
  }

  /** Weapon class from charModel.setWeapon. Ignored while bound tables already are of that class. */
  setClass(cls: UpperClass): void {
    if (this.aiName && classOfDriver(this.upperT.driver) === cls) {
      this.cls = cls;
      return;
    }
    if (cls === this.cls && !this.aiName && this.upKey) return;
    this.cls = cls;
    this.aiName = null;
    this.zoomAI = true;
    this.upperT = fallbackTables(this.clips, cls).upper;
    this.resetUpper();
  }

  /** Bind the PB tables of one weapon AI with its clips (charAnimLib.bindWeaponAnim). */
  useTables(lower: LowerTables, upper: UpperAI, aiName: string, clips: Map<string, THREE.AnimationClip>, zoomType?: number): void {
    this.zoomAI = zoomType === undefined || zoomType === 2 || zoomType === 3;
    for (const [k, c] of clips) this.clips.set(k, c);
    this.lowerT = lower;
    this.upperT = upper;
    this.aiName = aiName;
    this.cls = classOfDriver(upper.driver);
    this.lowKey = "";
    this.lowState = "";
    this.resetUpper();
  }

  private resetUpper(): void {
    this.queued = null;
    this.upKey = "";
    this.upState = "";
    if (this.oneShot) {
      this.oneShot.track.target = 0;
      this.oneShot = null;
    }
  }

  private track(key: string, loop: boolean): Track | null {
    let tr = this.tracks.get(key);
    if (tr) return tr;
    const c = this.clips.get(key);
    if (!c) return null;
    const a = this.mixer.clipAction(c);
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    a.clampWhenFinished = !loop;
    a.setEffectiveWeight(0);
    a.play();
    tr = { action: a, key, layer: key.includes("Low_") ? "low" : "up", loop, w: 0, target: 0, rate: 1 };
    this.tracks.set(key, tr);
    return tr;
  }

  private upperTable(): StateTable {
    const S = this.upperT.stances;
    return (this.upStance === "Zoom" ? S.Zoom : S.AttackIdle) ?? S.AttackIdle ?? {};
  }

  /**
   * Play an upper one-shot state (Attack, SecondaryAttack, LoadMagazine, LoadBullet, Change, DamageFrontLeftA, ...).
   * `duration` (s) stretches the whole clip over that time (reload = weapon.pef ReloadTime), so it is never cut.
   */
  playUpper(state: string, duration?: number): boolean {
    if (this.death) return false;
    const T = this.upperTable();
    const s = T[state] ?? this.upperT.stances.AttackIdle?.[state];
    if (!s) return false;
    const c = this.clips.get(s.clip);
    if (!c) return false;
    if (this.oneShot && this.oneShot.track.key !== s.clip) this.oneShot.track.target = 0;
    const tr = this.track(s.clip, false)!;
    tr.layer = "shot";
    tr.action.reset().play();
    tr.action.setLoop(THREE.LoopOnce, 1);
    tr.action.clampWhenFinished = true;
    // OnActionLoadMagazine 0xa0cd50: scale = i3AIState duration / ReloadTime (LoadBullet: / LoadBulletTime)
    const scale = duration && duration > 0 ? (s.dur > 0 ? s.dur : c.duration) / duration : 1;
    tr.action.timeScale = scale;
    const len = c.duration / scale;
    tr.w = s.blend > 0 ? Math.min(tr.w, 0.999) : 1;
    tr.target = 1;
    tr.rate = s.blend > 0 ? 1 / s.blend : Infinity;
    this.oneShot = { track: tr, state, until: this.t + Math.max(len, 0.1), fadeOut: Math.min(0.15, len * 0.5 + 0.05) };
    this.onState?.("shot", `${state} -> ${s.clip}`);
    return true;
  }

  /**
   * heavy = knife stab (right click) / secondary attack. `hand` (dual-wield AI, charAnimLib dualTables): "L" = the
   * left gun fires (AttackLeft), "both" = both guns (AttackBoth, DualSMG); default = right / single gun (Attack).
   */
  fire(heavy = false, hand?: "L" | "both"): void {
    this.queued = null;
    if (heavy && this.playUpper("SecondaryAttack")) return;
    if (hand === "L" && this.playUpper("AttackLeft")) return;
    if (hand === "both" && this.playUpper("AttackBoth")) return;
    this.playUpper("Attack");
  }
  /** Throwing AI AttackReady (WeaponGrenade::FireReady 0x630b80): held on its last frame until the next upper state */
  ready(): void {
    if (this.playUpper("AttackReady") && this.oneShot) this.oneShot.until = Infinity;
  }
  /** an upper state held on its last frame until release() or the next upper state (C4 Install while the plant is held) */
  hold(state: string): boolean {
    const ok = this.playUpper(state);
    if (ok && this.oneShot) this.oneShot.until = Infinity;
    return ok;
  }
  release(): void {
    if (this.oneShot && this.oneShot.until === Infinity) this.oneShot.until = this.t;
  }
  /**
   * magazine reload over weapon.pef ReloadTime (shotguns: one shell, ReloadTime per shell). An AI with a
   * LoadMagazineReady state (M1887, UTS-15, Cerberus, WaterGun, M70: ReloadA) opens with it, then LoadMagazine runs
   * over the rest of the time. [INFERIDO]: the exe rule for Ready -> LoadMagazine is not decoded.
   */
  reload(duration?: number): void {
    this.queued = null;
    const ready = this.upperTable().LoadMagazineReady, rc = ready && this.clips.get(ready.clip);
    if (rc && this.playUpper("LoadMagazineReady")) {
      this.queued = { state: "LoadMagazine", dur: duration && duration > rc.duration + 0.1 ? duration - rc.duration : duration, at: this.t + rc.duration };
      return;
    }
    this.playUpper("LoadMagazine", duration) || this.playUpper("LoadBullet", duration);
  }
  /** LoadMagazine waiting for LoadMagazineReady to end */
  private queued: { state: string; dur?: number; at: number } | null = null;
  /** pump / bolt cycle (weapon.pef LoadBulletTime) */
  loadBullet(duration?: number): void {
    this.playUpper("LoadBullet", duration);
  }
  change(): void {
    this.queued = null;
    this.playUpper("Change");
  }
  /**
   * Flinch on a hit. `from` = side the bullet came from, relative to the actor: DamageFrontLeftA / DamageFrontRightA /
   * DamageBackA (all three exported per AI). [INFERIDO]: the exe rule that picks the clip is not decoded; the names
   * are read as "hit from the front-left / front-right / back". Without a direction: FrontLeftA, then BackA.
   */
  hurt(from?: "FrontLeft" | "FrontRight" | "Back"): void {
    const first = from ? `Damage${from}A` : "DamageFrontLeftA";
    this.playUpper(first) || this.playUpper("DamageFrontLeftA") || this.playUpper("DamageBackA");
  }

  /** Death: dir = hit direction relative to the actor ("Front" = shot from the front). */
  die(dir: Dir = "Front", crouch = false): string | null {
    const cands = [...this.clips.keys()].filter((k) =>
      crouch ? new RegExp(`^Sit_Death${dir}`).test(k) : new RegExp(`^Stand_Death${dir}`).test(k)
    );
    const pool = cands.length ? cands : [...this.clips.keys()].filter((k) => /^Stand_Death/.test(k));
    const name = pool.length ? pool[Math.floor(Math.random() * pool.length)] : this.clips.has("death") ? "death" : null;
    if (!name) return null;
    this.undoAim();
    this.mixer.stopAllAction();
    for (const tr of this.tracks.values()) (tr.w = 0), (tr.target = 0);
    const a = this.mixer.clipAction(this.clips.get(name)!);
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.setEffectiveWeight(1).play();
    this.death = a;
    this.oneShot = null;
    this.pitch = 0;
    this.onState?.("death", name);
    return name;
  }

  get dead(): boolean {
    return this.death !== null;
  }

  respawn(): void {
    if (this.death) {
      this.death.stop();
      this.death = null;
    }
    for (const tr of this.tracks.values()) {
      tr.action.reset().setEffectiveWeight(0).play();
      tr.w = 0;
      tr.target = 0;
    }
    this.oneShot = null;
    this.lowKey = this.lowState = "";
    this.upKey = this.upState = "";
  }

  /** switch the base state of a layer: the other tracks of the layer fade out at the new state's blend rate */
  private enter(layer: "low" | "up", s: AnimState, name: string, restart = false): void {
    const cur = layer === "low" ? this.lowKey : this.upKey;
    if (layer === "low") this.lowState = name;
    else this.upState = name;
    if (cur === s.clip && !restart) return;
    const tr = this.track(s.clip, s.loop);
    if (!tr) return;
    const rate = s.blend > 0 ? 1 / s.blend : Infinity;
    for (const o of this.tracks.values()) if (o.layer === layer && o !== tr) (o.target = 0), (o.rate = rate);
    if (!cur) tr.w = 1; // first state: no fade from bind pose
    tr.layer = layer;
    tr.target = 1;
    tr.rate = rate;
    if (!s.loop || restart) tr.action.reset().play();
    if (layer === "low") this.lowKey = s.clip;
    else this.upKey = s.clip;
    this.onState?.(layer, `${layer === "low" ? "" : this.upStance + "."}${name} -> ${s.clip}`);
  }

  update(dt: number, s: CharAnimInput): void {
    this.t += dt;
    if (this.death) {
      this.undoAim();
      this.mixer.update(dt);
      return;
    }

    // ---- lower: one PB state (stance x direction x gait) ----
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw); // forward
    const rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw); // right
    const vf = s.vel.x * fx + s.vel.z * fz;
    const vr = s.vel.x * rx + s.vel.z * rz;
    const speed = Math.hypot(vf, vr);
    if (!s.grounded) this.airTime += dt;
    let landing = false;
    if (s.grounded && !this.wasGrounded && this.airTime > 0.25) (landing = true), (this.landT = 0.3);
    if (s.grounded) this.airTime = 0;
    this.wasGrounded = s.grounded;
    this.landT = Math.max(0, this.landT - dt);

    const LT = s.crouch ? this.lowerT.Sit : this.lowerT.Stand;
    const moving = s.moving ?? (speed > MOVE_EPS && s.grounded);
    const walking = s.walking ?? speed < walkRunThreshold(s.crouch, !!s.zoom);
    let lowName = "Idle";
    if (!s.grounded && this.airTime > 0.12 && LT.JumpStart) lowName = "JumpStart";
    else if (moving) {
      const d = s.dir8 ?? dir8Of(vf, vr);
      const pick = (n: string) => (LT[n] ? n : null);
      // 4-direction stand-in tables: diagonal -> the dominant axis
      const d4 = Math.abs(vf) >= Math.abs(vr) ? (vf >= 0 ? "Front" : "Back") : vr >= 0 ? "Right" : "Left";
      lowName = (walking && (pick(`Walk${d}`) ?? pick(`Walk${d4}`))) || pick(d) || pick(d4) || "Idle";
    } else if (this.landT > 0 && LT.JumpEnd) lowName = "JumpEnd";
    const ls = LT[lowName] ?? LT.Idle;
    if (ls) this.enter("low", ls, lowName, landing && lowName === "JumpEnd");
    const lowTrack = this.lowKey ? this.tracks.get(this.lowKey) : null;
    if (ls && moving && ls.loop) {
      // clip time advances at the PB time scale; on a direction change the new clip keeps the normalised phase
      // (OnActionRunLower: newTime = localTime x newDur / oldDur)
      const dur = lowTrack?.action.getClip().duration || ls.dur;
      this.phase = (this.phase + (dt * lowerTimeScale(lowName, s.crouch, speed)) / Math.max(dur, 1e-3)) % 1;
    }

    // ---- upper: stance (AttackIdle | Zoom) x base (Idle | Move) + one-shot ----
    const stance = s.zoom && this.zoomAI && this.upperT.stances.Zoom ? "Zoom" : "AttackIdle";
    if (stance !== this.upStance) {
      this.upStance = stance;
      this.upState = "";
    }
    const UT = this.upperTable();
    const upName = moving && UT.Move ? "Move" : "Idle";
    const us = UT[upName] ?? UT.Idle;
    if (us && (upName !== this.upState || this.upKey !== us.clip)) this.enter("up", us, upName);
    if (this.queued && this.t >= this.queued.at) {
      const q = this.queued;
      this.queued = null;
      this.playUpper(q.state, q.dur);
    }
    if (this.oneShot && this.t >= this.oneShot.until) {
      const tr = this.oneShot.track;
      tr.target = 0;
      tr.rate = 1 / Math.max(1e-3, this.oneShot.fadeOut);
      this.oneShot = null;
    }

    // ---- weights: fade, then normalise per layer (the mixer averages by weight; a sum < 1 would leak the bind pose)
    const sum = { low: 0, up: 0, shot: 0 };
    for (const tr of this.tracks.values()) {
      const step = tr.rate === Infinity ? 1 : tr.rate * dt;
      tr.w = tr.target > tr.w ? Math.min(tr.target, tr.w + step) : Math.max(tr.target, tr.w - step);
      sum[tr.layer] += tr.w;
    }
    // one-shot share f of the upper body: weight f/(1-f) against the base sum 1, so bones a one-shot clip does not
    // animate (Pivot in Up_Reload / Up_AttackIdle_Zoom) keep the base pose instead of drifting to bind
    const f = Math.min(sum.shot, 0.999);
    for (const tr of this.tracks.values()) {
      const w = sum[tr.layer] > 0 ? tr.w / sum[tr.layer] : 0;
      tr.action.setEffectiveWeight(tr.layer === "shot" ? w * (f / (1 - f)) : w);
      if (tr.layer !== "low") continue;
      const clip = tr.action.getClip();
      if (tr.loop && clip.duration > 0) {
        tr.action.timeScale = 0; // time driven here: shared locomotion phase (direction changes keep the step)
        tr.action.time = /Idle$/.test(tr.key) ? this.t % clip.duration : this.phase * clip.duration;
      } else tr.action.timeScale = 1;
    }

    this.undoAim();
    this.mixer.update(dt);
    this.applyAim(dt, s.pitch);

    this.active.length = 0;
    for (const tr of this.tracks.values()) if (tr.w > 0.05) this.active.push(tr.key);
  }

  private undoAim(): void {
    if (!this.aimApplied) return;
    for (let i = 0; i < this.aimBones.length; i++) this.aimBones[i].quaternion.copy(this.aimRest[i]);
    this.aimApplied = false;
  }

  private applyAim(dt: number, pitch: number): void {
    this.pitch += (THREE.MathUtils.clamp(pitch, -1.2, 1.2) - this.pitch) * (1 - Math.exp(-20 * dt));
    if (!this.aimBones.length || Math.abs(this.pitch) < 1e-3) return;
    for (let i = 0; i < this.aimBones.length; i++) (this.aimRest[i] ??= new THREE.Quaternion()).copy(this.aimBones[i].quaternion);
    this.aimApplied = true;
    const frame = this.aimFrame ?? this.root.parent ?? this.root;
    frame.updateWorldMatrix(true, false);
    // actor right axis in world space; +pitch around +X of a -Z-forward frame tilts the chest up
    _axis.set(1, 0, 0).transformDirection(frame.matrixWorld);
    const per = this.pitch / this.aimBones.length;
    for (const b of this.aimBones) {
      // the skeleton sits under the mirrored i3 AxisRotate (det -1): map the axis with the full inverse matrix
      // (not a world quaternion) and flip the angle's sign in a mirrored frame
      b.parent!.updateWorldMatrix(true, false);
      _m.copy(b.parent!.matrixWorld);
      const sign = _m.determinant() < 0 ? -1 : 1;
      _local.copy(_axis).transformDirection(_m.invert());
      _q.setFromAxisAngle(_local, per * sign);
      b.quaternion.premultiply(_q);
    }
  }
}
