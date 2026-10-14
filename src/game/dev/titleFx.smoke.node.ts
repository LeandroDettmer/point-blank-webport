// Title battle effects: Σ per family from the equipped titles (titleData.ts, DesignationValue.pef) + the formulas.
// run: npx esbuild src/game/dev/titleFx.smoke.node.ts --bundle --platform=node --format=esm --outfile=%TEMP%/sm/titleFx.mjs && node %TEMP%/sm/titleFx.mjs
import { TITLES, EFFECT_VALUES, EFFECTS } from "../../lobby/core/titleData.ts";
import { titleFxSum, emptyTitleFx, fxFireDelay, fxPct } from "../../gameplay/titleFx.ts";
import { distanceRate } from "../damage.ts";

let fail = 0;
const eq = (name: string, got: number, want: number): void => {
  const ok = Math.abs(got - want) < 1e-9;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${got} (want ${want})`);
};
const val = (id: number): number => EFFECT_VALUES[EFFECTS[id][1]];

// title 5 (set 5): Plus 71 Weapon_Reaction_Control_1 -4, Minus 161 DPD_Rate_Minus_1 +10
let fx = titleFxSum([5]);
eq("t5 reactionControl", fx.reactionControl, val(71));
eq("t5 dpd", fx.dpd, val(161));
// title 6 (set 6): Plus 76 DPD_Rate_Plus_1 -10, Minus 141 Fire_Speed_Minus_1 +0.001
fx = titleFxSum([6]);
eq("t6 dpd", fx.dpd, val(76));
eq("t6 fireSpeed", fx.fireSpeed, val(141));
// title 7 (Gunner, set 7): Plus 6 Fire_Speed_Plus_1 -0.001, Minus 156 Weapon_Reaction_Control_Minus_1 +4
fx = titleFxSum([7]);
eq("t7 fireSpeed", fx.fireSpeed, -0.001);
eq("t7 reactionControl", fx.reactionControl, 4);
// Σ over slots, Plus and Minus in the same accumulator: titles 5 + 6 + 7
fx = titleFxSum([5, 6, 7]);
eq("5+6+7 dpd (+10 -10)", fx.dpd, 0);
eq("5+6+7 fireSpeed (+0.001 -0.001)", fx.fireSpeed, 0);
eq("5+6+7 reactionControl (-4 +4)", fx.reactionControl, 0);
// every Plus/Minus effect id of every title maps to a family or is a known character/dead one
const known = /^(Move_|Jump_|AddSpeed_|FallDown_|Reload_|Horizontal_|Vertical_)/;
let unmapped = 0;
for (const t of TITLES) for (const e of [...t.plus, ...t.minus]) {
  const k = EFFECTS[e]?.[1];
  if (!k) { unmapped++; continue; }
  const f = titleFxSum([t.id]);
  if (Object.values(f).every((v) => v === 0) && !known.test(k) && EFFECT_VALUES[k] !== 0) { unmapped++; console.log("unmapped", t.id, k); }
}
eq("unmapped effects", unmapped, 0);
// formulas
eq("empty fx = no change", fxFireDelay(0.075, emptyTitleFx()), 0.075);
eq("fire delay + Σ", fxFireDelay(0.075, { ...emptyTitleFx(), fireSpeed: -0.003 }), 0.072);
eq("fire delay clamp 0.06", fxFireDelay(0.061, { ...emptyTitleFx(), fireSpeed: -0.005 }), 0.06);
eq("deviation x(1-0.09)", 1 * fxPct(-9), 0.91);
eq("recoil max x(1-0.12)", 10 * fxPct(-12), 8.8);
eq("DPD slope: -30% title", distanceRate(50, 100, 0.5, 0.01 * -30), 1 - 0.5 * 0.5 * 0.7);
eq("DPD no title", distanceRate(50, 100, 0.5), 0.75);
console.log(fail ? `${fail} FAILED` : "titleFx smoke ok");
process.exit(fail ? 1 : 0);
