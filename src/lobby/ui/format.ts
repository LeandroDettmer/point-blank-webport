// JSON formats written by pb-extract-tools ui-export.
// Pure types: no runtime code, so Node (type stripping) and the browser share them.

export type UiVersion = "v11" | "kaybo" | "cross";

/** One template shape, copied from the original XML (`nX nY nWidth nHeight u v w h path`). */
export interface Shape {
  /** image key = lowercased file stem of `path` ("image/main/frame_01.tga" ->), null = no image */
  img: string | null;
  /** place inside the template reference box */
  x: number; y: number; w: number; h: number;
  /** source rectangle inside the image */
  u: number; v: number; uw: number; vh: number;
  path?: string;
}

export interface Template {
  /** i3UITemplate_* class without prefix: Button, ButtonComposed3, FrameWnd, Tab, LVItem, VScrollBar... */
  cls: string;
  name?: string;
  shapes: Shape[];
  /** SubTemplateN in order (scroll bar parts, list cells...) */
  sub?: (Template | null)[];
  hash?: string;
}

export interface Caption {
  /** design-time text stored in the .i3UIs (runtime labels come from String_Brazil.lua) */
  text: string;
  size: number;
  weight: number;
  /** [r, g, b, a(0..1)] */
  color: [number, number, number, number];
  shadow: [number, number, number, number];
  alignX: number;
  alignY: number;
}

export interface Control {
  /** I3R2 object id; the i3UIScene itself is id 1 (never listed) */
  id: number;
  /** parent object id, null = child of the scene */
  parent: number | null;
  cls: string;
  /** original control name (Btn_CreateRoom, ScrollBar_RL...) */
  name: string;
  x: number; y: number; w: number; h: number;
  /** raw UIC1 flags (meaning not decoded; 0x100 is set on every control seen) */
  flags: string;
  tplHash: string | null;
  template?: string | null;
  /** RGBA 0..1, only when not white/opaque */
  color?: [number, number, number, number];
  caption?: Caption;
  noLayout?: boolean;
}

export interface SceneJson {
  format: "pb-ui-scene/1";
  version: UiVersion;
  name: string;
  sceneName: string;
  source: string;
  design: { w: number; h: number };
  script: string | null;
  unresolvedTemplates: number;
  images: string[];
  controls: Control[];
  templates: Record<string, Template>;
}

/**
 * Where a frame's pixels came from.
 *  original          plain file of the same version (exact)
 *  decrypted         encrypted V12 file decoded exactly (?, pb-extract-tools ui-export/vtex-crypt.mjs)
 *  decrypted-partial decode with known colour errors
 *  fallback-v11      same image name taken from UI_V11 [FALLBACK V11]
 *  fallback-kaybo    same image name taken from the 2017 client [FALLBACK Kaybo]
 *  missing           no pixels: the runtime draws a [RECRIADO] placeholder
 */
export type FrameStatus = "original" | "decrypted" | "decrypted-partial" | "fallback-v11" | "fallback-kaybo" | "missing";

export interface Frame {
  status: FrameStatus;
  /** rect inside the sheet PNG (absent when missing or empty) */
  x?: number; y?: number; w?: number; h?: number;
  /** fully transparent source rect (e.g. blank.tga): nothing to draw */
  empty?: boolean;
}

export interface SheetJson {
  format: "pb-ui-sheet/1";
  version: UiVersion;
  sheet: string;
  /** PNG file name, relative to the sheet JSON */
  png: string;
  w: number; h: number;
  /** key = frameKey(shape) = "<img>:<u>,<v>,<uw>,<vh>" */
  frames: Record<string, Frame>;
}
