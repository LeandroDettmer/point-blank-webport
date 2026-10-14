// Bullet wall penetration, decoded from the 2017 exe.
// WeaponBase::DoLineCollision 0x60f700 -> 0x609a30 (characters) after the world walk 0x6094f0:
//   maxDist = the weapon range (vf+0x218). h1 = the nearest world hit.
//   h1 beyond maxDist -> no wall. Else 0x60abb0: the wall test 0x60a950 passes -> the bullet goes on, maxDist unchanged;
//   it fails -> maxDist = h1 distance (the bullet stops in the wall).
//   After a penetration (0x6095f9) the walk casts once more from h1 + dir * 0.01 (h2): h2 stops the bullet only when it is
//   nearer than half the range left, (maxDist - h1) * 0.5 > h2 (0x6097b4); a farther h2 does not limit it, and no third
//   wall is tested.
//   Characters: the nearest one nearer than maxDist; class 5 (sniper) hits every character on the line (0x609d90).
//   A character behind the penetrated wall gets info.f10 = that wall's terrain thickness (_CalcHitChara 0x60c904, < 0 or
//   > 100 -> 50) and CalcDamage 0x5448d0 multiplies by 1 - f10 * 0.01 when 0 < f10 < 100. A head hit skips CalcDamage
//   (OnHit 0x543bbc, CalcHeadShotDamage 0x7fbf20), so the wall does not reduce it.

/**
 * I3_TERRAIN_TYPE values 0x60a950 lets a bullet through (the order of the i3SceneDx I3_TERRAIN_* names): 12-15 the thin
 * concrete / steel / wood / marble, 21-31 the other *_THIN types and BARBEDWIRE, 35+ CLOTH_NO_DECAL and the *_WIRE types.
 * Solid terrain (0-11), PAPER / GLASS / PLASTIC / RUBBER / CLOTH (16-20) and BLOOD / TEMP1 / TEMP2 (32-34) stop it.
 */
export function penetrableTerrain(type: number): boolean {
  if (type < 12) return false;
  if (type > 15 && type < 21) return false;
  if (type > 31 && type < 35) return false;
  return true;
}

/** 0x5b7080: weapon classes the wall test is skipped for (melee 1 / 0x17, throwable 7, item 8, bomb 9) */
export function classSkipsWallTest(classType: number): boolean {
  return classType === 1 || classType === 0x17 || classType === 7 || classType === 8 || classType === 9;
}

export interface WallTerrain {
  /** I3_TERRAIN_TYPE of the shape (its _tagi3PhysixTerrainInfo +0) */
  type: number;
  /** terrain thickness (+8, an int set by the map author: TH_MET 90, TH_WOOD 50, TH_CLOTH 10...) */
  thickness: number;
}

/**
 * 0x60a950: does the bullet go through this wall?
 *   not a penetrable type -> no; thickness <= 10 -> yes;
 *   p = GetWeaponPenetrate(false) (HelmetPenetrate + equip bonus, 0x618080) * BulletWeight (CWeaponInfo +0x101c) * maxDist
 *   p > I3_EPS -> yes when rand() % 100 <= int(100 - thickness * hitDist / p); else no.
 * `roll` = rand() % 100 (0..99).
 */
export function wallPenetrates(t: WallTerrain, hitDist: number, maxDist: number, helmetPenetrate: number, bulletWeight: number,
  roll: number): boolean {
  if (!penetrableTerrain(t.type)) return false;
  if (t.thickness <= 10) return true;
  const p = helmetPenetrate * bulletWeight * maxDist;
  if (!(p > 2e-5)) return false;
  const chance = Math.trunc(100 - (t.thickness * hitDist) / p);
  return roll <= chance;
}

/** _CalcHitChara 0x60c97b: the thickness written to info.f10 (out of [0, 100] -> 50) */
export function wallDamageThickness(thickness: number): number {
  return thickness < 0 || thickness > 100 ? 50 : thickness;
}

/** 0x6097b4: after a penetration at h1, does the next wall h2 (distance from h1) stop the bullet? */
export function secondWallStops(maxDist: number, h1Dist: number, h2Dist: number): boolean {
  return (maxDist - h1Dist) * 0.5 > h2Dist;
}
