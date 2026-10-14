// Reports (reports.ts) and bug reports (bugReports.ts). The pure parts run anywhere; the rest needs the local Postgres (docker pb-postgres-local,
// DB pb, loaded) and is skipped without it. It writes only rows of the fake ids 9100000001+ and removes them at the end.
//   node --test test/reportsBugs.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db.ts";
import { BUG_ERR, parseBugReport, saveBugReport } from "../src/game/bugReports.ts";
import { AUTO_MUTE_REPORTERS, REPORT_ERR, REPORT_TYPE, applyMute, isMuted, kindsOfWire, reportsSummary, submitReport, ticketsLeft } from "../src/game/reports.ts";
import { social } from "../src/game/socialHandlers.ts";
import { banState } from "../src/game/socialHandlers.ts";
import { battleEndHooks } from "../src/game/roomModel.ts";
import { battleRoom, fakeAccount, chatText, manualClock, type Sent } from "./fakeRoom.ts";
import { ringPush } from "../src/game/chatGuard.ts";

const BASE = 9100000000;
let db = false;
before(async () => {
  manualClock();
  try { await pool.query("SELECT 1 FROM bug_reports LIMIT 1"); db = true; } catch { db = false; }
  if (db) await clean();
});
async function clean() {
  await pool.query(`DELETE FROM base_report_history WHERE sender_id > $1 OR owner_id > $1`, [BASE]);
  await pool.query(`DELETE FROM base_ban_history WHERE owner_id > $1`, [BASE]);
  await pool.query(`DELETE FROM bug_reports WHERE account_id > $1`, [BASE]);
}
after(async () => { if (db) await clean(); await pool.end(); });

test("parseBugReport: limits, JSON object only, known fields to columns, the rest to extra", () => {
  assert.equal(parseBugReport("", "{}"), null);
  assert.equal(parseBugReport("x".repeat(1001), "{}"), null);
  assert.equal(parseBugReport("ok", "{" + "\"a\":1,".repeat(1000) + "\"z\":1}"), null, "meta over 4000 chars");
  assert.equal(parseBugReport("ok", "not json"), null);
  assert.equal(parseBugReport("ok", "[1,2]"), null);
  assert.equal(parseBugReport("ok", "null"), null);
  assert.equal(parseBugReport("ok", "\"str\""), null);
  const r = parseBugReport("  a\u0000b\nlinha 2  ", JSON.stringify({
    build: "abc123", userAgent: "UA", fps: 58.6, ping: "41", p2pRole: "host", mode: "tdm", map: "Hotel",
    lastErrors: Array.from({ length: 30 }, (_, i) => `err${i}`), weapons: ["k2"], slot: 3,
  }))!;
  assert.equal(r.text, "ab\nlinha 2");
  assert.deepEqual([r.client_build, r.user_agent, r.fps, r.ping, r.p2p_role, r.mode, r.map], ["abc123", "UA", 59, 41, "host", "tdm", "Hotel"]);
  assert.equal(r.last_errors!.length, 20);
  assert.equal(r.last_errors!.at(-1), "err29");
  assert.deepEqual(r.extra, { weapons: ["k2"], slot: 3 });
  assert.equal(parseBugReport("ok", "")!.extra, null, "empty meta is fine");
});

test("kindsOfWire: 0 chat / 1 hack (web) and the original ReportType bits", () => {
  assert.deepEqual(kindsOfWire(0), { chat: true, hack: false });
  assert.deepEqual(kindsOfWire(1), { chat: false, hack: true });
  assert.deepEqual(kindsOfWire(2), { chat: false, hack: true });
  assert.deepEqual(kindsOfWire(4), { chat: true, hack: false });
  assert.deepEqual(kindsOfWire(6), { chat: true, hack: true });
  assert.equal(kindsOfWire(3), null);
});

test("bug report: saved with columns, then 3 per hour per account", async (t) => {
  if (!db) return t.skip("no Postgres");
  const sent: Sent[] = [];
  const p = fakeAccount(BASE + 1, "BugMan", sent);
  const meta = JSON.stringify({ build: "b1", fps: 60, ping: 30, p2pRole: "guest", lastErrors: ["boom"], extraField: true });
  const a = await saveBugReport(p, "tela preta ao respawnar", meta);
  assert.equal(a.err, 0);
  assert.ok(a.id > 0);
  const row = (await pool.query(`SELECT * FROM bug_reports WHERE id=$1`, [a.id])).rows[0];
  assert.equal(String(row.account_id), String(BASE + 1));
  assert.equal(row.nick, "BugMan");
  assert.equal(row.client_build, "b1");
  assert.equal(row.fps, 60);
  assert.equal(row.p2p_role, "guest");
  assert.deepEqual(row.last_errors, ["boom"]);
  assert.deepEqual(row.extra, { extraField: true });
  assert.equal((await saveBugReport(p, "dois", "{}")).err, 0);
  assert.equal((await saveBugReport(p, "tres", "{}")).err, 0);
  assert.equal((await saveBugReport(p, "quatro", "{}")).err, BUG_ERR.limit);
  assert.equal((await saveBugReport(fakeAccount(BASE + 2, "Outro", sent), "meu", "{}")).err, 0, "the limit is per account");
  assert.equal((await saveBugReport(fakeAccount(BASE + 3, "Ruim", sent), "meu", "[]")).err, BUG_ERR.fail);
});

test("report: tickets (3 / 24 h), rank, self and GM ignored, one per target per match, evidence only to GMs, auto-mute at 3 chat reporters", async (t) => {
  if (!db) return t.skip("no Postgres");
  const f = battleRoom(4);
  const [rep1, rep2, rep3, target] = f.accounts;
  const pids = [BASE + 11, BASE + 12, BASE + 13, BASE + 14];
  f.accounts.forEach((a, i) => { (a as unknown as { playerId: bigint }).playerId = BigInt(pids[i]); f.room.slots[i].playerId = BigInt(pids[i]); });
  rep1.nickname = "Rep1"; rep2.nickname = "Rep2"; rep3.nickname = "Rep3"; target.nickname = "Alvo";
  const gm = fakeAccount(BASE + 15, "Moderador", f.sent, { gm: true });
  gm.nickname = "Moderador";
  social.online = new Map([...f.accounts, gm].map((a) => [a.playerId, a]));
  ringPush(f.room, { t: Date.now(), slot: 3, nick: "Alvo", type: 1, text: "voce e horrivel" });
  ringPush(f.room, { t: Date.now(), slot: 0, nick: "Rep1", type: 1, text: "calma" });
  const chat = { chat: true, hack: false }, hack = { chat: false, hack: true };

  assert.equal((await ticketsLeft(rep1)), 3);
  const low = fakeAccount(BASE + 16, "Novato", f.sent, { rank: 1 });
  assert.equal((await submitReport(low, target, chat, "x")).err, REPORT_ERR.rank);
  assert.deepEqual(await submitReport(rep1, rep1, chat, "x"), { err: 0, ignored: true, left: 3 }, "self is ignored, no ticket used");
  assert.equal((await submitReport(rep1, gm, chat, "x")).ignored, true, "a GM is ignored");
  f.clear();
  const r1 = await submitReport(rep1, target, chat, "ofendeu todo mundo");
  assert.deepEqual([r1.err, r1.left], [0, 2]);
  const gmLines = f.sent.filter((s) => s.op === 2571 && s.to === gm.playerId).map((s) => chatText(s.bytes));
  assert.match(gmLines[0], /\[DENUNCIA\] Rep1 -> Alvo \(chat\): ofendeu todo mundo/);
  assert.equal(gmLines.some((l) => /Alvo: voce e horrivel/.test(l) && />>/.test(l)), true, "chat context from the in-memory ring");
  assert.equal(f.sent.filter((s) => s.op === 2571 && s.to !== gm.playerId).length, 0, "nobody else is told");
  assert.equal((await submitReport(rep1, target, hack, "x")).err, REPORT_ERR.duplicate, "same target twice in the match");
  for (const h of battleEndHooks) h(f.room); // match over
  const again = await submitReport(rep1, target, hack, "usa wallhack");
  assert.deepEqual([again.err, again.left], [0, 1]);
  assert.equal((await submitReport(rep1, target, chat, "")).err, 0 + REPORT_ERR.duplicate, "...and again in the new match, no: dedupe resets only with the match");
  const row = (await pool.query(`SELECT type, message, owner_nick, sender_nick FROM base_report_history WHERE sender_id=$1 ORDER BY object_id`, [String(pids[0])])).rows;
  assert.deepEqual(row.map((x) => x.type), [REPORT_TYPE.chat, REPORT_TYPE.hack]);
  assert.equal(row[0].owner_nick, "Alvo");
  assert.equal(await isMuted(target.playerId), false, "hack never mutes, one chat reporter is not enough");
  // a third ticket, then the other reporters
  assert.equal((await submitReport(rep2, target, chat, "spam")).err, 0);
  assert.equal(await isMuted(target.playerId), false, `${AUTO_MUTE_REPORTERS - 1} distinct chat reporters`);
  f.clear();
  assert.equal((await submitReport(rep3, target, chat, "insulto")).err, 0);
  assert.equal(await isMuted(target.playerId), true, "3 distinct chat reporters in 24 h = mute");
  assert.equal(await banState(target), "mute", "the mechanism the chat handler reads");
  assert.match(f.sent.filter((s) => s.op === 2571 && s.to === 103n /* the fake records the id it was built with */).map((s) => chatText(s.bytes)).join("|"), /silenciado por 30 minutos/);
  // the row is a MUTE of ~30 min, not a login ban
  const m = (await pool.query(`SELECT type, expire_date - start_date AS d FROM base_ban_history WHERE owner_id=$1`, [String(pids[3])])).rows;
  assert.equal(m.length, 1);
  assert.equal(m[0].type, "MUTE");
  assert.equal(m[0].d.minutes, 30);
  // tickets are used up after 3 reports within 24 h: rep1 made 2 so far
  assert.equal((await submitReport(rep1, rep2, chat, "um")).err, 0);
  assert.equal((await submitReport(rep1, rep3, chat, "dois")).err, REPORT_ERR.noTickets);
  assert.match(await reportsSummary("Alvo"), /Alvo <- Rep1 \[chat\] ofendeu todo mundo/);
  assert.match(await reportsSummary(), /Reports \(last/);
  // :mute lifting
  await applyMute(target.playerId, 0, "");
  assert.equal(await isMuted(target.playerId), false);
});
