// Shared lobby/meta types. Other workstreams
// only import from here. Every field mirrors a server writer; the source is noted per type.
// Parsers live in src/net/metaAuth.ts, src/net/metaGame.ts and src/net/shopCatalog.ts.

/** Plugin.Core/Enums/ItemEquipType.cs */
export const ItemEquipType = {
  /** count = quantity or seconds; becomes Temporary once activated */
  Durable: 1,
  /** count = expiry as yyMMddHHmm */
  Temporary: 2,
  Permanent: 3,
  CafePC: 4,
} as const;

/** Wire row `{D objectId, D itemId, C equip, D count}` (2319, 3334). */
export interface InventoryItem {
  objectId: number;
  itemId: number;
  equip: number; // ItemEquipType
  count: number;
}

/** 3334 changeType (PROTOCOL_INVENTORY_GET_INFO_ACK ctor arg). */
export const InventoryChangeType = {
  Add: 0,
  Update: 1,
  Repair: 2,
} as const;

export interface InventoryDelta {
  /** Items.Count of the server-side inventory after the change (includes in-memory basics). */
  inventoryTotal: number;
  items: InventoryItem[];
  changeType: number; // InventoryChangeType
}

/** 2319 PROTOCOL_BASE_GET_INVEN_INFO_ACK (Auth). */
export interface InventoryPage {
  error: number;
  items: InventoryItem[];
  /** TemplatePackXML.Basics.Count (+ PC-cafe rewards). */
  basicCount: number;
}

/** 1061 PROTOCOL_AUTH_GET_POINT_CASH_ACK (Auth and Game). */
export interface Wallet {
  gold: number;
  cash: number;
  tags: number;
}

/** {D itemId, D objectId}; objectId 0 = item not in the inventory (EquipmentDataChara). */
export interface EquipPair {
  itemId: number;
  objectId: number;
}

/**
 * The 18-pair S2_CHAR_CHANGE_EQUIP_INFO block shared by 2453, 3082 and 6149 (index = pair position).
 * Indices 5, 6, 7 are never read or written by the server (CharChangeEquip121Request.CopyToLegacyFields,
 * GET_CHARA_INFO_ACK, CHANGE_INVENTORY_ACK): send {0,0}.
 */
export const EquipSlot = {
  Primary: 0,
  Secondary: 1,
  Melee: 2,
  Throw: 3,
  Special: 4,
  /** 3082: CharaRedId (lobby) or the team costume (room). 6149: the character to (re)assign. */
  Chara: 8,
  Head: 9,
  Face: 10,
  Jacket: 11,
  Pocket: 12,
  Glove: 13,
  Belt: 14,
  Holster: 15,
  Skin: 16,
  Beret: 17,
} as const;
export const EQUIP_PAIRS = 18;

/** One player_characters row as sent in 2453: `C slot, C 20, D itemId, D objectId`. */
export interface CharaSlot {
  slot: number;
  itemId: number;
  objectId: number;
}

/** 2453 PROTOCOL_BASE_GET_CHARA_INFO_ACK (Game; Auth pushes its own 2453 after 2316). */
export interface CharaInfo {
  charas: CharaSlot[];
  /** 18 pairs, see EquipSlot. */
  equip: EquipPair[];
}

/** 3082 PROTOCOL_SERVER_MESSAGE_CHANGE_INVENTORY_ACK: the full loadout. */
export interface Loadout {
  emoticons: EquipPair[]; // 6
  /** player_characters.slot of the red and blue characters (only those that exist). */
  charaSlots: number[];
  accessory: EquipPair;
  /** 18 pairs, see EquipSlot. */
  equip: EquipPair[];
  dino: EquipPair;
  spray: EquipPair;
  namecard: EquipPair;
}

/** Weapon itemIds by slot, as feeds WeaponSystem/RESPAWN. */
export interface WeaponLoadout {
  primary: number;
  secondary: number;
  melee: number;
  grenade: number;
  special: number;
}

/** 2369 PROTOCOL_BASE_GET_MYINFO_RECORD_ACK and USER_INFO_RECORD in 2317 (same 12 dwords, ×2). */
export interface RecordStats {
  matches: number;
  wins: number;
  loses: number;
  draws: number;
  kills: number;
  headshots: number;
  deaths: number;
  totalMatches: number;
  totalKills: number;
  escapes: number;
  assists: number;
  mvp: number;
}
export interface PlayerRecord {
  season: RecordStats;
  total: RecordStats;
}

/** USER_INFO_BASIC (185 bytes): 2371 body and block 47 of 2317. */
export interface UserInfoBasic {
  nickname: string;
  /** GetDisplayRank() */
  rank: number;
  /** GetRank() high-water */
  rankHigh: number;
  gold: number;
  exp: bigint;
  tags: number;
  inventoryPlus: number;
  cash: number;
  clanId: number;
  clanAccess: number;
  cafePC: number;
  clanName: string;
  clanRank: number;
  clanUnit: number;
  clanLogo: number;
  clanNameColor: number;
  clanEffect: number;
}

/** USER_INFO_INVITEM_DATA (81 bytes): 2395 body and block 45 of 2317. */
export interface InvItemData {
  tag: number;
  nickColor: number;
  fakeRank: number;
  fakeNick: string;
  crosshairColor: number;
  muzzleColor: number;
  nickBorderColor: number;
}

/** 2317 PROTOCOL_BASE_GET_USER_INFO_ACK (Auth), the fields the web uses. */
export interface UserInfo {
  error: number;
  basic: UserInfoBasic | null;
  record: PlayerRecord | null;
  invItem: InvItemData | null;
  /** S2_MULTI_SLOT_INFO: player_characters.slot of red/blue + dino/spray/namecard pairs. */
  redSlot: number;
  blueSlot: number;
  dino: EquipPair;
  spray: EquipPair;
  namecard: EquipPair;
  pointUp: number;
  expUp: number;
  age: number;
  /** QUESTING_INFO (89 bytes): mission card slots, parsed by net/missionClient.ts */
  questing?: Uint8Array;
}

/** 1047 PROTOCOL_AUTH_SHOP_GOODS_BUY_ACK. */
export interface BuyResult {
  ok: boolean;
  /** 1 on success (the server's SUCCESS for this ACK), else the EventErrorEnum code. */
  code: number;
  goodIds: number[];
  gold: number;
  cash: number;
  /** yyMMddHHmm on success. */
  time: number;
}

/** 1045 cart entry. Plugin.Core ShopManager.TryApplyCartPrice: 1 = cash, 2 = gold. */
export const BuyType = {
  Cash: 1,
  Gold: 2,
} as const;
export interface CartGood {
  goodId: number;
  buyType: number; // BuyType
}

/** ShopManager.WriteGoodsRecord210 option: 17-byte stride at record+6, 12 options. */
export interface GoodsOption {
  gold: number;
  cash: number;
  code: number;
}
/**
 * 1037 PACKED_GOODSLIST record (210 bytes). The record has no itemId: it comes from the 1042 matching
 * list (goodId -> itemId, count). goodId is NOT always itemId*100+variant (live: good 170002701 ->
 * items 1701027 / 1703027 / 1707027 / 1730027 for the 4 durations).
 */
export interface ShopGood {
  goodId: number;
  /** from 1042; 0 when the good has no matching row */
  itemId: number;
  /** from 1042 (quantity or seconds, see ItemEquipType.Durable); 0 when unknown */
  count: number;
  /** Visibility == 4 ? 4 : 1 */
  visibility: number;
  priceGold: number;
  priceCash: number;
  /** system_shop.shop_tag (option0.code, +22) */
  tag: number;
  options: GoodsOption[];
}
/** 1039 ITEMLIST record (11 bytes). Carries no name: names are client-side data (.pef). */
export interface ShopItem {
  itemId: number;
  authType: number;
  buyType2: number;
  buyType3: number;
  title: number;
  titleFlag: number;
}
/** 1075 REPAIRLIST record (16 bytes). */
export interface ShopRepair {
  itemId: number;
  pointPerUnit: number;
  cashPerUnit: number;
  quantity: number;
}
/** 1042 PACKED_MATCHINGLIST record (16 bytes): goodId -> itemId + count. */
export interface ShopMatching {
  goodId: number;
  itemId: number;
  count: number;
}
