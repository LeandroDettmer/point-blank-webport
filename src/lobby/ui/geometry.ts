// Template -> sprite pieces, without DOM. Shared by Skin.ts (browser) and pb-extract-tools ui-export/ui-compose.mjs
// (Node, type stripping), so the PNG check and the page draw the same thing.
//
// What is original vs inferred:
//  - shape rectangles (nX/nY/nWidth/nHeight) and source rects (u/v/w/h) come from the template XML;
//  - the grouping of shapes into states ("a new group starts at nX=nY=0") and the stretch rule
//    (1 shape = fill, 3 = 3-slice, 9 = 9-slice, corners keep their nWidth/nHeight) are read off the data
//    (Bt3_01 = 4 states x 3, FrameWnd = 9 + 1, LVItem = 4 x 1) but the engine code was not decompiled;
//  - state order normal/hover/pressed/disabled is the i3UI convention and is [INFERIDO].
import type { Shape, Template } from "./format.ts";

export const frameKey = (s: Shape): string => `${s.img}:${s.u},${s.v},${s.uw},${s.vh}`;

/** A sprite to draw: `shape`'s source rect stretched into (x, y, w, h), relative to the control. */
export interface Piece { shape: Shape; x: number; y: number; w: number; h: number }

/** Shapes grouped per state. */
export function shapeGroups(t: Template): Shape[][] {
  const groups: Shape[][] = [];
  for (const s of t.shapes) {
    const g = groups[groups.length - 1];
    if (!g || (s.x === 0 && s.y === 0)) groups.push([s]);
    else g.push(s);
  }
  // FrameWnd / LVBox: 9-slice + trailing extra shapes (the 10th repeats the centre) -> keep one 9-group
  if (groups.length === 1 && groups[0].length > 9) groups[0] = groups[0].slice(0, 9);
  return groups;
}

/** Layout one state group into a w x h control box. */
export function layoutGroup(g: Shape[], w: number, h: number): Piece[] {
  if (g.length === 1) return [{ shape: g[0], x: 0, y: 0, w, h }];
  if (g.length === 3) {
    const horizontal = g[0].y === g[1].y && g[1].y === g[2].y;
    if (horizontal) {
      const l = Math.min(g[0].w, w / 2), r = Math.min(g[2].w, w - l);
      return [
        { shape: g[0], x: 0, y: 0, w: l, h },
        { shape: g[1], x: l, y: 0, w: Math.max(0, w - l - r), h },
        { shape: g[2], x: w - r, y: 0, w: r, h },
      ];
    }
    const t = Math.min(g[0].h, h / 2), b = Math.min(g[2].h, h - t);
    return [
      { shape: g[0], x: 0, y: 0, w, h: t },
      { shape: g[1], x: 0, y: t, w, h: Math.max(0, h - t - b) },
      { shape: g[2], x: 0, y: h - b, w, h: b },
    ];
  }
  if (g.length === 9) {
    const l = Math.min(g[0].w, w / 2), r = Math.min(g[2].w, w - l);
    const t = Math.min(g[0].h, h / 2), b = Math.min(g[6].h, h - t);
    const xs = [0, l, w - r], ws = [l, Math.max(0, w - l - r), r];
    const ys = [0, t, h - b], hs = [t, Math.max(0, h - t - b), b];
    return g.map((shape, i) => ({ shape, x: xs[i % 3], y: ys[Math.floor(i / 3)], w: ws[i % 3], h: hs[Math.floor(i / 3)] }));
  }
  // anything else: scale the reference box to the control
  const rw = Math.max(1, ...g.map(s => s.x + s.w)), rh = Math.max(1, ...g.map(s => s.y + s.h));
  return g.map(shape => ({ shape, x: shape.x * w / rw, y: shape.y * h / rh, w: shape.w * w / rw, h: shape.h * h / rh }));
}

/** Pieces for a control in a given state (0 = normal). Scroll bars draw track + prev/next buttons. */
export function layoutTemplate(t: Template, w: number, h: number, state = 0): Piece[] {
  const groups = shapeGroups(t);
  const g = groups[Math.min(state, groups.length - 1)];
  // Radio: 6 state dots (17x17 sources) + a trailing "selectimage" glow. The generic layout stretched the dot over the whole
  // control (a wide ellipse): the dot keeps its source size at the left, vertically centred, and the glow is not drawn
  // (the screens mark the selection themselves) [INFERIDO]
  if (t.cls === "Radio" && g?.length) {
    const s = g[0], dw = Math.min(s.uw, w), dh = Math.min(s.vh, h);
    return [{ shape: s, x: 0, y: (h - dh) / 2, w: dw, h: dh }];
  }
  const out = g ? layoutGroup(g, w, h) : [];
  if ((t.cls === "VScrollBar" || t.cls === "HScrollBar") && t.sub) {
    const v = t.cls === "VScrollBar";
    const btn = (st: Template | null | undefined, atEnd: boolean) => {
      const s = st && shapeGroups(st)[0]?.[0];
      if (!s) return;
      const bw = v ? w : Math.min(s.w, w / 2), bh = v ? Math.min(s.h, h / 2) : h;
      out.push({ shape: s, x: v ? 0 : atEnd ? w - bw : 0, y: v ? (atEnd ? h - bh : 0) : 0, w: bw, h: bh });
    };
    btn(t.sub[0], false);
    btn(t.sub[1], true);
    // sub[2] = thumb: its length depends on the list content -> drawn by the runtime, not here
  }
  return out;
}
