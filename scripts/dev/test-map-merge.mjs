#!/usr/bin/env node
// Map draw call merge smoke, no browser / GL.
// Builds the real visual.glb of a map (positions / uv / uv1 / DDS textures through parseDds, pbWorldMaterial like realLevel),
// merges it and checks: same triangle count, per triangle the same diffuse + lightmap pixels, UVs, positions and render state.
// Then counts the meshes (= draw calls) a camera sees at every respawn x 8 yaws, before / after, with frustum culling.
//
//   node scripts/dev/test-map-merge.mjs [map ...] [--cell N]     (default: giran2 sandstorm airport ghosttown fallucity)
import './lib/nodeTs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import * as THREE from 'three';

const args = process.argv.slice(2);
const ci = args.indexOf('--cell');
const CELL = ci >= 0 ? Number(args.splice(ci, 2)[1]) : undefined;
const maps = args.length ? args : ['giran2', 'sandstorm', 'airport', 'ghosttown', 'fallucity'];
const PUBLIC = path.resolve(import.meta.dirname, '../public');

const { parseDds } = await import('../../src/render/compressedTex.ts');
const { pbWorldMaterial } = await import('../../src/render/pbLighting.ts');
const { mergeWorldMeshes, MAP_MERGE_CELL } = await import('../../src/render/mapMerge.ts');

const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const AR = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };

function buildScene(map) {
  const base = path.join(PUBLIC, 'assets/maps', map) + '/';
  const g = fs.readFileSync(base + 'visual.glb');
  const jl = g.readUInt32LE(12);
  const J = JSON.parse(g.toString('utf8', 20, 20 + jl));
  const bo = 20 + jl;
  const bin = g.subarray(bo + 8, bo + 8 + g.readUInt32LE(bo));
  const read = (ai) => {
    const a = J.accessors[ai], v = J.bufferViews[a.bufferView], T = AR[a.componentType], n = a.count * NC[a.type];
    const o = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    return new T(bin.buffer.slice(bin.byteOffset + o, bin.byteOffset + o + n * T.BYTES_PER_ELEMENT));
  };
  const texCache = new Map();
  const tex = (i) => {
    if (!texCache.has(i)) {
      const uri = J.images[J.textures[i].source].uri;
      const f = base + uri.replace(/\.png$/i, '.dds');
      let t = fs.existsSync(f) ? parseDds(fs.readFileSync(f).buffer.slice(0)) : null;
      if (t) {
        const h = crypto.createHash('md5');
        for (const mm of t.mipmaps) h.update(mm.data);
        t.userData.hash = h.digest('hex'); // pixels of every mip
        t.userData.ddsUrl = f; // what DdsTextureExt sets (compressedTex.ts)
      } else {
        t = new THREE.Texture(); // PNG fallback: not mergeable, stays a mesh of its own
        t.userData.hash = 'png:' + uri;
      }
      texCache.set(i, t);
    }
    return texCache.get(i);
  };
  const mats = J.materials.map((M) => {
    const s = new THREE.MeshStandardMaterial();
    if (!M.pbrMetallicRoughness?.baseColorTexture || !M.occlusionTexture) { s.name = 'std:' + M.name; return s; } // realLevel leaves these as glTF materials
    s.map = tex(M.pbrMetallicRoughness.baseColorTexture.index);
    s.aoMap = tex(M.occlusionTexture.index);
    s.userData.lightMap = true;
    s.side = M.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
    s.alphaTest = M.alphaMode === 'MASK' ? (M.alphaCutoff ?? 0.5) : 0;
    s.transparent = M.alphaMode === 'BLEND';
    return pbWorldMaterial(s);
  });
  const root = new THREE.Group();
  const cache = new Map();
  for (const me of J.meshes)
    for (const p of me.primitives) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(read(p.attributes.POSITION)), 3));
      if (p.attributes.TEXCOORD_0 !== undefined) geom.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(read(p.attributes.TEXCOORD_0)), 2));
      if (p.attributes.TEXCOORD_1 !== undefined) geom.setAttribute('uv1', new THREE.BufferAttribute(Float32Array.from(read(p.attributes.TEXCOORD_1)), 2));
      if (p.indices !== undefined) geom.setIndex(new THREE.BufferAttribute(Uint32Array.from(read(p.indices)), 1));
      const mesh = new THREE.Mesh(geom, mats[p.material]);
      mesh.name = me.name;
      root.add(mesh);
    }
  void cache;
  const col = JSON.parse(fs.readFileSync(base + 'collision.json', 'utf8'));
  const lj = fs.existsSync(base + 'lighting.json') ? JSON.parse(fs.readFileSync(base + 'lighting.json', 'utf8')) : null;
  return { root, respawns: col.respawns ?? [], camFar: lj?.camFar ?? 1000, texs: [...texCache.values()] };
}

// per-triangle multiset: pixels of diffuse + lightmap, uv, uv1, positions, render state
const f5 = (n) => n.toFixed(5);
function triSignatures(root) {
  const out = new Map();
  const add = (k) => out.set(k, (out.get(k) ?? 0) + 1);
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry, m = o.material;
    const P = g.getAttribute('position'), A = g.getAttribute('uv'), B = g.getAttribute('uv1'), L = g.getAttribute('pbLayer');
    if (!m.uniforms) { // not a PB world material: untouched by the merge
      const n = g.index ? g.index.count : P.count;
      for (let t = 0; t < n; t += 3) add(`std|${m.name}|${[0, 1, 2].map((k) => P.getX(g.index ? g.index.getX(t + k) : t + k).toFixed(5)).join(',')}`);
      return;
    }
    const state = `${m.uniforms.alphaTest.value}/${m.side}/${m.transparent}/${m.depthWrite}`;
    let hd, hl;
    if (L) { // merged: the layer's bytes are the texture
      const layerHash = (arr, layer) => {
        const mip0 = arr.mipmaps[0], per = mip0.data.byteLength / arr.image.depth;
        const h = crypto.createHash('md5');
        for (const mm of arr.mipmaps) { const pl = mm.data.byteLength / arr.image.depth; h.update(mm.data.subarray(layer * pl, (layer + 1) * pl)); }
        void per;
        return h.digest('hex');
      };
      const hc = new Map();
      const lh = (arr, layer) => { const k = arr.uuid + layer; if (!hc.has(k)) hc.set(k, layerHash(arr, layer)); return hc.get(k); };
      hd = (i) => lh(m.uniforms.mapArr.value, L.getX(i));
      hl = (i) => lh(m.uniforms.luxArr.value, L.getY(i));
    } else {
      const d = m.uniforms.map.value.userData.hash, l = m.uniforms.luxMap.value.userData.hash;
      hd = () => d; hl = () => l;
    }
    const n = g.index ? g.index.count : P.count;
    for (let t = 0; t < n; t += 3) {
      const vs = [0, 1, 2].map((k) => (g.index ? g.index.getX(t + k) : t + k));
      const s = vs.map((i) => [f5(P.getX(i)), f5(P.getY(i)), f5(P.getZ(i)), f5(A.getX(i)), f5(A.getY(i)), f5(B.getX(i)), f5(B.getY(i))].join(',')).join(';');
      add(`${s}|${hd(vs[0])}|${hl(vs[0])}|${state}`);
    }
  });
  return out;
}

// draw calls seen: meshes whose bounding sphere intersects the camera frustum
function drawStats(root, respawns, far) {
  const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, far);
  const fr = new THREE.Frustum(), pm = new THREE.Matrix4();
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) { o.geometry.computeBoundingSphere(); meshes.push(o); } });
  const counts = [];
  for (const r of respawns)
    for (let k = 0; k < 8; k++) {
      cam.position.set(r.pos[0], r.pos[1] + 1.6, r.pos[2]);
      cam.rotation.set(0, (k * Math.PI) / 4, 0);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      fr.setFromProjectionMatrix(pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
      let n = 0;
      for (const m of meshes) if (fr.intersectsObject(m)) n++;
      counts.push(n);
    }
  counts.sort((a, b) => a - b);
  return { total: meshes.length, avg: Math.round(counts.reduce((a, b) => a + b, 0) / counts.length), min: counts[0], p90: counts[Math.floor(counts.length * 0.9)], max: counts[counts.length - 1] };
}

// CPU bytes retained: mips of every source texture still holding them (the loader's parser cache keeps them all) + the arrays +
// geometry in the scene. `texs` = every source texture the glTF parser would still reference before the merge.
const MB = (n) => (n / 1048576).toFixed(1) + ' MB';
function retained(root, texs) {
  const seen = new Set();
  let tex = 0, geo = 0;
  const addTex = (t) => { if (!t || seen.has(t)) return; seen.add(t); for (const m of t.mipmaps ?? []) tex += m.data.byteLength; };
  for (const t of texs) addTex(t);
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const v of Object.values(o.material.uniforms ?? {})) if (v.value?.isTexture) addTex(v.value);
    for (const a of Object.values(o.geometry.attributes)) geo += a.array.byteLength;
    if (o.geometry.index) geo += o.geometry.index.array.byteLength;
  });
  return { tex, geo };
}
// real process memory (node --expose-gc): heap + array buffers after a full GC
const gcMem = () => { if (!globalThis.gc) return null; globalThis.gc(); const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
const rows = [];
for (const map of maps) {
  const { root, respawns, camFar, texs } = buildScene(map);
  const before = drawStats(root, respawns, camFar);
  const mem0 = retained(root, texs);
  const sigBefore = triSignatures(root);
  const mats0 = [];
  root.traverse((o) => { const u = o.isMesh && o.material.uniforms; if (u?.map?.value?.isCompressedTexture && u.luxMap?.value?.isCompressedTexture && u.map.value.userData.ddsUrl && u.luxMap.value.userData.ddsUrl && !o.material.transparent) mats0.push({ d: u.map.value, l: u.luxMap.value }); });
  const gc0 = gcMem();
  const t0 = performance.now();
  const s = mergeWorldMeshes(root, CELL);
  const ms = performance.now() - t0;
  const gc1 = gcMem();
  const after = drawStats(root, respawns, camFar);
  const sigAfter = triSignatures(root);
  const mem1 = retained(root, texs);
  if (gc0 !== null) console.log(`  process heap+buffers after GC: ${MB(gc0)} -> ${MB(gc1)} (${gc1 >= gc0 ? '+' : ''}${MB(gc1 - gc0)})`);
  console.log(`  cpu bytes: textures ${MB(mem0.tex)} -> ${MB(mem1.tex)}, geometry ${MB(mem0.geo)} -> ${MB(mem1.geo)}, total ${MB(mem0.tex + mem0.geo)} -> ${MB(mem1.tex + mem1.geo)} (${s.releasedTextures} source textures freed)`);

  // one layer per distinct image: depth sum == distinct DDS files used by merged candidates, per kind (diffuse / lightmap)
  const usedD = new Set(), usedL = new Set();
  for (const o of mats0) { usedD.add(o.d.userData.ddsUrl); usedL.add(o.l.userData.ddsUrl); }
  const depth = s.arrays.reduce((n, a) => n + a.depth, 0);
  console.log(`  distinct images: ${usedD.size} diffuse + ${usedL.size} lightmap, ${mats0.length} merge candidates`);
  for (const a of s.arrays) console.log(`  array ${a.key}: depth ${a.depth}, ${a.mips} mips, ${MB(a.bytes)}`);
  assert.equal(depth, usedD.size + usedL.size, `${map}: array layers != distinct images`);
  assert.equal(s.trisOut, s.trisIn, `${map}: merged triangle count`);
  assert.equal([...sigAfter.values()].reduce((a, b) => a + b, 0), [...sigBefore.values()].reduce((a, b) => a + b, 0), `${map}: total triangles`);
  assert.equal(sigAfter.size, sigBefore.size, `${map}: distinct triangles`);
  for (const [k, n] of sigBefore) if (sigAfter.get(k) !== n) { const pre = k.split("|")[0]; console.log("BEFORE", k.split("|").slice(1).join(" ")); for (const k2 of sigAfter.keys()) if (k2.startsWith(pre)) console.log("AFTER ", k2.split("|").slice(1).join(" ")); assert.fail(map + ": triangle differs"); }
  let seen = 0;
  root.traverse((o) => { if (o.isMesh && o.geometry.getAttribute('pbLayer')) seen++; });
  assert.equal(seen, s.meshesOut - s.kept, `${map}: merged mesh count`);
  console.log(`${map}: ${s.meshesIn} meshes -> ${s.meshesOut} (${s.kept} kept), ${s.trisIn} tris identical, ${s.diffuseArrays}+${s.luxArrays} arrays, merge ${ms.toFixed(0)} ms`);
  console.log(`  draw calls per view (${respawns.length} respawns x 8 yaws, far ${camFar}): before avg ${before.avg} min ${before.min} p90 ${before.p90} max ${before.max} | after avg ${after.avg} min ${after.min} p90 ${after.p90} max ${after.max}`);
  rows.push({ map, before, after });
}
console.log(`map merge smoke OK (cell ${CELL ?? MAP_MERGE_CELL} m)`);
