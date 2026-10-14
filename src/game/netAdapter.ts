import type { HitZone, Team } from "./types";

/*
 * Network seam for the battle loop (to be implemented on top of src/net/**).
 * The original server does not validate physics (client-authoritative), so:
 *  - each client sends its own PlayerState at ~20 Hz (game.ts calls sendState),
 *  - the shooter decides hits and sends HitEvent; the VICTIM's client applies the damage
 *    when it receives a HitEvent whose victimId === localId, then reports its own death
 *    via sendKill (so kill feed / score stay consistent everywhere).
 * In local mode (LocalNetAdapter) every actor is a local bot and nothing leaves the page.
 */

export type Vec3 = [number, number, number];

export interface PlayerState {
  id: string;
  name: string;
  team: Team;
  pos: Vec3; // feet position (metres, map space)
  vel: Vec3;
  yaw: number; // radians, three.js convention (forward = (-sin, 0, -cos))
  pitch: number;
  crouch: boolean;
  alive: boolean;
  hp: number;
  weapon: string;
  /** item id of the weapon in hand (weapons.json / ItemStatistics id; net: WeaponSync D weaponId), the source of truth
   *  for the remote's 3PV model + fire sound; `weapon` is its name (game.ts resolves it on receive) */
  weaponId?: number;
  /** equip slot in hand: 0 primary, 1 secondary, 2 melee, 3 throw, 4 special (net: ActionState weaponFlag = slot << 4,
   *  Server.Match WeaponSyncType; action bits 2-9, exe BuildCharaInfo_State +0x38) */
  weaponSlot?: number;
  firing: boolean;
  /**
   * Torso/upper-body action for 3PV animation selection (charAnim.ts). Optional: falls back to
   * "fire"/"idle" from `firing` when absent, so producers that don't set it yet (game.ts) still work.
   * Wire-packed into ActionState.action bits 10-13.
   */
  /** ready = grenade pin out, held until the release (WeaponSystem.isThrowReady) */
  torsoAction?: "idle" | "fire" | "reload" | "change" | "zoom" | "ready" | "plant" | "defuse";
  /** RMB silencer extension on (weapon.pef _Extension Silencer: MK23 / MP5K); wire: ActionState.action bit 9 */
  silencer?: boolean;
  /** Legs moving (walk or run). Optional: falls back to |vel|>threshold. Packed into action bit14. */
  moving?: boolean;
  /** Sprinting (run vs walk); ignored when `moving` is false. Packed into action bit15. */
  running?: boolean;
  /** Off the ground (jump / fall); the sender's own grounded flag. Absent = the receiver guesses from vel.y, which stairs
   *  fool (stair climb / descent looks like a jump). web extension: action bit 8. */
  airborne?: boolean;
  /** 8-way movement direction relative to yaw (0=fwd,1=fwd-right,...7=fwd-left). Falls back to vel/yaw. Packed into value low nibble. */
  moveDir?: number;
  /** I3CHR zoom type (0=none,2,3 per charAnim.ts _ZoomType). Packed into value high nibble. */
  zoomType?: number;
  /** this fire is a heavy knife attack (RMB); web extension: ActionState.value bit 7 while alive (old peers ignore it) */
  heavy?: boolean;
  /** equipped character itemId (net: RESPAWN 5138 of the slot); absent = the team default model */
  chara?: number;
  /** AI slot: simulated by the match host (net/battle.ts FLAG_BOT, action bit 5) and replicated like a player */
  bot?: boolean;
  t: number; // sender clock, ms
}

export interface HitEvent {
  attackerId: string;
  victimId: string;
  weapon: string;
  zone: HitZone;
  /** Base weapon damage (before zone/armor); victim applies computeDamage(). */
  baseDamage: number;
  /** true: baseDamage already has zone/falloff/helmet applied (src/weapons); victim only applies vest */
  preScaled?: boolean;
  helmetPenetrate: number;
  falloff: number;
  point: Vec3;
  t: number;
  /** Helmet blocked the hit (it pops off) — computed by attacker's client, trusted by victim's client */
  helmetBlocked?: boolean;
}

export interface KillEvent {
  killerId: string | null;
  victimId: string;
  weapon: string;
  headshot: boolean;
  t: number;
}

/** A weapon dropped (G or death) / picked up (gameplay/pbDrop.ts; wire: DropWeapon / GetWeaponForClient 19 B). */
export interface WeaponDropEvent {
  actorId: string;
  weaponId: number;
  slot: 0 | 1;
  ammo: number;
  extra: number;
  reserve: number;
  death: boolean;
  /** drop ring index (net: the server's DropCounter; pick-up: the drop taken) */
  idx: number;
  /** dropper feet + yaw at the drop (remote drops spawn there) */
  pos?: Vec3;
  yaw?: number;
}

/**
 * A thrown weapon (grenade / flash / smoke / C5) of one player (wire: SubHead.Grenade record, net/matchUdp.ts GrenadeSyncInfo).
 * "throw" spawns the replicated object (origin + velocity), "trigger" arms a planted C5, "explode" sets it off at `pos`.
 */
export interface ThrowEvent {
  actorId: string;
  /** throw net index (owner slot * 16 + seq % 16) */
  idx: number;
  state: "throw" | "trigger" | "explode";
  weaponId: number;
  pos: Vec3;
  vel: Vec3;
}

/** Position stream of a dropped weapon by its owner (wire: SubHead.DroppedWeapon record). */
export interface DroppedSyncEvent {
  actorId: string;
  idx: number;
  weaponId: number;
  slot: 0 | 1;
  death: boolean;
  ammo: number;
  extra: number;
  reserve: number;
  pos: Vec3;
  resting: boolean;
}

/** Radio message (gameplay/pbRadio.ts; wire: RadioChat 0x20 = id + area). */
export interface RadioEvent {
  actorId: string;
  id: number;
  area: number;
}

export interface NetAdapter {
  readonly mode: "local" | "net";
  readonly localId: string;
  sendState(s: PlayerState): void;
  sendHit(e: HitEvent): void;
  sendKill(e: KillEvent): void;
  onRemoteState(cb: (s: PlayerState) => void): () => void;
  onRemoteHit(cb: (e: HitEvent) => void): () => void;
  onRemoteKill(cb: (e: KillEvent) => void): () => void;
  onRemoteLeave(cb: (id: string) => void): () => void;
  /** Weapons for the next BATTLE_RESPAWN_REQ: [primary, secondary, melee, throw, special] (respawnSelect.ts). */
  setRespawnWeapons?(weapons: { itemId: number; objectId: number }[]): void;
  /** RoomWeaponsFlag of the room (weapon limit), when known. */
  readonly weaponsFlag?: number;
  /** StageOptions of the room (224 = Clube da Luta), when known. */
  readonly stage?: number;
  /** room observer rules byte (lobby/core/roomRules.ts); absent offline = the default rules */
  readonly watchRule?: number;
  /** Drop / pick-up / radio (net only; offline everything stays in game.ts). */
  sendDrop?(e: WeaponDropEvent): void;
  sendPickup?(e: WeaponDropEvent): void;
  sendRadio?(e: RadioEvent): void;
  /** a breakable map prop (mapProps index) broke here: tell the other players */
  sendPropBreak?(index: number): void;
  onRemotePropBreak?(cb: (index: number) => void): () => void;
  /** Destroy: our bullet hit an enemy objective (server object id); the host applies it and the 5167 bars come back to everyone */
  sendObjectiveHit?(objectId: number, damage: number, point: [number, number, number]): void;
  /** the same for a bot of ours (the host's AI slot `slot`): it rides that bot's record */
  sendBotObjectiveHit?(slot: number, objectId: number, damage: number, point: [number, number, number]): void;
  onRemoteDrop?(cb: (e: WeaponDropEvent) => void): () => void;
  onRemotePickup?(cb: (e: WeaponDropEvent) => void): () => void;
  onRemoteRadio?(cb: (e: RadioEvent) => void): () => void;
  /** Thrown weapons (net only): local throw / trigger / explosion out, the other players' in. */
  sendThrow?(e: ThrowEvent): void;
  onRemoteThrow?(cb: (e: ThrowEvent) => void): () => void;
  /** Dropped-weapon position stream (net only): our own drops out, the other players' in. */
  sendDropped?(e: DroppedSyncEvent): void;
  onRemoteDropped?(cb: (e: DroppedSyncEvent) => void): () => void;
  /**
   * AI slots (AI rooms online): the bots live in ONE client, the P2P match host, which sends them as slot records through its
   * own link; the others only render them (RemoteActor) and their hits on a bot reach the host as ordinary hits. A host
   * change moves the bots with it (onBotHost).
   */
  readonly isBotHost?: boolean;
  /** free slots for bots of these teams (parity = team), one per entry; fewer when the room has no free slot left */
  allocBotSlots?(teams: Team[]): number[];
  /** the bot slots this client simulates are the given ones from now on (host change: adopt) / none (released) */
  claimBots?(slots: number[]): void;
  releaseBots?(): void;
  /** the room seated a player on the slot of one of our bots: the game drops the bot (id = "slot<N>") */
  onBotYield?(cb: (id: string) => void): () => void;
  /** last replicated state of every bot slot seen (adoption after a host change) */
  botSnapshot?(): PlayerState[];
  /** the 25 Hz tick (or an event) of the bots is due */
  botSendDue?(): boolean;
  sendBotStates?(states: PlayerState[]): void;
  /** a bot of ours died: its dead state carries the killer mark every peer turns into the kill */
  sendBotKill?(e: KillEvent): void;
  /** this client became (true) / stopped being (false) the match host mid-battle */
  onBotHost?(cb: (host: boolean) => void): () => void;
  /** drop index range of the room counter (Server.Match MaxDropWpnCount; offline 31) */
  readonly dropMaxIndex?: number;
  dispose(): void;
}

/** Offline: bots only, all events stay local. */
export class LocalNetAdapter implements NetAdapter {
  readonly mode = "local" as const;
  readonly localId = "local";
  sendState(): void {}
  sendHit(): void {}
  sendKill(): void {}
  onRemoteState(): () => void { return () => {}; }
  onRemoteHit(): () => void { return () => {}; }
  onRemoteKill(): () => void { return () => {}; }
  onRemoteLeave(): () => void { return () => {}; }
  dispose(): void {}
}
