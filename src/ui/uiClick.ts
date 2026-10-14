import { uiGain } from "../gameplay/settings.ts";
import { soundInfo } from "../gameplay/soundMix.ts";
import { newAudio } from "../audioUrl.ts";

/**
 * Select click of the i3UIButton set (Sound_Interface.i3Pack, pb-extract-tools export-charsfx2017.mjs -> sfx/char). 3.123 names
 * this clip UI_Button_Click_Select (the file this was picked by ear under, when sfx/char names were shifted by one, was named _Tab:
 * same audio); the real _Tab/_Ok clips are long and loud, so they are unused here.
 * HTMLAudio, cloned per play so rapid clicks overlap. Volume: Interface.RSC listener volume (UI_BUTTON_CLICK_TAB 60) x the
 * interface gauge (settings.uiVolume [RECRIADO]: in the exe UI clips are effect-type sounds, InitSound 0x6d4410, no interface gauge).
 */
const FILE = "/assets/sfx/char/UI_Button_Click_Select.wav";
export function playUiClick(): void { playUiSound(FILE); }

/** UISND clips of the exe (names at 0xd5cd78): 10 = UI_PAGE_SHIFT (a phase starts its exit slide, 0x8e54e0),
 * 11 = UI_POPUP_FADE_IN (a phase starts its entrance slide, 0x8e54c0). */
export const UI_PAGE_SHIFT = "/assets/sfx/char/UI_PAGE_SHIFT.wav";
export const UI_POPUP_FADE_IN = "/assets/sfx/char/UI_POPUP_FADE_IN.wav";

/** 13 = UI_SERVER_ENTER: played by the channel-list handler 0x8f9130 (PlaySound(13) at 0x8f921a) once the picked channel
 * passed its check and the enter request left; a failed check plays 14 UI_WARNING. The class owning 0x8f9130 is
 * UIPhaseSelectChannel [INFERIDO: same code range as its OnCreate 0x8f83e0]. */
export const UI_SERVER_ENTER = "/assets/sfx/char/UI_SERVER_ENTER.wav";
/** 12 = UI_SERVER_CONNECT: PlaySound(12) at 0x8fb062, last step of a handler that returns true (server-list pick
 * [INFERIDO: the owning class is not named; same code range as the channel-list handler 0x8f9130]). */
export const UI_SERVER_CONNECT = "/assets/sfx/char/UI_SERVER_CONNECT.wav";

/** 2 = UI_PopUp_Open: end of the popup base's open routine 0x7a0620 (PlaySound(2) at 0x7a0698, after its controls are reset)
 * [INFERIDO: the owning class is the shared popup base: 0x7a0620 sits in the vtables of the 0xc254bc / 0xc3966c popups]. */
export const UI_POPUP_OPEN = "/assets/sfx/char/UI_PopUp_Open.wav";
/** Point Blank Cross classic screens (CGuiNotifyReceiver sound table 0xd617bc, PlaySound 0x6fb7e0): 0 UI_Scroll_In when a
 * phase / step starts sliding in, 1 UI_Scroll_Out when a phase starts sliding out, 2 UI_PopUp_Open / 3 UI_PopUp_Close when
 * a CPopupBase opens / closes (OnOpenPopup 0x870ae0 / OnClosePopup 0x870b30) */
export const UI_SCROLL_IN = "/assets/sfx/char/UI_Scroll_In.wav";
export const UI_SCROLL_OUT = "/assets/sfx/char/UI_Scroll_Out.wav";
export const UI_POPUP_CLOSE = "/assets/sfx/char/UI_PopUp_Close.wav";
/** 4 = UI_Button_Click_Select: UIPhaseReadyRoom::ClickSlot 0x8f4a40 (0x8f4b70) and ClickRSlot 0x8f4b80 (0x8f4e63) when the clicked
 * team row holds a player (slot state not 0 / 1). */
export const UI_CLICK_SELECT = "/assets/sfx/char/UI_Button_Click_Select.wav";
/** 5 = UI_Item_Equip: UIPhaseInventory OnEquipWeapon 0x8ffc00 (0x8ffcbf), OnEquipCharacter 0x9012c0 (0x90153a), OnRemoveCharacter
 * 0x901720 (0x9017e6): played once the equip / remove request passed its local check. */
export const UI_ITEM_EQUIP = "/assets/sfx/char/UI_Item_Equip.wav";
/** 8 = UI_MOUSE_ON1: OnEnterMouse overrides play it when the hovered control is named btnStart (ReadyRoom 0x8f4880, 0x8f48bf) or
 * i3UIButtonComposed30 (channel / server lists 0x8f8f00, 0x8fa340). Which phase owns each override is [INFERIDO] (same code range as the
 * channel-list handler 0x8f9130). */
export const UI_MOUSE_ON1 = "/assets/sfx/char/UI_MOUSE_ON1.wav";
/** 14 = UI_WARNING: channel-list handler 0x8f9130 when its enter check fails (PlaySound(14) at 0x8f917c). */
export const UI_WARNING = "/assets/sfx/char/UI_WARNING.wav";

/** 7 = UI_MOUSE_CLICK: base OnClick 0x79dc80 (PlaySound(7) at 0x79dcba) for a plain button; short tick. Used by the inventory Equip
 * button so it does not stack the long Tab clip on UI_Item_Equip. */
export const UI_MOUSE_CLICK = "/assets/sfx/char/UI_MOUSE_CLICK.wav";

const bases = new Map<string, HTMLAudioElement>();
/** One UI clip at the listener, same mix as the click: its RSC listener volume (DEFAULT_INFO 100 when no list names it,
 * as UI_PAGE_SHIFT / UI_POPUP_FADE_IN) x interface gauge uiGain [RECRIADO] (exe: UI clips are effects-type sounds, no interface gauge). */
export function playUiSound(file: string): void {
  try {
    let base = bases.get(file);
    if (!base) { base = newAudio(file); bases.set(file, base); }
    const a = base.cloneNode() as HTMLAudioElement;
    a.volume = Math.min(1, (soundInfo(file).lvol / 100) * uiGain());
    void a.play().catch(() => {});
  } catch { /* audio is a nicety, never block input */ }
}

/** Option window (UI_Project_Popup.i3Pack, 2nd i3GuiRoot): the only controls with an I3GUI_EVENT_DATA (sound) are the 9 tab
 * buttons (UI_BUTTON_CLICK_TAB), opConfirm (UI_BUTTON_CLICK_OK) and opCancel (UI_BUTTON_CLICK_CANCEL); arrows, checkboxes,
 * combos and Padrão have none, and no PlaySound (0x79e0c0) sits in the window class (0x87c000-0x88c000). */
export const UI_CLICK_OK = "/assets/sfx/char/UI_Button_Click_Ok.wav";
export const UI_CLICK_CANCEL = "/assets/sfx/char/UI_Button_Click_Cancel.wav";
