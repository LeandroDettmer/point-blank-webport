// Recados (notas / correio) do Cross: lista da aba Msg. da janela Comunidade (lobby/screensCross/pages/notes.ts).
// Servidor: server socialHandlers.ts (handleNoteSend 1921 / 1930 -> 1922, handleNoteRead 1926 -> 1927,
// handleNoteDelete 1928 -> 1929, noteListAck 1925 pelo 2320 GET_OPTION no login, noteReceiveAck 1931 no recebimento).
// Porta do C# (PROTOCOL_MESSENGER_NOTE_*, NoteMessageType.cs). Exe: CPopupCommunity::OnEvent 0x81324f,
// _FindNoteByUid 0x815467, SetSelectedNote 0x814674; botões cmNote* em tools/data/cross-ui-map.json.
// Pedidos: 1921 {C nick len, C text len, U nick, U text} (nick por nick), 1930 {Q uid, C text len, U text} (resposta),
// 1926 {C n, D id x n} -> 1927 {C n, D id x n}, 1928 {C n, D id x n} -> 1929 {D err, C n, D id x n}.
// Erros de envio (1922 {D err}): 0x8000107e destinatário inexistente, 0x8000107f caixa cheia (100), 0x80000000 falha.
import type { PbConnection } from "./connection.ts";
import { ClanClient } from "./clanClient.ts";
import { PacketReader, PacketWriter } from "./packet.ts";

export const NoteOp = {
  SEND_REQ: 1921, SEND_ACK: 1922, LIST_ACK: 1925, READ_REQ: 1926, READ_ACK: 1927, DELETE_REQ: 1928, DELETE_ACK: 1929, REPLY_REQ: 1930, RECEIVE_ACK: 1931,
} as const;
export const NoteErr = { NOT_FOUND: 0x8000107e, FULL: 0x8000107f, FAIL: 0x80000000 } as const;
/** NoteMessageType. 1931 writes ClanAsk as 6, 1925 writes it as 5 (old PROTOCOL_MESSENGER_NOTE_RECEIVE_ACK.cs:30). */
export const NoteType = { NORMAL: 0, NORMAL_ASK: 1, GIFT: 2, WEB: 3, CLAN: 4, CLAN_ASK: 5, CLAN_ASK_WIRE: 6 } as const;
/** state of a note: the server stores 1 when it arrives and 0 after a read (1926) */
export const NoteState = { READ: 0, UNREAD: 1 } as const;
/** days left after a read: the server's 1926 sets expire_date = now + 7 days (socialHandlers.ts handleNoteRead); the exe's
 * read (0x91e860 / 0x91ea10) writes the same 7 into the note's days byte (+0xe) */
export const READ_DAYS = 7;
/** notes the exe opens with 1926 when the player picks them (0x91e860: a jump table on the type, the cases 0, 1, 3 and 4
 * read; 2 gift and 5 / 6 clan invite do not). An invite is marked read only by its answer (answerClanNote). */
export const readsOnPick = (type: number): boolean => type === NoteType.NORMAL || type === NoteType.NORMAL_ASK || type === NoteType.WEB || type === NoteType.CLAN;
/** no answer to a request (accept/delete timeout), same convention as friendClient.ts */
const NO_ANSWER = 0x80000000;

export interface Note {
  id: number; senderId: bigint; type: number; state: number; days: number; clanId: number;
  /** sender nick, or the clan name for clan notes */
  sender: string; text: string;
  /** NoteMessageClan of a clan note (0 none, 1 invite, 4..6 join / secession, 7..10 staff / master); 0 for other notes */
  clanNote: number;
}

export const isClanAsk = (type: number): boolean => type === NoteType.CLAN_ASK || type === NoteType.CLAN_ASK_WIRE;

/** goodId of a gift note: the low dword of the header's senderId (exe _NoteReceive `_ui32GoodsID`, UIPopupReceiveMail::ReceivePresent 0x91e900) */
export const giftGoodsId = (n: Note): number => Number(BigInt.asUintN(32, n.senderId));

/** wstrz: UTF-16 chars up to a NUL char (socialHandlers.ts wstrz) */
function readWstrz(r: PacketReader): string {
  let s = "";
  for (;;) { const c = r.readH(); if (c === 0) return s; s += String.fromCharCode(c); }
}

/**
 * Body of one note (socialHandlers.ts noteBody): C name len+1, C text len+1 (0 for ask and clan-with-clanNote), name, then
 * the text. Clan notes with clanNote 4..6 and the ones with other clanNote carry the clanNote in the body.
 * [INFERIDO] Branch rule: the body with textLen 0 starts H textLen+1, H clanNote (4..6) and text, C 0 (join / secession), or
 * H 3, D clanNote, H 0 (other clanNote). The second H tells them apart: 4..6 = first branch. Not checked against the exe.
 */
function readBody(r: PacketReader, type: number): { sender: string; text: string; clanNote: number } {
  const nameLen = r.readC(), textLen = r.readC();
  const sender = r.readU(nameLen * 2);
  if (type !== NoteType.CLAN && !isClanAsk(type)) return { sender, text: readWstrz(r), clanNote: 0 };
  if (textLen > 0) return { sender, text: readWstrz(r), clanNote: 0 };
  const h = r.readH(), second = r.readH();
  if (second >= 4 && second <= 6) { const text = r.readU((h - 1) * 2); r.readC(); return { sender, text, clanNote: second }; }
  r.skip(4); // high half of D clanNote + the trailing H 0
  return { sender, text: "", clanNote: second };
}

/** the header of a note in 1925 (D id, Q sender, C type, C state, C days, D clan id) */
function readHeader(r: PacketReader): Omit<Note, "sender" | "text" | "clanNote"> {
  const id = r.readD(), senderId = r.readQ(), type = r.readC(), state = r.readC(), days = r.readC(), clanId = r.readD();
  return { id, senderId, type, state, days, clanId };
}

/** 1925 NOTE_LIST: C 0, C n, n headers, then the n bodies in the same order (socialHandlers.ts noteListAck) */
export function readNoteList(r: PacketReader): Note[] {
  r.readC();
  const n = r.readC();
  const heads = Array.from({ length: n }, () => readHeader(r));
  return heads.map((h) => ({ ...h, ...readBody(r, h.type) }));
}

/** 1931 NOTE_RECEIVE_ACK: one new note (header + body) */
export function readNoteReceive(r: PacketReader): Note {
  const h = readHeader(r);
  return { ...h, ...readBody(r, h.type) };
}

/** 1921 by nick (1930 by uid for a reply). Answer 1922 {D err}; 0x80000000 when it does not come. */
export async function sendNote(conn: PbConnection, nick: string, text: string): Promise<number> {
  const ack = conn.waitFor(NoteOp.SEND_ACK, 5000).then((r) => r.readD(), () => NO_ANSWER);
  const w = new PacketWriter(2 + (nick.length + text.length) * 2).writeC(nick.length).writeC(text.length).writeU(nick, nick.length * 2).writeU(text, text.length * 2);
  conn.send(NoteOp.SEND_REQ, w);
  return ack;
}

export async function replyNote(conn: PbConnection, senderId: bigint, text: string): Promise<number> {
  const ack = conn.waitFor(NoteOp.SEND_ACK, 5000).then((r) => r.readD(), () => NO_ANSWER);
  conn.send(NoteOp.REPLY_REQ, new PacketWriter(11 + text.length * 2).writeQ(senderId).writeC(text.length).writeU(text, text.length * 2));
  return ack;
}

/**
 * Clan invite answer (exe 0x887340 Accept / Reject, 0x91ea10): 890 through ClanClient, then 1926 marks the invite read. The
 * exe does not check the 890 result before the read and does not delete the note: the answered invite stays in the list
 * (read, 7 days) until the player deletes it. The caller marks the list the same way.
 */
export async function answerClanNote(conn: PbConnection, n: Note, accept: boolean): Promise<{ ok: boolean; err: number }> {
  const r = await new ClanClient(conn).inviteAccept(n.clanId, accept);
  readNotes(conn, [n.id]);
  return { ok: r.ok, err: r.err };
}

/** the list as the exe shows it: newest first (cmNoteList row 0 = the last index, CPopupCommunity refresh 0x887690) */
export const newestFirst = (list: Note[]): Note[] => [...list].reverse();

/** 1926: marks the notes read on the server (no answer is awaited; 1927 only confirms it) */
export function readNotes(conn: PbConnection, ids: number[]): void {
  const w = new PacketWriter(1 + ids.length * 4).writeC(ids.length);
  for (const id of ids) w.writeD(id);
  conn.send(NoteOp.READ_REQ, w);
}

/** 1928 -> 1929 {D err, C n, D id x n}: 0 on success, the server's error (or NO_ANSWER) otherwise */
export async function deleteNotes(conn: PbConnection, ids: number[]): Promise<number> {
  const ack = conn.waitFor(NoteOp.DELETE_ACK, 5000).then((r) => r.readD(), () => NO_ANSWER);
  const w = new PacketWriter(1 + ids.length * 4).writeC(ids.length);
  for (const id of ids) w.writeD(id);
  conn.send(NoteOp.DELETE_REQ, w);
  return ack;
}

/**
 * The account's notes. The list comes once per login on the Auth connection (2320 GET_OPTION -> 1925, see metaAuth.ts
 * fetchAuthMeta -> set); new notes (1931) and the clan invite arrive on the Game connection (attach), like friendClient.ts.
 */
export class NoteList {
  list: Note[] = [];
  private off: (() => void) | null = null;
  private subs = new Set<() => void>();

  set(list: Note[]): void {
    this.list = list;
    this.emit();
  }

  attach(conn: PbConnection): void {
    this.detach();
    this.off = conn.on((op, r) => {
      if (op !== NoteOp.RECEIVE_ACK) return;
      const n = readNoteReceive(new PacketReader(r.data.slice(r.pos)));
      this.list = [...this.list.filter((x) => x.id !== n.id), n];
      this.emit();
    });
  }

  detach(): void {
    this.off?.();
    this.off = null;
  }

  /** the list changed: local marks after a read / delete (the server already has them); `days` after a read */
  mark(ids: number[], state: number, days?: number): void {
    this.list = this.list.map((n) => (ids.includes(n.id) ? { ...n, state, days: days ?? n.days } : n));
    this.emit();
  }

  remove(ids: number[]): void {
    this.list = this.list.filter((n) => !ids.includes(n.id));
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private emit(): void { for (const fn of this.subs) fn(); }
}

export const noteList = new NoteList();
