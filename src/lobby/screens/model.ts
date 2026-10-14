// Data layer of the inventory / shop screens: stores + UI state -> MenuData. The Cross lobby (screensCross) draws it.
import { EquipSlot, ItemEquipType, type InventoryItem } from "../types.ts";
import type { PlayerStore } from "../state/PlayerStore.ts";
import type { ShopOffer, ShopOption, ShopStore } from "../state/ShopStore.ts";
import { filterOffers, priceIn, type Currency } from "../state/ShopStore.ts";
import { charaTeamOf, countIsSeconds, equipSlotOf, isStockObjectId, itemTerm, matchesFilter, tabOf, type ItemFilter, type ItemTab, type ItemTerm } from "../state/itemInfo.ts";
import { itemName } from "../state/itemNames.ts";
import { isItemShown } from "../state/weaponSupport.ts";
import { iconOf } from "./icons.ts";
import { S } from "./strings.ts";

/** 1234567 -> "1,234,567" */
export const fmtInt = (n: number): string => Math.trunc(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// ---------------------------------------------------------------------------------------------- chrome

export interface ChromeData {
  nickname: string;
  rank: number;
  exp: string;
  gold: number;
  cash: number;
  tags: number;
  serverLabel?: string;
  active: "lobby" | "inventory" | "shop";
}

export function chromeData(p: PlayerStore, active: ChromeData["active"], serverLabel?: string): ChromeData {
  const pr = p.state.profile, w = p.state.wallet;
  return {
    nickname: pr?.nickname ?? "", rank: pr?.rank ?? 0, exp: pr ? `EXP ${pr.exp}` : "",
    gold: w?.gold ?? pr?.gold ?? 0, cash: w?.cash ?? pr?.cash ?? 0, tags: w?.tags ?? pr?.tags ?? 0, serverLabel, active,
  };
}

// ---------------------------------------------------------------------------------------------- inventory / shop

export interface MenuUi {
  tab: ItemTab;
  filter: ItemFilter;
  search: string;
  /** first visible item (multiple of 3) */
  top: number;
  /** inventory: objectId; shop: itemId */
  selected: number | null;
  team: number;
  currency: Currency;
  option: number;
  toast: string;
  busy: boolean;
  /** a second click on Equipar/Comprar confirms */
  confirming: boolean;
  /** shop: the NEW & HOT tab (every tab's offers tagged NOVO / HOT, system_shop.shop_tag 1 / 2) instead of `tab` */
  hot?: boolean;
}
export const defaultMenuUi = (): MenuUi => ({ tab: "weapon", filter: "all", search: "", top: 0, selected: null, team: 0, currency: "gold", option: 0, toast: "", busy: false, confirming: false });

export interface SlotData { key: number; itemId: number; name: string; term: string; button: string; buttonEnabled: boolean; price: string; selected: boolean }

export interface MenuData {
  chrome: ChromeData;
  mode: "inventory" | "shop";
  ui: MenuUi;
  slots: SlotData[];
  total: number;
  countText: string;
  selectedItemId: number;
  selectedName: string;
  loadoutTitles: string[];
  loadoutItems: number[];
  charaItemId: number;
  actionLabel: string;
  actionEnabled: boolean;
  /** inventory only: the selected item is equipped in this cosmetic slot, so the action button clears it (itemId 0) instead of equipping */
  actionUnequipSlot?: number;
  /** shop: up to 4 options of the selected offer */
  options: { label: string; price: string; enabled: boolean }[];
}

export const GRID = { cols: 3, rows: 3, x0: 17, y0: 139, dx: 202, dy: 119 } as const;
export const PAGE = GRID.cols * GRID.rows;
/** shop options shown per offer (the buy window's 4 duration rows) */
export const MAX_OPTIONS = 4;

function fmtPeriod(sec: number): string {
  if (sec >= 86400) return `${Math.round(sec / 86400)} ${S.days}`;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
export function termText(t: ItemTerm): string {
  switch (t.kind) {
    case "permanent": return S.unlimited;
    case "unused": return `${S.notUsed} ${fmtPeriod(t.value)}`;
    case "remaining": return fmtPeriod(t.value);
    case "expired": return `0 ${S.days}`;
    case "count": return `${t.value} ${S.units}`;
    case "pc": return S.pcRoom;
  }
}
/** Shop option duration: 1039 authType 1 = quantity, 2 = period (seconds); count 0 = no limit. */
export function optionText(o: ShopOption, offer: ShopOffer): string {
  if (!o.count) return S.unlimited;
  const auth = offer.item?.authType;
  const period = auth === 2 || (auth !== 1 && countIsSeconds(offer.itemId));
  return period ? fmtPeriod(o.count) : `${o.count} ${S.units}`;
}
export const priceText = (v: number, c: Currency): string => `${fmtInt(v)} ${c === "gold" ? S.gold : S.cash}`;

function loadoutPanel(p: PlayerStore, tab: ItemTab): { titles: string[]; items: number[] } {
  const eq = p.equipPairs();
  if (tab === "chara") {
    const t = p.teamCharas();
    return { titles: [S.redChara, S.blueChara, S.head, S.mask, S.beret], items: [t.red, t.blue, eq[EquipSlot.Head].itemId, eq[EquipSlot.Face].itemId, eq[EquipSlot.Beret].itemId] };
  }
  return { titles: [S.primary, S.secondary, S.melee, S.throwing, S.special], items: [0, 1, 2, 3, 4].map((i) => eq[i].itemId) };
}

export function inventoryItems(p: PlayerStore, ui: MenuUi): InventoryItem[] {
  const q = ui.search.trim().toLowerCase();
  // kept even when incomplete in 2017: basics, equipped items and activated (Temporary) Item-tab goods
  return p.items().filter((it) => isItemShown(it.itemId, isStockObjectId(it.objectId) || p.isEquipped(it) || (it.equip === ItemEquipType.Temporary && tabOf(it.itemId) === "item")) &&
    matchesFilter(it.itemId, ui.tab, ui.filter) && (!q || itemName(it.itemId).name.toLowerCase().includes(q)))
    // grouped by slot (primary, secondary, melee, throw, special; chara and parts after), equipped first inside a group, the
    // server's order kept otherwise (Array.sort is stable). It came in raw server order: knives between rifles.
    .sort((x, y) => (equipSlotOf(x.itemId) ?? 99) - (equipSlotOf(y.itemId) ?? 99) || Number(p.isEquipped(y)) - Number(p.isEquipped(x)));
}

/** Head..Beret (9-17): cosmetic slots the original lets stay empty. Weapon slots (0-4) and Chara (8) always keep one item equipped. */
export const isUnequippableSlot = (slot: number): boolean => slot >= EquipSlot.Head && slot <= EquipSlot.Beret;

function equipState(p: PlayerStore, it: InventoryItem | undefined, team: number): { label: string; enabled: boolean; unequip?: number } {
  if (!it) return { label: S.equip, enabled: false };
  const slot = equipSlotOf(it.itemId);
  if (slot === null) return { label: S.equip, enabled: false };
  if (slot === EquipSlot.Chara) {
    const t = p.teamCharas();
    return ((charaTeamOf(it.itemId) ?? team) === 0 ? t.red : t.blue) === it.itemId ? { label: S.equipped, enabled: false } : { label: S.equip, enabled: true };
  }
  if (p.isEquipped(it)) return isUnequippableSlot(slot) ? { label: S.unequip, enabled: true, unequip: slot } : { label: S.equipped, enabled: false };
  return { label: S.equip, enabled: true };
}

export function inventoryData(p: PlayerStore, ui: MenuUi, serverLabel?: string, nowMs = Date.now()): MenuData {
  const list = inventoryItems(p, ui);
  const sel = ui.selected !== null ? p.state.inventory.get(ui.selected) : undefined;
  const lp = loadoutPanel(p, ui.tab);
  const act = equipState(p, sel, ui.team);
  const t = p.teamCharas();
  return {
    chrome: chromeData(p, "inventory", serverLabel), mode: "inventory", ui,
    slots: list.slice(ui.top, ui.top + PAGE).map((it) => {
      const st = equipState(p, it, ui.team);
      return { key: it.objectId, itemId: it.itemId, name: itemName(it.itemId).name, term: termText(itemTerm(it, nowMs)), button: st.label, buttonEnabled: st.enabled && !ui.busy, price: "", selected: it.objectId === ui.selected };
    }),
    total: list.length,
    countText: `${p.state.inventory.size} / 1500`, // server refuses buys at 1500 items
    selectedItemId: sel?.itemId ?? 0, selectedName: sel ? itemName(sel.itemId).name : "",
    loadoutTitles: lp.titles, loadoutItems: lp.items,
    charaItemId: sel && equipSlotOf(sel.itemId) === EquipSlot.Chara ? sel.itemId : ui.team === 0 ? t.red : t.blue,
    actionLabel: ui.confirming ? S.confirm : act.label, actionEnabled: act.enabled && !ui.busy, actionUnequipSlot: act.unequip, options: [],
  };
}

/** Offers of the tab / filter / search; items with an icon first (itemId order kept inside each group). Weapons not
 * complete in 2017 are hidden (state/weaponSupport.ts). */
export function shopOffers(shop: ShopStore, ui: MenuUi): ShopOffer[] {
  const q = ui.search.trim().toLowerCase();
  const base = ui.hot
    ? shop.offers.filter((o) => o.options.some((x) => x.tag === 1 || x.tag === 2) && (!q || itemName(o.itemId).name.toLowerCase().includes(q)))
    : filterOffers(shop.offers, ui.tab, ui.filter, ui.search, (id) => itemName(id).name);
  const list = base.filter((o) => o.options.some((x) => isItemShown(x.itemId)));
  return [...list.filter((o) => iconOf(o.itemId)), ...list.filter((o) => !iconOf(o.itemId))];
}

/** Cheapest option in the tab's currency, else in the other one (the server's price, never converted). */
function slotPrice(o: ShopOffer, c: Currency): string {
  const cur = o.options.filter((x) => priceIn(x, c) > 0);
  if (cur.length) return priceText(Math.min(...cur.map((x) => priceIn(x, c))), c);
  const other: Currency = c === "gold" ? "cash" : "gold";
  const alt = o.options.filter((x) => priceIn(x, other) > 0);
  return alt.length ? priceText(Math.min(...alt.map((x) => priceIn(x, other))), other) : "";
}

export function shopData(p: PlayerStore, shop: ShopStore, ui: MenuUi, serverLabel?: string): MenuData {
  const list = shopOffers(shop, ui);
  const sel = ui.selected !== null ? shop.offer(ui.selected) : undefined;
  const lp = loadoutPanel(p, ui.tab);
  const t = p.teamCharas();
  const opts = sel ? sel.options.slice(0, MAX_OPTIONS) : [];
  const chosen = opts[ui.option];
  const can = !!chosen && priceIn(chosen, ui.currency) > 0 && !ui.busy;
  return {
    chrome: chromeData(p, "shop", serverLabel), mode: "shop", ui,
    slots: list.slice(ui.top, ui.top + PAGE).map((o) => ({
      key: o.itemId, itemId: o.itemId, name: itemName(o.itemId).name, term: o.options[0] ? optionText(o.options[0], o) : "",
      button: "", buttonEnabled: true, price: slotPrice(o, ui.currency), selected: o.itemId === ui.selected,
    })),
    total: list.length,
    countText: `${p.state.inventory.size} / 1500`,
    selectedItemId: sel?.itemId ?? 0, selectedName: sel ? itemName(sel.itemId).name : "",
    loadoutTitles: lp.titles, loadoutItems: lp.items,
    charaItemId: sel && equipSlotOf(sel.itemId) === EquipSlot.Chara ? sel.itemId : ui.team === 0 ? t.red : t.blue,
    actionLabel: ui.confirming ? S.confirm : S.buy, actionEnabled: can,
    options: opts.map((o) => ({ label: optionText(o, sel!), price: priceIn(o, ui.currency) > 0 ? priceText(priceIn(o, ui.currency), ui.currency) : "-", enabled: priceIn(o, ui.currency) > 0 })),
  };
}

