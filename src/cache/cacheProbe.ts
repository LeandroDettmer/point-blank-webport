// Detects a browser that does not keep the game assets (private tab, cache off, tiny quota), "Cache de assets".
// Evidence: (1) Cache Storage missing or unopenable, (2) storage quota under MIN_QUOTA, (3) the same immutable (hashed) asset
// downloaded again from the network in the same session (PerformanceResourceTiming: transferSize > 0 twice).
// A cross-origin entry only carries sizes with `Timing-Allow-Origin: *` on the asset Worker (deploy/cloudflare/assets-worker.js);
// without it both sizes are 0 and the entry says nothing (no verdict from that URL).

export interface ResEntry { name: string; startTime: number; responseEnd: number; transferSize: number; encodedBodySize: number }
export type NoCacheReason = "no-cache-api" | "low-quota" | "refetch";

/** below this the browser cannot hold a map's worth of assets (Chrome/Firefox private tabs report tens of MB) */
export const MIN_QUOTA = 1024 * 1024 * 1024;
/** only files this big count as evidence (a small one can be re-requested for other reasons) */
export const MIN_BODY = 64 * 1024;
/** distinct URLs fetched twice from the network before the verdict is "refetch" */
export const REFETCH_STRIKES = 3;

const HASHED = /\.[0-9a-f]{8}\.[A-Za-z0-9]+$/;

/** 'network': bytes came over the wire; 'cached': memory/disk/SW cache or a 304; 'opaque': no sizes (no TAO) */
export function entryKind(e: Pick<ResEntry, "transferSize" | "encodedBodySize">): "network" | "cached" | "opaque" {
  if (e.encodedBodySize <= 0 && e.transferSize <= 0) return "opaque";
  if (e.transferSize <= 0) return "cached";
  return e.transferSize < e.encodedBodySize ? "cached" : "network";
}

/** Counts hashed assets downloaded again after their first download had finished. */
export class RefetchTracker {
  private last = new Map<string, number>();
  private again = new Set<string>();

  feed(entries: readonly ResEntry[]): void {
    for (const e of entries) {
      if (e.encodedBodySize < MIN_BODY || entryKind(e) !== "network") continue;
      let path: string;
      try { path = new URL(e.name).pathname; } catch { continue; }
      if (!HASHED.test(path)) continue;
      const prev = this.last.get(e.name);
      // a request that started before the first finished is a parallel duplicate, not a cache miss
      if (prev !== undefined && e.startTime >= prev) this.again.add(e.name);
      this.last.set(e.name, e.responseEnd);
    }
  }

  get strikes(): number { return this.again.size; }
}

export interface StorageInfo { hasCaches: boolean; quota: number | null }

export function verdict(s: StorageInfo, strikes: number): NoCacheReason[] {
  const out: NoCacheReason[] = [];
  if (!s.hasCaches) out.push("no-cache-api");
  if (s.quota !== null && s.quota < MIN_QUOTA) out.push("low-quota");
  if (strikes >= REFETCH_STRIKES) out.push("refetch");
  return out;
}

async function storageInfo(): Promise<StorageInfo> {
  let hasCaches = typeof caches !== "undefined";
  if (hasCaches) {
    try { await caches.open("pb-probe"); await caches.delete("pb-probe"); } catch { hasCaches = false; }
  }
  const quota = await navigator.storage?.estimate?.().then((e) => e.quota ?? null).catch(() => null) ?? null;
  return { hasCaches, quota };
}

/** Watches the page's own resource timings; calls `onWarn` once with the reasons. Returns a stop function. */
export function startCacheGuard(onWarn: (reasons: NoCacheReason[]) => void): () => void {
  if (typeof PerformanceObserver === "undefined") return () => {};
  const tracker = new RefetchTracker();
  let info: StorageInfo | null = null;
  let done = false;
  const check = () => {
    if (done || !info) return;
    const r = verdict(info, tracker.strikes);
    if (r.length) { done = true; obs.disconnect(); onWarn(r); }
  };
  const obs = new PerformanceObserver((list) => { tracker.feed(list.getEntries() as PerformanceResourceTiming[]); check(); });
  try { obs.observe({ type: "resource", buffered: true }); } catch { return () => {}; }
  void storageInfo().then((s) => { info = s; check(); });
  return () => { done = true; obs.disconnect(); };
}
