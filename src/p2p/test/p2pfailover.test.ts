// Host change:  node src/p2p/test/p2pfailover.test.ts
// A = leader (slot 0), B and C = guests over WebRTC. A leaves mid-match; the "server" (a stub RoomClient here) hands the
// room to B, which hosts a fresh match core with the cached RESPAWN_ACKs replayed; C reconnects to B and registers again.
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { PbBattleNet } from "../../net/battle.ts";
import { signalTicketEnv, testTicket } from "./signalTickets.ts";
import type { RoomClient } from "../../net/roomClient.ts";
import type { RespawnAck } from "../../net/metaGame.ts";
import type { WorkerLike } from "../../host/local.ts";
import type { MatchData } from "../../host/matchCore.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const PORT = Number(process.env.P2P_TEST_PORT ?? 18091);
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

/** Just what PbBattleNet / HostBridge read of a RoomClient; `leaderSlot` is moved by the test like the server's 3595 does. */
function stubRoom(mySlot: number, shared: { leaderSlot: number }, acks: RespawnAck[]): RoomClient {
  const respawnAcks = new Map(acks.map((a) => [a.slot, a]));
  return {
    mySlot, respawnAcks, slots: [0, 1, 2].map((slot) => ({ slot, nick: `P${slot}`, state: 19, team: slot % 2, rank: 0 })), room: null, onDeath: null, onRespawnAck: null,
    get leaderSlot() { return shared.leaderSlot; },
    get isLeader() { return shared.leaderSlot === mySlot; },
    game: { conn: { on: () => () => {} } },
    reportKill: () => {},
  } as unknown as RoomClient;
}

async function main(): Promise<void> {
  const gw = await startSignalServer();
  const data = JSON.parse(readFileSync(resolve(root, "src/host/data/matchData.json"), "utf8")) as MatchData;
  const uniqueRoomId = (1 << 20) | 8, roomSeed = (36 << 20) | (1 << 12) | 4;
  const roster = [0, 1, 2].map((slot) => ({ slot, name: `P${slot}`, team: (slot % 2) as 0 | 1 }));
  const weapons = { primary: 100003001, secondary: 601002003, melee: 702001001, grenade: 803007001, special: 904007002 };
  const acks: RespawnAck[] = [0, 1, 2].map((slot) => ({ slot, roomSpawns: 3, slotSpawns: slot + 1, weapons, chara: 0, parts: [], beret: 0, accessory: 0 }));
  const shared = { leaderSlot: 0 };
  const common = { RTCPeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection, data, worker: nodeWorker, log: (l: string) => { if (process.env.P2P_TEST_VERBOSE) console.log("  [host]", l); } };
  const mk = (slot: number) => new PbBattleNet({
    session: { uniqueRoomId, roomSeed, slot, accountId: 0x10 + slot, signalTicket: testTicket(uniqueRoomId, roomSeed, slot) }, roster, serverUrl: GW,
    room: stubRoom(slot, shared, acks), p2p: { ...common },
  });
  const [A, B, C] = [mk(0), mk(1), mk(2)];

  A.setRespawnCount(1); B.setRespawnCount(2); C.setRespawnCount(3);
  const conns = [B.connect(), C.connect()];
  await sleep(300);
  await A.connect();
  await Promise.all(conns);
  check("3 peers registered on A's core", A.link.connected && B.link.connected && C.link.connected && A.p2p!.host!.rtc.slots().length === 2);

  // the host leaves (tab closed): no "match over", guests see a dropped link
  A.dispose();
  await sleep(200);
  shared.leaderSlot = 1; // Server.Game: RemovePlayer -> SetNewLeader -> 3595
  await until("B hosts", 15000, () => B.p2p?.leader && B.link.connected);
  check("new leader B hosts a fresh core and registered on it", !!B.p2p?.host);
  await until("C follows", 15000, () => C.p2p && !C.p2p.leader && C.link.connected && B.p2p!.host!.rtc.slots().includes(2));
  check("C reconnected to B as a guest", C.link.connected && B.p2p!.host!.rtc.slots().join() === "2");
  const st = await B.p2p!.host!.local.stats();
  const pl = (s: number) => st.players.find((p) => p.slot === s);
  check("RESPAWN_ACKs replayed into the new core (SpawnsCount of B and C)", pl(1)?.respawn === 2 && pl(2)?.respawn === 3, JSON.stringify(st.players));

  // ---- after the change: both still see each other move, and damage still lands (no ghost / invincible slot)
  const seen: Record<string, number> = { b: 0, c: 0 };
  B.onRemoteState((st) => { if (st.id === "slot2") seen.c++; });
  C.onRemoteState((st) => { if (st.id === "slot1") seen.b++; });
  let i = 0;
  const pump = setInterval(() => {
    const mk = (id: string, team: 0 | 1, x: number) => ({ id, name: id, team, pos: [x + i * 0.1, 0.5, -10] as [number, number, number], vel: [1, 0, 1] as [number, number, number], yaw: 0, pitch: 0, crouch: false, alive: true, hp: 100, weapon: "K-2", firing: false, t: Date.now(), torsoAction: "idle" as const, moving: true, running: false, moveDir: 0, zoomType: 0 });
    B.sendState(mk(B.localId, 1, -5));
    C.sendState(mk(C.localId, 0, 5));
    i++;
  }, 40);
  await sleep(1500);
  check("after the host change B and C see each other move", seen.b > 20 && seen.c > 20, JSON.stringify(seen));
  const rawB: import("../../net/matchUdp.ts").ActionIn[] = [], rawC: import("../../net/matchUdp.ts").ActionIn[] = [];
  const tap = (n: PbBattleNet, sink: typeof rawB) => { const orig = n.link.onActions!; n.link.onActions = (acts, t) => { sink.push(...acts); orig(acts, t); }; };
  tap(B, rawB); tap(C, rawC);
  const hit = (from: PbBattleNet, victimSlot: number) => from.link.send({ hits: [{ start: [0, 1.5, -10], end: [1, 1.5, -10], victimSlot, damage: 30, part: 1, objectType: 1, weaponId: weapons.primary }] });
  hit(B, 2); // the new host shoots a guest
  const hpC = await until("C hp 70", 2000, () => rawC.find((a) => a.slot === 2 && a.hp === 70 && !a.posRot)).catch(() => null);
  check("host B hits guest C after the change (C loses hp)", !!hpC);
  hit(C, 1); // a guest shoots the new host
  const hpB = await until("B hp 70", 2000, () => rawB.find((a) => a.slot === 1 && a.hp === 70 && !a.posRot)).catch(() => null);
  check("guest C hits host B after the change (B loses hp)", !!hpB);

  // ---- a guest link blips while the host lives: the host core resets the slot (peerClosed); reconnecting must re-arm it
  seen.c = 0; seen.b = 0;
  const oldLink = C.p2p;
  oldLink!.stop();
  await until("C reconnects to the same host", 20000, () => C.p2p && C.p2p !== oldLink && C.link.connected && B.p2p!.host!.rtc.slots().includes(2));
  await sleep(1200);
  check("guest reconnected to the living host: both still see each other move", seen.b > 15 && seen.c > 15, JSON.stringify(seen));
  rawC.length = 0;
  hit(B, 2);
  const hpC2 = await until("C hp after reconnect", 2000, () => rawC.find((a) => a.slot === 2 && a.hp !== undefined && !a.posRot && a.hp < 100)).catch(() => null);
  if (!hpC2) console.log(JSON.stringify((await B.p2p!.host!.local.stats()).players), JSON.stringify(rawC.filter((a) => !a.posRot).slice(0, 6)));
  check("after the reconnect the guest is not invincible (hit on it lands)", !!hpC2, hpC2 ? `hp ${hpC2.hp}` : "no hp event");
  rawB.length = 0;
  hit(C, 1);
  const hpB2 = await until("B hp after C reconnect", 2000, () => rawB.find((a) => a.slot === 1 && a.hp !== undefined && !a.posRot && a.hp < 100)).catch(() => null);
  check("and its own hits land (respawn count validated again)", !!hpB2, hpB2 ? `hp ${hpB2.hp}` : "no hp event");
  clearInterval(pump);

  B.dispose();
  C.dispose();
  await sleep(900);
  gw.kill();
  const ok = results.every((r) => r.ok);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks\nRESULT: ${ok ? "PASS" : "FAIL"} — P2P host change`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("RESULT: FAIL —", e instanceof Error ? e.stack : e); process.exit(1); });
