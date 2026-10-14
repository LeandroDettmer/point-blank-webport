// Battle loading screen = the Point Blank Cross exe's CGameSupportSet::SetLoadingSpr (0x4db100) + its update (0x4dc730).
// Art: pbx ui cross-loading -> ui/cross/loading/ (index.json); FirstLoading and UI_Source03 from pbx ui cross-ui (ui/cross/atlas).
// Every sprite is laid out on a 1024x768 design stretched to the screen per axis (scale W/1024, H/768, 0x4db12d); the text keeps
// its pixel size and only its position scales. Map name, team, objective and story are baked in the map art: no DOM text for them.
//  - background: World/<Map>/Images/load_<Map>_<Red|Blue>.i3i by slot % 2 (even = Red), the _DM_ pair when the stage ordinal
//    (STAGE_ID & 0xff) is in DM_STAGES (switch 0x4db1f9); uv (0,0)-(1024,768) over the whole screen. A missing file falls back to
//    Gui/Loading/Loading.i3i (0x4db2fc, black in Cross).
//  - AI room: Load_Training.i3i, 3 sprites (0x4db50e): story panel uv (1,1)-(620,170) at (403,596) 620x169, tag (1,176)-(82,202)
//    at (745,14) 81x25, team emblem Red (822,0)-(1021,170) / Blue (622,0)-(821,170) at (34,76) 200x171. The exe shows them for
//    room byte +0x25 == 6 / 8 or flag 0xb (0x4c29b0 / 0x4c2a30); that they are our bot rooms is [INFERIDO].
//    Load_CCmode (stage mode 12, 0x4de190) is not used: the server has no such mode.
//  - FirstLoading.i3i: "LOADING..." uv (66,774)-(188,831) at (899,722) 106x42 and the spinner (852,722) 42x42, 23 frames of 58x58
//    from (7,833), 17 per row, 59 px pitch, one frame each 1/23 s (0x4dc759).
//  - tip (0x4dc200): icon Gui/Main/UI_Source03.i3i uv (323,429)-(372,464) at (12,728) 49x35; text rand() % 7: 0..1 ->
//    STBL_IDX_TIP_LOADING_SINGLE_%d at (70,737), 2..6 -> _DUAL_%d (n - 2) at (70,729); default font 14 pt, weight 400, white.
// No progress bar exists in the Cross loading screen: the spinner is its only motion.
import { UI_BASE } from "../lobby/ui/assets.ts";
import { guiFont } from "../lobby/ui/i3Gui.ts";
import { tOr } from "../lobby/ui/i18n.ts";
import { jsonOnce } from "../jsonOnce.ts";

export interface BattleLoadingInfo {
  map: string;
  /** room stage ordinal (STAGE_ID & 0xff) */
  mapId: number;
  /** bot room: the Load_Training overlay */
  ai: boolean;
  /** local slot % 2: 0 = red, 1 = blue */
  team: 0 | 1;
}

const DIR = `${UI_BASE}/cross/loading`;
const FIRST = `${UI_BASE}/cross/atlas/loading_firstloading.png`;
const SOURCE03 = `${UI_BASE}/cross/atlas/main_ui_source03.png`;
/** stage ordinals with the _DM_ art (jump table 0x4dc1a4 over ordinal - 12) */
const DM_STAGES = [12, 13, 14, 15, 19, 24, 45, 93];

type Uv = [number, number, number, number];

let root: HTMLDivElement | null = null;
let spin = 0;

const images = new Map<string, Promise<HTMLImageElement>>();
function image(url: string): Promise<HTMLImageElement> {
  let p = images.get(url);
  if (!p) {
    p = new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    images.set(url, p);
  }
  return p;
}

/** i3Sprite2D: SetRect(x, y, w, h) + SetTextureCoord(u1, v1, u2, v2), drawn once the image is in; returns the uv setter */
function sprite(into: HTMLElement, url: string, x: number, y: number, w: number, h: number, uv: Uv): (uv: Uv) => void {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  Object.assign(c.style, { position: "absolute", left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  into.append(c);
  const g = c.getContext("2d")!;
  let cur = uv;
  const draw = (img: HTMLImageElement) => { g.clearRect(0, 0, w, h); g.drawImage(img, cur[0], cur[1], cur[2] - cur[0], cur[3] - cur[1], 0, 0, w, h); };
  const img = image(url);
  img.then(draw, () => {});
  return (next) => { cur = next; void img.then(draw, () => {}); };
}

/** `{col:r,g,b,a}` colour markup of the STBL strings -> spans */
function markup(into: HTMLElement, s: string): void {
  let color = "";
  for (const part of s.split(/(\{col:[^}]*\})/)) {
    const m = /^\{col:(\d+),(\d+),(\d+)/.exec(part);
    if (m) { color = `rgb(${m[1]},${m[2]},${m[3]})`; continue; }
    if (!part) continue;
    const sp = document.createElement("span");
    sp.textContent = part;
    if (color) sp.style.color = color;
    into.append(sp);
  }
}

/** The Cross screen has no progress bar; kept for main.ts's load milestones. */
export function setBattleProgress(_p: number): void {}

/** Shows the loading screen (a second call while it is up does nothing). `_caption` = the room's start messages: the Cross
 * screen has no text box for them. */
export function showBattleLoading(info: BattleLoadingInfo, _caption?: string): void {
  if (root) return;
  const el = document.createElement("div");
  root = el;
  Object.assign(el.style, { position: "fixed", inset: "0", zIndex: "100000", background: "#000", overflow: "hidden", userSelect: "none", cursor: "default" });
  document.body.append(el);

  const sx = window.innerWidth / 1024, sy = window.innerHeight / 768;
  const ui = document.createElement("div");
  Object.assign(ui.style, { position: "absolute", left: "0", top: "0", width: "1024px", height: "768px", transformOrigin: "0 0", transform: `scale(${sx}, ${sy})` });
  el.append(ui);

  const bg = document.createElement("div");
  Object.assign(bg.style, { position: "absolute", inset: "0" });
  ui.append(bg);
  const red = info.team === 0;
  const dm = DM_STAGES.includes(info.mapId & 0xff);
  const variant = `${dm ? "dm_" : ""}${red ? "red" : "blue"}`;
  void jsonOnce<{ maps: Record<string, string[]> }>(`${DIR}/index.json`).catch(() => null).then((idx) => {
    if (root !== el) return;
    const file = idx?.maps[info.map]?.includes(variant) ? `${info.map}_${variant}.png` : "loading.png";
    sprite(bg, `${DIR}/${file}`, 0, 0, 1024, 768, [0, 0, 1024, 768]);
  });

  if (info.ai) {
    const tex = `${DIR}/load_training.png`;
    sprite(ui, tex, 403, 596, 620, 169, [1, 1, 620, 170]);
    sprite(ui, tex, 745, 14, 81, 25, [1, 176, 82, 202]);
    sprite(ui, tex, 34, 76, 200, 171, red ? [822, 0, 1021, 170] : [622, 0, 821, 170]);
  }

  sprite(ui, FIRST, 899, 722, 106, 42, [66, 774, 188, 831]);
  const frame = (f: number): Uv => { const u = 7 + (f % 17) * 59, v = 833 + Math.floor(f / 17) * 59; return [u, v, u + 58, v + 58]; };
  const setSpin = sprite(ui, FIRST, 852, 722, 42, 42, frame(0));
  let f = 0;
  spin = window.setInterval(() => { f = f >= 22 ? 0 : f + 1; setSpin(frame(f)); }, 1000 / 23);

  sprite(ui, SOURCE03, 12, 728, 49, 35, [323, 429, 372, 464]);
  const n = Math.floor(Math.random() * 7);
  const font = guiFont(14, 400);
  const tip = document.createElement("div");
  Object.assign(tip.style, {
    position: "absolute", left: `${70 * sx}px`, top: `${(n > 1 ? 729 : 737) * sy}px`, width: `${1024 * sx}px`, height: `${80 * sy}px`,
    font: font.css, lineHeight: `${font.lineH}px`, color: "#fff", whiteSpace: "pre-wrap",
  });
  markup(tip, tOr(n > 1 ? `STBL_IDX_TIP_LOADING_DUAL_${n - 2}` : `STBL_IDX_TIP_LOADING_SINGLE_${n}`, ""));
  el.append(tip);
}

export function hideBattleLoading(): void {
  clearInterval(spin);
  spin = 0;
  root?.remove();
  root = null;
}
