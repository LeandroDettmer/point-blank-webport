// Reward scale of the end of match: x0.5 with 2 humans, x0.75
// with 3, x1 with 4+, nothing below 2, x0.5 more under 3 min; an AI room keeps only the length factor. No database: pool.query is mocked.
//   node --test test/rewardCaps.test.ts
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { PacketReader, PacketWriter } from "../../src/net/packet.ts";
import { pool } from "../src/db.ts";
import { Account } from "../src/shared/account.ts";
import { PlayerEquipment } from "../src/shared/models.ts";
import { RoomModel, RoomState, SlotState } from "../src/game/roomModel.ts";
import { handleTimerSync, rewardScale } from "../src/game/roomHandlers.ts";
import type { ChannelModel } from "../src/game/channel.ts";
import type { GameClient } from "../src/game/gameServer.ts";

const q = mock.method(pool, "query", async () => ({ rows: [] }));
after(() => { q.mock.restore(); });

const MIN = 60000;
function room(n: number, actors: number, matchMs: number) {
  const accounts: Account[] = [];
  const svc = { getAccount: (pid: bigint) => accounts.find((a) => a.playerId === pid) ?? null, send: () => {}, updateStatus: async () => {} };
  const r = new RoomModel(3, { id: 0, type: 0, serverId: 1, lobbyPlayers: [], rooms: [] } as unknown as ChannelModel, svc);
  Object.assign(r, { state: RoomState.BATTLE, mapId: 4, rule: 0, stage: 1, roomType: 4, killTime: 0, leader: 0 });
  r.battleStart = Date.now() - 181000;
  r.matchStart = Date.now() - matchMs;
  for (let i = 0; i < actors; i++) r.actors.add(BigInt(900 + i));
  const clients: GameClient[] = [];
  for (let i = 0; i < n; i++) {
    const a = new Account();
    Object.assign(a, { playerId: BigInt(100 + i), nickname: `P${i}`, rank: 10, slotId: i, room: r });
    const c = { player: a, session: { send: () => {}, close: () => {} } };
    a.connection = c;
    accounts.push(a); clients.push(c as unknown as GameClient);
    const s = r.slots[i];
    Object.assign(s, { playerId: a.playerId, state: SlotState.BATTLE, startTime: Date.now() - 2 * MIN, allKills: 4, allDeaths: 3, score: 20 });
    s.equipment = new PlayerEquipment();
  }
  return { r, accounts, clients };
}

test("rewardScale: humans and length", () => {
  const scale = (actors: number, matchMs: number, bot = false) => rewardScale(room(0, actors, matchMs).r, bot);
  assert.equal(scale(4, 4 * MIN), 1);
  assert.equal(scale(3, 4 * MIN), 0.75);
  assert.equal(scale(2, 4 * MIN), 0.5);
  assert.equal(scale(2, 2 * MIN), 0.25, "2 humans and a short match stack");
  assert.equal(scale(1, 10 * MIN), 0, "one human: nobody to play against");
  assert.equal(scale(1, 10 * MIN, true), 1, "AI room: humans do not count");
  assert.equal(scale(1, 2 * MIN, true), 0.5);
});

test("end of match: a 2-human 2-minute match pays a quarter of a 4-human 4-minute one", () => {
  const end = (actors: number, matchMs: number) => {
    const w = room(2, actors, matchMs);
    handleTimerSync(w.clients[0], new PacketReader(new PacketWriter().writeD(0).writeT(0).writeC(1).writeC(5).writeC(0).writeH(30).toBytes()));
    assert.equal(w.r.state, RoomState.READY, "the match ended");
    return w.accounts.map((a) => [a.exp, a.gold]);
  };
  const full = end(4, 4 * MIN), farm = end(2, 2 * MIN);
  for (let i = 0; i < 2; i++) {
    assert.ok(full[i][0] > 0 && farm[i][0] > 0);
    assert.deepEqual(farm[i], full[i].map((v) => Math.trunc(v * 0.25)));
  }
});
