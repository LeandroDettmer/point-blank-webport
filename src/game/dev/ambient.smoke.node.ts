// Node smoke: map ambient zones (game/audio3d.ts) on the exported maps/<map>/ambient.json.
//   * insideBox: AABB and rotated box; ZoneTracker enter / stay / leave edges; box hand-over keeps the emitter on
//   * gain of a layer by distance (soundMix.gain3D with the i3SoundPlayInfo min / max): full inside min, min/d past it, 0 at max
//   * MadnessSchedule: 0 / 15 / 30 / 45 s first cycle, 4 distinct clips, reset at 60 s
//   npx --no-install tsx src/game/dev/ambient.smoke.node.ts
import fs from "node:fs";
import path from "node:path";
import { MadnessSchedule, ZoneTracker, insideBox, layerInfo, type AmbientJson } from "../audio3d";
import { gain3D } from "../../gameplay/soundMix";

let bad = 0;
const ok = (c: boolean, msg: string) => { if (!c) { bad++; console.error("FAIL", msg); } else console.log("ok  ", msg); };
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

// ---- boxes
const box = { c: [10, 2, -5] as [number, number, number], s: [4, 2, 6] as [number, number, number] };
ok(insideBox(box, { x: 10, y: 2, z: -5 }), "centre inside");
ok(insideBox(box, { x: 11.9, y: 2.9, z: -7.9 }), "corner region inside");
ok(!insideBox(box, { x: 12.1, y: 2, z: -5 }), "past x half-size outside");
ok(!insideBox(box, { x: 10, y: 3.1, z: -5 }), "past y half-size outside");
const rot = { ...box, q: [0, Math.SQRT1_2, 0, Math.SQRT1_2] as [number, number, number, number] }; // 90 deg about Y: x/z swap
ok(insideBox(rot, { x: 10, y: 2, z: -6.9 }) && !insideBox(rot, { x: 10, y: 2, z: -7.1 }), "rotated box: z extent = old x half (2)");
ok(insideBox(rot, { x: 12.9, y: 2, z: -5 }) && !insideBox(rot, { x: 13.1, y: 2, z: -5 }), "rotated box: x extent = old z half (3)");

// ---- tracker on a hand-made emitter with two boxes
const e = { id: "t", trigger: "zone" as const, boxes: [box, { c: [20, 2, -5] as [number, number, number], s: [4, 2, 6] as [number, number, number] }], layers: [{ file: "x.wav", loop: true, vol: 0.6, lvol: 0.6, min: 5, max: 50 }] };
const tr = new ZoneTracker([e]);
let r = tr.update({ x: 0, y: 0, z: 0 });
ok(r.entered.length === 0 && r.left.length === 0, "outside: no edge");
r = tr.update({ x: 10, y: 2, z: -5 });
ok(r.entered.length === 1 && tr.at.get(e) === e.boxes[0], "enter box 0");
r = tr.update({ x: 10.5, y: 2, z: -5 });
ok(r.entered.length === 0 && r.left.length === 0, "stay: no edge");
r = tr.update({ x: 20, y: 2, z: -5 });
ok(r.entered.length === 0 && r.left.length === 0 && tr.at.get(e) === e.boxes[1], "box 0 -> box 1: still inside, source moves");
r = tr.update({ x: 30, y: 2, z: -5 });
ok(r.left.length === 1 && !tr.at.has(e), "leave");
r = tr.update({ x: 10, y: 2, z: -5 });
r = tr.update(null);
ok(r.left.length === 1, "null position (dead) = left");

// ---- gain by distance (layer 0.6 vol, min 5, max 50)
const info = layerInfo(e.layers[0]);
ok(near(gain3D(info, 3), 0.6), "inside min: full volume");
ok(near(gain3D(info, 10), 0.3), "10 m: vol * min / d");
ok(gain3D(info, 50) === 0 && gain3D(info, 80) === 0, "at / past max: muted");

// ---- the exported maps
const maps = path.resolve("public/assets/maps");
for (const m of fs.existsSync(maps) ? fs.readdirSync(maps) : []) {
  const f = path.join(maps, m, "ambient.json");
  if (!fs.existsSync(f)) continue;
  const j = JSON.parse(fs.readFileSync(f, "utf8")) as AmbientJson;
  const t = new ZoneTracker(j.emitters);
  let all = true;
  for (const em of j.emitters) {
    const b = em.boxes[0];
    const inside = t.update({ x: b.c[0], y: b.c[1], z: b.c[2] }).entered.includes(em);
    t.update(null);
    all &&= inside && em.layers.every((l) => l.vol > 0 && fs.existsSync(path.resolve("public/assets/sfx", l.file)));
  }
  ok(all, `${m}: ${j.emitters.length} emitter(s), every box centre inside, clips on disk`);
}

// ---- Madness
const played: number[] = [];
const times: number[] = [];
const sch = new MadnessSchedule(0, () => 0); // cursor 0 -> clips 1,2,3,0
let t = 0;
for (let i = 0; i < 60 * 130; i++) { // 130 s at 60 Hz
  t += 1 / 60;
  const c = sch.tick(1 / 60);
  if (c >= 0) { played.push(c); times.push(Math.round(t)); }
}
ok(times.slice(0, 4).join() === "0,15,30,45", `first cycle at 0/15/30/45 s (${times.slice(0, 5).join()})`);
ok(new Set(played.slice(0, 4)).size === 4, `first four clips distinct (${played.slice(0, 4).join()})`);
ok(times.length >= 8 && times.slice(5, 9).join() === "75,90,105,120", `after the reset 15 s apart (${times.join()})`);

if (bad) { console.error(bad + " failed"); process.exit(1); }
console.log("ambient smoke ok");
