// Clan ops beyond the list/enter/create core of socialHandlers.ts (Server.Game PROTOCOL_CS_* ports): 808 close, 810 join
// authority, 816/818/820 request context/list/info, 822 accept, 825 deny, 830 deport, 833/836/839 commission master/staff/
// regular, 856 check mark, 858/860 notice/intro, 868 management, 877 room invite, 886 page chat, 888/890 invite/accept,
// 892 clan note, 916 create condition. 918 CHECK_DUPLICATE stays the C# STUB (always 0, gameServer.ts).
// ClanManager is the system_clan table (no in-memory cache in the TS port); SendClanInfo (cross-server sync) goes away
// because Auth and Game share this process.
import { PacketWriter, type PacketReader } from "../../../src/net/packet.ts";
import { pool } from "../db.ts";
import { config } from "../config.ts";
import type { Account } from "../shared/account.ts";
import * as dao from "../shared/dao.ts";
import { fmtDate } from "../shared/time.ts";
import { roomOf } from "./roomHandlers.ts";
import { dropTeamOf } from "./clanWarHandlers.ts";
import { slotOneInfoAck } from "./roomPackets.ts";
import { social, wstrz, banState, announce, clanById, clanStatus, clanUnit, createNote, clanMemberInfoAck, type ClanRow } from "./socialHandlers.ts";
import type { GameClient } from "./gameServer.ts";

const W = (n = 64) => new PacketWriter(n);
const err = (op: number, e: number) => W(8).writeH(op).writeD(e >>> 0).toBytes();
const today = () => Number(fmtDate(new Date(), "yyyyMMdd"));
const NC = { Invite: 1, InviteAccept: 2, InviteDenial: 3, JoinAccept: 4, JoinDenial: 5, Secession: 6, Deportation: 7, Master: 8, Staff: 9, Regular: 10 };
const NT = { Clan: 4, ClanAsk: 5 };
const messages = async (pid: bigint) => Number((await pool.query(`SELECT COUNT(*) AS n FROM player_messages WHERE owner_id=$1`, [String(pid)])).rows[0].n);
/** AccountManager.GetAccount(id, 31): online first, then the DB. */
const account = async (pid: bigint) => social.online.get(pid) ?? (await social.byPid(pid));
const isOnline = (a: Account) => social.online.get(a.playerId) === a && !!a.connection;
/** ClanManager.GetClanPlayers(clanId, -1, true) restricted to the online ones (ClanManager.SendPacket skips offline accounts). */
const onlineMembers = (clanId: number, except = -1n) => (clanId > 0 ? [...social.online.values()].filter((a) => a.clanId === clanId && a.playerId !== except) : []);
const memberCountDB = async (clanId: number) => Number((await pool.query(`SELECT COUNT(*) AS n FROM accounts WHERE clan_id=$1`, [clanId])).rows[0].n);
const clanNote = (owner: Account, cl: ClanRow, sender: bigint, clanNote: number, type = NT.Clan, text = "") =>
  createNote(owner, { senderId: sender, senderName: cl.name, type, text, clanId: cl.id, clanNote, days: 15 });

/** PROTOCOL_CS_MEMBER_INFO_INSERT_ACK (847). */
async function memberInsertAck(a: Account): Promise<Uint8Array> {
  const w = W(128).writeH(847).writeC(a.nickname.length + 1);
  wstrz(w, a.nickname).writeQ(a.playerId).writeQ(clanStatus(a.status.buffer >>> 0, isOnline(a))).writeC(a.rank).writeC(a.nickColor);
  const s = (await pool.query(`SELECT clan_match_wins AS w, clan_match_loses AS l FROM player_stat_clans WHERE owner_id=$1`, [String(a.playerId)])).rows[0];
  return w.writeD(Number(s?.w ?? 0)).writeD(Number(s?.l ?? 0)).writeD(a.equipment.nameCardId).writeC(a.bonus.nickBorderColor).writeD(10).writeD(20).writeD(30).toBytes();
}
/** PROTOCOL_CS_ACCEPT_REQUEST_RESULT_ACK (824). */
async function acceptResultAck(cl: ClanRow, owner: Account | null, count: number): Promise<Uint8Array> {
  const w = W(1300).writeH(824).writeD(cl.id).writeU(cl.name, 34).writeC(cl.rank).writeC(count).writeC(cl.maxPlayers).writeD(cl.createDate).writeD(cl.logo).writeC(cl.nameColor)
    .writeC(cl.effects).writeC(clanUnit(await memberCountDB(cl.id))).writeD(cl.exp).writeD(10).writeQ(cl.ownerId).writeU(owner?.nickname ?? "", 66).writeC(owner?.nickColor ?? 0).writeC(owner?.rank ?? 0)
    .writeU(cl.info, 510).writeU("Temp", 42).writeC(cl.rankLimit).writeC(cl.minAge).writeC(cl.maxAge).writeC(cl.authority).writeU(cl.news, 510);
  return w.writeD(cl.matches).writeD(cl.wins).writeD(cl.loses).writeD(cl.matches).writeD(cl.wins).writeD(cl.loses).toBytes();
}
const basic = (a: Account) => a.statistic.basic ?? { killsCount: 0, deathsCount: 0, matches: 0, matchWins: 0, matchLoses: 0 };

// ---- 808 / 810 / 916 ----
/** Close cleanup [INFERIDO]: C# clears only the owner row, so every other member kept a dangling clan_id and the
 * pending requests stayed. Here members, their clan stats and the requests are cleared too; online members get 832
 * (the deport result) so their client drops the clan. */
async function releaseMembers(clanId: number): Promise<void> {
  await pool.query(`DELETE FROM system_clan_invites WHERE clan_id=$1`, [clanId]).catch(() => {});
  const ids = (await pool.query(`SELECT player_id FROM accounts WHERE clan_id=$1`, [clanId])).rows.map((x) => BigInt(String(x.player_id)));
  if (ids.length === 0) return;
  await pool.query(`UPDATE accounts SET clan_id=0, clan_access=0 WHERE clan_id=$1`, [clanId]).catch(() => {});
  for (const pid of ids) {
    await dao.updateDB("player_stat_clans", "owner_id", pid, ["clan_matches", "clan_match_wins"], [0, 0]);
    const a = social.online.get(pid);
    if (!a) continue;
    await dropTeamOf(a);
    a.clanId = 0; a.clanAccess = 0; a.clan = await dao.getClanDB(0);
    if (isOnline(a)) social.send(a, W(4).writeH(832).toBytes());
  }
}

export async function handleCloseClan(c: GameClient): Promise<void> {
  const p = c.player;
  if (!p) return;
  const cl = await clanById(p.clanId);
  let e = 0;
  if (cl && cl.ownerId === p.playerId && (await pool.query(`DELETE FROM system_clan WHERE id=$1`, [cl.id]).then(() => true, () => false))
    && (await dao.updateDB("accounts", "player_id", p.playerId, ["clan_id", "clan_access"], [0, 0]))
    && (await dao.updateDB("player_stat_clans", "owner_id", p.playerId, ["clan_matches", "clan_match_wins"], [0, 0]))) {
    p.clanId = 0; p.clanAccess = 0; p.clan = await dao.getClanDB(0);
    await releaseMembers(cl.id);
  } else e = 0x8000106a;
  c.session.send(err(809, e));
}

export async function handleCheckJoinAuthority(c: GameClient, r: PacketReader): Promise<void> {
  const id = r.readD();
  const p = c.player;
  if (!p) return;
  const cl = await clanById(id);
  c.session.send(err(811, cl ? (cl.rankLimit > p.rank ? 0x8000107b : 0) : 0x80000000));
}

export const handleCreateClanCondition = (c: GameClient) => c.session.send(W(8).writeH(917).writeC(config.minCreateRank).writeD(config.minCreateGold).toBytes());

// ---- join requests 816 / 818 / 820 / 822 / 825 ----
export async function handleRequestContext(c: GameClient): Promise<void> {
  const p = c.player;
  if (!p) return;
  // PROTOCOL_CS_REQUEST_CONTEXT_ACK(ClanId): Field0 = 0 when the invite count loads, the count in Field1 (C# ctor)
  const n = p.clanId > 0 ? Number((await pool.query(`SELECT COUNT(*) AS n FROM system_clan_invites WHERE clan_id=$1`, [p.clanId])).rows[0].n) : -1;
  if (n < 0) return c.session.send(err(817, 0xffffffff));
  c.session.send(W(16).writeH(817).writeD(0).writeC(n).writeC(13).writeC(Math.ceil(n / 13)).writeD(Number(fmtDate(new Date(), "MMddHHmmss")) >>> 0).toBytes());
}

export async function handleRequestList(c: GameClient, r: PacketReader): Promise<void> {
  const page = r.readC();
  const p = c.player;
  if (!p) return;
  if (p.clanId === 0) return c.session.send(err(819, 0xffffffff));
  const list = (await pool.query(`SELECT * FROM system_clan_invites WHERE clan_id=$1`, [p.clanId])).rows;
  const body = W(2048);
  let n = 0;
  for (let i = page * (page !== 0 ? 14 : 13); i < list.length; i++) {
    const inv = list[i], pid = BigInt(String(inv.player_id)), date = Number(inv.invite_date) >>> 0;
    body.writeQ(pid);
    const a = await account(pid);
    if (a) {
      const b = basic(a), text = String(inv.text ?? "");
      body.writeU(a.nickname, 66).writeC(a.rank).writeC(a.nickColor).writeD(date).writeD(b.killsCount).writeD(b.deathsCount).writeD(b.matches).writeD(b.matchWins).writeD(b.matchLoses);
      wstrz(body, text);
    }
    body.writeD(date);
    if (++n === 13) break;
  }
  // C# PROTOCOL_CS_REQUEST_LIST_ACK writes the page (Field1) before the count (Field2)
  c.session.send(W(2100).writeH(819).writeD(0).writeC(page).writeC(n).writeB(body.toBytes()).toBytes());
}

export async function handleRequestInfo(c: GameClient, r: PacketReader): Promise<void> {
  const pid = r.readQ();
  const p = c.player;
  if (!p) return;
  const text = (await pool.query(`SELECT text FROM system_clan_invites WHERE clan_id=$1 AND player_id=$2`, [p.clanId, String(pid)])).rows[0]?.text as string | undefined;
  const a = await account(pid);
  // PROTOCOL_CS_REQUEST_INFO_ACK: 0x80000000 when the account or the text is missing
  if (!a || text == null) return c.session.send(err(821, 0x80000000));
  const b = basic(a);
  const w = W(256).writeH(821).writeD(0).writeQ(a.playerId).writeU(a.nickname, 66).writeC(a.rank).writeD(b.killsCount).writeD(b.deathsCount).writeD(b.matches).writeD(b.matchWins).writeD(b.matchLoses);
  c.session.send(wstrz(w, String(text)).toBytes());
}

async function readIds(r: PacketReader): Promise<bigint[]> { const n = r.readC(), ids: bigint[] = []; for (let i = 0; i < n; i++) ids.push(r.readQ()); return ids; }
const staff = (p: Account, cl: ClanRow) => (p.clanAccess >= 1 && p.clanAccess <= 2) || p.playerId === cl.ownerId;

export async function handleAcceptRequest(c: GameClient, r: PacketReader): Promise<void> {
  const ids = await readIds(r);
  const p = c.player;
  if (!p) return;
  const cl = await clanById(p.clanId);
  let res = 0;
  if (cl && staff(p, cl)) {
    let count = await memberCountDB(cl.id);
    if (count >= cl.maxPlayers) return; // C#: returns inside the try before the 823 (kept)
    for (const id of ids) {
      const a = await account(id);
      // Only a request made to this clan counts. C# checks the player's request for any clan, so a player who asked
      // clan X could be pulled into clan Y; this port fixes that divergence.
      const invited = a ? (await pool.query(`SELECT 1 FROM system_clan_invites WHERE clan_id=$1 AND player_id=$2`, [cl.id, String(a.playerId)])).rows.length > 0 : false;
      if (!a || !(count < cl.maxPlayers) || a.clanId !== 0 || !invited) continue;
      const change = W(20).writeH(851).writeQ(a.playerId).writeQ(clanStatus(a.status.buffer >>> 0, isOnline(a))).toBytes();
      for (const m of onlineMembers(cl.id)) social.send(m, change);
      a.clanId = p.clanId; a.clanDate = today(); a.clanAccess = 3;
      await dao.updateDB("accounts", "player_id", a.playerId, ["clan_access", "clan_id", "clan_date"], [a.clanAccess, a.clanId, a.clanDate]);
      await pool.query(`DELETE FROM system_clan_invites WHERE clan_id=$1 AND player_id=$2`, [p.clanId, String(a.playerId)]).catch(() => {});
      if (isOnline(a)) {
        a.clan = await dao.getClanDB(a.clanId);
        social.send(a, await clanMemberInfoAck(a));
        const room = roomOf(a);
        if (room) room.sendAboutSlot(a.slotId, slotOneInfoAck(a, room));
        social.send(a, await acceptResultAck(cl, await account(cl.ownerId), count + 1));
      }
      if ((await messages(a.playerId)) < 100) await clanNote(a, cl, p.playerId, NC.InviteAccept);
      res++; count++;
    }
  } else res = -1;
  c.session.send(err(823, res));
}

export async function handleDenialRequest(c: GameClient, r: PacketReader): Promise<void> {
  const ids = await readIds(r);
  const p = c.player;
  if (!p) return;
  const cl = await clanById(p.clanId);
  let n = 0;
  if (cl && staff(p, cl)) {
    for (const id of ids) {
      if (!(await pool.query(`DELETE FROM system_clan_invites WHERE clan_id=$1 AND player_id=$2`, [cl.id, String(id)]).then(() => true, () => false))) continue;
      if ((await messages(id)) < 100) { const a = await account(id); if (a) await clanNote(a, cl, p.playerId, NC.InviteDenial); }
      n++;
    }
  }
  c.session.send(err(826, n));
}

// ---- members 830 / 833 / 836 / 839 ----
/** C# also skips accounts with Account.Match != null (clan-war team). Clan war (6916-6965, 7699) is not ported, so the check is absent. */
export async function handleDeportation(c: GameClient, r: PacketReader): Promise<void> {
  const ids = await readIds(r);
  const p = c.player;
  if (!p) return;
  const cl = await clanById(p.clanId);
  if (!cl || !staff(p, cl)) return; // C#: sets 0x80001059 but never sends it (kept)
  let res = 0;
  for (const id of ids) {
    const a = await account(id);
    if (a && a.clanId === cl.id && (await dao.updateDB("accounts", "player_id", a.playerId, ["clan_id", "clan_access"], [0, 0]))
      && (await dao.updateDB("player_stat_clans", "owner_id", a.playerId, ["clan_matches", "clan_match_wins"], [0, 0]))) {
      const del = W(12).writeH(849).writeQ(a.playerId).toBytes();
      for (const m of onlineMembers(cl.id, a.playerId)) social.send(m, del);
      await dropTeamOf(a);
      a.clanId = 0; a.clanAccess = 0; a.clan = await dao.getClanDB(0);
      if ((await messages(a.playerId)) < 100) await clanNote(a, cl, p.playerId, NC.Deportation);
      if (isOnline(a)) social.send(a, W(4).writeH(832).toBytes());
      res++;
      continue;
    }
    res = 0x80001059;
    break;
  }
  c.session.send(err(831, res));
}

export async function handleCommissionMaster(c: GameClient, r: PacketReader): Promise<void> {
  const target = r.readQ();
  const p = c.player;
  if (!p || p.clanAccess !== 1) return;
  const a = await account(target);
  let e = 0;
  if (a && a.clanId === p.clanId) {
    if (a.rank <= 10) e = 0x800010b8;
    else {
      const cl = await clanById(p.clanId);
      if (cl && cl.ownerId === p.playerId && a.clanAccess === 2 && (await dao.update1("system_clan", "owner_id", String(target), "id", cl.id))
        && (await dao.update1("accounts", "clan_access", 1, "player_id", target)) && (await dao.update1("accounts", "clan_access", 2, "player_id", p.playerId))) {
        a.clanAccess = 1; p.clanAccess = 2; cl.ownerId = target;
        if ((await messages(a.playerId)) < 100) await clanNote(a, cl, p.playerId, NC.Master);
        if (isOnline(a)) social.send(a, W(4).writeH(835).toBytes());
      } else e = 0x80001000;
    }
  } else e = 0x80000000;
  c.session.send(err(834, e));
}

async function commission(c: GameClient, r: PacketReader, from: number, to: number, op: number, result: number, note: number, who: (p: Account, cl: ClanRow) => boolean): Promise<void> {
  const ids = await readIds(r);
  const p = c.player;
  if (!p) return;
  const cl = await clanById(p.clanId);
  if (!cl || !who(p, cl)) return; // C#: 0x80001059 is set but never sent (kept)
  let n = 0;
  for (const id of ids) {
    const a = await account(id);
    if (!a || a.clanId !== cl.id || a.clanAccess !== from || !(await dao.update1("accounts", "clan_access", to, "player_id", a.playerId))) continue;
    a.clanAccess = to;
    if ((await messages(a.playerId)) < 100) await clanNote(a, cl, p.playerId, note);
    if (isOnline(a)) social.send(a, W(4).writeH(result).toBytes());
    n++;
  }
  c.session.send(err(op, n));
}
export const handleCommissionStaff = (c: GameClient, r: PacketReader) => commission(c, r, 3, 2, 837, 838, NC.Staff, (p, cl) => p.clanAccess === 1 || cl.ownerId === p.playerId);
export const handleCommissionRegular = (c: GameClient, r: PacketReader) => commission(c, r, 2, 3, 840, 841, NC.Regular, staff);

// ---- edit 856 / 858 / 860 / 868 ----
export async function handleCheckMark(c: GameClient, r: PacketReader): Promise<void> {
  const logo = r.readD() >>> 0;
  const p = c.player;
  // C#: ClanManager.GetClan(player.ClanId).Logo (live row; uint.MaxValue when no clan)
  const own = p ? ((await clanById(p.clanId))?.logo ?? 0xffffffff) : 0xffffffff;
  const exists = Number((await pool.query(`SELECT COUNT(*) AS n FROM system_clan WHERE logo=$1`, [logo])).rows[0].n) > 0;
  c.session.send(err(857, !p || own === logo || exists ? 0x80000000 : 0));
}

async function replaceText(c: GameClient, r: PacketReader, col: "news" | "info", op: number, dbErr: number): Promise<void> {
  const text = r.readU(r.readC() * 2);
  const p = c.player;
  if (!p) return;
  const cl = await clanById(p.clanId);
  let e = 0;
  if (cl && cl[col] !== text && (cl.ownerId === p.playerId || (p.clanAccess >= 1 && p.clanAccess <= 2))) {
    if (!(await dao.update1("system_clan", col, text, "id", cl.id))) e = dbErr;
  } else e = 0x8000105b;
  c.session.send(err(op, e));
}
export const handleReplaceNotice = (c: GameClient, r: PacketReader) => replaceText(c, r, "news", 859, 0x80001073);
export const handleReplaceIntro = (c: GameClient, r: PacketReader) => replaceText(c, r, "info", 861, 0x80001074);

export async function handleReplaceManagement(c: GameClient, r: PacketReader): Promise<void> {
  const authority = r.readC(), rankLimit = r.readC(), maxAge = r.readC(), minAge = r.readC(), join = r.readC();
  const p = c.player;
  if (!p) return;
  const cl = await clanById(p.clanId);
  let e = 0;
  if (cl && cl.ownerId === p.playerId) {
    await pool.query(`UPDATE system_clan SET authority=$1, rank_limit=$2, min_age_limit=$3, max_age_limit=$4, join_permission=$5 WHERE id=$6`, [authority, rankLimit, minAge, maxAge, join, cl.id]).catch(() => {});
  } else e = 0x80000000;
  c.session.send(err(869, e));
}

// ---- 877 room invite / 886 page chat / 888 + 890 invite / 892 note ----
// [web] Opções da sala > Convidar (rrInviteWin): só o dono da sala convida, e só quem está online, fora de sala, no mesmo canal.
// The target is the lobby list session id (3677 rows), not the playerId: the web lobby list (LobbyPlayer) carries no playerId.
// A regra de clã de não vale aqui (o convite vem da lista do lobby).
export async function handleRoomInvited(c: GameClient, r: PacketReader): Promise<void> {
  const sessionId = Number(r.readQ());
  const p = c.player;
  if (!p) return;
  const room = roomOf(p);
  if (!room || room.getLeader()?.playerId !== p.playerId) return;
  // Session ids are numbered per game server, so the same id can belong to a player on another server: match server and channel too.
  const a = [...social.online.values()].find((x) => x.session?.sessionId === sessionId && x.serverId === p.serverId && x.channelId === p.channelId);
  if (!a || a.playerId === p.playerId || roomOf(a)) return;
  social.send(a, W(96).writeH(3077).writeU(p.nickname, 66).writeD(room.roomId).writeQ(p.playerId).writeS(room.password, 4).toBytes());
}

export async function handlePageChat(c: GameClient, r: PacketReader): Promise<void> {
  const type = r.readH(), text = r.readU(r.readH() * 2);
  const p = c.player;
  if (!p || type !== 8 || p.durationSince("chatting") < 1) return; // ChattingType.ClanMemberPage
  const b = await banState(p);
  if (b === "ban") return c.session.send(announce("Your account is banned."));
  if (b === "mute") return c.session.send(announce("You are muted and cannot use clan page chat."));
  const w = W(64 + text.length * 2).writeH(887).writeC(0).writeC(p.nickname.length + 1);
  wstrz(w, p.nickname).writeC(p.useChatGM(p.hideGMcolor) ? 1 : 0).writeC(p.nickColor).writeC(text.length + 1);
  wstrz(w, text);
  const pkt = w.toBytes();
  for (const a of onlineMembers(p.clanId)) social.send(a, pkt);
  p.last.chatting = Date.now();
}

export async function handleInvite(c: GameClient): Promise<void> {
  const p = c.player;
  if (!p || p.clanId === 0 || p.durationSince("clanInvite") < 1 || !p.findPlayer) return;
  const a = await social.byNick(p.findPlayer);
  const cl = await clanById(p.clanId);
  let e = 0;
  // [INFERIDO] autoridade de convidar = staff (dono ou auxiliar, clanAccess 1|2), o mesmo gate do cliente (canClanInvite); o C# não checa
  if (!a || !cl || !staff(p, cl)) e = 0x80000000;
  else if (a.clanId === 0 && p.clanId !== 0) {
    if ((await messages(a.playerId)) >= 100) e = 0x80000000;
    else { await createNote(a, { senderId: p.playerId, senderName: cl.name, type: NT.ClanAsk, text: "", clanId: p.clanId, clanNote: NC.Invite, days: 15 }); }
  } else e = 0x80000000;
  c.session.send(err(889, e));
  p.last.clanInvite = Date.now();
}

export async function handleInviteAccept(c: GameClient, r: PacketReader): Promise<void> {
  const clanId = r.readD(), accept = r.readC();
  const p = c.player;
  if (!p || !p.nickname) return;
  const cl = await clanById(clanId);
  if (!cl) return c.session.send(err(891, 0x8000105b));
  if (p.clanId > 0) return c.session.send(err(891, 0x80001058));
  const count = await memberCountDB(cl.id);
  if (!(cl.maxPlayers > count)) return c.session.send(err(891, 0x80001056));
  if (accept !== 0 && accept !== 1) return;
  let e = 0;
  const owner = await account(cl.ownerId);
  if (owner) {
    if ((await messages(cl.ownerId)) < 100) await clanNote(owner, cl, p.playerId, accept === 0 ? NC.JoinDenial : NC.JoinAccept, NT.Clan, p.nickname);
    if (accept === 1) {
      const d = today();
      if (await dao.updateDB("accounts", "player_id", p.playerId, ["clan_id", "clan_access", "clan_date"], [cl.id, 3, d])) {
        const ins = await memberInsertAck(p);
        for (const m of onlineMembers(cl.id)) social.send(m, ins);
        p.clanId = cl.id; p.clanDate = d; p.clanAccess = 3; p.clan = await dao.getClanDB(cl.id);
        c.session.send(await clanMemberInfoAck(p));
        { const room = roomOf(p); if (room) room.sendAboutSlot(p.slotId, slotOneInfoAck(p, room)); }
        c.session.send(await acceptResultAck(cl, owner, count + 1));
      } else e = 0x80000000;
    }
  } else e = 0x80000000;
  c.session.send(err(1922, e));
}

export async function handleClanNote(c: GameClient, r: PacketReader): Promise<void> {
  const target = r.readC(), text = r.readU(r.readC() * 2);
  const p = c.player;
  if (text.length > 120 || !p) return;
  const cl = await clanById(p.clanId);
  let n = 0;
  if (cl && cl.ownerId === p.playerId) {
    const rows = (await pool.query(`SELECT player_id, clan_access FROM accounts WHERE clan_id=$1 AND player_id<>$2`, [cl.id, String(p.playerId)])).rows;
    for (const x of rows) {
      const access = Number(x.clan_access), pid = BigInt(String(x.player_id));
      if ((target === 0 || (access === 2 && target === 1) || (access === 3 && target === 2)) && (await messages(pid)) < 100) {
        n++;
        const a = await account(pid);
        if (a) await createNote(a, { senderId: p.playerId, senderName: cl.name, type: NT.Clan, text, clanId: cl.id, clanNote: 0, days: 15 });
      }
    }
  }
  c.session.send(err(893, n));
  if (n > 0) c.session.send(err(1922, 0));
}
