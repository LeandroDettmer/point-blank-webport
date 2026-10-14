// Clan battle in the Cross clan window: the Batalha tab (clanBattlePhase of UI_Project_Clan.json, the MakeTeam list) and the
// battle lobby step (ClanBattleLobby: my team, the team list, my clan). Every action is a ClanWarClient request
//. The team list (6917) has no clan name, leader nick or clan rank per
// row, so those cells stay empty [LACUNA]. The battle lobby is the battle tab's second state: it shows while the viewer has a team.
// Pairing (6930 push): the server seats both teams in the battle room and sends each seat its join ACK (3586); the controller's
// adoptClanRoom opens that room (the Cross room page), the same screen as a joined room.
import { ClanWarClient, ClanWarErr, type ClanWarEvent, type TeamInfo, type TeamRoster } from "../../../net/clanWarClient.ts";
import type { ClanDetail } from "../../../net/clanClient.ts";
import type { GNode, I3Gui } from "../../ui/i3Gui.ts";
import { buildWindows, nickCss, onClick, pageGui, type PageCtx, type Texts } from "./common.ts";

/** MakeTeam rows (clanBattlePhase, 6 slots) and team list rows (7). The MakeTeam pitch is [INFERIDO]: the six rows are authored at
 *  one place inside a 437 px list, so each row is moved down by one pitch (6 x 72 fits). */
const MAKE_ROWS = 6, MAKE_PITCH = 72, LIST_ROWS = 7, SEATS = 8;
/** team list row height: the Bg columns are 27 px apart, the first at y 27 */
const LIST_PITCH = 27;
/** CHANGE_OPERATION cuts at 64; the team chat is 60 (2384 type 7) */
const NAME_MAX = 64, CHAT_MAX = 60;

const MAKE_SHOWN = ["Name", "State", "MatchType", "MatchMember", "Join"];
const MAKE_HIDDEN = ["Locale", "LeaderValue", "LeaderRank", "LeaderNick"];
/** team state text: MatchState 1 Ready, 2 Play (Invisible is not listed) [INFERIDO: the state strings are the room's own] */
const TEAM_STATE: Record<number, [string, string]> = {
  1: ["STR_POPUP_READY_STATE", "Aguardando"],
  2: ["STBL_IDX_ROOM_STATE_PLAY", "Jogando"],
};
/** the errors the server sends (ClanWarErr) and the text per request; anything else takes the request's fallback */
const ERR_TEXT: Record<number, [string, string]> = {
  [ClanWarErr.NOT_IN_CLAN]: ["STBL_IDX_CLAN_BATTLE_CANNOT_FIND", "Não é possível identificar o Clã."],
  [ClanWarErr.ALREADY_IN_TEAM]: ["STBL_IDX_CLAN_BATTLE_ALREADY_TEAM", "Já está cadastrado em um time."],
  [ClanWarErr.NO_MATCH_ID]: ["STBL_IDX_CLAN_BATTLE_FULL_TEAM", "Servidor está cheio. Não é possível registrar mais times."],
  [ClanWarErr.NO_SQUAD]: ["STBL_IDX_CLAN_BATTLE_FULL_TEAM", "Servidor está cheio. Não é possível registrar mais times."],
  [ClanWarErr.NOT_LEADER]: ["STBL_IDX_CLAN_BATTLE_ONLY_LEADER", "Apenas o Líder pode realizar o pedido."],
  [ClanWarErr.NOT_READY]: ["STBL_IDX_CLAN_BATTLE_CANNOT_CHANGE", "Não é possível alterar a formação do Clã."],
  [ClanWarErr.NOT_FULL]: ["STBL_IDX_CLAN_BATTLE_NEED_TO_MEMBER", "Não há número de jogadores suficiente para começar o jogo."],
};
const FALLBACK: Record<string, [string, string]> = {
  create: ["STBL_IDX_CLAN_BATTLE_FAILED_TEAM", "Não conseguiu cadastrar o time por erro de conexão."],
  join: ["STBL_IDX_CLAN_BATTLE_FAILED_JOIN", "Não conseguiu participar no time por erro de conexão."],
  leave: ["STBL_IDX_CLAN_BATTLE_FAIL_OUT_TEAM", "Não conseguiu sair por erro de conexão."],
  operation: ["STBL_IDX_CLAN_BATTLE_CANNOT_CHANGE", "Não é possível alterar a formação do Clã."],
  maxPer: ["STBL_IDX_CLAN_BATTLE_CANNOT_ORGANIZE_TEAM", "Não é possível alterar o número de jogadores no time."],
  matchmake: ["STBL_IDX_CLAN_BATTLE_FAILED_MATCH", "Falhou na partida do clã."],
  cancel: ["STBL_IDX_CLAN_BATTLE_FAILED_MATCH", "Falhou na partida do clã."],
};

/** Texts of the clan window's battle controls (merged into clan.ts TEXTS) */
export const BATTLE_TEXTS: Texts = {
  clanBattleMakeTeamStatic: ["STBL_IDX_CLAN_BATTLE_TEAM_ORGANIZATION_COLON", "Organização:"],
  clanBattleMakeTeamEntryButton: ["STBL_IDX_CLAN_CREATE_TEAM", "Registrar"],
  ...Object.fromEntries(Array.from({ length: MAKE_ROWS }, (_, i) => [`clanBattleMakeTeamJoin${i + 1}`, ["STBL_IDX_CLAN_JOIN_TEAM", "Participar"] as [string, string]])),
};

/** Texts of the battle lobby (ClanBattleLobby) */
const LOBBY_TEXTS: Texts = {
  clanBattleLobbyMyTeamWinCaption: ["STBL_IDX_CLAN_MY_CLAN_TEAM_LIST", "Lista da equipe"],
  clanBattleLobbyMyTeamClanNameStatic: ["STBL_IDX_CLAN_NAME", "Nome do clã :"],
  clanBattleLobbyMyTeamClanRankStatic: ["STBL_IDX_CLAN_RANK", "Classe :"],
  clanBattleLobbyMyTeamClanPointStatic: ["STBL_IDX_CLAN_POINT", "Pts. de Clã :"],
  clanBattleLobbyMyTeamTypeStatic: ["STBL_IDX_CLAN_BATTLE_TEAM_ORGANIZATION", "Formação do time"],
  clanBattleLobbyTeamListCaption: ["STBL_IDX_CLAN_BATTLE_LIST", "Lista de batalhas dos clãs"],
  clanBattleLobbyTeamListHeadSlotNum: ["STBL_IDX_CLAN_BATTLE_HEADER_NUMBER", "N°"],
  clanBattleLobbyTeamListHeadClanRank: ["STBL_IDX_CLAN_BATTLE_HEADER_RANK", "Nível"],
  clanBattleLobbyTeamListHeadClanName: ["STBL_IDX_CLAN_BATTLE_HEADER_NAME", "Nome do clã"],
  clanBattleLobbyTeamListHeadTeam: ["STBL_IDX_CLAN_BATTLE_HEADER_TEAM", "Time"],
  clanBattleLobbyTeamListHeadType: ["STBL_IDX_CLAN_BATTLE_HEADER_ORGANIZATION", "Membros"],
  clanBattleLobbyTeamListHeadState: ["STBL_IDX_CLAN_BATTLE_HEADER_STATE", "Status"],
  clanBattleLobbyTeamListSearchStatic: ["STBL_IDX_CLAN_BATTLE_SEARCHING", "Procurar clã"],
  clanBattleLobbyTeamListInfoStatic: ["STBL_IDX_CLAN_BATTLE_TEAM_INFO", "Informações do time"],
  clanBattleLobbyTeamListViewAll: ["STBL_IDX_CLAN_VIEW_ALL", "Ver todos"],
  clanBattleLobbyClanInfoTeamLeaderStatic: ["STBL_IDX_CLAN_BATTLE_TEAM_LEADER", "Líder do time:"],
  clanBattleLobbyClanInfoNameStatic: ["STBL_IDX_CLAN_NAME", "Nome do clã :"],
  clanBattleLobbyClanInfoMasterStatic: ["STBL_IDX_CLAN_MASTER", "Líder"],
  clanBattleLobbyClanInfoRankStatic: ["STBL_IDX_CLAN_RANK", "Classe :"],
  clanBattleLobbyClanInfoStaffStatic: ["STBL_IDX_CLAN_PERSON", "Membros :"],
  clanBattleLobbyClanInfoAddressStatic: ["STBL_IDX_CLAN_AZIT", "Fórum :"],
  clanBattleLobbyClanInfoOrderStatic: ["STBL_IDX_CLAN_ORDER", "Nível :"],
  clanBattleLobbyClanInfoExpStatic: ["STBL_IDX_CLAN_EXP", "Experiência:"],
  ...Object.fromEntries(Array.from({ length: LIST_ROWS }, (_, i) => [`clanBattleLobbyTeamMatchButton${i + 1}`, ["STBL_IDX_CLAN_JOIN_TEAM", "Participar"] as [string, string]])),
};

const versus = (n: number): string => `${n}vs${n}`;

export class ClanBattle {
  private lobby: I3Gui;
  private conn: unknown = null;
  private client: ClanWarClient | null = null;
  private off: (() => void) | null = null;
  private repaints: (() => void)[] = [];
  private teams: TeamInfo[] = [];
  private makeTop = 0;
  private listTop = 0;
  private selected = -1;
  private search = "";
  /** the team the viewer is in (roster 6921), null when none; `myMatchId` is set as soon as a create / join is acknowledged */
  private team: TeamRoster | null = null;
  private myMatchId: number | null = null;
  private queued = false;
  private operation = "";
  private chat: string[] = [];
  /** organization picked for the next CREATE_TEAM (capacity 1..8) */
  private capacity = 1;
  private drop: "make" | "type" | null = null;
  private chatArea: HTMLTextAreaElement | null = null;
  private nameBox: HTMLInputElement | null = null;
  private busy = false;

  constructor(private ctx: PageCtx, private phase: I3Gui, root: GNode, private detailOf: () => ClanDetail | null) {
    this.lobby = pageGui(ctx, LOBBY_TEXTS);
    buildWindows(this.lobby, ctx, root, ["ClanBattleLobby"]);
    // the step covers the whole design: it passes the pointer through, its windows take it (pointer-events is inherited)
    this.lobby.get("ClanBattleLobby")!.el.style.pointerEvents = "none";
    for (const w of ["clanBattleLobbyMyTeamWin", "clanBattleLobbyTeamListWin"]) this.lobby.get(w)!.el.style.pointerEvents = "auto";
    this.placeRows();
    this.wire();
  }

  /** the MakeTeam rows share one place in the file: row i moves down by (i - 1) pitches */
  private placeRows(): void {
    for (let i = 1; i <= MAKE_ROWS; i++) {
      for (const k of [...MAKE_SHOWN, ...MAKE_HIDDEN]) {
        const b = this.phase.get(`clanBattleMakeTeam${k}${i}`);
        if (b) b.el.style.top = `${b.node.y + (i - 1) * MAKE_PITCH}px`;
      }
    }
  }

  private button(gui: I3Gui, name: string, fn: () => void, on: () => boolean = () => true): void {
    this.repaints.push(gui.button(name, fn, on));
  }

  private wire(): void {
    const p = this.phase, l = this.lobby;
    // the Batalha tab: create a team with the picked organization, join a listed team
    this.button(p, "clanBattleMakeTeamEntryButton", () => void this.create(), () => !this.myMatchId);
    for (let i = 1; i <= MAKE_ROWS; i++) {
      this.button(p, `clanBattleMakeTeamJoin${i}`, () => void this.join(this.teams[this.makeTop + i - 1]?.matchId ?? -1), () => !this.myMatchId && !!this.teams[this.makeTop + i - 1]);
    }
    this.button(p, "clanBattleMakeTeamComboButton", () => this.toggleDrop("make"), () => !this.myMatchId);
    p.get("clanBattleMakeTeamScrollList")?.el.addEventListener("wheel", (e) => { e.preventDefault(); this.scrollMake(Math.sign(e.deltaY)); }, { passive: false });
    // the battle lobby: my team (organization, name, chat, leave), the team list (search, view all, match) and my clan
    this.button(l, "clanBattleLobbyMyTeamTypeComboButton", () => this.toggleDrop("type"), () => this.isLeader() && !this.queued);
    this.button(l, "clanBattleLobbyTeamListViewAll", () => void this.refreshList());
    this.button(l, "clanBattleLobbyTeamListQuickButton", () => void this.quick(), () => this.queued || (this.isLeader() && this.teamFull()));
    this.button(l, "clanBattleLobbyTeamListLeaveButton", () => this.askLeave(), () => !!this.myMatchId);
    this.button(l, "clanBattleLobbyTeamListSearchButton", () => this.draw());
    for (let i = 1; i <= LIST_ROWS; i++) {
      this.button(l, `clanBattleLobbyTeamMatchButton${i}`, () => void this.join(this.rowTeam(i)?.matchId ?? -1), () => !this.myMatchId && !!this.rowTeam(i));
      onClick(l, `clanBattleLobbyTeamFilter${i}`, () => { this.selected = this.listTop + i - 1; this.draw(); });
    }
    l.get("clanBattleLobbyTeamListFrame")?.el.addEventListener("wheel", (e) => { e.preventDefault(); this.scrollList(Math.sign(e.deltaY)); }, { passive: false });
    this.nameBox = l.edit("clanBattleLobbyMyTeamName", { maxLength: NAME_MAX, onEnter: (v) => void this.setOperation(v) });
    l.edit("clanBattleLobbyTeamListSearchEdit", { onInput: (v) => { this.search = v; this.listTop = 0; this.draw(); } });
    const chatBox = l.edit("clanBattleLobbyMyTeamChatBox", { maxLength: CHAT_MAX, onEnter: (v) => { this.sendChat(v); if (chatBox) chatBox.value = ""; } });
    this.chatArea = this.area(l, "clanBattleLobbyMyTeamChatTextBox");
    // the team chat tabs / language / combo have no data on the web [PENDENTE]: hidden
    for (const n of ["clanBattleLobbyMyTeamChatTab1", "clanBattleLobbyMyTeamChatTab2", "clanBattleLobbyMyTeamChatTab3", "clanBattleLobbyMyTeamChatTab4",
      "clanBattleLobbyMyTeamChatCombo", "clanBattleLobbyMyTeamChatButton", "clanBattleLobbyMyTeamChatLang"]) l.show(n, false);
  }

  /** a multi-line read-only box over a control (the chat log) */
  private area(gui: I3Gui, name: string): HTMLTextAreaElement | null {
    const b = gui.get(name);
    if (!b) return null;
    const t = document.createElement("textarea");
    t.readOnly = true;
    t.style.cssText = `position:absolute;left:3px;top:2px;width:${b.node.w - 6}px;height:${b.node.h - 4}px;box-sizing:border-box;padding:0;border:0;outline:0;resize:none;background:transparent;font:inherit;color:#e4e4e4;`;
    t.addEventListener("click", (e) => e.stopPropagation());
    b.el.appendChild(t);
    return t;
  }

  private str(key: string, fallback: string): string { return this.ctx.str(key, fallback); }
  private say(text: string): void { this.ctx.ctl.say(text, true); }
  private draw(): void { this.ctx.ctl.draw(); }
  private failText(op: keyof typeof FALLBACK, err: number): string {
    const [k, f] = ERR_TEXT[err] ?? FALLBACK[op];
    return this.str(k, f);
  }
  private teamName(squad: number): string {
    const naming = this.str(`STBL_IDX_CLAN_BATTLE_TEAM_NAMING_${squad}`, `${squad}`);
    return this.str("STBL_IDX_CLAN_BATTLE_TEAM_WITHOUT_NUM", "Time %s").replace("%s", naming);
  }
  private stateText(state: number): string { const t = TEAM_STATE[state]; return t ? this.str(...t) : ""; }

  /** the client on the live Game connection (one per connection; its pushes arrive at any time) */
  private api(): ClanWarClient | null {
    const conn = this.ctx.ctl.session?.connection ?? null;
    if (!conn || !conn.isOpen) return null;
    if (conn !== this.conn) {
      this.off?.(); this.client?.dispose();
      this.conn = conn;
      this.client = new ClanWarClient(conn);
      this.off = this.client.on((ev) => this.onPush(ev));
      this.dropTeam();
    }
    return this.client;
  }

  /** the Batalha tab opened: the list of the channel's teams */
  enter(): void { void this.refreshList(); }

  /** clan lost / left: the team is gone on the server too (the clan rules drop it) */
  reset(): void { this.dropTeam(); this.teams = []; this.selected = -1; this.queued = false; }

  inLobby(): boolean { return this.myMatchId !== null; }

  isLeader(): boolean { return !!this.team && this.team.leader === this.team.localSeat; }
  private teamFull(): boolean { return !!this.team && this.team.count === this.team.capacity; }
  private rowTeam(i: number): TeamInfo | undefined {
    const rows = this.filtered();
    return rows[this.listTop + i - 1];
  }
  private filtered(): TeamInfo[] {
    const q = this.search.trim().toLowerCase();
    if (!q) return this.teams;
    return this.teams.filter((t) => this.teamName(t.squad).toLowerCase().includes(q));
  }

  private dropTeam(): void {
    this.team = null; this.myMatchId = null; this.queued = false; this.operation = ""; this.chat = [];
  }

  /** pushes: my roster (6921), the operation (6925), the max per (6927), the team chat (6929), the pairing (6930) */
  private onPush(ev: ClanWarEvent): void {
    switch (ev.type) {
      case "roster":
        if (ev.roster.localSeat === null) { if (ev.roster.matchId === this.myMatchId) this.dropTeam(); }
        else { this.team = ev.roster; this.myMatchId = ev.roster.matchId; }
        break;
      case "operation": this.operation = ev.text; break;
      case "max-per": if (this.team) this.team = { ...this.team, capacity: ev.max }; break;
      case "team-chat": this.chat.push(`${ev.msg.nick}: ${ev.msg.text}`); if (this.chat.length > 200) this.chat.shift(); break;
      // paired: the team is no longer queued; the room opens from its own ACK (see the file header)
      case "match-info": this.queued = false; void this.ctx.ctl.adoptClanRoom(); break;
    }
    this.draw();
  }

  private async refreshList(): Promise<void> {
    const c = this.api();
    if (!c) return;
    const r = await c.list();
    if (r.ok && r.data) { this.teams = r.data.teams; this.listTop = Math.max(0, Math.min(this.listTop, this.teams.length - LIST_ROWS)); }
    else console.warn("[cross] clan battle list", r.err);
    this.draw();
  }

  private async create(): Promise<void> {
    const c = this.api();
    if (!c || this.busy) return;
    this.busy = true;
    try {
      const r = await c.create(this.capacity);
      if (!r.ok || !r.data) { this.say(this.failText("create", r.err)); return; }
      // the roster follows as a 6921 push (the server sends it to the creator)
      this.myMatchId = r.data.matchId;
      await this.refreshList();
    } catch (e) { console.warn("[cross] clan battle create", e); this.say(this.failText("create", 0)); }
    finally { this.busy = false; this.draw(); }
  }

  private async join(matchId: number): Promise<void> {
    const c = this.api();
    if (!c || this.busy || matchId < 0) return;
    this.busy = true;
    try {
      const r = await c.join(matchId);
      if (!r.ok || !r.data) { this.say(this.failText("join", r.err)); return; }
      this.team = r.data; this.myMatchId = r.data.matchId;
      await this.refreshList();
    } catch (e) { console.warn("[cross] clan battle join", e); this.say(this.failText("join", 0)); }
    finally { this.busy = false; this.draw(); }
  }

  private askLeave(): void {
    this.ctx.ctl.msg = { text: this.str("STBL_IDX_CLAN_BATTLE_LEAVE_Q", "Caso saia, não será possível participar do time novamente. Tem certeza que deseja sair?"), onOk: () => void this.leave(), onCancel: () => {} };
    this.draw();
  }

  /** 6922: the team is dropped at once when the server acknowledges; the lobby step closes behind it */
  private async leave(): Promise<void> {
    const c = this.api();
    if (!c || this.busy) return;
    this.busy = true;
    try {
      const r = await c.leave();
      if (r.ok) { this.dropTeam(); await this.refreshList(); }
      else this.say(this.failText("leave", r.err));
    } catch (e) { console.warn("[cross] clan battle leave", e); this.say(this.failText("leave", 0)); }
    finally { this.busy = false; this.draw(); }
  }

  /** 6924: leader only; the name is the team's operation text */
  private async setOperation(text: string): Promise<void> {
    const c = this.api();
    if (!c || !this.team) return;
    if (!this.isLeader()) { this.say(this.str("STBL_IDX_CLAN_BATTLE_MODIFY_ONLY_LEADER", "Apenas o Líder pode alterar.")); return; }
    const r = await c.setOperation(text);
    if (r.ok && r.data !== undefined) this.operation = r.data;
    else this.say(this.failText("operation", r.err));
    this.draw();
  }

  /** 6926: leader only, team READY and not queued; the server answers the value it kept */
  private async setMaxPer(max: number): Promise<void> {
    const c = this.api();
    if (!c || !this.team) return;
    if (!this.isLeader()) { this.say(this.str("STBL_IDX_CLAN_BATTLE_MODIFY_ONLY_LEADER", "Apenas o Líder pode alterar.")); return; }
    const r = await c.setMaxPer(max);
    if (r.ok && r.data !== undefined && this.team) this.team = { ...this.team, capacity: r.data };
    else this.say(this.failText("maxPer", r.err));
    this.draw();
  }

  /** 2384 type 7: the echo comes as a 6929 push to every seat */
  private sendChat(text: string): void {
    const c = this.api();
    const t = text.trim().slice(0, CHAT_MAX);
    if (!c || !this.team || !t) return;
    c.teamChat(t);
  }

  /** Quick: the leader asks a match for the full team (6932); asked again it cancels (6934) */
  private async quick(): Promise<void> {
    const c = this.api();
    if (!c || this.busy) return;
    this.busy = true;
    try {
      if (this.queued) {
        const r = await c.cancelMatchmaking();
        if (r.ok) this.queued = false; else this.say(this.failText("cancel", r.err));
      } else {
        const r = await c.matchmake();
        if (r.ok) { this.queued = true; this.say("Aguardando partida do clã."); } else this.say(this.failText("matchmake", r.err));
      }
    } catch (e) { console.warn("[cross] clan battle match", e); this.say(this.failText("matchmake", 0)); }
    finally { this.busy = false; this.draw(); }
  }

  private toggleDrop(which: "make" | "type"): void {
    this.drop = this.drop === which ? null : which;
    this.draw();
  }

  private scrollMake(d: number): void {
    const max = Math.max(0, this.teams.length - MAKE_ROWS);
    this.makeTop = Math.max(0, Math.min(max, this.makeTop + d));
    this.draw();
  }

  private scrollList(d: number): void {
    const max = Math.max(0, this.filtered().length - LIST_ROWS);
    this.listTop = Math.max(0, Math.min(max, this.listTop + d));
    this.draw();
  }

  /** a list popup under its combo: rebuilt on paint, a pick runs and closes it */
  private paintDrop(gui: I3Gui, popup: string, on: boolean, items: [string, () => void][]): void {
    gui.show(popup, on);
    const box = gui.get(popup);
    if (!box) return;
    const el = box.el;
    el.innerHTML = "";
    if (!on) return;
    el.style.height = `${items.length * 22 + 4}px`;
    el.style.zIndex = "5";
    for (const [label, fn] of items) {
      const row = document.createElement("div");
      row.textContent = label;
      row.style.cssText = "position:relative;height:22px;line-height:22px;padding:0 6px;color:#fff;font:12px Arial,sans-serif;background:#1d2a3a;cursor:pointer;white-space:nowrap;";
      row.addEventListener("click", (e) => { e.stopPropagation(); this.drop = null; fn(); this.draw(); });
      el.appendChild(row);
    }
  }

  private organizations(pick: (n: number) => void): [string, () => void][] {
    return Array.from({ length: 8 }, (_, i) => [versus(i + 1), () => pick(i + 1)]);
  }

  /** the Batalha tab (clan window): the team list in six rows and the organization combo */
  paintPhase(): void {
    const p = this.phase;
    p.setText("clanBattleMakeTeamCombo", versus(this.capacity));
    this.paintDrop(p, "clanBattleMakeTeamComboPopup", this.drop === "make", this.organizations((n) => { this.capacity = n; }));
    for (const r of this.repaints) r();
    const max = Math.max(0, this.teams.length - MAKE_ROWS);
    this.makeTop = Math.min(this.makeTop, max);
    for (let i = 1; i <= MAKE_ROWS; i++) {
      const t = this.teams[this.makeTop + i - 1];
      for (const k of MAKE_SHOWN) p.show(`clanBattleMakeTeam${k}${i}`, !!t);
      for (const k of MAKE_HIDDEN) p.show(`clanBattleMakeTeam${k}${i}`, false);
      if (!t) continue;
      p.setText(`clanBattleMakeTeamName${i}`, this.teamName(t.squad));
      p.setText(`clanBattleMakeTeamState${i}`, this.stateText(t.state));
      p.setText(`clanBattleMakeTeamMatchType${i}`, versus(t.capacity));
      p.setText(`clanBattleMakeTeamMatchMember${i}`, `${t.count}/${t.capacity}`);
    }
  }

  /** the battle lobby step (ClanBattleLobby): shown by the clan page when the battle tab has a team */
  paintLobby(on: boolean): void {
    this.lobby.show("ClanBattleLobby", on);
    if (!on) return;
    for (const r of this.repaints) r();
    const l = this.lobby, r = this.team, d = this.detailOf(), leader = this.isLeader();
    // my team
    const cap = r?.capacity ?? this.capacity;
    l.setText("clanBattleLobbyMyTeamTypeCombo", r ? versus(cap) : "");
    l.show("clanBattleLobbyMyTeamTypeStatic", true);
    this.paintDrop(l, "clanBattleLobbyMyTeamTypeComboPopup", this.drop === "type", this.organizations((n) => void this.setMaxPer(n)));
    if (this.nameBox) {
      this.nameBox.readOnly = !leader;
      if (document.activeElement !== this.nameBox) this.nameBox.value = this.operation;
    }
    for (let s = 0; s < SEATS; s++) {
      const m = r?.members.find((x) => x.seat === s);
      const i = s + 1;
      l.show(`clanBattleLobbyMyTeamMemberRank${i}`, false);
      l.show(`clanBattleLobbyMyTeamMemberState${i}`, false);
      l.show(`clanBattleLobbyMyTeamMemberNick${i}`, !!m);
      l.show(`clanBattleLobbyMyTeamMemberLeader${i}`, !!m && r?.leader === s);
      l.setText(`clanBattleLobbyMyTeamMemberNick${i}`, m?.nick ?? "");
    }
    const text = this.chat.join("\n");
    if (this.chatArea && this.chatArea.value !== text) { this.chatArea.value = text; this.chatArea.scrollTop = this.chatArea.scrollHeight; }
    const chatBox = l.get("clanBattleLobbyMyTeamChatBox")?.el.querySelector("input");
    if (chatBox) chatBox.disabled = !r;
    // team list
    const rows = this.filtered();
    this.listTop = Math.max(0, Math.min(this.listTop, rows.length - LIST_ROWS));
    for (let i = 1; i <= LIST_ROWS; i++) {
      const t = rows[this.listTop + i - 1];
      l.show(`clanBattleLobbyTeamSlotNum${i}`, !!t);
      l.show(`clanBattleLobbyTeamName${i}`, !!t);
      l.show(`clanBattleLobbyTeamType${i}`, !!t);
      l.show(`clanBattleLobbyTeamState${i}`, !!t);
      l.show(`clanBattleLobbyTeamMatchButton${i}`, !!t);
      // the clan's name / rank and the team's mark are not in 6917 [LACUNA]
      l.setText(`clanBattleLobbyTeamClanName${i}`, "");
      l.setText(`clanBattleLobbyTeamSlotNum${i}`, t ? `${this.listTop + i}` : "");
      l.setText(`clanBattleLobbyTeamName${i}`, t ? this.teamName(t.squad) : "");
      l.setText(`clanBattleLobbyTeamType${i}`, t ? versus(t.capacity) : "");
      l.setText(`clanBattleLobbyTeamState${i}`, t ? this.stateText(t.state) : "");
    }
    const sel = this.selected - this.listTop;
    const selOn = sel >= 0 && sel < LIST_ROWS;
    l.show("clanBattleLobbyTeamListSelect", selOn);
    if (selOn) l.get("clanBattleLobbyTeamListSelect")!.el.style.top = `${(sel + 1) * LIST_PITCH}px`;
    // my clan (the team's clan is my clan: the server lists the teams of my clan's channel)
    l.setText("clanBattleLobbyMyTeamClanNameValue", d?.name ?? "");
    // 0x86db5c: 0x4ad850(MyTeamClanNameValue, my clan name +0x18, clan name colour +0x2d)
    l.setColor("clanBattleLobbyMyTeamClanNameValue", nickCss(d?.nameColor));
    l.setText("clanBattleLobbyMyTeamClanRankValue", d ? `${d.unit}` : "");
    l.setText("clanBattleLobbyMyTeamClanPointValue", d ? `${d.points}` : "");
    l.setText("clanBattleLobbyClanInfoTeamLeaderValue", r ? r.members.find((x) => x.seat === r.leader)?.nick ?? "" : "");
    l.setText("clanBattleLobbyClanInfoNameValue", d?.name ?? "");
    // 0x86ee0c: 0x4ad850(ClanInfoNameValue, name +4, clan name colour +0x20)
    l.setColor("clanBattleLobbyClanInfoNameValue", nickCss(d?.nameColor));
    l.setText("clanBattleLobbyClanInfoMasterValue", d?.ownerNick ?? "");
    l.setText("clanBattleLobbyClanInfoRankValue", d ? `${d.unit}` : "");
    l.setText("clanBattleLobbyClanInfoStaffValue", d ? `${d.members}/${d.maxPlayers}` : "");
    l.setText("clanBattleLobbyClanInfoOrderValue", d ? `${d.rank}` : "");
    l.setText("clanBattleLobbyClanInfoExpValue", d ? `${d.exp}` : "");
    l.setText("clanBattleLobbyClanInfoAddressValue", "");
  }
}
