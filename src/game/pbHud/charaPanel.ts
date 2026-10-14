// CHUD_CharaState of the Point Blank Cross client (PointBlank.exe, create 0x720f70, text pos 0x723550, weapon update 0x724650 ..
// 0x7269b6; RE of the Cross exe, / 4): the HP / ammo / weapon panel. Positions are absolute
// window px: W / H = the view size (no 768 design scaling). Panel origin X0 = W - 175, Y0 = H - 104. Textures: Gui/Ingame/Hud.i3i
// (cross-hud/hud/Hud.png); uv is l, t, r, b. `charaLayout` is pure (the PNG check dev/cross-hud.node.ts draws the same list).
//  - Sprites shown for a gun: background, portrait (crouch uv on crouch, 0x723ca6), ammo frame + fill (4 px per round, 0x724f51).
//    The update (0x725142..0x7255dd) disables every weapon-class icon (+0x78 idx1..4, 9..11; hud2 +0xa4; hud3 +0xa8) for a gun;
//    they belong to special weapons (knife kinds, dino, K-201...).
//  - Text nodes (Create / SetAlign at 0x7227e9..0x7232ee, hudText.ts): HP +0x7c "%03d" Gunplay 28 (142,183,64) at (W-170, H-43)
//    70x50, left / top; ammo +0x80 "%03d/%03d" (0x725b85) Gunplay 19 at (W-100, H-82) 100x30, left / top, "        %d" for the
//    count-only weapons (0x726069), off for melee (0x725150); weapon name +0x84 Arial 10 (180,180,180) at (W-109, H-97) 92x13,
// centred. +0x90 / +0x94 ("%d" /, 0x724490) are a points counter of another mode: not drawn.
//  - Helmet slot idx6 (0x727e80): hidden until the chara has a helmet, then uv (463,323) and, once it is lost, (463,373) (flag
//    +0xbc). Throwable slot idx8 (0x728050): while slot 3 is the weapon in hand, uv (413,359) when its weapon passes the per-item
//    check, else the empty frame (413,407); hidden when another weapon is in hand and the check fails (flag +0xc0).
// [INFERIDO]: the per-item check of 0x728050 (vtbl+0x228(2) over the slot's list) = grenades left > 0; the knife class icon idx1
// for every melee weapon (the knife branches of 0x7257cd.. pick per knife name); the fill capped at 21 rounds (84 px frame);
// slot >= 3 = the "        %d" count text; ammo text colour white (no SetColor at create).
import { CROSS_HUD } from "./crossAssets.ts";
import { FONTS } from "../../lobby/ui/assets.ts";
import { textCss, type I3Text, type RGB } from "./hudText.ts";
import type { HudData } from "./model.ts";

type UV = [number, number, number, number];
/** dim = SetColor 0xa0 (the inactive dual gun's gauge): rgb and alpha x 160/255 */
export interface SprBox { x: number; y: number; w: number; h: number; tex: string; uv: UV; dim?: boolean }
export interface PanelLayout { boxes: SprBox[]; texts: I3Text[] }
/** state the exe keeps across frames: helmet flag +0xbc, throwable flag +0xc0 */
export interface CharaFlags { helmetSeen: boolean; throwShown: boolean }

const GREEN: RGB = [142, 183, 64], GREY: RGB = [180, 180, 180], WHITE: RGB = [255, 255, 255];
const AMMO_CELLS = 21, CELL_PX = 4;
const pad3 = (n: number) => String(Math.max(0, Math.trunc(n))).padStart(3, "0");

/** ammo gauge: frame 84x18 + n rounds x 4 px fill (ammo bar frame +0xb0 idx0 / fill idx1, 0x724f51) */
function ammoBar(boxes: SprBox[], x: number, y: number, n: number, dim: boolean): void {
  boxes.push({ tex: "Hud.png", x, y, w: 84, h: 18, uv: [155, 1, 237, 19], dim });
  if (n > 0) boxes.push({ tex: "Hud.png", x, y, w: n * CELL_PX, h: 17, uv: [157, 23, 157 + n * CELL_PX, 40], dim });
}

export function charaLayout(d: HudData, W: number, H: number, f: CharaFlags): PanelLayout {
  const X0 = W - 175, Y0 = H - 104, w = d.weapon, melee = w.melee, count = !melee && w.slot >= 3;
  // 0x727e80 / 0x728050: flags first (they persist across frames)
  if (d.helmet) f.helmetSeen = true;
  if (w.slot === 3) f.throwShown = true;
  else if (!((d.grenades ?? 0) > 0)) f.throwShown = false;
  const hud = "Hud.png";
  const boxes: SprBox[] = [
    { tex: hud, x: X0 - 1, y: Y0, w: 162, h: 96, uv: [244, 206, 406, 302] },
    { tex: hud, x: X0 + 8, y: Y0 + 10, w: 42, h: 50, uv: d.crouch ? [67, 1, 109, 51] : [110, 1, 152, 51] },
  ];
  if (melee) boxes.push({ tex: hud, x: X0 + 74, y: Y0 + 25, w: 77, h: 15, uv: [187, 185, 269, 200] });
  if (f.helmetSeen) boxes.push({ tex: hud, x: X0 + 115, y: Y0 - 47, w: 46, h: 46, uv: d.helmet ? [463, 323, 509, 369] : [463, 373, 509, 419] });
  if (f.throwShown) boxes.push({ tex: hud, x: X0 + 115, y: Y0 - 96, w: 46, h: 46, uv: (d.grenades ?? 0) > 0 ? [413, 359, 458, 405] : [413, 407, 458, 453] });
  if (!melee && !count) {
    const n = Math.min(AMMO_CELLS, Math.max(0, w.ammo));
    if (w.dual) {
      // SetDualGage 0x728270: the 1st gauge moves to (W-102, H-54), the 2nd (+0xb4) sits at (W-103, H-49). The gun that
      // fires next is bright, the other is dimmed (SetColor 0xa0). [INFERIDO] both gauges show the shared magazine count
      const left = w.dual.left;
      ammoBar(boxes, W - 102, H - 54, n, left);
      ammoBar(boxes, W - 103, H - 49, n, !left);
    } else ammoBar(boxes, W - 103, H - 52, n, false);
  }
  const texts: I3Text[] = [
    { text: pad3(Math.ceil(d.hp)), x: W - 170, y: H - 43, w: 70, h: 50, face: "Gunplay", size: 28, color: GREEN },
    { text: w.name, x: W - 109, y: H - 97, w: 92, h: 13, face: "Arial", size: 10, color: GREY, ax: 1, ay: 1 },
  ];
  if (!melee) texts.push({ text: count ? `        ${Math.max(0, w.ammo)}` : `${pad3(w.ammo)}/${pad3(w.reserve)}`, x: W - 100, y: H - 82, w: 100, h: 30, face: "Gunplay", size: 19, color: WHITE });
  return { boxes, texts };
}

/** one sprite box in window px (background = sheet url + -u -v), restyled only when it changes */
export function placeBox(el: HTMLElement, x: number, y: number, w: number, h: number, bg: string): void {
  const key = `${x},${y},${w},${h},${bg}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${bg} no-repeat`;
}

/** SprBox: the uv rect stretched to w x h like i3Sprite2D SetRect + SetTextureCoord (a scale transform when the sizes differ) */
function placeSprite(el: HTMLElement, b: SprBox): void {
  const uw = b.uv[2] - b.uv[0], uh = b.uv[3] - b.uv[1];
  placeBox(el, b.x, b.y, uw, uh, `url("${CROSS_HUD}/hud/${b.tex}") -${b.uv[0]}px -${b.uv[1]}px`);
  const tf = uw === b.w && uh === b.h ? "" : `scale(${b.w / uw},${b.h / uh})`;
  if (el.style.transform !== tf) { el.style.transform = tf; el.style.transformOrigin = "0 0"; }
  // SetColor 0xa0 on all four channels = rgb and alpha x 160/255
  const op = b.dim ? "0.627" : "", shade = b.dim ? "brightness(0.627)" : "";
  if (el.style.opacity !== op) el.style.opacity = op;
  if (el.style.filter !== shade) el.style.filter = shade;
}

/** text node in window px (hudText.ts textCss), restyled only when it changes */
export function placeText(el: HTMLElement, t: I3Text): void {
  if (el.textContent !== t.text) el.textContent = t.text;
  const css = textCss(t, t.face === "Gunplay" ? FONTS.hudNumber : FONTS.hudText) + ";pointer-events:none";
  if (el.dataset.key === css) return;
  el.dataset.key = css;
  el.style.cssText = css;
}

/** draws a PanelLayout into a layer, reusing one element per index */
export class LayoutView {
  private boxes: HTMLDivElement[] = [];
  private texts: HTMLDivElement[] = [];
  private boxLayer = document.createElement("div");
  private textLayer = document.createElement("div");
  constructor(layer: HTMLElement) {
    // sprites under the texts, whatever order the pools grow in
    layer.append(this.boxLayer, this.textLayer);
  }
  render(l: PanelLayout): void {
    const take = (pool: HTMLDivElement[], i: number) => {
      let el = pool[i];
      if (!el) { el = document.createElement("div"); (pool === this.boxes ? this.boxLayer : this.textLayer).appendChild(el); pool[i] = el; }
      if (el.style.display === "none") el.style.display = "";
      return el;
    };
    l.boxes.forEach((b, i) => placeSprite(take(this.boxes, i), b));
    l.texts.forEach((t, i) => placeText(take(this.texts, i), t));
    for (let i = l.boxes.length; i < this.boxes.length; i++) { this.boxes[i].style.display = "none"; this.boxes[i].dataset.key = ""; }
    for (let i = l.texts.length; i < this.texts.length; i++) { this.texts[i].style.display = "none"; this.texts[i].dataset.key = ""; }
  }
}

export class CharaPanel {
  private layer: HTMLDivElement;
  private view: LayoutView;
  private flags: CharaFlags = { helmetSeen: false, throwShown: false };
  private visible = false;

  constructor(parent: HTMLElement) {
    this.layer = document.createElement("div");
    this.layer.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;display:none";
    parent.appendChild(this.layer);
    this.view = new LayoutView(this.layer);
  }

  /** Per frame. W / H = window px (the view), visible = the panel's show rule (PbHud.render). */
  render(d: HudData, W: number, H: number, visible: boolean): void {
    if (visible !== this.visible) { this.visible = visible; this.layer.style.display = visible ? "" : "none"; }
    if (!visible) return;
    this.view.render(charaLayout(d, W, H, this.flags));
  }
}
