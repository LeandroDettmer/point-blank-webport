#!/usr/bin/env node
// Snapshot of item names FROM THE SERVER DATA, so the lobby never invents names:
//   1. system_shop.item_name + system_shop_effects.coupon_name (Postgres of the local server: docker exec pb-postgres-local psql)
//   2. Data/Match/ItemStatistics.xml  <Statistic Id Name>  (weapons, fallback)
// Writes src/lobby/state/data/itemNames.json {format, generated, sources, names: {itemId: [name, src]}}.
// The runtime reads it through itemNames.ts, which also exposes setItemNameProvider() to swap the source.
//
//   node src/lobby/state/data/export-item-names.mjs [--no-db]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "../../../../server");
const XML = path.join(SERVER, "runtime/Data/Match/ItemStatistics.xml");
const OUTF = path.join(HERE, "itemNames.json");
const TAB = String.fromCharCode(9);

const names = {};
const sources = {};

function psql(q) {
  return execFileSync("docker", ["exec", "pb-postgres-local", "psql", "-U", "postgres", "-d", "pb", "-At", "-F", TAB, "-c", q],
    { encoding: "utf8", maxBuffer: 64 << 20 });
}
function take(rows, src) {
  let n = 0;
  for (const line of rows.split(/\r?\n/)) {
    const [id, name] = line.split(TAB);
    if (!id || !name || names[id]) continue;
    names[id] = [name.trim(), src];
    n++;
  }
  sources[src] = n;
}

if (!process.argv.includes("--no-db")) {
  take(psql("select item_id, item_name from system_shop where item_name <> '' order by item_id"), "system_shop");
  // coupons: system_shop_effects.coupon_name, loaded by ShopManager next to system_shop
  take(psql("select coupon_id, coupon_name from system_shop_effects where coupon_name <> '' order by coupon_id"), "system_shop_effects");
}

let nx = 0;
for (const m of fs.readFileSync(XML, "utf8").matchAll(/<Statistic\s+Id="(\d+)"\s+Name="([^"]*)"/g)) {
  if (names[m[1]]) continue;
  names[m[1]] = [m[2].trim(), "ItemStatistics.xml"];
  nx++;
}
sources["ItemStatistics.xml"] = nx;

fs.writeFileSync(OUTF, JSON.stringify({
  format: "pb-item-names/1", generated: new Date().toISOString(),
  from: ["server DB system_shop.item_name", "server DB system_shop_effects.coupon_name", "server/runtime/Data/Match/ItemStatistics.xml"],
  sources, names,
}) + "\n");
console.log(OUTF, JSON.stringify(sources), Object.keys(names).length);
