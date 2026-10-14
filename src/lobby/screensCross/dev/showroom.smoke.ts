// Smoke of the Cross showroom camera (screensCross/showroom.ts) against the exported cameras.json
// (pb-extract-tools export-cross-showroom.mjs): every move of the MoveCamera table starts where the current animation ends and ends
// at the wanted look, and the character (0.453, 0, 0) is on screen for each look (1024x768 projection printed), and on a 1920x1080 window (stretched UI, fixed vertical FOV) it is where the camera projects it.
//   npx --no-install tsx src/lobby/screensCross/dev/showroom.smoke.ts
import fs from "node:fs";
import * as THREE from "three";
import { CHARA_POS, ENDS_AT, FOV, FOV_DEG, MOVE } from "../showroom.ts";

const j = JSON.parse(fs.readFileSync("public/assets/ui/cross/showroom/cameras.json", "utf8")) as { cameras: { name: string; keys: { m: number[] }[] }[] };
const cams = j.cameras;
const posOf = (m: number[]) => new THREE.Vector3(m[12], m[13], m[14]);
const first = (a: number) => posOf(cams[a].keys[0].m), last = (a: number) => posOf(cams[a].keys[cams[a].keys.length - 1].m);
/** where each look's camera rests: the end of the animation that leads to it */
const rest = [last(0), last(1), last(2)];
let fail = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fail++; };

for (let a = 0; a < 7; a++) check(last(a).distanceTo(rest[ENDS_AT[a]]) < 1e-3, `${cams[a].name} ends at look ${ENDS_AT[a]}`);
for (let from = 0; from < 3; from++) for (let to = 0; to < 3; to++) {
  const a = MOVE[from][to];
  if (a < 0) { check(from === to, `look ${from} -> ${to}: stays`); continue; }
  check(first(a).distanceTo(rest[from]) < 1e-3 && ENDS_AT[a] === to, `look ${from} -> ${to}: ${cams[a].name}`);
}
// character on screen at each rest pose (chest and head; Left / Right are closer and crop the legs), 4:3 stage
const cam = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(FOV), 1024 / 768, 1, 1000);
for (const look of [0, 1, 2]) {
  const a = [0, 1, 2][look], m = cams[a].keys[cams[a].keys.length - 1].m;
  new THREE.Matrix4().fromArray(m).decompose(cam.position, cam.quaternion, new THREE.Vector3());
  cam.updateMatrixWorld(true);
  const px = [0, 1.2, 1.8].map((y) => {
    const p = CHARA_POS.clone().setY(y).project(cam);
    return [Math.round((p.x + 1) * 512), Math.round((1 - p.y) * 384)];
  });
  check(px.slice(1).every(([x, y]) => x >= 0 && x <= 1024 && y >= 0 && y <= 768), `look ${look} (${cams[a].name}): feet/chest/head at ${px.map((p) => p.join(",")).join("  ")}`);
}
// full-window canvas (preview.ts) under the stretched UI (Stage stretch: design px = window px / (W/1024, H/768)), camera
// FOV_DEG at the window aspect: the character keeps its 1024x768 design y (same vertical FOV) and its x offset from the
// centre shrinks by (4/3) / aspect, and it stays inside the design box (on screen, next to the windows).
/** design rects (x, y, w, h) of the profile windows, UI_Project_Profile.json absolute: prProfileWin, prDesigzationMyInfoBG */
const PROFILE_RECTS = ((): number[][] => {
  type N = { name?: string; x?: number; y?: number; w?: number; h?: number; children?: N[] };
  const out: number[][] = [];
  const walk = (n: N, px: number, py: number) => {
    const x = px + (n.x ?? 0), y = py + (n.y ?? 0);
    if (n.name === "prProfileWin" || n.name === "prDesigzationMyInfoBG") out.push([x, y, n.w ?? 0, n.h ?? 0]);
    for (const c of n.children ?? []) walk(c, x, y);
  };
  walk((JSON.parse(fs.readFileSync("public/assets/ui/cross/UI_Project_Profile.json", "utf8")) as { root: N }).root, 0, 0);
  return out;
})();
check(PROFILE_RECTS.length === 2, `profile windows ${PROFILE_RECTS.map((r) => r.join(",")).join("  ")}`);
for (const [W, H] of [[1920, 1080], [1024, 768]]) {
  const win = new THREE.PerspectiveCamera(FOV_DEG, W / H, 1, 1000), k = (1024 / 768) / (W / H);
  let worst = 0;
  const at: string[] = [];
  for (const a of [0, 1, 2]) {
    const m = cams[a].keys[cams[a].keys.length - 1].m;
    for (const c of [cam, win]) new THREE.Matrix4().fromArray(m).decompose(c.position, c.quaternion, new THREE.Vector3());
    cam.fov = FOV_DEG; cam.aspect = 1024 / 768;
    for (const c of [cam, win]) { c.updateProjectionMatrix(); c.updateMatrixWorld(true); }
    for (const y of [0, 1.2, 1.8]) {
      const p = CHARA_POS.clone().setY(y).project(cam), q = CHARA_POS.clone().setY(y).project(win);
      const dx = ((q.x + 1) * W / 2) / (W / 1024), dy = ((1 - q.y) * H / 2) / (H / 768);
      const ex = 512 + ((p.x + 1) * 512 - 512) * k, ey = (1 - p.y) * 384;
      worst = Math.max(worst, Math.hypot(dx - ex, dy - ey));
      if (y > 0) { check(dx >= 0 && dx <= 1024 && dy >= 0 && dy <= 768, `window ${W}x${H} look ${a} y ${y}: design px ${dx.toFixed(0)},${dy.toFixed(0)} inside the UI`); at.push(`${dx.toFixed(0)},${dy.toFixed(0)}`); }
      // profile (look 1, CStageReady::ChangeStep 0x513a87): chest / head clear of prProfileWin and prDesigzationMyInfoBG
      if (a === 1 && y > 0) check(!PROFILE_RECTS.some(([x, ry, w, h]) => dx >= x && dx <= x + w && dy >= ry && dy <= ry + h), `window ${W}x${H} profile look 1 y ${y}: ${dx.toFixed(0)},${dy.toFixed(0)} outside the profile windows`);
    }
  }
  check(worst < 0.01, `window ${W}x${H}: chest/head design px ${at.join("  ")} (max err vs projection ${worst.toFixed(4)} px)`);
}
if (fail) { console.error(`${fail} failed`); process.exit(1); }
