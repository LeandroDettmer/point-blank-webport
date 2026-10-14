// Map ambient sound of the 2017 client.
// Not a global loop: each emitter is a zone. A live <Map>_Scene i3Evt (i3ActionPlaySound) is tied to Box_N i3Triggers; the
// sound is 3D (style 0x03040010: 3D + loop) with the i3SoundPlayInfo min / max distance and volume. Enter a box -> the
// layers start, leave every box of the emitter -> they stop [INFERIDO: Leave stops, i3Trigger::Leave not disassembled].
// The source sits at the centre of the box that holds the player [INFERIDO: the i3SoundNode is a child of the trigger].
// Madness is code, not map data: 4 announcer-path (2D) clips, one every 15 s, a 60 s cycle.
import * as THREE from "three";
import { assetKnown } from "../assetMap";
import { loadClip } from "../audioUrl";
import { PbPositionalAudio, audio2D, namedInfo, type SoundInfo } from "../gameplay/soundMix";

export interface AmbientBox { c: [number, number, number]; s: [number, number, number]; q?: [number, number, number, number] }
export interface AmbientLayer { file: string; loop: boolean; vol: number; lvol: number; min: number; max: number }
export interface AmbientEmitter { id: string; trigger: "zone"; boxes: AmbientBox[]; layers: AmbientLayer[] }
export interface AmbientJson { source: string; mapKey: string; emitters: AmbientEmitter[] }

/** Madness clips (Sound_Ambient_Madness), exported to sfx/ambient/madness by the same exporter */
export const MADNESS_CLIPS = [
  "madness_dropwater_ambient_ver1", "madness_dropwater_ambient_ver2", "madness_girlscream_ambient_ver1", "madness_girlscream_ambient_ver2",
];
/** the i3Trigger tests the character capsule: the point tested is this far above the feet [INFERIDO: capsule centre] */
const BODY_Y = 0.9;

const _l = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** p inside the box (GINS TRS of the unit cube: centre c, size s, rotation q when the box is not axis aligned) */
export function insideBox(b: AmbientBox, p: { x: number; y: number; z: number }): boolean {
  _l.set(p.x - b.c[0], p.y - b.c[1], p.z - b.c[2]);
  if (b.q) _l.applyQuaternion(_q.set(b.q[0], b.q[1], b.q[2], b.q[3]).invert());
  return Math.abs(_l.x) <= b.s[0] / 2 && Math.abs(_l.y) <= b.s[1] / 2 && Math.abs(_l.z) <= b.s[2] / 2;
}

/** the i3SoundPlayInfo of a layer as the mix data of soundMix (0..1 -> 0..100) */
export const layerInfo = (l: AmbientLayer): SoundInfo => ({ min: l.min, max: l.max, vol: l.vol * 100, lvol: l.lvol * 100 });

/** Which emitters hold the player: `update` returns the edges. `at` = the box that holds him (null = outside). */
export class ZoneTracker {
  readonly at = new Map<AmbientEmitter, AmbientBox>();
  constructor(readonly emitters: AmbientEmitter[]) {}

  update(p: { x: number; y: number; z: number } | null): { entered: AmbientEmitter[]; left: AmbientEmitter[] } {
    const entered: AmbientEmitter[] = [], left: AmbientEmitter[] = [];
    for (const e of this.emitters) {
      const box = p ? e.boxes.find((b) => insideBox(b, p)) : undefined;
      if (box) { if (!this.at.has(e)) entered.push(e); this.at.set(e, box); }
      else if (this.at.delete(e)) left.push(e);
    }
    return { entered, left };
  }
}

/** Madness clip schedule, 0x776cd0: timer += dt; plays when count * 15 < timer; flags of the 4 played; reset at 60 s with all 4 played. */
export class MadnessSchedule {
  private timer = 0;
  private count = 0;
  private flags = [false, false, false, false];
  constructor(private cursor = Math.floor(Math.random() * 4), private rand: () => number = Math.random) {}

  /** the clip index to start this frame, or -1 */
  tick(dt: number): number {
    this.timer += dt;
    let play = -1;
    if (this.count * 15 < this.timer) {
      this.cursor = (this.cursor + 1) % 4;
      play = this.cursor;
      this.flags[this.cursor] = true;
      this.count++;
    }
    if (this.flags.every(Boolean) && this.timer >= 60) {
      this.flags = [false, false, false, false];
      this.count = 1;
      this.timer = 0;
      this.cursor = Math.floor(this.rand() * 4);
    }
    return play;
  }
}

const loader = new THREE.AudioLoader();
const clips = new Map<string, Promise<AudioBuffer | null>>();
/** decoded once per file, shared by every AmbientAudio and the match preload */
function clip(url: string): Promise<AudioBuffer | null> {
  let p = clips.get(url);
  if (!p) clips.set(url, p = loadClip(loader, url).then((b) => b, () => null));
  return p;
}

const jsons = new Map<string, Promise<AmbientJson | null>>();
function ambientJson(base: string, mapKey: string): Promise<AmbientJson | null> {
  const url = `${base}/maps/${mapKey}/ambient.json`;
  let p = jsons.get(url);
  if (!p) {
    // prod: not in the asset map = no file (most maps have no live ambient evt): no 404 per match
    p = !assetKnown(url) ? Promise.resolve(null) : fetch(url).then(async (res) => {
      // vite serves index.html on any 404 in dev: only parse when the response really is JSON
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
      return (await res.json().catch(() => null)) as AmbientJson | null;
    }).catch(() => null);
    jsons.set(url, p);
  }
  return p;
}

const sfxUrl = (base: string, file: string) => `${base}/sfx/${file}`;

/** Match preload (game/matchPreload.ts): the map's ambient.json and its clips, plus the Madness clips when the mode is on. */
export async function preloadAmbient(base: string, mapKey: string, madness = false): Promise<void> {
  const json = await ambientJson(base, mapKey);
  await Promise.all([
    ...(json?.emitters ?? []).flatMap((e) => e.layers.map((l) => clip(sfxUrl(base, l.file)))),
    ...(madness ? MADNESS_CLIPS.map((n) => clip(sfxUrl(base, `ambient/madness/${n}.wav`))) : []),
  ]);
}

interface Playing { audio: PbPositionalAudio; layer: AmbientLayer }

export class AmbientAudio {
  private tracker: ZoneTracker | null = null;
  private playing = new Map<AmbientEmitter, Playing[]>();
  private madness: MadnessSchedule | null;
  private token = 0;

  /** `madness`: the match is a Madness one (the web has no such mode yet: game.ts passes false) */
  constructor(private scene: THREE.Scene, private listener: THREE.AudioListener, private base: string, madness = false) {
    this.madness = madness ? new MadnessSchedule() : null;
  }

  async loadMap(mapKey: string): Promise<void> {
    const tok = ++this.token;
    const json = await ambientJson(this.base, mapKey);
    if (!json || tok !== this.token) return;
    this.tracker = new ZoneTracker(json.emitters);
    await Promise.all(json.emitters.flatMap((e) => e.layers.map((l) => clip(sfxUrl(this.base, l.file)))));
  }

  /** every frame: `feet` = the local player's feet (null while dead / observing: outside every zone) */
  update(dt: number, feet: { x: number; y: number; z: number } | null): void {
    if (this.tracker) {
      const { entered, left } = this.tracker.update(feet && { x: feet.x, y: feet.y + BODY_Y, z: feet.z });
      for (const e of left) this.stop(e);
      for (const e of entered) this.start(e);
      for (const [e, voices] of this.playing) {
        const box = this.tracker.at.get(e);
        if (box) for (const v of voices) v.audio.position.set(box.c[0], box.c[1], box.c[2]);
      }
    }
    const i = this.madness?.tick(dt) ?? -1;
    if (i >= 0) this.playMadness(MADNESS_CLIPS[i]);
  }

  private start(e: AmbientEmitter): void {
    const tok = this.token;
    const voices: Playing[] = [];
    this.playing.set(e, voices);
    for (const layer of e.layers) {
      void clip(sfxUrl(this.base, layer.file)).then((buf) => {
        if (!buf || tok !== this.token || this.playing.get(e) !== voices) return; // left (or map changed) while decoding
        const a = new PbPositionalAudio(this.listener, layerInfo(layer));
        a.setBuffer(buf);
        a.setLoop(layer.loop);
        const box = this.tracker?.at.get(e);
        if (box) a.position.set(box.c[0], box.c[1], box.c[2]);
        this.scene.add(a);
        a.play();
        voices.push({ audio: a, layer });
      });
    }
  }

  private stop(e: AmbientEmitter): void {
    for (const v of this.playing.get(e) ?? []) {
      if (v.audio.isPlaying) v.audio.stop();
      this.scene.remove(v.audio);
    }
    this.playing.delete(e);
  }

  /** announcer path: 2D at the listener volume of the clip's list data */
  private playMadness(name: string): void {
    const tok = this.token;
    void clip(sfxUrl(this.base, `ambient/madness/${name}.wav`)).then((buf) => {
      if (!buf || tok !== this.token) return;
      const a = audio2D(this.listener, namedInfo(name) ?? { min: 1, max: 0, vol: 100, lvol: 100 });
      a.setBuffer(buf);
      a.play();
    });
  }

  /** stop and discard everything (map change, dispose) */
  dispose(): void {
    this.token++;
    for (const e of [...this.playing.keys()]) this.stop(e);
    this.tracker = null;
  }
}
