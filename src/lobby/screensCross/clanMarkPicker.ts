// Escolha de emblema do clã (Cross): clanCreateClanMarkPopup (criar) e changeClanMarkPopup (trocar) de UI_Project_Popup, mesmo
// layout. Uma instância só para o menu de clã (criar / trocar na gestão) e o inventário (Usar do item de troca 1600052).
// Dono: a própria instância; quem abre passa `hooks` (OK / verificar) e fecha com close() quando a ação dá certo.
// [RECRIADO] a célula / cor escolhida fica marcada com contorno e a moldura de seleção vai para ela.
import { CLAN_MARK_BACK_IMAGE_COUNT, CLAN_MARK_COLOR_COUNT, CLAN_MARK_SHAPE_IMAGE_COUNT, CLAN_MARK_USER_COLORS, encodeClanMark, type ClanMarkParts } from "../clanMark.ts";
import { ClanClient } from "../../net/clanClient.ts";
import { jsonOnce } from "../../jsonOnce.ts";
import type { MetaSession } from "../state/MetaSession.ts";
import type { InventoryItem } from "../types.ts";
import type { GNode, I3Gui } from "../ui/i3Gui.ts";
import { BASE, buildWindows, onClick, pageGui, type PageCtx, type Texts } from "./pages/common.ts";
import { paintMark } from "./clanMarkView.ts";

/** the emblem a new clan / an empty pick starts with: colour 1 and image 1 of each layer [INFERIDO] (the exe's default not decoded) */
export const MARK_DEFAULT: ClanMarkParts = { backColor: 1, backImage: 1, shapeImage: 1, shapeColor: 1 };
/** cash effect of the emblem change item (EffectId.ClanLogo, server itemHandlers.ts case 1600052) */
export const CLAN_MARK_ITEM_EFFECT = 1600052;
/** select cells per page of each group (SelectImage1j = back images, SelectImage2j = shape images) */
const PER_PAGE = 5;
const PREFIXES = ["clanCreateClanMark", "changeClanMark"] as const;

/** the item that changes the emblem: the cash id above 1700000 whose effect is 1600052 (handleUseItem's eff = 1600000 + id % 1000) [INFERIDO] */
export const isClanMarkItem = (itemId: number): boolean => itemId > 1700000 && 1600000 + (itemId % 1000) === CLAN_MARK_ITEM_EFFECT;

const TEXTS: Texts = {
  clanCreateClanMarkPopupCaption: ["STBL_IDX_CLAN_CREATE_CLAN_MARK", "Criar emblema do clã"],
  changeClanMarkPopupCaption: ["STBL_IDX_CLAN_CHANGE_CLAN_MARK", "Trocar emblema do clã"],
  clanCreateClanMarkOk: ["STBL_IDX_CLAN_BUTTON_OK", "Confirmar"], clanCreateClanMarkCancel: ["STBL_IDX_CLAN_BUTTON_CANCEL", "Cancelar"],
  changeClanMarkOk: ["STBL_IDX_CLAN_BUTTON_OK", "Confirmar"], changeClanMarkCancel: ["STBL_IDX_CLAN_BUTTON_CANCEL", "Cancelar"],
};

export interface MarkHooks {
  /** OK: the emblem picked (logo) */
  ok: (logo: number) => void;
  /** overlap check (856): the emblem picked (logo) */
  check: (logo: number) => void;
}

/** page of a 1-based cell value in its group */
const pageOf = (v: number): number => Math.max(0, Math.floor((v - 1) / PER_PAGE));

/** moves selection frame `sel` onto control `target`, keeping its offset from `first` (the frame starts over the first box) */
export function slide(g: I3Gui, sel: string, target: string, first: string): void {
  const s = g.get(sel), t = g.get(target), f = g.get(first);
  if (!s || !t || !f) return;
  s.el.style.left = `${t.node.x + s.node.x - f.node.x}px`;
  s.el.style.top = `${t.node.y + s.node.y - f.node.y}px`;
}

/** colour swatch: a fill inside the box control (the box sprite stays under it) */
export function swatch(g: I3Gui, name: string, rgba: readonly number[]): void {
  const b = g.get(name);
  if (!b) return;
  let d = b.el.querySelector<HTMLElement>(":scope > .clan-swatch");
  if (!d) {
    d = document.createElement("div");
    d.className = "clan-swatch";
    d.style.cssText = "position:absolute;left:3px;top:3px;right:3px;bottom:3px;pointer-events:none;";
    b.el.appendChild(d);
  }
  d.style.background = `rgb(${rgba[0]},${rgba[1]},${rgba[2]})`;
}

export class ClanMarkPicker {
  private gui: I3Gui;
  private mode: "create" | "change" = "create";
  private open = false;
  private parts: ClanMarkParts = { ...MARK_DEFAULT };
  /** page of the back-image group and of the shape-image group */
  private page: [number, number] = [0, 0];
  private hooks: MarkHooks | null = null;

  constructor(ctx: PageCtx, popRoot: GNode) {
    this.gui = pageGui(ctx, TEXTS);
    buildWindows(this.gui, ctx, popRoot, ["clanCreateClanMarkPopup", "changeClanMarkPopup"]);
    const g = this.gui;
    for (const p of PREFIXES) {
      g.button(`${p}Ok`, () => this.ok());
      g.button(`${p}Cancel`, () => this.close());
      g.button(`${p}OverlappingCheck`, () => { if (this.hooks) this.hooks.check(encodeClanMark(this.parts)); });
      g.button(`${p}Prev1`, () => this.turn(0, -1));
      g.button(`${p}Next1`, () => this.turn(0, 1));
      g.button(`${p}Prev2`, () => this.turn(1, -1));
      g.button(`${p}Next2`, () => this.turn(1, 1));
      for (let k = 1; k <= CLAN_MARK_COLOR_COUNT; k++) {
        onClick(g, `${p}BackColorBox${k}`, () => this.pick("backColor", k));
        onClick(g, `${p}ShapeColorBox${k}`, () => this.pick("shapeColor", k));
      }
      for (let j = 1; j <= PER_PAGE; j++) {
        onClick(g, `${p}SelectImage1${j}`, () => this.pick("backImage", this.page[0] * PER_PAGE + j));
        onClick(g, `${p}SelectImage2${j}`, () => this.pick("shapeImage", this.page[1] * PER_PAGE + j));
      }
    }
  }

  get isOpen(): boolean { return this.open; }

  /** opens the picker on `start` (null = the default emblem) for create or for the change item */
  show(mode: "create" | "change", start: ClanMarkParts | null, hooks: MarkHooks): void {
    this.mode = mode;
    this.hooks = hooks;
    this.parts = { ...(start ?? MARK_DEFAULT) };
    this.page = [pageOf(this.parts.backImage), pageOf(this.parts.shapeImage)];
    this.open = true;
    this.paint();
  }

  /** closes the picker (the owner calls it when its action worked, and on Cancel) */
  close(): void {
    this.open = false;
    this.hooks = null;
    this.paint();
  }

  private ok(): void { if (this.hooks) this.hooks.ok(encodeClanMark(this.parts)); }

  private pick(field: keyof ClanMarkParts, v: number): void {
    const max = field === "backImage" ? CLAN_MARK_BACK_IMAGE_COUNT : field === "shapeImage" ? CLAN_MARK_SHAPE_IMAGE_COUNT : CLAN_MARK_COLOR_COUNT;
    if (v < 1 || v > max) return;
    this.parts[field] = v;
    this.paint();
  }

  private turn(group: 0 | 1, d: number): void {
    const count = group === 0 ? CLAN_MARK_BACK_IMAGE_COUNT : CLAN_MARK_SHAPE_IMAGE_COUNT;
    const last = Math.ceil(count / PER_PAGE) - 1;
    this.page[group] = Math.max(0, Math.min(last, this.page[group] + d));
    this.paint();
  }

  private paint(): void {
    const g = this.gui;
    const pre = this.mode === "create" ? PREFIXES[0] : PREFIXES[1];
    g.show("clanCreateClanMarkPopup", this.open && this.mode === "create");
    g.show("changeClanMarkPopup", this.open && this.mode === "change");
    if (!this.open) return;
    const p = this.parts;
    for (let k = 1; k <= CLAN_MARK_COLOR_COUNT; k++) {
      swatch(g, `${pre}BackColorBox${k}`, CLAN_MARK_USER_COLORS[k]);
      swatch(g, `${pre}ShapeColorBox${k}`, CLAN_MARK_USER_COLORS[k]);
    }
    slide(g, `${pre}BackColorSelected`, `${pre}BackColorBox${p.backColor}`, `${pre}BackColorBox1`);
    slide(g, `${pre}ShapeColorSelected`, `${pre}ShapeColorBox${p.shapeColor}`, `${pre}ShapeColorBox1`);
    // the two image groups: 5 cells per page, a cell past the count is hidden; each cell shows its own layer only
    const groups: [0 | 1, number, number][] = [[0, CLAN_MARK_BACK_IMAGE_COUNT, p.backImage], [1, CLAN_MARK_SHAPE_IMAGE_COUNT, p.shapeImage]];
    for (const [grp, count, cur] of groups) {
      for (let j = 1; j <= PER_PAGE; j++) {
        const v = this.page[grp] * PER_PAGE + j, frame = `${pre}SelectFrame${grp + 1}${j}`, img = `${pre}SelectImage${grp + 1}${j}`;
        const on = v <= count;
        g.show(frame, on);
        g.show(img, on);
        if (!on) continue;
        paintMark(g, img, grp === 0
          ? encodeClanMark({ backColor: p.backColor, backImage: v, shapeImage: 0, shapeColor: 0 })
          : encodeClanMark({ backColor: 0, backImage: 0, shapeImage: v, shapeColor: p.shapeColor }));
        const f = g.get(frame);
        if (f) f.el.style.outline = v === cur ? "2px solid #ffd200" : ""; // [RECRIADO] selected cell
      }
    }
    paintMark(g, `${pre}ConfirmImage`, encodeClanMark(p));
  }
}

let picker: Promise<ClanMarkPicker> | null = null;

/** the shared picker: built once from UI_Project_Popup on first use */
export function clanMarkPicker(ctx: PageCtx): Promise<ClanMarkPicker> {
  if (!picker) picker = jsonOnce<{ root: GNode }>(`${BASE}/UI_Project_Popup.json`).then((p) => new ClanMarkPicker(ctx, p.root));
  return picker;
}

/** the item that changes the emblem in the account's inventory (the first one) */
export function clanMarkItem(s: MetaSession): InventoryItem | undefined {
  return [...s.player.state.inventory.values()].find((i) => isClanMarkItem(i.itemId));
}

/** 1052 with the logo (the owner only: the server checks). null = done, else the message to show */
export async function applyClanMark(s: MetaSession, item: InventoryItem, logo: number): Promise<string | null> {
  try {
    const code = await s.changeClanMark(item, logo);
    if (code === 1) return null;
    return `Não foi possível trocar o emblema (0x${(code >>> 0).toString(16)}).`;
  } catch (e) {
    console.warn("[cross] clan mark change", e);
    return "Não foi possível trocar o emblema.";
  }
}

/** 856: is the emblem free (no other clan has it); the message to show */
export async function checkClanMark(s: MetaSession, logo: number): Promise<string> {
  const conn = s.connection;
  if (!conn || !conn.isOpen) return "Sem conexão com o servidor.";
  const c = new ClanClient(conn);
  try {
    const r = await c.checkMark(logo);
    return r.ok ? "Emblema disponível." : "Emblema já usado por outro clã.";
  } catch (e) {
    console.warn("[cross] clan mark check", e);
    return "Sem resposta do servidor.";
  } finally {
    c.dispose();
  }
}
