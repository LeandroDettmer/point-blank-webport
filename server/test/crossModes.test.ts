// Map rotation per Cross room rule (SystemMapXML.GetMapLimit): HeadHunter (Rule 32, mode 8), Chaos (Rule 80, mode 15) and the
// Bomb Mission variants (Rule 128, mode 2, StageOptions 96 / 128 / 224). A map outside the rule's rotation has no limit, and the
// server's READYBATTLE then returns without starting, so the rotation must hold the seed rows (db/init/001_init.sql).
//   node --test test/crossModes.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db.ts";
import { getMapLimit, loadMaps } from "../src/game/roomModel.ts";

const RULES = [
  { mode_id: 1, rule: 0, stage_options: 1, conditions: 4 }, { mode_id: 2, rule: 128, stage_options: 1, conditions: 8 },
  { mode_id: 8, rule: 32, stage_options: 0, conditions: 4 }, { mode_id: 15, rule: 80, stage_options: 0, conditions: 4 },
  { mode_id: 22, rule: 128, stage_options: 96, conditions: 8 }, { mode_id: 23, rule: 128, stage_options: 128, conditions: 8 },
  { mode_id: 24, rule: 128, stage_options: 224, conditions: 8 },
  { mode_id: 4, rule: 0, stage_options: 1, conditions: 16 }, { mode_id: 55, rule: 128, stage_options: 0, conditions: 32 },
  { mode_id: 40, rule: 224, stage_options: 0, conditions: 8 }, { mode_id: 47, rule: 192, stage_options: 1, conditions: 8 },
];
// mode 8 = HeadHunter (10 maps), mode 15 = Chaos (10 maps), mode 2 = Bomb (a few of its 21), mode 1 = Deathmatch (one)
const MATCH = (mode_id: number, map_id: number, map_limit: number) => ({ mode_id, map_id, map_limit, tag: 0, name: "seed" });
const MATCHES = [
  ...[1, 2, 4, 5, 7, 9, 10, 23, 29, 67].map((m) => MATCH(8, m, m === 9 || m === 10 ? 8 : 16)),
  ...[1, 2, 4, 7, 9, 10, 20, 23, 42, 67].map((m) => MATCH(15, m, m === 9 || m === 10 ? 8 : 16)),
  ...[12, 13, 19, 131].map((m) => MATCH(2, m, 16)), MATCH(2, 89, 10), MATCH(1, 1, 16), MATCH(1, 9, 8),
  // Annihilation = mode 4 "Eliminate" (12 maps, Rule 0), Ace = mode 55 (Drain Tunnel 108, Rule 128). Modes 40 / 47 (Hardcore) have no row.
  ...[1, 2, 4, 9, 10, 18, 20, 28, 34, 41, 42, 65].map((m) => MATCH(4, m, m === 9 || m === 10 || m === 41 ? 8 : 16)), MATCH(55, 108, 16),
];

before(async () => {
  (pool as unknown as { query: (sql: string) => Promise<{ rows: unknown[] }> }).query = async (sql: string) => ({
    rows: sql.includes("system_map_matches") ? MATCHES : sql.includes("system_map_rules") ? RULES : [],
  });
  await loadMaps();
});

test("HeadHunter rule 32: its 10 maps, Library (3) not in the rotation", () => {
  for (const m of [1, 2, 4, 5, 7, 9, 10, 23, 29, 67]) assert.ok(getMapLimit(m, 32), `map ${m}`);
  assert.equal(getMapLimit(3, 32), null);
  assert.equal(getMapLimit(9, 32)?.limit, 8, "Crack Down keeps its 8-player limit");
});

test("Chaos rule 80: its 10 maps, Two Towers (29) not in the rotation", () => {
  for (const m of [1, 2, 4, 7, 9, 10, 20, 23, 42, 67]) assert.ok(getMapLimit(m, 80), `map ${m}`);
  assert.equal(getMapLimit(29, 80), null);
});

test("Bomb variants share the Bomb rotation through Rule 128 (stage 96 / 128 / 224 do not change the maps)", () => {
  assert.ok(getMapLimit(12, 128));
  assert.ok(getMapLimit(131, 128));
  assert.equal(getMapLimit(12, 0), null, "a Deathmatch rule has no Bomb map");
  assert.equal(getMapLimit(89, 128)?.limit, 10, "Bank Hall keeps its 10-player limit");
});

test("the rules do not mix: HeadHunter / Chaos maps are not Bomb or Deathmatch rotations by accident", () => {
  assert.equal(getMapLimit(20, 128), null, "Desert Camp is Chaos only");
  assert.equal(getMapLimit(12, 80), null, "Down Town is Bomb only");
});

test("Annihilation rule 0 (mode 4 Eliminate): its 12 maps, Rule 128 has no Annihilation rotation", () => {
  for (const m of [1, 2, 4, 9, 10, 18, 20, 28, 34, 41, 42, 65]) assert.ok(getMapLimit(m, 0), `map ${m}`);
  assert.equal(getMapLimit(3, 0), null, "Old Library is not an Eliminate map");
  assert.equal(getMapLimit(1, 128), null, "Rule 128 Annihilation (mode 43) has no map row");
  assert.equal(getMapLimit(9, 0)?.limit, 8, "Crack Down keeps its 8-player limit");
});

test("Ace rule 128 (mode 55): Drain Tunnel (108) only", () => {
  assert.equal(getMapLimit(108, 128)?.limit, 16);
  assert.equal(getMapLimit(1, 128), null, "Port Acaba is not an Ace map");
  assert.equal(getMapLimit(108, 0), null, "Ace needs its Rule 128");
});

test("Hardcore (Rule 192 mode 47 / Rule 224 mode 40): no map in the rotation, so no room can run it", () => {
  for (const m of [12, 13, 88, 91, 131, 1]) { assert.equal(getMapLimit(m, 192), null, `map ${m} rule 192`); assert.equal(getMapLimit(m, 224), null, `map ${m} rule 224`); }
});
