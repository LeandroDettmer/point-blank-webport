import * as THREE from "three";
import { pbWorldArrayMaterial } from "./pbLighting";
import { texturesOfMaterial } from "../levelCache";
import { trackAniso } from "./compressedTex";

/**
 * Draw call merge of the map visual. export-visual.mjs writes one material per (diffuse, lightmap) pair
 * and one mesh per material: giran2 has 467 meshes for 426 diffuse textures and 4 lightmaps, so merging by pair does nothing.
 * Here every DDS diffuse of the same size / mip count / format becomes one layer of a CompressedArrayTexture (same for the
 * lightmaps); the layer of a triangle is a vertex attribute (pbLayer). No atlas: UVs are untouched, wrap, mips and filtering stay per
 * layer, so the image is the one of the separate textures. Meshes with the same texture buckets and the same render state are
 * fused per spatial cell (the frustum culling keeps working). Needs the compressed textures (S3TC): PNG textures (no S3TC, no .dds)
 * keep their own mesh. On by default (compared on screen 2026-10-04, giran2 6 views: <= 0.005% of channels differ, max 17/255,
 * filtering only); ?mapmerge=0 turns it off.
 */

/** cell side (m, XZ) of a merged mesh: smaller = better culling, more draw calls */
export const MAP_MERGE_CELL = 96;

export function mapMergeEnabled(): boolean {
  return typeof location !== "undefined" && new URLSearchParams(location.search).get("mapmerge") !== "0";
}

export interface MergeStats {
  meshesIn: number;
  meshesOut: number;
  /** meshes left alone (PNG textures, blended, flipped...) */
  kept: number;
  trisIn: number;
  trisOut: number;
  diffuseArrays: number;
  luxArrays: number;
  /** every texture array: layers (distinct source images), mip levels, CPU bytes */
  arrays: { key: string; depth: number; mips: number; bytes: number }[];
  /** source textures whose CPU mips were freed after the merge */
  releasedTextures?: number;
}

type CTex = THREE.CompressedTexture;

const isCompressed = (t: unknown): t is CTex => !!t && (t as CTex).isCompressedTexture === true && ((t as CTex).mipmaps?.length ?? 0) > 0;
const bucketKey = (t: CTex): string => `${t.mipmaps![0].width}x${t.mipmaps![0].height}/${t.mipmaps!.length}/${t.format}/${t.type}`;

function buildArray(texs: CTex[]): THREE.CompressedArrayTexture {
  const first = texs[0];
  const mips = first.mipmaps!.map((m, level) => {
    const bytes = m.data.byteLength;
    const data = new Uint8Array(bytes * texs.length);
    texs.forEach((t, i) => data.set(t.mipmaps![level].data, i * bytes));
    return { data, width: m.width, height: m.height };
  });
  const arr = new THREE.CompressedArrayTexture(mips, mips[0].width, mips[0].height, texs.length, first.format as THREE.CompressedPixelFormat, first.type);
  arr.colorSpace = THREE.NoColorSpace; // raw sampling like the separate textures (pbLighting.rawTexture)
  arr.generateMipmaps = false;
  arr.minFilter = first.minFilter;
  arr.magFilter = first.magFilter;
  arr.wrapS = first.wrapS;
  arr.wrapT = first.wrapT;
  arr.anisotropy = first.anisotropy;
  arr.needsUpdate = true;
  trackAniso(arr);
  return arr;
}

interface Cand {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  d: CTex;
  l: CTex;
  dKey: string;
  lKey: string;
  state: string;
  cx: number;
  cz: number;
}

/**
 * Replaces the lightmapped world meshes (pbWorldMaterial) under `root` by merged ones (see the file header). Positions are baked
 * relative to `root`; call before the first render, once per loaded map. Triangles, UVs and per-triangle textures are preserved.
 */
export function mergeWorldMeshes(root: THREE.Object3D, cell = MAP_MERGE_CELL): MergeStats {
  root.updateWorldMatrix(true, true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const stats: MergeStats = { meshesIn: 0, meshesOut: 0, kept: 0, trisIn: 0, trisOut: 0, diffuseArrays: 0, luxArrays: 0, arrays: [] };
  const cands: Cand[] = [];
  const m4 = new THREE.Matrix4(), v = new THREE.Vector3(), box = new THREE.Box3();

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    stats.meshesIn++;
    const g = mesh.geometry, mat = mesh.material as THREE.ShaderMaterial;
    const d = mat.uniforms?.map?.value, l = mat.uniforms?.luxMap?.value;
    m4.multiplyMatrices(toRoot, mesh.matrixWorld);
    if (
      Array.isArray(mat) || !mat.isShaderMaterial || !mat.userData.pb || !isCompressed(d) || !isCompressed(l) || mat.transparent || mesh.renderOrder !== 0 ||
      !g.getAttribute("position") || !g.getAttribute("uv") || !g.getAttribute("uv1") || m4.determinant() <= 0
    ) {
      stats.kept++;
      return;
    }
    g.computeBoundingBox();
    box.copy(g.boundingBox!).applyMatrix4(m4).getCenter(v);
    const state = [mat.uniforms.alphaTest.value, mat.side, mat.depthWrite, mat.depthTest, mat.blending, mat.opacity].join("/");
    cands.push({ mesh, mat, d, l, dKey: bucketKey(d), lKey: bucketKey(l), state, cx: Math.floor(v.x / cell), cz: Math.floor(v.z / cell) });
    stats.trisIn += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
  });
  stats.meshesOut = stats.kept;
  if (!cands.length) return stats;

  // one array per diffuse bucket and per lightmap bucket (every distinct texture = one layer)
  // Layers are deduped by source image (userData.ddsUrl + sampling params), not by Texture object: the glTF has one texture
  // object per material for the same file (giran2: 4 distinct lightmaps, 467 objects).
  type Arr = { tex: THREE.CompressedArrayTexture; layer: Map<CTex, number> };
  const arrays = (pick: (c: Cand) => [string, CTex]): Map<string, Arr> => {
    const lists = new Map<string, { list: CTex[]; byImg: Map<string, number> }>();
    const layerOf = new Map<CTex, number>();
    const owner = new Map<CTex, string>();
    for (const c of cands) {
      const [k, t] = pick(c);
      let a = lists.get(k);
      if (!a) lists.set(k, (a = { list: [], byImg: new Map() }));
      if (layerOf.has(t) && owner.get(t) === k) continue;
      const url = t.userData?.ddsUrl as string | undefined;
      const ik = url ? `${url}|${t.wrapS}|${t.wrapT}|${t.minFilter}|${t.magFilter}|${t.anisotropy}|${t.flipY}` : undefined;
      let i = ik === undefined ? undefined : a.byImg.get(ik);
      if (i === undefined) {
        i = a.list.push(t) - 1;
        if (ik !== undefined) a.byImg.set(ik, i);
      }
      layerOf.set(t, i);
      owner.set(t, k);
    }
    const out = new Map<string, Arr>();
    for (const [k, { list }] of lists) {
      const arr = buildArray(list);
      stats.arrays.push({ key: k, depth: list.length, mips: arr.mipmaps!.length, bytes: arr.mipmaps!.reduce((n, m) => n + m.data!.byteLength, 0) });
      out.set(k, { tex: arr, layer: new Map() });
    }
    for (const [t, i] of layerOf) out.get(owner.get(t)!)!.layer.set(t, i);
    return out;
  };
  const dArr = arrays((c) => [c.dKey, c.d]);
  const lArr = arrays((c) => [c.lKey, c.l]);
  stats.diffuseArrays = dArr.size;
  stats.luxArrays = lArr.size;

  // groups: render state + buckets (one material), then spatial cell (one mesh)
  const groups = new Map<string, { mat: THREE.ShaderMaterial; cells: Map<string, Cand[]> }>();
  for (const c of cands) {
    const k = `${c.dKey}|${c.lKey}|${c.state}`;
    let gr = groups.get(k);
    if (!gr) {
      gr = { mat: pbWorldArrayMaterial(c.mat, dArr.get(c.dKey)!.tex, lArr.get(c.lKey)!.tex), cells: new Map() };
      groups.set(k, gr);
    }
    const ck = `${c.cx},${c.cz}`;
    let list = gr.cells.get(ck);
    if (!list) gr.cells.set(ck, (list = []));
    list.push(c);
  }

  const p = new THREE.Vector3();
  for (const [k, gr] of groups) {
    for (const [ck, list] of gr.cells) {
      let verts = 0, idx = 0;
      for (const c of list) {
        const g = c.mesh.geometry;
        verts += g.getAttribute("position").count;
        idx += g.index ? g.index.count : g.getAttribute("position").count;
      }
      const pos = new Float32Array(verts * 3), uv = new Float32Array(verts * 2), uv1 = new Float32Array(verts * 2), lay = new Float32Array(verts * 2);
      const ind = verts > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
      let vo = 0, io = 0;
      for (const c of list) {
        const g = c.mesh.geometry;
        const P = g.getAttribute("position"), A = g.getAttribute("uv"), B = g.getAttribute("uv1");
        m4.multiplyMatrices(toRoot, c.mesh.matrixWorld);
        const dl = dArr.get(c.dKey)!.layer.get(c.d)!, ll = lArr.get(c.lKey)!.layer.get(c.l)!;
        for (let i = 0; i < P.count; i++) {
          p.fromBufferAttribute(P, i).applyMatrix4(m4).toArray(pos, (vo + i) * 3);
          uv[(vo + i) * 2] = A.getX(i); uv[(vo + i) * 2 + 1] = A.getY(i);
          uv1[(vo + i) * 2] = B.getX(i); uv1[(vo + i) * 2 + 1] = B.getY(i);
          lay[(vo + i) * 2] = dl; lay[(vo + i) * 2 + 1] = ll;
        }
        if (g.index) for (let i = 0; i < g.index.count; i++) ind[io + i] = g.index.getX(i) + vo;
        else for (let i = 0; i < P.count; i++) ind[io + i] = vo + i;
        io += g.index ? g.index.count : P.count;
        vo += P.count;
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      geom.setAttribute("uv1", new THREE.BufferAttribute(uv1, 2));
      geom.setAttribute("pbLayer", new THREE.BufferAttribute(lay, 2));
      geom.setIndex(new THREE.BufferAttribute(ind, 1));
      const merged = new THREE.Mesh(geom, gr.mat);
      merged.name = `merged:${k}@${ck}`;
      merged.userData.merged = list.length;
      merged.matrixAutoUpdate = false; // static world: positions are baked, identity matrix
      merged.updateMatrix();
      root.add(merged);
      stats.meshesOut++;
      stats.trisOut += idx / 3;
    }
  }

  for (const c of cands) {
    c.mesh.removeFromParent();
    c.mesh.geometry.dispose();
  }

  // The source DDS (one Uint8Array view per mip over the whole file) now live only as layers of the arrays (the single CPU copy,
  // kept for a re-upload when the renderer is recreated). Drop them unless a kept mesh (PNG / blended...) still samples them.
  const stillUsed = new Set<THREE.Texture>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) for (const t of texturesOfMaterial(mesh.material as THREE.Material)) stillUsed.add(t);
  });
  const released = new Set<CTex>();
  for (const c of cands) for (const t of [c.d, c.l]) {
    if (released.has(t) || stillUsed.has(t)) continue;
    released.add(t);
    t.mipmaps = [];
    t.dispose();
  }
  stats.releasedTextures = released.size;
  return stats;
}
