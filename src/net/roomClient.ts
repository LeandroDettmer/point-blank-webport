// Room + battle flow on the Game TCP connection (Server.Game). Layouts:
//
//   leader: CREATE(3592) ................ READY(5123) -> START_GAME(5127) -> LOADING_START(3657)
//   guest:  JOIN(3585) -> READY(5123) ..............  START_GAME(5127) -> LOADING_START(3657)
//   both:   PRESTARTBATTLE(5129) -> 5130 {Match ip/port, UniqueRoomId, Seed, slot}
//           -> UDP register (opcode 65/66) -> STARTBATTLE(5131) -> [server waits CountdownIG]
//           -> 5132/5151/5153 (room BATTLE) -> RESPAWN(5137) -> 5138 (+ Game->Match sync: StartTime)
//   end:    kill goal, or TIMERSYNC(5168) with timeRemaining 0 -> 5155 ROUND_END, 5140 ENDBATTLE
//           -> room back to READY automatically.  Leave early: GIVEUPBATTLE(5133) -> 5134.
//
// Caveat: pushes sent with SendPacketToPlayers/SendCompletePacket (3588, 3595, 3601, 5127, 5132,
// 5136, 5138, ...) use `H len = N - 2`, so FrameDecoder hands us the payload minus its last 2 bytes.
// Parsers below never depend on those trailing bytes.
import type { GameClient } from "./gameClient.ts";
import { GameError } from "./gameClient.ts";
import { PacketReader, PacketWriter } from "./packet.ts";
import { buildRespawnBody, parseRespawnAck, type RespawnAck } from "./metaGame.ts";
import type { EquipPair } from "../lobby/types.ts";

export const RoomOp = {
  ROOM_JOIN_REQ: 3585,
  ROOM_JOIN_ACK: 3586,
  ROOM_GET_SLOTONEINFO_ACK: 3588,
  ROOM_CREATE_REQ: 3592,
  ROOM_CREATE_ACK: 3593,
  ROOM_GET_SLOTINFO_ACK: 3595,
  ROOM_GET_PLAYERINFO_REQ: 3596,
  ROOM_GET_PLAYERINFO_ACK: 3597,
  /** the nick / colour items (server handleUseItem 1600047/1600051 and 1600006 -> C# PROTOCOL_ROOM_GET_NICKNAME_ACK / COLOR_NICK_ACK) */
  ROOM_GET_NICKNAME_ACK: 3599,
  ROOM_GET_COLOR_NICK_ACK: 3629,
  /** the effect items of the colour group (server handleUseItem 1600187 / 1600205 -> C# USE_ITEM_REQ) */
  ROOM_GET_COLOR_MUZZLE_FLASH_ACK: 3671,
  ROOM_GET_NICK_OUTLINE_COLOR_ACK: 3639,
  ROOM_CHANGE_ROOMINFO_ACK: 3601,
  ROOM_CHANGE_ROOM_OPTIONINFO_ACK: 3637,
  ROOM_CHANGE_ROOMINFO_REQ: 3640,
  ROOM_PERSONAL_TEAM_CHANGE_REQ: 3609,
  ROOM_CHANGE_SLOT_REQ: 3604,
  ROOM_REQUEST_MAIN_CHANGE_WHO_REQ: 3615,
  ROOM_REQUEST_MAIN_CHANGE_WHO_ACK: 3616,
  ROOM_TEAM_BALANCE_ACK: 3622,
  ROOM_LOADING_START_REQ: 3657,
  ROOM_LOADING_START_ACK: 3659,
  BATTLE_READYBATTLE_REQ: 5123,
  BATTLE_READYBATTLE_ACK: 5124,
  BATTLE_START_COUNTDOWN_ACK: 5126,
  BATTLE_START_GAME_ACK: 5127,
  BATTLE_PRESTARTBATTLE_REQ: 5129,
  BATTLE_PRESTARTBATTLE_ACK: 5130,
  BATTLE_STARTBATTLE_REQ: 5131,
  BATTLE_STARTBATTLE_ACK: 5132,
  BATTLE_GIVEUPBATTLE_REQ: 5133,
  BATTLE_GIVEUPBATTLE_ACK: 5134,
  BATTLE_DEATH_REQ: 5135,
  BATTLE_DEATH_ACK: 5136,
  BATTLE_RESPAWN_REQ: 5137,
  BATTLE_RESPAWN_ACK: 5138,
  BATTLE_ENDBATTLE_ACK: 5140,
  BATTLE_ROUND_PRE_START_ACK: 5151,
  BATTLE_ROUND_START_ACK: 5153,
  BATTLE_ROUND_END_ACK: 5155,
  BATTLE_MISSION_BOMB_INSTALL_REQ: 5156,
  BATTLE_MISSION_BOMB_INSTALL_ACK: 5157,
  BATTLE_MISSION_BOMB_UNINSTALL_REQ: 5158,
  BATTLE_MISSION_BOMB_UNINSTALL_ACK: 5159,
  BATTLE_MISSION_GENERATOR_INFO_REQ: 5166,
  BATTLE_MISSION_GENERATOR_INFO_ACK: 5167,
  BATTLE_TIMERSYNC_REQ: 5168,
  SERVER_MESSAGE_KICK_PLAYER_ACK: 3075,
  SERVER_MESSAGE_KICK_BATTLE_PLAYER_ACK: 3076,
  LOBBY_ENTER_REQ: 2583,
  LOBBY_ENTER_ACK: 2584,
} as const;

export const RoomState = { UNK: 0, READY: 1, COUNTDOWN: 2, LOADING: 3, RENDEZVOUS: 4, PRE_BATTLE: 5, BATTLE_READY: 6, BATTLE: 7, BATTLE_END: 8 } as const;
export const ROOM_STATE_NAMES = ["UNK", "READY", "COUNTDOWN", "LOADING", "RENDEZVOUS", "PRE_BATTLE", "BATTLE_READY", "BATTLE", "BATTLE_END", "EMPTY"];

/** Slot state as sent on the wire (SlotModel.GetClientState): internal + 3 from NORMAL up. */
export function slotStateName(wire: number): string {
  if (wire === 0) return "EMPTY";
  if (wire === 1) return "CLOSE";
  return ({ 3: "SHOP", 4: "INFO", 5: "CLAN", 6: "INVENTORY", 7: "GACHA", 8: "GIFTSHOP", 12: "NORMAL", 13: "READY", 14: "LOAD", 15: "RENDEZVOUS", 16: "PRESTART", 17: "BATTLE_LOAD", 18: "BATTLE_READY", 19: "BATTLE" } as Record<number, string>)[wire] ?? `S${wire}`;
}
export const WIRE_READY = 13;
/** first wire state of a slot in a running match (LOAD 14 .. BATTLE 19) */
export const WIRE_LOAD = 14;

/** Metro (Matches.xml Match Rule=1 Map 36) Team DeathMatch (Rules.xml Mode 1: Rule 0, Stage 1, Conditions 4). */
export const METRO_TDM = { mapId: 36, rule: 0, stage: 1, roomType: 4, mapName: "Metro" } as const;
/** M. Station (Matches.xml Match Rule=1 Map 4), same Death Match rule set as Metro; ROOM_CREATE_REQ does not validate maps. */
export const NSTATION_TDM = { mapId: 4, rule: 0, stage: 1, roomType: 4, mapName: "M. Station" } as const;
export type RoomPreset = typeof METRO_TDM | typeof NSTATION_TDM;

export interface CreateRoomOptions {
  name: string;
  mapId?: number;
  rule?: number;
  stage?: number;
  roomType?: number;
  slots?: number; // 2..16
  password?: string;
  /** StageFlag bits (server roomModel.ts StageFlag): RANDOM_MAP 2; PASSWORD (4) is derived from `password` by the server */
  flag?: number;
  /** 1 = "Restrição de entrada" (STR_TBL_GUI_LOBBY_LIMIT_ENTER_TEXT): the server refuses joins once the countdown started */
  limit?: number;
  /** observer rules byte (bit layout in src/lobby/core/roomRules.ts [INFERIDO]) */
  watchRule?: number;
  /** 24 bytes: the maps the random-map pick may choose (roomRules.ts) */
  randomMaps?: Uint8Array;
  /** Low 4 bits: KILLS index {15,30,50,60,80,100,120,140,160}; high: TIMES index {3,3,3,5,7,5,10,15,20,25,30} min. */
  killTime?: number;
  weaponsFlag?: number;
  /** 0 -> server waits 5.25 s before spawning, else 3.25 s. */
  cdFlag?: number;
  /** AI room (stage 2/4/6, RoomModel.IsBotMode): trailing AiCount / AiLevel / AiType bytes of ROOM_CREATE_REQ.
   * `allies` [RECRIADO]: bots on the leader's own team; the server has no concept of it (bots are always the
   * other team's slots), so it never goes on the wire, only kept locally like count/level already are for the leader. */
  ai?: { count: number; level: number; type?: number; allies?: number };
}

export interface RoomSummary {
  roomId: number;
  name: string;
  mapId: number;
  rule: number;
  stage: number;
  roomType: number;
  state: number;
  players: number;
  slotCount: number;
  weaponsFlag: number;
  leaderName: string;
  killTime: number;
  /** option half of the block, echoed back untouched by ROOM_CHANGE_ROOMINFO_REQ (absent on truncated broadcasts) */
  opts?: RoomOptionFields;
}

export interface RoomOptionFields {
  ping: number; flag: number; newInt: number; limit: number; watchRuleFlag: number; balanceType: number;
  randomMaps: Uint8Array; countdown: number; leaderAddr: Uint8Array; killCam: number;
}

/** What the leader may change from the ready room (ROOM_CHANGE_ROOMINFO_REQ 3640); unset fields keep the room's. */
export interface RoomChange {
  name?: string; mapId?: number; rule?: number; stage?: number; roomType?: number; weaponsFlag?: number;
  /** same nibble layout as CreateRoomOptions.killTime */
  killTime?: number;
  slots?: number;
  /** StageFlag / limit / observer rules / random-map list, same meaning as in CreateRoomOptions */
  flag?: number; limit?: number; watchRuleFlag?: number; randomMaps?: Uint8Array;
  /** TeamBalance (Plugin.Core/Enums/TeamBalance.cs): 0 None, 1 Count, 2 Rank */
  balanceType?: number;
  ai?: { count: number; level: number };
  /** "" clears the password, a string sets it (max 4 chars); undefined keeps the room's */
  password?: string;
}

/** Body of ROOM_CHANGE_ROOMINFO_REQ (3640), field order of the C# PROTOCOL_ROOM_CHANGE_ROOMINFO_REQ.Read(). */
export function buildChangeRoomInfoBody(room: RoomSummary, ch: RoomChange, ai: { count: number; level: number } | null): PacketWriter {
  const o = room.opts;
  const w = new PacketWriter(260);
  w.writeD(room.roomId).writeU(ch.name ?? room.name, 46)
    .writeC(ch.mapId ?? room.mapId).writeC(ch.rule ?? room.rule).writeC(ch.stage ?? room.stage).writeC(ch.roomType ?? room.roomType)
    .writeC(Math.max(RoomState.READY, room.state)).writeC(room.players).writeC(ch.slots ?? room.slotCount).writeC(o?.ping ?? 0)
    .writeH(ch.weaponsFlag ?? room.weaponsFlag).writeD(ch.flag ?? o?.flag ?? 0).writeH(0).writeD(o?.newInt ?? 0).writeH(0)
    .writeU(room.leaderName, 66).writeD(ch.killTime ?? room.killTime)
    .writeC(ch.limit ?? o?.limit ?? 0).writeC(ch.watchRuleFlag ?? o?.watchRuleFlag ?? 0).writeH(ch.balanceType ?? o?.balanceType ?? 0)
    .writeB(ch.randomMaps ?? o?.randomMaps ?? new Uint8Array(24)).writeC(o?.countdown ?? 5).writeB(o?.leaderAddr ?? new Uint8Array(4)).writeC(o?.killCam ?? 0).writeH(0);
  const a = ch.ai ?? ai;
  w.writeC(a?.count ?? 0).writeC(a?.level ?? 0);
  // web extension (server readChangeRoomInfo): apply byte + password; "" clears it, undefined keeps the room's
  if (ch.password !== undefined) w.writeC(1).writeS(ch.password, 4);
  return w;
}

/** One stat line of PROTOCOL_ROOM_GET_PLAYERINFO_ACK (server profileHandlers.ts recordFields order). */
export interface PlayerRecord { matches: number; wins: number; loses: number; draws: number; kills: number; headshots: number; deaths: number; totalKills: number; escapes: number; assists: number; mvp: number }

/** PROTOCOL_ROOM_GET_PLAYERINFO_ACK (3597): what the ready room shows about another player. */
export interface RoomPlayerInfo {
  slot: number;
  nick: string;
  rank: number;
  /** the 18 equip pairs' item ids (0-4 weapons, 8 chara, 9 head, 10 face, 17 beret) */
  equip: number[];
  season: PlayerRecord;
  total: PlayerRecord;
  /** PC-cafe type (0 none) and clan name ("" = none) of UserInfoBasic */
  cafe: number;
  clan: string;
}

/** Body of 3597 after the opcode: H 0, D 0, accessory pair, 2 x 12 D records (season, basic), C 3 + 3 pairs,
 * 18 chara-block pairs [D itemId][D objectId], C 3 + 3 zero bytes, then UserInfoBasic (U66 nick, D display rank, D rank). */
export function parsePlayerInfoAck(r: PacketReader, slot: number): RoomPlayerInfo {
  r.readH(); r.readD();
  r.skip(8);
  const rec = (): PlayerRecord => {
    const v = Array.from({ length: 12 }, () => r.readD());
    return { matches: v[0], wins: v[1], loses: v[2], draws: v[3], kills: v[4], headshots: v[5], deaths: v[6], totalKills: v[8], escapes: v[9], assists: v[10], mvp: v[11] };
  };
  const season = rec(), total = rec();
  r.readC(); r.skip(24);
  const equip = Array.from({ length: 18 }, () => { const id = r.readD(); r.readD(); return id; });
  r.readC(); r.skip(3);
  const nick = r.readU(66);
  r.readD();
  const rank = r.readD();
  // rest of UserInfoBasic (server metaPackets.ts writeUserInfoBasic): 67 bytes to the PC-cafe byte, then U34 clan name
  r.skip(67);
  const cafe = r.readC();
  r.readC();
  const clan = r.readU(34);
  return { slot, nick, rank, equip, season, total, cafe, clan };
}

export interface SlotInfo {
  slot: number;
  state: number; // wire value (see slotStateName)
  team: number; // 0 FR (red), 1 CT (blue)
  nick: string;
  rank: number;
  /** account authLevel (0 normal, >0 GM / MOD): only the JOIN_ROOM_ACK record carries it, other packets give 0 */
  auth?: number;
  /** PC-cafe type (record byte +15, 0 none), clan name, nick colour index (the last one only in the full records) */
  cafe?: number;
  clan?: string;
  nickColor?: number;
  /** clan emblem (logo D; 0xFFFFFFFF = no clan / no mark) */
  clanLogo?: number;
  /** name-card outline colour index (1600205; 0 = none) and muzzle flash colour index (1600187; 0 = none): full records and 3671 / 3639 */
  nickBorderColor?: number;
  muzzleColor?: number;
}

export interface MatchEndpoint {
  slot: number;
  udpType: number;
  ip: string;
  port: number;
  uniqueRoomId: number;
  roomSeed: number;
  /** /signal proof for this battle and slot (server text frame sent just before our 5130; undefined from a non-web server) */
  signalTicket?: string;
}

/** the account's clan at the end of the match (5140 own record, server ClanModel): grade = `rank`, emblem = `logo` (D, 0xFFFFFFFF = none) */
export interface EndBattleClan { id: number; name: string; rank: number; unit: number; logo: number; nameColor: number; effect: number }

/** clan block of the own 5140 record, read after the slot tables (roomPackets.ts endBattleAck): nick, D rank, D exp..., D clan id, D access, C cafe, C, then the clan */
function readEndBattleClan(r: PacketReader): EndBattleClan {
  r.skip(r.readC()); // nick: C bytes + U
  r.skip(43); // D displayRank, D rank, D gold, Q exp, D, C, Q, C, C, D tags, D cash
  const id = r.readD();
  r.readD(); // clanAccess
  r.skip(10); // D, D, C cafe, C
  const name = r.readU(r.readC());
  const rank = r.readC(), unit = r.readC(), logo = r.readD(), nameColor = r.readC(), effect = r.readC();
  return { id, name, rank, unit, logo, nameColor, effect };
}

export interface EndBattleInfo {
  winner: number; // 0 FR, 1 CT, 2 draw
  frKills?: number;
  ctKills?: number;
  /** 5140 result table (AllUtils.GetBattleResult): exp / gold earned per slot, and the round counts of the round modes */
  exp?: number[];
  gold?: number[];
  frRounds?: number;
  ctRounds?: number;
  /** the account's clan (5140 own record); absent when the body is short */
  clan?: EndBattleClan;
  /** the local player left (give up): no result screen */
  left?: boolean;
  /** the away kick left for him (awayChecker.ts): the room tells him why (STBL_IDX_EP_GAME_AWAY_INPUT_LOBBY) */
  away?: boolean;
}

/** 5153 ROUND_START: C rounds, D timeLeft, D slotsFlag, C swap, H FR rounds, H CT rounds (server roomPackets roundStartAck). */
export interface RoundStartInfo { round: number; timeLeft: number; swap: boolean; frRounds: number; ctRounds: number; /** bit per slot that plays this round (late joiners of a round mode are left out: spectators) */ slotsFlag: number }
/** 5155 ROUND_END: C winner (0 FR, 1 CT, 2 draw), C motive (1 time out, 2 bomb fire, 3 uninstall, 4 all dead), H FR, H CT. */
export interface RoundEndInfo { winner: number; motive: number; fr: number; ct: number }
/** 5157 installed / 5159 uninstalled: the slot that did it, the site (C zone) and the position. */
/** 5167 GENERATOR_INFO_ACK: H bar1, H bar2, 18 x H DamageBar1 (per slot index). */
export interface GeneratorInfo { bar1: number; bar2: number; damage: number[] }
export interface BombNetEvent { kind: "planted" | "defused"; slot: number; zone: number; pos: [number, number, number]; /** seconds of fuse left when the server says so (resync ACK, web extension); undefined = the plant itself */ fuse?: number }

export interface DeathInfo {
  killerSlot: number;
  weaponId: number;
  victims: { slot: number; headshot: boolean }[];
  frKills: number;
  ctKills: number;
}

/** 246-byte RoomInfo block (GameServerPacket.WriteRoomInfoBlock). */
export function parseRoomInfoBlock(r: PacketReader): RoomSummary {
  const start = r.pos;
  const roomId = r.readSignedD();
  const name = r.readU(46);
  const mapId = r.readC();
  const rule = r.readC();
  const stage = r.readC();
  const roomType = r.readC();
  const state = r.readC();
  const players = r.readC();
  const slotCount = r.readC();
  const ping = r.readC();
  const weaponsFlag = r.readH();
  const flag = r.readD();
  r.readH();
  const newInt = r.readD();
  r.readH();
  const leaderName = r.readU(66);
  const killTime = r.readD();
  // option half (limit, watchRule, balance, randomMaps, ...): may be truncated on broadcasts
  let opts: RoomOptionFields | undefined;
  if (r.remaining >= 1 + 1 + 2 + 24 + 1 + 4 + 1) {
    const limit = r.readC(), watchRuleFlag = r.readC(), balanceType = r.readH(), randomMaps = r.readB(24);
    const countdown = r.readC(), leaderAddr = r.readB(4), killCam = r.readC();
    opts = { ping, flag, newInt, limit, watchRuleFlag, balanceType, randomMaps, countdown, leaderAddr, killCam };
  }
  r.pos = Math.min(r.data.length, start + 246);
  return { roomId, name, mapId, rule, stage, roomType, state, players, slotCount, weaponsFlag, leaderName, killTime, opts };
}

function parseSlotRecord(r: PacketReader, team: number): SlotInfo {
  const base = r.pos;
  const state = r.readC();
  const rank = r.readC();
  r.pos = base + 34;
  const auth = r.readC();
  // clan block (server roomPackets.ts playerSlotFields): rank at base+1, D clan id, D access, C clan rank, D logo at base+11
  r.pos = base + 11;
  const clanLogo = r.readD();
  r.pos = base + 15;
  const cafe = r.readC();
  r.pos = base + 36;
  const clan = r.readU(34);
  const slot = r.readC();
  const nick = r.readU(66);
  const nickColor = r.readC();
  // playerSlotFields: nick border = field 32 (base+33), muzzle = field 137 (base+138) [server roomPackets.ts]
  r.pos = base + 33;
  const nickBorderColor = r.readC();
  r.pos = base + 138;
  const muzzleColor = r.readC();
  r.pos = Math.min(r.data.length, base + 142);
  return { slot, state, team, nick, rank, auth, cafe, clan, nickColor, clanLogo, nickBorderColor, muzzleColor };
}

type Handler = (r: PacketReader) => void;

export class RoomClient {
  readonly game: GameClient;
  room: RoomSummary | null = null;
  mySlot = -1;
  /** my account is a GM / MOD: latched from the authLevel of my own slot record (JOIN_ROOM_ACK), kept for the session */
  isGM = false;
  /** the last READY went out with mode 2: the battle starts me as a GM observer (Game: spectating, observer camera in every mode) */
  gmObserverMode = false;
  /** joined hidden (ROOM_JOIN_REQ stealth byte, honoured: a GM seated in 16 / 17): the server keeps slot.stealth, and specGM = stealth,
   *  for the whole stay in the room, whatever seat it holds later */
  hiddenGm = false;
  /** observer seats 16 / 17 are the hidden GM's: always an observer whatever READY was sent (a start that races the click, ready() without mode, a late join) */
  get gmObserver(): boolean { return this.gmObserverMode || (this.isGM && (this.mySlot >= 16 || this.hiddenGm)); }
  /** Round modes: this slot sits the round out (no body, observer camera). The 5153 slots flag leaves out a late joiner
   *  (Spectator) but carries a GM observer's seat like any other (C# GetSlotsFlag), so the GM observer is checked first. */
  sitsOutRound(slotsFlag: number): boolean { return this.gmObserver || !((slotsFlag >>> this.mySlot) & 1); }
  leaderSlot = -1;
  /** latest RESPAWN_ACK per slot of the running battle: a guest that becomes the P2P host replays them into its match core */
  readonly respawnAcks = new Map<number, RespawnAck>();
  /** Other slots' character / parts from USER_EQUIPMENT 3667 (sent to us at LOADING_START): what a player who (re)joins a
   * running battle knows before anyone respawns. Shaped like a RespawnAck for the onRespawnAck listeners only (spawn
   * counts 0: never fed to the match core). */
  readonly equipAcks = new Map<number, RespawnAck>();
  /** AiCount / AiLevel sent at create (the 246-byte RoomInfo block has no AI fields; guests only get them from
   * ROOM_CHANGE_ROOMINFO_ACK, not parsed yet). `allies` [RECRIADO]: leader-only local choice, same limitation. */
  ai: { count: number; level: number; allies?: number } | null = null;
  slots: SlotInfo[] = Array.from({ length: 18 }, (_, i) => ({ slot: i, state: 0, team: i % 2, nick: "", rank: 0 }));
  endpoint: MatchEndpoint | null = null;
  /** Slot.SpawnsCount of my slot from the last RESPAWN_ACK (goes in the UDP header). */
  mySpawns = 0;

  onChange: (() => void) | null = null;
  /** The leader changed the room's rules (name / map / mode / weapons / slots / kills): guests lose their READY. */
  onRulesChanged: (() => void) | null = null;
  onStartGame: (() => void) | null = null;
  /** BATTLE_START_COUNTDOWN_ACK 5126 as the exe reads it (signed byte): 5 = countdown started, -1 = stopped by the leader (255),
   * -2 = stopped by a player (254). src/ui/roomCountdown.ts */
  onCountdown: ((count: number) => void) | null = null;
  onBattleStart: (() => void) | null = null;
  onRespawn: ((slot: number, slotSpawns: number) => void) | null = null;
  /** Whole 5138 (weapons, character, parts) of any slot: PbBattleNet uses the character for remote models. */
  onRespawnAck: ((ack: RespawnAck) => void) | null = null;
  onDeath: ((d: DeathInfo) => void) | null = null;
  onEndBattle: ((e: EndBattleInfo) => void) | null = null;
  /** Round modes (Bomb / Destroy): the server drives the rounds; the round counter follows 5153 (timerSync sends it back). */
  onRoundStart: ((e: RoundStartInfo) => void) | null = null;
  onRoundEnd: ((e: RoundEndInfo) => void) | null = null;
  onBomb: ((e: BombNetEvent) => void) | null = null;
  /** Destroy: 5167 GENERATOR_INFO_ACK, the objectives' bars and each slot's damage this round */
  onGenerator: ((e: GeneratorInfo) => void) | null = null;
  /** current round (5153 C rounds; 1 until the first one) */
  round = 1;
  /** the last 5153: a Game created after it (map loading) still learns whether this slot plays the round or spectates it */
  lastRoundStart: RoundStartInfo | null = null;
  onKicked: ((reason: string) => void) | null = null;
  /** 3075 SERVER_MESSAGE_KICK_PLAYER_ACK (body C 0): the leader kicked me from the ready room (server handleChangeSlot already
   * removed me). 2017 exe: opcode case 0x9a14d8 posts game event 1001 (arg 0) -> room phase 0x8f54e0. */
  onRoomKicked: (() => void) | null = null;

  private off: () => void;
  private handlers = new Map<number, Handler>();
  private lastRoundEnd: { frKills?: number; ctKills?: number } | null = null;

  constructor(game: GameClient) {
    this.game = game;
    const h = (op: number, fn: Handler) => this.handlers.set(op, fn);
    h(RoomOp.ROOM_CHANGE_ROOMINFO_ACK, (r) => {
      const before = this.room;
      this.room = parseRoomInfoBlock(r);
      // The server clears every READY slot when the leader changes mode / map / weapons / slots (handleChangeRoomInfo).
      const b = before, n = this.room;
      if (b && n && !this.isLeader && (b.name !== n.name || b.mapId !== n.mapId || b.rule !== n.rule || b.stage !== n.stage || b.roomType !== n.roomType
        || b.weaponsFlag !== n.weaponsFlag || b.slotCount !== n.slotCount || b.killTime !== n.killTime)) this.onRulesChanged?.();
      // bot rooms append AiCount / AiLevel (roomPackets.ts changeRoomInfoAck): guests learn them here
      if (this.isBotRoom && r.remaining >= 2) this.ai = { count: r.readC(), level: r.readC(), allies: this.ai?.allies };
      this.changed();
    });
    h(RoomOp.ROOM_GET_SLOTINFO_ACK, (r) => this.parseSlotInfo(r));
    h(RoomOp.ROOM_GET_SLOTONEINFO_ACK, (r) => {
      r.readH();
      const team = r.readC();
      const s = parseSlotRecord(r, team);
      this.slots[s.slot] = s;
      this.changed();
    });
    // 3599: D slot, U66 nick, C colour (the slot's nick after a Change Name / Fake nick); 3629: D slot, C colour
    h(RoomOp.ROOM_GET_NICKNAME_ACK, (r) => {
      const slot = r.readD(), nick = r.readU(66), nickColor = r.readC();
      if (this.slots[slot]) { this.slots[slot] = { ...this.slots[slot], nick, nickColor }; this.changed(); }
    });
    h(RoomOp.ROOM_GET_COLOR_NICK_ACK, (r) => {
      const slot = r.readD(), nickColor = r.readC();
      if (this.slots[slot]) { this.slots[slot] = { ...this.slots[slot], nickColor }; this.changed(); }
    });
    // 3671: D slot, H muzzle colour; 3639: D slot, C outline colour
    h(RoomOp.ROOM_GET_COLOR_MUZZLE_FLASH_ACK, (r) => {
      const slot = r.readD(), muzzleColor = r.readH();
      if (this.slots[slot]) { this.slots[slot] = { ...this.slots[slot], muzzleColor }; this.changed(); }
    });
    h(RoomOp.ROOM_GET_NICK_OUTLINE_COLOR_ACK, (r) => {
      const slot = r.readD(), nickBorderColor = r.readC();
      if (this.slots[slot]) { this.slots[slot] = { ...this.slots[slot], nickBorderColor }; this.changed(); }
    });
    h(RoomOp.ROOM_TEAM_BALANCE_ACK, (r) => {
      r.readC();
      this.leaderSlot = r.readC();
      const n = r.readC();
      for (let i = 0; i < n; i++) {
        const oldSlot = r.readC();
        const newSlot = r.readC();
        r.skip(2);
        const moved = this.slots[oldSlot];
        this.slots[newSlot] = { ...moved, slot: newSlot, team: newSlot % 2 };
        this.slots[oldSlot] = { slot: oldSlot, state: 0, team: oldSlot % 2, nick: "", rank: 0 };
        if (oldSlot === this.mySlot) this.mySlot = newSlot;
      }
      this.changed();
    });
    h(RoomOp.BATTLE_START_COUNTDOWN_ACK, (r) => this.onCountdown?.((r.readC() << 24) >> 24));
    h(RoomOp.BATTLE_START_GAME_ACK, () => this.onStartGame?.());
    // PROTOCOL_ROOM_GET_USER_EQUIPMENT_ACK 3667 (server roomPackets userEquipmentAck): H 0 | D 0 Q D | C 10 | D chara,
    // 9 x D parts (head face jacket pocket glove belt holster skin beret) | C 8 | 8 x D weapons | C 2 D D | C slot.
    // A slot without equipment sends just D 0x08000000.
    h(3667, (r) => {
      r.readH();
      if (r.readD() !== 0) return;
      r.skip(8 + 4 + 1);
      const chara = r.readD();
      const parts = Array.from({ length: 9 }, () => r.readD());
      r.skip(1);
      const w = Array.from({ length: 8 }, () => r.readD());
      r.skip(1 + 8);
      const slot = r.readC();
      const a: RespawnAck = { slot, roomSpawns: 0, slotSpawns: 0, weapons: { primary: w[0], secondary: w[1], melee: w[2], grenade: w[3], special: w[4] }, chara, parts: parts.slice(0, 8), beret: parts[8], accessory: null };
      this.equipAcks.set(slot, a);
      console.info(`[room] USER_EQUIPMENT slot ${slot}: chara ${chara}, head ${parts[0]}, face ${parts[1]}, beret ${parts[8]}${this.onRespawnAck ? "" : " (held until the battle screens chain)"}`);
      this.onRespawnAck?.(a);
    });
    // PROTOCOL_BATTLE_LEAVEP2PSERVER_ACK: the battle's host left, D = the new leader slot (Server.Game GiveUp / RemovePlayer)
    h(5149, (r) => { const l = r.readD(); if (l >= 0 && l < 18) { this.leaderSlot = l; this.changed(); } });
    h(RoomOp.BATTLE_STARTBATTLE_ACK, () => this.onBattleStart?.());
    h(RoomOp.BATTLE_RESPAWN_ACK, (r) => {
      const at = r.pos;
      const slot = r.readD();
      r.readD(); // room spawns
      const slotSpawns = r.readD();
      if (slot === this.mySlot) this.mySpawns = slotSpawns;
      this.onRespawn?.(slot, slotSpawns);
      r.pos = at; // the whole body (weapons, character, parts) for the loadout; short / synthetic bodies stop above
      let a: RespawnAck | null = null;
      try { a = parseRespawnAck(r); } catch { /* truncated body: slot + spawns only */ }
      if (a) this.respawnAcks.set(a.slot, a);
      if (a) this.onRespawnAck?.(a);
    });
    h(RoomOp.BATTLE_DEATH_ACK, (r) => {
      r.readC(); // kill type
      const count = r.readC();
      const killerSlot = r.readC();
      const weaponId = r.readD();
      r.skip(12 + 2);
      const victims: DeathInfo["victims"] = [];
      for (let i = 0; i < count; i++) {
        const slot = r.readC();
        r.readC();
        const hitspot = r.readC();
        r.skip(2 + 1 + 12 + 1 + 4);
        victims.push({ slot, headshot: hitspot >> 4 === 3 });
      }
      const frKills = r.readH();
      r.skip(4);
      const ctKills = r.readH();
      this.onDeath?.({ killerSlot, weaponId, victims, frKills, ctKills });
    });
    h(RoomOp.BATTLE_ROUND_END_ACK, (r) => {
      // C winner | C reason | H FRkills | H CTkills — broadcast framing drops the last 2 bytes.
      const winner = r.readC(), motive = r.readC();
      const frKills = r.remaining >= 2 ? r.readH() : undefined;
      const ctKills = r.remaining >= 2 ? r.readH() : undefined;
      this.lastRoundEnd = { frKills, ctKills };
      this.onRoundEnd?.({ winner, motive, fr: frKills ?? 0, ct: ctKills ?? 0 });
    });
    h(RoomOp.BATTLE_ROUND_START_ACK, (r) => {
      const round = r.readC(), timeLeft = r.readD();
      const slotsFlag = r.readD();
      const swap = r.readC() !== 0, fr = r.readH(), ct = r.readH();
      this.round = round;
      this.lastRoundStart = { round, timeLeft, swap, frRounds: fr, ctRounds: ct, slotsFlag };
      this.onRoundStart?.(this.lastRoundStart);
    });
    h(RoomOp.BATTLE_MISSION_BOMB_INSTALL_ACK, (r) => {
      const slot = r.readD(), zone = r.readC();
      const h16 = r.readH(); // 42 / 0 at the plant; 0x8000 | tenths of a second left in the server's 1 s resync
      this.onBomb?.({ kind: "planted", slot, zone, pos: [r.readT(), r.readT(), r.readT()], fuse: h16 & 0x8000 ? (h16 & 0x7fff) / 10 : undefined });
    });
    h(RoomOp.BATTLE_MISSION_BOMB_UNINSTALL_ACK, (r) => this.onBomb?.({ kind: "defused", slot: r.readD(), zone: 0, pos: [0, 0, 0] }));
    h(RoomOp.BATTLE_MISSION_GENERATOR_INFO_ACK, (r) => {
      const bar1 = r.readH(), bar2 = r.readH();
      const damage = Array.from({ length: 18 }, () => r.readH());
      this.onGenerator?.({ bar1, bar2, damage });
    });
    h(RoomOp.BATTLE_ENDBATTLE_ACK, (r) => {
      r.readD(); // slot flag
      const winner = r.readC();
      // D slotFlag | C winner | 378 B result (exp u16 x18 @0, gold u16 x18 @36, bonuses...) | D missionFlag | round modes: H fr, H ct, H, H, zeros(36)
      // | zeros(36) unless mode 0/7/9/10/12 | zeros(5), C x5, D x5, (C rank, H, D) x18, zeros(108) | own account record: clan block
      // (server roomPackets.ts endBattleAck; mode 11 = Battle Royale, not roomType / 4)
      const extra: Partial<EndBattleInfo> = {};
      try {
        const t = r.readB(378), dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
        extra.exp = Array.from({ length: 18 }, (_, i) => dv.getUint16(i * 2, true));
        extra.gold = Array.from({ length: 18 }, (_, i) => dv.getUint16(36 + i * 2, true));
        r.readD();
        const rt = this.room?.roomType ?? 4;
        const mode = rt === 11 ? 11 : Math.trunc(rt / 4);
        if ([2, 3, 4, 5, 7, 8, 12, 13, 15, 16, 17, 18, 19].includes(mode)) {
          extra.frRounds = r.readH(); extra.ctRounds = r.readH();
          r.skip(40);
        }
        if (![0, 7, 9, 10, 12].includes(mode)) r.skip(36);
        r.skip(264);
        extra.clan = readEndBattleClan(r);
      } catch { /* short body: winner only */ }
      this.onEndBattle?.({ winner, ...(this.lastRoundEnd ?? {}), ...extra });
      this.lastRoundEnd = null;
      this.endpoint = null;
      this.respawnAcks.clear();
      this.equipAcks.clear();
    });
    h(RoomOp.SERVER_MESSAGE_KICK_PLAYER_ACK, () => this.onRoomKicked?.());
    h(RoomOp.SERVER_MESSAGE_KICK_BATTLE_PLAYER_ACK, (r) => this.onKicked?.(`kick 0x${r.readD().toString(16)}`));
    this.off = game.conn.on((op, r) => {
      const fn = this.handlers.get(op);
      if (!fn) return;
      try { fn(r); } catch (e) { console.warn(`[room] parse ${op}`, e); }
    });
  }

  /** GET_USER_EQUIPMENT_REQ 3666 for one slot: character / parts / weapons of a player whose 5138 this client never saw (late joiner, observer) */
  requestEquip(slot: number): void {
    if (slot !== this.mySlot && slot >= 0 && slot < 18) this.game.conn.send(3666, new PacketWriter().writeC(slot));
  }

  /** 3667 lands at LOADING_START, before the battle screens chain onRespawnAck: they call this once chained. */
  replayEquip(): void {
    for (const a of this.equipAcks.values()) this.onRespawnAck?.(a);
    // and ask again for every other player in the battle now that the listeners exist (GET_USER_EQUIPMENT_REQ 3666, D slot
    // as a C): covers a 3667 that came before this client's LOADING_START or whose slot changed since
    for (const s of this.slots) {
      if (s.slot !== this.mySlot && s.nick && s.state >= 14) this.game.conn.send(3666, new PacketWriter().writeC(s.slot));
    }
  }

  dispose(): void {
    this.off();
  }

  get isLeader(): boolean {
    return this.mySlot >= 0 && this.mySlot === this.leaderSlot;
  }

  /** RoomModel.IsBotMode: StageOptions AI (2), DieHard (4) or Infection (6). */
  get isBotRoom(): boolean {
    const st = this.room?.stage ?? 0;
    return st === 2 || st === 4 || st === 6;
  }

  private changed(): void {
    if ((this.slots[this.mySlot]?.auth ?? 0) > 0) this.isGM = true;
    this.onChange?.();
  }

  private parseSlotInfo(r: PacketReader): void {
    this.leaderSlot = r.readC();
    const states: { state: number; rank: number; cafe: number; clan: string; clanLogo: number }[] = [];
    for (let i = 0; i < 18; i++) {
      const base = r.pos;
      // `H 36` | C state | 35 fixed bytes (cafe at +15) | C clanNameBytes | U[clanNameBytes] (empty slot: 37 bytes)
      r.readH();
      const state = r.readC();
      const rank = r.readC();
      // D logo at +11 (empty slot: 0xFFFFFFFF, the zeros(10) + D block of server roomPackets.ts)
      r.pos = base + 2 + 11;
      const clanLogo = r.readD();
      r.pos = base + 2 + 15;
      const cafe = r.readC();
      r.pos = base + 2 + 36;
      const clanLen = r.readC();
      const clan = r.readU(clanLen);
      r.pos = base + 2 + 37 + clanLen;
      states.push({ state, rank, cafe, clan, clanLogo });
    }
    for (let i = 0; i < 18; i++) {
      const s = this.slots[i];
      const team = r.remaining > 0 ? r.readC() : s.team;
      const { state, rank, cafe, clan, clanLogo } = states[i];
      this.slots[i] = { ...s, slot: i, state, rank, team, cafe, clan, clanLogo, nick: state === 0 || state === 1 ? "" : s.nick };
    }
    this.changed();
  }

  /** Sends REQ and waits for ACK (ACK listener is registered before sending). */
  private async request(reqOp: number, body: PacketWriter | undefined, ackOp: number, timeoutMs = 5000): Promise<PacketReader> {
    const ack = this.game.conn.waitFor(ackOp, timeoutMs);
    this.game.conn.send(reqOp, body);
    return ack;
  }

  async create(o: CreateRoomOptions): Promise<RoomSummary> {
    const m = { ...METRO_TDM, ...o };
    const w = new PacketWriter(256);
    w.writeD(0).writeU(o.name, 46)
      .writeC(m.mapId).writeC(m.rule).writeC(m.stage).writeC(m.roomType)
      .writeC(RoomState.READY).writeC(0).writeC(o.slots ?? 16).writeC(0)
      .writeH(o.weaponsFlag ?? 0x1ff).writeD(o.flag ?? 0).writeH(0).writeD(0).writeH(0)
      .writeU("", 66).writeD(o.killTime ?? 0x63).writeC(o.limit ?? 0).writeC(o.watchRule ?? 0).writeH(0)
      .writeB(o.randomMaps ?? new Uint8Array(24)).writeC(o.cdFlag ?? 1).zeros(4).writeC(0).writeH(0)
      .writeS(o.password ?? "", 4).zeros(68).writeC(o.ai?.count ?? 0).writeC(o.ai?.level ?? 0).writeC(o.ai?.type ?? 0);
    this.ai = o.ai ? { count: o.ai.count, level: o.ai.level, allies: o.ai.allies } : null;
    // Account ctor sets LastCreateRoom = now, so the server silently drops creates for 4 s after
    // USER_ENTER (and 4 s after each create): retry a few times instead of failing.
    let r: PacketReader | null = null;
    for (let attempt = 0; attempt < 3 && !r; attempt++) {
      r = await this.request(RoomOp.ROOM_CREATE_REQ, w, RoomOp.ROOM_CREATE_ACK, 2000).catch(() => null);
      if (!r && attempt < 2) await new Promise((res) => setTimeout(res, 2500));
    }
    if (!r) throw new Error("CREATE_ROOM: sem resposta (servidor ignora < 4s após entrar/último create, já em sala ou sem nick)");
    const idOrErr = r.readD();
    if (r.remaining < 246) throw new GameError("CREATE_ROOM", idOrErr);
    this.room = parseRoomInfoBlock(r);
    this.mySlot = 0;
    this.leaderSlot = 0;
    this.slots = Array.from({ length: 18 }, (_, i) => ({ slot: i, state: 0, team: i % 2, nick: "", rank: 0 }));
    this.slots[0] = { slot: 0, state: 12, team: 0, nick: this.room.leaderName, rank: 0 };
    this.changed();
    return this.room;
  }

  /** Another player's chara, parts and records (ROOM_GET_PLAYERINFO_REQ 3596 -> 3597); null when the server stays
   * silent (empty slot, player gone). */
  async getPlayerInfo(slot: number, timeoutMs = 3000): Promise<RoomPlayerInfo | null> {
    const w = new PacketWriter(8).writeD(slot);
    const r = await this.request(RoomOp.ROOM_GET_PLAYERINFO_REQ, w, RoomOp.ROOM_GET_PLAYERINFO_ACK, timeoutMs).catch(() => null);
    if (!r) return null;
    try { return parsePlayerInfoAck(r, slot); } catch { return null; }
  }

  /** Leader only, ready room: ROOM_CHANGE_ROOMINFO_REQ (3640). The server answers with 3601 (handled above) + 3637. */
  changeRoomInfo(ch: RoomChange): boolean {
    if (!this.room || !this.isLeader) return false;
    if (ch.ai && this.ai) this.ai = { ...this.ai, count: ch.ai.count, level: ch.ai.level };
    this.game.conn.send(RoomOp.ROOM_CHANGE_ROOMINFO_REQ, buildChangeRoomInfoBody(this.room, ch, this.ai));
    return true;
  }

  /** `stealth` (web extension, GM accounts only): join hidden in an observer seat; the server ignores it for other accounts */
  async join(roomId: number, password = "", stealth = false): Promise<number> {
    const w = new PacketWriter().writeD(roomId).writeS(password, 4).writeC(0).writeC(stealth ? 1 : 0);
    const r = await this.request(RoomOp.ROOM_JOIN_REQ, w, RoomOp.ROOM_JOIN_ACK);
    return this.adopt(r, stealth);
  }

  /** The ROOM_JOIN_ACK (3586) body, reader right after the opcode: seats this client in the room the server put it in. join() reads
   *  it after its request; the clan-war pairing (clanWarHandlers buildBattleRoom) pushes the same ACK, with no request. */
  adopt(r: PacketReader, stealth = false): number {
    r.readH();
    const err = r.readD();
    if (err !== 0) throw new GameError("JOIN_ROOM", err);
    const nTeams = r.readC();
    const teams = Array.from({ length: nTeams }, () => r.readC());
    const nSlots = r.readC();
    for (let i = 0; i < nSlots; i++) {
      const s = parseSlotRecord(r, teams[i] ?? i % 2);
      this.slots[s.slot] = s;
    }
    r.skip(3);
    r.readC(); // slot count
    this.leaderSlot = r.readC();
    r.skip(1 + 1 + 4); // countdown, randmaps count + entries
    const opt = r.readB(175);
    const basic = r.readB(71);
    const blob = new Uint8Array(246);
    blob.set(basic, 0);
    blob.set(opt, 71);
    this.room = parseRoomInfoBlock(new PacketReader(blob));
    this.mySlot = r.readC();
    if ((this.slots[this.mySlot]?.auth ?? 0) > 0) this.isGM = true;
    this.hiddenGm = stealth && this.isGM && this.mySlot >= 16;
    this.changed();
    return this.mySlot;
  }

  /** READYBATTLE: guest toggles READY; leader starts the match (needs a READY player on the other team). */
  /** `mode` 2 = GM observer (the room's "GM observer" checkbox): the server honours it only for a GM account (roomHandlers.ts specGM) */
  ready(mode: 0 | 2 = 0): void {
    if (this.isGM && (this.mySlot >= 16 || this.hiddenGm)) mode = 2; // hidden GM: READY is always mode 2 (same as the server's specGM = stealth)
    this.gmObserverMode = mode === 2;
    this.game.conn.send(RoomOp.BATTLE_READYBATTLE_REQ, new PacketWriter().writeC(mode).writeD(0));
  }

  /** Leader-side start. Resolves "game" when START_GAME (5127) arrives, "countdown" on BATTLE_START_COUNTDOWN_ACK (5126: a countdown
   * mode, START_GAME follows when it ends); rejects on READYBATTLE_ACK error. */
  async start(timeoutMs = 15000): Promise<"game" | "countdown"> {
    return new Promise<"game" | "countdown">((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(new Error("READYBATTLE: partida não iniciou (sem START_GAME)")); }, timeoutMs);
      const off = this.game.conn.on((op, r) => {
        if (op === RoomOp.BATTLE_START_GAME_ACK || op === RoomOp.BATTLE_START_COUNTDOWN_ACK) {
          clearTimeout(t);
          off();
          resolve(op === RoomOp.BATTLE_START_GAME_ACK ? "game" : "countdown");
        } else if (op === RoomOp.BATTLE_READYBATTLE_ACK) {
          r.skip(3); // H 0, C 0
          const err = r.readD();
          if (err & 0x80000000) {
            clearTimeout(t);
            off();
            reject(new GameError("READYBATTLE", err)); // 0x80001009: nenhum jogador READY no outro time
          }
        }
      });
      this.ready();
    });
  }

  /** Move myself to an empty slot of `team` (slot must be NORMAL, not READY). */
  changeTeam(team: number): boolean {
    const target = this.slots.find((s) => s.slot % 2 === team && s.state === 0 && s.slot < (this.room?.slotCount ?? 16));
    if (!target) return false;
    this.game.conn.send(RoomOp.ROOM_PERSONAL_TEAM_CHANGE_REQ, new PacketWriter().writeD(team).writeC(target.slot));
    return true;
  }

  /** Leader: kick the player of `slot` or close it; a closed slot (state 1) is opened (flag 0x10000000). ROOM_CHANGE_SLOT_REQ
   * (3604, server roomHandlers.ts handleChangeSlot; Cross exe 0x7ca430 SetEvent 508). */
  changeSlot(slot: number): void {
    const closed = this.slots.find((s) => s.slot === slot)?.state === 1;
    this.game.conn.send(RoomOp.ROOM_CHANGE_SLOT_REQ, new PacketWriter().writeD(slot | (closed ? 0x10000000 : 0)));
  }

  /** Leader: hand the room to `slot` (Novo dono, context menu item 0). PROTOCOL_ROOM_REQUEST_MAIN_CHANGE_WHO_REQ 3615 {slot};
   * the answer is 3616 {slot}.
   * Cross exe path: OnCommand 0x7c94a0 case 0 -> 0x7ca400(slot) -> SetEvent 0x86 -> 0x592ea4 writes D slot (payload shape
   * matches; the internal id 0xf1e -> wire 3615 mapping is [INFERIDO], the same table as kick 0x1fc -> 0xf09 / 3604). Live: leaderTransfer.live.ts. */
  changeLeader(slot: number): void {
    this.game.conn.send(RoomOp.ROOM_REQUEST_MAIN_CHANGE_WHO_REQ, new PacketWriter().writeD(slot));
  }

  /** Move myself to a specific empty slot (the slot picked in the ReadyRoom team list, PB's own behavior). */
  changeTeamSlot(slot: number): boolean {
    if (slot < 0 || slot >= (this.room?.slotCount ?? 16) || slot === this.mySlot) return false;
    const target = this.slots.find((s) => s.slot === slot);
    if (!target || target.state !== 0) return false;
    this.game.conn.send(RoomOp.ROOM_PERSONAL_TEAM_CHANGE_REQ, new PacketWriter().writeD(slot % 2).writeC(slot));
    return true;
  }

  async loadingStart(): Promise<void> {
    const name = this.room ? mapName(this.room.mapId) : METRO_TDM.mapName;
    await this.request(RoomOp.ROOM_LOADING_START_REQ, new PacketWriter().writeC(name.length).writeS(name, name.length), RoomOp.ROOM_LOADING_START_ACK);
  }

  /** PRESTARTBATTLE -> 5130 with the Match endpoint. The leader must have sent LOADING_START first. */
  async preStart(): Promise<MatchEndpoint> {
    const room = this.room!;
    const w = new PacketWriter().writeC(room.mapId).writeC(room.rule).writeC(room.stage).writeC(room.roomType);
    // The leader also gets a 5130 for every guest's PRESTART (same layout, guest's slot): wait for ours.
    const r = await new Promise<PacketReader>((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(new Error("PRESTARTBATTLE: sem resposta")); }, 8000);
      const off = this.game.conn.on((op, pr) => {
        if (op !== RoomOp.BATTLE_PRESTARTBATTLE_ACK) return;
        const at = pr.pos;
        const other = pr.remaining >= 8 && pr.readD() === 1 && pr.readD() !== this.mySlot;
        pr.pos = at;
        if (other) return;
        clearTimeout(t);
        off();
        resolve(pr);
      });
      this.game.conn.send(RoomOp.BATTLE_PRESTARTBATTLE_REQ, w);
    });
    const ok = r.readD();
    if (ok !== 1) throw new Error("PRESTARTBATTLE recusado (mapa/regra não conferem ou líder ainda não fez LOADING_START)");
    const slot = r.readD();
    const udpType = r.readC();
    const ip = [...r.readB(4)].join(".");
    r.readB(4);
    const port = r.readH();
    const uniqueRoomId = r.readD();
    const roomSeed = r.readD();
    this.endpoint = { slot, udpType, ip, port, uniqueRoomId, roomSeed, signalTicket: this.game.conn.signalTicket ?? undefined };
    return this.endpoint;
  }

  /** STARTBATTLE (5131). The server spawns everyone CountdownIG s after the last player sends it. */
  startBattle(): void {
    this.game.conn.send(RoomOp.BATTLE_STARTBATTLE_REQ);
  }

  /**
   * RESPAWN (5137, 154 bytes). `equip` = the 18 S2_CHAR_CHANGE_EQUIP_INFO pairs (weapons [0..4] = the respawn
   * weapon choice, respawnSelect.ts). Items are validated against the inventory: a zero/unknown weapon becomes the
   * server default (ComDiv.CheckEquipedItems -> 103004...), so pass the real itemIds.
   */
  async respawn(weaponsFlag = this.room?.weaponsFlag ?? 0x1ff, equip?: EquipPair[]): Promise<number> {
    const w = equip ? buildRespawnBody(equip, weaponsFlag) : new PacketWriter(160).zeros(7 * 8 + 8 + 10 * 8).writeH(weaponsFlag & 0xf).zeros(8);
    const ack = new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(new Error("RESPAWN: sem RESPAWN_ACK")); }, 5000);
      const off = this.game.conn.on((op, r) => {
        if (op !== RoomOp.BATTLE_RESPAWN_ACK) return;
        const slot = r.readD();
        if (slot !== this.mySlot) return;
        r.readD();
        clearTimeout(t);
        off();
        resolve(r.readD());
      });
    });
    this.game.conn.send(RoomOp.BATTLE_RESPAWN_REQ, w);
    this.mySpawns = await ack;
    return this.mySpawns;
  }

  /** BATTLE_DEATH_REQ: must be sent by the killer (killerSlot == mySlot). */
  reportKill(victimSlot: number, weaponId: number, headshot: boolean, killerPos: [number, number, number] = [0, 0, 0], victimPos: [number, number, number] = [0, 0, 0]): void {
    const w = new PacketWriter(64).writeC(0).writeC(1).writeC(this.mySlot).writeD(weaponId)
      .writeT(killerPos[0]).writeT(killerPos[1]).writeT(killerPos[2]).writeC(0).writeC(0);
    const deathType = headshot ? 3 : 1; // CharaDeath.HEADSHOT / DEFAULT
    w.writeC(victimSlot).writeC(Math.floor(weaponId / 100000) % 100).writeC((deathType << 4) | (victimSlot & 15)).writeH(0).writeC(0)
      .writeT(victimPos[0]).writeT(victimPos[1]).writeT(victimPos[2])
      .writeC(this.mySlot).zeros(4); // assist = killer (no assist); server indexes Slots[assist], 255 throws
    this.game.conn.send(RoomOp.BATTLE_DEATH_REQ, w);
  }

  /** TIMERSYNC with timeRemaining 0 ends the TDM round (there is no server-side battle clock). */
  timerSync(timeRemaining: number): void {
    const round = this.round;
    this.game.conn.send(RoomOp.BATTLE_TIMERSYNC_REQ, new PacketWriter().writeD(timeRemaining).writeT(0).writeC(round).writeC(5).writeC(0).writeH(30));
  }

  /** BOMB_INSTALL_REQ 5156: D slot, C zone (site index), D flag, 3T pos. The server answers everyone with 5157 (onBomb).
   *  `slot` = a bot's seat when the match host plants for its AI (the server takes it from the leader of an AI room only). */
  bombInstall(zone: number, pos: [number, number, number], slot = this.mySlot): void {
    this.game.conn.send(RoomOp.BATTLE_MISSION_BOMB_INSTALL_REQ, new PacketWriter(24).writeD(slot).writeC(zone).writeD(0).writeT(pos[0]).writeT(pos[1]).writeT(pos[2]));
  }

  /** GENERATOR_INFO_REQ 5166 (Destroy, sent by the match host's leader): H bar1, H bar2, 18 x H cumulative damage per slot.
   *  The server answers everyone with 5167 (onGenerator) and ends the round when a bar is 0. */
  generatorInfo(bar1: number, bar2: number, damage: number[]): void {
    const w = new PacketWriter(40).writeH(bar1).writeH(bar2);
    for (let i = 0; i < 18; i++) w.writeH(damage[i] ?? 0);
    this.game.conn.send(RoomOp.BATTLE_MISSION_GENERATOR_INFO_REQ, w);
  }

  /** BOMB_UNINSTALL_REQ 5158: D slot. The server answers everyone with 5159 and ends the round for the defenders. */
  bombUninstall(slot = this.mySlot): void {
    this.game.conn.send(RoomOp.BATTLE_MISSION_BOMB_UNINSTALL_REQ, new PacketWriter(8).writeD(slot));
  }

  /** 5199 (web-only, F2 test menu): 1 = explode the planted C4 now, 2 = end the round. The server answers with the normal ACKs. */
  devBomb(action: 1 | 2): void {
    this.game.conn.send(5199, new PacketWriter(4).writeC(action));
  }

  giveUp(): void {
    // the TCP session may already be gone (server closed it): leaving must still work, the server removed us on its side
    try { this.game.conn.send(RoomOp.BATTLE_GIVEUPBATTLE_REQ, new PacketWriter().writeD(0)); } catch (e) { console.warn("[room] giveUp:", (e as Error).message); }
  }

  /** LOBBY_ENTER while in a room removes us from it. */
  async leave(): Promise<void> {
    await this.request(RoomOp.LOBBY_ENTER_REQ, undefined, RoomOp.LOBBY_ENTER_ACK).catch(() => null);
    this.room = null;
    this.mySlot = -1;
    this.endpoint = null;
  }
}

export function mapName(mapId: number): string {
  return ({ 4: NSTATION_TDM.mapName, 36: METRO_TDM.mapName } as Record<number, string>)[mapId] ?? `Map${mapId}`;
}
