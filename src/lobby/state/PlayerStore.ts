// Player meta state, The server is the source of truth: every change comes from a
// parsed server packet (2319, 3334, 1059, 1051, 1061, 1047, 3082, 2453, 6146, 2371, 2369) or from the 6150 ACK of a
// 6149 this client sent. Pure reducer + observable wrapper; no DOM, no socket (MetaSession feeds it).
// Exposed to ?: weaponLoadout(), teamCharas(), equipPairs().
import {
  EQUIP_PAIRS, EquipSlot, ItemEquipType,
  type BuyResult, type CharaInfo, type CharaSlot, type EquipPair, type InventoryDelta, type InventoryItem,
  type InventoryPage, type InvItemData, type Loadout, type PlayerRecord, type UserInfo, type UserInfoBasic, type Wallet, type WeaponLoadout,
} from "../types.ts";
import type { CharChangeEquipRequest, CreateCharaAck, EnterPushes } from "../../net/metaGame.ts";
import { KEEP_CHARA_SLOT, unsavedCharas, weaponsOf } from "../../net/metaGame.ts";
import { Observable } from "./observable.ts";

export type PlayerKey = "profile" | "record" | "wallet" | "inventory" | "loadout" | "charas";

export interface PlayerState {
  profile: UserInfoBasic | null;
  /** USER_INFO_INVITEM_DATA (2317 block 45, 2395 push): own nick colour, fake rank / nick, crosshair / muzzle / border colours */
  invItem: InvItemData | null;
  record: PlayerRecord | null;
  wallet: Wallet | null;
  /** by objectId */
  inventory: ReadonlyMap<number, InventoryItem>;
  /** Items.Count reported by the last 3334 (includes in-memory basics) */
  inventoryTotal: number | null;
  loadout: Loadout | null;
  /**
   *: the server's CHANGE_INVENTORY.: rebuilt locally from a 6149 the server ACKed, applying the
   * same rules the server applies, because 6149 is never followed by a 3082.
   */
  loadoutSource: "3082" | "6150" | null;
  charaInfo: CharaInfo | null;
  /** Characters whose Auth INSERT failed (stock objectId): the Game will duplicate a slot. */
  unsavedCharas: CharaSlot[];
  lastBuy: BuyResult | null;
}

export type PlayerEvent =
  | { type: "authMeta"; userInfo: UserInfo; inventory: InventoryPage | null; wallet: Wallet | null; charaInfo?: CharaInfo | null }
  | { type: "enter"; pushes: EnterPushes }
  | { type: "inventoryPage"; page: InventoryPage }
  | { type: "inventoryDelta"; delta: InventoryDelta }
  | { type: "itemDeleted"; objectId: number }
  | { type: "itemAuth"; item: InventoryItem }
  | { type: "wallet"; wallet: Wallet }
  | { type: "buy"; result: BuyResult }
  | { type: "loadout"; loadout: Loadout }
  | { type: "charaInfo"; info: CharaInfo }
  | { type: "charaCreated"; ack: CreateCharaAck }
  | { type: "profile"; basic: UserInfoBasic }
  | { type: "invItem"; data: InvItemData }
  | { type: "record"; record: PlayerRecord }
  | { type: "equipAck"; request: CharChangeEquipRequest; error: number };

export const emptyPlayerState = (): PlayerState => ({
  profile: null, invItem: null, record: null, wallet: null, inventory: new Map(), inventoryTotal: null,
  loadout: null, loadoutSource: null, charaInfo: null, unsavedCharas: [], lastBuy: null,
});

const zero = (): EquipPair => ({ itemId: 0, objectId: 0 });

function upsert(inv: ReadonlyMap<number, InventoryItem>, items: InventoryItem[]): Map<number, InventoryItem> {
  const m = new Map(inv);
  for (const it of items) m.set(it.objectId, { ...it });
  return m;
}

/** Inventory has an item with that itemId (the server's 6149 check is by itemId: Inventory.GetItem(id)). */
export function hasItemId(inv: ReadonlyMap<number, InventoryItem>, itemId: number): InventoryItem | undefined {
  for (const it of inv.values()) if (it.itemId === itemId) return it;
  return undefined;
}

/**
 * 2453 after a 6146: the server appended the character to player_characters (slot = Characters.Count) and sends
 * no 2453, so the new slot is added here. Same (slot, itemId) twice is one character.
 */
export function addCreatedChara(info: CharaInfo | null, ack: CreateCharaAck): CharaInfo | null {
  if (ack.error !== 0 || !ack.itemId || ack.slot < 0) return info;
  const cur = info ?? { charas: [], equip: ack.equip.map((p) => ({ ...p })) };
  if (cur.charas.some((c) => c.slot === ack.slot && c.itemId === ack.itemId)) return cur;
  return { ...cur, charas: [...cur.charas, { slot: ack.slot, itemId: ack.itemId, objectId: ack.objectId }] };
}

/**
 * Loadout after a 6149 the server ACKed (6150 is always 0: validation is silent). Mirrors
 *: weapon/part pairs change only when the itemId is in the inventory, the beret is taken
 * as sent, a side's character changes only when the sent slot belongs to exactly one character in 2453
 * (KEEP_CHARA_SLOT leaves it). equip[8] follows the red side, as 3082 does in the lobby.
 */
export function applyEquipRequest(s: PlayerState, q: CharChangeEquipRequest): Loadout | null {
  const cur = s.loadout;
  if (!cur || !q.equipChanged || !q.equip) return cur;
  const equip = cur.equip.map((p) => ({ ...p }));
  for (let i = 0; i < EQUIP_PAIRS; i++) {
    if (i >= 5 && i <= 8) continue;
    const want = q.equip[i];
    if (!want) continue;
    if (i === EquipSlot.Beret) { equip[i] = { ...want }; continue; }
    // cosmetic parts (head / face / jacket ... skin): 0 clears the slot, like server handleChangeEquip does
    // (weapons 0-4 keep the previous item, the server never unequips them)
    if (!want.itemId && i >= EquipSlot.Head && i < EquipSlot.Beret) { equip[i] = zero(); continue; }
    if (want.itemId === equip[i].itemId) continue;
    const it = want.itemId ? hasItemId(s.inventory, want.itemId) : undefined;
    if (it) equip[i] = { itemId: it.itemId, objectId: it.objectId };
  }
  const charaSlots = [...cur.charaSlots];
  q.charaSlots.forEach((slot, side) => {
    if (slot === KEEP_CHARA_SLOT || !s.charaInfo) return;
    const owners = s.charaInfo.charas.filter((c) => c.slot === slot);
    if (owners.length !== 1) return;
    charaSlots[side] = slot;
    if (side === 0) equip[EquipSlot.Chara] = { itemId: owners[0].itemId, objectId: owners[0].objectId };
  });
  return { ...cur, equip, charaSlots };
}

export function reducePlayer(s: PlayerState, e: PlayerEvent): { state: PlayerState; changed: PlayerKey[] } {
  const changed: PlayerKey[] = [];
  let n: PlayerState = s;
  const set = <K extends keyof PlayerState>(k: K, v: PlayerState[K], key: PlayerKey) => {
    n = { ...n, [k]: v };
    if (!changed.includes(key)) changed.push(key);
  };
  switch (e.type) {
    case "authMeta":
      if (e.userInfo.basic) set("profile", e.userInfo.basic, "profile");
      if (e.userInfo.invItem) set("invItem", e.userInfo.invItem, "profile");
      if (e.userInfo.record) set("record", e.userInfo.record, "record");
      if (e.inventory) set("inventory", upsert(new Map(), e.inventory.items), "inventory");
      if (e.wallet) set("wallet", e.wallet, "wallet");
      else if (e.userInfo.basic) set("wallet", { gold: e.userInfo.basic.gold, cash: e.userInfo.basic.cash, tags: e.userInfo.basic.tags }, "wallet");
      if (e.charaInfo) set("unsavedCharas", unsavedCharas(e.charaInfo), "charas");
      break;
    case "enter": {
      const p = e.pushes;
      if (p.basic) set("profile", p.basic, "profile");
      if (p.invItem) set("invItem", p.invItem, "profile");
      if (p.record) set("record", p.record, "record");
      if (p.wallet) set("wallet", p.wallet, "wallet");
      if (p.charaInfo) set("charaInfo", p.charaInfo, "charas");
      if (p.loadout) { set("loadout", p.loadout, "loadout"); set("loadoutSource", "3082", "loadout"); }
      break;
    }
    case "inventoryPage":
      if (e.page.error === 0) set("inventory", upsert(new Map(), e.page.items), "inventory");
      break;
    case "inventoryDelta":
      set("inventory", upsert(n.inventory, e.delta.items), "inventory");
      set("inventoryTotal", e.delta.inventoryTotal, "inventory");
      break;
    case "itemDeleted": {
      if (!n.inventory.has(e.objectId)) break;
      const m = new Map(n.inventory);
      m.delete(e.objectId);
      set("inventory", m, "inventory");
      break;
    }
    case "itemAuth": {
      // itemId 0 + count 0 = the item was used up: a buff coupon (17DDxxx) whose last unit became its [Active] effect
      // item (server buffCoupon + itemAuthAck deleteItem), gold / BP / expansion coupons, ... The row is gone
      // server-side; keeping it left a "0 unidades" coupon next to the new effect item.
      if (e.item.itemId === 0 && e.item.count === 0) {
        if (!n.inventory.has(e.item.objectId)) break;
        const m = new Map(n.inventory);
        m.delete(e.item.objectId);
        set("inventory", m, "inventory");
        break;
      }
      // 1051 for a Temporary coupon carries itemId 0 (PROTOCOL_AUTH_SHOP_ITEM_AUTH_ACK.Write): keep the known id
      const prev = n.inventory.get(e.item.objectId);
      const item = e.item.itemId === 0 && prev ? { ...e.item, itemId: prev.itemId } : e.item;
      set("inventory", upsert(n.inventory, [item]), "inventory");
      break;
    }
    case "wallet":
      set("wallet", { ...e.wallet }, "wallet");
      break;
    case "buy":
      // both 1047 branches carry the account's gold/cash after the attempt; tags are not in 1047
      set("wallet", { gold: e.result.gold, cash: e.result.cash, tags: n.wallet?.tags ?? 0 }, "wallet");
      n = { ...n, lastBuy: e.result };
      break;
    case "loadout":
      set("loadout", e.loadout, "loadout");
      set("loadoutSource", "3082", "loadout");
      break;
    case "charaInfo":
      set("charaInfo", e.info, "charas");
      break;
    case "charaCreated": {
      const ci = addCreatedChara(n.charaInfo, e.ack);
      if (ci !== n.charaInfo) set("charaInfo", ci, "charas");
      if (e.ack.error === 0) set("wallet", { gold: e.ack.gold, cash: e.ack.cash, tags: n.wallet?.tags ?? 0 }, "wallet");
      break;
    }
    case "profile":
      set("profile", e.basic, "profile");
      break;
    case "invItem":
      set("invItem", e.data, "profile");
      break;
    case "record":
      set("record", e.record, "record");
      break;
    case "equipAck":
      if (e.error === 0) {
        const lo = applyEquipRequest(n, e.request);
        if (lo && lo !== n.loadout) { set("loadout", lo, "loadout"); set("loadoutSource", "6150", "loadout"); }
      }
      break;
  }
  return { state: n, changed };
}

export class PlayerStore extends Observable<PlayerKey> {
  private s: PlayerState = emptyPlayerState();

  get state(): PlayerState { return this.s; }

  dispatch(e: PlayerEvent): PlayerKey[] {
    const r = reducePlayer(this.s, e);
    this.s = r.state;
    this.emit(r.changed);
    return r.changed;
  }

  reset(): void {
    this.s = emptyPlayerState();
    this.emit(["profile", "record", "wallet", "inventory", "loadout", "charas"]);
  }

  // ---- selectors

  /** Sorted by objectId (2319 order). */
  items(): InventoryItem[] { return [...this.s.inventory.values()].sort((a, b) => a.objectId - b.objectId); }

  /** 18 pairs of the current loadout (zeros before 3082). */
  equipPairs(): EquipPair[] { return this.s.loadout?.equip.map((p) => ({ ...p })) ?? Array.from({ length: EQUIP_PAIRS }, zero); }

  /** Weapon itemIds by slot for WeaponSystem / RESPAWN. */
  weaponLoadout(): WeaponLoadout { return weaponsOf(this.equipPairs()); }

  /**
   * Characters of the red and blue team. Red = equip[8] (3082 in the lobby); blue = the 2453 character whose slot
   * is charaSlots[1]. `ambiguous` = that slot is shared by two characters.
   */
  teamCharas(): { red: number; blue: number; redSlot: number | null; blueSlot: number | null; ambiguous: boolean } {
    const lo = this.s.loadout, ci = this.s.charaInfo;
    const redSlot = lo?.charaSlots[0] ?? null, blueSlot = lo?.charaSlots[1] ?? null;
    const bySlot = (slot: number | null) => (slot === null || !ci ? [] : ci.charas.filter((c) => c.slot === slot));
    const blues = bySlot(blueSlot), reds = bySlot(redSlot);
    return {
      red: lo?.equip[EquipSlot.Chara]?.itemId || reds[0]?.itemId || 0,
      blue: blues[0]?.itemId ?? 0,
      redSlot, blueSlot,
      ambiguous: blues.length > 1 || reds.length > 1,
    };
  }

  /** objectIds shown as "Equipado" (weapon/part/beret pairs + both team characters). */
  equippedObjectIds(): Set<number> {
    const out = new Set<number>();
    const eq = this.s.loadout?.equip ?? [];
    eq.forEach((p, i) => {
      if (!p.itemId || (i >= 5 && i <= 7)) return;
      const it = p.objectId && this.s.inventory.has(p.objectId) ? this.s.inventory.get(p.objectId) : hasItemId(this.s.inventory, p.itemId);
      if (it) out.add(it.objectId);
    });
    const t = this.teamCharas();
    for (const id of [t.red, t.blue]) { const it = id ? hasItemId(this.s.inventory, id) : undefined; if (it) out.add(it.objectId); }
    return out;
  }

  /** player_characters slot of a character (2453 + 6146), null when the server has not given it one. */
  charaSlotOf(itemId: number): number | null {
    return this.s.charaInfo?.charas.find((c) => c.itemId === itemId)?.slot ?? null;
  }

  /** Is this inventory item the one in its loadout slot? */
  isEquipped(it: InventoryItem): boolean { return this.equippedObjectIds().has(it.objectId); }

  /**
   * The item that must be activated (1050) before it can be used. Not just equipment: the server's 1050
   * handler (PROTOCOL_CHAR_CHANGE_EQUIP_SINGLE_REQ.cs) also starts the Durable timer for non-equippable
   * function/coupon items (Quick Change, capsules, buffs, ...) by handing them to the unified item-use
   * handler, so any Durable item needs the "Usar" -> "Confirmar" flow, not just the 18-pair equipment.
   */
  needsActivation(it: InventoryItem): boolean { return it.equip === ItemEquipType.Durable; }
}
