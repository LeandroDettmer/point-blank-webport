// Live 2-client battle: the room flow on the real server Game through the web front,
// the match hosted by the leader (A) — the Server.Match port in a Worker thread — with B over WebRTC (node-datachannel),
// signaling on /signal:
//   node src/p2p/test/p2pbattle.live.ts [--gw ws://127.0.0.1:8090] [--api http://127.0.0.1:8090] [--suffix 1]
// Everything counts here: positions + anim bits both ways, the hit relay, the kill (B's mark -> A's DEATH_REQ ->
// DEATH_ACK), B's respawn (RESPAWN_ACK 5138 -> the host bridge's RespawnSync, nothing injected), and the end
// (TIMERSYNC 0 -> ENDBATTLE on both -> the host closes B's link with 1001).
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { AuthClient, gameTargetForServer } from "../../net/authClient.ts";
import { GameClient } from "../../net/gameClient.ts";
import { RoomClient, WIRE_READY } from "../../net/roomClient.ts";
import { PbBattleNet } from "../../net/battle.ts";
import type { HitEvent, PlayerState } from "../../game/netAdapter";
import type { WorkerLike } from "../../host/local.ts";
import type { MatchData } from "../../host/matchCore.ts";
import { replicationChecks } from "../../net/test/replication.live-part.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const GW = arg("--gw", "ws://127.0.0.1:8090");
const API = arg("--api", "http://127.0.0.1:8090");
const DATA = JSON.parse(readFileSync(new URL("../../host/data/matchData.json", import.meta.url), "utf8")) as MatchData;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (who: string, msg: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s [${who}] ${msg}`);
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok }); log(ok ? "ok" : "FAIL", `${name}${detail ? ` — ${detail}` : ""}`); };

function nodeWorker(): WorkerLike {
  const w = new Worker(new URL("./nodeHostWorker.ts", import.meta.url));
  const like: WorkerLike = { postMessage: (m) => w.postMessage(m), onmessage: null, onerror: null, terminate: () => { void w.terminate(); } };
  w.on("message", (m) => like.onmessage?.({ data: m }));
  w.on("error", (e) => like.onerror?.({ message: e.message }));
  return like;
}

async function account(username: string, password: string): Promise<{ token: Uint8Array }> {
  const post = (path: string) => fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  let res = await post("/api/register");
  if (res.status === 409) res = await post("/api/login");
  const body = (await res.json()) as { token?: string; error?: string };
  if (!res.ok || !body.token) throw new Error(`account-api ${username}: ${res.status} ${body.error ?? ""}`);
  return { token: Uint8Array.from(Buffer.from(body.token, "base64")) };
}

interface Player { name: string; game: GameClient; room: RoomClient; playerId: bigint; net?: PbBattleNet }

async function enter(name: string, username: string): Promise<Player> {
  const acc = await account(username, "battle-test-pw1");
  const auth = new AuthClient(GW);
  const mac = crypto.getRandomValues(new Uint8Array(6));
  mac[0] = (mac[0] & 0xfe) | 2;
  const login = await auth.connectAndLogin({ token: acc.token, mac, width: 1280, height: 720 });
  if (!login.ok) throw new Error(`${name}: login ${login.errorName}`);
  const servers = await auth.getServers();
  const server = servers.find((s) => s.index > 0)!;
  await auth.leave();
  const game = new GameClient(gameTargetForServer(server), GW);
  await game.enter(login.username, login.playerId, server.index);
  await game.selectChannel(0);
  await game.enterLobby();
  log(name, `logged in as ${login.username} (pid ${login.playerId})`);
  return { name, game, room: new RoomClient(game), playerId: login.playerId };
}

function waitFor<T>(what: string, ms: number, arm: (done: (v: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${what}`)), ms);
    arm((v) => { clearTimeout(t); resolve(v); });
  });
}

async function main(): Promise<void> {
  const suffix = arg("--suffix", "1");
  const A = await enter("A", `p2ptest_a${suffix}`);
  await sleep(1500); // the server drops a 2nd login from the same IP within 1 s
  const B = await enter("B", `p2ptest_b${suffix}`);

  const room = await A.room.create({ name: `web p2p ${Date.now() % 10000}`, slots: 8, killTime: 0x60 });
  log("A", `created room #${room.roomId} map ${room.mapId}`);
  const bSlot = await B.room.join(room.roomId);
  if (bSlot % 2 === 0) throw new Error("B landed on the leader's team; TDM start needs a READY enemy");
  const bReady = waitFor<void>("B READY", 5000, (done) => { A.room.onChange = () => { if (A.room.slots[bSlot].state === WIRE_READY) done(); }; });
  B.room.ready();
  await bReady;
  A.room.onChange = null;
  const bStart = waitFor<void>("B START_GAME", 6000, (done) => { B.room.onStartGame = done; });
  await A.room.start();
  await bStart;
  await A.room.loadingStart();
  await B.room.loadingStart();
  const epA = await A.room.preStart();
  const epB = await B.room.preStart();
  log("A+B", `PRESTART: uid 0x${epA.uniqueRoomId.toString(16)} seed 0x${epA.roomSeed.toString(16)}, slots ${epA.slot}/${epB.slot} (Server.Match ${epA.ip}:${epA.port} unused)`);

  const roster = [{ slot: epA.slot, name: "A", team: 0 as const }, { slot: epB.slot, name: "B", team: 1 as const }];
  for (const [p, ep] of [[A, epA], [B, epB]] as const) {
    p.net = new PbBattleNet({
      session: { uniqueRoomId: ep.uniqueRoomId, roomSeed: ep.roomSeed, slot: ep.slot, accountId: Number(p.playerId & 0xffn), signalTicket: ep.signalTicket },
      roster, serverUrl: GW, room: p.room,
      p2p: { RTCPeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection, worker: nodeWorker, data: DATA, log: (l) => log(p.name, `p2p: ${l}`) },
    });
  }
  let bClosed = "";
  B.net!.link.onClose = (r) => { bClosed = r; };
  await Promise.all([A.net!.connect(), B.net!.connect()]); // B waits on /signal for A's host
  check("P2P register: A on its local peer, B over WebRTC (65 -> CONNECT 66)", A.net!.link.connected && B.net!.link.connected && A.net!.p2p!.leader && !B.net!.p2p!.leader,
    `A hosts, WebRTC guests [${A.net!.p2p!.host!.rtc.slots()}]`);

  const battleA = waitFor<void>("A STARTBATTLE", 12000, (done) => { A.room.onBattleStart = done; });
  const battleB = waitFor<void>("B STARTBATTLE", 12000, (done) => { B.room.onBattleStart = done; });
  A.room.startBattle();
  B.room.startBattle();
  await Promise.all([battleA, battleB]);
  for (const p of [A, B]) p.net!.setRespawnCount(await p.room.respawn());
  await sleep(300); // RESPAWN_ACK 5138 -> host bridge -> RespawnSync (StartTime, PlayerIdByServer)
  const st0 = await A.net!.p2p!.host!.local.stats();
  check("host bridge: both RESPAWN_ACKs became RespawnSync (slots bound, respawn 1)", st0.players.length === 2 && st0.players.every((p) => p.respawn === 1 && !p.dead), JSON.stringify(st0.players));

  const got: Record<string, PlayerState[]> = { A: [], B: [] };
  const hits: HitEvent[] = [];
  A.net!.onRemoteState((s) => got.A.push(s));
  B.net!.onRemoteState((s) => got.B.push(s));
  B.net!.onRemoteHit((e) => hits.push(e));
  const TORSO = ["idle", "fire", "reload", "change", "zoom"] as const;
  const state = (id: string, team: 0 | 1, i: number, base: number): PlayerState => ({
    id, name: id, team, pos: [base + i * 0.1, 0.5, -10 - i * 0.05], vel: [1, 0, 1], yaw: (i * 0.05) % 6, pitch: 0.1,
    crouch: i % 20 < 10, alive: true, hp: 100, weapon: "K-2", firing: false, t: Date.now(),
    torsoAction: TORSO[i % TORSO.length], moving: i % 3 !== 0, running: i % 6 < 3, moveDir: i % 8, zoomType: i % 3 === 0 ? 2 : i % 3 === 1 ? 3 : 0,
  });
  let i = 0;
  const pump = setInterval(() => {
    A.net!.sendState(state(A.net!.localId, 0, i, 5));
    B.net!.sendState(state(B.net!.localId, 1, i, -5));
    if (i === 40) A.net!.sendHit({ attackerId: A.net!.localId, victimId: B.net!.localId, weapon: "K-2", zone: "head", baseDamage: 25, helmetPenetrate: 50, falloff: 1, point: [-5, 1.6, -12], t: Date.now() });
    i++;
  }, 40);
  await sleep(3000);
  clearInterval(pump);
  await sleep(300);
  const near = (p: number[] | undefined, q: number[]) => !!p && Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.5;
  const lastA = A.net!.latest(epB.slot), lastB = B.net!.latest(epA.slot);
  check("positions both ways through the leader's host", near(lastA?.pos, state("", 1, i - 1, -5).pos) && near(lastB?.pos, state("", 0, i - 1, 5).pos),
    `A rx ${A.net!.link.rxPackets} pk, B rx ${B.net!.link.rxPackets} pk`);
  const torso = new Set(got.A.map((s) => s.torsoAction)), dirs = new Set(got.A.map((s) => s.moveDir)), zoom = new Set(got.A.map((s) => s.zoomType));
  check("3PV anim bits (ActionState) intact", torso.size === 5 && dirs.size >= 4 && zoom.has(2) && zoom.has(3), `torso ${[...torso]} dirs ${dirs.size} zoom ${[...zoom]}`);
  check("hit relay A -> B", hits.some((h) => h.attackerId === `slot${epA.slot}` && h.zone === "head"), `${hits.length} hit(s)`);

  // weapon in hand / throwables / dropped weapons (WeaponSync, SubHead.Grenade, DropWeapon + SubHead.DroppedWeapon)
  const rep = await replicationChecks(A.net!, B.net!, epA.slot, (who, k) => (who === "A" ? state(A.net!.localId, 0, k, 5) : state(B.net!.localId, 1, k, -5)), i);
  i = rep.i;
  for (const r of rep.results) check(r.name, r.ok, r.detail);

  // kill: B (victim) marks its death -> A's client sends DEATH_REQ -> Server.Game DEATH_ACK to both
  const killA = waitFor<string>("A onRemoteKill", 5000, (done) => { A.net!.onRemoteKill((k) => done(`${k.killerId} -> ${k.victimId} hs=${k.headshot}`)); });
  const deathB = waitFor<string>("B DEATH_ACK", 5000, (done) => { const prev = B.room.onDeath; B.room.onDeath = (d) => { prev?.(d); done(`killer ${d.killerSlot} FR ${d.frKills} CT ${d.ctKills}`); }; });
  B.net!.sendKill({ killerId: A.net!.localId, victimId: B.net!.localId, weapon: "K-2", headshot: true, t: Date.now() });
  const deadPump = setInterval(() => {
    A.net!.sendState(state(A.net!.localId, 0, i, 5));
    B.net!.sendState({ ...state(B.net!.localId, 1, i, -5), alive: false, hp: 0 });
  }, 40);
  const k = await killA.catch((e) => `ERR ${(e as Error).message}`);
  const d = await deathB.catch((e) => `ERR ${(e as Error).message}`);
  clearInterval(deadPump);
  check("kill: B's mark via the host -> A's DEATH_REQ -> Server.Game DEATH_ACK", !k.startsWith("ERR") && !d.startsWith("ERR"), `${k}; B: ${d}`);

  // respawn: B alive again -> RESPAWN_REQ -> 5138 -> the host bridge re-syncs B (type 2, respawn 2)
  const respawnB = waitFor<number>("B RESPAWN_ACK", 5000, (done) => { B.room.onRespawn = (slot, n) => { if (slot === epB.slot) done(n); }; });
  B.net!.sendState({ ...state(B.net!.localId, 1, i, -5) });
  await sleep(50);
  B.net!.sendState({ ...state(B.net!.localId, 1, i + 1, -5), t: Date.now() + 100 });
  const n = await respawnB.catch(() => -1);
  await sleep(300);
  const st1 = await A.net!.p2p!.host!.local.stats();
  const pb = st1.players.find((p) => p.slot === epB.slot);
  check("respawn: RESPAWN_ACK -> host RespawnSync (B alive, respawn count = Server.Game's)", n > 1 && !!pb && !pb.dead && pb.respawn === (n & 0xff), `server spawns ${n}, host ${JSON.stringify(pb)}`);

  // end: the leader's clock -> TIMERSYNC 0 -> ENDBATTLE (exp / gold on Server.Game) -> the host closes the guests
  const endA = waitFor<string>("A ENDBATTLE", 6000, (done) => { A.room.onEndBattle = (e) => done(`winner ${e.winner} FR ${e.frKills} CT ${e.ctKills}`); });
  const endB = waitFor<string>("B ENDBATTLE", 6000, (done) => { B.room.onEndBattle = (e) => done(`winner ${e.winner}`); });
  A.room.timerSync(0);
  const ea = await endA.catch((e) => `ERR ${(e as Error).message}`);
  const eb = await endB.catch((e) => `ERR ${(e as Error).message}`);
  check("end: TIMERSYNC 0 -> ENDBATTLE from Server.Game on both", !ea.startsWith("ERR") && !eb.startsWith("ERR"), `A: ${ea}; B: ${eb}`);
  await waitFor<void>("B link closed", 3000, (done) => { const t = setInterval(() => { if (bClosed) { clearInterval(t); done(); } }, 20); }).catch(() => {});
  check("end: the host closed B's WebRTC link (1001 match over)", /1001/.test(bClosed), bClosed || "still open");

  for (const p of [A, B]) {
    p.net?.dispose();
    await p.room.leave();
    p.room.dispose();
    p.game.close();
  }
  await sleep(900);
  const pass = results.every((r) => r.ok);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks\nRESULT: ${pass ? "PASS" : "FAIL"} — P2P battle on the real Server.Game room flow`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("RESULT: FAIL —", e instanceof Error ? e.message : e);
  process.exit(1);
});
