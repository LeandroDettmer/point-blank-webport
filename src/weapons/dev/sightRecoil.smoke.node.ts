// Node smoke: AUG A3 (103037, DotSight _ZoomType 3, WeaponDotLaser) scoped spray vs the exe-2017 sight / laser rules.
//   * CHUD_Scope sprites are placed only in CreateScopeHUD 0x740b40 / SetSniperScope 0x740f80: the overlay is screen
//     fixed; the recoil moves the camera (R.v * CamSyncRate, yaw absolute) behind it.
//   * the red dot seen through the DOTFREE sight is the laser dot (EnableOffDotLaser 0 keeps it while zoomed,
//     0x64c13d) on the weapon target point (0x64c1f6): it sits R.v * (1 - CamSyncRate) above the screen centre, on the
//     bullet's aim ray, and moves smoothly (no clip jitter, same frame as the kick).
//   * laser on by default; the screen crosshair hides while it is on (OnApplyCrosshair 0xa6585f).
//   npx esbuild src/weapons/dev/sightRecoil.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/sr.mjs && node <tmp>/sr.mjs
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { WeaponSystem } from "../WeaponSystem";

const any: any = new Proxy(function () {}, {
  get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : k === "then" ? undefined : any),
  apply: () => any,
  construct: () => any,
  set: () => true,
});
const g = globalThis as any;
g.document = any;
g.window = any;
g.AudioContext = any;
g.innerWidth = 1920;
g.innerHeight = 1080;
g.Image = class { complete = false; naturalWidth = 0; onload: unknown = null; src = ""; };
const PUB = path.resolve("public");
g.fetch = async (url: string) => {
  const p = path.join(PUB, decodeURIComponent(url.replace(/^\//, "")));
  const ok = fs.existsSync(p);
  const buf = ok ? fs.readFileSync(p) : Buffer.alloc(0);
  return { ok, status: ok ? 200 : 404, headers: { get: () => "application/json" }, json: async () => JSON.parse(buf.toString("utf8")), arrayBuffer: async () => buf.buffer };
};

let fails = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`);
};
const DEG = Math.PI / 180;

(async () => {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  // a wall 25 m ahead (the camera looks down -Z)
  world.createCollider(RAPIER.ColliderDesc.cuboid(200, 200, 0.5).setTranslation(0, 0, -25), world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
  world.step();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 300);
  camera.position.set(0, 1.6, 0);
  scene.add(camera);
  // the player: pitch / yaw, posed at the start of every frame; applyLook re-poses the camera at once (game.ts)
  const look = { p: 0, y: 0 };
  const pose = () => { camera.rotation.set(look.p, look.y, 0, "YXZ"); camera.updateMatrixWorld(); };
  const ws = new WeaponSystem({
    scene, camera, world, RAPIER, viewmodel: false, audioListener: any, resolveTarget: () => null, loadout: { primary: 103037 },
    applyLook: (dp, dy) => { look.p += dp; look.y += dy; pose(); },
    getYaw: () => look.y,
  });
  await ws.ready;
  ws.setLoadout({ primary: 103037 });
  ws.switchTo(0);
  const W = ws as any;
  // the laser ray: record what the dot is cast along
  const L = W.laser;
  const ray0 = L.ray;
  let lastHit = null as THREE.Vector3 | null;
  const lastDir = new THREE.Vector3();
  L.ray = (o: THREE.Vector3, d: THREE.Vector3, max: number) => { lastDir.copy(d); return (lastHit = ray0(o, d, max)); };

  const dt = 1 / 60;
  const frame = (input: { fire?: boolean; aim?: boolean }) => { pose(); lastHit = null; ws.update(dt, { fire: !!input.fire, aim: !!input.aim }); };
  for (let i = 0; i < 90; i++) frame({}); // draw (Change state)
  check("AUG A3 in hand", ws.getHudState().name.includes("AUG"), ws.getHudState().name);
  check("laser on by default for a WeaponDotLaser weapon", L.enabled && ws.getHudState().laserOn === true);
  // zoom (RMB is a press toggle) and wait for the 0.15 s FOV blend
  frame({ aim: true });
  for (let i = 0; i < 20; i++) frame({});
  check("scoped: DotSight overlay up, laser dot kept (EnableOffDotLaser 0)", ws.getHudState().scoped && ws.getHudState().laserOn === true && !!lastHit);

  const camSync = W.slots[W.cur].def.params.recoil.camSyncRate as number;
  const tanHalf = Math.tan((camera.fov / 2) * DEG);
  const rows: string[] = [];
  let maxErr = 0, maxX = 0, maxStep = 0, prevY: number | null = null, shots = 0, frames = 0, bulletErr = 0;
  const startAmmo = ws.getHudState().ammo;
  const yaw0 = look.y;
  while (shots < 30 && frames < 600) {
    frame({ fire: true });
    frames++;
    shots = startAmmo - ws.getHudState().ammo;
    if (!lastHit) continue;
    const ndc = lastHit.clone().project(camera);
    const extra = (W.recV - W.recoilPitch) * DEG; // aim-bone part the camera does not show
    const want = Math.tan(extra) / tanHalf;
    maxErr = Math.max(maxErr, Math.abs(ndc.y - want));
    maxX = Math.max(maxX, Math.abs(ndc.x));
    if (prevY !== null) maxStep = Math.max(maxStep, Math.abs(ndc.y - prevY));
    prevY = ndc.y;
    const aim = ws.aimRay().dir;
    bulletErr = Math.max(bulletErr, aim.angleTo(lastDir));
    if (frames % 6 === 0) rows.push(`  shot ${String(shots).padStart(2)}  R.v ${W.recV.toFixed(2)} deg  camera ${W.recoilPitch.toFixed(2)} deg  dot ${(ndc.y * 540).toFixed(1)} px above centre (1080p)  yaw ${(look.y / DEG).toFixed(2)} deg`);
  }
  console.log(rows.join("\n"));
  check("30 shots fired while scoped", shots >= 30, `${shots} shots / ${frames} frames`);
  check("dot = R.v * (1 - CamSyncRate) above the centre, same frame as the kick", maxErr < 2e-3, `max err ${(maxErr * 540).toFixed(2)} px, CamSyncRate ${camSync}`);
  check("dot stays on the vertical centre line (yaw recoil turns the camera itself)", maxX < 2e-3, `max |x| ${(maxX * 960).toFixed(2)} px`);
  check("dot ray = the bullets' aim ray (weapon target point)", bulletErr < 1e-6, `${bulletErr.toExponential(1)} rad`);
  check("no jitter: dot moves < 12 px per frame at 1080p", maxStep * 540 < 12, `max step ${(maxStep * 540).toFixed(2)} px`);
  // release: the recoil comes back and the dot returns to the centre. A 10 deg mouse turn right after the release
  // stays: the return pulls only the recoil offset ([INFERIDO], WeaponSystem.updateRecoil)
  look.y += 10 * DEG;
  for (let i = 0; i < 180; i++) frame({});
  check("after release the yaw returns to the burst start + the mouse turn (recoil only comes back)",
    Math.abs((look.y - yaw0) / DEG - 10) < 0.5, `${((look.y - yaw0) / DEG - 10).toFixed(2)} deg off`);
  const hitNow = lastHit as THREE.Vector3 | null;
  const back = hitNow ? Math.abs(hitNow.clone().project(camera).y) * 540 : -1;
  check("after release the dot settles back at the centre", back >= 0 && back < 1, `${back.toFixed(2)} px`);
  // B toggles the laser off -> crosshair back (unscoped)
  frame({ aim: true });
  for (let i = 0; i < 20; i++) frame({});
  L.enabled = false;
  frame({});
  check("laser off (B) and unscoped: crosshair back", ws.getHudState().laserOn === false && !ws.getHudState().scoped);

  console.log(fails ? `\n${fails} FAILED` : "\nall ok");
  process.exit(fails ? 1 : 0);
})();
