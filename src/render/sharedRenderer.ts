// One WebGLRenderer (and its canvas / GL context) for every match of the session. A rematch on the
// same map no longer recreates the context nor re-sends the level's textures / geometry: those live in levelCache and stay
// uploaded. What a match created is disposed at its end (releaseMatch), everything else stays.
import * as THREE from "three";
import { getSettings } from "../gameplay/settings";
import { levelCacheOwned, texturesOfMaterial } from "../levelCache";

/** The renderer is rebuilt after this many matches: a safety valve for a per-match resource nobody disposes (see releaseMatch). */
export const RENDERER_MAX_REUSE = 12;

export interface SweepStats { geometries: number; materials: number; textures: number }
export interface MemSnap { geometries: number; textures: number; programs: number }

let shared: THREE.WebGLRenderer | null = null;
let uses = 0;
let sharedAA = true;
export const rendererStats = { created: 0, reused: 0, dropped: 0 };

/** The session's renderer: created on the first match, kept afterwards. A lost context or too many reuses make a new one. */
export function acquireRenderer(): THREE.WebGLRenderer {
  if (shared && (uses >= RENDERER_MAX_REUSE || shared.getContext().isContextLost() || sharedAA !== getSettings().antialias)) dropRenderer();
  installTracker();
  if (shared) rendererStats.reused++;
  else {
    shared = new THREE.WebGLRenderer({ antialias: (sharedAA = getSettings().antialias), powerPreference: "high-performance" });
    uses = 0;
    rendererStats.created++;
  }
  uses++;
  return shared;
}

/** Frees the GL context for good (dispose() alone keeps it alive: Chrome caps ~16). The next acquireRenderer makes a new one. */
export function dropRenderer(): void {
  const r = shared;
  if (!r) return;
  shared = null;
  rendererStats.dropped++;
  r.domElement.remove();
  r.dispose();
  r.forceContextLoss();
}

// ?perf leak tracker: three adds a 'dispose' listener to every texture / geometry it uploads and removes it on dispose(), so
// wrapping addEventListener on those two prototypes gives the set of resources living on the GPU. releaseMatch logs the ones
// that outlived the match, are not the level cache's and were not already listed at a previous match end.
interface LiveRes { kind: string; desc: string; stack: string }
const liveRes = new Map<object, LiveRes>();
const reportedRes = new WeakSet<object>();
let trackerOn = false;
/** where the next uploads come from ("warmup" / "render" ...): set by the caller, shown in the survivors list */
export let leakPhase = "";
export function setLeakPhase(p: string): void { leakPhase = p; }

const isPerf = (): boolean => typeof location !== "undefined" && new URLSearchParams(location.search).has("perf");

function describe(o: object): string {
  if ((o as THREE.Texture).isTexture) {
    const t = o as THREE.Texture & { mipmaps?: { width: number; height: number }[] };
    const img = t.image as { src?: string; currentSrc?: string; width?: number; height?: number } | undefined;
    return `${t.constructor.name} "${t.name}" ${img?.width ?? t.mipmaps?.[0]?.width ?? "?"}x${img?.height ?? t.mipmaps?.[0]?.height ?? "?"} ${img?.currentSrc ?? img?.src ?? ""} ${t.uuid}`;
  }
  const g = o as THREE.BufferGeometry;
  return `${g.constructor.name} "${g.name}" ${g.type} v=${g.attributes?.position?.count ?? 0} ${g.uuid}`;
}

function installTracker(): void {
  if (trackerOn || !isPerf()) return;
  trackerOn = true;
  for (const C of [THREE.Texture, THREE.BufferGeometry] as { prototype: THREE.EventDispatcher }[]) {
    const orig = C.prototype.addEventListener;
    C.prototype.addEventListener = function (this: object, type: string, listener: never) {
      if (type === "dispose" && !liveRes.has(this)) {
        const self = this;
        liveRes.set(self, { kind: (self as THREE.Texture).isTexture ? "texture" : "geometry", desc: describe(self), stack: `[${leakPhase}] ` + (new Error().stack ?? "").split("\n").slice(3, 9).map((s) => s.trim().replace(/^at /, "")).join(" < ") });
        const ev = self as unknown as { addEventListener(t: string, l: () => void): void; removeEventListener(t: string, l: () => void): void };
        ev.addEventListener("dispose", function gone() { liveRes.delete(self); ev.removeEventListener("dispose", gone); });
      }
      return (orig as (t: string, l: never) => void).call(this, type, listener);
    } as typeof orig;
  }
}

/** ?perf: the textures / geometries still on the GPU that no one owns (not the level cache's), first time they are seen */
function logSurvivors(owned: { has(o: object): boolean }, label: string): void {
  const fresh: string[] = [];
  for (const [o, r] of liveRes) {
    if (owned.has(o) || reportedRes.has(o)) continue;
    reportedRes.add(o);
    fresh.push(`${r.kind}: ${r.desc}\n    ${r.stack}`);
  }
  if (fresh.length) console.info(`[renderer] ${label} end: ${fresh.length} new survivors\n  ${fresh.join("\n  ")}`);
}

export function memSnap(r: THREE.WebGLRenderer): MemSnap {
  return { geometries: r.info.memory.geometries, textures: r.info.memory.textures, programs: r.info.programs?.length ?? 0 };
}

/**
 * Disposes what a match's scene graph holds on the GPU: geometries, materials, textures (own maps + shader uniforms), instance
 * buffers and bone textures, skipping what `owned` has (the level cache). Objects detached from the graph before this are the
 * owner's to dispose (RemoteActor, Bot, drops, effect pools do). Disposing a resource still in a module cache (weapon / chara
 * models) is safe: three re-uploads it when it is drawn again.
 */
export function disposeSceneResources(roots: THREE.Object3D[], owned: { has(o: object): boolean }): SweepStats {
  const geos = new Set<THREE.BufferGeometry>(), mats = new Set<THREE.Material>(), texs = new Set<THREE.Texture>();
  const visit = (o: THREE.Object3D) => {
    const m = o as THREE.Mesh & THREE.InstancedMesh & THREE.SkinnedMesh;
    if (m.geometry && !owned.has(m.geometry)) geos.add(m.geometry);
    if (m.material) for (const x of Array.isArray(m.material) ? m.material : [m.material]) {
      if (owned.has(x)) continue;
      mats.add(x);
      for (const t of texturesOfMaterial(x)) if (!owned.has(t)) texs.add(t);
    }
    if (m.isInstancedMesh) m.dispose();
    m.skeleton?.dispose();
  };
  for (const r of roots) r.traverse(visit);
  for (const g of geos) g.dispose();
  for (const x of mats) x.dispose();
  for (const t of texs) t.dispose();
  return { geometries: geos.size, materials: mats.size, textures: texs.size };
}

/**
 * Match end: frees what the match put on the GPU (everything in `roots` that the level cache does not own), takes the canvas out
 * of the page and leaves the renderer ready for the next acquireRenderer. Call it BEFORE the Game's dispose, which detaches its
 * actors from the scene.
 */
export function releaseMatch(r: THREE.WebGLRenderer, roots: THREE.Object3D[], label = "match"): SweepStats {
  const before = memSnap(r);
  const owned = levelCacheOwned();
  const swept = disposeSceneResources(roots, owned);
  r.setRenderTarget(null);
  r.domElement.remove();
  r.domElement.style.filter = ""; // the next match applies the Brilho setting again (main.ts)
  r.info.reset();
  const after = memSnap(r);
  if (isPerf()) {
    logSurvivors(owned, label);
    console.info(`[renderer] ${label} end: geometries ${before.geometries} -> ${after.geometries}, textures ${before.textures} -> ${after.textures}, programs ${before.programs} -> ${after.programs} (swept ${swept.geometries} geo / ${swept.materials} mat / ${swept.textures} tex)`);
  }
  return swept;
}
