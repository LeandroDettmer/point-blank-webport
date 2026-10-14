// HUD of the observer (a dead / late-joining player of a round mode, or a GM observer): the help band with its five lines, the HP
// list, the GM extras (seat icons, F9 badge of the target, F1 help image). Cross exe: band CHud+0x554
// (0x73d2e5..0x73d8f9), target line 0x745ec0, HP list CHUD_ObserverHPGauge (0x709250 / 0x70a2e0), F9 badge 0x7628e6, help 0x73f1a0.
// The numbers live in game/observer.ts; absolute window px (W / H = the view size, nothing scaled). Text nodes: hudText.ts.
import { CROSS_HUD } from "./crossAssets.ts";
import { HELP_BAND, HP_GAUGE, observedNickColor } from "../observer.ts";
import { idBadgeCell } from "../observerGm.ts";
import { placeBox, placeText } from "./charaPanel.ts";
import type { I3Text, RGB } from "./hudText.ts";

export interface ObsRow { team: 0 | 1; nick: string; score: number; weapon: string; fill: number; seat?: number }
export interface ObsHelp { next: string; prev: string; weapon: string; view: string; title: string }

const WHITE: RGB = [255, 255, 255];
const HUD2 = `url("${CROSS_HUD}/hud/Hud2.png")`, HUD4 = `url("${CROSS_HUD}/hud/HUD4.png")`;

function box(parent: HTMLElement, css = ""): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText = `position:absolute;${css}`;
  parent.appendChild(el);
  return el;
}

interface RowEls { frame: HTMLDivElement; bar: HTMLDivElement; seat: HTMLDivElement; nick: HTMLDivElement; score: HTMLDivElement; weapon: HTMLDivElement }
interface HeadEls { pieces: HTMLDivElement[]; title: HTMLDivElement }

export class ObserverHud {
  private root: HTMLDivElement;
  private band: HTMLDivElement;
  private nickEl: HTMLDivElement;
  private lines: HTMLDivElement[];
  private rows: RowEls[] = [];
  private heads: HeadEls[];
  /** GM extras: F9 badge of the observed target, F1 help image (outside root: they show in FLY too) */
  private extras: HTMLDivElement;
  private badge: HTMLDivElement;
  private help: HTMLDivElement;
  private helpText: ObsHelp = { next: "", prev: "", weapon: "", view: "", title: "" };
  private nick = { text: "", team: 0 as 0 | 1, gm: false, set: false };
  private on = false;
  private since = 0;

  constructor() {
    this.root = box(document.body, "inset:0;pointer-events:none;overflow:hidden;z-index:19;display:none;position:fixed");
    this.band = box(this.root);
    this.nickEl = box(this.root);
    this.lines = Array.from({ length: 4 }, () => box(this.root));
    this.heads = [0, 1].map(() => ({ pieces: [0, 1, 2].map(() => box(this.root)), title: box(this.root) }));
    this.extras = box(document.body, "position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:21");
    this.badge = box(this.extras, "display:none");
    this.help = box(this.extras, "display:none");
  }

  get width(): number { return window.innerWidth; }
  get height(): number { return window.innerHeight; }

  /** the four help lines (STBL_IDX_OBSERVER_NEXT / _PREV / _WEAPON "%s %s" with the key / _VIEW) and the HP list title */
  setHelp(t: ObsHelp): void { this.helpText = t; }

  /** whole block on / off (CHud::SetMode 0x73f3f0: mode 3 = observing with the HUD, mode 4 = FLY hides it) */
  setVisible(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.root.style.display = on ? "block" : "none";
    if (on) this.since = performance.now();
  }

  /** observed player line (0x745ec0): H-68 once set, colour by team / GM observer, GM font 25 */
  setNick(text: string, team: 0 | 1, gm = false): void {
    this.nick = { text, team, gm, set: true };
    this.layoutBand();
  }

  /** F9 seat badge of the observed target (CStageBattle+0x358, hud4 24x24 at (W/2-12, H-93), 0x7628e6); null = off */
  setBadge(seat: number | null): void {
    const cell = seat === null ? null : idBadgeCell(seat);
    if (cell) placeBox(this.badge, (this.width >> 1) - 12, this.height - 93, 24, 24, `${HUD4} -${cell.x}px -${cell.y}px`);
    this.badge.style.display = cell ? "" : "none";
  }

  /** F1 held: help image (W/2-326, H/2-256) 652x512 (0x73f1a0): help_observer.i3i for a GM observer, else help.i3i */
  setHelpImage(on: boolean, gm = true): void {
    if (on) placeBox(this.help, (this.width >> 1) - 326, (this.height >> 1) - 256, 652, 512, `url("${CROSS_HUD}/hud/${gm ? "help_observer" : "help"}.png") 0 0`);
    this.help.style.display = on ? "" : "none";
  }

  private layoutBand(): void {
    const W = this.width, H = this.height, b = HELP_BAND, n = this.nick;
    placeBox(this.band, 0, H - b.height, W, b.height, `rgba(0,0,0,${b.alpha.toFixed(3)})`);
    const nt: I3Text = {
      text: n.text, x: (W >> 1) - 200, y: H - (n.set ? b.nick.y : 90), w: b.nick.w, h: n.gm ? b.nick.gmH : b.nick.h,
      face: "Arial", size: n.gm ? b.nick.gmSize : b.nick.size, weight: 700, color: observedNickColor(n.team, n.gm), ax: 1,
    };
    placeText(this.nickEl, nt);
    const h = this.helpText;
    const line = (text: string, x: number, y: number): I3Text => ({ text, x, y: H - y, w: 400, h: 20, face: "Arial", size: b.next.size, color: WHITE });
    [line(h.next, b.next.x, b.next.y), line(h.prev, b.prev.x, b.prev.y), line(h.weapon, W - b.weapon.fromRight, b.weapon.y), line(h.view, W - b.view.fromRight, b.view.y)]
      .forEach((t, i) => placeText(this.lines[i], t));
  }

  /** the list (rows ordered by slot); `y(n, i)` = game/observer.ts hpRowY; `gm` draws the hud4 seat icons */
  setRows(rows: readonly ObsRow[], y: (n: number, i: number) => number, gm = false): void {
    this.layoutBand();
    // 0x70a32f: the list waits 0.5 s after the HUD switches on
    const ready = performance.now() - this.since > 500;
    const per: [ObsRow[], ObsRow[]] = [[], []];
    for (const r of rows) per[r.team].push(r);
    const W = this.width, g = HP_GAUGE;
    let k = 0;
    for (const team of [0, 1] as const) {
      const list = ready ? per[team] : [];
      const px = team === 0 ? g.leftX : W - g.rightInset;
      list.forEach((r, i) => {
        const e = (this.rows[k] ??= this.makeRow());
        this.place(e, r, team, px, y(list.length, i), gm);
        k++;
      });
      // team header + title, 34 px above the top row (moved by the update)
      const hd = this.heads[team], on = list.length > 0;
      hd.pieces.forEach((p, j) => {
        p.style.display = on ? "" : "none";
        if (!on) return;
        const dx = (team === 0 ? g.header.dxRed : g.header.dxBlue)[j], v = team === 0 ? g.header.vRed : g.header.vBlue;
        const sx = g.header.w[j] / g.header.uw[j];
        placeBox(p, px + dx, y(list.length, 0) + g.header.dy, g.header.w[j], g.header.h, `${HUD2} -${g.header.u[j] * sx}px -${v}px / ${1024 * sx}px 512px`);
      });
      hd.title.style.display = on ? "" : "none";
      if (on) placeText(hd.title, { text: this.helpText.title, x: px + (team === 0 ? g.title.dxRed : g.title.dxBlue), y: y(list.length, 0) + g.header.dy + g.title.dy, w: g.title.w, h: g.title.h, face: "Arial", size: g.title.size, weight: 700, color: WHITE });
    }
    for (; k < this.rows.length; k++) this.rows[k].frame.style.display = "none";
  }

  private makeRow(): RowEls {
    const frame = box(this.root);
    const bar = box(frame), seat = box(frame), nick = box(frame), score = box(frame), weapon = box(frame);
    return { frame, bar, seat, nick, score, weapon };
  }

  private place(e: RowEls, r: ObsRow, team: 0 | 1, x: number, y: number, gm: boolean): void {
    const g = HP_GAUGE;
    e.frame.style.display = "block";
    placeBox(e.frame, x, y, g.frame.w, g.frame.h, `${HUD2} -${g.frame.u}px -${g.frame.v}px`);
    const wpx = Math.round(r.fill * g.bar.w);
    placeBox(e.bar, g.barDx, g.barDy, wpx, g.bar.h, `${HUD2} -${g.bar.u}px -${team === 0 ? g.bar.vRed : g.bar.vBlue}px`);
    e.bar.style.display = wpx > 0 ? "" : "none";
    const cell = gm && r.seat !== undefined ? idBadgeCell(r.seat) : null;
    if (cell) placeBox(e.seat, team === 0 ? g.seat.dxRed : g.seat.dxBlue, g.seat.dy, 24, 24, `${HUD4} -${cell.x}px -${cell.y}px`);
    e.seat.style.display = cell ? "" : "none";
    placeText(e.nick, { text: r.nick, x: g.nick.dx, y: g.nick.dy, w: g.nick.w, h: g.nick.h, face: "Arial", size: g.nick.size, color: WHITE });
    placeText(e.score, { text: String(r.score), x: team === 0 ? g.score.dx : g.score.dxBlue, y: g.score.dy, w: g.score.w, h: g.score.h, face: "Gunplay", size: g.score.size, color: WHITE, ax: 1, ay: 1 });
    placeText(e.weapon, { text: r.weapon, x: g.weapon.dx, y: g.weapon.dy, w: g.weapon.w, h: g.weapon.h, face: "Arial", size: g.weapon.size, color: WHITE });
    for (const t of [e.nick, e.weapon]) { t.style.overflow = "hidden"; t.style.textOverflow = "ellipsis"; }
  }

  dispose(): void {
    this.root.remove();
    this.extras.remove();
  }
}
