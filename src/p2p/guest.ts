// Guest side of the P2P match, after the reference port: a MatchTransport over one
// RTCPeerConnection to the leader's tab. The guest makes the offer and opens both channels (src/p2p/channels.ts);
// MatchLink's datagrams go on 'rel' or 'state' as it tags them. A '_close' text frame on 'rel' is the host's reason.
import type { MatchTransport } from "../net/matchTransport.ts";
import { asBytes, readCloseFrame, REL, REL_INIT, STATE, STATE_HIGH_WATER, STATE_INIT } from "./channels.ts";
import { newSid, type GuestSignaling } from "./signaling.ts";

export interface GuestOptions {
  RTCPeerConnection?: typeof RTCPeerConnection;
  timeoutMs?: number;
}

export class RtcGuestTransport implements MatchTransport {
  onopen: (() => void) | null = null;
  onmessage: ((data: Uint8Array, reliable: boolean) => void) | null = null;
  onclose: ((reason: string) => void) | null = null;
  onerror: ((err: Error) => void) | null = null;
  private open = false;
  private done = false;
  private readonly pc: RTCPeerConnection;
  private readonly state: RTCDataChannel;
  private readonly rel: RTCDataChannel;

  private constructor(pc: RTCPeerConnection) {
    this.pc = pc;
    this.state = pc.createDataChannel(STATE, STATE_INIT);
    this.rel = pc.createDataChannel(REL, REL_INIT);
  }

  /** Offers through `sig`, resolves once both channels are open (the host has bound the link to `slot`). */
  static connect(sig: GuestSignaling, ice: RTCConfiguration, opts: GuestOptions = {}): Promise<RtcGuestTransport> {
    const PC = opts.RTCPeerConnection ?? globalThis.RTCPeerConnection;
    const t = new RtcGuestTransport(new PC(ice));
    const sid = newSid();
    const pending: RTCIceCandidateInit[] = [];
    let remoteSet = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { t.fail(`no WebRTC link to the host within ${opts.timeoutMs ?? 20000} ms`); reject(new Error("p2p: WebRTC link timeout (NAT without TURN?)")); }, opts.timeoutMs ?? 20000);
      const maybeOpen = () => {
        if (t.open || t.done || t.state.readyState !== "open" || t.rel.readyState !== "open") return;
        t.open = true;
        clearTimeout(timer);
        resolve(t);
      };
      for (const ch of [t.state, t.rel]) {
        ch.binaryType = "arraybuffer";
        ch.onopen = maybeOpen;
        ch.onclose = () => t.fail(`${ch.label} channel closed`);
        ch.onmessage = (m) => {
          if (typeof m.data === "string") {
            const c = ch === t.rel ? readCloseFrame(m.data) : null;
            if (c) t.fail(`${c.code} ${c.reason}`);
            return;
          }
          const b = asBytes(m.data);
          if (b) t.onmessage?.(b, ch === t.rel);
        };
      }
      t.pc.onicecandidate = (e) => { if (e.candidate) sig.candidate(sid, e.candidate.toJSON()); };
      t.pc.onconnectionstatechange = () => {
        if (t.pc.connectionState === "failed" || t.pc.connectionState === "closed") {
          t.fail(`connection ${t.pc.connectionState}`);
          reject(new Error(`p2p: WebRTC connection ${t.pc.connectionState}`));
        }
      };
      sig.onAnswer = (s, sdp) => {
        if (s !== sid) return;
        t.pc.setRemoteDescription({ type: "answer", sdp }).then(() => {
          remoteSet = true;
          for (const c of pending.splice(0)) t.pc.addIceCandidate(c).catch(() => {});
        }).catch((e: unknown) => reject(e));
      };
      sig.onCandidate = (s, c) => {
        if (s !== sid) return;
        if (remoteSet) t.pc.addIceCandidate(c).catch(() => {});
        else pending.push(c);
      };
      sig.onBye = (s) => {
        if (s !== sid || t.open) return;
        clearTimeout(timer);
        t.fail("refused by the host");
        reject(new Error("p2p: the host refused the link (slot not in the battle?)"));
      };
      (sig as { flush?(): void }).flush?.();
      t.pc.createOffer()
        .then((o) => t.pc.setLocalDescription(o))
        .then(() => sig.offer(sid, t.pc.localDescription!.sdp))
        .catch((e: unknown) => { clearTimeout(timer); reject(e); });
    });
  }

  get isOpen(): boolean { return this.open && !this.done; }

  send(data: Uint8Array, reliable: boolean): void {
    if (!this.isOpen) return;
    const b = data as Uint8Array<ArrayBuffer>;
    if (reliable) { if (this.rel.readyState === "open") this.rel.send(b); }
    else if (this.state.readyState === "open" && this.state.bufferedAmount < STATE_HIGH_WATER) this.state.send(b);
  }

  private fail(reason: string): void {
    if (this.done) return;
    this.done = true;
    const wasOpen = this.open;
    this.open = false;
    try { this.pc.close(); } catch { /* ignore */ }
    if (wasOpen) this.onclose?.(reason);
  }

  close(): void {
    // let a queued UNREGISTER (67) leave on 'rel' before the connection goes
    setTimeout(() => this.fail("closed"), 200);
  }
}
