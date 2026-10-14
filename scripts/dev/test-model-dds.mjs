#!/usr/bin/env node
// Smoke for the weapon / character .dds written by export-model-dds.mjs (run with --experimental-transform-types):
//   node --experimental-transform-types scripts/dev/test-model-dds.mjs [N weapons (default 40)]
// 1. container: header, dims == PNG, mip chain size, alpha flag, no .dds without PNG, models_lod has none
// 2. blocks == the original i3i of the pack named in index.json (same ddsOf), for models whose maps live in their own pack
// 3. client hook (src/render/compressedTex.ts, mocked parser + fetch): .dds -> CompressedTexture, 404 / garbage -> PNG fallback,
//    no S3TC -> null, models_lod path -> null (low-texture option wins)
import { tool } from './lib/tools.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { packTextures } = await tool('export-model.mjs');
const { ddsOf, hasAlphaFast } = await tool('export-visual.mjs');
const { stem } = await tool('i3r2/skin-glb.mjs');

const WEBAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUB = path.join(WEBAPP, 'public', 'assets');
const BLOCK = { DXT1: 8, DXT3: 16, DXT5: 16 };
let fail = 0, n = 0, bytes = 0, orig = 0;
const bad = (m) => { fail++; console.log('FAIL', m); };
const walk = (d, o = []) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) e.isDirectory() ? walk(path.join(d, e.name), o) : o.push(path.join(d, e.name)); return o; };

const all = [...walk(path.join(PUB, 'weapons')), ...walk(path.join(PUB, 'chars'))].filter((f) => f.endsWith('.dds'));
if (!all.length) { console.log('no .dds: run scripts/dev/export-model-dds.mjs first'); process.exit(1); }
const step = Math.max(1, Math.floor(all.length / Math.max(1, +process.argv[2] || 40)));
for (const f of all) {
  if (f.split(path.sep).join('/').includes('/models_lod/')) bad(f + ' dds in models_lod');
  const png = f.replace(/\.dds$/, '.png');
  if (!fs.existsSync(png)) { bad(f + ' no png'); continue; }
}
for (const f of all.filter((_, i) => i % step === 0)) {
  const dds = fs.readFileSync(f); bytes += dds.length; n++;
  const id = path.relative(PUB, f);
  if (dds.toString('latin1', 0, 4) !== 'DDS ' || dds.readUInt32LE(4) !== 124) { bad(id + ' header'); continue; }
  const h = dds.readUInt32LE(12), w = dds.readUInt32LE(16), mips = dds.readUInt32LE(28), kind = dds.toString('latin1', 84, 88);
  if (!BLOCK[kind]) { bad(id + ' fourCC ' + kind); continue; }
  let total = 128;
  for (let m = 0; m < mips; m++) { const lw = Math.max(1, w >> m), lh = Math.max(1, h >> m); if (lw % 4 || lh % 4) bad(`${id} level ${m} not x4`); total += Math.ceil(lw / 4) * Math.ceil(lh / 4) * BLOCK[kind]; }
  if (total !== dds.length) bad(`${id} size ${dds.length} != chain ${total}`);
  const png = fs.readFileSync(f.replace(/\.dds$/, '.png'));
  if (png.readUInt32BE(16) !== w || png.readUInt32BE(20) !== h) bad(`${id} dims ${w}x${h} vs png`);
  if (png[25] === 6 && !(dds.readUInt32LE(80) & 1)) bad(`${id} png has alpha, dds flag not`);
}

// 2. original blocks
const packs = new Map();
const tries = [];
for (const [file, key, dirOf] of [['weapons/models/index.json', 'weapons', (e) => `weapons/models/tex/${e.id}`], ['chars/index.json', 'chars', (e) => `chars/${e.name}/tex`]]) {
  const list = JSON.parse(fs.readFileSync(path.join(PUB, file), 'utf8'))[key].filter((e) => !e.skinOf && e.source);
  for (const e of list.filter((_, i) => i % Math.max(1, Math.floor(list.length / 25)) === 0)) tries.push({ e, dir: path.join(PUB, dirOf(e)) });
}
for (const { e, dir } of tries) {
  const src = path.join(process.env.PB_CLIENTS ?? path.join(WEBAPP, 'Clients'), e.source.replace(/^.*?(PBKaybo|PointBlank 3\.123|PB RUSSIA)/, (_, c) => c));
  if (!fs.existsSync(src)) continue;
  if (!packs.has(src)) packs.set(src, packTextures(fs.readFileSync(src), src));
  const lib = packs.get(src);
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.dds')) : []) {
    const t = lib.get(f.replace(/\.dds$/, ''));
    if (!t) continue; // map came from a fallback pack
    const dds = fs.readFileSync(path.join(dir, f));
    const want = ddsOf(t.buf, t, (dds.readUInt32LE(80) & 1) !== 0);
    if (!want || !want.equals(dds)) bad(`${e.id || e.name}/${f} differs from original i3i blocks`); else orig++;
  }
}

// 3. client hook
const THREE = await import('three');
const { setCompressedTextureSupport, registerModelCompressedTextures, parseDds } = await import('../../src/render/compressedTex.ts');
const sample = all.find((f) => f.split(path.sep).join('/').includes('weapons/models/tex'));
const buf = fs.readFileSync(sample);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
const tex = parseDds(ab);
if (!tex || !tex.isCompressedTexture || tex.mipmaps.length !== buf.readUInt32LE(28)) bad('parseDds');
let factory = null;
const loader = { register: (f) => { factory = f; } };
registerModelCompressedTextures(loader);
const mk = (p) => { const calls = { png: 0 }; const parser = { options: { path: p }, json: { textures: [{ source: 0 }], images: [{ uri: 'tex/a/a.png', name: 'a' }] }, textureLoader: {}, loadTextureImage: async () => { calls.png++; return 'PNG'; } }; return { ext: factory(parser), calls }; };
const real = globalThis.fetch;
const run = async (p, resp, supported = true) => {
  setCompressedTextureSupport({ extensions: { has: () => supported } });
  globalThis.fetch = async () => resp;
  const { ext, calls } = mk(p);
  const r = ext.loadTexture(0);
  return { r: r ? await r : null, calls };
};
const ok = { ok: true, arrayBuffer: async () => ab };
let t1 = await run('/assets/weapons/models/', ok); if (!t1.r?.isCompressedTexture || t1.calls.png) bad('hook dds');
t1 = await run('/assets/weapons/models/', { ok: false }); if (t1.r !== 'PNG') bad('hook 404 fallback');
t1 = await run('/assets/weapons/models/', { ok: true, arrayBuffer: async () => new ArrayBuffer(200) }); if (t1.r !== 'PNG') bad('hook garbage fallback');
t1 = await run('/assets/weapons/models/', ok, false); if (t1.r !== null) bad('hook no s3tc');
t1 = await run('/assets/weapons/models_lod/', ok); if (t1.r !== null) bad('hook models_lod');
globalThis.fetch = real;

console.log(`${fail ? 'FAIL' : 'OK'}: ${all.length} dds on disk, ${n} container-checked (${(bytes / 1048576).toFixed(1)} MB), ${orig} byte-equal to original i3i, hook ok, ${fail} problems`);


// 4. per-load url cache: N glTF textures with one uri = 1 fetch, 1 parse. Maps share the object; models clone (shared Source).
{
  const { registerCompressedTextures } = await import('../../src/render/compressedTex.ts');
  setCompressedTextureSupport({ extensions: { has: () => true } });
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return { ok: true, arrayBuffer: async () => ab }; };
  const N = 50;
  const mkMany = (p) => ({ options: { path: p }, json: { textures: Array.from({ length: N }, () => ({ source: 0 })), images: [{ uri: 'tex/a/a.png', name: 'a' }] }, textureLoader: {}, loadTextureImage: async () => 'PNG' });
  for (const [kind, reg, base] of [['model', registerModelCompressedTextures, '/assets/weapons/models/'], ['map', (l) => registerCompressedTextures(l, '/assets/maps/x/'), '/assets/maps/x/']]) {
    fetches = 0; let f; reg({ register: (fn) => { f = fn; } });
    const ext = f(mkMany(base));
    const ts = await Promise.all(Array.from({ length: N }, (_, i) => ext.loadTexture(i)));
    const distinct = new Set(ts).size, sameSource = new Set(ts.map((t) => t.source)).size;
    if (fetches !== 1) bad(`${kind} cache: ${fetches} fetches for ${N} textures`);
    if (kind === 'map' ? distinct !== 1 : distinct !== N || sameSource !== 1) bad(`${kind} cache: ${distinct} objects, ${sameSource} sources`);
    if (ts.some((t) => t.userData.ddsUrl !== base + 'tex/a/a.dds')) bad(`${kind} cache: ddsUrl`);
    console.log(`  ${kind}: ${N} textures -> ${fetches} fetch, ${distinct} objects, ${sameSource} source`);
  }
  globalThis.fetch = real;
}
process.exitCode = fail ? 1 : 0;
