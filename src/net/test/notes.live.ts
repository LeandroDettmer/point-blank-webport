// Live check of the Cross Msg. tab (recados, noteClient.ts / pages/notes.ts) against the real server (Docker + server), no
// browser. Accounts: A (clan owner), B (accepts a clan invite), C (refuses one), D (receives 26 notes for the inbox size check).
//   A -> B note by nick (1921 -> 1922 0, B gets 1931), B reads it (1926 -> 1927), B replies by uid (1930, A gets 1931),
//   send to a nick that does not exist (1922 0x8000107e), A creates a clan (806), invites B and C (2426 find + 888),
//   B accepts and C refuses (answerClanNote: 890, then 1926 -> 1927; no 1928: the exe keeps the answered invite),
//   A -> B note of 240 characters (the exe's text limit, 1922 0), A -> D 26 notes, then A logs in again and fetchAuthMeta pulls
//   the list (2320 -> 1925): the reply, the clan notes (clanNote 4 join / 5 denial), the days left (14..15 for a note sent now),
//   the newest-first order (newestFirst: the denial comes first) and D gets all 26 notes (the 1925 count byte = headers sent).
//   B deletes its three notes in one batch (1928 -> 1929 0, count 3) and its list is empty.
// A and B log in on different game servers (--server-a 1, --server-b 2 by default; 3 is the clan server: B then needs a clan row,
// set in the DB here, and the clan invite step fails because B is already in a clan).
// Usage (stack up: npm run dev:all): node --experimental-transform-types src/net/test/notes.live.ts [--gw ws://127.0.0.1:8090] [--api http://127.0.0.1:8090]
// Exit 0 = pass.
import { execSync } from "node:child_process";
import { AuthClient, gameTargetForServer } from "../authClient.ts";
import { ClanClient } from "../clanClient.ts";
import { GameClient } from "../gameClient.ts";
import { collectEnterPushes } from "../metaGame.ts";
import { fetchAuthMeta } from "../metaAuth.ts";
import { NoteErr, NoteList, NoteOp, NoteState, answerClanNote, deleteNotes, isClanAsk, newestFirst, noteList, readNotes, replyNote, sendNote, type Note } from "../noteClient.ts";
import type { PbConnection } from "../connection.ts";
import { PacketWriter } from "../packet.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const GW = arg("--gw", "ws://127.0.0.1:8090");
const API = arg("--api", "http://127.0.0.1:8090");
const t0 = Date.now();
const log = (who: string, msg: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s [${who}] ${msg}`);
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => { results.push({ name, ok, detail }); log(ok ? "PASS" : "FAIL", `${name}: ${detail}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;
// game server index (system_servers id) of A and B: different by default, so the test covers the cross-server path
const SERVER_A = Number(arg("--server-a", "1")), SERVER_B = Number(arg("--server-b", "2"));
const rnd = Math.random().toString(36).slice(2, 7);

async function account(username: string): Promise<Uint8Array> {
  const res = await fetch(`${API}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "notes-live-pw1" }) });
  const body = (await res.json()) as { token?: string; error?: string };
  if (res.status !== 201 || !body.token) throw new Error(`register ${username}: ${res.status} ${body.error ?? ""}`);
  return Uint8Array.from(Buffer.from(body.token, "base64"));
}

interface Session { who: string; game: GameClient; nick: string; playerId: bigint; notes: NoteList }

/** one login: Auth (optionally with the meta pushes, 2320 -> 1925) then the Game lobby. The notes list is per session. */
async function enter(who: string, token: Uint8Array, serverIndex: number, withMeta = false): Promise<Session> {
  await sleep(1200); // the auth drops a 2nd login from the same IP within 1 s (authServer.ts handleLogin)
  const auth = new AuthClient(GW);
  const mac = crypto.getRandomValues(new Uint8Array(6));
  mac[0] = (mac[0] & 0xfe) | 2;
  const login = await auth.connectAndLogin({ token, mac });
  if (!login.ok) throw new Error(`${who}: login ${login.errorName}`);
  const servers = await auth.getServers();
  const server = servers.find((s) => s.index === serverIndex);
  if (!server) throw new Error(`${who}: server ${serverIndex} not in the Auth list (${servers.map((s) => s.index).join(",")})`);
  if (withMeta) { await fetchAuthMeta(auth.conn); }
  await auth.leave();
  const game = new GameClient(gameTargetForServer(server), GW);
  let pushes: Promise<unknown> | null = null;
  const connect = game.conn.connect.bind(game.conn);
  game.conn.connect = async (...a) => { const i = await connect(...a); pushes = collectEnterPushes(game.conn).done; return i; };
  await game.enter(login.username, login.playerId, server.index);
  await pushes!;
  await game.selectChannel(0);
  await game.enterLobby();
  const notes = new NoteList();
  notes.attach(game.conn);
  log(who, `in lobby as ${login.username}`);
  return { who, game, nick: login.username, playerId: login.playerId, notes };
}

/** waits until `fn` is true (the pushes arrive after the request's ack) */
async function until(fn: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(50); }
  return fn();
}

/** the 1927 ack of a 1926 read: the ids the server confirms (armed before the request is sent) */
const readAcks = (conn: PbConnection): Promise<number[]> => conn.waitFor(NoteOp.READ_ACK, 5000).then((r): number[] => { const n = r.readC(); const ids: number[] = []; for (let i = 0; i < n; i++) ids.push(r.readD()); return ids; }, (): number[] => []);

const byText = (l: Note[], text: string) => l.find((n) => n.text === text);

async function main(): Promise<void> {
  const nA = `na${rnd}`, nB = `nb${rnd}`, nC = `nc${rnd}`, nD = `nd${rnd}`;
  const tokA = await account(nA), tokB = await account(nB), tokC = await account(nC), tokD = await account(nD);
  // creating a clan needs rank 4 and 25000 gold (Settings.ini MinCreateRank / MinCreateGold); new accounts are rank 0. The rank is
  // set in the local Postgres before A logs in (the server loads it at login). Gold of a new account is 100000.
  execSync(`docker exec pb-postgres-local psql -U postgres -d pb -q -c "UPDATE accounts SET rank=4 WHERE nickname='${nA}'"`);
  // the clan server (channels of type Clan) lets in only an account with a clan (CHANNEL_REQUIREMENT): give B any clan row first
  if (SERVER_B === 3) execSync(`docker exec pb-postgres-local psql -U postgres -d pb -q -c "UPDATE accounts SET clan_id=(SELECT max(id) FROM system_clan) WHERE nickname='${nB}'"`);
  // B logs in on the other game server: the note, reply and clan-invite pushes must cross servers
  const A = await enter("A", tokA, SERVER_A);
  const B = await enter("B", tokB, SERVER_B);
  const C = await enter("C", tokC, SERVER_A);

  // 1. A -> B by nick
  const sent = await sendNote(A.game.conn, B.nick, "oi");
  check("send 1921 -> 1922", sent === 0, `err ${hex(sent)} (want 0)`);
  check("B gets 1931", await until(() => !!byText(B.notes.list, "oi")), `B list ${B.notes.list.length} note(s)`);
  const m1 = byText(B.notes.list, "oi");
  check("note fields (1931)", !!m1 && m1.sender === A.nick && m1.state === NoteState.UNREAD && !isClanAsk(m1.type), `sender ${m1?.sender} state ${m1?.state} type ${m1?.type}`);

  // 2. B reads (1926 -> 1927)
  const ack2 = readAcks(B.game.conn);
  readNotes(B.game.conn, [m1!.id]);
  const acked = await ack2;
  check("read 1926 -> 1927", acked.includes(m1!.id), `acked ids ${acked.join(",") || "none"}`);

  // 3. B replies by uid (1930 -> 1922 0), A gets the reply
  const rep = await replyNote(B.game.conn, A.playerId, "resp");
  check("reply 1930 -> 1922", rep === 0, `err ${hex(rep)} (want 0)`);
  check("A gets the reply (1931)", await until(() => !!byText(A.notes.list, "resp")), `A list ${A.notes.list.length} note(s)`);
  const mr = byText(A.notes.list, "resp");
  check("reply sender is B", !!mr && mr.sender === B.nick, `sender ${mr?.sender}`);

  // 4. unknown nick
  const nf = await sendNote(A.game.conn, `zz${rnd}none`, "x");
  check("unknown nick -> 0x8000107e", nf === NoteErr.NOT_FOUND, `err ${hex(nf)}`);

  // 5. clan: A creates, invites B (find 2426 then invite 888)
  const clanA = new ClanClient(A.game.conn);
  // the server refuses emblem 0 and an emblem another clan has (0x80000000): a random one from the picker's range
  const cr = await clanA.create(`Cl${rnd}`, "notes live", 1000 + Math.floor(Math.random() * 50000));
  check("A creates a clan (806)", cr.ok && !!cr.data, `err ${hex(cr.err)}`);
  const clanId = cr.data!.id;
  // the inviter looks the target up by nick (2426 sets the server's findPlayer, which the invite 888 reads)
  const find = (from: Session, target: Session) => { from.game.conn.send(2426, new PacketWriter(66).writeU(target.nick, 66)); };
  find(A, B); await sleep(1100);
  const invB = await clanA.invite();
  check("A invites B (888)", invB.ok, `err ${hex(invB.err)}`);
  check("B gets the clan invite (1931 type ClanAsk)", await until(() => B.notes.list.some((n) => isClanAsk(n.type))), `B list ${B.notes.list.length}`);
  const ask = B.notes.list.find((n) => isClanAsk(n.type));
  check("invite fields", !!ask && ask.clanId === clanId && ask.clanNote === 1 && ask.state === NoteState.UNREAD, `clanId ${ask?.clanId} (want ${clanId}) clanNote ${ask?.clanNote} (want 1) state ${ask?.state} sender ${ask?.sender}`);

  // 6. B accepts (890), then 1926 marks the invite read; the exe sends no 1928, so no delete ack comes
  const ack6 = readAcks(B.game.conn);
  const gotDel6 = B.game.conn.waitFor(NoteOp.DELETE_ACK, 1500).then(() => true, () => false);
  const accB = await answerClanNote(B.game.conn, ask!, true);
  check("B accepts the invite (890)", accB.ok, `err ${hex(accB.err)}`);
  check("B's answer marks the invite read (1926 -> 1927)", (await ack6).includes(ask!.id), "read ack for the invite id");
  check("B's answered invite is not deleted (no 1929)", !(await gotDel6), "no delete ack");
  B.notes.mark([ask!.id], NoteState.READ, 7);

  // 7. C is invited and refuses (same answer: 890 accept=0, then 1926)
  find(A, C); await sleep(1100);
  const invC = await clanA.invite();
  check("A invites C (888)", invC.ok, `err ${hex(invC.err)}`);
  check("C gets the clan invite", await until(() => C.notes.list.some((n) => isClanAsk(n.type))), `C list ${C.notes.list.length}`);
  const askC = C.notes.list.find((n) => isClanAsk(n.type));
  const ackC = readAcks(C.game.conn);
  const refC = await answerClanNote(C.game.conn, askC!, false);
  check("C refuses the invite (890 accept=0)", refC.ok, `err ${hex(refC.err)}`);
  check("C's refusal marks the invite read (1926 -> 1927)", (await ackC).includes(askC!.id), "read ack for the invite id");

  // 8. the 240-character note (the exe's text limit): accepted by the server
  const long = "x".repeat(240);
  const sLong = await sendNote(A.game.conn, B.nick, long);
  check("send a 240-char note (1922 0)", sLong === 0, `err ${hex(sLong)}`);
  check("B gets the 240-char text intact", await until(() => B.notes.list.some((n) => n.text === long)), "text length 240");

  // 9. D gets 26 notes: the 1925 list must carry all of them (the old cut at 25 broke the count byte)
  const D0 = await enter("D0", tokD, SERVER_A);
  for (let i = 0; i < 26; i++) { const e = await sendNote(A.game.conn, D0.nick, `d${i}`); if (e !== 0) { check("send 26 notes to D", false, `note ${i}: err ${hex(e)}`); break; } }
  D0.game.conn.close();

  // 10. A logs in again: fetchAuthMeta pulls 1925 (2320 GET_OPTION) into the singleton noteList (metaAuth.ts)
  A.game.conn.close();
  noteList.set([]);
  await sleep(3000); // the server still holds A's closed session for a moment: an immediate login gets no 1283 ack
  const A2 = await enter("A2", tokA, SERVER_A, true);
  const got = noteList.list;
  check("1925 list at login has the reply", got.some((n) => n.text === "resp" && n.sender === B.nick), `${got.length} note(s): ${got.map((n) => `${n.sender}/${n.clanNote}/${n.text}`).join(" | ")}`);
  check("1925 clan notes (clanNote 4 join, 5 denial)", got.some((n) => n.clanNote === 4 && n.text === B.nick) && got.some((n) => n.clanNote === 5 && n.text === C.nick), "branch of the clan body");
  check("1925 days left (14..15 for a note sent now)", got.length > 0 && got.every((n) => n.days >= 14 && n.days <= 15), `days ${got.map((n) => n.days).join(",")} (1 = old server without daysLeft)`);
  check("list shown newest first (the denial, sent last)", newestFirst(got)[0]?.clanNote === 5 && newestFirst(got)[0]?.text === C.nick, `first ${newestFirst(got)[0]?.text}`);
  A2.game.conn.close();

  // 11. D's login: the list holds all 26 notes
  const D = await enter("D", tokD, SERVER_A, true);
  check("D's 1925 list holds all 26 notes", noteList.list.length === 26, `D list ${noteList.list.length} (want 26)`);
  D.game.conn.close();

  // 12. B deletes its notes in one batch (1928 -> 1929 0, count 3): the first note, the invite (read) and the 240-char note
  const batch = B.notes.list.map((n) => n.id);
  const delB = await deleteNotes(B.game.conn, batch);
  check(`B deletes ${batch.length} notes in one batch (1928 -> 1929)`, delB === 0 && batch.length === 3, `err ${hex(delB)}, ids ${batch.length}`);
  B.notes.remove(batch);
  check("B's list is empty after the batch", B.notes.list.length === 0, `left ${B.notes.list.length}`);

  for (const s of [B, C]) s.game.conn.close();
  const failed = results.filter((r) => !r.ok);
  log("END", `${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
