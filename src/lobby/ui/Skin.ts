// Skin: template -> sprite divs cut from the scene's sheet (background-image + position/size), one layer per
// state. Geometry is geometry.ts (same as the Node composer). Frames without pixels (status "missing",
// e.g. encrypted V12 atlases until lands) draw a [RECRIADO] placeholder, never invented art.
import type { Frame, Template } from "./format.ts";
import type { LoadedSheet } from "./assets.ts";
import { frameKey, layoutTemplate, shapeGroups } from "./geometry.ts";

/** Visual states in i3UI order [INFERIDO]: normal, hover, pressed, disabled. */
export const SKIN_STATE = { normal: 0, hover: 1, pressed: 2, disabled: 3 } as const;

export interface SkinHandle {
  el: HTMLElement;
  /** number of state layers the template has */
  states: number;
  setState(s: number): void;
  /** frames drawn as placeholders (for the dev overlay / reports) */
  missing: string[];
}

function pieceEl(sheet: LoadedSheet, f: Frame | undefined, key: string, x: number, y: number, w: number, h: number): HTMLElement | null {
  if (!f || f.empty || w <= 0 || h <= 0) return null;
  const d = document.createElement("div");
  d.className = "pbui-piece";
  d.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
  if (f.status === "missing" || f.x === undefined || !sheet.url) {
    d.classList.add("pbui-missing");
    d.title = `[RECRIADO] placeholder: ${key} (${f.status})`;
    return d;
  }
  const sx = w / f.w!, sy = h / f.h!;
  d.style.backgroundImage = `url("${sheet.url}")`;
  d.style.backgroundSize = `${sheet.w * sx}px ${sheet.h * sy}px`;
  d.style.backgroundPosition = `${-f.x * sx}px ${-f.y! * sy}px`;
  if (f.status !== "original" && f.status !== "decrypted") d.dataset.status = f.status;
  return d;
}

/** Builds the skin of a w x h control. Layer i = state i; only the current one is visible. */
export function buildSkin(tpl: Template, w: number, h: number, sheet: LoadedSheet): SkinHandle {
  const el = document.createElement("div");
  el.className = "pbui-skin";
  const states = Math.max(1, shapeGroups(tpl).length);
  const layers: HTMLElement[] = [];
  const missing: string[] = [];
  for (let s = 0; s < states; s++) {
    const layer = document.createElement("div");
    layer.className = "pbui-state";
    layer.dataset.s = String(s);
    for (const pc of layoutTemplate(tpl, w, h, s)) {
      const key = frameKey(pc.shape);
      const f = sheet.frames[key];
      const p = pieceEl(sheet, f, key, pc.x, pc.y, pc.w, pc.h);
      if (!p) continue;
      if (p.classList.contains("pbui-missing") && s === 0) missing.push(key);
      layer.appendChild(p);
    }
    layer.hidden = s !== 0;
    layers.push(layer);
    el.appendChild(layer);
  }
  let cur = 0;
  return {
    el, states, missing,
    setState(s: number) {
      const n = Math.max(0, Math.min(states - 1, s));
      if (n === cur) return;
      layers[cur].hidden = true;
      layers[n].hidden = false;
      cur = n;
    },
  };
}

/** Control classes that react to the pointer (hover/pressed layers). The reaction itself is [RECRIADO]. */
export const INTERACTIVE = new Set(["i3UIButton", "i3UIButtonComposed3", "i3UIButtonImageSet", "i3UITab", "i3UICheckBox", "i3UIRadio", "i3UIListView_Item"]);

/** Pointer-driven state switching for interactive controls. Returns a disposer. A host marked `pbui-fixed` keeps
 * the state its owner set: image sets whose "state" picks the picture (map thumbnail, rank icon) would otherwise
 * swap to another map/rank on hover. */
export function wireStates(host: HTMLElement, skin: SkinHandle): () => void {
  if (skin.states < 2) return () => {};
  const set = (s: number) => { if (!host.classList.contains("pbui-disabled") && !host.classList.contains("pbui-fixed")) skin.setState(s); };
  const enter = () => set(1), leave = () => set(0), down = () => set(2), up = () => set(1);
  host.addEventListener("pointerenter", enter);
  host.addEventListener("pointerleave", leave);
  host.addEventListener("pointerdown", down);
  host.addEventListener("pointerup", up);
  return () => {
    host.removeEventListener("pointerenter", enter);
    host.removeEventListener("pointerleave", leave);
    host.removeEventListener("pointerdown", down);
    host.removeEventListener("pointerup", up);
  };
}
