const WINDOW_MS = 60_000;
const MAX_HITS = 10;

const hits = new Map<string, number[]>();

export function isRateLimited(key: string): boolean {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(key, list);
  return list.length > MAX_HITS;
}
