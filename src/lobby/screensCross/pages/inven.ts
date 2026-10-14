// Cross inventory page (UI_Project_Inven, CStepInventory 0x840a70): ivEquipmentWin (equipped weapons), ivCharacterWin
// (team characters / head / beret), ivInvenWin (Weapon / Character / Item tabs, filter buttons, item grid, info frame,
// Equipar). Data and actions are the Lobby2017 controller's inventory (menu state, "tabs" / "hit slot<i>" / "mount<i>" /
// "list i3UIButtonComposed31" clicks: the 2017 control names), so the equip path is the same 6149 request.
import type { GNode, I3Gui } from "../../ui/i3Gui.ts";
import { INV_SUBS, INV_TABS, MAIN_BUTTONS } from "../../core/model.ts";
import { inventoryData, inventoryItems, termText } from "../../screens/model.ts";
import { equipSlotOf, itemTerm, type ItemFilter, type ItemTab } from "../../state/itemInfo.ts";
import { prefetchModels } from "../preview.ts";
import { itemName } from "../../state/itemNames.ts";
import { EquipSlot, type InventoryItem } from "../../types.ts";
import { CLAN_MARK_DEFAULT, decodeClanMark } from "../../clanMark.ts";
import { GameMetaOp, parseDeleteItem } from "../../../net/metaGame.ts";
import { PacketWriter } from "../../../net/packet.ts";
import { applyClanMark, checkClanMark, clanMarkPicker, isClanMarkItem } from "../clanMarkPicker.ts";
import { nameItemKind, useNameItem } from "../itemNamePopups.ts";
import { effectItemKind, useEffectItem } from "../itemEffectPopups.ts";
import { charaDescription } from "../charaDescription.ts";
import {
  SlotGrid, WeaponDetail, askRepair, buildWindows, paintDurability, repairCost, rightAlign, setTab, loadPack, onClick, pageGui, paintStats, setIcon, statTexts, weaponStats,
  type PageCtx, type Texts,
} from "./common.ts";

/** control -> STR of cross-ui-map.json (ivInvenWin / ivEquipmentWin / ivCharacterWin, confidence str:exe); the
 * equipment row keys are set by 0x8431d0 (STR_INVEN_PRIMARY..SPECIAL_WEAPON on this+0xac..0xdc) */
const TEXTS: Texts = {
  ivEquipmentCaption: ["STR_INVEN_USED_EQUIP", "Equipamento usado"], ivCharacterCaption: ["STR_INVEN_USED_CHARA", "Personagem em uso"],
  ivRedTypeKey: ["STR_INVEN_RED_CHARA", "Personagem rebelde"], ivBlueTypeKey: ["STR_INVEN_BLUE_CHARA", "Personagem da OTP"],
  ivHeadKey: ["STR_INVEN_HEAD", "Cabeça"], ivBeretKey: ["STR_INVEN_BERET", "Boina"],
  ivInvenCaption: ["STR_INVEN_INVENTORY", "Inventário"],
  ivAllWeapon: ["STR_INVEN_VIEW_ALL", "Ver tudo"], ivPrimaryWeapon: ["STR_INVEN_PRIMARY_WEAPON", "Arma primária"], ivSecondaryWeapon: ["STR_INVEN_SECONDARY_WEAPON", "Arma secundária"],
  ivMeleeWeapon: ["STR_INVEN_MELEE_WEAPON", "Arma branca"], ivThrowingWeapon: ["STR_INVEN_THROWING_WEAPON", "Granada"], ivItemWeapon: ["STR_INVEN_SPECIAL_WEAPON", "Arma especial"],
  ivPrimaryKey: ["STR_INVEN_PRIMARY_WEAPON", "Arma primária"], ivSecondaryKey: ["STR_INVEN_SECONDARY_WEAPON", "Arma secundária"], ivMeleeKey: ["STR_INVEN_MELEE_WEAPON", "Arma branca"],
  ivThrowingKey: ["STR_INVEN_THROWING_WEAPON", "Granada"], ivItemKey: ["STR_INVEN_SPECIAL_WEAPON", "Arma especial"],
  ivAllCharacter: ["STR_INVEN_VIEW_ALL", "Ver tudo"], ivTypeCharacter: ["STR_INVEN_CHRACTER", "Personagem"], ivHeadCharacter: ["STR_INVEN_HEAD", "Cabeça"], ivBeretCharacter: ["STR_INVEN_BERET", "Boina"],
  ivItemGroupAll: ["STR_INVEN_VIEW_ALL", "Ver tudo"],
  ivItemGroupMaintenance: ["STR_INVEN_MAINTENANCE_ITEM", "Durab."], ivItemGroupExpendable: ["STR_INVEN_EXPENDABLES", "Consumível"],
  ivCharacterTermKey: ["STR_INVEN_REMAIN_TERM", "Tempo restante"], ivItemDetailTermKey: ["STR_INVEN_REMAIN_TERM", "Tempo restante"],
  ...statTexts("iv", "STR_INVEN_BULLETS", "STR_INVEN_WEAPON_RANGE"),
  ivInvenWeaponInfoDetail: ["STR_INVEN_DETAIL_INFO", "Detalhes"], ivCharacterDetail: ["STR_INVEN_DETAIL_INFO", "Detalhes"],
  // ivInvenWeaponRepair's map entry carries several STR (the exe relabels it): Reparar is the one the chara button uses
  ivInvenWeaponRepair: ["STR_INVEN_DO_REPAIR", "Reparar"], ivInvenCharaRepair: ["STR_INVEN_DO_REPAIR", "Reparar"],
};

/** controls with no web equivalent: sale marks, extensions, auth (key items), the character remove button (0x849521 enables
 * it: deletes the character, no server path), dino slot, red / blue combo */
const HIDDEN = [
  "ivDinoTypeSlot", "ivCharacterSeparate6", "ivInvenWeaponInfoAuth", "ivWeaponInfoExtension",
  "ivCharacterAuth", "ivCharacterRemove", "ivCharacterTypeCombo",
];

/** GUI colour table index 2 (0x791000, read by 0x7913c0) */
const GUI_COLOR_2 = "#999999";
const WEAPON_SLOTS = Array.from({ length: 8 }, (_, i) => `ivWeaponSlot${i + 1}`);
const CHARA_SLOTS = Array.from({ length: 9 }, (_, i) => `ivCharacterSlot${i + 1}`);
const ITEM_SLOTS = Array.from({ length: 9 }, (_, i) => `ivItemSlot${i + 1}`);
/** per-slot children: [name, icon dummy, term, used badge, hidden extras] */
const SLOT_PARTS: Record<ItemTab, (k: number) => { value: string; dummy: string; term: string; used: string; hide: string[] }> = {
  weapon: (k) => ({ value: `ivWeaponSlotValue${k}`, dummy: `ivWeaponSlotDummy${k}`, term: `ivWeaponSlotTerm${k}`, used: `ivWeaponSlotUsed${k}`,
    hide: [`ivWeaponSlotKey${k}`, `ivWeaponSlotSaleMark${k}`, `ivWeaponSlotExtension${k}`, `ivWeaponSlotFilter${k}`] }),
  chara: (k) => ({ value: `ivCharacterValue${k}`, dummy: `ivCharacterDummy${k}`, term: `ivCharacterTerm${k}`, used: `ivCharacterUsed${k}`,
    hide: [`ivCharacterSaleMark${k}`, `ivCharacterFilter${k}`] }),
  item: (k) => ({ value: `ivItemSlotValue${k}`, dummy: `ivItemSlotDummy${k}`, term: `ivItemSlotTerm${k}`, used: `ivItemSlotUsed${k}`,
    hide: [`ivItemSlotSaleMark${k}`, `ivItemSlotFilter${k}`] }),
};
const TAB_BUTTON: Record<ItemTab, string> = { weapon: "ivInvenWeaponTab", chara: "ivInvenCharaTab", item: "ivInvenItemTab" };
const SECTION: Record<ItemTab, string> = { weapon: "ivWeapon", chara: "ivCharacter", item: "ivItemSect" };
/** Cross filter button -> 2017 filter (INV_SUBS) */
const FILTERS: Record<ItemTab, [string, ItemFilter][]> = {
  weapon: [["ivAllWeapon", "all"], ["ivPrimaryWeapon", "primary"], ["ivSecondaryWeapon", "secondary"], ["ivMeleeWeapon", "melee"], ["ivThrowingWeapon", "throw"], ["ivItemWeapon", "special"]],
  chara: [["ivAllCharacter", "all"], ["ivTypeCharacter", "chara"], ["ivHeadCharacter", "head"], ["ivBeretCharacter", "beret"]],
  item: [["ivItemGroupAll", "all"], ["ivItemGroupMaintenance", "maintenance"], ["ivItemGroupExpendable", "expendable"]],
};
/** the equipment window's rows: [row prefix, slot]; 0x8431d0 aligns the key left / middle and the value right / middle,
 * both in GUI colour 2 */
const EQUIP_ROWS: [string, number][] = [["ivPrimary", EquipSlot.Primary], ["ivSecondary", EquipSlot.Secondary], ["ivMelee", EquipSlot.Melee], ["ivThrowing", EquipSlot.Throw], ["ivItem", EquipSlot.Special]];
/** durability bar of a slot (repairable items only) */
const DURABILITY: Partial<Record<ItemTab, (k: number) => [bar: string, gauge: string]>> = {
  weapon: (k) => [`ivWeaponSlotDurabilityBar${k}`, `ivWeaponSlotDurabilityGauge${k}`],
  chara: (k) => [`ivCharaSlotDurabilityBar${k}`, `ivCharaSlotDurabilityGauge${k}`],
};
/** Reparar of the weapon / character info frames (ivInvenCharaRepair 0x84be00): shown for repairable items */
const REPAIR: Partial<Record<ItemTab, string>> = { weapon: "ivInvenWeaponRepair", chara: "ivInvenCharaRepair" };
/** the equip button of each tab's info frame */
const ACTION: Record<ItemTab, string> = { weapon: "ivInvenWeaponInfoUse", chara: "ivCharacterEquip", item: "ivItemDetailUse" };

/** Usar of the items with their own popup (emblem, names, nick colour, effects); false = a normal item. The inventory's Usar
 * and the shop's "use now" after a purchase (controller cosmeticUse, set in pages/index.ts) both come here. */
export function useCosmeticItem(ctx: PageCtx, it: InventoryItem): boolean {
  if (isClanMarkItem(it.itemId)) { void openClanMark(ctx, it); return true; }
  const kind = nameItemKind(it.itemId);
  if (kind) { void useNameItem(ctx, it, kind); return true; }
  const effect = effectItemKind(it.itemId);
  if (effect) { void useEffectItem(ctx, it, effect); return true; }
  return false;
}

/** Usar do item de troca de emblema: the emblem picker starts on my clan's emblem; its OK sends 1052 with the logo */
async function openClanMark(ctx: PageCtx, item: InventoryItem): Promise<void> {
  const c = ctx.ctl, s = c.session;
  if (!s) return;
  const p = await clanMarkPicker(ctx);
  p.show("change", decodeClanMark(s.player.state.profile?.clanLogo ?? CLAN_MARK_DEFAULT), {
    ok: (logo) => void useClanMark(ctx, item, logo),
    check: (logo) => void checkClanMark(s, logo).then((m) => c.say(m, true)),
  });
}

/** 1052 with the logo (server handleUseItem: the owner only, emblem must be free); the profile takes the new emblem */
async function useClanMark(ctx: PageCtx, item: InventoryItem, logo: number): Promise<void> {
  const c = ctx.ctl, s = c.session;
  if (!s) return;
  const err = await applyClanMark(s, item, logo);
  if (err) { c.say(err, true); return; }
  const pr = s.player.state.profile;
  if (pr) s.player.dispatch({ type: "profile", basic: { ...pr, clanLogo: logo } });
  (await clanMarkPicker(ctx)).close();
  c.say("Emblema alterado.", true); // [RECRIADO] text
}

export class InvenPage {
  private gui: I3Gui;
  private grids: Record<ItemTab, SlotGrid>;
  private view = "";
  private repaints: (() => void)[] = [];
  private detail: WeaponDetail;

  static async create(ctx: PageCtx): Promise<InvenPage> {
    const [pack, detail] = await Promise.all([loadPack("UI_Project_Inven"), WeaponDetail.create(ctx)]);
    return new InvenPage(ctx, pack.root, detail);
  }

  private constructor(private ctx: PageCtx, root: GNode, detail: WeaponDetail) {
    this.detail = detail;
    const gui = (this.gui = pageGui(ctx, TEXTS));
    buildWindows(gui, ctx, root, ["ivEquipmentWin", "ivCharacterWin", "ivInvenWin"]);
    for (const n of HIDDEN) gui.hide(n);
    const c = ctx.ctl;
    const items = () => (c.session ? inventoryItems(c.session.player, c.menu) : []);
    const sel = (k: number) => items()[k]?.objectId === c.menu.selected;
    this.grids = {
      weapon: new SlotGrid(gui, c, WEAPON_SLOTS, 2, "ivWeaponList", () => items().length, sel),
      chara: new SlotGrid(gui, c, CHARA_SLOTS, 3, "ivCharacterList", () => items().length, sel),
      item: new SlotGrid(gui, c, ITEM_SLOTS, 3, "ivItemSlotList", () => items().length, sel),
    };
    // double click on the emblem change item: the emblem picker (the grid's double click would equip it: 1050 fails)
    ITEM_SLOTS.forEach((n, i) => gui.get(n)?.el.addEventListener("dblclick", (e) => {
      const it = items()[this.grids.item.top + i];
      if (!it || !(isClanMarkItem(it.itemId) || nameItemKind(it.itemId) || effectItemKind(it.itemId))) return;
      e.stopImmediatePropagation();
      useCosmeticItem(this.ctx, it);
    }, { capture: true }));
    for (const t of Object.keys(TAB_BUTTON) as ItemTab[]) {
      onClick(gui, TAB_BUTTON[t], () => c.click("tabs", INV_TABS.find(([, x]) => x === t)![0]));
      for (const [btn, f] of FILTERS[t]) onClick(gui, btn, () => c.click("tabs", INV_SUBS[t].find(([, x]) => x === f)![0]));
      // Usar of the emblem change item (1600052) and of the name / nick colour items: their own popup, not the controller's 1050 activation
      this.repaints.push(gui.button(ACTION[t], () => {
        const it = this.selected();
        if (t === "item" && it && useCosmeticItem(this.ctx, it)) return;
        else if (t === "item" && it && c.session?.player.needsActivation(it)) this.askUse(it);
        else c.click("list", "i3UIButtonComposed31");
      }, () => this.actionEnabled()));
    }
    // Excluir (ivItemDelete, 0x84bc60 TogglePopup -> deleteItemQueryPopup): the selected item of the item tab
    this.repaints.push(gui.button("ivItemDelete", () => { const it = this.selected(); if (it) this.askDelete(it); }, () => !!this.selected() && !c.busy));
    // the red / blue character rows pick the team the next character goes to (controller "mount0" / "mount1")
    onClick(gui, "ivRedTypeSlot", () => c.click("hit", "mount0"));
    onClick(gui, "ivBlueTypeSlot", () => c.click("hit", "mount1"));
    gui.button("ivInvenLeave", () => c.click("main", MAIN_BUTTONS.back));
    // Detalhes (ivInvenWeaponInfoDetail 0x842fb0): the selected weapon in weExtensionWin
    this.repaints.push(gui.button("ivInvenWeaponInfoDetail", () => { const it = this.selected(); if (it) detail.open(it.itemId); }, () => { const it = this.selected(); return !!it && !!weaponStats(it.itemId, () => c.draw()); }));
    // Detalhes of the character info (ivCharacterDetail): its handler 0x846ef0 is an empty body, and the init (0x847f52)
    // shows it with setInputDisable(1) + caption colour 2 that nothing turns back on, so it stays a greyed button
    this.repaints.push(gui.button("ivCharacterDetail", () => {}, () => false));
    gui.setColor("ivCharacterDetail", GUI_COLOR_2);
    for (const b of Object.values(REPAIR)) {
      this.repaints.push(gui.button(b, () => { const it = this.selected(); if (it) askRepair(ctx, it); },
        () => { const it = this.selected(), s = c.session; return !!it && !!s && !c.busy && (repairCost(s, it)?.damage ?? 0) > 0; }));
    }
  }

  private selected(): InventoryItem | undefined {
    const c = this.ctx.ctl;
    return c.menu.selected !== null ? c.session?.player.state.inventory.get(c.menu.selected) : undefined;
  }

  private actionEnabled(): boolean {
    const c = this.ctx.ctl;
    if (!c.session || c.busy) return false;
    // the emblem change item has no equip slot (equipState greys it out); its Usar opens the emblem picker
    const it = this.selected();
    if (it && (isClanMarkItem(it.itemId) || nameItemKind(it.itemId) || effectItemKind(it.itemId))) return true;
    return inventoryData(c.session.player, c.menu).actionEnabled;
  }

  /** Usar of a Durable item (CPopupUseItem useItemQueryPopup, 0x89f540): "Item usado:", "Atributo:" and "Deseja usar o
   * item?"; OK runs the controller's equip with its start-auth question already answered (the 1050 activation) */
  private askUse(it: InventoryItem): void {
    const c = this.ctx.ctl, str = this.ctx.str;
    c.msg = {
      text: `${str("STR_POPUP_USE_ITEM", "Item usado:")} ${itemName(it.itemId).name}\n${str("STR_POPUP_ITEM_ATTRIBUTE", "Atributo:")} ${termText(itemTerm(it))}\n\n${str("STR_POPUP_Q_MESSAGE_WANT_USE_ITEM", "Deseja usar o item?")}`,
      onOk: () => { c.menu.confirming = true; void c.equip(); },
      onCancel: () => {},
    };
    c.draw();
  }

  /** Excluir (CPopupDeleteItem deleteItemQueryPopup, 0x8a5c20): item, "Restante" term, the question and the red warning; OK
   * asks STR_INVEN_MESSAGE_DELETE_ITEM, then deleteItem. The popup's {col} markup is dropped (the message box is plain text) */
  private askDelete(it: InventoryItem): void {
    const c = this.ctx.ctl, str = this.ctx.str;
    const warning = str("STR_POPUP_Q_MESSAGE_WARNING_DELETE_ITEM", "Itens excluídos não poderão ser recuperados!").replace(/\{[^}]*\}/g, "");
    c.msg = {
      text: `${str("STR_POPUP_DELETE_ITEM", "Excluir Item")}: ${itemName(it.itemId).name}\n${str("STR_POPUP_TERM_DELETE_ITEM", "Restante")}: ${termText(itemTerm(it))}\n\n${str("STR_POPUP_Q_MESSAGE_WANT_DELETE_ITEM", "Tem certeza que deseja excluir?")}\n${warning}`,
      onOk: () => {
        c.msg = { text: str("STR_INVEN_MESSAGE_DELETE_ITEM", "Deseja excluir o item?"), onOk: () => void this.deleteItem(it.objectId), onCancel: () => {} };
        c.draw();
      },
      onCancel: () => {},
    };
    c.draw();
  }

  /** 1055 INVENTORY delete (`D objectId`, server handleDeleteItem) answered by 1059 (`D err, D objId`); the MetaSession
   * listener drops the item from the store on the ack. Result text: STR_INVEN_DELETE_ITEM_SUCCESS / _FAIL */
  private async deleteItem(objectId: number): Promise<void> {
    const c = this.ctx.ctl, str = this.ctx.str, conn = c.session?.connection;
    if (!conn || !conn.isOpen) { c.say(str("STR_INVEN_DELETE_ITEM_FAIL", "Falha ao excluir o item\npor problemas na rede."), true); return; }
    c.busy = true; c.draw();
    try {
      const ack = conn.waitFor(GameMetaOp.SHOP_DELETE_ITEM_ACK, 5000);
      conn.send(1055, new PacketWriter(4).writeD(objectId >>> 0));
      const d = parseDeleteItem(await ack);
      if (d.ok) { c.menu.selected = null; c.say(str("STR_INVEN_DELETE_ITEM_SUCCESS", "Os itens foram removidos.")); }
      else c.say(str("STR_INVEN_DELETE_ITEM_FAIL", "Falha ao excluir o item\npor problemas na rede."), true);
    } catch {
      c.say(str("STR_INVEN_DELETE_ITEM_FAIL", "Falha ao excluir o item\npor problemas na rede."), true);
    } finally {
      c.busy = false; c.draw();
    }
  }

  paint(): void {
    const c = this.ctx.ctl, s = c.session, gui = this.gui, ui = c.menu;
    const on = c.page === "inventory" && !!s;
    for (const w of ["ivEquipmentWin", "ivCharacterWin", "ivInvenWin"]) gui.show(w, on);
    this.detail.paint(on);
    if (!on) { this.view = ""; return; }
    const p = s.player, tab = ui.tab;
    // a new tab / filter starts at the top of the list
    const view = `${tab}/${ui.filter}/${ui.search}`;
    if (view !== this.view) { this.view = view; for (const g of Object.values(this.grids)) g.top = 0; }
    // tab handlers 0x8427c0 (weapon: equipment on, character off), 0x8469b0 (character: the reverse), 0x84b590 (item: both off)
    gui.show("ivEquipmentWin", tab === "weapon");
    gui.show("ivCharacterWin", tab === "chara");
    for (const t of Object.keys(TAB_BUTTON) as ItemTab[]) {
      gui.show(SECTION[t], t === tab);
      setTab(gui, TAB_BUTTON[t], t === tab);
      for (const [btn, f] of FILTERS[t]) gui.setState(btn, t === tab && f === ui.filter ? 2 : 0);
    }
    // equipped weapons / characters
    const eq = p.equipPairs(), team = p.teamCharas();
    for (const [row, slot] of EQUIP_ROWS) {
      const id = eq[slot]?.itemId ?? 0;
      gui.setText(`${row}Value`, id ? itemName(id).name : "");
      for (const n of [`${row}Key`, `${row}Value`]) gui.setColor(n, GUI_COLOR_2);
      rightAlign(gui, `${row}Value`);
      setIcon(gui, `${row}Slot`, id);
    }
    for (const [row, id] of [["ivRedType", team.red], ["ivBlueType", team.blue], ["ivHead", eq[EquipSlot.Head]?.itemId ?? 0], ["ivBeret", eq[EquipSlot.Beret]?.itemId ?? 0]] as const) setIcon(gui, `${row}Dummy`, id);
    gui.setColor("ivRedTypeKey", ui.team === 0 ? "#ffd24a" : "#c9ced6");
    gui.setColor("ivBlueTypeKey", ui.team === 1 ? "#ffd24a" : "#c9ced6");
    // the grid of the open tab
    const list = inventoryItems(p, ui), grid = this.grids[tab];
    const equipped = (it: InventoryItem) => (equipSlotOf(it.itemId) === EquipSlot.Chara ? it.itemId === team.red || it.itemId === team.blue : p.isEquipped(it));
    grid.paint();
    prefetchModels(tab, grid.names.flatMap((_, i) => { const k = grid.at(i); return k === null || !list[k] ? [] : [list[k].itemId]; }));
    grid.names.forEach((_, i) => {
      const k = grid.at(i), it = k === null ? undefined : list[k], parts = SLOT_PARTS[tab](i + 1);
      for (const h of parts.hide) gui.hide(h);
      gui.setText(parts.value, it ? itemName(it.itemId).name : "");
      gui.setText(parts.term, it && !equipped(it) ? termText(itemTerm(it)) : "");
      setIcon(gui, parts.dummy, it?.itemId ?? 0);
      // Used badge (main_ui_source02 463,0..53): 0 "Equipado", 1 "Sem Uso" (not activated yet), 2 "Usado"
      const badge = !it ? -1 : equipped(it) ? 0 : itemTerm(it).kind === "unused" ? 1 : -1;
      gui.show(parts.used, badge >= 0);
      if (badge >= 0) gui.setState(parts.used, badge);
      const dur = DURABILITY[tab]?.(i + 1);
      if (dur) paintDurability(gui, dur[0], dur[1], s, it);
    });
    // info frame of the selected item + the equip button (label from the controller: Equipar / Equipado / Remover)
    const sel = ui.selected !== null ? p.state.inventory.get(ui.selected) : undefined, d = inventoryData(p, ui);
    const name = sel ? itemName(sel.itemId).name : "", term = sel ? termText(itemTerm(sel)) : "";
    if (tab === "weapon") {
      gui.setText("ivWeaponValue", name);
      gui.hide("ivWeaponKey");
      gui.setText("ivTerm", term);
      setIcon(gui, "ivWeaponDummy", sel?.itemId ?? 0);
      paintStats(gui, "iv", sel ? weaponStats(sel.itemId, () => c.draw()) : null);
    } else {
      const pre = tab === "chara" ? "ivCharacter" : "ivItemDetail";
      gui.setText(`${pre}InfoValue`, name);
      gui.setText(`${pre}TermValue`, term);
      gui.show(`${pre}TermKey`, !!sel);
      setIcon(gui, `${pre}InfoDummy`, sel?.itemId ?? 0);
      // exe 0x849130: +0x5f4 <- CharaInfoDataBase::GetDescription (empty: no "Description" key in any client's Character.pef), then SetShow 1.
      // The Cross keeps it empty; charaDescription fills it with real pef numbers [RECRIADO]
      if (tab === "chara") {
        gui.setText("ivCharacterDescription", sel ? charaDescription(sel.itemId, this.ctx.str) : "");
        gui.show("ivCharacterDescription", !!sel);
      } else gui.hide("ivItemDetailDescription");
    }
    gui.setText(ACTION[tab], d.actionLabel);
    // nothing picked (a filter / tab change sets +0x9c = -1 at 0x8462a0 / 0x8427c0, no auto-pick unlike the shop): the info
    // refreshes 0x845430 (weapon), 0x849130 (character), 0x84aaf0 (item) leave the frame up but hide its dummy, name,
    // term, Detalhes, equip and repair buttons, then return
    gui.show(ACTION[tab], !!sel);
    gui.show(tab === "weapon" ? "ivInvenWeaponInfoDetail" : "ivCharacterDetail", !!sel);
    gui.show("ivItemDelete", tab === "item" && !!sel);
    for (const [t, b] of Object.entries(REPAIR)) gui.show(b, t === tab && !!sel && !!repairCost(s, sel));
    for (const f of this.repaints) f();
  }
}
