// ICE servers of the P2P match. The server's /signal sends its list in "ready" (SIGNAL_STUN_URLS, TURN_URLS /
// TURN_USERNAME / TURN_CREDENTIAL or Cloudflare TURN in the server env), only to a socket with a valid ticket; this build can
// add public STUN (VITE_STUN_URLS). Never a TURN credential in the bundle: the old VITE_TURN_* are gone
// and vite.config.ts refuses a build that still sets them. Public STUN when nothing is configured.
// relayOnly = iceTransportPolicy 'relay': TURN only, no peer learns another's address (needs a TURN server).

export const DEFAULT_STUN = "stun:stun.l.google.com:19302";

const list = (v: string | undefined) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const isTurn = (s: RTCIceServer) => [s.urls].flat().some((u) => /^turns?:/.test(u));

export function iceConfig(fromServer: RTCIceServer[] = [], relayOnly = false): RTCConfiguration {
  /** import.meta.env is undefined outside Vite (the Node tests) */
  const stun = list((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_STUN_URLS);
  const iceServers: RTCIceServer[] = [...fromServer, ...(stun.length ? [{ urls: stun }] : [])];
  if (!iceServers.some((s) => [s.urls].flat().some((u) => /^stuns?:/.test(u)))) iceServers.unshift({ urls: DEFAULT_STUN });
  if (relayOnly && !iceServers.some(isTurn)) console.warn("[p2p] relay only without a TURN server (TURN_URLS / CF_TURN_* on the server): the link will fail");
  return { iceServers, iceTransportPolicy: relayOnly ? "relay" : "all" };
}
