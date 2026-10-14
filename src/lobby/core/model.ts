// Lobby state shapes and tables shared by the controller (controller.ts) and the Point Blank Cross shell (screensCross):
// pages, chrome numbers, chat rows, room list order, item tab / filter ids and the create-window choices. No drawing here:
// the Cross shell paints its own i3Gui windows from this state. Control ids are the original 2017 scene names the
// controller's click(placement, control) still dispatches on.
import type { RoomInfo } from "../../net/gameClient.ts";
import { mapName } from "../../net/roomClient.ts";
import { AVAILABLE_MAPS, MAP_LABELS, mapIndexEntry } from "../../config.ts";
import type { ItemFilter, ItemTab } from "../state/itemInfo.ts";
import { modeLabel } from "./roomModes.ts";

export type RGBA = [number, number, number, number];

/** Stage name of a server mapId: roomClient's names, else the exported map index label. */
export function stageName(mapId: number): string {
  const known = mapName(mapId);
  if (!/^Map\d+$/.test(known)) return known;
  const id = AVAILABLE_MAPS.find((m) => mapIndexEntry(m)?.mapId === mapId);
  return (id && MAP_LABELS[id]) || known;
}

export type Page = "channels" | "lobby" | "room" | "inventory" | "shop" | "profile" | "clan";

export interface Chrome {
  page: Page;
  nickname: string;
  rank: number;
  expText: string;
  gold: number;
  cash: number;
  clan: string;
  record: string;
  kd: string;
  headshot: string;
  serverLabel: string;
  /** Main's Back works (channels: only with more than one server) */
  canBack: boolean;
}

export const EMPTY_CHROME: Chrome = { page: "channels", nickname: "", rank: 0, expText: "", gold: 0, cash: 0, clan: "", record: "", kd: "", headshot: "", serverLabel: "", canBack: false };

/** Main button -> page / action (tooltips of PointBlankRe_Main.lua). */
export const MAIN_BUTTONS = {
  clan: "i3UIButton18", inventory: "i3UIButton17", shop: "i3UIButton10", unknown: "i3UIButton", mail: "i3UIButton_Mail_Main",
  back: "i3UIButton9", options: "i3UIButton12", exit: "i3UIButton8",
} as const;

export type ChatTab = "all" | "team" | "whisper";
/** one line of the chat log, already formatted ("nick: text") with its colour; `nick` = sender of the line (right-click target
 *  of the Cross chat), undefined on Server / system lines */
export interface ChatRow { text: string; color: RGBA; nick?: string }

/** Chat tab -> control id. Original tab names: STR_TBL_CHAT_CHANNEL_TYPE_ALL / _TEAM / _WHISPER; the clan tab stays hidden */
export const CHAT_TABS: Record<ChatTab, string> = { all: "i3UITab_CW_01", team: "i3UITab0_CW_01", whisper: "i3UITab2_CW_01" };
/** line colours [RECRIADO]: the exe's own palette of the chat modes is not decoded; team / whisper follow the original hint texts
 * (STBL_IDX_CHATMESSAGE_HELP2 team = 98,180,253, HELP3 whisper = 237,86,250) */
export const CHAT_COLOR = {
  all: [232, 238, 244, 1] as RGBA, team: [98, 180, 253, 1] as RGBA, clan: [80, 255, 60, 1] as RGBA, whisper: [237, 86, 250, 1] as RGBA,
  system: [255, 204, 102, 1] as RGBA, gm: [255, 120, 70, 1] as RGBA,
};

/** room list columns a header click sorts by ("ping" = the Cross lobby lbPingCaption) */
export type RoomSortKey = "idx" | "name" | "mode" | "stage" | "member" | "state" | "ping";
export interface RoomSort { key: RoomSortKey; desc: boolean }
export const DEFAULT_ROOM_SORT: RoomSort = { key: "idx", desc: false };

/** Room list order picked by clicking a header column [RECRIADO: PointBlankRe_Lobby_RoomList.lua's sort wasn't
 * exported]; ties keep room number order. The controller joins through the same order. */
export function sortRooms(rooms: RoomInfo[], s: RoomSort): RoomInfo[] {
  const val = (r: RoomInfo): number | string =>
    s.key === "idx" ? r.roomId : s.key === "name" ? r.name.toLowerCase() : s.key === "mode" ? modeLabel(r.rule, r.stage, r.roomType)
      : s.key === "stage" ? stageName(r.mapId) : s.key === "member" ? r.players : s.key === "ping" ? r.ping : r.state;
  const dir = s.desc ? -1 : 1;
  return [...rooms].sort((a, b) => {
    const x = val(a), y = val(b);
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return c ? c * dir : a.roomId - b.roomId;
  });
}

/** item grid page (the pageUp / pageDown step of the inventory and shop) */
export const GRID_PAGE = 12;

export const INV_TABS: [string, ItemTab][] = [["i3UIButton_Weapon_ILB", "weapon"], ["i3UIButton_Character", "chara"], ["i3UIButton_item_ILB", "item"]];
/** Sub filter ids of the inventory tabs (Body/Lower have no server class: reused for beret/parts) [INFERIDO]. */
export const INV_SUBS: Record<ItemTab, [string, ItemFilter][]> = {
  weapon: [["All_ILB", "all"], ["MainWeapon_ILB", "primary"], ["SubWeapon_ILB", "secondary"], ["Melee_ILB", "melee"], ["Throw_ILB", "throw"], ["Special_ILB", "special"]],
  chara: [["All_Char_ILB", "all"], ["Character_ILB", "chara"], ["Hair_ILB", "head"], ["Mask_ILB", "face"], ["Body_ILB", "beret"], ["Lower_ILB", "parts"]],
  // the group buttons are the Cross scene's (UI_Project_Inven, ivItemGroup*)
  item: [["All_item_ILB", "all"], ["ivItemGroupMaintenance", "maintenance"], ["ivItemGroupExpendable", "expendable"]],
};

export const SHOP_TABS: [string, ItemTab][] = [["i3UIButton_Weapon", "weapon"], ["i3UIButton_Character", "chara"], ["i3UIButton_Item", "item"]];
/** Shop sub filters; Rush..ShotGun are primary sub-classes the store cannot tell apart: Rush = all primaries. */
export const SHOP_SUBS: Record<ItemTab, { frame: string; buttons: [string, ItemFilter][] }> = {
  weapon: { frame: "i3UIFrameWnd_Weapon", buttons: [["All_Weapon", "all"], ["Rush", "primary"], ["SubWeapon", "secondary"], ["Melee", "melee"], ["Thrown", "throw"], ["Special", "special"]] },
  chara: { frame: "i3UIFrameWnd_Character", buttons: [["All_Char", "all"], ["Character", "chara"], ["Hair", "head"], ["Mask", "face"], ["Body", "beret"], ["Lower", "parts"]] },
  item: { frame: "i3UIFrameWnd_Item", buttons: [["All_item", "all"], ["shopItemGroupMaintenance", "maintenance"], ["shopItemGroupExpendable", "expendable"]] },
};

export interface MapChoice { mapId: number; name: string }

/** visible map rows of the create window's map list; the list scrolls one row per step */
export const MAP_ROWS = 3;

