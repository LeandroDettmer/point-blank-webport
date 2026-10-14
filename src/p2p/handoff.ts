// Host handoff: the room leader changed on purpose, so the
// old host (its tab still alive) gives the new one the match core's state instead of letting it start a fresh core.
// Carried by the server's /signal route as `handoff` text frames, because that is the one channel the new host has to
// the old one before they share a WebRTC link: the new host opens /signal as a guest of its own slot and listens, the old
// host (on /signal as host) sends. The snapshot is gzip + base64, cut in chunks that fit a signaling message (16 KiB).
import type { MatchSnapshot } from "../host/matchCore.ts";

export const HANDOFF_VERSION = 1;
/** base64 characters per frame (a /signal message is at most 16 KiB, the frame's own fields take < 200 B) */
export const HANDOFF_CHUNK = 12000;
/** a snapshot is not worth more than this once unpacked (a real one is ~50 KB): refuses a hostile or corrupt blob */
const MAX_UNPACKED = 4 * 1024 * 1024;
const MAX_CHUNKS = 16;

/** what the old host hands over: the core's snapshot and what the new host's bridge needs (src/host/bridge.ts exportState) */
export interface HandoffEnvelope {
  v: number;
  /** the old host's slot */
  from: number;
  core: MatchSnapshot;
  bridge: { spawned: number[] };
}

/** one `handoff` frame, as the old host sends it (`to` = the new leader's slot) and as the new one reads it (server adds `from`) */
export interface HandoffFrame {
  /** transfer id: [A-Za-z0-9_-]{8,32}, one per snapshot (a repeated send keeps it) */
  x: string;
  /** chunk index / chunk count */
  i: number;
  n: number;
  blob: string;
}
export type HandoffIn = HandoffFrame & { from?: number };

export interface HandoffSender { handoff(to: number, f: HandoffFrame): void }
export interface HandoffReceiver { onHandoff: ((f: HandoffIn) => void) | null; /** re-deliver frames that came before the handler */ flush?(): void }

const b64 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pipe(data: Uint8Array, t: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const w = t.writable.getWriter();
  void w.write(data as Uint8Array<ArrayBuffer>).then(() => w.close()).catch(() => {});
  const parts: Uint8Array[] = [];
  let n = 0;
  const r = t.readable.getReader();
  for (;;) {
    const { value, done } = await r.read();
    if (done) break;
    n += value.length;
    if (n > limit) { void r.cancel(); throw new Error("handoff: snapshot too big"); }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const newXid = (): string => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");

/** snapshot -> frames (JSON, gzip, base64, chunks of HANDOFF_CHUNK) */
export async function encodeHandoff(env: HandoffEnvelope): Promise<HandoffFrame[]> {
  const packed = b64(await pipe(new TextEncoder().encode(JSON.stringify(env)), new CompressionStream("gzip")));
  const n = Math.max(1, Math.ceil(packed.length / HANDOFF_CHUNK));
  if (n > MAX_CHUNKS) throw new Error(`handoff: snapshot needs ${n} frames`);
  const x = newXid();
  return Array.from({ length: n }, (_, i) => ({ x, i, n, blob: packed.slice(i * HANDOFF_CHUNK, (i + 1) * HANDOFF_CHUNK) }));
}

/** Frames of one transfer -> envelope; null while a chunk is missing. Frames of another transfer id restart it (the old
 * host sent a newer snapshot); a repeated chunk is harmless. */
export class HandoffAssembler {
  private x = "";
  private chunks: (string | undefined)[] = [];
  private done = false;
  add(f: HandoffIn): Promise<HandoffEnvelope | null> {
    if (this.done || typeof f.x !== "string" || !Number.isInteger(f.i) || !Number.isInteger(f.n) || f.n < 1 || f.n > MAX_CHUNKS || f.i < 0 || f.i >= f.n || typeof f.blob !== "string") return Promise.resolve(null);
    if (f.x !== this.x || this.chunks.length !== f.n) { this.x = f.x; this.chunks = new Array<string | undefined>(f.n).fill(undefined); }
    this.chunks[f.i] = f.blob;
    if (this.chunks.some((c) => c === undefined)) return Promise.resolve(null);
    this.done = true;
    return decodeHandoff(this.chunks.join(""));
  }
}

async function decodeHandoff(packed: string): Promise<HandoffEnvelope> {
  const env = JSON.parse(new TextDecoder().decode(await pipe(unb64(packed), new DecompressionStream("gzip"), MAX_UNPACKED))) as HandoffEnvelope;
  if (!env || env.v !== HANDOFF_VERSION || !env.core || !Array.isArray(env.core.rooms) || !Array.isArray(env.bridge?.spawned)) throw new Error("handoff: not a snapshot of this build");
  return env;
}

/** Old host: send the snapshot to the new leader. The new leader may not be listening yet (it opens its /signal guest
 * socket when it sees the leader change, as the old host does), and a frame to a slot with no socket is dropped, so the
 * whole transfer repeats every `everyMs` for `forMs` (the receiver dedups by transfer id). */
export async function sendHandoff(sig: HandoffSender, to: number, env: HandoffEnvelope, o: { everyMs?: number; forMs?: number } = {}): Promise<void> {
  const frames = await encodeHandoff(env);
  const every = o.everyMs ?? 300, until = Date.now() + (o.forMs ?? 1200);
  const burst = () => { for (const f of frames) sig.handoff(to, f); };
  burst();
  while (Date.now() + every < until) {
    await new Promise((r) => setTimeout(r, every));
    burst();
  }
}

/** New host: the old host's snapshot, or null after `ms` (old host dead / frozen / on a build without handoff, or a corrupt
 * blob): the caller then does the fresh-core takeover (Fase 1). */
export function receiveHandoff(sig: HandoffReceiver, ms = 2000): Promise<HandoffEnvelope | null> {
  return new Promise((resolve) => {
    const asm = new HandoffAssembler();
    const end = (e: HandoffEnvelope | null) => { clearTimeout(t); sig.onHandoff = null; resolve(e); };
    const t = setTimeout(() => end(null), ms);
    sig.onHandoff = (f) => {
      asm.add(f).then((e) => { if (e) end(e); }).catch((err: unknown) => { console.warn("[p2p] handoff refused:", (err as Error).message); end(null); });
    };
    sig.flush?.();
  });
}
