import * as THREE from "three";
import type { GLTFLoader, GLTFParser } from "three/examples/jsm/loaders/GLTFLoader.js";
import { getSettings, onSettings } from "../gameplay/settings";
import { cubeFaceAverages } from "./cubeAvg";

// Map textures: the original i3i blocks (DXT1/3/5 + their mips) exported by pb-extract-tools export-map-dds.mjs as tex/<name>.dds,
// next to the PNG. Uploaded as-is (4-8x less VRAM than RGBA8, same pixels as the original). No S3TC (mobile), a missing
// .dds (partial mip chain / NPOT / raw texture) or any error: GLTFLoader keeps the PNG.

let supported = false;

/** Call once per renderer. sRGB maps need the s3tc_srgb extension too (PB shader materials sample raw, the rest decode sRGB). */
export function setCompressedTextureSupport(renderer: THREE.WebGLRenderer): void {
  supported = renderer.extensions.has("WEBGL_compressed_texture_s3tc") && renderer.extensions.has("WEBGL_compressed_texture_s3tc_srgb");
}

const FOURCC: Record<string, { fmt: THREE.CompressedPixelFormat; block: number }> = {
  DXT1: { fmt: THREE.RGB_S3TC_DXT1_Format, block: 8 },
  DXT3: { fmt: THREE.RGBA_S3TC_DXT3_Format, block: 16 },
  DXT5: { fmt: THREE.RGBA_S3TC_DXT5_Format, block: 16 },
};

/** Parses a DDS written by export-visual.ddsOf: DXT1/3/5, complete mip chain. Returns null when it is not one. */
export function parseDds(buf: ArrayBuffer): THREE.CompressedTexture | null {
  if (buf.byteLength < 128) return null;
  const v = new DataView(buf);
  if (v.getUint32(0, true) !== 0x20534444 || v.getUint32(4, true) !== 124) return null;
  const h = v.getUint32(12, true), w = v.getUint32(16, true), mipCount = v.getUint32(28, true);
  const f = FOURCC[String.fromCharCode(v.getUint8(84), v.getUint8(85), v.getUint8(86), v.getUint8(87))];
  if (!f || !w || !h || !mipCount) return null;
  const alpha = (v.getUint32(80, true) & 1) !== 0;
  const mipmaps: { data: Uint8Array; width: number; height: number }[] = [];
  let off = 128;
  for (let m = 0; m < mipCount; m++) {
    const mw = Math.max(1, w >> m), mh = Math.max(1, h >> m);
    const size = Math.max(1, (mw + 3) >> 2) * Math.max(1, (mh + 3) >> 2) * f.block;
    if (off + size > buf.byteLength) return null;
    mipmaps.push({ data: new Uint8Array(buf, off, size), width: mw, height: mh });
    off += size;
  }
  const fmt = f.fmt === THREE.RGB_S3TC_DXT1_Format && alpha ? THREE.RGBA_S3TC_DXT1_Format : f.fmt;
  const tex = new THREE.CompressedTexture(mipmaps, w, h, fmt, THREE.UnsignedByteType);
  tex.generateMipmaps = false;
  tex.minFilter = mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; // glTF sampler of export-visual (REPEAT)
  tex.needsUpdate = true;
  return tex;
}

class DdsTextureExt {
  readonly name = "PB_dds_texture";
  /** base = the one folder this loader's GLB lives in (maps); null = any folder (weapons / chars, resolved from the loaded url). */
  private parser: GLTFParser;
  private base: string | null;
  constructor(parser: GLTFParser, base: string | null) {
    this.parser = parser;
    this.base = base;
  }
  /** One fetch + parse per .dds url within this load (one parser = one GLB). The glTF has one texture object per material for the same file:
   *  they all get the same CompressedTexture (the hook ignores the glTF sampler, so every user wants the same one; one GPU upload). null = no usable .dds. */
  private byUrl = new Map<string, Promise<THREE.CompressedTexture | null>>();
  private used = new Set<string>();

  loadTexture(index: number): Promise<THREE.Texture> | null {
    if (!supported) return null;
    // The loader also loads the prop GLBs (assets/objects/, textures in objects/tex): their .dds never exist under the map's tex/ (404 per texture).
    const loaded = (this.parser.options as { path?: string }).path;
    const base = this.base ?? loaded;
    if (base === undefined || (this.base !== null && loaded !== undefined && loaded !== this.base)) return null;
    // "Texturas leves" mirror (assetLod.ts): 256 px PNGs only, there is no .dds next to them: precedence = the low-texture option wins.
    if (this.base === null && base.includes("/models_lod/")) return null;
    const json = this.parser.json as { textures?: { source?: number; name?: string }[]; images?: { uri?: string; name?: string }[] };
    const img = json.images?.[json.textures?.[index]?.source ?? -1];
    if (!img?.uri || !/\.png$/i.test(img.uri) || img.uri.startsWith("data:")) return null;
    const url = base + img.uri.replace(/\.png$/i, ".dds");
    const png = () => this.parser.loadTextureImage(index, json.textures![index].source!, this.parser.textureLoader);
    let p = this.byUrl.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((b) => {
          const tex = b && parseDds(b);
          if (!tex) return null;
          tex.name = img.name ?? "";
          tex.userData.ddsUrl = url; // mapMerge dedupes array layers by source image
          return tex;
        })
        .catch(() => null);
      this.byUrl.set(url, p);
    }
    // Maps: all users are PB shader materials (raw sampling), share the object. Models mix PB and standard materials, and pbLighting.rawTexture
    // mutates colorSpace: later users get a clone (own sampler state, shared Source = one GPU upload).
    return p.then((tex) => {
      if (!tex) return png();
      if (this.base !== null) return tex;
      const used = this.used.has(url);
      this.used.add(url);
      return used ? tex.clone() : tex;
    });
  }
}

// ---- anisotropic filtering (Gráficos > "Filtro anisotrópico") -----------------------------------------------------------
// Original: with TriLinear on a class-5 GPU, i3GfxDx _SetTextureFilter (0x100bf380) applies 16x anisotropy to every texture
//. Off = 1 as before. three clamps to getMaxAnisotropy() itself. Weapon diffuse keeps 16 always
// (userData.pbAnisoFixed, worldModel.ts). Samplers are fixed at upload, so a change re-uploads the tracked textures.

const ANISO_MAX = 16;
const aniso = new Set<THREE.Texture>();
let anisoOn = getSettings().anisotropic;

function applyAniso(t: THREE.Texture): void {
  const want = anisoOn ? ANISO_MAX : 1;
  if (t.userData.pbAnisoFixed || t.anisotropy === want) return;
  t.anisotropy = want;
  if (t.version > 0) t.needsUpdate = true;
}

/** Applies the current anisotropy to `t` and keeps it in sync with the setting until it is disposed. */
export function trackAniso<T extends THREE.Texture>(t: T): T {
  if (!aniso.has(t)) {
    aniso.add(t);
    t.addEventListener("dispose", () => aniso.delete(t));
  }
  applyAniso(t);
  return t;
}

onSettings((s) => {
  if (s.anisotropic === anisoOn) return;
  anisoOn = s.anisotropic;
  for (const t of aniso) applyAniso(t);
});

/** afterRoot: tracks every texture of the loaded glTF (DDS, PNG fallback, clones), whichever path produced it. */
class AnisoExt {
  readonly name = "PB_aniso";
  private parser: GLTFParser;
  constructor(parser: GLTFParser) {
    this.parser = parser;
  }
  afterRoot(result: { scene: THREE.Object3D }): null {
    result.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      for (const mat of Array.isArray(m) ? m : m ? [m] : []) for (const v of Object.values(mat)) if ((v as THREE.Texture)?.isTexture) trackAniso(v as THREE.Texture);
    });
    return null;
  }
}

/** Registers the DDS-first texture hook on a loader that will load `<base>visual.glb` (base ends with '/'). */
export function registerCompressedTextures(loader: GLTFLoader, base: string): void {
  loader.register((parser) => new AnisoExt(parser));
  if (!supported) return;
  loader.register((parser) => new DdsTextureExt(parser, base));
}

/**
 * DDS-first hook for weapon / character / equipment / viewmodel GLBs (textures are external PNG uris: tex/<id>/<name>.png,
 * tex/<name>.png; pb-extract-tools export-model-dds.mjs writes the .dds next to them). Register once per loader; whether S3TC exists is
 * checked at load time, so module-level loaders created before the renderer are fine.
 */
export function registerModelCompressedTextures(loader: GLTFLoader): GLTFLoader {
  loader.register((parser) => new DdsTextureExt(parser, null));
  loader.register((parser) => new AnisoExt(parser));
  loader.register((parser) => new DetailMapsExt(parser));
  return loader;
}

// ---- Phong N/S/R/E maps (chara / weapon, Gráficos tab) -------------------------------------------------------
// The exporter keeps them out of the glTF textures (material.extras pbNormal / pbSpec / pbRef (reflect mask) / pbEmissive = uri next to the GLB), so GLTFLoader never
// downloads them. This hook only resolves the uris to absolute urls; pbLighting fetches them when the option is on.

class DetailMapsExt {
  readonly name = "PB_detail_maps";
  private parser: GLTFParser;
  constructor(parser: GLTFParser) {
    this.parser = parser;
  }
  afterRoot(gltf: { scene: THREE.Object3D }): null {
    const base = (this.parser.options as { path?: string }).path;
    if (base === undefined || base.includes("/models_lod/")) return null; // "Texturas leves" mirror has no N/S maps
    const seen = new Set<THREE.Material>();
    gltf.scene.traverse((o) => {
      for (const m of [(o as THREE.Mesh).material].flat()) {
        const u = (m as THREE.Material | undefined)?.userData;
        if (!u || seen.has(m)) continue;
        seen.add(m);
        if (typeof u.pbNormal === "string") u.pbNormalUrl = base + u.pbNormal;
        if (typeof u.pbSpec === "string") u.pbSpecUrl = base + u.pbSpec;
        if (typeof u.pbRef === "string") u.pbRefUrl = base + u.pbRef;
        if (typeof u.pbEmissive === "string") u.pbEmissiveUrl = base + u.pbEmissive;
      }
    });
    return null;
  }
}

const detailCache = new Map<string, Promise<THREE.Texture | null>>();

/** One fetch per url: the .dds twin when S3TC exists, else the PNG. Raw sampling (no colour space), glTF orientation. */
export function loadDetailTexture(pngUrl: string): Promise<THREE.Texture | null> {
  let p = detailCache.get(pngUrl);
  if (!p) {
    const dds = supported
      ? fetch(pngUrl.replace(/\.png$/i, ".dds")).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b && parseDds(b)) || null).catch(() => null)
      : Promise.resolve(null);
    p = dds.then(
      (t) =>
        t ??
        new THREE.TextureLoader().loadAsync(pngUrl).then((x) => {
          x.flipY = false;
          x.wrapS = x.wrapT = THREE.RepeatWrapping;
          x.colorSpace = THREE.NoColorSpace;
          return x;
        }),
    ).catch(() => null);
    detailCache.set(pngUrl, p);
  }
  return p;
}

/** Reflection cubemap of a map (env_ref.dds = World/<Map>/<Map>_Ref.dds): DDS cubemap, DXT1/3/5, 6 faces (+X -X +Y -Y +Z -Z), every face with its mips. */
export function parseCubeDds(buf: ArrayBuffer): THREE.CompressedCubeTexture | null {
  if (buf.byteLength < 128) return null;
  const v = new DataView(buf);
  if (v.getUint32(0, true) !== 0x20534444 || v.getUint32(4, true) !== 124 || (v.getUint32(112, true) & 0xfe00) !== 0xfe00) return null;
  const h = v.getUint32(12, true), w = v.getUint32(16, true), mipCount = Math.max(1, v.getUint32(28, true));
  const f = FOURCC[String.fromCharCode(v.getUint8(84), v.getUint8(85), v.getUint8(86), v.getUint8(87))];
  if (!f || !w || !h) return null;
  const faces: { mipmaps: { data: Uint8Array; width: number; height: number }[]; width: number; height: number }[] = [];
  let off = 128;
  for (let i = 0; i < 6; i++) {
    const mipmaps: { data: Uint8Array; width: number; height: number }[] = [];
    for (let m = 0; m < mipCount; m++) {
      const mw = Math.max(1, w >> m), mh = Math.max(1, h >> m);
      const size = Math.max(1, (mw + 3) >> 2) * Math.max(1, (mh + 3) >> 2) * f.block;
      if (off + size > buf.byteLength) return null;
      mipmaps.push({ data: new Uint8Array(buf, off, size), width: mw, height: mh });
      off += size;
    }
    faces.push({ mipmaps, width: w, height: h });
  }
  const tex = new THREE.CompressedCubeTexture(faces, f.fmt, THREE.UnsignedByteType);
  tex.generateMipmaps = false;
  tex.minFilter = mipCount > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace; // raw like the DX9 shader
  tex.needsUpdate = true;
  return tex;
}

/** Fetches + parses a cubemap .dds. null = no S3TC / missing / not a cubemap (callers then simply skip the reflection). `avg` = cubeFaceAverages. */
export async function loadCubeDds(url: string): Promise<{ tex: THREE.CompressedCubeTexture; avg: Float32Array } | null> {
  if (!supported) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    const tex = parseCubeDds(buf);
    const avg = cubeFaceAverages(buf);
    return tex && avg ? { tex, avg } : null;
  } catch {
    return null;
  }
}
