// UI asset helpers: the base folder (public/assets/ui), image keep-alive and the UI fonts.
import type { SheetJson } from "./format.ts";

export const UI_BASE = "/assets/ui";

/** HUD sheet shape (game/pbHud) */
export interface LoadedSheet extends SheetJson { url: string }

/** URL -> image kept alive after decode(). Icons and sheets are CSS backgrounds: once the divs leave the DOM (screen
 *  change) the browser drops the decoded bitmap and decodes again on the next visit; a live Image keeps it. Icons
 *  (small PNGs, ~2-30 KB) are an LRU capped at MAX_KEPT_ICONS; atlas sheets (`pinned`, a few MB each) stay outside the cap. */
const MAX_KEPT_ICONS = 600;
const kept = new Map<string, HTMLImageElement>();
const icons = new Set<string>(); // kept urls that are LRU icons, oldest first
export function keepImage(url: string, pinned = false): void {
  if (!url || typeof Image === "undefined") return;
  if (kept.has(url)) {
    if (icons.delete(url)) icons.add(url); // touched: newest
    return;
  }
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  kept.set(url, img);
  if (!pinned) {
    icons.add(url);
    if (icons.size > MAX_KEPT_ICONS) {
      const oldest = icons.values().next().value as string;
      icons.delete(oldest);
      kept.delete(oldest);
    }
  }
  img.decode().catch(() => { kept.delete(url); icons.delete(url); });
}

/** Arial: the Cross default font (PBCross PointBlank.exe 0x4ada40 -> SetDefaultFont 0x4ada60 at 0x69e8b7; i3Gui:
 *  i3Language::GetDefaultFontName(1252) = "Arial", i3BaseDx_Cli 0x10019ad9). A Windows system font, not a client file. */
const ARIAL = `Arial,"Liberation Sans",sans-serif`;

/**
 * The fonts of the Cross client, per role. Only two faces exist in the exe:
 *  - "Gunplay" = Font/Gunplay.ttf (pbx ui fonts -> ui/fonts/Gunplay.ttf, AddFontResourceExA 0x6c91b0), the face of every
 *    number text node: 20 i3TextNodeDX2::Create("Gunplay", n, 15..32, FW_NORMAL) calls (0x709e72, 0x7b00cd, 0xa47c84...).
 *  - Arial for every other text: HUD texts, battle chat (CBattleChatBox 10 pt, 0x8c123a), lobby and popups (i3Gui).
 * Size and weight come from each call site (lobby: cross-ui-text.json via guiFont). Font/YGO240.ttf is registered by the exe
 * but no text names its face, and Font/Hud_Small_Font is never opened: neither is used.
 */
export const FONTS = {
  hudNumber: `"PB Gunplay",${ARIAL}`,
  hudText: ARIAL,
  chat: ARIAL,
  lobby: ARIAL,
  popup: ARIAL,
} as const;

/** Registers Gunplay (the only font file the Cross client loads). Runs on import so battle/HUD modules never miss it. */
export function ensureUiFont(): void {
  if (document.getElementById("pbui-font")) return;
  const st = document.createElement("style");
  st.id = "pbui-font";
  st.textContent = `@font-face{font-family:"PB Gunplay";src:url("${UI_BASE}/fonts/Gunplay.ttf") format("truetype");font-display:block}`;
  document.head.appendChild(st);
  void document.fonts?.load(`25px "PB Gunplay"`);
}

if (typeof document !== "undefined") ensureUiFont();
