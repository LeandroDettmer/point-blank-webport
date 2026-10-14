// Host side of the P2P match, after the reference port: the match runs in the
// leader's Worker (src/host/local.ts) and every remote player is one RTCPeerConnection here. Each guest's two data
// channels (src/p2p/channels.ts) are bridged to one Worker peer bound to the guest's slot: its datagrams go to the core,
// the core's come back on 'rel' or 'state' as the core tags them, and a closed or failed link is the peer's close.
import { asBytes, closeFrame, MAX_DATAGRAM, REL, STATE, STATE_HIGH_WATER } from "../p2p/channels.ts";
import type { HostSignaling, OfferIn } from "../p2p/signaling.ts";
import type { LocalHost, LocalPeer } from "./local.ts";

/** the match's 16 battle seats minus the host's (Server.Match keeps 18 player models) */
const MAX_GUESTS = 17;

interface Guest {
  sid: string;
  slot: number;
  pc: RTCPeerConnection;
  state: RTCDataChannel | null;
  rel: RTCDataChannel | null;
  /** the Worker peer, once both channels are open */
  peer: LocalPeer | null;
  remoteSet: boolean;
  pending: RTCIceCandidateInit[];
}

export interface RtcHostOptions {
  /** the RTCPeerConnection implementation (browser global by default; node-datachannel's polyfill in Node tests) */
  RTCPeerConnection?: typeof RTCPeerConnection;
  /** may this slot join? (the leader's RoomClient knows who is in the battle) */
  allowSlot?: (slot: number) => boolean;
  log?: (line: string) => void;
}

export class RtcHost {
  private readonly guests = new Map<string, Guest>();
  /** single use: a sid is never answered twice, whatever the signaling lets through */
  private readonly used = new Set<string>();
  private readonly host: LocalHost;
  private readonly sig: HostSignaling;
  private readonly ice: RTCConfiguration;
  private readonly PC: typeof RTCPeerConnection;
  private readonly allowSlot: (slot: number) => boolean;
  private readonly log: (line: string) => void;
  onGuest: ((slot: number, up: boolean) => void) | null = null;

  constructor(host: LocalHost, sig: HostSignaling, ice: RTCConfiguration, opts: RtcHostOptions = {}) {
    this.host = host;
    this.sig = sig;
    this.ice = ice;
    this.PC = opts.RTCPeerConnection ?? globalThis.RTCPeerConnection;
    this.allowSlot = opts.allowSlot ?? (() => true);
    this.log = opts.log ?? ((l) => console.log(`[p2p] ${l}`));
    sig.onOffer = (o) => { this.offer(o).catch((e: unknown) => { this.log(`offer from slot ${o.slot} failed: ${(e as Error).message}`); this.drop(o.sid, "bad offer"); }); };
    sig.onCandidate = (sid, c) => {
      const g = this.guests.get(sid);
      if (!g) return;
      if (g.remoteSet) g.pc.addIceCandidate(c).catch(() => {});
      else g.pending.push(c);
    };
    sig.onBye = (sid) => this.drop(sid, "guest bye", false);
    sig.flush?.();
  }

  get count(): number { return this.guests.size; }
  slots(): number[] { return [...this.guests.values()].filter((g) => g.peer).map((g) => g.slot); }

  private async offer(o: OfferIn): Promise<void> {
    if (this.used.has(o.sid) || this.guests.size >= MAX_GUESTS || !this.allowSlot(o.slot)) {
      this.log(`refused offer from slot ${o.slot}${this.allowSlot(o.slot) ? "" : " (not in this battle)"}`);
      this.sig.bye(o.sid);
      return;
    }
    this.used.add(o.sid);
    // one link per slot: a new attempt of the same slot replaces the old one
    for (const g of [...this.guests.values()]) if (g.slot === o.slot) this.drop(g.sid, "replaced by a new attempt");
    const pc = new this.PC(this.ice);
    const g: Guest = { sid: o.sid, slot: o.slot, pc, state: null, rel: null, peer: null, remoteSet: false, pending: [] };
    this.guests.set(o.sid, g);
    pc.onicecandidate = (e) => { if (e.candidate) this.sig.candidate(o.sid, e.candidate.toJSON()); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.drop(o.sid, `connection ${pc.connectionState}`);
    };
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      // exactly the two channels of p2p/channels.ts; anything else is refused. Their delivery modes are the guest's
      // choice (a wrong one only hurts its own link) and node-datachannel does not report them for incoming channels.
      if (ch.label === STATE && !g.state) g.state = ch;
      else if (ch.label === REL && !g.rel) g.rel = ch;
      else { ch.close(); return; }
      ch.binaryType = "arraybuffer";
      ch.onopen = () => this.maybeJoin(g);
      ch.onclose = () => this.drop(g.sid, `${ch.label} channel closed`);
      ch.onmessage = (m) => this.fromGuest(g, m.data);
      if (ch.readyState === "open") this.maybeJoin(g);
    };
    await pc.setRemoteDescription({ type: "offer", sdp: o.sdp });
    g.remoteSet = true;
    for (const c of g.pending.splice(0)) pc.addIceCandidate(c).catch(() => {});
    await pc.setLocalDescription(await pc.createAnswer());
    if (this.guests.get(o.sid) === g) this.sig.answer(o.sid, pc.localDescription!.sdp);
  }

  /** both channels up: the guest becomes a peer of the match, bound to its slot (its REGISTER 65 follows on 'rel') */
  private maybeJoin(g: Guest): void {
    if (g.peer || g.state?.readyState !== "open" || g.rel?.readyState !== "open" || this.guests.get(g.sid) !== g) return;
    const peer = (g.peer = this.host.peer(`p2p:slot${g.slot}`, g.slot));
    peer.onmessage = (data, rel) => this.toGuest(g, data, rel);
    // the core closed it (1001 match over, host stopping): tell the guest why, let the frame leave, then drop the link
    peer.onclose = () => {
      if (this.guests.get(g.sid) !== g) return;
      try {
        if (g.rel?.readyState === "open") g.rel.send(closeFrame(peer.closeCode || 1000, peer.closeCode === 1001 ? "match over" : "closed by the host"));
      } catch { /* the channel closed under us: the drop below still releases the link */ }
      setTimeout(() => this.drop(g.sid, `closed by the match (${peer.closeCode})`), 500);
    };
    this.log(`slot ${g.slot} connected (${this.slots().length} guest(s))`);
    this.onGuest?.(g.slot, true);
  }

  private fromGuest(g: Guest, data: unknown): void {
    if (!g.peer?.isOpen) return;
    const b = asBytes(data);
    if (!b) return; // text frames: not match datagrams
    if (b.length > MAX_DATAGRAM) { this.drop(g.sid, "datagram too big"); return; }
    try { g.peer.send(b.slice(), false); } catch { this.drop(g.sid, "send to the match failed"); }
  }

  /** readyState can flip to closed between the check and send (guest leaving, failover): send then throws, drop the link */
  private toGuest(g: Guest, data: Uint8Array, rel: boolean): void {
    try {
      if (!rel) {
        if (g.state?.readyState === "open" && g.state.bufferedAmount < STATE_HIGH_WATER) g.state.send(data as Uint8Array<ArrayBuffer>);
      } else if (g.rel?.readyState === "open") g.rel.send(data as Uint8Array<ArrayBuffer>);
    } catch {
      this.drop(g.sid, `${rel ? "rel" : "state"} send failed`);
    }
  }

  /** the link is gone: the Worker peer closes (the core's peerClosed = its 67), the connection is released */
  private drop(sid: string, why: string, tellGuest = true): void {
    const g = this.guests.get(sid);
    if (!g) return;
    this.guests.delete(sid);
    if (g.peer?.isOpen) g.peer.close();
    try { g.pc.close(); } catch { /* ignore */ }
    if (tellGuest && !g.peer) this.sig.bye(sid);
    this.log(`slot ${g.slot} ${g.peer ? "disconnected" : "not connected"}: ${why}`);
    if (g.peer) this.onGuest?.(g.slot, false);
  }

  /** every guest link down, the signaling socket stays (a host handoff still has to send the snapshot on it) */
  dropGuests(why: string): void {
    for (const sid of [...this.guests.keys()]) this.drop(sid, why);
  }

  close(): void {
    this.dropGuests("host closing");
    this.sig.close();
  }
}
