// Mission cards (Quest) on the Game connection, server socialHandlers.ts / progress.ts (= the C# PROTOCOL_BASE_QUEST_*):
//   2355 QUEST_GET_INFO_ACK   C active + the 89-byte questing block (server pushes it after creating the nick; the same block
//                             rides in the Auth 2317 GET_USER_INFO_ACK, seeded through `seed`)
//   2359 QUEST_CHANGE_ACK     C task (+240 once complete), C progress of the active card's task
//   2360 ACTIVE_IDX_CHANGE    C slot, C card, H the card's complete flags (0xffff = done) -> no ack
//   2361 ACTIVE_IDX_CHANGE_ACK D flag, C type (+ exp, 0, gold, ribbon, ensign, medal, master when flag & 1): card (1, 1) / set (273, 4) done
//   2364 BUY_CARD_SET -> 2365  D err (+ D gold, C active, 89 B, D cash)
//   2366 DELETE_CARD_SET -> 2367 D err (+ 89 B)
// Questing block (auth/metaPackets.ts questingInfo): C active, 4 x C current card, 4 x 10 x H card flags (nibble per task, 0xF = done),
// 4 x C card set id. Plain data, no DOM: the Node smoke drives it.
import { PacketReader, PacketWriter } from "./packet.ts";
import type { TitleConn } from "./titleClient.ts";

export const MissionOp = {
  INFO_ACK: 2355, CHANGE_ACK: 2359, ACTIVE_REQ: 2360, ACTIVE_ACK: 2361, BUY_REQ: 2364, BUY_ACK: 2365, DELETE_REQ: 2366, DELETE_ACK: 2367,
} as const;
/** server handleBuyCardSet / handleDeleteCardSet codes (C# PROTOCOL_BASE_QUEST_*_CARD_SET_ACK; the exe's messages: UITabProfileMissionCard 0x955760) */
export const MissionErr = {
  NO_CARD_INFO: 0x8000104c, NO_POINT: 0x8000104d, LIMIT: 0x8000104e, NOT_TUTORIAL: 0x800010d5, DELETE_NO_INFO: 0x8000104f, DELETE_NETWORK: 0x80001050,
} as const;

export const MISSION_SLOTS = 4;
export const CARDS_PER_SET = 10;
export const TASKS_PER_CARD = 4;
export const QUESTING_SIZE = 89;

export interface MissionSlotState {
  /** CardSetId, 0 = empty slot */
  setId: number;
  /** current card (0..9) */
  card: number;
  /** 10 u16 complete flags, one per card: nibble `task` = 0xF once the task is done */
  flags: number[];
}
export interface MissionState {
  /** active slot (actualMission) */
  active: number;
  slots: MissionSlotState[];
  /** live task counts from 2359 (slot -> card * 4 + task -> count); the server keeps no counts on the wire otherwise */
  counts: Map<number, number>[];
  /** false until a questing block arrived */
  known: boolean;
}
export const emptyMissionState = (): MissionState => ({
  active: 0, known: false,
  slots: Array.from({ length: MISSION_SLOTS }, () => ({ setId: 0, card: 0, flags: new Array(CARDS_PER_SET).fill(0) })),
  counts: Array.from({ length: MISSION_SLOTS }, () => new Map<number, number>()),
});

/** the 89-byte questing block -> state (counts of the slots whose set did not change are kept) */
export function parseQuesting(r: PacketReader, prev: MissionState = emptyMissionState()): MissionState {
  const active = r.readC();
  const cards = Array.from({ length: MISSION_SLOTS }, () => r.readC());
  const flags = Array.from({ length: MISSION_SLOTS }, () => Array.from({ length: CARDS_PER_SET }, () => r.readH()));
  const sets = Array.from({ length: MISSION_SLOTS }, () => r.readC());
  const slots = sets.map((setId, i) => ({ setId, card: cards[i], flags: flags[i] }));
  const counts = slots.map((s, i) => (s.setId && s.setId === prev.slots[i]?.setId ? new Map(prev.counts[i]) : new Map<number, number>()));
  return { active: active < MISSION_SLOTS ? active : 0, slots, counts, known: true };
}
export const questingFrom = (block: Uint8Array, prev?: MissionState): MissionState => parseQuesting(new PacketReader(block), prev);

export const taskDone = (s: MissionSlotState, card: number, task: number): boolean => ((s.flags[card] ?? 0) >> (task * 4) & 0xf) === 0xf;
export const cardDone = (s: MissionSlotState, card: number): boolean => (s.flags[card] ?? 0) === 0xffff;

/** 2361 prize (flag & 1): the account's new totals */
export interface MissionPrize {
  flag: number; type: number; exp: number; gold: number; ribbon: number; ensign: number; medal: number; master: number;
  /** set / card of the active slot when the 2361 arrived (the finished one) */
  setId: number; card: number;
}
export function parsePrize(r: PacketReader): MissionPrize {
  const flag = r.readD(), type = r.readC();
  const p: MissionPrize = { flag, type, exp: 0, gold: 0, ribbon: 0, ensign: 0, medal: 0, master: 0, setId: 0, card: 0 };
  if ((flag & 1) === 1) {
    p.exp = r.readD(); r.readD(); p.gold = r.readD();
    p.ribbon = r.readD(); p.ensign = r.readD(); p.medal = r.readD(); p.master = r.readD();
  }
  return p;
}

export interface MissionResult { ok: boolean; err: number; gold?: number; cash?: number }

export class MissionClient {
  state: MissionState = emptyMissionState();
  /** last 2361 (card / set finished), for the Complete popup; the controller clears it */
  prize: MissionPrize | null = null;
  private subs = new Set<() => void>();
  private off: () => void;
  private conn: TitleConn;

  constructor(conn: TitleConn) {
    this.conn = conn;
    this.off = conn.on((op, r) => {
      if (op === MissionOp.INFO_ACK) {
        r.readC();
        this.state = parseQuesting(r, this.state);
        this.emit();
      } else if (op === MissionOp.CHANGE_ACK) {
        this.onChange(r.readC(), r.readC());
      } else if (op === MissionOp.ACTIVE_ACK) {
        this.onPrize(parsePrize(r));
      }
    });
  }

  subscribe(fn: () => void): () => void { this.subs.add(fn); return () => this.subs.delete(fn); }
  private emit(): void { for (const f of [...this.subs]) f(); }
  dispose(): void { this.off(); this.subs.clear(); }

  /** the questing block of the Auth 2317 (before the Game session had any 2355) */
  seed(block: Uint8Array | null | undefined): void {
    if (!block || block.length < QUESTING_SIZE || this.state.known) return;
    this.state = questingFrom(block);
    this.emit();
  }

  private slotCopy(i: number): MissionSlotState { const s = this.state.slots[i]; return { ...s, flags: [...s.flags] }; }

  /** 2359: one task of the active card moved; `b` = task (0..3) + 240 once it is complete */
  private onChange(b: number, count: number): void {
    const st = this.state, i = st.active, s = this.slotCopy(i), task = b & 0x0f;
    if (!s.setId || task >= TASKS_PER_CARD) return;
    const counts = st.counts.map((m) => new Map(m));
    counts[i].set(s.card * TASKS_PER_CARD + task, count);
    if (b >= 240) s.flags[s.card] = (s.flags[s.card] | (0xf << (task * 4))) & 0xffff;
    const slots = [...st.slots];
    slots[i] = s;
    this.state = { ...st, slots, counts };
    this.emit();
  }

  /** 2361: (1, 1) the active card is done; (273, 4) the whole set is done: the server empties the slot (actualMission = first owned) */
  private onPrize(p: MissionPrize): void {
    const st = this.state;
    p.setId = st.slots[st.active]?.setId ?? 0;
    p.card = st.slots[st.active]?.card ?? 0;
    if (p.type === 4) {
      const slots = [...st.slots], counts = [...st.counts];
      slots[st.active] = { setId: 0, card: 0, flags: new Array(CARDS_PER_SET).fill(0) };
      counts[st.active] = new Map();
      const first = slots.findIndex((s) => s.setId);
      this.state = { ...st, slots, counts, active: first < 0 ? 0 : first };
    }
    this.prize = p;
    this.emit();
  }

  /** request + its ack (the waiter is armed before the send) */
  private ask(op: number, body: PacketWriter, ackOp: number): Promise<PacketReader> {
    const ack = this.conn.waitFor(ackOp);
    try { this.conn.send(op, body); } catch (e) { ack.catch(() => {}); throw e; }
    return ack;
  }

  /** 2360 (no ack): slot `slot` becomes the active one with card `card` (CQuestManager 0x58c490: flag = the card's complete flags) */
  setActive(slot: number, card: number): void {
    const st = this.state, s = st.slots[slot];
    if (!s?.setId) return;
    this.conn.send(MissionOp.ACTIVE_REQ, new PacketWriter(4).writeC(slot).writeC(card).writeH(s.flags[card] ?? 0));
    const slots = [...st.slots];
    slots[slot] = { ...s, card };
    this.state = { ...st, slots, active: slot };
    this.emit();
  }

  /** 2364: buy card set `setId`; the ack carries the new questing block and wallet */
  async buy(setId: number): Promise<MissionResult> {
    const r = await this.ask(MissionOp.BUY_REQ, new PacketWriter(2).writeC(setId).writeC(0), MissionOp.BUY_ACK);
    const err = r.readD();
    if (err !== 0) return { ok: false, err };
    const gold = r.readD();
    r.readC();
    this.state = parseQuesting(r, this.state);
    const cash = r.readD();
    this.emit();
    return { ok: true, err, gold, cash };
  }

  /** 2366: delete the card set in `slot` */
  async remove(slot: number): Promise<MissionResult> {
    const r = await this.ask(MissionOp.DELETE_REQ, new PacketWriter(1).writeC(slot), MissionOp.DELETE_ACK);
    const err = r.readD();
    if (err !== 0) return { ok: false, err };
    this.state = parseQuesting(r, this.state);
    this.emit();
    return { ok: true, err };
  }
}
