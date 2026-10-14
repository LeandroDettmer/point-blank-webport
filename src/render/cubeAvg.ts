// Pure (no three / settings) so node smokes can import it.
const BLOCK: Record<string, number> = { DXT1: 8, DXT3: 16, DXT5: 16 }; // bytes per 4x4 block

/**
 * Mean rgb (0..1, raw) of mip 0 of each cube face (+X -X +Y -Y +Z -Z, 18 floats), decoded on the CPU from the DXT blocks. Feeds the IBL diffuse
 * (env_ref.dds has no mips, so a blurred GPU sample is not available). null = not a DXT1/3/5 cubemap.
 */
export function cubeFaceAverages(buf: ArrayBuffer): Float32Array | null {
  if (buf.byteLength < 128) return null;
  const v = new DataView(buf);
  if (v.getUint32(0, true) !== 0x20534444 || v.getUint32(4, true) !== 124 || (v.getUint32(112, true) & 0xfe00) !== 0xfe00) return null;
  const h = v.getUint32(12, true), w = v.getUint32(16, true), mipCount = Math.max(1, v.getUint32(28, true));
  const f = BLOCK[String.fromCharCode(v.getUint8(84), v.getUint8(85), v.getUint8(86), v.getUint8(87))];
  if (!f || !w || !h) return null;
  const bw = (w + 3) >> 2, bh = (h + 3) >> 2;
  let faceBytes = 0; // all mips of one face
  for (let m = 0; m < mipCount; m++) faceBytes += Math.max(1, (Math.max(1, w >> m) + 3) >> 2) * Math.max(1, (Math.max(1, h >> m) + 3) >> 2) * f;
  if (128 + faceBytes * 6 > buf.byteLength) return null;
  const out = new Float32Array(18);
  const pal = new Float32Array(12); // 4 colours x rgb
  const c565 = (c: number, o: number): void => {
    pal[o] = ((c >> 11) & 31) / 31;
    pal[o + 1] = ((c >> 5) & 63) / 63;
    pal[o + 2] = (c & 31) / 31;
  };
  for (let face = 0; face < 6; face++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < bw * bh; i++) {
      const o = 128 + face * faceBytes + i * f + (f - 8); // DXT3/5 keep the colour block in the last 8 bytes
      const c0 = v.getUint16(o, true), c1 = v.getUint16(o + 2, true), bits = v.getUint32(o + 4, true);
      c565(c0, 0);
      c565(c1, 3);
      const four = f === 16 || c0 > c1;
      for (let k = 0; k < 3; k++) {
        pal[6 + k] = four ? (2 * pal[k] + pal[3 + k]) / 3 : (pal[k] + pal[3 + k]) / 2;
        pal[9 + k] = four ? (pal[k] + 2 * pal[3 + k]) / 3 : 0;
      }
      for (let p = 0; p < 16; p++) {
        const idx = ((bits >>> (p * 2)) & 3) * 3;
        r += pal[idx];
        g += pal[idx + 1];
        b += pal[idx + 2];
      }
      n += 16;
    }
    out[face * 3] = r / n;
    out[face * 3 + 1] = g / n;
    out[face * 3 + 2] = b / n;
  }
  return out;
}

