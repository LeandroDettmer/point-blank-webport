// Client side of the match link (Server.Match datagrams: register 65/66, game data, ping). The transport is the
// leader-hosted match: the leader's in-tab host or a WebRTC link to it.
import { defaultServerUrl } from "./connection.ts";
import type { MatchTransport, MatchTransportFactory } from "./matchTransport.ts";
import {
  MatchOp, buildGameData, buildHandshake, buildPing, decodeActions, decodeServerGameData, encodeActions, readHeader,
  type ActionIn, type ActionOut, type RoomKey,
} from "./matchUdp.ts";

export interface MatchSession extends RoomKey {
  slot: number;
  /** Low byte of the account PlayerId (Server.Game EquipmentSync writes GetBytes(PlayerId)[0]). */
  accountId: number;
  /** the /signal ticket of this battle and slot (MatchEndpoint.signalTicket); /signal refuses a socket without it */
  signalTicket?: string;
}

export class MatchLink {
  readonly session: MatchSession;
  readonly serverUrl: string;
  /** Slot.SpawnsCount (header "respawn"): hits are accepted only when it matches the server's. */
  respawn = 0;
  round = 0;
  connected = false;
  rxPackets = 0;
  txPackets = 0;
  onActions: ((actions: ActionIn[], time: number) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  /** set by PbBattleNet.connect() before open() (P2P host or guest link) */
  transport: MatchTransportFactory | null = null;

  private ws: MatchTransport | null = null;
  private t0 = Date.now();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(session: MatchSession, serverUrl = defaultServerUrl()) {
    this.session = session;
    this.serverUrl = serverUrl;
  }

  /** Opens the tunnel and registers (opcode 65) until the server answers CONNECT (66). */
  open(timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.transport) { reject(new Error("match: no transport (P2P session not opened)")); return; }
      const ws = (this.ws = this.transport());
      let retry: ReturnType<typeof setInterval> | null = null;
      const timer = setTimeout(() => {
        if (retry) clearInterval(retry);
        reject(new Error(`match: no CONNECT (66) within ${timeoutMs}ms — room not known to Server.Match?`));
      }, timeoutMs);
      const register = () => this.raw(buildHandshake(MatchOp.REGISTER, this.session.slot, this.session.accountId, this.session), true);
      ws.onopen = () => {
        register();
        retry = setInterval(register, 700); // UDP: resend until acknowledged
      };
      ws.onerror = (err) => reject(err);
      ws.onclose = (reason) => {
        this.connected = false;
        this.stopPing();
        clearTimeout(timer);
        if (retry) clearInterval(retry);
        reject(new Error(`match: link closed before CONNECT (${reason})`)); // no-op once resolved
        this.onClose?.(reason);
      };
      ws.onmessage = (data) => {
        if (data.length < 2) return;
        const op = data[0];
        if (op === MatchOp.CONNECT && !this.connected) {
          this.connected = true;
          clearTimeout(timer);
          if (retry) clearInterval(retry);
          this.pingTimer = setInterval(() => this.raw(buildPing(this.session.slot, this.session.accountId, this.session, this.time()), false), 3000);
          resolve();
          return;
        }
        if (op === MatchOp.PVE || op === 132) {
          const dec = decodeServerGameData(data);
          if (!dec) return;
          this.rxPackets++;
          this.onActions?.(decodeActions(dec.actions), dec.header.time);
        } else if (op !== MatchOp.PING && op !== MatchOp.CONNECT) {
          console.debug(`[match] << op ${op} (${readHeader(data).length}b)`);
        }
      };
      if (ws.isOpen) ws.onopen?.(); // a P2P link handed over already open fires no transition
    });
  }

  /** Seconds since this link was created (goes in the header time field / cipher key). */
  time(): number {
    return (Date.now() - this.t0) / 1000;
  }

  send(a: ActionOut): void {
    this.sendRecords([{ slot: this.session.slot, a }]);
  }

  /** Several slot records in ONE datagram: the match host sends its AI slots this way. The core relays every record under its
   *  own slot (the header slot is only the sender's identity), so the other peers see a bot like a player. */
  sendRecords(recs: { slot: number; a: ActionOut }[]): void {
    if (!this.connected || !recs.length) return;
    const s = this.session;
    this.txPackets++;
    // events a lost datagram would drop for good ride the reliable WebRTC channel (P2P; the UDP tunnel ignores it)
    const reliable = recs.some(({ a }) => !!(a.hits?.length || a.drop || a.pickup || a.radio || a.weapon || a.grenades?.length || a.dropped?.some((d) => d.d.resting)));
    const parts = recs.map(({ slot, a }) => encodeActions(slot, a));
    const body = new Uint8Array(parts.reduce((n, r) => n + r.length, 0));
    let o = 0;
    for (const r of parts) { body.set(r, o); o += r.length; }
    this.raw(buildGameData(
      { slot: s.slot, time: this.time(), round: this.round, respawn: this.respawn, roundNumber: 0, accountId: s.accountId, unk1: 0 },
      body, s), reliable);
  }

  /** Host change: drop the dead transport without an UNREGISTER, register again over `factory` (the new host's core). */
  reopen(factory: MatchTransportFactory, timeoutMs = 8000): Promise<void> {
    this.stopPing();
    this.connected = false;
    const old = this.ws;
    this.ws = null;
    if (old) { old.onclose = null; try { old.close(); } catch { /* ignore */ } }
    this.transport = factory;
    return this.open(timeoutMs);
  }

  close(): void {
    this.stopPing();
    if (this.ws?.isOpen) {
      try { this.raw(buildHandshake(MatchOp.UNREGISTER, this.session.slot, this.session.accountId, this.session), true); } catch { /* ignore */ }
    }
    this.connected = false;
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private raw(b: Uint8Array, reliable: boolean): void {
    if (this.ws?.isOpen) this.ws.send(b, reliable);
  }
}
