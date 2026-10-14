// Node-only smoke test (no browser, no scene assets) for the room mode / kills-time / "Configurar sala" flow in
// controller.ts: the mode list offers the roomModes.ts Deathmatch family, the kills/time combos step their nibbles,
// Criar Sala sends the mode's stage + weaponsFlag + killTime, and the leader's settings window in a READY room sends
// ROOM_CHANGE_ROOMINFO_REQ (RoomClient.changeRoomInfo) with the new map / mode / kills-time. Run:
//   node --experimental-transform-types --no-warnings src/lobby/core/test/lobby2017-roomsettings.smoke.node.ts
const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.location = { search: "", hash: "", hostname: "127.0.0.1", protocol: "http:", host: "127.0.0.1:8000" };
g.fetch = () => Promise.resolve(new Response("", { status: 404 }));

const { Lobby2017, modeGroups } = await import("../controller.ts");
const { ROOM_MODES, DEFAULT_KILLTIME, KILLS, TIMES_MIN, modeText } = await import("../roomModes.ts");
import type { RoomChange } from "../../../net/roomClient.ts";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };

const ctl = new Lobby2017({ serverUrl: "ws://127.0.0.1:0", username: "test", token: new Uint8Array(), render: () => {}, onBattle: () => {}, onLocalPlay: () => {}, onExit: () => {} });
// the create window's mode list / Custom Mode combo as the Cross shell reads them from ctl.create (screensCross/app.ts)
const popup = () => {
  const cr = ctl.create;
  if (!cr) return null;
  const gr = modeGroups(cr), label = (i: number) => modeText(ROOM_MODES[i]);
  return { mode: modeText(ROOM_MODES[cr.mode]), normal: gr.normal.map(label), normalSel: gr.normal.indexOf(cr.mode), special: gr.special.map(label), specialSel: gr.special.indexOf(cr.mode) };
};
const idx = (stage: number) => ROOM_MODES.findIndex((m) => m.stage === stage);
const cur = () => ctl.create; // read through a call: `ctl.create = null` below would otherwise narrow it to never

// ---- Criar Sala: mode list + kills/time
ctl.page = "lobby";

ctl.loadingRooms = false; // the room list is in: no loading curtain over the lobby
ctl.click("roomlist", "btn04");
check("Criar Sala opens with Deathmatch, 50 kills / 7 min (Cross exe 0x7d2f10)", ctl.create?.mode === 0 && ctl.create?.killTime === DEFAULT_KILLTIME);
ctl.create!.map = { mapId: 4, name: "M. Station" };
const pm = popup();
check("mode list = Deathmatch + Challenge + Destruição + Sabotagem + Defesa, Custom Mode combo = Sniper / Shotgun / Faca / HeadHunter / Caos / Destruição variants, Deathmatch marked", JSON.stringify(pm?.normal) === '["Deathmatch","Challenge","Destruição","Sabotagem","Defesa"]' && JSON.stringify(pm?.special) === '["Modo Sniper","Shotgun","Modo Faca","HeadHunter","Caos","Destruição Sniper","Destruição Shotgun","Destruição Faca","Sabotagem Sniper","Sabotagem Shotgun","Sabotagem Faca"]' && pm?.normalSel === 0 && pm?.specialSel === -1);
ctl.click("hit", "opt:special"); ctl.click("hit", "pick:0");
check("Custom Mode combo picks Sniper", ROOM_MODES[ctl.create!.mode].stage === 96 && popup()?.mode === "Modo Sniper" && popup()?.specialSel === 0 && popup()?.normalSel === -1, popup()?.mode);
ctl.click("hit", "opt:kills"); ctl.click("hit", "pick:1");
check("kills dropdown picks 80", KILLS[ctl.create!.killTime & 15] === 80, String(ctl.create!.killTime));
ctl.click("hit", "opt:time"); ctl.click("hit", "pick:2");
check("time dropdown picks 15 min", TIMES_MIN[(ctl.create!.killTime >> 4) & 15] === 15, String(ctl.create!.killTime));
ctl.click("hit", "opt:kills"); ctl.click("hit", "pick:0");
check("kills dropdown picks 60 again", KILLS[ctl.create!.killTime & 15] === 60);

// ---- ready room "Configurar sala" (leader, READY room)
const sent: RoomChange[] = [];
const summary = { roomId: 3, name: "sala x", mapId: 4, rule: 0, stage: 1, roomType: 4, state: 1, players: 2, slotCount: 16, weaponsFlag: 0x1ff, leaderName: "test", killTime: 0x63 };
const room = { room: summary, isLeader: true, ai: null, mySlot: 0, leaderSlot: 0, slots: [], changeRoomInfo: (c: RoomChange) => { sent.push(c); return true; } };
ctl.create = null;
ctl.page = "room";
(ctl as unknown as { roomScreen: unknown }).roomScreen = { room, dispose() {} };
ctl.click("mapinfo", "i3UIButtonRoomSet");
check("settings window opens prefilled (edit, Deathmatch, room's kills/time)", !!cur()?.edit && cur()!.mode === 0 && cur()!.killTime === 0x63 && cur()!.map?.mapId === 4);
check("an ordinary room lists no AI mode", !cur()!.modeList.some((i) => ROOM_MODES[i].ai), JSON.stringify(cur()!.modeList));
ctl.click("hit", "opt:special"); ctl.click("hit", "pick:2");
cur()!.map = { mapId: 9, name: "Outro mapa" };
ctl.click("hit", "opt:time"); ctl.click("hit", "pick:2");
ctl.click("create", "i3UIButtonComposed3_LCR");
const ch = sent[0];
check("OK sends ROOM_CHANGE_ROOMINFO_REQ", sent.length === 1 && cur() === null);
check("… with the knife mode's stage and melee-only weapon flag", ch?.stage === 224 && ch?.weaponsFlag === 2, JSON.stringify(ch));
check("… the new map and time", ch?.mapId === 9 && TIMES_MIN[((ch?.killTime ?? 0) >> 4) & 15] === 15, JSON.stringify(ch));

// non-leader / room in battle: the button does nothing
sent.length = 0;
(room as { isLeader: boolean }).isLeader = false;
ctl.click("mapinfo", "i3UIButtonRoomSet");
check("non-leader cannot open the settings", cur() === null);
(room as { isLeader: boolean }).isLeader = true;
summary.state = 7;
ctl.click("mapinfo", "i3UIButtonRoomSet");
check("room in battle cannot be edited", cur() === null);

console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
