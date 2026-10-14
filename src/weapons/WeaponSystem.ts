import { C4_ITEM_ID, isMissionWeapon } from "./mission";
import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { WeaponAudio } from "./audio";
import { WeaponDb } from "./data";
import { WeaponEffects, hitShapeId, hitSide,surfaceOfCollider, terrainOfCollider, type Tint } from "./effects";
import { soundTerrainOf } from "./terrainSound";
import { explosionHits } from "./explosion";
import { classSkipsWallTest, secondWallStops, wallDamageThickness, wallPenetrates } from "./penetration";
import { GrenadePhysics, grenadeArmed, type LiveGrenade } from "./grenade";
import { ScopeOverlay } from "./scope";
import { LaserSight } from "./laser";
import { loadWeaponFx, weaponFxInfo } from "./sights";
import {
  C5_TRIGGER_DELAY, CLAYMORE_CONE_COS, CLAYMORE_DETECT_RANGE, DUAL_GRENADE_TIMES, noReadySound, FlashTinnitus, emitFlashbang, isDualGrenade, isServerThrowable, flashFor, localFlash, smokeField, throwableBaseId, throwKind, type FlashBurst, type ThrowKind,
} from "./throwables";
import type {
  FireEvent, HitEvent, HitTarget, HitZone, LoadoutIds, PbItemEffects, ReloadEvent, SlotIndex, SwitchEvent,
  WeaponContext, WeaponDef, WeaponHudState, WeaponInput,
} from "./types";
import { Viewmodel, getViewmodelChara } from "./viewmodel";
import { createWeaponModel, dualFire } from "./worldModel";

import { pbHitDamage } from "../game/damage";
import { fxFireDelay, fxPct, titleFxLive } from "../gameplay/titleFx";
import { blastPoints, type BlastPoints } from "../game/hitbox";
import type { Actor } from "../game/types";
import { actorHelmetDefense } from "../game/actorEquip";
import { PB_CAMERA_SHAKE, PB_FPS_CAMERA, pbLive } from "../gameplay/pbConfig";

/** HELMET PROTECTION rate of a hit target's head item; undefined = no known item, damage.ts falls back to its default. */
const helmetRate = (t: { hasHelmet?: boolean; id?: string | number }): number | undefined =>
  (t.hasHelmet && t.id !== undefined ? actorHelmetDefense(String(t.id)) : 0) || undefined;

interface SlotState {
  /** silencer weapons (pef _Extension Silencer): the RMB extension is on */
  silencer?: boolean;
  /** Extension2 Dual: the other variant (single <-> dual) with its own magazine and reserve while it is put away */
  alt?: SlotState;
  def: WeaponDef;
  ammo: number;
  reserve: number;
}

type Listener<T> = (e: T) => void;

const DEG = Math.PI / 180;
const wrap180 = (d: number) => d - 360 * Math.round(d / 360);
/** i3 FP guard added to the item factors before use (exe: f + (f > 0 ? 2e-5 : -2e-5)) */
const PB_EPS = 0.00002;

/**
 * Swap speed, exe-2017 CGameCharaActionControl 0xa0c3d0 (the swap action: cancels zoom, then
 * _Animation_Upper(9, 0, scale) plays the upper Change state): scale starts at 1 and, once per source, scale += scale *
 * 0.5 (+eps); sources = Quick Change item (IsUseFuncItemSlot(net, 7)) and a beret of type 10 (0x622cc0 == 10); then
 * min(scale, 2.3). The new weapon is drawn at once (there is no lowering phase) and can fire when the Change state
 * ends: changeTime / scale. The upper Change clip (1PV / 3PV) and the weapon's own Change clip (0x6084f0, same loop at
 * 0x608655) play at that scale, so animation, sound events and the fire gate stay in step. Multiplicative: 1.5 (item or
 * beret), 2.25 (both). The beret comes in as fx.beretQuickChange (game/loadout.ts itemEffectsOf: the equipped
 * beret, pair 17; no equip / skill bonus is read: 0x801c90 unused here).
 */
export function pbSwapScale(fx: PbItemEffects = {}, beretQuickChange = !!fx.beretQuickChange): number {
  const n = (fx.quickChangeWeapon ? 1 : 0) + (beretQuickChange ? 1 : 0);
  let scale = 1;
  for (let i = 0; i < n; i++) scale += scale * (0.5 + PB_EPS);
  return Math.min(scale, 2.3);
}

/**
 * Reload speed, exe-2017 OnActionLoadMagazine 0xa0cd50 / OnActionLoadBullet 0xa0d2d0 and the weapon side 0x611980:
 * both the character LoadMagazine and the weapon's own LoadMag i3a play at i3AIState dur / ReloadTime; the Quick
 * Change Reload item (IsUseFuncItemSlot(net, 8)) adds scale * 0.25 (+eps), i.e. ReloadTime / 1.25. The fast-reload
 * beret multiplies by 1.25 first (isUseFastReloadTime_CurrentBeret 0x613710, constant 0xb434d8; weapons with
 * FastReloadAnimation=1 play their fast clip at scale 1 instead - that clip is not exported, so they get the same 1.25
 * [INFERRED]); the item then stacks multiplicatively: 1.5625 with both. The item is skipped for GaugeReload == 1 (only
 * WaterGun2016, not in weapons.json). LoadBullet (bolt / pump) runs at the same scale (0xa0d379). The ammo is loaded
 * when the weapon's LoadMag state passes its actual duration (0x9d0ef0), i.e. at the end.
 */
export function pbReloadScale(fx: PbItemEffects = {}): number {
  let scale = fx.beretFastReload ? 1.25 : 1;
  if (fx.quickChangeReload) scale += scale * (0.25 + PB_EPS);
  return scale;
}
/** How a dual weapon fires: worldModel.ts dualFire (shared with the 3rd-person models). */
export { dualFire };

/**
 * i3 signed random, exe-2017 0x5f08c0: (rand() & 0xfff) * 0.000488519785 - 1, i.e. 4096 steps in [-1, 1.0005]
 * (MSVC rand(); the seed is not reproduced, `rng` stands in for rand() / 32768).
 */
export function pbRandSigned(rng: () => number = Math.random): number {
  return Math.floor(rng() * 4096) * 0.000488519785 - 1;
}

/**
 * exe-2017 0x7ece10: g_SinTable[(trunc(x * 127) + 128) & 0x1ff]. The 512-entry table is filled by the i3 dll; it is read
 * here as sin(i * 2pi / 512) (the +128 = quarter turn and the 0x1ff mask only fit that layout; the dll was not read).
 */
export function pbSinTab(x: number): number {
  return Math.sin((((Math.trunc(x * 127) + 128) & 0x1ff) * Math.PI * 2) / 512);
}

/**
 * Bullet direction, WeaponBase::FireCollision 0x606b30 (loop 0x606e80-0x60719e), per pellet:
 *   right = normalize(dir x Y), up = normalize(right x dir)       (0x582ae0)
 *   a = dev * 0.5 * 0.5 * r1  -> rotate about right, degrees    (0x622700)
 *   b = r2 * dev * 0.5 * 0.5  -> rotate about up, degrees       (0x622740)
 * r1, r2 = pbRandSigned (independent, uniform), so the shot lands in a SQUARE of half-side dev/4 degrees around the aim
 * (not a disk). dev = boneCtx+0xb4 (the crosshair value before this shot's Deviation was added, 0x7e84b3).
 */
export function pbShotOffsets(dev: number, rng: () => number = Math.random): { pitch: number; yaw: number } {
  const pitch = dev * 0.5 * 0.5 * pbRandSigned(rng);
  const yaw = pbRandSigned(rng) * dev * 0.5 * 0.5;
  return { pitch, yaw };
}

/** one shot of the numeric trace (smoke / tuning); angles in degrees, t in s */
export interface PbShotTrace {
  t: number;
  /** 0-based shot index inside the trigger pull (weapon+0xd00 when _ProcessFire runs) */
  n: number;
  /** deviation used for this bullet (boneCtx+0xb4) */
  dev: number;
  /** random offset of this bullet from the aim */
  offPitch: number;
  offYaw: number;
  /** vertical recoil R.v after this shot's kick (aim gets v, camera v * CamSyncRate) */
  recV: number;
  /** horizontal kick queued by this shot (0 when the shot had no horizontal kick) */
  kickH: number;
  /** accumulated yaw offset from horizontal recoil when the shot fired */
  yaw: number;
  /** crosshair value after the shot (b0) */
  cross: number;
}

const MAX_TRACE = 300; // visual trace length; damage only inside weapon range
// Walls and bodies (exe-2017 world walk 0x6094f0 + characters 0x609a30, src/weapons/penetration.ts): one thin wall at
// most, by its terrain type / thickness and a BulletWeight roll; a sniper (class 5) goes on through every character on
// the line with the same damage, the others stop in the first one (RoomDeath.cs PiercingShot = 2+ frags in one
// death packet).
/** the walk steps this far past a wall face before casting again (0x609637: hit + dir * 0.01) */
const WALL_STEP = 0.01;
/** blast lines skip their first metres so the floor the bomb rests on does not block them (blastLineClear) [INFERIDO] */
const BLAST_SURFACE_SKIP = 0.05;

/** longest melee reach in the pefs (Death-Scythe 2.85 m) */
const MELEE_REACH_MAX = 3;
/**
 * Ballistic Knife (Melee/BallisticKnife*, pef NeedToLoadBullet 1, LoadBullet 5 / MaxBullet 5, extension item Range 70): LMB stabs, RMB
 * fires the blade like the Kunai throw. The blades are not reloadable: when the last one is gone the slot goes back to the default
 * knife (M-7). [INFERIDO: blade count = the main item's LoadBullet; the exe's rule is not decoded]
 */
const isBallisticKnife = (d: WeaponDef): boolean => d.family === "KNIFE" && !!d.pb?.needToLoadBullet && (d.pb?.loadBullet ?? 0) > 0;
/** Kunai throw: ext item 301107 Range 70; blade length to the tip of Kunai_Dual (EdgeTraceEnd 0.284 m) */
const KUNAI_RANGE = 70, KUNAI_TIP = 0.284, KUNAI_STICK_DEPTH = 0.06, KUNAI_SPEED = 45, KUNAI_STUCK_LIFE = 20;
/**
 * Effect_High Medical_Kit_Medic_01: persistent aura for the heal zone. [INFERIDO] marker: no pef, fxlist (Effect_Define) or exe
 * string names it, so the exe's own kit effect is the pef _FireEffect "buff" (both pefs; its i3s carries the sound node
 * WM_MedicKit_Recovery), played once when the kit lands; the aura is only kept so the zone stays visible
 */
const MEDIC_FX = "Medical_Kit_Medic_01";
/** the owner cannot be healed by his own kit for this long after the throw (0x668c2f: +0xa5e0 < 0.5 s, counted while the kit lives) */
const KIT_OWNER_DELAY = 0.5;

/** [INFERIDO] the demolition charge against map objects: no pef field or exe value for object damage was found; the C5's 60 could never break the 70-100 life windows */
const C5_PROP_DAMAGE_MULT = 2;
/** HUD thrown-object warning range, metres (Cross CHud driver 0x744be0 -> 0x7443c0, float 0xb2af0c; text the same) */
const GRENADE_WARN_RANGE = 10;

export class WeaponSystem {
  readonly db = new WeaponDb();
  readonly audio: WeaponAudio;
  readonly effects: WeaponEffects;
  readonly viewmodel: Viewmodel | null;
  /** host switch (dead / spectating = false). Kept apart from the scope hide: the host sets it every frame, and writing
   * viewmodel.hidden directly cleared the scope hide after update() -> the Zoom-pose weapon drawn under the overlay */
  viewmodelEnabled = true;
  /** resolves when weapons.json + sfx index are loaded (the system works before, with fallback stats) */
  readonly ready: Promise<void>;

  private ctx: WeaponContext;
  private base: string;
  private grenades: GrenadePhysics;
  private scope: ScopeOverlay;
  /** WeaponDotLaser beam + dot (laser.ts; key B) */
  readonly laser: LaserSight;
  private slots: (SlotState | null)[] = [null, null, null, null, null, null];
  private cur: SlotIndex = 0;
  private prev: SlotIndex = 0; // Q target; spawn sets it to cur (resetLast)
  private swapped = false;
  private time = 0;
  private nextFire = 0;
  private triggerLatched = false;
  private dryLatched = false;
  private reloadWasDown = false;
  private switchTimer = 0; // counts down the Change (draw) state: changeTime / pbSwapScale
  private switchTotal = 0;
  private itemFx: PbItemEffects = {};
  private reloading = false;
  private reloadTimer = 0;
  private reloadDuration = 0;
  /** ReloadTime / pbReloadScale of the running reload (per shell for shell-by-shell weapons) */
  private reloadTime = 0;
  private lastShot = -10;
  /** bullet counter: HitEvent.shot groups the hits of one bullet or blast (2+ kills = Piercing Shot / Mass Kill) */
  private shotSeq = 0;
  /** FireDelay timer weapon+0xdfc (-1 = not in the Fire state) and flag 0x100 (auto continuing) */
  private fireT = -1;
  /** 1 = the Fire state just ended (vf134 0x6177c0), next frame is the idle callback 0x9d0240; 2 = idle re-entered Fire */
  private fireEnd = 0;
  private autoCont = false;
  /** weapon shot counter (weapon+0xd00): shots since the trigger went down */
  private shotCount = 0;
  // vertical recoil state (boneCtx+0x74, 0x5cea50 / per-frame 0x7e7f60), degrees
  private recV = 0;
  private recV0 = 0;
  private recVT = 0;
  private recVt = 0;
  // horizontal recoil (0x5ced10 / per-frame 0x7e6a20): yawOff = char yaw offset from the aim, degrees
  private recH = 0;
  private recHt = 0;
  private recHdur = 0;
  private recHrecov = 1;
  private yawOff = 0;
  private yawBase = 0;
  /** yawOff at the burst start: the 2 s return pulls only the recoil back to it, not the mouse turn */
  private yawOffBase = 0;
  private hState = 0;
  private hR = 0;
  // crosshair / deviation, boneCtx+0xa8 struct (0x7e8100): +0 target, +4 start, +8 current, +0xc value at the last shot,
  // +0x10 duration, +0x14 t, +0x18 active. Degrees: the HUD gap is tan(current) * H/2 (Crosshair::CalcRminLen 0x7598b0)
  private xhCur = 0;
  private xhStart = 0;
  private xhTarget = -1;
  private xhDur = 0;
  private xhT = 0;
  private xhPrev = 0;
  private xhActive = false;
  /** RMB zoom toggle (chara state 9) and weapon+0x668 / +0x66c (FastZoom flag, time since the last zoomed shot) */
  private zoomOn = false;
  private aimWasDown = false;
  private fastZoomFresh = false;
  private sinceZoomShot = 10;
  /** stands in for MSVC rand() / 32768 in the recoil / bullet rolls (deterministic in the smoke) */
  rng: () => number = Math.random;
  /** set to [] to record every shot (PbShotTrace) */
  trace: PbShotTrace[] | null = null;
  private burstLeft = 0;
  private recoilPitch = 0; // deg
  private recoilYaw = 0;
  private appliedPitch = 0; // rad currently added to camera
  private appliedYaw = 0;
  private lastSetX = NaN;
  private lastSetY = NaN;
  /** CGameCamera::SetShake state (0x528570; a new shake replaces the running one) */
  private pbShake: { amp: number; freq: number; phase: number; time: number; t: number } | null = null;
  private shakeP = 0;
  private shakeR = 0;
  /** CGameCamera zoom (0x5281d0 / 0x528260): from -> to over PB_FPS_CAMERA.zoomTime, sin(90deg * t / T) */
  private fovTween: { from: number; to: number; t: number } | null = null;
  private baseFov: number;
  /** ESC menu / lobby FOV slider (gameplay/settings.ts): re-anchors the non-aiming FOV live. */
  setBaseFov(fov: number): void {
    this.baseFov = fov;
  }
  private aiming = false;
  private scoped = false;
  /** seconds the scope overlay has been open (breath sound timer, exe 0x7412f0 +0x84) */
  private scopedFor = 0;
  private boltUntil = 0;
  /** WeaponDualHandGun +0xa550: the next shot is the left gun's */
  private dualLeft = false;
  private throwTimer = -1;
  /**
   * Weapon flag 8 of a ThrowingGrenade (class 7): set by the press (ProcessWeapon 0xa21f89 -> Cmd_Attack(2) ->
   * OnFireReady 0xa14760 -> WeaponGrenade::FireReady vf+0x1a4 0x630b80: AttackReady anim, 0x6069e0 flags 1|8). The
   * throw only starts on the RELEASE (0xa221ab: button up + class 7 + flag 8 -> Cmd_Attack(0)); it can be held forever.
   */
  private throwReady = false;
  /** length of the running throw (the Throwing AI's Attack state) */
  private throwTotal = 1;
  /** net replication of the local player's throwables (game.ts -> NetAdapter.sendThrow, SubHead.Grenade) */
  onThrowNet: ((e: { state: "throw" | "trigger" | "explode"; g: LiveGrenade; pos: THREE.Vector3; vel: THREE.Vector3 }) => void) | null = null;
  /** local player healed by a medical kit (hp amount); game.ts adds it to the player */
  onHeal: ((amount: number) => void) | null = null;
  /** the local character as a heal target: feet, head height, null when dead / at full HP (game.ts) */
  healBody: (() => { feet: THREE.Vector3; headY: number } | null) | null = null;
  /** live medical kits: when the local one was thrown, and the aura that marks where it lies */
  private kits = new Map<LiveGrenade, { born: number; aura: THREE.Group | null }>();
  /** C5 thrown by the local player and not yet detonated (WeaponBombTrigger list +0xa54c) */
  private planted: LiveGrenade[] = [];
  /** Claymores of the local player (value: look = thrower's aim at the throw, triggered = fuse running); see updateMines */
  private mines = new Map<LiveGrenade, { look: THREE.Vector3; triggered: boolean }>();
  private c5AimLatched = false;
  private tinnitus: FlashTinnitus;
  private spreadNow = 0;
  private pending: { t: number; fn: () => void }[] = [];
  private lastInput: WeaponInput = { fire: false, aim: false };

  private fireL: Listener<FireEvent>[] = [];
  private hitL: Listener<HitEvent>[] = [];
  private reloadL: Listener<ReloadEvent>[] = [];
  private switchL: Listener<SwitchEvent>[] = [];

  constructor(ctx: WeaponContext) {
    this.ctx = ctx;
    this.base = (ctx.assetBase ?? "/assets/weapons").replace(/\/$/, "");
    const { scene, camera } = ctx;
    if (!camera.parent) scene.add(camera); // camera children (viewmodel, listener) need the camera in the graph
    this.baseFov = camera.fov;
    this.audio = new WeaponAudio(scene, camera, this.base, ctx.audioListener);
    this.effects = new WeaponEffects(scene);
    this.viewmodel = ctx.viewmodel === false ? null : new Viewmodel(camera, this.base);
    this.scope = new ScopeOverlay();
    // weapon FX data of the 2017 client (scope HUD textures, i3 particle effects, laser) — fx/weaponfx.json
    void loadWeaponFx(this.base);
    this.laser = new LaserSight(this.effects, (o, d, max) => {
      const h = this.castNormal(o, d, max);
      return h ? o.clone().addScaledVector(d, h.timeOfImpact) : null;
    });
    this.laser.bindKey();
    this.tinnitus = new FlashTinnitus(this.audio.listener);
    this.grenades = new GrenadePhysics(scene, ctx.world, ctx.RAPIER,
      (g, p) => this.explode(g, p),
      (g, p, terrain) => {
        // a medical kit only gets here when it bounces (wall / steep slope, kitLands false): the exe plays WM_Throw_Bound too (vf 0x204)
        // WeaponC5::_BoundObject: exe string WM_C5_Stick (not the terrain bound clip); no stick sound for a Claymore (its pack has only CHANGE / Fire)
        if (g.sticky) { if (throwKind(g.weapon) === "c5") this.audio.c5Stick(p); }
        else this.audio.bounce(g.weapon, p, terrain);
      },
      (g, p) => this.kitLanded(g, p));
    // the grenade ray skips its thrower (0x62fc60); replicated throws hit everything
    this.grenades.rayFilter = (g) => ({ groups: this.ctx.filterGroups, exclude: g.local ? this.own() : undefined });
    this.setLoadout(ctx.loadout ?? {});
    this.ready = Promise.allSettled([this.db.load(`${this.base.replace(/\/weapons$/, "/cross/weapons")}/weapons.json`), this.audio.load()]).then((r) => {
      for (const x of r) if (x.status === "rejected") console.warn("[weapons]", x.reason);
      // re-resolve defs with the full json (same ids) keeping ammo
      this.setLoadout(ctx.loadout ?? {}, true);
    });
  }

  // ---- events --------------------------------------------------------------
  onFire(cb: Listener<FireEvent>): () => void { return this.sub(this.fireL, cb); }
  onHit(cb: Listener<HitEvent>): () => void { return this.sub(this.hitL, cb); }
  onReload(cb: Listener<ReloadEvent>): () => void { return this.sub(this.reloadL, cb); }
  onSwitch(cb: Listener<SwitchEvent>): () => void { return this.sub(this.switchL, cb); }
  private sub<T>(arr: Listener<T>[], cb: Listener<T>) {
    arr.push(cb);
    return () => {
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    };
  }
  private emit<T>(arr: Listener<T>[], e: T) {
    for (const l of arr.slice()) l(e);
  }

  // ---- loadout -------------------------------------------------------------
  /** ids from weapons.json; missing entries use weapons.json defaultLoadout. keepAmmo re-resolves stats only. */
  setLoadout(ids: Partial<LoadoutIds>, keepAmmo = false): void {
    const d = this.db.defaultLoadout;
    // slot 5: empty, or an owned item with no Cross throwable row (hidden in the Cross-only shop data) -> FlashBang 508002, the server's
    // slot-5 default (roomPackets WEAPON_DEFAULTS[4]); it has a model (throwables.ts ROWS 508002 -> flashbang.glb)
    const sp = ids.special;
    const special = sp && Math.trunc(sp / 100000) % 100 === 5 && isServerThrowable(sp) ? sp : 508002;
    const want = [ids.primary ?? d.primary, ids.secondary ?? d.secondary, ids.melee ?? d.melee, ids.grenade ?? d.grenade, special];
    want.forEach((id, i) => {
      this.owned[i] = id ?? null;
      const def = this.db.def(id);
      if (!def) {
        if (!keepAmmo) this.slots[i] = null;
        return;
      }
      const old = this.slots[i];
      if (keepAmmo && old && old.def.id === id) old.def = def;
      else this.slots[i] = this.fresh(def, i);
      this.audio.preload(def);
    });
    // before weapons.json loads only the built-in stats exist: a primary missing from them made the pistol current, and the
    // keepAmmo re-resolve must then go back to the first slot (unless the player already swapped)
    if (!this.slots[this.cur] || (keepAmmo && !this.swapped)) {
      const first = Math.max(0, this.slots.findIndex(Boolean)) as SlotIndex;
      if (first !== this.cur) { this.cur = first; keepAmmo = false; }
    }
    const cur = this.slots[this.cur];
    if (cur && !keepAmmo) {
      this.viewmodel?.setWeapon(cur.def);
      this.emit(this.switchL, { from: null, to: cur.def, slot: this.cur });
    } else if (cur && keepAmmo) this.viewmodel?.setWeapon(cur.def);
  }

  /** Room weapon limit (sniper / shotgun / knife modes): the slot has no allowed weapon this life, so it stays empty;
   * the hand goes to the first slot still armed. */
  clearSlot(idx: SlotIndex): void {
    if (!this.slots[idx]) return;
    this.slots[idx] = null;
    this.owned[idx] = null;
    if (idx !== this.cur) return;
    this.cancelReload();
    const first = this.slots.findIndex(Boolean);
    if (first < 0) return;
    this.cur = first as SlotIndex;
    const def = this.slots[first]!.def;
    this.startChange(def);
    this.viewmodel?.setWeapon(def);
    this.emit(this.switchL, { from: null, to: def, slot: this.cur });
  }

  /**
   * Observer mode: the first-person arms hold the OBSERVED player's weapon (CStageBattle::ProcessObserverMode 0x76ab80 -> 0x76c810 shows the
   * target's view weapon); null gives the own current weapon back. View only: ammo / slots are untouched.
   */
  observe(target: { id?: number; name?: string; chara?: number; team?: 0 | 1 } | null, opts: { swap?: boolean } = {}): void {
    if (!this.viewmodel) return;
    if (!target) {
      this.obs = null;
      this.obsDef = null;
      this.obsBoltUntil = 0;
      this.obsThrowT = -1;
      this.viewmodel.throwT = -1;
      this.viewmodel.throwReady = false;
      this.viewmodel.observing = false;
      if (this.ownArms !== undefined) { this.viewmodel.setArms(this.ownArms, null); this.ownArms = undefined; }
      const cur = this.slots[this.cur];
      if (cur) this.viewmodel.setWeapon(cur.def);
      return;
    }
    if (this.ownArms === undefined) this.ownArms = getViewmodelChara();
    this.viewmodel.setArms(target.chara ? { itemId: target.chara, team: target.team ?? 0 } : null, target.team ?? 0); // his skin's arms
    const id = target.id || (target.name ? this.db.find(target.name)?.id : 0);
    const def = id ? this.db.def(id) : undefined;
    if (def) {
      const swap = def.id !== this.obsDef?.id;
      this.viewmodel.observing = true;
      this.viewmodel.reloadScale = 1; // not the spectator's own Quick Change Reload from an earlier life
      this.obsDef = def;
      if (swap) { this.obsBoltUntil = 0; this.obsThrowT = -1; this.viewmodel.throwT = -1; this.viewmodel.throwReady = false; } // a cut throw / pin does not follow the swap
      this.viewmodel.setWeapon(def, true, !(swap && opts.swap)); // no Change clip on mount unless HE swapped
      // his draw (Change) state runs on the arms only when HE swapped weapons (quick swaps included); a new watched player / view
      // already holds his weapon: no draw clip, and one still running from the previous target is dropped
      if (swap && opts.swap) this.startChange(def);
      else this.switchTimer = 0;
    }
  }

  private obsNextFire = 0;
  /** the watched player's bolt rifle is cycling: his scope drops until the next round is chambered */
  private obsBoltUntil = 0;

  observedFireMode(): string | null {
    return this.obsDef ? this.obsDef.fireMode : null;
  }

  /** world position of the arms' muzzle while a player is watched in FPS (his tracer / flash start there, not at his hidden 3PV body) */
  observedMuzzle(out: THREE.Vector3): THREE.Vector3 | null {
    return this.obsDef && this.viewmodel ? this.viewmodel.muzzleWorld(out) : null;
  }

  /** the watched weapon's ReloadTime (s): the arms' LoadMagazine clip is stretched over it (his Quick Change Reload is not networked) */
  observedReloadSecs(): number | null {
    return this.obsDef ? this.obsDef.params.reloadTime : null;
  }

  /** the watched player's grenade pin is out / put back: the arms' FireReady pose (same viewmodel flag as the own readied throw) */
  observeReady(on: boolean): void {
    if (this.viewmodel && this.obsDef?.family === "GRENADE") this.viewmodel.throwReady = on;
  }

  /** running throw of the watched player (0..1 of the Attack clip, -1 none) */
  private obsThrowT = -1;
  private obsThrowTotal = 1;

  /** the watched player threw: the Throwing AI's Attack clip from the release (same viewmodel path as startThrow) [INFERIDO: C5 trigger press also reads as a throw] */
  private observeThrow(def: WeaponDef): void {
    const vm = this.viewmodel;
    if (!vm) return;
    this.obsThrowTotal = vm.throwDuration(throwKind(def) === "c5") ?? (isDualGrenade(def.id) ? 1.6667 : 1);
    vm.throwTotal = this.obsThrowTotal;
    vm.throwReady = false;
    this.obsThrowT = 0;
  }

  private ownArms: { itemId: number; team: 0 | 1 } | null | undefined = undefined;
  private obsDef: WeaponDef | null = null;
  private obs: { speed: number; grounded: boolean; aiming: boolean; reloadT: number } | null = null;

  /** the observed player's motion for the arms (walk / run bob, jump, zoom, reload progress -1 = none) */
  observeState(s: { speed: number; grounded: boolean; aiming: boolean; reloadT: number }): void {
    this.obs = s;
  }

  /** the observed player holds the C4 install: the Install clip on the arms + the LCD steps */
  observePlant(on: boolean, progress: number): void {
    // game.ts calls this every frame: the release goes out once (plantHold(false) drops whatever one-shot runs, so his
    // Attack / knife swing / throw clips were cut on the frame they started); the hold keeps retrying until the rig is mounted
    if (on || this.obsPlanting) this.viewmodel?.plantHold(on);
    this.obsPlanting = on;
    if (on) this.viewmodel?.plantProgress(progress);
  }
  private obsPlanting = false;

  /** the observed player fired: kick + the arms' Attack clip + muzzle flash (the shot sound comes from the positional remote fire) */
  observeFire(heavy = false, tint?: Tint): void {
    const vm = this.viewmodel, def = this.obsDef;
    if (!vm || !def || this.time < this.obsNextFire) return;
    this.obsNextFire = this.time + Math.max(0.05, def.fireDelay) * 0.8; // one arms shot per weapon cycle (shot events + the firing flag both land here)
    // a stab / throw is not a shot: the knife swings (light / heavy as the remote's fire event says), no kick, no muzzle flash
    if (def.family === "KNIFE") { vm.meleeSwing(heavy, heavy ? def.params.melee?.delayB ?? def.fireDelay : def.fireDelay, !!def.params.melee?.timeA2); return; }
    if (def.family === "GRENADE") { this.observeThrow(def); return; }
    if (def.fireMode === "bolt" && this.scoped) this.obsBoltUntil = this.time + Math.max(def.fireDelay, def.params.loadBulletTime ?? 0);
    vm.fireKick(def.family === "SR" || def.family === "SG" ? 6 : def.family === "HG" ? 3.5 : 2.2, false);
    this.effects.setWeapon(def.id, def.family);
    this.effects.muzzleFlash(vm.muzzleNode, vm.muzzleWorld(), def.family === "SG" || def.family === "SR" ? 1.5 : 1, undefined, tint);
    if (def.params.loadBulletTime !== undefined) vm.loadBullet();
  }

  /** put any weapon id in its slot (by weapons.json slot: 1..4 -> index 0..3) */
  equip(id: number): boolean {
    const def = this.db.def(id);
    if (!def) return false;
    const idx = (isMissionWeapon(def.id) ? 5 : Math.min(5, Math.max(1, def.slot)) - 1) as SlotIndex;
    this.slots[idx] = this.fresh(def, idx);
    this.owned[idx] = id;
    this.audio.preload(def);
    if (idx === this.cur) {
      this.cancelReload();
      this.nextFire = 0;
      this.startChange(def); // draw the new weapon
      this.viewmodel?.setWeapon(def);
      this.emit(this.switchL, { from: null, to: def, slot: idx });
    }
    return true;
  }

  /** Bomb Mission C4 in hand: the Install arm clip runs while the plant is held */
  plantHold(on: boolean): void {
    this.viewmodel?.plantHold(on);
  }

  /** install progress 0..1 on the C4's LCD in the hand (null: off) */
  plantProgress(p: number | null): void {
    this.viewmodel?.plantProgress(p);
  }

  /** Bomb Mission: the attackers carry the C4 in the 6th (mission) slot, key 6 (exe: Cmd_ChangeWeapon(5); firing a class 9 weapon = Cmd_Install). */
  setMission(on: boolean): void {
    const has = !!this.slots[5];
    if (on) {
      if (!has && !this.equip(C4_ITEM_ID)) console.warn(`[weapons] C4 ${C4_ITEM_ID} not in weapons.json / not loaded: no bomb for the attackers`);
      return;
    }
    if (has) this.clearSlot(5);
  }

  private fresh(def: WeaponDef, slot = -1): SlotState {
    if (def.family === "GRENADE") {
      // Increase Grenade Slot (throwing slot, a pair for dual grenades) / Increase Smoke Slot (special slot) [INFERIDO +1]
      const extra = slot === 3 && this.itemFx.extraGrenade ? (isDualGrenade(def.id) ? 2 : 1)
        : slot === 4 && this.itemFx.extraSpecialThrow ? 1 : 0;
      return { def, ammo: Math.max(1, def.loadedBullet) + extra, reserve: 0 };
    }
    if (isBallisticKnife(def)) return { def, ammo: def.loadedBullet, reserve: 0 };
    if (def.family === "KNIFE") return { def, ammo: 0, reserve: 0 };
    // Ammo Up coupon: reserve (weapon.pef MaxBullet) + 40% / 10% [INFERIDO: the exe's Ability bullet formula is not
    // decoded; applied to the reserve of every firearm, rounded down]
    return { def, ammo: def.loadedBullet, reserve: Math.floor(def.totalBullet * (1 + (this.itemFx.ammoUp ?? 0))) };
  }

  /** full ammo on every slot (respawn); a dropped or picked-up weapon gives way to the player's own loadout again */
  refill(): void {
    this.slots = this.slots.map((s, i) => {
      const own = this.owned[i] != null ? this.db.def(this.owned[i]!) : null;
      const def = own ?? s?.def ?? null;
      return def ? this.fresh(def, i) : null;
    });
    this.cancelReload();
    this.throwReady = false; // a readied grenade does not survive death
    this.throwTimer = -1; // nor a throw cut by the death
    if (this.viewmodel) { this.viewmodel.throwReady = false; this.viewmodel.throwT = -1; }
  }

  /** Spawn: the weapon control Reset (0xa12f50) clears the last-weapon slot (+0x1dc = -1), picks the first usable weapon and
   * stores it as last (0xa13038: setLast(current slot 0xa127a0)), so in the exe Q right after spawn is a no-op (OnPreSelectWeapon
   * 0xa13620, `cur == req` -> false at 0xa136c1) until the first real swap. Deliberate divergence (user decision 2026-10-05):
   * Q works from the spawn, last = the secondary (else the next usable slot). A stale prev from the previous life (empty / spent
   * slot) made Q work or fail at random. */
  resetLast(): void {
    const order = [1, 0, 2, 3, 4, 5] as SlotIndex[];
    this.prev = order.find((i) => i !== this.cur && this.slots[i] && this.usable(this.slots[i]!)) ?? this.cur;
  }

  current(): WeaponDef | null {
    return this.slots[this.cur]?.def ?? null;
  }

  /** weapon ids the player owns per slot (setLoadout / equip); refill() restores them after a drop / pickup */
  private owned: (number | null)[] = [null, null, null, null, null, null];

  /** slot index 0..3 is empty (dropped): the drop search (0xa11f40) only picks up into an empty primary / secondary */
  slotEmpty(slot: SlotIndex): boolean {
    return !this.slots[slot];
  }

  /**
   * G, CGameCharaInputControlLocal::ProcessDropWeapon 0xa21070 -> WriteGameEvent_DropWeapon 0x9fb1c0: the current
   * weapon leaves the hand with its loaded (0x615380) / extra (vf148) / reserve (0x615470) rounds. Only usage 0 / 1
   * (primary, secondary: `slot <= 1` at 0x9fb1d0), not while the weapon is in its Fire state (0x623040 == 2), not in a
   * dead state. `force` = the death drop (CGameCharaManager::DeathHuman 0x57364e: the weapon in hand if its slot < 2),
   * which skips the fire-state gate. Returns the dropped weapon, or null.
   */
  dropCurrent(force = false): { def: WeaponDef; slot: SlotIndex; ammo: number; reserve: number } | null {
    const slot = this.cur;
    const s = this.slots[slot];
    if (!s || slot > 1) return null;
    if (!force && this.fireT >= 0 && this.lastInput.fire) return null;
    this.cancelReload();
    this.setZoom(false);
    this.fireT = -1; this.fireEnd = 0;
    this.autoCont = false;
    this.burstLeft = 0;
    this.slots[slot] = null;
    const out = { def: s.def, slot, ammo: s.ammo, reserve: s.reserve };
    // [RECRIADO] the next weapon is drawn (the receiver's 0xa13900 path swaps; its slot order was not traced)
    if (!force) {
      for (let k = 1; k <= 4; k++) {
        const i = ((slot + k) % 5) as SlotIndex;
        const n = this.slots[i];
        if (n && this.usable(n)) {
          this.switchTo(i);
          break;
        }
      }
    }
    return out;
  }

  /**
   * Pick-up (WriteGameEvent_PickupWeapon 0x9fb580): the dropped weapon goes into its (empty) usage slot with the rounds
   * it had on the ground; the player keeps the weapon in hand ([RECRIADO]: the local swap after the pickup ack is not
   * traced), except when the hand is empty. Returns false if the slot is taken or the id is unknown.
   */
  pickUp(id: number, ammo: number, reserve: number): boolean {
    const def = this.db.def(id);
    if (!def) return false;
    const idx = (isMissionWeapon(def.id) ? 5 : Math.min(5, Math.max(1, def.slot)) - 1) as SlotIndex;
    if (idx > 1 || this.slots[idx]) return false;
    this.slots[idx] = { def, ammo: Math.max(0, Math.min(def.loadedBullet, ammo)), reserve: Math.max(0, reserve) };
    this.audio.preload(def);
    if (!this.slots[this.cur]) this.switchTo(idx);
    else this.audio.play(this.audio.swap(def));
    return true;
  }

  /** Battle item effects (Quick Change / Quick Change Reload) of the local player. */
  setItemEffects(fx: PbItemEffects): void {
    this.itemFx = { ...fx };
  }

  /** 1600187 muzzle tint of the local player's own flash, set by game.ts from the room slot (undefined = the weapon's own colour) */
  ownMuzzleTint: () => Tint | undefined = () => undefined;

  /** Swap time of a weapon with the current item effects (s). */
  changeTimeOf(def: WeaponDef): number {
    // the observed player's swap: the spectator's own Quick Change / beret does not apply (his are not networked: scale 1)
    return def.params.changeTime / pbSwapScale(this.obsDef ? {} : this.itemFx);
  }

  /** Reload time of a weapon with the current item effects (s; per shell for shell-by-shell weapons). */
  reloadTimeOf(def: WeaponDef): number {
    return def.params.reloadTime / pbReloadScale(this.itemFx);
  }

  private startChange(def: WeaponDef) {
    this.switchTotal = this.changeTimeOf(def);
    this.switchTimer = this.switchTotal;
  }

  /**
   * PB swap (0xa0c3d0): the reload is cancelled, the new weapon is attached at once and its Change (draw) state plays;
   * it can fire when the state ends. Pressing another slot while drawing starts that weapon's draw.
   * CGameCharaWeaponControl::OnPreSelectWeapon 0xa13620: the current slot becomes the "last" slot (0xa130e0, weapon ctx
   * +0x1dc, read back by Q through 0x76a6e0); a weapon still owing its LoadBullet (flag 0x80000, set by OnFire 0xa1448e
   * when NeedToLoadBullet) gets 0x80011 cleared and its shot counter reset (0x6230b0 / 0x6152d0), and a LoadBullet state
   * already running is simply replaced by the swap: the bolt / pump cycle is dropped and the round stays chambered. That
   * is the QQ trick: shot -> Q -> Q -> the sniper fires as soon as its Change ends, zoom off (Cmd_ChangeWeapon 0x78a930
   * -> _Idle_Camera). The burst pause (weapon +0x688) goes with it.
   */
  switchTo(slot: SlotIndex): void {
    if (slot === this.cur) return;
    this.swapped = true;
    if (!this.slots[slot]) return;
    const g = this.slots[slot]!;
    if (!this.usable(g)) return;
    this.cancelReload();
    this.throwTimer = -1;
    this.throwReady = false;
    // a throw cut by the swap: the viewmodel kept the last throw time, so the next time the grenade was drawn it still
    // counted as past its release and hid the grenade in the hand (K-400 invisible)
    if (this.viewmodel) { this.viewmodel.throwReady = false; this.viewmodel.throwT = -1; }
    this.burstLeft = 0;
    this.dualLeft = false;
    this.fireT = -1; this.fireEnd = 0; this.shotCount = 0; // ReturnToReady resets weapon+0xd00
    this.autoCont = false;
    this.nextFire = 0; // LoadBullet / burst pause of the weapon put away: dropped (0xa1383c)
    this.boltUntil = 0;
    this.setZoom(false); // the swap action cancels zoom first (0xa0c3d0 -> OnActionActiveZoom(0))
    const from = this.slots[this.cur]?.def ?? null;
    this.prev = this.cur;
    this.cur = slot;
    this.startChange(g.def);
    this.viewmodel?.setWeapon(g.def);
    this.audio.play(this.audio.swap(g.def));
    this.xhCur = 0;
    this.xhTarget = -1;
    this.emit(this.switchL, { from, to: g.def, slot });
  }

  /**
   * Extension2 Type "Dual" (pef, 641 items: Kriss S.V 104013 Extension2 ITEMID 118001; the dual item 118001 has
   * OriginalWeaponID 104013 and Extension1 Dual_Left ITEMID 104012 = the left-hand gun): the extension key swaps the
   * single item for the dual one and back (pb.dualId / pb.dualOf). The draw of the new item is its Change state
   * (swap sound WM_KrissV_Dual, changeTime, 1PV / 3PV dual AI); no dedicated toggle clip is known [INFERIDO]. Ignored
   * during reload / swap / bolt cycle like the zoom key (ProcessExtension 0xa238f0). Each variant keeps its own
   * magazine + reserve while the other is in hand [INFERIDO]; refill() restores the owned (single) item. The
   * remote side follows by the weaponId already sent every frame.
   */
  private toggleDual(): void {
    const s = this.slots[this.cur];
    if (!s || this.obsDef || this.reloading || this.switchTimer > 0 || this.time < this.nextFire) return;
    const to = s.def.pb?.dualId ?? s.def.pb?.dualOf;
    const def = to !== undefined ? this.db.def(to) : undefined;
    if (!def) return;
    const alt = s.alt ?? this.fresh(def, this.cur);
    alt.alt = { def: s.def, ammo: s.ammo, reserve: s.reserve };
    this.slots[this.cur] = alt;
    this.audio.preload(def);
    this.setZoom(false);
    this.dualLeft = false;
    this.burstLeft = 0;
    this.fireT = -1; this.fireEnd = 0; this.shotCount = 0;
    this.autoCont = false;
    this.nextFire = 0;
    this.boltUntil = 0;
    this.startChange(def);
    this.viewmodel?.setWeapon(def);
    this.audio.play(this.audio.swap(def));
    this.xhCur = 0;
    this.xhTarget = -1;
    this.emit(this.switchL, { from: s.def, to: def, slot: this.cur });
  }

  /** a slot can be drawn: throwables need one left, or (C5) a planted one to detonate with the bomb trigger */
  private usable(s: SlotState): boolean {
    if (s.def.family !== "GRENADE" || s.ammo > 0) return true;
    return throwKind(s.def) === "c5" && this.planted.length > 0;
  }

  private cycle(dir: number) {
    for (let k = 1; k <= 5; k++) {
      const i = (((this.cur + dir * k) % 5) + 5) % 5 as SlotIndex;
      const s = this.slots[i];
      if (s && this.usable(s)) return this.switchTo(i);
    }
  }

  // ---- main loop -----------------------------------------------------------
  /** call once per frame AFTER the player controller wrote the camera transform */
  update(dt: number, input: WeaponInput): void {
    this.time += dt;
    this.lastInput = input;
    this.syncCamera(); // re-apply recoil offset so the shot direction includes it

    if (input.slot !== undefined && input.slot !== null) this.switchTo(input.slot);
    else if (input.lastWeapon) this.switchTo(this.prev); // Q: the slot that was current before the last swap
    if (input.scroll) this.cycle(input.scroll > 0 ? 1 : -1);
    if (input.extension2) this.toggleDual();

    this.runPending();
    this.updateHeal();
    this.updateKunai(dt);
    this.updateSwitch(dt);
    const s = this.slots[this.cur];
    const switching = this.switchTimer > 0;

    const reloadDown = !!input.reload;
    if (reloadDown && !this.reloadWasDown) this.startReload();
    this.reloadWasDown = reloadDown;
    this.updateReload(dt, input);

    if (this.obsThrowT >= 0 && this.viewmodel) {
      this.obsThrowT += dt;
      const done = this.obsThrowT >= this.obsThrowTotal;
      this.viewmodel.throwT = done ? -1 : this.obsThrowT / this.obsThrowTotal;
      if (done) this.obsThrowT = -1;
    }
    const speed = this.obs ? this.obs.speed : input.speed ?? (input.moving ? 3 : 0);
    const grounded = this.obs ? this.obs.grounded : input.grounded ?? true;

    if (this.fireT >= 0 && this.fireEnd === 0) this.fireT += dt; // 0x9d0910: timer += dt every frame of the Fire state
    if (s && !switching) {
      const f = s.def.family;
      if (f === "KNIFE") this.updateMelee(s, input);
      else if (f === "GRENADE") this.updateGrenade(s, input, dt);
      else if (isMissionWeapon(s.def.id)) { /* Bomb Mission C4: inert here, Game reads the held fire button (plant) */ }
      else this.updateGun(s, input, speed, grounded, dt);
    }
    if (!input.fire) {
      this.autoCont = false;
      this.triggerLatched = false;
      this.dryLatched = false;
    }

    // aim / scope / fov: RMB is a press toggle, not a hold (zoom command 0x78bd90: zoom(!state 9); scope weapons
    // 0x78bdb0: next level while level < MaxScopeLevel, else off). The knife keeps the raw RMB (heavy attack).
    // observer (first-person view of another player): his weapon and his zoom state drive the scope overlay / FOV; the spectator's own
    // zoom state and slots are not touched. Scope level 1 [INFERIDO]: the level he picked is not networked.
    const od = this.obsDef && this.obs ? this.obsDef : null;
    const vdef = od ?? s?.def;
    const gun = vdef && vdef.family !== "KNIFE" && vdef.family !== "GRENADE" && !isMissionWeapon(vdef.id);
    if (vdef) this.scope.setWeapon(vdef.id);
    if (od) {
      this.aiming = !!(gun && this.obs!.aiming && this.obs!.reloadT < 0);
      this.scoped = this.aiming && !!od.params.scope && this.time >= this.obsBoltUntil;
    } else {
      const aimPress = !!input.aim && !this.aimWasDown;
      this.aimWasDown = !!input.aim;
      if (!gun || switching || input.cancelZoom) this.setZoom(false);
      else if (aimPress && !this.reloading) this.pressZoom(s!.def);
      this.aiming = !!(gun && this.zoomOn && !this.reloading && !switching);
      this.scoped = this.aiming && !!s!.def.params.scope && this.time >= this.boltUntil;
    }
    const targetFov = this.aiming && (vdef!.params.scope ? this.scoped : true)
      ? (this.scoped ? this.scope.fov(vdef!.params.zoomFov ?? this.baseFov) : vdef!.params.zoomFov ?? this.baseFov) : this.baseFov;
    const cam = this.ctx.camera;
    if (!this.fovTween ? Math.abs(targetFov - cam.fov) > 0.01 : this.fovTween.to !== targetFov) {
      this.fovTween = { from: cam.fov, to: targetFov, t: 0 };
    }
    if (this.fovTween) {
      const z = this.fovTween, T = PB_FPS_CAMERA.zoomTime;
      z.t += dt;
      cam.fov = z.t >= T ? z.to : z.from + (z.to - z.from) * Math.sin((Math.PI / 2) * (z.t / T));
      cam.updateProjectionMatrix();
      if (z.t >= T) this.fovTween = null;
    }
    this.scope.setVisible(this.scoped);
    // MV / WV_Zoom_Breath: once, when the scope has been open 2 s (0x7412f0: timer < 2 <= timer + dt; reset when it closes)
    if (this.scoped && !od) {
      if (this.scopedFor < 2 && this.scopedFor + dt >= 2) this.audio.breath(this.ctx.isFemale?.() ?? false);
      this.scopedFor += dt;
    } else this.scopedFor = 0;

    // spread / recoil recovery (0x7e7f10: vertical 0x7e7f60, crosshair target 0x7e7d90, interpolation 0x7e8100)
    if (!input.fire) this.shotCount = 0; // FireEnd vf1a8 0x606ac0 resets weapon+0xd00 on release
    this.sinceZoomShot += dt; // WeaponBase::OnUpdate 0x611559: weapon+0x66c += dt
    if (s) {
      this.updateRecoil(dt);
      this.updateCrosshair(s.def, speed, grounded, !!input.crouching, dt);
      this.recoilPitch = this.recV * s.def.params.recoil.camSyncRate; // camera shows R.v * CamSyncRate (0x7e5670)
      this.recoilYaw = this.yawOff;
    }
    // laser after this frame's recoil reached the camera (no shake yet: the shake only turns the camera, 0x5285e0), so
    // the dot, the overlay and the view move together in the same frame
    this.syncCamera();
    if (vdef) {
      this.laser.setWeapon(vdef.id, this.viewmodel?.laserDummy ?? null);
      this.laser.update(cam, this.aiming, vdef.params.range ?? vdef.range, this.time - this.lastShot < 0.1, this.aimRay());
    } else this.laser.active = false;
    // live link to the player controller (MoveNormal_* speed factors, WeaponBase::GetMoveSpeed 0x615ea0)
    const armed = !!s && s.def.family !== "KNIFE" && s.def.family !== "GRENADE" && !isMissionWeapon(s.def.id);
    pbLive.moveNormal = s?.def.params.moveNormal ?? null;
    pbLive.firing = !!s && this.time - this.lastShot < Math.max(0.1, s.def.fireDelay * 1.5);
    pbLive.aiming = armed && this.aiming;
    pbLive.scoped = this.scoped;
    this.updateShake(dt);
    this.syncCamera(true);

    if (this.viewmodel) {
      // _ZoomType 3 overlay (scope / DotSight): the viewer's own model is hidden for the whole zoom, 0x816c13 AddFlag(2)
      this.viewmodel.hidden = this.scoped || !this.viewmodelEnabled;
      // draw progress 0..1 -> Change clip time (the viewmodel plays the whole state over the swap time)
      this.viewmodel.switchT = this.switchTimer > 0 ? 1 - this.switchTimer / Math.max(0.001, this.switchTotal) : 1;
      this.viewmodel.silencerWanted = !!s?.silencer;
      this.viewmodel.reloadT = this.obs ? this.obs.reloadT : this.reloading ? 1 - this.reloadTimer / Math.max(0.001, this.reloadDuration) : -1;
      // no Zoom-stance pose under the overlay: it would still be blending out (weapon centred) on the first unscoped frames
      this.viewmodel.update(dt, cam, speed, grounded, (this.obs ? this.obs.aiming : this.aiming) && !this.scoped);
    }
    this.updateMines();
    this.grenades.update(dt);
    this.updateTrails(dt);
    this.effects.update(dt);
    localFlash.update(dt); // CGameCharaHUDContext::OnUpdate state 2 (PbHud draws localFlash.alpha)
    this.tinnitus.update(localFlash);
  }

  /**
   * Crosshair target for the current posture, CGunInfo vf21c 0x5ce780 (caller 0x7e7d90), vtable getters c4..e8:
   *   m = CrossHair_Min (<= 0 -> 0.01, 0x618170); t = m                                   (0x5ce7a6: the base is m itself)
   *   standing: t += m*Stand; zoomed (state 9): t += m*Zoom, else sniper (class 5): t += NoZoom (not x m)
   *   move state (animCtx+0x44): idle -> crouched ? m*Sit; run -> m*(crouch ? MoveSit : Move); jump -> m*Jump;
   *   walk -> m*(crouch ? WalkSit : Walk); hit state -> + m*Damage (not wired: no hit feed); + equip bonus (0 here)
   *   clamp(0, CrossHair_Max)
   * The chara-state-0x10 x g_d80b3c+0x2c factor on Stand is not modelled (state not identified).
   */
  private crosshairTarget(def: WeaponDef, speed: number, grounded: boolean, crouch: boolean): number {
    const c = def.params.spread.cross;
    const m = c.min > 0 ? c.min : 0.01;
    let t = m;
    if (!crouch) t += m * c.stand;
    if (this.aiming) t += m * c.zoom;
    else if (def.classType === 5) t += c.noZoom;
    if (!grounded) t += m * c.jump;
    else if (speed > 0.5) t += m * (pbLive.walking ? (crouch ? c.walkSit : c.walk) : crouch ? c.moveSit : c.move);
    else if (crouch) t += m * c.sit;
    t += titleFxLive.firstShot; // title First_Shot_Rate (0x7e7d90)
    return Math.min(c.max, Math.max(0, t));
  }

  /**
   * WeaponBase::getCrossHairDeviationTargetTime 0x615170: ContractTime * SpeedFactor, 0 while a FastZoom weapon is on a
   * fresh zoom (0x6150c0: FastZoom && weapon+0x668).
   */
  private crossTime(def: WeaponDef): number {
    const c = def.params.spread.cross;
    return def.pb?.fastZoom && this.fastZoomFresh ? 0 : c.contractTime * c.speedFactor;
  }

  /**
   * 0x7e7d90: on a new posture target, start = current, t = 0, T = crossTime (ExpandTime when the target is above the
   * current value). 0x7e8100 per frame: t += dt; T > 2e-5 ? cur = start + (target - start) * sin(pi/2 * t/T) (0x7ecde0);
   * t > T ? cur = start = target, done.
   */
  private updateCrosshair(def: WeaponDef, speed: number, grounded: boolean, crouch: boolean, dt: number) {
    const c = def.params.spread.cross;
    const tgt = this.crosshairTarget(def, speed, grounded, crouch);
    if (tgt !== this.xhTarget) {
      this.xhDur = tgt > this.xhCur ? c.expandTime : this.crossTime(def);
      this.xhTarget = tgt;
      this.xhStart = this.xhCur;
      this.xhActive = true;
      this.xhT = 0;
    }
    if (this.xhActive) {
      this.xhT += dt;
      if (this.xhDur > 0.00002) this.xhCur = this.xhStart + (this.xhTarget - this.xhStart) * Math.sin((Math.PI / 2) * (this.xhT / this.xhDur));
      if (this.xhT > this.xhDur) {
        this.xhCur = this.xhStart = this.xhTarget;
        this.xhT = 0;
        this.xhActive = false;
      }
    }
    this.spreadNow = this.xhCur;
  }

  /**
   * per-frame recoil recovery.
   * Vertical 0x7e7f60 (R = boneCtx+0x74): v > 0 ? t += dt; T > 0 ? v = max(0, v0 + v0 * sinTab(1 + t/T)); t > T ? v = 0.
   *   sinTab(1 + u) = -sin((trunc(127(1+u)) - 128) * pi/256) ~ -sin(pi/2 * u): an ease-out drop from v0 to 0 over T.
   *   T = log10(v / Recovertime) can be <= 0 (v < Recovertime): then v is dropped on the next frame.
   * Horizontal 0x7e6a20: kick phase t < dur: (first frame: base = yaw, state 1) yaw += h * (1/dur) * dt (full dt);
   *   release (state 1 and shots == 0) -> state 2: yaw += (base - yaw) * 0.07 * Recovertime every frame, for 2 s.
   *   yaw is the absolute chara theta (get 0x60b3e0 / set 0x5070e0, disassembled 2026-10-04), not a recoil-only offset:
   *   the mouse turn made since the burst start is pulled back too. base - yaw is wrapped to ±180 (0x7e6bd2).
   */
  private updateRecoil(dt: number) {
    if (this.recV > 0) {
      this.recVt += dt;
      if (this.recVT > 0) this.recV = Math.max(0, this.recV0 + this.recV0 * pbSinTab(1 + this.recVt / this.recVT));
      if (this.recVt > this.recVT) { this.recV = 0; this.recVt = 0; }
    }
    if (this.recHt < this.recHdur) {
      if (this.hState !== 1) { this.yawBase = this.theta(); this.yawOffBase = this.yawOff; this.hState = 1; }
      this.yawOff += this.recH * (this.recHdur > 0.00002 ? 1 / this.recHdur : 0) * dt;
      this.recHt += dt;
    } else if (this.hState === 1 && this.shotCount <= 0) {
      this.hState = 2;
      this.hR = 0;
    }
    if (this.hState === 2) {
      // exe: theta += (base - theta) * 0.07 * Recovertime per frame (not dt-scaled); converted to a 60 fps equivalent
      const k = 1 - Math.pow(1 - Math.min(1, 0.07 * this.recHrecov), dt * 60);
      // [INFERIDO] the exe pulls the absolute theta (mouse turn included); in game that drags the view for 2 s after
      // every shot, so the return only brings the recoil offset back. Base and clamp stay on the absolute yaw.
      this.yawOff += (this.yawOffBase - this.yawOff) * k;
      this.hR += dt;
      if (this.hR > 2) this.hState = 0;
    }
  }

  /** chara yaw in degrees (0x60b3e0); without getYaw (smokes) the recoil offset alone stands in for it */
  private theta(): number {
    const y = this.ctx.getYaw?.();
    return y === undefined ? this.yawOff : y / DEG;
  }

  /** true while the RMB extension (zoom / scope / steady aim / dot sight) is on: the Ext_* factors apply */
  private extOn(def: WeaponDef): boolean {
    const t = def.params.ext?.type;
    if (t === "Silencer") return !!this.slots[this.cur]?.silencer;
    return this.aiming && !!t && t !== "DualMag";
  }

  /**
   * RMB on a silencer weapon (MK23, MP5K): no zoom, the extension toggles. ExtensionActivate / Deactivate (2 s) on the
   * arms and on the weapon (the silencer flies on / off); the *_Ext states (Fire_Ext, LoadMag_Ext ...) and the Ext_*
   * recoil factors apply while it is on. Like the zoom key (ProcessExtension 0xa238f0) it is ignored while a
   * load / bolt cycle runs; firing is held for the clip [INFERIDO].
   */
  private toggleSilencer(): void {
    const s = this.slots[this.cur];
    if (!s || this.reloading || this.time < this.nextFire) return;
    const on = !s.silencer;
    s.silencer = on;
    const a = this.viewmodel?.weaponAnimator;
    const key = a?.stateKey(on ? "extOn" : "extOff") ?? null;
    const dur = (key && a?.set.states[key]?.dur) || 2;
    this.viewmodel?.toggleSilencer(on, dur);
    this.nextFire = this.time + dur;
    const ev = a ? this.audio.stateSounds(a.set.ai, key) : null;
    if (ev) for (const [t, file] of ev.ev) this.later((t / ev.dur) * dur, () => this.slots[this.cur] === s && this.audio.play(file));
    else this.audio.silencerAt(s.def, on); // the pack's ExtensionActivate / Deactivate clip when the AI state has no sound event
  }

  /**
   * CGameCharaBoneContext::_ProcessFire 0x7e81c0, run by CGameCharaWeaponControl::OnFire 0xa14210 right after
   * WeaponBase::Fire (0x606a30: target + NET_Fire). The bullets (FireCollision, from the weapon's fire-state callback
   * vf12c 0x6174c0) come after, so this sees the 0-based shot index n (weapon+0xd00 is bumped at the end of
   * FireCollision, 0x6071ca) and the bullet reads the pre-shot crosshair copy b4.
   *   vertical 0x5cea50 (local chara only): kick if vc == 0 || (OneVert ? vc <= n : vc < n)
   *     v += RecoilVertAngle (x Ext_RecoilVertFactor); v > Max ? v = Max + 0.1 * rand; v0 = v;
   *     T = log10(v / RecoilVertAngle_Recovertime) (x87 fldlg2/fyl2x at 0xabd9cf); t = 0
   *   horizontal 0x5ced10: kick if OneHorz ? hc <= n : hc < n
   *     h = rand * RecoilHorzAngle (x Ext_RecoilHorzFactor); |yaw + h - base| > RecoilHorzMax ? h = -h;
   *     dur = min(FireDelay, 0.5) (weaponInfo vf210); Recovertime = vf238
   *   deviation 0x7e8400: b4 = b0; b0 += Deviation (x Ext_DeviationFactor); target = min(b0, CrossHair_Max); start = b0;
   *     T = crossTime; t = 0
   * rand = pbRandSigned. Max values get x(1 + equip bonus) in the exe (no equipment here: bonus 0).
   */
  private kick(def: WeaponDef): { kickH: number } {
    const rc = def.params.recoil, ext = def.params.ext ?? {}, on = this.extOn(def);
    const n = this.shotCount;
    const vc = on && ext.recoilVertCount !== undefined ? ext.recoilVertCount : rc.vertCount;
    if (vc === 0 || (rc.oneVert ? vc <= n : vc < n)) {
      this.recV += rc.vertAngle * (on ? ext.recoilVertFactor ?? 1 : 1);
      const vMax = rc.vertMax * fxPct(titleFxLive.reactionControl); // title Weapon_Reaction_Control
      if (this.recV > vMax) this.recV = vMax + pbRandSigned(this.rng) * 0.1;
      this.recV0 = this.recV;
      this.recVT = Math.log10(this.recV / rc.vertRecoverTime);
      this.recVt = 0;
    }
    let kickH = 0;
    const hc = on && ext.recoilHorzCount !== undefined ? ext.recoilHorzCount : rc.horzCount;
    if (rc.oneHorz ? hc <= n : hc < n) {
      let h = pbRandSigned(this.rng) * rc.horzAngle * (on ? ext.recoilHorzFactor ?? 1 : 1);
      // 0x5ced10: |theta + h - base| > Max flips h (theta = the absolute chara yaw passed by the caller)
      if (Math.abs(wrap180(this.theta() - this.yawBase) + h) > rc.horzMax * fxPct(titleFxLive.reactionControl)) h = -h;
      this.recH = kickH = h;
      this.recHt = 0;
      this.recHdur = Math.min(def.fireDelay, 0.5);
      this.recHrecov = rc.horzRecoverTime;
    }
    const c = def.params.spread.cross;
    this.xhPrev = this.xhCur;
    this.xhCur += def.params.spread.deviation * (on ? ext.deviationFactor ?? 1 : 1) * fxPct(titleFxLive.hitRate); // title Target_Declination
    this.xhStart = this.xhCur;
    this.xhTarget = Math.min(this.xhCur, c.max);
    this.xhT = 0;
    this.xhDur = this.crossTime(def);
    this.xhActive = true;
    return { kickH };
  }

  /** RMB press: toggle zoom; scope weapons step ScopeOverlay levels (0 -> 1 -> .. -> MaxScopeLevel -> 0) */
  private pressZoom(def: WeaponDef) {
    if (def.params.ext?.type === "Silencer") return this.toggleSilencer();
    // ProcessExtension 0xa238f0 ignores the zoom key during load magazine / load bullet / bolt cycle / swap (0xa23979)
    if (def.params.loadBulletTime !== undefined && this.time < this.nextFire) return;
    const on = def.params.scope ? this.scope.press() > 0 : !this.zoomOn;
    this.setZoom(on);
  }

  /**
   * chara zoom on/off. Weapon side 0x615590(on): weapon+0x668 = 0, then if the weapon was not zoomed yet (state 0x10000)
   * and weapon+0x66c > 1 s: 0x668 = 1 (the FastZoom "fresh zoom" flag); off clears state 0x10000.
   */
  private setZoom(on: boolean) {
    // WM_Scope / AssaultScope In / Out (0x823830), once per zoom open / close; stepping the scope level is not a new zoom
    const zd = this.slots[this.cur]?.def;
    if (on !== this.zoomOn && zd && !this.obs) this.audio.zoom(zd, on);
    if (on) {
      const was = this.zoomOn;
      this.fastZoomFresh = !was && this.sinceZoomShot > 1;
    } else {
      this.fastZoomFresh = false;
      this.scope.level = 0;
    }
    this.zoomOn = on;
  }

  private runPending() {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].t <= this.time) {
        const p = this.pending.splice(i, 1)[0];
        p.fn();
      }
    }
  }
  private later(delay: number, fn: () => void) {
    this.pending.push({ t: this.time + delay, fn });
  }

  private updateSwitch(dt: number) {
    if (this.switchTimer <= 0) return;
    this.switchTimer = Math.max(0, this.switchTimer - dt);
  }

  // ---- reload --------------------------------------------------------------
  private canReload(s: SlotState | null): s is SlotState {
    return !!s && !this.reloading && this.switchTimer <= 0 && s.def.family !== "KNIFE" && s.def.family !== "GRENADE" &&
      s.reserve > 0 && s.ammo < s.def.loadedBullet;
  }

  startReload(): boolean {
    const s = this.slots[this.cur];
    if (!this.canReload(s)) return false;
    this.reloading = true;
    this.fireT = -1; this.fireEnd = 0;
    this.shotCount = 0; // reload resets weapon+0xd00 (GAMEPLAY_RE_2017: FireEnd, ReturnToReady and reload)
    this.dualLeft = false; // WeaponDualHandGun reload (0x649c60) resets the hand flag: the right gun fires first
    this.burstLeft = 0;
    this.setZoom(false); // OnLoadMagazine 0xa14a30 / OnLoadMagazine_Ready: zoomed -> _Idle_Camera 0x78adc0, no re-zoom after
    const p = s.def.params;
    const rt = this.reloadTimeOf(s.def);
    this.reloadTime = rt;
    if (this.viewmodel) this.viewmodel.reloadScale = pbReloadScale(this.itemFx);
    // partial magazine: the same LoadMag state (PB has no empty/tactical variants); the missing rounds come at the end
    this.reloadDuration = p.reloadPerShell ? rt * (s.def.loadedBullet - s.ammo) + 0.3 : rt;
    this.reloadTimer = p.reloadPerShell ? rt + 0.3 : rt;
    this.emit(this.reloadL, { weapon: s.def, phase: "start", ammo: s.ammo, reserve: s.reserve, reloadTime: rt });
    // the weapon AI's own LoadMag sounds (Remove / Load / ReLoad at their state times); shells replay it per shell
    this.reloadEv = this.stateSounds("reload", rt, () => this.reloading, p.reloadPerShell ? 0.3 : 0);
    if (!this.reloadEv) {
      const clips = this.audio.reloadClips(s.def);
      const at = [0.12, 0.5, 0.78, 0.9]; // [RECRIADO] for packs without AI sound events
      if (!p.reloadPerShell) clips.forEach((c, i) => this.later(at[i] * rt, () => this.reloading && this.audio.playReload(c)));
      else this.audio.playReload(clips[0]);
    }
    return true;
  }

  private reloadEv = false;
  /**
   * Sound events of the weapon pack's i3AIState (sfx/pb2017.json, pb-extract-tools export-sfx2017.mjs) for the state the viewmodel
   * weapon runs (LoadMag1PVMale, LoadBullet1PVMale ...), stretched like the state over `time` s: event t -> t / dur * time.
   */
  private stateSounds(kind: "reload" | "loadBullet", time: number, gate: () => boolean, delay = 0): boolean {
    const a = this.viewmodel?.weaponAnimator;
    const ev = a ? this.audio.stateSounds(a.set.ai, a.stateKey(kind)) : null;
    if (!ev) return false;
    for (const [t, file] of ev.ev) this.later(delay + (t / ev.dur) * time, () => gate() && this.audio.play(file));
    return true;
  }

  private updateReload(dt: number, input: WeaponInput) {
    const s = this.slots[this.cur];
    if (!this.reloading || !s) return;
    const p = s.def.params;
    // shotgun: firing interrupts the shell-by-shell reload
    if (p.reloadPerShell && input.fire && s.ammo > 0) return this.finishReload(s, "cancel");
    this.reloadTimer -= dt;
    if (this.reloadTimer > 0) return;
    if (p.reloadPerShell) {
      s.ammo++;
      s.reserve--;
      if (!this.reloadEv) this.audio.playReload(this.audio.reloadClips(s.def)[1] ?? this.audio.reloadClips(s.def)[0]);
      this.emit(this.reloadL, { weapon: s.def, phase: "shell", ammo: s.ammo, reserve: s.reserve, reloadTime: this.reloadTime });
      if (s.ammo < s.def.loadedBullet && s.reserve > 0) {
        this.reloadTimer += this.reloadTime;
        if (this.reloadEv) this.stateSounds("reload", this.reloadTime, () => this.reloading);
        return;
      }
      return this.finishReload(s, "end");
    }
    const need = s.def.loadedBullet - s.ammo;
    const take = Math.min(need, s.reserve);
    s.ammo += take;
    s.reserve -= take;
    this.finishReload(s, "end");
  }

  private finishReload(s: SlotState, phase: "end" | "cancel") {
    this.reloading = false;
    this.reloadTimer = 0;
    this.emit(this.reloadL, { weapon: s.def, phase, ammo: s.ammo, reserve: s.reserve, reloadTime: this.reloadTime });
  }

  private cancelReload() {
    const s = this.slots[this.cur];
    if (this.reloading && s) this.finishReload(s, "cancel");
    this.pending = [];
  }

  // ---- guns ----------------------------------------------------------------
  /**
   * Fire gate. The FireDelay timer is weapon+0xdfc, run by the Fire-state callback 0x9d0910:
   *   timer += dt per frame; it may fire again once timer > delay (strict, 0x9d0b2c).
   * Full auto (AutoFireCount 0, flag 0x100) carries the remainder: timer -= delay (0x9d0bb9).
   *   Past 2·delay the timer is set to 0.032.
   *   A fresh pull resets the timer to 0 (0x61756a) and fires on the press frame (Cmd_Attack, no fire-ready wait).
   *   delay = GetFireDelay 0x616020 = FireDelay (+ skill bonus), clamped to [0.06, 3].
   *   Semi (AutoFireCount 1): weapon flag 8 blocks firing until release (0xa21e6c / FireEnd 0x606ac0).
   *   A click inside the delay is not queued: it fires when the delay ends only if still held.
   * Fire-state cycle (0x9d0910 disassembled 2026-10-04):
   *   first frame of the state (AI local time 0, 0x9d0969): vf12c (bullets) and timer += dt, no compare;
   *   later frames: timer += dt; timer − delay > delay → 0.032 (0x9d0ae4); timer > delay → vf134 0x6177c0 (weapon back
   *   to ready) and timer −= delay. Then the idle callback 0x9d0240 re-enters Fire (state 6 + flag 0x100, 0x9d0562).
   *   That idle frame adds no dt, so a held trigger fires every delay + one frame (K-2 at 60 fps ≈ 10.9/s, not 13.3).
   *   [INFERIDO] the idle state lasts exactly one frame and Cmd_Attack runs before the Fire callback of the press frame.
   * Bursts (AutoFireDelay pause) and bolt / pump LoadBulletTime keep the extra nextFire wait.
   */
  private updateGun(s: SlotState, input: WeaponInput, speed: number, grounded: boolean, dt: number) {
    if (this.reloading) return;
    const mode = s.def.fireMode;
    const delay = fxFireDelay(s.def.fireDelay); // + equipped-title Fire_Speed
    let want = false;
    if (mode === "auto") want = input.fire;
    else if (mode === "burst") {
      if (input.fire && !this.triggerLatched && this.burstLeft === 0) {
        this.burstLeft = s.def.params.burstCount ?? 3;
        this.triggerLatched = true;
      }
      want = this.burstLeft > 0;
    } else want = input.fire && !this.triggerLatched;
    if (this.fireT >= 0 && this.fireEnd === 0) {
      if (mode === "auto" && this.fireT - delay > delay) this.fireT = 0.032;
      if (this.fireT <= delay) return; // strict compare 0x9d0b2c
      this.fireT -= delay; // 0x9d0bb9: remainder carried
      this.fireEnd = 1;
      return;
    }
    if (this.fireEnd === 1) {
      if (!want) { this.fireT = -1; this.fireEnd = 0; } // Fire state over: a new press is a fresh pull
      else if (this.time >= this.nextFire) this.fireEnd = 2; // idle callback re-enters Fire, it shoots next frame
      return;
    }
    // fresh pull (Cmd_Attack, shoots on the press frame) or the Fire state re-entered on the previous frame
    if (this.fireEnd !== 2 && (!want || this.time < this.nextFire)) return;
    if (s.ammo <= 0) {
      this.burstLeft = 0;
      this.fireT = -1;
      this.fireEnd = 0;
      if (!this.dryLatched) {
        this.dryLatched = true;
        this.audio.play(this.audio.common("emptybullet"));
        if (s.reserve > 0) this.startReload();
      }
      return;
    }
    // flag 0x100 keeps the carried remainder, a fresh pull resets the timer (0x61756a); the first Fire frame adds dt
    this.fireT = (this.autoCont && this.fireEnd === 2 ? this.fireT : 0) + dt;
    this.fireEnd = 0;
    this.autoCont = mode === "auto" || (mode === "burst" && this.burstLeft > 1);
    this.triggerLatched = true;
    if (this.burstLeft > 0) this.burstLeft--;
    this.shoot(s, speed, grounded);
  }

  private shoot(s: SlotState, _speed: number, _grounded: boolean) {
    const def = s.def, p = def.params;
    const dual = dualFire(def);
    // DualHandGun: one gun per shot, right first (Fire 0x649b40, flag +0xa550), one shared magazine;
    // DualSMG: both guns every shot (Fire 0x6526b0 / NET_Fire 0x652870) -> two bullets, two rounds.
    // [INFERIDO] 2 rounds per shot: not confirmed in the exe (the local PointBlank.exe files are packed, 0x6526b0 does
    // not disassemble). pef: FireDecBulletCount 1 per Fire call, LoadBullet 60 = 2 x 30 (Dual Uzi 118004); whether
    // 0x6526b0 runs the decrement once or once per gun is open. If once: 1 round per shot, 2 bullets.
    const guns: ("R" | "L")[] = dual === "both" && s.ammo >= 2 ? ["R", "L"] : dual === "alt" ? [this.dualLeft ? "L" : "R"] : ["R"];
    if (dual === "alt") this.dualLeft = !this.dualLeft;
    s.ammo -= guns.length;
    // NeedToLoadBullet weapons (bolt / pump) cycle LoadBulletTime after the shot; bursts pause AutoFireDelay at the end
    // LoadBullet (bolt / pump) also runs at the Quick Change Reload scale (OnActionLoadBullet 0xa0d2d0)
    const cycle = p.loadBulletTime !== undefined ? Math.max(fxFireDelay(def.fireDelay), p.loadBulletTime / pbReloadScale(this.itemFx)) : fxFireDelay(def.fireDelay);
    // the FireDelay itself is the fireT gate (updateGun); nextFire only holds the bolt / pump cycle and the burst pause
    this.nextFire = def.fireMode === "burst" && this.burstLeft === 0 ? this.time + Math.max(cycle, p.burstDelay ?? 0)
      : p.loadBulletTime !== undefined ? this.time + cycle : 0;
    this.lastShot = this.time;

    // the aim bone gets the full R.v, the camera only R.v * CamSyncRate (0x7e743c vs 0x7e5670). The target is taken
    // in Fire() before _ProcessFire, so this shot's own kick is not in its bullet.
    const { origin, dir: fwd } = this.aimRay();
    // FastZoom on a fresh zoom: FireCollision uses 0 deviation (0x606cc6); NET_Fire clears the flag (0x612e96) before the
    // bullets, so for the local shot this only matters through crossTime (instant crosshair while freshly zoomed)
    if (this.zoomOn) this.sinceZoomShot = 0; // NET_Fire 0x612e8b: 0x66c = 0 while zoomed (state 0x10000)
    this.fastZoomFresh = false;
    const yawAtShot = this.yawOff;
    const { kickH } = this.kick(def); // _ProcessFire: recoil + deviation (b4 = pre-shot crosshair)
    const dev = this.xhPrev;
    const pellets = Math.max(1, p.pellets ?? 1);
    this.effects.setWeapon(def.id, def.family);
    const vm = this.viewmodel && !this.scoped ? this.viewmodel : null;
    if (vm) vm.side = guns[guns.length - 1] === "L" && vm.dual ? "L" : "R";
    // tracer / flash origin = the 1PV weapon's FXDummy (AddBulletTrace 0x60f100 -> vf+0x190 0x60f0a0 -> 0x6154e0; zoomed
    // AK-SOPMOD: + Ext_PosFireEffectOffset). [INFERIDO] scoped: the viewmodel is hidden here, so eye + 0.5 m stands in
    const muzzleOf = (g: "R" | "L") => {
      if (!vm) return origin.clone().addScaledVector(fwd, 0.5);
      vm.side = g === "L" && vm.dual ? "L" : "R";
      return vm.muzzleWorld();
    };
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    let off = { pitch: 0, yaw: 0 };
    const muzzles = guns.map(muzzleOf);
    for (const muzzle of muzzles) for (let i = 0; i < pellets; i++) {
      off = pbShotOffsets(dev, this.rng);
      const dir = fwd.clone().applyAxisAngle(right, off.pitch * DEG).applyAxisAngle(up, off.yaw * DEG).normalize();
      const end = this.traceBullet(def, origin, dir);
      // every pellet: the FireCollision loop (0x606e77..0x60719e) runs DoLineCollision 0x60f700 -> AddBulletTrace per bullet
      this.effects.tracer(muzzle, end);
    }
    this.shotCount++; // weapon+0xd00 += 1 after the pellets (0x6071a3)
    this.trace?.push({ t: this.time, n: this.shotCount - 1, dev, offPitch: off.pitch, offYaw: off.yaw, recV: this.recV, kickH,
      yaw: yawAtShot, cross: this.xhCur });
    this.recoilPitch = this.recV * p.recoil.camSyncRate;
    this.syncCamera();

    if (vm) {
      const kick = def.family === "SR" || def.family === "SG" ? 6 : def.family === "HG" ? 3.5 : 2.2;
      vm.fireKick(kick, guns.length === 2 ? "both" : guns[0] === "L");
      guns.forEach((g, i) => {
        vm.side = g === "L" && vm.dual ? "L" : "R";
        this.effects.muzzleFlash(vm.muzzleNode, muzzles[i], def.family === "SG" || def.family === "SR" ? 1.5 : 1, undefined, this.ownMuzzleTint());
        if (def.fireMode !== "pump" && def.fireMode !== "bolt") this.ejectShell();
      });
    }
    // bolt rifles chamber the next round (LoadBullet state, arms + bolt) whenever a round is left, scoped or not
    if (p.loadBulletTime !== undefined && s.ammo > 0) {
      this.viewmodel?.loadBullet();
      this.stateSounds("loadBullet", p.loadBulletTime / pbReloadScale(this.itemFx), () => this.slots[this.cur] === s); // ReLoadC
    }
    if (def.fireMode === "pump" || def.fireMode === "bolt") this.later(0.45, () => this.ejectShell());
    if (def.fireMode === "bolt" && this.scoped) this.boltUntil = this.time + cycle;
    // NeedToLoadBullet guns chamber after the shot: _OnProcessFireEndAnim 0x6177c0 -> state 7 -> OnLoadBullet 0xa14ef0
    // drops zoom (_Idle_Camera); it does not come back by itself
    if (p.loadBulletTime !== undefined && s.ammo > 0) this.setZoom(false);
    // silencer on = _Muffler clip, zoom open = Zoom_Fire clip (WeaponAudio.fireClip)
    this.audio.fire(def, { silencer: def.params.ext?.type === "Silencer" && !!s.silencer, zoom: this.zoomOn });
    this.emit(this.fireL, { weapon: def, slot: this.cur, kind: "bullet", origin, direction: fwd, ammo: s.ammo, reserve: s.reserve });
  }

  private ejectShell() {
    if (!this.viewmodel) return;
    const cam = this.ctx.camera;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    this.effects.shell(this.viewmodel.ejectWorld(), right, new THREE.Vector3(0, 1, 0), this.viewmodel.ejectNode);
    // _OnProcessFireEndAnim 0x617bb0 -> 0x610200: one WM_Bullet_<terrain> 0.7 s after the shot (no random roll; G11 / Jackhammer
    // excluded); WeaponBase::OnUpdate 0x6103c0 plays it when the timer runs out. Terrain = the surface under the shooter, read at
    // the shot (the exe reads the owner's +0x200) [INFERIDO]. Bolt / pump: the delay counts from the eject call [INFERIDO]
    const def = this.slots[this.cur]?.def;
    if (!def || /g11|jackhammer/i.test(def.name)) return;
    const down = this.castNormal(cam.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(0, -1, 0), 3);
    const terrain = soundTerrainOf(down?.collider.handle);
    this.later(0.7, () => this.audio.casing(terrain));
  }

  private own(): RAPIER.Collider | undefined {
    const o = this.ctx.ownCollider;
    return typeof o === "function" ? o() : o;
  }

  private castNormal(origin: THREE.Vector3, dir: THREE.Vector3, len: number, pred?: (c: RAPIER.Collider) => boolean) {
    const R = this.ctx.RAPIER;
    const ray = new R.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z });
    const pr = (c: RAPIER.Collider) => !this.grenades.isGrenade(c) && (!pred || pred(c));
    return this.ctx.world.castRayAndGetNormal(ray, len, true, undefined, this.ctx.filterGroups, this.own(), undefined, pr);
  }

  /**
   * Nearest non-character collider on the ray (grenades skipped); `dist` is from `origin`. `leaving` = the wall the ray
   * just went through: its other face (the same collider hit on the other triangle side, effects.ts hitSide) is passed,
   * as PhysX 2.8's one-sided casts meet only one face of a closed thin wall.
   */
  private castWorld(origin: THREE.Vector3, dir: THREE.Vector3, len: number, leaving?: RAPIER.RayColliderIntersection) {
    const o = origin.clone();
    const out = leaving && hitSide(leaving.collider.handle, leaving.featureId);
    let done = 0;
    for (let k = 0; k < 8 && len - done > 0; k++) {
      const hit = this.castNormal(o, dir, len - done, (c) => !this.ctx.resolveTarget(c));
      if (!hit) return null;
      const side = out && hitShapeId(hit.collider.handle, hit.featureId) === hitShapeId(leaving!.collider.handle, leaving!.featureId) ? hitSide(hit.collider.handle, hit.featureId) : null;
      if (!side || side === out) {
        const dist = done + hit.timeOfImpact;
        return { hit, dist, point: origin.clone().addScaledVector(dir, dist) };
      }
      const step = hit.timeOfImpact + 0.002;
      o.addScaledVector(dir, step);
      done += step;
    }
    return null;
  }

  /** character hitboxes on the ray nearer than `len`, nearest first, one per character (`all` = every one, else the first) */
  private castChars(origin: THREE.Vector3, dir: THREE.Vector3, len: number, all: boolean) {
    const out: { target: HitTarget; collider: RAPIER.Collider; dist: number; normal: THREE.Vector3 }[] = [];
    if (len <= 0) return out;
    const seen = new Set<unknown>();
    const o = origin.clone();
    let done = 0;
    for (let k = 0; k < 16 && len - done > 0; k++) {
      const hit = this.castNormal(o, dir, len - done, (c) => {
        const t = this.ctx.resolveTarget(c);
        return !!t && !seen.has(t.id ?? t);
      });
      if (!hit) break;
      const target = this.ctx.resolveTarget(hit.collider)!;
      const dist = done + hit.timeOfImpact;
      seen.add(target.id ?? target);
      out.push({ target, collider: hit.collider, dist, normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z) });
      if (!all) break;
      o.copy(origin).addScaledVector(dir, dist);
      done = dist;
    }
    return out;
  }

  /** 0x60abb0 -> 0x60a950: does this bullet go through the wall it hit at `dist` (maxDist = the walk's range)? */
  private wallPasses(def: WeaponDef, collider: RAPIER.Collider, dist: number, maxDist: number): boolean {
    if (classSkipsWallTest(def.classType)) return false;
    // props and colliders without a surfaces.json terrain entry count as solid [INFERIDO: the props' own terrain is not exported]
    const t = terrainOfCollider(collider.handle);
    if (!t) return false;
    // GetWeaponPenetrate(false) 0x618080 = HelmetPenetrate + the equip bonus (the bullet coupon stands in for it [INFERIDO])
    const pen = (def.params.helmetPenetrate ?? def.helmetPenetrate / 100) + (this.itemFx.bulletPenetrateUp ?? 0);
    return wallPenetrates(t, dist, maxDist, pen, def.params.bulletWeight, Math.floor(Math.random() * 100));
  }

  /** a thin breakable pane the bullet went through still takes the hit (_OnHit on the walk's entry record, 0x60a14b) */
  private hurtCrossedProp(def: WeaponDef, w: { hit: RAPIER.RayColliderIntersection; dist: number; point: THREE.Vector3 }): void {
    if (w.dist <= def.range) this.ctx.damageProp?.(w.hit.collider, this.bulletDamage(def, "body", w.dist, false), w.point);
  }

  /** a bullet's wall impact: Hit_/Hmk_<cat>_<surface> + WM_Hit_<terrain>, and the world hit event inside the range */
  private wallImpact(def: WeaponDef, origin: THREE.Vector3, dir: THREE.Vector3, w: { hit: RAPIER.RayColliderIntersection; dist: number; point: THREE.Vector3 },
    penetrated: number): void {
    const n = new THREE.Vector3(w.hit.normal.x, w.hit.normal.y, w.hit.normal.z);
    // Hit_/Hmk_<cat>_<surface>: surface of the map shape hit (surfaces.json), "Cm" for props
    const surf = surfaceOfCollider(w.hit.collider.handle);
    this.effects.impact(w.point, n, true, surf, dir);
    this.audio.hitAt(soundTerrainOf(w.hit.collider.handle), w.point); // WM_Hit_<terrain>_1/2, one per terrain a frame (ReserveSoundPlay 0x699d70)
    if (w.dist <= def.range && this.hitL.length)
      this.emit(this.hitL, { weapon: def, kind: "bullet", target: null, collider: w.hit.collider, point: w.point.clone(), normal: n,
        distance: w.dist, zone: null, headshot: false, damage: 0, penetrated, origin: origin.clone() });
  }

  /**
   * One bullet, exe-2017 WeaponBase::DoLineCollision 0x60f700 -> 0x609a30 (penetration.ts): the world walk 0x6094f0 sets how
   * far characters can be hit, then the characters, then the wall impacts when no character was hit. Returns the tracer end.
   */
  private traceBullet(def: WeaponDef, origin: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 {
    const shot = ++this.shotSeq;
    // the walk's range: GetRange vf+0x218 (pef Range); a hit past the XML range is dropped (the server rejects it)
    const range = (def.params.range > 0 ? def.params.range : def.range) + titleFxLive.range; // title Fire_Range
    const sniper = def.classType === 5; // 0x609d90: class 5 hits every character on the line, the others the nearest
    let o = origin.clone();
    let travelled = 0;
    for (let seg = 0; seg < 6; seg++) {
      // ---- world walk 0x6094f0 ----
      const w1 = this.castWorld(o, dir, MAX_TRACE - travelled);
      const h1 = w1 && { ...w1, dist: travelled + w1.dist };
      let maxDist = range;
      let wall: { dist: number; thickness: number } | null = null;
      let h2: (typeof h1) = null;
      let h2Stops = false;
      if (h1 && h1.dist <= maxDist) {
        if (this.wallPasses(def, h1.hit.collider, h1.dist, maxDist)) {
          // the next wall, cast from h1 + dir * 0.01: it stops the bullet only inside half the range left (0x6097b4)
          wall = { dist: h1.dist, thickness: wallDamageThickness(terrainOfCollider(h1.hit.collider.handle)!.thickness) };
          const from = h1.point.clone().addScaledVector(dir, WALL_STEP);
          const w2 = this.castWorld(from, dir, Math.max(0, MAX_TRACE - h1.dist - WALL_STEP), h1.hit);
          if (w2) {
            h2 = { ...w2, dist: h1.dist + WALL_STEP + w2.dist };
            h2Stops = secondWallStops(maxDist, h1.dist, w2.dist);
            if (h2Stops) maxDist = h1.dist + w2.dist;
          }
        } else maxDist = h1.dist; // stopped in the wall
      }
      // ---- characters 0x609a30: nearer than maxDist ----
      const chars = this.castChars(o, dir, Math.min(maxDist, def.range) - travelled, sniper);
      if (chars.length) {
        if (wall && h1) { // the penetrated wall's entry (0x60a14b, walk result 4)
          this.hurtCrossedProp(def, h1);
          this.wallImpact(def, origin, dir, h1, 0);
        }
        let end = o;
        for (const c of chars) {
          const dist = travelled + c.dist;
          const p = o.clone().addScaledVector(dir, c.dist);
          const zone = c.target.hitzone;
          // behind the penetrated wall: info.f10 = its thickness (_CalcHitChara 0x60c904)
          const behind = wall !== null && dist > wall.dist;
          const dmg = this.bulletDamage(def, zone, dist, !!c.target.hasHelmet, def.params.damage, behind ? wall!.thickness : 0, helmetRate(c.target));
          // ExpHu01_1 sprays back at the shooter (emitDir +Y = local axis); worldShot uses -dir too
          this.effects.blood(p, dir);
          this.audio.hitAt("Human", p); // WM_Hit_Human_1..3 (Sound_Weapon_Common)
          this.emit(this.hitL, { weapon: def, kind: "bullet", target: c.target, collider: c.collider, point: p, normal: c.normal,
            distance: dist, zone, headshot: zone === "head", damage: Math.round(dmg), penetrated: behind ? 1 : 0, origin: origin.clone(), shot });
          end = p;
        }
        return end;
      }
      // ---- no character: the bullet ends in a wall or in the air ----
      if (!h1) return o.addScaledVector(dir, MAX_TRACE - travelled);
      // breakable map object (glass, crate, vending machine...): the bullet hurts it with the weapon damage [INFERIDO: same
      // rule as the host, life -= Damage]; one that just broke lets the bullet through
      if (!wall && h1.dist <= def.range && this.ctx.damageProp?.(h1.hit.collider, this.bulletDamage(def, "body", h1.dist, false), h1.point)) {
        travelled = h1.dist + WALL_STEP;
        o = h1.point.clone().addScaledVector(dir, WALL_STEP);
        continue;
      }
      // 0x60a050: the wall that stopped the bullet (+0xe40.. only with the stop flag +0xe3c), then the penetrated wall's
      // entry (walk result 4); the trace (AddBulletTrace 0x60f100) ends on the first of them. _OnHit on a map object
      // hurts it (_CalcHitObject), a penetrated pane too
      if (h2 && h2Stops) {
        if (h2.dist <= def.range) this.ctx.damageProp?.(h2.hit.collider, this.bulletDamage(def, "body", h2.dist, false), h2.point);
        this.wallImpact(def, origin, dir, h2, 1);
      }
      if (wall) this.hurtCrossedProp(def, h1);
      this.wallImpact(def, origin, dir, h1, 0);
      return h2 && h2Stops ? h2.point : h1.point;
    }
    return o;
  }

  /** Character.pef DamageRate for a zone (weapons.json hitzone = SWAT_Male). */
  zoneMultiplier(zone: HitZone): number {
    const h = this.db.hitzone;
    switch (zone) {
      case "head": return h.head;
      case "arm": case "limb": return h.arm;
      case "leg": return h.leg;
      default: return h.body;
    }
  }

  /**
   * pef Damage x part rate x DPD falloff over the pef Range (0x540690) x helmet roll (0x5425e0), rounded like CalcDamage
   * (0x5448d0). Hits beyond the XML range are dropped by traceBullet (the server rejects them). `wallThickness` = info.f10
   * of a bullet that went through a wall (0x60c904).
   */
  bulletDamage(def: WeaponDef, zone: HitZone, dist: number, helmet: boolean, base = def.params.damage, wallThickness = 0, helmetDefense?: number): number {
    // bullet coupons (Hollow Point / Plus / Jack / Full Metal Jack, loadout.ts BATTLE_COUPONS [INFERIDO values])
    const up = this.itemFx.bulletDamageUp ?? 0, pen = this.itemFx.bulletPenetrateUp ?? 0;
    return pbHitDamage({
      base: base * (1 + up), zone, distance: dist, range: def.params.range > 0 ? def.params.range + titleFxLive.range : def.params.range, dpdRate: def.params.dpdRate, dpdBonus: 0.01 * titleFxLive.dpd, helmet,
      helmetPenetrate01: Math.min(1, (def.params.helmetPenetrate ?? def.helmetPenetrate / 100) + pen),
      wallThickness, // part rates: PB_CHARA.damageRate (2017 SWAT_Male); weapons.json hitzone is the Cross SWAT_Male table
      helmetDefense, // the target's head item rate (actorEquip.ts); undefined = damage.ts default

    }).damage;
  }

  // ---- melee ---------------------------------------------------------------
  private updateMelee(s: SlotState, input: WeaponInput) {
    if (!input.fire && !input.aim) this.meleeLatched = false;
    const ballistic = isBallisticKnife(s.def);
    if (this.time < this.nextFire) return;
    const heavy = input.aim && !input.fire;
    if (!input.fire && !input.aim) return;
    const m = s.def.params.melee;
    // one swing per press, like every AutoFireCount >= 1 weapon (semi gate 0xa21e6c); holding the button re-swung every
    // FireDelay and cut the clip each time (Fang Blade: 0.55 s of a 1.13 s Attack_A). DualKnife: one swing = two hits [INFERIDO for melee]
    if (this.meleeLatched && (m?.timeA2 || (s.def.pb?.autoFireCount ?? 1) > 0)) return;
    this.meleeLatched = true;
    if (ballistic && heavy) {
      if (s.ammo <= 0) return this.dropBallistic(s); // emptied while another slot was in hand
      s.ammo--;
    }
    // LMB: FireDelay / AttackTimeA1, RMB: FireDelay2 / AttackTimeB1 (Weapon.pef)
    let interval = heavy ? m?.delayB ?? s.def.fireDelay : s.def.fireDelay;
    // the next swing cannot start before this one's hit lands: Knuckle FireDelay 0.1 / A1 0.2, Candy Cane 0.2 / 0.28,
    // Icicles 0.25 / 0.366, Kunai 0.05 / 0.3 would restart (and cut) the clip before its own hit [INFERIDO]
    interval = Math.max(interval, (heavy ? m?.timeB : m?.timeA) ?? 0);
    // DualKnife: both blades hit inside one swing (A1 + A2 / B1 + B2), so it cannot restart before its last hit
    // (Kunai FireDelay 0.05 alone gave 1200 stabs/min on a 1.5 s clip) [INFERIDO: the exe's swing lock is not decoded]
    const t2 = heavy ? m?.timeB2 : m?.timeA2;
    if (t2) interval = Math.max(interval, t2);
    if (ballistic && heavy) interval = Math.max(interval, this.viewmodel?.weaponAnimator?.set.states.SecondaryFire?.dur ?? 0); // [INFERIDO] the blade fires again when its SecondaryFire state ends
    this.nextFire = this.time + interval;
    if (ballistic && heavy && s.ammo <= 0) this.later(interval, () => this.dropBallistic(s)); // the last blade is gone
    this.viewmodel?.meleeSwing(heavy, t2 ? 0 : interval, !!t2);
    this.audio.swing(s.def, heavy);
    const cam = this.ctx.camera;
    this.emit(this.fireL, { weapon: s.def, slot: this.cur, kind: "melee", origin: cam.getWorldPosition(new THREE.Vector3()),
      direction: cam.getWorldDirection(new THREE.Vector3()), ammo: ballistic ? s.ammo : 0, reserve: ballistic ? s.reserve : 0, heavy });
    this.later(heavy ? m?.timeB ?? 0 : m?.timeA ?? 0.1, () => this.meleeHit(s.def, heavy));
    if (t2) this.later(t2, () => this.meleeHit(s.def, heavy, true));
  }

  /** Ballistic Knife out of blades: its slot becomes the default knife (M-7), drawn at once when it is in hand */
  private dropBallistic(s: SlotState): void {
    const idx = this.slots.indexOf(s);
    const def = this.db.def(this.db.defaultLoadout.melee);
    if (idx < 0 || !def || def.id === s.def.id) return;
    this.slots[idx] = this.fresh(def, idx);
    this.audio.preload(def);
    if (idx !== this.cur) return;
    this.cancelReload();
    this.startChange(def);
    this.viewmodel?.setWeapon(def);
    this.audio.play(this.audio.swap(def));
    this.emit(this.switchL, { from: s.def, to: def, slot: this.cur });
  }

  /** Kunai thrown blades: flying to the hit point, then stuck in the wall for a while */
  private kunai: { g: THREE.Group; from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number; stick: boolean; life: number }[] = [];

  /**
   * Kunai RMB (Dual_Kunai Extension1 Type, ext item 301107 Range 70): SecondaryAttack throws one blade per
   * hand, B1 (right, 0.6 s) and B2 (left, 0.9 s), each AttackDamageB1 / B2 (105). The blade leaves the hand and stays
   * stuck where it lands. [INFERIDO: speed, stick time and the hand offset are not decoded]
   */
  private throwKunai(def: WeaponDef, second: boolean): void {
    const cam = this.ctx.camera, m = def.params.melee;
    const origin = cam.getWorldPosition(new THREE.Vector3());
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const side = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(second ? -0.15 : 0.15);
    const hand = origin.clone().add(side).addScaledVector(fwd, 0.35).add(new THREE.Vector3(0, -0.12, 0));
    const ballistic = isBallisticKnife(def);
    if (!ballistic) this.viewmodel?.hideBlade(second, Math.max(0.2, 1.27 - ((second ? m?.timeB2 : m?.timeB) ?? 0.6))); // until the 1.267 s Attack_B ends
    const hit = this.castNormal(origin, fwd, KUNAI_RANGE);
    const target = hit ? this.ctx.resolveTarget(hit.collider) : null;
    const end = origin.clone().addScaledVector(fwd, hit ? hit.timeOfImpact : KUNAI_RANGE);
    if (hit && target) {
      const dmg = this.bulletDamage(def, target.hitzone, 0, !!target.hasHelmet, (second ? m?.damageB2 : undefined) ?? m?.damageB ?? def.params.damage, 0, helmetRate(target));
      this.effects.setWeapon(def.id, def.family);
      this.effects.blood(end, fwd);
      this.audio.knifeHit(target.hitzone === "head" ? "Head" : "Human", end);
      this.emit(this.hitL, { weapon: def, kind: "melee", target, collider: hit.collider, point: end, normal: fwd.clone().negate(),
        distance: hit.timeOfImpact, zone: target.hitzone, headshot: target.hitzone === "head", damage: Math.round(dmg), penetrated: 0, origin });
    } else if (hit) {
      const surf = surfaceOfCollider(hit.collider.handle);
      this.effects.setWeapon(def.id, def.family);
      this.effects.impact(end, new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z), true, surf, fwd);
      this.audio.knifeHit(soundTerrainOf(hit.collider.handle), end);
    }
    const g = new THREE.Group();
    g.position.copy(hand);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), end.clone().sub(hand).normalize());
    this.ctx.scene.add(g);
    void createWeaponModel(def.id, "KNIFE").then((inst) => {
      if (!inst || !g.parent) return;
      const ax = new THREE.Group();
      ax.matrixAutoUpdate = false;
      ax.matrix.copy(inst.axis);
      ax.add(inst.object);
      // Ballistic Knife: only the blade (Model_Knife) flies, not the handle and button
      if (ballistic) ax.traverse((o) => {
        if (!(o as THREE.Mesh).isMesh) return;
        for (let p: THREE.Object3D | null = o; p && p !== ax; p = p.parent) if (p.name === "Model_Knife") return;
        o.visible = false;
      });
      g.add(ax); // i3 space under AxisRotate: the blade tip points along +Z
    });
    const to = end.clone().addScaledVector(fwd, -KUNAI_TIP + KUNAI_STICK_DEPTH); // tip a little inside the surface
    const dur = Math.max(0.03, hand.distanceTo(to) / KUNAI_SPEED);
    this.kunai.push({ g, from: hand, to, t: 0, dur, stick: !!hit && !target, life: KUNAI_STUCK_LIFE });
  }

  private updateKunai(dt: number): void {
    for (const k of this.kunai) {
      if (k.t < k.dur) {
        k.t = Math.min(k.dur, k.t + dt);
        k.g.position.lerpVectors(k.from, k.to, k.t / k.dur);
      } else k.life -= dt;
      if (k.t >= k.dur && !k.stick) k.life = 0; // hit a character: the blade is gone
    }
    for (const k of this.kunai) if (k.life <= 0) k.g.removeFromParent();
    this.kunai = this.kunai.filter((k) => k.life > 0);
  }

  /** a melee button is held since the last swing (DualKnife needs a fresh press) */
  private meleeLatched = false;

  private meleeHit(def: WeaponDef, heavy: boolean, second = false) {
    if (heavy && (isBallisticKnife(def) || (def.className === "DualKnife" && def.pb?.extType === "Throw"))) return this.throwKunai(def, second);
    const cam = this.ctx.camera, m = def.params.melee;
    const origin = cam.getWorldPosition(new THREE.Vector3());
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    // a Throw / Ballistic / bow extension item carries the projectile range (70 m): a stab reaches like the blades (<= 3 m)
    const range = Math.min(def.range, MELEE_REACH_MAX);
    // WeaponKnife::FireCollision 0x634bd0 -> DoFireCollision 0x634f70: ONE i3CollideeLine from the start point to the shot target
    // (vf 0x18c GetShotTargetPos 0x6092c0 = camera - At * Range: the crosshair ray), tested like a bullet line (WeaponBase 0x607840:
    // nearest world / character hit, the part is the hit shape's). No fan of rays, so aiming at the chest hits the chest.
    // The exe's start is the midpoint of two character points (0x634cf4, x 0.5); the camera position stands for it [INFERIDO].
    const hit = this.castNormal(origin, fwd, range);
    if (!hit) return;
    const best = { hit, target: this.ctx.resolveTarget(hit.collider), dir: fwd };
    // the knife's own terrain category (HIT_CAT KNIFE -> Hit_M9_* / Hmk_M9_*): effects keep the family of the last shot
    // fired (setWeapon only ran in fireGun), so a stab after the pistol drew the bullet blow + bullet hole
    this.effects.setWeapon(def.id, def.family);
    const pt = origin.clone().addScaledVector(best.dir, best.hit.timeOfImpact);
    const n = new THREE.Vector3(best.hit.normal.x, best.hit.normal.y, best.hit.normal.z);
    if (best.target) {
      const zone = best.target.hitzone;
      // AttackDamageA1 (LMB) / AttackDamageB1 (RMB) x part rate, helmet roll; no distance falloff (no DPD_Rate).
      // NOTE: with AntiScript on, the server rejects melee RawDamage > XML Damage (M-7: B1 90 > 60).
      const base = (heavy ? (second ? m?.damageB2 : undefined) ?? m?.damageB : (second ? m?.damageA2 : undefined) ?? m?.damageA)
        ?? def.params.damage;
      const dmg = this.bulletDamage(def, zone, 0, !!best.target.hasHelmet, base, 0, helmetRate(best.target));
      this.effects.blood(pt, best.dir);
      this.audio.knifeHit(zone === "head" ? "Head" : "Human", pt);
      this.emit(this.hitL, { weapon: def, kind: "melee", target: best.target, collider: best.hit.collider, point: pt, normal: n,
        distance: best.hit.timeOfImpact, zone, headshot: zone === "head", damage: Math.round(dmg), penetrated: 0, origin });
    } else {
      // breakable map object (glass, crate, vending machine...): a stab hurts it with the blow's damage [INFERIDO: same rule as bullets]
      const base = (heavy ? (second ? m?.damageB2 : undefined) ?? m?.damageB : (second ? m?.damageA2 : undefined) ?? m?.damageA) ?? def.params.damage;
      this.ctx.damageProp?.(best.hit.collider, this.bulletDamage(def, "body", 0, false, base), pt);
      if (second) return; // the 2nd blade hits the same wall / ground: no second mark or sound
      const surf = surfaceOfCollider(best.hit.collider.handle);
      this.effects.impact(pt, n, true, surf, best.dir);
      this.audio.knifeHit(soundTerrainOf(best.hit.collider.handle), pt); // WM_Knife_Hit_<terrain>, not the bullet ricochet set
    }
  }

  /**
   * WeaponMedicalKit::OnUpdate 0x6689e0 + heal check vf 0x2ec (0x66acd0): while the kit lives (in flight too) it looks for a character
   * to heal. A character qualifies when hurt (HP != max, 0x66ac60) and the kit is within Explosion_Range of its origin (3D, 0x66ae15)
   * or within it horizontally with the kit between the character's feet and bone 7 (0x66adab; head used for bone 7 [INFERIDO]).
   * The first one gets Damage HP at once (a hit of type 10 = CharaDeath.MEDICAL_KIT: matchCore adds the damage to the victim's life),
   * the kit is then destroyed (0x668dd6 -> vf 0x228). Not a tick over Explosion_Time: that is how long the kit lies there.
   * The owner is skipped for the first 0.5 s. Only the local character is checked: healing other players needs a MEDICAL_KIT hit
   * over the P2P hit stream [INFERIDO: the team filter of the hit (0x543890) is not decoded either].
   */
  private updateHeal(): void {
    if (!this.kits.size || !this.healBody) return;
    let body: { feet: THREE.Vector3; headY: number } | null | undefined;
    for (const [g, k] of this.kits) {
      if (!g.local || g.fuse <= 0 || this.time - k.born < KIT_OWNER_DELAY) continue;
      body ??= this.healBody();
      if (!body) return;
      const p = g.mesh.position;
      const dx = body.feet.x - p.x, dz = body.feet.z - p.z, dy = body.feet.y - p.y;
      const reach = g.weapon.params.explosionRadius ?? 0.85;
      const inReach = Math.hypot(dx, dy, dz) < reach || (Math.hypot(dx, dz) < reach && p.y >= body.feet.y && p.y <= body.headY);
      if (!inReach) continue;
      this.onHeal?.(g.weapon.pb?.damage ?? g.weapon.damage);
      g.fuse = 0; // destroyed: GrenadePhysics.update runs explode() (aura off, "explode" record to the others)
      return;
    }
  }

  /** the kit came to rest (landing branch 0x669540): its pef _FireEffect plays and the sound row 1 idx 0x10 = the pack's WM_MedicKit_Recovery */
  private kitLanded(g: LiveGrenade, pos: THREE.Vector3): void {
    const def = g.weapon;
    const kitFx = (weaponFxInfo(def.id) ?? weaponFxInfo(throwableBaseId(def.id)))?.fire; // pef _FireEffect: buff / Chocolate_Kit
    const up = new THREE.Vector3(0, 1, 0);
    if (kitFx) this.effects.play(kitFx, pos, up);
    // the sound is the effect's own node (buff.i3s: WM_MedicKit_Recovery; Chocolate_Kit.i3s has none), heard from every kit
    if (kitFx !== "Chocolate_Kit") this.audio.medicRecovery(pos);
    const k = this.kits.get(g);
    if (k && !k.aura) k.aura = this.effects.play(MEDIC_FX, pos, up);
  }

  // ---- grenade -------------------------------------------------------------
  private updateGrenade(s: SlotState, input: WeaponInput, dt: number) {
    if (this.throwTimer >= 0) {
      this.throwTimer += dt;
      if (this.viewmodel) this.viewmodel.throwT = Math.min(1, this.throwTimer / this.throwTotal);
      if (this.throwTimer >= this.throwTotal) {
        this.throwTimer = -1;
        if (this.viewmodel) this.viewmodel.throwT = -1;
        if (!this.usable(s)) this.switchTo(this.slots[this.prev] ? this.prev : 0);
      }
      return;
    }
    const kind = throwKind(s.def);
    // C5: the hand always holds the bomb trigger (WeaponBombTrigger::OnFire 0x642340). LMB presses it (every planted C5 of the
    // owner goes off), RMB throws a C5 at the aim point (the brick's own Attack_A, no pin / hold) [pairing of the buttons: in-game behaviour]
    if (kind === "c5") {
      const aimPress = input.aim && !this.c5AimLatched;
      this.c5AimLatched = input.aim;
      if (s.ammo <= 0 && !this.planted.length) {
        // every C5 gone off: the empty slot gives way
        if (this.time >= this.nextFire) this.switchTo(this.slots[this.prev] && this.prev !== this.cur ? this.prev : 0);
        return;
      }
      if (this.time < this.nextFire) return;
      if (aimPress && s.ammo > 0) { this.startThrow(s, kind); return; }
      if (!input.fire || this.triggerLatched || !this.planted.length) return;
      this.triggerLatched = true;
      this.nextFire = this.time + s.def.fireDelay;
      this.audio.fire(s.def); // _FireSound WM_C5_Press
      this.viewmodel?.pressTrigger();
      this.later(C5_TRIGGER_DELAY, () => this.detonateC5());
      return;
    }
    // pin out: hold while the button is down, throw on the release (0xa221ab)
    if (this.throwReady) {
      if (input.fire) return;
      this.throwReady = false;
      if (this.viewmodel) this.viewmodel.throwReady = false;
      if (s.ammo > 0) this.startThrow(s, kind);
      return;
    }
    if (!input.fire || this.triggerLatched || s.ammo <= 0 || this.time < this.nextFire) return;
    this.triggerLatched = true;
    // every throwable is exe WEAPON_CLASS 7 (2017 Weapon.pef _ClassType 7: K-400, K-413, C5, FlashBang, SmokeGrenade,
    // WP smoke...; the server ItemClass 8 / 27 of weapons.json classType is NOT the exe class): the press only readies
    // Medical_Kit: no pin, the press plays Install and places the kit (no Throw_Hold sound)
    // Claymore (WeaponClaymore, NoReadySound 1): no pin either, the press plays Install and sets it down
    if (kind !== null && kind !== "heal" && kind !== "mine") {
      this.throwReady = true;
      if (this.viewmodel) this.viewmodel.throwReady = true;
      if (!noReadySound(s.def.id)) this.audio.play(this.audio.throwPin()); // pin out
      return;
    }
    this.startThrow(s, kind);
  }

  /** Cmd_Attack -> Fire: the Throwing AI's Attack (AttackC) state, the grenade(s) leave at the release time(s) */
  private startThrow(s: SlotState, kind: ThrowKind | null): void {
    this.throwTimer = 0;
    this.nextFire = this.time + s.def.fireDelay;
    const dual = isDualGrenade(s.def.id);
    // the Attack (AttackC) state runs to its end before the weapon is ready again (slot 0x210): K-400 1 s, K-413 1.667 s
    this.throwTotal = this.viewmodel?.throwDuration(kind === "c5") ?? (dual ? 1.6667 : 1);
    if (this.viewmodel) this.viewmodel.throwTotal = this.throwTotal;
    // weapon.pef _FireSound (K-400: WM_Throw_Fire) on Fire; the Medical_Kit pef has none (the grenade pack played a bomb throw)
    if (kind !== "heal") this.audio.fire(s.def);
    // release (0x62e8d0 -> 0x631330): fire-anim t > AttackTimeA1 - 0.05 (K-400 0.1 -> 0.05 s); WeaponDualGrenade
    // (0x632370) throws the right grenade at t > 0.4 and the left one at t > 1.233, one press, both rounds
    const rel = dual ? [...DUAL_GRENADE_TIMES] : [Math.max(0, (s.def.params.throwDelay ?? 0.1) - 0.05)];
    const spawn = (): void => {
      if (s.ammo <= 0) return;
      const p = s.def.params;
      const { origin, dir } = this.throwRay();
      const vel = dir.clone().multiplyScalar((p.throwSpeed ?? 18.5) + titleFxLive.throwSpeed); // title Throw_Speed
      s.ammo--;
      // C5: no fuse until the trigger (flag 8), sticks where it lands (AttachableItem)
      const g = this.spawnGrenade(s.def.id, origin, vel, kind === "c5" || kind === "mine" ? Infinity : kind === "heal" ? (s.def.pb?.grenade?.explosionTime ?? 10) : Math.max(0.1, (p.fuse ?? 2.5) + titleFxLive.bombTime), true); // title Bomb_Time
      if (g && kind === "c5") this.planted.push(g);
      // Claymore: no fuse until an enemy comes near (updateMines); it sticks where it lands (AttachableItem)
      if (g && kind === "mine") this.mines.set(g, { look: dir.clone().normalize(), triggered: false });
      if (g) this.onThrowNet?.({ state: "throw", g, pos: origin, vel });
      this.emit(this.fireL, { weapon: s.def, slot: this.cur, kind: "throw", origin, direction: vel.clone().normalize(),
        ammo: s.ammo, reserve: s.reserve });
    };
    for (const at of rel) this.later(at, spawn);
  }

  /**
   * Launch ray of a throw (slot 0x200 0x630bf0): start = the camera position (getVirtualCamPosition 0x815cd0, no hand
   * offset), direction = camera forward (target 0x6092c0 = cam - At * Range; no added pitch). Player velocity is not
   * added (Throw 0x62ed14 keeps position, direction, speed).
   */
  private throwRay(): { origin: THREE.Vector3; dir: THREE.Vector3 } {
    const cam = this.ctx.camera;
    return { origin: cam.getWorldPosition(new THREE.Vector3()), dir: cam.getWorldDirection(new THREE.Vector3()) };
  }

  /** trail state per flying grenade: last piece end, time since it */
  private trails = new WeakMap<LiveGrenade, { last: THREE.Vector3; t: number; every: number }>();
  /** thrown-item trail (weapon.pef TracerType): a piece every PieceCreateTime while the item is in the air */
  private updateTrails(dt: number): void {
    for (const g of this.grenades.live) {
      const type = (weaponFxInfo(g.weapon.id) ?? weaponFxInfo(throwableBaseId(g.weapon.id)))?.tracerType;
      if (!type || g.resting || g.stuck) continue;
      let tr = this.trails.get(g);
      if (!tr) this.trails.set(g, tr = { last: g.mesh.position.clone(), t: 0, every: 0.025 });
      tr.t += dt;
      if (tr.t < tr.every) continue;
      tr.t = 0;
      tr.every = this.effects.trailPiece(type, tr.last, g.mesh.position) || 0.025;
      tr.last.copy(g.mesh.position);
    }
  }

  /** spawn a physical grenade; local=false for replicated throws (visual/sound only, no onHit). */
  spawnGrenade(weaponId: number, origin: THREE.Vector3, velocity: THREE.Vector3, fuse = 2.5, local = false): LiveGrenade | null {
    const def = this.db.def(weaponId);
    if (!def) return null;
    const kind = throwKind(def);
    const g = this.grenades.spawn(def, origin, velocity, fuse, local, undefined, kind === "c5" || kind === "mine", kind === "heal");
    if (kind === "heal") this.kits.set(g, { born: this.time, aura: null });
    return g;
  }

  /** bomb trigger press + 0.05 s: every planted C5 gets flag 8 and goes off Explosion_Time later (WeaponC5 OnUpdate) */
  private detonateC5(): void {
    for (const g of this.planted) {
      g.fuse = g.weapon.params.fuse ?? 0.5;
      this.audio.c5Count(g.mesh.position); // sound 0x10 at the C5 (0x6425ff) = sound table row 0 idx 0x10 WM_C5_Count_A (0x7b4a64) [INFERIDO: row]
      this.onThrowNet?.({ state: "trigger", g, pos: g.mesh.position, vel: new THREE.Vector3() });
    }
    this.planted = [];
  }

  /**
   * Claymore trigger, run by the owner's client only (its mines are local; the others get the explode record). A planted mine
   * (stuck) whose enemy is in its cone (enemyInCone) gets fuse = Explosion_Time (0.8 s, pef). The trigger is not sent over
   * the net: the explode record that follows is the only record the others need.
   * [INFERIDO] the arm delay after landing is 0 (exe 0x671760 searches at once: no timer before the flag 0x2 search).
   */
  private updateMines(): void {
    if (!this.mines.size) return;
    for (const [g, m] of this.mines) {
      if (m.triggered || !g.stuck || !g.local) continue;
      if (!this.enemyInCone(g.mesh.position, m.look, CLAYMORE_DETECT_RANGE)) continue;
      m.triggered = true;
      g.fuse = g.weapon.params.fuse ?? 0.8;
    }
  }

  /**
   * Claymore target (exe 0x671760 -> 0x6714e0): an enemy (WeaponContext.isEnemy) with a point within `r` of the mine, inside the
   * cone of CLAYMORE_CONE_COS about `look`, and no wall between (exe 0x607790). The exe tests one point per character; the
   * hitbox centre stands in for it [INFERIDO].
   */
  private enemyInCone(pos: THREE.Vector3, look: THREE.Vector3, r: number): boolean {
    const R = this.ctx.RAPIER, world = this.ctx.world;
    let found = false;
    world.intersectionsWithShape({ x: pos.x, y: pos.y, z: pos.z }, { x: 0, y: 0, z: 0, w: 1 }, new R.Ball(r), (c) => {
      const t = this.ctx.resolveTarget(c);
      if (!t || !(this.ctx.isEnemy?.(t) ?? true)) return true;
      const tp = c.translation();
      const d = new THREE.Vector3(tp.x, tp.y, tp.z).sub(pos);
      const len = d.length();
      if (len === 0 || len > r || d.dot(look) < len * CLAYMORE_CONE_COS) return true;
      if (this.castNormal(pos, d.divideScalar(len), len, (w) => !this.ctx.resolveTarget(w))) return true;
      found = true;
      return false;
    }, undefined, this.ctx.filterGroups);
    return found;
  }

  /** C5 of the local player waiting for the trigger (smoke / HUD) */
  plantedC5(): number { return this.planted.length; }
  /** a ThrowingGrenade is readied (pin out) and waits for the fire release */
  isThrowReady(): boolean { return this.throwReady; }

  /**
   * The local character was hurt by the blast of `weapon` (weapons.json name): WM_K400_Explosion_Damage at the
   * character (explosion hit routine 0x60ef90, after OnHit). Not for flash / smoke (no damage).
   */
  blastHurt(weapon: string): void {
    const w = this.db.find(weapon);
    const k = w ? throwKind(w) : null;
    if (k === "grenade" || k === "c5" || k === "mine" || k === "wpsmoke") this.audio.explosionHurt();
  }

  /** the local player's view of a flashbang (every client blinds its own player, 0x633e70) */
  private flashLocal(f: FlashBurst): number {
    const cam = this.ctx.camera, R = this.ctx.RAPIER, world = this.ctx.world;
    const eye = cam.getWorldPosition(new THREE.Vector3());
    const facing = cam.getWorldDirection(new THREE.Vector3());
    const own = this.own();
    const dur = flashFor(f, eye, facing, (o, d, len) => {
      const hit = world.castRay(new R.Ray({ x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z }), len, true, undefined,
        this.ctx.filterGroups, own, undefined, (c) => !this.grenades.isGrenade(c) && !this.ctx.resolveTarget(c));
      return hit ? hit.timeOfImpact : null;
    });
    if (dur > 0) {
      // Flashbang Protection coupon: half the blind time (ScreenEffect_Flashbang 0xAA25F3, server EffectId note)
      localFlash.start(this.itemFx.flashProtect ? dur / 2 : dur);
      this.audio.explosionHurt(true); // WM_Flash_Explosion_Damage (0x6340bf)
    }
    return dur;
  }

  /**
   * Thrown objects that raise the HUD warning for the local player (Cross CHud driver 0x744be0, collectors 0x744950 /
   * 0x744ac0, filter 0x7441e0, per-list update 0x7443c0): world position, distance and the pef IndicatorType (the badge:
   * DefaultGrenade / C5).
   *  - filter 0x7441e0: item class type 7 (ThrowingGrenade, 0x5b13d0) with a non-zero IndicatorType (0x5b2360), of class
   *    WeaponGrenade / K400 / DualGrenade / M14 / C5 / Claymore (i3String::Compare), with bomb-state flags 1 (thrown) and
   *    2 (nearly still, speed < 0.2) both set (vf+0x228 on +0xa524, C5 +0xa4d0): a grenade in flight raises nothing.
   *    Medical kits (class type 28), flash / smoke (8) and WP smoke (27) never do, nor Decoy / Football Bomb (no IndicatorType).
   *  - owner 0x57e7d0 [INFERIDO name]: skipped when it is another character of the local player's team (0x548d60 equal for
   *    both [INFERIDO: team id]); the local player's own objects and the enemies' raise it. `isAlly(owner)` answers for a
   *    replicated throw.
   *  - distance = |GetPos(object) - GetPos(local character)| [INFERIDO: feet = character root], shown up to 10 m (0xb2af0c).
   *  - NOT ported: the exe's K400 list at 8 m and the second list gated by 0x53f870 (one list at 10 m here).
   */
  grenadesNear(feet: THREE.Vector3, isAlly: (owner: string) => boolean): { pos: THREE.Vector3; dist: number; indicatorType: string }[] {
    // entries and array are pooled: valid only until the next call (the one caller reads them right away)
    const out = this._nearOut;
    let n = 0;
    for (const g of this.grenades.live) {
      const ind = g.weapon.pb?.indicatorType;
      if (g.weapon.classType !== 7 || (ind !== "DefaultGrenade" && ind !== "C5") || !grenadeArmed(g)) continue;
      if (g.owner !== undefined && isAlly(g.owner)) continue;
      // [RECRIADO] user choice (2026-10-13): the C5 badge only for its thrower; the exe (collectors 0x744950 / 0x744ac0)
      // also shows it to enemies, which gives the remote charge away
      if (ind === "C5" && !g.local) continue;
      const t = g.body.translation();
      const e = (this._nearPool[n] ??= { pos: new THREE.Vector3(), dist: 0, indicatorType: "" });
      e.indicatorType = ind;
      e.pos.set(t.x, t.y, t.z);
      e.dist = e.pos.distanceTo(feet);
      if (e.dist <= GRENADE_WARN_RANGE) out[n++] = e;
    }
    out.length = n;
    return out;
  }
  private _nearPool: { pos: THREE.Vector3; dist: number; indicatorType: string }[] = [];
  private _nearOut: { pos: THREE.Vector3; dist: number; indicatorType: string }[] = [];

  private explode(g: LiveGrenade, pos: THREE.Vector3) {
    const def = g.weapon, p = def.params;
    const radius = Math.max(0.1, (p.explosionRadius ?? 7) + (g.local ? titleFxLive.bombRange : 0)); // title Bomb_Range
    const kind = throwKind(def);
    this.planted = this.planted.filter((x) => x !== g);
    this.mines.delete(g);
    if (g.local) this.onThrowNet?.({ state: "explode", g, pos, vel: new THREE.Vector3() });
    if (kind === "heal") {
      // the kit is gone: Explosion_Time after it lay still (0x668b40 a540 >= vf 0x88) or consumed by a heal; no blast, no sound
      const k = this.kits.get(g);
      if (k?.aura) this.effects.stop(k.aura);
      this.kits.delete(g);
      return;
    }
    // the item's pef _FireEffect (weaponfx.json weapons[id].fire; items weapons.json lacks use their class base)
    const fire = (weaponFxInfo(def.id) ?? weaponFxInfo(throwableBaseId(def.id)))?.fire;
    if (kind === "flash" || kind === "smoke") {
      this.audio.explode(def, pos, kind);
      if (kind === "smoke") {
        this.effects.smokeCloud(fire ?? "Exp_Sm_01", pos); // WeaponSmoke::Explosion 0x632f90
        return;
      }
      if (fire) this.effects.play(fire, pos, new THREE.Vector3(0, 1, 0));
      const pb = def.pb?.grenade;
      const f: FlashBurst = { pos: pos.clone(), effTime: pb?.effectiveTime ?? 10, range: radius, slope: p.explosionSlope ?? 0.8 };
      this.flashLocal(f);
      emitFlashbang(f); // bots (and any other observer) run the same test for themselves
      return;
    }
    // the item's own i3 explosion effect (weapon.pef _FireEffect: K-400 Exp_Gr_01, K-413 Exp_Gr_K413_01, C5 Exp_C5_01),
    // +Y up like every throwable blast
    if (kind === "wpsmoke") this.effects.smokeCloud(fire ?? "Exp_WPSm_01", pos);
    else if (fire) this.effects.play(fire, pos, new THREE.Vector3(0, 1, 0));
    this.audio.explode(def, pos, kind);
    const camPos = this.ctx.camera.getWorldPosition(new THREE.Vector3());
    const cd = camPos.distanceTo(pos);
    this.cameraShake(PB_CAMERA_SHAKE.explosion(cd, radius)); // exe-2017 0x60ecc0
    // every client breaks its own map objects; the C5 does 60 and the glass lives 70-100 (never broke), so its blast counts x C5_PROP_DAMAGE_MULT on props
    if (kind === "grenade" || kind === "c5" || kind === "mine") this.ctx.blastProps?.(pos, radius, kind === "c5" ? p.damage * C5_PROP_DAMAGE_MULT : p.damage, g.local, def.name);
    if (!g.local) return;
    const R = this.ctx.RAPIER, world = this.ctx.world;
    // WeaponBase::_OnCheckCollisionByExplosion 0x60e9c0: every character in range -> 0x60ed10 (explosion.ts); the enemy /
    // thrower-only filter of 0x60e9c0 is left to the hit consumer (computeDamage drops same-team hits) [INFERIDO for C5:
    // WeaponC5 has its own _OnHitCharaByExplosion 0x645a70, its shape choice is not decoded]
    const cands = new Map<string | number, { target: HitTarget; collider: RAPIER.Collider | null }>();
    world.intersectionsWithShape({ x: pos.x, y: pos.y, z: pos.z }, { x: 0, y: 0, z: 0, w: 1 }, new R.Ball(radius), (c) => {
      const target = this.ctx.resolveTarget(c);
      if (!target) return true;
      const key = target.id ?? c.handle;
      if (!cands.has(key)) cands.set(key, { target, collider: c });
      return true;
    }, undefined, this.ctx.filterGroups);
    // the thrower takes its own blast too (the local player has no hitbox sensors)
    const self = this.ctx.selfTarget?.();
    if (self && !cands.has(self.id ?? "self")) cands.set(self.id ?? "self", { target: self, collider: null });
    const blast = { damage: p.damage, range: radius, slope: p.explosionSlope ?? 0 };
    // one blast = one death packet in the original: its victims share an id (2+ kills = Mass Kill, killmarks.ts ShotKills)
    const shot = ++this.shotSeq;
    for (const b of cands.values()) {
      const pts = this.blastPointsOf(b.target, b.collider);
      const d = pts.ik.distanceTo(pos);
      // both hits go out as body hits: a blast's death type is BOOM (info.f28 = 2) whatever the part, so the head line
      // only decides the damage (raw Damage, no falloff); no headshot / helmet pop downstream
      for (const h of this.blastHits(pts, pos, blast)) {
        const at = h.part === "head" ? pts.head : pts.ik;
        this.emit(this.hitL, { weapon: def, kind: "explosion", target: b.target, collider: b.collider as RAPIER.Collider, point: at.clone(),
          normal: at.clone().sub(pos).normalize(), distance: d, zone: "torso", headshot: false,
          damage: h.damage, penetrated: 0, origin: pos.clone(), shot });
      }
    }
  }

  /** the bones a blast tests for one target (hitbox.ts blastPoints); a target without an actor uses its collider centre */
  private blastPointsOf(target: HitTarget, collider: RAPIER.Collider | null): BlastPoints {
    const a = target.data as Actor | undefined;
    if (a && typeof a.feet === "function" && typeof a.isCrouching === "function") return blastPoints(a);
    const t = collider ? collider.translation() : { x: 0, y: 0, z: 0 };
    const v = new THREE.Vector3(t.x, t.y, t.z);
    return { head: v.clone(), ik: v.clone(), root: v.clone() };
  }

  /**
   * 0x60aa50 as a throwable / C4 calls it: true when no map (group 5) or object (group 7) collider lies between the blast and
   * `to`. Characters and grenades do not block. No wall is crossed (0x60abb0 skips the wall test for classes 7 / 9, 0x5b7080).
   */
  blastLineClear(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const R = this.ctx.RAPIER;
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len <= BLAST_SURFACE_SKIP) return true;
    dir.divideScalar(len);
    // the bomb lies on (or bounced off) a surface: under PhysX's one-sided casts a ray leaving it does not hit it, Rapier's
    // does, so the first BLAST_SURFACE_SKIP m are not tested [INFERIDO]
    const o = from.clone().addScaledVector(dir, BLAST_SURFACE_SKIP);
    const hit = this.ctx.world.castRay(new R.Ray({ x: o.x, y: o.y, z: o.z }, { x: dir.x, y: dir.y, z: dir.z }), len - BLAST_SURFACE_SKIP, true,
      undefined, this.ctx.filterGroups, this.own(), undefined, (cc) => !this.grenades.isGrenade(cc) && !this.ctx.resolveTarget(cc));
    return !hit;
  }

  /**
   * The hits of one blast on one target (explosion.ts explosionHits): range on the IK bone, head line, IK line, body falloff
   * over |Root - blast|. `passes` 2 for the C4 (0x637664), `hp` stops the next hit once one killed.
   */
  blastHits(pts: BlastPoints, pos: THREE.Vector3, o: { damage: number; range: number; slope: number; passes?: number; hp?: number }) {
    const ikDist = pts.ik.distanceTo(pos);
    if (!(ikDist < o.range)) return [];
    return explosionHits(o, {
      ikDist, rootDist: pts.root.distanceTo(pos), headClear: this.blastLineClear(pos, pts.head), ikClear: this.blastLineClear(pos, pts.ik),
    });
  }

  // ---- remote players --------------------------------------------------------
  /**
   * A 3rd-person shot (bot, or a remote player replicated from its aim): the same PB effects as the local shot, from the
   * shooter's 3PV muzzle. Flash = the weapon's world _FireEffect (not the _1st variant, 0x623210 is 1PV only), tracer
   * (TracerBullet, same TracerBulletRate roll), then Hit_/Hmk_<cat>_<surface> on the world or the ExpHu01_1 blood on a
   * character. `hit` null = shot into the void (flash + tracer to the max range point only).
   */
  worldShot(weaponId: number, muzzle: THREE.Vector3, to: THREE.Vector3,
    hit: { normal: THREE.Vector3 | null; actor: boolean; colliderHandle?: number } | null, opts: { flash?: boolean; tint?: Tint } = {}): void {
    const def = this.db.def(weaponId);
    if (!def || def.family === "KNIFE" || def.family === "GRENADE") return;
    this.effects.setWeapon(def.id, def.family);
    // barrel axis of the 3PV FXDummy ~ the shot direction [INFERIDO]: the replicated aim is all a remote shot carries
    const dir = to.clone().sub(muzzle).normalize();
    if (opts.flash !== false) { // the watched player's shot (observer FPS): observeFire already flashed the arms' muzzle
      this.effects.firstPerson = false;
      this.effects.muzzleFlash(this.effects.scene, muzzle, def.family === "SG" || def.family === "SR" ? 1.5 : 1, dir, opts.tint);
      this.effects.firstPerson = true;
    }
    this.effects.tracer(muzzle, to);
    if (!hit) return;
    if (hit.actor) {
      this.effects.blood(to, dir);
      this.audio.hitAt("Human", to); // WM_Hit_Human_* (Sound_Weapon_Common)
    } else {
      const n = hit.normal ?? dir.clone().negate();
      this.effects.impact(to, n, true, hit.colliderHandle !== undefined ? surfaceOfCollider(hit.colliderHandle) : "Cm", dir);
    }
  }

  /** visual + positional sound for another player's shot (net replication); `owner` = the shooter (its fire channel) */
  playRemoteFire(weaponId: number, from: THREE.Vector3, to?: THREE.Vector3, owner?: string | number): void {
    const def = this.db.def(weaponId);
    if (!def) return;
    this.effects.setWeapon(def.id, def.family);
    if (def.family === "KNIFE") {
      // a remote stab: swing sound at the attacker, knife blow + cut mark at the hit, never a tracer
      this.audio.swing(def, false, from, owner);
      if (to) {
        this.effects.impact(to, from.clone().sub(to).normalize(), true);
        this.audio.knifeHit(soundTerrainOf(undefined), to);
      }
      return;
    }
    this.audio.fireAt(def, from, owner);
    if (to) {
      this.effects.tracer(from, to);
      this.effects.impact(to, from.clone().sub(to).normalize(), false);
    }
  }

  /** the local player was hit from `from`: the arms' Damage* clip */
  hurtView(from: "FrontLeft" | "FrontRight" | "Back"): void {
    this.viewmodel?.hurt(from);
  }

  /** PB camera shake (CGameCamera::SetShake 0x528570), e.g. PB_CAMERA_SHAKE.damage(dealt, hp). null = no-op. */
  cameraShake(s: { amp: number; freq: number; phase: number; time: number } | null): void {
    if (s && s.time > 0) this.pbShake = { ...s, t: 0 };
  }

  /**
   * 0x5285e0: phi = t*freq*pi + phase, k = amp*(T - t)/T (degrees); sin(5 phi)*k turns the camera matrix about its own
   * at-row (0x528480 -> 0x52a7b0 = row +0x20: roll), then cos(2 phi)*k about its right axis (0x52aa70 mixes rows 1/2:
   * pitch). No yaw term.
   */
  private updateShake(dt: number): void {
    const s = this.pbShake;
    this.shakeP = this.shakeR = 0;
    if (!s) return;
    if (s.t >= s.time) {
      this.pbShake = null;
      return;
    }
    const phi = s.t * s.freq * Math.PI + s.phase, k = (s.amp * (s.time - s.t)) / s.time;
    this.shakeR = Math.sin(phi * 5) * k * DEG;
    this.shakeP = Math.cos(phi * 2) * k * DEG;
    s.t += dt;
  }

  /**
   * The weapon's target ray (WeaponBase vf+0x18c): eye + camera forward turned up by the part of the vertical recoil
   * the camera does not show, R.v * (1 - CamSyncRate). The bullets and the laser dot (0x64c1f6) both use it.
   */
  aimRay(): { origin: THREE.Vector3; dir: THREE.Vector3 } {
    const cam = this.ctx.camera;
    const origin = cam.getWorldPosition(new THREE.Vector3());
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const extraPitch = (this.recV - this.recoilPitch) * DEG;
    if (Math.abs(extraPitch) > 1e-6) {
      const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
      if (right.lengthSq() > 1e-8) dir.applyAxisAngle(right.normalize(), extraPitch).normalize();
    }
    return { origin, dir };
  }

  // ---- camera recoil ---------------------------------------------------------
  /** withShake: only the end-of-frame call. The start-of-frame / shot calls ran with the previous frame's shake still
   *  set, so the shake was added twice per frame (2x the exe amplitude), and the exe shake never reaches the aim. */
  private syncCamera(withShake = false) {
    const cam = this.ctx.camera;
    const wantP = this.recoilPitch * DEG;
    const wantY = this.recoilYaw * DEG;
    if (this.ctx.applyLook) {
      const dp = wantP - this.appliedPitch, dy = wantY - this.appliedYaw;
      if (dp || dy) this.ctx.applyLook(dp, dy);
      this.appliedPitch = wantP;
      this.appliedYaw = wantY;
      // the shake only turns the camera (0x5285e0 edits the camera matrix, not the aim); the player rewrites the
      // rotation every frame before this runs, so adding it here lasts one frame
      if (withShake && (this.shakeP || this.shakeR)) {
        cam.rotation.order = "YXZ";
        cam.rotation.x += this.shakeP;
        cam.rotation.z += this.shakeR;
        cam.updateMatrixWorld();
      }
      return;
    }
    // player overwrote rotation this frame -> nothing of ours is applied any more
    if (cam.rotation.x !== this.lastSetX || cam.rotation.y !== this.lastSetY) {
      this.appliedPitch = 0;
      this.appliedYaw = 0;
    }
    const wP = wantP + this.shakeP, wY = wantY;
    cam.rotation.order = "YXZ";
    cam.rotation.x += wP - this.appliedPitch;
    cam.rotation.y += wY - this.appliedYaw;
    cam.rotation.z = this.shakeR; // nothing else rolls the camera
    this.appliedPitch = wP;
    this.appliedYaw = wY;
    this.lastSetX = cam.rotation.x;
    this.lastSetY = cam.rotation.y;
    cam.updateMatrixWorld();
  }

  // ---- HUD -------------------------------------------------------------------
  getHudState(): WeaponHudState {
    const s = this.slots[this.cur];
    const def = s?.def;
    return {
      ready: this.db.loaded,
      slot: this.cur,
      id: def?.id ?? 0,
      name: def?.name ?? "",
      family: def?.family ?? "OTHER",
      fireMode: def?.fireMode ?? "semi",
      ammo: s?.ammo ?? 0,
      reserve: s?.reserve ?? 0,
      magSize: def?.loadedBullet ?? 0,
      limitedAmmo: !!def && isBallisticKnife(def),
      reloading: this.reloading,
      reloadProgress: this.reloading ? 1 - this.reloadTimer / Math.max(0.001, this.reloadDuration) : 0,
      switching: this.switchTimer > 0,
      silencer: !!s?.silencer,
      aiming: this.aiming,
      scoped: this.scoped,
      laserOn: this.laser.active,
      dual: def ? dualFire(def) : null,
      dualLeft: this.dualLeft,
      spreadDeg: this.spreadNow,
      fov: this.ctx.camera.fov,
      slots: this.slots.flatMap((x, i) => (x ? [{ slot: i as SlotIndex, id: x.def.id, name: x.def.name, family: x.def.family,
        ammo: x.ammo, reserve: x.reserve }] : [])),
    };
  }

  /**
   * crosshair gap in px for a viewport height: Crosshair::CalcRminLen 0x7598b0 = tan(b0 deg) * H/2 (Crosshair_Ring
   * 0xa41680 passes H/2). No FOV term: zooming does not scale the gap. The bullets land within +-b0/4 deg per axis
   * (pbShotOffsets), well inside it.
   */
  crosshairRadiusPx(viewportHeight: number): number {
    return Math.tan(this.spreadNow * DEG) * (viewportHeight / 2);
  }

  /**
   * Round start (Bomb Mission). ROUND_START packet (ClientTCPSocket::_PacketParsingBattle, call at 0x99f8d4) ->
   * CGameWeaponManager::PreStartRound 0x66fa00: every thrown weapon (THROWING_MAX lists, +0x418) and grenade shell
   * (GRENADESHELL_MAX, +0x41c) goes back to its pool (0x66e8f0: off the world root), RemoveAllDropWeapon 0x670150.
   * Then _ProcessEvent_RoundStart 0x769040 resets the effect manager (WeaponEffects.reset): smoke clouds, blasts, holes.
   */
  resetRound(): void {
    this.grenades.clear();
    this.kits.clear();
    this.mines.clear();
    this.planted = [];
    smokeField.clear();
    this.effects.reset();
  }

  dispose(): void {
    this.grenades.clear();
    this.kits.clear();
    this.planted = [];
    smokeField.clear();
    localFlash.clear();
    this.tinnitus.update(localFlash);
    this.scope.dispose();
    this.laser.dispose();
    this.audio.dispose();
    this.viewmodel?.group.parent?.remove(this.viewmodel.group);
    this.fireL = [];
    this.hitL = [];
    this.reloadL = [];
    this.switchL = [];
  }
}
