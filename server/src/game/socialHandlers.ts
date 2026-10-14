// F5 (Server.Game/Server.Auth ClientPacket ports): chat 2384/1826/1828, friends 1811/1816/1818/1820 (+1810/1815,
// SyncPlayerToFriends), notes 1921/1930/1926/1928 (+1931, Auth 1925), missions 2360/2364/2366/8709/8705/8707/8449/
// clan 769/771/997/999/800/1001/802/804/806/812/814/828/854/918 (+ Auth 845; the other CS_* ops live in clanHandlers.ts), gifts 1041/1043.
// Auth and Game run in one Node process, so the C# cross-server sync (ops 11/13/17...) is a loop over online players.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { PacketWriter, type PacketReader } from "../../../src/net/packet.ts";
import { pool } from "../db.ts";
import { config } from "../config.ts";
import type { Account } from "../shared/account.ts";
import * as dao from "../shared/dao.ts";
import { MISSION_PROGRESS_SIZE, type FriendModel } from "../shared/models.ts";
import { nowNum, fmtDate } from "../shared/time.ts";
import { getGoodByItemId } from "../shared/shop.ts";
import { zlibCompress } from "../shared/shop.ts";
import { questingInfo } from "../auth/metaPackets.ts";
import { seasonChallengeInfoAck } from "../auth/metaPackets.ts";
import { roomOf, stopCountDownBySlot } from "./roomHandlers.ts";
import { SlotState, DeadEnum, type SlotModel } from "./roomModel.ts";
import type { GameClient } from "./gameServer.ts";
import { serverCommands } from "./gmCommands.ts";
import { playerCommands } from "./playerCommands.ts";
import { cleanChatText, filterChatText, floodCheck, loadChatFilter, ringPush } from "./chatGuard.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} [social-ts] ${m}`);
const W = (n = 64) => new PacketWriter(n);
/** WriteN(s, len+2, UTF-16LE): UTF-16 + 00 00 */
export const wstrz = (w: PacketWriter, s: string) => { for (let i = 0; i < s.length; i++) w.writeH(s.charCodeAt(i)); return w.writeH(0); };
const utf16 = (w: PacketWriter, s: string) => { for (let i = 0; i < s.length; i++) w.writeH(s.charCodeAt(i)); return w; };
const pidS = (p: Account) => String(p.playerId);

/** Wired by gameServer.ts (online accounts of every TS server, Auth included). */
export const social = {
  online: new Map<bigint, Account>(),
  send(a: Account | null | undefined, b: Uint8Array): void { (a?.connection as { session?: { send(x: Uint8Array): void } } | null)?.session?.send(b); },
  byNick: async (_n: string): Promise<Account | null> => null,
  byPid: async (_p: bigint): Promise<Account | null> => null,
};

// ---- chat ------------------------------------------------------------------------------------------------------------

export function announce(text: string): Uint8Array {
  const w = W(32 + text.length * 2).writeH(3079).writeH(0).writeD(0).writeH(text.length);
  return utf16(w, text).writeD(2).toBytes();
}
export function lobbyChatAck(sessionId: number, nick: string, nickColor: number, gm: boolean, text: string): Uint8Array {
  const w = W(64 + text.length * 2).writeH(2571).writeD(sessionId).writeC(nick.length + 1);
  wstrz(w, nick).writeC(nickColor).writeC(gm ? 1 : 0).writeH(text.length + 1);
  return wstrz(w, text).toBytes();
}
function roomChatAck(type: number, slot: number, gm: boolean, text: string): Uint8Array {
  const w = W(32 + text.length * 2).writeH(3606).writeH(type).writeD(slot).writeC(gm ? 1 : 0).writeD(text.length + 1);
  return wstrz(w, text).toBytes();
}

export async function banState(p: Account): Promise<"ban" | "mute" | null> {
  if (p.access === -1) return "ban";
  const r = await pool.query(`SELECT type FROM base_ban_history WHERE (owner_id=$1 OR player_id=$1) AND expire_date > $2 ORDER BY object_id DESC LIMIT 1`, [pidS(p), new Date()]).catch(() => ({ rows: [] as { type: string }[] }));
  const t = r.rows[0]?.type;
  return t === undefined ? null : t === "MUTE" ? "mute" : "ban";
}

/** AllUtils.SlotValidMessage. */
function slotValidMessage(a: SlotModel, b: SlotModel): boolean {
  const n = (s: SlotModel) => s.state === SlotState.NORMAL || s.state === SlotState.READY;
  if (n(a) && n(b)) return true;
  if (a.state < SlotState.LOAD || b.state < SlotState.LOAD) return false;
  if (a.specGM || b.specGM || (a.deathState & DeadEnum.UseChat) || ((a.deathState & DeadEnum.Dead) && (b.deathState & DeadEnum.Dead)) || (a.spectator && b.spectator)) return true;
  if (!(a.deathState & DeadEnum.Alive) || !(b.deathState & DeadEnum.Alive)) return false;
  return !a.spectator && !b.spectator;
}

/** A line from "Server" (session 0, nick colour 5) to one player: the reply of every / and : command and the flood notices. */
export const serverReply = (a: Account | null | undefined, text: string): void => social.send(a, lobbyChatAck(0, "Server", 5, false, text));

/** floodCheck of the connection plus its notice; false = drop the message. */
function floodGate(c: GameClient, p: Account): boolean {
  const f = floodCheck(c);
  if (f.notice) serverReply(p, f.justMuted ? `Você enviou mensagens rápido demais: chat silenciado por ${f.mutedFor} s.` : `Chat silenciado por flood (${f.mutedFor} s).`);
  return f.ok;
}

/** Commands the client handles by itself (/bloquear, /desbloquear): never broadcast if one reaches the server. */
export const isClientCommand = (text: string): boolean => /^\/(bloquear|desbloquear)(\s|$)/i.test(text);

export async function handleChat(c: GameClient, r: PacketReader): Promise<void> {
  const type = r.readH(), raw = r.readU(r.readH() * 2);
  const p = c.player;
  if (!p || !raw || raw.length > 60 || !p.nickname) return;
  if (!floodGate(c, p)) return; // counts every attempt, also the ones the 1 msg/s rule below drops
  if (p.durationSince("chatting") < 1) return;
  const text = cleanChatText(raw);
  if (!text) return;
  const b = await banState(p);
  if (b === "ban") return c.session.send(announce("Your account is banned."));
  const gm = p.useChatGM(p.hideGMcolor);
  const room = roomOf(p);
  if ((type === 1 || type === 4 || type === 6) && text.startsWith("/")) {
    if (isClientCommand(text) || (await playerCommands(p, text))) { p.last.chatting = Date.now(); return; }
  }
  if (type === 1 || type === 6) {
    if (!room && !c.channelOf(p)) return;
    if (await serverCommands(p, text)) { p.last.chatting = Date.now(); return; }
  }
  if (b === "mute") return c.session.send(announce("You are muted and cannot chat."));
  const shown = filterChatText(text);
  if (type === 1 || type === 6) {
    if (room) {
      const me = room.slots[p.slotId];
      const pkt = roomChatAck(type, p.slotId, gm, shown);
      for (const s of room.slots) { const a = s.playerId > 0n ? room.svc.getAccount(s.playerId) : null; if (a && me && slotValidMessage(me, s)) social.send(a, pkt); }
      ringPush(room, { t: Date.now(), slot: p.slotId, nick: p.nickname, type, text: shown });
    } else {
      const ch = c.channelOf(p);
      if (!ch) return;
      const pkt = lobbyChatAck(p.session?.sessionId ?? 0, p.nickname, p.nickColor, gm, shown);
      for (const a of ch.lobbyPlayers) social.send(a, pkt);
    }
  } else if (type === 4 && room) {
    const me = room.slots[p.slotId];
    const pkt = roomChatAck(type, p.slotId, gm, shown);
    for (const s of room.slots) if (s.team === me.team) { const a = s.playerId > 0n ? room.svc.getAccount(s.playerId) : null; if (a && slotValidMessage(me, s)) social.send(a, pkt); }
    ringPush(room, { t: Date.now(), slot: p.slotId, nick: p.nickname, type, text: shown });
  }
  p.last.chatting = Date.now();
}

function whisperErr(nick: string, text: string, err: number): Uint8Array {
  const w = W(96).writeH(1827).writeD(err).writeC(err & 0xff).writeU(nick, 66);
  if (err === 0) wstrz(w.writeH(text.length + 1), text);
  return w.toBytes();
}
function whisperAck(sender: string, gm: boolean, text: string): Uint8Array {
  const w = W(96 + text.length * 2).writeH(1830).writeU(sender, 66).writeC(gm ? 1 : 0).writeC(0).writeH(text.length + 1);
  return wstrz(w, text).writeC(0).toBytes();
}

/** /r: the nick of whoever whispered to the player last, or whom the player whispered last. */
const lastWhisper = new WeakMap<Account, string>();
export const lastWhisperPartner = (p: Account): string => lastWhisper.get(p) ?? "";

/** Delivers a whisper (text already cleaned and <= 60); false when the target cannot receive it. */
export function sendWhisper(p: Account, t: Account | null, text: string): boolean {
  if (!t || !t.isOnline || !t.connection) return false;
  social.send(t, whisperAck(p.nickname, p.useChatGM(p.hideGMcolor), filterChatText(text)));
  lastWhisper.set(t, p.nickname);
  lastWhisper.set(p, t.nickname);
  return true;
}

export async function handleWhisper(c: GameClient, op: number, r: PacketReader): Promise<void> {
  const targetId = op === 1828 ? r.readQ() : 0n;
  const nick = r.readU(66), raw = r.readU(r.readH() * 2);
  const p = c.player;
  if (!p || p.nickname === nick) return;
  if (raw.length > 60 || !floodGate(c, p)) return; // same 60 chars and the same flood rule as the chat
  if (p.durationSince("chatting") < 1) return;
  const b = await banState(p);
  if (b) return c.session.send(announce(b === "ban" ? "Your account is banned." : "You are muted and cannot send whispers."));
  const text = cleanChatText(raw);
  if (!text) return;
  const t = op === 1828 ? social.online.get(targetId) ?? null : [...social.online.values()].find((a) => a.nickname === nick) ?? null;
  if (!t || (op === 1826 && t.nickname !== nick) || !sendWhisper(p, t, text)) c.session.send(whisperErr(nick, text, 0x80000000));
  p.last.chatting = Date.now();
}

// ---- friends ---------------------------------------------------------------------------------------------------------

interface FriendInfo { nickname: string; rank: number; nickColor: number; online: boolean; status: number; clanLogo: number }
export const FS = { Offline: 3, Online: 4, Lobby: 5, Room: 8 };

async function friendInfo(fid: bigint): Promise<FriendInfo | null> {
  const a = social.online.get(fid);
  if (a) return { nickname: a.nickname, rank: a.getRank(), nickColor: a.nickColor, online: a.isOnline, status: a.status.buffer, clanLogo: a.clan.logo };
  const x = (await pool.query(`SELECT a.nickname, a.rank, a.nick_color, a.online, a.status, COALESCE(c.logo, 4294967295) AS logo FROM accounts a LEFT JOIN system_clan c ON c.id = a.clan_id AND a.clan_id > 0 WHERE a.player_id=$1`, [String(fid)])).rows[0];
  return x ? { nickname: String(x.nickname ?? ""), rank: Number(x.rank), nickColor: Number(x.nick_color), online: !!x.online, status: Number(x.status) >>> 0, clanLogo: Number(x.logo) >>> 0 } : null;
}

/** ComDiv.GetPlayerLocation -> the friend status u32. */
function locationStatus(info: FriendInfo): number {
  const ch = info.status & 0xff, room = (info.status >>> 8) & 0xff, srv = (info.status >>> 16) & 0xff;
  let state = FS.Online, rr = 0, cc = 0, ss = 0;
  if (!info.online) state = FS.Offline;
  else if (room !== 255) { state = FS.Room; rr = room; cc = ch; }
  else if (ch !== 255) { state = FS.Lobby; cc = ch; }
  if (info.online && srv !== 255) ss = srv;
  return (((state & 0xff) << 28) | ((ss & 0xff) << 20) | ((cc & 0xff) << 12) | (rr & 0xfff)) >>> 0;
}
function friendStatus(f: FriendModel, info: FriendInfo, stateN: number | null = null): number {
  if (f.removed) return (FS.Offline << 28) >>> 0;
  if (f.state > 0) return (f.state << 28) >>> 0;
  if (stateN === null || stateN === 0) return locationStatus(info);
  return (stateN << 28) >>> 0;
}

/** PROTOCOL_AUTH_FRIEND_INFO_ACK (1810): auth layout (0xFFFFFFFF + clan logo) or game layout. */
export async function friendInfoAck(list: FriendModel[], auth: boolean): Promise<Uint8Array> {
  const w = W(64 + list.length * 64).writeH(1810).writeC(list.length);
  for (const f of list) {
    const info = await friendInfo(f.playerId);
    if (!info || !info.nickname || f.playerId <= 0n) { w.zeros(31); continue; }
    w.writeC(info.nickname.length + 1);
    wstrz(w, info.nickname).writeQ(f.playerId).writeD(friendStatus(f, info)).writeD(auth ? 0xffffffff : 0).writeC(info.rank);
    if (auth) w.zeros(8).writeD(info.clanLogo).writeC(0); else w.zeros(13);
  }
  return w.toBytes();
}

/** PROTOCOL_AUTH_FRIEND_INFO_CHANGE_ACK (1815). changeState: Insert 1, Accept 2, Delete 3, Update 4. */
async function friendChangeAck(cs: number, f: FriendModel | null, idx: number, stateN: number | null = null, auth = false): Promise<Uint8Array> {
  const w = W(96).writeH(1815).writeC(cs).writeC(idx);
  const info = f ? await friendInfo(f.playerId) : null;
  if ((cs === 1 || cs === 4) && f && info) {
    w.writeC(info.nickname.length + 1);
    wstrz(w, info.nickname).writeQ(f.playerId).writeD(friendStatus(f, info, stateN)).writeD(auth ? 0xffffffff : 0).writeC(info.rank).zeros(6);
  } else w.zeros(24);
  return w.toBytes();
}

async function friendsOf(pid: bigint): Promise<FriendModel[]> {
  const a = social.online.get(pid);
  if (a) return a.friends;
  return (await pool.query(`SELECT * FROM player_friends WHERE owner_id=$1 ORDER BY id`, [String(pid)])).rows.map((x) => ({ playerId: BigInt(x.id), objectId: BigInt(x.object_id), state: Number(x.state), removed: !!x.removed }));
}

/** AllUtils.AddFriend: 0 = inserted, 1 = already there (un-removed), -1 = error. */
async function addFriend(owner: bigint, friend: bigint, state: number): Promise<number> {
  try {
    const list = await friendsOf(owner);
    const e = list.find((f) => f.playerId === friend);
    if (!e) {
      const r = await pool.query(`INSERT INTO player_friends (id, owner_id, state) VALUES ($1, $2, $3) RETURNING object_id`, [String(friend), String(owner), state]);
      const f = { playerId: friend, objectId: BigInt(r.rows[0].object_id), state, removed: false };
      if (social.online.get(owner)) list.push(f);
      return 0;
    }
    if (e.removed) { e.removed = false; await pool.query(`UPDATE player_friends SET removed=false WHERE owner_id=$1 AND id=$2`, [String(owner), String(friend)]); }
    return 1;
  } catch (e) { log(`AddFriend: ${(e as Error).message}`); return -1; }
}

export async function handleFriendInvite(c: GameClient, op: number, r: PacketReader): Promise<void> {
  const nick = r.readU(66);
  const p = c.player;
  if (!p) return;
  const ack = op === 1811 ? 1812 : 1819;
  const err = (e: number) => c.session.send(W(8).writeH(ack).writeD(e).toBytes());
  if (!nick || nick === p.nickname || (op === 1811 && p.durationSince("friendInvite") < 1)) return err(0x80001037);
  if (p.friends.length >= 50) return err(0x80001038);
  const t = await social.byNick(nick);
  if (!t) return err(0x80001042);
  if (p.friends.some((f) => f.playerId === t.playerId)) return err(0x80001041);
  const tFriends = await friendsOf(t.playerId);
  if (tFriends.length >= 50) return err(0x80001038);
  const num = await addFriend(t.playerId, p.playerId, 2);
  const rr = await addFriend(p.playerId, t.playerId, num === 1 ? 0 : 1);
  if (rr === -1 || num === -1) return err(0x80001039);
  const tl = await friendsOf(t.playerId);
  const ti = tl.findIndex((f) => f.playerId === p.playerId), mi = p.friends.findIndex((f) => f.playerId === t.playerId);
  if (op === 1818) await createNote(t, { senderId: p.playerId, senderName: p.nickname, type: 7, text: "", clanId: 0, clanNote: 0, days: 7 });
  social.send(t, await friendChangeAck(num === 0 ? 1 : 4, tl[ti] ?? null, ti));
  c.session.send(await friendChangeAck(1, p.friends[mi] ?? null, mi));
  if (op === 1811) p.last.friendInvite = Date.now();
}

export async function handleFriendAccept(c: GameClient, r: PacketReader): Promise<void> {
  const idx = r.readC();
  const p = c.player;
  if (!p) return;
  const f = p.friends[idx];
  // only a request received (state 2): the C# accepted any state > 0, so the sender could accept its own request (state 1)
  if (!f || f.state !== 2) return c.session.send(W(8).writeH(1817).writeD(0x80000000).toBytes());
  f.state = 0;
  await pool.query(`UPDATE player_friends SET state=0 WHERE owner_id=$1 AND id=$2`, [pidS(p), String(f.playerId)]);
  c.session.send(await friendChangeAck(2, null, idx));
  c.session.send(await friendChangeAck(4, f, idx));
  const a = social.online.get(f.playerId);
  const al = await friendsOf(f.playerId);
  const i2 = al.findIndex((x) => x.playerId === p.playerId);
  const f2 = al[i2];
  if (f2 && f2.state > 0) {
    f2.state = 0;
    await pool.query(`UPDATE player_friends SET state=0 WHERE owner_id=$1 AND id=$2`, [String(f.playerId), pidS(p)]);
    if (a) social.send(a, await friendChangeAck(4, f2, i2));
  }
}

export async function handleFriendDelete(c: GameClient, r: PacketReader): Promise<void> {
  const idx = r.readC();
  const p = c.player;
  if (!p || p.durationSince("friendDelete") < 1) return;
  let err = 0;
  const f = p.friends[idx];
  if (!f) err = 0x80000000;
  else {
    await pool.query(`DELETE FROM player_friends WHERE id=$1 AND owner_id=$2`, [String(f.playerId), pidS(p)]);
    const al = await friendsOf(f.playerId);
    const i2 = al.findIndex((x) => x.playerId === p.playerId);
    if (i2 >= 0) {
      al[i2].removed = true;
      await pool.query(`UPDATE player_friends SET removed=true WHERE owner_id=$1 AND id=$2`, [String(f.playerId), pidS(p)]);
      social.send(social.online.get(f.playerId), await friendChangeAck(4, al[i2], i2));
    }
    p.friends.splice(idx, 1);
    c.session.send(await friendChangeAck(3, null, idx));
  }
  c.session.send(W(8).writeH(1821).writeD(err).toBytes());
  c.session.send(await friendInfoAck(p.friends, false));
  p.last.friendDelete = Date.now();
}

/** AllUtils.SyncPlayerToFriends: each (accepted) friend online gets 1815 Update with p's live status. */
export async function syncPlayerToFriends(p: Account, all: boolean): Promise<void> {
  for (const f of p.friends) {
    if (!(all || (f.state === 0 && !f.removed))) continue;
    const a = social.online.get(f.playerId);
    if (!a) continue;
    const i2 = a.friends.findIndex((x) => x.playerId === p.playerId);
    if (i2 >= 0) social.send(a, await friendChangeAck(4, a.friends[i2], i2));
  }
}

// ---- notes -----------------------------------------------------------------------------------------------------------

export interface Note { objectId?: bigint; senderId: bigint; senderName: string; type: number; text: string; clanId: number; clanNote: number; days: number; state?: number }

function noteBody(w: PacketWriter, n: Note): void {
  const ask = n.type === 5, clan = n.type === 4;
  w.writeC(n.senderName.length + 1).writeC(n.type === 7 || ask || (clan && n.clanNote !== 0) ? 0 : n.text.length + 1);
  wstrz(w, n.senderName);
  if (!clan && !ask) wstrz(w, n.text);
  else if (n.clanNote >= 4 && n.clanNote <= 6) { w.writeH(n.text.length + 1).writeH(n.clanNote); utf16(w, n.text).writeC(0); }
  else if (n.clanNote === 0) wstrz(w, n.text);
  else w.writeH(3).writeD(n.clanNote).writeH(0);
}
function noteReceiveAck(n: Note): Uint8Array {
  const x = W(128 + n.text.length * 2).writeH(1931).writeD(Number(BigInt.asUintN(32, n.objectId ?? 0n))).writeQ(n.senderId).writeC(n.type === 5 ? 6 : n.type)
    .writeC(n.state ?? 1).writeC(Math.ceil(n.days)).writeD(n.clanId);
  noteBody(x, n);
  return x.toBytes();
}

/** DaoManagerSQL.CreateMessage (RETURNING object_id) + 1931 to the owner when online. */
export async function createNote(owner: Account, n: Note): Promise<boolean> {
  try {
    const exp = Number(fmtDate(new Date(Date.now() + n.days * 86400000), "yyMMddHHmm"));
    const r = await pool.query(`INSERT INTO player_messages(owner_id, sender_id, sender_name, clan_id, clan_note, text, type, state, expire_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING object_id`,
      [String(owner.playerId), String(n.senderId), n.senderName, n.clanId, n.clanNote, n.text, n.type, 1, exp]);
    n.objectId = BigInt(r.rows[0].object_id);
    social.send(social.online.get(owner.playerId) ?? null, noteReceiveAck(n));
    return true;
  } catch (e) { log(`CreateMessage: ${(e as Error).message}`); return false; }
}

export async function handleNoteSend(c: GameClient, op: number, r: PacketReader): Promise<void> {
  let nick = "", text = "", target: Account | null = null;
  const p = c.player;
  if (op === 1921) { const nl = r.readC(), tl = r.readC(); nick = r.readU(nl * 2); text = r.readU(tl * 2); }
  else { const id = r.readQ(); text = r.readU(r.readC() * 2); if (!p || id === p.playerId) return; target = await social.byPid(id); }
  if (!p) return;
  if (op === 1921) {
    if (!nick || nick === p.nickname) return;
    const b = await banState(p);
    if (b) return c.session.send(announce(b === "ban" ? "Your account is banned." : "You are muted and cannot send notes."));
    target = await social.byNick(nick);
  }
  let err = 0;
  if (!target) err = 0x8000107e;
  else if (Number((await pool.query(`SELECT COUNT(*) AS n FROM player_messages WHERE owner_id=$1`, [String(target.playerId)])).rows[0].n) >= 100) err = 0x8000107f;
  else if (!(await createNote(target, { senderId: p.playerId, senderName: p.nickname, type: 0, text, clanId: 0, clanNote: 0, days: 15 }))) err = 0x80000000;
  c.session.send(W(8).writeH(1922).writeD(err).toBytes());
}

export async function handleNoteRead(c: GameClient, r: PacketReader): Promise<void> {
  const n = r.readC();
  if (n > 100) return;
  const ids: number[] = [];
  for (let i = 0; i < n; i++) { const v = r.readD(); if (v > 0) ids.push(v); }
  const p = c.player;
  if (!p || ids.length === 0) return;
  const exp = Number(fmtDate(new Date(Date.now() + 7 * 86400000), "yyMMddHHmm"));
  try {
    await pool.query(`UPDATE player_messages SET expire_date=$1, state=0 WHERE object_id = ANY($2) AND owner_id=$3`, [exp, ids, pidS(p)]);
    const w = W(8 + ids.length * 4).writeH(1927).writeC(ids.length);
    for (const i of ids) w.writeD(i);
    c.session.send(w.toBytes());
  } catch { /* silent */ }
}

export async function handleNoteDelete(c: GameClient, r: PacketReader): Promise<void> {
  const n = r.readC(), ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push(r.readD());
  const p = c.player;
  if (!p) return;
  let err = 0;
  if (ids.length === 0) err = 0x80000000;
  else await pool.query(`DELETE FROM player_messages WHERE object_id = ANY($1) AND owner_id=$2`, [ids, pidS(p)]).catch(() => { err = 0x80000000; });
  const w = W(8 + ids.length * 4).writeH(1929).writeD(err).writeC(ids.length);
  for (const i of ids) w.writeD(i);
  c.session.send(w.toBytes());
}

/** days left of a note from expire_date (yyMMddHHmm, as createNote / handleNoteRead write it); at least 1 while it lives */
const daysLeft = (exp: number): number => {
  const s = String(exp).padStart(10, "0");
  const end = new Date(2000 + Number(s.slice(0, 2)), Number(s.slice(2, 4)) - 1, Number(s.slice(4, 6)), Number(s.slice(6, 8)), Number(s.slice(8, 10))).getTime();
  return Math.max(1, Math.ceil((end - Date.now()) / 86400000));
};

/**
 * Auth GET_OPTION: 1925 NOTE_LIST after RecycleMessages (drops expired notes). Every note goes in: the count byte is the number
 * of headers sent. The exe's inbox holds 100 (CPopupCommunity 0x886b60 loops to 0x64; 1921 answers 0x8000107f at 100), so the
 * old cut at 25 made the count byte (all rows) disagree with the headers sent.
 */
export async function noteListAck(owner: bigint): Promise<Uint8Array | null> {
  const now = nowNum("yyMMddHHmm");
  await pool.query(`DELETE FROM player_messages WHERE owner_id=$1 AND expire_date <= $2`, [String(owner), now]).catch(() => undefined);
  const rows = (await pool.query(`SELECT * FROM player_messages WHERE owner_id=$1 ORDER BY object_id ASC`, [String(owner)])).rows;
  if (rows.length === 0) return null;
  const notes = rows.slice(0, 100).map((x) => ({ objectId: BigInt(x.object_id), senderId: BigInt(x.sender_id), senderName: String(x.sender_name ?? ""), type: Number(x.type), text: String(x.text ?? ""), clanId: Number(x.clan_id), clanNote: Number(x.clan_note), state: Number(x.state), days: daysLeft(Number(x.expire_date)) }));
  const w = W(256 + notes.length * 128).writeH(1925).writeC(0).writeC(notes.length);
  for (const n of notes) w.writeD(Number(BigInt.asUintN(32, n.objectId))).writeQ(n.senderId).writeC(n.type).writeC(n.state).writeC(n.days).writeD(n.clanId);
  for (const n of notes) noteBody(w, n);
  return w.toBytes();
}

// ---- missions ----------------------------------------------------------------------------------------------------------

let missionStores = new Map<number, { itemId: number; enabled: boolean }>();
export async function loadSocialData(): Promise<void> {
  missionStores = new Map((await pool.query(`SELECT id, item_id, enabled FROM system_mission_stores`)).rows.map((x) => [Number(x.id), { itemId: Number(x.item_id), enabled: x.enabled === true }]));
  loadChatFilter();
}

export async function handleQuestActiveIdx(c: GameClient, r: PacketReader): Promise<void> {
  const slot = r.readC(), card = r.readC(), flag = r.readH();
  const p = c.player;
  if (!p) return;
  const m = p.mission;
  if (slot < 4 && m.at(slot).currentCard !== card) {
    m.at(slot).currentCard = card;
    await pool.query(`UPDATE player_mission_slots SET current_card=$1 WHERE owner_id=$2 AND slot=$3`, [card, pidS(p), slot]);
  }
  m.selectedCard = flag === 0xffff;
  if (slot < 4 && m.actualMission !== slot) { m.actualMission = slot; await dao.update1("player_missions", "current_mission", slot, "owner_id", p.playerId); }
}

export async function handleBuyCardSet(c: GameClient, r: PacketReader): Promise<void> {
  const setId = r.readC(); r.readC();
  const p = c.player;
  if (!p) return;
  const ack = (err: number) => {
    const w = W(110).writeH(2365).writeD(err);
    if (err === 0) w.writeD(p.gold).writeC(p.mission.actualMission).writeB(questingInfo(p.mission)).writeD(p.cash);
    c.session.send(w.toBytes());
  };
  const m = p.mission;
  if (m.ownsCardSet(setId)) return ack(0x8000104d);
  const store = missionStores.get(setId);
  // [INFERIDO] C# buy ignores Enable (MissionConfigXML only feeds MissionPage1/2, which nothing reads); a disabled set is refused with the same code as an unknown set.
  if (!store?.enabled) return ack(0x8000104d);
  const good = getGoodByItemId(store.itemId);
  if (!good) return ack(0x8000104d);
  const slot = m.findFreeSlot();
  if (slot < 0) return ack(0x8000104e);
  const price = good.priceGold;
  if (p.gold < price) return ack(0x8000104d);
  // conditional debit / credit by delta (dao.addMoney); p.gold is read back from the row
  if (!(await dao.addMoney(p, -price))) return ack(p.gold < price ? 0x8000104d : 0x8000104c);
  try {
    await pool.query(`INSERT INTO player_mission_slots(owner_id, slot, card_set_id, current_card, progress, acquired_at) VALUES($1, $2, $3, 0, $4, now())
      ON CONFLICT (owner_id, slot) DO UPDATE SET card_set_id=EXCLUDED.card_set_id, current_card=0, progress=EXCLUDED.progress, acquired_at=now()`, [pidS(p), slot, setId, Buffer.alloc(MISSION_PROGRESS_SIZE)]);
  } catch {
    await dao.addMoney(p, price);
    return ack(0x8000104c);
  }
  const s = m.at(slot);
  s.cardSetId = setId; s.currentCard = 0; s.progress = new Uint8Array(MISSION_PROGRESS_SIZE);
  m.actualMission = slot;
  await dao.update1("player_missions", "current_mission", slot, "owner_id", p.playerId);
  ack(0);
}

export async function handleDeleteCardSet(c: GameClient, r: PacketReader): Promise<void> {
  const slot = r.readC();
  const p = c.player;
  if (!p) return;
  const m = p.mission;
  let ok = slot < 4 && !m.at(slot).isEmpty;
  if (ok) ok = await pool.query(`DELETE FROM player_mission_slots WHERE owner_id=$1 AND slot=$2`, [pidS(p), slot]).then(() => true, () => false);
  if (!ok) return c.session.send(W(8).writeH(2367).writeD(0x80001050).toBytes());
  const s = m.at(slot);
  s.cardSetId = 0; s.currentCard = 0; s.progress = new Uint8Array(MISSION_PROGRESS_SIZE);
  if (m.actualMission === slot) { m.actualMission = m.firstOwnedSlot(); await dao.update1("player_missions", "current_mission", m.actualMission, "owner_id", p.playerId); }
  c.session.send(W(96).writeH(2367).writeD(0).writeB(questingInfo(m)).toBytes());
}

let questPacked: Uint8Array | null = null;
export function handleQuestList(c: GameClient): void {
  if (!questPacked) {
    const f = path.join(config.dataDir, "Quest.bin");
    let raw: Uint8Array = existsSync(f) ? readFileSync(f) : new Uint8Array(0);
    if (raw.length === 0 || raw.length % 16224 !== 0) raw = new Uint8Array(16224);
    questPacked = zlibCompress(raw);
  }
  const w = W(questPacked.length + 64).writeH(8710).writeD(questPacked.length);
  for (let o = 0; o < questPacked.length; o += 8875) { const ch = questPacked.subarray(o, Math.min(o + 8875, questPacked.length)); w.writeD(o).writeD(ch.length).writeB(ch); }
  c.session.send(w.toBytes());
}

// ---- clan ----------------------------------------------------------------------------------------------------------------

export interface ClanRow { id: number; name: string; logo: number; info: string; news: string; ownerId: bigint; rank: number; exp: number; points: number; createDate: number; maxPlayers: number; nameColor: number; effects: number; matches: number; wins: number; loses: number; authority: number; rankLimit: number; minAge: number; maxAge: number; joinPermission: number }
const clanRow = (x: Record<string, unknown>): ClanRow => ({
  id: Number(x.id), name: String(x.name ?? ""), logo: Number(x.logo) >>> 0, info: String(x.info ?? ""), news: String(x.news ?? ""), ownerId: BigInt(String(x.owner_id ?? 0)),
  rank: Number(x.rank), exp: Number(x.exp), points: Number(x.point ?? 1000), createDate: Number(x.create_date), maxPlayers: Number(x.max_players ?? 50), nameColor: Number(x.name_color),
  effects: Number(x.effects), matches: Number(x.matches), wins: Number(x.match_wins), loses: Number(x.match_loses), authority: Number(x.authority), rankLimit: Number(x.rank_limit),
  minAge: Number(x.min_age_limit), maxAge: Number(x.max_age_limit), joinPermission: Number(x.join_permission),
});
async function allClans(): Promise<ClanRow[]> { return (await pool.query(`SELECT * FROM system_clan ORDER BY id ASC`)).rows.map(clanRow); }
export async function clanById(id: number): Promise<ClanRow | null> { if (id <= 0) return null; const x = (await pool.query(`SELECT * FROM system_clan WHERE id=$1`, [id])).rows[0]; return x ? clanRow(x) : null; }
export const memberCount = async (id: number) => Number((await pool.query(`SELECT COUNT(*) AS n FROM accounts WHERE clan_id=$1`, [id])).rows[0].n);
/** ClanModel.GetClanUnit(count): the clan tier from the member count (C# thresholds 10/30/50/100/150/200/250). */
export const clanUnit = (n: number) => (n >= 250 ? 7 : n >= 200 ? 6 : n >= 150 ? 5 : n >= 100 ? 4 : n >= 50 ? 3 : n >= 30 ? 2 : n >= 10 ? 1 : 0);
/** PROTOCOL_CS_MEDAL_INFO_ACK (991) step table: [points, a, b, float bits] x 30, from Server.Game PROTOCOL_CS_MEDAL_INFO_ACK.cs (MedalSteps). */
const MEDAL_STEPS: [number, number, number, number][] = [
  [500, 2, 1, 0x3E4CCCCD], [700, 3, 1, 0x3D4CCCCD], [1000, 5, 1, 0x3E4CCCCD], [1300, 8, 1, 0x3D4CCCCD], [1700, 2, 2, 0x3F000000], [2000, 3, 2, 0x3DCCCCCD], [2500, 5, 2, 0x3E99999A], [3000, 8, 2, 0x3DA3D70A],
  [4000, 4, 1, 0x40000000], [5000, 7, 1, 0x3E99999A], [6000, 2, 3, 0x3F400000], [7000, 3, 3, 0x3E19999A], [8000, 5, 3, 0x3F000000], [10000, 8, 3, 0x3DF5C28F], [12000, 4, 2, 0x40400000], [14000, 7, 2, 0x3F000000],
  [16000, 1, 1, 0x3E4CCCCD], [18000, 2, 4, 0x3F800000], [20000, 3, 4, 0x3E4CCCCD], [23000, 5, 4, 0x3F333333], [25000, 8, 4, 0x3E19999A], [28000, 4, 3, 0x40800000], [30000, 7, 3, 0x3F333333], [32000, 1, 2, 0x3F000000],
  [35000, 4, 4, 0x40A00000], [37000, 7, 4, 0x3F666666], [40000, 1, 3, 0x3F400000], [43000, 6, 1, 0x3D4CCCCD], [45000, 1, 4, 0x3F800000], [50000, 6, 2, 0x3DCCCCCD],
];
/** PROTOCOL_CS_MEDAL_INFO_ACK (991): D 0, C 0, then two blocks (slot 1 and 2) of D slot, D count, per step D points, H, H, D bits. */
export function medalInfoAck(): Uint8Array {
  const w = W(16 + 2 * 8 + MEDAL_STEPS.length * 12 * 2).writeH(991).writeD(0).writeC(0);
  for (const slot of [1, 2]) {
    w.writeD(slot).writeD(MEDAL_STEPS.length);
    for (const [pts, a, b, bits] of MEDAL_STEPS) w.writeD(pts).writeH(a).writeH(b).writeD(bits >>> 0);
  }
  return w.toBytes();
}
export const clanStatus = (status: number, online: boolean) => {
  const ch = status & 0xff, room = (status >>> 8) & 0xff, srv = (status >>> 16) & 0xff, cm = (status >>> 24) & 0xff;
  let st = FS.Online, rr = 0, cc = 0, ss = 0;
  if (!online) st = FS.Offline;
  else if (room !== 255 && !(cm !== 255 || room === 255)) { st = FS.Room; rr = room; cc = ch; }
  else if ((cm !== 255 || room === 255) && ch !== 255) { st = FS.Lobby; cc = ch; }
  if (online && srv !== 255) ss = srv;
  const low = (((st & 0xff) << 28) | ((ss & 0xff) << 20) | ((cc & 0xff) << 12) | (rr & 0xfff)) >>> 0;
  return (BigInt(cm !== 255 ? cm + 1 : 0) << 32n) | BigInt(low);
};

export async function handleClanEnter(c: GameClient): Promise<void> {
  const p = c.player;
  if (!p) return;
  const room = roomOf(p);
  if (room) { room.changeSlotState(p.slotId, SlotState.CLAN, false); stopCountDownBySlot(room, p.slotId); room.updateSlotsInfo(); }
  const req = p.clanId === 0 && p.nickname ? Number((await pool.query(`SELECT clan_id FROM system_clan_invites WHERE player_id=$1`, [pidS(p)])).rows[0]?.clan_id ?? 0) : 0;
  const id = req > 0 ? req : p.clan.id;
  const w = W(32).writeH(770).writeD(0).writeD(id).writeD(p.clanAccess);
  if (!(id !== 0 && p.clanAccess !== 0)) {
    const n = (await allClans()).length;
    w.writeD(n).writeC(15).writeH(Math.ceil(n / 15)).writeD(Number(fmtDate(new Date(), "MMddHHmmss")) >>> 0);
  }
  c.session.send(w.toBytes());
  c.session.send(medalInfoAck());
  if (p.clan.id > 0 && req === 0) { const cl = await clanById(p.clan.id); if (cl) c.session.send(await clanDetailAck(0, cl)); }
}

export function handleClanLeave(c: GameClient): void {
  const p = c.player;
  if (!p) return;
  roomOf(p)?.changeSlotState(p.slotId, SlotState.NORMAL, true);
  c.session.send(W(8).writeH(772).writeD(0).toBytes());
}

export async function handleClanList(c: GameClient, r: PacketReader): Promise<void> {
  const start = r.readC(); r.readU(r.readC() * 2); r.readC(); r.readC();
  const clans = await allClans();
  const rows = clans.slice(start, start + 15);
  const w = W(64 + rows.length * 128).writeH(1000).writeD(0).writeH(rows.length).writeH(clans.length).writeH(start);
  for (const cl of rows) { w.writeD(cl.id).writeC(cl.name.length + 1); wstrz(w, cl.name).writeD(cl.logo).writeH(cl.info.length + 1); wstrz(w, cl.info).writeC(0); }
  const b = w.toBytes();
  c.session.send(b);
  c.session.send(b); // sent twice in the C#
}

/** PROTOCOL_CS_DETAIL_INFO_ACK (801): D echo + the fixed 1607-byte clan blob. */
async function clanDetailAck(echo: number, cl: ClanRow | null): Promise<Uint8Array> {
  const blob = W(1610);
  if (cl) {
    const owner = (await pool.query(`SELECT nickname, nick_color, rank FROM accounts WHERE player_id=$1`, [String(cl.ownerId)])).rows[0];
    const n = await memberCount(cl.id);
    blob.writeD(cl.id).writeU(cl.name, 34).writeC(cl.rank).writeC(n).writeC(cl.maxPlayers).writeD(cl.createDate).writeD(cl.logo).writeC(cl.nameColor).writeC(cl.effects).writeC(clanUnit(n))
      .writeD(cl.exp).writeQ(cl.ownerId).zeros(4);
    blob.writeU(String(owner?.nickname ?? ""), 66).writeC(Number(owner?.nick_color ?? 0)).writeC(Number(owner?.rank ?? 0));
    blob.writeU(cl.info, 510).zeros(41).writeC(cl.joinPermission).writeC(cl.rankLimit).writeC(cl.maxAge).writeC(cl.minAge).writeC(cl.authority);
    blob.writeU(cl.news, 510).writeD(cl.points).writeD(cl.wins).writeD(cl.loses).zeros(96);
    blob.writeD(cl.matches).writeD(cl.wins).writeD(cl.loses).writeD(0).writeD(0).zeros(20); // kills/assists/deaths/headshots/escapes: clan stats not tracked
    // @1446/@1450 weekly medals, @1454 pad, @1455 clan rank (C# PROTOCOL_CS_DETAIL_INFO_ACK), tail war region
    blob.zeros(48).zeros(48).writeD(0).writeD(0).writeC(0).writeD(cl.rank).zeros(82).writeC(0).writeC(0).zeros(64);
  }
  const b = blob.toBytes();
  const full = new Uint8Array(1607);
  full.set(b.subarray(0, 1607));
  return W(1616).writeH(801).writeD(echo).writeB(full).toBytes();
}

export async function handleClanDetail(c: GameClient, r: PacketReader): Promise<void> {
  const id = r.readD(), echo = r.readC();
  const p = c.player;
  if (!p) return;
  p.findClanId = id;
  const cl = await clanById(id);
  if (!cl) return;
  c.session.send(await clanDetailAck(echo, cl));
}

export async function handleClanSimpleInfo(c: GameClient, r: PacketReader): Promise<void> {
  const id = r.readD();
  const p = c.player;
  if (!p) return;
  p.findClanId = id;
  const cl = await clanById(id);
  const w = W(128).writeH(1002).writeD(0).writeH(0).writeD(cl ? 0 : 0x80000000);
  if (cl) {
    const n = await memberCount(cl.id);
    const name = cl.name.slice(0, 33);
    w.writeD(cl.points).writeC(cl.nameColor).writeD(cl.loses).writeD(cl.wins).writeD(cl.matches).writeD(cl.logo).writeC(clanUnit(n)).writeC(cl.maxPlayers).writeC(n).writeC(name.length);
    utf16(w, name).writeQ(cl.ownerId).writeC(cl.rank);
  }
  c.session.send(w.toBytes());
}

export async function handleClanMemberContext(c: GameClient): Promise<void> {
  const p = c.player;
  if (!p) return;
  const id = p.clanId || p.findClanId;
  if (!id) return c.session.send(W(8).writeH(803).writeD(0xffffffff).toBytes());
  const n = await memberCount(id);
  c.session.send(W(16).writeH(803).writeD(0).writeC(n).writeC(14).writeC(Math.ceil(n / 14)).writeD(Number(fmtDate(new Date(), "MMddHHmmss")) >>> 0).toBytes());
}

export async function handleClanMemberList(c: GameClient, r: PacketReader): Promise<void> {
  const page = r.readC();
  const p = c.player;
  if (!p) return;
  const cl = await clanById(p.clanId || p.findClanId);
  if (!cl) return c.session.send(W(8).writeH(805).writeD(0xffffffff).toBytes());
  const rows = (await pool.query(`SELECT a.player_id, a.nickname, a.nick_color, a.rank, a.online, a.clan_access, a.clan_date, a.status, COALESCE(s.clan_match_wins,0) AS w, COALESCE(s.clan_match_loses,0) AS l, COALESCE(e.namecard_id,0) AS nc
    FROM accounts a LEFT JOIN player_stat_clans s ON s.owner_id=a.player_id LEFT JOIN player_equipments e ON e.owner_id=a.player_id WHERE a.clan_id=$1`, [cl.id])).rows.slice(page * 14, page * 14 + 14);
  const w = W(16 + rows.length * 114).writeH(805).writeD(0).writeC(page).writeC(rows.length);
  for (const x of rows) {
    w.writeQ(BigInt(x.player_id)).writeU(String(x.nickname ?? ""), 66).writeC(Number(x.rank)).writeC(Number(x.clan_access)).writeQ(clanStatus(Number(x.status) >>> 0, !!x.online))
      .writeD(Number(x.clan_date)).writeC(Number(x.nick_color)).writeD(Number(x.w)).writeD(Number(x.l)).writeD(Number(x.nc)).writeC(0).writeD(10).writeD(20).writeD(30);
  }
  c.session.send(w.toBytes());
}

/** Auth login: PROTOCOL_CS_MEMBER_INFO_ACK (845) for clan members (excludes self). */
export async function clanMemberInfoAck(p: Account): Promise<Uint8Array> {
  const rows = (await pool.query(`SELECT a.player_id, a.nickname, a.rank, a.online, a.status, COALESCE(s.clan_match_wins,0) AS w, COALESCE(s.clan_match_loses,0) AS l, COALESCE(e.namecard_id,0) AS nc, COALESCE(b.nick_border_color,0) AS nb
    FROM accounts a LEFT JOIN player_stat_clans s ON s.owner_id=a.player_id LEFT JOIN player_equipments e ON e.owner_id=a.player_id LEFT JOIN player_bonus b ON b.owner_id=a.player_id
    WHERE a.clan_id=$1 AND a.player_id<>$2`, [p.clanId, pidS(p)])).rows.filter((x) => String(x.nickname ?? "") !== "" && BigInt(x.player_id) >= 1n);
  // C# writes the count of the list before its skip, so a skipped row left the count wrong; here the count matches the rows written.
  const w = W(16 + rows.length * 96).writeH(845).writeC(rows.length);
  for (const x of rows) {
    const nick = String(x.nickname ?? "");
    w.writeC(nick.length + 1);
    wstrz(w, nick).writeQ(BigInt(x.player_id)).writeQ(clanStatus(Number(x.status) >>> 0, !!x.online)).writeC(Number(x.rank)).writeD(Number(x.w)).writeD(Number(x.l)).writeD(Number(x.nc)).writeC(Number(x.nb)).writeD(10).writeD(20).writeD(30);
  }
  return w.toBytes();
}

export async function handleClanCreate(c: GameClient, r: PacketReader): Promise<void> {
  r.readD();
  const name = r.readU(34), info = r.readU(510);
  // [INFERIDO] the emblem (logo) follows the intro as one D; 0 = no mark (a body without it, as before)
  const logo = r.remaining >= 4 ? r.readD() >>> 0 : 0;
  const p = c.player;
  if (!p) return;
  const ack = (err: number, cl?: ClanRow) => {
    const w = W(1600).writeH(807).writeD(err);
    if (err === 0 && cl) {
      w.writeD(cl.id).writeU(cl.name, 34).writeC(cl.rank).writeC(1).writeC(cl.maxPlayers).writeD(cl.createDate).writeD(cl.logo).zeros(11).writeQ(cl.ownerId)
        .writeS(p.nickname, 66).writeC(p.nickColor).writeC(p.rank).writeU(cl.info, 510).writeU("Temp", 42).writeC(cl.rankLimit).writeC(cl.minAge).writeC(cl.maxAge).writeC(cl.authority)
        .writeU("", 510).zeros(44);
      const f64 = (v: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); w.writeB(b); };
      f64(cl.points); f64(60.0); w.zeros(16); f64(cl.points); f64(60.0); w.zeros(80).zeros(66).writeD(p.gold);
    }
    c.session.send(w.toBytes());
  };
  const pending = Number((await pool.query(`SELECT COUNT(*) AS n FROM system_clan_invites WHERE player_id=$1`, [pidS(p)])).rows[0].n);
  if (p.clanId > 0 || pending > 0) return ack(0x8000105c);
  if (p.gold < config.minCreateGold || p.rank < config.minCreateRank) return ack(0x8000104a);
  if (!name || Number((await pool.query(`SELECT COUNT(*) AS n FROM system_clan WHERE name=$1`, [name])).rows[0].n) > 0) return ack(0x8000105a); // C# set 0x8000105A but never sent 807 (client hung); the error is sent here [INFERIDO]
  // every clan has an emblem: 0 (none) is refused, and an emblem already on another clan gives the same 0x80000000 that 857 gives (C#: IsClanLogoExist) [INFERIDO]
  if (logo === 0 || Number((await pool.query(`SELECT COUNT(*) AS n FROM system_clan WHERE logo=$1`, [logo])).rows[0].n) > 0) return ack(0x80000000);
  // C#: ClanManager.Clans.Count <= ConfigLoader.MaxActiveClans (Settings.ini MaxActiveClans)
  if ((await allClans()).length > config.maxActiveClans) return ack(0x80001055);
  let id = 0;
  // the fee is a conditional debit taken before the clan row (C#: unconditional gold-$1 after it); refunded if the row fails
  if (!(await dao.addMoney(p, -config.minCreateGold))) return ack(0x8000104a);
  try {
    id = Number((await pool.query(`INSERT INTO system_clan (name, owner_id, create_date, info, best_exp, best_participants, best_wins, best_kills, best_headshots, logo) VALUES ($1, $2, $3, $4, '0-0', '0-0', '0-0', '0-0', '0-0', $5) RETURNING id`,
      [name, pidS(p), Number(fmtDate(new Date(), "yyyyMMdd")), info, logo])).rows[0].id);
  } catch { await dao.addMoney(p, config.minCreateGold); return ack(0x80001048); }
  if (!(await dao.updateDB("accounts", "player_id", p.playerId, ["clan_access", "clan_date", "clan_id"], [1, Number(fmtDate(new Date(), "yyyyMMdd")), id]))) return ack(0x80001048);
  if (id <= 0) return ack(0x8000104b);
  p.clanId = id; p.clanAccess = 1;
  p.clan = await dao.getClanDB(id);
  const cl = await clanById(id);
  ack(0, cl ?? undefined);
}

export async function handleClanJoinRequest(c: GameClient, r: PacketReader): Promise<void> {
  const clanId = r.readD(), text = r.readU(r.readC() * 2);
  const p = c.player;
  if (!p) return;
  const ack = (err: number) => { const w = W(12).writeH(813).writeD(err); if ((err | 0) >= 0) w.writeD(clanId); c.session.send(w.toBytes()); };
  if (p.clanId > 0 || !p.nickname) return ack(0x8000105c);
  if (!(await clanById(clanId))) return ack(0x80000000);
  if (Number((await pool.query(`SELECT COUNT(*) AS n FROM system_clan_invites WHERE clan_id=$1`, [clanId])).rows[0].n) >= 100) return ack(0x80001057);
  try { await pool.query(`INSERT INTO system_clan_invites(clan_id, player_id, invite_date, text) VALUES($1, $2, $3, $4)`, [clanId, pidS(p), Number(fmtDate(new Date(), "yyyyMMdd")), text]); }
  catch { return ack(0x80001068); }
  ack(0);
}

export async function handleClanCancelRequest(c: GameClient): Promise<void> {
  const p = c.player;
  if (!p) return;
  const ok = await pool.query(`DELETE FROM system_clan_invites WHERE player_id=$1`, [pidS(p)]).then(() => true, () => false);
  c.session.send(W(8).writeH(815).writeD(ok ? 0 : 0x80000000).toBytes());
}

export async function handleClanSecession(c: GameClient): Promise<void> {
  const p = c.player;
  if (!p) return;
  const ack = (e: number) => c.session.send(W(8).writeH(829).writeD(e).toBytes());
  if (p.clanId <= 0) return ack(0x8000105b);
  const cl = await clanById(p.clanId);
  if (!cl || cl.ownerId === p.playerId) return ack(0x8000105e);
  const ok = (await dao.updateDB("accounts", "player_id", p.playerId, ["clan_id", "clan_access"], [0, 0])) && (await dao.updateDB("player_stat_clans", "owner_id", p.playerId, ["clan_matches", "clan_match_wins"], [0, 0]));
  if (!ok) return ack(0x8000106b);
  const leave = W(12).writeH(849).writeQ(p.playerId).toBytes();
  for (const a of social.online.values()) if (a !== p && a.clanId === p.clanId) social.send(a, leave);
  const owner = social.online.get(cl.ownerId) ?? (await social.byPid(cl.ownerId));
  if (owner && Number((await pool.query(`SELECT COUNT(*) AS n FROM player_messages WHERE owner_id=$1`, [String(owner.playerId)])).rows[0].n) < 100) {
    await createNote(owner, { senderId: p.playerId, senderName: cl.name, type: 4, text: p.nickname, clanId: cl.id, clanNote: 6, days: 15 });
  }
  p.clanId = 0; p.clanAccess = 0;
  p.clan = await dao.getClanDB(0);
  ack(0);
}

export async function handleClanChat(c: GameClient, r: PacketReader): Promise<void> {
  const type = r.readH(), text = r.readU(r.readH() * 2);
  const p = c.player;
  if (!p || type !== 5 || !text || text.length > 60 || p.clanId <= 0 || p.durationSince("chatting") < 1) return;
  const b = await banState(p);
  if (b === "ban") return c.session.send(announce("Your account is banned."));
  if (b === "mute") return c.session.send(announce("You are muted and cannot use clan chat."));
  const w = W(64 + text.length * 2).writeH(855).writeC(p.nickname.length + 1);
  wstrz(w, p.nickname).writeC(p.useChatGM(p.hideGMcolor) ? 1 : 0).writeC(p.nickColor).writeC(text.length + 1);
  wstrz(w, text);
  const pkt = w.toBytes();
  for (const a of social.online.values()) if (a.clanId === p.clanId) social.send(a, pkt);
  p.last.chatting = Date.now();
}

// ---- gifts -------------------------------------------------------------------------------------------------------------
export function handleGiftList(c: GameClient): void { c.session.send(W(4).writeH(1044).writeH(0).toBytes()); }

// ---- season challenge ------------------------------------------------------------------------------------------------
export function handleSeasonInfo(c: GameClient): void { if (c.player) c.session.send(seasonChallengeInfoAck(c.player)); }

/** Auth SendRefresh.RefreshAccount (sync op 11 in C#): online friends get 1815 Update (Online/Offline), online clan
 * members get 851 {Q pid, Q clanStatus}. */
export async function refreshAccount(p: Account, connect: boolean): Promise<void> {
  const st = connect ? FS.Online : FS.Offline;
  for (const f of p.friends) {
    const a = social.online.get(f.playerId);
    if (!a) continue;
    const i2 = a.friends.findIndex((x) => x.playerId === p.playerId);
    if (i2 >= 0 && a.friends[i2].state === 0) social.send(a, await friendChangeAck(4, a.friends[i2], i2, st));
  }
  if (p.clanId > 0) {
    const pkt = W(20).writeH(851).writeQ(p.playerId).writeQ(BigInt((st << 28) >>> 0)).toBytes();
    for (const a of social.online.values()) if (a.clanId === p.clanId && a.playerId !== p.playerId) social.send(a, pkt);
  }
}
