// Game meta packets: USER_ENTER pushes, inventory deltas, equip, shop buy.
// Parsers take a reader positioned after the opcode (PbConnection delivers S->C only, so opcodes
// that are also REQ numbers C->S — 1047 = ITEM_AUTH_REQ / GOODS_BUY_ACK — are unambiguous here).
// Called by GameClient / RoomClient; nothing here owns a socket.
import type { PbConnection } from "./connection.ts";
import { PacketReader, PacketWriter } from "./packet.ts";
import { readInvItemData, readItemRow, readPair, readRecord, readUserInfoBasic } from "./metaAuth.ts";
import {
  EQUIP_PAIRS, EquipSlot,
  type BuyResult, type CartGood, type CharaInfo, type CharaSlot, type EquipPair, type InvItemData,
  type InventoryDelta, type Loadout, type PlayerRecord, type UserInfoBasic, type WeaponLoadout,
} from "../lobby/types.ts";

export const GameMetaOp = {
  USER_ENTER_ACK: 2331,
  MYINFO_BASIC_ACK: 2371,
  INV_ITEM_DATA_ACK: 2395,
  POINT_CASH_ACK: 1061,
  MYINFO_RECORD_ACK: 2369,
  CHARA_INFO_ACK: 2453,
  CHANGE_INVENTORY_ACK: 3082,
  INVENTORY_GET_INFO_ACK: 3334,
  SHOP_DELETE_ITEM_ACK: 1059,
  CHAR_CREATE_CHARA_REQ: 6145,
  CHAR_CREATE_CHARA_ACK: 6146,
  CHAR_CHANGE_EQUIP_REQ: 6149,
  CHAR_CHANGE_EQUIP_ACK: 6150,
  CHAR_DELETE_CHARA_REQ: 6151,
  CHAR_DELETE_CHARA_ACK: 6152,
  SHOP_GET_SAILLIST_REQ: 1029,
  SHOP_GOODS_BUY_REQ: 1045,
  SHOP_GOODS_BUY_ACK: 1047,
  SHOP_GOODS_GIFT_REQ: 1048,
  SHOP_GOODS_GIFT_ACK: 1049,
  SHOP_AUTH_GIFT_REQ: 1056,
  SHOP_AUTH_GIFT_ACK: 1057,
  BATTLE_RESPAWN_REQ: 5137,
  BATTLE_RESPAWN_ACK: 5138,
} as const;

/** GOODS_BUY_ACK success code: the handler sends `new PROTOCOL_AUTH_SHOP_GOODS_BUY_ACK(1U, goods, player)`. */
export const BUY_OK = 1;

const zeroPair = (): EquipPair => ({ itemId: 0, objectId: 0 });

function readPairs(r: PacketReader, n: number): EquipPair[] {
  const out: EquipPair[] = [];
  for (let i = 0; i < n; i++) out.push(readPair(r));
  return out;
}

// ---- USER_ENTER pushes (G/PROTOCOL_BASE_USER_ENTER_REQ.cs, in this order after 2331)

/** 2371 PROTOCOL_BASE_GET_MYINFO_BASIC_ACK: USER_INFO_BASIC (185 bytes), no header. */
export function parseMyInfoBasic(r: PacketReader): UserInfoBasic {
  return readUserInfoBasic(r);
}

/** 2395 PROTOCOL_BASE_INV_ITEM_DATA_ACK: USER_INFO_INVITEM_DATA (81 bytes). */
export function parseInvItemData(r: PacketReader): InvItemData {
  return readInvItemData(r);
}

/** 2369 PROTOCOL_BASE_GET_MYINFO_RECORD_ACK: season (12 D) + total (12 D). */
export function parseMyInfoRecord(r: PacketReader): PlayerRecord {
  return readRecord(r);
}

/** 2453 PROTOCOL_BASE_GET_CHARA_INFO_ACK: `H0, H n, n×{C slot, C 20, D itemId, D objId}, 18 pairs`. */
export function parseCharaInfo(r: PacketReader): CharaInfo {
  r.readH();
  const n = r.readH();
  const charas: CharaSlot[] = [];
  for (let i = 0; i < n; i++) {
    const slot = r.readC();
    r.readC(); // 20
    charas.push({ slot, itemId: r.readD(), objectId: r.readD() });
  }
  return { charas, equip: readPairs(r, EQUIP_PAIRS) };
}

/**
 * 3082 PROTOCOL_SERVER_MESSAGE_CHANGE_INVENTORY_ACK:
 * `H0, C 6, 6 emote pairs, C n, n×D charaSlot, C0, accessory pair, C0, H0, H0, 18 pairs, C 3, dino, spray, namecard`.
 * Sent on USER_ENTER, after 1050 (single equip) and when equipment is revalidated in a room;
 * **not** after 6149 (that handler only answers 6150).
 * equip[8] = CharaRedId in the lobby (room: the costume of the slot's team). charaSlots lists the red
 * then the blue slot, each only if that character exists.
 */
export function parseChangeInventory(r: PacketReader): Loadout {
  r.readH();
  const emoticons = readPairs(r, r.readC());
  const charaSlots: number[] = [];
  for (let n = r.readC(), i = 0; i < n; i++) charaSlots.push(r.readD());
  r.readC();
  const accessory = readPair(r);
  r.skip(1 + 2 + 2);
  const equip = readPairs(r, EQUIP_PAIRS);
  const extra = readPairs(r, r.readC());
  return { emoticons, charaSlots, accessory, equip, dino: extra[0] ?? zeroPair(), spray: extra[1] ?? zeroPair(), namecard: extra[2] ?? zeroPair() };
}

/** 3334 PROTOCOL_INVENTORY_GET_INFO_ACK: `H0, H invTotal, H n, n×row, C changeType`. One per bought good. */
export function parseInventoryGetInfo(r: PacketReader): InventoryDelta {
  r.readH();
  const inventoryTotal = r.readH();
  const n = r.readH();
  const items = [];
  for (let i = 0; i < n; i++) items.push(readItemRow(r));
  return { inventoryTotal, items, changeType: r.readC() };
}

/** 1059 PROTOCOL_AUTH_SHOP_DELETE_ITEM_ACK: `D err, D objId`. err 1 = deleted (objId valid only then). */
export function parseDeleteItem(r: PacketReader): { code: number; ok: boolean; objectId: number } {
  const code = r.readD();
  const objectId = r.readD();
  return { code, ok: code === 1, objectId: code === 1 ? objectId : 0 };
}

/** 6150 PROTOCOL_CHAR_CHANGE_EQUIP_ACK: `D err, H0`. The handler always answers 0 (validation is silent). */
export function parseCharChangeEquip(r: PacketReader): { error: number } {
  return { error: r.readD() };
}

/** 6146 PROTOCOL_CHAR_CREATE_CHARA_ACK: the character the server just gave a player_characters slot. */
export interface CreateCharaAck {
  /** 0 = created; 0x80001017 good not found, 0x80001018 no money, 0x80001019 DB, 0x800010B9 full, 0x80000000 INSERT failed */
  error: number;
  /** 1 = answer to a 6145; 3 = pushed by AllUtils.CreateCharacter (1045 buy, gift, event) */
  kind: number;
  slot: number;
  itemId: number;
  /** player_items object_id (0 when the item is not in the inventory) */
  objectId: number;
  /** the 18 pairs of the account's equipment with [8] = the new character */
  equip: EquipPair[];
  cash: number;
  gold: number;
}

/**
 * 6146 PROTOCOL_CHAR_CREATE_CHARA_ACK: `H0, D err` and, when err == 0,
 * `C0, 18 pairs, D cash, D gold, C kind, C 20, C slot, C 1`. Sent after a 6145 (kind 1) **and** by the server's
 * CreateCharacter (kind 3) when a 1045 buy delivers a character; neither is followed by a 2453, so this is
 * the only place the client learns the new slot.
 */
export function parseCreateChara(r: PacketReader): CreateCharaAck {
  r.readH();
  const error = r.readD();
  if (error !== 0) return { error, kind: 0, slot: -1, itemId: 0, objectId: 0, equip: [], cash: 0, gold: 0 };
  r.readC();
  const equip = readPairs(r, EQUIP_PAIRS);
  const cash = r.readD();
  const gold = r.readD();
  const kind = r.readC();
  r.readC(); // 20
  const slot = r.readC();
  return { error, kind, slot, itemId: equip[EquipSlot.Chara].itemId, objectId: equip[EquipSlot.Chara].objectId, equip, cash, gold };
}

/** 6152 PROTOCOL_CHAR_DELETE_CHARA_ACK: `D err` + (err == 0) `C slot, D objId[, D team slot]`; a 2453 follows. */
export function parseDeleteChara(r: PacketReader): { error: number; slot: number; objectId: number } {
  const error = r.readD();
  if (error !== 0) return { error, slot: -1, objectId: 0 };
  return { error, slot: r.readC(), objectId: r.readD() };
}

/**
 * 1047 PROTOCOL_AUTH_SHOP_GOODS_BUY_ACK. Both branches have the same shape:
 * ok   `H0, C n, n×{D0, D goodId, C0}, D0, D gold, D cash, D yyMMddHHmm`
 * fail `H0, C 1, {D0, D0, C0}, D0, D gold, D cash, D errorCode`
 * The last dword alone cannot tell them apart (dates like 2609271530 and 0x800010xx errors overlap in
 * range), so a result is ok only when every entry carries a goodId. Callers that know the cart pass it.
 */
export function parseGoodsBuy(r: PacketReader, cart?: CartGood[]): BuyResult {
  r.readH();
  const n = r.readC();
  const goodIds: number[] = [];
  for (let i = 0; i < n; i++) {
    r.readD();
    goodIds.push(r.readD());
    r.readC();
  }
  r.readD();
  const gold = r.readD();
  const cash = r.readD();
  const last = r.readD();
  let ok = n > 0 && goodIds.every((g) => g !== 0);
  if (ok && cart) ok = cart.every((c) => goodIds.includes(c.goodId));
  return { ok, code: ok ? BUY_OK : last, goodIds: ok ? goodIds : [], gold, cash, time: ok ? last : 0 };
}

/** 5138 PROTOCOL_BATTLE_RESPAWN_ACK (broadcast to the room): slot, spawns and the equipment the server settled on. */
export interface RespawnAck {
  slot: number;
  roomSpawns: number;
  slotSpawns: number;
  weapons: WeaponLoadout;
  /** character of the slot's (costume) team: server Field4 = Equipment.CharaRedId / CharaBlueId */
  chara: number;
  parts: number[]; // head, face, jacket, pocket, glove, belt, holster, skin
  beret: number;
  /** null when the frame arrived truncated (broadcast, see parseRespawnAck). */
  accessory: number | null;
}
export function parseRespawnAck(r: PacketReader): RespawnAck {
  const slot = r.readD();
  const roomSpawns = r.readD();
  const slotSpawns = r.readD();
  const weapons = { primary: r.readD(), secondary: r.readD(), melee: r.readD(), grenade: r.readD(), special: r.readD() };
  r.skip(12 + 8); // 3×D0, "64 64 64 64 64 00 00 00"
  const chara = r.readD(); // Field4: CharaRedId (FR) / CharaBlueId (CT), RoomModel.ValidateTeam(Team, CostumeTeam)
  const parts: number[] = [];
  for (let i = 0; i < 8; i++) parts.push(r.readD());
  const beret = r.readD();
  // 5138 goes out via room.SendPacketToPlayers (GetCompleteBytes): FrameDecoder drops its last 2 bytes,
  // so the accessory dword arrives with only its low half.
  return { slot, roomSpawns, slotSpawns, weapons, chara, parts, beret, accessory: r.remaining >= 4 ? r.readD() : null };
}

// ---- builders

/**
 * 1029 PROTOCOL_SHOP_GET_SAILLIST_REQ: `S[32]` hash of the client's Data/Raws/Shop.dat. The first 1029
 * of a session triggers the whole catalog (ShopCatalog121Sender), then 1106, (1103), 1030.
 */
export function buildShopGetSailList(shopDatHash = ""): PacketWriter {
  return new PacketWriter(32).writeS(shopDatHash, 32);
}

/**
 * 1045 PROTOCOL_AUTH_SHOP_GOODS_BUY_REQ: `C n, n×{C, D goodId, C buyType, C, Q}`.
 * The server reads and ignores the two C and the Q; the original client's values are not known
 * (no RE yet), so they go as 0 **[RECRIADO]**.
 */
export function buildGoodsBuy(cart: CartGood[]): PacketWriter {
  const w = new PacketWriter(1 + cart.length * 15).writeC(cart.length);
  for (const g of cart) w.writeC(0).writeD(g.goodId).writeC(g.buyType).writeC(0).writeQ(0n);
  return w;
}

/**
 * 6145 PROTOCOL_CHAR_CREATE_CHARA_REQ: `C, C len, U name, C, D goodId, C buyType, C` (G/PROTOCOL_CHAR_CREATE_CHARA_REQ.Read).
 * How the original buys a character good: the server charges, delivers the item (3334), creates the
 * player_characters row with `slot = Characters.Count` and answers 6146. The three C the server ignores go
 * as 0 **[RECRIADO]**. Only for a character the account does not have yet: the handler does not check, so a
 * second 6145 for an owned character adds a second row with the same id.
 */
export function buildCreateChara(goodId: number, buyType: number, name: string): PacketWriter {
  const nm = name.slice(0, 32);
  return new PacketWriter(10 + nm.length * 2).writeC(0).writeC(nm.length).writeU(nm, nm.length * 2).writeC(0).writeD(goodId).writeC(buyType).writeC(0);
}

/** 6151 PROTOCOL_CHAR_DELETE_CHARA_REQ: `C slot`. Deletes the character **and** its item; the slots are re-packed. */
export function buildDeleteChara(slot: number): PacketWriter {
  return new PacketWriter(1).writeC(slot);
}

export interface CharChangeEquipRequest {
  emoticons?: EquipPair[]; // ≤ 6
  emoticonsChanged?: boolean;
  accessory?: EquipPair;
  accessoryChanged?: boolean;
  couponsDisable?: number[]; // ≤ 39 itemIds
  couponsEnable?: number[]; // ≤ 39 itemIds
  /** 18 pairs (EquipSlot). Server reads [0..4] weapons, [8] chara, [9..16] parts, [17] beret. */
  equip?: EquipPair[];
  equipChanged?: boolean;
  /** dino, spray, namecard */
  items3?: EquipPair[];
  items3Changed?: boolean;
  /** player_characters.slot of red and blue (ValidateCharacterSlot always runs). */
  charaSlots: [number, number];
}

/**
 * 6149 PROTOCOL_CHAR_CHANGE_EQUIP_REQ, layout of G/CharChangeEquip121Parser.ParseBody (which rejects
 * trailing bytes). Byte values the server ignores — the S2_CHAR_CHANGE_EQUIP_INFO flag and the two H
 * markers after the coupon arrays — go as 0 **[RECRIADO]** (original values not RE'd).
 * With equipChanged the server re-applies weapon/part slots only for itemIds in the inventory, sets
 * the beret to equip[17] as sent (0 unequips), and reassigns equip[8] only if it is a character whose
 * player_characters.slot matches charaSlots[side].
 */
export function buildCharChangeEquip(q: CharChangeEquipRequest): PacketWriter {
  const w = new PacketWriter(256);
  const pairs = (list: EquipPair[], max: number) => {
    if (list.length > max) throw new RangeError(`6149: ${list.length} > ${max}`);
    w.writeC(list.length);
    for (const p of list) w.writeD(p.itemId).writeD(p.objectId);
  };
  const dwords = (list: number[]) => {
    if (list.length > 39) throw new RangeError("6149: coupon list > 39");
    w.writeC(list.length);
    for (const v of list) w.writeD(v);
  };
  pairs(q.emoticons ?? [], 6);
  w.writeC(q.emoticonsChanged ? 1 : 0);
  const acc = q.accessory ?? zeroPair();
  w.writeD(acc.itemId).writeD(acc.objectId).writeC(q.accessoryChanged ? 1 : 0);
  dwords(q.couponsDisable ?? []);
  w.writeH(0);
  dwords(q.couponsEnable ?? []);
  w.writeH(0);
  const equip = q.equip ?? [];
  if (equip.length > EQUIP_PAIRS) throw new RangeError("6149: equip > 18 pairs");
  w.writeC(0);
  for (let i = 0; i < EQUIP_PAIRS; i++) {
    const p = equip[i] ?? zeroPair();
    w.writeD(p.itemId).writeD(p.objectId);
  }
  w.writeC(q.equipChanged ? 1 : 0);
  pairs(q.items3 ?? [], 3);
  w.writeC(q.items3Changed ? 1 : 0);
  w.writeC(2).writeC(q.charaSlots[0]).writeC(q.charaSlots[1]);
  return w;
}

/**
 * 6149 slot value that leaves a side untouched: ValidateCharacterSlot does
 * `GetCharacterSlot(slot) != null && Id != current` and no character has slot 255.
 */
export const KEEP_CHARA_SLOT = 0xff;

/**
 * Characters whose Auth 2453 objectId is a stock id (ComDiv.IsStockId, 0x40000000..0x40FFFFFF): their
 * player_characters INSERT failed, so the Game will recreate them on USER_ENTER
 * with `slot = Characters.Count` and may duplicate a slot.
 */
export function unsavedCharas(info: CharaInfo): CharaSlot[] {
  return info.charas.filter((c) => c.objectId >= 0x40000000 && c.objectId <= 0x40ffffff);
}

/**
 * 6149 that changes only weapon/part/beret slots, keeping the character and slots of the current loadout.
 * `set` replaces pairs by EquipSlot index; objectId 0 is fine (the server resolves by itemId).
 * Pass the Game 2453 as `charas`: a slot shared by two characters resolves to the first one in the server
 * list (GetCharacterSlot), not necessarily the equipped one, so such a side is sent as KEEP_CHARA_SLOT.
 * Without 2453, or when 3082 did not list both sides, both sides are sent as KEEP_CHARA_SLOT.
 */
export function equipRequestFromLoadout(current: Loadout, set: Partial<Record<number, EquipPair>>, charas?: CharaInfo): CharChangeEquipRequest {
  const equip = current.equip.map((p, i) => set[i] ?? p);
  for (const i of [5, 6, 7]) equip[i] = zeroPair();
  const safe = (slot: number) => (charas && charas.charas.filter((c) => c.slot === slot).length === 1 ? slot : KEEP_CHARA_SLOT);
  const [red, blue] = current.charaSlots;
  return {
    equip,
    equipChanged: true,
    charaSlots: current.charaSlots.length === 2 ? [safe(red), safe(blue)] : [KEEP_CHARA_SLOT, KEEP_CHARA_SLOT],
  };
}

export function weaponsOf(equip: EquipPair[]): WeaponLoadout {
  return {
    primary: equip[EquipSlot.Primary]?.itemId ?? 0,
    secondary: equip[EquipSlot.Secondary]?.itemId ?? 0,
    melee: equip[EquipSlot.Melee]?.itemId ?? 0,
    grenade: equip[EquipSlot.Throw]?.itemId ?? 0,
    special: equip[EquipSlot.Special]?.itemId ?? 0,
  };
}

/**
 * 5137 PROTOCOL_BATTLE_RESPAWN_REQ body (154 bytes, G/PROTOCOL_BATTLE_RESPAWN_REQ.Read): the same 18
 * pairs as 6149 with `H weaponsFlag` between pair 17 and a 19th pair (accessory). The server reads the
 * itemId of pairs [0..4], [8] (chara or dino), [9..17] and the accessory; pairs 5-7 are skipped.
 * A zero weapon is NOT: ComDiv.CheckEquipedItems replaces any weapon not found
 * in the inventory with the default (103004 / 202022 / ...), so send the real itemIds.
 */
export function buildRespawnBody(equip: EquipPair[], weaponsFlag: number, accessory: EquipPair = zeroPair()): PacketWriter {
  const w = new PacketWriter(160);
  for (let i = 0; i < EQUIP_PAIRS; i++) {
    const p = i >= 5 && i <= 7 ? zeroPair() : equip[i] ?? zeroPair();
    w.writeD(p.itemId).writeD(p.objectId);
  }
  return w.writeH(weaponsFlag & 0xffff).writeD(accessory.itemId).writeD(accessory.objectId);
}

// ---- helpers for GameClient

export interface EnterPushes {
  basic?: UserInfoBasic;
  invItem?: InvItemData;
  wallet?: { gold: number; cash: number; tags: number };
  record?: PlayerRecord;
  charaInfo?: CharaInfo;
  loadout?: Loadout;
}

/**
 * Collects the pushes that follow USER_ENTER_ACK. Arm it BEFORE sending USER_ENTER_REQ; `done`
 * resolves on 3082 (the last push) or after timeoutMs with whatever arrived.
 */
export function collectEnterPushes(conn: PbConnection, timeoutMs = 5000): { state: EnterPushes; done: Promise<EnterPushes>; stop: () => void } {
  const state: EnterPushes = {};
  let stop = () => {};
  const done = new Promise<EnterPushes>((resolve) => {
    const t = setTimeout(() => { off(); resolve(state); }, timeoutMs);
    const off = conn.on((op, r) => {
      switch (op) {
        case GameMetaOp.MYINFO_BASIC_ACK: state.basic = parseMyInfoBasic(r); break;
        case GameMetaOp.INV_ITEM_DATA_ACK: state.invItem = parseInvItemData(r); break;
        case GameMetaOp.POINT_CASH_ACK: { const e = r.readD(); if (e === 0) state.wallet = { cash: r.readD(), gold: r.readD(), tags: r.readD() }; break; }
        case GameMetaOp.MYINFO_RECORD_ACK: state.record = parseMyInfoRecord(r); break;
        case GameMetaOp.CHARA_INFO_ACK: state.charaInfo = parseCharaInfo(r); break;
        case GameMetaOp.CHANGE_INVENTORY_ACK:
          state.loadout = parseChangeInventory(r);
          clearTimeout(t); off(); resolve(state);
          break;
      }
    });
    stop = () => { clearTimeout(t); off(); resolve(state); };
  });
  return { state, done, stop: () => stop() };
}

/**
 * 1045 -> (3334 per delivered good) -> 1047. Character goods (class 6) create a character instead of
 * a 3334 (AllUtils.CreateCharacter), so `deltas` can be shorter than the cart.
 */
export async function buyGoods(conn: PbConnection, cart: CartGood[], timeoutMs = 5000): Promise<{ result: BuyResult; deltas: InventoryDelta[] }> {
  const deltas: InventoryDelta[] = [];
  const off = conn.on((op, r) => { if (op === GameMetaOp.INVENTORY_GET_INFO_ACK) deltas.push(parseInventoryGetInfo(r)); });
  try {
    const ack = conn.waitFor(GameMetaOp.SHOP_GOODS_BUY_ACK, timeoutMs);
    conn.send(GameMetaOp.SHOP_GOODS_BUY_REQ, buildGoodsBuy(cart));
    return { result: parseGoodsBuy(await ack, cart), deltas };
  } finally {
    off();
  }
}

/**
 * 1048 PROTOCOL_AUTH_SHOP_GOODS_GIFT_REQ: the 1045 cart, then `C len, U text` and `C len, U nick` (the server's Field0 is
 * the text, Field1 the receiver). The text goes empty: the Cross gift popup has no message box (shopGift* map).
 */
export function buildGoodsGift(cart: CartGood[], nick: string, text = ""): PacketWriter {
  const w = buildGoodsBuy(cart);
  return w.writeC(text.length).writeU(text, text.length * 2).writeC(nick.length).writeU(nick, nick.length * 2);
}

/** 1049 PROTOCOL_AUTH_SHOP_GOODS_GIFT_ACK (success): `H0, C n, n×{D0, D goodId, C0}, D cash, D gold, D time` (cash first). */
function parseGoodsGiftAck(r: PacketReader): BuyResult {
  r.readH();
  const n = r.readC(), goodIds: number[] = [];
  for (let i = 0; i < n; i++) { r.readD(); goodIds.push(r.readD()); r.readC(); }
  const cash = r.readD(), gold = r.readD(), time = r.readD();
  return { ok: true, code: BUY_OK, goodIds, gold, cash, time };
}

/**
 * 1048 -> 1049 (ok) or 1047 (failure, the buy's shape). No answer in time = 0x80000000, as the other requests.
 */
export function giftGoods(conn: PbConnection, cart: CartGood[], nick: string, text = "", timeoutMs = 5000): Promise<BuyResult> {
  return new Promise((resolve) => {
    const finish = (res: BuyResult) => { clearTimeout(timer); off(); resolve(res); };
    const timer = setTimeout(() => finish({ ok: false, code: 0x80000000, goodIds: [], gold: 0, cash: 0, time: 0 }), timeoutMs);
    const off = conn.on((op, r) => {
      if (op === GameMetaOp.SHOP_GOODS_GIFT_ACK) finish(parseGoodsGiftAck(r));
      else if (op === GameMetaOp.SHOP_GOODS_BUY_ACK) finish(parseGoodsBuy(r, cart));
    });
    conn.send(GameMetaOp.SHOP_GOODS_GIFT_REQ, buildGoodsGift(cart, nick, text));
  });
}

/**
 * 1056 PROTOCOL_AUTH_SHOP_AUTH_GIFT_REQ: `D objectId` of a gift note (the server reads ReadUD). Answers 1057 `D code` (1 =
 * the item is in the inventory, the inventory delta comes with it). Resolves with the code; 0x80000000 without an answer.
 */
export async function acceptGift(conn: PbConnection, objectId: number, timeoutMs = 5000): Promise<number> {
  const ack = conn.waitFor(GameMetaOp.SHOP_AUTH_GIFT_ACK, timeoutMs).then((r) => r.readD(), () => 0x80000000);
  conn.send(GameMetaOp.SHOP_AUTH_GIFT_REQ, new PacketWriter(4).writeD(objectId));
  return ack;
}

export async function changeEquip(conn: PbConnection, q: CharChangeEquipRequest, timeoutMs = 5000): Promise<number> {
  const ack = conn.waitFor(GameMetaOp.CHAR_CHANGE_EQUIP_ACK, timeoutMs);
  conn.send(GameMetaOp.CHAR_CHANGE_EQUIP_REQ, buildCharChangeEquip(q));
  return parseCharChangeEquip(await ack).error;
}

/**
 * 6145 -> (3334) -> 6146. Resolves with the parsed 6146 (error != 0 when the server refused; the wallet is
 * not in a failed 6146, ask 1060).
 */
export async function createChara(conn: PbConnection, goodId: number, buyType: number, name: string, timeoutMs = 5000): Promise<CreateCharaAck> {
  const ack = conn.waitFor(GameMetaOp.CHAR_CREATE_CHARA_ACK, timeoutMs);
  conn.send(GameMetaOp.CHAR_CREATE_CHARA_REQ, buildCreateChara(goodId, buyType, name));
  return parseCreateChara(await ack);
}
