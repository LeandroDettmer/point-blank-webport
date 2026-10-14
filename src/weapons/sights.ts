/**
 * Weapon visual data exported from the 2017 client by pb-extract-tools export-weaponfx.mjs (public/assets/weapons/fx/weaponfx.json):
 * per-weapon sight / zoom / fire-effect / bullet-smoke info, the i3 particle effects (Fir_*, Hit_*, Hmk_*, Bul_*,
 * Env_TargetLaser_01, ExpHu01_*) and the tracer globals. No DOM, no three.js: shared by effects.ts, scope.ts, laser.ts.
 */

export type FxFunc = "none" | "const" | "sin" | "cos" | "rand" | "table" | number;
export interface FxTable { v: number[]; t?: number[] }
export interface FxChannel { func: FxFunc; init: number; factor: number; table: FxTable | null }
export interface FxSeq { loop: boolean; random: boolean; atSpawn: boolean; fw: number; fh: number; frameTime: number; count: number; start: number }
export interface FxParticle {
  name: string;
  type: "quad" | "sprite" | "mesh" | "billboard" | "stretch" | "decal" | string;
  emitterLife: number; life: number; mass: [number, number];
  initCount: number; maxCount: number; emitCount: number; oneShot: boolean;
  emitType: number; emitPos: number[]; emitDir: number[]; emitAngle: number; emitInterval: number; up: number[];
  jitterInterval: number; jitter: number[];
  posStyle: number; speed: FxChannel; accel: FxChannel; speedMinMax: [number, number];
  scaleStyle: number; scale: FxChannel; grow: FxChannel; scaleMinMax: [number, number];
  rotStyle: number; rot: FxChannel;
  colorStyle: number; rgbFunc: FxFunc; rgbInit: number; R: FxTable | null; G: FxTable | null; B: FxTable | null; A: FxTable | null;
  alphaFunc: FxFunc; alphaInit: number;
  scaleMask: number[]; rotRandom: number; speedRandom: number; scaleRandom: number; billboardFactor: number;
  tex: string | null; seq?: FxSeq; mesh?: string | true;
  /** [D3DBLEND src, dst] or null = opaque */
  blend: [number, number] | null;
  faceCamera: boolean; decal: boolean; zwrite: boolean; ztest: boolean;
  time: { start: number; duration: number; loop: boolean };
}
export interface FxEffect { particles: FxParticle[] }
export interface BulletSmoke { color: number[]; life: number; thickness: number; grow: number; startSpeed: number; endSpeed: number; repeat: number }
export interface WeaponFxInfo {
  fire?: string; fire1st?: string;
  /** Extension1/Type: Scope, DotSight, Dotsight, SteadyAim, Zoom, 3DScope, DualMag, ... */
  ext?: string; zoomType?: number;
  fovZoom?: number; fovScope?: number; fovScope2?: number; maxScopeLevel?: number;
  /** Cross ScopeType enum (0..28), the index into subScope[] (CHUD_Scope::SetSniperScope 0x736620 hardcodes the row per enum); absent = no ScopeType */
  subScope?: number; scopeTex?: string; scopePng?: string;
  /** the enum draws its dot only when the weapon is neither WeaponP90Ext nor WeaponDotLaser (0x7369b7 / 0x736a97): this one is */
  noScopeDot?: boolean;
  smoke?: BulletSmoke; tracerType?: number;
  /** laser class (pef ClassMeta WeaponDotLaser / *WithLaser): beam from FXLaserSightDummy + Env_TargetLaser_01 dot */
  laser?: string;
  /** the weapon model has FXLaserSightDummy */
  laserDummy?: boolean;
}
export interface SubScopeInfo { idx: number; dot: [number, number, number, number] | null; offDotLaser: boolean; scopeSound: boolean }
export interface WeaponFxData {
  globals: {
    tex: Record<string, string | null>;
    TracerBulletLength?: number; TracerBulletRate?: number; TracerBulletSpeed?: number; TracerBulletThickness?: number;
    [k: string]: unknown;
  };
  subScope: SubScopeInfo[];
  weapons: Record<string, WeaponFxInfo>;
  effects: Record<string, FxEffect>;
  fxList: Record<string, { count?: number; decal?: boolean; priority?: number }>;
}

let data: WeaponFxData | null = null;
let loading: Promise<WeaponFxData | null> | null = null;
let base = "/assets/weapons/fx";

/** Load weaponfx.json once (resolves null when missing: every consumer then keeps its [RECRIADO] fallback). */
export function loadWeaponFx(assetBase = "/assets/weapons"): Promise<WeaponFxData | null> {
  base = `${assetBase.replace(/\/$/, "")}/fx`;
  loading ??= fetch(`${base}/weaponfx.json`)
    .then((r) => (r.ok ? (r.json() as Promise<WeaponFxData>) : null))
    .catch(() => null)
    .then((d) => (data = d));
  return loading;
}
/** headless / tests: inject the parsed json and the folder its relative paths resolve against */
export function setWeaponFx(d: WeaponFxData, folder: string): void {
  data = d;
  base = folder.replace(/\/$/, "");
  loading = Promise.resolve(d);
}
export const weaponFx = (): WeaponFxData | null => data;
export const fxUrl = (rel: string): string => `${base}/${rel}`;
export const weaponFxInfo = (id: number): WeaponFxInfo | null => data?.weapons[String(id)] ?? null;

/**
 * Sight mode of a weapon while RMB is held, from Extension1 (Weapon.pef) + the exe:
 *  - "scope":  2D full-screen HUD texture (Gui/Hud/<ScopeType>; Cross: enum -> texture by CreateScopeHUD 0x736067, no scopePng = no overlay), viewmodel hidden, FovOnScope / FovOnScope2 levels
 *  - "zoom":   FovOnZoom only, the 1PV Zoom clip brings the sight to the eye (DotSight / SteadyAim / Zoom / 3DScope)
 *  - "none"
 */
export type SightMode = "scope" | "zoom" | "none";
export interface SightInfo {
  mode: SightMode;
  /** FOV per scope level (level 1 = index 0) */
  levels: number[];
  hud: string | null;
  /** red dot sub-rect [x, y, w, h] in HUD texture pixels (Cross: SetSniperScope 0x736834 switch per ScopeType, CROSS_SUB_HUD) */
  dot: [number, number, number, number] | null;
  hudSize: [number, number];
}

/**
 * CGameCharaCameraContext::SetScopeLevel 0x816b30 / CHUD_Scope::SetSniperScope 0x740f80: _ZoomType 3 weapons with a
 * ScopeType (Scope and DotSight alike) get the HUD overlay, the viewer's own character is hidden (AddFlag(2) 0x816c13)
 * and the FOV goes to FovOnScope (level 1) / FovOnScope2 (level 2, MaxScopeLevel >= 2) over 0.15 s. Other zoom types
 * only blend to FovOnZoom (0x816a10) with the viewmodel visible.
 */
export function sightInfo(id: number): SightInfo | null {
  const w = weaponFxInfo(id);
  if (!w) return null;
  const sub = w.noScopeDot ? null : data?.subScope.find((s) => s.idx === (w.subScope ?? 0)) ?? null;
  if (w.zoomType === 3 && w.scopePng && (w.fovScope ?? 0) > 0) {
    const levels = [w.fovScope!];
    if ((w.maxScopeLevel ?? 1) >= 2 && (w.fovScope2 ?? 0) > 0) levels.push(w.fovScope2!);
    return { mode: "scope", levels, hud: w.scopePng, dot: sub?.dot ?? null, hudSize: [512, 768] };
  }
  if ((w.fovZoom ?? 0) > 0) return { mode: "zoom", levels: [w.fovZoom!], hud: null, dot: null, hudSize: [512, 768] };
  return { mode: "none", levels: [], hud: null, dot: null, hudSize: [512, 768] };
}

/**
 * Cross WeaponDotLaser::OnUpdate 0x6457e0: flag = ScopeType != 0 (weapon info vf+0x1c4, 0x64582a). ScopeType 0 (scope.i3i,
 * offDotLaser) hides the world laser dot while zoomed (0x9e6130 AddFlag 3); any other enum keeps it, the laser dot being the
 * reticle seen through the sight. No ScopeType: the base info returns -1 (0x5bede0), the dot stays [INFERIDO: the gun class default].
 */
export function laserDotWhileScoped(id: number): boolean {
  const w = weaponFxInfo(id);
  if (w?.subScope === undefined) return true;
  const s = data?.subScope.find((x) => x.idx === w.subScope);
  return s ? !s.offDotLaser : true;
}

export interface ScopeDraw { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number; mirror: boolean }
/**
 * CHUD_Scope::CreateScopeHUD 0x740b40 layout (texture pixels -> screen pixels):
 *  area = full height H, width min(W, H*4/3) centred (0x740d30); sprite 0 = texture u 0..512 / v 0..768 in the left
 *  half, sprite 1 = the same mirrored in the right half, sprites 2/3 = the u 0..1 column stretched over the side bars,
 *  sprite 4 = the dot sub-rect (DotStartPos, DotWidthHeight) at native pixel size, centred (0x7411a6).
 */
export function scopeLayout(W: number, H: number, s: SightInfo): ScopeDraw[] {
  const [tw, th] = s.hudSize;
  // edges snapped to whole pixels: a fractional centre (odd W, H*4/3 not integer) left the two halves with partly transparent
  // edge columns, a thin see-through line down the middle of the scope that came and went with the window size
  const aw = Math.min(W, (H * 4) / 3), x0 = Math.round((W - aw) / 2), xm = Math.round((W - aw) / 2 + aw / 2), xe = Math.round((W - aw) / 2 + aw);
  const out: ScopeDraw[] = [
    { sx: 0, sy: 0, sw: tw, sh: th, dx: x0, dy: 0, dw: xm - x0, dh: H, mirror: false },
    { sx: 0, sy: 0, sw: tw, sh: th, dx: xm, dy: 0, dw: xe - xm, dh: H, mirror: true },
  ];
  if (x0 > 0) {
    out.push({ sx: 0, sy: 0, sw: 1, sh: th, dx: 0, dy: 0, dw: x0, dh: H, mirror: false });
    out.push({ sx: 0, sy: 0, sw: 1, sh: th, dx: xe, dy: 0, dw: W - xe, dh: H, mirror: false });
  }
  if (s.dot && s.dot[2] > 0 && s.dot[3] > 0) {
    const [dx, dy, dw, dh] = s.dot;
    out.push({ sx: dx, sy: dy, sw: dw, sh: dh, dx: Math.round(W / 2 - dw / 2), dy: Math.round(H / 2 - dh / 2), dw, dh, mirror: false });
  }
  return out;
}
