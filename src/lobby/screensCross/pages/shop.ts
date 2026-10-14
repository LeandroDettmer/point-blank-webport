// Cross shop page (UI_Project_Shop, CStepShop 0x84d1d0): shopWin with the Weapon / Character / Item tabs, filter buttons,
// the item grid, the info frame and the goods frame (4 price options + Comprar), and the buy confirmation
// (UI_Project_Popup shopBuyPopup). Data and actions are the Lobby2017 controller's shop: "menu" tab / filter clicks, "hit
// slot<i>", openBuy + "buy" radio / currency / SBN_Buy (the same 1029 / 1045 path as the 2017 lobby).
import type { GNode, I3Gui } from "../../ui/i3Gui.ts";
import { MAIN_BUTTONS, SHOP_SUBS, SHOP_TABS } from "../../core/model.ts";
import { MAX_OPTIONS, optionText, shopOffers, termText } from "../../screens/model.ts";
import { fmtInt } from "../../screens/model.ts";
import { BuyType } from "../../types.ts";
import { priceIn, type ShopOffer } from "../../state/ShopStore.ts";
import { countIsSeconds, itemTerm, type ItemFilter, type ItemTab } from "../../state/itemInfo.ts";
import { prefetchModels } from "../preview.ts";
import { charaDescription } from "../charaDescription.ts";
import { itemName } from "../../state/itemNames.ts";
import {
  SlotGrid, WeaponDetail, askRepair, buildWindows, ownedRepairable, repairCost, rightAlign, setTab, loadPack, onClick, pageGui, paintStats, setIcon,
  statTexts, weaponStats, type PageCtx, type Texts,
} from "./common.ts";

type Currency = "gold" | "cash";

/** control -> STR of cross-ui-map.json (shopWin / shopBuyPopup, confidence str:exe); the have / remain labels are in
 * MONEY_LABELS */
const TEXTS: Texts = {
  shopWinCaption: ["STBL_IDX_SHOP_CAPTION", "Loja"],
  shopAllWeapon: ["STBL_IDX_SHOP_FILTER_ALL", "Ver todos"], shopPrimaryWeapon: ["STBL_IDX_SHOP_FILTER_PRIMARY", "Arma primária"], shopSecondaryWeapon: ["STBL_IDX_SHOP_FILTER_SECONDARY", "Arma secundária"],
  shopMeleeWeapon: ["STBL_IDX_SHOP_FILTER_MELEE", "Arma branca"], shopThrowingWeapon: ["STBL_IDX_SHOP_FILTER_THROWING", "Granada"], shopItemWeapon: ["STBL_IDX_SHOP_FILTER_SPECIAL", "Arma especial"],
  shopAllCharacter: ["STBL_IDX_SHOP_FILTER_ALL", "Ver todos"], shopTypeCharacter: ["STBL_IDX_SHOP_FILTER_CHARA", "Personagem"], shopHairCharacter: ["STBL_IDX_SHOP_FILTER_HEAD", "Cabeça"],
  shopItemAllGroup: ["STBL_IDX_SHOP_FILTER_ALL", "Ver todos"],
  shopItemGroupMaintenance: ["STR_INVEN_MAINTENANCE_ITEM", "Durab."], shopItemGroupExpendable: ["STR_INVEN_EXPENDABLES", "Consumível"],
  shopWeaponGoodsBuy: ["STBL_IDX_SHOP_BUY", "Comprar"], shopCharacterGoodsBuy: ["STBL_IDX_SHOP_BUY", "Comprar"], shopItemGoodsBuy: ["STBL_IDX_SHOP_BUY", "Comprar"],
  shopWeaponGoodsCombo1: ["STBL_IDX_SHOP_INFO_BUYTYPE_POINT", "Gold"], shopWeaponGoodsCombo2: ["STBL_IDX_SHOP_INFO_BUYTYPE_CASH", "Cash"],
  shopCharacterTermKey: ["STBL_IDX_SHOP_USE_TERM", "Tempo restante"],
  shopCharacterPointInfoStatic: ["STBL_IDX_SHOP_INFO_POINT", "Preço"], shopItemPointInfoStatic: ["STBL_IDX_SHOP_INFO_POINT", "Preço"],
  ...statTexts("shop", "STBL_IDX_SHOP_WEAPON_BULLET", "STBL_IDX_SHOP_WEAPON_RANGE"),
  // the shop's own keys: 0xa65c48..0xa65d1f SetText(STBL_IDX_SHOP_WEAPON_*) on the stat rows (members 0x238..0x274)
  shopDamageKey: ["STBL_IDX_SHOP_WEAPON_DAMAGE", "Dano"], shopRapidKey: ["STBL_IDX_SHOP_WEAPON_RAPID", "Taxa de disparo"],
  shopHitRateKey: ["STBL_IDX_SHOP_WEAPON_HIT_RATE", "Precisão"], shopVertRecoilKey: ["STBL_IDX_SHOP_WEAPON_VERT_RECOIL", "Recuo v."],
  shopHorzRecoilKey: ["STBL_IDX_SHOP_WEAPON_HORZ_RECOIL", "Recuo h."], shopSpeedKey: ["STBL_IDX_SHOP_WEAPON_SPEED", "Peso"],
  shopBuyCaption: ["STBL_IDX_EP_SHOP_BUY_SUCCESS_CAPTION", "Confirmar"], shopBuyOk: ["STBL_IDX_BUTTON_OK", "Confirmar"], shopBuyCancel: ["STR_POPUP_LEAVE", "Sair"],
  shopGiftCaption: ["STBL_IDX_EP_SHOP_GIFT_CAPTION", "Enviar presente"], shopGiftReceiverNameStatic: ["STBL_IDX_SHOP_RECEIVER", "Destinatário"],
  shopGiftOk: ["STBL_IDX_BUTTON_OK", "Confirmar"], shopGiftCancel: ["STBL_IDX_BUTTON_CANCEL", "Cancelar"],
  shopWeaponInfoDetail: ["STBL_IDX_SHOP_DETAIL", "Detalhes"],
  // repair frames: Reparo / Custo de reparo are the exe's (str:exe)
  ...Object.fromEntries(["shopWeapon", "shopChara"].flatMap((r) => [
    [`${r}DoRepair`, ["STR_SHOP_DO_REPAIR", "Reparo"]], [`${r}RepairText`, ["STR_POPUP_REPAIR_PRICE", "Custo de reparo"]]])),
};

/** have / remain money labels: sprintf("%s :", STBL_IDX_SHOP_HAVE_MONEY / REMAIN_MONEY), SetTextAlign(2, 1) (right / middle).
 * Goods frames: item 0xa5ea38 (this+0xa8 / 0xb8), chara 0xa62193, weapon 0xa65f8d; repair frames: chara 0xa60bfd (+0x1c /
 * 0x28), weapon 0xa6443d; buy popup 0x890b7a (CPopupShopBuy +0xc8 / 0xcc) */
const MONEY_LABELS: [control: string, key: string, fallback: string][] = [
  ...["shopWeaponGoods", "shopCharacterGoods", "shopItemGoods", "shopBuy", "shopGift"].flatMap((g): [string, string, string][] => [
    [`${g}HavePointStatic`, "STBL_IDX_SHOP_HAVE_MONEY", "Atual"], [`${g}RemainPointStatic`, "STBL_IDX_SHOP_REMAIN_MONEY", "Restante"]]),
  ...["shopWeapon", "shopChara"].flatMap((r): [string, string, string][] => [
    [`${r}RepairHaveMoneyStatic`, "STBL_IDX_SHOP_HAVE_MONEY", "Atual"], [`${r}RepairRemainMoneyStatic`, "STBL_IDX_SHOP_REMAIN_MONEY", "Restante"]]),
];
/** slot text colours (GUI colour table 0x791000): owned term 0, "Não possui" 0x10, sale labels Cash 0x11 / Gold 0xe */
const COLOR = { term: "#adadad", noHave: "#8bd925", cash: "#ffff00", gold: "#ffffff" };

/** no web equivalent: set goods (shopSetTab / shopSet: server does not port system_shop_sets and the DB has 0 rows), cash
 * charge, Visualizar (shopWeaponInfoPreview 0xa678d0: the Cross 3D preview left of the shop already shows the picked weapon), sale
 * texts / marks, the red / blue combo, the cash-only buy buttons */
/** Presente (1048) is ported: only the receiver nick field of shopGiftPopup stays; the friend / clan pickers, the cash charge and
 * the per-class extras are hidden here */
const GIFT_HIDDEN = [
  "shopGiftFriend", "shopGiftFriendDropDown", "shopGiftFriendScroll", "shopGiftClan", "shopGiftClanDropDown", "shopGiftClanScroll",
  "shopGiftReceiverSelectStatic", "shopGiftCashOk", "shopGiftCashCancel", "shopGiftCashCharge", "shopGiftCashChargeMark", "shopGiftCashChargeStatic",
  "shopGiftCashSymbol", "shopGiftHaveCashSymbol", "shopGiftRemainCashSymbol", "shopGiftWeaponKey", "shopGiftWeaponExtension", "shopGiftWeaponFilter",
  "shopGiftWeaponUsed", "shopGiftItemUsed", "shopGiftCharacterUsed", "shopGiftSeparate1", "shopGiftSeparate2", "shopGiftSeparate3",
];
const HIDDEN = [
  // N-coin symbols of the goods frames: hidden by user choice 2026-10-12 (the exe leaves them drawn, see BUY_CASH_SYMBOLS)
  ...["shopWeaponGoods", "shopCharaGoods", "shopItemGoods", "shopSetGoods"].flatMap((g) => [1, 2, 3, 4].map((k) => `${g}CashSymbol0${k}`).concat(`${g}HaveCashSymbol`, `${g}RemainCashSymbol`)),
  ...GIFT_HIDDEN,
  "shopSetTab", "shopSet", "shopCashCharge",
  "shopWeaponInfoPreview", "shopWeaponKey", "shopWeaponInfoExtension",
  "shopCharacterTypeCombo", "shopItemDescription",
  ...[1, 2, 3, 4].map((n) => `shopWeaponGoodsSaleText0${n}`),
  "shopBuyCashOk", "shopBuyCashCancel", "shopBuyCashCharge", "shopBuyWeaponKey", "shopBuyWeaponExtension", "shopBuyWeaponUsed", "shopBuyWeaponFilter",
  "shopBuyItemUsed", "shopBuyCharacterUsed",
];

const SLOTS = (pre: string) => Array.from({ length: 6 }, (_, i) => `${pre}${i + 1}`);
const TAB_BUTTON: Record<ItemTab, string> = { weapon: "shopWeaponTab", chara: "shopCharaTab", item: "shopItemTab" };
const SECTION: Record<ItemTab, string> = { weapon: "shopWeapon", chara: "shopCharacter", item: "shopItem" };
const GOODS: Record<ItemTab, string> = { weapon: "shopWeaponGoods", chara: "shopCharacterGoods", item: "shopItemGoods" };
/** N-coin symbols (template "N코인 심볼", main_ui_source01 452,157 18x18). The goods frames' %sCashSymbol0%d / Have / Remain
 * are only linked (weapon 0xa672a0 / 0xa67311 / 0xa6739b), never SetEnable'd or reshaped, and the .gui has no hidden flag:
 * the web leaves them as drawn for both currencies [INFERIDO: i3Gui default = shown]. The buy popup SetEnable(0)s these
 * three (0x89111e..0x891188) */
const BUY_CASH_SYMBOLS = ["shopBuyCashSymbol", "shopBuyHaveCashSymbol", "shopBuyRemainCashSymbol"];
/** per-slot children: name, icon dummy, term, the two sale texts, hidden extras. The slot fillers (weapon 0xa67d85, chara
 * 0xa632d0, item 0xa5fa20) put no price in the slot: the term line is the owned copy's term or STBL_IDX_ITEM_NO_HAVE, and the
 * sale texts are CStepShop::_PrintSaleText 0x84e470 (currency labels). Hidden: shopWeaponSlotPurchase (written only with
 * STR_SHOP_CANNOT_BUYING in red when 0x7f7760 / 0x7f7790 refuse the weapon, rule not decoded), shopWeaponSlotKey (the
 * weapon category, WeaponInfoDataBase::GetWeaponCategoryEx 0x5f5ef0, not ported) and the durability bars (CStepShop only
 * ever SetEnable(0)s them: chara 0xa634a2, weapon 0xa67d46) */
const SLOT_PARTS: Record<ItemTab, (k: number) => { value: string; dummy: string; term: string; sale: [string, string]; hide: string[] }> = {
  weapon: (k) => ({ value: `shopWeaponSlotValue${k}`, dummy: `shopWeaponSlotDummy${k}`, term: `shopWeaponSlotTerm${k}`, sale: [`shopWeaponFirstSaleText${k}`, `shopWeaponSecondSaleText${k}`],
    hide: [`shopWeaponSlotKey${k}`, `shopWeaponSlotSaleMark${k}`, `shopWeaponSlotExtension${k}`, `shopWeaponSlotUsed${k}`, `shopWeaponSlotFilter${k}`, `shopWeaponSlotPurchase${k}`, `shopWeaponSlotDurabilityBar${k}`] }),
  chara: (k) => ({ value: `shopCharacterValue${k}`, dummy: `shopCharacterDummy${k}`, term: `shopCharacterTerm${k}`, sale: [`shopCharaFirstSaleText${k}`, `shopCharaSecondSaleText${k}`],
    hide: [`shopCharacterSaleMark${k}`, `shopCharacterUsed${k}`, `shopCharaSlotDurabilityBar${k}`] }),
  item: (k) => ({ value: `shopItemValue${k}`, dummy: `shopItemDummy${k}`, term: `shopItemTerm${k}`, sale: [`shopItemFirstSaleText${k}`, `shopItemSecondSaleText${k}`],
    hide: [`shopItemSaleMark${k}`] }),
};
/** repair frame of the weapon / character info (shopWeaponDoRepair / shopCharaDoRepair 0xa6d120): it stands in for the goods
 * frame when the player owns the picked item and it is repairable [INFERIDO: when the exe swaps the two frames; the goods
 * frame is never SetEnable'd in CStepShop and CRepairFrameChara::Update (StepShop_TabChara.cpp, ~0xa60e00) only fills texts] */
const REPAIR: Partial<Record<ItemTab, string>> = { weapon: "shopWeapon", chara: "shopChara" };
/** Cross filter button -> 2017 filter (SHOP_SUBS) */
const FILTERS: Record<ItemTab, [string, ItemFilter][]> = {
  weapon: [["shopAllWeapon", "all"], ["shopPrimaryWeapon", "primary"], ["shopSecondaryWeapon", "secondary"], ["shopMeleeWeapon", "melee"], ["shopThrowingWeapon", "throw"], ["shopItemWeapon", "special"]],
  chara: [["shopAllCharacter", "all"], ["shopTypeCharacter", "chara"], ["shopHairCharacter", "head"]],
  item: [["shopItemAllGroup", "all"], ["shopItemGroupMaintenance", "maintenance"], ["shopItemGroupExpendable", "expendable"]],
};
const MONEY = (c: Currency): [string, string] => (c === "gold" ? ["STBL_IDX_SHOP_INFO_BUYTYPE_POINT", "Gold"] : ["STBL_IDX_SHOP_INFO_BUYTYPE_CASH", "Cash"]);

export class ShopPage {
  private gui: I3Gui;
  private grids: Record<ItemTab, SlotGrid>;
  private detail: WeaponDetail;
  private view = "";
  /** a new tab / filter still has to pick its first goods (the list may still be loading) */
  private pickFirst = false;
  private repaints: (() => void)[] = [];
  /** the buy confirmation (shopBuyPopup) is open */
  private confirm = false;
  /** the gift popup (shopGiftPopup, Presente) is open: same goods / option as the buy, receiver typed in shopGiftReceiverInput */
  private gift = false;
  private nick: HTMLInputElement | null = null;

  static async create(ctx: PageCtx): Promise<ShopPage> {
    const [shop, popup, detail] = await Promise.all([loadPack("UI_Project_Shop"), loadPack("UI_Project_Popup"), WeaponDetail.create(ctx)]);
    return new ShopPage(ctx, shop.root, popup.root, detail);
  }

  private constructor(private ctx: PageCtx, root: GNode, popupRoot: GNode, detail: WeaponDetail) {
    this.detail = detail;
    const gui = (this.gui = pageGui(ctx, TEXTS));
    buildWindows(gui, ctx, root, ["shopWin"]);
    buildWindows(gui, ctx, popupRoot, ["shopBuyPopup", "shopGiftPopup"]);
    this.nick = gui.edit("shopGiftReceiverInput", { maxLength: 16 });
    for (const n of HIDDEN) gui.hide(n);
    for (const [n, k, f] of MONEY_LABELS) { gui.setText(n, `${ctx.str(k, f)} :`); rightAlign(gui, n); }
    const c = ctx.ctl;
    const offers = () => (c.session ? shopOffers(c.session.shop, c.menu) : []);
    const sel = (k: number) => offers()[k]?.itemId === c.menu.selected;
    this.grids = {
      weapon: new SlotGrid(gui, c, SLOTS("shopWeaponSlot"), 2, "shopWeaponScrollList", () => offers().length, sel),
      chara: new SlotGrid(gui, c, SLOTS("shopCharacterSlot"), 3, "shopCharacterScrollList", () => offers().length, sel),
      item: new SlotGrid(gui, c, SLOTS("shopItemSlot"), 3, "shopItemScrollList", () => offers().length, sel),
    };
    // every shop click first drops a pending buy state: the controller's buy popup is modal (it blocks tabs / slots / back)
    const drop = () => { this.confirm = false; this.gift = false; if (c.buy && !c.buy.busy) c.click("buy", "SBN_Cancel"); };
    for (const g of Object.values(this.grids)) for (const n of g.names) gui.get(n)?.el.addEventListener("click", drop, { capture: true });
    for (const t of Object.keys(TAB_BUTTON) as ItemTab[]) {
      onClick(gui, TAB_BUTTON[t], () => { drop(); c.click("menu", SHOP_TABS.find(([, x]) => x === t)![0]); });
      for (const [btn, f] of FILTERS[t]) onClick(gui, btn, () => { drop(); c.click("menu", SHOP_SUBS[t].buttons.find(([, x]) => x === f)![0]); });
      const g = GOODS[t];
      for (let i = 0; i < MAX_OPTIONS; i++) onClick(gui, `${g}Radio0${i + 1}`, () => this.pick(() => c.click("buy", `i3UIRadio_SBN_0${i + 1}`)));
      this.repaints.push(gui.button(`${g}Buy`, () => this.pick(() => { this.confirm = true; c.draw(); }), () => this.canBuy()));
      this.repaints.push(gui.button(`${g}Gift`, () => this.pick(() => { this.gift = true; this.confirm = false; if (this.nick) this.nick.value = ""; c.draw(); }), () => this.canBuy()));
    }
    onClick(gui, "shopWeaponGoodsCombo1", () => this.pick(() => c.click("buy", "i3UITab")));
    onClick(gui, "shopWeaponGoodsCombo2", () => this.pick(() => c.click("buy", "i3UITab0")));
    this.repaints.push(gui.button("shopBuyOk", () => { this.confirm = false; c.click("buy", "SBN_Buy"); }, () => this.canBuy()));
    gui.button("shopBuyCancel", () => { this.confirm = false; c.draw(); });
    this.repaints.push(gui.button("shopGiftOk", () => this.sendGift(), () => this.canBuy()));
    gui.button("shopGiftCancel", () => { this.gift = false; c.draw(); });
    gui.button("shopLeave", () => { drop(); c.click("main", MAIN_BUTTONS.back); });
    // Detalhes (0xa67870): the picked goods' weapon in weExtensionWin
    this.repaints.push(gui.button("shopWeaponInfoDetail", () => { const o = this.offer(); if (o) detail.open(o.itemId); }, () => { const o = this.offer(); return !!o && !!weaponStats(o.itemId, () => c.draw()); }));
    for (const r of Object.values(REPAIR)) {
      this.repaints.push(gui.button(`${r}DoRepair`, () => { const it = this.owned(); if (it) askRepair(ctx, it); },
        () => { const it = this.owned(), s = c.session; return !!it && !!s && !c.busy && (repairCost(s, it)?.damage ?? 0) > 0; }));
    }
  }

  /** a goods-frame action: the controller's buy state opened first (openBuy picks the currency / first priced option) */
  private pick(fn: () => void): void {
    const c = this.ctx.ctl;
    if (c.menu.selected === null || c.buy?.busy) return;
    if (!c.buy) c.openBuy();
    if (c.buy) fn();
  }

  /**
   * Confirmar (shopGiftOk, exe 0x894ba0): empty nick = STR_POPUP_MESSAGE_PLEASE_NAME ("Escreva o apelido"). Then 0x4e9820 checks the
   * money (deficit = STBL_IDX_EP_SHOP_DEFICIT_MONEY, here canBuy) and SetEvent(0x26) opens the gift popup 0x26 through 0x4e9a10
   * (refused while this+0x84 says it is open). 0x894f10(1) then sets the Ok / Cancel state. Popup 0x26's Ok is the 1048 send
   * (giftSend). [INFERIDO] the 1048 push (0x999591) sits in the GUI handler 0x999390 (switch on the control id), not yet tied to
   * event 0x26. [RECRIADO] the question text: no exe key found for it, so the fallback is used.
   */
  private sendGift(): void {
    const c = this.ctx.ctl, o = this.offer(), b = c.buy;
    if (!o || !b || b.busy || !c.session) return;
    const nick = (this.nick?.value ?? "").trim();
    if (!nick) { c.say(this.ctx.str("STR_POPUP_MESSAGE_PLEASE_NAME", "Escreva o apelido"), true); return; }
    const { currency, option } = this.choice(o), opt = o.options[option];
    if (!opt || priceIn(opt, currency) <= 0) return;
    const goodId = opt.goodId;
    c.msg = { text: `Deseja enviar o presente para ${nick}?`, onOk: () => void this.giftSend(goodId, currency, nick), onCancel: () => {} };
    c.draw();
  }

  /**
   * Ok of popup 0x26: 1048 with the buy state's currency and the picked option, the receiver by nick. The server answers 1049
   * (sent) or 1047 (refused, the buy's code). Success = STR_POPUP_MESSAGE_SUCCESS_GIFT ("O presente foi enviado para [%s] com sucesso"),
   * the caption STR_POPUP_CAPTION_SUCCESS_GIFT is not shown (the say box has one text) [RECRIADO].
   */
  private async giftSend(goodId: number, currency: Currency, nick: string): Promise<void> {
    const c = this.ctx.ctl, b = c.buy;
    if (!b || b.busy || !c.session) return;
    b.busy = true;
    c.draw();
    try {
      await c.session.gift([{ goodId, buyType: currency === "gold" ? BuyType.Gold : BuyType.Cash }], nick);
      this.gift = false;
      b.busy = false;
      c.click("buy", "SBN_Cancel");
      c.say(this.ctx.str("STR_POPUP_MESSAGE_SUCCESS_GIFT", "O presente foi enviado para [%s]\ncom sucesso.").replace("%s", nick), true);
    } catch (e) {
      b.busy = false;
      this.gift = true;
      c.say(e instanceof Error ? e.message : String(e), true);
      c.draw();
    }
  }

  /** the player's repairable copy of the picked item (undefined: the goods frame shows) */
  private owned() {
    const s = this.ctx.ctl.session, o = this.offer();
    return s && o && REPAIR[this.ctx.ctl.menu.tab] ? ownedRepairable(s, o.itemId) : undefined;
  }

  private offer(): ShopOffer | undefined {
    const c = this.ctx.ctl;
    return c.menu.selected !== null ? c.session?.shop.offer(c.menu.selected) : undefined;
  }

  /** currency / option shown: the buy state's, else what openBuy would pick */
  private choice(o: ShopOffer): { currency: Currency; option: number } {
    const b = this.ctx.ctl.buy;
    if (b) return { currency: b.currency, option: b.option };
    const currency: Currency = o.options.some((x) => priceIn(x, "gold") > 0) ? "gold" : "cash";
    return { currency, option: Math.max(0, o.options.slice(0, MAX_OPTIONS).findIndex((x) => priceIn(x, currency) > 0)) };
  }

  private canBuy(): boolean {
    const c = this.ctx.ctl, o = this.offer();
    if (!o || c.busy || c.buy?.busy) return false;
    const { currency, option } = this.choice(o), opt = o.options[option];
    return !!opt && priceIn(opt, currency) > 0;
  }

  paint(): void {
    const c = this.ctx.ctl, s = c.session, gui = this.gui, ui = c.menu, str = this.ctx.str;
    const on = c.page === "shop" && !!s;
    gui.show("shopWin", on);
    if (!on || !c.buy) { this.confirm = false; this.gift = false; }
    gui.show("shopBuyPopup", on && this.confirm && !!c.buy);
    this.detail.paint(on);
    if (!on) { this.view = ""; return; }
    const tab = ui.tab;
    const view = `${tab}/${ui.filter}/${ui.search}`;
    if (view !== this.view) { this.view = view; this.pickFirst = true; for (const g of Object.values(this.grids)) g.top = 0; }
    for (const t of Object.keys(TAB_BUTTON) as ItemTab[]) {
      gui.show(SECTION[t], t === tab);
      setTab(gui, TAB_BUTTON[t], t === tab);
      for (const [btn, f] of FILTERS[t]) gui.setState(btn, t === tab && f === ui.filter ? 2 : 0);
    }
    // the grid: name, the owned term / "Não possui", the currency labels
    const list = shopOffers(s.shop, ui), grid = this.grids[tab], inv = [...s.player.state.inventory.values()];
    // the shop never sits with nothing picked: the tab's OnEnter (vf 0x8, weapon 0xa663f0) and every filter change
    // (CTabWeapon::OnChangeGroup 0xa69290, CTabChara 0xa63d20, CTabItem 0xa5f930) clear the selection (+0xd4 = 0) and
    // call vf 0x18 (0xa66550 -> CShopTab 0xa6c2e0) with slot 0, which picks the list's first goods; only an empty list
    // leaves +0xd4 = 0. The +0xd8 "keep" flag (0xa69630, back from a popup) restores the old pick: here it never drops
    if (this.pickFirst && list.length) { this.pickFirst = false; if (ui.selected === null) queueMicrotask(() => c.click("hit", "slot0")); }
    grid.paint();
    prefetchModels(tab, grid.names.flatMap((_, i) => { const k = grid.at(i); return k === null || !list[k] ? [] : [list[k].itemId]; }));
    grid.names.forEach((_, i) => {
      const k = grid.at(i), o = k === null ? undefined : list[k], parts = SLOT_PARTS[tab](i + 1);
      for (const h of parts.hide) gui.hide(h);
      gui.setText(parts.value, o ? itemName(o.itemId).name : "");
      const have = o && inv.find((it) => it.itemId === o.itemId);
      if (!o) gui.setText(parts.term, "");
      else if (!have) { gui.setText(parts.term, str("STBL_IDX_ITEM_NO_HAVE", "Não possui")); gui.setColor(parts.term, COLOR.noHave); }
      else if (tab === "item") {
        // item 0xa60159: "%s : {col:255,255,255,255}%d%s{/col}" (HAVE_TERM / HAVE_COUNT, the amount in white)
        const t = itemTerm(have), key = t.kind === "count" ? "STBL_IDX_ITEM_HAVE_COUNT" : "STBL_IDX_ITEM_HAVE_TERM";
        haveText(gui, parts.term, str(key, "Restante"), termText(t));
        gui.setColor(parts.term, COLOR.term);
      } else { gui.setText(parts.term, termText(itemTerm(have))); gui.setColor(parts.term, COLOR.term); }
      const labels = o ? saleLabels(o, str) : [];
      parts.sale.forEach((n, j) => { gui.setText(n, labels[j]?.[0] ?? ""); if (labels[j]) gui.setColor(n, labels[j][1]); });
      setIcon(gui, parts.dummy, o?.itemId ?? 0);
    });
    // info + goods frames of the selected offer
    const o = this.offer(), ch = o ? this.choice(o) : null, opt = o && ch ? o.options[ch.option] : undefined;
    const name = o ? itemName(o.itemId).name : s.shop.status === "error" ? s.shop.error ?? "" : "";
    const money = ch ? str(...MONEY(ch.currency)) : "";
    if (tab === "weapon") {
      // 0xa68620 hides Detalhes / Preview / extension / bullet / range first and returns when nothing is picked (+0xd4 = 0)
      gui.show("shopWeaponInfoDetail", !!o);
      gui.setText("shopWeaponValue", name);
      setIcon(gui, "shopWeaponDummy", o?.itemId ?? 0);
      // shopWeaponInfoTerm / InfoPurchase (+0x2c0 / 0x2c4) are linked (0xa66cde / 0xa66cfe) but CStepShop never writes them
      paintStats(gui, "shop", o ? weaponStats(o.itemId, () => c.draw()) : null);
      gui.setState("shopWeaponGoodsCombo1", ch?.currency === "gold" ? 1 : 0);
      gui.setState("shopWeaponGoodsCombo2", ch?.currency === "cash" ? 1 : 0);
    } else {
      const pre = tab === "chara" ? "shopCharacter" : "shopItem";
      gui.setText(`${pre}InfoValue`, name);
      setIcon(gui, `${pre}InfoDummy`, o?.itemId ?? 0);
      if (tab === "chara") {
        gui.setText("shopCharacterTermValue", o && opt ? optionText(opt, o) : "");
        // [RECRIADO] o Cross deixa vazio: charaDescription monta com números reais do pef (ver charaDescription.ts)
        gui.setText("shopCharacterDescription", o ? charaDescription(o.itemId, str) : "");
        gui.show("shopCharacterDescription", !!o);
      }
    }
    const g = GOODS[tab], have = ch ? (ch.currency === "gold" ? c.chrome().gold : c.chrome().cash) : 0;
    // an owned repairable item shows the repair frame instead of the goods frame
    const owned = this.owned(), fix = owned ? repairCost(s, owned) : null;
    gui.show(g.replace(/Goods$/, "GoodsFrame"), !!o && !fix);
    for (const [t, r] of Object.entries(REPAIR)) gui.show(`${r}RepairFrame`, t === tab && !!fix);
    const rp = REPAIR[tab];
    if (rp && fix) {
      const fm = str(...MONEY(fix.currency)), have = fix.currency === "gold" ? c.chrome().gold : c.chrome().cash;
      gui.setText(`${rp}RepairPrice`, fmtInt(fix.cost));
      gui.setText(`${rp}PriceType`, fm);
      gui.setText(`${rp}RepairHaveMoneyValue`, fmtInt(have));
      gui.setText(`${rp}RepairRemainMoneyValue`, fmtInt(have - fix.cost));
      gui.setText(`${rp}RepairHaveMoneyType`, fm);
      gui.setText(`${rp}RepairRemainMoneyType`, fm);
      for (const n of [`${rp}RepairPrice`, `${rp}RepairHaveMoneyValue`, `${rp}RepairRemainMoneyValue`]) rightAlign(gui, n);
    }
    for (let i = 0; i < MAX_OPTIONS; i++) {
      const x = o?.options[i], n = `0${i + 1}`, price = x && ch ? priceIn(x, ch.currency) : 0;
      for (const part of ["Radio", "DayValue", "DayStatic", "PointValue", "PointStatic"]) gui.show(`${g}${part}${n}`, !!x);
      if (!x || !o) continue;
      gui.setState(`${g}Radio${n}`, price <= 0 ? 3 : ch?.option === i ? 2 : 0); // radio: 0 off, 1 over, 2 on, 3 disabled
      const [day, unit] = dayTexts(x, o, str);
      gui.setText(`${g}DayValue${n}`, day);
      gui.setText(`${g}DayStatic${n}`, unit);
      gui.setText(`${g}PointValue${n}`, price > 0 ? fmtInt(price) : "-");
      gui.setText(`${g}PointStatic${n}`, money);
    }
    const cost = opt && ch ? priceIn(opt, ch.currency) : 0;
    gui.setText(`${g}HavePointValue`, ch ? fmtInt(have) : "");
    gui.setText(`${g}RemainPointValue`, ch ? fmtInt(have - cost) : "");
    for (const k of ["05", "06"]) gui.setText(`${g}PointStatic${k}`, money);
    // amounts right / middle: SetTextAlign(2, 1) on the have / remain values (0xa5eae0 / 0xa5eb2c) and the option prices
    for (const n of [...[1, 2, 3, 4].map((i) => `${g}PointValue0${i}`), `${g}HavePointValue`, `${g}RemainPointValue`]) rightAlign(gui, n);
    // buy confirmation
    if (this.confirm && o && ch) {
      gui.show("shopBuyWeaponInfo", tab === "weapon");
      gui.show("shopBuyCharacterInfo", tab === "chara");
      gui.show("shopBuyItemInfo", tab === "item");
      const pre = tab === "weapon" ? "shopBuyWeapon" : tab === "chara" ? "shopBuyCharacter" : "shopBuyItem";
      gui.setText(`${pre}Value`, name);
      setIcon(gui, `${pre}Dummy`, o.itemId);
      gui.setText("shopBuyUseSaleText", opt ? optionText(opt, o) : "");
      gui.setText("shopBuyPointValue", fmtInt(cost));
      gui.setText("shopBuyHavePointValue", fmtInt(have));
      gui.setText("shopBuyRemainPointValue", fmtInt(have - cost));
      for (const k of [1, 2, 3]) gui.setText(`shopBuyPointStatic${k}`, money);
      for (const k of BUY_CASH_SYMBOLS) gui.hide(k);
    }
    // gift popup: the goods, the price and the have / remain of the buy state; the receiver is typed in shopGiftReceiverInput
    gui.show("shopGiftPopup", on && this.gift && !!c.buy && !!o && !!ch);
    if (this.gift && o && ch) {
      gui.show("shopGiftWeaponInfo", tab === "weapon");
      gui.show("shopGiftCharacterInfo", tab === "chara");
      gui.show("shopGiftItemInfo", tab === "item");
      const pre = tab === "weapon" ? "shopGiftWeapon" : tab === "chara" ? "shopGiftCharacter" : "shopGiftItem";
      gui.setText(`${pre}Value`, name);
      setIcon(gui, `${pre}Dummy`, o.itemId);
      gui.setText("shopGiftUseDaySaleText", opt ? optionText(opt, o) : "");
      gui.setText("shopGiftPointValue", fmtInt(cost));
      gui.setText("shopGiftHavePointValue", fmtInt(have));
      gui.setText("shopGiftRemainPointValue", fmtInt(have - cost));
      for (const k of [1, 2, 3]) gui.setText(`shopGiftPointStatic${k}`, money);
    }
    for (const f of this.repaints) f();
  }
}

/** a goods row's period (0xa6b560): DayValue (25 px, right) "%d", DayStatic (40 px, left) "%s :". Period (0x68aea0 = 0):
 * hours = ceil(sec / 3600) (0x7fa6b0 -> 0x7f5030), < 24 -> STR_UI_HOUR, else hours / 24 STBL_IDX_ITEM_TERM_UNIT; count
 * (= 1): the count, "%s:" STBL_IDX_ITEM_COUNT_UNIT. Unlimited (count 0) [INFERIDO]: the exe would print 0, the web puts
 * the unlimited text in DayStatic */
function dayTexts(x: ShopOffer["options"][number], o: ShopOffer, str: (k: string, f: string) => string): [string, string] {
  if (!x.count) return ["", optionText(x, o)];
  const auth = o.item?.authType;
  if (!(auth === 2 || (auth !== 1 && countIsSeconds(o.itemId)))) return [`${x.count}`, `${str("STBL_IDX_ITEM_COUNT_UNIT", " und.")}:`];
  const h = Math.ceil(x.count / 3600);
  return h < 24 ? [`${h}`, `${str("STR_UI_HOUR", "Horas")} :`] : [`${Math.floor(h / 24)}`, `${str("STBL_IDX_ITEM_TERM_UNIT", "dias")} :`];
}

/** CStepShop::_PrintSaleText 0x84e470 with the goods' buy flags 0x7f4490 (1 = Gold price, 2 = Cash price, none = 1): the
 * Cash label (colour 0x11) fills the first sale text, then the Gold one (colour 0xe) */
function saleLabels(o: ShopOffer, str: (k: string, f: string) => string): [string, string][] {
  const gold = o.options.some((x) => priceIn(x, "gold") > 0), cash = o.options.some((x) => priceIn(x, "cash") > 0);
  const out: [string, string][] = [];
  if (cash) out.push([str("STR_SHOP_CAN_BUYING_CASH", "Cash"), COLOR.cash]);
  if (gold || !cash) out.push([str("STR_SHOP_POINTITEM", "Gold"), COLOR.gold]);
  return out;
}

/** "label : " + the amount in white (the exe's {col:255,255,255,255} markup) */
function haveText(gui: I3Gui, name: string, label: string, amount: string): void {
  const text = () => gui.get(name)?.el.querySelector<HTMLElement>(":scope > .op-text");
  if (text()?.textContent === `${label} : ${amount}`) return;
  gui.setText(name, `${label} : `);
  const span = document.createElement("span");
  span.style.color = COLOR.gold;
  span.textContent = amount;
  text()?.append(span);
}
