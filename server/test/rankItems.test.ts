// In-memory rank / GM items (PlayerInventory.LoadGeneralBeret, LoadHatForGM): a GM general (rank 53) has the
// "Beret S. General" equipped but the lobby showed it missing from the inventory, because both virtual rows went out
// with objectId 0 and the client keys the inventory by objectId.
//   node --test test/rankItems.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db.ts";
import { getInvenInfoAck } from "../src/auth/metaPackets.ts";
import { ItemsModel, ItemEquipType, isStockId } from "../src/shared/items.ts";
import { PlayerCharacters, PlayerEquipment, PlayerInventory } from "../src/shared/models.ts";
import { checkEquipedItems, rankItems, validatePlayerInventoryStatus } from "../src/shared/playerUtils.ts";
import type { Account } from "../src/shared/account.ts";

after(async () => { await pool.end(); });

const BERET = 2700008, MOD_HAT = 700160;

/** 2319 rows: H op, H 0, D 0, H n, n x {D objectId, D itemId, C equip, D count}. */
function invenRows(b: Uint8Array): { objectId: number; itemId: number }[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = dv.getUint16(8, true), out = [];
  for (let i = 0, o = 10; i < n; i++, o += 13) out.push({ objectId: dv.getUint32(o, true), itemId: dv.getUint32(o + 4, true) });
  return out;
}

test("rankItems: beret from rank 46, MOD Hat for GMs, each with its own stock objectId", () => {
  assert.deepEqual(rankItems(45, false), []);
  assert.deepEqual(rankItems(46, false).map((i) => i.id), [BERET]);
  assert.deepEqual(rankItems(10, true).map((i) => i.id), [MOD_HAT]);
  const both = rankItems(53, true);
  assert.deepEqual(both.map((i) => i.id), [BERET, MOD_HAT]);
  for (const it of both) {
    assert.equal(it.equip, ItemEquipType.Permanent);
    assert.ok(isStockId(it.objectId), `${it.id} objectId ${it.objectId} is a stock id (never a player_items row)`);
  }
  assert.notEqual(both[0].objectId, both[1].objectId);
});

test("2319 of a GM general: the beret row survives a client map keyed by objectId", async () => {
  const p = {
    playerId: 7n, nickname: "player1", rank: 53, cafePC: 0, inventoryPlus: 0,
    inventory: new PlayerInventory(), character: new PlayerCharacters(), isGM: () => true,
  } as unknown as Account;
  p.inventory.items.push(Object.assign(new ItemsModel(103004, "K-2", ItemEquipType.Permanent, 1), { objectId: 501n }));
  await validatePlayerInventoryStatus(p); // GM: cafe access needs no DB, no character item -> no INSERT
  const rows = invenRows(getInvenInfoAck(p.inventory.items, 0));
  const byObject = new Map(rows.map((r) => [r.objectId, r.itemId]));
  assert.equal(byObject.size, rows.length, "every 2319 row has its own objectId");
  assert.ok([...byObject.values()].includes(BERET), "the General beret is listed");
  assert.ok([...byObject.values()].includes(MOD_HAT), "the MOD Hat is listed");
});

test("checkEquipedItems keeps the General beret while the rank grants it, clears it otherwise", () => {
  const inv = () => [new ItemsModel(601001, "Red", ItemEquipType.Permanent, 1), new ItemsModel(602002, "Blue", ItemEquipType.Permanent, 1)];
  const equip = () => Object.assign(new PlayerEquipment(), { beretItem: BERET, dinoItem: 0 });
  const owned = equip();
  assert.equal(checkEquipedItems(owned, [...inv(), ...rankItems(46, false)], false) & 1, 0);
  assert.equal(owned.beretItem, BERET);
  const lost = equip(); // rank fell below 46 (or a beret that was never owned): the slot is reset and saved
  assert.equal(checkEquipedItems(lost, inv(), false) & 1, 1);
  assert.equal(lost.beretItem, 0);
});
