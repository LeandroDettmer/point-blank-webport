// Node smoke test of the observer rules (game/observer.ts, decoded from PointBlank.exe 0x76ab80 / 0x76bfc0 / 0x76b5d0 /
// 0x7147c0): view walk with the room bits, target list and mouse stepping, HP list layout, nick line.
//   node --experimental-transform-types src/game/dev/observer.smoke.node.ts
import { observerRules, WATCH } from "../../lobby/core/roomRules.ts";
import { DEAD_BODY_STATE, DEATH_BLEND_S, deathBone } from "../deathCam.ts";
import { DEAD_TARGET_HOLD, FLY_SPEED, FLY_STEP, HP_GAUGE, entryView, flyMove, hpColumns, hpFill, hpRowY, nextAfterDead, nextView, observeList, observedNickText, stepTarget, type ObsSlot, type ObsView } from "../observer.ts";

let fails = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`);
};

const walk = (watch: number, from: ObsView, n = 6): ObsView[] => {
  const r = observerRules(watch), out: ObsView[] = [from];
  for (let i = 0; i < n; i++) out.push(nextView(out[out.length - 1], r));
  return out;
};
const seq = (a: ObsView[]) => a.join(">");

// entry view: 0x76ae7b
check("no rule bits: a new observer starts in FPS (port choice; the exe starts OBSERVER)", entryView(observerRules(0)) === "fps");
check("first-person-only room starts in FPS", entryView(observerRules(WATCH.FIRST_ONLY)) === "fps");

// Space, 0x76bfc0
check("bare room: third <-> fps", seq(walk(0, "third", 3)) === "third>fps>third>fps");
check("FLY allowed (0x02): fps > third > fly > fps", seq(walk(WATCH.ON, "fps", 4)) === "fps>third>fly>fps>third", seq(walk(WATCH.ON, "fps", 4)));
check("3rd person free (0x01) + FLY: fps > third > third2 > fly > fps", seq(walk(WATCH.THIRD | WATCH.ON, "fps", 5)) === "fps>third>third2>fly>fps>third", seq(walk(WATCH.THIRD | WATCH.ON, "fps", 5)));
check("3rd person free without FLY: third > third2 > fps", seq(walk(WATCH.THIRD, "third", 3)) === "third>third2>fps>third");
check("first-person only + FLY: fps > fly > fps", seq(walk(WATCH.FIRST_ONLY | WATCH.ON, "fps", 3)) === "fps>fly>fps>fly");
check("first-person only without FLY: stays in fps", seq(walk(WATCH.FIRST_ONLY, "fps", 2)) === "fps>fps>fps");
check("first-person only beats 3rd person free", seq(walk(WATCH.FIRST_ONLY | WATCH.THIRD, "fps", 2)) === "fps>fps>fps");

// target list: 0x76b5d0 / 0x76d120
const S = (id: string, team: 0 | 1, slot: number, alive = true): ObsSlot => ({ id, team, slot, alive });
const all = [S("s5", 1, 5), S("s0", 0, 0), S("s2", 0, 2), S("s3", 1, 3), S("s4", 0, 4, false), S("s1", 1, 1)];
check("own team only, alive only, by slot", observeList(all, 0, false).map((s) => s.id).join() === "s0,s2");
check("with the enemy: red slots then blue slots", observeList(all, 0, true).map((s) => s.id).join() === "s0,s2,s1,s3,s5");
check("blue observer sees blue", observeList(all, 1, false).map((s) => s.id).join() === "s1,s3,s5");
const L = observeList(all, 0, true);
check("first target = first of the list", stepTarget(L, null, 1)?.id === "s0");
check("target died: the one that followed him takes over (same index in the shorter list), wraps at the end", nextAfterDead(L, 2)?.id === L[2].id && nextAfterDead(L, L.length)?.id === L[0].id && nextAfterDead([], 0) === null);
check("left click (NEXT) steps the index down and wraps", stepTarget(L, "s0", -1)?.id === "s5" && stepTarget(L, "s2", -1)?.id === "s0");
check("right click (PREV) steps up and wraps", stepTarget(L, "s5", 1)?.id === "s0" && stepTarget(L, "s0", 1)?.id === "s2");
check("empty list = no target", stepTarget([], "s0", 1) === null);
check("dead target hold is 3 s", DEAD_TARGET_HOLD === 3);

// HP list: 0x7147c0
check("without rule 0x08 only the own team column", JSON.stringify(hpColumns(observerRules(0), 1)) === JSON.stringify({ red: false, blue: true }));
check("rule 0x08 draws both columns", JSON.stringify(hpColumns(observerRules(WATCH.ENEMY_HP), 0)) === JSON.stringify({ red: true, blue: true }));
check("rows re-centred every update (Cross 0x70a9a8: (H >> 1) - n*37/2 + 37 i): 3 rows at 768 high", [0, 1, 2].map((i) => hpRowY(768, 3, i)).join() === "329,366,403", [0, 1, 2].map((i) => hpRowY(768, 3, i)).join());
check("frame 219x35, bar 189 wide, step 37", HP_GAUGE.frame.w === 219 && HP_GAUGE.frame.h === 35 && HP_GAUGE.bar.w === 189 && HP_GAUGE.step === 37);
check("fill = hp / max, dead = 0", hpFill(50, 100, true) === 0.5 && hpFill(50, 100, false) === 0 && hpFill(200, 100, true) === 1);

// nick line: 0x76cb40 " (HP %3d)"
check("nick line pads the HP to 3", observedNickText("Ana", 7) === "Ana (HP   7)" && observedNickText("Ana", 100) === "Ana (HP 100)");

// exe bit layout of the room rule byte
const ace = observerRules(142);
check("Ace 142: FLY + enemy team + enemy HP", ace.on && ace.enemy && ace.enemyHp && !ace.firstOnly && !ace.third);

// death camera bone (game.ts deathCam, deathCam.ts): 3PV flag -> IK; dying state 0xc -> Spine3; dead 0xb -> Neck
check("death cam: local body is 1PV and dead -> Neck", deathBone(false, DEAD_BODY_STATE) === "Neck");
check("death cam: state 0xc -> Spine3", deathBone(false, 0xc) === "Spine3");
check("death cam: 3PV flag -> IK whatever the state", deathBone(true, DEAD_BODY_STATE) === "IK" && deathBone(true, 0xc) === "IK");
check("death cam: observer blend 0.1 s", DEATH_BLEND_S === 0.1);

// FLY camera, Cross CGameCamera_FLY::OnUpdate 0x67e270: one second of 60 frames moves 60 * speed * 0.15; its own position is
// integrated every frame even when another camera (the death camera) rewrote the scene camera in between
{
  const none = { forward: false, back: false, left: false, right: false, up: false, down: false };
  const pos = { x: 0, y: 0, z: 0 };
  let cam = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 60; i++) { cam = { x: 5, y: 1, z: 5 }; flyMove(pos, 0, 0, { ...none, forward: true }, FLY_SPEED, 1 / 60); cam = { ...pos }; }
  const step = 60 * FLY_SPEED * FLY_STEP;
  check("FLY forward (W) flies along -Z at yaw 0, 60 * 6.7 * 0.15 per second", Math.abs(cam.z + step) < 1e-6 && Math.abs(cam.x) < 1e-9 && cam.y === 0, JSON.stringify(cam));
  const p2 = { x: 0, y: 0, z: 0 };
  flyMove(p2, Math.PI / 2, 0, { ...none, right: true }, FLY_SPEED, 1);
  check("FLY right (D) at yaw 90 deg moves along -Z", Math.abs(p2.z + step) < 1e-6 && Math.abs(p2.x) < 1e-6, JSON.stringify(p2));
  const p3 = { x: 0, y: 0, z: 0 };
  flyMove(p3, 0, 0, { ...none, up: true }, FLY_SPEED, 1);
  flyMove(p3, 0, 0, { ...none, down: true, back: true }, FLY_SPEED, 1);
  check("FLY R up / F down along world Y, S back", Math.abs(p3.y) < 1e-9 && Math.abs(p3.z - step) < 1e-6, JSON.stringify(p3));
  const p4 = { x: 0, y: 0, z: 0 };
  flyMove(p4, 0, Math.PI / 2, { ...none, forward: true }, FLY_SPEED, 1);
  check("FLY forward follows the pitch (looking up climbs)", Math.abs(p4.y - step) < 1e-6, JSON.stringify(p4));
}

if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log("all ok");
