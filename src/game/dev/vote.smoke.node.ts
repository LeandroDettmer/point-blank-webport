// Vote HUD state machine (game/voteState.ts) fed with real packets parsed by net/voteClient.ts parseVote.
// node --experimental-transform-types src/game/dev/vote.smoke.node.ts
import assert from "node:assert/strict";
import { PacketReader, PacketWriter } from "../../net/packet.ts";
import { VoteErr, VoteOp, parseVote, type VoteEvent } from "../../net/voteClient.ts";
import { VOTE_RESULT_S, VOTE_START_S, VOTE_WINDOW_S, VoteModel } from "../voteState.ts";

const pkt = (w: PacketWriter) => new PacketReader(w.toBytes());
const ev = (op: number, w = new PacketWriter()): VoteEvent => parseVote(op, pkt(w))!;

let t = 0, me = 3, kicked = 0;
const notices: string[] = [], sent: boolean[] = [];
const mk = () => new VoteModel({ mySlot: () => me, now: () => t, notice: (s) => notices.push(s), onKicked: () => kicked++, onLocalVote: (y) => sent.push(y) });

// ---- kick vote, I am a bystander ----------------------------------------------------------------------------------
let m = mk();
assert.equal(m.view().phase, "idle");
m.handle(ev(VoteOp.kick.START, new PacketWriter().writeC(1).writeC(5).writeC(1)));
let v = m.view();
assert.equal(v.phase, "start");
assert.deepEqual([v.kind, v.creator, v.target, v.reason, v.accept, v.deny], ["kick", 1, 5, 1, 1, 1]);
assert.equal(m.canVote(), false, "no vote during the start notice");
t = VOTE_START_S + 0.1;
v = m.view();
assert.equal(v.phase, "guide");
assert.ok(v.canVote);
assert.ok(v.bar > 0.8 && v.bar < 1);
m.handle(ev(VoteOp.kick.CURRENT, new PacketWriter().writeC(2).writeC(1)));
assert.deepEqual([m.view().accept, m.view().deny], [2, 1]);
m.localVote(true);
assert.deepEqual(sent, [true]);
assert.equal(m.view().phase, "voted");
m.localVote(false);
assert.equal(sent.length, 1, "second vote is ignored");
t = 12;
m.handle(ev(VoteOp.kick.RESULT, new PacketWriter().writeC(5).writeC(4).writeC(1).writeD(0)));
v = m.view();
assert.equal(v.phase, "result");
assert.ok(v.result?.passed);
assert.deepEqual([v.accept, v.deny], [4, 1]);
t = 12 + VOTE_RESULT_S + 0.1;
assert.equal(m.view().phase, "idle");

// ---- rejected: the missing-enemies code ---------------------------------------------------------------------------
m = mk(); t = 100;
m.handle(ev(VoteOp.kick.START, new PacketWriter().writeC(0).writeC(2).writeC(0)));
m.handle(ev(VoteOp.kick.RESULT, new PacketWriter().writeC(2).writeC(3).writeC(1).writeD(VoteErr.NO_ENEMY)));
v = m.view();
assert.equal(v.result?.passed, false);
assert.equal(v.result?.why, "noenemy");

// ---- I started it / I am the target: counts only, no Yes / No -----------------------------------------------------
m = mk(); t = 200;
m.handle(ev(VoteOp.kick.START, new PacketWriter().writeC(me).writeC(7).writeC(0)));
t += VOTE_START_S + 0.1;
assert.equal(m.view().phase, "voted");
assert.equal(m.canVote(), false);
m = mk(); t = 300;
m.handle(ev(VoteOp.kick.START, new PacketWriter().writeC(7).writeC(me).writeC(1)));
t += VOTE_START_S + 0.1;
assert.equal(m.view().phase, "voted");

// ---- cancel, ack errors, kicked ------------------------------------------------------------------------------------
m = mk(); t = 400;
m.handle(ev(VoteOp.kick.START, new PacketWriter().writeC(0).writeC(2).writeC(0)));
m.handle(ev(VoteOp.kick.CANCEL));
assert.equal(m.view().result?.why, "cancel");
m.handle(ev(VoteOp.kick.START_ACK, new PacketWriter().writeD(VoteErr.ALREADY_RUNNING)));
m.handle(ev(VoteOp.kick.VOTE_ACK, new PacketWriter().writeD(VoteErr.ALREADY_VOTED)));
assert.equal(notices.length, 2);
m.handle(ev(VoteOp.kick.KICKED));
assert.equal(kicked, 1);

// ---- the server loses the vote: the panel does not stay forever -----------------------------------------------------
m = mk(); t = 500;
m.handle(ev(VoteOp.kick.START, new PacketWriter().writeC(0).writeC(2).writeC(0)));
t += VOTE_WINDOW_S + 3.5;
assert.equal(m.view().phase, "idle");

// ---- leader vote (web-only opcodes 9010-9021): starts at 0 / 0, result err 0 = approved -----------------------------
m = mk(); t = 600;
m.handle(ev(VoteOp.leader.START, new PacketWriter().writeC(1).writeC(4)));
v = m.view();
assert.deepEqual([v.kind, v.creator, v.target, v.accept, v.deny], ["leader", 1, 4, 0, 0]);
t += VOTE_START_S + 0.1;
assert.equal(m.view().phase, "guide");
m.localVote(false);
assert.equal(m.view().deny, 1);
m.handle(ev(VoteOp.leader.CURRENT, new PacketWriter().writeC(3).writeC(1)));
m.handle(ev(VoteOp.leader.RESULT, new PacketWriter().writeC(4).writeC(3).writeC(1).writeD(0)));
assert.equal(m.view().result?.passed, true);
assert.equal(m.view().kind, "leader");

// ---- unrelated opcodes are not votes; 5199 REQ of the F2 bomb test menu is a different direction, never parsed here ----
assert.equal(parseVote(3606, pkt(new PacketWriter())), null);

console.log("vote smoke: ok");
