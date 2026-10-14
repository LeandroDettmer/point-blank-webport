// Observer of the round modes (Bomb Mission / Destruction): who is watched, which camera, what the HUD lists. Pure logic
// (no three / DOM), decoded from PointBlank.exe 2017, shared by game.ts (camera + HUD) and dev/observer.smoke.node.ts.
//
// CStageBattle::ProcessObserverMode 0x76ab80 runs every frame for a player who is dead (or joined a running round):
//  - the camera is CAMERA_TYPE 4 "OBSERVER" (third person behind the watched player) unless the room rule 0x10 (first
//    person only) is set, then type 0 "FPS" (his own eyes): 0x76ae7b. Types (CGameCameraManager::Create 0x68d40d):
//    0 FPS, 1 FOLLOW, 2 FLY, 3 KILL, 4 OBSERVER, 5 ONOBJECT, 6 OBSERVER2.
//  - the mouse picks the target (left 0x76b810, right 0x76b970, STBL_IDX_OBSERVER_NEXT / _PREV). The keyboard block of that
//    function (Shift+1..4, digits, F1 / F5 ...) sits behind CPlayer 0x6b4a30 = GM only: a normal player has no digit keys.
// - Space (0x76bfc0, STBL_IDX_OBSERVER_VIEW) walks the views.
//  - the watched player dying keeps the camera on him for 3 s (0x76b04b), then it jumps to the next one (0x76b970).
//  - watching the enemy team needs rule 0x04 (0x76b5d0), or nobody of the own team is left alive (0x76af80).
import type { ObserverRules } from "../lobby/core/roomRules";

export type ObsView = "fps" | "third" | "third2" | "fly";

/**
 * view a new observer starts in. The 2017 exe (0x76ad9b / 0x76ae32: room rule 0x10 -> FPS, else OBSERVER type 4) starts the
 * third-person chase camera unless the room says; the player remembers the original starting through
 * the teammate's eyes, so the port starts in FPS for every room [AJUSTE pedido pelo usuário, 2026-10-07]. Space still walks
 * the views the room allows (nextView), so OBSERVER is one key away when the 0x10 bit is clear.
 */
export function entryView(_r: ObserverRules): ObsView {
  return "fps";
}

/**
 * Space, 0x76bfc0. With S = rule 0x02 (FLY allowed), T = rule 0x01 while 0x10 is clear:
 * OBSERVER -> (0x10: FPS) / (T: OBSERVER2) / (S: FLY) / FPS; OBSERVER2 -> (S: FLY) / FPS; FPS -> (no 0x10: OBSERVER) / (S: FLY) / stay;
 * FLY -> FPS.
 */
export function nextView(cur: ObsView, r: ObserverRules): ObsView {
  switch (cur) {
    case "third": return r.firstOnly ? "fps" : r.third ? "third2" : r.on ? "fly" : "fps";
    case "third2": return r.on ? "fly" : "fps";
    case "fps": return !r.firstOnly ? "third" : r.on ? "fly" : "fps";
    case "fly": return "fps";
  }
}

/** a slot as the observer sees it */
export interface ObsSlot { id: string; team: 0 | 1; slot: number; alive: boolean }

/**
 * CStageBattle::_BuildObserveList 0x76b5d0 / 0x76d120: valid = present and alive (the slot is playing this round). Own team
 * slots first when the enemy is not watchable; with the enemy the list is red slots then blue slots, each by slot number
 * (the two 8-entry arrays 0x128 / 0x148 of the stage object).
 */
export function observeList(all: readonly ObsSlot[], myTeam: 0 | 1, withEnemy: boolean): ObsSlot[] {
  return all
    .filter((s) => s.alive && (withEnemy || s.team === myTeam))
    .sort((a, b) => a.team - b.team || a.slot - b.slot);
}

/**
 * Left click = STBL_IDX_OBSERVER_NEXT: the exe steps the list index down (0x76b81c: index - 1, wraps to 15);
 * right click = PREV steps it up. The list is the red / blue order of observeList.
 */
export function stepTarget(list: readonly ObsSlot[], cur: string | null, dir: -1 | 1): ObsSlot | null {
  if (list.length === 0) return null;
  const i = cur ? list.findIndex((s) => s.id === cur) : -1;
  if (i < 0) return list[dir === -1 ? list.length - 1 : 0];
  return list[(i + dir + list.length) % list.length];
}

/**
 * The watched player died and left the list: the camera moves on to who followed him in the old order (`idx` = his index in the
 * list of the last frame; the same index now points at the next one). 0x76b04b advances by index [INFERIDO: the exact step].
 */
export function nextAfterDead(list: readonly ObsSlot[], idx: number): ObsSlot | null {
  if (list.length === 0) return null;
  return list[idx >= 0 && idx < list.length ? idx : 0];
}

/** seconds the camera stays on a watched player who died before it moves on (0x76b04b: timer > 3.0) */
export const DEAD_TARGET_HOLD = 3;

/** third-person camera of the OBSERVER types: 0x68b290 / 0x68c1e0 */
export const OBS_CAM = {
  /** literal FOV of every non-FPS camera (CGameCameraManager::Create 0x68d11f) */
  fov: 70,
  /** pef Camera.Observer / Observer2 Distance and Height (basic.json); the exe distance is CGameCharaCameraContext::getVirtualCamPosition 0x815c40 [INFERIDO = pef Distance] */
  distance: 1.5,
  /** the OBSERVER camera follows the target's yaw and only a tenth of his pitch (0x68b387: pitch / 10) */
  pitchShare: 0.1,
  /** the collision line from the target to the camera stops at 0.9 of the hit (0x68b691, constant 0.9) */
  wallShare: 0.9,
  /** OBSERVER while the watched player aims (flag 0x54dd50): the camera backs off 4.5 m and tilts -15 degrees [INFERIDO: direction / sign, the values come from the exe notes] */
  aimPush: 4.5,
  aimPitch: (-15 * Math.PI) / 180,
  /** OBSERVER2 mouse orbit: pitch limited to +-80 degrees (0x68c2e1 / 0x68c315) */
  orbitPitchMax: (80 * Math.PI) / 180,
} as const;

/** the FLY camera speed (Cross CGameCamera_FLY ctor 0x67e14b: +0x148 = 6.7; 2017 0x68d206) */
export const FLY_SPEED = 6.7;
/** Cross CGameCamera_FLY ctor 0x67e15e: +0x150 = 0.15, the step factor: every update moves speed * 0.15 (0x67e2f5) */
export const FLY_STEP = 0.15;
/** the exe moves the FLY camera by a fixed step per frame (no dt in 0x67e270); the port scales it to 60 fps [INFERIDO: frame rate] */
export const FLY_FPS = 60;

/** held keys of the FLY camera: the bound move keys (stroke bits left 0x1 / back 0x2 / right 0x4 / forward 0x8) and R / F */
export interface FlyKeys { forward: boolean; back: boolean; left: boolean; right: boolean; up: boolean; down: boolean }

/**
 * CGameCamera_FLY::OnUpdate (Cross 0x67e270, vtable 0xb986c4 + 0xd0): forward / back along the look vector (pitch included),
 * left / right along the right vector (0x67e491..0x67e591), I3I key 0x1b (R) world up and 0x0f (F) world down (0x67e591 /
 * 0x67e5db), each by speed * FLY_STEP per frame. Moves `pos` in place (three axes: forward at yaw / pitch = (-sin yaw cos p,
 * sin p, -cos yaw cos p)).
 */
export function flyMove(pos: { x: number; y: number; z: number }, yaw: number, pitch: number, k: FlyKeys, speed: number, dt: number): void {
  const d = speed * FLY_STEP * FLY_FPS * dt, cp = Math.cos(pitch);
  const fx = -Math.sin(yaw) * cp, fy = Math.sin(pitch), fz = -Math.cos(yaw) * cp;
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  const f = (k.forward ? 1 : 0) - (k.back ? 1 : 0), r = (k.right ? 1 : 0) - (k.left ? 1 : 0), u = (k.up ? 1 : 0) - (k.down ? 1 : 0);
  pos.x += (fx * f + rx * r) * d;
  pos.y += (fy * f + u) * d;
  pos.z += (fz * f + rz * r) * d;
}

/**
 * HP list rows:
 * frame 219x35 of hud2 (473,38), bars 189x17 at (473,74) red / (473,92) blue, absolute window px. Texts (Create 0x709ded..0x70a0a7):
 * nick Arial 13 (189x17, ellipsis), score "%d" Gunplay 15 centred (21x26), weapon Arial 10 (129x17). Team header: hud2 frames
 * 32..37 (28 + 191 + 27 px, 30 high) 34 px above the top row, title STR_TBL_INGAME_HUD_LIFE_COUNT_TEXT Arial 17 bold white 191x23
 * 7 px lower (0x709cd6). GM observer only: hud4 seat icon 24x24 at (252 / W-278, y+6).
 */
export const HP_GAUGE = {
  frame: { w: 219, h: 35, u: 473, v: 38 },
  bar: { w: 189, h: 17, u: 473, vRed: 74, vBlue: 92 },
  step: 37,
  /** left column x (even slots = red), right column x = width - 249 (odd slots = blue) */
  leftX: 30,
  rightInset: 249,
  /** bar offset inside the frame (57 - 30 on the left, 222 from the right edge = frame + 27), y + 3 */
  barDx: 27, barDy: 3,
  /** text positions inside the frame: nick (30, 3), score (4 / 3, 5), weapon (30, 21) (left: 60 / 34 / 60; right: W-219 / W-246 / W-219) */
  nick: { dx: 30, dy: 3, w: 189, h: 17, size: 13 }, score: { dx: 4, dxBlue: 3, dy: 5, w: 21, h: 26, size: 15 }, weapon: { dx: 30, dy: 21, w: 129, h: 17, size: 10 },
  /** team header pieces relative to the plate x: red x 2 / 30 / 221 -> -28 / 0 / 191; blue W-249 / W-222 / W-31 -> 0 / 27 / 218 */
  header: { dy: 3 - 37, h: 30, w: [28, 191, 27], dxRed: [-28, 0, 191], dxBlue: [0, 27, 218], u: [693, 726, 757], uw: [28, 25, 27], vRed: 38, vBlue: 69 },
  /** header title: x 30 / W-240, 7 px under the header, 191x23, Arial 17 bold */
  title: { dxRed: 0, dxBlue: 9, dy: 7, w: 191, h: 23, size: 17 },
  /** GM seat icon (hud4, idBadgeCell) relative to the plate: 252 - 30 / W-278 - (W-249) */
  seat: { dxRed: 222, dxBlue: -29, dy: 6 },
} as const;

/**
 * Which rows the HP list draws (0x714db7..0x714e10): rule 0x08 = both teams; otherwise only the observer's own team
 * (the flag pair of 0x59c2b0 hides the other column).
 */
export function hpColumns(r: ObserverRules, myTeam: 0 | 1): { red: boolean; blue: boolean } {
  return r.enemyHp ? { red: true, blue: true } : { red: myTeam === 0, blue: myTeam === 1 };
}

/** y of row `i` of a column of `n` rows: UpdateGauge re-centres the column every update, y = (H >> 1) - (n * 37) / 2 + 37 i
 *  (Cross 0x70a9a8; the create rects H - 145 - 37 i are overwritten) */
export function hpRowY(height: number, n: number, i: number): number {
  return (height >> 1) - Math.trunc((n * HP_GAUGE.step) / 2) + i * HP_GAUGE.step;
}

/** bar fill 0..1 = current HP / full HP; a dead character (state 0xb) counts as 0 (0x714d5b) */
export function hpFill(hp: number, maxHp: number, alive: boolean): number {
  return alive ? Math.max(0, Math.min(1, hp / Math.max(1, maxHp))) : 0;
}

/** _SetObservedNick 0x76cb40: "<nick> (HP %3d)" (the format " (HP %3d%%)" is the branch of 0x4c1420 characters) */
export function observedNickText(name: string, hp: number): string {
  return `${name} (HP ${String(Math.max(0, Math.round(hp))).padStart(3, " ")})`;
}

/**
 * Bottom help band and its lines: black band (0,0,0,150),
 * 100 px high; y are from the screen bottom; i3 font sizes (hudText.ts). The target line is centred at W/2 - 200, at H-90 when
 * created and H-68 once a target is set (0x745ef7): Arial 15 bold 400x20, or 25 bold 400x40 for a GM observer (0x6aa770).
 * Lines 1..4 Arial 13 weight 400, 400x20, left, white.
 */
export const HELP_BAND = {
  height: 100, alpha: 0x96 / 255,
  nick: { y: 68, size: 15, h: 20, gmSize: 25, gmH: 40, w: 400 },
  next: { x: 30, y: 60, size: 13, w: 400 },
  prev: { x: 30, y: 40, size: 13, w: 400 },
  weapon: { fromRight: 230, y: 60, size: 13, w: 400 },
  view: { fromRight: 230, y: 40, size: 13, w: 400 },
} as const;
/** observed nick colour (0x745ec0): red team (255,0,0); otherwise (100,100,255), or (0,128,255) for a GM observer */
export function observedNickColor(team: 0 | 1, gm: boolean): [number, number, number] {
  return team === 0 ? [255, 0, 0] : gm ? [0, 128, 255] : [100, 100, 255];
}
