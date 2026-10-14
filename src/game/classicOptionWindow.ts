// Option window ("Configuração") of the Point Blank Cross client, drawn from its own i3Gui layout:
// UI_Project_Popup.i3Pack (Popup_Option.gui) -> public/assets/ui/cross/UI_Project_Popup.json and
// the Cross atlases (main_ui_source01/02, main_grade). Positions, sizes and sprites are the file's; only the rows the web game can honour
// are shown (hit list in HIDDEN), restacked where the original left a hole. Texts are not in the file (the exe sets them
// by control name): the name -> STR key table below is [INFERIDO] from the control names. Values live in
// gameplay/settings.ts and apply live; Cancelar restores what they were when the window opened.
// Replaced the V12 Option_* window (the 3.123 UI generation) and the EpicBlackout option.json.
// Surface: create / open / close / isOpen / onClose / dispose.
import { Stage } from "../lobby/ui/LayoutRenderer.ts";
import { FONTS, UI_BASE, keepImage } from "../lobby/ui/assets.ts";
import { I3Gui, cloneNode as clone, findNode as find, relayout, renameTree, type Built, type GNode, type Img } from "../lobby/ui/i3Gui.ts";
import { loadStrings, tOr } from "../lobby/ui/i18n.ts";
import { jsonOnce } from "../jsonOnce.ts";
import { CROSSHAIR, CROSSHAIR_COLORS, type CrosshairType, crosshairShape } from "./pbHud/layout.ts";
import { DEFAULT_SETTINGS, type GameSettings, crosshairIndex, setCrosshairIndex, crosshairType, setCrosshairType, RENDER_SCALES, type RenderScale, LOBBY_UIS, type LobbyUi, LOBBY_UI_AT_LOAD, getSettings, MOUSE_SENS_MAX, MOUSE_SENS_MIN, MOUSE_SENS_STEP, saveSettings } from "../gameplay/settings.ts";
import { PB_FPS_CAMERA } from "../gameplay/pbConfig.ts";
import { isFullscreen, toggleFullscreen } from "../ui/fullscreen.ts";
import { playUiClick, playUiSound, UI_CLICK_OK, UI_CLICK_CANCEL } from "../ui/uiClick.ts";

/** The Point Blank Cross client's own Popup_Option in UI_Project_Popup (pb-extract-tools export-classic-ui.mjs): the same 276 controls at
 * the same rects and atlas cells (only opCommunityChatFilter* more, under the hidden community tab), drawn from the Cross atlases
 * main_ui_source01/02 + main_grade at their own sizes, with the exe's per-control text attributes (txt). */
const CROSS_BASE = `${UI_BASE}/cross`;
const P = PB_FPS_CAMERA;

/** window position in the 1024x768 design (the file keeps 576,198 of the exe's own layout: the popup is centred) */
const WIN_X = 316, WIN_Y = 121;

const TABS: Record<string, string> = { opPlay: "opPlaySect", opVideo: "opVideoSect", opInterface: "opInterfaceSect", opSound: "opSoundSect", opControl: "opControlSect", opGfx: "opGfxSect" };

/** Controls with no web equivalent (graphics options of the D3D9 client, key binding list, community / macro / voice tabs...). */
const HIDDEN = [
  "opGfxPhysics", // ragdoll toggle hidden (user choice 2026-10-12: lag risk); settings.ragdoll stays false
  "opCapacity", "opCommunity", "opMacro", "opVoice", "opOptimize", "opRating", "opRatingSect", "opCapacitySect", "opCommunitySect", "opMacroSect", "opVoiceSect",
  // Jogar: hit marker, weapon hand (and the separator under it), blood 2 ("Exibir sangue" and the crosshair type are real)
  "opPlaySeparate2", "opPlayHit", "opPlayHandType", "opPlayBlood2Key", "opPlayBloodRadio1",
  // Vídeo: only brightness and window mode
  "opVideoSmoothDistance", "opVideoScreenSync", "opVideoCapture", "opVideoAntiAliasing", "opVideoColor", "opVideoScanRate",
  // Interface: only "Efeito de texto" (the radar combo row is reused for the lobby interface)
  "opInterfaceSeparate1", "opInterfaceNickname", "opInterfaceMark", "opInterfaceChallenge", "opInterface1VS1",
  // Áudio: output device, voice combo
  "opSoundSpeaker", "opSoundVoiceCombo",
  // Controle: key bindings
  "opControlSeparate1", "opControlKeyboard", "opControlKeyButton", "opControlKeyDelete",
];

/** row restack (y inside the tab) where a hidden block left a hole */
const MOVE_Y: Record<string, number> = {
  opPlaySeparate1: 91, opPlayCrosshair: 111, opPlayCrosshairType1: 141, opPlayCrosshairType2: 141, opPlayCrosshairType3: 141, opPlayCrosshairType4: 141, // Hit row hidden: crosshair block moves up 29
  opVideoGamma: 60, opVideoWindowMode: 126, opVideoLowTex: 182, opVideoResolution: 238, opVideoDynRes: 294,
  opInterfaceEffect: 63, opInterfaceRadar: 119,
  opGfx: 241, // [RECRIADO] Gráficos tab button: the hidden "Capacidade" slot under Controle
  opControlReverse: 62, opControlMouse: 112, opControlAim: 182, opControlFov: 252,
};

/** Áudio rows restacked over the hidden output-device row: the file has speaker 60, separator 128, BGM 144, effects 211, separator 288, voice 301.
 *  ui = [RECRIADO] interface row (copy of the effects one) one effects step (67) under it; separator / voice move down by the same */
const SOUND_ROWS = { bgm: 60, effect: 127, ui: 194, separator2: 271, voice: 284 };

/** control name -> STR key + fallback (texts are set by the exe, not stored in the layout) [INFERIDO] */
const TEXT: Record<string, [key: string, fallback: string]> = {
  opOptionCaption: ["STR_POPUP_ENV_SETTING", "Configuração"],
  opPlay: ["STR_POPUP_GAME_PLAY", "Jogar"], opVideo: ["STR_POPUP_VIDEO", "Vídeo"], opInterface: ["STR_POPUP_OPTION_INTERFACE", "Interface"],
  opSound: ["STR_POPUP_SOUND", "Áudio"], opControl: ["STR_POPUP_OPTION_CONTROL", "Controle"],
  opInit: ["STR_POPUP_DEFAULT", "Padrão"], opConfirm: ["STBL_IDX_BUTTON_OK", "Confirmar"], opCancel: ["STBL_IDX_BUTTON_CANCEL", "Cancelar"],
  opPlayBloodKey: ["STR_POPUP_DISPLAY_BLOOD", "Exibir sangue"], opPlayCrosshairKey: ["STR_POPUP_CROSSHAIR", "Mira"],
  opVideoGammaKey: ["STR_POPUP_SCREEN_BRIGHTNESS", "Brilho"], opVideoWindowModeKey: ["STR_POPUP_WINDOW_MODE", "Modo de janela"],
  opVideoLowTexKey: ["", "Texturas leves (conexão lenta)"], // [RECRIADO]
  opVideoDynResKey: ["", "Resolução dinâmica"], opGfxDynResKey: ["", "Resolução dinâmica"], opGfxAntialiasKey: ["", "Antialias (próxima partida)"], // [RECRIADO] same setting in both tabs
  opVideoResolutionKey: ["", "Escala de renderização"], // [RECRIADO] the client's own combo control, repurposed
  opGfx: ["", "Gráficos"], // [RECRIADO] tab; rows = names of the official DX11 launcher
  opGfxNormalKey: ["", "Normal Mapping"], opGfxSpecKey: ["", "Specular"], opGfxReflectKey: ["", "Reflexo"], opGfxRimKey: ["", "Rim Light"],
  opGfxIblKey: ["", "Image Based Light"], opGfxAnisoKey: ["", "Filtro anisotrópico (Tri-Linear)"],
  opGfxPhysicsKey: ["STR_POPUP_PHYSICS_EFFECT", "Efeitos de física"], // the exe's own row (opCapacityPhysX), moved to Gráficos
  opInterfaceEffectKey: ["STR_POPUP_DISPLAY_EFFECT", "Efeito de texto"],
  opInterfaceRadarKey: ["", "Interface do lobby"], // [RECRIADO] the hidden radar combo row, repurposed (settings.lobbyUi)
  opInterfaceReload: ["STBL_IDX_GAMEKEY_RELOAD", "Recarregar"], // [RECRIADO] copy of the Padrão button: reloads the page so the lobby choice applies
  opSoundBgmKey: ["STR_POPUP_SETTING_BGM", "Volume: Músicas"], opSoundEffectKey: ["STR_POPUP_SET_SFX_VOLUME", "Volume: Efeito sonoros"],
  opSoundUiKey: ["", "Volume: Interface"], // [RECRIADO] no interface-volume STR in the Cross / 2017 strings (the exe has no such gauge)
  opSoundVoiceKey: ["STR_POPUP_RADIO_MESSAGE", "Mensagem de rádio"], // [INFERIDO] the row's combo is English / native language (0x889040 sets STR_POPUP_ENGLISH_LANGUAGE / NATIVE_LANGUAGE): a radio / voice language row, combo hidden
  opControlReverseKey: ["STR_POPUP_INVERT_MOUSE", "Inverter mouse"], opControlMouseKey: ["STR_POPUP_MOUSE_SENSITIVITY", "Sensibilidade do mouse"],
  opControlAimKey: ["", "Sensibilidade da mira"], // [RECRIADO] the client's popup has no zoomed-sensitivity row
  opControlFovKey: ["STR_POPUP_FIELD_OF_VIEW", "Ângulo de visão"],
};

interface GaugeDef { track: string; prev: string; next: string; thumb: string; value: string; min: number; max: number; step: number; /** digits shown and kept (the exe's mouse row prints "%.2f"); default 0 */ decimals?: number; get: (s: GameSettings) => number; set: (s: GameSettings, v: number) => void }
interface CheckDef { box: string; get: (s: GameSettings) => boolean; set: (s: GameSettings, v: boolean) => void }

const gauge = (base: string, parts: { track: string; value: string; prev?: string; next?: string; thumb?: string }, g: Pick<GaugeDef, "min" | "max" | "step" | "decimals" | "get" | "set">): GaugeDef =>
  ({ track: parts.track, prev: parts.prev ?? `${base}Prev`, next: parts.next ?? `${base}Next`, thumb: parts.thumb ?? `${base}Gage`, value: parts.value, ...g });

/**
 * BGM / effects rows (exe bind 0x87f0b6.., apply 0x889180): the checkbox is an enable flag (off = type volume 0, the gauge value is
 * kept and Prev / Next / the number box are disabled, 0x888ce0 / 0x888e90), the gauge is a bar that FILLS (Gage width =
 * (Next.x - Gage.x) * value / 100, hidden at 0: 0x889540) with no thumb and no drag; Prev / Next = -1 / +1, repeated every frame once held
 * 0.3 s (0x880730, 0xb52b38); the number box takes a typed integer 0..100 (0x889bd0), anything else is ignored.
 */
interface VolumeDef { row: string; get: (s: GameSettings) => number; set: (s: GameSettings, v: number) => void; on: (s: GameSettings) => boolean; setOn: (s: GameSettings, v: boolean) => void }
const VOLUMES: VolumeDef[] = [
  { row: "opSoundBgm", get: (s) => s.bgmVolume, set: (s, v) => (s.bgmVolume = v), on: (s) => s.bgmOn, setOn: (s, v) => (s.bgmOn = v) },
  { row: "opSoundEffect", get: (s) => s.sfxVolume, set: (s, v) => (s.sfxVolume = v), on: (s) => s.sfxOn, setOn: (s, v) => (s.sfxOn = v) },
  { row: "opSoundUi", get: (s) => s.uiVolume, set: (s, v) => (s.uiVolume = v), on: (s) => s.uiOn, setOn: (s, v) => (s.uiOn = v) }, // [RECRIADO]
];
/** hold-to-repeat of the arrows: first step on press, then one per frame after this delay (0x880730: time > 0.3) */
const HOLD_DELAY_MS = 300, HOLD_STEP_MS = 1000 / 60;
const GAUGES: GaugeDef[] = [
  gauge("opVideoGamma", { track: "opVideoGammaValue", value: "opVideoGammaNumber" }, { min: 0, max: 100, step: 5, get: (s) => s.brightness, set: (s, v) => (s.brightness = v) }),
  gauge("opControlMouse", { track: "opControlMouseGageBg", value: "opControlMouseValue", prev: "opControlMouseGagePrev", next: "opControlMouseGageNext" }, { min: MOUSE_SENS_MIN, max: MOUSE_SENS_MAX, step: MOUSE_SENS_STEP, decimals: 2, get: (s) => s.sensitivity, set: (s, v) => (s.sensitivity = v) }),
  gauge("opControlAim", { track: "opControlAimGageBg", value: "opControlAimValue", prev: "opControlAimGagePrev", next: "opControlAimGageNext" }, { min: 0, max: 100, step: 5, get: (s) => s.aimSensitivity, set: (s, v) => (s.aimSensitivity = v) }),
  gauge("opControlFov", { track: "opControlFovBg", value: "opControlFovValue" }, { min: P.fovMin, max: P.fovMax, step: 1, get: (s) => s.fov, set: (s, v) => (s.fov = v) }),
];
const CHECKS: CheckDef[] = [
  { box: "opPlayBlood", get: (s) => s.showBlood, set: (s, v) => (s.showBlood = v) },
  { box: "opInterfaceEffect", get: (s) => s.textEffect, set: (s, v) => (s.textEffect = v) },
  { box: "opSoundVoice", get: (s) => s.radioMessage, set: (s, v) => (s.radioMessage = v) },
  { box: "opVideoLowTex", get: (s) => s.lowTextures, set: (s, v) => (s.lowTextures = v) },
  { box: "opVideoDynRes", get: (s) => s.dynamicRes, set: (s, v) => (s.dynamicRes = v) },
  { box: "opGfxDynRes", get: (s) => s.dynamicRes, set: (s, v) => (s.dynamicRes = v) },
  { box: "opGfxAntialias", get: (s) => s.antialias, set: (s, v) => (s.antialias = v) },
  { box: "opGfxNormal", get: (s) => s.normalMap, set: (s, v) => (s.normalMap = v) },
  { box: "opGfxSpec", get: (s) => s.specularMap, set: (s, v) => (s.specularMap = v) },
  { box: "opGfxReflect", get: (s) => s.reflection, set: (s, v) => (s.reflection = v) },
  { box: "opGfxRim", get: (s) => s.rimLight, set: (s, v) => (s.rimLight = v) },
  { box: "opGfxIbl", get: (s) => s.ibl, set: (s, v) => (s.ibl = v) },
  { box: "opGfxAniso", get: (s) => s.anisotropic, set: (s, v) => (s.anisotropic = v) },
  { box: "opGfxPhysics", get: (s) => s.ragdoll, set: (s, v) => (s.ragdoll = v) },
  { box: "opControlReverse", get: (s) => s.invertMouse, set: (s, v) => (s.invertMouse = v) },
];

/**
 * Jogar > Mira radios -> type. Exe: Radio2 = CrossDot (idx 0), Radio1 = Cross (1), Radio4 = Ring (2), Radio3 = Dot (3)
 * (setter 0x886f10 lights idx 2 = state 2 of the radio; string write 0x885365). The Type1..4 frames sit under Radio1..4.
 */
const CROSSHAIR_RADIOS: [n: number, type: CrosshairType][] = [[1, "Crosshair_Cross"], [2, "Crosshair_CrossDot"], [3, "Crosshair_Dot"], [4, "Crosshair_Ring"]];
/** [INFERIDO] the frames are empty 51x49 boxes in the file; the exe's preview is not decoded: the shape is drawn as in battle at a fixed spread */
const PREVIEW_SPREAD_DEG = 17.7;
/** preview is drawn in a half-size box and scaled x2 (pixelated) so the 5 px lines of the real crosshair stay legible in the 51x49 frame */
const PREVIEW_ZOOM = 2;
/** [RECRIADO] "Cor da mira" row (in the original the colour is a cash item): y inside the tab, swatch size / gap */
const COLOR_ROW = { y: 226, swatchY: 246, size: 16, gap: 3, x: 14 };

/** Vídeo > render scale combo labels [RECRIADO] (supersampling is NOT ORIGINAL) */
const SCALE_LABEL: Record<RenderScale, string> = { "70": "70%", "100": "100%", native: "Nativa", "150": "150%", "200": "200%" };
const POPUP_ROW_H = 17;
/** Interface > lobby combo labels [RECRIADO] */
const LOBBY_LABEL: Record<LobbyUi, string> = { cross: "Cross" };
/** [RECRIADO] restart note + Recarregar button under the lobby combo (y inside the tab), shown while the saved lobby differs from this load's */
const LOBBY_NOTE_Y = 166, LOBBY_RELOAD_Y = 206; // under the lobby UI row (y 119; the kill banner row above it was removed)

/** Áudio restacked over the hidden output-device row (its separator is dropped, the second one moves up) */
function restackSound(root: GNode): void {
  const sect = find(root, "opSoundSect");
  if (!sect?.children) return;
  const y = (name: string, v: number) => { const n = find(sect, name); if (n) n.y = v; };
  const fx = find(sect, "opSoundEffect");
  if (fx) { const ui = clone(fx); renameTree(ui, "opSoundEffect", "opSoundUi"); sect.children.push(ui); } // [RECRIADO] interface volume row
  y("opSoundBgm", SOUND_ROWS.bgm);
  y("opSoundEffect", SOUND_ROWS.effect);
  y("opSoundUi", SOUND_ROWS.ui);
  y("opSoundVoice", SOUND_ROWS.voice);
  const seps = sect.children.filter((c) => c.name === "opSoundSeparate1");
  if (seps[0]) seps[0].images = [];
  if (seps[1]) seps[1].y = SOUND_ROWS.separator2;
}

/** [RECRIADO] Vídeo > low textures: a copy of the window mode row (the client has no such row) */
function withLowTexRow(root: GNode): void {
  const sect = find(root, "opVideoSect"), src = sect && find(sect, "opVideoWindowMode");
  if (!sect?.children || !src) return;
  const row = clone(src);
  renameTree(row, "opVideoWindowMode", "opVideoLowTex");
  sect.children.push(row);
  const dyn = clone(src); // [RECRIADO] Resolução dinâmica row, same shape
  renameTree(dyn, "opVideoWindowMode", "opVideoDynRes");
  sect.children.push(dyn);
}

/** [RECRIADO] Gráficos tab: the Controle tab button + a section shell with one checkbox row (copy of the window mode row) per effect */
const GFX_ROWS = ["opGfxNormal", "opGfxSpec", "opGfxReflect", "opGfxRim", "opGfxIbl", "opGfxAniso", "opGfxDynRes", "opGfxAntialias", "opGfxPhysics"];
const GFX_Y0 = 60, GFX_STEP = 35; // 9 rows must fit the 385 px frame (last at y 340, as before)

function withGraphicsTab(root: GNode): void {
  const frame = find(root, "opFrame"), vsect = find(root, "opVideoSect"), mode = vsect && find(vsect, "opVideoWindowMode"), ctl = find(root, "opControl");
  if (!frame?.children || !vsect || !mode || !ctl) return;
  const tab = clone(ctl);
  renameTree(tab, "opControl", "opGfx");
  root.children?.push(tab);
  const sect = clone(vsect);
  renameTree(sect, "opVideo", "opGfx");
  sect.children = GFX_ROWS.map((name, i) => {
    const row = clone(mode);
    renameTree(row, "opVideoWindowMode", name);
    row.y = GFX_Y0 + i * GFX_STEP;
    return row;
  });
  frame.children.push(sect);
}

/** [RECRIADO] Interface > Recarregar: a copy of the Padrão button inside the tab */
function withLobbyReload(root: GNode): void {
  const sect = find(root, "opInterfaceSect"), src = find(root, "opInit");
  if (!sect?.children || !src) return;
  const b = clone(src);
  renameTree(b, "opInit", "opInterfaceReload");
  b.x = 21; b.y = LOBBY_RELOAD_Y;
  sect.children.push(b);
}

/** [RECRIADO] Controle > aim sensitivity: a copy of the mouse row (the client has no such row) */
function withAimRow(root: GNode): void {
  const sect = find(root, "opControlSect"), src = sect && find(sect, "opControlMouse");
  if (!sect?.children || !src) return;
  const row = clone(src);
  renameTree(row, "opControlMouse", "opControlAim");
  sect.children.push(row);
}

export class ClassicOptionWindow {
  private stage: Stage;
  private gui: I3Gui;
  private get byName(): Map<string, Built> { return this.gui.byName; }
  private current = "opPlay";
  private snapshot: GameSettings = getSettings();
  private typeSnapshot: CrosshairType = crosshairType();
  private colorSnapshot: number | null = crosshairIndex();
  private abort = new AbortController();
  private opened = false;
  private refreshers: (() => void)[] = [];
  /** called after the window closes */
  onClose: (() => void) | null = null;

  private constructor(host: HTMLElement, tree: GNode, private inBattle: boolean) {
    this.gui = new I3Gui({
      base: CROSS_BASE,
      text: (n) => { const t = TEXT[n.name]; return t ? tOr(t[0], t[1]) : undefined; },
      caption: (n) => n.name === "opOptionCaption",
    });
    restackSound(tree);
    withAimRow(tree);
    withLowTexRow(tree);
    withLobbyReload(tree);
    withGraphicsTab(tree);
    this.stage = new Stage(host, 1024, 768, true); // the Cross i3Gui stretches X / Y
    this.stage.el.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:60;display:none;";
    this.build(tree, this.stage.design, WIN_X - tree.x, WIN_Y - tree.y);
    for (const n of HIDDEN) this.hide(n);
    for (const [n, y] of Object.entries(MOVE_Y)) { const b = this.byName.get(n); if (b) b.el.style.top = `${y}px`; }
    this.wire();
  }

  /** Match preload (game/matchPreload.ts): option.json + the two atlases decoded, so the first ESC > Opções draws at once. */
  static async preload(): Promise<void> {
    await Promise.all([loadStrings(), jsonOnce(`${CROSS_BASE}/UI_Project_Popup.json`)]);
    keepImage(`${CROSS_BASE}/atlas/main_ui_source01.png`, true);
    keepImage(`${CROSS_BASE}/atlas/main_ui_source02.png`, true);
  }

  /** inBattle: opened from the ESC menu, where Recarregar would drop the match (only the note shows) */
  static async create(host: HTMLElement, inBattle = false): Promise<ClassicOptionWindow> {
    await loadStrings();
    const root = find((await jsonOnce<{ root: GNode }>(`${CROSS_BASE}/UI_Project_Popup.json`)).root, "opOptionWin");
    if (!root) throw new Error("[option] no opOptionWin in UI_Project_Popup.json");
    // the window mutates its tree (restackSound ...): build from a copy, the cached object stays as exported
    return new ClassicOptionWindow(host, structuredClone(root), inBattle);
  }

  // ---- drawing (lobby/ui/i3Gui.ts) -------------------------------------------------------------------------------
  private build(n: GNode, parent: HTMLElement, ox = 0, oy = 0): HTMLElement { return this.gui.build(n, parent, ox, oy); }
  private setText(name: string, s: string): void { this.gui.setText(name, s); }
  private setState(name: string, i: number): void { this.gui.setState(name, i); }
  private hide(name: string): void { this.gui.hide(name); }

  // ---- behaviour --------------------------------------------------------------------------------------------------
  private commit(fn: (s: GameSettings) => void): void {
    const s = { ...getSettings() };
    fn(s);
    saveSettings(s);
    this.refresh();
  }

  private refresh(): void {
    for (const f of this.refreshers) f();
  }

  private hover(name: string, base = 0): void {
    const b = this.byName.get(name);
    if (!b?.states.length) return;
    b.el.style.cursor = "pointer";
    b.el.addEventListener("pointerenter", () => this.setState(name, 1));
    b.el.addEventListener("pointerleave", () => this.setState(name, base));
  }

  private wire(): void {
    const stop = (e: Event) => e.stopPropagation();
    this.stage.el.addEventListener("click", stop);
    // tabs
    for (const [tab, sect] of Object.entries(TABS)) {
      const b = this.byName.get(tab);
      if (!b) continue;
      b.el.style.cursor = "pointer";
      b.el.addEventListener("click", () => { playUiClick(); this.showTab(tab); });
      b.el.addEventListener("pointerenter", () => { if (this.current !== tab) this.setState(tab, 1); });
      b.el.addEventListener("pointerleave", () => { if (this.current !== tab) this.setState(tab, 0); });
      void sect;
    }
    // bottom buttons
    // sounds = the layout's I3GUI_EVENT_DATA: only the tabs (TAB), opConfirm (OK) and opCancel (CANCEL) have one
    const button = (name: string, fn: () => void, sound?: string) => {
      const b = this.byName.get(name);
      if (!b) return;
      this.hover(name);
      b.el.addEventListener("click", () => { if (sound) playUiSound(sound); fn(); });
    };
    button("opInit", () => { saveSettings({ ...DEFAULT_SETTINGS }); setCrosshairType("Crosshair_Cross"); setCrosshairIndex(null); this.refresh(); });
    button("opConfirm", () => this.close(), UI_CLICK_OK);
    button("opCancel", () => { saveSettings(this.snapshot); setCrosshairType(this.typeSnapshot); setCrosshairIndex(this.colorSnapshot); this.close(); }, UI_CLICK_CANCEL);
    this.wireCrosshairTypes();
    // checkboxes (the box and its label toggle)
    for (const c of CHECKS) {
      const b = this.byName.get(c.box);
      if (!b) continue;
      b.el.style.cursor = "pointer";
      b.el.addEventListener("click", () => { this.commit((s) => c.set(s, !c.get(getSettings()))); });
      this.refreshers.push(() => this.paintCheck(c.box, c.get(getSettings())));
    }
    // window mode: checked = windowed, toggles the browser's full screen
    this.wireWindowMode();
    this.wireCombo("opVideoResolution", RENDER_SCALES, SCALE_LABEL, (s) => s.renderScale, (s, v) => (s.renderScale = v));
    this.wireCombo("opInterfaceRadar", LOBBY_UIS, LOBBY_LABEL, (s) => s.lobbyUi, (s, v) => (s.lobbyUi = v));
    this.wireLobbyNote();
    for (const v of VOLUMES) this.wireVolume(v);
    for (const g of GAUGES) this.wireGauge(g);
    window.addEventListener("keydown", (e) => {
      if (!this.opened || e.code !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      saveSettings(this.snapshot);
      setCrosshairType(this.typeSnapshot);
      setCrosshairIndex(this.colorSnapshot);
      this.close();
    }, { signal: this.abort.signal, capture: true });
  }

  /** one BGM / effects row, see VOLUMES */
  private wireVolume(v: VolumeDef): void {
    const check = this.byName.get(v.row), gage = this.byName.get(`${v.row}Gage`), next = this.byName.get(`${v.row}Next`), prev = this.byName.get(`${v.row}Prev`), val = this.byName.get(`${v.row}Value`);
    if (!check || !gage || !next || !prev || !val) return;
    check.el.style.cursor = "pointer";
    check.el.addEventListener("click", () => this.commit((s) => v.setOn(s, !v.on(s))));
    const set = (n: number) => this.commit((s) => v.set(s, Math.max(0, Math.min(100, Math.round(n)))));
    // arrows: -1 / +1 on press, then one per frame after 0.3 s held; dead while the row's checkbox is off
    for (const [b, d] of [[prev, -1], [next, 1]] as const) {
      let delay = 0, tick = 0;
      const stop = () => { clearTimeout(delay); clearInterval(tick); };
      b.el.addEventListener("click", (e) => e.stopPropagation());
      b.el.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        if (!v.on(getSettings())) return;
        stop();
        set(v.get(getSettings()) + d);
        delay = window.setTimeout(() => { tick = window.setInterval(() => set(v.get(getSettings()) + d), HOLD_STEP_MS); }, HOLD_DELAY_MS);
      });
      for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.el.addEventListener(ev, stop);
      b.el.addEventListener("pointerenter", () => { if (v.on(getSettings())) this.setState(b.node.name, 1); });
      b.el.addEventListener("pointerleave", () => { this.setState(b.node.name, v.on(getSettings()) ? 0 : 2); });
      this.abort.signal.addEventListener("abort", stop);
    }
    // the number box is an edit box: Enter / leaving it applies a typed integer 0..100, anything else is dropped
    val.el.querySelector(":scope > .op-text")?.remove();
    const input = document.createElement("input");
    input.type = "text"; input.inputMode = "numeric"; input.maxLength = 3;
    input.style.cssText = `position:absolute;left:0;top:0;width:${val.node.w}px;height:${val.node.h}px;box-sizing:border-box;padding:0;border:0;outline:0;background:transparent;text-align:center;font:bold 11px ${FONTS.popup};color:#c9ced6;text-shadow:1px 1px 0 rgba(0,0,0,.8);`;
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.code === "Enter" || e.code === "NumpadEnter") input.blur(); });
    input.addEventListener("change", () => { if (/^\d{1,3}$/.test(input.value) && +input.value <= 100) set(+input.value); else this.refresh(); });
    val.el.appendChild(input);
    // the gauge: a filled bar from the Gage x to the Next arrow, hidden at 0
    const img = gage.node.images?.[0], full = next.node.x - gage.node.x, bar = gage.el.firstElementChild as HTMLElement | null;
    this.refreshers.push(() => {
      const s = getSettings(), on = v.on(s), n = v.get(s), w = full * n / 100;
      this.paintCheck(v.row, on);
      gage.el.style.display = n > 0 ? "" : "none";
      gage.el.style.width = `${w}px`;
      if (bar && img) bar.style.transform = `scale(${w / img[5]},${img[8] / img[6]})`;
      if (document.activeElement !== input) input.value = String(n);
      input.readOnly = !on;
      for (const b of [prev, next]) { this.setState(b.node.name, on ? 0 : 2); b.el.style.cursor = on ? "pointer" : "default"; }
    });
  }

  /** Mira: one radio + preview frame per type; a click on either selects it (live in battle and lobby through onCrosshairType) */
  private wireCrosshairTypes(): void {
    const previews = CROSSHAIR_RADIOS.map(([n, type]) => {
      const frame = this.byName.get(`opPlayCrosshairType${n}`), radio = this.byName.get(`opPlayCrosshairRadio${n}`);
      if (!frame) return null;
      frame.states.forEach((st) => (st.style.display = "none")); // the file's sprites are the exe's own preview art (corner pieces): frame drawn blank
      const cv = document.createElement("canvas");
      cv.width = frame.node.w; cv.height = frame.node.h;
      cv.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;";
      frame.el.appendChild(cv);
      for (const b of [frame, radio]) if (b) { b.el.style.cursor = "pointer"; b.el.addEventListener("click", () => { setCrosshairType(type); this.refresh(); }); }
      return { cv, type, radio: `opPlayCrosshairRadio${n}` };
    });
    this.refreshers.push(() => {
      const cur = crosshairType(), ci = crosshairIndex(), col = ci === null ? CROSSHAIR.color : CROSSHAIR_COLORS[ci] ?? CROSSHAIR.color;
      for (const p of previews) {
        if (!p) continue;
        this.setState(p.radio, p.type === cur ? 2 : 0);
        const g = p.cv.getContext("2d");
        if (!g) continue;
        g.clearRect(0, 0, p.cv.width, p.cv.height);
        const c = `rgb(${col[0]},${col[1]},${col[2]})`, vw = Math.floor(p.cv.width / PREVIEW_ZOOM), vh = Math.floor(p.cv.height / PREVIEW_ZOOM);
        const sh = crosshairShape(p.type, vw, vh, PREVIEW_SPREAD_DEG);
        g.save();
        g.translate((p.cv.width - vw * PREVIEW_ZOOM) / 2, (p.cv.height - vh * PREVIEW_ZOOM) / 2);
        g.scale(PREVIEW_ZOOM, PREVIEW_ZOOM);
        g.fillStyle = c; g.strokeStyle = c; g.lineWidth = 1;
        for (const r of sh.rects) g.fillRect(Math.round(r.x), Math.round(r.y), r.w, r.h);
        if (sh.poly) { g.beginPath(); sh.poly.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill(); }
        if (sh.loop) { g.beginPath(); sh.loop.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.stroke(); }
        g.restore();
      }
    });
    this.wireCrosshairColors();
  }

  /** [RECRIADO] "Cor da mira": default green + the 11 colours of the exe table (0xb2fe2c); same key as the cash item (setCrosshairIndex) */
  private wireCrosshairColors(): void {
    const sect = this.byName.get("opPlaySect");
    if (!sect) return;
    const R = COLOR_ROW, lab = document.createElement("div");
    lab.className = "op-text";
    lab.textContent = "Cor da mira";
    lab.style.cssText = `position:absolute;left:${R.x}px;top:${R.y}px;height:20px;line-height:20px;white-space:nowrap;pointer-events:none;font:bold 11px ${FONTS.popup};color:#c9ced6;text-shadow:1px 1px 0 rgba(0,0,0,.8);`;
    sect.el.appendChild(lab);
    const options: (number | null)[] = [null, ...CROSSHAIR_COLORS.map((_, i) => i)];
    const sw = options.map((idx, k) => {
      const c = idx === null ? CROSSHAIR.color : CROSSHAIR_COLORS[idx], d = document.createElement("div");
      d.style.cssText = `position:absolute;left:${R.x + k * (R.size + R.gap)}px;top:${R.swatchY}px;width:${R.size}px;height:${R.size}px;box-sizing:border-box;cursor:pointer;background:rgb(${c[0]},${c[1]},${c[2]});`;
      d.addEventListener("click", () => { setCrosshairIndex(idx); this.refresh(); });
      sect.el.appendChild(d);
      return { d, idx };
    });
    this.refreshers.push(() => {
      const cur = crosshairIndex();
      for (const s of sw) s.d.style.border = s.idx === cur ? "2px solid #fff" : "1px solid #000";
    });
  }

  /** checkbox art: the box is always drawn, the tick (5th image) while set */
  private paintCheck(name: string, on: boolean): void { this.gui.paintCheck(name, on); }

  private wireWindowMode(): void {
    const b = this.byName.get("opVideoWindowMode");
    if (!b) return;
    b.el.style.cursor = "pointer";
    b.el.addEventListener("click", () => { void toggleFullscreen(); });
    document.addEventListener("fullscreenchange", () => this.paintCheck("opVideoWindowMode", !isFullscreen()), { signal: this.abort.signal });
    this.refreshers.push(() => this.paintCheck("opVideoWindowMode", !isFullscreen()));
  }

  /** a combo of the original layout (<base>Combo / Button / Popup): box + arrow button open the Dropdown popup, one row per value */
  private wireCombo<T extends string>(base: string, values: readonly T[], label: Record<T, string>, get: (s: GameSettings) => T, setV: (s: GameSettings, v: T) => void): void {
    const combo = this.byName.get(`${base}Combo`), button = this.byName.get(`${base}Button`), popup = this.byName.get(`${base}Popup`);
    if (!combo || !popup) return;
    const pad = 4, h = values.length * POPUP_ROW_H + pad * 2;
    popup.el.innerHTML = "";
    popup.el.style.cssText += `height:${h}px;display:none;z-index:5;`;
    popup.node.h = h;
    this.gui.pieces(popup.el, relayout((popup.node.images ?? []) as Img[], popup.node.w, h));
    // the open list sits over the controls after it: the combo and its ancestors are raised (sealed pieces isolate a control)
    const lift = (on: boolean) => { for (let e: HTMLElement | null = combo.el; e && e !== this.stage.design; e = e.parentElement) e.style.zIndex = on ? "5" : ""; };
    const close = () => { popup.el.style.display = "none"; lift(false); };
    const rows = values.map((v, i) => {
      const r = document.createElement("div");
      r.className = "op-text";
      r.textContent = label[v];
      r.style.cssText = `position:absolute;left:8px;top:${pad + i * POPUP_ROW_H}px;width:${popup.node.w - 16}px;height:${POPUP_ROW_H}px;line-height:${POPUP_ROW_H}px;cursor:pointer;font:bold 11px ${FONTS.popup};color:#c9ced6;`;
      r.addEventListener("pointerenter", () => (r.style.background = "rgba(255,255,255,.18)"));
      r.addEventListener("pointerleave", () => (r.style.background = ""));
      r.addEventListener("click", (e) => { e.stopPropagation(); close(); this.commit((s) => setV(s, v)); });
      popup.el.appendChild(r);
      return r;
    });
    const toggle = (e: Event) => { e.stopPropagation(); const open = popup.el.style.display === "none"; popup.el.style.display = open ? "" : "none"; lift(open); };
    for (const b of [combo, button]) if (b) { b.el.style.cursor = "pointer"; b.el.addEventListener("click", toggle); }
    if (button) this.hover(`${base}Button`);
    // any other click on the window (or switching tab / closing) folds the list
    this.stage.el.addEventListener("click", close);
    this.refreshers.push(() => {
      const cur = get(getSettings());
      this.setText(`${base}Combo`, label[cur]);
      rows.forEach((r, i) => (r.style.color = values[i] === cur ? "#fff" : "#c9ced6"));
      close();
    });
  }

  /** lobby interface applies on the next load (boot.ts reads it once): note + Recarregar while it differs from this load's */
  private wireLobbyNote(): void {
    const sect = this.byName.get("opInterfaceSect"), reload = this.byName.get("opInterfaceReload");
    if (!sect || !reload) return;
    const note = document.createElement("div");
    note.className = "op-text";
    note.textContent = tOr("STBL_IDX_EP_OPTION_RESTART_MESSAGE", "A mudança será aplicada na próxima vez que abrir o jogo.");
    note.style.cssText = `position:absolute;left:21px;top:${LOBBY_NOTE_Y}px;width:220px;white-space:normal;font:bold 11px ${FONTS.popup};color:#e8c060;`;
    sect.el.appendChild(note);
    this.hover("opInterfaceReload");
    reload.el.addEventListener("click", () => { playUiClick(); location.reload(); });
    this.refreshers.push(() => {
      const show = getSettings().lobbyUi !== LOBBY_UI_AT_LOAD;
      note.style.display = show ? "" : "none";
      reload.el.style.display = show && !this.inBattle ? "" : "none";
    });
  }

  private wireGauge(g: GaugeDef): void {
    const track = this.byName.get(g.track), thumb = this.byName.get(g.thumb), prev = this.byName.get(g.prev), next = this.byName.get(g.next);
    if (!track || !thumb) return;
    const x0 = prev ? prev.node.x + prev.node.w : 23, x1 = (next ? next.node.x : track.node.w) - thumb.node.w;
    const set = (v: number) => this.commit((s) => g.set(s, Math.max(g.min, Math.min(g.max, Math.round(v * 10 ** (g.decimals ?? 0)) / 10 ** (g.decimals ?? 0)))));
    if (prev) { this.hover(g.prev); prev.el.addEventListener("click", () => set(g.get(getSettings()) - g.step)); }
    if (next) { this.hover(g.next); next.el.addEventListener("click", () => set(g.get(getSettings()) + g.step)); }
    const at = (e: PointerEvent) => {
      const r = track.el.getBoundingClientRect(), k = r.width / track.node.w;
      const t = Math.max(0, Math.min(1, ((e.clientX - r.left) / k - x0 - thumb.node.w / 2) / (x1 - x0)));
      set(g.min + t * (g.max - g.min));
    };
    track.el.style.cursor = "pointer";
    // the volume rows nest the gauge inside the mute checkbox: a click on the gauge must not bubble up and toggle the mute
    track.el.addEventListener("click", (e) => e.stopPropagation());
    this.byName.get(g.value)?.el.addEventListener("click", (e) => e.stopPropagation());
    track.el.addEventListener("pointerdown", (e) => { if (e.target !== prev?.el && e.target !== next?.el && !prev?.el.contains(e.target as Node) && !next?.el.contains(e.target as Node)) { try { track.el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } at(e); } });
    track.el.addEventListener("pointermove", (e) => { if (e.buttons & 1 && track.el.hasPointerCapture?.(e.pointerId)) at(e); });
    this.refreshers.push(() => {
      const v = g.get(getSettings()), t = (v - g.min) / (g.max - g.min);
      thumb.el.style.left = `${x0 + t * (x1 - x0)}px`;
      this.setText(g.value, g.decimals ? v.toFixed(g.decimals) : String(Math.round(v)));
    });
  }

  private showTab(tab: string): void {
    this.current = tab;
    for (const [t, sect] of Object.entries(TABS)) {
      const s = this.byName.get(sect);
      if (s) s.el.style.display = t === tab ? "" : "none";
      this.setState(t, t === tab ? 1 : 0);
    }
    // the frame's caption (section title) is the tab's own name
    const label = TEXT[tab];
    if (label) this.setText("opFrameCaption", tOr(label[0], label[1]));
  }

  get isOpen(): boolean { return this.opened; }

  open(): void {
    this.snapshot = { ...getSettings() };
    this.typeSnapshot = crosshairType();
    this.colorSnapshot = crosshairIndex();
    this.opened = true;
    this.stage.el.style.display = "block";
    this.refresh();
    this.showTab(this.current);
    this.stage.fit();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.stage.el.style.display = "none";
    this.onClose?.();
  }

  dispose(): void {
    this.abort.abort();
    this.stage.destroy();
  }
}
