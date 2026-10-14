// A WebSocket that looks like the net.Socket TcpSession expects: 1 WS binary message in = bytes on "data",
// write() = 1 WS binary message out. Lets the browser reach Auth/Game without a TCP bridge process.
import { Duplex } from "node:stream";
import { config } from "../config.ts";
import type { WebSocket, RawData } from "ws";
import { Bucket } from "./guard.ts";

const toBuffer = (d: RawData): Buffer => (Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d as ArrayBuffer));

export class WsSocket extends Duplex {
  readonly remoteAddress: string;
  /** the first {t:"enter", ticket} text frame: the Game's USER_ENTER reads it (signalTicket.ts readEnterTicket) */
  enterTicket: string | null = null;
  private ws: WebSocket;
  private rate = new Bucket(config.webMsgBurst, config.webMsgPerSec);

  constructor(ws: WebSocket, remoteAddress: string | undefined) {
    super();
    this.ws = ws;
    this.remoteAddress = remoteAddress ?? "";
    ws.on("message", (data, isBinary) => {
      if (!this.rate.take()) { this.closeWith(1008); this.destroy(); return; } // flood: drop the session (TcpSession.onClose runs)
      if (!isBinary) { this.onText(data); return; } // text frames are not part of the PB stream
      this.push(toBuffer(data));
    });
    ws.on("close", () => this.destroy());
    ws.on("error", () => this.destroy());
  }

  private onText(data: RawData): void {
    const b = toBuffer(data);
    if (this.enterTicket !== null || b.length > 512) return;
    try {
      const m = JSON.parse(b.toString()) as { t?: unknown; ticket?: unknown };
      if (m.t === "enter" && typeof m.ticket === "string") this.enterTicket = m.ticket;
    } catch { /* not ours */ }
  }

  setNoDelay(): this { return this; }

  /** Closes the WebSocket with <code> (1008 = policy violation: message / packet flood, TcpSession.flood; 4000 "idle" = idle kick, the
   *  client then does not reconnect by itself). */
  closeWith(code: number, reason?: string): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.close(code, reason);
  }

  /** A web-only side message (WS text frame, outside the PB stream; the client's Connection.onText): the /signal ticket. */
  sendText(s: string): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(s);
  }

  _read(): void {}

  _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (this.ws.readyState !== this.ws.OPEN) { cb(); return; }
    this.ws.send(chunk, { binary: true }, (err) => cb(err ?? null));
  }

  _final(cb: (err?: Error | null) => void): void {
    this.ws.close(1000);
    cb();
  }

  _destroy(err: Error | null, cb: (err: Error | null) => void): void {
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) this.ws.close(err ? 1011 : 1000);
    cb(err);
  }
}
