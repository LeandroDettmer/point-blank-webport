// Node smoke test: the first-person arms across Bomb Mission rounds with the observer in between (bug: the round after a
// dead + spectate-switch showed a bot's basic character arms, hands higher, until the next respawn).
// Real WeaponSystem + Viewmodel; the GLB loads are deferred by hand (GLTFLoader.loadAsync patched) so the order they finish in
// is the test's: a spectate target's arms that load slower than the own arms on respawn must not end up on screen.
//   npx esbuild src/weapons/dev/observeArms.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/oa.mjs && node <tmp>/oa.mjs
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { WeaponSystem } from "../WeaponSystem";
import { getViewmodelChara, setViewmodelChara } from "../viewmodel";

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
g.location = { search: "" };
const PUB = path.resolve("public");
g.fetch = async (url: string) => {
  const p = path.join(PUB, String(url).replace(/^\//, ""));
  if (!fs.existsSync(p)) return new Response("", { status: 404 });
  return new Response(fs.readFileSync(p), { headers: { "content-type": url.endsWith(".json") ? "application/json" : "application/octet-stream" } });
};

// every GLB load waits until the test settles it; arms GLBs get a fake rig (hand dummy + one clip), weapon GLBs fail (no model)
type Pending = { url: string; settle(): void };
const pending: Pending[] = [];
GLTFLoader.prototype.loadAsync = function (url: string) {
  return new Promise((resolve, reject) => {
    pending.push({
      url,
      settle: () => {
        if (!url.endsWith("arms_1pv.glb")) return reject(new Error("no weapon model in the smoke"));
        const scene = new THREE.Group();
        const hand = new THREE.Object3D();
        hand.name = "WeaponPointDummyRight";
        scene.add(hand);
        resolve({ scene, animations: [new THREE.AnimationClip(`assault/Idle ${url}`, 1, [])] } as never);
      },
    });
  });
} as never;
const settle = (re: RegExp) => {
  for (let i = pending.length - 1; i >= 0; i--) if (re.test(pending[i].url)) pending.splice(i, 1)[0].settle();
};
const flush = () => new Promise((r) => setTimeout(r, 20));

let fails = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`);
};

(async () => {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 300);
  scene.add(camera);
  // local player: Hide (602009, blue, female: swat_female clips); Game.create sets the pair before the WeaponSystem
  setViewmodelChara(602009, 1);
  const ws = new WeaponSystem({ scene, camera, world, RAPIER, audioListener: any, resolveTarget: () => null, loadout: {} });
  await ws.ready;
  const vm = ws.viewmodel as unknown as { rig: { clips: Map<string, unknown> } | null; anim1pv: string };
  const arms = () => (vm.rig ? [...vm.rig.clips.keys()][0]?.replace(/^assault\/Idle /, "") : "none");
  const anim = () => vm.anim1pv;
  await flush();
  settle(/arms_1pv/);
  await flush();
  check("round 1: own arms (Hide)", arms() === "/assets/chars/hide/arms_1pv.glb" && anim() === "/assets/chars/swat_female/anim1pv", `${arms()} ${anim()}`);

  // bots: no character (Actor.chara undefined) -> the watched team's basic character
  const botRed = { id: 103037, team: 0 as const }, botBlue = { id: 103037, team: 1 as const };
  for (let round = 2; round <= 4; round++) {
    // dead: FPS observer on a red bot (its arms load), then the spectate key to a blue bot just before the round ends
    ws.observe(botRed);
    await flush();
    settle(/arms_1pv/);
    await flush();
    check(`round ${round} dead: watched red bot -> red basic arms (Rebel Male)`, arms() === "/assets/chars/rebel_male/arms_1pv.glb", arms());
    ws.observe(botBlue);
    ws.observe(botRed);
    await flush(); // the red bot's arms are still downloading when the round ends
    // respawn (endObserver -> setSpecTarget(null) -> observe(null)): the own arms come from the cache first, the spectate load after
    ws.observe(null);
    await flush();
    settle(/hide\/arms_1pv/);
    await flush();
    settle(/arms_1pv/);
    await flush();
    check(`round ${round + 1} alive: own arms back after spectate switch`, arms() === "/assets/chars/hide/arms_1pv.glb" && anim() === "/assets/chars/swat_female/anim1pv", `${arms()} ${anim()}`);
    check(`round ${round + 1}: viewmodel chara still the local one`, getViewmodelChara()?.itemId === 602009 && getViewmodelChara()?.team === 1, JSON.stringify(getViewmodelChara()));
  }

  // ---- observed actions: quick swap / reload / knife / grenade drive the arms (weapon models fail to load here: the state, not the pixels) ----
  const lo = ws.db.defaultLoadout;
  const rifle = ws.db.def(lo.primary)!, knife = ws.db.def(lo.melee)!, nade = ws.db.def(lo.grenade)!;
  const vmx = ws.viewmodel as unknown as { throwT: number; throwReady: boolean; throwTotal: number; reloadT: number; switchT: number };
  const step = (n = 1, s = { speed: 0, grounded: true, aiming: false, reloadT: -1 }) => {
    for (let i = 0; i < n; i++) { ws.observeState(s); ws.update(1 / 60, { fire: false, aim: false, grounded: true } as never); }
  };
  const idle = { speed: 0, grounded: true, aiming: false, reloadT: -1 };
  check("fixture: rifle / knife / grenade resolved", !!rifle && !!knife && !!nade && knife.family === "KNIFE" && nade.family === "GRENADE");

  // quick swap while the watched player reloads: the swap draws (switchT < 1) and the cancelled reload no longer holds the Change clip
  ws.observe({ id: rifle.id, team: 1 });
  step(2, idle);
  check("reload: reloadSecs = the watched weapon's ReloadTime", ws.observedReloadSecs() === rifle.params.reloadTime, String(ws.observedReloadSecs()));
  step(5, { ...idle, reloadT: 0.4 });
  check("reload: reloadT drives the arms", vmx.reloadT === 0.4, String(vmx.reloadT));
  ws.observe({ id: knife.id, team: 1 }, { swap: true });
  step(1, idle); // game.ts clears reloadT on the swap (specReloadEnd = 0)
  check("quick swap: reload cancelled, Change draw runs (switchT < 1)", vmx.reloadT === -1 && vmx.switchT < 1, `reloadT ${vmx.reloadT} switchT ${vmx.switchT}`);
  step(120, idle);
  check("quick swap: draw ends", vmx.switchT === 1, String(vmx.switchT));
  ws.observe({ id: rifle.id, team: 1 }, { swap: true });
  step(1, idle);
  check("swap back (Q): draws again", vmx.switchT < 1, String(vmx.switchT));

  // knife: light and heavy swings are reproduced (observeFire -> meleeSwing); no muzzle flash path
  ws.observe({ id: knife.id, team: 1 });
  step(2, idle);
  const vmk = ws.viewmodel as unknown as { meleeSwing(h: boolean, i?: number, d?: boolean): void };
  const swings: boolean[] = [];
  const orig = vmk.meleeSwing.bind(vmk);
  vmk.meleeSwing = (h, i, d) => { swings.push(h); orig(h, i, d); };
  ws.observeFire(false);
  step(60, idle);
  ws.observeFire(true);
  check("melee: light then heavy swing reach the arms", swings.length === 2 && swings[0] === false && swings[1] === true, JSON.stringify(swings));
  vmk.meleeSwing = orig;

  // rifle: an observed shot reaches the arms' kick / Attack clip once per weapon cycle
  ws.observe({ id: rifle.id, team: 1 });
  step(200, idle);
  const kicks: number[] = [];
  const vmr = ws.viewmodel as unknown as { fireKick(s: number, l?: boolean | "both"): void };
  const origKick = vmr.fireKick.bind(vmr);
  vmr.fireKick = (s, l) => { kicks.push(s); origKick(s, l); };
  ws.observeFire();
  ws.observeFire();
  step(Math.ceil(rifle.fireDelay * 60) + 2, idle);
  ws.observeFire();
  check("rifle: observed shots kick the arms (1 per cycle)", kicks.length === 2, JSON.stringify(kicks));
  vmr.fireKick = origKick;

  // grenade: pin out -> FireReady, the throw -> Attack clip (throwT 0..1, then -1), a swap drops a cut throw / pin
  ws.observe({ id: nade.id, team: 1 });
  step(180, idle); // past the knife's shot gap (obsNextFire)
  ws.observeReady(true);
  check("grenade: pin out (observeReady)", vmx.throwReady === true);
  ws.observeFire();
  check("grenade: throw clears the pin and starts the Attack clip", vmx.throwReady === false && vmx.throwTotal > 0);
  step(10, idle);
  check("grenade: throwT advances", vmx.throwT > 0 && vmx.throwT < 1, String(vmx.throwT));
  step(180, idle);
  check("grenade: throw ends (throwT -1)", vmx.throwT === -1, String(vmx.throwT));
  ws.observeFire();
  ws.observe({ id: rifle.id, team: 1 }, { swap: true });
  check("grenade: a swap drops the running throw", vmx.throwT === -1 && vmx.throwReady === false);
  ws.observe(null);

  console.log(fails ? `\n${fails} FAILED` : "\nall ok");
  process.exit(fails ? 1 : 0);
})();
