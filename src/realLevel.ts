import * as THREE from "three";
import { registerCompressedTextures } from "./render/compressedTex";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type RAPIER from "@dimforge/rapier3d-compat";
import { AssetPaths, CurrentMap, MovementConfig } from "./config";
import { cachedOnce, cloneGltf, levelCacheScope, loadGltfShared } from "./levelCache";
import { mapMergeEnabled, mergeWorldMeshes } from "./render/mapMerge";
import { createPbFallbackLights, loadPbLighting, pbWorldMaterial } from "./render/pbLighting";
import { loadMapProps } from "./game/mapProps";
import { clearColliderShapes, loadSurfaceTable, registerColliderShape, registerColliderTriangles } from "./weapons/effects";
import type { LevelBuildResult } from "./testLevel";
import { buildStaticColliders, type StaticShape } from "./mapCollision";
import { jsonOnce } from "./jsonOnce";

// Industrial / metro-station palette, desaturated. Picked by hashing the node's name prefix
// (e.g. "CCR_01" -> "CCR") so every part of a given shape family gets the same tone.
const SHAPE_PALETTE = [
  0x8a8f94, // concrete grey
  0x6f7d78, // steel-teal
  0x9a8f7a, // sandstone
  0x5f6a72, // slate blue-grey
  0x8f7a6a, // rust-brown
  0x707a6a, // moss-grey
  0x9a9a8a, // dust
  0x656b70, // gunmetal
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function colorForShapeName(name: string): THREE.Color {
  const family = name.split(/[_\d]/)[0] || name;
  const idx = hashString(family) % SHAPE_PALETTE.length;
  return new THREE.Color(SHAPE_PALETTE[idx]);
}

// Adds a cheap procedural triplanar grid to a material via onBeforeCompile, to give
// featureless collision surfaces a sense of scale without needing UVs or textures.
function addTriplanarGrid(material: THREE.MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vGridWorldPos;\nvarying vec3 vGridNormal;"
      )
      .replace(
        "#include <worldpos_vertex>",
        "#include <worldpos_vertex>\nvGridWorldPos = worldPosition.xyz;\nvGridNormal = normalize(normalMatrix * normal);"
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vGridWorldPos;
varying vec3 vGridNormal;
float gridLine(vec2 co, float scale, float thickness) {
  vec2 g = abs(fract(co * scale - 0.5) - 0.5) / fwidth(co * scale);
  float line = min(g.x, g.y);
  return 1.0 - clamp(line / thickness, 0.0, 1.0);
}`
      )
      .replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>
{
  vec3 n = abs(vGridNormal);
  float sumN = n.x + n.y + n.z + 1e-5;
  vec2 uvX = vGridWorldPos.zy;
  vec2 uvY = vGridWorldPos.xz;
  vec2 uvZ = vGridWorldPos.xy;
  float gx = gridLine(uvX, 1.0, 1.2);
  float gy = gridLine(uvY, 1.0, 1.2);
  float gz = gridLine(uvZ, 1.0, 1.2);
  float grid = (gx * n.x + gy * n.y + gz * n.z) / sumN;
  gl_FragColor.rgb *= 1.0 - grid * 0.18;
}`
      );
  };
}

export interface CollisionJson {
  spawnSuggestion?: [number, number, number] | { x: number; y: number; z: number };
  bounds?: unknown;
}

function toVector3(
  spawn: CollisionJson["spawnSuggestion"] | undefined,
  fallback: THREE.Vector3
): THREE.Vector3 {
  if (!spawn) return fallback;
  if (Array.isArray(spawn)) return new THREE.Vector3(spawn[0], spawn[1], spawn[2]);
  return new THREE.Vector3(spawn.x, spawn.y, spawn.z);
}

// The exporter writes the i3 lightmap (i3LuxMapBindAttr) as occlusionTexture (uv1) + extras.lightMap. PB draws those
// meshes with Phong_DLX_Dir_: rgb = 2 * D * L * (1 + 0.3 * (L + D)), in DX9 gamma space.
function applyBakedLightmaps(root: THREE.Object3D): void {
  const converted = new Map<THREE.Material, THREE.Material>();
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const src = obj.material as THREE.MeshStandardMaterial;
    if (!src.userData?.lightMap || !src.aoMap) return;
    let dst = converted.get(src);
    if (!dst) {
      dst = pbWorldMaterial(src);
      converted.set(src, dst);
    }
    obj.material = dst;
  });
}

/** collision.glb parsed once per map: world-space arrays of every shape (read-only, shared across matches) */
interface CollisionSet {
  shapes: StaticShape[];
  /** GLASS_* and thin TH_* shapes wait for the props: the map collision carries copies of breakable windows / boards (downtown:
   * TH_WOOD_ strips inside glass_building_06 and downtown_wood boxes), they leave with their prop (mapProps.claimPanes) */
  glass: StaticShape[];
  /** geometry + world matrix of each shape: the F4 wireframe and the collision-only render */
  meshes: { name: string; geom: THREE.BufferGeometry; matrix: THREE.Matrix4 }[];
}

/** One node per shape: each mesh in the collision GLB becomes a fixed trimesh collider (mesh order = collision.json shapes[] order). */
async function loadCollisionSet(loader: GLTFLoader, url: string): Promise<CollisionSet> {
  const gltf = await loader.loadAsync(url);
  const set: CollisionSet = { shapes: [], glass: [], meshes: [] };
  gltf.scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const geom = obj.geometry;
    const posAttr = geom.getAttribute("position");
    if (!posAttr) return;

    obj.updateWorldMatrix(true, false);
    const worldMatrix = obj.matrixWorld;

    const vertexCount = posAttr.count;
    const vertices = new Float32Array(vertexCount * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < vertexCount; i++) {
      v.fromBufferAttribute(posAttr, i);
      v.applyMatrix4(worldMatrix);
      vertices[i * 3] = v.x;
      vertices[i * 3 + 1] = v.y;
      vertices[i * 3 + 2] = v.z;
    }

    let indices: Uint32Array;
    if (geom.index) {
      indices = Uint32Array.from(geom.index.array);
    } else {
      indices = new Uint32Array(vertexCount);
      for (let i = 0; i < vertexCount; i++) indices[i] = i;
    }

    const shape = { name: obj.name, index: set.meshes.length, vertices, indices };
    (/^(TH_|GLASS)/i.test(obj.name) ? set.glass : set.shapes).push(shape);
    set.meshes.push({ name: obj.name, geom, matrix: worldMatrix.clone() });
  });
  return set;
}

/** one material for every F4 wireframe mesh (was one per shape: 328 in provence) */
const DEBUG_WIRE = new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true });

export async function buildRealLevel(
  world: RAPIER.World,
  RAPIER_MOD: typeof RAPIER,
  hasVisual = true,
  loader: GLTFLoader = new GLTFLoader()
): Promise<LevelBuildResult> {
  registerCompressedTextures(loader, AssetPaths.visualGlb.replace(/[^/]*$/, "")); // tex/<name>.dds next to visual.glb
  levelCacheScope(CurrentMap); // another map frees the previous one's geometry / textures

  const [, visualShared, collision, collisionJsonRes] = await Promise.all([
    loadPbLighting(AssetPaths.lightingJson), // per-map engine lighting (pb-extract-tools export-lighting.mjs)
    hasVisual ? loadGltfShared(loader, AssetPaths.visualGlb) : Promise.resolve(null),
    cachedOnce(`collision:${AssetPaths.collisionGlb}`, () => loadCollisionSet(loader, AssetPaths.collisionGlb), (c) => c.meshes.forEach((m) => m.geom.dispose())),
    jsonOnce<CollisionJson>(AssetPaths.collisionJson).catch(() => ({})), // shared with spawns.ts loadMapMeta (one parse)
  ]);

  const visualGroup = new THREE.Group();
  // the PB lightmap shaders replace the materials once per map (after loadPbLighting); every match clones the node tree over them
  const visualGltf = visualShared
    ? cloneGltf(await cachedOnce(`visual-lm:${AssetPaths.visualGlb}`, async () => {
      applyBakedLightmaps(visualShared.scene);
      if (mapMergeEnabled()) { // default on (?mapmerge=0 off): texture arrays + spatial cells instead of one mesh per material
        const s = mergeWorldMeshes(visualShared.scene);
        console.info(`[mapmerge] ${s.meshesIn} -> ${s.meshesOut} meshes (${s.kept} kept), ${s.trisIn} -> ${s.trisOut} tris, ${s.diffuseArrays}+${s.luxArrays} texture arrays, ${s.releasedTextures} source textures freed`);
        // the parser caches every original primitive geometry / material / texture of the GLB (nothing reads it after the load)
        (visualShared as { parser?: unknown }).parser = undefined;
      }
      return visualShared;
    }))
    : null;
  if (visualGltf) visualGroup.add(visualGltf.scene);

  const collisionJsonEarly = (collisionJsonRes || {}) as CollisionJson;

  // PB lights only the ported materials through their shaders; this rig only serves the three.js materials that are
  // not ported yet (collision-only view, grenades, shells, effects). No sky / hemisphere / sun of our own.
  visualGroup.add(createPbFallbackLights());

  const colliderMeshes: THREE.Mesh[] = [];
  // bullet impact surface per shape (Hit_/Hmk_<cat>_<surface>): mesh order = collision.json shapes[] order
  clearColliderShapes();
  const surfaceBase = AssetPaths.collisionJson.replace(/\/collision\.json$/, "");
  const surfacesLoaded = loadSurfaceTable(surfaceBase);
  const staticShapes = collision.shapes;
  const glassShapes = collision.glass;

  for (const { name, geom, matrix } of collision.meshes) {
    // Debug wireframe mesh, hidden by default (toggled with F4), not added to visualGroup render pass directly.
    const debugMesh = new THREE.Mesh(geom, DEBUG_WIRE);
    debugMesh.matrixAutoUpdate = false;
    debugMesh.matrix.copy(matrix);
    debugMesh.visible = false;
    colliderMeshes.push(debugMesh);

    // No visual GLB yet: render the collision geometry itself, shaded per-shape family.
    if (!visualGltf) {
      const shaded = geom.clone();
      shaded.computeVertexNormals();
      toCreasedNormals(shaded, THREE.MathUtils.degToRad(30));
      const material = new THREE.MeshStandardMaterial({
        color: colorForShapeName(name || "SHAPE"),
        roughness: 0.85,
        metalness: 0.05,
        side: THREE.DoubleSide,
      });
      addTriplanarGrid(material);
      const solid = new THREE.Mesh(shaded, material);
      solid.matrixAutoUpdate = false;
      solid.matrix.copy(matrix);
      solid.castShadow = true;
      solid.receiveShadow = true;
      visualGroup.add(solid);
    }
  }

  // shapes sharing a surface + terrain become one trimesh each (mapCollision.ts); the grouping needs the surface table
  await surfacesLoaded;
  buildStaticColliders(world, RAPIER_MOD, staticShapes);

  // GINS object instances (vending machines, billboards, glass...) + their own colliders (pb-extract-tools export-props.mjs).
  // After loadPbLighting: the props sample the light volume at load.
  const mapProps = await loadMapProps(AssetPaths.collisionJson.replace(/collision\.json$/,"props.json"), loader, world, RAPIER_MOD);
  if (mapProps) {
    visualGroup.add(mapProps.group);
    colliderMeshes.push(...mapProps.debugMeshes);
  }

  // the GLASS_* / TH_* shapes: triangles inside a breakable window's box belong to that prop, the rest stay static
  const glassRest: StaticShape[] = [];
  for (const g of glassShapes) {
    // their triangle counts go to the bullet wall walk (one-sided like PhysX: effects.ts hitSide)
    const rest = mapProps ? mapProps.claimPanes(g.vertices, g.indices, (c, triangles) => {
      registerColliderShape(c.handle, g.name, g.index);
      registerColliderTriangles(c.handle, triangles);
    }) : g.indices;
    if (rest.length) glassRest.push({ name: g.name, index: g.index, vertices: g.vertices, indices: rest, walk: true });
  }
  buildStaticColliders(world, RAPIER_MOD, glassRest);

  return { visualGroup, colliderMeshes, spawn: levelSpawnOf(collisionJsonEarly) };
}

/** Player spawn (capsule centre) of a collision.json; also the fallback respawn base of loadMapMeta (the nav bake needs the same one). */
export function levelSpawnOf(collisionJson: CollisionJson): THREE.Vector3 {
  const spawn = toVector3(collisionJson.spawnSuggestion, new THREE.Vector3(0, 2, 0));
  // Respawn points are feet positions; the player body is placed by capsule centre.
  spawn.y += MovementConfig.capsuleHalfHeightStand + MovementConfig.capsuleRadius;
  return spawn;
}
