// Node smoke: ~5 simulated minutes of a bot match (20 bots firing, steps, hits, grenades, deaths) on a WebAudio stub whose
// sources END BY THEMSELVES after their buffer duration (the soundMix smoke only ends them by stop()). The voice pool
// (soundMix.claimVoice, 48 channels), the scene's 3D voices and the keyed fire channels must stay bounded; a context
// that stays suspended (autoplay policy) must not leave the pool full forever.
//   npx esbuild src/game/dev/audioLeak.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/leak.mjs && node <tmp>/leak.mjs
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import { WeaponAudio } from "../../weapons/audio";
import { WeaponDb } from "../../weapons/data";
import { CharSfx } from "../charSfx";
import { liveVoices, PbPositionalAudio, REAL_CHANNELS } from "../../gameplay/soundMix";

const PUB = path.resolve("public");
const g = globalThis as any;
g.Request = class { url: string; constructor(u: string) { this.url = u; } };
g.Headers = class {};
let failOnce = "";
g.fetch = async (req: any) => {
  const url = typeof req === "string" ? req : req.url;
  if (failOnce && url.endsWith(failOnce)) { failOnce = ""; return { ok: false, status: 503, headers: { get: () => "" }, arrayBuffer: async () => new ArrayBuffer(0) }; }
  const p = path.join(PUB, decodeURIComponent(url.replace(/^\//, "")));
  const ok = fs.existsSync(p);
  const buf = ok ? fs.readFileSync(p) : Buffer.alloc(0);
  return { ok, status: ok ? 200 : 404, headers: { get: () => "application/json" }, json: async () => JSON.parse(buf.toString("utf8")), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};
g.window = { addEventListener: () => {}, AudioContext: undefined as unknown };
g.localStorage = { getItem: () => null, setItem: () => {} };

class P { value = 1; setTargetAtTime(v: number) { this.value = v; } setValueAtTime(v: number) { this.value = v; } linearRampToValueAtTime(v: number) { this.value = v; } }
class N { connect(n: N) { return n; } disconnect() {} }
class Gn extends N { gain = new P(); }
class Pn extends N { setPosition() {} setOrientation() {} }
let now = 0, suspended = false;
const sources = new Set<Src>();
class Src extends N {
  buffer: { duration: number } | null = null; loop = false; playbackRate = new P(); detune = new P(); onended: (() => void) | null = null;
  endAt = Infinity;
  start() { this.endAt = now + (this.buffer?.duration ?? 0); sources.add(this); }
  stop() { if (!sources.delete(this)) return; const f = this.onended; f?.(); }
}
class Ctx {
  get currentTime() { return now; }
  destination = new N(); listener = { setPosition() {}, setOrientation() {} };
  get state() { return suspended ? "suspended" : "running"; }
  createGain() { return new Gn(); } createPanner() { return new Pn(); } createBufferSource() { return new Src(); }
  decodeAudioData(buf: ArrayBuffer, ok: (b: unknown) => void) {
    const d = 0.15 + (buf.byteLength % 1000) / 1000 * 2.5; // 0.15 .. 2.65 s
    const b = { duration: d, byteLength: buf.byteLength }; ok(b); return Promise.resolve(b);
  }
  resume() { suspended = false; return Promise.resolve(); }
}
g.window.AudioContext = Ctx;
/** advance the stub clock: sources past their end fire onended (never while the context is suspended) */
const advance = (dt: number) => {
  now += dt;
  if (suspended) return;
  for (const s of [...sources]) if (s.endAt <= now) { sources.delete(s); s.onended?.(); }
};

let fails = 0;
const check = (name: string, ok: boolean, info = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`); };
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

(async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  scene.add(camera);
  const listener = new THREE.AudioListener();
  camera.add(listener);
  const audio = new WeaponAudio(scene, camera, "/assets/weapons", listener);
  await audio.load();
  const db = new WeaponDb();
  await db.load("/assets/cross/weapons/weapons.json");
  const defs = [103004, 103001, 104001, 105001].map((id) => db.def(id)).filter((d): d is NonNullable<typeof d> => !!d);
  const gren = defs[0];
  // one clip's first fetch fails (dev server busy / restarting): it must not stay silent for the session
  const flaky = (audio as any).fireClip(defs[3]) as string;
  failOnce = flaky;
  await audio.preloadMatch(defs);
  const ch = new CharSfx(scene, listener);
  await new Promise((r) => setTimeout(r, 50));
  const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

  const BOTS = 20, DT = 1 / 60;
  const pos = Array.from({ length: BOTS }, () => new THREE.Vector3(rnd(-60, 60), 0, rnd(-60, 60)));
  const sample = (label: string) => {
    const pa = scene.children.filter((c) => c instanceof PbPositionalAudio).length;
    console.log(`${label.padEnd(10)} voices=${liveVoices()} sources=${sources.size} scene3D=${pa} keyed=${(audio as any).keyed.size}`);
    return { v: liveVoices(), s: sources.size, pa, k: (audio as any).keyed.size };
  };
  const run = async (sec: number, tag: string) => {
    const out: ReturnType<typeof sample>[] = [];
    for (let f = 0, n = Math.round(sec / DT); f < n; f++) {
      advance(DT);
      for (let b = 0; b < BOTS; b++) {
        const p = pos[b];
        if (Math.random() < 0.5 * 10 * DT) audio.fireAt(defs[b % defs.length], p, `bot${b}`);
        if (Math.random() < 2.5 * DT) ch.step(p, 1, Math.random() < 0.5);
        if (Math.random() < 0.15 * DT) { ch.hurt(p, true); ch.death?.(p, false, false); }
        if (Math.random() < 0.3 * DT) audio.hitAt(Math.random() < 0.5 ? 1 : "Human", p);
      }
      if (Math.random() < 0.2 * DT) { audio.bounce(gren, pos[0], 1); audio.explode(gren, pos[1], "grenade"); }
      if (Math.random() < 10 * DT) audio.fire(defs[0]);
      scene.updateMatrixWorld(true);
      await tick();
      if (f % Math.round(30 / DT) === 0) out.push(sample(`${tag} ${(f * DT) | 0}s`));
    }
    return out;
  };

  const s1 = await run(300, "t");
  const maxV = Math.max(...s1.map((x) => x.v)), maxS = Math.max(...s1.map((x) => x.s)), maxA = Math.max(...s1.map((x) => x.pa));
  check(`5 min: voices bounded (<= ${REAL_CHANNELS})`, maxV <= REAL_CHANNELS, `max ${maxV}`);
  const mean = (a: { v: number }[]) => a.reduce((t, x) => t + x.v, 0) / a.length, h = s1.length >> 1;
  check("5 min: voice count does not climb (2nd half mean <= 1st half mean + 6)", mean(s1.slice(h)) <= mean(s1.slice(1, h)) + 6, `${mean(s1.slice(1, h)).toFixed(1)} -> ${mean(s1.slice(h)).toFixed(1)}`);
  check("5 min: live sources and scene 3D voices bounded", maxS <= 120 && maxA <= 120, `sources ${maxS} scene3D ${maxA}`);
  // let everything end: nothing may stay held
  await run(5, "drain");
  for (let i = 0; i < 400; i++) { advance(0.05); await tick(); }
  check("silence -> every voice released (pool empty, no source, no scene voice)", liveVoices() === 0 && sources.size === 0 && !scene.children.some((c) => c instanceof PbPositionalAudio), `voices ${liveVoices()} sources ${sources.size}`);

  const flakyPlays = async () => { const n0 = sources.size; audio.play(flaky); await tick(); await new Promise((r) => setTimeout(r, 30)); return sources.size > n0; };
  check("clip whose first load failed: silent right after (cached failure)", !(await flakyPlays()));
  await new Promise((r) => setTimeout(r, 2300));
  let again = false;
  for (let i = 0; i < 20 && !again; i++) again = await flakyPlays();
  check("...but plays once the retry window passed", again);

  // context suspended mid-match (tab hidden / autoplay): sources never end
  suspended = true;
  await run(20, "susp");
  const held = liveVoices();
  console.log(`suspended 20 s: voices held ${held}`);
  suspended = false;
  advance(10); // the context resumes: held sources end
  await tick();
  const after = await run(15, "resumed");
  check("context suspended 20 s then resumed -> pool recovers", liveVoices() < REAL_CHANNELS, `voices ${liveVoices()} (held ${held})`);
  void after;
  process.exit(fails ? 1 : 0);
})();
