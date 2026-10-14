// Messages between the leader's tab (src/host/local.ts LocalHost) and the match Worker (src/host/runtime.ts).
import type { GameSyncOut, MatchConfig, MatchData, MatchSnapshot, RespawnSyncIn } from "./matchCore.ts";

export type HostIn =
  /** restore: a host handoff: the core is rebuilt from the old host's snapshot before it serves anyone */
  | { t: "start"; uniqueRoomId: number; roomSeed: number; data: MatchData; config?: Partial<MatchConfig>; restore?: MatchSnapshot }
  /** a new peer; slot = the only header slot it may send as (a WebRTC guest), undefined = any (the leader's own) */
  | { t: "open"; id: number; label: string; slot?: number }
  | { t: "dgram"; id: number; data: Uint8Array }
  | { t: "close"; id: number }
  | { t: "respawn"; s: RespawnSyncIn }
  | { t: "remove"; slot: number; type: number }
  | { t: "round"; round: number; teamSwap: boolean }
  /** the match is over (ENDBATTLE): every peer is closed with 1001 */
  | { t: "end"; reason: string }
  | { t: "stats" }
  /** MatchCore.snapshot() for the next host (answered with `snapshot`) */
  | { t: "snapshot" };

export interface HostStats { rx: number; tx: number; relayed: number; dropped: number; spoofed: number; peers: number; players: { slot: number; peer: string | null; life: number; dead: boolean; respawn: number }[] }

export type HostOut =
  /** restored: set when `start` carried a snapshot (MatchCore.restore's result) */
  | { t: "ready"; restored?: { startTick: number; slots: number[] } }
  | { t: "snapshot"; snapshot: MatchSnapshot }
  | { t: "dgram"; id: number; data: Uint8Array; rel: boolean }
  | { t: "close"; id: number; code: number; reason: string }
  | { t: "game"; m: GameSyncOut }
  | { t: "log"; line: string }
  | { t: "stats"; stats: HostStats }
  | { t: "error"; message: string };

/** the worker end of the pipe: `self` in a Web Worker, a node:worker_threads parentPort adapter in tests */
export interface HostPort {
  postMessage(m: HostOut): void;
  onmessage: ((e: { data: HostIn }) => void) | null;
}
