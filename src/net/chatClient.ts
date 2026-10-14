// Text chat on the Game connection: lobby/system lines 2571, room and
// battle lines 3606, whispers 1826 -> 1830 (+ 1827 failure), report 3852/3853 + 3850/3851. One singleton (`chat`)
// shared by the lobby and the battle HUD: whoever owns the GameClient calls `chat.attach(game.conn)`.
// Strings are only ever handed out as plain text: renderers must use textContent, never innerHTML.
import type { PbConnection } from "./connection.ts";
import { PacketReader, PacketWriter } from "./packet.ts";
import { friendList } from "./friendClient.ts";
import { noteList } from "./noteClient.ts";
import { parseClanChat } from "./clanClient.ts";

export type ChatKind = "all" | "team" | "clan" | "whisper" | "system";
export interface ChatLine {
  kind: ChatKind;
  nick: string;
  /** room / battle slot of the speaker (3606 lines only) */
  slot?: number;
  gm: boolean;
  /** nick colour index of 2571 lines (0 = default) */
  color: number;
  text: string;
  time: number;
  /** whisper I sent: the target's nick (nick = mine) */
  to?: string;
  /** local system line in its own colour (the {col:} of a client string, alpha 0..1), e.g. the room countdown notices */
  rgba?: [number, number, number, number];
}

export const ChatOp = {
  CHAT_REQ: 2384, LOBBY_CHAT_ACK: 2571, ROOM_CHAT_ACK: 3606,
  WHISPER_NICK_REQ: 1826, WHISPER_ID_REQ: 1828, WHISPER_ERR_ACK: 1827, WHISPER_ACK: 1830,
  REPORT_COND_REQ: 3852, REPORT_COND_ACK: 3853, REPORT_REQ: 3850, REPORT_ACK: 3851,
  CLAN_CHAT_REQ: 854, CLAN_CHAT_ACK: 855,
} as const;
/** chat REQ type: 1 lobby general, 6 room general, 4 team (server handleChat) */
export const ChatType = { ALL: 1, TEAM: 4, ROOM: 6 } as const;
export const CHAT_MAX = 60;
export const HISTORY_MAX = 100;
/** a system line with exactly this text opens the bug popup instead of being shown (server /bug) */
export const BUG_MARK = "\u0001BUG";
/** a Server line with exactly this text = this account is a GM (server chatGuard GM_MARK): the GM panel buttons appear */
export const GM_MARK = "\u0001GM";
export const ERR_REPORT_NO_TICKET = 0x80001e68;
export const ERR_REPORT_RANK = 0x80001e69;

const BLOCK_KEY = "pbweb.chat.blocked";
const norm = (s: string) => s.trim().toLowerCase();
/** control characters out (they break the log layout); the server does the same */
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

/** Splits a command line honouring: `/w "a b" hi` -> [,, "hi"]; the remainder stays one piece after `max`. */
export function splitArgs(line: string, max = Infinity): string[] {
  const out: string[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && line[i] === " ") i++;
    if (i >= n) break;
    if (out.length >= max - 1) { out.push(line.slice(i).trim()); break; }
    if (line[i] === '"') {
      const e = line.indexOf('"', i + 1);
      if (e < 0) { out.push(line.slice(i + 1)); break; }
      out.push(line.slice(i + 1, e));
      i = e + 1;
    } else {
      let e = i;
      while (e < n && line[e] !== " ") e++;
      out.push(line.slice(i, e));
      i = e;
    }
  }
  return out;
}

/** 2571: D session, C nickLen+1, U nick\0, C color, C gm, H len+1, U text\0 */
export function parseLobbyChat(r: PacketReader): { session: number; nick: string; color: number; gm: boolean; text: string } {
  const session = r.readD(), n = r.readC();
  const nick = r.readU(n * 2), color = r.readC(), gm = r.readC() !== 0, tl = r.readH();
  return { session, nick, color, gm, text: r.readU(tl * 2) };
}

/** 3606: H type, D slot, C gm, D len+1, U text\0 */
export function parseRoomChat(r: PacketReader): { type: number; slot: number; gm: boolean; text: string } {
  const type = r.readH(), slot = r.readD(), gm = r.readC() !== 0, tl = r.readD();
  return { type, slot, gm, text: r.readU(Math.min(tl, 400) * 2) };
}

/** 1830: U sender (66 bytes), C gm, C 0, H len+1, U text\0, C 0 */
export function parseWhisper(r: PacketReader): { nick: string; gm: boolean; text: string } {
  const nick = r.readU(66), gm = r.readC() !== 0;
  r.readC();
  const tl = r.readH();
  return { nick, gm, text: r.readU(tl * 2) };
}

export interface ReportCondition { canReport: boolean; err: number }

type LineCb = (line: ChatLine) => void;

export class ChatClient {
  private conn: PbConnection | null = null;
  private off: (() => void) | null = null;
  private hist: ChatLine[] = [];
  private lineCbs = new Set<LineCb>();
  private bugCbs = new Set<() => void>();
  private gmCbs = new Set<() => void>();
  /** the server said this account is a GM (kept for the session) */
  isGM = false;
  /** GM panel (F8 in the lobby) option: join rooms hidden, in an observer seat nobody else sees (READY is then always a GM observer) */
  gmStealth = false;
  private blocked: Set<string> | null = null;
  /** room / battle slot -> nick, for 3606 lines (set by whoever knows the slots: lobby room, battle HUD) */
  nickOfSlot: (slot: number) => string = () => "";
  /** room / battle slot -> nick colour index (NICK_COLORS), for the room chat lines: the nick takes the slot's colour */
  nickColorOfSlot: (slot: number) => number = () => 0;
  /** nick of the last whisper (received or sent): the Whisper tab / `/r` target */
  lastWhisper = "";
  /** the one account nick (own lines in whispers) */
  myNick = "";

  attach(conn: PbConnection): void {
    this.detach();
    this.conn = conn;
    friendList.attach(conn); // lista de amigos (1810 / 1815) chega no mesmo Game connection
    noteList.attach(conn); // recados novos (1931) chegam no Game connection; a lista inicial (1925) vem do login (metaAuth.ts)
    this.off = conn.on((op, r) => {
      try {
        if (op === ChatOp.LOBBY_CHAT_ACK) this.onLobby(r);
        else if (op === ChatOp.ROOM_CHAT_ACK) this.onRoom(r);
        else if (op === ChatOp.WHISPER_ACK) this.onWhisper(r);
        else if (op === ChatOp.WHISPER_ERR_ACK) this.onWhisperErr(r);
        else if (op === ChatOp.CLAN_CHAT_ACK) this.onClan(r);
      } catch (e) { console.warn(`[chat] parse ${op}`, e); }
    });
  }

  detach(): void {
    this.off?.();
    this.off = null;
    this.conn = null;
    friendList.detach();
    noteList.detach();
  }

  get connected(): boolean { return !!this.conn; }
  /** the attached connection (bugReport.ts sends 9001 through it) */
  get connection(): PbConnection | null { return this.conn; }

  /** bounded (100) history, oldest first */
  history(): ChatLine[] { return this.hist.slice(); }
  clear(): void { this.hist = []; }

  onLine(cb: LineCb): () => void { this.lineCbs.add(cb); return () => this.lineCbs.delete(cb); }
  /** fires once when the account turns out to be a GM (right away when it already is) */
  onGm(cb: () => void): () => void { this.gmCbs.add(cb); if (this.isGM) cb(); return () => this.gmCbs.delete(cb); }
  onBugPopup(cb: () => void): () => void { this.bugCbs.add(cb); return () => this.bugCbs.delete(cb); }

  /** Pushes a line into the history and to the listeners (also used for local feedback: kind). */
  push(line: Omit<ChatLine, "time"> & { time?: number }): void {
    const l: ChatLine = { ...line, time: line.time ?? Date.now() };
    if (l.kind !== "system" && !l.gm && l.nick !== this.myNick && this.isBlocked(l.nick)) return;
    this.hist.push(l);
    if (this.hist.length > HISTORY_MAX) this.hist.splice(0, this.hist.length - HISTORY_MAX);
    for (const cb of this.lineCbs) { try { cb(l); } catch (e) { console.warn("[chat] listener", e); } }
  }

  /** Local system feedback (blocked nick, whisper failed...), never sent. */
  system(text: string): void { this.push({ kind: "system", nick: "", gm: false, color: 0, text }); }

  // ---- send -------------------------------------------------------------------------------------------------------

  /** 2384 {H type, H len, U text}; false when not connected / empty. Text over 60 chars is cut. */
  send(type: number, text: string): boolean {
    const t = clean(text).slice(0, CHAT_MAX);
    if (!this.conn || !t) return false;
    try { this.conn.send(ChatOp.CHAT_REQ, new PacketWriter(16 + t.length * 2).writeH(type).writeH(t.length).writeU(t, t.length * 2)); } catch { return false; }
    return true;
  }

  /** 854 {H 5 (ChattingType.Clan), H len, U text}: clan chat to every online member of the clan, the match not counted (exe
   *  PROTOCOL_CS_CHATTING_REQ -> ClanManager.SendPacket; server socialHandlers handleClanChat). The sender gets its own line back as 855. */
  sendClan(text: string): boolean {
    const t = clean(text).slice(0, CHAT_MAX);
    if (!this.conn || !t) return false;
    try { this.conn.send(ChatOp.CLAN_CHAT_REQ, new PacketWriter(16 + t.length * 2).writeH(5).writeH(t.length).writeU(t, t.length * 2)); } catch { return false; }
    return true;
  }

  /** 1826 {U nick(66), H len, U text}: whisper by nick. The server does not echo it back, so the sender's own line is added here. */
  whisper(nick: string, text: string): boolean {
    const t = clean(text).slice(0, CHAT_MAX), to = clean(nick).slice(0, 32);
    if (!this.conn || !t || !to) return false;
    try { this.conn.send(ChatOp.WHISPER_NICK_REQ, new PacketWriter(96 + t.length * 2).writeU(to, 66).writeH(t.length).writeU(t, t.length * 2)); } catch { return false; }
    this.lastWhisper = to;
    this.push({ kind: "whisper", nick: this.myNick, gm: false, color: 0, text: t, to });
    return true;
  }

  // ---- report 3852 / 3850 -----------------------------------------------------------------------------------------

  /** 3852 -> 3853 {H 0, C canReport, D err} */
  async reportCondition(): Promise<ReportCondition> {
    if (!this.conn) return { canReport: false, err: 0x80000000 };
    const p = this.conn.waitFor(ChatOp.REPORT_COND_ACK, 5000);
    this.conn.send(ChatOp.REPORT_COND_REQ);
    const r = await p;
    r.readH();
    const canReport = r.readC() !== 0;
    return { canReport, err: r.remaining >= 4 ? r.readD() : 0 };
  }

  /** 3850 {C n, U detail(n), C type, C m, U nick(m)} -> 3851 {H 0, D err}; type 0 chat, 1 hack [INFERIDO]. Resolves the error code (0 = ok). */
  async report(nick: string, type: 0 | 1, detail: string): Promise<number> {
    if (!this.conn) return 0x80000000;
    const d = clean(detail).slice(0, 50), n = clean(nick).slice(0, 32);
    const w = new PacketWriter(160).writeC(d.length).writeU(d, d.length * 2).writeC(type).writeC(n.length).writeU(n, n.length * 2);
    const p = this.conn.waitFor(ChatOp.REPORT_ACK, 5000);
    this.conn.send(ChatOp.REPORT_REQ, w);
    const r = await p;
    r.readH();
    return r.remaining >= 4 ? r.readD() : 0;
  }

  // ---- receive ----------------------------------------------------------------------------------------------------

  private onLobby(r: PacketReader): void {
    const m = parseLobbyChat(r);
    const text = m.text;
    // session 0 / "Server" = the server speaking (command replies, notices)
    if (m.session === 0) {
      if (text === GM_MARK) { if (!this.isGM) { this.isGM = true; for (const cb of this.gmCbs) { try { cb(); } catch (e) { console.warn("[chat] gm", e); } } } return; }
      if (text === BUG_MARK) { for (const cb of this.bugCbs) { try { cb(); } catch (e) { console.warn("[chat] bug popup", e); } } return; }
      this.push({ kind: "system", nick: m.nick || "Server", gm: false, color: m.color, text });
      return;
    }
    this.push({ kind: "all", nick: m.nick, gm: m.gm, color: m.color, text });
  }

  private onRoom(r: PacketReader): void {
    const m = parseRoomChat(r);
    this.push({ kind: m.type === 4 ? "team" : "all", nick: this.nickOfSlot(m.slot) || `#${m.slot + 1}`, slot: m.slot, gm: m.gm, color: this.nickColorOfSlot(m.slot), text: m.text });
  }

  /** 855 {C len, U nick, C gm, C nick colour, C len, U text}: a clan chat line (clanClient.ts parseClanChat) */
  private onClan(r: PacketReader): void {
    const m = parseClanChat(r);
    this.push({ kind: "clan", nick: m.nick, gm: m.gm, color: m.nickColor, text: m.text });
  }

  private onWhisper(r: PacketReader): void {
    const m = parseWhisper(r);
    this.lastWhisper = m.nick;
    this.push({ kind: "whisper", nick: m.nick, gm: m.gm, color: 0, text: m.text });
  }

  /** 1827 {D err, C err&0xff, U nick(66)}: the target is offline / unknown */
  private onWhisperErr(r: PacketReader): void {
    const err = r.readD();
    r.readC();
    const nick = r.remaining >= 66 ? r.readU(66) : "";
    if (err !== 0) this.system(`${nick || "Jogador"}: jogador não encontrado ou offline.`);
  }

  // ---- block list (local filter, persisted) -------------------------------------------------------------------------

  private load(): Set<string> {
    if (this.blocked) return this.blocked;
    let a: string[] = [];
    try { const v = JSON.parse(globalThis.localStorage?.getItem(BLOCK_KEY) ?? "[]"); if (Array.isArray(v)) a = v.filter((x) => typeof x === "string"); } catch { /* no storage */ }
    return (this.blocked = new Set(a));
  }

  private save(): void {
    try { globalThis.localStorage?.setItem(BLOCK_KEY, JSON.stringify([...this.load()])); } catch { /* no storage */ }
  }

  isBlocked(nick: string): boolean { return !!nick && this.load().has(norm(nick)); }
  block(nick: string): void { const n = norm(nick); if (n) { this.load().add(n); this.save(); } }
  unblock(nick: string): void { if (this.load().delete(norm(nick))) this.save(); }
  blockedNicks(): string[] { return [...this.load()]; }
}

export const chat = new ChatClient();
