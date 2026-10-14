// Leader vote in battle (voteLeader.ts) and its P2P host switch (web/signal.ts handoffHost / kickSlot), offline.
//   node --test test/voteLeader.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { LEADER_ERR, castLeaderVote, handoffLeader, pickBestLeader, pingOf, startLeaderVote } from "../src/game/voteLeader.ts";
import { KICK_ERR, startKickVote } from "../src/game/voteKick.ts";
import { activeVote } from "../src/game/voteCommon.ts";
import { config } from "../src/config.ts";
import { battleEndHooks, slotLeftHooks, SlotState } from "../src/game/roomModel.ts";
import { handleSignal, handoffHost, kickSlot, signalKey } from "../src/web/signal.ts";
import { mintSignalTicket } from "../src/web/signalTicket.ts";
import { battleRoom, manualClock, u32 } from "./fakeRoom.ts";

let mc: ReturnType<typeof manualClock>;
beforeEach(() => { mc = manualClock(); });

const pings = (f: ReturnType<typeof battleRoom>, from: number, v: Record<number, number>) => {
  const b = new Uint8Array(16).fill(255);
  for (const [k, x] of Object.entries(v)) b[Number(k)] = x;
  f.room.pingReports.set(from, b);
};

test("best ping: mean of the other slots' reports; unknown never wins; never the current leader", () => {
  const f = battleRoom(4);
  pings(f, 0, { 1: 50, 2: 30, 3: 200 });
  pings(f, 1, { 0: 10, 2: 40, 3: 100 });
  pings(f, 2, { 0: 20, 1: 60, 3: 120 });
  assert.equal(pingOf(f.room, 2), 35);
  assert.equal(pingOf(f.room, 3), 140);
  assert.equal(pickBestLeader(f.room), 2, "slot 0 leads and is skipped; 2 beats 1 (55) and 3");
  assert.equal(pickBestLeader(f.room, 2), 1);
  const g = battleRoom(4);
  pings(g, 0, { 1: 50 });
  assert.equal(pingOf(g.room, 3), 255);
  assert.equal(pickBestLeader(g.room), 1);
});

test("majority of the humans in BATTLE approves: leader, 5149 and the 9017 / 9019 broadcasts", () => {
  const f = battleRoom(5);
  pings(f, 1, { 0: 90, 2: 20, 3: 70, 4: 80 });
  let acked = 0;
  assert.equal(startLeaderVote(f.accounts[3], 255, () => { acked++; }), 0);
  assert.equal(acked, 1, "9011 ack goes out before the 9013 announcement");
  assert.deepEqual([...f.ops(9013)[0].bytes.subarray(2, 4)], [3, 2], "creator 3, best-ping target 2");
  assert.equal(f.ops(9013).length, 5, "to every human in BATTLE, creator and target included");
  assert.equal(castLeaderVote(f.accounts[1], true), 0);
  assert.equal(castLeaderVote(f.accounts[1], true), LEADER_ERR.voted);
  assert.deepEqual([...f.ops(9017).at(-1)!.bytes.subarray(2, 4)], [2, 0], "running count");
  assert.equal(f.room.leader, 0, "2 of 5: not yet");
  assert.equal(castLeaderVote(f.accounts[4], true), 0); // 3 of 5 = 50% + 1
  assert.equal(f.room.leader, 2);
  const res = f.ops(9019, f.accounts[0].playerId)[0];
  assert.deepEqual([...res.bytes.subarray(2, 5)], [2, 3, 0]);
  assert.equal(u32(res.bytes, 5), 0, "err 0 = approved");
  assert.equal(f.ops(5149, f.accounts[4].playerId).length, 1);
  assert.equal(activeVote(f.room), null);
});

test("rejected when the denials make a majority impossible, and on timeout", () => {
  const f = battleRoom(5);
  startLeaderVote(f.accounts[0], 2);
  castLeaderVote(f.accounts[1], false);
  castLeaderVote(f.accounts[3], false);
  assert.equal(f.ops(9019).length, 0, "2 no of 5: 3 yes still possible");
  castLeaderVote(f.accounts[4], false); // 3 no: cannot reach 3 yes
  assert.equal(u32(f.ops(9019)[0].bytes, 5), LEADER_ERR.rejected);
  assert.equal(f.room.leader, 0);
  const g = battleRoom(5);
  startLeaderVote(g.accounts[0], 2);
  castLeaderVote(g.accounts[1], true);
  mc.advance(20000);
  assert.equal(u32(g.ops(9019)[0].bytes, 5), LEADER_ERR.rejected, "2 yes of 5 at the end of the window");
  assert.equal(g.room.leader, 0);
});

test("rules: 4+ humans, cooldown 2 min, one vote at a time (shared with the kick vote), target in BATTLE, not the leader, ping <= 120", () => {
  const two = battleRoom(2);
  assert.equal(startLeaderVote(two.accounts[0], 255), LEADER_ERR.fewPlayers, "1v1: only the automatic failover");
  assert.equal(startLeaderVote(battleRoom(3).accounts[1], 2), LEADER_ERR.fewPlayers, "3 humans: 2 accounts of one player would take the host");
  const f = battleRoom(6);
  assert.equal(startLeaderVote(f.accounts[1], 0), LEADER_ERR.badTarget, "the leader is not a target");
  assert.equal(startLeaderVote(f.accounts[1], 9), LEADER_ERR.badTarget);
  f.room.slots[4].state = SlotState.NORMAL;
  assert.equal(startLeaderVote(f.accounts[1], 4), LEADER_ERR.badTarget, "not in BATTLE");
  assert.equal(startLeaderVote(f.accounts[1], 3), 0);
  assert.equal(startKickVote(f.accounts[2], 5, 0), KICK_ERR.active, "kick vote waits for the leader vote");
  assert.equal(startLeaderVote(f.accounts[2], 3), LEADER_ERR.active);
  mc.advance(20000);
  assert.equal(startLeaderVote(f.accounts[1], 3), LEADER_ERR.cooldown);
  mc.advance(100000);
  assert.equal(startLeaderVote(f.accounts[1], 3), 0, "2 min later");
  const hp = battleRoom(5);
  pings(hp, 1, { 2: 200, 3: 40 });
  assert.equal(startLeaderVote(hp.accounts[1], 2), LEADER_ERR.highPing);
  assert.equal(startLeaderVote(hp.accounts[1], 3), 0);
});

test("the kick vote's rank floor (PB_VOTE_MIN_RANK, GM bypass) with the same error code", () => {
  const low = battleRoom(5, { rank: config.voteMinRank - 1 });
  assert.equal(LEADER_ERR.rank, KICK_ERR.rank);
  assert.equal(startLeaderVote(low.accounts[1], 2), LEADER_ERR.rank);
  assert.equal(startKickVote(low.accounts[1], 2, 0), KICK_ERR.rank);
  assert.equal(activeVote(low.room), null);
  low.accounts[1].isGM = () => true;
  assert.equal(startLeaderVote(low.accounts[1], 2), 0, "a GM votes whatever the rank");
});

test("a kick vote blocks the leader vote; 9021 when the target leaves; battle end clears timers and cooldowns", () => {
  const f = battleRoom(5);
  startKickVote(f.accounts[0], 1, 0);
  assert.equal(startLeaderVote(f.accounts[2], 3), LEADER_ERR.active);
  for (const h of battleEndHooks) h(f.room);
  const g = battleRoom(5);
  startLeaderVote(g.accounts[0], 3);
  g.clear();
  for (const h of slotLeftHooks) h(g.room, 3);
  assert.equal(g.ops(9021).length, 5);
  assert.equal(activeVote(g.room), null);
  const h2 = battleRoom(5);
  startLeaderVote(h2.accounts[0], 3);
  for (const h of battleEndHooks) h(h2.room);
  assert.equal(mc.pending(), 0);
  assert.equal(startLeaderVote(h2.accounts[0], 3), 0);
});

// ---- web/signal.ts: one host per room, switched atomically -------------------------------------------------------------

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | null = null;
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = { code, reason };
    this.readyState = 3;
    queueMicrotask(() => this.emit("close"));
  }
}
const join = (key: string, role: string, slot: number) => {
  const ws = new FakeWs();
  handleSignal(ws as never, new URL(`http://x/signal?room=${key}&role=${role}&slot=${slot}`), () => {});
  ws.emit("message", JSON.stringify({ t: "auth", ticket: mintSignalTicket(key, slot, BigInt(100 + slot)) }), false);
  return ws;
};
const tick = () => new Promise((r) => setTimeout(r, 5));

test("signal: handoffHost detaches the old host at once (socket kept a grace) and reserves the role for the new leader", async () => {
  const key = signalKey(0x30001, 0xabc);
  const oldHost = join(key, "host", 0);
  const guest = join(key, "guest", 2);
  await tick();
  assert.equal(oldHost.closed, null);
  handoffHost(key, 2);
  assert.equal(oldHost.closed, null, "the detached host keeps its socket for the snapshot");
  assert.deepEqual(guest.sent.at(-1), { t: "host", online: false });
  // the detached host still relays its handoff snapshot to the new leader's guest socket, and only to it
  const other = join(key, "guest", 3);
  oldHost.emit("message", JSON.stringify({ t: "handoff", to: 2, x: "abc", i: 0, n: 1, blob: "AAAA" }), false);
  assert.deepEqual(guest.sent.at(-1), { t: "handoff", from: 0, x: "abc", i: 0, n: 1, blob: "AAAA" });
  assert.equal(other.sent.some((m) => m.t === "handoff"), false);
  other.close();
  const again = join(key, "host", 0); // the old host tries to take the role back
  assert.deepEqual(again.closed, { code: 4009, reason: "HOST_RESERVED" });
  const third = join(key, "host", 1);
  assert.deepEqual(third.closed, { code: 4009, reason: "HOST_RESERVED" });
  guest.close(); // the new leader drops its guest socket and re-hosts
  await tick();
  await new Promise((r) => setTimeout(r, 3100)); // grace over: the old host is closed
  assert.deepEqual(oldHost.closed, { code: 4010, reason: "HOST_HANDOFF" });
  const newHost = join(key, "host", 2);
  await tick();
  assert.equal(newHost.closed, null, "the reserved slot becomes the host");
  const late = join(key, "host", 1);
  assert.deepEqual(late.closed, { code: 4009, reason: "HOST_TAKEN" }, "still one host per room");
  newHost.close();
  await tick();
});

test("signal: kickSlot closes the guest, tells the host and bars the slot for a minute", async () => {
  const key = signalKey(0x30002, 0xdef);
  const host = join(key, "host", 0);
  const guest = join(key, "guest", 3);
  await tick();
  kickSlot(key, 3);
  assert.deepEqual(guest.closed, { code: 4003, reason: "KICKED" });
  assert.deepEqual(host.sent.at(-1), { t: "kick", slot: 3 });
  const back = join(key, "guest", 3);
  assert.deepEqual(back.closed, { code: 4003, reason: "KICKED" }, "a kicked slot cannot come back through /signal");
  const other = join(key, "guest", 4);
  await tick();
  assert.equal(other.closed, null);
  host.close();
  other.close();
  await tick();
});

test("handoffLeader on the room model: leader and 5149 to the humans in BATTLE", () => {
  const f = battleRoom(4);
  handoffLeader(f.room, 3);
  assert.equal(f.room.leader, 3);
  assert.equal(f.ops(5149).length, 4);
});
