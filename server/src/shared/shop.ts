// Plugin.Core/Managers/ShopManager.cs (Load(1) then Load(2), no Reset in between, like Server.Host/Program.cs),
// BattleBoxXML (system_battle_boxes) and ZlibUtil.Compress. Shared by Auth (IsPackedGood/GetGood for the visit and
// login events) and Game (catalog burst on 1029, GetGoods on 1045).
import { deflateSync } from "node:zlib";
import { pool } from "../db.ts";
import { ItemsModel, ItemEquipType, getIdStatics } from "./items.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} [shop] ${m}`);

export const ItemTag = { None: 0, New: 1, Hot: 2, Event: 3, PcCafe: 4, Sale: 5 } as const;

export class GoodsItem {
  id = 0;
  priceGold = 0;
  priceCash = 0;
  authType = 0;
  buyType2 = 0;
  buyType3 = 0;
  title = 0;
  visibility = 0;
  starGold = 0;
  starCash = 0;
  tag = 0;
  item = new ItemsModel(0, "", ItemEquipType.Durable, 0);
}
interface ItemsRepair { id: number; point: number; cash: number; quantity: number; enable: boolean }
interface ShopData { buffer: Uint8Array; itemsCount: number; offset: number }
interface ItemsLimited { goodId: number; itemId: number; variantIndex: number; startDate: bigint; endDate: bigint; saleType: number; initialStock: number; remain: number; enabled: boolean; itemCount: number; cashPrice: number; goldPrice: number }

const S = {
  all: [] as GoodsItem[],
  buyable: [] as GoodsItem[],
  unique: new Map<number, GoodsItem>(),
  repairs: [] as ItemsRepair[],
  limited: [] as ItemsLimited[],
  tags: new Set<number>(),
  set4p: 0,
  flashSaleGoodIds: [] as number[],
  flashSaleStartDate: 0,
  flashSaleEndMinute: 0,
  mt1: [] as ShopData[], mt2: [] as ShopData[], goods: [] as ShopData[], items: [] as ShopData[], itemRepairs: [] as ShopData[],
  totalGoods: 0, totalItems: 0, totalMatching1: 0, totalMatching2: 0, totalRepairs: 0,
  packedGoodsIds: new Set<number>(),
  packedGoods: new Uint8Array(0) as Uint8Array, packedItems: new Uint8Array(0) as Uint8Array, packedRepairs: new Uint8Array(0) as Uint8Array,
  packedMt1: new Uint8Array(0) as Uint8Array, packedMt2: new Uint8Array(0) as Uint8Array,
  catalogVersion: 0,
  battleBoxes: [] as ShopData[], totalBoxes: 0,
};
export const shop = S;

const csv = (v: unknown) => { const s = v == null ? "" : String(v); return s.includes(",") ? s.split(",") : [s]; };
const tryInt = (s: string | undefined): number | null => { const t = (s ?? "").trim(); return /^[+-]?\d+$/.test(t) && Math.abs(Number(t)) <= 2147483647 ? Number(t) : null; };
const tryUInt = (s: string | undefined): number | null => { const t = (s ?? "").trim(); return /^\+?\d+$/.test(t) && Number(t) <= 4294967295 ? Number(t) : null; };
const pad2 = (n: number) => (n < 0 ? "-" + String(-n).padStart(2, "0") : String(n).padStart(2, "0"));
/** ComDiv.Percentage (int32 math). */
const percentage = (total: number, pct: number) => Math.trunc(Math.imul(total, pct) / 100);
/** Npgsql column lookup is case-insensitive (system_shop has "Item_count_list"). */
const col = (row: Record<string, unknown>, name: string) => { for (const k in row) if (k.toLowerCase() === name) return row[k]; return undefined; };
const int = (v: unknown) => { const n = tryInt(v == null ? "" : String(v)); if (n === null) throw new Error(`int.Parse("${v}")`); return n; };
const bool = (v: unknown) => v === true || String(v).toLowerCase() === "true";

function isRepairableItem(id: number): boolean { return S.repairs.some((r) => r.id === id); }

async function loadRepairableItems(type: number): Promise<void> {
  try {
    for (const x of (await pool.query(`SELECT * FROM system_shop_repair`)).rows) {
      const r: ItemsRepair = { id: int(x.item_id), point: int(x.price_gold), cash: int(x.price_cash), quantity: int(x.quantity) >>> 0, enable: bool(x.repairable) };
      if (type === 1 && r.enable && r.quantity <= 100) S.repairs.push(r);
    }
  } catch (e) { log(`LoadRepairableItems: ${(e as Error).message}`); }
}

function addGood(g: GoodsItem, capped: boolean, junk: boolean, emitted: { n: number }): void {
  S.all.push(g);
  if (g.visibility !== 2 && g.visibility !== 4) {
    if (!capped) S.buyable.push(g);
    else if (!junk && emitted.n < 4) { S.buyable.push(g); emitted.n++; }
  }
  if (!S.unique.has(g.item.id) && g.authType > 0) {
    S.unique.set(g.item.id, g);
    if (g.visibility === 4) S.set4p++;
  }
}

async function loadShopItems(type: number): Promise<void> {
  try {
    for (const x of (await pool.query(`SELECT * FROM system_shop`)).rows) {
      const itemId = int(x.item_id);
      const counts = csv(col(x, "item_count_list"));
      let cash = csv(x.price_cash_list), gold = csv(x.price_gold_list);
      const codes = csv(x.variant_code_list);
      const n = counts.length;
      if (cash.length < n) cash = Array.from({ length: n }, (_, i) => (i < cash.length ? cash[i] : "0"));
      if (gold.length < n) gold = Array.from({ length: n }, (_, i) => (i < gold.length ? gold[i] : "0"));
      let hasPriced = false;
      for (let p = 0; p < n; p++) if ((tryInt(cash[p]) ?? 0) > 0 || (tryInt(gold[p]) ?? 0) > 0) hasPriced = true;
      const emitted = { n: 0 };
      let vi = 0;
      for (const countStr of counts) {
        vi++;
        const cnt = tryUInt(countStr);
        if (cnt === null) continue;
        const pc = tryInt(cash[vi - 1]), pg = tryInt(gold[vi - 1]);
        if (pc === null || pg === null) continue;
        const cat = Math.trunc(itemId / 100000);
        const special = cat === 22 || cat === 26 || cat === 36 || cat === 37 || cat === 40;
        const vc = codes.length >= vi ? tryInt(codes[vi - 1]) : null;
        const suffix = vc !== null ? pad2(vc) : special ? "00" : pad2(vi);
        const g = new GoodsItem();
        g.id = int(`${itemId}${suffix}`);
        g.priceGold = pg;
        g.priceCash = pc;
        g.visibility = bool(x.item_visible) ? 0 : 4;
        let disc = int(x.discount_percent);
        if (g.visibility === 4) disc = 0;
        if (disc > 0 && g.priceCash > 0) { g.starCash = Math.imul(g.priceCash, 255); g.priceCash = percentage(g.priceCash, disc); }
        if (disc > 0 && g.priceGold > 0) { g.starGold = Math.imul(g.priceGold, 255); g.priceGold = percentage(g.priceGold, disc); }
        const tag = int(x.shop_tag);
        g.tag = tag & 0xff;
        if (tag >= 1 && tag <= 255) S.tags.add(tag);
        g.title = int(x.title_requi);
        g.authType = int(x.item_consume);
        g.buyType2 = g.authType === 2 ? 1 : isRepairableItem(itemId) ? 2 : 1;
        g.buyType3 = g.authType === 1 ? 2 : 1;
        g.item.setItemId(itemId);
        const name = String(x.item_name ?? "");
        g.item.name = g.authType === 1 ? `${name} (${cnt} qty)` : g.authType === 2 ? `${name} (${Math.trunc(cnt / 3600)} hours)` : name;
        g.item.count = cnt;
        const junk = g.priceCash === 0 && g.priceGold === 0 && hasPriced;
        if (type === 1) addGood(g, true, junk, emitted);
        else if (type === 2 && (cat === 16 || g.visibility === 4)) addGood(g, true, junk, emitted);
      }
    }
  } catch (e) { log(`LoadShopItems: ${(e as Error).message}`); }
}

async function loadShopEffects(type: number): Promise<void> {
  try {
    for (const x of (await pool.query(`SELECT * FROM system_shop_effects`)).rows) {
      const couponId = int(x.coupon_id);
      const days = csv(x.coupon_count_day_list), cash = csv(x.price_cash_list), gold = csv(x.price_gold_list);
      if (days.length !== cash.length || days.length !== gold.length) continue;
      let vi = 0;
      for (const d of days) {
        vi++;
        let dayCount = tryInt(d);
        const pc = tryInt(cash[vi - 1]), pg = tryInt(gold[vi - 1]);
        if (dayCount === null || pc === null || pg === null) continue;
        if (dayCount >= 100) dayCount = 100;
        const s = `${couponId}`;
        const itemId = int(s.substring(0, 2) + pad2(dayCount) + s.substring(4, 7));
        const g = new GoodsItem();
        g.id = int(`${couponId}${pad2(vi)}`);
        g.priceGold = pg;
        g.priceCash = pc;
        const disc = int(x.discount_percent);
        if (disc > 0 && g.priceCash > 0) { g.starCash = Math.imul(g.priceCash, 255); g.priceCash = percentage(g.priceCash, disc); }
        if (disc > 0 && g.priceGold > 0) { g.priceGold = Math.imul(g.priceGold, 255); g.priceGold = percentage(g.priceGold, disc); } // C# bug kept
        const tag = int(x.shop_tag);
        g.tag = tag & 0xff;
        if (tag >= 1 && tag <= 255) S.tags.add(tag);
        g.title = 0; g.authType = 1; g.buyType2 = 1; g.buyType3 = 2;
        g.visibility = bool(x.coupon_visible) ? 0 : 4;
        g.item.setItemId(itemId);
        g.item.name = `${String(x.coupon_name ?? "")} (${dayCount} days)`;
        g.item.count = 1;
        if (type === 1) addGood(g, false, false, { n: 0 });
        else if (type === 2 && Math.trunc(itemId / 100000) === 16) addGood(g, false, false, { n: 0 });
      }
    }
  } catch (e) { log(`LoadShopEffects: ${(e as Error).message}`); }
}

async function loadShopSets(): Promise<void> {
  try {
    const n = (await pool.query(`SELECT count(*) AS n FROM system_shop_sets WHERE visible = 'True'`)).rows[0].n;
    if (Number(n) > 0) log(`WARNING ${n} visible system_shop_sets: set goods are not ported (system_shop_sets_items)`);
  } catch (e) { log(`LoadShopSets: ${(e as Error).message}`); }
}

async function loadLimitedItems(): Promise<void> {
  S.limited = [];
  for (const x of (await pool.query(`SELECT * FROM system_shop WHERE count_limited IS NOT NULL AND count_limited > 0`)).rows) {
    try {
      const itemId = int(x.item_id), cat = Math.trunc(itemId / 100000);
      const special = cat === 22 || cat === 26 || cat === 36 || cat === 37 || cat === 40;
      const stock = int(x.count_limited) >>> 0;
      S.limited.push({
        goodId: int(`${itemId}${special ? "00" : "01"}`), itemId, variantIndex: 1,
        startDate: BigInt(x.start_date ?? 0), endDate: BigInt(x.end_date ?? 0), saleType: x.sale_type == null ? 2 : int(x.sale_type),
        initialStock: stock, remain: stock, enabled: true,
        itemCount: tryInt(csv(col(x, "item_count_list"))[0]) ?? 0, cashPrice: tryInt(csv(x.price_cash_list)[0]) ?? 0, goldPrice: tryInt(csv(x.price_gold_list)[0]) ?? 0,
      });
    } catch (e) { log(`LoadLimitedItems row: ${(e as Error).message}`); }
  }
}

async function loadFlashSale(): Promise<void> {
  S.flashSaleGoodIds = []; S.flashSaleStartDate = 0; S.flashSaleEndMinute = 0;
  try {
    const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
    const now = Number(`${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`);
    const r = await pool.query(
      `SELECT l.item_id, l.variant_index, l.start_date, l.end_date, s.variant_code_list FROM system_shop_limited l
       JOIN system_shop s ON s.item_id = l.item_id WHERE l.enabled = TRUE AND s.item_visible = TRUE
       AND l.start_date <= $1 AND l.end_date >= $1 ORDER BY l.id LIMIT 3`, [now]);
    const ids: number[] = [];
    let start = 0, end = 0;
    for (const x of r.rows) {
      const codes = String(x.variant_code_list ?? "").split(",");
      let vi = Number(x.variant_index);
      if (vi < 1 || vi > codes.length) vi = 1;
      const code = tryInt(codes[vi - 1].trim());
      if (code === null) continue;
      ids.push(Number(x.item_id) * 100 + code);
      const sd = Number(x.start_date), ed = Number(x.end_date);
      if (start === 0 || sd < start) start = sd;
      if (end === 0 || ed < end) end = ed;
    }
    if (ids.length === 0) return;
    S.flashSaleGoodIds = ids;
    S.flashSaleStartDate = start >>> 0;
    S.flashSaleEndMinute = Math.trunc(end / 10000) > Math.trunc(now / 10000) ? 1439 : Math.trunc((end % 10000) / 100) * 60 + (end % 100);
  } catch (e) { log(`LoadFlashSale: ${(e as Error).message}`); }
}

function pages(list: GoodsItem[] | ItemsRepair[], per: number, size: number, write: (b: DataView, o: number, x: never) => void): ShopData[] {
  const out: ShopData[] = [];
  for (let p = 0; p * per < list.length; p++) {
    const part = list.slice(p * per, (p + 1) * per);
    const buf = new Uint8Array(part.length * size);
    const dv = new DataView(buf.buffer);
    part.forEach((x, i) => write(dv, i * size, x as never));
    out.push({ buffer: buf, itemsCount: part.length, offset: p * per });
  }
  return out;
}
const le32 = (dv: DataView, o: number, v: number) => dv.setUint32(o, v >>> 0, true);
const writeMatching = (dv: DataView, o: number, g: GoodsItem) => { le32(dv, o, g.id); le32(dv, o + 4, g.item.id); le32(dv, o + 8, g.item.count); le32(dv, o + 12, 0); };

function buildMatching(): void {
  const priced = new Set(S.all.filter((g) => g.priceCash > 0 || g.priceGold > 0).map((g) => g.item.id));
  const eligible = (g: GoodsItem) => g.visibility !== 4 && (g.priceCash > 0 || g.priceGold > 0 || !priced.has(g.item.id));
  const match = (g: GoodsItem, f: number) => eligible(g) && (g.tag !== ItemTag.PcCafe || f !== 0) && ((g.tag === ItemTag.PcCafe && f > 0) || g.visibility !== 2);
  const mt1 = S.all.filter((g) => g.item.count !== 0 && match(g, 0));
  const goods = S.all.filter((g) => g.item.count !== 0 && (g.visibility < 2 || g.visibility === 4));
  const mt2 = S.all.filter((g) => g.item.count !== 0 && match(g, 1));
  S.totalMatching1 = mt1.length; S.totalGoods = goods.length; S.totalMatching2 = mt2.length;
  S.mt1 = pages(mt1, 500, 16, writeMatching);
  S.mt2 = pages(mt2, 500, 16, writeMatching);
  S.goods = pages(goods, 50, 128, (dv, o, g: GoodsItem) => {
    le32(dv, o, g.id); dv.setUint8(o + 4, 1); dv.setUint8(o + 5, g.visibility === 4 ? 4 : 1); le32(dv, o + 6, g.priceGold); le32(dv, o + 10, g.priceCash);
    dv.setUint8(o + 18, g.tag); le32(dv, o + 22, g.starCash > 0 ? g.starCash : g.starGold > 0 ? g.starGold : 0);
  });
}

function buildUniqueAndRepairs(): void {
  const uniq = [...S.unique.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g).filter((g) => g.visibility !== 1 && g.visibility !== 3);
  S.totalItems = uniq.length;
  S.items = pages(uniq, 800, 11, (dv, o, g: GoodsItem) => {
    le32(dv, o, g.item.id); dv.setUint8(o + 4, g.authType); dv.setUint8(o + 5, g.buyType2); dv.setUint8(o + 6, g.buyType3);
    dv.setUint8(o + 7, g.title); dv.setUint8(o + 8, g.title !== 0 ? 2 : 0);
  });
  const div = (a: number, b: number) => { const v = a / b; return Number.isFinite(v) ? Math.trunc(v) : -2147483648; };
  S.totalRepairs = S.repairs.length;
  S.itemRepairs = pages(S.repairs, 100, 16, (dv, o, r: ItemsRepair) => {
    le32(dv, o, r.id); le32(dv, o + 4, div(r.point, r.quantity)); le32(dv, o + 8, div(r.cash, r.quantity)); le32(dv, o + 12, r.quantity);
  });
}

/** ZlibUtil.Compress: 78 9C + deflate(level 6) + Adler32 BE. */
export function zlibCompress(raw: Uint8Array): Uint8Array {
  return new Uint8Array(deflateSync(raw, { level: 6 }));
}

function buildPacked(): void {
  const list = S.buyable.slice(0, 20000);
  const raw = new Uint8Array(list.length * 210);
  const dv = new DataView(raw.buffer);
  const opt = (o: number, k: number, gold: number, cash: number, code: number) => {
    const b = o + 6 + k * 17;
    le32(dv, b, gold); le32(dv, b + 4, cash); le32(dv, b + 8, 0); le32(dv, b + 12, 0); dv.setUint8(b + 16, code);
  };
  list.forEach((g, i) => {
    const o = i * 210;
    le32(dv, o, g.id); raw[o + 4] = 1; raw[o + 5] = g.visibility === 4 ? 4 : 1;
    opt(o, 0, g.priceGold, g.priceCash, 0);
    raw[o + 22] = g.tag;
    if (S.flashSaleGoodIds.includes(g.id)) {
      const fullGold = g.starGold > 0 ? Math.trunc(g.starGold / 255) : g.priceGold;
      const fullCash = g.starCash > 0 ? Math.trunc(g.starCash / 255) : g.priceCash;
      const promo = g.priceGold > 0 ? g.priceGold : g.priceCash, full = fullGold > 0 ? fullGold : fullCash;
      opt(o, 6, promo, g.priceCash, 0);
      opt(o, 7, full, fullCash, 0);
      raw[o + 22] = g.tag;
    }
  });
  S.packedGoodsIds = new Set(list.map((g) => g.id));
  S.packedGoods = zlibCompress(raw);
  const rows = (chunks: ShopData[], count: number, size: number) => {
    const out = new Uint8Array(count * size);
    for (const c of chunks) {
      const dst = c.offset * size;
      if (dst >= out.length) continue;
      out.set(c.buffer.subarray(0, Math.min(c.buffer.length, out.length - dst)), dst);
    }
    return out;
  };
  S.packedItems = zlibCompress(rows(S.items, Math.min(S.totalItems, 16000), 11));
  S.packedRepairs = zlibCompress(rows(S.itemRepairs, Math.min(S.totalRepairs, 16000), 16));
  S.packedMt1 = zlibCompress(rows(S.mt1, Math.min(S.totalMatching1, 30000), 16));
  S.packedMt2 = zlibCompress(rows(S.mt2, Math.min(S.totalMatching2, 30000), 16));
  let h = 2166136261;
  for (const buf of [S.packedItems, S.packedGoods, S.packedMt1]) for (const b of buf) h = Math.imul(h ^ b, 16777619) >>> 0;
  S.catalogVersion = (h | 0) === 0 ? 1 : h | 0;
}

async function loadBattleBoxes(): Promise<void> {
  const seen = new Set<number>();
  const boxes: { couponId: number; requireTags: number }[] = [];
  for (const x of (await pool.query(`SELECT coupon_id, require_tags FROM system_battle_boxes ORDER BY coupon_id ASC`)).rows) {
    const id = Number(x.coupon_id);
    if (seen.has(id)) continue;
    seen.add(id);
    boxes.push({ couponId: id, requireTags: Number(x.require_tags) });
  }
  S.totalBoxes = boxes.length;
  S.battleBoxes = [];
  for (let p = 0; p * 100 < boxes.length; p++) {
    const part = boxes.slice(p * 100, (p + 1) * 100);
    const buf = new Uint8Array(part.length * 11); // BattleBoxXML.WriteBattleBoxData: D id, H tags, H 0, H 0, C 0
    const dv = new DataView(buf.buffer);
    part.forEach((b, i) => { le32(dv, i * 11, b.couponId); dv.setUint16(i * 11 + 4, b.requireTags & 0xffff, true); });
    S.battleBoxes.push({ buffer: buf, itemsCount: part.length, offset: p * 100 });
  }
}

/** ShopManager.Load(Type). */
async function load(type: number): Promise<void> {
  await loadRepairableItems(type);
  await loadShopItems(type);
  await loadShopEffects(type);
  await loadShopSets();
  await loadLimitedItems();
  await loadFlashSale();
  if (type !== 1) return;
  try {
    buildMatching();
    buildUniqueAndRepairs();
    buildPacked();
  } catch (e) { log(`Load(1) build: ${(e as Error).message}`); }
}

export async function loadShop(): Promise<void> {
  await load(1);
  await load(2);
  await loadBattleBoxes();
  log(`${S.all.length} goods, ${S.buyable.length} buyable, ${S.unique.size} unique, packed goods ${S.packedGoodsIds.size}, items ${S.totalItems}, mt1 ${S.totalMatching1}, mt2 ${S.totalMatching2}, repairs ${S.totalRepairs}, catalog ${S.catalogVersion}`);
}

export const getGood = (goodId: number) => (goodId === 0 ? null : S.all.find((g) => g.id === goodId) ?? null);
export const getGoodByItemId = (itemId: number) => (itemId === 0 ? null : S.all.find((g) => g.item.id === itemId) ?? null);
export const isPackedGood = (goodId: number) => goodId !== 0 && S.packedGoodsIds.has(goodId);
export const isRepairable = isRepairableItem;
export { getIdStatics };
