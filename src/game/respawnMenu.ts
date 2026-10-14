// In-game respawn HUD + weapon change panel of the Point Blank Cross client (logic: respawnSelect.ts):
//   Respawn_BG of UI_Project_HUD.i3Pack (public/assets/ui/cross/UI_Project_HUD.json, atlases ingame_respawn / ingame_hud2)
//   Respawn_Wait            respawn notice (STR_TBL_BATTLEGUI_NOTICE_RESPAWN) + respawn bar (clipped to the share of the respawn time)
//   Respawn_Wep_SelectBG    weapon change: rsSlotBg1..5 rows (prev / selected / next, arrows), rsConfirm / rsCancel, rsLimitKey = manual text
// The Cross panel has no class tabs and no search box: the primary filter stays null.
// Weapon cards = CBattleGui slot update 0x71d570 (Cross exe; controls linked at 0x71f1a0, row struct this+0xb4 + slot*0x54):
//   rs{Prev,Select,Next}Weapon%d  multi-shape Static: SetAllShapeEnable(0) + SetShapeEnable(k, 1). HudSlot (side): 0 card,
//                                 1 card with "VAZIO"; HudSelect: 0 SELECT frame, 1 card, 2 card with "VAZIO"
//   rs*WeaponDummy%d              the icon: ChangeFirstShape with the 204x57 weapon cell (0x522fe0 -> 0x7a6d30), hidden
//                                 without a cell; colour alpha 125, 255 when the room allows the slot
//   rs*WeaponValue%d              weapon name (0x71d470: SetText + enable, colour 215,211,210)
//   rs*WeaponCategory%d           STBL_IDX_WEAPON_CLASS_* only for class 3..6 / 10 (0x71e670), else hidden
//   rs*WeaponExtension%d          "+Extension" art, enabled only when the weapon has one (CGunInfo vf 0x1d8 0x5ea860 =
//                                 getExtensionType(0) != 0; weapons.json pb.extType) [INFERIDO for non-gun info classes]
// Empty slot: select card shape 2, side cards shape 1, arrows disabled. Side cards: prev / next item (0x71e860 / 0x71e6f0),
// with 2 items only the one toward the other end (0x71e0aa / 0x71e35d). Focused row = rsSlotEnable (0x71b5e4).
// Keyboard arrows / Enter / Esc stay [INFERIDO] (respawnSelect.ts).
import { lockPointer } from "../lockPointer.ts";
import { Stage } from "../lobby/ui/LayoutRenderer.ts";
import { UI_BASE } from "../lobby/ui/assets.ts";
import { I3Gui, cloneNode, findNode, type GNode } from "../lobby/ui/i3Gui.ts";
import { iconOf, loadCrossIcons, paintRect } from "../lobby/screens/icons.ts";
import { loadStrings, tOr } from "../lobby/ui/i18n.ts";
import { itemName, loadItemNames } from "../lobby/state/itemNames.ts";
import {
  BAREFIST_ID, CHANGE_WEAPON_KEY, KNUCKLE_STAGE, RESPAWN_SLOTS, RespawnSelection, catalogFromWeapons, slotAllowed,
  type RespawnInventory, type WeaponCatalog,
} from "./respawnSelect.ts";
import { testInventory } from "./testLoadout.ts";
import { jsonOnce } from "../jsonOnce.ts";

const CROSS = `${UI_BASE}/cross`;

/** Category text of 0x71e670: weapon class type 3..6 and 10 only (class -> STBL_IDX_WEAPON_CLASS_* 0x5f6030) */
const CATEGORY_KEY: Record<number, string> = { 3: "ASSAULT", 4: "SMG", 5: "SNIPER", 6: "SHOTGUN", 10: "MG" };

interface WeaponsJson {
  defaultLoadout: { primary: number; secondary: number; melee: number; grenade: number };
  weapons: { id: number; slot: number; className: string; classType?: number; name: string; pb?: { extType?: string } }[];
}
/** what a card needs beyond the catalog: class type (category) and Extension1 Type (the "+Extension" art) */
interface CardInfo { classType: number; ext: boolean }

/** Respawn_BG tree of UI_Project_HUD.json (cached by jsonOnce; cloned per window) */
const respawnTree = async (): Promise<GNode> => {
  const root = (await jsonOnce<{ root: GNode }>(`${CROSS}/UI_Project_HUD.json`)).root;
  const tree = findNode(root, "Respawn_BG");
  if (!tree) throw new Error("[respawn] no Respawn_BG in UI_Project_HUD.json");
  return cloneNode(tree);
};

/** Cross markup of the notice text ({col:r,g,b,a}..{/col}) dropped: the EditBox takes plain text */
const plain = (s: string): string => s.replace(/\{col:[^}]*\}|\{\/col\}/g, "");

export interface RespawnHudState {
  dead: boolean;
  /** seconds until respawn, total delay */
  respawnLeft: number;
  respawnTotal: number;
  invincibleSec: number;
  /** panel may open (match live or waiting respawn) */
  canOpen: boolean;
}

const ROWS = RESPAWN_SLOTS.map((_, i) => i + 1);

export class RespawnMenu {
  readonly sel: RespawnSelection;
  readonly catalog: WeaponCatalog;
  private stage: Stage;
  private gui: I3Gui;
  private cards: Map<number, CardInfo>;
  private abort = new AbortController();
  private lastNotice = "";
  private dirty = true;
  private canOpen = false;
  /** repaint of the rsSlotPrev / rsSlotNext buttons (enabled = a card on that side) */
  private arrows: (() => void)[] = [];

  private constructor(host: HTMLElement, sel: RespawnSelection, catalog: WeaponCatalog, tree: GNode, cards: Map<number, CardInfo>) {
    this.sel = sel;
    this.catalog = catalog;
    this.cards = cards;
    this.stage = new Stage(host); // letterboxed 1024x768. [INFERIDO] "px" (SetViewer(viewer, 0) at 0x718d62 read as 1:1) put it top-left on wide windows: reverted
    this.stage.el.style.cssText = "background:transparent;pointer-events:none;z-index:30";
    this.gui = new I3Gui({ base: CROSS });
    this.gui.build(tree, this.stage.design, 0, 0);
    this.gui.hide("Respawn_Text"); // remaining-respawn counter: Madness / limited-respawn modes only
    this.gui.hide("Respawn_Seconds");
    this.gui.hide("Respawn_Wep_SelectBG");
    this.gui.hide("Respawn_Wait");
    for (const n of ROWS) for (const k of ["rsSlotBg", "rsSlotPrev", "rsSlotNext", "rsPrevWeapon", "rsSelectWeapon", "rsNextWeapon"]) {
      const b = this.gui.get(`${k}${n}`);
      if (b) b.el.style.pointerEvents = "auto";
    }
    for (const k of ["rsConfirm", "rsCancel"]) this.gui.get(k)!.el.style.pointerEvents = "auto";
    this.wire();
  }

  /**
   * Loads the Cross window, strings, item names, icons and weapons.json.
   * `inventory`: online = inventoryFromPlayer(PlayerStore); omitted = offline test inventory (testLoadout.ts: one
   * weapon per type), or with `equippedOnly` just the default loadout (net game without inventory data).
   */
  static async create(host: HTMLElement, opts: { inventory?: RespawnInventory; equippedOnly?: boolean; weaponsFlag?: number; stage?: number } = {}): Promise<RespawnMenu> {
    const W = `${UI_BASE.replace(/\/ui$/, "")}/weapons`;
    const [tree, weapons] = await Promise.all([
      respawnTree(),
      jsonOnce<WeaponsJson>(`${W.replace(/\/weapons$/, "/cross/weapons")}/weapons.json`),
      loadCrossIcons(), loadStrings(), loadItemNames(),
    ]);
    const cards = new Map(weapons.weapons.map((w) => [w.id, { classType: w.classType ?? 0, ext: !!w.pb?.extType }]));
    const d = weapons.defaultLoadout;
    const inv = opts.inventory ?? (opts.equippedOnly
      ? { items: [], equipped: { ...d, special: 0 } } // net without inventory data: no change possible
      : testInventory()); // offline: one weapon per type, testLoadout.ts
    const catalog = catalogFromWeapons(weapons.weapons);
    const sel = new RespawnSelection(catalog, inv, opts.weaponsFlag, opts.stage === KNUCKLE_STAGE ? BAREFIST_ID : null);
    return new RespawnMenu(host, sel, catalog, tree, cards);
  }

  get isOpen(): boolean { return this.sel.isOpen; }

  private wire(): void {
    const signal = this.abort.signal;
    // While the panel is open the stage takes the clicks (the game does not see them; main.ts re-locks the pointer on close)
    this.stage.el.addEventListener("click", (ev) => ev.stopPropagation(), { signal });
    this.gui.button("rsConfirm", () => this.close(true));
    this.gui.button("rsCancel", () => this.close(false));
    for (const n of ROWS) {
      const i = n - 1;
      // 0x71b370: a disabled arrow (no card on that side) stops the change; the change focuses the row (0x71b5e4)
      const can = (dir: 1 | -1) => (dir < 0 ? this.sides(i).prev : this.sides(i).next) !== null;
      const go = (dir: 1 | -1) => { if (!can(dir)) return; this.sel.focus = i; this.sel.cycle(i, dir); this.dirty = true; };
      this.arrows.push(
        this.gui.button(`rsSlotPrev${n}`, () => go(-1), () => can(-1)),
        this.gui.button(`rsSlotNext${n}`, () => go(1), () => can(1)),
      );
      // side cards (0x71a8c5 / 0x71a908): click = change, pointer over = the arrow's over sprite (0x71b670)
      for (const [card, arrow, dir] of [["Prev", "rsSlotPrev", -1], ["Next", "rsSlotNext", 1]] as const) {
        const el = this.gui.get(`rs${card}Weapon${n}`)?.el;
        if (!el) continue;
        el.addEventListener("click", (e) => { e.stopPropagation(); go(dir); }, { signal });
        el.addEventListener("pointerenter", () => { if (can(dir)) this.gui.setState(`${arrow}${n}`, 1); }, { signal });
        el.addEventListener("pointerleave", () => this.gui.setState(`${arrow}${n}`, can(dir) ? 0 : 3), { signal });
      }
      this.gui.get(`rsSelectWeapon${n}`)?.el.addEventListener("click", (e) => {
        e.stopPropagation();
        this.sel.focus = i;
        this.dirty = true;
      }, { signal });
    }
    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement | null)?.closest?.("input,textarea")) return;
      if (e.code === CHANGE_WEAPON_KEY.code && !e.repeat) {
        if (this.sel.isOpen) this.close(false);
        else if (this.canOpen) this.open();
        e.preventDefault();
        return;
      }
      // the arrow keys change like the arrow buttons: nothing when that side has no card
      const dir = e.code === "ArrowLeft" ? -1 : e.code === "ArrowRight" ? 1 : 0;
      const side = dir && this.sel.isOpen ? this.sides(this.sel.focus) : null;
      if (side && (dir < 0 ? side.prev : side.next) === null) { e.preventDefault(); e.stopPropagation(); return; }
      if (this.sel.isOpen && this.sel.key(e.code)) {
        e.preventDefault();
        e.stopPropagation();
        if (!this.sel.isOpen) this.afterClose();
        this.dirty = true;
      }
    }, { signal, capture: true });
    document.addEventListener("pointerlockchange", () => {
      if (this.sel.isOpen) document.getElementById("blocker")?.classList.add("hidden");
    }, { signal });
  }

  open(): void {
    this.sel.open();
    this.dirty = true;
    this.stage.el.style.pointerEvents = "auto";
    this.gui.show("Respawn_Wep_SelectBG", true);
    this.gui.hide("Respawn_Wait");
    if (document.pointerLockElement) document.exitPointerLock();
  }

  close(confirm: boolean): void {
    this.sel.close(confirm);
    this.afterClose();
  }

  private afterClose(): void {
    this.stage.el.style.pointerEvents = "none";
    this.gui.show("Respawn_Wep_SelectBG", false);
    // back to the game (a click / keydown is a user gesture, so the lock request is allowed)
    if (document.pointerLockElement !== document.body) {
      try { void lockPointer(); } catch { /* no user gesture: main.ts blocker click re-locks */ }
    }
  }

  /** Per frame (Game.updateHud). */
  update(s: RespawnHudState): void {
    this.canOpen = s.canOpen;
    if (!s.canOpen && this.sel.isOpen) this.close(false);
    // the weapon panel covers the notice and the bar: they show only while the panel is closed [INFERIDO]
    this.gui.show("Respawn_Wait", s.dead && !this.sel.isOpen);
    if (s.dead) {
      const notice = plain(tOr("STR_TBL_BATTLEGUI_NOTICE_RESPAWN", ""))
        .replace("%d", String(Math.round(s.invincibleSec)))
        .replace("%s", CHANGE_WEAPON_KEY.name);
      if (notice !== this.lastNotice) {
        this.lastNotice = notice;
        this.gui.setText("Respawn_Notice", notice);
      }
      // the respawn bar: visible part = elapsed share of the respawn time (clip, the bar art itself is not scaled)
      const frac = s.respawnTotal > 0 ? Math.min(1, Math.max(0, 1 - s.respawnLeft / s.respawnTotal)) : 1;
      const bar = this.gui.get("Respawn_Time_Bar");
      if (bar) bar.el.style.clipPath = `inset(0 ${((1 - frac) * 100).toFixed(2)}% 0 0)`;
    }
    if (this.sel.isOpen && this.dirty) this.renderPanel();
  }

  /** prev / next card of a row (0x71e0aa / 0x71e35d): 3+ items both, 2 items only toward the other one, 1 / empty none */
  private sides(i: number): { prev: number | null; next: number | null } {
    const v = this.sel.view(i), n = v.list.length;
    if (!v.cur || n < 2) return { prev: null, next: null };
    return { prev: n > 2 || v.index > 0 ? v.prev : null, next: n > 2 || v.index < n - 1 ? v.next : null };
  }

  /** one weapon card: shape `shape` of the card, then (with an item) icon, name, category and the extension art */
  private card(side: "Prev" | "Select" | "Next", n: number, shape: number, id: number | null, allowed: boolean): void {
    const g = this.gui, base = `rs${side}Weapon`;
    g.setAllShapeEnable(`${base}${n}`, false);
    g.setShapeEnable(`${base}${n}`, shape, true);
    const info = id ? this.cards.get(id) : undefined;
    const cat = info ? CATEGORY_KEY[info.classType] : undefined;
    g.show(`${base}Value${n}`, !!id);
    g.show(`${base}Category${n}`, !!cat);
    g.show(`${base}Extension${n}`, !!info?.ext);
    if (id) {
      g.setText(`${base}Value${n}`, this.name(id));
      g.setColor(`${base}Value${n}`, "rgb(215,211,210)");
    }
    if (cat) g.setText(`${base}Category${n}`, tOr(`STBL_IDX_WEAPON_CLASS_${cat}`, ""));
    this.setIcon(`${base}Dummy${n}`, id, allowed ? 1 : 125 / 255);
  }

  private name(id: number): string {
    const n = itemName(id);
    return n.source === "none" ? (this.catalog(id)?.name ?? "") : n.name;
  }

  /** the weapon cell in the Dummy (ChangeFirstShape; lobby fit rule, paintRect); no cell = hidden (0x7a6d61) */
  private setIcon(name: string, id: number | null, alpha: number): void {
    const dummy = this.gui.get(name);
    if (!dummy) return;
    let img = dummy.el.querySelector<HTMLElement>(":scope > .rsp-icon");
    if (!img) {
      img = document.createElement("div");
      img.className = "rsp-icon";
      img.style.cssText = "position:absolute;pointer-events:none";
      dummy.el.appendChild(img);
    }
    const r = id ? iconOf(id) : null;
    img.style.display = r ? "" : "none";
    if (!r) return;
    paintRect(img, r, dummy.node.w, dummy.node.h);
    img.style.opacity = String(alpha);
  }

  private renderPanel(): void {
    this.dirty = false;
    const sel = this.sel;
    const manual = tOr("STR_TBL_BATTLEGUI_NOTICE_SELECETWEAPON", "") +
      (sel.limited() ? `\n${tOr("STR_TBL_BATTLEGUI_NOTICE_WEAPON_LIMIT", "")}` : "");
    this.gui.setText("rsLimitKey", plain(manual));
    ROWS.forEach((n, i) => {
      const v = sel.view(i), s = this.sides(i);
      // 0x71dafe: a slot the room weapon limit bars keeps the dim icons and the select card without its SELECT frame
      const allowed = slotAllowed(v.slot, sel.weaponsFlag);
      this.card("Select", n, !v.cur ? 2 : allowed ? 0 : 1, v.cur || null, allowed);
      this.card("Prev", n, s.prev ? 0 : 1, s.prev, allowed);
      this.card("Next", n, s.next ? 0 : 1, s.next, allowed);
      this.gui.show(`rsSlotEnable${n}`, i === sel.focus);
      this.gui.show(`rsSlotDisable${n}`, i !== sel.focus);
      this.gui.setText(`rsSlotKey${n}`, tOr(`STBL_IDX_GAMEKEY_CHANGEWEPON_${n}`, ""));
    });
    for (const repaint of this.arrows) repaint();
  }

  dispose(): void {
    this.abort.abort();
    this.stage.destroy();
  }
}
