// A GM observer that joins hidden (RoomModel.addStealthPlayer, seat 16 / 17): only GM accounts get its slot, normal accounts never see it.
//   node --test test/stealthGm.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SlotState } from "../src/game/roomModel.ts";
import { battleRoom, fakeAccount } from "./fakeRoom.ts";

function withGm() {
  const f = battleRoom(3);
  const gm = fakeAccount(900, "StaffGM", f.sent, { gm: true });
  const gm2 = fakeAccount(901, "OtherGM", f.sent, { gm: true });
  (f.accounts as unknown[]).push(gm, gm2);
  f.room.slots[16].state = SlotState.EMPTY;
  assert.ok(f.room.addStealthPlayer(gm) >= 16);
  // the second GM sits as a normal (visible) player in slot 3
  gm2.slotId = 3; gm2.room = f.room;
  f.room.slots[3].playerId = gm2.playerId; f.room.slots[3].state = SlotState.NORMAL;
  f.room.buildSlotInfo = (hide) => Uint8Array.of(0xaa, hide ? 1 : 0);
  return { ...f, gm, gm2 };
}

test("the hidden GM sits in an observer seat as a GM spectator", () => {
  const { room, gm } = withGm();
  const s = room.slots[gm.slotId];
  assert.ok(s.id === 16 || s.id === 17);
  assert.deepEqual([s.specGM, s.stealth, s.viewType], [true, true, 2]);
});

test("slot list: GM accounts get it whole, everybody else without the hidden observer", () => {
  const f = withGm();
  f.clear();
  f.room.updateSlotsInfo();
  const flag = (pid: bigint) => f.sent.filter((x) => x.to === pid).map((x) => x.bytes[1]);
  assert.deepEqual(flag(100n), [1], "normal player: hideStealth");
  assert.deepEqual(flag(f.gm.playerId), [0], "the hidden GM itself");
  assert.deepEqual(flag(f.gm2.playerId), [0], "another GM");
});

test("per-slot packets about the hidden GM reach GM accounts only", () => {
  const f = withGm();
  f.clear();
  f.room.sendAboutSlot(f.gm.slotId, Uint8Array.of(1, 2));
  const to = new Set(f.sent.map((x) => x.to));
  assert.deepEqual([...to].sort(), [900n, 901n]);
  f.clear();
  f.room.sendAboutSlot(0, Uint8Array.of(1, 2)); // a normal slot goes to everybody
  assert.equal(new Set(f.sent.map((x) => x.to)).size, 5);
});

test("head count skips the hidden GM; the hidden GM never becomes the leader", () => {
  const f = withGm();
  assert.equal(f.room.getCountPlayers(), 5);
  assert.equal(f.room.getVisiblePlayers(), 4);
  f.room.slots[f.gm.slotId].state = SlotState.BATTLE;
  for (const i of [0, 1, 2]) { f.room.slots[i].playerId = 0n; f.room.slots[i].state = SlotState.EMPTY; }
  f.room.slots[3].state = SlotState.EMPTY; f.room.slots[3].playerId = 0n;
  f.room.leader = -1;
  f.room.setNewLeader(-1, SlotState.EMPTY, -1, false);
  assert.equal(f.room.leader, -1, "only the observer is left: nobody to lead");
});

test("resetSlot (battle end / give-up) keeps the observer hidden; real slotInfoAck blanks it for a normal account", async () => {
  const rp = await import("../src/game/roomPackets.ts");
  const f = withGm();
  const s = f.room.slots[f.gm.slotId];
  s.state = SlotState.BATTLE;
  s.resetSlot(); // what resetBattleInfo / handleGiveUpBattle do
  assert.equal(s.stealth, true, "stealth survives resetSlot");
  s.state = SlotState.NORMAL;
  f.room.slots.forEach((x) => { if (x !== s) { x.playerId = 0n; x.state = SlotState.EMPTY; } }); // fake accounts have no rank / clan: only the observer is seated
  // opcode H + leader C, then 39-byte records for hidden / empty slots (`H 36`, C state, 10 + D + 22)
  const stateOf = (b: Uint8Array, slot: number) => b[3 + slot * 39 + 2];
  assert.equal(stateOf(rp.slotInfoAck(f.room, true), f.gm.slotId), SlotState.EMPTY, "normal account: observer slot EMPTY");
});

test("hidden GM READY during COUNTDOWN with mode 0 still ends specGM (never a combatant)", async () => {
  const { handleReadyBattle } = await import("../src/game/roomHandlers.ts");
  const { RoomState } = await import("../src/game/roomModel.ts");
  const { PacketReader, PacketWriter } = await import("../../src/net/packet.ts");
  const f = withGm();
  const s = f.room.slots[f.gm.slotId];
  f.room.slots.forEach((x) => { if (x.playerId > 0n && x !== s) x.state = SlotState.READY; });
  f.room.state = RoomState.COUNTDOWN;
  s.state = SlotState.NORMAL; s.specGM = false; // a seat that lost the flag
  const c = { player: f.gm, session: { send: () => {} } } as never;
  handleReadyBattle(c, new PacketReader(new PacketWriter().writeC(0).writeD(0).toBytes(), 0));
  assert.equal(s.specGM, true);
});
