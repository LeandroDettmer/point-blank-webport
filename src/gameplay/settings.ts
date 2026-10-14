// Player options of the lobby's Configuração window (the exe's option popup: STR_POPUP_MOUSE_SENSITIVITY,
// STR_POPUP_INVERT_MOUSE, STR_POPUP_SET_SFX_VOLUME, STR_POPUP_SCREEN_BRIGHTNESS...), kept in localStorage and read
// live by the game (player look, audio, canvas brightness). Gauges use the popup's own 0..100 scales (their mapping
// onto the web game is [RECRIADO]); the mouse sensitivity is the exe's own value and formula (pbConfig.ts MOUSE_*).
import { CROSSHAIR_TYPES, type CrosshairType } from "../game/pbHud/layout.ts";
import { MOUSE_RAD_PER_COUNT, MOUSE_SENS_DEFAULT, MOUSE_SENS_MAX, MOUSE_SENS_MIN, MOUSE_SENS_STEP, PB_FPS_CAMERA } from "./pbConfig.ts";

export { MOUSE_SENS_MAX, MOUSE_SENS_MIN, MOUSE_SENS_STEP };

export const RENDER_SCALES = ["70", "100", "native", "150", "200"] as const;
export type RenderScale = (typeof RENDER_SCALES)[number];
export const LOBBY_UIS = ["cross"] as const;
export type LobbyUi = (typeof LOBBY_UIS)[number];

export interface GameSettings {
  /** the exe's option value, 0.10..1.20 (default 0.5); rad per mouse count = sensitivity * 0.005 */
  sensitivity: number;
  invertMouse: boolean;
  /** 0..100, "Volume: Efeitos sonoros": every game sound (weapons, steps, voices, radio, announcer, UI), linear
   *  (exe InitSound 0x6d4410: SetTypeVolume of types 0x40000 / 0x20000, gameplay/soundMix.ts) */
  sfxVolume: number;
  /** 0..100, 50 = unchanged */
  brightness: number;
  /** 1PV vertical FOV in degrees, PB_FPS_CAMERA range (default 70, 35..80) */
  fov: number;
  /** 0..100, 50 = same as sensitivity (no change) while aiming/zoomed; each 25 steps doubles / halves it */
  aimSensitivity: number;
  /** Option > Game "Exibir sangue" (STR_POPUP_DISPLAY_BLOOD): hit blood effect on / off */
  showBlood: boolean;
  /** Option > Sound "Volume: Músicas" (STR_POPUP_SETTING_BGM), 0..100: the BGM stream alone (type 0x10000), linear */
  bgmVolume: number;
  /** Option > Sound checkboxes of the BGM / effects rows (exe 0x87d475 / 0x87d482: both default on): unchecked = that type
   *  plays at 0 while its gauge value is kept (apply 0x889180) */
  bgmOn: boolean;
  sfxOn: boolean;
  /** Option > Sound "Volume: Interface" [RECRIADO] (user request 2026-10-12): the exe has no interface gauge (UI clips are effects-type
   *  sounds, InitSound 0x6d4410, and no STR names one); 0..100, linear, with its own on / off checkbox like the BGM / effects rows.
   *  Drives every UI clip (ui/uiClick.ts playUiSound); the effects row no longer touches them */
  uiVolume: number;
  uiOn: boolean;
  /** Option > Sound "Mensagem de rádio" (STR_POPUP_RADIO_MESSAGE): incoming radio lines and voices on / off */
  radioMessage: boolean;
  /** Option > Game "Efeito de texto" (STR_POPUP_DISPLAY_EFFECT): the kill banner text on / off */
  textEffect: boolean;
  /** Vídeo > "Texturas leves" [RECRIADO]: characters / weapons from the 256 px `models_lod` mirror (~10x less download); read when a model is first loaded */
  lowTextures: boolean;
  /** Vídeo > "Escala de renderização" [RECRIADO], live: see pixelRatioFor */
  renderScale: RenderScale;
  /** Vídeo / Gráficos > "Resolução dinâmica" [RECRIADO], live: the pixel ratio steps down (to ~70% of the renderScale) while the frame time misses the monitor's refresh, back up when it fits (main.ts) */
  dynamicRes: boolean;
  /** Gráficos > "Antialias" [RECRIADO]: MSAA of the WebGL context, so it applies to the next match (sharedRenderer rebuilds the renderer when it differs) */
  antialias: boolean;
  /** Gráficos tab [RECRIADO], all live, all off = the plain Phong_D look: */
  /** Normal Mapping: chara / weapon normal map (Phong_DN*) */
  normalMap: boolean;
  /** Specular: chara / weapon specular map (Phong_*S*) */
  specularMap: boolean;
  /** Reflexo: cubemap reflection x reflect mask (Phong_*RM*) + emissive map (Phong_*E*) */
  reflection: boolean;
  /** Rim Light (DX11 ini [DX11] RimLight) */
  rimLight: boolean;
  /** Image Based Light (DX11 ini [DX11] IBL): diffuse + specular from the map cubemap */
  ibl: boolean;
  /** Filtro anisotrópico (Tri-Linear): 16x anisotropy on every texture */
  anisotropic: boolean;
  /** Gráficos > "Efeitos de física" (STR_POPUP_PHYSICS_EFFECT; exe env PhysXEnable / Option opCapacityPhysX): the death ragdoll
   *  of the character's PhysX bodies (game/ragdoll.ts, DeathHuman 0x5738fa); off = the Death clip. Read at each death */
  ragdoll: boolean;
  /** Interface > "Interface do lobby" [RECRIADO]: 2017 = the Kaybo 2017 lobby, cross = the Point Blank Cross i3Gui one
   *  (lobby/screensCross). Default cross (user choice 2026-10-12). Read once by boot.ts, so it applies on the next load; ?lobby= in the URL wins over it */
  lobbyUi: LobbyUi;
}

/** NOT ORIGINAL (the D3D9 client has no DPR): 70 = 0.7 x cap, 100 = min(dpr, cap) (default), native = dpr, 150 / 200 = dpr x 1.5 / 2 (supersampling).
 *  maxPx = the GL's largest renderbuffer side: the ratio never takes the longest canvas side (cssPx) past it. */
export const PIXEL_RATIO_CAP = 1.5;
export const pixelRatioFor = (s: Pick<GameSettings, "renderScale">, dpr: number, cssPx = 0, maxPx = Infinity): number => {
  const capped = Math.min(dpr, PIXEL_RATIO_CAP);
  const r = { "70": capped * 0.7, "100": capped, native: dpr, "150": dpr * 1.5, "200": dpr * 2 }[s.renderScale] ?? capped;
  return cssPx > 0 ? Math.min(r, maxPx / cssPx) : r;
};

/** sfxVolume 100 / bgmVolume 60 = the account defaults of the server */
export const DEFAULT_SETTINGS: GameSettings = {
  sensitivity: MOUSE_SENS_DEFAULT, invertMouse: false, sfxVolume: 100, brightness: 50, fov: PB_FPS_CAMERA.fov, aimSensitivity: 50, showBlood: true,
  bgmVolume: 60, bgmOn: true, sfxOn: true, uiVolume: 100, uiOn: true, radioMessage: true, textEffect: true, lowTextures: false, renderScale: "100", dynamicRes: true, antialias: true,
  normalMap: true, specularMap: true, reflection: true, rimLight: false, ibl: true, anisotropic: true, ragdoll: false, lobbyUi: "cross", // new players: every Gráficos effect on except Rim Light and the ragdoll (user choice: the ragdoll lagged, 2026-10-12)
};
const KEY = "pb.settings";

let current: GameSettings = load();
/** the lobby interface this page load started with (boot.ts reads it once): the Option window warns while the saved one differs */
export const LOBBY_UI_AT_LOAD: LobbyUi = current.lobbyUi;
const listeners = new Set<(s: GameSettings) => void>();

/** exe 0x4cec2a: a stored value outside 0.10..1.20 falls back to the 0.5 default */
function sensOk(v: number): number {
  return Number.isFinite(v) && v >= MOUSE_SENS_MIN - 1e-6 && v <= MOUSE_SENS_MAX + 1e-6 ? Math.round(v * 100) / 100 : MOUSE_SENS_DEFAULT;
}

/** Saves before sensVer 2 kept sensitivity as a 0..100 gauge (rad/px = 0.0022 * 2^((v-50)/25), 50 = untouched default):
 *  convert to the exe's value with the same turn rate (untouched default -> 0.5). */
function migrateSensitivity(saved: Partial<GameSettings> & { sensVer?: number }): void {
  if (saved.sensVer === 2 || typeof saved.sensitivity !== "number") return;
  const v = saved.sensitivity;
  saved.sensitivity = v === 50 ? MOUSE_SENS_DEFAULT : Math.min(MOUSE_SENS_MAX, Math.max(MOUSE_SENS_MIN, Math.round((0.0022 * 2 ** ((v - 50) / 25) / MOUSE_RAD_PER_COUNT) * 100) / 100));
}

function load(): GameSettings {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    if (!raw) return { ...DEFAULT_SETTINGS };
    const saved = JSON.parse(raw) as Partial<GameSettings> & { sensVer?: number; detailMaps?: boolean; lowRes?: boolean; highRes?: boolean; bloom?: boolean; fxaa?: boolean };
    migrateSensitivity(saved);
    // the old single "Gráficos detalhados" switch = every detail effect on (dropped on the next save)
    if (saved.detailMaps) Object.assign(saved, { normalMap: true, specularMap: true, reflection: true, rimLight: true, ibl: true, anisotropic: true });
    delete saved.detailMaps;
    // the old lowRes / highRes pair = the single scale
    saved.renderScale ??= saved.lowRes ? "70" : saved.highRes ? "native" : "100";
    delete saved.lowRes; delete saved.highRes;
    // older saves had no interface gauge (UI clips followed the effects row): start it at the effects value
    if (typeof saved.uiVolume !== "number" || !Number.isFinite(saved.uiVolume)) saved.uiVolume = typeof saved.sfxVolume === "number" ? saved.sfxVolume : DEFAULT_SETTINGS.uiVolume;
    if (typeof saved.uiOn !== "boolean") saved.uiOn = typeof saved.sfxOn === "boolean" ? saved.sfxOn : true;
    saved.uiVolume = Math.max(0, Math.min(100, Math.round(saved.uiVolume)));
    delete (saved as { killBannersNew?: boolean }).killBannersNew; // banner art choice removed: the Cross art only
    delete saved.bloom; delete saved.fxaa; // "HDR e Bloom" and "Anti-aliasing (FXAA)" removed (FPS cost)
    delete (saved as { physicsEffects?: boolean }).physicsEffects; // renamed to ragdoll (default off): an old "on" from the first build does not carry over
    if (!RENDER_SCALES.includes(saved.renderScale)) saved.renderScale = "100";
    if (saved.lobbyUi !== undefined && !LOBBY_UIS.includes(saved.lobbyUi)) delete saved.lobbyUi;
    const s = { ...DEFAULT_SETTINGS, ...saved };
    s.sensitivity = sensOk(s.sensitivity);
    return s;
  } catch { return { ...DEFAULT_SETTINGS }; }
}

export function getSettings(): GameSettings { return current; }

export function saveSettings(s: GameSettings): void {
  const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
  current = { ...s, sensitivity: sensOk(s.sensitivity), sfxVolume: clamp(s.sfxVolume), bgmVolume: clamp(s.bgmVolume), uiVolume: clamp(s.uiVolume), brightness: clamp(s.brightness) };
  try { localStorage.setItem(KEY, JSON.stringify({ ...current, sensVer: 2 })); } catch { /* storage blocked: still applies this session */ }
  for (const l of listeners) l(current);
}

/** Called now and on every save; returns the unsubscribe. */
export function onSettings(fn: (s: GameSettings) => void): () => void {
  listeners.add(fn);
  fn(current);
  return () => listeners.delete(fn);
}

/** radians per mouse count, the exe's formula (0xa23e80): sensitivity * 0.005 (default 0.5 = 0.0025 rad = 0.143 deg) */
export const lookScale = (s = current): number => s.sensitivity * MOUSE_RAD_PER_COUNT;
/** [RECRIADO] extra multiplier on lookScale while aiming/zoomed (the exe has none: 50 = x1); each 25 steps doubles / halves it */
export const aimLookScale = (s = current): number => 2 ** ((s.aimSensitivity - 50) / 25);
/** gauge 0..100 -> linear gain: _calcCtxVolume multiplies the type volume in (0x100155c0), no curve; checkbox off = 0
 *  (exe 0x889180: SetTypeVolume(0x10000 BGM, gauge or 0); effects set both 0x40000 and 0x20000 from the one gauge) */
export const sfxGain = (s = current): number => (s.sfxOn ? s.sfxVolume / 100 : 0);
export const bgmGain = (s = current): number => (s.bgmOn ? s.bgmVolume / 100 : 0);
/** [RECRIADO] interface gauge -> linear gain of the UI clips, checkbox off = 0 */
export const uiGain = (s = current): number => (s.uiOn ? s.uiVolume / 100 : 0);
/** CSS brightness() factor: 0 -> 0.6, 50 -> 1, 100 -> 1.4 */
export const brightnessFactor = (s = current): number => 0.6 + (s.brightness / 100) * 0.8;

// ---- crosshair colour (the popup's STR_POPUP_CROSSHAIR row): an index into pbHud/layout.ts CROSSHAIR_COLORS, null =
// the default green. Its own key (older saves), shared by the lobby Configuração window and the in-battle one.
const CROSSHAIR_KEY = "pb.crosshairColor";
const crossListeners = new Set<(i: number | null) => void>();

export function crosshairIndex(): number | null {
  try {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem(CROSSHAIR_KEY) : null;
    return v === null || v === "" ? null : Number(v);
  } catch { return null; }
}

export function setCrosshairIndex(i: number | null): void {
  try { localStorage.setItem(CROSSHAIR_KEY, i === null || i < 0 ? "" : String(i)); } catch { /* storage blocked */ }
  const v = i === null || i < 0 ? null : i;
  for (const l of crossListeners) l(v);
}

// ---- crosshair type (the popup's Mira radios): the exe keeps the class name ("Crosshair_Cross" default, 0x4cd40a), so do we
const CROSSHAIR_TYPE_KEY = "pb.crosshairType";
const typeListeners = new Set<(t: CrosshairType) => void>();

export function crosshairType(): CrosshairType {
  try {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem(CROSSHAIR_TYPE_KEY) : null;
    return CROSSHAIR_TYPES.find((t) => t === v) ?? "Crosshair_Cross";
  } catch { return "Crosshair_Cross"; }
}

export function setCrosshairType(t: CrosshairType): void {
  try { localStorage.setItem(CROSSHAIR_TYPE_KEY, t); } catch { /* storage blocked */ }
  for (const l of typeListeners) l(t);
}

/** Called now and on every change; returns the unsubscribe (the HUD redraws live). */
export function onCrosshairType(fn: (t: CrosshairType) => void): () => void {
  typeListeners.add(fn);
  fn(crosshairType());
  return () => typeListeners.delete(fn);
}

/** Called now and on every change; returns the unsubscribe (the HUD recolours live). */
export function onCrosshair(fn: (i: number | null) => void): () => void {
  crossListeners.add(fn);
  fn(crosshairIndex());
  return () => crossListeners.delete(fn);
}
