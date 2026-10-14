// Clan war, etapa A round trip: ClanWarClient requests run through the real server handlers (server clanWarHandlers.ts);
// the ACK and push frames they write come back through the client parsers. pool.query is stubbed (system_clan row, member
// count, ban rows), so no Postgres is needed. The route table is checked against gameServer.ts so the two cannot drift.
// Run: node --experimental-transform-types src/net/test/clanWarClient.smoke.node.ts
import { readFileSync } from "node:fs";
import { PacketReader, PacketWriter } from "../packet.ts";
import { ClanWarClient, ClanWarErr, type ClanWarEvent } from "../clanWarClient.ts";
import type { TitleConn } from "../titleClient.ts";
import { pool } from "../../../server/src/db.ts";
import { ChannelModel } from "../../../server/src/game/channel.ts";
import { AccountStatus, type Account } from "../../../server/src/shared/account.ts";
import * as cw from "../../../server/src/game/clanWarHandlers.ts";
import { social } from "../../../server/src/game/socialHandlers.ts";
import type { GameClient } from "../../../server/src/game/gameServer.ts";

let passes = 0, failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) passes++; else failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};
const hex = (v: number) => `0x${(v >>> 0).toString(16)}`;
const J = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

// ---- wire: one per account. Client requests queue here; server frames queue in `frames` until pump() delivers them ----
class Wire implements TitleConn {
  requests: { op: number; body: Uint8Array }[] = [];
  frames: Uint8Array[] = [];
  private subs = new Set<(op: number, r: PacketReader) => void>();
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

// ---- fake accounts: the online map, the seat and status state the handlers touch ----
interface Fake {
  playerId: bigint; nickname: string; rank: number; clanId: number; clanAccess: number; access: number; status: AccountStatus;
  connection: unknown; room: null; last: Record<string, number>; durationSince: () => number;
}
const wires = new Map<bigint, Wire>();
const accounts = new Map<bigint, Fake>();
const clients = new Map<bigint, ClanWarClient>();
const events = new Map<bigint, ClanWarEvent[]>();
const ctx = new Map<bigint, { player: Account; session: { send(b: Uint8Array): void }; channelOf(): ChannelModel }>();
const CHANNEL = new ChannelModel();
CHANNEL.id = 1;
CHANNEL.type = 4; // ChannelType.clan
const cli = (pid: bigint) => clients.get(pid)!;
const evs = (pid: bigint) => events.get(pid)!;
const acc = (pid: bigint) => accounts.get(pid)! as unknown as Account;

function mk(pid: bigint, nickname: string, rank: number, clanId: number): Fake {
  const w = new Wire();
  const a: Fake = {
    playerId: pid, nickname, rank, clanId, clanAccess: clanId ? 3 : 0, access: 0, status: new AccountStatus(),
    connection: { session: { send: (b: Uint8Array) => w.frames.push(b) } }, room: null, last: {},
    durationSince: () => 1e9,
  };
  accounts.set(pid, a);
  wires.set(pid, w);
  social.online.set(pid, a as unknown as Account);
  ctx.set(pid, { player: a as unknown as Account, session: { send: (b) => w.frames.push(b) }, channelOf: () => CHANNEL });
  const c = new ClanWarClient(w);
  clients.set(pid, c);
  const evList: ClanWarEvent[] = [];
  events.set(pid, evList);
  c.on((e) => evList.push(e));
  return a;
}

// ---- pool.query stub: the SQL the team path sends ----
const CLANS: Record<number, object> = {
  7: { id: 7, name: "Alpha", logo: 5, rank: 0, owner_id: "1", name_color: 0, effects: 0 },
  9: { id: 9, name: "Beta", logo: 6, rank: 0, owner_id: "4", name_color: 0, effects: 0 },
};
(pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
  const s = sql.replace(/\s+/g, " ").trim();
  if (/^SELECT \* FROM system_clan WHERE id=/.test(s)) {
    const row = CLANS[Number(params[0])];
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  if (/^SELECT COUNT\(\*\) AS n FROM accounts WHERE clan_id=/.test(s)) {
    return { rows: [{ n: [...accounts.values()].filter((a) => a.clanId === Number(params[0])).length }], rowCount: 1 };
  }
  return { rows: [], rowCount: 1 }; // base_ban_history (no ban), UPDATE accounts
};

// ---- server dispatch: the ops gameServer.ts routes to the team handlers ----
type Route = (c: GameClient, r: PacketReader) => unknown;
const ROUTES: Record<number, Route> = {
  6916: (c) => cw.handleMatchTeamList(c),
  6918: (c, r) => cw.handleCreateTeam(c, r),
  6920: (c, r) => cw.handleJoinTeam(c, r),
  6922: (c) => cw.handleLeaveTeam(c),
  6924: (c, r) => cw.handleChangeOperation(c, r),
  6926: (c, r) => cw.handleChangeMaxPer(c, r),
  6934: (c) => cw.handleCancelMatchmaking(c),
  2384: (c, r) => (cw.isTeamChat(r) ? cw.handleTeamChat(c, r) : undefined),
};
const gameServerSrc = readFileSync(new URL("../../../server/src/game/gameServer.ts", import.meta.url), "utf8");
for (const op of Object.keys(ROUTES)) check(`gameServer routes ${op}`, gameServerSrc.includes(`case ${op}:`));

async function pump(): Promise<void> {
  for (let round = 0; round < 200; round++) {
    let busy = false;
    for (const [pid, w] of wires) {
      while (w.requests.length > 0) {
        busy = true;
        const q = w.requests.shift()!;
        const route = ROUTES[q.op];
        if (!route) throw new Error(`no server route for clan war opcode ${q.op}`);
        await route(ctx.get(pid)! as unknown as GameClient, new PacketReader(q.body));
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
const lastRoster = (pid: bigint) => [...evs(pid)].reverse().find((e) => e.type === "roster");

async function run(): Promise<void> {
  const OWNER = 1n, MEMBER = 2n, OUTSIDER = 3n, OTHER = 4n;
  mk(OWNER, "Dono", 10, 7);
  mk(MEMBER, "Membro", 3, 7);
  mk(OUTSIDER, "Fora", 1, 0);
  mk(OTHER, "Outro", 2, 9);

  const created = await call(() => cli(OWNER).create(8));
  check("create: team 0, squad 0, cap 8, 1 seated", created.ok && created.data?.matchId === 0 && created.data.squad === 0 && created.data.capacity === 8 && created.data.count === 1, J(created));
  check("create: owner status clanMatchId = squad", acc(OWNER).status.clanMatchId === 0);
  check("create: owner gets roster push (1 member)", lastRoster(OWNER)?.type === "roster" && (lastRoster(OWNER) as { roster: { members: unknown[] } }).roster.members.length === 1);

  const list1 = await call(() => cli(OUTSIDER).list());
  check("list: 1 team, total 1, pages 1", list1.ok && list1.data?.teams.length === 1 && list1.data.total === 1 && list1.data.pages === 1, JSON.stringify(list1));

  const joined = await call(() => cli(MEMBER).join(0));
  const j = joined.data;
  check("join: member in seat 1, 2 seated, leader 0, clan Alpha", joined.ok && j?.count === 2 && j.localSeat === 1 && j.leader === 0 && j.clanName === "Alpha" && j.occupied[0] && j.occupied[1], J(joined));
  check("join: owner gets roster push (2 members)", (lastRoster(OWNER) as { roster: { members: unknown[] } } | undefined)?.roster.members.length === 2);

  const foreign = await call(() => cli(OTHER).join(0));
  check("join: other clan refused (etapa B mercenaries)", !foreign.ok && foreign.err === ClanWarErr.FAIL, hex(foreign.err));
  const noClan = await call(() => cli(OUTSIDER).join(0));
  check("join: clanless account NOT_IN_CLAN", !noClan.ok && noClan.err === ClanWarErr.NOT_IN_CLAN, hex(noClan.err));
  const twice = await call(() => cli(OWNER).create(4));
  check("create: already in a team", !twice.ok && twice.err === ClanWarErr.ALREADY_IN_TEAM, hex(twice.err));

  const opBy = await call(() => cli(MEMBER).setOperation("nao pode"));
  check("operation: member refused (leader only)", !opBy.ok && opBy.err === ClanWarErr.FAIL, hex(opBy.err));
  const op = await call(() => cli(OWNER).setOperation("ataque 1"));
  check("operation: leader sets text, member gets 6925 push", op.ok && op.data === "ataque 1" && evs(MEMBER).some((e) => e.type === "operation" && e.text === "ataque 1"));

  const tooSmall = await call(() => cli(OWNER).setMaxPer(1));
  check("max per: 1 refused while 2 seated", !tooSmall.ok && tooSmall.err === ClanWarErr.FAIL, hex(tooSmall.err));
  const maxByMember = await call(() => cli(MEMBER).setMaxPer(4));
  check("max per: member refused", !maxByMember.ok);

  const left = await call(() => cli(MEMBER).leave());
  check("leave: member, team stays, leader kept, left seat 1", left.ok && left.data?.disbanded === false && left.data.leftSeat === 1 && left.data.leaderSeat === 0, J(left));
  check("leave: owner gets roster push (1 member)", (lastRoster(OWNER) as { roster: { members: unknown[] } } | undefined)?.roster.members.length === 1);

  const max1 = await call(() => cli(OWNER).setMaxPer(1));
  check("max per: leader sets 1 with 1 seated", max1.ok && max1.data === 1, hex(max1.err));
  const full = await call(() => cli(MEMBER).join(0));
  check("join: full at max 1", !full.ok && full.err === ClanWarErr.FAIL, hex(full.err));

  await call(async () => { cli(OWNER).teamChat("oi time"); });
  check("team chat: owner gets type 7 echo", evs(OWNER).some((e) => e.type === "team-chat" && e.msg.text === "oi time" && e.msg.nick === "Dono" && e.msg.chatType === 0));
  check("team chat: outsider gets nothing", !evs(OUTSIDER).some((e) => e.type === "team-chat"));

  const cancelIdle = await call(() => cli(OWNER).cancelMatchmaking());
  check("cancel: not queued -> FAIL", !cancelIdle.ok && cancelIdle.err === ClanWarErr.FAIL, hex(cancelIdle.err));
  const team = cw.teamOf(acc(OWNER))!;
  cw.enqueueTeam(team);
  const cancelQ = await call(() => cli(OWNER).cancelMatchmaking());
  check("cancel: queued team leaves the queue", cancelQ.ok && !team.inQueue && cw.queueOf(CHANNEL).length === 0, hex(cancelQ.err));

  await call(async () => { social.send(acc(OWNER), cw.matchTeamInfoAck([team], () => ({ kills: 4, deaths: 2 }))); });
  const mi = evs(OWNER).find((e) => e.type === "match-info");
  check("match info: seat 0 row with kills/deaths, team Alpha squad 0", mi?.type === "match-info" && mi.info.rows.length === 1 && mi.info.rows[0].seat === 0 && mi.info.rows[0].kills === 4 && mi.info.rows[0].deaths === 2 && mi.info.teams[0].clanName === "Alpha" && mi.info.teams[0].squad === 0 && mi.info.teams[0].clanId === 7, J(mi));

  const solo = await call(() => cli(OWNER).leave());
  check("leave: last member disbands (leader -1)", solo.ok && solo.data?.disbanded === true && solo.data.leftSeat === 0 && solo.data.leaderSeat === -1, J(solo));
  const gone = await call(() => cli(OUTSIDER).list());
  check("list: empty after disband", gone.ok && gone.data?.total === 0 && gone.data.teams.length === 0);

  const again = await call(() => cli(MEMBER).create(8));
  check("create again by member: squad 0 reused", again.ok && again.data?.squad === 0, hex(again.err));
  await call(async () => { await cw.dropTeamOf(acc(MEMBER)); });
  check("drop (logout/exit): team removed, status cleared", cw.teamOf(acc(MEMBER)) === null && acc(MEMBER).status.clanMatchId === 255);

  const bad = await call(() => cli(MEMBER).create(9));
  check("create: capacity 9 refused", !bad.ok && bad.err === ClanWarErr.FAIL, hex(bad.err));

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exitCode = 1;
}

run().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error("FAIL abort:", e); process.exit(1); });
