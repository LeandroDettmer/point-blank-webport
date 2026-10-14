// Auth server flow: CONNECT_ACK -> LOGIN_REQ -> LOGIN_ACK -> meta 2316 -> 2318 -> 2320 -> 1060 (fetchMeta)
// -> GAME_SERVER_STATE -> GET_CHANNELLIST -> USER_LEAVE (hand-off: keeps the account online so Game's
// USER_ENTER accepts it). Meta order: and step 1.
import { PbConnection, defaultServerUrl } from "./connection.ts";
import { PacketReader, PacketWriter } from "./packet.ts";
import { Op, errorName } from "./opcodes.ts";
import { fetchAuthMeta, type AuthMeta } from "./metaAuth.ts";
import { parseCharaInfo, unsavedCharas } from "./metaGame.ts";

export interface LoginOptions {
  token: Uint8Array;
  clientVersion?: [number, number]; // must equal ServerConfig.json ClientVersion ("122.0")
  locale?: number; // ClientLocale: 9 = Brazil (ignored while Settings.ini Test=True)
  userFileList?: string; // checked only when ServerConfig AccessUFL=true
  mac?: Uint8Array; // must be non-zero
  width?: number;
  height?: number;
}

export interface LoginResult {
  error: number;
  errorName: string;
  ok: boolean;
  playerId: bigint;
  username: string;
  verificationKey: number;
}

export interface GameServerInfo {
  index: number; // position in the list == server id (0 is the auth/"login" entry)
  online: boolean;
  ip: string;
  port: number;
  type: number;
  maxPlayers: number;
  players: number;
  channelTypes: number[];
}

export interface ChannelListInfo {
  channelPlayers: number[];
  maxPerChannel: number;
}

const DEFAULT_UFL = "c9bb7c4f004ede8ed47e11ca58721167";

/** ChannelType.clan (Plugin.Core/Enums/ChannelType.cs; server auth/packets.ts): the clan channel, where clan vs clan matches run */
export const CHANNEL_TYPE_CLAN = 4;

export function stableMac(): Uint8Array {
  const key = "pbweb.mac";
  try {
    const saved = localStorage.getItem(key);
    if (saved && /^[0-9a-f]{12}$/.test(saved)) return Uint8Array.from(saved.match(/../g)!.map((h) => parseInt(h, 16)));
  } catch { /* no storage */ }
  const mac = crypto.getRandomValues(new Uint8Array(6));
  mac[0] = (mac[0] & 0xfe) | 0x02; // locally administered, unicast
  try {
    localStorage.setItem(key, [...mac].map((b) => b.toString(16).padStart(2, "0")).join(""));
  } catch { /* ignore */ }
  return mac;
}

/** Body of PROTOCOL_BASE_LOGIN_REQ as read by Server.Auth PROTOCOL_BASE_LOGIN_REQ.Read(). */
export function buildLoginBody(o: LoginOptions): PacketWriter {
  const [vMaj, vMin] = o.clientVersion ?? [122, 0];
  const ufl = o.userFileList ?? DEFAULT_UFL;
  const w = new PacketWriter();
  w.writeB([0x00, 0x57, 0x45, 0x42]); // 4 verification bytes; bytes 1..4 feed ValidateKey (hwSpec0)
  w.writeB(o.mac ?? stableMac());
  w.zeros(21);
  w.writeH(o.width ?? 1280).writeH(o.height ?? 720);
  w.zeros(10);
  w.writeC(ufl.length).writeS(ufl, ufl.length);
  w.zeros(16);
  w.writeC(o.locale ?? 9);
  w.writeC(vMaj).writeC(vMin);
  w.zeros(1);
  w.writeH(o.token.length).writeB(o.token);
  return w;
}

/** PROTOCOL_BASE_LOGIN_ACK (1283). */
export function parseLoginAck(r: PacketReader): LoginResult {
  r.readH(); // 0
  const verificationKey = r.readD();
  r.skip(3 + 9);
  r.readD(); // features
  r.readH(); // 1531
  r.skip(16);
  let playerId = 0n;
  let username = "";
  // Success block: C len, S pidStr, C 0, C len, S username, Q playerId. Failure: 11 zero bytes.
  const pidLen = r.readC();
  if (pidLen > 0) {
    r.readS(pidLen);
    r.readC();
    username = r.readS(r.readC());
    playerId = r.readQ();
  } else {
    r.skip(10);
  }
  const error = r.readD();
  return { error, errorName: errorName(error), ok: error === 0, playerId, username, verificationKey };
}

/** PROTOCOL_BASE_GAME_SERVER_STATE_ACK (2400). */
export function parseServerList(r: PacketReader): GameServerInfo[] {
  r.readH();
  const count = r.readC();
  const list: GameServerInfo[] = [];
  for (let i = 0; i < count; i++) {
    const online = r.readD() !== 0;
    const ipb = r.readB(4);
    r.skip(4);
    const port = r.readH();
    const type = r.readC();
    const maxPlayers = r.readH();
    const players = r.readSignedD();
    // 11 channel type bytes (ChannelsXML must hold 11 channels per server) + C type + C 0 + H 0
    const channelTypes = [...r.readB(11)];
    r.skip(4);
    list.push({ index: i, online, ip: [...ipb].join("."), port, type, maxPlayers, players, channelTypes });
  }
  return list;
}

/** PROTOCOL_BASE_GET_CHANNELLIST_ACK (2333), same on Auth and Game. */
export function parseChannelList(r: PacketReader): ChannelListInfo {
  r.skip(4 + 4 + 4 + 2 + 1);
  const n = r.readC();
  const channelPlayers: number[] = [];
  for (let i = 0; i < n; i++) channelPlayers.push(r.readH());
  r.readH(); // 310
  const maxPerChannel = r.readH();
  return { channelPlayers, maxPerChannel };
}

export class AuthClient {
  readonly conn: PbConnection;
  login: LoginResult | null = null;
  /** fetchMeta() result: profile, 2319 inventory, wallet, raw Auth 2453. */
  meta: AuthMeta | null = null;

  constructor(serverUrl = defaultServerUrl()) {
    this.conn = new PbConnection("auth", serverUrl);
  }

  async connectAndLogin(o: LoginOptions): Promise<LoginResult> {
    await this.conn.connect();
    const ack = this.conn.waitFor(Op.BASE_LOGIN_ACK, 10000);
    this.conn.send(Op.BASE_LOGIN_REQ, buildLoginBody(o));
    this.login = parseLoginAck(await ack);
    return this.login;
  }

  /**
   * 2316 -> 2318 -> 2320 -> 1060 after LOGIN_ACK, before USER_LEAVE. 2316 answers
   * once per Auth session (it loads the inventory), so the result is cached. Warns when the Auth 2453 lists
   * characters whose INSERT failed (stock objectId): the Game will then duplicate a character slot.
   */
  async fetchMeta(timeoutMs = 5000): Promise<AuthMeta> {
    if (this.meta) return this.meta;
    const meta = await fetchAuthMeta(this.conn, timeoutMs);
    try {
      const bad = meta.charaInfoRaw ? unsavedCharas(parseCharaInfo(new PacketReader(meta.charaInfoRaw))) : [];
      if (bad.length) console.warn("[auth] 2453: characters not saved, the Game will duplicate a slot", bad);
    } catch { /* malformed 2453: MetaSession falls back to charaInfo = null */ }
    return (this.meta = meta);
  }

  async getServers(): Promise<GameServerInfo[]> {
    const ack = this.conn.waitFor(Op.BASE_GAME_SERVER_STATE_ACK);
    this.conn.send(Op.BASE_GAME_SERVER_STATE_REQ);
    return parseServerList(await ack);
  }

  /** Server silently drops the request if ChannelsXML != 11 channels or < 1s since last call. */
  async getChannels(serverId: number, timeoutMs = 3000): Promise<ChannelListInfo | null> {
    const ack = this.conn.waitFor(Op.BASE_GET_CHANNELLIST_ACK, timeoutMs);
    this.conn.send(Op.BASE_GET_CHANNELLIST_REQ, new PacketWriter().writeD(serverId));
    try {
      return parseChannelList(await ack);
    } catch {
      return null;
    }
  }

  /** USER_LEAVE -> server closes without resetting online status (required before Game USER_ENTER). */
  async leave(): Promise<void> {
    if (!this.conn.isOpen) return;
    const ack = this.conn.waitFor(Op.BASE_USER_LEAVE_ACK, 3000).catch(() => null);
    this.conn.send(Op.BASE_USER_LEAVE_REQ);
    await ack;
    this.conn.close();
  }
}

export function gameTargetForServer(s: GameServerInfo): "game1" | "game2" | "game3" {
  const byPort = s.port - 39190;
  const n = byPort >= 1 && byPort <= 3 ? byPort : Math.min(Math.max(s.index, 1), 3);
  return `game${n}` as "game1" | "game2" | "game3";
}
