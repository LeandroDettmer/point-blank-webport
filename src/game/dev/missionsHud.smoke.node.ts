// Node-only smoke of the mission cards in battle: the lobby's MissionClient fed 2355 / 2359 / 2361 like the
// server does during a match -> pbHud/missionHud.ts lines (texts of missionLogic.ts, state of the quest's vtbl+0x18) -> the left panel
// (model.ts missionPanelState, layout.ts MISSION_PANEL), the
// "Task Completed" edges (once per task, not on the server's second 2359) and the modes without the panel. The panel geometry
// (layout.ts missionPanelBox, Cross CChallengeBoard 0x6fc220) is checked against the Cross minimap frame (164x181 at 5,5): under it,
// frame around every wrapped line.
// No browser, no server. Run:
//   node --experimental-transform-types --no-warnings src/game/dev/missionsHud.smoke.node.ts
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

register("../../lobby/core/test/resolve-ts.mjs", import.meta.url);

const PUBLIC = fileURLToPath(new URL("../../../public", import.meta.url));
const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.location = { search: "", hash: "", hostname: "127.0.0.1", protocol: "http:", host: "127.0.0.1:8000" };
const realFetch = globalThis.fetch;
g.fetch = (u: string | URL) => {
  const s = String(u);
  if (s.startsWith("/")) {
    try { return Promise.resolve(new Response(readFileSync(PUBLIC + s.split("?")[0]), { status: 200 })); }
    catch { return Promise.resolve(new Response("", { status: 404 })); }
  }
  return realFetch(u);
};

const { PacketReader, PacketWriter } = await import("../../net/packet.ts");
const { MissionClient } = await import("../../net/missionClient.ts");
const { missionSet, taskText } = await import("../../lobby/core/missionLogic.ts");
const { setItemNameTable } = await import("../../lobby/state/itemNames.ts");
const { missionLines, missionPanelOn, newlyDone, taskSnapshot } = await import("../pbHud/missionHud.ts");
const { missionPanelState } = await import("../pbHud/model.ts");
const { MISSION_PANEL, missionIcon, missionPanelBox, wrapText } = await import("../pbHud/layout.ts");
const { KILL_MARKS } = await import("../pbHud/killmarks.ts");
await (await import("../../lobby/ui/i18n.ts")).loadStrings();
setItemNameTable(JSON.parse(readFileSync(new URL("../../lobby/state/data/itemNames.json", import.meta.url), "utf8")));

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };

// ---- the Game connection as the match sees it: pushes only
type Reader = InstanceType<typeof PacketReader>;
class FakeConn {
  listeners = new Set<(op: number, r: Reader) => void>();
  on(fn: (op: number, r: Reader) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  waitFor(): Promise<Reader> { return new Promise(() => {}); }
  send() {}
  push(packet: Uint8Array) { const op = packet[0] | (packet[1] << 8); for (const f of [...this.listeners]) f(op, new PacketReader(packet, 2)); }
}
function questing(active: number, slots: { set: number; card?: number; flags?: number[] }[]): Uint8Array {
  const w = new PacketWriter(89).writeC(active);
  for (let i = 0; i < 4; i++) w.writeC(slots[i]?.card ?? 0);
  for (let i = 0; i < 4; i++) for (let c = 0; c < 10; c++) w.writeH(slots[i]?.flags?.[c] ?? 0);
  for (let i = 0; i < 4; i++) w.writeC(slots[i]?.set ?? 0);
  return w.toBytes();
}
const info2355 = (active: number, slots: { set: number; card?: number; flags?: number[] }[]) => new PacketWriter(96).writeH(2355).writeC(active).writeB(questing(active, slots)).toBytes();
const change2359 = (b: number, n: number) => new PacketWriter(4).writeH(2359).writeC(b).writeC(n).toBytes();
const prize2361 = (flag: number, type: number) => {
  const w = new PacketWriter(40).writeH(2361).writeD(flag).writeC(type);
  if (flag & 1) w.writeD(5000).writeD(0).writeD(900).writeD(3).writeD(1).writeD(0).writeD(1);
  return w.toBytes();
};

/** HudData of a live match, missions as game.ts watchMissions builds them */
const hud = (over: Record<string, unknown> = {}) => ({
  hp: 100, maxHp: 100, armor: 0, helmet: false,
  weapon: { name: "K-2", slot: 0, ammo: 30, reserve: 90, melee: false, reloading: false, reloadProgress: 0 },
  grenades: null, myTeam: 0 as const, score: [0, 0] as [number, number], killLimit: 60, round: 1, timeLeft: 300, kills: 0, deaths: 0, assists: 0,
  phase: "live" as const, showBoard: false, dead: false, rows: [], mapName: "NStation", modeName: "Team Deathmatch",
  ...over,
});

// ---- game.ts watchMissions, as is: lines + banner edges per push
const conn = new FakeConn();
const mc = new MissionClient(conn);
let snap: ReturnType<typeof taskSnapshot> = null;
let banners = 0;
let lines: ReturnType<typeof missionLines> = [];
mc.subscribe(() => {
  const s = taskSnapshot(mc.state);
  banners += newlyDone(snap, s).length ? 1 : 0;
  snap = s;
  lines = missionLines(mc.state);
});

check("no questing block yet: no card, no line", missionLines(mc.state).length === 0 && taskSnapshot(mc.state) === null);

// slot 0 = Missão: Assalto (5), card 1: tasks [Weapon_Accm KILL x3 rifle, class kill x2 rifle, HEADSHOT x1, DOUBLE_KILL x1]
conn.push(info2355(0, [{ set: 5, card: 1 }, { set: 7 }]));
const card = missionSet(5)!.cards[1];
check("2355: 4 lines of the active card, all state 0 (no progress)", lines.length === 4 && lines.every((l) => l.state === 0), JSON.stringify(lines.map((l) => l.state)));
const nameOf = () => "";
check("line text = OnQueryDesc newline 1 (missionLogic taskText), Tab text = the same without the newline",
  lines[0].text === taskText(card.tasks[0], 0, { nameOf }) && lines[0].text.includes("\n") && lines[0].tab === lines[0].text.replace("\n", "") && !lines[0].tab.includes("\n"),
  JSON.stringify(lines[0]));
check("progress (0/3) in the text", lines[0].text.endsWith(" 0/3 vezes"), JSON.stringify(lines[0].text));

// 2359 (0, 1): task 0 one step further -> state 1 ("in progress" icon), 1/3, no banner
conn.push(change2359(0, 1));
check("2359 (0,1): task 0 state 1, 1/3, the others 0", lines[0].state === 1 && lines[0].text.endsWith(" 1/3 vezes") && lines.slice(1).every((l) => l.state === 0), JSON.stringify(lines[0]));
check("2359 (0,1): no Task Completed", banners === 0);
// the server sends each step twice: nothing changes
conn.push(change2359(0, 1));
check("2nd 2359 (0,1): same state, no banner", lines[0].state === 1 && banners === 0);

// 2359 (240, 3): task 0 done -> state 2 (check icon), 3/3, ONE banner; the second copy shows nothing
conn.push(change2359(240, 3));
check("2359 (240,3): task 0 state 2, 3/3", lines[0].state === 2 && lines[0].text.endsWith(" 3/3 vezes"), JSON.stringify(lines[0]));
check("2359 (240,3): one Task Completed", banners === 1);
conn.push(change2359(240, 3));
check("2nd 2359 (240,3): no second banner (AddQuestFinishToHud only when the task was not done)", banners === 1);
// task 2 (HEADSHOT x1) done in one step
conn.push(change2359(242, 1));
check("2359 (242,1): task 2 done, banner #2", lines[2].state === 2 && banners === 2);

// ---- left panel (CHud+0x600) and Tab list (CHUD_Score) from those lines
const missions = { lines, panel: true };
const p = missionPanelState(hud({ missions }));
check("panel: shown in a live match with the card's 4 rows", p.show && p.rows.length === 4);
check("panel: icon cells 515 / 532 / 549 (0x707180: +0x11 / +0x22)",
  p.rows[0].icon.x === 549 && p.rows[1].icon.x === 515 && p.rows[2].icon.x === 549 && missionIcon(1).x === 532 && p.rows[0].icon.y === 281 && p.rows[0].icon.w === 14 && p.rows[0].icon.h === 15);
check("panel: row text keeps the newline", p.rows[1].text === lines[1].text && p.rows[1].text.includes("\n"));
check("panel: frame pieces of 0x7066d0 (4,188 166x29; UVs 515,148 / 179 / 209; bottom 9 px after Update)",
  MISSION_PANEL.x === 4 && MISSION_PANEL.top.y === 188 && MISSION_PANEL.w === 166 && MISSION_PANEL.top.src.y === 148 && MISSION_PANEL.mid.src.y === 179 && MISSION_PANEL.bottom.src.y === 209 && MISSION_PANEL.bottom.h === 9);
// ---- panel geometry (layout.ts missionPanelBox) under the minimap the web HUD really draws
/** Arial advance widths (1/1000 em, = Helvetica) for the wrap; accented letters take their base letter */
const ARIAL: Record<string, number> = { " ": 278, "(": 333, ")": 333, "/": 278, "-": 333, ".": 278, ",": 278, ":": 278, "!": 278, "?": 556, "%": 889, "'": 191 };
for (const [c, w] of Object.entries({ A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500 })) ARIAL[c] = w;
for (let d = 0; d < 10; d++) ARIAL[String(d)] = 556;
const measure = (str: string) => [...str.normalize("NFD").replace(/[\u0300-\u036f]/g, "")].reduce((a, c) => a + (ARIAL[c] ?? 556), 0) * MISSION_PANEL.text.font / 1000;
const inside = (r: { x: number; y: number; w: number; h: number }, o: { x: number; y: number; w: number; h: number }) => r.x >= o.x && r.y >= o.y && r.x + r.w <= o.x + o.w && r.y + r.h <= o.y + o.h;
const hits = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// the task of the user's print (Weapon_Accm DO_KILL x5, no weapon): missionLogic taskText as the panel gets it
const USER_TEXT = "(Cumulativa)  Conseguir Kill\n 4/5vezes";
const userWrap = wrapText(USER_TEXT, 138, measure);
check("wrap: the print's task -> '(Cumulativa)  Conseguir' / 'Kill' / ' 4/5vezes' (153 px > 138 at 12 ppem in the exe too), newline kept",
  JSON.stringify(userWrap) === JSON.stringify(["(Cumulativa)  Conseguir", "Kill", " 4/5vezes"]), JSON.stringify(userWrap));
check("wrap: a word wider than the box breaks between characters, every line fits",
  wrapText("ab " + "W".repeat(30) + " cd", 138, measure).every((l) => measure(l) <= 138) && wrapText("ab " + "W".repeat(30) + " cd", 138, measure).join("").replace(/ /g, "") === "ab" + "W".repeat(30) + "cd");
check("Cross position: the box from y 188 puts the middle and row 0 at 217, icon x 10, text at icon + (18, 2) (Create 0x6fc220 / 0x6fce20)",
  (() => { const b = missionPanelBox(p.rows, 188, measure); return b.top.y === 188 && b.mid.y === 217 && b.rows[0].icon.x === 10 && b.rows[0].icon.y === 217 && b.rows[0].text.x === 28 && b.rows[0].text.y === 219; })());

// Cross CBattleHUD_MiniMap frame 0x6fe500: SetRect(5, 5, 164, 181), bottom 186; the board's top is the exe's literal 188
const mm = { x: 5, y: 5, w: 164, h: 181 };
const py = MISSION_PANEL.top.y;
check("panel y = 188, 2 px under the Cross minimap frame", py === 188 && py === mm.y + mm.h + 2, String(py));

const userRows = [
  { text: USER_TEXT, icon: missionIcon(1) },
  ...p.rows.slice(1),
];
for (const [name, rows] of [["card rows", p.rows], ["user's print rows", userRows]] as const) {
  const b = missionPanelBox(rows, py, measure);
  const panel = { x: b.top.x, y: b.top.y, w: b.top.w, h: b.bottom.y + b.bottom.h - b.top.y };
  const lines = b.rows.flatMap((r) => r.lines.map((l) => ({ x: l.x, y: l.y, w: MISSION_PANEL.text.w, h: MISSION_PANEL.text.line, text: l.text })));
  check(`${name}: panel does not intersect the minimap box (frame, area name, +/- buttons)`, !hits(panel, mm!), JSON.stringify({ panel, mm }));
  check(`${name}: title piece above row 0 (no line under the title)`, b.rows.every((r) => r.icon.y >= b.top.y + b.top.h && r.text.y >= b.top.y + b.top.h));
  check(`${name}: middle piece covers every line and icon`, lines.every((l) => inside(l, b.mid)) && b.rows.every((r) => inside(r.icon, b.mid)), JSON.stringify({ mid: b.mid, last: lines.at(-1) }));
  check(`${name}: middle = rows' total advance (14 * lines + 6 each), bottom 9 px right under it`,
    b.mid.h === b.rows.reduce((a, r) => a + 14 * r.lines.length + 6, 0) && b.bottom.y === b.mid.y + b.mid.h && b.bottom.h === 9);
  check(`${name}: rows stacked, never overlapping`, b.rows.every((r, i) => i === 0 || r.icon.y >= b.rows[i - 1].text.y + b.rows[i - 1].text.h));
  check(`${name}: every line fits 138 px, inside the 166 px frame`, lines.every((l) => measure(l.text) <= 138 && l.x + l.w <= b.top.x + b.top.w));
}

check("panel: kept while dead (the exe only drops it without a card)", missionPanelState(hud({ missions, dead: true })).show);
check("panel: hidden on the Tab board, the result, the end screen, as an observer",
  !missionPanelState(hud({ missions, showBoard: true })).show && !missionPanelState(hud({ missions, phase: "ended" })).show
  && !missionPanelState(hud({ missions, final: { winner: 0, red: 1, blue: 0, mapName: "", modeName: "", tab: 0, leaveIn: 9, exp: null, gold: null } })).show
  && !missionPanelState(hud({ missions, observing: "view" })).show);
check("panel: hidden with no card / in a mode without it", !missionPanelState(hud()).show && !missionPanelState(hud({ missions: { lines: [], panel: true } })).show && !missionPanelState(hud({ missions: { lines, panel: false } })).show);

// ---- the set is done (2361 type 4): the server empties the slot -> no card, no banner
conn.push(prize2361(273, 4));
check("2361 (273,4): active slot emptied -> next owned set's card (Infiltração, slot 1), no banner", taskSnapshot(mc.state)?.key === "1:7:0" && banners === 2 && lines.length === 4 && lines.every((l) => l.state === 0));
conn.push(info2355(0, [{ set: 0 }]));
check("2355 with no set: no lines (panel off)", lines.length === 0 && !missionPanelState(hud({ missions: { lines, panel: true } })).show);
mc.dispose();

// ---- modes (CHud::CreateHUD 0x744790): RoomCondition >> 2
check("panel modes: DeathMatch (4) / Bomb (8) / Tutorial (40) on; 6 / 8 / 9 / 0xb off",
  missionPanelOn(4) && missionPanelOn(8) && missionPanelOn(40) && !missionPanelOn(24) && !missionPanelOn(32) && !missionPanelOn(36) && !missionPanelOn(44));

// ---- sprites: kill_message.i3i cell 10 and the panel sheet (real textures; skipped when public/assets is not generated)
const tc = KILL_MARKS.taskCompleted;
check("banner: Task Completed = kill_message cell 10 (col 0, row 5: 0,510 512x102), no voice clip", tc.sprite?.x === 0 && tc.sprite?.y === 510 && tc.sprite?.w === 512 && tc.sprite?.h === 102 && !tc.sprite.sheet && tc.caption === "");
// PNG decoder of the external pb-extract-tools repo (scripts/dev/lib/tools.mjs, PB_TOOLS)
const { tool } = await import(new URL("../../../scripts/dev/lib/tools.mjs", import.meta.url).href) as { tool(rel: string): Promise<unknown> };
const { decodePNG } = await tool("ui-export/lib.mjs") as { decodePNG(b: Buffer): { w: number; h: number; rgba: Buffer } };
const alphaIn = (file: string, r: { x: number; y: number; w: number; h: number }) => {
  const img = decodePNG(readFileSync(file));
  let n = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (img.rgba[(y * img.w + x) * 4 + 3] > 8) n++;
  return n;
};
const km = `${PUBLIC}/assets/ui/cross-hud/hud/kill_message.png`, sheet = `${PUBLIC}/assets/ui/cross-hud/hud/${MISSION_PANEL.sheet}`;
if (existsSync(km) && existsSync(sheet)) {
  check("banner cell has the sprite (alpha inside 0,510 512x102)", alphaIn(km, tc.sprite!) > 5000);
  check("panel sheet: the 3 frame pieces and the 3 state icons are drawn", [MISSION_PANEL.top.src, MISSION_PANEL.mid.src, MISSION_PANEL.bottom.src, missionIcon(0), missionIcon(1), missionIcon(2)].every((r) => alphaIn(sheet, r) > 100));
} else console.log(`SKIP sprite checks (${MISSION_PANEL.sheet} / kill_message.png not generated: pbx ui cross-hud)`);

console.log(fails ? `\n${fails} FAIL` : "\nall PASS");
process.exit(fails ? 1 : 0);
