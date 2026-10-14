import * as THREE from "three";
import { getSettings, onSettings } from "../gameplay/settings";
import { loadCubeDds, loadDetailTexture } from "./compressedTex";

/**
 * Point Blank / i3Engine lighting, reproduced from the original compiled DX9 shaders (Shader/DefaultSHGL and the
 * driver cache Shader/Cache.i3GL of the 2017 client, disassembled with D3DXDisassembleShader) and from the clean
 * 2017 DLLs/exe that feed their constants. Full derivation + provenance of every number: 
 *
 * DX9 renders in gamma space: textures are sampled raw (no sRGB decode), the maths runs on those values and the
 * result is written raw to the back buffer. The ShaderMaterials here do exactly that: their textures are switched
 * to NoColorSpace and the fragment shaders skip three's output colour-space conversion and tone mapping.
 *
 *  world  (Phong_DLX_Dir_, ps_2_0 in Cache.i3GL / ps_1_1 in DefaultSHGL, identical maths):
 *           rgb = 2 * D * L * (1 + 0.3 * (L + D))          D = g_texDiffuse, L = g_texLux (uv1)
 *           a   = D.a * g_vLightDiffuse0.a
 *  chara  (Phong_D_Dir_, ps_2_x):  N, L (= g_vLightDir0, towards the light), R = 2(N.L)N - L, V = eye - P
 *           ndl  = sat(N.L);  spec = pow(sat(R.V), g_vLightSpecular0.w) * g_vLightSpecular0.rgb
 *           rgb  = D * g_vAmbient + g_vLightDiffuse0.rgb * ndl * (D * (1 + 0.3 * (D + ndl)) + spec)
 *           a    = D.a * g_vLightDiffuse0.a
 *         g_vLightDiffuse0  = light.diffuse * material.diffuse (material.diffuse.rgb = light-volume colour)
 *         g_vLightSpecular0 = light.specular * material.specular, .w = material.shininess
 *  fog    fixed-function D3D table fog (D3DRS_FOGTABLEMODE) on the world root only, applied after the shader.
 */

export interface PbFog {
  index: number;
  target: string;
  enable: boolean;
  mode: number; // D3DFOGMODE: 1 EXP, 2 EXP2, 3 LINEAR
  color: number[]; // I3COLOR 0..255
  density: number;
  near: number;
  far: number;
}

export interface PbLightingJson {
  map: string;
  ambient: [number, number, number];
  defaultDiffuse: [number, number, number];
  camFar: number | null;
  light: { diffuse: number[]; specular: number[]; dirToLight: [number, number, number] } | null;
  fog: PbFog[];
  worldMaterials: { diffuse: number[]; specular: number[]; shininess: number }[];
  lightVolume: { positions: number[]; tris: number[]; colors: number[] } | null;
  /** reflection cubemap next to lighting.json (pb-extract-tools export-env-ref.mjs); absent = the map has none */
  envRef?: string;
}

// ---- shared engine constants (one set per loaded map) --------------------------------------------------------------

const U = {
  pbAmbient: { value: new THREE.Vector3(1, 1, 1) }, // [RECRIADO] neutral until lighting.json is loaded
  pbLightDir: { value: new THREE.Vector3(0, 1, 0) },
  pbLightDiffuse: { value: new THREE.Vector4(0, 0, 0, 1) },
  pbLightSpecular: { value: new THREE.Vector4(0, 0, 0, 1) },
  // Gráficos tab [RECRIADO]: one gate per effect of the chara shader (live)
  pbNormalOn: { value: getSettings().normalMap ? 1 : 0 },
  pbSpecOn: { value: getSettings().specularMap ? 1 : 0 },
  pbReflectOn: { value: getSettings().reflection ? 1 : 0 }, // reflection x mask + emissive
  pbRimOn: { value: getSettings().rimLight ? 1 : 0 },
  pbIblOn: { value: getSettings().ibl ? 1 : 0 },
  pbEnvMap: { value: null as THREE.Texture | null }, // g_texReflect: <Map>_Ref.dds cubemap of the loaded map (only with reflection / ibl)
  pbHasEnv: { value: 0 },
  pbEnvAvg: { value: Array.from({ length: 6 }, () => new THREE.Vector3()) }, // mean rgb of the 6 cube faces (+X -X +Y -Y +Z -Z): IBL diffuse
  pbFogMode: { value: 0 }, // 0 = off
  pbFogColor: { value: new THREE.Vector3(1, 1, 1) },
  pbFogParams: { value: new THREE.Vector3(1, 1000, 1) }, // near, far, density
};

// Materials with N/S/R/E maps still to fetch (url in userData.pbNormalUrl / pbSpecUrl / pbRefUrl / pbEmissiveUrl, set by compressedTex
// DetailMapsExt). Cleared on material dispose.
const detailPending = new Set<THREE.ShaderMaterial>();
const detailAsked = new WeakMap<THREE.ShaderMaterial, Set<string>>(); // uniform names already requested per material

/** Fetches only the maps an enabled effect needs (once per map; N: normalMap, S: specularMap or ibl, R/E: reflection). */
function loadDetail(m: THREE.ShaderMaterial): void {
  const s = getSettings();
  let asked = detailAsked.get(m);
  if (!asked) detailAsked.set(m, (asked = new Set()));
  const get = (want: boolean, url: unknown, tex: string, has: string): void => {
    if (!want || typeof url !== "string" || asked.has(tex)) return;
    asked.add(tex);
    void loadDetailTexture(url).then((t) => {
      if (!t) return;
      m.uniforms[tex].value = t;
      m.uniforms[has].value = 1;
    });
  };
  get(s.normalMap, m.userData.pbNormalUrl, "normalMap", "hasNormal");
  get(s.specularMap || s.ibl, m.userData.pbSpecUrl, "specMap", "hasSpec");
  get(s.reflection, m.userData.pbRefUrl, "refMap", "hasRef");
  get(s.reflection, m.userData.pbEmissiveUrl, "emissiveMap", "hasEmissive");
}

// Reflection cubemap of the current map (lighting.json): fetched only while Reflexo or IBL is on, once per map.
let envUrl: string | null = null;
let envLoaded: string | null = null;

function loadEnv(): void {
  const url = envUrl;
  const s = getSettings();
  if (!url || url === envLoaded || !(s.reflection || s.ibl)) return;
  envLoaded = url;
  void loadCubeDds(url).then((e) => {
    if (url !== envUrl) return e?.tex.dispose(); // another map loaded meanwhile
    U.pbEnvMap.value = e?.tex ?? null;
    U.pbHasEnv.value = e ? 1 : 0;
    if (e) for (let i = 0; i < 6; i++) U.pbEnvAvg.value[i].fromArray(e.avg, i * 3);
  });
}

function clearEnv(url: string | null): void {
  envUrl = url;
  envLoaded = null;
  U.pbEnvMap.value?.dispose();
  U.pbEnvMap.value = null;
  U.pbHasEnv.value = 0;
  loadEnv();
}

onSettings((s) => {
  U.pbNormalOn.value = s.normalMap ? 1 : 0;
  U.pbSpecOn.value = s.specularMap ? 1 : 0;
  U.pbReflectOn.value = s.reflection ? 1 : 0;
  U.pbRimOn.value = s.rimLight ? 1 : 0;
  U.pbIblOn.value = s.ibl ? 1 : 0;
  for (const r of detailPending) loadDetail(r);
  loadEnv();
});

let current: PbLightingJson | null = null;
let defaultDiffuse = new THREE.Vector3(0.588, 0.588, 0.588); // i3MaterialAttr default of the chara packs until loaded
const viewers = new Set<PbMtl>();

/** The lighting.json currently applied (null = none / not loaded). */
export function pbLighting(): PbLightingJson | null {
  return current;
}

/** Maps with no lighting.json: no Stage.pef entry in PBCross (pb-extract-tools export-lighting.mjs skips them), so no fetch/404. */
const NO_LIGHTING = new Set(["deadtown"]);

/** Loads public/assets/maps/<map>/lighting.json and makes it the active lighting. Resolves null when missing. */
export async function loadPbLighting(url: string): Promise<PbLightingJson | null> {
  let j: PbLightingJson | null = null;
  const map = /\/maps\/([^/]+)\/lighting\.json$/.exec(url)?.[1];
  if (map && NO_LIGHTING.has(map)) {
    setPbLighting(null);
    clearEnv(null);
    return null;
  }
  try {
    const r = await fetch(url);
    const type = r.headers.get("content-type") ?? "";
    if (r.ok && !type.includes("text/html")) j = (await r.json()) as PbLightingJson;
  } catch {
    j = null;
  }
  setPbLighting(j);
  clearEnv(j?.envRef ? url.replace(/lighting.json$/, j.envRef) : null);
  return j;
}

export function setPbLighting(j: PbLightingJson | null): void {
  current = j;
  lightVolume = j?.lightVolume ? buildLightVolume(j.lightVolume) : null;
  if (!j) return;
  U.pbAmbient.value.fromArray(j.ambient);
  defaultDiffuse = new THREE.Vector3().fromArray(j.defaultDiffuse);
  if (j.light) {
    U.pbLightDir.value.fromArray(j.light.dirToLight).normalize();
    U.pbLightDiffuse.value.fromArray(j.light.diffuse);
    U.pbLightSpecular.value.fromArray(j.light.specular);
  } else {
    U.pbLightDiffuse.value.set(0, 0, 0, 1);
  }
  const f = j.fog.find((x) => x.index === 0);
  U.pbFogMode.value = f && f.enable ? f.mode : 0;
  if (f) {
    U.pbFogColor.value.set(f.color[0] / 255, f.color[1] / 255, f.color[2] / 255);
    U.pbFogParams.value.set(f.near, f.far, f.density);
  }
  for (const m of viewers) m.reset();
}

/**
 * Renderer / scene state matching the DX9 pipeline: no tone mapping. The world fog is also given to three's own
 * fog so non-PB materials (effects, decals) fade like the world ([RECRIADO] three mixes it in linear space).
 */
export function configurePbRenderer(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;
  const f = current?.fog.find((x) => x.index === 0);
  if (f && f.enable) {
    const c = new THREE.Color().setRGB(f.color[0] / 255, f.color[1] / 255, f.color[2] / 255, THREE.SRGBColorSpace);
    scene.fog = f.mode === 3 ? new THREE.Fog(c, f.near, f.far) : f.mode === 2 ? new THREE.FogExp2(c, f.density) : null;
  } else scene.fog = null;
}

/**
 * [RECRIADO] Plain three lights carrying the PB light values, for materials that are not ported to the PB shaders
 * yet (grenades, shells, effects, test level). They never touch the PB ShaderMaterials.
 */
export function createPbFallbackLights(): THREE.Object3D {
  const g = new THREE.Group();
  g.name = "pbFallbackLights";
  // three's Lambert BRDF divides by PI, hence intensity PI: diffuse * colour, like the PB terms D*ambient and D*light.
  const a = U.pbAmbient.value, d = U.pbLightDiffuse.value, dd = defaultDiffuse;
  g.add(new THREE.AmbientLight(new THREE.Color().setRGB(a.x, a.y, a.z, THREE.SRGBColorSpace), Math.PI));
  const sun = new THREE.DirectionalLight(new THREE.Color().setRGB(Math.min(1, d.x * dd.x), Math.min(1, d.y * dd.y), Math.min(1, d.z * dd.z), THREE.SRGBColorSpace), Math.PI);
  sun.position.copy(U.pbLightDir.value).multiplyScalar(50);
  g.add(sun);
  return g;
}

// ---- GLSL ---------------------------------------------------------------------------------------------------------

const FOG_PARS = /* glsl */ `
uniform int pbFogMode;
uniform vec3 pbFogColor;
uniform vec3 pbFogParams;
varying float vPbFogDepth;
vec3 pbFog(vec3 c) {
  if (pbFogMode == 0) return c;
  float z = vPbFogDepth, f;
  if (pbFogMode == 3) f = (pbFogParams.y - z) / (pbFogParams.y - pbFogParams.x);
  else if (pbFogMode == 1) f = exp(-pbFogParams.z * z);
  else f = exp(-(pbFogParams.z * z) * (pbFogParams.z * z));
  return mix(pbFogColor, c, clamp(f, 0.0, 1.0));
}`;

const WORLD_VS = /* glsl */ `
#include <common>
#ifndef USE_UV1
attribute vec2 uv1;
#endif
varying vec2 vPbUv;
varying vec2 vPbUv1;
varying float vPbFogDepth;
void main() {
  vPbUv = uv;
  vPbUv1 = uv1;
  #include <begin_vertex>
  #include <project_vertex>
  vPbFogDepth = -mvPosition.z; // table fog: view-space depth (W-friendly projection)
}`;

const WORLD_FS = /* glsl */ `
uniform sampler2D map;
uniform sampler2D luxMap;
uniform vec4 pbLightDiffuse;
uniform float alphaTest;
varying vec2 vPbUv;
varying vec2 vPbUv1;
${FOG_PARS}
void main() {
  vec4 D = texture2D(map, vPbUv);
  vec3 L = texture2D(luxMap, vPbUv1).rgb;
  float a = D.a * pbLightDiffuse.a;
  if (a <= alphaTest) discard;
  vec3 c = 2.0 * D.rgb * (L * ((L + D.rgb) * 0.3 + 1.0)); // Phong_DLX_Dir_
  gl_FragColor = vec4(pbFog(clamp(c, 0.0, 1.0)), a);
}`;

const CHARA_VS = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
varying vec2 vPbUv;
varying vec3 vPbNormal;
varying vec3 vPbWorldPos;
varying float vPbFogDepth;
void main() {
  vPbUv = uv;
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vPbNormal = inverseTransformDirection(transformedNormal, viewMatrix); // vs_1_1: normalised per vertex
  vPbWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vPbFogDepth = -mvPosition.z;
}`;

const CHARA_FS = /* glsl */ `
uniform sampler2D map;
uniform float hasMap;
uniform sampler2D normalMap;
uniform float pbNormalOn;
uniform float pbSpecOn;
uniform float pbReflectOn;
uniform float pbRimOn;
uniform float pbIblOn;
uniform float hasNormal;
uniform sampler2D specMap;
uniform float hasSpec;
uniform sampler2D refMap;
uniform float hasRef;
uniform samplerCube pbEnvMap;
uniform float pbHasEnv;
uniform vec3 pbEnvAvg[6];
uniform sampler2D emissiveMap;
uniform float hasEmissive;
uniform vec3 emissiveColor;
uniform vec3 baseColor;
uniform vec3 pbAmbient;
uniform vec3 pbLightDir;
uniform vec4 pbLightDiffuse;
uniform vec4 pbLightSpecular;
uniform vec4 mtlDiffuse;
uniform vec3 mtlSpecular;
uniform float mtlShininess;
uniform float alphaTest;
uniform float useFog;
varying vec2 vPbUv;
varying vec3 vPbNormal;
varying vec3 vPbWorldPos;
${FOG_PARS}
float d3dPow(float x, float y) { return y <= 0.0 ? 1.0 : pow(x, y); }
void main() {
  vec4 D = hasMap > 0.5 ? texture2D(map, vPbUv) : vec4(1.0);
  D.rgb *= baseColor;
  vec3 N = vPbNormal;                        // interpolated, not renormalised (ps_2_x uses t1 directly)
  if (hasNormal * pbNormalOn > 0.5) {
    // Phong_DN*: n = x*T - y*B + sqrt(1-x^2-y^2)*N. The vertex tangent/binormal in the
    // i3 VA30 are not reliable (zero in half the triangles), so the frame comes from screen derivatives (cotangent frame).
    // [INFERIDO] sign: in the vertex data T = +dP/du and B = -dP/dv (measured on Weapon_AK-47_PBIC2013, B only where non-zero), so
    // -y*B = +y*dP/dv: the D3D map is a GL map with G flipped; uv here is the glTF/D3D one (v down), no flip needed.
    vec3 Ng = normalize(vPbNormal);
    vec3 dp1 = dFdx(vPbWorldPos), dp2 = dFdy(vPbWorldPos);
    vec2 duv1 = dFdx(vPbUv), duv2 = dFdy(vPbUv);
    vec3 dp2perp = cross(dp2, Ng), dp1perp = cross(Ng, dp1);
    vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
    vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
    float inv = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-20));
    vec2 xy = texture2D(normalMap, vPbUv).rg * 2.0 - 1.0;
    N = normalize(xy.x * T * inv + xy.y * B * inv + sqrt(max(1.0 - dot(xy, xy), 0.0)) * Ng); // bytecode: nrm r1.xyz
  }
  vec3 L = pbLightDir;
  vec4 LD = pbLightDiffuse * mtlDiffuse;     // g_vLightDiffuse0
  float a = D.a * LD.a;
  if (a <= alphaTest) discard;
  float nl = dot(L, N);
  float ndl = clamp(nl, 0.0, 1.0);
  vec3 R = 2.0 * nl * N - L;
  vec3 V = normalize(cameraPosition - vPbWorldPos);
  float rv = clamp(dot(R, V), 0.0, 1.0);
  // d3dPow: ps_2_x pow = exp2(y * log2(x)) with the D3D9 rule 0 * anything = 0, so pow(0, 0) = 1. GLSL pow(0, 0) is NaN:
  // spec maps with alpha 0 (as-50_beyond_spec, coltppython_holder_spec 100 %) painted every R.V = 0 texel black.
  vec3 spec = d3dPow(rv, mtlShininess) * pbLightSpecular.rgb * mtlSpecular; // g_vLightSpecular0
  if (hasSpec * pbSpecOn > 0.5) {
    vec4 S = texture2D(specMap, vPbUv);      // Phong_*S*: specMap.rgb*2 * pow(R.V, specMap.a*255)
    spec = S.rgb * 2.0 * d3dPow(rv, S.a * 255.0);
  }
  vec3 k = (D.rgb + ndl) * 0.3 + 1.0;
  vec3 c = LD.rgb * (ndl * (D.rgb * k + spec)) + D.rgb * pbAmbient;   // Phong_D_Dir_
  if (hasEmissive * pbReflectOn > 0.5) c += texture2D(emissiveMap, vPbUv).rgb * emissiveColor * 4.0; // Phong_*E*: E * g_vMtlEmissive * 4
  if (hasRef * pbHasEnv * pbReflectOn > 0.5) {
    // Phong_*RM*: rgb += texCUBE(g_texReflect, g_mInvView * reflect(nrm(viewPos), N)) * reflectMask.rgb (additive, unlit). Done in world space:
    // the world coordinates are the D3D ones (cubemap +Y face = sky, measured), so no axis swap. [INFERIDO] face orientation / no x flip.
    vec3 Rw = reflect(normalize(vPbWorldPos - cameraPosition), normalize(N));
    c += textureCube(pbEnvMap, Rw).rgb * texture2D(refMap, vPbUv).rgb;
  }
  if (pbRimOn + pbIblOn > 0.5) {
    // DX11 "máximo" (ini [DX11] RimLight / IBL): only booleans exist in the clients, the HLSL is encrypted.
    // Everything below is [RECRIADO]; constants are conservative guesses, not exe values.
    vec3 Nn = normalize(N);
    float mapLight = clamp(dot(pbAmbient + pbLightDiffuse.rgb, vec3(0.3333)), 0.0, 1.0); // dark map = no neon
    if (pbHasEnv * pbIblOn > 0.5) {
      // IBL diffuse: the env_ref.dds has no mips, so the CPU averaged each face (pbEnvAvg, cubeFaceAverages); blend the 6 colours by N^2
      // per axis (sign picks +/- face, same GL face order as the reflection sample) x albedo.
      vec3 w2 = Nn * Nn;
      vec3 irr = w2.x * (Nn.x >= 0.0 ? pbEnvAvg[0] : pbEnvAvg[1]) + w2.y * (Nn.y >= 0.0 ? pbEnvAvg[2] : pbEnvAvg[3]) + w2.z * (Nn.z >= 0.0 ? pbEnvAvg[4] : pbEnvAvg[5]);
      c += D.rgb * irr * 0.35;
      // IBL specular: sharp sample along reflect(V) x existing spec map (or its mean when hasSpec off), fresnel-weighted.
      vec3 Vi = normalize(cameraPosition - vPbWorldPos);
      float fres = 0.04 + 0.96 * pow(1.0 - clamp(dot(Nn, Vi), 0.0, 1.0), 5.0);
      vec3 sc = hasSpec > 0.5 ? texture2D(specMap, vPbUv).rgb : vec3(0.5);
      c += textureCube(pbEnvMap, reflect(-Vi, Nn), 2.0).rgb * sc * (0.25 + fres) * 0.5;
    }
    // Rim: pow(1-N.V, 3) * color * 0.5, additive, scaled by map light (ambient + directional).
    if (pbRimOn > 0.5) {
      float rim = pow(1.0 - clamp(dot(Nn, normalize(cameraPosition - vPbWorldPos)), 0.0, 1.0), 3.0);
      c += rim * vec3(0.85, 0.9, 1.0) * 0.5 * mapLight;
    }
  }
  c = clamp(c, 0.0, 1.0);
  gl_FragColor = vec4(useFog > 0.5 ? pbFog(c) : c, a);
}`;

// ---- materials ----------------------------------------------------------------------------------------------------

/** Textures are sampled raw like DX9 (the value in the file is the value the shader sees). */
function rawTexture(t: THREE.Texture | null | undefined): THREE.Texture | null {
  if (!t) return null;
  if (t.colorSpace !== THREE.NoColorSpace) {
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
  }
  return t;
}

function common(src: THREE.Material, m: THREE.ShaderMaterial): THREE.ShaderMaterial {
  m.name = src.name;
  m.side = src.side;
  m.transparent = src.transparent;
  m.opacity = src.opacity;
  m.depthWrite = src.depthWrite;
  m.depthTest = src.depthTest;
  m.blending = src.blending;
  m.toneMapped = false;
  m.userData.pb = true;
  return m;
}

/** Lightmapped world material (glTF: baseColor = diffuse, occlusionTexture uv1 = i3LuxMap). */
export function pbWorldMaterial(src: THREE.MeshStandardMaterial): THREE.ShaderMaterial {
  const lux = src.aoMap ?? src.lightMap;
  const m = new THREE.ShaderMaterial({
    vertexShader: WORLD_VS,
    fragmentShader: WORLD_FS,
    uniforms: {
      map: { value: rawTexture(src.map) },
      luxMap: { value: rawTexture(lux) },
      alphaTest: { value: src.alphaTest > 0 ? src.alphaTest : -1 },
      pbLightDiffuse: U.pbLightDiffuse,
      pbFogMode: U.pbFogMode,
      pbFogColor: U.pbFogColor,
      pbFogParams: U.pbFogParams,
    },
  });
  return common(src, m);
}

// Merged world (render/mapMerge.ts): same Phong_DLX_Dir_ maths, diffuse + lightmap fetched from texture arrays; the layer of
// each triangle's textures is a per-vertex attribute (pbLayer = diffuse layer, lux layer). Wrap / mips / filtering are per layer.
const WORLD_ARRAY_VS = /* glsl */ `
#include <common>
#ifndef USE_UV1
attribute vec2 uv1;
#endif
attribute vec2 pbLayer;
varying vec2 vPbUv;
varying vec2 vPbUv1;
varying vec2 vPbLayer;
varying float vPbFogDepth;
void main() {
  vPbUv = uv;
  vPbUv1 = uv1;
  vPbLayer = pbLayer;
  #include <begin_vertex>
  #include <project_vertex>
  vPbFogDepth = -mvPosition.z;
}`;

const WORLD_ARRAY_FS = /* glsl */ `
uniform sampler2DArray mapArr;
uniform sampler2DArray luxArr;
uniform vec4 pbLightDiffuse;
uniform float alphaTest;
varying vec2 vPbUv;
varying vec2 vPbUv1;
varying vec2 vPbLayer;
${FOG_PARS}
void main() {
  vec4 D = texture(mapArr, vec3(vPbUv, vPbLayer.x));
  vec3 L = texture(luxArr, vec3(vPbUv1, vPbLayer.y)).rgb;
  float a = D.a * pbLightDiffuse.a;
  if (a <= alphaTest) discard;
  vec3 c = 2.0 * D.rgb * (L * ((L + D.rgb) * 0.3 + 1.0)); // Phong_DLX_Dir_
  gl_FragColor = vec4(pbFog(clamp(c, 0.0, 1.0)), a);
}`;

/** World material over texture arrays (render/mapMerge.ts); `src` = a pbWorldMaterial whose state (side, alpha test...) it keeps. */
export function pbWorldArrayMaterial(src: THREE.ShaderMaterial, mapArr: THREE.Texture, luxArr: THREE.Texture): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    vertexShader: WORLD_ARRAY_VS,
    fragmentShader: WORLD_ARRAY_FS,
    uniforms: {
      mapArr: { value: mapArr },
      luxArr: { value: luxArr },
      alphaTest: { value: src.uniforms.alphaTest.value },
      pbLightDiffuse: U.pbLightDiffuse,
      pbFogMode: U.pbFogMode,
      pbFogColor: U.pbFogColor,
      pbFogParams: U.pbFogParams,
    },
  });
  return common(src, m);
}

/**
 * Per-object i3MaterialAttr state (what CGameCharaMaterialContext drives): diffuse.rgb = light-volume colour or the
 * stage DefaultDiffuse, specular (0,0,0) and shininess 12.8 = the i3MaterialAttr of the chara packs (Chara_*.i3Pack).
 */
export class PbMtl {
  readonly diffuse = { value: new THREE.Vector4(0.588, 0.588, 0.588, 1) };
  readonly specular = { value: new THREE.Vector3(0, 0, 0) };
  readonly shininess = { value: 12.8 };
  /** light-volume smoothing (exe 0x821e50): t accumulates, target/prev colours */
  private t = 1;
  private prev = new THREE.Vector3();
  private target = new THREE.Vector3();
  private primed = false;

  reset(): void {
    this.primed = false;
    this.t = 1;
  }

  /**
   * Every frame: t += dt. When t >= 0.033 s: prev = target, target = sphere query of the light volume (or the stage
   * DefaultDiffuse), t = 0. Otherwise diffuse = prev + (target - prev) * t * 30.303.
   */
  update(feet: THREE.Vector3, dt: number): void {
    const d = this.diffuse.value;
    if (!this.primed) {
      // first frame: no history to blend from
      queryLightVolume(feet, this.target);
      this.prev.copy(this.target);
      d.set(this.target.x, this.target.y, this.target.z, d.w);
      this.primed = true;
      this.t = 0;
      return;
    }
    this.t += dt;
    if (this.t >= LV_PERIOD) {
      this.prev.copy(this.target);
      queryLightVolume(feet, this.target);
      this.t = 0;
      return;
    }
    const f = Math.min(1, this.t * (1 / LV_PERIOD));
    d.set(this.prev.x + (this.target.x - this.prev.x) * f, this.prev.y + (this.target.y - this.prev.y) * f, this.prev.z + (this.target.z - this.prev.z) * f, d.w);
  }
}

/** The local player's material state, used by the 1st-person viewmodel (arms + weapon). */
export const PB_VIEWER_MTL = new PbMtl();
viewers.add(PB_VIEWER_MTL);

export function createPbMtl(): PbMtl {
  const m = new PbMtl();
  viewers.add(m);
  return m;
}

export function disposePbMtl(m: PbMtl): void {
  if (m !== PB_VIEWER_MTL) viewers.delete(m);
}

/** Character / weapon / viewmodel material (Phong_D_Dir_). `fog` = [NÃO CONFIRMADO] world fog on this object. */
export function pbCharaMaterial(src: THREE.Material, mtl: PbMtl, fog = false): THREE.ShaderMaterial {
  const s = src as THREE.MeshStandardMaterial;
  const map = rawTexture(s.map);
  const base = s.color ? s.color.clone() : new THREE.Color(1, 1, 1);
  if (!map) base.convertLinearToSRGB(); // flat-colour placeholders: author the hex as the DX colour
  const m = new THREE.ShaderMaterial({
    vertexShader: CHARA_VS,
    fragmentShader: CHARA_FS,
    uniforms: {
      map: { value: map },
      hasMap: { value: map ? 1 : 0 },
      normalMap: { value: null }, // lazy: only fetched with the Gráficos toggle that needs it (loadDetail)
      hasNormal: { value: 0 },
      specMap: { value: null },
      hasSpec: { value: 0 },
      refMap: { value: null }, // reflect mask (_Ref / _RefMask), lazy like normalMap
      hasRef: { value: 0 },
      emissiveMap: { value: null }, // _Emissive, lazy
      hasEmissive: { value: 0 },
      emissiveColor: { value: new THREE.Vector3().fromArray((s.userData.pbEmissiveColor as number[] | undefined) ?? [1, 1, 1]) }, // i3MaterialAttr emissive = g_vMtlEmissive
      pbEnvMap: U.pbEnvMap,
      pbHasEnv: U.pbHasEnv,
      baseColor: { value: new THREE.Vector3(base.r, base.g, base.b) },
      alphaTest: { value: s.alphaTest > 0 ? s.alphaTest : -1 },
      useFog: { value: fog ? 1 : 0 },
      mtlDiffuse: mtl.diffuse,
      mtlSpecular: mtl.specular,
      mtlShininess: mtl.shininess,
      pbNormalOn: U.pbNormalOn,
      pbSpecOn: U.pbSpecOn,
      pbReflectOn: U.pbReflectOn,
      pbRimOn: U.pbRimOn,
      pbIblOn: U.pbIblOn,
      pbEnvAvg: U.pbEnvAvg,
      pbAmbient: U.pbAmbient,
      pbLightDir: U.pbLightDir,
      pbLightDiffuse: U.pbLightDiffuse,
      pbLightSpecular: U.pbLightSpecular,
      pbFogMode: U.pbFogMode,
      pbFogColor: U.pbFogColor,
      pbFogParams: U.pbFogParams,
    },
  });
  if (s.userData.pbNormalUrl || s.userData.pbSpecUrl || s.userData.pbRefUrl || s.userData.pbEmissiveUrl) {
    m.userData.pbNormalUrl = s.userData.pbNormalUrl;
    m.userData.pbSpecUrl = s.userData.pbSpecUrl;
    m.userData.pbRefUrl = s.userData.pbRefUrl;
    m.userData.pbEmissiveUrl = s.userData.pbEmissiveUrl;
    detailPending.add(m);
    m.addEventListener("dispose", () => detailPending.delete(m));
    loadDetail(m);
  }
  return common(src, m);
}

/**
 * Swaps every mesh material under `root` for the PB chara shader bound to `mtl` (a character and its 3rd-person
 * weapon share one PbMtl, like the chara's material context drives both). Already-converted materials are kept.
 */
export function applyPbCharaLighting(root: THREE.Object3D, mtl: PbMtl): void {
  const done = new Map<THREE.Material, THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const conv = (mat: THREE.Material): THREE.Material => {
      if (mat.userData.pb || !mat.colorWrite) return mat; // PB already / shadow-only proxies
      let n = done.get(mat);
      if (!n) {
        n = pbCharaMaterial(mat, mtl);
        done.set(mat, n);
      }
      return n;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(conv) : conv(mesh.material);
  });
}

// ---- light volume (i3World LightVolumeCollision, <Map>_Light.i3s) --------------------------------------------------

const LV_PERIOD = 0.033; // exe 0x821e9c: 0.033 s between queries, lerp factor t * 30.303
/**
 * Sphere centre above the feet. [INFERIDO] 1.0 m: the up-facing light-volume planes sit at floorY + 1.0 m on every map
 * checked (construction 0 -> 1.0 and 4.09 -> 5.1, airport 6.0 -> 7.0, nstation 0.27 -> 1.3). A centre at 0.5 m only grazed
 * them (distance == radius), so the test missed and every chara fell back to DefaultDiffuse (dark).
 */
const LV_CENTER_Y = 1.0;
/** [NÃO CONFIRMADO] sphere radius comes from a chara DB float (exe 0x8221b0, [db+0x30]) not decoded yet. */
const LV_RADIUS = 0.5;
const CELL = 4;

interface LightVolume {
  p: Float32Array;
  t: Uint32Array;
  c: Float32Array; // rgb * 2 / 255 per triangle
  grid: Map<number, number[]>;
  /** per-triangle "visited in query #n" stamp (replaces a Set per query) */
  seen: Uint32Array;
  stamp: number;
}

/** numeric cell key (gx, gz are small signed ints: 4 m cells) */
const cellKey = (gx: number, gz: number): number => (gx + 32768) * 65536 + (gz + 32768);
let lightVolume: LightVolume | null = null;

function buildLightVolume(lv: NonNullable<PbLightingJson["lightVolume"]>): LightVolume {
  const p = Float32Array.from(lv.positions), t = Uint32Array.from(lv.tris);
  const c = new Float32Array(lv.colors.length);
  for (let i = 0; i < c.length; i++) c[i] = (lv.colors[i] * 2) / 255; // exe 0x822066: byte * (1/255) * 2
  const grid = new Map<number, number[]>();
  for (let k = 0; k < t.length / 3; k++) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let j = 0; j < 3; j++) {
      const i = t[k * 3 + j] * 3;
      x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
      z0 = Math.min(z0, p[i + 2]); z1 = Math.max(z1, p[i + 2]);
    }
    for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++)
      for (let gz = Math.floor(z0 / CELL); gz <= Math.floor(z1 / CELL); gz++) {
        const key = cellKey(gx, gz);
        let a = grid.get(key);
        if (!a) grid.set(key, (a = []));
        a.push(k);
      }
  }
  return { p, t, c, grid, seen: new Uint32Array(t.length / 3), stamp: 0 };
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _q = new THREE.Vector3();
const _tri = new THREE.Triangle();

/** avg colour of the light-volume triangles touching the sphere (centre feet + LV_CENTER_Y, radius LV_RADIUS), else DefaultDiffuse. */
export function queryLightVolume(feet: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  const lv = lightVolume;
  if (!lv) return out.copy(defaultDiffuse);
  const cx = feet.x, cy = feet.y + LV_CENTER_Y, cz = feet.z, r2 = LV_RADIUS * LV_RADIUS;
  _q.set(cx, cy, cz);
  const seen = lv.seen, stamp = ++lv.stamp; // Uint32 wrap after 4e9 queries: not reachable
  let n = 0, sr = 0, sg = 0, sb = 0;
  for (let gx = Math.floor((cx - LV_RADIUS) / CELL); gx <= Math.floor((cx + LV_RADIUS) / CELL); gx++)
    for (let gz = Math.floor((cz - LV_RADIUS) / CELL); gz <= Math.floor((cz + LV_RADIUS) / CELL); gz++) {
      const cell = lv.grid.get(cellKey(gx, gz));
      if (!cell) continue;
      for (const k of cell) {
        if (seen[k] === stamp) continue;
        seen[k] = stamp;
        const i0 = lv.t[k * 3] * 3, i1 = lv.t[k * 3 + 1] * 3, i2 = lv.t[k * 3 + 2] * 3;
        _tri.set(_a.fromArray(lv.p, i0), _b.fromArray(lv.p, i1), _c.fromArray(lv.p, i2));
        _tri.closestPointToPoint(_q, _b);
        if (_b.distanceToSquared(_q) > r2) continue;
        sr += lv.c[k * 3]; sg += lv.c[k * 3 + 1]; sb += lv.c[k * 3 + 2];
        n++;
      }
    }
  if (!n) return out.copy(defaultDiffuse);
  return out.set(sr / n, sg / n, sb / n);
}
