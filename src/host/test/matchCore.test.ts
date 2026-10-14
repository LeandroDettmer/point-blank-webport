// The Server.Match port (src/host/matchCore.ts) against the vectors made by the original C# (src/net/test/match-vectors.json:
// Udp121Cipher.cs + Bitwise.cs + BaseWriteCode compiled with csc), and against the client codec.
//   node --test src/host/test/matchCore.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bitwiseDecrypt } from "../../net/bitwise.ts";
import { buildGameData, buildHandshake, buildPing, decodeActions, decodeServerGameData, encodeUserAction, type ActionIn, type ActionOut, type HitInfo } from "../../net/matchUdp.ts";
import { DEFAULT_CONFIG, MatchCore, type GameSyncOut, type MatchData } from "../matchCore.ts";

const v = JSON.parse(readFileSync(new URL("../../net/test/match-vectors.json", import.meta.url), "utf8"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const KEY = { uniqueRoomId: 0x00101005, roomSeed: 0x02401004 };
/** Settings.ini as deployed for the dedicated server (AntiScript = False): the port's own behaviour, nochecks */
const SERVER_MATCH = { antiScript: false, checkLoadout: false, fireRateCap: false };

test("BaseWriteCode + EncryptServerToClient reproduce the C# S->C datagram byte for byte", () => {
  const dg = bytes(v.s2cDatagram);
  const view = new DataView(dg.buffer);
  const time = view.getFloat32(2, true);
  const len = view.getUint16(7, true);
  const blob = bitwiseDecrypt(dg.slice(25, len), (len % 6) + 1);
  // the 7 random bytes: key2 (header off 13) + iv1, iv2, mix (blob head)
  const rnd = Uint8Array.from([...dg.subarray(13, 17), blob[0], blob[1], blob[2]]);
  const core = new MatchCore({ send() {} }, { cipherBytes: () => rnd });
  const out = core.baseWriteCode(dg[0], bytes(v.actions), dg[1], time, dg[6], dg[9], dg[10], dg[11]);
  assert.equal(hex(out), v.s2cDatagram);
});

test("a C# C->S datagram through register, respawn, damage and relay", () => {
  const sent: { peer: string; data: Uint8Array; rel: boolean }[] = [];
  const game: GameSyncOut[] = [];
  let now = 1_000_000;
  const core = new MatchCore({ send: (peer, data, rel) => sent.push({ peer, data, rel }), game: (m) => game.push(m) }, { now: () => now, config: SERVER_MATCH });
  // the vector's sender: slot 3, accountId 42, respawn 1; a victim in slot 2
  core.receive("pA", buildHandshake(65, 3, 42, KEY));
  core.receive("pB", buildHandshake(65, 2, 7, KEY));
  assert.deepEqual(sent.map((s) => [s.peer, s.data[0], s.rel]), [["pA", 66, true], ["pB", 66, true]]);
  // before any RespawnSync the room has no StartTime: game data is dropped (ProcessPVPPacket)
  core.receive("pA", bytes(v.c2sDatagram));
  assert.equal(sent.length, 2);
  for (const [slot, acc] of [[3, 42], [2, 7]]) core.respawnSync({ ...KEY, startTick: now - 5000, type: 0, round: 1, slot, respawnCount: 1, accountId: acc, charaId: 602002 });
  sent.length = 0;
  now += 10;
  core.receive("pA", bytes(v.c2sDatagram));
  assert.equal(sent.length, 1, "relayed to the other slot only");
  assert.equal(sent[0].peer, "pB");
  assert.equal(sent[0].rel, true, "hit + events ride the reliable channel");
  const dec = decodeServerGameData(sent[0].data)!;
  assert.equal(dec.header.slot, 255);
  const acts = decodeActions(dec.actions);
  const rec = acts.find((a) => a.slot === 3)!;
  // Method0 re-encodes the record: PosRotation gains SoundPosRotation (the packet time)
  assert.ok(rec.flags & 0x00800000);
  assert.deepEqual([rec.posRot!.x, rec.posRot!.y, rec.posRot!.z], [12.5, 1.75, -30.25]);
  assert.equal(rec.hits![0].damage, 33);
  // ObjectType.User hit: Server.Match applies it (100 - 33) and appends the events (PROTOCOL_EVENTS_ACTION type 2)
  const hp = acts.find((a: ActionIn) => a.slot === 2 && a.hp !== undefined && !a.posRot)!;
  assert.equal(hp.hp, 67);
  assert.equal(game.length, 0, "no death yet");
});

test("ping is echoed, unregister frees the slot, a wrong UDP version is refused", () => {
  const sent: { peer: string; data: Uint8Array }[] = [];
  const core = new MatchCore({ send: (peer, data) => sent.push({ peer, data }) });
  core.receive("p1", buildHandshake(65, 0, 1, KEY));
  const ping = buildPing(0, 1, KEY, 3);
  core.receive("p1", ping);
  assert.equal(hex(sent[1].data), hex(ping));
  core.receive("p1", buildHandshake(67, 0, 1, KEY));
  assert.equal(core.getRoom(KEY.uniqueRoomId, KEY.roomSeed), null, "last player out removes the room");
  const bad = new MatchCore({ send: (peer, data) => sent.push({ peer, data }) }, { config: { udpVersion: "1508.7" } });
  const n = sent.length;
  bad.receive("p1", buildHandshake(65, 0, 1, KEY));
  assert.equal(sent.length, n);
});

test("a stale respawn counter makes the shooter's User hits invalid (RespawnIsValid)", () => {
  const sent: Uint8Array[] = [];
  const core = new MatchCore({ send: (_p, d) => sent.push(d) }, { config: SERVER_MATCH });
  core.receive("a", buildHandshake(65, 0, 1, KEY));
  core.receive("b", buildHandshake(65, 1, 2, KEY));
  for (const [slot, acc] of [[0, 1], [1, 2]]) core.respawnSync({ ...KEY, startTick: Date.now() - 1000, type: 0, round: 1, slot, respawnCount: 4, accountId: acc });
  const hit = (respawn: number) => buildGameData({ slot: 0, time: 1, round: 0, respawn, roundNumber: 0, accountId: 1, unk1: 0 },
    encodeUserAction(0, { hits: [{ start: [0, 0, 0], end: [1, 0, 0], victimSlot: 1, damage: 10, part: 1, objectType: 1, weaponId: 100003001 }] }), KEY);
  sent.length = 0;
  core.receive("a", hit(3));
  const stale = decodeActions(decodeServerGameData(sent[0])!.actions);
  assert.equal(stale.find((a) => a.slot === 0)!.hits!.length, 0, "hit removed");
  assert.ok(!stale.some((a) => a.slot === 1));
  sent.length = 0;
  core.receive("a", hit(4));
  const ok = decodeActions(decodeServerGameData(sent[0])!.actions);
  assert.equal(ok.find((a) => a.slot === 1 && a.hp !== undefined)!.hp, 90);
});

// ---- host handoff: MatchCore.snapshot() / restore()

const mapData = JSON.parse(readFileSync(new URL("../data/matchData.json", import.meta.url), "utf8")) as MatchData;
// Metro TDM seed (map 36, rule 1, DeathMatch 4): MapStructure objects load at the first respawn
const MAP_KEY = { uniqueRoomId: (1 << 20) | 7, roomSeed: (36 << 20) | (1 << 12) | 4 };
const WEAPONS = { primary: 100003001, secondary: 601002003, melee: 702001001, explosive: 803007001, special: 904007002 };
const norm = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** a core with 2 registered, respawned players; slot 1 took a 30 damage hit from slot 0 */
function playedCore(now: () => number, sent: { peer: string; data: Uint8Array }[], game: GameSyncOut[] = []): MatchCore {
  const core = new MatchCore({ send: (peer, data) => sent.push({ peer, data }), game: (m) => game.push(m) }, { now, data: mapData, config: SERVER_MATCH });
  core.receive("a", buildHandshake(65, 0, 1, MAP_KEY));
  core.receive("b", buildHandshake(65, 1, 2, MAP_KEY));
  for (const [slot, acc] of [[0, 1], [1, 2]]) core.respawnSync({ ...MAP_KEY, startTick: now() - 8000, type: 0, round: 1, slot, respawnCount: 4, accountId: acc, charaId: 602002, weapons: WEAPONS, accessory: 0 });
  return core;
}
const userHit = (from: number, victim: number, damage: number, accountId: number, respawn = 4) =>
  buildGameData({ slot: from, time: 1, round: 0, respawn, roundNumber: 0, accountId, unk1: 0 },
    encodeUserAction(from, { hits: [{ start: [0, 1.5, 0], end: [1, 1.5, 0], victimSlot: victim, damage, part: 1, objectType: 1, weaponId: WEAPONS.primary }] }), MAP_KEY);
const hpOf = (out: Uint8Array, slot: number) => decodeActions(decodeServerGameData(out)!.actions).find((a) => a.slot === slot && a.hp !== undefined && !a.posRot)?.hp;

test("snapshot() is JSON / structured-clone safe and restore() gives back the same state", () => {
  const sent: { peer: string; data: Uint8Array }[] = [];
  const now = () => 2_000_000;
  const a = playedCore(now, sent);
  a.receive("a", userHit(0, 1, 30, 1));
  assert.equal(a.rooms[0].players[1].life, 70);
  a.rooms[0].players[1].position = { x: 0x3c00, y: 0x4000, z: 0x4200 };
  a.rooms[0].bombPosition = { x: 1, y: 2, z: 3 };
  a.rooms[0].hasC4 = true;
  a.rooms[0].dropCounter = 9;

  const snap = a.snapshot();
  assert.equal(snap.v, 1);
  assert.deepEqual(norm(snap), snap, "survives JSON (no Map / undefined / class instance)");
  assert.deepEqual(structuredClone(snap), snap, "survives structuredClone (postMessage to the Worker)");
  const room = snap.rooms[0];
  assert.ok(room.objects.length > 0 && room.objects.every((o) => o.model), "the map objects of MapStructure.xml are in it");
  assert.equal(room.players[1].life, 70);
  assert.equal(room.players[1].maxLife, 100);
  assert.equal(room.players[1].dead, false);
  assert.equal(room.players[0].equip!.wpnPrimary, WEAPONS.primary);
  assert.equal(room.players[1].respawnByServer, 4);
  assert.deepEqual([room.players[0].connected, room.players[1].connected, room.players[2].connected], [true, true, false]);

  const b = new MatchCore({ send() {} }, { now, data: mapData });
  const r = b.restore(structuredClone(snap));
  assert.deepEqual(r.slots, [0, 1]);
  assert.equal(r.startTick, room.lastStartTick);
  assert.deepEqual(b.snapshot(), snap, "restore -> snapshot is the identity");
  assert.ok(b.rooms[0].players.every((p) => p.client === null), "no peer is carried over: guests register again");
  assert.ok(b.rooms[0].objects.filter((o) => o.model).length === room.objects.length, "object models are tied to the map again");
  assert.throws(() => b.restore(snap), /fresh core/);
  assert.throws(() => new MatchCore({ send() {} }).restore({ ...snap, v: 99 }), /version 99/);
});

test("a tick after restore behaves like the original core (hp kept through the re-register, damage continues)", () => {
  const sentA: { peer: string; data: Uint8Array }[] = [];
  const a = playedCore(() => 3_000_000, sentA);
  a.receive("a", userHit(0, 1, 30, 1));
  const snap = a.snapshot();

  // the new host: a fresh core from the snapshot, then the guests REGISTER (65) from their new links
  const sentB: { peer: string; data: Uint8Array }[] = [];
  const b = new MatchCore({ send: (peer, data) => sentB.push({ peer, data }) }, { now: () => 3_000_000, data: mapData, config: SERVER_MATCH });
  b.restore(snap);
  b.receive("x", buildHandshake(65, 0, 1, MAP_KEY));
  b.receive("y", buildHandshake(65, 1, 2, MAP_KEY));
  assert.deepEqual(sentB.map((s) => [s.peer, s.data[0]]), [["x", 66], ["y", 66]], "CONNECT to both");
  const pb = b.rooms[0].players;
  assert.equal(pb[1].life, 70, "the re-register did not reset the restored slot (ProcessUnregister_65's !Integrity reset)");
  assert.equal(pb[1].respawnByServer, 4);
  assert.equal(pb[0].client, "x");

  // the same next hit on both cores: same outcome (70 - 30 = 40)
  sentA.length = 0; sentB.length = 0;
  a.receive("a", userHit(0, 1, 30, 1));
  b.receive("x", userHit(0, 1, 30, 1));
  assert.equal(hpOf(sentA.find((s) => s.peer === "b")!.data, 1), 40);
  assert.equal(hpOf(sentB.find((s) => s.peer === "y")!.data, 1), 40, "restored core: 70 -> 40, not 100 -> 70");
  // and a kill reaches Game from the restored core
  const game: GameSyncOut[] = [];
  (b as unknown as { out: { game: (m: GameSyncOut) => void } }).out.game = (m) => game.push(m);
  b.receive("x", userHit(0, 1, 60, 1));
  assert.equal(b.rooms[0].players[1].dead, true);
  assert.equal(game.find((g) => g.t === "death")?.t, "death");
  // a hit with a stale respawn counter is still refused (RespawnIsValid state survived)
  sentB.length = 0;
  b.receive("y", userHit(1, 0, 10, 2, 3));
  assert.equal(b.rooms[0].players[0].life, 100);
});

test("restore() keeps ages, not clocks: the new host's clock may be anywhere", () => {
  let nowA = 5_000_000;
  const a = playedCore(() => nowA, []);
  nowA += 1500;
  const snap = a.snapshot();
  const b = new MatchCore({ send() {} }, { now: () => 90_000_000, data: mapData });
  const r = b.restore(snap);
  const s2 = b.snapshot();
  assert.equal(s2.now, 90_000_000);
  assert.equal(s2.now - s2.rooms[0].startTime, snap.now - snap.rooms[0].startTime, "StartTime is as old as before");
  assert.equal(r.startTick, s2.rooms[0].lastStartTick);
  const withUse = snap.rooms[0].objects.find((o) => o.useDate !== 0);
  if (withUse) assert.equal(s2.now - s2.rooms[0].objects.find((o) => o.id === withUse.id)!.useDate, snap.now - withUse.useDate, "object animation clocks keep their age");
  assert.equal(s2.rooms[0].lastObjsSync === 0, snap.rooms[0].lastObjsSync === 0);
});

test("a RESPAWN_ACK parked for an unregistered slot survives the handoff", () => {
  const a = new MatchCore({ send() {} }, { now: () => 7_000_000, data: mapData });
  a.receive("a", buildHandshake(65, 0, 1, MAP_KEY));
  a.respawnSync({ ...MAP_KEY, startTick: 6_990_000, type: 0, round: 1, slot: 1, respawnCount: 2, charaId: 602002, weapons: WEAPONS }); // slot 1 not registered: parked
  const snap = a.snapshot();
  assert.equal(snap.pendingRespawn.length, 1);
  const b = new MatchCore({ send() {} }, { now: () => 7_000_500, data: mapData });
  b.restore(snap);
  b.receive("y", buildHandshake(65, 1, 2, MAP_KEY));
  assert.equal(b.rooms[0].players[1].respawnByServer, 2, "applied on register, as in the original core");
});

// ----anti-cheat: every rule lets an honest case through and
// drops a forged one. The web client's hits are ObjectType.UserObject: Server.Match relays them untouched and the victim
// applies them, so a dropped hit is one missing from the relayed record.

const ST = mapData.itemStats!;
const K2 = 103004, K2_SAME_NAME = 103047, CHEYTAC = 105030, SHOTGUN = 106001, JACKHAMMER = 106019, UZI = 118004;
const MK23_DUAL = 214001, M7 = 301001, KRISS = 104013, KRISS_DUAL = 118001, PISTOL = 202022, K400 = 407001;
type Hit = { victim: number; damage: number; part?: number; weapon: number; objectType?: number };
const webHit = (h: Hit): HitInfo => ({ start: [0, 1.5, 0], end: [0, 1.5, 0], victimSlot: h.victim, damage: h.damage, part: h.part ?? 1,
  objectType: h.objectType ?? 2, weaponId: h.weapon });
const concat = (parts: Uint8Array[]) => {
  const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { o.set(p, i); i += p.length; }
  return o;
};
type Loadout = Partial<{ primary: number; secondary: number; melee: number; explosive: number; special: number }>;

/** a P2P core as runtime.ts builds it: peer "host" = the leader's own link (slot 0), "g<slot>" = a guest */
class Bench {
  t = 20_000_000;
  sent: { peer: string; data: Uint8Array }[] = [];
  kicks: string[] = [];
  warns: string[] = [];
  readonly core: MatchCore;
  readonly key: typeof MAP_KEY;
  constructor(key = MAP_KEY, config: Partial<typeof DEFAULT_CONFIG> = {}) {
    this.key = key;
    this.core = new MatchCore({ send: (peer, data) => this.sent.push({ peer, data }), kick: (peer) => this.kicks.push(peer), warn: (l) => this.warns.push(l) },
      { now: () => this.t, data: mapData, hostPeer: (p) => p === "host", config });
  }
  peer(slot: number): string { return slot === 0 ? "host" : `g${slot}`; }
  join(slot: number, w: Loadout = {}): void {
    this.core.receive(this.peer(slot), buildHandshake(65, slot, slot + 1, this.key));
    this.core.respawnSync({ ...this.key, startTick: 15_000_000, type: 0, round: 1, slot, respawnCount: 1, accountId: slot + 1, charaId: 602002,
      weapons: { primary: 0, secondary: 0, melee: 0, explosive: 0, special: 0, ...w } });
  }
  /** one datagram of `slot`'s peer with these records; the records as the core relays them */
  send(slot: number, ...records: [number, ActionOut][]): ActionIn[] {
    this.sent.length = 0;
    const body = concat(records.map(([s, a]) => encodeUserAction(s, a)));
    this.core.receive(this.peer(slot), buildGameData({ slot, time: 1, round: 0, respawn: 1, roundNumber: 0, accountId: slot + 1, unk1: 0 }, body, this.key));
    const out = this.sent[0];
    return out ? decodeActions(decodeServerGameData(out.data)!.actions) : [];
  }
  /** the hits of `from`'s own record that were relayed */
  hits(from: number, ...hs: Hit[]): HitInfo[] {
    return this.send(from, [from, { hits: hs.map(webHit) }]).find((a) => a.slot === from)?.hits ?? [];
  }
}

test("anti-cheat is on by default; ItemStatistics + pef in matchData.json", () => {
  assert.equal(DEFAULT_CONFIG.antiScript, true);
  assert.equal(DEFAULT_CONFIG.checkLoadout, true);
  assert.equal(DEFAULT_CONFIG.fireRateCap, true);
  assert.ok(DEFAULT_CONFIG.strikeLimit > 1, "never on the first rejection");
  assert.deepEqual([ST[K2].damage, ST[K2].fireDelay], [27, 0.075]);
  assert.equal(ST[CHEYTAC].damageMax, 173, "pef Damage above the XML 95");
  assert.equal(ST[SHOTGUN].hits, 8);
  assert.equal(ST[UZI].hits, 2, "DualSMG: both guns every shot");
  assert.equal(mapData.weaponGroup![702001001], mapData.weaponGroup![M7], "battle.ts WEAPON_IDS M-7 = the knife's name group");
});

test("(a) damage: honest maximum passes, inflated damage is dropped", () => {
  const b = new Bench();
  b.join(0, { primary: K2 }); b.join(1, { primary: CHEYTAC, melee: M7 }); b.join(2);
  // K-2 27 x Body 1.2 x coupon 1.1 = 36 (the original allowed 27 + 30 % = 35)
  assert.equal(b.hits(0, { victim: 1, damage: 36, weapon: K2 }).length, 1);
  assert.equal(b.hits(0, { victim: 1, damage: 37, weapon: K2 }).length, 0);
  assert.equal(b.hits(0, { victim: 1, damage: 2047, weapon: K2 }).length, 0);
  // head: CalcHeadShotDamage <= 255
  assert.equal(b.hits(0, { victim: 1, damage: 200, part: 14, weapon: K2 }).length, 1);
  assert.equal(b.hits(0, { victim: 1, damage: 256, part: 14, weapon: K2 }).length, 0);
  // Cheytac body 173 x 1.2 = 208 (XML 95: the original would have dropped it), M-7 RMB 90 x 1.2 = 108 (XML 60)
  assert.equal(b.hits(1, { victim: 0, damage: 208, weapon: CHEYTAC }).length, 1);
  assert.equal(b.hits(1, { victim: 0, damage: 108, weapon: M7 }).length, 1);
  assert.equal(b.hits(1, { victim: 0, damage: 130, weapon: M7 }).length, 0);
  assert.ok(b.warns.some((l) => /slot 0: hit 37 part 1 with 103004/.test(l)), b.warns.join("\n"));
});

test("(a) a record that breaks a prop may carry its car blast; without the break it may not", () => {
  const b = new Bench({ uniqueRoomId: MAP_KEY.uniqueRoomId, roomSeed: (6 << 20) | (1 << 12) | 4 }); // a map with exploding cars
  assert.equal(mapData.propBlast![6], 100);
  b.join(0); b.join(1, { secondary: PISTOL }); b.join(2);
  const car: Hit = { victim: 0x8000 + 3, damage: 1, weapon: PISTOL, objectType: 3 }; // battle.ts prop break
  assert.equal(b.hits(1, { victim: 2, damage: 90, weapon: PISTOL }).length, 0, "pistol 25: 90 is no bullet");
  assert.equal(b.hits(1, { victim: 2, damage: 90, weapon: PISTOL }, car).length, 2, "the car's blast rides the record that breaks it");
});

test("(b) loadout: the RESPAWN's items (by name group), Dual swap, defaults and dropped pick-ups pass; any other weapon is dropped", () => {
  const b = new Bench();
  b.join(0); b.join(1, { primary: K2_SAME_NAME, secondary: KRISS, melee: M7 }); b.join(2, { primary: CHEYTAC });
  assert.equal(b.hits(1, { victim: 0, damage: 30, weapon: K2_SAME_NAME }).length, 1);
  assert.equal(b.hits(1, { victim: 0, damage: 30, weapon: K2 }).length, 1, "weaponIdOfName gives the first K-2 id");
  assert.equal(b.hits(1, { victim: 0, damage: 60, weapon: 702001001 }).length, 1, "WEAPON_IDS M-7 = the slot's knife");
  assert.equal(b.hits(1, { victim: 0, damage: 22, weapon: KRISS_DUAL }).length, 1, "Extension2 Dual swap");
  assert.equal(b.hits(1, { victim: 0, damage: 90, weapon: K400 }).length, 1, "RESPAWN grenade 0: the client's default K-400");
  assert.equal(b.hits(1, { victim: 0, damage: 100, weapon: CHEYTAC }).length, 0, "not in slot 1's loadout");
  // WeaponSync: a weapon the slot does not have is not relayed
  assert.equal(b.send(1, [1, { weapon: { weaponId: CHEYTAC } }]).find((a) => a.slot === 1)?.weaponId, undefined);
  assert.equal(b.send(1, [1, { weapon: { weaponId: K2_SAME_NAME } }]).find((a) => a.slot === 1)?.weaponId, K2_SAME_NAME);
  // a pick-up counts only for an item somebody dropped
  b.send(1, [1, { pickup: { ammo: 5, extra: 0, reserve: 0, flags: 0, weaponId: SHOTGUN } }]);
  assert.equal(b.hits(1, { victim: 0, damage: 20, weapon: SHOTGUN }).length, 0, "nobody dropped a shotgun");
  b.send(2, [2, { drop: { ammo: 5, extra: 0, reserve: 0, flags: 0, weaponId: CHEYTAC } }]);
  b.send(1, [1, { pickup: { ammo: 5, extra: 0, reserve: 0, flags: 0, weaponId: CHEYTAC } }]);
  assert.equal(b.hits(1, { victim: 0, damage: 100, weapon: CHEYTAC }).length, 1, "slot 2's dropped Cheytac, picked up");
});

test("(b) Champion Claymore 407113 has its own ItemStatistics row: its grenade hits pass in the explosive slot, over-damage is dropped", () => {
  const CHAMPION = 407113;
  assert.equal(ST[CHAMPION]?.damage, 65, "row of the 2017 base 407023");
  const b = new Bench();
  b.join(0); b.join(1, { explosive: CHAMPION }); b.join(2);
  assert.equal(b.hits(1, { victim: 0, damage: 65, weapon: CHAMPION }).length, 1, "Champion 65 hits the slot's Claymore");
});

test("(b) a guest's record for another slot is dropped; the host's AI seats pass (and are checked)", () => {
  const b = new Bench();
  b.join(0, { primary: K2 }); b.join(1, { primary: K2 }); b.join(2, { primary: K2 });
  const forged = b.send(1, [1, { hp: 100 }], [2, { hits: [webHit({ victim: 0, damage: 30, weapon: K2 })] }]);
  assert.ok(forged.some((a) => a.slot === 1) && !forged.some((a) => a.slot === 2), "slot 1 may not speak for slot 2");
  // the host's bot in seat 5 (no RESPAWN): legacy WEAPON_IDS K-2 id, damage still capped
  const bot = (damage: number) => b.send(0, [0, { hp: 100 }], [5, { hits: [webHit({ victim: 1, damage, weapon: 100003001 })] }]).find((a) => a.slot === 5)?.hits ?? [];
  assert.equal(bot(27).length, 1);
  assert.equal(bot(300).length, 0);
});

test("(c) fire rate: the honest maximum of K-2, dual pistol, DualSMG, shotguns, sniper and knife passes", () => {
  // fastest honest cadence: FireDelay minus the best titles' Fire_Speed (floor 0.06), not even the frame the exe adds, for 3 s
  for (const w of [K2, MK23_DUAL, UZI, SHOTGUN, JACKHAMMER, CHEYTAC, M7]) {
    const b = new Bench();
    b.join(0, { primary: w, melee: M7 }); b.join(1); b.join(2);
    const st = ST[w], period = Math.max(0.06, st.fireDelay - 0.01) * 1000, n = st.hits ?? 1;
    let sent = 0, relayed = 0;
    for (const end = b.t + 3000; b.t < end; b.t += period) {
      sent += n;
      relayed += b.hits(0, ...Array.from({ length: n }, () => ({ victim: 1, damage: 1, weapon: w }))).length;
    }
    assert.equal(relayed, sent, `${w}: ${relayed} / ${sent} hits relayed at ${period.toFixed(1)} ms`);
  }
  // a sniper bullet goes through every character on its line: its rate is per victim
  const b = new Bench();
  b.join(0, { primary: CHEYTAC }); b.join(1); b.join(2);
  for (let i = 0; i < 4; i++, b.t += 340) assert.equal(b.hits(0, { victim: 1, damage: 1, weapon: CHEYTAC }, { victim: 2, damage: 1, weapon: CHEYTAC }).length, 2);
});

test("(c) fire rate: K-2 at twice its rate loses the excess, not a strike", () => {
  const b = new Bench(MAP_KEY, { strikeLimit: 2 });
  b.join(0); b.join(1, { primary: K2 });
  let relayed = 0;
  for (let i = 0; i < 80; i++, b.t += 37.5) relayed += b.hits(1, { victim: 0, damage: 27, weapon: K2 }).length; // 3 s at 2x
  const limit = Math.floor((1 / 0.065) * 1.15) + 1; // 18 a second
  assert.ok(relayed <= limit * 3 + 1 && relayed >= 40, `${relayed} of 80 relayed`);
  assert.deepEqual(b.kicks, [], "jitter can bunch honest hits: the rate never strikes");
});

test("strikes: strikeLimit hard rejections drop the guest and its slot may not register again; the host is never dropped", () => {
  const b = new Bench(MAP_KEY, { strikeLimit: 3 });
  b.join(0, { primary: K2 }); b.join(1, { primary: K2 });
  for (let i = 0; i < 2; i++) b.hits(1, { victim: 0, damage: 500, weapon: K2 });
  assert.deepEqual(b.kicks, [], "not on the first rejections");
  b.hits(1, { victim: 0, damage: 500, weapon: K2 });
  assert.deepEqual(b.kicks, ["g1"]);
  assert.ok(b.core.rooms[0].kicked.has(1));
  b.sent.length = 0;
  b.core.peerClosed("g1");
  b.core.receive("g1b", buildHandshake(65, 1, 2, MAP_KEY));
  assert.equal(b.sent.length, 0, "no CONNECT for the dropped slot");
  for (let i = 0; i < 10; i++) b.hits(0, { victim: 1, damage: 500, weapon: K2 });
  assert.deepEqual(b.kicks, ["g1"], "the leader's own link passes the checks but is never dropped");
  // the strike state and the loadouts cross a host handoff
  const snap = b.core.snapshot();
  assert.deepEqual(snap.rooms[0].kicked, [1]);
  assert.ok(snap.rooms[0].players[0].loadout!.includes(K2));
});
