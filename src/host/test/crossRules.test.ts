// Damage of the Cross Deathmatch rules in the host's MatchCore (matchCore.ts ~1119): HeadHunter (Rule 32) = 1 damage unless
// headshot, Chaos (Rule 80) = 200. The rule comes from the room seed (RoomModel seed: map << 20 | rule << 12 | roomType),
// the same bits the server writes (server roomModel.ts generateSeed). Plain Deathmatch (rule 1) is the control.
//   node --test src/host/test/crossRules.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildGameData, buildHandshake, decodeActions, decodeServerGameData, encodeUserAction } from "../../net/matchUdp.ts";
import { MatchCore, type MatchData } from "../matchCore.ts";

const mapData = JSON.parse(readFileSync(new URL("../data/matchData.json", import.meta.url), "utf8")) as MatchData;
const WEAPONS = { primary: 100003001, secondary: 601002003, melee: 702001001, explosive: 803007001, special: 904007002 };
const SERVER_MATCH = { antiScript: false, checkLoadout: false, fireRateCap: false };
const HEAD = 14; // CharaHitPart.HEAD

/** Metro (map 36) room with the given rule: 2 respawned players, slot 0 shoots slot 1 */
function coreWithRule(rule: number, now: () => number, sent: Uint8Array[]): MatchCore {
  const key = { uniqueRoomId: (1 << 20) | 7, roomSeed: (36 << 20) | (rule << 12) | 4 };
  const core = new MatchCore({ send: (_p, d) => sent.push(d), game: () => {} }, { now, data: mapData, config: SERVER_MATCH });
  core.receive("a", buildHandshake(65, 0, 1, key));
  core.receive("b", buildHandshake(65, 1, 2, key));
  for (const [slot, acc] of [[0, 1], [1, 2]]) core.respawnSync({ ...key, startTick: now() - 8000, type: 0, round: 1, slot, respawnCount: 4, accountId: acc, charaId: 602002, weapons: WEAPONS, accessory: 0 });
  return core;
}

/** one hit from slot 0 on slot 1; returns the victim's hp in the relayed datagram (undefined = no hp record) */
function shoot(rule: number, damage: number, part: number): number | undefined {
  const sent: Uint8Array[] = [];
  let now = 1_000_000;
  const core = coreWithRule(rule, () => now, sent);
  now += 10;
  sent.length = 0;
  const key = { uniqueRoomId: (1 << 20) | 7, roomSeed: (36 << 20) | (rule << 12) | 4 };
  const hit = buildGameData({ slot: 0, time: 1, round: 0, respawn: 4, roundNumber: 0, accountId: 1, unk1: 0 },
    encodeUserAction(0, { hits: [{ start: [0, 1.5, 0], end: [1, 1.5, 0], victimSlot: 1, damage, part, objectType: 1, weaponId: WEAPONS.primary }] }), key);
  core.receive("a", hit);
  const acts = decodeActions(decodeServerGameData(sent[0])!.actions);
  return acts.find((a) => a.slot === 1 && a.hp !== undefined && !a.posRot)?.hp;
}

test("control: plain Deathmatch (rule 1) keeps the 33 damage of a body shot", () => {
  assert.equal(shoot(1, 33, 1), 67);
});

test("HeadHunter (rule 32): a body hit does 1 damage", () => {
  assert.equal(shoot(32, 33, 1), 99);
});

test("HeadHunter (rule 32): a headshot keeps its damage", () => {
  assert.equal(shoot(32, 33, HEAD), 67);
});

test("Chaos (rule 80): a body hit does 200 damage (one-shot)", () => {
  assert.equal(shoot(80, 33, 1), 0);
});
