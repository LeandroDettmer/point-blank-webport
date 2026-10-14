// Respawn weapon change (PB): pure state, no DOM (view: respawnMenu.ts, test:
// src/game/test/respawnSelect.test.ts). What the 2017 client does:
//
// - Key: game key map entry 12 (STBL_IDX_GAMEKEY_CHANGEWEPON). Default = keyboard
//   0x1d = "T" (CGameContext default table 0x4cd591; key names switch 0x887790 -> jump table 0x887d84). The respawn
//   notice CBattleGui 0x7239f8 prints that key: STR_TBL_BATTLEGUI_NOTICE_RESPAWN(%d = invincible s, %s = key 12).
// - Panel: 5 slot rows (CBattleGui::_LinkControl 0x729a3b loop `< 5`: rsSlotBg/Enable/Disable/Key/Prev/Next%d,
//   rsPrevWeapon/rsSelectWeapon/rsNextWeapon%d) = primary, secondary, melee, throw, special; rsConfirm/rsCancel;
//   rsLimitKey + STR_TBL_BATTLEGUI_NOTICE_WEAPON_LIMIT (room weapon limit). Items come from the inventory
//   (STR_TBL_BATTLEGUI_WEAPON_NO_INVEN). The choice is used on the NEXT respawn (STR_TBL_BATTLEGUI_NOTICE_SELECETWEAPON).
// - Server (Server.Game PROTOCOL_BATTLE_RESPAWN_REQ 5137): weapon itemIds [0..4] + flags; ComDiv.CheckEquipedItems
//   swaps anything not in the inventory for the default (103004...), so the client must send the real ids.
//   RoomWeaponsFlag: Grenade 1, Melee 2, Secondary 4, primary 8 ("Accessory" in the enum, RESPAWN_REQ reads it as
//   primary), classes Assault 16, SMG 32, Sniper 64, Shotgun 128, MG 256, RPG7 1024, Shield 2048.
// [INFERIDO] opening while alive (the choice still waits for the next respawn), arrow/Enter/Esc bindings (the v12
// scene text says), unconfirmed choice discarded when the respawn happens with the panel open.

import { isItemShown } from "../lobby/state/weaponSupport.ts";
import { isStockObjectId } from "../lobby/state/itemInfo.ts";

export const RESPAWN_SLOTS = ["primary", "secondary", "melee", "grenade", "special"] as const;
export type RespawnSlot = (typeof RESPAWN_SLOTS)[number];
export type RespawnLoadout = Record<RespawnSlot, number>;

/** Key map entry 12 default (keyboard 0x1d) as a KeyboardEvent.code, and its PB key name. */
export const CHANGE_WEAPON_KEY = { code: "KeyT", name: "T" } as const;

export const WEAPONS_FLAG = {
  grenade: 1, melee: 2, secondary: 4, primary: 8,
  Assault: 16, SMG: 32, Sniper: 64, Shotgun: 128, Machinegun: 256, RocketLauncher: 1024, Shield: 2048,
  all: 0x1ff,
} as const;

/** Clube da Luta = Rules.xml *_KCL, StageOptions 224 (C# Plugin.Core StageOptions.Knuckle). Its only weapon is the bare fist,
 * BarefistKnuckle 323001 (weapons.json className Knuckle, pb.src Knuckle/BareFist; server checkEquipedItems gives it free in
 * battle). The room's weaponsFlag is 2 (melee), which bars the rest. [INFERIDO] the exe's own knuckle-mode loadout not traced. */
export const KNUCKLE_STAGE = 224;
export const BAREFIST_ID = 323001;

/** weapons.json className -> RoomWeaponsFlag class bit (primary slot only). */
const CLASS_BIT: Record<string, number> = {
  Assault: WEAPONS_FLAG.Assault, SMG: WEAPONS_FLAG.SMG, DualSMG: WEAPONS_FLAG.SMG, Sniper: WEAPONS_FLAG.Sniper,
  Shotgun: WEAPONS_FLAG.Shotgun, DualShotgun: WEAPONS_FLAG.Shotgun, Machinegun: WEAPONS_FLAG.Machinegun,
  RocketLauncher: WEAPONS_FLAG.RocketLauncher, Shield: WEAPONS_FLAG.Shield,
};
const SLOT_BIT: Record<RespawnSlot, number> = { primary: 8, secondary: 4, melee: 2, grenade: 1, special: 0 };
/** Classes that never sit in a player's inventory slot (map objects, dino, mission bomb). */
const NOT_SELECTABLE = new Set(["Dino", "OnObject", "Mission", "BombTrigger"]);

export interface WeaponInfo {
  id: number;
  /** weapons.json slot 1..5 */
  slot: number;
  className: string;
  name: string;
}
export type WeaponCatalog = (id: number) => WeaponInfo | undefined;

export interface InventoryWeapon { itemId: number; objectId: number }
export interface RespawnInventory {
  /** Owned items (any kind; non-weapons are ignored). */
  items: InventoryWeapon[];
  /** What the slot uses now (server loadout online, default loadout offline). */
  equipped: RespawnLoadout;
}

/** Room weapon limit: may this slot change at all, and is this item allowed. */
export function slotAllowed(slot: RespawnSlot, flag: number): boolean {
  return slot === "special" || (flag & SLOT_BIT[slot]) !== 0;
}
export function itemAllowed(w: WeaponInfo, flag: number): boolean {
  const slot = RESPAWN_SLOTS[w.slot - 1];
  if (!slot || !slotAllowed(slot, flag)) return false;
  const bit = slot === "primary" ? CLASS_BIT[w.className] : undefined;
  return bit === undefined || (flag & bit) !== 0;
}

/** RoomWeaponsFlag class bit by the class digits of a primary item id (T CC NNN): 103 Assault, 104 SMG, 105 Sniper,
 * 106 Shotgun, 110 MG, 116 RPG7, 118 dual SMG (system_shop names). */
const ID_CLASS_BIT: Record<number, number> = { 3: 16, 4: 32, 5: 64, 6: 128, 10: 256, 16: 1024, 18: 32 };

/** Basic primaries: SSG-69, 870MCS, K-2, K-1 (system_shop 105003 / 106001 / 103004 / 104003). */
const BASIC_PRIMARY = [105003, 106001, 103004, 104003];

/** itemAllowed without the catalog: slot from the id's first digit, primary class from its class digits (an unknown
 * primary class passes only when every class is allowed). */
export function idAllowed(itemId: number, flag: number): boolean {
  const slot = RESPAWN_SLOTS[Math.trunc(itemId / 100000) - 1];
  if (!slot || !slotAllowed(slot, flag)) return false;
  if (slot !== "primary") return true;
  const bit = ID_CLASS_BIT[Math.trunc(itemId / 1000) % 100];
  return bit === undefined ? (flag & 0x1f0) === 0x1f0 : (flag & bit) !== 0;
}

/**
 * Room weapon limit on an equip list (pairs 0..4 = primary..special): a barred weapon becomes the first owned item
 * the room allows in that slot (Sniper room: the player's first sniper), or `empty` when there is none. Same rule
 * as RespawnSelection.takeForRespawn, for the first life, which starts from the lobby loadout. [INFERIDO] the exe's
 * own handling of an equipped-but-barred weapon was not traced.
 * Clube da Luta (`stage` KNUCKLE_STAGE): melee = the bare fist, primary / secondary / grenade empty, special kept.
 */
export function enforceRoomWeapons<T extends { itemId: number }>(pairs: T[], owned: T[], flag: number, empty: T, stage = 0): T[] {
  if (stage === KNUCKLE_STAGE) return pairs.map((p, i) => (i > 4 || i === 4 ? p : i === 2 ? { ...empty, itemId: BAREFIST_ID } : { ...empty, itemId: 0 }));
  if ((flag & 0x1ff) === 0x1ff) return pairs;
  return pairs.map((p, i) => {
    if (i > 4 || !p?.itemId || idAllowed(p.itemId, flag)) return p;
    const own = owned.find((o) => Math.trunc(o.itemId / 100000) === i + 1 && idAllowed(o.itemId, flag));
    if (own) return own;
    // no allowed primary owned: the basic one of the class (SSG-69 / 870MCS) [INFERIDO]
    const basic = i === 0 ? BASIC_PRIMARY.find((id) => idAllowed(id, flag)) : undefined;
    return basic ? { ...empty, itemId: basic } : empty;
  });
}

export interface SlotView {
  slot: RespawnSlot;
  enabled: boolean;
  /** item ids in carousel order */
  list: number[];
  index: number;
  prev: number | null;
  cur: number;
  next: number | null;
}

export class RespawnSelection {
  isOpen = false;
  focus = 0;
  /** Primary row filter (TH03_1 class tabs): className set or null = all. */
  primaryFilter: string[] | null = null;
  private lists: number[][] = [];
  private index: number[] = [];
  private equipped: RespawnLoadout;
  /** Confirmed choice waiting for the next respawn. */
  private pending: RespawnLoadout | null = null;
  private objectIds = new Map<number, number>();

  private allItems: number[] = [];
  private catalog: WeaponCatalog;
  weaponsFlag: number;
  /** Clube da Luta: the melee row is this one fist (BAREFIST_ID) and nothing else; null = every melee of the room */
  readonly meleeOnly: number | null;

  constructor(catalog: WeaponCatalog, inv: RespawnInventory, weaponsFlag: number = WEAPONS_FLAG.all, meleeOnly: number | null = null) {
    this.catalog = catalog;
    this.weaponsFlag = weaponsFlag;
    this.meleeOnly = meleeOnly;
    this.equipped = { ...inv.equipped };
    this.setInventory(inv);
  }

  setWeaponsFlag(flag: number): void {
    this.weaponsFlag = flag;
    this.rebuild();
    this.restore(this.pending ?? this.equipped);
  }

  setInventory(inv: RespawnInventory): void {
    this.equipped = { ...inv.equipped };
    this.objectIds.clear();
    for (const it of inv.items) if (!this.objectIds.has(it.itemId)) this.objectIds.set(it.itemId, it.objectId);
    this.rebuild(inv.items.map((i) => i.itemId));
  }

  private rebuild(items = this.allItems): void {
    this.allItems = items;
    const base = this.pending ?? this.equipped;
    this.lists = RESPAWN_SLOTS.map((slot, si) => {
      if (slot === "melee" && this.meleeOnly !== null) return [this.meleeOnly];
      const seen = new Set<number>();
      const out: number[] = [];
      const cur = base[slot];
      // equipped item is always there, unless the room mode restricts weapons (sniper / shotgun / knife) and bars it
      if (cur && (!this.enforcing() || this.allowedId(slot, cur))) { out.push(cur); seen.add(cur); }
      if (slotAllowed(slot, this.weaponsFlag)) {
        for (const id of items) {
          if (seen.has(id)) continue;
          const w = this.catalog(id);
          if (!w || w.slot !== si + 1 || NOT_SELECTABLE.has(w.className) || !itemAllowed(w, this.weaponsFlag)) continue;
          if (slot === "primary" && this.primaryFilter && id !== cur && !this.primaryFilter.includes(w.className)) continue;
          seen.add(id);
          out.push(id);
        }
      }
      if (!out.length) out.push(0);
      return out;
    });
    this.index = this.lists.map(() => 0);
  }

  setPrimaryFilter(classes: string[] | null): void {
    const keep = this.current();
    this.primaryFilter = classes;
    this.rebuild();
    this.restore(keep);
  }

  private restore(pick: RespawnLoadout): void {
    RESPAWN_SLOTS.forEach((s, i) => { const k = this.lists[i].indexOf(pick[s]); this.index[i] = k >= 0 ? k : 0; });
  }

  /** The room mode restricts weapons (flag short of the full 0x1ff): barred items leave the loadout, not only the
   * change list. [INFERIDO] the exe's own handling of an equipped-but-barred weapon was not traced. */
  enforcing(): boolean {
    return (this.weaponsFlag & 0x1ff) !== 0x1ff;
  }

  private allowedId(slot: RespawnSlot, id: number): boolean {
    if (!slotAllowed(slot, this.weaponsFlag)) return false;
    const w = this.catalog(id);
    return !w || itemAllowed(w, this.weaponsFlag);
  }

  /** Any slot locked by the room weapon limit (shows STR_TBL_BATTLEGUI_NOTICE_WEAPON_LIMIT). */
  limited(): boolean {
    return RESPAWN_SLOTS.some((s) => !slotAllowed(s, this.weaponsFlag)) || (this.weaponsFlag & 0x1f0) !== 0x1f0;
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.rebuild();
    this.restore(this.pending ?? this.equipped);
  }

  /** OK: the picks become the next-respawn loadout. Cancel: discarded. */
  close(confirm: boolean): void {
    if (!this.isOpen) return;
    if (confirm) {
      const pick = this.current();
      const base = this.pending ?? this.equipped;
      this.pending = RESPAWN_SLOTS.some((s) => pick[s] !== base[s]) || this.pending ? pick : null;
    }
    this.isOpen = false;
  }

  current(): RespawnLoadout {
    const out = {} as RespawnLoadout;
    RESPAWN_SLOTS.forEach((s, i) => (out[s] = this.lists[i]?.[this.index[i]] ?? this.equipped[s]));
    return out;
  }

  view(i: number): SlotView {
    const list = this.lists[i], k = this.index[i], n = list.length;
    return {
      slot: RESPAWN_SLOTS[i],
      enabled: slotAllowed(RESPAWN_SLOTS[i], this.weaponsFlag) && n > 1,
      list, index: k,
      prev: n > 1 ? list[(k - 1 + n) % n] : null,
      cur: list[k],
      next: n > 1 ? list[(k + 1) % n] : null,
    };
  }

  cycle(i: number, dir: 1 | -1): void {
    const n = this.lists[i]?.length ?? 0;
    if (n < 2 || !slotAllowed(RESPAWN_SLOTS[i], this.weaponsFlag)) return;
    this.index[i] = (this.index[i] + dir + n) % n;
  }

  moveFocus(dir: 1 | -1): void {
    this.focus = (this.focus + dir + RESPAWN_SLOTS.length) % RESPAWN_SLOTS.length;
  }

  /** Keyboard while open. Returns true when the key was used. */
  key(code: string): boolean {
    if (!this.isOpen) return false;
    switch (code) {
      case "ArrowUp": this.moveFocus(-1); return true;
      case "ArrowDown": this.moveFocus(1); return true;
      case "ArrowLeft": this.cycle(this.focus, -1); return true;
      case "ArrowRight": this.cycle(this.focus, 1); return true;
      case "Enter": case "NumpadEnter": this.close(true); return true;
      case "Escape": this.close(false); return true;
    }
    return false;
  }

  hasPending(): boolean { return this.pending !== null; }

  /**
   * Called when the local player respawns: returns the loadout to use (the confirmed choice, else the current one)
   * and makes it the equipped one. An open, unconfirmed panel is discarded.
   */
  takeForRespawn(): RespawnLoadout {
    if (this.isOpen) this.close(false);
    if (this.pending) this.equipped = this.pending;
    this.pending = null;
    const out = { ...this.equipped };
    // restricted mode: a barred weapon becomes the slot's first allowed one, or nothing (0) when there is none
    if (this.enforcing()) {
      RESPAWN_SLOTS.forEach((s, i) => {
        if (!out[s] || this.allowedId(s, out[s])) return;
        out[s] = this.lists[i]?.[0] || (s === "primary" ? BASIC_PRIMARY.find((id) => idAllowed(id, this.weaponsFlag)) ?? 0 : 0);
      });
    }
    return out;
  }

  objectIdOf(itemId: number): number { return this.objectIds.get(itemId) ?? 0; }
}

/** weapons.json-backed catalog (id, slot, className, name). */
export function catalogFromWeapons(list: { id: number; slot: number; className: string; name: string }[]): WeaponCatalog {
  const m = new Map(list.map((w) => [w.id, w]));
  return (id) => m.get(id);
}

/**
 * Offline (?play) test inventory: default loadout + every weapon that has a 3D model
 * (public/assets/weapons/models/index.json itemIds). With `catalog`, one item per slot + display name: the pef has
 * many same-named copies (event / PC-cafe / region ids: 870MCS x3, AK-47 Silver x4, 292 extra rows) that listed as
 * repeated weapons; a real account (player_items) holds only what it owns.
 */
export function localTestInventory(
  defaults: { primary: number; secondary: number; melee: number; grenade: number },
  modelIndex: { weapons: { itemIds?: number[] }[] },
  catalog?: WeaponCatalog,
): RespawnInventory {
  const ids = new Set<number>([defaults.primary, defaults.secondary, defaults.melee, defaults.grenade]);
  const names = new Set<string>();
  const key = (id: number) => { const w = catalog?.(id); return w ? `${w.slot}:${w.name}` : null; };
  for (const id of ids) { const k = key(id); if (k) names.add(k); }
  for (const w of modelIndex.weapons) for (const id of w.itemIds ?? []) {
    const k = key(id);
    if (k && names.has(k)) continue;
    if (k) names.add(k);
    ids.add(id);
  }
  return {
    items: [...ids].map((itemId) => ({ itemId, objectId: 0 })),
    equipped: { primary: defaults.primary, secondary: defaults.secondary, melee: defaults.melee, grenade: defaults.grenade, special: 0 },
  };
}

/** Online: PlayerStore (?, read-only) inventory + loadout. */
/** ItemEquipType.Durable (lobby/types.ts): bought but never activated ("Usar" in the inventory), not usable yet */
const EQUIP_DURABLE = 1;
/** Server default kit (server shared/playerUtils.ts checkEquipedItems: the reset values). */
const DEFAULT_KIT: RespawnLoadout = { primary: 103004, secondary: 202022, melee: 301012, grenade: 407001, special: 508002 };
/** Ids the server keeps without an inventory item on a respawn (battleRules): basic primary, the battle-rule primaries, the fist. */
const FREE_LOADOUT_IDS = new Set([103004, 105025, 106007, 323001]);

export function inventoryFromPlayer(p: {
  items(): { itemId: number; objectId: number; equip?: number }[];
  weaponLoadout(): { primary: number; secondary: number; melee: number; grenade: number; special: number };
}): RespawnInventory {
  // an item the Cross client does not ship (lobby gate, isItemShown) is absent here too: not offered, and reset like an unowned one
  const all = p.items().filter((i) => isItemShown(i.itemId, isStockObjectId(i.objectId)));
  // a never-activated item can't be picked in battle: the original only lists items already in use
  const usable = all.filter((i) => i.equip !== EQUIP_DURABLE);
  // an equipped weapon the account does not own is reset to the default kit by the server (checkEquipedItems), so the
  // menu's current card shows what the battle uses, not an unowned weapon (e.g. a primary left equipped after a sale)
  const have = new Set(all.map((i) => i.itemId));
  const lo = p.weaponLoadout();
  const equipped = { ...lo } as RespawnLoadout;
  for (const s of RESPAWN_SLOTS) if (!have.has(lo[s]) && !FREE_LOADOUT_IDS.has(lo[s])) equipped[s] = DEFAULT_KIT[s];
  return { items: usable.map((i) => ({ itemId: i.itemId, objectId: i.objectId })), equipped };
}
