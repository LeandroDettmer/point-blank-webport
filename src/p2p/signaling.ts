// Signaling of the P2P match: how a guest's WebRTC offer reaches the leader's tab and the answer comes
// back. Interfaces as in the reference port; one implementation here, the server's
// WebSocket route /signal?room=<uniqueRoomId hex>-<roomSeed hex>&role=host|guest&slot=<n> (server/src/web/signal.ts).
// Every connection attempt of a guest has its own random single-use `sid`.
// The first frame is {t:, ticket};
// everything else waits for, which also brings the ICE servers (TURN only reaches a socket with a valid ticket).
// `handoff` frames carry no sid: src/p2p/handoff.ts.
import type { HandoffFrame, HandoffIn } from "./handoff.ts";

export interface OfferIn {
  sid: string;
  sdp: string;
  /** the slot the guest signaled as (the host checks it against the room and binds the link to it) */
  slot: number;
}

export interface HostSignaling {
  onOffer: ((o: OfferIn) => void) | null;
  onCandidate: ((sid: string, c: RTCIceCandidateInit) => void) | null;
  onBye: ((sid: string) => void) | null;
  answer(sid: string, sdp: string): void;
  candidate(sid: string, c: RTCIceCandidateInit): void;
  bye(sid: string): void;
  close(): void;
  /** re-deliver what arrived before the handlers were set */
  flush?(): void;
}

export interface GuestSignaling {
  /** resolves once the host's tab is online and answers offers */
  hostReady(timeoutMs?: number): Promise<void>;
  onAnswer: ((sid: string, sdp: string) => void) | null;
  onCandidate: ((sid: string, c: RTCIceCandidateInit) => void) | null;
  onBye: ((sid: string) => void) | null;
  offer(sid: string, sdp: string): void;
  candidate(sid: string, c: RTCIceCandidateInit): void;
  bye(sid: string): void;
  close(): void;
}

/** a fresh connection id: 128 random bits, hex */
export function newSid(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** the signaling room of a battle: Server.Game's UniqueRoomId + seed (both from PRESTARTBATTLE) */
export const signalRoomKey = (uniqueRoomId: number, roomSeed: number) => `${(uniqueRoomId >>> 0).toString(16)}-${(roomSeed >>> 0).toString(16)}`;

type SignalMsg =
  | { t: "ready"; role: "host" | "guest"; ice: RTCIceServer[]; hostOnline: boolean }
  | { t: "host"; online: boolean }
  | { t: "offer"; sid: string; sdp: string; slot: number }
  | { t: "answer"; sid: string; sdp: string }
  | { t: "ice"; sid: string; c: RTCIceCandidateInit }
  | { t: "bye"; sid: string }
  | ({ t: "handoff" } & HandoffIn)
  | { t: "error"; err: string; sid?: string };

/** The server's /signal WebSocket, either side. `ready` resolves with the server's ICE servers. */
export class WebSignaling implements HostSignaling, GuestSignaling {
  onOffer: ((o: OfferIn) => void) | null = null;
  onCandidate: ((sid: string, c: RTCIceCandidateInit) => void) | null = null;
  onBye: ((sid: string) => void) | null = null;
  onAnswer: ((sid: string, sdp: string) => void) | null = null;
  onError: ((err: string, sid?: string) => void) | null = (err, sid) => console.warn(`[p2p] signaling: ${err}${sid ? ` (${sid.slice(0, 8)})` : ""}`);
  onClose: ((reason: string) => void) | null = null;
  /** guest role: the old host's snapshot frames (host handoff) */
  onHandoff: ((f: HandoffIn) => void) | null = null;
  readonly ready: Promise<RTCIceServer[]>;
  hostOnline = false;
  private readonly ws: WebSocket;
  private hostWaiters: (() => void)[] = [];
  private queue: string[] = [];
  /** "ready" came: the server took the ticket, the queue may go out */
  private authed = false;
  /** offers / candidates / byes that came before their handler was set (the host is still booting its Worker) */
  private backlog: SignalMsg[] = [];

  constructor(serverUrl: string, room: string, role: "host" | "guest", slot: number, ticket = "") {
    const url = `${serverUrl.replace(/\/$/, "")}/signal?room=${encodeURIComponent(room)}&role=${role}&slot=${slot}`;
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this.ws.send(JSON.stringify({ t: "auth", ticket }));
    this.ready = new Promise((resolve, reject) => {
      this.ws.onmessage = (ev) => {
        let m: SignalMsg;
        try { m = JSON.parse(String(ev.data)) as SignalMsg; } catch { return; }
        this.dispatch(m, resolve);
      };
      this.ws.onerror = () => reject(new Error(`p2p: signaling WebSocket error (${url})`));

      this.ws.onclose = (ev) => {
        reject(new Error(`p2p: signaling closed (${ev.code} ${ev.reason})`));
        this.onClose?.(`${ev.code} ${ev.reason}`);
      };
    });
    this.ready.catch(() => { /* surfaced by hostReady / the caller's own await */ });
  }

  private dispatch(m: SignalMsg, resolveReady?: (ice: RTCIceServer[]) => void): void {
    const later = () => { this.backlog.push(m); };
    switch (m.t) {
      case "ready":
        this.authed = true;
        this.setHost(m.hostOnline);
        for (const q of this.queue.splice(0)) this.ws.send(q);
        resolveReady?.(m.ice ?? []);
        break;
      case "host": this.setHost(m.online); break;
      case "offer": if (this.onOffer) this.onOffer({ sid: m.sid, sdp: m.sdp, slot: m.slot }); else later(); break;
      case "answer": if (this.onAnswer) this.onAnswer(m.sid, m.sdp); else later(); break;
      case "ice": if (!m.c || typeof m.c.candidate !== "string") break; if (this.onCandidate) this.onCandidate(m.sid, m.c); else later(); break;
      case "bye": if (this.onBye) this.onBye(m.sid); else later(); break;
      case "handoff": if (this.onHandoff) this.onHandoff(m); else later(); break;
      case "error": this.onError?.(m.err, m.sid); break;
    }
  }

  flush(): void {
    for (const m of this.backlog.splice(0)) this.dispatch(m);
  }

  private setHost(online: boolean): void {
    this.hostOnline = online;
    if (online) for (const w of this.hostWaiters.splice(0)) w();
  }

  hostReady(timeoutMs = 30000): Promise<void> {
    return this.ready.then(() => this.hostOnline ? undefined : new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`p2p: the room leader is not hosting (no host on /signal within ${timeoutMs} ms)`)), timeoutMs);
      this.hostWaiters.push(() => { clearTimeout(t); resolve(); });
    }));
  }

  private send(m: Record<string, unknown>): void {
    const s = JSON.stringify(m);
    if (this.ws.readyState === WebSocket.OPEN && this.authed) this.ws.send(s);
    else if (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN) this.queue.push(s);
  }
  offer(sid: string, sdp: string): void { this.send({ t: "offer", sid, sdp }); }
  answer(sid: string, sdp: string): void { this.send({ t: "answer", sid, sdp }); }
  candidate(sid: string, c: RTCIceCandidateInit): void { this.send({ t: "ice", sid, c }); }
  bye(sid: string): void { this.send({ t: "bye", sid }); }
  /** host role: a piece of the match snapshot for the next leader (`to` = its slot) */
  handoff(to: number, f: HandoffFrame): void { this.send({ t: "handoff", to, x: f.x, i: f.i, n: f.n, blob: f.blob }); }
  close(): void { try { this.ws.close(1000, "done"); } catch { /* ignore */ } }
}
