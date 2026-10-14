// Node smoke: the FPS observer's arms play the watched player's one-shot clips (real arms / weapon GLBs + 1PV tables from
// public/assets). Bug: game.ts observeArms calls observePlant(false) every frame and ArmsRig.plant(false) dropped whatever
// one-shot ran, so his shot (Attack), knife swing (Attack_A) and throw were cut on the frame they started.
//   npx esbuild src/weapons/dev/observeClips.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/oc.mjs && node <tmp>/oc.mjs
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { WeaponSystem } from "../WeaponSystem";
import { setViewmodelChara } from "../viewmodel";
import { C4_ITEM_ID } from "../mission";

const any: any = new Proxy(function () {}, {
  get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : k === "then" ? undefined : any),
  apply: () => any,
  construct: () => any,
  set: () => true,
});
const g = globalThis as any;
g.document = any;
g.window = any;
g.self = globalThis;
g.AudioContext = any;
g.ProgressEvent = class { constructor(public type: string, o: object) { Object.assign(this, o); } };
g.location = { search: "" };
const PUB = path.resolve("public");
const NativeResponse = Response;
g.Request = class { url: string; constructor(u: string) { this.url = u; } };
g.fetch = async (req: any) => {
  const url = String(typeof req === "string" ? req : req.url);
  const p = path.join(PUB, decodeURIComponent(url.replace(/^\//, "").split("?")[0]));
  if (!fs.existsSync(p)) return new NativeResponse("", { status: 404 });
  return new NativeResponse(fs.readFileSync(p), { headers: { "content-type": url.endsWith(".json") ? "application/json" : "application/octet-stream" } });
};
// textures: no decoder in Node, a 1x1 stand-in (the clips are what is tested)
THREE.ImageLoader.prototype.load = function (_url: string, onLoad?: (i: unknown) => void) {
  const img = { width: 1, height: 1 };
  setTimeout(() => onLoad?.(img), 0);
  return img as never;
} as never;
const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`);
};

(async () => {
  if (!fs.existsSync(path.join(PUB, "assets/chars/index.json"))) { console.log("skip: public/assets missing"); process.exit(0); }
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 300);
  scene.add(camera);
  setViewmodelChara(602009, 1); // spectator: Hide (blue)
  const ws = new WeaponSystem({ scene, camera, world, RAPIER, audioListener: any, resolveTarget: () => null, loadout: {} });
  await ws.ready;
  const vm = ws.viewmodel as any;
  // one frame in game.ts order: observeArms (shot event, then observePlant + observeState every frame) -> WeaponSystem.update
  let plant = false;
  const frame = (shot?: () => void) => {
    shot?.();
    ws.observePlant(plant, 0.5);
    ws.observeState({ speed: 0, grounded: true, aiming: false, reloadT: -1 });
    ws.update(1 / 60, { fire: false, aim: false, grounded: true } as never);
  };
  const frames = (n: number) => { for (let i = 0; i < n; i++) frame(); };
  const mount = async (id: number, swap = false) => {
    ws.observe({ id, chara: 601007, team: 0 }, { swap }); // watched: D-Fox (red), other arms than the spectator's
    await flush(100);
    for (let i = 0; i < 300 && !(vm.rigActive && vm.rig?.pb && vm.lastDef?.id === id); i++) { await flush(); frame(); }
    frames(200); // past the draw / shot gap
    return vm.rigActive && vm.rig?.pb;
  };
  // the running one-shot (null = stance) and its weight
  const shot = () => { const a: THREE.AnimationAction | null = vm.rig.shot; return a ? `${a.getClip().name} w${a.getEffectiveWeight().toFixed(2)}` : "-"; };
  const playing = (re: RegExp) => { const a: THREE.AnimationAction | null = vm.rig.shot; return !!a && re.test(a.getClip().name) && a.getEffectiveWeight() > 0.9 && a.time > 0; };

  const lo = ws.db.defaultLoadout;
  const rifle = ws.db.def(lo.primary)!, knife = ws.db.def(lo.melee)!, nade = ws.db.def(lo.grenade)!;

  check(`rifle ${rifle.name}: arms + 1PV tables mounted`, !!(await mount(rifle.id)));
  frame(() => ws.observeFire());
  frames(6);
  check("rifle: his shot plays the Attack clip", playing(/Attack/), shot());

  check(`knife ${knife.name}: mounted`, !!(await mount(knife.id, true)));
  frame(() => ws.observeFire(false));
  frames(10);
  check("knife: light swing plays Attack_A", playing(/Attack_A$/), shot());
  frames(120);
  frame(() => ws.observeFire(true));
  frames(10);
  check("knife: heavy swing plays SecondaryAttack (Attack_Stab)", playing(/Stab/), shot());

  check(`grenade ${nade.name}: mounted`, !!(await mount(nade.id, true)));
  ws.observeReady(true);
  frames(10);
  check("grenade: pin out holds AttackReady", !!vm.rig.shot && vm.rig.shot.getClip() === vm.rig.st("AttackReady")?.c, shot());
  frame(() => ws.observeFire());
  frames(10);
  check("grenade: the throw plays its Attack clip", !!vm.rig.shot && vm.rig.shot.getClip() === vm.rig.st("Attack")?.c && vm.rig.shot.time > 0, shot());

  // C4 install: the hold keeps the Install clip, the release drops it once
  if (await mount(C4_ITEM_ID, true)) {
    plant = true;
    frames(30);
    check("C4: plant hold plays Install (the AI's Attack)", !!vm.rig.shot && vm.rig.shot.getClip() === vm.rig.st("Attack")?.c, shot());
    plant = false;
    frames(1);
    check("C4: release drops it", !vm.rig.shot, shot());
  } else console.log("skip C4: no 1PV tables");

  ws.observe(null);
  console.log(fails ? `\n${fails} FAILED` : "\nall ok");
  process.exit(fails ? 1 : 0);
})();
