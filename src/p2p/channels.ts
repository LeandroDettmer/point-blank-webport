// The two data channels of a P2P match link, opened by the guest, as in the reference port:
//   'state'  unordered, maxRetransmits 0: what the next datagram replaces (positions / ActionState / HP at 25 Hz, pings)
//   'rel'    ordered, reliable: register / unregister, CONNECT, and every datagram carrying an event (hits, deaths,
//            drops, pick-ups, radio, weapon change, objects, the respawn re-sync)
// Both carry the Server.Match datagrams as binary messages, byte for byte. A text message on 'rel' is a control frame
// of the host (the reason it closed the link), never a match datagram.

export const STATE = "state";
export const REL = "rel";
export const STATE_INIT: RTCDataChannelInit = { ordered: false, maxRetransmits: 0 };
export const REL_INIT: RTCDataChannelInit = { ordered: true };

/** an unreliable datagram is dropped, not queued, once this much is waiting on its channel (a congested link) */
export const STATE_HIGH_WATER = 64 * 1024;
/** Server.Match's receive buffer (MatchManager: 22..8096 bytes); anything bigger from a guest closes its link */
export const MAX_DATAGRAM = 8096;

export const closeFrame = (code: number, reason: string): string => JSON.stringify({ t: "_close", code, reason });
export function readCloseFrame(d: string): { code: number; reason: string } | null {
  try {
    const m = JSON.parse(d) as { t?: unknown; code?: unknown; reason?: unknown };
    if (m.t !== "_close") return null;
    return { code: typeof m.code === "number" ? m.code : 1000, reason: typeof m.reason === "string" ? m.reason : "" };
  } catch {
    return null;
  }
}

/** RTCDataChannel message payloads as bytes (browsers: ArrayBuffer; node-datachannel: Buffer / ArrayBuffer) */
export function asBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}
