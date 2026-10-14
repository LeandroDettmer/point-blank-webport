#!/usr/bin/env node
// Smoke for tex/*.dds written by export-map-dds.mjs: container, dimensions == the PNG, mip chain sizes, S3TC level rule,
// alpha flag == PNG alpha, and mip layout (mean colour of level 1 ~ mean colour of level 0).
//   node scripts/dev/test-map-dds.mjs [N maps (default 12)]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'assets', 'maps');
const BLOCK = { DXT1: 8, DXT3: 16, DXT5: 16 };

function meanColour(dds, level, sizes, w, h, kind) {
  let off = 128; for (let m = 0; m < level; m++) off += sizes[m];
  const lw = Math.max(1, w >> level), lh = Math.max(1, h >> level), n = Math.ceil(lw / 4) * Math.ceil(lh / 4), bsz = BLOCK[kind];
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < n; i++) {
    const o = off + i * bsz + (kind === 'DXT1' ? 0 : 8);
    const c0 = dds.readUInt16LE(o), c1 = dds.readUInt16LE(o + 2), idx = dds.readUInt32LE(o + 4);
    const p = (c) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
    const a = p(c0), z = p(c1);
    const pal = [a, z, c0 > c1 || kind !== 'DXT1' ? a.map((v, k) => (2 * v + z[k]) / 3) : a.map((v, k) => (v + z[k]) / 2),
      c0 > c1 || kind !== 'DXT1' ? a.map((v, k) => (v + 2 * z[k]) / 3) : [0, 0, 0]];
    for (let k = 0; k < 16; k++) { const c = pal[(idx >>> (2 * k)) & 3]; r += c[0]; g += c[1]; b += c[2]; }
  }
  return [r, g, b].map((v) => v / (n * 16));
}

const all = fs.readdirSync(ROOT).filter((d) => fs.existsSync(path.join(ROOT, d, 'tex')) && fs.readdirSync(path.join(ROOT, d, 'tex')).some((f) => f.endsWith('.dds')));
const want = Math.max(1, +process.argv[2] || 12);
const maps = all.filter((_, i) => i % Math.max(1, Math.floor(all.length / want)) === 0).slice(0, want);
let n = 0, fail = 0, bytes = 0;
const bad = (m) => { fail++; console.log('FAIL', m); };
if (!all.length) { console.log('no .dds found: run scripts/dev/export-map-dds.mjs first'); process.exit(1); }
for (const map of maps) {
  const dir = path.join(ROOT, map, 'tex');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.dds'));
  files.forEach((f, fi) => {
    const dds = fs.readFileSync(path.join(dir, f)); bytes += dds.length; n++;
    const id = `${map}/${f}`;
    if (dds.toString('latin1', 0, 4) !== 'DDS ' || dds.readUInt32LE(4) !== 124) return bad(id + ' header');
    const h = dds.readUInt32LE(12), w = dds.readUInt32LE(16), mips = dds.readUInt32LE(28), kind = dds.toString('latin1', 84, 88);
    if (!BLOCK[kind]) return bad(id + ' fourCC ' + kind);
    const sizes = [];
    for (let m = 0; m < mips; m++) {
      const lw = Math.max(1, w >> m), lh = Math.max(1, h >> m);
      if (lw % 4 || lh % 4) bad(`${id} level ${m} ${lw}x${lh} not multiple of 4`);
      sizes.push(Math.ceil(lw / 4) * Math.ceil(lh / 4) * BLOCK[kind]);
    }
    if (dds.length !== 128 + sizes.reduce((a, b) => a + b, 0)) return bad(`${id} size ${dds.length} != chain`);
    const png = fs.readFileSync(path.join(dir, f.replace(/\.dds$/, '.png')));
    if (png.readUInt32BE(16) !== w || png.readUInt32BE(20) !== h) bad(`${id} dims ${w}x${h} vs png ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
    const pngAlpha = png[25] === 6, ddsAlpha = (dds.readUInt32LE(80) & 1) !== 0;
    if (pngAlpha !== ddsAlpha) bad(`${id} alpha png=${pngAlpha} dds=${ddsAlpha}`);
    if (fi < 3 && mips > 1) {
      const a = meanColour(dds, 0, sizes, w, h, kind), b = meanColour(dds, 1, sizes, w, h, kind);
      const d = Math.max(...a.map((v, k) => Math.abs(v - b[k])));
      if (d > 12) bad(`${id} mip1 mean differs from mip0 by ${d.toFixed(1)} (layout?)`);
    }
  });
}
console.log(`${fail ? 'FAIL' : 'OK'}: ${n} dds in ${maps.length} maps (${maps.join(', ')}), ${(bytes / 1048576).toFixed(1)} MB, ${fail} problems`);
process.exitCode = fail ? 1 : 0;
