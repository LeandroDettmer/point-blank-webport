// Node-only smoke test (no browser, no scene assets) for the create window's "Mais" rules (roomRules.ts + controller.ts):
// weapon restriction bits, observer rules (Ace preset), random-map mask, password / entry restriction / player count
// state, and the ROOM_CHANGE_ROOMINFO_REQ body they end up in. Run:
//   node --experimental-transform-types --no-warnings src/lobby/core/test/lobby2017-roomrules.smoke.node.ts
const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.location = { search: "", hash: "", hostname: "127.0.0.1", protocol: "http:", host: "127.0.0.1:8000" };
g.fetch = () => Promise.resolve(new Response("", { status: 404 }));

const { Lobby2017, randomDefaultMaps } = await import("../controller.ts");
const { ROOM_MODES } = await import("../roomModes.ts");
const R = await import("../roomRules.ts");
const { buildChangeRoomInfoBody } = await import("../../../net/roomClient.ts");
import type { RoomChange, RoomSummary } from "../../../net/roomClient.ts";

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };

// ---- pure helpers
check("all weapons = 0x1ff (the server's AllWeapons preset)", R.weaponsFlagOf(R.ALL_WEAPONS) === 0x1ff, String(R.weaponsFlagOf(R.ALL_WEAPONS)));
check("sniper preset 79 round-trips through the checkboxes", R.weaponsFlagOf(R.weaponChecksOf(79)) === 79 || (R.weaponsFlagOf(R.weaponChecksOf(79)) & 15) === 15);
check("knife preset 2 = melee only", JSON.stringify(R.weaponChecksOf(2)) === JSON.stringify({ throw: false, melee: true, secondary: false, primary: false, rpg7: false }));
check("RPG7 needs the primary slot", R.weaponsFlagOf({ ...R.ALL_WEAPONS, primary: false, rpg7: true }) === (1 | 2 | 4));
check("RPG7 adds bit 1024", (R.weaponsFlagOf({ ...R.ALL_WEAPONS, rpg7: true }) & 1024) === 1024);
const ace = R.observerRules(142);
check("Ace preset 142 = FLY camera + enemy team + enemy HP, not first-person-only (exe bits 0x02 / 0x04 / 0x08)", ace.on && ace.enemy && ace.enemyHp && !ace.firstOnly && !ace.third, JSON.stringify(ace));
check("exe bit layout: THIRD 1, ON 2, ENEMY 4, ENEMY_HP 8, FIRST_ONLY 0x10", R.WATCH.THIRD === 1 && R.WATCH.ON === 2 && R.WATCH.ENEMY === 4 && R.WATCH.ENEMY_HP === 8 && R.WATCH.FIRST_ONLY === 0x10);
check("first-person-only wins over 3rd person (0x76bfc0)", (() => { const r = R.observerRules(0x11); return r.firstOnly && !r.third; })());
check("default observer rules: FLY camera only", (() => { const d = R.observerRules(R.DEFAULT_WATCH); return d.on && !d.enemyHp && !d.third && !d.enemy && !d.firstOnly; })());
const mask = R.randomMapMask([1, 4, 9, 40]);
check("random-map mask is 24 bytes and round-trips", mask.length === 24 && JSON.stringify(R.randomMapIds(mask)) === "[1,4,9,40]", JSON.stringify(R.randomMapIds(mask)));
check("ids beyond the mask are dropped", R.randomMapIds(R.randomMapMask([500])).length === 0);

// ---- controller: create window state
const ctl = new Lobby2017({ serverUrl: "ws://127.0.0.1:0", username: "test", token: new Uint8Array(), render: () => {}, onBattle: () => {}, onLocalPlay: () => {}, onExit: () => {} });
const cr = () => ctl.create!;
ctl.page = "lobby";

ctl.loadingRooms = false; // the room list is in: no loading curtain over the lobby
ctl.click("roomlist", "btn04");
check("window opens with every weapon, no password, 16 slots, default observer rules", cr().weapons.primary && cr().weapons.melee && !cr().passwordOn && cr().people === 16 && cr().watch === R.DEFAULT_WATCH && !cr().limitEnter);
ctl.click("hit", "chk:pwd");
check("password checkbox turns the field on", cr().passwordOn);
ctl.input("roomPassword", "12345");
check("password is cut to 4 chars", cr().password === "1234", cr().password);
ctl.click("hit", "chk:pwd");
check("unchecking clears the password", !cr().passwordOn && cr().password === "");
ctl.click("hit", "chk:inter");
check("Restrição de entrada sets the limit", cr().limitEnter);
ctl.click("hit", "opt:people"); ctl.click("hit", "pick:3");
check("Users combo picks 8 slots", cr().people === 8, String(cr().people));
ctl.click("hit", "chk:wMelee");
check("knife checkbox is locked on", cr().weapons.melee);
ctl.click("hit", "chk:wSub");
check("weapon checkbox clears the pistol", !cr().weapons.secondary && (R.weaponsFlagOf(cr().weapons) & 4) === 0);
ctl.click("hit", "chk:wSub");
ctl.click("hit", "chk:wRpg");
check("RPG7 on keeps the primary slot on", cr().weapons.rpg7 && cr().weapons.primary);
ctl.click("hit", "chk:wMain");
check("primary off drops RPG7", !cr().weapons.primary && !cr().weapons.rpg7);
ctl.click("hit", "chk:obsThird");
check("3rd person on", (cr().watch & R.WATCH.THIRD) !== 0);
ctl.click("hit", "chk:obsFirst");
check("1st person only on clears and locks 3rd person (Lua OnClicked)", (cr().watch & R.WATCH.FIRST_ONLY) !== 0 && (cr().watch & R.WATCH.THIRD) === 0);
ctl.click("hit", "chk:obsThird");
check("3rd person stays locked while 1st person only is on", (cr().watch & R.WATCH.THIRD) === 0);
ctl.click("hit", "chk:obsFirst");
ctl.click("hit", "chk:obsEnemy");
ctl.click("hit", "chk:obsHp");
check("enemy team / enemy HP toggle their own bits", (cr().watch & R.WATCH.ENEMY) !== 0 && (cr().watch & R.WATCH.ENEMY_HP) !== 0);
ctl.click("hit", "chk:obsOn");
check("the FLY camera bit does not gate the other rules", (cr().watch & R.WATCH.ON) === 0 && (cr().watch & R.WATCH.ENEMY) !== 0);

// special-weapon modes show their preset, locked
ctl.click("hit", "opt:special"); ctl.click("hit", "pick:0");
check("Sniper mode shows the server preset weapons", R.weaponsFlagOf(cr().weapons) === (R.weaponsFlagOf(R.weaponChecksOf(ROOM_MODES[cr().mode].weaponsFlag))));
ctl.click("hit", "chk:wSub");
ctl.click("hit", "chk:wThrow");
check("Sniper mode: pistol and grenade can be unchecked", !cr().weapons.secondary && !cr().weapons.throw && cr().weapons.primary && cr().weapons.melee);
ctl.click("hit", "chk:wMain"); ctl.click("hit", "chk:wMelee");
check("Sniper mode: primary and knife stay locked", cr().weapons.primary && cr().weapons.melee);
ctl.listSelect("modes", 0);
check("back to Deathmatch restores every weapon", cr().weapons.primary && cr().weapons.secondary && cr().weapons.melee && cr().weapons.throw);
check("8-player maps cap the Users combo", R.mapPlayerLimit(9) === 8 && R.mapPlayerLimit(4) === 16 && R.mapPlayerLimit(89, true) === 10 && R.peopleOptions(8).join() === "2,4,6,8" && R.peopleOptions(10).join() === "2,4,6,8,10");

// ---- random map
cr().maps = [{ mapId: 1, name: "A" }, { mapId: 4, name: "B" }, { mapId: 9, name: "C" }];
cr().map = cr().maps[0];
const ids = randomDefaultMaps(cr().maps).map((m) => m.mapId); // the exe default leaves out mapId 9 (Crackdown)
const defaultOk = ids.length === 2 && !ids.includes(9);
ctl.click("hit", "chk:rand");
check("Mapa aleatório opens its window with the exe default picked (Crackdown out)", !!cr().rm && cr().rm!.picked.length === ids.length && defaultOk);
ctl.click("hit", "rm:0");
check("clicking a map unpicks it", cr().rm!.picked.length === ids.length - 1 && !cr().rm!.picked.includes(ids[0]));
for (let i = 1; i < ids.length; i++) ctl.click("hit", `rm:${i}`);
ctl.click("hit", "rm:ok");
check("OK with no map picked stays open and warns", !!cr().rm && cr().rm!.warn);
ctl.click("hit", "rm:0");
ctl.click("hit", "rm:ok");
check("OK with a map stores the list and closes", !cr().rm && cr().randomMap && cr().randomIds.length === 1 && cr().randomIds[0] === ids[0]);
ctl.click("hit", "chk:rand");
check("unchecking Mapa aleatório keeps the list but turns it off", !cr().randomMap);
ctl.click("hit", "chk:rand");
ctl.click("hit", "rm:cancel");
check("cancel of the window keeps the earlier list", cr().randomMap && cr().randomIds.length === 1);

// ---- wire: the change-room body carries the new fields
const summary: RoomSummary = { roomId: 3, name: "sala x", mapId: 4, rule: 0, stage: 1, roomType: 4, state: 1, players: 2, slotCount: 16, weaponsFlag: 0x1ff, leaderName: "test", killTime: 0x63,
  opts: { ping: 0, flag: 4, newInt: 0, limit: 0, watchRuleFlag: 0, balanceType: 0, randomMaps: new Uint8Array(24), countdown: 5, leaderAddr: new Uint8Array(4), killCam: 0 } };
const ch: RoomChange = { slots: 8, limit: 1, watchRuleFlag: 0x8e, flag: 4 | 2, randomMaps: R.randomMapMask([4, 9]), weaponsFlag: 79 };
const body = buildChangeRoomInfoBody(summary, ch, null).toBytes();
const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
// D roomId, U46 name (46 bytes), C mapId rule stage roomType state players slots ping, H weapons, D flag ...
const off = 4 + 46 + 8;
check("body: slot count 8 and weaponsFlag 79", body[4 + 46 + 6] === 8 && dv.getUint16(off, true) === 79, `${body[4 + 46 + 6]} ${dv.getUint16(off, true)}`);
check("body: flag keeps PASSWORD and adds RANDOM_MAP", dv.getUint32(off + 2, true) === 6, String(dv.getUint32(off + 2, true)));

console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
