// Server.Match (server/Server.Match) ported to TypeScript: the match core the room leader's tab runs in a Web Worker
// when the battle is hosted peer to peer. It takes the same datagrams the .NET server takes
// and answers with the
// same bytes, so src/net/matchUdpLink.ts and battle.ts talk to it unchanged. One "peer" id stands in for the IPEndPoint.
//
// Ported 1:1 (C# source in brackets):
//   receive                  MatchManager.OnReceiveData + MatchClient.BeginReceive / ReadPacket
//   decrypt / baseWriteCode  AllUtils.GetDecryptedData / TryDecryptUdp121GameData / BaseWriteCode, Udp121Cipher
//   register / unregister    ProcessUnregister_65 / _67, RoomModel.AddPlayer / RemovePlayer, RoomsManager
//   pvp                      ProcessPVPPacket -> WritePlayerActionData -> Method0 (every UdpGameEvent, same order)
//   ping                     ProcessPingPacket (echo)
//   damage                   DamageManager.SimpleDeath / BoomDeath / SabotageDestroy, AssistManager
//   events                   PROTOCOL_EVENTS_ACTION.GET_CODE (ObjectHitInfo types 1-6: hp, death, objects, weapon)
//   objects                  RoomModel.SyncInfo / RoundResetRoomF1 / S1, ObjectModel anims (MapStructure.xml data)
//   Game -> Match sync       RespawnSync.Load, RemovePlayerSync.Load, MatchRoundSync.Load (fed by the host tab from the
//                            leader's Server.Game session: RESPAWN_ACK 5138 etc., src/host/bridge.ts)
//   Match -> Game sync       SendMatchInfo.* (death, bomb, hit marker, sabotage, ping, portal) -> CoreOut.game
// Not in Server.Match: AntiScript on with the web's item table,
// the weapon of a hit / WeaponSync held to the slot's RESPAWN loadout, a fire rate cap, strikes (MatchCore).
// Not ported: the AI/bot paths (opcode 4 PVE, 131/132, WriteBotActionData / Method1, PROTOCOL_BOTS_ACTION): the web
// build has no AI modes; those datagrams are dropped with a log line.
import { bitwiseDecrypt, bitwiseEncrypt } from "../net/bitwise.ts";
import { fromHalf, toHalf } from "../net/matchUdp.ts";
import { PacketWriter } from "../net/packet.ts";
import { BAREFIST_ID } from "../game/respawnSelect.ts";

// ------------------------------------------------------------------ enums (Server.Match/Data/Enums, Plugin.Core/Enums)

/** UdpGameEvent */
export const Ev = {
  ActionState: 0x100, Animation: 0x2, PosRotation: 0x08000000, SoundPosRotation: 0x00800000, UseObject: 0x4,
  ActionForObjectSync: 0x10, RadioChat: 0x20, WeaponSync: 0x04000000, WeaponRecoil: 0x80, HpSync: 0x8,
  Suicide: 0x00100000, MissionData: 0x800, RetriveDataForClient: 0x1000, SeizeDataForClient: 0x8000,
  DropWeapon: 0x00400000, GetWeaponForClient: 0x01000000, FireData: 0x02000000, CharaFireNHitData: 0x400,
  HitData: 0x00020000, GrenadeHit: 0x10000000, GetWeaponForHost: 0x200, FireDataOnObject: 0x40000000,
  FireNHitDataOnObject: 0x2000, BattleRoyalItem: 0x40, DirectPickUp: 0x4000,
} as const;

/** UdpSubHead */
const Sub = {
  User: 0, Grenade: 1, DroppedWeapon: 2, ObjectStatic: 3, ObjectMove: 4, ObjectAnim: 6, StageInfoChara: 8,
  StageInfoObjectStatic: 9, StageInfoObjectAnim: 12, StageInfoObjectControl: 13,
} as const;

const WeaponSyncType = { Primary: 0, Secondary: 16, Melee: 32, Explosive: 48, Special: 64, Mission: 80, Dual: 128, Ext: 144 } as const;
const ActionFlag = { Unk2048: 2048, Unk4096: 4096 } as const;
const CharaMoves = { HeliInMove: 16, HeliUnknown: 32, HeliLeave: 64, HeliStopped: 128 } as const;
const BombFlag = { Start: 1, Stop: 2, Defuse: 4 } as const;
export const CharaHitPart = { UNK: 0, ALL: 1, HEAD: 14 } as const;
export const CharaDeath = {
  UNK: 0, DEFAULT: 1, BOOM: 2, HEADSHOT: 3, FALLING_DEATH: 4, OBJECT_EXPLOSION: 5, FAST_OBJECT: 6, POISON: 7,
  TRAMPLED: 8, HOWL: 9, MEDICAL_KIT: 10,
} as const;
const HitType = { Normal: 0, HeadshotCritical: 1, HeadshotProtection: 2, HelmetProtection: 3 } as const;
const ObjectType = { Nothing: 0, User: 1, UserObject: 2, Object: 3 } as const;
const RoomCondition = { DeathMatch: 4, Bomb: 8, Destroy: 12, Defense: 20, Boss: 28 } as const;
const MapRules = { HeadHunter: 32, Chaos: 80 } as const;
const ClassDino = 19;
const Team = { FR: 0, CT: 1, DRAW: 2 } as const;

/** Enum.HasFlag */
const has = (v: number, f: number) => ((v >>> 0) & f) === f;

// ------------------------------------------------------------------ config (server/runtime/Config/Settings.ini)

export interface MatchConfig {
  udpVersion: string;
  /** (a) AllUtils.ValidateHitData / ValidateGrenadeHit: damage and range of every hit against itemStats */
  antiScript: boolean;
  /** (b) a hit's / WeaponSync's weapon must be one the slot's last RespawnSync gave it (or it picked up since) */
  checkLoadout: boolean;
  /** (c) hits of one weapon over its own fire rate (+ FIRE_RATE_SLACK) are dropped */
  fireRateCap: boolean;
  /** hard rejections (a) / (b) / a record for another slot within STRIKE_WINDOW_MS before the guest is dropped; 0 = never */
  strikeLimit: number;
  useMaxAmmoInDrop: boolean;
  maxDropWpnCount: number;
  useHitMarker: boolean;
  sendPingSync: boolean;
  sendFailMsg: boolean;
  plantDuration: number;
  defuseDuration: number;
  /** Clube da Luta (room stage KNUCKLE_STAGE): a slot's loadout is the bare fist (+ special), nothing else (loadoutOf) */
  barefistOnly?: boolean;
}

/** Settings.ini [Others]/[Internal] as deployed (server/runtime/Config/Settings.ini), except the anti-cheat: the deployed
 * file has AntiScript = False (the PB client was trusted, it had its own anticheat); in the P2P core every guest's browser
 * is untrusted, so (a)-(c) are on. */
export const DEFAULT_CONFIG: MatchConfig = {
  udpVersion: "-31247.1733",
  antiScript: true,
  checkLoadout: true,
  fireRateCap: true,
  strikeLimit: 30,
  useMaxAmmoInDrop: false,
  maxDropWpnCount: 25,
  useHitMarker: false,
  sendPingSync: true,
  sendFailMsg: true,
  // Cross exe 0x5845d0 / 0x584600: 5 s / 7 s (3 s / 5 s with the speed kit, see c4SpeedKit); the C# Settings.ini had 5.5 / 7.1
  plantDuration: 5,
  defuseDuration: 7,
};

// ------------------------------------------------------------------ anti-cheat limits (not in Server.Match)

/** pef-2017 Character SWAT_Male Body DamageRate: the highest non-head part rate a web hit carries (PB_CHARA.damageRate) */
const PART_RATE_MAX = 1.2;
/** bullet damage coupon 1600078, +10 % (src/game/loadout.ts BATTLE_COUPONS, [INFERIDO] there) */
const DAMAGE_UP_MAX = 0.1;
/** CalcHeadShotDamage 0x7fbf20 caps a human head hit at 255 (src/game/damage.ts HEAD_HIT_DAMAGE) */
const HEAD_DAMAGE_MAX = 255;
/** best three titles' Fire_Speed (DesignationValue.pef: -0.004, -0.003, -0.003 s) and GetFireDelay's floor (0x616020) */
const FIRE_SPEED_TITLE_MAX = 0.01;
const FIRE_DELAY_MIN = 0.06;
/** [RECRIADO] the original never checks the fire rate: 15 % over the item's own, counted over a sliding 1 s window */
const FIRE_RATE_SLACK = 0.15;
const FIRE_WINDOW_MS = 1000;
/** [RECRIADO] strikes older than this are forgotten; one log line per slot and reason every WARN_EVERY_MS */
const STRIKE_WINDOW_MS = 60000;
const WARN_EVERY_MS = 5000;

// ------------------------------------------------------------------ static data (CharaHealth.xml, MapStructure.xml)

export interface AnimData { id: number; duration: number; next: number; otherObj: number; otherAnim: number }
export interface ObjectData { id: number; life: number; animation: number; needSync: boolean; anims?: AnimData[]; effects?: { id: number; life: number }[] }
export interface MapData { objects: ObjectData[]; bombs: [number, number, number][] }
/** One item for the anti-cheat (pb-extract-tools match-data.mjs: ItemStatistics.xml + the pef the web client plays with). */
export interface ItemStat {
  /** ItemStatistics.xml Damage: what Server.Match's ValidateHitData reads */
  damage: number;
  /** highest base a hit of the item carries in the web client (pef Damage / AttackDamageA1..B2); absent = damage */
  damageMax?: number;
  /** max(ItemStatistics Range, pef Range), m */
  range: number;
  /** shortest time between two shots / swings / throws, s (pef FireDelay; a blade's fastest button) */
  fireDelay: number;
  /** most hits one shot lands on one victim (pellets, DualSMG, 2nd blade, blast head + body); absent = 1 */
  hits?: number;
  /** one shot may hit several victims (sniper line, blast): the rate is counted per victim */
  multi?: boolean;
  /** Bomb Mission C4: the room hands it out, never the RESPAWN */
  mission?: boolean;
  /** Extension2: the item the extension key swaps this one for in hand */
  alt?: number;
}
/** pb-extract-tools match-data.mjs output (src/host/data/matchData.json). itemStats / weaponGroup / propBlast / defaultLoadout:
 * the anti-cheat. */
export interface MatchData {
  charaHp: Record<string, number>;
  maps: Record<string, MapData>;
  itemStats?: Record<string, ItemStat>;
  /** item id -> the id its hits may carry instead: the client names a hit's weapon by name (src/net/battle.ts
   * weaponIdOfName: WEAPON_IDS, then the first weapons.json id with that name) */
  weaponGroup?: Record<string, number>;
  /** map id -> damage of its strongest exploding prop (car / drum): the web sends that blast as a hit of the breaker's weapon */
  propBlast?: Record<string, number>;
  /** what WeaponSystem.setLoadout puts in a slot the RESPAWN left at 0; the melee one also replaces a spent Ballistic Knife */
  defaultLoadout?: { primary?: number; secondary?: number; melee?: number; explosive?: number };
}

// ------------------------------------------------------------------ Half3 (SharpDX Half raw bits)

export interface Half3 { x: number; y: number; z: number }
const HALF0: Half3 = { x: 0, y: 0, z: 0 };
const vec = (h: Half3): [number, number, number] => [fromHalf(h.x), fromHalf(h.y), fromHalf(h.z)];
const half3 = (x: number, y: number, z: number): Half3 => ({ x: toHalf(x), y: toHalf(y), z: toHalf(z) });
const halfSub = (a: Half3, b: Half3): Half3 => { const p = vec(a), q = vec(b); return half3(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
const dist = (a: [number, number, number], b: [number, number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ------------------------------------------------------------------ SyncClientPacket (reads past the end give 0 / empty)

class SyncReader {
  pos = 0;
  readonly d: Uint8Array;
  private readonly v: DataView;
  constructor(d: Uint8Array) {
    this.d = d;
    this.v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  }
  get remaining(): number { return this.d.length - this.pos; }
  private can(n: number): boolean { return this.remaining >= n; }
  c(): number { return this.can(1) ? this.d[this.pos++] : 0; }
  h(): number { if (!this.can(2)) return 0; const x = this.v.getInt16(this.pos, true); this.pos += 2; return x; }
  uh(): number { if (!this.can(2)) return 0; const x = this.v.getUint16(this.pos, true); this.pos += 2; return x; }
  /** ReadUH(out Exception) */
  uhEx(): number | null { return this.can(2) ? this.uh() : null; }
  d32(): number { if (!this.can(4)) return 0; const x = this.v.getInt32(this.pos, true); this.pos += 4; return x; }
  ud(): number { if (!this.can(4)) return 0; const x = this.v.getUint32(this.pos, true); this.pos += 4; return x; }
  t(): number { if (!this.can(4)) return 0; const x = this.v.getFloat32(this.pos, true); this.pos += 4; return x; }
  b(n: number): Uint8Array { if (n <= 0 || !this.can(n)) return new Uint8Array(0); const x = this.d.slice(this.pos, this.pos + n); this.pos += n; return x; }
  advance(n: number): void { if (n < 0 || !this.can(n)) return; this.pos += n; }
  /** ReadUHV: three raw halves */
  uhv(): Half3 { if (!this.can(6)) return { ...HALF0 }; return { x: this.uh(), y: this.uh(), z: this.uh() }; }
  /** ReadTV: three floats, stored as Half3 (the server keeps them at half precision) */
  tv(): Half3 { if (!this.can(12)) return { ...HALF0 }; return half3(this.t(), this.t(), this.t()); }
}

const writeHV = (w: PacketWriter, h: Half3) => w.writeH(h.x).writeH(h.y).writeH(h.z);
const writeTV = (w: PacketWriter, h: Half3) => { const p = vec(h); return w.writeT(p[0]).writeT(p[1]).writeT(p[2]); };

// ------------------------------------------------------------------ ComDiv / AllUtils helpers

/** ComDiv.GetIdStatics */
export function idStatics(id: number, type: number): number {
  switch (type) {
    case 1: return Math.trunc(id / 100000);
    case 2: return Math.trunc((id % 100000) / 1000);
    case 3: return id % 1000;
    case 4: return Math.trunc((id % 10000000) / 100000);
    case 5: return Math.trunc(id / 1000);
    default: return 0;
  }
}
const hitType = (i: number) => i & 3;
const hitPart = (i: number) => (i >>> 11) & 63;
const hitDamageBot = (i: number) => i >>> 20;
const hitDamageNormal = (i: number) => i >>> 21;
const hitHelmet = (i: number) => (i >>> 17) & 7;
const charaDeathOf = (i: number) => i & 15;
const killerIdOf = (i: number) => (i >>> 11) & 511;
const objectTypeOf = (i: number) => (i >>> 10) & 1;
const roomInfo = (uid: number, type: number) => (type === 0 ? uid & 0xfff : type === 1 ? (uid >>> 12) & 0xff : type === 2 ? (uid >>> 20) & 0xfff : 0);
const seedInfo = (seed: number, type: number) => roomInfo(seed, type);
/** AllUtils.ItemClassified: ClassType -> ItemClass (1 primary, 2 secondary, 3 melee, 4 explosive, 5 special, 0 unknown) */
function itemClassified(cls: number): number {
  switch (cls) {
    case 1: case 15: case 23: return 3; // Knife, DualKnife, Knuckle -> Melee
    case 2: case 13: case 14: return 2; // HandGun, CIC, DualHandGun -> Secondary
    case 3: case 4: case 18: case 5: case 6: case 35: case 10: return 1; // Assault, SMG, DualSMG, Sniper, Shotgun, DualShotgun, MG
    case 7: return 4; // ThrowingGrenade -> Explosive
    case 8: return 5; // ThrowingSpecial -> Special
    default: return 0; // Dino and the rest: Unknown
  }
}

// ------------------------------------------------------------------ models

interface AnimModel { id: number; duration: number; nextAnim: number; otherObj: number; otherAnim: number }

class ObjectModel {
  id = 0;
  life = 0;
  animation = 0;
  ultraSync = 0;
  updateId = 1;
  needSync: boolean;
  destroyable = false;
  noInstaSync = false;
  animations: AnimModel[] | null;
  effects: { id: number; life: number }[] = [];
  constructor(needSync: boolean) {
    this.needSync = needSync;
    this.animations = needSync ? [] : null;
  }
  checkDestroyState(life: number): number {
    for (let i = this.effects.length - 1; i > -1; --i) if (this.effects[i].life >= life) return this.effects[i].id;
    return 0;
  }
  getRandomAnimation(core: MatchCore, room: RoomModel, obj: ObjectInfo): number {
    if (this.animations && this.animations.length > 0) {
      const a = this.animations[Math.floor(core.random() * this.animations.length)];
      obj.animation = a;
      obj.useDate = core.now();
      if (a.otherObj > 0) this.getAnim(core, a.otherAnim, 0, 0, room.objects[a.otherObj]);
      return a.id;
    }
    obj.animation = null;
    return 255;
  }
  getAnim(core: MatchCore, animId: number, time: number, duration: number, obj: ObjectInfo | undefined): void {
    if (animId === 255 || !obj || !obj.model || !obj.model.animations || obj.model.animations.length === 0) return;
    for (const a of obj.model.animations) {
      if (a.id === animId) {
        obj.animation = a;
        time -= duration;
        obj.useDate = core.now() - time * 1000;
        break;
      }
    }
  }
}

class ObjectInfo {
  id: number;
  life = 100;
  destroyState = 0;
  animation: AnimModel | null = null;
  /** ms; 0 = DateTime default */
  useDate = 0;
  model: ObjectModel | null = null;
  constructor(id: number) { this.id = id; }
}

interface MapModel { id: number; objects: ObjectModel[]; bombs: { position: Half3; everyWhere: boolean }[] }

interface Equipment { wpnPrimary: number; wpnSecondary: number; wpnMelee: number; wpnExplosive: number; wpnSpecial: number; accessory: number }

export class PlayerModel {
  slot: number;
  team: number;
  life = 100;
  maxLife = 100;
  playerIdByUser = -2;
  playerIdByServer = -1;
  respawnByUser = -2;
  respawnByServer = -1;
  ping = 5;
  latency = 0;
  weaponId = 0;
  accessory = 0;
  extensions = 0;
  plantDuration = 0;
  defuseDuration = 0;
  c4Time = 0;
  position: Half3 = { ...HALF0 };
  /** the IPEndPoint: the peer id this slot registered from */
  client: string | null = null;
  /** restore() brought this slot back from a host handoff: its next 65 (the guest re-registering on the new host) keeps
   * the restored battle state instead of resetting it (the `!Integrity` reset of ProcessUnregister_65 is for a re-register
   * on the same core) */
  restoreKeep = false;
  startTime = 0;
  lastPing = 0;
  lastDie = 0;
  c4First = 0;
  equip: Equipment | null = null;
  /**items the slot may use, from its last full RespawnSync + legal pick-ups; null = no RespawnSync (an AI seat) */
  loadout: Set<number> | null = null;
  weaponClass = 0;
  dead = true;
  neverRespawn = true;
  integrity = true;
  immortal = false;
  constructor(slot: number) {
    this.slot = slot;
    this.team = slot % 2;
  }
  compareIp(peer: string | null): boolean { return this.client !== null && peer !== null && this.client === peer; }
  respawnIsValid(): boolean { return this.respawnByServer === this.respawnByUser; }
  accountIdIsValid(): boolean { return this.playerIdByServer === this.playerIdByUser; }
  checkLifeValue(): void { if (this.life > this.maxLife) this.life = this.maxLife; }
  resetAllInfos(cfg: MatchConfig): void {
    this.client = null;
    this.startTime = 0;
    this.playerIdByUser = -2;
    this.playerIdByServer = -1;
    this.integrity = true;
    this.resetBattleInfos(cfg);
  }
  resetBattleInfos(cfg: MatchConfig): void {
    this.respawnByUser = -2;
    this.respawnByServer = -1;
    this.immortal = false;
    this.dead = true;
    this.neverRespawn = true;
    this.weaponId = 0;
    this.accessory = 0;
    this.extensions = 0;
    this.weaponClass = 0;
    this.lastPing = 0;
    this.lastDie = 0;
    this.c4First = 0;
    this.c4Time = 0;
    this.position = { ...HALF0 };
    this.life = 100;
    this.maxLife = 100;
    this.ping = 5;
    this.latency = 0;
    this.plantDuration = cfg.plantDuration;
    this.defuseDuration = cfg.defuseDuration;
  }
  resetLife(): void { this.life = this.maxLife; }
}

class ObjectHitInfo {
  type: number;
  objSyncId = 0;
  objId = 0;
  objLife = 0;
  killerSlot = 0;
  animId1 = 0;
  animId2 = 0;
  destroyState = 0;
  weaponId = 0;
  accessory = 0;
  extensions = 0;
  specialUse = 0;
  position: Half3 = { ...HALF0 };
  hitPart = 0;
  deathType: number = CharaDeath.DEFAULT;
  constructor(type: number, init?: Partial<ObjectHitInfo>) {
    this.type = type;
    if (init) Object.assign(this, init);
  }
}

interface DeathServerData { player: PlayerModel; deathType: number; assistSlot: number }
interface AssistServerData { roomId: number; killer: number; victim: number; isKiller: boolean; victimDead: boolean; isAssist: boolean }

export class RoomModel {
  players: PlayerModel[] = [];
  objects: ObjectInfo[] = [];
  lastStartTick = 0;
  uniqueRoomId: number;
  roomSeed: number;
  objsSyncRound = 0;
  serverRound = 0;
  sourceToMap = -1;
  serverId = 0;
  roomId = 0;
  channelId = 0;
  lastRound = 0;
  bar1 = 6000;
  bar2 = 6000;
  default1 = 6000;
  default2 = 6000;
  /** cumulative objective damage per slot this round (the server's SlotModel.DamageBar1; 5166 sends it) */
  slotDamage: number[] = new Array(18).fill(0);
  dropCounter = 0;
  botMode = false;
  hasC4 = false;
  isTeamSwap = false;
  mapId = 0;
  rule = 0;
  roomType = 0;
  map: MapModel | null = null;
  bombPosition: Half3 = { ...HALF0 };
  startTime = 0;
  lastObjsSync = 0;
  lastPlayersSync = 0;
  /**groups (weaponGroup) of the items dropped in this room, the only ones a pick-up may add to a loadout */
  dropped = new Set<number>();
  /**slots dropped for strikes, refused if they register again */
  kicked = new Set<number>();
  constructor(uid: number, seed: number) {
    this.uniqueRoomId = uid >>> 0;
    this.roomSeed = seed >>> 0;
    for (let i = 0; i < 18; ++i) this.players[i] = new PlayerModel(i);
    for (let i = 0; i < 200; ++i) this.objects[i] = new ObjectInfo(i);
  }
  getPlayer(slot: number): PlayerModel | null { return this.players[slot] ?? null; }
  getActive(slot: number): PlayerModel | null { const p = this.getPlayer(slot); return p && p.client !== null ? p : null; }
  getByPeer(slot: number, peer: string): PlayerModel | null { const p = this.getPlayer(slot); return p && p.compareIp(peer) ? p : null; }
  getObject(id: number): ObjectInfo | null { return this.objects[id] ?? null; }
  objectsIsValid(): boolean { return this.serverRound === this.objsSyncRound; }
  getPlayersCount(): number { return this.players.filter((p) => p.client !== null).length; }
}

// ------------------------------------------------------------------ host handoff snapshot (MatchCore.snapshot / restore)

/** bump when a field of the snapshot changes meaning: restore() refuses another version (the new host then starts a fresh core) */
export const SNAPSHOT_VERSION = 1;

export interface PlayerSnapshot {
  slot: number; team: number; life: number; maxLife: number; playerIdByUser: number; playerIdByServer: number;
  respawnByUser: number; respawnByServer: number; ping: number; latency: number; weaponId: number; accessory: number;
  extensions: number; plantDuration: number; defuseDuration: number; c4Time: number; position: Half3;
  /** ms on the old host's clock (0 = never) */
  startTime: number; lastPing: number; lastDie: number; c4First: number;
  equip: Equipment | null; weaponClass: number; dead: boolean; neverRespawn: boolean; integrity: boolean; immortal: boolean;
  /** a peer was registered on this slot (its guest registers again on the new host) */
  connected: boolean;
  /** PlayerModel.loadout (absent in an older snapshot: rebuilt from equip) */
  loadout?: number[] | null;
}
export interface ObjectSnapshot { id: number; life: number; destroyState: number; animation: AnimModel | null; useDate: number; model: boolean }
export interface RoomSnapshot {
  uniqueRoomId: number; roomSeed: number; lastStartTick: number; objsSyncRound: number; serverRound: number; sourceToMap: number;
  serverId: number; roomId: number; channelId: number; lastRound: number; bar1: number; bar2: number; default1: number; default2: number; slotDamage: number[];
  dropCounter: number; botMode: boolean; hasC4: boolean; isTeamSwap: boolean; mapId: number; rule: number; roomType: number;
  bombPosition: Half3; startTime: number; lastObjsSync: number; lastPlayersSync: number;
  players: PlayerSnapshot[];
  objects: ObjectSnapshot[];
  /** RoomModel.dropped / kicked (absent in an older snapshot) */
  dropped?: number[];
  kicked?: number[];
}
export interface MatchSnapshot {
  v: number;
  /** the old host's now() when taken: every ms field above is on that clock */
  now: number;
  rooms: RoomSnapshot[];
  assists: AssistServerData[];
  pendingRespawn: [string, RespawnSyncIn][];
}

// ------------------------------------------------------------------ Match -> Game messages (SendMatchInfo)

export type GameSyncOut =
  | { t: "death"; room: RoomRef; killerSlot: number; objectId: number; weaponId: number; killerPos: [number, number, number];
      deaths: { slot: number; weaponClass: number; deathType: number; pos: [number, number, number]; assistSlot: number }[] }
  | { t: "bomb"; room: RoomRef; type: number; slot: number; bombArea: number; pos: [number, number, number] }
  | { t: "hitMarker"; room: RoomRef; slot: number; deathType: number; hitEnum: number; damage: number }
  | { t: "sabotage"; room: RoomRef; slot: number; bar1: number; bar2: number; ultraSync: number; damage: number; slotDamage: number[] }
  | { t: "ping"; room: RoomRef; slot: number; ping: number; latency: number }
  | { t: "portal"; room: RoomRef; slot: number; portal: number };
export interface RoomRef { roomId: number; channelId: number; serverId: number; uniqueRoomId: number; roomSeed: number }

/** Game -> Match RespawnSync (Server.Game EquipmentSync.SendUDPPlayerSync, opcode 1). */
export interface RespawnSyncIn {
  uniqueRoomId: number;
  roomSeed: number;
  /** Room.StartTick, ms here (only its increase matters: ResyncTick) */
  startTick: number;
  /** 0 first respawn, 2 later ones, 1 the round-start re-sync (RoomModel 2248) */
  type: number;
  round: number;
  slot: number;
  respawnCount: number;
  /** low byte of the account PlayerId; undefined = trust what the slot registered with */
  accountId?: number;
  charaId?: number;
  hpBonus?: number;
  c4SpeedKit?: boolean;
  weapons?: { primary: number; secondary: number; melee: number; explosive: number; special: number };
  accessory?: number;
}

export interface CoreOut {
  /** a datagram for a peer; reliable = carries events a loss would drop for good (hits, deaths, drops, radio, ...) */
  send(peer: string, data: Uint8Array, reliable: boolean): void;
  game?(m: GameSyncOut): void;
  log?(line: string): void;
  /** anti-cheat rejections (rate limited per slot and reason); falls back to log */
  warn?(line: string): void;
  /** strikeLimit reached: close this peer's link (never called for hostPeer) */
  kick?(peer: string, reason: string): void;
}

export interface MatchCoreOptions {
  config?: Partial<MatchConfig>;
  data?: MatchData;
  now?: () => number;
  random?: () => number;
  /** P2P: the one room this host serves (RoomsManager.CreateOrGetRoom refuses the others) */
  allowRoom?: (uniqueRoomId: number, roomSeed: number) => boolean;
  /** the 7 random bytes of Udp121Cipher.EncryptServerToClient (tests: replay a C# datagram) */
  cipherBytes?: () => Uint8Array;
  /** P2P: the leader's own link (LocalPeer). Only it may send records for another slot (the AI seats it simulates) and it is
   * never kicked. Absent = every peer may (Server.Match) */
  hostPeer?: (peer: string) => boolean;
}

/** events whose loss the receiver never recovers from: these datagrams go on the reliable channel */
const RELIABLE_EVENTS = Ev.HitData | Ev.GrenadeHit | Ev.Suicide | Ev.DropWeapon | Ev.GetWeaponForClient | Ev.RadioChat
  | Ev.MissionData | Ev.UseObject | Ev.CharaFireNHitData | Ev.GetWeaponForHost | Ev.FireDataOnObject | Ev.FireNHitDataOnObject
  | Ev.SeizeDataForClient | Ev.WeaponSync;

interface PacketModel {
  data: Uint8Array;
  /** the sender (MatchClient's IPEndPoint) */
  peer: string;
  receiveDate: number;
  opcode: number; slot: number; time: number; round: number; length: number; respawn: number; roundNumber: number;
  accountId: number; unk1: number; unk2: number;
  withEnd: Uint8Array | null;
  withoutEnd: Uint8Array | null;
}

interface ActionModel { length: number; slot: number; subHead: number; flag: number; data: Uint8Array }

// ------------------------------------------------------------------ the core

export class MatchCore {
  readonly cfg: MatchConfig;
  readonly rooms: RoomModel[] = [];
  private readonly assists: AssistServerData[] = [];
  private readonly data: MatchData;
  readonly now: () => number;
  readonly random: () => number;
  private readonly out: CoreOut;
  private readonly allowRoom: (uid: number, seed: number) => boolean;
  private readonly cipherBytes: () => Uint8Array;
  /** RESPAWN syncs for a slot that had not registered yet (see respawnSync) */
  private readonly pendingRespawn = new Map<string, RespawnSyncIn>();
  private readonly hostPeer: ((peer: string) => boolean) | null;
  /** (c): accepted hit times per slot + weapon (+ victim for a multi-target weapon) */
  private readonly fireLog = new Map<string, number[]>();
  /** hard rejection times per room + slot */
  private readonly strikes = new Map<string, number[]>();
  private readonly warned = new Map<string, { at: number; n: number }>();
  stats = { rx: 0, tx: 0, relayed: 0, dropped: 0, rejected: 0 };

  constructor(out: CoreOut, opts: MatchCoreOptions = {}) {
    this.out = out;
    this.cfg = { ...DEFAULT_CONFIG, ...opts.config };
    this.data = opts.data ?? { charaHp: {}, maps: {} };
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
    this.allowRoom = opts.allowRoom ?? (() => true);
    this.cipherBytes = opts.cipherBytes ?? (() => crypto.getRandomValues(new Uint8Array(7)));
    this.hostPeer = opts.hostPeer ?? null;
  }

  private log(line: string): void { this.out.log?.(line); }
  private duration(ms: number): number { return (this.now() - ms) / 1000; }
  private send(peer: string | null, data: Uint8Array, reliable: boolean): void {
    if (!peer || data.length === 0) return;
    this.stats.tx++;
    this.out.send(peer, data, reliable);
  }
  private ref(room: RoomModel): RoomRef {
    return { roomId: room.roomId, channelId: room.channelId, serverId: room.serverId, uniqueRoomId: room.uniqueRoomId, roomSeed: room.roomSeed };
  }

  // ---------------------------------------------------------------- RoomsManager

  getRoom(uid: number, seed: number): RoomModel | null {
    return this.rooms.find((r) => r.uniqueRoomId === uid >>> 0 && r.roomSeed === seed >>> 0) ?? null;
  }
  private createOrGetRoom(uid: number, seed: number): RoomModel | null {
    const r = this.getRoom(uid, seed);
    if (r) return r;
    if (!this.allowRoom(uid >>> 0, seed >>> 0)) {
      this.log(`register for a room this host does not serve (uid 0x${(uid >>> 0).toString(16)} seed 0x${(seed >>> 0).toString(16)})`);
      return null;
    }
    const room = new RoomModel(uid, seed);
    room.serverId = roomInfo(uid, 2);
    room.channelId = roomInfo(uid, 1);
    room.roomId = roomInfo(uid, 0);
    room.mapId = seedInfo(seed, 2);
    room.roomType = seedInfo(seed, 0);
    room.rule = seedInfo(seed, 1);
    this.rooms.push(room);
    return room;
  }
  private removeRoom(room: RoomModel): void {
    const i = this.rooms.indexOf(room);
    if (i >= 0) this.rooms.splice(i, 1);
  }

  // ---------------------------------------------------------------- BeginReceive / ReadPacket

  /** One datagram from `peer` (MatchManager.OnReceiveData: 22..8096 bytes). */
  receive(peer: string, buf: Uint8Array): void {
    if (buf.length < 22 || buf.length > 8096) return;
    this.stats.rx++;
    const r = new SyncReader(buf);
    const p: PacketModel = {
      data: buf, peer, receiveDate: this.now(),
      opcode: r.c(), slot: r.c(), time: r.t(), round: r.c(), length: r.uh(), respawn: r.c(), roundNumber: r.c(),
      accountId: r.c(), unk1: r.c(), unk2: r.ud(), withEnd: null, withoutEnd: null,
    };
    if (p.length <= 0 || p.length > buf.length) return;
    this.getDecryptedData(p);
    if (!p.withEnd || !p.withoutEnd) return;
    if (p.withEnd.length < 4) return;
    try {
      const c = new SyncReader(p.withEnd);
      switch (p.opcode) {
        case 3: this.processPvp(peer, c, p, p.withoutEnd.length); break;
        case 65: this.processRegister(peer, c, p); break;
        case 67: this.processUnregister(peer, c, p); break;
        case 97: this.processPing(peer, c, p); break;
        case 4: case 131: case 132: this.stats.dropped++; this.log(`opcode ${p.opcode} (AI / bot mode) is not ported`); break;
        default: this.log(`MATCH Opcode Not Found: [${p.opcode}]`);
      }
    } catch (e) {
      this.log(`ReadPacket Exception: Opcode=${p.opcode} - ${(e as Error).message}`);
    }
  }

  private getDecryptedData(p: PacketModel): void {
    try {
      if (isUdp121Handshake(p)) {
        const w = new PacketWriter(13).writeH(-31247).writeH(1733);
        w.writeB(p.data.subarray(29, 37)).writeC(p.data[37]);
        p.withEnd = w.toBytes();
        p.withoutEnd = new Uint8Array(0);
        return;
      }
      if ((p.opcode === 3 || p.opcode === 4 || p.opcode === 131 || p.opcode === 132) && tryDecryptUdp121(p)) return;
      if (p.data.length >= p.length) {
        const src = bitwiseDecrypt(p.data.slice(17, p.length), (p.length % 6) + 1);
        if (src.length - 9 < 0) throw new Error("Arithmetic operation resulted in an overflow.");
        p.withEnd = src;
        p.withoutEnd = src.slice(0, src.length - 9);
      }
    } catch (e) {
      this.log((e as Error).message);
    }
  }

  // ---------------------------------------------------------------- 65 / 67

  private processRegister(peer: string, c: SyncReader, p: PacketModel): void {
    const version = `${c.h()}.${c.h()}`;
    c.advance(p.withoutEnd!.length - 4);
    const uid = c.ud();
    const seed = c.ud();
    c.c(); // DedicationSlot
    const room = this.createOrGetRoom(uid, seed);
    if (!room) return;
    const player = this.addPlayer(room, peer, p, version);
    if (!player) return;
    if (!player.integrity && !player.restoreKeep) player.resetBattleInfos(this.cfg);
    player.restoreKeep = false;
    this.send(player.client, PROTOCOL_CONNECT, true);
    this.log(`Player Connected. [${peer}] slot ${p.slot}`);
    const pend = this.pendingRespawn.get(`${room.uniqueRoomId}:${room.roomSeed}:${p.slot}`);
    if (pend) {
      this.pendingRespawn.delete(`${room.uniqueRoomId}:${room.roomSeed}:${p.slot}`);
      this.respawnSync(pend);
    }
  }

  private processUnregister(peer: string, c: SyncReader, p: PacketModel): void {
    const version = `${c.h()}.${c.h()}`;
    c.advance(p.withoutEnd!.length - 4);
    const uid = c.ud();
    const seed = c.ud();
    c.c();
    const room = this.getRoom(uid, seed);
    if (!room) return;
    if (this.removePlayer(room, peer, p.slot, version)) this.log(`Player Disconnected. [${peer}] slot ${p.slot}`);
    if (room.getPlayersCount() === 0) this.removeRoom(room);
  }

  private addPlayer(room: RoomModel, peer: string, p: PacketModel, udp: string): PlayerModel | null {
    if (this.cfg.udpVersion !== udp) {
      this.log(`Wrong UDP Version (${udp}); Player can't be connected into it!`);
      return null;
    }
    const player = room.players[p.slot];
    if (!player) { this.log("Index was outside the bounds of the array."); return null; }
    if (room.kicked.has(p.slot)) { this.log(`slot ${p.slot} was dropped by the anti-cheat: register refused`); return null; }
    if (!player.compareIp(peer)) {
      player.client = peer;
      player.startTime = p.receiveDate;
      player.playerIdByUser = p.accountId;
      return player;
    }
    return null;
  }

  private removePlayer(room: RoomModel, peer: string, slot: number, udp: string): boolean {
    if (this.cfg.udpVersion !== udp) return false;
    const player = room.players[slot];
    if (player?.compareIp(peer)) {
      player.resetAllInfos(this.cfg);
      return true;
    }
    return false;
  }

  /** P2P: the peer's link is gone (a UDP client just goes quiet; here the host knows). Same as its 67. */
  peerClosed(peer: string): void {
    for (const room of [...this.rooms]) {
      for (const pl of room.players) if (pl.client === peer) pl.resetAllInfos(this.cfg);
      if (room.getPlayersCount() === 0) this.removeRoom(room);
    }
  }

  // ---------------------------------------------------------------- 97

  private processPing(peer: string, c: SyncReader, p: PacketModel): void {
    const uid = c.ud();
    c.c();
    const seed = c.ud();
    const room = this.getRoom(uid, seed);
    if (!room) return;
    const player = room.getByPeer(p.slot, peer);
    if (!player) return;
    player.lastPing = p.receiveDate;
    this.send(peer, p.data, false);
    if (this.cfg.sendPingSync) {
      // AllUtils.PingTime is an ICMP ping of the client's address: not possible from a browser; 0 ms -> grade 5
      player.latency = 0;
      player.ping = 5;
      this.out.game?.({ t: "ping", room: this.ref(room), slot: player.slot, ping: player.ping, latency: player.latency });
    }
  }

  // ---------------------------------------------------------------- 3

  private processPvp(peer: string, c: SyncReader, p: PacketModel, basicLen: number): void {
    c.advance(basicLen);
    const uid = c.ud();
    const ded = c.c();
    const seed = c.ud();
    const room = this.getRoom(uid, seed);
    if (!room) return;
    const player1 = room.getByPeer(p.slot, peer);
    if (!player1 || player1.playerIdByServer !== p.accountId) { this.stats.dropped++; return; }
    player1.respawnByUser = p.respawn;
    if (room.startTime === 0) { this.stats.dropped++; return; }
    const res = this.writePlayerActionData(p.withoutEnd!, room, p.time, p);
    const code = this.baseWriteCode(4, res.actions, room.botMode ? p.slot : 255, this.duration(room.startTime), p.round, p.respawn, p.roundNumber, p.accountId);
    const flag1 = !room.botMode && ded !== 255;
    for (const player2 of room.players) {
      const flag2 = player2.slot !== p.slot;
      if (player2.client !== null && player1.accountIdIsValid() && ((ded === 255 && flag2) || (room.botMode && flag2) || flag1)) {
        this.stats.relayed++;
        this.send(player2.client, code, res.reliable);
      }
    }
  }

  /** WritePlayerActionData: up to 18 records, each re-encoded by Method0; the events (Objs) appended at the end. */
  private writePlayerActionData(data: Uint8Array, room: RoomModel, time: number, packet: PacketModel): { actions: Uint8Array; reliable: boolean } {
    const C = new SyncReader(data);
    let objs: ObjectHitInfo[] = [];
    const S = new PacketWriter(data.length + 64);
    let reliable = false;
    for (let index = 0; index < 18; ++index) {
      try {
        let stop = false;
        const length = C.uhEx();
        if (length === null) break;
        const slot = C.uh();
        const subHead = C.c();
        if (subHead === 255) break;
        S.writeH(length).writeH(slot).writeC(subHead);
        switch (subHead) {
          case Sub.User:
          case Sub.StageInfoChara: {
            const a: ActionModel = { length, slot, subHead, flag: C.ud(), data: C.b(length - 9) };
            if (slot !== packet.slot && this.hostPeer && !this.hostPeer(packet.peer)) {
              // a guest speaks for its own slot only (runtime.ts holds it to its header slot; the records inside are
              // checked here): only the host sends the records of the AI seats it simulates. Not relayed.
              S.length -= 5;
              this.reject(room, packet, "record", `a record for slot ${slot}`, true);
              if (a.data.length === 0 && a.length - 9 !== 0) stop = true;
              break;
            }
            // AllUtils.CheckDataFlags
            if (has(a.flag, Ev.WeaponSync) && packet.opcode !== 4 && (a.flag & (Ev.DropWeapon | Ev.GetWeaponForClient)) !== 0) a.flag = (a.flag - Ev.WeaponSync) >>> 0;
            const m = this.method0(a, room, time, packet);
            objs.push(...m.objs);
            if (a.flag & RELIABLE_EVENTS) reliable = true;
            S.length -= 5; // GoBack(5)
            S.writeH(m.out.length + 9).writeH(a.slot).writeC(a.subHead).writeD(a.flag).writeB(m.out);
            if (a.data.length === 0 && a.length - 9 !== 0) stop = true;
            break;
          }
          case Sub.Grenade: S.writeB(C.b(4)).writeH(C.uh()).writeD(C.d32()).writeC(C.c()).writeC(C.c()).writeH(C.uh()).writeH(C.uh()).writeH(C.uh()).writeD(C.d32()).writeD(C.d32()).writeD(C.d32()); reliable = true; break; // web: throw / trigger / explode one-shots
          case Sub.DroppedWeapon: writeHV(S, C.uhv()); S.writeH(C.uh()).writeH(C.uh()).writeH(C.uh()).writeH(C.uh()).writeC(C.c()).writeB(C.b(16)); reliable = true; break;
          case Sub.ObjectStatic: S.writeH(C.uh()).writeH(C.uh()).writeC(C.c()); reliable = true; break;
          case Sub.ObjectMove: S.writeB(C.b(16)); break;
          case Sub.ObjectAnim: S.writeH(C.uh()).writeC(C.c()).writeC(C.c()).writeT(C.t()); reliable = true; break;
          case Sub.StageInfoObjectStatic: S.writeC(C.c()); reliable = true; break;
          case Sub.StageInfoObjectAnim: S.writeC(C.c()).writeH(C.uh()).writeT(C.t()).writeC(C.c()).writeC(C.c()); reliable = true; break;
          case Sub.StageInfoObjectControl: S.writeB(C.b(9)); reliable = true; break;
          default: this.log(`PVP Sub Head: '${subHead}'`);
        }
        if (stop) break;
      } catch (e) {
        this.log(`PVP Action Data - Buffer (Length: ${data.length}): | ${(e as Error).message}`);
        objs = [];
        break;
      }
    }
    if (objs.length > 0) {
      S.writeB(eventsActionCode(objs));
      reliable = true;
    }
    return { actions: S.toBytes(), reliable };
  }

  /** MatchClient.Method0: one User / StageInfoChara record, events in the server's order. Throws where the C# throws. */
  private method0(A: ActionModel, room: RoomModel, time: number, packet: PacketModel): { objs: ObjectHitInfo[]; out: Uint8Array } {
    const objs: ObjectHitInfo[] = [];
    if (A.data.length === 0) return { objs, out: new Uint8Array(0) };
    const C = new SyncReader(A.data);
    const S = new PacketWriter(A.data.length + 16);
    let num1 = 0;
    const player = room.getPlayer(A.slot);
    const cfg = this.cfg;

    if (has(A.flag, Ev.ActionState)) {
      num1 += Ev.ActionState;
      const action = C.uh(), value = C.c(), flag = C.c();
      if (!room.botMode && player !== null && player.equip) {
        const equip = player.equip;
        let num2 = 0, num3 = 0, num4 = 0;
        if (has(flag, WeaponSyncType.Primary)) {
          num2 = equip.wpnPrimary;
          const s1 = idStatics(equip.accessory, 1), s2 = idStatics(equip.accessory, 3);
          num3 = s1 === 30 ? s2 & 0xff : num3;
        }
        if (has(flag, WeaponSyncType.Secondary)) num2 = equip.wpnSecondary;
        if (has(flag, WeaponSyncType.Melee)) num2 = equip.wpnMelee;
        if (has(flag, WeaponSyncType.Explosive)) num2 = equip.wpnExplosive;
        if (has(flag, WeaponSyncType.Special)) num2 = equip.wpnSpecial;
        if (has(flag, WeaponSyncType.Mission) && room.roomType === RoomCondition.Bomb) num2 = 5009001;
        if (has(flag, WeaponSyncType.Dual)) {
          num4 = 16;
          if (has(action, ActionFlag.Unk2048)) num2 = equip.wpnPrimary;
          if (has(action, ActionFlag.Unk4096)) num2 = equip.wpnPrimary;
        }
        if (has(flag, WeaponSyncType.Ext)) {
          num4 = 16;
          if (has(action, ActionFlag.Unk2048)) num2 = equip.wpnSecondary;
          if (has(action, ActionFlag.Unk4096)) num2 = equip.wpnSecondary;
        }
        objs.push(new ObjectHitInfo(6, { objId: player.slot, weaponId: num2, accessory: num3, extensions: num4 }));
      }
      S.writeH(action).writeC(value).writeC(flag);
    }
    if (has(A.flag, Ev.Animation)) {
      num1 += Ev.Animation;
      S.writeH(C.uh()).writeH(C.uh()).writeH(C.uh()).writeH(C.uh());
    }
    if (has(A.flag, Ev.PosRotation)) {
      num1 += Ev.PosRotation;
      const camX = C.uh(), camY = C.uh(), area = C.uh(), rz = C.uh(), rx = C.uh(), ry = C.uh();
      if (player) player.position = { x: rx, y: ry, z: rz };
      A.flag = (A.flag | Ev.SoundPosRotation) >>> 0;
      S.writeH(camX).writeH(camY).writeH(area).writeH(rz).writeH(rx).writeH(ry);
    }
    if (has(A.flag, Ev.SoundPosRotation)) {
      num1 += Ev.SoundPosRotation;
      S.writeT(time); // ReadInfo(Action, C, Time): the packet time, nothing read
    }
    if (has(A.flag, Ev.UseObject)) {
      num1 += Ev.UseObject;
      const n = C.c();
      const infos: { objectId: number; use: number; spaceFlags: number }[] = [];
      for (let i = 0; i < n; i++) infos.push({ objectId: C.uh(), use: C.c(), spaceFlags: C.c() });
      for (let index = 0; index < infos.length; ++index) {
        const u = infos[index];
        if (!room.botMode && u.objectId !== 0xffff) {
          const oi = room.getObject(u.objectId);
          if (oi) {
            let flag = false;
            if (has(u.spaceFlags, CharaMoves.HeliInMove) && oi.useDate === 0) flag = true; // UseDate "0101010000" = never used
            if (has(u.spaceFlags, CharaMoves.HeliStopped)) {
              const anim = oi.animation;
              if (anim && anim.id === 0) oi.model!.getAnim(this, anim.nextAnim, 0, 0, oi);
            }
            if (!flag) {
              objs.push(new ObjectHitInfo(3, {
                objSyncId: 1, objId: oi.id, objLife: oi.life, animId1: 255, animId2: oi.animation ? oi.animation.id : 255,
                specialUse: this.duration(oi.useDate),
              }));
            }
          }
        } else infos.splice(index--, 1);
      }
      S.writeC(infos.length);
      for (const u of infos) S.writeH(u.objectId).writeC(u.use).writeC(u.spaceFlags);
    }
    if (has(A.flag, Ev.ActionForObjectSync)) {
      num1 += Ev.ActionForObjectSync;
      const u1 = C.c(), u2 = C.c();
      if (player) this.syncInfo(room, objs, 1);
      S.writeC(u1).writeC(u2);
    }
    if (has(A.flag, Ev.RadioChat)) {
      num1 += Ev.RadioChat;
      S.writeC(C.c()).writeC(C.c());
    }
    if (has(A.flag, Ev.WeaponSync)) {
      const weaponId = C.d32(), accessory = C.c(), extensions = C.c();
      // a weapon the slot does not have is not relayed (the others keep the last valid one); the C4 comes from the room
      if (player && !this.statsOf(weaponId)?.mission && this.loadoutWeapon(room, player, weaponId, packet) === null) {
        A.flag = (A.flag & ~Ev.WeaponSync) >>> 0;
      } else {
        num1 += Ev.WeaponSync;
        if (player) {
          player.weaponId = weaponId;
          player.accessory = accessory;
          player.extensions = extensions;
          player.weaponClass = idStatics(weaponId, 2);
          this.syncInfo(room, objs, 2);
        }
        S.writeD(weaponId).writeC(accessory).writeC(extensions);
      }
    }
    if (has(A.flag, Ev.WeaponRecoil)) {
      num1 += Ev.WeaponRecoil;
      S.writeT(C.t()).writeT(C.t()).writeT(C.t()).writeT(C.t()).writeT(C.t()).writeC(C.c()).writeD(C.d32()).writeC(C.c()).writeC(C.c());
    }
    if (has(A.flag, Ev.HpSync)) {
      num1 += Ev.HpSync;
      S.writeH(C.uh());
    }
    if (has(A.flag, Ev.Suicide)) {
      num1 += Ev.Suicide;
      const n = C.c();
      let hits: { playerPos: Half3; weaponId: number; accessory: number; extensions: number; hitInfo: number }[] = [];
      for (let i = 0; i < n; i++) hits.push({ playerPos: C.uhv(), weaponId: C.d32(), accessory: C.c(), extensions: C.c(), hitInfo: C.ud() });
      const deaths: DeathServerData[] = [];
      if (player) {
        let objectId = -1;
        let weaponId = 0;
        for (let index = 0; index < hits.length; ++index) {
          const s = hits[index];
          if (!player.dead && player.life > 0) {
            const dmg = hitDamageBot(s.hitInfo);
            const killerId = killerIdOf(s.hitInfo);
            const objectType = objectTypeOf(s.hitInfo);
            const part = (s.hitInfo >>> 4) & 63;
            const death = charaDeathOf(s.hitInfo);
            if (objectType === 1 || objectType === 0) objectId = killerId;
            weaponId = s.weaponId;
            this.simpleDeath(room, deaths, objs, player, player, dmg, weaponId, part, death);
            if (dmg > 0) {
              if (cfg.useHitMarker) this.hitMarker(room, player, death, HitType.Normal, dmg);
              objs.push(new ObjectHitInfo(2, { objId: player.slot, objLife: player.life, hitPart: part, killerSlot: objectId, position: s.playerPos, deathType: death, weaponId }));
            }
          } else hits.splice(index--, 1);
        }
        if (deaths.length > 0) this.deathSync(room, player, objectId, weaponId, deaths);
      } else hits = [];
      S.writeC(hits.length);
      for (const s of hits) { writeHV(S, s.playerPos); S.writeD(s.weaponId).writeC(s.accessory).writeC(s.extensions).writeD(s.hitInfo); }
    }
    if (has(A.flag, Ev.MissionData)) {
      num1 += Ev.MissionData;
      const plantTime = C.t();
      let bomb = C.c();
      const bombEnum = bomb & 15, bombId = bomb >> 4;
      if (room.map && player && !player.dead && plantTime > 0 && !has(bombEnum, BombFlag.Stop)) {
        const bp = room.map.bombs[bombId] ?? null;
        if (bp) {
          const flag = has(bombEnum, BombFlag.Defuse);
          const target = flag ? room.bombPosition : has(bombEnum, BombFlag.Start) ? bp.position : HALF0;
          const num5 = dist(vec(player.position), vec(target));
          const team = swappedTeam(player, room);
          if ((bp.everyWhere || num5 <= 2) && ((team === Team.CT && flag) || (team === Team.FR && !flag))) {
            if (Math.fround(player.c4Time) !== Math.fround(plantTime)) {
              player.c4First = this.now();
              player.c4Time = plantTime;
            }
            const duration = this.duration(player.c4First);
            const num6 = flag ? player.defuseDuration : player.plantDuration;
            if ((time >= plantTime + num6 || duration >= num6) && ((!room.hasC4 && has(bombEnum, BombFlag.Start)) || (room.hasC4 && flag))) {
              room.hasC4 = !room.hasC4;
              bomb |= 2;
              this.bombSync(room, player, has(bombEnum, BombFlag.Defuse) ? 1 : 0, bombId);
            }
          }
        }
      }
      S.writeT(plantTime).writeC(bomb);
    }
    if (has(A.flag, Ev.DropWeapon)) {
      num1 += Ev.DropWeapon;
      const d = readDropInfo(C);
      room.dropped.add(this.groupOf(d.weaponId)); // what a pick-up may take
      let counter = 0;
      if (!room.botMode) {
        room.dropCounter = (room.dropCounter + 1) & 0xff;
        if (room.dropCounter > cfg.maxDropWpnCount) room.dropCounter = 0;
        counter = room.dropCounter;
        const equip = player!.equip; // C#: player.Equip before the null check (NullReferenceException)
        if (player && equip) {
          const s = idStatics(d.weaponId, 1);
          if (s === 1) equip.wpnPrimary = 0;
          if (s === 2) equip.wpnSecondary = 0;
        }
      }
      writeDropInfo(S, d, cfg, (d.flags + counter) & 0xff);
    }
    if (has(A.flag, Ev.GetWeaponForClient)) {
      num1 += Ev.GetWeaponForClient;
      const d = readDropInfo(C);
      // a pick-up adds to the loadout only an item somebody dropped in this room
      if (player?.loadout && room.dropped.has(this.groupOf(d.weaponId))) this.addToLoadout(player.loadout, d.weaponId);
      if (!room.botMode) {
        const equip = player!.equip;
        if (player && equip) {
          const s = idStatics(d.weaponId, 1);
          if (s === 1) equip.wpnPrimary = d.weaponId;
          if (s === 2) equip.wpnSecondary = d.weaponId;
        }
      }
      writeDropInfo(S, d, cfg, d.flags);
    }
    if (has(A.flag, Ev.FireData)) {
      num1 += Ev.FireData;
      S.writeC(C.c()).writeC(C.c()).writeH(C.h()).writeD(C.d32()).writeC(C.c()).writeC(C.c()).writeH(C.uh()).writeH(C.uh()).writeH(C.uh());
    }
    if (has(A.flag, Ev.CharaFireNHitData)) {
      num1 += Ev.CharaFireNHitData;
      const n = C.c();
      const recs: Uint8Array[] = [];
      for (let i = 0; i < n; i++) recs.push(new PacketWriter(18).writeD(C.d32()).writeC(C.c()).writeC(C.c()).writeD(C.ud()).writeH(C.h()).writeH(C.uh()).writeH(C.uh()).writeH(C.uh()).toBytes());
      S.writeC(recs.length);
      for (const b of recs) S.writeB(b);
    }
    if (has(A.flag, Ev.HitData)) {
      num1 += Ev.HitData;
      const n = C.c();
      let hits: HitDataInfo[] = [];
      for (let i = 0; i < n; i++) {
        const h: HitDataInfo = {
          startBullet: C.tv(), endBullet: C.tv(), bulletPos: C.tv(), boomInfo: C.uh(), objectId: C.uh(), hitIndex: C.ud(),
          weaponId: C.d32(), accessory: C.c(), extensions: C.c(), hitEnum: 0, boomPlayers: null, weaponClass: 0,
        };
        h.hitEnum = hitHelmet(h.hitIndex);
        if (h.boomInfo > 0) { h.boomPlayers = []; for (let k = 0; k < 18; ++k) if ((h.boomInfo & (1 << k)) === 1 << k) h.boomPlayers.push(k); }
        h.weaponClass = idStatics(h.weaponId, 2);
        hits.push(h);
      }
      const deaths: DeathServerData[] = [];
      if (player === null) hits = [];
      else {
        let weaponId = 0;
        const propBreak = hits.some((h) => this.noEffectObject(room, h.hitIndex, h.objectId));
        for (let index = 0; index < hits.length; ++index) {
          const hit = hits[index];
          // before the helmet skip: the web victim applies every relayed hit itself, a "helmet" one too
          if (!this.screenHit(room, player, packet, hit, propBreak)) { hits.splice(index--, 1); continue; }
          if (hit.hitEnum === HitType.HelmetProtection || hit.hitEnum === HitType.HeadshotProtection) continue;
          let damage = hitDamageNormal(hit.hitIndex);
          const objectId = hit.objectId;
          const part = hitPart(hit.hitIndex);
          let deathType: number = CharaDeath.DEFAULT;
          weaponId = hit.weaponId;
          const ht = hitType(hit.hitIndex);
          switch (ht) {
            case ObjectType.User: {
              const victim = room.getPlayer(objectId);
              if (victim && player.respawnIsValid() && !player.dead && !victim.dead && !victim.immortal) {
                if (part === CharaHitPart.HEAD) deathType = CharaDeath.HEADSHOT;
                if (room.roomType === RoomCondition.DeathMatch && room.rule === MapRules.HeadHunter && deathType !== CharaDeath.HEADSHOT) damage = 1;
                else if (room.roomType !== RoomCondition.Boss || deathType !== CharaDeath.HEADSHOT) {
                  if (room.roomType === RoomCondition.DeathMatch && room.rule === MapRules.Chaos) damage = 200;
                } else if ((room.lastRound === 1 && victim.team === Team.FR) || (room.lastRound === 2 && victim.team === Team.CT)) damage = Math.trunc(damage / 10);
                this.simpleDeath(room, deaths, objs, player, victim, damage, weaponId, part, deathType);
                if (damage > 0) {
                  if (cfg.useHitMarker) this.hitMarker(room, player, deathType, hit.hitEnum, damage);
                  objs.push(new ObjectHitInfo(2, { objId: victim.slot, objLife: victim.life, hitPart: part, killerSlot: player.slot, position: halfSub(victim.position, player.position), deathType, weaponId }));
                }
                continue;
              }
              hits.splice(index--, 1);
              continue;
            }
            case ObjectType.UserObject:
              continue;
            case ObjectType.Object: {
              const oi = room.getObject(objectId);
              const model = oi?.model ?? null;
              if (oi && model && model.destroyable) {
                if (oi.life > 0) {
                  oi.life -= damage;
                  if (oi.life <= 0) {
                    oi.life = 0;
                    this.boomDeath(room, player, damage, weaponId, deaths, objs, hit.boomPlayers, CharaHitPart.ALL, CharaDeath.OBJECT_EXPLOSION);
                  }
                  oi.destroyState = model.checkDestroyState(oi.life);
                  this.sabotageDestroy(room, player, model, oi, damage);
                  const duration = this.duration(oi.useDate);
                  if (oi.animation && oi.animation.duration > 0 && duration >= oi.animation.duration) oi.model!.getAnim(this, oi.animation.nextAnim, duration, oi.animation.duration, oi);
                  objs.push(new ObjectHitInfo(model.updateId, {
                    objId: oi.id, objLife: oi.life, killerSlot: A.slot, objSyncId: model.needSync ? 1 : 0, specialUse: duration,
                    animId1: model.animation, animId2: oi.animation ? oi.animation.id : 255, destroyState: oi.destroyState,
                  }));
                }
                continue;
              }
              if (cfg.sendFailMsg && model === null) this.log(`Fire Obj: ${objectId} Map: ${room.mapId} Invalid Object.`);
              continue;
            }
            default:
              this.log(`HitType: (${ht}) Slot: ${A.slot}`);
              continue;
          }
        }
        if (deaths.length > 0) this.deathSync(room, player, 255, weaponId, deaths);
      }
      S.writeC(hits.length);
      for (const h of hits) {
        writeTV(S, h.startBullet); writeTV(S, h.endBullet); writeTV(S, h.bulletPos);
        S.writeH(h.boomInfo).writeH(h.objectId).writeD(h.hitIndex).writeD(h.weaponId).writeC(h.accessory).writeC(h.extensions);
      }
    }
    if (has(A.flag, Ev.GrenadeHit)) {
      num1 += Ev.GrenadeHit;
      const n = C.c();
      let hits: GrenadeHitInfo[] = [];
      for (let i = 0; i < n; i++) {
        const h: GrenadeHitInfo = {
          weaponId: C.d32(), accessory: C.c(), extensions: C.c(), boomInfo: C.uh(), objectId: C.uh(), hitInfo: C.ud(),
          playerPos: C.uhv(), firePos: C.uhv(), hitPos: C.uhv(), grenadesCount: C.uh(), deathType: C.c(), hitEnum: 0, boomPlayers: null, weaponClass: 0,
        };
        h.hitEnum = hitHelmet(h.hitInfo);
        if (h.boomInfo > 0) { h.boomPlayers = []; for (let k = 0; k < 18; ++k) if ((h.boomInfo & (1 << k)) === 1 << k) h.boomPlayers.push(k); }
        h.weaponClass = idStatics(h.weaponId, 2);
        hits.push(h);
      }
      const deaths: DeathServerData[] = [];
      if (player) {
        let num7 = -1;
        let weaponId = 0;
        for (let index = 0; index < hits.length; ++index) {
          const hit = hits[index];
          const v = this.screenGrenadeHit(room, player, packet, hit);
          if (v === null) { hits.splice(index--, 1); continue; }
          let damage = v;
          const objectId = hit.objectId;
          const part = hitPart(hit.hitInfo);
          weaponId = hit.weaponId;
          const ht = hitType(hit.hitInfo);
          switch (ht) {
            case ObjectType.User: {
              ++num7;
              const victim = room.getPlayer(objectId);
              if (damage > 0 && victim && player.respawnIsValid() && !victim.dead && !victim.immortal) {
                const team = num7 % 2 === 0 ? Team.FR : Team.CT;
                if (hit.deathType === CharaDeath.MEDICAL_KIT) {
                  victim.life += damage;
                  victim.checkLifeValue();
                } else if (hit.deathType === CharaDeath.BOOM && hit.weaponClass !== ClassDino && (team === Team.FR || team === Team.CT)) {
                  damage = Math.ceil(damage / 2.7);
                  this.simpleDeath(room, deaths, objs, player, victim, damage, weaponId, part, hit.deathType);
                } else this.simpleDeath(room, deaths, objs, player, victim, damage, weaponId, part, hit.deathType);
                if (damage > 0) {
                  if (cfg.useHitMarker) this.hitMarker(room, player, hit.deathType, hit.hitEnum, damage);
                  objs.push(new ObjectHitInfo(2, { objId: victim.slot, objLife: victim.life, hitPart: part, killerSlot: player.slot, position: halfSub(victim.position, player.position), deathType: hit.deathType, weaponId }));
                }
                continue;
              }
              hits.splice(index--, 1);
              continue;
            }
            case ObjectType.UserObject:
              continue;
            case ObjectType.Object: {
              const oi = room.getObject(objectId);
              const model = oi?.model ?? null;
              if (oi && model && model.destroyable && oi.life > 0) {
                oi.life -= damage;
                if (oi.life <= 0) {
                  oi.life = 0;
                  this.boomDeath(room, player, damage, weaponId, deaths, objs, hit.boomPlayers, CharaHitPart.ALL, CharaDeath.OBJECT_EXPLOSION);
                }
                oi.destroyState = model.checkDestroyState(oi.life);
                this.sabotageDestroy(room, player, model, oi, damage);
                if (damage > 0) {
                  objs.push(new ObjectHitInfo(model.updateId, {
                    objId: oi.id, objLife: oi.life, killerSlot: A.slot, objSyncId: model.needSync ? 1 : 0, animId1: model.animation,
                    animId2: oi.animation ? oi.animation.id : 255, destroyState: oi.destroyState, specialUse: this.duration(oi.useDate),
                  }));
                }
                continue;
              }
              continue;
            }
            default:
              continue;
          }
        }
        if (deaths.length > 0) this.deathSync(room, player, 255, weaponId, deaths);
      } else hits = [];
      S.writeC(hits.length);
      for (const h of hits) {
        S.writeD(h.weaponId).writeC(h.accessory).writeC(h.extensions).writeH(h.boomInfo).writeH(h.objectId).writeD(h.hitInfo);
        writeHV(S, h.playerPos); writeHV(S, h.firePos); writeHV(S, h.hitPos);
        S.writeH(h.grenadesCount).writeC(h.deathType);
      }
    }
    if (has(A.flag, Ev.GetWeaponForHost)) {
      num1 += Ev.GetWeaponForHost;
      S.writeC(C.c()).writeH(C.uh()).writeH(C.uh()).writeH(C.uh()).writeC(C.c()).writeD(C.d32()).writeC(C.c());
    }
    if (has(A.flag, Ev.FireDataOnObject)) {
      num1 += Ev.FireDataOnObject;
      S.writeC(C.c()).writeC(C.c()).writeC(C.c());
    }
    if (has(A.flag, Ev.FireNHitDataOnObject)) {
      num1 += Ev.FireNHitDataOnObject;
      const portal = C.uh();
      if (player && !player.dead) this.portalPass(room, player, portal);
      S.writeH(portal);
    }
    if (has(A.flag, Ev.SeizeDataForClient)) {
      num1 += Ev.SeizeDataForClient;
      S.writeT(C.t()).writeC(C.c());
    }
    if (num1 >>> 0 !== A.flag >>> 0) this.log(`PVP - Missing Flag Events: '${A.flag >>> 0}' | '${(A.flag - num1) >>> 0}'`);
    return { objs, out: S.toBytes() };
  }

  // ---------------------------------------------------------------- anti-cheat
  // Server.Match trusted the PB client (AntiScript = False). Here every guest's browser is untrusted, so each hit of a record
  // passes (b) loadout -> (a) damage / range -> (c) fire rate before it is relayed or applied; a failing hit is dropped and
  // logged, a hard failure ((a), (b), a record for another slot) is a strike. The leader's own hits pass the same checks.

  /**for one HitData: false = drop it. `propBreak`: the same record breaks a prop (its blast may ride these hits) */
  private screenHit(room: RoomModel, player: PlayerModel, pk: PacketModel, hit: HitDataInfo, propBreak: boolean): boolean {
    if (this.noEffectObject(room, hit.hitIndex, hit.objectId)) return true; // a web prop break (battle.ts PROP_ID_BASE): cosmetic
    const w = this.loadoutWeapon(room, player, hit.weaponId, pk);
    if (w === null) return false;
    const st = this.statsOf(w);
    const raw = hitDamageNormal(hit.hitIndex);
    if (this.cfg.antiScript) {
      if (!st) return this.reject(room, pk, "stats", `The Item Statistic was not found. Please add: ${hit.weaponId} to config!`, true);
      const blast = propBreak ? this.data.propBlast?.[room.mapId] ?? 0 : 0;
      if (this.validateHitData(raw, hit, st, w, blast) === null) {
        return this.reject(room, pk, "damage", `hit ${raw} part ${hitPart(hit.hitIndex)} with ${hit.weaponId} on ${hit.objectId}`, true);
      }
    }
    return this.underFireRate(room, player, pk, w, st, hitType(hit.hitIndex) === ObjectType.Object ? `o${hit.objectId}` : `u${hit.objectId}`);
  }

  /**for one GrenadeHit (the web client never sends one): the damage to apply, null = drop it */
  private screenGrenadeHit(room: RoomModel, player: PlayerModel, pk: PacketModel, hit: GrenadeHitInfo): number | null {
    const w = this.loadoutWeapon(room, player, hit.weaponId, pk);
    if (w === null) return null;
    const v = this.validateGrenadeHit(hitDamageNormal(hit.hitInfo), hit, w);
    if (v === null) { this.reject(room, pk, "damage", `grenade hit ${hitDamageNormal(hit.hitInfo)} with ${hit.weaponId}`, true); return null; }
    const victim = hitType(hit.hitInfo) === ObjectType.Object ? `o${hit.objectId}` : `u${hit.objectId}`;
    return this.underFireRate(room, player, pk, w, this.statsOf(w), victim) ? v : null;
  }

  /** AllUtils.ValidateHitData with antiScript on, for the resolved item `w`. Deviations, each because a web hit
   * would fail the original: the cap is never below the honest maximum, max(pef / blade base) x PART_RATE_MAX x
   * (1 + DAMAGE_UP_MAX) (Cheytac: XML 95, pef 173); a head hit is capped at HEAD_DAMAGE_MAX (unchecked in the original, and
   * not on a map object, which takes the damage as is); a record that breaks a prop may carry its blast (`blast`). */
  private validateHitData(raw: number, hit: HitDataInfo, st: ItemStat, w: number, blast: number): number | null {
    const cls = itemClassified(idStatics(w, 2));
    const num1 = dist(vec(hit.startBullet), vec(hit.endBullet));
    if (cls === 3 || num1 <= st.range) {
      if (cls === 3 && num1 > st.range) return null;
      if (hitPart(hit.hitIndex) !== CharaHitPart.HEAD || hitType(hit.hitIndex) === ObjectType.Object) {
        const num2 = cls === 3 ? st.damage : st.damage + Math.trunc((st.damage * 30) / 100);
        const honest = Math.trunc((st.damageMax ?? st.damage) * PART_RATE_MAX * (1 + DAMAGE_UP_MAX) + 0.5);
        if (raw > Math.max(num2, honest, blast)) return null;
      } else if (raw > HEAD_DAMAGE_MAX) return null;
      return raw;
    }
    return null;
  }

  /** AllUtils.ValidateGrenadeHit, for the resolved item `w` */
  private validateGrenadeHit(raw: number, hit: GrenadeHitInfo, w: number): number | null {
    if (!this.cfg.antiScript) return raw * 2;
    const st = this.statsOf(w);
    if (!st) { this.log(`The Item Statistic was not found. Please add: ${hit.weaponId} to config!`); return null; }
    if (itemClassified(idStatics(w, 2)) === 4) {
      if (dist(vec(hit.firePos), vec(hit.hitPos)) > st.range || raw > st.damage) return null;
    }
    return raw * 2;
  }

  /** a hit on an object Server.Match has no model for (the web's prop breaks, PROP_ID_BASE): it changes nothing here */
  private noEffectObject(room: RoomModel, hitIndex: number, objectId: number): boolean {
    return hitType(hitIndex) === ObjectType.Object && !room.getObject(objectId)?.model;
  }

  private groupOf(id: number): number { return this.data.weaponGroup?.[id] ?? id; }
  /** itemStats of an item, or of its name group's first id (a legacy WEAPON_IDS id, battle.ts) */
  private statsOf(id: number): ItemStat | undefined {
    const s = this.data.itemStats;
    return s?.[id] ?? s?.[this.groupOf(id)];
  }
  private addToLoadout(lo: Set<number>, id: number): void {
    if (id <= 0) return;
    lo.add(id);
    const alt = this.statsOf(id)?.alt;
    if (alt) lo.add(alt);
  }

  /**the slot's own item a hit / WeaponSync names (the client names it by name: a same-name id of the item is
   * that item), or null = not one the slot has (a strike). A seat that never had a RespawnSync (AI) has no loadout. */
  private loadoutWeapon(room: RoomModel, player: PlayerModel, id: number, pk: PacketModel): number | null {
    const lo = player.loadout;
    if (!this.cfg.checkLoadout || !lo || lo.has(id)) return id;
    const g = this.groupOf(id);
    for (const w of lo) if (this.groupOf(w) === g) return w;
    this.reject(room, pk, "loadout", `weapon ${id} is not in slot ${player.slot}'s loadout [${[...lo].join(", ")}]`, true);
    return null;
  }

  /**at most FIRE_RATE_SLACK over hits x 1 / fireDelay (title Fire_Speed and GetFireDelay's floor included) per
   * FIRE_WINDOW_MS, + one shot of jitter; per victim for a multi-target item, per weapon otherwise. Not a strike: network
   * jitter can bunch honest hits. */
  private underFireRate(room: RoomModel, player: PlayerModel, pk: PacketModel, w: number, st: ItemStat | undefined, victim: string): boolean {
    if (!this.cfg.fireRateCap || !st) return true;
    const hits = st.hits ?? 1;
    const delay = Math.max(FIRE_DELAY_MIN, st.fireDelay - FIRE_SPEED_TITLE_MAX);
    const limit = Math.floor((hits * (FIRE_WINDOW_MS / 1000) / delay) * (1 + FIRE_RATE_SLACK)) + hits;
    const key = `${room.uniqueRoomId}:${player.slot}:${this.groupOf(w)}${st.multi || victim[0] === "o" ? `:${victim}` : ""}`;
    const now = pk.receiveDate;
    const log = (this.fireLog.get(key) ?? []).filter((t) => now - t < FIRE_WINDOW_MS);
    if (log.length >= limit) {
      this.fireLog.set(key, log);
      this.reject(room, pk, "rate", `slot ${player.slot} over ${limit} hits / ${FIRE_WINDOW_MS} ms with ${w}`, false);
      return false;
    }
    log.push(now);
    this.fireLog.set(key, log);
    if (this.fireLog.size > 4096) for (const [k, v] of this.fireLog) if (now - v[v.length - 1] >= FIRE_WINDOW_MS) this.fireLog.delete(k);
    return true;
  }

  /** a rejected datagram part: a rate-limited log line, and for a hard one a strike on the sender's slot; strikeLimit
   * strikes within STRIKE_WINDOW_MS drop that guest (never the host's own link) and its slot may not register again.
   * Always false (the caller's). */
  private reject(room: RoomModel, pk: PacketModel, kind: string, detail: string, hard: boolean): false {
    this.stats.rejected++;
    const now = pk.receiveDate;
    const wk = `${pk.slot}:${kind}`;
    const w = this.warned.get(wk);
    if (!w || now - w.at >= WARN_EVERY_MS) {
      this.warned.set(wk, { at: now, n: 0 });
      const line = `[anti-cheat] slot ${pk.slot}: ${detail}${w?.n ? ` (+${w.n} more since the last line)` : ""}`;
      if (this.out.warn) this.out.warn(line); else this.log(line);
    } else w.n++;
    if (!hard || this.cfg.strikeLimit <= 0 || this.hostPeer?.(pk.peer) || room.kicked.has(pk.slot)) return false;
    const sk = `${room.uniqueRoomId}:${pk.slot}`;
    const list = (this.strikes.get(sk) ?? []).filter((t) => now - t < STRIKE_WINDOW_MS);
    list.push(now);
    this.strikes.set(sk, list);
    if (list.length >= this.cfg.strikeLimit) {
      room.kicked.add(pk.slot);
      this.strikes.delete(sk);
      const why = `${list.length} anti-cheat strikes in ${STRIKE_WINDOW_MS / 1000} s (last: ${kind})`;
      this.log(`slot ${pk.slot} dropped: ${why}`);
      this.out.kick?.(pk.peer, why);
    }
    return false;
  }

  // ---------------------------------------------------------------- RoomModel.SyncInfo

  private syncInfo(room: RoomModel, objs: ObjectHitInfo[], type: number): void {
    if (room.botMode || !room.objectsIsValid()) return;
    const d1 = this.duration(room.lastObjsSync);
    const d2 = this.duration(room.lastPlayersSync);
    if (d1 >= 0.5 && (type & 1) === 1) {
      room.lastObjsSync = this.now();
      for (const oi of room.objects) {
        const model = oi.model;
        if (model && ((model.destroyable && oi.life !== model.life) || model.needSync)) {
          const d3 = this.duration(oi.useDate);
          const anim = oi.animation;
          if (anim && anim.duration > 0 && d3 >= anim.duration) model.getAnim(this, anim.nextAnim, d3, anim.duration, oi);
          objs.push(new ObjectHitInfo(model.updateId, {
            objSyncId: model.needSync ? 1 : 0, animId1: model.animation, animId2: oi.animation ? oi.animation.id : 255,
            destroyState: oi.destroyState, objId: model.id, objLife: oi.life, specialUse: d3,
          }));
        }
      }
    }
    if (d2 < 0.5 || (type & 2) !== 2) return;
    room.lastPlayersSync = this.now();
    for (const p of room.players) {
      if (!p.immortal && (p.maxLife !== p.life || p.dead)) objs.push(new ObjectHitInfo(4, { objId: p.slot, objLife: p.life }));
    }
  }

  // ---------------------------------------------------------------- DamageManager / AssistManager

  private simpleDeath(room: RoomModel, deaths: DeathServerData[], objs: ObjectHitInfo[], killer: PlayerModel, victim: PlayerModel, damage: number, weaponId: number, part: number, deathType: number): void {
    victim.life -= damage;
    if (victim.life <= 0) {
      victim.life = 0;
      victim.dead = true;
      victim.lastDie = this.now();
    }
    this.addAssist(room, victim, killer, victim.life);
    if (victim.life > 0) {
      victim.dead = false;
      objs.push(new ObjectHitInfo(5, { objId: victim.slot, killerSlot: killer.slot, deathType, objLife: victim.life, hitPart: part }));
    } else this.kill(room, deaths, victim, killer, deathType);
  }

  /** DamageManager.StaticMethod0 */
  private kill(room: RoomModel, deaths: DeathServerData[], victim: PlayerModel, killer: PlayerModel, deathType: number): void {
    victim.life = 0;
    victim.dead = true;
    victim.lastDie = this.now();
    const assist = this.getAssist(victim.slot, room.roomId);
    const d: DeathServerData = { player: victim, deathType, assistSlot: assist ? (assist.isAssist ? assist.killer : killer.slot) : killer.slot };
    this.removeAssist(assist);
    deaths.push(d);
  }

  private boomDeath(room: RoomModel, killer: PlayerModel, damage: number, weaponId: number, deaths: DeathServerData[], objs: ObjectHitInfo[], boomPlayers: number[] | null, part: number, deathType: number): void {
    if (!boomPlayers || boomPlayers.length === 0) return;
    for (const b of boomPlayers) {
      const p = room.getPlayer(b);
      if (p && !p.dead) {
        this.kill(room, deaths, p, killer, deathType);
        if (damage > 0) {
          if (this.cfg.useHitMarker) this.hitMarker(room, killer, deathType, HitType.Normal, damage);
          objs.push(new ObjectHitInfo(2, { objId: p.slot, objLife: p.life, hitPart: part, killerSlot: killer.slot, position: halfSub(p.position, killer.position), deathType, weaponId }));
        }
      }
    }
  }

  private sabotageDestroy(room: RoomModel, player: PlayerModel, model: ObjectModel, oi: ObjectInfo, damage: number): void {
    if (model.ultraSync <= 0 || (room.roomType !== RoomCondition.Destroy && room.roomType !== RoomCondition.Defense)) return;
    if (model.ultraSync === 1 || model.ultraSync === 3) room.bar1 = oi.life;
    else if (model.ultraSync === 2 || model.ultraSync === 4) room.bar2 = oi.life;
    if (player.slot >= 0 && player.slot < 18) room.slotDamage[player.slot] += damage;
    this.out.game?.({ t: "sabotage", room: this.ref(room), slot: player.slot, bar1: room.bar1, bar2: room.bar2, ultraSync: model.ultraSync === 4 ? 2 : 1, damage, slotDamage: [...room.slotDamage] });
  }

  /** DamageManager.StaticMethod2 */
  private addAssist(room: RoomModel, victim: PlayerModel, killer: PlayerModel, life: number): void {
    const a: AssistServerData = { roomId: room.roomId, killer: killer.slot, victim: victim.slot, isKiller: life <= 0, victimDead: life <= 0, isAssist: life > 0 };
    if (a.killer === a.victim) return;
    this.assists.push(a);
  }
  private getAssist(victim: number, roomId: number): AssistServerData | null {
    return this.assists.find((a) => a.victim === victim && a.roomId === roomId) ?? null;
  }
  private removeAssist(a: AssistServerData | null): boolean {
    const i = a ? this.assists.indexOf(a) : -1;
    if (i < 0) return false;
    this.assists.splice(i, 1);
    return true;
  }

  // ---------------------------------------------------------------- SendMatchInfo (Match -> Game)

  private deathSync(room: RoomModel, killer: PlayerModel, objectId: number, weaponId: number, deaths: DeathServerData[]): void {
    this.out.game?.({
      t: "death", room: this.ref(room), killerSlot: killer.slot, objectId: objectId & 0xff, weaponId, killerPos: vec(killer.position),
      deaths: deaths.map((d) => ({ slot: d.player.slot, weaponClass: idStatics(weaponId, 2) & 0xff, deathType: d.deathType, pos: vec(d.player.position), assistSlot: d.assistSlot & 0xff })),
    });
  }
  private bombSync(room: RoomModel, player: PlayerModel, type: number, bombArea: number): void {
    if (type === 0) room.bombPosition = { ...player.position };
    this.out.game?.({ t: "bomb", room: this.ref(room), type, slot: player.slot, bombArea, pos: vec(player.position) });
  }
  private hitMarker(room: RoomModel, player: PlayerModel, deathType: number, hitEnum: number, damage: number): void {
    this.out.game?.({ t: "hitMarker", room: this.ref(room), slot: player.slot, deathType, hitEnum, damage });
  }
  private portalPass(room: RoomModel, player: PlayerModel, portal: number): void {
    if (room.roomType !== RoomCondition.Boss) return;
    player.life = player.maxLife;
    this.out.game?.({ t: "portal", room: this.ref(room), slot: player.slot, portal: portal & 0xff });
  }

  // ---------------------------------------------------------------- Game -> Match sync

  /** RespawnSync.Load (Game -> Match opcode 1). */
  respawnSync(s: RespawnSyncIn): void {
    const room = this.getRoom(s.uniqueRoomId, s.roomSeed);
    if (!room) return;
    this.resyncTick(room, s.startTick, s.roomSeed);
    const player = room.getActive(s.slot);
    const accountId = s.accountId ?? player?.playerIdByUser;
    if (!player || player.playerIdByUser !== accountId) {
      // Server.Match drops it (the slot registers before its first RESPAWN there). Over P2P the respawn comes from the
      // leader's TCP session and may beat the slot's WebRTC link: keep the last one and apply it on register.
      if (!player) this.pendingRespawn.set(`${room.uniqueRoomId}:${room.roomSeed}:${s.slot}`, s);
      return;
    }
    player.playerIdByServer = accountId;
    player.respawnByServer = s.respawnCount;
    player.integrity = false;
    player.dead = false;
    if (s.round > room.serverRound) room.serverRound = s.round;
    const full = s.type === 0 || s.type === 2;
    if (full) {
      const existing = this.getAssist(player.slot, room.roomId);
      if (existing && this.removeAssist(existing)) {
        for (const a of this.assists.filter((x) => x.victim === player.slot && x.roomId === room.roomId)) this.removeAssist(a);
      }
      const w = s.weapons ?? { primary: 0, secondary: 0, melee: 0, explosive: 0, special: 0 };
      player.plantDuration = this.cfg.plantDuration;
      player.defuseDuration = this.cfg.defuseDuration;
      player.equip = { wpnPrimary: w.primary, wpnSecondary: w.secondary, wpnMelee: w.melee, wpnExplosive: w.explosive, wpnSpecial: w.special, accessory: s.accessory ?? 0 };
      player.loadout = this.loadoutOf(player.equip);
      if (s.c4SpeedKit) {
        // Cross exe 0x5845d0 / 0x584600: the kit takes 2 s off both (plant 5 -> 3, defuse 7 -> 5; C# server: -50 % / -25 %)
        player.plantDuration -= 2;
        player.defuseDuration -= 2;
      }
      if (!room.botMode) {
        if (room.sourceToMap === -1) this.roundResetRoomF1(room, s.round);
        else this.roundResetRoomS1(room, s.round);
      }
      const charaId = s.charaId ?? 0;
      if (charaId === -1) player.immortal = true;
      else {
        player.immortal = false;
        const baseHp = this.data.charaHp[charaId] ?? 100;
        player.maxLife = baseHp + Math.trunc((baseHp * (s.hpBonus ?? 0)) / 100);
        player.resetLife();
      }
    }
    if (room.botMode || s.type === 2 || !room.objectsIsValid()) return;
    const objs: ObjectHitInfo[] = [];
    for (const oi of room.objects) {
      const model = oi.model;
      if (model && ((s.type !== 2 && model.destroyable && oi.life !== model.life) || model.needSync)) {
        objs.push(new ObjectHitInfo(3, {
          objSyncId: model.needSync ? 1 : 0, animId1: model.animation, animId2: oi.animation ? oi.animation.id : 255,
          destroyState: oi.destroyState, objId: model.id, objLife: oi.life, specialUse: this.duration(oi.useDate),
        }));
      }
    }
    for (const o of room.players) {
      if (o.slot !== s.slot && o.accountIdIsValid() && !o.immortal && o.startTime !== 0 && (o.maxLife !== o.life || o.dead)) {
        objs.push(new ObjectHitInfo(4, { objId: o.slot, objLife: o.life }));
      }
    }
    if (objs.length > 0) {
      const code = this.baseWriteCode(4, eventsActionCode(objs), 255, this.duration(room.startTime), s.round, s.respawnCount, 0, accountId ?? 0);
      this.send(player.client, code, true);
    }
  }

  /**the RESPAWN's items, their Dual swaps, the client's default for a slot left at 0 (WeaponSystem.setLoadout)
   * and the default knife (a spent Ballistic Knife becomes it) */
  private loadoutOf(e: Equipment): Set<number> {
    // Clube da Luta: the fist and the special slot only (no default knife / primary added below)
    if (this.cfg.barefistOnly) return new Set([BAREFIST_ID, e.wpnSpecial].filter((id) => id > 0));
    const d = this.data.defaultLoadout ?? {};
    const lo = new Set<number>();
    for (const [id, def] of [[e.wpnPrimary, d.primary], [e.wpnSecondary, d.secondary], [e.wpnMelee, d.melee], [e.wpnExplosive, d.explosive], [e.wpnSpecial, 0]] as const) {
      this.addToLoadout(lo, id > 0 ? id : def ?? 0);
    }
    this.addToLoadout(lo, d.melee ?? 0);
    return lo;
  }

  /** RemovePlayerSync.Load (opcode 2): type 0 drops the room, otherwise the slot. */
  removePlayerSync(uid: number, seed: number, slot: number, type: number): void {
    const room = this.getRoom(uid, seed);
    if (!room) return;
    if (type === 0) this.removeRoom(room);
    else room.getPlayer(slot)?.resetAllInfos(this.cfg);
  }

  /** MatchRoundSync.Load (opcode 3). */
  roundSync(uid: number, seed: number, round: number, teamSwap: boolean): void {
    const room = this.getRoom(uid, seed);
    if (!room) return;
    room.serverRound = round;
    room.isTeamSwap = teamSwap;
  }

  // ---------------------------------------------------------------- host handoff

  /** Everything the match needs to go on in another tab: every field of RoomModel / PlayerModel / ObjectInfo that the
   * code above reads or writes, the assists, and the RESPAWN syncs parked for a slot that had not registered. JSON /
   * structured-clone safe. Clocks (`ms`) are the old host's `now()`; restore() moves them onto its own. Not part of it:
   * `stats`, the map models (rebuilt from the static data), the peers (a guest re-registers on the new host). */
  snapshot(): MatchSnapshot {
    const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
    return {
      v: SNAPSHOT_VERSION,
      now: this.now(),
      rooms: this.rooms.map((r): RoomSnapshot => ({
        uniqueRoomId: r.uniqueRoomId, roomSeed: r.roomSeed, lastStartTick: r.lastStartTick, objsSyncRound: r.objsSyncRound,
        serverRound: r.serverRound, sourceToMap: r.sourceToMap, serverId: r.serverId, roomId: r.roomId, channelId: r.channelId,
        lastRound: r.lastRound, bar1: r.bar1, bar2: r.bar2, default1: r.default1, default2: r.default2, slotDamage: [...r.slotDamage], dropCounter: r.dropCounter,
        botMode: r.botMode, hasC4: r.hasC4, isTeamSwap: r.isTeamSwap, mapId: r.mapId, rule: r.rule, roomType: r.roomType,
        bombPosition: { ...r.bombPosition }, startTime: r.startTime, lastObjsSync: r.lastObjsSync, lastPlayersSync: r.lastPlayersSync,
        players: r.players.map((p): PlayerSnapshot => ({
          slot: p.slot, team: p.team, life: p.life, maxLife: p.maxLife, playerIdByUser: p.playerIdByUser, playerIdByServer: p.playerIdByServer,
          respawnByUser: p.respawnByUser, respawnByServer: p.respawnByServer, ping: p.ping, latency: p.latency, weaponId: p.weaponId,
          accessory: p.accessory, extensions: p.extensions, plantDuration: p.plantDuration, defuseDuration: p.defuseDuration, c4Time: p.c4Time,
          position: { ...p.position }, startTime: p.startTime, lastPing: p.lastPing, lastDie: p.lastDie, c4First: p.c4First,
          equip: p.equip ? { ...p.equip } : null, weaponClass: p.weaponClass, dead: p.dead, neverRespawn: p.neverRespawn,
          integrity: p.integrity, immortal: p.immortal, connected: p.client !== null || p.restoreKeep,
          loadout: p.loadout ? [...p.loadout] : null,
        })),
        dropped: [...r.dropped],
        kicked: [...r.kicked],
        // only objects the match touched: a map object (model) or anything off the ObjectInfo defaults
        objects: r.objects.filter((o) => o.model !== null || o.life !== 100 || o.destroyState !== 0 || o.animation !== null || o.useDate !== 0).map((o): ObjectSnapshot => ({
          id: o.id, life: o.life, destroyState: o.destroyState, animation: o.animation ? { ...o.animation } : null, useDate: o.useDate, model: o.model !== null,
        })),
      })),
      assists: clone(this.assists),
      pendingRespawn: [...this.pendingRespawn.entries()].map(([k, s]) => [k, clone(s)] as [string, RespawnSyncIn]),
    };
  }

  /** Rebuilds the match from snapshot() on a fresh core (before any peer opens). Returns what the host tab needs to line
   * its bridge up: the restored room's StartTick (on this clock; src/host/bridge.ts must not hand the core a later one,
   * resyncTick would reset the room) and the slots that were connected (their guests will register again and are NOT
   * re-armed from RESPAWN_ACKs: that would give them full life). Throws on another snapshot version. */
  restore(s: MatchSnapshot): { startTick: number; slots: number[] } {
    if (s.v !== SNAPSHOT_VERSION) throw new Error(`match snapshot version ${s.v} (this build reads ${SNAPSHOT_VERSION})`);
    if (this.rooms.length > 0) throw new Error("restore needs a fresh core");
    const delta = this.now() - s.now; // the old host's ages kept on this clock (clocks of two machines are not comparable)
    const at = (t: number) => (t === 0 ? 0 : t + delta);
    let startTick = 0;
    const slots: number[] = [];
    for (const rs of s.rooms) {
      const room = new RoomModel(rs.uniqueRoomId, rs.roomSeed);
      room.lastStartTick = at(rs.lastStartTick); room.objsSyncRound = rs.objsSyncRound; room.serverRound = rs.serverRound;
      room.sourceToMap = rs.sourceToMap; room.serverId = rs.serverId; room.roomId = rs.roomId; room.channelId = rs.channelId;
      room.lastRound = rs.lastRound; room.bar1 = rs.bar1; room.bar2 = rs.bar2; room.default1 = rs.default1; room.default2 = rs.default2; room.slotDamage = [...rs.slotDamage];
      room.dropCounter = rs.dropCounter; room.botMode = rs.botMode; room.hasC4 = rs.hasC4; room.isTeamSwap = rs.isTeamSwap;
      room.mapId = rs.mapId; room.rule = rs.rule; room.roomType = rs.roomType; room.bombPosition = { ...rs.bombPosition };
      room.startTime = at(rs.startTime); room.lastObjsSync = at(rs.lastObjsSync); room.lastPlayersSync = at(rs.lastPlayersSync);
      room.dropped = new Set(rs.dropped ?? []); room.kicked = new Set(rs.kicked ?? []);
      for (const ps of rs.players) {
        const p = room.players[ps.slot];
        if (!p) continue;
        p.team = ps.team; p.life = ps.life; p.maxLife = ps.maxLife; p.playerIdByUser = ps.playerIdByUser; p.playerIdByServer = ps.playerIdByServer;
        p.respawnByUser = ps.respawnByUser; p.respawnByServer = ps.respawnByServer; p.ping = ps.ping; p.latency = ps.latency;
        p.weaponId = ps.weaponId; p.accessory = ps.accessory; p.extensions = ps.extensions; p.plantDuration = ps.plantDuration;
        p.defuseDuration = ps.defuseDuration; p.c4Time = ps.c4Time; p.position = { ...ps.position }; p.startTime = at(ps.startTime);
        p.lastPing = at(ps.lastPing); p.lastDie = at(ps.lastDie); p.c4First = at(ps.c4First); p.equip = ps.equip ? { ...ps.equip } : null;
        p.weaponClass = ps.weaponClass; p.dead = ps.dead; p.neverRespawn = ps.neverRespawn; p.integrity = ps.integrity; p.immortal = ps.immortal;
        p.loadout = ps.loadout !== undefined ? (ps.loadout ? new Set(ps.loadout) : null) : p.equip ? this.loadoutOf(p.equip) : null;
        p.restoreKeep = ps.connected; // client stays null until that slot registers on this host
        if (ps.connected) slots.push(ps.slot);
      }
      // the models: RoundResetRoomF1 ties room.objects[om.id] to MapStructure's om (S1 reuses them)
      room.map = rs.sourceToMap !== -1 ? this.getMap(rs.mapId) : null;
      for (const os of rs.objects) {
        const oi = room.objects[os.id];
        if (!oi) continue;
        oi.life = os.life; oi.destroyState = os.destroyState; oi.animation = os.animation ? { ...os.animation } : null; oi.useDate = at(os.useDate);
        if (os.model) oi.model = room.map?.objects.find((m) => m.id === os.id) ?? null;
      }
      this.rooms.push(room);
      startTick = Math.max(startTick, room.lastStartTick);
    }
    this.assists.length = 0;
    this.assists.push(...s.assists.map((a) => ({ ...a })));
    this.pendingRespawn.clear();
    for (const [k, r] of s.pendingRespawn) this.pendingRespawn.set(k, { ...r, startTick: at(r.startTick) });
    return { startTick, slots };
  }

  private resyncTick(room: RoomModel, startTick: number, seed: number): void {
    if (startTick <= room.lastStartTick) return;
    room.startTime = startTick;
    if (room.lastStartTick > 0) this.resetRoomInfo(room, seed);
    room.lastStartTick = startTick;
  }

  private resetRoomInfo(room: RoomModel, seed: number): void {
    for (let i = 0; i < 200; ++i) room.objects[i] = new ObjectInfo(i);
    room.mapId = seedInfo(seed, 2);
    room.roomType = seedInfo(seed, 0);
    room.rule = seedInfo(seed, 1);
    room.sourceToMap = -1;
    room.map = null;
    room.lastRound = 0;
    room.dropCounter = 0;
    room.botMode = false;
    room.hasC4 = false;
    room.isTeamSwap = false;
    room.serverRound = 0;
    room.objsSyncRound = 0;
    room.lastObjsSync = 0;
    room.lastPlayersSync = 0;
    room.bombPosition = { ...HALF0 };
    room.dropped.clear();
  }

  private roundResetRoomF1(room: RoomModel, round: number): boolean {
    if (room.lastRound === round) return false;
    const now = this.now();
    room.lastRound = round;
    room.hasC4 = false;
    room.bombPosition = { ...HALF0 };
    room.dropCounter = 0;
    room.objsSyncRound = 0;
    room.sourceToMap = room.mapId;
    if (!room.botMode) {
      for (const p of room.players) p.life = p.maxLife;
      room.lastPlayersSync = now;
      room.map = this.getMap(room.mapId);
      for (const om of room.map?.objects ?? []) {
        if (om.id < 0 || om.id >= room.objects.length) { this.log(`RoundResetRoomF1: object Id ${om.id} out of range on Map ${room.mapId}; skipping.`); continue; }
        const oi = room.objects[om.id];
        oi.life = om.life;
        if (om.noInstaSync) {
          oi.animation = { id: 0, duration: 0, nextAnim: 1, otherObj: 0, otherAnim: 0 };
          oi.useDate = now;
        } else om.getRandomAnimation(this, room, oi);
        oi.model = om;
        oi.destroyState = 0;
        // MapStructureXML.SetObjectives
        if (om.ultraSync === 1 || om.ultraSync === 3) { room.bar1 = om.life; room.default1 = room.bar1; }
        else if (om.ultraSync === 2 || om.ultraSync === 4) { room.bar2 = om.life; room.default2 = room.bar2; }
      }
      room.lastObjsSync = now;
      room.objsSyncRound = round;
    }
    return true;
  }

  private roundResetRoomS1(room: RoomModel, round: number): boolean {
    if (room.lastRound === round) return false;
    room.lastRound = round;
    room.slotDamage.fill(0); // RoundRestart: SlotModel.DamageBar1/2 = 0
    room.hasC4 = false;
    room.dropCounter = 0;
    room.bombPosition = { ...HALF0 };
    if (!room.botMode) {
      for (const p of room.players) p.life = p.maxLife;
      const now = this.now();
      room.lastPlayersSync = now;
      for (const oi of room.objects) {
        const model = oi.model;
        if (!model) continue;
        oi.life = model.life;
        if (!model.noInstaSync) model.getRandomAnimation(this, room, oi);
        else {
          oi.animation = { id: 0, duration: 0, nextAnim: 1, otherObj: 0, otherAnim: 0 };
          oi.useDate = now;
        }
        oi.destroyState = 0;
      }
      room.lastObjsSync = now;
      room.objsSyncRound = round;
      if (room.roomType === RoomCondition.Destroy || room.roomType === RoomCondition.Defense) {
        room.bar1 = room.default1;
        room.bar2 = room.default2;
      }
    }
    return true;
  }

  private readonly maps = new Map<number, MapModel | null>();
  /** MapStructureXML.GetMapId (models built once per map, like the XML load) */
  private getMap(id: number): MapModel | null {
    if (this.maps.has(id)) return this.maps.get(id)!;
    const d = this.data.maps[id];
    let m: MapModel | null = null;
    if (d) {
      m = {
        id,
        bombs: d.bombs.map(([x, y, z]) => ({ position: half3(x, y, z), everyWhere: x === 0 && y === 0 && z === 0 })),
        objects: d.objects.map((o) => {
          const om = new ObjectModel(o.needSync);
          om.id = o.id;
          om.life = o.life;
          om.animation = o.animation;
          if (om.life > -1) om.destroyable = true;
          if (om.animation > 255) {
            om.ultraSync = om.animation === 256 ? 1 : om.animation === 257 ? 2 : om.animation === 258 ? 3 : om.animation === 259 ? 4 : 0;
            om.animation = 255;
          }
          for (const a of o.anims ?? []) {
            if (a.id === 0) om.noInstaSync = true;
            if (a.id !== 255) om.updateId = 3;
            if (!om.animations) throw new Error(`MapStructure: object ${o.id} of map ${id} has anims but NeedSync=false`);
            om.animations.push({ id: a.id, duration: a.duration, nextAnim: a.next, otherObj: a.otherObj, otherAnim: a.otherAnim });
          }
          om.effects = (o.effects ?? []).map((e) => ({ ...e }));
          return om;
        }),
      };
    }
    this.maps.set(id, m);
    return m;
  }

  // ---------------------------------------------------------------- AllUtils.BaseWriteCode

  baseWriteCode(opcode: number, actions: Uint8Array, slot: number, time: number, round: number, respawn: number, roundNumber: number, accountId: number): Uint8Array {
    if (actions.length === 0) return new Uint8Array(0);
    const key1 = new Uint8Array(new Float32Array([time]).buffer);
    const { blob, key2 } = udp121EncryptS2C(actions, key1, this.cipherBytes());
    const length = 25 + blob.length;
    const enc = bitwiseEncrypt(blob, (length % 6) + 1);
    return new PacketWriter(length).writeC(opcode).writeC(slot).writeT(time).writeC(round).writeH(length).writeC(respawn)
      .writeC(roundNumber).writeC(accountId).writeC(0).writeD(key2).writeD(0).writeD(0).writeB(enc).toBytes();
  }
}

interface HitDataInfo {
  startBullet: Half3; endBullet: Half3; bulletPos: Half3; boomInfo: number; objectId: number; hitIndex: number;
  weaponId: number; accessory: number; extensions: number; hitEnum: number; boomPlayers: number[] | null; weaponClass: number;
}
interface GrenadeHitInfo {
  weaponId: number; accessory: number; extensions: number; boomInfo: number; objectId: number; hitInfo: number;
  playerPos: Half3; firePos: Half3; hitPos: Half3; grenadesCount: number; deathType: number; hitEnum: number;
  boomPlayers: number[] | null; weaponClass: number;
}

interface DropInfo { ammoPrin: number; ammoDual: number; ammoTotal: number; unk1: number; unk2: number; unk3: number; flags: number; weaponId: number; accessory: number; extensions: number }
function readDropInfo(C: SyncReader): DropInfo {
  return { ammoPrin: C.uh(), ammoDual: C.uh(), ammoTotal: C.uh(), unk1: C.uh(), unk2: C.uh(), unk3: C.uh(), flags: C.c(), weaponId: C.d32(), accessory: C.c(), extensions: C.c() };
}
function writeDropInfo(S: PacketWriter, d: DropInfo, cfg: MatchConfig, flags: number): void {
  if (cfg.useMaxAmmoInDrop) S.writeH(0xffff).writeH(d.ammoDual).writeH(10000);
  else S.writeH(d.ammoPrin).writeH(d.ammoDual).writeH(d.ammoTotal);
  S.writeH(d.unk1).writeH(d.unk2).writeH(d.unk3).writeC(flags).writeD(d.weaponId).writeC(d.accessory).writeC(d.extensions);
}

function swappedTeam(p: PlayerModel, room: RoomModel): number {
  return room.isTeamSwap ? (p.team === Team.FR ? Team.CT : Team.FR) : p.team;
}

/** PROTOCOL_EVENTS_ACTION.GET_CODE */
function eventsActionCode(objs: ObjectHitInfo[]): Uint8Array {
  const w = new PacketWriter(objs.length * 16);
  for (const o of objs) {
    if (o.type !== 1) {
      if (o.type === 2) {
        let len = 11;
        let ev = Ev.HpSync as number;
        if (o.objLife === 0) { len += 13; ev |= Ev.GetWeaponForHost; }
        w.writeH(len).writeH(o.objId).writeC(0).writeD(ev).writeH(o.objLife);
        if (has(ev, Ev.GetWeaponForHost)) {
          w.writeC(o.deathType).writeC(o.killerSlot);
          writeHV(w, o.position);
          w.writeD(0).writeC(o.hitPart);
        }
      } else if (o.type === 3) {
        if (o.objSyncId !== 0) w.writeH(14).writeH(o.objId).writeC(12).writeC(o.destroyState).writeH(o.objLife).writeT(o.specialUse).writeC(o.animId1).writeC(o.animId2);
        else w.writeH(8).writeH(o.objId).writeC(9).writeH(1).writeC(o.objLife === 0 ? 1 : 0);
      } else if (o.type === 4) {
        w.writeH(11).writeH(o.objId).writeC(8).writeD(8).writeH(o.objLife);
      } else if (o.type === 5) {
        w.writeH(12).writeH(o.objId).writeC(0).writeD(0x40000000).writeC(o.deathType * 16).writeC(o.hitPart).writeC(o.killerSlot);
      } else if (o.type === 6) {
        w.writeH(15).writeH(o.objId).writeC(0).writeD(0x04000000).writeD(o.weaponId).writeC(o.accessory).writeC(o.extensions);
      }
    } else if (o.objSyncId !== 0) {
      w.writeH(13).writeH(o.objId).writeC(6).writeH(o.objLife).writeC(o.animId1).writeC(o.animId2).writeT(o.specialUse);
    } else {
      w.writeH(10).writeH(o.objId).writeC(3).writeH(6).writeH(o.objLife).writeC(o.killerSlot);
    }
  }
  return w.toBytes();
}

/** PROTOCOL_CONNECT.GET_CODE */
const PROTOCOL_CONNECT = new PacketWriter(14).writeC(66).writeC(0).writeT(0).writeC(0).writeH(14).writeD(0).writeC(8).toBytes();

// ------------------------------------------------------------------ 121 framing + Udp121Cipher (server side)

const u32 = (d: Uint8Array, o: number) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;

function isUdp121Handshake(p: PacketModel): boolean {
  return (p.opcode === 65 || p.opcode === 67) && p.length === 38 && p.data.length >= 38
    && u32(p.data, 17) === 0x34282e8c && u32(p.data, 21) === 0x2b3c3014 && u32(p.data, 25) === 0x000705e4;
}

function tryDecryptUdp121(p: PacketModel): boolean {
  if (p.data.length < p.length || p.length < 38) return false;
  const regionLen = p.length - 25;
  if (regionLen < 13) return false;
  const unrot = bitwiseDecrypt(p.data.slice(25, 25 + regionLen), (p.length % 6) + 1);
  const blobLen = regionLen - 9;
  if (!(blobLen >= 4 && unrot[0] < 32 && unrot[1] < 32 && unrot[3] >= 2 && unrot[3] <= 9)) return false; // LooksLikeBlob
  const plain = udp121DecryptC2S(unrot, blobLen, p.data.slice(2, 6), p.data.slice(13, 17));
  if (!plain) return false;
  const withEnd = new Uint8Array(plain.length + 9);
  withEnd.set(plain);
  withEnd.set(unrot.subarray(blobLen, blobLen + 9), plain.length);
  p.withEnd = withEnd;
  p.withoutEnd = plain;
  return true;
}

/** Udp121Cipher.Tap */
function tap(buf: Uint8Array, a3: number): number {
  const len = buf.length;
  const v4 = Math.floor(a3 / 8) % len;
  const v5 = a3 & 7;
  if (v5 === 0) return buf[v4];
  return ((buf[(v4 + 1) % len] >> (8 - v5)) + ((buf[v4] & (0xff >> v5)) << v5)) & 0xff;
}

/** Udp121Cipher.Decrypt (client -> server blob) */
export function udp121DecryptC2S(blob: Uint8Array, length: number, key1: Uint8Array, key2: Uint8Array): Uint8Array | null {
  if (length < 4 || length > blob.length) return null;
  const [iv1, iv2, mix, padlen] = blob;
  const ctlen = length - 4 - padlen;
  if (ctlen < 0) return null;
  const k1 = key1.slice(), k2 = key2.slice();
  const idx1 = ((mix & 0xf) + iv1) & 0xff;
  const idx2 = ((mix >> 4) + iv2) & 0xff;
  let fb = 0;
  let jit = 0;
  const plain = new Uint8Array(ctlen);
  for (let i = 0; i < ctlen; i++) {
    fb = (fb ^ tap(k1, (idx1 + jit) >>> 0) ^ tap(k2, (idx2 + jit) >>> 0)) & 0xff;
    const c = blob[4 + i];
    plain[i] = fb ^ c;
    jit = (jit + fb + 8) >>> 0;
    for (let j = 0; j < k1.length; j += 2) k1[j] ^= c;
    for (let j = 1; j < k2.length; j += 2) k2[j] ^= c;
  }
  return plain;
}

/** Udp121Cipher.EncryptServerToClient */
export function udp121EncryptS2C(plain: Uint8Array, key1: Uint8Array, random: Uint8Array = crypto.getRandomValues(new Uint8Array(7))): { blob: Uint8Array; key2: number } {
  const key2 = u32(random, 0);
  const k1 = key1.slice();
  const k2 = random.slice(0, 4);
  const iv1 = random[4] & 31, iv2 = random[5] & 31, mix = random[6];
  const padLength = ((2 - plain.length) & 7) + 2;
  const blob = new Uint8Array(4 + plain.length + padLength);
  blob[0] = iv1; blob[1] = iv2; blob[2] = mix; blob[3] = padLength;
  const index1 = (iv1 + (mix >> 4)) & 0xff;
  const index2 = (iv2 + (mix & 15)) & 0xff;
  let feedback = 0;
  let jitter = 0;
  for (let i = 0; i < plain.length + padLength; i++) {
    feedback = (feedback ^ tap(k1, (index1 + jitter) >>> 0) ^ tap(k2, (index2 + jitter) >>> 0)) & 0xff;
    const cipher = feedback ^ (i < plain.length ? plain[i] : padLength);
    blob[4 + i] = cipher;
    jitter = (jitter + feedback + 14) >>> 0;
    k1[0] ^= cipher; k1[2] ^= cipher;
    k2[1] ^= cipher; k2[3] ^= cipher;
  }
  return { blob, key2 };
}
