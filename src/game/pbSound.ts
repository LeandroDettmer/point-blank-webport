// Positional sound effects for game events (exe-2017 CGameSoundManager).
// HelmetProtection.wav plays when a headshot is blocked by the helmet.
import * as THREE from "three";
import { sfxGain } from "../gameplay/settings";
import { soundInfo } from "../gameplay/soundMix";
import { loadClip } from "../audioUrl";

// Decoded once on three's shared AudioContext (same pattern as charSfx.ts): no `new Audio` + network request per hit.
// Played straight to the destination (not the effects bus) with the same gain the HTMLAudio volume had, so the
// mix level is unchanged.
const loader = new THREE.AudioLoader();
const loading = new Map<string, Promise<AudioBuffer | null>>();
function clip(url: string): Promise<AudioBuffer | null> {
  let p = loading.get(url);
  if (!p) {
    const q: Promise<AudioBuffer | null> = loadClip(loader, url).then((b) => b, () => {
      // a failed load must not silence the clip for the whole session: forget it so the next play retries
      setTimeout(() => { if (loading.get(url) === q) loading.delete(url); }, 2000);
      return null;
    });
    p = q;
    loading.set(url, p);
  }
  return p;
}

function play(url: string, volume: number): void {
  void clip(url).then((buf) => {
    if (!buf) return;
    try {
      const ctx = THREE.AudioContext.getContext();
      if (ctx.state === "suspended") void ctx.resume();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = volume;
      src.connect(g).connect(ctx.destination);
      src.onended = () => { src.disconnect(); g.disconnect(); };
      src.start();
    } catch { /* audio not available */ }
  });
}

/** Play the helmet protection sound at the attacker's position (HelmetProtection.wav). */
export function pbHelmetProtection(_attackerPos: { x: number; y: number; z: number }): void {
  const file = "/assets/sfx/announce/2017/MV_Ann_HelmetProtection.wav";
  // an announce line: 2D at its listener volume (Voice.RSC MV_ANN_HELMETPROTECTION 100) x the effects gauge
  play(file, Math.min(1, (soundInfo(file).lvol / 100) * sfxGain()));
}
