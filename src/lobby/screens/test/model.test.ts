// screen model: the pure layout the page and the PNG composer share, fed with real vectors.
//   node --test "src/lobby/screens/test/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PacketReader } from "../../../net/packet.ts";
import { fromHex } from "../../../net/bytes.ts";
import { parseInvenInfo, parseUserInfo } from "../../../net/metaAuth.ts";
import { parseChangeInventory, parseCharaInfo, parseMyInfoBasic } from "../../../net/metaGame.ts";
import { ShopCatalog } from "../../../net/shopCatalog.ts";
import { PlayerStore } from "../../state/PlayerStore.ts";
import { ShopStore } from "../../state/ShopStore.ts";
import { itemName, setClientItemNames, setItemNameTable } from "../../state/itemNames.ts";
import { PAGE, defaultMenuUi, inventoryData, shopData, shopOffers } from "../model.ts";

const V = JSON.parse(readFileSync(new URL("../../../net/test/meta-vectors.json", import.meta.url), "utf8")) as { vectors: { conn: string; op: number; hex: string; step: string }[] };
const rd = (op: number, step: string, conn?: string) => new PacketReader(fromHex(V.vectors.find((v) => v.op === op && v.step === step && (!conn || v.conn === conn))!.hex), 2);
function player(): PlayerStore {
  const p = new PlayerStore();
  p.dispatch({ type: "authMeta", userInfo: parseUserInfo(rd(2317, "login")), inventory: parseInvenInfo(rd(2319, "login")), wallet: null });
  p.dispatch({ type: "enter", pushes: { basic: parseMyInfoBasic(rd(2371, "login")), charaInfo: parseCharaInfo(rd(2453, "login", "game-A")), loadout: parseChangeInventory(rd(3082, "login")) } });
  return p;
}

test("inventory data: 9 slots max, equipped flags, filters", () => {
  const p = player();
  const ui = { ...defaultMenuUi(), tab: "weapon" as const };
  const d = inventoryData(p, ui);
  assert.ok(d.slots.length <= PAGE && d.slots.length > 0);
  const prim = d.slots.find((s) => s.itemId === p.weaponLoadout().primary)!;
  assert.equal(prim.button, "Equipado");
  const thr = inventoryData(p, { ...ui, filter: "throw" });
  assert.ok(thr.slots.every((s) => Math.floor(s.itemId / 100000) === 4));
});

test("shop data: server prices only, currency tab and options", async () => {
  const cat = new ShopCatalog();
  for (const v of V.vectors.filter((x) => x.step === "catalog")) cat.onPacket(v.op, new PacketReader(fromHex(v.hex), 2));
  const shop = new ShopStore();
  shop.setData(await cat.decode());
  const p = player();
  const ui = { ...defaultMenuUi(), tab: "item" as const, currency: "gold" as const };
  const offer = shopOffers(shop, ui)[0];
  ui.selected = offer.itemId;
  const d = shopData(p, shop, ui);
  // the recorded catalog is cash-only: gold options are "-" and "Comprar" is disabled, no gold price made up
  assert.ok(d.options.every((o) => o.price === "-" && !o.enabled));
  assert.equal(d.actionEnabled, false);
  const dc = shopData(p, shop, { ...ui, currency: "cash" });
  assert.ok(dc.options[0].price.endsWith("Cash") && dc.actionEnabled);
});

test("item names: client PT-BR name first, then server snapshot", () => {
  setItemNameTable({ names: { "103004": ["K-2 srv", "system_shop"] } });
  setClientItemNames({ "103004": { name: "K-2" }, "999": { name: "한글" } });
  assert.deepEqual(itemName(103004), { name: "K-2", source: "client-pt-BR" });
  assert.equal(itemName(999).source, "none", "hangul skipped");
});
