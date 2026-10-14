// Menu de contexto do jogador do Point Blank Cross (ContextMenu em UI_Project + ctList). Itens e ordem do exe Cross:
// CContextMenu::AddCommand (0xc22448) com a enum ContextMenuCommand; a tabela de textos (STR_TBL_GUI_ETC_CONTEXT_*) está em
// tools/data/cross-ui-map.json (lbAbuseWindow) e strings.json. Quem monta a lista e com quais condições:
//   lista de espera do lobby, clique direito no nick (0x835170 -> 0x835180, ordem 9, 3, 6, 8): Informações sempre; eu não
//   recebe PM / amizade / convite; Convite do Clã se canClanInvite. Clique direito = evento 5 do despachante 0x8282xx
//   ([ev+4]==5 em 0x8282fd, arg [ev+8] = índice da linha -> 0x835170).
//   slot da sala (0x7d5cf0, ordem 0, 1, 3, 6, 8, 10): nada no próprio slot; Novo dono (0) = REQUEST_MAIN_CHANGE_WHO 3615 (líder);
//   Forçar saída (1) = ROOM_CHANGE_SLOT_REQ (líder, 0x7d2ee0); Espionar (10) escondido: gate 0x7fc0c0 = item 1301085000 (0x4d8cfb48)
//   no inventário (0x7f4450) + catálogo (0x523c00); a ação é 0x7cc760 (mesmo gate). Item não existe nos dados do repo nem no 3.123
//   (Shop/ItemGroup/RandomBox/Quest.dat, UI.xml, Messages.xml, Kaybo Tables) -> inalcançável, fica escondido.
//   lista de amigos / comunidade (0x886780, PM 3, Convidar 4, Buscar 5, Convite 8, Adicionar 6): não portada (estados 0x886700 e 0x4de150 não decodificados).
//   chat (lobby lb / sala rr), clique direito em qualquer linha: 0x8747e0 (vt+0xd8 do chat) -> gate [this+0xbf8]==0 e
//   0x6fbdc0([this+0x18]) = owner é CStageReady (meta 0xd86858, nome em 0xb34dd0) -> 0x6fb980 -> 0x515580 -> popup [H+0x3698]
//   vt+0xd8(x, y). Não monta lista nem lê a linha: mostra o menu compartilhado [H+0x369c] (CContextMenu: count +0x9c, alvo
//   +0xa0/+0xa4, textos +0xa8) que a última lista deixou (lobby, slot da sala, amigo). Ver app.ts openChatMenu.
//   Cada item: 0x6fb960(cmd) -> 0x515560 -> 0x8b3590(cmd) = texto do CMC_TEXT; 0x6fb940(alvo, arg) -> 0x8b3370 grava o alvo.
// Convite do Clã: 2426 (achar nick) -> 888 -> 889 (friendClient.ts findUser, clanClient.ts invite). Ver app.ts clanInviteMenu.

import { CrossState } from "../../net/friendClient.ts";

/** ContextMenuCommand, na ordem da enum do exe (índice = id usado pelo builder 0x8b3590). */
export const CMC = {
  GIVE_MASTER: 0, FORCE_GET_AWAY: 1, PERSONAL_INFO: 2, WHISPER: 3, INVITE: 4, FIND_OUT: 5,
  ADD_FRIEND: 6, CUT_OFF: 7, CLAN_INVITE: 8, DETAIL_INFO: 9, VIEW_ITEM_INFO: 10,
} as const;

/** STR key + texto de reserva por comando (strings.json). */
export const CMC_TEXT: Record<number, [key: string, fallback: string]> = {
  0: ["STR_TBL_GUI_ETC_CONTEXT_GIVE_MASTER", "Novo dono"],
  1: ["STR_TBL_GUI_ETC_CONTEXT_FORCE_GET_AWAY", "Forçar saída"],
  2: ["STR_TBL_GUI_ETC_CONTEXT_PERSONAL_INFO", "Informações pessoais"],
  3: ["STR_TBL_GUI_ETC_CONTEXT_WHISPER", "PM"],
  4: ["STR_TBL_GUI_ETC_CONTEXT_INVITE", "Convidar"],
  5: ["STR_TBL_GUI_ETC_CONTEXT_FIND_OUT", "Buscar"],
  6: ["STR_TBL_GUI_ETC_CONTEXT_ADD_FRIEND", "Adicionar amigo"],
  7: ["STR_TBL_GUI_ETC_CONTEXT_CUT_OFF", "Bloquear"],
  8: ["STR_TBL_GUI_ETC_CONTEXT_CLAN_INVITE", "Convite do Clã"],
  9: ["STR_TBL_GUI_ETC_CONTEXT_DETAIL_INFO", "Informações"],
  10: ["STR_TBL_GUI_ETC_CONTEXT_VIEW_ITEM_INFO", "Espionar"],
};

/** clã: 0xFFFFFFFF = sem clã (gameServer.ts GetClan(0), a logo do clã). Lobby e slot usam o mesmo valor. */
export const NO_CLAN_LOGO = 0xffffffff;

/** lista de amigos / comunidade (0x886780, ordem do exe 3, 4, 5, 8). Decodificado: top = (rec+8)>>28.
 * PM (3): top != offline e [x+0x70] (0x884a50/0x884a70, flag de sessão) [INFERIDO: só estados conectados 4/5/6 aqui].
 * Convidar (4) e Buscar (5) (estado 4/5: Convidar; estado 6: Buscar fora do lobby, Convidar+Buscar no lobby):
 * [ui+0x3714] == 3 = eu no lobby (0x4de150). Gate 0x597cc0 (own-place: mesmo servidor, canal e sala que eu, community.ts) e
 * busy 0x519270 (return obj+0x50) não têm equivalente no web [LACUNA]: no lobby o meu lugar nunca é sala, e o web não tem obj+0x50.
 * Convite do Clã (8): 0x886690 = amigo já está na lista de amigos, e todo amigo da linha está; nunca aparece aqui. */
export function friendMenuItems(top: number, inLobby: boolean): number[] {
  const conn = top === CrossState.ONLINE || top === CrossState.LOBBY || top === CrossState.ROOM;
  return [...(conn ? [CMC.WHISPER] : []), ...(conn && inLobby ? [CMC.INVITE] : []), ...(top === CrossState.ROOM ? [CMC.FIND_OUT] : [])];
}

/** Convite do Clã (0x802fd0 + 0x4f81f0): só dono/auxiliar convida, e só quem não tem clã. [INFERIDO] a regra de autoridade
 * é canManage (dono ou auxiliar); o exe ainda consulta a opção "Autoridade de convidar ao clã" (STBL_IDX_CLAN_AUTHORITY_INVITE),
 * que o web não tem. Quem recebe o convite é checado no servidor (clanHandlers.ts handleInvite: alvo sem clã). */
export function canClanInvite(myAccess: number, targetClanLogo: number | undefined): boolean {
  return (myAccess === 1 || myAccess === 2) && (targetClanLogo ?? 0) >>> 0 === NO_CLAN_LOGO;
}

/** lista de espera do lobby (0x835170, ordem do exe): Informações sempre; eu não recebo PM, amizade nem convite */
export function lobbyMenuItems(isMe: boolean, clanInvite: boolean): number[] {
  if (isMe) return [CMC.DETAIL_INFO];
  return [CMC.DETAIL_INFO, CMC.WHISPER, CMC.ADD_FRIEND, ...(clanInvite ? [CMC.CLAN_INVITE] : [])];
}

/** slot da sala de espera (0x7d5cf0, ordem do exe): nada no próprio slot; líder (0x7d2ee0) ganha Novo dono (push 0, 0x7d5d20)
 * e Forçar saída (push 1); PM e amizade; Convite do Clã. Novo dono = REQUEST_MAIN_CHANGE_WHO 3615 (líder, só em READY). */
export function roomMenuItems(isMine: boolean, isLeader: boolean, clanInvite: boolean): number[] {
  if (isMine) return [];
  return [...(isLeader ? [CMC.GIVE_MASTER, CMC.FORCE_GET_AWAY] : []), CMC.WHISPER, CMC.ADD_FRIEND, ...(clanInvite ? [CMC.CLAN_INVITE] : [])];
}
