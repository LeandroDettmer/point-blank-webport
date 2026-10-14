// Cross Deathmatch rules in the battle's real damage path: every hit lands through computeDamage (game.ts applyHit for a
// remote victim, applyHitLocal for ourselves and bots, the HitEvent of a remote shooter). HeadHunter (Rule 32, roomType 4)
// = 1 damage unless headshot, Chaos (Rule 80) = 200. Other rooms keep their damage.
//   node --test src/game/test/roomRuleDamage.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDamage, type RoomRule } from "../damage.ts";
import type { Actor } from "../types.ts";

const DM = 4, BOMB = 8;
const HEADHUNTER: RoomRule = { rule: 32, roomType: DM };
const CHAOS: RoomRule = { rule: 80, roomType: DM };
const PLAIN_DM: RoomRule = { rule: 0, roomType: DM };

const shooter = { id: 1, team: 0, kind: "bot", alive: true } as unknown as Actor;

/** HP lost by a fresh 100 HP victim (team 1) hit by `base` in `zone`, through computeDamage */
function dealt(room: RoomRule | undefined, base: number, zone: "torso" | "head", helmet = false): { dealt: number; helmetBlocked: boolean } {
  const target = { id: 2, team: 1, kind: "remote", alive: true, hp: 100, invulnUntil: 0, helmet, defense: 0 } as unknown as Actor;
  const r = computeDamage({ target, attacker: shooter, base, zone, helmetPenetrate: 0, falloff: 1, now: 1, room });
  return { dealt: r.dealt, helmetBlocked: r.helmetBlocked };
}

test("control: plain Deathmatch keeps the body damage (AK 33 x 1.2 = 40)", () => {
  assert.equal(dealt(PLAIN_DM, 33, "torso").dealt, 40);
  assert.equal(dealt(undefined, 33, "torso").dealt, 40);
});

test("HeadHunter: a body shot does 1 damage", () => {
  assert.equal(dealt(HEADHUNTER, 33, "torso").dealt, 1);
});

test("HeadHunter: a headshot keeps the normal headshot damage", () => {
  assert.equal(dealt(HEADHUNTER, 33, "head").dealt, dealt(undefined, 33, "head").dealt);
});

test("Chaos: a body shot does 200 damage (one-shot)", () => {
  assert.equal(dealt(CHAOS, 33, "torso").dealt, 200);
});

test("Chaos: a headshot does 200 damage too", () => {
  assert.equal(dealt(CHAOS, 33, "head").dealt, 200);
});

test("Chaos: a helmet that stops the head hit still stops it (0 damage)", () => {
  const r = dealt(CHAOS, 33, "head", true);
  assert.equal(r.helmetBlocked, true);
  assert.equal(r.dealt, 0);
});

test("the rule only applies in Deathmatch rooms (Bomb type 8 with rule 80 is untouched)", () => {
  assert.equal(dealt({ rule: 80, roomType: BOMB }, 33, "torso").dealt, 40);
});
