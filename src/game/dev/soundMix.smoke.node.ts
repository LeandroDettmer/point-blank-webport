// Node smoke: the sound mix of the 2017 client on a recording WebAudio stub.
//   * list data (Sound/*.RSC) reaches the clips: own K-2 shot 2D at 0.56, remote 3D at 0.56 from 5 m, muted past 75 m
//   * the effects gauge drives one bus every game sound goes through, live, and the flash duck no longer resets it
//   * one fire channel per weapon (FMOD_CHANNEL_REUSE): a burst does not stack its shots
//   * 48 real voices, bullet hits merged per terrain a frame (ReserveSoundPlay), steps 2D for the local character
//   npx esbuild src/game/dev/soundMix.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/mix.mjs && node <tmp>/mix.mjs
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import { WeaponAudio } from "../../weapons/audio";
import { WeaponDb } from "../../weapons/data";
import { FlashTinnitus } from "../../weapons/throwables";
import { CharSfx } from "../charSfx";
import { getSettings, saveSettings } from "../../gameplay/settings";
import { PbPositionalAudio, effectsBus, gain3D, liveVoices, namedInfo, REAL_CHANNELS, soundInfo } from "../../gameplay/soundMix";

const PUB = path.resolve("public");
const g = globalThis as any;
class FakeRequest { url: string; constructor(u: string) { this.url = u; } }
g.Request = FakeRequest;
g.Headers = class {};
g.fetch = async (req: string | FakeRequest) => {
  const url = typeof req === "string" ? req : req.url;
  const p = path.join(PUB, decodeURIComponent(url.replace(/^\//, "")));
  const ok = fs.existsSync(p);
  const buf = ok ? fs.readFileSync(p) : Buffer.alloc(0);
  return { ok, status: ok ? 200 : 404, headers: { get: () => "application/json" }, json: async () => JSON.parse(buf.toString("utf8")), arrayBuffer: async () => buf.buffer };
};
g.window = { addEventListener: () => {}, AudioContext: undefined as unknown };
g.localStorage = { getItem: () => null, setItem: () => {} };

// recording WebAudio stub: gains keep their value, nodes keep their outputs, sources fire onended on stop
class FakeParam { value = 1; setTargetAtTime(v: number) { this.value = v; } setValueAtTime(v: number) { this.value = v; } linearRampToValueAtTime(v: number) { this.value = v; } }
class FakeNode {
  out = new Set<FakeNode>();
  connect(n: FakeNode) { this.out.add(n); return n; }
  disconnect(n?: FakeNode) { if (n) this.out.delete(n); else this.out.clear(); }
}
class FakeGain extends FakeNode { gain = new FakeParam(); }
class FakePanner extends FakeNode {
  refDistance = 1; rolloffFactor = 1; maxDistance = 10000; distanceModel = "inverse"; panningModel = "";
  setPosition() {} setOrientation() {}
}
const sources: FakeSource[] = [];
class FakeSource extends FakeNode {
  buffer: unknown = null; loop = false; playing = false;
  playbackRate = new FakeParam();
  onended: (() => void) | null = null;
  start() { this.playing = true; sources.push(this); }
  stop() { this.playing = false; const f = this.onended; f?.(); }
}
class FakeAudioContext {
  currentTime = 0;
  destination = new FakeNode();
  listener = { setPosition() {}, setOrientation() {} };
  state = "running";
  createGain() { return new FakeGain(); }
  createPanner() { return new FakePanner(); }
  createBufferSource() { return new FakeSource(); }
  decodeAudioData(buf: ArrayBuffer, ok: (b: unknown) => void) { const b = { duration: 1, byteLength: buf.byteLength ?? 0 }; ok(b); return Promise.resolve(b); }
  resume() { return Promise.resolve(); }
}
g.window.AudioContext = FakeAudioContext;

let fails = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`);
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const tick = () => new Promise((r) => setTimeout(r, 30));
const playing = () => sources.filter((s) => s.playing);

(async () => {
  // ---- list data ----
  const k2 = namedInfo("WM_K2_FIRE");
  check("Sound/Weapon.RSC WM_K2_FIRE = min 5, max 75, vol 56, lvol 56", !!k2 && k2.min === 5 && k2.max === 75 && k2.vol === 56 && k2.lvol === 56, JSON.stringify(k2));
  check("soundInfo by file path (2017/.../WM_K2_FIRE.wav)", soundInfo("2017/AssaultRifle/K-2/WM_K2_FIRE.wav").vol === 56);
  check("footstep CH_Concrete_Left_1 = 2.5 / 25 / 40 / 50", JSON.stringify(namedInfo("ch_concrete_left_1")) === JSON.stringify({ min: 2.5, max: 25, vol: 40, lvol: 50 }));
  check("3D gain: full inside min, min/d past it (FMOD log rolloff)", near(gain3D(k2!, 3), 0.56) && near(gain3D(k2!, 20), 0.56 * 5 / 20));
  check("3D gain: muted at and past max (isAudioable)", gain3D(k2!, 75) === 0 && gain3D(k2!, 120) === 0);

  // ---- scene ----
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  scene.add(camera);
  const listener = new THREE.AudioListener();
  camera.add(listener);
  scene.updateMatrixWorld(true);
  const audio = new WeaponAudio(scene, camera, "/assets/weapons", listener);
  await audio.load();
  const db = new WeaponDb();
  await db.load("/assets/cross/weapons/weapons.json");
  const k2def = db.def(103004);
  check("K-2 (103004) in weapons.json", !!k2def);
  if (!k2def) process.exit(1);

  // ---- effects gauge = one bus, live; the flash duck stays on the listener gain ----
  const bus = effectsBus(listener.context) as unknown as FakeGain;
  const lg = (listener.gain as unknown as FakeGain).out;
  check("listener output goes through the effects bus", lg.has(bus) && lg.size === 1 && bus.out.has(listener.context.destination as unknown as FakeNode), `listener->${lg.size} bus->${bus.out.size}`);
  saveSettings({ ...getSettings(), sfxVolume: 50 });
  check("gauge 50 -> bus gain 0.5 (linear)", near(bus.gain.value, 0.5), String(bus.gain.value));
  new FlashTinnitus(listener).update({ active: false, alpha: 0 } as any);
  check("FlashTinnitus.update (every frame) leaves the gauge alone", near(bus.gain.value, 0.5) && near((listener.gain as unknown as FakeGain).gain.value, 1));
  saveSettings({ ...getSettings(), sfxVolume: 100 });

  // ---- own fire: 2D at lvol, one channel per weapon ----
  sources.length = 0;
  audio.fire(k2def);
  await tick();
  const first = playing();
  check("own shot: one 2D voice", first.length === 1 && !(scene.children.some((c) => c instanceof THREE.PositionalAudio)));
  const own = [...((first[0]?.out ?? new Set()) as Set<FakeNode>)][0] as FakeGain | undefined;
  check("own shot volume = WM_K2_FIRE listener volume 0.56", !!own && near(own.gain.value, 0.56), String(own?.gain.value));
  for (let i = 0; i < 12; i++) audio.fire(k2def);
  await tick();
  check("13 shots of one weapon -> still one live fire voice (FMOD_CHANNEL_REUSE)", playing().length === 1, `live ${playing().length}`);

  // ---- remote fire: 3D, per owner; past max distance it does not start ----
  sources.length = 0;
  audio.fireAt(k2def, new THREE.Vector3(10, 0, 0), "botA");
  audio.fireAt(k2def, new THREE.Vector3(12, 0, 0), "botB");
  await tick();
  const pas = scene.children.filter((c) => c instanceof PbPositionalAudio) as PbPositionalAudio[];
  check("two remote shooters -> two 3D voices", playing().length === 2 && pas.length === 2, `live ${playing().length}`);
  const pan = pas[0] && ((pas[0] as any).panner as FakePanner);
  check("3D voice: inverse rolloff from min 5, factor 1, volume 0.56", !!pan && pan.refDistance === 5 && pan.rolloffFactor === 1 && near((pas[0].gain as unknown as FakeGain).gain.value, 0.56));
  for (let i = 0; i < 5; i++) audio.fireAt(k2def, new THREE.Vector3(10, 0, 0), "botA");
  await tick();
  check("a burst of botA keeps one voice for botA", playing().length === 2, `live ${playing().length}`);
  sources.length = 0;
  audio.fireAt(k2def, new THREE.Vector3(100, 0, 0), "far");
  await tick();
  check("remote shot 100 m away (max 75) does not start", playing().length === 0);
  // a voice that ends up past max while playing goes silent (UpdateMuteState)
  const pa0 = pas[0];
  pa0.position.set(200, 0, 0);
  pa0.isPlaying = true;
  pa0.updateMatrixWorld(true);
  check("a playing 3D voice past max is muted", (pa0.gain as unknown as FakeGain).gain.value === 0);
  pa0.position.set(5, 0, 0);
  pa0.updateMatrixWorld(true);
  check("...and back in range it plays at its volume again", near((pa0.gain as unknown as FakeGain).gain.value, 0.56));

  // ---- 48 real voices ----
  const k2clip = (audio as any).fireClip(k2def) as string;
  for (let i = 0; i < 70; i++) audio.playAt(k2clip, new THREE.Vector3(1 + (i % 7), 0, 0));
  await tick();
  check(`70 clips at once -> ${REAL_CHANNELS} real voices (setSoftwareChannels 0x30)`, liveVoices() === REAL_CHANNELS, `live ${liveVoices()}`);
  check("...the two quietest (remote shots at 10 / 12 m) gave theirs up", !pas[0].isPlaying || !pas[1].isPlaying);
  for (const s of [...sources]) s.stop();
  await tick();

  // ---- bullet hits: one per terrain a frame ----
  sources.length = 0;
  for (let i = 0; i < 8; i++) audio.hitAt(1, new THREE.Vector3(3 + i, 0, 0)); // 8 pellets on concrete
  audio.hitAt(2, new THREE.Vector3(4, 0, 0));
  await tick();
  check("8 pellets on concrete + 1 on metal in one frame -> 2 hit sounds", playing().length === 2, `live ${playing().length}`);

  // ---- character sounds: local 2D at lvol, others 3D at vol; no second gauge factor ----
  for (const s of [...sources]) s.stop();
  saveSettings({ ...getSettings(), sfxVolume: 50 });
  const ch = new CharSfx(scene, listener);
  await tick();
  sources.length = 0;
  const before = scene.children.length;
  ch.step(new THREE.Vector3(0, -1.6, 0), 1, true, true);
  ch.step(new THREE.Vector3(8, 0, 0), 1, false);
  await tick();
  const added = scene.children.slice(before).filter((c) => c instanceof PbPositionalAudio) as PbPositionalAudio[];
  const gains = playing().map((s) => ([...s.out][0] as FakeGain | FakePanner));
  check("own step 2D + remote step 3D", playing().length === 2 && added.length === 1);
  const ownStep = gains.find((x) => x instanceof FakeGain) as FakeGain | undefined;
  check("own step volume = CH_Concrete lvol 0.5 (gauge only on the bus)", !!ownStep && near(ownStep.gain.value, 0.5), String(ownStep?.gain.value));
  check("remote step volume = vol 0.4", !!added[0] && near((added[0].gain as unknown as FakeGain).gain.value, 0.4));
  saveSettings({ ...getSettings(), sfxVolume: 100 });

  process.exit(fails ? 1 : 0);
})();
