// In-battle votes on the Game connection: vote kick (original opcodes, the REQ
// numbers 5190 / 5194 are [INFERIDO] = ACK - 1) and the web-only leader vote 9010-9021. Only parses and sends: the state
// machine is game/voteState.ts. Report 3852 / 3850 lives in chatClient.ts.
import type { PbConnection } from "./connection.ts";
import { PacketReader, PacketWriter } from "./packet.ts";

export type VoteKind = "kick" | "leader";

export const VoteOp = {
  kick: { START_REQ: 5190, START_ACK: 5191, START: 5193, VOTE_REQ: 5194, VOTE_ACK: 5195, RESULT: 5197, CANCEL: 5199, CURRENT: 5201, KICKED: 5203 },
  leader: { START_REQ: 9010, START_ACK: 9011, START: 9013, VOTE_REQ: 9014, VOTE_ACK: 9015, RESULT: 9019, CANCEL: 9021, CURRENT: 9017, KICKED: 0 },
} as const;

/** err codes of the original ACKs (PROTOCOL_BATTLE_*_KICKVOTE_ACK) */
export const VoteErr = {
  ALREADY_RUNNING: 0x80001200, COOLDOWN: 0x80001201, RANK: 0x80001205, ALREADY_VOTED: 0x80001211,
  /** web server rules (server voteKick.ts / voteLeader.ts) [RECRIADO]: too few human players, protected target, bad / high-ping leader target */
  FEW_PLAYERS: 0x80001206, PROTECTED: 0x80001207, LEADER_REJECTED: 0x80002100, BAD_TARGET: 0x80002101, HIGH_PING: 0x80002102,
  /** result codes of 5197 / 9019: 2147488000 rejected, ...001 no ally voted, ...002 no enemy voted */
  REJECTED: 2147488000, NO_ALLY: 2147488001, NO_ENEMY: 2147488002,
} as const;

/** kick reason byte (VoteKickEnum): 0 NoManner (chat), 1 IllegalProgram (hack) [INFERIDO: the scene only has Hack / Chat] */
export const KickReason = { CHAT: 0, HACK: 1, ABUSE: 2, ETC: 3 } as const;

export type VoteEvent =
  | { t: "start"; kind: VoteKind; creator: number; target: number; reason: number }
  | { t: "current"; kind: VoteKind; accept: number; deny: number }
  | { t: "result"; kind: VoteKind; target: number; accept: number; deny: number; err: number }
  | { t: "cancel"; kind: VoteKind }
  | { t: "startAck"; kind: VoteKind; err: number }
  | { t: "voteAck"; kind: VoteKind; err: number }
  | { t: "kicked" };

/** Parses one packet into a VoteEvent, or null when `op` is not a vote opcode. Pure (smoke tests feed it). */
export function parseVote(op: number, r: PacketReader): VoteEvent | null {
  for (const kind of ["kick", "leader"] as const) {
    const o = VoteOp[kind];
    if (op === o.START_ACK) return { t: "startAck", kind, err: r.remaining >= 4 ? r.readD() : 0 };
    if (op === o.VOTE_ACK) return { t: "voteAck", kind, err: r.remaining >= 4 ? r.readD() : 0 };
    if (op === o.START) return { t: "start", kind, creator: r.readC(), target: r.readC(), reason: kind === "kick" ? r.readC() : 0 };
    if (op === o.CURRENT) return { t: "current", kind, accept: r.readC(), deny: r.readC() };
    if (op === o.RESULT) return { t: "result", kind, target: r.readC(), accept: r.readC(), deny: r.readC(), err: r.remaining >= 4 ? r.readD() : 0 };
    if (op === o.CANCEL) return { t: "cancel", kind };
    if (o.KICKED && op === o.KICKED) return { t: "kicked" };
  }
  return null;
}

export class VoteClient {
  private off: () => void;
  private cbs = new Set<(e: VoteEvent) => void>();

  constructor(private conn: PbConnection) {
    this.off = conn.on((op, r) => {
      let e: VoteEvent | null = null;
      try { e = parseVote(op, r); } catch (err) { console.warn(`[vote] parse ${op}`, err); }
      if (!e) return;
      for (const cb of this.cbs) { try { cb(e); } catch (err) { console.warn("[vote] listener", err); } }
    });
  }

  onEvent(cb: (e: VoteEvent) => void): () => void { this.cbs.add(cb); return () => this.cbs.delete(cb); }

  /** 5190 {C target slot, C reason} */
  startKick(target: number, reason: number): void { this.conn.send(VoteOp.kick.START_REQ, new PacketWriter(4).writeC(target).writeC(reason)); }
  /** 5194 {C vote: 0 yes, 1 no} */
  voteKick(yes: boolean): void { this.conn.send(VoteOp.kick.VOTE_REQ, new PacketWriter(4).writeC(yes ? 0 : 1)); }
  /** 9010 {C target slot (255 = best ping)} */
  startLeader(target = 255): void { this.conn.send(VoteOp.leader.START_REQ, new PacketWriter(4).writeC(target)); }
  /** 9014 {C vote: 0 yes, 1 no} */
  voteLeader(yes: boolean): void { this.conn.send(VoteOp.leader.VOTE_REQ, new PacketWriter(4).writeC(yes ? 0 : 1)); }

  dispose(): void { this.off(); this.cbs.clear(); }
}
