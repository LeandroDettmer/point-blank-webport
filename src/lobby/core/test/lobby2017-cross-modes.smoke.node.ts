// Node-only smoke test (no browser, no scene assets) for the Cross modes the create window can now make: HeadHunter and
// Chaos (Deathmatch rules 32 / 80, own rotation), the Bomb Mission variants (Rule 128, StageOptions 96 / 128 / 224) and the
// lbSpecialWarWin rows that open them. Rules / maps are the server's system_map_rules / system_map_matches (db/init/001_init.sql)
// 015 + 067). Run:
//   node --experimental-transform-types --no-warnings src/lobby/core/test/lobby2017-cross-modes.smoke.node.ts
export {};
const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.location = { search: "", hash: "", hostname: "127.0.0.1", protocol: "http:", host: "127.0.0.1:8000" };
g.fetch = () => Promise.resolve(new Response("", { status: 404 }));

const { Lobby2017, modeGroups, modeStageChoices, stageChoices } = await import("../controller.ts");
const { ROOM_MODES, CHAOS_MAP_IDS, HEADHUNTER_MAP_IDS, ANNIHILATION_MAP_IDS, ACE_MAP_IDS, modeIndex, modeLabel, modeText, DEFAULT_KILLTIME } = await import("../roomModes.ts");
const { SPECIAL_WAR } = await import("../../screensCross/crossMap.ts");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };
const byText = (t: string) => ROOM_MODES.findIndex((m) => m.text === t);

// ---- table: rule / stage / type per mode (the server's Rules.xml values)
const hh = ROOM_MODES[byText("modeHeadHunter")], chaos = ROOM_MODES[byText("modeChaos")];
check("HeadHunter = Rule 32, stage 0, Deathmatch type 4, special", hh.rule === 32 && hh.stage === 0 && hh.roomType === 4 && !!hh.special, JSON.stringify(hh));
check("Chaos = Rule 80, stage 0, Deathmatch type 4, special", chaos.rule === 80 && chaos.stage === 0 && chaos.roomType === 4 && !!chaos.special, JSON.stringify(chaos));
const bombVariants = ["modeBombSniper", "modeBombShotgun", "modeBombKnife"].map((t) => ROOM_MODES[byText(t)]);
check("Bomb variants = Rule 128, stages 96 / 128 / 224, type 8, rounds, special",
  JSON.stringify(bombVariants.map((m) => [m.rule, m.stage, m.roomType, !!m.rounds, !!m.special])) === "[[128,96,8,true,true],[128,128,8,true,true],[128,224,8,true,true]]");
check("Bomb variant weapon presets = the Deathmatch ones (79 / 143 / 2)", JSON.stringify(bombVariants.map((m) => m.weaponsFlag)) === "[79,143,2]");

// ---- Annihilation and Ace: off the room list (user, 2026-10-13); their rotations stay for the server rules
check("no Annihilation / Ace row", !ROOM_MODES.some((m) => m.roomType === 16 || m.roomType === 32));
check("Annihilation rotation = 12 maps of mode 4 (Eliminate)", JSON.stringify(ANNIHILATION_MAP_IDS) === "[1,2,4,9,10,18,20,28,34,41,42,65]");
check("Ace rotation = Drain Tunnel (108) of mode 55", JSON.stringify(ACE_MAP_IDS) === "[108]");
// Hardcore (Rules 192 / 224, modes 47 / 40): no map row in system_map_matches, so no room mode offers them
check("no room mode with Rule 192 / 224 (Hardcore has no map)", !ROOM_MODES.some((m) => m.rule === 192 || m.rule === 224));

// ---- HeadHunter and Chaos share stage 0 / type 4: the rule tells them apart
check("modeIndex(0, 4, 32) = HeadHunter", modeText(ROOM_MODES[modeIndex(0, 4, 32)]) === "HeadHunter");
check("modeIndex(0, 4, 80) = Chaos", modeText(ROOM_MODES[modeIndex(0, 4, 80)]) === "Caos");
check("modeIndex(96, 8, 128) = Bomb Sniper", ROOM_MODES[modeIndex(96, 8, 128)].text === "modeBombSniper");
check("modeIndex(96, 4, 0) still = Deathmatch Sniper", ROOM_MODES[modeIndex(96, 4, 0)].text === "modeSniper");
check("modeLabel(32, 0) / modeLabel(80, 0) name the two modes", modeLabel(32, 0) === "HeadHunter" && modeLabel(80, 0) === "Caos");

// ---- rotation: the same maps the server's getMapLimit accepts for the rule (DB mode 8 / 15)
check("HeadHunter rotation = 10 maps of mode 8", JSON.stringify(HEADHUNTER_MAP_IDS) === "[1,2,4,5,7,9,10,23,29,67]");
check("Chaos rotation = 10 maps of mode 15", JSON.stringify(CHAOS_MAP_IDS) === "[1,2,4,7,9,10,20,23,42,67]");

// ---- create window: the special-war rows open the mode, with its own map list
const ctl = new Lobby2017({ serverUrl: "ws://127.0.0.1:0", username: "test", token: new Uint8Array(), render: () => {}, onBattle: () => {}, onLocalPlay: () => {}, onExit: () => {} });
ctl.page = "lobby";
ctl.loadingRooms = false;
ctl.specialWar("modeHeadHunter");
const cr = () => ctl.create!;
check("specialWar(HeadHunter) opens the create window on HeadHunter", !!ctl.create && modeText(ROOM_MODES[cr().mode]) === "HeadHunter", String(ctl.create?.mode));
// the map entries need the asset index (fetched in the browser): in node the lists can be empty, so only the subset is checked
check("HeadHunter lists only maps of its rotation", cr().maps.every((m) => HEADHUNTER_MAP_IDS.includes(m.mapId)), JSON.stringify(cr().maps.map((m) => m.mapId)));
check("HeadHunter keeps the 50 kills / 7 min default (not rounds)", cr().killTime === DEFAULT_KILLTIME);
ctl.create = null;
ctl.specialWar("modeChaos");
check("specialWar(Chaos) switches the create window to Chaos", modeText(ROOM_MODES[cr().mode]) === "Caos", modeText(ROOM_MODES[cr().mode]));
check("Chaos lists only maps of its rotation", cr().maps.every((m) => CHAOS_MAP_IDS.includes(m.mapId)), JSON.stringify(cr().maps.map((m) => m.mapId)));
ctl.specialWar("modeBombKnife");
check("Bomb Knife switches to rounds with the bomb list (no rotation narrowing)", ROOM_MODES[cr().mode].rounds === true && JSON.stringify(cr().maps.map((m) => m.mapId)) === JSON.stringify(stageChoices(true).map((m) => m.mapId)));
check("Bomb Knife killTime = rounds default (0x03)", cr().killTime === 0x03, cr().killTime.toString(16));
check("the Bomb variant rotation = the plain Bomb list", JSON.stringify(modeStageChoices(bombVariants[0])) === JSON.stringify(stageChoices(true)));

// ---- Custom Mode combo: specials after the Deathmatch presets (existing picks keep their index)
const special = modeGroups(cr()).special.map((i) => modeText(ROOM_MODES[i]));
check("special combo = Sniper, Shotgun, Faca, HeadHunter, Caos, then the bomb variants",
  JSON.stringify(special) === JSON.stringify(["Modo Sniper", "Shotgun", "Modo Faca", "HeadHunter", "Caos", "Destruição Sniper", "Destruição Shotgun", "Destruição Faca", "Sabotagem Sniper", "Sabotagem Shotgun", "Sabotagem Faca"]), JSON.stringify(special));
check("normal list = Deathmatch, Challenge, Destruição, Sabotagem, Defesa", JSON.stringify(modeGroups(cr()).normal.map((i) => modeText(ROOM_MODES[i]))) === '["Deathmatch","Challenge","Destruição","Sabotagem","Defesa"]');

// ---- Cross special-war window: the HeadHunter and Chaos rows are live buttons now
const rowOf = (m: string) => SPECIAL_WAR.find((r) => r.mode === m);
check("SPECIAL_WAR HeadHunter row opens modeHeadHunter", rowOf("modeHeadHunter") !== undefined);
check("SPECIAL_WAR Chaos row opens modeChaos", rowOf("modeChaos") !== undefined);

console.log(fails ? `\n${fails} FAIL` : "\nall pass");
process.exit(fails ? 1 : 0);
