import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import * as PBW from "../weapons";
import { throwKind } from "../weapons/throwables";
import type { HitZone } from "./types";

/*
 * WeaponSystem contract consumed by src/game/game.ts.
 *
 * Default: PbWeaponsBridge wraps the real src/weapons WeaponSystem (weapons.json stats, sfx,
 * viewmodel, scope, grenades, wall penetration). It raycasts Rapier colliders, so the game keeps
 * sensor hitboxes (hitColliders.ts) and hands back ActorHitTargets via resolveTarget. Its onHit
 * damage already includes zone/falloff/helmet (final: true); the game only applies vest + helmet pop.
 * ?weapons=adapter forces MinimalWeaponSystem (analytic ctx.shoot, base damage, game applies zones).
 */

export interface WeaponInput {
  fire: boolean; // trigger held
  firePressed: boolean; // trigger went down this frame
  aim: boolean; // right mouse
  reload: boolean; // R pressed this frame
  switchSlot: number | null; // 0 primary, 1 secondary, 2 melee, 3 grenade, 4 special
  cycle: number; // mouse wheel -1/0/+1
  /** Q pressed this frame: last weapon (PB game-key 19) */
  lastWeapon?: boolean;
  /** F pressed this frame: Dual extension (single <-> dual item) */
  extension2?: boolean;
  /** drop zoom / scope (round or match over) */
  cancelZoom?: boolean;
}

export interface ShotResult {
  point: THREE.Vector3;
  normal: THREE.Vector3 | null;
  distance: number;
  actorId: string | null;
  zone: HitZone | null;
  /** world collider hit (surface lookup for the impact effect) */
  colliderHandle?: number;
}

export interface WeaponContext {
  now: number;
  origin: THREE.Vector3; // eye position
  forward: THREE.Vector3; // normalized look direction
  camera: THREE.PerspectiveCamera;
  crouching: boolean;
  grounded: boolean;
  /** Horizontal speed / run speed (0 = still). */
  moveRatio: number;
  /** World + actor-hitbox raycast from the shooter (self excluded). */
  shoot(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): ShotResult;
}

export interface WeaponFireEvent {
  weapon: string;
  origin: THREE.Vector3;
  dirs: THREE.Vector3[];
  recoilPitch: number; // radians, applied to camera by the game
  recoilYaw: number;
  melee: boolean;
  /** grenade throw (the WeaponSystem throw event) */
  thrown?: boolean;
  /** knife heavy attack (RMB); replicated so an observer sees the same swing */
  heavy?: boolean;
}

export interface WeaponHitEvent {
  weapon: string;
  damage: number;
  /** damage already includes zone multiplier, falloff and helmet (src/weapons) */
  final?: boolean;
  helmetPenetrate: number;
  range: number;
  /** DPD_Rate for rangeFalloff; ignored when `final` (src/weapons already applied it). */
  dpdRate: number;
  hit: ShotResult;
  /** bullet / blast id: hits of one bullet or one explosion share it (Piercing Shot / Mass Kill) */
  shot?: number;
  /** start of the bullet / centre of the blast (the death push direction, ragdoll.ts) */
  from?: THREE.Vector3;
  explosion?: boolean;
}

export interface WeaponReloadEvent {
  weapon: string;
  phase: "start" | "end";
}

export interface WeaponHudState {
  name: string;
  slot: number;
  ammo: number;
  reserve: number;
  melee: boolean;
  reloading: boolean;
  reloadProgress: number; // 0..1
  spreadDeg: number; // current cone half-angle
  zoomFov: number | null; // requested camera FOV when aiming
  /** laser weapon with the laser on: the red dot replaces the screen crosshair (exe-2017 0xa6585f) */
  laserOn?: boolean;
  /** weapon family (SR = sniper: no 2D crosshair even unscoped) */
  family?: string;
}

export interface WeaponSystem {
  /** true when the system drives camera FOV, viewmodel, tracers/decals itself */
  readonly ownsCamera?: boolean;
  update(dt: number, input: WeaponInput, ctx: WeaponContext): void;
  onFire(cb: (e: WeaponFireEvent) => void): () => void;
  onHit(cb: (e: WeaponHitEvent) => void): () => void;
  onReload(cb: (e: WeaponReloadEvent) => void): () => void;
  getState(): WeaponHudState;
  /** Refill ammo and select primary (on respawn). */
  reset(): void;
  /** Show/hide the first-person weapon (hidden while dead). */
  setVisible?(on: boolean): void;
  /** ESC menu / lobby FOV slider: re-anchors the non-aiming FOV live. */
  setBaseFov?(fov: number): void;
  /** PB camera shake (CGameCamera::SetShake 0x528570), view only */
  cameraShake?(s: { amp: number; freq: number; phase: number; time: number } | null): void;
  /** the local player was hit from this side: the arms' Damage* clip */
  hurtView?(from: "FrontLeft" | "FrontRight" | "Back"): void;
  dispose?(): void;
}

// ---- Weapon data (from server/binary/Debug/Data/Match/ItemStatistics.xml) ----
export interface WeaponDef {
  id: number;
  name: string;
  slot: number;
  damage: number;
  fireDelay: number;
  mag: number;
  reserve: number;
  helmetPenetrate: number;
  range: number;
  reloadTime: number;
  auto: boolean;
  melee: boolean;
  spreadBase: number; // deg
  spreadMove: number; // deg added at full run speed
  spreadAir: number;
  spreadPerShot: number;
  spreadMax: number;
  spreadRecover: number; // deg / s
  recoil: number; // rad pitch kick per shot
  zoomFov: number | null;
  /** DPD_Rate (pef-3.123 weapons.json pb.dpdRate): CGameCharaBase::_CalcDistanceRate slope, see damage.ts. */
  dpdRate: number;
}

export const WEAPON_DEFS: WeaponDef[] = [
  { id: 103004, name: "K-2", slot: 0, damage: 27, fireDelay: 0.08, mag: 30, reserve: 90, helmetPenetrate: 55, range: 140,
    reloadTime: 2.5, auto: true, melee: false, spreadBase: 0.35, spreadMove: 2.6, spreadAir: 5, spreadPerShot: 0.32,
    spreadMax: 4.5, spreadRecover: 9, recoil: 0.009, zoomFov: 55, dpdRate: 0.25 },
  { id: 214002, name: "Desert Eagle", slot: 1, damage: 28, fireDelay: 0.35, mag: 14, reserve: 42, helmetPenetrate: 58, range: 45,
    reloadTime: 1.8, auto: false, melee: false, spreadBase: 0.5, spreadMove: 2, spreadAir: 4, spreadPerShot: 1.2,
    spreadMax: 4, spreadRecover: 7, recoil: 0.03, zoomFov: null, dpdRate: 0.35 },
  { id: 119010, name: "M-7", slot: 2, damage: 40, fireDelay: 0.4, mag: 0, reserve: 0, helmetPenetrate: 43, range: 2,
    reloadTime: 0, auto: true, melee: true, spreadBase: 0, spreadMove: 0, spreadAir: 0, spreadPerShot: 0,
    spreadMax: 0, spreadRecover: 1, recoil: 0, zoomFov: null, dpdRate: 1 },
];

export const BOT_WEAPON: WeaponDef = WEAPON_DEFS[0];

/** Random direction inside a cone of half-angle `deg` around `dir`. */
export function spreadDir(dir: THREE.Vector3, deg: number, out: THREE.Vector3): THREE.Vector3 {
  out.copy(dir);
  if (deg <= 0) return out;
  const up = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(dir, up).normalize();
  const v = new THREE.Vector3().crossVectors(u, dir).normalize();
  const r = Math.tan(THREE.MathUtils.degToRad(deg)) * Math.sqrt(Math.random());
  const a = Math.random() * Math.PI * 2;
  out.addScaledVector(u, Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r).normalize();
  return out;
}

type Listener<T> = Set<(e: T) => void>;
function sub<T>(set: Listener<T>, cb: (e: T) => void): () => void {
  set.add(cb);
  return () => set.delete(cb);
}

/** Fallback used until src/weapons/index.ts exists. Hitscan, ammo, reload, spread bloom, recoil, ADS. */
export class MinimalWeaponSystem implements WeaponSystem {
  private fireL: Listener<WeaponFireEvent> = new Set();
  private hitL: Listener<WeaponHitEvent> = new Set();
  private reloadL: Listener<WeaponReloadEvent> = new Set();
  private ammo: number[] = [];
  private reserve: number[] = [];
  private slot = 0;
  private cooldown = 0;
  private reloadLeft = 0;
  private switchLeft = 0;
  private bloom = 0;
  private spread = 0;
  private aiming = false;

  constructor(private defs: WeaponDef[] = WEAPON_DEFS) {
    this.reset();
  }

  private get def(): WeaponDef {
    return this.defs[this.slot];
  }

  reset(): void {
    this.ammo = this.defs.map((d) => d.mag);
    this.reserve = this.defs.map((d) => d.reserve);
    this.slot = 0;
    this.cooldown = 0;
    this.reloadLeft = 0;
    this.switchLeft = 0;
    this.bloom = 0;
  }

  onFire(cb: (e: WeaponFireEvent) => void) { return sub(this.fireL, cb); }
  onHit(cb: (e: WeaponHitEvent) => void) { return sub(this.hitL, cb); }
  onReload(cb: (e: WeaponReloadEvent) => void) { return sub(this.reloadL, cb); }

  private select(slot: number): void {
    if (slot === this.slot || slot < 0 || slot >= this.defs.length) return;
    if (this.reloadLeft > 0) this.reloadLeft = 0; // switching cancels reload
    this.slot = slot;
    this.switchLeft = 0.45;
    this.bloom = 0;
  }

  private startReload(): void {
    const d = this.def;
    if (d.melee || this.reloadLeft > 0 || this.ammo[this.slot] >= d.mag || this.reserve[this.slot] <= 0) return;
    this.reloadLeft = d.reloadTime;
    this.reloadL.forEach((cb) => cb({ weapon: d.name, phase: "start" }));
  }

  update(dt: number, input: WeaponInput, ctx: WeaponContext): void {
    if (input.switchSlot !== null) this.select(input.switchSlot);
    if (input.cycle) this.select((this.slot + input.cycle + this.defs.length) % this.defs.length);

    const d = this.def;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.switchLeft = Math.max(0, this.switchLeft - dt);
    this.bloom = Math.max(0, this.bloom - d.spreadRecover * dt);
    this.aiming = input.aim && d.zoomFov !== null && this.reloadLeft <= 0;

    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 0) {
        const need = d.mag - this.ammo[this.slot];
        const take = Math.min(need, this.reserve[this.slot]);
        this.ammo[this.slot] += take;
        this.reserve[this.slot] -= take;
        this.reloadLeft = 0;
        this.reloadL.forEach((cb) => cb({ weapon: d.name, phase: "end" }));
      }
    }
    if (input.reload) this.startReload();

    let spread = d.spreadBase + d.spreadMove * Math.min(1.2, ctx.moveRatio) + (ctx.grounded ? 0 : d.spreadAir) + this.bloom;
    if (ctx.crouching) spread *= 0.6;
    if (this.aiming) spread *= 0.5;
    this.spread = Math.min(d.spreadMax + d.spreadAir, spread);

    const wants = d.auto ? input.fire : input.firePressed;
    if (!wants || this.cooldown > 0 || this.switchLeft > 0 || this.reloadLeft > 0) return;
    if (!d.melee && this.ammo[this.slot] <= 0) {
      this.startReload();
      return;
    }

    this.cooldown = d.fireDelay;
    if (!d.melee) this.ammo[this.slot]--;
    const dir = spreadDir(ctx.forward, d.melee ? 0 : this.spread, new THREE.Vector3());
    this.bloom = Math.min(d.spreadMax, this.bloom + d.spreadPerShot);
    const recoilPitch = d.recoil * (this.aiming ? 0.6 : 1) * (ctx.crouching ? 0.7 : 1);
    this.fireL.forEach((cb) =>
      cb({ weapon: d.name, origin: ctx.origin.clone(), dirs: [dir], recoilPitch, recoilYaw: (Math.random() - 0.5) * recoilPitch * 0.6, melee: d.melee })
    );
    const hit = ctx.shoot(ctx.origin, dir, d.melee ? d.range : Math.max(200, d.range));
    if (hit.distance < Infinity) {
      this.hitL.forEach((cb) => cb({ weapon: d.name, damage: d.damage, helmetPenetrate: d.helmetPenetrate, range: d.range, dpdRate: d.dpdRate, hit }));
    }
    if (!d.melee && this.ammo[this.slot] <= 0) this.startReload();
  }

  getState(): WeaponHudState {
    const d = this.def;
    return {
      name: d.name,
      slot: this.slot,
      ammo: this.ammo[this.slot],
      reserve: this.reserve[this.slot],
      melee: d.melee,
      reloading: this.reloadLeft > 0,
      reloadProgress: d.reloadTime > 0 && this.reloadLeft > 0 ? 1 - this.reloadLeft / d.reloadTime : 0,
      spreadDeg: this.spread,
      zoomFov: this.aiming ? d.zoomFov : null,
    };
  }
}

export interface BridgeDeps {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  world: RAPIER.World;
  R: typeof RAPIER;
  filterGroups: number;
  resolveTarget(c: RAPIER.Collider): PBW.HitTarget | null;
  damageProp?(c: RAPIER.Collider, damage: number, point: THREE.Vector3): boolean;
  blastProps?(pos: THREE.Vector3, radius: number, damage: number, local: boolean, weapon?: string): void;
  ownCollider(): RAPIER.Collider | undefined;
  selfTarget?(): PBW.HitTarget | null;
  isEnemy?(t: PBW.HitTarget): boolean;
  applyLook(dPitch: number, dYaw: number): void;
  getYaw?(): number;
  isFemale?(): boolean;
}

/** Adapts src/weapons WeaponSystem to the game-facing WeaponSystem contract above. */
export class PbWeaponsBridge implements WeaponSystem {
  readonly ownsCamera = true;
  readonly ws: PBW.WeaponSystem;

  constructor(d: BridgeDeps) {
    this.ws = new PBW.WeaponSystem({
      scene: d.scene,
      camera: d.camera,
      world: d.world,
      RAPIER: d.R,
      resolveTarget: d.resolveTarget,
      damageProp: d.damageProp,
      blastProps: d.blastProps,
      ownCollider: d.ownCollider,
      selfTarget: d.selfTarget,
      isEnemy: d.isEnemy,
      filterGroups: d.filterGroups,
      applyLook: d.applyLook,
      getYaw: d.getYaw,
      isFemale: d.isFemale,
    });
  }

  update(dt: number, input: WeaponInput, ctx: WeaponContext): void {
    this.ws.update(dt, {
      fire: input.fire,
      aim: input.aim,
      reload: input.reload,
      slot: input.switchSlot as PBW.SlotIndex | null,
      lastWeapon: input.lastWeapon,
      extension2: input.extension2,
      cancelZoom: input.cancelZoom,
      scroll: input.cycle,
      speed: ctx.moveRatio * 4.5,
      grounded: ctx.grounded,
      crouching: ctx.crouching,
    });
  }

  onFire(cb: (e: WeaponFireEvent) => void) {
    return this.ws.onFire((e) =>
      // a medical kit is not a grenade: no "Granada!" call (WeaponGrenade::Throw 0x62ebb3 is for the throwables)
      cb({ weapon: e.weapon.name, origin: e.origin, dirs: [e.direction], recoilPitch: 0, recoilYaw: 0, melee: e.kind === "melee", thrown: e.kind === "throw" && throwKind(e.weapon) !== "heal", heavy: e.heavy })
    );
  }

  onHit(cb: (e: WeaponHitEvent) => void) {
    return this.ws.onHit((e) => {
      const t = e.target as (PBW.HitTarget & { id?: string }) | null;
      if (!t || t.id === undefined) return;
      const zone: HitZone = e.zone === "head" ? "head" : e.zone === "torso" || e.zone === "body" ? "torso" : "limb";
      cb({
        weapon: e.weapon.name,
        damage: e.damage,
        final: true,
        helmetPenetrate: e.weapon.helmetPenetrate,
        range: e.weapon.range,
        dpdRate: e.weapon.params.dpdRate,
        hit: { point: e.point, normal: e.normal, distance: e.distance, actorId: String(t.id), zone },
        shot: e.shot,
        from: e.origin,
        explosion: e.kind === "explosion",
      });
    });
  }

  onReload(cb: (e: WeaponReloadEvent) => void) {
    return this.ws.onReload((e) => {
      if (e.phase === "start" || e.phase === "end") cb({ weapon: e.weapon.name, phase: e.phase });
    });
  }

  getState(): WeaponHudState {
    const h = this.ws.getHudState();
    return {
      name: h.name || "...",
      slot: h.slot,
      ammo: h.ammo,
      reserve: h.reserve,
      melee: h.family === "KNIFE" && !h.limitedAmmo,
      family: h.family,
      reloading: h.reloading,
      reloadProgress: h.reloadProgress,
      spreadDeg: h.scoped ? 0 : h.spreadDeg,
      zoomFov: h.scoped ? h.fov : null, // scoped: hide crosshair; FOV itself is driven by src/weapons
      laserOn: !!h.laserOn,
    };
  }

  reset(): void {
    this.ws.refill();
    this.ws.switchTo(0);
    this.ws.resetLast(); // Q after spawn = no-op like the exe (last == current, 0xa13038)
  }

  cameraShake(s: { amp: number; freq: number; phase: number; time: number } | null): void {
    this.ws.cameraShake(s);
  }

  hurtView(from: "FrontLeft" | "FrontRight" | "Back"): void {
    this.ws.hurtView(from);
  }

  setVisible(on: boolean): void {
    // not viewmodel.hidden: WeaponSystem owns it (scope overlay hide) and this runs after its update every frame
    this.ws.viewmodelEnabled = on;
    if (this.ws.viewmodel) this.ws.viewmodel.group.visible = on && !this.ws.viewmodel.hidden;
  }

  setBaseFov(fov: number): void {
    this.ws.setBaseFov(fov);
  }

  dispose(): void {
    this.ws.dispose();
  }
}

export async function loadWeaponSystem(d: BridgeDeps): Promise<{ system: WeaponSystem; source: "weapons" | "adapter" }> {
  if (new URLSearchParams(location.search).get("weapons") !== "adapter") {
    try {
      const b = new PbWeaponsBridge(d);
      await b.ws.ready;
      return { system: b, source: "weapons" };
    } catch (err) {
      console.warn("[weapons] src/weapons failed to start; using adapter", err);
    }
  }
  return { system: new MinimalWeaponSystem(), source: "adapter" };
}
