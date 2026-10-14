import * as THREE from "three";
import type { GLTF, GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type RAPIER from "@dimforge/rapier3d-compat";
import { cloneGltf, loadGltfShared } from "../levelCache";
import type { ObjectiveSide } from "./objectives.ts";
import { createPbMtl, pbCharaMaterial, pbWorldMaterial, queryLightVolume, type PbMtl } from "../render/pbLighting";

/**
 * GINS object instances of the map (vending machines, billboards, glass...): public/assets/maps/<map>/props.json and
 * public/assets/objects/<id>.glb, written by pb-extract-tools export-props.mjs from the 2017 client packs.
 *
 * Every object GLB is in object-local three.js space; the instance TRS (i3 world == three world) places it. Repeated
 * objects are drawn with one InstancedMesh per GLB mesh. Lighting is the PB one (render/pbLighting.ts): materials with
 * an i3LuxMap (uv1) use the lightmapped world shader (Phong_DLX_Dir_), the others the object/chara shader
 * (Phong_D_Dir_) with the light-volume colour sampled at the instance (static objects: sampled once at load).
 *
 * Collision: the objects' own i3PhysixShapeSet (NX boxes, in props.json) become fixed Rapier cuboids; the map
 * collision (<Map>_Col) does not contain them. Collision-only geometry of the map (invisible walls) stays as it is.
 * Destructible props (`def.breakable`, i3Obj stateCount > 1): damage(handle, dmg) takes life off; at 0 the intact model is
 * hidden (instance zeroed / Object3D hidden), the broken state model (def.brokenStates[0], <id>_s1.glb) is shown when the
 * object has one (else the prop just vanishes) and the colliders are swapped for the broken state's own collision (none for
 * glass: bullets and players pass). The map collision (<Map>_Col) also carries copies of those windows / boards as GLASS_* and thin TH_* shapes
 * (hospital GLASS_01, downtown TH_WOOD_): claimPanes() hands the triangles lying inside a breakable prop's box to that prop, so
 * they leave with it. Effect / sound are the i3Obj's (def.breakEffects / breakSounds), played by the caller
 * through onBreak. reset() puts everything back (round start). Local only: MapStructure.xml NeedSync (net) is not sent yet.
 */

/** [INFERIDO] slack (m) around a prop's collision box when matching the map's GLASS_* pane triangles to it */
const PANE_MARGIN = 0.3;

/** a piece of the map collision (window pane, thin board / rail) that belongs to one or more breakable props */
export interface MapPane {
  vertices: Float32Array;
  indices: Uint32Array;
  /** called with each collider built for the pane and its triangle count (effects.ts registerColliderTriangles) */
  register: (c: RAPIER.Collider, triangles: number) => void;
  owners: MapProp[];
  collider: RAPIER.Collider | null;
}

export interface PropBox {
  center: [number, number, number];
  quat: [number, number, number, number];
  half: [number, number, number];
}

/** one i3ActionPlaySound of an i3TimeEventGen (pb-extract-tools export-props.mjs readStateSounds): the object's own i3SoundPlayInfo */
export interface PropSound {
  /** lower-case wav under `<weapons>/sfx/objects/` */
  clip: string;
  /** seconds after the state starts (the TimeEventInfo time) */
  t: number;
  /** SoundPlayInfo style LoopMode 1: the clip repeats while the state lasts */
  loop: boolean;
  /** clip length (s), written by pb-extract-tools export-break-sfx.mjs */
  dur?: number;
  vol: number;
  lvol: number;
  min: number;
  max: number;
}

/** the i3TimeEventGen of one object state: state 0 = intact (ambient), state k = what plays when the object enters state k */
export interface PropStateSound {
  /** the generator repeats every `cycle` s (stormtube subway: 40 / 60 s) [INFERIDO flag meaning] */
  cycle: number | null;
  sounds: PropSound[];
}

export interface PropBrokenDef {
  state: number;
  glb: string;
  collision?: PropObjectDef["collision"];
}

export interface PropObjectDef {
  id: string;
  glb?: string;
  bounds?: { min: [number, number, number]; max: [number, number, number] };
  /** Effect_High .i3s stems (weaponfx.json) and Sound_Object_* wav paths of the i3ActionEmitEffect / i3ActionPlaySound */
  breakEffects?: string[];
  breakSounds?: string[];
  /** sounds per object state (ambient loops of state 0, break sound of the later states) */
  stateSounds?: PropStateSound[];
  /** i3ActionExplosion of barrels / cars: area damage to other props when it breaks [INFERIDO field order] */
  explosion?: { damage: number; range: number } | null;
  /** models of the states after the intact one; none = the object vanishes when broken */
  brokenStates?: PropBrokenDef[];
  life: number | null;
  stateCount: number | null;
  breakable: boolean;
  states: string[];
  lightmapped?: boolean;
  collision?: { kind: "boxes"; boxes: PropBox[] } | { kind: "visual" | "none"; source?: string };
  /** embedded i3Animation of the model (CH47 hover + rotors), exported as the GLB clip `clip`: played in a loop */
  animated?: { clip: string; loop: boolean; bones: string[] };
  error?: string;
}

export interface PropNet {
  index: number;
  needSync: boolean;
  animation: number;
  life: number;
}

export interface PropInstanceJson {
  name: string;
  object: string;
  pos: [number, number, number];
  quat: [number, number, number, number];
  scale: [number, number, number];
  net?: PropNet;
  /** Destroy objective: the colour of the side that defends it (blue = CT, red = FR); see objectives.ts */
  objective?: ObjectiveSide;
}

export interface MapPropsJson {
  source: string;
  objects: Record<string, PropObjectDef>;
  props: PropInstanceJson[];
  server?: { mapId: number | null; matchedByOrder?: boolean };
}

export interface MapProp {
  index: number;
  name: string;
  def: PropObjectDef;
  matrix: THREE.Matrix4;
  /** server object (MapStructure.xml) when the instance maps onto one */
  net: PropNet | null;
  /** Destroy objective (Transformer / helicopter_uh60, Helispot heli): never breaks by a local hit, its life is the server's bar */
  objective: ObjectiveSide | null;
  /** current life, starts at the .i3Obj life (server Life overrides when mapped and >= 0) */
  life: number | null;
  colliders: RAPIER.Collider[];
  /** map-collision GLASS_* / TH_* pieces claimed by this prop (see claimPanes): solid while every owner is intact */
  panes: MapPane[];
  broken: boolean;
  /** world-space centre of the intact model (effect / sound position) */
  center: THREE.Vector3;
  /** where the instance is drawn: its own Object3D, or an index into the def's InstancedMeshes */
  object3d: THREE.Object3D | null;
  instanced: { meshes: THREE.InstancedMesh[]; index: number } | null;
}

export interface PropHit {
  prop: MapProp;
  /** true when this hit took the last life: the prop is now in its broken state */
  broke: boolean;
}

export interface LoadedMapProps {
  group: THREE.Group;
  props: MapProp[];
  debugMeshes: THREE.Mesh[];
  /** damage to the breakable prop owning this collider handle; null when the collider is not a breakable prop */
  damage(handle: number, dmg: number): PropHit | null;
  /** explosion at `pos`: every intact breakable prop whose centre is within `radius` takes dmg * (1 - slope * d / radius); slope 1 = linear [INFERIDO], the C4 passes its 0.01 */
  blast(pos: THREE.Vector3, radius: number, dmg: number, slope?: number): void;
  /** a sound of the intact state of a prop is due (loop: every clip length; cycle: at its time of the repeating generator) */
  onAmbient: ((p: MapProp, s: PropSound) => void) | null;
  /** advance the looping model animations (rotors...) */
  update(dt: number): void;
  /** every prop back to its intact state (round start) */
  reset(): void;
  /**
   * Map-collision triangles (world space) of a GLASS_* / TH_* shape. A connected piece whose vertices all lie inside the boxes
   * (+PANE_MARGIN) of breakable props (a rail across two windows) belongs to every prop it touches; otherwise the triangles whose 3
   * vertices lie in one prop's box belong to that prop. A piece is solid while all its owners are intact (removed on break,
   * rebuilt on reset; `register` runs for each collider built).
   * Returns the triangles no prop claimed, for the caller's own static collider.
   */
  claimPanes(vertices: Float32Array, indices: Uint32Array, register: (c: RAPIER.Collider, triangles: number) => void): Uint32Array;
  /** break a prop by index (the same break another player made); no-op when already broken */
  breakIndex(index: number): void;
  /** a bullet hit an objective (prop.objective) of the enemy side: game.ts sends it to the match host (ObjectType.Object) */
  onObjectiveHit: ((p: MapProp, dmg: number) => void) | null;
  /** the server's bar of an objective (5167 GENERATOR_INFO): 0 breaks it (effect + sound, onBreak remote) */
  setObjectiveLife(index: number, life: number): void;
  /** called once per prop the moment it breaks (effect + sound); `remote` = came from breakIndex */
  onBreak: ((p: MapProp, remote: boolean) => void) | null;
}

/** geometry + object-local matrix of a model mesh, kept apart from the scene graph (its matrixWorld changes once parented) */
interface MeshSnap {
  geometry: THREE.BufferGeometry;
  matrixWorld: THREE.Matrix4;
}
const snap = (m: THREE.Mesh): MeshSnap => ({ geometry: m.geometry, matrixWorld: m.matrixWorld.clone() });

/** replay period of a looping clip whose length is unknown (pb-extract-tools export-break-sfx.mjs writes `dur`) */
const LOOP_FALLBACK = 5;

/** editor marker model of the sound-only objects (Cargoship_Engine / _Sea): not drawn [INFERIDO] */
const isMarker = (def: PropObjectDef | undefined): boolean => /sound_sign/i.test(def?.states?.[0] ?? "");

let current: LoadedMapProps | null = null;

/** the sound the i3Obj plays when it enters a broken state (the first sound of the TimeEventGens after the intact one) */
const breakSound = (def: PropObjectDef): PropSound | undefined => def.stateSounds?.slice(1).flatMap((s) => s.sounds)[0];

/**
 * Sound a breaking prop plays (file under `<weapons>/sfx/objects/`): the i3Obj's i3ActionPlaySound of the broken state, else the
 * explosion class of a barrel / car, else the glass break [INFERIDO]. Game.propBroken plays it, preloadMatch loads it
 *.
 */
export function propBreakSound(def: PropObjectDef): string | undefined {
  return (def.stateSounds ? breakSound(def)?.clip : def.breakSounds?.[0]?.split(/[\\/]/).pop()?.toLowerCase())
    ?? (def.explosion ? (/car/i.test(def.id) ? "ob_car_big_explosion.wav" : "ob_drum_explosion.wav") : undefined)
    ?? (/glass/i.test(def.id) || def.breakEffects?.some((n) => /^Exp_Gl/i.test(n)) ? "ob_glass_big_explosion.wav" : undefined);
}

/** the object's own i3SoundPlayInfo data of a sound, for WeaponAudio PlayOpts.info */
export const propSoundInfo = (s: PropSound): { min: number; max: number; vol: number; lvol: number } => ({ min: s.min, max: s.max, vol: s.vol, lvol: s.lvol });

/** data of the break sound (undefined for the [INFERIDO] fallback clips: the lists name those) */
export const propBreakInfo = (def: PropObjectDef) => { const s = def.stateSounds && breakSound(def); return s ? propSoundInfo(s) : undefined; };

/** every clip a prop can play (preloadMatch) */
export const propSoundFiles = (def: PropObjectDef): string[] =>
  [...new Set([propBreakSound(def), ...(def.stateSounds?.flatMap((s) => s.sounds.map((x) => x.clip)) ?? [])])].filter((f): f is string => !!f);

/** The props of the loaded map (null before load / when the map has no props.json). */
export function currentMapProps(): LoadedMapProps | null {
  return current;
}

const instMatrix = (p: PropInstanceJson): THREE.Matrix4 =>
  new THREE.Matrix4().compose(new THREE.Vector3(...p.pos), new THREE.Quaternion(...p.quat).normalize(), new THREE.Vector3(...p.scale));

function pbMaterial(src: THREE.Material, mtl: PbMtl, done: Map<THREE.Material, THREE.Material>): THREE.Material {
  let m = done.get(src);
  if (!m) {
    const s = src as THREE.MeshStandardMaterial;
    m = s.userData?.lightMap && s.aoMap ? pbWorldMaterial(s) : pbCharaMaterial(s, mtl, true);
    done.set(src, m);
  }
  return m;
}

/** Light-volume colour averaged over the instances (one material state per object def) [RECRIADO for instancing]. */
function staticMtl(instances: PropInstanceJson[]): PbMtl {
  const mtl = createPbMtl();
  const sum = new THREE.Vector3(), c = new THREE.Vector3(), feet = new THREE.Vector3();
  for (const p of instances) sum.add(queryLightVolume(feet.set(...p.pos), c));
  sum.multiplyScalar(1 / Math.max(1, instances.length));
  mtl.diffuse.value.set(sum.x, sum.y, sum.z, 1);
  return mtl;
}

export async function loadMapProps(
  url: string,
  loader: GLTFLoader,
  world: RAPIER.World,
  RAPIER_MOD: typeof RAPIER
): Promise<LoadedMapProps | null> {
  let json: MapPropsJson;
  try {
    const r = await fetch(url);
    if (!r.ok || (r.headers.get("content-type") ?? "").includes("text/html")) return (current = null);
    json = (await r.json()) as MapPropsJson;
  } catch {
    return (current = null);
  }

  const group = new THREE.Group();
  group.name = "mapProps";
  const order = new Map(json.props.map((p, i) => [p, i]));
  const byDef = new Map<string, PropInstanceJson[]>();
  for (const p of json.props) {
    const list = byDef.get(p.object);
    if (list) list.push(p);
    else byDef.set(p.object, [p]);
  }
  const gltfs = new Map<string, GLTF>();
  await Promise.all(
    [...byDef.keys()].map(async (id) => {
      const def = json.objects[id];
      if (!def?.glb || isMarker(def)) return;
      try {
        gltfs.set(id, cloneGltf(await loadGltfShared(loader, def.glb))); // shared geometry / textures, own node tree (levelCache.ts)
      } catch (err) {
        console.warn("mapProps: failed to load", def.glb, err);
      }
    })
  );

  const brokenGltfs = new Map<string, GLTF>();
  const brokenSnaps = new Map<string, MeshSnap[]>();
  await Promise.all(
    [...byDef.keys()].map(async (id) => {
      const b = json.objects[id]?.brokenStates?.[0];
      if (!b?.glb) return;
      try {
        const g = cloneGltf(await loadGltfShared(loader, b.glb));
        g.scene.updateMatrixWorld(true);
        const ms: THREE.Mesh[] = [];
        g.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) ms.push(o as THREE.Mesh); });
        brokenSnaps.set(id, ms.map(snap));
        brokenGltfs.set(id, g);
      } catch (err) {
        console.warn("mapProps: failed to load", b.glb, err);
      }
    })
  );

  const body = world.createRigidBody(RAPIER_MOD.RigidBodyDesc.fixed());
  const byHandle = new Map<number, MapProp>();
  const defCtx = new Map<string, { mtl: PbMtl; done: Map<THREE.Material, THREE.Material>; meshes: MeshSnap[] }>();
  const props: MapProp[] = [];
  const mixers: THREE.AnimationMixer[] = [];
  /** intact-state sounds: `t` = clock time of the next play, `every` = replay period (loop: the clip length, cycle: the generator's) */
  const ambient: { prop: MapProp; s: PropSound; t: number; every: number; cycle: boolean }[] = [];
  let clock = 0;
  const debugMeshes: THREE.Mesh[] = [];
  const debugMat = new THREE.MeshBasicMaterial({ color: 0x00ffff, wireframe: true });
  const boxGeo = new THREE.BoxGeometry(2, 2, 2);

  /** Rapier colliders of an NX collision description placed by matrix M (boxes, or the visual triangles of `meshes`). */
  const buildColliders = (col: PropObjectDef["collision"], M: THREE.Matrix4, meshes: MeshSnap[], name: string, debug: THREE.Mesh[] | null): RAPIER.Collider[] => {
    const colliders: RAPIER.Collider[] = [];
    const pos = new THREE.Vector3(), rot = new THREE.Quaternion(), scl = new THREE.Vector3();
    M.decompose(pos, rot, scl);
    if (col?.kind === "boxes") {
      for (const b of col.boxes) {
        const c = new THREE.Vector3(...b.center).applyMatrix4(M);
        const q = rot.clone().multiply(new THREE.Quaternion(...b.quat));
        const h = new THREE.Vector3(...b.half).multiply(new THREE.Vector3(Math.abs(scl.x), Math.abs(scl.y), Math.abs(scl.z)));
        const desc = RAPIER_MOD.ColliderDesc.cuboid(h.x, h.y, h.z).setTranslation(c.x, c.y, c.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
        colliders.push(world.createCollider(desc, body));
        if (debug) {
          const dbg = new THREE.Mesh(boxGeo, debugMat);
          dbg.matrixAutoUpdate = false;
          dbg.matrix.compose(c, q, h);
          dbg.visible = false;
          debug.push(dbg);
        }
      }
    } else if (col?.kind === "visual") {
      // [RECRIADO] convex NX shape not decoded: the visual triangles are the collider
      const v = new THREE.Vector3();
      for (const m of meshes) {
        const g = m.geometry, pa = g.getAttribute("position");
        const W = new THREE.Matrix4().multiplyMatrices(M, m.matrixWorld);
        const verts = new Float32Array(pa.count * 3);
        for (let k = 0; k < pa.count; k++) {
          v.fromBufferAttribute(pa, k).applyMatrix4(W);
          verts[k * 3] = v.x; verts[k * 3 + 1] = v.y; verts[k * 3 + 2] = v.z;
        }
        const idx = g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: pa.count }, (_, k) => k);
        try {
          colliders.push(world.createCollider(RAPIER_MOD.ColliderDesc.trimesh(verts, idx), body));
        } catch (err) {
          console.warn("mapProps: trimesh failed for", name, err);
        }
      }
    }
    return colliders;
  };

  for (const [id, instances] of byDef) {
    const def = json.objects[id];
    const gltf = gltfs.get(id);
    const mtl = staticMtl(instances);
    const done = new Map<THREE.Material, THREE.Material>();
    const meshes: THREE.Mesh[] = [];
    if (gltf) {
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
      });
    }
    defCtx.set(id, { mtl, done, meshes: meshes.map(snap) });
    const matrices = instances.map(instMatrix);
    let instancedMeshes: THREE.InstancedMesh[] = [];
    const animated = (gltf?.animations?.length ?? 0) > 0; // InstancedMesh cannot play node animations: one Object3D per instance
    if (gltf && instances.length > 1 && !animated) {
      instancedMeshes = meshes.map((m) => {
        const mat = Array.isArray(m.material) ? m.material.map((x) => pbMaterial(x, mtl, done)) : pbMaterial(m.material, mtl, done);
        const im = new THREE.InstancedMesh(m.geometry, mat, instances.length);
        im.name = `${id}:${m.name}`;
        const tmp = new THREE.Matrix4();
        matrices.forEach((M, i) => im.setMatrixAt(i, tmp.multiplyMatrices(M, m.matrixWorld)));
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        group.add(im);
        return im;
      });
    }

    instances.forEach((p, i) => {
      const M = matrices[i];
      const snaps = defCtx.get(id)!.meshes;
      let object3d: THREE.Object3D | null = null;
      if (gltf && (instances.length === 1 || animated)) {
        object3d = i === 0 ? gltf.scene : gltf.scene.clone(true);
        object3d.name = p.name;
        object3d.matrixAutoUpdate = false;
        object3d.matrix.copy(M);
        object3d.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) mesh.material = Array.isArray(mesh.material) ? mesh.material.map((x) => pbMaterial(x, mtl, done)) : pbMaterial(mesh.material, mtl, done);
        });
        group.add(object3d);
        if (animated) {
          const mixer = new THREE.AnimationMixer(object3d);
          const clip = gltf!.animations.find((c) => c.name === def?.animated?.clip) ?? gltf!.animations[0];
          mixer.clipAction(clip).play();
          mixer.setTime(Math.random() * clip.duration); // repeated instances do not spin in lockstep
          mixers.push(mixer);
        }
      }

      const colliders = buildColliders(def?.collision, M, snaps, p.name, debugMeshes);

      const serverLife = p.net && p.net.life >= 0 ? p.net.life : null;
      const index = order.get(p)!;
      props[index] = {
        index,
        name: p.name,
        def: def ?? { id, life: null, stateCount: null, breakable: false, states: [] },
        matrix: M,
        net: p.net ?? null,
        objective: p.objective ?? null,
        life: serverLife ?? def?.life ?? null,
        colliders,
        panes: [],
        broken: false,
        center: def?.bounds ? new THREE.Vector3(...def.bounds.min).add(new THREE.Vector3(...def.bounds.max)).multiplyScalar(0.5).applyMatrix4(M) : new THREE.Vector3().setFromMatrixPosition(M),
        object3d,
        instanced: instancedMeshes.length ? { meshes: instancedMeshes, index: i } : null,
      };
    });
  }

  for (const pr of props) if (pr.def.breakable || pr.objective) for (const c of pr.colliders) byHandle.set(c.handle, pr);

  // world-space boxes (inverse matrix + half extents + PANE_MARGIN) of the breakable box-collision props, for claimPanes
  const boxProps: { prop: MapProp; boxes: { inv: THREE.Matrix4; half: THREE.Vector3 }[] }[] = [];
  for (const pr of props) {
    const col = pr.def.collision;
    if (!pr.def.breakable || pr.objective || col?.kind !== "boxes") continue;
    const pos = new THREE.Vector3(), rot = new THREE.Quaternion(), scl = new THREE.Vector3();
    pr.matrix.decompose(pos, rot, scl);
    boxProps.push({ prop: pr, boxes: col.boxes.map((b) => ({
      inv: new THREE.Matrix4().compose(new THREE.Vector3(...b.center).applyMatrix4(pr.matrix), rot.clone().multiply(new THREE.Quaternion(...b.quat)), new THREE.Vector3(1, 1, 1)).invert(),
      half: new THREE.Vector3(...b.half).multiply(new THREE.Vector3(Math.abs(scl.x), Math.abs(scl.y), Math.abs(scl.z))).addScalar(PANE_MARGIN),
    })) });
  }

  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  const tmp = new THREE.Matrix4();
  const brokenObj = new Map<MapProp, THREE.Object3D>();

  const dropColliders = (pr: MapProp) => {
    for (const c of pr.colliders) {
      byHandle.delete(c.handle);
      world.removeCollider(c, true);
    }
    pr.colliders = [];
  };

  const allPanes: MapPane[] = [];
  const buildPanes = () => {
    for (const p of allPanes) {
      if (p.collider || p.owners.some((o) => o.broken)) continue;
      try {
        p.collider = world.createCollider(RAPIER_MOD.ColliderDesc.trimesh(p.vertices, p.indices), body);
        byHandle.set(p.collider.handle, p.owners[0]);
        p.register(p.collider, p.indices.length / 3);
      } catch (err) {
        console.warn("mapProps: pane trimesh failed for", p.owners[0].name, err);
      }
    }
  };

  const breakProp = (pr: MapProp) => {
    pr.broken = true;
    if (pr.object3d) pr.object3d.visible = false;
    if (pr.instanced) for (const im of pr.instanced.meshes) { im.setMatrixAt(pr.instanced.index, ZERO); im.instanceMatrix.needsUpdate = true; }
    dropColliders(pr);
    for (const p of pr.panes) if (p.collider) { byHandle.delete(p.collider.handle); world.removeCollider(p.collider, true); p.collider = null; }
    const st = pr.def.brokenStates?.[0], bg = brokenGltfs.get(pr.def.id), ctx = defCtx.get(pr.def.id);
    if (!st || !bg || !ctx) return; // no broken model: the prop just vanishes (single-state i3Object: i3ActionVisible hide)
    const o = bg.scene.clone(true);
    o.matrixAutoUpdate = false;
    o.matrix.copy(pr.matrix);
    o.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (mesh.isMesh) mesh.material = Array.isArray(mesh.material) ? mesh.material.map((x) => pbMaterial(x, ctx.mtl, ctx.done)) : pbMaterial(mesh.material, ctx.mtl, ctx.done);
    });
    group.add(o);
    brokenObj.set(pr, o);
    // the broken state's own collision (glass: none)
    pr.colliders = buildColliders(st.collision, pr.matrix, brokenSnaps.get(pr.def.id) ?? [], pr.name, null);
  };

  const hurt = (pr: MapProp, dmg: number, remote = false): PropHit | null => {
    if (pr.broken || pr.life === null) return null;
    pr.life -= dmg;
    if (pr.life > 0) return { prop: pr, broke: false };
    pr.life = 0;
    breakProp(pr);
    api.onBreak?.(pr, remote);
    if (pr.def.explosion) api.blast(pr.center, pr.def.explosion.range, pr.def.explosion.damage); // chain reaction
    return { prop: pr, broke: true };
  };

  const api: LoadedMapProps = {
    group, props, debugMeshes, onBreak: null, onObjectiveHit: null,
    setObjectiveLife(index, life) {
      const pr = props[index];
      if (!pr?.objective || pr.broken) return;
      pr.life = Math.max(0, life);
      if (pr.life > 0) return;
      breakProp(pr);
      api.onBreak?.(pr, true); // the break effect + sound; remote = true: the bar came from the server, nothing to send
    },
    onAmbient: null,
    update(dt) {
      for (const m of mixers) m.update(dt);
      clock += dt;
      for (const a of ambient) {
        if (clock < a.t) continue;
        a.t += a.every;
        if (a.t <= clock) a.t = clock + a.every; // a long frame / tab pause: no catch-up burst
        if (!a.prop.broken) api.onAmbient?.(a.prop, a.s);
      }
    },
    damage(handle, dmg) {
      const pr = byHandle.get(handle);
      if (pr?.objective) { api.onObjectiveHit?.(pr, dmg); return { prop: pr, broke: false }; } // the life is the server's bar (setObjectiveLife)
      return pr ? hurt(pr, dmg) : null;
    },
    claimPanes(vertices, indices, register) {
      const a = new THREE.Vector3(), l = new THREE.Vector3();
      const inBox = (bx: { inv: THREE.Matrix4; half: THREE.Vector3 }, v: number) => {
        a.set(vertices[v * 3], vertices[v * 3 + 1], vertices[v * 3 + 2]);
        l.copy(a).applyMatrix4(bx.inv);
        return Math.abs(l.x) <= bx.half.x && Math.abs(l.y) <= bx.half.y && Math.abs(l.z) <= bx.half.z;
      };
      const touching = (v: number) => boxProps.filter((bp) => bp.boxes.some((bx) => inBox(bx, v)));
      // connected pieces (vertices welded by position)
      const key = (v: number) => `${Math.round(vertices[v * 3] * 1000)},${Math.round(vertices[v * 3 + 1] * 1000)},${Math.round(vertices[v * 3 + 2] * 1000)}`;
      const parent = new Map<string, string>();
      const find = (k: string): string => { let r = k; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(k, r); return r; };
      for (let t = 0; t + 2 < indices.length; t += 3) {
        const ks = [0, 1, 2].map((k) => key(indices[t + k]));
        for (const k of ks) if (!parent.has(k)) parent.set(k, k);
        for (let k = 1; k < 3; k++) parent.set(find(ks[k]), find(ks[0]));
      }
      const pieces = new Map<string, number[]>();
      for (let t = 0; t + 2 < indices.length; t += 3) {
        const r = find(key(indices[t]));
        (pieces.get(r) ?? pieces.set(r, []).get(r)!).push(t);
      }
      const rest: number[] = [];
      const claim = (tris: number[], owners: MapProp[]) => {
        const idx: number[] = [];
        for (const t of tris) idx.push(indices[t], indices[t + 1], indices[t + 2]);
        const pane: MapPane = { vertices, indices: Uint32Array.from(idx), register, owners, collider: null };
        allPanes.push(pane);
        for (const o of owners) o.panes.push(pane);
      };
      for (const tris of pieces.values()) {
        const owners = new Set<MapProp>();
        const whole = tris.every((t) => [0, 1, 2].every((k) => { const bps = touching(indices[t + k]); bps.forEach((bp) => owners.add(bp.prop)); return bps.length > 0; }));
        if (whole) { claim(tris, [...owners]); continue; }
        // not enclosed by breakable boxes (a facade): only the triangles inside one prop's box go with it
        const per = new Map<MapProp, number[]>();
        for (const t of tris) {
          const bp = boxProps.find((b) => b.boxes.some((bx) => [0, 1, 2].every((k) => inBox(bx, indices[t + k]))));
          if (!bp) { rest.push(indices[t], indices[t + 1], indices[t + 2]); continue; }
          (per.get(bp.prop) ?? per.set(bp.prop, []).get(bp.prop)!).push(t);
        }
        for (const [pr, ts] of per) claim(ts, [pr]);
      }
      buildPanes();
      return Uint32Array.from(rest);
    },
    breakIndex(index) {
      const pr = props[index];
      if (pr?.def.breakable) hurt(pr, Infinity, true);
    },
    blast(pos, radius, dmg, slope = 1) {
      for (const pr of props) {
        if (!pr.def.breakable || pr.broken || pr.objective) continue;
        const d = pr.center.distanceTo(pos);
        if (d < radius) hurt(pr, Math.round(dmg * (1 - slope * d / radius)));
      }
    },
    reset() {
      for (const a of ambient) if (a.cycle) a.t = clock + a.s.t; // the repeating generators restart with the round [INFERIDO]
      for (const pr of props) {
        if (!pr.broken) { if (pr.objective) pr.life = pr.net?.life ?? pr.life; continue; } // a damaged objective's bar starts over
        const o = brokenObj.get(pr);
        if (o) { group.remove(o); brokenObj.delete(pr); }
        dropColliders(pr);
        pr.broken = false;
        pr.life = (pr.net && pr.net.life >= 0 ? pr.net.life : null) ?? pr.def.life ?? null;
        if (pr.object3d) pr.object3d.visible = true;
        const ctx = defCtx.get(pr.def.id);
        if (pr.instanced && ctx) pr.instanced.meshes.forEach((im, k) => { im.setMatrixAt(pr.instanced!.index, tmp.multiplyMatrices(pr.matrix, ctx.meshes[k].matrixWorld)); im.instanceMatrix.needsUpdate = true; });
        pr.colliders = buildColliders(pr.def.collision, pr.matrix, ctx?.meshes ?? [], pr.name, null);
        for (const c of pr.colliders) byHandle.set(c.handle, pr);
      }
      buildPanes();
    },
  };
  // state 0 of the TimeEventGen: a looping clip replays every clip length from a random phase (repeated instances do not sound
  // in lockstep); a repeating generator (subway) plays its clips at their time of every cycle, clock = s since the map loaded [INFERIDO]
  for (const pr of props) {
    const st = pr.def.stateSounds?.[0];
    for (const s of st?.sounds ?? []) {
      if (st!.cycle) ambient.push({ prop: pr, s, t: s.t, every: st!.cycle, cycle: true });
      else if (s.loop) { const every = s.dur || LOOP_FALLBACK; ambient.push({ prop: pr, s, t: Math.random() * every, every, cycle: false }); }
    }
  }
  current = api;
  return current;
}
