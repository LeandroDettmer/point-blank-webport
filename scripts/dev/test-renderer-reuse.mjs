#!/usr/bin/env node
// Shared-renderer smoke (src/render/sharedRenderer.ts + levelCache.levelCacheOwned), no WebGL: the renderer lives across matches, so
// a match end must dispose every geometry / material / texture the match created (created == disposed after N matches) and nothing
// the level cache owns (those stay uploaded for the next match on the same map). A mock counts the 'dispose' events three's renderer
// listens to.
//
//   node scripts/dev/test-renderer-reuse.mjs
import './lib/nodeTs.mjs';
import assert from 'node:assert/strict';
import * as THREE from 'three';

const { cachedOnce, disposeGltf, levelCacheScope, levelCacheOwned } = await import('../../src/levelCache.ts');
const { releaseMatch, disposeSceneResources } = await import('../../src/render/sharedRenderer.ts');

const disposed = new Map(); // object -> times its 'dispose' fired
const track = (o) => { disposed.set(o, 0); o.addEventListener('dispose', () => disposed.set(o, disposed.get(o) + 1)); return o; };
const tex = () => track(new THREE.Texture());

// the cached level: 3 meshes, a ShaderMaterial with a lightmap uniform
levelCacheScope('mock-map');
const levelScene = new THREE.Group();
const levelObjs = [];
for (let i = 0; i < 3; i++) {
  const g = track(new THREE.BufferGeometry());
  const t = tex();
  const m = i === 2
    ? track(new THREE.ShaderMaterial({ uniforms: { lm: { value: t } } }))
    : track(new THREE.MeshStandardMaterial({ map: t }));
  levelScene.add(new THREE.Mesh(g, m));
  levelObjs.push(g, m, t);
}
await cachedOnce('gltf:mock', () => Promise.resolve({ scene: levelScene }), disposeGltf);

const mockRenderer = () => {
  let removed = 0;
  return { removed: () => removed, setRenderTarget() {}, domElement: { remove: () => { removed++; }, style: { filter: 'x' } }, info: { reset() {}, memory: { geometries: 0, textures: 0 }, programs: [] } };
};

const MATCHES = 5;
let created = 0;
for (let n = 0; n < MATCHES; n++) {
  const scene = new THREE.Scene();
  scene.add(levelScene.clone(true)); // shares geometry / materials / textures, like cloneGltf
  const own = [];
  // a cloned level material (props / decals): own material, shared texture
  const shared = levelScene.children[0];
  const clone = track(shared.material.clone());
  scene.add(new THREE.Mesh(shared.geometry, clone));
  own.push(clone);
  // a per-match model: own geometry + material + texture, plus an instanced mesh and a material array
  const g = track(new THREE.BoxGeometry()), t = tex(), m = track(new THREE.MeshBasicMaterial({ map: t })), m2 = track(new THREE.MeshBasicMaterial());
  scene.add(new THREE.Mesh(g, m), new THREE.Mesh(track(new THREE.BufferGeometry()), [m2, m2]));
  const inst = new THREE.InstancedMesh(g, m, 4); // reuses g / m: counted once
  scene.add(inst);
  own.push(g, t, m, m2);
  // the camera child (viewmodel) is outside `scene` roots unless passed: releaseMatch gets [scene, camera]
  const camera = new THREE.PerspectiveCamera();
  const vm = new THREE.Mesh(track(new THREE.BufferGeometry()), track(new THREE.MeshBasicMaterial({ map: tex() })));
  camera.add(vm);
  own.push(vm.geometry, vm.material, vm.material.map);
  created += own.length + 1; // + the BufferGeometry of the array-material mesh
  const r = mockRenderer();
  const swept = releaseMatch(r, [scene, camera]);
  assert.equal(r.removed(), 1, 'canvas leaves the page');
  assert.equal(r.domElement.style.filter, '', 'brightness filter reset');
  assert.equal(swept.geometries, 3, `match ${n}: geometries swept (box, array mesh, viewmodel)`);
  assert.equal(swept.materials, 4, `match ${n}: materials swept`);
  assert.equal(swept.textures, 2, `match ${n}: textures swept (own + viewmodel; the level texture of the clone is shared)`);
  for (const o of own) assert.ok(disposed.get(o) >= 1, `match ${n}: a per-match resource leaked (${o.type})`);
  for (const o of levelObjs) assert.equal(disposed.get(o), 0, `match ${n}: level resource disposed while cached (${o.type})`);
  for (const o of own) disposed.delete(o); // next match gets new objects
}
console.log(`${MATCHES} matches: ${created} per-match resources created and swept, ${levelObjs.length} level resources untouched`);

// sweep without a cache: everything goes
const s = new THREE.Scene();
s.add(levelScene.clone(true));
const all = disposeSceneResources([s], { has: () => false });
assert.equal(all.geometries, 3);
assert.equal(all.textures, 3);
for (const o of levelObjs) assert.ok(disposed.get(o) >= 1);

// SkinnedMesh: the sweep frees the boneTexture (Skeleton.dispose); a detached one is its owner's (CharVisual.dispose)
{
  const mk = () => {
    const bone = new THREE.Bone(), sk = new THREE.Skeleton([bone]);
    const sm = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    sm.add(bone); sm.bind(sk);
    sk.computeBoneTexture();
    return { sm, bt: track(sk.boneTexture) };
  };
  const a = mk(), sc = new THREE.Scene(); sc.add(a.sm);
  disposeSceneResources([sc], { has: () => false });
  assert.ok(disposed.get(a.bt) >= 1, 'boneTexture of a scene skinned mesh disposed');
  const b = mk(); b.sm.skeleton.dispose();
  assert.ok(disposed.get(b.bt) >= 1, 'Skeleton.dispose frees boneTexture');
}

// a map switch frees the cache for real (disposeGltf): the owned set is empty afterwards
levelCacheScope('other-map');
await new Promise((r) => setTimeout(r, 0));
assert.equal(levelCacheOwned().has(levelObjs[0]), false);
console.log('shared renderer smoke OK');
