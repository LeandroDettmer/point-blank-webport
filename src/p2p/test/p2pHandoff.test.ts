// Host handoff:  node src/p2p/test/p2pHandoff.test.ts
// A = leader (slot 0), B = next leader, C = guest, all real PbBattleNet over WebRTC; the match cores run in node Worker
// threads. The room's leader moves from A to B while A is ALIVE (a vote, not a link drop). The `handoff` frame is not on the
// server /signal yet, so this test puts a small
// WebSocket relay in front of the real signal server: it relays only `handoff` frames (host -> the guest socket of `to`) and
// pipes everything else through. Scenarios:
//   1. handoff: B restores A's core (hp, respawn counters kept), C and A re-register on B, damage continues from the restored hp
//   2. no snapshot (the relay drops the frames = old host frozen / dead): after ~2 s B hosts a fresh core (Fase 1, hp back to max)
// plus the transfer layer alone (chunking, repeats, a corrupt blob, a timeout).
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { RTCPeerConnection } from "node-datachannel/polyfill";
// @ts-ignore ws has no types here (it lives in server/node_modules); only the test relay uses it
import { WebSocketServer, WebSocket as WsClient } from "../../../server/node_modules/ws/wrapper.mjs";
import { PbBattleNet } from "../../net/battle.ts";
import { signalTicketEnv, testTicket } from "./signalTickets.ts";
import type { RoomClient } from "../../net/roomClient.ts";
import type { RespawnAck } from "../../net/metaGame.ts";
import type { WorkerLike } from "../../host/local.ts";
import type { MatchData, MatchSnapshot } from "../../host/matchCore.ts";
import { HANDOFF_CHUNK, HANDOFF_VERSION, HandoffAssembler, encodeHandoff, receiveHandoff, sendHandoff, type HandoffEnvelope, type HandoffFrame, type HandoffIn } from "../handoff.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const REAL = Number(process.env.P2P_TEST_PORT ?? 18093);
const PORT = REAL + 1; // the relay the clients talk to
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
    env: { ...process.env, PB_WEB_PORT: String(REAL), PB_WEB_HOST: "127.0.0.1", SIGNAL_STUN_URLS: "none", ...signalTicketEnv },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("signal server did not start")), 8000);
    gw.stdout!.on("data", (b: Buffer) => { if (b.toString().includes("listening")) { clearTimeout(t); res(gw); } });
    gw.on("exit", (c) => rej(new Error(`signal server exited ${c}`)));
  });
}

/** The relay: /signal as the clients see it. `handoff` frames follow; the rest goes to the real server. */
function startRelay(): { close(): void; drop: { handoff: boolean }; relayed: number[] } {
  const wss = new WebSocketServer({ port: PORT, host: "127.0.0.1" });
  const guests = new Map<string, InstanceType<typeof WsClient>>();
  const state = { drop: { handoff: false }, relayed: [] as number[] };
  wss.on("connection", (client: InstanceType<typeof WsClient>, req: { url: string }) => {
    const u = new URL(req.url, "http://relay");
    const room = u.searchParams.get("room") ?? "", role = u.searchParams.get("role"), slot = Number(u.searchParams.get("slot"));
    const up = new WsClient(`ws://127.0.0.1:${REAL}${req.url}`);
    const pending: string[] = [];
    up.on("open", () => { for (const p of pending.splice(0)) up.send(p); });
    up.on("message", (d: Buffer) => { if (client.readyState === 1) client.send(d.toString()); });
    up.on("close", (code: number, reason: Buffer) => { try { client.close(code >= 3000 ? code : 1000, reason.toString()); } catch { /* ignore */ } });
    up.on("error", () => client.close());
    if (role === "guest") guests.set(`${room}:${slot}`, client);
    client.on("close", () => { if (guests.get(`${room}:${slot}`) === client) guests.delete(`${room}:${slot}`); up.close(); });
    client.on("message", (d: Buffer) => {
      const s = d.toString();
      let m: { t?: string; to?: number; x?: string; i?: number; n?: number; blob?: string } = {};
      try { m = JSON.parse(s); } catch { /* the real server answers BAD_JSON */ }
      if (m.t === "handoff") {
        if (role !== "host" || state.drop.handoff) return;
        const g = guests.get(`${room}:${m.to}`);
        if (g?.readyState === 1) { state.relayed.push(m.i ?? -1); g.send(JSON.stringify({ t: "handoff", x: m.x, i: m.i, n: m.n, blob: m.blob, from: slot })); }
        return;
      }
      if (up.readyState === 1) up.send(s); else pending.push(s);
    });
  });
  return { close: () => wss.close(), drop: state.drop, relayed: state.relayed };
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

// ---------------------------------------------------------------------------------------------- the transfer layer alone

async function transferTests(): Promise<void> {
  const big = JSON.parse(readFileSync(resolve(root, "src/host/data/matchData.json"), "utf8")) as { maps: Record<string, unknown> };
  // an incompressible-ish payload bigger than one frame: forces chunking
  const noise = Array.from({ length: 30000 }, (_, i) => ((i * 2654435761) >>> 0).toString(36));
  const env: HandoffEnvelope = { v: HANDOFF_VERSION, from: 3, core: { v: 1, now: 5, rooms: [], assists: [], pendingRespawn: [], noise, maps: Object.keys(big.maps).length } as unknown as MatchSnapshot, bridge: { spawned: [0, 2] } };
  const frames = await encodeHandoff(env);
  check("encode: gzip + base64 cut in frames under the /signal limit", frames.length > 1 && frames.every((f) => f.blob.length <= HANDOFF_CHUNK && f.n === frames.length && f.x === frames[0].x), `${frames.length} frames, ${frames.reduce((n, f) => n + f.blob.length, 0)} chars`);
  const asm = new HandoffAssembler();
  let got: HandoffEnvelope | null = null;
  for (const f of [...frames].reverse().concat(frames)) got = (await asm.add(f)) ?? got; // out of order, then repeated
  check("assemble: out of order + repeated frames give the same envelope", !!got && JSON.stringify(got) === JSON.stringify(env));

  // sendHandoff -> a fake signaling pair (no server): repeats until forMs, the receiver takes the first complete transfer
  const rx: { onHandoff: ((f: HandoffIn) => void) | null } = { onHandoff: null };
  let sends = 0;
  const tx = { handoff: (to: number, f: HandoffFrame) => { sends++; if (to === 1) setTimeout(() => rx.onHandoff?.({ ...f, from: 0 }), 1); } };
  const recv = receiveHandoff(rx, 3000);
  await sendHandoff(tx, 1, env, { everyMs: 100, forMs: 450 });
  const env2 = await recv;
  check("sendHandoff repeats the transfer; receiveHandoff resolves once with the envelope", !!env2 && env2.from === 3 && sends >= frames.length * 3, `${sends} frame sends`);
  const none = await receiveHandoff({ onHandoff: null }, 150);
  check("receiveHandoff: null after the timeout (old host dead / frozen)", none === null);
  const bad = await new Promise<HandoffEnvelope | null>((res) => {
    const r2: { onHandoff: ((f: HandoffIn) => void) | null } = { onHandoff: null };
    void receiveHandoff(r2, 1500).then(res);
    r2.onHandoff!({ x: "abcdefgh12", i: 0, n: 1, blob: "bm90IGd6aXA=" }); // "not gzip"
  });
  check("receiveHandoff: a corrupt blob is refused (null: fresh core)", bad === null);
  const wrongVersion = await encodeHandoff({ ...env, v: 99 });
  const asm2 = new HandoffAssembler();
  let refused = false;
  for (const f of wrongVersion) await asm2.add(f).catch(() => { refused = true; });
  check("a snapshot of another version is refused", refused);
}

// ---------------------------------------------------------------------------------------------- the match

interface Rig { A: PbBattleNet; B: PbBattleNet; C: PbBattleNet; shared: { leaderSlot: number }; log: string[] }

async function rig(uniqueRoomId: number, data: MatchData): Promise<Rig> {
  const roomSeed = (36 << 20) | (1 << 12) | 4;
  const roster = [0, 1, 2].map((slot) => ({ slot, name: `P${slot}`, team: (slot % 2) as 0 | 1 }));
  const weapons = { primary: 100003001, secondary: 601002003, melee: 702001001, grenade: 803007001, special: 904007002 };
  const acks: RespawnAck[] = [0, 1, 2].map((slot) => ({ slot, roomSpawns: 3, slotSpawns: slot + 1, weapons, chara: 0, parts: [], beret: 0, accessory: 0 }));
  const shared = { leaderSlot: 0 };
  const log: string[] = [];
  const common = { RTCPeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection, data, worker: nodeWorker, log: (l: string) => { log.push(l); if (process.env.P2P_TEST_VERBOSE) console.log("  [p2p]", l); } };
  const mk = (slot: number) => new PbBattleNet({ session: { uniqueRoomId, roomSeed, slot, accountId: 0x10 + slot, signalTicket: testTicket(uniqueRoomId, roomSeed, slot) }, roster, serverUrl: GW, room: stubRoom(slot, shared, acks), p2p: { ...common } });
  const [A, B, C] = [mk(0), mk(1), mk(2)];
  A.setRespawnCount(1); B.setRespawnCount(2); C.setRespawnCount(3);
  const conns = [B.connect(), C.connect()];
  await sleep(300);
  await A.connect();
  await Promise.all(conns);
  await until("guests on A", 5000, () => A.p2p!.host!.rtc.slots().length === 2);
  A.p2p!.host!.bridge!.replay(); // arms A's own slot too (the guests were armed when their links came up)
  await sleep(200);
  return { A, B, C, shared, log };
}

const hit = (from: PbBattleNet, victimSlot: number, damage: number) =>
  from.link.send({ hits: [{ start: [0, 1.5, -10], end: [1, 1.5, -10], victimSlot, damage, part: 1, objectType: 1, weaponId: 100003001 }] });
const lives = async (n: PbBattleNet) => Object.fromEntries((await n.p2p!.host!.local.stats()).players.map((p) => [p.slot, p.life]));

async function scenario(name: string, uid: number, data: MatchData, relay: ReturnType<typeof startRelay>, handoff: boolean): Promise<void> {
  relay.drop.handoff = !handoff;
  const { A, B, C, shared, log } = await rig(uid, data);
  check(`[${name}] 3 peers registered on A's core, all armed`, A.link.connected && B.link.connected && C.link.connected);
  hit(A, 1, 30);   // B: 100 -> 70
  hit(C, 0, 20);   // A: 100 -> 80
  await sleep(400);
  const before = await lives(A);
  check(`[${name}] before the change: B 70, A 80 on the old core`, before[1] === 70 && before[0] === 80, JSON.stringify(before));

  const t0 = Date.now();
  shared.leaderSlot = 1; // the vote passed: Server.Game SetNewLeader -> 3595, the old host is alive
  await until("B hosts", 25000, () => B.p2p?.leader && B.link.connected);
  const tHost = Date.now() - t0;
  check(`[${name}] B (new leader) hosts and registered on its core`, !!B.p2p?.host);
  await until("A and C follow", 25000, () => A.p2p && !A.p2p.leader && A.link.connected && C.p2p && !C.p2p.leader && C.link.connected && B.p2p!.host!.rtc.slots().length === 2);
  check(`[${name}] the old host A is a guest of B and C reconnected to B`, B.p2p!.host!.rtc.slots().join() === "0,2" || B.p2p!.host!.rtc.slots().sort().join() === "0,2");
  const after = await lives(B);
  const restored = B.p2p!.host!.local.restored;
  if (handoff) {
    check(`[${name}] B's core was restored from the snapshot (not fresh)`, !!restored && log.some((l) => /^handoff from slot 0: 1 room/.test(l)) && log.some((l) => l.includes("handoff to slot 1 sent")), JSON.stringify(restored));
    check(`[${name}] hp survived the change: B 70, A 80, C 100`, after[1] === 70 && after[0] === 80 && after[2] === 100, JSON.stringify(after));
    check(`[${name}] no fallback wait: B hosted ${tHost} ms after the change`, tHost < 4000, `${tHost} ms`);
    hit(C, 1, 30);
    await sleep(400);
    const next = await lives(B);
    check(`[${name}] damage continues on the restored core: B 70 -> 40 (not 100 -> 70)`, next[1] === 40, JSON.stringify(next));
    hit(B, 0, 30);
    await sleep(400);
    check(`[${name}] the new host's own hits land on the old host (80 -> 50)`, (await lives(B))[0] === 50);
    check(`[${name}] the snapshot travelled in frames over /signal`, relay.relayed.length >= 1, `${relay.relayed.length} frame(s) relayed`);
  } else {
    check(`[${name}] no snapshot: B waited and fell back to a fresh core`, !restored && log.some((l) => l.includes("no handoff snapshot")), JSON.stringify(restored));
    check(`[${name}] fresh core = RESPAWN_ACK replay: everyone back at full hp`, after[1] === 100 && after[0] === 100 && after[2] === 100, JSON.stringify(after));
    check(`[${name}] the fallback waited about the 2 s window (${tHost} ms)`, tHost >= 1800, `${tHost} ms`);
    hit(C, 1, 30);
    await sleep(400);
    check(`[${name}] damage lands on the fresh core (100 -> 70)`, (await lives(B))[1] === 70);
  }
  A.dispose(); B.dispose(); C.dispose();
  await sleep(900);
}

async function main(): Promise<void> {
  await transferTests();
  const gw = await startSignalServer();
  const relay = startRelay();
  const data = JSON.parse(readFileSync(resolve(root, "src/host/data/matchData.json"), "utf8")) as MatchData;
  try {
    await scenario("handoff", (1 << 20) | 21, data, relay, true);
    await scenario("fallback", (1 << 20) | 22, data, relay, false);
  } finally {
    relay.close();
    gw.kill();
  }
  const ok = results.every((r) => r.ok);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks\nRESULT: ${ok ? "PASS" : "FAIL"} — P2P host handoff`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("RESULT: FAIL —", e instanceof Error ? e.stack : e); process.exit(1); });
