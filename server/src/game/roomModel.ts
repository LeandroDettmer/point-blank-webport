// Server.Game/Data/Models/RoomModel.cs + Plugin.Core/Models/SlotModel.cs: in-memory rooms and slots, the enums, the
// map limits (SystemMapXML: system_map_matches + system_map_rules) and the room broadcast helpers.
import { pool } from "../db.ts";
import type { Account } from "../shared/account.ts";
import type { PlayerEquipment, PlayerMissions } from "../shared/models.ts";
import type { ChannelModel } from "./channel.ts";
import type { ClanTeam } from "./clanWarHandlers.ts";

export const RoomState = { UNK: 0, READY: 1, COUNTDOWN: 2, LOADING: 3, RENDEZVOUS: 4, PRE_BATTLE: 5, BATTLE_READY: 6, BATTLE: 7, BATTLE_END: 8, EMPTY: 9 } as const;
export const SlotState = {
  EMPTY: 0, CLOSE: 1, UNKNOWN: 2, SHOP: 3, INFO: 4, CLAN: 5, INVENTORY: 6, GACHA: 7, GIFTSHOP: 8, NORMAL: 9, READY: 10, LOAD: 11,
  RENDEZVOUS: 12, PRESTART: 13, BATTLE_LOAD: 14, BATTLE_READY: 15, BATTLE: 16, PLAYING: 18,
} as const;
export const Team = { ALL: -1, FR: 0, CT: 1, DRAW: 2 } as const;
export const RoomCondition = {
  DeathMatch: 4, Bomb: 8, BattleRoyale: 11, Destroy: 12, Annihilation: 16, Defense: 20, FreeForAll: 24, Boss: 28, Ace: 32, StepUp: 36,
  Tutorial: 40, Domination: 44, CrossCounter: 48, Convoy: 52, Runaway: 56, Seize: 65, Glass: 68,
} as const;
export const StageFlag = { TEAM_SWAP: 1, RANDOM_MAP: 2, PASSWORD: 4, OBSERVER_MODE: 8, REAL_IP: 16, TEAM_BALANCE: 32, OBSERVER: 64, INTER_ENTER: 128 } as const;
export const DeadEnum = { Alive: 1, Dead: 2, UseChat: 4 } as const;
export const TIMES = [3, 3, 3, 5, 7, 5, 10, 15, 20, 25, 30];
export const KILLS = [15, 30, 50, 60, 80, 100, 120, 140, 160];
export const ROUNDS = [1, 2, 3, 5, 7, 9];
export const SWAP_ROUNDS = [1, 2, 2, 4, 6, 8];

// ---- SystemMapXML ------------------------------------------------------------------------------------------------
interface MapMatch { id: number; mode: number; limit: number; tag: number; name: string }
interface MapRule { id: number; rule: number; stageOptions: number; conditions: number; name: string }
const maps = { matches: [] as MapMatch[], rules: [] as MapRule[] };
export async function loadMaps(): Promise<void> {
  maps.matches = (await pool.query(`SELECT * FROM system_map_matches ORDER BY seq ASC`)).rows.map((x) => ({ id: Number(x.map_id), mode: Number(x.mode_id), limit: Number(x.map_limit), tag: Number(x.tag), name: String(x.name) }));
  maps.rules = (await pool.query(`SELECT * FROM system_map_rules ORDER BY seq ASC`)).rows.map((x) => ({ id: Number(x.mode_id), rule: Number(x.rule), stageOptions: Number(x.stage_options), conditions: Number(x.conditions), name: String(x.name) }));
}
/** SystemMapXML.GetMapLimit. */
export function getMapLimit(mapId: number, rule: number): MapMatch | null {
  for (const m of maps.matches) {
    if (m.id !== mapId) continue;
    if (maps.rules.some((r) => r.id === m.mode && r.rule === rule)) return m;
  }
  return null;
}

/**
 * Random-map rooms (StageFlag.RANDOM_MAP): `randomMaps` is the 24-byte list of the create window's "Mapa aleatório"
 * popup, read as a bit mask indexed by mapId (bit i of byte i >> 3) [INFERIDO: the layout is the client's, not decoded].
 * Returns the picked mapId that is valid for the room's rule, or -1 when none is set.
 */
export function pickRandomMap(randomMaps: Uint8Array, rule: number, rnd: () => number = Math.random): number {
  const ids: number[] = [];
  for (let id = 0; id < randomMaps.length * 8; id++) if ((randomMaps[id >> 3] >> (id & 7)) & 1 && getMapLimit(id, rule)) ids.push(id);
  return ids.length ? ids[Math.floor(rnd() * ids.length)] : -1;
}

// ---- SlotModel ---------------------------------------------------------------------------------------------------
export class SlotModel {
  id: number;
  team: number;
  get flag(): number { return 1 << this.id; }
  state: number = SlotState.EMPTY;
  playerId = 0n;
  equipment: PlayerEquipment | null = null;
  deathState: number = DeadEnum.Alive;
  firstRespawn = true;
  ping = 5;
  latency = 0;
  failLatencyTimes = 0;
  isPlaying = 0;
  specGM = false;
  /** GM observer that joined hidden (seat 16 / 17): only GM accounts see this slot, nobody else gets its nick, equipment or head count */
  stealth = false;
  viewType = 0;
  spectator = false;
  withHost = false;
  check = false;
  isMercenary = false;
  missionsCompleted = false;
  missions: PlayerMissions | null = null;
  aiLevel = 0;
  score = 0; allKills = 0; allDeaths = 0; allAssists = 0; allHeadshots = 0; killsOnLife = 0; lastKillState = 0; repeatLastState = false;
  passSequence = 0; spawnsCount = 0; objects = 0; earnedEXP = 0;
  /** SlotModel.DamageBar1 / DamageBar2: objective damage of this round (5166 sets bar1 per slot; zeroed at RoundRestart) */
  damageBar1 = 0; damageBar2 = 0;
  exp = 0; gold = 0; cash = 0; seasonPoint = 0; bonusSeasonPoint = 0;
  bonusFlags = 0; bonusCafeExp = 0; bonusItemExp = 0; bonusEventExp = 0; bonusCafePoint = 0; bonusItemPoint = 0; bonusEventPoint = 0; bonusBattlePass = 0;
  /** per weapon class [kills, deaths]: AR, SMG, SR, SG, MG, SHD */
  ar = [0, 0]; smg = [0, 0]; sr = [0, 0]; sg = [0, 0]; mg = [0, 0]; shd = [0, 0];
  itemUsages: number[] = [];
  startTime = 0;
  preLoadDate = 0;
  preStartDate = 0;
  timing: ReturnType<typeof setTimeout> | null = null;
  /** [web] battle guard: when the last DEATH_REQ killed this slot, the RESPAWN held until it is due,
   * the battle packets of this slot rejected in this match, and the last guard log line (rate limit) */
  deathAt = 0;
  respawnTimer: ReturnType<typeof setTimeout> | null = null;
  strikes = 0;
  guardLogAt = 0;

  constructor(id: number) {
    this.id = id;
    this.team = id % 2;
  }

  /** SlotModel.GetClientState. */
  clientState(): number {
    if (this.state === 18) return 18;
    if (this.state === SlotState.BATTLE) return this.isPlaying === 2 ? 19 : 16;
    if (this.state >= 9) return this.state + 3;
    return this.state;
  }

  stopTiming(): void { if (this.timing) clearTimeout(this.timing); this.timing = null; }

  /** SlotModel.ResetSlot (the SHD array is not cleared, like the C#). `stealth` [web] survives it: the hidden GM stays hidden after a battle; clear it where the seat is vacated. */
  resetSlot(): void {
    this.stopTiming();
    this.deathState = DeadEnum.Alive; this.ping = 5; this.latency = 0; this.failLatencyTimes = 0;
    this.score = 0; this.allKills = 0; this.allDeaths = 0; this.allAssists = 0; this.allHeadshots = 0; this.killsOnLife = 0; this.lastKillState = 0;
    this.passSequence = 0; this.spawnsCount = 0; this.objects = 0; this.earnedEXP = 0; this.damageBar1 = 0; this.damageBar2 = 0; this.exp = 0; this.gold = 0; this.cash = 0; this.seasonPoint = 0; this.bonusSeasonPoint = 0;
    this.bonusFlags = 0; this.bonusCafeExp = 0; this.bonusItemExp = 0; this.bonusEventExp = 0; this.bonusCafePoint = 0; this.bonusItemPoint = 0; this.bonusEventPoint = 0; this.bonusBattlePass = 0;
    this.isPlaying = 0; this.aiLevel = 0;
    this.check = false; this.specGM = this.stealth; this.withHost = false; // [web] a hidden GM keeps its observer role too (never leader, never waited for)
    this.spectator = false; this.repeatLastState = false; this.missionsCompleted = false;
    this.firstRespawn = true; this.missions = null; this.itemUsages = [];
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.respawnTimer = null; this.deathAt = 0; this.strikes = 0;
    this.ar = [0, 0]; this.smg = [0, 0]; this.sr = [0, 0]; this.sg = [0, 0]; this.mg = [0, 0];
  }

  /** SlotModel.InBattleTime(now): seconds since StartTime. */
  inBattleTime(now = Date.now()): number { return this.startTime ? (now - this.startTime) / 1000 : 0; }
}

/**
 * Social layer hooks (chat ring, votes, report dedupe: playerCommands / voteKick / voteLeader / chatGuard), registered by those modules
 * so roomHandlers needs no import of them. battleEndHooks run in ResetBattleInfo; slotLeftHooks when a player leaves the match
 * (RemovePlayer or GIVEUP_BATTLE), before the slot is cleared.
 */
export const battleEndHooks: ((r: RoomModel) => void)[] = [];
export const slotLeftHooks: ((r: RoomModel, slotId: number) => void)[] = [];

// ---- RoomModel ---------------------------------------------------------------------------------------------------
export interface RoomServices {
  getAccount(pid: bigint): Account | null;
  send(a: Account, bytes: Uint8Array): void;
  /** AccountStatus.Method0: UPDATE accounts SET status */
  updateStatus(a: Account): Promise<void>;
}

export class RoomModel {
  readonly roomId: number;
  readonly channel: ChannelModel;
  readonly svc: RoomServices;
  slots = Array.from({ length: 18 }, (_, i) => new SlotModel(i));
  channelId: number;
  channelType: number;
  serverId: number;
  name = ""; password = ""; mapName = ""; leaderName = "";
  mapId = 0; rule = 0; stage = 0; roomType = 0;
  state: number = RoomState.READY;
  leader = 0;
  leaderAddr: Uint8Array = new Uint8Array(4);
  ping = 5;
  weaponsFlag = 0;
  flag = 0;
  newInt = 0;
  killTime = 0;
  limit = 0;
  watchRuleFlag = 0;
  balanceType = 0;
  randomMaps: Uint8Array = new Uint8Array(24);
  countdownIG = 5;
  killCam = 0;
  aiCount = 1; aiLevel = 1; aiType = 0; ingameAiLevel = 0;
  countPlayers = 0; countMaxSlots = 0;
  rounds = 1; tRex = -1;
  seed = 0;
  readonly uniqueRoomId: number;
  frKills = 0; frDeaths = 0; frAssists = 0; ctKills = 0; ctDeaths = 0; ctAssists = 0;
  frRounds = 0; ctRounds = 0; frDino = 0; ctDino = 0; spawnsCount = 0;
  bar1 = 0; bar2 = 0;
  timeRoom = 0;
  battleStart = 0;
  /** [web] server clock of the match start (first spawn; battleStart restarts every round) and the accounts that killed, died, assisted
   * or planted / defused in it: the reward scale of calculateResult */
  matchStart = 0;
  actors = new Set<bigint>();
  startTick = 0n;
  startDate = 0;
  swapRound = false; preMatchCD = false; blockedClan = false; changingSlots = false; competitive = false; roundEnding = false; activeC4 = false;
  /** [web] clan-war match (etapa B): the two teams seated here. resetBattleInfo sends them back to READY (releaseClanMatch) */
  clanMatch: { teams: ClanTeam[] } | null = null;
  udpServer: { host: string; port: number } | null = null;
  lastChangeTeam = Date.now();
  lastPingSync = Date.now();
  kickedPlayersHost = new Map<bigint, number>();
  kickedPlayersVote: bigint[] = [];
  /** last 5146 SENDPING array of each reporter slot (b[i] = ping of slot i, 255 = unknown): voteLeader picks the best-ping candidate from them */
  pingReports = new Map<number, Uint8Array>();
  requestRoomMaster: bigint[] = [];
  /** seat of each player who left the running match (removePlayer), used by addPlayer to keep the team on re-entry */
  lastSeat = new Map<bigint, number>();
  slotRewards: { slots: number[]; items: number[] } | null = null;
  countdownTimer: ReturnType<typeof setTimeout> | null = null;
  countdownEnd = 0;
  preMatchTimer: ReturnType<typeof setTimeout> | null = null;
  roundTimer: ReturnType<typeof setTimeout> | null = null;
  bombTimer: ReturnType<typeof setTimeout> | null = null;
  /** C4 fuse clock (server authority): when it blows, the site / position (re-sent to late joiners) and the 1 s resync interval */
  bombEndAt = 0;
  bombSite = 0;
  bombPos: [number, number, number] = [0, 0, 0];
  bombSlot = 0;
  bombSyncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(roomId: number, ch: ChannelModel, svc: RoomServices) {
    this.roomId = roomId;
    this.channel = ch;
    this.svc = svc;
    this.channelId = ch.id;
    this.channelType = ch.type;
    this.serverId = ch.serverId;
    this.uniqueRoomId = ((ch.serverId & 0xff) << 20) | ((ch.id & 0xff) << 12) | (roomId & 0xfff);
  }

  generateSeed(): void { this.seed = ((this.mapId & 0xff) << 20) | ((this.rule & 0xff) << 12) | (this.roomType & 0xfff); }

  /** RoomModel.GetFlag (rewrites Flag; bit 32 TEAM_BALANCE is dropped). */
  getFlag(): number {
    let f = 0;
    if (this.flag & StageFlag.TEAM_SWAP) f += 1;
    if (this.flag & StageFlag.RANDOM_MAP) f += 2;
    if ((this.flag & StageFlag.PASSWORD) || this.password.length > 0) f += 4;
    if (this.flag & StageFlag.OBSERVER_MODE) f += 8;
    if (this.flag & StageFlag.REAL_IP) f += 16;
    if (this.flag & StageFlag.OBSERVER) f += 64;
    if ((this.flag & StageFlag.INTER_ENTER) || (this.limit > 0 && this.state > RoomState.READY)) f += 128;
    this.flag = f;
    return f;
  }

  isBotMode(): boolean { return this.stage === 2 || this.stage === 4 || this.stage === 6; }
  isDinoMode(t = ""): boolean {
    if (t === "DE") return this.roomType === RoomCondition.Boss;
    if (t === "CC") return this.roomType === RoomCondition.CrossCounter;
    return this.roomType === RoomCondition.Boss || this.roomType === RoomCondition.CrossCounter;
  }
  isPreparing(): boolean { return this.state >= RoomState.LOADING; }
  isStartingMatch(): boolean { return this.state > RoomState.READY; }
  thisModeHaveCD(): boolean { const t = this.roomType; return t === RoomCondition.Bomb || t === RoomCondition.Annihilation || t === RoomCondition.Boss || t === RoomCondition.CrossCounter || t === RoomCondition.Convoy || t === RoomCondition.Ace; }
  thisModeHaveRounds(): boolean { const t = this.roomType; return t === RoomCondition.Bomb || t === RoomCondition.Destroy || t === RoomCondition.Annihilation || t === RoomCondition.Defense || t === RoomCondition.Convoy || t === RoomCondition.Ace; }
  isTeamSwap(): boolean { return (this.flag & StageFlag.TEAM_SWAP) !== 0; }
  validateTeam(team: number, costume: number): number {
    if (this.roomType === RoomCondition.FreeForAll) return costume;
    if (this.swapRound && this.isTeamSwap()) return team === 0 ? 1 : 0;
    return team;
  }

  /** RoomModel.SetSlotCount. */
  setSlotCount(count: number, isCreate: boolean, isUpdate: boolean): void {
    const ml = getMapLimit(this.mapId, this.rule);
    if (!ml) return;
    if (count > ml.limit) count = ml.limit;
    if (this.roomType === RoomCondition.Tutorial) count = 1;
    if (this.isBotMode()) count = 8;
    if (count <= 0) count = 1;
    if (isCreate) {
      for (const s of this.slots) if (s.id >= count && s.id !== 16 && s.id !== 17) s.state = SlotState.CLOSE;
    } else if (isUpdate && !this.isBotMode()) {
      // settings window: the user limit applies to the open slots too (empty ones past the limit close, closed ones inside it
      // reopen; a slot with a player stays, nobody is kicked) [INFERIDO: the C# only closes slots at create]
      for (const s of this.slots) {
        if (s.id >= 16) continue;
        if (s.id >= count && s.state === SlotState.EMPTY && s.playerId === 0n) s.state = SlotState.CLOSE;
        else if (s.id < count && s.state === SlotState.CLOSE) s.state = SlotState.EMPTY;
      }
    }
    if (isUpdate) this.updateSlotsInfo();
  }

  getSlotCount(): number { return this.slots.filter((s) => s.id < 16 && s.state !== SlotState.CLOSE).length; }
  getSlot(i: number): SlotModel | null { return i >= 0 && i < 18 ? this.slots[i] : null; }

  /** GetCountPlayers: slots with a player whose cached account still has SlotId != -1. */
  getCountPlayers(): number {
    let n = 0;
    for (const s of this.slots) if (s.playerId > 0n) { const a = this.svc.getAccount(s.playerId); if (a && a.slotId !== -1) n++; }
    return n;
  }

  /** players a normal account may see: GetCountPlayers without the hidden GM observers (room list / room info head count) */
  getVisiblePlayers(): number {
    let n = 0;
    for (const s of this.slots) if (s.playerId > 0n && !s.stealth) { const a = this.svc.getAccount(s.playerId); if (a && a.slotId !== -1) n++; }
    return n;
  }

  /** GetAllPlayers(state, type, exc...): type 0 = state ==, 1 = state >. */
  getAllPlayers(state?: number, type?: number, ...exc: number[]): Account[] {
    const out: Account[] = [];
    for (const s of this.slots) {
      if (s.playerId <= 0n || exc.includes(s.id)) continue;
      if (state !== undefined && !(type === 0 ? s.state === state : s.state > state)) continue;
      const a = this.svc.getAccount(s.playerId);
      if (a && a.slotId !== -1) out.push(a);
    }
    return out;
  }
  getAllPlayersExceptPid(pid: bigint): Account[] { return this.getAllPlayers().filter((a) => a.playerId !== pid); }

  /** GetPlayingPlayers(team, state, type, exc). */
  getPlayingPlayers(team: number, state: number, type: number, exc = -1): number {
    let n = 0;
    for (const s of this.slots) {
      if (s.playerId <= 0n || s.id === exc || s.specGM) continue;
      if (!(type === 0 ? s.state === state : s.state > state)) continue;
      if (team !== Team.DRAW && s.team !== team) continue;
      const a = this.svc.getAccount(s.playerId);
      if (a && a.slotId !== -1) n++;
    }
    return n;
  }

  /** RoomModel.GetReadyPlayers: slots >= READY with equipment whose account sits in that slot. */
  getReadyPlayers(): number {
    let n = 0;
    for (const s of this.slots) {
      if (s.state < SlotState.READY || !s.equipment) continue;
      const a = this.svc.getAccount(s.playerId);
      if (a && a.slotId === s.id) n++;
    }
    return n;
  }

  getLeader(): Account | null {
    if (this.getAllPlayers().length <= 0) return null;
    if (this.leader === -1) this.setNewLeader(-1, SlotState.EMPTY, -1, false);
    return this.leader === -1 ? null : this.svc.getAccount(this.slots[this.leader].playerId);
  }

  /** RoomModel.SetNewLeader (LeaderName is never updated here). */
  setNewLeader(slot: number, floor: number, old: number, update: boolean): void {
    if (slot !== -1) this.leader = slot;
    else {
      const s = this.slots.find((x) => x.id !== old && x.playerId > 0n && x.state > floor && !x.specGM); // a GM observer never leads the room
      if (s) this.leader = s.id;
    }
    if (this.leader !== -1 && this.slots[this.leader].state === SlotState.READY) this.slots[this.leader].state = SlotState.NORMAL;
    if (update) this.updateSlotsInfo();
  }

  /** RoomModel.ChangeSlotState. */
  changeSlotState(slot: SlotModel | number | null, st: number, send: boolean): void {
    const s = typeof slot === "number" ? this.getSlot(slot) : slot;
    if (!s || s.state === st) return;
    s.state = st;
    if (st === SlotState.EMPTY || st === SlotState.CLOSE) s.playerId = 0n;
    if (send) this.updateSlotsInfo();
  }

  /** AddPlayer: first slot (0..17) with no player and state EMPTY. `team` (clan-war match) takes the first free seat of that side. */
  addPlayer(p: Account, team?: number): number {
    // slots 16 / 17 are the observer slots (reached through ROOM_CHANGE_SLOT / the GM spectator path), never a plain join:
    // a full room (closed slots past the user limit) must refuse the join (ROOM_JOIN_ACK 0x80001003)
    // [web] a player who left the running match comes back to their seat, else a free seat of the same team (slot parity = team),
    // else the first free one. The C# AddPlayer always took the first free seat [desvio do C#: team kept on re-entry]
    const free = (x: SlotModel) => x.id < 16 && x.playerId === 0n && x.state === SlotState.EMPTY;
    const was = this.lastSeat.get(p.playerId);
    this.lastSeat.delete(p.playerId);
    const s = (was !== undefined && this.state >= RoomState.LOADING
      ? (free(this.slots[was]) ? this.slots[was] : this.slots.find((x) => free(x) && x.team === was % 2))
      : undefined) ?? this.slots.find((x) => free(x) && (team === undefined || x.team === team));
    if (!s) return -1;
    s.playerId = p.playerId;
    s.state = SlotState.NORMAL;
    p.room = this;
    p.slotId = s.id;
    s.equipment = p.equipment;
    p.status.roomId = this.roomId & 0xff;
    void this.svc.updateStatus(p);
    const i = this.channel.lobbyPlayers.indexOf(p);
    if (i >= 0) this.channel.lobbyPlayers.splice(i, 1);
    return s.id;
  }

  /**
   * [web] /signal admission (web/signal.ts signalGate): only a slot of this room's running match, with its account sitting in it, may join
   * the P2P mesh, and only the leader as the host. Without it a stranger with the (public) room key could sit in an empty slot, e.g. the
   * observer seats 16 / 17 the host accepts without a nick, and watch or shoot. `playerId` = the account of the socket's ticket
   *: it must be the one sitting in that slot, online.
   */
  maySignal(role: "host" | "guest", slot: number, playerId: bigint): boolean {
    if (this.state < RoomState.LOADING || this.state > RoomState.BATTLE_END) return false;
    const s = this.getSlot(slot);
    const a = s && s.playerId > 0n && s.playerId === playerId ? this.svc.getAccount(s.playerId) : null;
    if (!s || !a || a.room !== this || a.slotId !== slot || s.state < SlotState.LOAD) return false;
    return role === "guest" || this.leader === slot;
  }

  // ---- broadcast ----
  sendToPlayers(bytes: Uint8Array, list = this.getAllPlayers()): void { for (const a of list) this.svc.send(a, bytes); }
  /** the slot list: GM accounts get it whole, everybody else without the hidden GM observers */
  updateSlotsInfo(): void {
    const all = this.getAllPlayers();
    if (!this.slots.some((s) => s.stealth)) { this.sendToPlayers(this.buildSlotInfo(), all); return; }
    this.sendToPlayers(this.buildSlotInfo(false), all.filter((a) => a.isGM()));
    this.sendToPlayers(this.buildSlotInfo(true), all.filter((a) => !a.isGM()));
  }

  /** a slot-one / team-change packet about `slot`: hidden from non-GM accounts when the slot is stealth */
  sendAboutSlot(slotId: number, bytes: Uint8Array, list = this.getAllPlayers()): void {
    this.sendToPlayers(bytes, this.slots[slotId]?.stealth ? list.filter((a) => a.isGM()) : list);
  }
  updateRoomInfo(): void { this.generateSeed(); this.sendToPlayers(this.buildRoomInfo()); }

  /** AddPlayer for a GM that joins hidden: observer seat 16 / 17 (state NORMAL, GM spectator, stealth); -1 = both taken */
  addStealthPlayer(p: Account): number {
    const s = this.slots.find((x) => x.id >= 16 && x.playerId === 0n && x.state === SlotState.EMPTY);
    if (!s) return -1;
    s.playerId = p.playerId;
    s.state = SlotState.NORMAL;
    s.specGM = true; s.stealth = true; s.viewType = 2;
    p.room = this;
    p.slotId = s.id;
    s.equipment = p.equipment;
    p.status.roomId = this.roomId & 0xff;
    void this.svc.updateStatus(p);
    const i = this.channel.lobbyPlayers.indexOf(p);
    if (i >= 0) this.channel.lobbyPlayers.splice(i, 1);
    return s.id;
  }

  /** set by the packet module (avoids an import cycle) */
  buildSlotInfo: (hideStealth?: boolean) => Uint8Array = () => new Uint8Array(0);
  buildRoomInfo: () => Uint8Array = () => new Uint8Array(0);

  getInBattleTime(): number {
    if (this.battleStart === 0 || (this.state !== RoomState.BATTLE && this.state !== RoomState.PRE_BATTLE)) return 0;
    return Math.max(0, Math.floor((Date.now() - this.battleStart) / 1000));
  }
  /** the time index is masked and falls back to 10 min like the client (boot.ts TIMES_MIN[(kt >> 4) & 15] ?? 10): an index past the table gave NaN */
  getInBattleTimeLeft(): number { return (TIMES[(this.killTime >> 4) & 15] ?? 10) * 60 - this.getInBattleTime(); }
  countdownTimeLeft(): number { return this.countdownTimer ? Math.max(0, Math.floor((this.countdownEnd - Date.now()) / 1000)) : 0; }
  /** GetSlotsFlag(onlyNoSpectators, missionSuccess). */
  getSlotsFlag(noSpectators: boolean, missions: boolean): number {
    let f = 0;
    for (const s of this.slots) {
      if (s.state < SlotState.LOAD) continue;
      if (noSpectators && s.spectator) continue;
      if (missions && !s.missionsCompleted) continue;
      f += s.flag;
    }
    return f;
  }
  /** RoomModel.StopBomb. */
  stopBomb(): void {
    if (this.bombTimer) clearTimeout(this.bombTimer);
    if (this.bombSyncTimer) clearInterval(this.bombSyncTimer);
    this.bombTimer = null; this.bombSyncTimer = null; this.activeC4 = false;
  }
  stopTimers(): void {
    for (const t of [this.countdownTimer, this.preMatchTimer, this.roundTimer]) if (t) clearTimeout(t);
    this.countdownTimer = this.preMatchTimer = this.roundTimer = null;
    this.stopBomb();
  }
}
