// Clan mark logo pack/unpack + render from the exported atlas (public/assets/ui/clanmark). No browser: composes in node,
// writes PNGs for visual check. Run: node --experimental-transform-types src/lobby/test/clanMark.smoke.node.ts
// Output dir: argv[2] or <os tmp>/clanmark-smoke.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  CLAN_MARK_DEFAULT, clanMarkBackImageList, clanMarkColorList, clanMarkShapeImageList, composeClanMark,
  decodeClanMark, encodeClanMark, type ClanMarkAtlas, type ClanMarkSheet,
} from "../clanMark.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, "../../../public/assets/ui/clanmark");
const OUT = process.argv[2] ?? path.join(os.tmpdir(), "clanmark-smoke");

// ---- pack / unpack (exe shifts) -----------------------------------------------------------------------------------
assert.equal(decodeClanMark(CLAN_MARK_DEFAULT), null, "0xFFFFFFFF = no mark");
assert.equal(encodeClanMark({ backColor: 0, backImage: 0, shapeImage: 0, shapeColor: 0 }), 0, "all zero packs to 0");
assert.equal(encodeClanMark({ backColor: 0x12, backImage: 0x34, shapeImage: 0x56, shapeColor: 0x78 }), 0x12345678, "byte order back colour > back image > shape image > shape colour");
assert.deepEqual(decodeClanMark(0x12345678), { backColor: 0x12, backImage: 0x34, shapeImage: 0x56, shapeColor: 0x78 });
for (let i = 0; i < 1000; i++) {
  const p = { backColor: i % 256, backImage: (i * 7) % 256, shapeImage: (i * 13) % 256, shapeColor: (i * 31) % 256 };
  const logo = encodeClanMark(p);
  assert.ok(logo >= 0 && logo <= 0xffffffff, "logo is uint32");
  assert.deepEqual(decodeClanMark(logo), p, `round trip ${i}`);
}
assert.deepEqual(decodeClanMark(Number(BigInt.asUintN(32, BigInt(0x12345678)))), decodeClanMark(0x12345678));

// ---- lists for the popup ------------------------------------------------------------------------------------------
assert.equal(clanMarkBackImageList().length, 27);
assert.equal(clanMarkShapeImageList().length, 81);
assert.equal(clanMarkColorList().length, 10);
assert.deepEqual(clanMarkColorList()[0].rgba, [121, 23, 0, 255], "colour 1 = exe user table entry 1");

// ---- PNG decode (8-bit RGB/RGBA, no interlace; the exporter writes RGBA) ------------------------------------------
function decodePng(file: string): ClanMarkSheet {
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt32BE(0), 0x89504e47, `${file} is PNG`);
  let p = 8, w = 0, h = 0, ct = 0, depth = 0;
  const idat: Buffer[] = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("latin1", p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ct = data[9]; }
    if (type === "IDAT") idat.push(data);
    p += 12 + len;
  }
  assert.equal(depth, 8, "8-bit");
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  assert.ok(bpp, `colour type ${ct} supported`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp, out = new Uint8ClampedArray(new ArrayBuffer(w * h * 4));
  let prev = new Uint8Array(stride), line = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, s = x * bpp;
      out[o] = line[s]; out[o + 1] = line[s + 1]; out[o + 2] = line[s + 2]; out[o + 3] = bpp === 4 ? line[s + 3] : 255;
    }
    [prev, line] = [line, new Uint8Array(stride)];
  }
  return { w, h, rgba: out };
}

const sheet = (name: string) => decodePng(path.join(ASSETS, name));
const atlasOf = (k: "m" | "s") => ({
  frameFill: sheet(`frame_${k}_fill.png`),
  frameOutline: sheet(`frame_${k}_outline.png`),
  shapeFill: [0, 1, 2].map((p) => sheet(`shape_${k}_fill_${p}.png`)),
  shapeOutline: [0, 1, 2].map((p) => sheet(`shape_${k}_outline_${p}.png`)),
});
const atlas: ClanMarkAtlas = { m: atlasOf("m"), s: atlasOf("s") };
assert.equal(atlas.m.frameFill.w, 512);
assert.equal(atlas.s.frameFill.w, 256);
assert.equal(atlas.m.shapeFill[2].w, 512);

// ---- render ------------------------------------------------------------------------------------------------------
const alphaSum = (px: Uint8ClampedArray) => { let n = 0; for (let i = 3; i < px.length; i += 4) n += px[i]; return n; };
assert.equal(composeClanMark(CLAN_MARK_DEFAULT, 128, atlas), null, "default logo = nothing to draw");
assert.equal(alphaSum(composeClanMark(0, 128, atlas)!), 0, "logo 0 = no images, transparent");
assert.equal(alphaSum(composeClanMark(encodeClanMark({ backColor: 1, backImage: 0, shapeImage: 82, shapeColor: 1 }), 128, atlas)!), 0, "index past count = no image");
assert.ok(alphaSum(composeClanMark(encodeClanMark({ backColor: 1, backImage: 1, shapeImage: 0, shapeColor: 1 }), 128, atlas)!) > 0, "back cell 0 draws");
assert.ok(alphaSum(composeClanMark(encodeClanMark({ backColor: 0, backImage: 0, shapeImage: 81, shapeColor: 0 }), 128, atlas)!) > 0, "last shape cell (81) draws");

// ---- minimal RGBA PNG encoder (node side only; the browser path uses canvas) ----------------------------------------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function pngEncode(rgba: Uint8ClampedArray, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ---- contact sheet: rows = back colour 1..9, cols = shape colour 1..9, indices walk the cells --------------------------
fs.mkdirSync(OUT, { recursive: true });
const CELL = 96, N = 9, W = N * CELL;
const grid = new Uint8ClampedArray(new ArrayBuffer(W * W * 4));
for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
  const logo = encodeClanMark({ backColor: r + 1, backImage: 1 + ((r * 3 + c) % 27), shapeImage: 1 + ((c * 9 + r * 4) % 81), shapeColor: c + 1 });
  const px = composeClanMark(logo, CELL, atlas)!;
  for (let y = 0; y < CELL; y++) grid.set(px.subarray(y * CELL * 4, (y + 1) * CELL * 4), ((r * CELL + y) * W + c * CELL) * 4);
}
fs.writeFileSync(path.join(OUT, "clanmark-grid.png"), pngEncode(grid, W, W));
const big = composeClanMark(encodeClanMark({ backColor: 4, backImage: 13, shapeImage: 40, shapeColor: 7 }), 512, atlas)!;
fs.writeFileSync(path.join(OUT, "clanmark-512.png"), pngEncode(big, 512, 512));
const small = composeClanMark(encodeClanMark({ backColor: 4, backImage: 13, shapeImage: 40, shapeColor: 7 }), 64, atlas)!;
fs.writeFileSync(path.join(OUT, "clanmark-64.png"), pngEncode(small, 64, 64));

console.log(`clanMark smoke ok -> ${OUT}`);
