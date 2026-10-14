// Clan war, etapa A + B: clan teams and clan matches (Server.Game PROTOCOL_CLAN_WAR_* / CS_CLAN_MATCH_RESULT / MATCH_CLAN_SEASON ports).
// Opcodes: 6916 MATCH_TEAM_LIST -> 6915 COUNT + 6917 LIST; 6918 CREATE_TEAM -> 6919; 6920 JOIN_TEAM -> 6921 (roster, also pushed to
// every member); 6922 LEAVE_TEAM -> 6923; 6924 CHANGE_OPERATION -> 6925; 6926 CHANGE_MAX_PER -> 6927; 2384 chat type 7 (ChattingType.Match)
// -> 6929 TEAM_CHATTING; 6932 MATCHMAKING -> 6933 (pairing: 6930 push + ROOM_CREATE_ACK 3593 + GET_SLOTINFO 3595 to the 2 teams);
// 6934 CANCEL_MATCHMAKING -> 6935; 1954 CLAN_MATCH_RESULT_CONTEXT -> 1955; 1956 CLAN_MATCH_RESULT_LIST -> 1957; 7699 MATCH_CLAN_SEASON -> 7702.
// The clan result of a finished match (applyClanMatchResult) runs from roomHandlers calculateResult, like RoomModel.UpdateClanInformation.
// Every ACK frame below is the C# Write() output, opcode included; the "H 0" pad is written where the C# writes it.
// The team registry (per clan channel, in memory) is exported for etapa B: matchmaking, match result and mercenaries.
// Layouts and sources: 
import { PacketReader, PacketWriter } from "../../../src/net/packet.ts";
import type { ChannelModel } from "./channel.ts";
import { ChannelType } from "../auth/packets.ts";
import type { Account } from "../shared/account.ts";
import * as dao from "../shared/dao.ts";
import type { ClanModel } from "../shared/dao.ts";
import { pool } from "../db.ts";
import { config } from "../config.ts";
import { roomOf } from "./roomHandlers.ts";
import { social, banState, announce, clanStatus } from "./socialHandlers.ts";
import { RoomCondition, RoomState, SlotState as RoomSlotState, Team } from "./roomModel.ts";
import type { RoomModel } from "./roomModel.ts";
import * as rp from "./roomPackets.ts";
import type { GameClient } from "./gameServer.ts";

export const TeamOp = {
  LIST_REQ: 6916, COUNT_ACK: 6915, LIST_ACK: 6917,
  CREATE_REQ: 6918, CREATE_ACK: 6919,
  JOIN_REQ: 6920, JOIN_ACK: 6921,
  LEAVE_REQ: 6922, LEAVE_ACK: 6923,
  OPERATION_REQ: 6924, OPERATION_ACK: 6925,
  MAX_PER_REQ: 6926, MAX_PER_ACK: 6927,
  TEAM_CHAT_ACK: 6929, MATCH_INFO_ACK: 6930,
  MATCHMAKING_REQ: 6932, MATCHMAKING_ACK: 6933,
  CANCEL_REQ: 6934, CANCEL_ACK: 6935,
  /** generic chat opcode: team chat is chat type 7 on it */
  CHAT_REQ: 2384,
  /** clan match history (CS_CLAN_MATCH_RESULT_*). The C# never dispatches 1954 / 1956: the REQ = ACK - 1 pairing is [INFERIDO] */
  RESULT_CONTEXT_REQ: 1954, RESULT_CONTEXT_ACK: 1955, RESULT_LIST_REQ: 1956, RESULT_LIST_ACK: 1957,
  /** MATCH_CLAN_SEASON_REQ (dispatched by the C#) and its ACK */
  SEASON_REQ: 7699, SEASON_ACK: 7702,
  /** PROTOCOL_SERVER_MESSAGE_USER_EVENT_START_ACK, sent after the season ack */
  USER_EVENT_START_ACK: 3086,
} as const;

/** ChattingType.Match (Plugin.Core/Enums/ChattingType.cs): clan-war team chat */
export const TEAM_CHAT_TYPE = 7;

/** error values (Server.Game). NAME_* / ALREADY_* are the C# literals of PROTOCOL_CLAN_WAR_CREATE_TEAM_REQ */
export const TEAM_ERR = {
  FAIL: 0x80000000,
  NOT_IN_CLAN: 0x8000105b,
  ALREADY_IN_TEAM: 0x80001087,
  NO_MATCH_ID: 0x80001088,
  NO_SQUAD: 0x80001089,
  /** MATCHMAKING_REQ: team not Ready (STBL_IDX_CLAN_BATTLE_ALREADY_STARTING) */
  NOT_READY: 0x80001090,
  /** MATCHMAKING_REQ: team not full, seats != capacity (STBL_IDX_CLAN_BATTLE_CANNOT_JOIN_FULL) */
  NOT_FULL: 0x80001091,
  /** MATCHMAKING_REQ: not the leader (STBL_IDX_CLAN_BATTLE_ONLY_LEADER) */
  NOT_LEADER: 0x80001094,
} as const;

/** ClanMatchCheck errors on READYBATTLE_ACK (C# AllUtils.cs:2682): the room must have 2 clans; with enemies, both sides need players */
export const CLAN_MATCH_ERR = {
  NO_TWO_CLANS: 0x80001071,
  NEED_MEMBERS: 0x80001072,
} as const;

/** MatchState (Plugin.Core/Enums/MatchState.cs) */
export const TeamState = { INVISIBLE: 0, READY: 1, PLAY: 2 } as const;
/** SlotMatchState (Plugin.Core/Enums/SlotMatchState.cs) */
export const SlotState = { EMPTY: 0, NORMAL: 1, READY: 2, PLAY: 3 } as const;

/** the clan-war battle room: "Port Akaba" (MapIdEnum.PortAkaba) in Death Match, rule None, StageOptions.Default = 1 (ClanWarMaps[0] of the C#) */
const CLAN_WAR_MAP = 1;
const CLAN_WAR_RULE = 0;
const CLAN_WAR_STAGE = 1;
const CLAN_WAR_KILL_TIME = 3;
/** the battle room runs as 1 round (Limit 1) */
const CLAN_WAR_LIMIT = 1;

const SEATS = 9;           // MatchModel.Slots length (GetCountPlayers counts all of them)
const MAX_MEMBERS = 8;     // roster cap on the wire (JOIN_TEAM_ACK) and the capacity range 1..8
const MAX_TEAM_IDS = 250;  // CREATE_TEAM_REQ searches match ids 0..249
const MAX_SQUADS = 25;     // CREATE_TEAM_REQ searches squads 0..24
const MAX_LIST = 26;       // MATCH_TEAM_LIST cap (S2MOValue<MATCH_TEAM_INFO,26>)
const TEAMS_PER_PAGE = 13; // PROTOCOL_CLAN_WAR_MATCH_TEAM_COUNT_ACK
const MAX_OP_CHARS = 64;   // CHANGE_OPERATION text cap
const MAX_CHAT_CHARS = 60; // team chat text cap (base chatting)
const MAX_MATCH_INFO_ROWS = 18;
const MAX_MATCH_INFO_TEAMS = 2;

/** one seat of a team (SlotMatch + the account that sits there) */
export interface TeamSlot { account: Account | null; playerId: bigint; state: number }

/** one clan-war team (MatchModel). Kept in the registry below; never sent whole */
export class ClanTeam {
  /** u16 id on the wire; JOIN_TEAM_REQ echoes it (MatchModel.MatchId) */
  matchId = -1;
  /** squad number 0..24 (MatchModel.FriendId); also the members' status clanMatchId */
  squad = 0;
  /** max players 1..8 (MatchModel.Training) */
  capacity = 0;
  /** seat index of the leader */
  leader = 0;
  /** MatchState, TeamState.* */
  state: number = TeamState.READY;
  /** queued for matchmaking (etapa B owns the queue order; see enqueueTeam) */
  inQueue = false;
  /** operation / notice line, max 64 chars */
  operation = "";
  readonly slots: TeamSlot[] = Array.from({ length: SEATS }, () => ({ account: null, playerId: 0n, state: SlotState.EMPTY }));

  readonly channel: ChannelModel;
  readonly clan: ClanModel;

  constructor(channel: ChannelModel, clan: ClanModel) {
    this.channel = channel;
    this.clan = clan;
  }

  /** occupied seats (all of them, as MatchModel.GetCountPlayers) */
  count(): number { return this.slots.filter((s) => s.playerId > 0n).length; }
  /** seat index of the account, -1 when not seated here */
  slotOf(playerId: bigint): number { return playerId > 0n ? this.slots.findIndex((s) => s.playerId === playerId) : -1; }
  /** seated accounts, seat order (only those with a live account object) */
  members(): Account[] { return this.slots.flatMap((s) => (s.playerId > 0n && s.account ? [s.account] : [])); }
}

// ---- registry (in memory; one list per clan channel) -----------------------------------------------------------------

const teamsByChannel = new Map<ChannelModel, ClanTeam[]>();
const queues = new Map<ChannelModel, ClanTeam[]>();
const teamOfPlayer = new Map<bigint, ClanTeam>();

/** the channel's teams in creation order (a copy: safe to walk while teams come and go) */
export const teamsOf = (ch: ChannelModel): ClanTeam[] => [...(teamsByChannel.get(ch) ?? [])];
/** the team with this wire id in the channel, or null (JOIN_TEAM_REQ lookup) */
export const getTeam = (ch: ChannelModel, matchId: number): ClanTeam | null => (teamsByChannel.get(ch) ?? []).find((t) => t.matchId === matchId) ?? null;
/** the team the account sits in, or null */
export const teamOf = (p: Account): ClanTeam | null => teamOfPlayer.get(p.playerId) ?? null;
/** the queued teams of the channel, queue order (etapa B pairs from the head) */
export const queueOf = (ch: ChannelModel): ClanTeam[] => [...(queues.get(ch) ?? [])];

export function setTeamState(team: ClanTeam, state: number): void { team.state = state; }
/** put a team in the matchmaking queue (etapa B). false when it already waits */
export function enqueueTeam(team: ClanTeam): boolean {
  if (team.inQueue) return false;
  const list = queues.get(team.channel) ?? [];
  list.push(team);
  queues.set(team.channel, list);
  team.inQueue = true;
  return true;
}
/** take a team out of the queue (LeaveQueue: idempotent) */
export function dequeueTeam(team: ClanTeam): void {
  team.inQueue = false;
  const list = queues.get(team.channel);
  const i = list?.indexOf(team) ?? -1;
  if (list && i >= 0) list.splice(i, 1);
  if (list && list.length === 0) queues.delete(team.channel);
}

function addTeam(team: ClanTeam): void {
  const list = teamsByChannel.get(team.channel) ?? [];
  list.push(team);
  teamsByChannel.set(team.channel, list);
}
function removeTeam(team: ClanTeam): void {
  dequeueTeam(team);
  const list = teamsByChannel.get(team.channel);
  const i = list?.indexOf(team) ?? -1;
  if (list && i >= 0) list.splice(i, 1);
  if (list && list.length === 0) teamsByChannel.delete(team.channel);
}

/** AddPlayer: seats the account in the first empty seat under the capacity. -1 when the team is full or the account has a team. */
export function seatPlayer(team: ClanTeam, p: Account): number {
  if (teamOfPlayer.has(p.playerId)) return -1;
  for (let i = 0; i < team.capacity; i++) {
    const s = team.slots[i];
    if (s.playerId === 0n && s.state === SlotState.EMPTY) {
      s.playerId = p.playerId;
      s.account = p;
      s.state = SlotState.NORMAL;
      teamOfPlayer.set(p.playerId, team);
      p.status.clanMatchId = team.squad;
      return i;
    }
  }
  return -1;
}

/** RemovePlayer: frees the seat, drops the team from the queue, removes an empty team, else moves the leader and re-sends the roster. */
function unseat(p: Account): { team: ClanTeam; seat: number; disbanded: boolean } | null {
  const team = teamOf(p);
  if (!team) return null;
  const seat = team.slotOf(p.playerId);
  if (seat >= 0) team.slots[seat] = { account: null, playerId: 0n, state: SlotState.EMPTY };
  teamOfPlayer.delete(p.playerId);
  dequeueTeam(team);
  p.status.clanMatchId = 255;
  if (team.count() === 0) removeTeam(team);
  else {
    if (seat === team.leader) {
      const next = team.slots.findIndex((s, i) => i < team.capacity && s.playerId > 0n);
      if (next >= 0) team.leader = next;
    }
    broadcastRoster(team);
  }
  return { team, seat, disbanded: team.count() === 0 };
}

/** MATCH_TEAM_INFO push: team list entry of a team the account sits in (BroadcastRoster to every seated member) */
export function broadcastRoster(team: ClanTeam): void {
  for (const m of team.members()) social.send(m, joinTeamAck(0, team, m));
}

/** C# RoomModel.RemovePlayer (RoomModel.cs:1831-1835): a seated member leaves the match room, so its team's roster goes out again (6921) */
export function broadcastRosterOf(p: Account): void {
  const team = teamOf(p);
  if (team) broadcastRoster(team);
}

/** SyncPlayerToClanMembers: status row to the accounts table, and 851 (clan status) to the online clan members */
async function syncClan(p: Account): Promise<void> {
  await dao.update1("accounts", "status", p.status.buffer, "player_id", p.playerId);
  if (p.clanId <= 0) return;
  const pkt = new PacketWriter(20).writeH(851).writeQ(p.playerId).writeQ(clanStatus(p.status.buffer >>> 0, !!p.connection)).toBytes();
  for (const a of social.online.values()) if (a.clanId === p.clanId) social.send(a, pkt);
}

/** leaves the account's team outside an ACK (logout, channel exit, clan exit). No-op without a team. */
export async function dropTeamOf(p: Account): Promise<void> {
  if (!unseat(p)) return;
  await syncClan(p);
}

// ---- writers ---------------------------------------------------------------------------------------------------------

const W = (n = 64) => new PacketWriter(n);

/** MATCH_TEAM_INFO, 6 bytes (WriteMatchTeamInfo): H match id, C squad, C state, C capacity, C player count */
function writeTeamInfo(w: PacketWriter, team: ClanTeam): PacketWriter {
  return w.writeH(team.matchId).writeC(team.squad).writeC(team.state).writeC(team.capacity).writeC(team.count());
}

/** 6919 CREATE_TEAM_ACK: H op, H 0, D result, MATCH_TEAM_INFO (6 zero bytes on error: the client reads it unconditionally) */
export function createTeamAck(result: number, team?: ClanTeam): Uint8Array {
  const w = W(16).writeH(TeamOp.CREATE_ACK).writeH(0).writeD(result);
  return team ? writeTeamInfo(w, team).toBytes() : w.writeB(new Uint8Array(6)).toBytes();
}

/** 6921 JOIN_TEAM_ACK: the roster of `team` as seen by `viewer` (the tail says which seat is the viewer's). Result only on error. */
export function joinTeamAck(result: number, team?: ClanTeam, viewer?: Account): Uint8Array {
  const w = W(256).writeH(TeamOp.JOIN_ACK).writeH(0).writeD(result);
  if (result !== 0 || !team) return w.toBytes();
  const seats = Math.min(team.capacity, MAX_MEMBERS);
  const filled = (i: number) => i < seats && team.slots[i].playerId > 0n;
  const rows: number[] = [];
  for (let i = 0; i < seats; i++) if (filled(i)) rows.push(i);
  w.writeC(rows.length); // S2MOValue<MATCH_MEMBER_INFO,8>
  for (const i of rows) {
    const s = team.slots[i];
    w.writeQ(s.playerId).writeC(s.account?.rank ?? 0).writeC(i).writeC(0).writeC(0)
      .writeU(s.account?.nickname ?? "", 66).writeC(0).writeC(0).writeC(0);
  }
  // MATCH_TEAM_DETAIL_INFO, 143 bytes
  w.writeH(team.matchId).writeC(team.channel.id).writeC(team.channel.serverId).writeC(team.capacity).writeC(rows.length)
    .writeC(team.leader).writeU(team.clan.name, 128);
  for (let i = 0; i < MAX_MEMBERS; i++) w.writeC(filled(i) ? 1 : 0);
  const local = viewer && teamOf(viewer) === team ? team.slotOf(viewer.playerId) : -1;
  return w.writeC(local >= 0 ? local : 0).writeC(local >= 0 ? 1 : 0).toBytes();
}

/** 6930 MATCH_TEAM_INFO push (no result dword): the two teams and their occupied seats. `stat` gives kills / deaths per account
 *  (etapa B supplies it; the C# reads them from Statistic). The match wins / loses are inert on the wire and written as 0. */
export function matchTeamInfoAck(teams: ClanTeam[], stat: (pid: bigint) => { kills: number; deaths: number } = () => ({ kills: 0, deaths: 0 })): Uint8Array {
  const list = teams.slice(0, MAX_MATCH_INFO_TEAMS);
  const rows: { seat: number; playerId: bigint }[] = [];
  for (const t of list) {
    for (let i = 0; i < SEATS && rows.length < MAX_MATCH_INFO_ROWS; i++) {
      if (t.slots[i].playerId > 0n) rows.push({ seat: i, playerId: t.slots[i].playerId });
    }
  }
  const w = W(256).writeH(TeamOp.MATCH_INFO_ACK).writeH(0).writeC(rows.length);
  for (const r of rows) {
    const s = stat(r.playerId);
    w.writeC(r.seat).writeD(0).writeD(0).writeD(s.kills).writeD(s.deaths).writeD(0);
  }
  w.writeC(list.length);
  for (const t of list) {
    w.writeD(t.clan.id).writeU(t.clan.name, 34).writeH(0).writeC(0).writeD(0).writeD(t.clan.logo).writeH(0).writeD(0).writeH(1).writeH(t.squad);
  }
  return w.toBytes();
}

/** 6915 COUNT: total teams and pages (no result dword) */
const countAck = (total: number): Uint8Array => W(12).writeH(TeamOp.COUNT_ACK).writeH(0).writeD(total).writeD(Math.ceil(total / TEAMS_PER_PAGE)).toBytes();

/** 6917 LIST: result, then the teams (max 26), the count byte again at the end */
function listAck(result: number, teams: ClanTeam[] = []): Uint8Array {
  const w = W(64).writeH(TeamOp.LIST_ACK).writeH(0).writeD(result);
  if (result !== 0) return w.toBytes();
  const n = Math.min(teams.length, MAX_LIST);
  w.writeC(n);
  for (let i = 0; i < n; i++) writeTeamInfo(w, teams[i]);
  return w.writeC(n).toBytes();
}

/** 6923 LEAVE_TEAM_ACK: result, disbanded flag, left seat and leader seat (-1 = 0xff) */
const leaveAck = (result: number, disbanded: boolean, leftSlot: number, leaderSlot: number): Uint8Array =>
  W(16).writeH(TeamOp.LEAVE_ACK).writeH(0).writeD(result).writeC(disbanded ? 1 : 0).writeC(leftSlot).writeC(leaderSlot).toBytes();

/** 6925 CHANGE_OPERATION_ACK: result, then the operation text as StrW<64> (count byte + chars) on success */
function operationAck(result: number, text = ""): Uint8Array {
  const w = W(16 + text.length * 2).writeH(TeamOp.OPERATION_ACK).writeD(result);
  if (result !== 0) return w.toBytes();
  return w.writeC(text.length).writeU(text, text.length * 2).toBytes();
}

/** 6927 CHANGE_MAX_PER_ACK: result, then the new max (1 byte) */
const maxPerAck = (result: number, max: number): Uint8Array => W(16).writeH(TeamOp.MAX_PER_ACK).writeH(0).writeD(result).writeC(max).toBytes();

/** 6935 CANCEL_MATCHMAKING_ACK: result only */
const cancelAck = (result: number): Uint8Array => W(8).writeH(TeamOp.CANCEL_ACK).writeD(result).toBytes();

/** 6929 TEAM_CHATTING_ACK: result, nick (count + chars, max 33), chat type, flag 0, message (count + chars) */
export function teamChatAck(nick: string, text: string, chatType = 0): Uint8Array {
  const n = nick.slice(0, 33);
  return W(16 + (n.length + text.length) * 2).writeH(TeamOp.TEAM_CHAT_ACK).writeD(0)
    .writeC(n.length).writeU(n, n.length * 2)
    .writeC(chatType).writeC(0)
    .writeC(text.length).writeU(text, text.length * 2)
    .toBytes();
}

/** 6933 MATCHMAKING_ACK: bare result (no H pad, C# WriteH(op) + WriteD) */
const matchmakingAck = (result: number): Uint8Array => W(8).writeH(TeamOp.MATCHMAKING_ACK).writeD(result).toBytes();

/** 1955 CLAN_MATCH_RESULT_CONTEXT_ACK: C count of the clan's teams in the channel, C 13 per page, C pages (no H pad) */
const resultContextAck = (n: number): Uint8Array => W(8).writeH(TeamOp.RESULT_CONTEXT_ACK).writeC(n).writeC(13).writeC(Math.ceil(n / 13)).toBytes();

/** 1957 CLAN_MATCH_RESULT_LIST_ACK: C count (91 = no clan), then C 1, C 0, C count, one row per team (no H pad) */
function resultListAck(teams: ClanTeam[]): Uint8Array {
  const w = W(64).writeH(TeamOp.RESULT_LIST_ACK).writeC(teams.length);
  if (teams.length === 0) return w.toBytes();
  w.writeC(1).writeC(0).writeC(teams.length);
  for (const t of teams) {
    const leader = t.slots[t.leader];
    const leaderAcc = leader.account;
    // GetServerInfo = ChannelId + ServerId * 10 (MatchModel.cs)
    const info = t.channel.id + t.channel.serverId * 10;
    w.writeH(t.matchId).writeH(info).writeH(info).writeC(t.state).writeC(t.squad).writeC(t.capacity).writeC(t.count()).writeC(0).writeD(t.leader);
    if (!leaderAcc) w.zeros(76);
    else w.writeC(leaderAcc.rank).writeU(leaderAcc.nickname, 66).writeQ(leaderAcc.playerId).writeC(leader.state);
  }
  return w.toBytes();
}

/** 7702 MATCH_CLAN_SEASON_ACK: the clan season block is empty (C# EmptyClanSeasonBlock, 2 x 121 bytes) */
const seasonAck = (): Uint8Array => W(256).writeH(TeamOp.SEASON_ACK).zeros(242).toBytes();

// ---- ids ----------------------------------------------------------------------------------------------------------------

const freeMatchId = (list: ClanTeam[]): number => {
  for (let id = 0; id < MAX_TEAM_IDS; id++) if (!list.some((t) => t.matchId === id)) return id;
  return -1;
};
/** squad numbers are unique per clan inside the channel */
const freeSquad = (list: ClanTeam[], clanId: number): number => {
  const used = list.filter((t) => t.clan.id === clanId).map((t) => t.squad);
  for (let i = 0; i < MAX_SQUADS; i++) if (!used.includes(i)) return i;
  return -1;
};

// ---- handlers ---------------------------------------------------------------------------------------------------------

/** 6918 -> 6919: capacity (C), then the account's new team (or the error). The creator gets the roster 6921 next. */
export async function handleCreateTeam(c: GameClient, r: PacketReader): Promise<void> {
  const capacity = r.readC();
  const p = c.player;
  if (!p) return;
  const ch = c.channelOf(p);
  if (!ch || ch.type !== ChannelType.clan || roomOf(p)) return c.session.send(createTeamAck(TEAM_ERR.FAIL));
  if (p.clanId === 0) return c.session.send(createTeamAck(TEAM_ERR.NOT_IN_CLAN));
  // [INFERIDO] the C# takes any capacity and then seats nobody (AddPlayer indexes past 9 slots, no ACK): refused here instead
  if (capacity < 1 || capacity > MAX_MEMBERS) return c.session.send(createTeamAck(TEAM_ERR.FAIL));
  const clan = await dao.getClanDB(p.clanId);
  // id search and insert run without an await in between, so two creates cannot take the same id
  if (teamOf(p)) return c.session.send(createTeamAck(TEAM_ERR.ALREADY_IN_TEAM));
  const list = teamsOf(ch);
  const matchId = freeMatchId(list);
  if (matchId < 0) return c.session.send(createTeamAck(TEAM_ERR.NO_MATCH_ID));
  const squad = freeSquad(list, p.clanId);
  if (squad < 0) return c.session.send(createTeamAck(TEAM_ERR.NO_SQUAD));
  const team = new ClanTeam(ch, clan);
  team.matchId = matchId;
  team.squad = squad;
  team.capacity = capacity;
  addTeam(team);
  team.leader = seatPlayer(team, p);
  c.session.send(createTeamAck(0, team));
  broadcastRoster(team);
  await syncClan(p);
}

/** 6916 -> 6915 + 6917: the channel's teams. Not a clan channel: list ACK with the error only. The account's own team (if it sits in
 *  one) follows as its roster 6921: the client has no other way to learn it again when the Batalha tab reopens (no ALREADY_IN_TEAM). */
export function handleMatchTeamList(c: GameClient): void {
  const p = c.player;
  if (!p) return;
  const ch = c.channelOf(p);
  if (!ch || ch.type !== ChannelType.clan) return c.session.send(listAck(TEAM_ERR.FAIL));
  const teams = teamsOf(ch);
  c.session.send(countAck(teams.length));
  c.session.send(listAck(0, teams));
  const mine = teamOf(p);
  if (mine) c.session.send(joinTeamAck(0, mine, p));
}

/** 6920 -> 6921: match id (H). Success pushes the roster to every seat, the joiner included. */
export async function handleJoinTeam(c: GameClient, r: PacketReader): Promise<void> {
  const matchId = r.readH();
  const p = c.player;
  if (!p) return;
  if (teamOf(p) || roomOf(p)) return c.session.send(joinTeamAck(TEAM_ERR.FAIL));
  if (p.clanId === 0) return c.session.send(joinTeamAck(TEAM_ERR.NOT_IN_CLAN));
  const ch = c.channelOf(p);
  if (!ch || ch.type !== ChannelType.clan) return c.session.send(joinTeamAck(TEAM_ERR.FAIL));
  const team = getTeam(ch, matchId);
  if (!team) return c.session.send(joinTeamAck(TEAM_ERR.FAIL));
  // [etapa B] another clan's team is joined only by a registered mercenary (C# channel.Mercenaries): refused here until B adds it
  if (team.clan.id !== p.clanId) return c.session.send(joinTeamAck(TEAM_ERR.FAIL));
  if (seatPlayer(team, p) < 0) return c.session.send(joinTeamAck(TEAM_ERR.FAIL));
  broadcastRoster(team);
  await syncClan(p);
}

/** 6922 -> 6923: no body. Leaves the team; the ACK is sent after the remaining members got their roster. */
export async function handleLeaveTeam(c: GameClient): Promise<void> {
  const p = c.player;
  if (!p) return;
  const out = unseat(p);
  if (!out) return c.session.send(leaveAck(TEAM_ERR.FAIL, false, -1, -1));
  c.session.send(leaveAck(0, out.disbanded, out.seat, out.disbanded ? -1 : out.team.leader));
  await syncClan(p);
}

/** 6924 -> 6925: leader only. C count (max 64) + count wide chars. The new line goes to every seat. */
export function handleChangeOperation(c: GameClient, r: PacketReader): void {
  const n = Math.min(r.readC(), MAX_OP_CHARS);
  const text = n > 0 ? r.readU(n * 2) : "";
  const p = c.player;
  if (!p) return;
  const team = teamOf(p);
  if (!team || team.slotOf(p.playerId) !== team.leader) return c.session.send(operationAck(TEAM_ERR.FAIL));
  team.operation = text;
  const pkt = operationAck(0, text);
  for (const m of team.members()) social.send(m, pkt);
}

/** 6926 -> 6927: leader only, team READY and not queued. C new max; 1..8 and not below the seated count (C# rule). */
export function handleChangeMaxPer(c: GameClient, r: PacketReader): void {
  const max = r.readC();
  const p = c.player;
  if (!p) return;
  const team = teamOf(p);
  const fail = () => c.session.send(maxPerAck(TEAM_ERR.FAIL, 0));
  if (!team || team.slotOf(p.playerId) !== team.leader || team.state !== TeamState.READY || team.inQueue) return fail();
  if (max < 1 || max > MAX_MEMBERS || max < team.count()) return fail();
  // [INFERIDO] a seat at or past the new max would be dropped from the roster (roster reads seats < capacity): refused
  if (team.slots.some((s, i) => i >= max && s.playerId > 0n)) return fail();
  team.capacity = max;
  const pkt = maxPerAck(0, max);
  for (const m of team.members()) social.send(m, pkt);
  broadcastRoster(team);
}

/** 6934 -> 6935: leader only, team must be queued. Takes it out of the queue. */
export function handleCancelMatchmaking(c: GameClient): void {
  const p = c.player;
  if (!p) return;
  const team = teamOf(p);
  if (!team || team.slotOf(p.playerId) !== team.leader || !team.inQueue) return c.session.send(cancelAck(TEAM_ERR.FAIL));
  dequeueTeam(team);
  c.session.send(cancelAck(0));
}

/** Team chat comes in on 2384 as chat type 7. Peeks the type so the generic chat handler keeps the other types. */
export const isTeamChat = (r: PacketReader): boolean => new PacketReader(r.data, r.pos).readH() === TEAM_CHAT_TYPE;

/** 2384 type 7: H type, H len, U text (<= 60). Sent to every seat of the sender's team (C# ChattingType.Match). */
export async function handleTeamChat(c: GameClient, r: PacketReader): Promise<void> {
  const type = r.readH(), text = r.readU(r.readH() * 2);
  const p = c.player;
  if (!p || type !== TEAM_CHAT_TYPE || !text || text.length > MAX_CHAT_CHARS || p.durationSince("chatting") < 1) return;
  const team = teamOf(p);
  if (!team) return;
  const b = await banState(p);
  if (b === "ban") return c.session.send(announce("Your account is banned."));
  if (b === "mute") return c.session.send(announce("You are muted and cannot chat."));
  const pkt = teamChatAck(p.nickname, text);
  for (const m of team.members()) social.send(m, pkt);
  p.last.chatting = Date.now();
}

// ---- matchmaking (etapa B) ------------------------------------------------------------------------------------------------

/** a queued team can go to a room: every seat taken by a live account, and nobody of it already in a room */
const readyForRoom = (t: ClanTeam): boolean =>
  t.count() === t.capacity && t.members().length === t.capacity && t.members().every((a) => !roomOf(a));

/** 6932 -> 6933: leader only, team READY, every seat taken, not queued. Then the queue is paired. */
export function handleMatchmaking(c: GameClient): void {
  const p = c.player;
  if (!p) return;
  const ch = c.channelOf(p);
  const team = teamOf(p);
  if (!ch || ch.type !== ChannelType.clan || !team || roomOf(p)) return c.session.send(matchmakingAck(TEAM_ERR.FAIL));
  if (team.slotOf(p.playerId) !== team.leader) return c.session.send(matchmakingAck(TEAM_ERR.NOT_LEADER));
  if (team.state !== TeamState.READY) return c.session.send(matchmakingAck(TEAM_ERR.NOT_READY));
  if (team.count() !== team.capacity) return c.session.send(matchmakingAck(TEAM_ERR.NOT_FULL));
  if (!enqueueTeam(team)) return c.session.send(matchmakingAck(TEAM_ERR.FAIL));
  c.session.send(matchmakingAck(0));
  tryPairMatches(c, ch);
}

/** pairing: the first two queued teams with the same capacity and different clans (C# TryPairMatches) */
function tryPairMatches(c: GameClient, ch: ChannelModel): void {
  const q = queueOf(ch).filter(readyForRoom);
  let red: ClanTeam | null = null, blue: ClanTeam | null = null;
  for (let i = 0; i < q.length && !blue; i++) {
    for (let j = i + 1; j < q.length; j++) {
      if (q[i].capacity !== q[j].capacity || q[i].clan.id === q[j].clan.id) continue;
      red = q[i]; blue = q[j];
      break;
    }
  }
  if (!red || !blue) return;
  dequeueTeam(red);
  dequeueTeam(blue);
  // no free room in the channel: both teams go back to the end of the queue and the next request retries
  if (!buildBattleRoom(c, ch, red, blue)) { enqueueTeam(red); enqueueTeam(blue); }
}

/** RoomModel for the pair (C# BuildBattleRoom): red = FR seats, blue = CT seats; both teams PLAY; 6930 to all, then the room to each seat.
 *  false when the channel has no free room or a side has too few free seats. */
function buildBattleRoom(c: GameClient, ch: ChannelModel, red: ClanTeam, blue: ClanTeam): boolean {
  let room: RoomModel | null = null;
  for (let i = 0; i < ch.maxRooms && !room; i++) if (!ch.getRoom(i)) room = c.newRoom(i, ch);
  if (!room) return false;
  const freeSeats = (side: number) => room!.slots.filter((s) => s.id < 16 && s.team === side && s.state === RoomSlotState.EMPTY && s.playerId === 0n).length;
  if (freeSeats(Team.FR) < red.capacity || freeSeats(Team.CT) < blue.capacity) return false;

  room.name = `${red.clan.name} vs ${blue.clan.name}`;
  room.mapId = CLAN_WAR_MAP;
  room.rule = CLAN_WAR_RULE;
  room.stage = CLAN_WAR_STAGE;
  room.roomType = RoomCondition.DeathMatch;
  room.generateSeed();
  room.state = RoomState.READY;
  room.leaderName = red.clan.name;
  room.password = "";
  room.killTime = CLAN_WAR_KILL_TIME;
  room.limit = CLAN_WAR_LIMIT;
  room.balanceType = 0;
  room.randomMaps = new Uint8Array(24);
  room.leaderAddr = new Uint8Array(4);
  room.setSlotCount(red.capacity * 2, true, false);

  const redMembers = red.members(), blueMembers = blue.members();
  for (const a of redMembers) room.addPlayer(a, Team.FR);
  for (const a of blueMembers) room.addPlayer(a, Team.CT);
  // the host of the P2P battle is the red leader (C# room leader = red team); the seat of that account
  const redLeader = room.slots.find((s) => s.playerId > 0n && s.playerId === red.slots[red.leader].playerId);
  if (redLeader) room.leader = redLeader.id;
  ch.rooms.push(room);

  red.state = TeamState.PLAY;
  blue.state = TeamState.PLAY;
  for (const t of [red, blue]) for (const s of t.slots) if (s.playerId > 0n) s.state = SlotState.READY;
  room.clanMatch = { teams: [red, blue] };

  const everyone = [...redMembers, ...blueMembers];
  const who = new Map(everyone.map((a) => [a.playerId, a]));
  const info = matchTeamInfoAck([red, blue], (pid) => {
    const b = who.get(pid)?.statistic.basic;
    return { kills: b?.killsCount ?? 0, deaths: b?.deathsCount ?? 0 };
  });
  for (const a of everyone) social.send(a, info);
  // C# SendIntoRoom: ROOM_CREATE_ACK (the room header) and the full slot table, nobody sent a join request.
  // Then each seat gets the ROOM_JOIN_ACK (3586) of its own room entry: it carries the seat (the web client has no other seat
  // number here) and the room's slots, the same body a joined room gets (RoomClient.adopt, ClanBattle -> adoptClanRoom).
  const created = rp.createRoomAck(0, room), slots = rp.slotInfoAck(room);
  for (const a of everyone) { social.send(a, created); social.send(a, slots); social.send(a, rp.joinRoomAck(0, a, room)); }
  return true;
}

/** the room ends (resetBattleInfo) or was left by its last team member (removePlayer): both teams go back to READY with the same members.
 * [INFERIDO] C# leaves them in Play after the first match (MatchModel.State is only set to Play); the decision in 7.1 is READY. */
export function releaseClanMatch(r: RoomModel): void {
  const m = r.clanMatch;
  if (!m) return;
  r.clanMatch = null;
  for (const t of m.teams) {
    t.state = TeamState.READY;
    for (const s of t.slots) if (s.playerId > 0n) s.state = SlotState.NORMAL;
  }
}

/** removePlayer hook: no seated member of the match teams is in the room any more */
export function releaseClanMatchIfUnused(r: RoomModel): void {
  const m = r.clanMatch;
  if (m && !m.teams.some((t) => t.members().some((a) => a.room === r))) releaseClanMatch(r);
}

/** AllUtils.ClanMatchCheck (C# AllUtils.cs:2682): 0 when the battle may start, else the error for READYBATTLE_ACK. Off with Settings Test=True.
 *  [DESVIO] the C# needs 4 players per side whenever there are enemies; here the bar is min(4, seats per side), so a 1x1 or 2x2 clan
 *  match can start. Full 4+ teams keep the C# bar. */
export function clanMatchCheck(r: RoomModel, enemies: number): number {
  if (config.testMode || r.channelType !== ChannelType.clan) return 0;
  const clans = new Map<number, { fr: number; ct: number }>();
  for (const a of r.getAllPlayers()) {
    const clan = teamOf(a)?.clan.id ?? a.clanId; // GetClanTeams: the match clan, else the account clan
    const s = r.getSlot(a.slotId);
    if (!clan || !s) continue;
    const e = clans.get(clan) ?? { fr: 0, ct: 0 };
    if (s.team === Team.FR) e.fr++; else e.ct++;
    clans.set(clan, e);
  }
  if (clans.size !== 2) return CLAN_MATCH_ERR.NO_TWO_CLANS;
  if (enemies > 0) {
    const open = r.slots.filter((s) => s.id < 16 && s.state !== RoomSlotState.CLOSE).length;
    const need = Math.min(4, Math.floor(open / 2));
    const values = [...clans.values()];
    if (!values.some((e) => e.fr >= need) || !values.some((e) => e.ct >= need)) return CLAN_MATCH_ERR.NEED_MEMBERS;
  }
  return 0;
}

/** AllUtils.CheckClanMatchRestrict (C# AllUtils.cs:2153): a clan with seats on both sides blocks the room's clan points */
export function checkClanMatchRestrict(r: RoomModel): void {
  if (r.channelType !== ChannelType.clan) return;
  const sides = new Map<number, { fr: boolean; ct: boolean }>();
  for (const a of r.getAllPlayers()) {
    const clan = teamOf(a)?.clan.id ?? a.clanId;
    const s = r.getSlot(a.slotId);
    if (!clan || !s) continue;
    const e = sides.get(clan) ?? { fr: false, ct: false };
    if (s.team === Team.FR) e.fr = true; else e.ct = true;
    sides.set(clan, e);
    if (e.fr && e.ct) { r.blockedClan = true; return; }
  }
}

// ---- clan match result (etapa B) ------------------------------------------------------------------------------------------

/** RoomModel.UpdateClanInformation + UpdateClanPointsAndMatches (C# RoomModel.cs:1344-1413). Exp is summed per clan (x1.5 with the
 *  bonus flag 256); the first seat of each clan sets its team, which gives win / lose and the points. One UPDATE per clan, as increments.
 *  Points: win +25 + k; lose -(40 - k) unless the clan has 0 points; draw none. k = team kills / 20 (DeathMatch) or team rounds. */
export function applyClanMatchResult(r: RoomModel, w: number): void {
  if (r.channelType !== ChannelType.clan || r.blockedClan || r.roomType === RoomCondition.FreeForAll) return;
  const clans = new Map<number, { team: number; exp: number; members: Account[] }>();
  for (const s of r.slots) {
    if (s.state !== RoomSlotState.BATTLE || s.playerId === 0n) continue;
    const P = r.svc.getAccount(s.playerId);
    if (!P || P.clanId === 0) continue;
    const exp = (P.bonus.bonuses & 256) === 256 ? Math.trunc((s.exp * 3) / 2) : s.exp;
    const c = clans.get(P.clanId);
    if (c) { c.exp += exp; c.members.push(P); } else clans.set(P.clanId, { team: s.team, exp, members: [P] });
  }
  const draw = w === Team.DRAW;
  for (const [clanId, c] of clans) {
    const won = !draw && c.team === w;
    const kills = c.team === Team.FR ? r.frKills : r.ctKills;
    const rounds = c.team === Team.FR ? r.frRounds : r.ctRounds;
    const k = r.roomType === RoomCondition.DeathMatch ? Math.trunc(kills / 20) : rounds;
    const delta = draw ? 0 : won ? 25 + k : -(40 - k);
    applyClanInMemory(c.members, c.exp);
    void writeClanMatch(clanId, c.exp, delta, !draw && !won, won ? 1 : 0, !draw && !won ? 1 : 0)
      .then(() => refreshClanOf(clanId, c.members))
      .catch((e) => console.log(`clanWar result clan ${clanId}: ${(e as Error).message}`));
  }
}

/** system_clan_ranks: rank id -> exp needed to step up (on_next_level + on_all_exp). Loaded with the reward tables (loadRewardData). */
const clanRankNeed = new Map<number, number>();
export async function loadClanRanks(): Promise<void> {
  clanRankNeed.clear();
  for (const x of (await pool.query(`SELECT id, on_next_level, on_all_exp FROM system_clan_ranks`)).rows) clanRankNeed.set(Number(x.id), Number(x.on_next_level) + Number(x.on_all_exp));
}

/** C# UpdateClanInformation changes ClanManager's clan in place before the 5140 is built: the members' clan takes the match's exp and
 *  the rank step (one per match, same rule as writeClanMatch) right away, so the ENDBATTLE of this match carries the new grade. */
function applyClanInMemory(members: Account[], exp: number): void {
  const cl = { ...members[0].clan, exp: members[0].clan.exp + exp };
  const need = clanRankNeed.get(cl.rank);
  if (need !== undefined && cl.exp >= need) cl.rank = (cl.rank + 1) & 0xff;
  for (const a of members) a.clan = cl;
}

/** After the UPDATE rows are written, the members' clan reloads from the DB (the stored truth, same values as applyClanInMemory). */
async function refreshClanOf(clanId: number, members: Account[]): Promise<void> {
  const cl = await dao.getClanDB(clanId);
  for (const a of members) if (a.clanId === clanId) a.clan = cl;
}

/** one clan's row: exp, matches (+1 always), wins / loses, points (guardZero: a loss at 0 points keeps 0), then the rank step when
 *  the exp reaches the next rank (C# UpdateClanRank: one step per match, from system_clan_ranks) */
async function writeClanMatch(clanId: number, exp: number, delta: number, guardZero: boolean, win: number, lose: number): Promise<void> {
  const up = await pool.query(
    `UPDATE system_clan SET exp = exp + $1, matches = matches + 1, match_wins = match_wins + $2, match_loses = match_loses + $3,
       point = CASE WHEN $4::boolean AND point = 0 THEN point ELSE point + $5::int END
     WHERE id = $6 RETURNING exp, rank`,
    [exp, win, lose, guardZero, delta, clanId],
  );
  const row = up.rows[0];
  if (!row) return;
  const rank = await pool.query(`SELECT on_next_level, on_all_exp FROM system_clan_ranks WHERE id = $1`, [row.rank]);
  const need = rank.rows[0] ? Number(rank.rows[0].on_next_level) + Number(rank.rows[0].on_all_exp) : null;
  if (need !== null && Number(row.exp) >= need) await pool.query(`UPDATE system_clan SET rank = rank + 1 WHERE id = $1`, [clanId]);
}

// ---- history and season (1954-1957, 7699) ---------------------------------------------------------------------------------

/** 1954 -> 1955: how many teams of the account's clan the channel holds (clan channel only) */
export function handleClanMatchContext(c: GameClient): void {
  const p = c.player;
  const ch = p ? c.channelOf(p) : null;
  const n = p && ch && p.clanId > 0 && ch.type === ChannelType.clan ? teamsOf(ch).filter((t) => t.clan.id === p.clanId).length : 0;
  c.session.send(resultContextAck(n));
}

/** 1956 -> 1957: the clan's teams in the channel. C byte read first (the C# Field1); no clan = count 91 */
export function handleClanMatchResultList(c: GameClient, r: PacketReader): void {
  r.readC();
  const p = c.player;
  if (!p) return;
  if (p.clanId === 0) return c.session.send(new PacketWriter(8).writeH(TeamOp.RESULT_LIST_ACK).writeC(91).toBytes());
  const ch = c.channelOf(p);
  const teams = ch && ch.type === ChannelType.clan ? teamsOf(ch).filter((t) => t.clan.id === p.clanId) : [];
  c.session.send(resultListAck(teams));
}

/** 7699 -> 7702 (empty season block), then 3086 USER_EVENT_START (no event) */
export function handleClanSeason(c: GameClient): void {
  c.session.send(seasonAck());
  c.session.send(new PacketWriter(96).writeH(TeamOp.USER_EVENT_START_ACK).writeH(0).zeros(83).writeD(0).toBytes());
}
