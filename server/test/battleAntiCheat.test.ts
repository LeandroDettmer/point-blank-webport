// Battle guard: the client declares kills (DEATH_REQ 5135), respawns (5137),
// the end of the clock (TIMERSYNC 5168) and the F2 test menu (5199). Each rule: one packet taken, one refused.
//   node --test test/battleAntiCheat.test.ts
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { PacketReader, PacketWriter } from "../../src/net/packet.ts";
import { Account } from "../src/shared/account.ts";
import { PlayerEquipment, PlayerMissions } from "../src/shared/models.ts";
import { CouponEffects, data } from "../src/shared/data.ts";
import { MT } from "../src/game/progress.ts";
import { RoomModel, RoomState, SlotState, DeadEnum } from "../src/game/roomModel.ts";
import { battleGuard, handleDeath, handleDevBomb, handleRespawn, handleTimerSync } from "../src/game/roomHandlers.ts";
import type { ChannelModel } from "../src/game/channel.ts";
import type { GameClient } from "../src/game/gameServer.ts";

const WEAPON = 105007, TDM = 4, BOMB = 8;
const opOf = (b: Uint8Array) => b[0] | (b[1] << 8);

/** n accounts fighting (slot i, team i % 2), the leader in slot 0, in battle for a minute */
function world(n = 2, roomType = TDM) {
  const sent: { to: bigint; op: number; bytes: Uint8Array }[] = [];
  const accounts: Account[] = [];
  const svc = {
    getAccount: (pid: bigint) => accounts.find((a) => a.playerId === pid) ?? null,
    send: (a: Account, b: Uint8Array) => { sent.push({ to: a.playerId, op: opOf(b), bytes: b }); },
    updateStatus: async () => {},
  };
  const ch = { id: 0, type: 0, serverId: 1, lobbyPlayers: [] as Account[], rooms: [] } as unknown as ChannelModel;
  const r = new RoomModel(3, ch, svc);
  Object.assign(r, { state: RoomState.BATTLE, mapId: 4, rule: 0, stage: 1, roomType, killTime: roomType === BOMB ? 0x03 : 0, leader: 0 });
  r.battleStart = r.matchStart = Date.now() - 60000;
  const clients: GameClient[] = [];
  const closed: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = new Account();
    Object.assign(a, { playerId: BigInt(100 + i), nickname: `P${i}`, rank: 10, slotId: i, room: r, isOnline: true });
    const c = { player: a, session: { send: (b: Uint8Array) => sent.push({ to: a.playerId, op: opOf(b), bytes: b }), close: () => closed.push(i) } };
    a.connection = c;
    accounts.push(a);
    clients.push(c as unknown as GameClient);
    const s = r.slots[i];
    s.playerId = a.playerId; s.state = SlotState.BATTLE; s.startTime = Date.now() - 60000;
    s.equipment = Object.assign(new PlayerEquipment(), { weaponPrimary: WEAPON });
  }
  return { r, accounts, clients, sent, closed, ops: (op: number) => sent.filter((x) => x.op === op) };
}

/** DEATH_REQ: C type, C count, C killer, D weapon, T xyz, C flag, C unk; frag: C victim, C class, C hitspot, H flag, C unk, T xyz, C assist, 4 B */
function deathReq(killer: number, victim: number, weapon = WEAPON, hitspot = 0x10): PacketReader {
  const w = new PacketWriter(64).writeC(0).writeC(1).writeC(killer).writeD(weapon).writeT(0).writeT(0).writeT(0).writeC(0).writeC(0);
  w.writeC(victim).writeC(Math.trunc(weapon / 100000)).writeC(hitspot).writeH(0).writeC(0).writeT(0).writeT(0).writeT(0).writeC(killer).writeB(new Uint8Array(4));
  return new PacketReader(w.toBytes());
}
const timerSync = (time: number, round = 1) => new PacketReader(new PacketWriter().writeD(time).writeT(0).writeC(round).writeC(5).writeC(0).writeH(30).toBytes());
const respawnReq = () => new PacketReader(new Uint8Array(160));

const guard0 = { ...battleGuard };
beforeEach(() => { mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000_000 }); });
afterEach(() => { mock.timers.reset(); Object.assign(battleGuard, guard0); });
const done = (w: ReturnType<typeof world>) => { w.r.stopTimers(); for (const s of w.r.slots) s.resetSlot(); };

// -----------------------------------------------------------------------------------------------------------------

test("5199 ends the bomb round only with PB_DEV_OPS", () => {
  const w = world(2, BOMB);
  battleGuard.devOps = false;
  handleDevBomb(w.clients[1], new PacketReader(new Uint8Array([2])));
  assert.equal(w.ops(5155).length, 0, "prod: ignored");
  assert.equal(w.r.ctRounds, 0);
  battleGuard.devOps = true;
  handleDevBomb(w.clients[1], new PacketReader(new Uint8Array([2])));
  assert.equal(w.ops(5155).length, 2, "dev: round over for both fighters");
  done(w);
});

// -----------------------------------------------------------------------------------------------------------------

test("TIMERSYNC 0 from a non-leader is refused, the leader's ends the round", () => {
  const w = world(2, BOMB);
  w.r.battleStart = Date.now() - 181000; // TIMES[0] = 3 min: the server's round clock is out
  handleTimerSync(w.clients[1], timerSync(0));
  assert.equal(w.ops(5155).length, 0);
  assert.equal(w.r.slots[1].strikes, 1);
  handleTimerSync(w.clients[0], timerSync(0));
  assert.equal(w.ops(5155).length, 2);
  assert.equal(w.r.ctRounds, 1);
  done(w);
});

test("the leader's TIMERSYNC 0 before the server clock runs out is refused (taken within the slack)", () => {
  const w = world(2, BOMB);
  w.r.battleStart = Date.now() - 60000; // 2 min left
  handleTimerSync(w.clients[0], timerSync(0));
  assert.equal(w.ops(5155).length, 0);
  assert.equal(w.r.slots[0].strikes, 1);
  w.r.battleStart = Date.now() - 178000; // 2 s left: inside the 3 s slack
  handleTimerSync(w.clients[0], timerSync(0));
  assert.equal(w.ops(5155).length, 2);
  done(w);
});

// -----------------------------------------------------------------------------------------------------------------

test("the respawn after a DEATH_REQ death waits RespawnTime (5 s minus the 1.5 s slack), then is served", () => {
  const w = world();
  handleDeath(w.clients[0], deathReq(0, 1));
  assert.ok(w.r.slots[1].deathState & DeadEnum.Dead);
  handleRespawn(w.clients[1], respawnReq());
  assert.equal(w.ops(5138).length, 0, "held");
  mock.timers.tick(3400);
  assert.equal(w.ops(5138).length, 0);
  mock.timers.tick(200);
  assert.equal(w.ops(5138).length, 2, "served when due, to both fighters");
  assert.equal(w.r.slots[1].deathState, DeadEnum.Alive);
  done(w);
});

test("a Respawn100 coupon respawns at once", () => {
  const w = world();
  w.accounts[1].effects = CouponEffects.Respawn100;
  handleDeath(w.clients[0], deathReq(0, 1));
  handleRespawn(w.clients[1], respawnReq());
  assert.equal(w.ops(5138).length, 2);
  done(w);
});

test("deaths of one victim are capped by its time in battle / RespawnTime", () => {
  const w = world();
  const v = w.r.slots[1];
  v.startTime = Date.now() - 2000; v.allDeaths = 1; // a 2nd death 2 s into the battle
  handleDeath(w.clients[0], deathReq(0, 1));
  assert.equal(w.ops(5136).length, 0);
  assert.equal(v.allDeaths, 1);
  assert.equal(w.r.slots[0].strikes, 1);
  v.startTime = Date.now() - 6000; // 6 s: room for 2 lives
  handleDeath(w.clients[0], deathReq(0, 1));
  assert.equal(w.ops(5136).length, 2);
  assert.equal(v.allDeaths, 2);
  done(w);
});

test("a weapon no slot of the match has still kills (honest clients report some by name) but earns no weapon mission", () => {
  // 1 card, 1 task: 5 kills with a weapon of class 5 (WEAPON 105007 and 105099 are both class 5)
  data.missionCards = [{ missionId: 99, cardBasicId: 0, missionBasicId: 0, arrayIdx: 0, flag: 15, missionLimit: 5, missionType: MT.KILL, mapId: 0, weaponReq: 5, weaponReqId: 0 }];
  const w = world();
  const ks = w.r.slots[0], v = w.r.slots[1];
  const m = new PlayerMissions();
  m.actualMission = 1; m.at(1).cardSetId = 99; m.at(1).currentCard = 0;
  w.accounts[0].mission = m; ks.missions = m.clone();
  handleDeath(w.clients[0], deathReq(0, 1, 105099));
  assert.equal(w.ops(5136).length, 2, "the kill counts");
  assert.equal(ks.missions!.current.progress[0], 0, "no weapon mission");
  v.deathState = DeadEnum.Alive;
  handleDeath(w.clients[0], deathReq(0, 1, WEAPON));
  assert.equal(ks.missions!.current.progress[0], 1);
  done(w);
});

test("the killer is the sender's slot, also in an AI room", () => {
  const w = world(3);
  w.r.stage = 2; // AI room: the C# skipped the killer check here
  handleDeath(w.clients[0], deathReq(1, 2)); // slot 0 reports slot 1 killing slot 2
  assert.equal(w.ops(5136).length, 0);
  assert.equal(w.r.slots[2].deathState, DeadEnum.Alive);
  handleDeath(w.clients[1], deathReq(1, 2));
  assert.equal(w.ops(5136).length, 3);
  done(w);
});

test("the victim is a live fighter of the other team (or the killer itself)", () => {
  const w = world(3);
  handleDeath(w.clients[0], deathReq(0, 2)); // slot 2 = team 0, the killer's
  assert.equal(w.ops(5136).length, 0);
  handleDeath(w.clients[0], deathReq(0, 5)); // nobody in slot 5
  assert.equal(w.ops(5136).length, 0);
  handleDeath(w.clients[0], deathReq(0, 0)); // suicide
  assert.equal(w.ops(5136).length, 3);
  assert.equal(w.r.slots[0].strikes, 2);
  done(w);
});

test("a death type past CharaDeath is echoed as DEFAULT, a headshot stays a headshot", () => {
  const w = world(3);
  const hitspotOf = (b: Uint8Array) => { const rd = new PacketReader(b); rd.readH(); rd.readC(); rd.readC(); rd.readC(); rd.readD(); rd.readT(); rd.readT(); rd.readT(); rd.readC(); rd.readC(); rd.readC(); rd.readC(); return rd.readC(); };
  handleDeath(w.clients[0], deathReq(0, 1, WEAPON, 0xf1));
  assert.equal(hitspotOf(w.ops(5136)[0].bytes), 0x11);
  w.sent.length = 0;
  w.r.slots[0].startTime = Date.now() - 60000;
  handleDeath(w.clients[1], deathReq(1, 0, WEAPON, 0x30));
  assert.equal(hitspotOf(w.ops(5136)[0].bytes), 0x30);
  assert.equal(w.r.slots[1].allHeadshots, 1);
  done(w);
});

test("strikes reach PB_BATTLE_STRIKES = the session drops once", () => {
  const w = world();
  battleGuard.strikes = 3;
  for (let i = 0; i < 4; i++) handleTimerSync(w.clients[1], timerSync(0));
  assert.deepEqual(w.closed, [1]);
  done(w);
});
