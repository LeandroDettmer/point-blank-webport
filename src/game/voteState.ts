// State machine of the in-battle vote HUD (HUD_UserBanVote), pure: fed with VoteEvents (net/voteClient.ts) and a clock,
// it answers which panel shows. The scene has four panels: FmwStart (announcement), FmwVoteGuide (Yes / No + counts),
// FmwVoted (counts only, already voted) and FmwResult. Timing of the panels is [INFERIDO]: the original script was not
// decoded; the 20 s window is the C# server's.
import { VoteErr, type VoteEvent, type VoteKind } from "../net/voteClient.ts";

export const VOTE_WINDOW_S = 20;
/** the first seconds of a vote, before the keys count (an accidental 9 / 0 press) [INFERIDO]; the HUD shows the same panel throughout */
export const VOTE_START_S = 1;
/** the result notice closes after 5 s (PBRe_ForceExitVote_Result.lua result:OnUpdate, g_UpdateTime > 5) */
export const VOTE_RESULT_S = 5;

export type VotePhase = "idle" | "start" | "guide" | "voted" | "result";
export type VoteWhy = "ok" | "rejected" | "noally" | "noenemy" | "cancel";

export interface VoteView {
  phase: VotePhase;
  kind: VoteKind;
  creator: number;
  target: number;
  reason: number;
  accept: number;
  deny: number;
  /** 0..1 of the current panel's bar: the start notice fills, the vote window drains */
  bar: number;
  /** whole seconds left of the 20 s window */
  secondsLeft: number;
  /** I can still press Yes / No */
  canVote: boolean;
  result: { passed: boolean; why: VoteWhy; accept: number; deny: number } | null;
}

export interface VoteModelOpts {
  mySlot: () => number;
  now: () => number;
  /** feedback lines for the chat log (errors of the REQ ACKs) */
  notice?: (text: string) => void;
  /** 5203 / the local player was kicked */
  onKicked?: () => void;
  /** a vote of mine was refused / accepted by the server (key feedback) */
  onLocalVote?: (yes: boolean) => void;
}

const IDLE: VoteView = { phase: "idle", kind: "kick", creator: -1, target: -1, reason: 0, accept: 0, deny: 0, bar: 0, secondsLeft: 0, canVote: false, result: null };

export class VoteModel {
  private kind: VoteKind = "kick";
  private active = false;
  private startAt = 0;
  private creator = -1;
  private target = -1;
  private reason = 0;
  private accept = 1;
  private deny = 1;
  private voted = false;
  private result: { passed: boolean; why: VoteWhy; accept: number; deny: number; at: number } | null = null;
  /** strings for the notices; the owner swaps them for the client's STR_ACK_FORCIBLYREMOVE_* */
  text: (key: "already" | "running" | "cooldown" | "rank" | "noright" | "fail" | "few" | "protected" | "badTarget" | "highPing") => string = (k) => k;

  constructor(private o: VoteModelOpts) {}

  get running(): boolean { return this.active && !this.result; }
  /** the slot the running vote is about */
  get targetSlot(): number { return this.running ? this.target : -1; }

  handle(e: VoteEvent): void {
    const now = this.o.now();
    switch (e.t) {
      case "start":
        this.kind = e.kind; this.active = true; this.startAt = now;
        this.creator = e.creator; this.target = e.target; this.reason = e.reason;
        // Accept = 1 / Denie = 1 and both already counted as voted (VoteKickModel, 5.1); the leader vote starts from 0
        this.accept = e.kind === "kick" ? 1 : 0; this.deny = e.kind === "kick" ? 1 : 0;
        this.voted = e.kind === "kick" ? e.creator === this.o.mySlot() || e.target === this.o.mySlot() : e.creator === this.o.mySlot();
        if (e.kind === "leader" && e.creator === this.o.mySlot()) this.accept = 1;
        this.result = null;
        break;
      case "current":
        if (this.active && e.kind === this.kind) { this.accept = e.accept; this.deny = e.deny; }
        break;
      case "result": {
        if (!this.active) { this.kind = e.kind; this.target = e.target; this.active = true; this.startAt = now - VOTE_START_S; }
        const passed = e.err === 0;
        this.result = {
          passed,
          why: passed ? "ok" : e.err === VoteErr.NO_ALLY ? "noally" : e.err === VoteErr.NO_ENEMY ? "noenemy" : "rejected",
          accept: e.accept, deny: e.deny, at: now,
        };
        break;
      }
      case "cancel":
        if (this.active) this.result = { passed: false, why: "cancel", accept: this.accept, deny: this.deny, at: now };
        break;
      case "startAck":
        if (e.err !== 0) this.o.notice?.(this.errText(e.err));
        break;
      case "voteAck":
        if (e.err !== 0) { this.o.notice?.(this.errText(e.err)); if (e.err === VoteErr.ALREADY_VOTED) this.voted = true; }
        break;
      case "kicked":
        this.o.onKicked?.();
        break;
    }
  }

  /** I pressed Yes / No: the guide gives way to the counts panel at once (the server counts it, 5201 follows) */
  localVote(yes: boolean): void {
    if (!this.canVote()) return;
    this.voted = true;
    if (yes) this.accept++; else this.deny++; // the broadcast replaces these
    this.o.onLocalVote?.(yes);
  }

  canVote(): boolean {
    if (!this.running || this.voted) return false;
    const t = this.o.now() - this.startAt;
    return t >= VOTE_START_S && t < VOTE_WINDOW_S + 1;
  }

  private errText(err: number): string {
    switch (err) {
      case VoteErr.ALREADY_RUNNING: return this.text("running");
      case VoteErr.COOLDOWN: return this.text("cooldown");
      case VoteErr.RANK: return this.text("rank");
      case VoteErr.ALREADY_VOTED: return this.text("already");
      case VoteErr.FEW_PLAYERS: return this.text("few");
      case VoteErr.PROTECTED: return this.text("protected");
      case VoteErr.BAD_TARGET: return this.text("badTarget");
      case VoteErr.HIGH_PING: return this.text("highPing");
      default: return this.text("fail");
    }
  }

  view(): VoteView {
    if (!this.active) return IDLE;
    const now = this.o.now(), t = now - this.startAt;
    const base = { kind: this.kind, creator: this.creator, target: this.target, reason: this.reason, accept: this.accept, deny: this.deny };
    if (this.result) {
      if (now - this.result.at >= VOTE_RESULT_S) { this.active = false; this.result = null; return IDLE; }
      return { ...base, phase: "result", bar: 0, secondsLeft: 0, canVote: false, result: this.result, accept: this.result.accept, deny: this.result.deny };
    }
    // no result 3 s after the window: the server lost it, do not leave the panel up
    if (t > VOTE_WINDOW_S + 3) { this.active = false; return IDLE; }
    const left = Math.max(0, VOTE_WINDOW_S - t);
    if (t < VOTE_START_S) return { ...base, phase: "start", bar: t / VOTE_START_S, secondsLeft: Math.ceil(left), canVote: false, result: null };
    return { ...base, phase: this.voted ? "voted" : "guide", bar: left / VOTE_WINDOW_S, secondsLeft: Math.ceil(left), canVote: this.canVote(), result: null };
  }
}
