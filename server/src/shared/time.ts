// Plugin.Core/Utility/DateTimeUtil.cs. The C# servers run in Docker with TZ=UTC, so "local time" there is UTC;
// config.ts sets process.env.TZ (PB_TZ, default UTC) before any Date is used so both backends write the same
// yyMMddHHmm values.

const p2 = (n: number) => String(n).padStart(2, "0");

/** DateTime.ToString(format) for the formats the servers use (yy, yyyy, MM, dd, HH, mm, ss). */
export function fmtDate(d: Date, format: string): string {
  return format.replace(/yyyy|yy|MM|dd|HH|mm|ss/g, (t) => {
    switch (t) {
      case "yyyy": return String(d.getFullYear()).padStart(4, "0");
      case "yy": return p2(d.getFullYear() % 100);
      case "MM": return p2(d.getMonth() + 1);
      case "dd": return p2(d.getDate());
      case "HH": return p2(d.getHours());
      case "mm": return p2(d.getMinutes());
      default: return p2(d.getSeconds());
    }
  });
}

/** DateTimeUtil.Now(format) as a number (uint.Parse(...)). */
export function nowNum(format: string, d = new Date()): number {
  return Number(fmtDate(d, format));
}

/** new DateTime() (0001-01-01 00:00). */
export const MIN_DATE = (() => { const d = new Date(0); d.setFullYear(1, 0, 1); d.setHours(0, 0, 0, 0); return d; })();

/** DateTimeUtil.Convert: "yyMMddHHmm" or "yyMMdd"; shorter than 6 chars -> "101010"; no match -> new DateTime(). */
export function convertDate(s: string | null | undefined): Date {
  let v = s ?? "";
  if (v.length < 6) v = "101010";
  const two = (i: number) => Number(v.slice(i, i + 2));
  const ok = (d: Date, y: number, mo: number, da: number, h: number, mi: number) =>
    d.getFullYear() === y && d.getMonth() === mo - 1 && d.getDate() === da && d.getHours() === h && d.getMinutes() === mi;
  if ((v.length === 10 || v.length === 6) && /^\d+$/.test(v)) {
    // .NET two-digit year: 00-49 -> 20xx, 50-99 -> 19xx (Calendar.TwoDigitYearMax 2049)
    const yy = two(0), y = yy < 50 ? 2000 + yy : 1900 + yy;
    const mo = two(2), da = two(4), h = v.length === 10 ? two(6) : 0, mi = v.length === 10 ? two(8) : 0;
    const d = new Date(y, mo - 1, da, h, mi, 0, 0);
    if (ok(d, y, mo, da, h, mi) && h < 24 && mi < 60) return d;
  }
  return MIN_DATE;
}
