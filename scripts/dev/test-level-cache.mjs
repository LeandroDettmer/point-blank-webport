#!/usr/bin/env node
// Level cache smoke (src/levelCache.ts + realLevel.ts + mapProps.ts), no browser: the second match on the same map must not
// load the visual / collision / prop GLBs again, props start intact in it, and another map releases the first.
//
//   node scripts/dev/test-level-cache.mjs [map]     (default downtown: breakable glass props)
import './lib/nodeTs.mjs';
import assert from 'node:assert/strict';

const MAP = process.argv[2] ?? 'downtown', OTHER = MAP === 'nstation' ? 'downtown' : 'nstation';
const { installNodeEnv, buildNodeLevel, glbLoader } = await import('../../src/game/dev/navLevel.node.ts');
const { levelCacheStats } = await import('../../src/levelCache.ts');
const { currentMapProps } = await import('../../src/game/mapProps.ts');
installNodeEnv();

const loader = glbLoader();
const t = (f) => { const t0 = performance.now(); return f().then((r) => [r, performance.now() - t0]); };
const n = (w) => w.colliders.len();

// match 1: cold
const [a, ms1] = await t(() => buildNodeLevel(MAP, loader));
const loads1 = loader.loads.length;
assert.ok(loads1 >= 2, 'cold build loads visual + collision');
const props1 = currentMapProps();
assert.ok(props1 && props1.props.some((p) => p.def.breakable), `${MAP} has breakable props`);
const colliders1 = n(a.world);
const breakable = props1.props.filter((p) => p.def.breakable && p.life !== null);
const victim = breakable[0];
const lifeBefore = victim.life, collidersBefore = victim.colliders.length;
props1.breakIndex(victim.index);
assert.ok(victim.broken, 'the prop broke in match 1');
a.world.step();
const broken1 = n(a.world);
console.log(`match 1 (cold): ${loads1} loads, ${ms1.toFixed(0)} ms, ${colliders1} colliders, prop ${victim.name} broken -> ${broken1}`);

// match 2: same map, a fresh world
const hits0 = levelCacheStats.hits;
const [b, ms2] = await t(() => buildNodeLevel(MAP, loader));
assert.equal(loader.loads.length, loads1, 'match 2 loads nothing: ' + loader.loads.slice(loads1).join(', '));
assert.ok(levelCacheStats.hits > hits0, 'match 2 was served by the cache');
const props2 = currentMapProps();
assert.notEqual(props2, props1, 'props are rebuilt per match');
const v2 = props2.props[victim.index];
assert.equal(v2.name, victim.name);
assert.equal(v2.broken, false, 'the prop is intact again');
assert.equal(v2.life, lifeBefore, 'initial life');
assert.equal(v2.colliders.length, collidersBefore, 'initial colliders');
assert.equal(props2.props.filter((p) => p.broken).length, 0, 'no prop starts broken');
assert.equal(n(b.world), colliders1, 'same collider count as a cold build');
assert.notEqual(b.world, a.world);
assert.notEqual(b.level.visualGroup, a.level.visualGroup, 'own node tree per match');
// the broken prop of match 1 did not leak into the shared geometry: its model is the cached one and visible in match 2
assert.ok(broken1 !== colliders1 || victim.def.collision?.kind !== 'boxes', 'break changed the colliders of match 1');
console.log(`match 2 (cached): 0 loads, ${ms2.toFixed(0)} ms (cold ${ms1.toFixed(0)} ms), props intact, ${n(b.world)} colliders`);

// match 3: reset path still works on a cached level
props2.breakIndex(victim.index);
props2.reset();
assert.equal(v2.broken, false);
assert.equal(v2.colliders.length, collidersBefore);

// another map releases the first: coming back loads again
const rel0 = levelCacheStats.releases;
await buildNodeLevel(OTHER, loader);
assert.equal(levelCacheStats.releases, rel0 + 1, 'the previous map was released');
const loads3 = loader.loads.length;
await buildNodeLevel(MAP, loader);
assert.ok(loader.loads.length > loads3, 'returning to the first map reloads it (it was freed)');
console.log(`map change: released, reloaded ${loader.loads.length - loads3} files; stats`, levelCacheStats);
console.log('level cache smoke OK');
