// Player commands, called by handleChat before the broadcast. The GM commands (":name",
// gmCommands.ts) are a different prefix and untouched. The reply goes only to the author, as a line from "Server" (lobbyChatAck(0, "Server", 5)).
// Everything is validated here again: the client only parses to open the right popup.
//   /ajuda  /w <nick> <texto>  /r <texto>  /ping  /denunciar <nick> <hack|chat> [detalhe]  /votekick <nick> <hack|chat>
//   /votelider [nick]  /sim  /nao  /bug
//   /bloquear <nick>, /desbloquear <nick>: CLIENT-side filters, playerCommands returns false for them (handleChat drops them, isClientCommand)
// A nick with spaces goes "in quotes". A nick is resolved by unique prefix among the players of the sender's room (exact match wins; an
// ambiguous prefix is an error line), then by exact match among the players online.
// /bug answers the line "\u0001BUG" (SOH + BUG): the client sees the prefix and opens the bug popup instead of printing it.
import { config } from "../config.ts";
import type { Account } from "../shared/account.ts";
import { RoomState } from "./roomModel.ts";
import * as rp from "./roomPackets.ts";
import { handleRequestMain } from "./roomHandlers.ts";
import { banState, lastWhisperPartner, sendWhisper, serverReply, social } from "./socialHandlers.ts";
import { PLAYER_HELP as HELP, cleanChatText, tokenize, type Token } from "./chatGuard.ts";
import { KICK_ERR, castKickVote, startKickVote } from "./voteKick.ts";
import { LEADER_ERR, LEADER_MIN_HUMANS, castLeaderVote, pingOf, startLeaderVote } from "./voteLeader.ts";
import { activeVote, roomOf } from "./voteCommon.ts";
import { REPORT_ERR, submitReport, type ReportKinds } from "./reports.ts";
import type { GameClient } from "./gameServer.ts";

/** The first line of the reply to /bug: the marker the client turns into the bug popup. */
export const BUG_POPUP_LINE = "\u0001BUG";

export { tokenize, type Token };

const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export interface ParsedCommand { name: string; args: Token[]; /** the text after token <n> (n = -1: after the name) */ rest(n: number): string }

/** "/name rest" -> the lower-case accent-free name and its tokens; null when the text is not a command ("/", "/o/", ":x"). */
export function parseCommand(text: string): ParsedCommand | null {
  const m = /^\/(\p{L}+)(?=\s|$)/u.exec(text.trim());
  if (!m) return null;
  const t = text.trim(), after = t.slice(m[0].length);
  const args = tokenize(after);
  return { name: fold(m[1]), args, rest: (n) => (n < 0 ? after : after.slice(args[n]?.end ?? after.length)).trim() };
}

export type TargetResult = { acc: Account } | { err: string };

/** Unique prefix inside the room, then exact among the online players (see the header). roomOnly: only the room counts. */
export function resolveNick(p: Account, query: string, roomOnly = false): TargetResult {
  const q = fold(query);
  if (!q) return { err: "Informe o apelido do jogador." };
  const room = roomOf(p);
  if (room) {
    // a hidden GM observer is not a room mate for a normal account: no prefix match, no name in the "ambiguous" list
    const mates = room.getAllPlayers().filter((a) => p.isGM() || !room.slots[a.slotId]?.stealth);
    const exact = mates.filter((a) => fold(a.nickname) === q);
    if (exact.length === 1) return { acc: exact[0] };
    const pref = mates.filter((a) => fold(a.nickname).startsWith(q));
    if (pref.length === 1) return { acc: pref[0] };
    if (pref.length > 1) return { err: `Apelido ambíguo: ${pref.slice(0, 5).map((a) => a.nickname).join(", ")}${pref.length > 5 ? "..." : ""}. Digite mais letras.` };
  }
  if (!roomOnly) {
    const a = [...social.online.values()].find((x) => x.isOnline && fold(x.nickname) === q);
    if (a) return { acc: a };
  }
  return { err: `Jogador '${query}' não encontrado${roomOnly ? " na sala" : ""}.` };
}

const KICK_TEXT = (): Record<number, string> => ({
  [KICK_ERR.fail]: "Não foi possível iniciar a votação.",
  [KICK_ERR.active]: "Já há uma votação em andamento.",
  [KICK_ERR.cooldown]: "Aguarde 1 minuto entre votações.",
  [KICK_ERR.rank]: `Você precisa ser patente ${config.voteMinRank} ou mais para votar uma expulsão.`,
  [KICK_ERR.voted]: "Você já votou.",
  [KICK_ERR.fewPlayers]: "É preciso ter pelo menos 4 jogadores humanos na partida.",
  [KICK_ERR.protectedTarget]: "Esse jogador não pode ser expulso por votação.",
});
const LEADER_TEXT = (): Record<number, string> => ({
  [LEADER_ERR.fail]: "Não foi possível iniciar a votação.",
  [LEADER_ERR.active]: "Já há uma votação em andamento.",
  [LEADER_ERR.cooldown]: "Aguarde 2 minutos entre votações de líder.",
  [LEADER_ERR.rank]: `Você precisa ser patente ${config.voteMinRank} ou mais para votar um novo líder.`,
  [LEADER_ERR.voted]: "Você já votou.",
  [LEADER_ERR.fewPlayers]: `É preciso ter pelo menos ${LEADER_MIN_HUMANS} jogadores humanos na partida.`,
  [LEADER_ERR.badTarget]: "Esse jogador não pode ser o novo líder.",
  [LEADER_ERR.highPing]: "Esse jogador tem ping alto demais para ser líder.",
  [LEADER_ERR.rejected]: "Votação reprovada.",
});
const REPORT_TEXT = (): Record<number, string> => ({
  [REPORT_ERR.noTickets]: `Sem tickets de denúncia (${config.reportTickets} a cada 24 h).`,
  [REPORT_ERR.rank]: `Você precisa ser patente ${config.reportMinRank} ou mais para denunciar.`,
  [REPORT_ERR.duplicate]: "Você já denunciou esse jogador.",
  [REPORT_ERR.fail]: "Não foi possível enviar a denúncia.",
});

/** "hack" / "chat" -> report kinds + the vote motive (0 chat, 1 hack [INFERIDO]); null when it is neither. */
export function parseKind(w: string | undefined): { kinds: ReportKinds; motive: number } | null {
  const k = fold(w ?? "");
  if (k === "hack") return { kinds: { chat: false, hack: true }, motive: 1 };
  if (k === "chat") return { kinds: { chat: true, hack: false }, motive: 0 };
  return null;
}

/** true = the text was a command and was answered (do not broadcast); false = not for us (normal chat, or client-side commands). */
export async function playerCommands(p: Account, text: string): Promise<boolean> {
  const cmd = parseCommand(text);
  if (!cmd) return false;
  const say = (m: string) => serverReply(p, m);
  const client = p.connection as GameClient | null;
  const room = roomOf(p);
  const a = cmd.args;
  switch (cmd.name) {
    case "bloquear": case "desbloquear": return false;
    case "ajuda": case "help": for (const l of HELP) say(l); return true;
    case "bug": say(BUG_POPUP_LINE); return true;
    case "w": {
      if (a.length < 2) { say("Uso: /w <nick> <texto>"); return true; }
      const t = cleanChatText(cmd.rest(0));
      if (!t) { say("Uso: /w <nick> <texto>"); return true; }
      if (t.length > 60) { say("Texto longo demais (máximo 60 caracteres)."); return true; }
      if (await banState(p)) { say("Você está silenciado."); return true; }
      const r = resolveNick(p, a[0].value);
      if ("err" in r) { say(r.err); return true; }
      if (r.acc.playerId === p.playerId) { say("Você não pode sussurrar para si mesmo."); return true; }
      say(sendWhisper(p, r.acc, t) ? `Sussurro para ${r.acc.nickname}: ${t}` : `${r.acc.nickname} não está disponível.`);
      return true;
    }
    case "r": {
      const t = cleanChatText(cmd.rest(-1));
      if (!t) { say("Uso: /r <texto>"); return true; }
      if (t.length > 60) { say("Texto longo demais (máximo 60 caracteres)."); return true; }
      const nick = lastWhisperPartner(p);
      if (!nick) { say("Ninguém para responder."); return true; }
      if (await banState(p)) { say("Você está silenciado."); return true; }
      const to = [...social.online.values()].find((x) => x.nickname === nick) ?? null;
      say(sendWhisper(p, to, t) ? `Sussurro para ${nick}: ${t}` : `${nick} não está disponível.`);
      return true;
    }
    case "ping": {
      if (!room || room.state < RoomState.BATTLE_READY) { say("O /ping só funciona durante a partida."); return true; }
      const host = room.getSlot(room.leader), hostAcc = host && host.playerId > 0n ? room.svc.getAccount(host.playerId) : null;
      const me = pingOf(room, p.slotId), h = pingOf(room, room.leader);
      say(`Host: ${hostAcc?.nickname ?? "?"} (slot ${room.leader + 1}${room.leader === p.slotId ? ", você" : ""}). Ping: você ${me === 255 ? "?" : me}, host ${h === 255 ? "?" : h}.`);
      return true;
    }
    case "denunciar": {
      if (a.length < 2) { say("Uso: /denunciar <nick> <hack|chat> [detalhe]"); return true; }
      const k = parseKind(a[1].value);
      if (!k) { say("Tipo inválido: use hack ou chat."); return true; }
      const r = resolveNick(p, a[0].value);
      if ("err" in r) { say(r.err); return true; }
      const res = await submitReport(p, r.acc, k.kinds, cmd.rest(1));
      if (res.err !== 0) say(REPORT_TEXT()[res.err] ?? REPORT_TEXT()[REPORT_ERR.fail]);
      else say(res.ignored ? "Denúncia ignorada: não é possível denunciar a si mesmo nem um GM." : `Denúncia enviada contra ${r.acc.nickname}. Tickets restantes: ${res.left}.`);
      return true;
    }
    case "votekick": {
      if (!room || room.state !== RoomState.BATTLE) { say("A votação de expulsão só funciona durante a partida."); return true; }
      if (a.length < 2) { say("Uso: /votekick <nick> <hack|chat>"); return true; }
      const k = parseKind(a[1].value);
      if (!k) { say("Motivo inválido: use hack ou chat."); return true; }
      const r = resolveNick(p, a[0].value, true);
      if ("err" in r) { say(r.err); return true; }
      let acked = false;
      const err = startKickVote(p, r.acc.slotId, k.motive, () => { acked = true; client?.session.send(rp.errAck(5191, 0)); });
      if (!acked) client?.session.send(rp.errAck(5191, err));
      say(err === 0 ? `Votação de expulsão iniciada contra ${r.acc.nickname}. Vote com /sim ou /nao.` : KICK_TEXT()[err] ?? KICK_TEXT()[KICK_ERR.fail]);
      return true;
    }
    case "votelider": {
      if (!room) { say("Você precisa estar em uma sala."); return true; }
      if (room.state === RoomState.READY) {
        // out of battle: 3611 REQUEST_MAIN, a vote to take the leadership for yourself
        const r = a.length ? resolveNick(p, a[0].value, true) : { acc: p };
        if ("err" in r) { say(r.err); return true; }
        if (r.acc.playerId !== p.playerId) { say("Na sala, /votelider pede a liderança para você mesmo."); return true; }
        if (room.leader === p.slotId) { say("Você já é o líder."); return true; }
        if (client) handleRequestMain(client);
        say("Pedido de liderança enviado à sala.");
        return true;
      }
      if (room.state !== RoomState.BATTLE) { say("A votação de líder só funciona na sala ou durante a partida."); return true; }
      let slot = 255;
      if (a.length) { const r = resolveNick(p, a[0].value, true); if ("err" in r) { say(r.err); return true; } slot = r.acc.slotId; }
      let acked = false;
      const err = startLeaderVote(p, slot, () => { acked = true; client?.session.send(rp.errAck(9011, 0)); });
      if (!acked) client?.session.send(rp.errAck(9011, err));
      say(err === 0 ? "Votação de líder iniciada. Vote com /sim ou /nao." : LEADER_TEXT()[err] ?? LEADER_TEXT()[LEADER_ERR.fail]);
      return true;
    }
    case "sim": case "nao": {
      const v = room ? activeVote(room) : null;
      if (!room || !v) { say("Não há votação em andamento."); return true; }
      const yes = cmd.name === "sim";
      const err = v.kind === "kick" ? castKickVote(p, yes) : castLeaderVote(p, yes);
      say(err === 0 ? "Voto registrado." : err === KICK_ERR.voted ? "Você já votou." : "Você não pode votar agora.");
      return true;
    }
    default:
      say("Comando desconhecido. Digite /ajuda.");
      return true;
  }
}
