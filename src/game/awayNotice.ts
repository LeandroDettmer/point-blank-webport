// Caution box of the in-battle away kick (awayChecker.ts): STBL_IDX_EP_GAME_AWAY_INPUT_BATTLE with its 5 s countdown.
// The exe opens it through CMessageBoxManager (0x518140, style 0x20004: no buttons); drawn as the Cross message popup
// without its Confirm (crossMessageBox.ts) [INFERIDO: which skin the battle's box draws is not decoded].
import { loadStrings, tOr } from "../lobby/ui/i18n.ts";
import { CrossMessageBox } from "./crossMessageBox.ts";

export class AwayNotice {
  private shownSec: number | null = null;

  private constructor(private box: CrossMessageBox) {}

  static async create(host: HTMLElement): Promise<AwayNotice> {
    await loadStrings();
    const box = await CrossMessageBox.create(host, { caption: tOr("STBL_IDX_COMMON_MSGBOX_CAPTION", "Aviso"), message: " ", modal: false });
    return new AwayNotice(box);
  }

  /** null hides the box; a number redraws "%d" */
  show(sec: number | null): void {
    if (sec === this.shownSec) return;
    this.shownSec = sec;
    this.box.show(sec !== null);
    if (sec === null) return;
    // the exe formats the string with sprintf: "%dsegundos" stays glued, as in the BR table
    const text = tOr("STBL_IDX_EP_GAME_AWAY_INPUT_BATTLE", "Como muito tempo não teve movimento será movido para sala %dsegundos depois.");
    this.box.setMessage(text.replace("%d", String(sec)));
  }

  dispose(): void {
    this.box.destroy();
  }
}
