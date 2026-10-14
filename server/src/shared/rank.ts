// Plugin.Core/Utility/RankDomain.cs
export const NO_FAKE_RANK = 255;
const FALLBACK = 50;
export const isValidRank = (r: number) => (r >= 0 && r <= 56) || (r >= 58 && r <= 60) || (r >= 97 && r <= 99) || (r >= 101 && r <= 112);
export const isStaffRank = (r: number) => r === 98 || r === 99;
export const sanitizeRank = (r: number) => (isValidRank(r) ? r : FALLBACK);
export const resolveRank = (real: number, fake: number) => sanitizeRank(fake !== NO_FAKE_RANK ? fake : real);

/** C# (int)Math.Floor(double): NaN/Infinity convert to int.MinValue on x64. */
export function csFloorInt(v: number): number {
  return Number.isFinite(v) ? Math.floor(v) | 0 : -2147483648;
}
