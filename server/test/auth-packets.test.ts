// Offline checks of the TS Auth packet writers .
//   node --test test/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PacketReader } from "../../src/net/packet.ts";
import { toHex } from "../../src/net/bytes.ts";
import { cmessDecrypt, cmessEncrypt, MODE_AUTH } from "../../src/net/cmess.ts";
import { loginAck, validateKey, channelListAck, gameServerStateAck, userLeaveAck, EventError } from "../src/auth/packets.ts";
import { generateSessionKeys, writeConnectAck } from "../src/net/tcpSession.ts";

test("ValidateKey: {hw%999:000}{pid%999:000}{session%999:000}", () => {
  assert.equal(validateKey(126n, 1, 0x02424557), 494126001);
  assert.equal(validateKey(1000n, 999, 5), 5001000);
});

test("LOGIN_ACK success/failure layout (as parsed by src/net/authClient.ts parseLoginAck)", () => {
  const ok = loginAck(0, 123456789, 0x87fd776e, { playerId: 126n, username: "w17abc" });
  const r = new PacketReader(ok, 2);
  r.readH();
  assert.equal(r.readD(), 123456789);
  r.skip(12);
  assert.equal(r.readD(), 0x87fd776e);
  assert.equal(r.readH(), 1531);
  r.skip(16);
  assert.equal(r.readS(r.readC()), "126");
  r.readC();
  assert.equal(r.readS(r.readC()), "w17abc");
  assert.equal(r.readQ(), 126n);
  assert.equal(r.readD(), 0);
  const bad = loginAck(EventError.LOGIN_ID_PASS_INCORRECT, 0, 1, null);
  assert.equal(bad.length, 2 + 2 + 4 + 12 + 4 + 2 + 16 + 11 + 4);
  assert.equal(new DataView(bad.buffer).getUint32(bad.length - 4, true), 0x80000117);
});

test("CONNECT_ACK carries modulus with SessionId+29890 in bytes 0..4; keys are modulus[0..16]/[16..32]", async () => {
  const { modulus, exponent } = await generateSessionKeys(7);
  assert.equal(modulus.length, 170);
  assert.equal(toHex(exponent), "010001");
  assert.equal(new DataView(modulus.buffer).getInt32(0, true), 7 + 29890);
  const ack = writeConnectAck(7, 1234, modulus, exponent);
  assert.equal(ack.length, 202); // + 2 trailer zeros = the 204 FrameDecoder yields
  const clientKey = modulus.slice(16, 32);
  const pt = Uint8Array.from([1, 5, 9, 0, 1, 2, 3]);
  assert.deepEqual(cmessDecrypt(clientKey, cmessEncrypt(clientKey, pt, MODE_AUTH), MODE_AUTH), pt);
});

test("GAME_SERVER_STATE / CHANNELLIST / USER_LEAVE sizes", () => {
  const servers = [0, 1].map((id) => ({ id, state: id > 0, host: "127.0.0.1", port: 39190 + id, type: id ? 3 : 0, maxPlayers: 2000, lastPlayers: 0, channelPlayers: 180 }));
  const chans = Array.from({ length: 11 }, (_, i) => ({ serverId: 1, id: i, type: i === 10 ? 14 : 1, totalPlayers: 0 }));
  assert.equal(gameServerStateAck(servers, chans).length, 2 + 2 + 1 + 2 * 36 + 1);
  assert.equal(channelListAck(servers[1], chans).length, 2 + 16 + 22 + 6);
  assert.equal(toHex(userLeaveAck(0)), "190900000000" + "0000");
});
