import * as THREE from "three";
import type { HelmetSource } from "./helmetDrop";
import type { DeathHit } from "./ragdoll";

// 0 = RED, 1 = BLUE (PB team order).
export type Team = 0 | 1;
export const TEAM_COLORS = [0xd33a2c, 0x2c6fd3] as const;

export type HitZone = "head" | "torso" | "limb";

// Rapier interaction groups: (memberships << 16) | filter.
// World colliders keep the default (all bits). Actors live on bit 1 only, so a
// world-only query (filter = bit 0) passes through them.
export const ACTOR_COLLISION_GROUPS = (0x0002 << 16) | 0xffff;
export const WORLD_ONLY_QUERY = (0xffff << 16) | 0x0001;
/** Hitbox sensors (bit 2) for src/weapons ray queries; invisible to KCC and world-only rays. */
export const HITBOX_COLLISION_GROUPS = (0x0004 << 16) | 0x0001;
/** Character-controller queries: world + other capsules, never hitboxes. */
export const KCC_QUERY = (0xffff << 16) | 0x0003;
/** src/weapons bullet queries: world + hitboxes, never capsules. */
export const WEAPON_QUERY = (0xffff << 16) | 0x0005;

/** motion / event counters of an actor for the observer view (game.ts spectateCam -> WeaponSystem.observeState) */
export interface ObsState { speed: number; grounded: boolean; aiming: boolean; fireSeq: number; reloadSeq: number; reloadSecs: number; firing?: boolean; planting?: boolean; heavy?: boolean;
  /** replicated torsoAction "reload" / "ready" (grenade pin out): absent (bots) = the observer falls back to the reload counter / nothing */
  reloading?: boolean; ready?: boolean }

/** Anything that can be shot: local player, bot, or (later) a remote network player. */
export interface Actor {
  readonly id: string;
  name: string;
  team: Team;
  readonly kind: "player" | "bot" | "remote";
  hp: number;
  maxHp: number;
  /** Vest points: absorbs part of torso/limb damage while > 0. */
  armor: number;
  /** wears a helmet: a head item is equipped and it has not popped off this life (HELMET PROTECTION) */
  helmet: boolean;
  /** the helmet-slot accessory (helmet or beret) popped off this life */
  helmetLost: boolean;
  /** the helmet model on the head (HELMET PROTECTION drop); absent / null = nothing drawn */
  helmetSource?(): HelmetSource | null;
  alive: boolean;
  /** Defense Up coupons: share of the damage taken removed (0..1; local player only) */
  defense?: number;
  /** Game-time (s) until which the actor ignores damage (spawn protection). */
  invulnUntil: number;
  weaponName: string;
  feet(out: THREE.Vector3): THREE.Vector3;
  eye(out: THREE.Vector3): THREE.Vector3;
  yaw(): number;
  /** replicated aim direction (unit vector); the observer camera looks along it */
  aimDir?(out?: THREE.Vector3): THREE.Vector3;
  isCrouching(): boolean;
  /** what the observer camera needs to animate the first-person arms for this actor */
  obsState?(): ObsState;
  /** Character model root (charModel.getBoneHitboxes) when this actor has a visual; undefined = capsule fallback. */
  readonly visualRoot?: THREE.Object3D;
  /** Called by the damage system after hp was reduced (attacker may be null for fall damage). */
  onDamaged?(attacker: Actor | null, dealt: number, zone: HitZone): void;
  /**
   * 3PV flinch on a bullet hit: the weapon AI's DamageFrontLeftA / DamageBackA upper state
   * (charAnim.hurt -> playUpper, resolved per weapon folder). Absent on the local player, whose body is only ever
   * seen as the first-person viewmodel + shadow.
   */
  playHurt?(shotDir?: THREE.Vector3): void;
  /** the shot / blast that may kill it: death push of the ragdoll + clip direction (charModel.noteHit); absent on the local player */
  noteHit?(h: DeathHit): void;
  /** 3PV death clip (Stand_/Sit_Death<dir>); absent on the local player. */
  playDeath?(shotDir?: THREE.Vector3): void;
  /** Footsteps audible to bots (running, not crouched/shift-walking). */
  isNoisy?(): boolean;
  /** Equipped character itemId (RESPAWN 5138 chara pair): radio voice / model family lookup. Undefined = unknown. */
  readonly chara?: number;
}

export interface KillInfo {
  killer: Actor | null;
  victim: Actor;
  weapon: string;
  headshot: boolean;
  time: number;
  /** kills the victim had this life when it died (set by Match.registerKill; Chain Stopper when > 3) */
  victimStreak?: number;
}
