// Minimal TrueType (glyf) rasteriser for the PNG checks of the meta screens: cmap 4, simple and
// composite glyphs, quadratic outlines flattened, non-zero winding with 4x4 supersampling. No hinting, no kerning.
// Only for validation images (game/pbHud/dev/cross-hud.node.ts); the page uses the browser's text engine with the same font.
import fs from "node:fs";

export function loadFont(file) {
  const b = fs.readFileSync(file);
  const tables = {};
  const n = b.readUInt16BE(4);
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    tables[b.toString("latin1", o, o + 4)] = { off: b.readUInt32BE(o + 8), len: b.readUInt32BE(o + 12) };
  }
  const head = tables.head.off;
  const unitsPerEm = b.readUInt16BE(head + 18);
  const locFmt = b.readInt16BE(head + 50);
  const numGlyphs = b.readUInt16BE(tables.maxp.off + 4);
  const hhea = tables.hhea.off;
  const ascender = b.readInt16BE(hhea + 4), descender = b.readInt16BE(hhea + 6);
  const nHM = b.readUInt16BE(hhea + 34);
  const hmtx = tables.hmtx.off;
  const advance = (g) => b.readUInt16BE(hmtx + 4 * Math.min(g, nHM - 1));
  const loca = (g) => (locFmt ? b.readUInt32BE(tables.loca.off + g * 4) : b.readUInt16BE(tables.loca.off + g * 2) * 2);
  // cmap format 4 (platform 3, encoding 1)
  const cm = tables.cmap.off;
  let sub = 0;
  for (let i = 0, nt = b.readUInt16BE(cm + 2); i < nt; i++) {
    const pid = b.readUInt16BE(cm + 4 + i * 8), eid = b.readUInt16BE(cm + 6 + i * 8);
    if (pid === 3 && eid === 1) sub = cm + b.readUInt32BE(cm + 8 + i * 8);
  }
  const segX2 = b.readUInt16BE(sub + 6);
  const ends = sub + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
  const glyphOf = (code) => {
    for (let i = 0; i < segX2 / 2; i++) {
      const end = b.readUInt16BE(ends + i * 2);
      if (code > end) continue;
      const start = b.readUInt16BE(starts + i * 2);
      if (code < start) return 0;
      const delta = b.readInt16BE(deltas + i * 2), ro = b.readUInt16BE(ranges + i * 2);
      if (!ro) return (code + delta) & 0xffff;
      const g = b.readUInt16BE(ranges + i * 2 + ro + (code - start) * 2);
      return g ? (g + delta) & 0xffff : 0;
    }
    return 0;
  };
  const cache = new Map();
  // contours: array of [x, y, onCurve][]
  function outline(g, depth = 0) {
    if (cache.has(g)) return cache.get(g);
    const o = tables.glyf.off + loca(g), next = tables.glyf.off + loca(g + 1);
    let res = [];
    if (next > o && depth < 8) {
      const nc = b.readInt16BE(o);
      if (nc >= 0) {
        const endPts = [];
        for (let i = 0; i < nc; i++) endPts.push(b.readUInt16BE(o + 10 + i * 2));
        const np = nc ? endPts[nc - 1] + 1 : 0;
        let p = o + 10 + nc * 2;
        p += 2 + b.readUInt16BE(p);
        const flags = [];
        while (flags.length < np) {
          const f = b[p++];
          flags.push(f);
          if (f & 8) { let r = b[p++]; while (r--) flags.push(f); }
        }
        const xs = [], ys = [];
        let v = 0;
        for (const f of flags) { if (f & 2) { const d = b[p++]; v += f & 16 ? d : -d; } else if (!(f & 16)) { v += b.readInt16BE(p); p += 2; } xs.push(v); }
        v = 0;
        for (const f of flags) { if (f & 4) { const d = b[p++]; v += f & 32 ? d : -d; } else if (!(f & 32)) { v += b.readInt16BE(p); p += 2; } ys.push(v); }
        let s = 0;
        for (const e of endPts) { const c = []; for (let i = s; i <= e; i++) c.push([xs[i], ys[i], flags[i] & 1]); res.push(c); s = e + 1; }
      } else {
        let p = o + 10, more = true;
        while (more) {
          const fl = b.readUInt16BE(p), gi = b.readUInt16BE(p + 2);
          p += 4;
          let dx, dy;
          if (fl & 1) { dx = b.readInt16BE(p); dy = b.readInt16BE(p + 2); p += 4; } else { dx = b.readInt8(p); dy = b.readInt8(p + 1); p += 2; }
          let a = 1, bb = 0, c = 0, d = 1;
          if (fl & 8) { a = d = b.readInt16BE(p) / 16384; p += 2; }
          else if (fl & 0x40) { a = b.readInt16BE(p) / 16384; d = b.readInt16BE(p + 2) / 16384; p += 4; }
          else if (fl & 0x80) { a = b.readInt16BE(p) / 16384; bb = b.readInt16BE(p + 2) / 16384; c = b.readInt16BE(p + 4) / 16384; d = b.readInt16BE(p + 6) / 16384; p += 8; }
          if (!(fl & 2)) { dx = 0; dy = 0; } // point matching not supported
          for (const cont of outline(gi, depth + 1)) res.push(cont.map(([x, y, on]) => [x * a + y * c + dx, x * bb + y * d + dy, on]));
          more = !!(fl & 0x20);
        }
      }
    }
    cache.set(g, res);
    return res;
  }
  return { unitsPerEm, ascender, descender, glyphOf, advance, outline };
}

// quadratic contour -> polyline in font units
function flatten(cont) {
  const pts = [];
  const n = cont.length;
  if (!n) return pts;
  let start = cont.findIndex((p) => p[2]);
  let first;
  if (start < 0) { first = [(cont[0][0] + cont[1 % n][0]) / 2, (cont[0][1] + cont[1 % n][1]) / 2]; start = 0; }
  else first = [cont[start][0], cont[start][1]];
  pts.push(first);
  let prev = first, ctrl = null;
  for (let k = 1; k <= n; k++) {
    const q = cont[(start + k) % n];
    const cur = [q[0], q[1]];
    if (q[2]) {
      if (ctrl) quad(pts, prev, ctrl, cur); else pts.push(cur);
      prev = cur; ctrl = null;
    } else if (ctrl) {
      const mid = [(ctrl[0] + cur[0]) / 2, (ctrl[1] + cur[1]) / 2];
      quad(pts, prev, ctrl, mid);
      prev = mid; ctrl = cur;
    } else ctrl = cur;
  }
  if (ctrl) quad(pts, prev, ctrl, first);
  return pts;
}
function quad(out, a, c, b) {
  for (let i = 1; i <= 4; i++) {
    const t = i / 4, u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
  }
}

export function measure(font, text, px) {
  const s = px / font.unitsPerEm;
  let w = 0;
  for (const ch of text) w += font.advance(font.glyphOf(ch.codePointAt(0))) * s;
  return w;
}

/** Draws `text` with its baseline at (x, baseY) into an RGBA buffer via blend(x, y, alpha). */
export function drawText(font, text, px, x, baseY, blend) {
  const s = px / font.unitsPerEm, SS = 4;
  let pen = x;
  for (const ch of text) {
    const g = font.glyphOf(ch.codePointAt(0));
    const polys = font.outline(g).map(flatten).map((pl) => pl.map(([gx, gy]) => [pen + gx * s, baseY - gy * s]));
    pen += font.advance(g) * s;
    if (!polys.length) continue;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const pl of polys) for (const [px_, py] of pl) { minX = Math.min(minX, px_); maxX = Math.max(maxX, px_); minY = Math.min(minY, py); maxY = Math.max(maxY, py); }
    const X0 = Math.floor(minX), X1 = Math.ceil(maxX), Y0 = Math.floor(minY), Y1 = Math.ceil(maxY);
    const W = X1 - X0 + 1;
    const cov = new Float32Array(W);
    for (let y = Y0; y <= Y1; y++) {
      cov.fill(0);
      for (let sy = 0; sy < SS; sy++) {
        const yy = y + (sy + 0.5) / SS;
        const xs = [];
        for (const pl of polys) for (let i = 0; i < pl.length; i++) {
          const [ax, ay] = pl[i], [bx, by] = pl[(i + 1) % pl.length];
          if (ay === by || yy < Math.min(ay, by) || yy >= Math.max(ay, by)) continue;
          xs.push([ax + ((yy - ay) * (bx - ax)) / (by - ay), by > ay ? 1 : -1]);
        }
        xs.sort((p, q) => p[0] - q[0]);
        let wind = 0;
        for (let i = 0; i < xs.length - 1; i++) {
          wind += xs[i][1];
          if (!wind) continue;
          const a = xs[i][0] - X0, bq = xs[i + 1][0] - X0;
          for (let sx = 0; sx < W * SS; sx++) { const cx = (sx + 0.5) / SS; if (cx >= a && cx < bq) cov[sx / SS | 0] += 1 / (SS * SS); }
        }
      }
      for (let i = 0; i < W; i++) if (cov[i] > 0) blend(X0 + i, y, Math.min(1, cov[i]));
    }
  }
  return pen - x;
}
