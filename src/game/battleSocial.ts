// Everything social inside a room battle, behind one object so game.ts only needs a few hooks (phases
// 3, 5, 6, 8, 9 on the client): the chat (battleChat.ts), "/" commands, the vote HUD (voteHud.ts + voteState.ts), the report /
// vote-kick popups (reportPopup.ts) and the bug popup. Online room battles only: offline there is no Game connection.
// Everything is created asynchronously (scenes load); the hooks tolerate a part that is not up yet.
import { ChatType, chat, splitArgs, type ChatClient } from "../net/chatClient.ts";
import type { PbConnection } from "../net/connection.ts";
import { sendBugReport, setBugContext, setBugOpener } from "../net/bugReport.ts";
import type { RoomClient } from "../net/roomClient.ts";
import { VoteClient, type VoteKind } from "../net/voteClient.ts";
import { loadStrings, tOr } from "../lobby/ui/i18n.ts";
import { BattleChat } from "./battleChat.ts";
import type { Input } from "./input.ts";
import { CHAT_KEYS } from "./keymap.ts";
import { GM_KEY, GmPanel } from "./gmPanel.ts";
import { BugPopup, ModerationPopup, type PlayerRef } from "./reportPopup.ts";
import { VoteHud } from "./voteHud.ts";
import { FONTS } from "../lobby/ui/assets.ts";
import { VoteModel } from "./voteState.ts";

export interface BattleSocialDeps {
  host: HTMLElement;
  input: Input;
  room: RoomClient;
  /** field may open: pointer locked, no menu / final screen */
  canOpenChat: () => boolean;
  /** a Z / X / C radio menu is open (the digit keys belong to it) */
  radioMenuOpen: () => boolean;
  /** the server removed me by a vote: leave the battle (game.ts onLeave) */
  onKicked: () => void;
}

const SLOT_IN_BATTLE = 12; // SlotState LOAD and up (boot.ts: s.state >= 12)

export class BattleSocial {
  readonly chat: ChatClient = chat;
  readonly votes: VoteClient;
  readonly model: VoteModel;
  private chatUi: BattleChat | null = null;
  private hud: VoteHud | null = null;
  private report: ModerationPopup | null = null;
  private banVote: ModerationPopup | null = null;
  private leaderVote: ModerationPopup | null = null;
  private bug: BugPopup | null = null;
  private gm: GmPanel | null = null;
  private clock = 0;
  private disposed = false;
  private offBug: () => void;
  private prevBugOpener: (() => void) | null = null;
  private banner: HTMLElement | null = null;
  private kickTimer = 0;

  constructor(private d: BattleSocialDeps) {
    const conn = d.room.game.conn as PbConnection;
    if (!chat.connected) chat.attach(conn);
    chat.nickOfSlot = (s) => d.room.slots[s]?.nick ?? "";
    chat.nickColorOfSlot = (s) => d.room.slots[s]?.nickColor ?? 0;
    chat.myNick = d.room.slots[d.room.mySlot]?.nick ?? chat.myNick;
    this.votes = new VoteClient(conn);
    this.model = new VoteModel({
      mySlot: () => d.room.mySlot,
      now: () => this.clock,
      notice: (t) => chat.system(t),
      onKicked: () => this.kicked(),
      onLocalVote: (yes) => { try { (this.lastKind === "leader" ? this.votes.voteLeader(yes) : this.votes.voteKick(yes)); } catch (e) { console.warn("[vote] send", e); } },
    });
    this.votes.onEvent((e) => { if ("kind" in e) this.lastKind = e.kind; this.model.handle(e); });
    this.model.text = (k) => ({
      already: tOr("STR_ACK_FORCIBLYREMOVE_VOTE_FAIL_ALREADY", "Você já votou."),
      running: tOr("STR_ACK_FORCIBLYREMOVE_START_FAIL_ALREADY", "Outra votação já está em andamento."),
      cooldown: "Aguarde um minuto para iniciar outra votação.", // [RECRIADO]
      rank: tOr("STR_ACK_FORCIBLYREMOVE_VOTE_FAIL_NORIGHT", "Não tem direito ao voto."),
      noright: tOr("STR_ACK_FORCIBLYREMOVE_VOTE_FAIL_NORIGHT", "Não tem direito ao voto."),
      fail: tOr("STR_ACK_FORCIBLYREMOVE_UNKNOWN_ERROR", "Erro desconhecido."),
      few: this.lastKind === "leader" ? "É preciso ter pelo menos 4 jogadores humanos na partida para votar um novo líder." : "É preciso ter pelo menos 4 jogadores humanos na partida para votar uma expulsão.",
      protected: "Esse jogador não pode ser expulso por votação.",
      badTarget: "Esse jogador não pode ser o novo líder.",
      highPing: "Esse jogador tem ping alto demais para ser líder.",
    })[k];
    setBugContext(() => ({ p2p_role: d.room.isLeader ? "host" : "guest", room_id: d.room.room?.roomId ?? null, map: d.room.room?.mapId ?? null, mode: d.room.room?.roomType ?? null }));
    this.prevBugOpener = setBugOpener(() => this.openBug());
    this.offBug = chat.onBugPopup(() => this.openBug());
    void this.load();
  }

  private lastKind: VoteKind = "kick";

  private async load(): Promise<void> {
    await loadStrings().catch(() => {});
    const d = this.d, host = d.host;
    const mod = { host, input: d.input, roster: () => this.roster(), mySlot: () => d.room.mySlot, leaderSlot: () => d.room.leaderSlot, chat, votes: () => this.votes, voteRunning: () => this.model.running };
    const results = await Promise.allSettled([
      BattleChat.create({
        host, input: d.input, chat, canOpen: () => !this.modalOpen && d.canOpenChat(), command: (l) => this.command(l),
        inClan: () => !!d.room.slots[d.room.mySlot]?.clan,
      }),
      VoteHud.create(host, (s) => d.room.slots[s]?.nick ?? ""),
      ModerationPopup.create(mod, "report"),
      ModerationPopup.create(mod, "vote"),
      ModerationPopup.create(mod, "leader"),
      BugPopup.create({ host, input: d.input, send: async (t) => (await sendBugReport(t)).message }),
      Promise.resolve(d.room.isGM || chat.isGM ? new GmPanel({ host, input: d.input, roster: () => this.roster(), send: (t) => chat.send(ChatType.ROOM, t), onLine: (cb) => chat.onLine(cb) }) : null),
    ]);
    const ok = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : (console.error("[battleSocial] scene failed", r.reason), null));
    const [c, h, r, v, l, b, g] = [ok(results[0]), ok(results[1]), ok(results[2]), ok(results[3]), ok(results[4]), ok(results[5]), ok(results[6])];
    if (this.disposed) { c?.dispose(); h?.dispose(); r?.dispose(); v?.dispose(); l?.dispose(); b?.dispose(); g?.dispose(); return; }
    this.chatUi = c; this.hud = h; this.report = r; this.banVote = v; this.leaderVote = l; this.bug = b; this.gm = g;
    if (g) window.addEventListener("keydown", this.gmKey, true);
  }

  /** players of the room battle (human slots): nick + slot */
  roster(): PlayerRef[] {
    const out: PlayerRef[] = [];
    for (const s of this.d.room.slots) if (s.nick && s.state >= SLOT_IN_BATTLE) out.push({ slot: s.slot, nick: s.nick, rank: s.rank });
    return out;
  }

  /** nick (exact, else a unique prefix, case-insensitive) -> roster entry */
  private resolve(arg: string): PlayerRef | null {
    const a = arg.trim().toLowerCase();
    if (!a) return null;
    const r = this.roster();
    return r.find((p) => p.nick.toLowerCase() === a) ?? (r.filter((p) => p.nick.toLowerCase().startsWith(a)).length === 1 ? r.find((p) => p.nick.toLowerCase().startsWith(a))! : null);
  }

  // ---- hooks used by game.ts --------------------------------------------------------------------------------------

  get chatOpen(): boolean { return !!this.chatUi?.isOpen; }
  /** the chat field and the chat history count: both free the pointer like a popup, so no ESC menu and no "click to play" blocker on that unlock (game.ts) */
  get modalOpen(): boolean { return !!(this.report?.isOpen || this.banVote?.isOpen || this.leaderVote?.isOpen || this.bug?.isOpen || this.gm?.isOpen || this.chatOpen || this.chatUi?.historyOpen); }
  /** an Escape that closed the chat field must not open the ESC menu */
  escConsumed(): boolean { return !!this.chatUi?.escConsumed(); }
  isBlockedNick(nick: string): boolean { return chat.isBlocked(nick); }

  openReport(preselect = -1): void { this.report?.open(preselect); }
  openBanVote(preselect = -1): void { this.banVote?.open(preselect); }
  openLeaderVote(preselect = -1): void { this.leaderVote?.open(preselect); }
  openBug(prefill = ""): void { this.bug?.open(prefill); }
  openGm(): void { this.gm?.open(); }
  private gmKey = (e: KeyboardEvent): void => {
    if (e.code !== GM_KEY || !this.gm) return;
    e.preventDefault(); e.stopPropagation();
    if (this.gm.isOpen) this.gm.close();
    else if (this.d.canOpenChat() && !this.modalOpen) this.gm.open();
  };

  /** every frame; `dt` real seconds */
  update(dt: number): void {
    this.clock += dt;
    this.chatUi?.update(dt);
    const inp = this.d.input;
    if (!inp.chatOpen && this.model.canVote() && !this.d.radioMenuOpen()) {
      const yes = CHAT_KEYS.voteYes.some((c) => inp.keyPressed(c)), no = CHAT_KEYS.voteNo.some((c) => inp.keyPressed(c));
      if (yes !== no) this.model.localVote(yes);
    }
    this.hud?.update(this.model.view());
  }

  /** "/..." typed in the chat field; true = handled here (not sent) */
  private command(line: string): boolean {
    const [cmd = "", ...rest] = splitArgs(line, 2);
    const arg = rest.join(" ");
    switch (cmd.toLowerCase()) {
      case "/bloquear": case "/block": {
        const nick = splitArgs(arg, 1)[0] ?? "";
        if (!nick) { chat.system("Uso: /bloquear <apelido>"); return true; }
        const p = this.resolve(nick);
        chat.block(p?.nick ?? nick);
        chat.system(`${p?.nick ?? nick}: bloqueado (chat e rádio).`);
        return true;
      }
      case "/desbloquear": case "/unblock": {
        const nick = splitArgs(arg, 1)[0] ?? "";
        if (!nick) { chat.system(chat.blockedNicks().length ? `Bloqueados: ${chat.blockedNicks().join(", ")}` : "Ninguém bloqueado."); return true; }
        const p = this.resolve(nick);
        chat.unblock(p?.nick ?? nick);
        chat.system(`${p?.nick ?? nick}: desbloqueado.`);
        return true;
      }
      case "/denunciar": if (!arg) { this.openReport(); return true; } return false; // with arguments the server parses it
      case "/votekick": if (!arg) { this.openBanVote(); return true; } return false;
      case "/votelider": if (!arg) { this.openLeaderVote(); return true; } return false;
      case "/bug": this.openBug(arg); return true;
      case "/sim": case "/yes": this.model.localVote(true); return true;
      case "/nao": case "/não": case "/no": this.model.localVote(false); return true;
      default: return false;
    }
  }

  /** 5203: show the notice, then leave through the normal leave path (the server already removed the slot) */
  private kicked(): void {
    if (this.banner || this.disposed) return;
    const msg = tOr("STR_ACK_FORCIBLYREMOVE_KICKED_BY_VOTE", "%s Você foi expulso da sala através de votação.").replace(/%s\s*/, "").replace(/\{\/?col[^}]*\}/g, "");
    chat.system(msg);
    const b = this.banner = document.createElement("div");
    b.style.cssText = 'position:fixed;left:50%;top:38%;transform:translateX(-50%);z-index:70;padding:14px 22px;background:rgba(0,0,0,.78);border:1px solid rgba(255,255,255,.3);'
      + 'font:bold 16px ' + FONTS.popup + ';color:#fff;text-shadow:1px 1px 0 #000;pointer-events:none;';
    b.textContent = msg;
    this.d.host.appendChild(b);
    this.kickTimer = window.setTimeout(() => this.d.onKicked(), 2500);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.kickTimer);
    this.banner?.remove();
    this.offBug();
    setBugOpener(this.prevBugOpener);
    this.votes.dispose();
    this.chatUi?.dispose(); this.hud?.dispose(); this.report?.dispose(); this.banVote?.dispose(); this.leaderVote?.dispose(); this.bug?.dispose(); this.gm?.dispose();
    window.removeEventListener("keydown", this.gmKey, true);
  }
}
