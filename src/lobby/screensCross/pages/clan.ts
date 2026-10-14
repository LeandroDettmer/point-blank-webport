// Cross clan menu (mbClan, Point Blank Cross V-37): ClanNonMemberWin (no clan) or ClanMemberWin (in a clan) of
// UI_Project_Clan.json, and the clan popups of UI_Project_Popup.json (criar clã, registro, pedido de cadastro, pedido
// detalhe). mbClan sets the controller's page "clan" (openClan, the lobby is hidden while it is on); paint() shows the windows
// while that page is on and drops the state when it leaves. Opening runs 769 (ENTER) for the clanId / access; every action is
// a ClanClient request (src/net/clanClient.ts) followed by a redraw. Back / Sair go through the controller (closeMenu, 771).
// Battle tab and its lobby step: clanBattle.ts. Not ported: history (no season data on the server), chat, emblem, rename,
// forum address, rules (868) and the note to members (892) [LACUNA]. The mbClan gate (+0x400) is not applied.
import { ClanClient, type ClanDetail, type ClanEvent, type ClanJoinRequest, type ClanMemberRow, type ClanStatus } from "../../../net/clanClient.ts";
import { jsonOnce } from "../../../jsonOnce.ts";
import type { GNode, I3Gui } from "../../ui/i3Gui.ts";
import { BASE, buildWindows, locate, loadPack, nickCss, onClick, pageGui, setTab, type PageCtx, type Texts } from "./common.ts";
import { MAIN_BUTTONS } from "../../core/model.ts";
import { CLAN_ACCESS, MEMBER_ACTIONS, canManage, clanDate, failText, isLeader, presence, type ClanOp, type MemberActionDef } from "../clanRules.ts";
import { ClanBrowser, type BrowseNames } from "./clanBrowser.ts";
import { CLAN_MARK_DEFAULT, decodeClanMark } from "../../clanMark.ts";
import { applyClanMark, checkClanMark, clanMarkItem, clanMarkPicker, type MarkHooks } from "../clanMarkPicker.ts";
import { paintMark } from "../clanMarkView.ts";
import { paintNodeIcons } from "../iconCanvas.ts";
import { BATTLE_TEXTS, ClanBattle } from "./clanBattle.ts";

/** Settings.ini (MinCreateRank / MinCreateGold), the create rule of socialHandlers.ts:644 */
const MIN_CREATE_RANK = 15, MIN_CREATE_GOLD = 25000;
/** [INFERIDO] text of clanCreateGuideValue: the exe's guide text is not decoded; the numbers are the server's rule */
const CREATE_GUIDE = `Para criar um clã é preciso ter nível ${MIN_CREATE_RANK} ou mais e ${MIN_CREATE_GOLD.toLocaleString("pt-BR")} de gold.`;
const WINDOWS = ["ClanNonMemberWin", "ClanMemberWin"];
const POPUPS = ["clanCreatePopup", "clanInputInfoPopup", "clanSubscriptionPopup", "clanSubscriberInfoPopup"];
/** the panels of the two windows (children of the full-design root): the ones that take the pointer */
const PANELS = ["clanSubscriberWin", "clanClanListWin", "clanMyClanWin", "clanManagementWin"];
type Popup = "guide" | "name" | "memo" | "request";
type Tab = "info" | "search" | "management" | "battle";
type Sub = "writing" | "member" | "subscription" | "others";

const TEXTS: Texts = {
  ...BATTLE_TEXTS,
  // ClanMemberWin: my clan (clanMyClanWin)
  clanMyClanCaption: ["STBL_IDX_CLAN_MY_CLAN", "Meu clã"],
  clanMyClanNameStatic: ["STBL_IDX_CLAN_NAME", "Nome do clã :"], clanMyClanStaffStatic: ["STBL_IDX_CLAN_PERSON", "Membros :"],
  clanMyClanRankStatic: ["STBL_IDX_CLAN_RANK", "Classe :"], clanMyClanMasterStatic: ["STBL_IDX_CLAN_MASTER", "Líder"],
  clanMyClanExpStatic: ["STBL_IDX_CLAN_EXP", "Experiência:"], clanMyClanOrderStatic: ["STBL_IDX_CLAN_ORDER", "Nível :"],
  clanMyClanAddressStatic: ["STBL_IDX_CLAN_AZIT", "Fórum :"], clanMyClanPointStatic: ["STBL_IDX_CLAN_POINT", "Pts. de Clã :"],
  // ClanMemberWin: management window (clanManagementWin)
  clanManagementCaption: ["STBL_IDX_CLAN_INFORMATION", "Informações do Clã"],
  clanInfoMember: ["STBL_IDX_CLAN_MEMBER", "Membros do clã"], clanInfoSecession: ["STBL_IDX_CLAN_SECESSION", "Abandonar clã"],
  clanMemberListStatic: ["STBL_IDX_CLAN_MEMBER_LIST", "Lista de membros do clã"],
  clanMemberListHeadClass: ["STBL_IDX_CLAN_MEMBER_LEVEL", "Nível"], clanMemberListHeadNick: ["STBL_IDX_CLAN_MEMBER_NAME", "Nick"],
  clanMemberListHeadState: ["STBL_IDX_CLAN_MEMBER_STATE", "Estado"],
  clanManagementWritingBoard: ["STBL_IDX_CLAN_MANAGEMENT_WRITING_BOARD", "Administrar posts"],
  clanManagementMember: ["STBL_IDX_CLAN_MANAGEMENT_MEMBER", "Administrar membros do clã"],
  clanManagementSubscription: ["STBL_IDX_CLAN_MANAGEMENT_SUBSCRIPTION", "Administrar alistamentos"],
  clanManagementOthers: ["STBL_IDX_CLAN_MANAGEMENT_OTHERS", "Administrar outros"],
  clanManagementWritingBoardNoticeStatic: ["STBL_IDX_CLAN_MODIFY_NOTICE", "Alterar notícia"],
  clanManagementWritingBoardGuideStatic: ["STBL_IDX_CLAN_MODIFY_GUIDE", "Alterar informação do clã"],
  clanManagementWritingBoardNoticeModify: ["STBL_IDX_CLAN_MODIFY_OK", "Alterar"], clanManagementWritingBoardGuideModify: ["STBL_IDX_CLAN_MODIFY_OK", "Alterar"],
  clanManagementMemberStatic: ["STBL_IDX_CLAN_MEMBER_LIST", "Lista de membros do clã"],
  clanManagementListHeadNick: ["STBL_IDX_CLAN_MEMBER_NAME", "Nick"], clanManagementListHeadClass: ["STBL_IDX_CLAN_MEMBER_LEVEL", "Nível"],
  clanManagementListHeadDay: ["STBL_IDX_CLAN_MEMBER_JOIN_DATE", "Data de cadastro"],
  clanManagementInstructionStatic: ["STBL_IDX_CLAN_SELECTED_MEMBER", "Membros selecionados"], clanManagementInstructionCombo: ["STBL_IDX_CLAN_CHOOSING", "Selecionar"],
  clanManagementSubscriptionStatic: ["STBL_IDX_CLAN_SUBSCRIBER_LIST", "Aplicações"],
  clanSubscriptionListHeadNick: ["STBL_IDX_CLAN_MEMBER_NAME", "Nick"], clanSubscriptionListHeadDay: ["STBL_IDX_CLAN_MEMBER_REQUEST_DATE", "Data de pedido"],
  clanSubscriptionInstructionStatic: ["STBL_IDX_CLAN_SELECTED_USER", "Selecionado"], clanSubscriptionInstructionCombo: ["STBL_IDX_CLAN_CHOOSING", "Selecionar"],
  clanManagementOthersDissolutionStatic: ["STBL_IDX_CLAN_DISSOLUTION_STATIC", "Terminar clã"],
  clanManagementOthersChangeClanMarkStatic: ["STBL_IDX_CLAN_CHANGE_CLAN_MARK", "Trocar emblema"],
  clanManagementOthersChangeClanMarkButton: ["STBL_IDX_CLAN_CHANGE_CLAN_MARK", "Trocar emblema"],
  clanManagementOthersDissolutionButton: ["STBL_IDX_CLAN_DISSOLUTION", "Excluir todo o clã"],
  // search (member tab) and no-clan window: the same rows, the search's own control names
  clanSearchClanSearchStatic: ["STBL_IDX_CLAN_BATTLE_SEARCHING", "Procurar clã"],
  clanSearchClanNameStatic: ["STBL_IDX_CLAN_NAME", "Nome do clã :"], clanSearchClanStaffStatic: ["STBL_IDX_CLAN_PERSON", "Membros :"],
  clanSearchClanMasterStatic: ["STBL_IDX_CLAN_MASTER", "Líder"], clanSearchClanRankStatic: ["STBL_IDX_CLAN_RANK", "Classe :"],
  clanSearchClanExpStatic: ["STBL_IDX_CLAN_EXP", "Experiência:"], clanSearchClanOrderStatic: ["STBL_IDX_CLAN_ORDER", "Nível :"],
  clanSearchAddressStatic: ["STBL_IDX_CLAN_AZIT", "Fórum :"],
  clanSearchClanListViewAll: ["STBL_IDX_CLAN_VIEW_ALL", "Ver todos"],
  clanSearchClanListHeadRank: ["STBL_IDX_CLAN_HEADER_RANK", "Nível"], clanSearchClanListHeadName: ["STBL_IDX_CLAN_HEADER_NAME", "Nome do clã"],
  clanSearchClanListHeadDate: ["STBL_IDX_CLAN_HEADER_ENTRY", "Data de criação"], clanSearchClanListHeadMember: ["STBL_IDX_CLAN_HEADER_PERSON", "Membros"],
  clanNonMemberCaption: ["STBL_IDX_CLAN_FINDING", "Procurar clã"], clanNonMemberSearchStatic: ["STBL_IDX_CLAN_SEARCHING", "Procurar clã por nome"],
  clanNonMemberClanSubscription: ["STBL_IDX_CLAN_JOINING", "Aliste-se"], clanNonMemberClanCreate: ["STBL_IDX_CLAN_CREATING", "Criar clã"],
  clanNonMemberClanNameStatic: ["STBL_IDX_CLAN_NAME", "Nome do clã :"], clanNonMemberClanStaffStatic: ["STBL_IDX_CLAN_PERSON", "Membros :"],
  clanNonMemberClanMasterStatic: ["STBL_IDX_CLAN_MASTER", "Líder"], clanNonMemberClanRankStatic: ["STBL_IDX_CLAN_RANK", "Classe :"],
  clanNonMemberClanExpStatic: ["STBL_IDX_CLAN_EXP", "Experiência:"], clanNonMemberClanOrderStatic: ["STBL_IDX_CLAN_ORDER", "Nível :"],
  clanNonMemberAddressStatic: ["STBL_IDX_CLAN_AZIT", "Fórum :"],
  clanClanListCaption: ["STBL_IDX_CLAN_CLAN", "Clã"], clanClanListViewAll: ["STBL_IDX_CLAN_VIEW_ALL", "Ver todos"],
  clanClanListHeadRank: ["STBL_IDX_CLAN_HEADER_RANK", "Nível"], clanClanListHeadClanName: ["STBL_IDX_CLAN_HEADER_NAME", "Nome do clã"],
  clanClanListHeadEntryDay: ["STBL_IDX_CLAN_HEADER_ENTRY", "Data de criação"], clanClanListHeadEntryMember: ["STBL_IDX_CLAN_HEADER_PERSON", "Membros"],
  clanUserListHeadTitle: ["STBL_IDX_CLAN_HEADER_USER_LIST", "Lista de usuários conectados"],
};

/** popups (UI_Project_Popup): caption / label / button texts */
const POP_TEXTS: Texts = {
  clanCreateCaption: ["STBL_IDX_CLAN_CREATING", "Criar clã"], clanCreateOk: ["STBL_IDX_CLAN_BUTTON_OK", "Confirmar"], clanCreateCancel: ["STBL_IDX_CLAN_BUTTON_CANCEL", "Cancelar"],
  clanInputInfoCaption: ["STBL_IDX_CLAN_CAPTION_INPUT_INFO", "Registração do Clã"], clanInputInfoOk: ["STBL_IDX_CLAN_BUTTON_OK", "Confirmar"],
  clanInputInfoCancel: ["STBL_IDX_CLAN_BUTTON_CANCEL", "Cancelar"], clanInputInfoClanNameStatic: ["STBL_IDX_CLAN_HEADER_NAME", "Nome do clã"],
  clanInputInfoClanNameGuideStatic: ["STBL_IDX_CLAN_INPUT_NAME_CONDITION", "(16 dígitos em Português)"],
  clanInputInfoClanIntroduceStatic: ["STBL_IDX_CLAN_INPUT_GUIDE_CONDITION", "Apresentação do clã."],
  clanSubscriptionPopupCaption: ["STBL_IDX_CLAN_CAPTION_SUBSCRIBER_NOTE", "Mensagem de cadastro do clã"], clanSubscriptionPopupOk: ["STBL_IDX_CLAN_SEND", "Enviar"],
  clanSubscriptionPopupCancel: ["STBL_IDX_CLAN_BUTTON_CANCEL", "Cancelar"], clanSubscriptionPopupMessageStatic: ["STBL_IDX_CLAN_SUBSCRIBER_NOTE_CONDITION", "Mensagem de pedido de cadastro"],
  clanSubscriberInfoPopupCaption: ["STBL_IDX_CLAN_SUBSCRIBER_INFO", "Informações do pedido de cadastro"], clanSubscriberInfoPopupPrev: ["STBL_IDX_CLAN_PREV", "Anterior"],
  clanSubscriberInfoPopupNext: ["STBL_IDX_CLAN_NEXT", "Próximo"], clanSubscriberInfoPopupOk: ["STBL_IDX_CLAN_BUTTON_OK", "Confirmar"],
  clanSubscriberInfoPopupMessageStatic: ["STBL_IDX_CLAN_SUBSCRIBER_NOTE", "Aplicações de Mensagem"], clanSubscriberInfoPopupNickStatic: ["STBL_IDX_CLAN_MEMBER_NAME", "Nick"],
};

/** window controls with no web equivalent: chat, emblem, rename, forum address, rules, history, battle, bars */
const HIDDEN = /Chat|ExpBar|ExpFrame|History|BestList|SerchBar|SerchGage|SerchText|[Ff]ocus$|Selection$|ListSelect$|ListRank\d|ListTitle\d|Authority|AdmissionLimit|ChangeClanName|SendNote|OthersFrame|OthersModify|ClanMemberSerch/;
/** popup rows with no web data (the request's receiver / win / score / rank), the address and the name check (no opcode) */
const POP_HIDDEN = /ReceiverStatic|ReceiverValue|ReceiverBullet|WinStatic|WinValue|WinBullet|ScoreStatic|ScoreValue|ScoreBullet|RankImage|GuideBullet|ClanAddress|ClanNameCheck|clanSubscriptionPopupNickStatic|clanSubscriptionPopupNickValue|clanSubscriberInfoPopupNickBullet|clanSubscriberInfoPopupNickValue/;

const NON_MEMBER: BrowseNames = {
  rows: 15,
  name: (i) => `clanClanLisClanName${i}`, day: (i) => `clanClanListEntryDay${i}`, members: (i) => `clanClanListEntryMember${i}`,
  scroll: "clanClanListScrollList", viewAll: "clanClanListViewAll",
  info: { name: "clanNonMemberClanNameValue", master: "clanNonMemberClanMasterValue", rank: "clanNonMemberClanRankValue", staff: "clanNonMemberClanStaffValue", order: "clanNonMemberClanOrderValue", exp: "clanNonMemberClanExpValue", address: "clanNonMemberAddressValue", intro: "clanNonMemberClanIntroduceValue" },
  search: { edit: "clanNonMemberSearchEdit", button: "clanNonMemberSearchButton" },
  mark: { row: (i) => `clanClanListClanMarkImage${i}`, panel: "clanNonMemberClanMark" },
};
const SEARCH: BrowseNames = {
  rows: 8,
  name: (i) => `clanSearchClanLisClanName${i}`, day: (i) => `clanSearchClanListEntryDay${i}`, members: (i) => `clanSearchClanListEntryMember${i}`,
  scroll: "clanSearchClanListScrollList", viewAll: "clanSearchClanListViewAll",
  info: { name: "clanSearchClanNameValue", master: "clanSearchClanMasterValue", rank: "clanSearchClanRankValue", staff: "clanSearchClanStaffValue", order: "clanSearchClanOrderValue", exp: "clanSearchClanExpValue", address: "clanSearchAddressValue", intro: null },
  search: { edit: "clanSearchClanSearchInput", button: "clanSearchClanSearchButton" },
  mark: { row: (i) => `clanSearchClanListClanMarkImage${i}`, panel: "clanSearchClanMark" },
};

/** rows of the member list (info tab: 7) and of the management lists (12) */
const INFO_ROWS = 7, MANAGE_ROWS = 12;

/** a row's presence text (CLAN_STATE): "Canal%d Sala%d" for a room, channel shown 1-based [INFERIDO] */
function presenceText(str: (k: string, f: string) => string, st: ClanStatus): string {
  const [k, f] = presence(st);
  return k.endsWith("DECLARE_ROOM") ? str(k, f).replace("%d", String(st.channel + 1)).replace("%d", String(st.room)) : str(k, f);
}

export class ClanPage {
  private gui: I3Gui;
  private pop: I3Gui;
  private client: ClanClient | null = null;
  private conn: unknown = null;
  private off: (() => void) | null = null;
  private visible = false;
  private busy = false;
  // my account's clan (ENTER 770) and the lists of my clan
  private clanId = 0;
  private access = 0;
  private pending = 0;
  private detail: ClanDetail | null = null;
  private members: ClanMemberRow[] = [];
  private requests: ClanJoinRequest[] = [];
  private checked = new Set<string>();
  private reqChecked = new Set<string>();
  private memberTop = 0;
  private reqTop = 0;
  private reqSel = -1;
  private tab: Tab = "info";
  private sub: Sub = "member";
  private dropdown: "member" | "subscription" | null = null;
  private popup: Popup | null = null;
  private memo = 0;
  private nameBox: HTMLInputElement | null = null;
  private introBox: HTMLTextAreaElement | null = null;
  private memoBox: HTMLTextAreaElement | null = null;
  private noticeBox: HTMLTextAreaElement | null = null;
  private guideBox: HTMLTextAreaElement | null = null;
  private outside: ClanBrowser;
  private search: ClanBrowser;
  private battle: ClanBattle;
  /** repaint of every button (its state sprite follows the access) */
  private repaints: (() => void)[] = [];

  static async create(ctx: PageCtx): Promise<ClanPage> {
    const [root, popRoot] = await Promise.all([loadPack("UI_Project_Clan"), jsonOnce<{ root: GNode }>(`${BASE}/UI_Project_Popup.json`)]);
    return new ClanPage(ctx, root.root, popRoot.root);
  }

  private constructor(private ctx: PageCtx, root: GNode, popRoot: GNode) {
    this.gui = pageGui(ctx, TEXTS);
    this.pop = pageGui(ctx, POP_TEXTS);
    buildWindows(this.gui, ctx, root, WINDOWS);
    buildWindows(this.pop, ctx, popRoot, POPUPS);
    for (const w of WINDOWS) this.hideMatching(this.gui, root, w, HIDDEN);
    for (const p of POPUPS) this.hideMatching(this.pop, popRoot, p, POP_HIDDEN);
    // the window roots cover the whole design and pass the pointer through; pointer-events is inherited, so the panels (and
    // every control in them) must say `auto` themselves or the controls get no clicks
    for (const w of WINDOWS) { const el = this.gui.get(w)?.el; if (el) el.style.pointerEvents = "none"; }
    for (const p of PANELS) { const el = this.gui.get(p)?.el; if (el) el.style.pointerEvents = "auto"; }
    const call = () => this.ctx.ctl.draw();
    const api = () => this.api();
    this.outside = new ClanBrowser(this.gui, NON_MEMBER, api, call, (what) => console.warn("[cross] clan list", what));
    this.search = new ClanBrowser(this.gui, SEARCH, api, call, (what) => console.warn("[cross] clan search", what));
    this.battle = new ClanBattle(this.ctx, this.gui, root, () => this.detail);
    this.wire();
  }

  /** hides the controls of window `name` (under `root`) whose names match `re` */
  private hideMatching(gui: I3Gui, root: GNode, name: string, re: RegExp): void {
    const f = locate(root, name);
    const walk = (n: GNode) => { if (re.test(n.name)) gui.hide(n.name); n.children?.forEach(walk); };
    if (f) walk(f.node);
  }

  private str(key: string, fallback: string): string { return this.ctx.str(key, fallback); }
  private say(text: string): void { this.ctx.ctl.say(text, true); }
  private draw(): void { this.ctx.ctl.draw(); }

  /** a button whose state sprite the paint refreshes (`on` false = greyed) */
  private button(gui: I3Gui, name: string, fn: () => void, on: () => boolean = () => true): void {
    this.repaints.push(gui.button(name, fn, on));
  }

  /** one-time wiring of every control (the handlers read the state when they run) */
  private wire(): void {
    const g = this.gui, p = this.pop;
    this.button(g, "clanClanListLeaveButton", () => this.close());
    this.button(g, "clanMemberLeaveButton", () => this.close());
    // no clan: create / join; the user tab is not ready (the exe's)
    this.button(g, "clanNonMemberClanCreate", () => this.openPopup("guide"));
    this.button(g, "clanNonMemberClanSubscription", () => this.joinButton());
    this.button(g, "clanUserListTab", () => this.say(this.str("STBL_IDX_CLAN_PREPARE_PLAN", "Em preparação")));
    // member: tabs
    this.button(g, "clanInfoTab", () => this.setTab("info"));
    this.button(g, "clanBattleTab", () => this.setTab("battle"));
    this.button(g, "clanSearchTab", () => this.setTab("search"));
    this.button(g, "clanManagementTab", () => this.setTab("management"));
    this.button(g, "clanInfoSecession", () => this.askSecede());
    // management sub-tabs
    this.button(g, "clanManagementWritingBoard", () => this.setSub("writing"));
    this.button(g, "clanManagementMember", () => this.setSub("member"));
    this.button(g, "clanManagementSubscription", () => this.setSub("subscription"));
    this.button(g, "clanManagementOthers", () => this.setSub("others"));
    this.button(g, "clanManagementWritingBoardNoticeModify", () => void this.saveText("notice"), () => canManage(this.access));
    this.button(g, "clanManagementWritingBoardGuideModify", () => void this.saveText("intro"), () => canManage(this.access));
    this.button(g, "clanManagementOthersDissolutionButton", () => this.askDissolve(), () => isLeader(this.access));
    this.button(g, "clanManagementOthersChangeClanMarkButton", () => void this.openChangeMark(), () => isLeader(this.access));
    // member and request lists: check boxes (a row's name click checks it too)
    for (let i = 1; i <= MANAGE_ROWS; i++) {
      const member = () => this.members[this.memberTop + i - 1]?.playerId.toString();
      const request = () => this.requests[this.reqTop + i - 1]?.playerId.toString();
      onClick(g, `clanManagementListCheck${i}`, () => this.toggle(this.checked, member()));
      onClick(g, `clanManagementListNick${i}`, () => this.toggle(this.checked, member()));
      onClick(g, `clanSubscriptionListCheck${i}`, () => this.toggle(this.reqChecked, request()));
      onClick(g, `clanSubscriptionListNick${i}`, () => { this.reqSel = this.reqTop + i - 1; this.toggle(this.reqChecked, request()); });
    }
    onClick(g, "clanManagementListHeadCheckAll", () => this.toggleAll(this.checked, this.members.map((m) => m.playerId.toString())));
    onClick(g, "clanSubscriptionListHeadCheckAll", () => this.toggleAll(this.reqChecked, this.requests.map((q) => q.playerId.toString())));
    this.button(g, "clanManagementInstructionButton", () => this.toggleDropdown("member"));
    onClick(g, "clanManagementInstructionCombo", () => this.toggleDropdown("member"));
    this.button(g, "clanSubscriptionInstructionButton", () => this.toggleDropdown("subscription"));
    onClick(g, "clanSubscriptionInstructionCombo", () => this.toggleDropdown("subscription"));
    // popups
    this.button(p, "clanCreateOk", () => this.openPopup("name"));
    this.button(p, "clanCreateCancel", () => this.openPopup(null));
    this.button(p, "clanInputInfoOk", () => this.nameNext());
    this.button(p, "clanInputInfoCancel", () => this.openPopup(null));
    this.button(p, "clanSubscriptionPopupOk", () => void this.join());
    this.button(p, "clanSubscriptionPopupCancel", () => this.openPopup(null));
    this.button(p, "clanSubscriberInfoPopupOk", () => this.openPopup(null));
    this.button(p, "clanSubscriberInfoPopupPrev", () => this.stepRequest(-1));
    this.button(p, "clanSubscriberInfoPopupNext", () => this.stepRequest(1));
    this.nameBox = p.edit("clanInputInfoClanNameEdit", { maxLength: 17 });
    this.introBox = this.area(p, "clanInpuIntroduceValue", 255);
    this.memoBox = this.area(p, "clanSubscriptionPopupMemoEdit", 127);
    this.noticeBox = this.area(g, "clanManagementWritingBoardNoticeTextBox", 255);
    this.guideBox = this.area(g, "clanManagementWritingBoardGuideTextBox", 255);
  }

  /** a multi-line box over an EditBox control (the exe's TextBox); `max` characters (the server's byte limit / 2) */
  private area(gui: I3Gui, name: string, max: number): HTMLTextAreaElement | null {
    const b = gui.get(name);
    if (!b) return null;
    const t = document.createElement("textarea");
    t.maxLength = max;
    t.style.cssText = `position:absolute;left:3px;top:2px;width:${b.node.w - 6}px;height:${b.node.h - 4}px;box-sizing:border-box;padding:0;border:0;outline:0;resize:none;background:transparent;font:inherit;color:#e4e4e4;`;
    t.addEventListener("click", (e) => e.stopPropagation());
    t.addEventListener("keydown", (e) => e.stopPropagation());
    b.el.appendChild(t);
    return t;
  }

  /** page "clan" (mbClan): the menu opens at the info tab; the membership is read from the server each time */
  private enter(): void {
    // no Game connection yet (the lobby is still connecting): the list and the clan cannot be read, so the page goes back
    // (deferred: say() and the back click redraw, and a redraw inside paint would come back here; visible keeps it to one back click)
    if (!this.api()) {
      this.visible = true;
      queueMicrotask(() => { this.say(this.str("STBL_IDX_CLAN_MESSAGE_PLEASE_WAIT", "Aguarde um momento.")); this.close(); });
      return;
    }
    this.visible = true;
    this.tab = "info";
    this.sub = "member";
    void this.refresh();
  }

  /** page left (Sair / back, or the controller's close): the popups and the lists dropped; the controller sends the clan leave (771) */
  private leave(): void {
    this.visible = false;
    this.popup = null;
    this.dropdown = null;
    this.checked.clear(); this.reqChecked.clear();
    this.outside.reset(); this.search.reset();
  }

  /** Sair / back: the controller's back button closes the page (closeMenu: clan leave 771, then the lobby) */
  private close(): void { this.ctx.ctl.click("main", MAIN_BUTTONS.back); }

  /** ClanClient on the live Game connection: one per connection, its pushes (824, 832, 835..) reach the page at any time */
  private api(): ClanClient | null {
    const conn = this.ctx.ctl.session?.connection ?? null;
    if (!conn || !conn.isOpen) return null;
    if (conn !== this.conn) {
      this.off?.(); this.client?.dispose();
      this.conn = conn;
      this.client = new ClanClient(conn);
      this.off = this.client.on((ev) => this.onPush(ev));
    }
    return this.client;
  }

  /** pushes: 824 puts me in the clan; a removal or a role change reads the clan again */
  private onPush(ev: ClanEvent): void {
    switch (ev.type) {
      case "accept-result":
        this.pending = 0;
        this.clanId = ev.clan.id; this.access = CLAN_ACCESS.NORMAL;
        this.syncProfile(ev.clan.id, CLAN_ACCESS.NORMAL, ev.clan.name);
        break;
      case "deported":
        this.clanLost();
        return;
      case "master": case "staff": case "regular": case "member-insert": case "member-leave": case "member-status":
        break;
      default:
        return;
    }
    if (this.visible) void this.refresh();
    this.draw();
  }

  /** the account has no clan (kicked, left, dissolved): the lists dropped, the profile cleared */
  private clanLost(): void {
    this.clanId = 0; this.access = 0; this.detail = null; this.members = []; this.requests = [];
    this.checked.clear(); this.reqChecked.clear();
    this.syncProfile(0, 0, "");
    this.outside.reset(); this.search.reset();
    this.battle.reset();
    this.tab = "info";
    this.draw();
  }

  /** the account's clan fields in the profile (the chrome's clan label reads clanName): clanId, clanAccess, clanName */
  private syncProfile(clanId: number, access: number, name: string): void {
    const s = this.ctx.ctl.session, p = s?.player.state.profile;
    if (!s || !p) return;
    s.player.dispatch({ type: "profile", basic: { ...p, clanId, clanAccess: access, clanName: name } });
  }

  /** 769: the membership (clanId, access; a pending applicant has an id with access 0) and the data of the menu */
  private async refresh(): Promise<void> {
    const c = this.api();
    if (!c || this.busy) return;
    const r = await c.enter();
    if (!r.ok || !r.data) { this.draw(); return; }
    const e = r.data;
    const had = this.clanId;
    this.clanId = e.clanId; this.access = e.access;
    this.pending = e.clanId && !e.access ? e.clanId : 0;
    if (e.clanId && e.access) {
      await this.loadMine(c);
    } else {
      this.detail = null; this.members = []; this.requests = [];
      this.checked.clear(); this.reqChecked.clear();
      if (had) this.syncProfile(0, 0, "");
      if (!this.outside.count) void this.outside.loadNext();
    }
    this.draw();
  }

  /** my clan: detail (800), every member page (802 / 804), the requests when leader or staff (816 / 818) */
  private async loadMine(c: ClanClient): Promise<void> {
    const d = await c.detail(this.clanId);
    this.detail = d.ok && d.data ? d.data : null;
    const mc = await c.memberContext();
    const pages = mc.ok && mc.data ? mc.data.pages : 0;
    const rows: ClanMemberRow[] = [];
    for (let p = 0; p < pages; p++) {
      const m = await c.memberList(p);
      if (!m.ok || !m.data) break;
      rows.push(...m.data.members);
    }
    this.members = rows;
    this.requests = [];
    if (canManage(this.access)) {
      const rc = await c.requestContext();
      const pg = rc.ok && rc.data ? rc.data.pages : 0;
      for (let p = 0; p < pg; p++) {
        const q = await c.requestList(p);
        if (!q.ok || !q.data) break;
        this.requests.push(...q.data.requests);
      }
    }
    if (this.detail) this.syncProfile(this.clanId, this.access, this.detail.name);
  }

  // ---- no-clan window ----

  /** Aliste-se: a pending applicant cancels it (814); otherwise the picked clan gets the request memo (812) */
  private joinButton(): void {
    if (this.pending) {
      this.confirm(this.str("STBL_IDX_CLAN_MESSAGE_CANCEL_SUBSCRIPTION_Q", "Deseja cancelar o pedido pendente?"), () => void this.cancelJoin());
      return;
    }
    const id = this.outside.pickedId;
    if (!id) { this.say(this.str("STBL_IDX_CLAN_CHOOSE_CLAN", "Por favor, escolha um clã para entrar.")); return; }
    this.memo = id;
    this.openPopup("memo");
  }

  private async cancelJoin(): Promise<void> {
    const c = this.api();
    if (!c || this.busy) return;
    this.busy = true;
    try {
      const r = await c.cancelJoin();
      if (r.ok) { this.pending = 0; this.say(this.str("STBL_IDX_CLAN_CAPTION_CANCEL_REQUEST_SUCCESS", "Cancelamento de pedido de cadastro realizado.")); }
      else this.say(this.str(...failText("cancelJoin", r.err)));
    } catch (e) { console.warn("[cross] clan cancel", e); this.say(this.str(...failText("cancelJoin", 0))); }
    finally { this.busy = false; this.draw(); }
  }

  /** 812: the request for the picked clan with its memo */
  private async join(): Promise<void> {
    const c = this.api();
    if (!c || this.busy) return;
    const text = this.memoBox?.value ?? "";
    this.busy = true;
    try {
      const r = await c.requestJoin(this.memo, text);
      if (r.ok) {
        this.pending = this.memo;
        this.openPopup(null);
        this.say(this.str("STBL_IDX_CLAN_CAPTION_SUBSCRIPTION_SUCCESS", "O cadastro do clã foi realizado com sucesso."));
      } else this.say(this.str(...failText("join", r.err)));
    } catch (e) { console.warn("[cross] clan join", e); this.say(this.str(...failText("join", 0))); }
    finally { this.busy = false; this.draw(); }
  }

  /** name popup OK: the name is checked here, then the emblem picker; its OK sends the create (806) */
  private nameNext(): void {
    if (!(this.nameBox?.value ?? "").trim()) { this.say(this.str("STBL_IDX_CLAN_MESSAGE_PLEASE_INPUT_NAME", "Digite o nome do clã.")); return; }
    this.openPopup(null);
    void clanMarkPicker(this.ctx).then((p) => p.show("create", null, this.markHooks((logo) => void this.create(logo))));
  }

  /** the picker's OK and its overlap check (856) for this page; `ok` is the action the OK runs */
  private markHooks(ok: (logo: number) => void): MarkHooks {
    return { ok, check: (logo) => void this.checkMark(logo) };
  }

  /** 856 from the emblem picker: the message says whether the emblem is free */
  private async checkMark(logo: number): Promise<void> {
    const s = this.ctx.ctl.session;
    if (s) this.say(await checkClanMark(s, logo));
  }

  /** management "Trocar emblema" (leader): the picker starts on the clan's emblem; its OK runs the change item */
  private async openChangeMark(): Promise<void> {
    const p = await clanMarkPicker(this.ctx);
    p.show("change", decodeClanMark(this.detail?.logo ?? CLAN_MARK_DEFAULT), this.markHooks((logo) => void this.changeMark(logo)));
  }

  /** 1052 with the emblem (the change item 1600052 is needed; the server checks the owner and that the emblem is free) */
  private async changeMark(logo: number): Promise<void> {
    const s = this.ctx.ctl.session;
    if (!s) return;
    const item = clanMarkItem(s);
    if (!item) { this.say(this.str("STBL_IDX_CLAN_CHANGE_CLAN_MARK_NEED_ITEM", "Você precisa do item de troca de emblema.")); return; }
    const err = await applyClanMark(s, item, logo);
    if (err) { this.say(err); return; }
    if (this.detail) this.detail.logo = logo;
    const p = s.player.state.profile;
    if (p) s.player.dispatch({ type: "profile", basic: { ...p, clanLogo: logo } });
    void clanMarkPicker(this.ctx).then((pk) => pk.close());
    this.say(this.str("STBL_IDX_CLAN_CHANGE_CLAN_MARK_OK", "Emblema alterado."));
    this.draw();
  }

  /** 806: name + intro + emblem (server socialHandlers.ts reads the emblem after the intro [INFERIDO]) */
  private async create(logo: number): Promise<void> {
    const c = this.api();
    if (!c || this.busy) return;
    const name = (this.nameBox?.value ?? "").trim(), intro = this.introBox?.value ?? "";
    if (!name) { this.say(this.str("STBL_IDX_CLAN_MESSAGE_PLEASE_INPUT_NAME", "Digite o nome do clã.")); return; }
    this.busy = true;
    try {
      const r = await c.create(name, intro, logo);
      if (!r.ok || !r.data) { this.say(this.str(...failText("create", r.err))); return; }
      void clanMarkPicker(this.ctx).then((p) => p.close());
      this.openPopup(null);
      this.clanId = r.data.id; this.access = CLAN_ACCESS.LEADER; this.pending = 0;
      this.outside.reset();
      this.syncProfile(r.data.id, CLAN_ACCESS.LEADER, r.data.name);
      await this.loadMine(c);
      this.say(this.str("STBL_IDX_CLAN_CAPTION_COMPLETE_CREATING", "Clã criado!"));
    } catch (e) {
      // timeout / socket error (a duplicate name gets 807 0x8000105a: failText above)
      console.warn("[cross] clan create", e);
      this.say(this.str(...failText("create", 0)));
    } finally { this.busy = false; this.draw(); }
  }

  // ---- member window ----

  private setTab(t: Tab): void {
    if (t === "management" && !canManage(this.access)) { this.say(this.str("STBL_IDX_CLAN_REQUIRE_MASTER_OR_STAFF", "Necessita de autoridade do Líder ou Auxiliar.")); return; }
    this.tab = t;
    if (t === "search") { this.search.reset(); void this.search.loadNext(); }
    if (t === "battle") this.battle.enter();
    this.draw();
  }

  private setSub(s: Sub): void {
    if (s === "others" && !isLeader(this.access)) { this.say(this.str("STBL_IDX_CLAN_REQUIRE_MASTER", "Apenas o Líder pode alterar.")); return; }
    this.sub = s;
    this.tab = "management";
    if (s === "writing" && this.detail) {
      if (this.noticeBox) this.noticeBox.value = this.detail.news;
      if (this.guideBox) this.guideBox.value = this.detail.info;
    }
    this.dropdown = null;
    this.draw();
  }

  private toggle(set: Set<string>, key: string | undefined): void {
    if (!key) return;
    if (set.has(key)) set.delete(key); else set.add(key);
    this.draw();
  }

  private toggleAll(set: Set<string>, keys: string[]): void {
    const all = keys.length > 0 && keys.every((k) => set.has(k));
    set.clear();
    if (!all) keys.forEach((k) => set.add(k));
    this.draw();
  }

  private askSecede(): void {
    if (!this.clanId) return;
    this.confirm(this.str("STBL_IDX_CLAN_MESSAGE_SECESSION_Q", "Deseja sair do clã?"), () => void this.secede());
  }

  /** 828: a member leaves; the owner cannot (the server answers 0x8000105e) */
  private async secede(): Promise<void> {
    const c = this.api();
    if (!c || this.busy) return;
    this.busy = true;
    try {
      const r = await c.secede();
      if (r.ok) { this.clanLost(); this.say(this.str("STBL_IDX_CLAN_CAPTION_SECESSION_SUCCESS", "Sucesso ao sair do clã.")); void this.refresh(); }
      else this.say(this.str(...failText("secede", r.err)));
    } catch (e) { console.warn("[cross] clan secede", e); this.say(this.str(...failText("secede", 0))); }
    finally { this.busy = false; this.draw(); }
  }

  private askDissolve(): void {
    if (!isLeader(this.access)) return;
    this.confirm(this.str("STBL_IDX_CLAN_MESSAGE_DISSOLUTION_Q", "Tem certeza que deseja excluir o clã?"), () => void this.dissolve());
  }

  /** 808: the owner deletes the clan */
  private async dissolve(): Promise<void> {
    const c = this.api();
    if (!c || this.busy) return;
    this.busy = true;
    try {
      const r = await c.close();
      if (r.ok) { this.clanLost(); this.say(this.str("STBL_IDX_CLAN_CAPTION_DISSOLUTION_SUCCESS", "O clã foi desfeito.")); void this.refresh(); }
      else this.say(this.str(...failText("close", r.err)));
    } catch (e) { console.warn("[cross] clan close", e); this.say(this.str(...failText("close", 0))); }
    finally { this.busy = false; this.draw(); }
  }

  /** 858 notice / 860 intro: the leader or staff; the detail is read again after the save */
  private async saveText(which: "notice" | "intro"): Promise<void> {
    const c = this.api();
    if (!c || this.busy || !canManage(this.access)) return;
    const text = (which === "notice" ? this.noticeBox?.value : this.guideBox?.value) ?? "";
    this.busy = true;
    try {
      const r = which === "notice" ? await c.replaceNotice(text) : await c.replaceIntro(text);
      if (r.ok) { await this.loadMine(c); this.say(this.str("STBL_IDX_CLAN_CAPTION_MODIFY_SUCCESS", "Alteração realizada.")); }
      else this.say(this.str(...failText(which, r.err)));
    } catch (e) { console.warn("[cross] clan text", e); this.say(this.str(...failText(which, 0))); }
    finally { this.busy = false; this.draw(); }
  }

  private toggleDropdown(which: "member" | "subscription"): void {
    this.dropdown = this.dropdown === which ? null : which;
    this.draw();
  }

  /** 830 / 836 / 839 / 833 on the checked rows; each row must have the access the action's target needs */
  private async memberAction(a: MemberActionDef): Promise<void> {
    const c = this.api();
    if (!c || this.busy) return;
    const picked = this.members.filter((m) => this.checked.has(m.playerId.toString()) && m.access !== CLAN_ACCESS.LEADER && (a.id === "deport" || m.access === a.target));
    if (!picked.length) { this.say(this.str("STBL_IDX_CLAN_SELECTED_MEMBER", "Selecione um membro.")); return; }
    if (a.id === "master" && picked.length !== 1) { this.say(this.str("STBL_IDX_CLAN_MESSAGE_COMMISSION_MASTER_ONLY", "Apenas o líder pode passar a liderança.")); return; }
    const ids = picked.map((m) => m.playerId);
    this.busy = true;
    try {
      if (a.id === "master") {
        const r = await c.commissionMaster(ids[0]);
        if (r.ok) { this.say(this.str("STBL_IDX_CLAN_CAPTION_COMMISION_MASTER_SUCCESS", "A troca de dono do clã foi realizada com sucesso.")); await this.refresh(); }
        else this.say(this.str(...failText("master", r.err)));
      } else {
        const r = a.id === "deport" ? await c.deport(ids) : a.id === "staff" ? await c.commissionStaff(ids) : await c.commissionRegular(ids);
        if (r.ok && r.data && r.data.count > 0) { this.checked.clear(); await this.loadMine(c); }
        else this.say(this.str(...failText(a.id, r.err)));
      }
    } catch (e) { console.warn("[cross] clan member action", e); this.say(this.str(...failText(a.id, 0))); }
    finally { this.busy = false; this.draw(); }
  }

  /** 822 accept / 825 deny of the checked requests */
  private async requestAction(accept: boolean): Promise<void> {
    const c = this.api();
    if (!c || this.busy) return;
    const ids = this.requests.filter((q) => this.reqChecked.has(q.playerId.toString())).map((q) => q.playerId);
    if (!ids.length) { this.say(this.str("STBL_IDX_CLAN_SELECTED_USER", "Selecione um pedido.")); return; }
    const op: ClanOp = accept ? "accept" : "deny";
    this.busy = true;
    try {
      const r = accept ? await c.accept(ids) : await c.deny(ids);
      if (r.ok && r.data && r.data.count > 0) { this.reqChecked.clear(); await this.loadMine(c); }
      else this.say(this.str(...failText(op, r.err)));
    } catch (e) { console.warn("[cross] clan request", e); this.say(this.str(...failText(op, 0))); }
    finally { this.busy = false; this.draw(); }
  }

  /** the request detail popup: Informações (the picked request), Prev / Next walk the list */
  private openRequest(): void {
    if (this.reqSel < 0) this.reqSel = this.requests.findIndex((q) => this.reqChecked.has(q.playerId.toString()));
    if (this.reqSel < 0 || !this.requests[this.reqSel]) { this.say(this.str("STBL_IDX_CLAN_SELECTED_USER", "Selecione um pedido.")); return; }
    this.openPopup("request");
  }

  private stepRequest(d: number): void {
    const n = this.requests.length;
    if (!n) return;
    this.reqSel = (this.reqSel + d + n) % n;
    this.draw();
  }

  private confirm(text: string, go: () => void): void {
    this.ctx.ctl.msg = { text, onOk: go, onCancel: () => {} };
    this.draw();
  }

  /** the popup on top (or none); a new input popup starts empty */
  private openPopup(p: Popup | null): void {
    this.popup = p;
    if (p === "name") { if (this.nameBox) this.nameBox.value = ""; if (this.introBox) this.introBox.value = ""; }
    if (p === "memo" && this.memoBox) this.memoBox.value = "";
    this.draw();
  }

  // ---- paint ----

  /** the windows, popups and lists as the state says; the controller draws once per change. Shown while the page is "clan" */
  paint(): void {
    const on = this.ctx.ctl.page === "clan";
    if (on && !this.visible) this.enter();
    else if (!on && this.visible) this.leave();
    this.api();
    const member = !!this.clanId && !!this.access;
    // the battle lobby step replaces the clan window while the battle tab has a team
    const lobby = this.visible && member && this.tab === "battle" && this.battle.inLobby();
    this.gui.show("ClanNonMemberWin", this.visible && !member);
    this.gui.show("ClanMemberWin", this.visible && member && !lobby);
    this.battle.paintLobby(lobby);
    this.pop.show("clanCreatePopup", this.visible && this.popup === "guide");
    this.pop.show("clanInputInfoPopup", this.visible && this.popup === "name");
    this.pop.show("clanSubscriptionPopup", this.visible && this.popup === "memo");
    this.pop.show("clanSubscriberInfoPopup", this.visible && this.popup === "request");
    if (!this.visible) return;
    for (const r of this.repaints) r();
    this.pop.setText("clanCreateGuideValue", CREATE_GUIDE);
    if (member) this.paintMember(); else this.paintOutside();
    this.paintPopup();
    // clan grade / master rank cells (static sprites, clanMyClanRankImage and the like) drawn at the screen size
    paintNodeIcons(this.gui);
    paintNodeIcons(this.pop);
  }

  private paintOutside(): void {
    const g = this.gui;
    g.show("clanClanListPhase", true);
    g.show("clanUserListPhase", false);
    this.outside.paint();
    if (!this.outside.detail) g.setText("clanNonMemberClanIntroduceValue", this.str("STBL_IDX_CLAN_CHOOSE_CLAN_IN_LIST", "Selecione o clã da lista."));
  }

  private paintMember(): void {
    const g = this.gui, d = this.detail;
    setTab(g, "clanInfoTab", this.tab === "info");
    setTab(g, "clanSearchTab", this.tab === "search");
    setTab(g, "clanManagementTab", this.tab === "management");
    setTab(g, "clanBattleTab", this.tab === "battle");
    g.show("clanInfoPhase", this.tab === "info");
    g.show("clanSearchPhase", this.tab === "search");
    g.show("clanManagementPhase", this.tab === "management");
    g.show("clanBattlePhase", this.tab === "battle");
    // my clan (left window)
    g.setText("clanMyClanNameValue", d?.name ?? "");
    // 0x853d8a: 0x4ad850(clanMyClanNameValue, name, clan name colour) = the nick colour table 0xb210a4
    g.setColor("clanMyClanNameValue", nickCss(d?.nameColor));
    g.setText("clanMyClanMasterValue", d?.ownerNick ?? "");
    g.setText("clanMyClanRankValue", d ? `${d.unit}` : "");
    g.setText("clanMyClanStaffValue", d ? `${d.members}/${d.maxPlayers}` : "");
    g.setText("clanMyClanAddressValue", "");
    g.setText("clanMyClanOrderValue", d ? `${d.rank}` : "");
    g.setText("clanMyClanPointValue", d ? `${d.points}` : "");
    g.setText("clanMyClanExpValue", d ? `${d.exp}` : "");
    paintMark(g, "clanMyClanClanMark", d ? d.logo : null);
    if (this.tab === "info") this.paintInfoList();
    if (this.tab === "search") this.search.paint();
    if (this.tab === "management") this.paintManagement();
    if (this.tab === "battle") this.battle.paintPhase();
  }

  private paintInfoList(): void {
    const g = this.gui;
    const top = Math.max(0, Math.min(this.members.length - INFO_ROWS, this.memberTop));
    this.memberTop = top;
    for (let i = 1; i <= INFO_ROWS; i++) {
      const m = this.members[top + i - 1];
      g.show(`clanMemberListNick${i}`, !!m);
      g.show(`clanMemberListClass${i}`, !!m);
      g.show(`clanMemberListState${i}`, !!m);
      g.setText(`clanMemberListNick${i}`, m?.nick ?? "");
      // 0x855dda: 0x4ad850(clanMemberListNick, nick +0xc, nick colour +0x3b)
      g.setColor(`clanMemberListNick${i}`, nickCss(m?.nickColor));
      g.setText(`clanMemberListClass${i}`, m ? `${m.rank}` : "");
      g.setText(`clanMemberListState${i}`, m ? presenceText((k, f) => this.str(k, f), m.status) : "");
    }
  }

  private paintManagement(): void {
    const g = this.gui;
    setTab(g, "clanManagementWritingBoard", this.sub === "writing");
    setTab(g, "clanManagementMember", this.sub === "member");
    setTab(g, "clanManagementSubscription", this.sub === "subscription");
    setTab(g, "clanManagementOthers", this.sub === "others");
    g.show("clanManagementWritingBoardPhase", this.sub === "writing");
    g.show("clanManagementMemberPhase", this.sub === "member");
    g.show("clanManagementSubscriptionPhase", this.sub === "subscription");
    g.show("clanManagementOthersPhase", this.sub === "others");
    if (this.sub === "member") this.paintMembers();
    if (this.sub === "subscription") this.paintRequests();
    this.paintDropdown();
  }

  private paintMembers(): void {
    const g = this.gui;
    const top = Math.max(0, Math.min(this.members.length - MANAGE_ROWS, this.memberTop));
    this.memberTop = top;
    g.paintCheck("clanManagementListHeadCheckAll", this.members.length > 0 && this.members.every((m) => this.checked.has(m.playerId.toString())));
    for (let i = 1; i <= MANAGE_ROWS; i++) {
      const m = this.members[top + i - 1];
      for (const k of ["Nick", "Class", "Day", "Check"]) g.show(`clanManagementList${k}${i}`, !!m);
      g.setText(`clanManagementListNick${i}`, m?.nick ?? "");
      // 0x85eeb7: 0x4ad850(clanManagementListNick, nick +0xc, nick colour +0x3b)
      g.setColor(`clanManagementListNick${i}`, nickCss(m?.nickColor));
      g.setText(`clanManagementListClass${i}`, m ? `${m.rank}` : "");
      g.setText(`clanManagementListDay${i}`, m ? clanDate(m.joinDate) : "");
      g.paintCheck(`clanManagementListCheck${i}`, !!m && this.checked.has(m.playerId.toString()));
    }
  }

  private paintRequests(): void {
    const g = this.gui;
    const top = Math.max(0, Math.min(this.requests.length - MANAGE_ROWS, this.reqTop));
    this.reqTop = top;
    g.paintCheck("clanSubscriptionListHeadCheckAll", this.requests.length > 0 && this.requests.every((q) => this.reqChecked.has(q.playerId.toString())));
    for (let i = 1; i <= MANAGE_ROWS; i++) {
      const q = this.requests[top + i - 1];
      for (const k of ["Nick", "Day", "Check"]) g.show(`clanSubscriptionList${k}${i}`, !!q);
      g.setText(`clanSubscriptionListNick${i}`, q?.nick ?? "");
      g.setText(`clanSubscriptionListDay${i}`, q ? clanDate(q.inviteDate) : "");
      g.paintCheck(`clanSubscriptionListCheck${i}`, !!q && this.reqChecked.has(q.playerId.toString()));
    }
  }

  /** the instruction list under its combo: rebuilt on paint, a pick runs the action and closes the list */
  private paintDropdown(): void {
    const member = this.dropdown === "member", sub = this.dropdown === "subscription";
    this.gui.show("clanManagementInstructionPopup", member);
    this.gui.show("clanSubscriptionInstructionPopup", sub);
    const box = this.gui.get(member ? "clanManagementInstructionPopup" : sub ? "clanSubscriptionInstructionPopup" : "");
    if (!box || (!member && !sub)) return;
    const items: [string, () => void][] = member
      ? MEMBER_ACTIONS.filter((a) => a.can(this.access)).map((a) => [this.str(...a.key), () => void this.memberAction(a)])
      : [
        [this.str("STBL_IDX_CLAN_SUBSCRIBER_INTROMISSION", "Aceitar"), () => void this.requestAction(true)],
        [this.str("STBL_IDX_CLAN_SUBSCRIBER_REJECTION", "Rejeitar"), () => void this.requestAction(false)],
        [this.str("STBL_IDX_CLAN_SUBSCRIBER_INFO", "Informações do pedido de cadastro"), () => this.openRequest()],
      ];
    const el = box.el;
    el.innerHTML = "";
    el.style.height = `${items.length * 22 + 4}px`;
    el.style.zIndex = "5";
    for (const [label, fn] of items) {
      const row = document.createElement("div");
      row.textContent = label;
      row.style.cssText = "position:relative;height:22px;line-height:22px;padding:0 6px;color:#fff;font:12px Arial,sans-serif;background:#1d2a3a;cursor:pointer;white-space:nowrap;";
      row.addEventListener("click", (e) => { e.stopPropagation(); this.dropdown = null; fn(); this.draw(); });
      el.appendChild(row);
    }
  }

  private paintPopup(): void {
    if (this.popup !== "request") return;
    const q = this.requests[this.reqSel];
    if (!q) return;
    this.pop.setText("clanSubscriberInfoPopupNickValue", q.nick);
    this.pop.setText("clanSubscriberInfoPopupMemoEdit", q.text);
    this.pop.setText("clanSubscriberInfoPopupPageValue", `${this.reqSel + 1}/${this.requests.length}`);
  }
}
