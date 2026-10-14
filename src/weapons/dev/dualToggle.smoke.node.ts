// Node smoke: Extension2 Type "Dual" toggle (Kriss S.V 104013 <-> Dual Kriss 118001) on the real WeaponSystem.
//   npx esbuild src/weapons/dev/dualToggle.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/dt.mjs && node <tmp>/dt.mjs
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { WeaponSystem, dualFire } from "../WeaponSystem";
import { setFxTextureLoader } from "../effects";
import { setWeaponFx } from "../sights";

const any: any = new Proxy(function () {}, { get: () => any, apply: () => any, construct: () => any });
const g = globalThis as any;
g.document = any;
g.window = any;
g.AudioContext = any;
const PUB = path.resolve("public");
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(PUB, rel), "utf8"));
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

(async () => {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(60, 0.1, 60).setTranslation(0, -0.1, 0));
  world.step();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 300);
  camera.position.set(0, 1.6, 0);
  scene.add(camera);
  camera.updateMatrixWorld();
  setFxTextureLoader(() => new THREE.Texture());
  setWeaponFx(readJson("assets/weapons/fx/weaponfx.json"), "/assets/weapons/fx");
  const ws = new WeaponSystem({
    scene, camera, world, RAPIER, viewmodel: false, audioListener: any, loadout: {}, resolveTarget: () => null,
    applyLook: () => {},
  });
  await ws.ready;
  const W = ws as any;
  const dt = 1 / 60;
  const frame = (inp: Record<string, unknown> = {}) => { camera.updateMatrixWorld(); ws.update(dt, { fire: false, aim: false, ...inp } as any); };
  const idle = (n: number) => { for (let i = 0; i < n; i++) frame(); };
  W.audio.playAt = () => {};
  W.audio.play = () => {};

  const k = ws.db.def(104013)!, d = ws.db.def(118001)!;
  check("weapons.json links Kriss 104013 -> dual 118001 and back", k.pb?.dualId === 118001 && d.pb?.dualOf === 104013, `${k.pb?.dualId} ${d.pb?.dualOf}`);
  check("Dual Uzi (no Extension2 Dual) has no link", !ws.db.def(118004)!.pb?.dualId && ws.db.def(214004)!.pb?.dualId === undefined);

  ws.setLoadout({ primary: 104013, secondary: 202022, melee: 301001, grenade: 407001 });
  ws.refill();
  frame({ slot: 0 }); idle(90);
  const sw: number[] = [];
  ws.onSwitch((e) => sw.push(e.to.id));
  check("single Kriss in hand: 30 / 210, single fire", ws.getHudState().id === 104013 && ws.getHudState().ammo === 30 && dualFire(k) === null);
  frame({ fire: true }); idle(5);
  const a1 = ws.getHudState().ammo;
  check("single shot costs 1 round", a1 === 29, `${a1}`);

  frame({ extension2: true });
  const h = ws.getHudState();
  check("extension key -> Dual Kriss 118001 in the same slot, drawing (Change state)", h.id === 118001 && h.switching && sw.join() === "118001", `${h.id} sw=${sw}`);
  check("dual item: 60 round magazine, both guns", h.ammo === 60 && dualFire(d) === "both", `${h.ammo}`);
  frame({ fire: true });
  check("cannot fire while the dual is being drawn", ws.getHudState().ammo === 60);
  idle(90);
  frame({ extension2: true });
  check("toggle works again once the draw ended (dual -> single)", ws.getHudState().id === 104013, `${ws.getHudState().id}`);
  idle(90);
  check("back to single keeps its own magazine (29 / 210)", ws.getHudState().ammo === 29 && ws.getHudState().reserve === 210, `${ws.getHudState().ammo}/${ws.getHudState().reserve}`);

  // dual: fire, toggle back, toggle again keeps the dual magazine
  frame({ extension2: true }); idle(90);
  frame({ fire: true }); idle(5);
  const ad = ws.getHudState().ammo;
  check("dual shot costs 2 rounds [INFERIDO]", ad === 58, `${ad}`);
  frame({ extension2: true }); idle(90);
  frame({ extension2: true }); idle(90);
  check("dual magazine kept across a round trip", ws.getHudState().id === 118001 && ws.getHudState().ammo === 58, `${ws.getHudState().id} ${ws.getHudState().ammo}`);

  // gates: reload blocks the toggle, swap blocks it, a weapon with no link ignores it
  frame({ reload: true }); idle(2);
  frame({ extension2: true });
  check("toggle ignored during reload", ws.getHudState().id === 118001 && ws.getHudState().reloading);
  idle(260);
  frame({ slot: 1 }); idle(90);
  frame({ extension2: true });
  check("pistol without Extension2 Dual ignores the key", ws.getHudState().id === 202022);
  frame({ slot: 0 }); idle(90);
  ws.refill(); idle(2);
  check("refill (respawn) restores the owned single", ws.getHudState().slots.find((s) => s.slot === 0)?.id === 104013);

  console.log(fails ? `\n${fails} FAILED` : "\nall ok");
  process.exit(fails ? 1 : 0);
})();
