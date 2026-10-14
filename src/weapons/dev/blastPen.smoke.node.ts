// Node smoke test: the decoded 2017 explosion and bullet-wall rules (src/weapons/explosion.ts, penetration.ts) on the real
// WeaponSystem + Rapier (DOM / WebAudio stubbed). C4 with and without cover (WeaponC4::_OnCheckCollisionByExplosion 0x6375f0
// -> 0x60ed10), the K-400 numbers, a thin wall a K-2 goes through (0x60a950, f10 thickness 0x60c904), a solid one it does
// not, the second-wall rule (0x6097b4) and the sniper going through two bodies (0x609d90).
//   npx esbuild src/weapons/dev/blastPen.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/bp.mjs && node <tmp>/bp.mjs
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { WeaponSystem } from "../WeaponSystem";
import { clearColliderShapes, registerColliderShape, registerColliderTriangles, setFxTextureLoader, setSurfaceTable } from "../effects";
import { setWeaponFx } from "../sights";
import { explosionBodyDamage, explosionDistanceRate, explosionHits } from "../explosion";
import { classSkipsWallTest, penetrableTerrain, secondWallStops, wallDamageThickness, wallPenetrates } from "../penetration";
import { pbHitDamage } from "../../game/damage";
import type { HitEvent, HitTarget } from "../types";

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
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

(async () => {
  // ---- explosion rule (pure) ----
  const C4 = { damage: 100, range: 10, slope: 0.01 }, K400 = { damage: 90, range: 7, slope: 0.9 };
  check("0x540690 term for a blast: 1 - d / R * slope (C4 5 m = 0.995, K-400 3.5 m = 0.55)",
    near(explosionDistanceRate(5, 10, 0.01), 0.995) && near(explosionDistanceRate(3.5, 7, 0.9), 0.55));
  check("part-1 hit = CalcDamage rounding: K-400 at 3.5 m = 50, at 0 m = 90; C4 at 9.9 m = 99",
    explosionBodyDamage(90, 3.5, 7, 0.9) === 50 && explosionBodyDamage(90, 0, 7, 0.9) === 90 && explosionBodyDamage(100, 9.9, 10, 0.01) === 99);
  const open = { ikDist: 5, rootDist: 5, headClear: true, ikClear: true };
  const c4Open = explosionHits({ ...C4, passes: 2, hp: 100 }, open);
  check("C4, exposed at 5 m, HP 100: the head line alone kills (raw 100, no falloff), nothing after",
    c4Open.length === 1 && c4Open[0].part === "head" && c4Open[0].damage === 100, JSON.stringify(c4Open));
  const c4Body = explosionHits({ ...C4, passes: 2, hp: 110 }, { ...open, headClear: false });
  check("C4, head covered, body exposed, HP 110: body 100 * (1 - 0.01 * 5 / 10) = 100 (rounded), twice (team loop)",
    c4Body.length === 2 && c4Body.every((h) => h.part === "body" && h.damage === 100), JSON.stringify(c4Body));
  check("C4, both lines blocked: no hit", explosionHits({ ...C4, passes: 2 }, { ...open, headClear: false, ikClear: false }).length === 0);
  check("C4, IK bone 10 m away (range is strict <): no hit", explosionHits({ ...C4, passes: 2 }, { ...open, ikDist: 10 }).length === 0);
  const k = explosionHits({ ...K400, hp: 110 }, { ikDist: 6, rootDist: 6, headClear: true, ikClear: true });
  check("K-400 at 6 m, exposed, HP 110: head 90 + body 90 * (1 - 0.9 * 6 / 7) = 21, one pass",
    k.length === 2 && k[0].damage === 90 && k[1].damage === 21, JSON.stringify(k));
  const dino = explosionHits({ ...K400 }, { ikDist: 2, rootDist: 2, headClear: false, ikClear: true, dino: true });
  check("a dino's first line ends on the IK bone (0x4c1420): head part hit even with the head line blocked", dino[0]?.part === "head");

  // ---- wall rule (pure) ----
  check("penetrable I3_TERRAIN types: 12-15, 21-31, 35+ (CONCRETE 1 / GLASS 17 / BLOOD 32 not)",
    [12, 13, 14, 15, 21, 27, 30, 31, 35, 36].every(penetrableTerrain) && ![0, 1, 2, 4, 11, 16, 17, 20, 32, 34].some(penetrableTerrain));
  check("0x5b7080: melee / throwable / item / bomb skip the wall test, guns do not",
    [1, 7, 8, 9, 0x17].every(classSkipsWallTest) && ![2, 3, 4, 5, 6, 10].some(classSkipsWallTest));
  const steelThin = { type: 13, thickness: 90 };
  check("thickness <= 10 always passes (roll 99), solid STEEL never", wallPenetrates({ type: 13, thickness: 10 }, 50, 140, 0, 0, 99)
    && !wallPenetrates({ type: 2, thickness: 0 }, 1, 140, 1, 100, 0));
  // K-2: HelmetPenetrate 0.79 x BulletWeight 5 x Range 140 = 553; TH_MET 90 at 100 m: int(100 - 9000 / 553) = 83
  check("K-2 vs TH_MET 90 at 100 m: chance int(100 - 90 * 100 / (0.79 * 5 * 140)) = 83 (roll <= 83 passes)",
    wallPenetrates(steelThin, 100, 140, 0.79, 5, 83) && !wallPenetrates(steelThin, 100, 140, 0.79, 5, 84));
  check("no BulletWeight x HelmetPenetrate: only the <= 10 walls pass", !wallPenetrates(steelThin, 1, 140, 0, 5, 0));
  check("f10 clamp (0x60c97b): -1 / 120 -> 50, 90 stays", wallDamageThickness(-1) === 50 && wallDamageThickness(120) === 50 && wallDamageThickness(90) === 90);
  check("second wall stops only inside half the range left: (140 - 3) / 2 = 68.5", secondWallStops(140, 3, 68) && !secondWallStops(140, 3, 69));
  const bodyWall = pbHitDamage({ base: 27, zone: "torso", wallThickness: 50 }).damage, headWall = pbHitDamage({ base: 27, zone: "head", wallThickness: 50 }).damage;
  check("CalcDamage wall term: body 27 x 1.2 through thickness 50 = 16; the head (no CalcDamage) keeps its damage",
    bodyWall === 16 && headWall === pbHitDamage({ base: 27, zone: "head" }).damage, `${bodyWall} / ${headWall}`);

  // ---- world ----
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(80, 0.1, 80).setTranslation(0, -0.1, 0));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 300);
  camera.position.set(0, 1.6, 0);
  scene.add(camera);
  camera.updateMatrixWorld();
  setFxTextureLoader(() => new THREE.Texture());
  setWeaponFx(readJson("assets/weapons/fx/weaponfx.json"), "/assets/weapons/fx");
  // a closed thin box wall (outward CCW faces, like the exported collision): x [-3, 3], y [0, 3], z [z0 - t, z0]
  const thinWall = (z0: number, t: number, inward = false) => {
    const xs = [-3, 3], ys = [0, 3], zs = [z0 - t, z0];
    const v: number[] = [];
    for (const x of xs) for (const y of ys) for (const z of zs) v.push(x, y, z);
    const id = (x: number, y: number, z: number) => x * 4 + y * 2 + z;
    const quads = [ // each face counter-clockwise seen from outside
      [id(0, 0, 1), id(1, 0, 1), id(1, 1, 1), id(0, 1, 1)], [id(1, 0, 0), id(0, 0, 0), id(0, 1, 0), id(1, 1, 0)],
      [id(0, 0, 0), id(0, 0, 1), id(0, 1, 1), id(0, 1, 0)], [id(1, 0, 1), id(1, 0, 0), id(1, 1, 0), id(1, 1, 1)],
      [id(0, 1, 1), id(1, 1, 1), id(1, 1, 0), id(0, 1, 0)], [id(0, 0, 0), id(1, 0, 0), id(1, 0, 1), id(0, 0, 1)],
    ];
    const idx: number[] = [];
    for (const [a, b, c, d] of quads) inward ? idx.push(a, c, b, a, d, c) : idx.push(a, b, c, a, c, d);
    const vv = new Float32Array(v), ii = new Uint32Array(idx);
    const col = world.createCollider(RAPIER.ColliderDesc.trimesh(vv, ii));
    return { col, vv, ii };
  };
  const wallA = thinWall(-3, 0.1);
  clearColliderShapes();
  registerColliderShape(wallA.col.handle, "TH_MET_01", 0);
  registerColliderTriangles(wallA.col.handle, wallA.ii.length / 3);
  const terrain: [number, number][] = [[13, 10]];
  setSurfaceTable({ byIndex: ["Me"], byName: { TH_MET_01: "Me" }, terrain });

  const targets = new Map<number, HitTarget>();
  const addTarget = (id: string, x: number, z: number) => {
    const c = world.createCollider(RAPIER.ColliderDesc.capsule(0.6, 0.3).setSensor(true).setTranslation(x, 1.2, z));
    const feet = new THREE.Vector3(x, 0, z);
    targets.set(c.handle, { hitzone: "body", id, data: { feet: (o: THREE.Vector3) => o.copy(feet), isCrouching: () => false } });
    return c;
  };
  const tA = addTarget("A", 0, -6);
  const tB = addTarget("B", 0, -8);
  const ws = new WeaponSystem({
    scene, camera, world, RAPIER, viewmodel: false, audioListener: any, loadout: {},
    resolveTarget: (c) => targets.get(c.handle) ?? null,
  });
  await ws.ready;
  world.step();
  const hits: HitEvent[] = [];
  ws.onHit((e) => { if (e.target) hits.push(e); });
  const W = ws as any;
  const shoot = (id: number, from = new THREE.Vector3(0, 1.4, 0)) => {
    hits.length = 0;
    W.traceBullet(ws.db.def(id), from, new THREE.Vector3(0, 0, -1));
    return hits.map((h) => `${(h.target as { id: string }).id}:${h.damage}${h.penetrated ? "w" : ""}`);
  };
  const k2 = ws.db.def(103004)!, barrett = ws.db.def(105032)!;
  check("weapons.json: K-2 class 3 BulletWeight 5, Barrett class 5 BulletWeight 18", k2.classType === 3 && k2.params.bulletWeight === 5
    && barrett.classType === 5 && barrett.params.bulletWeight === 18);
  const clean = (h: HitEvent, wall = 0) => W.bulletDamage(ws.db.def(h.weapon.id), "body", h.distance, false, h.weapon.params.damage, wall) as number;

  // thin wall thickness 10: always through, f10 = 10 -> 90 % (body)
  let r = shoot(103004);
  check("K-2 through TH_MET thickness 10: hits A behind it, body damage x (1 - 0.10)", r.length === 1 && r[0].startsWith("A:") && hits[0].penetrated === 1
    && hits[0].damage === clean(hits[0], 10) && hits[0].damage < clean(hits[0]), `${r} clean ${hits[0] ? clean(hits[0]) : "-"}`);
  // the same shape as solid STEEL (type 2): the bullet stops in it
  terrain[0] = [2, 0];
  r = shoot(103004);
  check("the same wall as solid STEEL: nothing behind it is hit", r.length === 0, `${r}`);
  // thickness 0 TH_ wall: through with no damage loss
  terrain[0] = [13, 0];
  r = shoot(103004);
  check("TH_MET thickness 0: through, full damage", r.length === 1 && hits[0].damage === clean(hits[0]), `${r}`);
  // knives / grenades never pass (0x5b7080) - checked by the pure test; a sniper goes on through both bodies
  r = shoot(105032);
  check("Barrett (class 5) through the thin wall and both bodies, same damage each", r.length === 2 && r[0].startsWith("A:") && r[1].startsWith("B:")
    && hits.every((h) => h.damage === clean(h) && h.penetrated === 1), `${r}`);
  r = shoot(103004);
  check("K-2 (class 3) stops in the first body", r.length === 1 && r[0].startsWith("A:"), `${r}`);
  // a solid wall 1 m behind the thin one stops it: (140 - 3) / 2 > 1
  const solid = world.createCollider(RAPIER.ColliderDesc.cuboid(3, 3, 0.1).setTranslation(0, 1.5, -4.1));
  world.step();
  r = shoot(103004);
  check("second (solid) wall 1 m behind the thin one stops the bullet (0x6097b4)", r.length === 0, `${r}`);
  world.removeCollider(solid, true);
  // the exported winding is not the same in every map mesh: an inward-wound wall must behave the same
  world.removeCollider(wallA.col, true);
  const wallB = thinWall(-3, 0.1, true);
  registerColliderShape(wallB.col.handle, "TH_MET_01", 0);
  registerColliderTriangles(wallB.col.handle, wallB.ii.length / 3);
  terrain[0] = [13, 10];
  world.step();
  r = shoot(103004);
  check("inward-wound thin wall: same result (one wall crossed, A hit at x0.9)", r.length === 1 && r[0].startsWith("A:") && hits[0].penetrated === 1
    && hits[0].damage === clean(hits[0], 10), `${r}`);

  // ---- C4 cover through WeaponSystem.blastLineClear (0x60aa50, no wall test for class 9) ----
  const c4At = new THREE.Vector3(0, 0.02, -9);
  const actorPts = (x: number, z: number) => {
    const f = new THREE.Vector3(x, 0, z);
    return { head: f.clone().setY(1.597), ik: f.clone().setY(1.125), root: f.clone().setY(0.99) };
  };
  const exposed = ws.blastHits(actorPts(4, -9), c4At, { ...C4, passes: 2, hp: 100 });
  check("C4 4 m away in the open: killed by the head line (100)", exposed.length === 1 && exposed[0].damage === 100, JSON.stringify(exposed));
  const behindThin = ws.blastHits(actorPts(0, -1), c4At, { ...C4, passes: 2, hp: 100 });
  check("C4 behind the thin wall (8 m): blocked, a bomb never goes through a wall", behindThin.length === 0, JSON.stringify(behindThin));
  const low = world.createCollider(RAPIER.ColliderDesc.cuboid(0.1, 0.65, 1).setTranslation(-3.5, 0.65, -9));
  world.step();
  const lowCover = ws.blastHits(actorPts(-4, -9), c4At, { ...C4, passes: 2, hp: 110 });
  check("C4 behind a 1.3 m crate (IK 1.125 covered, head 1.597 seen): head 100 only, then the head again on pass 2",
    lowCover.length === 2 && lowCover.every((h) => h.part === "head" && h.damage === 100), JSON.stringify(lowCover));
  world.removeCollider(low, true);
  const beam = world.createCollider(RAPIER.ColliderDesc.cuboid(0.1, 0.1, 1).setTranslation(-3.5, 1.4, -9));
  world.step();
  const headCover = ws.blastHits(actorPts(-4, -9), c4At, { ...C4, passes: 2, hp: 110 });
  check("C4 with only the head line blocked, HP 110: body 100 * (1 - 0.01 * 4 / 10) = 100, twice -> dead",
    headCover.length === 2 && headCover.every((h) => h.part === "body" && h.damage === 100), JSON.stringify(headCover));
  world.removeCollider(beam, true);
  world.step();
  const far = ws.blastHits(actorPts(10.5, -9), c4At, { ...C4, passes: 2 });
  check("C4 10.5 m away: out of range", far.length === 0);
  void tA; void tB;

  ws.dispose();
  console.log(fails ? `\n${fails} FAILED` : "\nall ok");
  process.exit(fails ? 1 : 0);
})();
