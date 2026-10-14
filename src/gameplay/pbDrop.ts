// Dropped weapons on the map, exe-2017 rules.
// Pure logic, no three.js: src/game/drops.ts draws the GLBs, src/game/game.ts wires input / death / net.
//
//  - Drop (G, ProcessDropWeapon 0xa21070): only usage slots 0 / 1 (WriteGameEvent_DropWeapon 0x9fb1c0 `slot <= 1`), the
//    rounds travel with it (loaded 0x615380, extra vf148, reserve 0x615470). Death drop: DeathHuman 0x57364e drops the
//    weapon in hand when its slot is < 2 (knife / grenade in hand: nothing).
//  - At most 32 on the map (GAMEINFO_DROPWEAPON ring, BuildCharaInfo_DropWeapon 0xaa3d50 `_nIdx < 32`); the drop index
//    comes from a room counter (0xa053c0 & 0x1f; Server.Match: DropCounter, wraps at MaxDropWpnCount).
//  - Pick-up (_ProcessDropedWeaponSearching 0xa11f40): automatic, no key. Every 0.25 s, only while alive and not a dino;
//    primary slot empty -> the first usage-0 drop in range, else secondary empty -> the first usage-1 drop; a drop must be
//    pickable (weapon +0xa3f9), have rounds (reserve > 0 || loaded > 0 || extra > 0; the secondary test skips `extra`) and
//    lie within 1 m of the character position (|chara.pos - weapon.pos| < 1, 3D).
//  - Lifetime (0x67b010): in respawn modes (stage type 1/3/5/7/8/12/13 via 0x687310 = DM, Destroy, Defense, Boss, Ace,
//    CrossCounter, Convoy; TDM is 1) the owner's copy stops being pickable at 10 s, fades 1 - (t - 10) and is removed at
//    11 s (the other clients: removed at 12 s, fade from 10 s); an EMPTY drop (no rounds) fades from 1 s and goes at 2 s
//    (others: 1.5 s / 3 s). Round modes (bomb, annihilation) keep drops until the round resets.
//  - Chara +0xb80 = 0.5 after a drop (ProcessDropWeapon 0x9815c0): [RECRIADO] read as the next-drop cooldown (the reader
//    of +0xb80 was not traced).

export const PB_DROP = {
  maxDrops: 32,
  /** Server.Match Settings.ini MaxDropWpnCount (the counter wraps to 0 after it) */
  serverMaxIndex: 25,
  searchInterval: 0.25,
  pickupRadius: 1,
  life: 10,
  fade: 1,
  removeAtRemote: 12,
  emptyLife: 1,
  emptyFade: 1,
  emptyRemoveAtRemote: 3,
  dropCooldown: 0.5,
  /** STAGE_MODE values whose drops expire (0x687310); RoomCondition >> 2 on the server */
  timedStageModes: [1, 3, 5, 7, 8, 12, 13] as readonly number[],
} as const;

export type Vec3 = { x: number; y: number; z: number };

export interface DroppedWeapon {
  /** ring / wire index (0..31) */
  idx: number;
  weaponId: number;
  /** usage slot 0 primary, 1 secondary */
  slot: 0 | 1;
  ammo: number;
  /** extra rounds (dual magazine / extension, vf148); 0 for most weapons */
  extra: number;
  reserve: number;
  pos: Vec3;
  /** dropper id (web actor id) */
  owner: string;
  /** drop happened on this client (owner copy timings) */
  local: boolean;
  death: boolean;
  /** seconds on the map */
  t: number;
  pickable: boolean;
  /** 1 opaque .. 0 gone (vf174 alpha) */
  alpha: number;
}

export const hasRounds = (d: Pick<DroppedWeapon, "ammo" | "extra" | "reserve">) => d.reserve > 0 || d.ammo > 0 || d.extra > 0;

/** Lifetime step (0x67b010). Returns true when the drop must be removed. */
export function stepDrop(d: DroppedWeapon, dt: number, timedMode = true): boolean {
  d.t += dt;
  const P = PB_DROP;
  // alpha = 1 - (t - start) * 1 (vf174), the same 1 s fade on every client; only the removal time differs
  if (!hasRounds(d)) {
    const from = d.local ? P.emptyLife : P.emptyRemoveAtRemote / 2;
    const end = d.local ? P.emptyLife + P.emptyFade : P.emptyRemoveAtRemote;
    if (d.t > from) d.alpha = Math.max(0, 1 - (d.t - from) / P.emptyFade);
    return d.t > end;
  }
  if (!timedMode) return false;
  const end = d.local ? P.life + P.fade : P.removeAtRemote;
  if (d.t > P.life) {
    d.pickable = false;
    d.alpha = Math.max(0, 1 - (d.t - P.life) / P.fade);
  }
  return d.t > end;
}

/**
 * The drop the character picks up now, or null (_ProcessDropedWeaponSearching 0xa11f40). `emptySlot(0|1)` = the
 * player's usage slot is free. The primary is searched first; only when the primary slot is taken is the secondary tried.
 */
export function findPickup(drops: Iterable<DroppedWeapon>, pos: Vec3, emptySlot: (s: 0 | 1) => boolean): DroppedWeapon | null {
  const list = [...drops];
  const r2 = PB_DROP.pickupRadius * PB_DROP.pickupRadius;
  const near = (d: DroppedWeapon) => {
    const dx = d.pos.x - pos.x, dy = d.pos.y - pos.y, dz = d.pos.z - pos.z;
    return dx * dx + dy * dy + dz * dz < r2;
  };
  if (emptySlot(0)) return list.find((d) => d.pickable && d.slot === 0 && hasRounds(d) && near(d)) ?? null;
  if (emptySlot(1)) return list.find((d) => d.pickable && d.slot === 1 && (d.reserve > 0 || d.ammo > 0) && near(d)) ?? null;
  return null;
}

/**
 * The drops on the map (a 32-entry ring like GAMEINFO_DROPWEAPON). Offline the index is local; online the room counter
 * (Server.Match DropCounter) numbers them: `nextIndex` predicts the index of our own next drop (the server does not echo
 * it back), `seen` follows the counter from the remote drops.
 */
export class DropField {
  readonly drops = new Map<number, DroppedWeapon>();
  private counter = 0;
  private searchT = 0;
  private cooldown = 0;
  private maxIndex: number;
  timedMode: boolean;
  // no parameter properties: src/net (node --test, strip-only TS) imports this file
  constructor(maxIndex: number = PB_DROP.maxDrops - 1, timedMode = true) {
    this.maxIndex = maxIndex;
    this.timedMode = timedMode;
  }

  /** index of the next local drop: counter + 1, wrapping like Server.Match (> max -> 0) */
  nextIndex(): number {
    this.counter = this.counter + 1 > this.maxIndex ? 0 : this.counter + 1;
    return this.counter;
  }
  seen(idx: number): void {
    this.counter = idx;
  }

  canDrop(): boolean {
    return this.cooldown <= 0;
  }

  add(d: Omit<DroppedWeapon, "t" | "pickable" | "alpha" | "idx"> & { idx?: number }): DroppedWeapon {
    const idx = d.idx ?? this.nextIndex();
    if (d.idx !== undefined && !d.local) this.seen(idx);
    if (d.local) this.cooldown = PB_DROP.dropCooldown;
    const w: DroppedWeapon = { ...d, idx, t: 0, pickable: true, alpha: 1 };
    this.drops.set(idx, w); // a reused ring slot replaces the old weapon
    return w;
  }

  remove(idx: number): DroppedWeapon | null {
    const d = this.drops.get(idx) ?? null;
    this.drops.delete(idx);
    return d;
  }

  /** Advances lifetimes and the pick-up search timer. Returns the removed drops and whether a search is due. */
  update(dt: number): { removed: DroppedWeapon[]; search: boolean } {
    this.cooldown = Math.max(0, this.cooldown - dt);
    const removed: DroppedWeapon[] = [];
    for (const d of this.drops.values()) if (stepDrop(d, dt, this.timedMode)) removed.push(d);
    for (const d of removed) this.drops.delete(d.idx);
    // 0xa11f40: timer (0xa12230) + dt > 0.25 -> reset to 0 (0xa12250) and search
    this.searchT += dt;
    const search = this.searchT > PB_DROP.searchInterval;
    if (search) this.searchT = 0;
    return { removed, search };
  }

  clear(): void {
    this.drops.clear();
  }
}

// ---- wire (Server.Match DropWeapon / GetWeaponForClient, 19 bytes, MatchClient.cs 715-754) ------------------------

/**
 * Flags byte, 2017 layout (BuildCharaInfo_DropWeapon 0xaa3d50): bits 6-7 state (2 = drop, bit 6 set = death drop),
 * bit 5 usage slot, bits 0-4 index. Server.Match adds its DropCounter to the byte it relays, so a sender writes index 0.
 */
export function dropFlags(slot: 0 | 1, death: boolean, idx = 0): number {
  return ((2 | (death ? 1 : 0)) << 6 | (slot & 1) << 5 | (idx & 0x1f)) & 0xff;
}
export function parseDropFlags(f: number): { slot: 0 | 1; death: boolean; idx: number } {
  return { slot: ((f >> 5) & 1) as 0 | 1, death: ((f >> 6) & 1) === 1, idx: f & 0x1f };
}
