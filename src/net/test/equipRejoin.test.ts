// A peer leaves the match and comes back with another character / equipment: the others must get the NEW equipment
// (battle.ts asks the server 3666 -> 3667 when a slot reappears; a missed 5138 no longer leaves the default model on it).
import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as any).fetch = async () => ({ json: async () => ({ weapons: [] }) });
const { PbBattleNet } = await import("../battle.ts");
import type { RespawnAck } from "../metaGame.ts";
import type { PlayerState } from "../../game/netAdapter";

const FEMALE = 602009, MALE = 601001;
const ackOf = (slot: number, chara: number, head = 0, beret = 0): RespawnAck => ({
  slot, roomSpawns: 1, slotSpawns: 1, weapons: { primary: 100003001, secondary: 0, melee: 0, grenade: 0, special: 0 }, chara, parts: [head, 0, 0, 0, 0, 0, 0, 0], beret, accessory: 0,
});

function setup() {
  const slots = Array.from({ length: 18 }, (_, slot) => ({ slot, nick: slot < 2 ? `P${slot}` : "", state: slot < 2 ? 19 : 0, team: slot % 2, rank: 0 }));
  const asked: number[] = [];
  const equipOf = new Map<number, RespawnAck>(); // what Server.Game answers a 3666 with (the slot's current equipment)
  const room: any = {
    mySlot: 0, slots, room: null, onDeath: null, onRespawnAck: null, leaderSlot: 0,
    requestEquip(slot: number) { asked.push(slot); const a = equipOf.get(slot); if (a) setImmediate(() => room.onRespawnAck?.(a)); }, // 3667 handler
  };
  const net = new PbBattleNet({
    session: { uniqueRoomId: 1, roomSeed: 1, slot: 0, accountId: 1, signalTicket: "t" } as any,
    roster: [{ slot: 0, name: "P0", team: 0 }, { slot: 1, name: "P1", team: 1 }], room,
  }) as any;
  const seen: PlayerState[] = [];
  const left: string[] = [];
  net.onRemoteState((s: PlayerState) => seen.push(s));
  net.onRemoteLeave((id: string) => left.push(id));
  const record = (slot: number) => net.onActions([{ slot, flags: 0, posRot: { x: 1, y: 0, z: 2, yaw: 0, pitch: 0, area: 0 }, hp: 100, actionState: { action: 0, value: 0, weaponFlag: 0 } }]);
  return { net, room, slots, asked, equipOf, seen, left, record };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test("B learns A's new character when A leaves and re-enters with other equipment", async () => {
  const { net, room, slots, asked, equipOf, seen, left, record } = setup();
  // first stay: A (slot 1) wears the female character; 5138 reaches B
  room.onRespawnAck(ackOf(1, FEMALE, 701002, 0));
  record(1);
  assert.equal(net.latest(1).chara, FEMALE);
  // A leaves: the slot drops below LOAD, B's tick reports the leave
  slots[1].state = 0; slots[1].nick = "";
  net.tick();
  assert.deepEqual(left, ["slot1"]);
  // A comes back wearing another character; this time B's 5138 never arrives (only the slot's records do)
  slots[1].state = 19; slots[1].nick = "P1";
  equipOf.set(1, ackOf(1, MALE, 0, 2700013));
  asked.length = 0;
  record(1);
  assert.deepEqual(asked, [1], "the reappearing slot is asked for its equipment (3666)");
  assert.equal(net.latest(1).chara, FEMALE, "stale until the answer lands");
  await tick();
  record(1);
  assert.equal(net.latest(1).chara, MALE, "the next record carries the new character");
  net.dispose();
});

test("a remote whose character stays unknown is asked again every 3 s, a known one is not", async () => {
  const { net, asked, equipOf, record } = setup();
  record(1);
  asked.length = 0;
  net.equipAskAt = 0;
  net.tick();
  assert.deepEqual(asked, [1], "unknown character: asked");
  asked.length = 0;
  net.equipAskAt = 0;
  equipOf.set(1, ackOf(1, FEMALE));
  net.room.onRespawnAck(ackOf(1, FEMALE));
  net.tick();
  assert.deepEqual(asked, [], "known character: not asked");
  net.dispose();
});

test("bots are never asked (no account behind an AI seat)", () => {
  const { net, asked } = setup();
  net.botSlots.add(7);
  net.onActions([{ slot: 7, flags: 0, posRot: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, area: 0 }, hp: 100, actionState: { action: 0x8000, value: 0, weaponFlag: 0 } }]);
  net.equipAskAt = 0;
  net.tick();
  assert.ok(!asked.includes(7));
  net.dispose();
});
