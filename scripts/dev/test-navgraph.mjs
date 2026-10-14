#!/usr/bin/env node
// Baked nav graph smoke (src/game/navGraph.ts + pb-extract-tools bake-navgraph.mjs), no browser: the graph loaded from
// public/assets/maps/<map>/navgraph.bin must be the one NavGraph.build makes on the same level (production map path: buildRealLevel +
// loadMapMeta), node for node and edge for edge in the same order, with the same A* paths; a stale file is rejected.
//
//   node scripts/dev/test-navgraph.mjs [map ...]     (default nstation downtown; compares live build vs file)
//   node scripts/dev/test-navgraph.mjs --all         every baked map: the file matches the map's bounds / respawns (no rebuild)
import './lib/nodeTs.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const { installNodeEnv, buildNodeLevel, availableMaps, PUBLIC } = await import('../../src/game/dev/navLevel.node.ts');
const { NavGraph } = await import('../../src/game/navGraph.ts');
installNodeEnv();
const file = (m) => path.join(PUBLIC, 'assets/maps', m, 'navgraph.bin');
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

if (args.includes('--all')) {
  let ok = 0, missing = [];
  for (const m of await availableMaps()) {
    const lvl = await buildNodeLevel(m);
    if (!lvl.meta.bounds) continue;
    if (!fs.existsSync(file(m))) { missing.push(m); continue; }
    const g = NavGraph.fromBuffer(ab(fs.readFileSync(file(m))), lvl.meta.bounds, lvl.meta.spawns.map((s) => s.feet));
    assert.ok(g, `${m}: navgraph.bin is stale (rebake)`);
    ok++;
  }
  console.log(`${ok} baked graphs match their maps; no file (maps the game plays without a graph or not baked): ${missing.join(' ') || '-'}`);
  process.exit(missing.length ? 1 : 0);
}

for (const m of args.length ? args : ['nstation', 'downtown']) {
  const lvl = await buildNodeLevel(m);
  const { bounds, spawns } = lvl.meta;
  const seeds = spawns.map((s) => s.feet);
  const t0 = performance.now();
  const built = NavGraph.build(lvl.world, lvl.R, bounds, seeds);
  const buildMs = performance.now() - t0;
  const buf = fs.readFileSync(file(m));
  const t1 = performance.now();
  const loaded = NavGraph.fromBuffer(ab(buf), bounds, seeds);
  const loadMs = performance.now() - t1;
  assert.ok(loaded, `${m}: baked file rejected`);
  assert.equal(loaded.size, built.size, `${m}: node count`);
  assert.deepEqual(loaded.px, built.px, `${m}: px`);
  assert.deepEqual(loaded.py, built.py, `${m}: py`);
  assert.deepEqual(loaded.pz, built.pz, `${m}: pz`);
  assert.deepEqual(loaded.adj, built.adj, `${m}: adjacency (order included)`);
  let edges = 0;
  for (const a of built.adj) edges += a.length;
  // lookups and A* behave the same (cell index rebuilt)
  const THREE = await import('three');
  let paths = 0;
  for (let i = 0; i < 40; i++) {
    const a = Math.floor((built.size * (i + 1)) / 41), b = Math.floor((built.size * ((i * 7) % 40 + 1)) / 41);
    assert.deepEqual(loaded.path(a, b), built.path(a, b), `${m}: path ${a}->${b}`);
    const p = new THREE.Vector3(built.px[a] + 0.3, built.py[a], built.pz[a] - 0.2);
    assert.equal(loaded.nearest(p, 3), built.nearest(p, 3), `${m}: nearest`);
    if (built.path(a, b)) paths++;
  }
  // stale bakes are rejected: other bounds, other respawns, damaged header
  const shifted = { min: bounds.min.clone().addScalar(1), max: bounds.max.clone() };
  assert.equal(NavGraph.fromBuffer(ab(buf), shifted, seeds), null, 'other bounds');
  assert.equal(NavGraph.fromBuffer(ab(buf), bounds, seeds.slice(1)), null, 'other respawns');
  assert.equal(NavGraph.fromBuffer(ab(buf).slice(0, 100), bounds, seeds), null, 'truncated');
  // round trip of the live graph
  const again = NavGraph.fromBuffer(built.toBuffer(bounds, seeds), bounds, seeds);
  assert.deepEqual(again.adj, built.adj, `${m}: toBuffer/fromBuffer round trip`);
  console.log(`${m}: ${built.size} nodes, ${edges / 2} edges, ${paths}/40 paths; build ${buildMs.toFixed(0)} ms vs baked load ${loadMs.toFixed(1)} ms (${buf.length} bytes)`);
}
console.log('navgraph smoke OK');
