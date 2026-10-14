// Generic renderer of classic i3Gui windows (the pre-i3UIs engine GUI: EpicBlackout / PB Cross UI_Project_*.i3Pack), drawn
// from the exported tree: one absolutely placed
// div per control, the template's sprites from the atlas PNGs. Shared by the classic Option window
// (game/classicOptionWindow.ts) and the Cross lobby (lobby/screensCross).
//   - one sprite per state (button: 0 normal, 1 over, 2 pressed / selected, 3 disabled) or, for a template whose images
//     carry offsets / several sizes (Window, Frame, Edit, ListScroll...), one picture in pieces relaid for the control's size
//   - Check templates: images 0..3 = the box, 4 = the tick (shown while set)
//   - text: the files carry none (the exe sets it by control name), the caller passes it per control; its attributes
//     (alignment, colour, font, offset, spacing) come from the exe's calls per control, exported as `txt` (TextAttr)
import { ensureUiFont, FONTS } from "./assets.ts";
import { GDI_ARIAL } from "./gdiArial.ts";

/** flip: 1 mirror X | 2 mirror Y inside the piece's rect */
export type Img = [tex: string, dx: number, dy: number, u: number, v: number, sw: number, sh: number, dw: number, dh: number, flip?: number];
/**
 * Text attributes the exe gives a control: align [h, v] (h 0 left
 * 1 centre 2 right, v 0 top 1 middle 2 bottom), colour, font [point size, weight], offset / space [x, y] in px, wrap 0/1,
 * caption 1 = button caption (0x7d2d50). Missing field = the engine default.
 */
export interface TextAttr { align?: [number, number]; color?: string; font?: [number, number]; offset?: [number, number]; space?: [number, number]; wrap?: number; caption?: number; shadow?: [number, number] }
export interface GNode { name: string; cls: string; x: number; y: number; w: number; h: number; tpl?: string; images?: Img[]; children?: GNode[]; txt?: TextAttr }

export const findNode = (n: GNode, name: string): GNode | undefined => (n.name === name ? n : n.children?.map((c) => findNode(c, name)).find(Boolean));
export const cloneNode = (n: GNode): GNode => JSON.parse(JSON.stringify(n)) as GNode;
export const renameTree = (n: GNode, from: string, to: string): void => { n.name = n.name.replace(from, to); n.children?.forEach((c) => renameTree(c, from, to)); };

/** offsets are u32 in the file: 0xffffffff = -1 */
const s32 = (v: number): number => (v > 0x7fffffff ? v - 0x100000000 : v);
/** design px a stretched piece grows under its neighbours (I3Gui.pieces): >= 1 screen px at any Stage scale >= 1 */
const SEAM = 1;

/**
 * The sprites of a node: a template with offsets is one picture in pieces, otherwise one image per state. Sizes alone do not
 * make pieces: state lists mix sizes (the mode tag of the map boxes has one 59 px shape among 60 px ones, the PC-cafe icons,
 * tabs, sale marks), and pieces all at offset 0 would sit on top of each other.
 */
export const isPieces = (imgs: Img[]): boolean => imgs.length > 1 && imgs.some((i) => s32(i[1]) !== 0 || s32(i[2]) !== 0);

/**
 * Line breaks of i3TextAttrDX2::_ArrangeText (Cross i3SceneDx 0x101041d0) with auto wrap on (flag 0x10000 of +0x34, set by
 * the ctor): glyph advances (+ space x) add up until the line passes the box width W (0x1010428a); a space / tab there
 * breaks before it; otherwise the part of the word since the last space (from line start when there is none) is measured
 * (_calcGlyphWidth 0x100a44d0): wider than W minus itself (more than half the box) -> break inside the word before the glyph
 * that overflowed, else after that space (0x101042b7). A line keeps at least one glyph. Break points: only " " (flag 1,
 * _SetText 0x10106a42); "\n" / "\r" start a new line (flag 2, 0x10106a05). Nothing is clipped to the box
 * (setOutCharaProcess, +0x22c, is 0 from the ctor and no control here turns it on): a line wider than the box (one long
 * glyph run) and lines below the box overflow it. The space a wrapped line starts with is dropped here (the engine keeps it
 * in the centring width but moves the pen 1 px instead of its advance, 0x101043cd).
 */
export function arrangeText(s: string, w: number, charW: (ch: string) => number, spaceX = 0): string {
  const out: string[] = [];
  for (const para of s.split(/\r\n|\r|\n/)) {
    const g = [...para];
    let start = 0;
    if (!g.length) out.push("");
    while (start < g.length) {
      let width = 0, space = start, i = start;
      for (; i < g.length; i++) {
        if (g[i] === " ") space = i;
        width += charW(g[i]) + spaceX;
        if (width > w) break;
      }
      let end = g.length;
      if (i < g.length) {
        if (g[i] === " " || g[i] === "\t") end = i;
        else {
          const seg = g.slice(space, i + 1).reduce((a, ch) => a + charW(ch) + spaceX, 0);
          end = seg > w - seg ? i : space + 1;
        }
        end = Math.max(end, start + 1);
      }
      out.push(g.slice(start, end).join(""));
      start = end;
      while (start < g.length && g[start] === " ") start++;
    }
  }
  return out.join("\n");
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** advance of one glyph in a CSS font (no kerning: the engine sums glyph advances) */
function canvasWidth(font: string, ch: string): number {
  if (measureCtx === undefined) measureCtx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!measureCtx) return 0;
  measureCtx.font = font;
  return measureCtx.measureText(ch).width;
}

/** the engine font of a point size / weight: CSS font, line advance, glyph advance */
export interface GuiFont { css: string; lineH: number; w: (ch: string) => number }
const guiFonts = new Map<string, GuiFont>();
/**
 * i3TextAttrDX2::CreateEx (Cross i3SceneDx 0x10105b10): LOGFONT Arial, lfHeight = FontPointToPixel(pt) > 0 (cell height),
 * the given weight; each glyph's width = GDI GetTextExtentPoint32A of that one char (i3GfxFontDX2::getGlyph i3GfxDx
 * 0x100b0430 -> _DrawFontToDrawTex 0x100ae820), whole hinted pixels, ~8 % narrower than plain Arial at the cell's em
 * (10 pt "Arma secundária" = 79 px in GDI, 88 px in CSS Arial 11.64 px; button 82 px). Line advance = getGlyphHeight (the
 * extent's cy = tmHeight) + space y. Widths from the GDI table (gdiArial.ts, tools/re/gdi-arial-widths.py); the text is
 * drawn at the CSS size with the same average advance. A size / char outside the table: the browser's plain Arial at the
 * cell's em [INFERIDO].
 */
export function guiFont(pt: number, weight: number): GuiFont {
  const cell = fontCell(pt), key = `${cell}/${weight >= 650 ? 700 : weight >= 500 ? 600 : 400}`;
  let f = guiFonts.get(key);
  if (f) return f;
  const t = GDI_ARIAL[key];
  const css = `${weight >= 600 ? "bold" : "normal"} ${t ? t.em : +(cell / ARIAL_CELL_EM).toFixed(2)}px ${GUI_FONT}`;
  const w = (ch: string): number => {
    const i = (ch.codePointAt(0) ?? 0) - 32, c = t && i >= 0 && i < t.w.length ? t.w.charCodeAt(i) - 48 : 0;
    return c > 0 ? c : canvasWidth(css, ch);
  };
  guiFonts.set(key, (f = { css, lineH: t?.h ?? cell, w }));
  return f;
}
const nodeFont = (n: GNode): GuiFont => guiFont(...(n.txt?.font ?? [10, 400]));

/**
 * i3TextAttrDX2 shadow (Cross i3SceneDx): on only when the exe passes bShadow to CreateTextEx / ReCreateTextEx (args 7/8 ->
 * CreateEx state 0x20000, 0x10105ba7); ADDControlByGUI (i3GuiDx 0x10012b6f) and CreateCaption (0x100237a8) pass 0, so
 * EditBox and caption text has none by default. Drawn under the glyph in the shadow colour (ctor 0x1010478a: black, alpha
 * 255): FONT_SHADOW_QUALITY 1/2 = 4 copies at (+-1, +-1) (offset table PB RUSSIA i3SceneDx 0x10281af0, writer 0x1013a7d0),
 * other = 1 copy at (+1, +1). Design px: scaled with the UI like the engine's vertices.
 */
const shadowCss = (n: GNode): string => {
  const [on, q] = n.txt?.shadow ?? [0, 0];
  return !on ? "none" : q === 1 || q === 2 ? "-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000" : "1px 1px 0 #000";
};

/**
 * The pieces of a template are laid out for the size of its first user; another size keeps the corner pieces and
 * stretches the ones that are already scaled (dst != src), pieces right of / below a stretched one move by the difference.
 */
export function relayout(imgs0: Img[], w: number, h: number): Img[] {
  const imgs = imgs0.map((i) => [i[0], s32(i[1]), s32(i[2]), ...i.slice(3)] as Img);
  const W0 = Math.max(...imgs.map((i) => i[1] + i[7])), H0 = Math.max(...imgs.map((i) => i[2] + i[8]));
  const dW = w - W0, dH = h - H0;
  if (dW === 0 && dH === 0) return imgs;
  const sx = Math.min(...imgs.filter((i) => i[7] !== i[5]).map((i) => i[1]), Infinity);
  const sy = Math.min(...imgs.filter((i) => i[8] !== i[6]).map((i) => i[2]), Infinity);
  return imgs.map((i) => {
    const o = [...i] as Img;
    if (i[7] !== i[5]) o[7] = i[7] + dW; else if (i[1] > sx) o[1] = i[1] + dW;
    if (i[8] !== i[6]) o[8] = i[8] + dH; else if (i[2] > sy) o[2] = i[2] + dH;
    return o;
  });
}

/** shapes: every sprite of the control in file order (the pieces of one picture, or the state sprites) */
export interface Built { el: HTMLElement; node: GNode; states: HTMLElement[]; shapes: HTMLElement[]; tick?: HTMLElement }

export interface I3GuiOptions {
  /** folder holding atlas/<tex>.png */
  base: string;
  /** atlas texture name as written by the exporter -> file name (default: the name itself) */
  atlas?: (tex: string) => string;
  /** background-size of every atlas (the classic Option atlases are 512x512); omitted = the PNG's own size */
  atlasSize?: number;
  /** text of a control at build time (undefined = none) */
  text?: (n: GNode) => string | undefined;
  /** [INFERIDO] fallback for a control without `txt` (exe call not found): window caption style (bigger, white) */
  caption?: (n: GNode) => boolean;
  /** [INFERIDO] fallback for a control without `txt`: text centred (default: buttons, the caption and number boxes) */
  centred?: (n: GNode) => boolean;
}

/** i3Gui text font: GetDefaultFontName (Cross exe 0x4ada40) = "Arial", i3GuiRoot::Create(font, 10 pt) 0x79e123 */
export const GUI_FONT = FONTS.lobby;
/** code-drawn lobby text (same face; size and weight at the call) */
export const TEXT_FONT = FONTS.lobby;
/**
 * Point size -> CSS px: i3Gfx::FontPointToPixel = round(pt * dpi / 72) (i3GfxDx 0x100b9a20, 96 dpi) is the LOGFONT
 * lfHeight > 0 = cell height (i3TextAttrDX2::CreateEx 0x10105b60), Arial cell = 1.117 em (ascent 1854 + descent 434 / 2048).
 * Glyph widths and the line advance are GDI's (guiFont).
 */
export const fontCell = (pt: number): number => Math.round((pt * 96) / 72);
const ARIAL_CELL_EM = (1854 + 434) / 2048;
const JUSTIFY = ["flex-start", "center", "flex-end"];
const TEXT_ALIGN = ["left", "center", "right"];

export class I3Gui {
  readonly byName = new Map<string, Built>();
  private readonly o: I3GuiOptions;

  constructor(o: I3GuiOptions) {
    ensureUiFont();
    this.o = o;
  }

  get(name: string): Built | undefined { return this.byName.get(name); }

  sprite(parent: HTMLElement, im: Img): HTMLElement {
    const [tex, dx0, dy0, u, v, sw, sh, dw, dh, flip = 0] = im;
    const dx = s32(dx0), dy = s32(dy0);
    const d = document.createElement("div");
    // a stretched piece is its source rect scaled by transform (a huge background-size for 1-3 px slices breaks browsers)
    const kx = dw / sw, ky = dh / sh, scaled = kx !== 1 || ky !== 1, file = this.o.atlas?.(tex) ?? tex, size = this.o.atlasSize;
    // a flipped piece is mirrored in place (i3Sprite2D::SetFlip): scale by -k and shift back by the drawn size
    const fx = flip & 1, fy = flip & 2;
    // no image-rendering: the D3D9 client samples its UI LINEAR (bilinear), so a stretched piece is smoothed too
    d.style.cssText = `position:absolute;left:${dx}px;top:${dy}px;width:${sw}px;height:${sh}px;pointer-events:none;`
      + `background:url(${this.o.base}/atlas/${file}.png) ${-u}px ${-v}px${size ? `/${size}px ${size}px` : ""} no-repeat;`
      + (scaled || flip ? `transform-origin:0 0;transform:translate(${fx ? dw : 0}px,${fy ? dh : 0}px) scale(${fx ? -kx : kx},${fy ? -ky : ky});` : "");
    parent.appendChild(d);
    return d;
  }

  /**
   * The pieces of one (relaid) picture. Under the Stage's fractional, per-axis scale an edge two pieces share falls inside a
   * screen pixel and both sides are antialiased there, so what is behind shows through a thin seam. Sealed here: at each
   * such edge the piece stretched across it (the earlier one if both are) grows SEAM px under the other one, so the growth
   * never shows and the picture keeps its size and look. The draw order (z inside the control, isolation) puts each grown
   * piece under the ones it grows into and keeps the file order wherever the pieces already overlap. Stacked pieces (state
   * pictures at 0,0, a scroll thumb on its track) and a picture with no edge to seal are drawn as before.
   */
  pieces(parent: HTMLElement, imgs: Img[]): HTMLElement[] {
    const n = imgs.length, R = imgs.map((i) => [s32(i[1]), s32(i[2]), i[7], i[8]]);
    const hit = (a: number[], b: number[]) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
    const grow = R.map(() => [0, 0, 0, 0]), took = R.map(() => [0, 0, 0, 0]); // SEAM px added / grown into: before x / y, after x / y
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (const p of [0, 1]) {
      const q = 1 - p, a = R[i], b = R[j]; // j starts where i ends along axis p, their spans on the other axis overlap
      if (i === j || a[p] + a[p + 2] !== b[p] || a[q] >= b[q] + b[q + 2] || b[q] >= a[q] + a[q + 2]) continue;
      const si = imgs[i][7 + p] !== imgs[i][5 + p], sj = imgs[j][7 + p] !== imgs[j][5 + p];
      // one growth per edge line: a piece that overlaps the edge by 1 px may already grow across it from the other side
      if (si && (!sj || i < j) && !grow[j][p] && !took[i][p + 2]) { grow[i][p + 2] = SEAM; took[j][p] = 1; }
      else if (sj && !grow[i][p + 2] && !took[j][p]) { grow[j][p] = SEAM; took[i][p + 2] = 1; }
    }
    // a growth must land under other pieces: one along a gap the file leaves open (a few px of an edge meet) is dropped
    grow.forEach((g, k) => g.forEach((on, s) => {
      if (!on) return;
      const [x, y, w, h] = R[k], p = s & 1, len = p ? w : h;
      let open = 0;
      for (let t = 0; t < len; t++) {
        const cx = p ? x + t : s === 0 ? x - 1 : x + w, cy = p ? (s === 1 ? y - 1 : y + h) : y + t;
        if (!R.some((r, m) => m !== k && cx >= r[0] && cx < r[0] + r[2] && cy >= r[1] && cy < r[1] + r[3])) open++;
      }
      if (open > 2) g[s] = 0;
    }));
    const G = R.map((r, k) => { const g = grow[k]; return [r[0] - g[0], r[1] - g[1], r[2] + g[0] + g[2], r[3] + g[1] + g[3]]; });
    // only a tiling is sealed (the designers' pieces may overlap by a few px)
    const stacked = R.some((a, k) => R.some((b, m) => m !== k && Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]) > 8
      && Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]) > 8));
    if (stacked || !grow.some((g) => g.some(Boolean))) return imgs.map((im) => this.sprite(parent, im));
    // k is drawn over m where m grew into k, and where they overlap in the file and m comes first. The two can disagree
    // (the designers' 1 px overlaps, two growths meeting at a corner): the next piece is then the one with the fewest
    // pieces still to draw under it, file overlaps counted only when the growths tie (a corner pixel loses, not an edge)
    const hard = R.map((a, k) => R.flatMap((b, m) => (m !== k && !hit(a, b) && hit(G[m], a) ? [m] : [])));
    const soft = R.map((a, k) => R.flatMap((b, m) => (m < k && hit(a, b) ? [m] : [])));
    const order: number[] = [], left = (l: number[]) => l.filter((m) => !order.includes(m)).length;
    while (order.length < n) {
      let k = -1, best = Infinity;
      for (let c = 0; c < n; c++) {
        const cost = order.includes(c) ? Infinity : left(hard[c]) * n + left(soft[c]);
        if (cost < best) { best = cost; k = c; }
      }
      order.push(k);
    }
    parent.style.isolation = "isolate";
    return imgs.map((im, k) => {
      const s = this.sprite(parent, [im[0], G[k][0], G[k][1], im[3], im[4], im[5], im[6], G[k][2], G[k][3], im[9]] as Img);
      s.style.zIndex = `${order.indexOf(k) - n}`;
      return s;
    });
  }

  /** builds `n` and its children under `parent` (ox / oy shift the top node only) */
  build(n: GNode, parent: HTMLElement, ox = 0, oy = 0): HTMLElement {
    const el = document.createElement("div");
    el.dataset.name = n.name;
    el.style.cssText = `position:absolute;left:${n.x + ox}px;top:${n.y + oy}px;width:${n.w}px;height:${n.h}px;`;
    const imgs = n.images ?? [];
    const built: Built = { el, node: n, states: [], shapes: [] };
    if (n.tpl === "Check" && imgs.length >= 5) {
      // checkbox: images 0..3 = the box (normal / over / ...), 4 = the tick (offset 1,2), shown while set. The 13-image copies
      // (chkObserver, CheckRandomMap, rr*TeamBalanceYes2) carry 8 stale entries before or after the box: the box is the first full
      // 13x13 cell, the tick the last image
      this.sprite(el, imgs.find((im) => im[5] === n.w && im[6] === n.h) ?? imgs[0]);
      built.tick = this.sprite(el, imgs[imgs.length - 1]);
      built.tick.style.display = "none";
    } else if (imgs.length && n.tpl !== "Null") {
      if (isPieces(imgs)) built.shapes = this.pieces(el, relayout(imgs, n.w, n.h));
      else for (const im of imgs) { const s = this.sprite(el, im); s.style.display = "none"; built.states.push(s); }
      if (built.states.length) { built.states[0].style.display = ""; built.shapes = built.states; }
    }
    // a name used twice (the files repeat separators / captions) maps to the last one built
    this.byName.set(n.name, built);
    const text = this.o.text?.(n);
    if (text !== undefined) this.text(el, n, text);
    parent.appendChild(el);
    for (const c of n.children ?? []) this.build(c, el);
    return el;
  }

  /**
   * The text node of a control, laid out like i3TextAttrDX2::_ArrangeText (i3SceneDx 0x101041d0): the rect is the
   * control's (EditBox CreateTextEx 0x10017a50 / caption _ReCalculateCaptionSize 0x10023040) moved by the offset, h 1 =
   * x + (W - textW) / 2, h 2 = x + W - textW, v 1 = y + (H - lines * lineH) / 2, v 2 = y + H - lines * lineH; auto wrap on
   * unless the exe turns it off. Engine defaults: EditBox left / top, white, 10 pt FW_NORMAL (ADDControlByGUI 0x10012b6f,
   * i3TextAttrDX2 ctor 0x101046e0); caption centre / middle (i3GuiControl ctor 0x10022f69).
   */
  text(el: HTMLElement, n: GNode, s: string): HTMLElement {
    const t = document.createElement("div");
    t.className = "op-text";
    const a = n.txt ?? {};
    // [INFERIDO] without `txt` (call not found in the exe): the caller's guess, vertically centred as before
    const caption = !n.txt && (this.o.caption?.(n) ?? false);
    const centred = this.o.centred ? this.o.centred(n) : n.cls === "Button" || caption || /(Value|Number)$/.test(n.name);
    const [h, v] = a.align ?? (n.txt && n.cls !== "EditBox" ? [1, 1] : n.txt ? [0, 0] : [centred ? 1 : 0, 1]);
    const f = nodeFont(n), [ox, oy] = a.offset ?? [0, 0], [sx, sy] = a.space ?? [0, 0];
    const color = a.color ?? (caption ? "#fff" : n.cls === "Button" ? "#e4e4e4" : n.txt ? "#ffffff" : "#c9ced6");
    // lines broken by the engine rule (arrangeText, GDI widths), drawn as they are: pre, no browser wrap, no clip
    t.style.cssText = `position:absolute;left:${Math.trunc(ox)}px;top:${Math.trunc(oy)}px;width:${n.w}px;height:${n.h}px;box-sizing:border-box;pointer-events:none;`
      + `display:flex;flex-direction:column;justify-content:${JUSTIFY[v] ?? "flex-start"};text-align:${TEXT_ALIGN[h] ?? "left"};`
      + `white-space:pre;line-height:${f.lineH + sy}px;letter-spacing:${sx}px;`
      + `font:${f.css};color:${color};text-shadow:${shadowCss(n)};`;
    el.appendChild(t);
    this.layoutText(t, n, s);
    return t;
  }

  private layoutText(t: HTMLElement, n: GNode, s: string): void {
    const laid = n.txt?.wrap === 0 ? s : arrangeText(s, n.w, nodeFont(n).w, n.txt?.space?.[0] ?? 0);
    Object.assign(t.dataset, { raw: s, laid });
    t.textContent = laid;
  }

  /** the control's text (created on first use) */
  setText(name: string, s: string): void {
    const b = this.byName.get(name);
    if (!b) return;
    const t = b.el.querySelector<HTMLElement>(":scope > .op-text");
    if (!t) { this.text(b.el, b.node, s); return; }
    // a caller may have added to the node (shop amount span): laid out again whenever it is not ours any more
    if (t.dataset.raw !== s || t.textContent !== t.dataset.laid) this.layoutText(t, b.node, s);
  }

  setColor(name: string, color: string): void {
    const t = this.byName.get(name)?.el.querySelector<HTMLElement>(":scope > .op-text");
    if (t) t.style.color = color;
  }

  /** 1 px outline of a text in `color` (name-card outline 1600205); null = no outline */
  setOutline(name: string, color: string | null): void {
    const t = this.byName.get(name)?.el.querySelector<HTMLElement>(":scope > .op-text");
    if (t) t.style.textShadow = color ? `-1px 0 ${color}, 1px 0 ${color}, 0 -1px ${color}, 0 1px ${color}` : "";
  }

  setState(name: string, i: number): void {
    const b = this.byName.get(name);
    if (!b?.states.length) return;
    b.states.forEach((s, k) => (s.style.display = k === Math.min(i, b.states.length - 1) ? "" : "none"));
  }

  /**
   * i3GuiControl::SetShapeUVIndex after SetUVPositioner(cell, texture size): the first sprite shows cell `index` of a grid
   * of `cell`-px cells (texture / cell per row), counted from the shape's own u / v.
   */
  setShapeUVIndex(name: string, index: number, cell: number, tex: number): void {
    const r = this.shapeUVRect(name, index, cell, tex), s = this.byName.get(name)?.states[0];
    if (!r || !s) return;
    s.style.backgroundPosition = `${-r.u}px ${-r.v}px`;
  }

  /** the atlas rect setShapeUVIndex shows for `index` (the control's own shape size), or null without a sprite */
  shapeUVRect(name: string, index: number, cell: number, tex: number): { tex: string; u: number; v: number; w: number; h: number } | null {
    const b = this.byName.get(name), im = b?.node.images?.[0];
    if (!im || !b?.states[0]) return null;
    const cols = Math.floor(tex / cell);
    return { tex: im[0], u: im[3] + (index % cols) * cell, v: im[4] + Math.floor(index / cols) * cell, w: im[5], h: im[6] };
  }

  /**
   * i3GuiControl::SetShapeEnable(index, on) / SetAllShapeEnable(on) (i3GuiDx): which of the control's sprites are drawn.
   * Multi-shape Statics (the Cross respawn weapon cards HudSlot / HudSelect) keep several pictures at one place and the exe
   * enables the one it wants.
   */
  setShapeEnable(name: string, i: number, on: boolean): void {
    const s = this.byName.get(name)?.shapes[i];
    if (s) s.style.display = on ? "" : "none";
  }

  setAllShapeEnable(name: string, on: boolean): void {
    for (const s of this.byName.get(name)?.shapes ?? []) s.style.display = on ? "" : "none";
  }

  hide(name: string): void {
    const b = this.byName.get(name);
    if (b) b.el.style.display = "none";
  }

  show(name: string, on = true): void {
    const b = this.byName.get(name);
    if (b) b.el.style.display = on ? "" : "none";
  }

  /** checkbox art: the box is always drawn, the tick (5th image) while set */
  paintCheck(name: string, on: boolean): void {
    const b = this.byName.get(name);
    if (b?.tick) b.tick.style.display = on ? "" : "none";
  }

  /** over sprite (state 1) while the pointer is on it, `base` otherwise; `live` = the control takes the pointer (default: not the disabled state 3) */
  hover(name: string, base: () => number = () => 0, live: () => boolean = () => base() !== 3): void {
    const b = this.byName.get(name);
    if (!b?.states.length) return;
    b.el.style.cursor = "pointer";
    b.el.addEventListener("pointerenter", () => { if (live()) this.setState(name, 1); });
    b.el.addEventListener("pointerleave", () => this.setState(name, base()));
  }

  /**
   * A button: over / pressed sprites, `fn` on click. `enabled` false = state `off` (3 = disabled sprite; the last one if
   * there are fewer), no hover / press / click. `off` 0 = input off only, the sprite stays the normal one (exe setInputDisable).
   * Returns a repaint for the enabled state (call it on every refresh).
   */
  button(name: string, fn: () => void, enabled: () => boolean = () => true, off = 3): () => void {
    const b = this.byName.get(name);
    if (!b) return () => {};
    const base = () => (enabled() ? 0 : off);
    this.hover(name, base, enabled);
    b.el.style.cursor = "pointer";
    b.el.addEventListener("pointerdown", () => { if (enabled() && b.states.length > 2) this.setState(name, 2); });
    b.el.addEventListener("pointerup", () => { if (enabled()) this.setState(name, 1); });
    b.el.addEventListener("click", (e) => { e.stopPropagation(); if (enabled()) fn(); });
    return () => { this.setState(name, base()); b.el.style.cursor = enabled() ? "pointer" : "default"; };
  }

  /** an edit box: a transparent <input> over the control's own Edit frame */
  edit(name: string, o: { maxLength?: number; password?: boolean; onInput?: (v: string) => void; onEnter?: (v: string) => void } = {}): HTMLInputElement | null {
    const b = this.byName.get(name);
    if (!b) return null;
    const input = document.createElement("input");
    input.type = o.password ? "password" : "text";
    if (o.maxLength) input.maxLength = o.maxLength;
    input.style.cssText = `position:absolute;left:3px;top:0;width:${b.node.w - 6}px;height:${b.node.h}px;box-sizing:border-box;padding:0;border:0;outline:0;background:transparent;`
      + `font:${nodeFont(b.node).css};color:${b.node.txt?.color ?? "#e4e4e4"};text-shadow:${shadowCss(b.node)};`;
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.code === "Enter" || e.code === "NumpadEnter") o.onEnter?.(input.value);
    });
    input.addEventListener("input", () => o.onInput?.(input.value));
    b.el.appendChild(input);
    return input;
  }

  /**
   * ListScroll template (5 pieces: 0 list area, 1 track, 2 thumb, 3 up arrow, 4 down arrow [INFERIDO from the atlas rects and
   * offsets: the arrows sit at the track's ends]): the thumb moves along the track for `top` of `total - visible`; arrows and
   * wheel step one row.
   */
  scrollList(name: string, onScroll: (delta: number) => void): (top: number, total: number, visible: number) => void {
    const b = this.byName.get(name);
    if (!b) return () => {};
    const pieces = Array.from(b.el.children).filter((c) => !(c as HTMLElement).classList.contains("op-text")) as HTMLElement[];
    const imgs = relayout(b.node.images ?? [], b.node.w, b.node.h);
    const thumb = pieces[2], up = pieces[3], down = pieces[4];
    b.el.addEventListener("wheel", (e) => { e.preventDefault(); onScroll(Math.sign(e.deltaY)); }, { passive: false });
    for (const [p, d] of [[up, -1], [down, 1]] as const) {
      if (!p) continue;
      p.style.pointerEvents = "auto";
      p.style.cursor = "pointer";
      p.addEventListener("click", (e) => { e.stopPropagation(); onScroll(d); });
    }
    const y0 = s32(imgs[3]?.[2] ?? 0) + (imgs[3]?.[8] ?? 0), y1 = s32(imgs[4]?.[2] ?? b.node.h) - (imgs[2]?.[8] ?? 0);
    // thumb drag: the row follows the pointer along the track (design px = screen px / the control's on-screen scale)
    let cur = 0, maxTop = 0;
    if (thumb) {
      thumb.style.pointerEvents = "auto";
      thumb.style.cursor = "pointer";
      thumb.addEventListener("pointerdown", (e) => {
        e.preventDefault(); e.stopPropagation();
        thumb.setPointerCapture(e.pointerId);
        const startY = e.clientY, startTop = cur, k = b.el.getBoundingClientRect().height / (b.node.h || 1);
        const move = (ev: PointerEvent) => {
          if (maxTop <= 0 || y1 <= y0) return;
          const want = Math.max(0, Math.min(maxTop, Math.round(startTop + ((ev.clientY - startY) / k / (y1 - y0)) * maxTop)));
          if (want !== cur) onScroll(want - cur);
        };
        const up = () => { thumb.removeEventListener("pointermove", move); thumb.removeEventListener("pointerup", up); thumb.removeEventListener("pointercancel", up); };
        thumb.addEventListener("pointermove", move);
        thumb.addEventListener("pointerup", up);
        thumb.addEventListener("pointercancel", up);
      });
    }
    return (top, total, visible) => {
      if (!thumb) return;
      const max = Math.max(0, total - visible);
      cur = top; maxTop = max;
      thumb.style.display = max > 0 ? "" : "none";
      thumb.style.top = `${max > 0 ? y0 + (y1 - y0) * (top / max) : y0}px`;
    };
  }
}
