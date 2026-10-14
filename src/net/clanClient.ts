// Clan on the Game connection. REQ -> ACK pairs routed in server/src/game/gameServer.ts:543-576 (918 inline at :555) plus the
// clan pushes. Writers: server/src/game/socialHandlers.ts (clan section) and clanHandlers.ts. Bodies exclude the opcode (the
// reader starts after it). Field names follow the server writers; `[INFERIDO]` marks a value whose meaning the server does not show.
// Smoke: src/net/test/clanClient.smoke.node.ts runs the real server handlers against these parsers.
import { PacketReader, PacketWriter } from "./packet.ts";
import type { TitleConn } from "./titleClient.ts";

export const ClanOp = {
  ENTER_REQ: 769, ENTER_ACK: 770, LEAVE_REQ: 771, LEAVE_ACK: 772,
  LIST_REQ: 997, LIST_ACK: 1000,
  DETAIL_REQ: 800, DETAIL_ACK: 801,
  SIMPLE_REQ: 1001, SIMPLE_ACK: 1002,
  MEMBER_CTX_REQ: 802, MEMBER_CTX_ACK: 803,
  MEMBER_LIST_REQ: 804, MEMBER_LIST_ACK: 805,
  CREATE_REQ: 806, CREATE_ACK: 807,
  JOIN_REQ: 812, JOIN_ACK: 813,
  CANCEL_REQ: 814, CANCEL_ACK: 815,
  SECEDE_REQ: 828, SECEDE_ACK: 829,
  CHAT_REQ: 854, CHAT_ACK: 855,
  CLOSE_REQ: 808, CLOSE_ACK: 809,
  JOIN_AUTH_REQ: 810, JOIN_AUTH_ACK: 811,
  CONTEXT_REQ: 816, CONTEXT_ACK: 817,
  REQUEST_LIST_REQ: 818, REQUEST_LIST_ACK: 819,
  REQUEST_INFO_REQ: 820, REQUEST_INFO_ACK: 821,
  ACCEPT_REQ: 822, ACCEPT_ACK: 823, ACCEPT_RESULT_PUSH: 824,
  DENY_REQ: 825, DENY_ACK: 826,
  DEPORT_REQ: 830, DEPORT_ACK: 831, DEPORTED_PUSH: 832, MEMBER_LEAVE_PUSH: 849,
  MASTER_REQ: 833, MASTER_ACK: 834, MASTER_PUSH: 835,
  STAFF_REQ: 836, STAFF_ACK: 837, STAFF_PUSH: 838,
  REGULAR_REQ: 839, REGULAR_ACK: 840, REGULAR_PUSH: 841,
  MARK_REQ: 856, MARK_ACK: 857,
  NOTICE_REQ: 858, NOTICE_ACK: 859,
  INTRO_REQ: 860, INTRO_ACK: 861,
  MANAGE_REQ: 868, MANAGE_ACK: 869,
  ROOM_INVITE_REQ: 877, ROOM_INVITE_PUSH: 3077,
  PAGE_CHAT_REQ: 886, PAGE_CHAT_PUSH: 887,
  INVITE_REQ: 888, INVITE_ACK: 889,
  INVITE_ACCEPT_REQ: 890, INVITE_ACCEPT_ERR_ACK: 891, INVITE_RESULT_PUSH: 1922,
  NOTE_REQ: 892, NOTE_ACK: 893,
  CONDITION_REQ: 916, CONDITION_ACK: 917,
  DUPLICATE_REQ: 918, DUPLICATE_ACK: 919,
  MEMBER_INFO_PUSH: 845, MEMBER_INSERT_PUSH: 847, STATUS_PUSH: 851,
} as const;

/** error values the clan writers send (`[INFERIDO]` names: taken from the handler that sends each one) */
export const ClanErr = {
  FAIL: 0x80000000,
  /** the account has no clan (secession / invite accept of a clanless account) */
  NOT_IN_CLAN: 0x8000105b,
  /** already in a clan or with a pending invite (create / join) */
  ALREADY_IN_CLAN: 0x8000105c,
  OWNER_CANNOT_SECEDE: 0x8000105e,
  CREATE_CONDITION: 0x8000104a,
  /** create with a clan name already in use (server sends it; the C# set it but never sent 807) [INFERIDO] */
  NAME_IN_USE: 0x8000105a,
  CLAN_LIMIT: 0x80001055,
  CREATE_DB: 0x80001048,
  CREATE_NO_ID: 0x8000104b,
  REQUEST_LIMIT: 0x80001057,
  ALREADY_MEMBER: 0x80001058,
  CLAN_FULL: 0x80001056,
  JOIN_DB: 0x80001068,
  CLOSE_DB: 0x8000106a,
  SECEDE_DB: 0x8000106b,
  DEPORT_FAIL: 0x80001059,
  MASTER_RANK: 0x800010b8,
  COMMISSION_DB: 0x80001000,
  NOTICE_DB: 0x80001073,
  INTRO_DB: 0x80001074,
  RANK_LIMIT: 0x8000107b,
  /** "no clan" / "not staff" (count-style ACKs and the member / request lists) */
  NONE: 0xffffffff,
} as const;

/** server FS presence codes inside a ClanStatus (socialHandlers.ts FS) */
export const CLAN_STATE = { OFFLINE: 3, ONLINE: 4, LOBBY: 5, ROOM: 8 } as const;

const SIGN = 0x80000000;
const ASK_TIMEOUT_MS = 5000;

export interface ClanReply<T> { ok: boolean; err: number; data?: T }
const reply = <T>(err: number, data?: T): ClanReply<T> => (err === 0 ? { ok: true, err, data } : { ok: false, err });
/** count-style ACK: a value with the high bit set is an error (ClanErr.NONE, ClanErr.DEPORT_FAIL...), anything else is a count */
const countReply = (v: number): ClanReply<{ count: number }> => (v & SIGN ? { ok: false, err: v } : { ok: true, err: 0, data: { count: v } });

export interface ClanStatus { raw: bigint; high: number; state: number; server: number; channel: number; room: number }
/** the Q status of the member rows (socialHandlers.ts clanStatus). `high` = the server's (cm + 1) or 0 [INFERIDO meaning] */
export function decodeClanStatus(raw: bigint): ClanStatus {
  const v = BigInt.asUintN(64, raw);
  const low = Number(v & 0xffffffffn);
  return { raw: v, high: Number(v >> 32n), state: low >>> 28, server: (low >>> 20) & 0xff, channel: (low >>> 12) & 0xff, room: low & 0xfff };
}

export interface ClanSummary { id: number; name: string; logo: number; info: string }
export interface ClanListPage { total: number; start: number; clans: ClanSummary[] }
export interface ClanEnterList { count: number; perPage: number; pages: number; date: number }
export interface ClanEnter { clanId: number; access: number; list: ClanEnterList | null }
export interface ClanPage { count: number; perPage: number; pages: number; date: number }
export interface ClanDetail {
  echo: number; id: number; name: string; rank: number; members: number; maxPlayers: number; createDate: number; logo: number;
  nameColor: number; effects: number; unit: number; exp: number; ownerId: bigint; ownerNick: string; ownerNickColor: number; ownerRank: number;
  info: string; joinPermission: number; rankLimit: number; maxAge: number; minAge: number; authority: number; news: string;
  points: number; wins: number; loses: number; matches: number; matchWins: number; matchLoses: number; clanRank: number;
}
export interface ClanSimple {
  points: number; nameColor: number; loses: number; wins: number; matches: number; logo: number; unit: number; members: number; maxPlayers: number;
  name: string; ownerId: bigint; rank: number;
}
export interface ClanCreated {
  id: number; name: string; rank: number; members: number; maxPlayers: number; createDate: number; logo: number; ownerId: bigint;
  ownerNick: string; ownerNickColor: number; ownerRank: number; info: string; rankLimit: number; minAge: number; maxAge: number; authority: number;
  points: number; gold: number;
}
/** 824 ACCEPT_RESULT (also the 1922-path result): the account's clan right after an accept */
export interface ClanResult {
  id: number; name: string; rank: number; members: number; maxPlayers: number; createDate: number; logo: number; nameColor: number;
  effects: number; unit: number; exp: number; ownerId: bigint; ownerNick: string; ownerNickColor: number; ownerRank: number; info: string;
  rankLimit: number; minAge: number; maxAge: number; authority: number; news: string; matches: number; wins: number; loses: number;
}
export interface ClanMemberRow {
  playerId: bigint; nick: string; rank: number; access: number; status: ClanStatus; joinDate: number; nickColor: number;
  wins: number; loses: number; nameCard: number;
}
/** 845 (login / accept of another member): no nick colour on the wire */
export interface ClanMemberInfo { playerId: bigint; nick: string; rank: number; status: ClanStatus; wins: number; loses: number; nameCard: number; nickBorderColor: number }
export interface ClanMemberInsert extends ClanMemberInfo { nickColor: number }
export interface ClanJoinRequest {
  playerId: bigint; nick: string; rank: number; nickColor: number; inviteDate: number; kills: number; deaths: number; matches: number;
  wins: number; loses: number; text: string;
}
export interface ClanRequestInfo { playerId: bigint; nick: string; rank: number; kills: number; deaths: number; matches: number; wins: number; loses: number; text: string }
export interface ClanChat { nick: string; gm: boolean; nickColor: number; text: string }
export interface ClanRoomInvite { nick: string; roomId: number; inviterId: bigint; password: string }
export interface ClanCondition { minRank: number; minGold: number }
export interface ClanManage { authority: number; rankLimit: number; maxAge: number; minAge: number; join: number }

export type ClanEvent =
  | { type: "detail"; detail: ClanDetail }
  | { type: "members"; members: ClanMemberInfo[] }
  | { type: "member-insert"; member: ClanMemberInsert }
  | { type: "member-leave"; playerId: bigint }
  | { type: "member-status"; playerId: bigint; status: ClanStatus }
  | { type: "accept-result"; clan: ClanResult }
  | { type: "deported" }
  | { type: "master" }
  | { type: "staff" }
  | { type: "regular" }
  | { type: "chat"; msg: ClanChat }
  | { type: "page-chat"; msg: ClanChat }
  | { type: "room-invite"; invite: ClanRoomInvite }
  | { type: "invite-result"; err: number };

// ---- readers (PacketReader positioned after the opcode) ----
const u64 = (r: PacketReader): bigint => BigInt.asUintN(64, r.readQ());
/** C count (count includes the NUL terminator, server wstrz) + U count*2 */
const countedC = (r: PacketReader): string => r.readU(r.readC() * 2);
/** H count + U count*2 (server writeH(info.length + 1) + wstrz) */
const countedH = (r: PacketReader): string => r.readU(r.readH() * 2);
/** NUL-terminated UTF-16 run with no length (server wstrz after a fixed block) */
const readWz = (r: PacketReader): string => {
  let s = "";
  for (let c = r.readH(); c !== 0; c = r.readH()) s += String.fromCharCode(c);
  return s;
};
const readF64 = (r: PacketReader): number => {
  const b = r.readB(8);
  return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
};
const status = (r: PacketReader): ClanStatus => decodeClanStatus(r.readQ());

// ---- parsers: each takes the ACK body ----
function parseEnter(r: PacketReader): ClanReply<ClanEnter> {
  const err = r.readD();
  const clanId = r.readD(), access = r.readD();
  // server: the clan list only when the account is not in a clan (or is still an applicant)
  const list = clanId !== 0 && access !== 0 ? null : { count: r.readD(), perPage: r.readC(), pages: r.readH(), date: r.readD() };
  return reply(err, { clanId, access, list });
}

function parseList(r: PacketReader): ClanReply<ClanListPage> {
  const err = r.readD();
  const n = r.readH(), total = r.readH(), start = r.readH();
  const clans: ClanSummary[] = [];
  for (let i = 0; i < n; i++) {
    const id = r.readD(), name = countedC(r), logo = r.readD(), info = countedH(r);
    r.skip(1);
    clans.push({ id, name, logo, info });
  }
  return reply(err, { total, start, clans });
}

/** 801 DETAIL: D echo + the fixed 1607-byte blob (socialHandlers.ts clanDetailAck, offsets in comments there) */
function parseDetail(r: PacketReader): ClanDetail {
  const echo = r.readD();
  const id = r.readD(), name = r.readU(34), rank = r.readC(), members = r.readC(), maxPlayers = r.readC(), createDate = r.readD(), logo = r.readD();
  const nameColor = r.readC(), effects = r.readC(), unit = r.readC(), exp = r.readD(), ownerId = u64(r);
  r.skip(4);
  const ownerNick = r.readU(66), ownerNickColor = r.readC(), ownerRank = r.readC(), info = r.readU(510);
  r.skip(41);
  const joinPermission = r.readC(), rankLimit = r.readC(), maxAge = r.readC(), minAge = r.readC(), authority = r.readC();
  const news = r.readU(510), points = r.readD(), wins = r.readD(), loses = r.readD();
  r.skip(96);
  const matches = r.readD(), matchWins = r.readD(), matchLoses = r.readD();
  r.skip(8 + 20 + 96 + 4 + 4 + 1); // D0 D0, zeros(20), zeros(96) (weekly medals, war region), D0 C0 [INFERIDO padding]
  const clanRank = r.readD();
  r.skip(82 + 2 + 64); // zeros(82), C0 C0, zeros(64)
  return {
    echo, id, name, rank, members, maxPlayers, createDate, logo, nameColor, effects, unit, exp, ownerId, ownerNick, ownerNickColor, ownerRank,
    info, joinPermission, rankLimit, maxAge, minAge, authority, news, points, wins, loses, matches, matchWins, matchLoses, clanRank,
  };
}

function parseSimple(r: PacketReader): ClanReply<ClanSimple> {
  r.readD(); r.readH(); // D 0, H 0 [INFERIDO: unused echo fields]
  const err = r.readD();
  if (err !== 0) return reply(err);
  const points = r.readD(), nameColor = r.readC(), loses = r.readD(), wins = r.readD(), matches = r.readD(), logo = r.readD();
  const unit = r.readC(), maxPlayers = r.readC(), members = r.readC();
  const name = r.readU(r.readC() * 2), ownerId = u64(r), rank = r.readC();
  return reply(err, { points, nameColor, loses, wins, matches, logo, unit, members, maxPlayers, name, ownerId, rank });
}

/** 803 (member context) and 817 (request context) share the shape: C count, C perPage, C pages, D date */
function parseCount(r: PacketReader): ClanReply<ClanPage> {
  const err = r.readD();
  if (err !== 0) return reply(err);
  const count = r.readC(), perPage = r.readC(), pages = r.readC(), date = r.readD();
  return reply(err, { count, perPage, pages, date });
}

function parseMemberList(r: PacketReader): ClanReply<{ page: number; members: ClanMemberRow[] }> {
  const err = r.readD();
  if (err !== 0) return reply(err);
  const page = r.readC(), n = r.readC();
  const members: ClanMemberRow[] = [];
  for (let i = 0; i < n; i++) {
    const playerId = u64(r), nick = r.readU(66), rank = r.readC(), access = r.readC(), st = status(r);
    const joinDate = r.readD(), nickColor = r.readC(), wins = r.readD(), loses = r.readD(), nameCard = r.readD();
    r.skip(1 + 12); // C0 D10 D20 D30 [INFERIDO padding]
    members.push({ playerId, nick, rank, access, status: st, joinDate, nickColor, wins, loses, nameCard });
  }
  return reply(err, { page, members });
}

function parseCreate(r: PacketReader): ClanReply<ClanCreated> {
  const err = r.readD();
  if (err !== 0) return reply(err);
  if (r.remaining === 0) return reply(0); // server ack(0) with no clan row: nothing to read
  const id = r.readD(), name = r.readU(34), rank = r.readC(), members = r.readC(), maxPlayers = r.readC(), createDate = r.readD(), logo = r.readD();
  r.skip(11);
  const ownerId = u64(r), ownerNick = r.readS(66), ownerNickColor = r.readC(), ownerRank = r.readC(), info = r.readU(510);
  r.skip(42); // literal "Temp" placeholder the server writes here
  const rankLimit = r.readC(), minAge = r.readC(), maxAge = r.readC(), authority = r.readC();
  r.skip(510 + 44);
  const points = readF64(r);
  r.skip(8 + 16); // 60.0, zeros(16)
  readF64(r);
  r.skip(8 + 80 + 66); // 60.0, zeros(80), zeros(66)
  const gold = r.readD();
  return reply(err, { id, name, rank, members, maxPlayers, createDate, logo, ownerId, ownerNick, ownerNickColor, ownerRank, info, rankLimit, minAge, maxAge, authority, points, gold });
}

function parseJoin(r: PacketReader): ClanReply<{ clanId: number }> {
  const err = r.readD();
  // server writes the clan id only when (err | 0) >= 0, i.e. err == 0
  const clanId = (err | 0) >= 0 && r.remaining >= 4 ? r.readD() : 0;
  return reply(err, { clanId });
}

function parseRequestList(r: PacketReader): ClanReply<{ page: number; requests: ClanJoinRequest[] }> {
  const err = r.readD();
  if (err !== 0) return reply(err);
  // server (819): C page, then C count
  const page = r.readC(), n = r.readC();
  const requests: ClanJoinRequest[] = [];
  for (let i = 0; i < n; i++) {
    const playerId = u64(r), nick = r.readU(66), rank = r.readC(), nickColor = r.readC(), inviteDate = r.readD();
    const kills = r.readD(), deaths = r.readD(), matches = r.readD(), wins = r.readD(), loses = r.readD();
    const text = readWz(r);
    r.readD(); // the request date again, after the text
    requests.push({ playerId, nick, rank, nickColor, inviteDate, kills, deaths, matches, wins, loses, text });
  }
  return reply(err, { page, requests });
}

function parseRequestInfo(r: PacketReader): ClanReply<ClanRequestInfo> {
  const err = r.readD();
  if (err !== 0) return reply(err);
  const playerId = u64(r), nick = r.readU(66), rank = r.readC();
  const kills = r.readD(), deaths = r.readD(), matches = r.readD(), wins = r.readD(), loses = r.readD();
  return reply(err, { playerId, nick, rank, kills, deaths, matches, wins, loses, text: readWz(r) });
}

/** 824: the account's clan right after an accept (socialHandlers acceptResultAck / clanHandlers.ts) */
function parseAcceptResult(r: PacketReader): ClanResult {
  const id = r.readD(), name = r.readU(34), rank = r.readC(), members = r.readC(), maxPlayers = r.readC(), createDate = r.readD(), logo = r.readD();
  const nameColor = r.readC(), effects = r.readC(), unit = r.readC(), exp = r.readD();
  r.skip(4); // D 10
  const ownerId = u64(r), ownerNick = r.readU(66), ownerNickColor = r.readC(), ownerRank = r.readC(), info = r.readU(510);
  r.skip(42); // "Temp"
  const rankLimit = r.readC(), minAge = r.readC(), maxAge = r.readC(), authority = r.readC(), news = r.readU(510);
  const matches = r.readD(), wins = r.readD(), loses = r.readD();
  r.skip(12); // the matches / wins / loses triple again
  return {
    id, name, rank, members, maxPlayers, createDate, logo, nameColor, effects, unit, exp, ownerId, ownerNick, ownerNickColor, ownerRank,
    info, rankLimit, minAge, maxAge, authority, news, matches, wins, loses,
  };
}

function parseMemberInfo(r: PacketReader): ClanMemberInfo[] {
  const n = r.readC();
  const out: ClanMemberInfo[] = [];
  for (let i = 0; i < n; i++) {
    const nick = countedC(r), playerId = u64(r), st = status(r), rank = r.readC();
    const wins = r.readD(), loses = r.readD(), nameCard = r.readD(), nickBorderColor = r.readC();
    r.skip(12);
    out.push({ playerId, nick, rank, status: st, wins, loses, nameCard, nickBorderColor });
  }
  return out;
}

function parseMemberInsert(r: PacketReader): ClanMemberInsert {
  const nick = countedC(r), playerId = u64(r), st = status(r), rank = r.readC(), nickColor = r.readC();
  const wins = r.readD(), loses = r.readD(), nameCard = r.readD(), nickBorderColor = r.readC();
  r.skip(12);
  return { nick, playerId, status: st, rank, nickColor, wins, loses, nameCard, nickBorderColor };
}

export function parseClanChat(r: PacketReader): ClanChat {
  const nick = countedC(r), gm = r.readC() !== 0, nickColor = r.readC(), text = countedC(r);
  return { nick, gm, nickColor, text };
}

function parseRoomInvite(r: PacketReader): ClanRoomInvite {
  return { nick: r.readU(66), roomId: r.readD(), inviterId: u64(r), password: r.readS(4) };
}

function parseCondition(r: PacketReader): ClanCondition {
  return { minRank: r.readC(), minGold: r.readD() };
}

const errOnly = (r: PacketReader): ClanReply<void> => reply(r.readD());

/** pushes that are not the answer to a request of this client */
function parsePush(op: number, r: PacketReader): ClanEvent | null {
  switch (op) {
    case ClanOp.DETAIL_ACK: return { type: "detail", detail: parseDetail(r) };
    case ClanOp.MEMBER_INFO_PUSH: return { type: "members", members: parseMemberInfo(r) };
    case ClanOp.MEMBER_INSERT_PUSH: return { type: "member-insert", member: parseMemberInsert(r) };
    case ClanOp.MEMBER_LEAVE_PUSH: return { type: "member-leave", playerId: u64(r) };
    case ClanOp.STATUS_PUSH: return { type: "member-status", playerId: u64(r), status: status(r) };
    case ClanOp.ACCEPT_RESULT_PUSH: return { type: "accept-result", clan: parseAcceptResult(r) };
    case ClanOp.DEPORTED_PUSH: return { type: "deported" };
    case ClanOp.MASTER_PUSH: return { type: "master" };
    case ClanOp.STAFF_PUSH: return { type: "staff" };
    case ClanOp.REGULAR_PUSH: return { type: "regular" };
    case ClanOp.CHAT_ACK: return { type: "chat", msg: parseClanChat(r) };
    case ClanOp.PAGE_CHAT_PUSH: r.readC(); return { type: "page-chat", msg: parseClanChat(r) };
    case ClanOp.ROOM_INVITE_PUSH: return { type: "room-invite", invite: parseRoomInvite(r) };
    case ClanOp.INVITE_RESULT_PUSH: return { type: "invite-result", err: r.readD() };
    default: return null;
  }
}

// ---- writers ----
/** C count + U count*2 (server reads readU(readC() * 2)) */
const countedW = (w: PacketWriter, text: string): PacketWriter => {
  const s = text.slice(0, 255);
  return w.writeC(s.length).writeU(s, s.length * 2);
};
const countedHW = (w: PacketWriter, text: string): PacketWriter => w.writeH(text.length).writeU(text, text.length * 2);
const idsW = (ids: readonly bigint[]): PacketWriter => {
  const w = new PacketWriter(1 + ids.length * 8).writeC(ids.length);
  for (const id of ids) w.writeQ(id);
  return w;
};

export class ClanClient {
  private conn: TitleConn;
  private subs = new Set<(ev: ClanEvent) => void>();
  private off: () => void;

  constructor(conn: TitleConn) {
    this.conn = conn;
    this.off = conn.on((op, r) => {
      const ev = parsePush(op, r);
      if (ev) for (const f of [...this.subs]) f(ev);
    });
  }

  /** every clan push (and the 801 detail that follows an enter) */
  on(fn: (ev: ClanEvent) => void): () => void { this.subs.add(fn); return () => this.subs.delete(fn); }
  dispose(): void { this.off(); this.subs.clear(); }

  /** request + one of its ACK opcodes; the listener is armed before the send and removed on the first match or on timeout */
  /** asks run one at a time: two pending asks on the same ACK opcode (e.g. two 800 -> 801) would both take the first reply */
  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private ask(op: number, ackOps: readonly number[], body?: PacketWriter): Promise<PacketReader> {
    // idle: send now (synchronously); else after the asks in flight
    const run = this.pending === 0 ? this.askNow(op, ackOps, body) : this.chain.then(() => this.askNow(op, ackOps, body));
    this.pending++;
    const done = run.then(() => {}, () => {}).then(() => { this.pending--; });
    this.chain = done;
    return run;
  }

  private askNow(op: number, ackOps: readonly number[], body?: PacketWriter): Promise<PacketReader> {
    return new Promise((resolve, reject) => {
      let off: () => void = () => {};
      const timer = setTimeout(() => { off(); reject(new Error(`clan: no ACK for opcode ${op}`)); }, ASK_TIMEOUT_MS);
      off = this.conn.on((o, r) => {
        if (!ackOps.includes(o)) return;
        clearTimeout(timer);
        off();
        resolve(r);
      });
      try { this.conn.send(op, body); } catch (e) { clearTimeout(timer); off(); reject(e); }
    });
  }

  /** 769 -> 770: join the applicant / member view (a member also gets the 801 detail push) */
  async enter(): Promise<ClanReply<ClanEnter>> {
    return parseEnter(await this.ask(ClanOp.ENTER_REQ, [ClanOp.ENTER_ACK]));
  }

  /** 771 -> 772: leave the clan lobby room state */
  async leave(): Promise<ClanReply<void>> {
    return errOnly(await this.ask(ClanOp.LEAVE_REQ, [ClanOp.LEAVE_ACK]));
  }

  /** 997 -> 1000: clan list page starting at index `start` (server slices 15 per page). The name filter is not used by the server. */
  async list(start = 0): Promise<ClanReply<ClanListPage>> {
    const w = new PacketWriter(4).writeC(start).writeC(0).writeC(0).writeC(0); // C start, C0 name len [INFERIDO], C0 C0 [INFERIDO]
    return parseList(await this.ask(ClanOp.LIST_REQ, [ClanOp.LIST_ACK], w));
  }

  /** 800 -> 801: clan detail. `echo` comes back in the ACK (server echoes the C). */
  async detail(id: number, echo = 0): Promise<ClanReply<ClanDetail>> {
    const r = await this.ask(ClanOp.DETAIL_REQ, [ClanOp.DETAIL_ACK], new PacketWriter(5).writeD(id).writeC(echo));
    return reply(0, parseDetail(r));
  }

  /** 1001 -> 1002: short clan card (err 0x80000000 when the clan does not exist) */
  async simpleInfo(id: number): Promise<ClanReply<ClanSimple>> {
    return parseSimple(await this.ask(ClanOp.SIMPLE_REQ, [ClanOp.SIMPLE_ACK], new PacketWriter(4).writeD(id)));
  }

  /** 802 -> 803: member count and page layout of the own clan (or the last `detail` id) */
  async memberContext(): Promise<ClanReply<ClanPage>> {
    return parseCount(await this.ask(ClanOp.MEMBER_CTX_REQ, [ClanOp.MEMBER_CTX_ACK]));
  }

  /** 804 -> 805: member rows, 14 per page */
  async memberList(page = 0): Promise<ClanReply<{ page: number; members: ClanMemberRow[] }>> {
    return parseMemberList(await this.ask(ClanOp.MEMBER_LIST_REQ, [ClanOp.MEMBER_LIST_ACK], new PacketWriter(1).writeC(page)));
  }

  /** 806 -> 807: create a clan (the server charges the create gold; err 0x8000104a when the condition fails). `logo` = the
   * emblem after the intro [INFERIDO] (server socialHandlers.ts reads it when 4 bytes follow; 0 = no mark) */
  async create(name: string, info: string, logo = 0): Promise<ClanReply<ClanCreated>> {
    const w = new PacketWriter(564).writeD(0).writeU(name, 34).writeU(info, 510).writeD(logo >>> 0); // D unused by the server
    return parseCreate(await this.ask(ClanOp.CREATE_REQ, [ClanOp.CREATE_ACK], w));
  }

  /** 812 -> 813: ask to join clan `clanId` with a short text (server caps the list of requests per clan at 100) */
  async requestJoin(clanId: number, text: string): Promise<ClanReply<{ clanId: number }>> {
    const w = new PacketWriter(16).writeD(clanId);
    countedW(w, text);
    return parseJoin(await this.ask(ClanOp.JOIN_REQ, [ClanOp.JOIN_ACK], w));
  }

  /** 814 -> 815: withdraw own join request */
  async cancelJoin(): Promise<ClanReply<void>> {
    return errOnly(await this.ask(ClanOp.CANCEL_REQ, [ClanOp.CANCEL_ACK]));
  }

  /** 828 -> 829: leave the clan (the owner gets err 0x8000105e) */
  async secede(): Promise<ClanReply<void>> {
    return errOnly(await this.ask(ClanOp.SECEDE_REQ, [ClanOp.SECEDE_ACK]));
  }

  /** 854: clan chat line (type 5; server drops text over 60 chars). The echo comes back as a `chat` event to every online member. */
  chat(text: string): void {
    const w = new PacketWriter(8 + text.length * 2).writeH(5);
    countedHW(w, text);
    this.conn.send(ClanOp.CHAT_REQ, w);
  }

  /** 808 -> 809: close the clan (owner only) */
  async close(): Promise<ClanReply<void>> {
    return errOnly(await this.ask(ClanOp.CLOSE_REQ, [ClanOp.CLOSE_ACK]));
  }

  /** 810 -> 811: rank check before a join (err 0x8000107b when the clan's rank limit is above the account) */
  async checkJoinAuthority(clanId: number): Promise<ClanReply<void>> {
    return errOnly(await this.ask(ClanOp.JOIN_AUTH_REQ, [ClanOp.JOIN_AUTH_ACK], new PacketWriter(4).writeD(clanId)));
  }

  /** 816 -> 817: pending join-request count of the own clan (staff) */
  async requestContext(): Promise<ClanReply<ClanPage>> {
    return parseCount(await this.ask(ClanOp.CONTEXT_REQ, [ClanOp.CONTEXT_ACK]));
  }

  /** 818 -> 819: pending join requests, 13 per first page then 14 */
  async requestList(page = 0): Promise<ClanReply<{ page: number; requests: ClanJoinRequest[] }>> {
    return parseRequestList(await this.ask(ClanOp.REQUEST_LIST_REQ, [ClanOp.REQUEST_LIST_ACK], new PacketWriter(1).writeC(page)));
  }

  /** 820 -> 821: one pending request by account id */
  async requestInfo(playerId: bigint): Promise<ClanReply<ClanRequestInfo>> {
    return parseRequestInfo(await this.ask(ClanOp.REQUEST_INFO_REQ, [ClanOp.REQUEST_INFO_ACK], new PacketWriter(8).writeQ(playerId)));
  }

  /** 822 -> 823: accept pending requests (staff). `count` = accepted; not staff = ok false. Each accepted online account gets 824 / 845. */
  async accept(ids: readonly bigint[]): Promise<ClanReply<{ count: number }>> {
    return this.countAck(ClanOp.ACCEPT_REQ, ClanOp.ACCEPT_ACK, idsW(ids));
  }

  /** 825 -> 826: refuse pending requests (staff) */
  async deny(ids: readonly bigint[]): Promise<ClanReply<{ count: number }>> {
    return this.countAck(ClanOp.DENY_REQ, ClanOp.DENY_ACK, idsW(ids));
  }

  /** 830 -> 831: remove members (staff); the server answers a count or 0x80001059 */
  async deport(ids: readonly bigint[]): Promise<ClanReply<{ count: number }>> {
    return this.countAck(ClanOp.DEPORT_REQ, ClanOp.DEPORT_ACK, idsW(ids));
  }

  /** 833 -> 834: hand the clan to `playerId` (owner only; target must be staff with rank above 10) */
  async commissionMaster(playerId: bigint): Promise<ClanReply<void>> {
    return errOnly(await this.ask(ClanOp.MASTER_REQ, [ClanOp.MASTER_ACK], new PacketWriter(8).writeQ(playerId)));
  }

  /** 836 -> 837: regular -> staff (owner, or owner-only master rule); count of promoted */
  async commissionStaff(ids: readonly bigint[]): Promise<ClanReply<{ count: number }>> {
    return this.countAck(ClanOp.STAFF_REQ, ClanOp.STAFF_ACK, idsW(ids));
  }

  /** 839 -> 840: staff -> regular; count of demoted */
  async commissionRegular(ids: readonly bigint[]): Promise<ClanReply<{ count: number }>> {
    return this.countAck(ClanOp.REGULAR_REQ, ClanOp.REGULAR_ACK, idsW(ids));
  }

  /** 856 -> 857: is `logo` free. ok = free (server err 0 means no other clan has it). */
  async checkMark(logo: number): Promise<ClanReply<void>> {
    return errOnly(await this.ask(ClanOp.MARK_REQ, [ClanOp.MARK_ACK], new PacketWriter(4).writeD(logo)));
  }

  /** 858 -> 859: replace the clan notice (staff) */
  async replaceNotice(text: string): Promise<ClanReply<void>> {
    return errOnly(await this.ask(ClanOp.NOTICE_REQ, [ClanOp.NOTICE_ACK], countedW(new PacketWriter(2 + text.length * 2), text)));
  }

  /** 860 -> 861: replace the clan intro (staff) */
  async replaceIntro(text: string): Promise<ClanReply<void>> {
    return errOnly(await this.ask(ClanOp.INTRO_REQ, [ClanOp.INTRO_ACK], countedW(new PacketWriter(2 + text.length * 2), text)));
  }

  /** 868 -> 869: clan rules (owner only) */
  async replaceManagement(m: ClanManage): Promise<ClanReply<void>> {
    const w = new PacketWriter(5).writeC(m.authority).writeC(m.rankLimit).writeC(m.maxAge).writeC(m.minAge).writeC(m.join);
    return errOnly(await this.ask(ClanOp.MANAGE_REQ, [ClanOp.MANAGE_ACK], w));
  }

  /** 877: invite the lobby user `sessionId` (3677 list row) to the room the account owns (no ACK; the target gets a `room-invite` push) */
  roomInvite(sessionId: number): void {
    this.conn.send(ClanOp.ROOM_INVITE_REQ, new PacketWriter(8).writeQ(BigInt(sessionId)));
  }

  /** 886: page chat line (type 8; no ACK; every online member gets a `page-chat` push) */
  pageChat(text: string): void {
    const w = new PacketWriter(4 + text.length * 2).writeH(8);
    countedHW(w, text);
    this.conn.send(ClanOp.PAGE_CHAT_REQ, w);
  }

  /** 888 -> 889: invite the account named by the server's last find (`findPlayer`); the server takes no nick here */
  async invite(): Promise<ClanReply<void>> {
    return errOnly(await this.ask(ClanOp.INVITE_REQ, [ClanOp.INVITE_ACK]));
  }

  /** 890 -> 891 (error) or 1922 (done): answer a clan invite. accept = true joins the clan. */
  async inviteAccept(clanId: number, accept: boolean): Promise<ClanReply<void>> {
    const r = await this.ask(ClanOp.INVITE_ACCEPT_REQ, [ClanOp.INVITE_ACCEPT_ERR_ACK, ClanOp.INVITE_RESULT_PUSH], new PacketWriter(5).writeD(clanId).writeC(accept ? 1 : 0));
    return errOnly(r);
  }

  /** 892 -> 893: clan note to members (owner). target 0 = all, 1 = staff, 2 = regular. count = notes sent. */
  async clanNote(target: 0 | 1 | 2, text: string): Promise<ClanReply<{ count: number }>> {
    const w = new PacketWriter(2 + text.length * 2).writeC(target);
    countedW(w, text);
    return this.countAck(ClanOp.NOTE_REQ, ClanOp.NOTE_ACK, w);
  }

  /** 916 -> 917: minimum rank and gold to create a clan */
  async createCondition(): Promise<ClanReply<ClanCondition>> {
    return reply(0, parseCondition(await this.ask(ClanOp.CONDITION_REQ, [ClanOp.CONDITION_ACK])));
  }

  /** 918 -> 919: duplicate check (server stub: always 0) */
  async checkDuplicate(): Promise<ClanReply<void>> {
    return errOnly(await this.ask(ClanOp.DUPLICATE_REQ, [ClanOp.DUPLICATE_ACK]));
  }

  /** count-style ACK (see countReply) */
  private async countAck(op: number, ackOp: number, body: PacketWriter): Promise<ClanReply<{ count: number }>> {
    return countReply((await this.ask(op, [ackOp], body)).readD());
  }
}
