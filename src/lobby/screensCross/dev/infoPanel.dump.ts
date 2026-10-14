// Dump of the lobby "Informações do jogo" panel (lbInfoWin) without a browser: every row's key / value rect (1024x768
// design px) and the lines the engine rule gives (arrangeText below) next to what the CSS layout shows (pre-wrap +
// overflow-wrap:anywhere; "before" = with the 20 px clip app.ts put on the keys, removed now). Glyph widths = Arial hmtx (Windows font) at the
// CSS size i3Gui uses (13 px cell / 1.117), close to the browser's canvas measure. Also the mode tag sprite mode
// (isPieces: pieces = all 11 tags drawn on top of each other, states = one tag).
//   npx --no-install tsx src/lobby/screensCross/dev/infoPanel.dump.ts [C:/Windows/Fonts/arial.ttf]
import fs from "node:fs";
import { isPieces, type GNode } from "../../ui/i3Gui.ts";

/**
 * Reference port of the line breaks of i3TextAttrDX2::_ArrangeText (i3SceneDx 0x101041d0) with auto wrap on (the wrap rule
 * itself is ported in i3Gui.ts by its owner): glyph advances (+ space x) add up until the line passes the box width W; a
 * space / tab there breaks before it; otherwise the part of the word since the last space (from line start when there is
 * none) is measured (_calcGlyphWidth 0x100a44d0): wider than W minus itself (more than half the box) -> break inside the word
 * before the glyph that overflowed, else after that space. A line keeps at least one glyph. Nothing is clipped to the box
 * (setOutCharaProcess, +0x22c, is 0 from the ctor 0x10104800 and the lobby never turns it on). The engine keeps the space a
 * wrapped line starts with but skips its advance (0x105043cd); dropped here.
 */
export function arrangeText(s: string, w: number, charW: (ch: string) => number, spaceX = 0): string {
  const out: string[] = [];
  for (const para of s.split("\n")) {
    const g = [...para];
    let start = 0;
    if (!g.length) out.push("");
    while (start < g.length) {
      let width = 0, space = start, i = start;
      for (; i < g.length; i++) {
        if (g[i] === " ") space = i;
        width += charW(g[i]) + spaceX;
        if (width > w) break;
      }
      let end = g.length;
      if (i < g.length) {
        if (g[i] === " " || g[i] === "\t") end = i;
        else {
          const seg = g.slice(space, i + 1).reduce((a, ch) => a + charW(ch) + spaceX, 0);
          end = seg > w - seg ? i : space + 1;
        }
        end = Math.max(end, start + 1);
      }
      out.push(g.slice(start, end).join(""));
      start = end;
      while (start < g.length && g[start] === " ") start++;
    }
  }
  return out.join("\n");
}

const font = fs.readFileSync(process.argv[2] ?? "C:/Windows/Fonts/arial.ttf");
const tables: Record<string, number> = {};
for (let i = 0; i < font.readUInt16BE(4); i++) { const o = 12 + i * 16; tables[font.toString("latin1", o, o + 4)] = font.readUInt32BE(o + 8); }
const cm = tables.cmap;
let sub = 0;
for (let i = 0; i < font.readUInt16BE(cm + 2); i++) if (font.readUInt16BE(cm + 4 + i * 8) === 3 && font.readUInt16BE(cm + 6 + i * 8) === 1) sub = cm + font.readUInt32BE(cm + 8 + i * 8);
const seg2 = font.readUInt16BE(sub + 6), ends = sub + 14, starts = ends + seg2 + 2, deltas = starts + seg2, ros = deltas + seg2;
function glyph(c: number): number {
  for (let i = 0; i < seg2 / 2; i++) {
    if (c > font.readUInt16BE(ends + i * 2)) continue;
    const st = font.readUInt16BE(starts + i * 2), d = font.readInt16BE(deltas + i * 2), ro = font.readUInt16BE(ros + i * 2);
    if (c < st) return 0;
    if (!ro) return (c + d) & 0xffff;
    const g = font.readUInt16BE(ros + i * 2 + ro + (c - st) * 2);
    return g ? (g + d) & 0xffff : 0;
  }
  return 0;
}
const nh = font.readUInt16BE(tables.hhea + 34), px = 13 / ((1854 + 434) / 2048);
const charW = (ch: string) => (font.readUInt16BE(tables.hmtx + Math.min(glyph(ch.codePointAt(0)!), nh - 1) * 4) / 2048) * px;
const width = (s: string) => [...s].reduce((a, ch) => a + charW(ch), 0);

/** the old browser layout: pre-wrap breaks at spaces, overflow-wrap:anywhere inside a word wider than the box */
function cssLines(s: string, w: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of s.split(" ")) {
    const t = line ? `${line} ${word}` : word;
    if (width(t) <= w) { line = t; continue; }
    if (line) out.push(line);
    line = "";
    for (const ch of word) { if (width(line + ch) > w && line) { out.push(line); line = ""; } line += ch; }
  }
  out.push(line);
  return out;
}

const pack = JSON.parse(fs.readFileSync("public/assets/ui/cross/UI_Project_Lobby.json", "utf8")) as { root: GNode };
const strings = JSON.parse(fs.readFileSync("public/assets/ui/cross/strings.json", "utf8")) as Record<string, string>;
const find = (n: GNode, name: string, ox = 0, oy = 0): { n: GNode; x: number; y: number } | null => {
  if (n.name === name) return { n, x: ox + n.x, y: oy + n.y };
  for (const c of n.children ?? []) { const f = find(c, name, ox + n.x, oy + n.y); if (f) return f; }
  return null;
};
const KEYS: [string, string, string][] = [
  ["Map", "STR_TBL_GUI_LOBBY_MAP_INFO_TEXT", "M. Station"], ["Mode", "STR_TBL_GUI_LOBBY_GAME_MODE_TEXT", "Deathmatch"],
  ["Type", "STR_TBL_GUI_LOBBY_GAME_SETTING_TEXT", "60 Kills / 10 min"], ["Host", "STR_TBL_GUI_LOBBY_ROOM_MASTER_TEXT", "infa26768"],
  ["State", "STR_TBL_GUI_LOBBY_PROGRESS_TEXT", "Aguarde..."], ["JoinLimit", "STR_TBL_GUI_LOBBY_LIMIT_ENTER_TEXT", "Não"],
  ["WeaponLimit", "STR_TBL_GUI_LOBBY_LIMIT_WEAPON_TEXT", "Não"], ["ObserverLimit", "STR_TBL_GUI_LOBBY_LIMIT_OBSERVER", "Utilizar todos"],
  ["TeamBalance", "STR_TBL_GUI_LOBBY_TEAM_BALANCE_TEXT", "Não"],
];
const LINE = 13; // fontCell(10)
const show = (lines: string[], boxH: number, clip: boolean) => {
  const top = (boxH - lines.length * LINE) / 2;
  return lines.map((l, i) => {
    const y0 = top + i * LINE, cut = clip && (y0 < 0 || y0 + LINE > boxH) ? ` (cut ${Math.max(0, -y0) + Math.max(0, y0 + LINE - boxH)}px)` : "";
    return `"${l}" y${y0}${cut}`;
  }).join(" | ");
};
for (const [k, str, val] of KEYS) {
  const key = find(pack.root, `lb${k}Key`)!, value = find(pack.root, `lb${k}Value`)!, text = strings[str] ?? str;
  console.log(`lb${k}Key   rect ${key.x},${key.y} ${key.n.w}x${key.n.h} align ${JSON.stringify(key.n.txt?.align)} "${text}" w${width(text).toFixed(0)}`);
  console.log(`   before: ${show(cssLines(text, key.n.w), key.n.h, true)}`);
  console.log(`   after:  ${show(arrangeText(text, key.n.w, charW).split("\n"), key.n.h, false)}`);
  console.log(`lb${k}Value rect ${value.x},${value.y} ${value.n.w}x${value.n.h} "${arrangeText(val, value.n.w, charW).replace(/\n/g, " | ")}"`);
}
const mode = find(pack.root, "lbSlotMode1")!, dm = "Deathmatch";
console.log(`lbSlotMode1 rect ${mode.n.w}x${mode.n.h} space ${JSON.stringify(mode.n.txt?.space)} "${dm}" w${width(dm).toFixed(0)}: before ${JSON.stringify(cssLines(dm, mode.n.w))} after ${JSON.stringify(arrangeText(dm, mode.n.w, charW).split("\n"))}`);
const tag = find(pack.root, "lbImageDummy2")!.n.images!;
const oldPieces = tag.length > 1 && tag.some((i) => i[1] !== 0 || i[2] !== 0 || i[7] !== tag[0][7] || i[8] !== tag[0][8]);
console.log(`lbImageDummy2 ${tag.length} tag shapes: before ${oldPieces ? "pieces (all drawn stacked)" : "states"}, after ${isPieces(tag) ? "pieces" : "states (setState picks one)"}`);
