// F4 (Server.Game ClientPacket ports): characters 6145/6151, CreateCharacter (Game), room player info 3596, nick
// 2326/1061/1063/1064, records 2350/2414, user detail 2422/2424/2425/2426, 2447, titles 2376/2378/2380, coupon 1091.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { PacketWriter, type PacketReader } from "../../../src/net/packet.ts";
import { pool } from "../db.ts";
import { config, parseIni } from "../config.ts";
import type { Account } from "../shared/account.ts";
import * as dao from "../shared/dao.ts";
import { data } from "../shared/data.ts";
import { ItemsModel } from "../shared/items.ts";
import { newStat, type Stat, type CharacterModel } from "../shared/models.ts";
import * as pu from "../shared/playerUtils.ts";
import { getGood, shop, type GoodsItem } from "../shared/shop.ts";
import { nowNum } from "../shared/time.ts";
import { pointCashAck } from "../auth/packets.ts";
import { getCharaInfoAck, charaBlock, equipmentDataChara, equipmentData, writeUserInfoBasic, questingInfo } from "../auth/metaPackets.ts";
import * as gp from "./packets.ts";
import { roomOf } from "./roomHandlers.ts";
import { Team } from "./roomModel.ts";
import type { GameClient } from "./gameServer.ts";
import { isReservedNick } from "../web/accounts/validation.ts";
import { enforceRoomWeapons } from "../../../src/game/respawnSelect.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} [game-ts] ${m}`);
const W = (n = 64) => new PacketWriter(n);
const oid32 = (v: bigint) => Number(BigInt.asUintN(32, v));

// ---- static data --------------------------------------------------------------------------------------------------
interface TitleModel { id: number; classId: number; ribbon: number; ensign: number; medal: number; masterMedal: number; rank: number; slot: number; req1: number; req2: number; flag: bigint }
interface Ticket { token: string; type: string; ticketCount: number; playerRation: number; gold: number; cash: number; tags: number; rewards: number[] }
const st = {
  titles: new Map<number, TitleModel>(),
  titleAwards: [] as { titleId: number; item: ItemsModel }[],
  tickets: [] as Ticket[],
  nickFilters: [] as string[],
  minNick: 4,
  maxNick: 16,
};
export const titlesTable = () => st.titles;
export async function loadProfileData(): Promise<void> {
  st.titles = new Map((await pool.query(`SELECT * FROM system_titles`)).rows.map((x) => [Number(x.id), {
    id: Number(x.id), classId: Number(x.class_id), ribbon: Number(x.ribbon), ensign: Number(x.ensign), medal: Number(x.medal), masterMedal: Number(x.master_medal),
    rank: Number(x.rank), slot: Number(x.slot), req1: Number(x.req_title_1), req2: Number(x.req_title_2), flag: 1n << BigInt(Number(x.id)),
  }]));
  st.titleAwards = (await pool.query(`SELECT title_id, item_id, item_count, equip_type, item_name FROM system_title_awards ORDER BY title_id ASC, ordinal ASC`)).rows.map((x) => {
    const it = new ItemsModel(Number(x.item_id), x.item_name == null ? "" : String(x.item_name), Number(x.equip_type), Number(x.item_count));
    return { titleId: Number(x.title_id), item: it };
  });
  const tk = (await pool.query(`SELECT token, type, ticket_count, player_ration, gold_reward, cash_reward, tags_reward FROM system_redeem_codes ORDER BY token ASC`)).rows.map((x): Ticket => ({
    token: String(x.token), type: String(x.type), ticketCount: Number(x.ticket_count), playerRation: Number(x.player_ration ?? 1), gold: Number(x.gold_reward ?? 0), cash: Number(x.cash_reward ?? 0), tags: Number(x.tags_reward ?? 0), rewards: [],
  }));
  for (const x of (await pool.query(`SELECT token, type, good_id FROM system_redeem_code_rewards ORDER BY token ASC, ordinal ASC`)).rows) tk.find((t) => t.token === String(x.token) && t.type === String(x.type))?.rewards.push(Number(x.good_id));
  st.tickets = tk;
  const f = path.join(config.configDir, "Filters", "Nicks.txt");
  st.nickFilters = existsSync(f) ? readFileSync(f, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  const ini = parseIni(readFileSync(path.join(config.configDir, "Settings.ini"), "utf8"));
  st.minNick = Number(ini.Essentials?.MinNickSize ?? 4);
  st.maxNick = Number(ini.Essentials?.MaxNickSize ?? 16);
}

// ---- characters ----------------------------------------------------------------------------------------------------

/** PROTOCOL_CHAR_CREATE_CHARA_ACK (6146). */
export function createCharaAck(result: number, field5: number, ch: CharacterModel | null, p: Account | null): Uint8Array {
  const w = W(200).writeH(6146).writeH(0).writeD(result);
  if (result !== 0 || !ch || !p) return w.toBytes();
  w.writeC(0);
  for (const b of charaBlock(p, ch.id)) w.writeB(b);
  return w.writeD(p.cash).writeD(p.gold).writeC(field5).writeC(20).writeC(ch.slot).writeC(1).toBytes();
}

/** AllUtils.CreateCharacter (Game): 3334 (TryCreateItem) then the player_characters row and 6146(0, 3). */
export async function createCharacterGame(c: GameClient, p: Account, item: ItemsModel): Promise<void> {
  const model = item.clone();
  await pu.tryCreateItem(model, p);
  c.session.send(gp.inventoryGetInfoAck(0, p, [model]));
  const own = p.inventory.getItem(item.id);
  const ch: CharacterModel = { objectId: own ? own.objectId : item.objectId, id: item.id, name: item.name, slot: pu.nextCharaSlot(p), createDate: nowNum("yyMMddHHmm"), playTime: 0 };
  p.character.characters.push(ch);
  if (await dao.createPlayerCharacter(ch, p.playerId)) c.session.send(createCharaAck(0, 3, ch, p));
  else c.session.send(createCharaAck(0x80000000, 255, null, null));
}

/** ShopManager.GetGoods(cart) + TryApplyCartPrice. */
export function getGoods(cart: { goodId: number; buyType: number }[]): { goods: GoodsItem[]; gold: number; cash: number } | null {
  if (cart.length === 0) return null;
  const found = new Set<number>(), goods: GoodsItem[] = [];
  let gold = 0, cash = 0;
  const pass = (list: GoodsItem[]): boolean => {
    for (const g of list) for (const it of cart) {
      if (it.goodId !== g.id || found.has(g.id)) continue;
      // [web] a price of 1 is Shop.dat's not-for-sale mark (ShopStore.ts NOT_FOR_SALE_PRICE): never bought for 1
      if (it.buyType === 2 && g.priceGold > 1) gold += g.priceGold;
      else if (it.buyType === 1 && g.priceCash > 1) cash += g.priceCash;
      else if (g.priceCash > 1) cash += g.priceCash;
      else if (g.priceGold > 1) gold += g.priceGold;
      else return false;
      goods.push(g);
      found.add(g.id);
    }
    return true;
  };
  if (!pass(shop.buyable)) return null;
  if (found.size < cart.length && !pass(shop.all)) return null;
  return found.size === cart.length ? { goods, gold, cash } : null;
}

export async function handleCreateChara(c: GameClient, r: PacketReader): Promise<void> {
  r.readC();
  const name = r.readU(r.readC() * 2);
  r.readC();
  const goodId = r.readD(), buyType = r.readC();
  const p = c.player;
  if (!p) return;
  if (!(p.inventory.items.length < 1500 && p.character.characters.length < 150)) return c.session.send(createCharaAck(0x800010b9, 0, null, null));
  const res = getGoods([{ goodId, buyType }]);
  if (!res) return c.session.send(createCharaAck(0x80001017, 0, null, null));
  if (p.gold - res.gold < 0 || p.cash - res.cash < 0) return c.session.send(createCharaAck(0x80001018, 0, null, null));
  if (!(await dao.addMoney(p, -res.gold, -res.cash))) // conditional debit by delta
    return c.session.send(createCharaAck(p.gold < res.gold || p.cash < res.cash ? 0x80001018 : 0x80001019, 0, null, null));
  const models = res.goods.map((g) => g.item.clone());
  for (const m of models) await pu.tryCreateItem(m, p);
  c.session.send(gp.inventoryGetInfoAck(0, p, models));
  const g = res.goods.find((x) => x.item.id !== 0);
  let ch: CharacterModel | null = null;
  if (g) {
    ch = { objectId: 0n, id: g.item.id, slot: p.character.characters.length, name, createDate: nowNum("yyMMddHHmm"), playTime: 0 };
    const it = p.inventory.getItem(ch.id);
    if (it) ch.objectId = it.objectId;
    p.character.characters.push(ch);
    await dao.createPlayerCharacter(ch, p.playerId);
  }
  if (ch) c.session.send(createCharaAck(0, 1, ch, p)); // null -> the C# Write throws, nothing is sent
}

export async function handleDeleteChara(c: GameClient, r: PacketReader): Promise<void> {
  const slot = r.readC();
  const p = c.player;
  if (!p) return;
  const fail = () => c.session.send(W(8).writeH(6152).writeD(0x800010a7).toBytes());
  const ch = p.character.getCharacterSlot(slot);
  const it = ch ? p.inventory.getItem(ch.id) : null;
  if (!ch || !it) return fail();
  const del = async (t: string, oid: bigint) => oid !== 0n && p.playerId !== 0n && (await pool.query(`DELETE FROM ${t} WHERE object_id=$1 AND owner_id=$2`, [String(oid), String(p.playerId)]).then(() => true, () => false));
  const okC = await del("player_characters", ch.objectId), okI = await del("player_items", it.objectId);
  if (!okC || !okI) return fail();
  p.character.characters = p.character.characters.filter((x) => x !== ch);
  p.inventory.items = p.inventory.items.filter((x) => x !== it);
  let i = 0;
  for (const x of [...p.character.characters].sort((a, b) => a.slot - b.slot)) {
    if (x.slot !== i) { x.slot = i; await pool.query(`UPDATE player_characters SET slot=$1 WHERE object_id=$2 AND owner_id=$3`, [i, String(x.objectId), String(p.playerId)]); }
    i++;
  }
  let type = Math.trunc((it.id % 100000) / 1000);
  if (it.id >= 632001 && it.id <= 632999) type = 1;
  if (it.id >= 664001 && it.id <= 664999) type = 2;
  const w = W(16).writeH(6152).writeD(0).writeC(slot).writeD(oid32(it.objectId));
  if (type === 1 || type === 2) {
    const eq = p.character.getCharacter(type === 1 ? p.equipment.charaRedId : p.equipment.charaBlueId);
    if (!eq) { c.session.send(getCharaInfoAck(p)); return; } // C# Write throws: 6152 not sent
    w.writeD(eq.slot);
  }
  c.session.send(w.toBytes());
  c.session.send(getCharaInfoAck(p));
}

// ---- room player info / records ----------------------------------------------------------------------------------

const recordFields = ["matches", "matchWins", "matchLoses", "matchDraws", "killsCount", "headshotsCount", "deathsCount", "totalMatchesCount", "totalKillsCount", "escapesCount", "assistsCount", "mvpCount"];
const writeRecords = (w: PacketWriter, a: Account) => { for (const s of [a.statistic.season ?? newStat("season"), a.statistic.basic ?? newStat("basic")] as Stat[]) for (const f of recordFields) w.writeD(s[f]); };

export function handleRoomPlayerInfo(c: GameClient, r: PacketReader): void {
  const slot = r.readD();
  const p = c.player, room = roomOf(p);
  if (!p || !room) return;
  const s = room.getSlot(slot);
  const t = s && s.playerId > 0n ? room.svc.getAccount(s.playerId) : null;
  if (!t) return;
  const w = W(480).writeH(3597).writeH(0).writeD(0).writeB(equipmentDataChara(t.inventory, t.equipment.accessoryId));
  writeRecords(w, t);
  w.writeC(3).writeB(equipmentDataChara(t.inventory, t.equipment.dinoItem)).writeB(equipmentDataChara(t.inventory, t.equipment.sprayId)).writeB(equipmentDataChara(t.inventory, t.equipment.nameCardId));
  const ts = room.getSlot(t.slotId);
  const chara = !ts ? -1 : room.validateTeam(ts.team, ts.team) === Team.FR ? t.equipment.charaRedId : t.equipment.charaBlueId;
  const blocks = charaBlock(t, chara < 0 ? 0 : chara);
  if (chara < 0) blocks[8] = new Uint8Array(8);
  // Sniper / Shotgun / Knife room: the asker has no inventory of the target to swap a barred weapon for, so the
  // weapon blocks carry the same pick the target's own client makes for its respawn (enforceRoomWeapons)
  const e = t.equipment;
  const owned = t.inventory.items.filter((i) => i.equip !== 1).map((i) => ({ itemId: i.id }));
  enforceRoomWeapons([e.weaponPrimary, e.weaponSecondary, e.weaponMelee, e.weaponExplosive, e.weaponSpecial].map((itemId) => ({ itemId })), owned, room.weaponsFlag, { itemId: 0 }, room.stage)
    .forEach((p, i) => { blocks[i] = equipmentDataChara(t.inventory, p.itemId); });
  for (const b of blocks) w.writeB(b);
  w.writeC(3).zeros(3);
  writeUserInfoBasic(w, t, t.clan, true);
  c.session.send(w.writeC(0).writeC(0).toBytes());
}

export async function handleRecordInfoDB(c: GameClient, r: PacketReader, find: (pid: bigint) => Promise<Account | null>): Promise<void> {
  const target = r.readQ();
  const p = c.player;
  if (!p || target === p.playerId) return;
  const t = await find(target);
  if (!t) return;
  const w = W(100).writeH(2351);
  writeRecords(w, t);
  c.session.send(w.toBytes());
}

export function handleDailyRecord(c: GameClient): void {
  const p = c.player;
  const d = p?.statistic.daily;
  if (!p || !d) return;
  c.session.send(W(64).writeH(2415).writeH(d.matches).writeH(d.matchWins).writeH(d.matchLoses).writeH(d.matchDraws).writeH(d.killsCount).writeH(d.headshotsCount)
    .writeH(d.deathsCount).writeD(d.expGained).writeD(d.pointGained).writeD(d.playtime).writeC(p.event.lastPlaytimeFinish).writeD(p.event.lastPlaytimeValue)
    .writeH(0).writeD(0).writeD(0).writeC(0).writeD(0).toBytes());
}

/** PROTOCOL_BASE_GET_USER_DETAIL_INFO_ACK (2438). */
export function userDetailAck(err: number, a: Account | null): Uint8Array {
  const w = W(2330).writeH(2438).writeH(0).writeD(err);
  if (err !== 0 || !a) return w.toBytes();
  const s = a.statistic.season ?? newStat("season");
  w.zeros(12).writeQ(a.playerId).writeU(a.nickname, 66).writeU(a.clan.name, 34).writeD(a.clan.logo).writeC(a.clan.effect).writeC(0).writeD(0).writeD(0);
  for (const f of ["matches", "matchWins", "matchDraws", "matchLoses", "escapesCount", "killsCount", "deathsCount", "headshotsCount", "assistsCount", "mvpCount"]) w.writeD(s[f]);
  w.zeros(270).writeC(a.nickColor).writeC(0).writeC(0).writeH(a.bonus.crosshairColor).writeH(a.bonus.muzzleColor).zeros(19)
    .writeC(a.bonus.nickBorderColor).writeD(a.bonus.fakeRank).writeD(a.bonus.fakeRank).zeros(1840);
  return w.toBytes();
}

export async function handleUserDetail(c: GameClient, op: number, r: PacketReader, look: { bySession(id: number): Account | null; byPid(pid: bigint): Promise<Account | null>; byNick(n: string): Promise<Account | null> }): Promise<void> {
  const p = c.player;
  if (!p) return;
  if (op === 2422) {
    const t = look.bySession(r.readD());
    if (!t) return;
    c.session.send(userDetailAck(0, t));
  } else if (op === 2424) {
    const room = roomOf(p), s = room?.getSlot(r.readD());
    const t = s && s.playerId > 0n ? room!.svc.getAccount(s.playerId) : null;
    if (t) c.session.send(userDetailAck(0, t));
  } else if (op === 2425) {
    const pid = r.readQ();
    const t = await look.byPid(pid);
    if (t && p.nickname && pid !== p.playerId) { c.session.send(userDetailAck(0, t)); c.session.send(W(8).writeH(2427).writeH(0).writeD(0).toBytes()); }
    else c.session.send(W(8).writeH(2427).writeH(0).writeD(0x80001803).toBytes());
  } else if (op === 2426) {
    const nick = r.readU(66);
    if (p.durationSince("findUser") < 1) return;
    p.findPlayer = nick;
    const t = await look.byNick(nick);
    if (t && p.nickname && t.nickname !== p.nickname) { if (p.nickname !== t.nickname) p.findPlayer = t.nickname; c.session.send(userDetailAck(0, t)); }
    p.last.findUser = Date.now();
  }
}

// ---- nick ----------------------------------------------------------------------------------------------------------

const nameExists = async (nick: string) => { if (!nick) return true; try { return Number((await pool.query(`SELECT COUNT(*) AS n FROM accounts WHERE nickname=$1`, [nick])).rows[0].n) > 0; } catch { return false; } };

export async function handleCheckNick(c: GameClient, op: number, r: PacketReader): Promise<void> {
  const nick = r.readU(66);
  if (op === 1061) return c.session.send(W(8).writeH(1065).writeD((await nameExists(nick)) ? 0x80000113 : 0).toBytes());
  if (!nick || nick.length < st.minNick || nick.length > st.maxNick || st.nickFilters.some((f) => nick.includes(f))) return c.session.send(W(8).writeH(1065).writeD(0x80000000).toBytes());
  c.session.send(W(8).writeH(1065).writeD((await nameExists(nick)) ? 0x80000113 : 0).toBytes());
}

export async function handleCreateNick(c: GameClient, r: PacketReader): Promise<void> {
  const nick = r.readU(r.readC() * 2);
  const p = c.player;
  if (!p) return;
  const err = (e: number) => c.session.send(W(8).writeH(2327).writeH(0).writeD(e).toBytes());
  if (!(p.nickname.length === 0 && nick && nick.length >= st.minNick && nick.length <= st.maxNick)) return err(0x80000113);
  if (isReservedNick(nick)) return err(0x80001013);
  if (st.nickFilters.some((f) => nick.includes(f))) return err(0x80001013); // the C# forgot this return: the filtered nick was still created
  if (await nameExists(nick)) return err(0x80000113);
  if (!(await dao.update1("accounts", "nickname", nick, "player_id", p.playerId))) return err(0x80001013);
  await pool.query(`INSERT INTO base_nick_history(owner_id, old_nick, new_nick, change_date, motive) VALUES($1, $2, $3, $4, $5)`, [String(p.playerId), p.nickname, nick, nowNum("yyMMddHHmm"), "First nick choosed"]);
  p.nickname = nick;
  for (const b of data.basics) if (Math.trunc(b.id / 100000) === 6 && !p.character.getCharacter(b.id)) await createCharacterGame(c, p, b);
  for (const a of data.awards) {
    if (Math.trunc(a.id / 100000) === 6 && !p.character.getCharacter(a.id)) await createCharacterGame(c, p, a);
    else { const m = a.clone(); await pu.tryCreateItem(m, p); c.session.send(gp.inventoryGetInfoAck(0, p, [m])); }
  }
  const w = W(64).writeH(2327).writeH(0).writeD(0).writeC(1).writeB(equipmentData(p.inventory, p.equipment.dinoItem)).writeC(nick.length * 2).writeU(nick, nick.length * 2);
  c.session.send(w.toBytes());
  c.session.send(W(16).writeH(1077).writeH(0).writeC(4).writeD(p.gold).writeD(p.gold).toBytes());
  c.session.send(W(96).writeH(2355).writeC(p.mission.actualMission).writeB(questingInfo(p.mission)).toBytes());
  c.session.send(W(8).writeH(1810).writeC(0).toBytes()); // friends: F5 (friendInfoAck)
}

// ---- 2447 -----------------------------------------------------------------------------------------------------------
export function handleUserSubtask(c: GameClient, r: PacketReader, bySession: (id: number) => Account | null): void {
  const sid = r.readD();
  const t = bySession(sid);
  if (!t) return;
  c.session.send(W(16).writeH(2448).writeH(0).writeD(0).writeC(0).writeD(t.session?.sessionId ?? 0).toBytes());
}

// ---- titles ---------------------------------------------------------------------------------------------------------
/** 2363 badges (ribbon / ensign / medal / master medal) and 2383 titles (flags, equipped, slots) of `p`, as the client's Perfil
 * phase reads them. The C# server sends 2383 only from GM commands and 2363 after a get; the web client has no other way to learn
 * its titles, so the lobby entry pushes both [RECRIADO]. */
export const badgesPacket = (p: Account): Uint8Array => W(32).writeH(2363).writeQ(p.playerId).writeD(p.ribbon).writeD(p.ensign).writeD(p.medal).writeD(p.masterMedal).toBytes();
export function titleInfoPackets(p: Account): Uint8Array[] {
  const t = p.title;
  return [
    badgesPacket(p),
    W(32).writeH(2383).writeD(Number(p.playerId & 0xffffffffn)).writeQ(t.flags).writeC(t.equiped1).writeC(t.equiped2).writeC(t.equiped3).writeD(t.slots).toBytes(),
  ];
}
export function sendTitleInfo(c: GameClient): void {
  if (c.player) for (const b of titleInfoPackets(c.player)) c.session.send(b);
}

const hasTitle = (p: Account, f: bigint) => (p.title.flags & f) === f || f === 0n;

export async function handleTitleChange(c: GameClient, r: PacketReader): Promise<void> {
  const tid = r.readC();
  const p = c.player;
  if (!p || tid >= 45) return;
  let err = 0;
  const t = tid ? st.titles.get(tid) : undefined;
  if (!t) err = 0x80001083;
  else {
    const r1 = st.titles.get(t.req1)?.flag ?? 0n, r2 = st.titles.get(t.req2)?.flag ?? 0n;
    if (p.rank >= t.rank && p.ribbon >= t.ribbon && p.medal >= t.medal && p.masterMedal >= t.masterMedal && p.ensign >= t.ensign && !hasTitle(p, t.flag) && hasTitle(p, r1) && hasTitle(p, r2)) {
      p.ribbon -= t.ribbon; p.medal -= t.medal; p.masterMedal -= t.masterMedal; p.ensign -= t.ensign;
      p.title.flags |= t.flag;
      await dao.update1("player_titles", "flags", p.title.flags.toString(), "owner_id", p.playerId);
      const awards = st.titleAwards.filter((a) => a.titleId === tid).map((a) => a.item.clone());
      if (awards.length) { for (const m of awards) await pu.tryCreateItem(m, p); c.session.send(gp.inventoryGetInfoAck(0, p, awards)); }
      c.session.send(badgesPacket(p));
      await dao.updateDB("accounts", "player_id", p.playerId, ["ribbon", "ensign", "medal", "master_medal"], [p.ribbon, p.ensign, p.medal, p.masterMedal]);
      if (p.title.slots < t.slot) { p.title.slots = t.slot; await dao.update1("player_titles", "slots", t.slot, "owner_id", p.playerId); }
    } else err = 0x80001083;
  }
  c.session.send(W(12).writeH(2377).writeD(err).writeD(p.title.slots).toBytes());
}

export async function handleTitleEquip(c: GameClient, r: PacketReader): Promise<void> {
  const idx = r.readC(), tid = r.readC();
  const p = c.player;
  if (!p) return;
  const t = st.titles.get(tid);
  const eq = [p.title.equiped1, p.title.equiped2, p.title.equiped3].map((x) => st.titles.get(x));
  const ok = idx < 3 && tid < 45 && t && eq.every((e, i) => !e || t.classId !== e.classId || idx === i) && hasTitle(p, t.flag) && ![p.title.equiped1, p.title.equiped2, p.title.equiped3].includes(tid);
  if (ok && (await dao.update1("player_titles", `equip_slot${idx + 1}`, tid, "owner_id", p.playerId))) {
    if (idx === 0) p.title.equiped1 = tid; else if (idx === 1) p.title.equiped2 = tid; else p.title.equiped3 = tid;
    c.session.send(W(8).writeH(2379).writeD(0).writeC(idx).writeC(tid).toBytes());
  } else c.session.send(W(8).writeH(2379).writeD(0x80000000).writeC(0xff).writeC(0xff).toBytes());
}

export async function handleTitleRelease(c: GameClient, r: PacketReader): Promise<void> {
  const idx = r.readC(), tid = r.readC();
  const p = c.player;
  if (!p || idx >= 3) return;
  const cur = [p.title.equiped1, p.title.equiped2, p.title.equiped3][idx];
  if (tid < 45 && cur === tid && (await dao.update1("player_titles", `equip_slot${idx + 1}`, 0, "owner_id", p.playerId))) {
    if (idx === 0) p.title.equiped1 = 0; else if (idx === 1) p.title.equiped2 = 0; else p.title.equiped3 = 0;
    const beret = p.equipment.beretItem;
    if (beret && st.titleAwards.some((a) => a.titleId === tid && a.item.id === beret) && (await dao.update1("player_equipments", "beret_item_part", 0, "owner_id", p.playerId))) {
      p.equipment.beretItem = 0;
      const room = roomOf(p);
      if (room) { const s = room.getSlot(p.slotId); if (s) s.equipment = p.equipment; room.updateSlotsInfo(); }
    }
    c.session.send(W(8).writeH(2381).writeD(0).toBytes());
  } else c.session.send(W(8).writeH(2381).writeD(0x80000000).toBytes());
}

// ---- 1091 gift coupon / voucher -----------------------------------------------------------------------------------------
export async function handleGiftCoupon(c: GameClient, r: PacketReader): Promise<void> {
  const token = r.readS(r.readC()), type = r.readC() === 1 ? "VOUCHER" : "COUPON";
  const p = c.player;
  if (!p) return;
  let err = 0;
  const tk = st.tickets.find((t) => t.token === token && t.type === type);
  if (!tk) err = 0x80000000;
  else {
    const n = Number((await pool.query(`SELECT COUNT(used_count) AS n FROM base_redeem_history WHERE used_token = $1`, [tk.token])).rows[0].n);
    if (n >= tk.ticketCount) return c.session.send(W(8).writeH(1092).writeH(0).writeD(0x80000000).toBytes());
    const row = (await pool.query(`SELECT object_id, used_count FROM base_redeem_history WHERE used_token=$1 AND owner_id=$2`, [tk.token, String(p.playerId)])).rows[0];
    const used = row ? Number(row.used_count) : 0;
    if (used < tk.playerRation) {
      const hist = async (k: number) => {
        if (k === 0) return false;
        if (row && Number(row.object_id) !== 0) await pool.query(`UPDATE base_redeem_history SET used_count=$1 WHERE owner_id=$2 AND used_token=$3`, [k, String(p.playerId), tk.token]);
        else await pool.query(`INSERT INTO base_redeem_history(owner_id, used_token, used_count) VALUES($1, $2, $3)`, [String(p.playerId), tk.token, k]);
        return true;
      };
      if (tk.type === "COUPON") {
        const goods = tk.rewards.map(getGood).filter((g): g is GoodsItem => !!g);
        if (goods.length > 0 && (await hist(used + 1))) {
          for (const g of goods) {
            if (Math.trunc(g.item.id / 100000) === 6 && !p.character.getCharacter(g.item.id)) await createCharacterGame(c, p, g.item);
            else { const m = g.item.clone(); await pu.tryCreateItem(m, p); c.session.send(gp.inventoryGetInfoAck(0, p, [m])); }
          }
        }
      } else if ((tk.gold || tk.cash || tk.tags) && (await hist(used + 1))) {
        await dao.addMoney(p, tk.gold, tk.cash, tk.tags); // credit by delta, the balance read back
        c.session.send(pointCashAck(0, p));
      }
    } else err = 0x80000000;
  }
  c.session.send(W(8).writeH(1092).writeH(0).writeD(err).toBytes());
  log(`1091 ${type} "${token}" by ${p.nickname}: 0x${(err >>> 0).toString(16)}`);
}
