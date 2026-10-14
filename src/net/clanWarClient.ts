// Clan war, etapa A, on the Game connection: client side of server/src/game/clanWarHandlers.ts (that file has the layouts).
// Requests: 6916 list (-> 6915 count + 6917 list), 6918 create (-> 6919), 6920 join (-> 6921 roster), 6922 leave (-> 6923),
// 6924 operation (-> 6925), 6926 max per (-> 6927), 2384 team chat type 7 (no ACK; the echo is 6929), 6934 cancel (-> 6935).
// Pushes: 6921 roster, 6925 operation, 6927 max per, 6929 team chat, 6930 match info (pairing, etapa B).
// The "H 0" pad after the opcode is read where the server writes it. Smoke: src/net/test/clanWarClient.smoke.node.ts.
import { PacketReader, PacketWriter } from "./packet.ts";
import type { TitleConn } from "./titleClient.ts";

export const ClanWarOp = {
  LIST_REQ: 6916, COUNT_ACK: 6915, LIST_ACK: 6917,
  CREATE_REQ: 6918, CREATE_ACK: 6919,
  JOIN_REQ: 6920, JOIN_ACK: 6921,
  LEAVE_REQ: 6922, LEAVE_ACK: 6923,
  OPERATION_REQ: 6924, OPERATION_ACK: 6925,
  MAX_PER_REQ: 6926, MAX_PER_ACK: 6927,
  TEAM_CHAT_ACK: 6929, MATCH_INFO_ACK: 6930,
  MATCHMAKING_REQ: 6932, MATCHMAKING_ACK: 6933,
  CANCEL_REQ: 6934, CANCEL_ACK: 6935,
  CHAT_REQ: 2384,
  RESULT_CONTEXT_REQ: 1954, RESULT_CONTEXT_ACK: 1955, RESULT_LIST_REQ: 1956, RESULT_LIST_ACK: 1957,
  SEASON_REQ: 7699, SEASON_ACK: 7702,
} as const;

/** ChattingType.Match: team chat rides the generic chat opcode */
export const CLAN_WAR_CHAT_TYPE = 7;

/** error values the server sends (clanWarHandlers.ts TEAM_ERR) */
export const ClanWarErr = {
  FAIL: 0x80000000,
  NOT_IN_CLAN: 0x8000105b,
  ALREADY_IN_TEAM: 0x80001087,
  NO_MATCH_ID: 0x80001088,
  NO_SQUAD: 0x80001089,
  NOT_READY: 0x80001090,
  NOT_FULL: 0x80001091,
  NOT_LEADER: 0x80001094,
} as const;

export interface ClanWarReply<T> { ok: boolean; err: number; data?: T }
const reply = <T>(err: number, data?: T): ClanWarReply<T> => (err === 0 ? { ok: true, err, data } : { ok: false, err });

/** MATCH_TEAM_INFO, 6 bytes: one row of the team list and the team header */
export interface TeamInfo { matchId: number; squad: number; state: number; capacity: number; count: number }
export interface TeamListPage { total: number; pages: number; teams: TeamInfo[] }
export interface TeamRosterMember { playerId: bigint; rank: number; seat: number; nick: string }
/** 6921: MATCH_MEMBER_INFO list + MATCH_TEAM_DETAIL_INFO. `localSeat` is the viewer's seat, null when the viewer has none */
export interface TeamRoster {
  matchId: number; channelId: number; serverId: number; capacity: number; count: number; leader: number; clanName: string;
  occupied: boolean[]; localSeat: number | null; members: TeamRosterMember[];
}
/** 6923: `leftSeat` / `leaderSeat` are -1 when not applicable (wire 0xff) */
export interface TeamLeave { disbanded: boolean; leftSeat: number; leaderSeat: number }
export interface TeamChat { nick: string; chatType: number; text: string }
export interface MatchInfoRow { seat: number; kills: number; deaths: number }
export interface MatchInfoTeam { clanId: number; clanName: string; logo: number; squad: number }
/** 6930: the two facing teams and the occupied seats (pairing screen, etapa B) */
export interface MatchTeamInfo { rows: MatchInfoRow[]; teams: MatchInfoTeam[] }

/** 1957 row (CS_CLAN_MATCH_RESULT_LIST_ACK): one team of the clan in the channel, the leader's nick / rank and slot state */
export interface ClanMatchRow {
  matchId: number; serverInfo: number; state: number; squad: number; capacity: number; count: number; leader: number;
  leaderRank: number; leaderNick: string; leaderPlayerId: bigint; leaderState: number;
}

export type ClanWarEvent =
  | { type: "roster"; roster: TeamRoster }
  | { type: "operation"; text: string }
  | { type: "max-per"; max: number }
  | { type: "team-chat"; msg: TeamChat }
  | { type: "match-info"; info: MatchTeamInfo };

// ---- readers (PacketReader positioned after the opcode) ----
const s8 = (v: number): number => (v << 24) >> 24;
const u64 = (r: PacketReader): bigint => BigInt.asUintN(64, r.readQ());
const readTeamInfo = (r: PacketReader): TeamInfo => ({ matchId: r.readH(), squad: r.readC(), state: r.readC(), capacity: r.readC(), count: r.readC() });

/** 6915: H 0, D total, D pages */
function parseCount(r: PacketReader): { total: number; pages: number } {
  r.readH();
  return { total: r.readD(), pages: r.readD() };
}

/** 6917: H 0, D result, C count, teams, C count */
function parseList(r: PacketReader): ClanWarReply<TeamInfo[]> {
  r.readH();
  const err = r.readD();
  if (err !== 0) return reply(err);
  const n = r.readC();
  const teams: TeamInfo[] = [];
  for (let i = 0; i < n; i++) teams.push(readTeamInfo(r));
  r.readC();
  return reply(0, teams);
}

/** 6919: H 0, D result, MATCH_TEAM_INFO (the error body is 6 zero bytes; not read on error) */
function parseCreate(r: PacketReader): ClanWarReply<TeamInfo> {
  r.readH();
  const err = r.readD();
  if (err !== 0) return reply(err);
  return reply(0, readTeamInfo(r));
}

/** 6921: H 0, D result, roster. The error body stops after the result. */
function parseRoster(r: PacketReader): ClanWarReply<TeamRoster> {
  r.readH();
  const err = r.readD();
  if (err !== 0) return reply(err);
  const n = r.readC();
  const members: TeamRosterMember[] = [];
  for (let i = 0; i < n; i++) {
    const playerId = u64(r), rank = r.readC(), seat = r.readC();
    r.skip(2); // C 0, C 0 [INFERIDO padding]
    const nick = r.readU(66);
    r.skip(3); // C 0 x3 [INFERIDO padding]
    members.push({ playerId, rank, seat, nick });
  }
  const matchId = r.readH(), channelId = r.readC(), serverId = r.readC(), capacity = r.readC(), count = r.readC(), leader = r.readC();
  const clanName = r.readU(128);
  const occupied = Array.from({ length: 8 }, () => r.readC() === 1);
  const localSeat = r.readC(), hasLocal = r.readC() === 1;
  return reply(0, { matchId, channelId, serverId, capacity, count, leader, clanName, occupied, localSeat: hasLocal ? localSeat : null, members });
}

/** 6923: H 0, D result, C disbanded, s8 left seat, s8 leader seat (the body is read on error too) */
function parseLeave(r: PacketReader): ClanWarReply<TeamLeave> {
  r.readH();
  const err = r.readD();
  const disbanded = r.readC() === 1;
  const leftSeat = s8(r.readC()), leaderSeat = s8(r.readC());
  return reply(err, { disbanded, leftSeat, leaderSeat });
}

/** 6925 (request ACK and member push): D result, then StrW<64> on success (no H pad) */
function parseOperation(r: PacketReader): ClanWarReply<string> {
  const err = r.readD();
  if (err !== 0) return reply(err);
  const n = r.readC();
  return reply(0, r.readU(n * 2));
}

/** 6927: H 0, D result, C max players */
function parseMaxPer(r: PacketReader): ClanWarReply<number> {
  r.readH();
  const err = r.readD();
  if (err !== 0) return reply(err);
  return reply(0, r.readC());
}

/** 6929 push (no H pad): D result, C nick len, U nick, C chat type, C flag, C msg len, U msg */
function parseTeamChat(r: PacketReader): TeamChat | null {
  if (r.readD() !== 0) return null;
  const nick = r.readU(r.readC() * 2);
  const chatType = r.readC();
  r.readC(); // flag, unused by the client
  const text = r.readU(r.readC() * 2);
  return { nick, chatType, text };
}

/** 6930 push (H 0, no result dword): C rows x {C seat, D 0, D 0, D kills, D deaths, D 0}, C teams x {D clan id, U[17] name, H 0, C 0, D 0, D logo, H 0, D 0, H 1, H squad} */
function parseMatchInfo(r: PacketReader): MatchTeamInfo {
  r.readH();
  const rows: MatchInfoRow[] = [];
  const nRows = r.readC();
  for (let i = 0; i < nRows; i++) {
    const seat = r.readC();
    r.skip(8); // D 0, D 0 [INFERIDO: inert on the wire]
    const kills = r.readD(), deaths = r.readD();
    r.skip(4); // D 0
    rows.push({ seat, kills, deaths });
  }
  const teams: MatchInfoTeam[] = [];
  const nTeams = r.readC();
  for (let i = 0; i < nTeams; i++) {
    const clanId = r.readD(), clanName = r.readU(34);
    r.skip(7); // H 0, C 0, D 0
    const logo = r.readD();
    r.skip(8); // H 0, D 0, H 1
    teams.push({ clanId, clanName, logo, squad: r.readH() });
  }
  return { rows, teams };
}

/** 6933: D result (no H pad) */
function parseMatchmaking(r: PacketReader): ClanWarReply<void> {
  return reply(r.readD());
}

/** 1955: C count, C 13 per page, C pages (no H pad) */
function parseResultContext(r: PacketReader): { count: number; pages: number } {
  const count = r.readC();
  r.readC(); // C 13 (per page)
  return { count, pages: r.readC() };
}

/** 1957: C count (91 = no clan, the error), then C 1, C 0, C count, one ClanMatchRow per team (no H pad) */
function parseResultList(r: PacketReader): ClanWarReply<ClanMatchRow[]> {
  const n = r.readC();
  if (n === 91) return reply(91);
  if (n === 0) return reply(0, []);
  r.skip(2); // C 1, C 0 [INFERIDO padding]
  const count = r.readC();
  const rows: ClanMatchRow[] = [];
  for (let i = 0; i < count; i++) {
    const matchId = r.readH(), serverInfo = r.readH();
    r.readH(); // second serverInfo copy
    const state = r.readC(), squad = r.readC(), capacity = r.readC(), members = r.readC();
    r.skip(1); // C 0
    const leader = r.readD();
    const leaderRank = r.readC(), leaderNick = r.readU(66), leaderPlayerId = u64(r), leaderState = r.readC();
    rows.push({ matchId, serverInfo, state, squad, capacity, count: members, leader, leaderRank, leaderNick, leaderPlayerId, leaderState });
  }
  return reply(0, rows);
}

/** pushes (the ACK frames of requests are parsed by the request methods; these run for every frame) */
function parsePush(op: number, r: PacketReader): ClanWarEvent | null {
  switch (op) {
    case ClanWarOp.JOIN_ACK: { const x = parseRoster(r); return x.ok && x.data ? { type: "roster", roster: x.data } : null; }
    case ClanWarOp.OPERATION_ACK: { const x = parseOperation(r); return x.ok && x.data !== undefined ? { type: "operation", text: x.data } : null; }
    case ClanWarOp.MAX_PER_ACK: { const x = parseMaxPer(r); return x.ok && x.data !== undefined ? { type: "max-per", max: x.data } : null; }
    case ClanWarOp.TEAM_CHAT_ACK: { const m = parseTeamChat(r); return m ? { type: "team-chat", msg: m } : null; }
    case ClanWarOp.MATCH_INFO_ACK: return { type: "match-info", info: parseMatchInfo(r) };
    default: return null;
  }
}

export class ClanWarClient {
  private conn: TitleConn;
  private subs = new Set<(ev: ClanWarEvent) => void>();
  private off: () => void;
  /** the last 6915 count frame; list() reads it, the frame comes just before the 6917 list */
  private lastCount: { total: number; pages: number } | null = null;

  constructor(conn: TitleConn) {
    this.conn = conn;
    // every listener gets the same reader: parse a copy so the request waiters still see the frame from its start
    this.off = conn.on((op, r) => {
      if (op === ClanWarOp.COUNT_ACK) { this.lastCount = parseCount(new PacketReader(r.data, r.pos)); return; }
      const ev = parsePush(op, new PacketReader(r.data, r.pos));
      if (ev) for (const f of [...this.subs]) f(ev);
    });
  }

  /** every team push (roster, operation, max per, team chat, match info) */
  on(fn: (ev: ClanWarEvent) => void): () => void { this.subs.add(fn); return () => this.subs.delete(fn); }
  dispose(): void { this.off(); this.subs.clear(); }

  /** request + its ACK; the waiter is armed before the send */
  private ask(op: number, ackOp: number, body?: PacketWriter): Promise<PacketReader> {
    const ack = this.conn.waitFor(ackOp);
    try { this.conn.send(op, body); } catch (e) { ack.catch(() => {}); throw e; }
    return ack;
  }

  /** 6916 -> 6915 + 6917: the channel's teams (not a clan channel: error only) */
  async list(): Promise<ClanWarReply<TeamListPage>> {
    this.lastCount = null;
    const x = parseList(await this.ask(ClanWarOp.LIST_REQ, ClanWarOp.LIST_ACK));
    if (!x.ok || !x.data) return reply(x.err);
    const teams = x.data;
    const count = this.lastCount as { total: number; pages: number } | null; // set by the 6915 frame before the list
    return reply(0, { total: count?.total ?? teams.length, pages: count?.pages ?? 0, teams });
  }

  /** 6918 -> 6919: new team, capacity 1..8. The creator's roster follows as a 6921 push. */
  async create(capacity: number): Promise<ClanWarReply<TeamInfo>> {
    return parseCreate(await this.ask(ClanWarOp.CREATE_REQ, ClanWarOp.CREATE_ACK, new PacketWriter(1).writeC(capacity)));
  }

  /** 6920 -> 6921: join the team with this match id. The ACK is the roster (error: result only). */
  async join(matchId: number): Promise<ClanWarReply<TeamRoster>> {
    return parseRoster(await this.ask(ClanWarOp.JOIN_REQ, ClanWarOp.JOIN_ACK, new PacketWriter(2).writeH(matchId)));
  }

  /** 6922 -> 6923: leave the team */
  async leave(): Promise<ClanWarReply<TeamLeave>> {
    return parseLeave(await this.ask(ClanWarOp.LEAVE_REQ, ClanWarOp.LEAVE_ACK));
  }

  /** 6924 -> 6925: leader only. The text is cut to 64 chars. */
  async setOperation(text: string): Promise<ClanWarReply<string>> {
    const s = text.slice(0, 64);
    return parseOperation(await this.ask(ClanWarOp.OPERATION_REQ, ClanWarOp.OPERATION_ACK, new PacketWriter(1 + s.length * 2).writeC(s.length).writeU(s, s.length * 2)));
  }

  /** 6926 -> 6927: leader only, team READY and not queued. 1..8, not below the seated count. */
  async setMaxPer(max: number): Promise<ClanWarReply<number>> {
    return parseMaxPer(await this.ask(ClanWarOp.MAX_PER_REQ, ClanWarOp.MAX_PER_ACK, new PacketWriter(1).writeC(max)));
  }

  /** 2384 type 7: team chat, <= 60 chars. No ACK; every seat gets a 6929 push. */
  teamChat(text: string): void {
    const w = new PacketWriter(6 + text.length * 2).writeH(CLAN_WAR_CHAT_TYPE).writeH(text.length).writeU(text, text.length * 2);
    this.conn.send(ClanWarOp.CHAT_REQ, w);
  }

  /** 6934 -> 6935: leader only, team must be queued */
  async cancelMatchmaking(): Promise<ClanWarReply<void>> {
    return reply((await this.ask(ClanWarOp.CANCEL_REQ, ClanWarOp.CANCEL_ACK)).readD());
  }

  /** 6932 -> 6933: leader only, team READY and full, not in a room. The pair (other clan, same size) is seated in a battle room:
   *  6930 and the room (3593 / 3595) follow as pushes. Ok = queued (or already paired when the request was the second team). */
  async matchmake(): Promise<ClanWarReply<void>> {
    return parseMatchmaking(await this.ask(ClanWarOp.MATCHMAKING_REQ, ClanWarOp.MATCHMAKING_ACK));
  }

  /** 1954 -> 1955: how many teams of the viewer's clan the channel holds */
  async clanMatchContext(): Promise<ClanWarReply<{ count: number; pages: number }>> {
    return reply(0, parseResultContext(await this.ask(ClanWarOp.RESULT_CONTEXT_REQ, ClanWarOp.RESULT_CONTEXT_ACK)));
  }

  /** 1956 -> 1957: the clan's teams in the channel. [INFERIDO] the request body is one C (C# Field1), sent as 0. err 91 = no clan. */
  async clanMatchResults(): Promise<ClanWarReply<ClanMatchRow[]>> {
    return parseResultList(await this.ask(ClanWarOp.RESULT_LIST_REQ, ClanWarOp.RESULT_LIST_ACK, new PacketWriter(1).writeC(0)));
  }
}
