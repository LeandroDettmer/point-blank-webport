// P2P match, 2 peers, no browser:  npm run test:p2p   (node src/p2p/test/p2p2peers.test.ts)
// A = room leader: the Server.Match port (src/host/matchCore.ts) in a real Worker thread + RtcHost; B = guest over WebRTC
// (node-datachannel's W3C polyfill). Signaling: a signal-only server web front started here (server/tools/signal-server.ts) on its own port.
// Both sides are the real PbBattleNet / MatchLink ; the Server.Game respawn feed (RESPAWN_ACK 5138 ->
// RespawnSync) is injected as src/host/bridge.ts would. Checks: register 65/66 both, positions + ActionState at 25 Hz
// both ways, a relayed hit, server-side damage (User hits: HP 100 -> 40 -> death with killer/headshot, the DeathSync to
// Game), hits on a dead player refused, respawn (type 2 sync) and a new hit accepted, a spoofed slot dropped, match end
// (1001 to the guest), host-leaves.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { PbBattleNet } from "../../net/battle.ts";
import { signalTicketEnv, testTicket } from "./signalTickets.ts";
import { buildGameData, encodeUserAction, type ActionIn } from "../../net/matchUdp.ts";
import type { WorkerLike } from "../../host/local.ts";
import type { GameSyncOut, MatchData } from "../../host/matchCore.ts";
import type { PlayerState, KillEvent, HitEvent } from "../../game/netAdapter";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const PORT = Number(process.env.P2P_TEST_PORT ?? 18090);
const GW = `ws://127.0.0.1:${PORT}`;
const t0 = Date.now();
const log = (who: string, msg: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s [${who}] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hostLog: string[] = [];
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); log(ok ? "ok" : "FAIL", `${name}${detail ? ` — ${detail}` : ""}`); };
function until<T>(what: string, ms: number, probe: () => T | undefined | null | false): Promise<T> {
  return new Promise((res, rej) => {
    const t = setInterval(() => { const v = probe(); if (v) { clearInterval(t); clearTimeout(to); res(v); } }, 10);
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
    gw.stdout!.on("data", (b: Buffer) => {
      const s = b.toString();
      if (process.env.P2P_TEST_VERBOSE) process.stdout.write(`[gw] ${s}`);
      if (s.includes("listening")) { clearTimeout(t); res(gw); }
    });
    gw.on("exit", (c) => rej(new Error(`signal server exited ${c}`)));
  });
}

function nodeWorker(): WorkerLike {
  const w = new Worker(new URL("./nodeHostWorker.ts", import.meta.url));
  const like: WorkerLike = {
    postMessage: (m) => w.postMessage(m),
    onmessage: null,
    onerror: null,
    terminate: () => { void w.terminate(); },
  };
  w.on("message", (m) => like.onmessage?.({ data: m }));
  w.on("error", (e) => { console.error("[worker]", e); like.onerror?.({ message: e.message }); });
  return like;
}

async function main(): Promise<void> {
  const gw = await startSignalServer();
  log("gw", `signal server on ${GW}`);
  const data = JSON.parse(readFileSync(resolve(root, "src/host/data/matchData.json"), "utf8")) as MatchData;

  // Server.Game room: server 1, channel 0, room 7; Metro TDM seed (map 36, rule 1, DeathMatch 4)
  const uniqueRoomId = (1 << 20) | (0 << 12) | 7;
  const roomSeed = (36 << 20) | (1 << 12) | 4;
  const roster = [{ slot: 0, name: "A", team: 0 as const }, { slot: 1, name: "B", team: 1 as const }];

  const common = { RTCPeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection, data, log: (l: string) => hostLog.push(l) };
  const A = new PbBattleNet({ session: { uniqueRoomId, roomSeed, slot: 0, accountId: 0x11, signalTicket: testTicket(uniqueRoomId, roomSeed, 0) }, roster, serverUrl: GW, p2p: { ...common, leader: true, worker: nodeWorker } });
  const B = new PbBattleNet({ session: { uniqueRoomId, roomSeed, slot: 1, accountId: 0x22, signalTicket: testTicket(uniqueRoomId, roomSeed, 1) }, roster, serverUrl: GW, p2p: { ...common, leader: false } });

  // raw decoded actions each side receives
  const rawA: ActionIn[] = [], rawB: ActionIn[] = [];
  const tap = (n: PbBattleNet, sink: ActionIn[]) => { const orig = n.link.onActions!; n.link.onActions = (acts, t) => { sink.push(...acts); orig(acts, t); }; };
  tap(A, rawA);
  tap(B, rawB);
  let bClosed = "";
  B.link.onClose = (r) => { bClosed = r; };

  // ---- connect: A hosts (Worker + /signal host), B offers over /signal, WebRTC, both REGISTER (65) -> CONNECT (66)
  const connB = B.connect(); // the guest may come first: it waits for the host on /signal
  await sleep(300);
  await A.connect();
  await connB;
  check("register 65 -> CONNECT 66 over the local peer (A) and over WebRTC (B)", A.link.connected && B.link.connected);
  const local = A.p2p!.host!.local;
  const game: GameSyncOut[] = [];
  local.onGame = (m) => game.push(m);
  check("host has 1 WebRTC guest bound to slot 1", A.p2p!.host!.rtc.slots().join() === "1", `slots [${A.p2p!.host!.rtc.slots()}]`);

  // ---- Server.Game respawn feed (what bridge.ts derives from RESPAWN_ACK 5138): A with its PlayerId byte, B trusted
  const start = Date.now();
  const weapons = { primary: 100003001, secondary: 601002003, melee: 702001001, explosive: 803007001, special: 904007002 };
  local.respawn({ uniqueRoomId, roomSeed, startTick: start, type: 0, round: 1, slot: 0, respawnCount: 1, accountId: 0x11, charaId: 602002, weapons });
  local.respawn({ uniqueRoomId, roomSeed, startTick: start, type: 0, round: 1, slot: 1, respawnCount: 1, charaId: 602002, weapons });
  A.setRespawnCount(1);
  B.setRespawnCount(1);
  await sleep(100);

  // ---- positions + 3PV ActionState both ways, 25 Hz for 3 s
  const gotA: PlayerState[] = [], gotB: PlayerState[] = [];
  A.onRemoteState((s) => gotA.push(s));
  B.onRemoteState((s) => gotB.push(s));
  const hitsB: HitEvent[] = [];
  B.onRemoteHit((e) => hitsB.push(e));
  const killsB: KillEvent[] = [], killsA: KillEvent[] = [];
  B.onRemoteKill((k) => killsB.push(k));
  A.onRemoteKill((k) => killsA.push(k));
  const TORSO = ["idle", "fire", "reload", "change", "zoom"] as const;
  const state = (id: string, team: 0 | 1, i: number, base: number, hp = 100): PlayerState => ({
    id, name: id, team, pos: [base + i * 0.1, 0.5, -10 - i * 0.05], vel: [1, 0, 1], yaw: (i * 0.05) % 6, pitch: 0.1,
    crouch: i % 20 < 10, alive: hp > 0, hp, weapon: "K-2", firing: false, t: Date.now(),
    torsoAction: TORSO[i % TORSO.length], moving: i % 3 !== 0, running: i % 6 < 3, moveDir: i % 8, zoomType: i % 3 === 0 ? 2 : 0,
  });
  let i = 0;
  let bHp = 100;
  let pump = setInterval(() => {
    A.sendState(state(A.localId, 0, i, 5));
    B.sendState(state(B.localId, 1, i, -5, bHp));
    if (i === 30) A.sendHit({ attackerId: A.localId, victimId: B.localId, weapon: "K-2", zone: "head", baseDamage: 25, helmetPenetrate: 50, falloff: 1, point: [-5, 1.6, -12], t: Date.now() });
    i++;
  }, 40);
  const rxA0 = A.link.rxPackets, rxB0 = B.link.rxPackets;
  await sleep(3000);
  const rateA = (A.link.rxPackets - rxA0) / 3, rateB = (B.link.rxPackets - rxB0) / 3;
  const near = (p: number[] | undefined, q: number[]) => !!p && Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.5;
  const lastAseesB = A.latest(1), lastBseesA = B.latest(0);
  check("positions both ways at ~25 Hz", near(lastAseesB?.pos, state("", 1, i - 1, -5).pos) && near(lastBseesA?.pos, state("", 0, i - 1, 5).pos) && rateA > 18 && rateB > 18,
    `A rx ${rateA.toFixed(1)}/s B rx ${rateB.toFixed(1)}/s; A sees B at ${lastAseesB?.pos.map((v) => v.toFixed(2))}`);
  const torso = new Set(gotA.map((s) => s.torsoAction)), dirs = new Set(gotA.map((s) => s.moveDir));
  check("ActionState bits (torso / move / dir / zoom / crouch) survive the host", torso.size === 5 && dirs.size >= 4 && gotA.some((s) => s.crouch) && gotA.some((s) => s.running) && gotA.some((s) => s.zoomType === 2),
    `torso ${[...torso]} dirs ${dirs.size}`);
  check("relayed hit (UserObject, victim-authoritative web hit) reaches the victim", hitsB.some((h) => h.attackerId === "slot0" && h.victimId === "slot1" && h.zone === "head"), `${hitsB.length} hit(s)`);
  const weaponSync = rawB.find((a) => a.slot === 0 && a.flags === 0x04000000 && a.weaponId === weapons.primary);
  check("ActionState -> server WeaponSync event (ObjectHitInfo 6, equipment from RespawnSync)", !!weaponSync);

  // ---- server-side damage: User hits (ObjectType 1) as the original client sends them: 36 torso (K-2 27 x Body 1.2 x the
  // +10 % coupon, the most theanti-cheat lets a K-2 body hit carry), then a 200 head hit (CalcHeadShotDamage)
  const userHit = (damage: number, part: number) => A.link.send({ hits: [{ start: [5, 1.5, -10], end: [-5, 1.5, -12], victimSlot: 1, damage, part, objectType: 1, weaponId: weapons.primary }] });
  const mark = rawB.length;
  userHit(36, 1);
  const hp64 = await until("B hp 64 event", 2000, () => rawB.slice(mark).find((a) => a.slot === 1 && a.hp === 64 && !a.death)).catch(() => null);
  check("User hit 36: Server.Match damage -> HpSync 64 to the victim", !!hp64);
  userHit(200, 14);
  const death = await until("B death event", 2000, () => rawB.slice(mark).find((a) => a.slot === 1 && a.death)).catch(() => null);
  check("second hit (head): life 0 -> death event (killer slot 0, HEADSHOT)", !!death && death.hp === 0 && death.death!.killerSlot === 0 && death.death!.deathType === 3 && death.death!.hitPart === 14,
    death ? JSON.stringify(death.death) : "none");
  check("victim's PbBattleNet emits the kill", killsB.some((k) => k.killerId === "slot0" && k.victimId === "slot1" && k.headshot));
  const ds = await until("DeathSync to Game", 1000, () => game.find((g) => g.t === "death")).catch(() => null);
  check("Match -> Game DeathSync (SendMatchInfo 3) for the bridge", !!ds && ds.t === "death" && ds.killerSlot === 0 && ds.deaths[0]?.slot === 1 && ds.deaths[0]?.deathType === 3, ds ? JSON.stringify({ k: ds.t === "death" && ds.killerSlot, d: ds.t === "death" && ds.deaths }) : "none");
  bHp = 0;

  // ---- dead: further hits refused (the periodic life record, subHead 8 + HpSync after a WeaponSync, is not a hit reply)
  const mark2 = rawB.length;
  userHit(30, 1);
  await sleep(400);
  check("hit on a dead player refused (no HP event)", !rawB.slice(mark2).some((a) => a.slot === 1 && a.hp !== undefined && (a.flags & 0x08) && !a.posRot && a.sub !== 8));

  // ---- respawn: Server.Game RESPAWN_ACK #2 for B -> RespawnSync type 2; B alive again, a hit counts again
  local.respawn({ uniqueRoomId, roomSeed, startTick: start, type: 2, round: 1, slot: 1, respawnCount: 2, charaId: 602002, weapons });
  B.setRespawnCount(2);
  bHp = 100;
  await sleep(200);
  const mark3 = rawB.length;
  userHit(30, 1);
  const hp70 = await until("B hp 70 after respawn", 2000, () => rawB.slice(mark3).find((a) => a.slot === 1 && a.hp === 70 && !a.posRot)).catch(() => null);
  check("respawn sync (type 2): life back to MaxLife, next hit 30 -> HpSync 70", !!hp70);
  const st = await local.stats();
  const pl1 = st.players.find((p) => p.slot === 1);
  check("host state: slot 1 alive, life 70, respawn 2", !!pl1 && !pl1.dead && pl1.life === 70 && pl1.respawn === 2, JSON.stringify(pl1));

  // ---- a guest speaking for another slot is dropped by the host
  const spoof = buildGameData({ slot: 0, time: 1, round: 0, respawn: 1, roundNumber: 0, accountId: 0x11, unk1: 0 },
    encodeUserAction(0, { posRot: { x: 999, y: 999, z: 999, yaw: 0, pitch: 0, area: 0 } }), { uniqueRoomId, roomSeed });
  B.p2p!.transport.send(spoof, false);
  await sleep(300);
  const st2 = await local.stats();
  check("spoofed slot from the guest dropped", st2.spoofed >= 1 && !rawA.some((a) => a.posRot && a.posRot.x > 900), `spoofed ${st2.spoofed}, relayed ${st2.relayed}, rx ${st2.rx}`);

  // ---- end of the match (ENDBATTLE on the leader -> bridge -> every peer closed 1001)
  clearInterval(pump);
  local.end("ENDBATTLE");
  await until("B link closed", 3000, () => bClosed).catch(() => null);
  check("match end: the guest's link closes with 1001", /1001/.test(bClosed), bClosed || "still open");

  A.dispose();
  B.dispose();
  await sleep(900);
  gw.kill();
  const ok = results.every((r) => r.ok);
  if (!ok || process.env.P2P_TEST_VERBOSE) for (const l of hostLog) console.log(`  [host] ${l}`);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks\nRESULT: ${ok ? "PASS" : "FAIL"} — P2P match (leader-hosted Server.Match port over WebRTC), 2 peers`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  for (const l of hostLog) console.log(`  [host] ${l}`);
  console.error("RESULT: FAIL —", e instanceof Error ? e.stack : e);
  process.exit(1);
});
