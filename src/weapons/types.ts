import type * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";

export type Family = "AR" | "SMG" | "MG" | "SR" | "SG" | "HG" | "KNIFE" | "GRENADE" | "OTHER";
export type FireMode = "auto" | "semi" | "burst" | "bolt" | "pump" | "melee" | "throw";
/** 'torso'/'limb' are accepted too so src/game/types.ts HitZone plugs in unchanged. */
export type HitZone = "head" | "body" | "arm" | "leg" | "torso" | "limb";
export type SlotIndex = 0 | 1 | 2 | 3 | 4 | 5; // primary, secondary, melee, grenade, special (smoke / flash), mission (C4): keys 1-6 (exe ProcessWeapon 0xa23485: Cmd_ChangeWeapon 0..5)

/** Weapon.pef recoil block (degrees), read by CGunInfo (vtable 0xb68cfc), applied by 0x5cea50 / 0x5ced10. */
export interface RecoilParams {
  /** RecoilVertAngle: pitch added per kicking shot */
  vertAngle: number;
  /** RecoilVertMax: accumulated pitch cap */
  vertMax: number;
  /** RecoilVertCount: free shots before the vertical kick starts (0 = every shot) */
  vertCount: number;
  /** OneVertEnable / OneHorzEnable: count compare is <= instead of < */
  oneVert: boolean;
  oneHorz: boolean;
  /** RecoilHorzAngle: random +-yaw per kicking shot */
  horzAngle: number;
  /** RecoilHorzMax: |yaw| from the burst start, kick bounces back when exceeded */
  horzMax: number;
  /** RecoilHorzCount: free shots before the yaw kick starts */
  horzCount: number;
  /** RecoilVertAngle_Recovertime / RecoilHorzAngle_Recovertime (default 1.0) */
  vertRecoverTime: number;
  horzRecoverTime: number;
  /** CamSyncRate: share of the vertical recoil the camera shows (the aim uses all of it) */
  camSyncRate: number;
}
/** Weapon.pef deviation + crosshair block. Deviation* in degrees, CrossHair_* in crosshair units (see WeaponSystem). */
export interface SpreadParams {
  /** Deviation: crosshair/deviation added per shot (0x7e8400) */
  deviation: number;
  /** Deviation_Max: read by CGunInfo but NOT used by the per-shot code (CrossHair_Max is the clamp) */
  deviationMax: number;
  deviationDecrement?: number;
  deviationDiminutionDistance?: number;
  cross: {
    stand: number; sit: number; walk: number; move: number; jump: number; fire: number; zoom: number; noZoom: number;
    moveSit: number; walkSit: number; damage: number; min: number; max: number; expand: number; speedFactor: number;
    /** CrossHair_ExpandTime (default 0) / CrossHair_ContractTime (default 0.4) */
    expandTime: number; contractTime: number;
  };
}
/** Weapon.pef MoveNormal_* (% of the character speed). */
export interface MoveNormal { stand: number; fire: number; sit: number; zoom: number; scope: number }

/** Per-weapon handling, built from the weapons.json pb block (Weapon.pef) by WeaponDb.def(). */
export interface ClassParams {
  fireMode: FireMode;
  /** pef Damage / Range (the top-level WeaponStat damage/range stay the server XML values; see xmlDiff) */
  damage: number;
  range: number;
  /** ReloadTime (per shell when reloadPerShell) */
  reloadTime: number;
  /** ReloadBulletCount == 1 -> shell-by-shell */
  reloadPerShell?: boolean;
  /**
   * Swap (draw) time in seconds: the weapon's 1PV upper Change i3AIState duration (weapons.json changeTime, not in
   * the pef). WeaponSystem divides it by pbSwapScale() (Quick Change item).
   */
  changeTime: number;
  /** NeedToLoadBullet: LoadBulletTime cycle after every shot (bolt / pump) */
  loadBulletTime?: number;
  /** FovOnZoom (RMB zoom) / FovOnScope / FovOnScope2 */
  zoomFov?: number;
  zoomFov2?: number;
  scope?: boolean;
  /** FireBulletCount */
  pellets?: number;
  /** AutoFireCount > 1 = burst size, AutoFireDelay = pause after a burst */
  burstCount?: number;
  burstDelay?: number;
  /** DPD_Rate: damage lost at max range (CGameCharaBase::_CalcDistanceRate 0x540690) */
  dpdRate: number;
  /** Damage{}.HelmetPenetrate (0..1) */
  helmetPenetrate?: number;
  /** Damage{}.BulletWeight: the bullet wall test 0x60a950 (penetration.ts); 100 when the key is absent (CWeaponInfo 0x5b351d) */
  bulletWeight: number;
  moveNormal?: MoveNormal;
  /** knife: AttackDamageA1 / AttackTimeA1 (LMB), AttackDamageB1 / AttackTimeB1 / FireDelay2 (RMB) */
  /** Ext_* factors, active while the extension (RMB zoom/scope/steady aim) is on (0x5cea50 / 0x5ced10 / 0x7e8400) */
  ext?: { type?: string; deviationFactor?: number; recoilVertFactor?: number; recoilHorzFactor?: number; recoilHorzCount?: number; recoilVertCount?: number };
  melee?: { damageA: number; timeA: number; damageB: number; timeB: number; delayB: number;
    /** DualKnife (Bone Knife, Kunai): second blade hit of the same swing, AttackDamage/TimeA2 / B2 */
    damageA2?: number; timeA2?: number; damageB2?: number; timeB2?: number };
  /** grenade: fuse = pef Explosion_Time, counted once the grenade is nearly still (speed < 0.2, exe-2017 0x630830 / grenade.ts) */
  fuse?: number;
  throwSpeed?: number;
  throwDelay?: number;
  explosionRadius?: number;
  explosionSlope?: number;
  spread: SpreadParams;
  recoil: RecoilParams;
  /** true when a value above had to fall back to the family default (no pef entry for this id) */
  fallback?: boolean;
}

/** raw pef block written by pb-extract-tools export-weapons.mjs (field names = Weapon.pef keys, camelCased). */
export interface PbWeaponBlock {
  src: string;
  base?: string;
  prov?: { base?: string[] };
  /** weapon.pef _SwapSound (WeaponBase::_LoadSwapSound 0x60556a loads "<name>.wav"), e.g. WM_Change_Assault */
  swapSound?: string;
  /** weapon.pef _FireSound (wav name without extension; sfx/pb2017.json files) */
  fireSound?: string;
  extType?: string;
  /** pef IndicatorType: grenade-warning badge (Cross CHud 0x7443c0), "DefaultGrenade" or "C5"; absent = no warning */
  indicatorType?: string;
  /** pef Extension2 Type "Dual" ITEMID: the extension key swaps this item for the dual one (Kriss S.V 104013 -> 118001) */
  dualId?: number;
  /** the single item whose Extension2 Dual points at this dual item (118001 -> 104013): the way back */
  dualOf?: number;
  damage?: number; damageMax?: number; fireDelay?: number; range?: number; dpdRate?: number;
  helmetPenetrate?: number; helmetPenetrateStr?: number; bulletWeight?: number;
  loadBullet?: number; maxBullet?: number; fireBulletCount?: number; fireDecBulletCount?: number;
  autoFireCount?: number; autoFireDelay?: number; triggerType?: number; fireType?: number; zoomType?: number;
  reloadTime?: number; reloadBulletCount?: number; needToLoadBullet?: number; loadBulletTime?: number; pumpAction?: number;
  fovOnZoom?: number; fovOnScope?: number; fovOnScope2?: number; maxScopeLevel?: number;
  /** Weapon.pef FastZoom: zooming in >1 s after the last zoomed shot makes crosshair changes instant (exe-2017 0x615590 / 0x6150c0) */
  fastZoom?: number;
  deviation?: number; deviationMax?: number; deviationDecrement?: number; deviationDiminutionDistance?: number;
  recoil?: { vertAngle?: number; vertMax?: number; vertCount?: number; oneVert?: number; oneHorz?: number; horzAngle?: number;
    horzMax?: number; horzCount?: number; camSyncRate?: number; vertRecoverTime?: number; horzRecoverTime?: number };
  crosshair?: Partial<SpreadParams["cross"]> & { type?: number; invisible?: number };
  moveNormal?: Partial<MoveNormal>;
  ext?: { deviationFactor?: number; recoilVertFactor?: number; recoilHorzFactor?: number; recoilHorzCount?: number;
    recoilVertCount?: number; autoFireCount?: number; fireDelay?: number; damage?: number };
  melee?: { damageA1?: number; damageA2?: number; damageB1?: number; damageB2?: number; timeA1?: number; timeA2?: number;
    timeB1?: number; timeB2?: number; fireDelay2?: number; autoFireCount2?: number };
  grenade?: { explosionNearRange?: number; explosionRange?: number; explosionSlope?: number; explosionTime?: number; effectiveTime?: number;
    throwSpeed?: number; throwDelay?: number };
}

/** One row of public/assets/weapons/weapons.json (from server ItemStatistics.xml). */
export interface WeaponStat {
  id: number;
  name: string;
  slot: number;
  slotName: string;
  classType: number;
  className: string;
  family: Family;
  loadedBullet: number;
  totalBullet: number;
  /** base body damage, HP 100 */
  damage: number;
  /** seconds between shots */
  fireDelay: number;
  rpm: number;
  /** XML HelmetPenetrate %, = pef chance (0..1) * 100 that a head hit gets through the helmet */
  helmetPenetrate: number;
  /** meters; the server rejects hits beyond it */
  range: number;
  sfx: string | null;
  fireMode?: FireMode;
  /** rounded XML FireDelay (fireDelay is the pef value when there is one) */
  fireDelayXml?: number;
  pb?: PbWeaponBlock;
  xmlDiff?: Record<string, [number, number]>;
  /** 1PV Change (draw) i3AIState duration, s (pb-extract-tools export-weapons.mjs from chars/swat_male/anim1pv) */
  changeTime?: number;
  /** LoadBullet i3AIState duration, s: the LoadBulletTime of a NeedToLoadBullet gun whose pef block has no such key (pb-extract-tools export-weapons.mjs) */
  loadBulletClip?: number;
}

export interface WeaponDef extends WeaponStat {
  fireMode: FireMode;
  params: ClassParams;
}

/** Character.pef DamageRate (per hit part multiplier). */
export type PartRates = Record<"head" | "body" | "arm" | "leg", number> & { hand?: number; foot?: number };

export interface WeaponsJson {
  hitzone: PartRates | null;
  classes: Record<string, Partial<ClassParams>>;
  defaultLoadout: Record<string, number>;
  weapons: WeaponStat[];
}

/** What the game-core returns for a collider that belongs to a damageable actor. */
export interface HitTarget {
  hitzone: HitZone;
  /** stable id used to merge several hitbox colliders of one actor (explosions) */
  id?: string | number;
  hasHelmet?: boolean;
  /** anything the game-core wants back in onHit (Actor, net id...) */
  data?: unknown;
}

export interface LoadoutIds {
  primary: number;
  secondary: number;
  melee: number;
  grenade: number;
  /** slot 5 (Throwing2: SmokeGrenade / FlashBang / WP Smoke) */
  special?: number;
}

export interface WeaponContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  world: RAPIER.World;
  RAPIER: typeof RAPIER;
  resolveTarget(collider: RAPIER.Collider): HitTarget | null;
  /** map object under a bullet (glass, crates...): apply `damage`; true when it just broke, so the bullet goes on through */
  damageProp?(collider: RAPIER.Collider, damage: number, point: THREE.Vector3): boolean;
  /** explosion at `pos` (grenade / C5): breakable map objects within `radius` take damage * (1 - d / radius) */
  blastProps?(pos: THREE.Vector3, radius: number, damage: number, local: boolean, weapon?: string): void;
  /** player's own capsule, excluded from every query */
  /** the local player as a blast victim (it has no hitbox sensors); null when dead */
  selfTarget?(): HitTarget | null;
  /** a Claymore goes off for this target: an enemy character (HitTarget.data = the Actor). Absent = every target counts */
  isEnemy?(target: HitTarget): boolean;
  ownCollider?:RAPIER.Collider | (() => RAPIER.Collider | undefined);
  /** Rapier InteractionGroups for queries (e.g. game/types WORLD_ONLY_QUERY | actor bits) */
  filterGroups?: number;
  loadout?: Partial<LoadoutIds>;
  /** default "/assets/weapons" */
  assetBase?: string;
  audioListener?: THREE.AudioListener;
  /**
   * Optional: receive recoil as permanent look deltas (radians). When absent, recoil is applied
   * as a recovering offset on camera.rotation after the player wrote it (call update after player).
   */
  applyLook?(dPitch: number, dYaw: number): void;
  /** absolute look yaw (radians, recoil included): the horizontal recoil works on the chara yaw (0x60b3e0) */
  getYaw?(): number;
  /** the own character's voice is female (MV_ / WV_ takes, the scope breath); default male */
  isFemale?(): boolean;
  /** show the procedural/GLB first-person weapon (default true) */
  viewmodel?: boolean;
}

export interface WeaponInput {
  /** LMB held */
  fire: boolean;
  /** RMB held (zoom/scope for guns, heavy stab for knife) */
  aim: boolean;
  /** drop the zoom / scope now (round or match over: the end screen must not sit under the sight) */
  cancelZoom?: boolean;
  /** R (held or pressed; edge detected) */
  reload?: boolean;
  /** 0..3 from keys 1-4 (only on the frame it is pressed) */
  slot?: SlotIndex | null;
  /** Q (game-key slot 19, stroke 0x20000; press frame only): back to the last weapon (0xa23639 -> Cmd_ChangeWeapon(last)) */
  lastWeapon?: boolean;
  /** Dual extension key (F, press frame only): single <-> dual item of a weapon with pef Extension2 Type "Dual" [INFERIDO key] */
  extension2?: boolean;
  /** wheel delta this frame (sign used) */
  scroll?: number;
  /** horizontal speed m/s (or just moving=true) */
  speed?: number;
  moving?: boolean;
  grounded?: boolean;
  crouching?: boolean;
}

export interface FireEvent {
  weapon: WeaponDef;
  slot: SlotIndex;
  kind: "bullet" | "melee" | "throw";
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  ammo: number;
  reserve: number;
  heavy?: boolean;
}

export interface HitEvent {
  weapon: WeaponDef;
  kind: "bullet" | "melee" | "explosion";
  target: HitTarget | null;
  collider: RAPIER.Collider | null;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  zone: HitZone | null;
  headshot: boolean;
  /** damage from Damage x part rate x DPD falloff x helmet roll (src/game/damage.ts pbHitDamage) */
  damage: number;
  /** walls / characters crossed before this hit */
  penetrated: number;
  /** bullet / blast id (traceBullet, explosion): every character hit of one bullet or one blast shares it */
  shot?: number;
  /** start point of the bullet (server checks |start-end| <= range) */
  origin: THREE.Vector3;
}

export interface ReloadEvent {
  weapon: WeaponDef;
  phase: "start" | "shell" | "end" | "cancel";
  ammo: number;
  reserve: number;
  /** reload time actually used (ReloadTime / pbReloadScale; per shell for shell-by-shell weapons) */
  reloadTime: number;
}

/**
 * Battle item effects that change handling (server CouponEffects; items 1600026/1600165 = QuickChangeWeapon,
 * 1600027/1600166 = QuickChangeReload). The exe reads them as CGameContext::IsUseFuncItemSlot(net, 7 | 8).
 */
export interface PbItemEffects {
  quickChangeWeapon?: boolean;
  quickChangeReload?: boolean;
  /** equipped beret of type 10 (chara+0xcdc, 0x622cc0): a 2nd x1.5 swap source (0xa0c3d0) */
  beretQuickChange?: boolean;
  /** equipped beret with fast reload (isUseFastReloadTime_CurrentBeret 0x613710): reload x1.25 before the item */
  beretFastReload?: boolean;
  /** respawn coupons (CouponEffects Respawn20/30/50/100): share of the respawn time cut, 0.2 / 0.3 / 0.5 / 1 */
  respawnCut?: number;
  /** Ammo Up coupons (CouponEffects Ammo40 / Ammo10): extra share of the reserve rounds, 0.4 / 0.1 */
  ammoUp?: number;
  /** HP Up 5% / 10% (CouponEffects HP5 / HP10): extra share of the character's max HP */
  hpUp?: number;
  /** Defense Up 5% / 10% / 20% / Vest 90% (CouponEffects Defense5/10/20/90): share of the damage taken removed */
  defense?: number;
  /** "Invisible +1 Seconds" (CouponEffects Invincible): extra spawn protection (s) */
  invincibleExtra?: number;
  /** Flashbang Protection (CouponEffects FlashProtect): the flash blinds for half the time */
  flashProtect?: boolean;
  /** Increase Grenade Slot (CouponEffects ExtraGrenade): one more grenade (a pair for dual grenades) */
  extraGrenade?: boolean;
  /** Increase Smoke Slot (CouponEffects ExtraThrowGrenade): one more throwable in the special slot */
  extraSpecialThrow?: boolean;
  /** bullet coupons (Hollow Point / Hollow Point Plus / Jack Hollow Point / Full Metal Jack): damage share added */
  bulletDamageUp?: number;
  /** bullet coupons: added to the weapon's helmet penetration (0..1) */
  bulletPenetrateUp?: number;
}

export interface SwitchEvent {
  from: WeaponDef | null;
  to: WeaponDef;
  slot: SlotIndex;
}

export interface WeaponHudSlot {
  slot: SlotIndex;
  id: number;
  name: string;
  family: Family;
  ammo: number;
  reserve: number;
}

export interface WeaponHudState {
  ready: boolean;
  slot: SlotIndex;
  id: number;
  name: string;
  family: Family;
  fireMode: FireMode;
  ammo: number;
  reserve: number;
  magSize: number;
  /** a knife with a magazine (Ballistic Knife): the HUD shows its ammo */
  limitedAmmo?: boolean;
  reloading: boolean;
  /** 0..1 */
  reloadProgress: number;
  switching: boolean;
  /** silencer extension on (MK23 / MP5K) */
  silencer?: boolean;
  aiming: boolean;
  /** sniper scope overlay is visible (hide crosshair) */
  scoped: boolean;
  /** WeaponDotLaser shown (hide the screen crosshair, OnApplyCrosshair 0xa6585f) */
  laserOn?: boolean;
  /** dual-wield gun: "alt" = the hands take turns (DualHandGun), "both" = both guns each shot (DualSMG); null = one gun */
  dual?: "alt" | "both" | null;
  /** the left gun fires next (WeaponDualHandGun +0xa550); with `dual` it picks the bright bar of the 2nd ammo gauge */
  dualLeft?: boolean;
  /** current cone half-angle, degrees */
  spreadDeg: number;
  /** camera fov right now (for crosshair px = tan(spread)/tan(fov/2) * h/2) */
  fov: number;
  slots: WeaponHudSlot[];
}
