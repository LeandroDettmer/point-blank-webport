// Sound mix of the 2017 client (i3SoundDx.dll over FMOD Ex 4.08, Clients/PBKaybo/GameData/Apps/PB), shared by every
// game sound: per-clip volume / distance, the slider groups, the 3D attenuation and the voice limit.
// Addresses: i3SoundDx.dll (base 0x10000000), i3FrameworkDx.dll, PointBlank.exe 2017. Table: 
//
// * per clip: the i3GameResSound data of Sound.i3Pack Sound/*.RSC (pb-extract-tools export-sound-rsc.mjs -> data/soundRsc2017.json):
//   min / max distance, volume (3D) and listener volume (2D).
// * channel volume = type volume x main volume x clip volume / 1e6 (i3SoundPlayState::_calcCtxVolume 0x100155c0),
//   then Channel::setVolume(v * 0.01) (i3SoundPlayStateFMOD::SetVolume 0x10016a89): linear everywhere.
// * 2D (3D mode 0x1000000: the own 1PV shot, own steps, announcer, radio, UI) takes the listener volume, 3D the volume.
import * as THREE from "three";
import rsc from "../game/data/soundRsc2017.json" with { type: "json" };
import { onSettings, sfxGain } from "./settings.ts";

export interface SoundInfo {
  /** FMOD min distance (m): full volume inside it */
  min: number;
  /** past it the sound is muted (setMuteAtMaxDistance) */
  max: number;
  /** 0..100, 3D sounds */
  vol: number;
  /** 0..100, 2D sounds (played at the listener) */
  lvol: number;
}

/** i3SoundPlayInfo constructor (i3SoundDx 0x10013cb0): min 3, max 50, volume and listener volume 100 */
export const DEFAULT_INFO: SoundInfo = { min: 3, max: 50, vol: 100, lvol: 100 };
/** System::setSoftwareChannels(0x30) (0x1000eaff): the voices FMOD mixes. init(0xff, 0x82) (0x1000eb15) keeps up to
 *  255 channels, the rest virtual (silent) */
export const REAL_CHANNELS = 48;
/** FMOD_INIT_VOL0_BECOMES_VIRTUAL (init flags 0x82) + FMOD_ADVANCEDSETTINGS.vol0virtualvol 0.0125 (0x1000eb70):
 *  a channel quieter than this is virtual */
export const VIRTUAL_VOL = 0.0125;
/** set3DMinMaxDistance(min, 10000) (i3SoundPlayStateFMOD::Set3DParams 0x10015818): FMOD's own max is never reached,
 *  the list's max only mutes */
const FMOD_MAX_DISTANCE = 10000;

const table: Record<string, number[]> = rsc.files;

/** the list's data of a clip by name (no path, no .wav, any case), undefined when no list has it */
export function namedInfo(name: string | undefined): SoundInfo | undefined {
  const r = name ? table[name.toLowerCase()] : undefined;
  return r ? { min: r[0], max: r[1], vol: r[2], lvol: r[3] } : undefined;
}

/** the list's data of a clip file ("char/CH_Concrete_Left_1.wav"...);
 *  `fallback` for a clip no list names (the 3.123 packs' 000.wav ...) */
export function soundInfo(file: string | undefined, fallback: SoundInfo = DEFAULT_INFO): SoundInfo {
  const base = file?.split(/[\\/]/).pop()?.replace(/\.(wav|ogg)$/i, "");
  return namedInfo(base) ?? fallback;
}

/** FMOD needs min > 0; a list min of 0 keeps FMOD's default 1 m [INFERIDO] */
const minOf = (i: SoundInfo): number => (i.min > 0 ? i.min : 1);
/** isAudioable (0x10004580): audible while d^2 < max^2; a max of 0 never mutes (comiss 0, max -> audible) */
const muted = (i: SoundInfo, d: number): boolean => i.max > 0 && d >= i.max;

/** gain (0..1) of a 3D clip at distance d before the sliders: FMOD_3D_LOGROLLOFF (createSound mode 0x100852,
 *  i3SoundFMOD::Get3DSound 0x10010f0e) with no set3DSettings (rolloff scale 1) = min / d past min, 0 past max */
export function gain3D(info: SoundInfo, d: number): number {
  if (muted(info, d)) return 0;
  const min = minOf(info);
  return (info.vol / 100) * (d > min ? min / d : 1);
}

// ---- the "Efeitos sonoros" group ----------------------------------------------------------------------------------
// InitSound (exe 0x6d4410, called by the Option popup's apply 0x889180) sets i3SoundContext::SetTypeVolume (vtable +0x1c,
// i3SoundDx 0x10002130) of types 0x40000 and 0x20000 to (int)env+0xec (effects gauge, 0..100), 0 when its box (env+0xd8)
// is off, and type 0x10000 to env+0xe8 (BGM gauge, env+0xd4 box). Every clip of the lists is type 0x40000 (ctor style
// 0x1040000), so the effects gauge drives weapons, steps, voices, radio, announcer and UI alike; only the BGM stream is
// type 0x10000 (0x69a648). Web: one GainNode between every game sound and the speakers, live on every settings change.
let bus: GainNode | null = null, busCtx: BaseAudioContext | null = null;
export function effectsBus(ctx: BaseAudioContext = THREE.AudioContext.getContext()): GainNode {
  if (bus && busCtx === ctx) return bus;
  busCtx = ctx;
  const b = (bus = ctx.createGain());
  b.connect(ctx.destination);
  onSettings((s) => {
    if (bus !== b) return;
    try { b.gain.setTargetAtTime(sfxGain(s), ctx.currentTime, 0.01); } catch { b.gain.value = sfxGain(s); }
  });
  return b;
}

/** puts a three.js listener's output under the effects group (its own gain stays free for the flash duck) */
export function routeListener(listener: THREE.AudioListener): void {
  const g = listener.gain;
  try { g.disconnect(); } catch { /* not connected */ }
  g.connect(effectsBus(listener.context));
}

// ---- voice limit ----------------------------------------------------------------------------------------------------
interface Voice { aud: number; stop: () => void }
const live = new Set<Voice>();

/**
 * Room for a new voice of audibility `aud` (its gain now). null = FMOD would make it virtual: under VIRTUAL_VOL, or the
 * 48 real channels all hold louder voices. Otherwise, at 48, the quietest voice gives its channel up. FMOD keeps a
 * virtual channel and brings it back when it gets louder; a one-shot is dropped instead [INFERIDO].
 */
export function claimVoice(aud: number, stop: () => void): Voice | null {
  if (!(aud >= VIRTUAL_VOL)) return null;
  if (live.size >= REAL_CHANNELS) {
    let q: Voice | null = null;
    for (const v of live) if (!q || v.aud < q.aud) q = v;
    if (q && q.aud >= aud) return null;
    if (q) { live.delete(q); q.stop(); }
  }
  const v = { aud, stop };
  live.add(v);
  return v;
}
export function releaseVoice(v: Voice | null | undefined): void {
  if (v) live.delete(v);
}
/** voices holding a real channel (smokes) */
export const liveVoices = (): number => live.size;

const _s = new THREE.Vector3(), _l = new THREE.Vector3();

/** distance from the listener to a world point (the listener's matrixWorld of the last render) */
export function listenerDistance(listener: THREE.AudioListener, p: THREE.Vector3): number {
  return _l.setFromMatrixPosition(listener.matrixWorld).distanceTo(p);
}

/**
 * THREE.PositionalAudio with the i3Sound distance rules: inverse rolloff from the clip's min distance with factor 1
 * (= FMOD log rolloff, scale 1, max 10000), silent past the clip's max distance, re-checked every frame while it plays
 * (i3SoundPlayStateFMOD::UpdateMuteState 0x10015a20 -> Mute).
 */
export class PbPositionalAudio extends THREE.PositionalAudio {
  private far = false;
  private level = 1;

  constructor(listener: THREE.AudioListener, readonly info: SoundInfo, scale = 1) {
    super(listener);
    this.setDistanceModel("inverse");
    this.setRolloffFactor(1);
    this.setRefDistance(minOf(info));
    this.setMaxDistance(FMOD_MAX_DISTANCE);
    this.level = (info.vol / 100) * scale;
    this.setVolume(this.level);
  }

  /** the clip gain while in range */
  setLevel(v: number): this {
    this.level = v;
    if (!this.far) this.setVolume(v);
    return this;
  }

  override updateMatrixWorld(force?: boolean): void {
    super.updateMatrixWorld(force);
    if (!(this.info.max > 0)) return;
    const far = muted(this.info, _s.setFromMatrixPosition(this.matrixWorld).distanceTo(_l.setFromMatrixPosition(this.listener.matrixWorld)));
    if (far === this.far) return;
    this.far = far;
    this.setVolume(far ? 0 : this.level);
  }
}

/** a 2D (listener) clip at its listener volume */
export function audio2D(listener: THREE.AudioListener, info: SoundInfo, scale = 1): THREE.Audio {
  const a = new THREE.Audio(listener);
  a.setVolume((info.lvol / 100) * scale);
  return a;
}
