// "Usar" dos itens de nome e de cor do apelido (Cross): troca de apelido (1800047 -> 1600047), apelido provisório (1600010),
// troca de nome do clã (1800051 -> 1600051) e cor do apelido (1600006). Janelas de UI_Project_Popup: useItemChangeNamePopup
// (os três nomes, mesmo layout) e useItemChangeColorPopup (a cor). Mesmo padrão de clanMarkPicker.ts.
// [RECRIADO] o nome do clã usa a janela de apelido com os textos do clã (o exe tem outra cena, não decodificada); a cor
// usa as 10 caixas do popup, cada uma com NICK_COLORS[k], k = 1..10 [INFERIDO: NICK_COLORS[0] branco é o padrão, sem item].
import { NICK_COLORS } from "../../game/battleChatModel.ts";
import { findUser } from "../../net/friendClient.ts";
import type { MetaSession } from "../state/MetaSession.ts";
import { useEffectOf } from "../state/singleEquip.ts";
import { itemName } from "../state/itemNames.ts";
import type { InventoryItem } from "../types.ts";
import type { GNode, I3Gui } from "../ui/i3Gui.ts";
import { jsonOnce } from "../../jsonOnce.ts";
import { BASE, buildWindows, nickCss, onClick, pageGui, type PageCtx, type Texts } from "./pages/common.ts";
import { slide, swatch } from "./clanMarkPicker.ts";

export type NameKind = "nick" | "fake" | "clan" | "color";

/** the kind of a use item this module opens (null = not one of them); the cash items map through useEffectOf */
export function nameItemKind(itemId: number): NameKind | null {
  switch (useEffectOf(itemId)) {
    case 1600047: return "nick";
    case 1600010: return "fake";
    case 1600051: return "clan";
    case 1600006: return "color";
    default: return null;
  }
}

const POPUP = "UI_Project_Popup";
const NAME_WIN = "useItemChangeNamePopup";
const COLOR_WIN = "useItemChangeColorPopup";
const COLOR_BOXES = 10;

const NAME_TEXTS: Texts = {
  useItemChangeNamePopupOk: ["STBL_IDX_CLAN_BUTTON_OK", "Confirmar"],
  useItemChangeNamePopupCancel: ["STBL_IDX_CLAN_BUTTON_CANCEL", "Cancelar"],
  useItemChangeNamePopupCheck: ["STR_POPUP_CONFIRM_OVERLAPPING", "Verificar"],
};
const COLOR_TEXTS: Texts = {
  useItemChangeColorPopupOk: ["STBL_IDX_CLAN_BUTTON_OK", "Confirmar"],
  useItemChangeColorPopupCancel: ["STBL_IDX_CLAN_BUTTON_CANCEL", "Cancelar"],
};

/** per name kind: caption, "before" label, input label and the nick check (fake nick and clan have none: the server does not check them) */
const NAME_MODE: Record<Exclude<NameKind, "color">, { caption: [string, string]; input: [string, string]; check: boolean }> = {
  nick: { caption: ["STR_HEADER_ITEM_CHANGE_NICK", "Troca de apelido"], input: ["STR_POPUP_MODIFIED_NICK", "Novo apelido:"], check: true },
  fake: { caption: ["STR_HEADER_DISGUISE_NICK", "Apelido provisório"], input: ["STR_POPUP_DISGUISED_NICK", "Apelido temporário:"], check: false },
  clan: { caption: ["STBL_IDX_CLAN_CHANGE_CLAN_NAME", "Alteração do nome do clã"], input: ["STR_POPUP_MODIFIED_CLAN_NAME", "Novo nome:"], check: false },
};

export interface NameHooks {
  /** OK with the typed text: the caller sends the item (the popup stays open until close()) */
  ok: (text: string) => void;
  /** Verificar (nick only): the answer shown under the input */
  check?: (text: string) => Promise<string>;
}

/** useItemChangeNamePopup: the text of a use item (nick / fake nick / clan name), the current name above the input */
export class NameItemPopup {
  private gui: I3Gui;
  private open = false;
  private kind: Exclude<NameKind, "color"> = "nick";
  private hooks: NameHooks | null = null;
  private before = "";
  /** colour index of the current name (null: plain text) */
  private beforeColor: number | null = null;
  private item = "";
  private answer = "";
  private box: HTMLInputElement | null;

  constructor(private ctx: PageCtx, popRoot: GNode) {
    this.gui = pageGui(ctx, NAME_TEXTS);
    buildWindows(this.gui, ctx, popRoot, [NAME_WIN]);
    const g = this.gui;
    g.button(`${NAME_WIN}Ok`, () => this.hooks?.ok(this.box?.value.trim() ?? ""));
    g.button(`${NAME_WIN}Cancel`, () => this.close());
    g.button(`${NAME_WIN}Check`, () => void this.check());
    this.box = g.edit(`${NAME_WIN}UserEdit`, { maxLength: 16, onEnter: () => this.hooks?.ok(this.box?.value.trim() ?? "") });
  }

  get isOpen(): boolean { return this.open; }

  show(kind: Exclude<NameKind, "color">, item: string, before: string, hooks: NameHooks, beforeColor: number | null = null): void {
    this.kind = kind;
    this.item = item;
    this.before = before;
    this.beforeColor = beforeColor;
    this.hooks = hooks;
    this.answer = "";
    this.open = true;
    if (this.box) this.box.value = "";
    this.paint();
  }

  close(): void {
    this.open = false;
    this.hooks = null;
    this.paint();
  }

  private async check(): Promise<void> {
    const check = this.hooks?.check, text = this.box?.value.trim() ?? "";
    if (!check) return;
    this.answer = text ? await check(text) : this.str("STR_POPUP_MESSAGE_INPUT_NAME", "Digite o apelido.");
    this.paint();
  }

  private str(key: string, fallback: string): string { return this.ctx.str(key, fallback); }

  private paint(): void {
    const g = this.gui, m = NAME_MODE[this.kind];
    g.show(NAME_WIN, this.open);
    if (!this.open) return;
    g.setText(`${NAME_WIN}Caption`, this.str(...m.caption));
    g.setText(`${NAME_WIN}ItemValue`, this.item);
    g.setText(`${NAME_WIN}BeforeStatic`, this.str("STR_POPUP_CURRENT_NICK_NAME", "Nome atual:"));
    g.setText(`${NAME_WIN}BeforeValue`, this.before);
    g.setColor(`${NAME_WIN}BeforeValue`, this.beforeColor === null ? "" : nickCss(this.beforeColor));
    g.setText(`${NAME_WIN}UserStatic`, this.str(...m.input));
    g.show(`${NAME_WIN}Check`, m.check);
    g.show(`${NAME_WIN}CheckStatic`, m.check);
    g.setText(`${NAME_WIN}CheckStatic`, this.answer);
  }
}

/** the name the colour applies to (ApplyStatic label + ApplyValue name), painted in the picked colour */
export interface ColorApply { label: [string, string]; name: string }

/**
 * useItemChangeColorPopup: the 10 colour boxes (NICK_COLORS[k]) and the picked colour; OK sends the picked index.
 * Exe (CPopupUseItem 0x8a4bf0 nick / 0x8a5050 clan name): the popup opens on the current colour (OnChangeColorSelect
 * 0x8a4e70(current - 1), -1 when 0); a pick shows the Selected frame on its box and CurrentColorBox in that colour, and
 * 0x8a5034 repaints ApplyValue (the nick / clan name, 0x8a4cc7 / 0x8a5112) in it; no pick hides both and leaves colour 0.
 */
export class NickColorPopup {
  private gui: I3Gui;
  private open = false;
  private sel = 0;
  private item = "";
  private apply: ColorApply | null = null;
  private title: [string, string] = ["STR_HEADER_COLOR_NICK", "Apelido colorido"];
  private hooks: { ok: (index: number) => void } | null = null;

  constructor(private ctx: PageCtx, popRoot: GNode) {
    this.gui = pageGui(ctx, COLOR_TEXTS);
    buildWindows(this.gui, ctx, popRoot, [COLOR_WIN]);
    const g = this.gui;
    g.button(`${COLOR_WIN}Ok`, () => this.ok());
    g.button(`${COLOR_WIN}Cancel`, () => this.close());
    for (let k = 1; k <= COLOR_BOXES; k++) onClick(g, `useItemChangeColorSelectColorBox${k}`, () => this.pick(k));
  }

  get isOpen(): boolean { return this.open; }

  /** title = the popup caption (the nick colour by default; the clan name colour and the muzzle colour pass their own) */
  show(item: string, current: number, hooks: { ok: (index: number) => void }, title?: [string, string], apply: ColorApply | null = null): void {
    this.item = item;
    if (title) this.title = title;
    this.apply = apply;
    this.sel = current > 0 && current <= COLOR_BOXES ? current : 0;
    this.hooks = hooks;
    this.open = true;
    this.paint();
  }

  close(): void {
    this.open = false;
    this.hooks = null;
    this.paint();
  }

  private pick(k: number): void {
    this.sel = k;
    this.paint();
  }

  private ok(): void {
    if (!this.sel) { this.ctx.ctl.say(this.ctx.str("STR_POPUP_MESSAGE_CHOOSE_MODIFY_COLOR", "Escolha a cor desejada."), true); return; }
    this.hooks?.ok(this.sel);
  }

  private paint(): void {
    const g = this.gui, str = this.ctx.str;
    g.show(COLOR_WIN, this.open);
    if (!this.open) return;
    g.setText(`${COLOR_WIN}Caption`, str(...this.title));
    g.setText(`${COLOR_WIN}TitleValue`, this.item);
    g.setText(`${COLOR_WIN}CurrentStatic`, str("STR_POPUP_CURRENT_COLOR", "Cor atual:"));
    g.setText(`${COLOR_WIN}SelectStatic`, str("STR_POPUP_MESSAGE_CHOOSE_MODIFY_COLOR", "Escolha a cor desejada."));
    g.setText(`${COLOR_WIN}NoticeValue`, str("STR_POPUP_MESSAGE_CAN_CHANGE_COLOR", "Deseja utilizar?"));
    g.setText(`${COLOR_WIN}ApplyStatic`, this.apply ? str(...this.apply.label) : "");
    g.setText(`${COLOR_WIN}ApplyValue`, this.apply?.name ?? "");
    g.setColor(`${COLOR_WIN}ApplyValue`, nickCss(this.sel));
    g.show("useItemChangeColorCurrentColorBox", this.sel > 0);
    swatch(g, "useItemChangeColorCurrentColorBox", NICK_COLORS[this.sel] ?? NICK_COLORS[0]);
    for (let k = 1; k <= COLOR_BOXES; k++) swatch(g, `useItemChangeColorSelectColorBox${k}`, NICK_COLORS[k]);
    const sel = g.get("useItemChangeColorSelectColorSelected");
    if (sel) sel.el.style.display = this.sel ? "" : "none";
    if (this.sel) slide(g, "useItemChangeColorSelectColorSelected", `useItemChangeColorSelectColorBox${this.sel}`, "useItemChangeColorSelectColorBox1");
  }
}

let names: Promise<NameItemPopup> | null = null;
let colors: Promise<NickColorPopup> | null = null;

/** the shared popups: built once from UI_Project_Popup on first use (the first caller's ctx) */
const popupPack = () => jsonOnce<{ root: GNode }>(`${BASE}/${POPUP}.json`);
export function nameItemPopup(ctx: PageCtx): Promise<NameItemPopup> {
  if (!names) names = popupPack().then((p) => new NameItemPopup(ctx, p.root));
  return names;
}
export function nickColorPopup(ctx: PageCtx): Promise<NickColorPopup> {
  if (!colors) colors = popupPack().then((p) => new NickColorPopup(ctx, p.root));
  return colors;
}

/** the nick check of Verificar: findUser (friend search, USER_DETAIL_ACK result 0) answers true when the account exists = taken [INFERIDO] */
async function nickFree(s: MetaSession, nick: string): Promise<string> {
  const conn = s.connection;
  if (!conn || !conn.isOpen) return "Sem conexão com o servidor.";
  try {
    return (await findUser(conn, nick)) ? "Apelido já está em uso ou não é permitido." : "O apelido está disponível";
  } catch (e) {
    console.warn("[cross] nick check", e);
    return "Sem resposta do servidor.";
  }
}

/**
 * "Usar" of a name / colour item: opens its popup and sends 1052 on OK (1052 text for the names, 1052 index for the colour).
 * The message box shows the outcome; the popup closes when the server accepts. Only call it when nameItemKind() is set.
 */
export async function useNameItem(ctx: PageCtx, item: InventoryItem, kind: NameKind): Promise<void> {
  const c = ctx.ctl, s = c.session;
  if (!s) return;
  const str = ctx.str;
  const name = itemName(item.itemId).name;
  if (kind === "color") {
    const p = await nickColorPopup(ctx);
    const current = s.player.state.invItem?.nickColor ?? s.lobby.playerList().find((u) => u.nickname === s.player.state.profile?.nickname)?.nickColor ?? 0;
    // 0x8a4cc7: ApplyValue = my nick (0x5984b0 copy of my basic info)
    p.show(name, current, {
      ok: (index) => {
        void s.changeNickColor(item, index).then((code) => {
          if (code !== 1) { c.say(`Não foi possível trocar a cor (0x${(code >>> 0).toString(16)}).`, true); return; }
          p.close();
          c.say("Cor do apelido alterada.", true); // [RECRIADO] text
        }, () => c.say("Não foi possível trocar a cor.", true));
      },
    }, undefined, { label: ["STR_POPUP_APPLIED_NICK_NAME", "Apelido aplicado:"], name: s.player.state.profile?.nickname ?? "" });
    return;
  }
  const p = await nameItemPopup(ctx);
  const before = kind === "clan" ? s.player.state.profile?.clanName ?? "" : s.player.state.profile?.nickname ?? "";
  // 0x8a3da7 (nick) / 0x8a48d7 (fake nick): BeforeValue = my nick in my nick colour (basic info +0x47); the clan name scene is not decoded
  const beforeColor = kind === "clan" ? null : s.player.state.invItem?.nickColor ?? 0;
  p.show(kind, name, before, {
    ok: (text) => {
      if (!text) { c.say(str("STR_POPUP_MESSAGE_INPUT_NAME", "Digite o apelido."), true); return; }
      void s.useItemText(item, text).then((code) => {
        if (code !== 1) { c.say(`Não foi possível trocar o nome (0x${(code >>> 0).toString(16)}).`, true); return; }
        p.close();
        c.say(kind === "clan"
          ? str("STR_TBL_CLAN_NAMECHANGE_SUCCESS", "Nome do clã trocado.")
          : `${str("STR_POPUP_APPLIED_NICK_NAME", "Apelido aplicado:")} ${text}`, true);
      }, () => c.say("Não foi possível trocar o nome.", true));
    },
    check: kind === "nick" ? (text) => nickFree(s, text) : undefined,
  }, beforeColor);
}
