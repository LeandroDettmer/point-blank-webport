// Player reports. Port of PROTOCOL_COMMUNITY_USER_REPORT_CONDITION_CHECK_REQ (3852 -> 3853) and
// PROTOCOL_COMMUNITY_USER_REPORT_REQ (3850 -> 3851) on the EXISTING tables player_reports (ticket_count, reported_count) and base_report_history
// (no new table or column). Changes from the C#:
//   - tickets: 3 per 24 h [RECRIADO]. The C# counter never refills; here a ticket is "used" for 24 h after the row it made in base_report_history,
//     so the remaining count is derived from that table and player_reports.ticket_count just mirrors it
//   - minimum rank PB_REPORT_MIN_RANK (default 3 [RECRIADO]; the original is 7, 0x80001E69)
//   - the same target is not reported twice by the same player in one match (in a room), nor twice in 24 h outside a room; self and GMs are ignored
//   - 3 distinct "chat" reporters in 24 h on one target = automatic 30 min mute + notice to the GMs online [RECRIADO]; "hack" never punishes alone
// The chat context shown to the GMs comes from the in-memory ring of the room (chatGuard.ts): never stored.
// base_report_history.type keeps the original ReportType bits: 2 IllegalSoftware (hack), 4 InsultingOthers (chat), 6 both.
import { PacketReader, PacketWriter } from "../../../src/net/packet.ts";
import { config } from "../config.ts";
import { pool } from "../db.ts";
import type { Account } from "../shared/account.ts";
import { convertDate, fmtDate, nowNum } from "../shared/time.ts";
import { battleEndHooks, type RoomModel } from "./roomModel.ts";
import { cleanChatText, ringLines } from "./chatGuard.ts";
import { roomOf } from "./voteCommon.ts";
import { serverReply, social } from "./socialHandlers.ts";
import type { GameClient } from "./gameServer.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} [report-ts] ${m}`);

export const REPORT_ERR = {
  noTickets: 0x80001e68, // 2147487976
  rank: 0x80001e69, // 2147487977
  fail: 0x80000000,
  /** [RECRIADO] already reported this player in this match */
  duplicate: 0x80001e6a,
} as const;
export const REPORT_TYPE = { hack: 2, chat: 4 } as const;
export const AUTO_MUTE_REPORTERS = 3;
export const AUTO_MUTE_MINUTES = 30;
const DAY_MS = 86400000;
const since24h = () => nowNum("yyMMddHHmm", new Date(Date.now() - DAY_MS));

export interface ReportKinds { chat: boolean; hack: boolean }
/**
 * Report type of the wire. The web client sends 0 = chat, 1 = hack [INFERIDO]; the original client sent the ReportType bits (2 hack,
 * 4 chat, 6 both): both are accepted. null = unknown.
 */
export function kindsOfWire(w: number): ReportKinds | null {
  if (w === 0) return { chat: true, hack: false };
  if (w === 1) return { chat: false, hack: true };
  if (w === 2 || w === 4 || w === 6) return { chat: (w & 4) !== 0, hack: (w & 2) !== 0 };
  return null;
}
export const dbType = (k: ReportKinds): number => (k.hack ? REPORT_TYPE.hack : 0) | (k.chat ? REPORT_TYPE.chat : 0);

/** "player:target" pairs already reported in the running match of a room (cleared with the match). */
const reportedInRoom = new WeakMap<RoomModel, Set<string>>();
battleEndHooks.push((r) => { reportedInRoom.delete(r); });

/** Tickets left: REPORT_TICKETS minus the reports sent in the last 24 h. Mirrors the value into player_reports.ticket_count. */
export async function ticketsLeft(p: Account): Promise<number> {
  const used = Number((await pool.query(`SELECT count(*) AS n FROM base_report_history WHERE sender_id=$1 AND date >= $2`, [String(p.playerId), since24h()])).rows[0].n);
  const left = Math.max(0, config.reportTickets - used);
  if (p.report.ticketCount !== left) {
    p.report.ticketCount = left;
    await pool.query(`UPDATE player_reports SET ticket_count=$1 WHERE owner_id=$2`, [left, String(p.playerId)]).catch(() => undefined);
  }
  return left;
}

export const lowRank = (p: Account): boolean => p.rank < config.reportMinRank && !p.isGM();

export interface ReportResult { err: number; /** the wire / reply was OK but nothing was stored (self, GM) */ ignored?: boolean; left?: number }

/** Records a report of <p> against <target>. Does every check; the callers only translate the result. */
export async function submitReport(p: Account, target: Account, kinds: ReportKinds, detailRaw: string): Promise<ReportResult> {
  if (!kinds.chat && !kinds.hack) return { err: REPORT_ERR.fail };
  if (lowRank(p)) return { err: REPORT_ERR.rank };
  const left = await ticketsLeft(p);
  if (left <= 0) return { err: REPORT_ERR.noTickets };
  if (target.playerId === p.playerId || target.isGM()) return { err: 0, ignored: true, left };
  const room = roomOf(p);
  const pair = `${p.playerId}:${target.playerId}`;
  if (room) {
    if (reportedInRoom.get(room)?.has(pair)) return { err: REPORT_ERR.duplicate, left };
  } else {
    const d = await pool.query(`SELECT 1 FROM base_report_history WHERE sender_id=$1 AND owner_id=$2 AND date >= $3 LIMIT 1`, [String(p.playerId), String(target.playerId), since24h()]);
    if (d.rowCount) return { err: REPORT_ERR.duplicate, left };
  }
  const detail = cleanChatText(detailRaw).slice(0, 255);
  try {
    await pool.query(`INSERT INTO base_report_history(date, owner_id, owner_nick, sender_id, sender_nick, type, message) VALUES($1, $2, $3, $4, $5, $6, $7)`,
      [nowNum("yyMMddHHmm"), String(target.playerId), target.nickname.slice(0, 32), String(p.playerId), p.nickname.slice(0, 32), dbType(kinds), detail]);
  } catch (e) { log(`insert failed: ${(e as Error).message}`); return { err: REPORT_ERR.fail, left }; }
  if (room) { let s = reportedInRoom.get(room); if (!s) reportedInRoom.set(room, (s = new Set())); s.add(pair); }
  p.report.ticketCount = left - 1;
  target.report.reportedCount++;
  await pool.query(`UPDATE player_reports SET ticket_count=$1 WHERE owner_id=$2`, [left - 1, String(p.playerId)]).catch(() => undefined);
  await pool.query(`UPDATE player_reports SET reported_count=reported_count+1 WHERE owner_id=$1`, [String(target.playerId)]).catch(() => undefined);
  log(`${p.nickname} reported ${target.nickname} (${kinds.chat ? "chat" : ""}${kinds.chat && kinds.hack ? "+" : ""}${kinds.hack ? "hack" : ""}): ${detail}`);
  notifyGMs(p, target, kinds, detail, room);
  if (kinds.chat) await maybeAutoMute(target);
  return { err: 0, left: left - 1 };
}

/** The GMs online get the report, plus the last chat lines of the room when the report was made in one. Memory only. */
function notifyGMs(p: Account, target: Account, kinds: ReportKinds, detail: string, room: RoomModel | null): void {
  const gms = [...social.online.values()].filter((a) => a.isGM());
  if (gms.length === 0) return;
  const lines = [`[DENUNCIA] ${p.nickname} -> ${target.nickname} (${[kinds.chat ? "chat" : "", kinds.hack ? "hack" : ""].filter(Boolean).join("+")})${detail ? `: ${detail}` : ""}`];
  if (room) {
    for (const l of ringLines(room, 12)) lines.push(`  ${fmtDate(new Date(l.t), "HH:mm:ss")} ${l.nick === target.nickname ? ">>" : "  "} ${l.nick}: ${l.text}`);
  }
  for (const g of gms) for (const t of lines) serverReply(g, t);
}

// ---- mute --------------------------------------------------------------------------------------------------------------

/** True while the account has an active MUTE row in base_ban_history (the mechanism banState reads). */
export async function isMuted(pid: bigint): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM base_ban_history WHERE (owner_id=$1 OR player_id=$1) AND type='MUTE' AND expire_date > $2 LIMIT 1`, [String(pid), new Date()]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Mutes an account for <minutes> (base_ban_history type MUTE, like PROTOCOL_GMCHAT_APPLY_PENALTY_ACK; accounts.ban_object_id is left alone: the
 * C# sets it and Auth then refuses the login of a muted player). minutes <= 0 lifts the active mutes. Returns the row id (0n = lifted).
 */
export async function applyMute(pid: bigint, minutes: number, reason: string): Promise<bigint> {
  if (minutes <= 0) {
    await pool.query(`UPDATE base_ban_history SET expire_date=$2 WHERE (owner_id=$1 OR player_id=$1) AND type='MUTE' AND expire_date > $2`, [String(pid), new Date()]);
    return 0n;
  }
  const r = await pool.query(`INSERT INTO base_ban_history(owner_id, player_id, type, value, reason, start_date, expire_date) VALUES($1, $1, 'MUTE', $2, $3, $4, $5) RETURNING object_id`,
    [String(pid), String(pid), reason.slice(0, 255), new Date(), new Date(Date.now() + minutes * 60000)]);
  return BigInt(r.rows[0].object_id);
}

async function maybeAutoMute(target: Account): Promise<void> {
  const r = await pool.query(`SELECT count(DISTINCT sender_id) AS n FROM base_report_history WHERE owner_id=$1 AND (type & $2) = $2 AND date >= $3`, [String(target.playerId), REPORT_TYPE.chat, since24h()]);
  if (Number(r.rows[0].n) < AUTO_MUTE_REPORTERS || (await isMuted(target.playerId))) return;
  await applyMute(target.playerId, AUTO_MUTE_MINUTES, `Auto: ${AUTO_MUTE_REPORTERS} chat reports in 24 h`);
  serverReply(target, `Você foi silenciado por ${AUTO_MUTE_MINUTES} minutos após denúncias de chat de vários jogadores.`);
  for (const g of social.online.values()) if (g.isGM()) serverReply(g, `[DENUNCIA] ${target.nickname} silenciado ${AUTO_MUTE_MINUTES} min (${AUTO_MUTE_REPORTERS} denunciantes de chat em 24 h).`);
  log(`auto mute ${AUTO_MUTE_MINUTES} min: ${target.nickname}`);
}

// ---- packets ---------------------------------------------------------------------------------------------------------

/** REQ 3852 -> ACK 3853 {H 0, C canReport, D err}. The C# answers err 0 + the ticket flag; the rank error is added here (the C# only checks it on 3850). */
export async function handleReportCondition(c: GameClient): Promise<void> {
  const p = c.player;
  if (!p) return;
  const err = lowRank(p) ? REPORT_ERR.rank : 0;
  const can = err === 0 && (await ticketsLeft(p)) > 0;
  c.session.send(new PacketWriter(16).writeH(3853).writeH(0).writeC(can ? 1 : 0).writeD(err).toBytes());
}

/** REQ 3850 {C n, U detail(n), C type, C m, U nick(m)} -> ACK 3851 {H 0, D err}. */
export async function handleReport(c: GameClient, rd: PacketReader): Promise<void> {
  const detail = rd.readU(rd.readC() * 2), wire = rd.readC(), nick = rd.readU(rd.readC() * 2);
  const p = c.player;
  if (!p) return;
  const ack = (err: number) => c.session.send(new PacketWriter(16).writeH(3851).writeH(0).writeD(err).toBytes());
  const kinds = kindsOfWire(wire);
  const target = nick && p.nickname ? await social.byNick(nick) : null;
  if (!kinds || !target) return ack(REPORT_ERR.fail);
  ack((await submitReport(p, target, kinds, detail)).err);
}

// ---- GM: :reports ----------------------------------------------------------------------------------------------------

/** `:reports [nick]`: the last reports (of or against a nick), newest first. */
export async function reportsSummary(nick?: string, n = 10): Promise<string> {
  const q = nick
    ? await pool.query(`SELECT * FROM base_report_history WHERE lower(owner_nick)=lower($1) OR lower(sender_nick)=lower($1) ORDER BY object_id DESC LIMIT $2`, [nick, n])
    : await pool.query(`SELECT * FROM base_report_history ORDER BY object_id DESC LIMIT $1`, [n]);
  if (q.rows.length === 0) return nick ? `No reports for '${nick}'.` : "No reports.";
  const out = [`Reports${nick ? ` of '${nick}'` : ""} (last ${q.rows.length}):`];
  for (const x of q.rows) {
    const t = Number(x.type), kind = [(t & REPORT_TYPE.chat) ? "chat" : "", (t & REPORT_TYPE.hack) ? "hack" : ""].filter(Boolean).join("+") || "?";
    out.push(`#${x.object_id} ${fmtDate(convertDate(String(x.date)), "dd/MM HH:mm")} ${x.owner_nick} <- ${x.sender_nick} [${kind}] ${x.message}`);
  }
  const counts = await pool.query(`SELECT owner_nick, count(DISTINCT sender_id) AS n FROM base_report_history WHERE date >= $1 GROUP BY owner_nick ORDER BY n DESC LIMIT 3`, [since24h()]);
  if (counts.rows.length) out.push(`24 h: ${counts.rows.map((x) => `${x.owner_nick} (${x.n})`).join(", ")}`);
  return out.join("\n");
}
