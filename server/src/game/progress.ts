// Mission progress/awards and season pass (Server.Game AllUtils MISSION SYSTEM + SEASON PASS AND BATTLE PASS regions):
// CompleteMission (2359 QUEST_CHANGE on DEATH_REQ kills, the victim's DEATH, WIN/DEFEAT at the end), GenerateMissionAwards
// (2361 + 3334), CalculateSeasonExpPoints (8456), UpdateSeasonPass (8451 + 8450, 8453 rewards), the premium pass /
// level-skip purchases (8453/8454 REQ -> 8455, season goods in GOODS_BUY -> 8455/8458) and GrantRankRewards.
import { PacketWriter } from "../../../src/net/packet.ts";
import { pool } from "../db.ts";
import type { Account } from "../shared/account.ts";
import * as dao from "../shared/dao.ts";
import { data, activeSeason, bpLevelInfo, getMissionCards, getMissionCardAward, getMissionAward, getMissionItems, type BattlePassCard, type MissionCardModel } from "../shared/data.ts";
import { getIdStatics, ItemEquipType, ItemCategory, type ItemsModel } from "../shared/items.ts";
import { nowNum } from "../shared/time.ts";
import { getGood, getGoodByItemId, type GoodsItem } from "../shared/shop.ts";
import { tryCreateItem, removeBonuses, checkEquipedItems, equipmentColumns } from "../shared/playerUtils.ts";
import { seasonChangeAck, seasonChallengeInfoAck } from "../auth/metaPackets.ts";
import { inventoryGetInfoAck, changeInventoryAck } from "./packets.ts";
import { badgesPacket, createCharacterGame } from "./profileHandlers.ts";
import type { RoomModel, SlotModel } from "./roomModel.ts";
import type { FragInfo } from "./roomPackets.ts";
import type { GameClient } from "./gameServer.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} [progress-ts] ${m}`);
const W = (n = 64) => new PacketWriter(n);
const send = (a: Account | null | undefined, b: Uint8Array) => (a?.connection as GameClient | null)?.session.send(b);
const pct = (t: number, p: number) => Math.trunc((t * p) / 100);

/** Plugin.Core/Enums/MissionType.cs (the values used here). */
export const MT = {
  NA: 0, C4_PLANT: 1, C4_DEFUSE: 2, WIN: 13, DEFEAT: 14, KILL: 15, DEATH: 16, HEADSHOT: 27, DOUBLE_KILL: 28, PIERCING: 29, TRIPLE_KILL: 30,
  MASS_KILL: 31, KILL_WEAPONCLASS: 40, DOUBLE_KILL_WEAPONCLASS: 41, TRIPLE_KILL_WEAPONCLASS: 42, CHAINKILLER: 44, CHAINSLUGGER: 45,
  CHAINSTOPPER: 46, CHAINHEADSHOT: 47, DEATHBLOW: 49, KILL_MAN: 55,
} as const;
const KM = { Piercing: 1, MassKill: 2, ChainStopper: 4, Headshot: 8, ChainHeadshot: 16, ChainSlugger: 32 };

/** ConvertDualWeaponType (ClassType: DualHandGun 14 -> HandGun 2, DualKnife 15 / Knuckle 23 -> Knife 1, DualSMG 18 -> SMG 4, DualShotgun 35 -> Shotgun 6). */
const baseClass = (t: number) => (t === 14 ? 2 : t === 15 || t === 23 ? 1 : t === 18 ? 4 : t === 35 ? 6 : t);

/** Item delivery shared by every reward path: CreateCharacter for a new class-6 item, else 3334 (TryCreateItem). */
export async function grantItem(p: Account, item: ItemsModel): Promise<void> {
  const c = p.connection as GameClient | null;
  if (getIdStatics(item.id, 1) === 6 && !p.character.getCharacter(item.id)) { if (c) await createCharacterGame(c, p, item); return; }
  const m = item.clone();
  await tryCreateItem(m, p);
  send(p, inventoryGetInfoAck(0, p, [m]));
}

// ---- missions ----------------------------------------------------------------------------------------------------------

/** PROTOCOL_BASE_QUEST_CHANGE_ACK (2359): C MissionBasicId (+240 when complete), C progress. */
const questChangeAck = (progress: number, c: MissionCardModel) =>
  W(8).writeH(2359).writeC((c.missionBasicId + (c.missionLimit === progress ? 240 : 0)) & 0xff).writeC(progress & 0xff).toBytes();

/** PROTOCOL_BASE_QUEST_ACTIVE_IDX_CHANGE_ACK (2361). */
export function questActiveIdxChangeAck(flag: number, type: number, p: Account): Uint8Array {
  const w = W(40).writeH(2361).writeD(flag >>> 0).writeC(type);
  if ((flag & 1) === 1) w.writeD(p.exp).writeD(0).writeD(p.gold).writeD(p.ribbon).writeD(p.ensign).writeD(p.medal).writeD(p.masterMedal);
  return w.toBytes();
}

function updateMissionProgress(p: Account, c: MissionCardModel, list: Uint8Array, progress: number): void {
  const i = c.arrayIdx;
  if (list[i] + 1 > c.missionLimit) return;
  send(p, questChangeAck(list[i], c));
  list[i] = (list[i] + progress) & 0xff;
  if (list[i] > c.missionLimit) list[i] = c.missionLimit;
  send(p, questChangeAck(list[i], c));
}

const weaponOk = (c: MissionCardModel, t: number, bt: number, id: number) =>
  (c.weaponReqId !== 0 && c.weaponReqId !== id) || (c.weaponReq !== 0 && c.weaponReq !== t && c.weaponReq !== bt) ? 0 : 1;

/** AllUtils.CompleteMission(room, slot, kills, autoComplete, moreInfo) (DEATH_REQ). */
export function completeMissionKills(r: RoomModel, s: SlotModel, k: FragInfo, auto: number, moreInfo: number): void {
  try {
    const p = r.svc.getAccount(s.playerId), m = s.missions;
    if (!p || !m) return;
    const setId = m.current.cardSetId;
    if (setId <= 0 || m.selectedCard) return;
    const cards = getMissionCards(setId, m.current.currentCard);
    if (!cards.length) return;
    let flags = 0;
    for (const f of k.frags) flags |= f.killFlag;
    const list = m.current.progress;
    const wt = getIdStatics(k.weapon, 2), bwt = baseClass(wt), wid = getIdStatics(k.weapon, 3);
    const swt = moreInfo > 0 ? getIdStatics(k.weapon, 2) : 0, sbwt = moreInfo > 0 ? baseClass(swt) : 0, swid = moreInfo > 0 ? getIdStatics(moreInfo, 3) : 0;
    for (const c of cards) {
      let progress = 0;
      if (c.mapId === 0 || c.mapId === r.mapId) {
        if (k.frags.length > 0) progress = killProgress(c, s, k, flags, wt, bwt, wid, r);
        else if (c.missionType === MT.DEATHBLOW && auto === MT.DEATHBLOW) progress = weaponOk(c, swt, sbwt, swid);
        else if (c.missionType === auto) progress = 1;
      }
      if (progress !== 0) updateMissionProgress(p, c, list, progress);
    }
  } catch (e) { log(`CompleteMission1: ${e}`); }
}

/** AllUtils.CompleteMission(room, slot, autoComplete, moreInfo). */
export function completeMission(r: RoomModel, s: SlotModel, auto: number, moreInfo: number): void {
  try {
    const p = r.svc.getAccount(s.playerId);
    if (p) processMissionCompletion(r, p, s, auto, moreInfo);
  } catch (e) { log(`CompleteMission2: ${e}`); }
}

function processMissionCompletion(r: RoomModel, p: Account, s: SlotModel, auto: number, moreInfo: number): void {
  const m = s.missions;
  if (!m) return;
  const setId = m.current.cardSetId;
  if (setId <= 0 || m.selectedCard) return;
  const cards = getMissionCards(setId, m.current.currentCard);
  if (!cards.length) return;
  const list = m.current.progress;
  const wt = moreInfo > 0 ? getIdStatics(moreInfo, 2) : 0, bwt = moreInfo > 0 ? baseClass(wt) : 0, wid = moreInfo > 0 ? getIdStatics(moreInfo, 3) : 0;
  for (const c of cards) {
    let progress = 0;
    if (c.mapId === 0 || c.mapId === r.mapId) {
      if (c.missionType !== MT.DEATHBLOW || auto !== MT.DEATHBLOW) { if (c.missionType === auto) progress = 1; }
      else progress = weaponOk(c, wt, bwt, wid);
    }
    if (progress !== 0) updateMissionProgress(p, c, list, progress);
  }
}

function killProgress(c: MissionCardModel, s: SlotModel, k: FragInfo, flags: number, wt: number, bwt: number, wid: number, r: RoomModel): number {
  const t = c.missionType, has = (f: number) => (flags & f) === f;
  if (t === MT.KILL || (t === MT.CHAINSTOPPER && has(KM.ChainStopper)) || (t === MT.CHAINSLUGGER && has(KM.ChainSlugger)) || (t === MT.CHAINKILLER && s.killsOnLife >= 4)
    || (t === MT.TRIPLE_KILL && s.killsOnLife === 3) || (t === MT.DOUBLE_KILL && s.killsOnLife === 2) || (t === MT.HEADSHOT && (has(KM.Headshot) || has(KM.ChainHeadshot)))
    || (t === MT.CHAINHEADSHOT && has(KM.ChainHeadshot)) || (t === MT.PIERCING && has(KM.Piercing)) || (t === MT.MASS_KILL && has(KM.MassKill))
    || (t === MT.KILL_MAN && r.isDinoMode() && ((s.team === 1 && r.rounds === 2) || (s.team === 0 && r.rounds === 1)))) {
    let n = 0;
    if ((c.weaponReqId === 0 || c.weaponReqId === wid) && (c.weaponReq === 0 || c.weaponReq === wt || c.weaponReq === bwt)) {
      for (const f of k.frags) if (f.victim % 2 !== k.killerIdx % 2) n++;
    }
    return n;
  }
  if (t === MT.KILL_WEAPONCLASS || (t === MT.DOUBLE_KILL_WEAPONCLASS && s.killsOnLife === 2) || (t === MT.TRIPLE_KILL_WEAPONCLASS && s.killsOnLife === 3)) {
    let n = 0;
    for (const f of k.frags) if (f.victim % 2 !== k.killerIdx % 2 && (c.weaponReq === 0 || c.weaponReq === f.weaponClass || c.weaponReq === baseClass(f.weaponClass))) n++;
    return n;
  }
  return 0;
}

/** End of a played match (RoomModel.CalculateBattleResults): WIN/DEFEAT on the slot's clone, the clone replaces the live cards
 * (C# Player.Mission = slot.Missions), awards, then the active slot's progress is saved (UpdatePlayerMissionSlotProgress).
 * A match that never reaches here (abort / leave) drops the clone. */
export function finishMissions(r: RoomModel, p: Account, s: SlotModel, winner: number, q: [string[], unknown[]]): void {
  if (s.missions) {
    endMatchMission(r, p, s, winner);
    p.mission = s.missions;
  }
  const m = p.mission, slot = m.actualMission;
  generateMissionAwards(p, q);
  const t = m.at(slot); // a finished set empties the slot (its row is deleted by the awards tail)
  if (s.missions && t.cardSetId > 0) void dao.updatePlayerMissionSlotProgress(p.playerId, slot, t.progress, t.currentCard, t.cardSetId);
}

/** AllUtils.EndMatchMission: WIN / DEFEAT (nothing on a draw). */
export function endMatchMission(r: RoomModel, p: Account, s: SlotModel, winner: number): void {
  if (winner === 2) return;
  processMissionCompletion(r, p, s, s.team === winner ? MT.WIN : MT.DEFEAT, 0);
}

/** AllUtils.GenerateMissionAwards: a finished card (4/4) -> 2361(1,1); the whole set (40) -> 2361(273,4) + items + slot reset. */
export function generateMissionAwards(p: Account, q: [string[], unknown[]]): void {
  try {
    const m = p.mission, slot = m.actualMission, setId = m.current.cardSetId, card = m.current.currentCard;
    if (setId <= 0 || m.selectedCard) return;
    let done = 0, cardDone = 0;
    const list = m.current.progress;
    for (const c of getMissionCards(setId, -1)) if (list[c.arrayIdx] >= c.missionLimit) { done++; if (c.cardBasicId === card) cardDone++; }
    const r0 = [p.ribbon, p.ensign, p.medal, p.masterMedal];
    const push = () => {
      if (p.ribbon !== r0[0]) { q[0].push("ribbon"); q[1].push(p.ribbon); }
      if (p.ensign !== r0[1]) { q[0].push("ensign"); q[1].push(p.ensign); }
      if (p.medal !== r0[2]) { q[0].push("medal"); q[1].push(p.medal); }
      // [RECRIADO] the web Perfil phase reads its badges from 2363 only (the C# client takes them from the 2361 counters)
      if (p.ribbon !== r0[0] || p.ensign !== r0[1] || p.medal !== r0[2] || p.masterMedal !== r0[3]) send(p, badgesPacket(p));
    };
    const cardAward = () => {
      const a = getMissionCardAward(setId, card);
      if (a) { p.ribbon += a.ribbon; p.medal += a.medal; p.ensign += a.ensign; p.gold += a.gold; p.exp += a.exp; }
      return a;
    };
    if (done >= 40) {
      cardAward();
      const ma = getMissionAward(setId);
      if (ma) { p.masterMedal += ma.masterMedal; p.exp += ma.exp; p.gold += ma.gold; }
      const items = getMissionItems(setId).map((i) => i.clone());
      const ack = questActiveIdxChangeAck(273, 4, p);
      push();
      if (p.masterMedal !== r0[3]) { q[0].push("master_medal"); q[1].push(p.masterMedal); }
      const s = m.at(slot);
      s.cardSetId = 0; s.currentCard = 0; s.progress = new Uint8Array(s.progress.length);
      m.actualMission = m.firstOwnedSlot();
      const lastSlot = slot === 3 && !!p.event;
      if (lastSlot) p.event.lastQuestFinish = 1;
      // the in-memory credit above stays synchronous (the caller writes accounts right after); the DB/packet tail follows in C# order
      void (async () => {
        if (items.length) { for (const i of items) await tryCreateItem(i, p); send(p, inventoryGetInfoAck(0, p, items)); }
        send(p, ack);
        await pool.query(`DELETE FROM player_mission_slots WHERE owner_id=$1 AND slot=$2`, [String(p.playerId), slot]).catch(() => {});
        await dao.update1("player_missions", "current_mission", m.actualMission, "owner_id", p.playerId);
        if (lastSlot) await dao.update1("player_events", "last_quest_finish", 1, "owner_id", p.playerId);
      })().catch((e) => log(`GenerateMissionAwards tail: ${e}`));
    } else {
      if (cardDone !== 4 || m.selectedCard) return;
      if (cardAward()) push();
      m.selectedCard = true;
      send(p, questActiveIdxChangeAck(1, 1, p));
    }
  } catch (e) { log(`AllUtils.GenerateMissionAwards: ${e}`); }
}

// ---- battle-used items -------------------------------------------------------------------------------------------------

/** AllUtils.DiscountPlayerItems(slot, player) (Game, end of match): Durable items used in the battle lose one count, expired
 * Temporary coupons and 0-count items are removed (1059 each). ProcessExpiredCoupon takes its two "changed" flags by value in
 * C#, so the coupon_effect write and the INV_ITEM_DATA push never happen there (kept). The memory part runs synchronously
 * (the slot is reset right after); the DB writes and packets follow. */
export function discountBattleItems(s: SlotModel, p: Account): void {
  try {
    const now = nowNum("yyMMddHHmm"), usages = [...s.itemUsages], specGM = s.specGM;
    const updated: ItemsModel[] = [], del: bigint[] = [], special: number[] = [];
    const b0 = [p.bonus.bonuses, p.bonus.freePass];
    const items = p.inventory.items;
    const dbq: Promise<unknown>[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.equip === ItemEquipType.Durable && usages.includes(it.id) && !specGM) {
        if (it.count <= now && (it.id === 800216 || it.id === 2700013 || it.id === 800169)) dbq.push(dao.deleteDB("player_items", "object_id", [it.objectId], "owner_id", p.playerId));
        it.count = (it.count - 1) >>> 0;
        if (it.count >= 1) { updated.push(it); dbq.push(pool.query(`UPDATE player_items SET count=$1 WHERE object_id=$2 AND owner_id=$3`, [it.count, String(it.objectId), String(p.playerId)]).catch(() => {})); }
        else { del.push(it.objectId); items.splice(i--, 1); }
      } else if (it.count <= now && it.equip === ItemEquipType.Temporary) {
        if (it.category !== ItemCategory.Coupon) continue;
        if (!removeBonuses(p, it.id)) special.push(it.id);
        const flag = data.coupons.get(it.id);
        if (flag !== undefined && flag > 0n && (p.effects & flag) === flag) p.effects -= flag;
        del.push(it.objectId); items.splice(i--, 1);
      } else if (it.count === 0) { del.push(it.objectId); items.splice(i--, 1); }
    }
    if (p.effects < 0n) p.effects = 0n;
    const mask = checkEquipedItems(p.equipment, p.inventory.items, false);
    if (mask > 0) s.equipment = p.equipment;
    void (async () => {
      await Promise.all(dbq);
      for (const id of special) {
        if (id === 1600014) { await dao.update1("player_bonus", "crosshair_color", 4, "owner_id", p.playerId); p.bonus.crosshairColor = 4; }
        else if (id === 1600006) { await dao.update1("accounts", "nick_color", 0, "player_id", p.playerId); p.nickColor = 0; }
        else if (id === 1600009) { await dao.update1("player_bonus", "fake_rank", 255, "owner_id", p.playerId); p.bonus.fakeRank = 255; }
        else if (id === 1600010) {
          await dao.update1("player_bonus", "fake_nick", "", "owner_id", p.playerId);
          await dao.update1("accounts", "nickname", p.bonus.fakeNick, "player_id", p.playerId);
          p.nickname = p.bonus.fakeNick; p.bonus.fakeNick = "";
        } else if (id === 1600187) { await dao.update1("player_bonus", "muzzle_color", 0, "owner_id", p.playerId); p.bonus.muzzleColor = 0; }
        else if (id === 1600205) { await dao.update1("player_bonus", "nick_border_color", 0, "owner_id", p.playerId); p.bonus.nickBorderColor = 0; }
        // the room nick/rank/colour pushes (3690-family ACKs) of ProcessSpecialCouponExpiration are not ported
      }
      if (del.length) {
        for (const oid of del) send(p, W(12).writeH(1059).writeD(1).writeD(Number(BigInt.asUintN(32, oid))).toBytes()); // GetItem after the removal finds nothing (C#)
        await dao.deleteDB("player_items", "object_id", del, "owner_id", p.playerId);
      }
      if (p.bonus.bonuses !== b0[0] || p.bonus.freePass !== b0[1]) await dao.updatePlayerBonus(p.playerId, p.bonus.bonuses, p.bonus.freePass);
      if (updated.length) send(p, inventoryGetInfoAck(1, p, updated));
      if (mask > 0) {
        const [cols, vals] = equipmentColumns(p.equipment, mask);
        await dao.updateDB("player_equipments", "owner_id", p.playerId, cols, vals);
        send(p, changeInventoryAck(p));
      }
    })().catch((e) => log(`DiscountPlayerItems: ${e}`));
  } catch (e) { log(`DiscountPlayerItems: ${e}`); }
}

// ---- rank rewards ------------------------------------------------------------------------------------------------------

let rankRewards = new Map<number, number[]>();
export async function loadProgressData(): Promise<void> {
  rankRewards = new Map();
  for (const x of (await pool.query(`SELECT rank_id, good_id FROM system_player_rank_rewards ORDER BY rank_id ASC, ordinal ASC`).catch(() => ({ rows: [] as Record<string, unknown>[] }))).rows) {
    const k = Number(x.rank_id);
    if (!rankRewards.has(k)) rankRewards.set(k, []);
    rankRewards.get(k)!.push(Number(x.good_id));
  }
}

/** AllUtils.GrantRankRewards(player, rankTier): PlayerRankXML rewards are item ids (ShopManager.GetItemId). */
export async function grantRankRewards(p: Account, rank: number): Promise<number> {
  let n = 0;
  for (const itemId of rankRewards.get(rank) ?? []) {
    const g = getGoodByItemId(itemId);
    if (!g) continue;
    await grantItem(p, g.item);
    n++;
  }
  return n;
}

// ---- season pass -------------------------------------------------------------------------------------------------------

export const SEASON_ERR = { NOT_GOING: 0x80002734 | 0, ALREADY: 0x80002735 | 0, NO_MONEY: 0x80002737 | 0, NO_GOODS: 0x80002738 | 0, TRANS: 0x80002739 | 0, EXCEED: 0x80002732 | 0 };
const cards = (): BattlePassCard[] => data.bpCards;
const ordered = () => [...cards()].sort((a, b) => a.number - b.number);
const sid = (s: { seasonId: string } | null) => { const n = s ? Number.parseInt(s.seasonId, 10) : NaN; return Number.isFinite(n) ? n : null; };

/** BattlePass.GetCompletedLevel. */
export function completedLevel(exp: number, list: BattlePassCard[]): number {
  if (exp <= 0 || !list.length) return 0;
  let last = 0;
  for (const c of [...list].sort((a, b) => a.number - b.number)) { if (exp >= c.requiredExp) last = c.number; else break; }
  return last;
}

/** AllUtils.BuildSeasonUserInfo (21 bytes). */
export function seasonUserInfo(p: Account): Uint8Array {
  const u = new Uint8Array(21), v = new DataView(u.buffer);
  let id = sid(data.activeSeason) ?? 1;
  if (id === 0) id = 1;
  v.setInt32(0, id, true);
  u[4] = bpLevelInfo(p.battlepass.earnedPoints).currentLevel & 0xff;
  v.setInt32(5, p.battlepass.earnedPoints, true);
  u[9] = Math.max(0, Math.min(255, p.battlepass.battlepassNormalLevel));
  u[10] = Math.max(0, Math.min(255, p.battlepass.battlepassPremiumLevel));
  u[11] = p.battlepass.havePremium ? 1 : 0;
  return u;
}
/** 8455 BUY_SEASON_PASS_ACK / 8458 BUY_SEASON_LEVEL_UP_ACK / 8456 PLUS_SEASON_EXP_ACK / 8453 SEND_REWARD_ACK. */
export const buySeasonPassAck = (err: number, p: Account) => { const w = W(40).writeH(8455).writeH(0).writeD(err >>> 0); if (err < 0) return w.toBytes(); return w.writeB(seasonUserInfo(p)).writeD(0).toBytes(); };
export const buySeasonLevelUpAck = (err: number, p: Account) => { const w = W(40).writeH(8458).writeH(0).writeD(err >>> 0); if (err < 0) return w.toBytes(); return w.writeD(0).writeB(seasonUserInfo(p)).writeD(0).toBytes(); };
const plusSeasonExpAck = (p: Account) => W(40).writeH(8456).writeH(0).writeC(0).writeB(seasonUserInfo(p)).writeD(0).toBytes();
const sendRewardAck = (n: number, a: number, b: number) => W(24).writeH(8453).writeH(0).writeD(0).writeC(2).writeD(a).writeD(b).writeD(n).writeC(1).writeC(1).writeC(1).toBytes();

/** AllUtils.BattlepassCardReward. */
export async function battlepassCardReward(p: Account, normal: number, a: number, b: number): Promise<void> {
  for (const id of [normal, a, b]) {
    if (id === 0) continue;
    const g = getGood(id);
    if (g) await grantItem(p, g.item);
  }
  send(p, sendRewardAck(normal, a, b));
}

/** AllUtils.CalculateSeasonExpPoints (after the exp/gold credit of CalculateBattleResults). */
export async function calculateSeasonExpPoints(p: Account, s: SlotModel): Promise<void> {
  const pass = p.battlepass;
  if (!pass) return;
  const season = activeSeason();
  if (!season) return;
  const bn = p.bonus.bonuses;
  let bsp = 0;
  if (bn & 512) bsp += 20; if (bn & 1024) bsp += 30; if (bn & 2048) bsp += 50; if (bn & 4096) bsp += 100;
  s.bonusSeasonPoint += bsp;
  if (sid(season) === null || pass.battlepassId !== sid(season)) return;
  if (pass.battlepassNormalLevel >= cards().length) { p.updateSeasonpass = true; return; }
  s.seasonPoint += pct(s.exp, 15);
  let gain = s.seasonPoint + pct(s.seasonPoint, 15);
  const d = new Date(), today = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const baseDaily = pass.lastRecord !== today ? 0 : pass.dailyPoints;
  if (season.maxDailyPoints > 0) gain = Math.min(gain, Math.max(0, season.maxDailyPoints - baseDaily));
  if (gain <= 0) { p.updateSeasonpass = true; return; }
  const next = pass.earnedPoints + gain, nextDaily = baseDaily + gain;
  if (!(await dao.updateDB("player_battlepass", "owner_id", p.playerId, ["earned_points", "points", "last_record"], [next, nextDaily, today]))) return;
  pass.earnedPoints = next; pass.dailyPoints = nextDaily; pass.lastRecord = today;
  p.updateSeasonpass = true;
  send(p, plusSeasonExpAck(p));
}

/** AllUtils.UpdateSeasonPass: grants every newly completed level, then 8451 + 8450. */
export async function updateSeasonPass(p: Account): Promise<void> {
  if (!data.activeSeason) return;
  const bp = p.battlepass, list = cards();
  if (!list.length) { sendSeasonState(p); return; }
  const n0 = bp.battlepassNormalLevel, prem0 = bp.battlepassPremiumLevel;
  const done = completedLevel(bp.earnedPoints, list);
  const jobs: Promise<void>[] = [];
  if (done > n0) {
    for (let lv = n0; lv < done && lv < list.length; lv++) {
      const c = list[lv];
      if (!bp.havePremium) jobs.push(battlepassCardReward(p, c.normalCard, 0, 0));
      bp.battlepassNormalLevel++;
      await dao.update1("player_battlepass", "battlepass_normal_levels", bp.battlepassNormalLevel, "owner_id", p.playerId);
      if (bp.havePremium && prem0 <= lv) {
        jobs.push(battlepassCardReward(p, c.normalCard, c.premiumCardA, c.premiumCardB));
        bp.battlepassPremiumLevel++;
        await dao.update1("player_battlepass", "battlepass_premium_levels", bp.battlepassPremiumLevel, "owner_id", p.playerId);
      }
    }
  }
  sendSeasonState(p);
  await Promise.all(jobs); // C# Task.Run: the rewards land beside the state push
}
const sendSeasonState = (p: Account) => { send(p, seasonChangeAck()); send(p, seasonChallengeInfoAck(p)); };

/** AllUtils.ProcessBattlepassPremiumBuy. */
async function premiumBuy(p: Account): Promise<boolean> {
  try {
    const bp = p.battlepass, list = ordered();
    if (!bp || !activeSeason() || !list.length) { log("ProcessBattlepassPremiumBuy: season/cards unavailable"); return false; }
    const old = bp.battlepassPremiumLevel, target = Math.max(old, Math.min(bp.battlepassNormalLevel, list.length));
    if (!(await dao.updateDB("player_battlepass", "owner_id", p.playerId, ["battlepass_premium_levels", "battlepass_premium"], [target, true]))) return false;
    bp.havePremium = true;
    for (let lv = old; lv < target; lv++) await battlepassCardReward(p, 0, list[lv].premiumCardA, list[lv].premiumCardB);
    bp.battlepassPremiumLevel = target;
    return true;
  } catch (e) { log(`ProcessBattlepassPremiumBuy: ${e}`); return false; }
}

/** AllUtils.ProcessBattlepassLevelBuy. */
async function levelBuy(p: Account, target: number): Promise<boolean> {
  try {
    const season = activeSeason(), list = ordered(), bp = p.battlepass;
    if (!bp || !season || !list.length || target <= 0) return false;
    target = Math.min(target, list.length);
    const claimed = bp.battlepassNormalLevel;
    if (target <= Math.max(claimed, completedLevel(bp.earnedPoints, list))) return false;
    const newId = sid(season) ?? bp.battlepassId, earned = Math.max(bp.earnedPoints, list[target - 1].requiredExp);
    const oldPrem = bp.battlepassPremiumLevel, newPrem = bp.havePremium && oldPrem < target ? target : oldPrem;
    if (!(await dao.updateDB("player_battlepass", "owner_id", p.playerId, ["battlepass_id", "earned_points", "battlepass_normal_levels", "battlepass_premium_levels"], [newId, earned, target, newPrem]))) return false;
    for (let lv = claimed; lv < target; lv++) if (list[lv].normalCard > 0) await battlepassCardReward(p, list[lv].normalCard, 0, 0);
    if (bp.havePremium) for (let lv = oldPrem; lv < target; lv++) await battlepassCardReward(p, 0, list[lv].premiumCardA, list[lv].premiumCardB);
    bp.battlepassId = newId; bp.earnedPoints = earned; bp.battlepassNormalLevel = target; bp.battlepassPremiumLevel = newPrem;
    return true;
  } catch (e) { log(`ProcessBattlepassLevelBuy: ${e}`); return false; }
}

const isPass = (id: number) => Math.trunc(id / 1000) === 3600;
const isSkip = (id: number) => Math.trunc(id / 1000) === 3602;
export const isSeasonShopGood = (g: GoodsItem) => !!g.item && (isPass(g.item.id) || isSkip(g.item.id));

/** AllUtils.PreflightSeasonGoods: false + a SEASON_ERR_* before any charge. */
export function preflightSeasonGoods(p: Account, goods: GoodsItem[]): { ok: boolean; err: number } {
  if (goods.filter(isSeasonShopGood).length > 1) return { ok: false, err: SEASON_ERR.TRANS };
  for (const g of goods) {
    const id = g.item.id, season = activeSeason();
    if (isPass(id)) {
      if (!p.battlepass || !season || season.seasonEnabled !== 1 || !season.enabledForPremium) return { ok: false, err: SEASON_ERR.NOT_GOING };
      if (p.battlepass.havePremium) return { ok: false, err: SEASON_ERR.ALREADY };
    } else if (isSkip(id)) {
      const list = ordered();
      if (!p.battlepass || !season || !list.length) return { ok: false, err: SEASON_ERR.NOT_GOING };
      const target = Math.min((id % 1000) + 1, list.length);
      if (target <= Math.max(p.battlepass.battlepassNormalLevel, completedLevel(p.battlepass.earnedPoints, list))) return { ok: false, err: SEASON_ERR.EXCEED };
    }
  }
  return { ok: true, err: 0 };
}

/** AllUtils.CommitSeasonGoods: applies the (single) season good; refunds the charge (gold / cash paid, as a credit:) when it
 * fails to persist. 0 none, 1 pass, 2 level skip. */
export async function commitSeasonGoods(p: Account, goods: GoodsItem[], paidGold: number, paidCash: number): Promise<number> {
  let type = 0;
  for (const g of goods) {
    if (!isSeasonShopGood(g)) continue;
    let t = 0;
    if (isPass(g.item.id)) { if (await premiumBuy(p)) { p.updateSeasonpass = false; t = 1; } }
    else if (await levelBuy(p, (g.item.id % 1000) + 1)) t = 2;
    if (t === 0) {
      if (!(await dao.addMoney(p, paidGold, paidCash))) log(`CommitSeasonGoods: refund FAILED to persist for player ${p.playerId}`);
      return 0;
    }
    type = t;
  }
  return type;
}

/** AllUtils.FinalizeSeasonShopPurchase. */
export function finalizeSeasonShopPurchase(p: Account, type: number): void {
  if (type === 0) return;
  send(p, type === 1 ? buySeasonPassAck(0, p) : buySeasonLevelUpAck(0, p));
  send(p, seasonChallengeInfoAck(p));
}

/** PROTOCOL_SEASON_CHALLENGE_BUY_SEASON_PASS_REQ (8453/8454, no body): premium pass for SeasonPrice cash. */
export async function handleBuySeasonPass(c: GameClient): Promise<void> {
  const p = c.player;
  if (!p) return;
  const bp = p.battlepass, s = activeSeason(), ack = (e: number) => c.session.send(buySeasonPassAck(e, p));
  if (!bp || !s || s.seasonEnabled !== 1 || !s.enabledForPremium) return ack(SEASON_ERR.NOT_GOING);
  if (bp.havePremium) return ack(SEASON_ERR.ALREADY);
  const price = /^[+-]?\d+$/.test(s.price.trim()) ? Number(s.price.trim()) : NaN;
  if (!(price > 0)) { log(`Season pass premium has no valid SeasonPrice (SeasonId ${s.seasonId}): '${s.price}'`); return ack(SEASON_ERR.NO_GOODS); }
  if (p.cash < price) return ack(SEASON_ERR.NO_MONEY);
  if (!(await dao.addMoney(p, 0, -price))) return ack(p.cash < price ? SEASON_ERR.NO_MONEY : SEASON_ERR.TRANS);
  if (!(await premiumBuy(p))) {
    if (!(await dao.addMoney(p, 0, price))) log(`BUY_SEASON_PASS_REQ: refund FAILED to persist for player ${p.playerId}`);
    return ack(SEASON_ERR.TRANS);
  }
  p.updateSeasonpass = false;
  ack(0);
}

/** AllUtils.CouponIncreaseBP (ITEM_AUTH class 37): earned points += num*10 + sub*100000. */
export async function couponIncreaseBP(p: Account, couponId: number): Promise<boolean> {
  const bp = p.battlepass;
  if (!bp) return false;
  bp.earnedPoints += getIdStatics(couponId, 3) * 10 + getIdStatics(couponId, 2) * 100000;
  if (!(await dao.update1("player_battlepass", "earned_points", bp.earnedPoints, "owner_id", p.playerId))) return false;
  p.updateSeasonpass = true;
  await updateSeasonPass(p);
  return true;
}
