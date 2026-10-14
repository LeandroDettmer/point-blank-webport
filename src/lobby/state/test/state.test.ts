// state: reducers fed with the REAL payloads recorded by ? (src/net/test/meta-vectors.json, Docker server via
// the web front, DB snapshot of the same run).   node --test "src/lobby/state/test/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PacketReader, PacketWriter } from "../../../net/packet.ts";
import { fromHex } from "../../../net/bytes.ts";
import { parseInvenInfo, parseUserInfo } from "../../../net/metaAuth.ts";
import {
  KEEP_CHARA_SLOT, equipRequestFromLoadout, parseChangeInventory, parseCharaInfo, parseGoodsBuy, parseInventoryGetInfo,
  parseMyInfoBasic, parseDeleteItem, parseCreateChara, buildCreateChara,
} from "../../../net/metaGame.ts";
import { ShopCatalog, ShopOp } from "../../../net/shopCatalog.ts";
import { EquipSlot, ItemEquipType, type Loadout } from "../../types.ts";
import { PlayerStore, applyEquipRequest, emptyPlayerState, reducePlayer } from "../PlayerStore.ts";
import { MemoryCatalogCache, ShopStore, buildOffers, decodePacked, filterOffers } from "../ShopStore.ts";
import { LobbyStore } from "../LobbyStore.ts";
import { buildEquipSingle, parseItemAuth } from "../singleEquip.ts";
import { equipSlotOf, itemTerm, matchesFilter, parseYyMMddHHmm, tabOf } from "../itemInfo.ts";
import { MetaSession, buyErrorText } from "../MetaSession.ts";
import { itemName, setItemNameProvider, setItemNameTable } from "../itemNames.ts";

interface Vec { conn: string; op: number; hex: string; step: string }
const V = JSON.parse(readFileSync(new URL("../../../net/test/meta-vectors.json", import.meta.url), "utf8")) as {
  db: { equipments: Record<string, string>; items: Record<string, string>[]; wallet0: { gold: number; cash: number; tags: number };
    bought: { goodId: number; itemId: number; price: number; objectId: number; extraGoodId: number; extraItemId: number; extraPrice: number } };
  vectors: Vec[];
};
const rd = (v: Vec) => new PacketReader(fromHex(v.hex), 2);
const one = (op: number, step: string, conn?: string) => {
  const v = V.vectors.find((x) => x.op === op && x.step === step && (!conn || x.conn === conn));
  assert.ok(v, `vector ${op}/${step}`);
  return v!;
};
const all = (op: number, step: string) => V.vectors.filter((x) => x.op === op && x.step === step);

function loggedIn(): PlayerStore {
  const p = new PlayerStore();
  p.dispatch({ type: "authMeta", userInfo: parseUserInfo(rd(one(2317, "login"))), inventory: parseInvenInfo(rd(one(2319, "login"))), wallet: null,
    charaInfo: parseCharaInfo(rd(one(2453, "login", "auth-A"))) });
  p.dispatch({ type: "enter", pushes: {
    basic: parseMyInfoBasic(rd(one(2371, "login"))),
    charaInfo: parseCharaInfo(rd(one(2453, "login", "game-A"))),
    loadout: parseChangeInventory(rd(one(3082, "login"))),
  } });
  return p;
}

test("2319 -> inventory, 2371 -> profile/wallet", () => {
  const p = loggedIn();
  const page = parseInvenInfo(rd(one(2319, "login")));
  assert.equal(p.state.inventory.size, page.items.length);
  assert.ok(page.items.length >= 16, "16 in-memory basics at least");
  assert.equal(p.state.profile?.nickname.length ? true : false, true);
  assert.deepEqual({ gold: p.state.wallet!.gold, cash: p.state.wallet!.cash }, { gold: V.db.wallet0.gold, cash: V.db.wallet0.cash });
});

test("3334 deltas (buy) upsert the bought items; 1047 sets the wallet", () => {
  const p = loggedIn();
  const before = p.state.inventory.size;
  for (const v of all(3334, "buy")) p.dispatch({ type: "inventoryDelta", delta: parseInventoryGetInfo(rd(v)) });
  const b = V.db.bought;
  const bought = [...p.state.inventory.values()].find((i) => i.itemId === b.itemId);
  assert.ok(bought, "bought itemId present");
  assert.equal(bought!.equip, ItemEquipType.Durable);
  assert.ok(p.state.inventory.size > before);
  // the same delta twice (listener + buyGoods) is idempotent
  const size = p.state.inventory.size;
  for (const v of all(3334, "buy")) p.dispatch({ type: "inventoryDelta", delta: parseInventoryGetInfo(rd(v)) });
  assert.equal(p.state.inventory.size, size);
  const res = parseGoodsBuy(rd(one(1047, "buy")));
  assert.ok(res.ok);
  p.dispatch({ type: "buy", result: res });
  assert.equal(p.state.wallet!.cash, V.db.wallet0.cash - b.price - b.extraPrice);
  assert.equal(p.state.wallet!.gold, V.db.wallet0.gold);
  // failed buy: still carries the balance, no inventory change
  const fail = parseGoodsBuy(rd(one(1047, "buy-fail")));
  assert.equal(fail.ok, false);
  const inv = p.state.inventory;
  p.dispatch({ type: "buy", result: fail });
  assert.equal(p.state.inventory, inv);
  assert.match(buyErrorText(fail.code), /Falha|insuficiente|Não é possível/);
});

test("1059 removes the item", () => {
  const p = loggedIn();
  for (const v of all(3334, "buy")) p.dispatch({ type: "inventoryDelta", delta: parseInventoryGetInfo(rd(v)) });
  const d = parseDeleteItem(rd(one(1059, "delete")));
  assert.ok(d.ok);
  assert.ok(p.state.inventory.has(d.objectId));
  p.dispatch({ type: "itemDeleted", objectId: d.objectId });
  assert.equal(p.state.inventory.has(d.objectId), false);
});

test("3082 loadout -> weaponLoadout / teamCharas / equipped flags (DB player_equipments of the relog)", () => {
  const p = loggedIn();
  p.dispatch({ type: "loadout", loadout: parseChangeInventory(rd(one(3082, "relog"))) });
  const e = V.db.equipments;
  const w = p.weaponLoadout();
  assert.equal(w.primary, Number(e.weapon_primary));
  assert.equal(w.secondary, Number(e.weapon_secondary));
  assert.equal(w.melee, Number(e.weapon_melee));
  assert.equal(w.grenade, Number(e.weapon_explosive));
  assert.equal(w.special, Number(e.weapon_special));
  const t = p.teamCharas();
  assert.equal(t.red, Number(e.chara_red_side));
  assert.equal(p.state.loadoutSource, "3082");
  const eq = p.equippedObjectIds();
  const prim = [...p.state.inventory.values()].find((i) => i.itemId === w.primary);
  assert.ok(prim && eq.has(prim.objectId), "primary flagged Equipado");
});

test("6150 applies the 6149 like the server: weapons only if owned, chara only by unique slot", () => {
  const p = loggedIn();
  const lo = p.state.loadout!;
  const owned = [...p.state.inventory.values()].find((i) => equipSlotOf(i.itemId) === EquipSlot.Primary && i.itemId !== lo.equip[0].itemId)!;
  assert.ok(owned, "a second primary in the inventory");
  const q = equipRequestFromLoadout(lo, { [EquipSlot.Primary]: { itemId: owned.itemId, objectId: 0 }, [EquipSlot.Secondary]: { itemId: 299999, objectId: 0 } }, p.state.charaInfo!);
  // error != 0 -> nothing changes
  p.dispatch({ type: "equipAck", request: q, error: 0x80000000 });
  assert.equal(p.state.loadout, lo);
  p.dispatch({ type: "equipAck", request: q, error: 0 });
  assert.equal(p.weaponLoadout().primary, owned.itemId);
  assert.equal(p.weaponLoadout().secondary, lo.equip[1].itemId, "not-owned secondary ignored");
  assert.equal(p.state.loadoutSource, "6150");
  // KEEP_CHARA_SLOT never moves a side
  const s2 = applyEquipRequest(p.state, { ...q, charaSlots: [KEEP_CHARA_SLOT, KEEP_CHARA_SLOT] })!;
  assert.deepEqual(s2.charaSlots, p.state.loadout!.charaSlots);
});

test("MetaSession.charaRequest refuses duplicated slots and keeps the other side", () => {
  const s = new MetaSession(loggedIn());
  const ci = s.player.state.charaInfo!;
  const counts = new Map<number, number>();
  for (const c of ci.charas) counts.set(c.slot, (counts.get(c.slot) ?? 0) + 1);
  const unique = ci.charas.find((c) => counts.get(c.slot) === 1);
  const dup = ci.charas.find((c) => (counts.get(c.slot) ?? 0) > 1);
  if (unique) {
    const q = s.charaRequest(unique.itemId, 0);
    assert.equal(q.charaSlots[0], unique.slot);
    assert.ok(q.charaSlots[1] === KEEP_CHARA_SLOT || counts.get(q.charaSlots[1]) === 1);
    assert.equal(q.equip![EquipSlot.Chara].itemId, unique.itemId);
  }
  if (dup) assert.throws(() => s.charaRequest(dup.itemId, 1), /Personagem errado/);
  assert.ok(unique || dup);
});

test("1051 / 1050 layouts (server Write()/Read())", () => {
  const w = new PacketWriter().writeD(1).writeD(2609271530).writeD(228).writeD(1701001).writeC(2).writeD(2610041530);
  const a = parseItemAuth(new PacketReader(w.toBytes()));
  assert.deepEqual(a.item, { objectId: 228, itemId: 1701001, equip: 2, count: 2610041530 });
  assert.equal(parseItemAuth(new PacketReader(new PacketWriter().writeD(0x80000000).toBytes())).ok, false);
  const b = new PacketReader(buildEquipSingle(0x4001974e).toBytes());
  assert.equal(b.readD(), 0x4001974e);
  assert.equal(b.readC(), 0);
  // Durable -> Temporary through itemAuth
  const p = loggedIn();
  const it = [...p.state.inventory.values()][0];
  p.dispatch({ type: "itemAuth", item: { ...it, equip: ItemEquipType.Temporary, count: 2610041530 } });
  assert.equal(p.state.inventory.get(it.objectId)!.equip, ItemEquipType.Temporary);
});

test("catalog 1039/1037/1042 -> offers (real vectors), cache round trip", async () => {
  const cat = new ShopCatalog();
  for (const v of V.vectors.filter((x) => x.step === "catalog")) cat.onPacket(v.op, rd(v));
  const d = await cat.decode();
  const offers = buildOffers(d);
  assert.ok(offers.length > 0);
  const b = V.db.bought;
  // coupon goods (class 17, 1701001 = 1 day) are grouped under their base id 1700001, one option per period (b81a013c)
  const o = offers.find((x) => x.options.some((p) => p.goodId === b.goodId));
  assert.ok(o, "bought item has an offer");
  assert.equal(o!.itemId, b.itemId - 1000);
  const opt = o!.options.find((x) => x.goodId === b.goodId)!;
  assert.equal(opt.itemId, b.itemId);
  assert.equal(opt.count, 86400);
  assert.equal(opt.priceCash, b.price);
  for (const of of offers) for (const op of of.options) assert.ok(op.priceGold > 0 || op.priceCash > 0);
  assert.deepEqual(filterOffers(offers, "weapon", "all").every((x) => tabOf(x.itemId) === "weapon"), true);
  // persisted packed lists decode to the same offers
  const lists: Record<number, Uint8Array> = {};
  for (const op of [ShopOp.ITEMLIST_ACK, ShopOp.PACKED_GOODSLIST_ACK, ShopOp.REPAIRLIST_ACK, ShopOp.PACKED_MATCHINGLIST_ACK]) { const z = cat.packed(op); if (z) lists[op] = z; }
  const cache = new MemoryCatalogCache();
  await cache.put({ version: d.version, lists });
  const d2 = await decodePacked((await cache.get())!);
  assert.deepEqual(buildOffers(d2), offers);
  const store = new ShopStore(cache);
  store.setData(d2, true);
  assert.equal(store.status, "ready");
  assert.ok(store.fromCache);
});

test("lobby pages merge, page 0 resets; quick start candidates", () => {
  const l = new LobbyStore();
  const room = (id: number, state: number, players: number) => ({ roomId: id, name: `r${id}`, mapId: 4, rule: 0, stage: 1, roomType: 4, state, players, slots: 16, ping: 3, weaponsFlag: 0, flag: 0, leaderAddr: "" });
  l.applyPage({ totalRooms: 3, roomPage: 0, rooms: [room(0, 1, 2), room(1, 7, 8)], totalPlayers: 1, playerPage: 0, players: [{ sessionId: 9, clanLogo: 0, clanName: "", rank: 5, nickColor: 0, nickname: "a", nation: 0 }] });
  l.applyPage({ totalRooms: 3, roomPage: 1, rooms: [room(2, 1, 5)], totalPlayers: 1, playerPage: 1, players: [] });
  assert.equal(l.roomList().length, 3);
  assert.deepEqual(l.quickStartCandidates().map((r) => r.roomId), [2, 0]);
  l.applyPage({ totalRooms: 1, roomPage: 0, rooms: [room(2, 1, 5)], totalPlayers: 0, playerPage: 0, players: [] });
  assert.equal(l.roomList().length, 1);
  assert.equal(l.playerList().length, 0);
});

test("item info: classes, filters, terms", () => {
  assert.equal(equipSlotOf(103004), EquipSlot.Primary);
  assert.equal(equipSlotOf(601666), EquipSlot.Chara);
  assert.equal(equipSlotOf(2700001), EquipSlot.Beret);
  assert.equal(equipSlotOf(1701001), null);
  assert.ok(matchesFilter(407056, "weapon", "throw"));
  assert.ok(!matchesFilter(407056, "weapon", "primary"));
  assert.ok(matchesFilter(2700001, "chara", "beret"));
  const now = parseYyMMddHHmm(2609271200);
  assert.deepEqual(itemTerm({ objectId: 1, itemId: 103004, equip: 2, count: 2609281200 }, now), { kind: "remaining", value: 86400 });
  assert.deepEqual(itemTerm({ objectId: 1, itemId: 103004, equip: 1, count: 604800 }, now), { kind: "unused", value: 604800 });
  assert.equal(itemTerm({ objectId: 1, itemId: 103004, equip: 3, count: 0 }, now).kind, "permanent");
});

test("item names: server snapshot, then hook", () => {
  setItemNameTable(JSON.parse(readFileSync(new URL("../data/itemNames.json", import.meta.url), "utf8")));
  assert.equal(itemName(103004).source, "system_shop");
  assert.equal(itemName(99999999).name, "#99999999");
  setItemNameProvider((id) => (id === 103004 ? "X" : null));
  assert.deepEqual(itemName(103004), { name: "X", source: "provider" });
  setItemNameProvider(null);
});

test("store subscribe fires per key", () => {
  const p = new PlayerStore();
  const seen: string[] = [];
  p.subscribe("wallet", (k) => seen.push(k.join(",")));
  p.dispatch({ type: "wallet", wallet: { gold: 1, cash: 2, tags: 0 } });
  p.dispatch({ type: "itemDeleted", objectId: 5 }); // no-op -> no emit
  assert.deepEqual(seen, ["wallet"]);
  assert.equal(reducePlayer(emptyPlayerState(), { type: "loadout", loadout: { equip: [] } as unknown as Loadout }).changed[0], "loadout");
});

test("2395 push (after a 1052 nick colour) updates the own nick colour", () => {
  const data = { tag: 0, nickColor: 4, fakeRank: 0, fakeNick: "", crosshairColor: 0, muzzleColor: 0, nickBorderColor: 0 };
  const r = reducePlayer(emptyPlayerState(), { type: "invItem", data });
  assert.equal(r.state.invItem?.nickColor, 4);
  assert.deepEqual(r.changed, ["profile"]);
});

test("6146 (6145 answer or 1045 push) adds the character's slot; 6145 builder matches CREATE_CHARA_REQ.Read", () => {
  // server PROTOCOL_CHAR_CREATE_CHARA_ACK.Write: H0, D err, C0, 18 pairs, D cash, D gold, C kind, C 20, C slot, C 1 (+ 2 framing zeros)
  const w = new PacketWriter().writeH(0).writeD(0).writeC(0);
  for (let i = 0; i < 18; i++) w.writeD(i === EquipSlot.Chara ? 601124 : 0).writeD(i === EquipSlot.Chara ? 256 : 0);
  w.writeD(80000).writeD(99000).writeC(3).writeC(20).writeC(4).writeC(1).writeH(0);
  const r = new PacketReader(w.toBytes());
  const ack = parseCreateChara(r);
  assert.deepEqual({ error: ack.error, kind: ack.kind, slot: ack.slot, itemId: ack.itemId, objectId: ack.objectId, cash: ack.cash, gold: ack.gold },
    { error: 0, kind: 3, slot: 4, itemId: 601124, objectId: 256, cash: 80000, gold: 99000 });
  assert.equal(r.remaining, 3); // C 1 + framing
  const s0 = { ...emptyPlayerState(), charaInfo: { charas: [{ slot: 0, itemId: 601005, objectId: 1 }], equip: [] } };
  const s1 = reducePlayer(s0, { type: "charaCreated", ack }).state;
  assert.deepEqual(s1.charaInfo?.charas.map((c) => c.slot), [0, 4]);
  assert.equal(reducePlayer(s1, { type: "charaCreated", ack }).state.charaInfo, s1.charaInfo); // same slot+id once
  assert.equal(parseCreateChara(new PacketReader(new PacketWriter().writeH(0).writeD(0x80001018).toBytes())).slot, -1);
  // G/PROTOCOL_CHAR_CREATE_CHARA_REQ.Read: C, C len, U(len*2), C, D goodId, C buyType, C
  const b = new PacketReader(buildCreateChara(60112412, 2, "Rica_Zombie").toBytes());
  b.readC(); const n = b.readC(); b.skip(n * 2); b.readC();
  assert.deepEqual([n, b.readD(), b.readC(), b.readC(), b.remaining], [11, 60112412, 2, 0, 0]);
});
