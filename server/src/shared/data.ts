// Static data both servers load at startup (Server.Host/Program.cs load order), DB first like the C# loaders:
//   TemplatePackXML (system_template_items basic/award, system_pc_cafes + rewards), CouponEffectXML
//   (system_coupon_effects), EventQuestXML / EventLoginXML / EventVisitXML / EventXmasXML (system_event_*),
//   BattlePassManager (system_battlepass_seasons + cards), MissionCardRAW (Data/Missions/*.mqf).
// The C# XML fallbacks only run when the DB tables are empty/unreachable; this port logs that case instead.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.ts";
import { config } from "../config.ts";
import { ItemsModel, ItemEquipType, validateStockId } from "./items.ts";
import { nowNum } from "./time.ts";

const int = (v: unknown) => (v == null ? 0 : Number(v));
const log = (m: string) => console.log(`${new Date().toISOString()} [data] ${m}`);

export const CafeEnum: Record<string, number> = { none: 0, silver: 1, gold: 2, unk: 3 };

/** CouponEffects [Flags] enum (Plugin.Core/Enums/CouponEffects.cs). */
const COUPON_NAMES = ["Defense90", "Ketupat", "Defense20", "HollowPointPlus", "Defense10", "HP5", "JackHollowPoint", "ExtraGrenade",
  "C4SpeedKit", "HollowPoint", "FullMetalJack", "Defense5", "Invincible", "HP10", "QuickChangeReload", "QuickChangeWeapon", "FlashProtect",
  "GetDroppedWeapon", "Ammo40", "Respawn20", "Respawn30", "Respawn50", "Respawn100", null, "Ammo10", "ExtraThrowGrenade", "Unk1", "Unk2",
  "Unk3", "Unk4", "Camoflage50", "Camoflage99", "Unk7", "Unk8", "Unk9", "Unk10", "Unk11", "Unk12", "Unk13", "Unk14", "Unk15", "Unk16",
  "Unk17", "Unk18", "Unk19"];
export const CouponEffects: Record<string, bigint> = { None: 0n };
COUPON_NAMES.forEach((n, i) => { if (n) CouponEffects[n] = 1n << BigInt(i); });

/** ComDiv.ParseEnum<CouponEffects>(text, ignoreCase): "A", "A, B" or a number. */
export function parseCouponEffects(text: string): bigint {
  let v = 0n;
  for (const part of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const k = Object.keys(CouponEffects).find((n) => n.toLowerCase() === part.toLowerCase());
    if (k) v |= CouponEffects[k];
    else if (/^-?\d+$/.test(part)) v |= BigInt(part);
    else throw new Error(`CouponEffects value not found: ${part}`);
  }
  return v;
}

export interface PCCafeModel { type: number; expUp: number; pointUp: number; rewards: ItemsModel[] }
export interface EventQuestModel { beginDate: number; endedDate: number }
export interface EventLoginModel { id: number; beginDate: number; endedDate: number; name: string; period: boolean; priority: boolean; goods: number[] }
export interface VisitBox { reward1: number; reward2: number; isBothReward: boolean; rewardCount: number }
export interface EventVisitModel { id: number; beginDate: number; endedDate: number; title: string; checks: number; boxes: VisitBox[] }
export interface EventXmasModel { beginDate: number; endedDate: number; goodId: number }
export interface BattlePassCard { number: number; requiredExp: number; normalCard: number; premiumCardA: number; premiumCardB: number }
export interface BattlePassSeason {
  seasonId: string; seasonEnabled: number; maxDailyPoints: number; enabledForFree: boolean; enabledForPremium: boolean;
  name: string; startDate: string; endDate: string; price: string; cards: BattlePassCard[];
}
/** MissionCardRAW.Awards (per card) / MissionAwardXML (system_mission_awards, per card set) / MissionCardRAW.Items. */
export interface MissionCardAwards { id: number; card: number; ensign: number; medal: number; ribbon: number; exp: number; gold: number }
export interface MissionAwards { id: number; masterMedal: number; exp: number; gold: number }
/** RandomBoxXML (system_random_boxes + system_random_box_rewards). */
export interface RandomBoxItem { index: number; goodsId: number; percent: number; special: boolean }
export interface RandomBoxModel { itemsCount: number; minPercent: number; maxPercent: number; items: RandomBoxItem[] }
export interface MissionCardModel { missionId: number; cardBasicId: number; missionBasicId: number; arrayIdx: number; flag: number; missionLimit: number; missionType: number; mapId: number; weaponReq: number; weaponReqId: number }

export const data = {
  basics: [] as ItemsModel[],
  awards: [] as ItemsModel[],
  cafes: [] as PCCafeModel[],
  coupons: new Map<number, bigint>(),
  questEvents: [] as EventQuestModel[],
  loginEvents: [] as EventLoginModel[],
  visitEvents: [] as EventVisitModel[],
  xmasEvents: [] as EventXmasModel[],
  seasons: [] as BattlePassSeason[],
  activeSeason: null as BattlePassSeason | null,
  bpCards: [] as BattlePassCard[],
  missionCards: [] as MissionCardModel[],
  missionCardAwards: [] as MissionCardAwards[],
  missionItems: [] as { missionId: number; item: ItemsModel }[],
  missionAwards: [] as MissionAwards[],
  randomBoxes: new Map<number, RandomBoxModel>(),
  /** RandomBoxXML packed records before zlib (the 2501 sender compresses them). */
  randomBoxRaw: null as Uint8Array | null,
  /** BattleRewardXML (system_battle_rewards + _goods): MVP, AssistKing, MultiKill -> percentage + good ids by slot */
  battleRewards: [] as { type: string; percentage: number; rewards: number[] }[],
};

async function templateItems(kind: string, equip: number, stockId: boolean): Promise<ItemsModel[]> {
  const r = await pool.query(`SELECT item_id, name, item_count FROM system_template_items WHERE kind = $1 ORDER BY seq ASC`, [kind]);
  return r.rows.map((x) => {
    const it = new ItemsModel(int(x.item_id));
    it.objectId = stockId ? BigInt(validateStockId(it.id)) : 0n;
    it.name = String(x.name);
    it.count = int(x.item_count) >>> 0;
    it.equip = equip;
    return it;
  });
}

async function loadCafes(): Promise<PCCafeModel[]> {
  const byType = new Map<string, PCCafeModel>();
  const out: PCCafeModel[] = [];
  for (const x of (await pool.query(`SELECT cafe_type, exp_up, point_up FROM system_pc_cafes ORDER BY cafe_type ASC`)).rows) {
    const t = String(x.cafe_type);
    if (byType.has(t)) continue;
    const c: PCCafeModel = { type: CafeEnum[t.toLowerCase()] ?? int(t), expUp: int(x.exp_up), pointUp: int(x.point_up), rewards: [] };
    byType.set(t, c);
    out.push(c);
  }
  if (byType.size > 0) {
    for (const x of (await pool.query(`SELECT cafe_type, item_id, name FROM system_pc_cafe_rewards ORDER BY cafe_type ASC, seq ASC`)).rows) {
      const c = byType.get(String(x.cafe_type));
      if (!c) continue;
      const it = new ItemsModel(int(x.item_id));
      it.objectId = BigInt(validateStockId(it.id));
      it.name = String(x.name);
      it.count = 1;
      it.equip = ItemEquipType.CafePC;
      c.rewards.push(it);
    }
  }
  return out;
}

export async function loadBattlePass(): Promise<void> {
  const byId = new Map<number, BattlePassSeason>();
  data.seasons = [];
  for (const x of (await pool.query(`SELECT season_id, name, description, enabled, enabled_for_free, enabled_for_premium, price, start_date, end_date, max_daily_points FROM system_battlepass_seasons ORDER BY season_id ASC`)).rows) {
    const s: BattlePassSeason = {
      seasonId: String(x.season_id), name: x.name == null ? "" : String(x.name), seasonEnabled: int(x.enabled),
      enabledForFree: !!x.enabled_for_free, enabledForPremium: !!x.enabled_for_premium, startDate: String(x.start_date),
      endDate: String(x.end_date), maxDailyPoints: int(x.max_daily_points), price: x.price == null ? "" : String(x.price), cards: [],
    };
    byId.set(int(x.season_id), s);
    data.seasons.push(s);
  }
  for (const x of (await pool.query(`SELECT season_id, card_number, required_exp, normal_card, premium_card_a, premium_card_b FROM system_battlepass_cards ORDER BY season_id ASC, card_number ASC`)).rows) {
    byId.get(int(x.season_id))?.cards.push({
      number: int(x.card_number), requiredExp: int(x.required_exp), normalCard: int(x.normal_card), premiumCardA: int(x.premium_card_a), premiumCardB: int(x.premium_card_b),
    });
  }
  // BattlePassManager.Load: the active season, else the first one.
  data.activeSeason = activeSeason() ?? data.seasons[0] ?? null;
  data.bpCards = data.activeSeason?.cards ?? [];
}

/** BattlePassLoader.GetActiveSeasons: YYMMDDHHSS (minutes in the "SS" slot) or unix start/end, enabled == 1. */
export function activeSeason(): BattlePassSeason | null {
  const now = Math.floor(Date.now() / 1000);
  const isFmt = (d: string) => d.length === 10 && /^\d+$/.test(d) && (() => {
    const mm = Number(d.slice(2, 4)), dd = Number(d.slice(4, 6)), hh = Number(d.slice(6, 8)), ss = Number(d.slice(8, 10));
    return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && hh <= 23 && ss <= 59;
  })();
  const toUnix = (d: string) => Math.floor(new Date(2000 + Number(d.slice(0, 2)), Number(d.slice(2, 4)) - 1, Number(d.slice(4, 6)), Number(d.slice(6, 8)), Number(d.slice(8, 10)), 0).getTime() / 1000);
  for (const s of data.seasons) {
    if (!s.startDate || !s.endDate) continue;
    let start: number, end: number;
    if (isFmt(s.startDate)) start = toUnix(s.startDate);
    else if (/^\d+$/.test(s.startDate)) start = Number(s.startDate);
    else continue;
    if (isFmt(s.endDate)) end = toUnix(s.endDate);
    else if (/^\d+$/.test(s.endDate)) end = Number(s.endDate);
    else continue;
    if (now >= start && now <= end && s.seasonEnabled === 1) return s;
  }
  return null;
}

/** BattlePass.GetLevelInfo(playerExp, cards) (cards of the first season, as BattlePassLoader.Load returns). */
export function bpLevelInfo(playerExp: number): { currentLevel: number; completedLevel: number } {
  const cards = [...(data.seasons[0]?.cards ?? [])].sort((a, b) => a.number - b.number);
  if (cards.length === 0) return { currentLevel: 1, completedLevel: 0 };
  let completed = 0;
  if (playerExp > 0) for (const c of cards) { if (playerExp >= c.requiredExp) completed = c.number; else break; }
  let current = 1;
  if (playerExp > 0) {
    const last = cards[cards.length - 1];
    if (playerExp >= last.requiredExp) current = last.number;
    else current = cards.find((c) => playerExp < c.requiredExp)?.number ?? 1;
  }
  if (!(current === cards[cards.length - 1].number && playerExp >= cards[cards.length - 1].requiredExp) && !cards.some((c) => c.number === current)) {
    return { currentLevel: 1, completedLevel: 0 };
  }
  return { currentLevel: current, completedLevel: completed };
}

const MISSION_FILES: [string, number][] = [
  ["TutorialCard_Russia", 1], ["Dino_Tutorial", 2], ["Human_Tutorial", 3], ["AssaultCard", 5], ["BackUpCard", 6], ["InfiltrationCard", 7],
  ["SpecialCard", 8], ["DefconCard", 9], ["Commissioned_o", 10], ["Company_o", 11], ["Field_o", 12], ["EventCard", 13], ["Dino_Basic", 14],
  ["Human_Basic", 15], ["Dino_Intensify", 16], ["Human_Intensify", 17],
];

/** MissionCardRAW.LoadBasicCards. Program.cs calls it twice (Type 1 = awards/items, Type 2) and Parse adds the 40 tasks on
 * both calls, so the C# card list holds every task twice: CompleteMission then moves a task +2 per kill / death / win and
 * GenerateMissionAwards (40 = set, 4 = card) fires on 20 tasks / 2 tasks. That is an emulator bug (the 40 / 4 thresholds
 * expect one copy), so the list is loaded once. */
export function loadMissionCards(): MissionCardModel[] {
  const out: MissionCardModel[] = [];
  for (const [name, missionId] of MISSION_FILES) {
    const file = path.join(config.dataDir, "Missions", `${name}.mqf`);
    if (!existsSync(file)) continue;
    const b = readFileSync(file);
    if (b.length === 0) continue;
    let o = 4;
    const questType = b.readInt32LE(o); o += 4 + 16;
    let v1 = 0, v2 = 0;
    for (let i = 0; i < 40; i++) {
      const missionBId = v2++, cardBId = v1;
      if (v2 === 4) { v2 = 0; v1++; }
      o += 2; // ReqType
      const type = b[o++], mapId = b[o++], limit = b[o++], weaponClass = b[o++];
      const weaponId = b.readUInt16LE(o); o += 2;
      out.push({ missionId, cardBasicId: cardBId, missionBasicId: missionBId, arrayIdx: cardBId * 4 + missionBId, flag: 15 << (4 * missionBId), missionLimit: limit, missionType: type, mapId, weaponReq: weaponClass, weaponReqId: weaponId });
      if (questType === 1) o += 24;
    }
    try {
      const per = questType === 2 ? 5 : 1;
      for (let card = 0; card < 10; card++) {
        const gold = b.readInt32LE(o), exp = b.readInt32LE(o + 4), medals = b.readInt32LE(o + 8); o += 12 + per * 16;
        const a: MissionCardAwards = { id: missionId, card, exp: questType === 1 ? exp * 10 : exp, gold, ribbon: 0, ensign: 0, medal: 0 };
        if (medals >= 1 && medals <= 50) a.ribbon++; else if (medals >= 51 && medals <= 100) a.ensign++; else if (medals >= 101 && medals <= 116) a.medal++;
        if (!(a.ensign === 0 && a.medal === 0 && a.ribbon === 0 && a.exp === 0 && a.gold === 0)) data.missionCardAwards.push(a);
      }
      if (questType === 2) {
        o += 12;
        for (let i = 0; i < 5; i++) {
          const unk = b.readInt32LE(o), itemId = b.readInt32LE(o + 8), count = b.readUInt32LE(o + 12); o += 16;
          if (unk > 0) data.missionItems.push({ missionId, item: new ItemsModel(itemId, "Mission Item", ItemEquipType.Durable, count) });
        }
      }
    } catch { /* short file: the award list ends there */ }
  }
  return out;
}

/** ComDiv.GetMissionCardFlags(missionId, progress): 10 u16 flags. The C# GetCards(cards, idx) filters the GLOBAL
 * list by CardBasicId only (not by mission), which is kept. */
export function missionCardFlags(missionId: number, progress: Uint8Array): Uint8Array {
  const out = new Uint8Array(20);
  if (missionId === 0) return out;
  const cards = getMissionCards(missionId, -1);
  if (!cards.length) return out;
  for (let cb = 0; cb < 10; cb++) {
    let num = 0;
    for (const c of cards) if (c.cardBasicId === cb && progress[c.arrayIdx] >= c.missionLimit) num |= c.flag;
    out[cb * 2] = num & 0xff;
    out[cb * 2 + 1] = (num >> 8) & 0xff;
  }
  return out;
}

export async function loadStaticData(): Promise<void> {
  data.basics = await templateItems("basic", ItemEquipType.Permanent, true);
  data.awards = await templateItems("award", ItemEquipType.Durable, false);
  if (data.basics.length === 0) log("WARNING system_template_items(basic) empty: the C# falls back to Data/Temps/Basic.xml (not ported)");
  data.cafes = await loadCafes();
  data.battleRewards = (await pool.query(`SELECT reward_type, slot_count, percentage FROM system_battle_rewards ORDER BY reward_type ASC`)).rows
    .map((x) => ({ type: String(x.reward_type), percentage: int(x.percentage), rewards: new Array<number>(int(x.slot_count)).fill(0) }));
  for (const x of (await pool.query(`SELECT reward_type, slot_index, good_id FROM system_battle_reward_goods ORDER BY reward_type ASC, slot_index ASC`)).rows) {
    const rw = data.battleRewards.find((b) => b.type === String(x.reward_type)), i = int(x.slot_index);
    if (rw && i >= 0 && i < rw.rewards.length) rw.rewards[i] = int(x.good_id);
  }
  if (data.battleRewards.length === 0) log("WARNING system_battle_rewards empty: the C# falls back to Data/BattleRewards.xml (not ported)");
  data.coupons = new Map((await pool.query(`SELECT item_id, effect_flag FROM system_coupon_effects`)).rows.map((x) => [int(x.item_id), parseCouponEffects(String(x.effect_flag))]));
  data.questEvents = (await pool.query(`SELECT begin_date, ended_date FROM system_event_quest ORDER BY id ASC`)).rows.map((x) => ({ beginDate: int(x.begin_date), endedDate: int(x.ended_date) }));
  const logins = (await pool.query(`SELECT id, begin_date, ended_date, name, period, priority FROM system_event_login ORDER BY id ASC`)).rows.map((x): EventLoginModel => ({
    id: int(x.id), beginDate: int(x.begin_date), endedDate: int(x.ended_date), name: String(x.name ?? ""), period: !!x.period, priority: !!x.priority, goods: [],
  }));
  for (const x of (await pool.query(`SELECT event_id, good_id FROM system_event_login_rewards ORDER BY event_id ASC, ordinal ASC`)).rows) logins.find((e) => e.id === int(x.event_id))?.goods.push(int(x.good_id));
  data.loginEvents = logins;
  const visits = (await pool.query(`SELECT id, begin_date, ended_date, title, check_days FROM system_event_visit ORDER BY id ASC`)).rows.map((x): EventVisitModel => ({
    id: int(x.id), beginDate: int(x.begin_date), endedDate: int(x.ended_date), title: String(x.title ?? ""), checks: int(x.check_days),
    boxes: Array.from({ length: 31 }, () => ({ reward1: 0, reward2: 0, isBothReward: false, rewardCount: 0 })),
  }));
  for (const x of (await pool.query(`SELECT event_id, day, good_id_1, good_id_2, is_both FROM system_event_visit_boxes ORDER BY event_id ASC, day ASC`)).rows) {
    const e = visits.find((v) => v.id === int(x.event_id)), day = int(x.day) - 1;
    if (!e || day < 0 || day >= e.boxes.length) continue;
    e.boxes[day].reward1 = int(x.good_id_1);
    e.boxes[day].reward2 = int(x.good_id_2);
    e.boxes[day].isBothReward = !!x.is_both;
  }
  for (const e of visits) for (const b of e.boxes) b.rewardCount = (b.reward1 > 0 ? 1 : 0) + (b.reward2 > 0 ? 1 : 0);
  data.visitEvents = visits;
  data.xmasEvents = (await pool.query(`SELECT begin_date, ended_date, good_id FROM system_event_xmas ORDER BY id ASC`)).rows.map((x) => ({ beginDate: int(x.begin_date), endedDate: int(x.ended_date), goodId: int(x.good_id) }));
  await loadBattlePass();
  data.missionCardAwards = []; data.missionItems = [];
  data.missionCards = loadMissionCards();
  data.missionAwards = (await pool.query(`SELECT id, master_medal, exp, gold FROM system_mission_awards ORDER BY id ASC`)).rows.map((x) => ({ id: int(x.id), masterMedal: int(x.master_medal), exp: int(x.exp), gold: int(x.gold) }));
  await loadRandomBoxes();
  log(`${data.basics.length} basics, ${data.awards.length} awards, ${data.cafes.length} cafes, ${data.coupons.size} coupons, ${data.visitEvents.length} visit events, ${data.seasons.length} seasons (active ${data.activeSeason?.seasonId ?? "-"}), ${data.missionCards.length} mission cards`);
}

/** RandomBoxXML.Load (DB rows + SetTopPercent) and BuildPackedRandomBoxData (24928-byte records, max 500, 100 rewards of 244 bytes). */
export async function loadRandomBoxes(): Promise<void> {
  const boxes = new Map<number, RandomBoxModel>();
  for (const x of (await pool.query(`SELECT box_id, items_count FROM system_random_boxes ORDER BY box_id ASC`)).rows) {
    if (!boxes.has(int(x.box_id))) boxes.set(int(x.box_id), { itemsCount: int(x.items_count), minPercent: 0, maxPercent: 0, items: [] });
  }
  if (boxes.size) {
    for (const x of (await pool.query(`SELECT box_id, idx, good_id, percent, is_special FROM system_random_box_rewards ORDER BY box_id ASC, seq ASC`)).rows) {
      boxes.get(int(x.box_id))?.items.push({ index: int(x.idx), goodsId: int(x.good_id), percent: int(x.percent), special: !!x.is_special });
    }
  } else log("system_random_boxes empty (the C# Data/RBoxes XML fallback is not ported)");
  for (const b of boxes.values()) {
    let lo = 100, hi = 0;
    for (const i of b.items) { if (i.percent < lo) lo = i.percent; if (i.percent > hi) hi = i.percent; }
    b.minPercent = lo; b.maxPercent = hi;
  }
  data.randomBoxes = boxes;
  const list = [...boxes.entries()].sort((a, b) => a[0] - b[0]).slice(0, 500);
  if (!list.length) { data.randomBoxRaw = null; return; }
  const raw = new Uint8Array(list.length * 24928), dv = new DataView(raw.buffer);
  list.forEach(([id, box], i) => {
    const off = i * 24928;
    raw[off] = 3; dv.setInt32(off + 4, id, true);
    const n = Math.min(box.items.length, 100);
    raw[off + 524] = n;
    for (let k = 0; k < n; k++) { const ro = off + k * 244; raw[ro + 529] = 1; dv.setInt32(ro + 532, box.items[k].goodsId, true); }
  });
  data.randomBoxRaw = raw;
}
/** MissionCardRAW.GetCards(missionId, cardBasicId): -1 = every card of the set. */
export const getMissionCards = (missionId: number, cardBasicId: number) =>
  data.missionCards.filter((c) => c.missionId === missionId && ((cardBasicId >= 0 && c.cardBasicId === cardBasicId) || cardBasicId === -1));
export const getMissionCardAward = (mission: number, card: number) => data.missionCardAwards.find((a) => a.id === mission && a.card === card) ?? null;
export const getMissionAward = (id: number) => data.missionAwards.find((a) => a.id === id) ?? null;
export const getMissionItems = (id: number) => data.missionItems.filter((m) => m.missionId === id).map((m) => m.item);

const running = <T extends { beginDate: number; endedDate: number }>(list: T[]): T | null => {
  const now = nowNum("yyMMddHHmm");
  return list.find((e) => e.beginDate <= now && now < e.endedDate) ?? null;
};
export const runningQuestEvent = () => running(data.questEvents);
export const runningLoginEvent = () => running(data.loginEvents);
export const runningVisitEvent = () => running(data.visitEvents);
export const runningXmasEvent = () => running(data.xmasEvents);
export const visitEventById = (id: number) => data.visitEvents.find((e) => e.id === id) ?? null;
export const visitEventEnabled = (e: EventVisitModel) => { const n = nowNum("yyMMddHHmm"); return e.beginDate <= n && n < e.endedDate; };
export const getPCCafe = (type: number) => data.cafes.find((c) => c.type === type) ?? null;
export const getPCCafeRewards = (type: number) => getPCCafe(type)?.rewards ?? [];
