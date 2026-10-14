// Clan mark (emblema do clã) logo: one uint32 on the wire and in system_clan.logo.
// Layout from PointBlank.exe Cross (Clients/PBCross), CPopupClanCreate::_CreateClanMarkOverlappingCheck at 0x89b0e9:
//   bits 31..24 = m_nClanMarkBackColorIdx  (+0x1a4)
//   bits 23..16 = m_nClanMarkBackImageIdx  (+0x1a8)
//   bits 15..8  = m_nClanMarkShapeImageIdx (+0x1ac)
//   bits 7..0   = m_nClanMarkShapeColorIdx (+0x1b0)
// 0xFFFFFFFF = no clan mark (CLAN_MARK_DEFAULT, Cross Lua defines).
//
// Counts (exe + ConfigEx.pef, Brazil slot): back image 27 cells, shape image 81 cells, colour 10 (+ index 0 = white).
//   GetMarkBackImageCount 0x4f0140 ([singleton+0] = CustomClanMarkFrameCount), GetMarkShapeImageCount 0x4f0120
//   ([singleton+4] = CustomClanMarkContentCount), GetMarkColorCount 0x4f0160 (const 10).
// [INFERIDO] image index rule: 0 = no image; k >= 1 = cell k-1 (MakeClanMarkTex asserts 'idx > 0', and 81 values = 81 cells + 0).
//   Shape cells: page = floor((k-1)/81), cell = (k-1)%81; pages 0..2 = Filled_01..03 (page 2 holds 19 cells, nations with 181).
//   Back cells: cell = k-1 in the 9x3 frame sheet.
// Colours: user table (GetUserColorTable 0x4edad0, VA 0xb2cc20) = popup swatches; layer tables (GetLayerColorTable 0x4edb90,
//   layer 0 VA 0xb2cc4c = shape, layer 1 VA 0xb2cc78 = back). The marks are tinted with the user table, so the mark has the
//   swatch colour the player picked [INFERIDO] (the exe draw path 0x4ef894 reads both; the layer tables gave a different colour
//   than the swatch). Outline textures use index 0 (white = untinted) [INFERIDO].
// Atlas: public/assets/ui/clanmark/ (pb-extract-tools export-clanmark.mjs), sheet layout in clanmark.json.
export const CLAN_MARK_DEFAULT = 0xffffffff;

export interface ClanMarkParts { backColor: number; backImage: number; shapeImage: number; shapeColor: number }

export const CLAN_MARK_BACK_IMAGE_COUNT = 27;
export const CLAN_MARK_SHAPE_IMAGE_COUNT = 81;
export const CLAN_MARK_SHAPE_PAGES = 3;
export const CLAN_MARK_COLOR_COUNT = 10;
// pitch = cell step in the sheet (px): 53 in the 512 sheets, 26 in the 256 sheets (measured, export-clanmark.mjs)
export const CLAN_MARK_GRID = { cols: 9, backRows: 3, shapeRows: 9, pitch: { m: 53, s: 26 } } as const;

export type RGBA = readonly [number, number, number, number];

/** GetUserColorTable, idx 0..10 (exe 0xb2cc20). idx 0 = white. Popup swatches. */
export const CLAN_MARK_USER_COLORS: readonly RGBA[] = [
  [255, 255, 255, 255], [121, 23, 0, 255], [227, 96, 0, 255], [255, 211, 3, 255], [196, 213, 0, 255], [128, 217, 0, 255],
  [32, 171, 0, 255], [3, 181, 255, 255], [0, 96, 227, 255], [0, 35, 107, 255], [115, 37, 117, 255],
];
/** GetLayerColorTable layer 0 = shape tint, idx 0..10 (exe 0xb2cc4c) */
export const CLAN_MARK_SHAPE_COLORS: readonly RGBA[] = [
  [255, 255, 255, 255], [238, 190, 0, 255], [255, 180, 0, 255], [255, 126, 0, 255], [0, 115, 66, 255], [0, 67, 158, 255],
  [255, 204, 0, 255], [0, 67, 158, 255], [77, 232, 255, 255], [238, 190, 0, 255], [248, 138, 255, 255],
];
/** GetLayerColorTable layer 1 = back tint, idx 0..10 (exe 0xb2cc78) */
export const CLAN_MARK_BACK_COLORS: readonly RGBA[] = [
  [255, 255, 255, 255], [255, 190, 45, 255], [255, 210, 0, 255], [95, 0, 0, 255], [75, 85, 0, 255], [0, 67, 158, 255],
  [0, 70, 40, 255], [0, 45, 85, 255], [80, 190, 255, 255], [240, 255, 5, 255], [0, 195, 205, 255],
];

/** decimal lists for the popup pickers (index 0 = none for images; colour 0 = white) */
export const clanMarkBackImageList = (): number[] => Array.from({ length: CLAN_MARK_BACK_IMAGE_COUNT }, (_, i) => i + 1);
export const clanMarkShapeImageList = (): number[] => Array.from({ length: CLAN_MARK_SHAPE_IMAGE_COUNT }, (_, i) => i + 1);
export const clanMarkColorList = (): { index: number; rgba: RGBA }[] =>
  Array.from({ length: CLAN_MARK_COLOR_COUNT }, (_, i) => ({ index: i + 1, rgba: CLAN_MARK_USER_COLORS[i + 1] }));

/** pack the four indices into the logo uint32 (same shifts as the exe) */
export function encodeClanMark(p: ClanMarkParts): number {
  return (((p.backColor & 0xff) << 24) | ((p.backImage & 0xff) << 16) | ((p.shapeImage & 0xff) << 8) | (p.shapeColor & 0xff)) >>> 0;
}

/** unpack a logo; null when the logo is CLAN_MARK_DEFAULT (no mark to draw) */
export function decodeClanMark(logo: number): ClanMarkParts | null {
  const v = logo >>> 0;
  if (v === CLAN_MARK_DEFAULT) return null;
  return { backColor: v >>> 24, backImage: (v >>> 16) & 0xff, shapeImage: (v >>> 8) & 0xff, shapeColor: v & 0xff };
}

// ---- rendering -------------------------------------------------------------------------------------------------
/** decoded atlas sheet, RGBA8 */
export interface ClanMarkSheet { w: number; h: number; rgba: Uint8Array | Uint8ClampedArray }
/** 'm' = 512 px sheets (big mark), 's' = 256 px sheets (list/small mark) */
export interface ClanMarkSourceAtlas { frameFill: ClanMarkSheet; frameOutline: ClanMarkSheet; shapeFill: ClanMarkSheet[]; shapeOutline: ClanMarkSheet[] }
export type ClanMarkAtlas = { m: ClanMarkSourceAtlas; s: ClanMarkSourceAtlas };

/** top-left of cell  (0-based, row-major) in a sheet */
function cellOrigin(cell: number, pitch: number, cols: number): [number, number] {
  return [(cell % cols) * pitch, Math.floor(cell / cols) * pitch];
}

/**
 * One cell of a sheet, resampled (bilinear) into the S x S output, tinted multiplicatively and drawn over `out` (straight alpha).
 * Sampling stays inside the cell's pitch window, so a neighbour cell never bleeds in. Colour is weighted by alpha, so the
 * transparent texels do not darken the edge.
 */
function blendLayer(out: Uint8ClampedArray, S: number, sheet: ClanMarkSheet, ox: number, oy: number, pitch: number, tint: RGBA): void {
  const scale = pitch / S;
  const x1 = Math.min(sheet.w - 1, ox + pitch - 1), y1 = Math.min(sheet.h - 1, oy + pitch - 1);
  for (let y = 0; y < S; y++) {
    const py = oy + Math.min(pitch - 1, Math.max(0, (y + 0.5) * scale - 0.5));
    const iy = Math.floor(py), ty = py - iy, iy1 = Math.min(iy + 1, y1);
    for (let x = 0; x < S; x++) {
      const px = ox + Math.min(pitch - 1, Math.max(0, (x + 0.5) * scale - 0.5));
      const ix = Math.floor(px), tx = px - ix, ix1 = Math.min(ix + 1, x1);
      // the four texels: weight, and their index in the sheet
      const wt = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
      const ti = [iy * sheet.w + ix, iy * sheet.w + ix1, iy1 * sheet.w + ix, iy1 * sheet.w + ix1];
      let a = 0, r = 0, g = 0, b = 0; // a = sum of weight * alpha (0..255)
      for (let k = 0; k < 4; k++) {
        const si = ti[k] * 4, wa = wt[k] * sheet.rgba[si + 3];
        a += wa; r += wa * sheet.rgba[si]; g += wa * sheet.rgba[si + 1]; b += wa * sheet.rgba[si + 2];
      }
      if (a <= 0) continue;
      const sa = (a / 255) * (tint[3] / 255); // 0..1, same unit as da below
      if (sa <= 0) continue;
      const colour = [r / a, g / a, b / a];
      const di = (y * S + x) * 4;
      const da = out[di + 3] / 255;
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        const s = (colour[c] * tint[c]) / 255;
        out[di + c] = oa > 0 ? Math.round((s * sa + out[di + c] * da * (1 - sa)) / oa) : 0;
      }
      out[di + 3] = Math.round(oa * 255);
    }
  }
}

/**
 * Compose a clan mark at `size` px into RGBA8 (row-major, S x S). Back layer first (fill, outline), then shape.
 * Returns null for CLAN_MARK_DEFAULT (no mark). Index ranges are clamped to the counts, out-of-range = no image.
 * Sheet by drawn size [RECRIADO]: 's' (26 px cells) up to 32 px, else 'm' (53 px cells), so a cell is never blown up past its art.
 */
export function composeClanMark(logo: number, size: number, atlas: ClanMarkAtlas, source: 'm' | 's' = size > 32 ? 'm' : 's'): Uint8ClampedArray<ArrayBuffer> | null {
  const p = decodeClanMark(logo);
  if (!p) return null;
  const S = Math.max(1, Math.round(size));
  const out: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(new ArrayBuffer(S * S * 4));
  const src = atlas[source];
  const pitch = CLAN_MARK_GRID.pitch[source];
  const cols = CLAN_MARK_GRID.cols;
  // the colour index is the swatch the player picked (user table): the layer tables give another colour per index
  // (index 3: swatch yellow, back layer dark red), so the mark would not show the picked colour [INFERIDO]
  const back = CLAN_MARK_USER_COLORS[Math.min(p.backColor, CLAN_MARK_COLOR_COUNT)];
  const shape = CLAN_MARK_USER_COLORS[Math.min(p.shapeColor, CLAN_MARK_COLOR_COUNT)];
  const white = CLAN_MARK_USER_COLORS[0];
  if (p.backImage >= 1 && p.backImage <= CLAN_MARK_BACK_IMAGE_COUNT) {
    const [ox, oy] = cellOrigin(p.backImage - 1, pitch, cols);
    blendLayer(out, S, src.frameFill, ox, oy, pitch, back);
    blendLayer(out, S, src.frameOutline, ox, oy, pitch, white);
  }
  if (p.shapeImage >= 1 && p.shapeImage <= CLAN_MARK_SHAPE_IMAGE_COUNT) {
    const k = p.shapeImage - 1, page = Math.floor(k / 81), cell = k % 81;
    const [ox, oy] = cellOrigin(cell, pitch, cols);
    const fill = src.shapeFill[page], outline = src.shapeOutline[page];
    if (fill) blendLayer(out, S, fill, ox, oy, pitch, shape);
    if (outline) blendLayer(out, S, outline, ox, oy, pitch, white);
  }
  return out;
}

/** draw a clan mark on a 2D context at (x, y); returns false when the logo has no mark */
export function drawClanMark(ctx: CanvasRenderingContext2D, logo: number, x: number, y: number, size: number, atlas: ClanMarkAtlas): boolean {
  // composed from the big sheet at its own cell size (or more), then scaled down by the canvas with high-quality
  // smoothing: a small mark composed straight from the 26 px sheet came out blocky
  const S = Math.round(size);
  const C = Math.max(S, Math.ceil(CLAN_MARK_GRID.pitch.m));
  const px = composeClanMark(logo, C, atlas, 'm');
  if (!px) return false;
  const tmp = document.createElement('canvas');
  tmp.width = C;
  tmp.height = C;
  const tctx = tmp.getContext('2d');
  if (!tctx) return false;
  tctx.putImageData(new ImageData(px, C, C), 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tmp, x, y, S, S);
  return true;
}

/** browser loader: fetches the exporter's PNGs under `base` (e.g. '/assets/ui/clanmark/') and decodes them to RGBA */
export async function loadClanMarkAtlas(base: string): Promise<ClanMarkAtlas> {
  const load = (name: string): Promise<ClanMarkSheet> => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d');
      if (!g) return reject(new Error('2d context'));
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height);
      resolve({ w: c.width, h: c.height, rgba: d.data });
    };
    img.onerror = () => reject(new Error(`clan mark sheet ${name}`));
    img.src = base + name;
  });
  const one = async (kind: 'm' | 's'): Promise<ClanMarkSourceAtlas> => ({
    frameFill: await load(`frame_${kind}_fill.png`),
    frameOutline: await load(`frame_${kind}_outline.png`),
    shapeFill: await Promise.all([0, 1, 2].map((p) => load(`shape_${kind}_fill_${p}.png`))),
    shapeOutline: await Promise.all([0, 1, 2].map((p) => load(`shape_${kind}_outline_${p}.png`))),
  });
  return { m: await one('m'), s: await one('s') };
}
