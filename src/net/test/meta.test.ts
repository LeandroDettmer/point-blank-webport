// meta protocol: parsers against payloads recorded from a real session (meta.live.ts --record,
// server via the web front) and cross-checked with the DB snapshot taken in the same run; builders
// against re-implementations of the server Read() layouts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PacketReader } from "../packet.ts";
import { fromHex } from "../bytes.ts";
import {
  buildGetInvenInfo, buildGetOption, buildGetPointCash, buildGetUserInfo, parseInvenInfo, parsePointCash, parseUserInfo,
} from "../metaAuth.ts";
import {
  BUY_OK, buildCharChangeEquip, buildGoodsBuy, buildRespawnBody, buildShopGetSailList, equipRequestFromLoadout,
  parseChangeInventory, parseCharChangeEquip, parseCharaInfo, parseDeleteItem, parseGoodsBuy, parseInvItemData,
  parseInventoryGetInfo, parseMyInfoBasic, parseMyInfoRecord, parseRespawnAck, weaponsOf, KEEP_CHARA_SLOT, unsavedCharas,
} from "../metaGame.ts";
import { ShopCatalog, decodeGoods, inflateZlib, GOODS_RECORD_SIZE } from "../shopCatalog.ts";
import { EquipSlot, type EquipPair } from "../../lobby/types.ts";

interface Vec { conn: string; op: number; hex: string; step: string }
const V = JSON.parse(readFileSync(new URL("./meta-vectors.json", import.meta.url), "utf8")) as {
  db: {
    account: Record<string, string>; equipments: Record<string, string>; characters: Record<string, string>[];
    items: Record<string, string>[]; wallet0: { gold: number; cash: number; tags: number };
    bought: { goodId: number; itemId: number; count: number; price: number; objectId: number; extraGoodId: number; extraItemId: number; extraPrice: number; failGoodId: number };
    equipTarget: { objectId: number; itemId: number };
  };
  vectors: Vec[];
};
const db = V.db;
const all = (op: number, step?: string, conn?: string) =>
  V.vectors.filter((v) => v.op === op && (!step || v.step === step) && (!conn || v.conn === conn));
const one = (op: number, step?: string, conn?: string): PacketReader => {
  const v = all(op, step, conn)[0];
  assert.ok(v, `vector ${op} ${step ?? ""} ${conn ?? ""}`);
  return new PacketReader(fromHex(v.hex), 2);
};
/** Unicast frames carry opcode + body + 2 framing zeros: a full parse leaves exactly those. */
const framed = (r: PacketReader) => assert.equal(r.remaining, 2, `trailing bytes ${r.remaining}`);

test("2317 GET_USER_INFO_ACK: every block consumed; nick/gold/cash match accounts", () => {
  const r = one(2317, "login", "auth-A");
  const u = parseUserInfo(r);
  framed(r);
  assert.equal(u.error, 0);
  assert.equal(u.basic!.nickname, db.account.nickname);
  assert.equal(u.basic!.gold, db.wallet0.gold);
  assert.equal(u.basic!.cash, db.wallet0.cash);
  assert.equal(u.basic!.exp, BigInt(db.account.experience));
  assert.equal(u.record!.total.matches, 0);
  assert.equal(u.dino.itemId, Number(db.equipments.dino_item_chara));
});

test("2319 GET_INVEN_INFO_ACK: the 16 in-memory basics", () => {
  const r = one(2319, "login");
  const p = parseInvenInfo(r);
  framed(r);
  assert.equal(p.error, 0);
  assert.equal(p.items.length, 16);
  assert.equal(p.basicCount, 16);
  assert.ok(p.items.every((i) => i.equip === 3 && i.count === 1), "basics are Permanent");
  assert.ok(p.items.some((i) => i.itemId === db.equipTarget.itemId && i.objectId === db.equipTarget.objectId));
});

test("1061 POINT_CASH on Auth and Game", () => {
  for (const conn of ["auth-A", "game-A"]) {
    const r = one(1061, "login", conn);
    const w = parsePointCash(r);
    framed(r);
    assert.deepEqual(w, { error: 0, ...db.wallet0 });
  }
});

test("USER_ENTER pushes: 2371, 2395, 2369", () => {
  let r = one(2371, "login");
  const b = parseMyInfoBasic(r);
  framed(r);
  assert.equal(b.nickname, db.account.nickname);
  assert.equal(b.rank, Number(db.account.rank));
  r = one(2395, "login");
  const inv = parseInvItemData(r);
  framed(r);
  assert.equal(inv.fakeNick, "");
  r = one(2369, "login");
  const rec = parseMyInfoRecord(r);
  framed(r);
  assert.equal(rec.season.kills + rec.total.kills, 0);
});

test("2453 CHARA_INFO: characters and equip block", () => {
  const r = one(2453, "relog", "game-A");
  const c = parseCharaInfo(r);
  framed(r);
  assert.deepEqual(new Set(c.charas.map((x) => x.itemId)), new Set(db.characters.map((x) => Number(x.id))));
  assert.equal(c.equip[EquipSlot.Primary].itemId, Number(db.equipments.weapon_primary));
  assert.equal(c.equip[EquipSlot.Chara].itemId, Number(db.equipments.chara_red_side));
  for (const i of [5, 6, 7]) assert.deepEqual(c.equip[i], { itemId: 0, objectId: 0 });
});

test("§11.8: Auth 2453 exposes failed character INSERTs (stock objectId) and Game duplicates the slot", () => {
  const auth = parseCharaInfo(one(2453, "login", "auth-A"));
  assert.deepEqual(unsavedCharas(auth).map((c) => c.itemId), [601666, 602002]);
  const game = parseCharaInfo(one(2453, "login", "game-A"));
  assert.equal(unsavedCharas(game).length, 0);
  assert.deepEqual(game.charas.filter((c) => c.slot === 3).map((c) => c.itemId), [602011, 602002]);
  assert.equal(db.characters.filter((c) => c.slot === "3").length, 2);
});

test("3082 CHANGE_INVENTORY: login default vs relog after 6149", () => {
  let r = one(3082, "login", "game-A");
  const before = parseChangeInventory(r);
  framed(r);
  assert.equal(before.equip[EquipSlot.Primary].itemId, 103004); // player_equipments default (schema :600)
  r = one(3082, "relog", "game-A");
  const after = parseChangeInventory(r);
  framed(r);
  assert.equal(after.emoticons.length, 6);
  assert.deepEqual(after.equip[EquipSlot.Primary], { itemId: db.equipTarget.itemId, objectId: db.equipTarget.objectId });
  assert.deepEqual(weaponsOf(after.equip), {
    primary: Number(db.equipments.weapon_primary), secondary: Number(db.equipments.weapon_secondary), melee: Number(db.equipments.weapon_melee),
    grenade: Number(db.equipments.weapon_explosive), special: Number(db.equipments.weapon_special),
  });
  assert.equal(after.equip[EquipSlot.Chara].itemId, Number(db.equipments.chara_red_side));
  assert.equal(after.dino.itemId, Number(db.equipments.dino_item_chara));
  assert.equal(after.charaSlots.length, 2);
});

test("1047 GOODS_BUY_ACK: fail and ok branches; 3334 per good; wallet == accounts", () => {
  let r = one(1047, "buy-fail");
  const fail = parseGoodsBuy(r, [{ goodId: db.bought.failGoodId, buyType: 2 }]);
  framed(r);
  assert.equal(fail.ok, false);
  assert.equal(fail.code, 0x80001017); // GetGoods found nothing
  r = one(1047, "buy");
  const ok = parseGoodsBuy(r, [{ goodId: db.bought.goodId, buyType: 1 }, { goodId: db.bought.extraGoodId, buyType: 1 }]);
  framed(r);
  assert.equal(ok.ok, true);
  assert.equal(ok.code, BUY_OK);
  assert.equal(ok.cash, Number(db.account.cash));
  assert.equal(ok.gold, Number(db.account.gold));
  assert.equal(ok.cash, db.wallet0.cash - db.bought.price - db.bought.extraPrice);
  const deltas = all(3334, "buy").map((v) => { const rr = new PacketReader(fromHex(v.hex), 2); const d = parseInventoryGetInfo(rr); framed(rr); return d; });
  const items = deltas.flatMap((d) => d.items);
  assert.ok(deltas.every((d) => d.changeType === 0));
  const bought = items.find((i) => i.itemId === db.bought.itemId)!;
  assert.equal(bought.objectId, db.bought.objectId);
  const row = db.items.find((i) => Number(i.object_id) === bought.objectId)!;
  assert.equal(Number(row.id), bought.itemId);
  assert.equal(Number(row.count), bought.count);
  assert.equal(Number(row.equip), bought.equip);
  assert.ok(items.some((i) => i.itemId === db.bought.extraItemId));
});

test("1059 DELETE_ITEM_ACK and 6150 CHAR_CHANGE_EQUIP_ACK", () => {
  let r = one(1059, "delete");
  const d = parseDeleteItem(r);
  framed(r);
  assert.equal(d.ok, true);
  assert.ok(!db.items.some((i) => Number(i.object_id) === d.objectId), "deleted row gone from player_items");
  r = one(6150, "equip");
  assert.equal(parseCharChangeEquip(r).error, 0);
  r.readH();
  framed(r);
});

test("catalog chunks are zlib (78 9C ... Adler-32), goods join the matching list", async () => {
  const cat = new ShopCatalog();
  for (const v of V.vectors.filter((x) => x.step === "catalog")) cat.onPacket(v.op, new PacketReader(fromHex(v.hex), 2));
  await cat.ready;
  const z = cat.packed(1037)!;
  assert.deepEqual([z[0], z[1]], [0x78, 0x9c]);
  const raw = await inflateZlib(z);
  assert.equal(raw.length % GOODS_RECORD_SIZE, 0);
  const d = await cat.decode();
  assert.equal(d.sailChanged, true); // empty hash != Shop.dat
  assert.ok(d.version !== null && d.items.length > 0 && d.repairs.length > 0);
  const g = d.goods.find((x) => x.goodId === db.bought.goodId)!;
  assert.equal(g.itemId, db.bought.itemId); // 1042 says what the server delivered (player_items.id)
  assert.equal(g.priceCash, db.bought.price);
  assert.equal(decodeGoods(raw).find((x) => x.goodId === db.bought.goodId)!.itemId, 0, "no itemId without 1042");
});

test("5138 RESPAWN_ACK: echoes the equipped primary; broadcast truncation drops the accessory high half", () => {
  const v = all(5138, "respawn", "game-A")[0];
  const r = new PacketReader(fromHex(v.hex), 2);
  const a = parseRespawnAck(r);
  assert.equal(a.weapons.primary, Number(db.equipments.weapon_primary));
  assert.ok([Number(db.equipments.chara_red_side), Number(db.equipments.chara_blue_side)].includes(a.chara), `chara ${a.chara}`);
  assert.equal(a.accessory, null);
  assert.equal(r.remaining, 2);
});

// ---- builders

test("empty Auth REQs (2316/2318/2320/1060)", () => {
  for (const b of [buildGetUserInfo(), buildGetInvenInfo(), buildGetOption(), buildGetPointCash()]) assert.equal(b.length, 0);
});

test("1029 = S[32]; 1045 = C n + n×{C, D goodId, C buyType, C, Q}", () => {
  assert.equal(buildShopGetSailList("abc").length, 32);
  const r = new PacketReader(buildGoodsBuy([{ goodId: 170000101, buyType: 1 }, { goodId: 10310201, buyType: 2 }]).toBytes());
  assert.equal(r.readC(), 2);
  for (const [goodId, buyType] of [[170000101, 1], [10310201, 2]]) {
    r.readC();
    assert.equal(r.readD(), goodId);
    assert.equal(r.readC(), buyType);
    r.readC();
    r.readQ();
  }
  assert.equal(r.remaining, 0);
});

/** Port of G/CharChangeEquip121Parser.ParseBody (throws on trailing bytes, like the server). */
function serverParse6149(body: Uint8Array) {
  const r = new PacketReader(body);
  const count = (max: number) => { const n = r.readC(); if (n > max) throw new Error(`count ${n} > ${max}`); return n; };
  const pair = () => ({ itemId: r.readD(), objectId: r.readD() });
  const pairs = (max: number) => Array.from({ length: count(max) }, pair);
  const emotes = pairs(6), emotesChanged = r.readC() !== 0;
  const accessory = pair(), accessoryChanged = r.readC() !== 0;
  const a = Array.from({ length: count(39) }, () => r.readD()); r.readH();
  const b = Array.from({ length: count(39) }, () => r.readD()); r.readH();
  r.readC();
  const equip = Array.from({ length: 18 }, pair), equipChanged = r.readC() !== 0;
  const items3 = pairs(3), items3Changed = r.readC() !== 0;
  const slots = [...r.readB(count(2))];
  if (r.remaining !== 0) throw new Error(`${r.remaining} trailing bytes`);
  return { emotes, emotesChanged, accessory, accessoryChanged, a, b, equip, equipChanged, items3, items3Changed, slots };
}

test("6149 builder matches the server parser; equipRequestFromLoadout keeps chara/slots", () => {
  const r = one(3082, "login", "game-A");
  const lo = parseChangeInventory(r);
  const charas = parseCharaInfo(one(2453, "login", "game-A"));
  const body = buildCharChangeEquip(equipRequestFromLoadout(lo, { [EquipSlot.Primary]: { itemId: 104006, objectId: 1073845830 } }, charas)).toBytes();
  assert.equal(body.length, 1 + 1 + 8 + 1 + 1 + 2 + 1 + 2 + 145 + 1 + 1 + 1 + 3);
  const p = serverParse6149(body);
  assert.equal(p.equipChanged, true);
  assert.deepEqual(p.equip[0], { itemId: 104006, objectId: 1073845830 });
  assert.deepEqual(p.equip[8], lo.equip[8]);
  // recorded account pid 45: 3082 slots [2, 3]; 2453 has 602011 AND 602002 at slot 3 -> blue sent as "keep"
  assert.deepEqual(lo.charaSlots, [2, 3]);
  assert.deepEqual(p.slots, [2, KEEP_CHARA_SLOT]);
  const noInfo = serverParse6149(buildCharChangeEquip(equipRequestFromLoadout(lo, {})).toBytes());
  assert.deepEqual(noInfo.slots, [KEEP_CHARA_SLOT, KEEP_CHARA_SLOT]);
  const full = buildCharChangeEquip({
    emoticons: Array.from({ length: 6 }, (_, i) => ({ itemId: 2900000 + i, objectId: i })), emoticonsChanged: true,
    accessory: { itemId: 3000001, objectId: 9 }, accessoryChanged: true, couponsDisable: [1600001], couponsEnable: [1600002, 1600003],
    items3: [{ itemId: 1500511, objectId: 0 }, { itemId: 0, objectId: 0 }, { itemId: 0, objectId: 0 }], items3Changed: true, charaSlots: [0, 1],
  }).toBytes();
  const q = serverParse6149(full);
  assert.equal(q.emotes[5].itemId, 2900005);
  assert.deepEqual([q.a, q.b], [[1600001], [1600002, 1600003]]);
  assert.equal(q.items3[0].itemId, 1500511);
});

test("5137 RESPAWN body = 154 bytes, G/PROTOCOL_BATTLE_RESPAWN_REQ.Read offsets", () => {
  const equip: EquipPair[] = Array.from({ length: 18 }, (_, i) => ({ itemId: 1000 + i, objectId: 2000 + i }));
  const b = buildRespawnBody(equip, 0x1f, { itemId: 3000001, objectId: 7 }).toBytes();
  assert.equal(b.length, 154);
  const r = new PacketReader(b);
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) { ids.push(r.readD()); r.readD(); }
  r.skip(24);
  for (let i = 0; i < 10; i++) { ids.push(r.readD()); r.readD(); }
  assert.equal(r.readH(), 0x1f);
  ids.push(r.readD());
  // Field0[0..4] weapons, [5] chara (pair 8), [6..14] pairs 9..17, [15] accessory
  assert.deepEqual(ids, [1000, 1001, 1002, 1003, 1004, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 1015, 1016, 1017, 3000001]);
});
