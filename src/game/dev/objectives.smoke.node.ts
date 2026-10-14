// Destroy objectives: which colour a team plays and which objective its bullets may damage (objectives.ts).
// node --experimental-transform-types src/game/dev/objectives.smoke.node.ts
import assert from "node:assert/strict";
import { barOf, isEnemyObjective, sideOf } from "../objectives.ts";

// no swap: CT (1) plays blue, FR (0) plays red
assert.equal(sideOf(1), "blue");
assert.equal(sideOf(0), "red");
// TEAM_SWAP: the teams trade colours
assert.equal(sideOf(1, true), "red");
assert.equal(sideOf(0, true), "blue");

// the blue objective (Transformer / *_BLUE) is damaged by red players only, and the red one by blue players only
assert.equal(isEnemyObjective("blue", 0), true);
assert.equal(isEnemyObjective("blue", 1), false);
assert.equal(isEnemyObjective("red", 1), true);
assert.equal(isEnemyObjective("red", 0), false);
assert.equal(isEnemyObjective("red", 0, true), true, "swap: the red team now plays blue");

// server bars: red = Animation 256 = bar1, blue = 257 = bar2
assert.equal(barOf("red"), 1);
assert.equal(barOf("blue"), 2);

console.log("objectives smoke ok");
