// Character damage of a K-400 / K-413 / C5 / C4 blast, decoded from the 2017 exe.
// The grenade and the C4 share every step below except the outer loop:
//   grenade WeaponBase::_OnCheckCollisionByExplosion 0x60e9c0: enemies + the thrower, one pass
//   C4      WeaponC4::_OnCheckCollisionByExplosion   0x6375f0: every character, two passes (team loop 0x637664, the team
//           argument is never read by 0x60ed10), no owner / team filter
// Both test |IK bone (2) - blast| < Explosion_Range (0x617060: pef + equip bonuses, 0 without items) and call vf+0x114
// 0x60ed10 for each character in range:
//   1. alive and human (0x4c1420 = dino): line blast -> Head bone (7, 0x5428f0); not blocked -> hit part HEAD (0x22)
//   2. alive state unchanged by 1: line blast -> IK bone (2, 0x559d10); not blocked -> hit part 1 (B_Root)
//   blocked = 0x60aa50: a world (group 5) or object (group 7) hit nearer than the bone. A throwable / C4 never goes
//   through a wall: 0x60abb0 skips the wall test 0x60a950 for class 1 / 7 / 8 / 9 / 0x17 (0x5b7080).
// Each hit is WeaponBase::_OnHitCharaByExplosion 0x60e4a0 -> CGameCharaBase::OnHit 0x543890 with
// f40 = GetDamage(1) x weapon+0xd24 (0x5833e0; the scale is taken as 1 [INFERIDO]):
//   HEAD: OnHit skips CalcDamage (0x543bbc) -> the raw f40, no distance term
//   part 1: CalcDamage 0x5448d0 -> _CalcDistanceRate 0x540690: 1 - len / f04 * f08, where f04 = Explosion_Range and
//     f08 = Explosion_EffectiveSlope (CWeaponInfo::SetDamageInfo 0x5b7820, vf+0x8c / vf+0x90) and
//     len = _CalcDamageLength 0x5405e0 = |B_Root shape actor - blast|. The DPD term is 1: CGrenadeInfo / CBombInfo keep
//     the base DPD getter vf+0x17c 0x5c3d70, which returns 0.
// K-400 (Damage 90, R 7, slope 0.9): 90 on an exposed head + 90..9 on the body. C4 (100, 10, 0.01): 100 + ~99, twice.

/** CGameCharaBase::_CalcDistanceRate 0x540690 first term, as explosions fill it: 1 - len / Explosion_Range * slope */
export function explosionDistanceRate(len: number, range: number, slope: number): number {
  if (range <= 2e-5) return 1; // the exe only applies the term when f04 > I3_EPS (0x54073f)
  return 1 - (len / range) * slope;
}

/** CalcDamage 0x5448d0 for a part-1 blast hit: int(max(1, Damage * clamp01(rate) + 0.5)) (no equip / cash terms) */
export function explosionBodyDamage(damage: number, len: number, range: number, slope: number): number {
  const r = Math.min(1, Math.max(0, explosionDistanceRate(len, range, slope)));
  return Math.trunc(Math.max(1, damage * r + 0.5));
}

export interface BlastTarget {
  /** |IK bone - blast|: the range test of 0x60e9c0 / 0x6375f0 */
  ikDist: number;
  /** |B_Root - blast|: _CalcDamageLength of the part-1 hit */
  rootDist: number;
  /** line blast -> Head bone not blocked (0x60aa50 groups 5 and 7) */
  headClear: boolean;
  /** line blast -> IK bone not blocked */
  ikClear: boolean;
  /** 0x4c1420: a dino has no head line, its first line also goes to the IK bone */
  dino?: boolean;
}

export interface BlastHit {
  part: "head" | "body";
  damage: number;
}

/**
 * The hits one blast lands on one character, in the exe's order. `hp` (current HP, <= 0 = dead) lets the "alive state
 * unchanged" check of 0x60ed10 stop the next hit once one killed; pass Infinity when the caller cannot know (a remote
 * victim drops the hits that arrive after its death anyway).
 */
export function explosionHits(o: { damage: number; range: number; slope: number; passes?: number; hp?: number }, t: BlastTarget): BlastHit[] {
  const out: BlastHit[] = [];
  if (!(t.ikDist < o.range)) return out;
  let hp = o.hp ?? Infinity;
  const raw = Math.trunc(o.damage + 0.5);
  for (let pass = 0; pass < (o.passes ?? 1); pass++) {
    if (hp <= 0) break;
    // 1. the head line (a dino's first line ends on the IK bone, the same part HEAD)
    if (t.dino ? t.ikClear : t.headClear) {
      out.push({ part: "head", damage: raw });
      hp -= raw;
    }
    // 2. only while the first hit did not change the alive state
    if (hp > 0 && t.ikClear) {
      const d = explosionBodyDamage(o.damage, t.rootDist, o.range, o.slope);
      out.push({ part: "body", damage: d });
      hp -= d;
    }
  }
  return out;
}
