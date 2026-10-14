import type { GLTF, GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { getSettings } from "./gameplay/settings";

/** `/assets/<kind>/<file>` -> its 256 px texture mirror `/assets/<kind>/models_lod/<file>` (pb-extract-tools asset-lod/build.mjs) */
export function lodUrl(url: string): string {
  return url.replace(/^(\/assets\/(?:chars|weapons))\/(?!models_lod\/)/, "$1/models_lod/");
}

/** Loads a character / weapon GLB; with the "Texturas leves" option the LOD mirror first, the full model when the mirror lacks the file. */
export function loadLodFirst(loader: GLTFLoader, url: string): Promise<GLTF> {
  if (!getSettings().lowTextures) return loader.loadAsync(url);
  const lod = lodUrl(url);
  return lod === url ? loader.loadAsync(url) : loader.loadAsync(lod).catch(() => loader.loadAsync(url));
}
