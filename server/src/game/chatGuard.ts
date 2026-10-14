// Chat hardening: text cleaning, word filter, per-connection flood and the per-room chat ring.
// The ring (last 50 lines of a room) lives in memory only, is cleared when the match ends and is never written to the database: its one use
// is the context an online GM sees when a report is opened during the match (reports.ts).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { battleEndHooks, type RoomModel } from "./roomModel.ts";

// ---- text ------------------------------------------------------------------------------------------------------------

/** Control characters, line breaks and invisible / bidi-override characters become spaces; runs of spaces collapse; trimmed. */
export function cleanChatText(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim();
}

export interface Token { value: string; start: number; end: number }

/** Splits on spaces; "double quotes" keep spaces inside one token (an unclosed quote runs to the end). start / end index the original text. */
export function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === " ") { i++; continue; }
    const start = i;
    if (s[i] === "\"") {
      const close = s.indexOf("\"", i + 1);
      const end = close < 0 ? s.length : close;
      out.push({ value: s.slice(i + 1, end), start, end: close < 0 ? s.length : close + 1 });
      i = close < 0 ? s.length : close + 1;
    } else {
      while (i < s.length && s[i] !== " ") i++;
      out.push({ value: s.slice(start, i), start, end: i });
    }
  }
  return out;
}

// ---- word filter -----------------------------------------------------------------------------------------------------

let words: string[] = [];
/** One char -> its lower-case base letter (accents dropped), always one UTF-16 unit so indexes map back to the original text. */
const fold = (s: string) => Array.from(s, (c) => c.normalize("NFD")[0].toLowerCase()).join("");
const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/** server/runtime/Config/Filters/Chat.txt: one word or phrase per line, `#` comments (the nick filter, Filters/Nicks.txt, uses the same format). */
export function loadChatFilter(): void {
  const f = path.join(config.configDir, "Filters", "Chat.txt");
  setChatFilter(existsSync(f) ? readFileSync(f, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : []);
}
export function setChatFilter(list: string[]): void { words = list.map(fold).filter(Boolean); }

/** Masks every listed word (whole words only, case and accent blind) with `*`. Returns the text unchanged when nothing matches. */
export function filterChatText(text: string): string {
  if (words.length === 0) return text;
  const f = fold(text);
  const out = text.split("");
  for (const w of words) {
    for (let i = f.indexOf(w); i >= 0; i = f.indexOf(w, i + 1)) {
      if (isWordChar(f[i - 1]) || isWordChar(f[i + w.length])) continue;
      for (let k = i; k < i + w.length; k++) out[k] = "*";
    }
  }
  return out.join("");
}

// ---- flood -----------------------------------------------------------------------------------------------------------

export const FLOOD_WINDOW_MS = 5000;
export const FLOOD_MAX = 5;
export const FLOOD_MUTE_MS = 60000;
interface Flood { hits: number[]; mutedUntil: number; lastNotice: number }
const floods = new WeakMap<object, Flood>();

export interface FloodResult { ok: boolean; /** this very call started the auto-mute */ justMuted: boolean; /** seconds of mute left (0 = none) */ mutedFor: number; /** a notice should be sent now (once per 5 s while muted) */ notice: boolean }

/**
 * Per CONNECTION (not per account): every chat / whisper attempt counts, also the ones the 1 msg/s rule drops. More than 5 in 5 s = automatic
 * mute of 60 s [RECRIADO]; while muted everything is refused.
 */
export function floodCheck(conn: object, now = Date.now()): FloodResult {
  let f = floods.get(conn);
  if (!f) floods.set(conn, (f = { hits: [], mutedUntil: 0, lastNotice: 0 }));
  if (f.mutedUntil > now) {
    const notice = now - f.lastNotice >= FLOOD_WINDOW_MS;
    if (notice) f.lastNotice = now;
    return { ok: false, justMuted: false, mutedFor: Math.ceil((f.mutedUntil - now) / 1000), notice };
  }
  f.hits = f.hits.filter((t) => t > now - FLOOD_WINDOW_MS);
  f.hits.push(now);
  if (f.hits.length > FLOOD_MAX) {
    f.hits = [];
    f.mutedUntil = now + FLOOD_MUTE_MS;
    f.lastNotice = now;
    return { ok: false, justMuted: true, mutedFor: FLOOD_MUTE_MS / 1000, notice: true };
  }
  return { ok: true, justMuted: false, mutedFor: 0, notice: false };
}

// ---- per-room ring ---------------------------------------------------------------------------------------------------

export const RING_SIZE = 50;
export interface ChatLine { t: number; slot: number; nick: string; type: number; text: string }
const rings = new WeakMap<RoomModel, ChatLine[]>();

export function ringPush(r: RoomModel, line: ChatLine): void {
  let a = rings.get(r);
  if (!a) rings.set(r, (a = []));
  a.push(line);
  if (a.length > RING_SIZE) a.splice(0, a.length - RING_SIZE);
}
export const ringLines = (r: RoomModel, n = RING_SIZE): ChatLine[] => (rings.get(r) ?? []).slice(-n);
export const ringClear = (r: RoomModel): void => { rings.delete(r); };
battleEndHooks.push(ringClear);

/** a Server line with exactly this text tells the client its account is a GM (the GM panel button); sent on lobby entry */
export const GM_MARK = "GM";

/** `/ajuda` text, also shown at the end of the GM `:help` (every account sees it) */
export const PLAYER_HELP = [
  "Comandos: /w <nick> <texto> sussurro, /r <texto> responde, /ping, /bloquear <nick>, /desbloquear <nick>.",
  "/denunciar <nick> <hack|chat> [detalhe], /votekick <nick> <hack|chat> (batalha), /votelider [nick], /sim, /nao, /bug.",
  "Apelido com espaço: entre \"aspas\". Basta o começo do apelido se for único na sala.",
];
