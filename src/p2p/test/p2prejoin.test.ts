// A guest leaves and comes back (same slot, or another one), with and without AI slots in the room:  node src/p2p/test/p2prejoin.test.ts
// A = leader (slot 0, the Server.Match port in a Worker + RtcHost, and the bots), B = guest. B quits (its link drops), then a NEW
// PbBattleNet joins on the same slot / on another slot (what a player who left and joined the room again gets). Checks: A and the other
// guest C get the rejoiner's records and see it (onRemoteState), the rejoiner sees them, and A's server-side hit on it lands (HpSync).
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { PbBattleNet } from "../../net/battle.ts";
import { signalTicketEnv, testTicket } from "./signalTickets.ts";
import type { ActionIn } from "../../net/matchUdp.ts";
import type { WorkerLike } from "../../host/local.ts";
import type { MatchData } from "../../host/matchCore.ts";
import type { PlayerState } from "../../game/netAdapter";
import type { RoomClient } from "../../net/roomClient.ts";
import type { RespawnAck } from "../../net/metaGame.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const PORT = Number(process.env.P2P_TEST_PORT ?? 18095);
const GW = `ws://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok }); console.log(`[${ok ? "ok" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`); };
const hostLog: string[] = [];

function startSignalServer(): Promise<ChildProcess> {
  const gw = spawn(process.execPath, [resolve(root, "server/tools/signal-server.ts")], {
    env: { ...process.env, PB_WEB_PORT: String(PORT), PB_WEB_HOST: "127.0.0.1", SIGNAL_STUN_URLS: "none", ...signalTicketEnv },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("signal server did not start")), 8000);
    gw.stdout!.on("data", (b: Buffer) => { if (b.toString().includes("listening")) { clearTimeout(t); res(gw); } });
    gw.on("exit", (c) => rej(new Error(`signal server exited ${c}`)));
  });
}

function nodeWorker(): WorkerLike {
  const w = new Worker(new URL("./nodeHostWorker.ts", import.meta.url));
  const like: WorkerLike = { postMessage: (m) => w.postMessage(m), onmessage: null, onerror: null, terminate: () => { void w.terminate(); } };
  w.on("message", (m) => like.onmessage?.({ data: m }));
  w.on("error", (e) => like.onerror?.({ message: e.message }));
  return like;
}

const uniqueRoomId = (1 << 20) | 9;
const roomSeed = (36 << 20) | (1 << 12) | 4;
const data = JSON.parse(readFileSync(resolve(root, "src/host/data/matchData.json"), "utf8")) as MatchData;
const common = { RTCPeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection, data, log: (l: string) => hostLog.push(l) };
const weapons = { primary: 100003001, secondary: 601002003, melee: 702001001, explosive: 803007001, special: 904007002 };
const TORSO = "idle" as const;
const state = (id: string, team: 0 | 1, i: number, base: number, hp = 100): PlayerState => ({
  id, name: id, team, pos: [base + i * 0.1, 0.5, -10], vel: [1, 0, 0], yaw: 0, pitch: 0, crouch: false, alive: hp > 0, hp, weapon: "K-2", firing: false, t: Date.now(),
  torsoAction: TORSO, moving: true, running: false, moveDir: 1, zoomType: 0,
});
const roster = (slots: number[]) => slots.map((slot) => ({ slot, name: `P${slot}`, team: (slot % 2) as 0 | 1 }));
/** Just what PbBattleNet / HostBridge read of a RoomClient: the leader's SLOTINFO view (shared) and the RESPAWN_ACK cache */
function stubRoom(mySlot: number, slots: SlotRow[], acks: Map<number, RespawnAck>): RoomClient {
  return {
    mySlot, respawnAcks: acks, slots, room: null, onDeath: null, onRespawnAck: null, leaderSlot: 0, isLeader: mySlot === 0,
    game: { conn: { on: () => () => {} } }, reportKill: () => {}, requestEquip: () => {}, respawn: () => Promise.resolve(1),
  } as unknown as RoomClient;
}
type SlotRow = { slot: number; nick: string; state: number; team: number; rank: number };
const ack = (slot: number, n: number): RespawnAck => ({ slot, roomSpawns: n, slotSpawns: n, weapons: { primary: weapons.primary, secondary: weapons.secondary, melee: weapons.melee, grenade: weapons.explosive, special: weapons.special }, chara: 602002, parts: [], beret: 0, accessory: 0 });
const mk = (slot: number, leader: boolean, slots: number[], room?: RoomClient) => new PbBattleNet({
  ...(room ? { room } : {}),
  session: { uniqueRoomId, roomSeed, slot, accountId: 0x11 + slot, signalTicket: testTicket(uniqueRoomId, roomSeed, slot) },
  roster: roster(slots), serverUrl: GW, p2p: { ...common, leader, ...(leader ? { worker: nodeWorker } : {}) },
});

async function scenario(label: string, rejoinSlot: number, bots: boolean, withRoom = false, abrupt = false, botOnSeat = false): Promise<void> {
  const slots = [0, 1, 2];
  const rows: SlotRow[] = Array.from({ length: 18 }, (_, i) => ({ slot: i, nick: slots.includes(i) ? `P${i}` : "", state: slots.includes(i) ? 19 : 0, team: i % 2, rank: 0 }));
  const acks = new Map<number, RespawnAck>(slots.map((i) => [i, ack(i, 1)]));
  const rm = (i: number) => (withRoom ? stubRoom(i, rows, acks) : undefined);
  const A = mk(0, true, slots, rm(0)), B = mk(1, false, slots, rm(1)), C = mk(2, false, slots, rm(2));
  const cB = B.connect(), cC = C.connect();
  await sleep(300);
  await A.connect();
  await Promise.all([cB, cC]);
  const local = A.p2p!.host!.local;
  const start = Date.now();
  const arm = (slot: number, n: number, withId: boolean) => local.respawn({ uniqueRoomId, roomSeed, startTick: start, type: n ? 2 : 0, round: 1, slot, respawnCount: n + 1, ...(withId ? { accountId: 0x11 + slot } : {}), charaId: 602002, weapons });
  arm(0, 0, true); arm(1, 0, false); arm(2, 0, false);
  A.setRespawnCount(1); B.setRespawnCount(1); C.setRespawnCount(1);
  let botSlots: number[] = [];
  if (bots) botSlots = A.allocBotSlots([0, 1, 0, 1, 0, 1, 0, 1]); // fill seats from 15 down, as an 8v8 AI room does
  const seen = new Map<string, PlayerState[]>();
  const tap = (n: PbBattleNet, name: string) => n.onRemoteState((s) => { const k = `${name}<-${s.id}`; (seen.get(k) ?? seen.set(k, []).get(k)!).push(s); });
  tap(A, "A"); tap(C, "C");
  let i = 0;
  const pumpFor = (n: PbBattleNet, team: 0 | 1, base: number) => setInterval(() => n.sendState(state(n.localId, team, i, base)), 40);
  const pumpA = setInterval(() => { A.sendState(state(A.localId, 0, i, 5)); i++; }, 40);
  const pB = pumpFor(B, 1, -5), pC = pumpFor(C, 0, 8);
  await sleep(800);
  check(`${label}: A sees B before it leaves`, (seen.get("A<-slot1")?.length ?? 0) > 5);
  // B quits: its link drops
  clearInterval(pB);
  if (!abrupt) B.dispose(); // abrupt: a crashed / reloaded tab, its link is still up when the new client offers
  rows[1] = { slot: 1, nick: "", state: 0, team: 1, rank: 0 }; // SLOTINFO: the seat is empty (the ack stays cached)
  await sleep(600);
  // the rejoiner: a new client (new PbBattleNet) on `rejoinSlot`
  rows[rejoinSlot] = { slot: rejoinSlot, nick: `P${rejoinSlot}`, state: 19, team: rejoinSlot % 2, rank: 0 };
  acks.set(rejoinSlot, ack(rejoinSlot, 2)); // the new occupant's RESPAWN_ACK
  const R = mk(rejoinSlot, false, [...slots.filter((s) => s !== 1), rejoinSlot], rm(rejoinSlot));
  const rawR: ActionIn[] = [];
  const orig = R.link.onActions!;
  R.link.onActions = (acts, t) => { rawR.push(...acts); orig(acts, t); };
  const seenByR: string[] = [];
  R.onRemoteState((s) => { seenByR.push(s.id); });
  const rid = `slot${rejoinSlot}`;
  const yielded: string[] = [];
  A.onBotYield((id) => yielded.push(id));
  if (botOnSeat) A.claimBots([rejoinSlot]); // the host's AI holds the seat the server gives the player (it knows no AI seat)
  const mark = seen.get(`A<-${rid}`)?.length ?? 0, markC = seen.get(`C<-${rid}`)?.length ?? 0;
  if (abrupt) arm(rejoinSlot, 1, false); // the new occupant's RESPAWN_ACK beat its link: the core applies it to the old registration
  await R.connect();
  // Server.Game's RESPAWN_ACK for the new occupant reaches the leader's bridge: the type-2 sync of an already spawned slot
  if (!withRoom && !abrupt) arm(rejoinSlot, 1, false); // with a room the bridge re-arms the slot itself (replaySlot)
  R.setRespawnCount(2);
  const pR = pumpFor(R, (rejoinSlot % 2) as 0 | 1, -5);
  await sleep(1200);
  check(`${label}: leader A gets the rejoiner's states`, (seen.get(`A<-${rid}`)?.length ?? 0) - mark > 10, `${(seen.get(`A<-${rid}`)?.length ?? 0) - mark} states`);
  const lastA = seen.get(`A<-${rid}`)?.at(-1), lastC = seen.get(`C<-${rid}`)?.at(-1);
  check(`${label}: both read it alive at full life`, !!lastA?.alive && lastA.hp === 100 && !!lastC?.alive && lastC.hp === 100, `A ${lastA?.hp}/${lastA?.alive} C ${lastC?.hp}/${lastC?.alive}`);
  check(`${label}: guest C gets the rejoiner's states`, (seen.get(`C<-${rid}`)?.length ?? 0) - markC > 10);
  check(`${label}: rejoiner sees A and C`, seenByR.includes("slot0") && seenByR.includes("slot2"));
  if (botOnSeat) check(`${label}: the bot yields the seat to the player`, yielded.join() === rid, `yielded [${yielded}]`);
  const m = rawR.length;
  A.link.send({ hits: [{ start: [5, 1.5, -10], end: [-5, 1.5, -10], victimSlot: rejoinSlot, damage: 30, part: 1, objectType: 1, weaponId: weapons.primary }] });
  const hp = await new Promise<ActionIn | null>((res) => {
    const t0 = Date.now();
    const t = setInterval(() => { const a = rawR.slice(m).find((x) => x.slot === rejoinSlot && x.hp === 70); if (a || Date.now() - t0 > 2000) { clearInterval(t); res(a ?? null); } }, 20);
  });
  check(`${label}: A's hit on the rejoiner lands (HpSync 70)`, !!hp, JSON.stringify((await local.stats()).players));
  void botSlots;
  clearInterval(pR); clearInterval(pC); clearInterval(pumpA);
  A.dispose(); C.dispose(); R.dispose(); if (abrupt) B.dispose();
  await sleep(900);
}

async function main(): Promise<void> {
  const gw = await startSignalServer();
  try {
    await scenario("same slot", 1, false);
    await scenario("other slot", 3, false);
    await scenario("same slot + bots", 1, true);
    await scenario("other slot + bots", 3, true);
    await scenario("room: same slot", 1, false, true);
    await scenario("room: other slot + bots", 3, true, true);
    await scenario("room, a bot holds the seat: same slot", 1, true, true, false, true);
    await scenario("room, a bot holds the seat: other slot", 3, true, true, false, true);
    await scenario("room, old link still up: same slot", 1, false, true, true);
    await scenario("room, old link still up: same slot + bots", 1, true, true, true);
  } finally { gw.kill(); }
  const ok = results.every((r) => r.ok);
  if (!ok) for (const l of hostLog.slice(-60)) console.log(`  [host] ${l}`);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks\nRESULT: ${ok ? "PASS" : "FAIL"} — rejoin`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { for (const l of hostLog.slice(-60)) console.log(`  [host] ${l}`); console.error("RESULT: FAIL —", e instanceof Error ? e.stack : e); process.exit(1); });
