// AI slots, host-owned:  node src/p2p/test/p2pbots.test.ts
// A = leader (slot 0, hosts the match core AND the bots), B (slot 2) and C (slot 4) = guests, all on team 0; the bots take free
// odd/even seats. The bots are the host's: A sends one slot record per bot (PbBattleNet.sendBotStates, what game.ts does with
// Bot.netState()), B and C only render them. Checks: both guests see the same position / team / name for every bot, a guest's
// hit on a bot reaches the host (which owns its hp), a bot's death and a bot's kill of a player are ONE kill event on every
// peer (no Server.Game report), and after A leaves B takes the bots over from its last replicated states (position and dead
// flags kept) and C sees them move on from where they were.
// Bomb Mission: the host's bots plant / defuse through Server.Game's path (5156 / 5158 in the bot's slot -> 5157 / 5159 + round end to
// everybody; a stand-in server here, the real handler is server/test/botBomb.test.ts): every peer plants with the same fuse left
// (+-0.2 s), the defuse ends the round the same on all, and a host change in the middle of a plant hold carries the plant on.
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { PbBattleNet } from "../../net/battle.ts";
import { encodeUserAction } from "../../net/matchUdp.ts";
import { botNameOfSlot } from "../../game/botNames.ts";
import { BombMode, BOMB, type Vec3 as BombVec3 } from "../../game/bombMode.ts";
import { BotBombDriver, type BombBot, type BotBombIO } from "../../game/botBomb.ts";
import { signalTicketEnv, testTicket } from "./signalTickets.ts";
import type { RoomClient } from "../../net/roomClient.ts";
import type { RespawnAck } from "../../net/metaGame.ts";
import type { WorkerLike } from "../../host/local.ts";
import type { MatchData } from "../../host/matchCore.ts";
import type { HitEvent, KillEvent, PlayerState } from "../../game/netAdapter";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const PORT = Number(process.env.P2P_TEST_PORT ?? 18092);
const GW = `ws://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); console.log(`[${ok ? "ok" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`); };
function until<T>(what: string, ms: number, probe: () => T | undefined | null | false): Promise<T> {
  return new Promise((res, rej) => {
    const t = setInterval(() => { const v = probe(); if (v) { clearInterval(t); clearTimeout(to); res(v); } }, 20);
    const to = setTimeout(() => { clearInterval(t); rej(new Error(`timeout: ${what}`)); }, ms);
  });
}

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

const HUMANS = [0, 2, 4];
/** Just what PbBattleNet / HostBridge read of a RoomClient; counts the TCP kill reports (there must be none for AI kills). */
function stubRoom(mySlot: number, shared: { leaderSlot: number }, acks: RespawnAck[], reports: number[]): RoomClient {
  const respawnAcks = new Map(acks.map((a) => [a.slot, a]));
  const slots = Array.from({ length: 18 }, (_, slot) => HUMANS.includes(slot) ? { slot, nick: `P${slot}`, state: 19, team: slot % 2, rank: 0 } : { slot, nick: "", state: 0, team: slot % 2, rank: 0 });
  return {
    mySlot, respawnAcks, slots, room: null, onDeath: null, onRespawnAck: null,
    get leaderSlot() { return shared.leaderSlot; },
    get isLeader() { return shared.leaderSlot === mySlot; },
    game: { conn: { on: () => () => {} } },
    reportKill: (victim: number) => { reports.push(victim); },
    respawn: () => Promise.resolve(mySlot + 1), // BATTLE_RESPAWN_REQ: the slot's SpawnsCount (acks above)
  } as unknown as RoomClient;
}

type V3 = [number, number, number];
const near = (a: V3 | undefined, b: V3 | undefined, tol: number) => !!a && !!b && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol;

// ---- Bomb Mission stand-ins: Server.Game's bomb (roomHandlers.ts handleBombInstall / handleBombUninstall + startBomb) and a peer's view of it
interface TestBot extends BombBot { slot: number; feet: BombVec3 }
class BombView {
  readonly bm: BombMode;
  readonly rounds: { winner: number; motive: number }[] = [];
  private last = Date.now();
  private t: ReturnType<typeof setInterval>;
  constructor(sites: { pos: BombVec3; area: number }[]) {
    this.bm = new BombMode(sites);
    this.bm.serverFuse = true; // online: the local clock only counts down for the display
    this.t = setInterval(() => {
      const now = Date.now(), dt = (now - this.last) / 1000; this.last = now;
      this.bm.update(dt, { team: 0, alive: true, pos: [0, 0, 0], plantHeld: false, defuseHeld: false, hasC4: false });
    }, 25);
  }
  /** game.ts r.onBomb / syncFuse */
  planted(zone: number, pos: BombVec3, fuse?: number): void {
    const b = this.bm;
    if (fuse === undefined) { if (b.state === "idle") b.plant(zone, pos); return; }
    if (b.state === "idle") b.plant(zone, pos, BOMB.fuse - fuse);
    else if (b.state === "planted" && Math.abs(b.fuseLeft - fuse) > 0.25) b.fuseLeft = fuse;
  }
  stop(): void { clearInterval(this.t); }
}
class FakeBombServer {
  views: BombView[] = [];
  asks: { kind: "install" | "uninstall"; slot: number }[] = [];
  plants = 0;
  active = false;
  private endAt = 0;
  private zone = 0;
  private pos: BombVec3 = [0, 0, 0];
  private sync: ReturnType<typeof setInterval> | null = null;
  left(): number { return Math.max(0, (this.endAt - Date.now()) / 1000); }
  install(slot: number, zone: number, pos: BombVec3): void {
    this.asks.push({ kind: "install", slot });
    if (this.active) return; // activeC4: a retry is ignored
    this.active = true; this.plants++; this.zone = zone; this.pos = pos;
    this.endAt = Date.now() + BOMB.fuse * 1000;
    for (const v of this.views) v.planted(zone, pos);
    this.sync = setInterval(() => { const l = Math.round(this.left() * 10) / 10; for (const v of this.views) v.planted(this.zone, this.pos, l); }, 1000);
  }
  uninstall(slot: number): void {
    this.asks.push({ kind: "uninstall", slot });
    if (!this.active) return;
    this.stop();
    for (const v of this.views) { v.bm.defuse(); v.rounds.push({ winner: 1, motive: 3 }); } // 5159 + 5155 (defenders, Uninstall)
  }
  stop(): void { this.active = false; if (this.sync) clearInterval(this.sync); this.sync = null; }
  newRound(): void { this.stop(); for (const v of this.views) v.bm.reset(0); }
}

async function main(): Promise<void> {
  const gw = await startSignalServer();
  const data = JSON.parse(readFileSync(resolve(root, "src/host/data/matchData.json"), "utf8")) as MatchData;
  const uniqueRoomId = (1 << 20) | 9, roomSeed = (36 << 20) | (1 << 12) | 4;
  const roster = HUMANS.map((slot) => ({ slot, name: `P${slot}`, team: 0 as const }));
  const weapons = { primary: 100003001, secondary: 601002003, melee: 702001001, grenade: 803007001, special: 904007002 };
  const acks: RespawnAck[] = HUMANS.map((slot) => ({ slot, roomSpawns: 3, slotSpawns: slot + 1, weapons, chara: 0, parts: [], beret: 0, accessory: 0 }));
  const shared = { leaderSlot: 0 };
  const reports: number[] = [];
  const common = { RTCPeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection, data, worker: nodeWorker, log: (l: string) => { if (process.env.P2P_TEST_VERBOSE) console.log("  [host]", l); } };
  const mk = (slot: number) => new PbBattleNet({
    session: { uniqueRoomId, roomSeed, slot, accountId: 0x10 + slot, signalTicket: testTicket(uniqueRoomId, roomSeed, slot) }, roster, serverUrl: GW,
    room: stubRoom(slot, shared, acks, reports), p2p: { ...common },
  });
  const [A, B, C] = [mk(0), mk(2), mk(4)];
  A.setRespawnCount(1); B.setRespawnCount(3); C.setRespawnCount(5);
  const conns = [B.connect(), C.connect()];
  await sleep(300);
  await A.connect();
  await Promise.all(conns);
  A.p2p!.host!.bridge!.replay(); // the RESPAWN_ACKs of the stub room reach the core (a real room feeds them as RESPAWN 5138 arrive)
  await sleep(300);
  check("3 peers registered on A's core; A is the bot host, the guests are not", A.link.connected && B.link.connected && C.link.connected && A.isBotHost && !B.isBotHost && !C.isBotHost);

  // ---- the host allocates seats by team parity, away from the humans
  const slots = A.allocBotSlots([1, 1, 1, 0]);
  check("bot slots: team = parity, none on a human seat, 16/17 kept free", slots.length === 4 && slots.every((s, i) => s % 2 === [1, 1, 1, 0][i] && !HUMANS.includes(s) && s < 16) && new Set(slots).size === 4, slots.join());
  const [b1, b2, b3, b4] = slots; // b4 = the only team-0 bot
  const idOf = (s: number) => `slot${s}`;

  // ---- A simulates the bots (a stand-in for Bot.update + netState) and replicates them at 25 Hz
  const holdTorso = (b: TestBot | undefined): PlayerState["torsoAction"] => (b?.alive && b.holding && b.holdKind ? b.holdKind : "idle");
  const tbotsA = new Map<number, TestBot>();
  const botState = (slot: number, k: number, over: Partial<PlayerState> = {}): PlayerState => ({
    id: idOf(slot), name: botNameOfSlot(slot), team: (slot % 2) as 0 | 1, pos: [slot * 1.5 + k * 0.05, 0.5, -10 + slot * 0.25], vel: [1.25, 0, 0], yaw: slot * 0.1, pitch: 0, crouch: false, alive: true, hp: 100,
    weapon: "K-2", weaponSlot: 0, firing: false, torsoAction: holdTorso(tbotsA.get(slot)), moving: true, running: false, zoomType: 0, bot: true, t: Date.now(), ...over,
  });
  let k = 0;
  const dead = new Set<number>();
  let simulator: PbBattleNet = A; // whoever is the host drives the bots
  const sim = setInterval(() => {
    k++;
    if (!simulator.botSendDue()) return;
    simulator.sendBotStates(slots.map((s) => botState(s, k, dead.has(s) ? { alive: false, hp: 0, moving: false } : {})));
  }, 20);

  const kills: Record<string, KillEvent[]> = { A: [], B: [], C: [] };
  const hitsA: HitEvent[] = [], hitsB: HitEvent[] = [];
  A.onRemoteKill((e) => kills.A.push(e)); B.onRemoteKill((e) => kills.B.push(e)); C.onRemoteKill((e) => kills.C.push(e));
  A.onRemoteHit((e) => hitsA.push(e)); B.onRemoteHit((e) => hitsB.push(e));
  const seenB = new Map<string, PlayerState>(), seenC = new Map<string, PlayerState>();
  B.onRemoteState((s) => seenB.set(s.id, s)); C.onRemoteState((s) => seenC.set(s.id, s));
  // humans keep sending too (a dead / alive human is a plain player record)
  const human = (n: PbBattleNet, x: number, over: Partial<PlayerState> = {}): PlayerState => ({ id: n.localId, name: n.localId, team: 0, pos: [x, 0.5, -5], vel: [0, 0, 0], yaw: 0, pitch: 0, crouch: false, alive: true, hp: 100, weapon: "K-2", firing: false, t: Date.now(), ...over });
  const humanOver = new Map<PbBattleNet, Partial<PlayerState>>();
  const pump = setInterval(() => { for (const [n, x] of [[B, -3], [C, 3], [A, 0]] as [PbBattleNet, number][]) n.sendState(human(n, x, humanOver.get(n))); }, 40);

  await until("guests see every bot", 6000, () => slots.every((s) => seenB.has(idOf(s)) && seenC.has(idOf(s))));
  await sleep(600);
  const sameAll = slots.every((s) => { const x = B.latest(s), y = C.latest(s); return !!x && !!y && near(x.pos, y.pos, 1e-6) && x.yaw === y.yaw && x.hp === y.hp && x.team === y.team && x.name === y.name; });
  check("B and C see the same position / aim / hp / team / name for every bot", sameAll);
  const first = B.latest(b1)!;
  check("bot records carry the bot flag, its seat team and the slot's derived name", first.bot === true && first.team === 1 && first.name === botNameOfSlot(b1) && B.latest(b4)!.team === 0 && B.latest(b4)!.bot === true, `${first.name} team ${first.team}`);
  const truth = botState(b2, k);
  check("replicated position follows the host's bot (half-float quantisation only)", near(B.latest(b2)!.pos, truth.pos, 2.5), JSON.stringify(B.latest(b2)!.pos));
  check("the host got none of its own bots back (no echo)", A.latest(b1) === undefined && A.botSnapshot().length === 4);

  // ---- a guest shoots a bot: the hit reaches the host, which owns the bot's hp
  B.sendHit({ attackerId: B.localId, victimId: idOf(b1), weapon: "K-2", zone: "head", baseDamage: 50, helmetPenetrate: 0, falloff: 1, point: [0, 1.5, -10], t: Date.now() });
  const hit = await until("host gets the hit", 3000, () => hitsA.find((h) => h.victimId === idOf(b1) && h.attackerId === B.localId)).catch(() => null);
  check("a guest's hit on a bot reaches the host (victim = the bot slot, zone head, 50)", !!hit && hit.zone === "head" && hit.baseDamage === 50, JSON.stringify(hit));
  const bystander = await sleep(300).then(() => hitsB.some((h) => h.victimId === idOf(b1)));
  check("the shooter is not echoed its own hit", !bystander);

  // ---- the host's bot dies (host game: onDeath -> sendBotKill, then the dead state): ONE kill on every peer
  dead.add(b1);
  A.sendBotKill({ killerId: B.localId, victimId: idOf(b1), weapon: "K-2", headshot: true, t: Date.now() });
  await until("kill on B and C", 3000, () => kills.B.length && kills.C.length);
  await sleep(700); // the dead state keeps coming: it must not repeat the kill
  const kb = kills.B[0], kc = kills.C[0];
  check("bot death = one kill on B and C: killer B, victim the bot, headshot, weapon K-2", kills.B.length === 1 && kills.C.length === 1 && kb.killerId === B.localId && kb.victimId === idOf(b1) && kb.headshot && kc.killerId === B.localId && kc.victimId === idOf(b1) && kc.weapon === "K-2" && kb.weapon === "K-2", JSON.stringify(kc));
  check("the dead bot reads hp 0 / not alive on both guests", B.latest(b1)!.hp === 0 && !B.latest(b1)!.alive && !C.latest(b1)!.alive);
  check("no DEATH_REQ went to Server.Game for the AI kill (killer B would have reported the bot slot)", !reports.includes(b1), `reports ${reports.join()}`);

  // ---- a bot kills a player: the bot's hit lands on the guest, the guest's death mark names the bot slot
  A.sendHit({ attackerId: idOf(b2), victimId: B.localId, weapon: "K-2", zone: "torso", baseDamage: 27, helmetPenetrate: 0, falloff: 1, point: [0, 1, -5], t: Date.now() });
  const botHit = await until("B gets the bot's hit", 3000, () => hitsB.find((h) => h.attackerId === idOf(b2) && h.victimId === B.localId)).catch(() => null);
  check("a bot's hit rides its own record: the victim sees the bot slot as the attacker", !!botHit && botHit.baseDamage === 27, JSON.stringify(botHit));
  B.sendKill({ killerId: idOf(b2), victimId: B.localId, weapon: "K-2", headshot: false, t: Date.now() });
  humanOver.set(B, { alive: false, hp: 0 });
  await until("kill of B on A and C", 3000, () => kills.A.find((e) => e.victimId === B.localId) && kills.C.find((e) => e.victimId === B.localId));
  await sleep(500);
  const ka = kills.A.filter((e) => e.victimId === B.localId), kc2 = kills.C.filter((e) => e.victimId === B.localId);
  check("a player killed by a bot = one kill on the other peers, killer = the bot slot", ka.length === 1 && kc2.length === 1 && ka[0].killerId === idOf(b2) && kc2[0].killerId === idOf(b2), JSON.stringify(ka[0]));
  check("still no Server.Game report", !reports.includes(2) && reports.length === 0, reports.join());
  humanOver.delete(B);

  // ---- Bomb Mission, round 1 (A hosts): bot b4 (team 0 = attackers) plants, bot b2 (team 1) defuses
  const SITE: BombVec3 = [10, 0.5, -3];
  const sites = [{ pos: SITE, area: 0 }];
  const vA = new BombView(sites), vB = new BombView(sites), vC = new BombView(sites);
  const srv = new FakeBombServer();
  srv.views = [vA, vB, vC];
  const mkTb = (slot: number, alive: boolean, feet: BombVec3): TestBot => ({ id: idOf(slot), slot, alive, team: slot % 2, inCombat: false, holding: false, holdKind: null, feet });
  for (const t of [mkTb(b1, false, [60, 0.5, 60]), mkTb(b2, true, [SITE[0] + 1, SITE[1], SITE[2]]), mkTb(b3, true, [60, 0.5, 60]), mkTb(b4, true, [SITE[0], SITE[1], SITE[2]])]) tbotsA.set(t.slot, t);
  const io: BotBombIO<TestBot> = {
    feet: (b) => b.feet, goto: () => {},
    install: (b, site, pos) => srv.install(b.slot, site, pos),
    uninstall: (b) => srv.uninstall(b.slot),
  };
  const drvA = new BotBombDriver<TestBot>(vA.bm, io);
  let round = 1;
  const VDT = 0.1; // the holds run at 10x so the test is quick; the server fuse is real time
  const bombSimA = setInterval(() => drvA.update(VDT, [...tbotsA.values()], round), 20);
  const sawTorso = (n: PbBattleNet, slot: number, t: string) => until(`${t} seen`, 8000, () => n.latest(slot)?.torsoAction === t).then(() => true, () => false);
  const [plantB, plantC] = await Promise.all([sawTorso(B, b4, "plant"), sawTorso(C, b4, "plant")]);
  check("while the bot holds the plant the guests see the C4 hold (torso 'plant') on its record", plantB && plantC);
  await until("bomb planted on every peer", 8000, () => [vA, vB, vC].every((v) => v.bm.state === "planted"));
  const fuseOk = () => [vA, vB, vC].every((v) => Math.abs(v.bm.fuseLeft - srv.left()) <= 0.2) && Math.abs(vB.bm.fuseLeft - vC.bm.fuseLeft) <= 0.2;
  check("bot plant: A, B and C all have it planted at the same site with the server's fuse left (+-0.2 s)", fuseOk() && [vA, vB, vC].every((v) => v.bm.planted?.site === 0 && near(v.bm.planted!.pos, SITE, 1e-6)), [vA, vB, vC].map((v) => v.bm.fuseLeft.toFixed(2)).join(" / ") + " server " + srv.left().toFixed(2));
  check("the plant was asked ONCE, in the bot's slot (not a human's)", srv.asks.filter((a) => a.kind === "install").length === 1 && srv.asks[0].slot === b4 && !HUMANS.includes(srv.asks[0].slot), JSON.stringify(srv.asks));
  await sleep(1300); // a server resync passes
  check("the fuse still agrees after the 1 s server resync", fuseOk(), [vA, vB, vC].map((v) => v.bm.fuseLeft.toFixed(2)).join(" / ") + " server " + srv.left().toFixed(2));
  const [defB, defC] = await Promise.all([sawTorso(B, b2, "defuse"), sawTorso(C, b2, "defuse")]);
  check("the defending bot's hold shows as 'defuse' on both guests", defB && defC);
  await until("round 1 over on every peer", 8000, () => [vA, vB, vC].every((v) => v.rounds.length === 1));
  check("bot defuse: the round ends the same on A, B and C (defenders, Uninstall) and the bomb reads defused", [vA, vB, vC].every((v) => v.rounds[0].winner === 1 && v.rounds[0].motive === 3 && v.bm.state === "defused") && srv.asks.some((a) => a.kind === "uninstall" && a.slot === b2), JSON.stringify(srv.asks));
  check("nothing holds any more once it is over", !tbotsA.get(b4)!.holding && !tbotsA.get(b2)!.holding);

  // ---- bandwidth: what one bot costs per second
  const rec = encodeUserAction(b1, { actionState: { action: 0, value: 0, weaponFlag: 0 }, posRot: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, area: 0 }, hp: 100 }).length;
  console.log(`  bandwidth: ${rec} B per bot record x 25 Hz = ${rec * 25} B/s per bot sent by the host (+ ~4 B/record the core adds on the relay, + 6 B WeaponSync / s)`);

  // ---- host change: A leaves; B (new leader) adopts the bots from what it last saw, C follows
  const lastBefore = new Map(slots.map((s) => [s, C.latest(s)!]));
  const deadBefore = B.botSnapshot().find((s) => s.id === idOf(b1));
  check("before the change B holds the last state of all 4 bots (the dead one dead)", B.botSnapshot().length === 4 && deadBefore?.alive === false);
  const adopted: PlayerState[] = [];
  const offB = B.onBotHost((host) => {
    if (!host) return;
    adopted.push(...B.botSnapshot());
    B.claimBots(adopted.map((s) => Number(s.id.slice(4))));
    simulator = B; // the game builds Bot objects from the snapshot and keeps simulating
  });
  // Bomb Mission, round 2: the host dies in the middle of the plant hold
  srv.newRound(); round = 2;
  await until("A's bot is mid-plant", 8000, () => tbotsA.get(b4)!.holding && drvA.progress > 0.3 && drvA.progress < 0.8);
  await sleep(150); // its 'plant' torso reaches B's last records (what the new host adopts)
  check("host dies mid-plant: nothing is planted yet", !srv.active && srv.plants === 1);
  clearInterval(bombSimA);
  A.dispose();
  clearInterval(sim);
  await sleep(200);
  shared.leaderSlot = 2;
  await until("B hosts", 20000, () => B.p2p?.leader && B.link.connected && B.isBotHost);
  await until("B adopted the bots", 3000, () => adopted.length === 4);
  check("B (new match host) adopted all 4 bots, the dead one still dead", adopted.length === 4 && adopted.find((s) => s.id === idOf(b1))?.alive === false);
  check("adopted positions are where the old host's bots were (what B had rendered)", slots.every((s) => near(adopted.find((a) => a.id === idOf(s))!.pos, lastBefore.get(s)!.pos, 3)));
  await until("C reconnected to B", 20000, () => C.p2p && !C.p2p.leader && C.link.connected && B.p2p!.host!.rtc.slots().includes(4));
  // B simulates from the adopted states (continuing along the same path)
  const adoptedById = new Map(adopted.map((s) => [s.id, s]));
  // game.ts adoptBots + makeBotBomb: the new host builds its bots from the snapshot, its driver prefers the ones that were holding
  const tbotsB = new Map<number, TestBot>(adopted.map((s) => { const n = Number(s.id.slice(4)); return [n, mkTb(n, s.alive, tbotsA.get(n)!.feet)]; }));
  check("the old host's last records carried the plant hold (b4 'plant') into the snapshot", adopted.find((s) => s.id === idOf(b4))?.torsoAction === "plant");
  const drvB = new BotBombDriver<TestBot>(vB.bm, io);
  drvB.prefer(adopted.find((s) => s.torsoAction === "plant" && s.alive)?.id ?? null, adopted.find((s) => s.torsoAction === "defuse" && s.alive)?.id ?? null);
  const bombSimB = setInterval(() => drvB.update(VDT, [...tbotsB.values()], round), 20);
  let k2 = 0;
  const sim2 = setInterval(() => {
    k2++;
    if (!B.botSendDue()) return;
    B.sendBotStates(slots.map((s) => { const a = adoptedById.get(idOf(s))!; return { ...a, pos: [a.pos[0] + (a.alive ? k2 * 0.01 : 0), a.pos[1], a.pos[2]] as V3, torsoAction: holdTorso(tbotsB.get(s)), t: Date.now() }; }));
  }, 20);
  const seenAgain = new Map<string, PlayerState>();
  C.onRemoteState((s) => { if (s.bot) seenAgain.set(s.id, s); });
  await until("C sees the bots from B", 8000, () => slots.every((s) => seenAgain.has(idOf(s))));
  await sleep(400);
  check("C sees every bot continue from where it was (position within 3 m of before the change)", slots.every((s) => near(C.latest(s)?.pos, lastBefore.get(s)!.pos, 3)), slots.map((s) => C.latest(s)?.pos.map((n) => n.toFixed(1)).join("/")).join(" "));
  check("the dead bot is still dead on C and raised no second kill", C.latest(b1)!.alive === false && kills.C.filter((e) => e.victimId === idOf(b1)).length === 1);
  check("the bots are still flagged AI with the same names after the change", slots.every((s) => C.latest(s)?.bot === true && C.latest(s)?.name === botNameOfSlot(s)));

  // a hit from C on a bot goes to the new host
  const hitsB2: HitEvent[] = [];
  B.onRemoteHit((e) => hitsB2.push(e));
  C.sendHit({ attackerId: C.localId, victimId: idOf(b3), weapon: "K-2", zone: "torso", baseDamage: 27, helmetPenetrate: 0, falloff: 1, point: [0, 1, -10], t: Date.now() });
  const h2 = await until("new host gets the hit", 3000, () => hitsB2.find((h) => h.victimId === idOf(b3))).catch(() => null);
  check("after the change a guest's hit on a bot reaches the new host", !!h2);
  // and a bot of the new host dies: one kill on C
  const before = kills.C.length;
  B.sendBotKill({ killerId: C.localId, victimId: idOf(b3), weapon: "K-2", headshot: false, t: Date.now() });
  adoptedById.set(idOf(b3), { ...adoptedById.get(idOf(b3))!, alive: false, hp: 0 });
  await until("C kill of bot 3", 4000, () => kills.C.length > before);
  await sleep(400);
  check("new host's bot death = one kill on C (killer C)", kills.C.length === before + 1 && kills.C[before].victimId === idOf(b3) && kills.C[before].killerId === C.localId, JSON.stringify(kills.C[before]));
  check("still no Server.Game report", reports.length === 0, reports.join());

  // ---- Bomb Mission after the host change: the new host's bot finishes the plant, the others see it with the same fuse
  await until("planted again on B and C", 12000, () => vB.bm.state === "planted" && vC.bm.state === "planted");
  const fuse2 = () => [vB, vC].every((v) => Math.abs(v.bm.fuseLeft - srv.left()) <= 0.2) && Math.abs(vB.bm.fuseLeft - vC.bm.fuseLeft) <= 0.2;
  check("host change mid-plant: the new host's bot plants, ONE plant in round 2, asked in the bot's slot", srv.plants === 2 && srv.asks.filter((a) => a.kind === "install").length === 2 && srv.asks[srv.asks.length - 1].slot === b4 && drvB.carrier?.slot === b4);
  check("B and C hold the same fuse (+-0.2 s of the server)", fuse2(), [vB, vC].map((v) => v.bm.fuseLeft.toFixed(2)).join(" / ") + " server " + srv.left().toFixed(2));
  await until("round 2 over on B and C", 12000, () => vB.rounds.length === 2 && vC.rounds.length === 2);
  check("the new host's defender bot defuses: the round ends the same on B and C", [vB, vC].every((v) => v.rounds[1].winner === 1 && v.rounds[1].motive === 3 && v.bm.state === "defused") && srv.asks[srv.asks.length - 1].kind === "uninstall", JSON.stringify(srv.asks.slice(-2)));
  clearInterval(bombSimB);
  srv.stop();
  [vA, vB, vC].forEach((v) => v.stop());

  clearInterval(pump);
  clearInterval(sim2);
  offB();
  B.dispose();
  C.dispose();
  await sleep(900);
  gw.kill();
  const ok = results.every((r) => r.ok);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks\nRESULT: ${ok ? "PASS" : "FAIL"} — host-owned bots`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("RESULT: FAIL —", e instanceof Error ? e.stack : e); process.exit(1); });
