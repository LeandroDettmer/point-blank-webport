// Item icons from the PBCross index (public/assets/ui/cross/icons/index.json,, pb-extract-tools export-cross-icons.mjs,
// format in). The index is keyed by server item id (407004 = K-413, 407002 = C5), so no 2017 pack
// numbering is needed. A record is a cell of a shared atlas (the CEquipShapeManager grids: weapon 204x57, character 134x78,
// head / beret / mask 135x78, cash item 90x65 with Count = item_cash_A and Perido = item_cash_B, 1 px gutter 0x7a5290), so it
// is painted as a sprite. Ids the index has no cell for get a neutral card with the item class name (.pbui-noicon) [RECRIADO],
// never another item's picture.
import { UI_BASE, keepImage } from "../ui/assets.ts";
import { setIconNames } from "../state/itemNames.ts";

export interface CrossRect { sheet: string; x: number; y: number; w: number; h: number; status: string; atlas: string; family: string; name?: string; list?: string; match?: string }

/** public/assets/ui/cross/icons/index.json: the atlases, icons (server id), goods (3.123 goodsId), maps, cards and byName tables */
export interface CrossIconIndex {
  atlases: Record<string, { sheet: string; w: number; h: number }>;
  /** server item id -> rect: weapon, character, head, beret, mask, cash item */
  icons: Record<string, CrossRect>;
  /** 3.123 goodsId -> rect (packages) */
  goods: Record<string, CrossRect>;
  /** STAGE_ID & 0xff (Cross ordinal) or "random" -> rect; byName.map is keyed by the Stage.pef name */
  maps: Record<string, CrossRect>;
  /** "<set>:<card>" -> card 34x55; cardSets: set -> deck 56x59 */
  cards: Record<string, CrossRect>;
  cardSets: Record<string, CrossRect>;
  byName: Record<string, Record<string, CrossRect>>;
}

let cross: CrossIconIndex | null = null;
let crossLoad: Promise<CrossIconIndex> | null = null;

/** loads the Cross index once (1.3 MB); resolves to an empty index when it is not exported */
export function loadCrossIcons(): Promise<CrossIconIndex> {
  return (crossLoad ??= fetch(`${UI_BASE}/cross/icons/index.json`)
    .then((r) => (r.ok ? (r.json() as Promise<CrossIconIndex>) : Promise.reject(new Error(`HTTP ${r.status}`))))
    .catch((e) => { console.warn("[icons] cross", e); return { atlases: {}, icons: {}, goods: {}, maps: {}, cards: {}, cardSets: {}, byName: {} }; })
    .then((j) => {
      console.info(`[icons] cross:${Object.keys(j.icons).length} goods:${Object.keys(j.goods).length}`);
      return (cross = j);
    }));
}

/** the Cross index once loaded (null before) */
export const crossIcons = (): CrossIconIndex | null => cross;

/** Loads the Cross index once and names the items by its pef keys (itemNames level 4). */
export function loadIconIndex(): Promise<void> {
  return loadCrossIcons().then((ix) => {
    const names: Record<string, string> = {};
    for (const [id, v] of Object.entries(ix.icons)) if (v.name) names[id] = v.name;
    setIconNames(names);
  });
}

/** the item's cell (icons, then goods; coupon 17 DD GGG -> its function item 16 00 GGG); null before the index loads */
export function iconOf(itemId: number): CrossRect | null {
  if (!cross || !itemId) return null;
  const r = cross.icons[itemId] ?? cross.goods[itemId];
  if (r) return r;
  // coupon 17 DD GGG (DD days; shop offers use DD = 00) activates the function item 16 00 GGG: same icon
  return Math.floor(itemId / 100000) === 17 ? iconOf(1600000 + (itemId % 1000)) : null;
}

/** Item class name for the no-icon card (server ItemClass, Plugin.Core/Enums/ItemClass.cs) [RECRIADO]. */
export function noIconLabel(itemId: number): string {
  const c = Math.floor(itemId / 100000);
  if (c >= 9 && c <= 14) return ["Uniforme", "Calça", "Luva", "Cinto", "Coldre", "Skin"][c - 9];
  return ({ 15: "Dino", 16: "Manutenção", 17: "Consumível", 18: "Cupom", 20: "Pontos", 22: "Cartão de missão", 26: "Cartão de missão", 27: "Boina", 28: "Caixa",
    30: "Acessório", 32: "Emblema", 33: "Emblema", 34: "Cartão de nome", 35: "Cartão de nome", 36: "Passe" } as Record<number, string>)[c] ?? "Item";
}

/**
 * Paints cell `r` into `el` (absolute, inside a bw x bh box). The exe sets the cell as the control's texture coords, so a
 * box of the cell's size shows it 1:1; a box of another size (weImageDummy 512x280, shopWeaponDummy 203x55) gets the cell
 * fitted and centred, aspect kept [INFERIDO]. `el` is resized to the cell so the atlas neighbours never show.
 */
export function paintRect(el: HTMLElement, r: CrossRect, bw: number, bh: number): void {
  const a = cross?.atlases[r.atlas], s = Math.min(bw / r.w, bh / r.h);
  const url = `${UI_BASE}/${r.sheet}`;
  keepImage(url);
  el.classList.remove("pbui-missing", "pbui-noicon");
  delete el.dataset.noicon;
  delete el.dataset.status;
  el.title = "";
  Object.assign(el.style, {
    left: `${(bw - r.w * s) / 2}px`, top: `${(bh - r.h * s) / 2}px`, width: `${r.w * s}px`, height: `${r.h * s}px`,
    backgroundImage: `url("${url}")`, backgroundRepeat: "no-repeat",
    backgroundSize: a ? `${a.w * s}px ${a.h * s}px` : "", backgroundPosition: `${-r.x * s}px ${-r.y * s}px`,
  });
}

/**
 * The item's icon in `el` (a bw x bh box, default the element's own box). No cell in the Cross index: the neutral card with
 * the item class name [RECRIADO]. The exe hides the control instead (SetCharacterShape 0x7a6ef4 / 0x7a7237, SetWeaponSelectMark
 * 0x7a6d61: vf 0x110 (0)) [INFERIDO for the card].
 */
export function paintIcon(el: HTMLElement, itemId: number, bw = el.clientWidth, bh = el.clientHeight): void {
  const r = iconOf(itemId);
  if (r) return paintRect(el, r, bw || r.w, bh || r.h);
  Object.assign(el.style, { left: "0", top: "0", width: "", height: "", backgroundImage: "", backgroundPosition: "", backgroundSize: "" });
  el.classList.remove("pbui-missing");
  el.classList.add("pbui-noicon");
  el.dataset.noicon = noIconLabel(itemId);
  el.title = `[RECRIADO] sem ícone para ${itemId}`;
}
