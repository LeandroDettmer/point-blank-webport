// Pure geometry of the code-drawn HUD parts (no scene file behind them in the client): crosshair, hit marker,
// damage direction, kill feed, minimap transform. Shared by PbHud.ts (DOM/canvas) and dev/cross-hud.node.ts (PNG).
// Sources are exe addresses of the 2017 client (PBKaybo PointBlank.exe, VA) or the 2017 textures exported by
// pb-extract-tools ui-export/hud-2017.mjs; everything else is marked [INFERIDO] / [RECRIADO].

export type Rect = { x: number; y: number; w: number; h: number };
export type RGBA = [number, number, number, number];

// ---- crosshair (Crosshair::Crosshair 0x758f50, Crosshair_Cross OnUpdate 0xa3f860, CalcRminLen 0x7598b0)
/**
 * 4 sprites of 1 px x len, centred on the render-target centre (W/2, H/2):
 *   rmin = tan(crosshair° * PI/180) * H/2   (CalcRminLen: [boneCtx+0xb0] degrees -> 0x75df60 tan, * (H/2))
 *   len  = weapon info vtbl slot +0xb4 (Cross; 2017 +0xb8), drawn from rmin to rmin+len: CWeaponInfo 0x5be9e0 = 5.0 px; CGunInfo
 *          0x5c7ad0 = the gun's pef float at +0x1348, the key stored before CrossHair_Min = CrossHair_Expand [INFERIDO: the pef key
 *          names are obfuscated].
 * Note: unlike WeaponSystem.crosshairRadiusPx() the exe does NOT divide by tan(fov/2).
 * Colour: ctor sets (0, 255, 0, 255); with the "ColorCrosshair" cash item (goods 0x4786c2b0) the RGB comes from the
 * 11-entry table at 0xb2fe2c (CROSSHAIR_COLORS). The 4 types are decoded below (crosshairShape).
 */
export const CROSSHAIR = { len: 5, thickness: 1, color: [0, 255, 0, 255] as RGBA };
export const CROSSHAIR_COLORS: RGBA[] = [
  [255, 255, 255, 255], [121, 23, 0, 255], [227, 96, 0, 255], [255, 211, 3, 255], [196, 213, 0, 255], [128, 217, 0, 255],
  [32, 171, 0, 255], [3, 181, 255, 255], [0, 96, 227, 255], [0, 35, 107, 255], [115, 37, 117, 255],
];
export function crosshairRadius(H: number, spreadDeg: number): number {
  return Math.tan((spreadDeg * Math.PI) / 180) * (H / 2);
}
/** Screen rects (px) of the 4 lines: down, up, right, left (sprite order 0..3 of 0xa3f860). */
/** line length of a weapon: its pef CrossHair_Expand for a gun (the only weapons whose pef carries it), else 5 */
export const crosshairLen = (expand: number | undefined): number => expand ?? CROSSHAIR.len;
export function crosshairLines(W: number, H: number, spreadDeg: number, L: number = CROSSHAIR.len): Rect[] {
  const cx = W / 2, cy = H / 2, r = crosshairRadius(H, spreadDeg), t = CROSSHAIR.thickness;
  return [
    { x: cx - t / 2, y: cy + r, w: t, h: L },
    { x: cx - t / 2, y: cy - r - L, w: t, h: L },
    { x: cx + r, y: cy - t / 2, w: L, h: t },
    { x: cx - r - L, y: cy - t / 2, w: L, h: t },
  ];
}

/**
 * Crosshair types = i3 classes picked by the saved string (option block +0x700; default "Crosshair_Cross" 0x4cd40a, unknown
 * string -> Cross 0x4ce9ee). The Jogar tab radios (setter 0x886f10, string write 0x885365, read 0x884d28) are
 * Radio2 = CrossDot, Radio1 = Cross, Radio4 = Ring, Radio3 = Dot; on screen Radio1..4 run left to right.
 *   Cross    OnUpdate 0xa3f860: the 4 lines above.
 *   CrossDot OnUpdate 0xa403a0: the 4 lines + a 5th sprite 1x1 centred on (W/2, H/2).
 *   Dot      Create 0xa40db0: 6 vertices, 2 triangles = a diamond of half-diagonal 3 px (3 / (W/2) in NDC), static (no spread).
 *   Ring     Create 0xa415c0 / OnUpdate 0xa41680: 40 vertices as a line list = 20 segments, step PI/10 (0xcb8040), radius
 *            rmin + len px (same CalcRminLen as Cross), colour as the others.
 */
export const CROSSHAIR_TYPES = ["Crosshair_Cross", "Crosshair_CrossDot", "Crosshair_Dot", "Crosshair_Ring"] as const;
export type CrosshairType = (typeof CROSSHAIR_TYPES)[number];
export const CROSSHAIR_DOT = { half: 3 };
export const CROSSHAIR_RING = { segments: 20 };
export interface CrosshairShape { rects: Rect[]; /** filled polygon (px) */ poly?: [number, number][]; /** closed 1 px line loop (px) */ loop?: [number, number][] }
export function crosshairShape(type: CrosshairType, W: number, H: number, spreadDeg: number, len: number = CROSSHAIR.len): CrosshairShape {
  const cx = W / 2, cy = H / 2;
  switch (type) {
    case "Crosshair_CrossDot": return { rects: [...crosshairLines(W, H, spreadDeg, len), { x: cx - 0.5, y: cy - 0.5, w: 1, h: 1 }] };
    case "Crosshair_Dot": { const d = CROSSHAIR_DOT.half; return { rects: [], poly: [[cx, cy - d], [cx + d, cy], [cx, cy + d], [cx - d, cy]] }; }
    case "Crosshair_Ring": {
      const r = crosshairRadius(H, spreadDeg) + len, n = CROSSHAIR_RING.segments;
      return { rects: [], loop: Array.from({ length: n }, (_, i) => [cx + Math.cos((i * 2 * Math.PI) / n) * r, cy + Math.sin((i * 2 * Math.PI) / n) * r] as [number, number]) };
    }
    default: return { rects: crosshairLines(W, H, spreadDeg, len) };
  }
}

// ---- hit marker:
// Gui/Ingame/Hud.i3i UV (286,122)-(319,154), top-left fixed at (W/2 - 16.5, H/2 - 15.5), SrcBlend 5 / DestBlend 2 (additive),
// white. SetHit: 33 x 33, alpha 255. Per FRAME: size +1 px up to 43 (grows right / down), alpha -10; hidden at 0 (26 frames).
export const HITMARK = { src: { x: 286, y: 122, w: 33, h: 32 }, dx: -16.5, dy: -15.5, size0: 33, sizeMax: 43, alpha0: 255, alphaStep: 10 };

// ---- damage direction (CHud 0x74ebf0, fade 0x7527e0): Hud.i3i UV (1,203)-(161,405), a 160x202 quad whose top
// part is the red arc; ring buffer of 10. Angle a = atan2(dir.x, dir.z) - myYaw (0xa65600); quad centre =
// (W/2 - R sin a, H/2 - R cos a), rotated by a, R = 140 px (100 on spawn), NOT resolution-scaled (0x7528de).
// Here rel = bearing (+right) = -a, so the canvas rotation is +rel with the quad centred at (0, -R).
// Cross update 0x747bf0: the camera yaw change of the frame is added to every live angle; the integer
// alpha (255 at the hit) loses (int)(100 * dt) per frame with dt floored at 0.01 (0x747d93), hidden at <= 0: 1 per frame between
// 50 and 100 fps (4.25 s at 60 fps). [INFERIDO] the exe floor is the float 0.0099999998, whose 100x truncates to 0 above 100 fps
// (the arc would never fade); the web floors at exactly 0.01 so it fades 1 per frame there.
export const DAMAGE_ARC = { src: { x: 1, y: 203, w: 160, h: 202 }, r: 140, max: 10 };
export const damageArcFade = (dt: number): number => Math.trunc(100 * Math.max(dt, 0.01));
/** Quad rect relative to the screen centre before rotation (screen px). */
export function damageArcRect(): Rect {
  const { w, h } = DAMAGE_ARC.src;
  return { x: -w / 2, y: -DAMAGE_ARC.r - h / 2, w, h };
}

// ---- grenade warning: per thrown object, by the weapon's
// pef IndicatorType (DefaultGrenade = 1 -> slots 0-7, C5 = 2 -> slots 8-15). Badge Hud.i3i 64x64 UV (0,0)-(63,63) (C5: 52x52
// UV (104,448)-(155,499)) centred at (W/2 - 100 sin a, H/2 - 100 cos a); arrow 32x32 UV (0,64)-(32,96) at R 135 rotated a;
// text '%.1fM' 10 px white at the badge's right-bottom - (130, 43) (C5: - (124, 40)). Range 10 m (K400 pool 8 m).
// Which objects (WeaponSystem.grenadesNear, filter 0x7441e0 / collectors 0x744950, 0x744ac0): class type 7 with an IndicatorType,
// thrown and nearly still (flags 1 and 2), not an ally's (own and enemy objects show), within 10 m of the character root.
export const GRENADE_WARN = {
  badge: { x: 0, y: 0, w: 63, h: 63, dw: 64, dh: 64 }, arrow: { x: 0, y: 64, w: 32, h: 32 }, rBadge: 100, rArrow: 135, text: { dx: 130, dy: 43, font: 10 },
  /** IndicatorType "C5" (slots 8-15): 52x52 badge UV (104,448)-(155,499), text at its right-bottom - (124, 40) */
  c5: { badge: { x: 104, y: 448, w: 51, h: 51, dw: 52, dh: 52 }, text: { dx: 124, dy: 40, font: 10 } },
};

// ---- screen blood (Gui/Ingame/blood.i3i of UI_Ingame.i3Pack, exported to public/assets/ui/hud/blood.png by
// pb-extract-tools ui-export/hud-2017.mjs): the red splatter that frames the screen when the local player is hit. The sheet is
// 512x1024 DXT5 but its alpha stops at row 767 (recorded as index.textures["blood.png"].content); the surviving
// 512x768 is a frame, and an asymmetric one. Mean alpha over each band of that box: top 115.6, bottom 115.5,
// left 123.4, right 14.7, dead centre 0.0 — so the centre really is clear and there is NO band on the right.
// Mean colour of the visible pixels is (105, 0, 0), i.e. the sheet is already red and needs no tint.
// The pack also ships blood_blue / blood_green and themed Blood_{Demonic,Fire,Flower,PBTC2016,X-Mas2015/2016}.
// Draw: Cross CHud::CreateHUD 0x739bd0 (+0x61c / +0x64c): left half UV (0,0)-(511,767), right half the same cell reversed on
// both axes (PbHud.drawBlood); blood_green.i3i when 0x688660 is false (not reproduced).
/** Cross 0x746c80: alpha = clamp(255 * cos(t / 2)) for pi s after the trigger 0x746bf0 (damage handler 0xa58390) */
export const SCREEN_BLOOD = { life: Math.PI };

// ---- kill feed. Cross exe CHud::SetKillText 0x741210, update 0x7434a9, text nodes made in CreateHUD
// 0x73c054 (victim +0x1f0) / 0x73c122 (killer +0x1a0). All lengths times R = getHeightRatioBy768 (screen px):
//   row n (0 = oldest shown) text box at y = 30*(n+1), h 30, 20 slots, life 5.0 s, no fade; survivors move up 30.
//   text nodes: i3TextNodeDX2::Create(Arial, size round(10R), weight 400, no shadow: Create arg 7 = 0), SetAlign(0, 0) = left / top.
//   names: while killerW + victimW > 200 the wider one (victim when victimW > killerW, else killer) loses 2; setSize(w, 30) then
// SetTextEllipsis (i3SceneDx 0x100db7e0: prefix that fits w - width +).
//   victim x = W - victimW - 15 (victimW = getTextWidth after the ellipsis); killer x = victim.x - 100 - killerW.
//   colours red (252,88,88), blue (67,182,243).
//   weapon icon (sprite +0x78[n], 0x7410d0): SetRect(victim.x - 100, victim.y - 11, 100, 36), cell 127x39 of
//   Gui/WeaponShape/Weapon_Kill{ord/88}.i3i (ord%88, 8 x 11 cells), ord = _UIShapeIndex (pb-extract-tools index.killIcons):
//   the icon fills the 100 px gap between the two names.
//   own kill/death: Hud.i3i UV (568,284)-(888,310) bar at (W-319, y-8, 319x28) (0x741fe6).
//   headshot (+0xc8, flag arg+0x14 without arg+0x18): Hud.i3i UV (183,204)-(238,242) at (victim.x-75, y-10) 55x36 times s;
//   s = 3 at the kill, -8/s down to 1 (0x7434e1), the rect keeps its top-left (0x7435d9). The hud3 helmet variants (+0xd0 / +0xcc,
//   arg+0x18) are not fed by addKill.
export const KILLFEED = {
  max: 20, life: 5, pitch: 30, right: 15, gap: 100, iconW: 100, iconH: 36, iconDy: 11, font: 10, maxNames: 200, shrink: 2,
  red: [252, 88, 88, 1] as RGBA, blue: [67, 182, 243, 1] as RGBA,
  meSrc: { x: 568, y: 284, w: 320, h: 26 }, meW: 319, meH: 28, meDy: 8,
  hsSrc: { x: 183, y: 204, w: 55, h: 38 }, hsW: 55, hsH: 36, hsDx: 75, hsDy: 10, hsAlpha: 200 / 255, // SetColor(255,255,255,200) 0x73bd6c
  hsScale: (t: number) => Math.max(1, 3 - 8 * t),
};
export interface FeedRowIn { killer: string; victim: string }
export interface FeedRowOut { killer: string; victim: string; y: number; killerR: Rect; icon: Rect; hs: Rect; victimR: Rect; me: Rect }
/** SetTextEllipsis (Cross i3SceneDx 0x100db7e0): text that fits w, else the longest prefix that fits w - width + "..." */
export function ellipsis(s: string, w: number, measure: (s: string) => number): string {
  if (measure(s) <= w) return s;
  let left = w - measure("..."), n = 0;
  for (const ch of s) { left -= measure(ch); if (left < 0) break; n += ch.length; }
  return s.slice(0, n) + "...";
}
/**
 * Row n of the list for screen width W at scale R (H/768; the page lays out in 1024x768 design px, R = 1);
 * measure(text) = px width at the row font (size round(10R)). SetKillText 0x741210.
 */
export function killFeedRow(r: FeedRowIn, n: number, W: number, measurePx: (s: string) => number, R = 1): FeedRowOut {
  const K = KILLFEED, measure = (s: string) => Math.trunc(measurePx(s)); // getTextWidth is an int
  let kw = r.killer ? measure(r.killer) : 0, vw = measure(r.victim);
  while (kw + vw > K.maxNames * R) { if (vw > kw) vw -= Math.trunc(K.shrink * R); else kw -= Math.trunc(K.shrink * R); }
  const victim = ellipsis(r.victim, vw, measure), killer = r.killer ? ellipsis(r.killer, kw, measure) : "";
  const vtw = measure(victim), ktw = killer ? measure(killer) : 0;
  const y = Math.trunc(K.pitch * R * (n + 1)), h = Math.trunc(K.pitch * R);
  const vx = Math.trunc(W - vtw - K.right * R);
  return {
    killer, victim, y,
    victimR: { x: vx, y, w: vw, h },
    killerR: { x: Math.trunc(vx - K.gap * R - ktw), y, w: kw, h },
    icon: { x: vx - K.gap * R, y: y - K.iconDy * R, w: K.iconW * R, h: K.iconH * R },
    hs: { x: vx - K.hsDx * R, y: y - K.hsDy * R, w: K.hsW * R, h: K.hsH * R },
    me: { x: W - K.meW * R, y: y - K.meDy * R, w: K.meW * R, h: K.meH * R },
  };
}
export interface KillIcons { cell: { w: number; h: number; cols: number; perPage: number }; pages: string[]; ord: Record<string, number> }
/** Page PNG + source rect of an item id's kill icon (key = id without the slot digit), null when unknown. */
export function killIcon(icons: KillIcons | undefined, itemId: number | null | undefined): { png: string; src: Rect } | null {
  if (!icons?.ord || itemId == null) return null; // Cross index: no ord table yet (kill feed falls back to the item icon)
  const ord = icons.ord[String(itemId % 100000)];
  if (ord === undefined) return null;
  const c = icons.cell, page = Math.floor(ord / c.perPage), cell = ord % c.perPage;
  const png = icons.pages[page];
  return png ? { png, src: { x: (cell % c.cols) * c.w, y: Math.floor(cell / c.cols) * c.h, w: c.w, h: c.h } } : null;
}

// ---- minimap (pb-extract-tools ui-export/hud-2017.mjs: minfo_<Map>.txt; axis check against collision.glb)
export interface MinimapInfo { w: number; h: number; realMapScale: number; realBakedSize: number; centerX: number; centerY: number }
/**
 * Image px of a world point: u = CenterX - x*k, v = CenterY - z*k, k = RealBakedSize / RealMapScale px/m
 *.
 * screenAngle(yaw): rotation that puts the view direction up. Player forward in world = (-sin yaw, -cos yaw)
 * (Player.yaw, three.js camera) -> image direction (+sin yaw*k, +cos yaw*k); rotating the map by -angle of that
 * vector plus 90 degrees puts it at screen up. [INFERIDO: radar rotates with the view; the 2017 _UpdateUnit was
 * not fully decoded]
 */
export function minimapTransform(m: MinimapInfo) {
  const k = m.realBakedSize / m.realMapScale;
  return {
    k,
    toImage: (x: number, z: number): [number, number] => [m.centerX - x * k, m.centerY - z * k],
    screenAngle: (yaw: number) => yaw - Math.PI,
  };
}
/**
 * CBattleHUD_MiniMap (0x708150..): radar mode is the EnvSet default (+0xc8 = 0, 0x4cce12): map rotated by -yaw, self
 * arrow fixed up, ally arrows rotated by allyYaw - myYaw. 1 image px = zoom screen px, zoom 0.8 default, +/-0.1 per
 * key, clamped 0.5..1.1 (0x709960). Enemies are NEVER drawn (unit loop skips other teams, 0x70e785).
 * Icons (Hud.i3i, 0x709090): self arrow (227,44)-(245,78.5) 17x34.5, ally arrow (172,89)-(182,111) 10x22,
 * dead ally (255,69)-(267,81) 12x12 (same cells in the Cross exe 0x6fe610). Frame 164x181 at (5,5) (0x6fe500); the map viewport is
 * SetViewportRect(9, 9, 153, 153) in radar mode (Cross 0x701aee; full-screen mode: a W- or H-sized square, 0x701ba7), player at
 * its centre. Map rotation: -angle when the option +0xc8 is 0, else 0 (Cross 0x702248..0x70228d). At yaw 0 the player faces +v
 * (image down), so the heading-up radar shows the map turned 180 degrees (baked texts upside down): not a mirror.
 */
export const MINIMAP = {
  area: "mm_Frm_Area", view: { x: 9, y: 9, w: 153, h: 153 }, zoom: 0.8, zoomMin: 0.5, zoomMax: 1.1, zoomStep: 0.1, mapAlpha: 1,
  self: { x: 227, y: 44, w: 18, h: 34.5, dw: 17, dh: 34.5 },
  ally: { x: 172, y: 89, w: 10, h: 22, dw: 10, dh: 22 },
  dead: { x: 255, y: 69, w: 12, h: 12, dw: 12, dh: 12 },
};

// ---- mission panel (CChallengeBoard, Cross CHud+0x5fc; Create 0x6fc220, Update 0x6fc620, icon UV 0x6fccd0, icon rect 0x6fce20;
// 1, the same code as the 2017 board 0x7066d0 / 0x706ad0)
/**
 * Fixed left panel listing the active mission card's tasks, absolute window px (not scaled). Sprite set +0x6c = 3 frame pieces of
 * the Cross Hud.i3i (texture 0, Hud.png): top (4,188 166x29, title "Alerta de Missão" baked in the texture), middle (4,217 166xH),
 * bottom; Update sets the middle to H = the rows' total advance and the bottom to (4, 217+H, 166x9) (the 29 px tall UV squashed to
 * 9, 0x6fcbd4 / 0x6fcc1f); with no row the set is disabled (0x6fcb76). Sprite set +0x70 = 4 state icons 15x16 (UV 14x15 at
 * (515,281) + 17 px in u per state: 0 empty, 1 in progress, 2 done); Create puts icon i at (6 + 4, 29 + 188 + 35 i) (0x6fce20 adds
 * 4 / 188 to its table), Update keeps row 0 there and moves every next row to the previous y + (getTextHeight + 1) *
 * getVisibleLineCount + 6 (0x6fca6e..0x6fcad6). Text node per row: setPos(icon + (18, 2)), width = board width 166 - icon x - 18
 * = 138, auto wrap, size 10 weight 0 (0x4ada50), SetTextSpace(0, 2).
 * Font: i3TextAttrDX2::CreateEx (2017 i3SceneDx.dll 0x10105b40) sets lfHeight = i3Gfx::FontPointToPixel(10) = 13 at 96 dpi,
 * positive = cell height, so the Arial em is 13 * 2048 / 2288 = 11.6 px (GDI renders it at 12 ppem) and getTextHeight = 13.
 * The panel's top (188) sits 2 px under the Cross minimap frame (CBattleHUD_MiniMap 0x6fe500: 164x181 at 5,5, bottom 186).
 * [INFERIDO] 12 px CSS font (the 12 ppem GDI size), line pitch = getTextHeight + 1 = 14 px, colour white, word wrap rule of
 * i3TextNodeDX2's auto wrap (break at spaces, a word wider than the box breaks between characters).
 */
export const MISSION_PANEL = {
  sheet: "Hud.png", x: 4, w: 166,
  top: { y: 188, h: 29, src: { x: 515, y: 148, w: 165, h: 29 } },
  mid: { src: { x: 515, y: 179, w: 165, h: 27 } },
  bottom: { h: 9, src: { x: 515, y: 209, w: 165, h: 29 } },
  icon: { x: 10, w: 15, h: 16, src: { x: 515, y: 281, w: 14, h: 15 }, step: 17 },
  text: { dx: 18, dy: 2, w: 138, font: 12, line: 14, gap: 6 },
};
/** Hud.i3i cell of a task state icon (0x6fccd0: u + 0x11 for 1, + 0x22 for 2) */
export function missionIcon(state: 0 | 1 | 2): Rect {
  const s = MISSION_PANEL.icon.src;
  return { x: s.x + state * MISSION_PANEL.icon.step, y: s.y, w: s.w, h: s.h };
}
/**
 * Lines of an auto-wrapped text node (i3TextNodeDX2 setAutoWrapEnable + setSize(w, ...)): each "\n" starts a line, words go on
 * the line while it fits, a word wider than the box alone breaks between characters. Spaces are kept as written (the quest texts
 * have double spaces where an empty piece sits). `measure` = width in px of a string in the panel font [INFERIDO wrap rule].
 */
export function wrapText(text: string, w: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(?<= )/)) { // words keep their trailing space
      if (line && measure(line + word.trimEnd()) > w) { out.push(line.trimEnd()); line = ""; }
      line += word;
      // a word wider than the box on its own line: cut it between characters
      while (measure(line.trimEnd()) > w && line.trimEnd().length > 1) {
        let n = line.length - 1;
        while (n > 1 && measure(line.slice(0, n)) > w) n--;
        out.push(line.slice(0, n));
        line = line.slice(n);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}
export interface MissionPanelBox {
  top: Rect; mid: Rect; bottom: Rect;
  /** per task: state icon rect + its Hud.i3i cell, the text box and its wrapped lines (`y` = top of a `text.line` px tall line) */
  rows: { icon: Rect; src: Rect; text: Rect; lines: { text: string; x: number; y: number }[] }[];
}
/**
 * Update 0x706ad0 laid out from the panel top `y`: middle piece from y + 29, row 0 at its top, each next row
 * (getTextHeight + 1) * lines + 6 lower; the middle as tall as the rows' total advance, the 9 px bottom right under it.
 */
export function missionPanelBox(rows: { text: string; icon: Rect }[], y: number, measure: (s: string) => number): MissionPanelBox {
  const P = MISSION_PANEL, T = P.text, x0 = P.icon.x;
  const midY = y + P.top.h;
  let ry = midY;
  const out = rows.map((r) => {
    const lines = wrapText(r.text, T.w, measure);
    const tx = x0 + T.dx, ty = ry + T.dy;
    const row = {
      icon: { x: x0, y: ry, w: P.icon.w, h: P.icon.h }, src: r.icon,
      text: { x: tx, y: ty, w: T.w, h: lines.length * T.line },
      lines: lines.map((text, i) => ({ text, x: tx, y: ty + i * T.line })),
    };
    ry += T.line * lines.length + T.gap;
    return row;
  });
  const h = ry - midY;
  return {
    top: { x: P.x, y, w: P.w, h: P.top.h },
    mid: { x: P.x, y: midY, w: P.w, h },
    bottom: { x: P.x, y: midY + h, w: P.w, h: P.bottom.h },
    rows: out,
  };
}
