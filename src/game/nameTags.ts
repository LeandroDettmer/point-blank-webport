// Nick over characters, from PointBlank.exe 2017 (Kaybo):
//  CHud::ShowHUDNick 0x750620 (every frame, all charas) -> CGameCharaHUDContext::ShowCharacterNick 0x826240:
//   - allies (same team): always, white (255,255,255), gated by a HUD option (g_d80ba8+0xbc, "Indicar aliados na mira"
//     STR_POPUP_DISPLAY_NICK_FOR_ALLY); no occlusion test (seen through walls)
//   - enemies: only the one under the crosshair, red (255,0,0) (CGameCharaCollisionContext::UpdateNickOnTarget 0x818e00:
//     world ray + hitshapes of the opposing team every 0.05 s, reach = min(wall hit, weapon range), skips state mask 0xb;
//     the last target is refreshed every frame until the ray finds another / none)
//   - anchor = chara pos + 1.9 m (0xbfeee0), projected; skipped when behind the camera or the chara is in state mask 0xb
//   - text left = viewW * nx - textWidth / 2; top = viewH * ny - trunc(distance) px (0 when > 9000) (0x74fc60)
// Font (Cross CHud::CreateHUD 0x73aea6..0x73af31, 16 nodes CHud+0xd98): default font Arial, size CHud+0xdd8 (12 GM / 11), weight 400,
// align left / top, no wrap; size -> px as every i3 text node (hudText.ts emPx). Cross nick tags 0x745240, size step 0x739a00.
// [INFERIDO]: the option default (assumed on), state mask 0xb = dead,
// the weapon flag (0x5b7160) that hides the enemy nick.
// GM (CPlayer 0x6b4a30) observing: ShowHUDNick 0x7507e0 drops the team rule, every other chara gets a nick while the ` flag is on
// (observerGm.ts gmNickView), no occlusion test; ShowCharacterNick 0x826240 -> CHud 0x74fe00: "%s -%dHP", red team (255,0,0),
// blue team (0,128,255), centered on the anchor without the distance lift; F9 swaps it for the seat badge (HUD4.png, 24x24 at
// x - 12, y - 10). The exe runs that GM branch for a GM who plays too: here only while observing [not ported for a live GM].
import * as THREE from "three";
import type { Actor } from "./types";
import { NICK_SIZE, gmNickText, idBadgeCell } from "./observerGm";
import { FONTS, UI_BASE } from "../lobby/ui/assets.ts";
import { emPx } from "./pbHud/hudText.ts";

const HEAD_UP = 1.9;
const TARGET_PERIOD = 0.05;
const ALLY = "rgb(255,255,255)";
const ENEMY = "rgb(255,0,0)";
const GM_BLUE = "rgb(0,128,255)";
// Cross Gui/Ingame/HUD4.i3i (ui/cross-hud, pb-extract-tools ui-export/cross-hud.mjs); cells: observerGm.ts idBadgeCell
const BADGE = `url("${UI_BASE}/cross-hud/hud/HUD4.png") no-repeat`;

/** GM observer nick mode: F9 badges, CHud+0xddc size, seat of an actor */
export interface GmNicks { ids: boolean; size: number; slotOf(a: Actor): number }

export class NameTags {
  private root = document.createElement("div");
  private pool: HTMLDivElement[] = [];
  private v = new THREE.Vector3();
  private cam = new THREE.Vector3();
  private target: Actor | null = null;
  private timer = 0;
  /** HUD option "show ally nick" (g_d80ba8+0xbc) */
  showAllies = true;

  constructor() {
    this.root.style.cssText = "position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:4";
    document.body.appendChild(this.root);
  }

  /** pickEnemy: the enemy under the crosshair within weapon reach (world-occluded), or null. gm: a GM observing (both teams). */
  update(dt: number, camera: THREE.PerspectiveCamera, me: Actor, actors: Iterable<Actor>, show: boolean, pickEnemy: () => Actor | null, gm: GmNicks | null = null): void {
    let n = 0;
    if (show && gm) {
      this.target = null;
      camera.getWorldPosition(this.cam);
      for (const a of actors) if (a !== me && a.alive) n = this.place(n, camera, a, false, gm);
    } else if (show) {
      this.timer += dt;
      if (this.timer >= TARGET_PERIOD) {
        this.timer = 0;
        this.target = pickEnemy();
      }
      if (this.target && (!this.target.alive || this.target.team === me.team)) this.target = null;
      camera.getWorldPosition(this.cam);
      for (const a of actors) {
        if (a === me || !a.alive) continue;
        const ally = a.team === me.team;
        if (ally ? !this.showAllies : a !== this.target) continue;
        n = this.place(n, camera, a, ally);
      }
    } else this.target = null;
    for (let i = n; i < this.pool.length; i++) this.pool[i].style.display = "none";
  }

  private place(n: number, camera: THREE.PerspectiveCamera, a: Actor, ally: boolean, gm: GmNicks | null = null): number {
    a.feet(this.v);
    this.v.y += HEAD_UP;
    const dist = this.v.distanceTo(this.cam);
    this.v.project(camera);
    if (this.v.z > 1) return n; // behind the camera
    const cell = gm?.ids ? idBadgeCell(gm.slotOf(a)) : null;
    if (gm?.ids && !cell) return n; // no seat (offline bot): no badge
    let el = this.pool[n];
    if (!el) {
      el = document.createElement("div");
      el.style.cssText = `position:absolute;left:0;top:0;white-space:nowrap;font:400 ${emPx("Arial", NICK_SIZE.normal).toFixed(2)}px ${FONTS.hudText};text-shadow:1px 1px 0 rgba(32,32,32,.85)`;
      this.root.appendChild(el);
      this.pool[n] = el;
    }
    if (el.style.display) el.style.display = "";
    const color = gm ? (a.team === 0 ? ENEMY : GM_BLUE) : ally ? ALLY : ENEMY;
    if (el.style.color !== color) el.style.color = color;
    const text = cell ? "" : gm ? gmNickText(a.name, a.hp) : a.name;
    if (el.textContent !== text) el.textContent = text;
    const fs = gm ? `${emPx("Arial", gm.size).toFixed(2)}px` : "";
    if (el.style.fontSize !== fs) el.style.fontSize = fs;
    const bg = cell ? `${BADGE} -${cell.x}px -${cell.y}px` : "", wh = cell ? "24px" : "";
    if (el.dataset.bg !== bg) { el.dataset.bg = bg; el.style.background = bg; el.style.width = el.style.height = wh; }
    const d = Math.trunc(dist);
    // transform moves the tag on the compositor: left/top rewrites forced a layout pass for every name, every frame
    const sx = (this.v.x * 0.5 + 0.5) * window.innerWidth, sy = (-this.v.y * 0.5 + 0.5) * window.innerHeight;
    // normal 0x74fc60: lifted by trunc(distance) px; GM 0x74fe00: no lift; badge: 24x24 at (x - 12, y - 10)
    const x = Math.round((cell ? sx - 12 : sx) * 10) / 10;
    const y = Math.round((cell ? sy - 10 : gm ? sy : sy - (d > 9000 ? 0 : d)) * 10) / 10;
    const tf = cell ? `translate(${x}px,${y}px)` : `translate(${x}px,${y}px) translateX(-50%)`;
    if (el.style.transform !== tf) el.style.transform = tf;
    return n + 1;
  }

  dispose(): void {
    this.root.remove();
  }
}
