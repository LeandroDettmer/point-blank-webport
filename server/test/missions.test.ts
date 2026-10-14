// Missoes (cartoes): kill progress filters, card 4/4 and set 40/40 awards, progress persistence and the per-match clone
// (RoomModel.CalculateBattleResults / AllUtils.CompleteMission / GenerateMissionAwards). Synthetic set 99, no database:
// pool.query is mocked and every statement is recorded.
//   node --test test/missions.test.ts
import { test, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { PacketReader, PacketWriter } from "../../src/net/packet.ts";
import { pool } from "../src/db.ts";
import { getPlayerMissionsDB } from "../src/shared/dao.ts";
import { data, getMissionCards, loadMissionCards } from "../src/shared/data.ts";
import { PlayerMissions } from "../src/shared/models.ts";
import { MT, completeMissionKills, completeMission, endMatchMission, finishMissions, generateMissionAwards } from "../src/game/progress.ts";
import { handleDeath } from "../src/game/roomHandlers.ts";
import type { GameClient } from "../src/game/gameServer.ts";
import type { FragInfo } from "../src/game/roomPackets.ts";
import { battleRoom, opOf, type Sent } from "./fakeRoom.ts";

const SET = 99, MAP = 7, WEAPON = 105007; // item class 1, weapon class 5, number 7

let queries: { sql: string; args: unknown[] }[] = [];
const q = mock.method(pool, "query", async (sql: string, args: unknown[] = []) => { queries.push({ sql, args }); return { rows: [] }; });
after(() => { q.mock.restore(); });

/** 10 cards x 4 tasks. Card 0: KILL x3, HEADSHOT x2, KILL with class 5 x1, KILL on map 7 x1. Every other task is a WIN x1. */
function setupData(): void {
  data.missionCards = [];
  for (let card = 0; card < 10; card++) for (let b = 0; b < 4; b++) {
    const t = card === 0 ? [MT.KILL, MT.HEADSHOT, MT.KILL, MT.KILL][b] : MT.WIN;
    data.missionCards.push({
      missionId: SET, cardBasicId: card, missionBasicId: b, arrayIdx: card * 4 + b, flag: 15 << (4 * b),
      missionLimit: card === 0 ? [3, 2, 1, 1][b] : 1, missionType: t, mapId: card === 0 && b === 3 ? MAP : 0, weaponReq: card === 0 && b === 2 ? 5 : 0, weaponReqId: 0,
    });
  }
  data.missionCardAwards = [{ id: SET, card: 0, exp: 500, gold: 300, ribbon: 1, ensign: 0, medal: 0 }, { id: SET, card: 9, exp: 100, gold: 50, ribbon: 0, ensign: 0, medal: 1 }];
  data.missionAwards = [{ id: SET, masterMedal: 1, exp: 4000, gold: 0 }];
  data.missionItems = [];
}

type Rig = ReturnType<typeof rig>;
function rig() {
  const f = battleRoom(2);
  f.room.mapId = MAP;
  const m = new PlayerMissions();
  m.actualMission = 1; m.at(1).cardSetId = SET; m.at(1).currentCard = 0;
  Object.assign(f.accounts[0], { mission: m, ribbon: 0, ensign: 0, medal: 0, masterMedal: 0, exp: 0, gold: 0, event: null, inventory: { items: [], getItem: () => null }, character: { getCharacter: () => null } });
  const s = f.room.slots[0];
  s.team = 0;
  s.missions = m.clone(); // what ReadyBattle / StartBattle do
  return { r: f.room, s, p: f.accounts[0], m, sent: f.sent };
}
const frag = (n: number, killFlag = 0): FragInfo["frags"] => Array.from({ length: n }, (_, i) => ({ victim: 1 + 2 * i, weaponClass: 5, hitspotInfo: 0, killFlag, unk: 0, x: 0, y: 0, z: 0, assist: 0, unks: new Uint8Array(0) }));
const fragInfo = (n: number, weapon: number, flag: number): FragInfo => ({ killingType: 1, killsCount: n, killerIdx: 0, weapon, x: 0, y: 0, z: 0, flag: 0, unk: 0, frags: frag(n, flag), score: 0 });
const kill = (r: Rig, n: number, o: { flag?: number; weapon?: number; life?: number } = {}) => {
  r.s.killsOnLife = o.life ?? 1;
  completeMissionKills(r.r, r.s, fragInfo(n, o.weapon ?? WEAPON, o.flag ?? 0), 0, 0);
};
const prog = (r: Rig) => r.s.missions!.current.progress;
const acct = (r: Rig) => r.p as unknown as { ribbon: number; masterMedal: number; exp: number; gold: number };
beforeEach(() => { queries = []; setupData(); });

test("KILL: counts enemy frags per task, class and map filters, capped at the limit", () => {
  const r = rig();
  kill(r, 2, { weapon: 103001 }); // class 3, map 7: KILL x3 (+2), KILL map 7 x1 (+1); class-5 task unmet
  assert.deepEqual([...prog(r).slice(0, 4)], [2, 0, 0, 1]);
  kill(r, 2); // class 5: KILL +1 (cap 3), class-5 task +1 (cap 1), map task capped
  assert.deepEqual([...prog(r).slice(0, 4)], [3, 0, 1, 1]);
  assert.equal(r.m.current.progress[0], 0, "the live cards stay untouched while the match runs");
  r.r.mapId = 1;
  prog(r).fill(0);
  kill(r, 1);
  assert.deepEqual([...prog(r).slice(0, 4)], [1, 0, 1, 0], "map filter");
});

test("KILL: friendly victims do not count; HEADSHOT needs the flag", () => {
  const r = rig();
  const k = fragInfo(1, WEAPON, 0);
  k.frags[0].victim = 2; // same team (even index)
  completeMissionKills(r.r, r.s, k, 0, 0);
  assert.equal(prog(r)[0], 0);
  kill(r, 1);
  assert.equal(prog(r)[1], 0);
  kill(r, 1, { flag: 8 });
  assert.deepEqual([...prog(r).slice(0, 2)], [2, 1]);
  kill(r, 1, { flag: 16 }); // ChainHeadshot also counts
  assert.equal(prog(r)[1], 2);
});

test("every progress step sends 2359 twice (old value, new value; +240 on the finishing step)", () => {
  const r = rig();
  r.sent.length = 0;
  kill(r, 1, { flag: 8 });
  const acks = (s: Sent[]) => s.filter((x) => x.op === 2359);
  assert.deepEqual(acks(r.sent).slice(0, 2).map((x) => [x.bytes[2], x.bytes[3]]), [[0, 0], [0, 1]], "KILL task (basic id 0)");
  r.sent.length = 0;
  kill(r, 1, { flag: 8 }); // HEADSHOT 1 -> 2 = limit
  assert.ok(acks(r.sent).some((x) => x.bytes[2] === 1 + 240 && x.bytes[3] === 2));
});

/** DEATH_REQ body (handleDeath): C type, C count, C killer, D weapon, T xyz, C flag, C unk; per frag C victim, C class,
 * C hitspot, H kill flag, C unk, T xyz, C assist, 4 B. */
function deathReq(killer: number, victim: number, weapon: number): PacketReader {
  const w = new PacketWriter(64).writeC(1).writeC(1).writeC(killer).writeD(weapon).writeT(0).writeT(0).writeT(0).writeC(0).writeC(0);
  w.writeC(victim).writeC(5).writeC(0).writeH(0).writeC(0).writeT(0).writeT(0).writeT(0).writeC(killer).writeB(new Uint8Array(4));
  return new PacketReader(w.toBytes());
}

test("real .mqf cards: one copy per task; one DEATH_REQ kill moves the killer's KILL task by exactly 1", () => {
  data.missionCardAwards = []; data.missionItems = [];
  data.missionCards = loadMissionCards();
  for (const set of new Set(data.missionCards.map((c) => c.missionId))) {
    for (let card = 0; card < 10; card++) assert.equal(getMissionCards(set, card).length, 4, `set ${set} card ${card}`);
  }
  const t = data.missionCards.find((c) => c.missionType === MT.KILL && c.mapId === 0 && c.weaponReq === 0 && c.weaponReqId === 0 && c.missionLimit >= 2)!;
  const r = rig();
  r.m.at(1).cardSetId = t.missionId; r.m.at(1).currentCard = t.cardBasicId;
  r.s.missions = r.m.clone();
  r.sent.length = 0;
  const killer = { player: r.p } as unknown as GameClient;
  handleDeath(killer, deathReq(0, 1, WEAPON));
  assert.equal(prog(r)[t.arrayIdx], 1, "1 kill = +1");
  const acks = r.sent.filter((x) => x.op === 2359 && x.to === r.p.playerId && (x.bytes[2] & 0x0f) === t.missionBasicId);
  assert.deepEqual(acks.map((x) => x.bytes[3]), [0, 1], "one 2359 pair (old, new)");
  handleDeath(killer, deathReq(0, 1, WEAPON)); // the same victim reported again while dead: dropped
  assert.equal(prog(r)[t.arrayIdx], 1);
});

test("completed card 4/4: ribbon + exp/gold, 2361(1,1), selectedCard, not twice", () => {
  const r = rig();
  prog(r).set([3, 2, 1, 1]);
  r.p.mission = r.s.missions!;
  r.sent.length = 0;
  const qq: [string[], unknown[]] = [[], []];
  generateMissionAwards(r.p, qq);
  const a = acct(r);
  assert.deepEqual([a.ribbon, a.exp, a.gold], [1, 500, 300]);
  assert.deepEqual(qq, [["ribbon"], [1]]);
  assert.ok(r.p.mission.selectedCard);
  const ack = r.sent.find((x) => opOf(x.bytes) === 2361)!;
  assert.equal(ack.bytes[2], 1, "flag 1");
  assert.equal(ack.bytes[6], 1, "type 1");
  generateMissionAwards(r.p, [[], []]);
  assert.equal(a.exp, 500);
});

test("incomplete card gives nothing", () => {
  const r = rig();
  prog(r).set([3, 2, 1, 0]);
  r.p.mission = r.s.missions!;
  generateMissionAwards(r.p, [[], []]);
  assert.equal(acct(r).exp, 0);
  assert.equal(r.p.mission.selectedCard, false);
});

test("set 40/40: master medal, card + set exp, 2361(273,4), slot cleared and deleted", async () => {
  const r = rig();
  for (const c of data.missionCards) prog(r)[c.arrayIdx] = c.missionLimit;
  r.p.mission = r.s.missions!;
  r.sent.length = 0;
  const qq: [string[], unknown[]] = [[], []];
  generateMissionAwards(r.p, qq);
  const a = acct(r);
  assert.deepEqual([a.ribbon, a.masterMedal, a.exp, a.gold], [1, 1, 4500, 300]);
  assert.deepEqual(qq[0].sort(), ["master_medal", "ribbon"]);
  assert.ok(r.p.mission.at(1).isEmpty);
  assert.ok(r.p.mission.at(1).progress.every((b) => b === 0));
  await new Promise((res) => setTimeout(res, 20));
  const ack = r.sent.find((x) => opOf(x.bytes) === 2361)!;
  assert.equal(ack.bytes[2] | (ack.bytes[3] << 8), 273);
  assert.equal(ack.bytes[6], 4);
  assert.ok(queries.some((x) => /DELETE FROM player_mission_slots/.test(x.sql) && x.args[1] === 1));
});

test("persistence: finishMissions applies the clone and writes the 40-byte progress of the active slot", () => {
  const r = rig();
  kill(r, 2, { flag: 8 });
  const expected = [...prog(r)];
  assert.equal(r.m.current.progress[0], 0, "live cards not yet changed");
  finishMissions(r.r, r.p, r.s, 2, [[], []]); // draw: no WIN
  assert.strictEqual(r.p.mission, r.s.missions, "the clone becomes the live cards");
  assert.deepEqual([...r.p.mission.current.progress], expected);
  const up = queries.filter((x) => /INSERT INTO player_mission_slots.*ON CONFLICT/s.test(x.sql));
  assert.equal(up.length, 1);
  const [bytes, card, owner, slot, setId] = up[0].args as [Buffer, number, string, number, number];
  assert.equal(bytes.length, 40);
  assert.deepEqual([...bytes], expected);
  assert.deepEqual([card, owner, slot, setId], [0, "100", 1, SET]);
});

test("event set 13 granted in memory (no row): end of match upserts it with card_set_id 13 and the progress; relogin keeps it", async () => {
  const r = rig();
  r.m.at(1).cardSetId = 0; r.m.at(2).cardSetId = 13; r.m.actualMission = 2; // EnableQuestMission: memory only
  data.missionCards = data.missionCards.map((c) => ({ ...c, missionId: 13 }));
  r.s.missions = r.m.clone();
  kill(r, 2, { flag: 8 });
  const expected = [...prog(r)];
  assert.ok(expected.some((b) => b > 0));
  finishMissions(r.r, r.p, r.s, 2, [[], []]);
  const up = queries.filter((x) => /INSERT INTO player_mission_slots.*ON CONFLICT/s.test(x.sql));
  assert.equal(up.length, 1);
  const [bytes, , , slot, setId] = up[0].args as [Buffer, number, string, number, number];
  assert.deepEqual([slot, setId], [2, 13]);
  assert.deepEqual([...bytes], expected);
  // relogin: the saved row comes back through getPlayerMissionsDB, 13 once, progress intact
  const n = q.mock.callCount();
  q.mock.mockImplementationOnce((async () => ({ rows: [{ current_mission: 2 }] })) as never, n);
  q.mock.mockImplementationOnce((async () => ({ rows: [{ slot: 2, card_set_id: 13, current_card: 0, progress: bytes }] })) as never, n + 1);
  const m = (await getPlayerMissionsDB(100n))!;
  assert.equal(m.at(2).cardSetId, 13);
  assert.deepEqual([...m.at(2).progress], expected);
  assert.equal(m.ownsCardSet(13), true); // checkGameEvents / login grant is skipped
  assert.equal([0, 1, 2, 3].filter((i) => m.at(i).cardSetId === 13).length, 1);
});

test("a finished set is not re-saved (its row is deleted)", async () => {
  const r = rig();
  for (const c of data.missionCards) prog(r)[c.arrayIdx] = c.missionLimit;
  finishMissions(r.r, r.p, r.s, 2, [[], []]);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(queries.filter((x) => /INSERT INTO player_mission_slots/.test(x.sql)).length, 0);
  assert.equal(queries.filter((x) => /DELETE FROM player_mission_slots/.test(x.sql)).length, 1);
});

test("WIN at the end counts for the card; draw / loss rules follow EndMatchMission", () => {
  const r = rig();
  const t = data.missionCards.find((c) => c.cardBasicId === 0 && c.missionBasicId === 3)!;
  t.missionType = MT.WIN; t.mapId = 0;
  endMatchMission(r.r, r.p, r.s, 2);
  assert.equal(prog(r)[3], 0, "draw");
  endMatchMission(r.r, r.p, r.s, 1);
  assert.equal(prog(r)[3], 0, "team 0 lost: DEFEAT does not progress a WIN task");
  endMatchMission(r.r, r.p, r.s, 0);
  assert.equal(prog(r)[3], 1);
  t.missionType = MT.DEFEAT; t.missionLimit = 2;
  completeMission(r.r, r.s, MT.DEFEAT, 0);
  assert.equal(prog(r)[3], 2);
});

test("aborted match: no clone applied, nothing written, live cards untouched", () => {
  const r = rig();
  kill(r, 3, { flag: 8 });
  r.s.missions = null; // the slot reset on leave; calculateResult skips it, so finishMissions never runs
  assert.ok(r.m.current.progress.every((b) => b === 0));
  assert.equal(queries.filter((x) => /player_mission_slots/.test(x.sql)).length, 0);
  finishMissions(r.r, r.p, r.s, 0, [[], []]); // a late finish without a clone neither applies nor persists
  assert.strictEqual(r.p.mission, r.m);
  assert.equal(queries.filter((x) => /INSERT INTO player_mission_slots/.test(x.sql)).length, 0);
});

test("clone is deep: slots, progress and flags", () => {
  const m = new PlayerMissions();
  m.at(2).cardSetId = 5; m.at(2).progress[7] = 3; m.selectedCard = true; m.actualMission = 2;
  const c = m.clone();
  c.at(2).progress[7] = 9; c.at(2).currentCard = 4;
  assert.equal(m.at(2).progress[7], 3);
  assert.equal(m.at(2).currentCard, 0);
  assert.deepEqual([c.actualMission, c.selectedCard, c.at(2).cardSetId], [2, true, 5]);
});

test("set 13 40/40 delivers the final items 103194 + 700178 (inventory ack lists both)", async () => {
  data.missionCardAwards = []; data.missionItems = [];
  data.missionCards = loadMissionCards();
  const r = rig();
  r.m.at(1).cardSetId = 13; r.m.at(1).currentCard = 0;
  r.s.missions = r.m.clone();
  for (const c of data.missionCards.filter((x) => x.missionId === 13)) prog(r)[c.arrayIdx] = c.missionLimit;
  r.p.mission = r.s.missions!;
  r.sent.length = 0;
  generateMissionAwards(r.p, [[], []]);
  await new Promise((res) => setTimeout(res, 20));
  const inv = r.sent.find((x) => opOf(x.bytes) === 3334 || opOf(x.bytes) === 3330);
  assert.ok(inv, "inventory packet sent");
  const bytes = Buffer.from(inv.bytes);
  for (const id of [103194, 700178]) assert.ok(bytes.includes(Buffer.from(new Uint32Array([id]).buffer)), `item ${id} in packet`);
  assert.ok(r.sent.some((x) => opOf(x.bytes) === 2361 && x.bytes[6] === 4));
});
