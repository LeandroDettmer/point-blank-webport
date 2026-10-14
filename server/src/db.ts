// Postgres access for the TS servers. Same database/schema as the C# servers (DaoManagerSQL, ComDiv.UpdateDB,
// AccountManager.GetAccountDB); every statement below names the C# code it mirrors.
import pg from "pg";
import { config } from "./config.ts";
import { storedToken, isStoredToken } from "./web/accounts/token.ts";

// keepAlive: Docker / the OS drop idle Postgres sockets after a few minutes; without a listener the pool's "error" event (an idle client
// that died) is uncaught and Node exits: every player is then disconnected at once ("upstream closed") while AFK in a match.
// PB_DB_URL replaces the discrete settings; PB_DB_SSL turns TLS on (the hosted Postgres certificate is only checked
// with PB_DB_SSL_STRICT, the Supabase pooler presents its own CA). pg lets a "?sslmode=" of the URL override the ssl
// object (and reads sslmode=require as verify-full), so with PB_DB_SSL set it is dropped from the URL.
function dbUrl(): string {
  if (!config.dbSsl) return config.dbUrl;
  const u = new URL(config.dbUrl);
  u.searchParams.delete("sslmode");
  return u.toString();
}
export const pool = new pg.Pool({
  ...(config.dbUrl ? { connectionString: dbUrl() } : config.db),
  ...(config.dbSsl ? { ssl: { rejectUnauthorized: config.dbSslStrict } } : {}),
  max: 8, keepAlive: true, keepAliveInitialDelayMillis: 10000,
});
pool.on("error", (e) => console.warn(`[db] idle client error (ignored, the pool reconnects): ${e.message}`));

export interface AccountRow {
  playerId: bigint;
  username: string;
  password: string;
  nickname: string;
  rank: number;
  gold: number;
  cash: number;
  tags: number;
  access: number;
  online: boolean;
  clanId: number;
  banObjectId: bigint;
  status: number;
}

const int = (v: unknown) => (v == null ? 0 : Number(v));

/**
 * AccountManager.GetAccountDB(token, null, 0, ...): "SELECT * FROM accounts WHERE token=@valor LIMIT 1".
 * accounts.token holds storedToken(token) (a hash); a row still holding the plaintext token (made before hashing,
 * or provisioned by hand with tools/web-token.ts) also matches and is rewritten to the hashed form.
 */
export async function accountByToken(token: string): Promise<AccountRow | null> {
  if (!token || isStoredToken(token)) return null; // a stored hash is never a credential
  const hashed = storedToken(token);
  const r = await pool.query(
    `SELECT player_id, username, password, nickname, rank, gold, cash, tags, access_level, online, clan_id,
            ban_object_id, status, token FROM accounts WHERE token=$1 OR token=$2 LIMIT 1`, [hashed, token]);
  const x = r.rows[0];
  if (!x) return null;
  if (x.token !== hashed) await pool.query("UPDATE accounts SET token=$1 WHERE player_id=$2 AND token=$3", [hashed, x.player_id, token]);
  return {
    playerId: BigInt(x.player_id), username: x.username ?? "", password: x.password ?? "", nickname: x.nickname ?? "",
    rank: int(x.rank), gold: int(x.gold), cash: int(x.cash), tags: int(x.tags), access: int(x.access_level),
    online: !!x.online, clanId: int(x.clan_id), banObjectId: BigInt(x.ban_object_id ?? 0), status: int(x.status) >>> 0,
  };
}

/** ComDiv.UpdateDB("accounts", col, value, "player_id", id). */
export async function updateAccount(playerId: bigint, column: "online" | "status" | "mac_address" | "ban_object_id", value: unknown): Promise<void> {
  await pool.query(`UPDATE accounts SET ${column}=$1 WHERE player_id=$2`, [value, String(playerId)]);
}

/** DaoManagerSQL.GetActiveBanForPlayer. MUTE rows (chat mute, :mute / report auto-mute) are not a login ban: Account.IsBanned ignores Type MUTE. */
export async function activeBanForPlayer(playerId: bigint): Promise<{ objectId: bigint; expire: Date } | null> {
  const r = await pool.query(
    `SELECT object_id, expire_date FROM base_ban_history WHERE (owner_id=$1 OR player_id=$1) AND expire_date > $2 AND type <> 'MUTE'
     ORDER BY object_id DESC LIMIT 1`, [String(playerId), new Date()]);
  return r.rows[0] ? { objectId: BigInt(r.rows[0].object_id), expire: r.rows[0].expire_date } : null;
}

/** DaoManagerSQL.GetAccountBan(object_id) expire date. */
export async function accountBanExpire(objectId: bigint): Promise<Date | null> {
  const r = await pool.query(`SELECT expire_date FROM base_ban_history WHERE object_id=$1`, [String(objectId)]);
  return r.rows[0]?.expire_date ?? null;
}

/** Account.IsBanned: access BANNED, or ANY base_auto_ban / base_ban_history row for the owner (expired included). */
export async function isBanned(a: AccountRow): Promise<boolean> {
  if (a.access === -1) return true;
  const r = await pool.query(
    `SELECT (SELECT count(*) FROM base_auto_ban WHERE owner_id=$1) + (SELECT count(*) FROM base_ban_history WHERE owner_id=$1 AND type <> 'MUTE') AS n`,
    [String(a.playerId)]);
  return Number(r.rows[0].n) > 0;
}

/** DaoManagerSQL.GetBanStatus(mac "0A1B2C3D4E5F", ip). */
export async function banStatus(mac: string, ip: string): Promise<{ mac: boolean; ip: boolean }> {
  const r = await pool.query(`SELECT type, value, expire_date FROM base_ban_history WHERE value IN ($1, $2)`, [mac, ip]);
  const out = { mac: false, ip: false };
  const now = Date.now();
  for (const x of r.rows) {
    if ((x.expire_date as Date).getTime() < now) continue;
    if (x.type === "MAC" && x.value === mac) out.mac = true;
    else if (x.type === "IP4" && x.value === ip) out.ip = true;
  }
  return out;
}

export interface ServerRow { id: number; state: boolean; host: string; port: number; type: string; isMobile: boolean; maxPlayers: number; channelPlayers: number }
export interface ChannelRow { serverId: number; id: number; type: string; maxRooms: number }

/** DaoManagerSQL.GetSystemServers. */
export async function systemServers(): Promise<ServerRow[]> {
  const r = await pool.query(`SELECT id, state, host, port, type, is_mobile, max_players, channel_players FROM system_servers ORDER BY id ASC`);
  return r.rows.map((x) => ({
    id: int(x.id), state: !!x.state, host: String(x.host), port: int(x.port), type: String(x.type), isMobile: !!x.is_mobile,
    maxPlayers: int(x.max_players), channelPlayers: int(x.channel_players),
  }));
}

/** DaoManagerSQL.GetSystemChannels. */
export async function systemChannels(): Promise<ChannelRow[]> {
  const r = await pool.query(`SELECT server_id, id, type, max_rooms FROM system_channels ORDER BY server_id ASC, id ASC`);
  return r.rows.map((x) => ({ serverId: int(x.server_id), id: int(x.id), type: String(x.type), maxRooms: int(x.max_rooms) }));
}

/**
 * Online players per game server / channel, from accounts.status (AccountStatus bytes: [0]=channel [1]=room
 * [2]=server [3]=clanMatch). The C# Auth gets these from the Game servers over the internal sync UDP (opcode 15
 * ServerCache / ChannelCache), which the TS Auth cannot reach while the Game runs in Docker; F2 replaces this.
 */
export async function onlineCounts(): Promise<{ servers: Map<number, number>; channels: Map<string, number> }> {
  const r = await pool.query(
    `SELECT (status >> 16) & 255 AS srv, status & 255 AS ch, count(*) AS n FROM accounts WHERE online GROUP BY 1, 2`);
  const servers = new Map<number, number>(), channels = new Map<string, number>();
  for (const x of r.rows) {
    const srv = int(x.srv), ch = int(x.ch), n = int(x.n);
    if (srv === 255) continue;
    servers.set(srv, (servers.get(srv) ?? 0) + n);
    if (ch !== 255) channels.set(`${srv}:${ch}`, n);
  }
  return { servers, channels };
}
