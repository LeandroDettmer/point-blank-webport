// Node smoke test of the GM observer shortcuts: key map, saved positions, FLY speed step.
//   node --experimental-transform-types src/game/dev/observerGm.smoke.node.ts
import { FLY_SPEED_LIMITS, NICK_SIZE, PosSlots, flySpeedStep, gmAction, gmNickText, gmNickView, idBadgeCell, nickSizeStep } from "../observerGm.ts";

let fails = 0;
const check = (name: string, ok: boolean) => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };

check("Shift+1 prev, Shift+2 next, Shift+3 fly", gmAction("Digit1", true, false)?.t === "prevTarget" && gmAction("Digit2", true, false)?.t === "nextTarget" && gmAction("Digit3", true, false)?.t === "viewFly");
check("Shift+4 (Top View) not ported", gmAction("Digit4", true, false) === null);
const sv = gmAction("Digit7", false, true), go = gmAction("Numpad7", false, false);
check("Ctrl+7 saves slot 7, 7 goes to it", sv?.t === "savePos" && sv.n === 7 && go?.t === "gotoPos" && go.n === 7);
check("Ctrl+Shift+digit and other keys do nothing", gmAction("Digit1", true, true) === null && gmAction("KeyW", false, false) === null);
check("F5 toggles the HUD", gmAction("F5", false, false)?.t === "toggleHud");

// nicks: ` / = / - only without Shift / Ctrl (GM block 0x76b124), F9 always (CHud::OnUpdate 0x7493aa)
check("` toggles the nicks, = bigger, - smaller", gmAction("Backquote", false, false)?.t === "toggleNicks"
  && JSON.stringify(gmAction("Equal", false, false)) === '{"t":"nickSize","d":1}' && JSON.stringify(gmAction("Minus", false, false)) === '{"t":"nickSize","d":-1}');
check("` = - ignored with Shift / Ctrl, numpad +/- unused", gmAction("Backquote", true, false) === null && gmAction("Equal", false, true) === null
  && gmAction("NumpadAdd", false, false) === null && gmAction("NumpadSubtract", false, false) === null);
check("F9 toggles the IDs with any modifier", gmAction("F9", false, false)?.t === "toggleIds" && gmAction("F9", true, true)?.t === "toggleIds");
check("nicks and IDs start off (0x590ea0)", !gmNickView.nicks && !gmNickView.ids);
check("nick size: GM 12, normal 11, step 1 within 6..18 (0x7445c0)", NICK_SIZE.gm === 12 && NICK_SIZE.normal === 11
  && nickSizeStep(12, 1) === 13 && nickSizeStep(12, -1) === 11 && nickSizeStep(18, 1) === 18 && nickSizeStep(6, -1) === 6);
let sz: number = NICK_SIZE.gm;
for (let i = 0; i < 20; i++) sz = nickSizeStep(sz, 1);
check("20 x = stops at 18", sz === 18);
check("GM nick text \"%s -%dHP\" (0x826240), HP truncated", gmNickText("Leo", 87.9) === "Leo -87HP" && gmNickText("x", 100) === "x -100HP");
const c0 = idBadgeCell(0), c1 = idBadgeCell(1), c15 = idBadgeCell(15);
check("seat badge: even red column u 5, odd blue u 35, row seat >> 1 (CreateHUD 0x748551)",
  c0?.x === 5 && c0.y === 5 && c1?.x === 35 && c1.y === 5 && c15?.x === 35 && c15.y === 5 + 27 * 7 && idBadgeCell(14)?.x === 5);
check("no badge outside seats 0..15", idBadgeCell(16) === null && idBadgeCell(-1) === null && idBadgeCell(100) === null);

const p = new PosSlots();
check("empty slot", p.get(3) === null);
p.save(3, { x: 1, y: 2, z: 3, yaw: 0.5, pitch: -0.2 });
const g = p.get(3)!;
g.x = 99;
check("saved slot is a copy", p.get(3)!.x === 1 && p.get(3)!.yaw === 0.5);
check("slot out of range refused", !p.save(10, g) && !p.save(-1, g));

const L = FLY_SPEED_LIMITS;
check("wheel up faster, down slower", flySpeedStep(6.7, -1) === 6.7 + L.step && flySpeedStep(6.7, 1) === 6.7 - L.step);
check("speed clamped", flySpeedStep(L.max, -1) === L.max && flySpeedStep(L.min, 1) === L.min && flySpeedStep(5, 0) === 5);

process.exit(fails ? 1 : 0);
