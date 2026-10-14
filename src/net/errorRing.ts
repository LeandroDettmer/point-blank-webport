// Last console errors of the page for the bug report: window.onerror +
// unhandledrejection + console.error, a ring of 20 strings cut to 300 chars. Never tokens / cookies / URL queries.
const MAX = 20;
const CUT = 300;
const ring: string[] = [];
let installed = false;

/** Drops what must never leave the client: URL query strings / fragments, token=... pairs, hex/base64 blobs of 32+ chars (the
 * session token is 32:). */
export function scrub(s: string): string {
  return s
    .replace(/(https?:\/\/[^\s"'<>?#)]+)[?#][^\s"'<>)]*/gi, "$1")
    .replace(/\b(token|auth|authorization|cookie|session|password|pass|secret|key)\s*[=:]\s*\S+/gi, "$1=[x]")
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, "[x]")
    .slice(0, CUT);
}

export function pushError(s: string): void {
  ring.push(scrub(s));
  if (ring.length > MAX) ring.splice(0, ring.length - MAX);
}

export const lastErrors = (): string[] => ring.slice();

const str = (v: unknown): string => {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (typeof v === "string") return v;
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
};

export function installErrorRing(): void {
  if (installed || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  installed = true;
  window.addEventListener("error", (ev) => pushError(`${ev.message || "error"} @${(ev.filename || "").split("/").pop()}:${ev.lineno}`));
  window.addEventListener("unhandledrejection", (ev) => pushError(`unhandledrejection: ${str(ev.reason)}`));
  const orig = console.error.bind(console);
  console.error = (...a: unknown[]) => { try { pushError(a.map(str).join(" ")); } catch { /* ring is best effort */ } orig(...a); };
}

installErrorRing();
