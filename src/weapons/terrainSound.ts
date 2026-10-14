// I3_TERRAIN_TYPE -> sound-name suffix: the one table behind footsteps / jump / land (CH_<T>_*), bullet hits (WM_Hit_<T>_*),
// knife hits, grenade bounce, casings (WM_Bullet_<T>_1) and helmet bounce (OB_Helmet_Bound_<T>).
// Source: CGameSoundManager's terrain table (PointBlank.exe 2017): 39 rows (StartTerrainTypeSnd 0x6991b0 rejects type >= 0x27)
// x 26 name pointers (stride 0x68) at file 0x9571c0, strings 0xbaadb0..0xbb1400. Row = I3_TERRAIN_TYPE; slots 0-5 CH_<T>_{Left_1,
// Left_2,Right_1,Right_2,Jump,JumpEnd}, 6 WM_Hit_<T>_1, 8 WM_Shotgun_Hit, 9 WM_Knife_Hit_<T>, 10 WM_Bullet_<T>_1, 12 WM_Throw_Bound_<T>,
// 13 OB_Helmet_Bound_<T>. Steps / hit / bullet use the same name in all 39 rows; knife, bound and helmet differ in the few rows
// listed below. Rows 32-34 (BLOOD / TEMP) name WM_Hit_Human / None: not map shapes, they keep the step name.
import { terrainOfCollider } from "./effects";

/** a map terrain type, or a character ("Human" / "Head": knife and bullet hit on a body) */
export type SoundTerrain = number | "Human" | "Head";

/** CH_<T> / WM_Hit_<T> / WM_Bullet_<T> suffix per I3_TERRAIN_TYPE (row index). Rows 5 SNOW, 10 MARBLE and 12-15 / 21-38 follow the
 * exe table as is (e.g. Snow = Concrete, Water types 6-8 = Water, 20 and 35 = Carpet): no CH_Snow / CH_Marble clip exists. */
const STEP = [
  "Concrete", "Concrete", "Metal", "Ground", "Wood", "Concrete", "Water", "Water", "Water", "Grass", // 0-9
  "Concrete", "Metal", "Concrete", "Metal", "Wood", "Concrete", "Paper_Box", "Glass", "Metal", "Grass", // 10-19
  "Carpet", "Ground", "Ground", "Water", "Grass", "Grass", "Grass", "Glass", "Metal", "Grass", // 20-29
  "Grass", "Metal", "Ground", "Metal", "Metal", "Carpet", "Metal", "Wood", "Metal", // 30-38
];
/** rows whose knife / bound / helmet name is not the step name */
const KNIFE: Record<number, string> = { 19: "Carpet", 25: "Paper_Box", 29: "Carpet", 30: "Carpet" };
const BOUND: Record<number, string> = { 16: "Paper" };
const HELM: Record<number, string> = { 16: "Grass", 20: "Ground", 35: "Ground" };

const DEFAULT = 1; // CONCRETE: props and colliders without a surfaces.json terrain, and a type past the table

/** terrain type of a world collider for sound: its surfaces.json type, CONCRETE for a prop / unknown collider */
export function soundTerrainOf(handle: number | undefined): number {
  return (handle === undefined ? undefined : terrainOfCollider(handle)?.type) ?? DEFAULT;
}

/** the name suffix of a terrain for one sound kind ("step" = CH_*, WM_Hit_*, WM_Bullet_*) */
export function terrainSuffix(t: SoundTerrain | undefined, kind: "step" | "knife" | "bound" | "helm" = "step"): string {
  const i = typeof t === "number" && t >= 0 && t < STEP.length ? t : DEFAULT;
  const step = STEP[i];
  return (kind === "knife" ? KNIFE[i] : kind === "bound" ? BOUND[i] : kind === "helm" ? HELM[i] : undefined) ?? step;
}
