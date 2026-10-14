// Shared bits of the Cross menu pages (inventory / shop / profile): each page builds its own i3Gui windows (own I3Gui, own
// name map) into one layer the app puts under the menu bar and the message box, and drives the same Lobby2017 controller
// the 2017 shell does (click / dblclick by the 2017 control names, the public menu / buy / profile state).
import { jsonOnce } from "../../../jsonOnce.ts";
import { UI_BASE } from "../../ui/assets.ts";
import { I3Gui, type GNode } from "../../ui/i3Gui.ts";
import { crossIcons, loadCrossIcons, paintIcon } from "../../screens/icons.ts";
import type { Lobby2017 } from "../../core/controller.ts";
import type { WeaponDb } from "../../../weapons/data.ts";
import type { WeaponDef } from "../../../weapons/types.ts";
import type { MetaSession } from "../../state/MetaSession.ts";
import type { InventoryItem } from "../../types.ts";
import { itemName } from "../../state/itemNames.ts";
import { PacketWriter } from "../../../net/packet.ts";
import { NICK_COLORS } from "../../../game/battleChatModel.ts";
import { ItemPreview } from "../../screens/preview3d.ts";

export const BASE = `${UI_BASE}/cross`;
export type Str = (key: string, fallback: string) => string;
export type Texts = Record<string, [key: string, fallback: string]>;

export interface PageCtx {
  ctl: Lobby2017;
  /** layer of the pages (under the menu bar / message box) */
  layer: HTMLElement;
  str: Str;
}

/**
 * CSS colour of a nick / clan name colour index: 0x4ad850 = SetText + SetTextColor(table 0xb210a4[i]) for i < 11, the table
 * being NICK_COLORS (index 0 = white). An index >= 11 leaves the control untouched in the exe; here it falls back to white.
 */
export const nickCss = (i: number | undefined): string => `rgb(${(NICK_COLORS[i ?? 0] ?? NICK_COLORS[0]).join(",")})`;

/** a node and the summed offset of its ancestors (the windows are built at their absolute place) */
export function locate(n: GNode, name: string, ox = 0, oy = 0): { node: GNode; ox: number; oy: number } | null {
  if (n.name === name) return { node: n, ox, oy };
  for (const c of n.children ?? []) { const f = locate(c, name, ox + n.x, oy + n.y); if (f) return f; }
  return null;
}

export const loadPack = (pack: string): Promise<{ root: GNode }> => jsonOnce<{ root: GNode }>(`${BASE}/${pack}.json`);

/** an I3Gui with the page's control texts (STR keys of strings.json) and the lobby's caption / centring rules */
export function pageGui(ctx: PageCtx, texts: Texts): I3Gui {
  const caption = (n: GNode) => /Caption$/.test(n.name);
  return new I3Gui({
    base: BASE,
    text: (n) => { const t = texts[n.name]; return t ? ctx.str(t[0], t[1]) : undefined; },
    caption,
    centred: (n) => n.cls === "Button" || caption(n),
  });
}

/** builds the windows `names` of `root` at their absolute place into the page layer; returns the built roots */
export function buildWindows(gui: I3Gui, ctx: PageCtx, root: GNode, names: string[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const name of names) {
    const f = locate(root, name);
    if (!f) { console.warn(`[cross] no ${name}`); continue; }
    const el = gui.build(f.node, ctx.layer, f.ox, f.oy);
    el.style.display = "none"; // the page paint shows it: no flash of every page window on load
    out.push(el);
  }
  return out;
}

/**
 * The item's own icon in a Null dummy control (the CEquipShapeManager cell of the Cross index, screens/icons.ts "cross"
 * set; 2017 / V12 icon when the Cross has none); 0 = none. The index loads on the first call and the icon paints when it is in.
 */
export function setIcon(gui: I3Gui, name: string, itemId: number): void {
  const b = gui.get(name);
  if (!b) return;
  let ic = b.el.querySelector<HTMLElement>(":scope > .cx-icon");
  if (!ic) {
    ic = document.createElement("div");
    ic.className = "cx-icon";
    ic.style.cssText = "position:absolute;inset:0;pointer-events:none;";
    b.el.appendChild(ic);
  }
  ic.style.display = itemId ? "" : "none";
  if (!itemId || ic.dataset.item === String(itemId)) return;
  const el = ic, id = String(itemId), paint = () => { if (el.dataset.item === id) paintIcon(el, itemId, b.node.w, b.node.h); };
  el.dataset.item = id;
  if (crossIcons()) paint();
  else void loadCrossIcons().then(paint);
}

/** clickable control: `fn` on click, `dbl` on double click */
export function onClick(gui: I3Gui, name: string, fn: () => void, dbl?: () => void): void {
  const b = gui.get(name);
  if (!b) return;
  b.el.style.cursor = "pointer";
  b.el.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
  if (dbl) b.el.addEventListener("dblclick", (e) => { e.stopPropagation(); dbl(); });
}

/**
 * A grid of item slots (Weapon / Character templates: 0 normal, 1 over, 2 selected [INFERIDO from the atlas order]).
 * Click / double click send the controller's own "slot<i>" hits (menu.top stays 0: i = the item's index in the list).
 */
export class SlotGrid {
  top = 0;
  private hover = -1;
  constructor(private gui: I3Gui, private ctl: Lobby2017, readonly names: string[], readonly cols: number, scrollName: string, private total: () => number, private selected: (i: number) => boolean) {
    names.forEach((n, i) => {
      const b = gui.get(n);
      if (!b) return;
      b.el.style.cursor = "pointer";
      b.el.addEventListener("click", (e) => { e.stopPropagation(); this.ctl.click("hit", `slot${this.top + i}`); });
      b.el.addEventListener("dblclick", (e) => { e.stopPropagation(); this.ctl.dblclick("hit", `slot${this.top + i}`); });
      b.el.addEventListener("pointerenter", () => { this.hover = i; this.paint(); });
      b.el.addEventListener("pointerleave", () => { if (this.hover === i) { this.hover = -1; this.paint(); } });
      // the wheel over the slots scrolls too: the List's own element sits under them and never gets the event
      b.el.addEventListener("wheel", (e) => { e.preventDefault(); this.scrollBy(Math.sign(e.deltaY)); this.ctl.draw(); }, { passive: false });
    });
    const scroll = gui.scrollList(scrollName, (d) => { this.scrollBy(d); this.ctl.draw(); });
    this.thumb = () => scroll(this.top / this.cols, Math.ceil(this.total() / this.cols), this.names.length / this.cols);
  }
  private thumb: () => void;
  scrollBy(rows: number): void {
    const max = Math.max(0, Math.ceil(this.total() / this.cols) - this.names.length / this.cols);
    this.top = Math.max(0, Math.min(max, this.top / this.cols + rows)) * this.cols;
  }
  /** index in the full list of slot `i` (none past the end) */
  at(i: number): number | null { const k = this.top + i; return k < this.total() ? k : null; }
  paint(): void {
    this.scrollBy(0);
    this.names.forEach((n, i) => {
      const k = this.at(i);
      this.gui.show(n, k !== null);
      if (k !== null) this.gui.setState(n, this.selected(k) ? 2 : this.hover === i ? 1 : 0);
    });
    this.thumb();
  }
}

// ---- weapon numbers (weapons.json, the battle's own WeaponDb, as the 2017 controller's shop / detail stats) ----
let weaponDb: WeaponDb | null = null;
let weaponDbLoad: Promise<void> | null = null;
export type StatKey = "damage" | "rate" | "hit" | "ammo" | "vRecoil" | "hRecoil" | "speed" | "range";
/** the six rows with a gauge, in the exe's GetPercentage index order (0 damage .. 5 speed) */
export type GaugeKey = Exclude<StatKey, "ammo" | "range">;
const GAUGES: GaugeKey[] = ["damage", "rate", "hit", "vRecoil", "hRecoil", "speed"];
export interface WeaponStats { text: Record<StatKey, string>; gauge: Record<GaugeKey, number> }
const num = (v: number, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toString().replace(".", ",");

/**
 * CWeaponInfo vf 0x1f8 (Cross PointBlank.exe): the 0..100 number of a stat row, -1 = none ("-", no bar). Guns
 * (CGunInfo 0x5c9eb0): 0 damage (x pellets for Shotgun 6 / DualShotgun 35), 1 100 - FireDelay x 100, 2 100 - Deviation x
 * DeviationMax (x 0.1 for Sniper 5), 3 RecoilVertAngle x 30, 4 RecoilHorzAngle x 30, 5 move speed; every value _ftol'd and
 * clamped to 0..100. Other weapons (CWeaponInfo 0x5b2490): damage and speed only.
 * [INFERIDO] which pef keys the getters vf 0x10c / 0x110 read (Deviation / DeviationMax); the *_OnlyUI overrides
 * (vf 0x114 / 0x118 / 0x11c / 0x120 / 0x21c, used when > 0) are not in weapons.json and are not applied; the knife /
 * grenade hit-rate branch (100 or -1 by a type the exe reads at +0x14) is shown as -1.
 */
function percent(d: WeaponDef, k: GaugeKey): number {
  const p = d.params, gun = d.family !== "KNIFE" && d.family !== "GRENADE";
  let v: number;
  switch (k) {
    case "damage": v = p.damage * (d.classType === 6 || d.classType === 35 ? (p.pellets ?? 1) : 1); break;
    case "speed": v = p.moveNormal?.stand ?? 100; break;
    case "rate": if (!gun) return -1; v = 100 - d.fireDelay * 100; break;
    case "hit": if (!gun) return -1; v = 100 - p.spread.deviation * p.spread.deviationMax * (d.classType === 5 ? 0.1 : 1); break;
    case "vRecoil": if (!gun) return -1; v = p.recoil.vertAngle * 30; break;
    case "hRecoil": if (!gun) return -1; v = p.recoil.horzAngle * 30; break;
  }
  return Math.max(0, Math.min(100, Math.trunc(v)));
}

/** a weapon's stat rows (null: not a weapon / table still loading: `redraw` runs once it is in). The gauge rows print
 * their number ("%d", the exe's 0xc1393c) or "-" (0xc13940); Bullet / Range keep the weapon's own figures. */
export function weaponStats(itemId: number, redraw: () => void): WeaponStats | null {
  if (!weaponDb) {
    weaponDbLoad ??= (async () => {
      const { WeaponDb } = await import("../../../weapons/data.ts");
      const db = new WeaponDb();
      await db.load(`${UI_BASE.replace(/\/ui$/, "")}/cross/weapons/weapons.json`);
      weaponDb = db;
    })().catch((e) => { weaponDbLoad = null; console.warn("[cross] weapons.json", e); });
    void weaponDbLoad.then(redraw);
    return null;
  }
  const d = itemId ? weaponDb.def(itemId) : undefined;
  if (!d) return null;
  const gauge = Object.fromEntries(GAUGES.map((k) => [k, percent(d, k)])) as Record<GaugeKey, number>;
  const text = Object.fromEntries(GAUGES.map((k) => [k, gauge[k] < 0 ? "-" : String(gauge[k])])) as Record<StatKey, string>;
  text.ammo = d.loadedBullet || d.totalBullet ? `${d.loadedBullet}/${d.totalBullet}` : "-";
  text.range = `${num(d.range)} m`;
  return { text, gauge };
}

/** stat rows of the Inven / Shop weapon info frames: [control prefix, stat] (Damage / Rapid / HitRate / Bullet, VertRecoil / HorzRecoil / Speed / Range) */
export const STAT_ROWS: [string, StatKey][] = [["Damage", "damage"], ["Rapid", "rate"], ["HitRate", "hit"], ["Bullet", "ammo"], ["VertRecoil", "vRecoil"], ["HorzRecoil", "hRecoil"], ["Speed", "speed"], ["Range", "range"]];

/**
 * A ShortGuage bar at `v` of 100 (0x881730): the control is resized to v / 100 of its own width, hidden at 0 or below.
 * The sprite is the 7 px piece stretched to the full width, so the box clips it.
 */
export function setGauge(gui: I3Gui, name: string, v: number): void {
  const b = gui.get(name);
  if (!b) return;
  b.el.style.display = v > 0 ? "" : "none";
  b.el.style.overflow = "hidden";
  b.el.style.width = `${Math.round((b.node.w * Math.min(100, Math.max(0, v))) / 100)}px`;
}

/**
 * Key texts of the stat rows: Bullet / Range are the map's (cross-ui-map.json ivBulletKey STR_INVEN_BULLETS, shopBulletKey
 * STBL_IDX_SHOP_WEAPON_BULLET...); the others are the 2017 detail popup's keys (core/strings.ts stat*) [INFERIDO].
 */
export function statTexts(prefix: string, bullet: string, range: string): Texts {
  const k: Record<string, [string, string]> = {
    Damage: ["STR_POPUP_DAMAGE", "Dano"], Rapid: ["STR_POPUP_RAPID_RATE", "Vel. de disparo"], HitRate: ["STR_POPUP_HIT_RATE", "Precisão"],
    VertRecoil: ["STR_POPUP_WEAPON_VERT_RECOIL", "Recuo vertical"], HorzRecoil: ["STR_POPUP_WEAPON_HORZ_RECOIL", "Recuo horizontal"], Speed: ["STR_SHOP_FILTER_SPEED", "Mobilidade"],
    Bullet: [bullet, "Munição"], Range: [range, "Alcance"],
  };
  return Object.fromEntries(Object.entries(k).map(([row, t]) => [`${prefix}${row}Key`, t]));
}

/**
 * Fills the stat rows `<prefix><Row>Key / Gage / Value` of a weapon info frame (the weExtensionWin rows have no Arrow:
 * the row node itself is the bullet). Bullet / Range write inside their bar (the pack's own place).
 */
export function paintStats(gui: I3Gui, prefix: string, stats: WeaponStats | null): void {
  for (const [row, k] of STAT_ROWS) {
    gui.show(`${prefix}${row}Arrow`, !!stats);
    if (k !== "ammo" && k !== "range") setGauge(gui, `${prefix}${row}Gage`, stats?.gauge[k] ?? 0);
    gui.setText(`${prefix}${row}Value`, stats?.text[k] ?? "");
  }
}

/**
 * "Detalhes" (shopWeaponInfoDetail 0xa67870 / ivInvenWeaponInfoDetail): UI_Project_Popup weExtensionWin (linked at 0x880260,
 * filled by 0x880d90) for one weapon: name, category, the six gauges, bullets / range, description; weLeave closes it.
 * The big weapon image (weImageDummy) is the 2017 lobby's 3D viewer (screens/preview3d.ts ItemPreview: drag to turn, the
 * item id carries its camo) [RECRIADO: the exe draws the 2D Gui/Weapon<Class>/<Name>.i3i there (CreateWeaponDescImageRes
 * 0x7a6670, not exported); 3D is the user's choice]. No model / no WebGL: the weapon's Cross WeaponSelect cell fitted in the
 * box [INFERIDO]. The viewer lives while the window is open (one WebGL context, reused across weapons). The extension
 * block (weExtension*, weControl*) has no data on the web: hidden.
 */
export class WeaponDetail {
  itemId = 0;
  private gui: I3Gui;
  private view: ItemPreview | null = null;
  /** item whose model did not load (its icon stands in) */
  private noModel = 0;

  static async create(ctx: PageCtx): Promise<WeaponDetail> { return new WeaponDetail(ctx, (await loadPack("UI_Project_Popup")).root); }

  private constructor(private ctx: PageCtx, root: GNode) {
    const gui = (this.gui = pageGui(ctx, {
      weExtensionCaption: ["STR_POPUP_DETAIL_INFO", "Informações"],
      ...statTexts("we", "STR_POPUP_BULLETS", "STR_POPUP_WEAPON_RANGE"), weSpeedKey: ["STR_POPUP_WEAPON_SPEED", "Vel. de movimento"],
    }));
    buildWindows(gui, ctx, root, ["weExtensionWin"]);
    for (const n of ["weExtension", "weExtensionDummy", "weSeparate2", "weSeparate3"]) gui.hide(n);
    gui.button("weLeave", () => { this.itemId = 0; ctx.ctl.draw(); });
    gui.hide("weExtensionWin");
  }

  /**
   * The exe opens it as a popup (0xa67870 -> 0x84e450 -> popup manager 0x513ae0 OpenPopup(1), 17 popups at stage+0x36b8),
   * drawn over the phase windows, at its own .gui place (380, 36 over the shop's 455, 37: no position call in 0x880200..0x881700).
   * It is built before the page that opens it, so it moves last in the layer to be on top.
   */
  open(itemId: number): void {
    this.itemId = itemId;
    const el = this.gui.get("weExtensionWin")?.el;
    if (el) this.ctx.layer.appendChild(el);
    this.ctx.ctl.draw();
  }

  /** shown while `on` (the page that opened it is up) */
  paint(on: boolean): void {
    if (!on) this.itemId = 0;
    const gui = this.gui, id = this.itemId;
    gui.show("weExtensionWin", !!id);
    if (!id) { this.view?.dispose(); this.view = null; return; }
    const n = itemName(id);
    gui.setText("weName", n.name);
    gui.setText("weCategory", weaponDb?.def(id)?.className ?? "");
    gui.setText("weDescription", "");
    const box = gui.get("weImageDummy");
    if (!this.view && box) {
      this.view = new ItemPreview(box.node.w, box.node.h);
      this.view.el.style.left = this.view.el.style.top = "0";
      box.el.appendChild(this.view.el); // inside the dummy: over the frame, under the texts built after it
    }
    const view = this.view;
    view?.show(id, false).then(() => {
      if (this.view === view && this.itemId === id && view.el.hidden) { this.noModel = id; setIcon(gui, "weImageDummy", id); }
    }).catch(() => {});
    setIcon(gui, "weImageDummy", !view || this.noModel === id ? id : 0);
    paintStats(gui, "we", weaponStats(id, () => this.ctx.ctl.draw()));
  }
}

// ---- repair (Durable items with a system_shop_repair row: count = durability, the match takes 1 per use) ----

/** what repairing `it` costs (server itemHandlers.handleRepair, 1:1 with the C# rule): the bill is price x damage / 100 in
 * Cash when the cash price is the higher one, else in Gold; null = not repairable (no 1075 row / no price) */
export function repairCost(s: MetaSession, it: InventoryItem | undefined): { currency: "gold" | "cash"; cost: number; damage: number; quantity: number } | null {
  const rep = it && s.shop.data?.repairs.find((r) => r.itemId === it.itemId);
  if (!it || !rep) return null;
  const damage = Math.max(0, rep.quantity - it.count);
  if (rep.pointPerUnit <= rep.cashPerUnit) {
    if (rep.cashPerUnit <= rep.pointPerUnit) return null;
    return { currency: "cash", cost: Math.trunc((rep.cashPerUnit * damage) / 100), damage, quantity: rep.quantity };
  }
  return { currency: "gold", cost: Math.trunc((rep.pointPerUnit * damage) / 100), damage, quantity: rep.quantity };
}

/** the owned, repairable inventory row of `itemId` (the shop's repair frame stands in for its goods frame) */
export const ownedRepairable = (s: MetaSession, itemId: number): InventoryItem | undefined =>
  [...s.player.state.inventory.values()].find((it) => it.itemId === itemId && !!repairCost(s, it));

/**
 * Reparar / Reparo: "Deseja reparar?" (STR_POPUP_REPAIR_1), then 1076 SHOP_REPAIR_REQ `C n, n x D objectId` -> 3334 (type 2,
 * the item's new count, through the MetaSession listener) + 1084 `H0, C n, n x (D objectId, D itemId), D cash, D gold` or
 * `H0, D err`. Checks first as the popup texts say: nothing to repair / not enough money.
 */
export function askRepair(ctx: PageCtx, it: InventoryItem): void {
  const c = ctx.ctl, s = c.session, str = ctx.str, info = s ? repairCost(s, it) : null;
  if (!s || !info || c.busy) return;
  if (info.damage <= 0) return c.say(str("STR_POPUP_REPAIR_NEEDLESS", "Não há necessidade de reparar essa arma."), true);
  const w = c.chrome();
  if ((info.currency === "gold" ? w.gold : w.cash) < info.cost) return c.say(str("STR_POPUP_REPAIR_3", "Gold insuficiente para reparar."), true);
  c.msg = { text: str("STR_POPUP_REPAIR_1", "Deseja reparar?"), onOk: () => void repair(ctx, s, it.objectId), onCancel: () => {} };
  c.draw();
}

async function repair(ctx: PageCtx, s: MetaSession, objectId: number): Promise<void> {
  const c = ctx.ctl, str = ctx.str, conn = s.connection;
  try {
    if (!conn?.isOpen) throw new Error("offline");
    const ack = conn.waitFor(1084);
    conn.send(1076, new PacketWriter(5).writeC(1).writeD(objectId));
    const r = await ack;
    r.readH();
    if (r.readC() !== 1) throw new Error("1084 refused");
    r.readD(); r.readD();
    const cash = r.readD(), gold = r.readD(), wallet = s.player.state.wallet;
    s.player.dispatch({ type: "wallet", wallet: { gold, cash, tags: wallet?.tags ?? 0 } });
    c.say(str("STR_POPUP_REPAIR_SUCCESS", "O reparo foi realizado."), true);
  } catch (e) {
    console.warn("[cross] repair", e);
    c.say(str("STR_POPUP_REPAIR_FAIL", "Falha no reparo"), true);
  }
  c.draw();
}

/** a durability bar (…DurabilityBar<k> + its Gauge) at count / quantity of a repairable item, hidden otherwise */
export function paintDurability(gui: I3Gui, bar: string, gauge: string, s: MetaSession, it: InventoryItem | undefined): void {
  const info = s && it ? repairCost(s, it) : null;
  gui.show(bar, !!info);
  if (info && it) setGauge(gui, gauge, (100 * it.count) / info.quantity);
}

/**
 * Tab button (WeaponTab / CharacterTab / ItemTab): sprite 0 = closed (grey), 1 = open (blue), the caption baked in the
 * sprite (main_ui_source03 y 422..510). ItemTab's two sprites differ in width (115 / 117 px), so I3Gui lays them as one
 * picture in pieces (both drawn): here only the one of the state is shown.
 */
export function setTab(gui: I3Gui, name: string, open: boolean): void {
  const b = gui.get(name);
  if (!b) return;
  if (b.states.length) { gui.setState(name, open ? 1 : 0); return; }
  const pieces = Array.from(b.el.children).filter((e) => !e.classList.contains("op-text")) as HTMLElement[];
  pieces.forEach((p, i) => (p.style.display = i === (open ? 1 : 0) ? "" : "none"));
}

/** the control's text right-aligned in its box */
export function rightAlign(gui: I3Gui, name: string): void {
  const t = gui.get(name)?.el.querySelector<HTMLElement>(":scope > .op-text");
  if (t) t.style.textAlign = "right";
}
