// Amizade no Cross. Pedido pelo nick (menu de contexto e UserInfoPopup, 1811) e lista de amigos da janela Comunidade
// (lobby/screensCross/pages/community.ts). Servidor: server socialHandlers.ts (handleFriendInvite / Accept / Delete).
// Pedido: 1811 {U nick(66)} -> sucesso 1815 (insert), falha 1812 {D err}. Erros: 0x80001037 (eu mesmo ou pedido rápido demais),
// 0x80001038 (lista cheia), 0x80001041 (já é amigo), 0x80001042 (nick inexistente / offline), 0x80001039 (falha no banco).
// Porta do C# (PROTOCOL_AUTH_FRIEND_INVITE_REQ).
// Lista: 1810 {C n, n x entrada} (entrada = C len + U len*2 (nick com NUL) + Q pid + D status + D flag + C rank + 13 bytes;
// len 0 = slot vazio, 31 bytes). Mudança: 1815 {C cs, C idx, bloco} com bloco = entrada com 6 bytes finais (len 0 nos cs
// 2 e 3, 24 bytes). cs: 1 Insert, 2 Accept, 3 Delete, 4 Update. Aceitar 1816 {C idx} -> 1815 cs 2 + cs 4 ou 1817 {D err};
// excluir / recusar 1820 {C idx} -> 1821 {D err}. O índice é a posição na lista do próprio jogador: a lista do cliente
// guarda os slots vazios para não deslocar os índices.
// Status (ComDiv.GetPlayerLocation, server locationStatus): topo 4 bits = estado (1 pedido enviado, 2 pedido recebido,
// 3 offline, 4 online, 5 lobby, 8 sala); bits 12..19 = canal, 0..11 = sala. [INFERIDO] canal e sala contados a partir de 1
// como o servidor escreve (sem prova no exe).
import type { PbConnection } from "./connection.ts";
import { PacketReader, PacketWriter } from "./packet.ts";

export const FriendOp = {
  INVITE_REQ: 1811, INVITE_ERR_ACK: 1812, LIST_ACK: 1810, INFO_CHANGE_ACK: 1815,
  ACCEPT_REQ: 1816, ACCEPT_ERR_ACK: 1817, DELETE_REQ: 1820, DELETE_ACK: 1821,
  FIND_USER_REQ: 2426, USER_DETAIL_ACK: 2438,
  /** Buscar, nick que não é amigo nem está na lista da lobby (exe 0x59223f, event 0x64): SetProtocol(0x129) + WriteData(nick, 33) */
  FIND_LOBBY_REQ: 297,
} as const;
export const FriendErr = { SELF: 0x80001037, FULL: 0x80001038, ALREADY: 0x80001041, NOT_FOUND: 0x80001042, FAIL: 0x80001039 } as const;
/** FriendChangeState of 1815 */
export const FriendChange = { INSERT: 1, ACCEPT: 2, DELETE: 3, UPDATE: 4 } as const;
/** status top nibble (FriendState) */
export const FriendState = { SENT: 1, RECEIVED: 2, OFFLINE: 3, ONLINE: 4, LOBBY: 5, ROOM: 8 } as const;
/** Cross exe enum (PointBlank.exe Cross): the card switch 0x88cc80 (idx = nibble-1, table 0x88e368) and the state text
 * 0x881bc0 (table 0x881d34). Sala = 6 (not 8: nibble 7/8 hit the default, no text, no Visitar). The wire keeps 8. */
export const CrossState = { SENT: 1, RECEIVED: 2, OFFLINE: 3, ONLINE: 4, LOBBY: 5, ROOM: 6 } as const;
/** status top nibble as the Cross exe reads it: the server's room (wire 8) is the Cross room (6) */
export function crossState(status: number): number {
  const top = status >>> 28;
  return top === FriendState.ROOM ? CrossState.ROOM : top;
}

/** local do amigo no status (servidor bits 20..27, canal 12..19, sala 0..11): Visitar (exe 0x884d70) entra nele */
export function friendLocation(status: number): { server: number; channel: number; room: number } {
  return { server: (status >>> 20) & 0xff, channel: (status >>> 12) & 0xff, room: status & 0xfff };
}

export interface Friend { nick: string; playerId: bigint; status: number; rank: number }
/** a slot of the list; null = the server sent no info for it (kept so the indexes match the server's list) */
export type FriendEntry = Friend | null;

/** Requests that the server answers with a fixed-size error block (accept 1817, delete 1821). Timeout = 0x80000000. */
const NO_ANSWER = 0x80000000;

/** one entry; `tail` = bytes after the rank (13 in 1810, 6 in 1815) */
function readEntry(r: PacketReader, tail: number): FriendEntry {
  const len = r.readC();
  if (len === 0) { r.skip(tail + 17); return null; }
  let nick = "";
  for (let i = 0; i < len; i++) nick += String.fromCharCode(r.readH());
  const playerId = r.readQ(), status = r.readD();
  r.readD(); // 0 / 0xffffffff: auth-only flag
  const rank = r.readC();
  r.skip(tail);
  return { nick: nick.replace(/\0+$/, ""), playerId, status: status >>> 0, rank };
}

/** 1810: the whole list, in the server's order */
export function readFriendList(r: PacketReader): FriendEntry[] {
  const n = r.readC();
  const out: FriendEntry[] = [];
  for (let i = 0; i < n; i++) out.push(readEntry(r, 13));
  return out;
}

export interface FriendChangeMsg { cs: number; idx: number; entry: FriendEntry }
/** 1815: one change of the list (`entry` is null on Accept / Delete) */
export function readFriendChange(r: PacketReader): FriendChangeMsg {
  const cs = r.readC(), idx = r.readC();
  return { cs, idx, entry: readEntry(r, 6) };
}

/**
 * Friend list of the account. The full list comes once per login on the Auth connection (2320 GET_OPTION -> 1810, see
 * metaAuth.ts fetchAuthMeta -> set); later changes (1815) come on the Game connection (attach). The list survives a
 * detach: the battle HUD re-attaches the same Game connection and must not lose it.
 */
export class FriendList {
  list: FriendEntry[] = [];
  private off: (() => void) | null = null;
  private subs = new Set<() => void>();

  set(list: FriendEntry[]): void {
    this.list = list;
    this.emit();
  }

  attach(conn: PbConnection): void {
    this.detach();
    this.off = conn.on((op, r) => {
      // parse a copy: the reader is shared with the waitFor() callers of the requests below
      if (op === FriendOp.LIST_ACK) this.set(readFriendList(new PacketReader(r.data.slice(r.pos))));
      else if (op === FriendOp.INFO_CHANGE_ACK) { this.apply(readFriendChange(new PacketReader(r.data.slice(r.pos)))); this.emit(); }
    });
  }

  detach(): void {
    this.off?.();
    this.off = null;
  }

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private apply(m: FriendChangeMsg): void {
    if (m.cs === FriendChange.DELETE) { this.list.splice(m.idx, 1); return; }
    if (m.cs !== FriendChange.INSERT && m.cs !== FriendChange.UPDATE) return; // Accept: the Update that follows carries the entry
    while (this.list.length < m.idx) this.list.push(null);
    this.list[m.idx] = m.entry;
  }

  private emit(): void { for (const fn of this.subs) fn(); }
}

/** the Game connection's friend list (attached by chat.attach, see chatClient.ts) */
export const friendList = new FriendList();

/** Resolves with 0 when the friend was added, else the server error code (FriendErr) or 0x80000000 when nothing answers. */
export async function requestFriend(conn: PbConnection, nick: string): Promise<number> {
  const ok = conn.waitFor(FriendOp.INFO_CHANGE_ACK, 5000).then(() => 0);
  const err = conn.waitFor(FriendOp.INVITE_ERR_ACK, 5000).then((r) => r.readD());
  try {
    conn.send(FriendOp.INVITE_REQ, new PacketWriter(72).writeU(nick, 66));
    return await Promise.race([ok, err]);
  } catch {
    return NO_ANSWER;
  }
}

/** Buscar / convite de clã pelo nick: 2426 {U nick(66)} -> 2438 {H 0, D err} (server profileHandlers.ts 2426; the
 * server sets `findPlayer` so the next 888 invites that account). Resolves true when found (err 0). An unknown nick or
 * the own nick gets no answer from the server, so this resolves false after the timeout. */
export async function findUser(conn: PbConnection, nick: string): Promise<boolean> {
  const ack = conn.waitFor(FriendOp.USER_DETAIL_ACK, 5000).then((r) => { r.readH(); return r.readD() === 0; });
  try {
    conn.send(FriendOp.FIND_USER_REQ, new PacketWriter(68).writeU(nick, 66));
    return await ack;
  } catch {
    return false;
  }
}

/** Buscar no servidor (exe 0x88efb0 -> 0x78e710 -> SetEvent 0x64 -> 0x59223f): opcode 297 with the nick in 33 bytes.
 * A nick of 33 bytes or more sends nothing (0x78e710 guard). Zero padding = the 0x78fc60 copy (strncpy 33) [INFERIDO]: the
 * exe writes the 33 raw bytes of its nick pointer. Fire and forget, no reply to wait for: the exe's recv dispatch has no
 * handler for 0x129 (PointBlank.exe 0x991d50, the 0x112..0x1db family maps it to the default 0x993132; no other family
 * covers it), so any 297 packet is ignored and a miss stays silent. server and the old C# server ignore 297 too. */
export function sendFindLobby(conn: PbConnection, nick: string): void {
  if (new TextEncoder().encode(nick).length >= 33) return;
  conn.send(FriendOp.FIND_LOBBY_REQ, new PacketWriter(33).writeS(nick, 33));
}

/** Aceitar pedido recebido (1816 by index). 0 = accepted; the server refuses a request that is not received (state 2). */
export async function acceptFriend(conn: PbConnection, idx: number): Promise<number> {
  // the answer is the 1815 Accept (cs 2) or the 1817 error; another 1815 (a friend's Update) that arrives first is skipped,
  // not taken as a refusal. The reader is copied: the other listeners of the connection read the same packet.
  let off = (): void => {};
  const answer = new Promise<number>((resolve) => {
    const timer = setTimeout(() => { off(); resolve(NO_ANSWER); }, 5000);
    off = conn.on((op, r) => {
      const copy = new PacketReader(r.data.slice(r.pos));
      if (op === FriendOp.INFO_CHANGE_ACK && copy.readC() === FriendChange.ACCEPT) resolve(0);
      else if (op === FriendOp.ACCEPT_ERR_ACK) resolve(copy.readD());
      else return;
      clearTimeout(timer);
      off();
    });
  });
  try {
    conn.send(FriendOp.ACCEPT_REQ, new PacketWriter(2).writeC(idx));
  } catch {
    off();
    return NO_ANSWER;
  }
  return answer;
}

/** Excluir amigo ou recusar pedido (1820 by index). 0 = done. */
export async function deleteFriend(conn: PbConnection, idx: number): Promise<number> {
  const ack = conn.waitFor(FriendOp.DELETE_ACK, 5000).then((r) => r.readD());
  try {
    conn.send(FriendOp.DELETE_REQ, new PacketWriter(2).writeC(idx));
    return await ack;
  } catch {
    return NO_ANSWER;
  }
}
