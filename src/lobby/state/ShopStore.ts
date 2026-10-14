// Shop catalog state, Wraps src/net/shopCatalog.ts: decoded
// 1039/1037/1075/1042 lists -> offers grouped by itemId, one option per good (duration/quantity variant).
// Prices are what the server sent in the 1037 record (option 0): no gold price is made up for cash-only goods.
// Cache: the server sends the catalog only after the FIRST 1029 of a session, so
// the decoded data is kept per connection; packed lists are also persisted (IndexedDB, keyed by the 1041
// CatalogVersion) as a fallback for a session whose first 1029 happened before this store listened.
import type { ShopCatalogData } from "../../net/shopCatalog.ts";
import { ShopCatalog, ShopOp } from "../../net/shopCatalog.ts";
import type { PbConnection } from "../../net/connection.ts";
import { PacketReader } from "../../net/packet.ts";
import { buildShopGetSailList } from "../../net/metaGame.ts";
import type { ShopGood, ShopItem } from "../types.ts";
import { Observable } from "./observable.ts";
import { matchesFilter, type ItemFilter, type ItemTab } from "./itemInfo.ts";

export interface ShopOption {
  goodId: number;
  /** the item this good grants (the offer's itemId, except for coupons: 17 DD GGG with the period's days) */
  itemId: number;
  /** 1042 count: seconds (authType 2 = period) or quantity (authType 1) */
  count: number;
  priceGold: number;
  priceCash: number;
  /** 1037 visibility: 1 normal, 4 limited sale (item_visible = false) */
  visibility: number;
  tag: number;
}
export interface ShopOffer {
  itemId: number;
  /** 1039 row (authType = system_shop.item_consume: 1 quantity, 2 period) */
  item: ShopItem | null;
  options: ShopOption[];
}

/** A price of 1 is Shop.dat's mark for goods that are not sold (event / reward periods: "2 horas" for 1 gold, 736
 * variants of the 2017 catalog) [INFERIDO]: treated as no price in that currency. */
export const NOT_FOR_SALE_PRICE = 1;
const salePrice = (v: number): number => (v > NOT_FOR_SALE_PRICE ? v : 0);

/** Coupon goods (class 17) carry their days in the item id (17 DD GGG: 1701026 = Quick Change Weapon 1 day, 1707026 = 7 days),
 * so the server sends one item per period. Days of such an id, 0 when it is not a coupon with days. */
const couponDays = (itemId: number): number => (Math.floor(itemId / 100000) === 17 && itemId % 100000 >= 1000 ? Math.floor(itemId / 1000) % 100 : 0);

/** Groups goods by itemId (coupons by their base id 17 00 GGG: one offer with a 1/3/7/30-day option each). Goods without a 1042 row (itemId 0) or without any real price are dropped. */
export function buildOffers(data: Pick<ShopCatalogData, "items" | "goods">): ShopOffer[] {
  const items = new Map(data.items.map((i) => [i.itemId, i]));
  const by = new Map<number, ShopOffer>();
  for (const raw of data.goods) {
    const g = { ...raw, priceGold: salePrice(raw.priceGold), priceCash: salePrice(raw.priceCash) };
    if (!g.itemId || (g.priceGold <= 0 && g.priceCash <= 0)) continue;
    const days = couponDays(g.itemId), key = g.itemId - days * 1000;
    let o = by.get(key);
    if (!o) {
      const it = items.get(g.itemId) ?? null;
      by.set(key, (o = { itemId: key, item: days && it ? { ...it, authType: 2 } : it, options: [] }));
    }
    o.options.push(days ? { ...optionOf(g), count: days * 86400 } : optionOf(g));
  }
  for (const o of by.values()) o.options.sort((a, b) => a.count - b.count || a.goodId - b.goodId);
  return [...by.values()].sort((a, b) => a.itemId - b.itemId);
}
const optionOf = (g: ShopGood): ShopOption => ({ goodId: g.goodId, itemId: g.itemId, count: g.count, priceGold: g.priceGold, priceCash: g.priceCash, visibility: g.visibility, tag: g.tag });

export type Currency = "gold" | "cash";
export const priceIn = (o: ShopOption, c: Currency): number => (c === "gold" ? o.priceGold : o.priceCash);

export function filterOffers(offers: ShopOffer[], tab: ItemTab, filter: ItemFilter, search = "", nameOf?: (id: number) => string): ShopOffer[] {
  const q = search.trim().toLowerCase();
  return offers.filter((o) => matchesFilter(o.itemId, tab, filter) && (!q || (nameOf?.(o.itemId) ?? "").toLowerCase().includes(q)));
}

// ---- cache

export interface PackedLists { version: number | null; lists: Record<number, Uint8Array> }
export interface CatalogCache {
  get(): Promise<PackedLists | null>;
  put(p: PackedLists): Promise<void>;
}
export class MemoryCatalogCache implements CatalogCache {
  private v: PackedLists | null = null;
  async get() { return this.v; }
  async put(p: PackedLists) { this.v = p; }
}
/** IndexedDB, one record ("last"); every access in try/catch (private windows, blocked storage). */
export class IdbCatalogCache implements CatalogCache {
  private db(): Promise<IDBDatabase | null> {
    return new Promise((res) => {
      try {
        const rq = indexedDB.open("pb-lobby", 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore("shop");
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => res(null);
      } catch { res(null); }
    });
  }
  async get(): Promise<PackedLists | null> {
    const db = await this.db();
    if (!db) return null;
    return new Promise((res) => {
      try {
        const rq = db.transaction("shop").objectStore("shop").get("last");
        rq.onsuccess = () => res((rq.result as PackedLists) ?? null);
        rq.onerror = () => res(null);
      } catch { res(null); }
    });
  }
  async put(p: PackedLists): Promise<void> {
    const db = await this.db();
    if (!db) return;
    try { db.transaction("shop", "readwrite").objectStore("shop").put(p, "last"); } catch { /* storage full/blocked */ }
  }
}

const PACKED_OPS = [ShopOp.ITEMLIST_ACK, ShopOp.PACKED_GOODSLIST_ACK, ShopOp.REPAIRLIST_ACK, ShopOp.PACKED_MATCHINGLIST_ACK];

/** Rebuilds a ShopCatalog from persisted packed lists (same decode path as the live one). */
export async function decodePacked(p: PackedLists): Promise<ShopCatalogData> {
  const cat = new ShopCatalog();
  for (const op of PACKED_OPS) {
    const z = p.lists[op];
    if (!z) continue;
    const w = new Uint8Array(12 + z.length);
    const v = new DataView(w.buffer);
    v.setUint32(0, z.length, true); v.setUint32(4, 0, true); v.setUint32(8, z.length, true);
    w.set(z, 12);
    cat.onPacket(op, new PacketReader(w));
  }
  const d = await cat.decode();
  return { ...d, version: p.version };
}

export type ShopKey = "catalog" | "status";
export type ShopStatus = "idle" | "loading" | "ready" | "empty" | "error";

const sessionData = new WeakMap<PbConnection, ShopCatalogData>();

export class ShopStore extends Observable<ShopKey> {
  data: ShopCatalogData | null = null;
  offers: ShopOffer[] = [];
  status: ShopStatus = "idle";
  error = "";
  /** true when the lists came from the persisted cache and not from this session */
  fromCache = false;
  private readonly cache: CatalogCache;

  constructor(cache: CatalogCache = new MemoryCatalogCache()) {
    super();
    this.cache = cache;
  }

  setData(d: ShopCatalogData, fromCache = false): void {
    this.data = d;
    this.offers = buildOffers(d);
    this.fromCache = fromCache;
    this.status = this.offers.length ? "ready" : "empty";
    this.emit(["catalog", "status"]);
  }

  offer(itemId: number): ShopOffer | undefined { return this.offers.find((o) => o.itemId === itemId); }

  /**
   * 1029 -> 1039/1037/1075/7426/1120/1042/1041/1106/(1103)/1030. Reuses this session's data if it already
   * arrived. `shopDatHash` = MD5 of the client's Shop.dat (unknown to the web client: "" -> 1030 changed=1).
   */
  async load(conn: PbConnection, timeoutMs = 10000, shopDatHash = ""): Promise<void> {
    const have = sessionData.get(conn);
    if (have) { this.setData(have); return; }
    this.status = "loading";
    this.emit(["status"]);
    const cat = new ShopCatalog();
    const off = conn.on((op, r) => cat.onPacket(op, r));
    try {
      conn.send(1029, buildShopGetSailList(shopDatHash));
      await Promise.race([cat.ready, new Promise((_, rej) => setTimeout(() => rej(new Error("1030 SAILLIST: sem resposta")), timeoutMs))]);
      const d = await cat.decode();
      if (d.goods.length) {
        sessionData.set(conn, d);
        const lists: Record<number, Uint8Array> = {};
        for (const op of PACKED_OPS) { const z = cat.packed(op); if (z) lists[op] = z; }
        void this.cache.put({ version: d.version, lists }).catch(() => {});
        this.setData(d);
        return;
      }
      // this session's first 1029 was answered before we listened: fall back to the persisted lists
      const p = await this.cache.get().catch(() => null);
      if (p) { const cd = await decodePacked(p); sessionData.set(conn, cd); this.setData(cd, true); return; }
      this.setData(d);
    } catch (e) {
      this.status = "error";
      this.error = e instanceof Error ? e.message : String(e);
      this.emit(["status"]);
    } finally {
      off();
    }
  }
}
