// GM panel (in-battle, opened from the ESC menu for a GM account): a form over the server's ":" commands (server gmCommands.ts), so
// the server stays the only authority (permission levels, "can't kick higher access"). Every button sends one chat line; the server's
// answer comes back as a "Server" chat line and is shown in the log of the panel too. [RECRIADO]: the client has no such window.
import type { ChatLine } from "../net/chatClient.ts";
import { CHAT_MAX } from "../net/chatClient.ts";
import type { Input } from "./input.ts";
import { Modal, el, rankIcon, type PlayerRef } from "./reportPopup.ts";

/** opens / closes the panel (lobby and battle); F8: no browser function, not used by the game (F1 help, F2 / F3 chat, F4 debug, F5 GM HUD, F9 GM ids, F10-F12 browser) */
export const GM_KEY = "F8";

export interface GmPanelDeps {
  host: HTMLElement;
  /** null in the lobby (no pointer lock / game keys to hand back) */
  input: Input | null;
  roster: () => PlayerRef[];
  /** one chat line (":mute nick 5"); false = not sent */
  send: (text: string) => boolean;
  /** lines the server answers with while the panel is open */
  onLine: (cb: (l: ChatLine) => void) => () => void;
  /** lobby only: "enter rooms hidden, as a GM observer" (the server puts the GM in an observer seat nobody else sees) */
  stealth?: { get(): boolean; set(v: boolean): void };
}

const CSS = `
.pbg-row{display:flex;gap:6px;flex-wrap:wrap}
.pbg-row .pbm-btn{min-width:0;flex:1 1 30%;height:30px;padding:0 6px;font-size:12px}
.pbg-row .pbm-btn.danger{background:linear-gradient(#e0644e,#9c2a1c)}
.pbg-row .pbm-btn.danger:hover{background:linear-gradient(#f07a64,#b73626)}
.pbg-two{display:flex;gap:8px}
.pbg-two>*{flex:1;min-width:0}
.pbg-log{min-height:64px;max-height:110px;overflow:auto;background:#070b14;border:1px solid #26314d;padding:6px 8px;font-size:12px;color:#f6c46a;
  white-space:pre-wrap;user-select:text}
`;
let cssDone = false;

/** nick with spaces goes in quotes (":mute" / ":reports" tokenize them) */
const q = (nick: string) => (/\s/.test(nick) ? `"${nick}"` : nick);
/** :player targets always in quotes: the server reads a bare number as a UID, so a player called "1001" would hit UID 1001 */
const qn = (nick: string) => `"${nick}"`;

export class GmPanel extends Modal {
  private nick: HTMLInputElement;
  private amount: HTMLInputElement;
  private gift: HTMLInputElement;
  private text: HTMLInputElement;
  private log = el("div", "pbg-log");
  private list = el("div", "pbm-list");
  private giftKind: "gold" | "cash" | "tags" = "gold";
  private giftBtns: HTMLElement[] = [];
  private armed: HTMLElement | null = null;
  private paintStealth: (() => void) | null = null;
  private offLine: (() => void) | null = null;

  constructor(private d: GmPanelDeps) {
    super(d.host, d.input, "Painel GM");
    if (!cssDone) { cssDone = true; const s = document.createElement("style"); s.textContent = CSS; document.head.appendChild(s); }
    const field = (ph: string, type = "text", max = 40) => {
      const i = el("input", "pbm-in");
      i.type = type; i.placeholder = ph; i.maxLength = max; i.autocomplete = "off"; i.spellcheck = false;
      return i;
    };
    if (d.stealth) {
      const st = d.stealth;
      const chk = el("div", "pbm-chk");
      chk.append(el("b", "", "✓"), el("span", "", "Entrar nas salas invisível (observador GM)"));
      const paint = () => chk.classList.toggle("on", st.get());
      chk.addEventListener("click", () => { st.set(!st.get()); paint(); });
      paint();
      this.section("Entrada", chk);
      this.body.appendChild(el("div", "pbm-n", "Nenhum jogador vê você na sala nem na partida, e você não ocupa vaga. Vale para as próximas salas em que entrar."));
      this.paintStealth = paint;
    }
    this.nick = field("Apelido do jogador", "text", 32);
    this.section("Jogador", this.nick, this.list);
    this.amount = field("Minutos / dias", "number", 6);
    this.amount.value = "30";
    const acts = el("div", "pbg-row");
    const act = (label: string, run: () => string | null, danger = false) => {
      const b = el("div", `pbm-btn${danger ? " danger" : ""}`, label);
      b.addEventListener("click", () => {
        if (danger && this.armed !== b) { this.arm(b, label); return; } // second click confirms
        this.disarm();
        const cmd = run();
        if (cmd) this.run(cmd);
      });
      acts.appendChild(b);
    };
    act("Expulsar", () => (this.needNick() ? `:player kick ${qn(this.nick.value.trim())}` : null), true);
    act("Silenciar", () => this.needNick() && this.num() !== null ? `:mute ${q(this.nick.value.trim())} ${this.num()}` : null);
    act("Liberar chat", () => this.needNick() ? `:mute ${q(this.nick.value.trim())} 0` : null);
    act("Banir (dias)", () => this.needNick() && this.num() !== null ? `:player ban normal ${this.num()} ${qn(this.nick.value.trim())}` : null, true);
    act("Denúncias", () => this.nick.value.trim() ? `:reports ${q(this.nick.value.trim())}` : ":reports");
    this.section("Ação (valor = minutos de silêncio ou dias de ban)", this.amount, acts);

    const seg = el("div", "pbm-seg");
    for (const k of ["gold", "cash", "tags"] as const) {
      const b = el("div", "pbm-p", k === "gold" ? "Gold" : k === "cash" ? "Cash" : "Tags");
      b.addEventListener("click", () => { this.giftKind = k; this.paintGift(); });
      this.giftBtns.push(b);
      seg.appendChild(b);
    }
    this.gift = field("Quantidade", "number", 9);
    const giftGo = el("div", "pbm-btn", "Enviar");
    giftGo.addEventListener("click", () => {
      const n = Math.trunc(Number(this.gift.value));
      if (!this.needNick() || !Number.isFinite(n) || n === 0) { this.say("Informe o jogador e uma quantidade."); return; }
      this.run(`:player gift ${this.giftKind} ${n} ${qn(this.nick.value.trim())}`);
    });
    const giftRow = el("div", "pbg-two");
    giftRow.append(this.gift, giftGo);
    giftGo.style.minWidth = "0";
    this.section("Presentear", seg, giftRow);
    this.paintGift();

    this.text = field("Texto (até 44 letras)", "text", CHAT_MAX - ":sendmsg player ".length);
    const msg = el("div", "pbg-row");
    for (const [label, where] of [["Para a sala", "room"], ["Para o canal", "channel"], ["Para todos", "player"]] as const) {
      const b = el("div", "pbm-btn", label);
      b.addEventListener("click", () => { const t = this.text.value.trim(); if (!t) { this.say("Escreva a mensagem."); return; } this.run(`:sendmsg ${where} ${t}`); });
      msg.appendChild(b);
    }
    this.section("Mensagem do servidor", this.text, msg);

    const srv = el("div", "pbg-row");
    const quick = (label: string, cmd: string, danger = false) => {
      const b = el("div", `pbm-btn${danger ? " danger" : ""}`, label);
      b.addEventListener("click", () => {
        if (danger && this.armed !== b) { this.arm(b, label); return; }
        this.disarm();
        this.run(cmd);
      });
      srv.appendChild(b);
    };
    quick("Encerrar partida", ":endbattle", true);
    quick("Últimas denúncias", ":reports");
    quick("Bugs", ":bugs");
    quick("Ajuda", ":help");
    this.section("Servidor", srv);

    this.section("Resposta", this.log);
    this.body.appendChild(this.status);
    this.button("Fechar", true, () => this.close());
    for (const inp of [this.nick, this.amount, this.gift, this.text]) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
  }

  private num(): number | null {
    const n = Math.trunc(Number(this.amount.value));
    if (!Number.isFinite(n) || n < 0) { this.say("Valor inválido."); return null; }
    return n;
  }

  private needNick(): boolean {
    if (this.nick.value.trim()) return true;
    this.say("Escolha o jogador (lista ou apelido).");
    return false;
  }

  private arm(b: HTMLElement, label: string): void {
    this.disarm();
    this.armed = b;
    b.dataset.label = label;
    b.textContent = "Confirmar?";
  }

  private disarm(): void {
    if (this.armed) { this.armed.textContent = this.armed.dataset.label ?? ""; this.armed = null; }
  }

  private paintGift(): void {
    const kinds = ["gold", "cash", "tags"];
    this.giftBtns.forEach((b, i) => b.classList.toggle("on", kinds[i] === this.giftKind));
  }

  private run(cmd: string): void {
    if (cmd.length > CHAT_MAX) { this.say(`Comando maior que ${CHAT_MAX} letras (apelido ou texto longo demais).`); return; }
    if (!this.d.send(cmd)) { this.say("Não enviado: sem conexão."); return; }
    this.say(`Enviado: ${cmd}`, true);
  }

  private paintRoster(): void {
    this.list.replaceChildren();
    const me = this.nick.value.trim().toLowerCase();
    for (const p of this.d.roster()) {
      const b = el("div", `pbm-p${p.nick.toLowerCase() === me ? " on" : ""}`);
      const bar = el("i");
      bar.style.setProperty("--tc", p.slot % 2 === 0 ? "rgb(255,120,100)" : "rgb(110,180,255)");
      b.append(bar);
      if (p.rank !== undefined && p.rank >= 0) b.appendChild(rankIcon(p.rank));
      b.append(el("span", "", p.nick));
      b.addEventListener("click", () => { this.nick.value = p.nick; this.paintRoster(); });
      this.list.appendChild(b);
    }
  }

  open(): void {
    this.paintStealth?.();
    this.say("");
    this.disarm();
    this.paintRoster();
    this.log.textContent = "";
    this.offLine?.();
    this.offLine = this.d.onLine((l) => {
      if (l.kind !== "system" && l.nick !== "Server") return;
      this.log.textContent += `${this.log.textContent ? "\n" : ""}${l.text}`;
      this.log.scrollTop = this.log.scrollHeight;
    });
    this.show();
  }

  close(): void {
    this.offLine?.();
    this.offLine = null;
    super.close();
  }

  dispose(): void {
    this.offLine?.();
    super.dispose();
  }
}
