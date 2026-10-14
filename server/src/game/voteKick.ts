// Vote kick in battle: port of Server.Game PROTOCOL_BATTLE_START_KICKVOTE_REQ / PROTOCOL_BATTLE_NOTIFY_CURRENT_KICKVOTE_REQ, AllUtils.VotekickResult,
// RoomModel.StartVote (20 s window) and VoteKickModel (Plugin.Core). The C# GameClient never wired the handlers to an opcode: REQ 5190 / 5194 are
// [INFERIDO].
//   REQ 5190 {C target, C motive}   -> ACK 5191 {D err} to the creator; 5193 {C creator, C target, C motive} to the others in BATTLE (not creator / target)
//   REQ 5194 {C vote (0 yes, 1 no)} -> ACK 5195 {D err} only on error; 5201 {C accept, C deny} to BATTLE while it runs
//   result 5197 {C target, C accept, C deny, D err} to BATTLE; 5199 {} cancelled; 5203 {} to the kicked player
// Motive (VoteKickEnum): 0 NoManner, 1 IllegalProgram, 2 Abuse, 3 ETC; the scene only offers Hack / Chat: 0 = chat, 1 = hack [INFERIDO].
// Changes from the C# (plan: only slots still in BATTLE count as in game, bots never vote nor get voted, no vote below 4 human players
// in BATTLE, rank minimum PB_VOTE_MIN_RANK (default 5 [RECRIADO], GM bypass), timer cleared at battle end, vote cancelled when the creator or
// the target leaves, and the kick reaches the P2P layer (web/signal.ts closes the kicked slot's socket and tells the host).
import { PacketReader, PacketWriter } from "../../../src/net/packet.ts";
import { kickSlot, handoffHost, signalKey } from "../web/signal.ts";
import type { Account } from "../shared/account.ts";
import { RoomState, SlotState, type RoomModel } from "./roomModel.ts";
import * as rp from "./roomPackets.ts";
import { removePlayer } from "./roomHandlers.ts";
import { handoffLeader, pickBestLeader } from "./voteLeader.ts";
import {
  activeVote, accountOfSlot, battleHumans, clearVote, clock, cooldownLeft, openVote, roomOf, sendBattle, setCooldown, voteRankOk, VOTE_MIN_HUMANS,
  VOTE_WINDOW_MS, type RoomVote,
} from "./voteCommon.ts";
import type { GameClient } from "./gameServer.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} [vote-ts] ${m}`);

export const KICK_ERR = {
  fail: 0x80000000,
  active: 0x80001200,
  cooldown: 0x80001201,
  rank: 0x80001205,
  voted: 0x80001211,
  /** [RECRIADO] fewer than 4 human players in BATTLE */
  fewPlayers: 0x80001206,
  /** [RECRIADO] the target is a GM / protected */
  protectedTarget: 0x80001207,
} as const;
export const KICK_RESULT = { rejected: 2147488000, noAllies: 2147488001, noEnemies: 2147488002 } as const;
export const KICK_COOLDOWN_MS = 60000;
export const KICK_MIN_HUMANS = VOTE_MIN_HUMANS;

/** The side effects, replaceable by the unit tests. */
export const deps = {
  removePlayer: (r: RoomModel, p: Account, warnAll: boolean, motive: number): void => removePlayer(r, p, warnAll, motive),
  kickSlot: (key: string, slot: number): void => kickSlot(key, slot),
  handoffHost: (key: string, slot: number): void => handoffHost(key, slot),
  handoffLeader: (r: RoomModel, slot: number): void => handoffLeader(r, slot),
};

const roomKey = (r: RoomModel) => signalKey(r.uniqueRoomId, r.seed);

/** REQ 5190 (START_KICKVOTE). Returns the error code (0 = started); <ack> runs once it is accepted, before the room is told. */
export function startKickVote(p: Account, target: number, motive: number, ack: () => void = () => {}): number {
  const r = roomOf(p);
  if (!r || r.state !== RoomState.BATTLE) return KICK_ERR.fail;
  const me = r.getSlot(p.slotId), vs = r.getSlot(target);
  if (!me || !vs || me.id === vs.id || me.playerId !== p.playerId) return KICK_ERR.fail;
  if (me.state !== SlotState.BATTLE || vs.state !== SlotState.BATTLE || me.specGM || vs.specGM) return KICK_ERR.fail;
  const victim = accountOfSlot(r, vs.id);
  if (!victim) return KICK_ERR.fail; // a bot slot
  if (!voteRankOk(p)) return KICK_ERR.rank;
  if (activeVote(r)) return KICK_ERR.active;
  if (cooldownLeft(r, "kick", me.id) > 0) return KICK_ERR.cooldown;
  const humans = battleHumans(r);
  if (humans.length < VOTE_MIN_HUMANS) return KICK_ERR.fewPlayers;
  if ((victim.isGM() || victim.antiKickGM) && !p.isGM()) return KICK_ERR.protectedTarget;
  setCooldown(r, "kick", me.id, KICK_COOLDOWN_MS);
  const v: RoomVote = {
    kind: "kick", creator: me.id, victim: vs.id, motive: motive & 0xff, accept: 1, deny: 1, allies: 0, enemies: 0,
    votes: new Set([me.id, vs.id]), total: r.slots.map((s) => humans.includes(s)), timer: null,
  };
  openVote(r, v);
  v.timer = clock.setTimer(() => kickVoteResult(r, v), VOTE_WINDOW_MS);
  ack();
  sendBattle(r, new PacketWriter(8).writeH(5193).writeC(me.id).writeC(vs.id).writeC(v.motive).toBytes(), me.id, vs.id);
  log(`room #${r.roomId} vote kick: slot ${me.id} -> slot ${vs.id} (motive ${v.motive})`);
  return 0;
}

/** REQ 5194 (NOTIFY_CURRENT_KICKVOTE). Returns the error code (0 = counted, silent in the C#). */
export function castKickVote(p: Account, yes: boolean): number {
  const r = roomOf(p);
  const v = r ? activeVote(r) : null;
  if (!r || !v || v.kind !== "kick" || r.state !== RoomState.BATTLE) return KICK_ERR.fail;
  const s = r.getSlot(p.slotId);
  if (!s || s.state !== SlotState.BATTLE || s.specGM || s.playerId !== p.playerId || !v.total[s.id]) return KICK_ERR.fail;
  if (v.votes.has(s.id)) return KICK_ERR.voted;
  v.votes.add(s.id);
  if (yes) {
    v.accept++;
    if (s.team !== r.slots[v.victim].team) v.enemies++; else v.allies++;
  } else v.deny++;
  const inGame = battleHumans(r).filter((x) => v.total[x.id]).length;
  if ([...v.votes].filter((id) => v.total[id]).length >= inGame) kickVoteResult(r, v);
  else sendBattle(r, new PacketWriter(8).writeH(5201).writeC(v.accept).writeC(v.deny).toBytes());
  return 0;
}

/**
 * AllUtils.VotekickResult. Passes with Accept > Denie, a yes from an ally AND from an enemy of the target (the creator's and the target's own
 * initial votes do not count as ally / enemy, like the C#) and votes >= inGame / 2. The C# error block reads inverted in the decompile (the
 * 2147488000 "rejected" code on Denie < Accept); here the error is set exactly when the vote did not pass.
 */
export function kickVoteResult(r: RoomModel, v: RoomVote): void {
  if (activeVote(r) !== v) return;
  clearVote(r);
  const inGame = battleHumans(r).filter((s) => v.total[s.id]).length;
  const voted = [...v.votes].filter((id) => v.total[id] && accountOfSlot(r, id)).length;
  const pass = v.accept > v.deny && v.enemies > 0 && v.allies > 0 && voted >= Math.trunc(inGame / 2);
  let err = 0;
  if (!pass) err = v.allies === 0 ? KICK_RESULT.noAllies : v.enemies === 0 ? KICK_RESULT.noEnemies : KICK_RESULT.rejected;
  const victim = pass ? accountOfSlot(r, v.victim) : null;
  if (victim) {
    log(`room #${r.roomId} vote kick passed: slot ${v.victim} (${victim.nickname}) ${v.accept} yes / ${v.deny} no`);
    const bye = new PacketWriter(4).writeH(5203).toBytes();
    (victim.connection as GameClient | null)?.session.send(bye);
    r.kickedPlayersVote.push(victim.playerId);
    // victim = leader = P2P host: the leadership moves to the best-ping player first (SLOTINFO, 5149, host role), then he is removed
    if (r.leader === v.victim) { const next = pickBestLeader(r, v.victim); if (next >= 0) deps.handoffLeader(r, next); }
    deps.kickSlot(roomKey(r), v.victim);
    deps.removePlayer(r, victim, true, 2);
  } else if (pass) err = KICK_RESULT.rejected; // the target was gone by now
  sendBattle(r, new PacketWriter(16).writeH(5197).writeC(v.victim).writeC(v.accept).writeC(v.deny).writeD(err).toBytes());
}

export function handleKickVoteStart(c: GameClient, rd: PacketReader): void {
  const target = rd.readC(), motive = rd.readC();
  const p = c.player;
  if (!p) return;
  let acked = false;
  const err = startKickVote(p, target, motive, () => { acked = true; c.session.send(rp.errAck(5191, 0)); });
  if (!acked) c.session.send(rp.errAck(5191, err));
}

export function handleKickVoteCast(c: GameClient, rd: PacketReader): void {
  const vote = rd.readC();
  const p = c.player;
  if (!p) return;
  const err = castKickVote(p, vote === 0);
  // the C# answers only; the other refusals (no vote running, not a voter) stay silent too
  if (err === KICK_ERR.voted) c.session.send(rp.errAck(5195, err));
}
