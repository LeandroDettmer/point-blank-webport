import { fxUrl, scopeLayout, sightInfo, type SightInfo } from "./sights";

/**
 * Scope / dot-sight HUD overlay (CHUD_Scope, 0x740b40 / 0x740f80) drawn with the Gui/Hud/<ScopeType> texture (Cross: enum -> HUD slot in CreateScopeHUD 0x736067, slot -> Gui/Hud file in InitHudTexture 0x763aa0; CROSS_SCOPE_TEX in export-weaponfx.mjs)
 * texture (public/assets/weapons/fx/scope/*.png) on a full-screen canvas; layout in sights.ts scopeLayout().
 * Scope levels (CGameCharaCameraContext::SetScopeLevel 0x816b30): each zoom press goes to level + 1 and past
 * MaxScopeLevel back to 0 (Cmd_ToggleZoom 0x78bdb0); leaving the scope resets the level (0x816fe0).
 * Self-contained DOM, no src/ui deps. Without weaponfx.json it keeps the old procedural lens ([RECRIADO]).
 */
export class ScopeOverlay {
  private el: HTMLCanvasElement | null = null;
  private visible = false;
  private sight: SightInfo | null = null;
  private weaponId = 0;
  private img: HTMLImageElement | null = null;
  private imgUrl = "";
  private drawnKey = "";
  /** current scope level (0 = off, 1 = FovOnScope, 2 = FovOnScope2) */
  level = 0;

  constructor() {
    if (typeof document === "undefined") return;
    const el = document.createElement("canvas");
    el.dataset.weaponScope = "";
    el.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;display:none;z-index:40;";
    document.body.appendChild(el);
    this.el = el;
    if (typeof addEventListener === "function") addEventListener("resize", () => this.visible && this.draw());
  }

  /** the weapon in hand (resets the level on change) */
  setWeapon(id: number): void {
    if (id === this.weaponId) return;
    this.weaponId = id;
    this.sight = sightInfo(id);
    this.level = 0;
    if (this.visible) this.draw(); // swapped while the overlay is up: show the new weapon's sight now
  }

  get info(): SightInfo | null {
    return this.sight ?? (this.sight = sightInfo(this.weaponId));
  }

  /** zoom key press: 0 -> 1 -> ... -> MaxScopeLevel -> 0 */
  press(): number {
    const n = Math.max(1, this.info?.levels.length ?? 1);
    this.level = this.level >= n ? 0 : this.level + 1;
    return this.level;
  }

  /** FOV for the scope while scoped (level >= 1, defaults to level 1 while the hold-to-aim input is down) */
  fov(fallback: number): number {
    const l = this.info?.levels;
    if (!l?.length) return fallback;
    return l[Math.min(l.length, Math.max(1, this.level)) - 1];
  }

  setVisible(v: boolean): void {
    if (!v) this.level = 0;
    else if (this.level === 0) this.level = 1;
    if (v === this.visible) return;
    this.visible = v;
    if (this.el) this.el.style.display = v ? "block" : "none";
    if (v) this.draw();
  }

  private draw(): void {
    const el = this.el;
    if (!el) return;
    const W = innerWidth, H = innerHeight, s = this.info;
    // the dot sub-rect is part of the key: weapons share one HUD texture with different dots (Cross enum 7 Scope_P90: the dot only when the weapon is neither
    // WeaponP90Ext nor WeaponDotLaser, SetSniperScope 0x7369b7), and an equal key skipped the redraw: the old dot stayed painted on the canvas
    const key = `${W}x${H}:${s?.hud}:${s?.dot?.join(",") ?? ""}`;
    if (el.width !== W || el.height !== H) { el.width = W; el.height = H; }
    const g = el.getContext("2d");
    if (!g) return;
    if (!s?.hud) return this.drawFallback(g, W, H);
    const url = fxUrl(s.hud);
    if (this.imgUrl !== url) {
      this.imgUrl = url;
      this.img = new Image();
      this.img.onload = () => this.visible && this.draw();
      this.img.src = url;
      this.drawnKey = "";
    }
    const img = this.img;
    if (!img?.complete || !img.naturalWidth) return this.drawFallback(g, W, H);
    if (this.drawnKey === key) return;
    this.drawnKey = key;
    g.clearRect(0, 0, W, H);
    g.imageSmoothingEnabled = true;
    for (const d of scopeLayout(W, H, s)) {
      // the side bars stretch the texture's first column: no filtering, or the sample bleeds into column 1+
      g.imageSmoothingEnabled = d.sw > 1;
      if (!d.mirror) g.drawImage(img, d.sx, d.sy, d.sw, d.sh, d.dx, d.dy, d.dw, d.dh);
      else {
        g.save();
        g.translate(d.dx + d.dw, d.dy);
        g.scale(-1, 1);
        g.drawImage(img, d.sx, d.sy, d.sw, d.sh, 0, 0, d.dw, d.dh);
        g.restore();
      }
    }
  }

  /** no exported scope texture: draw nothing rather than an invented lens */
  private drawFallback(g: CanvasRenderingContext2D, W: number, H: number): void {
    this.drawnKey = "";
    g.clearRect(0, 0, W, H);
  }

  dispose(): void {
    this.el?.remove();
  }
}
