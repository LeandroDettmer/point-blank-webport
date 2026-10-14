// TS port of Server.Game (F2 + the F3 inventory/equip/shop handlers): GameManager listeners (one per game server
// row of system_servers), GameClient.ProcessPacket dispatch, USER_ENTER, SELECT_CHANNEL, lobby, inventory, equip and
// shop. Rooms/battle live in ./roomHandlers.ts. Wire format identical to the .NET GameClient (tcpSession.ts).
import net from "node:net";
import { PacketWriter, type PacketReader } from "../../../src/net/packet.ts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { config } from "../config.ts";
import * as db from "../db.ts";
import { TcpSession } from "../net/tcpSession.ts";
import { Account, AccessLevel } from "../shared/account.ts";
import * as dao from "../shared/dao.ts";
import * as pu from "../shared/playerUtils.ts";
import { runningQuestEvent } from "../shared/data.ts";
import { shop, getGood } from "../shared/shop.ts";
import { getIdStatics } from "../shared/items.ts";
import { pointCashAck, channelListAck, gameServerStateAck, accountKickAck, serverMessageErrorAck, SChannelType, parseEnum, type ChannelEntry, type ServerEntry } from "../auth/packets.ts";
import { getCharaInfoAck, equipmentDataChara } from "../auth/metaPackets.ts";
import { ChannelModel, GameServerState, loadChannels, type PlayerSession } from "./channel.ts";
import { RoomModel, RoomState, SlotState, loadMaps } from "./roomModel.ts";
import * as gp from "./packets.ts";
import * as rp from "./roomPackets.ts";
import * as rh from "./roomHandlers.ts";
import * as ih from "./itemHandlers.ts";
import * as ph from "./profileHandlers.ts";
import * as sh from "./socialHandlers.ts";
import { lobbyChatAck } from "./socialHandlers.ts";
import { GM_MARK } from "./chatGuard.ts";
import * as pg from "./progress.ts";
import * as gmc from "./gmCommands.ts";
import * as ch from "./clanHandlers.ts";
import * as cw from "./clanWarHandlers.ts";
import { handleExtraPacket } from "./extraHandlers.ts";
import * as reports from "./reports.ts";
import * as voteKick from "./voteKick.ts";
import * as voteLeader from "./voteLeader.ts";
import { handleBugReport } from "./bugReports.ts";
import { signalGate, signalKey } from "../web/signal.ts";
import { readEnterTicket } from "../web/signalTicket.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} [game-ts] ${m}`);

/** Every account connected to any TS game server (AccountManager.Accounts for online players). */
export const onlineAccounts = new Map<bigint, Account>();
const states = new Map<number, GameServerState>();
export const gameStates = states;

export class GameClient {
  session!: TcpSession;
  player: Account | null = null;
  readonly state: GameServerState;
  readonly serverId: number;
  constructor(state: GameServerState) {
    this.state = state;
    this.serverId = state.info.id;
  }
  channelOf(p: Account): ChannelModel | null { return p.channelId >= 0 ? this.state.getChannel(p.channelId) : null; }
  newRoom(id: number, ch: ChannelModel): RoomModel {
    const r = new RoomModel(id, ch, roomServices);
    r.buildSlotInfo = (hide) => rp.slotInfoAck(r, hide);
    r.buildRoomInfo = () => rp.changeRoomInfoAck(r);
    return r;
  }
}

const roomServices = {
  getAccount: (pid: bigint) => onlineAccounts.get(pid) ?? null,
  send: (a: Account, b: Uint8Array) => (a.connection as GameClient | null)?.session.send(b),
  updateStatus: async (a: Account) => { await dao.update1("accounts", "status", a.status.buffer, "player_id", a.playerId); },
};

const updateStatus = (a: Account) => dao.update1("accounts", "status", a.status.buffer, "player_id", a.playerId);

// ---- USER_ENTER ----------------------------------------------------------------------------------------------------

/**
 * Server.Game Sync AuthLogin.Load (sync op 10, sent by the Auth's AuthLogin.SendLoginKickInfo when the account logs in again):
 * the account's live Game session gets PROTOCOL_AUTH_ACCOUNT_KICK_ACK(1) + SERVER_MESSAGE_ERROR_ACK(0x80001000) and closes in
 * 1 s (Account.Close(1000) = GameClient.Close(1000, true)). The 2017 exe shows STBL_IDX_EP_GAME_DRIVE_AWAY_LOGIN_E ("conexão
 * simultânea") for kick reason 1 (switch at 0x769a42 / 0x7aa810); the C# ACCOUNT_KICK_ACK.Write drops its argument (byte 0),
 * kept as is (which byte carries the reason is not confirmed). Here a direct call: Auth and Game share the process.
 * true = there was a live session.
 */
export function kickGameSession(pid: bigint): boolean {
  const s = (onlineAccounts.get(pid)?.connection as GameClient | null | undefined)?.session;
  if (!s || s.closed) return false;
  s.send(accountKickAck());
  s.send(serverMessageErrorAck(0x80001000));
  s.close(true, 1000);
  return true;
}

/** accounts between the ticket check and onlineAccounts.set (USER_ENTER awaits the DB): a 2nd USER_ENTER meanwhile is refused */
const entering = new Set<bigint>();

export async function handleUserEnter(c: GameClient, r: PacketReader): Promise<void> {
  const username = r.readS(r.readC());
  const playerId = r.readQ();
  if (c.player) { c.session.send(gp.userEnterAck(0x80000000)); c.session.close(true); return; }
  const refuse = (why: string) => {
    c.session.send(gp.userEnterAck(0x80000000));
    log(`USER_ENTER refused pid ${playerId} from ${c.session.ip}: ${why}`);
    c.session.close(true);
  };
  // [web]the C# trusted the playerId because its Auth had told this Game about the login (internal sync).
  // Here the proof is the enter ticket the Auth handed to the client at LOGIN (web/signalTicket.ts), sent as a WS text frame
  // before this packet (web/wsSocket.ts); a raw TCP socket has none and is refused. Same answer as the C# refusal (FAIL).
  const t = readEnterTicket((c.session.sock as { enterTicket?: string | null }).enterTicket);
  if (t !== playerId) return refuse(t === null ? "no valid enter ticket" : `ticket of pid ${t}`);
  // one Game session per account, as the original's Auth guaranteed: the live one is kicked (DRIVE_AWAY_LOGIN), this one refused
  if (entering.has(playerId)) return refuse("already entering");
  if (kickGameSession(playerId)) return refuse("account already in a Game session (that one kicked)");
  entering.add(playerId);
  try { await enterAccount(c, username, playerId); } finally { entering.delete(playerId); }
}

async function enterAccount(c: GameClient, username: string, playerId: bigint): Promise<void> {
  const p = await dao.getAccountDB("player_id", playerId, 31);
  if (!p || (username && p.username !== username) || p.status.serverId === 255) {
    c.session.send(gp.userEnterAck(0x80000000));
    log(`USER_ENTER refused pid ${playerId} (${p ? `status.server ${p.status.serverId}` : "no account"})`);
    c.session.close(true);
    return;
  }
  p.connection = c;
  p.serverId = c.serverId;
  await dao.getAccountInfos(p, 7935);
  await pu.validateAuthLevel(p);
  await pu.loadPlayerInventory(p);
  await pu.loadPlayerMissions(p);
  // AllUtils.EnableQuestMission (in memory only)
  if (p.event.lastQuestFinish === 0 && runningQuestEvent() && !p.mission.ownsCardSet(13)) {
    const slot = p.mission.findFreeSlot();
    if (slot >= 0) p.mission.at(slot).cardSetId = 13;
  }
  await pu.validatePlayerInventoryStatus(p); // Game CreateCharacter also sends 3334 + 6146 (only when a char item lacks a character)
  p.clan = await dao.getClanDB(p.clanId);
  p.session = { sessionId: c.session.sessionId, playerId: p.playerId };
  p.status.serverId = c.serverId & 0xff;
  await updateStatus(p);
  onlineAccounts.set(p.playerId, p);
  c.player = p;
  await dao.update1("accounts", "ip4_address", c.session.ip, "player_id", p.playerId);
  c.session.send(gp.userEnterAck(0));
  c.session.send(gp.myInfoBasicAck(p, p.clan));
  c.session.send(gp.invItemDataAck(p));
  c.session.send(pointCashAck(0, p));
  c.session.send(gp.myInfoRecordAck(p));
  c.session.send(getCharaInfoAck(p));
  c.session.send(gp.changeInventoryAck(p));
  log(`enter pid ${p.playerId} ${p.nickname} on server ${c.serverId}`);
}

// ---- channel / lobby -------------------------------------------------------------------------------------------------

/** AllUtils.ChannelRequirementCheck: true = blocked. */
function channelBlocked(p: Account, ch: ChannelModel): boolean {
  if (p.isGM()) return false;
  const kd = (s: Record<string, number> | null) => (!s || (s.headshotsCount <= 0 && s.killsCount <= 0) ? 0 : Math.floor((s.killsCount * 100 + 0.5) / (s.killsCount + s.deathsCount)));
  if (ch.type === 4 && p.clanId === 0) return true;
  if (ch.type === 3 && kd(p.statistic.basic) > 40 && kd(p.statistic.season) > 40) return true;
  if (ch.type === 2 && p.rank >= 4) return true;
  if (ch.type === 5 && p.rank <= 25) return true;
  return ch.type === -1;
}

async function handleSelectChannel(c: GameClient, r: PacketReader): Promise<void> {
  r.skip(4);
  const chId = (r.readH() << 16) >> 16;
  const p = c.player;
  if (!p || p.channelId >= 0) return;
  const ch = c.state.getChannel(chId);
  if (!ch) return c.session.send(gp.selectChannelAck(0x80000000));
  if (channelBlocked(p, ch)) return c.session.send(gp.selectChannelAck(0x80000202));
  if (ch.players.length >= c.state.info.channelPlayers) return c.session.send(gp.selectChannelAck(0x80000201));
  p.serverId = ch.serverId;
  p.channelId = ch.id;
  c.session.send(gp.selectChannelAck(0, p.serverId, p.channelId));
  p.status.serverId = p.serverId & 0xff;
  await updateStatus(p);
  p.status.channelId = p.channelId & 0xff;
  await updateStatus(p);
}

function handleLobbyEnter(c: GameClient): void {
  const p = c.player;
  if (!p) return;
  p.last.lobbyEnter = Date.now();
  if (p.channelId >= 0) c.channelOf(p)?.addPlayer(p.session as PlayerSession, p);
  const room = rh.roomOf(p);
  if (room) {
    if (p.slotId >= 0 && room.state >= RoomState.LOADING && room.slots[p.slotId].state >= SlotState.LOAD) { c.session.send(gp.lobbyEnterAck(0)); return; }
    rh.removePlayer(room, p, false);
  }
  void sh.syncPlayerToFriends(p, false);
  c.session.send(gp.lobbyEnterAck(0)); // GetXmasReward: no Xmas event running (system_event_xmas) — not ported
  ph.sendTitleInfo(c);
}

async function handleLobbyLeave(c: GameClient): Promise<void> {
  const p = c.player;
  if (!p || p.room) return;
  const ch = c.channelOf(p);
  const err = !ch || !p.session || !ch.removePlayer(p) ? 0x80000000 : 0;
  c.session.send(gp.lobbyLeaveAck(err));
  if (err === 0) {
    await cw.dropTeamOf(p); // a clan-war team belongs to its clan channel only
    p.lastRoomPage = 0; p.lastPlayerPage = 0;
    p.status.channelId = 255;
    await updateStatus(p);
    await sh.syncPlayerToFriends(p, false);
  } else c.session.close(true, 1000);
}

/** Lobby player entry (120 bytes). */
function lobbyPlayerEntry(a: Account): Uint8Array {
  const w = new PacketWriter(128).writeD(a.session?.sessionId ?? 0).writeD(a.clan.logo).writeC(a.clan.effect); // GetClan(0) = new ClanModel(): Logo 0xFFFFFFFF
  gp.syncU(w, a.clan.name, 34);
  w.writeC(a.getRank()).writeC(0).writeC(a.nickColor);
  gp.syncU(w, a.nickname, 66);
  return w.writeC(a.config.nations).writeC(0).writeD(a.equipment.nameCardId).writeC(a.bonus.nickBorderColor).writeC(0).toBytes();
}

function roomListEntry(r: RoomModel): Uint8Array {
  const w = new PacketWriter(80).writeD(r.roomId);
  gp.syncU(w, r.name, 46);
  return w.writeC(r.mapId).writeC(r.rule).writeC(r.stage).writeC(r.roomType).writeC(r.state).writeC(r.getVisiblePlayers()).writeC(r.getSlotCount())
    .writeC(r.ping).writeH(r.weaponsFlag).writeD(r.getFlag()).writeH(0).writeB(r.leaderAddr).writeC(0).toBytes();
}

function handleGetRoomList(c: GameClient): void {
  const p = c.player;
  if (!p || p.durationSince("roomList") < 1.0) return;
  const ch = c.channelOf(p);
  if (!ch) return;
  p.last.roomList = Date.now();
  // the client attaches its chat only after SELECT_CHANNEL / LOBBY_ENTER: the GM notice rides on the room list polls (idempotent there)
  if (p.isGM()) c.session.send(lobbyChatAck(0, "Server", 5, false, GM_MARK));
  if (p.missionCardBootstrap < 5) { p.missionCardBootstrap++; c.session.send(gp.saillistAck(false)); }
  ch.removeEmptyRooms();
  const rooms = [...ch.rooms], wait = [...ch.lobbyPlayers];
  const rpages = Math.ceil(rooms.length / 10), ppages = Math.ceil(wait.length / 8);
  if (p.lastRoomPage >= rpages) p.lastRoomPage = 0;
  if (p.lastPlayerPage >= ppages) p.lastPlayerPage = 0;
  const rs = p.lastRoomPage * (p.lastRoomPage === 0 ? 10 : 11), ps = p.lastPlayerPage * (p.lastPlayerPage === 0 ? 8 : 9);
  const rsel = rooms.slice(rs).filter(Boolean).slice(0, 10), psel = wait.slice(ps).slice(0, 8);
  const cat = (l: Uint8Array[]) => { const n = l.reduce((a, b) => a + b.length, 0), o = new Uint8Array(n); let i = 0; for (const b of l) { o.set(b, i); i += b.length; } return o; };
  c.session.send(gp.roomListAck(rooms.length, wait.length, p.lastRoomPage++, p.lastPlayerPage++, rsel.length, psel.length, cat(rsel.map(roomListEntry)), cat(psel.map(lobbyPlayerEntry))));
}

/** PROTOCOL_LOBBY_GET_ROOMINFOADD_REQ (2567): `D roomId`; no answer for a missing room or one without leader (C#) */
function handleRoomInfoAdd(c: GameClient, r: PacketReader): void {
  const p = c.player, id = r.readSignedD();
  const room = p ? c.channelOf(p)?.getRoom(id) : null;
  if (room?.getLeader()) c.session.send(rp.roomInfoAddAck(room));
}

// ---- inventory / equip -----------------------------------------------------------------------------------------------

function handleInventoryEnter(c: GameClient): void {
  const p = c.player;
  if (!p || p.durationSince("inventoryEnter") < 1.0) return;
  const r = rh.roomOf(p);
  if (r) { r.changeSlotState(p.slotId, SlotState.INVENTORY, false); rh.stopCountDownBySlot(r, p.slotId); r.updateSlotsInfo(); }
  c.session.send(gp.inventoryEnterAck());
  p.last.inventoryEnter = Date.now();
}
function handleInventoryLeave(c: GameClient): void {
  const p = c.player;
  if (!p || p.durationSince("inventoryLeave") < 1.0) return;
  rh.roomOf(p)?.changeSlotState(p.slotId, SlotState.NORMAL, true);
  c.session.send(gp.inventoryLeaveAck());
  p.last.inventoryLeave = Date.now();
}

// ---- profile (PROTOCOL_ROOM_INFO_ENTER/LEAVE_REQ: the C# throttles them with LastProfileEnter / LastProfileLeave) -----

function handleRoomInfoEnter(c: GameClient): void {
  const p = c.player;
  if (!p || p.durationSince("profileEnter") < 1.0) return;
  const r = rh.roomOf(p);
  if (r) { r.changeSlotState(p.slotId, SlotState.INFO, false); rh.stopCountDownBySlot(r, p.slotId); r.updateSlotsInfo(); }
  c.session.send(gp.roomInfoEnterAck());
  p.last.profileEnter = Date.now();
}
function handleRoomInfoLeave(c: GameClient): void {
  const p = c.player;
  if (!p || p.durationSince("profileLeave") < 1.0) return;
  rh.roomOf(p)?.changeSlotState(p.slotId, SlotState.NORMAL, true);
  c.session.send(gp.roomInfoLeaveAck());
  p.last.profileLeave = Date.now();
}

/** CharChangeEquip121Parser + PROTOCOL_CHAR_CHANGE_EQUIP_REQ.Run. */
async function handleChangeEquip(c: GameClient, raw: Uint8Array): Promise<void> {
  const b = raw.subarray(4);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  const C = () => { if (o + 1 > b.length) throw new Error("EOF"); return b[o++]; };
  const H = () => { if (o + 2 > b.length) throw new Error("EOF"); const v = dv.getUint16(o, true); o += 2; return v; };
  const D = () => { if (o + 4 > b.length) throw new Error("EOF"); const v = dv.getUint32(o, true); o += 4; return v; };
  const legacy = (v: number) => (v > 2147483647 ? 0 : v);
  const cnt = (max: number) => { const n = C(); if (n > max) throw new Error(`count ${n} > ${max}`); return n; };
  const emo: number[] = [];
  for (let i = cnt(6); i > 0; i--) { emo.push(legacy(D())); D(); }
  const changed6 = C() !== 0;
  const acc = legacy(D()); D();
  const changedAcc = C() !== 0;
  const disabled: number[] = [], enabled: number[] = [];
  for (let i = cnt(39); i > 0; i--) disabled.push(D());
  H();
  for (let i = cnt(39); i > 0; i--) enabled.push(D());
  H();
  C();
  const pairs: number[] = [];
  for (let i = 0; i < 18; i++) { pairs.push(legacy(D())); D(); }
  const changedChar = C() !== 0;
  const items3: number[] = [];
  for (let i = cnt(3); i > 0; i--) { items3.push(legacy(D())); D(); }
  const changedItems = C() !== 0;
  const slots: number[] = [];
  for (let i = cnt(2); i > 0; i--) slots.push(C());
  if (o !== b.length) throw new Error(`6149: ${b.length - o} trailing bytes`);
  const p = c.player;
  if (!p) return;
  const e = p.equipment, inv = p.inventory;
  const real = (id: number) => inv.getItem(id)?.id ?? 0;
  const slotsL = [slots[0] ?? 0, slots[1] ?? 0];
  if (p.character.characters.length > 0) {
    if (changedAcc && e.accessoryId !== acc) { e.accessoryId = real(acc); await dao.update1("player_equipments", "accesory_id", e.accessoryId, "owner_id", p.playerId); }
    if (disabled.length || enabled.length) log(`6149 coupon toggles not ported (F4): ${disabled.length} off, ${enabled.length} on`);
    if (changedChar) {
      const cols: string[] = [], vals: unknown[] = [];
      const chara = pairs[8], ch = p.character.getCharacter(chara);
      const cls = Math.trunc(chara / 100000), side = Math.trunc((chara % 100000) / 1000), sp = Math.trunc(chara / 1000);
      if (ch && cls === 6 && (side === 1 || sp === 632) && slotsL[0] === ch.slot) { if (e.charaRedId !== chara) { e.charaRedId = chara; cols.push("chara_red_side"); vals.push(chara); } }
      else if (ch && cls === 6 && (side === 2 || sp === 664) && slotsL[1] === ch.slot && e.charaBlueId !== chara) { e.charaBlueId = chara; cols.push("chara_blue_side"); vals.push(chara); }
      // weapons always keep the previous equip when the id sent is not owned (never unequipped, 0 is not a valid weapon)
      const weapons = [pairs[0], pairs[1], pairs[2], pairs[3], pairs[4]];
      const weaponKeys = ["weaponPrimary", "weaponSecondary", "weaponMelee", "weaponExplosive", "weaponSpecial"] as const;
      const weaponCols = ["weapon_primary", "weapon_secondary", "weapon_melee", "weapon_explosive", "weapon_special"];
      weapons.forEach((id, i) => { if (inv.getItem(id) && e[weaponKeys[i]] !== id) { e[weaponKeys[i]] = id; cols.push(weaponCols[i]); vals.push(id); } });
      // cosmetic parts (head/face/jacket/pocket/glove/belt/holster/skin): 0 clears the slot, like beret below
      const parts = [pairs[9], pairs[10], pairs[11], pairs[12], pairs[13], pairs[14], pairs[15], pairs[16]];
      const partKeys = ["partHead", "partFace", "partJacket", "partPocket", "partGlove", "partBelt", "partHolster", "partSkin"] as const;
      const partCols = ["part_head", "part_face", "part_jacket", "part_pocket", "part_glove", "part_belt", "part_holster", "part_skin"];
      parts.forEach((id, i) => { const v = real(id); if (e[partKeys[i]] !== v) { e[partKeys[i]] = v; cols.push(partCols[i]); vals.push(v); } });
      if (e.beretItem !== pairs[17]) { e.beretItem = real(pairs[17]); cols.push("beret_item_part"); vals.push(e.beretItem); }
      await dao.updateDB("player_equipments", "owner_id", p.playerId, cols, vals);
    }
    if (changedItems) {
      if (items3[0] && e.dinoItem !== items3[0]) { e.dinoItem = real(items3[0]); await dao.update1("player_equipments", "dino_item_chara", e.dinoItem, "owner_id", p.playerId); }
      if (items3.length > 1 && e.sprayId !== items3[1]) { e.sprayId = real(items3[1]); await dao.update1("player_equipments", "spray_id", e.sprayId, "owner_id", p.playerId); }
      if (items3.length > 2 && e.nameCardId !== items3[2]) { e.nameCardId = real(items3[2]); await dao.update1("player_equipments", "namecard_id", e.nameCardId, "owner_id", p.playerId); }
    }
    if (changed6) {
      const cols: string[] = [], vals: unknown[] = [];
      for (let i = 0; i < 6; i++) { const v = emo[i] ? real(emo[i]) : 0; if (e.emoticons[i] !== v) { e.emoticons[i] = v; cols.push(`emoticon_${i}`); vals.push(v); } }
      await dao.updateDB("player_equipments", "owner_id", p.playerId, cols, vals);
    }
    const cols: string[] = [], vals: unknown[] = [];
    const red = p.character.getCharacterSlot(slotsL[0]), blue = p.character.getCharacterSlot(slotsL[1]);
    if (red && red.id !== e.charaRedId) { e.charaRedId = real(red.id); cols.push("chara_red_side"); vals.push(e.charaRedId); }
    if (blue && blue.id !== e.charaBlueId) { e.charaBlueId = real(blue.id); cols.push("chara_blue_side"); vals.push(e.charaBlueId); }
    await dao.updateDB("player_equipments", "owner_id", p.playerId, cols, vals);
  }
  const r = rh.roomOf(p);
  if (r) { const s = r.getSlot(p.slotId); if (s) s.equipment = p.equipment; r.updateSlotsInfo(); }
  c.session.send(gp.changeEquipAck());
}

// ---- shop (F3) -------------------------------------------------------------------------------------------------------

function handleShopEnter(c: GameClient): void {
  const p = c.player;
  if (!p || p.durationSince("shopEnter") < 1.0) return;
  const r = rh.roomOf(p);
  if (r) { r.changeSlotState(p.slotId, SlotState.SHOP, false); rh.stopCountDownBySlot(r, p.slotId); r.updateSlotsInfo(); }
  c.session.send(gp.shopEnterAck());
  p.last.shopEnter = Date.now();
}
function handleShopLeave(c: GameClient): void {
  const p = c.player;
  if (!p || p.durationSince("shopLeave") < 1.0) return;
  rh.roomOf(p)?.changeSlotState(p.slotId, SlotState.NORMAL, true);
  c.session.send(gp.shopLeaveAck());
  p.last.shopLeave = Date.now();
}
function handleSailList(c: GameClient, r: PacketReader): void {
  const md5 = r.readS(32);
  const p = c.player;
  if (!p) return;
  if (!p.loadedShop) { p.loadedShop = true; for (const b of gp.fullCatalog(p, true)) c.session.send(b); }
  c.session.send(gp.shopTagInfoAck());
  if (shop.limited.length > 0) log("1103 LIMITED_SALE_LIST not ported (no count_limited items locally)");
  c.session.send(gp.saillistAck(shopDatMd5() !== md5));
}
let shopMd5: string | null = null;
function shopDatMd5(): string {
  if (shopMd5 !== null) return shopMd5;
  try {
    shopMd5 = createHash("md5").update(readFileSync(`${config.dataDir}/Raws/Shop.dat`)).digest("hex").toUpperCase();
  } catch { shopMd5 = "D41D8CD98F00B204E9800998ECF8427E"; }
  return shopMd5!;
}

type Cart = { goodId: number; buyType: number }[];
/** `C n, n×{C, D goodId, C buyType, C, Q}` (1045 and 1048 share it) */
function readCart(r: PacketReader): Cart {
  const n = r.readC(), cart: Cart = [];
  for (let i = 0; i < n; i++) { r.readC(); const goodId = r.readD(); const buyType = r.readC(); r.readC(); r.readQ(); cart.push({ goodId, buyType }); }
  return cart;
}

async function handleGoodsBuy(c: GameClient, r: PacketReader): Promise<void> {
  const cart = readCart(r), p = c.player;
  if (p) await buyCart(c, p, cart);
}

/** 1045 body; also the self gift (C# GOODS_GIFT_REQ.SelfBuy, same 1047 answers) */
async function buyCart(c: GameClient, p: Account, cart: Cart): Promise<void> {
  const fail = (code: number) => c.session.send(gp.goodsBuyAck(0, [], p, code));
  if (p.inventory.items.length >= 1500) return fail(0x800010b9);
  const res = ph.getGoods(cart);
  if (!res) return fail(0x80001017);
  if (!pg.preflightSeasonGoods(p, res.goods).ok) return fail(0x80001019);
  let extra = 0;
  for (const g of res.goods.filter((x) => Math.trunc(x.item.id / 100000) === 36 && !pg.isSeasonShopGood(x))) {
    const slots = ih.inventoryExpansionSlots(g.item.id);
    if (slots <= 0) { log(`PROTOCOL_AUTH_SHOP_GOODS_BUY_REQ; class 36 good ${g.item.id} has no slot mapping`); return fail(0x80001019); }
    extra += slots;
  }
  if (extra > 0 && !ih.canExtendInventory(p, extra)) return fail(0x80001019);
  if (extra > 0 && res.goods.some(pg.isSeasonShopGood)) return fail(0x80001019);
  const short = () => p.gold < res.gold || p.cash < res.cash;
  if (short()) return fail(0x80001018);
  // conditional debit in the database (dao.addMoney), not the absolute balance of this copy; a lost race reads as "no money"
  if (!(await dao.addMoney(p, -res.gold, -res.cash))) return fail(short() ? 0x80001018 : 0x80001019);
  if (extra > 0 && !(await ih.extendInventory(c, p, extra))) {
    if (!(await dao.addMoney(p, res.gold, res.cash))) log(`PROTOCOL_AUTH_SHOP_GOODS_BUY_REQ; refund failed for player ${p.playerId}, charged with no expansion`);
    return fail(0x80001019);
  }
  const hasSeason = res.goods.some(pg.isSeasonShopGood);
  const seasonType = await pg.commitSeasonGoods(p, res.goods, res.gold, res.cash);
  if (hasSeason && seasonType === 0) return fail(0x80001019);
  for (const g of res.goods) {
    if (pg.isSeasonShopGood(g) || Math.trunc(g.item.id / 100000) === 36) continue; // season: CommitSeasonGoods; class 36: applied above
    const model = g.item.clone();
    if (Math.trunc(g.item.id / 100000) === 6 && !p.character.getCharacter(g.item.id)) {
      await ph.createCharacterGame(c, p, g.item);
    } else {
      await pu.tryCreateItem(model, p);
      c.session.send(gp.inventoryGetInfoAck(0, p, [model]));
    }
  }
  c.session.send(gp.goodsBuyAck(1, res.goods, p));
  pg.finalizeSeasonShopPurchase(p, seasonType);
  log(`buy ${res.goods.map((g) => g.id).join(",")} by ${p.nickname}: -${res.gold} gold -${res.cash} cash`);
}

/**
 * 1048 PROTOCOL_AUTH_SHOP_GOODS_GIFT_REQ: `cart, C len, U text, C len, U nick`. Only a
 * receiver online gets a gift (C# IsOnline, else 0x80001019). The gift is a note type 2 whose senderId is the goodId: the exe's
 * _NoteReceive `_ui32GoodsID` is the low dword of the note header's senderId (UIPopupReceiveMail::ReceivePresent 0x91e900).
 * The sender pays as a buy does. C# debits before the receiver's 100-note check; here that check runs first [RECRIADO].
 */
async function handleGoodsGift(c: GameClient, r: PacketReader): Promise<void> {
  const cart = readCart(r);
  const text = r.readU(r.readC() * 2);
  const nick = r.readU(r.readC() * 2);
  const p = c.player;
  if (!p) return;
  if (!nick || nick === p.nickname) return buyCart(c, p, cart);
  const fail = (code: number) => c.session.send(gp.goodsBuyAck(0, [], p, code));
  const to = [...sh.social.online.values()].find((a) => a.nickname === nick);
  if (!to) return fail(0x80001019);
  if (to.inventory.items.length >= 1500) return fail(0x800010b9);
  if (Number((await db.pool.query(`SELECT COUNT(*) AS n FROM player_messages WHERE owner_id=$1`, [String(to.playerId)])).rows[0].n) >= 100) return fail(0x800010b9);
  const res = ph.getGoods(cart);
  if (!res) return fail(0x80001017);
  if (res.goods.some(pg.isSeasonShopGood)) return fail(0x80001019);
  const short = () => p.gold < res.gold || p.cash < res.cash;
  if (short()) return fail(0x80001018);
  // conditional debit in the database, as the buy does
  if (!(await dao.addMoney(p, -res.gold, -res.cash))) return fail(short() ? 0x80001018 : 0x80001019);
  let sent = true;
  for (const g of res.goods) sent = sent && (await sh.createNote(to, { senderId: BigInt(g.id), senderName: p.nickname, type: 2, text, clanId: 0, clanNote: 0, days: 15 }));
  if (!sent) {
    if (!(await dao.addMoney(p, res.gold, res.cash))) log(`PROTOCOL_AUTH_SHOP_GOODS_GIFT_REQ; refund failed for player ${p.playerId}, gift note not written`);
    return fail(0x80000000);
  }
  c.session.send(gp.goodsGiftAck(res.goods, p));
  c.session.send(pointCashAck(0, p));
  log(`gift ${res.goods.map((g) => g.id).join(",")} from ${p.nickname} to ${to.nickname}: -${res.gold} gold -${res.cash} cash`);
}

/**
 * 1056 PROTOCOL_AUTH_SHOP_AUTH_GIFT_REQ (...AUTH_GIFT_REQ.cs): `D objectId` of a gift note. The note is taken out of the box
 * (DELETE ... RETURNING, so a double accept cannot give the item twice) and the item goes to the inventory as a buy does.
 * A note whose goods the shop no longer has is answered with nothing (C# returns). 1057 lists the item.
 */
async function handleAuthGift(c: GameClient, r: PacketReader): Promise<void> {
  const id = r.readD() >>> 0;
  const p = c.player;
  if (!p) return;
  if (p.inventory.items.length >= 1500) return c.session.send(gp.giftAuthAck(0x80000000));
  const row = (await db.pool.query(`SELECT sender_id FROM player_messages WHERE object_id=$1 AND owner_id=$2 AND type=2`, [id, String(p.playerId)])).rows[0];
  if (!row) return c.session.send(gp.giftAuthAck(0x80000000));
  const good = getGood(Number(BigInt.asUintN(32, BigInt(row.sender_id))));
  if (!good) return;
  if (!(await db.pool.query(`DELETE FROM player_messages WHERE object_id=$1 AND owner_id=$2 AND type=2`, [id, String(p.playerId)])).rowCount) return c.session.send(gp.giftAuthAck(0x80000000));
  if (Math.trunc(good.item.id / 100000) === 6 && !p.character.getCharacter(good.item.id)) await ph.createCharacterGame(c, p, good.item);
  else { const model = good.item.clone(); await pu.tryCreateItem(model, p); c.session.send(gp.inventoryGetInfoAck(0, p, [model])); }
  c.session.send(gp.giftAuthAck(1, [p.inventory.getItem(good.item.id) ?? good.item]));
}

// ---- dispatch --------------------------------------------------------------------------------------------------------

async function onPacket(c: GameClient, op: number, r: PacketReader, raw: Uint8Array): Promise<void> {
  switch (op) {
    case 2330: return handleUserEnter(c, r);
    case 2334: return handleSelectChannel(c, r);
    case 2332: {
      const sid = r.readSignedD();
      const list = channelEntries().filter((x) => x.serverId === sid);
      const srv = serverEntries().find((x) => x.id === sid);
      if (list.length === 11 && srv) c.session.send(channelListAck(srv, list));
      return;
    }
    case 2399: return c.session.send(gameServerStateAck(serverEntries(), channelEntries()));
    case 2583: return handleLobbyEnter(c);
    case 2561: return handleLobbyLeave(c);
    case 2587: return handleGetRoomList(c);
    case 2567: return handleRoomInfoAdd(c, r);
    case 2309: case 5145: return;
    case 2328: c.session.send(gp.userLeaveAck()); c.session.close(false); return;
    case 2307: c.session.send(gp.logoutAck()); c.session.close(true, 1000); return;
    case 3329: return handleInventoryEnter(c);
    case 3331: return handleInventoryLeave(c);
    case 3672: return handleRoomInfoEnter(c);
    case 3674: return handleRoomInfoLeave(c);
    case 6149: return handleChangeEquip(c, raw);
    case 1025: r.readS(32); return handleShopEnter(c);
    case 1027: return handleShopLeave(c);
    case 1029: return handleSailList(c, r);
    case 1045: return handleGoodsBuy(c, r);
    case 1048: return handleGoodsGift(c, r);
    case 1056: return handleAuthGift(c, r);
    case 3592: return rh.handleCreateRoom(c, r);
    case 3585: return rh.handleJoinRoom(c, r);
    case 3609: return rh.handlePersonalTeamChange(c, r);
    case 5123: return rh.handleReadyBattle(c, r);
    case 3657: case 3658: return rh.handleLoadingStart(c, r);
    case 3665: case 3666: return rh.handleGetUserEquipment(c, r);
    case 5129: return rh.handlePreStartBattle(c, r);
    case 5131: return rh.handleStartBattle(c);
    case 5146: return rh.handleSendPing(c, r);
    case 5137: return rh.handleRespawn(c, r);
    case 5135: return rh.handleDeath(c, r);
    case 5168: return rh.handleTimerSync(c, r);
    case 5156: return rh.handleBombInstall(c, r);
    case 5158: return rh.handleBombUninstall(c, r);
    case 5166: return rh.handleGeneratorInfo(c, r);
    case 5199: return rh.handleDevBomb(c, r); // dev F2 test menu
    case 5133: return rh.handleGiveUpBattle(c);
    case 3604: return rh.handleChangeSlot(c, r);
    case 3640: return rh.handleChangeRoomInfo(c, r);
    case 3619: return rh.handleTotalTeamChange(c);
    case 3615: return rh.handleChangeLeader(c, r);
    case 3611: return rh.handleRequestMain(c);
    case 3850: return reports.handleReport(c, r);
    case 3852: return reports.handleReportCondition(c);
    case 5190: return voteKick.handleKickVoteStart(c, r); // [INFERIDO] REQ numbers (ACK - 1),
    case 5194: return voteKick.handleKickVoteCast(c, r);
    case 9001: return handleBugReport(c, r);
    case 9010: return voteLeader.handleLeaderVoteStart(c, r);
    case 9014: return voteLeader.handleLeaderVoteCast(c, r);
    case 1060: return ih.handleGetPointCash(c);
    case 1050: return ih.handleEquipSingle(c, r);
    case 1047: return ih.handleItemAuth(c, r);
    case 1052: return ih.handleUseItem(c, r);
    case 1055: return ih.handleDeleteItem(c, r);
    case 3333: return ih.handleInventoryUpgrade(c);
    case 1076: return ih.handleRepair(c, r);
    case 6145: return ph.handleCreateChara(c, r);
    case 6151: return ph.handleDeleteChara(c, r);
    case 3596: return ph.handleRoomPlayerInfo(c, r);
    case 2326: return ph.handleCreateNick(c, r);
    case 1061: case 1063: case 1064: return ph.handleCheckNick(c, op, r);
    case 2350: return ph.handleRecordInfoDB(c, r, lookup.byPid);
    case 2414: return ph.handleDailyRecord(c);
    case 2422: case 2424: case 2425: case 2426: return ph.handleUserDetail(c, op, r, { ...lookup, bySession: (id) => lookup.bySession(id, c.state) });
    case 2447: return ph.handleUserSubtask(c, r, (id) => lookup.bySession(id, c.state));
    case 2376: return ph.handleTitleChange(c, r);
    case 2378: return ph.handleTitleEquip(c, r);
    case 2380: return ph.handleTitleRelease(c, r);
    case 1091: return ph.handleGiftCoupon(c, r);
    case 2384: return cw.isTeamChat(r) ? cw.handleTeamChat(c, r) : sh.handleChat(c, r);
    case 1826: case 1828: return sh.handleWhisper(c, op, r);
    case 1811: case 1818: return sh.handleFriendInvite(c, op, r);
    case 1816: return sh.handleFriendAccept(c, r);
    case 1820: return sh.handleFriendDelete(c, r);
    case 1921: case 1930: return sh.handleNoteSend(c, op, r);
    case 1926: return sh.handleNoteRead(c, r);
    case 1928: return sh.handleNoteDelete(c, r);
    case 2360: return sh.handleQuestActiveIdx(c, r);
    case 2364: return sh.handleBuyCardSet(c, r);
    case 2366: return sh.handleDeleteCardSet(c, r);
    case 8709: return sh.handleQuestList(c);
    case 8705: case 8707: return c.session.send(new PacketWriter(8).writeH(op + 1).writeD(0).toBytes());
    case 8449: return sh.handleSeasonInfo(c);
    case 8453: case 8454: return pg.handleBuySeasonPass(c);
    case 2500: return ih.handleRandomBoxList(c, r);
    case 769: return sh.handleClanEnter(c);
    case 771: return sh.handleClanLeave(c);
    case 997: case 999: return sh.handleClanList(c, r);
    case 800: return sh.handleClanDetail(c, r);
    case 1001: return sh.handleClanSimpleInfo(c, r);
    case 802: return sh.handleClanMemberContext(c);
    case 804: return sh.handleClanMemberList(c, r);
    case 806: return sh.handleClanCreate(c, r);
    case 812: return sh.handleClanJoinRequest(c, r);
    case 814: return sh.handleClanCancelRequest(c);
    case 828: await sh.handleClanSecession(c); if (c.player && c.player.clanId === 0) await cw.dropTeamOf(c.player); return;
    case 854: return sh.handleClanChat(c, r);
    case 918: return c.session.send(new PacketWriter(8).writeH(919).writeD(0).toBytes());
    case 808: return ch.handleCloseClan(c);
    case 810: return ch.handleCheckJoinAuthority(c, r);
    case 816: return ch.handleRequestContext(c);
    case 818: return ch.handleRequestList(c, r);
    case 820: return ch.handleRequestInfo(c, r);
    case 822: return ch.handleAcceptRequest(c, r);
    case 825: return ch.handleDenialRequest(c, r);
    case 830: return ch.handleDeportation(c, r);
    case 833: return ch.handleCommissionMaster(c, r);
    case 836: return ch.handleCommissionStaff(c, r);
    case 839: return ch.handleCommissionRegular(c, r);
    case 856: return ch.handleCheckMark(c, r);
    case 858: return ch.handleReplaceNotice(c, r);
    case 860: return ch.handleReplaceIntro(c, r);
    case 868: return ch.handleReplaceManagement(c, r);
    case 877: return ch.handleRoomInvited(c, r);
    case 886: return ch.handlePageChat(c, r);
    case 888: return ch.handleInvite(c);
    case 890: return ch.handleInviteAccept(c, r);
    case 892: return ch.handleClanNote(c, r);
    case 916: return ch.handleCreateClanCondition(c);
    case 6916: return cw.handleMatchTeamList(c);
    case 6918: return cw.handleCreateTeam(c, r);
    case 6920: return cw.handleJoinTeam(c, r);
    case 6922: return cw.handleLeaveTeam(c);
    case 6924: return cw.handleChangeOperation(c, r);
    case 6926: return cw.handleChangeMaxPer(c, r);
    case 6932: return cw.handleMatchmaking(c);
    case 6934: return cw.handleCancelMatchmaking(c);
    case 1954: return cw.handleClanMatchContext(c);
    case 1956: return cw.handleClanMatchResultList(c, r);
    case 7699: return cw.handleClanSeason(c);
    case 1041: case 1043: return sh.handleGiftList(c);
    default:
      if (await handleExtraPacket(c, op, r, raw)) return;
      c.session.log(`unhandled opcode ${op} (${raw.length}b) session ${c.session.sessionId}`);
  }
}

/** GameClient.Close(ms, destroy). */
async function onClose(c: GameClient, destroy: boolean): Promise<void> {
  c.state.clients.delete(c.session.sessionId);
  const p = c.player;
  c.player = null;
  if (!p) return;
  if (destroy) {
    if (p.isOnline) { await dao.update1("accounts", "online", false, "player_id", p.playerId); p.isOnline = false; log(`Account User: ${p.username}, Player UID: ${p.playerId}, Is Disconnected`); }
    const r = rh.roomOf(p);
    if (r) rh.removePlayer(r, p, false, 0);
    await cw.dropTeamOf(p);
    c.channelOf(p)?.removePlayer(p);
    if (p.status.reset()) await dao.update1("accounts", "status", 0xffffffff, "player_id", p.playerId);
    if (onlineAccounts.get(p.playerId) === p) onlineAccounts.delete(p.playerId);
    await sh.syncPlayerToFriends(p, false);
  }
  if (onlineAccounts.get(p.playerId) === p) onlineAccounts.delete(p.playerId);
}

/** AccountManager.GetAccount lookups (memory first, then DB with searchFlag 31). */
export const lookup = {
  // Session ids are numbered per game server: look only in the caller's server, or another server's player with the same id answers.
  bySession(id: number, st: GameServerState): Account | null {
    const cl = st.clients.get(id);
    return cl?.player ?? null;
  },
  async byPid(pid: bigint): Promise<Account | null> { return onlineAccounts.get(pid) ?? (await dao.getAccountDB("player_id", pid, 31)); },
  async byNick(nick: string): Promise<Account | null> {
    for (const a of onlineAccounts.values()) if (a.nickname === nick) return a;
    return dao.getAccountDB("nickname", nick, 31);
  },
};

let servers: ServerEntry[] = [];
const serverEntries = () => servers;
const channelEntries = (): ChannelEntry[] => [...states.values()].flatMap((s) => s.channels.map((c) => ({ serverId: c.serverId, id: c.id, type: c.type, totalPlayers: c.players.length })));

function accept(state: GameServerState, sock: net.Socket): void {
  let id = 1;
  while (id < 100000 && state.clients.has(id)) id++;
  if (id >= 100000) { sock.destroy(); return; }
  const c = new GameClient(state);
  c.session = new TcpSession(sock, id, {
    firstPacketIds: null,
    onPacket: (op, r, raw) => onPacket(c, op, r, raw),
    onClose: (d) => onClose(c, d),
    log,
    keepIdle: () => { const p = c.player, r = p ? rh.roomOf(p) : null; return !!r && r.state >= RoomState.LOADING; },
  });
  state.clients.set(id, c);
  c.session.start().catch((e) => { log(`session start failed ${e}`); c.session.close(true); });
}

/** One listener per game server row (system_servers id >= 1): PB_TS_GAME_PORT_BASE + id. */
export async function startGameServers(): Promise<net.Server[]> {
  await loadMaps();
  await rh.loadRewardData();
  await ph.loadProfileData();
  await sh.loadSocialData();
  await pg.loadProgressData();
  ih.setBroadcastTargets(() => onlineAccounts.values());
  await gmc.loadPermissions();
  gmc.gm.online = () => onlineAccounts.values();
  gmc.gm.byPid = lookup.byPid;
  gmc.gm.byNick = lookup.byNick;
  sh.social.online = onlineAccounts;
  sh.social.byNick = lookup.byNick;
  sh.social.byPid = lookup.byPid;
  signalGate.allow = (key, role, slot, pid) => {
    for (const st of states.values()) for (const chn of st.channels) for (const r of chn.rooms) if (signalKey(r.uniqueRoomId, r.seed) === key) return r.maySignal(role, slot, pid);
    return false;
  };
  const rows = await db.systemServers();
  servers = rows.map((s) => ({ id: s.id, state: s.state, host: config.advertiseHost || s.host, port: s.port, type: parseEnum(SChannelType, s.type), maxPlayers: s.maxPlayers, lastPlayers: 0, channelPlayers: s.channelPlayers }));
  const out: net.Server[] = [];
  for (const s of rows.filter((x) => x.id >= 1)) {
    const st = new GameServerState({ id: s.id, channelPlayers: s.channelPlayers, maxPlayers: s.maxPlayers }, await loadChannels(s.id));
    states.set(s.id, st);
    const srv = net.createServer((sock) => accept(st, sock));
    const port = config.gamePortBase + s.id;
    if (config.noTcp) log(`game server ${s.id}: no TCP listener (PB_NO_TCP), WS /tcp only (${st.channels.length} channels)`);
    else {
      await new Promise<void>((res, rej) => { srv.once("error", rej); srv.listen(port, config.gameHost, () => res()); });
      log(`game server ${s.id} listening on ${config.gameHost}:${port} (${st.channels.length} channels)`);
    }
    out.push(srv);
  }
  return out;
}

export { AccessLevel, getIdStatics, equipmentDataChara, getGood };

/** Session of a browser WebSocket (web/webServer.ts target game<N>): same as a TCP accept on game server N. */
export function acceptGame(serverId: number, sock: net.Socket): void {
  const st = states.get(serverId);
  if (!st) { sock.destroy(); return; }
  accept(st, sock);
}
