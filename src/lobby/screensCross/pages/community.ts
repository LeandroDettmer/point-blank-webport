// Janela Comunidade do Cross (mbCommunity -> cmCommunityWin de UI_Project_Popup.json, CPopupCommunity; o botão da barra
// abre, cmContactClose / cmLeave fecham). Aba Amigos: lista (nome + estado: pedido enviado / recebido, offline, online,
// canal, sala), cartão do amigo selecionado (cmContactChild), Adicionar (popup cmNicknameWin, pelo nick, 1811 via app),
// Dispatcher (exe, PointBlank.exe Cross): CPopupCommunity::OnGuiNotify 0x882570 = switch por id (id - 0x499, ja 0x39;
// tabela de bytes 0x8829d4 -> jump table 0x882964). Ids: 0x49c cmProfile (0x8825ea), 0x49d cmFriend (0x88265b), 0x49e
// cmInvite (0x882671), 0x49f cmContactClose (0x882687), 0x4a0 cmFriendRefuse (0x88269d), 0x4b2 cmFind (0x882716), 0x4b3 cmAdd
// (0x88272c). Todos testam ev 1 (clique). Registro: init 0x882a30 (helper 0x715a90 = nome do controle -> id).
// Estado do amigo = topo 4 bits do status (1 enviado, 2 recebido, 3 offline, 4 online, 5 canal, 8 sala).
// - cmProfile (0x884650 Aceitar / 0x886120 Excluir): estado 2 = "Aceitar amigo" -> confirm STR_POPUP_Q_MESSAGE_ACCEPT_TO_FRINED
//   (0x8875c0) -> 1816; qualquer outro estado = "Excluir" -> confirm STR_POPUP_MESSAGE_DELETE_FRIEND (0x8875f0) -> 1820.
//   Rótulo por estado: _UpdateContactChild 0x88cc80 (idx 1 = estado 2: ACCEPT; 0/2/3/4 = DELETE).
// - cmFriendRefuse (0x886210 Recusar): habilitado só no pedido recebido (0x88cc80, enable 1 no estado 2; 0 nos outros);
//   confirm STR_POPUP_MESSAGE_REFUSE_FRIEND -> 1820 (mesma callback 0x8875f0).
// - cmFriend (Visitar, 0x884800 OnVisit): habilitado no cartão para estado 4/5/6 (0x88cc80). Clique: sem amigo selecionado
//   -> STR_POPUP_PLEASE_MESSAGE_FRIEND_TO_VISIT; estado != 6 (Sala) -> STR_POPUP_MESSAGE_FRIEND_IN_THE_ROOM (0x884c50);
//   estado 6 -> controller.visitRoom: mesmo canal entra pela lista da lobby (pede senha); outro canal/servidor troca de
//   canal e entra (visitOtherChannel). Decodificado (0x884d70, flag = rec+0xc): flag 0 (lista do jogo, a da lobby) só sala
//   visita; flag != 0 (lista do Auth, 0xffffffff) visita quem não é sala também [LACUNA: a lobby não usa essa lista, não portado].
//   "já está na sala" (0xc14cd8 STR_POPUP_ALREADY_JOIN_ROOM, 0x884c50): o amigo em sala com o mesmo servidor e canal e o
//   mesmo lugar que o meu (0x597cc0 = servidor + canal + sala: loc.room (0x9ba9f0, 12 bits) == 0x598020, meu lugar) e eu no
//   lobby (0x4de150 == 3). Na lobby web não há sala (meu lugar = nenhuma), então o caso não ocorre daqui: não portado (o mesmo
//   canal entra pela sala, como no exe). [INFERIDO: 0x597f10, que dá meu lugar, não decodificado]. Gate ocupado 0x519270 =
//   return obj+0x50 (0x884c24 -> 0x885200): sem campo equivalente no web [LACUNA]. "não pode visitar partida" (0xc14d94,
//   só flag != 0) [LACUNA].
//   Não portado: checagem de campeonato (0x820fb0 == 7) do OnVisit.
// - Estado do amigo (Cross, tabela do exe, ver friendClient.ts CrossState): 1/2 pedido = "Privado" (STR_POPUP_SECRET),
// 3, 4, 5, 6 "Sala <canal>-<sala+1>" (0x881bc0).
// - cmInvite (Convidar, 0x884ae0 OnInviteRoom): ver invite() abaixo (877 por session id, em app.ts).
// - cmFind (Buscar, 0x885e90 abre + 0x887420 confirm -> 0x88efb0 modo 1): popup de nick. Ordem do exe (0x88efb0): próprio
//   nick avisa; lista de amigos (exato) seleciona a linha; lista da lobby (exato, 0x78f630) seleciona a linha da lobby
//   (0x885840 + 0x8863c0 -> 0x885b70; lobbyPick -> lbUserListSlotSelect); senão 0x78fc60 guarda o nick (buffer do alvo, 33 bytes)
//   e 0x78e710 manda o evento 0x64, que envia o opcode 297 com o nick (sendFindLobby). O 297 não tem resposta no cliente
//   (0x991d50 não trata 0x129, ver friendClient.ts).
// A lista vem de friendClient.ts (1810 no login, 1815 depois). Aba Bloquear: o exe mostra "Opção desabilitada por
// enquanto" (cmBlockTab ev1 0x885800), igual aqui. Clã e recados: ver notes.ts. Históricos de temporada / total: o servidor
// não manda registros nesta lista.
import { jsonOnce } from "../../../jsonOnce.ts";
import { chat } from "../../../net/chatClient.ts";
import { CrossState, acceptFriend, crossState, deleteFriend, friendList, sendFindLobby, type Friend } from "../../../net/friendClient.ts";
import { friendMenuItems } from "../contextMenu.ts";

/** abre o menu de contexto do amigo (app.ts openContext); items vazio = sem menu */
export type OpenMenu = (e: MouseEvent, f: Friend, items: number[]) => void;
import type { GNode, I3Gui } from "../../ui/i3Gui.ts";
import { paintShapeIndex } from "../iconCanvas.ts";
import { LEVEL_ICON } from "../crossMap.ts";
import { BASE, buildWindows, locate, onClick, pageGui, type PageCtx, type Texts } from "./common.ts";
import { NOTE_HIDDEN, NOTE_TEXTS, NotesPage } from "./notes.ts";

const WINDOW = "cmCommunityWin";
const NICK_POPUP = "cmNicknameWin";
const ROWS = 8;
const ROW_H = 30;
/** the window's controls with no web equivalent (see the header): hidden, never placeholders. The Msg. tab's controls are in notes.ts */
const HIDDEN = [
  /^cmSeason/, /^cmTotal/, /^cmRecordTab/, /^cmUserDetailInfoPopup(?!Msg)/,
  /^cmClan/, ...NOTE_HIDDEN,
];

const TEXTS: Texts = {
  ...NOTE_TEXTS,
  cmCommunityCaption: ["STR_POPUP_COMMUNITY", "Comunidade"],
  cmFriendTab: ["STR_POPUP_FRIEND", "Amigos"],
  cmBlockTab: ["STR_POPUP_BLOCK", "Bloquear"],
  cmContactListName: ["STR_POPUP_NAME", "Nome"],
  // the exe's text map says STR_POPUP_RIGHT_HANDED here (a wrong key); the list's state column is STR_POPUP_STATE [INFERIDO]
  cmContactListState: ["STR_POPUP_STATE", "Estado"],
  cmContactKey: ["STR_POPUP_DETAIL_INFO", "Informações"],
  cmNicknameKey: ["STR_POPUP_NICKNAME", "Apelido"],
  cmPositionKey: ["STR_POPUP_CUR_POSITION", "Estado"],
  cmAdd: ["STR_POPUP_ADD_FRIEND", "Adicionar"],
  cmProfile: ["STR_POPUP_ACCEPT_FRIEND", "Aceitar amigo"],
  cmFriendRefuse: ["STR_POPUP_FRIEND_REFUSE", "Recusar amigo"],
  // label code 0x88a2e1 (STR_POPUP_VISIT) right before cmInvite's 0x88a367: cmFriend is the card's Visitar button
  cmFriend: ["STR_POPUP_VISIT", "Visitar"],
  cmInvite: ["STR_POPUP_INVITE", "Convidar"],
  // cmFind's own label key is not in the exe's label code [INFERIDO]: the popup title key is used
  cmFind: ["STR_POPUP_FIND_USER", "Buscar"],
  cmContactClose: ["STR_POPUP_CLOSE", "Fechar"],
  cmLeave: ["STR_POPUP_CLOSE", "Fechar"],
  cmUserDetailInfoPopupMsgCaption: ["STR_TBL_PROFILE_NOTICE_TEXT", "Aviso"],
  cmUserDetailInfoPopupMsgConfirm: ["STR_POPUP_OK", "Confirmar"],
  cmUserDetailInfoPopupMsgCancel: ["STR_POPUP_CANCEL", "Cancelar"],
  cmNicknameCaption: ["STR_POPUP_ADD_FRIEND", "Adicionar"],
  cmNicknameMessage: ["STR_POPUP_MESSAGE_INPUT_FRIEND_NAME", "Digite o apelido do usuário \npara adicionar na lista de amigos."],
  cmNicknameConfirm: ["STR_POPUP_OK", "Confirmar"],
  cmNicknameCancel: ["STR_POPUP_CANCEL", "Cancelar"],
};

interface Row { f: Friend; idx: number }
type Msg = { kind: "accept" | "refuse" | "delete"; idx: number; nick: string };

export class CommunityPage {
  private gui: I3Gui;
  private opened = false;
  /** server index of the selected friend (its place in the full list), -1 none */
  private sel = -1;
  private top = 0;
  private thumb: (top: number, total: number, visible: number) => void = () => {};
  private msg: Msg | null = null;
  /** the Msg. tab's confirm (delete a note) through the same popup as msg; `ok` runs on Confirmar */
  private noteAsk: { text: string; ok: () => void } | null = null;
  /** the window's tab: the friends list (cmContactSect) or the notes (cmNoteSect) */
  private tab: "contacts" | "notes" = "contacts";
  private notes: NotesPage;
  private nickOn = false;
  /** what the nick popup asks for: add (1811, the app) or find (the friend list, cmFind) */
  private nickMode: "add" | "find" = "add";
  private nickBox: HTMLInputElement | null = null;
  private repaints: (() => void)[] = [];

  static async create(ctx: PageCtx, addFriend: (nick: string) => void, inviteFriend: (nick: string) => void, openMenu: OpenMenu): Promise<CommunityPage> {
    const popRoot = await jsonOnce<{ root: GNode }>(`${BASE}/UI_Project_Popup.json`);
    return new CommunityPage(ctx, popRoot.root, addFriend, inviteFriend, openMenu);
  }

  private constructor(private ctx: PageCtx, root: GNode, private addFriend: (nick: string) => void, private inviteFriend: (nick: string) => void, private openMenu: OpenMenu) {
    const g = (this.gui = pageGui(ctx, TEXTS));
    buildWindows(g, ctx, root, [WINDOW, NICK_POPUP]);
    this.hideMatching(root);
    // the window root covers the design (pointer passes through in clan.ts); the page's own panels take the pointer
    const win = g.get(WINDOW)?.el;
    if (win) win.style.pointerEvents = "none";
    // cmLeave / the tabs / cmNoteChild are direct children of the window too: without auto the bottom Fechar never took a click
    for (const n of ["cmContactSect", "cmContactChild", "cmNoteSect", "cmNoteChild", "cmLeave", "cmContactTab", "cmNoteTab", "cmUserDetailInfoPopupMsg", NICK_POPUP]) { const el = g.get(n)?.el; if (el) el.style.pointerEvents = "auto"; }
    // cmContactList is the last child of cmContactListFrame, so its element lies over the rows and takes their clicks
    // (pick() never ran, the card and Aceitar / Recusar never showed). Its thumb and arrows keep pointer auto (scrollList)
    const list = g.get("cmContactList")?.el;
    if (list) list.style.pointerEvents = "none";
    this.notes = new NotesPage(ctx, g, (text, ok) => this.askNote(text, ok));
    this.wire();
    friendList.subscribe(() => this.ctx.ctl.draw());
  }

  /** mbCommunity: opens the window (the close buttons shut it) */
  openWindow(): void {
    this.opened = true;
    this.draw();
  }

  /** the window is up: the mbCommunity blink only starts with it shut (app.ts startCommunityAlarm) */
  get isOpen(): boolean { return this.opened; }

  /** Hides the HIDDEN controls. A hidden control that still holds a used control (the confirm popup cmUserDetailInfoPopupMsg
   * inside cmUserDetailInfoPopup, the note rows cmNoteWho1.. inside cmNoteSlot1, the gift images inside cmNoteGiftItemFrame)
   * keeps its element and loses only its own art and text: hiding the element hid those children too, so Aceitar never asked
   * and the Msg. list stayed empty. Its pointer stays none (inherited from the window root) */
  private hideMatching(root: GNode): void {
    const f = locate(root, WINDOW);
    const hidden = (n: GNode) => HIDDEN.some((re) => re.test(n.name));
    const holdsUsed = (n: GNode): boolean => !!n.children?.some((c) => !hidden(c) || holdsUsed(c));
    const walk = (n: GNode) => {
      if (hidden(n)) {
        const el = this.gui.get(n.name)?.el;
        if (!holdsUsed(n)) this.gui.hide(n.name);
        else if (el) for (const ch of el.children) if (!(ch as HTMLElement).dataset.name) (ch as HTMLElement).style.display = "none";
      }
      n.children?.forEach(walk);
    };
    if (f) walk(f.node);
  }

  private str(key: string, fallback: string): string { return this.ctx.str(key, fallback); }
  private say(text: string): void { this.ctx.ctl.say(text, true); }
  private draw(): void { this.ctx.ctl.draw(); }

  private button(name: string, fn: () => void, on: () => boolean = () => true): void {
    this.repaints.push(this.gui.button(name, fn, on));
  }

  private wire(): void {
    const g = this.gui;
    // cmContactClose (0x882687 -> 0x885520) only clears CGameContext+0x66c8 and keeps the window: it shuts the friend card
    // (the selection) [INFERIDO: what +0x66c8 holds]
    this.button("cmContactClose", () => { this.sel = -1; this.draw(); });
    this.button("cmLeave", () => this.close());
    this.button("cmContactTab", () => this.showTab("contacts"));
    this.button("cmNoteTab", () => this.showTab("notes"));
    this.button("cmBlockTab", () => this.say(this.str("STR_POPUP_PREPARE_PLAN", "Opção desabilitada por enquanto ;)")));
    this.button("cmAdd", () => this.openNick("add"));
    this.button("cmFind", () => this.openNick("find"));
    this.button("cmInvite", () => this.invite());
    this.button("cmFriend", () => this.visit(), () => {
      const r = this.selected(), st = r ? crossState(r.f.status) : 0;
      return !!r && st >= CrossState.ONLINE && st <= CrossState.ROOM && this.ctx.ctl.page === "lobby";
    });
    this.button("cmProfile", () => this.profileAction());
    this.button("cmFriendRefuse", () => this.refuse(), () => { const r = this.selected(); return !!r && this.isReceived(r.f); });
    this.button("cmUserDetailInfoPopupMsgConfirm", () => void this.confirmMsg());
    this.button("cmUserDetailInfoPopupMsgCancel", () => { this.msg = null; this.noteAsk = null; this.draw(); });
    this.button("cmNicknameConfirm", () => this.confirmNick());
    this.button("cmNicknameCancel", () => { this.nickOn = false; this.draw(); });
    this.nickBox = g.edit("cmNicknameInput", { maxLength: 16, onEnter: () => this.confirmNick() });
    this.thumb = g.scrollList("cmContactList", (d) => this.scroll(d));
    g.get("cmContactListFrame")?.el.addEventListener("wheel", (e) => { e.preventDefault(); this.scroll(Math.sign(e.deltaY)); }, { passive: false });
    for (let i = 0; i < ROWS; i++) {
      onClick(g, `cmContactSlotNick${i + 1}`, () => this.pick(i));
      onClick(g, `cmContactSlotState${i + 1}`, () => this.pick(i));
      // clique direito no amigo abre o menu (0x886780, ver contextMenu.ts friendMenuItems)
      for (const name of [`cmContactSlotNick${i + 1}`, `cmContactSlotState${i + 1}`]) {
        g.get(name)?.el.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const row = this.rows()[this.top + i];
          if (row) this.openMenu(e, row.f, friendMenuItems(crossState(row.f.status), this.ctx.ctl.page === "lobby"));
        });
      }
    }
  }

  /** all the friends with their server index (the empty slots of the list are skipped, the indexes are kept) */
  private rows(): Row[] {
    const out: Row[] = [];
    friendList.list.forEach((f, idx) => { if (f) out.push({ f, idx }); });
    return out;
  }

  private selected(): Row | null { return this.rows().find((r) => r.idx === this.sel) ?? null; }
  private isReceived(f: Friend): boolean { return crossState(f.status) === CrossState.RECEIVED; }

  private scroll(d: number): void {
    this.top = Math.max(0, Math.min(Math.max(0, this.rows().length - ROWS), this.top + d));
    this.draw();
  }

  private pick(i: number): void {
    const row = this.rows()[this.top + i];
    if (!row) return;
    this.sel = row.idx;
    this.draw();
  }

  /** cmContactTab / cmNoteTab: switches the window's section (contacts or Msg.) */
  private showTab(tab: "contacts" | "notes"): void {
    this.tab = tab;
    this.msg = null;
    this.noteAsk = null;
    this.draw();
  }

  /** the Msg. tab asks through the window's confirm popup (cmUserDetailInfoPopupMsg) */
  private askNote(text: string, ok: () => void): void {
    this.noteAsk = { text, ok };
    this.draw();
  }

  private close(): void {
    this.opened = false;
    this.msg = null;
    this.noteAsk = null;
    this.nickOn = false;
    this.draw();
  }

  /** cmProfile (exe 0x8825ea): pedido recebido = Aceitar; outro estado = Excluir. Sem seleção o exe não faz nada. Os dois
   * pedem confirmação (cmUserDetailInfoPopupMsg); o servidor responde Aceitar com 1816 e Excluir com 1820 */
  private profileAction(): void {
    const r = this.selected();
    if (!r) return;
    this.msg = { kind: this.isReceived(r.f) ? "accept" : "delete", idx: r.idx, nick: r.f.nick };
    this.draw();
  }

  /** cmFriendRefuse (exe 0x886210): enabled only for a received request; asks, then 1820 (the exe's delete callback 0x8875f0) */
  private refuse(): void {
    const r = this.selected();
    if (!r) return;
    this.msg = { kind: "refuse", idx: r.idx, nick: r.f.nick };
    this.draw();
  }

  private async confirmMsg(): Promise<void> {
    if (this.noteAsk) { const a = this.noteAsk; this.noteAsk = null; a.ok(); return; }
    const m = this.msg;
    this.msg = null;
    if (!m) return this.draw();
    const conn = chat.connection;
    if (m.kind === "accept") {
      // Aceitar (1816, exe 0x8875c0 -> 0x78e760): the server answers 1815 Accept + Update, then the list follows
      const err = conn ? await acceptFriend(conn, m.idx) : 0x80000000;
      if (err) this.say(this.str("STR_TBL_GUI_BASE_FAIL_REQUEST_FRIEND", "Não conseguiu adicionar o amigo à lista."));
      return this.draw();
    }
    // Excluir / Recusar (1820, exe 0x8875f0 -> 0x78e7e0): the exe clears the card's selection after the request
    this.sel = -1;
    const err = conn ? await deleteFriend(conn, m.idx) : 0x80000000;
    if (err) this.say(this.str("STR_TBL_GUI_BASE_FAIL_DELETE_FRIEND", "Não foi possível excluir o amigo."));
    else if (m.kind === "delete") this.say(this.str("STR_TBL_GUI_BASE_NOTICE_DELETE_FRIEND_COMPLETE", "[%s] foi excluído da sua lista de amigos.").replace("%s", m.nick));
    this.draw();
  }

  /** Adicionar / Buscar: popup cmNicknameWin, 2 to 16 characters (STR_POPUP_MESSAGE_LIMITED_NAME_LENGTH); add = the app's 1811 */
  private openNick(mode: "add" | "find"): void {
    this.nickMode = mode;
    this.nickOn = true;
    if (this.nickBox) this.nickBox.value = "";
    this.draw();
  }

  private confirmNick(): void {
    const nick = (this.nickBox?.value ?? "").trim();
    const find = this.nickMode === "find";
    this.nickOn = false;
    if (!nick) this.say(this.str("STR_POPUP_MESSAGE_INPUT_NAME", "Digite o apelido."));
    else if (nick.length < 2 || nick.length > 16) this.say(this.str("STR_POPUP_MESSAGE_LIMITED_NAME_LENGTH", "O apelido deve ter de 2 até 16 caracteres."));
    else if (find) this.findFriend(nick);
    else this.addFriend(nick);
    this.draw();
  }

  /** Buscar (exe 0x88efb0, ordem na nota do topo): o próprio nick avisa; amigo exato seleciona a linha; nick da lobby (exato)
   * seleciona a linha da lobby (lobbyPick -> lbUserListSlotSelect); fora das duas listas, sem seleção, o nick vai ao servidor
   * (opcode 297). Miss: nenhum aviso, como no exe (o 297 não tem resposta no cliente, ver friendClient.ts). */
  findFriend(nick: string): void {
    if (nick === chat.myNick) return this.say(this.str("STR_POPUP_MESSAGE_INPUT_SELF", "Não é possível buscar você mesmo."));
    const rows = this.rows();
    const pos = rows.findIndex((r) => r.f.nick === nick);
    if (pos >= 0) {
      this.sel = rows[pos].idx;
      this.top = Math.max(0, Math.min(pos, rows.length - ROWS));
      return;
    }
    this.sel = -1;
    // lobby hit (exe 0x885840 + 0x8863c0 -> 0x885b70): the lobby row is picked, the list shows its band (app.ts paintLobby)
    const hit = (this.ctx.ctl.session?.lobby.playerList() ?? []).find((u) => u.nickname === nick);
    if (hit) { this.ctx.ctl.lobbyPick = hit.nickname; return; }
    // miss: the exe shows nothing here and sends the nick (297); the client has no reply handler for 0x129 (see friendClient.ts)
    if (chat.connection) sendFindLobby(chat.connection, nick);
  }

  /** Convidar (exe 0x884ae0 OnInviteRoom): só amigo no canal (estado 5, a lista do servidor) pode ser convidado para a sala
   * do dono; o convite vai pelo app (877 pelo session id do lobby, ver app.ts inviteFriend). Sala: "já está numa sala". */
  private invite(): void {
    const r = this.selected();
    if (!r) return this.say(this.str("STR_POPUP_MESSAGE_CHOOSE_FRIEND_TO_INVITE", "Escolha um amigo para convidar."));
    const top = crossState(r.f.status);
    if (top === CrossState.ROOM) return this.say(this.str("STR_POPUP_MESSAGE_FRIEND_IN_THE_ROOM", "O amigo já está em uma sala."));
    if (top !== CrossState.LOBBY) return this.say(this.str("STR_POPUP_MESSAGE_INVITE_ONLINE_FRIEND", "Convide apenas amigos online no canal."));
    this.inviteFriend(r.f.nick);
    this.draw();
  }

  /** Visitar (exe 0x884800 OnVisit -> 0x884c50): só amigo em sala (estado 6) pode ser visitado; o resto é o da entrada. */
  private visit(): void {
    const r = this.selected();
    if (!r) return this.say(this.str("STR_POPUP_PLEASE_MESSAGE_FRIEND_TO_VISIT", "Selecione o amigo que deseja visitar."));
    if (crossState(r.f.status) !== CrossState.ROOM) return this.say(this.str("STR_POPUP_MESSAGE_FRIEND_IN_THE_ROOM", "O amigo deve estar na mesma sala."));
    this.ctx.ctl.visitRoom(r.f.status);
    this.draw();
  }

  /** state text of a friend (Cross exe 0x881bc0, see friendClient.ts CrossState). Channel = 10 * servidor + canal + 1 [INFERIDO
   * the order of the two numbers in "Sala %d-%d"]; room = sala + 1. Estado fora da tabela: sem texto. */
  private stateText(f: Friend): string {
    const st = crossState(f.status), chan = 10 * ((f.status >>> 20) & 0xff) + ((f.status >>> 12) & 0xff) + 1, room = (f.status & 0xfff) + 1;
    switch (st) {
      case CrossState.SENT:
      case CrossState.RECEIVED: return this.str("STR_POPUP_SECRET", "Privado");
      case CrossState.OFFLINE: return this.str("STR_POPUP_OFFLINE_STATE", "Offline");
      case CrossState.ONLINE: return this.str("STR_POPUP_READY_STATE", "Aguardando");
      case CrossState.LOBBY: return this.str("STR_POPUP_WHAT_POSITION_LOBBY", "%d-Lobby").replace("%d", String(chan));
      case CrossState.ROOM: return this.str("STR_POPUP_WHAT_POSITION", "Sala %d-%d").replace("%d", String(chan)).replace("%d", String(room));
      default: return "";
    }
  }

  paint(): void {
    const g = this.gui;
    g.show(WINDOW, this.opened);
    if (!this.opened) return;
    const rows = this.rows();
    this.top = Math.min(this.top, Math.max(0, rows.length - ROWS));
    for (let i = 0; i < ROWS; i++) {
      const r = rows[this.top + i];
      g.show(`cmContactSlotNick${i + 1}`, !!r);
      g.show(`cmContactSlotState${i + 1}`, !!r);
      // cmContactSlotMark = the friend's rank (Rank static, SetRankImage 0x801aa0, same cell as the lobby list); empty rows hide it
      // (it kept its default skull art on every row before)
      g.show(`cmContactSlotMark${i + 1}`, !!r);
      if (r) paintShapeIndex(g, `cmContactSlotMark${i + 1}`, r.f.rank, LEVEL_ICON.cell, LEVEL_ICON.tex);
      if (r) { g.setText(`cmContactSlotNick${i + 1}`, r.f.nick); g.setText(`cmContactSlotState${i + 1}`, this.stateText(r.f)); }
    }
    // highlight: screen row k sits at y = 30 * (k + 1) in cmContactListFrame (the slot separators are at 60 + 30k)
    const si = rows.findIndex((r) => r.idx === this.sel), hi = si - this.top;
    const hl = si >= 0 && hi >= 0 && hi < ROWS;
    g.show("cmContactSelect", hl);
    if (hl) { const el = g.get("cmContactSelect")?.el; if (el) el.style.top = `${ROW_H * (hi + 1)}px`; }
    this.thumb(this.top, rows.length, ROWS);
    const sel = si >= 0 ? rows[si] : null;
    g.show("cmContactSect", this.tab === "contacts");
    g.show("cmNoteSect", this.tab === "notes");
    this.notes.paint(this.tab === "notes");
    g.show("cmContactChild", this.tab === "contacts" && !!sel);
    if (sel) {
      // _UpdateContactChild 0x88cc80: cmProfile = Aceitar só no pedido recebido, Excluir nos outros estados
      const recv = this.isReceived(sel.f);
      g.setText("cmNicknameValue", sel.f.nick);
      g.setText("cmPositionValue", this.stateText(sel.f));
      g.setText("cmProfile", recv ? this.str("STR_POPUP_ACCEPT_FRIEND", "Aceitar amigo") : this.str("STR_POPUP_DELETE_FRIEND", "Excluir"));
    }
    g.show("cmUserDetailInfoPopupMsg", !!this.msg || !!this.noteAsk);
    if (this.noteAsk) g.setText("cmUserDetailInfoPopupMsgMessage", this.noteAsk.text);
    else if (this.msg) {
      const m = this.msg;
      const text = m.kind === "accept" ? this.str("STR_POPUP_Q_MESSAGE_ACCEPT_TO_FRINED", "Deseja aceitar o pedido de amizade do usuário [%s]?")
        : m.kind === "refuse" ? this.str("STR_POPUP_MESSAGE_REFUSE_FRIEND", "Deseja recusar o pedido de amizade do usuário [%s]?")
        : this.str("STR_POPUP_MESSAGE_DELETE_FRIEND", "Deseja excluir o amigo [%s]?");
      g.setText("cmUserDetailInfoPopupMsgMessage", text.replace("%s", m.nick));
    }
    if (this.nickOn) {
      const find = this.nickMode === "find";
      g.setText("cmNicknameCaption", find ? this.str("STR_POPUP_FIND_USER", "Buscar usuário") : this.str("STR_POPUP_ADD_FRIEND", "Adicionar"));
      g.setText("cmNicknameMessage", find ? this.str("STR_POPUP_MESSAGE_FINDING_NAME", "Digite o apelido do usuário \npara buscar na lista de amigos.")
        : this.str("STR_POPUP_MESSAGE_INPUT_FRIEND_NAME", "Digite o apelido do usuário \npara adicionar na lista de amigos."));
    }
    g.show(NICK_POPUP, this.nickOn);
    for (const fn of this.repaints) fn();
  }
}
