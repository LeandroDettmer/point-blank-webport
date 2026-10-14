// F3-F5 Game opcodes beyond the room/lobby core (characters, profile, coupons, clan, friends, chat, missions).
// Returns true when the opcode was handled.
import type { PacketReader } from "../../../src/net/packet.ts";
import type { GameClient } from "./gameServer.ts";

export async function handleExtraPacket(_c: GameClient, _op: number, _r: PacketReader, _raw: Uint8Array): Promise<boolean> {
  return false;
}
