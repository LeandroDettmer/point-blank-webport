// node --experimental-transform-types src/render/dev/cubeAvg.smoke.node.ts [env_ref.dds]
// Checks cubeFaceAverages: synthetic DXT1 cube (known colours) + the real airport env_ref.dds when present.
import { readFileSync, existsSync } from "node:fs";
import { cubeFaceAverages } from "../cubeAvg.ts";

function assert(c: boolean, m: string): void {
  if (!c) throw new Error("FAIL " + m);
}

// synthetic: 4x4 DXT1 cube, 1 mip, face i = solid colour (c0 = c1 = pure 565 value, all indices 0)
const cols = [0xf800, 0x07e0, 0x001f, 0xffff, 0x0000, 0xf81f]; // red green blue white black magenta
const buf = new ArrayBuffer(128 + 6 * 8);
const v = new DataView(buf);
v.setUint32(0, 0x20534444, true);
v.setUint32(4, 124, true);
v.setUint32(12, 4, true);
v.setUint32(16, 4, true);
v.setUint32(28, 1, true);
"DXT1".split("").forEach((ch, i) => v.setUint8(84 + i, ch.charCodeAt(0)));
v.setUint32(112, 0xfe00, true);
cols.forEach((c, i) => {
  v.setUint16(128 + i * 8, c, true);
  v.setUint16(128 + i * 8 + 2, c, true);
});
const a = cubeFaceAverages(buf)!;
assert(!!a && a.length === 18, "synthetic length");
const exp = [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 1];
exp.forEach((e, i) => assert(Math.abs(a[i] - e) < 1e-6, `synthetic[${i}] ${a[i]} != ${e}`));
console.log("synthetic ok");

const real = process.argv[2] ?? "public/assets/maps/airport/env_ref.dds";
if (existsSync(real)) {
  const b = readFileSync(real);
  const r = cubeFaceAverages(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)!;
  assert(!!r, "real parse");
  ["+X", "-X", "+Y", "-Y", "+Z", "-Z"].forEach((n, i) => console.log(n, [...r.slice(i * 3, i * 3 + 3)].map((x: number) => x.toFixed(3)).join(" ")));
  assert(r.every((x) => x >= 0 && x <= 1), "real range");
} else console.log("skip real (no", real + ")");
