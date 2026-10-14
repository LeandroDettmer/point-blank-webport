// Message popup of the Point Blank Cross client: rrRankUpWin of UI_Project_ReadyRoom.json (frame, caption, message, Confirm), drawn
// by i3Gui from the Cross atlases. Used by the away caution box and the cache notice in place of the 2017 scene
// PointBlankRe_PopUp_Default. The name / mark rows of rrRankUpWin are hidden (no player in these boxes).
import { Stage } from "../lobby/ui/LayoutRenderer.ts";
import { UI_BASE } from "../lobby/ui/assets.ts";
import { I3Gui, cloneNode, findNode, type GNode } from "../lobby/ui/i3Gui.ts";
import { jsonOnce } from "../jsonOnce.ts";

const CROSS_BASE = `${UI_BASE}/cross`;
const WINDOW = "rrRankUpWin";

export interface MessageBoxOptions {
  caption: string;
  message: string;
  /** Confirm button; omitted = a box with no button */
  confirm?: { label: string; onClick: () => void };
  /** modal: dims the screen and takes the clicks; otherwise the game keeps running under the box (no dim, clicks pass through) */
  modal: boolean;
}

export class CrossMessageBox {
  private constructor(private gui: I3Gui, private stage: Stage) {}

  static async create(host: HTMLElement, o: MessageBoxOptions): Promise<CrossMessageBox> {
    const root = findNode((await jsonOnce<{ root: GNode }>(`${CROSS_BASE}/UI_Project_ReadyRoom.json`)).root, WINDOW);
    if (!root) throw new Error(`[message] no ${WINDOW} in UI_Project_ReadyRoom.json`);
    const gui = new I3Gui({ base: CROSS_BASE });
    const stage = new Stage(host, 1024, 768, true); // the Cross i3Gui stretches X / Y
    stage.el.style.cssText = o.modal
      ? "position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:70;display:block;"
      : "position:fixed;inset:0;z-index:54;display:none;pointer-events:none;background:transparent;";
    gui.build(cloneNode(root), stage.design); // at its own place in the 1024x768 design
    gui.hide("rrRankUpName");
    gui.hide("rrRankUpMark");
    gui.setText("rrRankUpCaption", o.caption);
    gui.setText("rrRankUpMessage", o.message);
    if (o.confirm) {
      gui.setText("rrRankUpConfirm", o.confirm.label);
      gui.button("rrRankUpConfirm", o.confirm.onClick);
    } else {
      gui.hide("rrRankUpConfirm");
      gui.hide("rrRankUpSeparate");
    }
    return new CrossMessageBox(gui, stage);
  }

  setMessage(s: string): void { this.gui.setText("rrRankUpMessage", s); }

  show(on: boolean): void { this.stage.el.style.display = on ? "block" : "none"; }

  destroy(): void { this.stage.destroy(); }
}
