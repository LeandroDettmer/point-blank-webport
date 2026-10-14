// F3 item handlers (Server.Game ClientPacket ports): 1050 CHAR_CHANGE_EQUIP_SINGLE (activate/), 1047
// AUTH_SHOP_ITEM_AUTH, 1052 INVENTORY_USE_ITEM, 1055 AUTH_SHOP_DELETE_ITEM, 3333 INVENTORY_UPGRADE, 1076 SHOP_REPAIR,
// 1060 GET_POINT_CASH (Game).
import { PacketWriter, type PacketReader } from "../../../src/net/packet.ts";
import type { Account } from "../shared/account.ts";
import * as dao from "../shared/dao.ts";
import { data } from "../shared/data.ts";
import { ItemsModel, ItemCategory, ItemEquipType } from "../shared/items.ts";
import { NO_FAKE_RANK } from "../shared/rank.ts";
import { tryCreateItem } from "../shared/playerUtils.ts";
import { shop, getGood, zlibCompress } from "../shared/shop.ts";
import * as pg from "./progress.ts";
import { fmtDate, convertDate } from "../shared/time.ts";
import { pointCashAck } from "../auth/packets.ts";
import { getCharaInfoAck, charaBlock, equipmentDataChara } from "../auth/metaPackets.ts";
import { pool } from "../db.ts";
import { config } from "../config.ts";
import * as gp from "./packets.ts";
import { roomOf } from "./roomHandlers.ts";
import { social, clanById, clanStatus, syncPlayerToFriends } from "./socialHandlers.ts";
import { Team, type RoomModel } from "./roomModel.ts";
import type { GameClient } from "./gameServer.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} [game-ts] ${m}`);
const W = (n = 64) => new PacketWriter(n);
const cls = (id: number) => Math.trunc(id / 100000);
const sub = (id: number) => Math.trunc((id % 100000) / 1000);
const num = (id: number) => id % 1000;
const oid32 = (v: bigint) => Number(BigInt.asUintN(32, v));
const yyMMddHHmm = (d: Date) => Number(fmtDate(d, "yyMMddHHmm"));
const pid = (p: Account) => String(p.playerId);

// ---- packets ----
/** 1051 AUTH_SHOP_ITEM_AUTH_ACK. The C# ctor consumes class 17/18/20/37 items and forces codes != 1 to FAIL. */
async function itemAuthAck(code: number, item: ItemsModel | null, p: Account): Promise<Uint8Array> {
  if (item && code === 1) {
    switch (cls(item.id)) {
      case 17: case 18: case 20: case 37:
        if (item.count > 1 && item.equip === ItemEquipType.Durable) {
          item.count--;
          await pool.query(`UPDATE player_items SET count=$1 WHERE object_id=$2 AND owner_id=$3`, [item.count, String(item.objectId), pid(p)]);
        } else {
          await deleteItem(item.objectId, p);
          p.inventory.items = p.inventory.items.filter((x) => x !== item);
          item.id = 0; item.count = 0;
        }
        break;
      default: item.equip = ItemEquipType.Temporary;
    }
  } else code = 0x80000000;
  const w = W(32).writeH(1051).writeD(code);
  if (code !== 1 || !item) return w.toBytes();
  w.writeD(yyMMddHHmm(new Date())).writeD(oid32(item.objectId));
  if (item.category === ItemCategory.Coupon && item.equip === ItemEquipType.Temporary) w.writeD(0).writeC(1).writeD(0);
  else w.writeD(item.id).writeC(item.equip).writeD(item.count);
  return w.toBytes();
}
const changeStateAck = (slot: number) => W(12).writeH(6153).writeH(0).writeD(0).writeC(20).writeC(slot).toBytes();
const changeEquipErr = (err: number) => W(8).writeH(6150).writeD(err).writeH(0).toBytes();
const plusPointAck = (total: number, added: number) => W(16).writeH(1077).writeH(0).writeC(0).writeD(total).writeD(added).toBytes();
const capsuleAck = (idx: number[], couponId: number) => { const w = W(32).writeH(1067).writeH(0).writeC(idx.length); for (const i of idx) w.writeC(i); return w.writeC(idx.length).writeD(couponId).toBytes(); };
const maxUpAck = (err: number, p?: Account, slots = 0) => (err === 0 && p ? W(20).writeH(3337).writeH(0).writeD(0).writeH(0).writeH(0).writeH(slots).writeD(p.cash).toBytes() : W(8).writeH(3337).writeH(0).writeD(err).toBytes());
const deleteItemAck = (code: number, objId: bigint) => W(12).writeH(1059).writeD(code).writeD(code === 1 ? oid32(objId) : 0).toBytes();
function announce(text: string): Uint8Array {
  const w = W(64 + text.length * 2).writeH(3079).writeH(0).writeD(0).writeH(text.length);
  for (let i = 0; i < text.length; i++) w.writeH(text.charCodeAt(i));
  return w.writeD(2).toBytes();
}

const deleteItem = (objId: bigint, p: Account) => pool.query(`DELETE FROM player_items WHERE object_id=$1 AND owner_id=$2`, [String(objId), pid(p)]).then(() => true, () => false);
const isEquipClass = (c: number) => (c >= 1 && c <= 8) || c === 15 || c === 27 || (c >= 30 && c <= 35);

/** Durable -> Temporary: Count holds the duration in seconds while Durable. */
async function activate(item: ItemsModel, p: Account, checkDb: boolean): Promise<boolean> {
  if (item.equip !== ItemEquipType.Durable) return true;
  const exp = yyMMddHHmm(new Date(Date.now() + item.count * 1000));
  const ok = await pool.query(`UPDATE player_items SET count=$1,equip=$2 WHERE object_id=$3 AND owner_id=$4`, [exp, 2, String(item.objectId), pid(p)]).then(() => true, () => false);
  if (checkDb && !ok) return false;
  item.equip = ItemEquipType.Temporary;
  item.count = exp;
  return true;
}

// ---- 1050 ----
export async function handleEquipSingle(c: GameClient, r: PacketReader): Promise<void> {
  const objId = BigInt(r.readD()); r.readC();
  const p = c.player;
  if (!p) return;
  const item = p.inventory.getItemByObject(objId);
  if (!item) return c.session.send(changeEquipErr(0x80000000));
  const k = cls(item.id);
  if (k === 41) {
    const ok = await activate(item, p, true);
    if (ok && item.equip === ItemEquipType.Temporary) c.session.send(await itemAuthAck(1, item, p));
    if (ok) {
      const e = p.equipment;
      const real = p.inventory.getItem(item.id)?.id ?? 0;
      if (real !== 0 && !e.emoticons.includes(real)) {
        let slot = e.emoticons.indexOf(0);
        if (slot < 0) slot = 0;
        e.emoticons[slot] = real;
        await dao.update1("player_equipments", `emoticon_${slot}`, real, "owner_id", p.playerId);
      }
      c.session.send(gp.changeInventoryAck(p));
    }
    return c.session.send(changeEquipErr(ok ? 0 : 0x80000000));
  }
  if (!isEquipClass(k)) return runItemAuth(c, objId);
  const wasDurable = item.equip === ItemEquipType.Durable;
  const ok = await activate(item, p, true);
  if (ok && wasDurable) {
    c.session.send(await itemAuthAck(1, item, p));
    const ch = k === 6 ? p.character.getCharacter(item.id) : null;
    if (ch) c.session.send(changeStateAck(ch.slot));
  }
  const room = roomOf(p);
  if (ok && room) { const s = room.getSlot(p.slotId); if (s) s.equipment = p.equipment; room.updateSlotsInfo(); }
  c.session.send(changeEquipErr(ok ? 0 : 0x80000000));
}

// ---- 1047 ----
export async function handleItemAuth(c: GameClient, r: PacketReader): Promise<void> {
  const objId = BigInt(r.readD());
  return runItemAuth(c, objId);
}

async function runItemAuth(c: GameClient, objId: bigint): Promise<void> {
  const p = c.player;
  if (!p) return;
  let code = 1;
  const item = p.inventory.getItemByObject(objId);
  const st = p.statistic;
  if (!item) code = 0x80000000;
  else {
    if (item.category === ItemCategory.Coupon && p.inventory.items.length >= 1500) { c.session.send(await itemAuthAck(0x80001029, null, p)); return; }
    const id = item.id;
    // C# runs the UPDATE on player_stat_seasons even with no row (0 rows changed = ok); the in-memory season is reset only when present
    if (id === 1800049) {
      const s = st.season;
      if (await dao.updateDB("player_stat_seasons", "owner_id", p.playerId, ["kills_count", "deaths_count", "headshots_count", "total_kills"], [0, 0, s?.headshotsCount ?? 0, s?.totalKillsCount ?? 0])) {
        if (s) { s.killsCount = 0; s.deathsCount = 0; }
        c.session.send(gp.myInfoRecordAck(p));
      } else code = 0x80000000;
    } else if (id === 1800048) {
      const s = st.season;
      if (await dao.updateDB("player_stat_seasons", "owner_id", p.playerId, ["matches", "match_wins", "match_loses", "match_draws", "total_matches"], [0, 0, 0, 0, s?.totalMatchesCount ?? 0])) {
        if (s) Object.assign(s, { matches: 0, matchWins: 0, matchLoses: 0, matchDraws: 0 });
        c.session.send(gp.myInfoRecordAck(p));
      } else code = 0x80000000;
    } else if (id === 1800050) {
      if (await dao.update1("player_stat_seasons", "escapes_count", 0, "owner_id", p.playerId)) { if (st.season) st.season.escapesCount = 0; c.session.send(gp.myInfoRecordAck(p)); }
      else code = 0x80000000;
    } else if (id === 1800053 || id === 1800055 || id === 1800056) {
      code = await clanItem(c, p, id);
    } else if (id >= 1800114 && id <= 1800118) {
      const amt = [500, 1000, 5000, 10000, 30000][id - 1800114];
      if (await dao.addMoney(p, amt)) c.session.send(plusPointAck(amt, p.gold));
      else code = 0x80000000;
    } else if (id === 1801145) {
      const rr = Math.floor(Math.random() * 9), tags = [1, 2, 3, 4, 5, 10, 15, 25, 30][rr];
      if (await dao.addMoney(p, 0, 0, tags)) { c.session.send(pointCashAck(0, p)); c.session.send(capsuleAck([rr], 1801145)); }
      else code = 0x80000000;
    } else if (item.category === ItemCategory.Coupon && data.randomBoxes.has(id)) {
      code = await openRandomBox(c, p, id);
    } else {
      const k = cls(id);
      if (isEquipClass(k)) {
        if (item.equip === ItemEquipType.Durable) {
          await activate(item, p, false);
          const ch = k === 6 ? p.character.getCharacter(item.id) : null;
          if (ch) c.session.send(changeStateAck(ch.slot));
        } else code = 0x80000000;
      } else if (k === 17) code = await buffCoupon(c, p, item);
      else if (k === 20) {
        const gold = num(id) * 100 + sub(id) * 100000;
        if (await dao.addMoney(p, gold)) c.session.send(plusPointAck(gold, p.gold));
        else code = 0x80000000;
      } else if (k === 37) {
        if (!(await pg.couponIncreaseBP(p, id))) code = 0x80000000;
      } else if (k === 36) {
        const slots = inventoryExpansionSlots(id);
        if (slots <= 0 || !canExtendInventory(p, slots) || !(await dao.update1("accounts", "inventory_plus", p.inventoryPlus + slots, "player_id", p.playerId))) code = 0x80000000;
        else if (!(await deleteItem(item.objectId, p))) { await dao.update1("accounts", "inventory_plus", p.inventoryPlus, "player_id", p.playerId); code = 0x80000000; }
        else {
          p.inventoryPlus += slots;
          p.inventory.items = p.inventory.items.filter((x) => x !== item);
          item.id = 0; item.count = 0;
          notifyInventoryExtended(c, p, slots);
        }
      } else code = 0x80000000;
    }
  }
  c.session.send(await itemAuthAck(code, item, p));
}

/** Method1: class-17 buff coupon -> effect item 16xxxxx for sub(id) days. */
async function buffCoupon(c: GameClient, p: Account, item: ItemsModel): Promise<number> {
  const eff = 1600000 + num(item.id), days = sub(item.id);
  const marker = p.inventory.items.find((x) => x.id === eff && x.equip === ItemEquipType.Temporary && x.objectId !== item.objectId) ?? null;
  const flag = data.coupons.get(eff) ?? 0n;
  if (flag > 0n && (p.effects & flag) === flag && !marker) return 0x80000000; // CheckDuplicateCouponEffects (exclusivity table not ported)
  if (!marker) {
    const b = p.bonus, before = [b.bonuses, b.freePass];
    addBonuses(p, eff);
    if (flag > 0n && (p.effects & flag) !== flag) { p.effects |= flag; await dao.update1("accounts", "coupon_effect", p.effects.toString(), "player_id", p.playerId); }
    if (b.bonuses !== before[0] || b.freePass !== before[1]) await dao.updatePlayerBonus(p.playerId, b.bonuses, b.freePass);
    const model = new ItemsModel(eff, `${item.name} [Active]`, ItemEquipType.Temporary, yyMMddHHmm(new Date(Date.now() + days * 86400000)));
    await tryCreateItem(model, p);
    c.session.send(gp.inventoryGetInfoAck(0, p, [model]));
  } else {
    marker.count = yyMMddHHmm(new Date(convertDate(String(marker.count)).getTime() + days * 86400000));
    await pool.query(`UPDATE player_items SET count=$1 WHERE object_id=$2 AND owner_id=$3`, [marker.count, String(marker.objectId), pid(p)]);
    c.session.send(gp.inventoryGetInfoAck(1, p, [marker]));
  }
  return 1;
}

/** PlayerBonus.AddBonuses (same id table as RemoveBonuses). */
function addBonuses(p: Account, itemId: number): void {
  const b = p.bonus;
  const set = (v: number) => { if ((b.bonuses & v) !== v) b.bonuses += v; };
  switch (itemId) {
    case 1600001: set(1); break; case 1600002: set(2); break; case 1600003: set(4); break; case 1600004: set(32); break;
    case 1600011: case 1600162: if ((b.freePass & 128) !== 128) b.freePass += 128; break;
    case 1600012: set(256); break; case 1600037: set(8); break; case 1600038: set(128); break; case 1600119: set(64); break;
    case 1600201: set(512); break; case 1600202: set(1024); break; case 1600203: set(2048); break; case 1600204: set(4096); break;
  }
}

// ---- 1052 ----
// 1052 INVENTORY_USE_ITEM, client -> server: D objId, C n, B[n] = argument (C# PROTOCOL_INVENTORY_USE_ITEM_REQ Read/Method0).
//   1600010 / 1600186 (fake nick), 1600047 (change nick), 1600051 (clan name): UTF-16LE text, n = byte count (2 per char).
//     Cut at the first NUL (C# Bitwise.HexArrayToString). Nick 4..16 chars (Settings.ini MinNickSize/MaxNickSize), clan name 1..16.
//   1600005 (clan name colour), 1600052 (clan logo), 1600187 (muzzle colour): u32 LE, n = 4.
//   1600085 (PB Inspector): room slot index, 1 byte. Every other effect (1600006, 1600009, 1600014, 1600193, 1600205): 1 byte, n >= 1.
const COSMETIC = [1600005, 1600006, 1600009, 1600010, 1600014, 1600047, 1600051, 1600052, 1600085, 1600187, 1600193, 1600205, 1600186];
const NICK_MIN = 4, NICK_MAX = 16; // Settings.ini Essentials MinNickSize / MaxNickSize (profileHandlers reads the same file)
const validNick = (s: string) => s.length >= NICK_MIN && s.length <= NICK_MAX;
/** C# Bitwise.HexArrayToString: UTF-16LE, cut at the first NUL, odd trailing byte dropped. */
function utf16Arg(buf: Uint8Array): string {
  let s = "";
  for (let i = 0; i + 1 < buf.length; i += 2) { const ch = buf[i] | (buf[i + 1] << 8); if (ch === 0) break; s += String.fromCharCode(ch); }
  return s;
}
const nickExists = async (nick: string) => Number((await pool.query(`SELECT COUNT(*) AS n FROM accounts WHERE nickname=$1`, [nick])).rows[0].n) > 0;
const clanMembersOnline = (clanId: number) => [...social.online.values()].filter((a) => a.clanId === clanId);
/** 851 CS_MEMBER_INFO_CHANGE_ACK: the user's clan status, to the online clan members. */
const clanMemberAck = (p: Account) => W(20).writeH(851).writeQ(p.playerId).writeQ(clanStatus(p.status.buffer >>> 0, !!p.connection)).toBytes();
/** 1836 AUTH_CHANGE_NICKNAME_ACK: C len (chars), U text. */
const changeNickAck = (nick: string) => W(8 + nick.length * 2).writeH(1836).writeC(nick.length).writeU(nick, nick.length * 2).toBytes();
/** Nick changed by item (1600010 / 1600047): 1836 + MYINFO_BASIC to the user, 3599 ROOM_GET_NICKNAME_ACK to the room. */
function sendNickChanged(c: GameClient, p: Account): void {
  c.session.send(changeNickAck(p.nickname));
  c.session.send(gp.myInfoBasicAck(p, p.clan));
  const room = roomOf(p);
  if (!room) return;
  room.sendToPlayers(W(80).writeH(3599).writeD(p.slotId).writeU(p.nickname, 66).writeC(p.nickColor).toBytes());
  room.updateSlotsInfo();
}
/** C# PROTOCOL_ROOM_GET_USER_ITEM_ACK (3647): accessory, dino/spray/namecard, 18 equip blocks. Team char by the target's room team. */
function roomUserItemAck(room: RoomModel, t: Account): Uint8Array {
  const e = t.equipment, inv = t.inventory;
  const ts = room.getSlot(t.slotId);
  const chara = ts && room.validateTeam(ts.team, ts.team) !== Team.FR ? e.charaBlueId : e.charaRedId;
  const w = W(256).writeH(3647).writeH(0).writeB(equipmentDataChara(inv, e.accessoryId)).writeH(0);
  w.writeC(3).writeB(equipmentDataChara(inv, e.dinoItem)).writeB(equipmentDataChara(inv, e.sprayId)).writeB(equipmentDataChara(inv, e.nameCardId));
  for (const b of charaBlock(t, chara)) w.writeB(b);
  return w.toBytes();
}

export async function handleUseItem(c: GameClient, r: PacketReader): Promise<void> {
  const objId = BigInt(r.readSignedD());
  const len = r.readC(), buf = r.readB(len);
  const p = c.player;
  if (!p) return;
  const item = p.inventory.getItemByObject(objId);
  const eff = item ? 1600000 + num(item.id) : 0;
  if (!(item && (item.id > 1700000 || (cls(item.id) === 16 && [1600187, 1600009, 1600205, 1600006, 1600010, 1600014].includes(eff))) && COSMETIC.includes(eff))) return runItemAuth(c, objId);
  const exp = yyMMddHHmm(new Date(Date.now() + sub(item.id) * 86400000));
  const u32 = buf.length >= 4 ? new DataView(buf.buffer, buf.byteOffset).getUint32(0, true) : 0;
  const arg = [1600005, 1600052, 1600187].includes(eff) ? u32 : buf.length > 0 ? buf[0] : 0;
  const name = utf16Arg(buf);
  let code = 1;
  const grant = async (name: string) => {
    const m = new ItemsModel(eff, `${name} [Active]`, ItemEquipType.Temporary, exp);
    await tryCreateItem(m, p);
    c.session.send(gp.inventoryGetInfoAck(0, p, [m]));
  };
  const b = p.bonus;
  switch (eff) {
    case 1600006:
      if (await dao.update1("accounts", "nick_color", arg, "player_id", p.playerId)) { p.nickColor = arg; c.session.send(gp.invItemDataAck(p)); c.session.send(gp.myInfoBasicAck(p, p.clan)); await grant("Name Color"); const room = roomOf(p); if (room) { room.sendToPlayers(W(8).writeH(3629).writeD(p.slotId).writeC(p.nickColor).toBytes()); room.updateSlotsInfo(); } } // 3629 ROOM_GET_COLOR_NICK_ACK (C# USE_ITEM_REQ :111) else code = 0x80000000;
      break;
    case 1600009:
      if (arg < 51 && p.rank - 10 <= arg && arg <= p.rank + 10 && (await dao.update1("player_bonus", "fake_rank", arg, "owner_id", p.playerId))) { b.fakeRank = arg; c.session.send(gp.invItemDataAck(p)); c.session.send(gp.myInfoBasicAck(p, p.clan)); await grant("Fake Rank"); } else code = 0x80000000;
      break;
    case 1600014:
      if (await dao.update1("player_bonus", "crosshair_color", arg, "owner_id", p.playerId)) { b.crosshairColor = arg; c.session.send(gp.invItemDataAck(p)); await grant("Crosshair Color"); } else code = 0x80000000;
      break;
    case 1600187:
      if (await dao.update1("player_bonus", "muzzle_color", arg, "owner_id", p.playerId)) {
        b.muzzleColor = arg; c.session.send(gp.invItemDataAck(p)); await grant("Muzzle Color");
        // C# 1600187: 3671 ROOM_GET_COLOR_MUZZLE_FLASH_ACK (slot D, colour H) to the room; the others tint their flash with it
        roomOf(p)?.sendToPlayers(W(8).writeH(3671).writeD(p.slotId).writeH(arg).toBytes());
      } else code = 0x80000000;
      break;
    case 1600205:
      if (await dao.update1("player_bonus", "nick_border_color", arg, "owner_id", p.playerId)) {
        b.nickBorderColor = arg; c.session.send(gp.invItemDataAck(p)); await grant("Nick Border Color");
        // C# 1600205: 3639 ROOM_GET_NICK_OUTLINE_COLOR_ACK (slot D, colour C) to the room
        roomOf(p)?.sendToPlayers(W(7).writeH(3639).writeD(p.slotId).writeC(arg).toBytes());
      } else code = 0x80000000;
      break;
    case 1600052: {
      // C# PROTOCOL_INVENTORY_USE_ITEM_REQ case 1600052: owner only, logo must be free (IsClanLogoExist), then 867 to the clan
      const cl = await clanById(p.clanId);
      const free = cl && (Number((await pool.query(`SELECT COUNT(*) AS n FROM system_clan WHERE logo=$1`, [arg])).rows[0].n) === 0);
      if (cl && cl.ownerId === p.playerId && free && (await dao.update1("system_clan", "logo", arg, "id", cl.id))) {
        const pkt = new PacketWriter(8).writeH(867).writeD(arg).toBytes();
        // the online members' cached clan row takes the new logo too (their profile / room packets read it)
        for (const a of social.online.values()) if (a.clanId === cl.id) { if (a.clan) a.clan.logo = arg; social.send(a, pkt); }
      } else code = 0x80000000;
      break;
    }
    case 1600005: { // C# Method0 1600005: owner only, system_clan.name_color; 902 to the user + MYINFO_BASIC
      const cl = await clanById(p.clanId);
      if (cl && cl.ownerId === p.playerId && (await dao.update1("system_clan", "name_color", arg, "id", cl.id))) {
        for (const a of clanMembersOnline(cl.id)) if (a.clan) a.clan.nameColor = arg;
        c.session.send(W(8).writeH(902).writeC(arg).toBytes());
        c.session.send(gp.myInfoBasicAck(p, p.clan));
      } else code = 0x80000000;
      break;
    }
    case 1600010:
    case 1600186: { // C# Method0 1600010 / FakeNickEvent: 4..16 chars; the real nick goes to player_bonus.fake_nick (1055 restores it)
      if (!validNick(name)) { code = 0x80000000; break; }
      const old = p.nickname;
      if (!(await dao.update1("player_bonus", "fake_nick", old, "owner_id", p.playerId)) || !(await dao.update1("accounts", "nickname", name, "player_id", p.playerId))) { code = 0x80000000; break; }
      b.fakeNick = old; p.nickname = name;
      c.session.send(gp.invItemDataAck(p));
      sendNickChanged(c, p);
      await grant("Fake Nick");
      break;
    }
    case 1600047: { // C# Method0 1600047: 4..16 chars, no active fake nick (1600010), name not taken; history row; 1836 + room, clan 851, friends
      if (!validNick(name) || p.inventory.getItem(1600010)) { code = 0x80000000; break; }
      if (await nickExists(name)) { code = 0x80000113; break; }
      if (!(await dao.update1("accounts", "nickname", name, "player_id", p.playerId))) { code = 0x80000000; break; }
      await pool.query(`INSERT INTO base_nick_history(owner_id, old_nick, new_nick, change_date, motive) VALUES($1, $2, $3, $4, $5)`, [pid(p), p.nickname, name, yyMMddHHmm(new Date()), "Nickname changed (Item)"]).catch((e) => log(`nick history: ${(e as Error).message}`));
      p.nickname = name;
      sendNickChanged(c, p);
      if (p.clanId > 0) for (const a of clanMembersOnline(p.clanId)) social.send(a, clanMemberAck(p));
      await syncPlayerToFriends(p, true);
      break;
    }
    case 1600051: { // C# Method0 1600051: owner only, 1..16 chars, name not taken; 864 to every online clan member
      const cl = await clanById(p.clanId);
      const taken = name.length > 0 && Number((await pool.query(`SELECT COUNT(*) AS n FROM system_clan WHERE name=$1`, [name])).rows[0].n) > 0;
      if (cl && cl.ownerId === p.playerId && name.length > 0 && name.length <= 16 && !taken && (await dao.update1("system_clan", "name", name, "id", cl.id))) {
        const pkt = W(40).writeH(864).writeU(name, 34).toBytes();
        for (const a of clanMembersOnline(cl.id)) { if (a.clan) a.clan.name = name; social.send(a, pkt); }
      } else code = 0x80000000;
      break;
    }
    case 1600085: { // C# Method0 1600085: room slot in arg; 3647 with that user's equipment
      const room = roomOf(p), s = room?.getSlot(arg);
      const t = room && s && s.playerId > 0n ? room.svc.getAccount(s.playerId) : null;
      if (room && t) c.session.send(roomUserItemAck(room, t)); else code = 0x80000000;
      break;
    }
    case 1600193: { // C# Method0 1600193: owner only, system_clan.effects; 982 to the clan, MYINFO_BASIC to the user
      const cl = await clanById(p.clanId);
      if (cl && cl.ownerId === p.playerId && (await dao.update1("system_clan", "effects", arg, "id", cl.id))) {
        for (const a of clanMembersOnline(cl.id)) { if (a.clan) a.clan.effect = arg; social.send(a, W(4).writeH(982).writeC(arg).toBytes()); }
        c.session.send(gp.myInfoBasicAck(p, p.clan));
      } else code = 0x80000000;
      break;
    }
    default:
      log(`1052 cosmetic ${eff} not ported`);
      code = 0x80000000;
  }
  c.session.send(await itemAuthAck(code, item, p));
}

// ---- 1055 ----
export async function handleDeleteItem(c: GameClient, r: PacketReader): Promise<void> {
  const objId = BigInt(r.readD());
  const p = c.player;
  if (!p) return;
  let code = 1;
  const item = p.inventory.getItemByObject(objId);
  if (!item) code = 0x80000000;
  else if (cls(item.id) === 16) {
    const b = p.bonus, before = [b.bonuses, b.freePass];
    removeBonusFlag(p, item.id);
    if (b.bonuses !== before[0] || b.freePass !== before[1]) await dao.updatePlayerBonus(p.playerId, b.bonuses, b.freePass);
    else if (item.id === 1600014) { if (await dao.update1("player_bonus", "crosshair_color", 4, "owner_id", p.playerId)) { b.crosshairColor = 4; c.session.send(gp.invItemDataAck(p)); c.session.send(gp.myInfoBasicAck(p, p.clan)); } else code = 0x80000000; }
    else if (item.id === 1600009) { if (await dao.update1("player_bonus", "fake_rank", NO_FAKE_RANK, "owner_id", p.playerId)) { b.fakeRank = NO_FAKE_RANK; c.session.send(gp.invItemDataAck(p)); c.session.send(gp.myInfoBasicAck(p, p.clan)); } else code = 0x80000000; }
    else if (item.id === 1600187) { if (await dao.update1("player_bonus", "muzzle_color", 0, "owner_id", p.playerId)) { b.muzzleColor = 0; c.session.send(gp.invItemDataAck(p)); } else code = 0x80000000; }
    else if (item.id === 1600006) code = 0x80000000; // C# UpdateDB("accounts","nick_color",0,"owner_id",pid): accounts has no owner_id -> exception -> FAIL (kept)
    else if (item.id === 1600010) {
      if (b.fakeNick !== "" && (await dao.update1("accounts", "nickname", b.fakeNick, "player_id", p.playerId)) && (await dao.update1("player_bonus", "fake_nick", "", "owner_id", p.playerId))) {
        p.nickname = b.fakeNick; b.fakeNick = ""; c.session.send(gp.invItemDataAck(p)); c.session.send(gp.myInfoBasicAck(p, p.clan));
      } else code = 0x80000000;
    }
    const flag = data.coupons.get(item.id) ?? 0n;
    if (flag > 0n && (p.effects & flag) === flag) { p.effects -= flag; await dao.update1("accounts", "coupon_effect", p.effects.toString(), "player_id", p.playerId); }
  }
  if (code === 1 && item) {
    if (await deleteItem(item.objectId, p)) p.inventory.items = p.inventory.items.filter((x) => x !== item);
    else code = 0x80000000;
  }
  c.session.send(deleteItemAck(code, objId));
}

function removeBonusFlag(p: Account, itemId: number): void {
  const b = p.bonus;
  const clr = (v: number) => { if ((b.bonuses & v) === v) b.bonuses -= v; };
  switch (itemId) {
    case 1600001: clr(1); break; case 1600002: clr(2); break; case 1600003: clr(4); break; case 1600004: clr(32); break;
    case 1600011: case 1600162: if ((b.freePass & 128) === 128) b.freePass -= 128; break;
    case 1600012: clr(256); break; case 1600037: clr(8); break; case 1600038: clr(128); break; case 1600119: clr(64); break;
    case 1600201: clr(512); break; case 1600202: clr(1024); break; case 1600203: clr(2048); break; case 1600204: clr(4096); break;
  }
}

// ---- inventory expansion (AllUtils INVENTORY EXPANSION) ----
const INVENTORY_MAX_PLUS = 400;
const EXPANSION_SLOTS = new Map<number, number>([[3601005, 50]]);
export const inventoryExpansionSlots = (itemId: number) => EXPANSION_SLOTS.get(itemId) ?? 0;
export const canExtendInventory = (p: Account, add: number) => add > 0 && p.inventoryPlus + add <= INVENTORY_MAX_PLUS;
function notifyInventoryExtended(c: GameClient, p: Account, add: number): void {
  c.session.send(maxUpAck(0, p, add));
  c.session.send(announce(`Capacidade do inventário ampliada em ${add} espaços.`));
  log(`[Inventory] Player ${p.playerId} inventory plus ${p.inventoryPlus - add} -> ${p.inventoryPlus} (+${add})`);
}
export async function extendInventory(c: GameClient, p: Account, add: number): Promise<boolean> {
  if (!canExtendInventory(p, add)) return false;
  if (!(await dao.update1("accounts", "inventory_plus", p.inventoryPlus + add, "player_id", p.playerId))) return false;
  p.inventoryPlus += add;
  notifyInventoryExtended(c, p, add);
  return true;
}

// ---- random boxes (1047 on a RandomBoxXML coupon -> 1067 CAPSULE, 1073 JACKPOT broadcast; 2500 -> 2501 list) ----
const jackpotAck = (nick: string, boxId: number, index: number) => {
  const w = W(32 + nick.length * 2).writeH(1073).writeH(0).writeC(index & 0xff).writeD(boxId).writeC(nick.length);
  for (let i = 0; i < nick.length; i++) w.writeH(nick.charCodeAt(i));
  return w.toBytes();
};
const rnd = (lo: number, hi: number) => (hi <= lo ? lo : lo + Math.floor(Math.random() * (hi - lo)));
async function openRandomBox(c: GameClient, p: Account, boxId: number): Promise<number> {
  const box = data.randomBoxes.get(boxId);
  if (!box) return 0x80000000;
  let percent = rnd(1, 100);
  if (percent < box.minPercent) percent = box.minPercent;
  const sorted = box.items.filter((i) => percent <= i.percent);
  const pick = rnd(0, sorted.length);
  const rewards = sorted.length ? sorted.filter((i) => i.index === sorted[pick].index) : [];
  if (!rewards.length) return 0x80000000;
  const index = rewards[0].index, won: number[] = [], models: ItemsModel[] = [];
  let code = 1;
  for (const rw of rewards) {
    const good = getGood(rw.goodsId);
    if (good) { models.push(good.item.clone()); const pos = box.items.indexOf(rw); if (pos >= 0) won.push(pos); }
    else if (await dao.addMoney(p, index)) c.session.send(plusPointAck(index, p.gold));
    else { code = 0x80000000; break; }
    if (rw.special) { const j = jackpotAck(p.nickname, boxId, index); for (const a of broadcastTargets()) (a.connection as GameClient | null)?.session.send(j); }
  }
  c.session.send(capsuleAck(won.slice(0, 20), boxId));
  if (models.length) { for (const m of models) await tryCreateItem(m, p); c.session.send(gp.inventoryGetInfoAck(0, p, models)); }
  return code;
}
/** GameXender.BroadcastToAll: every account online on the TS game servers (wired by gameServer.ts). */
export let broadcastTargets: () => Iterable<Account> = () => [];
export function setBroadcastTargets(f: () => Iterable<Account>): void { broadcastTargets = f; }

let randomBoxPacked: Uint8Array | null | undefined;
/** PROTOCOL_BASE_RANDOMBOX_LIST_REQ (2500: C count, S[33] hash): full catalog first when the shop is not loaded, then 2501 chunks of 8000. */
export function handleRandomBoxList(c: GameClient, r: PacketReader): void {
  r.readC(); r.readS(33);
  const p = c.player;
  if (!p) return;
  if (!p.loadedShop) { p.loadedShop = true; for (const b of gp.fullCatalog(p, true)) c.session.send(b); }
  if (randomBoxPacked === undefined) randomBoxPacked = data.randomBoxRaw ? zlibCompress(data.randomBoxRaw) : null;
  const packed = randomBoxPacked;
  if (!packed || packed.length === 0) { c.session.send(W(16).writeH(2501).writeD(0).writeD(0).writeD(0).toBytes()); return; }
  for (let o = 0; o < packed.length; o += 8000) {
    const ch = packed.subarray(o, Math.min(o + 8000, packed.length));
    c.session.send(W(ch.length + 16).writeH(2501).writeD(packed.length).writeD(o).writeD(ch.length).writeB(ch).toBytes());
  }
}

// ---- clan items (1800053 record reset, 1800055 +50 members, 1800056 point reset) ----
async function clanItem(c: GameClient, p: Account, id: number): Promise<number> {
  const cl = p.clanId > 0 ? (await pool.query(`SELECT id, owner_id, max_players, point FROM system_clan WHERE id=$1`, [p.clanId])).rows[0] : null;
  const owner = !!cl && BigInt(String(cl.owner_id)) === p.playerId;
  if (id === 1800053) {
    // owner check before the UPDATE: a non-owner must not zero the clan's record (C# ran the UPDATE first)
    if (!cl || !owner) return 0x80000000;
    if (!(await pool.query(`UPDATE system_clan SET matches=0, match_wins=0, match_loses=0 WHERE id=$1`, [p.clanId]).then(() => true, () => false))) return 0x80000000;
    c.session.send(W(4).writeH(909).toBytes());
    return 1;
  }
  if (id === 1800055) {
    if (!cl || !owner) return 0x80001056;
    const max = Number(cl.max_players);
    if (!(max + 50 <= 250) || !(await dao.update1("system_clan", "max_players", max + 50, "id", p.clanId))) return 0x80001056;
    c.session.send(W(8).writeH(873).writeD(0).writeC(max + 50).toBytes());
    return 1;
  }
  if (!cl || Number(cl.point) === 1000) return 0x80001056;
  if (!(await dao.update1("system_clan", "point", 1000, "id", p.clanId))) return 0x80001056;
  c.session.send(W(4).writeH(910).toBytes());
  return 1;
}

// ---- 3333 ----
export async function handleInventoryUpgrade(c: GameClient): Promise<void> {
  const p = c.player;
  if (!p) return;
  if (!(p.inventoryPlus + 100 <= 400)) return c.session.send(maxUpAck(-2 >>> 0));
  if (p.cash < 10000) return c.session.send(maxUpAck(0x80002760));
  if (!(await dao.addMoney(p, 0, -10000))) return c.session.send(maxUpAck(p.cash < 10000 ? 0x80002760 : -1 >>> 0));
  if (await dao.update1("accounts", "inventory_plus", p.inventoryPlus + 100, "player_id", p.playerId)) {
    p.inventoryPlus += 100;
    c.session.send(maxUpAck(0, p, 100));
    c.session.send(announce("Capacidade do inventário ampliada em 100 espaços."));
  } else {
    await dao.addMoney(p, 0, 10000);
    c.session.send(maxUpAck(-1 >>> 0));
  }
}

// ---- 1076 ----
export async function handleRepair(c: GameClient, r: PacketReader): Promise<void> {
  const n = r.readC(), ids: bigint[] = [];
  for (let i = 0; i < n; i++) ids.push(BigInt(r.readD()));
  const p = c.player;
  if (!p) return;
  const list: ItemsModel[] = [], fix: [ItemsModel, number][] = [];
  let gold = 0, cash = 0, err = 0;
  for (const oid of ids) {
    const item = p.inventory.getItemByObject(oid);
    if (!item) { err = 0x80000110; continue; }
    list.push(item);
    const rep = shop.repairs.find((x) => x.id === item.id);
    if (!rep) { err = 0x80000110; continue; }
    const dmg = rep.quantity - item.count;
    let okCost = false;
    if (rep.point <= rep.cash) {
      if (rep.cash > rep.point && p.cash >= Math.trunc((rep.cash * dmg) / 100)) { cash += Math.trunc((rep.cash * dmg) / 100); okCost = true; }
    } else if (p.gold >= Math.trunc((rep.point * dmg) / 100)) { gold += Math.trunc((rep.point * dmg) / 100); okCost = true; }
    if (!okCost) { err = 0x80000110; continue; }
    fix.push([item, rep.quantity]);
    err = 1;
  }
  if (list.length === 0) return;
  // the whole bill is one conditional debit, taken before any item is repaired (C#: repair, then write the balance from memory)
  if (await dao.addMoney(p, -gold, -cash)) {
    for (const [item, q] of fix) { item.count = q; await pool.query(`UPDATE player_items SET count=$1 WHERE owner_id=$2 AND id=$3`, [item.count, pid(p), item.id]); }
    c.session.send(gp.inventoryGetInfoAck(2, p, list));
  } else err = 0x80000110;
  const w = W(64).writeH(1084).writeH(0);
  if (err === 1) { w.writeC(list.length); for (const it of list) w.writeD(oid32(it.objectId)).writeD(it.id); w.writeD(p.cash).writeD(p.gold); }
  else w.writeD(err);
  c.session.send(w.toBytes());
}

// ---- 1060 ----
export function handleGetPointCash(c: GameClient): void {
  const p = c.player;
  if (!p) return;
  c.session.send(pointCashAck(0, p));
  if (p.refreshLobbyInfo) {
    p.refreshLobbyInfo = false;
    c.session.send(gp.myInfoBasicAck(p, p.clan));
    c.session.send(gp.myInfoRecordAck(p));
    c.session.send(getCharaInfoAck(p));
  }
}

void config;
