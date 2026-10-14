// Browser shell of the Point Blank Cross lobby: the Lobby2017 controller (core/controller.ts: state, stores and network,
// no drawing) shown with the classic i3Gui windows of the Cross client (lobby/ui/i3Gui.ts). Pages: server / channel list (Ready_PhaseServer ssServerWin), lobby (Ready_PhaseLobby lbRoomWin / lbInfoWin /
// lbUserListWin / lbCreateWin), ready room (Ready_PhaseReadyRoom_New rrRoomWin), menu bar (Ready_MenuBar), join password
// (Ready_Popup lbJoinWin). Every control name -> text / action lives in crossMap.ts. Inventory / shop / profile are not
// drawn here yet (their menu-bar buttons are hidden). Same surface as LobbyScreen2017 for boot.ts.
import { bgmGain, onSettings } from "../../gameplay/settings.ts";
import type { PbBattleNet } from "../../net/battle.ts";
import type { RoomClient } from "../../net/roomClient.ts";
import type { LobbyPlayer, RoomInfoAdd } from "../../net/gameClient.ts";
import { WIRE_READY } from "../../net/roomClient.ts";
import { defaultServerUrl, GW_OVERRIDE } from "../../net/connection.ts";
import { clearSession } from "../../net/accountApi.ts";
import { allowLeave } from "../../ui/fullscreen.ts";
import { ClassicOptionWindow } from "../../game/classicOptionWindow.ts";
import { jsonOnce } from "../../jsonOnce.ts";
import { Stage } from "../ui/LayoutRenderer.ts";
import { UI_BASE } from "../ui/assets.ts";
import { I3Gui, TEXT_FONT, cloneNode, guiFont, renameTree, type GNode, type Img } from "../ui/i3Gui.ts";
import type { PlayerStore } from "../state/PlayerStore.ts";
import type { MissionClient } from "../../net/missionClient.ts";
import type { MapId } from "../../config.ts";
import { AI_COUNT_MAX, AI_LEVEL_MAX, Lobby2017, modeGroups, modeStageChoices, randomDefaultMaps, stageChoices } from "../core/controller.ts";
import { CHAT_TABS, sortRooms, stageName, type Page } from "../core/model.ts";
import { DEFAULT_KILLTIME, ROOM_MODES, conditionText, defaultKillTimeOf, killsText, modeIndex, modeLabel, modeText, roundsText, stepKillTime, timeText } from "../core/roomModes.ts";
import { DEFAULT_WATCH, STAGE_PASSWORD, STAGE_RANDOM_MAP, WATCH, randomMapIds, randomMapMask, weaponChecksOf, weaponsFlagOf, type WeaponChecks } from "../core/roomRules.ts";
import { WIRE_SLOT } from "../core/slotBadge.ts";
import { T } from "../core/strings.ts";
import { UI_CLICK_SELECT, UI_POPUP_CLOSE, UI_POPUP_OPEN, UI_SCROLL_IN, UI_SCROLL_OUT, playUiSound } from "../../ui/uiClick.ts";
import { CrossPages } from "./pages/index.ts";
import { nickCss, setIcon } from "./pages/common.ts";
import { CROSS_SLIDE_WINDOWS, CrossStage, type CrossPhase, type CrossStep, type CrossTarget } from "./slide.ts";
import { AI_GRADE_KEYS, CHAT_TAB, CLOCK_MODES, CROSS_CLICK, CROSS_HIDDEN, CROSS_PACKS, CROSS_SOUND, CROSS_TEXT, CROSS_WINDOWS, LEVEL_ICON, MAP_SHAPE, PC_CAFE_SHAPE, RECORD_WIN, ROOM_SELECT_SOUND, ROUND_WIN_MODES, SORT_COLUMN, LIST_MODE, SERVER_CARDS, infoMode, SERVER_CARD_COLS, SERVER_CARD_COLOR, SERVER_KIND, SERVER_TABS, SERVER_TAB_TEXT, type ServerTab, ANNOUNCE_SPEED, GAUGE_LEVELS, expBar, gaugeState, SPECIAL_WAR, STAGE_SHAPE, modeTag } from "./crossMap.ts";
import { mapFromRoomMapId, mapIndexEntry } from "../../config.ts";
import { NICK_COLORS } from "../../game/battleChatModel.ts";
import { markAtlas, paintMark } from "./clanMarkView.ts";
import { paintShapeIndex, setIconRedraw } from "./iconCanvas.ts";
import { chat } from "../../net/chatClient.ts";
import { CrossState, FriendErr, crossState, findUser, friendList, requestFriend } from "../../net/friendClient.ts";
import { noteList } from "../../net/noteClient.ts";
import { CMC, CMC_TEXT, canClanInvite, lobbyMenuItems, roomMenuItems } from "./contextMenu.ts";

/** channels shown in the channel list (user choice 2026-10-12: the first one only) */
const VISIBLE_CHANNELS = 1;
const BASE = `${UI_BASE}/cross`;
/** row pitch of ctList (the context menu's list template is not decoded) [INFERIDO] */
const CTX_ROW_H = 16;
/** Opções avançadas (rrAdvencedWin): the owner's copy of the rules until Confirmar / Cancelar */
interface AdvState { weapons: WeaponChecks; limit: boolean; balance: number; watch: number }
/** rrInviteWin rows (rrInviteCheck1..8) */
const INVITE_ROWS = 8;
/** rows of the lists, from the layouts: lbColumnN every 33 px (10), ssColumnN every 29 px (15), lbUserListSlotN every 25 px (8), rrRedSlotN every 24 px (8) */
const ROOM_ROWS = 10, ROOM_ROW_H = 33, SERVER_ROWS = 15, SERVER_ROW_H = 29, USER_ROWS = 8, TEAM_ROWS = 8, TEAM_ROW_H = 24, TEAM_ROW_Y = 10, USER_ROW_H = 25;
/** chat lines drawn in the text box (lbTextBox 109 px / rrTextBox 123 px) [INFERIDO line height] */
const CHAT_LINE_H = 15;
/** rows of the drop lists [INFERIDO]: the engine sizes a row to the font height + 2 (_ResizePopUp 0x1001e202) and the font of
 * these lists is not read; the map list (rrCreateMapPopup 120 px) shows 8 rows of 15, the difficulty list (240 px) its 10 levels */
const MAP_POPUP_ROW_H = 15;
/** DropdownWithScroll pieces of rrCreateMapPopup: 0..8 frame, 9 track, 10 down arrow (y 96), 11 up arrow (y 0), 12 thumb (60 px) */
const MAP_POPUP_THUMB = { y0: 24, y1: 36 };
/** RandomMapWin MapCheck0..39 (4 columns, x 15 / 140 / 265 / 382, rows every 22 px from y 45) */
const RANDOM_MAP_ROWS = 40;
/** the same pieces of the ready room's rrMapPopup (147 x 120: list area 127 px, arrows 20 px, thumb 48 px at y 20) */
const ROOM_MAP_POPUP_THUMB = { y0: 20, y1: 52 };

export interface LobbyScreenCrossOptions {
  session: { token: Uint8Array; username: string };
  onBattle(net: PbBattleNet, room: RoomClient): void;
  onLocalPlay(map: MapId, bots: { botCount: number; botSkill: number }): void;
}

type Pack = { root: GNode };

/** localStorage "pbweb.gw" only in the Vite dev build, as the 2017 shell */
function savedServerUrl(): string {
  if (!GW_OVERRIDE) return defaultServerUrl();
  try { return localStorage.getItem("pbweb.gw") || defaultServerUrl(); } catch { return defaultServerUrl(); }
}

/** a node and the summed offset of its ancestors (the windows are built at their absolute place) */
function locate(n: GNode, name: string, ox = 0, oy = 0): { node: GNode; ox: number; oy: number } | null {
  if (n.name === name) return { node: n, ox, oy };
  for (const c of n.children ?? []) { const f = locate(c, name, ox + n.x, oy + n.y); if (f) return f; }
  return null;
}

const pad3 = (n: number): string => String(n).padStart(3, "0");

/** ready-room slot badge (SlotState, UI_Source03 157..245,379..421): 0 PRONTO, 1 JOGAR, 2 inventory, 3 INFO, 4 shop, 5 CLAN;
 * -1 = none. 0x7d0c20: Cross state > 8 -> 1, else switch 0x7d0de8 on state - 2 (2 shop -> 4, 3 info -> 3, 4 clan -> 5,
 * 5 inventory -> 2, 8 ready -> 0), here on the 2017 server's numbering; gacha / gift shop (no Cross state) [INFERIDO] -> shop */
function slotState(wire: number): number {
  if (wire >= WIRE_SLOT.LOAD) return 1;
  switch (wire) {
    case WIRE_READY: return 0;
    case WIRE_SLOT.INVENTORY: return 2;
    case WIRE_SLOT.INFO: return 3;
    case WIRE_SLOT.CLAN: return 5;
    case WIRE_SLOT.SHOP: case WIRE_SLOT.GIFTSHOP: case WIRE_SLOT.GACHA: return 4;
    default: return -1;
  }
}

export class LobbyScreenCross {
  private host: HTMLDivElement;
  private stage: Stage;
  readonly ctl: Lobby2017;
  private gui: I3Gui | null = null;
  private strings: Record<string, string> = {};
  private repaints: (() => void)[] = [];
  /** mbCommunity alarm frame (true = sprite state 3) and its timer */
  private commFrame = false;
  private commBlink: ReturnType<typeof setInterval> | undefined;
  /** GET_ROOMINFOADD of the picked lobby room (2567 / 2568) and the room id of the request in flight (-1 = none) */
  private roomAdd: RoomInfoAdd | null = null;
  private roomAddFor = -1;
  private roomAddPending = false;
  private optionWindow: ClassicOptionWindow | null = null;
  /** inventory / shop / profile pages and the 3D character (pages/) */
  private pages: CrossPages | null = null;
  private bgm: HTMLAudioElement | null = null;
  private bgmName = "";
  private bgmVol = 1;
  private bgmFade: ReturnType<typeof setInterval> | undefined;
  /** first row shown by the room / user lists, chat lines scrolled back */
  private roomTop = 0;
  private userTop = 0;
  private chatBack = 0;
  private serverHover = -1;
  /** server cards: open tab, first row shown, card under the pointer (ssServerListWin) */
  private serverTab: ServerTab = "all";
  private serverTop = 0;
  private cardHover = -1;
  private roomHover = -1;
  /** popups opened since the last paint (inputs are filled once per opening) */
  private wasCreate = false;
  private wasPwd = false;
  private inputs: Record<string, HTMLInputElement | null> = {};
  /** open drop lists: the create window's map list (first row shown) and the ready room's AI difficulty */
  private mapPopup = false;
  /** lbSpecialWarWin open (0x831520(1) / (0)) */
  private specialWar = false;
  private mapTop = 0;
  private diffPopup = false;
  private mapRows: HTMLElement[] = [];
  private diffRows: HTMLElement[] = [];
  /** ready room map list (rrMapPopup, rrMapCombo 0x7ca650): open, first row shown, its rows */
  private roomMapPopup = false;
  private roomMapTop = 0;
  private roomMapRows: HTMLElement[] = [];
  /** map picture sprite drawn in each map box (lb / rr / rrCreate ImageDummy) and its atlas cell */
  private mapSprites = new Map<string, { key: string; el: HTMLElement }>();
  /** CMessageBox built for the current text / buttons ("" = none shown) */
  private msgKey = "";
  /** rrRecordWin unfolded (this+0x878; 0x7d5ed0 opens it so on entering the room), the page of the last paint */
  private recordShown = true;
  private wasRoom = false;
  /** Opções avançadas / Convidar of the owner, open until Confirmar or Cancelar (null = closed) */
  private adv: AdvState | null = null;
  private inv: { rows: LobbyPlayer[]; picks: boolean[] } | null = null;
  /** end of a mission in the room: the card (rrCardComplateWin), then the set window (rrFinalComplateWin / rrFinalComplateExWin), from the 2361 the controller holds */
  private roomDone: { step: "card" | "final" | "ex"; done: NonNullable<Lobby2017["missionDone"]> } | null = null;
  /** ready-room row under the pointer (rrRedList / rrBlueList ev1 focus 0x7ca760 / 0x7ca980) */
  private teamHover: { team: number; row: number } = { team: -1, row: -1 };
  /** phase / step slides (slide.ts): CStageReady swap + each window group's built elements and the ones on screen when it
   * last stood (an exit keeps showing what the page logic already hid) */
  private slideFx = new CrossStage((s) => playUiSound(s === "in" ? UI_SCROLL_IN : UI_SCROLL_OUT));
  private slideEls = new Map<CrossPhase | CrossStep, HTMLElement[]>();
  private slideShown = new Map<CrossPhase | CrossStep, HTMLElement[]>();
  /** windows the page logic showed but a hidden slide (state 1) took off: drawn again when that slide starts moving */
  private slideHidden = new Set<HTMLElement>();
  private slideLoop = false;
  /** CPopupBase windows open at the last paint (lbJoinWin = CPopupQueryPassword, RandomMapWin = CPopupRandomMap,
   * shopBuyPopup = CPopupShopBuy: their OnOpenPopup / OnClosePopup call the base 0x870ae0 / 0x870b30) */
  private popupsOpen = new Set<string>();
  /** right-click menu open now (null = closed) */
  private ctx: { nick: string; items: number[]; slot: number } | null = null;
  /** the exe's one shared menu state (CContextMenu at [holder+0x369c]): the target and items the last list builder
   * (lobby row, room slot, friend row) left. Closing does not clear it, and a chat right-click shows it again. */
  private menu: { nick: string; items: number[]; slot: number } | null = null;
  private ctxRows: HTMLElement[] = [];
  /** UserInfoPopup: the nick it shows, null = closed */
  private userInfo: string | null = null;
  private ctxOutside = (e: PointerEvent): void => { const el = this.gui?.get("ContextMenu")?.el; if (el && !el.contains(e.target as Node)) this.closeContext(); };

  constructor(opts: LobbyScreenCrossOptions) {
    this.host = document.createElement("div");
    this.host.id = "pbcross";
    this.host.style.cssText = "position:fixed;inset:0;z-index:49;background:#000";
    document.body.appendChild(this.host);
    // the emblem sheets load in the background; the controls that show a mark repaint when they are in (clanMarkView.ts)
    markAtlas(() => this.ctl.draw());
    // the rank / grade icon sheets repaint the same way (iconCanvas.ts)
    setIconRedraw(() => this.ctl.draw());
    this.stage = new Stage(this.host, 1024, 768, true); // i3GuiRoot SetViewer(viewer, 1): X / Y stretched to the window
    this.ctl = new Lobby2017({
      serverUrl: savedServerUrl(),
      username: opts.session.username,
      token: opts.session.token,
      render: () => { this.paint(); this.syncBgm(); },
      onBattle: (net, room) => { this.bgm?.pause(); opts.onBattle(net, room); },
      onLocalPlay: (map, bots) => { this.bgm?.pause(); opts.onLocalPlay(map, bots); },
      onOptions: () => { void this.openOptions(); },
      onExit: () => { this.bgm?.pause(); this.ctl.dispose(); clearSession(); allowLeave(); location.reload(); },
    });
    for (const ev of ["pointerdown", "keydown", "wheel"]) window.addEventListener(ev, () => this.ctl.touch(), { capture: true, passive: true });
    void this.boot();
    this.startBgm();
  }

  private async openOptions(): Promise<void> {
    // the Cross client's own Popup_Option (same controls as the Blackout window; Cross atlases + exe text attributes)
    this.optionWindow ??= await ClassicOptionWindow.create(document.body);
    this.optionWindow.open();
  }

  /**
   * Cross exe UIMainFrame phase BGM (pb-extract-tools export-cross-bgm.mjs, Sound_UI.i3Pack): SetPhase 0x7994c0 picks the track index of
   * 0x799392 (phases from the meta table 0x79a55c): SelectServer / SelectChannel / Lobby = NO1, ReadyRoom = NO4_2 (NO2 when
   * g(0xd85d70)->+0x314->+0x50 is set: [INFERIDO] clan-match room, none here), ClanMatch = NO2 (no page here). Sub-phases
   * (inventory / shop / profile) keep the track (0x799539). A change fades the old one out in 0.5 s (0x79935e -> 0x690f30),
   * then plays the new one looped at volume 1.0 (0x690ed0 args 1, 1, 1.0); NO2 / NO3_x / NO4_1 are otherwise unused.
   * [INFERIDO] this build never sets the table's gate byte +0x382c (only the ctor 0x79847c writes it), so the original only
   * plays NO1 on the login screen (UIPhaseLogin OnCreate 0x8e2779, faded 0.5 s when its scene unloads 0x8e263c) and the lobby
   * is silent; the phase table is played here anyway.
   */
  private syncBgm(): void {
    const a = this.bgm, page = this.ctl.page;
    if (!a || (this.bgmName && (page === "inventory" || page === "shop" || page === "profile"))) return;
    // [INFERIDO] user choice 2026-10-12: PB_BGM_NO4_2 (the exe ReadyRoom track) on every page; the exe phase table 0x799392 plays NO1 on
    // servers / channels / lobby. Kept as a one-name switch so the table can come back.
    const name = "PB_BGM_NO4_2";
    if (name === this.bgmName) return;
    const swap = () => {
      const playing = !a.paused;
      a.src = `/assets/sfx/cross/${name}.ogg`;
      a.volume = this.bgmVol;
      if (playing) void a.play().catch(() => {});
    };
    clearInterval(this.bgmFade);
    if (!this.bgmName || a.paused) { this.bgmName = name; swap(); return; }
    this.bgmName = name;
    const t0 = performance.now(), v0 = a.volume;
    this.bgmFade = setInterval(() => {
      const k = (performance.now() - t0) / 500;
      if (k < 1) { a.volume = v0 * (1 - k); return; }
      clearInterval(this.bgmFade);
      swap();
    }, 30);
  }

  private startBgm(): void {
    try {
      const a = new Audio();
      a.loop = true;
      this.bgm = a;
      this.syncBgm();
      onSettings((s) => { a.volume = this.bgmVol = bgmGain(s); });
      const kick = () => { void a.play().catch(() => {}); document.removeEventListener("pointerdown", kick); document.removeEventListener("keydown", kick); };
      void a.play().catch(() => { document.addEventListener("pointerdown", kick); document.addEventListener("keydown", kick); });
    } catch { /* audio is a nicety */ }
  }

  private async boot(): Promise<void> {
    const [packs, strings] = await Promise.all([
      Promise.all(CROSS_PACKS.map((p) => jsonOnce<Pack>(`${BASE}/${p}.json`))),
      jsonOnce<Record<string, string>>(`${BASE}/strings.json`).catch(() => ({})),
    ]);
    this.strings = strings;
    this.stage.design.style.visibility = "hidden"; // every window is visible until the first paint: no stacked flash on load
    this.build(Object.fromEntries(CROSS_PACKS.map((p, i) => [p, packs[i]])));
    this.stage.fit();
    await this.ctl.start();
  }

  /** text of a STR key (strings.json, the {col:...} colour tags dropped), the fallback without it */
  private str(key: string, fallback: string): string {
    const s = key ? this.strings[key] : undefined;
    return (s ?? fallback).replace(/\{\/?col[^}]*\}/g, "");
  }

  private textOf(name: string): string | undefined {
    const t = CROSS_TEXT[name];
    // the exe's colour markup ({col:...}) of the notice texts is dropped (the layout text has no colour run here)
    return t ? this.str(t[0], t[1]).replace(/\{col:[^}]*\}|\{\/col\}/g, "") : undefined;
  }

  // ---- building ---------------------------------------------------------------------------------------------------
  private build(packs: Record<string, Pack>): void {
    const caption = (n: GNode) => /(WinCaption|^ssServerCaption|^rrRoomCaption|^lbJoinCaption|^cxMsgCaption)$/.test(n.name);
    const gui = (this.gui = new I3Gui({
      base: BASE,
      text: (n) => this.textOf(n.name),
      caption,
      centred: (n) => n.cls === "Button" || caption(n) || /Caption$/.test(n.name) || /^lbSlot(Idx|Mode|Map|State|Person)\d+$|^ssSlotNumber\d+$|^ssServerSlotText\d+$|^cxMsgMessage$|^lbJoinMessage$/.test(n.name),
    }));
    for (const w of CROSS_WINDOWS) {
      const f = locate(packs[w.pack].root, w.name);
      if (!f) { console.warn(`[cross] ${w.pack}: no ${w.name}`); continue; }
      let node = f.node;
      if (w.as) { node = cloneNode(node); renameTree(node, w.name.replace(/Win$/, ""), w.as.replace(/Win$/, "")); }
      gui.build(node, this.stage.design, f.ox, f.oy);
    }
    for (const n of CROSS_HIDDEN) gui.hide(n);
    gui.hide("rrCreateMapPopup");
    gui.hide("rrTrainingDifficultyPopup");
    gui.hide("RandomMapWin");
    gui.hide("ContextMenu");
    gui.hide("UserInfoPopup");
    gui.hide("UserInfoPopupButton1"); // no str / text in the exe's map (the lobby info has no second button) [INFERIDO]
    gui.button("UserInfoPopupButton2", () => { if (this.userInfo) void this.addFriend(this.userInfo); });
    gui.button("UserInfoPopupClose", () => this.closeUserInfo());
    this.ctxRows = this.popupRows("ctList", CTX_ROW_H, 98, (i) => this.pickContext(i));
    this.startAnnounce();
    for (const [name, [p, c]] of Object.entries(CROSS_CLICK)) {
      const snd = CROSS_SOUND[name];
      this.repaints.push(gui.button(name, () => { if (snd) playUiSound(snd); this.ctl.click(p, c); }, () => this.enabled(name)));
    }
    this.wireServers();
    this.wireServerCards();
    this.wireLobby();
    this.wireCreate();
    this.wireSpecialWar();
    this.wireRoom();
    this.wireChat("lb");
    this.wireChat("rr");
    this.pages = new CrossPages(this.stage.design, gui.get("MenuBar")?.el, this.ctl, (k, f) => this.str(k, f), (nick) => void this.addFriend(nick), (nick) => this.inviteFriend(nick), (e, f, items) => this.openContext(e, f.nick, -1, items));
    const commBtn = gui.button("mbCommunity", () => { playUiSound(UI_CLICK_SELECT); this.stopCommunityAlarm(); this.pages?.openCommunity(); });
    this.repaints.push(() => { commBtn(); if (this.commFrame) gui.setState("mbCommunity", 3); });
    // recado ou pedido de amizade que chega ao vivo (a lista inicial do login não conta) liga o alarme
    let noteIds: Set<number> | null = null, reqNicks: Set<string> | null = null;
    noteList.subscribe(() => {
      const ids = new Set(noteList.list.map((n) => n.id));
      if (noteIds && [...ids].some((id) => !noteIds!.has(id))) this.startCommunityAlarm();
      noteIds = ids;
    });
    friendList.subscribe(() => {
      const nicks = new Set(friendList.list.flatMap((f) => (f && crossState(f.status) === CrossState.RECEIVED ? [f.nick] : [])));
      if (reqNicks && [...nicks].some((nick) => !reqNicks!.has(nick))) this.startCommunityAlarm();
      reqNicks = nicks;
    });
    this.inputs.join =gui.edit("lbJoinInput", { maxLength: 4, password: true, onInput: (v) => this.ctl.input("joinPassword", v), onEnter: () => this.ctl.click("pwd", "i3UIButtonOK") });
  }

  /** Alarme da Comunidade (exe CMenuBar: 0x81cc10 liga, 0x81cc30 desliga, 0x81d8c0 pisca a cada 0.25 s, `> 0.25` no
   * acumulado). Liga só com a janela fechada (0x513560); o clique em mbCommunity para (0x81c930). [INFERIDO]: a troca é
   * entre o sprite normal (state 0) e o state 3 do botão. */
  private startCommunityAlarm(): void {
    if (this.commBlink || this.pages?.communityOpen()) return;
    this.commBlink = setInterval(() => { this.commFrame = !this.commFrame; this.gui?.setState("mbCommunity", this.commFrame ? 3 : 0); }, 250);
  }

  private stopCommunityAlarm(): void {
    clearInterval(this.commBlink);
    this.commBlink = undefined;
    this.commFrame = false;
    this.gui?.setState("mbCommunity", 0);
  }

  /** buttons greyed out (state 3) by the controller state */
  private enabled(name: string): boolean {
    const c = this.ctl, cr = c.create, r = c.roomScreen?.room;
    switch (name) {
      case "ssEnter": return !c.busy && (c.channels ? c.channels.channelPlayers.length > 0 : c.servers.length > 0);
      case "ssPrev": return !c.busy && !!c.channels && c.servers.length > 1;
      case "lbCreateConfirm": return !!cr?.map && !cr.busy && !c.busy;
      case "rrOption": case "rrInvite": return !!r?.isLeader && !r.ai && (r.room?.state ?? 1) <= 1 && !c.busy;
      case "rrCreateTeamBalanceNo": case "rrCreateTeamBalanceYes": case "rrCreateTeamBalanceYes2": return !!cr && !ROOM_MODES[cr.mode].ai;
      default: return !c.busy || !/^(lb(Enter|Create|QuickStart|Refresh)|ss)/.test(name);
    }
  }

  /** a row index under the pointer inside `el` (design pixels: the stage is scaled) */
  private rowAt(el: HTMLElement, designH: number, e: MouseEvent, y0: number, rowH: number): number {
    const r = el.getBoundingClientRect(), k = r.height / designH;
    return Math.floor(((e.clientY - r.top) / k - y0) / rowH);
  }

  private wireServers(): void {
    const gui = this.gui!;
    for (let i = 0; i < SERVER_ROWS; i++) {
      const b = gui.get(`ssSlot${i + 1}`);
      if (!b) continue;
      b.el.style.cursor = "pointer";
      b.el.addEventListener("click", () => this.ctl.listSelect("channels", i));
      b.el.addEventListener("dblclick", () => this.ctl.listActivate("channels", i));
      b.el.addEventListener("pointerenter", () => { this.serverHover = i; this.paint(); });
      b.el.addEventListener("pointerleave", () => { if (this.serverHover === i) { this.serverHover = -1; this.paint(); } });
    }
  }

  /** servers of the open tab (index into ctl.servers) */
  private tabServers(): number[] {
    return this.ctl.servers.flatMap((sv, i) => (this.serverTab === "all" || SERVER_KIND[sv.type]?.tab === this.serverTab ? [i] : []));
  }

  /** TryEnterServer 0x820690: a closed server does nothing, a full one says USER_FULL, else the server's channels */
  private enterServer(i: number): void {
    const sv = this.ctl.servers[i];
    if (!sv?.online || this.ctl.busy) return;
    if (sv.maxPlayers > 0 && sv.players >= sv.maxPlayers) { this.ctl.say(this.str("STBL_IDX_EP_SERVER_USER_FULL_C", "Devido ao excesso de usuários no servidor, não foi possível conectar."), true); return; }
    this.ctl.listActivate("channels", i);
  }

  private wireServerCards(): void {
    const gui = this.gui!;
    for (let k = 0; k < SERVER_CARDS; k++) {
      const b = gui.get(`ssServerSlot${k + 1}`);
      if (!b) continue;
      const at = () => this.tabServers()[this.serverTop * SERVER_CARD_COLS + k];
      b.el.addEventListener("click", () => { const i = at(); if (i !== undefined && this.ctl.servers[i]?.online) this.ctl.listSelect("channels", i); });
      b.el.addEventListener("dblclick", () => { const i = at(); if (i !== undefined) this.enterServer(i); });
      b.el.addEventListener("pointerenter", () => { this.cardHover = k; this.paint(); });
      b.el.addEventListener("pointerleave", () => { if (this.cardHover === k) { this.cardHover = -1; this.paint(); } });
    }
    SERVER_TABS.forEach((_, n) => {
      const b = gui.get(`ssServer_Tab${n}`);
      if (!b) return;
      b.el.style.cursor = "pointer";
      b.el.addEventListener("click", () => {
        const tab = this.serverTabs()[n];
        if (!tab || tab === this.serverTab) return;
        this.serverTab = tab;
        this.serverTop = 0;
        this.ctl.chSelected = -1;
        this.paint();
      });
    });
    const rows = () => Math.ceil(this.tabServers().length / SERVER_CARD_COLS), shown = SERVER_CARDS / SERVER_CARD_COLS;
    const scroll = gui.scrollList("ssServerListScrollList", (d) => { this.serverTop = Math.max(0, Math.min(rows() - shown, this.serverTop + d)); this.paint(); });
    gui.get("ssServerListFrame")?.el.addEventListener("wheel", (e) => { e.preventDefault(); this.serverTop = Math.max(0, Math.min(rows() - shown, this.serverTop + Math.sign(e.deltaY))); this.paint(); }, { passive: false });
    this.repaints.push(() => scroll(this.serverTop, rows(), shown));
    this.repaints.push(gui.button("ssServer_Enter", () => this.enterServer(this.ctl.chSelected), () => !this.ctl.busy && !!this.ctl.servers[this.ctl.chSelected]?.online));
    this.repaints.push(gui.button("ssServer_ListRefresh", () => this.ctl.click("list", "i3UIButtonComposed3"), () => !this.ctl.busy));
  }

  /** tabs shown: "all" and the kinds that have a server, in the ServerListTab order, at most 6 */
  private serverTabs(): ServerTab[] {
    const kinds = new Set(this.ctl.servers.map((sv) => SERVER_KIND[sv.type]?.tab).filter(Boolean));
    return SERVER_TABS.filter((t) => t === "all" || kinds.has(t)).slice(0, 6);
  }

  private paintServerCards(): void {
    const gui = this.gui!, c = this.ctl, tabs = this.serverTabs();
    if (!tabs.includes(this.serverTab)) this.serverTab = "all";
    for (let n = 0; n < 6; n++) {
      const t = tabs[n];
      gui.show(`ssServer_Tab${n}`, !!t);
      if (!t) continue;
      gui.setText(`ssServer_Tab${n}`, this.str(...SERVER_TAB_TEXT[t]));
      gui.setState(`ssServer_Tab${n}`, t === this.serverTab ? 3 : 0);
    }
    const list = this.tabServers(), shown = SERVER_CARDS / SERVER_CARD_COLS;
    this.serverTop = Math.max(0, Math.min(this.serverTop, Math.ceil(list.length / SERVER_CARD_COLS) - shown));
    for (let k = 0; k < SERVER_CARDS; k++) {
      const i = list[this.serverTop * SERVER_CARD_COLS + k], sv = i === undefined ? undefined : c.servers[i], n = k + 1;
      gui.show(`ssServerSlot${n}`, !!sv);
      if (!sv) continue;
      const full = sv.maxPlayers > 0 && sv.players >= sv.maxPlayers, kind = SERVER_KIND[sv.type] ?? SERVER_KIND[0];
      gui.setText(`ssServerSlotText${n}`, `${this.str(...kind.name)} ${pad3(sv.index)}`);
      gui.setColor(`ssServerSlotText${n}`, !sv.online ? SERVER_CARD_COLOR.closed : full ? SERVER_CARD_COLOR.full : SERVER_CARD_COLOR.normal);
      gui.setState(`ssServerSlot${n}`, !sv.online ? 3 : i === c.chSelected ? 2 : this.cardHover === k ? 1 : 0);
      gui.get(`ssServerSlot${n}`)!.el.style.cursor = sv.online ? "pointer" : "default";
      gui.show(`ssServerSlotUserGage${n}`, sv.online);
      if (sv.online) gui.setState(`ssServerSlotUserGage${n}`, gaugeState(sv.players, sv.maxPlayers, GAUGE_LEVELS.server));
    }
  }

  private rooms() { return sortRooms(this.ctl.session?.lobby.roomList() ?? [], this.ctl.roomSort); }

  private wireLobby(): void {
    const gui = this.gui!, list = gui.get("lbList");
    for (let i = 0; i < USER_ROWS; i++) {
      const row = gui.get(`lbUserListSlot${i + 1}`) ?? gui.get(`lbUserListSlotNick${i + 1}`);
      row?.el.addEventListener("contextmenu", (e) => { e.preventDefault(); this.openLobbyMenu(e, this.userTop + i); });
    }
    if (list) {
      const row = (e: MouseEvent) => this.rowAt(list.el, list.node.h, e, 0, ROOM_ROW_H);
      list.el.style.cursor = "pointer";
      list.el.addEventListener("click", (e) => {
        const i = row(e);
        if (i < 0 || i >= ROOM_ROWS) return;
        if (this.rooms()[this.roomTop + i]) playUiSound(ROOM_SELECT_SOUND);
        this.ctl.listSelect("rooms", this.roomTop + i);
      });
      list.el.addEventListener("dblclick", (e) => { const i = row(e); if (i >= 0 && i < ROOM_ROWS) this.ctl.listActivate("rooms", this.roomTop + i); });
      list.el.addEventListener("pointermove", (e) => { const i = row(e); if (i !== this.roomHover) { this.roomHover = i; this.paint(); } });
      list.el.addEventListener("pointerleave", () => { this.roomHover = -1; this.paint(); });
    }
    const scroll = gui.scrollList("lbList", (d) => { this.roomTop = Math.max(0, Math.min(this.rooms().length - ROOM_ROWS, this.roomTop + d)); this.paint(); });
    this.repaints.push(() => scroll(this.roomTop, this.rooms().length, ROOM_ROWS));
    const users = gui.scrollList("lbUserListScroll", (d) => { this.userTop = Math.max(0, Math.min((this.ctl.session?.lobby.playerList().length ?? 0) - USER_ROWS, this.userTop + d)); this.paint(); });
    this.repaints.push(() => users(this.userTop, this.ctl.session?.lobby.playerList().length ?? 0, USER_ROWS));
    for (const [name, key] of Object.entries(SORT_COLUMN)) {
      const b = gui.get(name);
      if (!b) continue;
      b.el.style.cursor = "pointer";
      b.el.addEventListener("click", () => { playUiSound(CROSS_SOUND[name]); this.ctl.click("hit", `sort:${key}`); });
    }
  }

  /** lbSpecialWar / lbSpecialWarWin: the served rows trade their Empty art for button / description / title / arrow (see
   *); a click on any of the four closes the window, plays PlaySound(4) (0x827a0e) and runs the row. The hover
   * highlight of SetStateSpecialWarButton 0x827550 is not ported. */
  private wireSpecialWar(): void {
    const gui = this.gui!, c = this.ctl;
    const open = (on: boolean, snd: string) => () => { playUiSound(snd); this.specialWar = on; this.paint(); };
    this.repaints.push(gui.button("lbSpecialWar", open(true, CROSS_SOUND.lbSpecialWar), () => !c.busy && !c.create));
    this.repaints.push(gui.button("lbSpecialWarCancel", open(false, CROSS_SOUND.lbSpecialWarCancel)));
    for (const row of SPECIAL_WAR) {
      gui.setText(row.ctl[1], this.str(...row.desc));
      gui.setText(row.ctl[2], this.str(...row.title));
      gui.show(row.empty, !row.mode);
      for (const n of row.ctl) {
        gui.show(n, !!row.mode);
        const b = gui.get(n);
        if (!b || !row.mode) continue;
        b.el.style.cursor = "pointer";
        b.el.addEventListener("click", () => {
          if (c.busy) return;
          playUiSound(UI_CLICK_SELECT);
          this.specialWar = false;
          c.specialWar(row.mode!, row.name && this.str(...row.name));
          this.paint();
        });
      }
    }
  }

  private wireCreate(): void {
    const gui = this.gui!, c = this.ctl;
    // [RECRIADO] user choice 2026-10-13: centred in the 1024x768 view. The Cross pack puts lbCreateWin at 292,207 (486x500) and the
    // exe open handler 0x8325a0 does not move it, so the original sits low and right.
    const win = gui.get("lbCreateWin");
    if (win) {
      win.el.style.left = `${win.node.x + ((1024 - win.node.w) >> 1) - 292}px`;
      win.el.style.top = `${win.node.y + ((768 - win.node.h) >> 1) - 207}px`;
    }
    this.inputs.title = gui.edit("lbCreateTitleValue", { maxLength: 30, onInput: (v) => c.input("roomName", v) });
    this.inputs.pwd = gui.edit("lbCreatePasswordValue", { maxLength: 4, onInput: (v) => c.input("roomPassword", v) });
    const mode = (d: number) => {
      const cr = c.create;
      if (!cr || cr.busy) return;
      const normal = modeGroups(cr).normal, i = normal.indexOf(cr.mode);
      c.listSelect("modes", (i + d + normal.length) % normal.length);
    };
    const step = (which: "kills" | "time", d: number) => {
      const cr = c.create;
      if (!cr || cr.busy) return;
      const rounds = !!ROOM_MODES[cr.mode].rounds, n = which === "kills" ? 6 : rounds ? 3 : 6;
      for (let k = 0; k < (d > 0 ? 1 : n - 1); k++) cr.killTime = stepKillTime(cr.killTime, which, rounds);
      c.draw();
    };
    // rrCreateMapCombo (0x838620) drops rrCreateMapPopup, the map list; a pick sets the map and closes it
    const map = () => {
      const cr = c.create;
      if (!cr || cr.busy || !cr.maps.length) return;
      this.mapPopup = !this.mapPopup;
      if (this.mapPopup) this.mapTop = Math.max(0, Math.min(cr.maps.findIndex((m) => m.mapId === cr.map?.mapId), cr.maps.length - this.mapRows.length));
      this.paint();
    };
    this.mapRows = this.popupRows("rrCreateMapPopup", MAP_POPUP_ROW_H, 140, (i) => {
      const cr = c.create, m = cr?.maps[this.mapTop + i];
      if (!cr || cr.busy || !m) return;
      cr.map = m;
      this.mapPopup = false;
      c.draw();
    });
    const pop = gui.get("rrCreateMapPopup");
    if (pop) {
      const pieces = Array.from(pop.el.children) as HTMLElement[];
      const scroll = (d: number) => { const n = c.create?.maps.length ?? 0; this.mapTop = Math.max(0, Math.min(n - this.mapRows.length, this.mapTop + d)); this.paint(); };
      pop.el.addEventListener("wheel", (e) => { e.preventDefault(); scroll(Math.sign(e.deltaY)); }, { passive: false });
      for (const [k, d] of [[11, -1], [10, 1]] as const) {
        const el = pieces[k];
        if (!el) continue;
        el.style.pointerEvents = "auto";
        el.style.cursor = "pointer";
        el.addEventListener("click", (e) => { e.stopPropagation(); scroll(d); });
      }
    }
    const join = (on: boolean) => { if (c.create && c.create.limitEnter !== on) c.click("hit", "chk:inter"); };
    // random map (0x838410): rrCheckRandomMap flips room-option bit 2 and checks every map of the mode, without opening the
    // popup; rrLobbyRandomMapButton (enabled while checked, 0x8387c6) opens RandomMapWin (0x8384b0 -> CPopupRandomMap). The
    // controller opens its popup on the toggle: the toggle here confirms it at once, the button reopens it with the picks.
    gui.get("rrCheckRandomMap")?.el.addEventListener("click", (e) => {
      e.stopPropagation();
      const cr = c.create;
      if (!cr || cr.busy || ROOM_MODES[cr.mode].ai) return;
      c.click("hit", "chk:rand");
      if (c.create?.rm) c.click("hit", "rm:ok");
    });
    // rrCreateRandomMap (EditBox id -1, child of the box, no code touches it, 0x82acda): topmost control under the pointer
    // takes the click, so it does not reach the checkbox [INFERIDO from the i3Gui hit test]; its own sprite is transparent
    gui.get("rrCreateRandomMap")?.el.addEventListener("click", (e) => e.stopPropagation());
    // [RECRIADO] the random-map row (checkbox + its "Mapa aleatório" button child) sits 3 px lower than the pack's y 207,
    // which leaves the labelled button touching the map combo above
    const rmRow = gui.get("rrCheckRandomMap")?.el;
    if (rmRow) rmRow.style.marginTop = "3px";
    const rmOpen = () => { const cr = c.create; if (cr?.randomMap && !cr.busy) { c.click("hit", "chk:rand"); c.click("hit", "chk:rand"); } };
    for (let i = 0; i < RANDOM_MAP_ROWS; i++) {
      const b = gui.get(`MapCheck${i}`);
      if (!b) continue;
      b.el.style.cursor = "pointer";
      b.el.addEventListener("click", (e) => { e.stopPropagation(); if (c.create?.rm) c.click("hit", `rm:${i}`); });
    }
    this.repaints.push(
      gui.button("rrCreateModePrev", () => mode(-1)), gui.button("rrCreateModeNext", () => mode(1)),
      gui.button("rrCreateTypePrev", () => step("kills", -1)), gui.button("rrCreateTypeNext", () => step("kills", 1)),
      gui.button("rrCreateTimePrev", () => step("time", -1)), gui.button("rrCreateTimeNext", () => step("time", 1)),
      gui.button("rrCreateMapCombo", map),
      gui.button("rrCreateLimitJoinYes", () => join(true)), gui.button("rrCreateLimitJoinNo", () => join(false)),
      // exe 0x8387e0 / 0x838830: setInputDisable only (never setControlState), so the sprite stays state 0 when unchecked
      gui.button("rrLobbyRandomMapButton", rmOpen, () => !!c.create?.randomMap && !c.create.busy, 0),
      gui.button("RandomMapConfirm", () => c.click("hit", "rm:ok")), gui.button("RandomMapCancel", () => c.click("hit", "rm:cancel")),
      // CheckCountConfirm 0x8b13a0: hides the warning
      gui.button("CheckCountConfirm", () => { const rm = c.create?.rm; if (rm) { rm.warn = false; c.draw(); } }),
    );
  }

  private wireRoom(): void {
    const gui = this.gui!;
    // a row click picks the slot (ev0 0x7ca810 / 0x7caa30): another player's slot asks ROOM_GET_PLAYERINFO (3596 -> 3597,
    // the controller's inspect) and rrRecordWin shows them; a folded record window unfolds on the pick [INFERIDO]
    for (const [t, team, list] of [[0, "rrRed", "red"], [1, "rrBlue", "blue"]] as const) {
      const b = gui.get(team);
      if (!b) continue;
      const row = (e: MouseEvent) => this.rowAt(b.el, b.node.h, e, TEAM_ROW_Y, TEAM_ROW_H);
      b.el.style.cursor = "pointer";
      b.el.addEventListener("click", (e) => {
        const i = row(e);
        if (i < 0 || i >= TEAM_ROWS) return;
        this.recordShown = true;
        this.ctl.listSelect(list, i);
      });
      b.el.addEventListener("contextmenu", (e) => { e.preventDefault(); const i = row(e); if (i >= 0 && i < TEAM_ROWS) this.openRoomMenu(e, t + i * 2); });
      b.el.addEventListener("pointermove", (e) => {
        const i = row(e), h = i >= 0 && i < TEAM_ROWS ? i : -1;
        if (this.teamHover.team !== t || this.teamHover.row !== h) { this.teamHover = { team: t, row: h }; this.paint(); }
      });
      b.el.addEventListener("pointerleave", () => { this.teamHover = { team: -1, row: -1 }; this.paint(); });
    }
    // rrRecordCaption ev6 (0x7c9a40): fold / unfold the record window, which slides between y 436 and 686 (0x7d5db0)
    const rec = gui.get("rrRecordWin"), cap = gui.get("rrRecordCaption");
    if (rec) rec.el.style.transition = `top ${RECORD_WIN.slideS}s linear`;
    if (cap) {
      cap.el.style.cursor = "pointer";
      cap.el.addEventListener("click", () => { this.recordShown = !this.recordShown; this.paint(); });
    }
    // the change-team button: to the other team (the 2017 scene had one button per team)
    this.repaints.push(gui.button("rrChange", () => {
      const r = this.ctl.roomScreen?.room;
      if (r) this.ctl.click("team", r.mySlot % 2 === 0 ? "i3UIButton_BlueTeam" : "i3UIButton");
    }));
    // Opções avançadas (rrOption 0x7cabf0 -> rrAdvencedWin, owner only): a copy of the rules until Confirmar (0x7cb810: SetEvent(506)
    // + SetEvent(516) apply them) or Cancelar (0x7cbef0). Melee is always on; the weapon boxes lock in the special-weapon modes
    const openAdv = () => {
      const r = room(), info = r?.room;
      if (!r || !info || r.ai) return;
      this.adv = { weapons: weaponChecksOf(info.weaponsFlag), limit: info.opts?.limit === 1, balance: info.opts?.balanceType ?? 0, watch: info.opts?.watchRuleFlag ?? DEFAULT_WATCH };
      this.paint();
    };
    const advEdit = (fn: (a: AdvState) => void, weapon = false) => () => {
      const a = this.adv, info = this.ctl.roomScreen?.room?.room;
      if (!a || (weapon && (!info || ROOM_MODES[modeIndex(info.stage, info.roomType, info.rule)]?.special))) return;
      fn(a);
      this.paint();
    };
    const advConfirm = () => {
      const a = this.adv, r = room(), info = r?.room;
      // a special-weapon mode keeps its own weapons flag (the boxes are locked)
      if (a && r && info) {
        const special = !!ROOM_MODES[modeIndex(info.stage, info.roomType, info.rule)]?.special;
        r.changeRoomInfo({ weaponsFlag: special ? info.weaponsFlag : weaponsFlagOf({ ...a.weapons, melee: true }), limit: a.limit ? 1 : 0, balanceType: a.balance, watchRuleFlag: a.watch });
      }
      this.adv = null;
      this.paint();
    };
    const close = () => { this.adv = null; this.inv = null; this.paint(); };
    // Convidar (rrInvite 0x7ca2b0 -> rrInviteWin): the lobby users of the channel; Convidar sends one 877 per checked user
    const openInv = () => {
      const r = room(), me = this.ctl.chrome().nickname;
      if (!r || r.ai) return;
      const rows = (this.ctl.session?.lobby.playerList() ?? []).filter((u) => u.nickname !== me).slice(0, INVITE_ROWS);
      this.inv = { rows, picks: rows.map(() => false) };
      this.paint();
    };
    const invConfirm = () => {
      const inv = this.inv, c = this.ctl;
      const picked = inv ? inv.rows.filter((_, i) => inv.picks[i]) : [];
      for (const u of picked) c.clanNet?.roomInvite(u.sessionId);
      if (picked.length) c.say(this.str("STR_TBL_GUI_READY_NOTICE_SEND_INVITE", "Você enviou mensagem de convite a %d pessoas.").replace("%d", String(picked.length)));
      this.inv = null;
      this.paint();
    };
    this.repaints.push(
      gui.button("rrOption", openAdv, () => this.enabled("rrOption")), gui.button("rrInvite", openInv, () => this.enabled("rrInvite"), 0),
      gui.button("rrAdvencedConfirm", advConfirm), gui.button("rrAdvencedCancel", close),
      gui.button("rrLimitPrimary", advEdit((a) => { a.weapons.primary = !a.weapons.primary; if (!a.weapons.primary) a.weapons.rpg7 = false; }, true)),
      gui.button("rrLimitRPG7", advEdit((a) => { a.weapons.rpg7 = !a.weapons.rpg7; if (a.weapons.rpg7) a.weapons.primary = true; }, true)),
      gui.button("rrLimitSecondary", advEdit((a) => { a.weapons.secondary = !a.weapons.secondary; }, true)),
      gui.button("rrLimitThrow", advEdit((a) => { a.weapons.throw = !a.weapons.throw; }, true)),
      gui.button("rrLimitJoinYes", advEdit((a) => { a.limit = true; })), gui.button("rrLimitJoinNo", advEdit((a) => { a.limit = false; })),
      gui.button("rrTeamBalanceNo", advEdit((a) => { a.balance = 0; })), gui.button("rrTeamBalanceYes2", advEdit((a) => { a.balance = 1; })),
      gui.button("rrTeamBalanceYes", advEdit((a) => { a.balance = 2; })),
      // 1st-person only clears and locks 3rd person (the create window's obsFirst / obsThird rule)
      gui.button("rrReadyObserver1PV_Only", advEdit((a) => { a.watch ^= WATCH.FIRST_ONLY; a.watch &= ~WATCH.THIRD; })),
      gui.button("rrReadyObserver3PV_Free", advEdit((a) => { if (!(a.watch & WATCH.FIRST_ONLY)) a.watch ^= WATCH.THIRD; })),
      gui.button("rrReadyObserver1PV_Free", advEdit((a) => { a.watch ^= WATCH.ON; })),
      gui.button("rrReadyObserverEnemy_Free", advEdit((a) => { a.watch ^= WATCH.ENEMY; })),
      gui.button("rrReadyObserverEnemyHP_Free", advEdit((a) => { a.watch ^= WATCH.ENEMY_HP; })),
      gui.button("rrInviteConfirm", invConfirm), gui.button("rrInviteCancel", close),
      ...Array.from({ length: INVITE_ROWS }, (_, i) => gui.button(`rrInviteCheck${i + 1}`, () => {
        const inv = this.inv;
        if (inv && inv.rows[i]) { inv.picks[i] = !inv.picks[i]; this.paint(); }
      })),
      // end of mission: Confirmar of the card opens the set window when the set is whole (_OpenFinalPrizeWindow 0x7e1050) [INFERIDO: item -> Final, medals only -> Ex]
      gui.button("rrCardComplateConfirm", () => {
        const s = this.roomDone;
        if (!s) return;
        this.roomDone = s.done.whole ? { step: s.done.items.length ? "final" : "ex", done: s.done } : null;
        this.paint();
      }),
      gui.button("rrFinalComplateConfirm", () => { this.roomDone = null; this.paint(); }),
      gui.button("rrFinalComplateExConfirm", () => { this.roomDone = null; this.paint(); }),
      gui.button("rrFinalComplatePrizeConfirm", () => { this.roomDone = null; this.paint(); }),
    );
    // AI room rows (rrInfoTraining): time 0x7cb5d0 / 0x7cb5f0, enemy count 0x7cb610 / 0x7cb630, difficulty combo 0x7cb650 ->
    // rrTrainingDifficultyPopup pick 0x7cb670 (setCurrentDifficultyLevel + SetEvent(506)); here each sends ROOM_CHANGE_ROOMINFO_REQ
    const room = () => { const r = this.ctl.roomScreen?.room; return r?.isLeader && (r.room?.state ?? 1) <= 1 && !this.ctl.busy ? r : null; };
    const ai = (count: number, level: number) => {
      const r = room();
      if (r?.ai) r.changeRoomInfo({ ai: { count: Math.max(1, Math.min(AI_COUNT_MAX, count)), level: Math.max(1, Math.min(AI_LEVEL_MAX, level)) } });
    };
    const time = (d: number) => {
      const r = room();
      if (!r?.room) return;
      let kt = r.room.killTime || 0;
      for (let k = 0; k < (d > 0 ? 1 : 5); k++) kt = stepKillTime(kt, "time", false);
      r.changeRoomInfo({ killTime: kt });
    };
    const leader = () => !!room();
    // owner edits in the room (enabled for the leader only, 0x7cdefb): Objetivo / Limite de tempo arrows 0x7ca230..0x7ca290
    // (low / high nibble of killTime, SetEvent 505), title 0x7c9fa0 (empty -> PLEASE_ENTER_ROOM_NAME, cut to 22 bytes, sent
    // when changed: SetEvent 506); here each sends ROOM_CHANGE_ROOMINFO_REQ
    const step = (which: "kills" | "time", d: number) => {
      const r = room();
      if (!r?.room || r.ai) return;
      const rounds = r.room.roomType === 8 || r.room.roomType === 12, n = which === "kills" ? 6 : rounds ? 3 : 6;
      let kt = r.room.killTime || 0;
      for (let k = 0; k < (d > 0 ? 1 : n - 1); k++) kt = stepKillTime(kt, which, rounds);
      r.changeRoomInfo({ killTime: kt });
    };
    const title = () => {
      const r = room(), v = this.inputs.roomTitle?.value ?? "";
      if (!r?.room || r.ai) return;
      if (!v.trim()) { this.ctl.say(this.str("STR_TBL_GUI_READY_PLEASE_ENTER_ROOM_NAME", "Digite o nome da sala."), true); return; }
      if (v !== r.room.name) r.changeRoomInfo({ name: v });
    };
    this.inputs.roomTitle = gui.edit("rrTitleValue", { maxLength: 22, onEnter: () => title() });
    const normal = () => !!room() && !room()!.ai;
    this.repaints.push(
      gui.button("rrTypePrev", () => step("kills", -1), normal), gui.button("rrTypeNext", () => step("kills", 1), normal),
      gui.button("rrTimePrev", () => step("time", -1), normal), gui.button("rrTimeNext", () => step("time", 1), normal),
      gui.button("rrTitleChange", title, normal),
    );
    // mode arrows 0x7ca1b0 / 0x7ca1f0 -> 0x7d30b0 -> 0x7f4e10 (0x6e25f0) -> 0x7d2f10 (win condition reset, SetEvent 505).
    // Decoded: the stage table 0xd878f0 (init 0x6dfa70, 89 stages, type = stage >> 24 = Conditions / 4). With the room
    // flag bit 4 (0x599300 / 0x5a8900, normal room) the arrows jump to the other type of the pair Deathmatch (1) <-> Bomb (2)
    // (0x6e25f0 `mask & 4` branch), so ' normal list = the exe list. Special-weapon modes stay out of the arrows.
    // [INFERIDO] the exe then takes the first stage of the new type; here the map stays when the new mode allows it, else
    // the mode's first map. Leaving / entering a special-weapon mode takes that mode's weapon preset.
    const mode = (d: number) => {
      const r = room(), info = r?.room;
      if (!r || !info || r.ai) return;
      const cur = modeIndex(info.stage, info.roomType, info.rule), was = ROOM_MODES[cur];
      const list = ROOM_MODES.map((m, i) => (!m.ai && !m.special ? i : -1)).filter((i) => i >= 0);
      const md = ROOM_MODES[list[(list.indexOf(cur) + d + list.length) % list.length]];
      if (md === was) return;
      const maps = modeStageChoices(md);
      r.changeRoomInfo({
        rule: md.rule, stage: md.stage, roomType: md.roomType,
        mapId: maps.some((m) => m.mapId === info.mapId) ? info.mapId : maps[0]?.mapId,
        weaponsFlag: md.special || was.special ? md.weaponsFlag : info.weaponsFlag,
        killTime: defaultKillTimeOf(md),
      });
    };
    // password 0x7c9ed0: rrPasswordValue (4 chars) sent when it differs from the room's (SetEvent 507); "" clears it. The web
    // room never holds the password (the server only flags it), so the box shows "****" while one is set [INFERIDO]
    const PWD_MASK = "****";
    const pwd = () => {
      const r = room(), info = r?.room, v = this.inputs.roomPwd?.value ?? PWD_MASK;
      const had = ((info?.opts?.flag ?? 0) & STAGE_PASSWORD) !== 0;
      if (!r || !info || v === PWD_MASK || (!v && !had)) return;
      r.changeRoomInfo({ password: v });
    };
    this.inputs.roomPwd = gui.edit("rrPasswordValue", { maxLength: 4, onEnter: () => pwd() });
    this.inputs.roomPwd?.addEventListener("focus", () => this.inputs.roomPwd?.select());
    // map: rrMapCombo 0x7ca650 toggles rrMapPopup (filled by 0x7bfce0 with the mode's stages); a pick (ev0 0x7ca6b0) sets the
    // stage and sends (0x7d2f10). List = the create window's maps of the room's mode (stageChoices).
    const roomMaps = () => { const i = this.ctl.roomScreen?.room?.room; return i ? modeStageChoices(ROOM_MODES[modeIndex(i.stage, i.roomType, i.rule)]) : []; };
    const roomScroll = (d: number) => { this.roomMapTop = Math.max(0, Math.min(roomMaps().length - this.roomMapRows.length, this.roomMapTop + d)); this.paint(); };
    gui.hide("rrMapPopup");
    this.roomMapRows = this.popupRows("rrMapPopup", MAP_POPUP_ROW_H, 127, (i) => {
      const r = room(), m = roomMaps()[this.roomMapTop + i];
      this.roomMapPopup = false;
      if (r?.room && m && m.mapId !== r.room.mapId) r.changeRoomInfo({ mapId: m.mapId });
      this.paint();
    });
    const mpop = gui.get("rrMapPopup");
    if (mpop) {
      const pieces = Array.from(mpop.el.children) as HTMLElement[];
      mpop.el.addEventListener("wheel", (e) => { e.preventDefault(); roomScroll(Math.sign(e.deltaY)); }, { passive: false });
      for (const [k, d] of [[11, -1], [10, 1]] as const) {
        const el = pieces[k];
        if (!el) continue;
        el.style.pointerEvents = "auto";
        el.style.cursor = "pointer";
        el.addEventListener("click", (e) => { e.stopPropagation(); roomScroll(d); });
      }
    }
    const mapCombo = () => {
      const r = room(), maps = roomMaps();
      if (!r?.room || !maps.length) return;
      this.roomMapPopup = !this.roomMapPopup;
      if (this.roomMapPopup) this.roomMapTop = Math.max(0, Math.min(maps.findIndex((m) => m.mapId === r.room!.mapId), maps.length - this.roomMapRows.length));
      this.paint();
    };
    // CheckRandomMap 0x7cb750 (leader only, 0x7d2ee0): stage flag bit 2 = the box; with no random list yet (0x7d9580 < 1) the
    // mode's default list (0x7c0910 -> 0xa57cf0: the mode's stages minus those with sub byte 1, see randomDefaultMaps), then
    // SetEvent 506. Off in AI rooms, as the 2017 controller (randomFields).
    const random = () => {
      const r = room(), info = r?.room;
      if (!r || !info || r.ai) return;
      const flag = info.opts?.flag ?? 0, on = (flag & STAGE_RANDOM_MAP) === 0;
      r.changeRoomInfo({
        flag: (flag & ~STAGE_RANDOM_MAP) | (on ? STAGE_RANDOM_MAP : 0),
        randomMaps: on && !randomMapIds(info.opts?.randomMaps).length ? randomMapMask(randomDefaultMaps(roomMaps()).map((m) => m.mapId)) : undefined,
      });
    };
    // CheckRandomMap carries 13 images: 8..11 the box, 12 the tick (rrCheckRandomMap's 5 cells at the same atlas rects); the
    // generic Check build draws 0 / 4, so the art is redone here
    const rm = gui.get("CheckRandomMap"), rmi = rm?.node.images ?? [];
    if (rm && rmi.length >= 13) {
      rm.tick?.remove();
      rm.el.firstElementChild?.remove();
      rm.tick = gui.sprite(rm.el, rmi[12]);
      rm.tick.style.display = "none";
      rm.el.prepend(gui.sprite(rm.el, rmi[8]), rm.tick);
    }
    this.repaints.push(
      gui.button("rrModePrev", () => mode(-1), normal), gui.button("rrModeNext", () => mode(1), normal),
      gui.button("rrPasswordChange", pwd, leader), gui.button("rrMapCombo", mapCombo, leader),
      gui.button("CheckRandomMap", random, normal),
    );
    // slot kick / close / open (rr%sKick%d, id 0x30f + slot -> 0x7ca430 -> SetEvent 508): the slot, | 0x10000000 when the slot is
    // closed (opens it). Drawn on every slot (child of rr%sSlot%d); per frame (0x7cee10) enabled for the leader (0x7d2ee0), shape 3
    // otherwise, and the leader's slot (CGameContext+0x2cc00 main slot, 0x57e560) shape 4 = the host mark, for every viewer
    // (0x7cee7d..0x7ceeb9). A training room ignores slots >= 8.
    for (let slot = 0; slot < 16; slot++) {
      const name = `rr${slot % 2 ? "Blue" : "Red"}Kick${Math.floor(slot / 2) + 1}`, b = gui.get(name);
      if (!b) continue;
      const can = () => { const r = room(); return !!r && r.isLeader && slot !== r.mySlot && !(r.ai && slot >= 8); };
      b.el.addEventListener("pointerenter", () => { if (can()) gui.setState(name, 1); });
      b.el.addEventListener("pointerleave", () => this.paint());
      b.el.addEventListener("click", (e) => { e.stopPropagation(); const r = room(); if (r && can()) r.changeSlot(slot); });
      this.repaints.push(() => {
        const r = this.ctl.roomScreen?.room;
        gui.setState(name, r && slot === r.leaderSlot ? 4 : can() ? 0 : 3);
        b.el.style.cursor = can() ? "pointer" : "default";
      });
    }
    this.repaints.push(
      gui.button("rrTrainingTimePrev", () => time(-1), leader), gui.button("rrTrainingTimeNext", () => time(1), leader),
      gui.button("rrTrainingEnemyPrev", () => { const a = room()?.ai; if (a) ai(a.count - 1, a.level); }, leader),
      gui.button("rrTrainingEnemyNext", () => { const a = room()?.ai; if (a) ai(a.count + 1, a.level); }, leader),
      gui.button("rrTrainingDifficultyCombo", () => { this.diffPopup = !this.diffPopup; this.paint(); }, leader),
    );
    const diff = gui.get("rrTrainingDifficultyPopup");
    this.diffRows = this.popupRows("rrTrainingDifficultyPopup", diff ? Math.floor(diff.node.h / AI_LEVEL_MAX) : MAP_POPUP_ROW_H, 120, (i) => {
      this.diffPopup = false;
      const a = room()?.ai;
      if (a && i < AI_LEVEL_MAX) ai(a.count, i + 1);
      this.paint();
    });
  }

  /**
   * Rows of a PopupList drawn inside its frame: one text line each, `onPick(row)` on click. Row height [INFERIDO] (see
   * MAP_POPUP_ROW_H). Returns the row elements; the paint fills their text.
   */
  // ---- right-click menu of a player (contextMenu.ts) and the lobby's user info popup -----------------------------------
  private openLobbyMenu(e: MouseEvent, idx: number): void {
    const u = this.ctl.session?.lobby.playerList()[idx];
    if (u) this.openContext(e, u.nickname, idx, lobbyMenuItems(u.nickname === chat.myNick, this.canInviteClan(u.clanLogo)));
  }

  private openRoomMenu(e: MouseEvent, slot: number): void {
    const r = this.ctl.roomScreen?.room, s = r?.slots[slot];
    if (r && s?.nick) this.openContext(e, s.nick, slot, roomMenuItems(slot === r.mySlot, r.isLeader, this.canInviteClan(s.clanLogo)));
  }

  /** right-click on a chat line (lb / rr): the exe's handler 0x8747e0 does not read the line. It checks the owner is
   * CStageReady (0x6fbdc0), then shows the shared menu at the pointer (0x6fb980 -> 0x515580 -> popup vt+0xd8). Nothing
   * builds the items here, so the menu is the last one a list left: its items and its target nick, not the line's sender.
   * Before any list was opened the exe shows nothing. */
  private openChatMenu(e: MouseEvent): void {
    e.preventDefault();
    const m = this.menu;
    if (m) this.openContext(e, m.nick, m.slot, m.items);
  }

  /** Convite do Clã visível: minha autoridade no clã (profile.clanAccess) + alvo sem clã (contextMenu.ts canClanInvite) */
  private canInviteClan(targetClanLogo: number | undefined): boolean {
    return canClanInvite(this.ctl.session?.player.state.profile?.clanAccess ?? 0, targetClanLogo);
  }

  /** the menu at the pointer (design px, kept inside the 1024x768 view); a press outside it closes it */
  private openContext(e: MouseEvent, nick: string, slot: number, items: number[]): void {
    const gui = this.gui, win = gui?.get("ContextMenu");
    if (!gui || !win || !items.length) return;
    const r = this.stage.design.getBoundingClientRect();
    this.ctx = this.menu = { nick, items, slot };
    this.fillRows(this.ctxRows, items.map((c) => this.str(CMC_TEXT[c][0], CMC_TEXT[c][1])), 0, -1);
    win.el.style.left = `${Math.max(0, Math.min((e.clientX - r.left) * 1024 / r.width, 1024 - win.node.w))}px`;
    win.el.style.top = `${Math.max(0, Math.min((e.clientY - r.top) * 768 / r.height, 768 - win.node.h))}px`;
    gui.show("ContextMenu");
    document.addEventListener("pointerdown", this.ctxOutside, true);
  }

  private closeContext(): void {
    if (!this.ctx) return;
    this.ctx = null;
    this.gui?.show("ContextMenu", false);
    document.removeEventListener("pointerdown", this.ctxOutside, true);
  }

  private pickContext(i: number): void {
    const c = this.ctx, cmd = c?.items[i];
    if (!c || cmd === undefined) return;
    this.closeContext();
    playUiSound(UI_CLICK_SELECT);
    if (cmd === CMC.DETAIL_INFO) this.openUserInfo(c.nick);
    else if (cmd === CMC.WHISPER) this.whisper(c.nick);
    else if (cmd === CMC.ADD_FRIEND) void this.addFriend(c.nick);
    else if (cmd === CMC.CLAN_INVITE) void this.clanInviteMenu(c.nick);
    else if (cmd === CMC.INVITE) this.inviteFriend(c.nick);
    else if (cmd === CMC.FIND_OUT) { this.pages?.findFriend(c.nick); this.ctl.draw(); }
    else if (cmd === CMC.GIVE_MASTER) this.ctl.roomScreen?.room?.changeLeader(c.slot);
    else if (cmd === CMC.FORCE_GET_AWAY) this.ctl.roomScreen?.room?.changeSlot(c.slot);
  }

  /** Convite do Clã (menu): STR_TBL_GUI_LOBBY_Q_CLAN_INVITE_USER pede confirmação; OK -> 2426 acha o nick (o servidor guarda
   * findPlayer) e depois 888 -> 889. [RECRIADO] o fluxo de confirmação é o do clã (confirm); o exe não foi decodificado aqui. */
  private clanInviteMenu(nick: string): void {
    this.ctl.msg = {
      text: this.str("STR_TBL_GUI_LOBBY_Q_CLAN_INVITE_USER", "Deseja convidar [ %s ] para o clã?").replace("%s", nick),
      onOk: () => void this.sendClanInvite(nick), onCancel: () => {},
    };
    this.ctl.draw();
  }

  private async sendClanInvite(nick: string): Promise<void> {
    const conn = chat.connection;
    const found = conn ? await findUser(conn, nick) : false;
    const reply = found ? await this.ctl.clanNet?.invite() : undefined;
    this.ctl.msg = reply?.ok
      ? { text: this.str("STR_POPUP_MESSAGE_SEND_INVITE_MESSAGE", "Você enviou uma solicitação ao usuário [%s].").replace("%s", nick) }
      : { text: this.str(found ? "STR_TBL_NETWORK_FAIL_INVITED_USER" : "STR_TBL_NETWORK_NOT_FIND_USER", found ? "Não é possível convidar este usuário." : "Usuário não encontrado.") };
    this.ctl.draw();
  }

  /** PM: the lobby chat goes to its whisper tab aimed at `nick` (the same state the 2017 user menu sets) */
  private whisper(nick: string): void {
    chat.lastWhisper = nick;
    this.ctl.chatTab = "whisper";
    this.ctl.draw();
  }

  /** Convidar (friend list cmInvite, exe 0x884ae0): 877 to the lobby user with that nick, the same request as the room's
   * invite list (openInv / invConfirm). The server takes the session id of a lobby user, so the friend must be in the lobby list. */
  private inviteFriend(nick: string): void {
    const c = this.ctl, r = c.roomScreen?.room;
    // [RECRIADO] text: the exe's own refusal for a non-leader is not decoded (only the room leader's invite list exists here)
    if (!r?.isLeader || (r.room?.state ?? 1) > 1 || c.busy) return c.say("Só o dono da sala pode convidar.");
    const u = (c.session?.lobby.playerList() ?? []).find((x) => x.nickname === nick);
    if (!u) return c.say(this.str("STR_POPUP_MESSAGE_INVITE_ONLINE_FRIEND", "Convide apenas amigos online no canal."));
    c.clanNet?.roomInvite(u.sessionId);
    c.say(this.str("STR_TBL_GUI_READY_NOTICE_SEND_INVITE", "Você enviou mensagem de convite a %d pessoas.").replace("%d", "1"));
  }

  /** Adicionar amigo (1811 by nick). Result text = the exe's STR for each outcome, shown in the message box. */
  private async addFriend(nick: string): Promise<void> {
    const conn = chat.connection;
    const err = conn ? await requestFriend(conn, nick) : 0x80000000;
    const [key, fallback] = err === 0 ? ["STR_TBL_GUI_BASE_NOTICE_ADD_FRIEND_COMPLETE", "[%s] foi cadastrado na sua lista de amigos."]
      : err === FriendErr.SELF && nick === chat.myNick ? ["STBL_IDX_CLAN_MESSAGE_MYSELF_FRIEND", "Não é possível adicionar você mesmo em sua lista."]
      : err === FriendErr.FULL ? ["STR_POPUP_MESSAGE_NO_MORE_FRIEND", "Não é possível adicionar mais amigos."]
      : err === FriendErr.ALREADY ? ["STR_POPUP_MESSAGE_ALREADY_FRIEND", "Usuário [%s] já está na sua lista de amigos."]
      : err === FriendErr.NOT_FOUND ? ["STR_TBL_NETWORK_NOT_FIND_USER", "Usuário não encontrado."]
      : ["STR_TBL_GUI_BASE_FAIL_REQUEST_FRIEND", "Não conseguiu adicionar o amigo à lista."];
    this.ctl.msg = { text: this.str(key, fallback).replace("%s", nick) };
    this.ctl.draw();
  }

  /** Informações: UserInfoPopup with the nick. The records come from 2350 (RecordInfoDB), which takes the player's pid; the
   * lobby list only carries the session id, so the record rows stay empty [NEXT]. */
  private openUserInfo(nick: string): void {
    this.userInfo = nick;
    this.gui?.setText("UserInfoPopupNicknameValue", nick);
    this.gui?.show("UserInfoPopup");
    this.popupSounds();
  }

  private closeUserInfo(): void {
    this.userInfo = null;
    this.gui?.show("UserInfoPopup", false);
    this.popupSounds();
  }

  private popupRows(name: string, rowH: number, width: number, onPick: (i: number) => void): HTMLElement[] {
    const b = this.gui?.get(name);
    if (!b) return [];
    const rows: HTMLElement[] = [];
    for (let i = 0; i < Math.floor((b.node.h - 4) / rowH); i++) {
      const d = document.createElement("div");
      d.style.cssText = `position:absolute;left:4px;top:${2 + i * rowH}px;width:${width - 8}px;height:${rowH}px;line-height:${rowH}px;overflow:hidden;white-space:nowrap;cursor:pointer;`
        + `font:bold 11px ${TEXT_FONT};color:#c9ced6;text-shadow:1px 1px 0 rgba(0,0,0,.8);`;
      d.addEventListener("click", (e) => { e.stopPropagation(); onPick(i); });
      d.addEventListener("pointerenter", () => { d.style.color = "#fff"; });
      d.addEventListener("pointerleave", () => { d.style.color = d.dataset.sel ? "#ffd24a" : "#c9ced6"; });
      b.el.appendChild(d);
      rows.push(d);
    }
    return rows;
  }

  /** fills popup rows: texts from `first`, the selected one in yellow */
  private fillRows(rows: HTMLElement[], texts: string[], first: number, sel: number): void {
    rows.forEach((d, i) => {
      const t = texts[first + i] ?? "";
      if (d.textContent !== t) d.textContent = t;
      d.dataset.sel = first + i === sel ? "1" : "";
      d.style.color = first + i === sel ? "#ffd24a" : "#c9ced6";
      d.style.display = t ? "" : "none";
    });
  }

  /** chat box of the lobby (lb) / ready room (rr): tabs, the input line, the log with its scroll bar */
  private wireChat(p: "lb" | "rr"): void {
    const gui = this.gui!;
    for (const [n, tab] of Object.entries(CHAT_TAB[p])) {
      const b = gui.get(`${p}ChatTab${n}`);
      if (!b) continue;
      b.el.style.cursor = "pointer";
      b.el.addEventListener("click", () => this.ctl.click("chat", CHAT_TABS[tab]));
    }
    const input = gui.edit(`${p}ChatBox`, { maxLength: 100, onEnter: (v) => { if (this.ctl.submit("chat", v)) input!.value = ""; } });
    gui.get(`${p}TextBox`)?.el.addEventListener("contextmenu", (e) => this.openChatMenu(e));
    const list = p === "lb" ? "lbChatList" : "rrList";
    const scroll = gui.scrollList(list, (d) => { this.chatBack = Math.max(0, Math.min(this.ctl.chatRows().length - this.chatLines(p), this.chatBack - d)); this.paint(); });
    this.repaints.push(() => { const n = this.ctl.chatRows().length, v = this.chatLines(p); scroll(Math.max(0, n - v - this.chatBack), n, v); });
  }

  private chatLines(p: "lb" | "rr"): number {
    const b = this.gui?.get(`${p}TextBox`);
    return b ? Math.floor(b.node.h / CHAT_LINE_H) : 7;
  }

  // ---- painting ---------------------------------------------------------------------------------------------------
  /** multi-line text (message box, chat log): own div, pre-line */
  private lines(name: string, rows: { text: string; color?: string }[], centred = false, hit = false): void {
    const b = this.gui?.get(name);
    if (!b) return;
    let box = b.el.querySelector<HTMLElement>(":scope > .cx-lines");
    if (!box) {
      box = document.createElement("div");
      box.className = "cx-lines";
      box.style.cssText = `position:absolute;left:4px;top:2px;right:4px;bottom:2px;overflow:hidden;white-space:pre-line;font:bold 11px ${TEXT_FONT};line-height:${CHAT_LINE_H}px;text-shadow:1px 1px 0 rgba(0,0,0,.8);`
        + (centred ? "display:flex;flex-direction:column;justify-content:center;text-align:center;" : "");
      b.el.appendChild(box);
    }
    box.style.pointerEvents = hit ? "auto" : "none"; // chat log: each line is a hit target (right-click on a nick)
    box.replaceChildren(...rows.map((r) => { const d = document.createElement("div"); d.textContent = r.text; d.style.color = r.color ?? "#c9ced6"; return d; }));
  }

  private paint(): void {
    const gui = this.gui, c = this.ctl;
    if (!gui) return;
    this.stage.design.style.visibility = "";
    this.slideHidden.clear(); // the shows / hides below are the page logic; applySlides re-hides what is still slid out
    const page: Page = c.page;
    const loading = c.loading ?? (c.loadingRooms && page === "lobby" && !c.roomScreen ? T.loadingRooms : null);
    const chrome = c.chrome();
    // CPhaseServerList (server cards) until a server is picked, then CPhaseChannelList (ssServerWin)
    gui.show("ssServerListWin", page === "channels" && !c.channels);
    gui.show("ssServerWin", page === "channels" && !!c.channels);
    for (const w of ["lbUserListWin", "lbRoomWin"]) gui.show(w, page === "lobby");
    // 0x836850: no room picked (this+0x698 == -1) -> 0x834450 clears the values and hides lbInfoWin (vf +0x110, 0 at 0x834594)
    gui.show("lbInfoWin", page === "lobby" && !!this.rooms()[c.roomSel]);
    gui.show("rrRoomWin", page === "room");
    gui.show("rrRecordWin", page === "room");
    // the owner's windows close when the page leaves the room; the end-of-mission windows take the 2361 the controller holds, in the
    // room only (the profile's prCardComplateWin keeps the other pages)
    if (page !== "room") { this.adv = null; this.inv = null; }
    else { const d = c.missionDone; if (d && !this.roomDone) { this.roomDone = { step: "card", done: d }; c.missionDone = null; } }
    gui.show("rrAdvencedWin", !!this.adv);
    gui.show("rrInviteWin", !!this.inv);
    if (this.adv) this.paintAdv();
    if (this.inv) this.paintInv();
    this.paintRoomDone(page);
    if (page === "room" && !this.wasRoom) this.recordShown = true;
    this.wasRoom = page === "room";
    gui.show("lbCreateWin", !!c.create);
    if (page !== "lobby" || c.create) this.specialWar = false;
    gui.show("lbSpecialWarWin", this.specialWar);
    gui.show("lbJoinWin", !!c.pwdPrompt);
    // menu bar
    gui.setText("mbNickname", chrome.nickname);
    // 0x81cde9: nick colour 0 -> colour 3 (the text attr's #000000), else 0x4ad850 SetTextColor(table 0xb210a4[nick colour])
    const myColor = c.player?.state.invItem?.nickColor ?? 0;
    gui.setColor("mbNickname", myColor ? `rgb(${(NICK_COLORS[myColor] ?? NICK_COLORS[0]).join(",")})` : "");
    this.paintExp(chrome.nickname ? Number(chrome.expText) || 0 : null, chrome.rank);
    gui.setText("mbPinoValue", chrome.gold.toLocaleString("pt-BR"));
    gui.setText("mbNcCoinValue", chrome.cash.toLocaleString("pt-BR"));
    gui.setText("mbAnnounce", c.log.at(-1) ?? "");
    this.rankIcon("mbRankMark", chrome.nickname ? chrome.rank : null);
    if (page === "channels") { if (c.channels) this.paintServers(); else this.paintServerCards(); }
    if (page === "lobby") this.paintLobby();
    if (page === "room") this.paintRoom();
    if (page === "lobby" || page === "room") this.paintChat(page === "lobby" ? "lb" : "rr");
    this.paintCreate();
    this.paintPopups(loading);
    this.pages?.paint();
    for (const f of this.repaints) f();
    this.applySlides();
    this.popupSounds();
  }

  /** the page as CStageReady sees it: inventory / shop / profile are steps over the phase they were opened from */
  private slideTarget(): CrossTarget {
    const c = this.ctl, p = c.page;
    if (p === "inventory" || p === "shop" || p === "profile") return { phase: c.menuFrom, step: p };
    // Clã (2017 page): the Cross clan menu is its own popup (pages/clan.ts), this page is reached only from the 2017 lobby
    if (p === "clan") return { phase: c.menuFrom, step: null };
    return { phase: p === "channels" ? (c.channels ? "channels" : "servers") : p, step: null };
  }

  private slideWindows(k: CrossPhase | CrossStep): HTMLElement[] {
    const names = CROSS_SLIDE_WINDOWS[k].names;
    let els = this.slideEls.get(k);
    if (els?.length === names.length) return els;
    // the step pages build later (pages/): look again until every window is there
    els = names.flatMap((n) => { const el = this.stage.design.querySelector<HTMLElement>(`[data-name="${n}"]`); return el ? [el] : []; });
    this.slideEls.set(k, els);
    return els;
  }

  /**
   * Windows follow their slide (slide.ts): hidden = not drawn (the OnSliding overrides SetEnable the root with state != 1;
   * ssServerListWin is only pushed off the view). The group of the page on screen keeps the page logic's display; a group
   * the page left but still on screen (waiting for its exit, sliding out) keeps showing what it showed last. The offset is
   * added to the .gui place, in design px = the exe's view px given to setPositionX / Y [INFERIDO: i3Gui positions taken
   * as design units, same at 1024x768].
   */
  private applySlides(): void {
    const fx = this.slideFx, target = this.slideTarget(), here = target.step ?? target.phase;
    fx.want(target);
    for (const [k, g] of Object.entries(CROSS_SLIDE_WINDOWS) as [CrossPhase | CrossStep, (typeof CROSS_SLIDE_WINDOWS)["lobby"]][]) {
      const s = fx.slides[k], els = this.slideWindows(k);
      if (s.state === 1) { for (const el of els) if (el.style.display !== "none") { el.style.display = "none"; this.slideHidden.add(el); } continue; }
      // the slide left state 1 between two paints (the next phase starts its entrance): give back what only the slide hid
      for (const el of els) if (this.slideHidden.delete(el)) el.style.display = "";
      if (k !== here) { for (const el of this.slideShown.get(k) ?? []) el.style.display = ""; }
      else this.slideShown.set(k, els.filter((el) => el.style.display !== "none"));
      const d = g.axis === "x" ? s.x : s.y, tr = d ? `translate${g.axis.toUpperCase()}(${d}px)` : "";
      for (const el of els) if (el.style.transform !== tr) el.style.transform = tr;
    }
    if (this.slideLoop) return;
    this.slideLoop = true;
    // a phase takes no notify while disabled (from its exit start to its entrance end), a hidden root none either
    const block = (e: Event) => {
      for (const k of Object.keys(CROSS_SLIDE_WINDOWS) as (CrossPhase | CrossStep)[]) {
        if (!fx.input(k) && this.slideWindows(k).some((el) => el.contains(e.target as Node))) { e.stopPropagation(); e.preventDefault(); return; }
      }
    };
    for (const ev of ["pointerdown", "pointerup", "click", "dblclick", "wheel"]) this.stage.el.addEventListener(ev, block, { capture: true });
    let last = performance.now();
    const step = (now: number) => {
      fx.frame((now - last) / 1000, this.stage.el.clientWidth || 1024, this.stage.el.clientHeight || 768);
      last = now;
      this.applySlides();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** CPopupBase::OnOpenPopup 0x870ae0: PlaySound(2) UI_PopUp_Open when it was disabled; OnClosePopup 0x870b30: PlaySound(3)
   * UI_PopUp_Close when it was enabled. No slide or fade: SetEnable(1 / 0) at once. CMessageBox (0x753000..) plays nothing. */
  private popupSounds(): void {
    for (const n of ["lbJoinWin", "RandomMapWin", "shopBuyPopup", "UserInfoPopup"]) {
      const el = this.stage.design.querySelector<HTMLElement>(`[data-name="${n}"]`), on = !!el && el.style.display !== "none";
      if (on === this.popupsOpen.has(n)) continue;
      if (on) this.popupsOpen.add(n); else this.popupsOpen.delete(n);
      playUiSound(on ? UI_POPUP_OPEN : UI_POPUP_CLOSE);
    }
  }

  /** mbExp / mbExpText / mbExpGage (expBar, 0x81cdc0); null = no player yet (all blank) */
  private paintExp(exp: number | null, rank: number): void {
    const gui = this.gui!, e = exp === null ? null : expBar(exp, rank);
    gui.setText("mbExp", !e ? "" : rank >= 51 ? `${this.str("STR_TBL_GUI_ETC_CUMULATIVE_EXP", "Total EXP:")}${exp}` : e.text);
    gui.setText("mbExpText", e?.note ? this.str(...e.note) : "");
    gui.show("mbExpBar", !!e && !e.note);
    const pieces = Array.from(gui.get("mbExpGage")?.el.children ?? []).filter((c) => !c.classList.contains("op-text")) as HTMLElement[];
    pieces.forEach((p, i) => (p.style.display = e && i < e.shapes ? "" : "none"));
  }

  /** mbAnnounce flow (ANNOUNCE_SPEED): the EditBox slides left from the view's right edge until its text is out, then again */
  private startAnnounce(): void {
    const b = this.gui?.get("mbAnnounce");
    if (!b) return;
    let x = this.stage.design.offsetWidth || 1024, text = "", last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000), t = b.el.querySelector<HTMLElement>(":scope > .op-text");
      last = now;
      const view = this.stage.design.offsetWidth || 1024;
      if ((t?.textContent ?? "") !== text) { text = t?.textContent ?? ""; x = view; }
      // text width in design px: the range of the text node over the box's on-screen scale
      const r = document.createRange();
      if (t) r.selectNodeContents(t);
      const k = b.el.getBoundingClientRect().width / b.node.w || 1, w = t ? r.getBoundingClientRect().width / k : 0;
      x -= dt * ANNOUNCE_SPEED;
      if (x < -w) x = view;
      b.el.style.left = `${x}px`;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private paintServers(): void {
    const gui = this.gui!, c = this.ctl;
    // channel list only: the servers are the cards of ssServerListWin (paintServerCards)
    // only the first channel of each server is listed (user choice 2026-10-12): the protocol still carries the 11 channels a
    // server needs (2400 / 2333), the others are just not drawn
    const rows = (c.channels?.channelPlayers ?? []).slice(0, VISIBLE_CHANNELS).map((n, i) => ({ num: i + 1, name: this.str("STR_TBL_GUI_READYROOM_NORMAL_SERVER1", "%03d-Servidor comum").replace("%03d", pad3(i + 1)), players: n, max: c.channels!.maxPerChannel, online: true }));
    gui.setText("ssServerCaption", c.chrome().serverLabel || (this.textOf("ssServerCaption") ?? ""));
    for (let i = 0; i < SERVER_ROWS; i++) {
      const r = rows[i], k = i + 1;
      gui.setText(`ssSlotNumber${k}`, r ? String(r.num) : "");
      gui.setText(`ssSlotServer${k}`, r?.name ?? "");
      gui.show(`ssSlotUserGage${k}`, !!r?.online);
      if (r?.online) gui.setState(`ssSlotUserGage${k}`, gaugeState(r.players, r.max, GAUGE_LEVELS.channel));
    }
    this.place("ssSelect", c.chSelected < rows.length ? c.chSelected * SERVER_ROW_H : null);
    this.place("ssFocus", this.serverHover >= 0 && this.serverHover < rows.length ? this.serverHover * SERVER_ROW_H : null);
  }

  /** moves a highlight bar to `top` (design px inside its parent), hidden on null */
  private place(name: string, top: number | null): void {
    const b = this.gui?.get(name);
    if (!b) return;
    b.el.style.display = top === null ? "none" : "";
    if (top !== null) b.el.style.top = `${top}px`;
  }

  private paintLobby(): void {
    const gui = this.gui!, c = this.ctl, rooms = this.rooms();
    this.roomTop = Math.max(0, Math.min(this.roomTop, rooms.length - ROOM_ROWS));
    gui.setText("lbRoomServerInfo", c.chrome().serverLabel);
    for (let i = 0; i < ROOM_ROWS; i++) {
      const r = rooms[this.roomTop + i], k = i + 1, waiting = r?.state === 1;
      gui.setText(`lbSlotIdx${k}`, r ? pad3(r.roomId + 1) : "");
      gui.setText(`lbSlotMode${k}`, r ? this.listMode(r.rule, r.stage, r.roomType) : "");
      gui.setText(`lbSlotMap${k}`, r ? stageName(r.mapId) : "");
      gui.setText(`lbSlotTitle${k}`, r?.name ?? ""); // exe: SetTextEllipsis (row member +0x118, 0x835d5f), see i3Gui owner
      gui.setText(`lbSlotState${k}`, r ? this.str(waiting ? "STBL_IDX_ROOM_STATE_WAIT" : "STBL_IDX_ROOM_STATE_PLAY", waiting ? "Em espera" : "Jogando").replace(/\s*\n\s*/g, " ") : "");
      gui.setColor(`lbSlotState${k}`, waiting ? "#c9ced6" : "#ffd24a");
      gui.setText(`lbSlotPerson${k}`, r ? `${r.players}/${r.slots}` : "");
      gui.show(`lbKey${k}`, !!r && (r.flag & STAGE_PASSWORD) !== 0);
      gui.show(`lbPing${k}`, !!r);
      if (r) gui.setState(`lbPing${k}`, Math.max(0, Math.min(4, r.ping - 1)));
    }
    const sel = c.roomSel - this.roomTop;
    this.place("lbSelect", c.roomSel >= 0 && sel >= 0 && sel < ROOM_ROWS && rooms[c.roomSel] ? sel * ROOM_ROW_H : null);
    this.place("lbFocus", this.roomHover >= 0 && this.roomHover < ROOM_ROWS && rooms[this.roomTop + this.roomHover] ? this.roomHover * ROOM_ROW_H : null);
    // info of the picked room: CPhaseLobby 0x836850 (0x834450 clears every value and hides the window with none picked).
    // Map / mode / state / weapons come from the room list (2588), the rest from GET_ROOMINFOADD (REQ 0xc0f `D room` sent at
    // 0x5927bd, ACK 0xc10 read whole into context+0x47550 at 0x999078 -> event 0x206); here 2567 / 2568 of the 2017 server.
    const r = rooms[c.roomSel];
    // 0x8369c6 SetMapShape(lbImageDummy, stage) + mode tag (special byte 6 = AI training)
    this.mapImage("lbImageDummy", r ? r.mapId : null, modeTag(!!r && [2, 4, 6].includes(r.stage), r?.roomType ?? 4));
    // mode of the room for the clock / round / win lines: roomType / 4 (crossMap.ts infoMode, 0x6e0730)
    this.requestRoomAdd(r?.roomId ?? -1);
    const a = r && this.roomAdd?.roomId === r.roomId ? this.roomAdd : null;
    const yesNo = (on: boolean) => on ? this.str("STR_TBL_GUI_LOBBY_LIMIT_TEXT", "Ativado") : this.str("STR_TBL_GUI_LOBBY_NONE_TEXT", "Não");
    // 0x836f9b: row state byte +0x1f == 0 (READY, wire state 1) -> WAIT_STATE. Else 0x836fd3: clock "%02d:%02d" (add block +0x23,
    // 0x836ff9) in, else CURRENT_ROUND_COUNT (round byte +0x22, 0x83703f)
    const mode = infoMode(r?.roomType ?? 0), rounds = ROUND_WIN_MODES.includes(mode);
    const state = !r ? "" : r.state === 1 ? this.str("STR_TBL_GUI_LOBBY_WAIT_STATE_TEXT", "Aguarde...")
      : !a ? "" : CLOCK_MODES.includes(mode) ? `${String(Math.floor(a.battleTime / 60)).padStart(2, "0")}:${String(a.battleTime % 60).padStart(2, "0")}`
      : this.str("STR_TBL_GUI_LOBBY_CURRENT_ROUND_COUNT", "%d Rodada").replace("%d", String(a.round));
    // 0x8371b5: watch bits 1|2|4|8 all on -> OBSERVER1 (all), any of 1..0x10 -> OBSERVER2, none -> OBSERVER3
    const w = a?.watchRuleFlag ?? 0;
    const observer = (w & 0xf) === 0xf ? this.str("STR_TBL_GUI_LOBBY_ROOMINFO_OBSERVER1", "Utilizar todos")
      : w & 0x1f ? this.str("STR_TBL_GUI_LOBBY_ROOMINFO_OBSERVER2", "Utilizar") : this.str("STR_TBL_GUI_LOBBY_ROOMINFO_OBSERVER3", "Não utilizar");
    // 0x8372f1: balance 1 -> PERSON, 2 -> SKILLED, else NONE
    const balance = a?.balanceType === 1 ? this.str("STR_TBL_GUI_READY_TEAM_BALANCE_PERSON", "Qtde")
      : a?.balanceType === 2 ? this.str("STR_TBL_GUI_READY_TEAM_BALANCE_SKILLED", "Rank") : this.str("STR_TBL_GUI_LOBBY_NONE_TEXT", "Não");
    const info: [string, string][] = [
      ["lbMapValue", r ? stageName(r.mapId) : ""],
      ["lbModeValue", r ? modeLabel(r.rule, r.stage) : ""],
      ["lbStateValue", state],
      // 0x8370fe: byte +0x23 of the room's LIST row (0x599f50 entry, not the add block) == 0x0f -> NONE, else LIMIT. 0x0f = the four
      // slot bits of weaponsFlag (grenade 1 / melee 2 / secondary 4 / primary 8), so the test is its low nibble. The row byte is
      // fed by weaponsFlag (H, wire offset 58 of the 246-byte RoomInfo block) [INFERIDO: the exe's row builder not decoded]
      ["lbWeaponLimitValue", r ? yesNo((r.weaponsFlag & 0xf) !== 0xf) : ""],
      // 0x836df2: win condition (kills / rounds of the low killTime nibble) + " /" + time of the high nibble
      ["lbTypeValue", a ? conditionText(a.killTime, rounds) : ""],
      ["lbJoinLimitValue", a ? yesNo(a.limit !== 0) : ""], // 0x837090: +0x25 limit
      ["lbObserverLimitValue", a ? observer : ""],
      ["lbTeamBalanceValue", a ? balance : ""],
    ];
    for (const [n, v] of info) gui.setText(n, v);
    gui.setText("lbHostValue", a?.leaderName ?? ""); // exe: SetTextEllipsis(host nick) at 0x836f92
    // lobby players: nick + rank icon (_SetUserInfoListSlot 0x834c00: SetRankImage(lbUserListSlotRank, rank byte +0x19))
    // and the nick in its colour (0x834eb1: 0x4ad850(lbUserListSlotNick, nick +0x1b, nick colour +0x3c) = SetText + SetTextColor(table 0xb210a4))
    const users = c.session?.lobby.playerList() ?? [];
    this.userTop = Math.max(0, Math.min(this.userTop, users.length - USER_ROWS));
    for (let i = 0; i < USER_ROWS; i++) {
      const u = users[this.userTop + i];
      gui.setText(`lbUserListSlotNick${i + 1}`, u?.nickname ?? "");
      gui.setColor(`lbUserListSlotNick${i + 1}`, `rgb(${(NICK_COLORS[u?.nickColor ?? 0] ?? NICK_COLORS[0]).join(",")})`);
      this.rankIcon(`lbUserListSlotRank${i + 1}`, u ? u.rank : null);
      paintMark(gui, `lbUserListClanMark${i + 1}`, u ? u.clanLogo : null);
    }
    // Buscar hit (community.ts findFriend, exe 0x885b70): the picked row's band (lbUserListSlotSelect) over its slot, if on screen
    const pick = users.findIndex((u) => u.nickname === c.lobbyPick), row = pick - this.userTop;
    const band = gui.get("lbUserListSlotSelect");
    if (band) band.el.style.top = `${band.node.y + row * USER_ROW_H}px`;
    gui.show("lbUserListSlotSelect", row >= 0 && row < USER_ROWS);
  }

  /** Modo column text of the room list (LIST_MODE); a mode the table lacks keeps the web label */
  private listMode(rule: number, stage: number, roomType: number): string {
    const m = ROOM_MODES.find((x) => x.rule === rule && x.stage === stage && x.roomType === roomType) ?? ROOM_MODES.find((x) => x.rule === rule && x.stage === stage);
    const k = m && LIST_MODE[m.text];
    return k ? this.str(...k) : modeLabel(rule, stage);
  }

  /** One GET_ROOMINFOADD at a time: the ACK carries no room id, so a newer pick waits for the answer in flight. */
  private requestRoomAdd(roomId: number): void {
    const g = this.ctl.game;
    if (roomId < 0) this.roomAddFor = -1;
    if (roomId < 0 || !g || this.roomAddPending || this.roomAddFor === roomId) return;
    this.roomAddFor = roomId;
    this.roomAddPending = true;
    void g.getRoomInfoAdd(roomId).then((a) => {
      this.roomAddPending = false;
      this.roomAdd = a;
      this.paint();
    });
  }

  /**
   * Map box `box` (lbImageDummy / rrImageDummy / rrCreateImageDummy): the map picture of SetMapShape 0x7a73a0 (see MAP_SHAPE;
   * no Stage.pef entry hides the box, 0x7a74b6) under the mode tag `${box}2` (shape `tag`, see modeTag).
   */
  private mapImage(box: string, mapId: number | "random" | null, tag: number): void {
    const gui = this.gui!, b = gui.get(box);
    if (!b) return;
    const e = typeof mapId === "number" ? mapIndexEntry(mapFromRoomMapId(mapId)) : undefined;
    const idx = mapId === "random" ? MAP_SHAPE.random : e && e.mapId === mapId ? STAGE_SHAPE[e.pack.toLowerCase()] ?? -1 : -1;
    gui.show(box, idx >= 0);
    if (idx < 0) return;
    const q = Math.floor(idx / MAP_SHAPE.perTex), rest = idx % MAP_SHAPE.perTex;
    const [tex, cell] = q > 0 && rest !== 0 ? [q + 1, rest - 1] : [1, idx];
    const u = (cell % MAP_SHAPE.cols) * (MAP_SHAPE.w + 1) + 1, v = Math.floor(cell / MAP_SHAPE.cols) * (MAP_SHAPE.h + 1) + 1;
    const key = `${tex}:${u}:${v}`, old = this.mapSprites.get(box);
    if (old?.key !== key) {
      old?.el.remove();
      const el = gui.sprite(b.el, [MAP_SHAPE.atlas(tex), 0, 0, u, v, MAP_SHAPE.w, MAP_SHAPE.h, MAP_SHAPE.w, MAP_SHAPE.h]);
      b.el.prepend(el); // under the tags (children of the box)
      this.mapSprites.set(box, { key, el });
    }
    gui.setState(`${box}2`, tag);
  }

  /** a Rank static (SetRankImage 0x801aa0): cell `rank` of interface_level_icon, hidden on null */
  private rankIcon(name: string, rank: number | null): void {
    const gui = this.gui!;
    gui.show(name, rank !== null);
    if (rank !== null) paintShapeIndex(gui, name, rank, LEVEL_ICON.cell, LEVEL_ICON.tex);
  }

  private paintChat(p: "lb" | "rr"): void {
    const gui = this.gui!, c = this.ctl, rows = c.chatRows(), n = this.chatLines(p);
    this.chatBack = Math.max(0, Math.min(this.chatBack, rows.length - n));
    const end = rows.length - this.chatBack;
    const shown = rows.slice(Math.max(0, end - n), end);
    this.lines(`${p}TextBox`, shown.map((r) => ({ text: r.text, color: `rgb(${r.color[0]},${r.color[1]},${r.color[2]})` })), false, true);
    const tabs: Record<string, string> = CHAT_TAB[p];
    for (let k = 1; k <= 4; k++) gui.setState(`${p}ChatTab${k}`, tabs[k] && c.chatTab === tabs[k] ? 1 : 0);
  }

  private paintCreate(): void {
    const gui = this.gui!, cr = this.ctl.create;
    if (!cr) this.mapPopup = false;
    gui.show("rrCreateMapPopup", this.mapPopup);
    if (!cr) { this.wasCreate = false; gui.hide("RandomMapWin"); return; }
    if (this.mapPopup) {
      const n = cr.maps.length, v = this.mapRows.length, max = Math.max(0, n - v);
      this.mapTop = Math.max(0, Math.min(this.mapTop, max));
      this.fillRows(this.mapRows, cr.maps.map((m) => m.name), this.mapTop, cr.maps.findIndex((m) => m.mapId === cr.map?.mapId));
      const pieces = Array.from(gui.get("rrCreateMapPopup")!.el.children) as HTMLElement[], thumb = pieces[12];
      if (thumb) {
        thumb.style.display = max > 0 ? "" : "none";
        thumb.style.top = `${MAP_POPUP_THUMB.y0 + (MAP_POPUP_THUMB.y1 - MAP_POPUP_THUMB.y0) * (max ? this.mapTop / max : 0)}px`;
      }
    }
    if (!this.wasCreate) {
      this.wasCreate = true;
      if (this.inputs.title) this.inputs.title.value = cr.name;
      if (this.inputs.pwd) this.inputs.pwd.value = cr.password;
      this.inputs.title?.focus();
    }
    const md = ROOM_MODES[cr.mode], kt = cr.killTime, w = cr.weapons;
    if (this.inputs.pwd) this.inputs.pwd.disabled = !cr.passwordOn;
    gui.paintCheck("lbPasswordCheck", cr.passwordOn);
    gui.setText("rrCreateModeValue", modeText(md));
    gui.setText("rrCreateTypeValue", md.rounds ? roundsText(kt) : killsText(kt));
    gui.setText("rrCreateTimeValue", timeText(kt));
    gui.setText("rrCreateMap", cr.map?.name ?? "");
    // while the random map is on the map combo is hidden (0x8387c6)
    gui.paintCheck("rrCheckRandomMap", cr.randomMap);
    gui.show("rrCreateMapCombo", !cr.randomMap);
    // RandomMapWin (OnOpenPopup 0x8b11d0): MapCheck i + MapName i (stage name) for the mode's maps, the rest hidden
    const rm = cr.rm;
    gui.show("RandomMapWin", !!rm);
    gui.show("CheckCountWin", !!rm?.warn);
    for (let i = 0; i < RANDOM_MAP_ROWS; i++) {
      const m = rm ? cr.maps[i] : undefined;
      gui.show(`MapCheck${i}`, !!m);
      if (!m) continue;
      gui.setText(`MapName${i}`, m.name);
      gui.paintCheck(`MapCheck${i}`, rm!.picked.includes(m.mapId));
    }
    // 0x838740: rrCheckRandomMap on -> random cell (0x5230e0), else SetMapShape(rrCreateImageDummy, stage) at 0x838826
    this.mapImage("rrCreateImageDummy", cr.randomMap ? "random" : cr.map?.mapId ?? null, modeTag(!!md.ai, md.roomType));
    const checks: [string, boolean][] = [
      ["rrCreateLimitPrimary", w.primary], ["rrCreateLimitSecondary", w.secondary], ["rrCreateLimitMelee", true], ["rrCreateLimitThrow", w.throw], ["rrCreateLimitRPG7", w.rpg7],
      ["rrObserver1PV_Only", (cr.watch & WATCH.FIRST_ONLY) !== 0], ["rrObserver3PV_Free", (cr.watch & WATCH.THIRD) !== 0], ["rrObserver1PV_Free", (cr.watch & WATCH.ON) !== 0],
      ["rrObserverEnemy_Free", (cr.watch & WATCH.ENEMY) !== 0], ["rrObserverEnemyHP_Free", (cr.watch & WATCH.ENEMY_HP) !== 0],
      ["rrCreateLimitJoinYes", cr.limitEnter], ["rrCreateLimitJoinNo", !cr.limitEnter],
      ["rrCreateTeamBalanceNo", cr.balance === 0], ["rrCreateTeamBalanceYes", cr.balance === 2], ["rrCreateTeamBalanceYes2", cr.balance === 1],
    ];
    for (const [n, on] of checks) gui.paintCheck(n, on);
    for (const n of ["Primary", "Secondary", "Melee", "Throw", "RPG7"]) gui.show(`rrCreateLimit${n}_Lock`, !!md.special || n === "Melee");
  }

  /** rrAdvencedWin checkboxes from the owner's copy; the weapon boxes and their locks (rrLimit*Lock) follow the mode */
  private paintAdv(): void {
    const gui = this.gui!, a = this.adv!, info = this.ctl.roomScreen?.room?.room, w = a.weapons;
    const locked = !info || !!ROOM_MODES[modeIndex(info.stage, info.roomType, info.rule)]?.special;
    const checks: [string, boolean][] = [
      ["rrLimitPrimary", w.primary], ["rrLimitSecondary", w.secondary], ["rrLimitMelee", true], ["rrLimitThrow", w.throw], ["rrLimitRPG7", w.rpg7],
      ["rrLimitJoinYes", a.limit], ["rrLimitJoinNo", !a.limit],
      ["rrTeamBalanceNo", a.balance === 0], ["rrTeamBalanceYes2", a.balance === 1], ["rrTeamBalanceYes", a.balance === 2],
      ["rrReadyObserver1PV_Only", (a.watch & WATCH.FIRST_ONLY) !== 0], ["rrReadyObserver3PV_Free", (a.watch & WATCH.THIRD) !== 0],
      ["rrReadyObserver1PV_Free", (a.watch & WATCH.ON) !== 0], ["rrReadyObserverEnemy_Free", (a.watch & WATCH.ENEMY) !== 0],
      ["rrReadyObserverEnemyHP_Free", (a.watch & WATCH.ENEMY_HP) !== 0],
    ];
    for (const [n, on] of checks) gui.paintCheck(n, on);
    for (const n of ["Primary", "Secondary", "Melee", "Throw", "RPG7"]) gui.show(`rrLimit${n}Lock`, locked || n === "Melee");
  }

  /** rrInviteWin rows: the lobby users [RECRIADO: first 8 of the lobby list; the exe takes 8 of the channel's waiting players at random, C# PROTOCOL_ROOM_INVITE_LOBBY_USER_LIST_ACK] */
  private paintInv(): void {
    const gui = this.gui!, inv = this.inv!;
    for (let i = 0; i < INVITE_ROWS; i++) {
      const u = inv.rows[i], n = i + 1;
      gui.show(`rrInviteCheck${n}`, !!u);
      gui.paintCheck(`rrInviteCheck${n}`, !!inv.picks[i]);
      gui.show(`rrInviteNickname${n}`, !!u);
      gui.setText(`rrInviteNickname${n}`, u?.nickname ?? "");
      this.rankIcon(`rrInviteRank${n}`, u ? u.rank : null);
      gui.show(`rrInviteRank_Beginner${n}`, false);
    }
  }

  /** rrCardComplateWin / rrFinalComplateWin / rrFinalComplateExWin of the room; the reward icons and badges are not drawn yet */
  private paintRoomDone(page: Page): void {
    const gui = this.gui!, s = page === "room" ? this.roomDone : null;
    gui.show("rrCardComplateWin", !!s && s.step === "card");
    gui.show("rrFinalComplateWin", !!s && s.step === "final");
    gui.show("rrFinalComplateExWin", !!s && s.step === "ex");
    // rrFinalComplatePrizeWin has no path here yet (its Confirmar opens the reward popup, not decoded): kept hidden, it was on top of every page
    gui.show("rrFinalComplatePrizeWin", false);
    if (!s) return;
    gui.setText("rrCardComplateExp", s.done.exp);
    gui.setText("rrCardComplatePoint", s.done.point);
    // the reward item of the set (the first of the set's items, as prCardComplateDummy does): the Final / Ex prize frames
    const item = s.done.items[0] ?? 0;
    setIcon(gui, "rrFinalComplateDummy", item);
    setIcon(gui, "rrFinalComplateExWeaponDummy", item);
  }

  private paintRoom(): void {
    const gui = this.gui!, c = this.ctl, rs = c.roomScreen, r = rs?.room, info = r?.room;
    if (!r) return;
    gui.setText("rrRoomCaption", info ? `${pad3(info.roomId + 1)}  ${info.name}` : "");
    gui.show("rrKey", ((info?.opts?.flag ?? 0) & STAGE_PASSWORD) !== 0);
    // GM observer: chkObserver (id 1247, notify 0x7c43dc) + editObserver STR_TBL_GUI_OBSERVER (0x7d2d15); the web shows it to a GM who
    // is not the leader, as the 2017 CkGMObserver, and READY then goes out with mode 2 (controller) [INFERIDO: the exe's show rule]
    const gmBox = c.gmObserverBox, obs = gui.get("chkObserver");
    if (obs && !obs.el.dataset.wired) { obs.el.dataset.wired = "1"; obs.el.style.cursor = "pointer"; obs.el.addEventListener("click", (e) => { e.stopPropagation(); this.ctl.click("hit", "gmobs"); }); }
    gui.show("chkObserver", gmBox.can);
    gui.show("editObserver", gmBox.can);
    if (gmBox.can) gui.paintCheck("chkObserver", gmBox.on);
    // 0x7cd74a SetMapShape(rrImageDummy, stage) + mode tag (0x4c29b0 AI training room -> 4)
    // (0x7cd757: CheckRandomMap on -> the random cell, as the create window)
    const randomOn = ((info?.opts?.flag ?? 0) & STAGE_RANDOM_MAP) !== 0 && !r.isBotRoom;
    this.mapImage("rrImageDummy", randomOn ? "random" : info?.mapId ?? null, modeTag(r.isBotRoom, info?.roomType ?? 4));
    const slotCount = info?.slotCount ?? 16, myRank = c.chrome().rank;
    // the picked slot (ev0 0x7ca810 moves rrRedSelect / rrBlueSelect and hides the other team's): the inspected player, else mine
    const picked = c.inspect?.slot ?? r.mySlot;
    for (const [t, team] of [[0, "Red"], [1, "Blue"]] as const) {
      for (let i = 0; i < TEAM_ROWS; i++) {
        const slot = t + i * 2, x = r.slots[slot], k = i + 1, open = slot < slotCount && x?.state !== 1; // 1 = closed by the leader (3604)
        const used = !!x && (x.state >= WIRE_SLOT.SHOP || !!x.nick);
        gui.show(`rr${team}Open${k}`, open);
        gui.show(`rr${team}Close${k}`, !open);
        gui.setText(`rr${team}Nickname${k}`, used ? x!.nick || `slot ${slot + 1}` : "");
        // 0x7cf1d7: SetTextColor(nick colour table 0xb210a4[nick colour]) = the 2017 table (battleChatModel NICK_COLORS)
        gui.setColor(`rr${team}Nickname${k}`, `rgb(${(NICK_COLORS[x?.nickColor ?? 0] ?? NICK_COLORS[0]).join(",")})`);
        // 1600205 name-card outline [INFERIDO: drawn on the room list nick; the exe's outline draw (sub_9BFA00) is not traced]
        const border = x?.nickBorderColor ?? 0;
        gui.setOutline(`rr${team}Nickname${k}`, border > 0 && NICK_COLORS[border] ? `rgb(${NICK_COLORS[border].join(",")})` : null);
        const badge = used ? slotState(x!.state) : -1;
        gui.show(`rr${team}State${k}`, badge >= 0);
        if (badge >= 0) gui.setState(`rr${team}State${k}`, badge);
        // SetRankImage of %sRank%d (the controller's own slot reads the profile rank, as the 2017 room list)
        this.rankIcon(`rr${team}Rank${k}`, used ? (slot === r.mySlot && myRank ? myRank : x!.rank) : null);
        // emblem of the slot's clan (_SetClanInfoInSlot); 0xFFFFFFFF / no clan hides it
        paintMark(gui, `rr${team}ClanMark${k}`, used ? this.slotClan(slot).logo : null);
        // PC-cafe icon by the record's cafe byte (switch 0x7d05a0)
        const pc = used ? PC_CAFE_SHAPE[x!.cafe ?? 0] : undefined;
        gui.show(`rr${team}Pc${k}`, pc !== undefined);
        if (pc !== undefined) gui.setState(`rr${team}Pc${k}`, pc);
      }
      const sel = picked % 2 === t ? Math.floor(picked / 2) : -1;
      this.place(`rr${team}Select`, sel >= 0 && sel < TEAM_ROWS ? TEAM_ROW_Y + sel * TEAM_ROW_H : null);
      const h = this.teamHover.team === t ? this.teamHover.row : -1;
      this.place(`rr${team}Focus`, h >= 0 ? TEAM_ROW_Y + h * TEAM_ROW_H : null);
    }
    this.paintRecord();
    const ready = r.slots[r.mySlot]?.state === WIRE_READY, counting = !!rs?.countdown.running;
    gui.show("rrStart", r.isLeader && !counting);
    gui.show("rrCancelStart", r.isLeader && counting);
    gui.show("rrReady", !r.isLeader && !ready);
    gui.show("rrCancelReady", !r.isLeader && ready);
    const rounds = info?.roomType === 8, kt = info?.killTime ?? 0x63;
    if (this.inputs.roomTitle) {
      const inp = this.inputs.roomTitle;
      inp.disabled = !r.isLeader || r.isBotRoom; // 0x7cdefb: input off for a non-leader; training room: title disabled
      if (document.activeElement !== inp && inp.dataset.room !== (info?.name ?? "")) { inp.value = info?.name ?? ""; inp.dataset.room = info?.name ?? ""; }
    }
    if (this.inputs.roomPwd) {
      const inp = this.inputs.roomPwd, shown = ((info?.opts?.flag ?? 0) & STAGE_PASSWORD) !== 0 ? "****" : "";
      inp.disabled = !r.isLeader; // 0x7cdf24 / 0x7ce55e setInputDisable(rrPasswordValue)
      if (document.activeElement !== inp && inp.dataset.room !== shown) { inp.value = shown; inp.dataset.room = shown; }
    }
    gui.setText("rrModeValue", info ? modeLabel(info.rule, info.stage) : "");
    gui.setText("rrTypeValue", rounds ? roundsText(kt) : killsText(kt));
    gui.setText("rrTimeValue", timeText(kt));
    gui.setText("rrMap", info ? stageName(info.mapId) : "");
    gui.paintCheck("CheckRandomMap", randomOn);
    if (!r.isLeader || (info?.state ?? 1) > 1) this.roomMapPopup = false;
    gui.show("rrMapPopup", this.roomMapPopup);
    if (this.roomMapPopup && info) {
      const maps = modeStageChoices(ROOM_MODES[modeIndex(info.stage, info.roomType, info.rule)]), max = Math.max(0, maps.length - this.roomMapRows.length);
      this.roomMapTop = Math.max(0, Math.min(this.roomMapTop, max));
      this.fillRows(this.roomMapRows, maps.map((m) => m.name), this.roomMapTop, maps.findIndex((m) => m.mapId === info.mapId));
      const thumb = (Array.from(gui.get("rrMapPopup")!.el.children) as HTMLElement[])[12];
      if (thumb) {
        thumb.style.display = max > 0 ? "" : "none";
        thumb.style.top = `${ROOM_MAP_POPUP_THUMB.y0 + (ROOM_MAP_POPUP_THUMB.y1 - ROOM_MAP_POPUP_THUMB.y0) * (max ? this.roomMapTop / max : 0)}px`;
      }
    }
    // CPhaseReadyRoom::OnEntranceStart 0x7c7dc0 (training room = byte +0x25 6/8/9, 0x7c7fd2): a training room hides the Mode /
    // Objetivo / Limite de tempo / Opções rows (key + value, their arrows and rrOption are children) and rrInvite / rrSearchHost
    // (0x7c8022, 0x7c8590..0x7c86e2) and moves rrChange to rrSearchHost's x (0x7c88b4); the training rows shown depend on the
    // last option byte +0x28 (0: enemies + difficulty + time, 1: time, 2: none and rrChange hidden) [INFERIDO: 0 for the 2017
    // server's AI room]; a normal room hides every rrTraining* control
    const ai = r.isBotRoom ? r.ai : null;
    gui.show("rrInfoTraining", !!ai);
    // clan match (6930 pairing, clanPairing): the clan band rrClanBattleInfo (CPhaseReadyRoom 0x7d5360, this+0x790) takes the place of
    // the Modo / Objetivo / Tempo / Opções rows: siblings under rrInfo at the same spots in UI_Project_ReadyRoom.json
    const clan = this.clanPairing && !ai;
    gui.show("rrClanBattleInfo", clan);
    for (const n of ["rrModeKey", "rrModeValue", "rrTypeKey", "rrTypeValue", "rrTimeKey", "rrTimeValue", "rrOptionKey"]) gui.show(n, !ai && !clan);
    if (clan) {
      // the two clans: first seat of each team (even slots red, odd blue) with a clan; its emblem and name
      for (const [t, team] of [[0, "Red"], [1, "Blue"]] as const) {
        let c: { clan: string; logo: number | undefined } = { clan: "", logo: undefined };
        for (let s = t; s < slotCount && !c.clan; s += 2) c = this.slotClan(s);
        gui.setText(`rr${team}ClanNameValue`, c.clan);
        paintMark(gui, `rr${team}ClanMarkImage`, c.clan ? c.logo : null);
        gui.setText(`rr${team}TeamNameValue`, ""); // the team's FriendId name is not in the room [INFERIDO]
      }
      gui.setText("rrClanBattleModeValue", info ? modeLabel(info.rule, info.stage) : "");
      gui.setText("rrClanBattleTypeValue", rounds ? roundsText(kt) : killsText(kt));
      gui.setText("rrClanBattleTimeValue", timeText(kt));
    }
    const change = gui.get("rrChange"), host = gui.get("rrSearchHost");
    if (change && host) change.el.style.left = `${ai ? host.node.x : change.node.x}px`;
    if (!ai) this.diffPopup = false;
    gui.show("rrTrainingDifficultyPopup", this.diffPopup);
    if (ai) {
      gui.setText("rrTrainingTimeValue", timeText(kt));
      gui.setText("rrTrainingEnemyValue", String(ai.count));
      const grades = AI_GRADE_KEYS.map((k, i) => this.str(k, `${i + 1}`));
      gui.setText("rrTrainingDifficultyValue", grades[ai.level - 1] ?? "");
      if (this.diffPopup) this.fillRows(this.diffRows, grades, 0, ai.level - 1);
    }
  }

  /**
   * rrRecordWin "< Informações detalhadas >" (CPhaseReadyRoom 0x7ccdb0, every frame): the picked player (ROOM_GET_PLAYERINFO
   * 3597, the controller's inspect), else me (2369 record + my slot). Nick in the nick-colour table, rank icon, then per
   * record (season = the server's season block, total = its basic block):
   *   Record "%d%s %d%s %d%s" (0xbe6e00, sprintf 0x7cd185: no space between a number and its word, String_Brazil has
   *   none either, so "20Rodadas 6Vitórias 11Derrotas" is the exe's) = matches BATTLE_COUNT, wins WIN_COUNT, loses LOSE_COUNT; KillDeath = KILL_DEATH_RATE_MODE1 with
   *   kills / (kills + deaths) * 100 + 0.5 (0x7d9900); KillDeath2 "%d / %d" kills / deaths; Headshot = HEADSHOT_RATE_MODE1 with
   *   headshots * 100 / totalKills + 0.5 (Season/TotalHeadShotPercent 0xa3ec40 / 0xa3ebb0); Disconnect = BATTLE_LEAVE_RATE
   *   with the escapes. Clan: name or NO_JOINING. The rank icon stays at its layout place (the exe recentres rank + nick by
   *   the text width at 0x7ccea6, not ported) and the clan grade text of a clan member is not decoded [INFERIDO: empty].
   */
  /** clan name + emblem of a room slot. The creator's own slot has none until a slot list (3595) arrives: CREATE_ACK carries no
   * slot records and the server sends 3595 after a create only in AI rooms. The own slot then takes the profile's clan, as the
   * client fills its own slot from its own info [INFERIDO]. */
  private slotClan(slot: number): { clan: string; logo: number | undefined } {
    const r = this.ctl.roomScreen?.room, x = r?.slots[slot];
    if (x?.clan || !r || slot !== r.mySlot) return { clan: x?.clan ?? "", logo: x?.clanLogo };
    const p = this.ctl.session?.player.state.profile;
    return p && p.clanId ? { clan: p.clanName, logo: p.clanLogo } : { clan: "", logo: x?.clanLogo };
  }

  private paintRecord(): void {
    const gui = this.gui!, c = this.ctl, r = c.roomScreen?.room;
    if (!r) return;
    const win = gui.get("rrRecordWin");
    if (win) win.el.style.top = `${this.recordShown ? RECORD_WIN.shownY : RECORD_WIN.foldedY}px`;
    gui.setText("rrRecordCaption", this.recordShown ? this.str("STR_TBL_GUI_READY_DETAIL_INFO1", "< Informações detalhadas >") : this.str("STR_TBL_GUI_READY_DETAIL_INFO2", "< Informações detalhadas >"));
    const ins = c.inspect, mine = r.slots[r.mySlot], chrome = c.chrome(), my = c.player?.state.record ?? null, myClan = this.slotClan(r.mySlot);
    const who = ins
      ? { nick: ins.nick, rank: ins.rank, color: r.slots[ins.slot]?.nickColor ?? 0, season: ins.season, total: ins.total, clan: ins.clan, logo: this.slotClan(ins.slot).logo }
      : { nick: chrome.nickname, rank: chrome.rank, color: mine?.nickColor ?? 0, season: my?.season, total: my?.total, clan: myClan.clan, logo: myClan.logo };
    gui.setText("rrRecordNickname", who.nick);
    gui.setColor("rrRecordNickname", `rgb(${(NICK_COLORS[who.color] ?? NICK_COLORS[0]).join(",")})`);
    this.rankIcon("rrRecordRank", who.nick ? who.rank : null);
    this.recentreRank();
    const pct = (a: number, b: number) => (b > 0 ? Math.trunc((a * 100) / b + 0.5) : 0);
    for (const [p, rec] of [["rrSeason", who.season], ["rrTotal", who.total]] as const) {
      gui.setText(`${p}Record`, rec ? `${rec.matches}${this.str("STBL_IDX_BATTLE_COUNT", "Rodadas")} ${rec.wins}${this.str("STBL_IDX_BATTLE_WIN_COUNT", "Vitórias")} ${rec.loses}${this.str("STBL_IDX_BATTLE_LOSE_COUNT", "Derrotas")}` : "");
      gui.setText(`${p}KillDeath`, rec ? this.str("STR_TBL_PROFILE_KILL_DEATH_RATE_MODE1", "KILL/DEATH: %d%%").replace("%d", String(pct(rec.kills, rec.kills + rec.deaths))).replace("%%", "%") : "");
      gui.setText(`${p}KillDeath2`, rec ? `${rec.kills} / ${rec.deaths}` : "");
      gui.setText(`${p}Headshot`, rec ? this.str("STR_TBL_PROFILE_HEADSHOT_RATE_MODE1", "HEADSHOT: %d%%").replace("%d", String(pct(rec.headshots, rec.totalKills))).replace("%%", "%") : "");
      gui.setText(`${p}Disconnect`, rec ? this.str("STR_TBL_GUI_READY_BATTLE_LEAVE_RATE", "Desistências: %d").replace("%d", String(rec.escapes)) : "");
    }
    const none = this.str("STR_TBL_GUI_READY_NO_JOINING", "Não cadastrado.");
    paintMark(gui, "rrClanMark", who.nick && who.clan ? who.logo : null);
    gui.setText("rrClanNameValue", who.clan || none);
    // 0x7cd4f2: a clan member's name goes through 0x4ad850(rrClanNameValue, clan name +0x48, clan name colour +0x5f); no clan:
    // NO_JOINING in rgb(80, 80, 80) (0x7cd598). Only my own clan colour is known: 3595 slots and 3597 carry none [INFERIDO: white]
    gui.setColor("rrClanNameValue", who.clan ? nickCss(ins ? 0 : c.player?.state.profile?.clanNameColor) : "rgb(80,80,80)");
    gui.setText("rrClanRankValue", who.clan ? "" : none);
    // 0x7cd511: a member's grade in GetColor(14) (0x7913c0 table 0xd894d8: white), no clan NO_JOINING in rgb(80, 80, 80) (0x7cd634)
    gui.setColor("rrClanRankValue", who.clan ? "rgb(255,255,255)" : "rgb(80,80,80)");
  }

  /**
   * 0x7cd068: the rank icon sits left of the centred nickname: x = nick.x + (nick.w - textW) / 2 - icon.w - 8 (8.0 at 0xb29260,
   * GUI scale 1); the nickname itself stays centred in its box.
   */
  private recentreRank(): void {
    const nick = this.gui!.get("rrRecordNickname"), icon = this.gui!.get("rrRecordRank"), t = nick?.el.querySelector<HTMLElement>(":scope > .op-text");
    if (!nick || !icon || !t) return;
    const k = nick.el.getBoundingClientRect().width / nick.node.w;
    if (!k) return;
    const r = document.createRange();
    r.selectNodeContents(t);
    const tw = r.getBoundingClientRect().width / k;
    icon.el.style.left = `${Math.round(nick.node.x + (nick.node.w - tw) / 2 - icon.node.w - 8)}px`;
  }

  private paintPopups(loading: string | null): void {
    const c = this.ctl;
    if (c.pwdPrompt && !this.wasPwd && this.inputs.join) { this.inputs.join.value = c.pwdPrompt.text; this.inputs.join.focus(); }
    this.wasPwd = !!c.pwdPrompt;
    const m = c.msg, text = m?.text ?? loading;
    this.messageBox(text ?? null, !m ? "none" : m.onCancel ? "okCancel" : "ok");
  }

  /**
   * CMessageBox (Create 0x753c90, layout 0x754d80): built in code from Gui/Main/UI_Source01 (main_ui_source01), not a .gui.
   * Inner size W = max(textW + 20, 200), H = max(textH + 10, 35) (0x755501..0x7555c3; textW = widest line, textH = line height x
   * lines, split at); window (W + 52) x (H + 138) centred in the view (0x5224b0). 9-slice: columns u 1 / 28 / 55 (26 px),
   * rows v 84 (58 px) / 143 (26) / 170 (80); centre W x H, top / bottom edges W wide (0x755676..0x7558a1). Separator (158,159)
   * 26 x 2 at (9, yb + 22) W + 34 wide, yb = 58 + H. Caption (0, 0, W + 52, 48) and message (18, 39, W + 16, H + 38): default
   * font 10 pt weight 400, colour table 0 #adadad, no wrap, align (1, 1) (0x75421e) [INFERIDO: the message's align comes from
   * the caller, centre here]. Buttons 60 x 23 from (245,172) / (245,197) / (245,222) / disabled (157,297) 63 x 26, y = yb + 33,
   * cx = 26 + W / 2: OK alone at cx - 30; OK + Cancel at cx - 65 / cx + 5; no buttons (flag 4) while loading. Labels
   * STBL_IDX_BUTTON_OK / CANCEL, caption STBL_IDX_COMMON_MSGBOX_CAPTION.
   */
  private messageBox(text: string | null, buttons: "none" | "ok" | "okCancel"): void {
    const gui = this.gui!, key = text === null ? "" : `${buttons}|${text}`;
    if (key === this.msgKey) return;
    this.msgKey = key;
    gui.get("cxMsgWin")?.el.remove();
    if (text === null) return;
    const f = guiFont(10, 400), lines = text.split("\n");
    const tw = Math.max(...lines.map((l) => [...l].reduce((a, ch) => a + f.w(ch), 0))), th = f.lineH * lines.length;
    const W = Math.max(tw + 20, 200), H = Math.max(th + 10, 35), yb = 58 + H, cx = 26 + Math.trunc(W / 2);
    const T = "main_ui_source01", im = (dx: number, dy: number, u: number, v: number, sw: number, sh: number, dw = sw, dh = sh): Img => [T, dx, dy, u, v, sw, sh, dw, dh];
    const txt = { align: [1, 1] as [number, number], color: "#adadad", wrap: 0 };
    const button = (name: string, x: number): GNode => ({
      name, cls: "Button", x, y: yb + 33, w: 60, h: 23,
      images: [im(0, 0, 245, 172, 63, 26, 60, 23), im(0, 0, 245, 197, 63, 26, 60, 23), im(0, 0, 245, 222, 63, 26, 60, 23), im(0, 0, 157, 297, 63, 26, 60, 23)],
    });
    const win: GNode = {
      name: "cxMsgWin", cls: "Static", x: 0, y: 0, w: W + 52, h: H + 138,
      images: [
        im(0, 0, 1, 84, 26, 58), im(26, 0, 28, 84, 26, 58, W, 58), im(26 + W, 0, 55, 84, 26, 58),
        im(0, 58, 1, 143, 26, 26, 26, H), im(26, 58, 28, 143, 26, 26, W, H), im(26 + W, 58, 55, 143, 26, 26, 26, H),
        im(0, yb, 1, 170, 26, 80), im(26, yb, 28, 170, 26, 80, W, 80), im(26 + W, yb, 55, 170, 26, 80),
      ],
      children: [
        { name: "cxMsgSeparate", cls: "Static", x: 9, y: yb + 22, w: W + 34, h: 2, images: [im(0, 0, 158, 159, 26, 2, W + 34, 2)] },
        { name: "cxMsgCaption", cls: "EditBox", tpl: "Null", x: 0, y: 0, w: W + 52, h: 48, txt },
        { name: "cxMsgMessage", cls: "EditBox", tpl: "Null", x: 18, y: 39, w: W + 16, h: H + 38, txt },
        ...(buttons === "none" ? [] : buttons === "ok" ? [button("cxMsgConfirm", cx - 30)] : [button("cxMsgConfirm", cx - 65), button("cxMsgCancel", cx + 5)]),
      ],
    };
    gui.build(win, this.stage.design, Math.trunc((1024 - win.w) / 2), Math.trunc((768 - win.h) / 2));
    gui.setText("cxMsgCaption", this.textOf("cxMsgCaption") ?? "");
    gui.setText("cxMsgMessage", text);
    for (const name of ["cxMsgConfirm", "cxMsgCancel"]) {
      if (!gui.get(name)) continue;
      gui.setText(name, this.textOf(name) ?? "");
      const [pl, ctl] = CROSS_CLICK[name], snd = CROSS_SOUND[name];
      gui.button(name, () => { if (snd) playUiSound(snd); this.ctl.click(pl, ctl); });
    }
  }

  /** PlayerStore of the Game session (inventory + equipped loadout), null outside a channel. */
  get player(): PlayerStore | null { return this.ctl.player; }

  /** ChannelType of the channel the session is in (controller.ts channelType), for the clan HUD of the match */
  get channelType(): number | null { return this.ctl.channelType; }
  /** the room came from the clan-war pairing (controller clanPairing), for the clan HUD of the match */
  get clanPairing(): boolean { return this.ctl.clanPairing; }

  /** mission cards of the Game session, handed to the match for its HUD; null outside a channel */
  get missions(): MissionClient | null { return this.ctl.missions; }

  hide(): void { this.host.hidden = true; }

  show(): void {
    this.host.hidden = false;
    this.stage.fit();
    this.ctl.draw();
  }
}
