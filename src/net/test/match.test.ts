// Match UDP codec vs vectors produced by the original C# (Udp121Cipher.cs + Bitwise.cs compiled
// verbatim with csc): C->S datagram decoded by AllUtils.TryDecryptUdp121GameData's logic, S->C
// datagram built by AllUtils.BaseWriteCode's logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildGameData, buildHandshake, decodeActions, decodeServerGameData, encodeUserAction, fromHalf, toHalf,
} from "../matchUdp.ts";
import { interpolate } from "../battle.ts";

const v = JSON.parse(readFileSync(new URL("./match-vectors.json", import.meta.url), "utf8"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

test("action record encoding is stable", () => {
  const act = encodeUserAction(3, {
    posRot: { x: 12.5, y: 1.75, z: -30.25, yaw: 1.2, pitch: -0.3, area: 0 }, hp: 100,
    hits: [{ start: [1, 2, 3], end: [4, 5, 6], victimSlot: 2, damage: 33, part: 14, weaponId: 100003001 }],
  });
  assert.equal(hex(act), v.actions);
});

test("C->S 121 game data: C# decrypts it back to our action stream + room trailer", () => {
  let seed = 1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const dg = buildGameData({ slot: 3, time: 5.25, round: 0, respawn: 1, roundNumber: 0, accountId: 42, unk1: 0 },
    bytes(v.actions), { uniqueRoomId: 0x00101005, roomSeed: 0x02401004 }, rnd);
  assert.equal(hex(dg), v.c2sDatagram);
  assert.equal(v.csharpDecodedPlain, v.actions);
  assert.equal(v.csharpTrailer, "05101000ff04104002"); // D uniqueRoomId, C 255, D roomSeed
});

test("S->C BaseWriteCode datagram decodes to the action stream", () => {
  const d = decodeServerGameData(bytes(v.s2cDatagram));
  assert.ok(d);
  assert.equal(d.header.opcode, 4);
  assert.equal(hex(d.actions), v.actions);
  const [a] = decodeActions(d.actions);
  assert.equal(a.slot, 3);
  assert.equal(a.hp, 100);
  assert.deepEqual([a.posRot!.x, a.posRot!.y, a.posRot!.z], [12.5, 1.75, -30.25]);
  assert.equal(a.hits![0].victimSlot, 2);
  assert.equal(a.hits![0].damage, 33);
  assert.equal(a.hits![0].part, 14);
});

test("121 handshake layout (AllUtils.IsUdp121Handshake)", () => {
  const h = buildHandshake(65, 1, 7, { uniqueRoomId: 0x00101005, roomSeed: 0x02401004 });
  assert.equal(h.length, 38);
  assert.equal(h[7] | (h[8] << 8), 38);
  assert.equal(hex(h.subarray(17)), "8c2e2834" + "14303c2b" + "e4050700" + "05101000" + "04104002" + "ff");
});

test("half floats", () => {
  for (const x of [0, 1, -1, 0.5, 12.5, -30.25, 100, 1000.5]) assert.ok(Math.abs(fromHalf(toHalf(x)) - x) <= Math.abs(x) / 1024);
});

test("interpolation between snapshots", () => {
  const base = { id: "slot1", name: "a", team: 0 as const, vel: [0, 0, 0] as [number, number, number], yaw: 0, pitch: 0, crouch: false, alive: true, hp: 100, weapon: "", firing: false, t: 0 };
  const buf = [{ at: 0, s: { ...base, pos: [0, 0, 0] as [number, number, number] } }, { at: 100, s: { ...base, pos: [10, 0, 0] as [number, number, number] } }];
  assert.equal(interpolate(buf, 50).pos[0], 5);
});
