// Node smoke: scope overlay canvas after Kriss S.V. (104013, DotSight sub 4 = dot sprite) -> AUG A3 (103037, sub 5 = no dot).
// Both use scope/dotsight_sg550.png; the redraw cache key ignored the dot, so the Kriss dot stayed painted over the AUG sight.
// Counts the sprites on the canvas (everything drawn since the last clearRect) after each sequence.
//   npx esbuild src/weapons/dev/scopeStale.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/ss.mjs && node <tmp>/ss.mjs
import fs from "node:fs";
import path from "node:path";
import { setWeaponFx, type WeaponFxData } from "../sights";
import { ScopeOverlay } from "../scope";

const g = globalThis as any;
let drawn: string[] = []; // sprites on the canvas now
let canvas: any = null;
const ctx = {
  clearRect: () => { drawn = []; },
  drawImage: (_i: unknown, sx: number, sy: number, sw: number, sh: number) => { drawn.push(`${sx},${sy},${sw}x${sh}`); },
  save() {}, restore() {}, translate() {}, scale() {},
  imageSmoothingEnabled: true,
};
g.document = {
  createElement: () => (canvas = { dataset: {}, style: { cssText: "", display: "none" }, width: 0, height: 0, getContext: () => ctx }),
  body: { appendChild() {} },
};
g.innerWidth = 1920;
g.innerHeight = 1080;
g.Image = class { complete = true; naturalWidth = 512; onload: unknown = null; src = ""; };

const data = JSON.parse(fs.readFileSync(path.resolve("public/assets/weapons/fx/weaponfx.json"), "utf8")) as WeaponFxData;
setWeaponFx(data, "/assets/weapons/fx");

const KRISS = 104013, AUG = 103037;
const DOT = "4,773,46x46";
let fails = 0;
const check = (name: string, ok: boolean, info = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`); };
const dots = () => drawn.filter((d) => d === DOT).length;

// Kriss scoped -> swap to AUG scoped
let s = new ScopeOverlay();
s.setWeapon(KRISS); s.setVisible(true);
check("Kriss scoped draws its dot", dots() === 1, `drawn=${drawn.length}`);
s.setVisible(false);
s.setWeapon(AUG); s.setVisible(true);
check("AUG after Kriss: no Kriss dot on the canvas", dots() === 0, `dots=${dots()} drawn=${drawn.join("|")}`);

// AUG -> Kriss restores the dot
s.setVisible(false); s.setWeapon(KRISS); s.setVisible(true);
check("Kriss after AUG: dot back", dots() === 1);

// Kriss scoped -> dual 118001 (no overlay) -> AUG
s.setVisible(false); s.setWeapon(118001); s.setVisible(false); s.setWeapon(AUG); s.setVisible(true);
check("Kriss -> dual -> AUG: no Kriss dot", dots() === 0, `dots=${dots()}`);

// swap while still visible (no hide frame between the weapons)
s = new ScopeOverlay();
s.setWeapon(KRISS); s.setVisible(true); s.setWeapon(AUG); s.setVisible(true);
check("swap while visible: AUG sight has no dot", dots() === 0, `dots=${dots()}`);

console.log(fails ? `${fails} FAIL` : "all ok");
process.exit(fails ? 1 : 0);
