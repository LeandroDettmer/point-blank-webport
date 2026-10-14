// Runtime config, read from the same files the C# servers use so both backends agree:
//   server/runtime/Config/Settings.ini   (ConfigLoader: [Database], [Server] Test/ConnectionThrottleSeconds/ConfigId,
//                                         [Essentials] MinUserSize/MaxUserSize, [Internal] UpdateIntervalPlayersServer)
//   server/runtime/Data/ServerConfig.json (ServerConfigJSON: ClientVersion, AccessUFL, Enable*, ChannelOnlyGM)
//   server/runtime/Data/Events/Play.json  (EventPlaytimeXML: running event -> LOGIN_ACK features bit 0x100)
//   server/.env.local                     (PB_DB_*, PB_ADVERTISE_HOST), overridden by process.env
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SERVER_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2];
  }
  return out;
}

/** Tiny INI reader: section -> key -> value (C# ConfigEngine semantics: `Key = Value`, `;` comments). */
export function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let sec = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const s = /^\[(.+)\]$/.exec(line);
    if (s) { sec = s[1]; out[sec] ??= {}; continue; }
    const eq = line.indexOf("=");
    if (eq > 0) (out[sec] ??= {})[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const fileEnv = readEnvFile(path.join(SERVER_DIR, ".env.local"));
const env = (k: string, d = ""): string => process.env[k] ?? fileEnv[k] ?? d;
// The C# servers run in Docker (TZ=UTC): DateTime.Now there is UTC. Same local clock here (PB_TZ overrides).
process.env.TZ = env("PB_TZ", "UTC");
const resolveServerPath = (p: string) => (path.isAbsolute(p) ? p : path.resolve(SERVER_DIR, p));

const CONFIG_DIR = resolveServerPath(env("PB_CONFIG_DIR", "./runtime/Config"));
const DATA_DIR = resolveServerPath(env("PB_DATA_DIR", "./runtime/Data"));
const ini = parseIni(readFileSync(path.join(CONFIG_DIR, "Settings.ini"), "utf8"));
const iniGet = (sec: string, k: string, d: string) => ini[sec]?.[k] ?? d;
const iniBool = (sec: string, k: string, d: boolean) => iniGet(sec, k, String(d)).toLowerCase() === "true";
const iniInt = (sec: string, k: string, d: number) => Number.parseInt(iniGet(sec, k, String(d)), 10);

export interface ServerConfigJson {
  ConfigId: number;
  ClientVersion: string;
  AccessUFL: boolean;
  UserFileList: string;
  ChannelOnlyGM: boolean;
  EnableClan: boolean;
  EnableTicket: boolean;
  EnableTags: boolean;
  EnablePlaytime: boolean;
  EnableMissions: boolean;
}

function loadServerConfig(configId: number): ServerConfigJson {
  const doc = JSON.parse(readFileSync(path.join(DATA_DIR, "ServerConfig.json"), "utf8")) as { Server: Record<string, string>[] };
  const row = doc.Server.find((s) => Number(s.ConfigId) === configId);
  if (!row) throw new Error(`ServerConfig.json: no ConfigId ${configId}`);
  const b = (k: string) => String(row[k]).toLowerCase() === "true";
  return {
    ConfigId: configId, ClientVersion: row.ClientVersion, AccessUFL: b("AccessUFL"), UserFileList: row.UserFileList,
    ChannelOnlyGM: b("ChannelOnlyGM"), EnableClan: b("EnableClan"), EnableTicket: b("EnableTicket"),
    EnableTags: b("EnableTags"), EnablePlaytime: b("EnablePlaytime"), EnableMissions: row.EnableMissions === undefined ? true : b("EnableMissions"),
  };
}

export interface PlaytimeEvent { id: number; begin: number; ended: number; priority: boolean; period: boolean }

function loadPlaytimeEvents(): PlaytimeEvent[] {
  const file = path.join(DATA_DIR, "Events", "Play.json");
  if (!existsSync(file)) return [];
  const doc = JSON.parse(readFileSync(file, "utf8")) as { List?: { Event?: { Id: number; Begin: number; Ended: number; Priority?: boolean; Period?: boolean }[] } };
  return (doc.List?.Event ?? []).map((e) => ({ id: e.Id, begin: e.Begin, ended: e.Ended, priority: !!e.Priority, period: !!e.Period }));
}

const configId = iniInt("Server", "ConfigId", 1);

export const config = {
  serverDir: SERVER_DIR,
  configDir: CONFIG_DIR,
  intervalEnterRoomAfterKickSeconds: iniInt("Internal", "IntervalEnterRoomAfterKickSeconds", 30),
  dataDir: DATA_DIR,
  /** PB_DB_URL (postgres://user:pass@host:port/db, e.g. the Supabase pooler) replaces host/port/name/user/pass below. */
  dbUrl: env("PB_DB_URL", ""),
  /** PB_DB_SSL=1: TLS to Postgres (Supabase, public Cloud SQL); PB_DB_SSL_STRICT=1 also verifies the certificate chain. */
  dbSsl: env("PB_DB_SSL", "") === "1",
  dbSslStrict: env("PB_DB_SSL_STRICT", "") === "1",
  db: {
    host: env("PB_DB_HOST", iniGet("Database", "Host", "127.0.0.1").replace(/^localhost$/, "127.0.0.1")),
    port: Number(env("PB_DB_PORT", iniGet("Database", "Port", "5433"))),
    database: env("PB_DB_NAME", iniGet("Database", "Name", "pb")),
    user: env("PB_DB_USER", iniGet("Database", "User", "postgres")),
    password: env("PB_DB_PASS", iniGet("Database", "Pass", "postgres")),
  },
  /** TS Auth listener. 39190 is the .NET Auth (Docker); the TS one runs beside it until F6. */
  authHost: env("PB_TS_AUTH_HOST", "0.0.0.0"),
  authPort: Number(env("PB_TS_AUTH_PORT", "39290")),
  /** TS Game listeners, one per system_servers game row id 1..3 (.NET uses 39191-39193). */
  gameHost: env("PB_TS_GAME_HOST", "0.0.0.0"),
  gamePortBase: Number(env("PB_TS_GAME_PORT_BASE", "39290")),
  /** HTTP/WebSocket front for the browser (web/webServer.ts): /tcp, /signal, /api. */
  webHost: env("PB_WEB_HOST", "0.0.0.0"),
  webPort: Number(env("PB_WEB_PORT", env("PORT", "8090"))), // PORT: injected by Cloud Run
  /** extra exact origins allowed by CORS (/api) and the WS upgrade, comma list (prod front, e.g. https://<project>.web.app) */
  webOrigins: env("PB_WEB_ORIGINS", "").split(",").map((s) => s.trim()).filter(Boolean),
  /** PB_TRUST_PROXY=1: client IP = last X-Forwarded-For entry (appended by the Cloud Run front end), not the socket peer */
  trustProxy: env("PB_TRUST_PROXY", "") === "1",
  /** PB_NO_TCP=1: no raw TCP listeners for Auth/Game (39290-39293); the browser still reaches them over WS /tcp */
  noTcp: env("PB_NO_TCP", "") === "1",
  /** PB_IDLE_KICK_MIN=N: drop a session with no player input for N min (keep-alive and room-list polling do not count),
   * never during a battle. 0 = off: only the 10 min no-packet timeout of TcpSession. */
  idleKickMin: Number(env("PB_IDLE_KICK_MIN", "0")) || 0,
  /** per-WebSocket message bucket (burst, sustained/s) and concurrent WebSockets per non-loopback IP */
  webMsgBurst: Number(env("PB_WEB_MSG_BURST", "300")),
  webMsgPerSec: Number(env("PB_WEB_MSG_PER_SEC", "150")),
  webMaxConnPerIp: Number(env("PB_WEB_MAX_CONN_PER_IP", "32")),
  /** per-session PB packet bucket of TcpSession (burst, sustained/s), counted before the decrypt: one WS message can carry thousands of frames
   * [RECRIADO: the web client sends a few per second, 17 at most at once (3666 per slot)] */
  pktBurst: Number(env("PB_PKT_BURST", "60")),
  pktPerSec: Number(env("PB_PKT_PER_SEC", "30")),
  /** SChannelXML.Apply: PB_ADVERTISE_HOST replaces system_servers.host. */
  advertiseHost: env("PB_ADVERTISE_HOST", ""),
  testMode: iniBool("Server", "Test", false),
  throttleSeconds: iniInt("Server", "ConnectionThrottleSeconds", 0),
  minUserSize: iniInt("Essentials", "MinUserSize", 4),
  maxUserSize: iniInt("Essentials", "MaxUserSize", 16),
  minPassSize: iniInt("Essentials", "MinPassSize", 4),
  updateIntervalPlayersServer: iniInt("Internal", "UpdateIntervalPlayersServer", 2),
  server: loadServerConfig(configId),
  /** [Others] UdpType (PRESTART), Match UDP port advertised in 5130 */
  udpType: iniInt("Others", "UdpType", 3),
  matchPort: Number(env("PB_MATCH_PORT", "40009")),
  maxExpReward: iniInt("Internal", "MaxExpReward", 1000),
  maxGoldReward: iniInt("Internal", "MaxGoldReward", 1000),
  maxCashReward: iniInt("Internal", "MaxCashReward", 1000),
  winCashPerBattle: iniBool("Internal", "WinCashPerBattle", false),
  showCashReceiveWarn: iniBool("Internal", "ShowCashReceiveWarn", false),
  maxLatency: iniInt("Internal", "MaxLatency", 0),
  maxRepeatLatency: iniInt("Internal", "MaxRepeatLatency", 0),
  maxBuyItemDays: iniInt("Internal", "MaxBuyItemDays", 0),
  maxBuyItemUnits: iniInt("Internal", "MaxBuyItemUnits", 0),
  minCreateRank: iniInt("Internal", "MinCreateRank", 0),
  minCreateGold: iniInt("Internal", "MinCreateGold", 0),
  maxActiveClans: iniInt("Internal", "MaxActiveClans", 0),
  playtimeEvents: loadPlaytimeEvents(),
  /** chat / report / vote rules of [RECRIADO: the originals are rank 7 (report) and ConfigLoader.MinRankVote]. */
  reportMinRank: Number(env("PB_REPORT_MIN_RANK", "3")),
  reportTickets: Number(env("PB_REPORT_TICKETS", "3")),
  voteMinRank: Number(env("PB_VOTE_MIN_RANK", "5")),
};

/** DateTimeUtil.Now + "0000" as uint, local time like the C# server. */
export function yyMMdd0000(d = new Date()): number {
  const p = (n: number) => String(n).padStart(2, "0");
  return Number(`${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}0000`);
}

/** EventPlaytimeXML.GetRunningEvent (priority event wins). */
export function runningPlaytimeEvent(now = new Date()): PlaytimeEvent | null {
  const date = yyMMdd0000(now);
  let active: PlaytimeEvent | null = null;
  for (const e of config.playtimeEvents) {
    const b = Math.floor(e.begin / 10000) * 10000, en = Math.floor(e.ended / 10000) * 10000;
    if (b <= date && date < en && (!active || (e.priority && !active.priority))) {
      active = e;
      if (e.priority) break;
    }
  }
  return active;
}
