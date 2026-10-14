// Server.Game ChannelModel + ChannelsXML (system_channels) + the per-server GameManager state.
import { pool } from "../db.ts";
import { ChannelType, parseEnum } from "../auth/packets.ts";
import type { Account } from "../shared/account.ts";
import type { GameClient } from "./gameServer.ts";
import type { RoomModel } from "./roomModel.ts";

export interface PlayerSession { sessionId: number; playerId: bigint }

export class ChannelModel {
  id = 0;
  type = 0;
  serverId = 0;
  maxRooms = 0;
  expBonus = 0;
  goldBonus = 0;
  cashBonus = 0;
  password = "";
  players: PlayerSession[] = [];
  lobbyPlayers: Account[] = [];
  rooms: RoomModel[] = [];
  lastEmptyRoomSweep = 0;

  /** ChannelModel.AddPlayer: false when the session is already listed. */
  addPlayer(s: PlayerSession | null, a: Account): boolean {
    if (!s || this.players.includes(s)) return false;
    this.players.push(s);
    if (!this.lobbyPlayers.includes(a)) this.lobbyPlayers.push(a);
    return true;
  }

  /** ChannelModel.RemovePlayer. */
  removePlayer(a: Account): boolean {
    a.channelId = -1;
    a.serverId = -1;
    let ok = false;
    if (a.session) {
      const i = this.players.indexOf(a.session);
      if (i >= 0) { this.players.splice(i, 1); ok = true; }
      const j = this.lobbyPlayers.indexOf(a);
      if (j >= 0) this.lobbyPlayers.splice(j, 1);
    }
    return ok;
  }

  getRoom(id: number): RoomModel | null { return this.rooms.find((r) => r.roomId === id) ?? null; }

  /** ChannelModel.RemoveEmptyRooms (at most once per EmptyRoomRemovalInterval). */
  removeEmptyRooms(intervalMs = 10000): void {
    const now = Date.now();
    if (now - this.lastEmptyRoomSweep < intervalMs) return;
    this.lastEmptyRoomSweep = now;
    this.rooms = this.rooms.filter((r) => r.getCountPlayers() >= 1);
  }
}

export interface ServerInfo { id: number; channelPlayers: number; maxPlayers: number }

export class GameServerState {
  readonly clients = new Map<number, GameClient>();
  readonly channels: ChannelModel[];
  readonly info: ServerInfo;
  constructor(info: ServerInfo, channels: ChannelModel[]) {
    this.info = info;
    this.channels = channels;
  }
  getChannel(id: number): ChannelModel | null { return this.channels.find((c) => c.id === id) ?? null; }
}

/** ChannelsXML.Load (DB). */
export async function loadChannels(serverId: number): Promise<ChannelModel[]> {
  const r = await pool.query(`SELECT server_id, id, type, max_rooms, exp_bonus, gold_bonus, cash_bonus, password FROM system_channels WHERE server_id=$1 ORDER BY server_id ASC, id ASC`, [serverId]);
  return r.rows.map((x) => {
    const c = new ChannelModel();
    c.serverId = Number(x.server_id); c.id = Number(x.id); c.type = parseEnum(ChannelType, String(x.type)); c.maxRooms = Number(x.max_rooms);
    c.expBonus = Number(x.exp_bonus ?? 0); c.goldBonus = Number(x.gold_bonus ?? 0); c.cashBonus = Number(x.cash_bonus ?? 0); c.password = String(x.password ?? "");
    return c;
  });
}
