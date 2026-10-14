// GIVEUP_BATTLE (5133) in a Bomb room (roomHandlers.ts handleGiveUpBattle): 1v1 ends the match for the one who stayed (5140 with
// exp / gold); 3 players: the leaver's side is wiped, so the round ends (5155) and the leaver leaves the slot list.   node --test test/giveUpBomb.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleGiveUpBattle } from "../src/game/roomHandlers.ts";
import { SlotState, RoomState } from "../src/game/roomModel.ts";
import { battleRoom } from "./fakeRoom.ts";
import { config } from "../src/config.ts";
import type { GameClient } from "../src/game/gameServer.ts";

const client = (acc: unknown) => ({ player: acc, session: { send: () => {} } } as unknown as GameClient);
const DEAD = 2; // DeadEnum.Dead (roomModel): Alive = 1 is the default, a fighter who died this round has Dead

/** the account fields calculateResult / 5140 / 5134 read (no DB: the dao writes are fire-and-forget) */
const prep = (f: ReturnType<typeof battleRoom>) => {
  for (const a of f.accounts) f.room.actors.add(a.playerId); // rewardScale: HUMANS_FACTOR[actors] (empty = 0 exp)
  config.server.EnableMissions = false; // progress.ts reads the mission clone the fixture does not model
  for (const a of f.accounts) Object.assign(a, {
    statistic: {}, exp: 1000, gold: 500, cash: 0, tags: 0, rank: 10, cafePC: 0, bonus: { bonuses: 0 }, clanAccess: 0,
    mission: { actualMission: 0, at: () => ({ cardSetId: 0, progress: 0, currentCard: 0 }) },
    equipment: { charaRedId: 0, charaBlueId: 0, dinoItem: 0, sprayId: 0, nameCardId: 0 },
    character: { getCharacter: () => null }, inventory: { items: [], getItem: () => null }, clan: { id: 0, name: "", rank: 0, unit: 0, logo: 0, nameColor: 0, effect: 0 },
    nickname: "P", getRank: () => 10, getDisplayRank: () => 10, isGM: () => false, event: { lastPlaytimeFinish: 0, lastPlaytimeValue: 0 }, inventoryPlus: 0,
  });
};

test("1v1 bomb: the CT player gives up while dead -> the FR player that stayed gets 5140 ENDBATTLE (exp / gold), room back to READY", () => {
  const f = battleRoom(2);
  prep(f);
  f.room.roomType = 8; f.room.killTime = 0x13; f.room.rounds = 1;
  f.room.slots[1].deathState = DEAD;
  handleGiveUpBattle(client(f.accounts[1]));
  const end = f.ops(5140, f.accounts[0].playerId);
  assert.equal(end.length, 1, "stayer gets 5140");
  assert.ok(end[0].bytes.length > 100, "5140 carries the result table (exp / gold)");
  assert.equal(f.room.state, RoomState.READY, "room back to READY (not stuck in BATTLE)");
  f.room.stopTimers(); f.room.stopBomb();
});

test("3 players bomb (FR 0, CT 1 alive, CT 3 dead): CT 1 gives up -> CT side wiped, round ends for FR, leaver out of the list", () => {
  const f = battleRoom(4);
  prep(f);
  f.room.roomType = 8; f.room.killTime = 0x13; f.room.rounds = 1;
  f.room.slots[3].deathState = DEAD;
  handleGiveUpBattle(client(f.accounts[1]));
  assert.equal(f.room.slots[1].state, SlotState.NORMAL, "leaver's slot leaves BATTLE (slot info below LOAD)");
  assert.equal(f.room.state, RoomState.BATTLE, "3 humans: match goes on");
  assert.equal(f.ops(5155).length, 3, "round end (5155) to the 3 players still in BATTLE (0, 2, 3)");
  assert.equal(f.room.frRounds, 1, "FR won the round");
  f.room.stopTimers(); f.room.stopBomb();
});

