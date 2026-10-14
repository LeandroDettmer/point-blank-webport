// Server.Auth ServerPacket/*.cs Write() ports. Each returns the payload (opcode first) that TcpSession.send frames.
import { PacketWriter } from "../../../src/net/packet.ts";

export const EventError = {
  SUCCESS: 0x00000000,
  FAIL: 0x80000000,
  LOGIN_ALREADY_LOGIN: 0x80000101,
  LOGIN_TIME_OUT_2: 0x80000106,
  LOGIN_BLOCK_ACCOUNT: 0x80000107,
  LOGIN_ID_PASS_INCORRECT: 0x80000117,
  LOGIN_BLOCK_IP: 0x80000121,
  DISCONNECT_INVALID_LOGIN: 0x80000100,
} as const;

/** Plugin.Core/Enums/SChannelType.cs */
export const SChannelType: Record<string, number> = {
  all: 0, training: 1, novice: 2, public: 3, expert: 4, clan: 5, combination: 6, championship: 7, nation: 8,
};
/** Plugin.Core/Enums/ChannelType.cs */
export const ChannelType: Record<string, number> = {
  blocked: -1, unk: 0, public: 1, training: 2, novice: 3, clan: 4, special: 5, expert: 6, championship: 7,
  unk_14: 14, ch_pw: 111, ch_ip: 120,
};
/** ComDiv.ParseEnum<T>(value, ignoreCase): name or numeric string. */
export function parseEnum(table: Record<string, number>, value: string): number {
  const v = table[value.trim().toLowerCase()];
  if (v !== undefined) return v;
  const n = Number.parseInt(value, 10);
  if (Number.isFinite(n)) return n;
  throw new Error(`enum value not found: ${value}`);
}

/** AllUtils.ValidateKey: uint.Parse($). */
export function validateKey(playerId: bigint, sessionId: number, hwSpec0: number): number {
  const p3 = (n: number) => String(n).padStart(3, "0");
  return Number(`${p3((hwSpec0 >>> 0) % 999)}${p3(Number(playerId % 999n))}${p3(sessionId % 999)}`) >>> 0;
}

const utf8 = new TextEncoder();
/** BaseServerPacket.WriteS: all UTF-8 bytes of Text, then (Count - Text.Length) zeros. */
export function csWriteS(w: PacketWriter, text: string, count: number): PacketWriter {
  return w.writeB(utf8.encode(text)).zeros(Math.max(0, count - text.length));
}

/** PROTOCOL_BASE_LOGIN_ACK (1283). */
export function loginAck(error: number, verificationKey: number, features: number, acc: { playerId: bigint; username: string } | null): Uint8Array {
  const w = new PacketWriter()
    .writeH(1283).writeH(0).writeD(verificationKey).writeB([0x01, 0x03, 0x00]).zeros(9)
    .writeD(features).writeH(1531).zeros(16);
  if (error === EventError.SUCCESS && acc) {
    const pid = acc.playerId.toString();
    w.writeC(pid.length);
    csWriteS(w, pid, pid.length).writeC(0).writeC(acc.username.length);
    csWriteS(w, acc.username, acc.username.length).writeQ(acc.playerId);
  } else {
    w.zeros(11);
  }
  return w.writeD(error).toBytes();
}

/** PROTOCOL_AUTH_GET_POINT_CASH_ACK (1061). */
export function pointCashAck(error: number, a: { cash: number; gold: number; tags: number }): Uint8Array {
  return new PacketWriter().writeH(1061).writeD(error).writeD(a.cash).writeD(a.gold).writeD(a.tags).toBytes();
}

export interface ServerEntry {
  id: number; state: boolean; host: string; port: number; type: number; maxPlayers: number;
  lastPlayers: number; channelPlayers: number;
}
export interface ChannelEntry { serverId: number; id: number; type: number; totalPlayers: number }

function ipBytes(host: string): number[] {
  const p = host.split(".").map((x) => Number.parseInt(x, 10));
  if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255))) throw new Error(`IPAddress.Parse: ${host}`);
  return p;
}

/** PROTOCOL_BASE_GAME_SERVER_STATE_ACK (2400). */
export function gameServerStateAck(servers: ServerEntry[], channels: ChannelEntry[]): Uint8Array {
  const w = new PacketWriter().writeH(2400).writeH(0).writeC(servers.length);
  for (const s of servers) {
    const ip = ipBytes(s.host);
    w.writeD(s.state ? 1 : 0).writeB(ip).writeB(ip).writeH(s.port).writeC(s.type).writeH(s.maxPlayers).writeD(s.lastPlayers);
    if (s.id !== 0) {
      for (const c of channels) if (c.serverId === s.id) w.writeC(c.type);
      w.writeC(s.type).writeC(0).writeH(0);
    } else {
      w.writeB([0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x0e, 0x00, 0x00, 0x00, 0x00]);
    }
  }
  return w.writeC(0).toBytes();
}

/** PROTOCOL_BASE_GET_CHANNELLIST_ACK (2333). */
export function channelListAck(server: ServerEntry, channels: ChannelEntry[]): Uint8Array {
  const w = new PacketWriter().writeH(2333).writeD(0).writeD(1).writeD(0).writeH(0).writeC(0).writeC(channels.length);
  for (const c of channels) w.writeH(c.totalPlayers);
  return w.writeH(310).writeH(server.channelPlayers).writeC(channels.length).writeC(0).toBytes();
}

/** PROTOCOL_BASE_USER_LEAVE_ACK (2329). */
export function userLeaveAck(error: number): Uint8Array {
  return new PacketWriter().writeH(2329).writeD(error).writeH(0).toBytes();
}

/** PROTOCOL_SERVER_MESSAGE_DISCONNECTIONSUCCESS_ACK (3074). */
export function disconnectionSuccessAck(error: number): Uint8Array {
  return new PacketWriter().writeH(3074).writeD(error).toBytes();
}

/** PROTOCOL_AUTH_ACCOUNT_KICK_ACK (2009); the C# ctor argument is not written. */
export function accountKickAck(): Uint8Array {
  return new PacketWriter().writeH(2009).zeros(19).writeC(0).toBytes();
}

/** PROTOCOL_SERVER_MESSAGE_ERROR_ACK (3078). */
export function serverMessageErrorAck(error: number): Uint8Array {
  return new PacketWriter().writeH(3078).writeD(error).toBytes();
}
