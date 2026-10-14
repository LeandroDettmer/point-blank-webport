// Game server flow: CONNECT_ACK -> USER_ENTER (+ pushes up to 3082, collectEnterPushes) -> GET_CHANNELLIST
// -> SELECT_CHANNEL -> LOBBY_ENTER -> LOBBY_GET_ROOMLIST (paged; server rotates the page on every request, >= 1s apart).
import { PbConnection, defaultServerUrl, enterTickets, type TcpTarget } from "./connection.ts";
import { PacketReader, PacketWriter } from "./packet.ts";
import { Op, errorName } from "./opcodes.ts";
import { parseChannelList, type ChannelListInfo } from "./authClient.ts";
import { collectEnterPushes, type EnterPushes } from "./metaGame.ts";

export interface RoomInfo {
  roomId: number;
  name: string;
  mapId: number;
  rule: number;
  stage: number;
  roomType: number;
  state: number;
  players: number;
  slots: number;
  ping: number;
  weaponsFlag: number;
  flag: number;
  leaderAddr: string;
}

/** PROTOCOL_LOBBY_GET_ROOMINFOADD_ACK (2568): the room's option half, for the lobby's Info panel. */
export interface RoomInfoAdd {
  roomId: number;
  leaderName: string;
  killTime: number;
  /** Rounds - 1 */
  round: number;
  /** seconds since the battle started (0 outside BATTLE / PRE_BATTLE) */
  battleTime: number;
  limit: number;
  watchRuleFlag: number;
  balanceType: number;
}

export interface LobbyPlayer {
  sessionId: number;
  clanLogo: number;
  clanName: string;
  rank: number;
  nickColor: number;
  nickname: string;
  nation: number;
}

export interface RoomListPage {
  totalRooms: number;
  roomPage: number;
  rooms: RoomInfo[];
  totalPlayers: number;
  playerPage: number;
  players: LobbyPlayer[];
}

export class GameError extends Error {
  code: number;
  constructor(what: string, code: number) {
    super(`${what}: ${errorName(code)}`);
    this.code = code;
  }
}

/** PROTOCOL_LOBBY_GET_ROOMLIST_ACK (2588). Room = 71 bytes, player = 120 bytes. */
export function parseRoomList(r: PacketReader): RoomListPage {
  const totalRooms = r.readD();
  const roomPage = r.readD();
  const roomCount = r.readD();
  const rooms: RoomInfo[] = [];
  for (let i = 0; i < roomCount; i++) {
    rooms.push({
      roomId: r.readSignedD(),
      name: r.readU(46),
      mapId: r.readC(),
      rule: r.readC(),
      stage: r.readC(),
      roomType: r.readC(),
      state: r.readC(),
      players: r.readC(),
      slots: r.readC(),
      ping: r.readC(),
      weaponsFlag: r.readH(),
      flag: r.readD(),
      leaderAddr: (r.readH(), [...r.readB(4)].join(".")),
    });
    r.readC();
  }
  const totalPlayers = r.readD();
  const playerPage = r.readD();
  const playerCount = r.readD();
  const players: LobbyPlayer[] = [];
  for (let i = 0; i < playerCount; i++) {
    const sessionId = r.readD();
    const clanLogo = r.readD();
    r.readC(); // clan effect
    const clanName = r.readU(34);
    const rank = r.readC();
    r.readC();
    const nickColor = r.readC();
    const nickname = r.readU(66);
    const nation = r.readC();
    r.skip(1 + 4 + 1 + 1); // 0, namecard id, nick border color, 0
    players.push({ sessionId, clanLogo, clanName, rank, nickColor, nickname, nation });
  }
  return { totalRooms, roomPage, rooms, totalPlayers, playerPage, players };
}

export class GameClient {
  readonly conn: PbConnection;
  serverId = 0;
  channelId = -1;
  /** Pushes that followed USER_ENTER_ACK (2371/2395/1061/2369/2453/3082), set by enter(). */
  enterPushes: EnterPushes | null = null;

  constructor(target: TcpTarget, serverUrl = defaultServerUrl()) {
    this.conn = new PbConnection(target, serverUrl);
  }

  /**
   * Connects and sends USER_ENTER (C len + S username + Q playerId), then waits for the pushes up to 3082 so
   * 2453 and 3082 are known before any 6149. Also kept in `enterPushes`.
   */
  async enter(username: string, playerId: bigint, serverId: number): Promise<EnterPushes> {
    this.serverId = serverId;
    await this.conn.connect();
    // the Auth's enter ticket of this login, before USER_ENTER
    const ticket = enterTickets.get(playerId);
    if (ticket) this.conn.sendText({ t: "enter", ticket });
    const pushes = collectEnterPushes(this.conn);
    const ack = this.conn.waitFor(Op.BASE_USER_ENTER_ACK, 10000);
    const w = new PacketWriter().writeC(username.length).writeS(username, username.length).writeQ(playerId);
    this.conn.send(Op.BASE_USER_ENTER_REQ, w);
    let err: number;
    try { err = (await ack).readD(); } catch (e) { pushes.stop(); throw e; }
    if (err !== 0) { pushes.stop(); throw new GameError("USER_ENTER", err); }
    const got = await pushes.done;
    if (!got.loadout || !got.charaInfo) console.warn("[game] USER_ENTER: 2453/3082 not received; 6149 will keep both character slots (255)");
    return (this.enterPushes = got);
  }

  async getChannels(timeoutMs = 3000): Promise<ChannelListInfo | null> {
    const ack = this.conn.waitFor(Op.BASE_GET_CHANNELLIST_ACK, timeoutMs);
    this.conn.send(Op.BASE_GET_CHANNELLIST_REQ, new PacketWriter().writeD(this.serverId));
    try {
      return parseChannelList(await ack);
    } catch {
      return null;
    }
  }

  /** SELECT_CHANNEL_REQ body: 4 ignored bytes + H channelId. ACK: H 0, D error, [D server, H channel]. */
  async selectChannel(channelId: number): Promise<void> {
    const ack = this.conn.waitFor(Op.BASE_SELECT_CHANNEL_ACK);
    this.conn.send(Op.BASE_SELECT_CHANNEL_REQ, new PacketWriter().writeD(this.serverId).writeH(channelId));
    const r = await ack;
    r.readH();
    const err = r.readD();
    if (err !== 0) throw new GameError("SELECT_CHANNEL", err);
    r.readD();
    this.channelId = r.readH();
  }

  async enterLobby(): Promise<void> {
    const ack = this.conn.waitFor(Op.LOBBY_ENTER_ACK);
    this.conn.send(Op.LOBBY_ENTER_REQ);
    const err = (await ack).readD();
    if (err !== 0) throw new GameError("LOBBY_ENTER", err);
  }

  /** One page. The server ignores requests < 1s apart (no reply) -> resolves null on timeout. */
  async getRoomList(timeoutMs = 2500): Promise<RoomListPage | null> {
    const ack = this.conn.waitFor(Op.LOBBY_GET_ROOMLIST_ACK, timeoutMs);
    this.conn.send(Op.LOBBY_GET_ROOMLIST_REQ);
    try {
      return parseRoomList(await ack);
    } catch {
      return null;
    }
  }

  /** The server does not answer for a missing room (or one without leader) -> null on timeout. */
  async getRoomInfoAdd(roomId: number, timeoutMs = 2500): Promise<RoomInfoAdd | null> {
    const ack = this.conn.waitFor(Op.LOBBY_GET_ROOMINFOADD_ACK, timeoutMs);
    this.conn.send(Op.LOBBY_GET_ROOMINFOADD_REQ, new PacketWriter().writeD(roomId));
    try {
      const r = await ack;
      r.readC();
      return { roomId, leaderName: r.readU(66), killTime: r.readC(), round: r.readC(), battleTime: r.readH(), limit: r.readC(), watchRuleFlag: r.readC(), balanceType: r.readH() };
    } catch {
      return null;
    }
  }

  close(): void {
    this.conn.close();
  }
}
