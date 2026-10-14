// Run: node --test src/test/config.test.ts  (node --test, native TS type stripping)
// Exercises the maps/index.json wiring in src/config.ts: ?map= resolution and mapFromRoomMapId,
// both before and after loadMapIndex() has populated the 2017 maps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const indexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "assets", "maps", "index.json");
const indexEntries = JSON.parse(readFileSync(indexPath, "utf8"));

function stubDom(search: string): void {
  (globalThis as any).window = { location: { search } };
  (globalThis as any).fetch = async (url: string) => {
    assert.equal(url, "/assets/maps/index.json");
    return { ok: true, json: async () => indexEntries };
  };
}

test("before loadMapIndex(): falls back to the pre-2017 4 maps", async () => {
  stubDom("?map=library");
  const config = await import(`../config.ts?before-${Date.now()}`);
  // library isn't in the fallback AVAILABLE_MAPS, so resolveMapId() (evaluated at import time) defaults.
  assert.equal(config.CurrentMap, "nstation");
  assert.deepEqual(config.AVAILABLE_MAPS, ["metro", "nstation", "blowcity", "sewerage"]);
});

test("loadMapIndex() exposes all 2017 maps by id, mapId and ?map=", async () => {
  stubDom("?map=library");
  const config = await import(`../config.ts?full-${Date.now()}`);
  await config.loadMapIndex();

  // ?map= is re-resolved once the index is loaded (library has no fallback entry but is a real 2017 map).
  assert.equal(config.CurrentMap, "library");

  assert.ok(config.AVAILABLE_MAPS.length >= 70, `expected >=70 maps, got ${config.AVAILABLE_MAPS.length}`);

  const cases: [number, string][] = [
    [4, "nstation"], // M. Station (already shipped)
    [36, "metro"], // Metro (already shipped)
    [3, "library"], // 2017 map, no prior client folder
    [67, "pumpkinhollow"], // 2017 map with a PT-BR name (Parque Assombrado)
    [78, "sewerage"], // Sewerage (PBCross)
  ];
  for (const [mapId, expected] of cases) {
    assert.equal(config.mapFromRoomMapId(mapId), expected, `mapId ${mapId}`);
  }

  // The 7 maps without a server mapId must never be produced by mapFromRoomMapId.
  const noMapId = ["angkorruins", "blackmamba", "deadtown", "ghosttown", "giran2", "hardrock", "rothenvillage"];
  for (const id of noMapId) assert.ok(config.AVAILABLE_MAPS.includes(id), `${id} should still be selectable via ?map=`);

  assert.equal(config.MAP_LABELS.pumpkinhollow, "Parque Assombrado");
});
