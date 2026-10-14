// Death camera rules (exe 2017, "Câmera KILL (tipo 3)" /).
// Pure: no three.js, so the observer smoke can check them (src/game/dev/observer.smoke.node.ts).

/** chara state of a dead body (0xb, GAMEPLAY_RE_2017, 0x55ab80) */
export const DEAD_BODY_STATE = 0xb;

/** CGameCameraManager::SetType 0x68d9d0 blend when the observer takes over from the dead body (0xb32db0) */
export const DEATH_BLEND_S = 0.1;

/**
 * CGameCamera_FPS::Update 0x689670 bone pick for the dead body: [chara+0x528] != 0 (3PV view flag) → node 2 = IK;
 * else state 0xc (0x54dcf0) → node 5 = Spine3; otherwise (0xb = dead, 0x55ab80) → node 6 = Neck.
 * The local player's body is 1PV (flag 0) and dead (0xb), so the death camera sits on Neck [INFERIDO bone names].
 */
export function deathBone(thirdPerson: boolean, state: number): "IK" | "Spine3" | "Neck" {
  if (thirdPerson) return "IK";
  return state === 0xc ? "Spine3" : "Neck";
}
