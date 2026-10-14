// Revenge record panel of the Cross exe (CHUD_CharaState bar_A / bar_B, texts +0xf4 / +0xf0 / +0xfc / +0xf8), from the
// Cross PointBlank.exe:
//   CHud::RecordRevenge(slot, delta) 0x747270  called from the kill feed 0x741210 only when the local player is the killer
//                                              (delta +1) or the victim (delta -1) of a kill with another player (0x741320..0x741351)
//   CHud::Show / hide 0x747b40(flag)            bar_A (group frame 0) and the 4 texts; hide also clears the active flag
//   CHud::Tick 0x747ae0(dt)                     runs only while active (CHud::Update 0x73eb70): timer += dt, hidden at 4 s
// Window px: cx = W >> 1 (CreateHUD), bar at (cx-192, H-255) 383x84 of Hud2.png uv (324,409)-(707,493).
// [INFERIDO]: records are keyed by the foe's id (the exe keys by nick, 16 slots); the record is cleared on a new HUD (no exe
// caller of ClearRevenge 0x747a50 was traced); the gate [0xd867e8]+0xd0 of the exe is taken as "battle HUD on" (the kill feed only
// runs in battle).
import { LayoutView, type PanelLayout, type SprBox } from "./charaPanel.ts";
import type { I3Text, RGB } from "./hudText.ts";

/** the revenge panel stays up this long after the last record (0xb52978 = 4.0 double) */
export const REVENGE_SHOW_S = 4;

const RED: RGB = [252, 88, 88], BLUE: RGB = [67, 182, 243], WHITE: RGB = [255, 255, 255], LEAD: RGB = [255, 200, 100];

export interface RevengeFoe { id: string; name: string }

/** one foe of the local player: kills = my kills of the foe (exe +0x6e8), deaths = the foe's kills of me (exe +0x6e4) */
export interface RevengeRecord { foe: string; me: string; kills: number; deaths: number }

/** the records of the local player and the timer of the panel (exe d40 / d44) */
export class RevengeBook {
  private recs = new Map<string, RevengeRecord>();
  private shown: RevengeRecord | null = null;
  private timer = 0;
  private active = false;

  /** CHud::RecordRevenge: delta +1 = I killed the foe, -1 = the foe killed me. Shows the foe's record and restarts the timer. */
  record(foe: RevengeFoe, me: string, delta: number): void {
    let r = this.recs.get(foe.id);
    if (!r) { r = { foe: foe.name, me, kills: 0, deaths: 0 }; this.recs.set(foe.id, r); }
    r.me = me;
    if (delta < 0) r.deaths -= delta; else r.kills += delta;
    this.shown = r; // the texts are refreshed either way (0x74760d..)
    // 0x74757f: only a death (delta < 0) turns the panel on (+0xd40 = 1, timer at 0x7475c2); a kill only counts (+0x6e8)
    if (delta >= 0) return;
    this.timer = 0;
    this.active = true;
  }

  /** CHud::Update: only while active; the panel goes off once the timer reaches REVENGE_SHOW_S */
  tick(dt: number): void {
    if (!this.active) return;
    this.timer += dt;
    if (this.timer >= REVENGE_SHOW_S) { this.active = false; this.timer = 0; }
  }

  get visible(): boolean { return this.active; }
  get current(): RevengeRecord | null { return this.shown; }

  clear(): void { this.recs.clear(); this.shown = null; this.active = false; this.timer = 0; }
}

/** PanelLayout of the record (bar_A sprite + the 4 texts). Left = the foe (red names, deaths), right = me (blue names, kills). */
export function revengeLayout(r: RevengeRecord, W: number, H: number): PanelLayout {
  const cx = W >> 1;
  const boxes: SprBox[] = [{ x: cx - 192, y: H - 255, w: 383, h: 84, tex: "Hud2.png", uv: [324, 409, 707, 493] }];
  // CHud::Update 0x747720..0x747827: the larger count is yellow, the other white (equal: both white)
  const kills: RGB = r.kills > r.deaths ? LEAD : WHITE, deaths: RGB = r.deaths > r.kills ? LEAD : WHITE;
  const name = (text: string, x: number, color: RGB): I3Text => ({ text, x, y: H - 245, w: 169, h: 16, face: "Arial", size: 13, color, ax: 0, ay: 0 });
  const count = (text: string, x: number, color: RGB): I3Text => ({ text, x, y: H - 225, w: 169, h: 45, face: "Gunplay", size: 29, color, ax: 1, ay: 1 });
  const texts: I3Text[] = [
    name(r.foe, cx - 185, RED),
    name(r.me, cx + 10, BLUE),
    count(String(r.deaths), cx - 185, deaths),
    count(String(r.kills), cx + 10, kills),
  ];
  return { boxes, texts };
}

/** draws the revenge panel: shown while the book is active and the frame is live (no TAB board) */
export class RevengePanel {
  private layer: HTMLDivElement;
  private view: LayoutView;
  private visible = false;

  constructor(parent: HTMLElement) {
    this.layer = document.createElement("div");
    this.layer.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;display:none";
    parent.appendChild(this.layer);
    this.view = new LayoutView(this.layer);
  }

  render(r: RevengeRecord | null, W: number, H: number, visible: boolean): void {
    const on = visible && !!r;
    if (on !== this.visible) { this.visible = on; this.layer.style.display = on ? "" : "none"; }
    if (on && r) this.view.render(revengeLayout(r, W, H));
  }
}
