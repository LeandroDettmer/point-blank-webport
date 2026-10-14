// Node smoke test (no browser): the weapon-fidelity fixes against the 2017 exe on the real WeaponSystem.
//  1. Colt45 202022 fire sound resolves (pef _FireSound WM_COLT_FIRE, encrypted-name pack carved by export-sfx2017)
//  2. knife on a wall: Hit_M9 / Hmk_M9 + WM_Knife_Hit_<terrain>, no tracer, even right after a pistol shot
//  3. grenade: launch from the eye along the camera, P(t) = P0 + D s t - 5 t^2, bounce s' = s (k (d+1) + 0.165),
//     settle at s < 0.15, fuse only while s < 0.2; K-413 (WeaponDualGrenade) throws twice at 0.4 / 1.233 s
//  4. dual: Dual Deagle alternates R/L (right first, reset on reload), one magazine; DualSMG both guns; 1PV + 3PV dual AI
//  5. recoil: 30 shots K-2 / AUG, camera yaw / pitch vs the bullets (exe: the horizontal kick turns the view too)
//   npx esbuild src/weapons/dev/weaponFidelity.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/wf.mjs && node <tmp>/wf.mjs
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { WeaponSystem, dualFire } from "../WeaponSystem";
import { GRENADE, grenadeBounce, grenadeSegmentPos } from "../grenade";
import { setFxTextureLoader } from "../effects";
import { setWeaponFx } from "../sights";
import { isDualGrenade } from "../throwables";
import { loadWeapon1pv, wieldsTwo } from "../viewmodel";
import { aiForWeapon, dualTables, type Anim3pvIndex } from "../../game/charAnimLib";
import { weaponDualFire } from "../worldModel";

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
// GLTFLoader's FileLoader builds a (Node) Request, which needs an absolute url: the 1PV base is http://local/...
g.fetch = async (req: string | { url: string }) => {
  const url = (typeof req === "string" ? req : req.url).replace(/^http:\/\/local/, "");
  const p = path.join(PUB, decodeURIComponent(url.replace(/^\//, "")));
  if (!fs.existsSync(p)) return { ok: false, status: 404, headers: { get: () => "" }, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  const buf = fs.readFileSync(p);
  return { ok: true, status: 200, headers: { get: () => (p.endsWith(".json") ? "application/json" : "") },
    json: async () => JSON.parse(buf.toString("utf8")), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
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
  world.createCollider(RAPIER.ColliderDesc.cuboid(60, 0.1, 60).setTranslation(0, -0.1, 0)); // floor y = 0
  const wall = world.createCollider(RAPIER.ColliderDesc.cuboid(6, 4, 0.2).setTranslation(0, 4, -1.4)); // wall face z = -1.2
  world.step(); // scene queries see the colliders after a step (main.ts steps every frame)
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 300);
  camera.position.set(0, 1.6, 0);
  scene.add(camera);
  const look = { p: 0, y: 0 };
  const pose = () => { camera.rotation.set(look.p, look.y, 0, "YXZ"); camera.updateMatrixWorld(); };
  pose();
  setFxTextureLoader(() => new THREE.Texture());
  setWeaponFx(readJson("assets/weapons/fx/weaponfx.json"), "/assets/weapons/fx");
  const ws = new WeaponSystem({
    scene, camera, world, RAPIER, viewmodel: false, audioListener: any, loadout: {}, resolveTarget: () => null,
    applyLook: (dp, dy) => { look.p += dp; look.y += dy; pose(); },
  });
  await ws.ready;
  const W = ws as any;
  const dt = 1 / 60;
  const frame = (inp: { fire?: boolean; aim?: boolean; slot?: number } = {}) => { pose(); ws.update(dt, { fire: !!inp.fire, aim: !!inp.aim, ...(inp.slot !== undefined ? { slot: inp.slot } : {}) } as any); };
  const idle = (n: number) => { for (let i = 0; i < n; i++) frame(); };

  // ---- 1. Colt45 sound ----
  const colt = ws.db.def(202022)!;
  const fire = W.audio.fireClip(colt) as string | undefined;
  check("Colt45 202022 fire clip = pef WM_COLT_FIRE (2017 pack)", !!fire && /wm_colt_fire\.wav$/i.test(fire) && fs.existsSync(path.join(PUB, "assets/weapons/sfx", fire)), fire);
  const p99 = W.audio.fireClip(ws.db.def(213001)!) as string | undefined;
  check("P99 213001 (also a nameless pack) has a fire clip", !!p99 && /wm_p99_fire/i.test(p99), p99);

  // ---- 2. knife on a wall right after a pistol shot ----
  const played: string[] = [];
  const tracers: number[] = [];
  const E = W.effects;
  const play0 = E.play.bind(E);
  E.play = (name: string, ...a: unknown[]) => { played.push(name); return play0(name, ...a); };
  E.tracer = () => { tracers.push(1); };
  const sounds: string[] = [];
  W.audio.playAt = (f: string | undefined) => { if (f) sounds.push(f); };
  W.audio.play = (f: string | undefined) => { if (f) sounds.push(f); };
  ws.setLoadout({ primary: 103004, secondary: 202022, melee: 301001, grenade: 407001 });
  ws.refill();
  frame({ slot: 1 });
  idle(60);
  frame({ fire: true });
  idle(20);
  check("pistol shot hit the wall with the bullet FX (Hit_Ar_*)", played.some((n) => /^Hit_Ar_/.test(n)), played.slice(0, 3).join(","));
  played.length = 0; tracers.length = 0; sounds.length = 0;
  frame({ slot: 2 });
  idle(60);
  frame({ fire: true });
  idle(40);
  check("knife stab: knife blow + cut mark (Hit_M9 / Hmk_M9), no bullet FX", played.some((n) => /^Hit_M9_/.test(n)) && played.some((n) => /^Hmk_M9_/.test(n)) &&
    !played.some((n) => /_Ar_/.test(n)), played.join(","));
  check("knife stab: no tracer", tracers.length === 0);
  check("knife stab: WM_Knife_Hit_Concrete (terrain table), swing = pef WM_M7_Fire", sounds.some((f) => /wm_knife_hit_concrete/i.test(f)) &&
    sounds.some((f) => /wm_m7_fire/i.test(f)), sounds.join(","));
  W.audio.playAt = () => {};
  W.audio.play = () => {};

  // ---- 2b. knife part: one crosshair line (WeaponKnife::FireCollision 0x634bd0), not a fan ----
  // target 1 m ahead; the head box sticks out in front of the chest, so a +5 deg side ray would reach it before the chest
  const chest = world.createCollider(RAPIER.ColliderDesc.cuboid(0.2, 0.235, 0.12).setTranslation(0, 1.235, -1));
  const head = world.createCollider(RAPIER.ColliderDesc.cuboid(0.1, 0.12, 0.09).setTranslation(0, 1.6, -0.91));
  world.step();
  const resolve0 = W.ctx.resolveTarget;
  W.ctx.resolveTarget = (c: RAPIER.Collider) => c.handle === chest.handle ? { hitzone: "body" } : c.handle === head.handle ? { hitzone: "head" } : null;
  const zones: string[] = [];
  const offHit = ws.onHit((h) => { if (h.kind === "melee") zones.push(h.zone ?? "none"); });
  const stab = (pitch: number) => { look.p = pitch; look.y = 0; pose(); idle(60); frame({ fire: true }); idle(40); return zones.at(-1); };
  zones.length = 0;
  const zChest = stab(Math.atan2(1.42 - 1.6, 0.88));
  zones.length = 0;
  const zHead = stab(0);
  check("knife at 1 m: aim at the chest = body, aim at the head = head", zChest === "body" && zHead === "head", `chest ${zChest} head ${zHead}`);
  offHit();
  W.ctx.resolveTarget = resolve0;
  world.removeCollider(chest, false);
  world.removeCollider(head, false);
  world.step();
  look.p = 0; look.y = 0; pose();

  // ---- 3. grenade ----
  // pure formula: first segment and a floor bounce
  const P0 = new THREE.Vector3(0, 1.6, 0), D = new THREE.Vector3(0, 0.3, -1).normalize(), s0 = 18.5;
  const at05 = grenadeSegmentPos(P0, D, s0, 0.5);
  check("segment: P(0.5) = P0 + D*18.5*0.5 - (0, 5*0.25, 0)", Math.abs(at05.y - (1.6 + D.y * 9.25 - 1.25)) < 1e-9 && Math.abs(at05.z - D.z * 9.25) < 1e-9,
    at05.toArray().map((x) => x.toFixed(3)).join(","));
  const b = grenadeBounce(new THREE.Vector3(0, 0.2, -1), new THREE.Vector3(0, 0, -1.2), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -0.7071, -0.7071), 10);
  const c = new THREE.Vector3(0, -0.2, -0.2).normalize(), r = new THREE.Vector3(c.x, -c.y, c.z);
  const want = 10 * (0.1 * (r.dot(new THREE.Vector3(0, -0.7071, -0.7071)) + 1) + 0.165);
  check("floor bounce: reflect chord, s' = s (0.1 (d+1) + 0.165), P0 = H - 0.05c + 0.05n", Math.abs(b.speed - want) < 1e-4 && b.floor && b.dir.y > 0 &&
    Math.abs(b.p0.y - (0.05 - 0.05 * c.y)) < 1e-6, `s' ${b.speed.toFixed(4)} want ${want.toFixed(4)}`);

  // live throw: level, facing +Z (away from the wall)
  look.p = 0; look.y = Math.PI; pose();
  frame({ slot: 3 });
  idle(60);
  const G = W.grenades;
  const bounces: { t: number; s: number }[] = [];
  const onB0 = (G as any).onBounce;
  (G as any).onBounce = (gg: any, p: THREE.Vector3, surf: string) => { bounces.push({ t: W.time, s: gg.speed }); onB0(gg, p, surf); };
  const eye = camera.getWorldPosition(new THREE.Vector3()), fwd = camera.getWorldDirection(new THREE.Vector3());
  const t0 = W.time;
  frame({ fire: true });
  let gr: any = null, relT = -1;
  for (let i = 0; i < 30 && !gr; i++) { frame(); if (G.live.length) { gr = G.live[0]; relT = W.time - t0; } }
  check("K-400 released at AttackTimeA1 - 0.05 = 0.05 s (+1 frame)", relT > 0 && relT <= 0.05 + 2 * dt + 1e-9, `${relT.toFixed(3)} s`);
  check("launch from the eye along camera forward at Throw_Speed 18.5", !!gr && gr.p0.distanceTo(eye) < 1e-6 && gr.dir.angleTo(fwd) < 1e-6 && Math.abs(gr.speed - 18.5) < 1e-9,
    gr ? `${gr.p0.toArray().map((x: number) => x.toFixed(2))} dir ${gr.dir.toArray().map((x: number) => x.toFixed(2))}` : "none");
  // flight vs formula until the first bounce
  let maxErr = 0, n = 0;
  const p0 = gr.p0.clone(), d0 = gr.dir.clone();
  while (G.live.length && bounces.length === 0 && n < 200) {
    frame(); n++;
    if (bounces.length) break;
    const w = grenadeSegmentPos(p0, d0, 18.5, gr.t);
    maxErr = Math.max(maxErr, w.distanceTo(gr.mesh.position));
  }
  check("flight = P0 + D s t - 5 t^2 until the first bounce", maxErr < 1e-6 && n > 5, `${n} frames, max err ${maxErr.toExponential(1)} m`);
  const tLand = W.time - t0;
  let armedAt = -1, restAt = -1, boomAt = -1;
  const boom0 = (G as any).onExplode;
  (G as any).onExplode = (gg: any, p: THREE.Vector3) => { boomAt = W.time - t0; boom0(gg, p); };
  for (let i = 0; i < 900 && boomAt < 0; i++) {
    frame();
    if (G.live.length) {
      if (armedAt < 0 && G.live[0].speed < GRENADE.armSpeed) armedAt = W.time - t0;
      if (restAt < 0 && G.live[0].resting) restAt = W.time - t0;
    }
  }
  const pos = gr.mesh.position;
  console.log(`     K-400: lands ${tLand.toFixed(2)} s, ${bounces.length} bounce sounds (s: ${bounces.map((x) => x.s.toFixed(2)).join(" ")}), rests ${restAt.toFixed(2)} s at ` +
    `${pos.toArray().map((x: number) => x.toFixed(2)).join(",")}, boom ${boomAt.toFixed(2)} s`);
  check("bounces decay: each s' < s, sound only while s' > 0.5", bounces.every((x, i) => x.s > 0.5 && (i === 0 || x.s < bounces[i - 1].s)));
  check("settles on the floor (y = 0.045)", restAt > 0 && Math.abs(pos.y - 0.045) < 0.02, `y ${pos.y.toFixed(3)}`);
  check("fuse = Explosion_Time 0.9 s counted from speed < 0.2 (not from the throw)", armedAt > 0 && Math.abs(boomAt - (armedAt + 0.9)) < 2 * dt,
    `armed ${armedAt.toFixed(2)} boom ${boomAt.toFixed(2)}`);

  // K-413 dual: one press, two grenades at 0.4 / 1.233
  (G as any).onBounce = onB0;
  ws.setLoadout({ primary: 103004, secondary: 202022, melee: 301001, grenade: 407004 });
  ws.refill();
  frame({ slot: 0 }); idle(40); frame({ slot: 3 }); idle(60);
  check("K-413 is a WeaponDualGrenade", isDualGrenade(407004));
  const spawns: number[] = [];
  const sp0 = G.spawn.bind(G);
  G.spawn = (...a: any[]) => { spawns.push(W.time); return sp0(...a); };
  // the press only pulls the pin (throwReady); the Attack state, and its 0.4 / 1.233 clock, starts on the release
  let t1 = -1;
  const st0 = W.startThrow;
  W.startThrow = function (this: unknown, ...a: unknown[]) { t1 = W.time; return st0.apply(this, a); };
  frame({ fire: true });
  for (let i = 0; i < 120; i++) frame();
  W.startThrow = st0;
  const rel = t1 < 0 ? [] : spawns.map((t) => t - t1);
  check("K-413: one press throws both, at 0.4 and 1.233 s", rel.length === 2 && Math.abs(rel[0] - 0.4) < 2 * dt && Math.abs(rel[1] - 1.233) < 2 * dt,
    rel.map((x) => x.toFixed(3)).join(", "));
  G.spawn = sp0;
  idle(300);

  // ---- 4. dual weapons ----
  check("className -> dual fire: DualHandGun alt, DualSMG both, DualShotgun alt, HandGun none",
    dualFire(ws.db.def(214004)!) === "alt" && dualFire(ws.db.def(118004)!) === "both" && dualFire(ws.db.def(135001)!) === "alt" && dualFire(colt) === null);
  look.y = 0; pose();
  ws.setLoadout({ primary: 103004, secondary: 214004, melee: 301001, grenade: 407001 });
  ws.refill();
  frame({ slot: 1 }); idle(60);
  const sides: string[] = [];
  const ammo: number[] = [];
  for (let i = 0; i < 5; i++) {
    sides.push(W.dualLeft ? "L" : "R");
    frame({ fire: true });
    ammo.push(ws.getHudState().ammo);
    idle(30);
  }
  check("Dual Deagle: R, L, R, L, R (right first), one round per shot from one magazine of 21 (Cross LoadBullet)", sides.join("") === "RLRLR" && ammo.join(",") === "20,19,18,17,16",
    `${sides.join("")} ammo ${ammo.join(",")}`);
  ws.update(dt, { fire: false, aim: false, reload: true } as any);
  idle(260);
  check("after the reload the right gun fires first again", W.dualLeft === false && ws.getHudState().ammo === 21, `ammo ${ws.getHudState().ammo}`);
  ws.setLoadout({ primary: 118004, secondary: 214004, melee: 301001, grenade: 407001 });
  ws.refill();
  frame({ slot: 0 }); idle(60);
  const a0 = ws.getHudState().ammo;
  frame({ fire: true });
  check("Dual Uzi: both guns each shot (2 rounds) [INFERIDO]", a0 - ws.getHudState().ammo === 2, `${a0} -> ${ws.getHudState().ammo}`);
  idle(30);
  // 1PV: dual AI tables merged (Left* / Right* layers)
  const base = "http://local/assets/chars/swat_male/anim1pv";
  const deagle = ws.db.def(214004)!, uzi = ws.db.def(118004)!, bone = ws.db.def(315003)!;
  const pbD = await loadWeapon1pv(base, deagle);
  const pbU = await loadWeapon1pv(base, uzi);
  const idleClip = pbD?.clips.get(pbD.A.Idle.clip);
  const bones = new Set(idleClip?.tracks.map((t) => t.name.split(".")[0]) ?? []);
  check("Dual Deagle 1PV = DualHandGun/DesertEagle, dual, Idle keys both arms", pbD?.ai === "DualHandGun/DesertEagle" && !!pbD?.dual &&
    [...bones].some((b) => /^L_?Hand$/.test(b)) && [...bones].some((b) => /^R_?Hand$/.test(b)), `${pbD?.ai} ${[...bones].filter((b) => /Hand$/.test(b)).join(",")}`);
  check("Dual Deagle states: Attack (right), AttackLeft, AttackBoth, LoadMagazine, Change", !!pbD && ["Attack", "AttackLeft", "AttackBoth", "LoadMagazine", "Change"].every((k) => pbD.clips.get(pbD.A[k]?.clip)),
    pbD ? Object.keys(pbD.A).join(",") : "");
  check("Dual Uzi 1PV = DualSMG/Uzi (dual)", pbU?.ai === "DualSMG/Uzi" && !!pbU?.dual, pbU?.ai);
  check("two models: Dual Deagle / Dual Uzi / BoneKnife (DualKnife) / K-413; not the Colt45",
    wieldsTwo(deagle, pbD) && wieldsTwo(uzi, pbU) && wieldsTwo(bone, null) && wieldsTwo({ id: 407004 }, null) && !wieldsTwo(colt, null));
  // Knuckle (323003 Brass): one per fist like the DualKnife; the Hak (301031, ClassMeta WeaponKnife) stays single
  check("two models: Brass Knuckle (WeaponKnuckle); not the Hak", wieldsTwo(ws.db.def(323003)!, null) && !wieldsTwo(ws.db.def(301031)!, null));
  check("bare fist (323001): one hand, no model (empty Weapon_Barefist_Knuckle mesh)", !wieldsTwo(ws.db.def(323001)!, null));
  // pef second hit: Knuckle A2 0.4 (AutoFireCount 2), Karambit B2 0.7 (AutoFireCount2 2); Shovel: AttackTimeA2 1 s with AutoFireCount 1 = off, no B timing in PBCross so timeB = 0.0 (CMeleeWeaponInfo zeroes it, 0x5ecebc), Cleaver A2 -1 off
  const m = (id: number) => ws.db.def(id)!.params.melee!;
  check("melee 2nd hit: Knuckle A2 0.4 / Karambit B2 0.7; none on Shovel B / Cleaver A",
    m(323003).timeA2 === 0.4 && m(301147).timeB2 === 0.7 && m(301147).timeA2 === undefined && m(301025).timeB2 === undefined && m(301025).timeA2 === undefined && m(301025).timeB === 0 && m(301058).timeA2 === undefined,
    JSON.stringify({ knuckle: m(323003), karambit: m(301147), shovel: m(301025), cleaver: m(301058) }));
  // 3PV (bots / remote players): dual AI of the 2017 I3CHR (pb-extract-tools export-anim3pv.mjs DUAL_STATES), Left/Right merged
  const ix3 = JSON.parse(fs.readFileSync(path.join(PUB, "assets/chars/swat_male/anim3pv/index.json"), "utf8")) as Anim3pvIndex;
  const ai3 = (id: number) => aiForWeapon(ix3, id, "handgun");
  check("3PV AI: Dual Deagle DualHandGun/DesertEagle, Dual Uzi DualSMG/Uzi, Kriss dual DualSMG/KrissSuperV; HK45 Dual (HandGun) single",
    ai3(214004) === "DualHandGun/DesertEagle" && ai3(118004) === "DualSMG/Uzi" && ai3(118001) === "DualSMG/KrissSuperV" && !/^Dual/.test(ai3(202025)),
    `${ai3(214004)} ${ai3(118004)} ${ai3(118001)} ${ai3(202025)}`);
  const A3 = ix3.ai["DualHandGun/DesertEagle"].stances.AttackIdle!;
  const fake = new Map<string, THREE.AnimationClip>();
  const trk = (bone: string) => new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, [0], [0, 0, 0, 1]);
  for (const [st, v] of Object.entries(A3)) fake.set(v.clip, new THREE.AnimationClip(v.clip, 1, /^Left/.test(st) ? [trk("Spine1"), trk("L Hand")] : /^Right/.test(st) ? [trk("Spine1"), trk("R Hand")] : [trk("Spine1"), trk("L Hand"), trk("R Hand")]));
  const D3 = dualTables(ix3.ai["DualHandGun/DesertEagle"], fake, "DualHandGun/DesertEagle").stances.AttackIdle!;
  const hands = (st: string) => fake.get(D3[st]?.clip)?.tracks.map((t) => t.name.split(".")[0]).filter((b) => /Hand/.test(b)).sort().join("+") ?? "-";
  check("3PV dual tables: Idle / Move / Attack / AttackLeft / AttackBoth key both hands; LoadMagazine + Change kept",
    ["Idle", "Move", "Attack", "AttackLeft", "AttackBoth"].every((st) => hands(st) === "L Hand+R Hand") && !!D3.LoadMagazine && !!D3.Change &&
    D3.AttackLeft.clip.endsWith("/AttackLeft") && A3.LeftAttack.dur === D3.AttackLeft.dur, ["Idle", "AttackLeft", "AttackBoth"].map(hands).join(" "));
  check("3PV dual mode by id / name: Dual Deagle alt, Dual Uzi both, Colt45 none",
    (await weaponDualFire(214004)) === "alt" && (await weaponDualFire("Uzi")) === "both" && (await weaponDualFire(202022)) === null);

  // ---- 5. recoil: 30 shots, camera vs bullets ----
  for (const id of [103004, 103037]) {
    ws.setLoadout({ primary: id, secondary: 202022, melee: 301001, grenade: 407001 });
    ws.refill();
    look.p = 0; look.y = 0; pose();
    frame({ slot: 1 }); idle(30); frame({ slot: 0 }); idle(90);
    look.p = 0; look.y = 0; pose();
    W.trace = [];
    const start = ws.getHudState().ammo;
    let fr = 0, maxYaw = 0, maxPitch = 0, maxBulletYaw = 0;
    const rows: string[] = [];
    while (start - ws.getHudState().ammo < 30 && fr < 600) {
      frame({ fire: true }); fr++;
      const tr = W.trace.at(-1);
      maxYaw = Math.max(maxYaw, Math.abs(look.y / DEG));
      maxPitch = Math.max(maxPitch, look.p / DEG);
      if (tr) maxBulletYaw = Math.max(maxBulletYaw, Math.abs(look.y / DEG + tr.offYaw));
      if (tr && W.trace.length % 5 === 0 && rows.length < W.trace.length / 5) rows.push(`     shot ${String(W.trace.length).padStart(2)}: camera yaw ${(look.y / DEG).toFixed(2)} pitch ${(look.p / DEG).toFixed(2)} | bullet yaw ${(look.y / DEG + tr.offYaw).toFixed(2)} pitch ${(look.p / DEG + (W.recV - W.recoilPitch) + tr.offPitch).toFixed(2)} (spread ${tr.offYaw.toFixed(2)},${tr.offPitch.toFixed(2)})`);
    }
    const rc = ws.db.def(id)!.params.recoil;
    console.log(`     ${ws.db.def(id)!.name}: RecoilHorzAngle ${rc.horzAngle} Max ${rc.horzMax}, CamSyncRate ${rc.camSyncRate}\n${rows.join("\n")}`);
    check(`${ws.db.def(id)!.name}: camera yaw stays within RecoilHorzMax (exe 0x7e6a20 turns the view by the kick only)`, maxYaw <= rc.horzMax + rc.horzAngle + 1e-6,
      `max |yaw| ${maxYaw.toFixed(2)} deg, max pitch ${maxPitch.toFixed(2)}, bullet |yaw| ${maxBulletYaw.toFixed(2)}`);
    frame({}); idle(200);
    check(`${ws.db.def(id)!.name}: after release the yaw returns to the burst start (2 s pull)`, Math.abs(look.y / DEG) < 0.3 && Math.abs(look.p / DEG) < 1e-3,
      `yaw ${(look.y / DEG).toFixed(3)} pitch ${(look.p / DEG).toFixed(3)}`);
  }
  void wall;
  console.log(fails ? `\n${fails} FAILED` : "\nall ok");
  process.exit(fails ? 1 : 0);
})();
