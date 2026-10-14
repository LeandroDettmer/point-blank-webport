// The planted C4 of the Bomb Mission: model, blinking light effect, the count beeps and the blast.
// Assets: weapons/models/c4.glb (the only C4 model), fx Bomb_Light_Red / Bomb (pb-extract-tools export-weaponfx.mjs), sfx/c4/*.wav
// (pb-extract-tools export-c4-sfx.mjs, roles [INFERIDO]), announce bombPlanted / bombExploded / bombRemoved.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { registerModelCompressedTextures } from "../render/compressedTex";
import type { WeaponEffects } from "../weapons/effects";
import { DEFAULT_INFO, PbPositionalAudio, audio2D, namedInfo } from "../gameplay/soundMix";
import { setC4Lcd } from "../weapons/c4Lcd";
import { loadClip, loadClipCb } from "../audioUrl";

const SFX = "/assets/sfx";

interface C4Sfx { roles: Record<string, string> }
/** c4.json role -> the Sound/Weapon.RSC clip it is (WM_C4_*.WAV: the pack names are encrypted) [INFERIDO] */
const C4_CLIP: Record<string, string> = {
  button: "wm_c4_button", take: "wm_c4_take", installed: "wm_c4_installed", disarmed: "wm_c4_disarmed", explosion: "wm_c4_explosion",
  countA: "wm_c4_count_a", countB: "wm_c4_count_b", countC: "wm_c4_count_c", countD: "wm_c4_count_d", countE: "wm_c4_count_e",
};

/** c4.glb parsed once for the session: one per BombVisual left its textures on the GPU every match */
let c4Model: Promise<THREE.Object3D | null> | null = null;
/** the model is loaded once, then cloned */
function loadC4Model(): Promise<THREE.Object3D | null> {
  return (c4Model ??= registerModelCompressedTextures(new GLTFLoader()).loadAsync("/assets/weapons/models/c4.glb").then((g) => g.scene).catch(() => null));
}
/** c4.json (role -> clip), fetched once */
let c4SfxP: Promise<C4Sfx | null> | null = null;
const c4Sfx = (): Promise<C4Sfx | null> => (c4SfxP ??= fetch(`${SFX}/c4/c4.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
/** decoded C4 clips by c4.json path, shared by every BombVisual and the match preload */
const clipCache = new Map<string, AudioBuffer>();
const clipLoader = new THREE.AudioLoader();

/** Match preload (game/matchPreload.ts, bomb mode only): c4.glb and the ten clips decoded, so the first plant / defuse / count has no load. */
export async function preloadBomb(): Promise<void> {
  const [sfx] = await Promise.all([c4Sfx(), loadC4Model()]);
  await Promise.all(Object.values(sfx?.roles ?? {}).filter((rel) => !clipCache.has(rel)).map((rel) =>
    loadClip(clipLoader, `${SFX}/${rel}`).then((b) => { clipCache.set(rel, b); }, () => {})));
}

export class BombVisual {
  private model: THREE.Object3D | null = null;
  private light: THREE.Object3D | null = null;
  private pos = new THREE.Vector3();
  private beepIn = 0;
  /** the last count clip (Count_E) plays once, ending with the blast */
  private fifthPlayed = false;
  private sfx: C4Sfx | null = null;

  constructor(private scene: THREE.Scene, private listener: THREE.AudioListener, private effects: WeaponEffects | null) {
    void c4Sfx().then((j) => { this.sfx = j; this.preload(); });
  }

  /**
   * One C4 clip: 2D (`at` null, listener volume) or 3D at `at` (volume, min / max distance), list data of the WM_C4_*
   * clip the role stands for (Sound/Weapon.RSC via gameplay/soundMix.ts; the role -> clip pairing is as [INFERIDO] as
   * the roles themselves). The effects gauge comes from the listener's group.
   */
  private play(role: string, at: THREE.Vector3 | null, track?: (a: THREE.Audio<GainNode | PannerNode>) => void): void {
    const rel = this.sfx?.roles[role];
    if (!rel) return;
    const go = (buf: AudioBuffer) => {
      const info = namedInfo(C4_CLIP[role]) ?? DEFAULT_INFO;
      const a: THREE.Audio<GainNode | PannerNode> = at ? new PbPositionalAudio(this.listener, info) : audio2D(this.listener, info);
      if (track) track(a);
      else if (role === "take" || role === "disarmed") this.installVoice = a;
      a.setBuffer(buf);
      if (at) {
        a.position.copy(at);
        this.scene.add(a);
        a.onEnded = () => { a.isPlaying = false; this.scene.remove(a); };
      }
      a.play();
    };
    const buf = clipCache.get(rel);
    if (buf) go(buf);
    else loadClipCb(clipLoader, `${SFX}/${rel}`, (b) => { clipCache.set(rel, b); go(b); }, () => {});
  }

  private installVoice: THREE.Audio<GainNode | PannerNode> | null = null;

  /**
   * The plant / defuse hold starts: WM_C4_Take plays for the whole hold (CGameMissionManager 0x585470 -> StartWeapon_C4StateSnd state 8 while
   * an install timer runs, stopped by 0x585bb0 when it ends), so it is in sync with the Install arm clip. `play("take")` is preloaded first
   * so the clip starts with the press, not after the first load.
   */
  startInstall(kind: "plant" | "defuse" = "plant"): void {
    this.stopInstall();
    this.play(kind === "plant" ? "take" : "disarmed", null); // the defuse hold has its own (longer) clip, 7.3 s vs the 7.1 s hold
  }

  stopInstall(): void {
    const v = this.installVoice;
    this.installVoice = null;
    if (v?.isPlaying) v.stop();
  }

  private remoteVoices = new Map<number | string, THREE.Audio<GainNode | PannerNode>>();

  /** Another player holds the plant / defuse: the same clip as the local hold, positional at the holder, so the team hears the defuse. */
  remoteHold(id: number | string, kind: "plant" | "defuse", at: THREE.Vector3): void {
    this.remoteStop(id);
    this.play(kind === "plant" ? "take" : "disarmed", at, (a) => this.remoteVoices.set(id, a));
  }

  remoteStop(id: number | string): void {
    const v = this.remoteVoices.get(id);
    this.remoteVoices.delete(id);
    if (v?.isPlaying) v.stop();
  }

  private stopRemotes(): void {
    for (const v of this.remoteVoices.values()) if (v.isPlaying) v.stop();
    this.remoteVoices.clear();
  }

  /** load the sounds now (first plant has no decode delay) */
  preload(): void {
    for (const r of ["take", "installed", "disarmed", "explosion", "button", "countA", "countB", "countC", "countD", "countE"]) {
      const rel = this.sfx?.roles[r];
      if (rel && !clipCache.has(rel)) loadClipCb(clipLoader, `${SFX}/${rel}`, (b) => clipCache.set(rel, b), () => {});
    }
  }

  /** WM_C4_Installed + the model on the floor + the blinking light (Bomb_Light_Red). */
  plant(pos: [number, number, number]): void {
    this.clear();
    this.pos.set(pos[0], pos[1], pos[2]);
    this.beepIn = 1;
    this.fifthPlayed = false;
    this.stopInstall();
    this.play("installed", this.pos); // WeaponC4 install done: StartWeapon_C4StateSnd state 1 (0x6371d0)
    void loadC4Model().then((m) => {
      if (!m || !this.pos) return;
      this.model?.removeFromParent();
      this.model = m.clone(true);
      // c4.glb keeps the hand-grip origin (world bounds Y -0.105..+0.051, X 0.004..0.267): rest the box on the floor point, centred on it
      this.model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(this.model);
      const c = box.getCenter(new THREE.Vector3());
      this.model.position.set(this.pos.x - c.x, this.pos.y - box.min.y, this.pos.z - c.z);
      this.scene.add(this.model);
      setC4Lcd(this.model, 6); // the display is on (last row of c4_01_lcd)
      // the blinking LED (Bomb_Light_Red) sits on the model's FXDummy
      this.model.updateMatrixWorld(true);
      const fx = this.model.getObjectByName("FXDummy");
      const at = fx ? fx.getWorldPosition(new THREE.Vector3()) : this.pos.clone().add(new THREE.Vector3(0, 0.1, 0));
      if (this.light) this.effects?.stop(this.light);
      this.light = this.effects?.play("Bomb_Light_Red", at) ?? null;
    });
  }

  private rings: THREE.Object3D[] = [];

  /** A translucent ring on every listed site so the players can see where to plant [RECRIADO: the original shows the TargetObject arrow + minimap icon]. */
  showSites(sites: { pos: [number, number, number]; area: number }[]): void {
    this.hideSites();
    const geo = new THREE.RingGeometry(1.85, 2, 48).rotateX(-Math.PI / 2); // the exact area: 2 m (exe 0x585470)
    sites.forEach((s) => {
      const mat = new THREE.MeshBasicMaterial({ color: s.area === 0 ? 0xff5a4a : 0x4aa3ff, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
      const ring = new THREE.Mesh(geo, mat);
      ring.position.set(s.pos[0], s.pos[1] + 0.05, s.pos[2]);
      this.scene.add(ring);
      this.rings.push(ring);
    });
  }

  hideSites(): void {
    for (const r of this.rings) r.removeFromParent();
    this.rings = [];
  }

  /** the press: the keypad click, then the install sound starts */
  button(kind: "plant" | "defuse" = "plant"): void {
    this.play("button", null);
    this.startInstall(kind);
  }

  /** Count beeps: the C4 count clips at the fuse's schedule (BombMode.beepInterval) [RECRIADO schedule]. */
  update(dt: number, fuseLeft: number, interval: number): void {
    if (!this.model && !this.light) return;
    // Count_E (9 accelerating beeps, 5.3 s) is the final alarm: started so that it ends with the blast [INFERIDO timing]; the slower beeps run before it
    if (fuseLeft <= 5.3) {
      if (!this.fifthPlayed) { this.fifthPlayed = true; this.play("countE", this.pos); }
      return;
    }
    this.beepIn -= dt;
    if (this.beepIn > 0) return;
    this.beepIn = interval;
    this.play(fuseLeft > 30 ? "countA" : fuseLeft > 20 ? "countB" : fuseLeft > 12 ? "countC" : "countD", this.pos);
  }

  explode(): void {
    this.stopInstall();
    this.play("explosion", null);
    // WeaponC4::Explosion 0x637000: AddEffect(getFireEffectIndex) = the pef _FireEffect "Exp_Car_CTS_01"
    this.effects?.play("Exp_Car_CTS_01", this.pos.clone().add(new THREE.Vector3(0, 0.1, 0)), new THREE.Vector3(0, 1, 0));
    this.removeObjects();
  }

  defuse(): void {
    this.stopInstall(); // the disarm sound played during the hold (it ends with it)
    this.stopRemotes();
    this.removeObjects();
  }

  private removeObjects(): void {
    this.model?.removeFromParent();
    this.model = null;
    if (this.light) { this.effects?.stop(this.light); this.light = null; }
  }

  clear(): void { this.stopInstall(); this.stopRemotes(); this.removeObjects(); }

  dispose(): void { this.stopInstall(); this.stopRemotes(); this.removeObjects(); this.hideSites(); }
}
