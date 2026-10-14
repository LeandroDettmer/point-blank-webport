// Bug reports of the web client, web-only opcode outside the original range [RECRIADO]:
//   REQ 9001 {H len, U text (<= 1000), H metaLen, U metaJson (<= 4000)} -> ACK 9002 {D err, D id}
//   err: 0 ok, 0x80000000 failed (bad size / bad JSON / DB), 0x80002001 limit (3 per hour per account, 60 per hour for the whole server)
// metaJson must be a JSON object. Known keys go to their column, the rest to `extra` (jsonb):
//   roomId|room_id (the server's own room id wins), map|mapName, mode, build|clientBuild|client_build, userAgent|user_agent|ua, ping, fps,
//   p2pRole|p2p_role|role, lastErrors|last_errors|errors (array, last 20 strings of 500 chars).
// Table bug_reports: db/init/001_init.sql. Nothing sensitive is asked for: the client must not send tokens.
import { PacketReader, PacketWriter } from "../../../src/net/packet.ts";
import { pool } from "../db.ts";
import type { Account } from "../shared/account.ts";
import { fmtDate } from "../shared/time.ts";
import { roomOf } from "./voteCommon.ts";
import type { GameClient } from "./gameServer.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} [bug-ts] ${m}`);

export const BUG_ERR = { fail: 0x80000000, limit: 0x80002001 } as const;
export const BUG_MAX_TEXT = 1000;
export const BUG_MAX_META = 4000;
export const BUG_PER_HOUR = 3;

const KNOWN = new Set(["roomId", "room_id", "map", "mapName", "mode", "build", "clientBuild", "client_build", "userAgent", "user_agent", "ua", "ping", "fps", "p2pRole", "p2p_role", "role", "lastErrors", "last_errors", "errors"]);
const str = (v: unknown, max: number): string | null => (typeof v === "string" || typeof v === "number" ? String(v).slice(0, max) || null : null);
const int = (v: unknown): number | null => { const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? Math.max(-2147483648, Math.min(2147483647, Math.round(n))) : null; };
const first = (o: Record<string, unknown>, ...keys: string[]) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };

export interface BugRow {
  text: string; room_id: number | null; map: string | null; mode: string | null; client_build: string | null; user_agent: string | null;
  ping: number | null; fps: number | null; p2p_role: string | null; last_errors: string[] | null; extra: Record<string, unknown> | null;
}

/** Text: control characters out (line breaks and tabs stay), trimmed. */
export const cleanBugText = (s: string): string => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").trim();

/** Validates the pair (text, metaJson) and splits the meta into columns. null = rejected. */
export function parseBugReport(textRaw: string, metaJson: string): BugRow | null {
  const text = cleanBugText(textRaw);
  if (!text || text.length > BUG_MAX_TEXT || metaJson.length > BUG_MAX_META) return null;
  let meta: unknown = {};
  if (metaJson.trim()) { try { meta = JSON.parse(metaJson); } catch { return null; } }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  const errs = first(m, "lastErrors", "last_errors", "errors");
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) if (!KNOWN.has(k)) extra[k] = v;
  return {
    text,
    room_id: int(first(m, "roomId", "room_id")),
    map: str(first(m, "map", "mapName"), 100),
    mode: str(m.mode, 100),
    client_build: str(first(m, "build", "clientBuild", "client_build"), 100),
    user_agent: str(first(m, "userAgent", "user_agent", "ua"), 300),
    ping: int(m.ping),
    fps: int(m.fps),
    p2p_role: str(first(m, "p2pRole", "p2p_role", "role"), 16),
    last_errors: Array.isArray(errs) ? errs.slice(-20).map((e) => String(e).slice(0, 500)) : null,
    extra: Object.keys(extra).length ? extra : null,
  };
}

const busy = new Set<bigint>();

/** All accounts together: at most BUG_GLOBAL_PER_HOUR rows an hour [RECRIADO]. A row is up to ~15 KB and an account costs one /api/register
 *, so the per-account limit alone lets a few hundred fresh accounts fill the free database. Memory only. */
export const BUG_GLOBAL_PER_HOUR = 60;
const HOUR_MS = 3600000;
export const bugBudget = { times: [] as number[], now: (): number => Date.now() };
const globalFull = (): boolean => {
  const t = bugBudget.times, cut = bugBudget.now() - HOUR_MS;
  while (t.length && t[0] <= cut) t.shift();
  return t.length >= BUG_GLOBAL_PER_HOUR;
};

/** Stores a report; returns {err, id}. */
export async function saveBugReport(p: Account, textRaw: string, metaJson: string): Promise<{ err: number; id: number }> {
  const row = parseBugReport(textRaw, metaJson);
  if (!row) return { err: BUG_ERR.fail, id: 0 };
  if (busy.has(p.playerId) || globalFull()) return { err: BUG_ERR.limit, id: 0 };
  const stamp = bugBudget.now();
  bugBudget.times.push(stamp); // taken before the awaits (concurrent sessions cannot all pass the check), given back unless a row is stored
  let stored = false;
  busy.add(p.playerId);
  try {
    const n = Number((await pool.query(`SELECT count(*) AS n FROM bug_reports WHERE account_id=$1 AND created_at > now() - interval '1 hour'`, [String(p.playerId)])).rows[0].n);
    if (n >= BUG_PER_HOUR) return { err: BUG_ERR.limit, id: 0 };
    const room = roomOf(p);
    const r = await pool.query(
      `INSERT INTO bug_reports(account_id, nick, text, room_id, map, mode, client_build, user_agent, ping, fps, p2p_role, last_errors, extra)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb) RETURNING id`,
      [String(p.playerId), p.nickname, row.text, room ? room.roomId : row.room_id, row.map ?? (room ? String(room.mapId) : null), row.mode ?? (room ? String(room.roomType) : null),
        row.client_build, row.user_agent, row.ping, row.fps, row.p2p_role, row.last_errors ? JSON.stringify(row.last_errors) : null, row.extra ? JSON.stringify(row.extra) : null]);
    const id = Number(r.rows[0].id);
    stored = true;
    log(`bug #${id} by ${p.nickname}: ${row.text.slice(0, 80).replace(/\s+/g, " ")}`);
    return { err: 0, id };
  } catch (e) {
    log(`insert failed: ${(e as Error).message}`);
    return { err: BUG_ERR.fail, id: 0 };
  } finally {
    busy.delete(p.playerId);
    if (!stored) { const i = bugBudget.times.lastIndexOf(stamp); if (i >= 0) bugBudget.times.splice(i, 1); }
  }
}

/** REQ 9001. */
export async function handleBugReport(c: GameClient, rd: PacketReader): Promise<void> {
  const p = c.player;
  if (!p) return;
  const ack = (err: number, id: number) => c.session.send(new PacketWriter(16).writeH(9002).writeD(err).writeD(id).toBytes());
  let text = "", meta = "";
  try {
    const len = rd.readH();
    if (len > BUG_MAX_TEXT) return ack(BUG_ERR.fail, 0);
    text = rd.readU(len * 2);
    const metaLen = rd.readH();
    if (metaLen > BUG_MAX_META) return ack(BUG_ERR.fail, 0);
    meta = rd.readU(metaLen * 2);
  } catch { return ack(BUG_ERR.fail, 0); }
  const r = await saveBugReport(p, text, meta);
  ack(r.err, r.id);
}

/** `:bugs [n]` (GM): the last n reports (default 5, max 20), newest first. */
export async function bugsSummary(n = 5): Promise<string> {
  const k = Math.max(1, Math.min(20, n));
  const q = await pool.query(`SELECT id, created_at, nick, text, room_id, map, client_build, ping, fps, p2p_role FROM bug_reports ORDER BY id DESC LIMIT $1`, [k]);
  if (q.rows.length === 0) return "No bug reports.";
  const out = [`Bug reports (last ${q.rows.length}):`];
  for (const x of q.rows) {
    const meta = [x.map && `map ${x.map}`, x.room_id !== null && `room ${x.room_id}`, x.client_build && `build ${x.client_build}`, x.ping !== null && `ping ${x.ping}`, x.fps !== null && `fps ${x.fps}`, x.p2p_role].filter(Boolean).join(" ");
    out.push(`#${x.id} ${fmtDate(new Date(x.created_at), "dd/MM HH:mm")} ${x.nick}${meta ? ` [${meta}]` : ""}: ${String(x.text).replace(/\s+/g, " ").slice(0, 160)}`);
  }
  return out.join("\n");
}

export const BUG_RETENTION_DAYS = 30;

/** Deletes bug_reports older than BUG_RETENTION_DAYS. A failure only logs. */
export async function purgeOldBugReports(): Promise<number> {
  try {
    const r = await pool.query(`DELETE FROM bug_reports WHERE created_at < now() - make_interval(days => $1)`, [BUG_RETENTION_DAYS]);
    if (r.rowCount) log(`purged ${r.rowCount} bug reports older than ${BUG_RETENTION_DAYS} days`);
    return r.rowCount ?? 0;
  } catch (e) { log(`purge failed: ${(e as Error).message}`); return 0; }
}

/** Retention job: once at boot, then every 24 h (timer unref'd, never keeps the process alive). */
export function startBugRetention(): void {
  void purgeOldBugReports();
  setInterval(() => void purgeOldBugReports(), 24 * 3600 * 1000).unref();
}
