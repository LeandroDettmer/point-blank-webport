// node --experimental-transform-types src/game/dev/mapProps.smoke.node.ts
// Breakable map props: damage -> break (colliders swapped for the broken state's), blast, reset. Synthetic props.json / GLBs.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";

// the game sources import without extension (vite): resolve them to .ts here
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith(".") && ctx.parentURL && !/\.\w+$/.test(spec)) {
      const f = new URL(spec + ".ts", ctx.parentURL);
      if (existsSync(fileURLToPath(f))) return next(f.href, ctx);
    }
    return next(spec, ctx);
  },
});
const { loadMapProps, propBreakSound, propBreakInfo, propSoundFiles } = await import("../mapProps.ts");

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.8, z: 0 });

const box = () => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
const scenes: Record<string, () => { scene: THREE.Group }> = {
  "/g.glb": () => ({ scene: new THREE.Group().add(box()) }),
  "/g_s1.glb": () => ({ scene: new THREE.Group().add(box()) }),
  "/c.glb": () => ({ scene: new THREE.Group().add(box()) }),
};
const loader = { loadAsync: async (u: string) => scenes[u]() } as never;
const boxes = (h: number) => ({ kind: "boxes" as const, boxes: [{ center: [0, 0, 0] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number], half: [h, h, h] as [number, number, number] }] });
const json = {
  source: "synthetic",
  objects: {
    glass: { id: "glass", glb: "/g.glb", life: 70, stateCount: 2, breakable: true, states: ["a", "b"], collision: boxes(1), bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      brokenStates: [{ state: 1, glb: "/g_s1.glb", collision: { kind: "none" } }] },
    crate: { id: "crate", glb: "/c.glb", life: 100, stateCount: 2, breakable: true, states: ["a"], collision: boxes(1), bounds: { min: [-1, -1, -1], max: [1, 1, 1] } },
    barrel: { id: "barrel", glb: "/c.glb", life: 10, stateCount: 2, breakable: true, states: ["a"], collision: boxes(1), bounds: { min: [-1, -1, -1], max: [1, 1, 1] }, explosion: { damage: 500, range: 6 } },
    wall: { id: "wall", glb: "/c.glb", life: null, stateCount: 1, breakable: false, states: ["a"], collision: boxes(1) },
    // sounds: a looping clip (state 0), a repeating generator, a breakable whose break clip is in state 1, a sound-only marker
    torch: { id: "torch", life: null, stateCount: 1, breakable: false, states: ["a"], stateSounds: [{ cycle: null, sounds: [{ clip: "torch.wav", t: 0, loop: true, dur: 2, vol: 100, lvol: 100, min: 2, max: 7 }] }] },
    subway: { id: "subway", life: null, stateCount: 1, breakable: false, states: ["a"], stateSounds: [{ cycle: 10, sounds: [{ clip: "warn.wav", t: 3, loop: false, vol: 35, lvol: 45, min: 8, max: 65 }, { clip: "train.wav", t: 6, loop: false, vol: 65, lvol: 75, min: 8, max: 65 }] }] },
    taxi: { id: "taxi", glb: "/c.glb", life: 50, stateCount: 2, breakable: true, states: ["a"], collision: boxes(1), stateSounds: [{ cycle: null, sounds: [{ clip: "hum.wav", t: 0, loop: true, dur: 4, vol: 100, lvol: 100, min: 3, max: 50 }] }, { cycle: null, sounds: [{ clip: "boom.wav", t: 0, loop: false, vol: 90, lvol: 90, min: 5, max: 40 }] }] },
    marker: { id: "marker", glb: "/boom.glb", life: null, stateCount: 1, breakable: false, states: ["Object/event/sound_sign.I3S"] },
  },
  props: [
    { name: "g0", object: "glass", pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
    { name: "g1", object: "glass", pos: [10, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
    { name: "c0", object: "crate", pos: [20, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
    { name: "b0", object: "barrel", pos: [40, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
    { name: "c1", object: "crate", pos: [44, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
    { name: "w0", object: "wall", pos: [30, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
    { name: "t0", object: "torch", pos: [100, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
    { name: "s0", object: "subway", pos: [110, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
    { name: "x0", object: "taxi", pos: [120, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
    { name: "m0", object: "marker", pos: [130, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
  ],
};
(globalThis as { fetch: unknown }).fetch = async () => ({ ok: true, headers: { get: () => "application/json" }, json: async () => json });

const mp = await loadMapProps("/props.json", loader, world, RAPIER);
assert.ok(mp);
world.step();
const cast = (x: number) => world.castRay(new RAPIER.Ray({ x, y: 0, z: -5 }, { x: 0, y: 0, z: 1 }), 20, true);
const handleAt = (x: number) => cast(x)?.collider.handle;
const broke: string[] = [];
const remoteFlags: boolean[] = [];
mp.onBreak = (p, remote) => { broke.push(p.name); remoteFlags.push(remote); };

// glass g0: 70 life, 30 dmg x3 -> broken on the 3rd, bullet then passes (broken state has no collision)
const h0 = handleAt(0)!;
assert.ok(h0 !== undefined);
assert.equal(mp.damage(h0, 30)?.broke, false);
assert.equal(mp.damage(h0, 30)?.broke, false);
assert.equal(mp.damage(h0, 30)?.broke, true);
assert.deepEqual(broke, ["g0"]);
world.step();
assert.equal(cast(0), null, "broken glass lets the ray through");
assert.ok(cast(10), "the other glass is intact");
assert.equal(mp.damage(h0, 30), null, "broken prop no longer takes damage");
// a crate without broken model vanishes; a non-breakable wall ignores damage
const hc = handleAt(20)!;
assert.equal(mp.damage(hc, 999)?.broke, true);
world.step();
assert.equal(cast(20), null);
assert.equal(mp.damage(handleAt(30)!, 999), null);
// blast: g1 centre 10 m from the blast, radius 12 -> takes 200 * (1 - 10/12) = 33
const g1 = mp.props.find((p) => p.name === "g1")!;
mp.blast(new THREE.Vector3(0, 0, 0), 12, 200);
assert.ok(g1.life! < 70 && g1.life! > 30, `g1 life ${g1.life}`);
mp.blast(new THREE.Vector3(10, 0, 0), 12, 200);
assert.ok(g1.broken);
// reset: everything intact again with colliders
mp.reset();
world.step();
assert.ok(cast(0) && cast(10) && cast(20), "colliders are back");
assert.equal(mp.props.filter((p) => p.broken).length, 0);
assert.equal(mp.damage(handleAt(0)!, 30)?.broke, false, "life reset to the def life");
// explosive barrel chain-breaks the crate 4 m away; breakIndex is the remote path (no re-send)
broke.length = 0; remoteFlags.length = 0;
world.step();
mp.damage(handleAt(40)!, 50);
assert.deepEqual(broke, ["b0", "c1"]);
mp.reset();
world.step();
broke.length = 0; remoteFlags.length = 0;
mp.breakIndex(mp.props.findIndex((p) => p.name === "g1"));
assert.deepEqual(broke, ["g1"]);
assert.deepEqual(remoteFlags, [true]);
mp.breakIndex(mp.props.findIndex((p) => p.name === "g1")); // already broken: no second event
assert.equal(broke.length, 1);

// ---- sounds ----
assert.equal(mp.group.children.some((o) => o.name === "m0"), false, "the sound_sign marker model is not drawn");
const played: string[] = [];
mp.onAmbient = (p, s) => played.push(`${p.name}:${s.clip}`);
const run = (sec: number, dt = 0.25) => { for (let t = 0; t < sec; t += dt) mp.update(dt); };
mp.reset(); // round start: the repeating generators restart
played.length = 0;
run(9.9);
const count = (k: string) => played.filter((x) => x === k).length;
assert.equal(count("s0:warn.wav"), 1, "generator: warn once at t=3 of the cycle");
assert.equal(count("s0:train.wav"), 1, "generator: train once at t=6");
assert.ok(count("t0:torch.wav") >= 4 && count("t0:torch.wav") <= 6, `2 s loop over 10 s: ${count("t0:torch.wav")}`);
assert.ok(count("x0:hum.wav") >= 2 && count("x0:hum.wav") <= 3, `4 s loop: ${count("x0:hum.wav")}`);
run(10); // second cycle
assert.equal(count("s0:warn.wav"), 2);
// break: the intact loop stops, the break clip is the state-1 one (not the ambient hum), with the object's own data
const taxi = mp.props.find((p) => p.name === "x0")!;
assert.equal(propBreakSound(taxi.def), "boom.wav");
assert.deepEqual(propBreakInfo(taxi.def), { min: 5, max: 40, vol: 90, lvol: 90 });
assert.deepEqual(propSoundFiles(taxi.def).sort(), ["boom.wav", "hum.wav"]);
mp.breakIndex(taxi.index);
played.length = 0;
run(8);
assert.equal(count("x0:hum.wav"), 0, "a broken prop no longer hums");
mp.reset();
played.length = 0;
run(8);
assert.ok(count("x0:hum.wav") >= 1, "it hums again after the reset");
console.log("mapProps smoke ok");
