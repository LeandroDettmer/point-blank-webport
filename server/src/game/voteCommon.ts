// Shared state of the in-battle votes (voteKick.ts, voteLeader.ts): ONE vote per room at a time (the C# `VoteTime` timer / `VoteKick`
// field is that semaphore), the 20 s window, per-slot cooldowns, and the cancel / cleanup hooks.
// Everything here is in memory: votes are never saved.
import { PacketWriter } from "../../../src/net/packet.ts";
import { config } from "../config.ts";
import type { Account } from "../shared/account.ts";
import { RoomState, SlotState, battleEndHooks, slotLeftHooks, type RoomModel, type SlotModel } from "./roomModel.ts";

export type VoteKind = "kick" | "leader";

/** VoteKickModel (Plugin.Core/Models/VoteKickModel.cs), also used by the leader vote. */
export interface RoomVote {
  kind: VoteKind;
  creator: number;
  victim: number;
  motive: number;
  accept: number;
  deny: number;
  allies: number;
  enemies: number;
  /** slots that already voted (the C# `Votes`) */
  votes: Set<number>;
  /** slots that were in BATTLE when the vote started (the C# `TotalArray`) */
  total: boolean[];
  timer: ReturnType<typeof setTimeout> | null;
}

/** Replaced by the unit tests. */
export const clock = {
  now: (): number => Date.now(),
  setTimer: (fn: () => void, ms: number): ReturnType<typeof setTimeout> => setTimeout(fn, ms),
  clearTimer: (t: ReturnType<typeof setTimeout>): void => clearTimeout(t),
};

export const VOTE_WINDOW_MS = 20000;
/** Humans in BATTLE both votes need [RECRIADO]. The leader vote asked for 3 until2 accounts of one player won it. */
export const VOTE_MIN_HUMANS = 4;

/** Rank floor of both votes: PB_VOTE_MIN_RANK, GM bypass. */
export const voteRankOk = (p: Account): boolean => p.rank >= config.voteMinRank || p.isGM();

const active = new WeakMap<RoomModel, RoomVote>();
const cooldowns = new WeakMap<RoomModel, Map<string, number>>();
/** how each kind announces a cancelled vote (5199 / 9021, empty body) */
const CANCEL_OP: Record<VoteKind, number> = { kick: 5199, leader: 9021 };

/** Account.Room */
export const roomOf = (a: Account | null): RoomModel | null => (a?.room as RoomModel | null) ?? null;

export const activeVote = (r: RoomModel): RoomVote | null => active.get(r) ?? null;

export function openVote(r: RoomModel, v: RoomVote): void { active.set(r, v); }

/** Stops the timer and forgets the vote (no packet). */
export function clearVote(r: RoomModel): void {
  const v = active.get(r);
  if (v?.timer) clock.clearTimer(v.timer);
  active.delete(r);
}

/** Milliseconds left of the cooldown of <slot> for <kind> (0 = free). */
export function cooldownLeft(r: RoomModel, kind: VoteKind, slot: number): number {
  return Math.max(0, (cooldowns.get(r)?.get(`${kind}:${slot}`) ?? 0) - clock.now());
}
export function setCooldown(r: RoomModel, kind: VoteKind, slot: number, ms: number): void {
  let m = cooldowns.get(r);
  if (!m) cooldowns.set(r, (m = new Map()));
  m.set(`${kind}:${slot}`, clock.now() + ms);
}

/** The human players that can take part: in BATTLE, with an account sitting in the slot, not a GM spectator. Bots (no player id) are out. */
export function battleHumans(r: RoomModel): SlotModel[] {
  const out: SlotModel[] = [];
  for (const s of r.slots) {
    if (s.playerId <= 0n || s.state !== SlotState.BATTLE || s.specGM) continue;
    const a = r.svc.getAccount(s.playerId);
    if (a && a.slotId === s.id) out.push(s);
  }
  return out;
}

export const accountOfSlot = (r: RoomModel, slot: number): Account | null => {
  const s = r.getSlot(slot);
  const a = s && s.playerId > 0n ? r.svc.getAccount(s.playerId) : null;
  return a && a.slotId === slot ? a : null;
};

/** To every slot in BATTLE (SendPacketToPlayers(packet, SlotState.BATTLE, 0, exc...)). */
export const sendBattle = (r: RoomModel, bytes: Uint8Array, ...exc: number[]): void => r.sendToPlayers(bytes, r.getAllPlayers(SlotState.BATTLE, 0, ...exc));

/** Cancels the running vote and tells the room (5199 for a kick vote, 9021 for a leader vote). */
export function cancelVote(r: RoomModel): void {
  const v = active.get(r);
  if (!v) return;
  clearVote(r);
  sendBattle(r, new PacketWriter(4).writeH(CANCEL_OP[v.kind]).toBytes());
}

// The creator or the target left the match (RemovePlayer / GIVEUP_BATTLE): the vote has no subject any more.
slotLeftHooks.push((r, slot) => {
  const v = active.get(r);
  if (v && (slot === v.creator || slot === v.victim) && r.state === RoomState.BATTLE) cancelVote(r);
});
// Match over: timers, cooldowns and the ping reports go with it.
battleEndHooks.push((r) => {
  clearVote(r);
  cooldowns.delete(r);
  r.pingReports.clear();
});
