// Node smoke test for the HUD/scope/laser/surface links added to close out pb-hud + weapon-sights-fx:
//  - scope/DotSight _ZoomType 3 overlay predicate (data.ts params.scope) that drives hud.hideCrosshair
//  - laser BEAM class flag (weaponfx.json .laser) used by remoteActor.ts to always show it on 3PV remotes
//  - per-shape impact surface codes (pb-extract-tools export-surfaces.mjs) resolved through weapons/effects.ts
//
//   npx esbuild src/game/dev/pbLink.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/pbLink.mjs && node <tmp>/pbLink.mjs
import fs from "node:fs";
import path from "node:path";
import { setWeaponFx, sightInfo, weaponFxInfo, type WeaponFxData } from "../../weapons/sights";
import { setSurfaceTable, surfaceForShape } from "../../weapons/effects";

let fails = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`);
};

const ROOT = path.resolve("public/assets");
const fx = JSON.parse(fs.readFileSync(path.join(ROOT, "weapons/fx/weaponfx.json"), "utf8")) as WeaponFxData;
setWeaponFx(fx, path.join(ROOT, "weapons/fx"));

// ---- (1) hideCrosshair: sniper scope AND DotSight _ZoomType 3 both resolve to sightInfo.mode "scope" ----
for (const [id, w] of Object.entries(fx.weapons)) {
  if (w.zoomType === 3 && w.scopePng && (w.fovScope ?? 0) > 0) {
    const info = sightInfo(+id);
    check(`weapon ${id} (ext=${w.ext ?? "?"}) zoomType 3 -> scope overlay`, info?.mode === "scope");
  }
}
const zoomOnly = Object.entries(fx.weapons).find(([, w]) => !w.scopePng && (w.fovZoom ?? 0) > 0);
if (zoomOnly) check(`weapon ${zoomOnly[0]} zoom-only (no scopePng) -> not "scope" mode`, sightInfo(+zoomOnly[0])?.mode !== "scope");

// ---- (4) laser 3PV: weaponFxInfo(id).laser flags the class (WeaponDotLaser / *WithLaser) ----
const laserId = Object.keys(fx.weapons).find((id) => fx.weapons[id].laser);
const noLaserId = Object.keys(fx.weapons).find((id) => !fx.weapons[id].laser);
check("a laser weapon id exists in weaponfx.json", !!laserId);
check(`weapon ${laserId} has laser=true`, !!(laserId && weaponFxInfo(+laserId)?.laser));
check(`weapon ${noLaserId} has laser=false/undefined`, !!(noLaserId && !weaponFxInfo(+noLaserId)?.laser));

// ---- (5) surfaces: NStation + Luxville shapes resolve to distinct, real weaponfx.json suffix codes ----
const REAL_CODES = new Set(["Cm", "Co", "Gl", "Mb", "Me", "Pa", "Pl", "So", "Wo", "Water"]);
for (const map of ["nstation", "luxville"]) {
  const dir = path.join(ROOT, "maps", map);
  const surf = JSON.parse(fs.readFileSync(path.join(dir, "surfaces.json"), "utf8"));
  const col = JSON.parse(fs.readFileSync(path.join(dir, "collision.json"), "utf8"));
  setSurfaceTable(surf);
  const codes = new Set<string>();
  col.shapes.forEach((s: { name: string }, i: number) => {
    const code = surfaceForShape(s.name, i);
    codes.add(code);
    check(`${map} shape[${i}] "${s.name}" -> known suffix code`, REAL_CODES.has(code), code);
  });
  check(`${map} has more than one distinct surface code (real per-material data, not all "Cm")`, codes.size > 1, [...codes].join(","));
  // wrong shapeIndex from another map's table must not silently pass: unknown name + no table -> "Cm" default
  setSurfaceTable(null);
  check("surfaceForShape() with no table loaded falls back to Cm", surfaceForShape("MET_01", 0) === "Cm");
  setSurfaceTable(surf);
}

console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
