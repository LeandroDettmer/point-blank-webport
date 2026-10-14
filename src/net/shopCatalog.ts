// Shop catalog sent after the first 1029 of a session (SP/ShopCatalog121Sender.SendFullCatalog):
// 1039 ITEMLIST, 1037 PACKED_GOODSLIST, 1075 REPAIRLIST, 7426 BATTLEBOX, 1120 FLASH_SALE,
// 1042 PACKED_MATCHINGLIST, 1041 MATCHINGLIST (version), then 1106 TAG_INFO, 1103 (only with limited
// items) and 1030 SAILLIST. Later 1029s of the same session only get 1106/(1103)/1030 (player.LoadedShop).
//
// Packed lists: each chunk is `D total, D offset, D len, B[len]` (≤ 8000 bytes). The concatenation is
// **zlib (RFC 1950)**: Plugin.Core/Utility/ZlibUtil.Compress writes 78 9C + raw deflate + Adler-32 BE,
// so it inflates with DecompressionStream (which is the zlib format), not "deflate-raw".
import type { PacketReader } from "./packet.ts";
import type { GoodsOption, ShopGood, ShopItem, ShopMatching, ShopRepair } from "../lobby/types.ts";

export const ShopOp = {
  ITEMLIST_ACK: 1039,
  PACKED_GOODSLIST_ACK: 1037,
  REPAIRLIST_ACK: 1075,
  PACKED_MATCHINGLIST_ACK: 1042,
  MATCHINGLIST_ACK: 1041,
  SAILLIST_ACK: 1030,
} as const;

/** Plugin.Core/Managers/ShopManager.cs record sizes. */
export const ITEM_RECORD_SIZE = 11;
export const GOODS_RECORD_SIZE = 210;
export const REPAIR_RECORD_SIZE = 16;
export const MATCHING_RECORD_SIZE = 16;
const GOODS_OPTIONS = 12; // (210 - 6) / 17

export interface PackedChunk {
  total: number;
  offset: number;
  data: Uint8Array;
}

export function parsePackedChunk(r: PacketReader): PackedChunk {
  const total = r.readD();
  const offset = r.readD();
  const len = r.readD();
  return { total, offset, data: r.readB(len) };
}

/** Reassembles chunks of one packed list; `complete` once every byte of `total` arrived. */
export class PackedAssembler {
  private buf: Uint8Array | null = null;
  private got = 0;

  push(c: PackedChunk): boolean {
    if (!this.buf || this.buf.length !== c.total) {
      this.buf = new Uint8Array(c.total);
      this.got = 0;
    }
    if (c.offset + c.data.length > c.total) throw new RangeError(`packed chunk ${c.offset}+${c.data.length} > ${c.total}`);
    this.buf.set(c.data, c.offset);
    this.got += c.data.length;
    return this.complete;
  }

  get complete(): boolean {
    return !!this.buf && this.got >= this.buf.length;
  }

  bytes(): Uint8Array {
    if (!this.buf || !this.complete) throw new Error("packed list incomplete");
    return this.buf;
  }
}

/** zlib stream -> raw records (browser and Node ≥ 18 both have DecompressionStream). */
export async function inflateZlib(z: Uint8Array): Promise<Uint8Array> {
  if (z.length < 2 || z[0] !== 0x78) throw new Error(`not a zlib stream (first byte 0x${(z[0] ?? 0).toString(16)})`);
  const ds = new DecompressionStream("deflate");
  const out = new Response(new Blob([z.slice() as Uint8Array<ArrayBuffer>]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(await out);
}

function records<T>(raw: Uint8Array, size: number, read: (v: DataView, o: number) => T): T[] {
  if (raw.length % size !== 0) throw new Error(`packed list length ${raw.length} not a multiple of ${size}`);
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out: T[] = [];
  for (let o = 0; o < raw.length; o += size) out.push(read(v, o));
  return out;
}

/** ShopManager.WriteItemDataShort: D itemId, C authType, C buyType2, C buyType3, C title, C titleFlag, H 0. */
export function decodeItems(raw: Uint8Array): ShopItem[] {
  return records(raw, ITEM_RECORD_SIZE, (v, o) => ({
    itemId: v.getUint32(o, true), authType: v.getUint8(o + 4), buyType2: v.getUint8(o + 5),
    buyType3: v.getUint8(o + 6), title: v.getUint8(o + 7), titleFlag: v.getUint8(o + 8),
  }));
}

/**
 * ShopManager.WriteGoodsRecord210: D goodId, C 1, C visibility, 12 options × {D gold, D cash, D0, D0, C code}.
 * Option 0 is the price; options 6/7 are the flash-sale promo/full prices. itemId/count are filled from
 * the 1042 matching list when given (ShopCatalog.decode does it).
 */
export function decodeGoods(raw: Uint8Array, matching: ShopMatching[] = []): ShopGood[] {
  const byGood = new Map(matching.map((m) => [m.goodId, m]));
  return records(raw, GOODS_RECORD_SIZE, (v, o) => {
    const goodId = v.getUint32(o, true);
    const options: GoodsOption[] = [];
    for (let i = 0; i < GOODS_OPTIONS; i++) {
      const p = o + 6 + i * 17;
      options.push({ gold: v.getInt32(p, true), cash: v.getInt32(p + 4, true), code: v.getUint8(p + 16) });
    }
    return {
      goodId, itemId: byGood.get(goodId)?.itemId ?? 0, count: byGood.get(goodId)?.count ?? 0, visibility: v.getUint8(o + 5),
      priceGold: options[0].gold, priceCash: options[0].cash, tag: options[0].code, options,
    };
  });
}

/** ShopManager.WriteRepairItemData: D itemId, D point/quantity, D cash/quantity, D quantity. */
export function decodeRepairs(raw: Uint8Array): ShopRepair[] {
  return records(raw, REPAIR_RECORD_SIZE, (v, o) => ({
    itemId: v.getUint32(o, true), pointPerUnit: v.getInt32(o + 4, true), cashPerUnit: v.getInt32(o + 8, true), quantity: v.getInt32(o + 12, true),
  }));
}

/** ShopManager.WriteMatchingItemData: D goodId, D itemId, D count, D 0. */
export function decodeMatching(raw: Uint8Array): ShopMatching[] {
  return records(raw, MATCHING_RECORD_SIZE, (v, o) => ({
    goodId: v.getUint32(o, true), itemId: v.getUint32(o + 4, true), count: v.getUint32(o + 8, true),
  }));
}

/** 1030 PROTOCOL_SHOP_GET_SAILLIST_ACK: `C changed, D yyMMddHHmm`. changed = 0 when the 1029 hash equals Shop.dat. */
export function parseSailList(r: PacketReader): { changed: boolean; time: number } {
  return { changed: r.readC() !== 0, time: r.readD() };
}

/** 1041 PROTOCOL_AUTH_SHOP_MATCHINGLIST_ACK (S->C): `D CatalogVersion` (FNV-1a over the packed buffers). */
export function parseMatchingListVersion(r: PacketReader): number {
  return r.readD();
}

export interface ShopCatalogData {
  items: ShopItem[];
  goods: ShopGood[];
  repairs: ShopRepair[];
  matching: ShopMatching[];
  version: number | null;
  sailChanged: boolean | null;
}

/**
 * Feed every S->C packet with `onPacket`; `ready` resolves at 1030 (the last packet of the sequence).
 * Lists that never arrived stay empty (e.g. a second 1029 in the same session).
 */
export class ShopCatalog {
  private asm = new Map<number, PackedAssembler>();
  private raw = new Map<number, Uint8Array>();
  version: number | null = null;
  sailChanged: boolean | null = null;
  private resolveReady!: () => void;
  readonly ready = new Promise<void>((r) => (this.resolveReady = r));

  onPacket(op: number, r: PacketReader): void {
    switch (op) {
      case ShopOp.ITEMLIST_ACK:
      case ShopOp.PACKED_GOODSLIST_ACK:
      case ShopOp.REPAIRLIST_ACK:
      case ShopOp.PACKED_MATCHINGLIST_ACK: {
        let a = this.asm.get(op);
        if (!a) this.asm.set(op, (a = new PackedAssembler()));
        if (a.push(parsePackedChunk(r))) this.raw.set(op, a.bytes());
        break;
      }
      case ShopOp.MATCHINGLIST_ACK:
        this.version = parseMatchingListVersion(r);
        break;
      case ShopOp.SAILLIST_ACK:
        this.sailChanged = parseSailList(r).changed;
        this.resolveReady();
        break;
    }
  }

  /** Packed (still compressed) bytes per opcode, e.g. for an IndexedDB cache keyed by `version`. */
  packed(op: number): Uint8Array | undefined {
    return this.raw.get(op);
  }

  async decode(): Promise<ShopCatalogData> {
    const get = async <T>(op: number, dec: (raw: Uint8Array) => T[]): Promise<T[]> => {
      const z = this.raw.get(op);
      return z ? dec(await inflateZlib(z)) : [];
    };
    const matching = await get(ShopOp.PACKED_MATCHINGLIST_ACK, decodeMatching);
    return {
      items: await get(ShopOp.ITEMLIST_ACK, decodeItems),
      goods: await get(ShopOp.PACKED_GOODSLIST_ACK, (raw) => decodeGoods(raw, matching)),
      repairs: await get(ShopOp.REPAIRLIST_ACK, decodeRepairs),
      matching,
      version: this.version,
      sailChanged: this.sailChanged,
    };
  }
}
