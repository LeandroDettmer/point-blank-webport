// Equipped-title battle effects (DesignationSet Plus/Minus effects).:
// CStageBattle::_ApplyDesignation 0x7709b0 -> 0x770d60 sums DesignationValue.pef[<family>_<level>] per family over the 3 slots,
// Minus effects land in the same accumulator as Plus (the pef values already carry the sign). Pure data, no DOM.
import { EFFECTS, EFFECT_VALUES, TITLES } from "../lobby/core/titleData.ts";

/** families that have a battle consumer in the web (the 4 character ones and the dead ones are left out: see the doc) */
export interface TitleFx {
  /** s added to FireDelay (WeaponBase::GetFireDelay 0x616020) */
  fireSpeed: number;
  /** percent: deviation per shot x (1 + 0.01 x n) (GetDeviation 0x616400) */
  hitRate: number;
  /** percent: recoil Max x (1 + 0.01 x n) (0x616280, _ProcessFire 0x7e81c0) */
  reactionControl: number;
  /** percent: DPD slope x (1 + 0.01 x n) (_CalcDistanceRate 0x540690) */
  dpd: number;
  /** added to the crosshair target before the clamp (0x7e7d90) */
  firstShot: number;
  /** m added to the weapon range (GetRange 0x616620) */
  range: number;
  /** m/s added to the throw speed (0x616f20) */
  throwSpeed: number;
  /** s added to Explosion_Time (0x616fd0) */
  bombTime: number;
  /** m added to Explosion_Range (0x617060) */
  bombRange: number;
  // Character fields set once per match by CStageBattle::_ApplyDesignation (chara +0xc98/+0xcbc/+0xcc0/+0xcc4): Player.titleMove
  /** m/s added to the gait speed (GetMoveSpeed 0x544560) */
  move: number;
  /** added to JumpHeight (0xa0ebd0) */
  jump: number;
  /** s added to AccelerationTime (0x7fbbc0) */
  accel: number;
  /** m added to the fall damage min height (0x544720) */
  fall: number;
}
export type TitleFxFamily = keyof TitleFx;

export const emptyTitleFx = (): TitleFx => ({
  fireSpeed: 0, hitRate: 0, reactionControl: 0, dpd: 0, firstShot: 0, range: 0, throwSpeed: 0, bombTime: 0, bombRange: 0,
  move: 0, jump: 0, accel: 0, fall: 0,
});

/** pef value key prefix -> family (Plus / Minus / Reduce / Increase variants share one accumulator) */
const FAMILY: readonly [RegExp, TitleFxFamily][] = [
  [/^Fire_Speed_/, "fireSpeed"], [/^Target_Decl[a-z]*nation_/, "hitRate"], [/^Weapon_Reaction_Control_/, "reactionControl"],
  [/^DPD_Rate_/, "dpd"], [/^First_Shot_Rate_/, "firstShot"], [/^Fire_Range_/, "range"], [/^Throw_Speed_/, "throwSpeed"],
  [/^Bomb_Time_/, "bombTime"], [/^Bomb_Range_/, "bombRange"],
  [/^Move_Ability_/, "move"], [/^Jump_Ability_/, "jump"], [/^AddSpeed_Ability_/, "accel"], [/^FallDown_Damage_/, "fall"],
];

/** Σ per family of the equipped title ids (0 = empty slot): PlusEffect_0/1 + MinusEffect_0/1 of each DesignationSet */
export function titleFxSum(equiped: readonly number[]): TitleFx {
  const fx = emptyTitleFx();
  for (const id of equiped) {
    const d = id >= 1 ? TITLES[id - 1] : undefined;
    if (!d) continue;
    for (const eff of [...d.plus, ...d.minus]) {
      const key = EFFECTS[eff]?.[1];
      if (!key) continue;
      const fam = FAMILY.find(([re]) => re.test(key))?.[1];
      if (fam) fx[fam] += EFFECT_VALUES[key] ?? 0;
    }
  }
  return fx;
}

/** the local player's sum */
export const titleFxLive: TitleFx = emptyTitleFx();
export function setTitleFxLive(equiped: readonly number[]): void { Object.assign(titleFxLive, titleFxSum(equiped)); }

/** GetFireDelay 0x616020: FireDelay + Σ, clamped to [0.06, 3] */
export const fxFireDelay = (base: number, fx: TitleFx = titleFxLive): number => Math.min(3, Math.max(0.06, base + fx.fireSpeed));
/** x(1 + 0.01 Σ) of the Target_Declination / Weapon_Reaction_Control / DPD families */
export const fxPct = (n: number): number => 1 + 0.01 * n;
