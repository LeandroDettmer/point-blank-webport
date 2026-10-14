// One PB TCP client socket, server side (AuthClient.cs / GameClient.cs transport). Shared by Auth and Game:
//   C->S frames [u16 len|0x8000][CMess(ClientKey, MODE_AUTH)][1 trailer] -> [u16 opcode][u16 seed][body]
//   S->C frames [u16 N+2][N payload bytes][5 zero bytes] (plaintext, SendPacket)
// Reuses the client's cipher/framing code (src/net/cmess.ts, validated against the C# vectors).
import type net from "node:net";
import { generateKeyPair } from "node:crypto";
import { promisify } from "node:util";
import { FrameDecoder, MODE_AUTH, cmessDecrypt, nextSessionSeed } from "../../../src/net/cmess.ts";
import { PacketReader, PacketWriter } from "../../../src/net/packet.ts";
import { CRYPTO } from "../../../src/net/bitwise.ts";
import { config } from "../config.ts";
import { Bucket } from "../web/guard.ts";

const genRsa = promisify(generateKeyPair);

/** [web] PB frames one data chunk (one WS message) may carry: the client sends one per message [RECRIADO] */
export const MAX_FRAMES_PER_CHUNK = 32;
/** [web] log lines per session: 20, then 1 per 10 s, so bad seeds / unknown opcodes in a loop cannot flood the log [RECRIADO] */
const LOG_BURST = 20, LOG_PER_SEC = 0.1;

/** packets the client sends on its own timers (BASE_KEEP_ALIVE_REQ every 30 s, LOBBY_GET_ROOMLIST_REQ every 1.5 s in the
 * lobby): they keep the link alive but are not player input for PB_IDLE_KICK_MIN */
const BACKGROUND_OPCODES = new Set([2309, 2587]);

/**
 * Bitwise.GenerateRSAKeyPair(SessionId, CRYPTO[0], CRYPTO[2]=1360): public modulus/exponent as unsigned big-endian
 * bytes, then modulus[0..4] = BitConverter.GetBytes(SessionId + SecurityKey). The client only uses
 * modulus[0..16] (ServerKey) and modulus[16..32] (ClientKey) as CMess keys; RSA itself is never used.
 */
export async function generateSessionKeys(sessionId: number): Promise<{ modulus: Uint8Array; exponent: Uint8Array }> {
  const { publicKey } = await genRsa("rsa", { modulusLength: CRYPTO[2], publicExponent: 0x10001 });
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  const modulus = new Uint8Array(Buffer.from(jwk.n, "base64url"));
  const exponent = new Uint8Array(Buffer.from(jwk.e, "base64url"));
  const sb = new Uint8Array(4);
  new DataView(sb.buffer).setInt32(0, (sessionId + CRYPTO[0]) | 0, true);
  modulus.set(sb.subarray(0, Math.min(4, modulus.length)), 0);
  return { modulus, exponent };
}

/** PROTOCOL_BASE_CONNECT_ACK (2306), identical on Auth and Game. */
export function writeConnectAck(sessionId: number, sessionSeed: number, modulus: Uint8Array, exponent: Uint8Array): Uint8Array {
  return new PacketWriter()
    .writeH(2306).writeH(0).writeC(11).zeros(11)
    .writeH(modulus.length + exponent.length + 2).writeH(modulus.length).writeB(modulus).writeB(exponent)
    .writeC(118).writeH(0).writeH(sessionSeed).writeD(sessionId & 0xffff)
    .toBytes();
}

export interface SessionEvents {
  /** Auth: the first decrypted packet must be 1281 (LOGIN) or 2309 (KEEP_ALIVE), else the socket is dropped.
   * null = Game rule (GameClient.FirstPacketCheck): any non-zero opcode is accepted. */
  firstPacketIds: number[] | null;
  onPacket(opcode: number, r: PacketReader, raw: Uint8Array): void | Promise<void>;
  /** destroy=true: the peer went away / fatal error (C# Close(_, true)); false: server-side soft close. */
  onClose(destroy: boolean): void | Promise<void>;
  log?(msg: string): void;
  /** true = the peer is busy without talking to us (in a battle: the match runs peer to peer, the TCP link may stay silent): no idle drop */
  keepIdle?(): boolean;
}

export class TcpSession {
  readonly sock: net.Socket;
  readonly sessionId: number;
  readonly sessionSeed: number;
  readonly ip: string;
  clientKey = new Uint8Array(16);
  serverKey = new Uint8Array(16);
  firstPacketId = 0;
  closed = false;
  lastActivity = Date.now();
  /** last packet that is player input (not in BACKGROUND_OPCODES), for PB_IDLE_KICK_MIN */
  lastInput = Date.now();

  private nextSeed: number;
  private decoder = new FrameDecoder();
  private queue: Promise<void> = Promise.resolve();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private ev: SessionEvents;
  /** PB packets in, before the decrypt (PB_PKT_BURST / PB_PKT_PER_SEC) */
  private rate = new Bucket(config.pktBurst, config.pktPerSec);
  private logBudget = new Bucket(LOG_BURST, LOG_PER_SEC);
  private logMuted = false;

  constructor(sock: net.Socket, sessionId: number, ev: SessionEvents) {
    this.sock = sock;
    this.sessionId = sessionId;
    // AuthManager.AddSession: new Random(ms).Next(SessionId, 0x7FFF)
    this.sessionSeed = sessionId + Math.floor(Math.random() * (0x7fff - sessionId));
    this.nextSeed = this.sessionSeed;
    this.ip = (sock.remoteAddress ?? "").replace(/^::ffff:/, "");
    this.ev = ev;
  }

  async start(): Promise<void> {
    this.sock.setNoDelay(true);
    this.sock.on("data", (c) => this.onData(c));
    this.sock.on("error", () => this.close(true));
    this.sock.on("close", () => this.close(true));
    const { modulus, exponent } = await generateSessionKeys(this.sessionId);
    this.serverKey = modulus.slice(0, 16);
    this.clientKey = modulus.slice(16, 32);
    if (this.closed) return;
    this.send(writeConnectAck(this.sessionId, this.sessionSeed, modulus, exponent));
    // CheckConnectionTimeout: no first packet within 10 s -> drop. HeartBeatCounter: 10 min idle -> drop.
    // PB_IDLE_KICK_MIN (prod, [RECRIADO]: not in the C# servers): no player input for N min outside a battle -> drop, so a
    // forgotten tab (keep-alive + room-list polling forever) does not keep the Cloud Run instance up.
    this.timers.push(setTimeout(() => { if (!this.firstPacketId) this.close(true); }, 10000));
    const kickMs = config.idleKickMin * 60000;
    const idle = setInterval(() => {
      if (kickMs > 0 && Date.now() - this.lastInput >= kickMs) {
        if (this.ev.keepIdle?.()) this.lastInput = Date.now(); // in a match: the full N min count again from its end
        else {
          this.ev.log?.(`session ${this.sessionId} without input for ${config.idleKickMin} min: dropped (PB_IDLE_KICK_MIN)`);
          this.closeIdle();
          return;
        }
      }
      if (Date.now() - this.lastActivity < 600000) return;
      if (this.ev.keepIdle?.()) { this.lastActivity = Date.now() - 300000; return; } // in a match: never dropped for silence, only re-armed
      this.ev.log?.(`session ${this.sessionId} idle for 10 min: dropped (timeout)`);
      this.closeIdle();
    }, 15000);
    this.timers.push(idle as unknown as ReturnType<typeof setTimeout>);
  }

  /** SendPacket: [u16 len+2][payload][5 zero bytes]. */
  send(payload: Uint8Array): void {
    if (this.closed || this.sock.destroyed || payload.length < 2) return;
    const frame = new Uint8Array(payload.length + 7);
    frame[0] = (payload.length + 2) & 0xff;
    frame[1] = ((payload.length + 2) >> 8) & 0xff;
    frame.set(payload, 2);
    this.sock.write(frame);
  }

  /** [web] a JSON side message on the session's WebSocket (web/wsSocket.ts sendText); nothing on a raw TCP socket. */
  sendText(msg: Record<string, unknown>): void {
    if (this.closed || this.sock.destroyed) return;
    (this.sock as { sendText?: (s: string) => void }).sendText?.(JSON.stringify(msg));
  }

  /** C# Close(ms, destroy). destroy=false keeps DB state (USER_LEAVE hand-off) but still ends the socket. */
  close(destroy: boolean, delayMs = 0): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.queue = this.queue.then(() => this.ev.onClose(destroy)).catch((e) => this.ev.log?.(`onClose error ${e}`));
    const end = () => { this.sock.end(); setTimeout(() => this.sock.destroy(), 2000).unref(); };
    if (delayMs > 0) setTimeout(end, delayMs).unref();
    else end();
  }

  /** [web] idle kick: WS close 4000 "idle" (IDLE_CLOSE_REASON in the client), so the lobby shows the message instead of reconnecting */
  private closeIdle(): void {
    (this.sock as { closeWith?: (code: number, reason?: string) => void }).closeWith?.(4000, "idle");
    this.close(true);
  }

  /** ev.log within the session's budget; one "dropped" line when it runs out. Handlers log per-packet lines here. */
  log(msg: string): void {
    if (this.logBudget.take()) { this.logMuted = false; this.ev.log?.(msg); return; }
    if (!this.logMuted) { this.logMuted = true; this.ev.log?.(`session ${this.sessionId}: log limit reached, lines dropped`); }
  }

  /** [web] over the packet budget: logged, then the WebSocket closes with 1008 and no reason (the player only sees the drop). */
  private flood(why: string): void {
    this.log(`session ${this.sessionId} from ${this.ip}: ${why}, closed (1008)`);
    (this.sock as { closeWith?: (code: number) => void }).closeWith?.(1008);
    this.close(true);
  }

  /** CheckSeed: accept if the seed is within the next 16 LCG steps. */
  private checkSeed(seed: number): boolean {
    for (let i = 0; i < 16; i++) {
      this.nextSeed = nextSessionSeed(this.nextSeed);
      if (this.nextSeed === seed) return true;
    }
    this.log(`seed mismatch session ${this.sessionId}: got ${seed}`);
    return false;
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.lastActivity = Date.now();
    const frames = this.decoder.push(new Uint8Array(chunk));
    if (frames.length > MAX_FRAMES_PER_CHUNK) { this.flood(`${frames.length} frames in one message`); return; }
    for (const f of frames) {
      if (this.closed) return;
      if (!this.rate.take()) { this.flood(`more than ${config.pktBurst} packets / ${config.pktPerSec} per s`); return; }
      if (!f.encrypted) continue; // C# ignores plain C->S frames
      const plain = cmessDecrypt(this.clientKey, f.payload, MODE_AUTH);
      if (!plain || plain.length < 4) { this.close(true); return; }
      const opcode = plain[0] | (plain[1] << 8);
      const seed = plain[2] | (plain[3] << 8);
      if (this.ev.firstPacketIds === null) {
        if (opcode === 0) { this.close(true); return; }
        this.firstPacketId = opcode;
      } else if (!this.firstPacketId) {
        if (!this.ev.firstPacketIds.includes(opcode)) { this.log(`invalid first packet ${opcode} from ${this.ip}`); this.close(true); return; }
        this.firstPacketId = opcode;
      }
      if (!this.checkSeed(seed)) continue;
      if (!BACKGROUND_OPCODES.has(opcode)) this.lastInput = Date.now();
      const r = new PacketReader(plain, 4);
      this.queue = this.queue
        .then(() => this.ev.onPacket(opcode, r, plain))
        .catch((e) => { this.log(`handler ${opcode} failed: ${(e as Error).stack ?? e}`); this.close(true, 50); });
    }
  }
}
