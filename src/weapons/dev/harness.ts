// Dev-only smoke test for the weapon system: http://localhost:8000/src/weapons/dev/harness.html
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { WeaponSystem, type HitTarget } from "../index";

const log = (s: string) => ((document.getElementById("log")!.textContent += s + "\n"), console.log(s));
(async () => {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x333333, 2));
  const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 500);
  camera.position.set(0, 1.6, 0);
  const renderer = new THREE.WebGLRenderer();
  renderer.setSize(innerWidth, innerHeight);
  document.body.appendChild(renderer.domElement);
  world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.1, 50).setTranslation(0, -0.1, 0));
  const floor = new THREE.Mesh(new THREE.BoxGeometry(100, 0.2, 100), new THREE.MeshStandardMaterial({ color: 0x555555 }));
  floor.position.y = -0.1; scene.add(floor);
  // thin wall at z=-5 (penetrable), target at z=-10 behind it: head/body colliders
  world.createCollider(RAPIER.ColliderDesc.cuboid(2, 2, 0.05).setTranslation(3, 1, -5));
  const targets = new Map<number, HitTarget>();
  const head = world.createCollider(RAPIER.ColliderDesc.ball(0.15).setTranslation(0, 1.6, -10));
  const body = world.createCollider(RAPIER.ColliderDesc.cuboid(0.25, 0.4, 0.15).setTranslation(0, 1.0, -10));
  const walled = world.createCollider(RAPIER.ColliderDesc.cuboid(0.25, 0.4, 0.15).setTranslation(3, 1.6, -8));
  targets.set(head.handle, { hitzone: "head", id: "bot", hasHelmet: true });
  targets.set(body.handle, { hitzone: "body", id: "bot" });
  targets.set(walled.handle, { hitzone: "body", id: "bot2" });
  const ws = new WeaponSystem({ scene, camera, world, RAPIER, resolveTarget: (c) => targets.get(c.handle) ?? null });
  const hits: string[] = [];
  ws.onHit((h) => h.target && hits.push(`${h.kind}:${h.target.id}:${h.zone}:${h.damage}:pen${h.penetrated}`));
  ws.onSwitch((e) => log(`switch -> ${e.to.name} (${e.to.family})`));
  ws.onReload((e) => e.phase !== "shell" && log(`reload ${e.phase} ${e.ammo}/${e.reserve}`));
  await ws.ready;
  log(`ready db=${ws.db.all().length} hud=${JSON.stringify(ws.getHudState().slots.map((s) => s.name + " " + s.ammo + "/" + s.reserve))}`);
  const dt = 1 / 60;
  const step = (n: number, inp: object) => { for (let i = 0; i < n; i++) { world.step(); ws.update(dt, { fire: false, aim: false, grounded: true, ...inp }); renderer.render(scene, camera); } };
  const look = (x: number, y: number, z: number) => { camera.rotation.set(0, 0, 0); camera.lookAt(x, y, z); };
  // 1) AR headshot (helmet) then body, semi taps
  look(0, 1.6, -10); step(1, { fire: true }); step(20, {}); log(`AR head: ${hits.splice(0).join(" ")}`);
  look(0, 1.0, -10); step(1, { fire: true }); step(20, {}); log(`AR body: ${hits.splice(0).join(" ")}`);
  // penetration through thin wall
  look(3, 1.6, -8); step(1, { fire: true }); step(20, {}); log(`AR through wall: ${hits.splice(0).join(" ")}`);
  // spray: recoil climbs
  look(0, 1.0, -10); const p0 = camera.rotation.x; step(30, { fire: true }); log(`spray ammo=${ws.getHudState().ammo} recoil=${((camera.rotation.x - p0) * 57.3).toFixed(2)}deg spread=${ws.getHudState().spreadDeg.toFixed(2)} hits=${hits.length}`); hits.length = 0;
  step(120, { reload: true }); step(200, {}); log(`after reload ${ws.getHudState().ammo}/${ws.getHudState().reserve}`);
  step(1, { aim: true }); step(30, { aim: true }); log(`aim fov=${camera.fov.toFixed(1)}`); step(30, {});
  // 2) pistol
  step(1, { slot: 1 }); step(40, {}); look(0, 1.0, -10); step(1, { fire: true }); step(20, {}); log(`HG: ${hits.splice(0).join(" ")} ${ws.getHudState().name}`);
  // 3) knife: move target close
  step(1, { slot: 2 }); step(40, {}); camera.position.set(0, 1.0, -9.2); look(0, 1.0, -10); step(1, { fire: true }); step(20, {});
  step(1, { aim: true }); step(40, {}); log(`KNIFE: ${hits.splice(0).join(" ")}`);
  // 4) grenade
  camera.position.set(0, 1.6, 0); step(1, { slot: 3 }); step(40, {}); look(0, 1.5, -6); step(1, { fire: true }); step(260, {});
  log(`GRENADE: ${hits.splice(0).join(" ")} hud=${ws.getHudState().name}`);
  const t = ws.getHudState(); log(`final slot=${t.slot} ${t.name}`);
  document.title = "DONE";
})().catch((e) => { log("ERR " + (e?.stack ?? e)); document.title = "DONE"; });
