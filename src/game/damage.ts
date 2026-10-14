import { PB_CHARA, PB_DEFAULT_HELMET_PROTECTION } from "../gameplay/pbConfig";
import { actorHelmetDefense } from "./actorEquip";
import type { Actor, HitZone } from "./types";

// PB damage model from the 2017 exe:
//   CGameCharaBase::CalcDamage 0x5448d0, _CalcDistanceRate 0x540690, CalcHelmetPenetrate 0x5425e0.
// Part rates are pef-2017 Character.SWAT_Male.DamageRate (Body 1.2, Arm/Leg 0.8, Hand/Foot 0.6), read raw by
// CCharaInfo::ReadDamageRateInfo 0x534a20 and applied as plain multipliers by 0x542df0 (rate = getter 0x542f30 x
// GetDamageRateByMode 1.0) to info.f40 on a HUMAN target, EXCEPT hit parts 9, 10 and 0x22 (the head, part table
// 0x54310c): there 0x542df0 does not multiply. For those parts the local shooter's _CalcHitChara (0x60cd89..0x60ce08)
// replaces f40 with CalcHeadShotDamage 0x7fbf20 = 200 + shuffled[a % 35] - shuffled[(seed + idx) % 35], capped at 255
// (a 35-byte shuffled part table, CHARA_HIT_MAXCOUNT), not weapon Damage x Head. So the pef "Head 35" is only used for AI
// targets (0x542e77, every part), never as a human headshot multiplier. The 3.123 pef (Head 5, Body 1, Arm/Leg 0.75,
// Hand/Foot 0.5, HP 110) is NOT used: 2017 is the gameplay reference.
const R = PB_CHARA.damageRate;

/**
 * f40 of a human head hit (CalcHeadShotDamage 0x7fbf20): 200 + a - b with a, b bytes of the shuffled 35-part table, i.e.
 * 166..234 if the table is a permutation of 0..34 (not verified), so 200 is its mean. [INFERIDO] Always above a
 * soldier's HP (100 / 110 / 120): a head hit that gets through the helmet kills (distance rate still applies, 0x543bbc).
 */
export const HEAD_HIT_DAMAGE = 200;

/** game/types HitZone: torso = Body, limb = Arm/Leg (Hand / Foot 0.6 are not separate zones here). */
export const ZoneMultiplier: Record<HitZone, number> = {
  head: R.head, // AI targets only (0x542e77); a human head hit uses HEAD_HIT_DAMAGE
  torso: R.body,
  limb: R.arm,
};

/**
 * PB soldiers have no armor points. CalcDamage's percent term info.f10 is the thickness of the wall a bullet went through
 * (_CalcHitChara 0x60c904, src/weapons/penetration.ts), not a vest.
 */
export const VEST_ABSORB = 0;

/**
 * PLACEHOLDER DPD_Rate for callers that do not pass the weapon's own value (game.ts botFire / weaponAdapter
 * non-final hits call rangeFalloff(distance, range)). 0.35 = K-2. Pass WeaponStat.pb.dpdRate to be exact.
 */
export const FALLBACK_DPD_RATE = 0.35;

/** Fallback helmet rate (the default helmet 701002, HelmetDefault.Defense 0.75); a hit uses its target's item rate (actorEquip.ts). */
export const DEFAULT_HELMET_DEFENSE: number = PB_DEFAULT_HELMET_PROTECTION;

export interface DamageRequest {
  target: Actor;
  attacker: Actor | null;
  base: number;
  zone: HitZone;
  /** XML HelmetPenetrate 0..100 = pef chance x 100 that a head hit gets through the helmet. */
  helmetPenetrate: number;
  /** Distance falloff multiplier from rangeFalloff / distanceRate (1 = none). */
  falloff?: number;
  /** base already is the final damage from src/weapons (pbHitDamage, helmet roll included): only the helmet pop applies */
  preScaled?: boolean;
  /** the battle room's rule and type (ruleDamage); undefined = no rule */
  room?: RoomRule;
  now: number;
}

/** The room a battle runs in: Rules.xml rule (MapRules) and room type (RoomCondition). */
export interface RoomRule { rule: number; roomType: number }

/** MapRules (matchCore.ts) and RoomCondition.DeathMatch: the Cross Deathmatch rules that change the damage. [INFERIDO] values */
export const RULE_HEADHUNTER = 32;
export const RULE_CHAOS = 80;
export const ROOM_DEATHMATCH = 4;

/**
 * Damage of a hit under the room rule (matchCore.ts damage branch, same numbers): HeadHunter = 1 unless it is a headshot,
 * Chaos = 200. Only Deathmatch rooms. Shared by every client path that lands damage (computeDamage).
 */
export function ruleDamage(room: RoomRule | undefined, damage: number, headshot: boolean): number {
  if (!room || room.roomType !== ROOM_DEATHMATCH) return damage;
  if (room.rule === RULE_HEADHUNTER) return headshot ? damage : 1;
  if (room.rule === RULE_CHAOS) return 200;
  return damage;
}

export interface DamageResult {
  dealt: number;
  killed: boolean;
  headshot: boolean;
  blocked: boolean; // spawn protection / already dead / friendly
  /** a helmet was on the head and stopped the hit (it pops off) */
  helmetBlocked: boolean;
}

/**
 * CGameCharaBase::_CalcDistanceRate (0x540690), bullet branch:
 *   k = min(dist / Range, 1); slope = min(1, DPD_Rate * (1 + equipBonus)); rate = term1 * (1 - k * slope)
 * term1 = 1 - pen / info.f04 * info.f08 is the explosion falloff (f04 = Explosion_Range, f08 = Explosion_EffectiveSlope,
 * CWeaponInfo::SetDamageInfo 0x5b7820; src/weapons/explosion.ts): a gun's info returns 0 for both, so it is 1 here.
 * equipBonus (3 equip slots, value*0.01) is 0 for a default soldier.
 */
export function distanceRate(distance: number, range: number, dpdRate: number, equipBonus = 0): number {
  if (range <= 0) return 1;
  const k = Math.min(Math.max(0, distance) / range, 1);
  const slope = Math.min(1, dpdRate * (1 + equipBonus));
  return 1 - k * slope;
}

/** Kept for callers of the old API; the formula is distanceRate (0x540690). */
export function rangeFalloff(distance: number, range: number, dpdRate = FALLBACK_DPD_RATE): number {
  return distanceRate(distance, range, dpdRate);
}

/**
 * CGameCharaBase::CalcDamage (0x5448d0) without cash-item / AI-mode terms:
 *   armor = (0 < armorPct < 100) ? 1 - armorPct * 0.01 : 1   (armorPct = info.f10, the penetrated wall's thickness)
 *   r = clamp01(distRate * armor);  dmg = partScaled * (1 + charaEquipBonus) * r;  return int(max(1, dmg + 0.5))
 * partScaled = Damage x part rate (WeaponBase::GetDamage 0x616730 -> info.f40, not fully decoded).
 */
export function pbCalcDamage(partScaled: number, distRate = 1, armorPct = 0, charaEquipBonus = 0): number {
  const armor = armorPct > 0 && armorPct < 100 ? 1 - armorPct * 0.01 : 1;
  const r = Math.min(1, Math.max(0, distRate * armor));
  return Math.trunc(Math.max(1, partScaled * (1 + charaEquipBonus) * r + 0.5));
}

/**
 * CGameCharaBase::CalcHelmetPenetrate (0x5425e0): p = HelmetPenetrate (0..1) / helmet.Defense; penetrates if rand <= p.
 * (damageType 5 forces p = 0.5 before the division.)
 */
export function helmetPenetrates(pen01: number, defense = DEFAULT_HELMET_DEFENSE, rand = Math.random()): boolean {
  if (defense === 0) return true;
  let p = pen01;
  if (p > 0 && defense > 0) p /= defense;
  return rand <= p;
}

/**
 * Damage a head hit does when CalcHelmetPenetrate says the helmet stopped it.
 * TODO(caller of 0x5425e0, not decoded): PLACEHOLDER 0 - the helmet pops off and the hit is absorbed.
 */
export const HELMET_BLOCKED_DAMAGE = 0;

export interface PbHit {
  damage: number;
  /** a helmet was on the head and stopped the hit (it pops off either way) */
  helmetBlocked: boolean;
}

/**
 * One bullet/melee hit end to end: part rate -> helmet roll -> distance rate -> CalcDamage rounding.
 * `wallThickness` = info.f10 of a bullet that went through a wall (penetration.ts wallDamageThickness). The exe's head
 * hit skips CalcDamage (OnHit 0x543bbc), so the wall term is not applied to the head.
 */
export function pbHitDamage(opts: {
  base: number; zone: HitZone | "body" | "arm" | "leg" | "hand" | "foot"; distance?: number; range?: number;
  dpdRate?: number; helmet?: boolean; helmetPenetrate01?: number; helmetDefense?: number; rand?: number;
  partRates?: Partial<typeof R>; wallThickness?: number;
  /** 0.01 x the shooter's DPD_Rate title sum (distanceRate equipBonus) */
  dpdBonus?: number;
}): PbHit {
  const rates = { ...R, ...opts.partRates };
  const z = opts.zone;
  const part = z === "torso" || z === "body" ? rates.body : z === "limb" ? rates.arm
    : z === "arm" ? rates.arm : z === "leg" ? rates.leg : z === "hand" ? rates.hand : rates.foot;
  if (z === "head" && opts.helmet && !helmetPenetrates(opts.helmetPenetrate01 ?? 0, opts.helmetDefense, opts.rand)) {
    return { damage: HELMET_BLOCKED_DAMAGE, helmetBlocked: true };
  }
  const dr = opts.dpdRate !== undefined && opts.range ? distanceRate(opts.distance ?? 0, opts.range, opts.dpdRate, opts.dpdBonus ?? 0) : 1;
  const scaled = z === "head" ? HEAD_HIT_DAMAGE : opts.base * part;
  return { damage: pbCalcDamage(scaled, dr, z === "head" ? 0 : opts.wallThickness ?? 0), helmetBlocked: false };
}

export function computeDamage(req: DamageRequest): DamageResult {
  const t = req.target;
  const none: DamageResult = { dealt: 0, killed: false, headshot: false, blocked: true, helmetBlocked: false };
  if (!t.alive || req.now < t.invulnUntil) return none;
  if (req.attacker && req.attacker !== t && req.attacker.team === t.team) return none;

  let dmg: number;
  let helmetBlocked = false;
  if (req.preScaled) {
    // src/weapons already rolled the helmet (pbHitDamage); a head hit on a helmet still knocks it off
    dmg = Math.max(0, Math.round(req.base));
    if (req.zone === "head" && t.helmet) { t.helmet = false; helmetBlocked = true; }
  } else {
    const hit = pbHitDamage({
      base: req.base, zone: req.zone, helmet: req.zone === "head" && t.helmet,
      helmetPenetrate01: Math.max(0, Math.min(100, req.helmetPenetrate)) / 100, helmetDefense: actorHelmetDefense(t.id) || undefined,
    });
    if (req.zone === "head" && t.helmet) { t.helmet = false; helmetBlocked = true; }
    dmg = hit.helmetBlocked ? hit.damage : pbCalcDamage(req.zone === "head" ? HEAD_HIT_DAMAGE : req.base * ZoneMultiplier[req.zone], req.falloff ?? 1);
  }
  // Defense Up coupons of the target (Actor.defense, local player only) [INFERIDO: damage x (1 - N%), at least 1]
  if (dmg > 0 && t.defense) dmg = Math.max(1, Math.round(dmg * (1 - t.defense)));
  // the room rule replaces the damage, but a helmet that stopped the hit still stops it
  if (!helmetBlocked) dmg = ruleDamage(req.room, dmg, req.zone === "head");
  if (dmg <= 0) return { dealt: 0, killed: false, headshot: req.zone === "head", blocked: false, helmetBlocked };
  t.hp = Math.max(0, t.hp - dmg);
  const killed = t.hp <= 0;
  if (killed) t.alive = false;
  return { dealt: dmg, killed, headshot: req.zone === "head", blocked: false, helmetBlocked };
}
