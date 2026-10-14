// Rank and clan-grade icons on the Cross controls, drawn on a canvas at the on-screen size (the same technique as the emblem,
// clanMarkView.ts). The CSS sprite (I3Gui.sprite) shows its atlas cell as a bilinear background, stretched by the control size
// and then by the stage scale, so a 22 px rank cell is soft at any window bigger than 1024x768. Here the cell is drawn once
// into a backing store of the real pixel size, with high smoothing. Same atlas pixels: only the resampling changes.
// The CSS sprite stays under the canvas as the fallback until the atlas PNG is decoded (setIconRedraw repaints then).
import type { I3Gui } from "../ui/i3Gui.ts";
import { UI_BASE } from "../ui/assets.ts";

const ATLAS = `${UI_BASE}/cross/atlas`;
const CANVAS_CLASS = "icon-canvas";
/** atlas sheets whose cells are rank / grade icons: a control whose own sprite is one of them is painted by paintNodeIcons */
const ICON_SHEETS = new Set(["interface_level_icon", "interface_clan_level"]);

interface Atlas { img: HTMLImageElement; ok: boolean }
const atlases = new Map<string, Atlas>();
/** controls whose cell is set by paintShapeIndex (per gui), so paintNodeIcons leaves them to it */
const indexed = new WeakMap<I3Gui, Set<string>>();
let redraw: (() => void) | null = null;

/** the repaint run once an atlas PNG decodes (the Cross app: its ctl.draw) */
export function setIconRedraw(fn: () => void): void { redraw = fn; }

/** the decoded atlas sheet `tex`, or null while it loads (then `redraw` runs once it is in) */
function atlasOf(tex: string): HTMLImageElement | null {
  let a = atlases.get(tex);
  if (!a) {
    const img = new Image();
    const cur: Atlas = { img, ok: false };
    a = cur;
    atlases.set(tex, cur);
    img.onload = () => { cur.ok = true; redraw?.(); };
    img.onerror = () => console.warn("[cross] icon atlas", tex);
    img.src = `${ATLAS}/${tex}.png`;
  }
  return a.ok ? a.img : null;
}

/**
 * Draws the atlas rect `r` over control `name`, at the control's on-screen size, and hides its CSS sprites. False = not
 * drawn (no control, no rect, or the atlas is not in yet): the CSS sprite stays.
 */
export function paintIconRect(gui: I3Gui, name: string, r: { tex: string; u: number; v: number; w: number; h: number } | null): boolean {
  const b = gui.get(name);
  const img = r && b ? atlasOf(r.tex) : null;
  if (!b || !r || !img) return false;
  let cv = b.el.querySelector<HTMLCanvasElement>(`:scope > canvas.${CANVAS_CLASS}`);
  if (!cv) {
    cv = document.createElement("canvas");
    cv.className = CANVAS_CLASS;
    cv.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;";
    b.el.appendChild(cv);
  }
  // the canvas replaces the control's sprites (the CSS ones stay in the DOM, hidden)
  for (const ch of b.el.children) if (ch !== cv) (ch as HTMLElement).style.visibility = "hidden";
  const w = b.node.w, h = b.node.h;
  // backing store = on-screen size (layout size x stage scale x devicePixelRatio), as clanMarkView.paintMark
  const box = b.el.getBoundingClientRect();
  const k = Math.max(1, (box.width > 0 ? box.width / w : 1) * (window.devicePixelRatio || 1));
  const bw = Math.round(w * k), bh = Math.round(h * k);
  if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
  cv.style.width = `${w}px`;
  cv.style.height = `${h}px`;
  const g = cv.getContext("2d");
  if (!g) return false;
  g.clearRect(0, 0, bw, bh);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(img, r.u, r.v, r.w, r.h, 0, 0, bw, bh);
  return true;
}

/** SetShapeUVIndex (rank cell) drawn on the canvas; the CSS sprite is set as well, as the fallback */
export function paintShapeIndex(gui: I3Gui, name: string, index: number, cell: number, tex: number): void {
  gui.setShapeUVIndex(name, index, cell, tex);
  let set = indexed.get(gui);
  if (!set) { set = new Set(); indexed.set(gui, set); }
  set.add(name);
  paintIconRect(gui, name, gui.shapeUVRect(name, index, cell, tex));
}

/** every rank / grade control of `gui` that has a static cell (its own sprite, no SetShapeUVIndex): drawn on the canvas */
export function paintNodeIcons(gui: I3Gui): void {
  const claimed = indexed.get(gui);
  for (const [name, b] of gui.byName) {
    const im = b.node.images?.[0];
    if (!im || !ICON_SHEETS.has(im[0]) || claimed?.has(name)) continue;
    paintIconRect(gui, name, { tex: im[0], u: im[3], v: im[4], w: im[5], h: im[6] });
  }
}
