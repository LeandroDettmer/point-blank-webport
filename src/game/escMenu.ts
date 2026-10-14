// In-battle ESC popup: Esc_PopupBG of the Point Blank Cross client (UI_Project_HUD.json, drawn by i3Gui like classicOptionWindow.ts;
// the same Cross atlases). Buttons: Option (Configuração, opens the classic Option window), Report and Vote Kick (ForciblyRemove)
// only in an online room battle (setSocial, battleSocial.ts), Exit (Sair), Cancel (Cancelar). The rows close up when the two
// social ones are hidden. Not in the Cross window, so gone from the old V12 scene: Mute (no backend), the full screen button and
// the leader vote / bug buttons (they were [RECRIADO] there). Their EscSocial hooks are still called by battleSocial.ts but no button shows them.
import { lockPointer } from "../lockPointer.ts";
import { Stage } from "../lobby/ui/LayoutRenderer.ts";
import { UI_BASE } from "../lobby/ui/assets.ts";
import { I3Gui, cloneNode, findNode, type GNode } from "../lobby/ui/i3Gui.ts";
import { loadStrings, tOr } from "../lobby/ui/i18n.ts";
import { jsonOnce } from "../jsonOnce.ts";
import { ClassicOptionWindow } from "./classicOptionWindow.ts";

const CROSS_BASE = `${UI_BASE}/cross`;
const WINDOW = "Esc_PopupBG";
/** button -> [STR key, fallback], in the order the Cross exe sets them (0x71992d..0x719a6d) */
const TEXT: Record<string, [key: string, fallback: string]> = {
  Esc_Popup_Option: ["STR_TBL_BATTLEGUI_OPTION_TEXT", "Configuração"],
  Esc_Popup_Report: ["STR_TBL_BATTLEGUI_REPORT", "Reportar"],
  Esc_Popup_ForciblyRemove: ["STR_EXIT_POPUP_FORCIBLYREMOVE", "Expulso"],
  Esc_Popup_Exit: ["STR_TBL_BATTLEGUI_EXIT_TEXT", "Sair"],
  Esc_Popup_Cancel: ["STR_TBL_BATTLEGUI_CANCEL_TEXT", "Cancelar"],
};
/** rows top to bottom (the file's own y: 50 + 32 per row) */
const ROWS = ["Esc_Popup_Option", "Esc_Popup_Report", "Esc_Popup_ForciblyRemove", "Esc_Popup_Exit", "Esc_Popup_Cancel"];
const SOCIAL_ROWS = ["Esc_Popup_Report", "Esc_Popup_ForciblyRemove"];
const ROW_TOP = 50, ROW_GAP = 32;

export interface EscSocial { report(): void; banVote(): void; leaderVote(): void; bug(): void }

export class EscMenu {
  private stage: Stage;
  private gui: I3Gui;
  private options: ClassicOptionWindow;
  private open = false;
  onLeave: (() => void) | null = null;
  private social: EscSocial | null = null;

  private constructor(host: HTMLElement, root: GNode, options: ClassicOptionWindow) {
    this.gui = new I3Gui({
      base: CROSS_BASE,
      text: (n) => { const t = TEXT[n.name]; return t ? tOr(t[0], t[1]) : undefined; },
    });
    this.stage = new Stage(host, 1024, 768, true); // the Cross i3Gui stretches X / Y. [INFERIDO] "px" (SetViewer(viewer, 0) at 0x718d62 read as 1:1) left the popup off-centre on wide windows: reverted
    this.stage.el.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:55;display:none;";
    this.gui.build(root, this.stage.design); // at its own place in the 1024x768 design
    this.options = options;
    this.layout();
    this.wire();
  }

  /** Match preload (game/matchPreload.ts): the HUD layout decoded so the first ESC draws at once. */
  static async preload(): Promise<void> {
    await Promise.all([loadStrings(), jsonOnce(`${CROSS_BASE}/UI_Project_HUD.json`)]);
  }

  static async create(host: HTMLElement): Promise<EscMenu> {
    await loadStrings();
    const root = findNode((await jsonOnce<{ root: GNode }>(`${CROSS_BASE}/UI_Project_HUD.json`)).root, WINDOW);
    if (!root) throw new Error(`[esc] no ${WINDOW} in UI_Project_HUD.json`);
    // the window is built from a copy: the cached object stays as exported
    return new EscMenu(host, cloneNode(root), await ClassicOptionWindow.create(host, true));
  }

  /** shows the rows that apply and stacks them from ROW_TOP (a hidden row leaves no hole) */
  private layout(): void {
    let y = ROW_TOP;
    for (const name of ROWS) {
      const on = !SOCIAL_ROWS.includes(name) || this.social !== null;
      this.gui.show(name, on);
      const b = this.gui.get(name);
      if (on && b) { b.el.style.top = `${y}px`; y += ROW_GAP; }
    }
  }

  private wire(): void {
    // main.ts: a body click re-locks the pointer. Clicks on the dim around the popup must not reach it either, or the
    // pointer locks with the menu still open (player can't move, menu stays up).
    this.stage.el.addEventListener("click", (e) => e.stopPropagation());
    this.gui.button("Esc_Popup_Cancel", () => this.close());
    this.gui.button("Esc_Popup_Exit", () => this.onLeave?.());
    this.gui.button("Esc_Popup_Option", () => { this.options.open(); });
  }

  /**
   * Online room battle: Reportar (Esc_Popup_Report) and Vote Kick (Esc_Popup_ForciblyRemove) show up in the rows above Exit.
   */
  setSocial(h: EscSocial): void {
    if (this.social) return;
    this.social = h;
    this.gui.button("Esc_Popup_Report", () => { this.hideForModal(); h.report(); });
    this.gui.button("Esc_Popup_ForciblyRemove", () => { this.hideForModal(); h.banVote(); });
    this.layout();
  }

  /** closes the menu without asking for the pointer lock back: a popup that needs the mouse opens right after */
  private hideForModal(): void {
    this.open = false;
    this.stage.el.style.display = "none";
    this.options.close();
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.openMenu();
  }

  openMenu(): void {
    this.open = true;
    this.stage.el.style.display = "block";
    if (document.pointerLockElement) document.exitPointerLock();
  }

  close(): void {
    this.open = false;
    this.stage.el.style.display = "none";
    this.options.close();
    if (document.pointerLockElement !== document.body) {
      try { void lockPointer(); } catch { /* no user gesture: main.ts blocker click re-locks */ }
    }
  }

  dispose(): void {
    this.options.dispose();
    this.stage.destroy();
  }
}
