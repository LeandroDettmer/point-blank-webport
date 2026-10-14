// Server.Auth/Data/Utils/AllUtils.cs (the account-meta part the Game AllUtils repeats): LoadPlayerInventory,
// LoadPlayerMissions, ValidatePlayerInventoryStatus, DiscountPlayerItems, CheckGameEvents, ProcessBattlepass,
// CreateCharacter, plus ComDiv.CheckEquipedItems / TryCreateItem.
import { pool } from "../db.ts";
import type { Account } from "./account.ts";
import { AccessLevel, isDefinedAccess } from "./account.ts";
import * as dao from "./dao.ts";
import { data, getPCCafe, getPCCafeRewards, runningQuestEvent, runningLoginEvent, runningVisitEvent, runningXmasEvent, activeSeason } from "./data.ts";
import { ItemsModel, ItemCategory, ItemEquipType, genStockId, getIdStatics } from "./items.ts";
import { PlayerEquipment, type CharacterModel } from "./models.ts";
import { NO_FAKE_RANK } from "./rank.ts";
import { getGood, isRepairable } from "./shop.ts";
import { nowNum, convertDate, fmtDate } from "./time.ts";
import { config, runningPlaytimeEvent } from "../config.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} [player] ${m}`);

/** AllUtils.ValidateAuthLevel. */
export async function validateAuthLevel(p: Account): Promise<void> {
  if (isDefinedAccess(p.access)) return;
  const lvl = p.authLevel();
  if (await dao.update1("accounts", "access_level", lvl, "player_id", p.playerId)) p.access = lvl;
}

export async function loadPlayerInventory(p: Account): Promise<void> {
  p.inventory.items.push(...(await dao.getPlayerInventoryItems(p.playerId)));
}

export async function loadPlayerMissions(p: Account): Promise<void> {
  const m = await dao.getPlayerMissionsDB(p.playerId);
  if (m == null) {
    if (await dao.createPlayerMissionsDB(p.playerId)) return;
    log("There was an error when creating Player Missions!");
  } else p.mission = m;
  // the event set (13) is in-memory only in C#; its row exists here because progress is saved, so hide it once the event ends
  if (!runningQuestEvent()) {
    const s = p.mission.slots.find((x) => x.cardSetId === 13);
    if (s) { s.cardSetId = 0; s.currentCard = 0; s.progress = new Uint8Array(s.progress.length); }
    if (p.mission.current.isEmpty) p.mission.actualMission = p.mission.firstOwnedSlot();
  }
}

/** AllUtils.CreateCharacter: slot = current count, PK from player_characters_seq. */
export async function createCharacter(p: Account, item: ItemsModel): Promise<CharacterModel> {
  const c: CharacterModel = { objectId: item.objectId, id: item.id, name: item.name, slot: nextCharaSlot(p), createDate: nowNum("yyMMddHHmm"), playTime: 0 };
  p.character.characters.push(c);
  if (!(await dao.createPlayerCharacter(c, p.playerId))) log(`There is an error while cheating a character! (ID: ${item.id}`);
  return c;
}

/** AllUtils.StaticMethod1: re-slot the other characters, then delete this one. */
export async function removeCharacter(p: Account, itemId: number): Promise<void> {
  const c1 = p.character.getCharacter(itemId);
  if (!c1) return;
  let slot = 0;
  for (const c2 of p.character.characters) {
    if (c2.slot !== c1.slot) {
      c2.slot = slot;
      await dao.updatePlayerCharacter(slot, c2.objectId, p.playerId);
      slot++;
    }
  }
  if (!(await dao.deletePlayerCharacter(c1.objectId, p.playerId))) return;
  p.character.characters = p.character.characters.filter((c) => c !== c1);
}

/** AllUtils.StaticMethod0: GM or a valid player_vip row. */
async function hasCafeAccess(p: Account): Promise<{ ok: boolean; why: string }> {
  if (p.isGM()) return { ok: true, why: "GM Special Access" };
  const vip = await dao.getPlayerVIP(p.playerId);
  if (!vip) return { ok: false, why: "Database Not Found!" };
  if (vip.expirate >= nowNum("yyMMddHHmm")) {
    const s = cafeName(p.cafePC);
    if (vip.benefit !== s) await dao.update1("player_vip", "last_benefit", s, "owner_id", p.playerId);
    return { ok: true, why: "Valid Access" };
  }
  return { ok: false, why: "The Time Has Expired!" };
}
const cafeName = (t: number) => ["None", "Silver", "Gold", "Unk"][t] ?? String(t);

const updateCouponEffect = (p: Account) => dao.update1("accounts", "coupon_effect", p.effects.toString(), "player_id", p.playerId);

/**
 * PlayerInventory.LoadGeneralBeret (Rank >= 46) + LoadHatForGM: in-memory items, never in player_items.
 * [web] the C# leaves both at ObjectId 0. A GM general then gets two 2319/3334 rows with object 0 and the lobby
 * (PlayerStore keys the inventory by objectId) kept only the hat: the equipped beret was missing from the inventory.
 * They get a stock id (0x40000000 | itemId, ComDiv.GenStockId) like the basics, so every row has its own objectId.
 */
export function rankItems(rank: number, gm: boolean): ItemsModel[] {
  const out: ItemsModel[] = [];
  const add = (id: number, name: string) => { const it = new ItemsModel(id, name, ItemEquipType.Permanent, 1); it.objectId = BigInt(genStockId(id)); out.push(it); };
  if (rank >= 46) add(2700008, "Beret S. General");
  if (gm) add(700160, "MOD Hat");
  return out;
}

/** AllUtils.ValidatePlayerInventoryStatus. */
export async function validatePlayerInventoryStatus(p: Account): Promise<void> {
  p.inventory.items.push(...data.basics); // LoadBasicItems: the SAME template objects (shared references, like C#)
  p.inventory.items.push(...rankItems(p.rank, p.isGM()));
  if (p.nickname) {
    for (const it of [...p.inventory.items]) {
      if (getIdStatics(it.id, 1) === 6 && p.character.getCharacter(it.id) == null) await createCharacter(p, it);
    }
  }
  const access = await hasCafeAccess(p);
  const rewards = getPCCafeRewards(p.cafePC);
  if (access.ok) {
    p.inventory.items.push(...rewards);
    for (const it of rewards) {
      if (getIdStatics(it.id, 1) === 6 && p.character.getCharacter(it.id) == null) await createCharacter(p, it);
      if (getIdStatics(it.id, 1) === 16) {
        const flag = data.coupons.get(it.id);
        if (flag !== undefined && flag > 0n && (p.effects & flag) !== flag) { p.effects |= flag; await updateCouponEffect(p); }
      }
    }
    return;
  }
  for (const it of rewards) {
    if (getIdStatics(it.id, 1) === 6 && p.character.getCharacter(it.id) != null) await removeCharacter(p, it.id);
    if (getIdStatics(it.id, 1) === 16) {
      const flag = data.coupons.get(it.id);
      if (flag !== undefined && flag > 0n && (p.effects & flag) === flag) { p.effects -= flag; await updateCouponEffect(p); }
    }
  }
  if (p.cafePC <= 0 || !(await dao.update1("accounts", "pc_cafe", 0, "player_id", p.playerId))) return;
  p.cafePC = 0;
  if (access.why && (await dao.deleteDB("player_vip", "owner_id", [p.playerId], "owner_id", p.playerId))) log(`VIP for UID: ${p.playerId} Nick: ${p.nickname} Deleted Due To ${access.why}`);
  log(`Player PC Cafe was resetted by default into 'None'; (UID: ${p.playerId} Nick: ${p.nickname})`);
}

/** PlayerBonus.RemoveBonuses(itemId): returns whether Bonuses/FreePass changed. */
export function removeBonuses(p: Account, itemId: number): boolean {
  const b = p.bonus, before = [b.bonuses, b.freePass];
  const clear = (v: number) => { if ((b.bonuses & v) === v) b.bonuses -= v; };
  switch (itemId) {
    case 1600001: clear(1); break;
    case 1600002: clear(2); break;
    case 1600003: clear(4); break;
    case 1600004: clear(32); break;
    case 1600011: case 1600162: if ((b.freePass & 128) === 128) b.freePass -= 128; break;
    case 1600012: clear(256); break;
    case 1600037: clear(8); break;
    case 1600038: clear(128); break;
    case 1600119: clear(64); break;
    case 1600201: clear(512); break;
    case 1600202: clear(1024); break;
    case 1600203: clear(2048); break;
    case 1600204: clear(4096); break;
  }
  return b.bonuses !== before[0] || b.freePass !== before[1];
}

/** ComDiv.CheckEquipedItems(equip, inventory, battleRules): resets unowned slots; returns the dirty mask. */
export function checkEquipedItems(e: PlayerEquipment, inv: ItemsModel[], battleRules: boolean): number {
  const f = new Array<boolean>(21).fill(false);
  if (e.weaponPrimary === 103004) f[1] = true;
  if (battleRules) {
    if (!f[1] && (e.weaponPrimary === 105025 || e.weaponPrimary === 106007)) f[1] = true;
    if (!f[3] && e.weaponMelee === 323001) f[3] = true;
  }
  if (e.partHead === 0) f[8] = true;
  if (e.partFace === 0) f[9] = true;
  if (e.partJacket === 0) f[10] = true;
  if (e.partPocket === 0) f[11] = true;
  if (e.partGlove === 0) f[12] = true;
  if (e.partBelt === 0) f[13] = true;
  if (e.partHolster === 0) f[14] = true;
  if (e.partSkin === 0) f[15] = true;
  if (e.beretItem === 0) f[16] = true;
  if (e.dinoItem === 0) f[17] = true;
  if (e.accessoryId === 0) f[18] = true;
  if (e.sprayId === 0) f[19] = true;
  if (e.nameCardId === 0) f[20] = true;
  for (const it of inv) {
    if (it.count <= 0) continue;
    const id = it.id;
    if (id === e.weaponPrimary) f[1] = true;
    else if (id === e.weaponSecondary) f[2] = true;
    else if (id === e.weaponMelee) f[3] = true;
    else if (id === e.weaponExplosive) f[4] = true;
    else if (id === e.weaponSpecial) f[5] = true;
    else if (id === e.charaRedId) f[6] = true;
    else if (id === e.charaBlueId) f[7] = true;
    else if (id === e.partHead) f[8] = true;
    else if (id === e.partFace) f[9] = true;
    else if (id === e.partJacket) f[10] = true;
    else if (id === e.partPocket) f[11] = true;
    else if (id === e.partGlove) f[12] = true;
    else if (id === e.partBelt) f[13] = true;
    else if (id === e.partHolster) f[14] = true;
    else if (id === e.partSkin) f[15] = true;
    else if (id === e.beretItem) f[16] = true;
    else if (id === e.dinoItem) f[17] = true;
    else if (id === e.accessoryId) f[18] = true;
    else if (id === e.sprayId) f[19] = true;
    else if (id === e.nameCardId) f[20] = true;
    if (f.slice(1).every(Boolean)) break;
  }
  let num = 0;
  if (!f[1] || !f[2] || !f[3] || !f[4] || !f[5]) num += 2;
  if (f.slice(6, 18).some((x) => !x)) num += 1;
  if (!f[18] || !f[19] || !f[20]) num += 3;
  if (!f[1]) e.weaponPrimary = 103004;
  if (!f[2]) e.weaponSecondary = 202022;
  if (!f[3]) e.weaponMelee = 301012;
  if (!f[4]) e.weaponExplosive = 407001;
  if (!f[5]) e.weaponSpecial = 508002;
  if (!f[6]) e.charaRedId = 601001;
  if (!f[7]) e.charaBlueId = 602002;
  if (!f[8]) e.partHead = 0;
  if (!f[9]) e.partFace = 0;
  if (!f[10]) e.partJacket = 0;
  if (!f[11]) e.partPocket = 0;
  if (!f[12]) e.partGlove = 0;
  if (!f[13]) e.partBelt = 0;
  if (!f[14]) e.partHolster = 0;
  if (!f[15]) e.partSkin = 0;
  if (!f[16]) e.beretItem = 0;
  if (!f[17]) e.dinoItem = 1500511;
  if (!f[18]) e.accessoryId = 0;
  if (!f[19]) e.sprayId = 0;
  if (!f[20]) e.nameCardId = 0;
  return num;
}

/** ComDiv.UpdateWeapons/UpdateChars/UpdateItems(Equip, Query) column lists. */
export function equipmentColumns(e: PlayerEquipment, mask: number): [string[], unknown[]] {
  const cols: string[] = [], vals: unknown[] = [];
  const add = (c: string, v: number) => { cols.push(c); vals.push(v); };
  if ((mask & 2) === 2) {
    add("weapon_primary", e.weaponPrimary); add("weapon_secondary", e.weaponSecondary); add("weapon_melee", e.weaponMelee);
    add("weapon_explosive", e.weaponExplosive); add("weapon_special", e.weaponSpecial);
  }
  if ((mask & 1) === 1) {
    add("chara_red_side", e.charaRedId); add("chara_blue_side", e.charaBlueId); add("part_head", e.partHead); add("part_face", e.partFace);
    add("part_jacket", e.partJacket); add("part_pocket", e.partPocket); add("part_glove", e.partGlove); add("part_belt", e.partBelt);
    add("part_holster", e.partHolster); add("part_skin", e.partSkin); add("beret_item_part", e.beretItem); add("dino_item_chara", e.dinoItem);
  }
  if ((mask & 3) === 3) { add("accesory_id", e.accessoryId); add("spray_id", e.sprayId); add("namecard_id", e.nameCardId); }
  return [cols, vals];
}

/** AllUtils.DiscountPlayerItems. */
export async function discountPlayerItems(p: Account): Promise<boolean> {
  try {
    let effectsChanged = false;
    const now = nowNum("yyMMddHHmm");
    const removed: bigint[] = [], removedChars: number[] = [];
    const bonuses = p.bonus ? p.bonus.bonuses : 0, freePass = p.bonus ? p.bonus.freePass : 0;
    const items = p.inventory.items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.count <= now && it.equip === ItemEquipType.Temporary) {
        if (it.category === ItemCategory.Coupon) {
          if (!p.bonus) continue;
          if (!removeBonuses(p, it.id)) {
            if (it.id === 1600014) { await dao.update1("player_bonus", "crosshair_color", 4, "owner_id", p.playerId); p.bonus.crosshairColor = 4; }
            else if (it.id === 1600006) { await dao.update1("accounts", "nick_color", 0, "player_id", p.playerId); p.nickColor = 0; }
            else if (it.id === 1600009) { await dao.update1("player_bonus", "fake_rank", NO_FAKE_RANK, "owner_id", p.playerId); p.bonus.fakeRank = NO_FAKE_RANK; }
            else if (it.id === 1600010) {
              if (p.bonus.fakeNick.length > 0) {
                await dao.update1("player_bonus", "fake_nick", "", "owner_id", p.playerId);
                await dao.update1("accounts", "nickname", p.bonus.fakeNick, "player_id", p.playerId);
                p.nickname = p.bonus.fakeNick;
                p.bonus.fakeNick = "";
              }
            } else if (it.id === 1600187) { await dao.update1("player_bonus", "muzzle_color", 0, "owner_id", p.playerId); p.bonus.muzzleColor = 0; }
            else if (it.id === 1600205) { await dao.update1("player_bonus", "nick_border_color", 0, "owner_id", p.playerId); p.bonus.nickBorderColor = 0; }
          }
          const flag = data.coupons.get(it.id);
          if (flag !== undefined && flag > 0n && (p.effects & flag) === flag) { p.effects -= flag; effectsChanged = true; }
        }
        removed.push(it.objectId);
        if (getIdStatics(it.id, 1) === 6) removedChars.push(it.id);
        items.splice(i--, 1);
      } else if (it.count === 0) {
        removed.push(it.objectId);
        items.splice(i--, 1);
      }
    }
    if (removed.length > 0) {
      // [web] the C# looks the item up after removing it (finds nothing) and leaves an orphan player_characters row: remove the character of an expired character item
      for (const id of removedChars) await removeCharacter(p, id);
      await dao.deleteDB("player_items", "object_id", removed, "owner_id", p.playerId);
    }
    if (p.bonus && (p.bonus.bonuses !== bonuses || p.bonus.freePass !== freePass)) await dao.updatePlayerBonus(p.playerId, p.bonus.bonuses, p.bonus.freePass);
    if (p.effects < 0n) p.effects = 0n;
    if (effectsChanged) await updateCouponEffect(p);
    const mask = checkEquipedItems(p.equipment, p.inventory.items, false);
    if (mask > 0) {
      const [cols, vals] = equipmentColumns(p.equipment, mask);
      await dao.updateDB("player_equipments", "owner_id", p.playerId, cols, vals);
    }
    return true;
  } catch (e) {
    log(`DiscountPlayerItems: ${(e as Error).stack}`);
    return false;
  }
}

/** ComDiv.TryCreateItem (merge into an owned item or INSERT ... RETURNING object_id). */
export async function tryCreateItem(model: ItemsModel, p: Account): Promise<boolean> {
  try {
    const ex = p.inventory.getItem(model.id);
    if (!ex) {
      const r = await pool.query(`INSERT INTO player_items(owner_id, id, name, count, equip) VALUES($1, $2, $3, $4, $5) RETURNING object_id`,
        [String(p.playerId), model.id, model.name, model.count, model.equip]);
      model.objectId = BigInt(r.rows[0].object_id);
      p.inventory.items.push(model);
      return true;
    }
    model.objectId = ex.objectId;
    if (ex.equip === ItemEquipType.Durable) {
      model.count = isRepairable(model.id) ? 100 : (model.count + ex.count) >>> 0;
      await pool.query(`UPDATE player_items SET count=$1 WHERE owner_id=$2 AND id=$3`, [model.count, String(p.playerId), model.id]);
    } else if (ex.equip === ItemEquipType.Temporary) {
      const exact = convertDate(String(ex.count));
      if (model.category === ItemCategory.Coupon) {
        const ts = convertDate(String(model.count)).getTime() - Date.now();
        model.count = Number(fmtDate(new Date(exact.getTime() + ts), "yyMMddHHmm"));
      } else {
        model.count = Number(fmtDate(new Date(exact.getTime() + model.count * 1000), "yyMMddHHmm"));
      }
      model.equip = ItemEquipType.Temporary;
      await pool.query(`UPDATE player_items SET count=$1 WHERE owner_id=$2 AND id=$3`, [model.count, String(p.playerId), model.id]);
    }
    ex.equip = model.equip;
    ex.count = model.count;
    return true;
  } catch (e) {
    log(`TryCreateItem: ${(e as Error).message}`);
    return false;
  }
}

/** AllUtils.CheckGameEvents (Auth). The login gift announce (3079) is returned for the caller to send. */
export async function checkGameEvents(p: Account): Promise<{ loginGiftAnnounce: boolean }> {
  const out = { loginGiftAnnounce: false };
  const n0 = nowNum("yyMMddHHmm"), n1 = nowNum("yyMMdd");
  const ev = p.event;
  if (ev) {
    const q = runningQuestEvent();
    if (q) {
      const lastDate = ev.lastQuestDate, lastFinish = ev.lastQuestFinish;
      if (ev.lastQuestDate < q.beginDate) { ev.lastQuestDate = 0; ev.lastQuestFinish = 0; }
      if (ev.lastQuestFinish === 0) {
        if (!p.mission.ownsCardSet(13)) {
          const slot = p.mission.findFreeSlot();
          if (slot >= 0) p.mission.at(slot).cardSetId = 13;
        }
        if (ev.lastQuestDate === 0) ev.lastQuestDate = n0;
      }
      if (ev.lastQuestDate !== lastDate || ev.lastQuestFinish !== lastFinish)
        await dao.updateDB("player_events", "owner_id", p.playerId, ["last_quest_date", "last_quest_finish"], [ev.lastQuestDate, ev.lastQuestFinish]);
    }
    const lg = runningLoginEvent();
    if (lg) {
      if (ev.lastLoginDate < lg.beginDate) {
        ev.lastLoginDate = 0;
        await dao.update1("player_events", "last_login_date", 0, "owner_id", p.playerId);
      }
      if (Number(fmtDate(convertDate(String(ev.lastLoginDate)), "yyMMdd")) < n1) {
        let delivered = false, failed = false;
        for (const goodId of lg.goods) {
          const good = getGood(goodId);
          if (!good) { log(`[EventLogin] Good ${goodId} is not in the shop; login gift withheld for UID ${p.playerId}.`); failed = true; continue; }
          if (await tryCreateItem(good.item.clone(), p)) delivered = true;
          else { log(`[EventLogin] Failed to grant good ${goodId} to UID ${p.playerId}; login gift withheld.`); failed = true; }
        }
        if (delivered && !failed) {
          ev.lastLoginDate = n0;
          await dao.update1("player_events", "last_login_date", n0, "owner_id", p.playerId);
          out.loginGiftAnnounce = true;
        }
      }
    }
    const v = runningVisitEvent();
    if (v && ev.lastVisitDate < v.beginDate) {
      ev.lastVisitDate = 0; ev.lastVisitCheckDay = 0; ev.lastVisitSeqType = 0; ev.lastVisitRewardDay = 0;
      await dao.updateDB("player_events", "owner_id", p.playerId, ["last_visit_check_day", "last_visit_seq_type", "last_visit_date", "last_visit_reward_day"],
        [ev.lastVisitCheckDay, ev.lastVisitSeqType, ev.lastVisitDate, ev.lastVisitRewardDay]);
    }
    const x = runningXmasEvent();
    if (x && ev.lastXmasDate < x.beginDate) {
      ev.lastXmasDate = 0;
      await dao.update1("player_events", "last_xmas_date", 0, "owner_id", p.playerId);
    }
    const pt = runningPlaytimeEvent();
    if (pt) {
      const today = Number(fmtDate(new Date(), "yyMMdd") + "0000");
      const lastDay = ev.lastPlaytimeDate > 0 ? Number(fmtDate(convertDate(String(ev.lastPlaytimeDate)), "yyMMdd") + "0000") : 0;
      const isNew = ev.lastPlaytimeDate < pt.begin;
      const isDifferent = ev.currentPlaytimeEventId !== pt.id && ev.currentPlaytimeEventId !== 0;
      const reset = () => dao.updateDB("player_events", "owner_id", p.playerId,
        ["last_playtime_date", "last_playtime_value", "last_playtime_finish", "current_playtime_event_id", "playtime_completed_levels"],
        [ev.lastPlaytimeDate, ev.lastPlaytimeValue, ev.lastPlaytimeFinish, ev.currentPlaytimeEventId, ev.playtimeCompletedLevels]);
      if (isNew || isDifferent) {
        ev.lastPlaytimeDate = today; ev.lastPlaytimeFinish = 0; ev.lastPlaytimeValue = 0; ev.currentPlaytimeEventId = pt.id;
        if (isNew) ev.playtimeCompletedLevels = "";
        await reset();
      } else if (lastDay > 0 && lastDay < today) {
        if (pt.period) {
          ev.lastPlaytimeDate = today; ev.lastPlaytimeValue = 0; ev.lastPlaytimeFinish = 0; ev.playtimeCompletedLevels = "";
          await reset();
        }
      } else if (ev.lastPlaytimeDate === 0) {
        ev.lastPlaytimeDate = today; ev.lastPlaytimeFinish = 0; ev.lastPlaytimeValue = 0; ev.currentPlaytimeEventId = pt.id;
        await reset();
      }
    }
  }
  await dao.update1("accounts", "last_login_date", n0, "player_id", p.playerId);
  return out;
}

/** AllUtils.ProcessBattlepass. */
export async function processBattlepass(p: Account): Promise<void> {
  try {
    const s = activeSeason();
    if (!p.battlepass || !s) return;
    const sid = Number.parseInt(s.seasonId, 10);
    if (p.battlepass.battlepassId === sid) return;
    if (p.battlepass.battlepassId !== 0) {
      const b = p.battlepass;
      b.battlepassId = sid; b.havePremium = false; b.battlepassNormalLevel = 0; b.battlepassPremiumLevel = 0; b.earnedPoints = 0; b.dailyPoints = 0;
      b.lastRecord = Number(fmtDate(new Date(), "yyyyMMdd"));
      await dao.updateDB("player_battlepass", "owner_id", p.playerId,
        ["battlepass_id", "battlepass_premium_levels", "battlepass_normal_levels", "battlepass_premium", "earned_points", "points", "last_record"],
        [sid, 0, 0, false, 0, 0, b.lastRecord | 0]);
    } else {
      p.battlepass.battlepassId = sid;
      await dao.updateDB("player_battlepass", "owner_id", p.playerId, ["battlepass_id"], [sid]);
    }
  } catch (e) { log(`ProcessBattlepass: ${e}`); }
}

/** AllUtils.LimitationIndex (the C# RemoveRange(index, Count - num) arithmetic kept). */
export function limitationIndex(p: Account, items: ItemsModel[]): ItemsModel[] {
  const num = 600 + p.inventoryPlus;
  if (items.length > num) {
    const index = Math.trunc(num / 3);
    if (items.length > index) items.splice(index, items.length - num);
  }
  return items;
}

/** Account.PointUp / ExpUp: (float)(int / 100). */
export const pointUp = (p: Account) => { const c = getPCCafe(p.cafePC); return c ? Math.trunc(c.pointUp / 100) : 0; };
export const expUp = (p: Account) => { const c = getPCCafe(p.cafePC); return c ? Math.trunc(c.expUp / 100) : 0; };

export { AccessLevel, config };

/** First free character slot (C# uses characters.Count, which collides once a row was removed without re-slotting). */
export function nextCharaSlot(p: Account): number {
  const used = new Set(p.character.characters.map((c) => c.slot));
  let s = 0;
  while (used.has(s)) s++;
  return s;
}
