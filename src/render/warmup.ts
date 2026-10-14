// Shader + texture warm-up before the first match frame. Measured before it: 3-6 programs
// compiled mid-match at 45-55 ms each on a cold GPU cache (the bots' 3PV weapon, the transparent chara of the spawn
// protection blink, the casing's MeshStandard...), and the first frame uploading the new textures.
import * as THREE from "three";
import { setLeakPhase } from "./sharedRenderer";

/** every texture a material reads: its own maps and, for ShaderMaterials, the texture uniforms */
function texturesOf(m: THREE.Material, out: Set<THREE.Texture>): void {
  for (const v of Object.values(m)) if ((v as THREE.Texture | null)?.isTexture) out.add(v as THREE.Texture);
  const u = (m as THREE.ShaderMaterial).uniforms;
  if (u) for (const k in u) if ((u[k]?.value as THREE.Texture | null)?.isTexture) out.add(u[k].value as THREE.Texture);
}

function materialsOf(root: THREE.Object3D): Set<THREE.Material> {
  const out = new Set<THREE.Material>();
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (m) for (const x of Array.isArray(m) ? m : [m]) out.add(x);
  });
  return out;
}

/**
 * Compiles (KHR_parallel_shader_compile when present: off the main thread) every program `scene` + `extra` need and
 * uploads their textures, without drawing. `extra` (game/matchPreload.ts WarmSet) is added for the call and removed after,
 * never disposed. The PB chara shader also runs transparent (spawn protection CharVisual.setAlpha, the viewmodel pass), and
 * three r169 keys the program on it (OPAQUE define): the PB materials of `extra` are compiled in both variants.
 * The match scene holds one PointLight (the WeaponEffects muzzle i3Light, intensity 0 between shots) and the light count is
 * part of every program key: without one in `scene` yet (before Game.create) a stand-in takes its place for the call.
 */
export async function warmScene(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, extra: THREE.Object3D[] = []): Promise<void> {
  const t0 = performance.now();
  setLeakPhase("warmup");
  const group = new THREE.Group();
  group.name = "warmup";
  for (const o of extra) group.add(o);
  scene.add(group);
  let points = 0;
  scene.traverseVisible((o) => { if ((o as THREE.PointLight).isPointLight) points++; });
  const standIn = points ? null : new THREE.PointLight(0xffffff, 0, 3, 2);
  if (standIn) scene.add(standIn);
  const before = renderer.info.programs?.length ?? 0;
  try {
    await renderer.compileAsync(scene, camera);
    const flip = [...materialsOf(group)].filter((m) => m.userData.pb && !m.transparent);
    if (flip.length) {
      for (const m of flip) { m.transparent = true; m.needsUpdate = true; }
      await renderer.compileAsync(group, camera, scene);
      for (const m of flip) { m.transparent = false; m.needsUpdate = true; }
    }
    const tex = new Set<THREE.Texture>();
    for (const m of materialsOf(scene)) texturesOf(m, tex);
    for (const t of tex) renderer.initTexture(t);
    // one real draw (group included, so the extra set is covered too): the per-object setup (VAO, uniforms, render lists) of the
    // 1st frame happens here. Same camera and target as the match: same program keys.
    const tR = performance.now();
    renderer.render(scene, camera);
    renderer.info.reset();
    console.info(`[warmup] ${(renderer.info.programs?.length ?? 0) - before} programs, ${tex.size} textures: ${Math.round(performance.now() - t0)} ms (render ${Math.round(performance.now() - tR)} ms)`);
  } finally {
    setLeakPhase("");
    standIn?.removeFromParent();
    for (const o of extra) group.remove(o);
    group.removeFromParent();
  }
}
