// /signal ticket: proof that a /signal socket belongs to the account sitting in that slot of that
// battle. Server.Game mints it at PRESTARTBATTLE and hands it only to that account's own /tcp session (a WebSocket text
// frame, outside the PB stream: game/roomHandlers.ts handlePreStartBattle); the client sends it as the first /signal frame
// ({t:"auth", ticket}). Format: base64url("<room key>.<slot>.<playerId>.<expiry unix s>") + "." + base64url(HMAC-SHA256).
// The secret is random per process (one Cloud Run instance holds both Game and /signal) and never leaves the server.
// No dependency besides node:crypto: the P2P tests (src/p2p/test) import it to mint their own tickets.
//
// Enter ticket, same MAC: the Auth mints it on a successful LOGIN and hands it to that /tcp session
// ({t:"enterTicket", pid, ticket} text frame, auth/authServer.ts handleLogin); the client sends it as {t:"enter", ticket} on
// the Game socket before USER_ENTER (web/wsSocket.ts), and the Game only enters the account the ticket names. Body
// "enter.<playerId>.<expiry unix s>": never parses as a /signal ticket and vice versa.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

let secret = randomBytes(32);
/** Only for tools/signal-server.ts (the P2P tests share the secret with it); the game server keeps its random one. */
export function setSignalTicketSecret(s: string | Buffer): void { secret = Buffer.from(s); }

/** long enough for any battle (and its host changes / reconnects); the room check on /signal is what bounds it */
export const SIGNAL_TICKET_TTL_MS = 3 * 3600 * 1000;
/** [RECRIADO] one login's Game hand-offs (server changes included); prod relogs every 60 min anyway (Cloud Run WS cap, reconnect) */
export const ENTER_TICKET_TTL_MS = 12 * 3600 * 1000;

const mac = (body: string) => createHmac("sha256", secret).update(body).digest();

function mint(claims: string, ttlMs: number, now: number): string {
  const body = Buffer.from(`${claims}.${Math.floor((now + ttlMs) / 1000)}`).toString("base64url");
  return `${body}.${mac(body).toString("base64url")}`;
}

/** The decoded body when the MAC is ours, else null (expiry is checked by the caller's pattern). */
function open(ticket: unknown): string | null {
  if (typeof ticket !== "string" || ticket.length > 256) return null;
  const [body, sig, extra] = ticket.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const want = mac(body), got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return Buffer.from(body, "base64url").toString();
}

export function mintSignalTicket(key: string, slot: number, playerId: bigint, ttlMs = SIGNAL_TICKET_TTL_MS, now = Date.now()): string {
  return mint(`${key}.${slot}.${playerId}`, ttlMs, now);
}

export interface SignalTicket { key: string; slot: number; playerId: bigint; exp: number }

/** The ticket's claims when its MAC is ours and it has not expired, else null. */
export function readSignalTicket(ticket: unknown, now = Date.now()): SignalTicket | null {
  const m = /^([0-9a-f]{1,8}-[0-9a-f]{1,8})\.(\d{1,2})\.(\d{1,20})\.(\d{1,12})$/.exec(open(ticket) ?? "");
  if (!m) return null;
  const exp = Number(m[4]) * 1000;
  return exp > now ? { key: m[1], slot: Number(m[2]), playerId: BigInt(m[3]), exp } : null;
}

export function mintEnterTicket(playerId: bigint, ttlMs = ENTER_TICKET_TTL_MS, now = Date.now()): string {
  return mint(`enter.${playerId}`, ttlMs, now);
}

/** The playerId an unexpired enter ticket of ours names, else null. */
export function readEnterTicket(ticket: unknown, now = Date.now()): bigint | null {
  const m = /^enter\.(\d{1,20})\.(\d{1,12})$/.exec(open(ticket) ?? "");
  return m && Number(m[2]) * 1000 > now ? BigInt(m[1]) : null;
}
