// End-to-end: AuthClient/GameClient (Node global WebSocket) -> the server web front (web/webServer.ts, in this
// process) -> mock PB TCP servers that frame/decrypt exactly like Server.Auth/Server.Game (AuthClient.cs
// OnReceiveCallback, CheckSeed, PROTOCOL_BASE_LOGIN_REQ.Read, *_ACK.Write).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type { Server as HttpServer } from "node:http";
import { startWebServer } from "../../../server/src/web/webServer.ts";
import { cmessDecrypt, nextSessionSeed, MODE_AUTH } from "../cmess.ts";
import { PacketReader, PacketWriter } from "../packet.ts";
import { AuthClient } from "../authClient.ts";
import { GameClient } from "../gameClient.ts";
import { deriveWebToken } from "../token.ts";
import { toBase64 } from "../bytes.ts";

const TOKEN_USER = "webtest";
const PLAYER_ID = 4242n;
let expectedToken = "";
const log: string[] = [];

/** Mirrors AuthClient.SendPacket: [u16 N+2][N][5 zero bytes]. */
function frame(w: PacketWriter): Buffer {
  const p = w.toBytes();
  const out = Buffer.alloc(2 + p.length + 5);
  out.writeUInt16LE(p.length + 2, 0);
  out.set(p, 2);
  return out;
}

function mockServer(kind: "auth" | "game"): net.Server {
  return net.createServer((sock) => {
    const sessionId = 7 + Math.floor(Math.random() * 1000);
    const seed = Math.floor(Math.random() * 65536);
    let next = seed;
    const modulus = new Uint8Array(170).map(() => Math.floor(Math.random() * 256));
    new DataView(modulus.buffer).setInt32(0, sessionId + 29890, true);
    const clientKey = modulus.slice(16, 32);
    const exp = Uint8Array.from([1, 0, 1]);
    sock.write(frame(new PacketWriter().writeH(2306).writeH(0).writeC(11).zeros(11)
      .writeH(modulus.length + exp.length + 2).writeH(modulus.length).writeB(modulus).writeB(exp)
      .writeC(118).writeH(0).writeH(seed).writeD(sessionId)));
    let rem = Buffer.alloc(0);
    sock.on("data", (d) => {
      rem = Buffer.concat([rem, d]);
      let off = 0;
      while (off + 2 <= rem.length) {
        const hw = rem.readUInt16LE(off);
        const enc = (hw & 0x8000) !== 0;
        const pl = hw & 0x7fff;
        const wire = enc ? 3 + pl : 5 + pl;
        if (off + wire > rem.length) break;
        assert.ok(enc, "client must send encrypted frames");
        const pt = cmessDecrypt(clientKey, rem.subarray(off + 2, off + 2 + pl), MODE_AUTH);
        assert.ok(pt, "CMess pad check");
        const r = new PacketReader(pt!);
        const op = r.readH();
        const pseed = r.readH();
        let ok = false;
        for (let i = 0; i < 16 && !ok; i++) ok = (next = nextSessionSeed(next)) === pseed;
        assert.ok(ok, `seed accepted for op ${op}`);
        log.push(`${kind}:${op}`);
        handle(kind, op, r, sock);
        off += wire;
      }
      rem = rem.subarray(off);
    });
    sock.on("error", () => {});
  });
}

function handle(kind: string, op: number, r: PacketReader, sock: net.Socket): void {
  if (kind === "auth" && op === 1281) {
    r.skip(4);
    const mac = r.readB(6);
    assert.ok(mac.some((b) => b !== 0), "non-zero MAC");
    r.skip(21);
    assert.ok(r.readH() > 0 && r.readH() > 0, "resolution");
    r.skip(10);
    r.readS(r.readC());
    r.skip(16);
    assert.equal(r.readC(), 9);
    assert.equal(`${r.readC()}.${r.readC()}`, "122.0");
    r.skip(1);
    const tok = toBase64(r.readB(r.readH()));
    const good = tok === expectedToken;
    const w = new PacketWriter().writeH(1283).writeH(0).writeD(0x1234).writeB([1, 3, 0]).zeros(9).writeD(0).writeH(1531).zeros(16);
    if (good) {
      const pid = String(PLAYER_ID);
      w.writeC(pid.length).writeS(pid, pid.length).writeC(0).writeC(TOKEN_USER.length).writeS(TOKEN_USER, TOKEN_USER.length).writeQ(PLAYER_ID);
    } else w.zeros(11);
    sock.write(frame(w.writeD(good ? 0 : 0x80000117)));
  } else if (op === 2399) {
    const w = new PacketWriter().writeH(2400).writeH(0).writeC(2);
    for (const port of [39190, 39191]) {
      w.writeD(1).writeB([127, 0, 0, 1]).writeB([127, 0, 0, 1]).writeH(port).writeC(0).writeH(1000).writeD(3);
      if (port === 39190) w.writeB([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0x0e, 0, 0, 0, 0]);
      else w.writeB([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]).writeC(0).writeC(0).writeH(0);
    }
    sock.write(frame(w.writeC(0)));
  } else if (op === 2332) {
    assert.equal(r.readD(), 1);
    const w = new PacketWriter().writeH(2333).writeD(0).writeD(1).writeD(0).writeH(0).writeC(0).writeC(11);
    for (let i = 0; i < 11; i++) w.writeH(i);
    sock.write(frame(w.writeH(310).writeH(200).writeC(11).writeC(0)));
  } else if (kind === "auth" && op === 2328) {
    sock.write(frame(new PacketWriter().writeH(2329).writeH(0).writeD(0)));
    setTimeout(() => sock.end(), 10);
  } else if (kind === "game" && op === 2330) {
    const user = r.readS(r.readC());
    const pid = r.readQ();
    assert.equal(user, TOKEN_USER);
    assert.equal(pid, PLAYER_ID);
    sock.write(frame(new PacketWriter().writeH(2331).writeD(0)));
    sock.write(frame(new PacketWriter().writeH(9999).zeros(40))); // unrelated push packets are ignored
  } else if (op === 2334) {
    r.skip(4);
    const ch = r.readH();
    sock.write(frame(new PacketWriter().writeH(2335).writeH(0).writeD(0).writeD(1).writeH(ch)));
  } else if (op === 2583) {
    sock.write(frame(new PacketWriter().writeH(2584).writeD(0).writeC(0).writeC(0).writeD(0).zeros(9)));
  } else if (op === 2587) {
    const w = new PacketWriter().writeH(2588).writeD(1).writeD(0).writeD(1);
    w.writeD(0).writeU("Sala do webtest", 46).writeC(5).writeC(1).writeC(2).writeC(0).writeC(1)
      .writeC(3).writeC(16).writeC(0).writeH(0x0f).writeD(0).writeH(0).writeB([10, 0, 0, 5]).writeC(0);
    w.writeD(1).writeD(0).writeD(1);
    w.writeD(77).writeD(0).writeC(0).writeU("", 34).writeC(12).writeC(0).writeC(0).writeU("NickWeb", 66)
      .writeC(9).writeC(0).writeD(0).writeC(0).writeC(0);
    sock.write(frame(w));
  }
}

const servers: net.Server[] = [];
let web: HttpServer;
let gwUrl = "";

/** what the web front does for a real server (accept(sock)), here: pipe the session to a mock TCP server */
const pipeTo = (port: number) => (ws: net.Socket) => {
  const up = net.connect(port, "127.0.0.1");
  ws.pipe(up);
  up.pipe(ws);
  up.on("close", () => ws.destroy());
  ws.on("close", () => up.destroy());
};

async function listen(s: net.Server): Promise<number> {
  await new Promise<void>((res) => s.listen(0, "127.0.0.1", res));
  return (s.address() as net.AddressInfo).port;
}

before(async () => {
  expectedToken = toBase64(await deriveWebToken("webtest", "webtest123"));
  const auth = mockServer("auth");
  const game = mockServer("game");
  servers.push(auth, game);
  const [ap, gp] = [await listen(auth), await listen(game)];
  web = await startWebServer({ auth: pipeTo(ap), game1: pipeTo(gp) }, "127.0.0.1", 0);
  gwUrl = `ws://127.0.0.1:${(web.address() as net.AddressInfo).port}`;
});

after(() => {
  web?.close();
  web?.closeAllConnections();
  for (const s of servers) s.close();
});

test("wrong password -> LOGIN_ID_PASS_INCORRECT", async () => {
  const a = new AuthClient(gwUrl);
  const res = await a.connectAndLogin({ token: await deriveWebToken("webtest", "nope") });
  assert.equal(res.ok, false);
  assert.match(res.errorName, /LOGIN_ID_PASS_INCORRECT/);
  a.conn.close();
});

test("login -> servers -> channels -> leave -> game enter -> channel -> lobby -> rooms", async () => {
  const a = new AuthClient(gwUrl);
  const res = await a.connectAndLogin({ token: await deriveWebToken("webtest", "webtest123"), mac: Uint8Array.from([2, 1, 2, 3, 4, 5]) });
  assert.ok(res.ok, res.errorName);
  assert.equal(res.username, "webtest");
  assert.equal(res.playerId, PLAYER_ID);
  const servers = await a.getServers();
  assert.equal(servers.length, 2);
  assert.equal(servers[1].port, 39191);
  const ch = await a.getChannels(1);
  assert.equal(ch?.channelPlayers.length, 11);
  assert.equal(ch?.maxPerChannel, 200);
  await a.leave();

  const g = new GameClient("game1", gwUrl);
  await g.enter(res.username, res.playerId, 1);
  await g.selectChannel(3);
  assert.equal(g.channelId, 3);
  await g.enterLobby();
  const page = await g.getRoomList();
  assert.ok(page);
  assert.equal(page.rooms[0].name, "Sala do webtest");
  assert.equal(page.rooms[0].leaderAddr, "10.0.0.5");
  assert.equal(page.rooms[0].slots, 16);
  assert.equal(page.players[0].nickname, "NickWeb");
  g.close();
  assert.deepEqual(log.filter((l) => !l.endsWith(":2309")).slice(-8),
    ["auth:1281", "auth:2399", "auth:2332", "auth:2328", "game:2330", "game:2334", "game:2583", "game:2587"]);
});
