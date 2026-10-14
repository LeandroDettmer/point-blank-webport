// Vote kick (voteKick.ts): the rules of AllUtils.VotekickResult and the improvements of, offline (fake room).
//   node --test test/voteKick.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { KICK_ERR, KICK_RESULT, castKickVote, deps, kickVoteResult, startKickVote } from "../src/game/voteKick.ts";
import { activeVote, clearVote } from "../src/game/voteCommon.ts";
import { battleEndHooks, RoomState, SlotState } from "../src/game/roomModel.ts";
import { battleRoom, manualClock, u32, type Fixture } from "./fakeRoom.ts";

let mc: ReturnType<typeof manualClock>;
const calls = { removed: [] as number[], kicked: [] as number[], handoff: [] as number[] };
beforeEach(() => {
  mc = manualClock();
  calls.removed.length = 0; calls.kicked.length = 0; calls.handoff.length = 0;
  deps.removePlayer = (r, p) => { calls.removed.push(p.slotId); const s = r.slots[p.slotId]; s.state = SlotState.NORMAL; s.playerId = 0n; p.room = null; p.slotId = -1; };
  deps.kickSlot = (_k, slot) => { calls.kicked.push(slot); };
  deps.handoffHost = (_k, slot) => { calls.handoff.push(slot); };
});

const vote = (f: Fixture, slot: number, yes: boolean) => castKickVote(f.accounts[slot], yes);
// 6 humans: slots 0,2,4 = team 0; 1,3,5 = team 1. Slot 0 proposes to kick slot 1: allies of the target = team 1, enemies = team 0.

test("passes: accept > deny, a yes from an ally AND from an enemy, quorum", () => {
  const f = battleRoom(6);
  assert.equal(startKickVote(f.accounts[0], 1, 0), 0);
  assert.equal(f.ops(5191, f.accounts[0].playerId).length, 0, "ack is sent by the handler, not by startKickVote");
  // 5193 START goes to the BATTLE slots except creator and target
  assert.deepEqual(f.ops(5193).map((x) => Number(x.to) - 100).sort(), [2, 3, 4, 5]);
  assert.deepEqual([...f.ops(5193)[0].bytes.subarray(2, 5)], [0, 1, 0]);
  assert.equal(vote(f, 2, true), 0); // enemy of the target
  assert.equal(vote(f, 3, true), 0); // ally of the target
  assert.equal(f.ops(5201).length > 0, true, "running count 5201 {accept, deny}");
  assert.equal(vote(f, 4, false), 0);
  assert.equal(vote(f, 5, false), 0); // all 6 voted: closes at once
  // accept = 1 (creator) + 2 = 3, deny = 1 (target) + 2 = 3: not accept > deny
  const res = f.ops(5197)[0];
  assert.equal(u32(res.bytes, 5), KICK_RESULT.rejected);
  assert.equal(calls.removed.length, 0);
  assert.equal(activeVote(f.room), null);
});

test("passes and kicks: P2P layer told, victim barred from the room", () => {
  const f = battleRoom(6);
  startKickVote(f.accounts[0], 1, 1);
  vote(f, 2, true); vote(f, 3, true); vote(f, 4, true); vote(f, 5, false);
  // accept 4 (1 + 3) vs deny 2: all voted, passes
  assert.deepEqual(calls.removed, [1]);
  assert.deepEqual(calls.kicked, [1]);
  assert.equal(f.ops(5203, 101n).length, 1, "5203 to the kicked player");
  assert.deepEqual(f.room.kickedPlayersVote, [101n], "KickedPlayersVote: ROOM_JOIN refuses him (0x8000100c)");
  const res = f.ops(5197)[0];
  assert.deepEqual([...res.bytes.subarray(2, 5)], [1, 4, 2]);
  assert.equal(u32(res.bytes, 5), 0, "err 0 = kicked");
  assert.equal(f.ops(5197, 101n).length, 0, "result is not sent to the kicked player");
});

test("fails with only one team voting (no allies of the target / no enemies)", () => {
  const f = battleRoom(6);
  startKickVote(f.accounts[0], 1, 0);
  vote(f, 2, true); vote(f, 4, true); // both enemies of the target
  mc.advance(20000);
  const res = f.ops(5197)[0];
  assert.equal(u32(res.bytes, 5), KICK_RESULT.noAllies);
  assert.equal(calls.removed.length, 0);
  const g = battleRoom(6);
  startKickVote(g.accounts[0], 1, 0);
  vote(g, 3, true); vote(g, 5, true); // both allies of the target
  mc.advance(20000);
  assert.equal(u32(g.ops(5197)[0].bytes, 5), KICK_RESULT.noEnemies);
});

test("errors: rank, already voting, cooldown, few players, bots, protected, not in battle", () => {
  const low = battleRoom(6, { rank: 2 });
  assert.equal(startKickVote(low.accounts[0], 1, 0), KICK_ERR.rank);
  const f = battleRoom(6);
  assert.equal(startKickVote(f.accounts[0], 0, 0), KICK_ERR.fail, "not yourself");
  assert.equal(startKickVote(f.accounts[0], 9, 0), KICK_ERR.fail, "empty slot");
  assert.equal(startKickVote(f.accounts[0], 1, 0), 0);
  assert.equal(startKickVote(f.accounts[2], 3, 0), KICK_ERR.active, "one vote per room");
  assert.equal(vote(f, 1, true), KICK_ERR.voted, "the target already counts as voted");
  assert.equal(vote(f, 0, true), KICK_ERR.voted);
  mc.advance(20000); // window over
  assert.equal(activeVote(f.room), null);
  assert.equal(startKickVote(f.accounts[0], 3, 0), KICK_ERR.cooldown, "1 min cooldown of the slot");
  mc.advance(40001);
  assert.equal(startKickVote(f.accounts[0], 3, 0), 0, "free again after a minute");
  const few = battleRoom(3);
  assert.equal(startKickVote(few.accounts[0], 1, 0), KICK_ERR.fewPlayers);
  const bots = battleRoom(6);
  for (const i of [2, 3, 4, 5]) { bots.room.slots[i].playerId = 0n; } // slots in BATTLE without a player = bots
  assert.equal(startKickVote(bots.accounts[0], 1, 0), KICK_ERR.fewPlayers, "bots do not count as human players");
  assert.equal(startKickVote(bots.accounts[0], 3, 0), KICK_ERR.fail, "a bot cannot be the target");
  const gmT = battleRoom(6);
  (gmT.accounts[1] as unknown as { isGM: () => boolean }).isGM = () => true;
  assert.equal(startKickVote(gmT.accounts[0], 1, 0), KICK_ERR.protectedTarget);
  const lobby = battleRoom(6);
  lobby.room.state = RoomState.READY;
  assert.equal(startKickVote(lobby.accounts[0], 1, 0), KICK_ERR.fail);
});

test("only slots still in BATTLE count as in game", () => {
  const f = battleRoom(6);
  startKickVote(f.accounts[0], 1, 0);
  f.room.slots[4].state = SlotState.NORMAL; // gave up before voting
  f.room.slots[5].state = SlotState.NORMAL;
  assert.equal(vote(f, 4, true), KICK_ERR.fail, "a slot that left the battle cannot vote");
  vote(f, 2, true); // enemy
  vote(f, 3, true); // ally: 4 humans left in BATTLE, all voted -> closes
  assert.deepEqual(calls.removed, [1], "accept 3 vs deny 1, ally + enemy yes, all remaining voted");
});

test("cancelled (5199) when the target or the creator leaves", async () => {
  const { slotLeftHooks } = await import("../src/game/roomModel.ts");
  const f = battleRoom(6);
  startKickVote(f.accounts[0], 1, 0);
  f.clear();
  for (const h of slotLeftHooks) h(f.room, 3); // an ordinary voter leaving does not cancel
  assert.equal(f.ops(5199).length, 0);
  for (const h of slotLeftHooks) h(f.room, 1); // the target
  assert.equal(f.ops(5199).length, 5 + 1, "5199 to every slot still in BATTLE");
  assert.equal(activeVote(f.room), null);
  assert.equal(mc.pending(), 0, "timer cleared");
  const g = battleRoom(6);
  g.room.slots[0].playerId = g.accounts[0].playerId;
  startKickVote(g.accounts[0], 1, 0);
  g.clear();
  for (const h of slotLeftHooks) h(g.room, 0); // the creator
  assert.equal(g.ops(5199).length > 0, true);
});

test("timeout: the 20 s timer closes the vote with what it has", () => {
  const f = battleRoom(6);
  startKickVote(f.accounts[0], 1, 0);
  vote(f, 2, true); vote(f, 3, true); // ally + enemy yes: accept 3 > deny 1, 4 of 6 voted >= 6 / 2
  assert.equal(f.ops(5197).length, 0, "still open");
  mc.advance(19999);
  assert.equal(f.ops(5197).length, 0);
  mc.advance(2);
  assert.equal(f.ops(5197).length > 0, true);
  assert.deepEqual(calls.removed, [1]);
  assert.equal(mc.pending(), 0);
});

test("timeout without enough votes: not kicked", () => {
  const f = battleRoom(8);
  startKickVote(f.accounts[0], 1, 0);
  vote(f, 2, true);
  vote(f, 3, true);
  // votes: creator, target, 2, 3 = 4 >= 8 / 2 = 4 and ally + enemy: passes at exactly the quorum
  mc.advance(20000);
  assert.deepEqual(calls.removed, [1]);
  const g = battleRoom(8);
  startKickVote(g.accounts[0], 1, 0);
  vote(g, 2, true); // only an enemy: 3 votes < 4 and no ally
  mc.advance(20000);
  assert.equal(calls.removed.length, 1, "unchanged");
  assert.equal(u32(g.ops(5197)[0].bytes, 5), KICK_RESULT.noAllies);
});

test("victim = leader: the best-ping player gets the room first (SLOTINFO + 5149 + host role), then he is removed", () => {
  const f = battleRoom(6);
  f.room.leader = 1;
  // slot 3 reports the best pings about the others
  const b = new Uint8Array(16).fill(255);
  b[0] = 80; b[2] = 60; b[4] = 90; b[5] = 120;
  f.room.pingReports.set(3, b);
  startKickVote(f.accounts[0], 1, 0);
  vote(f, 2, true); vote(f, 3, true); vote(f, 4, true); vote(f, 5, true);
  assert.equal(f.room.leader, 2, "slot 2 has the best ping");
  assert.deepEqual(calls.removed, [1]);
  assert.equal(f.ops(5149).length > 0, true, "5149 LEAVE_P2P with the new leader");
  assert.equal(u32(f.ops(5149)[0].bytes, 2), 2);
});

test("battle end clears the vote, its timer and the cooldowns", () => {
  const f = battleRoom(6);
  startKickVote(f.accounts[0], 1, 0);
  for (const h of battleEndHooks) h(f.room);
  assert.equal(activeVote(f.room), null);
  assert.equal(mc.pending(), 0);
  assert.equal(startKickVote(f.accounts[0], 1, 0), 0, "cooldown gone with the match");
  clearVote(f.room);
  assert.equal(kickVoteResult.length, 2);
});
