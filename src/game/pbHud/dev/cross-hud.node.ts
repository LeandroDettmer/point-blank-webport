// PNG check of the Cross battle HUD panels without a browser: the same pure layouts the page draws (charaPanel.ts charaLayout,
// crossScore.ts dashLayout, layout.ts missionPanelBox / minimapTransform / MINIMAP, hudText.ts text nodes), the Cross sheets of
// public/assets/ui/cross-hud and the client fonts (Gunplay.ttf of the client, the system Arial for the default font 0x4ada40).
// Text = i3TextAttrDX2::_ArrangeText placement (hudText.ts textOrigin) rasterised by lobby/screens/dev/ttf.mjs.
//   node --experimental-transform-types --no-warnings src/game/pbHud/dev/cross-hud.node.ts [outDir]
//   -> cross-hud-1024x768.png, cross-hud-1920x1080.png (radar NStation at yaw 0), radar-NStation-yaw0.png / -yawPI.png (x4 zoom),
//      cross-tab-1024x768.png (TAB board, 16 rows: crossScore.ts tabLayout)
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

register("../../../lobby/core/test/resolve-ts.mjs", import.meta.url);
const g = globalThis as Record<string, unknown>;
g.window ??= globalThis;
g.location ??= { search: "", hash: "", hostname: "127.0.0.1", protocol: "http:", host: "127.0.0.1:8000" };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "../../../..");
const HUDDIR = path.join(WEB, "public/assets/ui/cross-hud");
const OUT = process.argv[2] || path.join(HERE, "out");
fs.mkdirSync(OUT, { recursive: true });

const { tool } = await import(new URL("../../../../scripts/dev/lib/tools.mjs", import.meta.url).href) as { tool(rel: string): Promise<unknown> };
type Img = { w: number; h: number; rgba: Buffer };
const { decodePNG, encodePNG } = await tool("ui-export/lib.mjs") as { decodePNG(b: Buffer): Img; encodePNG(rgba: Buffer, w: number, h: number): Buffer };
const ttf = await import(new URL("../../../lobby/screens/dev/ttf.mjs", import.meta.url).href) as {
  loadFont(f: string): unknown; measure(f: unknown, s: string, px: number): number;
  drawText(f: unknown, s: string, px: number, x: number, baseY: number, blend: (x: number, y: number, a: number) => void): number;
};
const { charaLayout } = await import("../charaPanel.ts");
const { dashLayout, tabLayout } = await import("../crossScore.ts");
const { textOrigin } = await import("../hudText.ts");
const { MISSION_PANEL, MINIMAP, missionIcon, missionPanelBox, minimapTransform } = await import("../layout.ts");
import type { I3Text } from "../hudText.ts";
import type { PanelLayout } from "../charaPanel.ts";
import type { HudData } from "../model.ts";

const FONTS = {
  Gunplay: ttf.loadFont(path.join(WEB, "public/assets/ui/fonts/Gunplay.ttf")),
  Arial: ttf.loadFont("C:/Windows/Fonts/arial.ttf"),
  ArialBold: ttf.loadFont("C:/Windows/Fonts/arialbd.ttf"),
};
const sheets = new Map<string, Img>();
const sheet = (f: string): Img => { let s = sheets.get(f); if (!s) { s = decodePNG(fs.readFileSync(path.join(HUDDIR, f))); sheets.set(f, s); } return s; };

class Canvas {
  rgba: Buffer;
  constructor(public w: number, public h: number, bg: [number, number, number]) {
    this.rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) this.rgba.set([bg[0], bg[1], bg[2], 255], i * 4);
  }
  blend(x: number, y: number, r: number, gg: number, b: number, a: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const o = (y * this.w + x) * 4, k = Math.min(1, a);
    this.rgba[o] = this.rgba[o] * (1 - k) + r * k; this.rgba[o + 1] = this.rgba[o + 1] * (1 - k) + gg * k; this.rgba[o + 2] = this.rgba[o + 2] * (1 - k) + b * k;
  }
  /** sprite: uv rect of `img` stretched to the dest rect (nearest), like i3Sprite2D SetRect + SetTextureCoord */
  sprite(img: Img, uv: [number, number, number, number], x: number, y: number, w: number, h: number): void {
    const [l, t, r, b] = uv;
    for (let dy = 0; dy < Math.round(h); dy++) for (let dx = 0; dx < Math.round(w); dx++) {
      const sx = Math.floor(l + ((dx + 0.5) * (r - l)) / w), sy = Math.floor(t + ((dy + 0.5) * (b - t)) / h);
      if (sx < 0 || sy < 0 || sx >= img.w || sy >= img.h) continue;
      const o = (sy * img.w + sx) * 4;
      this.blend(Math.round(x) + dx, Math.round(y) + dy, img.rgba[o], img.rgba[o + 1], img.rgba[o + 2], img.rgba[o + 3] / 255);
    }
  }
  text(t: I3Text): void {
    const font = t.face === "Gunplay" ? FONTS.Gunplay : (t.weight ?? 400) >= 700 ? FONTS.ArialBold : FONTS.Arial;
    const probe = textOrigin(t, 0);
    const o = textOrigin(t, ttf.measure(font, t.text, probe.em));
    ttf.drawText(font, t.text, o.em, o.x, o.baseline, (x, y, a) => this.blend(x, y, t.color[0], t.color[1], t.color[2], a));
  }
  layout(l: PanelLayout): void {
    for (const b of l.boxes) this.sprite(sheet(`hud/${b.tex}`), b.uv, b.x, b.y, b.w, b.h);
    for (const t of l.texts) this.text(t);
  }
  save(f: string): void { fs.writeFileSync(f, encodePNG(this.rgba, this.w, this.h)); console.log("wrote", f); }
}

const hud = (W: number): HudData => ({
  hp: 87, maxHp: 100, armor: 0, helmet: true, grenades: 1, crouch: false,
  weapon: { name: "AK-47 G.", slot: 0, ammo: 23, reserve: 90, melee: false, reloading: false, reloadProgress: 0 },
  myTeam: 0, score: [12, 9], killLimit: 100, round: 1, timeLeft: 7 * 60 + 5, kills: 3, deaths: 1, assists: 0,
  phase: "live", showBoard: false, dead: false, rows: [], mapName: "NStation", modeName: "",
  missions: { panel: true, lines: [
    { text: "(Rifle)  Conseguir Kill\n 1/3 vezes", tab: "", state: 1 },
    { text: " Entre!\n 0/1 vezes", tab: "", state: 0 },
    { text: "(Em 1 Round) Vença uma partida!\n 1/1 vezes", tab: "", state: 2 },
  ] },
  ...(W ? {} : {}),
} as unknown as HudData);

/** radar: frame sprite, then the map in the viewport (9,9,153,153) rotated by screenAngle(yaw) around its centre, then the arrow */
function radar(cv: Canvas, map: string, feet: [number, number], yaw: number, zoom = MINIMAP.zoom): void {
  const idx = JSON.parse(fs.readFileSync(path.join(HUDDIR, "index.json"), "utf8")) as { radar: Record<string, { png: string; w: number; h: number; minfo: { realMapScale: number; realBakedSize: number; centerX: number; centerY: number } }> };
  const r = idx.radar[map], img = sheet(r.png), hudTex = sheet("hud/Hud.png");
  cv.sprite(hudTex, [340.7, 6, 504, 187], 5, 5, 164, 181);
  const T = minimapTransform({ w: r.w, h: r.h, ...r.minfo }), [u0, v0] = T.toImage(feet[0], feet[1]), ang = T.screenAngle(yaw);
  const V = MINIMAP.view, cx = V.x + V.w / 2, cy = V.y + V.h / 2, c = Math.cos(-ang), s = Math.sin(-ang);
  for (let y = V.y; y < V.y + V.h; y++) for (let x = V.x; x < V.x + V.w; x++) {
    const px = (x + 0.5 - cx) / zoom, py = (y + 0.5 - cy) / zoom;
    const u = Math.floor(u0 + px * c - py * s), v = Math.floor(v0 + px * s + py * c);
    if (u < 0 || v < 0 || u >= img.w || v >= img.h) continue;
    const o = (v * img.w + u) * 4;
    cv.blend(x, y, img.rgba[o], img.rgba[o + 1], img.rgba[o + 2], img.rgba[o + 3] / 255);
  }
  const me = MINIMAP.self;
  cv.sprite(hudTex, [me.x, me.y, me.x + me.w, me.y + me.h], cx - me.dw / 2, cy - me.dh / 2, me.dw, me.dh);
}

function mission(cv: Canvas, d: HudData): void {
  const P = MISSION_PANEL, T = P.text, tex = sheet(`hud/${P.sheet}`);
  const measure = (str: string) => ttf.measure(FONTS.Arial, str, T.font);
  const rows = d.missions!.lines.map((l) => ({ text: l.text, icon: missionIcon(l.state) }));
  const b = missionPanelBox(rows, P.top.y, measure);
  const uv = (r: { x: number; y: number; w: number; h: number }): [number, number, number, number] => [r.x, r.y, r.x + r.w, r.y + r.h];
  cv.sprite(tex, uv(P.top.src), b.top.x, b.top.y, b.top.w, b.top.h);
  cv.sprite(tex, uv(P.mid.src), b.mid.x, b.mid.y, b.mid.w, b.mid.h);
  cv.sprite(tex, uv(P.bottom.src), b.bottom.x, b.bottom.y, b.bottom.w, b.bottom.h);
  for (const r of b.rows) {
    cv.sprite(tex, uv(r.src), r.icon.x, r.icon.y, r.icon.w, r.icon.h);
    for (const l of r.lines) ttf.drawText(FONTS.Arial, l.text, T.font, l.x, l.y + (T.line - (T.font * 2288) / 2048) / 2 + (T.font * 1854) / 2048, (x, y, a) => cv.blend(x, y, 255, 255, 255, a));
  }
}

// [panel layer only on a flat backdrop: the world is not rendered]
for (const [W, H] of [[1024, 768], [1920, 1080]]) {
  const cv = new Canvas(W, H, [62, 72, 64]);
  const d = hud(W);
  radar(cv, "NStation", [0, 0], 0);
  mission(cv, d);
  cv.layout(dashLayout(d, W));
  cv.layout(charaLayout(d, W, H, { helmetSeen: false, throwShown: false }));
  cv.save(path.join(OUT, `cross-hud-${W}x${H}.png`));
}
for (const [name, yaw] of [["yaw0", 0], ["yawPI", Math.PI]] as const) {
  const cv = new Canvas(174, 191, [62, 72, 64]);
  radar(cv, "NStation", [0, 0], yaw);
  const big = new Canvas(174 * 3, 191 * 3, [0, 0, 0]);
  for (let y = 0; y < big.h; y++) for (let x = 0; x < big.w; x++) { const o = (Math.floor(y / 3) * cv.w + Math.floor(x / 3)) * 4; big.rgba.set(cv.rgba.subarray(o, o + 4), (y * big.w + x) * 4); }
  big.save(path.join(OUT, `radar-NStation-${name}.png`));
}

// TAB board with 16 rows (8 per team): ranks, nick colours, own row bar, dead labels, team totals
{
  const W = 1024, H = 768, cv = new Canvas(W, H, [62, 72, 64]);
  const names = ["Hawk", "Viper", "Kobra", "Raven", "Tank", "Ghost", "Blitz", "Shadow", "Falcon", "Wolf", "Sniper_BR", "Zeus", "Apollo", "Titan", "Nyx", "Orion"];
  const rows = names.map((name, i) => ({
    name, team: (i & 1) as 0 | 1, kills: 20 - i, deaths: (i * 7) % 11, headshots: 0, alive: i % 5 !== 3, local: i === 2,
    rank: [0, 7, 15, 23, 31, 39, 45, 50, 12, 3, 27, 41, 48, 19, 9, 52][i], nickColor: i % 11,
  }));
  const d = { ...hud(W), showBoard: true, rows, score: [57, 104] } as unknown as HudData;
  cv.layout(tabLayout(d, W, H));
  cv.save(path.join(OUT, "cross-tab-1024x768.png"));
}

// Kill feed (layout.ts killFeedRow, SetKillText 0x741210) at screen scale R = H/768: normal, headshot (badge at its s = 1 size),
// own kill (Hud.i3i bar), long names (shrunk to 200R together, then "..."). -> cross-feed-1024x768.png, cross-feed-1920x1080.png
{
  const { KILLFEED, killFeedRow, killIcon } = await import("../layout.ts");
  const { cellPx, emPx } = await import("../hudText.ts");
  const idx = JSON.parse(fs.readFileSync(path.join(HUDDIR, "index.json"), "utf8"));
  const K = KILLFEED, hudTex = sheet("hud/Hud.png");
  const uv = (r: { x: number; y: number; w: number; h: number }): [number, number, number, number] => [r.x, r.y, r.x + r.w, r.y + r.h];
  const rows = [
    { killer: ["Tank", 1], victim: ["Kobra", 0], id: 3004, hs: false, me: false },
    { killer: ["Hawk", 0], victim: ["Blitz", 1], id: 4003, hs: true, me: false },
    { killer: ["Você", 0], victim: ["Raven", 1], id: 1001, hs: false, me: true },
    { killer: ["Sniper_BR_Longname", 1], victim: ["XxDestroyerOfWorldsxX", 0], id: 5004, hs: true, me: false },
  ] as const;
  for (const [W, H] of [[1024, 768], [1920, 1080]]) {
    const R = H / 768, size = Math.round(K.font * R), cv = new Canvas(W, H, [62, 72, 64]);
    const em = emPx("Arial", size), measure = (s: string) => ttf.measure(FONTS.Arial, s, em);
    rows.forEach((f, n) => {
      const L = killFeedRow({ killer: f.killer[0], victim: f.victim[0] }, n, W, measure, R);
      if (f.me) cv.sprite(hudTex, uv(K.meSrc), L.me.x, L.me.y, L.me.w, L.me.h);
      const ki = killIcon(idx.killIcons, f.id);
      if (ki) cv.sprite(sheet(ki.png), uv(ki.src), L.icon.x, L.icon.y, L.icon.w, L.icon.h);
      if (f.hs) cv.sprite(hudTex, uv(K.hsSrc), L.hs.x, L.hs.y, L.hs.w, L.hs.h);
      const col = (t: number) => (t === 0 ? K.red : K.blue).slice(0, 3) as [number, number, number];
      cv.text({ text: L.killer, ...L.killerR, face: "Arial", size, color: col(f.killer[1]), ax: 0, ay: 0 });
      cv.text({ text: L.victim, ...L.victimR, face: "Arial", size, color: col(f.victim[1]), ax: 0, ay: 0 });
      if (n === 0) console.log(`R=${R.toFixed(3)} cell=${cellPx(size)} row0`, JSON.stringify(L));
    });
    cv.save(path.join(OUT, `cross-feed-${W}x${H}.png`));
  }
}
