// Plugin.Core ItemsModel + ComDiv item-id helpers (GetIdStatics, GetItemCategory, GenStockId, ValidateStockId).

export const ItemCategory = { None: 0, Weapon: 1, Character: 2, Coupon: 3, NewItem: 4, Emoticon: 5 } as const;
export const ItemEquipType = { Durable: 1, Temporary: 2, Permanent: 3, CafePC: 4 } as const;

/** ComDiv.GetIdStatics(Id, Type). */
export function getIdStatics(id: number, type: number): number {
  switch (type) {
    case 1: return Math.trunc(id / 100000);
    case 2: return Math.trunc((id % 100000) / 1000);
    case 3: return id % 1000;
    case 4: return Math.trunc((id % 10000000) / 100000);
    case 5: return Math.trunc(id / 1000);
    default: return 0;
  }
}

/** ComDiv.GetItemCategory. */
export function getItemCategory(itemId: number): number {
  const s1 = getIdStatics(itemId, 1), s4 = getIdStatics(itemId, 4);
  if (s1 >= 1 && s1 <= 5) return ItemCategory.Weapon;
  if ((s1 >= 6 && s1 <= 14) || s1 === 27 || (s4 >= 7 && s4 <= 14)) return ItemCategory.Character;
  if ((s1 >= 16 && s1 <= 20) || s1 === 22 || s1 === 26 || (s1 >= 28 && s1 <= 29) || (s1 >= 36 && s1 <= 40) || s1 === 42 || s1 === 91 || s1 === 92 || s1 === 99)
    return ItemCategory.Coupon;
  if (s1 === 15 || (s1 >= 30 && s1 <= 35)) return ItemCategory.NewItem;
  if (s1 === 41) return ItemCategory.Emoticon;
  return ItemCategory.None;
}

/** ComDiv.GenStockId: BitConverter.GetBytes(ItemId) with byte[3] = 0x40. */
export function genStockId(itemId: number): number {
  return ((itemId & 0x00ffffff) | 0x40000000) >>> 0;
}

/** ComDiv.ValidateStockId. */
export function validateStockId(itemId: number): number {
  const s4 = getIdStatics(itemId, 4);
  return genStockId(s4 >= 7 && s4 <= 14 ? s4 : itemId);
}

/** ComDiv.IsStockId. */
export const isStockId = (objectId: bigint) => objectId >= 0x40000000n && objectId <= 0x40ffffffn;

export class ItemsModel {
  id = 0;
  name = "";
  category = 0;
  equip = 0;
  objectId = 0n;
  count = 0;

  constructor(id = 0, name = "", equip = 0, count = 0) {
    if (id) this.setItemId(id);
    this.name = name;
    this.equip = equip;
    this.count = count >>> 0;
  }

  setItemId(id: number): void {
    this.id = id;
    this.category = getItemCategory(id);
  }

  clone(): ItemsModel {
    const c = new ItemsModel();
    Object.assign(c, this);
    return c;
  }
}
