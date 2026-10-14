// "ColorCrosshair" cash item popup of the Point Blank Cross client: useItemChangeColorCrosshairPopup in
// UI_Project_Popup.i3Pack (public/assets/ui/cross/UI_Project_Popup.json, i3Gui, same atlases as the option window).
// Ten ColorBox controls, one image set state per colour: state i = table entry i+1 of the exe (layout.ts CROSSHAIR_COLORS,
// entry 0 = white) [INFERIDO index mapping]. The select frame moves to the picked box (its x = box x - 2 inside the group).
// Texts: the file has no captions (the exe sets them in OnCreate 0x8a0a11..0x8a0c12 of the Cross exe): caption
// STR_POPUP_CAPTION_USE_ITEM, then STR_POPUP_USE_ITEM / STR_POPUP_CURRENT_COLOR / STR_POPUP_MODIFIED_COLOR on the three statics
// and STR_POPUP_MESSAGE_CHOOSE_MODIFY_COLOR on the notice.
import { Stage } from "../../lobby/ui/LayoutRenderer.ts";
import { UI_BASE } from "../../lobby/ui/assets.ts";
import { I3Gui, cloneNode, findNode, type GNode } from "../../lobby/ui/i3Gui.ts";
import { loadStrings, tOr } from "../../lobby/ui/i18n.ts";
import { jsonOnce } from "../../jsonOnce.ts";

const CROSS = `${UI_BASE}/cross`;
const WIN = "useItemChangeColorCrosshairPopup";
const BOXES = 10;

/** Opens the popup; resolves with the table index (1..10) or null when cancelled. */
export async function openCrosshairColorPopup(host: HTMLElement, current: number | null): Promise<number | null> {
  const [root] = await Promise.all([jsonOnce<{ root: GNode }>(`${CROSS}/UI_Project_Popup.json`), loadStrings().catch(() => ({}))]);
  const tree = findNode(root.root, WIN);
  if (!tree) throw new Error(`[crosshair color] no ${WIN} in UI_Project_Popup.json`);
  const stage = new Stage(host, 1024, 768, true);
  stage.el.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:60";
  const gui = new I3Gui({ base: CROSS });
  gui.build(cloneNode(tree), stage.design, 0, 0); // Cross design position kept (342,221)
  gui.setText("useItemChangeColorCrosshairPopupCaption", tOr("STR_POPUP_CAPTION_USE_ITEM", "Item utilizado"));
  gui.setText("useItemChangeColorCrosshairPopupTitleStatic", tOr("STR_POPUP_USE_ITEM", "Item usado:"));
  gui.setText("useItemChangeColorCrosshairPopupCurrentStatic", tOr("STR_POPUP_CURRENT_COLOR", "Cor atual:"));
  gui.setText("useItemChangeColorCrosshairPopupSelectStatic", tOr("STR_POPUP_MODIFIED_COLOR", "Cor alterada:"));
  gui.setText("useItemChangeColorCrosshairPopupNoticeValue", tOr("STR_POPUP_MESSAGE_CHOOSE_MODIFY_COLOR", "Escolha a cor desejada."));
  for (const n of ["useItemChangeColorCrosshairCross", "useItemChangeColorCrosshairCrossDot", "useItemChangeColorCrosshairDot", "useItemChangeColorCrosshairCircle"]) gui.hide(n);
  gui.setState("useItemChangeColorCrosshairCurrentColorBox", Math.max(0, (current ?? 1) - 1));

  let pick = current ?? 1;
  const frame = gui.get("useItemChangeColorCrosshairSelectColorSelected")?.el;
  const select = (i: number) => {
    pick = i + 1;
    gui.setState("useItemChangeColorCrosshairSelectColorSelected", i);
    if (frame) frame.style.left = `${5 + 17 * i - 2}px`;
  };
  select(Math.max(0, Math.min(BOXES - 1, pick - 1)));

  return new Promise((done) => {
    const close = (v: number | null) => { stage.destroy(); done(v); };
    for (let i = 0; i < BOXES; i++) {
      const name = `useItemChangeColorCrosshairSelectColorBox${i + 1}`;
      gui.get(name)?.el.style.setProperty("pointer-events", "auto");
      gui.get(name)?.el.addEventListener("click", () => select(i));
    }
    gui.button("useItemChangeColorCrosshairPopupOk", () => close(pick));
    gui.button("useItemChangeColorCrosshairPopupCancel", () => close(null));
  });
}
