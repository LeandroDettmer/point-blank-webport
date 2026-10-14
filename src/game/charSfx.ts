// Character sounds of the 2017 client (Sound_Character_*, Sound_voice_Man, Sound_Object_Helmet): footsteps, jump,
// land, hurt grunt, critical, death, helmet bounce. Real WAVs by name (pb-extract-tools export-charsfx2017.mjs ->
// public/assets/sfx/char/index.json). Other characters are 3D (located by ear), the local one 2D at the listener
// volume, both with the clip's list data (gameplay/soundMix.ts).
import * as THREE from "three";
import { DEFAULT_INFO, PbPositionalAudio, audio2D, claimVoice, gain3D, listenerDistance, namedInfo, releaseVoice } from "../gameplay/soundMix";
import { jsonOnce } from "../jsonOnce";
import { loadClip } from "../audioUrl";
import { terrainSuffix } from "../weapons/terrainSound";

const BASE = "/assets/sfx";

const loader = new THREE.AudioLoader();
/** decoded clips by file, shared by every CharSfx and preloadCharSfx: one fetch + decode per file, also when the same
 * sound starts twice before its first decode ends */
const decoded = new Map<string, AudioBuffer>();
const loading = new Map<string, Promise<AudioBuffer | null>>();
function clip(rel: string): Promise<AudioBuffer | null> {
  let p = loading.get(rel);
  if (!p) {
    const q: Promise<AudioBuffer | null> = loadClip(loader, `${BASE}/${rel}`).then((b) => { decoded.set(rel, b); return b; }, () => {
      // a failed load must not silence the clip for the whole session: forget it so the next play retries
      setTimeout(() => { if (loading.get(rel) === q) loading.delete(rel); }, 2000);
      return null;
    });
    p = q;
    loading.set(rel, p);
  }
  return p;
}
const charIndex = (): Promise<Record<string, string>> =>
  jsonOnce<{ files?: Record<string, string> }>(`${BASE}/char/index.json`).then((j) => j.files ?? {}, () => ({}));

/** Match preload: the clips of the character events (footsteps / jump / land per terrain, hurt, critical, death, helmet);
 * not the UI, BGM and announcer files of the same index. */
export async function preloadCharSfx(): Promise<void> {
  const files = await charIndex();
  await Promise.all(Object.entries(files).filter(([k]) => /^(ch_|mv_hit_|wv_hit_|mv_heart_beat|ob_helmet_|ob_beanie_)/.test(k)).map(([, rel]) => clip(rel)));
}

export class CharSfx {
  private files: Record<string, string> = {};

  constructor(private scene: THREE.Scene, private listener: THREE.AudioListener) {
    void charIndex().then((f) => { this.files = f; });
  }

  /**
   * One character clip with its Sound/Character.RSC / Voice.RSC / Object.RSC data (soundMix): `own` = the local
   * character, played 2D at the listener volume (CGameSoundManager::StartTerrainTypeSnd / StartCharacterActionSnd take
   * the caller's listener flag, 0x699c50: set3DMode 0x1000000), else 3D at `pos` (volume, min / max distance).
   * `scale`: a web factor on top [RECRIADO where a caller passes one].
   */
  private playAt(key: string, pos: THREE.Vector3, own = false, scale = 1): void {
    const rel = this.files[key.toLowerCase()];
    if (!rel) return;
    const p = pos.clone();
    const done = (buf: AudioBuffer) => {
      const info = namedInfo(key) ?? DEFAULT_INFO;
      const aud = (own ? info.lvol / 100 : gain3D(info, listenerDistance(this.listener, p))) * scale;
      let a: THREE.Audio<GainNode | PannerNode>;
      if (own) a = audio2D(this.listener, info, scale);
      else {
        a = new PbPositionalAudio(this.listener, info, scale);
        a.position.copy(p);
      }
      let voice: ReturnType<typeof claimVoice> = null;
      const end = () => { releaseVoice(voice); a.parent?.remove(a); };
      voice = claimVoice(aud, () => { if (a.isPlaying) { a.onEnded = () => {}; a.stop(); } end(); });
      if (!voice) return;
      a.setBuffer(buf);
      if (!own) this.scene.add(a);
      a.onEnded = () => { a.isPlaying = false; end(); };
      a.play();
    };
    const buf = decoded.get(rel);
    if (buf) return done(buf);
    void clip(rel).then((b) => { if (b) done(b); });
  }

  /** one footstep (alternating left/right), CH_<Terrain>_Left/Right_1/2 (CGameCharaSoundContext::PlayFootStep 0x8230c0).
   *  `quiet` (crouched) = 0.42 of the clip [RECRIADO: the old 0.25 / 0.6 of the web steps] */
  step(pos: THREE.Vector3, terrain: number, left: boolean, own = false, quiet = false): void {
    const t = terrainSuffix(terrain), side = left ? "Left" : "Right", n = 1 + (Math.random() < 0.5 ? 0 : 1);
    this.playAt(`CH_${t}_${side}_${n}`, pos, own, quiet ? 0.25 / 0.6 : 1);
  }
  jump(pos: THREE.Vector3, terrain: number, own = false): void { this.playAt(`CH_${terrainSuffix(terrain)}_Jump`, pos, own); }
  land(pos: THREE.Vector3, terrain: number, own = false): void { this.playAt(`CH_${terrainSuffix(terrain)}_JumpEnd`, pos, own); }
  /** head-hit grunt, CH_Head_Hit_1/2 (0x78a230) */
  hurt(pos: THREE.Vector3, head: boolean, own = false): void {
    if (head) this.playAt(`CH_Head_Hit_${1 + (Math.random() < 0.5 ? 0 : 1)}`, pos, own);
  }
  /**
   * The local character took a hit and survived (damage handler 0x78caa0, HP before > damage): a CH_Critical_Male/Female
   * grunt, 2D (idx 0xc, gender 0x54dc10, call 0x78cd2d; the exe skips it for the Dino/monster classes of 0x4c1420, not
   * modelled), and MV_Heart_Beat (idx 0xd, no WV_ take, 2D, 0x78cd67 / 0x78c34b) once when the hit takes HP from above 20
   * into 1..20. One-shot: the exe has no loop for it.
   */
  ownHurt(pos: THREE.Vector3, female: boolean, hpAfter: number, dealt: number): void {
    if (hpAfter <= 0 || dealt <= 0) return;
    this.playAt(female ? "CH_Critical_Female" : "CH_Critical_Male", pos, true);
    if (hpAfter + dealt > 20 && hpAfter <= 20) this.playAt("MV_Heart_Beat", pos, true);
  }
  /**
   * Death voice by gender: Sound_voice_Man.i3Pack (MV_Hit_Death / MV_Hit_Downfall) vs Sound_voice_Woman.i3Pack
   * (WV_*), the same prefix split the radio voices use. `fall` = the downfall take (a fall to the death, PB's
   * MV/WV_Hit_Downfall) instead of the bullet one.
   */
  death(pos: THREE.Vector3, fall = false, female = false, own = false): void {
    const p = female ? "WV_" : "MV_";
    this.playAt(fall ? `${p}Hit_Downfall` : `${p}Hit_Death`, pos, own);
  }
  /** HELMET PROTECTION: the bullet stopped by the helmet, OB_Helmet_Hit_Defence_1 (exe sound table 0xbb5b57) */
  helmetDefence(pos: THREE.Vector3): void { this.playAt("OB_Helmet_Hit_Defence_1", pos); }
  /** a helmet hit seen by someone else than the victim: OB_Helmet_Hit_Attack_1 (CEffectManager::AddEquipHitEffect 0x68ff30, sound idx 5, victim not local) */
  helmetAttack(pos: THREE.Vector3): void { this.playAt("OB_Helmet_Hit_Attack_1", pos); }
  helmetBounce(pos: THREE.Vector3, terrain: number): void { this.playAt(`OB_Helmet_Bound_${terrainSuffix(terrain, "helm")}`, pos); }
}
