// Leader vote in battle. The room leader is the P2P host (his
// browser runs the matchCore), so changing the leader in a match = changing the host: Server.Game decides (room.leader + SLOTINFO + 5149),
// web/signal.ts hands the host role over in one call, the old host is cut off and BattleNet.failover (src/net/battle.ts) re-hosts on the new leader.
//   REQ 9010 {C targetSlot (255 = best ping)} -> ACK 9011 {D err}; to the room: 9013 {C creator, C target}
//   REQ 9014 {C vote (0 yes, 1 no)}           -> ACK 9015 {D err}; to the room: 9017 {C accept, C deny}
//   result 9019 {C target, C accept, C deny, D err (0 = approved)}; 9021 {} cancelled (creator / target left, voteCommon.ts)
// Rules [RECRIADO]: any human in BATTLE with the kick vote's rank (PB_VOTE_MIN_RANK, GM bypass) can start; 2 min cooldown per slot; shares the
// single-vote semaphore with the kick vote; >= 4 humans in BATTLE like the kick vote (with 3, 2 accounts of one player took
// the host); target in BATTLE with the best ping (<= 120 ms when named); passes with a simple majority of the humans in BATTLE (>= 50% + 1).
import { PacketReader, PacketWriter } from "../../../src/net/packet.ts";
import { handoffHost, signalKey } from "../web/signal.ts";
import { RoomState, SlotState, type RoomModel } from "./roomModel.ts";
import * as rp from "./roomPackets.ts";
import {
  activeVote, battleHumans, clearVote, clock, cooldownLeft, openVote, roomOf, sendBattle, setCooldown, voteRankOk, VOTE_MIN_HUMANS, VOTE_WINDOW_MS,
  type RoomVote,
} from "./voteCommon.ts";
import type { Account } from "../shared/account.ts";
import type { GameClient } from "./gameServer.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} [vote-ts] ${m}`);

export const LEADER_ERR = {
  fail: 0x80000000,
  active: 0x80001200,
  cooldown: 0x80001201,
  /** same codes as KICK_ERR.rank / KICK_ERR.fewPlayers (voteKick.ts) */
  rank: 0x80001205,
  voted: 0x80001211,
  fewPlayers: 0x80001206,
  badTarget: 0x80002101,
  highPing: 0x80002102,
  rejected: 0x80002100,
} as const;
export const LEADER_COOLDOWN_MS = 120000;
export const LEADER_MIN_HUMANS = VOTE_MIN_HUMANS;
export const MAX_LEADER_PING = 120;
const BEST = 255;

/** Ping of <slot> for the leader choice: mean of what the other slots reported for it in 5146 SENDPING (0 / 255 = no data); the slot's own
 * TIMERSYNC ping when nobody did [INFERIDO: the unit of the 5146 bytes is not decoded, treated as ms]. 255 = unknown. */
export function pingOf(r: RoomModel, slot: number): number {
  let sum = 0, n = 0;
  for (const [from, b] of r.pingReports) {
    const v = from === slot ? 0 : (b[slot] ?? 0);
    if (v > 0 && v < 255) { sum += v; n++; }
  }
  if (n) return Math.round(sum / n);
  if (r.pingReports.size > 0) return 255; // others measured the room and nobody saw this slot: unknown, never the "best"
  const own = r.slots[slot]?.ping ?? 255;
  return own > 0 ? own : 255;
}

/** The BATTLE human with the best ping, never <exclude> and never the current leader (a slot already leading is not a candidate). -1 = none. */
export function pickBestLeader(r: RoomModel, exclude = -1): number {
  let best = -1, bestPing = Infinity;
  for (const s of battleHumans(r)) {
    if (s.id === exclude || s.id === r.leader) continue;
    const p = pingOf(r, s.id);
    if (p < bestPing) { best = s.id; bestPing = p; }
  }
  return best;
}

/**
 * Makes <slot> the leader of a room in battle: RoomModel.SetNewLeader, SLOTINFO (3595), 5149 (LEAVE_P2P with the new leader, what RemovePlayer
 * sends when the leader quits) and the atomic host switch of /signal (the old host's host socket is closed: it demotes to guest while the new
 * leader's client re-hosts through BattleNet.failover).
 */
export function handoffLeader(r: RoomModel, slot: number): void {
  r.setNewLeader(slot, SlotState.EMPTY, -1, false);
  r.updateSlotsInfo();
  r.sendToPlayers(rp.leaveP2PAck(r.leader), r.getAllPlayers(SlotState.RENDEZVOUS, 1));
  handoffHost(signalKey(r.uniqueRoomId, r.seed), slot);
}

/** Humans needed for a simple majority. */
const majority = (humans: number) => Math.trunc(humans / 2) + 1;

/** REQ 9010. Returns the error code (0 = vote started); <ack> runs once the vote is accepted, before it is announced to the room. */
export function startLeaderVote(p: Account, target: number, ack: () => void = () => {}): number {
  const r = roomOf(p);
  if (!r || r.state !== RoomState.BATTLE) return LEADER_ERR.fail;
  const me = r.getSlot(p.slotId);
  if (!me || me.state !== SlotState.BATTLE || me.specGM || me.playerId !== p.playerId) return LEADER_ERR.fail;
  if (!voteRankOk(p)) return LEADER_ERR.rank;
  const humans = battleHumans(r);
  if (humans.length < LEADER_MIN_HUMANS) return LEADER_ERR.fewPlayers;
  if (activeVote(r)) return LEADER_ERR.active;
  if (cooldownLeft(r, "leader", me.id) > 0) return LEADER_ERR.cooldown;
  let t = target;
  if (t === BEST) t = pickBestLeader(r);
  else if (!humans.some((s) => s.id === t) || t === r.leader) return LEADER_ERR.badTarget;
  else if (pingOf(r, t) > MAX_LEADER_PING && pingOf(r, t) !== 255) return LEADER_ERR.highPing;
  if (t < 0) return LEADER_ERR.badTarget;
  setCooldown(r, "leader", me.id, LEADER_COOLDOWN_MS);
  const v: RoomVote = {
    kind: "leader", creator: me.id, victim: t, motive: 0, accept: 1, deny: 0, allies: 0, enemies: 0,
    votes: new Set([me.id]), total: r.slots.map((s) => humans.includes(s)), timer: null,
  };
  openVote(r, v);
  v.timer = clock.setTimer(() => finishLeaderVote(r, v), VOTE_WINDOW_MS);
  ack();
  sendBattle(r, new PacketWriter(8).writeH(9013).writeC(me.id).writeC(t).toBytes());
  log(`room #${r.roomId} leader vote: slot ${me.id} proposes slot ${t}`);
  evaluate(r, v); // the opening count (9017)
  return 0;
}

/** REQ 9014. Returns the error code (0 = counted). */
export function castLeaderVote(p: Account, yes: boolean): number {
  const r = roomOf(p);
  const v = r ? activeVote(r) : null;
  if (!r || !v || v.kind !== "leader") return LEADER_ERR.fail;
  const s = r.getSlot(p.slotId);
  if (!s || s.state !== SlotState.BATTLE || s.specGM || s.playerId !== p.playerId || !v.total[s.id]) return LEADER_ERR.fail;
  if (v.votes.has(s.id)) return LEADER_ERR.voted;
  v.votes.add(s.id);
  if (yes) v.accept++; else v.deny++;
  evaluate(r, v);
  return 0;
}

/** Closes the vote as soon as the outcome is certain, else announces the running count (9017). */
function evaluate(r: RoomModel, v: RoomVote): void {
  const n = battleHumans(r).filter((s) => v.total[s.id]).length;
  const need = majority(n);
  if (v.accept >= need || v.deny > n - need || v.votes.size >= n) return finishLeaderVote(r, v);
  sendBattle(r, new PacketWriter(8).writeH(9017).writeC(v.accept).writeC(v.deny).toBytes());
}

/** The 20 s timer, or an early close. */
export function finishLeaderVote(r: RoomModel, v: RoomVote): void {
  if (activeVote(r) !== v) return;
  clearVote(r);
  const humans = battleHumans(r).filter((s) => v.total[s.id]);
  const approved = v.accept >= majority(humans.length) && v.accept > v.deny && humans.some((s) => s.id === v.victim) && v.victim !== r.leader;
  const err = approved ? 0 : LEADER_ERR.rejected;
  sendBattle(r, new PacketWriter(16).writeH(9019).writeC(v.victim).writeC(v.accept).writeC(v.deny).writeD(err).toBytes());
  log(`room #${r.roomId} leader vote for slot ${v.victim}: ${v.accept} yes / ${v.deny} no -> ${approved ? "approved" : "rejected"}`);
  if (approved) handoffLeader(r, v.victim);
}

export function handleLeaderVoteStart(c: GameClient, rd: PacketReader): void {
  const target = rd.readC();
  const p = c.player;
  if (!p) return;
  let acked = false;
  const err = startLeaderVote(p, target, () => { acked = true; c.session.send(rp.errAck(9011, 0)); });
  if (!acked) c.session.send(rp.errAck(9011, err));
}

export function handleLeaderVoteCast(c: GameClient, rd: PacketReader): void {
  const vote = rd.readC();
  const p = c.player;
  if (!p) return;
  c.session.send(rp.errAck(9015, castLeaderVote(p, vote === 0)));
}
