// i3TextNodeDX2 text boxes of the Cross HUD, shared by the DOM panels and the PNG check (dev/cross-hud.node.ts). No DOM here.
// Every HUD text of the Cross exe is a text node made by i3TextNodeDX2::Create(face, bufLen, size, weight, ...) then setPos /
// setSize / SetAlign / SetColor. Faces: "Gunplay" (Font/Gunplay.ttf) for the numbers, the default font (0x4ada40 = "Arial") for
// the rest (FONTS in lobby/ui/assets.ts).
//  - size: i3TextAttrDX2::CreateEx sets lfHeight = FontPointToPixel(size) = MulDiv(size, 96, 72), positive = the GDI cell height
//    (ascent + descent), so the em is cell * unitsPerEm / (winAscent + winDescent) of the face.
//  - SetAlign(x, y) (Cross i3SceneDx.dll 0x101040a0 stores +0x60 / +0x64; _ArrangeText 0x101041d0 reads them): x 1 = centre
//    (left + (w >> 1) - (textW >> 1)), 2 = right (left + w - textW), else left; y 1 = middle (top + (h >> 1) - (lines * lineH >> 1)),
//    2 = bottom, else top. The constructor (0x101046e0) leaves both 0: a node with no SetAlign call is left / top.

export type I3Face = "Arial" | "Gunplay";
export type RGB = [number, number, number];

export interface I3Text {
  text: string;
  /** setPos / setSize box, window px */
  x: number; y: number; w: number; h: number;
  face: I3Face;
  /** the Create size (points) */
  size: number;
  /** FW_* weight of the Create call (400 normal, 700 bold) */
  weight?: number;
  color: RGB;
  /** SetAlign: 0 left / top, 1 centre / middle, 2 right / bottom */
  ax?: 0 | 1 | 2; ay?: 0 | 1 | 2;
}

/** hhea / OS/2 win metrics of the two faces (Gunplay.ttf of the client, Windows arial.ttf) */
export const FACE_METRICS: Record<I3Face, { upm: number; asc: number; desc: number }> = {
  Arial: { upm: 2048, asc: 1854, desc: 434 },
  Gunplay: { upm: 2048, asc: 1794, desc: 682 },
};

/** i3Gfx::FontPointToPixel at 96 dpi: MulDiv(size, 96, 72) */
export const cellPx = (size: number): number => Math.round((size * 96) / 72);
/** CSS font-size (em px) whose ascent + descent equals the GDI cell */
export function emPx(face: I3Face, size: number): number {
  const m = FACE_METRICS[face];
  return (cellPx(size) * m.upm) / (m.asc + m.desc);
}

/** top-left of the (single line) text and its baseline, for a text `textW` px wide: _ArrangeText 0x101041d0 */
export function textOrigin(t: I3Text, textW: number): { x: number; top: number; baseline: number; em: number; cell: number } {
  const cell = cellPx(t.size), em = emPx(t.face, t.size), m = FACE_METRICS[t.face];
  const tw = Math.trunc(textW);
  const x = t.ax === 1 ? t.x + (t.w >> 1) - (tw >> 1) : t.ax === 2 ? t.x + t.w - tw : t.x;
  const top = t.ay === 1 ? t.y + (t.h >> 1) - (cell >> 1) : t.ay === 2 ? t.y + t.h - cell : t.y;
  return { x, top, baseline: top + (m.asc * em) / m.upm, em, cell };
}

/** CSS of a text node box: the browser lays the line out with the same em / cell and the same alignment */
export function textCss(t: I3Text, family: string): string {
  const cell = cellPx(t.size), em = emPx(t.face, t.size);
  const jx = t.ax === 1 ? "center" : t.ax === 2 ? "flex-end" : "flex-start";
  const jy = t.ay === 1 ? "center" : t.ay === 2 ? "flex-end" : "flex-start";
  return `position:absolute;left:${t.x}px;top:${t.y}px;width:${t.w}px;height:${t.h}px;display:flex;justify-content:${jx};align-items:${jy};`
    + `white-space:pre;overflow:visible;font:${t.weight ?? 400} ${em.toFixed(2)}px/${cell}px ${family};color:rgb(${t.color.join(",")})`;
}
