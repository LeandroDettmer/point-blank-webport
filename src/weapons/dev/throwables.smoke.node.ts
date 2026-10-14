// Node smoke test: PB 2017 throwables on the real WeaponSystem (no browser: DOM/WebAudio stubbed, Rapier real, the
// 2017 weaponfx.json particles real). FlashBang intensity (front / side / back / behind a wall, exe 0x825b50) and its
// white-screen timeline (0x824f60), SmokeGrenade cloud blocking a bot sight line for its i3 particle life, C-5 PBWC2016
// (407053) thrown, stuck, detonated by the bomb trigger 0.05 + 0.5 s later with radius damage, key 5 = special slot,
// and the 2017 id remap of the C5 model / icon / 1PV AI.
//   npx esbuild src/weapons/dev/throwables.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/th.mjs && node <tmp>/th.mjs
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { WeaponSystem } from "../WeaponSystem";
import { kitLands } from "../grenade";
import { setFxTextureLoader } from "../effects";
import { setWeaponFx } from "../sights";
import {
  FlashScreen, flashDuration, localFlash, onFlashbang, pack2017Id, smokeField, throwKind, type FlashBurst,
} from "../throwables";
import { ai1pvFor } from "../viewmodel";
import type { FireEvent, HitEvent } from "../types";
import { PB_KEYS, slotPressed } from "../../game/keymap";

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
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(PUB, rel), "utf8"));
g.fetch = async (url: string) => {
  const p = path.join(PUB, url.replace(/^\//, ""));
  if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  const buf = fs.readFileSync(p);
  return { ok: true, status: 200, json: async () => JSON.parse(buf.toString("utf8")), arrayBuffer: async () => buf.buffer };
};

let fails = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`);
};
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps;

(async () => {
  // ---- exe formulas ----
  // FlashBang pef: EffectiveTime 10, Explosion_Range 10, Explosion_EffectiveSlope 0.8; dot term of 0x825d13
  check("flash 2 m in front: 10 * (1 - 0.8*2/10) = 8.4 s", near(flashDuration(10, 10, 0.8, 2, 1), 8.4));
  check("flash 2 m, dot 0.3 (still 'front': 17 < 70) = 8.4 s", near(flashDuration(10, 10, 0.8, 2, 0.3), 8.4));
  check("flash 2 m to the side (dot 0 -> 90) = x0.5 = 4.2 s", near(flashDuration(10, 10, 0.8, 2, 0), 4.2));
  check("flash 2 m behind (dot -1 -> 147) = x0.25 = 2.1 s", near(flashDuration(10, 10, 0.8, 2, -1), 2.1));
  check("flash at the range edge: rate floor 0.00002", near(flashDuration(10, 10, 0.8, 12.5, 1), 10 * 0.00002, 1e-9));
  const fs0 = new FlashScreen();
  fs0.start(8.4);
  const at = (t: number) => { let n = 0; while (n < Math.round(t * 60)) { fs0.update(1 / 60); n++; } return fs0.alpha; };
  const a025 = at(0.25), a075 = at(0.5), a3 = at(2.25);
  const aEnd = at(8.4 - 3 + 0.3), cleared = (at(1.2), !fs0.active);
  check("white screen: fade-in 0.5 s, 255 until 1 s, 105..255 pulse, fades out and clears",
    a025 > 110 && a025 < 145 && a075 === 255 && a3 >= 105 && a3 <= 255 && aEnd < 255 && cleared, `${a025} ${a075} ${a3} ${aEnd} ${cleared}`);

  // ---- world: floor + wall at z = -5, observer at the origin looking -Z ----
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.1, 50).setTranslation(0, -0.1, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(4, 3, 0.2).setTranslation(0, 3, -5.2));
  const target = world.createCollider(RAPIER.ColliderDesc.capsule(0.6, 0.3).setTranslation(1.2, 0.9, -3.8));
  const far = world.createCollider(RAPIER.ColliderDesc.capsule(0.6, 0.3).setTranslation(-2, 0.9, 12));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 300);
  camera.position.set(0, 1.6, 0);
  scene.add(camera);
  camera.updateMatrixWorld();
  setFxTextureLoader(() => new THREE.Texture());
  setWeaponFx(readJson("assets/weapons/fx/weaponfx.json"), "/assets/weapons/fx");
  const ws = new WeaponSystem({
    scene, camera, world, RAPIER, viewmodel: false, audioListener: any, loadout: {},
    resolveTarget: (c) => (c.handle === target.handle ? { hitzone: "body", id: "T" } : c.handle === far.handle ? { hitzone: "body", id: "F" } : null),
  });
  await ws.ready;
  const dt = 1 / 60;
  const step = (n = 1, inp: object = {}) => {
    for (let i = 0; i < n; i++) { world.step(); ws.update(dt, { fire: false, aim: false, grounded: true, ...inp }); camera.updateMatrixWorld(); }
  };
  const bursts: FlashBurst[] = [];
  onFlashbang((f) => bursts.push(f));

  // ---- FlashBang through WeaponSystem (replicated-throw path: explodes at the pef Explosion_Time) ----
  const flashAt = (p: THREE.Vector3): number => {
    localFlash.clear();
    ws.spawnGrenade(508002, p, new THREE.Vector3(), 0.02, false);
    step(3);
    return localFlash.total;
  };
  const fl = ws.db.def(508002)!;
  check("508002 FlashBang: kind flash, EffectiveTime 10, range 10", throwKind(fl) === "flash" && fl.params.explosionRadius === 10 && fl.pb?.grenade?.effectiveTime === 10);
  const dFront = flashAt(new THREE.Vector3(0, 1.6, -3));
  const dBack = flashAt(new THREE.Vector3(0, 1.6, 3));
  const dSide = flashAt(new THREE.Vector3(3, 1.6, 0));
  const dWall = flashAt(new THREE.Vector3(0, 1.6, -7));
  const dFar = flashAt(new THREE.Vector3(0, 1.6, 11));
  check("flash 3 m in front -> 7.6 s white", near(dFront, 10 * (1 - 0.8 * 0.3), 0.05), dFront.toFixed(3));
  check("flash 3 m behind -> 1/4 = 1.9 s", near(dBack, 7.6 * 0.25, 0.05), dBack.toFixed(3));
  check("flash 3 m to the side -> 1/2 = 3.8 s", near(dSide, 7.6 * 0.5, 0.05), dSide.toFixed(3));
  check("flash 7 m ahead behind the wall -> 0 (world line blocked)", dWall === 0, dWall.toFixed(3));
  check("flash 11 m away (range 10) -> 0", dFar === 0);
  check("every flash reaches the bots' listener (5 bursts, range/slope/EffectiveTime of the pef)",
    bursts.length === 5 && bursts.every((b) => b.range === 10 && b.slope === 0.8 && b.effTime === 10), `${bursts.length}`);
  localFlash.clear();

  // ---- SmokeGrenade: Exp_Sm_01 particles block the bot sight line ----
  smokeField.clear();
  const sm = ws.db.def(508001)!;
  check("508001 SmokeGrenade: kind smoke, fuse 1 s (Explosion_Time)", throwKind(sm) === "smoke" && sm.params.fuse === 1);
  const eye = new THREE.Vector3(-3, 1.6, 4), tgt = new THREE.Vector3(3, 1.4, 4);
  ws.spawnGrenade(508001, new THREE.Vector3(0, 0.3, 4), new THREE.Vector3(), 0.02, false);
  step(3);
  check("smoke cloud registered", smokeField.count === 1);
  const samples: string[] = [];
  let firstBlock = -1, lastBlock = -1, t = 0.05;
  for (let i = 0; i < 16 * 60; i++) {
    step(1);
    t += dt;
    const blocked = smokeField.blocks(eye, tgt);
    if (blocked && firstBlock < 0) firstBlock = t;
    if (blocked) lastBlock = t;
    if (i % 120 === 0) samples.push(`${t.toFixed(1)}s:T=${smokeField.transmittance(eye, tgt).toFixed(2)}`);
  }
  check("smoke blocks the 6 m sight line through it within 1 s", firstBlock > 0 && firstBlock < 1, `first ${firstBlock.toFixed(2)} s`);
  // SmokeCon/Disc layers: life 13 s each, emitted every 0.2 s up to maxCount 3-4 (last one at ~0.6 s)
  check("smoke still blocks at 8 s, gone with its last particle (13 s life + 0.6 s emission)", lastBlock > 8 && lastBlock < 13.7 && smokeField.count === 0,
    `last ${lastBlock.toFixed(2)} s, ${samples.join(" ")}`);
  const side = smokeField.transmittance(new THREE.Vector3(-3, 1.6, 12), new THREE.Vector3(3, 1.4, 12));
  check("a sight line 8 m beside the cloud is clear", side === 1);

  // ---- round start: PreStartRound 0x66fa00 + i3EffectManager::Reset (0x7690c9) take the live cloud and thrown items away ----
  ws.spawnGrenade(508001, new THREE.Vector3(0, 0.3, 4), new THREE.Vector3(), 0.02, false);
  step(60);
  const fxBefore = ws.effects.scene.children.length;
  ws.spawnGrenade(508001, new THREE.Vector3(0, 0.3, 6), new THREE.Vector3(), 5, false); // one still in the air / on the floor
  step(1);
  const cloudUp = smokeField.blocks(eye, tgt);
  ws.resetRound();
  step(1);
  check("round reset: the smoke cloud is gone at once (it no longer blocks), the cloud and the grenade on the floor leave the scene",
    cloudUp && !smokeField.blocks(eye, tgt) && smokeField.count === 0
      && ws.effects.scene.children.length < fxBefore, `blocked before ${cloudUp}, children ${fxBefore} -> ${ws.effects.scene.children.length}`);

  // ---- C-5 PBWC2016 (407053) ----
  const c5 = ws.db.def(407053);
  check("407053 resolves (weapons.json lacks it): C5 class, Explosion_Time 0.5, Throw_Speed 10, Range 6, damage 60",
    !!c5 && throwKind(c5) === "c5" && c5.params.fuse === 0.5 && c5.params.throwSpeed === 10 && c5.params.explosionRadius === 6 && c5.params.damage === 60,
    c5 ? `${c5.name} ${c5.family} slot ${c5.slot}` : "undefined");
  check("407053 in the 2017 packs = 407056 (C5_PBWC), not 407053 (WaterBomb)", pack2017Id(407053) === 407056);
  const models = readJson("assets/weapons/models/index.json").weapons as { id: string; itemIds?: number[] }[];
  const m = models.find((e) => e.itemIds?.includes(pack2017Id(407053)));
  check("C5 PBWC model -> c5_pbwc2016.glb", m?.id === "c5_pbwc2016", m?.id);
  const ix = readJson("assets/chars/swat_male/anim1pv/index.json");
  check("1PV AI: 407053 -> Throwing/C5 (Attack_B throw), 508002 -> Throwing/FlashBang (AttackC)",
    ai1pvFor(ix, c5!) === "Throwing/C5" && ai1pvFor(ix, fl) === "Throwing/FlashBang", `${ai1pvFor(ix, c5!)} ${ai1pvFor(ix, fl)}`);
  const cross = readJson("assets/ui/cross/icons/index.json").icons;
  check("inventory icon (Cross set, server ids): 407053 -> C5_PBWC cell, 407004 -> K-413, 508002 -> FlashBang cell",
    cross["407053"]?.name === "C5_PBWC" && cross["407004"]?.name === "K-413" && cross["508002"]?.name === "FlashBang");

  const hits: HitEvent[] = [], fires: FireEvent[] = [];
  ws.onHit((e) => hits.push(e));
  ws.onFire((e) => fires.push(e));
  camera.position.set(0, 1.6, 0);
  camera.rotation.set(0, 0, 0);
  camera.updateMatrixWorld();
  ws.equip(407053);
  step(1, { slot: 3 });
  step(60);
  check("C5 in the throwing slot (key 4), current", ws.getHudState().slot === 3 && ws.current()?.id === 407053);
  // the hand holds the bomb trigger: RMB throws a C5, LMB presses the trigger (WeaponSystem.ts updateGrenade, kind "c5")
  step(1, { aim: true });
  step(60);
  check("C5 thrown on RMB (fire kind throw), planted, not exploded, hand keeps the trigger",
    fires.some((f) => f.kind === "throw" && f.weapon.id === 407053) && ws.plantedC5() === 1 && hits.length === 0 && ws.current()?.id === 407053,
    `planted ${ws.plantedC5()} cur ${ws.current()?.id}`);
  step(120);
  check("C5 never goes off by itself (2 s later)", hits.length === 0 && ws.plantedC5() === 1);
  let tExp = -1, tt = 0;
  step(1, { fire: true });
  for (let i = 0; i < 90 && tExp < 0; i++) { step(1); tt += dt; if (hits.length) tExp = tt; }
  const hT = hits.find((h) => (h.target as { id?: string } | null)?.id === "T");
  check("trigger -> explosion 0.05 + 0.5 s later", tExp > 0.5 && tExp < 0.6 + 2 * dt, `${tExp.toFixed(3)} s`);
  check("C5 explosion damages the target 1.5 m away, not the one 17 m away",
    !!hT && hT.kind === "explosion" && hT.damage > 0 && !hits.some((h) => (h.target as { id?: string } | null)?.id === "F"),
    hT ? `dmg ${hT.damage} at ${hT.distance.toFixed(2)} m` : "no hit");
  const blastIds = new Set(hits.filter((h) => h.kind === "explosion").map((h) => h.shot));
  check("every hit of one blast carries the same id (one death packet: 2+ kills = Mass Kill, killmarks.ts ShotKills)",
    blastIds.size === 1 && typeof [...blastIds][0] === "number", [...blastIds].join(","));
  step(40);
  check("after the detonation the empty C5 slot gives way", ws.plantedC5() === 0 && ws.getHudState().slot !== 3, `slot ${ws.getHudState().slot}`);

  // ---- key 5: special slot equips the FlashBang and throws it ----
  check("key map: 1-6 are the usage slots (exe slots 13-18)", PB_KEYS.slots.join() === "Digit1,Digit2,Digit3,Digit4,Digit5,Digit6");
  check("Digit5 -> slot index 4", slotPressed({ key: () => false, keyPressed: (c) => c === "Digit5" }) === 4);
  ws.setLoadout({ primary: 103037, secondary: 202022, melee: 301001, grenade: 407001, special: 508002 });
  step(60);
  step(1, { slot: 4 });
  step(40);
  check("key 5 draws the FlashBang", ws.current()?.id === 508002 && ws.getHudState().slot === 4, `${ws.current()?.name}`);
  // an owned special with no Cross throwable row (528006, hidden by 067) and an empty special both fall back to FlashBang
  const slot5 = () => (ws as unknown as { slots: ({ def: { id: number } } | null)[] }).slots[4]?.def.id;
  ws.setLoadout({ primary: 103037, secondary: 202022, melee: 301001, grenade: 407001, special: 528006 });
  check("hidden owned special 528006 -> slot 5 = FlashBang 508002", slot5() === 508002, `${slot5()}`);
  ws.setLoadout({ primary: 103037, secondary: 202022, melee: 301001, grenade: 407001, special: 0 });
  check("empty special -> slot 5 = FlashBang 508002", slot5() === 508002, `${slot5()}`);
  ws.setLoadout({ primary: 103037, secondary: 202022, melee: 301001, grenade: 407001, special: 508002 });
  camera.rotation.set(0, Math.PI, 0); // face +Z (open side)
  camera.updateMatrixWorld();
  const nb = bursts.length;
  fires.length = 0;
  step(1, { fire: true });
  // WeaponGrenade::OnUpdate 0x630830: the fuse only runs once the grenade has (nearly) stopped (speed < 0.2)
  step(90);
  const early = bursts.length - nb;
  step(240);
  check("FlashBang thrown and went off its 1 s fuse after coming to rest (not 1 s after the throw)", early === 0 && fires.some((f) => f.kind === "throw" && f.weapon.id === 508002) && bursts.length === nb + 1,
    `bursts at 1.5 s: ${early}, at 5.5 s: ${bursts.length - nb}`);

  // ---- Medical Kit (WeaponMedicalKit 0x66ac10): lands where it hits, lasts Explosion_Time, one heal of Damage HP then it is gone ----
  check("kitLands: other terrain always, GROUND / CLOTH only on a floor (n.y > 0.1)", kitLands(1, 0) && kitLands(undefined, 0) && kitLands(3, 0.5) && !kitLands(3, 0.05) && !kitLands(20, -1));
  ws.setLoadout({ primary: 103037, secondary: 202022, melee: 301001, grenade: 407001, special: 528001 });
  step(60);
  step(1, { slot: 4 });
  step(40);
  check("slot 5 draws the Medical Kit", ws.current()?.id === 528001, `${ws.current()?.name}`);
  const healed: number[] = [];
  let bodyAt: { feet: THREE.Vector3; headY: number } | null = null;
  ws.onHeal = (n) => healed.push(n);
  ws.healBody = () => bodyAt;
  step(90);
  camera.rotation.set(0, Math.PI, 0);
  camera.updateMatrixWorld();
  step(1, { fire: true });
  step(150);
  const kit = (ws as any).grenades.live.find((g: any) => g.kit);
  check("the kit lies still after landing and is not gone yet (zone = Explosion_Time 10 s)", !!kit && (kit.stuck || kit.resting) && kit.fuse > 5, `fuse ${kit?.fuse?.toFixed(1)}`);
  step(60);
  check("not hurt / nobody near: no heal", healed.length === 0);
  const kp = kit.mesh.position as THREE.Vector3;
  bodyAt = { feet: new THREE.Vector3(kp.x + 0.3, kp.y - 0.3, kp.z), headY: kp.y + 1.4 };
  step(10);
  check("hurt character within 0.5 m (Cross Explosion_Range): one heal of the pef Damage (40) and the kit is destroyed", healed.length === 1 && healed[0] === 40 && !(ws as any).grenades.live.some((g: any) => g.kit), `${healed.join()}`);
  step(120);
  check("no second heal (the kit is gone)", healed.length === 1);

  // ---- Claymore (ClassMeta WeaponClaymore, 2017 pef: Explosion_Range 5, Explosion_Time 0.8, Detected_Range 3, Damage 65) ----
  const cm = ws.db.def(407023)!;
  check("407023 Claymore: kind mine, range 5, fuse (Explosion_Time) 0.8, damage 65", !!cm && throwKind(cm) === "mine" && cm.params.explosionRadius === 5 &&
    cm.params.fuse === 0.8 && cm.params.damage === 65, cm ? `${cm.name} ${throwKind(cm)}` : "undefined");
  check("Claymore pack id 407023 -> 407040 (Cross pef _Number 40)", pack2017Id(407023) === 407040);
  check("Claymore 1PV AI: 407023 -> Throwing/M18A1_Claymore (Install)", ai1pvFor(ix, cm) === "Throwing/M18A1_Claymore");
  camera.rotation.set(-Math.PI / 2, 0, 0); // look straight down: the install lands at the feet
  camera.updateMatrixWorld();
  ws.equip(407023);
  step(1, { slot: 3 });
  step(60);
  hits.length = 0;
  fires.length = 0;
  step(1, { fire: true }); // no pin: the press installs it (release at AttackTimeA1 - 0.05 s)
  step(60);
  const mine = [...((ws as any).mines as Map<any, { triggered: boolean }>).keys()][0];
  check("Claymore installed on the floor (no pin, fire kind throw), stuck, not triggered",
    fires.some((f) => f.kind === "throw" && f.weapon.id === 407023) && !!mine && mine.stuck === true && (ws as any).mines.get(mine).triggered === false,
    mine ? `stuck ${mine.stuck} y ${mine.mesh.position.y.toFixed(3)}` : "no mine");
  check("Claymore sits on the floor by its back face (0.0513 m up)", !!mine && Math.abs(mine.mesh.position.y - 0.0513) < 0.02, mine ? mine.mesh.position.y.toFixed(3) : "");
  step(180);
  check("no enemy within 3 m (target 4 m away): the Claymore stays quiet for 3 s", hits.length === 0 && (ws as any).mines.get(mine).triggered === false);
  // the install aim was straight down: the cone is moved to the horizontal aim (+X) the enemy stands in (45 deg)
  (ws as any).mines.get(mine).look = new THREE.Vector3(1, 0, 0);
  far.setTranslation({ x: -1.5, y: 0.9, z: 0 }); // behind the cone: quiet
  step(120);
  check("enemy 1.5 m behind the aim (outside the 45 deg cone) does not trigger the Claymore", (ws as any).mines.get(mine).triggered === false);
  far.setTranslation({ x: 1.5, y: 0.9, z: 0 });
  let tBlast = -1, n = 0;
  for (; n < 120 && (ws as any).mines.get(mine).triggered !== true; n++) step(1);
  const tTrig = n, trigged = (ws as any).mines.get(mine).triggered === true;
  for (n = 0; n < 120 && tBlast < 0; n++) { step(1); if (hits.length) tBlast = n; }
  const hF = hits.find((h) => (h.target as { id?: string } | null)?.id === "F");
  check("enemy 1.5 m away triggers the Claymore at once", trigged && tTrig <= 2, `trigger after ${tTrig} frames`);
  check("explosion Explosion_Time 0.8 s (48 frames) after the trigger, not before", tBlast >= 46 && tBlast <= 52, `${tBlast} frames after the trigger check`);
  check("Claymore blast hits the enemy 1.5 m away (explosion, damage > 0)", !!hF && hF.kind === "explosion" && hF.damage > 0,
    hF ? `dmg ${hF.damage} at ${hF.distance.toFixed(2)} m` : "no hit");
  check("the detonated Claymore is gone from the mine list", (ws as any).mines.size === 0);

  // ---- HUD thrown-object warning (Cross CHud 0x744be0, filter 0x7441e0, collectors 0x744950 / 0x744ac0) ----
  {
    const feet = new THREE.Vector3(0, 0, 0), ally = (o: string) => o === "ally";
    const warned = () => ws.grenadesNear(feet, ally);
    const base = warned().length;
    const put = (id: number, x: number, z: number, owner?: string, vel = new THREE.Vector3()) => {
      const gr = ws.spawnGrenade(id, new THREE.Vector3(x, 0.05, z), vel, 99, false)!;
      gr.owner = owner;
      return gr;
    };
    put(407001, 0, -9, undefined, new THREE.Vector3(0, 10, 0));
    check("K-400 in flight raises no warning (flag 2: speed < 0.2)", warned().length === base);
    put(407001, 0, -3);
    put(407002, 2, 0, "enemy");
    put(407001, -2, 0, "ally");
    put(528001, 0, 2);
    put(407012, 0, -2);
    put(407001, 0, 10.5);
    const w = warned().slice(base).map((e) => `${e.indicatorType}@${e.dist.toFixed(1)}`).sort();
    check("own K-400 and enemy C5 at rest warn; ally, medical kit, Decoy (no IndicatorType) and 10.5 m do not",
      w.join(" ") === "C5@2.0 DefaultGrenade@3.0", w.join(" "));
  }

  ws.dispose();
  console.log(fails ? `\n${fails} FAILED` : "\nall ok");
  process.exit(fails ? 1 : 0);
})();
