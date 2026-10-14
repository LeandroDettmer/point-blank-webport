// "Usar" of the effects that take a 1-byte argument (1600014 crosshair colour, 1600205 nick border) and
// of PB Inspector (1800085 / 1600085). Server: server itemHandlers.ts handleUseItem (C# PROTOCOL_INVENTORY_USE_ITEM_REQ
// Method0). The 4-byte u32 effects (1600005 clan name colour, 1600187 muzzle colour) use useItemArg in singleEquip.ts.
import { PacketWriter, type PacketReader } from "../../net/packet.ts";
import type { PbConnection } from "../../net/connection.ts";
import { SingleEquipOp, parseItemAuth } from "./singleEquip.ts";

/** 3647 ROOM_GET_USER_ITEM_ACK: the slot's equipment, sent before the 1051 of the PB Inspector use (server roomUserItemAck). */
export const ROOM_GET_USER_ITEM_ACK = 3647;

/** `D objectId, C 1, C value`: the server reads buf[0] for these effects. */
export async function useItemByte(conn: PbConnection, objectId: number, value: number, timeoutMs = 5000): Promise<{ code: number }> {
  const ack = conn.waitFor(SingleEquipOp.ITEM_AUTH_ACK, timeoutMs);
  conn.send(SingleEquipOp.USE_ITEM_REQ, new PacketWriter(6).writeD(objectId >>> 0).writeC(1).writeC(value & 0xff));
  return { code: parseItemAuth(await ack).code };
}

/** (itemId, objectId) pair of a 3647 block: 8 bytes, `D itemId, D objectId` (server equipmentDataChara; 0 = none). */
export interface EquipPair { itemId: number; objectId: number }

/** 3647 body after the opcode: H 0, pair accessory, H 0, C 3, pairs dino / spray / name card, then the 18 chara blocks. */
export interface InspectorEquip { accessory: EquipPair; dino: EquipPair; spray: EquipPair; nameCard: EquipPair; blocks: EquipPair[] }

const pair = (r: PacketReader): EquipPair => ({ itemId: r.readD(), objectId: r.readD() });

export function parseInspectorEquip(r: PacketReader): InspectorEquip {
  r.readH();
  const accessory = pair(r);
  r.readH();
  r.readC();
  const dino = pair(r), spray = pair(r), nameCard = pair(r);
  const blocks = Array.from({ length: 18 }, () => pair(r));
  return { accessory, dino, spray, nameCard, blocks };
}

export interface InspectResult { code: number; equip: InspectorEquip | null }

/**
 * "Usar" of PB Inspector: 1052 with the room slot index (`D objectId, C 1, C slot`). The server answers 3647 with the
 * slot's equipment and then 1051 (code 1 = ok); on refusal there is no 3647. Both waiters are armed before the send.
 */
export async function useInspector(conn: PbConnection, objectId: number, slot: number, timeoutMs = 5000): Promise<InspectResult> {
  const equipAck = conn.waitFor(ROOM_GET_USER_ITEM_ACK, timeoutMs).catch(() => null);
  const ack = conn.waitFor(SingleEquipOp.ITEM_AUTH_ACK, timeoutMs);
  conn.send(SingleEquipOp.USE_ITEM_REQ, new PacketWriter(6).writeD(objectId >>> 0).writeC(1).writeC(slot & 0xff));
  const code = parseItemAuth(await ack).code;
  if (code !== 1) return { code, equip: null };
  const r = await equipAck;
  return { code, equip: r ? parseInspectorEquip(r) : null };
}
