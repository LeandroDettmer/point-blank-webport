// What MatchLink (matchUdpLink.ts) sends its datagrams over: the leader's in-tab host (src/host/local.ts LocalPeer)
// or a WebRTC link to it (src/p2p/guest.ts RtcGuestTransport). The bytes are the Server.Match datagrams.

export interface MatchTransport {
  onopen: (() => void) | null;
  /** reliable: which channel it came in on */
  onmessage: ((data: Uint8Array, reliable: boolean) => void) | null;
  onclose: ((reason: string) => void) | null;
  onerror: ((err: Error) => void) | null;
  readonly isOpen: boolean;
  /** reliable: the datagram carries events a loss would drop for good (register, hits, drops, radio...). WebRTC
   *  picks the ordered reliable channel for it and the unreliable one otherwise. */
  send(data: Uint8Array, reliable: boolean): void;
  close(): void;
}

export type MatchTransportFactory = () => MatchTransport;
