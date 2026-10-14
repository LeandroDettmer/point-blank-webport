// 1050 PROTOCOL_CHAR_CHANGE_EQUIP_SINGLE_REQ ("Usar" -> activate a Durable item) and 1051 ITEM_AUTH_ACK.
// metaGame.ts has no 1050, so keeps these two here until adopts them (layouts from the server):
//   1050 Read(): `D objectId, C slot`            (Server.Game/Network/ClientPacket/PROTOCOL_CHAR_CHANGE_EQUIP_SINGLE_REQ.cs)
//   Run(): Durable -> Temporary (count = yyMMddHHmm expiry) + 1051; always answers 6150 (`D err`, 0 = ok,
//          0x80000000 = item not found / DB failure). Class 41 (emotes) also sends 3082; non-equipment classes
//          are routed to ITEM_AUTH (1047 REQ handler) and answer 1051 only.
//   1051 Write(): `D code` (1 = ok), then only when ok: `D now, D objectId, D itemId, C equip, D count`
//          (PROTOCOL_AUTH_SHOP_ITEM_AUTH_ACK.cs; Temporary coupons send itemId 0, equip 1, count 0).
// The slot byte: the server ignores it for equipment (it only activates); the original client's value is not
// known and goes as 0 [RECRIADO].
import { PacketWriter, type PacketReader } from "../../net/packet.ts";
import type { PbConnection } from "../../net/connection.ts";
import type { InventoryItem } from "../types.ts";

export const SingleEquipOp = { REQ: 1050, ITEM_AUTH_ACK: 1051, CHANGE_EQUIP_ACK: 6150, USE_ITEM_REQ: 1052 } as const;

export function buildEquipSingle(objectId: number, slot = 0): PacketWriter {
  return new PacketWriter(5).writeD(objectId >>> 0).writeC(slot);
}

export function parseItemAuth(r: PacketReader): { code: number; ok: boolean; time: number; item: InventoryItem | null } {
  const code = r.readD();
  if (code !== 1) return { code, ok: false, time: 0, item: null };
  const time = r.readD();
  const objectId = r.readD();
  const itemId = r.readD();
  const equip = r.readC();
  const count = r.readD();
  return { code, ok: true, time, item: { objectId, itemId, equip, count } };
}

/**
 * 1052 INVENTORY_USE_ITEM_REQ with one u32 argument: `D objectId, C 4, D arg` (cosmetic cash items; 1600052 = the clan
 * emblem change, arg = the logo). Answers 1051 (server itemHandlers.ts handleUseItem, `code` 1 = ok).
 */
export async function useItemArg(conn: PbConnection, objectId: number, arg: number, timeoutMs = 5000): Promise<{ code: number; auth: InventoryItem | null }> {
  const ack = conn.waitFor(SingleEquipOp.ITEM_AUTH_ACK, timeoutMs);
  conn.send(SingleEquipOp.USE_ITEM_REQ, new PacketWriter(9).writeD(objectId >>> 0).writeC(4).writeD(arg >>> 0));
  const a = parseItemAuth(await ack);
  return { code: a.code, auth: a.item };
}

/**
 * 1052 INVENTORY_USE_ITEM_REQ with a text argument: `D objectId, C n, B[n]`, n = the UTF-16LE bytes of `text` (Change Name
 * 1600047, Fake nick 1600010, Change Clan Name 1600051: C# Method0 reads it with Bitwise.HexArrayToString). No terminator
 * is sent [INFERIDO: the C# cuts at the first 0, so both forms are read the same]. Answers 1051 like useItemArg.
 */
export async function useItemStr(conn: PbConnection, objectId: number, text: string, timeoutMs = 5000): Promise<{ code: number; auth: InventoryItem | null }> {
  const n = text.length * 2;
  if (n > 255) throw new Error(`useItemStr: ${n} bytes > 255`);
  const ack = conn.waitFor(SingleEquipOp.ITEM_AUTH_ACK, timeoutMs);
  conn.send(SingleEquipOp.USE_ITEM_REQ, new PacketWriter(5 + n).writeD(objectId >>> 0).writeC(n).writeU(text, n));
  const a = parseItemAuth(await ack);
  return { code: a.code, auth: a.item };
}

/**
 * Effect id of a use item: cash items above 1700000 are 1600000 + the last three digits (server handleUseItem `eff`);
 * the 16xxxxx items are their own effect.
 */
export const useEffectOf = (itemId: number): number => (itemId > 1700000 ? 1600000 + (itemId % 1000) : itemId);

/**
 * Sends 1050 to activate a Durable item.
 * - equipment classes (IsActivatableEquipment: weapon/char/part/beret/dino) get Durable->Temporary + 1051 and
 *   always answer 6150 (`D err`): wait for 6150, collect the 1051 on the way.
 * - non-equipment classes (coupons/function items) are routed by the server to the 1047 ITEM_AUTH handler and
 *   answer 1051 only, never 6150 (see the header). Waiting for 6150 there times out, so resolve on the 1051
 *   (`code` 1 = ok) instead. `equipClass` picks the path.
 */
export async function equipSingle(
  conn: PbConnection,
  objectId: number,
  opts: { equipClass?: boolean; timeoutMs?: number } = {},
): Promise<{ error: number; auth: InventoryItem | null }> {
  const { equipClass = true, timeoutMs = 5000 } = opts;
  if (!equipClass) {
    const ack = conn.waitFor(SingleEquipOp.ITEM_AUTH_ACK, timeoutMs);
    conn.send(SingleEquipOp.REQ, buildEquipSingle(objectId));
    const a = parseItemAuth(await ack);
    return { error: a.ok ? 0 : a.code >>> 0, auth: a.item };
  }
  let auth: InventoryItem | null = null;
  const off = conn.on((op, r) => { if (op === SingleEquipOp.ITEM_AUTH_ACK) auth = parseItemAuth(r).item; });
  try {
    const ack = conn.waitFor(SingleEquipOp.CHANGE_EQUIP_ACK, timeoutMs);
    conn.send(SingleEquipOp.REQ, buildEquipSingle(objectId));
    return { error: (await ack).readD(), auth };
  } finally {
    off();
  }
}
