// Decode every .mqf with the C# MissionCardRAW layout; print tasks + prizes. node --experimental-transform-types tools/check-mqf.ts
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
const dir = path.resolve(import.meta.dirname, "../runtime/Data/Missions");
for (const f of readdirSync(dir).filter((x) => x.endsWith(".mqf")).sort()) {
  const b = readFileSync(path.join(dir, f));
  const qt = b.readInt32LE(4);
  let o = 24, bad = 0, lim0 = 0; const tasks: string[] = [];
  const types = new Set<number>();
  for (let i = 0; i < 40; i++) {
    const t = b[o + 2], m = b[o + 3], l = b[o + 4], wc = b[o + 5], wid = b.readUInt16LE(o + 6);
    if (t < 1 || t > 57 || l === 0) bad++;
    if (l === 0) lim0++;
    types.add(t); tasks.push(`${t}/${m}/${l}/${wc}/${wid}`);
    o += 8 + (qt === 1 ? 24 : 0);
  }
  const per = qt === 2 ? 5 : 1, prizes: string[] = [];
  for (let c = 0; c < 10; c++) { prizes.push(`${b.readInt32LE(o)}g/${b.readInt32LE(o + 4)}e/m${b.readInt32LE(o + 8)}`); o += 12 + per * 16; }
  console.log(`${f} size=${b.length} qt=${qt} taskEnd->prizesEnd=${o} (rest ${b.length - o}) badTasks=${bad} types=[${[...types].sort((a, b) => a - b)}]`);
  if (process.argv[2] === "-v") { console.log(" tasks", tasks.join(" ")); console.log(" prizes", prizes.join(" ")); }
  else console.log(" prizes", prizes.join(" "));
}
