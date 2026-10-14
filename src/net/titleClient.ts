// Titles (designations) on the Game connection: 2376 TITLE_CHANGE (get) -> 2377, 2378 TITLE_EQUIP -> 2379, 2380 TITLE_RELEASE
// -> 2381 (server profileHandlers.ts = C# PROTOCOL_BASE_USER_TITLE_*), plus the state pushes 2383 TITLE_INFO (flags, equipped
// slots, unlocked slots) and 2363 MEDAL_INFO (Broche / Insígnia / Medalha / Ordem Azul). The server pushes both once the lobby is
// entered [RECRIADO: the C# server sends 2383 only from GM commands]. Plain data, no DOM: the Node smoke / tests drive it.
import { PacketReader, PacketWriter } from "./packet.ts";
import { setTitleFxLive } from "../gameplay/titleFx.ts";
import { emptyTitleState, type TitleState } from "../lobby/core/titleLogic.ts";

export const TitleOp = {
  CHANGE_REQ: 2376, CHANGE_ACK: 2377, EQUIP_REQ: 2378, EQUIP_ACK: 2379, RELEASE_REQ: 2380, RELEASE_ACK: 2381, INFO_ACK: 2383, MEDAL_ACK: 2363,
} as const;
/** error the server answers a refused get with (profileHandlers.ts handleTitleChange) */
export const ERR_TITLE_REFUSED = 0x80001083;

export interface TitleInfo { flags: bigint; equiped: [number, number, number]; slots: number }
/** 2383: D playerId(low), Q flags, C equiped1..3, D slots */
export function parseTitleInfo(r: PacketReader): TitleInfo {
  r.readD();
  const flags = r.readQ();
  const equiped: [number, number, number] = [r.readC(), r.readC(), r.readC()];
  return { flags, equiped, slots: r.readD() };
}
export interface MedalInfo { ribbon: number; ensign: number; medal: number; master: number }
/** 2363: Q playerId, D ribbon, D ensign, D medal, D masterMedal */
export function parseMedalInfo(r: PacketReader): MedalInfo {
  r.readQ();
  return { ribbon: r.readD(), ensign: r.readD(), medal: r.readD(), master: r.readD() };
}

/** the part of PbConnection (connection.ts) the title client uses: keeps the server-side type check off the browser socket code */
export interface TitleConn {
  on(fn: (opcode: number, r: PacketReader) => void): () => void;
  waitFor(opcode: number, timeoutMs?: number): Promise<PacketReader>;
  send(opcode: number, body?: PacketWriter | Uint8Array): void;
}

export interface TitleResult { ok: boolean; err: number }

export class TitleClient {
  state: TitleState = emptyTitleState();
  private subs = new Set<() => void>();
  private off: () => void;
  private conn: TitleConn;

  constructor(conn: TitleConn) {
    this.conn = conn;
    this.off = conn.on((op, r) => {
      if (op === TitleOp.INFO_ACK) {
        const t = parseTitleInfo(r);
        this.state = { ...this.state, flags: t.flags, equiped: t.equiped, slots: Math.max(1, t.slots), known: true };
        this.emit();
      } else if (op === TitleOp.MEDAL_ACK) {
        const m = parseMedalInfo(r);
        this.state = { ...this.state, ...m };
        this.emit();
      }
    });
  }

  subscribe(fn: () => void): () => void { this.subs.add(fn); return () => this.subs.delete(fn); }
  private emit(): void { setTitleFxLive(this.state.equiped); for (const f of [...this.subs]) f(); }
  dispose(): void { this.off(); this.subs.clear(); }

  /** request + its ack (the waiter is armed before the send; a failed send does not leave a dangling timeout) */
  private ask(op: number, body: PacketWriter, ackOp: number): Promise<PacketReader> {
    const ack = this.conn.waitFor(ackOp);
    try { this.conn.send(op, body); } catch (e) { ack.catch(() => {}); throw e; }
    return ack;
  }

  /** 2376: get title `id` (server checks rank / badges / required titles, takes the badges, grants the awards) */
  async change(id: number): Promise<TitleResult> {
    const r = await this.ask(TitleOp.CHANGE_REQ, new PacketWriter(1).writeC(id), TitleOp.CHANGE_ACK);
    const err = r.readD(), slots = r.readD();
    if (err !== 0) return { ok: false, err };
    this.state = { ...this.state, flags: this.state.flags | (1n << BigInt(id)), slots: Math.max(1, slots) };
    this.emit();
    return { ok: true, err };
  }

  /** 2378: equip owned title `id` in slot `slot` (0..2) */
  async equip(slot: number, id: number): Promise<TitleResult> {
    const r = await this.ask(TitleOp.EQUIP_REQ, new PacketWriter(2).writeC(slot).writeC(id), TitleOp.EQUIP_ACK);
    const err = r.readD(), s = r.readC(), t = r.readC();
    if (err !== 0 || s > 2) return { ok: false, err };
    const equiped = [...this.state.equiped] as TitleState["equiped"];
    equiped[s] = t;
    this.state = { ...this.state, equiped };
    this.emit();
    return { ok: true, err };
  }

  /** 2380: release the title `id` equipped in `slot` */
  async release(slot: number, id: number): Promise<TitleResult> {
    const err = (await this.ask(TitleOp.RELEASE_REQ, new PacketWriter(2).writeC(slot).writeC(id), TitleOp.RELEASE_ACK)).readD();
    if (err !== 0) return { ok: false, err };
    const equiped = [...this.state.equiped] as TitleState["equiped"];
    equiped[slot] = 0;
    this.state = { ...this.state, equiped };
    this.emit();
    return { ok: true, err };
  }
}
