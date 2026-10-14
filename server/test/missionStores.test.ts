// BUY_CARD_SET (2364): system_mission_stores.enabled gates the purchase. pool.query is mocked, no database.
//   node --test test/missionStores.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { PacketReader } from "../../src/net/packet.ts";
import { pool } from "../src/db.ts";
import { PlayerMissions } from "../src/shared/models.ts";
import { shop } from "../src/shared/shop.ts";
import { handleBuyCardSet, loadSocialData } from "../src/game/socialHandlers.ts";
import type { GameClient } from "../src/game/gameServer.ts";

const ITEM = 2600005;
let stores: { id: number; item_id: number; enabled: boolean }[] = [];
const inserts: unknown[][] = [];
const q = (pool as unknown as { query: unknown }).query;
(pool as unknown as { query: unknown }).query = async (sql: string, args: unknown[] = []) => {
  if (/FROM system_mission_stores/.test(sql)) return { rows: stores };
  if (/INSERT INTO player_mission_slots/.test(sql)) inserts.push(args);
  return { rows: [] };
};
after(() => { (pool as unknown as { query: unknown }).query = q; });
const allBefore = shop.all.slice();
shop.all.push({ id: 1, item: { id: ITEM }, priceGold: 0 } as never);
after(() => { shop.all.length = 0; shop.all.push(...allBefore); });

async function buy(setId: number) {
  const sent: Uint8Array[] = [];
  const p = { playerId: 1n, gold: 1000, cash: 0, mission: new PlayerMissions() };
  await handleBuyCardSet({ player: p, session: { send: (b: Uint8Array) => sent.push(b) } } as unknown as GameClient, new PacketReader(Uint8Array.from([setId, 0])));
  const b = sent[0];
  return { err: (b[2] | (b[3] << 8) | (b[4] << 16) | (b[5] << 24)) >>> 0, owns: p.mission.ownsCardSet(setId) };
}

test("disabled set is refused with 0x8000104d and nothing is stored", async () => {
  stores = [{ id: 5, item_id: ITEM, enabled: false }];
  await loadSocialData();
  const r = await buy(5);
  assert.equal(r.err, 0x8000104d);
  assert.equal(r.owns, false);
  assert.equal(inserts.length, 0);
});

test("enabled set is bought", async () => {
  stores = [{ id: 5, item_id: ITEM, enabled: true }];
  await loadSocialData();
  const r = await buy(5);
  assert.equal(r.err, 0);
  assert.equal(r.owns, true);
  assert.equal(inserts.length, 1);
});
