// Minimal keyed observable (). Owner: ?.
export type Unsubscribe = () => void;

export class Observable<K extends string> {
  private subs = new Map<K | "*", Set<(keys: K[]) => void>>();

  /** `key = "*"` fires on every change with the list of changed keys. */
  subscribe(key: K | "*", fn: (keys: K[]) => void): Unsubscribe {
    let set = this.subs.get(key);
    if (!set) this.subs.set(key, (set = new Set()));
    set.add(fn);
    return () => { set!.delete(fn); };
  }

  protected emit(keys: K[]): void {
    if (!keys.length) return;
    const fired = new Set<(keys: K[]) => void>();
    for (const k of [...keys, "*" as const]) {
      for (const fn of this.subs.get(k as K | "*") ?? []) {
        if (fired.has(fn)) continue;
        fired.add(fn);
        try { fn(keys); } catch (e) { console.error("[lobby/state] subscriber failed", e); }
      }
    }
  }
}
