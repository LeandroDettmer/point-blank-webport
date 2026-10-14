// TS port of Server.Auth (F1): AuthManager (listener, session ids, throttle), AuthClient.RunPacket dispatch and the
// handlers the web client uses before handing off to Game: 1281 LOGIN (token), 1060 GET_POINT_CASH,
// 1059/2399 GAME_SERVER_STATE, 2332 GET_CHANNELLIST, 2328 USER_LEAVE, 2309 KEEP_ALIVE.
// F1b account meta: 2316 GET_USER_INFO, 2318 GET_INVEN_INFO, 2320 GET_OPTION (see ./meta.ts).
// Not ported yet (logged and ignored like any unknown opcode): 2322, 2314, 2414, 2459, 2489, 2520, 8709, 1127,
// 7681/7697/7699, 2307.
import net from "node:net";
import type { PacketReader } from "../../../src/net/packet.ts";
import { config, runningPlaytimeEvent } from "../config.ts";
import * as db from "../db.ts";
import { TcpSession } from "../net/tcpSession.ts";
import type { Account } from "../shared/account.ts";
import * as dao from "../shared/dao.ts";
import { handleGetUserInfo, handleGetInvenInfo, handleGetOption } from "./meta.ts";
import { clanMemberInfoAck, refreshAccount } from "../game/socialHandlers.ts";
import { kickGameSession } from "../game/gameServer.ts";
import { mintEnterTicket } from "../web/signalTicket.ts";
import {
  EventError, ChannelType, SChannelType, parseEnum, validateKey, loginAck, pointCashAck, gameServerStateAck,
  channelListAck, userLeaveAck, disconnectionSuccessAck, accountKickAck, serverMessageErrorAck,
  type ServerEntry, type ChannelEntry,
} from "./packets.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} [auth-ts] ${m}`);

interface AuthState {
  session: TcpSession;
  player: db.AccountRow | null;
  /** The full Account (sub-models) the meta handlers use: GetAccountDB(token, 95), then SetPlayerId(8159|16). */
  acc: Account | null;
  lastChannelList: number;
}

const sessions = new Map<number, AuthState>();
const lastConnectByIp = new Map<string, number>();
const lastLoginByIp = new Map<string, number>();

let servers: ServerEntry[] = [];
let channels: ChannelEntry[] = [];

/** SChannelXML.Load + ChannelsXML.Load (DB only; the XML fallbacks are not used by this deployment). */
export async function loadServerData(): Promise<void> {
  const [srv, ch] = await Promise.all([db.systemServers(), db.systemChannels()]);
  servers = srv.map((s) => ({
    id: s.id, state: s.state, host: config.advertiseHost || s.host, port: s.port, type: parseEnum(SChannelType, s.type),
    maxPlayers: s.maxPlayers, lastPlayers: 0, channelPlayers: s.channelPlayers,
  }));
  channels = ch.map((c) => ({ serverId: c.serverId, id: c.id, type: parseEnum(ChannelType, c.type), totalPlayers: 0 }));
}

let lastRefresh = 0;
/** UpdateServer.RefreshSChannel(0): server 0 LastPlayers = Auth socket count, throttled by UpdateIntervalPlayersServer. */
function refreshAuthServerCount(): void {
  if ((Date.now() - lastRefresh) / 1000 < config.updateIntervalPlayersServer) return;
  lastRefresh = Date.now();
  const s0 = servers.find((s) => s.id === 0);
  if (s0) s0.lastPlayers = sessions.size;
}

/** Game server/channel counts (C#: Game -> Auth sync ops 15/33; here: accounts.status, see db.onlineCounts). */
async function refreshGameCounts(): Promise<void> {
  const c = await db.onlineCounts();
  for (const s of servers) if (s.id !== 0) s.lastPlayers = c.servers.get(s.id) ?? 0;
  for (const ch of channels) ch.totalPlayers = c.channels.get(`${ch.serverId}:${ch.id}`) ?? 0;
}

/** AccountStatus.SetData(uint.MaxValue) + UpdateServer(0): [ch=FF, room=FF, server=0, clanMatch=FF]. */
const STATUS_AUTH = 0xff00ffff;
const STATUS_NONE = 0xffffffff;

function macString(mac: Uint8Array, sep: string, upper: boolean): string {
  const s = [...mac].map((b) => b.toString(16).padStart(2, "0")).join(sep);
  return upper ? s.toUpperCase() : s;
}

interface LoginReq {
  hwSpec0: number;
  mac: Uint8Array;
  resolution: string;
  userFileList: string;
  locale: number;
  clientVersion: string;
  token: string;
}

/** PROTOCOL_BASE_LOGIN_REQ.Read(). */
function readLogin(r: PacketReader, raw: Uint8Array): LoginReq {
  const body = raw.subarray(4);
  const hwSpec0 = body.length >= 5 ? new DataView(body.buffer, body.byteOffset + 1, 4).getUint32(0, true) : 0;
  r.skip(4);
  const mac = r.readB(6);
  r.skip(21);
  const resolution = `${r.readH()}x${r.readH()}`;
  r.skip(10);
  const userFileList = r.readS(r.readC());
  r.skip(16);
  const locale = r.readC();
  const clientVersion = `${r.readC()}.${r.readC()}`;
  r.skip(1);
  const token = Buffer.from(r.readB(r.readH())).toString("base64");
  return { hwSpec0, mac, resolution, userFileList, locale, clientVersion, token };
}

/** Account.AuthLevel(): BANNED / GAMEMASTER(100) / MODERATOR(50) / rank 58 GM, 59 MOD / NORMAL. */
function authLevel(a: db.AccountRow): number {
  if (a.access === -1) return -1;
  if (a.access >= 100) return 100;
  if (a.access >= 50) return 50;
  return a.rank === 58 ? 100 : a.rank === 59 ? 50 : 0;
}

/** AllUtils.GetFeatures(). */
function features(): number {
  let f = 0x87fd776e;
  const s = config.server;
  if (!s.EnableClan) f -= 0x1000;
  if (!s.EnableTicket) f -= 0x4000;
  if (!s.EnableTags) f -= 0x4000000;
  if (!s.EnablePlaytime || !runningPlaytimeEvent()) f -= 0x100;
  return f >>> 0;
}

async function handleLogin(st: AuthState, req: LoginReq): Promise<void> {
  const c = st.session;
  const now = Date.now();
  const prev = lastLoginByIp.get(c.ip);
  lastLoginByIp.set(c.ip, now);
  if (prev !== undefined && now - prev < 1000) {
    log(`duplicate login attempt blocked for ${c.ip}`);
    c.close(false, 1000);
    return;
  }
  const player = (st.player = await db.accountByToken(req.token));
  st.acc = player ? await dao.getAccountDB("player_id", player.playerId, 95, true) : null; // by id: accounts.token is a hash
  st.lastChannelList = Date.now(); // Account() ctor: LastChannelList = load time
  if (!player) {
    c.send(loginAck(EventError.LOGIN_ID_PASS_INCORRECT, 0, features(), null));
    log(`invalid token from ${c.ip}`);
    c.close(false, 1000);
    return;
  }
  const s = config.server;
  const valid = player.username.length >= config.minUserSize && player.username.length <= config.maxUserSize
    && (config.testMode || player.password.length >= config.minPassSize)
    && req.mac.some((b) => b !== 0)
    && req.clientVersion === s.ClientVersion
    && (!s.AccessUFL || req.userFileList === s.UserFileList)
    && req.resolution !== "0x0";
  // !IsTestMode && !GameLocales.Contains(locale) is skipped: Settings.ini Test=True locally.
  if (!valid) {
    c.send(disconnectionSuccessAck(EventError.DISCONNECT_INVALID_LOGIN));
    log(`login validation failed [${player.username}] ver=${req.clientVersion} res=${req.resolution}`);
    c.close(true, 1000);
    return;
  }
  const deny = (code: number, why: string) => {
    c.send(loginAck(code, 0, features(), player));
    log(`${why} [${player.username}]`);
    c.close(false, 1000);
  };
  const ban = await db.activeBanForPlayer(player.playerId);
  if (ban && ban.expire.getTime() > Date.now()) {
    if (player.banObjectId !== ban.objectId) {
      player.banObjectId = ban.objectId;
      await db.updateAccount(player.playerId, "ban_object_id", String(ban.objectId));
    }
    return deny(EventError.LOGIN_BLOCK_ACCOUNT, "account banned");
  }
  if (await db.isBanned(player)) return deny(EventError.LOGIN_BLOCK_ACCOUNT, "permanently banned");
  // C#: `player.MacAddress != _macAddress` compares PhysicalAddress references, so it always writes.
  await db.updateAccount(player.playerId, "mac_address", macString(req.mac, ":", false));
  const bans = await db.banStatus(macString(req.mac, "", true), c.ip);
  if (bans.mac || bans.ip) return deny(bans.ip ? EventError.LOGIN_BLOCK_IP : EventError.LOGIN_BLOCK_ACCOUNT, bans.mac ? "MAC blocked" : "IP blocked");
  const lvl = authLevel(player);
  const hasAccess = (lvl > 0 && s.ChannelOnlyGM) || (lvl >= 0 && !s.ChannelOnlyGM);
  if (!hasAccess) return deny(EventError.LOGIN_TIME_OUT_2, "invalid access level");
  if (player.online) {
    c.send(loginAck(EventError.LOGIN_ALREADY_LOGIN, 0, features(), player));
    log(`account online [${player.username}]`);
    const other = [...sessions.values()].find((x) => x !== st && x.player?.playerId === player.playerId);
    if (other) {
      other.session.send(accountKickAck());
      other.session.send(serverMessageErrorAck(0x80001000));
      other.session.close(true, 1000);
    } else {
      // C# AuthLogin.SendLoginKickInfo: status server 0 / 255 (no Game session) -> SetOnlineStatus(false); else sync op 10 to
      // that Game server (Server.Game AuthLogin.Load: kick). Same process here, so a direct call.
      const srv = (player.status >>> 16) & 0xff;
      if (srv === 0 || srv === 0xff) await db.updateAccount(player.playerId, "online", false);
      else if (!kickGameSession(player.playerId)) log(`kick of [${player.username}] on Game server ${srv}: no live session`);
    }
    c.close(false, 1000);
    return;
  }
  if (player.banObjectId > 0n) {
    const exp = await db.accountBanExpire(player.banObjectId);
    if (exp && exp.getTime() > Date.now()) return deny(EventError.LOGIN_BLOCK_ACCOUNT, "account with active ban");
  }
  // CompleteSuccessfulLogin (FlagCountryLATAM needs an external IP lookup; skipped, country_flags untouched)
  if (st.acc) await dao.getAccountInfos(st.acc, 8159 | 16);
  // [web]the Game's proof of this login (the C# Auth told the Game by its internal sync); a text frame, outside the PB stream
  c.sendText({ t: "enterTicket", pid: String(player.playerId), ticket: mintEnterTicket(player.playerId) });
  c.send(loginAck(EventError.SUCCESS, validateKey(player.playerId, c.sessionId, req.hwSpec0), features(), player));
  c.send(pointCashAck(0, player));
  if (player.clanId > 0 && st.acc) c.send(await clanMemberInfoAck(st.acc));
  player.status = STATUS_AUTH;
  if (st.acc) { st.acc.status.setData(STATUS_AUTH); st.acc.isOnline = true; }
  await db.updateAccount(player.playerId, "status", STATUS_AUTH);
  player.online = true;
  await db.updateAccount(player.playerId, "online", true);
  log(`Account User: ${player.username}, Player UID: ${player.playerId}, Is Connected`);
  if (st.acc) await refreshAccount(st.acc, true);
  refreshAuthServerCount();
}

async function onPacket(st: AuthState, opcode: number, r: PacketReader, raw: Uint8Array): Promise<void> {
  const c = st.session;
  switch (opcode) {
    case 1281:
      return handleLogin(st, readLogin(r, raw));
    case 1060:
      if (st.player) c.send(pointCashAck(0, st.player));
      return;
    case 1059:
    case 2399:
      await refreshGameCounts();
      c.send(gameServerStateAck(servers, channels));
      return;
    case 2332: {
      const serverId = r.readSignedD();
      if (!st.player) return;
      if (serverId <= 0) { c.log(`invalid ServerId ${serverId}, ignoring`); return; }
      if (Date.now() - st.lastChannelList < 1000) { c.log("channel list request too frequent, ignoring"); return; }
      const list = channels.filter((x) => x.serverId === serverId);
      const server = servers.find((x) => x.id === serverId);
      if (list.length === 11 && server) {
        await refreshGameCounts();
        c.send(channelListAck(server, list));
      } else {
        c.log(`expected 11 channels but found ${list.length} for server ${serverId}`);
      }
      st.lastChannelList = Date.now();
      return;
    }
    case 2328:
      c.send(userLeaveAck(0));
      c.close(false);
      return;
    case 2309:
      return;
    case 2316:
      if (st.acc) await handleGetUserInfo(c, st.acc);
      return;
    case 2318:
      if (st.acc) handleGetInvenInfo(c, st.acc);
      return;
    case 2320:
      if (st.acc) await handleGetOption(c, st.acc);
      return;
    default:
      c.log(`unhandled opcode ${opcode} (${raw.length}b) session ${c.sessionId}`);
  }
}

/** AuthClient.Close: destroy -> online=false and status reset (AccountStatus.ResetData); soft close keeps both. */
async function onClose(st: AuthState, destroy: boolean): Promise<void> {
  sessions.delete(st.session.sessionId);
  const p = st.player;
  st.player = null;
  st.acc = null;
  if (destroy && p) {
    if (p.online) {
      await db.updateAccount(p.playerId, "online", false);
      log(`Account User: ${p.username}, Player UID: ${p.playerId}, Is Disconnected`);
    }
    if (p.status !== STATUS_NONE) await db.updateAccount(p.playerId, "status", STATUS_NONE);
  }
  refreshAuthServerCount();
}

function isLoopback(ip: string): boolean {
  return ip === "::1" || ip.startsWith("127.");
}

/** AuthManager.AddSession: per-IP throttle (Settings.ini ConnectionThrottleSeconds, loopback exempt), ids 1..99999. */
export function accept(sock: net.Socket): void {
  const ip = (sock.remoteAddress ?? "").replace(/^::ffff:/, "");
  const now = Date.now();
  if (config.throttleSeconds > 0 && !isLoopback(ip)) {
    const last = lastConnectByIp.get(ip);
    if (last !== undefined && (now - last) / 1000 < config.throttleSeconds) {
      setTimeout(() => sock.destroy(), 500);
      return;
    }
    lastConnectByIp.set(ip, now);
  }
  let id = 1;
  while (id < 100000 && sessions.has(id)) id++;
  if (id >= 100000) { sock.destroy(); return; }
  const st = { player: null, acc: null, lastChannelList: 0 } as unknown as AuthState;
  st.session = new TcpSession(sock, id, {
    firstPacketIds: [1281, 2309],
    onPacket: (op, r, raw) => onPacket(st, op, r, raw),
    onClose: (destroy) => onClose(st, destroy),
    log,
  });
  sessions.set(id, st);
  st.session.start().catch((e) => { log(`session start failed ${e}`); st.session.close(true); });
}

export async function startAuthServer(host = config.authHost, port = config.authPort): Promise<net.Server> {
  await loadServerData();
  // This process is the sole owner of accounts.online; a stopped server never runs onClose(destroy=true) for its
  // still-open sockets (net.Server.close() only stops new connections), so a restart with players connected leaves
  // them stuck online=true forever ("EVENT_LOG_IN_ALREADY_LOGIN" on their next login). Boot is the only safe place
  // to know, so clear it here instead of trying to catch every SIGTERM path.
  const reset = await db.pool.query("UPDATE accounts SET online = false WHERE online = true");
  if (reset.rowCount) log(`reset ${reset.rowCount} stale online=true account(s) from a previous run`);
  const srv = net.createServer(accept);
  // PB_NO_TCP (prod): the server object stays (main.ts counts/closes it) but never listens; sessions come over WS /tcp
  if (config.noTcp) {
    log(`no TCP listener (PB_NO_TCP), WS /tcp only (${servers.length} servers, ${channels.length} channels, features 0x${features().toString(16)})`);
    return srv;
  }
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, host, () => resolve());
  });
  log(`listening on ${host}:${port} (${servers.length} servers, ${channels.length} channels, features 0x${features().toString(16)})`);
  return srv;
}
