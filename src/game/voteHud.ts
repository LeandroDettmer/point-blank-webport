// Vote HUD on the Cross client's own scenes UI_Temp/PBRe_ForceExitVote.i3UIs and PBRe_ForceExitVote_Result.i3UIs (Clients/PBCross),
// exported with their art by `pbx ui scenes cross` + `pbx ui atlas cross --all` (FrameWnd_01 / ImgBox_BG1 sprites from the Cross
// UI_Temp/PBRe.i3VTex) and drawn by the lobby LayoutRenderer: frame (4, 357) 225 x 165 / result 165 x 130, scene colours and sizes.
// Texts as the Cross exe + the scene's Lua (UI_Temp/script/PBRe_ForceExitVote.lua) set them:
//  - vote:__init: Subject = STR_HUD_FORCIBLYREMOVE_SUBJECT, Whos = STR_HUD_FORCIBLYREMOVE_WHOS, RTSec = _REMAIN_TIME_SECOND
//  - SetInfo(app, cand, reason) (exe 0x958e60): app = "[%s: %s]" with STBL_IDX_GUI_APPLICANT and the proposer (0x958f14..0x958f3c),
//    cand = the target nick; reason 0 NOMANNER, 1 ILLEGALPROGRAM, 2 ABUSE, anything else ETC (Lua; same switch in the exe 0x9599df)
//  - SetVoted(false / true): the key hints STR_HUD_FORCIBLYREMOVE_KEY_AGREE / _KEY_REVERSE, after voting _AGREE / _REVERSE
//  - UpdateVoteCount: the counts as plain decimals (itoa radix 10, 0x959133)
//  - result SetMsg(STR_HUD_FORCIBLYREMOVE_RESULT_TITLE, score + why + head) (0x959960..0x959c94): score "%d contra %d\n", why
//    "Motivo: %s\n" (passed) or the SHORTAGES / NOALLY / NOENEMY line, head RESULT_KICKED / RESULT_REJECT with the target nick
// The BR STR_HUD_FORCIBLYREMOVE_REMAIN_TIME_SUBJECT already carries "%d s", which the Lua prints raw in the 74 px RTSubject box:
// here it is formatted over the time row and RTNumber / RTSec stay empty [INFERIDO]. Leader vote: no Cross text [RECRIADO].
// Logic = voteState.ts.
import { RenderedScene, Stage } from "../lobby/ui/LayoutRenderer.ts";
import { UI_BASE, type LoadedSheet } from "../lobby/ui/assets.ts";
import type { SceneJson, SheetJson } from "../lobby/ui/format.ts";
import { loadStrings, tOr } from "../lobby/ui/i18n.ts";
import { jsonOnce } from "../jsonOnce.ts";
import type { VoteView } from "./voteState.ts";

export const VOTE_SCENE = "PBRe_ForceExitVote";
export const RESULT_SCENE = "PBRe_ForceExitVote_Result";

const fmt = (s: string, ...a: (string | number)[]) => { let i = 0; return s.replace(/%[sd]/g, () => String(a[i++] ?? "")); };
/** {col:r,g,b,a}..{/col} is rich text in the client strings: this HUD prints plain text */
const plain = (s: string) => s.replace(/\{\/?col[^}]*\}/g, "");

/** reason byte -> text: PBRe_ForceExitVote.lua vote:SetInfo (0 / 1 / 2, else ETC) */
export function kickReasonText(reason: number): string {
  switch (reason) {
    case 0: return plain(tOr("STR_HUD_FORCIBLYREMOVE_REASON_NOMANNER", "Chingamento"));
    case 1: return plain(tOr("STR_HUD_FORCIBLYREMOVE_REASON_ILLEGALPROGRAM", "Uso de Hack"));
    case 2: return plain(tOr("STR_HUD_FORCIBLYREMOVE_REASON_ABUSE", "Abuso"));
    default: return plain(tOr("STR_HUD_FORCIBLYREMOVE_REASON_ETC", "Outros"));
  }
}

async function loadCrossScene(name: string): Promise<[SceneJson, LoadedSheet]> {
  const [scene, sheet] = await Promise.all([
    jsonOnce<SceneJson>(`${UI_BASE}/scenes/cross/${name}.json`), jsonOnce<SheetJson>(`${UI_BASE}/atlas/cross/${name}.json`),
  ]);
  return [scene, { ...sheet, url: `${UI_BASE}/atlas/cross/${sheet.png}` }];
}

/** every design-time (Korean) caption of a scene emptied: the texts come from the Lua / exe above */
function blankTexts(scene: SceneJson): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of scene.controls) if (c.caption?.text) out[c.name] = "";
  return out;
}

export class VoteHud {
  private stage: Stage;
  private vote: RenderedScene;
  private result: RenderedScene;
  private last = new Map<string, string>();
  private shown = "";

  private constructor(host: HTMLElement, private nickOf: (slot: number) => string, v: [SceneJson, LoadedSheet], r: [SceneJson, LoadedSheet]) {
    this.stage = new Stage(host);
    this.stage.el.style.cssText = "background:transparent;pointer-events:none;z-index:32;";
    this.stage.el.style.display = "none";
    this.vote = new RenderedScene(v[0], v[1], { texts: blankTexts(v[0]) });
    this.result = new RenderedScene(r[0], r[1], { texts: blankTexts(r[0]) });
    for (const rs of [this.vote, this.result]) { rs.root.style.pointerEvents = "none"; this.stage.design.appendChild(rs.root); }
    // the time row: one formatted line over the scene's row (see the header)
    const time = this.vote.get("i3UIStaticText_RTSubject");
    if (time) time.style.width = "200px";
  }

  static async create(host: HTMLElement, nickOf: (slot: number) => string): Promise<VoteHud> {
    const [v, r] = await Promise.all([loadCrossScene(VOTE_SCENE), loadCrossScene(RESULT_SCENE), loadStrings()]);
    return new VoteHud(host, nickOf, v, r);
  }

  private text(rs: RenderedScene, name: string, s: string): void {
    const k = rs.scene.name + name;
    if (this.last.get(k) === s) return;
    this.last.set(k, s);
    rs.setText(name, s);
  }

  /** every frame (cheap: text writes are change-tracked) */
  update(v: VoteView): void {
    const phase = v.phase;
    if (phase === "idle") {
      if (this.shown) { this.shown = ""; this.stage.el.style.display = "none"; }
      return;
    }
    const which = phase === "result" ? "result" : "vote";
    if (this.shown !== which) {
      this.shown = which;
      this.stage.el.style.display = "";
      this.vote.root.hidden = which !== "vote";
      this.result.root.hidden = which !== "result";
    }
    const leader = v.kind === "leader";
    const creator = this.nickOf(v.creator) || `#${v.creator + 1}`;
    const target = this.nickOf(v.target) || `#${v.target + 1}`;

    if (which === "vote") {
      const r = this.vote;
      this.text(r, "i3UIStaticText_Subject", leader ? "Votação de líder" : plain(tOr("STR_HUD_FORCIBLYREMOVE_SUBJECT", "Vote Kick"))); // leader [RECRIADO]
      this.text(r, "i3UIStaticText_AppNick", `[${plain(tOr("STBL_IDX_GUI_APPLICANT", "Feito por"))}: ${creator}]`);
      this.text(r, "i3UIStaticText_Nick", target);
      this.text(r, "i3UIStaticText_Whos", plain(tOr("STR_HUD_FORCIBLYREMOVE_WHOS", "'s")));
      this.text(r, "i3UIStaticText_Reason", leader ? "Troca de líder" : kickReasonText(v.reason)); // leader [RECRIADO]
      const voted = phase === "voted";
      this.text(r, "i3UIStaticText_AgreeKey", plain(voted ? tOr("STR_HUD_FORCIBLYREMOVE_AGREE", "Aprovar") : tOr("STR_HUD_FORCIBLYREMOVE_KEY_AGREE", "Aceitar (Key - 9)")));
      this.text(r, "i3UIStaticText_Colon", ":");
      this.text(r, "i3UIStaticText_DisagreeKey", plain(voted ? tOr("STR_HUD_FORCIBLYREMOVE_REVERSE", "Negar") : tOr("STR_HUD_FORCIBLYREMOVE_KEY_REVERSE", "Negar (Key - 0)")));
      this.text(r, "i3UIStaticText_NumAgree", String(v.accept));
      this.text(r, "i3UIStaticText_NumDisagree", String(v.deny));
      this.text(r, "i3UIStaticText_RTSubject", fmt(plain(tOr("STR_HUD_FORCIBLYREMOVE_REMAIN_TIME_SUBJECT", "Tempo restante: %d s")), v.secondsLeft));
      return;
    }
    const res = v.result;
    if (!res) return;
    const score = fmt(plain(tOr("STR_HUD_FORCIBLYREMOVE_RESULT_SCORE", "%d contra %d\n")), res.accept, res.deny);
    let msg: string;
    if (leader) { // [RECRIADO]
      msg = score + (res.passed ? `${target} é o novo líder da sala` : res.why === "cancel" ? "Votação de líder cancelada" : "Troca de líder não aprovada");
    } else if (res.passed) {
      msg = score + fmt(plain(tOr("STR_HUD_FORCIBLYREMOVE_RESULT_SUCCESS", "Motivo: %s\n")), kickReasonText(v.reason))
        + fmt(plain(tOr("STR_HUD_FORCIBLYREMOVE_RESULT_KICKED", "%s foi kikado da sala")), target);
    } else if (res.why === "cancel") {
      msg = fmt(plain(tOr("STR_ACK_FORCIBLYREMOVE_CANCEL_VOTE", "%s quer cancelar a votação.")), creator);
    } else {
      const why = res.why === "noally" ? tOr("STR_HUD_FORCIBLYREMOVE_RESULT_NOALLY", "Motivo da não aprovação : Não recebeu votos dos amigos\n")
        : res.why === "noenemy" ? tOr("STR_HUD_FORCIBLYREMOVE_RESULT_NOENEMY", "Motivo da não aprovação : Não recebeu votos dos adversários\n")
          : tOr("STR_HUD_FORCIBLYREMOVE_RESULT_SHORTAGES", "Motivo da não aprovação : Maioria dos votos\n");
      msg = score + plain(why) + fmt(plain(tOr("STR_HUD_FORCIBLYREMOVE_RESULT_REJECT", "%s Decidiu não expulsar da sala")), target);
    }
    this.text(this.result, "i3UIStaticText_Subject", plain(tOr("STR_HUD_FORCIBLYREMOVE_RESULT_TITLE", "Notificação de Voto")));
    this.text(this.result, "i3UIStaticText_Content", msg.trim());
    // the content box wraps (i3UIStaticText multi-line): the caption span is single-line by default
    const cap = this.result.get("i3UIStaticText_Content")?.querySelector<HTMLElement>(".pbui-caption");
    if (cap) cap.style.whiteSpace = "pre-wrap";
  }

  dispose(): void {
    this.vote.destroy();
    this.result.destroy();
    this.stage.destroy();
  }
}
