// Aba Msg. (recados) da janela Comunidade do Cross. cmNoteTab (handler 0x884550: esconde cmContactSect, mostra cmNoteSect)
// fica em community.ts; esta classe cuida do que está dentro de cmNoteSect / cmNoteChild (UI_Project_Popup.json).
// Lista: cmNoteList com linhas cmNoteWho / cmNoteContent / cmNoteDate / cmNoteCheck n (n = 1..10), realce cmNoteSelect.
// A ordem é a do exe: a linha 0 é o recado mais novo (CPopupCommunity refresh 0x887690: linha i = índice N-1-(topo+i)).
// Ler (clique na linha) marca como lida, mas só nos tipos 0, 1, 3 e 4 (0x91e860, tabela de tipos): 1926 e dias = 7.
// Escrever (cmNoteWrite, handler 0x886d80) abre o cartão com destinatário e texto editáveis e Enviar manda 1921 pelo nick
// (SetEvent 101 em 0x886ec0). Ler mostra o texto; Responder (cmNoteSend) abre o cartão de resposta e Enviar manda 1930 pelo
// uid do remetente (_FindNoteByUid 0x815467, SetEvent 102).
// Excluir (cmNoteDelete) pede confirmação na popup cmUserDetailInfoPopupMsg (STR_POPUP_Q_MESSAGE_DELETE_NOTE) e, no OK, o
// batch de 0x886b60 (SetEvent 104 -> 1928): as caixas marcadas mais o selecionado, sem recado de presente (tipo 2).
// Convite de clã (nota ClanAsk): Aceitar / Recusar (cmNoteAccept / cmNoteReject, handler 0x887340, o mesmo de 0x91ea10) mandam
// 890 (ClanClient.inviteAccept) e em seguida 1926 (SetEvent 103, dias = 7). A nota NÃO é apagada: fica lida até o jogador
// excluir. Os botões somem porque o convite deixa de estar não lido (state 0) [INFERIDO: o exe não mostra o motivo].
// Textos: os STR_ são do exe (cross strings.json); os fallbacks marcados [INFERIDO] não têm chave confirmada.
// [LACUNA] "Nova mensagem" (STR_POPUP_RECEIVE_NOTE) só aparece na tabela do popup opCommunity (0x878113), que o Cross deixa como
// "em construção" (opCommunityNoteButton). O aviso de recado novo no Cross não foi achado; cmNoteGage / cmNoteGageBg (barra de
// capacidade, texto não decodificado) ficam escondidos. Presente (tipo 2, cmNoteGift*): card com a imagem e o nome do item,
// Aceitar = popup 0x2a (askTake, Ok = 1056 via takeGift). Não lê ao clicar (readsOnPick) e não tem Responder nem Excluir.
import { chat } from "../../../net/chatClient.ts";
import { acceptGift } from "../../../net/metaGame.ts";
import { NoteErr, NoteState, NoteType, READ_DAYS, answerClanNote, deleteNotes, giftGoodsId, isClanAsk, newestFirst, noteList, readNotes, readsOnPick, replyNote, sendNote, type Note } from "../../../net/noteClient.ts";
import { ItemClass, itemClass } from "../../state/itemInfo.ts";
import { itemName } from "../../state/itemNames.ts";
import type { I3Gui } from "../../ui/i3Gui.ts";
import { onClick, setIcon, type PageCtx, type Texts } from "./common.ts";

const ROWS = 10;
/** cmNoteSlot separators sit at y 51 and 75 (24 px rows) in UI_Project_Popup.json; the highlight's first row starts at 27 [INFERIDO] */
const ROW_PITCH = 24;
const ROW_TOP = 27;
/** limit of the message text: the exe copies cmNoteValue into a 241-byte buffer (0xf1, 0x886ec0 / 0x8871ca): 240 characters + NUL */
const NOTE_MAX = 240;
/** cmNoteFocus / cmNoteSel / cmNoteSlot / cmNoteGift... have no web equivalent here: hidden, never placeholders */
export const NOTE_HIDDEN = [/^cmNoteGift/, /^cmNoteSel\d+$/, /^cmNoteSlot\d+$/, /^cmNoteFocus$/, /^cmNoteKey$/, /^cmNoteGage/, /^cmNoteSeparate/];

export const NOTE_TEXTS: Texts = {
  cmNoteListTab: ["STR_POPUP_NOTE", "Msg."],
  cmNoteListWho: ["STR_POPUP_SENDER_1", "Remetente"],
  cmNoteListContent: ["STR_POPUP_CONTENT", "Conteúdo"],
  cmNoteListDate: ["STR_POPUP_REMAIN_DAY", "Dias restantes"],
  cmNoteWrite: ["STR_POPUP_WRITE_NOTE", "Escrever"],
  cmNoteSend: ["STR_POPUP_SEND", "Enviar"],
  cmNoteClose: ["STR_POPUP_CLOSE", "Fechar"],
  cmNoteAccept: ["STR_POPUP_ACCEPT", "Aceitar"],
  cmNoteReject: ["STR_POPUP_REFUSE", "Recusar"],
};

type Card = "read" | "write" | "reply";

export class NotesPage {
  /** id of the selected note, -1 none */
  private sel = -1;
  private top = 0;
  /** ids of the notes whose cmNoteCheck box is set (the exe keeps one flag per list index, CPopupCommunity +0x3ac) */
  private checked = new Set<number>();
  /** the message card: read a note, write a new one, or reply to the selected one; null = closed */
  private card: Card | null = null;
  private who: HTMLInputElement | null;
  private body: HTMLTextAreaElement | null = null;
  private readText: HTMLElement | null = null;
  private thumb: (top: number, total: number, visible: number) => void = () => {};
  private repaints: (() => void)[] = [];

  /** `ask` = the window's confirm popup (cmUserDetailInfoPopupMsg, community.ts) */
  constructor(private ctx: PageCtx, private g: I3Gui, private ask: (text: string, ok: () => void) => void) {
    this.who = g.edit("cmNoteWhoValue", { maxLength: 16 });
    const box = g.get("cmNoteValue")?.el;
    if (box) {
      // the i3Gui font of the edit fields (Arial 10 pt, i3Gui.ts nodeFont): font:inherit fell back to the page serif
      const font = this.who?.style.font || "inherit";
      const t = document.createElement("textarea");
      t.maxLength = NOTE_MAX;
      t.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;box-sizing:border-box;padding:2px;resize:none;border:0;outline:0;background:transparent;display:none;color:#ffffff;";
      t.style.font = font;
      t.addEventListener("click", (e) => e.stopPropagation());
      box.appendChild(t);
      this.body = t;
      const r = document.createElement("div");
      r.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;padding:2px;white-space:pre-line;overflow:hidden;display:none;color:#ffffff;"; // same look as the write box: without a color it inherited black on the dark frame (the text was there, unreadable)
      r.style.font = font;
      box.appendChild(r);
      this.readText = r;
    }
    const w = g.get("cmNoteChild")?.el; if (w) w.style.pointerEvents = "auto";
    const s = g.get("cmNoteSect")?.el; if (s) s.style.pointerEvents = "auto";
    // cmNoteList is the last child of cmNoteListFrame: its element lies over the rows, so it takes no clicks (scrollList keeps its thumb)
    const list = g.get("cmNoteList")?.el; if (list) list.style.pointerEvents = "none";
    this.wire();
    noteList.subscribe(() => this.ctx.ctl.draw());
  }

  private str(key: string, fallback: string): string { return this.ctx.str(key, fallback); }
  private say(text: string): void { this.ctx.ctl.say(text, true); }
  private draw(): void { this.ctx.ctl.draw(); }

  private button(name: string, fn: () => void, on: () => boolean = () => true): void {
    this.repaints.push(this.g.button(name, fn, on));
  }

  private wire(): void {
    const g = this.g;
    this.button("cmNoteWrite", () => this.openWrite());
    this.button("cmNoteDelete", () => this.askDelete(), () => this.deleteIds().length > 0);
    this.button("cmNoteClose", () => this.closeCard());
    this.button("cmNoteSend", () => (this.card === "read" ? this.openReply() : void this.send()), () => this.card !== null);
    this.button("cmNoteAccept", () => void this.accept(), () => this.clanAsk() !== null || this.giftSel() !== null);
    this.button("cmNoteReject", () => void this.answerClan(false), () => this.clanAsk() !== null);
    this.thumb = g.scrollList("cmNoteList", (d) => this.scroll(d));
    g.get("cmNoteListFrame")?.el.addEventListener("wheel", (e) => { e.preventDefault(); this.scroll(Math.sign(e.deltaY)); }, { passive: false });
    for (let i = 0; i < ROWS; i++) {
      onClick(g, `cmNoteWho${i + 1}`, () => this.pick(i));
      onClick(g, `cmNoteContent${i + 1}`, () => this.pick(i));
      onClick(g, `cmNoteDate${i + 1}`, () => this.pick(i));
      onClick(g, `cmNoteCheck${i + 1}`, () => this.toggle(i));
    }
  }

  /** the list as the exe shows it: newest first */
  private rows(): Note[] { return newestFirst(noteList.list); }
  private selected(): Note | null { return noteList.list.find((n) => n.id === this.sel) ?? null; }
  /** the selected note when it is a clan invite not answered yet (Aceitar / Recusar), else null */
  private clanAsk(): Note | null { const n = this.selected(); return n && this.card === "read" && isClanAsk(n.type) && n.state === NoteState.UNREAD ? n : null; }
  /** the selected gift note (type 2) with its Aceitar button: takes the item (takeGift) */
  private giftSel(): Note | null { const n = this.selected(); return n && this.card === "read" && n.type === NoteType.GIFT ? n : null; }

  /** Aceitar: a gift opens its receive popup (askTake), a clan invite is answered */
  private accept(): void | Promise<void> {
    const gift = this.giftSel();
    if (gift) return this.askTake(gift);
    return this.answerClan(true);
  }

  private scroll(d: number): void {
    this.top = Math.max(0, Math.min(Math.max(0, this.rows().length - ROWS), this.top + d));
    this.draw();
  }

  /** a row was clicked: select it; an unread note is marked read on the server (1926) when the exe reads that type */
  private pick(i: number): void {
    const n = this.rows()[this.top + i];
    if (!n) return;
    this.sel = n.id;
    this.card = "read";
    if (n.state === NoteState.UNREAD && readsOnPick(n.type)) {
      const conn = chat.connection;
      if (conn) { readNotes(conn, [n.id]); noteList.mark([n.id], NoteState.READ, READ_DAYS); }
    }
    this.draw();
  }

  /** cmNoteCheck box of row i: toggles the note's flag for the batch delete */
  private toggle(i: number): void {
    const n = this.rows()[this.top + i];
    if (!n) return;
    if (this.checked.has(n.id)) this.checked.delete(n.id); else this.checked.add(n.id);
    this.draw();
  }

  private openWrite(): void {
    this.card = "write";
    this.sel = -1;
    this.clearBody();
    this.draw();
  }

  private openReply(): void {
    const n = this.selected();
    if (!n || isClanAsk(n.type) || n.type === NoteType.CLAN || n.type === NoteType.GIFT) return;
    this.card = "reply";
    this.clearBody();
    this.draw();
  }

  private clearBody(): void { if (this.body) this.body.value = ""; }

  private closeCard(): void {
    this.card = null;
    this.draw();
  }

  /** Enviar: 1921 by nick (write) or 1930 by uid (reply). The exe checks the text first, then the receiver */
  private async send(): Promise<void> {
    const conn = chat.connection;
    if (!conn) return;
    const text = (this.body?.value ?? "").trim();
    if (!text) { this.say(this.str("STR_POPUP_INPUT_NOTE", "Digite o conteúdo da mensagem.")); return; }
    let err: number;
    if (this.card === "reply") {
      const n = this.selected();
      if (!n) return;
      err = await replyNote(conn, n.senderId, text);
    } else {
      const nick = (this.who?.value ?? "").trim();
      if (!nick) { this.say(this.str("STR_POPUP_MESSAGE_INPUT_RECEIVER", "Digite o nick do destinatário.")); return; }
      if (nick === chat.myNick) { this.say(this.str("STR_POPUP_MESSAGE_SEND_SELF", "Não é possível enviar mensagem para você mesmo.")); return; }
      err = await sendNote(conn, nick, text);
    }
    if (err === 0) { this.card = null; this.draw(); return; }
    if (err === NoteErr.FULL) this.say(this.str("STR_POPUP_MESSAGE_DELETE_FULL_NOTE", "Caixa de entrada lotada.\nTente excluir as mensagens desnecessárias \npara poder receber novas mensagens."));
    else this.say(this.str("STR_TBL_GUI_BASE_FAIL_SEND_NOTE", "Não conseguiu enviar mensagem."));
    this.draw();
  }

  /**
   * Ids of the batch delete (exe 0x886b60): every checked note, then the selected one when it is not checked. Gift notes
   * (type 2) are left out. Empty = the button is off and nothing is sent.
   */
  private deleteIds(): number[] {
    const ids = this.rows().filter((n) => this.checked.has(n.id)).map((n) => n.id);
    const s = this.selected();
    if (s && !ids.includes(s.id)) ids.push(s.id);
    return ids.filter((id) => noteList.list.find((n) => n.id === id)?.type !== NoteType.GIFT);
  }

  /** Excluir: asks first (STR_POPUP_Q_MESSAGE_DELETE_NOTE), then 1928 for the batch */
  private askDelete(): void {
    const ids = this.deleteIds();
    if (!ids.length) return;
    this.ask(this.str("STR_POPUP_Q_MESSAGE_DELETE_NOTE", "Deseja excluir a mensagem selecionada?"), () => void this.doDelete(ids));
  }

  private async doDelete(ids: number[]): Promise<void> {
    const conn = chat.connection;
    const err = conn ? await deleteNotes(conn, ids) : NoteErr.FAIL;
    if (err) this.say(this.str("STR_TBL_GUI_BASE_FAIL_DELETE_NOTE", "Não foi possível excluir a mensagem."));
    else { noteList.remove(ids); this.checked.clear(); this.sel = -1; this.card = null; }
    this.draw();
  }

  /** Aceitar / Recusar a clan invite: 890, then 1926 (answerClanNote). The note stays, read, until it is deleted. */
  private async answerClan(accept: boolean): Promise<void> {
    const n = this.clanAsk();
    const conn = chat.connection;
    if (!n || !conn) return;
    const r = await answerClanNote(conn, n, accept);
    noteList.mark([n.id], NoteState.READ, READ_DAYS);
    if (!r.ok) this.say(this.str("STR_TBL_GUI_BASE_FAIL_JOIN_CLAN", "Não foi possível entrar no clã."));
    this.draw();
  }

  private contentText(n: Note): string {
    if (n.type === NoteType.GIFT) return itemName(giftGoodsId(n)).name;
    return isClanAsk(n.type) ? this.str("STR_POPUP_CLAN_INVITE_NOTE", "Convite para o clã") : n.text;
  }

  /**
   * Aceitar on a gift opens popup 0x2a: the exe's UIPopupReceiveMail::ReceivePresent (0x91e900, reached from the note click at 0x91e3xx
   * for type 2 notes) asserts `pInfo->_ui32GoodsID != 0` and SetEvent(0x2a) opens the popup. [RECRIADO] the question text: no exe
   * key found for it, so the fallback is used. Ok = takeGift.
   */
  private askTake(n: Note): void {
    const c = this.ctx.ctl;
    c.msg = { text: "Deseja receber o presente?", onOk: () => void this.takeGift(n), onCancel: () => {} };
    this.draw();
  }

  /**
   * Ok of popup 0x2a: 1056 -> 1057 (the item comes to the inventory, the note is deleted by the server). Not answered = the note stays.
   * The 1057 result (exe 0x91e7xx): success = STR_SHOP_INFORM_SUCCESS_GIFT, failure = STR_SHOP_FAILED_GIFT (both referenced there).
   * [INFERIDO] the 1056 sender of popup 0x2a is not tied by a caller (0xa11490 is reached only through a vtable).
   */
  private async takeGift(n: Note): Promise<void> {
    const conn = chat.connection;
    if (!conn) return;
    const code = await acceptGift(conn, n.id);
    if (code === 1) {
      noteList.remove([n.id]);
      this.sel = -1;
      this.card = null;
      this.say(this.str("STR_SHOP_INFORM_SUCCESS_GIFT", "O presente foi enviado ao seu inventário."));
    } else this.say(this.str("STR_SHOP_FAILED_GIFT", "Falha na inserção de presente no inventário por problemas de rede."));
    this.draw();
  }

  /**
   * Gift card (type 2): the item frame with the item's image and name. _SetGiftNote (exe 0x8885d0) fills Value1 with the default
   * STR_POPUP_UNKNOWN_GIFT ("Presente não identificado") and the item name [INFERIDO]. The image branch reads [ebp-0x420] (1 / 2 / other,
   * not decoded): the weapon / character / other split here is [INFERIDO]. 0x68aea0 is NOT the image selector: it is the Perido / Count
   * classifier (0 = MAINTENANCE_GIFT_NAME "prazo de uso: %d dias", 1 = EXPENDABLES_GIFT_NAME "número usado: %d", call at 0x8888c9).
   * Value2 (days / count) has no decoded source here and stays hidden.
   */
  private paintGift(n: Note | null): void {
    const g = this.g, id = n ? giftGoodsId(n) : 0, cls = itemClass(id);
    const img = cls >= ItemClass.Primary && cls <= ItemClass.Special ? "cmNoteGiftWeaponImage" : cls === ItemClass.Character ? "cmNoteGiftCharacterImage" : "cmNoteGiftCashItemImage";
    g.show("cmNoteGiftItemFrame", !!n);
    for (const k of ["cmNoteGiftWeaponImage", "cmNoteGiftCharacterImage", "cmNoteGiftCashItemImage"]) g.show(k, !!n && k === img);
    if (n) setIcon(g, img, id);
    g.show("cmNoteGiftValue1", !!n);
    g.setText("cmNoteGiftValue1", n ? itemName(id).name : "");
  }

  /** the rows of cmNoteList and the message card; called by community.ts while the Msg. tab is open */
  paint(open: boolean): void {
    const g = this.g;
    const list = this.rows();
    this.top = Math.min(this.top, Math.max(0, list.length - ROWS));
    for (let i = 0; i < ROWS; i++) {
      const n = list[this.top + i];
      for (const name of [`cmNoteWho${i + 1}`, `cmNoteContent${i + 1}`, `cmNoteDate${i + 1}`, `cmNoteCheck${i + 1}`]) g.show(name, open && !!n);
      if (open && n) {
        g.setText(`cmNoteWho${i + 1}`, n.sender);
        g.setText(`cmNoteContent${i + 1}`, this.contentText(n));
        g.setText(`cmNoteDate${i + 1}`, String(n.days));
        g.paintCheck(`cmNoteCheck${i + 1}`, this.checked.has(n.id));
      }
    }
    const si = list.findIndex((n) => n.id === this.sel), hi = si - this.top;
    const hl = open && si >= 0 && hi >= 0 && hi < ROWS;
    g.show("cmNoteSelect", hl);
    if (hl) { const el = g.get("cmNoteSelect")?.el; if (el) el.style.top = `${ROW_TOP + ROW_PITCH * hi}px`; }
    this.thumb(this.top, list.length, ROWS);

    const showCard = open && this.card !== null;
    g.show("cmNoteChild", showCard);
    if (showCard) this.paintCard(this.selected());
    for (const fn of this.repaints) fn();
  }

  private paintCard(n: Note | null): void {
    const g = this.g, card = this.card!;
    const writing = card === "write" || card === "reply";
    const clan = !!n && (n.type === NoteType.CLAN || isClanAsk(n.type));
    // receiver field: typed when writing, the sender's nick when reading or replying
    if (this.who) { this.who.readOnly = card !== "write"; if (card !== "write") this.who.value = n?.sender ?? ""; }
    g.setText("cmNoteWhoKey", card === "write" ? this.str("STR_POPUP_RECEIVER", "Para:") : clan ? this.str("STR_POPUP_CLAN_SENDER", "Clã") : this.str("STR_POPUP_SENDER_2", "Remetente"));
    if (this.body) this.body.style.display = writing ? "block" : "none";
    const gift = card === "read" && !!n && n.type === NoteType.GIFT;
    this.paintGift(gift ? n : null);
    if (this.readText) {
      this.readText.style.display = writing ? "none" : "block";
      this.readText.textContent = n && !writing && !gift ? this.contentText(n) : "";
    }
    g.show("cmNoteAccept", !!this.clanAsk() || !!this.giftSel());
    g.show("cmNoteReject", !!this.clanAsk());
    g.setText("cmNoteSend", card === "read" ? this.str("STR_POPUP_REPLY", "Responder") : this.str("STR_POPUP_SEND", "Enviar"));
    g.show("cmNoteSend", !clan && !gift);
  }
}
