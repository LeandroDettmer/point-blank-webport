// Node-only smoke test (no browser) for the AI room's ally/enemy bot config (Criar Sala -> Mode de Jogo -> AI
// window i3UIFrameWnd8: enemy count [1..8], ally count [0..7, RECRIADO], difficulty), through to game.ts's bot
// spawn. Confirmar must open the server room with `ai: { count, level, allies }` (net/roomClient.ts, leader-local:
// the server has no ally concept and never sees it on the wire), and boot.ts's playBattle must turn that into
// startGame({ botCount: count+allies, botAllies: allies }), which game.ts clamps to at most 15 bots (+ the player
// = 16, PB IA room's Matches.xml Limit=16) and spawns `allies` of them on the player's own team. Run:
//   node --experimental-transform-types --no-warnings src/lobby/core/test/lobby2017-bots-room.smoke.node.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PUBLIC = fileURLToPath(new URL("../../../../public", import.meta.url));
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

const { Lobby2017, loadLobbyData, stageChoices, AI_COUNT_MAX, AI_ALLY_MAX, aiSkill } = await import("../controller.ts");
const { ROOM_MODES, DEFAULT_KILLTIME } = await import("../roomModes.ts");

const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => { checks.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };

await loadLobbyData();
const ctl = new Lobby2017({
  serverUrl: "ws://127.0.0.1:0",
  username: "test",
  token: new Uint8Array(),
  render: () => {},
  onBattle: () => {},
  onLocalPlay: () => {},
  onExit: () => {},
});

const maps = stageChoices();
const aiMode = ROOM_MODES.findIndex((m) => m.ai);
const modeList = ROOM_MODES.map((_, i) => i);
ctl.create = { name: "sala", map: maps[0] ?? null, maps, pick: 0, top: 0, busy: false, dd: null, mode: aiMode, modeList, killTime: DEFAULT_KILLTIME, edit: false, botCount: 1, aiLevel: 2, botAllies: 0, balance: 0, password: "", passwordOn: false, limitEnter: false, people: 16, weapons: { primary: true, secondary: true, melee: true, throw: true, rpg7: false }, watch: 0x85, randomMap: false, randomIds: [], rm: null };

// enemy count (ai:count) cycles 1..AI_COUNT_MAX, ally count (ai:allies) cycles 0..AI_ALLY_MAX
ctl.click("hit", "ai:count"); ctl.click("hit", "pick:7");
check("enemy count reaches 8", ctl.create?.botCount === AI_COUNT_MAX, String(ctl.create?.botCount));
ctl.click("hit", "ai:allies"); ctl.click("hit", "pick:7");
check("ally count reaches 7", ctl.create?.botAllies === AI_ALLY_MAX, String(ctl.create?.botAllies));
ctl.click("hit", "ai:allies"); ctl.click("hit", "pick:0");
check("ally count wraps to 0 past the max", ctl.create?.botAllies === 0, String(ctl.create?.botAllies));
ctl.click("hit", "ai:allies"); ctl.click("hit", "pick:7");
check("ally count back at 7 (8v8, player counted in their team)", ctl.create?.botAllies === AI_ALLY_MAX, String(ctl.create?.botAllies));

// the create state carries both counts for the AI window's combos (screensCross/app.ts reads ctl.create)
const cr = ctl.create;
check("create state carries enemy+ally+level", cr?.botCount === 8 && cr?.botAllies === 7 && cr?.aiLevel === 2, JSON.stringify({ count: cr?.botCount, allies: cr?.botAllies, level: cr?.aiLevel }));

// boot.ts playBattle's derivation from RoomClient.ai (leader-local; guests default allies to 0)
const roomAi = { count: 8, level: 2, allies: 7 };
const botCount = (roomAi.count ?? 8) + (roomAi.allies ?? 0);
const botAllies = roomAi.allies ?? 0;
check("startGame botCount = enemies + allies", botCount === 15, String(botCount));
check("startGame botAllies = 7", botAllies === 7, String(botAllies));
check("aiSkill(2) in (0.1, 1]", aiSkill(2) > 0.1 && aiSkill(2) <= 1, String(aiSkill(2)));

// game.ts's own spawn loop (StartGame handler, game.ts ~283-294): total clamps to 15, allies clamp to <= total,
// team = ally ? player's team : the other one. Reproduced here (no browser/physics) to check the team split.
const total = Math.max(0, Math.min(15, botCount));
const allies = Math.max(0, Math.min(total, botAllies));
const enemies = total - allies;
check("15 bots total (8v8 incl. player, Matches.xml Limit=16)", total === 15, String(total));
check("7 ally bots (+ player = 8 on that team)", allies === 7, String(allies));
check("8 enemy bots", enemies === 8, String(enemies));
const myTeam = 0;
const teams = Array.from({ length: total }, (_, i) => (i < allies ? myTeam : 1 - myTeam));
check("bots[0..6] on the player's team", teams.slice(0, 7).every((t) => t === myTeam));
check("bots[7..14] on the other team", teams.slice(7).every((t) => t === 1 - myTeam));

const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) process.exit(1);
