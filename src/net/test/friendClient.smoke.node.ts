// requestFriend (friendClient.ts) against a fake connection: the request body is 1811 {U nick(66)}, and the answer is either
// 1815 (added) or 1812 {D err}. The server side of these frames is server handleFriendInvite (socialHandlers.ts).
// Run: node --experimental-transform-types src/net/test/friendClient.smoke.node.ts
import assert from "node:assert/strict";
import { PacketReader, PacketWriter } from "../packet.ts";
import { FriendErr, FriendOp, requestFriend, sendFindLobby } from "../friendClient.ts";
import type { PbConnection } from "../connection.ts";

class FakeConn {
  sent: { op: number; body: Uint8Array }[] = [];
  private waiters = new Map<number, (r: PacketReader) => void>();
  waitFor(op: number): Promise<PacketReader> {
    return new Promise((resolve) => this.waiters.set(op, resolve));
  }
  send(op: number, body?: PacketWriter | Uint8Array): void {
    this.sent.push({ op, body: body instanceof PacketWriter ? body.toBytes() : (body ?? new Uint8Array(0)) });
  }
  /** the server frame: `body` is what follows the opcode */
  answer(op: number, body: PacketWriter): void {
    this.waiters.get(op)?.(new PacketReader(body.toBytes()));
  }
}

const conn = () => new FakeConn() as unknown as PbConnection & FakeConn;

async function main(): Promise<void> {
{
  const c = conn();
  const p = requestFriend(c, "Amigo");
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].op, FriendOp.INVITE_REQ);
  assert.equal(c.sent[0].body.length, 66, "U nick(66) = 66 bytes, as in the whisper 1826");
  c.answer(FriendOp.INFO_CHANGE_ACK, new PacketWriter(4).writeC(1));
  assert.equal(await p, 0, "1815 = added");
}
{
  const c = conn();
  const p = requestFriend(c, "Ninguem");
  c.answer(FriendOp.INVITE_ERR_ACK, new PacketWriter(4).writeD(FriendErr.NOT_FOUND));
  assert.equal(await p, FriendErr.NOT_FOUND, "1812 {D err} = server error");
}
{
  const c = conn();
  const p = requestFriend(c, "Ja");
  c.answer(FriendOp.INVITE_ERR_ACK, new PacketWriter(4).writeD(FriendErr.ALREADY));
  assert.equal(await p, FriendErr.ALREADY);
}
{
  // Buscar (sendFindLobby): opcode 297, the nick in 33 bytes, zero padded (exe 0x59223f WriteData(nick, 0x21))
  const c = conn();
  sendFindLobby(c, "Amigo");
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].op, 297);
  assert.equal(c.sent[0].body.length, 33);
  assert.deepEqual([...c.sent[0].body.subarray(0, 5)], [...new TextEncoder().encode("Amigo")]);
  assert.ok(c.sent[0].body.subarray(5).every((b) => b === 0), "rest of the 33 bytes is zero");
  // 0x78e710 guard: a nick of 33 bytes or more sends nothing
  sendFindLobby(c, "x".repeat(33));
  assert.equal(c.sent.length, 1);
}
console.log("friendClient smoke: ok");
}

main();
