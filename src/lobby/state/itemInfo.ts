// Item classification by itemId. Pure, no DOM, runs under Node type stripping.
// Server rules: ComDiv.GetIdStatics(id, 1) = id / 100000 is the item class (Plugin.Core/Enums/ItemClass.cs),
// ComDiv.GetItemCategory maps classes to Weapon/Character/Coupon/NewItem/Emoticon; the 6149 pair index per class
// is the S2_CHAR_CHANGE_EQUIP_INFO order (src/lobby/types.ts EquipSlot).
import { EquipSlot, ItemEquipType, type InventoryItem } from "../types.ts";

/** Plugin.Core/Enums/ItemClass.cs */
export const ItemClass = {
  Primary: 1, Secondary: 2, Melee: 3, Explosive: 4, Special: 5, Character: 6,
  PartHead: 7, PartFace: 8, PartJacket: 9, PartPocket: 10, PartGlove: 11, PartBelt: 12, PartHolster: 13, PartSkin: 14,
  DinoItem: 15, Maintenance: 16, Expendable: 17, Coupon: 18, Point: 20, BeretItem: 27, BattleBox: 28,
} as const;

export const itemClass = (itemId: number): number => Math.floor(itemId / 100000);

/** 6149/3082 pair index of an item, or null when it is not equipped through the 18-pair block. */
export function equipSlotOf(itemId: number): number | null {
  const c = itemClass(itemId);
  if (c >= 1 && c <= 5) return c - 1; // Primary..Special -> 0..4
  if (c === ItemClass.Character) return EquipSlot.Chara;
  if (c >= 7 && c <= 14) return EquipSlot.Head + (c - 7); // head..skin -> 9..16
  if (c === ItemClass.BeretItem) return EquipSlot.Beret;
  return null;
}

/**
 * Team a character item belongs to (0 = red/TR, 1 = blue/CT), or null for a non-character. The team is encoded in the
 * itemId like the server reads it (AllUtils.ValidateCharacterEquipment): GetIdStatics(id, 2) = id % 100000 / 1000 is
 * 1 for red and 2 for blue, with the special ranges id / 1000 = 632 (red) and 664 (blue). Any other character (no
 * team digit) returns null and the caller keeps the team the player picked.
 */
export function charaTeamOf(itemId: number): 0 | 1 | null {
  if (itemClass(itemId) !== ItemClass.Character) return null;
  const side = Math.floor((itemId % 100000) / 1000), special = Math.floor(itemId / 1000);
  if (side === 1 || special === 632) return 0;
  if (side === 2 || special === 664) return 1;
  return null;
}

/** Top menu of Inven_Menu_plus_finder (FwdTopMenuBtn): Weapon / Character / Item. */
export type ItemTab = "weapon" | "chara" | "item";

export function tabOf(itemId: number): ItemTab {
  const c = itemClass(itemId);
  if (c >= 1 && c <= 5) return "weapon";
  if ((c >= 6 && c <= 14) || c === ItemClass.BeretItem) return "chara";
  return "item";
}

/**
 * Sub filters (FwdSubMenuBtn). Weapon: all + the 5 classes. Character: all + character, head, face (mask), beret,
 * and "parts" (jacket..skin, which have no button of their own in the V12 scene).
 */
export type ItemFilter =
  | "all"
  | "primary" | "secondary" | "melee" | "throw" | "special"
  | "chara" | "head" | "face" | "beret" | "parts"
  | "maintenance" | "expendable";

/** Item-tab groups (ivItemGroupMaintenance / ivItemGroupExpendable, 0x84b750 / 0x84b7a0): by the ItemClass name of the
 * class (Maintenance 16, Expendable 17) [INFERIDO: the exe's group rule is not decoded; the names match the class] */
export const FILTER_CLASSES: Record<Exclude<ItemFilter, "all">, readonly number[]> = {
  primary: [ItemClass.Primary],
  secondary: [ItemClass.Secondary],
  melee: [ItemClass.Melee],
  throw: [ItemClass.Explosive],
  special: [ItemClass.Special],
  chara: [ItemClass.Character],
  head: [ItemClass.PartHead],
  face: [ItemClass.PartFace],
  beret: [ItemClass.BeretItem],
  parts: [9, 10, 11, 12, 13, 14],
  maintenance: [ItemClass.Maintenance],
  expendable: [ItemClass.Expendable],
};

export function matchesFilter(itemId: number, tab: ItemTab, filter: ItemFilter): boolean {
  if (tabOf(itemId) !== tab) return false;
  if (filter === "all") return true;
  return FILTER_CLASSES[filter].includes(itemClass(itemId));
}

/** Classes whose Durable `count` is a period in seconds: the ones 1050 activates (IsActivatableEquipment: 1..8, 15, 27,
 * 30..35) plus the parts 9..14 [INFERIDO: same Durable->Temporary rule, no activation path checked]. */
export function countIsSeconds(itemId: number): boolean {
  const c = itemClass(itemId);
  return (c >= 1 && c <= 8) || c === 15 || c === 27 || (c >= 30 && c <= 35) || (c >= 9 && c <= 14);
}

/** Stock ids of the in-memory basics (ComDiv.IsStockId): objectId 0x40000000 | itemId, never in player_items. */
export const isStockObjectId = (objectId: number): boolean => objectId >= 0x40000000 && objectId <= 0x40ffffff;

/** yyMMddHHmm (server DateTimeUtil) -> epoch ms, local time like the server clock. */
export function parseYyMMddHHmm(v: number): number {
  const s = String(v).padStart(10, "0");
  const y = 2000 + Number(s.slice(0, 2)), mo = Number(s.slice(2, 4)) - 1, d = Number(s.slice(4, 6));
  const h = Number(s.slice(6, 8)), mi = Number(s.slice(8, 10));
  return new Date(y, mo, d, h, mi).getTime();
}

export type TermKind = "permanent" | "unused" | "remaining" | "expired" | "count" | "pc";
export interface ItemTerm {
  kind: TermKind;
  /** seconds (unused period / remaining time) or quantity (count) */
  value: number;
}

/**
 * What the slot's term line says. Durable = not activated yet (count = seconds or quantity); Temporary =
 * count is the expiry (yyMMddHHmm); Permanent; CafePC.
 */
export function itemTerm(it: InventoryItem, nowMs = Date.now()): ItemTerm {
  switch (it.equip) {
    case ItemEquipType.Permanent: return { kind: "permanent", value: 0 };
    case ItemEquipType.CafePC: return { kind: "pc", value: 0 };
    case ItemEquipType.Durable:
      return countIsSeconds(it.itemId) ? { kind: "unused", value: it.count } : { kind: "count", value: it.count };
    case ItemEquipType.Temporary: {
      const left = Math.round((parseYyMMddHHmm(it.count) - nowMs) / 1000);
      return left > 0 ? { kind: "remaining", value: left } : { kind: "expired", value: 0 };
    }
    default: return { kind: "count", value: it.count };
  }
}
