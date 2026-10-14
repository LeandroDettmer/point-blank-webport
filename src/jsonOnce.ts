// One fetch + one JSON.parse per URL for the whole session. weapons.json (1.4 MB) was fetched and parsed by five modules
// (WeaponDb, worldModel, remoteActor, RespawnMenu, PbHud), about 50 ms of main thread each, one of them on the first match
// frame. The parsed object is shared: callers must not mutate it.

const cache = new Map<string, Promise<unknown>>();

/** Rejects on HTTP errors and non-JSON bodies (vite answers index.html for a missing file in dev); a failed URL is retried next call. */
export function jsonOnce<T>(url: string): Promise<T> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r.json();
    });
    p.catch(() => { if (cache.get(url) === p) cache.delete(url); });
    cache.set(url, p);
  }
  return p as Promise<T>;
}
