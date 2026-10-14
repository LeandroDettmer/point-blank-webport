// /signal admission by ticket: web/signalTicket.ts + web/signal.ts,
// and the ticket Server.Game hands out at PRESTARTBATTLE (game/roomHandlers.ts handlePreStartBattle), offline.
//   node --test test/signalAuth.test.ts
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PacketReader, PacketWriter } from "../../src/net/packet.ts";
import { pool } from "../src/db.ts";
import { RoomState, SlotState } from "../src/game/roomModel.ts";
import { handlePreStartBattle } from "../src/game/roomHandlers.ts";
import type { GameClient } from "../src/game/gameServer.ts";
import { handleSignal, signalGate, signalKey, sweepSignal } from "../src/web/signal.ts";
import { mintSignalTicket, readSignalTicket } from "../src/web/signalTicket.ts";
import { battleRoom, opOf } from "./fakeRoom.ts";

after(async () => { await pool.end(); });

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | null = null;
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = { code, reason };
    this.readyState = 3;
    queueMicrotask(() => this.emit("close"));
  }
}
/** a /signal socket; `first` = its first frame (a string = the ticket of an auth frame) */
const open = (key: string, role: string, slot: number, first?: string | { raw: string | Buffer; binary?: boolean }) => {
  const ws = new FakeWs();
  handleSignal(ws as never, new URL(`http://x/signal?room=${key}&role=${role}&slot=${slot}`), () => {});
  if (typeof first === "string") ws.emit("message", JSON.stringify({ t: "auth", ticket: first }), false);
  else if (first) ws.emit("message", first.raw, !!first.binary);
  return ws;
};
const tick = () => new Promise((r) => setTimeout(r, 5));
const BAD = { code: 4005, reason: "BAD_TICKET" };

test("ticket: round trip, and nothing but the server's own unexpired MAC reads back", () => {
  const key = signalKey(0x100003, 0x400004);
  const t = mintSignalTicket(key, 5, 123456789012345n);
  assert.deepEqual({ ...readSignalTicket(t)!, exp: 0 }, { key, slot: 5, playerId: 123456789012345n, exp: 0 });
  const [body, sig] = t.split(".");
  const forged = Buffer.from(Buffer.from(body, "base64url").toString().replace(".5.", ".6.")).toString("base64url");
  assert.equal(readSignalTicket(`${forged}.${sig}`), null, "claims changed under the old MAC");
  assert.equal(readSignalTicket(`${body}.${sig.slice(0, -2)}AA`), null, "MAC changed");
  assert.equal(readSignalTicket(mintSignalTicket(key, 5, 1n, -1000)), null, "expired");
  assert.equal(readSignalTicket(`${t}.x`), null);
  assert.equal(readSignalTicket(42), null);
});

test("/signal without a ticket: any other first frame is refused with 4005 and nothing is sent or relayed", async () => {
  const key = signalKey(0x100010, 0x400001);
  const host = open(key, "host", 0, mintSignalTicket(key, 0, 100n));
  await tick();
  const offer = open(key, "guest", 1, { raw: JSON.stringify({ t: "offer", sid: "a".repeat(32), sdp: "x" }) });
  assert.deepEqual(offer.closed, BAD);
  assert.deepEqual(open(key, "guest", 1, { raw: "not json" }).closed, BAD);
  assert.deepEqual(open(key, "guest", 1, { raw: Buffer.from("{}"), binary: true }).closed, BAD);
  assert.deepEqual(open(key, "guest", 1, { raw: JSON.stringify({ t: "auth" }) }).closed, BAD);
  await tick();
  assert.equal(host.sent.filter((m) => m.t !== "ready").length, 0, "the host never heard of them");
  assert.equal(offer.sent.length, 0);
  host.close();
});

test("/signal: a ticket of another slot, another room, expired or forged gets 4005", () => {
  const key = signalKey(0x100011, 0x400001);
  assert.deepEqual(open(key, "guest", 1, mintSignalTicket(key, 2, 101n)).closed, BAD, "other slot");
  assert.deepEqual(open(key, "guest", 1, mintSignalTicket(signalKey(0x100012, 0x400001), 1, 101n)).closed, BAD, "other room");
  assert.deepEqual(open(key, "guest", 1, mintSignalTicket(key, 1, 101n, -1)).closed, BAD, "expired");
  assert.deepEqual(open(key, "host", 0, "eyJ4IjoxfQ.AAAA").closed, BAD, "forged");
});

test("/signal: silence after connecting = 4005 NO_TICKET after 5 s", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const ws = open(signalKey(0x100013, 0x400001), "guest", 1);
    mock.timers.tick(4900);
    assert.equal(ws.closed, null);
    mock.timers.tick(200);
    assert.deepEqual(ws.closed, { code: 4005, reason: "NO_TICKET" });
  } finally { mock.timers.reset(); }
});

test("/signal: TURN only after a valid ticket, in the ready frame", async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { SIGNAL_STUN_URLS: "none", TURN_URLS: "turn:turn.test:3478", TURN_USERNAME: "u", TURN_CREDENTIAL: "s3cret" });
  delete process.env.CF_TURN_KEY_ID;
  try {
    const key = signalKey(0x100014, 0x400001);
    const ws = open(key, "guest", 3);
    await tick();
    assert.equal(ws.sent.length, 0, "nothing before the ticket");
    ws.emit("message", JSON.stringify({ t: "auth", ticket: mintSignalTicket(key, 3, 103n) }), false);
    await tick();
    assert.equal(ws.closed, null);
    assert.deepEqual(ws.sent[0], { t: "ready", role: "guest", ice: [{ urls: ["turn:turn.test:3478"], username: "u", credential: "s3cret" }], hostOnline: false });
    ws.close();
  } finally { process.env = saved; }
});

test("/signal sweep: the battle ending closes the sockets, a silent guest goes after 2 min", async () => {
  const { room, accounts } = battleRoom(3);
  const key = signalKey(room.uniqueRoomId, room.seed);
  signalGate.allow = (k, role, slot, pid) => k === key && room.maySignal(role, slot, pid);
  try {
    const host = open(key, "host", 0, mintSignalTicket(key, 0, accounts[0].playerId));
    const g1 = open(key, "guest", 1, mintSignalTicket(key, 1, accounts[1].playerId));
    await tick();
    sweepSignal();
    assert.equal(host.closed, null);
    assert.equal(g1.closed, null);
    sweepSignal(Date.now() + 121000);
    assert.deepEqual(g1.closed, { code: 4008, reason: "IDLE" });
    assert.equal(host.closed, null, "the host waits the whole battle");
    const g2 = open(key, "guest", 2, mintSignalTicket(key, 2, accounts[2].playerId));
    await tick();
    assert.equal(g2.closed, null);
    room.state = RoomState.READY; // the match ended
    sweepSignal();
    assert.deepEqual(host.closed, { code: 4004, reason: "NOT_IN_MATCH" });
    assert.deepEqual(g2.closed, { code: 4004, reason: "NOT_IN_MATCH" });
    await tick();
  } finally { signalGate.allow = null; }
});

test("PRESTARTBATTLE: the account gets its own ticket ahead of 5130, good for its slot only", async () => {
  const { room, accounts } = battleRoom(2);
  room.udpServer = { host: "127.0.0.1", port: 40000 };
  room.slots[1].state = SlotState.LOAD;
  const p = accounts[1];
  const out: (string | number)[] = [];
  const texts: Record<string, unknown>[] = [];
  const c = { player: p, session: { send: (b: Uint8Array) => out.push(opOf(b)), sendText: (m: Record<string, unknown>) => { out.push("text"); texts.push(m); } } } as unknown as GameClient;
  handlePreStartBattle(c, new PacketReader(new PacketWriter().writeC(room.mapId).writeC(room.rule).writeC(room.stage).writeC(room.roomType).toBytes(), 0));
  room.slots[1].stopTiming();
  assert.deepEqual(out.slice(out.indexOf("text")), ["text", 5130]);
  assert.equal(texts[0].t, "signalTicket");
  const key = signalKey(room.uniqueRoomId, room.seed);
  assert.deepEqual({ ...readSignalTicket(texts[0].ticket)!, exp: 0 }, { key, slot: 1, playerId: p.playerId, exp: 0 });
  signalGate.allow = (k, role, slot, pid) => k === key && room.maySignal(role, slot, pid);
  try {
    const ticket = texts[0].ticket as string;
    assert.deepEqual(open(key, "guest", 0, ticket).closed, BAD, "someone else's slot");
    assert.deepEqual(open(key, "host", 1, ticket).closed, { code: 4004, reason: "NOT_IN_MATCH" }, "not the leader");
    const ok = open(key, "guest", 1, ticket);
    await tick();
    assert.equal(ok.closed, null);
    assert.equal(ok.sent[0]?.t, "ready");
    ok.close();
    await tick();
  } finally { signalGate.allow = null; }
});
