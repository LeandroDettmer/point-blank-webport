// Score bar and Tab board of the Point Blank Cross client, from the Cross PointBlank.exe. Window px:
// W / H = the view size, no 768 design scaling.
//   DashPanel  CHUD_Dashboard (Create 0x7335b0, from CHud::CreateHUD 0x73bdd4; texts 0x734320). Wc = W / 2, Y0 = 18 when the stage
//              type (0x597e80) is 4 / 13 / 45, else 0 (0x708e00). Sprites of Hud.i3i (uv l, t, r, b).
//   TabBoard   CHUD_Score (0x72dc20): see tabLayout.
// [INFERIDO]: Y0 = 0 (the web has no stage-type table for 0x597e80); the hud3 variants of mode 10 and the +0x84 mode icon are not
// drawn; sprite idx3 (265x31, y not decoded) is not drawn; dash texts: see dashLayout; Tab: see tabLayout.
import { CROSS_HUD } from "./crossAssets.ts";
import { LayoutView, placeBox, type PanelLayout, type SprBox } from "./charaPanel.ts";
import { textCss, type I3Text, type RGB } from "./hudText.ts";
import { sortedRows, type HudData, type Team } from "./model.ts";
import { NICK_COLORS } from "../battleChatModel.ts";
import { tOr } from "../../lobby/ui/i18n.ts";
import { CLAN_MARK_DEFAULT, drawClanMark } from "../../lobby/clanMark.ts";
import { markAtlas } from "../../lobby/screensCross/clanMarkView.ts";

const HUD = `url("${CROSS_HUD}/hud/Hud.png")`;
const ROW_FONT = `Arial,"Liberation Sans",sans-serif`;

function div(parent: HTMLElement): HTMLDivElement {
  const d = document.createElement("div");
  d.style.position = "absolute";
  parent.appendChild(d);
  return d;
}

/** text box in window px; restyled only when position / style change */
function label(el: HTMLElement, s: string, x: number, y: number, w: number, h: number, css: string): void {
  if (el.textContent !== s) el.textContent = s;
  const key = `${x},${y},${w},${h},${css}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;white-space:nowrap;line-height:${h}px;${css}`;
}

function layer(parent: HTMLElement): HTMLDivElement {
  const l = document.createElement("div");
  l.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;display:none";
  parent.appendChild(l);
  return l;
}

/** Y0 of the mission HUD (bomb panel, mission notice): 18 when the stage type (STAGE_ID >> 24) is 4 / 13 / 45 (CHud 0x708e00), else 0 */
export const stageY0 = (stageType: number): number => ([4, 13, 45].includes(stageType) ? 18 : 0);

/**
 * CHUD_Dashboard sprites and text nodes (Create 0x7335b0, texts created 0x734074..0x7342a9, placed 0x734320, timer 0x734875).
 * Texts (hudText.ts): +0x88[i], all Gunplay, weight 400, SetAlign(1, 1) = centred; colour (180,180,180) except i 4 (205,205,50).
 * 0 timer "%02d %02d:" 19 at (Wc-42, Y0+45) 83x26; 2 / 3 red / blue score "%d" 25 at
 *   (Wc-118 / Wc+42, Y0+8) 75x40; 4 the goal at (Wc-37, Y0+9) 75x40 = "%d" of the kill table {60,80,100,120,140,160} (0xbec288) in
 *   the kill modes (0x7354c0: stage type 1 / 8 / 13), "" in type 12 (0x4de190), else "%dR" of the round table {3,2,3,5,7,9}
 *   (0xbec2a4), both indexed by the room's condition & 0xf.
 * Sprites: idx0 background and idx4 timer box always; of the team plates idx1 (red) / idx2 (blue) only the own team's (0x7338f0);
 * idx6 centre icon disabled in both create branches (0x733ab9 / 0x733b07); the hud3 mode icon +0x84 only when 0x532000 (alt HUD,
 * not drawn); strip idx3 only for the stage types 4 / 13 / 45 (0x733f7e, Y0 = 18 there).
 * [INFERIDO]: Y0 = 0; the round modes = d.bomb, and the goal shown is HudData.killLimit (kills, or rounds in a round mode);
 * 0x597550() & 2 = the blue team.
 */
export function dashLayout(d: HudData, W: number): PanelLayout {
  const Wc = Math.round(W / 2), Y0 = 0, hud = "Hud.png";
  const box = (x: number, y: number, w: number, h: number, u: number, v: number) => ({ tex: hud, x, y, w, h, uv: [u, v, u + w, v + h] as [number, number, number, number] });
  const boxes = [
    box(Wc - 133, Y0 + 6, 266, 43, 4, 116), // idx0 background
    box(Wc - 37, Y0 + 50, 72, 19, 98, 160), // idx4 timer box
    // only the own team's plate (0x7338f0: 0x597550() & 2 -> idx2 on / idx1 off, else idx1 on / idx2 off)
    d.myTeam === 1 ? box(Wc + 42, Y0 + 13.5, 74, 27, 252, 36) : box(Wc - 117, Y0 + 13.5, 74, 27, 252, 3),
  ];
  const t = Math.max(0, Math.ceil(d.timeLeft)), p2 = (n: number) => String(n).padStart(2, "0");
  const G: RGB = [180, 180, 180];
  const node = (text: string, x: number, y: number, w: number, h: number, size: number, color: RGB = G): I3Text => ({ text, x, y, w, h, face: "Gunplay", size, color, ax: 1, ay: 1 });
  const texts = [
    node(`${p2(Math.min(99, Math.floor(t / 60)))}   ${p2(t % 60)}`, Wc - 42, Y0 + 48, 83, 26, 19),
    node(":", Wc - 42, Y0 + 45, 83, 26, 19),
    node(String(d.score[0]), Wc - 118, Y0 + 8, 75, 40, 25),
    node(String(d.score[1]), Wc + 42, Y0 + 8, 75, 40, 25),
    node(d.bomb ? `${d.killLimit}R` : String(d.killLimit), Wc - 37, Y0 + 9, 75, 40, 23, [205, 205, 50]),
  ];
  return { boxes, texts };
}

export class DashPanel {
  private layer: HTMLDivElement;
  private view: LayoutView;
  private visible = false;

  constructor(parent: HTMLElement) {
    this.layer = layer(parent);
    this.view = new LayoutView(this.layer);
  }

  render(d: HudData, W: number, _H: number, visible: boolean): void {
    if (visible !== this.visible) { this.visible = visible; this.layer.style.display = visible ? "" : "none"; }
    if (!visible) return;
    this.view.render(dashLayout(d, W));
  }
}

/**
 * CHUD_Score TAB board (Create 0x72dc20, rows filled by UpdateStageNormalScore 0x72fbc0). BX = (W >> 1) - 387; the board sprites
 * use BY = (H >> 1) - 308, the row nodes / marks a second base BR = (H >> 1) - 300 (0x72e82e: - 288 - 12). Row r = 0..7 of a team
 * (red = left, blue = right, dx 375 / 376).
 *   Text nodes +0x74[80] (0x72e9c6): Create(default font 0x4ada50 = Arial, 64, size 10, weight 400), SetAlign(1, 1), white.
 *     nick (+0x74) (BX+105 / BX+480, BR+111+26r) 124x24 SetAlign(0, 1), colour = nick colour table 0xb210a4 (NICK_COLORS);
 * kills (+0x94) BX+264 / BX+640 and deaths (+0xb4) BX+303 / BX+680, 46x24,;
 *     dead label (+0xd4) BX+226 / BX+602 46x24 (255,204,0) STR_TBL_INGAME_HUD_DEATH_TEXT, on when the chara is dead (0x4c2850(0xb)).
 *   Rank +0x1fc (0x72f4ba, texture 12 = Gui/Interface/level_icon.i3i): (BX+77 / BX+453, BR+111+26r) 23x23, uv cell 24 px of 10 per
 *     row, (rank%10*24, rank/10*24) + 22 (0x7320d0).
 *   Clan mark +0x200 (0x72f3a2): (BX+47 / BX+423, BR+110+26r) 25x25, emblem of the slot's clan (0x7317c0).
 *   Own row bar = board sprite idx1 (Score uv 2,590,342,618) at (nick.x - 88, nick.y - 3) 364x27 (0x73063e).
 *   Totals: 3 digit cells 17x24 (uv u = 784 + 21 d, v 47..70) at BX+302 / BX+685 + 17 k, BY+340 (0x72f8f0).
 * Not drawn: the ping bars +0x1b4 at BX+349 / BX+724 (the web has no per-player ping) and the medal +0x1b4 of the slot 0x57e560
 * (context +0x2cc00, not identified); the title texts and the result labels idx8 / idx9. The column headers are drawn (see HEADS).
 * [INFERIDO]: rows without a rank (bots, offline) use rank 0 (an empty slot record); left list = red, right = blue.
 * Row fonts / align proof (2026-10-13, Cross exe): nodes created 0x72e9c6 with Arial 10 (0x4ada50 default font, weight 400, size 10),
 * SetAlign 1,1, white; nick SetAlign 0,1 (0x72eaec); dead label (255,204,0) (0x72ebc5); row placement 0x72eaa0 (red) / 0x72ec1a (blue);
 * clan 0x72f3a2 (+ BR+110), rank 0x72f502 (+ BR+111, 23x23 per 0xbc8b14, clan 25 per 0xb3607c). Texture = Gui/Interface/level_icon.i3i.
 */
const TAB_X = [
  { clan: 47, rank: 77, nick: 105, dead: 226, kills: 264, deaths: 303 },
  { clan: 423, rank: 453, nick: 480, dead: 602, kills: 640, deaths: 680 },
] as const;

export function tabLayout(d: HudData, W: number, H: number): PanelLayout {
  const BX = (W >> 1) - 387, BY = (H >> 1) - 308, BR = (H >> 1) - 300;
  const boxes: SprBox[] = [{ tex: "Score.png", x: BX - 1, y: BY - 1, w: 775, h: 576, uv: [0, 0, 774, 575] }];
  const texts: I3Text[] = [];
  const W255: RGB = [255, 255, 255];
  const node = (text: string, x: number, y: number, w: number, color: RGB = W255, ax: 0 | 1 = 1): I3Text => ({ text, x, y, w, h: 24, face: "Arial", size: 10, color, ax, ay: 1 });
  const dead = tOr("STR_TBL_INGAME_HUD_DEATH_TEXT", "Morto");
  // column headers, CHUD_Score create 0x72ee19..0x72f2a5 (proof, PointBlank.exe Cross): 7 nodes per team, +0x17c..+0x1b0 of the
  // 80-node array (created 0x72e9c6, Arial 10, SetAlign 1,1). SetPos (BX + x, BR+81: [ebp-0x18] = H/2 - 0x240/2 - 0xc at 0x72e831, + 0x51 at 0x72ee5d), SetSize (w, 25). Red x 18 / 47 / 76 / 103 / 265 / 300,
  // w 29 / 28 / 28 / 165 / 39 / 55; blue = red + 375 (393 / 422 / 451 / 478 / 640 / 675). Keys (0xbc9e6c.., 0xbc9f74..): ORDER,
  // CLAN, RANK, NICK, KILL, DEATH. Node 7 (+0x1ac / +0x1b0) has an empty string: not drawn. Headers are centred in their own rect.
  const HEADS: { key: string; fb: string; x: number; w: number }[] = [
    { key: "STR_TBL_INGAME_HUD_SCORE_TEXT_ORDER", fb: "Rank", x: 18, w: 29 },
    { key: "STR_TBL_INGAME_HUD_SCORE_TEXT_CLAN", fb: "Clã", x: 47, w: 28 },
    { key: "STR_TBL_INGAME_HUD_SCORE_TEXT_RANK", fb: "Nível", x: 76, w: 28 },
    { key: "STR_TBL_INGAME_HUD_SCORE_TEXT_NICK", fb: "Apelido", x: 103, w: 165 },
    { key: "STR_TBL_INGAME_HUD_SCORE_TEXT_KILL", fb: "KILL", x: 265, w: 39 },
    { key: "STR_TBL_INGAME_HUD_SCORE_TEXT_DEATH", fb: "DEATH", x: 300, w: 55 },
  ];
  for (const t of [0, 1] as Team[]) for (const h of HEADS) {
    texts.push({ ...node(tOr(h.key, h.fb), BX + h.x + 375 * t, BR + 81, h.w), h: 25 });
  }
  for (const t of [0, 1] as Team[]) {
    const X = t === 0 ? TAB_X[0] : TAB_X[1];
    sortedRows(d.rows, t).slice(0, 8).forEach((row, r) => {
      const y = BR + 111 + 26 * r, nx = BX + X.nick;
      if (row.local) boxes.push({ tex: "Score.png", x: nx - 88, y: y - 3, w: 364, h: 27, uv: [2, 590, 342, 618] });
      const rank = row.rank ?? 0;
      boxes.push({ tex: "level_icon.png", x: BX + X.rank, y, w: 23, h: 23, uv: [(rank % 10) * 24, Math.floor(rank / 10) * 24, (rank % 10) * 24 + 22, Math.floor(rank / 10) * 24 + 22] });
      texts.push(node(row.name, nx, y, 124, [...(NICK_COLORS[row.nickColor ?? 0] ?? W255)] as RGB, 0));
      if (!row.alive) texts.push(node(dead, BX + X.dead, y, 46, [255, 204, 0]));
      texts.push(node(String(row.kills), BX + X.kills, y, 46));
      texts.push(node(String(row.deaths), BX + X.deaths, y, 46));
    });
    const v = Math.min(999, Math.max(0, d.score[t]));
    [100, 10, 1].forEach((place, k) => {
      const dg = Math.floor(v / place) % 10;
      if (k === 2 || v >= place) boxes.push({ tex: "Score.png", x: BX + (t ? 685 : 302) + 17 * k, y: BY + 340, w: 17, h: 24, uv: [784 + 21 * dg, 47, 800 + 21 * dg, 70] });
    });
  }
  return { boxes, texts };
}

/** clan marks of the TAB rows (+0x200: (BX+47 / BX+423, BR+110+26r) 25x25), one canvas per emblem; rows without a clan have none */
function tabClans(d: HudData, W: number, H: number): { logo: number; x: number; y: number }[] {
  const BX = (W >> 1) - 387, BR = (H >> 1) - 300, out: { logo: number; x: number; y: number }[] = [];
  for (const t of [0, 1] as Team[]) sortedRows(d.rows, t).slice(0, 8).forEach((row, r) => {
    const logo = row.clanLogo;
    if (logo !== undefined && logo !== 0 && logo !== CLAN_MARK_DEFAULT) out.push({ logo, x: BX + TAB_X[t].clan, y: BR + 110 + 26 * r });
  });
  return out;
}

export class TabBoard {
  private layer: HTMLDivElement;
  private view: LayoutView;
  private clans: HTMLCanvasElement[] = [];
  private clanKey = "";
  private visible = false;

  constructor(parent: HTMLElement) {
    this.layer = layer(parent);
    this.view = new LayoutView(this.layer);
  }

  render(d: HudData, W: number, H: number, visible: boolean): void {
    if (visible !== this.visible) { this.visible = visible; this.layer.style.display = visible ? "" : "none"; }
    if (!visible) return;
    this.view.render(tabLayout(d, W, H));
    const marks = tabClans(d, W, H), atlas = marks.length ? markAtlas() : null;
    const key = atlas ? JSON.stringify(marks) : "";
    if (key === this.clanKey) return;
    this.clanKey = key;
    this.clans.forEach((c) => c.remove());
    this.clans = [];
    if (!atlas) return;
    const px = Math.round(25 * Math.min(2, window.devicePixelRatio || 1));
    for (const m of marks) {
      const cv = document.createElement("canvas");
      cv.width = cv.height = px;
      cv.style.cssText = `position:absolute;left:${m.x}px;top:${m.y}px;width:25px;height:25px`;
      const g = cv.getContext("2d");
      if (g && drawClanMark(g, m.logo, 0, 0, px, atlas)) { this.layer.appendChild(cv); this.clans.push(cv); }
    }
  }
}

/**
 * Bomb Mission HUD of the Cross exe, Hud.i3i sprites CHud+0xe4, window px, cx = round(W / 2), Y0 = stageY0
 * (0x740d36: 0, or 18 when 0x708e00 matches stage type 4 / 13 / 45). Per frame CHud::OnUpdate calls 0x740620 and, in mission state 3 (planted), 0x740d00.
 * - hold bar (0x740620): background 444x27 at (cx-222, H-95) = pixel (535,98) stretched; fill 439 * (1 - t/T) x 21 at (cx-219, H-92)
 *   = pixel (176,101) stretched, t/T = the hold share.
 * - before the plant (0x740620 while missionMgr+0x14 is set; 0x580880 sets it per frame when the local chara is in a site area,
 *   any team, same test as BombMode.siteAt): sprite 1 grey C4 uv 421,264,504,319 at (cx-42, Y0+75) 90x46
 *   (0x7407a8); sprites 0 / 2 / 5 hidden. After the round (state 4, 0x740570) every sprite and the text are hidden.
 * - planted (0x740d00): sprite 1 hidden, sprite 0 timer box uv 376,455,510,491 at (cx-96, Y0+80) 203x36, sprite 2 lit C4 uv
 *   421,205,504,258 moved to (cx-110, Y0+75) 90x46 (0x740e93), sprite 5 defuse kit (wrench) uv 412,323,444,355 at (cx-58, Y0+85)
 *   33x33 (0x740ef7) when the own slot (0x4c8c60 = +0x2a0fc, the slot 0x5845d0 reads) is odd = blue team. Drawn in index order.
 *   Text +0x298 (Create size 16 = points, weight 700, SetAlign(1, 1) = centre / middle (0x73d094), (cx-26, Y0+80) 133x36, 0x73d049 /
 *   0x73d062; cell 21 px, em 18.7 px, hudText.ts): '%02d:%02d:%02d' (m, s, centis) when m > 0, else '%02d:%02d' (s, centis);
 *   white (255,255,255,255, 0x74106f), and when m == 0 and s < 10 colour (1, .2, .2, a), a = min(1, sin(15 t) * 0.5 + 1), t = the
 *   fuse left (0x740fc5; 0x52bac0 = the engine's sine table).
 */
/** one Hud.i3i texel (u, v) stretched to w x h: a 1 px box scaled by transform (a huge background-size breaks browsers) */
function pixel(el: HTMLElement, x: number, y: number, w: number, h: number, u: number, v: number): void {
  const key = `px${x},${y},${w},${h},${u},${v}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:1px;height:1px;background:${HUD} -${u}px -${v}px no-repeat;transform-origin:0 0;transform:scale(${w},${h});display:${w > 0 ? "block" : "none"}`;
}

/** Hud.i3i (1024x512) rect u0,v0,u1,v1 stretched to w x h at (x, y); w = 0 hides it */
function sprite(el: HTMLElement, x: number, y: number, w: number, h: number, [u0, v0, u1, v1]: readonly number[]): void {
  const kx = w / (u1 - u0), ky = h / (v1 - v0);
  placeBox(el, x, y, w, h, `${HUD} -${u0 * kx}px -${v0 * ky}px / ${1024 * kx}px ${512 * ky}px`);
}

const C4_GREY = [421, 264, 504, 319], C4_LIT = [421, 205, 504, 258], TIMER_BOX = [376, 455, 510, 491], DEFUSE_KIT = [412, 323, 444, 355];

export class BombPanel {
  private layer: HTMLDivElement;
  private barBg: HTMLDivElement;
  private barFill: HTMLDivElement;
  private panel: HTMLDivElement;
  private grey: HTMLDivElement;
  private lit: HTMLDivElement;
  private kit: HTMLDivElement;
  private timer: HTMLDivElement;
  /** C4 hint box (CHud +0xdc: Hud.i3i pixel 531,14, 401 x 67 at (cx-200, H-170)) and its text (+0x29c: 600 x 67 at (cx-300, H-170)) */
  private hintBox: HTMLDivElement;
  private hintLabel: HTMLDivElement;
  private visible = false;

  constructor(parent: HTMLElement) {
    this.layer = layer(parent);
    [this.barBg, this.barFill, this.panel, this.grey, this.lit, this.kit, this.timer, this.hintBox, this.hintLabel] = Array.from({ length: 9 }, () => div(this.layer));
  }

  render(d: HudData, W: number, H: number, visible: boolean): void {
    const b = d.bomb, on = visible && !!b;
    if (on !== this.visible) { this.visible = on; this.layer.style.display = on ? "" : "none"; }
    if (!on || !b) return;
    const cx = Math.round(W / 2), Y0 = stageY0(d.stageType ?? 0);
    const hold = b.progress > 0, fuse = b.fuseLeft !== null;
    pixel(this.barBg, cx - 222, H - 95, hold ? 444 : 0, 27, 535, 98);
    pixel(this.barFill, cx - 219, H - 92, hold ? Math.round(439 * (1 - Math.min(1, b.progress))) : 0, 21, 176, 101);
    sprite(this.panel, cx - 96, Y0 + 80, fuse ? 203 : 0, 36, TIMER_BOX);
    sprite(this.grey, cx - 42, Y0 + 75, b.before && !fuse ? 90 : 0, 46, C4_GREY);
    sprite(this.lit, cx - 110, Y0 + 75, fuse ? 90 : 0, 46, C4_LIT);
    sprite(this.kit, cx - 58, Y0 + 85, fuse && d.myTeam === 1 ? 33 : 0, 33, DEFUSE_KIT);
    const t = Math.max(0, b.fuseLeft ?? 0), m = Math.floor(t / 60), s = Math.floor(t) % 60, c = Math.floor((t - Math.floor(t)) * 100);
    const p2 = (n: number): string => String(n).padStart(2, "0");
    const red = m === 0 && s < 10, a = red ? Math.min(1, Math.sin(15 * t) * 0.5 + 1) : 1;
    const T: I3Text = { text: "", x: cx - 26, y: Y0 + 80, w: 133, h: 36, face: "Arial", size: 16, weight: 700, color: [255, 255, 255], ax: 1, ay: 1 };
    label(this.timer, fuse ? (m > 0 ? `${p2(m)}:${p2(s)}:${p2(c)}` : `${p2(s)}:${p2(c)}`) : "",
      T.x, T.y, T.w, T.h, `${textCss(T, ROW_FONT)};color:${red ? `rgba(255,51,51,${a.toFixed(2)})` : "#fff"}`);
    // C4 hint (CHud::UpdateMissionNotice 0x74b1e0, box 0x740312 hides it after 5 s): the box is the same Hud.i3i pixel for every hint
    const hint = b.hint ?? "", hintW = hint ? 401 : 0;
    pixel(this.hintBox, cx - 200, H - 170, hintW, 67, 531, 14);
    const H13: I3Text = { text: hint, x: cx - 300, y: H - 170, w: 600, h: 67, face: "Arial", size: 13, weight: 700, color: [255, 255, 255], ax: 1, ay: 1 };
    label(this.hintLabel, hint, H13.x, H13.y, H13.w, H13.h, textCss(H13, ROW_FONT));
  }
}

// Destroy target HP (CHUD_TargetHP::Create 0x729310 "A" pieces, _UpdateTargetHP_DestroyMission 0x72ae80; 
// §Target HP). Left = red objective, right = blue. The bars are the 10 px strips of Hud.i3i (u 684..783): the red strip is at v 162
// and the blue one at v 149 [INFERIDO colour from the art]. Each bar shrinks toward the centre: 99 px at full life.
const TARGET_PLATE = [[682, 176, 833, 219], [836, 176, 987, 219]] as const;
const TARGET_ICON = [[788, 149, 824, 175], [826, 149, 862, 175]] as const;
const TARGET_BAR_V = [162, 149] as const;
export class TargetHpPanel {
  private layer: HTMLDivElement;
  private plate: HTMLDivElement[] = [];
  private icon: HTMLDivElement[] = [];
  private bar: HTMLDivElement[] = [];
  private visible = false;

  constructor(parent: HTMLElement) {
    this.layer = layer(parent);
    for (let i = 0; i < 2; i++) { this.plate.push(div(this.layer)); this.icon.push(div(this.layer)); this.bar.push(div(this.layer)); }
  }

  render(d: HudData, W: number, H: number, visible: boolean): void {
    const o = d.objectives, on = visible && !!o;
    if (on !== this.visible) { this.visible = on; this.layer.style.display = on ? "" : "none"; }
    if (!on || !o) return;
    const cx = Math.round(W / 2), Y0 = stageY0(d.stageType ?? 0);
    sprite(this.plate[0], cx - 191, Y0 + 37, 151, 43, TARGET_PLATE[0]);
    sprite(this.plate[1], cx + 39, Y0 + 37, 151, 43, TARGET_PLATE[1]);
    sprite(this.icon[0], cx - 181, Y0 + 46, 36, 26, TARGET_ICON[0]);
    sprite(this.icon[1], cx + 144, Y0 + 47, 36, 26, TARGET_ICON[1]);
    const fill = (life: number, max: number): number => Math.max(0, Math.min(99, Math.round(99 * life / max)));
    const fl = fill(o.bar[0], o.max[0]), fr = fill(o.bar[1], o.max[1]);
    // the uv range is never empty (a 0 fill still divides by its width): the bar's width is the fill, 0 hides it
    sprite(this.bar[0], cx - 144 + (99 - fl), Y0 + 53.5, fl, 10, [783 - Math.max(fl, 1), TARGET_BAR_V[0], 783, TARGET_BAR_V[0] + 9]);
    sprite(this.bar[1], cx + 43, Y0 + 53.5, fr, 10, [684, TARGET_BAR_V[1], 684 + Math.max(fr, 1), TARGET_BAR_V[1] + 9]);
  }
}

/** Round end banner of the Cross exe, Hud.i3i, window px,
 * y = H/2 - 38.5: the winning team's plate +, or the own team's plate + "EMPATOU" on a draw. No timer: it stays until
 *  the next RoundStart hides it (0x769799 -> 0x73f920(0)), i.e. until HudData.round changes (match.beginRound, 5153). */
const PLATE: Record<Team, { dx: number; w: number; u: number; v: number; win: { dx: number; u: number; v: number } }> = {
  0: { dx: -237.5, w: 325, u: 513, v: 335, win: { dx: 112, u: 862, v: 453 } },
  1: { dx: -247, w: 364, u: 513, v: 395, win: { dx: 122, u: 704, v: 453 } },
};
export class RoundBanner {
  private layer: HTMLDivElement;
  private plate: HTMLDivElement;
  private word: HTMLDivElement;
  /** up since the round end; the round number it ended (taken on the first frame after show) */
  private up = false;
  private round: number | null = null;
  private winner: Team | null = null;

  constructor(parent: HTMLElement) {
    this.layer = layer(parent);
    [this.plate, this.word] = [div(this.layer), div(this.layer)];
  }

  show(winner: Team | null): void { this.winner = winner; this.up = true; this.round = null; }

  render(d: HudData, W: number, H: number): void {
    if (this.up) { this.round ??= d.round; if (d.round !== this.round) this.up = false; }
    const on = this.up && !d.final;
    this.layer.style.display = on ? "" : "none";
    if (!on) return;
    const cx = W / 2, y = H / 2 - 38.5, team: Team = this.winner ?? d.myTeam, p = PLATE[team];
    placeBox(this.plate, cx + p.dx, y, p.w, 57, `${HUD} -${p.u}px -${p.v}px`);
    if (this.winner === null) placeBox(this.word, cx + 132, y, 187, 55, `${HUD} -514px -452px`);
    else placeBox(this.word, cx + p.win.dx, y, 157, 57, `${HUD} -${p.win.u}px -${p.win.v}px`);
  }
}
