// WebRTC signaling for the leader-hosted match:
//   ws://HOST:<web port>/signal?room=<uniqueRoomId hex>-<roomSeed hex>&role=host|guest&slot=<0..17>
// A relay of small JSON messages keyed by the Server.Game room of the battle (UniqueRoomId + seed from PRESTARTBATTLE)
// and the slot; like the /tcp route it never touches the match itself.
// client, 1st frame {t:, ticket} (signalTicket.ts: minted by Server.Game at PRESTARTBATTLE for that account and slot)
// once verified -> {t:, role, ice:[RTCIceServer], hostOnline} (nothing, TURN included, before the ticket)
// guest -> host {t:, sid, sdp} (the relay adds slot) | {t:, sid, c} | {t:, sid}
// host -> guest {t:, sid, sdp} | {t:, sid, c} | {t:, sid} (routed by the sid's owner)
// relay -> guests {t:, online}
// relay -> any {t:, err, sid?}
// Rules: one host per room (a second gets 4009); one socket per guest slot (a new one replaces the old, 4001); a guest
// never uses the host's slot; sids are single use and bound to the guest that offered them; message <= 16 KiB;
// 40 msg/s with a burst of 80, then the socket is closed (1008).
// Admission: no valid ticket for this room key and slot within 5 s = 4005 BAD_TICKET / NO_TICKET. With a
// Game server in the process (signalGate) the ticket's account must also sit in that slot of the room's running match, and the
// host role is only for its leader (4004 NOT_IN_MATCH). The same check runs every 15 s on the open sockets (sweepSignal,):
// the battle ending, the account leaving the slot or its game session = 4004; a guest silent for 2 min = 4008 IDLE.
// Server authority, called by Server.Game, never by a peer:
// kickSlot(key, slot) closes that slot's socket (4003 KICKED), sends the host {t:, sid, slot} per live sid and {t:, slot},
//                             and refuses that slot on /signal for 60 s
// handoffHost(key, slot) atomic host change: the old host is detached at once (guests get {t:, online:false}) and its socket
//                             closed after a 3 s grace (4010 HOST_HANDOFF) so it can still send its {t:"handoff"} snapshot, relayed to the guest socket of the new leader; for 30 s only <slot> may take the host role (the others get 4009 HOST_RESERVED)
// Env: SIGNAL_STUN_URLS (default stun:stun.l.google.com:19302, "none" = no STUN), TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL
// (static TURN), CF_TURN_KEY_ID + CF_TURN_API_TOKEN (Cloudflare Realtime TURN: short-lived credentials, see cfTurn).
import type { WebSocket, RawData } from "ws";
import { readSignalTicket } from "./signalTicket.ts";

const env = (k: string, d = "") => process.env[k] ?? d;
const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);

interface IceServer { urls: string[]; username?: string; credential?: string }
function staticIceServers(): IceServer[] {
  const out: IceServer[] = [];
  const stun = env("SIGNAL_STUN_URLS", "stun:stun.l.google.com:19302");
  if (stun !== "none" && list(stun).length) out.push({ urls: list(stun) });
  const turn = list(env("TURN_URLS"));
  if (turn.length) {
    out.push({ urls: turn, ...(env("TURN_USERNAME") ? { username: env("TURN_USERNAME") } : {}), ...(env("TURN_CREDENTIAL") ? { credential: env("TURN_CREDENTIAL") } : {}) });
  }
  return out;
}

// Cloudflare Realtime TURN (developers.cloudflare.com/realtime/turn/generate-credentials):
//   POST https://rtc.live.cloudflare.com/v1/turn/keys/<CF_TURN_KEY_ID>/credentials/generate-ice-servers
// Authorization: Bearer <CF_TURN_API_TOKEN>, {: 7200} -> 201 {iceServers: [{urls}, {urls, username, credential}]}
// The 2 h credential is reused for CF_TURN_CACHE_SEC (30 min),
// so every peer of a match gets one valid for 1.5 h or more; a failed call leaves the STUN/static list alone for CF_TURN_RETRY_SEC
// before trying again. Port 53 URLs are dropped (browsers block
// them: the candidate would only time out). The API token never reaches a log or a peer.
const CF_TTL_SEC = 7200;
const cfCacheMs = () => Number(env("CF_TURN_CACHE_SEC", "1800")) * 1000;
const cfRetryMs = () => Number(env("CF_TURN_RETRY_SEC", "60")) * 1000;
let cfCache: { at: number; servers: IceServer[] } | null = null;
let cfFailedAt = -Infinity;
let cfPending: Promise<IceServer[]> | null = null;

const port53 = (u: string) => /:53(\?|$)/.test(u);
/** the last good credential while it still has 1 h of its 2 h left, else nothing */
const cfStillValid = () => (cfCache && Date.now() - cfCache.at < (CF_TTL_SEC - 3600) * 1000 ? cfCache.servers : []);

async function fetchCfTurn(keyId: string, token: string, log: (msg: string) => void): Promise<IceServer[]> {
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: CF_TTL_SEC }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { iceServers?: { urls?: string | string[]; username?: string; credential?: string }[] };
    const servers = (body.iceServers ?? []).map((s): IceServer => ({
      urls: [s.urls ?? []].flat().filter((u) => typeof u === "string" && !port53(u)),
      ...(s.username ? { username: s.username } : {}),
      ...(s.credential ? { credential: s.credential } : {}),
    })).filter((s) => s.urls.length);
    if (!servers.some((s) => s.urls.some((u) => /^turns?:/.test(u)))) throw new Error("no TURN url in the reply");
    cfCache = { at: Date.now(), servers };
    log(`cloudflare TURN credentials refreshed (${servers.reduce((n, s) => n + s.urls.length, 0)} urls)`);
    return servers;
  } catch (e) {
    cfFailedAt = Date.now();
    const old = cfStillValid();
    log(`cloudflare TURN credentials failed (${(e as Error).message}): ${old.length ? "reusing the previous one" : "STUN/static ICE only"}, retry in ${cfRetryMs() / 1000}s`);
    return old;
  }
}

function cfTurn(log: (msg: string) => void): Promise<IceServer[]> {
  const keyId = env("CF_TURN_KEY_ID"), token = env("CF_TURN_API_TOKEN");
  if (!keyId || !token) return Promise.resolve([]);
  const now = Date.now();
  if (cfCache && now - cfCache.at < cfCacheMs()) return Promise.resolve(cfCache.servers);
  if (now - cfFailedAt < cfRetryMs()) return Promise.resolve(cfStillValid());
  return (cfPending ??= fetchCfTurn(keyId, token, log).finally(() => { cfPending = null; }));
}

async function iceServers(log: (msg: string) => void): Promise<IceServer[]> {
  return [...staticIceServers(), ...(await cfTurn(log))];
}

const ROOM_RE = /^[0-9a-f]{1,8}-[0-9a-f]{1,8}$/;
const SID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_MSG = 16 * 1024;
const RATE = 40;
const BURST = 80;
const MAX_SIDS_PER_GUEST = 16;
/** the client sends its ticket as soon as the socket opens */
const AUTH_MS = 5000;
/** a guest only signals to set its link up (then it closes /signal); the host stays for the whole battle */
const GUEST_IDLE_MS = 120000;
const SWEEP_MS = 15000;

interface Peer { ws: WebSocket; role: "host" | "guest"; slot: number; playerId: bigint; tokens: number; last: number }
interface Room { host: Peer | null; guests: Map<number, Peer>; sids: Map<string, number>; reserved: { slot: number; until: number } | null }

const rooms = new Map<string, Room>();
const blocked = new Map<string, number>(); // `${key}/${slot}` -> until (ms)
const BLOCK_MS = 60000;
const RESERVE_MS = 30000;
/** the detached old host keeps its socket this long so it can still send the handoff snapshot */
const HANDOFF_GRACE_MS = 3000;
const isBlocked = (key: string, slot: number) => { const k = `${key}/${slot}`, t = blocked.get(k); if (t === undefined) return false; if (t > Date.now()) return true; blocked.delete(k); return false; };
/** the room key of a Server.Game room: UniqueRoomId + seed of the PRESTARTBATTLE (src/p2p/signaling.ts signalRoomKey) */
export const signalKey = (uniqueRoomId: number, seed: number) => `${(uniqueRoomId >>> 0).toString(16)}-${(seed >>> 0).toString(16)}`;
const reservedFor = (r: Room) => (r.reserved && r.reserved.until > Date.now() ? r.reserved : null);
/** Server.Game's admission check (gameServer.ts: RoomModel.maySignal of the room with that key, for the ticket's account). null =
 * no Game server in this process (tools/signal-server.ts, the P2P tests): a valid ticket is enough. */
export const signalGate: { allow: ((key: string, role: "host" | "guest", slot: number, playerId: bigint) => boolean) | null } = { allow: null };
export const signalStats = () => ({ rooms: rooms.size, peers: [...rooms.values()].reduce((n, r) => n + r.guests.size + (r.host ? 1 : 0), 0) });

const send = (p: Peer | null | undefined, m: Record<string, unknown>) => {
  if (p && p.ws.readyState === p.ws.OPEN) p.ws.send(JSON.stringify(m));
};

let sweeper: ReturnType<typeof setInterval> | null = null;

/** Handles one /signal WebSocket. `url` = the upgrade request URL. Nothing is relayed or sent before the ticket frame. */
export function handleSignal(ws: WebSocket, url: URL, log: (msg: string) => void): void {
  const key = url.searchParams.get("room") ?? "";
  const role = url.searchParams.get("role");
  const slot = Number(url.searchParams.get("slot"));
  ws.on("error", () => ws.close());
  if (!ROOM_RE.test(key) || (role !== "host" && role !== "guest") || !Number.isInteger(slot) || slot < 0 || slot > 17) {
    ws.close(4000, "bad room / role / slot");
    return;
  }
  sweeper ??= setInterval(() => sweepSignal(), SWEEP_MS);
  sweeper.unref?.();
  const timer = setTimeout(() => ws.close(4005, "NO_TICKET"), AUTH_MS);
  timer.unref?.();
  ws.once("close", () => clearTimeout(timer));
  ws.once("message", (data: RawData, isBinary: boolean) => {
    clearTimeout(timer);
    let m: { t?: unknown; ticket?: unknown } | null = null;
    try { m = isBinary ? null : JSON.parse(String(data)); } catch { /* refused below */ }
    const t = m?.t === "auth" ? readSignalTicket(m.ticket) : null;
    if (!t || t.key !== key || t.slot !== slot) { ws.close(4005, "BAD_TICKET"); return; }
    join(ws, key, role, slot, t.playerId, log);
  });
}

/** The authenticated part of handleSignal: the account `playerId` holds a ticket for `key` / `slot`. */
function join(ws: WebSocket, key: string, role: "host" | "guest", slot: number, playerId: bigint, log: (msg: string) => void): void {
  if (isBlocked(key, slot)) { ws.close(4003, "KICKED"); return; }
  if (signalGate.allow && !signalGate.allow(key, role, slot, playerId)) { ws.close(4004, "NOT_IN_MATCH"); return; }
  let room = rooms.get(key);
  if (!room) rooms.set(key, (room = { host: null, guests: new Map(), sids: new Map(), reserved: null }));
  const r = room;
  const me: Peer = { ws, role, slot, playerId, tokens: BURST, last: Date.now() };

  if (role === "host") {
    const res = reservedFor(r);
    if (res && res.slot !== slot) { ws.close(4009, "HOST_RESERVED"); return; }
    if (r.host) { ws.close(4009, "HOST_TAKEN"); return; }
    if (r.guests.has(slot)) { ws.close(4000, "slot is a guest"); return; }
    r.host = me;
    if (res?.slot === slot) r.reserved = null;
    for (const g of r.guests.values()) send(g, { t: "host", online: true });
  } else {
    if (r.host?.slot === slot) { ws.close(4000, "slot is the host"); return; }
    const old = r.guests.get(slot);
    if (old) {
      old.ws.close(4001, "replaced");
      for (const [sid, s] of r.sids) if (s === slot) r.sids.delete(sid);
    }
    r.guests.set(slot, me);
  }
  log(`signal ${key} ${role} slot ${slot} join`);
  // the client queues its own messages until; a "host" notice sent while the TURN credential is fetched is fine
  void iceServers(log).then((ice) => send(me, { t: "ready", role, ice, hostOnline: !!r.host }));

  ws.on("message", (data: RawData, isBinary: boolean) => {
    const now = Date.now();
    me.tokens = Math.min(BURST, me.tokens + ((now - me.last) / 1000) * RATE);
    me.last = now;
    if (--me.tokens < 0) { ws.close(1008, "RATE_LIMITED"); return; }
    const size = Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : (data as Buffer | ArrayBuffer).byteLength;
    if (isBinary || size > MAX_MSG) { send(me, { t: "error", err: "BAD_FRAME" }); return; }
    let m: { t?: unknown; sid?: unknown; sdp?: unknown; c?: unknown };
    try { m = JSON.parse(String(data)); } catch { send(me, { t: "error", err: "BAD_JSON" }); return; }
    // host handoff: the host (also one detached by handoffHost, still inside its grace) hands a snapshot chunk to
    // the guest socket of slot `to`; no sid, nothing else is relayed
    if (m.t === "handoff" && role === "host") {
      const f = m as { to?: unknown; x?: unknown; i?: unknown; n?: unknown; blob?: unknown };
      const g = typeof f.to === "number" && Number.isInteger(f.to) ? r.guests.get(f.to) : undefined;
      if (g && typeof f.x === "string" && f.x.length <= 64 && Number.isInteger(f.i) && Number.isInteger(f.n) && typeof f.blob === "string" && f.blob.length <= 16000) {
        send(g, { t: "handoff", from: slot, x: f.x, i: f.i, n: f.n, blob: f.blob });
      }
      return;
    }
    const sid = typeof m.sid === "string" && SID_RE.test(m.sid) ? m.sid : null;
    if (!sid) { send(me, { t: "error", err: "BAD_SID" }); return; }
    if (role === "guest") {
      if (!r.host) { send(me, { t: "error", err: "NO_HOST", sid }); return; }
      const owner = r.sids.get(sid);
      if (m.t === "offer") {
        if (owner !== undefined || typeof m.sdp !== "string") { send(me, { t: "error", err: "BAD_OFFER", sid }); return; }
        if ([...r.sids.values()].filter((s) => s === slot).length >= MAX_SIDS_PER_GUEST) { send(me, { t: "error", err: "TOO_MANY_ATTEMPTS", sid }); return; }
        r.sids.set(sid, slot);
        send(r.host, { t: "offer", sid, sdp: m.sdp, slot });
      } else if (owner !== slot) send(me, { t: "error", err: "BAD_SID", sid });
      else if (m.t === "ice") send(r.host, { t: "ice", sid, c: m.c });
      else if (m.t === "bye") { r.sids.delete(sid); send(r.host, { t: "bye", sid }); }
      else send(me, { t: "error", err: "BAD_KIND", sid });
    } else {
      const owner = r.sids.get(sid);
      const guest = owner !== undefined ? r.guests.get(owner) : undefined;
      if (!guest) {
        // late candidates for a guest that already left /signal (its link is up) are expected: drop them quietly
        if (m.t !== "ice") send(me, { t: "error", err: "BAD_SID", sid });
        return;
      }
      if (m.t === "answer" && typeof m.sdp === "string") send(guest, { t: "answer", sid, sdp: m.sdp });
      else if (m.t === "ice") send(guest, { t: "ice", sid, c: m.c });
      else if (m.t === "bye") { r.sids.delete(sid); send(guest, { t: "bye", sid }); }
      else send(me, { t: "error", err: "BAD_KIND", sid });
    }
  });

  ws.on("close", () => {
    if (role === "host" && r.host === me) {
      r.host = null;
      r.sids.clear();
      for (const g of r.guests.values()) send(g, { t: "host", online: false });
    } else if (role === "guest" && r.guests.get(slot) === me) {
      r.guests.delete(slot);
      for (const [sid, s] of r.sids) if (s === slot) r.sids.delete(sid);
    }
    if (!r.host && r.guests.size === 0 && !reservedFor(r)) rooms.delete(key);
    log(`signal ${key} ${role} slot ${slot} leave`);
  });
}

/**an open /signal socket keeps living only while its account still sits in that slot of the running battle (and, for the
 * host, still leads it), so the socket does not outlive the match and keep the instance up; a guest that stopped signaling goes too. */
export function sweepSignal(now = Date.now()): void {
  const allow = signalGate.allow;
  for (const [key, r] of rooms) {
    if (r.host && allow && !allow(key, "host", r.host.slot, r.host.playerId)) r.host.ws.close(4004, "NOT_IN_MATCH");
    for (const g of r.guests.values()) {
      if (allow && !allow(key, "guest", g.slot, g.playerId)) g.ws.close(4004, "NOT_IN_MATCH");
      else if (now - g.last > GUEST_IDLE_MS) g.ws.close(4008, "IDLE");
    }
  }
}

/** Server.Game kicked <slot> (vote kick): drop its P2P presence and keep it out for a minute [INFERIDO: the original has no P2P]. */
export function kickSlot(key: string, slot: number): void {
  blocked.set(`${key}/${slot}`, Date.now() + BLOCK_MS);
  setTimeout(() => { isBlocked(key, slot); }, BLOCK_MS + 1000).unref(); // isBlocked drops an expired entry
  const r = rooms.get(key);
  if (!r) return;
  for (const [sid, s] of [...r.sids]) if (s === slot) { r.sids.delete(sid); send(r.host, { t: "bye", sid, slot }); }
  send(r.host, { t: "kick", slot });
  const g = r.guests.get(slot);
  if (g) g.ws.close(4003, "KICKED");
  if (r.host?.slot === slot) { const h = r.host; r.host = null; r.sids.clear(); for (const x of r.guests.values()) send(x, { t: "host", online: false }); h.ws.close(4003, "KICKED"); }
}

/** Server.Game gave the leadership (= the P2P host) to <slot>: one host per room, switched in this one call. */
export function handoffHost(key: string, slot: number): void {
  const r = rooms.get(key);
  if (!r) return;
  const mine = { slot, until: Date.now() + RESERVE_MS };
  r.reserved = mine;
  setTimeout(() => { if (r.reserved === mine) { r.reserved = null; if (!r.host && r.guests.size === 0) rooms.delete(key); } }, RESERVE_MS + 1000).unref();
  const old = r.host;
  if (!old || old.slot === slot) return;
  r.host = null;
  r.sids.clear();
  for (const g of r.guests.values()) send(g, { t: "host", online: false });
  setTimeout(() => { if (old.ws.readyState === old.ws.OPEN) old.ws.close(4010, "HOST_HANDOFF"); }, HANDOFF_GRACE_MS).unref();
}
