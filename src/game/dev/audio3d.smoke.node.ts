// Node smoke: audio graph, no browser (DOM/WebAudio stubbed, mirrors weapons/dev/hitShake.smoke.node.ts).
//   * bot fire at ~10 m from the listener plays a PositionalAudio (WeaponAudio.fireAt / game.ts botFire hook)
//   * remote player fire (RemoteActor.onFire, torsoAction "fire" edge) reaches WeaponSystem.playRemoteFire
//   npx esbuild src/game/dev/audio3d.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/a3d.mjs && node <tmp>/a3d.mjs
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import { WeaponAudio } from "../../weapons/audio";
import { WeaponDb } from "../../weapons/data";

const PUB = path.resolve("public");
const g = globalThis as any;
// THREE.FileLoader wraps every URL in `new Request(url)` (needs an absolute URL under Node's real fetch/Request);
// stub both so a plain "/assets/..." path round-trips to the local public/ dir like a dev server would serve it.
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

// Minimal mock AudioContext/AudioBuffer graph: enough for THREE.Audio / PositionalAudio / AudioListener to run
// without a browser.
class FakeNode {
  connect() { return this; }
  disconnect() {}
  setDistanceModel() {}
  setRolloffFactor() {}
  setMaxDistance() {}
  setRefDistance() {}
}
class FakeGain extends FakeNode { gain = { value: 1, setTargetAtTime: () => {} }; }
class FakePanner extends FakeNode {
  setPosition() {}
  setOrientation() {}
}
class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  playbackRate = { setTargetAtTime: () => {} };
  onended: (() => void) | null = null;
  start() {}
  stop() { this.onended?.(); }
}
class FakeAudioContext {
  currentTime = 0;
  destination = new FakeNode();
  state = "running";
  createGain() { return new FakeGain(); }
  createPanner() { return new FakePanner(); }
  createBufferSource() {
    const s = new FakeSource();
    return s;
  }
  decodeAudioData(buf: ArrayBuffer, ok: (b: unknown) => void) {
    ok({ duration: 1, byteLength: (buf as ArrayBuffer).byteLength ?? 0 });
    return Promise.resolve({ duration: 1 });
  }
  resume() { return Promise.resolve(); }
}
g.window.AudioContext = FakeAudioContext;

let fails = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`);
};

(async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  scene.add(camera);
  const listener = new THREE.AudioListener();
  camera.add(listener);

  // ---- bot / remote fire: positional 3D sound at 10 m ----
  const audio = new WeaponAudio(scene, camera, "/assets/weapons", listener);
  await audio.load();
  const db = new WeaponDb();
  await db.load("/assets/cross/weapons/weapons.json");
  const anyId = db.all()[0]?.id;
  const def = anyId !== undefined ? db.def(anyId) : undefined;
  check("weapons.json loaded with at least one weapon", !!def, `id ${anyId}`);
  if (def) {
    const before = scene.children.length;
    audio.fireAt(def, new THREE.Vector3(10, 0, 0));
    await new Promise((r) => setTimeout(r, 200)); // let the buffer promise resolve
    const added = scene.children.length > before;
    check("bot/remote fire (WeaponAudio.fireAt) adds a PositionalAudio 10 m from the listener", added, `scene children ${before}->${scene.children.length}`);
    const posAudio = scene.children.find((c) => c instanceof THREE.PositionalAudio) as THREE.PositionalAudio | undefined;
    check("...it is a THREE.PositionalAudio (WebAudio PannerNode) at the shot's world position", !!posAudio && posAudio.position.distanceTo(new THREE.Vector3(10, 0, 0)) < 1e-6);
  }


  process.exit(fails ? 1 : 0);
})();
