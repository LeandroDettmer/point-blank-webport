// Node smoke: gameplay round 2 (no browser; DOM/WebAudio stubbed, Rapier real).
//   * hit shake = exe CGameCamera 0x5285e0 only: roll sin(5 phi) k, pitch cos(2 phi) k, no yaw, gone after 0.1 s
//   * scope hide survives the host's per-frame setVisible (game.ts -> PbWeaponsBridge.setVisible)
//   * sniper LoadMag / LoadBullet run on the left hand (weaponAnim.ts leftGrip; K-2 / SSG69 via the 3.123 LEFT_GRIP), AUG does not
//   * sniper sounds: 2017 _FireSound / _SwapSound + AI state events (sfx/pb2017.json)
//   npx esbuild src/weapons/dev/hitShake.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/hs.mjs && node <tmp>/hs.mjs
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { WeaponSystem } from "../WeaponSystem";
import { WeaponAudio } from "../audio";
import { WeaponAnimator, loadWeaponAnimSet } from "../weaponAnim";
import { PB_CAMERA_SHAKE } from "../../gameplay/pbConfig";
import { PbWeaponsBridge } from "../../game/weaponAdapter";
import { TEST_WEAPONS, testInventory } from "../../game/testLoadout";

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
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 300);
  scene.add(camera);
  const ws = new WeaponSystem({ scene, camera, world, RAPIER, viewmodel: false, audioListener: any, resolveTarget: () => null, loadout: {}, applyLook: () => {} });
  await ws.ready;

  // ---- hit shake: CalcHitPoint 0x542d1d SetShake(2, 2, 0, 0.1), applied by 0x5285e0 ----
  const s = PB_CAMERA_SHAKE.hitPoint;
  ws.cameraShake(s);
  const dt = 1 / 120;
  let maxYaw = 0, maxErr = 0, maxRoll = 0, maxPitch = 0, frames = 0, after = 0;
  for (let i = 0; i < 40; i++) {
    const t = i * dt;
    camera.rotation.set(0, 0, 0, "YXZ"); // src/player.ts updateCamera rewrites the rotation every frame
    ws.update(dt, { fire: false, aim: false });
    const phi = t * s.freq * Math.PI + s.phase, k = t < s.time ? (s.amp * (s.time - t)) / s.time : 0;
    const wantR = t < s.time ? Math.sin(5 * phi) * k * DEG : 0, wantP = t < s.time ? Math.cos(2 * phi) * k * DEG : 0;
    maxYaw = Math.max(maxYaw, Math.abs(camera.rotation.y));
    maxErr = Math.max(maxErr, Math.abs(camera.rotation.z - wantR), Math.abs(camera.rotation.x - wantP));
    maxRoll = Math.max(maxRoll, Math.abs(camera.rotation.z));
    maxPitch = Math.max(maxPitch, Math.abs(camera.rotation.x));
    if (t < s.time) frames++;
    else after = Math.max(after, Math.abs(camera.rotation.x) + Math.abs(camera.rotation.z));
  }
  check("hit shake: no yaw (0x5285e0 turns about the at-row and the right axis only)", maxYaw < 1e-9, `yaw ${maxYaw}`);
  check("hit shake: roll = sin(5phi)k, pitch = cos(2phi)k (deg), per frame", maxErr < 1e-6, `err ${maxErr.toExponential(1)}`);
  check("hit shake: <= 2 deg, lasts 0.1 s, then nothing", maxRoll <= 2 * DEG + 1e-9 && maxPitch <= 2 * DEG + 1e-9 && after < 1e-9 && frames === 12,
    `roll ${(maxRoll / DEG).toFixed(2)} pitch ${(maxPitch / DEG).toFixed(2)} deg, ${frames} frames`);

  // ---- scope hide vs the host's per-frame setVisible ----
  const fake = { ws: { viewmodelEnabled: true, viewmodel: { hidden: true, group: { visible: true } } } };
  PbWeaponsBridge.prototype.setVisible.call(fake as unknown as PbWeaponsBridge, true);
  check("setVisible(alive) keeps the scope hide (hidden stays, group hidden)", fake.ws.viewmodel.hidden && !fake.ws.viewmodel.group.visible);
  PbWeaponsBridge.prototype.setVisible.call(fake as unknown as PbWeaponsBridge, false);
  check("setVisible(dead) -> viewmodelEnabled false", !fake.ws.viewmodelEnabled && !fake.ws.viewmodel.group.visible);

  // ---- left-hand reload states ----
  const lh = async (model: string, kind: "reload" | "loadBullet") => {
    const set = await loadWeaponAnimSet(model);
    if (!set) return "noset";
    const a = new WeaponAnimator(new THREE.Group(), set, "1pv");
    a.drive(kind);
    return `${a.stateKey(kind)}:${a.leftHand ? "L" : "R"}`;
  };
  const r = { cheyMag: await lh("cheytac_m200", "reload"), cheyBolt: await lh("cheytac_m200", "loadBullet"), l115: await lh("l115a1", "reload"),
    svd: await lh("svd_dragunov", "reload"), ssg: await lh("ssg69", "reload"), k2: await lh("k_2", "reload"), aug: await lh("aug_a3_gold", "reload") };
  check("left hand: Cheytac LoadMag+LoadBullet, L115A1, SVD LoadMag", [r.cheyMag, r.cheyBolt, r.l115, r.svd].every((x) => x.endsWith(":L")), JSON.stringify(r));
  // the 2017 K-2 / SSG69 packs keep the Idle LHandGunDummy key; weaponAnim.ts LEFT_RELOAD_AI re-keys them to the 3.123 grip
  check("left hand: SSG69, K-2 LoadMag1PV<gender> (3.123 LEFT_GRIP re-key)", [r.ssg, r.k2].every((x) => /^LoadMag1PV(Male|Female):L$/.test(x)));
  check("right hand: AUG A3 Gold (clip keeps the Idle LHandGunDummy)", !r.aug.endsWith(":L"));

  // ---- sounds ----
  const au = new WeaponAudio(scene, camera, "/assets/weapons", any);
  await au.load();
  const db = (ws as any).db;
  const fire = (id: number) => (au as any).fireClip(db.def(id)) as string;
  const snip = [105030, 105005, 105001, 105003, 105002, 105032];
  const fires = snip.map((id) => `${id}:${fire(id)}`);
  check("sniper fire clips: own weapon, never the SSG69 class fallback (except SSG69)",
    snip.every((id) => id === 105003 || !/SSG69/.test(fire(id))) && /WM_CheyTac M200_Fire/.test(fire(105030)), fires.join(" | "));
  check("Cheytac swap = its own WM_CheyTac M200_Chage", /WM_CheyTac M200_Chage/.test(au.swap(db.def(105030)) ?? ""), au.swap(db.def(105030)));
  const ev = au.stateSounds("Weapon_Cheytac", "LoadMag1PVMale");
  check("Cheytac LoadMag1PVMale events: Remove 0.32 / Load 1.19 / ReLoad 1.73 of 3 s",
    !!ev && ev.dur === 3 && ev.ev.map(([, f]) => path.basename(f)).join(",") === "WM_CheyTac M200_Remove.wav,WM_CheyTac M200_Load.wav,WM_CheyTac M200_ReLoad.wav",
    ev?.ev.map(([t, f]) => `${t}:${path.basename(f)}`).join(" "));
  const missing = ev?.ev.filter(([, f]) => !fs.existsSync(path.join(PUB, "assets/weapons/sfx", f))) ?? [];
  check("event wav files exist", missing.length === 0);

  // ---- test inventory ----
  const inv = testInventory();
  const fams = [...new Set(TEST_WEAPONS.primary.map((w) => db.def(w.id)?.family))].join(",");
  const listed = Object.values(TEST_WEAPONS).flat();
  check("test inventory: primaries cover AR/SMG/SR/SG/MG, 1 each melee/grenade/special, every listed weapon in the inventory",
    fams === "AR,SMG,SR,SG,MG" && TEST_WEAPONS.secondary.length > 0 && [TEST_WEAPONS.melee, TEST_WEAPONS.grenade, TEST_WEAPONS.special].every((l) => l.length === 1) &&
    inv.items.length === listed.length && listed.every((w) => inv.items.some((it) => it.itemId === w.id)),
    TEST_WEAPONS.primary.map((w) => `${w.id}:${db.def(w.id)?.family}`).join(" "));
  process.exit(fails ? 1 : 0);
})();
