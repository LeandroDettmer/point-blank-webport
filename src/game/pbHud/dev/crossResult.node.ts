// End-of-match window (crossFinal.ts) without a browser: PbHud.load reads CROSS_RESULT_JSON with a fetch, and the window is only
// built when that read gives the Result_BG tree. A wrong URL (it was "/assets/cross/...", the file lives in "/assets/ui/cross/")
// made the read 404, so the window never existed and only the blue overlay of the result state showed.
//   node --experimental-transform-types --no-warnings src/game/pbHud/dev/crossResult.node.ts
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

register("../../../lobby/core/test/resolve-ts.mjs", import.meta.url);
const g = globalThis as Record<string, unknown>;
g.window ??= globalThis;
g.location ??= { search: "", hash: "", hostname: "127.0.0.1", protocol: "http:", host: "127.0.0.1:8000" };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, "../../../../public");

const { CROSS_HUD_ATLASES, CROSS_RESULT_JSON, crossResultTree, stampShapes } = await import("../crossFinal.ts") as {
  CROSS_HUD_ATLASES: string[]; CROSS_RESULT_JSON: string; crossResultTree(root: { name: string; children?: unknown[] }): { name: string; children?: { name: string }[] } | undefined;
  stampShapes(winner: 0 | 1 | null): [number, number];
};

let fails = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };

// the fetch URL is served from public/: the file must exist at that path
const file = path.join(PUBLIC, CROSS_RESULT_JSON.replace(/^\/assets\//, "assets/"));
check(fs.existsSync(file), `${CROSS_RESULT_JSON} -> ${path.relative(PUBLIC, file)} exists`);

const root = JSON.parse(fs.readFileSync(file, "utf8")).root;
const tree = crossResultTree(root);
check(!!tree && tree.name === "Result_BG", "Result_BG found in the HUD json");
const names = new Set<string>();
const walk = (n: { name: string; children?: { name: string }[] }) => { names.add(n.name); n.children?.forEach(walk); };
if (tree) walk(tree);
for (const n of ["Result_Confirm", "Result_SelectBar", "TeamBarWin", "TeamBarLose", "Red_Score1", "Blue_Score3", "RedSlot_BG_1", "BlueSlot_BG_8"]) {
  check(names.has(n), `Result_BG has ${n}`);
}

// ResultMark pieces, in image order: 0 VENCEDORES, 1 PERDEDORES, 2 EMPATE (ingame_hud2 atlas rects)
type Img = [string, number, number, number, number, number, number, number, number];
type Node = { name: string; images?: Img[]; children?: Node[] };
const findNode = (n: Node, name: string): Node | undefined => (n.name === name ? n : n.children?.map((c) => findNode(c, name)).find(Boolean));
const stamp = tree && findNode(tree as Node, "TeamResultTop");
const rects = (stamp?.images ?? []).map((i) => `${i[0]}:${i[3]},${i[4]} ${i[5]}x${i[6]}`);
check(JSON.stringify(rects) === JSON.stringify(["ingame_hud2:477,112 317x149", "ingame_hud2:808,0 208x108", "ingame_hud2:815,108 209x110"]), `TeamResultTop pieces VENCEDORES / PERDEDORES / EMPATE (${rects.join(" | ")})`);
check(JSON.stringify(stampShapes(0)) === "[0,1]", "winner FR: VENCEDORES top, PERDEDORES bottom");
check(JSON.stringify(stampShapes(1)) === "[1,0]", "winner CT: PERDEDORES top, VENCEDORES bottom");
check(JSON.stringify(stampShapes(null)) === "[2,2]", "draw: EMPATE on both blocks");

for (const u of CROSS_HUD_ATLASES) {
  const p = path.join(PUBLIC, u.replace(/^\/assets\//, "assets/"));
  check(fs.existsSync(p), `atlas ${u} exists`);
}

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log("crossResult smoke: all ok");
