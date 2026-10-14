// Offline fixtures for the chat / vote tests: a real RoomModel with fake accounts that record every packet they are sent.
import type { Account } from "../src/shared/account.ts";
import { RoomModel, RoomState, SlotState } from "../src/game/roomModel.ts";
import type { ChannelModel } from "../src/game/channel.ts";
import { clock } from "../src/game/voteCommon.ts";

export interface Sent { to: bigint; op: number; bytes: Uint8Array }
export interface Fixture { room: RoomModel; accounts: Account[]; sent: Sent[]; ops(op: number, to?: bigint): Sent[]; clear(): void }

export const opOf = (b: Uint8Array) => b[0] | (b[1] << 8);
export const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** Text of a 2571 lobby chat line ("Server" replies): D session, C nickLen, U nick\0, C color, C gm, H len, U text\0. */
export function chatText(b: Uint8Array): string {
  let o = 2 + 4;
  const nickLen = b[o++];
  o += nickLen * 2 + 2 - 2; // nickLen counts the NUL: nickLen UTF-16 units including it
  o += 2; // color + gm
  const len = b[o] | (b[o + 1] << 8);
  o += 2;
  let s = "";
  for (let i = 0; i < len - 1; i++) s += String.fromCharCode(b[o + i * 2] | (b[o + i * 2 + 1] << 8));
  return s;
}

export function fakeAccount(pid: number, nick: string, sent: Sent[], opts: Partial<{ rank: number; gm: boolean }> = {}): Account {
  const a = {
    playerId: BigInt(pid), nickname: nick, rank: opts.rank ?? 10, slotId: -1, room: null, isOnline: true, antiKickGM: false,
    report: { ticketCount: 3, reportedCount: 0 }, hideGMcolor: false, nickColor: 0, last: {} as Record<string, number>,
    session: { sessionId: pid, playerId: BigInt(pid) }, status: { roomId: 0 }, friends: [],
    isGM: () => !!opts.gm,
    useChatGM: () => !!opts.gm,
    durationSince: () => 99,
    connection: { session: { send: (b: Uint8Array) => { sent.push({ to: BigInt(pid), op: opOf(b), bytes: b }); } }, player: null as unknown },
  };
  a.connection.player = a;
  return a as unknown as Account;
}

/** n humans in BATTLE (slot i, team i % 2, player id 100 + i, nick P<i>). */
export function battleRoom(n: number, opts: { rank?: number } = {}): Fixture {
  const sent: Sent[] = [];
  const accounts: Account[] = [];
  const svc = {
    getAccount: (pid: bigint) => accounts.find((a) => a.playerId === pid) ?? null,
    send: (a: Account, b: Uint8Array) => { sent.push({ to: a.playerId, op: opOf(b), bytes: b }); },
    updateStatus: async () => {},
  };
  const ch = { id: 0, type: 0, serverId: 1, lobbyPlayers: [] as Account[], rooms: [] } as unknown as ChannelModel;
  const room = new RoomModel(3, ch, svc);
  room.state = RoomState.BATTLE;
  room.mapId = 4; room.rule = 0; room.stage = 1; room.roomType = 4;
  room.generateSeed();
  for (let i = 0; i < n; i++) {
    const a = fakeAccount(100 + i, `P${i}`, sent, { rank: opts.rank });
    a.slotId = i; a.room = room;
    accounts.push(a);
    const s = room.slots[i];
    s.playerId = a.playerId; s.state = SlotState.BATTLE;
  }
  room.leader = 0;
  return { room, accounts, sent, ops: (op, to) => sent.filter((x) => x.op === op && (to === undefined || x.to === to)), clear: () => { sent.length = 0; } };
}

/** Manual clock + timers for clock (voteCommon). */
export function manualClock() {
  let now = 1_000_000;
  const timers: { at: number; fn: () => void; id: number; live: boolean }[] = [];
  let seq = 0;
  clock.now = () => now;
  clock.setTimer = (fn, ms) => { const t = { at: now + ms, fn, id: ++seq, live: true }; timers.push(t); return t as unknown as ReturnType<typeof setTimeout>; };
  clock.clearTimer = (h) => { (h as unknown as { live: boolean }).live = false; };
  return {
    advance(ms: number) {
      now += ms;
      for (const t of timers.filter((x) => x.live && x.at <= now).sort((a, b) => a.at - b.at)) { t.live = false; t.fn(); }
    },
    pending: () => timers.filter((t) => t.live).length,
  };
}
