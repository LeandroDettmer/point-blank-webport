// WsSocket + webServer: a browser-style WebSocket reaches a TcpSession with no TCP hop.
import { test } from "node:test";
import assert from "node:assert/strict";
import type net from "node:net";
import { MAX_FRAMES_PER_CHUNK, TcpSession } from "../src/net/tcpSession.ts";
import { startWebServer } from "../src/web/webServer.ts";
import { pool } from "../src/db.ts";
import { config } from "../src/config.ts";

test("ws /tcp gets CONNECT_ACK from TcpSession and close propagates", async () => {
  let closed: (d: boolean) => void = () => {};
  const closedP = new Promise<boolean>((r) => { closed = r; });
  let ip = "";
  const srv = await startWebServer({
    t: (sock: net.Socket) => {
      const s = new TcpSession(sock, 7, { firstPacketIds: null, onPacket() {}, onClose: (d) => closed(d) });
      ip = s.ip;
      void s.start();
    },
  }, "127.0.0.1", 0);
  const port = (srv.address() as net.AddressInfo).port;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tcp?target=t`);
    ws.binaryType = "arraybuffer";
    const first = await new Promise<Uint8Array>((res, rej) => { ws.onmessage = (e) => res(new Uint8Array(e.data as ArrayBuffer)); ws.onerror = () => rej(new Error("ws error")); });
    // frame = [u16 len][payload...]; payload starts with opcode 2306 (PROTOCOL_BASE_CONNECT_ACK)
    assert.equal(first[2] | (first[3] << 8), 2306);
    assert.equal(ip, "127.0.0.1");
    ws.close();
    assert.equal(await closedP, true);

    const bad = new WebSocket(`ws://127.0.0.1:${port}/tcp?target=nope`);
    await new Promise<void>((res) => { bad.onerror = () => res(); bad.onclose = () => res(); });
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { ok: boolean };
    assert.equal(h.ok, true);
  } finally {
    srv.close();
    srv.closeAllConnections();
    await pool.end().catch(() => {});
  }
});

test("a message flood closes the session", async () => {
  let closed: (d: boolean) => void = () => {};
  const closedP = new Promise<boolean>((r) => { closed = r; });
  const srv = await startWebServer({
    t: (sock: net.Socket) => { void new TcpSession(sock, 8, { firstPacketIds: null, onPacket() {}, onClose: (d) => closed(d) }).start(); },
  }, "127.0.0.1", 0);
  const port = (srv.address() as net.AddressInfo).port;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tcp?target=t`);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
    for (let i = 0; i < 2000; i++) ws.send(new Uint8Array(4));
    assert.equal(await closedP, true);
  } finally {
    srv.close();
    srv.closeAllConnections();
  }
});

// ----PB packets, not WS messages ---------------------------------------------------------------------------------

/** <n> plain PB frames [u16 2][2 payload bytes][3 trailer] in one buffer (counted, then ignored like the C#) */
const frames = (n: number) => new Uint8Array(n * 7).map((_, i) => (i % 7 === 0 ? 2 : 0));

async function closeCodeAfter(send: (ws: WebSocket) => void): Promise<{ code: number; logs: string[] }> {
  const logs: string[] = [];
  const srv = await startWebServer({
    t: (sock: net.Socket) => { void new TcpSession(sock, 9, { firstPacketIds: null, onPacket() {}, onClose() {}, log: (m) => logs.push(m) }).start(); },
  }, "127.0.0.1", 0);
  const port = (srv.address() as net.AddressInfo).port;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tcp?target=t`);
    ws.binaryType = "arraybuffer";
    await new Promise<void>((res, rej) => { ws.onmessage = () => res(); ws.onerror = () => rej(new Error("ws error")); }); // CONNECT_ACK
    const code = new Promise<number>((res) => { ws.onclose = (e) => res(e.code); });
    send(ws);
    return { code: await code, logs };
  } finally {
    srv.close();
    srv.closeAllConnections();
  }
}

test("one WS message with more than MAX_FRAMES_PER_CHUNK frames closes with 1008", async () => {
  const r = await closeCodeAfter((ws) => ws.send(frames(MAX_FRAMES_PER_CHUNK + 1)));
  assert.equal(r.code, 1008);
  assert.ok(r.logs.some((l) => l.includes("frames in one message")), r.logs.join("\n"));
});

test("the packet bucket counts frames: burst + 1 single-frame messages close with 1008", async () => {
  const r = await closeCodeAfter((ws) => { for (let i = 0; i <= config.pktBurst; i++) ws.send(frames(1)); });
  assert.equal(r.code, 1008);
  assert.ok(config.pktBurst < config.webMsgBurst, "the WS message bucket alone would let them through");
});

test("per-session log budget, one 'dropped' line when it runs out", () => {
  const lines: string[] = [];
  const s = new TcpSession({ remoteAddress: "10.0.0.1" } as net.Socket, 10, { firstPacketIds: null, onPacket() {}, onClose() {}, log: (m) => lines.push(m) });
  for (let i = 0; i < 500; i++) s.log(`unhandled opcode ${i}`);
  assert.equal(lines.length, 21);
  assert.match(lines[20], /log limit reached/);
});
