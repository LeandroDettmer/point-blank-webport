// Emblema (clan mark) on the Cross controls: the sheets load once (public/assets/ui/clanmark), then a control that shows a mark
// gets a canvas on top of its sprites (drawClanMark, lobby/clanMark.ts). A control with no mark (null logo, CLAN_MARK_DEFAULT,
// sheets not in yet) hides its canvas. The app registers one redraw with markAtlas, so the controls repaint when the sheets arrive.
import { CLAN_MARK_DEFAULT, drawClanMark, loadClanMarkAtlas, type ClanMarkAtlas } from "../clanMark.ts";
import type { I3Gui } from "../ui/i3Gui.ts";
import { UI_BASE } from "../ui/assets.ts";

const CANVAS_CLASS = "clan-mark-canvas";
let atlas: ClanMarkAtlas | null = null;
let loading: Promise<void> | null = null;
const waiting = new Set<() => void>();

/** the emblem sheets, or null until they are in; `then` runs once when they are (the caller redraws) */
export function markAtlas(then?: () => void): ClanMarkAtlas | null {
  if (atlas) return atlas;
  if (then) waiting.add(then);
  if (!loading) {
    loading = loadClanMarkAtlas(`${UI_BASE}/clanmark/`).then((a) => { atlas = a; }, (e) => console.warn("[cross] clan mark sheets", e)).then(() => {
      for (const f of waiting) f();
      waiting.clear();
    });
  }
  return null;
}

/** draws the mark `logo` centred and square in control `name` (its own size); hides it for null / no mark */
export function paintMark(gui: I3Gui, name: string, logo: number | null | undefined): void {
  const b = gui.get(name);
  if (!b) return;
  let cv = b.el.querySelector<HTMLCanvasElement>(`:scope > canvas.${CANVAS_CLASS}`);
  // no clan (0xFFFFFFFF; 0 = an account row with no clan, the server refuses logo 0): the whole control is hidden, as
  // _SetClanInfoInSlot 0x7d7130 does; otherwise the control's own sprite (the layout's placeholder mark) would show
  const a = logo === null || logo === undefined || logo === CLAN_MARK_DEFAULT || logo === 0 ? null : markAtlas();
  b.el.style.display = a ? "" : "none";
  if (!a || logo === null || logo === undefined) return;
  // the mark replaces the control's sprite: only the canvas is drawn
  for (const ch of b.el.children) if (ch !== cv) (ch as HTMLElement).style.visibility = "hidden";
  if (!cv) {
    cv = document.createElement("canvas");
    cv.className = CANVAS_CLASS;
    cv.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;";
    b.el.appendChild(cv);
  }
  const w = b.node.w, h = b.node.h;
  // the stage is 1024x768 stretched to the window: the backing store follows the on-screen size (x devicePixelRatio),
  // so the mark is drawn at the real pixel size instead of being upscaled (blurry in the room slots)
  const r = b.el.getBoundingClientRect();
  const k = Math.max(1, (r.width > 0 ? r.width / w : 1) * (window.devicePixelRatio || 1));
  const bw = Math.round(w * k), bh = Math.round(h * k);
  if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
  cv.style.width = `${w}px`;
  cv.style.height = `${h}px`;
  const g = cv.getContext("2d");
  if (!g) { cv.style.display = "none"; return; }
  g.clearRect(0, 0, bw, bh);
  const s = Math.min(bw, bh);
  cv.style.display = drawClanMark(g, logo, Math.floor((bw - s) / 2), Math.floor((bh - s) / 2), s, a) ? "" : "none";
}
