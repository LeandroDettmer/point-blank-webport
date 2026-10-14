// Kill stars of the local player (CChainKills). Pure state machine, no DOM: PbHud.ts draws the frames it returns and
// killStars.smoke.mjs runs the same code in Node. Read from the 2017 exe; the Cross exe is byte-identical
// apart from offsets: Create 0x7af9a0, _AddKillStar 0x7b2370, _ResetStars 0x7b0c50, _UpdateStars 0x7b2440, _SetKillStarUV 0x7b3460,
// Kill 0x7b05c0. 2017 addresses below; art = the Cross Hud.i3i and kill_mark_HistoryBG.i3i (ui/cross-hud):
//   CChainKills::Create 0x7b9e90        16 star sprites (Hud.i3i, sprite +0x5e0, 52 x 56 px) and ONE crest sprite (+0x5e4,
//                                       Gui/Ingame/kill_mark_HistoryBG.i3i, 128 x 128, HUD_TEXTURE_KILLHISTORY_BG) + 16 number texts
//                                       (font "Gunplay" 25, colour 200 200 200, box 52 x 60)
//   CChainKills::_AddKillStar 0x7bc870  ring of 16 {kind, count}; at most 9 stars are shown, the 10th kill drops the oldest
//   CChainKills::_ResetStars 0x7bb150   own death / round start: empties the ring and hides the crest
//   CChainKills::_UpdateStars 0x7bc940  the per-frame animation below (dt in seconds; the scale is sx = W / 1024, sy = H / 768)
//   CChainKills::_SetKillStarUV 0x7bd960 star cell of Hud.i3i: x = 199 + 52 * (kind & 3), y = 337 + 56 * (kind >> 2)
// One star goes through 6 states (+0x680[i]):
//   0 birth     the star appears huge (520 sx x 560 sy) and transparent at the top-left corner (W/2 - 26, H/2 - 140); the crest
//               starts 80 sx x 80 sy in the Cross exe (2017: 56) at (x - 17, y - 17), alpha 255
//   1 stamp     size shrinks 4160 / 4480 px/s down to 52 sx x 56 sy, alpha grows 500/s up to 200; the crest shows once the star's
//               alpha is > 80, grows 240 px/s up to 80 sx x 80 sy and fades 300/s. Done when the size and alpha are final
//   2 fly       size shrinks 260 / 280 px/s to 6 x 7, alpha falls 1100/s, the crest fades 700/s and keeps growing; the star moves
//               a tenth of the way to (W - 235, H - 65) per frame. Done at alpha 0 and size 6 x 7
//   3 pop       at its slot (x0, y0) with alpha 255, grows 988 / 1064 px/s up to 104 x 112
//   4 settle    shrinks at the same speed back to 52 x 56
//   5 resting   52 x 56 at the slot; a number (the kill count of the event) next to it when it is > 1
// The slots are right-aligned: x0 = W - (52 * count + 183) and +52 per resting star, y0 = H - 65 (bottom right, left of the
// weapon icon). Not reproduced: the training/ghost-mode branch (CGameContext 0x530c50), which hides the crest and uses another cell.

export const STAR_W = 52;
export const STAR_H = 56;
/** Hud.i3i cell of a star kind (0..7) */
export const starCell = (kind: number): { x: number; y: number; w: number; h: number } =>
  ({ x: 199 + STAR_W * (kind & 3), y: 337 + STAR_H * (kind >> 2), w: STAR_W, h: STAR_H });

export const MAX_STARS = 9;
const RING = 16;

export interface StarView {
  x: number; y: number; w: number; h: number;
  /** 0..255 */
  alpha: number;
  kind: number;
  /** the number beside the star (events with several victims), at (x, y) of the resting star */
  count: number;
}
export interface CrestView { x: number; y: number; w: number; h: number; alpha: number }
export interface StarsFrame { stars: StarView[]; crest: CrestView | null }

interface Sprite { x: number; y: number; w: number; h: number; a: number }

export class KillStars {
  private ring: { kind: number; count: number }[] = Array.from({ length: RING }, () => ({ kind: 0, count: 1 }));
  private head = 0;
  private n = 0;
  private state = new Array<number>(RING).fill(0);
  private spr: Sprite[] = Array.from({ length: RING }, () => ({ x: 0, y: 0, w: 0, h: 0, a: 0 }));
  private crest: Sprite = { x: 0, y: 0, w: 0, h: 0, a: 255 };
  private crestOn = false;

  get count(): number { return this.n; }

  /** _ResetStars: empty ring, crest hidden */
  reset(): void {
    this.head = 0;
    this.n = 0;
    this.state.fill(0);
    this.crestOn = false;
  }

  /** _AddKillStar: `kind` = Hud.i3i star variant (killmarks.ts starVariant), `count` = victims of the event */
  add(kind: number, count = 1): void {
    const e = this.ring[(this.head + this.n) % RING];
    e.kind = kind;
    e.count = count;
    if (this.n < MAX_STARS) this.n++;
    else this.head = (this.head + 1) % RING;
    this.state[this.n - 1] = 0;
  }

  /** one more victim of the same shot or blast as the newest star: its number goes up (the exe gets them in ONE event) */
  bumpLast(): boolean {
    if (!this.n) return false;
    this.ring[(this.head + this.n - 1) % RING].count++;
    return true;
  }

  /** `W` x `H` = the window in px (the exe draws CChainKills in absolute screen px) */
  update(dt: number, W: number, H: number): StarsFrame {
    const out: StarsFrame = { stars: [], crest: null };
    if (!this.n) return out;
    const sx = W / 1024, sy = H / 768;
    const crest = this.crest;
    let x0 = W - (this.n * STAR_W + 183);
    const y0 = H - 65;
    const tx = W - 235, ty = H - 65;
    const ftoi = Math.trunc;

    for (let i = 0; i < this.n; i++) {
      const e = this.ring[(this.head + i) % RING];
      const s = this.spr[i];
      let text = 0;

      if (this.state[i] === 0) {
        this.state[i] = 1;
        s.x = W * 0.5 - 26;
        s.y = H * 0.5 - 140;
        s.w = 520 * sx;
        s.h = 560 * sy;
        s.a = 0;
        crest.x = s.x - 17;
        crest.y = s.y - 17;
        crest.w = 80 * sx; // Cross: the crest is drawn 80 x 80
        crest.h = 80 * sy;
        crest.a = 255;
      }
      if (this.state[i] === 1) {
        s.w = Math.max(s.w - dt * 4160, STAR_W * sx);
        s.h = Math.max(s.h - dt * 4480, STAR_H * sy);
        s.a = Math.min(s.a + ftoi(dt * 500), 200);
        if (s.a > 80) this.crestOn = true;
        if (s.w === STAR_W * sx && s.h === STAR_H * sy && s.a === 200) this.state[i] = 2;
        if (this.crestOn) {
          crest.a = Math.max(crest.a - ftoi(dt * 300), 0);
          crest.w = Math.min(crest.w + dt * 240, 80 * sx);
          crest.h = Math.min(crest.h + dt * 240, 80 * sy);
        }
      }
      if (this.state[i] === 2) {
        s.w = Math.max(s.w - dt * 260, 6);
        s.h = Math.max(s.h - dt * 280, 7);
        s.a = Math.max(s.a - ftoi(dt * 1100), 0);
        this.crestOn = true;
        crest.a = Math.max(crest.a - ftoi(dt * 700), 0);
        if (s.a === 0 && s.w === 6 && s.h === 7) { this.state[i] = 3; this.crestOn = false; }
        const stepX = Math.abs(tx - s.x) / 10, stepY = Math.abs(ty - s.y) / 10;
        if (tx > s.x) s.x += stepX; else if (s.x > tx) s.x -= stepX;
        if (ty > s.y) s.y += stepY; else if (s.y > ty) s.y -= stepY;
        crest.w = Math.min(crest.w + dt * 240, 80 * sx);
        crest.h = Math.min(crest.h + dt * 240, 80 * sy);
      }
      if (this.state[i] === 3) {
        s.w = Math.min(s.w + dt * 988, 104);
        s.h = Math.min(s.h + dt * 1064, 112);
        s.a = 255;
        s.x = x0;
        s.y = y0;
        if (s.w === 104 && s.h === 112) this.state[i] = 4;
      }
      if (this.state[i] === 4) {
        s.w = Math.max(s.w - dt * 988, STAR_W);
        s.h = Math.max(s.h - dt * 1064, STAR_H);
        s.x = x0;
        s.y = y0;
        if (s.w === STAR_W && s.h === STAR_H) this.state[i] = 5;
      }
      if (this.state[i] === 5) {
        s.x = x0;
        s.y = y0;
        s.w = STAR_W;
        s.h = STAR_H;
        s.a = 255;
        x0 += STAR_W;
        if (e.count > 1) text = e.count;
      }
      out.stars.push({ x: s.x, y: s.y, w: s.w, h: s.h, alpha: s.a, kind: e.kind, count: text });
    }
    if (this.crestOn) out.crest = { x: crest.x, y: crest.y, w: crest.w, h: crest.h, alpha: crest.a };
    return out;
  }
}
