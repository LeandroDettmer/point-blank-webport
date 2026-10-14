import * as THREE from "three";

/*
 * The weapon's OWN animation: magazine out / in, slide or bolt, pistol hammer, shotgun pump (2017 client weapon packs,
 * tools/export-weapon-anim.mjs -> public/assets/weapons/anim/). A PB weapon is an i3Chara of its own: an i3AIContext
 * whose states (Fire, Idle, LoadMag, LoadBullet, Change, + 1PV / 3PV variants) play .i3a clips on the weapon's
 * skeleton bones (MagazineAnimationDummy, HandleAnimationDummy, VolAnimationDummy, ...) - the GLB nodes the meshes
 * hang from. Only the equipped model's clip library is fetched.
 *
 * Timing, exe 2017:
 *   WeaponBase::_PlayWeaponAnim 0x612520 -> i3AIContext::setCurrentAIState(state, blend 0, timeScale): states switch
 *   instantly (no cross-fade).
 *   Fire 0x612820: timeScale 1 (real time); WeaponShotGun::_OnPlayWeaponFireAnim 0x624c40: anim duration / fire cycle
 *   (the pump fits the shot interval).
 *   LoadMag 0x611980: anim duration / weapon.pef ReloadTime (x1.25 with the fast-reload beret) = the character's
 *   LoadMagazine scale, so both run over the same reload time (Viewmodel.reloadClipTime).
 *   1PV / 3PV: the "<State>1PV" / "<State>3PV" state when the weapon has it, else "<State>" (0x612ee0).
 *   *Master* states (master-beret reloads, EnablePlayMasterAnim) are not driven.
 */

const BASE = "/assets/weapons/anim";

interface ClipJson {
  name: string;
  duration: number;
  tracks: { node: string; times: number[]; T?: number[]; R?: number[] }[];
}
interface AnimIndex {
  sets: { ai: string; states: Record<string, { clip: string; dur: number }> }[];
  models: Record<string, number>;
  libs: Record<string, string>;
}

export type WeaponView = "1pv" | "3pv";
export type WeaponAnimKind = "fire" | "reload" | "loadBullet" | "change" | "idle" | "extOn" | "extOff" | "attackA" | "attackB";
const STATE: Record<WeaponAnimKind, string> = {
  fire: "Fire", reload: "LoadMag", loadBullet: "LoadBullet", change: "Change", idle: "Idle", extOn: "ExtensionActivate", extOff: "ExtensionDeactivate",
  // DualKnife blades: each hand's own swing clip (Attack<A|B>_<Male_>Left / _Right) re-orients the blade in the hand
  attackA: "AttackA", attackB: "AttackB",
};

export interface WeaponAnimSet {
  /** model id (models/index.json) */
  id: string;
  /** the pack's AI name (anim/index.json sets[].ai, e.g. Weapon_Cheytac): key of its sound events in sfx/pb2017.json */
  ai: string;
  /** left: the state runs with the weapon on the LEFT hand (see leftGrip) */
  states: Record<string, { clip: THREE.AnimationClip; dur: number; left?: boolean }>;
}

/**
 * WeaponBase::OnLoadMag 0x9d172d / OnLoadBullet 0x9d1a9d call ChangeAttachHand(1, 2) 0x613f00: the weapon moves to the
 * character's left-hand dummy (CGameCharaWeaponContext +0x274, WeaponPointDummyLeft 0x781f51) for the state, gated by
 * weapon-info flags (0x614270 / 0x614360) that the pef keys LoadMagazineLeftBarrel / LoadBulletLeftBarrel do not
 * separate (K-2 and L115A1 both have 1/1). The packs do: a left-hand state re-keys LHandGunDummy (the parent of every
 * weapon mesh) to the left grip offset (L115A1 / Cheytac / SVD Reload 1PV: (-0.006, -0.023, 0.037) vs Idle
 * (0.28, 0.05, 0.04)), a right-hand one keeps the Idle key (K-2, SSG69). Left-attached, the magazine lands in the
 * right hand (Cheytac 3.6 cm, SVD 1.9 cm at 20 %); right-attached it flew 0.8-1.3 m away from both hands.
 */
/**
 * K-2 / K-1 / AKS74U / SSG69 / WA2000 packs of the 2017 client (LHandGunDummy 0.276, 0.037, 0 in every state) keep the
 * Idle key in LoadMag / LoadBullet, so the leftGrip test above says "right hand", but the arms' Reload clip has the
 * left hand holding the gun. The 3.123 K-2 pack has the fix: Reload_Male_1PV re-keys LHandGunDummy to (-0.007, -0.023,
 * 0.037), Reload_Female_1PV to (-0.028, -0.013, 0.024); the same values fall out of the gun-doesn't-jump condition
 * (LHandGunDummy placed so the gun keeps its pose when moved from WeaponPointDummyRight to ...Left; checked against the
 * L115A1 re-key). The rest of the family reuses them (same LHandGunDummy origin on the male / female rig).
 */
const LEFT_RELOAD_AI = /^Weapon_(K-1_SE|Domi_K-1_Def|Domi_K-2_Def|Aks74u|Aks74u_Reload|Domi_SSG69_Def|Walther_Wa2000)$/;
const LEFT_GRIP = { Male: [-0.007, -0.023, 0.037], Female: [-0.028, -0.013, 0.024] };

function leftGrip(state: ClipJson, idle: ClipJson | undefined): boolean {
  const k = (c: ClipJson | undefined) => c?.tracks.find((t) => t.node === "LHandGunDummy")?.T?.slice(0, 3);
  const a = k(state), b = k(idle);
  return !!a && !!b && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 0.05;
}

let indexP: Promise<AnimIndex | null> | null = null;
const libP = new Map<string, Promise<Record<string, ClipJson> | null>>();
const clipCache = new Map<string, THREE.AnimationClip>();
const setCache = new Map<string, Promise<WeaponAnimSet | null>>();

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

function toClip(key: string, j: ClipJson): THREE.AnimationClip {
  let c = clipCache.get(key);
  if (c) return c;
  const tracks: THREE.KeyframeTrack[] = [];
  for (const t of j.tracks) {
    const n = THREE.PropertyBinding.sanitizeNodeName(t.node); // GLTFLoader names nodes the same way
    if (t.T) tracks.push(new THREE.VectorKeyframeTrack(`${n}.position`, t.times, t.T));
    if (t.R) tracks.push(new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, t.times, t.R));
  }
  c = new THREE.AnimationClip(j.name, Math.max(j.duration, 1e-3), tracks);
  clipCache.set(key, c);
  return c;
}

/** States + clips of a weapon model (null = the model has no weapon animation in the 2017 packs). */
export function loadWeaponAnimSet(modelId: string): Promise<WeaponAnimSet | null> {
  let p = setCache.get(modelId);
  if (p) return p;
  p = (async () => {
    indexP ??= fetchJson<AnimIndex>(`${BASE}/index.json`);
    const ix = await indexP;
    const set = ix?.sets[ix.models[modelId] ?? -1];
    if (!ix || !set) return null;
    const files = [...new Set(Object.values(set.states).map((s) => ix.libs[s.clip]).filter(Boolean))];
    const libs = await Promise.all(
      files.map((f) => {
        let q = libP.get(f);
        if (!q) libP.set(f, (q = fetchJson<{ clips: Record<string, ClipJson> }>(`${BASE}/${f}`).then((j) => j?.clips ?? null)));
        return q;
      })
    );
    const states: WeaponAnimSet["states"] = {};
    const raw = (clip: string | undefined) => (clip ? libs.map((l) => l?.[clip]).find(Boolean) : undefined);
    const idle = raw(set.states.Idle?.clip);
    for (const [name, s] of Object.entries(set.states)) {
      let j = raw(s.clip);
      if (!j) continue;
      const load = /^Load(Mag|Bullet)/.test(name);
      const left = load && leftGrip(j, idle);
      states[name] = { clip: toClip(s.clip, j), dur: s.dur, left };
      if (/^Load(Mag|Bullet)$/.test(name) && !left && LEFT_RELOAD_AI.test(set.ai) && j.tracks.some((t) => t.node === "LHandGunDummy")) {
        // the 3.123 packs ship these as LoadMag1PVMale / 1PVFemale with LHandGunDummy re-keyed per gender (stateKey picks them first)
        for (const g of ["Male", "Female"] as const) {
          const grip = LEFT_GRIP[g];
          const jg = { ...j, tracks: j.tracks.map((t) => (t.node === "LHandGunDummy" && t.T ? { ...t, T: t.times.flatMap(() => grip) } : t)) };
          states[`${name}1PV${g}`] = { clip: toClip(`${s.clip}#lgrip${g}`, jg), dur: s.dur, left: true };
        }
      }
    }
    return Object.keys(states).length ? { id: modelId, ai: set.ai, states } : null;
  })();
  setCache.set(modelId, p);
  return p;
}

/**
 * Plays a weapon's AI states on one model instance. Clip time is kept here (all actions run at timeScale 0 and get
 * their time set), so a state can run in real time (play) or follow the gameplay progress (drive / setTime).
 */
export class WeaponAnimator {
  readonly mixer: THREE.AnimationMixer;
  private idle: THREE.AnimationAction | null = null;
  private cur: THREE.AnimationAction | null = null;
  private t = 0;
  private speed = 1;
  private driven = false;
  /** clip name of the running state ("" = Idle) - debug / headless validation */
  current = "";
  /** the running state holds the weapon on the left hand (ChangeAttachHand 0x613f00, see leftGrip) */
  leftHand = false;

  constructor(readonly root: THREE.Object3D, readonly set: WeaponAnimSet, readonly view: WeaponView) {
    this.mixer = new THREE.AnimationMixer(root);
    const idle = this.state("idle");
    if (idle) {
      this.idle = this.mixer.clipAction(idle.clip);
      this.idle.play();
      this.idle.timeScale = 0;
    }
    this.mixer.update(0);
    root.traverse((o) => { if (/^Model_VOL\d*$/.test(o.name)) this.volMesh.push(o); });
    this.showVol();
    // switchable silencer (ExtensionActivate state): the mesh is only there while the extension is on / switching
    if (this.set.states.ExtensionActivate || this.set.states.ExtensionDeactivate) {
      root.traverse((o) => { if (/silencer/i.test(o.name) && !/dummy$/i.test(o.name)) this.silencerMesh.push(o); });
      this.showSilencer();
    }
  }

  /**
   * Loose shells of the shotguns (M1887 Model_VOL01..05): Idle / Fire park them beside the receiver (one static key), so they
   * hung in the air. Only the reload clips move them into the hand. Visibility rule not decoded [INFERIDO]: shown in reload only.
   */
  private volMesh: THREE.Object3D[] = [];
  private showVol(): void {
    const on = /reload/i.test(this.current);
    for (const m of this.volMesh) m.visible = on;
  }
  private silencerMesh: THREE.Object3D[] = [];
  private showSilencer(): void {
    const on = this._ext || this.current === this.set.states[this.stateKey("extOn") ?? ""]?.clip.name || this.current === this.set.states[this.stateKey("extOff") ?? ""]?.clip.name;
    for (const m of this.silencerMesh) m.visible = on;
  }

  /**
   * RMB extension of a silencer weapon (weapon.pef _Extension Silencer): on -> the *_Ext states (Idle_Ext, Fire_Ext,
   * LoadMag_Ext ...) and the ExtensionActivate clip (the silencer flies onto the barrel, 2 s); off -> ExtensionDeactivate,
   * the mesh goes away when it ends. `animate` false snaps (weapon switch).
   */
  private _ext = false;
  private extOffPending = false;
  /** the Activate / Deactivate clip is running: syncExt leaves the state alone */
  private extBusy = false;
  /** weapon switch / late model load: snap to the slot's silencer state unless the switch clip is playing */
  syncExt(on: boolean): void {
    if (!this.extBusy && on !== this._ext) this.setExt(on, false);
  }
  get ext(): boolean { return this._ext; }
  setExt(on: boolean, animate: boolean, duration?: number): void {
    if (on === this._ext && !this.extOffPending) return;
    this.extBusy = animate;
    if (animate) {
      if (on) { this._ext = true; this.extOffPending = false; this.rebindIdle(); this.play("extOn", duration); }
      else { this.extOffPending = true; this.play("extOff", duration); }
    } else {
      this.extOffPending = false;
      this._ext = on;
      this.rebindIdle();
    }
    this.showSilencer();
  }

  /** character family of the holder: some packs split states by gender (L115A1 LoadMag1PVMale / LoadBullet1PVFemale) */
  private _gender: "male" | "female" = "male";
  get gender(): "male" | "female" { return this._gender; }
  set gender(v: "male" | "female") { if (v !== this._gender) { this._gender = v; this.rebindIdle(); } }
  /** which blade of a DualKnife this instance is (states <State>_Left / <State>_Right, Kunai <State>_Male_Right) */
  private _hand: "R" | "L" = "R";
  get hand(): "R" | "L" { return this._hand; }
  set hand(v: "R" | "L") { if (v !== this._hand) { this._hand = v; this.rebindIdle(); } }

  /** the Idle state key depends on gender / hand (Kunai: Idle_Male_Right), which are set after construction */
  private rebindIdle(): void {
    const idle = this.state("idle");
    if (!idle || this.idle?.getClip() === idle.clip) return;
    this.idle?.stop();
    this.idle = this.mixer.clipAction(idle.clip);
    this.idle.play();
    this.idle.timeScale = 0;
    this.idle.setEffectiveWeight(this.cur ? 0 : 1);
    this.mixer.update(0);
  }

  /** "<State>1PV<Gender>" | "<State>1PV_<Gender>" | "<State>_<Gender>" | "<State>1PV" | "<State>" (first present) */
  stateKey(kind: WeaponAnimKind): string | null {
    const s = STATE[kind], st = this.set.states, v = this.view.toUpperCase(), g = this.gender === "female" ? "Female" : "Male";
    const h = this.hand === "L" ? "Left" : "Right"; // DualKnife packs: Change_Left / Change_Right per blade
    if (this._ext && (kind === "fire" || kind === "reload" || kind === "loadBullet" || kind === "idle")) {
      for (const k of [`${s}${v}_Ext_${g}`, `${s}${v}_Ext`, `${s}_Ext`]) if (st[k]) return k;
    }
    // [INFERIDO] gender states (LoadMag1PVMale) beat the plain one (LoadMag1PV) when both exist (7 weapons, audit-weapon-anim.mjs):
    // no exe proof for the opposite order, so the preference stays. Dual packs: <State>1PV_DualGun_<Left|Right> beats <State>1PV.
    for (const k of [s + v + g, `${s}${v}_${g}`, `${s}_${g}`, `${s}${v}_DualGun_${h}`, s + v, `${s}_${v}`, s, `${s}_${g}_${v}`, `${s}_${g}_${h}`, `${s}_${h}`]) if (st[k]) return k;
    // UTS-15 pack names the pump clips by letter (reload_a/b/c/d_<gender>); same letters as the M1887 / 870MCS clips:
    // b = LoadMag (shell), c = LoadBullet (pump after the shot). [INFERIDO] from the M1887 / 870MCS letter convention
    const letter = kind === "reload" ? "B" : kind === "loadBullet" ? "C" : "";
    if (letter && st[`LoadMag${letter}_${g}`]) return `LoadMag${letter}_${g}`;
    return null;
  }
  state(kind: WeaponAnimKind): { clip: THREE.AnimationClip; dur: number; left?: boolean } | null {
    const k = this.stateKey(kind);
    return k ? this.set.states[k] : null;
  }

  has(kind: WeaponAnimKind): boolean {
    return !!this.state(kind);
  }

  private start(kind: WeaponAnimKind, speed: number, driven: boolean): boolean {
    const s = this.state(kind);
    // AUG & co.: Fire / Change = idle.i3a -> the same action as Idle; starting it stopped the idle action (bind pose after)
    if (!s || kind === "idle" || s.clip === this.idle?.getClip()) return false;
    this.cur?.stop();
    const a = this.mixer.clipAction(s.clip);
    a.reset();
    a.timeScale = 0;
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.play();
    this.cur = a;
    this.t = 0;
    this.speed = speed;
    this.driven = driven;
    this.idle?.setEffectiveWeight(0);
    this.current = s.clip.name;
    this.leftHand = !!s.left;
    this.apply();
    this.showVol();
    if (this.silencerMesh.length) this.showSilencer();
    return true;
  }

  /** One-shot in real time. `duration` (s) stretches the clip over it (3PV reload over ReloadTime). */
  play(kind: WeaponAnimKind, duration?: number): boolean {
    const s = this.state(kind);
    return !!s && this.start(kind, duration && duration > 0 ? s.clip.duration / duration : 1, false);
  }

  /** Fire state: real time, or the clip over `cycle` seconds (shotguns, WeaponShotGun 0x624c40). */
  fire(cycle?: number): boolean {
    return this.play("fire", cycle);
  }

  /** Starts a state whose time the caller sets (setTime / setProgress) until end(). */
  drive(kind: WeaponAnimKind): boolean {
    return this.start(kind, 0, true);
  }

  /** clip duration of the running state (0 = Idle) */
  get duration(): number {
    return this.cur?.getClip().duration ?? 0;
  }

  setTime(t: number): void {
    if (!this.cur) return;
    this.t = t;
    this.apply();
  }

  setProgress(p: number): void {
    this.setTime(THREE.MathUtils.clamp(p, 0, 1) * this.duration);
  }

  /** back to Idle */
  end(): void {
    if (!this.cur) return;
    this.cur.stop();
    this.cur = null;
    this.driven = false;
    this.current = "";
    this.leftHand = false;
    this.extBusy = false;
    if (this.extOffPending) { this.extOffPending = false; this._ext = false; this.rebindIdle(); }
    this.idle?.setEffectiveWeight(1);
    this.mixer.update(0);
    this.showVol();
    if (this.silencerMesh.length) this.showSilencer();
  }

  private apply(): void {
    if (this.cur) this.cur.time = THREE.MathUtils.clamp(this.t, 0, this.cur.getClip().duration);
    this.mixer.update(0);
  }

  update(dt: number): void {
    if (this.cur && !this.driven) {
      this.t += dt * this.speed;
      if (this.t >= this.cur.getClip().duration) return this.end();
    }
    this.apply();
  }

}
