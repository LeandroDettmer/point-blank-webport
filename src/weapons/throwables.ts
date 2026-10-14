import * as THREE from "three";
import type { Family, WeaponStat } from "./types.ts";

/**
 * PB 2017 throwables beyond the plain frag:
 *  - FlashBang (WeaponFlash): WeaponFlash::_OnCheckCollisionByExplosion 0x633e70 only tests the LOCAL character
 *    (g_d8013c): eye distance < Explosion_Range (0x617060) -> 0x633f50 casts a world line grenade -> eye; a hit nearer
 *    than the range shortens it and only a line shorter than that reaches the character (walls block) -> vf+0x10c ->
 *    CGameCharaBase::OnHit 0x543890 (damage type 3) -> CGameCharaHUDContext::ScreenEffect_Flashbang 0x825b50
 *    (flashDuration) + the sound manager's deaf state 0x69a180 for the same time; the white screen then runs in
 *    CGameCharaHUDContext::OnUpdate 0x824f60 state 2 (FlashScreen). Every client blinds its own player.
 *  - SmokeGrenade (WeaponSmoke::Explosion 0x632f90): hides the grenade and plays its _FireEffect (Exp_Sm_01) with
 *    i3EffectManager::AddEffect at the grenade, +Y up. No gameplay volume in the exe: the cloud IS the particles
 *    (13 s life); SmokeField makes those particles opaque to the bots' sight lines.
 *  - C5 (WeaponC5 + WeaponBombTrigger): thrown at Throw_Speed (10), sticks (AttachableItem); the hand then holds the
 *    bomb trigger (Bombtrigger_ITEMID 412001). WeaponBombTrigger::OnFire 0x642340: once the press is 0.05 s old every
 *    planted C5 of the owner gets flag 8 (0x642f60) + sound 0x10; WeaponC5 OnUpdate (0x646306): while flag 8,
 *    +0xa5d0 += dt and it explodes past GetExplosionTime 0x616fd0 (Explosion_Time 0.5 s).
 */

/** "mine": Claymore (ClassMeta WeaponClaymore): planted where it lands, goes off when an enemy comes within CLAYMORE_DETECT_RANGE in its cone */
export type ThrowKind = "grenade" | "c5" | "mine" | "flash" | "smoke" | "wpsmoke" | "heal";

/**
 * Throwing / Throwing2 items of the PBCross Weapon.pef (tools: extracted/pef-cross/br/Weapon.json, ClassMeta -> kind):
 * [itemId, pef key, kind, base itemId when weapons.json lacks the item (0 = present), 2017 pack id (models / icons-kaybo,
 * 0 = none), Explosion_Range, Explosion_EffectiveSlope, Explosion_Time, EffectiveTime, Throw_Speed, AttackTimeA1,
 * Damage]. The 2017 packs number throwables differently from the server (server 407053 = C5_PBWC but 2017 407053 =
 * WaterBomb and 407056 = C5_PBWC; server 508002 FlashBang = 2017 507003; server 407004 K-413 = 2017 407008 while 2017
 * 407004 is the C5), so a server id must go through pack2017Id before looking up a 2017 model or icon.
 */
type Row = [number, string, ThrowKind, number, number, number, number, number, number, number, number, number];
const ROWS: Row[] = [
  [407001,"K-400","grenade",0,407001,7,0.9,0.9,0.8,18.5,0.1,90],
  [407002,"C5","c5",0,407004,6,0.9,0.5,0,10,0.1,60],
  [407003,"C5_D","c5",0,407006,6,0.9,0.5,0,10,0.1,60],
  [407004,"K-413","grenade",0,407008,7,0.9,0.9,0.8,18.5,0.4,40],
  [407005,"ChocolateGrenade","grenade",0,407009,8,0.9,0.9,0.8,18.5,0.1,40],
  [407006,"C5_EV","c5",0,407016,6,0.9,0.5,0,10,0.1,60],
  [407007,"K-413_Gold","grenade",0,407018,7,0.9,0.9,0.8,18.5,0.4,40],
  [407008,"Ketupat_Grenade","grenade",0,407019,7,0.75,0.9,0.8,20,0.1,90],
  [407009,"CANDYGRENADE","grenade",0,407020,7.5,0.9,0.9,0.8,18.5,0.1,90],
  [407010,"Fanoos_Grenade","grenade",0,407023,7,0.9,0.9,0.8,18.5,0.1,90],
  [407011,"Maamoul_Grenade","grenade",0,407024,7,0.9,0.9,0.8,18.5,0.1,90],
  [407014,"K-479","grenade",0,407028,7,0.9,0.9,0.8,18.5,0.1,35],
  [407015,"K-400_Easter","grenade",0,407030,7,0.9,0.9,0.8,18.5,0.1,90],
  [407017,"K-413_T","grenade",0,407034,7,0.9,0.9,0.8,18.5,0.4,40],
  [407019,"K-413_Traditional","grenade",0,407036,7,0.9,0.9,0.8,18.5,0.4,40],
  [407020,"K-413_PC_Cafe","grenade",0,407037,7,0.9,0.9,0.8,18.5,0.4,40],
  [407021,"ShuttleCock_Grenade","grenade",0,407038,7,0.9,0.9,0.8,18.5,0.4,40],
  [407022,"Sepaktakraw_Grenade","grenade",0,407039,7,0.9,0.9,0.8,18.5,0.1,90],
  // M18 A1 Claymore: server 407023 = 2017 407040 (pef _Number 40, _ResName M18_A1_Claymore; models/m18_a1_claymore.glb).
  // Without this row 407023 stayed a raw id and matched the Fanoos Grenade model (itemIds 407023) and its clips.
  // Pef values of the 2017 block (Explosion_Range 5, NearRange 2, Explosion_Time 0.8, Throw_Speed 14, AttackTimeA1 0.45).
  [407023,"M18A1_Claymore","mine",0,407040,5,0,0.8,0,14,0.45,65],
  [407024,"K-413_GW","grenade",0,407041,7,0.9,0.9,0.8,18.5,0.4,40],
  [407025,"K-400_Goat","grenade",0,407042,7,0.9,0.9,0.8,18.5,0.1,90],
  [407044,"C5_CNY-2015","c5",0,407044,6,0.9,0.5,0,10,0.1,60],
  [407045,"K-413_Chocolate","grenade",0,407045,7,0.9,0.9,0.8,18.5,0.4,40],
  [407046,"K-413_Redemption","grenade",0,407047,7,0.9,0.9,0.8,18.5,0.4,40],
  [407047,"K-413_4Game","grenade",0,407049,7,0.9,0.9,0.8,18.5,0.4,40],
  [407048,"K-413_4Game-SE","grenade",0,407050,7,0.9,0.9,0.8,18.5,0.4,40],
  [407049,"Snowman_Grenade","grenade",0,407052,7,0.9,0.9,0.8,18.5,0.1,90],
  [407051,"K-413_Tiger-Normal","grenade",407017,407054,7,0.9,0.9,0.8,18.5,0.4,40],
  [407052,"K-413_Tiger-Deluxe","grenade",407017,407055,7,0.9,0.9,0.8,18.5,0.4,40],
  [407053,"C5_PBWC","c5",407002,407056,6,0.9,0.5,0,10,0.1,60],
  [407054,"K-400_Mummy","grenade",407001,407057,7,0.9,0.9,0.8,18.5,0.1,90],
  [407055,"K-413_BlueDiamond","grenade",407004,407058,7,0.9,0.9,0.8,18.5,0.4,40],
  [407056,"K-400_Alien","grenade",0,407062,7,0.9,0.9,0.8,18.5,0.1,90],
  [407057,"K-413_Puzzle","grenade",407004,407063,7,0.9,0.9,0.8,18.5,0.4,40],
  [407058,"K-413_Russian_Normal","grenade",407004,407064,7,0.9,0.9,0.8,18.5,0.4,40],
  [407059,"K-413_Russian_Deluxe","grenade",407004,407065,7,0.9,0.9,0.8,18.5,0.4,40],
  [407061,"C5_PBIC2016","c5",407002,407067,6,0.9,0.5,0,10,0.1,60],
  [407062,"C5_PBNC2016","c5",407002,407068,6,0.9,0.5,0,10,0.1,60],
  [407063,"K-413_Ice","grenade",407004,407070,7,0.9,0.9,0.8,18.5,0.4,40],
  [407064,"C5_Lightning","c5",407002,407071,6,0.9,0.5,0,10,0.1,60],
  [407065,"K-400_Fire","grenade",407001,407072,7,0.9,0.9,0.8,18.5,0.1,90],
  [407067,"Beer_Glass","grenade",407010,0,7,0.9,0.9,0.8,18.5,0.1,90],
  [407069,"C5_PBIC2017","c5",407002,0,6,0.9,0.5,0,10,0.1,60],
  [407070,"K-400_M1LGR4U","grenade",407001,0,7,0.9,0.9,0.8,18.5,0.1,90],
  [407071,"K-413_Maze","grenade",407004,0,7,0.9,0.9,0.8,18.5,0.4,40],
  [407072,"C5_PBWC2018","c5",407002,0,6,0.9,0.5,0,10,0.1,60],
  [407073,"K-413_Ramazan2018","grenade",407004,0,7,0.9,0.9,0.8,18.5,0.4,40],
  [407074,"IceCreamGrenade","grenade",407005,0,8,0.9,0.9,0.8,18.5,0.1,40],
  [407075,"K-413_Football_Normal","grenade",407004,0,7,0.9,0.9,0.8,18.5,0.4,40],
  [407076,"K-413_Football_Deluxe","grenade",407004,0,7,0.9,0.9,0.8,18.5,0.4,40],
  [407077,"C5_Sacrifice","c5",407002,0,6,0.9,0.5,0,10,0.1,60],
  [407078,"C5_PBIC2018","c5",407002,0,6,0.9,0.5,0,10,0.1,60],
  [407080,"BundleM24","grenade",407009,0,10,1.15,1.3,1.5,19.5,0.1,95],
  [407081,"C5_Zepetto","c5",407002,0,6,0.9,0.5,0,10,0.1,60],
  [407082,"K-400_Xmas2018","grenade",407001,0,7,0.9,0.9,0.8,18.5,0.1,90],
  [407083,"K-400_BOG-Basic","grenade",407001,0,7,0.9,0.9,0.8,18.5,0.1,90],
  [407084,"K-400_BOG-Deluxe","grenade",407001,0,7,0.9,0.9,0.8,18.5,0.1,90],
  [407087,"C5_PBWC2019","c5",407002,0,6,0.9,0.5,0,10,0.1,60],
  [407088,"C5_PBIWC2019","c5",407002,0,6,0.9,0.5,0,10,0.1,60],
  [407089,"K-400_Ramadan19-Basic","grenade",407001,0,7,0.9,0.9,0.8,18.5,0.1,90],
  [407090,"C5_Executor","c5",407002,0,6,0.9,0.5,0,10,0.1,60],
  [407098,"K-400_Fruit","grenade",407001,0,7,0.9,0.9,0.8,18.5,0.1,90],
  [407099,"K-400_Vidio","grenade",407001,0,7,0.9,0.9,0.8,18.5,0.1,90],
  [407100,"C5_Title","c5",407002,0,6,0.9,0.5,0,10,0.1,60],
  [407101,"K-479_Title","grenade",407014,0,7,0.9,0.9,0.8,18.5,0.1,35],
  [407102,"K-413_Title","grenade",407017,0,7,0.9,0.9,0.8,18.5,0.4,40],
  [407107,"DalgonaGrenade","grenade",407009,0,7.5,0.9,0.9,0.8,18.5,0.1,90],
  [407108,"K-400_Erawan","grenade",407001,0,7,0.9,0.9,0.8,18.5,0.1,90],
  [407109,"C5_Esports_Revenge","c5",407002,0,6,0.9,0.5,0,10,0.1,60],
  [407111,"Maracas_Summer2023_Grenade","grenade",407004,0,6,0.9,0.8,0.8,18.5,0.383333,55],
  [407114,"C5_PBST24","c5",407002,0,6,0.9,0.5,0,10,0.1,60],
  [407115,"C5_Bayram24","c5",407002,0,6,0.9,0.5,0,10,0.1,60],
  [407116,"K-400_X-MAS2024","grenade",407001,0,7,0.9,0.9,0.8,18.5,0.1,90],
  [407117,"K-400_AoeXe_Basic","grenade",407001,0,7,0.9,0.9,0.8,18.5,0.1,90],
  [407118,"K-400_AoeXe_Deluxe","grenade",407001,0,7,0.9,0.9,0.8,18.5,0.1,90],
  [407119,"K-413_Easter2026","grenade",407004,0,7,0.9,0.9,0.8,18.5,0.4,40],
  [407120,"C5_Zepetto_Durability","c5",407002,0,6,0.9,0.5,0,10,0.1,60],
  [407121,"C5_WildArena","c5",407002,0,6,0.9,0.5,0,10,0.1,60],
  [407122,"C5_WildArena_Durability","c5",407002,0,6,0.9,0.5,0,10,0.1,60],
  // ThrowingHeal (ClassMeta WeaponMedicalKit): a heal zone, not a blast. Explosion_Range 0.85, Explosion_Time 10, Damage 40 (Kurma 50)
  [528001,"Medical_Kit","heal",0,507011,0.85,0,10,0,15,0.366667,40],
  [528002,"Halloween_Medical_Kit","heal",0,507014,0.85,0,10,0,15,0.366667,40],
  [528003,"Chocolate_Kit","heal",0,507015,0.85,0,10,0,15,0.366667,40],
  [528004,"Medical_Kit_Lotus","heal",0,507021,0.85,0,10,0,15,0.366667,40],
  [528005,"Medical_Kit_Opor_Ayam","heal",0,507025,0.85,0,10,0,15,0.366667,40],
  [528007,"Medical_Kit_Easter","heal",0,507031,0.85,0,10,0,15,0.366667,40],
  [528008,"Medical_Kit_Lotus2","heal",0,507032,0.85,0,10,0,15,0.366667,40],
  [528009,"Medical_Kit_Kurma","heal",0,507043,0.85,0,10,0,15,0.366667,50],
  [528012,"Medical_Kit_PBNC2015","heal",0,507051,0.85,0,10,0,15,0.366667,40],
  [508001,"SmokeGrenade","smoke",0,507002,10,10,1,0,18.5,0.1,0],
  [508002,"FlashBang","flash",0,507003,10,0.8,1,10,18.5,0.1,0],
  [508003,"SmokeGrenadePlus","smoke",0,507010,10,10,1,0,18.5,0.1,0],
  [508004,"FlashBangPlus","flash",0,507013,13,0.8,1,15,18.5,0.1,0],
  [508005,"SmokeGrenade_Pink","smoke",508001,507059,10,10,1,0,18.5,0.1,0],
  [508006,"SmokeGrenade_Blue","smoke",508001,507060,10,10,1,0,18.5,0.1,0],
  [508007,"SmokeGrenade_Yellow","smoke",508001,507061,10,10,1,0,18.5,0.1,0],
  [508009,"SmokeGrenadePlus_Title","smoke",508003,0,10,10,1,0,18.5,0.1,0],
  [508011,"FlashBangPlus_Title","flash",508004,0,13,0.8,1,15,18.5,0.1,0],
  [508015,"SmokeGrenade_Pink_Durability","smoke",508001,0,10,10,1,0,18.5,0.1,0],
  [508016,"SmokeGrenade_Pbis_Basic","smoke",508001,0,10,10,1,0,18.5,0.1,0],
  [527001,"WP_SmokeGrenade","wpsmoke",0,507005,5,0.9,0.9,10,18.5,0.1,1],
  [527002,"WP_SmokeGrenade_D","wpsmoke",0,507007,5,0.9,0.9,10,18.5,0.1,1],
  [527003,"WP_SmokeGrenadePlus","wpsmoke",0,507012,5,0,0.9,10,18.5,0.1,2],
  [527004,"WP_SmokeGrenade_EV","wpsmoke",0,507017,5,0.9,0.9,10,18.5,0.1,1],
  [527005,"WP_SmokeGrenadePlus_P","wpsmoke",0,507022,5,0,0.9,10,18.5,0.1,2],
  [527006,"WP_PerfumeGrenade","wpsmoke",527001,0,5,0,0.9,10,18.5,0.1,3],
  [527007,"WP_SmokeGrenadePlus_Title","wpsmoke",527003,0,5,0,0.9,10,18.5,0.1,2],
  [527008,"WP_SmokeGrenade_Pbis_Deluxe","wpsmoke",527001,0,5,0.9,0.9,10,18.5,0.1,1],
];
const BY_ID = new Map(ROWS.map((r) => [r[0], r]));

/**
 * Claymore detection (2017 pef Detected_Range 3, same in 3.123). Only the owner's client runs it on its own mines (exe
 * 0x671760 gate 0x671910); an enemy (WeaponContext.isEnemy) inside this radius, in the cone below and with no wall
 * between sets it off after Explosion_Time (0.8 s, pef). [INFERIDO] the radius is the pef value: the exe adds a value from
 * the weapon info (vfunc +0x520) and the owner's character, not named here.
 */
export const CLAYMORE_DETECT_RANGE = 3;
/**
 * Claymore cone: the target's direction must be within pi/4 of the mine's look direction (the thrower's aim, set at the
 * throw). Exe 0x6714e0: angle from dot(unit(target - mine), this+0xa650) compared with the float 0xb66524 = pi/4 (45 deg).
 */
export const CLAYMORE_CONE_COS = Math.cos(Math.PI / 4);
/**
 * Claymore body under the surface: models/index.json bounds Y -0.0513..0.058 with the origin inside, so the back (-Y)
 * rests on the surface at this offset along the normal [INFERIDO: the GLB's -Y is the back face].
 */
export const CLAYMORE_BACK_OFFSET = 0.0513;

/** 2017 pack id of a server throwable (models/index.json, icons-kaybo); 0 = none / not a throwable. */
export function pack2017Id(itemId: number): number {
  return BY_ID.get(itemId)?.[4] ?? 0;
}

/**
 * ClassMeta WeaponDualGrenade items of the server Weapon.pef (K-413 family, LoadBullet 2): one press throws the right
 * grenade at fire-anim t > 0.4 (0xb73588) and the left one at t > 1.233 (0xb7a7d0), both hard-coded in the override
 * 0x632370; same camera start / direction / Throw_Speed, no hand offset (WeaponDualGrenade::Create 0x631c40).
 */
const DUAL_GRENADE_IDS = new Set([407004, 407047, 407048, 407055, 407045, 407119, 407076, 407075, 407024, 407007, 407063,
  407071, 407020, 407057, 407073, 407046, 407059, 407058, 407017, 407052, 407051, 407102, 407019, 407111, 407021]);
export const DUAL_GRENADE_TIMES: readonly [number, number] = [0.4, 1.233];
export function isDualGrenade(itemId: number): boolean {
  return DUAL_GRENADE_IDS.has(itemId);
}

/** true for a server throwable: its id must not be looked up in the 2017 packs as is (see ROWS) */
export function isServerThrowable(itemId: number): boolean {
  return BY_ID.has(itemId);
}

/** kind of a weapon (null = not a throwable) */
export function throwKind(w: { id: number; family: Family; classType?: number; pb?: { src?: string } }): ThrowKind | null {
  if (w.family !== "GRENADE") return null;
  const r = BY_ID.get(w.id);
  if (r) return r[2];
  const src = w.pb?.src ?? "";
  if (w.classType === 28 || /Medical_?Kit|Chocolate_Kit/i.test(src)) return "heal"; // ThrowingHeal items with no row (PBNC5, PBNC6, Pigeon)
  if (/^Throwing2\/.*Flash/i.test(src)) return "flash";
  if (/^Throwing2\/WP_/i.test(src) || w.classType === 27) return "wpsmoke";
  if (/^Throwing2\/.*Smoke/i.test(src)) return "smoke";
  if (/^Throwing\/C5/i.test(src)) return "c5";
  return "grenade";
}
/** 2017 Weapon.pef NoReadySound 1 on a hand-held throwable (only the Chocolate Grenade): the pin pull makes no sound */
export const noReadySound = (itemId: number): boolean => itemId === 407005;

/** weapons.json row whose FX / sounds stand in for an item weapons.json lacks (the ROWS base), else the id itself */
export const throwableBaseId = (id: number): number => BY_ID.get(id)?.[3] || id;

/**
 * weapons.json row for a server throwable it lacks (e.g. 407053 C-5 PBWC2016): the base item of the same class with
 * this item's own id, name and pef explosion block. undefined when the id is not such an item.
 */
export function throwableStat(id: number, stat: (id: number) => WeaponStat | undefined): WeaponStat | undefined {
  const r = BY_ID.get(id);
  if (!r || !r[3]) return undefined;
  const b = stat(r[3]);
  if (!b) return undefined;
  const [, key, , , , range, slope, time, eff, speed, delay, dmg] = r;
  const grenade = { ...b.pb?.grenade, explosionRange: range, explosionSlope: slope, explosionTime: time, effectiveTime: eff,
    throwSpeed: speed, throwDelay: delay };
  const group = b.pb?.src?.split("/")[0] ?? "Throwing";
  return { ...b, id, name: key.replace(/_/g, " "), pb: { ...(b.pb ?? { src: "" }), src: `${group}/${key}`, damage: dmg, grenade } };
}

/**
 * Claymore: the 2017 pef explosion block over the stat of the same id. weapons.json has 407023 with the 3.123 block
 * (Explosion_Range 6, Explosion_Time 0.4), so the ROWS block (2017 client, the reference) must replace it. Other kinds
 * keep the weapons.json block, as before.
 */
export function mineStat(id: number, s: WeaponStat): WeaponStat {
  const r = BY_ID.get(id);
  if (!r || r[2] !== "mine") return s;
  const [, , , , , range, slope, time, eff, speed, delay] = r;
  const grenade = { ...s.pb?.grenade, explosionRange: range, explosionSlope: slope, explosionTime: time, effectiveTime: eff,
    throwSpeed: speed, throwDelay: delay };
  return { ...s, pb: { ...(s.pb ?? { src: "" }), grenade } };
}

// ---- FlashBang -------------------------------------------------------------------------------------------------

/**
 * ScreenEffect_Flashbang 0x825b50 (args pushed by OnHit 0x5439ad: EffectiveTime, Explosion_Range,
 * Explosion_EffectiveSlope, _CalcDamageLength): white time = EffectiveTime * rate, rate = 1 - slope * dist / range
 * (min 0.00002). The facing term is the exe's own: dot(character matrix +Z row, unit(flash - character)) * 180 / pi
 * (0x622600 is a dot product, not an angle); <= 0 becomes |x| + 90, then > 110 -> rate * 0.25, > 70 -> rate * 0.5.
 * So: flash in front = full time, behind within ~69 deg of the back = 1/4, anything else behind = 1/2.
 * (An equipped item halves it again, 0x522760(0x47870ce8): not modelled.)
 */
export function flashDuration(effTime: number, range: number, slope: number, dist: number, dotFacing: number): number {
  if (effTime === 0) return 0;
  let rate = 1 - (dist * slope) / range;
  if (rate < 0.00002) rate = 0.00002;
  let a = (dotFacing * 180) / Math.PI;
  if (a <= 0) a = Math.abs(a) + 90;
  if (a > 110) rate *= 0.25;
  else if (a > 70) rate *= 0.5;
  return effTime * rate;
}

/** exe g_SinTable lookup 0x52a710: 512 entries over 2 pi, index = (x * 41721.51) >> 9 & 0x1ff */
function tableSin(x: number): number {
  const i = (Math.trunc(x * 41721.51172) >> 9) & 0x1ff;
  return Math.sin((i / 512) * Math.PI * 2);
}

/**
 * White screen of CGameCharaHUDContext::OnUpdate 0x824f60, state 2 (sprite +0x130, colour +0x44 white):
 * remaining (+0x54) -= dt; elapsed = total (+0x58) - remaining;
 *   elapsed <= 0.5 -> alpha = elapsed * 2 * 255 (cap 255) | elapsed <= 1 -> 255 | else 255 - |sin(remaining)| * 150,
 *   not below 105. remaining <= 0: alpha -= round(dt * 255) per frame from its last value, cleared at 0 (the sound
 *   manager's deaf state is switched off there, 0x69a180(0)).
 */
export class FlashScreen {
  total = 0;
  remaining = 0;
  /** 0..255 */
  alpha = 0;
  active = false;

  /** a new flash restarts the effect (ScreenEffect_Flashbang overwrites +0x54 / +0x58) */
  start(duration: number): void {
    if (duration <= 0) return;
    this.total = duration;
    this.remaining = duration;
    this.alpha = 255;
    this.active = true;
  }

  update(dt: number): void {
    if (!this.active) return;
    this.remaining -= dt;
    if (this.remaining <= 0) {
      this.alpha -= Math.round(dt * 255);
      if (this.alpha <= 0) this.clear();
      return;
    }
    const elapsed = this.total - this.remaining;
    if (elapsed <= 0.5) this.alpha = Math.min(255, Math.round(elapsed * 2 * 255));
    else if (elapsed <= 1) this.alpha = 255;
    else this.alpha = Math.max(255 - 150, Math.round(255 - Math.abs(tableSin(this.remaining)) * 150));
  }

  clear(): void {
    this.total = this.remaining = this.alpha = 0;
    this.active = false;
  }
}

/** the local player's flash state (PbHud draws it, WeaponSystem feeds it) */
export const localFlash = new FlashScreen();

export interface FlashBurst {
  pos: THREE.Vector3;
  effTime: number;
  range: number;
  slope: number;
}
type FlashListener = (f: FlashBurst) => void;
const flashListeners = new Set<FlashListener>();
/** every flashbang going off (local or replicated): each observer (bots) tests itself, like each PB client does */
export function onFlashbang(cb: FlashListener): () => void {
  flashListeners.add(cb);
  return () => { flashListeners.delete(cb); };
}
export function emitFlashbang(f: FlashBurst): void {
  for (const l of [...flashListeners]) l(f);
}

/**
 * The exe test for one observer (0x633e70 / 0x633f50 / 0x825b50): eye within Explosion_Range, the world line from the
 * grenade not blocked (`hitDist(from, dir, len)` = world ray hit distance or null), then flashDuration with the
 * observer's horizontal facing (character matrix, not the camera pitch). Returns the white time, 0 = not affected.
 */
export function flashFor(f: FlashBurst, eye: THREE.Vector3, facing: THREE.Vector3,
  hitDist: (from: THREE.Vector3, dir: THREE.Vector3, len: number) => number | null): number {
  const d = eye.distanceTo(f.pos);
  if (!(d < f.range)) return 0;
  if (d > 1e-4) {
    const dir = _d.subVectors(eye, f.pos).divideScalar(d);
    let range = f.range;
    const hit = hitDist(f.pos, dir, d);
    if (hit !== null && hit < range) range = hit;
    if (!(d < range)) return 0;
  }
  const to = _t.subVectors(f.pos, eye);
  if (to.lengthSq() > 1e-8) to.normalize();
  const fw = _f.copy(facing).setY(0);
  if (fw.lengthSq() > 1e-8) fw.normalize();
  return flashDuration(f.effTime, f.range, f.slope, d, fw.dot(to));
}
const _d = new THREE.Vector3(), _t = new THREE.Vector3(), _f = new THREE.Vector3();

/**
 * "Zumbido": the sound manager's deaf state (0x69a180 on for the white time, off when the screen clears) ducks the game
 * sounds under the listener gain. The ringing itself is the real sample, table row 1 idx 9 = WM_Flash_Explosion_Damage
 * (0x6340bf -> 0x699530), played once by WeaponAudio.explosionHurt(true). The duck depth is [RECRIADO].
 */
export class FlashTinnitus {
  private listener: THREE.AudioListener | null;
  constructor(listener: THREE.AudioListener | null) { this.listener = listener; }

  update(f: FlashScreen): void {
    const l = this.listener;
    if (!l) return;
    try {
      const k = f.active ? f.alpha / 255 : 0;
      l.gain.gain.setTargetAtTime(f.active ? 1 - 0.85 * k : 1, l.context.currentTime, 0.05);
    } catch { /* no audio context (headless) */ }
  }
}

// ---- Smoke -----------------------------------------------------------------------------------------------------

/** one smoke particle as the sight test sees it: world centre, radius (half its quad), opacity 0..1 */
export interface SmokeSphere { x: number; y: number; z: number; r: number; a: number }
export interface SmokeSource {
  /** appends the live particles; returns false once the cloud is gone */
  collect(out: SmokeSphere[]): boolean;
}

/**
 * Sight occlusion by the live smoke clouds. Transmittance of a segment = prod(1 - a_i * chord_i / (2 r_i)) over the
 * particles it crosses; a sight line is blocked below BLOCK_T. [RECRIADO] threshold: the exe has no smoke rule for
 * AI (players are blocked by the drawn particles themselves).
 */
export class SmokeField {
  static readonly BLOCK_T = 0.35;
  private sources: SmokeSource[] = [];
  private buf: SmokeSphere[] = [];

  add(s: SmokeSource): void { this.sources.push(s); }
  clear(): void { this.sources = []; }
  get count(): number { return this.sources.length; }

  private gather(): SmokeSphere[] {
    const out = this.buf;
    out.length = 0;
    for (let i = this.sources.length - 1; i >= 0; i--) if (!this.sources[i].collect(out)) this.sources.splice(i, 1);
    return out;
  }

  /** 0..1 light getting through from `a` to `b` */
  transmittance(a: THREE.Vector3, b: THREE.Vector3): number {
    if (!this.sources.length) return 1;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-6) return 1;
    const ux = dx / L, uy = dy / L, uz = dz / L;
    let T = 1;
    for (const s of this.gather()) {
      if (s.a <= 0 || s.r <= 0) continue;
      const ox = s.x - a.x, oy = s.y - a.y, oz = s.z - a.z;
      const t = ox * ux + oy * uy + oz * uz;
      const d2 = ox * ox + oy * oy + oz * oz - t * t;
      if (d2 >= s.r * s.r) continue;
      const h = Math.sqrt(s.r * s.r - d2);
      const t0 = Math.max(0, t - h), t1 = Math.min(L, t + h);
      if (t1 <= t0) continue;
      T *= 1 - Math.min(1, s.a) * ((t1 - t0) / (2 * s.r));
      if (T < 1e-3) return 0;
    }
    return T;
  }

  blocks(a: THREE.Vector3, b: THREE.Vector3): boolean {
    return this.transmittance(a, b) < SmokeField.BLOCK_T;
  }
}

/** every smoke cloud of the scene (WeaponEffects registers them, bots read them) */
export const smokeField = new SmokeField();

// ---- C5 ------------------------------------------------------------------------------------------------------------

/** WeaponBombTrigger::OnFire 0x642340: the planted C5 are flagged once the press is 0.05 s old */
export const C5_TRIGGER_DELAY = 0.05;
