// Node smoke test for the pef-driven weapon model (no browser: DOM/WebAudio are stubbed, Rapier is real).
//   npx esbuild src/weapons/dev/smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/smoke.mjs && node <tmp>/smoke.mjs
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { distanceRate, pbCalcDamage, pbHitDamage } from "../../game/damage";
import { pbFallDamage, pbLive } from "../../gameplay/pbConfig";
import { WeaponSystem } from "../WeaponSystem";
import type { HitTarget } from "../types";

// universal stub: any property / call / construct returns itself
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
g.addEventListener = () => {}; // scope.ts resize hook
g.innerWidth = 1920;
g.innerHeight = 1080;
g.Image = any;
const PUB = path.resolve("public");
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

(async () => {
  // ---- formulas ----
  check("fall 5.8m = 0", pbFallDamage(5.8) === 0);
  check("fall 8m = 2+trunc(40) = 42", pbFallDamage(8) === 42, String(pbFallDamage(8)));
  check("fall 30m clamps to HP 100 (2017 SWAT_Male)", pbFallDamage(30) === 100);
  check("DPD K-2 at range = 1-0.25", Math.abs(distanceRate(140, 140, 0.25) - 0.75) < 1e-9);
  check("CalcDamage rounds +0.5, min 1", pbCalcDamage(24.4) === 24 && pbCalcDamage(24.5) === 25 && pbCalcDamage(0.1) === 1);
  check("AK 33 head no helmet = HEAD_HIT_DAMAGE 200 (0x7fbf20), not 33 x rate", pbHitDamage({ base: 33, zone: "head" }).damage === 200);
  check("AK 33 body = 33 x 1.2 = 40 (0x542df0)", pbHitDamage({ base: 33, zone: "torso" }).damage === 40);
  check("AK 33 body @140m DPD .25 = 33 x 1.2 x .75 = 30", pbHitDamage({ base: 33, zone: "torso", distance: 140, range: 140, dpdRate: 0.25 }).damage === 30);
  const blocked = pbHitDamage({ base: 33, zone: "head", helmet: true, helmetPenetrate01: 0.5, rand: 0.9 });
  const through = pbHitDamage({ base: 33, zone: "head", helmet: true, helmetPenetrate01: 0.5, rand: 0.5 });
  check("helmet roll: p=.5/.75 -> .9 blocked, .5 through", blocked.helmetBlocked && !through.helmetBlocked && through.damage === 200);

  // ---- weapon system ----
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(80, 16 / 9, 0.1, 300);
  camera.position.set(0, 1.6, 0);
  scene.add(camera);
  const targets = new Map<number, HitTarget>();
  const body = world.createCollider(RAPIER.ColliderDesc.cuboid(0.25, 0.4, 0.15).setTranslation(0, 1.6, -10));
  targets.set(body.handle, { hitzone: "torso", id: "bot" });
  world.step();
  const ws = new WeaponSystem({ scene, camera, world, RAPIER, viewmodel: false, audioListener: any,
    resolveTarget: (c) => targets.get(c.handle) ?? null, loadout: { primary: 103004 } });
  await ws.ready;
  const k2 = ws.db.def(103004)!;
  check("K-2 from pef 3.123", k2.pb?.src === "Assault/K-2", k2.pb?.src);
  check("K-2 fireDelay 0.075 auto", k2.fireDelay === 0.075 && k2.fireMode === "auto");
  check("K-2 recoil vert 1.95 max 7.25 horzCount 1", k2.params.recoil.vertAngle === 1.95 && k2.params.recoil.vertMax === 7.25 && k2.params.recoil.horzCount === 1);
  check("K-2 exe defaults: recover 1.0, contract 0.4", k2.params.recoil.vertRecoverTime === 1 && k2.params.spread.cross.contractTime === 0.4);
  const ssg = ws.db.def(105003)!;
  check("SSG69 bolt, LoadBulletTime cycle, scope fov 16", ssg.fireMode === "bolt" && (ssg.params.loadBulletTime ?? 0) > 0 && ssg.params.scope === true && ssg.params.zoomFov === 16,
    `${ssg.fireMode} lbt=${ssg.params.loadBulletTime} fov=${ssg.params.zoomFov}`);
  const sg = ws.db.def(106001)!;
  check("870MCS pump, 8 pellets, per-shell reload", sg.fireMode === "pump" && sg.params.pellets === 8 && sg.params.reloadPerShell === true);
  const knife = ws.db.def(301001)!;
  check("M-7 A1 60/0.18 B1 90", knife.params.melee?.damageA === 60 && knife.params.melee?.timeA === 0.18 && knife.params.melee?.damageB === 90);

  const hits: { d: number; dist: number }[] = [];
  ws.onHit((h) => { if (h.target) hits.push({ d: h.damage, dist: h.distance }); });
  const dt = 1 / 60;
  const step = (n: number, inp: object) => { for (let i = 0; i < n; i++) ws.update(dt, { fire: false, aim: false, grounded: true, ...inp }); };
  step(1, { slot: 0 });
  step(40, {}); // lower + raise the K-2 (slot 0 is filled only once weapons.json is loaded)
  check("current = K-2", ws.current()?.id === 103004, ws.current()?.name);
  camera.rotation.set(0, 0, 0);
  camera.lookAt(0, 1.6, -10);
  const p0 = camera.rotation.x;
  step(1, { fire: true });
  check("first K-2 shot hits body for 27 (dist 10, DPD .25)", !!hits[0] && hits[0].d === pbHitDamage({ base: 27, zone: "torso", distance: hits[0].dist, range: 140, dpdRate: 0.25 }).damage,
    JSON.stringify(hits[0]));
  step(40, { fire: true });
  const climb = (camera.rotation.x - p0) / THREE.MathUtils.DEG2RAD;
  const hud = ws.getHudState();
  // camera pitch = R.v * CamSyncRate (0x7e5670); R.v stays <= RecoilVertMax + 0.1 (0x5ceb59)
  check("spray: camera pitch = R.v * CamSyncRate <= (vertMax + 0.1) * 0.85", climb > 1 && climb <= (7.25 + 0.1) * 0.85 + 1e-6,
    `climb=${climb.toFixed(2)}deg spread=${hud.spreadDeg.toFixed(2)}`);
  check("spray: deviation grew above the posture target m(1+Stand)", hud.spreadDeg > 0.6 * 1.7, hud.spreadDeg.toFixed(2));
  check("pbLive fed MoveNormal", pbLive.moveNormal?.stand === 80 && pbLive.moveNormal?.fire === 78);
  step(90, {});
  const after = (camera.rotation.x - p0) / THREE.MathUtils.DEG2RAD;
  check("recoil recovers after release (log10 T, sin-table ease-out)", Math.abs(after) < 1e-9, `pitch=${after.toFixed(4)}deg spread=${ws.getHudState().spreadDeg.toFixed(2)}`);
  check("crosshair back to posture target m(1+Stand) = 1.02", Math.abs(ws.getHudState().spreadDeg - 0.6 * 1.7) < 1e-9, ws.getHudState().spreadDeg.toFixed(4));
  check("crosshair gap = tan(b0) * H/2 (0x7598b0, no FOV term)", Math.abs(ws.crosshairRadiusPx(1080) - Math.tan(1.02 * THREE.MathUtils.DEG2RAD) * 540) < 1e-9,
    ws.crosshairRadiusPx(1080).toFixed(2) + "px @1080p");

  // ---- 30-shot traces vs the disassembled formulas ----
  const mulberry = (seed: number) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const randS = (r: () => number) => Math.floor(r() * 4096) * 0.000488519785 - 1; // 0x5f08c0
  const sinTab = (x: number) => Math.sin((((Math.trunc(x * 127) + 128) & 0x1ff) * Math.PI * 2) / 512); // 0x7ece10
  type Row = { t: number; n: number; dev: number; offPitch: number; offYaw: number; recV: number; kickH: number; yaw: number; cross: number };
  /** independent frame model: same frame order as WeaponSystem.update (fire, then 0x7e7f60 / 0x7e6a20 / 0x7e7d90 / 0x7e8100) */
  const reference = (id: number, shots: number, seed: number): Row[] => {
    const d = ws.db.def(id)!, rc = d.params.recoil, c = d.params.spread.cross, rng = mulberry(seed);
    const m = c.min > 0 ? c.min : 0.01, posture = Math.min(c.max, Math.max(0, m + m * c.stand)), T = c.contractTime * c.speedFactor;
    const delay = Math.min(3, Math.max(0.06, d.fireDelay));
    let time = 0, fireT = -1, cont = false, n = 0, v = 0, v0 = 0, vT = 0, vt = 0, yaw = 0, base = 0, h = 0, ht = 0, hd = 0, hs = 0;
    let cur = posture, start = posture, tgt = posture, xt = 0, xT = 0, act = false;
    const rows: Row[] = [];
    while (rows.length < shots) {
      time += dt;
      if (fireT >= 0) fireT += dt; // 0x9d0910
      if (fireT < 0 || fireT > delay) {
        if (cont && fireT >= 0) { fireT -= delay; if (fireT > 2 * delay) fireT = 0.032; } else fireT = 0; // carry (0x9d0bb9) / fresh pull (0x61756a)
        cont = true;
        const vc = rc.vertCount;
        if (vc === 0 || (rc.oneVert ? vc <= n : vc < n)) {
          v += rc.vertAngle; if (v > rc.vertMax) v = rc.vertMax + randS(rng) * 0.1; v0 = v; vT = Math.log10(v / rc.vertRecoverTime); vt = 0;
        }
        let kickH = 0;
        if (rc.oneHorz ? rc.horzCount <= n : rc.horzCount < n) {
          kickH = randS(rng) * rc.horzAngle; if (Math.abs(yaw + kickH - base) > rc.horzMax) kickH = -kickH;
          h = kickH; ht = 0; hd = Math.min(d.fireDelay, 0.5);
        }
        const dev = cur;
        cur += d.params.spread.deviation; start = cur; tgt = Math.min(cur, c.max); xt = 0; xT = T; act = true;
        const offPitch = dev * 0.25 * randS(rng), offYaw = randS(rng) * dev * 0.25;
        rows.push({ t: time, n, dev, offPitch, offYaw, recV: v, kickH, yaw: rows.length ? yaw : 0, cross: cur });
        n++;
      }
      if (v > 0) { vt += dt; if (vT > 0) v = Math.max(0, v0 + v0 * sinTab(1 + vt / vT)); if (vt > vT) { v = 0; vt = 0; } }
      if (ht < hd) { if (hs !== 1) { base = yaw; hs = 1; } yaw += h * (1 / hd) * dt; ht += dt; }
      if (posture !== tgt) { xT = posture > cur ? c.expandTime : T; tgt = posture; start = cur; act = true; xt = 0; }
      if (act) { xt += dt; if (xT > 2e-5) cur = start + (tgt - start) * Math.sin((Math.PI / 2) * (xt / xT)); if (xt > xT) { cur = start = tgt; xt = 0; act = false; } }
    }
    return rows;
  };
  const spray = (id: number, shots: number, seed: number): Row[] => {
    ws.equip(id);
    step(120, {}); // draw + let recoil / crosshair settle
    ws.refill();
    ws.rng = mulberry(seed);
    ws.trace = [];
    for (let i = 0; i < 600 && ws.trace.length < shots; i++) ws.update(dt, { fire: true, aim: false, grounded: true });
    const rows = ws.trace.slice(0, shots) as Row[];
    ws.trace = null;
    ws.rng = Math.random;
    step(180, {});
    return rows;
  };
  for (const [id, label] of [[103004, "K-2"], [103037, "AUG A3"], [103002, "AK-47"]] as const) {
    const d = ws.db.def(id)!;
    const got = spray(id, 30, 1234), ref = reference(id, 30, 1234);
    const t0 = got[0]?.t ?? 0;
    // the reference clock starts at the first shot too
    const r0 = ref[0].t;
    let worst = 0;
    got.forEach((g, i) => {
      const r = ref[i];
      for (const k of ["dev", "offPitch", "offYaw", "recV", "kickH", "cross"] as const) worst = Math.max(worst, Math.abs(g[k] - r[k]));
      worst = Math.max(worst, Math.abs((g.t - t0) - (r.t - r0)), Math.abs(g.yaw - got[0].yaw - r.yaw));
    });
    const rc = d.params.recoil, c = d.params.spread.cross, m = c.min > 0 ? c.min : 0.01;
    check(`${label} 30-shot trace == disassembled formulas`, got.length === 30 && worst < 1e-9, `max|diff|=${worst.toExponential(2)}`);
    check(`${label} first shot deviation = posture target m(1+Stand) = ${(m * (1 + c.stand)).toFixed(3)}`, Math.abs(got[0].dev - m * (1 + c.stand)) < 1e-9, got[0].dev.toFixed(4));
    check(`${label} bullet offsets inside +-dev/4 square`, got.every((g) => Math.abs(g.offPitch) <= g.dev / 4 * 1.0005 + 1e-12 && Math.abs(g.offYaw) <= g.dev / 4 * 1.0005 + 1e-12));
    const span = got[29].t - got[0].t;
    check(`${label} cadence: 29 intervals = 29 x FireDelay within one frame (remainder carried)`, Math.abs(span - 29 * d.fireDelay) <= dt + 1e-9, `${span.toFixed(4)}s vs ${(29 * d.fireDelay).toFixed(4)}s`);
    check(`${label} R.v <= RecoilVertMax + 0.1`, got.every((g) => g.recV <= rc.vertMax + 0.1 + 1e-9), `max=${Math.max(...got.map((g) => g.recV)).toFixed(3)}`);
    const firstH = got.findIndex((g) => g.kickH !== 0);
    check(`${label} first horizontal kick at shot index ${rc.oneHorz ? rc.horzCount : rc.horzCount + 1} (HorzCount ${rc.horzCount}, 0-based n)`, firstH === (rc.oneHorz ? rc.horzCount : rc.horzCount + 1), String(firstH));
    console.log(`  ${label} (${d.id}) FireDelay ${d.fireDelay} Deviation ${d.params.spread.deviation} Vert ${rc.vertAngle}/${rc.vertMax} Horz ${rc.horzAngle}/${rc.horzMax}/${rc.horzCount} CamSync ${rc.camSyncRate}`);
    console.log("   n    t(s)   dt(s)  dev    offP    offY    aimPitch camPitch yaw     kickH   cross");
    got.forEach((g, i) => console.log("  " + [String(g.n).padStart(2), (g.t - t0).toFixed(4), (i ? g.t - got[i - 1].t : 0).toFixed(4), g.dev.toFixed(3),
      g.offPitch.toFixed(3).padStart(6), g.offYaw.toFixed(3).padStart(6), g.recV.toFixed(3).padStart(7), (g.recV * rc.camSyncRate).toFixed(3).padStart(7),
      (g.yaw - got[0].yaw).toFixed(3).padStart(6), g.kickH.toFixed(3).padStart(6), g.cross.toFixed(3)].join("  ")));
  }

  // ---- RMB toggle (0x78bd90) / scope level (0x78bdb0) ----
  ws.equip(103004);
  step(60, {});
  step(1, { aim: true });
  step(5, { aim: true });
  const zoomHeld = ws.getHudState().aiming;
  step(5, {});
  const zoomAfterRelease = ws.getHudState().aiming;
  step(1, { aim: true });
  step(1, {});
  check("RMB is a press toggle (on after press, stays on after release, off on 2nd press)", zoomHeld && zoomAfterRelease && !ws.getHudState().aiming);
  step(1, { aim: true });
  step(1, { fire: true });
  step(5, {});
  step(1, { reload: true });
  check("reload drops zoom (OnLoadMagazine 0xa14a30 -> _Idle_Camera)", !ws.getHudState().aiming && ws.getHudState().reloading);
  step(200, {});
  check("no re-zoom after the reload", !ws.getHudState().aiming && !ws.getHudState().reloading);
  ws.equip(105003); // SSG69, bolt
  step(90, {});
  step(1, { aim: true });
  step(10, {});
  const boltZoomed = ws.getHudState().scoped;
  step(1, { fire: true });
  step(2, {});
  check("bolt sniper: shot drops the scope (OnLoadBullet 0xa14ef0), no auto re-zoom", boltZoomed && !ws.getHudState().aiming, "scoped before=" + boltZoomed);
  step(1, { aim: true });
  check("RMB ignored while the bolt cycles (0xa23979)", !ws.getHudState().aiming);
  console.log(fails ? `${fails} FAILED` : "ALL OK");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
