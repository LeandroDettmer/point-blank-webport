// LayoutRenderer: scene JSON -> absolute-positioned DOM in the original design space (1024x768), plus the
// Stage that scales it into the window with pillarbox/letterbox like the PB client (never stretched).
// Controls are addressed by their ORIGINAL names (Btn_CreateRoom, ScrollBar_RL...) via bind()/get().
import type { Caption, Control, SceneJson } from "./format.ts";
import type { LoadedSheet } from "./assets.ts";
import { ensureUiFont, FONTS } from "./assets.ts";
import { INTERACTIVE, buildSkin, wireStates, type SkinHandle } from "./Skin.ts";

const CSS = `
.pbui-stage{position:absolute;inset:0;overflow:hidden;background:#000;user-select:none;-webkit-user-select:none}
.pbui-stage input,.pbui-stage textarea{user-select:text;-webkit-user-select:text}
.pbui-design{position:absolute;left:0;top:0;transform-origin:0 0;overflow:hidden}
.pbui-scene,.pbui-ctl{position:absolute}
.pbui-ctl{box-sizing:border-box}
.pbui-skin,.pbui-state{position:absolute;inset:0;pointer-events:none}
.pbui-piece{position:absolute;background-repeat:no-repeat}
.pbui-missing{background:rgba(255,0,200,.28);outline:1px solid rgba(255,0,200,.85);outline-offset:-1px}
.pbui-caption{position:absolute;inset:0;display:flex;pointer-events:none;white-space:nowrap;overflow:hidden;
  font-family:${FONTS.lobby};font-weight:bold;line-height:1}
.pbui-ctl[data-cls="i3UIRadio"]>.pbui-caption{left:21px}
.pbui-int{cursor:pointer}
.pbui-disabled{cursor:default}
`;
function ensureCss(): void {
  if (document.getElementById("pbui-css")) return;
  const st = document.createElement("style");
  st.id = "pbui-css";
  st.textContent = CSS;
  document.head.appendChild(st);
}

/**
 * The scenes' design-time UI blues (the 2017 client's cold light blue) -> the warm gold/orange of Project Blackout's
 * look (same family as the list headers). Keyed by; other colours are untouched.
 */
const WARM: Record<string, [number, number, number]> = {
  "82,177,235": [255, 196, 96], // value / info texts (my info, room info, inventory nick + rank, list titles)
  "160,209,255": [255, 224, 170], // item mount titles
  "103,135,167": [196, 170, 124], // item mount names (dimmer)
  "21,151,232": [255, 159, 21], // create-room section titles
};
const rgba = (c: [number, number, number, number]) => {
  const w = WARM[`${c[0]},${c[1]},${c[2]}`];
  return `rgba(${w ? w.join(",") : `${c[0]},${c[1]},${c[2]}`},${c[3]})`;
};
// alignX/alignY values seen: 0, 1, 2 -> start/center/end [INFERIDO from Tab/StaticText captions]
const FLEX = ["flex-start", "center", "flex-end"];
// i3 font size -> CSS px: point size at 96 dpi [INFERIDO]
export const fontPx = (size: number) => Math.round(size * 96 / 72 * 10) / 10;

// Buttons keep the label vertically centred even when the .i3UIs stores alignY 0 (shop/inventory filter row
// Rush/SubWeapon/...: text drawn at the top edge of the 19 px button otherwise) [INFERIDO]
const isButton = (cls?: string) => !!cls && cls.startsWith("i3UIButton");

export function applyCaption(el: HTMLElement, cap: Caption, text?: string, cls?: string): HTMLElement {
  let span = el.querySelector<HTMLElement>(":scope > .pbui-caption");
  if (!span) {
    span = document.createElement("div");
    span.className = "pbui-caption";
    el.appendChild(span);
  }
  span.style.fontSize = `${fontPx(cap.size || 10)}px`;
  span.style.color = rgba(cap.color);
  if (cap.shadow[3] > 0) span.style.textShadow = `1px 1px 0 ${rgba(cap.shadow)}`;
  span.style.justifyContent = FLEX[cap.alignX] ?? "flex-start";
  span.style.alignItems = isButton(cls) ? "center" : FLEX[cap.alignY] ?? "center";
  span.textContent = text ?? cap.text;
  return span;
}

export interface RenderOptions {
  /** draw design-time captions stored in the .i3UIs (default true) */
  captions?: boolean;
  /** override captions by control name (e.g. labels from String_Brazil.lua) */
  texts?: Record<string, string>;
  /** hide controls by name (runtime visibility is Lua logic in the original) */
  hidden?: string[];
}

export class RenderedScene {
  readonly root: HTMLElement;
  readonly byName = new Map<string, HTMLElement>();
  readonly byId = new Map<number, HTMLElement>();
  readonly skins = new Map<number, SkinHandle>();
  /** Control names drawn with the raw design-time caption because opts.texts had no override (i18n.ts: textsFor()). */
  readonly untranslated: string[] = [];
  private disposers: (() => void)[] = [];

  constructor(readonly scene: SceneJson, readonly sheet: LoadedSheet, opts: RenderOptions = {}) {
    ensureCss();
    ensureUiFont();
    const root = document.createElement("div");
    root.className = "pbui-scene";
    root.dataset.scene = scene.name;
    root.style.cssText = `left:0;top:0;width:${scene.design.w}px;height:${scene.design.h}px`;
    this.root = root;
    const hidden = new Set(opts.hidden ?? []);
    const ids = new Set(scene.controls.map(c => c.id));
    // parents may come after their children in object order -> create all, then attach
    for (const c of scene.controls) if (!c.noLayout) this.byId.set(c.id, this.makeControl(c, opts, hidden));
    for (const c of scene.controls) {
      const el = this.byId.get(c.id);
      if (!el) continue;
      const parent = c.parent !== null && ids.has(c.parent) ? this.byId.get(c.parent) : undefined;
      (parent ?? root).appendChild(el);
    }
  }

  private makeControl(c: Control, opts: RenderOptions, hidden: Set<string>): HTMLElement {
    const el = document.createElement("div");
    el.className = "pbui-ctl";
    el.dataset.name = c.name;
    el.dataset.cls = c.cls;
    el.style.cssText = `left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px`;
    if (c.color && c.color[3] !== 1) el.style.opacity = String(c.color[3]);
    if (hidden.has(c.name)) el.hidden = true;
    const tpl = c.template ? this.scene.templates[c.template] : undefined;
    if (tpl) {
      const skin = buildSkin(tpl, c.w, c.h, this.sheet);
      el.appendChild(skin.el);
      this.skins.set(c.id, skin);
      if (INTERACTIVE.has(c.cls)) {
        el.classList.add("pbui-int");
        this.disposers.push(wireStates(el, skin));
      }
    }
    if (c.caption && opts.captions !== false) {
      const t = opts.texts?.[c.name];
      if (t === undefined && c.caption.text) this.untranslated.push(c.name);
      if (t !== undefined || c.caption.text) applyCaption(el, c.caption, t, c.cls);
    }
    if (!this.byName.has(c.name)) this.byName.set(c.name, el);
    return el;
  }

  get(name: string): HTMLElement | undefined { return this.byName.get(name); }
  control(name: string): Control | undefined { return this.scene.controls.find(c => c.name === name); }

  setText(name: string, text: string): void {
    const c = this.control(name), el = this.byName.get(name);
    if (c?.caption && el) applyCaption(el, c.caption, text, c.cls);
    else if (el) { const d = document.createElement("div"); d.className = "pbui-caption"; d.textContent = text; el.appendChild(d); }
  }

  setEnabled(name: string, on: boolean): void {
    const el = this.byName.get(name), c = this.control(name);
    if (!el || !c) return;
    el.classList.toggle("pbui-disabled", !on);
    this.skins.get(c.id)?.setState(on ? 0 : 3);
  }

  /** Links logic by original control name: bind({Btn_CreateRoom: () => ...}). Returns a disposer. */
  bind(handlers: Record<string, (ev: MouseEvent, el: HTMLElement) => void>): () => void {
    const offs: (() => void)[] = [];
    for (const [name, fn] of Object.entries(handlers)) {
      const el = this.byName.get(name);
      if (!el) { console.warn(`[pbui] ${this.scene.name}: no control named ${name}`); continue; }
      const h = (ev: MouseEvent) => { if (!el.classList.contains("pbui-disabled")) fn(ev, el); };
      el.addEventListener("click", h);
      offs.push(() => el.removeEventListener("click", h));
    }
    this.disposers.push(...offs);
    return () => offs.forEach(f => f());
  }

  /** Frames drawn as placeholders (encrypted/missing atlases). */
  missingFrames(): string[] { return [...new Set([...this.skins.values()].flatMap(s => s.missing))]; }

  destroy(): void {
    this.disposers.forEach(f => f());
    this.disposers = [];
    this.root.remove();
  }
}

/**
 * Stage: fixed design box (default 1024x768) scaled by min(W/dw, H/dh) and centred -> black bars on
 * 16:9 (pillarbox), as the PB client does instead of stretching.
 * `stretch`: X and Y scaled apart (W/dw, H/dh) over the whole window, as the i3Gui root of the Cross ready stage:
 * CStageReady SetViewer(viewer, 1) (0x511bb7) -> i3GuiRoot::SetViewer (i3GuiDx 0x1000b120) sets
 * m_sfGuiResolutionWidth = W / 1024 and Height = H / 768, applied per axis by every control's _ResizeControl (0x10023940).
 * `stretch`: SetViewer(viewer, 0) (the CBattleGui root, 0x718d62, LoadGUIFile 0x718bc0): the resolution is 1.0, so the
 * design is drawn at window px, top-left, unscaled (no letterbox). Respawn_BG and the battle GUI use it.
 */
/** stretch mode: the widest / tallest window shape the UI stretches to (width / height) */
const STRETCH_MAX_ASPECT = 16 / 9, STRETCH_MIN_ASPECT = 4 / 3;

export class Stage {
  readonly el: HTMLElement;
  readonly design: HTMLElement;
  private ro: ResizeObserver | null = null;
  /** horizontal scale (both axes unless stretch) */
  scale = 1;
  /** vertical scale with stretch */
  scaleY = 1;

  constructor(readonly host: HTMLElement, readonly dw = 1024, readonly dh = 768, readonly stretch: boolean | "px" = false) {
    ensureCss();
    this.el = document.createElement("div");
    this.el.className = "pbui-stage";
    this.design = document.createElement("div");
    this.design.className = "pbui-design";
    this.design.style.width = `${dw}px`;
    this.design.style.height = `${dh}px`;
    this.el.appendChild(this.design);
    host.appendChild(this.el);
    this.fit();
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(this.el);
  }

  fit(): void {
    const W = this.el.clientWidth || window.innerWidth, H = this.el.clientHeight || window.innerHeight;
    if (this.stretch === "px") {
      this.scale = this.scaleY = 1;
      this.design.style.transform = "none";
      return;
    }
    if (this.stretch) {
      // stretched per axis only within the shapes the client ran at (4:3 .. 16:9); an ultrawide or tall window keeps that
      // limit and centres the UI, the background fills the rest [RECRIADO: the D3D9 client had no 21:9; user choice 2026-10-12]
      const ww = Math.min(W, H * STRETCH_MAX_ASPECT), hh = Math.min(H, W / STRETCH_MIN_ASPECT);
      this.scale = ww / this.dw;
      this.scaleY = hh / this.dh;
      this.design.style.transform = `translate(${(W - ww) / 2}px,${(H - hh) / 2}px) scale(${this.scale},${this.scaleY})`;
      return;
    }
    this.scale = Math.min(W / this.dw, H / this.dh);
    const ox = (W - this.dw * this.scale) / 2, oy = (H - this.dh * this.scale) / 2;
    this.design.style.transform = `translate(${ox}px,${oy}px) scale(${this.scale})`;
  }

  /** window px -> design px (for popups/tooltips positioned from pointer events) */
  toDesign(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.design.getBoundingClientRect();
    return { x: (clientX - r.left) / this.scale, y: (clientY - r.top) / (this.stretch ? this.scaleY : this.scale) };
  }

  destroy(): void {
    this.ro?.disconnect();
    this.el.remove();
  }
}
