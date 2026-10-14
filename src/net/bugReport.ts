// Bug report: REQ {H len, U text <=1000, H metaLen,
// U metaJson <=4000} -> ACK 9002 {D err, D id}. The popup UI lives in the lobby (core); the battle HUD shows its
// own and calls sendBugReport. Nothing sensitive goes in the meta: no token, no cookie, URLs without query.
import { PacketWriter } from "./packet.ts";
import { chat } from "./chatClient.ts";
import { lastErrors, scrub } from "./errorRing.ts";

export const BUG_REQ = 9001;
export const BUG_ACK = 9002;
export const BUG_TEXT_MAX = 1000;
const META_MAX = 4000;
export const ERR_BUG_FAIL = 0x80000000;
export const ERR_BUG_LIMIT = 0x80002001;

export interface BugContext {
  fps?: number | null;
  ping?: number | null;
  p2p_role?: "host" | "guest" | "none";
  room_id?: number | null;
  map?: string | number | null;
  mode?: string | number | null;
}
export interface BugResult { ok: boolean; err: number; id: number; message: string }

let ctx: () => BugContext = () => ({});
/** The shell that knows the room / P2P state (lobby controller, boot.ts, battle) registers what it knows. */
export function setBugContext(fn: () => BugContext): void { ctx = fn; }

// ---- average fps (rAF probe, started on first use) ----------------------------------------------------------------
let frames = 0, since = 0, avgFps: number | null = null, probing = false;
export function startFpsProbe(): void {
  if (probing || typeof requestAnimationFrame === "undefined") return;
  probing = true;
  const tick = (t: number) => {
    if (!since) since = t;
    frames++;
    if (t - since >= 2000) { const f = (frames * 1000) / (t - since); avgFps = avgFps === null ? f : avgFps * 0.7 + f * 0.3; frames = 0; since = t; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** hashed bundle name of the running build (Vite emits index-<hash>.js); "dev" outside a build */
function clientBuild(): string {
  try {
    const f = new URL(import.meta.url).pathname.split("/").pop() ?? "";
    const env = (import.meta as { env?: { MODE?: string } }).env;
    return /-[A-Za-z0-9_-]{6,}\./.test(f) ? f : `${env?.MODE ?? "dev"}`;
  } catch { return "unknown"; }
}

export function buildBugMeta(extra?: BugContext): string {
  const c = { ...ctx(), ...extra };
  const meta: Record<string, unknown> = {
    client_build: clientBuild(),
    user_agent: typeof navigator === "undefined" ? "" : navigator.userAgent.slice(0, 200),
    fps: c.fps ?? (avgFps === null ? null : Math.round(avgFps)),
    ping: c.ping ?? null,
    p2p_role: c.p2p_role ?? "none",
    room_id: c.room_id ?? null,
    map: c.map ?? null,
    mode: c.mode ?? null,
    last_errors: lastErrors().map((e) => scrub(e)),
  };
  let json = JSON.stringify(meta);
  while (json.length > META_MAX && (meta.last_errors as string[]).length) { (meta.last_errors as string[]).shift(); json = JSON.stringify(meta); }
  return json.length > META_MAX ? "{}" : json;
}

const MESSAGES: Record<number, string> = {
  [ERR_BUG_LIMIT]: "Limite de relatórios atingido (3 por hora). Tente mais tarde.",
  [ERR_BUG_FAIL]: "Não foi possível enviar o relatório.",
};

export async function sendBugReport(text: string, extra?: BugContext): Promise<BugResult> {
  const t = text.replace(/\u0000/g, "").trim().slice(0, BUG_TEXT_MAX);
  const conn = chat.connection;
  if (!t) return { ok: false, err: ERR_BUG_FAIL, id: 0, message: "Descreva o problema." };
  if (!conn) return { ok: false, err: ERR_BUG_FAIL, id: 0, message: MESSAGES[ERR_BUG_FAIL] };
  const meta = buildBugMeta(extra);
  try {
    const p = conn.waitFor(BUG_ACK, 8000);
    conn.send(BUG_REQ, new PacketWriter(16 + (t.length + meta.length) * 2).writeH(t.length).writeU(t, t.length * 2).writeH(meta.length).writeU(meta, meta.length * 2));
    const r = await p;
    const err = r.readD() >>> 0, id = r.remaining >= 4 ? r.readD() : 0;
    return err === 0 ? { ok: true, err, id, message: `Relatório #${id} enviado. Obrigado!` } : { ok: false, err, id: 0, message: MESSAGES[err] ?? MESSAGES[ERR_BUG_FAIL] };
  } catch {
    return { ok: false, err: ERR_BUG_FAIL, id: 0, message: MESSAGES[ERR_BUG_FAIL] };
  }
}

/** Asks the shell to show the bug popup (lobby: Lobby2017.openBug). A battle HUD registers its own opener while it is up. */
let opener: (() => void) | null = null;
/** returns the previous opener so a battle HUD can put the lobby's back when it closes */
export function setBugOpener(fn: (() => void) | null): (() => void) | null { const prev = opener; opener = fn; return prev; }
