// Server.Game ServerPacket Write() ports: user enter / channel / lobby / inventory / equip / shop.
import { PacketWriter } from "../../../src/net/packet.ts";
import type { Account } from "../shared/account.ts";
import type { ClanModel } from "../shared/dao.ts";
import { newStat, type Stat } from "../shared/models.ts";
import type { ItemsModel } from "../shared/items.ts";
import { shop, type GoodsItem } from "../shared/shop.ts";
import { nowNum, fmtDate } from "../shared/time.ts";
import { writeUserInfoBasic, csWriteU, equipmentDataChara, charaBlock } from "../auth/metaPackets.ts";

const oid32 = (v: bigint) => Number(BigInt.asUintN(32, v));
const W = (n = 64) => new PacketWriter(n);

export const userEnterAck = (err: number) => W(8).writeH(2331).writeD(err).toBytes();

export function myInfoBasicAck(a: Account, clan: ClanModel): Uint8Array {
  const w = W(200).writeH(2371);
  writeUserInfoBasic(w, a, clan, true);
  return w.toBytes();
}

export function invItemDataAck(a: Account): Uint8Array {
  const b = a.bonus;
  const w = W(90).writeH(2395).writeC(0).writeC(a.nickColor).writeD(b.fakeRank).writeD(b.fakeRank);
  csWriteU(w, b.fakeNick, 66);
  return w.writeH(b.crosshairColor).writeH(b.muzzleColor).writeC(b.nickBorderColor).toBytes();
}

const recordFields = ["matches", "matchWins", "matchLoses", "matchDraws", "killsCount", "headshotsCount", "deathsCount", "totalMatchesCount", "totalKillsCount", "escapesCount", "assistsCount", "mvpCount"];
export function myInfoRecordAck(a: Account): Uint8Array {
  const w = W(100).writeH(2369);
  for (const s of [a.statistic.season ?? newStat("season"), a.statistic.basic ?? newStat("basic")] as Stat[]) for (const f of recordFields) w.writeD(s[f]);
  return w.toBytes();
}

/** PROTOCOL_SERVER_MESSAGE_CHANGE_INVENTORY_ACK (3082), login constructor. */
export function changeInventoryAck(a: Account): Uint8Array {
  const e = a.equipment, inv = a.inventory;
  const w = W(260).writeH(3082).writeH(0).writeC(6);
  for (let i = 0; i < 6; i++) w.writeB(equipmentDataChara(inv, e.emoticons[i]));
  const handles: number[] = [];
  const red = a.character.getCharacter(e.charaRedId), blue = a.character.getCharacter(e.charaBlueId);
  if (red) handles.push(red.slot);
  if (blue) handles.push(blue.slot);
  w.writeC(handles.length);
  for (const h of handles) w.writeD(h);
  w.writeC(0).writeB(equipmentDataChara(inv, e.accessoryId)).writeC(0).writeH(0).writeH(0);
  for (const b of charaBlock(a, e.charaRedId)) w.writeB(b);
  return w.writeC(3).writeB(equipmentDataChara(inv, e.dinoItem)).writeB(equipmentDataChara(inv, e.sprayId)).writeB(equipmentDataChara(inv, e.nameCardId)).toBytes();
}

export function selectChannelAck(err: number, serverId = 0, channelId = 0): Uint8Array {
  const w = W(16).writeH(2335).writeH(0).writeD(err);
  if (err === 0) w.writeD(serverId).writeH(channelId);
  return w.toBytes();
}

export const lobbyEnterAck = (err: number) => W(24).writeH(2584).writeD(err).writeC(0).writeC(0).writeD(0).zeros(9).toBytes();
export const lobbyLeaveAck = (err: number) => W(8).writeH(2562).writeD(err).toBytes();
/** PROTOCOL_SHOP_GET_SAILLIST_ACK (1030): system clock yyMMddHHmm. */
export const saillistAck = (flag: boolean) => W(8).writeH(1030).writeC(flag ? 1 : 0).writeD(nowNum("yyMMddHHmm")).toBytes();
export const userLeaveAck = () => W(8).writeH(2329).writeD(0).writeH(0).toBytes();
export const logoutAck = () => W(4).writeH(2308).writeH(0).toBytes();
export const inventoryEnterAck = () => W(12).writeH(3330).writeD(0).writeD(nowNum("yyMMddHHmm")).toBytes();
export const inventoryLeaveAck = () => W(8).writeH(3332).writeH(0).writeD(0).toBytes();
export const changeEquipAck = () => W(8).writeH(6150).writeD(0).writeH(0).toBytes();
/** PROTOCOL_ROOM_INFO_ENTER_ACK (3673) / _LEAVE_ACK (3675): the profile (Perfil) screen opened / closed. */
export const roomInfoEnterAck = () => W(8).writeH(3673).writeD(0).writeC(68).toBytes();
export const roomInfoLeaveAck = () => W(8).writeH(3675).writeD(0).toBytes();

export function roomListAck(roomCount: number, waitCount: number, roomPage: number, playerPage: number, nR: number, nP: number, rooms: Uint8Array, players: Uint8Array): Uint8Array {
  return W(64 + rooms.length + players.length).writeH(2588).writeD(roomCount).writeD(roomPage).writeD(nR).writeB(rooms)
    .writeD(waitCount).writeD(playerPage).writeD(nP).writeB(players).toBytes();
}

/** SyncServerPacket.WriteU for lobby entries: UTF-16LE copied into at most count-2 bytes, zero padded. */
export function syncU(w: PacketWriter, text: string, count: number): PacketWriter {
  const out = new Uint8Array(count);
  for (let i = 0; i < text.length && i * 2 + 1 < count - 2; i++) { const c = text.charCodeAt(i); out[i * 2] = c & 0xff; out[i * 2 + 1] = c >> 8; }
  return w.writeB(out);
}

// ---- shop -----------------------------------------------------------------------------------------------------

export const shopEnterAck = () => W(12).writeH(1026).writeD(0).writeC(0).writeD(nowNum("yyMMddHHmm")).toBytes();
export const shopLeaveAck = () => W(8).writeH(1028).writeH(0).writeD(0).toBytes();

function chunked(op: number, buf: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let off = 0; off < buf.length; off += 8000) {
    const c = buf.subarray(off, Math.min(off + 8000, buf.length));
    out.push(W(16 + c.length).writeH(op).writeD(buf.length).writeD(off).writeD(c.length).writeB(c).toBytes());
  }
  return out;
}

/** ShopCatalog121Sender.SendFullCatalog. */
export function fullCatalog(a: Account, includePackedGoods: boolean): Uint8Array[] {
  const out: Uint8Array[] = [...chunked(1039, shop.packedItems)];
  if (includePackedGoods) out.push(...chunked(1037, shop.packedGoods));
  out.push(...chunked(1075, shop.packedRepairs));
  for (const p of shop.battleBoxes) out.push(W(32 + p.buffer.length).writeH(7426).writeD(shop.totalBoxes).writeD(p.itemsCount).writeD(p.offset).writeB(p.buffer).writeD(585).toBytes());
  out.push(flashSaleListAck());
  out.push(...chunked(1042, a.cafePC === 0 ? shop.packedMt1 : shop.packedMt2));
  out.push(W(8).writeH(1041).writeD(shop.catalogVersion).toBytes());
  return out;
}

export function flashSaleListAck(): Uint8Array {
  const w = W(128).writeH(1120);
  const ids = shop.flashSaleGoodIds;
  if (ids.length === 0 || shop.flashSaleStartDate === 0 || shop.flashSaleEndMinute <= 0) return w.writeD(0).toBytes();
  const e = new Uint8Array(121), dv = new DataView(e.buffer);
  e[0] = 0x0d; dv.setUint32(4, shop.flashSaleStartDate, true); e[18] = 1; e[20] = 1; dv.setUint32(22, shop.flashSaleEndMinute, true);
  const n = Math.min(ids.length, 3);
  e[26] = n;
  for (let i = 0; i < n; i++) dv.setUint32(27 + 4 * i, ids[i], true);
  e[120] = 0x38;
  return w.writeD(1).writeB(e).toBytes();
}

/** PROTOCOL_SHOP_TAG_INFO_ACK (1106), hard-coded in the C#. */
export function shopTagInfoAck(): Uint8Array {
  const w = W(96).writeH(1106).writeH(0).writeC(7).writeC(5).writeH(0).writeC(0).writeD(0).writeH(0);
  for (const t of [3, 4, 2, 6, 1]) { w.writeC(t).writeQ(0n).writeC(0); }
  // the C# sequence is C 3,Q 0,C 0, C 4,Q 0,C 0, C 2,Q 0,C 0, C 6,Q 0,C 0, C 1,Q 0 (no trailing C 0 for the last one)
  const b = w.toBytes().subarray(0, w.length - 1);
  return W(96).writeB(b).writeD(0).writeC(0).writeC(0xff).writeC(0xff).writeC(0xff).writeC(0).writeC(0xff).writeC(1).writeC(7).writeC(2).toBytes();
}

/** PROTOCOL_INVENTORY_GET_INFO_ACK (3334). */
export function inventoryGetInfoAck(type: number, a: Account, items: ItemsModel[]): Uint8Array {
  const w = W(32 + items.length * 13).writeH(3334).writeH(0).writeH(a.inventory.items.length).writeH(items.length);
  for (const it of items) w.writeD(oid32(it.objectId)).writeD(it.id).writeC(it.equip).writeD(it.count);
  return w.writeC(type).toBytes();
}

/** PROTOCOL_AUTH_SHOP_GOODS_BUY_ACK (1047). */
export function goodsBuyAck(code: number, goods: GoodsItem[], a: Account | null, error = 0): Uint8Array {
  const w = W(64).writeH(1047).writeH(0);
  if (code === 1) {
    w.writeC(goods.length);
    for (const g of goods) w.writeD(0).writeD(g.id).writeC(0);
    return w.writeD(0).writeD(a!.gold).writeD(a!.cash).writeD(nowNum("yyMMddHHmm")).toBytes();
  }
  return w.writeC(1).writeD(0).writeD(0).writeC(0).writeD(0).writeD(a ? a.gold : 0).writeD(a ? a.cash : 0).writeD(error).toBytes();
}

/** PROTOCOL_AUTH_SHOP_GOODS_GIFT_ACK (1049) on success: `H0, C n, n×{D0, D goodId, C0}, D cash, D gold, D yyMMddHHmm`
 *. The C# writes the receiver's money here;
 * the sender's is sent, so the sender's wallet is right [RECRIADO]. Gift errors go as the 1047 failure (goodsBuyAck). */
export function goodsGiftAck(goods: GoodsItem[], a: Account): Uint8Array {
  const w = W(64).writeH(1049).writeH(0).writeC(goods.length);
  for (const g of goods) w.writeD(0).writeD(g.id).writeC(0);
  return w.writeD(a.cash).writeD(a.gold).writeD(nowNum("yyMMddHHmm")).toBytes();
}

/** PROTOCOL_AUTH_SHOP_AUTH_GIFT_ACK (1057): `D code, [H0, H n, n×{D objectId, D itemId, C equip, D count}]` (code 1 = ok,
 * PROTOCOL_AUTH_SHOP_AUTH_GIFT_ACK.Write) */
export function giftAuthAck(code: number, items: ItemsModel[] = []): Uint8Array {
  const w = W(16 + items.length * 16).writeH(1057).writeD(code);
  if (code !== 1) return w.toBytes();
  w.writeH(0).writeH(items.length);
  for (const it of items) w.writeD(oid32(it.objectId)).writeD(it.id).writeC(it.equip).writeD(it.count);
  return w.toBytes();
}

export { fmtDate };
