import * as THREE from "three";
import { getSettings } from "../gameplay/settings.ts";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  fxUrl, weaponFx, weaponFxInfo, type BulletSmoke, type FxChannel, type FxEffect, type FxParticle, type FxTable,
} from "./sights";
import { smokeField, type SmokeSphere } from "./throwables";
import type { Family } from "./types";

/**
 * Weapon FX with the 2017 client's own data (pb-extract-tools export-weaponfx.mjs -> public/assets/weapons/fx):
 *  - muzzle flash  = i3 particle effect Effect._FireEffect (+ "_1st" variant in 1PV), parented to FXDummy (+Y = barrel),
 *                    WeaponBase::Create 0x603c70 / spawn 0x615600 -> 0x60f840, plus an i3Light (range 3, 1.4/1.3/1.2)
 *  - tracer        = CTracerBullet type 0 (0x5afa40 / OnActive 0x5affd0): Effect/TracerBullet.i3i strip of
 *                    TracerBulletLength, width TracerBulletThickness, tail moving at TracerBulletSpeed from the muzzle,
 *                    head clamped to the hit, white, additive (SrcBlend 5 / DestBlend 2, Create 0x5b0e80), UV (0,0)-(1,1)
 *                    = bright top row of the texture at the head; spawned per bullet when rand()%100 < TracerBulletRate
 *                    (0x60f42c) or the weapon is class 5 (sniper), skipped at <= 0.5 m (Fire 0x5b1700)
 *  - bullet smoke  = CTracerBullet type 6: Effect/TracerBulletSmoke.i3i, weapon BulletSmoke* (CGunInfo::SetBulletSmokeInfo)
 *  - impacts       = Hit_<cat>_<surface> (blow) + Hmk_<cat>_<surface> (bullet-mark decal), AddBlowEffect 0x6900b0 /
 *                    AddDecal 0x6902f0, decal placed at pos - dir*0.008; pool size = Default.i3FxList Count
 *  - shells        = Bul_{Hg_MK23|Ar_M4A1|Smg_MP5K|Sr_HKPSG1|Sg_870MCS} at EmptyCartridgeFXDummy (0x617bb0 -> 0x60fb50)
 *  - blood         = ExpHu01_1 (character hit)
 * Particle semantics: i3ParticleInfo / i3Particle::Drive (layouts in pb-extract-tools export-weaponfx.mjs).
 * Without weaponfx.json every call falls back to the procedural sprites below ([RECRIADO]).
 */

/** Texture source: the browser uses THREE.TextureLoader; the headless renderer injects its own. */
export type FxTextureLoader = (url: string) => THREE.Texture;
/** image load of each texture made by the default loader (preloadFx waits for them; an injected loader has none) */
const texLoaded = new WeakMap<THREE.Texture, Promise<void>>();
let texLoader: FxTextureLoader = (url) => {
  let done!: () => void;
  const ready = new Promise<void>((r) => { done = r; });
  const t = new THREE.TextureLoader().load(url, () => done(), undefined, () => done());
  t.colorSpace = THREE.SRGBColorSpace;
  texLoaded.set(t, ready);
  return t;
};
export function setFxTextureLoader(f: FxTextureLoader): void {
  texLoader = f;
}
const texCache = new Map<string, THREE.Texture>();
/**
 * NOT ORIGINAL: HD replacements (pb-extract-tools bloodtex/gen.mjs, same layout, x3) of the 64 px blood sheets, taken from the reference port.
 * Key = original path, value = design size (px) of the original sheet, so frameUV can rescale fw/fh.
 * Docs: 
 */
const BLOOD_HD: Record<string, number> = { "tex/tex_blood_1.png": 128, "tex/tex_blood_2.png": 256 };
/** billboardFactor cap and max streak length (effect units) of the HD blood particles; raise for longer streaks */
const BLOOD_STRETCH = 1.5, BLOOD_MAX_LEN = 0.6;
export function fxTexture(rel: string): THREE.Texture {
  const key = rel;
  if (BLOOD_HD[rel]) rel = rel.replace("tex/", "tex/hd/");
  let t = texCache.get(key);
  if (!t) texCache.set(key, (t = texLoader(fxUrl(rel))));
  return t;
}

// ---- i3 curve evaluation (i3Particle::Drive 0x10174a70, func switch 0x10175f78) -------------------------------------
function sampleTable(tb: FxTable, t: number, linear: boolean): number {
  const v = tb.v, n = v.length;
  if (!n) return 0;
  if (tb.t && tb.t.length === n) {
    const k = tb.t;
    if (t <= k[0]) return v[0];
    if (t >= k[n - 1]) return v[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (k[m] <= t) lo = m;
      else hi = m;
    }
    if (!linear) return v[lo];
    const f = (t - k[lo]) / Math.max(1e-9, k[hi] - k[lo]);
    return v[lo] + (v[hi] - v[lo]) * f;
  }
  const x = Math.max(0, t) * n, i = Math.floor(x);
  if (i >= n - 1) return v[n - 1];
  return linear ? v[i] + (v[i + 1] - v[i]) * (x - i) : v[i];
}
/** channel value at normalized life t; rnd = the particle's random factor (1 +- k/2) */
function evalCh(c: FxChannel, t: number, linear: boolean, rnd: number): number {
  switch (c.func) {
    case "const": return c.init;
    case "sin": return c.factor * Math.sin(t * Math.PI * 0.5);
    case "cos": return c.factor * Math.cos(t * Math.PI * 0.5);
    case "rand": return Math.random() * 2 - 1;
    case "table": return c.table ? sampleTable(c.table, t, linear) * rnd : c.init;
    default: return c.init;
  }
}
const on = (c: FxChannel) => c.func !== "none" && c.func !== 0;

// D3DBLEND -> three factors
const D3D_BLEND: Record<number, THREE.BlendingDstFactor> = {
  1: THREE.ZeroFactor, 2: THREE.OneFactor, 3: THREE.SrcColorFactor, 4: THREE.OneMinusSrcColorFactor,
  5: THREE.SrcAlphaFactor, 6: THREE.OneMinusSrcAlphaFactor, 7: THREE.DstAlphaFactor, 8: THREE.OneMinusDstAlphaFactor,
  9: THREE.DstColorFactor, 10: THREE.OneMinusDstColorFactor,
};
function layerMaterial(p: FxParticle): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    map: p.tex ? fxTexture(p.tex) : null, transparent: !!p.blend, depthWrite: p.zwrite, depthTest: p.ztest,
    side: THREE.DoubleSide, forceSinglePass: true, vertexColors: true,
  });
  if (p.blend) {
    const [s, d] = p.blend;
    if (s === 5 && d === 2) m.blending = THREE.AdditiveBlending;
    else if (!(s === 5 && d === 6)) {
      m.blending = THREE.CustomBlending;
      m.blendSrc = D3D_BLEND[s] ?? THREE.SrcAlphaFactor;
      m.blendDst = D3D_BLEND[d] ?? THREE.OneMinusSrcAlphaFactor;
    }
  }
  if (p.decal || p.type === "decal") {
    m.polygonOffset = true;
    m.polygonOffsetFactor = -4;
    m.polygonOffsetUnits = -4;
  }
  return m;
}

/**
 * One layer material per particle definition, shared by every instance of the effect and by every quad of it: colour and
 * alpha of each particle are its vertex colours (setCorners). A fresh material per play() made three derive the program
 * key again on every shot; a clone per particle made one material per live quad.
 */
const LAYER_MAT = new WeakMap<FxParticle, THREE.MeshBasicMaterial>();
function layerMaterialOf(p: FxParticle): THREE.MeshBasicMaterial {
  let m = LAYER_MAT.get(p);
  if (!m) LAYER_MAT.set(p, (m = layerMaterial(p)));
  return m;
}

/** sRGB colour of a muzzle colour (battleChatModel NICK_COLORS entry) */
export type Tint = readonly [number, number, number];
/**
 * 1600187 muzzle colour: the layer material multiplied by the colour (vertex colours x material colour). One copy per particle
 * and colour, cached: a tinted shot allocates nothing. White = the shared material (no tint).
 */
const TINT_MAT = new WeakMap<FxParticle, Map<string, THREE.MeshBasicMaterial>>();
function tintedLayerMaterialOf(p: FxParticle, rgb: Tint): THREE.MeshBasicMaterial {
  let byColor = TINT_MAT.get(p);
  if (!byColor) TINT_MAT.set(p, (byColor = new Map()));
  const key = rgb.join(",");
  let m = byColor.get(key);
  if (!m) {
    m = layerMaterial(p);
    m.color.setStyle(`rgb(${key})`);
    byColor.set(key, m);
  }
  return m;
}

/**
 * i3 gravity (i3Particle::Drive 0x10174fa6, posStyle bit4): per-frame velocity += dt^2 * mass * GravityFactor * dir, i.e.
 * a = mass * 98 along (0,-1,0): i3SceneDx statics g_102da0e4 = 98, g_102da0d8 = (0,-1,0); PointBlank.exe never calls
 * i3Particle::SetGravityFactor / SetGravityDirection (not imported), so the defaults hold.
 */
const GRAVITY = -1;
const GRAVITY_FACTOR = 98;

interface Live {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
  spawn: THREE.Vector3;
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  speed: number;
  vy: number;
  scale: number;
  rot: number;
  rotRate: number;
  rS: number;
  rP: number;
  colorT: number;
  frame: number;
  /** distance moved in the last update */
  step: number;
  /** position before the last update (velocity strip reference, i3Particle::Drive 0x1017512b) */
  prev: THREE.Vector3;
  /** frozen decal whose matrix is final (place() is skipped from then on) */
  placed?: boolean;
}
interface Layer { p: FxParticle; mat: THREE.MeshBasicMaterial; live: Live[]; emitted: number; nextEmit: number; started: boolean; /** holes moved to the instanced batches: no more emits */ baked?: boolean }

const _up = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _q = new THREE.Quaternion(), _cq = new THREE.Quaternion(), _m = new THREE.Matrix4();
const _q2 = new THREE.Vector3(), _q3 = new THREE.Vector3(), _z = new THREE.Vector3(), _tail = new THREE.Vector3();
/** unit quad, corners 0 (-x,+y) 1 (+x,+y) 2 (+x,-y) 3 (-x,-y) */
const QUAD = new Float32Array([-0.5, 0.5, 0, 0.5, 0.5, 0, 0.5, -0.5, 0, -0.5, -0.5, 0]);
/** mesh.matrix = [X Y Z P] (Z = unit normal), matrixWorld = parent * matrix */
function setBasis(mesh: THREE.Object3D, parent: THREE.Matrix4 | null, X: THREE.Vector3, Y: THREE.Vector3, P: THREE.Vector3) {
  _z.crossVectors(X, Y);
  if (_z.lengthSq() < 1e-16) _z.set(0, 0, 1);
  mesh.matrix.makeBasis(X, Y, _z.normalize()).setPosition(P);
  if (parent) mesh.matrixWorld.multiplyMatrices(parent, mesh.matrix);
  else mesh.matrixWorld.copy(mesh.matrix);
}

function coneDir(p: FxParticle, out: THREE.Vector3): THREE.Vector3 {
  const d = _a.fromArray(p.emitDir);
  if (d.lengthSq() < 1e-8) d.set(0, 1, 0);
  d.normalize();
  const ang = (p.emitAngle * Math.PI) / 180;
  if (p.emitType === 1) return out.randomDirection();
  const base = p.emitType === 2 ? _b.fromArray(p.up).normalize() : d;
  // random rotation of +-angle on two axes around the direction (emit type 0 / 2)
  const tx = Math.abs(base.y) < 0.99 ? _c.set(0, 1, 0) : _c.set(1, 0, 0);
  const s = new THREE.Vector3().crossVectors(base, tx).normalize(), u = new THREE.Vector3().crossVectors(s, base);
  const a1 = (Math.random() * 2 - 1) * ang, a2 = (Math.random() * 2 - 1) * ang;
  return out.copy(base).applyAxisAngle(s, a1).applyAxisAngle(u, a2).normalize();
}

/**
 * Particle quads recycled per layer definition: a fresh BufferGeometry per particle made three.js re-register a VAO
 * for every shot, which was half of the frame time with 20 actors firing.
 * Everything a particle changes (colour, opacity, UV, matrix, onBeforeRender) is rewritten on reuse. Colour and alpha are
 * the quad's vertex colours, so all quads of a layer draw with the layer material (no clone per particle).
 */
const QUAD_POOL = new WeakMap<FxParticle, THREE.Mesh[]>();
const QUAD_POOL_MAX = 64;
/** bullet-hole effects alive at once, all surfaces (each layer = 1 draw call; the original fxList allows ~2500) */
const MAX_DECAL_FX = 96;
/** transient (non-persistent) Hmk_* effects alive at once, all shooters; [RECRIADO] ~3 layers each = ~120 draw calls */
const MAX_TRANSIENT_MARK_FX = 40;
/** NOT ORIGINAL: Hit_* and Fir_* effects alive at once (each its own budget), all shooters */
const MAX_HITFIR_FX = 48;
/** RGBA vertex colours, one per corner (white, opaque: what a fresh material had) */
function rgbaAttribute(): THREE.BufferAttribute { return new THREE.BufferAttribute(new Float32Array(16).fill(1), 4); }
/** the 4 corners' RGBA of a quad / strip (rgb linear, as material.color holds it) */
const cornerRGBA = (g: THREE.BufferGeometry) => (g.attributes.color as THREE.BufferAttribute).array as Float32Array;
/** scratch colour: setRGB / setHex (sRGB in, linear out, like material.color) then setCorners */
const _col = new THREE.Color();
/**
 * Writes rgb (when given) and alpha to the 4 corners; uploads only when a value changed. Values are rounded to float32
 * first so an unchanged colour is not re-uploaded every frame.
 */
function setCorners(g: THREE.BufferGeometry, rgb: THREE.Color | null, a: number | null): void {
  const v = cornerRGBA(g);
  const r = rgb ? Math.fround(rgb.r) : v[0], gr = rgb ? Math.fround(rgb.g) : v[1], b = rgb ? Math.fround(rgb.b) : v[2];
  const al = a !== null ? Math.fround(a) : v[3];
  if (v[0] === r && v[1] === gr && v[2] === b && v[3] === al) return;
  for (let i = 0; i < 16; i += 4) { v[i] = r; v[i + 1] = gr; v[i + 2] = b; v[i + 3] = al; }
  (g.attributes.color as THREE.BufferAttribute).needsUpdate = true;
}
function takeQuad(L: Layer): THREE.Mesh {
  const q = QUAD_POOL.get(L.p)?.pop();
  if (q) return q;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(QUAD.slice(), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), 2));
  g.setAttribute("color", rgbaAttribute());
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const mesh = new THREE.Mesh(g, L.mat);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  return mesh;
}
function releaseQuad(p: FxParticle, l: Live): void {
  l.mesh.removeFromParent();
  l.mesh.onBeforeRender = () => {};
  let pool = QUAD_POOL.get(p);
  if (!pool) QUAD_POOL.set(p, (pool = []));
  if (pool.length < QUAD_POOL_MAX) pool.push(l.mesh);
  else l.mesh.geometry.dispose(); // the layer material is shared: kept
}

/**
 * Frozen bullet holes (matrix final, colour / opacity / UV constant) are drawn as one InstancedMesh per look
 * (layer def + colour + opacity + UV + renderOrder) instead of one quad mesh each: a burst of holes of one surface = 1 draw call.
 * Same material settings as the per-quad path (clone of the layer material), so blend / depthWrite / polygonOffset are unchanged.
 */
const BATCH_CAP = 256;
interface BatchSlot { batch: DecalBatch; idx: number }
class DecalBatch {
  readonly mesh: THREE.InstancedMesh;
  readonly slots: BatchSlot[] = [];
  constructor(readonly owner: DecalBatcher, readonly key: string, src: Live, renderOrder: number) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(QUAD.slice(), 3));
    g.setAttribute("uv", new THREE.BufferAttribute((src.mesh.geometry.attributes.uv as THREE.BufferAttribute).array.slice() as Float32Array, 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    // the batch has no corner colours: colour and alpha of its look go into its own material
    const mat = src.mat.clone(), v = cornerRGBA(src.mesh.geometry);
    mat.vertexColors = false;
    mat.color.setRGB(v[0], v[1], v[2]);
    mat.opacity = v[3];
    this.mesh = new THREE.InstancedMesh(g, mat, BATCH_CAP);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = renderOrder;
  }
  get full(): boolean { return this.slots.length >= BATCH_CAP; }
  add(m: THREE.Matrix4): BatchSlot {
    const s = { batch: this, idx: this.slots.length };
    this.slots.push(s);
    this.mesh.setMatrixAt(s.idx, m);
    this.mesh.count = this.slots.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    return s;
  }
  remove(s: BatchSlot): void {
    const last = this.slots.pop()!;
    if (last !== s) {
      this.mesh.getMatrixAt(last.idx, _m);
      this.mesh.setMatrixAt(s.idx, _m);
      last.idx = s.idx;
      this.slots[s.idx] = last;
    }
    this.mesh.count = this.slots.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (!this.slots.length) this.owner.drop(this);
  }
}
class DecalBatcher {
  private batches = new Map<string, DecalBatch[]>();
  private ids = new WeakMap<FxParticle, number>();
  private nextId = 0;
  constructor(private readonly parent: THREE.Object3D) {}
  /** number of drawable meshes (smoke hook) */
  get meshCount(): number { let n = 0; for (const b of this.batches.values()) n += b.length; return n; }
  add(p: FxParticle, l: Live, renderOrder: number): BatchSlot {
    let id = this.ids.get(p);
    if (id === undefined) this.ids.set(p, (id = this.nextId++));
    const uv = (l.mesh.geometry.attributes.uv as THREE.BufferAttribute).array;
    const v = cornerRGBA(l.mesh.geometry);
    const key = `${id}|${_col.setRGB(v[0], v[1], v[2]).getHex()}|${v[3]}|${renderOrder}|${uv.join(",")}`;
    let list = this.batches.get(key);
    if (!list) this.batches.set(key, (list = []));
    let b = list[list.length - 1];
    if (!b || b.full) {
      b = new DecalBatch(this, key, l, renderOrder);
      list.push(b);
      this.parent.add(b.mesh);
    }
    return b.add(l.mesh.matrixWorld);
  }
  drop(b: DecalBatch): void {
    b.mesh.removeFromParent();
    b.mesh.geometry.dispose();
    (b.mesh.material as THREE.Material).dispose();
    b.mesh.dispose();
    const list = this.batches.get(b.key)!;
    list.splice(list.indexOf(b), 1);
    if (!list.length) this.batches.delete(b.key);
  }
}
const _bakeCam = new THREE.Object3D();

/** persistent decal layer that never moves, scales, fades or changes frame once emitted */
function holeIsStatic(p: FxParticle): boolean {
  return p.type === "decal" && !(p.posStyle & 16) && p.speed.init === 0 && p.accel.func === "none" && p.scale.func !== "table" && p.scale.func !== "sin" && p.scale.func !== "cos"
    && p.grow.func === "none" && p.rot.func !== "const" && !(p.seq && !p.seq.atSpawn && p.seq.frameTime > 0 && p.seq.count > 1);
}

/** One playing i3 effect (all its particle layers) under `group`. */
class FxInstance {
  readonly group = new THREE.Group();
  private layers: Layer[] = [];
  private t = 0;
  dead = false;
  /** seconds since the effect started */
  get age(): number { return this.t; }
  /** effects with never-dying particles (decals, laser dot) stay until evicted */
  readonly persistent: boolean;
  readonly decalOnly: boolean;

  constructor(readonly name: string, def: FxEffect, readonly scaleMul = 1, tint?: Tint) {
    this.group.name = name; // shows up in scene dumps (draw-call accounting)
    // MESH layers (shell casings) are drawn by WeaponEffects.addShellMesh, not as quads
    // a layer without a texture would draw a flat white quad (the P90 MC square): i3 always binds one, so skip it
    for (const p of def.particles) if (p.type !== "mesh" && p.tex) this.layers.push({ p, mat: tint ? tintedLayerMaterialOf(p, tint) : layerMaterialOf(p), live: [], emitted: 0, nextEmit: 0, started: false });
    // >= : Hmk_Ar_So / _Gl / _Wo carry exactly 1e6 s and were left out, so they never died and were never capped by the fxList pool
    this.persistent = def.particles.some((p) => p.life >= 1e6);
    /** bullet-hole style effect: every persistent layer is a decal (safe to evict under the draw-call budget) */
    this.decalOnly = this.persistent && def.particles.every((p) => p.life < 1e6 || p.type === "decal");
  }

  private emit(L: Layer) {
    const p = L.p;
    if (this.culled && p.life < 1e6) return;
    const mesh = takeQuad(L);
    mesh.renderOrder = p.decal ? 1 : 5;
    const rS = 1 + (Math.random() - 0.5) * p.scaleRandom, rP = 1 + (Math.random() - 0.5) * p.speedRandom;
    const pos = new THREE.Vector3().fromArray(p.emitPos);
    if (p.emitType === 3 || p.emitType === 4) {
      const a = Math.random() * Math.PI * 2, r = p.emitType === 4 ? Math.sqrt(Math.random()) * p.emitAngle : 0;
      if (p.emitType === 4) pos.add(_v.set(Math.cos(a) * r, 0, Math.sin(a) * r));
      else pos.add(_v.set((Math.random() - 0.5) * p.emitAngle, 0, (Math.random() - 0.5) * p.emitAngle));
    }
    const nFrames = Math.max(1, p.seq?.count ?? 1);
    const l: Live = {
      mesh, mat: L.mat, age: 0, spawn: pos.clone(), pos, dir: coneDir(p, new THREE.Vector3()),
      speed: evalCh(p.speed, 0, (p.posStyle & 2) !== 0, rP), vy: 0,
      scale: 0, rot: p.rot.init + (Math.random() * 2 - 1) * p.rotRandom, rotRate: Math.random() * 2 - 1, rS, rP,
      colorT: p.colorStyle & 1 ? Math.random() : -1,
      step: 0,
      prev: pos.clone(),
      frame: p.seq && (p.seq.atSpawn || !p.seq.frameTime) ? (p.seq.random ? Math.floor(Math.random() * nFrames) : 0) : 0,
    };
    l.scale = (on(p.scale) || p.scale.init ? (p.scale.func === "none" ? p.scale.init : evalCh(p.scale, 0, (p.scaleStyle & 2) !== 0, rS)) : 0) * rS;
    mesh.onBeforeRender = (_r, _s, cam) => this.place(L, l, cam);
    this.group.add(mesh);
    L.live.push(l);
    L.emitted++;
    // atSpawn atlas frames (ExpHu blood: fw=64 on a 4x3 tex_blood_*.png sheet) are picked once here; update() only
    // reruns frameUV for time-driven sequences (!atSpawn), so without this the quad would sample the whole atlas.
    if (p.seq && (p.seq.atSpawn || !p.seq.frameTime) && p.seq.count > 1) this.frameUV(L, l);
  }

  /**
   * A bullet hole whose short-lived layers (flash, smoke) are over holds only static decals: nothing moves, scales, fades or
   * changes frame, so update() / place() / the UV upload are skipped from then on (they ran for every mark, every frame).
   */
  private frozen = false;

  update(dt: number): void {
    if (this.frozen) return;
    this.t += dt;
    let any = false;
    let settled = this.decalOnly;
    for (const L of this.layers) {
      const p = L.p, tl = p.time, lt = this.t - tl.start;
      const active = lt >= 0 && (tl.duration <= 0 || tl.loop || lt <= tl.duration) && (p.emitterLife <= 0 || lt <= p.emitterLife);
      if (settled) {
        const still = p.life >= 1e6 ? holeIsStatic(p) : !active && L.live.length === 0 && lt >= 0;
        if (!still) settled = false;
      }
      if (active && !L.baked) {
        if (!L.started) {
          L.started = true;
          for (let i = 0; i < Math.max(0, p.initCount); i++) if (L.live.length < Math.max(1, p.maxCount)) this.emit(L);
          L.nextEmit = lt + Math.max(1e-3, p.emitInterval);
        }
        while (lt >= L.nextEmit && p.emitInterval > 0) {
          L.nextEmit += p.emitInterval;
          for (let i = 0; i < p.emitCount; i++) {
            if (L.live.length >= Math.max(1, p.maxCount)) break;
            if (p.oneShot && L.emitted >= Math.max(1, p.maxCount)) break;
            this.emit(L);
          }
        }
        any = true;
      }
      const linP = (p.posStyle & 2) !== 0, linS = (p.scaleStyle & 2) !== 0, life = p.life > 0 ? p.life : 1e9;
      for (let i = L.live.length - 1; i >= 0; i--) {
        const l = L.live[i];
        l.age += dt;
        const t = Math.min(1, l.age / life);
        if (l.age >= life) {
          releaseQuad(p, l);
          L.live.splice(i, 1);
          continue;
        }
        any = true;
        // speed (component 0) + acceleration (component 1, integrated), clamp, gravity (posStyle bit4)
        if (on(p.accel)) l.speed += evalCh(p.accel, t, linP, l.rP) * dt;
        else if (p.speed.func === "table" || p.speed.func === "sin" || p.speed.func === "cos") l.speed = evalCh(p.speed, t, linP, l.rP);
        if (p.posStyle & 4) l.speed = THREE.MathUtils.clamp(l.speed, p.speedMinMax[0], p.speedMinMax[1]);
        l.prev.copy(l.pos);
        l.step = l.speed * dt * this.scaleMul;
        l.pos.addScaledVector(l.dir, l.step);
        if (p.posStyle & 16) {
          const mass = (p.mass[0] + p.mass[1]) * 0.5;
          l.vy += GRAVITY * mass * GRAVITY_FACTOR * dt;
          l.pos.y += l.vy * dt * this.scaleMul;
        }
        // scale (component 0) + growth (component 1)
        if (p.scale.func === "table" || p.scale.func === "sin" || p.scale.func === "cos") l.scale = evalCh(p.scale, t, linS, l.rS);
        if (on(p.grow)) l.scale += evalCh(p.grow, t, linS, 1) * dt;
        if (p.scaleStyle & 4) l.scale = THREE.MathUtils.clamp(l.scale, p.scaleMinMax[0], p.scaleMinMax[1]);
        if (p.rot.func === "const") l.rot += p.rot.init * dt * l.rotRate;
        // colour (R/G/B/A tables, colorStyle bit1 = linear)
        const ct = l.colorT >= 0 ? l.colorT : t, lin = (p.colorStyle & 2) !== 0;
        if (p.rgbFunc === "table") setCorners(l.mesh.geometry, _col.setRGB(
          (p.R ? sampleTable(p.R, ct, lin) : 255) / 255, (p.G ? sampleTable(p.G, ct, lin) : 255) / 255, (p.B ? sampleTable(p.B, ct, lin) : 255) / 255,
          THREE.SRGBColorSpace), null);
        else if (p.rgbFunc === "const") setCorners(l.mesh.geometry, _col.setHex(p.rgbInit & 0xffffff, THREE.SRGBColorSpace), null);
        const a = p.alphaFunc === "table" && p.A ? sampleTable(p.A, ct, lin)
          : p.alphaFunc === "const" ? p.alphaInit : p.alphaFunc === "sin" ? 255 * Math.sin(ct * Math.PI / 2)
            : p.alphaFunc === "cos" ? 255 * Math.cos(ct * Math.PI / 2) : 255;
        setCorners(l.mesh.geometry, null, THREE.MathUtils.clamp(a / 255, 0, 1));
        // texture sequence
        const sq = p.seq;
        if (sq && !sq.atSpawn && sq.frameTime > 0 && sq.count > 1) {
          const f = Math.floor(l.age / sq.frameTime);
          l.frame = sq.loop ? f % sq.count : Math.min(sq.count - 1, f);
        }
        this.frameUV(L, l);
      }
    }
    if (!any && !this.persistent) this.dead = true;
    // every persistent layer has its decals out and the rest is over (a layer that has not started yet keeps it unsettled)
    // the holes go to the batches as soon as they are static, without waiting for the 10 s emitter life of the flash layers
    if (this.batcher && this.decalOnly && !this.bakedDone && this.layers.every((L) => L.p.life < 1e6 || (L.started && holeIsStatic(L.p)))) this.bake(this.batcher);
    if (settled && this.layers.every((L) => L.started)) this.frozen = true;
  }
  private bakedDone = false;

  /** world-space parent only (decal matrices are baked in world space): set by WeaponEffects for scene-parented holes */
  batcher: DecalBatcher | null = null;
  private baked: BatchSlot[] = [];
  /** move every frozen decal quad into the instanced batches (the matrix is final, place() ignores the camera for decals) */
  private bake(b: DecalBatcher): void {
    this.bakedDone = true;
    for (const L of this.layers) {
      if (L.p.life < 1e6) continue; // flash / smoke layers keep their own quads
      for (const l of L.live) {
        this.place(L, l, _bakeCam as unknown as THREE.Camera);
        this.baked.push(b.add(L.p, l, l.mesh.renderOrder));
        releaseQuad(L.p, l);
      }
      L.live = [];
      L.baked = true;
    }
  }

  /**
   * Particle transform for the current camera (QUAD / SPRITE / strips / DECAL). The mesh is the unit quad
   * (+-0.5): its matrix is built here because three computes modelView right after onBeforeRender, whereas vertex
   * edits made here would only reach the GPU one frame late.
   */
  private place(L: Layer, l: Live, cam: THREE.Camera) {
    if (l.placed) return;
    const p = L.p, s = l.scale * this.scaleMul;
    this.group.updateWorldMatrix(true, false);
    const gw = this.group.matrixWorld;
    const camPos = _c.setFromMatrixPosition(cam.matrixWorld).applyMatrix4(_m.copy(gw).invert());
    if (p.type === "billboard" || p.type === "stretch") {
      // i3Particle::Drive 0x10175c99 -> AddForBillboard 0x10177c20: strip endpoints spawn->pos (BILLBOARD, exporter
      // comment) or prev->pos (velocity strip, 0x1017512b); ScaleBillboardFactor scales the (pos-ref) vector from the
      // spawn anchor, so factor=1 = plain [spawn,pos] trail; blood BloodVertical* set factor=5 for long streaks along
      // the movement axis. Width = scale.
      const ref = p.type === "billboard" ? l.spawn : l.prev;
      const a = _q3.copy(ref);
      const b = _tail.subVectors(l.pos, ref);
      if (b.lengthSq() < 1e-12) b.copy(l.dir).multiplyScalar(0.001);
      // NOT ORIGINAL: the blood streaks (BloodVertical*, factor 5) fly far and smear the HD sheet: shorter factor + length cap
      if (BLOOD_HD[p.tex ?? ""]) b.multiplyScalar(Math.min(p.billboardFactor, BLOOD_STRETCH)).clampLength(0, BLOOD_MAX_LEN).add(ref);
      else b.multiplyScalar(p.billboardFactor).add(ref);
      const side = _v.crossVectors(_b.subVectors(b, a), _q2.subVectors(camPos, a)).normalize().multiplyScalar(-s);
      setBasis(l.mesh, gw, side, _b.subVectors(a, b), _a.addVectors(a, b).multiplyScalar(0.5));
      return;
    }
    let r: THREE.Vector3, u: THREE.Vector3;
    if (p.faceCamera && p.type !== "decal") {
      this.group.getWorldQuaternion(_q).invert();
      const cq = cam.getWorldQuaternion(_cq);
      r = _a.set(1, 0, 0).applyQuaternion(cq).applyQuaternion(_q);
      u = _b.set(0, 1, 0).applyQuaternion(cq).applyQuaternion(_q);
    } else {
      // plane perpendicular to the effect's +Y (surface normal / barrel axis)
      r = _a.set(1, 0, 0);
      u = _b.set(0, 0, 1);
    }
    if (l.rot) {
      const n = _v.crossVectors(r, u).normalize();
      r.applyAxisAngle(n, l.rot);
      u.applyAxisAngle(n, l.rot);
    }
    setBasis(l.mesh, gw, r.multiplyScalar(s), u.multiplyScalar(s), l.pos);
    if (this.frozen && p.type === "decal") l.placed = true; // camera independent: the matrix stays as set
  }

  /**
   * The long-lived smoke layers' particles (Exp_Sm_01 SmokeCon* / SmokeDisc*, 13 s) in world space, as spheres of half
   * the drawn quad with the drawn opacity: the cloud bots cannot see through (throwables.ts SmokeField).
   */
  collectSmoke(out: SmokeSphere[]): void {
    this.group.updateWorldMatrix(true, false);
    const m = this.group.matrixWorld;
    for (const L of this.layers) {
      if (L.p.life < 5 || !/smoke/i.test(L.p.name)) continue;
      for (const l of L.live) {
        _v.copy(l.pos).applyMatrix4(m);
        out.push({ x: _v.x, y: _v.y, z: _v.z, r: Math.abs(l.scale * this.scaleMul) * 0.5, a: cornerRGBA(l.mesh.geometry)[3] });
      }
    }
  }

  /** atlas frame of a particle (row-major from the top-left) */
  private frameUV(L: Layer, l: Live) {
    const sq = L.p.seq, img = l.mat.map?.image as { width?: number; height?: number } | undefined;
    if (!sq || !img?.width || !img.height) return;
    // sq.fw/fh are px of the original sheet; an HD replacement (BLOOD_HD) is k times bigger
    const base = BLOOD_HD[L.p.tex ?? ""], k = base ? img.width / base : 1, fw = sq.fw * k, fh = sq.fh * k;
    const cols = Math.max(1, Math.floor(img.width / fw)), fr = sq.start + l.frame;
    const u0 = ((fr % cols) * fw) / img.width, v0 = (Math.floor(fr / cols) * fh) / img.height;
    const du = fw / img.width, dv = fh / img.height;
    const UV = l.mesh.geometry.attributes.uv as THREE.BufferAttribute, flip = l.mat.map!.flipY;
    const top = flip ? 1 - v0 : v0, bot = flip ? 1 - v0 - dv : v0 + dv;
    UV.setXY(0, u0, top); UV.setXY(1, u0 + du, top); UV.setXY(2, u0 + du, bot); UV.setXY(3, u0, bot);
    UV.needsUpdate = true;
  }

  private culled = false;
  /** any non-persistent layer still has quads on screen or is yet to start (Hmk_* budget) */
  hasTransient(): boolean {
    return !this.culled && this.layers.some((L) => L.p.life < 1e6 && (L.live.length > 0 || !L.started));
  }
  /** drop the short-lived layers (quads out now, no new emits); persistent decal layers are untouched */
  cullTransient(): void {
    this.culled = true;
    for (const L of this.layers) {
      if (L.p.life >= 1e6) continue;
      for (const l of L.live) releaseQuad(L.p, l);
      L.live = [];
    }
  }

  dispose(): void {
    for (const L of this.layers) {
      for (const l of L.live) releaseQuad(L.p, l);
      L.live = []; // L.mat is the shared layerMaterialOf material: kept
    }
    for (const s of this.baked) s.batch.remove(s);
    this.baked = [];
    this.group.removeFromParent();
  }
}

// ---- strips: tracer (type 0) and bullet smoke (type 6) ------------------------------------------------------------
interface Strip {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  from: THREE.Vector3;
  dir: THREE.Vector3;
  len: number;
  tail: number;
  head: number;
  age: number;
  kind: "tracer" | "smoke" | "piece";
  smoke?: BulletSmoke;
  /** thrown-item trail piece: width, start alpha 0..1, life (s) */
  piece?: { w: number; a: number; life: number };
}

/**
 * Strip geometries and bullet-smoke materials are recycled: a burst made one BufferGeometry + one cloned material per shot and
 * disposed both 0.2 s later, so every shot re-created GPU buffers and, once the last smoke strip of a pause died, three.js
 * released the material's program and recompiled it on the next burst (a stall at the start of every burst).
 * stripUV rewrites the UVs and update() the opacity on reuse.
 */
const STRIP_GEO_POOL: THREE.BufferGeometry[] = [];
const SMOKE_MAT_POOL: THREE.MeshBasicMaterial[] = [];
const STRIP_POOL_MAX = 32;
function takeStripGeometry(): THREE.BufferGeometry {
  const pooled = STRIP_GEO_POOL.pop();
  if (pooled) return pooled;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(QUAD.slice(), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setAttribute("color", rgbaAttribute()); // trail pieces: alpha per piece (setCorners)
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}
function releaseStrip(s: Strip): void {
  if (STRIP_GEO_POOL.length < STRIP_POOL_MAX) STRIP_GEO_POOL.push(s.mesh.geometry); else s.mesh.geometry.dispose();
  if (s.kind !== "smoke") return; // tracer and trail-piece materials are shared
  if (SMOKE_MAT_POOL.length < STRIP_POOL_MAX) SMOKE_MAT_POOL.push(s.mat); else s.mat.dispose();
}

function stripMesh(mat: THREE.MeshBasicMaterial, s: Strip): THREE.Mesh {
  const g = takeStripGeometry();
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  m.matrixAutoUpdate = false;
  m.renderOrder = 6;
  // i3Billboard tail (a) -> head (b), corners 0/1 at the tail. i3BillboardAttr::ApplyAlwaysUpdate (i3SceneDx 0x100e2180):
  // side = normalize(cross(end - start, view axis)), the view axis being the inverse view matrix Z row
  // (SetInverseViewMatrix 0x100a8980), not the eye -> point vector; corners = start/end -+ side * Size / 2 (0x100e1fe0)
  m.onBeforeRender = (_r, _s, cam) => {
    const a = _a.copy(s.from).addScaledVector(s.dir, s.tail), b = _b.copy(s.from).addScaledVector(s.dir, s.head);
    const viewZ = _c.setFromMatrixColumn(cam.matrixWorld, 2);
    const w = s.kind === "tracer" ? stripWidth.tracer : s.piece ? s.piece.w : (s.smoke!.thickness + (s.smoke!.grow - s.smoke!.thickness) * Math.min(1, s.age / Math.max(1e-3, s.smoke!.life)));
    const side = _v.crossVectors(_q2.subVectors(b, a), viewZ).normalize().multiplyScalar(-w);
    setBasis(m, null, side, _q2.subVectors(a, b), _q3.addVectors(a, b).multiplyScalar(0.5));
  };
  return m;
}
/** bullet smoke: the texture repeats every RepeatTexSize along the trail */
function stripUV(s: Strip) {
  if (s.kind !== "smoke") return;
  const UV = s.mesh.geometry.attributes.uv as THREE.BufferAttribute, rep = (s.head - s.tail) / Math.max(0.01, s.smoke!.repeat);
  UV.setXY(0, 0, 0); UV.setXY(1, 1, 0); UV.setXY(2, 1, rep); UV.setXY(3, 0, rep);
  UV.needsUpdate = true;
}
const stripWidth = { tracer: 0.2 };
/** weaponfx tracerType of a thrown item -> weaponfx globals key prefix (pef TracerType HAND_GRENADE / SMOKE / FLASH) */
const TRAIL_KEY: Record<number, string> = { 1: "TracerHandGrenade", 4: "TracerSmoke", 5: "TracerFlash" };
/** trail piece material per (texture, colour): the piece's alpha is its strip's vertex alpha (setCorners), so a trail shares one */
const TRAIL_MATS = new Map<string, THREE.MeshBasicMaterial>();
function trailMaterial(tex: string, c: number[]): THREE.MeshBasicMaterial {
  const key = `${tex}|${c[0]},${c[1]},${c[2]}`;
  let m = TRAIL_MATS.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ map: fxTexture(tex), transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, vertexColors: true });
    m.color.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
    TRAIL_MATS.set(key, m);
  }
  return m;
}

const shellMeshes = new Map<string, THREE.Object3D | null>();
const shellLoads = new Map<string, Promise<THREE.Object3D | null>>();
const shellName = (i3s: string | undefined): string | undefined => i3s?.split(/[\\/]/).pop()?.replace(/\.[^.]*$/, "").toLowerCase();
function loadShellMesh(name: string): Promise<THREE.Object3D | null> {
  let p = shellLoads.get(name);
  if (!p) {
    p = new GLTFLoader().loadAsync(`/assets/weapons/fx/mesh/${name}.glb`).then((gltf) => { shellMeshes.set(name, gltf.scene); return gltf.scene; }, () => null);
    shellLoads.set(name, p);
  }
  return p;
}
/** exported Effect/H/<name>.i3s (weapons/fx/mesh/<name>.glb), loaded on first use (or by preloadFx); null until then / when missing */
function shellMesh(i3s: string | undefined): THREE.Object3D | null {
  const name = shellName(i3s);
  if (!name) return null;
  if (!shellMeshes.has(name)) {
    shellMeshes.set(name, null);
    void loadShellMesh(name);
  }
  return shellMeshes.get(name) ?? null;
}

/** the warm-up quads' geometry: one for the session (a new one per match stayed on the GPU after the match) */
let fxProbeGeo: THREE.PlaneGeometry | null = null;
/**
 * Match preload (game/matchPreload.ts): the effects a match can play for these weapons (fire / 1PV fire, impact and bullet hole
 * of their hit category on every surface, blood, casing, laser dot), the tracer / bullet smoke / trail strips and the casing
 * meshes, with every texture decoded. Each of these loaded on its first use: 11 textures and the casing GLB on the first shot.
 * Returns one small mesh per distinct layer material and the casings, for the shader / texture warm-up (render/warmup.ts):
 * remove them from the scene afterwards without disposing (the materials are the shared ones).
 */
export async function preloadFx(weapons: { id: number; family: Family }[], extra: Iterable<string> = []): Promise<THREE.Object3D[]> {
  const d = weaponFx();
  if (!d) return [];
  // `extra`: the break effects of the map's props (def.breakEffects)
  const names = new Set(["ExpHu01_1", "Env_TargetLaser_01", "Exp_Sm_01", "Exp_WPSm_01", "Medical_Kit_Medic_01", ...extra]);
  const cats = new Set<string>();
  for (const w of weapons) {
    const info = weaponFxInfo(w.id);
    if (info?.fire) names.add(info.fire);
    if (info?.fire1st) names.add(info.fire1st);
    if (SHELL_FX[w.family]) names.add(SHELL_FX[w.family]!);
    cats.add(HIT_CAT[w.family] ?? "Ar");
  }
  for (const n of Object.keys(d.effects)) for (const c of cats) if (n.startsWith(`Hit_${c}_`) || n.startsWith(`Hmk_${c}_`)) names.add(n);
  const out: THREE.Object3D[] = [];
  const waits: Promise<unknown>[] = [];
  const geo = fxProbeGeo ?? (fxProbeGeo = new THREE.PlaneGeometry(0.01, 0.01));
  if (!geo.attributes.color) geo.setAttribute("color", rgbaAttribute()); // the layer materials read vertex colours
  const quad = (m: THREE.MeshBasicMaterial) => {
    const q = new THREE.Mesh(geo, m);
    q.frustumCulled = false;
    out.push(q);
    const ready = m.map ? texLoaded.get(m.map) : undefined;
    if (ready) waits.push(ready);
  };
  for (const n of names) {
    for (const p of d.effects[n]?.particles ?? []) {
      if (p.type === "mesh") {
        const s = shellName(typeof p.mesh === "string" ? p.mesh : undefined);
        if (s) waits.push(loadShellMesh(s).then((m) => { if (m) out.push(m.clone()); }));
      } else if (p.tex) quad(layerMaterialOf(p));
    }
  }
  const g = d.globals;
  for (const k of ["TracerBullet", "TracerBulletSmoke", "TracerGrenade"]) {
    const t = g.tex[k];
    if (!t) continue;
    const m = new THREE.MeshBasicMaterial({ map: fxTexture(t), transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
    if (k === "TracerBulletSmoke") m.map!.wrapT = THREE.RepeatWrapping;
    quad(m);
  }
  // trail pieces (thrown items): their material is made on the first piece; warm it up with the same vertex-colour program
  for (const key of Object.values(TRAIL_KEY)) {
    const t = g.tex[String(g[`${key}EffectFile`] ?? "")];
    if (t) quad(trailMaterial(t, (g[`${key}Color`] as number[] | undefined) ?? [255, 255, 255, 200]));
  }
  await Promise.all(waits);
  return out;
}

interface Timed {
  obj: THREE.Object3D;
  life: number;
  max: number;
  update?(t: number, dt: number): void;
}

/**
 * Per-triangle terrain surface (0x6900b0 / 0x6902f0, class table 0xba8a48): pb-extract-tools export-surfaces.mjs reads each
 * map's i3PhysixShapeSet names (collision.json `shapes[]`, real 2017 authoring tags: CCR/MET/GLASS/WOOD/PLASTIC/
 * MARB/PAP/RUB/CLOTH/GND/GRASS/WATER/CLAY/LEAF) into public/assets/maps/<map>/surfaces.json, one code per shape
 * (shape-level, not per-triangle: the cooked PhysX "NXS\x01MESH" blob's own material index was not decoded).
 * Codes match the suffixes actually present in weaponfx.json's Hit_<cat>_<code> / Hmk_<cat>_<code> effects
 * (Cm/Co/Gl/Mb/Me/Pa/Pl/So/Wo + Hmk-only) [RECRIADO/INFERIDO] mapping from shape name to code.
 */
export interface SurfaceTable {
  byIndex: string[];
  byName: Record<string, string>;
  /**
   * [I3_TERRAIN_TYPE, thickness] of each shape, parallel to byIndex: the shape set's _tagi3PhysixTerrainInfo array
   * (i3MemoryBuffer, 24-byte entries: u16 type at +0, int thickness at +8; every entry of one shape agrees in all 80 maps).
   * Read by the bullet wall test 0x60a950 (penetration.ts). null = the pack could not be matched.
   */
  terrain?: ([number, number] | null)[];
}
let surfaceTable: SurfaceTable | null = null;
let surfaceMapUrl = "";
/** Loads <map>/surfaces.json once per map (headless/tests: pass the parsed json directly to setSurfaceTable). */
export function loadSurfaceTable(mapAssetBase: string): Promise<SurfaceTable | null> {
  const url = `${mapAssetBase.replace(/\/$/, "")}/surfaces.json`;
  if (url === surfaceMapUrl) return Promise.resolve(surfaceTable);
  surfaceMapUrl = url;
  return fetch(url)
    .then((r) => (r.ok ? (r.json() as Promise<SurfaceTable>) : null))
    .then((t) => (surfaceTable = t))
    .catch(() => (surfaceTable = null));
}
export function setSurfaceTable(t: SurfaceTable | null): void {
  surfaceTable = t;
}
/**
 * Surface code ("Cm" default) of a raycast hit against the map collision: `shapeName` is the i3PhysixShapeSet /
 * collision.glb node name (Rapier has no per-collider userData, so the caller resolves the collider's handle to
 * that name off its own handle->name map, e.g. realLevel.ts at load time) and `shapeIndex` its position in
 * collision.json `shapes[]` when the name alone is ambiguous (duplicate shape names are common, e.g.).
 */
export function surfaceForShape(shapeName?: string | null, shapeIndex?: number): string {
  if (!surfaceTable) return "Cm";
  if (typeof shapeIndex === "number" && surfaceTable.byIndex[shapeIndex]) return surfaceTable.byIndex[shapeIndex];
  if (shapeName && surfaceTable.byName[shapeName]) return surfaceTable.byName[shapeName];
  return "Cm";
}

/**
 * Rapier collider handle -> map collision shape (collision.glb mesh node = collision.json shapes[i], same order in all
 * 80 maps). Filled by the level loader; resolved through surfaces.json at hit time (the table may load later).
 */
const colliderShapes = new Map<number, { name: string; index: number }>();
export function registerColliderShape(handle: number, shapeName: string, shapeIndex: number): void {
  colliderShapes.set(handle, { name: shapeName, index: shapeIndex });
}
export function clearColliderShapes(): void {
  colliderShapes.clear();
  colliderTriCount.clear();
  colliderGroups.clear();
}
/** key of the shapes that may share one collider: same surface code and same terrain entry (mapCollision.ts); needs the table loaded */
export function shapeGroupKey(shapeName: string, shapeIndex: number): string {
  return `${surfaceForShape(shapeName, shapeIndex)}|${JSON.stringify(surfaceTable?.terrain?.[shapeIndex] ?? null)}`;
}
/**
 * A collider merged from several map shapes (mapCollision.ts): triangle ranges [start, end) in the trimesh, each with the
 * shape's index (identity for) and whether it is a one-sided walk shape (see registerColliderTriangles).
 */
interface ShapeRange { start: number; end: number; index: number; walk: boolean }
const colliderGroups = new Map<number, { tris: number; ranges: ShapeRange[] }>();
export function registerColliderGroup(handle: number, triangleCount: number, ranges: ShapeRange[]): void {
  colliderGroups.set(handle, { tris: triangleCount, ranges });
}
function rangeOf(g: { tris: number; ranges: ShapeRange[] }, tri: number): ShapeRange | null {
  let lo = 0, hi = g.ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, r = g.ranges[mid];
    if (tri < r.start) hi = mid - 1;
    else if (tri >= r.end) lo = mid + 1;
    else return r;
  }
  return null;
}
/** the same wall? ids of the original shape a hit landed on (a merged collider holds many shapes; others are their own) */
export function hitShapeId(handle: number, featureId: number | undefined): string {
  const g = colliderGroups.get(handle);
  if (!g || featureId === undefined || featureId < 0 || featureId >= 2 * g.tris) return `${handle}`;
  const r = rangeOf(g, featureId % g.tris);
  return r ? `${handle}:${r.index}` : `${handle}`;
}
/** surface code of a world collider ("Cm" for props / unknown colliders) */
export function surfaceOfCollider(handle: number): string {
  const s = colliderShapes.get(handle);
  return s ? surfaceForShape(s.name, s.index) : "Cm";
}

/** terrain type + thickness of a map collider (surfaces.json `terrain`); null for props / unknown colliders / old tables */
export function terrainOfCollider(handle: number): { type: number; thickness: number } | null {
  const s = colliderShapes.get(handle);
  const t = s && surfaceTable?.terrain?.[s.index];
  return t ? { type: t[0], thickness: t[1] } : null;
}

/**
 * Triangle counts of the map colliders a bullet can go through (TH_* / GLASS_* / WR_* shapes, their window panes).
 * PhysX 2.8 casts rays one-sided (no NX_MESH_DOUBLE_SIDED): a ray crossing a closed thin wall meets one of its two faces.
 * Rapier meets both; parry reports a hit on a triangle's back side as Face(triangle + triangle count), so hitSide tells
 * the two apart and the wall walk drops the second face of the wall it just went through. The exported winding is not
 * the same in every mesh (186 TH_ / WR_ meshes wound outward, 129 inward), so the side is compared, never assumed.
 */
const colliderTriCount = new Map<number, number>();
export function registerColliderTriangles(handle: number, triangleCount: number): void {
  colliderTriCount.set(handle, triangleCount);
}
/** which side of its triangle a ray hit on a registered collider (featureId of the hit); null when unknown */
export function hitSide(handle: number, featureId: number | undefined): "front" | "back" | null {
  const grp = colliderGroups.get(handle);
  if (grp) {
    if (featureId === undefined || featureId < 0 || featureId >= 2 * grp.tris) return null;
    const r = rangeOf(grp, featureId % grp.tris);
    return r?.walk ? (featureId < grp.tris ? "front" : "back") : null;
  }
  const n = colliderTriCount.get(handle);
  if (n === undefined || featureId === undefined || featureId < 0 || featureId >= 2 * n) return null;
  return featureId < n ? "front" : "back";
}

/** weapon family -> effect category of the terrain tables (0x6900b0 / 0x6902f0, class table 0xba8a48) */
const HIT_CAT: Partial<Record<Family, string>> = { SG: "Sg", KNIFE: "M9" };
/** weapon family -> shell effect (WeaponBase::Create 0x603c70) */
const SHELL_FX: Partial<Record<Family, string>> = {
  HG: "Bul_Hg_MK23", AR: "Bul_Ar_M4A1", MG: "Bul_Ar_M4A1", SMG: "Bul_Smg_MP5K", SR: "Bul_Sr_HKPSG1", SG: "Bul_Sg_870MCS",
};

/** Tracers, muzzle flash, impact effects / bullet marks, shells, blood, explosions. */
export class WeaponEffects {
  readonly scene: THREE.Scene;
  private timed: Timed[] = [];
  private fx: FxInstance[] = [];
  private strips: Strip[] = [];
  private pools = new Map<string, FxInstance[]>();
  /** live bullet-hole effects, oldest first (MAX_DECAL_FX budget) */
  private decals: FxInstance[] = [];
  /** live transient (non-persistent) Hmk_* effects, oldest first */
  private transientMarks: FxInstance[] = [];
  /** live Hit_* / Fir_* effects, oldest first (MAX_HITFIR_FX each); localFireFx = the local player's muzzle flashes */
  private hitFx: FxInstance[] = [];
  private fireFx: FxInstance[] = [];
  private localFireFx = new Set<FxInstance>();

  private evict(o: FxInstance): void {
    o.dispose();
    const i = this.fx.indexOf(o);
    if (i >= 0) this.fx.splice(i, 1);
    const d = this.decals.indexOf(o);
    if (d >= 0) this.decals.splice(d, 1);
  }
  private tracerMat: THREE.MeshBasicMaterial | null = null;
  private smokeMat: THREE.MeshBasicMaterial | null = null;
  /** muzzle i3Light: 0x60f840, diffuse (1.4, 1.3, 1.2), range 3. Duration [RECRIADO] 0.05 s. */
  private light = new THREE.PointLight(new THREE.Color(1, 0.93, 0.86), 0, 3, 2);
  private lightT = 0;
  /** weapon of the next fire / impact / shell (WeaponSystem hook) */
  weaponId = 0;
  family: Family = "AR";
  /** 1PV owner: muzzle uses <FireEffect>_1st when it exists (0x623210) */
  firstPerson = true;

  private readonly decalBatcher: DecalBatcher;
  /** drawable meshes of the frozen bullet holes (smoke hook) */
  get decalMeshCount(): number { return this.decalBatcher.meshCount; }

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.decalBatcher = new DecalBatcher(scene);
    scene.add(this.light);
  }

  /** set by WeaponSystem before a shot */
  setWeapon(id: number, family: Family): void {
    this.weaponId = id;
    this.family = family;
  }

  private get data() {
    return weaponFx();
  }

  /** Remove a persistent effect started with play() (its particles never die by themselves). */
  stop(group: THREE.Object3D): void {
    const i = this.fx.findIndex((f) => f.group === group);
    if (i < 0) return;
    this.evict(this.fx[i]);
    for (const pool of this.pools.values()) { const k = pool.findIndex((f) => f.group === group); if (k >= 0) pool.splice(k, 1); }
  }

  /**
   * Round start: every live effect goes, whatever its life (explosion fire and smoke, smoke grenade clouds, bullet holes,
   * blood, shells), and every tracer. Cross _ProcessEvent_RoundStart 0x769040: g_pEffectManager (0xd85db8, set by
   * CGameFramework::OnCreate 0x51e56e) vtable +0xe0 at 0x7690c9 = i3EffectManager::Reset (i3FrameworkDx 0x100d81d0):
   * i3EffectTypeInfo::Reset on each effect type (frees all its live instances) + RemoveAllEmitter. Then
   * CTracerBulletManager 0x5ac710 (0x7690d7) turns every tracer off. A persistent effect its owner still wants back
   * (laser dot, planted C4 light) is played again by that owner.
   */
  reset(): void {
    for (const f of this.fx) { f.dispose(); f.dead = true; }
    this.fx = [];
    this.pools.clear();
    this.decals = [];
    this.transientMarks = [];
    this.hitFx = [];
    this.fireFx = [];
    this.localFireFx.clear();
    for (const t of this.timed) {
      t.obj.parent?.remove(t.obj);
      const mat = (t.obj as THREE.Mesh).material as THREE.Material | undefined;
      if (mat) mat.dispose();
    }
    this.timed = [];
    for (const s of this.strips) { s.mesh.removeFromParent(); releaseStrip(s); }
    this.strips = [];
    this.light.intensity = 0;
    this.lightT = 0;
  }

  /** Play an i3 effect: `parent` (default scene) at `pos`, local +Y along `axis`. Returns null when not exported. */
  play(name: string, pos: THREE.Vector3, axis?: THREE.Vector3, parent: THREE.Object3D = this.scene, spin = 0, tint?: Tint): THREE.Group | null {
    return this.spawnFx(name, pos, axis, parent, spin, tint)?.group ?? null;
  }

  /**
   * Smoke grenade cloud: the item's i3 effect at the grenade, +Y up (WeaponSmoke::Explosion 0x632f90), registered in
   * smokeField for as long as its particles live. Without weaponfx.json: [RECRIADO] a 13 s grey puff of 3 m.
   */
  smokeCloud(name: string, pos: THREE.Vector3): void {
    const inst = this.spawnFx(name, pos, _up);
    if (inst) {
      // the emitters stay "active" for their 100 s EmitterLife: the cloud ends with its last particle
      smokeField.add({ collect: (out) => {
        if (inst.dead) return false;
        const n = out.length;
        inst.collectSmoke(out);
        return out.length > n || inst.age < 1;
      } });
      return;
    }

  }

  private spawnFx(name: string, pos: THREE.Vector3, axis?: THREE.Vector3, parent: THREE.Object3D = this.scene, spin = 0, tint?: Tint): FxInstance | null {
    const def = this.data?.effects[name];
    if (!def) return null;
    const inst = new FxInstance(name, def, 1, tint);
    inst.group.position.copy(pos);
    if (axis && axis.lengthSq() > 1e-8) inst.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _v.copy(axis).normalize());
    if (spin) inst.group.rotateY(spin);
    parent.add(inst.group);
    if (inst.decalOnly && parent === this.scene) inst.batcher = this.decalBatcher;
    inst.update(0);
    if (inst.persistent) {
      // Default.i3FxList Count = pool size (oldest evicted)
      const cap = this.data?.fxList[name]?.count ?? 32;
      const pool = this.pools.get(name) ?? [];
      pool.push(inst);
      while (pool.length > cap) { const o = pool.shift()!; this.evict(o); }
      this.pools.set(name, pool);
      // NOT ORIGINAL: D3D9 draws the whole fxList (up to 64 per surface x 3 layers) cheaply; here each decal layer is a draw
      // call, and 20 shooters filled the pools to ~800 draw calls. Global budget, oldest decal first.
      if (inst.decalOnly) {
        this.decals.push(inst);
        while (this.decals.length > MAX_DECAL_FX) {
          const o = this.decals.shift()!;
          for (const pl of this.pools.values()) { const k = pl.indexOf(o); if (k >= 0) pl.splice(k, 1); }
          this.evict(o);
        }
      }
    }
    if (name.startsWith("Hmk_")) {
      // NOT ORIGINAL ([RECRIADO] ceiling): the short-lived (1-1.5 s) GlowSource layers of the bullet marks are not decals, so
      // MAX_DECAL_FX never counted them; an AUG burst kept ~120 of each Hmk_Ar_Mb / _Cm alive = ~550 draw calls. The original
      // fxList allows ~2500 effects at no cost on D3D9. Past the ceiling the oldest mark loses its transient layers only: its
      // persistent bullet hole stays as it was.
      const t = this.transientMarks;
      for (let i = t.length - 1; i >= 0; i--) if (!t[i].hasTransient()) t.splice(i, 1);
      t.push(inst);
      while (t.length > MAX_TRANSIENT_MARK_FX) t.shift()!.cullTransient();
    }
    // NOT ORIGINAL: ceiling on simultaneous Hit_* / Fir_* effects (same reasoning as MAX_DECAL_FX); oldest dies first, the
    // local player's own muzzle flash (Fir_ with firstPerson) is never culled while another shooter's is available.
    const kind = name.startsWith("Hit_") ? this.hitFx : name.startsWith("Fir_") ? this.fireFx : null;
    if (kind) {
      const mine = kind === this.fireFx && this.firstPerson;
      if (mine) this.localFireFx.add(inst);
      for (let i = kind.length - 1; i >= 0; i--) if (kind[i].dead || !this.fx.includes(kind[i])) { this.localFireFx.delete(kind[i]); kind.splice(i, 1); }
      kind.push(inst);
      while (kind.length > MAX_HITFIR_FX) {
        const k = kind.findIndex((f) => !this.localFireFx.has(f));
        if (k < 0) break;
        const [o] = kind.splice(k, 1);
        this.evict(o);
      }
    }
    this.fx.push(inst);
    return inst;
  }

  /** live non-persistent Hmk_* effects (MAX_TRANSIENT_MARK_FX budget; smoke hook) */
  get transientMarkCount(): number {
    return this.transientMarks.filter((f) => f.hasTransient()).length;
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const d = this.data;
    const len = from.distanceTo(to);
    if (!d?.globals.tex.TracerBullet) return;
    const g = d.globals;
    const dir = to.clone().sub(from).normalize();
    // bullet smoke (type 6) — same random branch as the tracer (0x60f42c)
    const rate = g.TracerBulletRate ?? 50;
    const sniper = this.family === "SR";
    if (!sniper && Math.random() * 100 >= rate) return;
    if (len > 0.5) {
      this.tracerMat ??= new THREE.MeshBasicMaterial({ map: fxTexture(g.tex.TracerBullet!), transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
      stripWidth.tracer = g.TracerBulletThickness ?? 0.2;
      const L = Math.min(g.TracerBulletLength ?? 3, len);
      const s: Strip = { mesh: null!, mat: this.tracerMat, from: from.clone(), dir, len, tail: 0, head: L, age: 0, kind: "tracer" };
      s.mesh = stripMesh(this.tracerMat, s);
      this.scene.add(s.mesh);
      this.strips.push(s);
    }
    const sm = weaponFxInfo(this.weaponId)?.smoke;
    if (sm && g.tex.TracerBulletSmoke) {
      if (!this.smokeMat) {
        this.smokeMat = new THREE.MeshBasicMaterial({ map: fxTexture(g.tex.TracerBulletSmoke), transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
        // the texture is shared by every smoke strip: repeat set once (it was re-uploaded to the GPU on every shot)
        const t = this.smokeMat.map!;
        if (t.wrapT !== THREE.RepeatWrapping) { t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; }
      }
      const m = SMOKE_MAT_POOL.pop() ?? this.smokeMat.clone();
      m.color.setRGB(sm.color[0] / 255, sm.color[1] / 255, sm.color[2] / 255, THREE.SRGBColorSpace);
      m.opacity = sm.color[3] / 255;
      const s: Strip = { mesh: null!, mat: m, from: from.clone(), dir, len, tail: 0, head: 0, age: 0, kind: "smoke", smoke: sm };
      s.mesh = stripMesh(m, s);
      this.scene.add(s.mesh);
      this.strips.push(s);
    }
  }

  /**
   * One piece of a thrown item's trail (weapon.pef TracerType HAND_GRENADE / SMOKE / FLASH = weaponfx tracerType 1 / 4 / 5
   * -> globals Tracer<HandGrenade|Smoke|Flash>*: texture, colour, thickness, PieceLifeTime). `from` -> `to` is the
   * path the item covered since the previous piece (PieceCreateTime apart). Returns the piece interval (s), 0 = no trail.
   */
  trailPiece(tracerType: number, from: THREE.Vector3, to: THREE.Vector3): number {
    const g = this.data?.globals;
    const key = TRAIL_KEY[tracerType];
    if (!g || !key) return 0;
    const tex = g.tex[String(g[`${key}EffectFile`] ?? "")];
    const len = from.distanceTo(to);
    const every = Number(g[`${key}PieceCreateTime`] ?? 0.025);
    if (!tex || len < 1e-3) return every;
    const c = (g[`${key}Color`] as number[] | undefined) ?? [255, 255, 255, 200];
    // plain alpha blend: CTracerBulletManager::Create 0x5b0e80 gives only the type 0 bullet billboard SrcBlend 5 / DestBlend 2
    // (additive); types 1-6 get 5 / 6 (SRCALPHA / INVSRCALPHA). TracerGrenade.i3i is white with the shape in its alpha.
    const m = trailMaterial(tex, c);
    const a = c[3] / 255;
    const s: Strip = { mesh: null!, mat: m, from: from.clone(), dir: to.clone().sub(from).divideScalar(len), len, tail: 0, head: len,
      age: 0, kind: "piece", piece: { w: Number(g[`${key}Thickness`] ?? 0.2), a, life: Number(g[`${key}PieceLifeTime`] ?? 0.5) } };
    s.mesh = stripMesh(m, s);
    setCorners(s.mesh.geometry, null, a);
    this.scene.add(s.mesh);
    this.strips.push(s);
    return every;
  }

  /**
   * Flash parented to the viewmodel muzzle (FXDummy, +Y = barrel) or world when parent is the scene. In the world case
   * `axis` is the barrel direction: the effect's +Y must follow it like under the FXDummy, otherwise its quads (planes
   * perpendicular to +Y) lie flat, edge-on to every viewer, and its sparks fly straight up (remote / bot shots showed
   * no flash at all).
   */
  muzzleFlash(parent: THREE.Object3D, worldPos: THREE.Vector3, scale = 1, axis?: THREE.Vector3, tint?: Tint): void {
    const info = weaponFxInfo(this.weaponId);
    const name = (this.firstPerson && info?.fire1st) || info?.fire || "Fir_Ar_M4A1";
    const world = parent === this.scene;
    const local = world ? worldPos : new THREE.Vector3();
    if (this.data) this.play(name, local, world ? axis : undefined, parent, 0, tint);
    this.light.position.copy(worldPos);
    this.light.intensity = 2.5 * scale;
    this.lightT = 0.05;
  }

  /**
   * Bullet hit on the world: Hit_<cat>_<surface> + Hmk_<cat>_<surface>. `dir` = bullet direction (decal at pos - dir*0.008).
   * Surface: surfaceOfCollider() (map shape -> surfaces.json code); "Cm" (the exe's general column) for props / unknown.
   */
  impact(point: THREE.Vector3, normal: THREE.Vector3, decal = true, surface = "Cm", dir?: THREE.Vector3): void {
    if (!this.data) return;
    const cat = HIT_CAT[this.family] ?? "Ar";
    this.play(`Hit_${cat}_${surface}`, point, normal) ?? this.play(`Hit_${cat}_Cm`, point, normal);
    if (decal) {
      const p = dir ? point.clone().addScaledVector(dir, -0.008) : point.clone().addScaledVector(normal, 0.008);
      const spin = Math.random() * Math.PI * 2;
      this.play(`Hmk_${cat}_${surface}`, p, normal, this.scene, spin) ?? this.play(`Hmk_${cat}_Cm`, p, normal, this.scene, spin);
    }
  }

  blood(point: THREE.Vector3, dir?: THREE.Vector3): void {
    if (!getSettings().showBlood) return;
    if (this.data?.effects.ExpHu01_1) {
      this.play("ExpHu01_1", point, dir ? dir.clone().negate() : undefined);
      return;
    }

  }

  /** shell ejection; with weaponfx.json `parent` (EmptyCartridgeFXDummy) carries the effect frame */
  shell(worldPos: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, parent?: THREE.Object3D): void {
    const fxName = SHELL_FX[this.family];
    if (fxName && this.data?.effects[fxName] && parent) {
      // world-space effect with the dummy's orientation (the casing must not follow the gun)
      parent.updateWorldMatrix(true, false);
      const q = parent.getWorldQuaternion(new THREE.Quaternion());
      const g = this.play(fxName, worldPos, undefined, this.scene);
      if (g) {
        g.quaternion.copy(q);
        this.addShellMesh(g, fxName);
        return;
      }
    }

  }

  /** the MESH layer of Bul_* (Effect/H/Assult_Vol.i3s ...): pb-extract-tools export-fxmesh.mjs GLB; the first shot after load skips it */
  private addShellMesh(g: THREE.Group, fxName: string) {
    const mp = this.data!.effects[fxName].particles.find((p) => p.type === "mesh");
    if (!mp) return;
    const src = shellMesh(typeof mp.mesh === "string" ? mp.mesh : undefined);
    if (!src) return;
    const m = src.clone();
    const dir = new THREE.Vector3().fromArray(mp.emitDir).normalize();
    let speed = mp.speed.init, vy = 0, age = 0;
    m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    g.add(m);
    // g carries the eject dummy's orientation: gravity must pull along world -Y, not the dummy's local Y
    const inv = g.quaternion.clone().invert();
    const down = new THREE.Vector3();
    this.add({ obj: m, life: mp.life, max: mp.life, update: (t, dt) => {
      age += dt;
      if (on(mp.accel)) speed = Math.max(0, speed + evalCh(mp.accel, 1 - t, false, 1) * dt);
      m.position.addScaledVector(dir, speed * dt);
      vy += GRAVITY * ((mp.mass[0] + mp.mass[1]) / 2) * GRAVITY_FACTOR * dt;
      m.position.add(down.set(0, vy * dt, 0).applyQuaternion(inv));
      m.rotation.x += 15 * dt;
      m.rotation.z += 9 * dt;
    } });
  }

  private add(t: Timed) {
    if (!t.obj.parent) this.scene.add(t.obj);
    this.timed.push(t);
  }

  update(dt: number): void {
    for (let i = this.timed.length - 1; i >= 0; i--) {
      const e = this.timed[i];
      e.life -= dt;
      if (e.life <= 0) {
        e.obj.parent?.remove(e.obj);
        const mat = (e.obj as THREE.Mesh).material as THREE.Material | undefined;
        if (mat) mat.dispose();
        this.timed.splice(i, 1);
        continue;
      }
      e.update?.(e.life / e.max, dt);
    }
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.update(dt);
      if (f.dead) { f.dispose(); this.fx.splice(i, 1); }
    }
    const g = this.data?.globals;
    for (let i = this.strips.length - 1; i >= 0; i--) {
      const s = this.strips[i];
      s.age += dt;
      let done: boolean;
      if (s.kind === "piece") {
        // CTracerBullet::OnActive types 1-5 (0x5b0643): life -= dt, alpha = Color.a * max(0, life / PieceLifeTime); no move, no resize
        setCorners(s.mesh.geometry, null, s.piece!.a * Math.max(0, 1 - s.age / s.piece!.life));
        done = s.age >= s.piece!.life;
      } else if (s.kind === "tracer") {
        // OnActive 0x5affd0: tail advances at TracerBulletSpeed, head = tail + length clamped to the hit
        s.tail += (g?.TracerBulletSpeed ?? 150) * dt;
        s.head = Math.min(s.len, s.tail + (g?.TracerBulletLength ?? 3));
        done = s.tail >= s.len;
      } else {
        const sm = s.smoke!;
        s.tail = Math.min(s.len, s.tail + sm.startSpeed * dt);
        s.head = Math.min(s.len, s.head + sm.endSpeed * dt);
        s.mat.opacity = (sm.color[3] / 255) * Math.max(0, 1 - s.age / Math.max(1e-3, sm.life));
        done = s.age >= sm.life;
      }
      stripUV(s);
      if (done) {
        s.mesh.removeFromParent();
        releaseStrip(s);
        this.strips.splice(i, 1);
      }
    }
    if (this.lightT > 0) {
      this.lightT -= dt;
      if (this.lightT <= 0) {
        this.light.intensity = 0;
        this.light.distance = 3;
      }
    }
  }
}
