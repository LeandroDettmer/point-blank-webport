// Clan client round trip. Each ClanClient request is run through the real server clan handlers (socialHandlers.ts /
// clanHandlers.ts); the ACK and push frames they write come back through ClanClient's parsers. pool.query is replaced by an
// in-memory stub that answers the SQL these handlers send, so no Postgres is needed.
// Run: node --experimental-transform-types src/net/test/clanClient.smoke.node.ts
import { readFileSync } from "node:fs";
import { PacketReader, PacketWriter } from "../packet.ts";
import { ClanClient, ClanErr, ClanOp, CLAN_STATE, decodeClanStatus, type ClanEvent } from "../clanClient.ts";
import type { TitleConn } from "../titleClient.ts";
import { pool } from "../../../server/src/db.ts";
import { config } from "../../../server/src/config.ts";
import * as sh from "../../../server/src/game/socialHandlers.ts";
import * as ch from "../../../server/src/game/clanHandlers.ts";
import type { Account } from "../../../server/src/shared/account.ts";

// ---- wire: one per account. Client requests queue here; server frames queue in `frames` until pump() delivers them ----
class Wire implements TitleConn {
  readonly pid: bigint;
  requests: { op: number; body: Uint8Array }[] = [];
  frames: Uint8Array[] = [];
  private subs = new Set<(op: number, r: PacketReader) => void>();
  constructor(pid: bigint) { this.pid = pid; }
  on(fn: (op: number, r: PacketReader) => void): () => void { this.subs.add(fn); return () => this.subs.delete(fn); }
  waitFor(op: number): Promise<PacketReader> {
    return new Promise((resolve) => {
      const off = this.on((o, r) => { if (o === op) { off(); resolve(r); } });
    });
  }
  send(op: number, body?: PacketWriter | Uint8Array): void {
    this.requests.push({ op, body: body instanceof PacketWriter ? body.toBytes() : (body ?? new Uint8Array(0)) });
  }
  deliver(op: number, body: Uint8Array): void { for (const f of [...this.subs]) f(op, new PacketReader(body)); }
}

// ---- fake accounts (also the online map and the account rows the stub SQL reads) ----
interface FakeAccount {
  playerId: bigint; nickname: string; nickColor: number; rank: number; gold: number; cash: number; tags: number; access: number;
  clanId: number; clanAccess: number; clanDate: number; clan: { id: number; logo: number; name: string; ownerId: bigint; rank: number; unit: number; effect: number; nameColor: number };
  status: { buffer: number }; statistic: { basic: { killsCount: number; deathsCount: number; matches: number; matchWins: number; matchLoses: number } };
  equipment: { nameCardId: number }; bonus: { nickBorderColor: number }; room?: { roomId: number; password: string; getLeader(): FakeAccount | null }; slotId: number;
  channelId: number; session: { sessionId: number };
  findPlayer: string; hideGMcolor: boolean; last: Record<string, number>; connection: unknown;
  lastAt(k: string): number; durationSince(k: string): number; useChatGM(): boolean;
}
type ServerClient = Parameters<typeof sh.handleClanEnter>[0];

const wires = new Map<bigint, Wire>();
const accounts = new Map<bigint, FakeAccount>();
const clients = new Map<bigint, ClanClient>();
const clientCtx = new Map<bigint, ServerClient>();
const events = new Map<bigint, ClanEvent[]>();

function mkAccount(pid: bigint, nickname: string, rank: number, clanId: number, clanAccess: number, gold = 0): FakeAccount {
  const a: FakeAccount = {
    playerId: pid, nickname, nickColor: 3, rank, gold, cash: 0, tags: 0, access: 0, clanId, clanAccess, clanDate: 20260101,
    clan: { id: clanId, logo: 0, name: "", ownerId: 0n, rank: 0, unit: 0, effect: 0, nameColor: 0 },
    status: { buffer: 0 }, statistic: { basic: { killsCount: 5, deathsCount: 2, matches: 3, matchWins: 1, matchLoses: 2 } },
    equipment: { nameCardId: 7 }, bonus: { nickBorderColor: 4 }, slotId: 0, channelId: 0, session: { sessionId: Number(pid) - 1000 }, findPlayer: "", hideGMcolor: false, last: {},
    connection: { session: { send: (b: Uint8Array) => wires.get(pid)?.frames.push(b) } },
    lastAt: () => 0, durationSince: () => 1e9, useChatGM: () => false,
  };
  accounts.set(pid, a);
  sh.social.online.set(pid, a as unknown as Account);
  const w = new Wire(pid);
  wires.set(pid, w);
  clientCtx.set(pid, { session: { send: (b: Uint8Array) => w.frames.push(b), close: () => {} }, player: a } as unknown as ServerClient);
  const c = new ClanClient(w);
  clients.set(pid, c);
  const evs: ClanEvent[] = [];
  events.set(pid, evs);
  c.on((e) => evs.push(e));
  return a;
}
const cli = (pid: bigint) => clients.get(pid)!;
const evs = (pid: bigint) => events.get(pid)!;
const acc = (pid: bigint) => accounts.get(pid)!;

// ---- stub for pool.query: the SQL the clan handlers send ----
interface ClanRow {
  id: number; name: string; logo: number; info: string; news: string; owner_id: string; rank: number; exp: number; point: number;
  create_date: number; max_players: number; name_color: number; effects: number; matches: number; match_wins: number; match_loses: number;
  authority: number; rank_limit: number; min_age_limit: number; max_age_limit: number; join_permission: number;
}
interface InviteRow { clan_id: number; player_id: string; invite_date: number; text: string }
const clanRows: ClanRow[] = [];
const inviteRows: InviteRow[] = [];
const members = (clanId: number, except = -1n) => [...accounts.values()].filter((a) => a.clanId === clanId && a.playerId !== except);
const str = (v: unknown) => String(v);

function rowsFor(sql: string, p: unknown[]): object[] {
  const s = sql.replace(/\s+/g, " ").trim();
  const n = Number(p[0]);
  if (/^SELECT \* FROM system_clan ORDER BY/.test(s)) return clanRows;
  if (/^SELECT \* FROM system_clan WHERE id=/.test(s)) return clanRows.filter((c) => c.id === n);
  if (/^SELECT COUNT\(\*\) AS n FROM system_clan WHERE name=/.test(s)) return [{ n: clanRows.filter((c) => c.name === p[0]).length }];
  if (/^SELECT COUNT\(\*\) AS n FROM system_clan WHERE logo=/.test(s)) return [{ n: clanRows.filter((c) => c.logo === n).length }];
  if (/^SELECT COUNT\(\*\) AS n FROM system_clan_invites WHERE clan_id=/.test(s)) return [{ n: inviteRows.filter((i) => i.clan_id === n).length }];
  if (/^SELECT COUNT\(\*\) AS n FROM system_clan_invites WHERE player_id=/.test(s)) return [{ n: inviteRows.filter((i) => i.player_id === str(p[0])).length }];
  if (/^SELECT COUNT\(\*\) AS n FROM accounts WHERE clan_id=/.test(s)) return [{ n: members(n).length }];
  if (/^SELECT clan_id FROM system_clan_invites WHERE player_id=/.test(s)) return inviteRows.filter((i) => i.player_id === str(p[0])).map((i) => ({ clan_id: i.clan_id }));
  if (/^SELECT \* FROM system_clan_invites WHERE clan_id=/.test(s)) return inviteRows.filter((i) => i.clan_id === n);
  if (/^SELECT 1 FROM system_clan_invites WHERE clan_id=/.test(s)) return inviteRows.filter((i) => i.clan_id === n && i.player_id === str(p[1])).map(() => ({ 1: 1 }));
  if (/^SELECT text FROM system_clan_invites WHERE clan_id=/.test(s)) return inviteRows.filter((i) => i.clan_id === n && i.player_id === str(p[1])).map((i) => ({ text: i.text }));
  if (/^SELECT nickname, nick_color, rank FROM accounts WHERE player_id=/.test(s)) {
    const a = accounts.get(BigInt(str(p[0])));
    return a ? [{ nickname: a.nickname, nick_color: a.nickColor, rank: a.rank }] : [];
  }
  if (/^SELECT player_id, clan_access FROM accounts WHERE clan_id=/.test(s)) return members(n, BigInt(str(p[1]))).map((a) => ({ player_id: a.playerId, clan_access: a.clanAccess }));
  if (/FROM accounts a LEFT JOIN player_stat_clans s/.test(s)) {
    // 845 (clanMemberInfoAck) excludes the account itself; 805 (member list) lists the whole clan
    const list = /player_bonus/.test(s) ? members(n, BigInt(str(p[1]))) : members(n);
    return list.map((a) => ({
      player_id: a.playerId, nickname: a.nickname, nick_color: a.nickColor, rank: a.rank, online: true, clan_access: a.clanAccess,
      clan_date: a.clanDate, status: a.status.buffer, w: 4, l: 3, nc: a.equipment.nameCardId, nb: a.bonus.nickBorderColor,
    }));
  }
  if (/^SELECT clan_match_wins AS w/.test(s)) return [{ w: 0, l: 0 }];
  if (/^SELECT type FROM base_ban_history/.test(s)) return [];
  if (/COUNT\(\*\)/.test(s)) return [{ n: 0 }];
  return [];
}

function runSql(sql: string, p: unknown[]): object[] {
  const s = sql.replace(/\s+/g, " ").trim();
  const n = Number(p[0]);
  if (/^INSERT INTO system_clan \(/.test(s)) {
    const id = clanRows.length ? Math.max(...clanRows.map((c) => c.id)) + 1 : 1;
    clanRows.push({
      id, name: str(p[0]), logo: 0, info: str(p[3]), news: "", owner_id: str(p[1]), rank: 0, exp: 0, point: 1000, create_date: Number(p[2]),
      max_players: 50, name_color: 0, effects: 0, matches: 0, match_wins: 0, match_loses: 0, authority: 0, rank_limit: 0, min_age_limit: 0,
      max_age_limit: 0, join_permission: 0,
    });
    return [{ id }];
  }
  if (/^INSERT INTO system_clan_invites/.test(s)) { inviteRows.push({ clan_id: n, player_id: str(p[1]), invite_date: Number(p[2]), text: str(p[3]) }); return []; }
  if (/^INSERT INTO player_messages/.test(s)) return [{ object_id: 1 }]; // notes are not stored; only the id is read back
  if (/^DELETE FROM system_clan_invites/.test(s)) {
    const byClan = /clan_id=\$1 AND player_id/.test(s);
    for (let i = inviteRows.length - 1; i >= 0; i--) {
      const x = inviteRows[i];
      if (byClan ? x.clan_id === n && x.player_id === str(p[1]) : x.player_id === str(p[0])) inviteRows.splice(i, 1);
    }
    return [];
  }
  if (/^DELETE FROM system_clan WHERE id=/.test(s)) {
    const i = clanRows.findIndex((c) => c.id === n);
    if (i >= 0) clanRows.splice(i, 1);
    return [];
  }
  if (/^UPDATE system_clan SET/.test(s)) {
    const m = /^UPDATE system_clan SET (.+) WHERE id=\$(\d+)$/.exec(s);
    const row = clanRows.find((c) => c.id === Number(p[Number(m![2]) - 1]));
    if (row) for (const part of m![1].split(",")) {
      const [col, ph] = part.trim().split("=");
      (row as unknown as Record<string, unknown>)[col] = p[Number(ph.slice(1)) - 1];
    }
    return [];
  }
  if (/^UPDATE accounts SET gold = gold/.test(s)) {
    const a = accounts.get(BigInt(str(p[3])));
    if (a) { a.gold += Number(p[0]); a.cash += Number(p[1]); a.tags += Number(p[2]); }
    return a ? [{ gold: a.gold, cash: a.cash, tags: a.tags }] : [];
  }
  if (/^UPDATE /.test(s)) return []; // accounts / player_stat_clans: the handlers set the same fields on the account object
  return rowsFor(sql, p);
}
(pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => ({ rows: runSql(sql, params), rowCount: 1 });

// ---- server dispatch: the same ops gameServer.ts routes to the clan handlers (checked against its source below) ----
type Route = (c: ServerClient, r: PacketReader) => unknown;
const ROUTES: Record<number, Route> = {
  769: (c) => sh.handleClanEnter(c), 771: (c) => sh.handleClanLeave(c), 997: (c, r) => sh.handleClanList(c, r),
  800: (c, r) => sh.handleClanDetail(c, r), 1001: (c, r) => sh.handleClanSimpleInfo(c, r), 802: (c) => sh.handleClanMemberContext(c),
  804: (c, r) => sh.handleClanMemberList(c, r), 806: (c, r) => sh.handleClanCreate(c, r), 812: (c, r) => sh.handleClanJoinRequest(c, r),
  814: (c) => sh.handleClanCancelRequest(c), 828: (c) => sh.handleClanSecession(c), 854: (c, r) => sh.handleClanChat(c, r),
  808: (c) => ch.handleCloseClan(c), 810: (c, r) => ch.handleCheckJoinAuthority(c, r), 816: (c) => ch.handleRequestContext(c),
  818: (c, r) => ch.handleRequestList(c, r), 820: (c, r) => ch.handleRequestInfo(c, r), 822: (c, r) => ch.handleAcceptRequest(c, r),
  825: (c, r) => ch.handleDenialRequest(c, r), 830: (c, r) => ch.handleDeportation(c, r), 833: (c, r) => ch.handleCommissionMaster(c, r),
  836: (c, r) => ch.handleCommissionStaff(c, r), 839: (c, r) => ch.handleCommissionRegular(c, r), 856: (c, r) => ch.handleCheckMark(c, r),
  858: (c, r) => ch.handleReplaceNotice(c, r), 860: (c, r) => ch.handleReplaceIntro(c, r), 868: (c, r) => ch.handleReplaceManagement(c, r),
  877: (c, r) => ch.handleRoomInvited(c, r), 886: (c, r) => ch.handlePageChat(c, r), 888: (c) => ch.handleInvite(c),
  890: (c, r) => ch.handleInviteAccept(c, r), 892: (c, r) => ch.handleClanNote(c, r), 916: (c) => ch.handleCreateClanCondition(c),
  // gameServer.ts:555 writes this one inline (CHECK_DUPLICATE stub)
  918: (c) => c.session.send(new PacketWriter(8).writeH(919).writeD(0).toBytes()),
};

const gameServerSrc = readFileSync(new URL("../../../server/src/game/gameServer.ts", import.meta.url), "utf8");

async function pump(): Promise<void> {
  for (let round = 0; round < 500; round++) {
    let busy = false;
    for (const w of wires.values()) {
      while (w.requests.length > 0) {
        busy = true;
        const q = w.requests.shift()!;
        const route = ROUTES[q.op];
        if (!route) throw new Error(`no server route for clan opcode ${q.op}`);
        await route(clientCtx.get(w.pid)!, new PacketReader(q.body));
      }
      while (w.frames.length > 0) {
        busy = true;
        const f = w.frames.shift()!;
        w.deliver(new PacketReader(f).readH(), f.subarray(2));
      }
    }
    if (!busy) return;
  }
  throw new Error("pump: frames did not settle");
}

/** arm the client call, let the server answer, then return the reply */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  const p = fn();
  p.catch(() => {});
  await pump();
  return p;
}

const J = (x: unknown): string => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
let failures = 0, passes = 0;
function check(label: string, cond: boolean, extra = ""): void {
  if (cond) passes++;
  else failures++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : ` ${extra}`}`);
}
const hasEv = (pid: bigint, pred: (e: ClanEvent) => boolean): boolean => evs(pid).some(pred);

// ---- fixtures: clan 1 Alpha (owner 1001, staff 1003, member 1002), clan 2 Beta (owner 1006), applicant 1004 with an invite to clan 1 ----
const OWNER = 1001n, MEMBER = 1002n, STAFF = 1003n, APPLICANT = 1004n, NEWBIE = 1005n, SOLO = 1006n;
mkAccount(OWNER, "Dono", 30, 1, 1); mkAccount(MEMBER, "Membro", 12, 1, 3); mkAccount(STAFF, "Staff", 15, 1, 2);
mkAccount(APPLICANT, "Pedinte", 8, 0, 0); mkAccount(NEWBIE, "Novato", config.minCreateRank + 1, 0, 0, config.minCreateGold + 100000);
mkAccount(SOLO, "Sozinho", 9, 0, 0);
acc(OWNER).clan = { id: 1, logo: 111, name: "Alpha", ownerId: OWNER, rank: 3, unit: 0, effect: 1, nameColor: 2 };
acc(MEMBER).clan = { ...acc(OWNER).clan }; acc(STAFF).clan = { ...acc(OWNER).clan };
clanRows.push(
  { id: 1, name: "Alpha", logo: 111, info: "alpha info", news: "alpha news", owner_id: "1001", rank: 3, exp: 500, point: 1200, create_date: 20260101,
    max_players: 50, name_color: 2, effects: 1, matches: 10, match_wins: 6, match_loses: 4, authority: 1, rank_limit: 5, min_age_limit: 18,
    max_age_limit: 60, join_permission: 1 },
  { id: 2, name: "Beta", logo: 222, info: "beta info", news: "", owner_id: "1006", rank: 1, exp: 0, point: 1000, create_date: 20260102,
    max_players: 50, name_color: 0, effects: 0, matches: 0, match_wins: 0, match_loses: 0, authority: 0, rank_limit: 0, min_age_limit: 0,
    max_age_limit: 0, join_permission: 0 },
);
inviteRows.push({ clan_id: 1, player_id: "1004", invite_date: 20260910, text: "quero entrar" });
sh.social.byNick = async (nick: string) => (nick === "Sozinho" ? acc(SOLO) : nick === "Pedinte" ? acc(APPLICANT) : null) as unknown as Account | null;

async function run(): Promise<void> {
  // route table must match gameServer.ts (a missing `case N:` means the table drifted)
  for (const op of Object.keys(ROUTES)) check(`gameServer.ts routes opcode ${op}`, gameServerSrc.includes(`case ${op}:`));

  // enter / leave
  {
    const r = await call(() => cli(OWNER).enter());
    check("enter (member): clan 1, access 1, no list", r.ok && r.data?.clanId === 1 && r.data?.access === 1 && r.data?.list === null, J(r));
    check("enter (member): 801 detail push", hasEv(OWNER, (e) => e.type === "detail" && e.detail.name === "Alpha"));
    const a = await call(() => cli(APPLICANT).enter());
    check("enter (applicant): pending clan 1, clan list page", a.ok && a.data?.clanId === 1 && a.data?.access === 0 && a.data?.list?.count === 2 && a.data?.list?.perPage === 15, J(a));
    const l = await call(() => cli(MEMBER).leave());
    check("leave: ok", l.ok, J(l));
  }

  // list / detail / simple info / member context + list
  {
    const r = await call(() => cli(OWNER).list(0));
    check("list: total 2, Alpha + Beta", r.ok && r.data?.total === 2 && r.data?.clans.map((c) => c.name).join() === "Alpha,Beta" && r.data?.clans[0].info === "alpha info" && r.data?.clans[0].logo === 111, J(r));
    const d = await call(() => cli(OWNER).detail(1, 7));
    const x = d.data!;
    check("detail: echo, name, owner, counts", x?.echo === 7 && x.name === "Alpha" && x.members === 3 && x.ownerNick === "Dono" && x.ownerId === 1001n && x.ownerRank === 30, J(d));
    check("detail: info, news, rules", x.info === "alpha info" && x.news === "alpha news" && x.joinPermission === 1 && x.rankLimit === 5 && x.minAge === 18 && x.maxAge === 60 && x.authority === 1);
    check("detail: points, wins/loses, matches", x.points === 1200 && x.wins === 6 && x.loses === 4 && x.matches === 10 && x.matchWins === 6 && x.matchLoses === 4);
    check("detail: exp, logo, name color, rank", x.exp === 500 && x.logo === 111 && x.nameColor === 2 && x.effects === 1 && x.rank === 3 && x.createDate === 20260101 && x.clanRank === 3);
    const s = await call(() => cli(OWNER).simpleInfo(1));
    check("simple info: Alpha card", s.ok && s.data?.name === "Alpha" && s.data?.points === 1200 && s.data?.unit === 0 && s.data?.members === 3 && s.data?.maxPlayers === 50 && s.data?.ownerId === 1001n && s.data?.logo === 111, J(s));
    const sn = await call(() => cli(OWNER).simpleInfo(999));
    check("simple info: missing clan -> err 0x80000000", !sn.ok && sn.err === ClanErr.FAIL, J(sn));
    const mc = await call(() => cli(OWNER).memberContext());
    check("member context: 3 members, 14 per page, 1 page", mc.ok && mc.data?.count === 3 && mc.data?.perPage === 14 && mc.data?.pages === 1, J(mc));
    const mcSolo = await call(() => cli(SOLO).memberContext());
    check("member context: no clan -> 0xffffffff", !mcSolo.ok && mcSolo.err === ClanErr.NONE, J(mcSolo));
    const ml = await call(() => cli(OWNER).memberList(0));
    const rows = ml.data?.members ?? [];
    check("member list: 3 rows, nicks + access", ml.ok && rows.map((m) => m.nick).join() === "Dono,Membro,Staff" && rows.map((m) => m.access).join() === "1,3,2" && rows[0].rank === 30, J(ml));
    check("member list: status decodes to the server clanStatus", rows.length > 0 && decodeClanStatus(rows[0].status.raw).state === CLAN_STATE.LOBBY && rows[0].status.raw === sh.clanStatus(0, true));
  }

  // join requests
  {
    const cc = await call(() => cli(SOLO).requestContext());
    check("request context: no clan -> 0xffffffff", !cc.ok && cc.err === ClanErr.NONE, J(cc));
    const ctx = await call(() => cli(OWNER).requestContext());
    check("request context: 1 pending, 13 per page", ctx.ok && ctx.data?.count === 1 && ctx.data?.perPage === 13, J(ctx));
    const rl = await call(() => cli(OWNER).requestList(0));
    const q = rl.data?.requests[0];
    check("request list: applicant row, page 0", rl.ok && rl.data?.page === 0 && rl.data?.requests.length === 1 && q?.playerId === APPLICANT && q.nick === "Pedinte" && q.rank === 8 && q.inviteDate === 20260910 && q.text === "quero entrar" && q.kills === 5 && q.wins === 1, J(rl));
    const ri = await call(() => cli(OWNER).requestInfo(APPLICANT));
    check("request info: applicant + text", ri.ok && ri.data?.nick === "Pedinte" && ri.data?.text === "quero entrar" && ri.data?.matches === 3, J(ri));
    const rn = await call(() => cli(OWNER).requestInfo(STAFF));
    check("request info: no request -> 0x80000000", !rn.ok && rn.err === ClanErr.FAIL, J(rn));
    const ja = await call(() => cli(APPLICANT).checkJoinAuthority(1));
    check("join authority: rank above the limit passes", ja.ok, J(ja));
    const jr = await call(() => cli(APPLICANT).requestJoin(2, "oi"));
    check("join request: clan 2 -> ack with clan id", jr.ok && jr.data?.clanId === 2, J(jr));
    const jc = await call(() => cli(APPLICANT).cancelJoin());
    check("join cancel: ok", jc.ok, J(jc));
    // the server cancel deletes every request of the account (DELETE ... WHERE player_id), so put the clan 1 invite back for accept
    inviteRows.push({ clan_id: 1, player_id: "1004", invite_date: 20260910, text: "quero entrar" });
    const jd = await call(() => cli(MEMBER).requestJoin(2, "x"));
    check("join request while in a clan -> 0x8000105c", !jd.ok && jd.err === ClanErr.ALREADY_IN_CLAN, J(jd));
  }

  // chat / page chat / checkmark / edit text and rules
  {
    cli(STAFF).chat("oi clan");
    await pump();
    check("clan chat: owner gets the line", hasEv(OWNER, (e) => e.type === "chat" && e.msg.nick === "Staff" && e.msg.text === "oi clan"));
    cli(OWNER).pageChat("pagina");
    await pump();
    check("page chat: member gets the line", hasEv(MEMBER, (e) => e.type === "page-chat" && e.msg.nick === "Dono" && e.msg.text === "pagina"), J(evs(MEMBER).slice(-1)));
    const mTaken = await call(() => cli(OWNER).checkMark(111));
    check("check mark: logo in use -> not ok", !mTaken.ok, J(mTaken));
    const mFree = await call(() => cli(OWNER).checkMark(777));
    check("check mark: free logo -> ok", mFree.ok, J(mFree));
    const nt = await call(() => cli(OWNER).replaceNotice("novo aviso"));
    const it = await call(() => cli(OWNER).replaceIntro("nova intro"));
    check("replace notice / intro: ok", nt.ok && it.ok, J([nt, it]));
    const rm = await call(() => cli(OWNER).replaceManagement({ authority: 2, rankLimit: 9, maxAge: 70, minAge: 20, join: 0 }));
    check("replace management: ok", rm.ok, J(rm));
    const d2 = (await call(() => cli(OWNER).detail(1, 0))).data!;
    check("edits persisted (news, intro, rules)", d2.news === "novo aviso" && d2.info === "nova intro" && d2.authority === 2 && d2.rankLimit === 9 && d2.maxAge === 70 && d2.minAge === 20 && d2.joinPermission === 0, J(d2));
  }

  // accept / deny / staff / regular / deport / note / invite
  {
    const ac = await call(() => cli(OWNER).accept([APPLICANT]));
    check("accept: count 1", ac.ok && ac.data?.count === 1, J(ac));
    check("accept: applicant gets 845 members (excl. self)", hasEv(APPLICANT, (e) => e.type === "members" && e.members.length === 3));
    const res = evs(APPLICANT).find((e) => e.type === "accept-result");
    check("accept: applicant gets 824 with the clan, members 4", !!res && res.type === "accept-result" && res.clan.name === "Alpha" && res.clan.members === 4 && res.clan.news === "novo aviso", J(res));
    check("accept: owner gets 851 status change", hasEv(OWNER, (e) => e.type === "member-status" && e.playerId === APPLICANT));
    const nope = await call(() => cli(MEMBER).accept([SOLO]));
    check("accept by non-staff -> 0xffffffff", !nope.ok && nope.err === ClanErr.NONE, J(nope));
    const dn = await call(() => cli(OWNER).deny([SOLO]));
    check("deny: count 1", dn.ok && dn.data?.count === 1, J(dn));
    const cs = await call(() => cli(OWNER).commissionStaff([MEMBER]));
    check("commission staff: count 1, member gets 838", cs.ok && cs.data?.count === 1 && hasEv(MEMBER, (e) => e.type === "staff"));
    const cr = await call(() => cli(OWNER).commissionRegular([MEMBER]));
    check("commission regular: count 1, member gets 841", cr.ok && cr.data?.count === 1 && hasEv(MEMBER, (e) => e.type === "regular"));
    const dp = await call(() => cli(OWNER).deport([MEMBER]));
    check("deport: count 1, member gets 832, others get 849", dp.ok && dp.data?.count === 1 && hasEv(MEMBER, (e) => e.type === "deported") && hasEv(OWNER, (e) => e.type === "member-leave" && e.playerId === MEMBER));
    const nt2 = await call(() => cli(OWNER).clanNote(0, "aviso geral"));
    check("clan note: 2 members, owner gets 1922", nt2.ok && nt2.data?.count === 2 && hasEv(OWNER, (e) => e.type === "invite-result" && e.err === 0), J(nt2));
    acc(OWNER).findPlayer = "Sozinho";
    const iv = await call(() => cli(OWNER).invite());
    check("invite: clanless target -> ok", iv.ok, J(iv));
    acc(OWNER).findPlayer = "Pedinte";
    const iv2 = await call(() => cli(OWNER).invite());
    check("invite: target already in a clan -> 0x80000000", !iv2.ok && iv2.err === ClanErr.FAIL, J(iv2));
    const ia = await call(() => cli(SOLO).inviteAccept(1, true));
    check("invite accept: ok (1922)", ia.ok, J(ia));
    check("invite accept: owner gets 847 member insert", hasEv(OWNER, (e) => e.type === "member-insert" && e.member.nick === "Sozinho" && e.member.nickColor === 3));
    check("invite accept: joiner gets 845 + 824", hasEv(SOLO, (e) => e.type === "members" && e.members.length === 3) && hasEv(SOLO, (e) => e.type === "accept-result"));
    const ib = await call(() => cli(NEWBIE).inviteAccept(99, true));
    check("invite accept, clan missing -> 0x8000105b", !ib.ok && ib.err === ClanErr.NOT_IN_CLAN, J(ib));
    const ik = await call(() => cli(NEWBIE).inviteAccept(1, false));
    check("invite decline: ok (1922)", ik.ok, J(ik));
    acc(OWNER).room = { roomId: 7, password: "1234", getLeader: () => acc(OWNER) };
    cli(OWNER).roomInvite(acc(SOLO).session.sessionId);
    await pump();
    check("room invite: joiner gets 3077", hasEv(SOLO, (e) => e.type === "room-invite" && e.invite.roomId === 7 && e.invite.password === "1234" && e.invite.nick === "Dono"));
    acc(OWNER).room = undefined;
  }

  // secession / owner rules / create / close / master / duplicate
  {
    const os = await call(() => cli(OWNER).secede());
    check("secede as owner -> 0x8000105e", !os.ok && os.err === ClanErr.OWNER_CANNOT_SECEDE, J(os));
    const sc = await call(() => cli(APPLICANT).secede());
    check("secede as member: ok", sc.ok, J(sc));
    const cond = await call(() => cli(NEWBIE).createCondition());
    check("create condition: min rank / gold from config", cond.ok && cond.data?.minRank === config.minCreateRank && cond.data?.minGold === config.minCreateGold, J(cond));
    const gold0 = acc(NEWBIE).gold;
    const cr = await call(() => cli(NEWBIE).create("Gamma", "gamma info", 0x01010101));
    const g = cr.data;
    check("create: clan Gamma, owner Novato, gold charged", cr.ok && g?.name === "Gamma" && g.ownerNick === "Novato" && g.ownerId === 1005n && g.members === 1 && g.info === "gamma info", J(cr));
    check("create: gold reported = gold after the fee", g?.gold === acc(NEWBIE).gold && acc(NEWBIE).gold === gold0 - config.minCreateGold);
    const cl = await call(() => cli(NEWBIE).close());
    check("close: owner closes Gamma", cl.ok, J(cl));
    const gone = await call(() => cli(NEWBIE).simpleInfo(g?.id ?? 0));
    check("close: Gamma gone", !gone.ok, J(gone));
    const ms = await call(() => cli(OWNER).commissionMaster(STAFF));
    check("commission master: ok, staff gets 835", ms.ok && hasEv(STAFF, (e) => e.type === "master"), J(ms));
    const dd = (await call(() => cli(STAFF).detail(1, 0))).data!;
    check("master: clan owner now Staff", dd.ownerId === STAFF, String(dd.ownerId));
    const dup = await call(() => cli(OWNER).checkDuplicate());
    check("check duplicate: stub 0", dup.ok, J(dup));
  }

  // 877 / 886 / 892 / 893 / 1922 / 855 / 887 / 3077 / 845 / 847 / 849 / 851 / 832 / 835 / 838 / 841 / 824 / 801: all pushes seen above
}

run()
  .then(() => {
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error("FAIL abort:", e);
    process.exit(1);
  });
