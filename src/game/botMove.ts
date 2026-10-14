import { PB_CHARA, moveDirType, type MoveNormalPct } from "../gameplay/pbConfig";

/**
 * pef-3.123 Weapon.Assault.K-2 (BOT_WEAPON, item 103004): MoveNormal_* (% of the character speed) and ReloadTime.
 * weaponAdapter's WEAPON_DEFS K-2 says reloadTime 2.4; the pef says 2.5, used here so the reload clip and the refill
 * line up.
 */
export const BOT_PEF: { moveNormal: MoveNormalPct; reloadTime: number } = {
  moveNormal: { stand: 80, fire: 78, sit: 33, zoom: 76, scope: 0 },
  reloadTime: 2.5,
};

/**
 * PB move speed for a bot, same rule as the player (src/player.ts moveSpeed, CGameCharaMoveContext::ProcessAccel):
 * PB_CHARA run|walk [direction type] x MoveNormal_(Sit|Stand)% x (zoom ? MoveNormal_Zoom%) x (firing ? MoveNormal_Fire%).
 * localX right, localZ forward; components under 30 % of the length count as 0 (keys are digital in PB).
 */
export function pbBotSpeed(localX: number, localZ: number, o: { crouch: boolean; zoom: boolean; firing: boolean; walk?: boolean },
  mn: MoveNormalPct = BOT_PEF.moveNormal): number {
  const l = Math.hypot(localX, localZ);
  if (l < 1e-6) return 0;
  const x = Math.abs(localX) < 0.3 * l ? 0 : localX, z = Math.abs(localZ) < 0.3 * l ? 0 : localZ;
  let v = (o.walk ? PB_CHARA.walk : PB_CHARA.run)[moveDirType(x, z)];
  v *= (o.crouch ? mn.sit : mn.stand) / 100;
  if (o.zoom && mn.zoom > 0) v *= mn.zoom / 100;
  if (o.firing) v *= mn.fire / 100;
  return v;
}
