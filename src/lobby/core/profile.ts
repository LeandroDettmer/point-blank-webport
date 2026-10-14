// Perfil / Títulos phase state (UIPhaseProfile, Designation tab): the picks the controller keeps and what the confirm button does
// (PointBlankRe_MyInfomation_Designation.lua SetDesignationSetCaption). The Cross shell (screensCross/pages/profile.ts) draws the
// tab; `` lists what is [INFERIDO] / [RECRIADO].
import { titleSlotOf, hasTitle, titleDef, type TitleState } from "./titleLogic.ts";

export interface ProfileData {
  state: TitleState;
  rank: number;
  /** title id shown in the detail panel (0 = none) */
  selected: number;
  /** equip slot picked (0..2) for, -1 = none */
  slotSel: number;
  busy: boolean;
}

/** what the confirm button does for the selected title (Lua SetDesignationSetCaption: GET / RELEASE / USE) */
export type ConfirmMode = "get" | "release" | "use" | "none";
export function confirmMode(d: Pick<ProfileData, "state" | "selected">): ConfirmMode {
  if (!titleDef(d.selected)) return "none";
  if (!hasTitle(d.state, d.selected)) return "get";
  return titleSlotOf(d.state, d.selected) >= 0 ? "release" : "use";
}

export type ProfileTab = "mission" | "designation";
