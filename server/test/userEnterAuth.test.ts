// USER_ENTER needs the Auth's enter ticket and an account has one Game session (the live one is kicked
// with DRIVE_AWAY_LOGIN, the new one refused, as the C# Auth's SendLoginKickInfo -> Game AuthLogin.Load). Offline: pool.query
// is mocked (one account row, every other statement answers no rows).
//   node --test test/userEnterAuth.test.ts
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PacketReader, PacketWriter } from "../../src/net/packet.ts";
import { pool } from "../src/db.ts";
import { handleUserEnter, kickGameSession, onlineAccounts, type GameClient } from "../src/game/gameServer.ts";
import { mintEnterTicket, mintSignalTicket, readEnterTicket, readSignalTicket } from "../src/web/signalTicket.ts";
import { WsSocket } from "../src/web/wsSocket.ts";
import { opOf, u32 } from "./fakeRoom.ts";

const PID = 9100000777n, USER = "enteruser";
let queries = 0;
const q = mock.method(pool, "query", async (sql: string, args: unknown[] = []) => {
  queries++;
  if (/SELECT \* FROM accounts WHERE player_id=\$1/.test(sql) && String(args[0]) === String(PID))
    return { rows: [{ player_id: String(PID), username: USER, nickname: "Enter", status: 0xff00ffff, online: true, gold: 10, cash: 20 }] };
  return { rows: [], rowCount: 0 };
});
after(() => { q.mock.restore(); onlineAccounts.clear(); });

/** a Game client whose socket carried `ticket` as its {t:"enter"} text frame (null = none) */
function client(ticket: string | null) {
  const sent: Uint8Array[] = [];
  let closedWith: { destroy: boolean; ms: number } | null = null;
  const session = {
    sessionId: 77, ip: "203.0.113.9", closed: false, sock: { enterTicket: ticket },
    send: (b: Uint8Array) => { sent.push(b); }, sendText() {}, log() {},
    close(destroy: boolean, ms = 0) { if (this.closed) return; this.closed = true; closedWith = { destroy, ms }; },
  };
  const c = { session, player: null, serverId: 1, state: { info: { id: 1 } } } as unknown as GameClient;
  return { c, sent, closed: () => closedWith, ack: () => { const b = sent.find((x) => opOf(x) === 2331); return b ? u32(b, 2) : null; } };
}
const enterReq = (pid: bigint, user = USER) => new PacketReader(new PacketWriter().writeC(user.length).writeS(user, user.length).writeQ(pid).toBytes());

test("enter ticket: round trip; tampered, expired, other kind or garbage read as null", () => {
  const t = mintEnterTicket(PID);
  assert.equal(readEnterTicket(t), PID);
  const [body, sig] = t.split(".");
  const forged = Buffer.from(Buffer.from(body, "base64url").toString().replace(String(PID), "1")).toString("base64url");
  assert.equal(readEnterTicket(`${forged}.${sig}`), null, "claims changed under the old MAC");
  assert.equal(readEnterTicket(mintEnterTicket(PID, -1000)), null, "expired");
  assert.equal(readEnterTicket(mintSignalTicket("100003-400004", 1, PID)), null, "a /signal ticket is not an enter ticket");
  assert.equal(readSignalTicket(t), null, "an enter ticket is not a /signal ticket");
  assert.equal(readEnterTicket(undefined), null);
  assert.equal(readEnterTicket("x".repeat(300)), null);
});

test("USER_ENTER without a ticket (old client, raw TCP) is refused with FAIL before any DB read", async () => {
  queries = 0;
  const k = client(null);
  await handleUserEnter(k.c, enterReq(PID));
  assert.equal(k.ack(), 0x80000000);
  assert.deepEqual(k.closed(), { destroy: true, ms: 0 });
  assert.equal(queries, 0);
  assert.equal(onlineAccounts.has(PID), false);
});

test("USER_ENTER with the ticket of another account is refused (the playerId of the packet is not trusted)", async () => {
  const k = client(mintEnterTicket(PID + 1n));
  await handleUserEnter(k.c, enterReq(PID));
  assert.equal(k.ack(), 0x80000000);
  assert.equal(onlineAccounts.has(PID), false);
});

test("USER_ENTER with its own ticket enters; a 2nd session of the account is refused and the live one kicked (DRIVE_AWAY_LOGIN)", async () => {
  const a = client(mintEnterTicket(PID));
  await handleUserEnter(a.c, enterReq(PID));
  assert.equal(a.ack(), 0, "accepted");
  assert.equal(a.closed(), null);
  assert.equal(onlineAccounts.get(PID)?.connection, a.c);

  const b = client(mintEnterTicket(PID)); // same login replayed / another tab with the same ticket
  await handleUserEnter(b.c, enterReq(PID));
  assert.equal(b.ack(), 0x80000000, "new session refused");
  assert.equal(b.closed()?.destroy, true);
  const kick = a.sent.slice(-2);
  assert.deepEqual(kick.map(opOf), [2009, 3078], "ACCOUNT_KICK_ACK + SERVER_MESSAGE_ERROR_ACK");
  assert.equal(u32(kick[1], 2), 0x80001000);
  assert.deepEqual(a.closed(), { destroy: true, ms: 1000 }, "Account.Close(1000)");
  assert.equal(kickGameSession(PID), false, "a closing session is not live any more");
  onlineAccounts.delete(PID);
});

test("two USER_ENTERs of one account at once: only the first one loads it", async () => {
  const a = client(mintEnterTicket(PID)), b = client(mintEnterTicket(PID));
  await Promise.all([handleUserEnter(a.c, enterReq(PID)), handleUserEnter(b.c, enterReq(PID))]);
  assert.equal(a.ack(), 0);
  assert.equal(b.ack(), 0x80000000);
  assert.equal(onlineAccounts.get(PID)?.connection, a.c);
  onlineAccounts.delete(PID);
});

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readonly CONNECTING = 0;
  readyState = 1;
  send() {}
  close() { this.readyState = 3; }
}

test("WsSocket keeps the first {t:'enter'} text frame as the ticket; text never reaches the PB stream", async () => {
  const ws = new FakeWs();
  const sock = new WsSocket(ws as never, "127.0.0.1");
  const data: Buffer[] = [];
  sock.on("data", (d: Buffer) => data.push(d));
  ws.emit("message", Buffer.from("not json"), false);
  ws.emit("message", Buffer.from(JSON.stringify({ t: "auth", ticket: "x" })), false);
  assert.equal(sock.enterTicket, null);
  ws.emit("message", Buffer.from(JSON.stringify({ t: "enter", ticket: "first" })), false);
  ws.emit("message", Buffer.from(JSON.stringify({ t: "enter", ticket: "second" })), false);
  ws.emit("message", Buffer.from([1, 2, 3]), true);
  assert.equal(sock.enterTicket, "first");
  await new Promise((r) => setImmediate(r)); // Duplex "data" is emitted on a later tick
  assert.deepEqual(data.map((d) => [...d]), [[1, 2, 3]]);
  const big = new WsSocket(new FakeWs() as never, "127.0.0.1");
  (big as unknown as { ws: FakeWs }).ws.emit("message", Buffer.from(JSON.stringify({ t: "enter", ticket: "y".repeat(600) })), false);
  assert.equal(big.enterTicket, null, "over 512 bytes: ignored");
});
