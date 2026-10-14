// Browser runtime of the original PB in-game HUD (Cross exe panels: charaPanel.ts, crossScore.ts, crossFinal.ts), code-drawn
// parts from layout.ts (the Node composer dev/cross-hud.node.ts draws the same panels to PNG). Layout:
//   #pbhud (window px)
//   ├─ .pbhud-box  design box 768 px high, (W/s) px wide, scale s = H/768: kill feed, kill banners, result window
//   ├─ .pbhud-ks   window px: kill stars + crest (CChainKills, absolute screen px in the exe)
//   └─ canvas      window px (DPR): crosshair, hit marker, damage arcs (Crosshair_Cross draws in render-target px)
import { FONTS, UI_BASE, keepImage } from "../../lobby/ui/assets.ts";
import { emPx, textCss } from "./hudText.ts";
import type { GNode } from "../../lobby/ui/i3Gui.ts";
import { newAudio } from "../../audioUrl.ts";
import { loadStrings } from "../../lobby/ui/i18n.ts";
import { isServerThrowable, localFlash, pack2017Id } from "../../weapons/throwables.ts";
import { missionPanelState, type HudData, type MissionPanelState, type Team } from "./model.ts";
import {
  CROSSHAIR, CROSSHAIR_COLORS, DAMAGE_ARC, crosshairLen, damageArcFade, GRENADE_WARN, HITMARK, KILLFEED, MINIMAP, MISSION_PANEL, SCREEN_BLOOD, crosshairShape, damageArcRect, killFeedRow, killIcon,
  minimapTransform, missionPanelBox, type CrosshairType, type KillIcons, type MinimapInfo, type RGBA, type Rect,
} from "./layout.ts";
import { ChainBanners, killSheetFile, markSprite, type KillMarkDef } from "./killmarks.ts";
import { KillStars, MAX_STARS, starCell } from "./killStars.ts";
import { getSettings, onSettings, sfxGain, type GameSettings } from "../../gameplay/settings.ts";
import { soundInfo } from "../../gameplay/soundMix.ts";
import { jsonOnce } from "../../jsonOnce.ts";
import { CROSS_HUD_ATLASES, CROSS_RESULT_JSON, CrossFinal, crossResultTree } from "./crossFinal.ts";
import { CROSS_HUD } from "./crossAssets.ts";
import { BombPanel, DashPanel, RoundBanner, TabBoard, TargetHpPanel, stageY0 } from "./crossScore.ts";
import { CharaPanel, placeBox } from "./charaPanel.ts";
import { RevengeBook, RevengePanel, type RevengeFoe } from "./revengePanel.ts";
const CROSS = `${UI_BASE}/cross`;

const CSS = `
#pbhud{position:absolute;inset:0;pointer-events:none;user-select:none;overflow:hidden;z-index:20}
#pbhud .pbhud-flash{position:absolute;inset:0;background:#fff;opacity:0;display:none}
#pbhud .pbhud-box{position:absolute;left:0;top:0;height:768px;transform-origin:0 0}
#pbhud .pbhud-box>.pbui-scene{pointer-events:none}
#pbhud canvas.pbhud-fx{position:absolute;inset:0;width:100%;height:100%}
#pbhud canvas.pbhud-blood{position:absolute;inset:0;width:100%;height:100%}
#pbhud .pbhud-bar{position:absolute;inset:0;overflow:hidden}
#pbhud .pbhud-icon{position:absolute;inset:0;background:center/contain no-repeat}
#pbhud .pbhud-txt{position:absolute;white-space:nowrap;overflow:hidden;font-family:${FONTS.hudText};font-weight:400;line-height:1;display:flex;align-items:center;text-shadow:1px 1px 0 rgba(32,32,32,.78)}
#pbhud .pbhud-feed{position:absolute;inset:0}
#pbhud .pbhud-feed .spr{position:absolute;background-repeat:no-repeat}
#pbhud .pbhud-banner{position:absolute;left:calc(50% - 300px);top:130px;width:600px;height:36px;display:flex;align-items:center;justify-content:center;white-space:nowrap;overflow:hidden;font:bold ${emPx("Arial", 16).toFixed(2)}px ${FONTS.hudText};color:rgb(240,210,110);text-shadow:1px 1px 0 rgba(32,32,32,.8)}
#pbhud .pbhud-killbanner{position:absolute;left:0;right:0;top:190px;text-align:center;font-family:${FONTS.hudText};font-weight:bold;color:#ffd75a;font-size:30px;letter-spacing:2px;text-shadow:0 2px 0 rgba(32,32,32,.9),0 0 14px rgba(255,180,0,.55);opacity:0;transform:scale(.85);transition:opacity .12s ease-out,transform .12s ease-out}
#pbhud .pbhud-killbanner.on{opacity:1;transform:scale(1)}
#pbhud .pbhud-chainbanner{position:absolute;background-repeat:no-repeat;pointer-events:none;display:none}
#pbhud .pbhud-cd{position:absolute;inset:0;pointer-events:none;display:none}
#pbhud .pbhud-cd>i{position:absolute;background-repeat:no-repeat;display:none}
#pbhud .pbhud-ks{position:absolute;inset:0;pointer-events:none}
#pbhud .pbhud-ks>div{position:absolute;display:none}
#pbhud .pbhud-kcrest{background-size:100% 100%;background-repeat:no-repeat}
#pbhud .pbhud-kstar{background-repeat:no-repeat}
#pbhud .pbhud-ktxt{width:52px;height:60px;align-items:flex-end;justify-content:center;font:${emPx("Gunplay", 25).toFixed(2)}px ${FONTS.hudNumber};color:rgb(200,200,200)}
#pbhud .pbhud-mission{position:absolute;left:0;top:0;display:none}
#pbhud .pbhud-mission>*{position:absolute;display:block;background-repeat:no-repeat}
#pbhud .pbhud-mission>.tx{white-space:pre;color:#fff}
#pbhud .pbhud-dbg{position:absolute;right:6px;bottom:120px;font:11px monospace;color:#9f9;white-space:pre;opacity:.7;text-align:right}
`;

/** The 2017 HUD text nodes (kill list, system lines) use the font set GameInterface::OnInitInstance 0x6a8af0 builds from 0x4ac520 = "Arial" (regular, weight 0x190, 10 pt = 13 px by i3Gfx::FontPointToPixel); the BR UI font "Arial Negrito" is only the i3UI controls' (CGameFramework::OnCreate SetFontName _Font). */
/** the exe default font (0x4ada40), FONTS.hudText */
const HUD_FONT = FONTS.hudText;

interface RadarRec { status: string; png?: string; w: number; h: number; minfo?: { realMapScale: number | null; realBakedSize: number | null; centerX: number | null; centerY: number | null } }
/** cross-hud/index.json: textures, kill pages, Tab minimaps and the radar (minfo_ + mini_ of <Map>_SubData, CBattleHUD_MiniMap 0x6fdc90) */
/** radar record of a map: the index keys are the Cross names, CurrentMap is the lowercase id */
const radarOf = (index: HudIndex | null | undefined, map: string): RadarRec | undefined => {
  const r = index?.radar;
  if (!r) return undefined;
  const lo = map.toLowerCase();
  return r[map] ?? r[Object.keys(r).find((k) => k.toLowerCase() === lo) ?? ""];
};
interface HudIndex { minimaps: Record<string, (MinimapInfo & { status: string; png?: string; content?: Rect }) | undefined>; radar?: Record<string, RadarRec | undefined>; killIcons?: KillIcons; textures?: Record<string, { content?: Rect }> }
/** cross/icons/index.json: item id -> cell of its Cross atlas (sheet = atlas PNG path under ui/, x/y/w/h = cell) */
interface IconRec { sheet: string; atlas?: string; x: number; y: number; w: number; h: number; status: string }
interface IconIndex { icons: Record<string, IconRec>; atlases: Record<string, { sheet: string; w: number; h: number }> }
interface FeedItem { el: HTMLElement; t: number; hs: HTMLElement | null }
/** a damage arc: bearing at the hit, the view yaw then, integer alpha (Cross update 0x747bf0) */
interface Arc { rel: number; yaw: number; alpha: number }
export interface Blip { x: number; z: number; team: Team; alive: boolean; self?: boolean }

function img(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error(url)); i.src = url; });
}
async function json<T>(url: string, fallback: T): Promise<T> {
  try { return await jsonOnce<T>(url); } catch { return fallback; } // one parse per url: icons/index.json is 3.7 MB, also read by the T menu
}

/** decoded HUD art of the match preload, held so the CSS backgrounds that show it later paint from the memory cache */
const hudArt: HTMLImageElement[] = [];
/**
 * Match preload (game/matchPreload.ts): the HUD sheets PbHud.load reads, the art that is only a CSS background until its
 * first use (kill crest, kill_message banners, observer frame) and the kill list pages of the match's
 * weapons, plus the announcer clips into the HTTP cache. Each of these was fetched on its first use (first kill).
 */
export async function preloadHudArt(weaponIds: number[], map: string): Promise<void> {
  const [index] = await Promise.all([
    jsonOnce<HudIndex>(`${CROSS_HUD}/index.json`).catch(() => null),
  ]);
  const pages = new Set<string>();
  for (const id of weaponIds) {
    const k = killIcon(index?.killIcons, isServerThrowable(id) ? pack2017Id(id) || id : id);
    if (k) pages.add(k.png);
  }
  const minimap = radarOf(index, map)?.png; // PbHud.loadMinimap
  if (minimap) void img(`${CROSS_HUD}/${minimap}`).then((i) => { hudArt.push(i); }, () => {});
  const files = ["Hud.png", "Hud2.png", MISSION_PANEL.sheet, "blood.png", "kill_mark_HistoryBG.png", "kill_message.png", "kill_message1.png", ...pages];
  await Promise.all([
    // PbHud.load: the Cross icon index and the patente cells
    jsonOnce<IconIndex>(`${CROSS}/icons/index.json`).catch(() => null), keepImage(`${CROSS}/atlas/interface_level_icon.png`, true),
    ...files.map((f) => img(`${CROSS_HUD}/hud/${f}`).then((i) => { hudArt.push(i); }, () => {})),
  ]);
}

/** kill banner art: the Cross sheet with the Cross lobby, else Interface > "Novos banners de kill" picks the TH or the 2017 sheets */

/** the mission panel's Hud.i3i cell `src` stretched to w x h (i3Sprite2D SetTextureCoord + SetRect) as the element's background */
function missionSprite(el: HTMLElement, src: Rect, w: number, h: number): void {
  const kx = w / src.w, ky = h / src.h;
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  el.style.backgroundImage = `url(${CROSS_HUD}/hud/${MISSION_PANEL.sheet})`;
  el.style.backgroundSize = `${1024 * kx}px ${512 * ky}px`;
  el.style.backgroundPosition = `${-src.x * kx}px ${-src.y * ky}px`;
}

export class PbHud {
  readonly root: HTMLDivElement;
  private box: HTMLDivElement;
  /** HP / ammo / weapon panel: CHUD_CharaState of the Cross exe, window px (charaPanel.ts) */
  private chara: CharaPanel;
  /** score bar (CHUD_Dashboard) and Tab board (CHUD_Score) of the Cross exe, window px (crossScore.ts) */
  private dash: DashPanel;
  private tab: TabBoard;
  private bombHud: BombPanel;
  private targetHud: TargetHpPanel;
  /** revenge record (CHud::RecordRevenge, bar_A / bar_B at hud2 centre bottom): records of the local player, window px (revengePanel.ts) */
  private revenge = new RevengeBook();
  private revengePanel: RevengePanel;
  private roundBanner: RoundBanner;
  private help: HTMLDivElement;
  private mmPanel: HTMLDivElement;
  /** [BLOQUEADO] layers whose geometry is not from the Cross exe yet (2017 / RECRIADO): kept alive but never shown, see
   * ?. Only the caption fallback (killBanner) is left here: every Cross banner is in the CChainKills queue. */
  private undecoded: HTMLDivElement;
  private fx: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  /** end-of-match screen: Cross Result_BG (crossFinal.ts), built by load() once UI_Project_HUD.json is in */
  private crossFinal: CrossFinal | null = null;
  private hudTex: HTMLImageElement | null = null;
  private hudIndex: HudIndex = { minimaps: {} };
  private icons: IconIndex = { icons: {}, atlases: {} };
  private weaponIds = new Map<string, number>();
  /** every weapons.json id of a name, for a kill icon when the exact item has none */
  private weaponIdsByName = new Map<string, number[]>();
  private mmImg: HTMLImageElement | null = null;
  private mmInfo: (MinimapInfo & { content?: Rect }) | null = null;
  private mmMap = "";
  private mmZoom = MINIMAP.zoom;
  private mmCanvas: HTMLCanvasElement | null = null;
  private feedLayer: HTMLDivElement;
  private feed: FeedItem[] = [];
  private arcs: Arc[] = [];
  /** view yaw of the last frame (render fx.yaw = player yaw), for the damage arcs */
  private yaw = 0;
  /** weapons.json id -> pef crosshair Expand (gun line length, layout.ts crosshairLen) */
  private xhExpand = new Map<number, number>();
  private xhLen: number = CROSSHAIR.len;
  private hitT = -1;
  /** screen blood (layout.ts SCREEN_BLOOD): its own canvas, first in the DOM so it sits UNDER the HUD scenes the
   *  way the client draws it; the fx canvas above holds the crosshair / hit marker / damage arcs. */
  private bloodCv: HTMLCanvasElement;
  private bloodG: CanvasRenderingContext2D;
  private bloodTex: HTMLImageElement | null = null;
  private blood = -1;
  /** the mission notice node (+0x2a0): the notice() text while its time runs, else the ready countdown line */
  private banner: HTMLDivElement;
  private countdown = "";
  private noticeText = "";
  private noticeLeft = 0;
  private bannerY0 = -1;
  private killBanner: HTMLDivElement;
  private killBannerT = -1;
  private killBannerLife = 0;
  /** kill_message.i3i / kill_message1.i3i cells (kill banners, HELMET PROTECTION, Task Completed, mission banners): CChainKills queue and animation (killmarks.ts ChainBanners) */
  private chainBanner: HTMLDivElement;
  private chainBanners = new ChainBanners();
  /** mission panel (layout.ts MISSION_PANEL / missionPanelBox): the 3 frame pieces, the state icons and the wrapped text lines,
   * all placed in design px; rebuilt when the rows change */
  private mission: HTMLDivElement;
  private missionKey = "";
  /** text measure of the wrap (canvas in the panel font) */
  private missionFont: CanvasRenderingContext2D | null = null;
  /** kill stars + crest of CChainKills (killStars.ts): the layer, the crest, 9 star cells and their numbers */
  private kstars = new KillStars();
  private kLayer: HTMLDivElement;
  private kcrest: HTMLDivElement;
  private kspr: HTMLDivElement[] = [];
  private ktxt: HTMLDivElement[] = [];
  private announceFiles: Record<string, string> | null = null;
  private announceAudio = new Map<string, HTMLAudioElement>();
  private unsubAnnounceVolume: (() => void) | null = null;
  private dbg: HTMLDivElement;
  /** flashbang white screen (CGameCharaHUDContext sprite +0x130, white, alpha = throwables.ts localFlash) */
  private flash: HTMLDivElement;
  private scale = 1;
  private dw = 1024;
  ready = false;
  crosshairColor: RGBA = CROSSHAIR.color;
  crosshairType: CrosshairType = "Crosshair_Cross";

  constructor(host: HTMLElement) {
    if (!document.getElementById("pbhud-css")) {
      const st = document.createElement("style");
      st.id = "pbhud-css";
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.root = document.createElement("div");
    this.root.id = "pbhud";
    this.box = document.createElement("div");
    this.box.className = "pbhud-box";
    this.fx = document.createElement("canvas");
    this.fx.className = "pbhud-fx";
    this.g = this.fx.getContext("2d")!;
    this.bloodCv = document.createElement("canvas");
    this.bloodCv.className = "pbhud-blood";
    this.bloodG = this.bloodCv.getContext("2d")!;
    this.feedLayer = document.createElement("div");
    this.banner = document.createElement("div");
    this.banner.className = "pbhud-banner";
    this.killBanner = document.createElement("div");
    this.killBanner.className = "pbhud-killbanner";
    this.chainBanner = document.createElement("div");
    this.chainBanner.className = "pbhud-chainbanner";
    this.mission = document.createElement("div");
    this.mission.className = "pbhud-mission";
    this.kLayer = document.createElement("div");
    this.kLayer.className = "pbhud-ks";
    this.kcrest = document.createElement("div");
    this.kcrest.className = "pbhud-kcrest";
    this.kcrest.style.backgroundImage = `url(${CROSS_HUD}/hud/kill_mark_HistoryBG.png)`;
    this.kLayer.appendChild(this.kcrest);
    for (let i = 0; i < MAX_STARS; i++) {
      const el = document.createElement("div");
      el.className = "pbhud-kstar";
      this.kspr.push(el);
      this.kLayer.appendChild(el);
    }
    for (let i = 0; i < MAX_STARS; i++) {
      const t = document.createElement("div");
      t.className = "pbhud-ktxt";
      this.ktxt.push(t);
      this.kLayer.appendChild(t);
    }
    this.dbg = document.createElement("div");
    this.dbg.className = "pbhud-dbg";
    this.flash = document.createElement("div");
    this.flash.className = "pbhud-flash";
    this.chara = new CharaPanel(this.root);
    this.dash = new DashPanel(this.root);
    // radar: CBattleHUD_MiniMap draws the map in its own viewport, SetViewportRect(9, 9, 153, 153) in radar mode (0x701aee): the
    // canvas is that window (clipped there, player at its centre), over the frame sprite (0x6fe500: SetRect(5, 5, 164, 181), Hud.i3i
    // UV (340.7,6)-(504,187), not scaled) [INFERIDO: draw order; the frame's inside is a 61 % dark glass, a background].
    this.mmPanel = document.createElement("div");
    this.mmPanel.style.cssText = "position:absolute;left:5px;top:5px;width:164px;height:181px;display:none;pointer-events:none";
    this.mmCanvas = document.createElement("canvas");
    this.mmCanvas.style.cssText = `position:absolute;left:${MINIMAP.view.x - 5}px;top:${MINIMAP.view.y - 5}px;width:${MINIMAP.view.w}px;height:${MINIMAP.view.h}px`;
    const ring = document.createElement("div");
    ring.style.cssText = `position:absolute;inset:0;background:url("${CROSS_HUD}/hud/Hud.png") -340.7px -6px no-repeat`;
    this.mmPanel.append(ring, this.mmCanvas);
    this.root.appendChild(this.mmPanel);
    this.tab = new TabBoard(this.root);
    this.bombHud = new BombPanel(this.root);
    this.targetHud = new TargetHpPanel(this.root);
    this.revengePanel = new RevengePanel(this.root);
    this.roundBanner = new RoundBanner(this.root);
    this.help = document.createElement("div");
    this.help.style.display = "none";
    this.root.appendChild(this.help);
    this.undecoded = document.createElement("div");
    this.undecoded.style.display = "none";
    this.root.append(this.bloodCv, this.box, this.fx, this.dbg, this.flash);
    host.appendChild(this.root);
    this.fit();
    void this.load();
  }

  private async load(): Promise<void> {
    const W = UI_BASE.replace(/\/ui$/, "");
    for (const u of CROSS_HUD_ATLASES) keepImage(u, true);
    const [hudTex, hudIndex, icons, weapons, , bloodTex, crossHud] = await Promise.all([
      img(`${CROSS_HUD}/hud/Hud.png`).catch(() => null),
      json<HudIndex>(`${CROSS_HUD}/index.json`, { minimaps: {} }),
      json<IconIndex>(`${CROSS}/icons/index.json`, { icons: {}, atlases: {} }),
      jsonOnce<{ weapons: { id: number; name: string; pb?: { crosshair?: { expand?: number } } }[] }>(`${W}/cross/weapons/weapons.json`).catch(() => ({ weapons: [] })),
      loadStrings().catch(() => ({})),
      img(`${CROSS_HUD}/hud/blood.png`).catch(() => null),
      jsonOnce<{ root: GNode }>(CROSS_RESULT_JSON).catch(() => null),
    ]);
    void this.loadAnnounce(W);
    this.hudTex = hudTex;
    this.hudIndex = hudIndex;
    this.bloodTex = bloodTex;
    this.icons = icons;
    // a name is not unique ("M-7" is 301001 but also 12 dino claws 119xxx, dual pistols share their single's name): the
    // kill feed / kill icon gets a name, so prefer a normal weapon over a dino (ClassType 19/20) or dual one, then the lowest id
    const rank = (id: number) => { const ct = Math.trunc((id % 100000) / 1000); return (ct === 19 || ct === 20 ? 1e7 : 0) + ([14, 15, 18, 35].includes(ct) ? 1e6 : 0) + id; };
    for (const w of weapons.weapons ?? []) {
      if (w.pb?.crosshair?.expand !== undefined) this.xhExpand.set(w.id, w.pb.crosshair.expand);
      const k = w.name.toLowerCase(), cur = this.weaponIds.get(k);
      if (cur === undefined || rank(w.id) < rank(cur)) this.weaponIds.set(k, w.id);
      const l = this.weaponIdsByName.get(k);
      if (l) l.push(w.id); else this.weaponIdsByName.set(k, [w.id]);
    }
    this.box.style.visibility = "hidden";
    // the CChainKills kill-message banner (Cross exe) is shown; the caption fallback has no Cross geometry: hidden holder
    this.undecoded.append(this.killBanner);
    // CChallengeBoard (layout.ts MISSION_PANEL) and the mission notice (+0x2a0) are absolute window px: on the root, not the design box
    this.fx.before(this.mission, this.banner);
    // CChainKills sizes and slots are absolute screen px too (52 x 56 at W - (52n + 183), H - 65; only the birth uses sx/sy)
    this.fx.before(this.kLayer);
    this.box.append(this.undecoded, this.feedLayer, this.chainBanner);
    // end screen: Cross Result_BG; its confirm button is the only click target (the HUD ignores the mouse)
    const resultTree = crossHud ? crossResultTree(crossHud.root) : undefined;
    if (resultTree) this.crossFinal = new CrossFinal(this.box, resultTree, () => this.onFinal.ok?.());
    this.ready = true;
    this.layout();
  }

  /** StartAnnounceMessage 0x699790: 2D (0x699c50 listener flag 1) at the clip's listener volume (Voice.RSC MV_Ann_*: 100)
   *  x the effects gauge; HTMLAudio volume stops at 1 like an FMOD channel */
  private announceLevel(id: string, st: GameSettings = getSettings()): number {
    return Math.min(1, (soundInfo(this.announceFiles?.[id]).lvol / 100) * sfxGain(st));
  }

  /** announce.json (pb-extract-tools export-announce2017.mjs, Cross Sound_voice_Announce.i3Pack): every voice line buffered up front
   *  (an Audio made on its first play waited for the network: the first kill voice came late). */
  private async loadAnnounce(assetsBase: string): Promise<void> {
    const idx = await json<{ files: Record<string, string> } | null>(`${assetsBase}/sfx/announce/announce.json`, null);
    this.announceFiles = idx?.files ?? null;
    for (const [id, rel] of Object.entries(this.announceFiles ?? {})) {
      if (this.announceAudio.has(id)) continue;
      const a = newAudio(`${assetsBase}/sfx/announce/${rel}`);
      a.preload = "auto";
      this.announceAudio.set(id, a);
    }
    // a gauge change applies to a line already playing too (the battle's ESC Configuração is live)
    this.unsubAnnounceVolume ??= onSettings((st) => { for (const [id, a] of this.announceAudio) a.volume = this.announceLevel(id, st); });
  }

  /** MV_Ann_*.wav / UI_HUD_Revenge_Effect.wav (pb-extract-tools export-announce2017.mjs), 2D one-shot, no positional audio. */
  private playAnnounce(id: string): void {
    const rel = this.announceFiles?.[id];
    if (!rel) return;
    let a = this.announceAudio.get(id);
    if (!a) { a = newAudio(`${UI_BASE.replace(/\/ui$/, "")}/sfx/announce/${rel}`); this.announceAudio.set(id, a); }
    else a.currentTime = 0;
    a.volume = this.announceLevel(id);
    void a.play().catch(() => {});
  }

  /**
   * Own kill: every mark in `marks` (src/game/pbHud/killmarks.ts, already in announcement order: this kill's shot
   * descriptor(s), then the multi-kill combo tier, then the no-death chain tier) gets its own kill_message.i3i
   * sprite (or caption fallback, e.g. revenge's flavoured STR_INGAME_HUD_REVENGE_* text) and voice line, shown one
   * after another 0.6s apart — CChainKills::_PushKillMessage pushes one banner per event, not a single winner.
   */
  killMark(marks: KillMarkDef[]): void {
    let delay = 0;
    for (const m of marks) {
      setTimeout(() => {
        if (markSprite(m)) this.spriteMark(m, false);
        else if (m.caption && getSettings().textEffect) { // Option > Game: Efeito de texto
          this.killBanner.textContent = m.caption;
          this.killBanner.classList.add("on");
          this.killBannerT = 0;
          this.killBannerLife = m.duration;
        }
        this.playAnnounce(m.sound);
      }, delay * 1000);
      delay += 0.6;
    }
  }

  /**
   * A mark drawn from kill_message.i3i / kill_message1.i3i (def.sprite) with its announce voice, e.g. the victim's HELMET PROTECTION or the
   * MISSION START banner. Every cell goes through the CChainKills queue and animation (ChainBanners): kill_message1 is the same node
   * (CChainKills 0x7b17b1 sets +0x5d4 = kill_message1 on the banner that 0x7afb7d sets for kill_message).
   * `voice` false: the caller plays the clip itself.
   */
  spriteMark(def: KillMarkDef, voice = true): void {
    const s = markSprite(def);
    if (s) this.chainBanners.push(s);
    if (voice) this.playAnnounce(def.sound);
  }

  private tickKillBanner(dt: number): void {
    const f = this.chainBanners.update(dt, this.dw, 768), cb = this.chainBanner;
    if (!f) cb.style.display = "none";
    else {
      const k = f.w / 512;
      cb.style.cssText = `display:block;left:${f.x}px;top:${f.y}px;width:${f.w}px;height:${f.h}px;opacity:${f.alpha / 255};background-image:url(${CROSS_HUD}/hud/${killSheetFile(f.sheet)});background-size:${1024 * k}px ${1024 * k}px;background-position:${-f.cellX * k}px ${-f.cellY * k}px`;
    }
    if (this.killBannerT < 0) return;
    this.killBannerT += dt;
    if (this.killBannerT >= this.killBannerLife) { this.killBannerT = -1; this.killBanner.classList.remove("on"); }
  }

  /** a kill star (killStars.ts): `kind` = Hud.i3i cell from killmarks.ts starVariant */
  addKillStar(kind: number): void {
    this.kstars.add(kind);
  }

  /** another victim of the shot behind the newest star: its number goes up; false when there is no star */
  bumpKillStar(): boolean {
    return this.kstars.bumpLast();
  }

  /** own death / new round: the stars and the crest go away (CChainKills::_ResetStars 0x7bb150) */
  resetKillStars(): void {
    this.kstars.reset();
  }

  /** ItemClass (1 primary .. 4 explosive) and ClassType (6 shotgun) of a weapon by name; 0 when unknown */
  weaponClassOf(name: string): { itemClass: number; classType: number } {
    const id = this.weaponIds.get(name.toLowerCase());
    return id === undefined ? { itemClass: 0, classType: 0 } : { itemClass: Math.trunc(id / 100000), classType: Math.trunc((id % 100000) / 1000) };
  }

  /** CChainKills::_UpdateStars: the crest + stars of killStars.ts drawn with the real Hud.i3i / kill_mark_HistoryBG.i3i cells */
  private tickKillStars(dt: number): void {
    const f = this.kstars.update(dt, this.dw * this.scale, 768 * this.scale);
    const hud = `url(${CROSS_HUD}/hud/Hud.png)`;
    const cr = this.kcrest;
    if (f.crest) cr.style.cssText = `display:block;left:${f.crest.x}px;top:${f.crest.y}px;width:${f.crest.w}px;height:${f.crest.h}px;opacity:${f.crest.alpha / 255}`;
    else cr.style.display = "none";
    for (let i = 0; i < MAX_STARS; i++) {
      const el = this.kspr[i], tx = this.ktxt[i], v = f.stars[i];
      if (!v) { el.style.display = "none"; tx.style.display = "none"; continue; }
      const c = starCell(v.kind), kx = v.w / c.w, ky = v.h / c.h;
      el.style.cssText = `display:block;left:${v.x}px;top:${v.y}px;width:${v.w}px;height:${v.h}px;opacity:${v.alpha / 255};background-image:${hud};background-size:${1024 * kx}px ${512 * ky}px;background-position:${-c.x * kx}px ${-c.y * ky}px`;
      if (v.count > 1) { tx.textContent = String(v.count); tx.style.cssText = `display:flex;left:${v.x}px;top:${v.y}px`; } else tx.style.display = "none";
    }
  }

  /** item icon (cross/icons/index.json) as CSS: its cell of the Cross atlas, scaled into a w x h box (contain), centred. null = none. */
  iconCss(id: number, w: number, h: number): string | null {
    const r = this.icons.icons[String(id)] ?? (isServerThrowable(id) && pack2017Id(id) ? this.icons.icons[String(pack2017Id(id))] : undefined);
    const a = r?.atlas ? this.icons.atlases[r.atlas] : undefined;
    if (!r || r.status === "missing" || !a) return null;
    const k = Math.min(w / r.w, h / r.h);
    const dw = r.w * k, dh = r.h * k, ox = (w - dw) / 2, oy = (h - dh) / 2;
    return `position:absolute;left:${ox}px;top:${oy}px;width:${dw}px;height:${dh}px;background:url("${UI_BASE}/${a.sheet}") -${r.x * k}px -${r.y * k}px / ${a.w * k}px ${a.h * k}px no-repeat`;
  }

  /** Window size -> design box + anchors. Called every frame (cheap when unchanged). */
  private fit(): boolean {
    const W = this.root.clientWidth || window.innerWidth, H = this.root.clientHeight || window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.fx.width !== Math.round(W * dpr) || this.fx.height !== Math.round(H * dpr)) {
      this.fx.width = this.bloodCv.width = Math.round(W * dpr);
      this.fx.height = this.bloodCv.height = Math.round(H * dpr);
    }
    const s = H / 768, dw = W / s;
    if (s === this.scale && dw === this.dw) return false;
    this.scale = s;
    this.dw = dw;
    this.box.style.width = `${dw}px`;
    this.box.style.transform = `scale(${s})`;
    this.layout();
    return true;
  }

  private layout(): void {
    if (!this.ready) return;
    this.feedLayer.style.cssText = `position:absolute;top:0;left:${this.dw - 1024}px;width:1024px;height:768px`;
    const cx = (this.dw - 1024) / 2;
    if (this.crossFinal) this.crossFinal.root.style.left = `${cx}px`;
  }

  /** end-of-match screen callbacks: leave button / tab picked (0 Score, 1 Reward) */
  readonly onFinal: { ok?: () => void; tab?: (i: 0 | 1) => void } = {};

  setVisible(on: boolean): void { this.root.style.display = on ? "" : "none"; }
  private dbgAt = 0;
  /** debug overlay: 4 Hz (a textContent write every frame forced a style recalc + layout) */
  debug(text: string): void {
    const now = performance.now();
    if (now - this.dbgAt < 250) return;
    this.dbgAt = now;
    if (this.dbg.textContent !== text) this.dbg.textContent = text;
  }
  /** the ready countdown line (game.ts, every frame of the countdown); a notice() on top of it wins until its time is up */
  setBanner(text: string, sub: string): void {
    this.countdown = [text, sub].filter(Boolean).join(" ");
  }

  /**
   * Mission notice, CHud::SetMissionNoticeString 0x73f7a0: text node +0x2a0, 600x36 at
   * (W/2 - 300 + dx, 130 + Yn + dy), 16 bold, colour (240,210,110), centred, hard cut at its lifetime (no fade). One node: a new
   * notice replaces the last one. sec 0 clears it. Yn = stageY0 (18 for the stage types 4 / 13 / 45); the 0x707d90 case (+30) has no web equivalent.
   */
  notice(text: string, sec: number): void {
    this.noticeText = sec > 0 ? text : "";
    this.noticeLeft = sec;
  }

  // ---- per frame

  render(d: HudData, dt: number, fx: { crosshair: boolean; spreadDeg: number; feet: [number, number, number] | null; yaw: number; blips: Blip[]; map: string }): void {
    this.fit();
    if (this.noticeLeft > 0 && (this.noticeLeft -= dt) <= 0) this.noticeText = "";
    const line = this.noticeText || this.countdown;
    if (this.banner.textContent !== line) this.banner.textContent = line;
    const y0 = stageY0(d.stageType ?? 0);
    if (this.bannerY0 !== y0) { this.bannerY0 = y0; this.banner.style.top = `${130 + y0}px`; }
    if (this.ready) {
      const W = this.root.clientWidth || window.innerWidth, H = this.root.clientHeight || window.innerHeight;
      const live = !d.final && d.phase !== "ended";
      // Cross exe panels (window px). Kill cam, round result and minimap have no decoded Cross position yet: not drawn.
      this.chara.render(d, W, H, live && !d.dead && !d.showBoard && !d.observing);
      this.dash.render(d, W, H, live);
      this.tab.render(d, W, H, live && d.showBoard);
      this.bombHud.render(d, W, H, live);
      this.targetHud.render(d, W, H, live);
      this.revengePanel.render(this.revenge.current, W, H, live && !d.showBoard && this.revenge.visible);
      this.roundBanner.render(d, W, H);
      this.drawMission(missionPanelState(d));
      this.xhLen = crosshairLen(d.weapon.id === undefined ? undefined : this.xhExpand.get(d.weapon.id));
      this.yaw = fx.yaw;
      const radar = live && !d.dead && !d.showBoard && d.observing !== "fly";
      this.loadMinimap(fx.map);
      this.mmPanel.style.display = radar && this.mmInfo ? "" : "none";
      if (radar && this.mmInfo) this.drawMinimap(fx.feet, fx.yaw, fx.blips, d.myTeam);
      this.crossFinal?.show(!!d.final);
      if (d.final) this.crossFinal?.render(d.final, d.rows);
      this.root.style.background = d.final ? "rgba(3,6,14,.78)" : "";
      this.box.style.visibility = "";
    }
    this.tickFeed(dt);
    this.tickKillBanner(dt);
    this.tickKillStars(dt);
    this.revenge.tick(dt);
    this.drawFx(dt, fx.crosshair ? fx.spreadDeg : null);
    this.drawBlood(dt);
    this.drawFlash();
  }

  /** CHud+0x600 Update 0x706ad0: one row per task (state icon + wrapped text), the middle piece as tall as the rows' total advance */
  private drawMission(m: MissionPanelState): void {
    this.mission.style.display = m.show ? "block" : "none";
    if (!m.show) return;
    const key = JSON.stringify(m.rows);
    if (key === this.missionKey) return;
    this.missionKey = key;
    const P = MISSION_PANEL, T = P.text;
    const g = (this.missionFont ??= document.createElement("canvas").getContext("2d")!);
    g.font = `normal ${T.font}px ${HUD_FONT}`;
    const box = missionPanelBox(m.rows, P.top.y, (s) => g.measureText(s).width);
    const sprite = (r: Rect, src: Rect): HTMLElement => {
      const el = document.createElement("i");
      missionSprite(el, src, r.w, r.h);
      el.style.left = `${r.x}px`;
      el.style.top = `${r.y}px`;
      return el;
    };
    const els = [sprite(box.top, P.top.src), sprite(box.mid, P.mid.src), sprite(box.bottom, P.bottom.src)];
    for (const r of box.rows) {
      els.push(sprite(r.icon, r.src));
      for (const l of r.lines) {
        const tx = document.createElement("div");
        tx.className = "tx";
        tx.style.cssText = `left:${l.x}px;top:${l.y}px;width:${T.w}px;height:${T.line}px;font:normal ${T.font}px/${T.line}px ${HUD_FONT}`;
        tx.textContent = l.text;
        els.push(tx);
      }
    }
    this.mission.replaceChildren(...els);
  }

  /** the white screen over the scene and the HUD while the local player is flashed */
  drawFlash(): void {
    const a = localFlash.active ? localFlash.alpha / 255 : 0;
    this.flash.style.display = a > 0 ? "block" : "none";
    this.flash.style.opacity = a.toFixed(3);
  }

  // ---- crosshair / hit marker / damage arcs (window px)

  hit(): void { this.hitT = 0; }
  /** round end banner (Cross CHud 0x73ffb0): winner 0 red / 1 blue / null draw */
  roundEnd(winner: Team | null): void { this.roundBanner.show(winner); }
  /** F1 held (CHud 0x73f1a0): help.i3i (CHud+0x3f8, texture 13) at (W/2-326, H/2-256) 652x512, uv 0,0,652,512. The GM observer's
   *  help_observer.i3i is drawn by ObserverHud. */
  helpImage(on: boolean): void {
    if (on) placeBox(this.help, (window.innerWidth >> 1) - 326, (window.innerHeight >> 1) - 256, 652, 512, `url("${CROSS_HUD}/hud/help.png") 0 0`);
    this.help.style.display = on ? "" : "none";
  }
  private grenades: { rel: number; dist: number; indicatorType?: string }[] = [];
  /** thrown objects to warn about: bearing (rel, +right) and distance in m (CHud 0x7443c0) */
  grenadeAlerts(list: { rel: number; dist: number; indicatorType?: string }[]): void { this.grenades = list; }
  damage(rel: number): void { this.arcs.push({ rel, yaw: this.yaw, alpha: 255 }); if (this.arcs.length > DAMAGE_ARC.max) this.arcs.shift(); this.blood = 0; }

  /**
   * The red frame the client paints over the screen when the local player is hit (layout.ts SCREEN_BLOOD). Drawn
   * twice, the second copy mirrored, because blood.i3i only has bands on the top / bottom / left edges. Fades out
   * linearly over SCREEN_BLOOD.life; a second hit before it is gone just restarts it at full.
   */
  private drawBlood(dt: number): void {
    if (this.blood < 0) return;
    this.blood += dt; // seconds since the trigger (Cross 0x746c80: alpha = cos(t / 2) for pi s)
    const tex = this.bloodTex, g = this.bloodG;
    if (!tex) { this.blood = -1; return; }
    const dpr = this.bloodCv.width / Math.max(1, this.root.clientWidth || window.innerWidth);
    const W = this.bloodCv.width / dpr, H = this.bloodCv.height / dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.bloodCv.width, this.bloodCv.height);
    if (this.blood >= SCREEN_BLOOD.life) { this.blood = -1; return; }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Cross CHud::CreateHUD 0x739bd0 sprites +0x61c / +0x64c: blood.i3i UV (0,0)-(511,767) on the left half (0, 0, W/2, H) and the
    // same cell reversed on both axes (UV (511,767)-(0,0)) on the right half
    g.globalAlpha = Math.max(0, Math.min(1, Math.cos(this.blood / 2)));
    g.drawImage(tex, 0, 0, 511, 767, 0, 0, W / 2, H);
    g.save();
    g.translate(W, H);
    g.scale(-1, -1);
    g.drawImage(tex, 0, 0, 511, 767, 0, 0, W / 2, H);
    g.restore();
    g.globalAlpha = 1;
  }

  private drawFx(dt: number, spreadDeg: number | null): void {
    const g = this.g, dpr = this.fx.width / Math.max(1, this.root.clientWidth || window.innerWidth);
    const W = this.fx.width / dpr, H = this.fx.height / dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.fx.width, this.fx.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // damage arcs: Cross CHud add 0x744030 / update 0x747bf0, identical to the 2017 one (layout.ts DAMAGE_ARC)
    const tex = this.hudTex;
    for (let i = this.arcs.length - 1; i >= 0; i--) {
      const a = this.arcs[i];
      a.alpha -= damageArcFade(dt);
      if (a.alpha <= 0) { this.arcs.splice(i, 1); continue; }
      if (!tex) continue;
      const r = damageArcRect(), s = DAMAGE_ARC.src;
      g.save();
      g.globalAlpha = a.alpha / 255;
      g.translate(W / 2, H / 2);
      g.rotate(a.rel + this.yaw - a.yaw); // the camera turn since the hit is added to the angle every frame (0xd87b24)
      g.drawImage(tex, s.x, s.y, s.w, s.h, r.x, r.y, r.w, r.h);
      g.restore();
    }
    // grenade warning (layout.ts GRENADE_WARN, Cross CHud 0x7443c0): rel = -a, so (W/2 - R sin a, H/2 - R cos a) = centre + R (sin rel, -cos rel)
    if (tex) for (const { rel, dist, indicatorType } of this.grenades) {
      const G = GRENADE_WARN, c5 = indicatorType === "C5", B = c5 ? G.c5.badge : G.badge, T = c5 ? G.c5.text : G.text, A = G.arrow;
      const bx = W / 2 + G.rBadge * Math.sin(rel), by = H / 2 - G.rBadge * Math.cos(rel);
      g.drawImage(tex, B.x, B.y, B.w, B.h, bx - B.dw / 2, by - B.dh / 2, B.dw, B.dh);
      g.save();
      g.translate(W / 2, H / 2);
      g.rotate(rel);
      g.translate(0, -G.rArrow);
      g.drawImage(tex, A.x, A.y, A.w, A.h, -A.w / 2, -A.h / 2, A.w, A.h);
      g.restore();
      g.font = `${T.font}px ${HUD_FONT}`;
      g.fillStyle = "#fff";
      g.textBaseline = "top";
      g.fillText(`${dist.toFixed(1)}M`, bx + B.dw / 2 - T.dx, by + B.dh / 2 - T.dy);
    }
    if (spreadDeg !== null) {
      const c = `rgba(${this.crosshairColor[0]},${this.crosshairColor[1]},${this.crosshairColor[2]},${this.crosshairColor[3] / 255})`;
      const shape = crosshairShape(this.crosshairType, Math.round(W), Math.round(H), spreadDeg, this.xhLen);
      g.fillStyle = c;
      for (const l of shape.rects) g.fillRect(Math.round(l.x), Math.round(l.y), l.w, l.h);
      if (shape.poly) { g.beginPath(); shape.poly.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill(); }
      if (shape.loop) { g.strokeStyle = c; g.lineWidth = 1; g.beginPath(); shape.loop.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.stroke(); }
    }
    // hit marker: frame-based like OnUpdate 0x74eee0 (hitT = frames since SetHit)
    if (this.hitT >= 0) {
      const M = HITMARK, a = M.alpha0 - M.alphaStep * this.hitT, hud = this.hudTex;
      if (a <= 0 || !hud) this.hitT = -1;
      else {
        const sz = Math.min(M.sizeMax, M.size0 + this.hitT), s = M.src;
        g.save();
        g.globalAlpha = a / 255;
        g.globalCompositeOperation = "lighter"; // SrcBlend 5 / DestBlend 2 (additive)
        g.drawImage(hud, s.x, s.y, s.w, s.h, W / 2 + M.dx, H / 2 + M.dy, sz, sz);
        g.restore();
        this.hitT++;
      }
    }
  }

  // ---- kill feed (layout.ts KILLFEED: Cross CHud::SetKillText 0x741210), rows in a 1024-wide layer right-anchored

  /** CHud::RecordRevenge (called from the kill feed only for kills where the local player is killer or victim) */
  recordRevenge(foe: RevengeFoe, me: string, delta: number): void { this.revenge.record(foe, me, delta); }

  addKill(killer: { name: string; team: Team } | null, victim: { name: string; team: Team }, weapon: string, headshot: boolean, mine: boolean): void {
    const K = KILLFEED;
    const ctx = this.g;
    ctx.font = `${emPx("Arial", K.font)}px ${HUD_FONT}`;
    const L = killFeedRow({ killer: killer?.name ?? "", victim: victim.name }, 0, 1024, (t) => ctx.measureText(t).width);
    const el = document.createElement("div");
    el.className = "pbhud-feed";
    const put = (cls: string, r: Rect, extra = "") => {
      const d = document.createElement("div");
      d.className = cls;
      d.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;${extra}`;
      el.appendChild(d);
      return d;
    };
    const tex = `${CROSS_HUD}/hud/Hud.png`;
    const spr = (src: Rect, r: Rect, texW: number, texH: number, url: string) =>
      `background-image:url("${url}");background-size:${(texW * r.w) / src.w}px ${(texH * r.h) / src.h}px;background-position:${(-src.x * r.w) / src.w}px ${(-src.y * r.h) / src.h}px`;
    if (mine) put("spr", L.me, spr(K.meSrc, L.me, 1024, 512, tex));
    // text nodes: left / top in their 30 px box, Arial 10 regular, no shadow (layout.ts KILLFEED)
    const txt = (text: string, r: Rect, t: Team) => {
      const [cr, cg, cb] = t === 0 ? K.red : K.blue;
      put("pbhud-txt", r, textCss({ text, ...r, face: "Arial", size: K.font, color: [cr, cg, cb], ax: 0, ay: 0 }, HUD_FONT) + ";text-shadow:none").textContent = text;
    };
    if (killer) txt(L.killer, L.killerR, killer.team);
    // a replicated kill can carry the bare item id (net/battle.ts weaponName without a known name): icon by that id
    const numId = /^\d+$/.test(weapon) ? Number(weapon) : undefined;
    const ki = this.killIconOf(numId ?? this.weaponIds.get(weapon.toLowerCase()), weapon);
    if (ki) put("spr", L.icon, spr(ki.src, L.icon, 1024, 512, `${CROSS_HUD}/${ki.png}`));
    else {
      // no Weapon_Kill cell for the item: its Cross inventory icon fits the same box (PbHud.iconCss); text as a final fallback.
      const id = numId ?? this.weaponIds.get(weapon.toLowerCase());
      const css = id !== undefined ? this.iconCss(id, L.icon.w, L.icon.h) : null;
      if (css) put("spr", L.icon, css);
      else put("pbhud-txt", L.icon, "font-size:9px;color:#ccc;justify-content:center").textContent = weapon; // last resort [RECRIADO]
    }
    let hs: HTMLElement | null = null;
    if (headshot) hs = put("spr", L.hs, spr(K.hsSrc, L.hs, 1024, 512, tex) + `;opacity:${K.hsAlpha};transform-origin:0 0;transform:scale(${K.hsScale(0)})`);
    txt(L.victim, L.victimR, victim.team);
    this.feedLayer.appendChild(el);
    this.feed.push({ el, t: 0, hs });
    while (this.feed.length > K.max) this.feed.shift()!.el.remove();
    this.restackFeed();
  }
  /**
   * Kill list icon (Weapon_Kill*.i3i cell by the Cross Weapon.pef _UIShapeIndex, cross-hud index.killIcons.ord, layout.ts killIcon).
   * Server throwables may be numbered differently in the pef (throwables.ts ROWS), so they also try pack2017Id. An item the pef lacks
   * or flags without an icon takes the cell of another item of the same name.
   */
  private killIconOf(id: number | undefined, name: string): ReturnType<typeof killIcon> {
    const icons = this.hudIndex.killIcons;
    const cand: number[] = [];
    if (id !== undefined) cand.push(id);
    if (!/^d+$/.test(name)) cand.push(...(this.weaponIdsByName.get(name.toLowerCase()) ?? []).filter((x) => x !== id && ![19, 20].includes(Math.trunc((x % 100000) / 1000))).sort((a, b) => a - b));
    for (const c of cand) {
      const k = killIcon(icons, isServerThrowable(c) ? pack2017Id(c) || c : c);
      if (k) return k;
    }
    return null;
  }
  /**
   * System line of the kill list (CHud 0x74dd80: same 20 lines, 5 s, 30 px pitch, right aligned 13 px from the edge, white 13 px):
   * "<nick> Entrou no combate." (CStageBattle::_ProcessEvent_StartBattle 0x7766a3, STBL_IDX_GAME_INTRODUCE_PLAYER), " Deixou o combate."
   * (STBL_IDX_GAME_BYE_PLAYER, ProcessGameContext 0x768fa5). The nick is cut to 160 px with "..." (0x753c90).
   */
  addNotice(nick: string, suffix: string): void {
    const K = KILLFEED;
    const ctx = this.g;
    ctx.font = `13px ${HUD_FONT}`;
    let n = nick;
    while (n.length > 1 && ctx.measureText(n).width > 160) n = n.slice(0, -1);
    if (n !== nick) n += "...";
    const text = n + suffix;
    const w = Math.ceil(ctx.measureText(text).width) + 2;
    const el = document.createElement("div");
    el.className = "pbhud-feed";
    const d = document.createElement("div");
    d.className = "pbhud-txt";
    d.style.cssText = `left:${1024 - w - 13}px;top:${K.pitch - 8}px;width:${w}px;height:${K.meH}px;font:normal 13px/1 ${HUD_FONT};text-shadow:none;color:#fff`;
    d.textContent = text;
    el.appendChild(d);
    this.feedLayer.appendChild(el);
    this.feed.push({ el, t: 0, hs: null });
    while (this.feed.length > K.max) this.feed.shift()!.el.remove();
    this.restackFeed();
  }
  clearFeed(): void { this.feed.forEach((f) => f.el.remove()); this.feed = []; }
  /** row n at y = (n+1)*30: the row layout was built for n = 0, so shift by n*30 */
  private restackFeed(): void { this.feed.forEach((f, i) => (f.el.style.transform = `translateY(${i * KILLFEED.pitch}px)`)); }
  private tickFeed(dt: number): void {
    let changed = false;
    for (let i = this.feed.length - 1; i >= 0; i--) {
      const f = this.feed[i];
      f.t += dt;
      if (f.hs && f.t < 0.3) f.hs.style.transform = `scale(${KILLFEED.hsScale(f.t)})`;
      if (f.t >= KILLFEED.life) { f.el.remove(); this.feed.splice(i, 1); changed = true; } // no fade (0x74e3b2)
    }
    if (changed) this.restackFeed();
  }

  // ---- minimap (2017 mini_<Map>.i3i, hud-2017.mjs)

  /** Radar of the map: mini_<Map>.i3i + minfo_<Map>.txt of <Map>_SubData (CBattleHUD_MiniMap::Create 0x6fdc90). A minfo without
   *  RealMapScale needs _CalcMapScale 0x6fe3b0 (max X / Z extent of the world bound box) [INFERIDO: not ported, no radar there]. */
  private loadMinimap(map: string): void {
    if (map === this.mmMap) return;
    this.mmMap = map;
    this.mmImg = null;
    this.mmInfo = null;
    const r = radarOf(this.hudIndex, map), m = r?.status === "original" ? r.minfo : undefined;
    if (!r?.png || !m || m.realMapScale == null || m.realBakedSize == null || m.centerX == null || m.centerY == null) return;
    this.mmInfo = { w: r.w, h: r.h, realMapScale: m.realMapScale, realBakedSize: m.realBakedSize, centerX: m.centerX, centerY: m.centerY };
    img(`${CROSS_HUD}/${r.png}`).then((i) => { if (this.mmMap === map) this.mmImg = i; }).catch(() => {});
  }

  /** Minimap zoom keys (STBL_IDX_GAMEKEY_MINIMAP_ENLARGE / _REDUCTION): +/-0.1, clamped 0.5..1.1 (0x709960). */
  zoomMinimap(dir: 1 | -1): void {
    this.mmZoom = Math.round(Math.max(MINIMAP.zoomMin, Math.min(MINIMAP.zoomMax, this.mmZoom + dir * MINIMAP.zoomStep)) * 10) / 10;
  }

  private drawMinimap(feet: [number, number, number] | null, yaw: number, blips: Blip[], myTeam: Team): void {
    const c = this.mmCanvas;
    if (!c) return;
    // window px (not scaled): backing store = the 153 x 153 viewport x dpr
    const dpr = Math.min(2, window.devicePixelRatio || 1), V = MINIMAP.view;
    if (c.width !== Math.round(V.w * dpr)) { c.width = Math.round(V.w * dpr); c.height = Math.round(V.h * dpr); }
    const g = c.getContext("2d")!, W = c.width, H = c.height, k = dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!this.mmImg || !this.mmInfo || !feet) return;
    const T = minimapTransform(this.mmInfo), [u0, v0] = T.toImage(feet[0], feet[2]), z = this.mmZoom * k, ang = T.screenAngle(yaw);
    g.translate(W / 2, H / 2);
    g.rotate(ang);
    g.scale(z, z);
    g.globalAlpha = MINIMAP.mapAlpha;
    g.drawImage(this.mmImg, -u0, -v0);
    g.globalAlpha = 1;
    const tex = this.hudTex;
    for (const b of blips) {
      if (b.team !== myTeam || !tex) continue; // enemies are never drawn (0x70e785)
      const [u, v] = T.toImage(b.x, b.z), ic = b.alive ? MINIMAP.ally : MINIMAP.dead;
      g.save();
      g.translate(u - u0, v - v0);
      g.rotate(-ang); // icon upright on screen (the ally yaw is not in the blip data) [INFERIDO]
      g.scale(1 / this.mmZoom, 1 / this.mmZoom);
      g.drawImage(tex, ic.x, ic.y, ic.w, ic.h, -ic.dw / 2, -ic.dh / 2, ic.dw, ic.dh);
      g.restore();
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (tex) { const me = MINIMAP.self; g.drawImage(tex, me.x, me.y, me.w, me.h, W / 2 - (me.dw * k) / 2, H / 2 - (me.dh * k) / 2, me.dw * k, me.dh * k); }
  }

  /** Cash item: index into the exe table (0xb2fe2c), null = default green. */
  setCrosshairColor(index: number | null): void {
    this.crosshairColor = index === null ? CROSSHAIR.color : CROSSHAIR_COLORS[index] ?? CROSSHAIR.color;
  }

  /**
   * Visible elements covering the screen centre (±12% W/H) — HUD scene controls, other UI stages (respawn panel,
   * scope overlay) and leftovers of the old HUD (#hud / #crosshair). Used after a weapon switch to catch overlays.
   */
  centerOverlays(): string[] {
    const W = window.innerWidth, H = window.innerHeight;
    const cx0 = W * 0.38, cx1 = W * 0.62, cy0 = H * 0.38, cy1 = H * 0.62;
    const out: string[] = [];
    const cands = [
      ...this.box.querySelectorAll<HTMLElement>(".pbui-ctl"),
      ...document.querySelectorAll<HTMLElement>("#hud, #crosshair, [data-weapon-scope], .pbui-stage > .pbui-design > .pbui-scene"),
    ];
    for (const el of cands) {
      if (el.closest("[hidden]") || el.offsetParent === null && getComputedStyle(el).position !== "fixed") continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.width >= W * 0.95 || r.right < cx0 || r.left > cx1 || r.bottom < cy0 || r.top > cy1) continue;
      if (el.classList.contains("pbui-ctl") && !el.querySelector(".pbui-piece:not([hidden]),.pbui-caption,.pbhud-icon")) continue;
      out.push(`${el.dataset.name ?? el.dataset.scene ?? el.id ?? el.tagName} @${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  }

  dispose(): void { this.root.remove(); this.unsubAnnounceVolume?.(); }
}
