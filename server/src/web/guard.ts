// Abuse guards of the web front: a token bucket (per WebSocket, in messages) and a cap of concurrent
// WebSockets per remote IP. Pure logic: webServer.ts and wsSocket.ts wire it.

export class Bucket {
  private tokens: number;
  private at: number;
  private readonly burst: number;
  private readonly perSec: number;
  constructor(burst: number, perSec: number, now = Date.now()) {
    this.burst = burst; this.perSec = perSec; this.tokens = burst; this.at = now;
  }
  take(n = 1, now = Date.now()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.perSec);
    this.at = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/** concurrent connections per IP; loopback is exempt (dev, tests, a reverse proxy on the same host) */
export class IpCap {
  private live = new Map<string, number>();
  private readonly max: number;
  constructor(max: number) { this.max = max; }
  /** true = accepted (call release() on close) */
  acquire(ip: string): boolean {
    if (ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.")) return true;
    const n = this.live.get(ip) ?? 0;
    if (n >= this.max) return false;
    this.live.set(ip, n + 1);
    return true;
  }
  release(ip: string): void {
    const n = this.live.get(ip);
    if (n === undefined) return;
    if (n <= 1) this.live.delete(ip); else this.live.set(ip, n - 1);
  }
}
