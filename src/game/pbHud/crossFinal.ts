// End-of-match screen of the Point Blank Cross client: Result_BG of UI_Project_HUD.i3Pack (public/assets/ui/cross/UI_Project_HUD.json,
// atlases ingame_result / ingame_hud2, exported by pb-extract-tools export-classic-ui.mjs). Replaces the v12 GameResult scene.
// Layout, sprites and the row order are the file's. Mapping of the controls to the match data is [INFERIDO]: the exe sets the
// text by control name, and the state order of the digit / bar / stamp sets is read off the sprite count.
//   team scores      Red_Score1..3 / Blue_Score1..3: digit state = digit (state 0..9)
//   team headers     TeamBarWin (top, red) / TeamBarLose (bottom, blue): state 0 = red bar, 1 = blue bar (ingame_result 2,730 / 3,972);
//                    fixed per block (block 0 = the Red rows), so a block keeps its colour whoever wins [INFERIDO]
//   stamps           TeamResultTop / TeamResultBottom: one ResultMark with 3 pieces, shape 0 VENCEDORES (ingame_hud2 477,112),
//                    1 PERDEDORES (808,0), 2 EMPATE (815,108). Winner block = 0, other block = 1, draw = 2 on both [INFERIDO]
//   user rows        <Team>Slot_BG_n (n = 1..8): ID nick, Kill, Death, Mission (objects), Score (damage), Exp, Pino (gold) [INFERIDO]
//                    Rank: SetShapeUVIndex(rank) on interface_level_icon (cell 24 of 256, as SetRankImage 0x801aa0); a row
//                    without a rank (bots, offline) shows rank 0, as the TAB board (crossScore.ts) [INFERIDO]
//                    Exp / Pino: the 5140 table (18 slots, roomClient.ts) per row; a row without a room slot (bots, offline) is blank
//   local row        Result_SelectBar moves to the local row
//   confirm          Result_Confirm: the sprite already carries "Confirmar" (ingame_result 771,834); no caption drawn on it [INFERIDO]
// Not in the Cross screen (no control in the file): map / mode title, clan block, Score / Reward tabs (one page now).
import { I3Gui, cloneNode, type GNode } from "../../lobby/ui/i3Gui.ts";
import { UI_BASE } from "../../lobby/ui/assets.ts";
import { LEVEL_ICON } from "../../lobby/screensCross/crossMap.ts";
import { sortedRows, type FinalData, type HudRow, type Team } from "./model.ts";

const CROSS = `${UI_BASE}/cross`;
/** the Cross HUD window file (the Result_BG tree is inside it); lives in ui/cross, next to the atlases */
export const CROSS_RESULT_JSON = `${CROSS}/UI_Project_HUD.json`;
const TEAM_PREFIX = ["Red", "Blue"] as const;
const SLOTS = 8;
/** children of a row (<Team>Slot_<name>_n) with no data source in the match: hidden */
const ROW_DECOR = ["Challenge", "PC_Room", "Item", "Event", "ClanMark", "Beginer", "ESport"];
/** ResultMark shapes (ingame_result / ingame_hud2 pieces, in image order) */
export const STAMP_WIN = 0, STAMP_LOSE = 1, STAMP_DRAW = 2;
/** the stamp of the top (Red) and bottom (Blue) block for the winner: 0 FR / 1 CT / null draw */
export function stampShapes(winner: Team | null): [number, number] {
  if (winner === null) return [STAMP_DRAW, STAMP_DRAW];
  return winner === 0 ? [STAMP_WIN, STAMP_LOSE] : [STAMP_LOSE, STAMP_WIN];
}
/** Result_BG controls of the mission-world (round) score: not used by the team modes */
const WORLD = ["Result_WinLostWorld", "Result_LoseLostWorld", "LostWorld_ScoreTop1", "LostWorld_ScoreTop2", "LostWorld_ScoreTop3", "LostWorld_ScoreTop4", "LostWorld_ScoreTop5",
  "LostWorld_ScoreBottom1", "LostWorld_ScoreBottom2", "LostWorld_ScoreBottom3", "LostWorld_ScoreBottom4", "LostWorld_ScoreBottom5"];

/** The Cross Result_BG node of UI_Project_HUD.json (jsonOnce, cached by the caller). */
export function crossResultTree(root: GNode): GNode | undefined {
  const find = (n: GNode): GNode | undefined => (n.name === "Result_BG" ? n : n.children?.map(find).find(Boolean));
  return find(root);
}

/** the atlases the Result_BG and Respawn_BG windows draw from (keepImage in PbHud.load: the CSS backgrounds paint from memory) */
export const CROSS_HUD_ATLASES = ["ingame_result", "ingame_hud2", "ingame_respawn"].map((a) => `${CROSS}/atlas/${a}.png`);

export class CrossFinal {
  readonly root: HTMLDivElement;
  private gui: I3Gui;
  private key = "";
  /** the local row's highlight bar (Result_SelectBar) is repositioned per render */
  private bar: HTMLElement | undefined;

  constructor(parent: HTMLElement, tree: GNode, private onOk: () => void) {
    this.root = document.createElement("div");
    this.root.style.cssText = "position:absolute;left:0;top:0;width:1024px;height:768px;display:none;pointer-events:none";
    parent.appendChild(this.root);
    this.gui = new I3Gui({ base: CROSS });
    this.gui.build(cloneNode(tree), this.root, 0, 0);
    for (const n of WORLD) this.gui.hide(n);
    this.gui.get("Result_Confirm")!.el.style.pointerEvents = "auto";
    this.gui.button("Result_Confirm", () => this.onOk());
    this.bar = this.gui.get("Result_SelectBar")?.el;
  }

  show(on: boolean): void { this.root.style.display = on ? "" : "none"; }

  /** Per frame while the screen is up. The rows / scores are rebuilt only when they change. */
  render(f: FinalData, rows: HudRow[]): void {
    const key = JSON.stringify([f.winner, f.red, f.blue, f.slotExp, f.slotGold, rows]);
    if (key !== this.key) { this.key = key; this.fill(f, rows); }
  }

  private fill(f: FinalData, rows: HudRow[]): void {
    const won = [f.winner === 0, f.winner === 1];
    this.score("Red", f.red);
    this.score("Blue", f.blue);
    this.gui.setState("TeamBarWin", 0);
    this.gui.setState("TeamBarLose", 1);
    this.gui.show("WinBarText", won[0]);
    this.gui.show("LoseBarText", !won[1]);
    const [top, bottom] = stampShapes(f.winner);
    for (const [name, shape] of [["TeamResultTop", top], ["TeamResultBottom", bottom]] as const) {
      this.gui.setAllShapeEnable(name, false);
      this.gui.setShapeEnable(name, shape, true);
      this.gui.show(name, true);
    }
    let localY: number | null = null;
    TEAM_PREFIX.forEach((p, t) => {
      const list = sortedRows(rows, t as Team);
      for (let i = 0; i < SLOTS; i++) {
        const n = i + 1, row = list[i];
        this.gui.show(`${p}Slot_BG_${n}`, !!row);
        for (const d of ROW_DECOR) this.gui.show(`${p}Slot_${d}_${n}`, false);
        this.gui.show(`${p}Slot_Rank_${n}`, !!row);
        if (!row) {
          for (const k of ["ID", "Kill", "Death", "Pino", "Exp", "Mission", "Score"]) this.gui.setText(`${p}Slot_${k}_${n}`, "");
          continue;
        }
        if (row.local) localY = this.gui.get(`${p}Slot_BG_${n}`)!.node.y;
        const col = row.local ? "#ffdc5a" : row.alive ? "#ffffff" : "#bebebe";
        this.gui.setShapeUVIndex(`${p}Slot_Rank_${n}`, row.rank ?? 0, LEVEL_ICON.cell, LEVEL_ICON.tex);
        this.gui.setText(`${p}Slot_ID_${n}`, row.name);
        this.gui.setColor(`${p}Slot_ID_${n}`, col);
        this.gui.setText(`${p}Slot_Kill_${n}`, String(row.kills));
        this.gui.setText(`${p}Slot_Death_${n}`, String(row.deaths));
        this.gui.setText(`${p}Slot_Mission_${n}`, String(row.objects ?? 0));
        this.gui.setText(`${p}Slot_Score_${n}`, String(Math.round(row.damage ?? 0)));
        const exp = row.slot !== undefined ? f.slotExp?.[row.slot] : undefined, gold = row.slot !== undefined ? f.slotGold?.[row.slot] : undefined;
        this.gui.setText(`${p}Slot_Exp_${n}`, exp !== undefined ? String(exp) : "");
        this.gui.setText(`${p}Slot_Pino_${n}`, gold !== undefined ? String(gold) : "");
      }
    });
    // the highlight sits on the local row: its Y is the row's own (RedSlot_BG_n / BlueSlot_BG_n node y), one bar for both teams
    if (this.bar) this.bar.style.display = localY === null ? "none" : "";
    if (this.bar && localY !== null) this.bar.style.top = `${localY - 1}px`;
  }

  /** three digit cells, hundreds first; leading cells hidden (the set's states 0..9 = the digits) */
  private score(p: string, v: number): void {
    const x = Math.min(999, Math.max(0, Math.trunc(v)));
    [100, 10, 1].forEach((place, k) => {
      const name = `${p}_Score${k + 1}`;
      this.gui.show(name, k === 2 || x >= place);
      this.gui.setState(name, Math.floor(x / place) % 10);
    });
  }
}
