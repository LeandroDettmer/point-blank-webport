// Glue between a Game PbConnection and the stores. Listens to the meta pushes and turns the
// screens' intents into the request sequences:
//   equip weapon/part/beret  6149 -> 6150 
//   team character           6149 -> 6150  (only characters whose 2453 slot is unique)
// activate Durable 1050 -> 1051 + 6150
//   buy                      1045 -> 3334... -> 1047
//   buy a new character      6145 -> 3334 -> 6146 (CREATE_CHARA: the slot comes in 6146, no 2453 follows)
//   delete a character       6151 -> 6152 + 2453
// The loadout is updated only after 6150 (server truth; 6149 never gets a 3082, see PlayerStore.applyEquipRequest).
import type { PbConnection } from "../../net/connection.ts";
import {
  GameMetaOp, acceptGift, buildDeleteChara, buyGoods, changeEquip, createChara, equipRequestFromLoadout, giftGoods, parseChangeInventory, parseCharaInfo,
  parseCreateChara, parseDeleteChara, parseDeleteItem, parseInvItemData, parseInventoryGetInfo, parseMyInfoBasic, parseMyInfoRecord, type CharChangeEquipRequest,
} from "../../net/metaGame.ts";
import { buildGetPointCash, parsePointCash } from "../../net/metaAuth.ts";
import { PacketWriter } from "../../net/packet.ts";
import { BuyType, EquipSlot, type BuyResult, type CartGood, type InventoryItem } from "../types.ts";
import { PlayerStore, hasItemId } from "./PlayerStore.ts";
import { ShopStore } from "./ShopStore.ts";
import { LobbyStore } from "./LobbyStore.ts";
import { SingleEquipOp, equipSingle, parseItemAuth, useItemArg, useItemStr } from "./singleEquip.ts";
import { type InspectResult, useInspector, useItemByte } from "./itemUse.ts";
import { chat } from "../../net/chatClient.ts";
import { ItemClass, charaTeamOf, countIsSeconds, equipSlotOf, itemClass } from "./itemInfo.ts";
import { itemName } from "./itemNames.ts";

/** STBL_IDX_ERROR_WRONG_CHARA (String_Brazil.lua) */
const WRONG_CHARA = "Personagem errado.";

/** Opcodes the original client sends when opening/closing the screens (IMPL server-side: slot state only). */
export const ScreenOp = {
  SHOP_ENTER_REQ: 1025, SHOP_LEAVE_REQ: 1027, INVENTORY_ENTER_REQ: 3329, INVENTORY_LEAVE_REQ: 3331, GET_POINT_CASH_REQ: 1060,
  /** PROTOCOL_ROOM_INFO_ENTER/LEAVE_REQ = the Perfil screen [INFERIDO: the C# throttles them with LastProfileEnter/Leave] */
  ROOM_INFO_ENTER_REQ: 3672, ROOM_INFO_LEAVE_REQ: 3674,
} as const;

/** Pushes of the nickname / clan name items: C# PROTOCOL_AUTH_CHANGE_NICKNAME_ACK 1836, PROTOCOL_CS_REPLACE_NAME_RESULT_ACK 864 */
export const NameOp = { CHANGE_NICKNAME_ACK: 1836, REPLACE_CLAN_NAME_ACK: 864 } as const;

export class MetaError extends Error {
  readonly code: number;
  constructor(msg: string, code = 0) { super(msg); this.code = code; }
}

export const Side = { Red: 0, Blue: 1 } as const;

export class MetaSession {
  readonly player: PlayerStore;
  readonly shop: ShopStore;
  readonly lobby: LobbyStore;
  private conn: PbConnection | null = null;
  private off: (() => void) | null = null;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(player = new PlayerStore(), shop = new ShopStore(), lobby = new LobbyStore()) {
    this.player = player;
    this.shop = shop;
    this.lobby = lobby;
  }

  get connection(): PbConnection | null { return this.conn; }

  /** Starts listening on the Game connection (call after USER_ENTER pushes were collected and dispatched). */
  attach(conn: PbConnection): void {
    this.detach();
    this.conn = conn;
    this.off = conn.on((op, r) => {
      switch (op) {
        case GameMetaOp.INVENTORY_GET_INFO_ACK: this.player.dispatch({ type: "inventoryDelta", delta: parseInventoryGetInfo(r) }); break;
        case GameMetaOp.SHOP_DELETE_ITEM_ACK: { const d = parseDeleteItem(r); if (d.ok) this.player.dispatch({ type: "itemDeleted", objectId: d.objectId }); break; }
        case GameMetaOp.POINT_CASH_ACK: { const w = parsePointCash(r); if (w.error === 0) this.player.dispatch({ type: "wallet", wallet: { gold: w.gold, cash: w.cash, tags: w.tags } }); break; }
        case GameMetaOp.CHANGE_INVENTORY_ACK: this.player.dispatch({ type: "loadout", loadout: parseChangeInventory(r) }); break;
        case GameMetaOp.CHARA_INFO_ACK: this.player.dispatch({ type: "charaInfo", info: parseCharaInfo(r) }); break;
        // 6146 answers our 6145 and is also pushed by the 1045 buy of a character (AllUtils.CreateCharacter)
        case GameMetaOp.CHAR_CREATE_CHARA_ACK: this.player.dispatch({ type: "charaCreated", ack: parseCreateChara(r) }); break;
        case GameMetaOp.MYINFO_BASIC_ACK: this.player.dispatch({ type: "profile", basic: parseMyInfoBasic(r) }); break;
        // 2395 is pushed again after a 1052 of nick colour / fake rank / crosshair / muzzle / border (server handleUseItem)
        case GameMetaOp.INV_ITEM_DATA_ACK: this.player.dispatch({ type: "invItem", data: parseInvItemData(r) }); break;
        case GameMetaOp.MYINFO_RECORD_ACK: this.player.dispatch({ type: "record", record: parseMyInfoRecord(r) }); break;
        case SingleEquipOp.ITEM_AUTH_ACK: { const a = parseItemAuth(r); if (a.item) this.player.dispatch({ type: "itemAuth", item: a.item }); break; }
        // 1836 = my nick changed (C len, U len*2): the lobby profile and the chat own nick; 864 = the clan name (U34)
        case NameOp.CHANGE_NICKNAME_ACK: { const n = r.readC(); this.renameSelf(r.readU(n * 2)); break; }
        case NameOp.REPLACE_CLAN_NAME_ACK: this.renameClan(r.readU(34)); break;
      }
    });
  }

  detach(): void {
    this.off?.();
    this.off = null;
    this.conn = null;
  }

  private need(): PbConnection {
    if (!this.conn || !this.conn.isOpen) throw new MetaError("Sem conexão com o servidor de jogo.");
    return this.conn;
  }

  // one meta request at a time (the server answers 6150/1047 without a request id)
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.busy.then(fn, fn);
    this.busy = p.catch(() => {});
    return p;
  }

  /** Fire-and-forget screen open/close notifications, as the original client sends them. */
  notifyScreen(which: "shop" | "inventory" | "info", open: boolean): void {
    const c = this.conn;
    if (!c?.isOpen) return;
    try {
      if (which === "shop") c.send(open ? ScreenOp.SHOP_ENTER_REQ : ScreenOp.SHOP_LEAVE_REQ, open ? new PacketWriter(32).writeS("", 32) : undefined);
      else if (which === "info") c.send(open ? ScreenOp.ROOM_INFO_ENTER_REQ : ScreenOp.ROOM_INFO_LEAVE_REQ);
      else c.send(open ? ScreenOp.INVENTORY_ENTER_REQ : ScreenOp.INVENTORY_LEAVE_REQ);
    } catch { /* closed meanwhile */ }
  }

  refreshWallet(): void {
    try { this.need().send(ScreenOp.GET_POINT_CASH_REQ, buildGetPointCash()); } catch { /* offline */ }
  }

  loadShop(): Promise<void> { return this.shop.load(this.need()); }

  private async sendEquip(q: CharChangeEquipRequest): Promise<void> {
    const err = await changeEquip(this.need(), q);
    this.player.dispatch({ type: "equipAck", request: q, error: err });
    if (err !== 0) throw new MetaError(`6150 erro 0x${(err >>> 0).toString(16)}`, err);
  }

  /**: 1050 on a Durable item (starts its period). Resolves after 6150. */
  activate(item: InventoryItem): Promise<void> {
    return this.serial(async () => {
      // Equipment classes answer 6150; coupons/function items answer 1051 only (the server routes 1050 to the
      // 1047 ITEM_AUTH handler for them), so waiting for 6150 there would time out.
      const r = await equipSingle(this.need(), item.objectId, { equipClass: countIsSeconds(item.itemId) });
      if (r.auth) this.player.dispatch({ type: "itemAuth", item: r.auth });
      if (r.error !== 0) throw new MetaError(`1050: erro 0x${(r.error >>> 0).toString(16)}`, r.error);
    });
  }

  /** "Usar" of Change Name (1800047), Fake nick (1600010) or Change Clan Name (1800051): 1052 with the text. Resolves to the server code (1 = ok). */
  useItemText(item: InventoryItem, text: string): Promise<number> {
    return this.serial(async () => (await useItemStr(this.need(), item.objectId, text)).code);
  }

  /** "Usar" of the nick colour item (1600006): 1052 with the colour index as its one argument (the server reads buf[0]). */
  changeNickColor(item: InventoryItem, index: number): Promise<number> {
    return this.serial(async () => {
      const code = (await useItemArg(this.need(), item.objectId, index)).code;
      const nick = this.player.state.profile?.nickname;
      if (code === 1 && nick) this.lobby.setNickColor(nick, index);
      return code;
    });
  }

  private renameSelf(nick: string): void {
    const pr = this.player.state.profile;
    if (pr) this.player.dispatch({ type: "profile", basic: { ...pr, nickname: nick } });
    chat.myNick = nick;
  }

  private renameClan(name: string): void {
    const pr = this.player.state.profile;
    if (pr) this.player.dispatch({ type: "profile", basic: { ...pr, clanName: name } });
  }

  /**
   * "Usar" of the emblem change item (1600052): 1052 with the logo as its one argument. The item is not consumed here
   * (handleUseItem only changes system_clan.logo), so the inventory is left as it is. Resolves to the server code (1 = ok).
   */
  changeClanMark(item: InventoryItem, logo: number): Promise<number> {
    return this.serial(async () => (await useItemArg(this.need(), item.objectId, logo)).code);
  }

  /** "Usar" of the 1-byte effects (crosshair 1600014, nick border 1600205): 1052 `C 1, C value`. Resolves to the server code. */
  useItemByte(item: InventoryItem, value: number): Promise<number> {
    return this.serial(async () => (await useItemByte(this.need(), item.objectId, value)).code);
  }

  /** "Usar" of the 4-byte colours (clan name colour 1600005, muzzle colour 1600187): 1052 `C 4, D value`. Resolves to the server code. */
  useItemU32(item: InventoryItem, value: number): Promise<number> {
    return this.serial(async () => (await useItemArg(this.need(), item.objectId, value)).code);
  }

  /** "Usar" of PB Inspector (1600085): 1052 with the room slot; the slot's equipment comes back with the code (server roomUserItemAck). */
  inspect(item: InventoryItem, slot: number): Promise<InspectResult> {
    return this.serial(() => useInspector(this.need(), item.objectId, slot));
  }

  /**
   *: weapon/part/beret -> its pair; character -> the given team side. Durable items are activated
   * first (1050), like the original ("Deseja equipar?" STR_INVEN_STARTING_AUTH). Function/coupon items
   * (Quick Change, capsules, ...) have no 18-pair slot: the server's 1050 handler routes them to the unified
   * item-use handler instead of equipping (PROTOCOL_CHAR_CHANGE_EQUIP_SINGLE_REQ.cs IsActivatableEquipment),
   * so activation via 1050 IS the whole "Usar" action for them — there is no 6149 to send afterwards.
   */
  async equip(item: InventoryItem, side: number = Side.Red): Promise<void> {
    const slot = equipSlotOf(item.itemId);
    if (this.player.needsActivation(item)) await this.activate(item);
    if (slot === null) return;
    return this.serial(async () => {
      const st = this.player.state;
      if (!st.loadout) throw new MetaError("Loadout (3082) ainda não recebido.");
      // a TR/CT character always goes to its own team: the server sets chara_red/blue_side from the slot it is sent in
      if (slot === EquipSlot.Chara) return this.sendEquip(this.charaRequest(item.itemId, charaTeamOf(item.itemId) ?? side));
      await this.sendEquip(equipRequestFromLoadout(st.loadout, { [slot]: { itemId: item.itemId, objectId: item.objectId } }, st.charaInfo ?? undefined));
    });
  }

  /**
   * "Desequipar" a cosmetic slot (head/face/beret/jacket/pocket/glove/belt/holster/skin): sends itemId 0 in its
   * 18-pair, which confirms clears it. Not
   * valid for weapon slots (0-4) or Chara (8): the original always keeps one item equipped there.
   */
  unequip(slot: number): Promise<void> {
    if (slot < EquipSlot.Head || slot > EquipSlot.Beret) throw new MetaError("Slot não pode ser desequipado.");
    return this.serial(async () => {
      const st = this.player.state;
      if (!st.loadout) throw new MetaError("Loadout (3082) ainda não recebido.");
      await this.sendEquip(equipRequestFromLoadout(st.loadout, { [slot]: { itemId: 0, objectId: 0 } }, st.charaInfo ?? undefined));
    });
  }

  /** 6149 for a team character: its player_characters slot must be unique in the Game 2453. */
  charaRequest(itemId: number, side: number): CharChangeEquipRequest {
    const st = this.player.state;
    // every refusal shows the original's text; the reason goes to the console
    if (!st.loadout || !st.charaInfo) { console.warn("equip chara: 2453/3082 not received"); throw new MetaError(WRONG_CHARA); }
    const mine = st.charaInfo.charas.filter((c) => c.itemId === itemId);
    // a character item always has a player_characters row (1045/6145 create it and answer 6146, USER_ENTER recreates missing ones)
    if (!mine.length) { console.warn(`equip chara ${itemId}: no slot in 2453/6146`); throw new MetaError(WRONG_CHARA); }
    const slot = mine[0].slot;
    if (st.charaInfo.charas.filter((c) => c.slot === slot).length !== 1) {
      console.warn(`equip chara ${itemId}: slot ${slot} shared by two characters`);
      throw new MetaError(WRONG_CHARA);
    }
    const q = equipRequestFromLoadout(st.loadout, side === Side.Red ? { [EquipSlot.Chara]: { itemId, objectId: mine[0].objectId } } : {}, st.charaInfo);
    q.charaSlots = side === Side.Red ? [slot, q.charaSlots[1]] : [q.charaSlots[0], slot];
    return q;
  }

  /**
   * 1045 -> 3334... -> 1047. Throws MetaError with the 1047 code on failure (wallet is updated either way).
   * A single character good the account does not have yet goes as 6145 CREATE_CHARA, as the original buys
   * characters; an owned one (extending its period) goes as 1045, since 6145 would add a second row.
   */
  buy(cart: CartGood[]): Promise<BuyResult> {
    const good = cart.length === 1 ? this.shop.data?.goods.find((g) => g.goodId === cart[0].goodId) : undefined;
    if (good && itemClass(good.itemId) === ItemClass.Character && this.player.charaSlotOf(good.itemId) === null && this.player.state.charaInfo && !hasItemId(this.player.state.inventory, good.itemId))
      return this.buyChara(cart[0], good.itemId);
    return this.serial(async () => {
      const { result, deltas } = await buyGoods(this.need(), cart);
      for (const d of deltas) this.player.dispatch({ type: "inventoryDelta", delta: d });
      this.player.dispatch({ type: "buy", result });
      if (!result.ok) throw new MetaError(buyErrorText(result.code), result.code);
      return result;
    });
  }

  /**
   * 1048 -> 1049 (or 1047 on failure). The sender pays; the receiver (online, by nick) gets a gift note (type 2) and takes the item
   * from it with acceptGift. The wallet comes back through 1061 from the server. Throws MetaError with the code on failure.
   */
  gift(cart: CartGood[], nick: string): Promise<BuyResult> {
    return this.serial(async () => {
      const result = await giftGoods(this.need(), cart, nick);
      if (!result.ok) throw new MetaError(buyErrorText(result.code), result.code);
      return result;
    });
  }

  /** 1056 -> 1057: the gift note's item goes to the inventory (its 3334 delta comes before the 1057 and the listener adds it). */
  acceptGift(objectId: number): Promise<void> {
    return this.serial(async () => {
      const code = await acceptGift(this.need(), objectId);
      if (code !== 1) throw new MetaError(buyErrorText(code), code);
    });
  }

  /** 6145 -> 3334 -> 6146 (PlayerStore gets the 6146 through the listener). */
  buyChara(g: CartGood, itemId: number): Promise<BuyResult> {
    return this.serial(async () => {
      const ack = await createChara(this.need(), g.goodId, g.buyType, itemName(itemId).name || String(itemId));
      if (ack.error !== 0) {
        this.refreshWallet();
        throw new MetaError(buyErrorText(ack.error, g.buyType === BuyType.Cash ? "cash" : "gold"), ack.error);
      }
      return { ok: true, code: 1, goodIds: [g.goodId], gold: ack.gold, cash: ack.cash, time: 0 };
    });
  }

  /** 6151 -> 6152 + 2453: deletes the character in that slot and its item (the original's). */
  deleteChara(slot: number): Promise<void> {
    return this.serial(async () => {
      const c = this.need();
      const ack = c.waitFor(GameMetaOp.CHAR_DELETE_CHARA_ACK);
      c.send(GameMetaOp.CHAR_DELETE_CHARA_REQ, buildDeleteChara(slot));
      const r = parseDeleteChara(await ack);
      if (r.error !== 0) throw new MetaError(WRONG_CHARA, r.error);
      if (r.objectId) this.player.dispatch({ type: "itemDeleted", objectId: r.objectId });
    });
  }
}

/** 1047 failure codes -> String_Brazil.lua texts. */
export function buyErrorText(code: number, currency: "gold" | "cash" = "gold"): string {
  switch (code >>> 0) {
    case 0x80001018: return currency === "cash" ? "Cash insuficiente." : "Gold insuficiente."; // STBL_IDX_COUPON_USE_FAIL_REASON_LIMIT_MONEY / STBL_IDX_CLAN_NO_POINT
    case 0x80001017: return "Não é possível comprar este item "; // STR_SHOP_CANNOT_ITEM_BUYING
    case 0x800010b9: return "Falha na compra (inventário cheio)"; // STBL_IDX_EP_SHOP_BUY_FAIL_CAPTION_E + [RECRIADO] reason
    default: return `Falha na compra (0x${(code >>> 0).toString(16)})`; // STBL_IDX_EP_SHOP_BUY_FAIL_CAPTION_E
  }
}
