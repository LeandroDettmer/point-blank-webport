// .mqf parser (loadMissionCards): layout follows u32@4 (questType 1 = 8+24 B per task, 2 = 8 B) as in MissionCardRAW.cs.
// Every shipped file must decode coherent: taskType in MissionType, limit > 0, 40 cards x tasks, prizes plausible.
//   node --test test/missionCards.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { data, loadMissionCards, getMissionItems } from "../src/shared/data.ts";

test("all shipped .mqf decode coherent", () => {
  data.missionCardAwards = []; data.missionItems = [];
  const cards = loadMissionCards();
  const ids = [...new Set(cards.map((c) => c.missionId))].sort((a, b) => a - b);
  assert.deepEqual(ids, [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  for (const id of ids) {
    const set = cards.filter((c) => c.missionId === id);
    assert.equal(set.length, 40, `set ${id}: 40 tasks, one copy (the C# list holds two)`);
    for (const c of set) {
      assert.ok(c.missionType >= 1 && c.missionType <= 57, `set ${id} taskType ${c.missionType}`);
      assert.ok(c.missionLimit > 0, `set ${id} limit`);
    }
    const aw = data.missionCardAwards.filter((a) => a.id === id);
    assert.ok(aw.length > 0 && aw.length <= 10, `set ${id} awards`);
    for (const a of aw) {
      assert.ok(a.gold >= 0 && a.gold <= 1000 && a.exp >= 0 && a.exp <= 1000, `set ${id} prize ${a.gold}/${a.exp}`);
      assert.ok(a.ribbon + a.ensign + a.medal <= 1);
    }
  }
});

test("questType 1 (Field_o) reads the +24 B per task layout", () => {
  const f = loadMissionCards().filter((c) => c.missionId === 12);
  assert.ok(f.slice(0, 40).every((c) => c.missionType >= 1 && c.missionType <= 57 && c.missionLimit > 0));
});

test("set 13 (EventCard = Independence2016_BR): qt=2, 10 x 500g/500e, final items 103194 + 700178 (7 d)", () => {
  data.missionCardAwards = []; data.missionItems = [];
  const set = loadMissionCards().filter((c) => c.missionId === 13);
  assert.equal(set.length, 40);
  assert.deepEqual([...new Set(set.map((c) => c.missionType))].sort((a, b) => a - b), [13, 15, 27, 28, 29, 40, 44]);
  const aw = data.missionCardAwards.filter((a) => a.id === 13);
  assert.equal(aw.length, 10);
  assert.ok(aw.every((a) => a.gold === 500 && a.exp === 500), "qt=2: exp raw, not x10");
  const items = getMissionItems(13);
  assert.deepEqual(items.map((i) => i.id), [103194, 700178]);
  assert.ok(items.every((i) => i.count === 604800), "7 days in seconds");
});
