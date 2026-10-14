// Every game sound ships twice: the original `x.wav` and an Ogg Vorbis twin `x.ogg` next to it (pb-extract-tools wav-to-ogg.mjs,
// ~80% smaller on the wire). The loaders below try the twin first and fall back to the wav when the browser cannot
// play Ogg Vorbis (Safari < 18.4: canPlayType is empty, so no request is wasted) or the twin is missing / fails to decode.
// Cache keys stay the wav URL: callers only swap the loader call.
import type * as THREE from "three";

const probe = typeof document === "undefined" ? null : document.createElement("audio");
/** this browser plays Ogg Vorbis (false in Node: smokes keep the wav path) */
export const OGG_OK = !!probe?.canPlayType('audio/ogg; codecs="vorbis"');

/** the .ogg twin of a .wav URL, null for another extension or when Ogg is unsupported */
export function oggTwin(url: string): string | null {
  return OGG_OK && /\.wav(?=[?#]|$)/i.test(url) ? url.replace(/\.wav(?=[?#]|$)/i, ".ogg") : null;
}

/** THREE.AudioLoader.loadAsync that prefers the .ogg twin and falls back to the .wav */
export function loadClip(loader: THREE.AudioLoader, url: string): Promise<AudioBuffer> {
  const o = oggTwin(url);
  return o ? loader.loadAsync(o).catch(() => loader.loadAsync(url)) : loader.loadAsync(url);
}

/** callback form of loadClip (THREE.AudioLoader.load shape) */
export function loadClipCb(loader: THREE.AudioLoader, url: string, onLoad: (b: AudioBuffer) => void, onError?: (e: unknown) => void): void {
  loadClip(loader, url).then(onLoad, onError);
}

/** new Audio(url) on the .ogg twin; a media error (missing twin / undecodable) swaps to the .wav once */
export function newAudio(url: string): HTMLAudioElement {
  const o = oggTwin(url);
  const a = new Audio(o ?? url);
  if (o) a.addEventListener("error", () => { a.src = url; a.load(); }, { once: true });
  return a;
}
