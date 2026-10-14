// One PB session over a WebSocket to the server web front (ws://host:8090/tcp?target=...).
// The WebSocket carries the raw PB byte stream; all framing and crypto live here.
import { MODE_AUTH, FrameDecoder, buildEncryptedFrame, cmessEncrypt, nextSessionSeed } from "./cmess.ts";
import { PacketReader, PacketWriter } from "./packet.ts";
import { Op } from "./opcodes.ts";
import { toHex } from "./bytes.ts";

export type TcpTarget = "auth" | "game1" | "game2" | "game3";

export interface ConnectInfo {
  sessionId: number;
  sessionSeed: number;
  serverKey: Uint8Array;
  clientKey: Uint8Array;
  modulus: Uint8Array;
  exponent: Uint8Array;
}

export class EarlyCloseError extends Error {}

type Listener = (opcode: number, r: PacketReader) => void;

/** Production build: the server's wss origin (wss://<service>.run.app). import.meta.env is
 *  undefined outside Vite (the Node tests). */
const ENV = (import.meta as { env?: Record<string, string | boolean | undefined> }).env;
const GW_URL = ENV?.VITE_GW_URL as string | undefined;
/** Vite dev server only: `?gw=` / localStorage "pbweb.gw" may point the client at another server. A production build ignores
 *  both. */
export const GW_OVERRIDE = ENV?.DEV === true;

/** The enter ticket of each logged-in account (playerId -> ticket): the Auth's text frame after LOGIN, sent back to the
 *  Game before USER_ENTER */
export const enterTickets = new Map<bigint, string>();

/** ?gw= first (dev build only), then the build's VITE_GW_URL, then the page's own host on the server web port (dev). */
export function defaultServerUrl(): string {
  const qs = GW_OVERRIDE && typeof location !== "undefined" ? new URLSearchParams(location.search).get("gw") : null;
  if (qs) return qs;
  if (GW_URL) return GW_URL;
  const host = typeof location !== "undefined" && location.hostname ? location.hostname : "127.0.0.1";
  const proto = typeof location !== "undefined" && location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${host}:8090`;
}

/** PROTOCOL_BASE_CONNECT_ACK (2306), identical on Auth and Game. Reader positioned after opcode. */
export function parseConnectAck(r: PacketReader): ConnectInfo {
  r.readH(); // 0
  const n = r.readC(); // 11
  r.skip(n);
  const total = r.readH(); // modLen + expLen + 2
  const modLen = r.readH();
  const modulus = r.readB(modLen);
  const exponent = r.readB(total - 2 - modLen);
  r.readC(); // 118
  r.readH(); // 0
  const sessionSeed = r.readH();
  const sessionId = r.readD();
  // Bitwise.GenerateRSAKeyPair overwrites modulus[0..4] with (SessionId + CRYPTO[0]);
  // CONNECT_ACK ctor: ServerKey = modulus[0..16], ClientKey = modulus[16..32].
  return {
    sessionId, sessionSeed, modulus, exponent,
    serverKey: modulus.slice(0, 16),
    clientKey: modulus.slice(16, 32),
  };
}

export class PbConnection {
  readonly target: TcpTarget;
  readonly serverUrl: string;
  info: ConnectInfo | null = null;
  debug = false;
  onClose: ((reason: string) => void) | null = null;
  /** Game: the /signal ticket of the last PRESTARTBATTLE */
  signalTicket: string | null = null;

  private ws: WebSocket | null = null;
  private decoder = new FrameDecoder();
  private seed = 0;
  private listeners = new Set<Listener>();
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(target: TcpTarget, serverUrl = defaultServerUrl()) {
    this.target = target;
    this.serverUrl = serverUrl;
  }

  /**
   * Opens the tunnel and resolves once CONNECT_ACK arrived. Auth/Game throttle new sockets per IP
   * (Settings.ini ConnectionThrottleSeconds = 5; behind Docker NAT every client shares one IP) and
   * drop throttled ones before CONNECT_ACK, so an early close is retried after the window.
   */
  async connect(retries = 6, timeoutMs = 8000): Promise<ConnectInfo> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.connectOnce(timeoutMs);
      } catch (e) {
        if (!(e instanceof EarlyCloseError) || attempt >= retries) throw e;
        await new Promise((r) => setTimeout(r, 5500));
        this.decoder = new FrameDecoder();
        this.closed = false;
      }
    }
  }

  private connectOnce(timeoutMs: number): Promise<ConnectInfo> {
    return new Promise((resolve, reject) => {
      const url = `${this.serverUrl.replace(/\/$/, "")}/tcp?target=${this.target}`;
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new Error(`${this.target}: no CONNECT_ACK within ${timeoutMs}ms (${url})`));
        this.close();
      }, timeoutMs);
      const off = this.on((op, r) => {
        if (op !== Op.BASE_CONNECT_ACK) return;
        off();
        clearTimeout(timer);
        try {
          this.info = parseConnectAck(r);
          this.seed = this.info.sessionSeed;
          this.keepAlive = setInterval(() => this.send(Op.BASE_KEEP_ALIVE_REQ), 30000);
          resolve(this.info);
        } catch (e) {
          reject(e);
        }
      });
      ws.onmessage = (ev) => (typeof ev.data === "string" ? this.onText(ev.data) : this.onBytes(new Uint8Array(ev.data as ArrayBuffer)));
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`${this.target}: WebSocket error (server ${this.serverUrl} up?)`));
      };
      ws.onclose = (ev) => {
        clearTimeout(timer);
        this.teardown();
        if (!this.info) {
          off();
          reject(new EarlyCloseError(`${this.target}: server closed before CONNECT_ACK (throttle 5s/IP?)`));
          return;
        }
        this.onClose?.(ev.reason || `closed (${ev.code})`);
      };
    });
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolves with a reader positioned right after the opcode of the next `opcode` packet. */
  waitFor(opcode: number, timeoutMs = 5000): Promise<PacketReader> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`${this.target}: timeout waiting for opcode ${opcode}`));
      }, timeoutMs);
      const off = this.on((op, r) => {
        if (op !== opcode) return;
        clearTimeout(timer);
        off();
        resolve(r);
      });
    });
  }

  /** Encrypts [opcode][seed][body] with CMess(ClientKey, MODE_AUTH) and ships one frame. */
  send(opcode: number, body?: PacketWriter | Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.info) throw new Error(`${this.target}: not connected`);
    this.seed = nextSessionSeed(this.seed);
    const w = new PacketWriter().writeH(opcode).writeH(this.seed);
    if (body) w.writeB(body instanceof PacketWriter ? body.toBytes() : body);
    const plain = w.toBytes();
    if (this.debug) console.debug(`[${this.target}] >> ${opcode} ${toHex(plain)}`);
    this.ws.send(buildEncryptedFrame(cmessEncrypt(this.info.clientKey, plain, MODE_AUTH)));
  }

  /** A server side message (WS text frame, outside the PB stream): the Game's {t:, ticket}. */
  sendText(msg: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error(`${this.target}: not connected`);
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    if (this.closed) return;
    this.teardown();
    try { this.ws?.close(); } catch { /* ignore */ }
  }

  get isOpen(): boolean {
    return !this.closed && this.ws?.readyState === WebSocket.OPEN;
  }

  private teardown(): void {
    this.closed = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }

  /** server side messages (server/src/net/tcpSession.ts sendText); unknown ones are ignored */
  private onText(s: string): void {
    try {
      const m = JSON.parse(s) as { t?: unknown; ticket?: unknown; pid?: unknown };
      if (m.t === "signalTicket" && typeof m.ticket === "string") this.signalTicket = m.ticket;
      else if (m.t === "enterTicket" && typeof m.ticket === "string" && typeof m.pid === "string" && /^\d{1,20}$/.test(m.pid)) enterTickets.set(BigInt(m.pid), m.ticket);
    } catch { /* not ours */ }
  }

  private onBytes(chunk: Uint8Array): void {
    for (const f of this.decoder.push(chunk)) {
      if (f.encrypted || f.payload.length < 2) continue; // server never encrypts S->C
      const opcode = f.payload[0] | (f.payload[1] << 8);
      if (this.debug) console.debug(`[${this.target}] << ${opcode} (${f.payload.length}b)`);
      for (const fn of [...this.listeners]) {
        try {
          fn(opcode, new PacketReader(f.payload, 2));
        } catch (e) {
          console.warn(`[${this.target}] handler error for opcode ${opcode}`, e);
        }
      }
    }
  }
}
