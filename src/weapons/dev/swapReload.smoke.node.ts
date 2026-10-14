// Node smoke test: PB weapon swap time (with / without Quick Change) and the reload sequence on the real WeaponSystem
// (no browser: DOM/WebAudio are stubbed, Rapier is real). Also the character resolution (game/loadout.ts).
//   npx esbuild src/weapons/dev/swapReload.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/sr.mjs && node <tmp>/sr.mjs
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { WeaponSystem, pbReloadScale, pbSwapScale } from "../WeaponSystem";
import type { ReloadEvent, SwitchEvent } from "../types";
import { BASIC_CHARAS, itemEffectsOf, resolveChara } from "../../game/loadout";

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
const near = (a: number, b: number, eps = 1 / 60 + 1e-6) => Math.abs(a - b) <= eps;

(async () => {
  // ---- exe formulas ----
  check("swap scale: none 1, Quick Change 1.5 (+eps), + beret 2.25, cap 2.3",
    pbSwapScale({}) === 1 && near(pbSwapScale({ quickChangeWeapon: true }), 1.5, 1e-4) &&
    near(pbSwapScale({ quickChangeWeapon: true }, true), 2.25, 1e-3) && pbSwapScale({ quickChangeWeapon: true }, true) <= 2.3,
    `${pbSwapScale({ quickChangeWeapon: true })} ${pbSwapScale({ quickChangeWeapon: true }, true)}`);
  check("reload scale: none 1, Quick Change Reload 1.25 (+eps)", pbReloadScale({}) === 1 && near(pbReloadScale({ quickChangeReload: true }), 1.25, 1e-4));
  // exe 0xa0c3d0 / 0xa0cd50 (RE 2026-09-27): all sources multiply, no equip / skill bonus; beret flags on PbItemEffects
  check("swap: beret (type 10) alone 1.5, beret + item 2.25 (fx flags)",
    near(pbSwapScale({ beretQuickChange: true }), 1.5, 1e-4) && near(pbSwapScale({ quickChangeWeapon: true, beretQuickChange: true }), 2.25, 1e-3));
  check("reload: fast-reload beret 1.25, beret + item 1.5625 (multiplicative)",
    near(pbReloadScale({ beretFastReload: true }), 1.25, 1e-4) && near(pbReloadScale({ beretFastReload: true, quickChangeReload: true }), 1.5625, 1e-3),
    `${pbReloadScale({ beretFastReload: true, quickChangeReload: true })}`);
  for (const [n, fx] of [["none", {}], ["QC item", { quickChangeWeapon: true, quickChangeReload: true }], ["item+beret", { quickChangeWeapon: true, quickChangeReload: true, beretQuickChange: true, beretFastReload: true }]] as const)
    console.log(`     AK-47 ${n}: swap ${(0.6667 / pbSwapScale(fx)).toFixed(3)} s, reload ${(2.5 / pbReloadScale(fx)).toFixed(3)} s`);
  check("items: 1600165 -> quick change, 1600166 -> quick reload, Durable not activated -> none",
    itemEffectsOf([{ itemId: 1600165, equip: 2 }]).quickChangeWeapon === true &&
    itemEffectsOf([{ itemId: 1600166, equip: 3 }]).quickChangeReload === true &&
    itemEffectsOf([{ itemId: 1600026 }]).quickChangeWeapon === true &&
    !itemEffectsOf([{ itemId: 1600165, equip: 1 }]).quickChangeWeapon && !itemEffectsOf([{ itemId: 103037, equip: 3 }]).quickChangeWeapon);
  check("equipped beret: 2700013 BeretPBTN (type 10) -> beretQuickChange, other / none -> off, swap 1.5 alone",
    itemEffectsOf([], 2700013).beretQuickChange === true && !itemEffectsOf([], 2700001).beretQuickChange && !itemEffectsOf([]).beretQuickChange &&
    near(pbSwapScale(itemEffectsOf([], 2700013)), 1.5, 1e-4) && near(pbSwapScale(itemEffectsOf([{ itemId: 1600165 }], 2700013)), 2.25, 1e-3) &&
    !itemEffectsOf([{ itemId: 2700013 }]).beretQuickChange);

  // ---- ?: character by itemId ----
  const chars = JSON.parse(fs.readFileSync(path.join(PUB, "assets/chars/index.json"), "utf8")).chars as
    { name: string; team: string; itemId?: number; itemIds?: number[] }[];
  const r1 = resolveChara(chars, 602008, 1);
  check("chara 602008 -> leopard (itemId)", r1.entry?.name === "leopard" && r1.source === "itemId", `${r1.entry?.name} ${r1.source}`);
  const r2 = resolveChara(chars, 601024, 0);
  check("chara 601024 -> bella (itemId)", r2.entry?.name === "bella" && r2.source === "itemId", `${r2.entry?.name}`);
  const r3 = resolveChara(chars, 601666, 0);
  check("601666 Natasha (no model) -> red basic 601001 rebel_male", r3.entry?.name === "rebel_male" && r3.source === "basic", `${r3.entry?.name} ${r3.source}`);
  const r4 = resolveChara(chars, 0, 1);
  check("no itemId, blue -> basic 602002 swat_male", r4.entry?.name === "swat_male" && r4.source === "basic", `${r4.entry?.name}`);
  const r5 = resolveChara(chars, 699999, 1);
  check("unknown itemId -> blue basic", r5.entry?.name === "swat_male" && r5.source === "basic");
  check("Basic.xml charas", BASIC_CHARAS[0][0] === 601001 && BASIC_CHARAS[1][0] === 602002);
  const withId = chars.filter((c) => c.itemId);
  check("every exported chara resolves to itself by its itemId", withId.every((c) => resolveChara(chars, c.itemId, c.team === "red" ? 0 : 1).entry?.name === c.name),
    `${withId.length} chars`);

  // ---- WeaponSystem: swap ----
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 300);
  scene.add(camera);
  const ws = new WeaponSystem({ scene, camera, world, RAPIER, viewmodel: false, audioListener: any, resolveTarget: () => null, loadout: {} });
  await ws.ready;
  const dt = 1 / 60;
  let t = 0;
  const step = (inp: object = {}) => { ws.update(dt, { fire: false, aim: false, grounded: true, ...inp }); t += dt; };
  const aug = ws.db.def(103037)!, colt = ws.db.def(202022)!;
  check("AUG A3 / Colt45 changeTime = 1PV Change state 0.6667 s", aug.params.changeTime === 0.6667 && colt.params.changeTime === 0.6667,
    `${aug.params.changeTime} ${colt.params.changeTime}`);
  check("Colt45 ReloadTime 2.4 (pef 3.123), AUG 2.5", colt.params.reloadTime === 2.4 && aug.params.reloadTime === 2.5);
  const switches: SwitchEvent[] = [];
  ws.onSwitch((e) => switches.push(e));

  /** press slot, count frames until the new weapon fires (a FireEvent), return seconds */
  const swapTime = (slot: 0 | 1): number => {
    let fired = -1;
    const off = ws.onFire(() => { if (fired < 0) fired = t; });
    const t0 = t;
    step({ slot });
    for (let i = 0; i < 180 && fired < 0; i++) step({ fire: i % 2 === 0 });
    off();
    return fired - t0;
  };
  ws.refill(); // spawn (Game: refill + switchTo(0)); before weapons.json the AUG slot was empty
  step({ slot: 0 });
  for (let i = 0; i < 60; i++) step();
  check("starts on the primary (AUG A3 Gold)", ws.current()?.id === 103037, ws.current()?.name);
  ws.resetLast(); // spawn (weaponAdapter.reset)
  step({ lastWeapon: true });
  check("Q right after spawn: goes to the secondary (divergence from exe 0xa13620, user decision)", ws.current()?.id === 202022, ws.current()?.name);
  for (let i = 0; i < 60; i++) step();
  step({ lastWeapon: true });
  check("Q again: back to the primary", ws.current()?.id === 103037, ws.current()?.name);
  for (let i = 0; i < 60; i++) step();
  const n0 = switches.length;
  step({ slot: 1 });
  check("PB swap: the new weapon is attached on the press (no lowering phase)", ws.current()?.id === 202022 && switches.length === n0 + 1);
  for (let i = 0; i < 60; i++) step();
  const tNormal = swapTime(0);
  check("swap Colt45 -> AUG, no item: fires after 0.667 s", near(tNormal, 0.6667 + dt), `${tNormal.toFixed(3)} s`);
  ws.setItemEffects({ quickChangeWeapon: true });
  for (let i = 0; i < 60; i++) step();
  const tQuick = swapTime(1);
  check("swap AUG -> Colt45, Quick Change: fires after 0.667 / 1.5 = 0.444 s", near(tQuick, 0.6667 / 1.50002 + dt), `${tQuick.toFixed(3)} s`);
  check("changeTimeOf with Quick Change", near(ws.changeTimeOf(colt), 0.4444, 1e-3), ws.changeTimeOf(colt).toFixed(4));
  ws.setItemEffects({});

  // ---- WeaponSystem: reload sequence (Colt45) ----
  for (let i = 0; i < 60; i++) step();
  ws.refill(); // the swap timing shots used some rounds
  const rel: (ReloadEvent & { t: number })[] = [];
  ws.onReload((e) => rel.push({ ...e, t }));
  for (let i = 0; i < 6; i++) { step({ fire: true }); for (let k = 0; k < 14; k++) step(); } // fireDelay 0.2
  const h0 = ws.getHudState();
  check("Colt45 fired 6 of 7", h0.ammo === 1 && h0.reserve === 28, `${h0.ammo}/${h0.reserve}`);
  const tr = t;
  step({ reload: true });
  const start = rel.find((e) => e.phase === "start");
  check("reload start event carries ReloadTime 2.4", !!start && start.reloadTime === 2.4, JSON.stringify(start && { rt: start.reloadTime, ammo: start.ammo }));
  let refillAt = -1;
  let h1 = ws.getHudState();
  for (let i = 0; i < 200 && refillAt < 0; i++) {
    step({ fire: i % 3 === 0 }); // firing during the reload does nothing (magazine weapon)
    const h = ws.getHudState();
    if (h.ammo !== h1.ammo) { refillAt = t - tr; h1 = h; }
  }
  check("partial magazine: +6 rounds only at the end of ReloadTime (not before)", h1.ammo === 7 && h1.reserve === 22 && near(refillAt, 2.4 + dt, 2 * dt),
    `ammo ${h1.ammo}/${h1.reserve} refill at ${refillAt.toFixed(3)} s`);
  check("reload end event", rel.some((e) => e.phase === "end"));

  // cancel on swap: reload, swap mid-way, ammo unchanged
  for (let i = 0; i < 3; i++) { step({ fire: true }); for (let k = 0; k < 14; k++) step(); }
  const before = ws.getHudState();
  step({ reload: true });
  for (let i = 0; i < 60; i++) step();
  step({ slot: 0 });
  const cancelled = rel[rel.length - 1];
  for (let i = 0; i < 60; i++) step();
  step({ slot: 1 });
  for (let i = 0; i < 200; i++) step();
  const after = ws.getHudState();
  check("swap cancels the reload (no rounds loaded)", cancelled.phase === "cancel" && after.ammo === before.ammo && after.reserve === before.reserve,
    `${before.ammo}/${before.reserve} -> ${after.ammo}/${after.reserve}`);

  // Quick Change Reload: 2.4 / 1.25 = 1.92 s
  ws.setItemEffects({ quickChangeReload: true });
  const tq = t;
  step({ reload: true });
  let qAt = -1;
  for (let i = 0; i < 200 && qAt < 0; i++) { step(); if (ws.getHudState().ammo === 7) qAt = t - tq; }
  check("Quick Change Reload: Colt45 refills after 2.4 / 1.25 = 1.92 s", near(qAt, 1.92 + dt, 2 * dt), `${qAt.toFixed(3)} s`);
  ws.setItemEffects({});

  // AUG A3 empty magazine: same LoadMag state, full ReloadTime
  step({ slot: 0 });
  for (let i = 0; i < 60; i++) step();
  for (let i = 0; i < 400 && ws.getHudState().ammo > 0; i++) step({ fire: true });
  const ta = t;
  for (let i = 0; i < 20; i++) step({ fire: i < 10 }); // dry fire starts the reload
  const ra = rel.filter((e) => e.weapon.id === 103037 && e.phase === "start").pop();
  let aAt = -1;
  for (let i = 0; i < 300 && aAt < 0; i++) { step(); if (ws.getHudState().ammo === 45) aAt = t - (ra?.t ?? ta); }
  check("AUG empty -> auto reload, 45 rounds after ReloadTime 2.5 s", !!ra && near(aAt, 2.5, 2 * dt), `${aAt.toFixed(3)} s`);

  console.log(fails ? `\n${fails} FAILED` : "\nall ok");
  process.exit(fails ? 1 : 0);
})();
