// The leader's side of the P2P match host: starts the match Worker (src/host/worker.ts,
// the Server.Match port) and hands out peers of it. The leader's own MatchLink uses one (LocalPeer is a MatchTransport),
// every WebRTC guest gets one through src/host/rtc.ts.
import type { MatchTransport } from "../net/matchTransport.ts";
import type { GameSyncOut, MatchConfig, MatchData, MatchSnapshot, RespawnSyncIn } from "./matchCore.ts";
import type { HostIn, HostOut, HostStats } from "./messages.ts";

/** What LocalHost needs of a Worker (a browser Worker, or a node:worker_threads adapter in tests). */
export interface WorkerLike {
  postMessage(m: HostIn): void;
  onmessage: ((e: { data: HostOut }) => void) | null;
  onerror: ((e: { message: string }) => void) | null;
  terminate(): void;
}

/** One peer of the match: datagrams in both directions, `reliable` tells which WebRTC channel they belong on. */
export class LocalPeer implements MatchTransport {
  readonly id: number;
  readonly label: string;
  onopen: (() => void) | null = null;
  onmessage: ((data: Uint8Array, reliable: boolean) => void) | null = null;
  onclose: ((reason: string) => void) | null = null;
  onerror: ((err: Error) => void) | null = null;
  /** the worker closed it: code 1001 = match over */
  closeCode = 0;
  private state: 0 | 1 | 3 = 0;
  private readonly host: LocalHost;
  constructor(host: LocalHost, id: number, label: string) {
    this.host = host;
    this.id = id;
    this.label = label;
  }
  get isOpen(): boolean { return this.state === 1; }
  send(data: Uint8Array, _reliable: boolean): void {
    if (this.state === 1) this.host.post({ t: "dgram", id: this.id, data });
  }
  close(): void {
    if (this.state === 3) return;
    this.host.post({ t: "close", id: this.id });
    this.closed(1000, "closed");
  }
  /** @internal */
  opened(): void {
    if (this.state !== 0) return;
    this.state = 1;
    this.onopen?.();
  }
  /** @internal */
  closed(code: number, reason: string): void {
    if (this.state === 3) return;
    this.state = 3;
    this.closeCode = code;
    this.onclose?.(`${code} ${reason}`);
  }
}

export interface LocalHostInit {
  uniqueRoomId: number;
  roomSeed: number;
  data: MatchData;
  config?: Partial<MatchConfig>;
  /** a host handoff: the old host's MatchCore.snapshot() */
  restore?: MatchSnapshot;
}

export class LocalHost {
  private readonly peers = new Map<number, LocalPeer>();
  private nextId = 1;
  private readonly worker: WorkerLike;
  private statsWaiters: ((s: HostStats) => void)[] = [];
  private snapshotWaiters: ((s: MatchSnapshot) => void)[] = [];
  /** set when the core was started from a snapshot (host handoff): src/host/bridge.ts lines up with it */
  restored: { startTick: number; slots: number[] } | null = null;
  /** SendMatchInfo (Match -> Game): src/host/bridge.ts forwards what Server.Game accepts from a client */
  onGame: ((m: GameSyncOut) => void) | null = null;
  onLog: ((line: string) => void) | null = (line) => console.debug(`[p2p host] ${line}`);

  private constructor(worker: WorkerLike) {
    this.worker = worker;
  }

  /** The browser Worker (Vite bundles src/host/worker.ts as its own chunk). */
  static browserWorker(): WorkerLike {
    return new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "pb-match-host" }) as unknown as WorkerLike;
  }

  /** Boots the match core in `worker`; resolves once it serves the room. */
  static start(worker: WorkerLike, init: LocalHostInit, timeoutMs = 10000): Promise<LocalHost> {
    return new Promise((resolve, reject) => {
      const host = new LocalHost(worker);
      const t = setTimeout(() => reject(new Error("p2p host: the match worker did not start")), timeoutMs);
      worker.onmessage = (e) => {
        const m = e.data;
        switch (m.t) {
          case "ready": clearTimeout(t); host.restored = m.restored ?? null; resolve(host); break;
          case "snapshot": for (const w of host.snapshotWaiters.splice(0)) w(m.snapshot); break;
          case "dgram": host.peers.get(m.id)?.onmessage?.(m.data, m.rel); break;
          case "close": { const p = host.peers.get(m.id); host.peers.delete(m.id); p?.closed(m.code, m.reason); break; }
          case "game": host.onGame?.(m.m); break;
          case "log": host.onLog?.(m.line); break;
          case "stats": for (const w of host.statsWaiters.splice(0)) w(m.stats); break;
          case "error": console.warn(`[p2p host] worker: ${m.message}`); break;
        }
      };
      worker.onerror = (e) => { clearTimeout(t); reject(new Error(`p2p host: worker error ${e.message}`)); };
      worker.postMessage({ t: "start", ...init });
    });
  }

  /** A new peer of the match. slot: the one UDP header slot it may use (a guest); undefined for the leader itself. */
  peer(label: string, slot?: number): LocalPeer {
    const p = new LocalPeer(this, this.nextId++, label);
    this.peers.set(p.id, p);
    this.post({ t: "open", id: p.id, label, ...(slot !== undefined ? { slot } : {}) });
    queueMicrotask(() => p.opened()); // postMessage is ordered: frames sent after this reach the worker after 'open'
    return p;
  }

  respawn(s: RespawnSyncIn): void { this.post({ t: "respawn", s }); }
  removePlayer(slot: number, type = 1): void { this.post({ t: "remove", slot, type }); }
  round(round: number, teamSwap: boolean): void { this.post({ t: "round", round, teamSwap }); }
  /** ENDBATTLE: the worker closes every peer (1001) */
  end(reason: string): void { this.post({ t: "end", reason }); }
  stats(): Promise<HostStats> {
    return new Promise((resolve) => { this.statsWaiters.push(resolve); this.post({ t: "stats" }); });
  }

  /** The core's state for the next host. Take it once, then stop serving: whatever the core does
   * afterwards is not in it. */
  snapshot(timeoutMs = 2000): Promise<MatchSnapshot> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("p2p host: the match worker did not answer the snapshot")), timeoutMs);
      this.snapshotWaiters.push((s) => { clearTimeout(t); resolve(s); });
      this.post({ t: "snapshot" });
    });
  }

  /** @internal */
  post(m: HostIn): void { this.worker.postMessage(m); }

  stop(): void {
    for (const p of this.peers.values()) p.closed(1001, "host stopped");
    this.peers.clear();
    this.worker.terminate();
  }
}
