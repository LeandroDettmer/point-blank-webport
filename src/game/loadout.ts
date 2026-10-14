// Match loadout helpers: which character model an equipped itemId uses, and which battle
// items change weapon handling. Pure (no three / DOM): used by charModel.ts, viewmodel.ts, game.ts and Node smokes.
import type { PbItemEffects } from "../weapons/types";
import type { Team } from "./types";

/** A chars/index.json entry (pb-extract-tools export-batch.mjs): `itemId` = the item the model was exported for, `itemIds` = all. */
export interface CharaLike {
  name: string;
  team?: string;
  itemId?: number | null;
  itemIds?: number[] | null;
}

/**
 * Basic characters every account owns (server Data/Temps/Basic.xml, system_template_items): red 601001 REBEL_Male +
 * 601003 Tarantula, blue 602002 SWAT_Male + 602004 Keen Eyes (equipped defaults are the plain male models).
 * The fallback of a side with no (or no exported) character is the first basic one that has a model.
 */
export const BASIC_CHARAS: Readonly<Record<Team, readonly number[]>> = { 0: [601001, 601003], 1: [602002, 602004] };

export type CharaSource = "itemId" | "basic" | "team" | "any" | "none";

const teamName = (team: Team) => (team === 0 ? "red" : "blue");

function byItem<E extends CharaLike>(list: readonly E[], itemId: number): E | undefined {
  return list.find((c) => c.itemId === itemId) ?? list.find((c) => c.itemIds?.includes(itemId));
}

/**
 * Character entry for an equipped itemId (chara_red_side / chara_blue_side, RESPAWN 5138 pair). Missing itemId or no
 * model for it -> the side's basic character -> the first character of the side -> any character.
 */
export function resolveChara<E extends CharaLike>(list: readonly E[], itemId: number | null | undefined, team: Team): { entry: E | null; source: CharaSource } {
  if (itemId) {
    const e = byItem(list, itemId);
    if (e) return { entry: e, source: "itemId" };
  }
  for (const id of BASIC_CHARAS[team]) {
    const e = byItem(list, id);
    if (e) return { entry: e, source: "basic" };
  }
  const t = list.find((c) => c.team === teamName(team));
  if (t) return { entry: t, source: "team" };
  return list[0] ? { entry: list[0], source: "any" } : { entry: null, source: "none" };
}

/**
 * Battle items that change handling (server Plugin.Core EffectId / CouponEffects): 1600026 and 1600165 Quick Change
 * (weapon swap), 1600027 and 1600166 Quick Change Reload. The exe checks them as IsUseFuncItemSlot(net, 7) in the swap
 * (0xa0c3d0) and (net, 8) in LoadMagazine / LoadBullet (0xa0cd50 / 0xa0d2d0); see WeaponSystem pbSwapScale /
 * pbReloadScale.
 */
export const QUICK_CHANGE_WEAPON_ITEMS: readonly number[] = [1600026, 1600165];
export const QUICK_CHANGE_RELOAD_ITEMS: readonly number[] = [1600027, 1600166];
/**
 * Respawn coupons (server CouponEffects Respawn20/30/50/100, EffectId.cs; HUD STR_TBL_BATTLEGUI_RESPAWN<N>_ITEM
 * "Respawn N% mais rápido"): itemId -> share of the respawn time cut. Instant Respawn (1600080 / 1600182, flag
 * Respawn100) = no wait. [INFERIDO] the time is RespawnTime x (1 - N%) and the biggest active coupon wins: the exe's
 * formula is not decoded.
 */
export const RESPAWN_CUT_ITEMS: Readonly<Record<number, number>> = {
  1600077: 0.2, 1600164: 0.2, 1600007: 0.3, 1600163: 0.3, 1600064: 0.5, 1600183: 0.5, 1600080: 1, 1600182: 1,
};
/** Ammo Up coupons (server EffectId AmmoPlus40 / AmmoPlus10, CouponEffects Ammo40 / Ammo10): extra reserve share. */
export const AMMO_UP_ITEMS: Readonly<Record<number, number>> = { 1600008: 0.4, 1600185: 0.1 };
/**
 * The other battle coupons (server CouponEffects, EffectId.cs; names from system_shop_effects). Values in the name:
 * HP Up 5% / 10%, Defense Up 5% / 10% / 20%, Vest 90% (GM), "Invisible +1 Seconds"; Flashbang Protection halves the
 * flash (ScreenEffect_Flashbang 0xAA25F3, server EffectId note). [INFERIDO]: how HP / defense apply (max HP x (1 + N%),
 * damage taken x (1 - N%)), the grenade / smoke slot +1 (a pair for dual grenades), and the bullet coupons, which
 * have no number anywhere: Hollow Point +5% damage, Hollow Point Plus +10%, Jack Hollow Point +5% damage and +5%
 * helmet penetration, Full Metal Jack +10% helmet penetration. Not applied: Camouflage 50 / 99 (the other clients
 * must draw it and the coupon flags are not replicated), Get Dropped Weapon (its rule is not decoded), C-4 Speed Up
 * (bomb modes only).
 */
type CouponFx = Partial<Pick<PbItemEffects, "hpUp" | "defense" | "invincibleExtra" | "flashProtect" | "extraGrenade" | "extraSpecialThrow" | "bulletDamageUp" | "bulletPenetrateUp">>;
export const BATTLE_COUPONS: Readonly<Record<number, CouponFx>> = {
  1600040: { hpUp: 0.05 }, 1600028: { hpUp: 0.1 }, 1600101: { hpUp: 0.1 },
  1600030: { defense: 0.05 }, 1600044: { defense: 0.1 }, 1600079: { defense: 0.2 }, 1600065: { defense: 0.9 },
  1600029: { invincibleExtra: 1 }, 1600167: { invincibleExtra: 1 },
  1600033: { flashProtect: true },
  1600035: { extraGrenade: true },
  1600191: { extraSpecialThrow: true }, 1600211: { extraSpecialThrow: true },
  1600032: { bulletDamageUp: 0.05 }, 1600169: { bulletDamageUp: 0.05 },
  1600078: { bulletDamageUp: 0.1 },
  1600036: { bulletDamageUp: 0.05, bulletPenetrateUp: 0.05 },
  1600031: { bulletPenetrateUp: 0.1 }, 1600170: { bulletPenetrateUp: 0.1 },
};
/** ?playtest=all: every coupon / Quick Change / Ammo Up / Respawn item active + Quick Change beret (biggest number wins). */
export function allItemEffects(): PbItemEffects {
  const ids = [...QUICK_CHANGE_WEAPON_ITEMS, ...QUICK_CHANGE_RELOAD_ITEMS, ...Object.keys(BATTLE_COUPONS).map(Number),
    ...Object.keys(AMMO_UP_ITEMS).map(Number), ...Object.keys(RESPAWN_CUT_ITEMS).map(Number)];
  return itemEffectsOf(ids.map((itemId) => ({ itemId })), QUICK_CHANGE_BERETS[0]);
}
/** lobby ItemEquipType.Durable: bought, not activated yet */
const ITEM_EQUIP_DURABLE = 1;

/**
 * Berets (item class 27, equip pair 17) that are a Quick Change source: the swap checks the equipped beret's type
 * (0x622cc0, chara+0xcdc) == 10 (WeaponSystem pbSwapScale). Type 10 is Equipment.pef Beret/BeretPBTN (_Type 10,
 * extracted/pef2017/br/Equipment.json), server item 2700013 (public/assets/equip/index.json "beretpbtn"). [INFERIDO]
 * that 0x622cc0 returns the pef _Type, and the 3.123 itemId <-> 2017 pef name match (pb-extract-tools export-headgear.mjs).
 */
export const QUICK_CHANGE_BERETS: readonly number[] = [2700013];
/**
 * Berets for which isUseFastReloadTime_CurrentBeret (0x613710) is true: none known. [INFERIDO] The condition inside
 * 0x613710 is not decoded (the local PointBlank.exe files are packed, no dump), and no 2017 Equipment.pef beret has a
 * FastReload_* / _Ability field, so no sold beret sets beretFastReload. Add item ids here once the check is decoded.
 */
export const FAST_RELOAD_BERETS: readonly number[] = [];

/**
 * Item effects of an inventory (PlayerStore items: { itemId, equip }) and the equipped beret itemId (equip pair 17,
 * 0 = none). A coupon works once activated (server AllUtils: Player.Effects |= CouponEffectXML flag); a Durable
 * (equip 1) item has not been activated yet (1050), so it does not count. Entries without `equip` count. The beret
 * counts only while equipped: the exe reads the worn beret, not the inventory.
 */
export function itemEffectsOf(items: Iterable<{ itemId: number; equip?: number }>, beret = 0): PbItemEffects {
  const fx: PbItemEffects = {};
  for (const it of items) {
    if (it.equip === ITEM_EQUIP_DURABLE) continue;
    if (QUICK_CHANGE_WEAPON_ITEMS.includes(it.itemId)) fx.quickChangeWeapon = true;
    if (QUICK_CHANGE_RELOAD_ITEMS.includes(it.itemId)) fx.quickChangeReload = true;
    const c = BATTLE_COUPONS[it.itemId];
    if (c) {
      // numbers: the biggest active coupon wins (the server keeps defense / bullet coupons exclusive anyway)
      for (const k of ["hpUp", "defense", "invincibleExtra", "bulletDamageUp", "bulletPenetrateUp"] as const) {
        const v = c[k];
        if (v !== undefined && v > (fx[k] ?? 0)) fx[k] = v;
      }
      if (c.flashProtect) fx.flashProtect = true;
      if (c.extraGrenade) fx.extraGrenade = true;
      if (c.extraSpecialThrow) fx.extraSpecialThrow = true;
    }
    const up = AMMO_UP_ITEMS[it.itemId];
    if (up && up > (fx.ammoUp ?? 0)) fx.ammoUp = up;
    const cut = RESPAWN_CUT_ITEMS[it.itemId];
    if (cut && cut > (fx.respawnCut ?? 0)) fx.respawnCut = cut;
  }
  if (beret && QUICK_CHANGE_BERETS.includes(beret)) fx.beretQuickChange = true;
  if (beret && FAST_RELOAD_BERETS.includes(beret)) fx.beretFastReload = true;
  return fx;
}
