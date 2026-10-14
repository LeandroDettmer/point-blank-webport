// In-battle moderation popups: report a player, start a vote kick, start a leader vote, send a bug report.
//   report   3852 condition -> 3850 report (net/chatClient.ts), optionally followed by 5190 (vote kick)
//   vote     5190 start a vote kick (net/voteClient.ts)
//   leader   9010 start a leader vote (web-only; no pick = the best ping, target 255)
//   bug      9001 (net/bugReport.ts)
// [RECRIADO] layout: the original scenes (BattlePopup_UserReport / _UserBanVote) are a fixed 16-radio grid with Korean captions and
// clipped texts, unusable in practice, so these are plain DOM dialogs in the game's palette (navy panels, blue buttons as the ESC menu,
// orange section labels as the scenes). Behaviour, protocol and texts that exist in the client (STR_POPUP_FORCIBLYREMOVE_*) are kept.
// The pointer is freed while one is open (Game checks `isOpen` so the ESC menu does not open for it); closing asks for the lock back.
import { lockPointer } from "../lockPointer.ts";
import { loadStrings, tOr } from "../lobby/ui/i18n.ts";
import { ERR_REPORT_NO_TICKET, ERR_REPORT_RANK, type ChatClient } from "../net/chatClient.ts";
import { KickReason, type VoteClient } from "../net/voteClient.ts";
import { FONTS, UI_BASE } from "../lobby/ui/assets.ts";
import type { Input } from "./input.ts";

/** `rank` = patente (the GM panel draws its icon next to the nick) */
export interface PlayerRef { slot: number; nick: string; rank?: number }

const CSS = `
.pbm-ov{position:fixed;inset:0;z-index:56;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);
  font:13px ${FONTS.popup};color:#e9edf5;user-select:none}
.pbm{width:min(480px,94vw);max-height:92vh;display:flex;flex-direction:column;background:linear-gradient(#0d1424,#0a0f1c);
  border:1px solid #1f6fbf;box-shadow:0 10px 40px rgba(0,0,0,.7)}
.pbm-h{display:flex;align-items:center;justify-content:space-between;padding:0 8px 0 16px;height:38px;flex:none;
  background:linear-gradient(#323a57,#1c2338);border-bottom:1px solid #0b0f1a;font-size:15px;font-weight:bold;text-shadow:1px 1px 0 rgba(0,0,0,.7)}
.pbm-x{width:26px;height:26px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#aeb7cc;font-size:18px;line-height:1}
.pbm-x:hover{color:#fff;background:rgba(255,255,255,.1)}
.pbm-b{padding:14px 16px 6px;overflow:auto;display:flex;flex-direction:column;gap:14px}
.pbm-sec{display:flex;flex-direction:column;gap:7px}
.pbm-l{display:flex;align-items:center;gap:7px;color:#f0932b;font-size:12px;font-weight:bold}
.pbm-l:before{content:"";width:8px;height:8px;background:#1a6fd0;flex:none}
.pbm-l small{margin-left:auto;color:#7f8aa3;font-weight:normal}
.pbm-list{display:grid;grid-template-columns:1fr 1fr;gap:6px;max-height:210px;overflow:auto;padding:2px}
.pbm-p{display:flex;align-items:center;gap:8px;height:32px;padding:0 10px;cursor:pointer;background:#131b2e;border:1px solid #232d47;
  min-width:0;box-sizing:border-box}
.pbm-p:hover{background:#1a2640;border-color:#2f4a7d}
.pbm-p.on{background:linear-gradient(#2d8be0,#0f64b5);border-color:#6fb4f5;color:#fff}
.pbm-p i{width:4px;height:16px;flex:none;background:var(--tc,#888)}
.pbm-p span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pbm-p.wide{grid-column:1/-1}
.pbm-seg{display:flex;gap:6px}
.pbm-seg .pbm-p{flex:1;justify-content:center}
.pbm-in{width:100%;box-sizing:border-box;background:#070b14;border:1px solid #26314d;color:#fff;padding:7px 9px;outline:0;
  font:13px ${FONTS.popup};user-select:text}
.pbm-in:focus{border-color:#3d86d6}
textarea.pbm-in{resize:none;height:170px;line-height:1.4}
.pbm-chk{display:flex;align-items:center;gap:9px;cursor:pointer}
.pbm-chk b{width:16px;height:16px;border:1px solid #3a4a72;background:#070b14;display:flex;align-items:center;justify-content:center;color:transparent;font-size:12px}
.pbm-chk.on b{background:#1a6fd0;border-color:#6fb4f5;color:#fff}
.pbm-n{color:#8c97b0;font-size:11px;line-height:1.45;font-weight:normal}
.pbm-s{min-height:16px;font-size:12px;color:#ff8f7a}
.pbm-s.ok{color:#8be08b}
.pbm-f{display:flex;gap:10px;justify-content:center;padding:10px 16px 16px;flex:none}
.pbm-btn{min-width:130px;height:34px;padding:0 16px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#fff;font-weight:bold;
  font-size:13px;text-shadow:1px 1px 0 rgba(0,0,0,.6);border:1px solid #0a0f1a;background:linear-gradient(#52b6ff,#0c66b5)}
.pbm-btn:hover{background:linear-gradient(#6ec0ff,#1b78cc)}
.pbm-btn.sec{background:linear-gradient(#3b4259,#232a3e)}
.pbm-btn.sec:hover{background:linear-gradient(#4a5270,#2b334b)}
.pbm-btn.off{opacity:.45;cursor:not-allowed;filter:grayscale(.6)}
`;

let cssDone = false;
function injectCss(): void {
  if (cssDone) return;
  cssDone = true;
  const s = document.createElement("style");
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** Patente cell of the Cross client (SetRankImage 0x801aa0, screensCross/crossMap.ts LEVEL_ICON): 24 px cells, 10 per row, rank = cell index */
const RANK_CELL = 24, RANK_PER_ROW = 10;

/** a 20x20 box showing the patente icon (player chips of the moderation / GM popups): cell `rank` of Cross interface_level_icon */
export function rankIcon(rank: number): HTMLElement {
  const box = el("div");
  const x = (rank % RANK_PER_ROW) * RANK_CELL, y = Math.floor(rank / RANK_PER_ROW) * RANK_CELL;
  box.style.cssText = `width:20px;height:20px;flex:none;position:relative;background:url(${UI_BASE}/cross/atlas/interface_level_icon.png) -${x}px -${y}px no-repeat`;
  box.title = `Patente ${rank}`;
  return box;
}

/** FR (slot parity 0) / CT (parity 1) marker colours, as the scoreboard digits */
const teamColor = (slot: number) => (slot % 2 === 0 ? "rgb(255,120,100)" : "rgb(110,180,255)");

/** Shared shell: overlay, panel, header, Escape, pointer handling. Content is built with textContent only. */
export abstract class Modal {
  protected ov: HTMLElement;
  protected body = el("div", "pbm-b");
  protected foot = el("div", "pbm-f");
  protected status = el("div", "pbm-s");
  private head = el("span");
  private openFlag = false;
  protected abort = new AbortController();

  constructor(host: HTMLElement, protected input: Input | null, title: string) {
    injectCss();
    this.ov = el("div", "pbm-ov");
    const panel = el("div", "pbm");
    const h = el("div", "pbm-h");
    this.head.textContent = title;
    const x = el("div", "pbm-x", "✕");
    x.addEventListener("click", () => this.close());
    h.append(this.head, x);
    panel.append(h, this.body, this.foot);
    this.ov.appendChild(panel);
    host.appendChild(this.ov);
    // clicks must not reach main.ts' body click (it would lock the pointer with the popup still open)
    this.ov.addEventListener("click", (e) => e.stopPropagation());
    this.ov.addEventListener("keydown", (e) => e.stopPropagation()); // typing must not reach the game keys
    window.addEventListener("keydown", (e) => {
      if (this.openFlag && e.code === "Escape") { e.preventDefault(); e.stopPropagation(); this.close(); }
    }, { signal: this.abort.signal, capture: true });
  }

  protected title(t: string): void { this.head.textContent = t; }

  protected section(label: string, ...children: (HTMLElement | null)[]): HTMLElement {
    const s = el("div", "pbm-sec");
    const l = el("div", "pbm-l");
    l.appendChild(el("span", "", label));
    s.appendChild(l);
    for (const c of children) if (c) s.appendChild(c);
    this.body.appendChild(s);
    return s;
  }

  protected button(label: string, secondary: boolean, onClick: () => void): HTMLElement {
    const b = el("div", `pbm-btn${secondary ? " sec" : ""}`, label);
    b.addEventListener("click", () => { if (!b.classList.contains("off")) onClick(); });
    this.foot.appendChild(b);
    return b;
  }

  protected say(text: string, ok = false): void {
    this.status.textContent = text;
    this.status.classList.toggle("ok", ok);
  }

  get isOpen(): boolean { return this.openFlag; }

  protected show(): void {
    this.openFlag = true;
    this.ov.style.display = "flex";
    this.input?.setChatOpen(true);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    this.ov.style.display = "none";
    this.input?.setChatOpen(false);
    try { void lockPointer(); } catch { /* no user gesture: the blocker click re-locks */ }
  }

  dispose(): void {
    this.abort.abort();
    if (this.openFlag) this.input?.setChatOpen(false);
    this.ov.remove();
  }
}

export interface ModerationDeps {
  host: HTMLElement;
  input: Input;
  roster: () => PlayerRef[];
  mySlot: () => number;
  chat: ChatClient;
  votes: () => VoteClient | null;
  /** a vote is already running (the server refuses a second one) */
  voteRunning: () => boolean;
  /** slot of the room leader (the leader vote cannot target it) */
  leaderSlot?: () => number;
}

export type ModerationMode = "report" | "vote" | "leader";

const DETAIL_MAX = 50;
/** server rules (server voteKick.ts KICK_MIN_HUMANS / voteLeader.ts LEADER_MIN_HUMANS): checked here too so the player is told before asking */
const KICK_MIN_HUMANS = 4, LEADER_MIN_HUMANS = 4;
const BEST_PING = -1;

/** Report a player ("report"), start a vote kick ("vote") or a leader vote ("leader", no pick = the best ping) */
export class ModerationPopup extends Modal {
  private pick = BEST_PING;
  private kind: 0 | 1 = 0; // 0 chat, 1 hack [INFERIDO]
  private alsoVote = false;
  private busy = false;
  private list = el("div", "pbm-list");
  private seg: HTMLElement[] = [];
  private detail: HTMLInputElement | null = null;
  private count = el("small");
  private chk: HTMLElement | null = null;
  private submitBtn!: HTMLElement;

  private constructor(private d: ModerationDeps, readonly mode: ModerationMode) {
    super(d.host, d.input, mode === "report" ? "Denunciar jogador" : mode === "vote" ? tOr("STR_POPUP_FORCIBLYREMOVE_TITLE", "Votação de expulsão") : "Votação de novo líder");
    const who = mode === "leader" ? "Novo líder" : "Jogador";
    this.section(who, this.list);
    if (mode === "leader") {
      const n = el("div", "pbm-n", `Sem escolher ninguém, o voto é para o jogador com melhor ping. Precisa de pelo menos ${LEADER_MIN_HUMANS} jogadores e maioria simples em 20 s.`);
      this.body.appendChild(n);
    } else {
      const seg = el("div", "pbm-seg");
      const mk = (label: string, k: 0 | 1) => {
        const b = el("div", "pbm-p", label);
        b.addEventListener("click", () => { this.kind = k; this.paintKind(); });
        this.seg.push(b);
        seg.appendChild(b);
      };
      mk("Chat / mau comportamento", 0);
      mk(tOr("STR_POPUP_FORCIBLYREMOVE_REASON_ILLEGALPROGRAM", "Uso de hack"), 1);
      this.section(tOr("STR_POPUP_FORCIBLYREMOVE_REASON_NOMANNER", "Motivo"), seg);
    }
    if (mode === "report") {
      this.detail = el("input", "pbm-in");
      this.detail.type = "text"; this.detail.maxLength = DETAIL_MAX; this.detail.autocomplete = "off"; this.detail.spellcheck = false;
      this.detail.placeholder = "Opcional: o que aconteceu";
      this.detail.addEventListener("input", () => { this.count.textContent = `${this.detail!.value.length}/${DETAIL_MAX}`; });
      this.detail.addEventListener("keydown", (e) => { if (e.key === "Enter") void this.submit(); });
      const s = this.section("Detalhe", this.detail);
      s.querySelector(".pbm-l")!.appendChild(this.count);
      const chk = this.chk = el("div", "pbm-chk");
      chk.append(el("b", "", "✓"), el("span", "", "Abrir também uma votação de expulsão"));
      chk.addEventListener("click", () => { this.alsoVote = !this.alsoVote; chk.classList.toggle("on", this.alsoVote); });
      this.body.appendChild(chk);
      this.body.appendChild(el("div", "pbm-n", "Em denúncia de chat, GMs online recebem as últimas mensagens da partida. Denúncia falsa ou sem motivo pode restringir quem denunciou."));
    }
    this.body.appendChild(this.status);
    this.submitBtn = this.button(mode === "report" ? "Denunciar" : "Iniciar votação", false, () => void this.submit());
    this.button(tOr("STR_TBL_BATTLEGUI_CANCEL_TEXT", "Cancelar"), true, () => this.close());
  }

  static async create(d: ModerationDeps, mode: ModerationMode): Promise<ModerationPopup> {
    await loadStrings().catch(() => {});
    return new ModerationPopup(d, mode);
  }

  /** opens the popup; `preselect` = slot to pick (a command named a nick) */
  open(preselect = -1): void {
    this.busy = false;
    this.alsoVote = false;
    this.chk?.classList.remove("on");
    this.kind = 0;
    this.paintKind();
    if (this.detail) { this.detail.value = ""; this.count.textContent = `0/${DETAIL_MAX}`; }
    this.say("");
    const me = this.d.mySlot(), lead = this.mode === "leader" ? this.d.leaderSlot?.() ?? -1 : -1;
    const roster = this.d.roster().filter((p) => p.slot !== me && p.slot !== lead && p.slot >= 0 && p.slot < 16).sort((a, b) => a.slot - b.slot);
    this.list.textContent = "";
    this.pick = this.mode === "leader" ? BEST_PING : -2;
    if (this.mode === "leader") this.list.appendChild(this.chip(BEST_PING, "Melhor ping (automático)", "#8be08b", true));
    for (const p of roster) this.list.appendChild(this.chip(p.slot, p.nick, teamColor(p.slot), false, p.rank));
    if (!roster.length && this.mode !== "leader") this.list.appendChild(el("div", "pbm-n wide", "Nenhum outro jogador na partida."));
    if (preselect >= 0 && roster.some((p) => p.slot === preselect)) this.choose(preselect);
    else if (this.mode !== "leader" && roster.length === 1) this.choose(roster[0].slot);
    else this.paintPick();
    this.show();
    if (this.mode === "report") void this.checkTickets();
  }

  private chip(slot: number, label: string, color: string, wide: boolean, rank?: number): HTMLElement {
    const c = el("div", `pbm-p${wide ? " wide" : ""}`);
    c.dataset.slot = String(slot);
    c.style.setProperty("--tc", color);
    c.append(el("i"));
    if (rank !== undefined && rank >= 0) c.appendChild(rankIcon(rank));
    c.append(el("span", "", label));
    c.title = label;
    c.addEventListener("click", () => this.choose(slot));
    return c;
  }

  private choose(slot: number): void { this.pick = slot; this.paintPick(); }

  private paintPick(): void {
    for (const c of Array.from(this.list.children) as HTMLElement[]) c.classList.toggle("on", c.dataset.slot === String(this.pick));
    this.submitBtn.classList.toggle("off", this.mode !== "leader" && this.pick < 0);
    if (this.mode !== "leader" && this.pick < 0 && !this.status.textContent) this.say("Escolha o jogador.");
    else if (this.pick >= 0 && this.status.textContent === "Escolha o jogador.") this.say("");
  }

  private paintKind(): void {
    this.seg.forEach((b, i) => b.classList.toggle("on", i === this.kind));
  }

  /** 3852: the server says whether this account may report (tickets, rank) */
  private async checkTickets(): Promise<void> {
    try {
      const c = await this.d.chat.reportCondition();
      if (!this.isOpen) return;
      if (!c.canReport) { this.say(errText(c.err)); this.submitBtn.classList.add("off"); }
    } catch { this.say("Sem resposta do servidor."); }
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    if (this.mode === "leader") return this.submitLeader();
    const target = this.d.roster().find((p) => p.slot === this.pick);
    if (!target) { this.say("Escolha o jogador."); return; }
    if (this.mode === "vote") {
      if (!this.enoughHumans(KICK_MIN_HUMANS)) { this.say(`Votação de expulsão precisa de pelo menos ${KICK_MIN_HUMANS} jogadores humanos na partida.`); return; }
      this.startVote(target.slot); this.close(); return;
    }
    this.busy = true;
    this.say("Enviando…", true);
    try {
      const err = await this.d.chat.report(target.nick, this.kind, this.detail?.value ?? "");
      if (err !== 0) { this.say(errText(err)); this.busy = false; return; }
      if (this.alsoVote) {
        if (this.enoughHumans(KICK_MIN_HUMANS)) this.startVote(target.slot);
        else this.d.chat.system(`Votação de expulsão não aberta: precisa de pelo menos ${KICK_MIN_HUMANS} jogadores humanos na partida.`);
      }
      this.d.chat.system(`Denúncia enviada: ${target.nick}.`);
      this.busy = false;
      this.close();
    } catch { this.say("Sem resposta do servidor."); this.busy = false; }
  }

  private enoughHumans(n: number): boolean { return this.d.roster().length >= n; }

  private submitLeader(): void {
    if (!this.enoughHumans(LEADER_MIN_HUMANS)) { this.say(`Votação de líder precisa de pelo menos ${LEADER_MIN_HUMANS} jogadores humanos na partida.`); return; }
    if (this.d.voteRunning()) { this.say(tOr("STR_ACK_FORCIBLYREMOVE_START_FAIL_ALREADY", "Outra votação já está em andamento.")); return; }
    try { this.d.votes()?.startLeader(this.pick >= 0 ? this.pick : 255); } catch (e) { console.warn("[vote] start leader", e); }
    this.close();
  }

  private startVote(slot: number): void {
    if (this.d.voteRunning()) { this.d.chat.system(tOr("STR_ACK_FORCIBLYREMOVE_START_FAIL_ALREADY", "Outra votação já está em andamento.")); return; }
    try { this.d.votes()?.startKick(slot, this.kind === 1 ? KickReason.HACK : KickReason.CHAT); } catch (e) { console.warn("[vote] start", e); }
  }
}

function errText(err: number): string {
  if (err === ERR_REPORT_NO_TICKET) return "Você não tem denúncias disponíveis.";
  if (err === ERR_REPORT_RANK) return "Patente baixa demais para denunciar.";
  return "Não foi possível enviar a denúncia.";
}

// ---- bug report ----------------------------------------------------------------------------------------------------------

const BUG_MAX = 1000;

export interface BugDeps {
  host: HTMLElement;
  /** null in the lobby (no game input to release) */
  input: Input | null;
  /** net/bugReport.ts sendBugReport: resolves a short message for the player */
  send: (text: string) => Promise<string>;
}

export class BugPopup extends Modal {
  private area = el("textarea", "pbm-in");
  private count = el("small");
  private busy = false;
  private sendBtn!: HTMLElement;

  private constructor(private d: BugDeps) {
    super(d.host, d.input, "Reportar bug");
    this.area.maxLength = BUG_MAX;
    this.area.spellcheck = false;
    this.area.placeholder = "O que aconteceu e como repetir?";
    this.area.addEventListener("input", () => { this.count.textContent = `${this.area.value.length}/${BUG_MAX}`; this.sendBtn.classList.toggle("off", !this.area.value.trim()); });
    const s = this.section("Descrição", this.area);
    s.querySelector(".pbm-l")!.appendChild(this.count);
    this.body.appendChild(el("div", "pbm-n", "O relatório leva automaticamente sua versão, navegador, FPS, ping, mapa e os últimos erros do console. Nunca senhas nem tokens."));
    this.body.appendChild(this.status);
    this.sendBtn = this.button("Enviar", false, () => void this.submit());
    this.button(tOr("STR_TBL_BATTLEGUI_CANCEL_TEXT", "Cancelar"), true, () => this.close());
  }

  static async create(d: BugDeps): Promise<BugPopup> {
    await loadStrings().catch(() => {});
    return new BugPopup(d);
  }

  /** `prefill`: text typed after "/bug" */
  open(prefill = ""): void {
    this.busy = false;
    this.area.value = prefill.slice(0, BUG_MAX);
    this.count.textContent = `${this.area.value.length}/${BUG_MAX}`;
    this.sendBtn.classList.toggle("off", !this.area.value.trim());
    this.say("");
    this.show();
    this.area.focus({ preventScroll: true });
  }

  private async submit(): Promise<void> {
    const t = this.area.value.trim();
    if (this.busy || !t) return;
    this.busy = true;
    this.say("Enviando…", true);
    let msg: string;
    try { msg = await this.d.send(t); } catch { msg = "Não foi possível enviar o relatório."; }
    const ok = /enviado|#\d+/i.test(msg);
    this.say(msg, ok);
    this.busy = false;
    if (ok) setTimeout(() => this.close(), 1200);
  }
}
