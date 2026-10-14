// NetAdapter (src/game/netAdapter.ts) on top of the PB Match UDP link (matchUdpLink.ts).
//
// Mapping PlayerState <-> PB action events (Server.Match relays them after re-encoding, see
//:
//   pos/yaw/pitch -> PosRotation (Half3 position, u16 angles)      every sendState (throttled 25 Hz)
//   hp            -> HpSync                                         every sendState
//   posture/torso/move/zoom -> ActionState (action u16, value u8, weaponFlag u8), packed in the SAME
//                    bit layout the 2017 client uses (decoded from PointBlank.exe,
//                    UDP_UTIL::BuildCharaInfo_State @0x9b7580 — was previously a "web convention" of
//                    ad hoc bits 0x0001/0x0002 that the real client neither writes nor understands):
//                      action bits 0-1  : posture   (0 stand, 1 crouch; 2-3 reserved)
//                      action bits 2-9  : weaponSlot (equip slot in hand, exe netdata +0x38)
//                      action bit 8    : airborne (jump / fall; web extension: the receiver has no velocity on the wire and vel.y from
//                                         position deltas reads stairs as jumps)
//                      action bit 9    : silencer extension on (weapon slots only use bits 2-4; web extension, not in the original wire)
//                      action bits 10-13: torsoAction (0 idle,1 fire,2 reload,3 change,4 zoom,5 ready = grenade pin out;
//                                         5 is ours [INFERIDO]: the exe's own value for the FireReady upper state is not decoded)
//                      action bit 14    : moving (walk or run)
//                      action bit 15    : running (only meaningful if moving)
//                      value  bits 0-3  : moveDir (8-way, relative to yaw)
//                      value  bits 4-6  : zoomType (I3CHR _ZoomType, 0/2/3)
//                      value  bit 7     : heavy knife attack in the torso "fire" (web extension; old peers read it as a zoomType > 3: ignored)
//                    While dead, value/weaponFlag are repurposed for the kill marker (see below) —
//                    matches the real client, which has no use for movement/torso state on a corpse.
//   weaponSlot    -> ActionState.weaponFlag = slot << 4 (Server.Match WeaponSyncType: Primary 0, Secondary 16, Melee 32,
//                    Explosive 48, Special 64; the .NET server answers with its own WeaponSync record built from the
//                    RESPAWN loadout, EVENTS_ACTION type 6) — used by the receiver only until the sender's own WeaponSync arrives
//   weaponId      -> WeaponSync (D itemId, the weapons.json / ItemStatistics id; sent on change and every 1 s)
//   ThrowEvent    -> SubHead.Grenade record (net index = owner*16 + seq): throw (origin + velocity), C5 trigger, explosion
//   DroppedSyncEvent -> SubHead.DroppedWeapon record (drop index): the owner's position stream of its dropped weapon
//   HitEvent      -> HitData (victim slot, damage = baseDamage*falloff, part HEAD/ALL/limb) with
//                    ObjectType.UserObject: Server.Match relays it untouched and applies NO damage,
//                    so the victim's computeDamage stays authoritative (no server-derived deaths).
//   WeaponDropEvent -> DropWeapon 0x400000 / GetWeaponForClient 0x1000000 (19 B, Server.Match relays them and bumps
//                    its DropCounter into the drop flags; never in the same record as WeaponSync, AllUtils.CheckDataFlags)
//   RadioEvent    -> RadioChat 0x20 (id, area), relayed to every slot; the receiver filters by team (pbRadio.ts)
//   KillEvent     -> victim (sendKill) marks its states with ActionState.value = killer+1 (|0x80 if
//                    headshot) while dead; the KILLER's client sees it and sends BATTLE_DEATH_REQ
//                    over TCP (the server only accepts kills reported by the killer). The Game server
//                    broadcasts BATTLE_DEATH_ACK (score, kill goal) -> onRemoteKill everywhere except
//                    on the victim, who already knows. Local alive-again -> BATTLE_RESPAWN_REQ.
// Remote states are buffered and exposed interpolated (INTERP_DELAY_MS behind) via onRemoteState,
// fired from an internal 60 Hz ticker, so game code can just set actor transforms.
// Transport: the match is hosted in the room leader's tab; the datagrams are the
// Server.Match ones.
import type { DroppedSyncEvent, HitEvent, KillEvent, NetAdapter, PlayerState, RadioEvent, ThrowEvent, Vec3, WeaponDropEvent } from "../game/netAdapter";
import { PB_DROP, dropFlags, parseDropFlags } from "../gameplay/pbDrop.ts";
import type { HitZone, Team } from "../game/types";
import { MatchLink, type MatchSession } from "./matchUdpLink.ts";
import { Ev, GrenadeState, type ActionIn, type ActionOut, type WeaponDropInfo } from "./matchUdp.ts";
import type { RoomClient } from "./roomClient.ts";
import type { P2PHandle, P2POptions } from "../p2p/session.ts";
import type { HandoffEnvelope } from "../p2p/handoff.ts";
import { itemName } from "../lobby/state/itemNames.ts";
import { botNameOfSlot } from "../game/botNames.ts";
import { jsonOnce } from "../jsonOnce.ts";

/** min time the victim keeps sending its dead state (hp 0 + kill mark): ~6 packets at 50 ms, survives UDP loss */
const DEATH_HOLD_MS = 300;

/** PB item ids for the web weapon names (ItemsStatistic ids). Unknown names -> 0. */
export const WEAPON_IDS: Record<string, number> = {
  "K-2": 100003001,
  "SG-550": 100003004,
  "MP5K": 200004006,
  "K-5": 601002003,
  "M-7": 702001001,
};
// Killfeed name lookup: WEAPON_IDS above only covers the net-protocol default loadout, not the
// full 743-weapon 2017 shop — fetch the same
// weapons.json PbHud uses so any equippable weapon resolves to its real name instead of raw id.
let weaponNamesById: Map<number, string> | null = null;
let weaponIdsByName: Map<string, number> | null = null;
function loadWeaponNames(): void {
  if (weaponNamesById || typeof fetch !== "function") return;
  weaponNamesById = new Map();
  weaponIdsByName = new Map();
  jsonOnce<{ weapons?: { id: number; name: string }[] }>("/assets/cross/weapons/weapons.json")
    .then((data) => {
      for (const w of data.weapons ?? []) {
        weaponNamesById!.set(w.id, w.name);
        if (!weaponIdsByName!.has(w.name)) weaponIdsByName!.set(w.name, w.id);
      }
    })
    .catch(() => {});
}
/** item id of a hit / kill weapon name (a projectile's name must not fall back to the weapon in hand: a grenade kill
 *  with the knife out would show the knife). WEAPON_IDS first, then weapons.json, then a numeric id as text; 0 = unknown */
export function weaponIdOfName(name: string): number {
  loadWeaponNames();
  return WEAPON_IDS[name] ?? weaponIdsByName?.get(name) ?? (/^\d+$/.test(name) ? Number(name) : 0);
}
/** weaponId of a HitEvent: the hit's own weapon (grenade, C5, the weapon that broke an exploding barrel), else the weapon in hand */
export function hitWeaponId(name: string, inHand: number): number {
  return weaponIdOfName(name) || Math.max(0, inHand);
}
/** weapons.json name, else the item's client / server name (weapons of the 2017 shop missing from weapons.json), else
 *  the id as text (PbHud.addKill still finds the kill icon of a numeric id) */
const weaponName = (id: number) => {
  loadWeaponNames();
  const known = weaponNamesById?.get(id) ?? Object.keys(WEAPON_IDS).find((k) => WEAPON_IDS[k] === id);
  if (known) return known;
  const n = itemName(id);
  return n.source !== "none" ? n.name : String(id);
};

/** 8-way move direction relative to facing (0=fwd, 2=right, 4=back, 6=left), for remoteActor leg anim. */
function moveDirFromVel(vel: [number, number, number], yaw: number): number {
  if (Math.hypot(vel[0], vel[2]) < 1e-3) return 0;
  const worldAngle = Math.atan2(-vel[0], -vel[2]); // three.js forward = (-sin(yaw), 0, -cos(yaw))
  const rel = worldAngle - yaw;
  // yaw grows counter-clockwise, so a move to the RIGHT is a negative rel: index = -rel in 45 degree steps
  const norm = (((-rel) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return Math.round(norm / (Math.PI / 4)) % 8;
}

export interface RosterEntry {
  slot: number;
  name: string;
  team: Team;
}

export interface BattleNetOptions {
  session: MatchSession;
  roster: RosterEntry[];
  serverUrl?: string;
  sendHz?: number; // default 25
  interpDelayMs?: number; // default 100
  /** TCP room session: enables kill reporting (DEATH_REQ/ACK) and auto RESPAWN_REQ. */
  room?: RoomClient;
  /** P2P extras (tests: RTCPeerConnection implementation, Worker factory, leader flag, match data) */
  p2p?: Partial<P2POptions>;
}

const POSTURE_MASK = 0x0003;
const WEAPON_SLOT_SHIFT = 2;
/** WeaponSync resend period: a lost datagram (UDP) or a late joiner still gets the weapon in hand */
const WEAPON_RESEND_MS = 1000;
const THROW_STATE = { throw: GrenadeState.Fly, trigger: GrenadeState.Trigger, explode: GrenadeState.Explode } as const;
const THROW_NAME = (st: number): ThrowEvent["state"] | null =>
  st === GrenadeState.Fly ? "throw" : st === GrenadeState.Trigger ? "trigger" : st === GrenadeState.Explode ? "explode" : null;
const POSTURE_CROUCH = 1;
const TORSO_SHIFT = 10;
const TORSO_MASK = 0x0f;
// plant = 6: C4 install hold, defuse = 7: defuse hold (web extension: observer view + the hold sound for the others, not in the original wire)
const TORSO_IDS = { idle: 0, fire: 1, reload: 2, change: 3, zoom: 4, ready: 5, plant: 6, defuse: 7 } as const;
const TORSO_NAMES: (keyof typeof TORSO_IDS)[] = ["idle", "fire", "reload", "change", "zoom", "ready", "plant", "defuse"];
/** web extension: ActionState.value bit 7 while alive = the knife attack in this "fire" is the heavy one (zoomType only uses bits 4-6: 0/2/3) */
const VALUE_HEAVY = 0x80;
const FLAG_AIRBORNE = 0x0100; // web extension (slots only use bits 2-4): the sender is off the ground
const FLAG_SILENCER = 0x0200;
const FLAG_MOVING = 0x4000;
const FLAG_RUNNING = 0x8000;
/** web extension (slots only use bits 2-4): this record is an AI slot simulated by the match host. Every peer learns "this slot is
 *  a bot" from it (no registry on the wire): kills involving a bot come from the dead-state mark, not from Server.Game's DEATH_ACK. */
const FLAG_BOT = 0x0020;
/** kill mark (ActionState.value & 0x7f) of a death with no killer slot (fall, world): killer slot 126 can never be a player */
const MARK_NO_KILLER = 0x7f;
/** AI records per datagram (the core relays <= 18 records a datagram; also keeps one under any WebRTC message limit) */
const BOT_RECORDS_PER_DATAGRAM = 6;
/** an AI slot silent this long is gone (the host died and nobody adopted the bots yet / they were released) */
const BOT_SILENT_MS = 8000;
const OBJECT_USER_OBJECT = 2;
const OBJECT_OBJECT = 3;
/** a prop break rides a HitData of ObjectType.Object whose objectId is PROP_ID_BASE + mapProps index: far above the
 *  MapStructure.xml object ids (< 200), so matchCore's room.getObject() finds nothing and leaves it alone (relayed as is) */
const PROP_ID_BASE = 0x8000;
const PART_HEAD = 14;
const ZONE_PART: Record<HitZone, number> = { head: PART_HEAD, torso: 1, limb: 2 };
const PART_ZONE_MASK = 0x1f;
/** HitData.part only ever carries 1/2/14 (web zones) here, so this unused bit rides along for HELMET PROTECTION:
 *  Server.Match relays HitData (ObjectType.UserObject) untouched, so every peer decodes the same popHelmet trigger. */
const PART_HELMET_BIT = 0x20;
const PART_ZONE = (p: number): HitZone => (p === PART_HEAD ? "head" : p === 2 ? "limb" : "torso");
/** HitEvent.zone/helmetBlocked <-> HitData.part (see PART_HELMET_BIT above). */
export const encodeHitPart = (zone: HitZone, helmetBlocked: boolean): number => ZONE_PART[zone] | (helmetBlocked ? PART_HELMET_BIT : 0);
export const decodeHitPart = (part: number): { zone: HitZone; helmetBlocked: boolean } =>
  ({ zone: PART_ZONE(part & PART_ZONE_MASK), helmetBlocked: (part & PART_HELMET_BIT) !== 0 });

/** PlayerState -> the events every state packet carries (ActionState + PosRotation + HpSync); `mark` = the dead-state kill marker */
function packState(s: PlayerState, mark: number, bot: boolean): ActionOut {
  const speed = Math.hypot(s.vel[0], s.vel[2]);
  const moving = s.moving ?? speed > 0.15;
  const running = s.running ?? speed > 3.5;
  const torso = TORSO_IDS[s.torsoAction ?? (s.firing ? "fire" : "idle")];
  const wslot = Math.max(0, Math.min(5, s.weaponSlot ?? 0));
  const action =
    (s.crouch ? POSTURE_CROUCH : 0) |
    ((wslot & 7) << WEAPON_SLOT_SHIFT) |
    (bot ? FLAG_BOT : 0) |
    (s.silencer ? FLAG_SILENCER : 0) |
    (s.airborne ? FLAG_AIRBORNE : 0) |
    ((torso & TORSO_MASK) << TORSO_SHIFT) |
    (moving ? FLAG_MOVING : 0) |
    (moving && running ? FLAG_RUNNING : 0);
  const moveDir = s.moveDir ?? moveDirFromVel(s.vel, s.yaw);
  const value = mark || ((moveDir & 0x0f) | ((s.zoomType ?? 0) & 0x07) << 4 | (s.heavy ? VALUE_HEAVY : 0));
  return {
    actionState: { action, value, weaponFlag: s.alive ? wslot << 4 : 0 },
    posRot: { x: s.pos[0], y: s.pos[1], z: s.pos[2], yaw: s.yaw, pitch: s.pitch, area: 0 },
    hp: Math.max(0, Math.round(s.alive ? s.hp : 0)),
  };
}

/** HitEvents -> HitData records (the hit's own weapon, else the one in hand) */
function toHitInfos(hits: HitEvent[], inHand: number) {
  return hits.map((h) => ({
    start: h.point, end: h.point,
    victimSlot: idSlot(h.victimId),
    damage: Math.max(1, Math.min(2047, Math.round(h.baseDamage * (h.falloff || 1)))),
    part: encodeHitPart(h.zone, !!h.helmetBlocked),
    objectType: OBJECT_USER_OBJECT,
    weaponId: hitWeaponId(h.weapon, inHand),
  })).filter((h) => h.victimSlot >= 0);
}

interface Snapshot { at: number; s: PlayerState }

export const slotId = (slot: number) => `slot${slot}`;
export const idSlot = (id: string) => (/^slot(\d+)$/.exec(id) ? Number(id.slice(4)) : -1);

export class PbBattleNet implements NetAdapter {
  readonly mode = "net" as const;
  readonly localId: string;
  readonly link: MatchLink;

  private roster = new Map<number, RosterEntry>();
  private buffers = new Map<number, Snapshot[]>();
  private lastSeen = new Map<number, number>();
  private stateCbs = new Set<(s: PlayerState) => void>();
  private hitCbs = new Set<(e: HitEvent) => void>();
  private killCbs = new Set<(e: KillEvent) => void>();
  private leaveCbs = new Set<(id: string) => void>();
  private pendingHits: HitEvent[] = [];
  private pendingDrops: WeaponDropEvent[] = [];
  private pendingPickups: WeaponDropEvent[] = [];
  private pendingRadio: RadioEvent[] = [];
  private pendingPropBreaks: number[] = [];
  /** Destroy: a hit on an enemy objective (server MapStructure object id, damage); rides a HitData of ObjectType.Object */
  private pendingObjectiveHits: { objectId: number; damage: number; point: Vec3 }[] = [];
  private propBreakCbs = new Set<(index: number) => void>();
  private pendingThrows: ThrowEvent[] = [];
  /** latest position per own drop index (coalesced between two sends) */
  private pendingDropped = new Map<number, DroppedSyncEvent>();
  private throwCbs = new Set<(e: ThrowEvent) => void>();
  private droppedCbs = new Set<(e: DroppedSyncEvent) => void>();
  /** weapon in hand per remote slot: from its own WeaponSync (authoritative) / from the server's loadout record */
  private clientWeapon = new Map<number, number>();
  private serverWeapon = new Map<number, number>();
  /** primary weapon of the slot's loadout (RESPAWN 5138 / USER_EQUIPMENT 3667): what a player who joined a running round (the observer)
   * shows until a WeaponSync arrives, instead of the model's default weapon */
  private loadoutWeapon = new Map<number, number>();
  private dropCbs = new Set<(e: WeaponDropEvent) => void>();
  private pickupCbs = new Set<(e: WeaponDropEvent) => void>();
  private radioCbs = new Set<(e: RadioEvent) => void>();
  readonly dropMaxIndex = PB_DROP.serverMaxIndex;
  private lastSend = 0;
  private lastWeapon = "";
  /** victim slot -> weaponId of our last hit on it (the kill feed icon of the kill that follows) */
  private lastHitWeapon = new Map<number, number>();
  private lastWeaponId = -1;
  private lastWeaponAt = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private sendIntervalMs: number;
  private interpDelayMs: number;
  private room: RoomClient | null;
  /** puts back the room hooks this battle wrapped (RoomClient outlives the match) */
  private restoreRoomHooks: (() => void) | null = null;
  private deathMark: { killerSlot: number; headshot: boolean } | null = null;
  private wasAlive = true;
  private lastState: PlayerState | null = null;
  private deathHold: { until: number; pos: Vec3 } | null = null;
  private reportedVictims = new Set<number>();
  /** 18 equip pairs for BATTLE_RESPAWN_REQ (weapons from the respawn weapon change); null = legacy zero body. */
  private respawnEquip: { itemId: number; objectId: number }[] | null = null;
  /** equipped character per slot from RESPAWN 5138 (PlayerState.chara) */
  private charas = new Map<number, number>();
  private equipAskAt = 0;
  private readonly p2pOpts: Partial<P2POptions>;
  /** the leader's host (Worker + WebRTC) or the guest's link */
  p2p: P2PHandle | null = null;
  /** room leader slot the P2P link was opened to (the host); a link that dies while it is still the leader is a stall */
  private hostSlot = -1;
  private failingOver = false;
  private disposed = false;

  // ---- AI slots (AI rooms): the bots live in ONE client, the P2P match host, and travel as ordinary slot records
  /** AI slots this client simulates (it is the match host) */
  private ownBots = new Set<number>();
  /** every AI slot known: ours + the ones whose records carry FLAG_BOT */
  private botSlots = new Set<number>();
  /** hits of our bots waiting for their next record (the record slot is the attacker) */
  private botHits = new Map<number, HitEvent[]>();
  /** objective hits of our bots (Destroy), the same records as botHits */
  private botObjHits = new Map<number, { objectId: number; damage: number; point: Vec3 }[]>();
  /** killer of our dead bots: the mark their dead-state records carry */
  private botDeath = new Map<number, { killer: number; headshot: boolean }>();
  private botWeaponAt = new Map<number, { id: number; at: number }>();
  private botLastSend = 0;
  private botDirty = false;
  /** last state per AI slot (sent by us / received): what a new host starts its bots from */
  private botSnap = new Map<number, PlayerState>();
  /** AI deaths already turned into a kill (cleared when the slot is alive again) */
  private reportedBots = new Set<number>();
  /** last hit per victim slot (any attacker): the weapon of the kill an AI mark announces */
  private lastHitBy = new Map<number, { by: number; weaponId: number }>();
  private botHostCbs = new Set<(host: boolean) => void>();
  private botYieldCbs = new Set<(id: string) => void>();
  private wasBotHost = false;

  constructor(opts: BattleNetOptions) {
    this.p2pOpts = opts.p2p ?? {};
    this.link = new MatchLink(opts.session, opts.serverUrl);
    this.localId = slotId(opts.session.slot);
    // the first kill of the match must already find the weapon's name (the fetch used to start on that kill)
    loadWeaponNames();
    for (const r of opts.roster) this.roster.set(r.slot, r);
    this.sendIntervalMs = 1000 / (opts.sendHz ?? 25);
    this.interpDelayMs = opts.interpDelayMs ?? 100;
    this.link.onActions = (actions) => this.onActions(actions);
    this.room = opts.room ?? null;
    if (this.room) {
      const room = this.room;
      let live = true; // a wrapper left linked under a later layer (Game's watchRespawnEquip, once per room) only passes through once disposed
      const prev = room.onDeath;
      const onDeath: NonNullable<RoomClient["onDeath"]> = (d) => {
        prev?.(d);
        if (!live) return;
        for (const v of d.victims) {
          if (slotId(v.slot) === this.localId) continue;
          this.emitKill({ killerId: slotId(d.killerSlot), victimId: slotId(v.slot), weapon: weaponName(d.weaponId), headshot: v.headshot, t: Date.now() });
        }
      };
      room.onDeath = onDeath;
      const prevAck = room.onRespawnAck;
      const onRespawnAck: NonNullable<RoomClient["onRespawnAck"]> = (a) => {
        prevAck?.(a);
        if (!live) return;
        if (a.chara) this.charas.set(a.slot, a.chara);
        console.info(`[net] equip slot ${a.slot}: chara ${a.chara}, primary ${a.weapons?.primary}`);
        const w = a.weapons?.primary || a.weapons?.secondary || a.weapons?.melee;
        if (w) this.loadoutWeapon.set(a.slot, w);
      };
      room.onRespawnAck = onRespawnAck;
      // only put back what is still ours: a layer chained on top of these keeps its own link
      this.restoreRoomHooks = () => {
        live = false;
        if (room.onDeath === onDeath) room.onDeath = prev;
        if (room.onRespawnAck === onRespawnAck) room.onRespawnAck = prevAck;
      };
    }
  }

  /** Registers on Server.Match (opcode 65 -> 66) and starts the interpolation ticker. */
  async connect(): Promise<void> {
    const { openP2P } = await import("../p2p/session.ts"); // its own chunk, loaded when a battle starts
    this.p2p = await openP2P({
      session: this.link.session, serverUrl: this.link.serverUrl, room: this.room,
      bridge: { reportKill: (v, w, hs, kp, vp) => this.reportKillOnce(v, w, hs, kp, vp) },
      ...this.p2pOpts,
    });
    const t = this.p2p.transport;
    this.link.transport = () => t;
    this.hostSlot = this.room?.leaderSlot ?? -1;
    const prevClose = this.link.onClose;
    this.link.onClose = (why) => { prevClose?.(why); this.onLinkClosed(why); };
    await this.link.open();
    this.wasBotHost = this.isBotHost; // the game reads isBotHost when it starts; only a later change is announced
    this.ticker = setInterval(() => this.tick(), 1000 / 60);
  }

  // ------------------------------------------------------------------ AI slots

  /** The match host runs the room's AI (the leader's tab, or whoever took over); guests only render it. */
  get isBotHost(): boolean {
    return !!this.p2p?.host;
  }

  onBotHost(cb: (host: boolean) => void): () => void { this.botHostCbs.add(cb); return () => this.botHostCbs.delete(cb); }

  /** A seat of ours (a bot) was taken by a player: the game drops that bot. */
  onBotYield(cb: (id: string) => void): () => void { this.botYieldCbs.add(cb); return () => this.botYieldCbs.delete(cb); }

  /** The server seats a player on a slot a bot holds (a bot never leaves a room slot empty, the server does not know it: a player
   *  who joins or comes back later takes the lowest empty seat, which can be one of the bots'). The room slot list is the truth:
   *  the player wins, the bot goes, or the player would sit behind a bot of the same id for the match host (invisible, unhittable). */
  private yieldBotSeats(): void {
    for (const slot of this.ownBots) {
      const seat = this.room?.slots[slot];
      if (!seat?.nick || seat.state < SLOT_LOAD) continue;
      this.ownBots.delete(slot);
      this.botSlots.delete(slot);
      for (const m of [this.botSnap, this.botHits, this.botObjHits, this.botDeath, this.botWeaponAt, this.buffers, this.lastSeen]) m.delete(slot);
      this.reportedBots.delete(slot);
      console.warn(`[bots] slot ${slot} is taken by ${seat.nick}: the bot leaves`);
      for (const cb of this.botYieldCbs) cb(slotId(slot));
    }
  }

  private notifyBotHost(): void {
    const host = this.isBotHost;
    if (host === this.wasBotHost) return;
    this.wasBotHost = host;
    if (!host) this.releaseBots();
    for (const cb of this.botHostCbs) cb(host);
  }

  /** Free slots for bots of these teams (slot parity = team, the same rule every peer reads a roster team by): top-down from 15, so
   *  a player joining later still finds a low seat; 16 / 17 stay clear (the observer seats). Fewer slots than asked when none is left. */
  allocBotSlots(teams: Team[]): number[] {
    const taken = new Set<number>([this.link.session.slot, ...this.roster.keys(), ...this.botSlots]);
    this.room?.slots.forEach((s, i) => { if (s?.nick) taken.add(i); });
    const out: number[] = [];
    for (const team of teams) {
      let slot = -1;
      for (let k = 15; k >= 0; k--) if (k % 2 === team && !taken.has(k)) { slot = k; break; }
      if (slot < 0) continue; // this team's seats are full; the other team may still have one
      taken.add(slot);
      out.push(slot);
    }
    this.claimBots(out);
    return out;
  }

  /** These AI slots are simulated here from now on (first allocation, or the host change adopting the old host's bots). */
  claimBots(slots: number[]): void {
    for (const slot of slots) {
      this.ownBots.add(slot);
      this.botSlots.add(slot);
      this.buffers.delete(slot); // no more interpolated states of a remote copy
      this.lastSeen.delete(slot);
    }
  }

  /** The host role is gone: the bots here stop (their next states come from the new host). */
  releaseBots(): void {
    this.ownBots.clear();
    this.botHits.clear();
    this.botObjHits.clear();
    this.botDeath.clear();
  }

  /** Last known state of every AI slot (own or received), for a new host to start its bots from. */
  botSnapshot(): PlayerState[] {
    return [...this.botSnap.values()];
  }

  botSendDue(): boolean {
    return this.ownBots.size > 0 && (this.botDirty || Date.now() - this.botLastSend >= this.sendIntervalMs);
  }

  /** One record per bot (same ActionState / PosRotation / HpSync / WeaponSync / HitData as a player), batched per datagram. */
  sendBotStates(states: PlayerState[]): void {
    const now = Date.now();
    this.botLastSend = now;
    this.botDirty = false;
    const recs: { slot: number; a: ActionOut }[] = [];
    for (const s of states) {
      const slot = idSlot(s.id);
      if (slot < 0 || !this.ownBots.has(slot)) continue;
      let mark = 0;
      if (s.alive) this.botDeath.delete(slot);
      else {
        const d = this.botDeath.get(slot);
        if (d) mark = ((d.killer + 1) & 0x7f) | (d.headshot ? 0x80 : 0);
      }
      const a = packState(s, mark, true);
      const weaponId = s.weaponId ?? WEAPON_IDS[s.weapon] ?? 0;
      const last = this.botWeaponAt.get(slot);
      if (weaponId && (!last || last.id !== weaponId || now - last.at >= WEAPON_RESEND_MS)) {
        this.botWeaponAt.set(slot, { id: weaponId, at: now });
        a.weapon = { weaponId };
      }
      const hits = this.botHits.get(slot);
      if (hits?.length) {
        a.hits = toHitInfos(hits.splice(0), weaponId);
        for (const h of a.hits) this.lastHitBy.set(h.victimSlot, { by: slot, weaponId: h.weaponId });
      }
      const objs = this.botObjHits.get(slot);
      if (objs?.length) {
        a.hits = [...(a.hits ?? []), ...objs.splice(0, 16).map((h) => ({
          start: h.point, end: h.point, victimSlot: h.objectId, damage: h.damage, part: 1, objectType: OBJECT_OBJECT, weaponId,
        }))];
      }
      this.botSnap.set(slot, { ...s, bot: true });
      recs.push({ slot, a });
    }
    for (let i = 0; i < recs.length; i += BOT_RECORDS_PER_DATAGRAM) this.link.sendRecords(recs.slice(i, i + BOT_RECORDS_PER_DATAGRAM));
  }

  /** A bot of ours died: its dead-state records carry the killer (and the headshot bit) like a player's death mark, and every
   *  peer turns that into the kill (no DEATH_REQ: Server.Game only takes the killer's own report and knows no AI slot). */
  sendBotKill(e: KillEvent): void {
    const victim = idSlot(e.victimId);
    if (!this.ownBots.has(victim)) return;
    const killer = e.killerId ? idSlot(e.killerId) : -1;
    this.botDeath.set(victim, { killer: killer >= 0 ? killer : MARK_NO_KILLER - 1, headshot: e.headshot });
    this.botDirty = true;
  }

  /** The P2P link died with the battle still running (host tab frozen / closed / crashed): "troca de host". The server
   * hands the room to a new leader when the old one drops; that leader hosts a fresh match core (last RESPAWN_ACK of
   * every slot replayed, src/host/bridge.ts replay), the others reconnect to it and register again. Lost with the old
   * core: current hp / dead flags (everyone comes back at full life until the next respawn). */
  private onLinkClosed(why: string): void {
    if (this.disposed || this.failingOver || !this.room || why.startsWith("1001")) return; // 1001 = match over
    this.startFailover(why, false);
  }

  /** The room's leader changed while the link to the host is still up (a vote,: SLOTINFO 3595
   * / 5149 moved `leaderSlot`): the same takeover as a dropped link, but the old host is alive. RoomClient has a single
   * `onChange` that the lobby owns, so this polls `leaderSlot` from the 60 Hz ticker instead of hooking it. */
  private watchLeader(): void {
    const room = this.room;
    if (!room || this.disposed || this.failingOver || this.hostSlot < 0) return;
    const now = room.leaderSlot;
    if (now < 0 || now >= 18 || now === this.hostSlot) return;
    this.startFailover(`room leader moved from slot ${this.hostSlot} to ${now}`, true);
  }

  private startFailover(why: string, voluntary: boolean): void {
    if (this.failingOver) return; // one takeover at a time: the link closing after a leader change lands here
    this.failingOver = true;
    this.failover(why, voluntary).catch((e: unknown) => console.warn("[p2p] host change failed:", e)).finally(() => { this.failingOver = false; });
  }

  /** `voluntary`: the leader changed with the old host alive (leaderSlot trigger), so it can hand its match core over
   *. Without a snapshot (old
   * host dead or frozen, ~2 s) or on any failure it is the plain takeover below. */
  private async failover(why: string, voluntary = false): Promise<void> {
    const room = this.room!;
    const lost = this.hostSlot;
    const me = this.link.session.slot;
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const deadline = Date.now() + 180000;
    console.warn(voluntary ? `[p2p] ${why}; taking over` : `[p2p] link to host slot ${lost} lost (${why}); waiting for the new leader`);
    let restore: HandoffEnvelope | null = null;
    if (voluntary) {
      const next = room.leaderSlot;
      if (this.p2p?.host && next !== me && next >= 0 && next < 18 && room.slots[next]?.nick) {
        // old host: give the new leader the core, then become its guest
        try { await this.p2p.host.handoff(next); } catch (e) { console.warn("[p2p] handoff failed, the new leader starts a fresh core:", (e as Error).message); }
      } else if (next === me && !this.p2p?.host) {
        // new leader: the snapshot comes before the host role opens on /signal (the old host's socket holds it until then)
        const { awaitHandoff } = await import("../p2p/session.ts");
        restore = await awaitHandoff({ serverUrl: this.link.serverUrl, session: this.link.session, log: this.p2pOpts.log });
      }
    }
    this.p2p?.stop();
    this.p2p = null;
    this.notifyBotHost(); // the old host stops simulating the bots now; the new host's states take over
    // the leader may be alive and only this link blipped (then it is the same host and we just reconnect); give the server a
    // moment to hand the room over when the host is gone
    for (let t = 0; !this.disposed && room.leaderSlot === lost && t < 2500; t += 250) await wait(250);
    while (!this.disposed && Date.now() < deadline) {
      const leader = room.leaderSlot === this.link.session.slot;
      try {
        const { openP2P } = await import("../p2p/session.ts");
        const h = await openP2P({
          session: this.link.session, serverUrl: this.link.serverUrl, room, leader,
          bridge: { reportKill: (v, w, hs, kp, vp) => this.reportKillOnce(v, w, hs, kp, vp) },
          hostWaitMs: 4000, // short: re-read room.leaderSlot often (the server may elect the next leader meanwhile)
          ...(leader && restore ? { restore } : {}),
          ...this.p2pOpts,
        });
        if (this.disposed) { h.stop(); return; }
        this.p2p = h;
        await this.link.reopen(() => h.transport);
        h.host?.bridge?.replay(); // slots restored from a handoff are skipped: the core already has their state
        this.hostSlot = room.leaderSlot;
        this.notifyBotHost(); // taking over: the game adopts the bots from botSnapshot()
        console.warn(`[p2p] back on the match: ${leader ? "hosting" : `guest of slot ${this.hostSlot}`}`);
        return;
      } catch (e) {
        console.warn("[p2p] reconnect attempt failed:", (e as Error).message);
        this.p2p?.stop();
        this.p2p = null;
        await wait(1000);
      }
    }
  }

  /** Roster entry; a player who joined after the battle began is not in the start roster: read the live room slot. */
  private rosterEntry(slot: number): RosterEntry | undefined {
    if (this.botSlots.has(slot)) return { slot, name: botNameOfSlot(slot), team: (slot % 2) as Team };
    const known = this.roster.get(slot);
    if (known) return known;
    const s = this.room?.slots[slot];
    if (!s?.nick) return undefined;
    const e: RosterEntry = { slot, name: s.nick, team: (slot % 2) as Team };
    this.roster.set(slot, e);
    return e;
  }

  setRoster(roster: RosterEntry[]): void {
    this.roster.clear();
    for (const r of roster) this.roster.set(r.slot, r);
  }

  /** Called after BATTLE_RESPAWN: header respawn counter must match Slot.SpawnsCount. */
  setRespawnCount(n: number): void {
    this.link.respawn = n & 0xff;
  }

  sendState(s: PlayerState): void {
    const now = Date.now();
    // Instant respawn (coupon) flips alive back before any dead packet went out, so the killer never sees the death
    // mark (no kill report, no headshot banner). Keep sending the corpse state for DEATH_HOLD_MS after the death.
    if (this.deathHold && now < this.deathHold.until) s = { ...s, alive: false, hp: 0, pos: this.deathHold.pos };
    else this.deathHold = null;
    this.lastState = s;
    const events = this.pendingHits.length || this.pendingDrops.length || this.pendingPickups.length || this.pendingRadio.length
      || this.pendingPropBreaks.length || this.pendingObjectiveHits.length || this.pendingThrows.length || this.pendingDropped.size;
    if (now - this.lastSend < this.sendIntervalMs && !events) return;
    this.lastSend = now;
    if (s.alive && !this.wasAlive) this.onLocalRespawn();
    this.wasAlive = s.alive;
    const mark = !s.alive && this.deathMark ? ((this.deathMark.killerSlot + 1) & 0x7f) | (this.deathMark.headshot ? 0x80 : 0) : 0;
    const a = packState(s, mark, false);
    this.lastLocalPos = [s.pos[0], s.pos[1], s.pos[2]];
    // one drop / pick-up / radio per record; a drop or pick-up record carries no WeaponSync (CheckDataFlags)
    const drop = this.pendingDrops.shift();
    const pickup = drop ? undefined : this.pendingPickups.shift();
    if (drop) a.drop = toDropInfo(drop, dropFlags(drop.slot, drop.death));
    if (pickup) a.pickup = toDropInfo(pickup, dropFlags(pickup.slot, false, pickup.idx));
    const radio = this.pendingRadio.shift();
    if (radio) a.radio = { id: radio.id, area: radio.area };
    const weaponId = s.weaponId ?? WEAPON_IDS[s.weapon] ?? 0;
    this.lastWeapon = s.weapon;
    if (!drop && !pickup && weaponId && (weaponId !== this.lastWeaponId || now - this.lastWeaponAt >= WEAPON_RESEND_MS)) {
      this.lastWeaponId = weaponId;
      this.lastWeaponAt = now;
      a.weapon = { weaponId };
    }
    if (this.pendingThrows.length) {
      a.grenades = this.pendingThrows.splice(0, 8).map((t) => ({
        idx: t.idx,
        g: { state: THROW_STATE[t.state], owner: this.link.session.slot, weaponId: t.weaponId, pos: t.pos, vel: t.vel },
      }));
    }
    if (this.pendingDropped.size) {
      a.dropped = [...this.pendingDropped.values()].slice(0, 8).map((d) => ({
        idx: d.idx,
        d: { pos: d.pos, ammo: d.ammo, extra: d.extra, reserve: d.reserve, resting: d.resting, flags: dropFlags(d.slot, d.death, d.idx),
          weaponId: d.weaponId, owner: this.link.session.slot },
      }));
      for (const d of a.dropped) this.pendingDropped.delete(d.idx);
    }
    if (this.pendingHits.length) {
      a.hits = toHitInfos(this.pendingHits.splice(0), this.lastWeaponId);
      // the kill is reported when the victim's death mark arrives, maybe after a weapon swap: keep the weapon of the hit
      for (const h of a.hits) {
        this.lastHitWeapon.set(h.victimSlot, h.weaponId);
        this.lastHitBy.set(h.victimSlot, { by: this.link.session.slot, weaponId: h.weaponId });
      }
    }
    if (this.pendingPropBreaks.length) {
      const p = this.lastState?.pos ?? [0, 0, 0];
      const props = this.pendingPropBreaks.splice(0, 16).map((i) => ({
        start: p as Vec3, end: p as Vec3, victimSlot: PROP_ID_BASE + i, damage: 1, part: 1, objectType: OBJECT_OBJECT,
        weaponId: Math.max(0, this.lastWeaponId), // antiScript checks the weapon of every hit
      }));
      a.hits = [...(a.hits ?? []), ...props];
    }
    if (this.pendingObjectiveHits.length) {
      // the host's matchCore applies it to the object (sabotageDestroy -> 5166 -> 5167 bars); no death, no hit marker
      const objs = this.pendingObjectiveHits.splice(0, 16).map((h) => ({
        start: h.point, end: h.point, victimSlot: h.objectId, damage: h.damage, part: 1, objectType: OBJECT_OBJECT,
        weaponId: Math.max(0, this.lastWeaponId),
      }));
      a.hits = [...(a.hits ?? []), ...objs];
    }
    this.link.send(a);
  }

  sendPropBreak(index: number): void {
    this.pendingPropBreaks.push(index);
  }

  sendObjectiveHit(objectId: number, damage: number, point: Vec3): void {
    this.pendingObjectiveHits.push({ objectId, damage: Math.max(1, Math.min(2047, Math.round(damage))), point });
  }
  /** a bot of ours hit an enemy objective: it goes in that bot's next record (sendBotStates), like sendObjectiveHit for us */
  sendBotObjectiveHit(slot: number, objectId: number, damage: number, point: Vec3): void {
    if (!this.ownBots.has(slot)) return;
    const q = this.botObjHits.get(slot) ?? [];
    q.push({ objectId, damage: Math.max(1, Math.min(2047, Math.round(damage))), point });
    this.botObjHits.set(slot, q);
    this.botDirty = true;
  }
  onRemotePropBreak(cb: (index: number) => void): () => void { this.propBreakCbs.add(cb); return () => this.propBreakCbs.delete(cb); }

  sendHit(e: HitEvent): void {
    // a hit of one of our bots rides that bot's own record (the record slot is the attacker the others see)
    const by = idSlot(e.attackerId);
    if (this.ownBots.has(by)) {
      const q = this.botHits.get(by) ?? [];
      q.push(e);
      this.botHits.set(by, q);
      this.botDirty = true;
      return;
    }
    this.pendingHits.push(e);
  }

  sendDrop(e: WeaponDropEvent): void {
    this.pendingDrops.push(e);
  }
  sendPickup(e: WeaponDropEvent): void {
    this.pendingPickups.push(e);
  }
  sendRadio(e: RadioEvent): void {
    this.pendingRadio.push(e);
  }
  sendThrow(e: ThrowEvent): void {
    this.pendingThrows.push(e);
  }
  sendDropped(e: DroppedSyncEvent): void {
    this.pendingDropped.set(e.idx, e);
  }
  onRemoteThrow(cb: (e: ThrowEvent) => void): () => void { this.throwCbs.add(cb); return () => this.throwCbs.delete(cb); }
  onRemoteDropped(cb: (e: DroppedSyncEvent) => void): () => void { this.droppedCbs.add(cb); return () => this.droppedCbs.delete(cb); }
  onRemoteDrop(cb: (e: WeaponDropEvent) => void): () => void { this.dropCbs.add(cb); return () => this.dropCbs.delete(cb); }
  onRemotePickup(cb: (e: WeaponDropEvent) => void): () => void { this.pickupCbs.add(cb); return () => this.pickupCbs.delete(cb); }
  onRemoteRadio(cb: (e: RadioEvent) => void): () => void { this.radioCbs.add(cb); return () => this.radioCbs.delete(cb); }

  sendKill(e: KillEvent): void {
    if (e.victimId !== this.localId) return; // only the victim reports (see header)
    const killer = e.killerId ? idSlot(e.killerId) : -1;
    const mySlot = this.link.session.slot;
    if (killer < 0 || killer === mySlot) {
      this.room?.reportKill(mySlot, weaponIdOfName(e.weapon), false); // suicide: killer == victim
      return;
    }
    this.deathMark = { killerSlot: killer, headshot: e.headshot };
    this.deathHold = { until: Date.now() + DEATH_HOLD_MS, pos: this.lastState?.pos ?? [0, 0, 0] };
  }

  get weaponsFlag(): number | undefined {
    return this.room?.room?.weaponsFlag;
  }

  get stage(): number | undefined {
    return this.room?.room?.stage;
  }

  get watchRule(): number | undefined {
    return this.room?.room?.opts?.watchRuleFlag;
  }

  /** Weapons [primary, secondary, melee, throw, special] sent in the next RESPAWN_REQ (pairs 0..4). */
  setRespawnWeapons(weapons: { itemId: number; objectId: number }[], base?: { itemId: number; objectId: number }[]): void {
    const equip = Array.from({ length: 18 }, (_, i) => ({ ...(base?.[i] ?? { itemId: 0, objectId: 0 }) }));
    weapons.slice(0, 5).forEach((w, i) => (equip[i] = { itemId: w.itemId, objectId: w.objectId }));
    this.respawnEquip = equip;
  }

  private onLocalRespawn(): void {
    this.deathMark = null;
    this.room?.respawn(undefined, this.respawnEquip ?? undefined).then((n) => this.setRespawnCount(n)).catch((err) => console.warn("[battle] respawn", err));
  }

  onRemoteState(cb: (s: PlayerState) => void): () => void { this.stateCbs.add(cb); return () => this.stateCbs.delete(cb); }
  onRemoteHit(cb: (e: HitEvent) => void): () => void { this.hitCbs.add(cb); return () => this.hitCbs.delete(cb); }
  onRemoteKill(cb: (e: KillEvent) => void): () => void { this.killCbs.add(cb); return () => this.killCbs.delete(cb); }
  onRemoteLeave(cb: (id: string) => void): () => void { this.leaveCbs.add(cb); return () => this.leaveCbs.delete(cb); }

  /** last kill emitted per victim (ms): the same death arrives twice, see emitKill */
  private lastKillAt = new Map<string, number>();

  /**
   * One kill to the game. The same death reaches us twice: the UDP death record (EVENTS_ACTION) and the Game server's
   * BATTLE_DEATH_ACK over TCP. Both used to be emitted, so every kill counted twice (the no-death streak jumped by 2:
   * Chain Killer on the 2nd-3rd kill, never Triple Kill; doubled kill-feed lines). A victim's death is emitted once
   * per 1.5 s window, far shorter than any respawn.
   */
  emitKill(e: KillEvent): void {
    const now = Date.now(), last = this.lastKillAt.get(e.victimId) ?? -Infinity;
    if (now - last < 1500) return;
    this.lastKillAt.set(e.victimId, now);
    for (const cb of this.killCbs) cb(e);
  }

  /** Latest raw (non-interpolated) state per remote slot — handy for tests/debug. */
  latest(slot: number): PlayerState | undefined {
    const b = this.buffers.get(slot);
    return b?.[b.length - 1]?.s;
  }

  dispose(): void {
    this.disposed = true;
    this.restoreRoomHooks?.();
    this.restoreRoomHooks = null;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.link.close();
    this.p2p?.stop();
    this.p2p = null;
    this.stateCbs.clear();
    this.hitCbs.clear();
    this.propBreakCbs.clear();
    this.killCbs.clear();
    this.leaveCbs.clear();
    this.dropCbs.clear();
    this.pickupCbs.clear();
    this.radioCbs.clear();
    this.throwCbs.clear();
    this.droppedCbs.clear();
    this.botHostCbs.clear();
    this.botYieldCbs.clear();
    this.ownBots.clear();
  }

  // ------------------------------------------------------------------ incoming

  private onActions(actions: ActionIn[]): void {
    const now = Date.now();
    const me = this.link.session.slot;
    for (const a of actions) {
      if (a.grenade || a.dropped) {
        this.objectRecord(a);
        continue;
      }
      if (a.actionState && (a.actionState.action & FLAG_BOT) && a.slot !== me && !this.ownBots.has(a.slot)) this.botSlots.add(a.slot);
      if (a.slot !== me && a.weaponId) {
        // the server's own WeaponSync (EVENTS_ACTION type 6: this flag alone, built from the RESPAWN loadout) is only a
        // fallback: the player's WeaponSync carries what is really in hand (picked-up weapons, skins)
        if (a.flags === Ev.WeaponSync) this.serverWeapon.set(a.slot, a.weaponId);
        else this.clientWeapon.set(a.slot, a.weaponId);
      }
      if (a.slot === me && !a.death && !a.hits) continue;
      if (a.death) {
        const killer = a.death.killerSlot;
        this.emitKill({ killerId: killer === 255 ? null : slotId(killer), victimId: slotId(a.slot), weapon: "", headshot: a.death.hitPart === PART_HEAD, t: now });
      }
      if (a.hits) {
        for (const h of a.hits) {
          if (h.objectType === OBJECT_OBJECT) {
            if (h.victimSlot >= PROP_ID_BASE && a.slot !== me) for (const cb of this.propBreakCbs) cb(h.victimSlot - PROP_ID_BASE);
            continue;
          }
          const { zone, helmetBlocked } = decodeHitPart(h.part);
          this.lastHitBy.set(h.victimSlot, { by: a.slot, weaponId: h.weaponId });
          const e: HitEvent = {
            attackerId: slotId(a.slot), victimId: slotId(h.victimSlot), weapon: weaponName(h.weaponId),
            zone, baseDamage: h.damage, helmetPenetrate: 0, falloff: 1,
            point: h.end as Vec3, t: now, helmetBlocked,
          };
          for (const cb of this.hitCbs) cb(e);
        }
      }
      if (a.slot !== this.link.session.slot) this.dropsAndRadio(a);
      if (a.slot !== this.link.session.slot && a.posRot && a.hp !== undefined) this.checkKillMark(a);
      if (!a.posRot || a.slot === this.link.session.slot) continue;
      const prev = this.latest(a.slot);
      const r = this.rosterEntry(a.slot);
      const act = a.actionState?.action ?? 0;
      const hp = a.hp ?? prev?.hp ?? 100;
      const alive = hp > 0;
      const torso = TORSO_NAMES[(act >> TORSO_SHIFT) & TORSO_MASK] ?? "idle";
      const moving = (act & FLAG_MOVING) !== 0;
      const running = (act & FLAG_RUNNING) !== 0;
      // value/weaponFlag are the kill marker while dead (checkKillMark); only meaningful when alive.
      const value = a.actionState?.value ?? 0;
      const heldId = this.clientWeapon.get(a.slot) ?? this.serverWeapon.get(a.slot) ?? this.loadoutWeapon.get(a.slot);
      const s: PlayerState = {
        id: slotId(a.slot),
        name: r?.name ?? `slot ${a.slot}`,
        team: r?.team ?? ((a.slot % 2) as Team),
        pos: [a.posRot.x, a.posRot.y, a.posRot.z],
        vel: [0, 0, 0],
        yaw: a.posRot.yaw,
        pitch: a.posRot.pitch,
        crouch: (act & POSTURE_MASK) === POSTURE_CROUCH,
        firing: torso === "fire",
        torsoAction: torso,
        silencer: alive ? (act & FLAG_SILENCER) !== 0 : false,
        airborne: alive && (act & FLAG_AIRBORNE) !== 0,
        moving,
        running,
        moveDir: alive ? value & 0x0f : prev?.moveDir ?? 0,
        zoomType: alive ? (value >> 4) & 0x07 : prev?.zoomType ?? 0,
        heavy: alive && torso === "fire" && (value & VALUE_HEAVY) !== 0,
        hp,
        alive,
        weapon: heldId !== undefined ? weaponName(heldId) : prev?.weapon ?? "",
        weaponId: heldId ?? prev?.weaponId,
        weaponSlot: alive && a.actionState ? (a.actionState.weaponFlag >> 4) & 7 : prev?.weaponSlot,
        t: now,
        chara: this.charas.get(a.slot),
        ...(this.botSlots.has(a.slot) ? { bot: true } : {}),
      };
      if (prev) {
        const dt = Math.max(1, s.t - prev.t) / 1000;
        s.vel = [(s.pos[0] - prev.pos[0]) / dt, (s.pos[1] - prev.pos[1]) / dt, (s.pos[2] - prev.pos[2]) / dt];
      }
      // a slot that (re)appears: its 5138 may be older than this occupant (left and came back with another character /
      // equipment) or never reached us, so ask the server for what the slot wears now (3666 -> 3667 -> onRespawnAck)
      if (!this.buffers.has(a.slot) && !s.bot) this.room?.requestEquip?.(a.slot);
      const buf = this.buffers.get(a.slot) ?? [];
      buf.push({ at: now, s });
      while (buf.length > 32) buf.shift();
      this.buffers.set(a.slot, buf);
      this.lastSeen.set(a.slot, now);
      if (s.bot) this.botSnap.set(a.slot, s);
    }
  }

  /** SubHead.Grenade / DroppedWeapon record of another player (the owner is in the body, the record slot is the object index). */
  private objectRecord(a: ActionIn): void {
    const me = this.link.session.slot;
    if (a.grenade) {
      const g = a.grenade;
      const state = THROW_NAME(g.state);
      if (g.owner === me || !state) return;
      const e: ThrowEvent = { actorId: slotId(g.owner), idx: a.slot, state, weaponId: g.weaponId, pos: g.pos, vel: g.vel };
      for (const cb of this.throwCbs) cb(e);
    } else if (a.dropped) {
      const d = a.dropped;
      if (d.owner === me) return;
      const f = parseDropFlags(d.flags);
      const e: DroppedSyncEvent = { actorId: slotId(d.owner), idx: a.slot, weaponId: d.weaponId, slot: f.slot, death: f.death,
        ammo: d.ammo, extra: d.extra, reserve: d.reserve, pos: d.pos, resting: d.resting };
      for (const cb of this.droppedCbs) cb(e);
    }
  }

  private dropsAndRadio(a: ActionIn): void {
    const id = slotId(a.slot);
    if (a.radio) for (const cb of this.radioCbs) cb({ actorId: id, id: a.radio.id, area: a.radio.area });
    const last = this.latest(a.slot);
    const pos = a.posRot ? ([a.posRot.x, a.posRot.y, a.posRot.z] as Vec3) : last?.pos;
    const yaw = a.posRot?.yaw ?? last?.yaw;
    if (a.drop) for (const cb of this.dropCbs) cb(fromDropInfo(id, a.drop, pos, yaw));
    if (a.pickup) for (const cb of this.pickupCbs) cb(fromDropInfo(id, a.pickup, pos, yaw));
  }

  /** Victim's death mark addressed to us -> report the kill (once per victim life) over TCP. */
  private checkKillMark(a: ActionIn): void {
    if (a.hp! > 0) {
      this.reportedVictims.delete(a.slot);
      this.reportedBots.delete(a.slot);
      return;
    }
    const v = a.actionState?.value ?? 0;
    if (!v) return;
    const killer = (v & 0x7f) - 1;
    // an AI victim or an AI killer: the mark is the whole kill report, every peer reads it (Server.Game has no AI slot)
    if (this.botSlots.has(a.slot) || this.botSlots.has(killer)) { this.botKillMark(a.slot, killer, v); return; }
    if (killer !== this.link.session.slot) return;
    const victim = this.latest(a.slot)?.pos ?? [0, 0, 0];
    // WEAPON_IDS only knows the default loadout: any other (shop) weapon reported id 0 = "0" in the kill feed
    const weaponId = this.lastHitWeapon.get(a.slot) ?? WEAPON_IDS[this.lastWeapon] ?? Math.max(0, this.lastWeaponId);
    this.lastHitWeapon.delete(a.slot);
    this.reportKillOnce(a.slot, weaponId, (v & 0x80) !== 0, this.lastLocalPos, victim as [number, number, number]);
  }

  /** A dead-state record with a kill mark where the victim or the killer is an AI slot: one kill event per life of the victim. */
  private botKillMark(victim: number, killer: number, v: number): void {
    if (this.reportedBots.has(victim)) return;
    this.reportedBots.add(victim);
    const noKiller = killer < 0 || killer >= 18;
    const lh = this.lastHitBy.get(victim);
    const w = lh && lh.by === killer ? lh.weaponId : (this.clientWeapon.get(killer) ?? this.serverWeapon.get(killer) ?? 0);
    this.emitKill({
      killerId: noKiller ? null : slotId(killer), victimId: slotId(victim),
      weapon: noKiller ? "Queda" : w ? weaponName(w) : "", headshot: (v & 0x80) !== 0, t: Date.now(),
    });
  }

  /** DEATH_REQ once per victim life: from the victim's kill mark, or (P2P host) from the match core's own damage. */
  private reportKillOnce(victimSlot: number, weaponId: number, headshot: boolean, killerPos: [number, number, number], victimPos: [number, number, number]): void {
    if (this.reportedVictims.has(victimSlot)) return;
    this.reportedVictims.add(victimSlot);
    this.room?.reportKill(victimSlot, weaponId, headshot, killerPos, victimPos);
  }

  private lastLocalPos: [number, number, number] = [0, 0, 0];

  private tick(): void {
    this.watchLeader();
    if (this.ownBots.size) this.yieldBotSeats();
    const now = Date.now();
    const renderAt = now - this.interpDelayMs;
    // a player whose character we still do not know (5138 missed): ask again, every 3 s
    if (now - this.equipAskAt >= 3000) {
      this.equipAskAt = now;
      for (const slot of this.buffers.keys()) if (!this.charas.has(slot) && !this.botSlots.has(slot)) this.room?.requestEquip?.(slot);
    }
    for (const [slot, buf] of this.buffers) {
      // A remote leaves when the server says its slot left the battle (GIVEUPBATTLE / disconnect -> slot info below
      // LOAD). Silence alone is not a leave: a background tab (requestAnimationFrame paused), a hitch or a lost burst
      // used to drop the player after 5 s, and a 1v1 then ended as "no enemy left". Without room info (offline
      // tests) the 5 s silence rule stays.
      // An AI slot has no room seat (state below LOAD all along): it leaves only when its host goes quiet for good.
      const bot = this.botSlots.has(slot);
      const st = this.room?.slots[slot]?.state;
      const serverLeft = !bot && st !== undefined && st < SLOT_LOAD;
      const silent = now - (this.lastSeen.get(slot) ?? 0) > (bot ? BOT_SILENT_MS : 5000);
      if (serverLeft || (silent && (!this.room || bot))) {
        this.buffers.delete(slot);
        this.lastSeen.delete(slot);
        for (const cb of this.leaveCbs) cb(slotId(slot));
        continue;
      }
      if (!buf.length) continue;
      const s = interpolate(buf, renderAt);
      for (const cb of this.stateCbs) cb(s);
    }
  }
}

/** roomClient.ts slotStateName: 14 LOAD .. 19 BATTLE = in the match */
const SLOT_LOAD = 14;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

/** Linear interpolation between the two snapshots around `at`; short extrapolation (<=150 ms) past the last. */
export function interpolate(buf: { at: number; s: PlayerState }[], at: number): PlayerState {
  let i = buf.length - 1;
  while (i > 0 && buf[i - 1].at > at) i--;
  const b = buf[i];
  const a = i > 0 ? buf[i - 1] : b;
  if (a === b) {
    const ex = Math.min(150, Math.max(0, at - b.at)) / 1000;
    return { ...b.s, pos: [b.s.pos[0] + b.s.vel[0] * ex, b.s.pos[1] + b.s.vel[1] * ex, b.s.pos[2] + b.s.vel[2] * ex] };
  }
  if (at >= b.at) {
    const ex = Math.min(150, at - b.at) / 1000;
    return { ...b.s, pos: [b.s.pos[0] + b.s.vel[0] * ex, b.s.pos[1] + b.s.vel[1] * ex, b.s.pos[2] + b.s.vel[2] * ex] };
  }
  const t = Math.min(1, Math.max(0, (at - a.at) / Math.max(1, b.at - a.at)));
  return {
    ...b.s,
    pos: [lerp(a.s.pos[0], b.s.pos[0], t), lerp(a.s.pos[1], b.s.pos[1], t), lerp(a.s.pos[2], b.s.pos[2], t)],
    yaw: lerpAngle(a.s.yaw, b.s.yaw, t),
    pitch: lerp(a.s.pitch, b.s.pitch, t),
  };
}

function toDropInfo(e: WeaponDropEvent, flags: number): WeaponDropInfo {
  return { ammo: e.ammo, extra: e.extra, reserve: e.reserve, flags, weaponId: e.weaponId };
}
function fromDropInfo(actorId: string, d: WeaponDropInfo, pos?: Vec3, yaw?: number): WeaponDropEvent {
  const f = parseDropFlags(d.flags);
  return { actorId, weaponId: d.weaponId, slot: f.slot, death: f.death, idx: f.idx, ammo: d.ammo, extra: d.extra, reserve: d.reserve, pos, yaw };
}
