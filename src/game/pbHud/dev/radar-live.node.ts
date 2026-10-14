// PNG check of the radar through the LIVE draw: PbHud.prototype.drawMinimap itself (not a copy) on a software 2D context that
// implements the canvas calls it uses (setTransform/translate/rotate/scale/save/restore/clearRect/drawImage, nearest sampling).
// Map NStation, player at world (4, -32) (Base VERMELHA, the in-game screenshot spot), one ally 8 m along world -z; yaw 0 / 90 / 180 degrees. Asserts that the transform is
// a rotation (det > 0: never a mirror), that the view direction lands at screen up and that the ally blip sits on its world spot.
//   node --experimental-transform-types --no-warnings src/game/pbHud/dev/radar-live.node.ts [outDir]
//   -> radar-live-yaw0.png, radar-live-yaw90.png, radar-live-yaw180.png (153x153 viewport, x3)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

register("../../../lobby/core/test/resolve-ts.mjs", import.meta.url);
const gl = globalThis as Record<string, unknown>;
gl.window ??= globalThis;
gl.location ??= { search: "", hash: "", hostname: "127.0.0.1", protocol: "http:", host: "127.0.0.1:8000" };
gl.devicePixelRatio = 1;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "../../../..");
const HUDDIR = path.join(WEB, "public/assets/ui/cross-hud");
const OUT = process.argv[2] || path.join(HERE, "out");
fs.mkdirSync(OUT, { recursive: true });

const { tool } = await import(new URL("../../../../scripts/dev/lib/tools.mjs", import.meta.url).href) as { tool(rel: string): Promise<unknown> };
type Img = { w: number; h: number; rgba: Buffer; width: number; height: number };
const { decodePNG, encodePNG } = await tool("ui-export/lib.mjs") as { decodePNG(b: Buffer): Img; encodePNG(rgba: Buffer, w: number, h: number): Buffer };
const { PbHud } = await import("../PbHud.ts");
const { MINIMAP, minimapTransform } = await import("../layout.ts");
const load = (f: string): Img => { const i = decodePNG(fs.readFileSync(path.join(HUDDIR, f))); i.width = i.w; i.height = i.h; return i; };

type M = [number, number, number, number, number, number]; // a b c d e f (canvas order)
const mul = (m: M, n: M): M => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
/** the subset of CanvasRenderingContext2D drawMinimap calls; drawImage = inverse-mapped nearest sampling with source-over */
class SoftCtx {
  m: M = [1, 0, 0, 1, 0, 0];
  stack: M[] = [];
  globalAlpha = 1;
  maps: M[] = []; // transform of every full-image drawImage (the map)
  constructor(public cv: { width: number; height: number; rgba: Buffer }) {}
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void { this.m = [a, b, c, d, e, f]; }
  translate(x: number, y: number): void { this.m = mul(this.m, [1, 0, 0, 1, x, y]); }
  rotate(r: number): void { const c = Math.cos(r), s = Math.sin(r); this.m = mul(this.m, [c, s, -s, c, 0, 0]); }
  scale(x: number, y: number): void { this.m = mul(this.m, [x, 0, 0, y, 0, 0]); }
  save(): void { this.stack.push(this.m); }
  restore(): void { this.m = this.stack.pop() ?? this.m; }
  clearRect(): void { this.cv.rgba.fill(0); }
  drawImage(img: Img, ...a: number[]): void {
    const [sx, sy, sw, sh, dx, dy, dw, dh] = a.length === 2 ? [0, 0, img.w, img.h, a[0], a[1], img.w, img.h] : a;
    if (a.length === 2) this.maps.push(this.m);
    const [A, B, C, D, E, F] = this.m, det = A * D - B * C, W = this.cv.width, H = this.cv.height;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const px = x + 0.5 - E, py = y + 0.5 - F, lx = (D * px - C * py) / det, ly = (-B * px + A * py) / det; // local (dest) coords
      if (lx < dx || ly < dy || lx >= dx + dw || ly >= dy + dh) continue;
      const u = Math.floor(sx + ((lx - dx) * sw) / dw), v = Math.floor(sy + ((ly - dy) * sh) / dh);
      if (u < 0 || v < 0 || u >= img.w || v >= img.h) continue;
      const s = (v * img.w + u) * 4, o = (y * W + x) * 4, k = (img.rgba[s + 3] / 255) * this.globalAlpha;
      for (let i = 0; i < 3; i++) this.cv.rgba[o + i] = this.cv.rgba[o + i] * (1 - k) + img.rgba[s + i] * k;
      this.cv.rgba[o + 3] = Math.min(255, this.cv.rgba[o + 3] + k * 255);
    }
  }
}

const idx = JSON.parse(fs.readFileSync(path.join(HUDDIR, "index.json"), "utf8"));
const r = idx.radar.NStation;
const mmInfo = { w: r.w, h: r.h, ...r.minfo };
const mmImg = load(r.png), hudTex = load("hud/Hud.png");
const T = minimapTransform(mmInfo), V = MINIMAP.view;
const P = { x: 4, z: -32 }, ally = { x: P.x, z: P.z - 8 };
for (const deg of [0, 90, 180]) {
  const yaw = (deg * Math.PI) / 180, W = V.w, H = V.h;
  const cv = { width: 0, height: 0, rgba: Buffer.alloc(0), getContext: () => ctx };
  const ctx = new SoftCtx(cv);
  // width setter of a real canvas reallocates the backing store
  Object.defineProperty(cv, "width", { get: () => W, set: () => {}, configurable: true });
  Object.defineProperty(cv, "height", { get: () => H, set: () => {}, configurable: true });
  cv.rgba = Buffer.alloc(W * H * 4);
  const self = { mmCanvas: cv, mmImg, mmInfo, mmZoom: MINIMAP.zoom, hudTex };
  (PbHud.prototype as unknown as { drawMinimap: Function }).drawMinimap.call(self, [P.x, 0, P.z], yaw, [{ team: 0, x: ally.x, z: ally.z, alive: true }], 0);

  const m = ctx.maps[0];
  assert.ok(m, "map drawn");
  assert.ok(m[0] * m[3] - m[1] * m[2] > 0, `yaw ${deg}: map transform is a rotation, not a mirror`);
  // view direction (world forward (-sin yaw, -cos yaw), Player.yaw) 10 m ahead -> screen straight above the centre
  const at = (x: number, z: number): [number, number] => { const [u, v] = T.toImage(x, z), [u0, v0] = T.toImage(P.x, P.z), lx = u - u0, ly = v - v0; return [m[0] * lx + m[2] * ly + m[4], m[1] * lx + m[3] * ly + m[5]]; };
  const [fx, fy] = at(P.x - Math.sin(yaw) * 10, P.z - Math.cos(yaw) * 10);
  assert.ok(Math.abs(fx - W / 2) < 1e-6 && fy < H / 2, `yaw ${deg}: forward at screen up (${fx.toFixed(1)}, ${fy.toFixed(1)})`);
  // camera right (local +x rotated by yaw about +y: (cos yaw, -sin yaw)) -> screen right: no left/right swap
  const [rx] = at(P.x + Math.cos(yaw) * 10, P.z - Math.sin(yaw) * 10);
  assert.ok(rx > W / 2, `yaw ${deg}: view right at screen right (${rx.toFixed(1)})`);
  console.log(`yaw ${deg}: det ${(m[0] * m[3] - m[1] * m[2]).toFixed(3)}, forward at (${fx.toFixed(1)}, ${fy.toFixed(1)}), ally 8 m to -z at (${at(ally.x, ally.z).map((n) => n.toFixed(1)).join(", ")})`);

  const S = 3, big = Buffer.alloc(W * S * H * S * 4);
  for (let y = 0; y < H * S; y++) for (let x = 0; x < W * S; x++) {
    const o = (Math.floor(y / S) * W + Math.floor(x / S)) * 4, a = cv.rgba[o + 3] / 255, d = (y * W * S + x) * 4;
    for (let i = 0; i < 3; i++) big[d + i] = cv.rgba[o + i] * a + 40 * (1 - a);
    big[d + 3] = 255;
  }
  const f = path.join(OUT, `radar-live-yaw${deg}.png`);
  fs.writeFileSync(f, encodePNG(big, W * S, H * S));
  console.log("wrote", f);
}
