// Node smoke test: PB key map, G drop -> pick-up (ammo kept), death drop, drop lifetime, radio Z/X/C, and the UDP
// DropWeapon / GetWeaponForClient / RadioChat events (no browser).
//   npx esbuild src/game/dev/dropRadio.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/dr.mjs && node <tmp>/dr.mjs
// Exe rules:,, "Radio".
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { WeaponSystem } from "../../weapons/WeaponSystem";
import type { WeaponInput } from "../../weapons/types";
import { Player } from "../../player";
import type { Input } from "../input";
import { PB_KEYS } from "../keymap";
import { DropField, PB_DROP, dropFlags, findPickup, parseDropFlags, stepDrop, type DroppedWeapon } from "../../gameplay/pbDrop";
import { RadioMenu, parseRadioId, radioId, radioRule, radioSoundFile, radioStringKey } from "../../gameplay/pbRadio";
import { Ev, decodeActions, encodeUserAction } from "../../net/matchUdp";

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
g.innerWidth = 1600;
g.innerHeight = 900;
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
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(200, 0.5, 200).setTranslation(0, -0.5, 0), world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 300);
  scene.add(camera);
  const dt = 1 / 60;

  // ---- key map ---------------------------------------------------------------
  {
    check("crouch = Ctrl only (slot 6, C is radio)", PB_KEYS.crouch.every((c) => c.startsWith("Control")) && !(PB_KEYS.crouch as readonly string[]).includes("KeyC"));
    check("walk Shift, jump Space, reload R, Q last, G drop, B ext, T change",
      PB_KEYS.walk[0] === "ShiftLeft" && PB_KEYS.jump[0] === "Space" && PB_KEYS.reload[0] === "KeyR" && PB_KEYS.lastWeapon[0] === "KeyQ" &&
      PB_KEYS.drop[0] === "KeyG" && PB_KEYS.extension[0] === "KeyB" && PB_KEYS.changeWeapon[0] === "KeyT");
    check("radio Z X C, slots 1-6", PB_KEYS.radio.join() === "KeyZ,KeyX,KeyC" && PB_KEYS.slots.join() === "Digit1,Digit2,Digit3,Digit4,Digit5,Digit6");
    const cam = new THREE.PerspectiveCamera();
    const down = new Set<string>();
    const input = { lookDX: 0, lookDY: 0, key: (c: string) => down.has(c), keyPressed: () => false } as unknown as Input;
    const p = new Player(world, RAPIER, cam, new THREE.Vector3(0, 0, 0), input);
    p.teleportFeet(new THREE.Vector3(5, 0, 5), 0);
    const step = (n: number) => { for (let i = 0; i < n; i++) { p.update(dt, { move: true, look: false }); world.timestep = dt; world.step(); } };
    step(30);
    down.add("KeyC"); step(5);
    check("player: C does not crouch", !p.isCrouching());
    down.delete("KeyC"); down.add("ControlLeft"); step(5);
    check("player: LCtrl crouches", p.isCrouching());
    down.clear(); step(5);
    world.removeCollider(p.collider, false);
  }

  const mk = async (primary: number) => {
    const ws = new WeaponSystem({ scene, camera, world, RAPIER, viewmodel: false, audioListener: any, resolveTarget: () => null,
      loadout: { primary, secondary: 202022, melee: 301001, grenade: 407001 }, applyLook: () => {} });
    await ws.ready;
    ws.rng = () => 0.5;
    const W = ws as any;
    const step = (inp: Partial<WeaponInput> = {}, n = 1) => { for (let i = 0; i < n; i++) ws.update(dt, { fire: false, aim: false, grounded: true, speed: 0, ...inp }); };
    step({}, 120);
    return { ws, W, step };
  };

  // ---- G drop -> pick-up keeps the rounds --------------------------------------
  const A = await mk(103015); // AK-47 SOPMOD
  const B = await mk(104001); // MP5K
  {
    A.step({ fire: true }, 20);
    A.step({}, 30);
    const before = A.ws.getHudState();
    check("A fired: fewer rounds loaded", before.ammo < before.magSize, `${before.ammo}/${before.magSize} + ${before.reserve}`);
    A.step({ fire: true }, 2);
    check("no drop while the weapon is in its Fire state (0x623040 == 2)", A.ws.dropCurrent() === null);
    A.step({}, 30);
    const d = A.ws.dropCurrent();
    check("G drops the primary with its rounds", !!d && d.slot === 0 && d.def.id === 103015 && d.ammo === before.ammo - 1 && d.reserve === before.reserve,
      d ? `${d.ammo} + ${d.reserve}` : "null");
    check("primary slot now empty, pistol drawn", A.ws.slotEmpty(0) && A.W.cur === 1);
    A.step({}, 60);
    A.W.cur = 2; // knife in hand
    check("knife is not droppable (slot <= 1 only)", A.ws.dropCurrent() === null && A.ws.dropCurrent(true) === null);
    A.W.cur = 1;

    const field = new DropField();
    const w = field.add({ weaponId: d!.def.id, slot: 0, ammo: d!.ammo, extra: 0, reserve: d!.reserve, pos: { x: 0, y: 0, z: 0 }, owner: "A", local: true, death: false });
    check("drop ring index from the counter", w.idx === 1 && !field.canDrop());
    // B already holds a primary: the search skips the primary drop and its secondary slot is taken
    check("B with both slots full: nothing picked", findPickup(field.drops.values(), { x: 0.2, y: 0, z: 0 }, (s) => B.ws.slotEmpty(s)) === null);
    const bd = B.ws.dropCurrent()!;
    B.step({}, 60);
    check("B out of range (1.2 m): nothing", findPickup(field.drops.values(), { x: 1.2, y: 0, z: 0 }, (s) => B.ws.slotEmpty(s)) === null);
    const got = findPickup(field.drops.values(), { x: 0.6, y: 0.1, z: 0.3 }, (s) => B.ws.slotEmpty(s));
    check("B walks over it (< 1 m, primary slot empty): picked", got === w);
    check("B pickUp keeps the dropped rounds", B.ws.pickUp(got!.weaponId, got!.ammo, got!.reserve) &&
      B.W.slots[0].def.id === 103015 && B.W.slots[0].ammo === d!.ammo && B.W.slots[0].reserve === d!.reserve, `${B.W.slots[0].ammo} + ${B.W.slots[0].reserve}`);
    field.remove(got!.idx);
    check("pickUp refuses a taken slot", !B.ws.pickUp(bd.def.id, bd.ammo, bd.reserve));
    A.ws.refill();
    check("respawn refill restores the own primary", A.W.slots[0]?.def.id === 103015 && A.W.slots[0].ammo === A.W.slots[0].def.loadedBullet);
    B.ws.refill();
    check("respawn refill: the picked-up gun gives way to the own MP5K", B.W.slots[0]?.def.id === 104001);
  }

  // ---- death drop: the weapon in hand --------------------------------------------
  {
    const C = await mk(105030);
    C.step({ fire: true }, 1);
    const dd = C.ws.dropCurrent(true);
    check("death drop: the primary in hand falls (even mid-shot)", !!dd && dd.slot === 0 && dd.def.id === 105030, dd ? `${dd.ammo} + ${dd.reserve}` : "null");
    C.ws.refill();
    C.ws.switchTo(1); C.step({}, 60);
    const dp = C.ws.dropCurrent(true);
    check("death drop with the pistol in hand: the pistol falls", !!dp && dp.slot === 1);
    check("death drop leaves the hand empty (no swap)", C.W.cur === 1 && C.ws.slotEmpty(1));
  }

  // ---- lifetime (0x67b010) ------------------------------------------------------
  {
    const mkD = (local: boolean, ammo = 10): DroppedWeapon => ({ idx: 0, weaponId: 1, slot: 0, ammo, extra: 0, reserve: 0, pos: { x: 0, y: 0, z: 0 }, owner: "x", local, death: false, t: 0, pickable: true, alpha: 1 });
    const run = (d: DroppedWeapon, until: number) => { let gone = -1; for (let t = 0; t < until; t += 0.05) if (stepDrop(d, 0.05) && gone < 0) { gone = d.t; break; } return gone; };
    const own = mkD(true);
    for (let i = 0; i < 205; i++) stepDrop(own, 0.05);
    check("owner copy: not pickable after 10 s, fading", !own.pickable && own.alpha < 1 && own.alpha > 0, `t ${own.t.toFixed(2)} a ${own.alpha.toFixed(2)}`);
    const tl = run(mkD(true), 20), tr = run(mkD(false), 20), te = run(mkD(true, 0), 20), ter = run(mkD(false, 0), 20);
    check("removed at 11 s (owner) / 12 s (others)", Math.abs(tl - 11) < 0.06 && Math.abs(tr - 12) < 0.06, `${tl.toFixed(2)} / ${tr.toFixed(2)}`);
    check("empty drop: removed at 2 s (owner) / 3 s (others)", Math.abs(te - 2) < 0.06 && Math.abs(ter - 3) < 0.06, `${te.toFixed(2)} / ${ter.toFixed(2)}`);
    const round = mkD(true);
    for (let i = 0; i < 400; i++) stepDrop(round, 0.05, false);
    check("round modes keep drops", round.pickable && round.alpha === 1);
    const f = new DropField(PB_DROP.serverMaxIndex);
    f.seen(25);
    check("drop counter wraps like Server.Match (> 25 -> 0)", f.nextIndex() === 0 && f.nextIndex() === 1);
    let search = 0;
    for (let i = 0; i < 60; i++) if (f.update(dt).search) search++;
    check("pick-up search every 0.25 s", search === 3 || search === 4, `${search} searches in 1 s`);
  }

  // ---- radio ------------------------------------------------------------------------
  {
    const strings = JSON.parse(fs.readFileSync(path.join(PUB, "assets/ui/strings/pt-BR.json"), "utf8")) as Record<string, string>;
    const m = new RadioMenu();
    check("Z opens CMD, digit 3 sends id 3", m.press("KeyZ").consumed && m.open === 0 && m.press("Digit3").send === 3 && m.open === null);
    check("digits pass through with no menu", !m.press("Digit2").consumed);
    m.press("KeyX");
    check("X: entry 9 does not exist (8 entries)", m.press("Digit9").send === null && m.open === 1);
    check("X -> C switches menus, C 9 = id 29", (m.press("KeyC"), m.open === 2) && m.press("Digit9").send === 29);
    m.press("KeyZ");
    check("0 closes the menu", m.press("Digit0").send === null && m.open === null);
    const all = [...Array(8)].map((_, i) => radioId(0, i + 1)).concat([...Array(8)].map((_, i) => radioId(1, i + 1)), [...Array(9)].map((_, i) => radioId(2, i + 1)), [31]);
    const missingText = all.filter((id) => { const r = parseRadioId(id); return !strings[radioStringKey(r.type, r.index)]; });
    check("every radio entry has its pt-BR text", !missingText.length, `${all.length} entries; CMD3 "${strings[radioStringKey(0, 3)]}", STT1 "${strings[radioStringKey(2, 1)]}"`);
    const missingSnd = all.flatMap((id) => { const r = parseRadioId(id); return (["Man", "Women"] as const).map((v) => radioSoundFile(r.type, r.index, v)!); })
      .filter((f) => !fs.existsSync(path.join(PUB, "assets/sfx/radio", f)));
    check("every radio entry has its Man / Women wav (0xd5b150 table names)", !missingSnd.length, missingSnd.slice(0, 3).join(" ") || radioSoundFile(0, 1)!);
    check("receiver: enemy radio ignored, team radio shown", !radioRule(3, 1, 0).show && radioRule(3, 0, 0).chat);
    check("grenade AUTO 1 (id 31): voice, no chat line", radioRule(31, 0, 0).sound && !radioRule(31, 0, 0).chat);
  }

  // ---- wire -----------------------------------------------------------------------------
  {
    const drop = { ammo: 17, extra: 0, reserve: 90, flags: dropFlags(0, true), weaponId: 103015 };
    const rec = encodeUserAction(3, { hp: 0, weapon: { weaponId: 202022 }, drop, radio: { id: 21, area: 0 } });
    const [a] = decodeActions(rec);
    check("drop record: DropWeapon + RadioChat, no WeaponSync (CheckDataFlags)",
      (a.flags & Ev.DropWeapon) !== 0 && (a.flags & Ev.RadioChat) !== 0 && (a.flags & Ev.WeaponSync) === 0);
    check("drop body 19 B round trip", !!a.drop && a.drop.ammo === 17 && a.drop.reserve === 90 && a.drop.weaponId === 103015 && rec.length === 9 + 2 + 2 + 19,
      `record ${rec.length} B`);
    check("radio round trip", a.radio?.id === 21);
    const relayed = parseDropFlags(drop.flags + 7); // Server.Match: Flags + DropCounter
    check("server counter lands in the index bits", relayed.idx === 7 && relayed.death && relayed.slot === 0);
    const [p] = decodeActions(encodeUserAction(4, { pickup: { ...drop, flags: dropFlags(0, false, 7) } }));
    check("pick-up (GetWeaponForClient) names the drop index", (p.flags & Ev.GetWeaponForClient) !== 0 && parseDropFlags(p.pickup!.flags).idx === 7);
  }

  console.log(fails ? `\n${fails} FAILED` : "\nall ok");
  process.exit(fails ? 1 : 0);
})();
