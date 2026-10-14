// Point Blank Cross control name -> text / Lobby2017 controller action / sound: the ONE table of the Cross lobby, filled from
// the Cross exe map. Entries the map confirms (str /
// handler read in the exe) carry the address; the ones it does not confirm sit in the [INFERIDO] blocks.
// Layouts: public/assets/ui/cross/UI_Project_*.json (pb-extract-tools export-classic-ui.mjs --client cross); texts: strings.json.
import { MAIN_BUTTONS } from "../core/model.ts";
import { UI_CLICK_CANCEL, UI_CLICK_OK, UI_CLICK_SELECT, UI_POPUP_OPEN } from "../../ui/uiClick.ts";

/** packs read by the Cross lobby */
export const CROSS_PACKS = ["UI_Project", "UI_Project_ServerList", "UI_Project_Lobby", "UI_Project_ReadyRoom", "UI_Project_Popup"] as const;

/**
 * Windows drawn, by layer (later = on top). Each is built at its absolute place in the 1024x768 design. The page decides which
 * are visible (app.ts paint). `as` builds a renamed copy. The message box is not here: the exe builds it in code
 * (CMessageBox::Create 0x753c90), app.ts messageBox() does the same.
 */
export const CROSS_WINDOWS: { pack: (typeof CROSS_PACKS)[number]; name: string; as?: string }[] = [
  { pack: "UI_Project_ServerList", name: "ssServerListWin" },
  { pack: "UI_Project_ServerList", name: "ssServerWin" },
  { pack: "UI_Project_Lobby", name: "lbInfoWin" },
  { pack: "UI_Project_Lobby", name: "lbUserListWin" },
  { pack: "UI_Project_Lobby", name: "lbRoomWin" },
  { pack: "UI_Project_ReadyRoom", name: "rrRoomWin" },
  { pack: "UI_Project_ReadyRoom", name: "rrRecordWin" },
  // ready room popups: Opções avançadas (rrOption 0x7cabf0), Convidar (rrInvite 0x7ca2b0), Recompensas / Aviso do fim de missão
  { pack: "UI_Project_ReadyRoom", name: "rrAdvencedWin" },
  { pack: "UI_Project_ReadyRoom", name: "rrInviteWin" },
  { pack: "UI_Project_ReadyRoom", name: "rrCardComplateWin" },
  { pack: "UI_Project_ReadyRoom", name: "rrFinalComplateWin" },
  { pack: "UI_Project_ReadyRoom", name: "rrFinalComplateExWin" },
  { pack: "UI_Project_ReadyRoom", name: "rrFinalComplatePrizeWin" },
  { pack: "UI_Project", name: "MenuBar" },
  { pack: "UI_Project_Lobby", name: "lbCreateWin" },
  { pack: "UI_Project_Lobby", name: "lbSpecialWarWin" },
  { pack: "UI_Project_Popup", name: "RandomMapWin" },
  { pack: "UI_Project_Popup", name: "lbJoinWin" },
  { pack: "UI_Project_Popup", name: "UserInfoPopup" },
  { pack: "UI_Project", name: "ContextMenu" },
];

/** controls with no web equivalent (yet): hidden, never placeholders */
export const CROSS_HIDDEN = [
  // server phase: the 'go to server list' / next-server arrows (the web flow has one Back), the server-group legend
  "ssGotoServerList", "ssNext", "ServerLabel1", "ServerLabel2", "ServerLabel3", "ServerLabel4", "ServerLabel5",
  ...Array.from({ length: 20 }, (_, i) => `ssServerSelectNumber_${i + 1}`),
  // lobby: special-mode buttons, chat combo + language, clan / e-sports / nation marks. The info rows (lbMap ..
  // lbTeamBalance) stay: the exe draws every key and clears the values with no room picked (0x834450). Map picture: the
  // NEW / Christmas tags of the three map boxes (lb / rr / rrCreate ImageDummy3, ImageXMas) come from a per-stage mark list
  // (0x7f4df0 -> 0x6e2350, table +0xc8 of 0xd878f0) that is not decoded; the Chaos / HeadHunter tag (ImageDummy4, room
  // special byte +0x25 7 / 10) has no such room on the server; the random-map spinner rrImageCircle is not ported.
  "lbDino", "lbQuickSeparate1", "lbImageDummy3", "lbImageDummy4", "lbImageXMas",
  "rrCreateImageDummy3", "rrCreateImageDummy4", "rrCreateImageXMas", "rrImageDummy3", "rrImageDummy4", "rrImageXMas", "rrImageCircle",
  "lbChatCombo", "lbChatLang", "lbTeamCaption", "lbHeadSeparate7", "lbChatTab4",
  ...Array.from({ length: 10 }, (_, i) => [`lbBattleMarkFront${i + 1}`, `lbBattleMarkRear${i + 1}`, `lbNonRealIP${i + 1}`]).flat(),
  // user list: the beginner-server mark (SetRankImage(52) only when the server type is 2, 0x834d6b; not in the web) and the rest
  ...Array.from({ length: 8 }, (_, i) => [`lbUserListSlotESport${i + 1}`, `lbUserListSlotNation${i + 1}`, `lbUserListChangeEffect${i + 1}`, `lbUserListSlotRank_Beginner${i + 1}`]).flat(),
  "lbUserListSlotSelect", "lbUserListSlotFocus",
  // ready room: host search, clan battle, GM observer box; the random-map list button (rrRandomMap 0x7cb6f0
  // CStageReady::TogglePopup -> RandomMapWin, not ported) and the edit frame under it. Owner edits (title / password / mode /
  // Objetivo / Tempo arrows, map combo + popup, CheckRandomMap) and the slot kick are wired in app.ts wireRoom.
  // clan match band (rrClanBattleInfo, shown by paintRoom while clanPairing): its Mode / Type / Time arrows and the Opções row are
  // not ported (the rules come from the room, no rule change in a clan match [INFERIDO]); its bottom (rrClanBattleBottom, ChangeTeam) stays hidden
  "rrSearchHost", "rrClanBattleBottom", "rrClanBattleInfo", "rrClanBattleModePrev", "rrClanBattleModeNext", "rrClanBattleTypePrev",
  "rrClanBattleTypeNext", "rrClanBattleTimePrev", "rrClanBattleTimeNext", "rrClanBattleOptionKey", "rrClanBattleOption",
  "rrBattleMark", "rrRedList", "rrBlueList", "rrRandomMap", "EditRandomMap",
  "rrChatCombo", "rrChatLang",
  // slots: clan mark / clan rank (_SetClanInfoInSlot 0x7d7130 hides both without a clan;
  // the clan mark / rank art is not exported), e-sports (byte +0x10, always 0 here), nation, mark effect, beginner rank
  ...["Red", "Blue"].flatMap((t) => Array.from({ length: 8 }, (_, i) => [`rr${t}ClanRank${i + 1}`, `rr${t}ESportLeft${i + 1}`, `rr${t}ESportRight${i + 1}`, `rr${t}Nation${i + 1}`, `rr${t}MarkEffect${i + 1}`, `rr${t}Rank_Beginner${i + 1}`]).flat()),
  // record window: beginner rank, clan mark / clan rank art (see above)
  "rrRecordRank_Beginner", "rrClanRank",
  // menu bar: pages not ported to the Cross renderer yet, e-sports / nation marks (profile / inventory / shop: pages/; clan: pages/clan.ts;
  // community: pages/community.ts, wired in app.ts)
  "mbESport", "mbNation", "mbAnnounce2",
];

/** control name -> [STR key of strings.json, fallback (the PT-BR text of String_Brazil)]; "%d" style values are filled by app.ts */
export const CROSS_TEXT: Record<string, [key: string, fallback: string]> = {
  // ---- confirmed: GAME_STRING -> SetText of the control in the exe (strVa of cross-ui-map.json) ----
  // channel list (CPhaseChannelList 0x822360..0x822673)
  ssServerCaption: ["STR_TBL_GUI_SERVER_LIST", "Lista de servidores"],
  ssPrevCaption: ["STR_TBL_GUI_SERVER_PREV_PAGE", "Voltar"],
  ssRefreshCaption: ["STR_TBL_GUI_SERVER_REFRESH", "Atualizar"],
  ssEnterCaption: ["STR_TBL_GUI_SERVER_CONNECT", "Conectar"],
  // lobby (CPhaseLobby text init 0x82b5f0, headers 0x82c15e..0x82c26b, info keys 0x82c47f..0x82c5de)
  lbRoomWinCaption: ["STR_TBL_GUI_LOBBY_ROOM_LIST_TEXT", "Lista de salas"],
  lbInfoWinCaption: ["STR_TBL_GUI_LOBBY_GAME_INFO_TEXT", "Informações do jogo"],
  lbUserListWinCaption: ["STR_TBL_GUI_LOBBY_USER_LIST", "Lista de espera"],
  lbIdxCaption: ["STR_TBL_GUI_LOBBY_NUMBER_TEXT", "ID"], lbModeCaption: ["STR_TBL_GUI_LOBBY_GAME_MODE_TEXT", "Modo"],
  lbMapCaption: ["STR_TBL_GUI_LOBBY_MAP_INFO_TEXT", "Mapa"], lbTitleCaption: ["STR_TBL_GUI_LOBBY_ROOMNAME_TEXT2", "Nome da sala"],
  lbStateCaption: ["STR_TBL_GUI_LOBBY_STATE_TEXT", "Status"], lbPersonCaption: ["STR_TBL_GUI_LOBBY_PEOPLE_COUNT_TEXT", "Users"],
  lbPingCaption: ["STR_TBL_GUI_LOBBY_PING_TEXT", "Ping"],
  lbMapKey: ["STR_TBL_GUI_LOBBY_MAP_INFO_TEXT", "Mapa"], lbModeKey: ["STR_TBL_GUI_LOBBY_GAME_MODE_TEXT", "Modo"],
  lbTypeKey: ["STR_TBL_GUI_LOBBY_GAME_SETTING_TEXT", "Configurações"], lbHostKey: ["STR_TBL_GUI_LOBBY_ROOM_MASTER_TEXT", "Dono da sala"],
  lbStateKey: ["STR_TBL_GUI_LOBBY_PROGRESS_TEXT", "Progresso"], lbJoinLimitKey: ["STR_TBL_GUI_LOBBY_LIMIT_ENTER_TEXT", "Restrição de entrada"],
  lbWeaponLimitKey: ["STR_TBL_GUI_LOBBY_LIMIT_WEAPON_TEXT", "Restrição de arma"], lbObserverLimitKey: ["STR_TBL_GUI_LOBBY_LIMIT_OBSERVER", "Observador"],
  lbTeamBalanceKey: ["STR_TBL_GUI_LOBBY_TEAM_BALANCE_TEXT", "Times balanceados"],
  // chat tabs (shared chat box 0x7b8e80, switch on the phase 0x7b9241: tabs 1..4 = members 0x84..0x90). Ready room (case 1,
  // 0x7b9501..0x7b958d): Todos / Time / Clã / PM. Lobby (cases 0/2/3, 0x7b968f..0x7b96fb): Todos / Clã / PM, tab 4 hidden.
  lbChatTab1: ["STR_TBL_CHAT_INGAME_POPUP_ALL", "Todos"], lbChatTab2: ["STR_TBL_CHAT_INGAME_POPUP_CLAN", "Clã"], lbChatTab3: ["STR_TBL_CHAT_INGAME_CHANNEL_WHISPER", "PM"],
  rrChatTab1: ["STR_TBL_CHAT_INGAME_POPUP_ALL", "Todos"], rrChatTab2: ["STR_TBL_CHAT_INGAME_POPUP_TEAM", "Time"], rrChatTab3: ["STR_TBL_CHAT_INGAME_POPUP_CLAN", "Clã"],
  rrChatTab4: ["STR_TBL_CHAT_INGAME_WHISPER_TEXT", "PM"],
  // create room
  lbCreateWinCaption: ["STR_TBL_GUI_LOBBY_CREATE_ROOM_TEXT", "Criar sala"],
  lbCreateTitleKey: ["STR_TBL_GUI_LOBBY_ROOMNAME_TEXT1", "Título da sala"], lbCreatePasswordKey: ["STR_TBL_GUI_LOBBY_PASSWORD_TEXT", "Senha"],
  rrCreateModeKey: ["STR_TBL_GUI_READY_GAME_MODE", "Modo"], rrCreateTypeKey: ["STR_TBL_GUI_READY_VICTORY_CONDITION", "Objetivo"],
  rrCreateTimeKey: ["STR_TBL_GUI_READY_LIMIT_TIME", "Tempo"],
  rrCreateLimitKey: ["STR_TBL_GUI_READY_WEAPON_LIMIT", "Restrição de armas"],
  rrCreateLimitPrimaryKey: ["STR_TBL_GUI_READY_PRIMARY_WEAPON", "Arma principal"], rrCreateLimitSecondaryKey: ["STR_TBL_GUI_READY_SECONDRY_WEAPON", "Arma secundária"],
  rrCreateLimitMeleeKey: ["STR_TBL_GUI_READY_MELLE_WEAPON", "Arma branca"], rrCreateLimitThrowKey: ["STR_TBL_GUI_READY_THROW_WEAPON", "Granada"],
  rrCreateLimitRPG7Key: ["STR_TBL_GUI_READY_RPG7_WEAPON", "RPG7"],
  rrCreateLimitObserverKey: ["STR_TBL_GUI_READY_OBSERVER_LIMIT", "Observador"],
  rrObserver1PV_OnlyKey: ["STR_TBL_GUI_READY_OBSERVER_LIMIT5", "Bloquear 3ª pessoa"], rrObserver3PV_FreeKey: ["STR_TBL_GUI_READY_OBSERVER_LIMIT1", "3ª pessoa livre"],
  rrObserver1PV_FreeKey: ["STR_TBL_GUI_READY_OBSERVER_LIMIT2", "Câmera livre"], rrObserverEnemy_FreeKey: ["STR_TBL_GUI_READY_OBSERVER_LIMIT3", "Visualizar time adversário"],
  rrObserverEnemyHP_FreeKey: ["STR_TBL_GUI_READY_OBSERVER_LIMIT4", "Ver HP do inimigo"],
  rrCreateLimitJoinKey: ["STR_TBL_GUI_READY_LIMIT_JOINING", "Bloquear sala com partida em andamento?"],
  rrCreateLimitJoinYesKey: ["STR_TBL_GUI_READY_BEING", "Sim"], rrCreateLimitJoinNoKey: ["STR_TBL_GUI_READY_NONE", "Não"],
  rrCreateTeamBalanceKey: ["STR_TBL_GUI_READY_TEAM_BALANCE", "Balancear time"],
  rrCreateTeamBalanceNoKey: ["STR_TBL_GUI_READY_TEAM_BALANCE_OFF", "Desativar"], rrCreateTeamBalanceYesKey: ["STR_TBL_GUI_READY_TEAM_BALANCE_SKILLED", "Rank"],
  rrCreateTeamBalanceYesKey2: ["STR_TBL_GUI_READY_TEAM_BALANCE_PERSON", "Qtde"],
  // [INFERIDO] the exe never sets text on rrLobbyRandomMapButton (0x82acfc bind, 0x8387e0 / 0x838830 enable only): the
  // original shows a blank button; labelled with the popup's own key by user choice (2026-10-13)
  rrLobbyRandomMapButton: ["STR_POPUP_RANDOMMAP", "Mapa aleatório"],
  lbCreateConfirm: ["STR_TBL_GUI_LOBBY_CONFIRM_TEXT", "Confirmar"], lbCreateCancel: ["STR_TBL_GUI_LOBBY_CANCEL_TEXT", "Cancelar"],
  // random map popup (CPopupRandomMap init 0x8b0cb8) [INFERIDO: the OK / Cancel keys; the exe shows "Confirmar" / "Cancelar"]
  RandomMapCaption: ["STR_POPUP_RANDOMMAP_CONFIG", "Configurar o mapa"], RandomMapConfirm: ["STBL_IDX_BUTTON_OK", "Confirmar"],
  RandomMapCancel: ["STBL_IDX_BUTTON_CANCEL", "Cancelar"], CheckCountConfirm: ["STBL_IDX_BUTTON_OK", "Confirmar"],
  CheckCountMessage: ["STR_POPUP_RANDOMMAP_CHECK_COUNT", "Selecione pelo menos um mapa."],
  // user info popup (UserInfoPopup 0x8aaca0, UI_Project_Popup; keys from cross-ui-map.json). Adicionar = ADD_FRIEND (0x8ab760)
  UserInfoPopupCaption: ["STR_POPUP_DETAIL_INFO", "Informações"], UserInfoPopupNicknameKey: ["STR_POPUP_NICKNAME", "Apelido"],
  UserInfoPopupSeasonRecordKey: ["STR_POPUP_SEASON_HISTORY", "Histórico da temporada"], UserInfoPopupTotalRecordKey: ["STR_POPUP_TOTAL_HISTORY", "Histórico"],
  UserInfoPopupPositionKey: ["STR_POPUP_CUR_POSITION", "Estado"], UserInfoPopupButton2: ["STR_POPUP_ADD_FRIEND", "Adicionar"],
  UserInfoPopupClose: ["STR_POPUP_CLOSE", "Fechar"],
  // join password (popup 0x8aded0)
  lbJoinCaption: ["STR_TBL_GUI_LOBBY_NOTICE_TEXT", "Aviso"],
  lbSpecialWarCaption: ["STR_TBL_GUI_LOBBY_SPECIAL_WAR_CAPTION", "Seleção de modo"], lbSpecialWarCancel: ["STR_TBL_GUI_LOBBY_CANCEL_TEXT", "Cancelar"],
  lbJoinConfirm: ["STR_TBL_GUI_LOBBY_CONFIRM_TEXT", "Confirmar"], lbJoinCancel: ["STR_TBL_GUI_LOBBY_CANCEL_TEXT", "Cancelar"],
  // message box (CMessageBox::Create 0x75435f / 0x75439d / 0x7543c5)
  cxMsgCaption: ["STBL_IDX_COMMON_MSGBOX_CAPTION", "Aviso"], cxMsgConfirm: ["STBL_IDX_BUTTON_OK", "Confirmar"], cxMsgCancel: ["STBL_IDX_BUTTON_CANCEL", "Cancelar"],
  // ready room (0x7d1f18..0x7d2b2f)
  editObserver: ["STR_TBL_GUI_OBSERVER", "Observador"], // the GM observer box caption (0x7d2d15)
  rrTitleKey: ["STR_TBL_GUI_READY_ROOM_SUBJECT", "Título da sala"], rrPasswordKey: ["STR_TBL_GUI_READY_PASSWORD", "Senha"],
  rrModeKey: ["STR_TBL_GUI_READY_GAME_MODE", "Modo"], rrTypeKey: ["STR_TBL_GUI_READY_VICTORY_CONDITION", "Objetivo"],
  rrTimeKey: ["STR_TBL_GUI_READY_LIMIT_TIME2", "Limite de tempo"],
  rrOptionKey: ["STR_TBL_GUI_READY_HIGHRANK_OPTION", "Opções avançadas"], rrOption: ["STR_TBL_GUI_READYROOM_OPTION", "Opções"],
  // clan match band (CPhaseReadyRoom 0x7d5360 SetText keys 0xbe7d54 / 0xbe7d78 / 0xbe7da4): the same labels as the rows above
  rrClanBattleModeKey: ["STR_TBL_GUI_READY_GAME_MODE", "Modo"], rrClanBattleTypeKey: ["STR_TBL_GUI_READY_VICTORY_CONDITION", "Objetivo"],
  rrClanBattleTimeKey: ["STR_TBL_GUI_READY_LIMIT_TIME2", "Limite de tempo"],
  // Opções avançadas (rrAdvencedWin, UI_Project_ReadyRoom; texts of the exe, cross-ui-map.json)
  rrAdvencedCaption: ["STR_TBL_GUI_READY_HIGHRANK_OPTION", "Opções avançadas"], rrAdvencedConfirm: ["STR_TBL_GUI_READY_CONFIRM", "Confirmar"],
  rrAdvencedCancel: ["STR_TBL_GUI_READY_CANCEL", "Cancelar"], rrLimitKey: ["STR_TBL_GUI_READY_WEAPON_LIMIT", "Restrição de armas"],
  rrLimitPrimaryKey: ["STR_TBL_GUI_READY_PRIMARY_WEAPON", "Arma principal"], rrLimitSecondaryKey: ["STR_TBL_GUI_READY_SECONDRY_WEAPON", "Arma secundária"],
  rrLimitMeleeKey: ["STR_TBL_GUI_READY_MELLE_WEAPON", "Arma branca"], rrLimitThrowKey: ["STR_TBL_GUI_READY_THROW_WEAPON", "Granada"],
  rrLimitRPG7Key: ["STR_TBL_GUI_READY_RPG7_WEAPON", "RPG7"],
  rrLimitJoinKey: ["STR_TBL_GUI_READY_LIMIT_JOINING", "Bloquear sala com partida em andamento?"],
  rrLimitJoinYesKey: ["STR_TBL_GUI_READY_BEING", "Sim"], rrLimitJoinNoKey: ["STR_TBL_GUI_READY_NONE", "Não"],
  rrTeamBalanceKey: ["STR_TBL_GUI_READY_TEAM_BALANCE", "Balancear time"],
  rrTeamBalanceYesKey2: ["STR_TBL_GUI_READY_TEAM_BALANCE_PERSON", "Qtde"], rrTeamBalanceYesKey: ["STR_TBL_GUI_READY_TEAM_BALANCE_SKILLED", "Rank"],
  rrTeamBalanceNoKey: ["STR_TBL_GUI_READY_TEAM_BALANCE_OFF", "Desativar"],
  rrLimitObserverKey: ["STR_TBL_GUI_READY_OBSERVER_LIMIT", "Observador"],
  rrReadyObserver1PV_OnlyKey: ["STR_TBL_GUI_READY_OBSERVER_LIMIT5", "Bloquear 3ª pessoa"], rrReadyObserver3PV_FreeKey: ["STR_TBL_GUI_READY_OBSERVER_LIMIT1", "3ª pessoa livre"],
  rrReadyObserver1PV_FreeKey: ["STR_TBL_GUI_READY_OBSERVER_LIMIT2", "Câmera livre"], rrReadyObserverEnemy_FreeKey: ["STR_TBL_GUI_READY_OBSERVER_LIMIT3", "Visualizar time adversário"],
  rrReadyObserverEnemyHP_FreeKey: ["STR_TBL_GUI_READY_OBSERVER_LIMIT4", "Ver HP do inimigo"],
  // Convidar (rrInvite button, rrInviteWin)
  // rrInvite: "Convidar" is drawn in its sprite (template Invitate, states 0..2 at main_ui_source01 376,176/218/260): no text on top.
  // Its 4th image (376,302) is the "Ajuda" help button art, so the disabled look keeps state 0 (app.ts gui.button off 0)
  rrInviteCaption: ["STR_TBL_GUI_READY_INVITE1", "Convidar"], rrInviteConfirm:["STR_TBL_GUI_READY_INVITE2", "Convidar"], rrInviteCancel: ["STR_TBL_GUI_READY_CANCEL", "Cancelar"],
  // fim de missão na sala (rrCardComplateWin / rrFinalComplate*)
  rrCardComplateCaption: ["STR_TBL_GUI_READY_MISSION_REWARD", "Recompensas de missão"], rrCardComplateConfirm: ["STR_TBL_GUI_READY_CONFIRM", "Confirmar"],
  rrFinalComplateCaption: ["STR_TBL_GUI_READY_NOTICE", "Aviso"], rrFinalComplateConfirm: ["STR_TBL_GUI_READY_CONFIRM", "Confirmar"],
  rrFinalComplateDescription: ["STR_TBL_GUI_READY_NOTICE_REWARD_ITEM1", "{col:255,152,52,255}Parabéns!{/col}\n \nConfira o seu inventário para receber a recompensa. Todos cartões colecionados serão excluídos. (Se for um item que já possui, aumentará seu prazo restante)."],
  rrFinalComplateExCaption: ["STR_TBL_GUI_READY_NOTICE", "Aviso"], rrFinalComplateExConfirm: ["STR_TBL_GUI_READY_CONFIRM", "Confirmar"],
  rrFinalComplateExDescription: ["STR_TBL_GUI_READY_NOTICE_COMPLETE_MISSION", "{col:255,152,52,255}Parabéns!!{/col}\n \nCartões de missões concluídos serão excluídos. As medalhas adquiridas podem ser trocadas por um título."],
  rrFinalComplatePrizeCaption: ["STR_TBL_GUI_READY_NOTICE", "Aviso"], rrFinalComplatePrizeConfirm: ["STR_TBL_GUI_READY_CONFIRM", "Confirmar"],
  rrFinalComplatePrizeDescription: ["STR_TBL_GUI_READY_NOTICE_COMPLETE_MISSION", "{col:255,152,52,255}Parabéns!!{/col}\n \nCartões de missões concluídos serão excluídos. As medalhas adquiridas podem ser trocadas por um título."],
  rrTrainingTimeKey: ["STR_TBL_GUI_READY_LIMIT_TIME2", "Limite de tempo"], rrTrainingEnemyKey: ["STR_TBL_GUI_READY_ENEMY_COUNT", "Inimigos"],
  rrTrainingDifficultyKey: ["STR_TBL_GUI_READY_DIFFICULTY", "Dificuldade"],
  // record window (CPhaseReadyRoom: rrRecordCaption toggled INFO1 / INFO2 at 0x7c9a40, the keys set once by the init)
  rrRecordCaption: ["STR_TBL_GUI_READY_DETAIL_INFO1", "< Informações detalhadas >"],
  rrSeasonKey: ["STR_TBL_GUI_READY_SEASON_BATTLE_HISTORY", "Histórico de combates do período"], rrTotalKey: ["STR_TBL_GUI_READY_TOTAL_BATTLE_HISTORY", "Histórico geral"],
  rrClanKey: ["STR_TBL_GUI_READY_CLAN_BATTLE_HISTORY", "Histórico do clã"], rrClanNameKey: ["STR_TBL_GUI_READY_CLAN_NAME", "Nome do clã:"],
  rrClanRankKey: ["STR_TBL_GUI_READY_CLAN_GRADE", "Nível do clã:"],
  // menu bar (CMenuBar)
  mbPinoKey: ["STR_TBL_GUI_ETC_MENUBAR_POINT", "Gold    :"], mbNcCoinKey: ["STR_TBL_GUI_ETC_MENUBAR_MONEY", "Cash    :"],

  // ---- [INFERIDO]: linked by the exe but no GAME_STRING site found for them (cross-ui-map); text by name ----
  lbServerCaption: ["STR_TBL_GUI_LOBBY_CHANGE_SERVER", "Servidores"], lbEnterCaption: ["STR_TBL_GUI_LOBBY_ENTER_ROOM_TEXT", "Entrar"],
  lbRefreshCaption: ["STR_TBL_GUI_LOBBY_REFRESH_TEXT", "Atualizar"], lbCreateCaption: ["STR_TBL_GUI_LOBBY_CREATE_ROOM_TEXT", "Criar sala"],
  lbJoinMessage: ["STBL_IDX_EP_LOBBY_WRONG_PW_Q", "Digite a senha"],
};

/**
 * lbSpecialWarWin (opened by lbSpecialWar: 0x831520(1) + PlaySound(2)), rows in the exe's order. The init
 * loop 0x82e55b walks 9 rows of 5 members (0x14 bytes from +0x7fc: button, description, title, arrow, Empty), sets the
 * description (+0x800) / title (+0x804) strings of the switch 0x82e5e9 and leaves every row as its Empty art (Empty shown, the
 * other four hidden, 0x82e8e2..0x82ea41). `mode` = the entry of the rows the web serves (their Empty gives way to
 * the row); `name` = the room title of the rows that create the room at once (SetEvent(113)), the others open lbCreateWin on
 * that mode. HeadHunter, Tutorial, Zumbi, Duro de Matar and Caos stay Empty: the server has no such room.
 */
export const SPECIAL_WAR: { ctl: [btn: string, desc: string, title: string, arrow: string]; empty: string; desc: [string, string]; title: [string, string]; mode?: string; name?: [string, string] }[] = [
  // 0x8315a0(0): name TRAINING_ROOM_TITLE, setEnemyAiCount(8), setCurrentDifficultyLevel(1), SetEvent(113)
  { ctl: ["SpecialWarChallengeButton", "lbSpecialWarButtonChallengeDescription", "lbBtnChallengeTitleDesc", "lbArrowChallenge"], empty: "SpecialWarChallengeEmpty",
    desc: ["STR_TBL_GUI_LOBBY_SPECIAL_WAR_AI_BUTTON_DESCRIPTION", "Jogue sozinho ou com amigos contra a IA \nem até 10 etapas emocionantes!"], title: ["STR_TBL_GUI_LOBBY_TRANING_TEXT", "Desafio"],
    mode: "modeBots", name: ["STR_TBL_GUI_LOBBY_TRAINING_ROOM_TITLE", "Partida de treinamento"] },
  // 0x8317e0: special flag 0x80 + lbCreateWin (0x8325a0)
  { ctl: ["SpecialWarShotgunButton", "lbSpecialWarButtonShotgunDescription", "lbBtnShotgunTitleDesc", "lbArrowShotgun"], empty: "SpecialWarShotgunEmpty",
    desc: ["STR_TBL_GUI_LOBBY_SPECIAL_WAR_SHOTGUN_BUTTON_DESCRIPTION", "Um modo de combate usando apenas \narmas Shotgun como principais"], title: ["STR_TBL_GUI_LOBBY_SHOTGUNMODE_TITLE", "Shotgun"], mode: "modeShotgun" },
  // 0x832580: special flag 4 + lbCreateWin
  { ctl: ["SpecialWarSniperButton", "lbSpecialWarButtonSniperDescription", "lbBtnSniperTitleDesc", "lbArrowSniper"], empty: "SpecialWarSniperEmpty",
    desc: ["STR_TBL_GUI_LOBBY_SPECIAL_WAR_SNIPER_BUTTON_DESCRIPTION", "Um modo de combate usando apenas \narmas Sniper como principais"], title: ["STR_TBL_GUI_LOBBY_SNIPERMODE_TITLE", "Modo Sniper"], mode: "modeSniper" },
  // 0x831810: special flag 0x20 + lbCreateWin
  { ctl: ["SpecialWarHeadHunterButton", "lbSpecialWarButtonHeadHunterDescription", "lbBtnHeadHunterTitleDesc", "lbArrowHeadHunter"], empty: "SpecialWarHeadHunterEmpty",
    desc: ["STR_TBL_GUI_LOBBY_SPECIAL_WAR_HEADHUNTER_BUTTON_DESCRIPTION", "Mire na cabeça do inimigo!"], title: ["STR_TBL_GUI_LOBBY_HEADHUNTERMODE_TITLE", "HeadHunter"], mode: "modeHeadHunter" },
  // 0x831860: name KNUCKLEMODE_ROOM_TITLE, SetEvent(113)
  { ctl: ["SpecialWarKnuckleButton", "lbSpecialWarButtonKnuckleDescription", "lbBtnKnuckleTitleDesc", "lbArrowKnuckle"], empty: "SpecialWarKnuckleEmpty",
    desc: ["STR_TBL_GUI_LOBBY_SPECIAL_WAR_KNUCKLE_BUTTON_DESCRIPTION", "Venha participar do verdadeiro clube da luta."], title: ["STR_TBL_GUI_LOBBY_KNUCKLEMODE_TITLE", "Modo Porrada"],
    mode: "modeKnife", name: ["STR_TBL_GUI_LOBBY_KNUCKLEMODE_ROOM_TITLE", "Clube da Luta"] },
  { ctl: ["SpecialWarTutorialButton", "lbSpecialWarButtonTutorialDescription", "lbBtnTutorialTitleDesc", "lbArrowTutorial"], empty: "SpecialWarTutorialEmpty",
    desc: ["STR_TBL_GUI_LOBBY_SPECIAL_WAR_TUTORIAL_BUTTON_DESCRIPTION", "Guia Iniciante"], title: ["STR_TBL_GUI_LOBBY_TUTORIALMODE_TITLE", "Tutorial"] },
  { ctl: ["lbSpecialWarButtonMadness", "lbSpecialWarButtonMadnessDescription", "lbBtnMadnessTitleDesc", "lbArrowMadness"], empty: "SpecialWarMadneeEmpty",
    desc: ["STR_TBL_GUI_LOBBY_MADNESS_DESCRIPTION", "Partida contra os Infectados"], title: ["STR_TBL_GUI_LOBBY_MADNESS_TEXT", "Modo Zumbi"] },
  { ctl: ["lbSpecialWarButtonDieHard", "lbSpecialWarButtonDieHardDescription", "lbBtnDiehardTitleDesc", "lbArrowDieHard"], empty: "SpecialWarDiehardEmpty",
    desc: ["STR_TBL_GUI_LOBBY_TRANING2_DESCRIPTION", "Partida contra IA"], title: ["STR_TBL_GUI_LOBBY_TRANING2_TEXT", "Duro de Matar"] },
  { ctl: ["SpecialWarChaosButton", "lbSpecialWarButtonChaosDescription", "lbBtnChaosTitleDesc", "lbArrowChaos"], empty: "SpecialWarChaosEmpty",
    desc: ["STR_TBL_GUI_LOBBY_SPECIAL_WAR_CHAOS_BUTTON_DESCRIPTION", "Dificuldade Extrema!"], title: ["STR_TBL_GUI_LOBBY_CHAOS_TITLE", "Caos"], mode: "modeChaos" },
];

/** room list header -> sort key of the controller (hit); ev6 of each caption sorts (0x833c70..0x833e50). */
export const SORT_COLUMN: Record<string, string> = {
  lbIdxCaption: "idx", lbModeCaption: "mode", lbMapCaption: "stage", lbTitleCaption: "name", lbStateCaption: "state", lbPersonCaption: "member", lbPingCaption: "ping",
};

/** chat tab N -> controller tab, per page (see CROSS_TEXT). The clan tab (lobby 2, ready room 3) is drawn with its text but
 * does nothing: the web has no clan chat. */
export const CHAT_TAB = {
  lb: { 1: "all", 3: "whisper" },
  rr: { 1: "all", 2: "team", 4: "whisper" },
} as const;

/** Cross control -> controller click (placement, control name of the 2017 scenes) */
export const CROSS_CLICK: Record<string, [p: string, c: string]> = {
  // ---- confirmed: case of the control's id in the OnGuiNotify switch (cross-ui-map handler / action) ----
  ssEnter: ["list", "i3UIButtonComposed30"], // CPhaseChannelList::OnConnect 0x823380
  lbServer: ["main", MAIN_BUTTONS.back], // SetEventOnce(2) 0x832ea0
  lbQuickStart: ["roomlist", "btn02"], // SetEventOnce(115) 0x8313b0
  lbRefresh: ["roomlist", "btn03"], // SetEvent(518) + _SortRoomList 0x832e00
  lbCreate: ["roomlist", "btn04"], // 0x8325a0 opens lbCreateWin
  lbEnter: ["roomlist", "btn05"], // 0x832ee0 -> 0x8338d0
  lbCreateConfirm: ["create", "i3UIButtonComposed3_LCR"], // 0x832f30 SetEvent(113)
  lbCreateCancel: ["create", "i3UIButtonComposed30_LCR"], // 0x833820
  rrCreateLimitPrimary: ["hit", "chk:wMain"], // id 125, exclusive with RPG7
  rrCreateLimitRPG7: ["hit", "chk:wRpg"], // id 126
  rrCreateTeamBalanceNo: ["hit", "bal:0"], // 0x839260; the keys beside each box: Yes = SKILLED "Rank", Yes2 = PERSON "Qtde"
  rrCreateTeamBalanceYes: ["hit", "bal:2"], // TeamBalance 2 Rank
  rrCreateTeamBalanceYes2: ["hit", "bal:1"], // TeamBalance 1 Count
  lbJoinCancel: ["pwd", "i3UIButtonComposed3"], // vfunc +0xe4 (0, 0)
  rrLeave: ["main", MAIN_BUTTONS.back], // SetEventOnce(1) 0x7c9d50
  rrReady: ["team", "btnReady"], // id 775 -> 0x7c9ad0 SetEvent(137)
  rrCancelReady: ["team", "btnReady"],
  rrStart: ["team", "btnStart"],
  rrCancelStart: ["team", "btnStart"],
  mbOption: ["main", MAIN_BUTTONS.options], // CStageReady::TogglePopup 0x81c960
  mbExit: ["main", MAIN_BUTTONS.exit], // 0x81c980 STBL_IDX_EP_GAME_EXIT_NORMAL_QE
  mbInventory: ["main", MAIN_BUTTONS.inventory], // CMenuBar::OnInventory 0x81c720
  mbShop: ["main", MAIN_BUTTONS.shop], // CMenuBar::OnShop 0x81c800
  mbProfile: ["myinfo", "i3UIButton"], // CMenuBar::OnProfile 0x81c630 (the controller's Perfil / Títulos)
  mbClan: ["main", MAIN_BUTTONS.clan], // CMenuBar::OnClan 0x81c550: the controller's openClan (page "clan"; pages/clan.ts draws it)

  // ---- [INFERIDO]: linked with no decoded case (link-only), or the web action stands in for another one ----
  ssRefresh: ["list", "i3UIButtonComposed3"], // SetEvent(16) 0x823490: meaning of the event inferred
  ssPrev: ["main", MAIN_BUTTONS.back],
  lbPasswordCheck: ["hit", "chk:pwd"],
  rrCreateLimitSecondary: ["hit", "chk:wSub"],
  rrCreateLimitThrow: ["hit", "chk:wThrow"],
  rrObserver1PV_Only: ["hit", "chk:obsFirst"],
  rrObserver3PV_Free: ["hit", "chk:obsThird"],
  rrObserver1PV_Free: ["hit", "chk:obsOn"],
  rrObserverEnemy_Free: ["hit", "chk:obsEnemy"],
  rrObserverEnemyHP_Free: ["hit", "chk:obsHp"],
  lbJoinConfirm: ["pwd", "i3UIButtonOK"], // vfunc +0xe4 (1, 0) -> JoinRoomPasswordCallback 0x8394a0: the link is inferred
  cxMsgConfirm: ["popup", "btnOK"],
  cxMsgCancel: ["popup", "btnCancel"],
  // rrOption (0x7cabf0 -> rrAdvencedWin) and rrInvite (0x7ca2b0 -> rrInviteWin): app.ts wireRoom
};

/**
 * Click sounds (files exported from Sound_Interface / Sound_UI, the same packs the 2017 lobby plays: Sound_UI.i3Pack is
 * byte-for-byte the same size in both clients):
 *   - I3GUI_EVENT_DATA of the layout (control word 17 -> event 8 + i3SoundNode): the Confirm / Cancel buttons of the windows
 *   - CMessageBox m_pBtnClickSound[i] (table 0xd62828: 0 Ok, 1 Cancel)
 *   - CGuiNotifyReceiver::PlaySound(GUI_SND 4 = UI_Button_Click_Select, table 0xd617bc) of the room-list headers (0x833cb0)
 * Every other button has neither (silent in the exe).
 */
export const CROSS_SOUND: Record<string, string> = {
  lbCreateConfirm: UI_CLICK_OK, lbCreateCancel: UI_CLICK_CANCEL,
  lbJoinConfirm: UI_CLICK_OK, lbJoinCancel: UI_CLICK_CANCEL,
  cxMsgConfirm: UI_CLICK_OK, cxMsgCancel: UI_CLICK_CANCEL,
  mbClan: UI_CLICK_SELECT,
  lbSpecialWar: UI_POPUP_OPEN, lbSpecialWarCancel: "/assets/sfx/char/UI_PopUp_Close.wav", // PlaySound(2) / (3): 0x827832 / 0x827868
  ...Object.fromEntries(Object.keys(SORT_COLUMN).map((n) => [n, UI_CLICK_SELECT])),
};
/** a pick in the room list: PlaySound(4) in the select case of lbList (0x833a47) */
export const ROOM_SELECT_SOUND = UI_CLICK_SELECT;

/**
 * Rank icon (SetRankImage 0x801aa0): SetUVPositioner(cell 24x24, texture 256x256, shape 22x22) at 0x791430, then
 * SetShapeUVIndex(rank): the Rank statics (lbUserListSlotRank%d, %sRank%d, mbRankMark) draw cell `rank` of
 * interface_level_icon (10 per row).
 */
export const LEVEL_ICON = { cell: 24, tex: 256 } as const;

/** AI level 1..10 -> rrTrainingDifficultyPopup elements (strAll of the map, STR_TBL_GUI_READY_GRADE_J..A) */
export const AI_GRADE_KEYS = ["J", "I", "H", "G", "F", "E", "D", "C", "B", "A"].map((g) => `STR_TBL_GUI_READY_GRADE_${g}`);

/**
 * Map picture: SetMapShape 0x7a73a0, called by the lobby info (0x8369c6), the ready room (0x7cd74a) and the create window
 * (0x838826). The stage's Stage.pef `_UIShapeIndex` (table filled at 0x7a86d0) picks a 166x88 cell of the "Map" texture group
 * (Gui/Interface/UI_Source_MapImage%d.i3i from 1, loaded at 0x7a5f73): index / 65 = texture when > 0 and the rest is not 0,
 * cell = rest - 1 there; else texture 1 and cell = index. Cells: 3 per row, 1 px gap, from (1, 1) (0x7a5290). A stage with no
 * entry hides the control (0x7a74b6). The random map (create window with rrCheckRandomMap on: 0x5230e0 -> 0x7a75d0) = cell 26.
 */
export const MAP_SHAPE = { w: 166, h: 88, cols: 3, perTex: 65, random: 26, atlas: (n: number) => `interface_ui_source_mapimage${n}` } as const;

/** Cross Stage.pef (Script.i3Pack Config/Stage.pef) Stage/<name>/_UIShapeIndex, the same in every nation slot; key = stage
 * name in lower case (= the pack name of public/assets/maps/index.json). Lobby (-1) and _N/A left out. */
export const STAGE_SHAPE: Record<string, number> = {
  airport: 48, angkorruins: 42, ballistic: 64, battleship: 62, blackmamba: 54, blackpanther: 28, blowcity: 13, breakdown: 6, breedingnest: 29,
  burninghall: 9, c_sandstorm: 36, cargoport: 52, cargoship: 40, construction: 2, construction2: 5, crackdown: 12, dsquad: 11, d_breakdown: 33, d_uptown: 31,
  desertcamp: 25, dinolab: 45, domination1: 4, domination2: 4, domination3: 4, domination4: 4, domination5: 4, domination6: 4, domination7: 4, domination8: 4,
  dominationrandom: 4, downtown: 4, downtown2: 24, dragonalley: 39, easternroad: 17, facerock: 32, fallucity: 68, fatalzone: 73, ghosttown: 43, giran: 8,
  giran2: 8, grandbazaar: 44, hardrock: 56, helispot: 18, hindrance: 66, hospital: 23, hotelcamouflage: 59, housemuseum: 58, kickpoint: 27,
  library: 1, luxville: 10, machupichu: 38, marinewave: 74, merrywhitevillage: 65, metro: 50, nport: 0, nstation: 3, new_library: 70,
  outpost: 14, pumpkinhollow: 61, ramparttown: 63, rothenvillage: 65, rushhour: 51, safari: 37, safari2: 49, safehouse: 53, saintmansion: 16, sandstorm: 36,
  sentrybase: 19, sewerage: 69, shoppingcenter: 30, slumarea: 71, stormtube: 15, supplybase: 35, taipeicitymall: 47, trainingcamp: 22, tutorial: 34, twotowers: 41,
  under23: 46, uptown: 7, watercomplex: 60, weststation: 55,
};

/**
 * Mode tag over the map picture (lb / rr / rrCreate ImageDummy2, 11 shapes of interface_ui_source_mapmode: 0 Destruição,
 * 1 Supressão, 2 Deathmatch, 3 Sabotagem, 4 Desafio, 5 Especial, 6 DEFENCE, 7 SUDDEN DEATH, 8..10 blank). The exe picks it by
 * stage type (STAGE_ID >> 24, switch 0x8373bc: 1 -> 2, 2 -> 0, 3 -> 3, 4 -> 1, 5 -> 6, 6 -> 7, 7 -> 5); an AI training room
 * (0x4c29b0 in the room, special byte 6 in the lobby) gets 4. The 2017 server has no Cross stage type: roomType 8 (Bomb
 * Mission) = type 2 and the rest = type 1 (Deathmatch) [INFERIDO].
 */
export const modeTag = (ai: boolean, roomType: number): number => (ai ? 4 : roomType === 8 ? 0 : 2);

/**
 * Info-panel mode = roomType / 4 (C# GetClientMode, the same value as STAGE_ID >> 24 that 0x6e0730 returns for the room row;
 * BattleRoyale 11 is its own mode). Confirmed by the mode tag switch 0x8373bc and the names: 2 Destruição, 3 Sabotagem,
 * 4 Supressão, 6 Defence / 1 Deathmatch. Clock "%02d:%02d" (room add block +0x23, 0x836ff9) in (0x836fd3); every other
 * mode shows CURRENT_ROUND_COUNT (+0x22, 0x83703f). Win line (0x836df2, switch on mode - 2): -> rounds text (0x790400),
 * 7 -> mode title STBL_IDX_MODE_TYPE1 (0x790630, text not decoded here), the rest -> kills (0x790330).
 */
export const infoMode = (roomType: number): number => (roomType === 11 ? 11 : Math.trunc(roomType / 4));
export const CLOCK_MODES: readonly number[] = [1, 8, 13];
export const ROUND_WIN_MODES: readonly number[] = [2, 3, 4, 5, 6, 9];

/** ready-room slot PC-cafe icon (%sPc%d, 4 shapes) by record byte +15, switch 0x7d05a0: 1 -> 0, 2 -> 1, 3 -> 2, 5..7 -> 3, else none */
export const PC_CAFE_SHAPE: Record<number, number> = { 1: 0, 2: 1, 3: 2, 5: 3, 6: 3, 7: 3 };

/** rrRecordWin slide (0x7d5db0): y 436 shown / 686 folded, 250 px in 0.25 s (dt * 4); the room opens it shown (0x7d5ed0) */
export const RECORD_WIN = { shownY: 436, foldedY: 686, slideS: 0.25 } as const;

/**
 * Load gauge (0x791470): pct = clamp(trunc(players / max * 100), 0, 100) (max <= 0 -> 1; 0 / 0 -> state 0), then the first
 * level T[i] with pct <= T[i] gives state S[i], S = {0, 1, 2, 3, 5, 4} (0xbdc600); none -> 4. One shape lit (SetAllShapeEnable(0)
 * + the state's shape, 0x823bda): 0..3 = 1..4 bars, 5 = 5 bars, 4 = FULL (FULL also disables the row, 0x823c67). T = the
 * Brazil column of the registry keys in Script.i3Pack: GaugeLevelChannelList (0x7915a0, config +0x494) for the channel list,
 * GaugeLevelServerList (0x791570: 0x4f22a0(cfg) + 0x24 = cfg+0x488) for the server cards. The loader (0x4b2c34) reads every gauge key
 * with the fixed index 1 (`push 1` before the key, getter 0xdb4948; same in 0x4b2d48 / 0x4b2e5c): the exe never picks the column by
 * nation here. "Brazil" = index 1 is the name in [INFERIDO: the Script column order not checked in the i3Pack]
 */
export const GAUGE_LEVELS = { channel: [32, 55, 74, 89, 98, 100], server: [32, 55, 74, 89, 93, 100] } as const;
const GAUGE_STATES = [0, 1, 2, 3, 5, 4];
export function gaugeState(players: number, max: number, levels: readonly number[]): number {
  if (players === 0 && max === 0) return 0;
  const pct = Math.max(0, Math.min(100, Math.trunc((players / (max > 0 ? max : 1)) * 100)));
  const i = levels.findIndex((t) => pct <= t);
  return i < 0 ? 4 : GAUGE_STATES[i];
}

/** mbAnnounce flow (CMenuBar::OnUpdate 0x81c4f0 -> 0x81d700): from x = view width it moves left 60 px/s (0xbb3110) until
 * x < -text width, then starts again from the right; a new text restarts it (0x81cd70) */
export const ANNOUNCE_SPEED = 60;

/** cumulative exp per rank, hardcoded at 0xbec0e8 (_GetExpMax 0x81d400), 52 entries */
export const RANK_EXP = [
  0, 2000, 5000, 9000, 14000, 21000, 30000, 41000, 55000, 71000, 89000, 110000, 134000, 161000, 191000, 224000, 260000, 301000,
  347000, 398000, 454000, 516000, 584000, 658000, 738000, 824000, 917000, 1017000, 1124000, 1238000, 1359000, 1510000, 1691000,
  1902000, 2143000, 2414000, 2725000, 3076000, 3467000, 3898000, 4369000, 4890000, 5461000, 6082000, 6753000, 7474000, 8255000,
  9106000, 10037000, 11058000, 12179000, 100000000,
];

/**
 * Menu-bar exp (0x81cdc0, 0x81cecb..0x81d2f8): cur = max(0, exp - T[rank]), need = T[rank + 1] - T[rank], pct = need ?
 * cur * 100 / need : 100 (0..100). mbExp: rank < 45 "%d/%d (%d%%)" cur / need / pct, 45..50 "%d (100%%)" total exp, 51
 * CUMULATIVE_EXP + total. A rank-up note (rank 51 HERO, 50 NEEDED5, 45..49 by exp >= T[50] NEEDED3, T[49] NEEDED6, T[48]
 * NEEDED1, T[47] NEEDED4, T[46] NEEDED2) goes to mbExpText and hides the bar; else mbExpGage lights min(20, pct / 5) of its
 * 20 shapes (0x81d460); ranks 45.. keep pct 100 (full gauge).
 */
export function expBar(exp: number, rank: number): { text: string; note: [string, string] | null; shapes: number } {
  const T = RANK_EXP, r = Math.max(0, Math.min(51, rank));
  const need = (T[r + 1] ?? T[r]) - T[r];
  const pct = r >= 45 ? 100 : Math.max(0, Math.min(100, need ? Math.trunc((Math.max(0, exp - T[r]) * 100) / need) : 100));
  const text = r < 45 ? `${Math.max(0, exp - T[r])}/${need} (${pct}%)` : r < 51 ? `${exp} (100%)` : "";
  const note = (k: string): [string, string] => [`STR_TBL_GUI_ETC_MENUBAR_RANKUP_${k}`, k];
  const n = r === 51 ? note("HERO") : r === 50 ? note("NEEDED5") : r >= 45
    ? exp >= T[50] ? note("NEEDED3") : exp >= T[49] ? note("NEEDED6") : exp >= T[48] ? note("NEEDED1") : exp >= T[47] ? note("NEEDED4") : exp >= T[46] ? note("NEEDED2") : null
    : null;
  return { text, note: n, shapes: pct >= 100 ? 20 : Math.trunc(pct / 5) };
}

/**
 * Room-list Modo column (lbSlotMode%d, 0x835800..0x835c8c): by the room's special byte +0x25 the mode titles (training
 * STR_TBL_GUI_LOBBY_TRANING_TEXT 0xc041d0, sniper 0xc041f8, shotgun 0xc04224, knuckle 0xc04250, ...), else 0x7f4900 -> switch on
 * the stage type (0x6e0750, table 0x7f4c4c): 1 TEAM_DEATH_MATCH, 2 EXPLOSION, 3 DESTROY, 4 ANNIHILATION ... (STR_HEADER_MODE_*).
 * Key = text of the web room.
 */
export const LIST_MODE: Record<string, [string, string]> = {
  deathmatch: ["STR_HEADER_MODE_TEAM_DEATH_MATCH", "Deathmatch"], modeBomb: ["STR_HEADER_MODE_EXPLOSION", "Destruição"],
  modeDestroy: ["STR_HEADER_MODE_DESTROY", "Sabotagem"], modeDefence: ["STR_HEADER_MODE_DEFENCE", "Defesa"],
  modeBots: ["STR_TBL_GUI_LOBBY_TRANING_TEXT", "Desafio"], modeSniper: ["STR_TBL_GUI_LOBBY_SNIPERMODE_TITLE", "Modo Sniper"],
  modeShotgun: ["STR_TBL_GUI_LOBBY_SHOTGUNMODE_TITLE", "Shotgun"], modeKnife: ["STR_TBL_GUI_LOBBY_KNUCKLEMODE_TITLE", "Modo Porrada"],
  modeAnnihilation: ["STR_HEADER_MODE_ANNIHILATION", "Supressão"], modeAce: ["STR_HEADER_DO_TCH_DN_ACE_ATTACKER", "Ace Attacker"], // Ace [INFERIDO]
};

/**
 * Server cards (CPhaseServerList, ssServerListWin of Ready_PhaseServerList.gui; link 0x81f9b5): 24 ssServerSlot%d cards (4 per
 * row, scrolled by rows of 4: 0x820660) with ssServerSlotText%d "%s %03d" (0x81efb0: type name 0x81ec40 + server number) and
 * the load gauge ssServerSlotUserGage%d (GAUGE_LEVELS.server); card shapes 0 normal, 1 over, 2 selected; text colour #adadad,
 * full #d20000, closed server #646464 + card disabled. Tabs ssServer_Tab0..5 (UpdateServerTab 0x8208d0): the ConfigEx.pef
 * ServerListTab order (Brazil: All, Normal, Normal2, Begin, Clan, Expert, Combination, Championship, Nation), a kind gets a
 * tab only with a server of it (0x69a1a0), at most 6, the rest off; the open tab is drawn in state 3 (setControlState 8,
 * 0x81f1c0); a tab click clears the pick and the scroll (0x8205b0). Enter / double click = TryEnterServer 0x820690 (full ->
 * STBL_IDX_EP_SERVER_USER_FULL_C, stop). TryEnterServer flow (0x820690):
 *  - server type (+0x54, 0x820fb0) == 7 and not the connected server -> STBL_IDX_EP_LOBBY_JOIN_ROOM_Q, yes -> 0x820810.
 *  - 0x820810(idx, type): stores the pick (+0x220 idx, +0x224 type). Other server than the connected one (0x69a590 != 0x69a6b0):
 *    0x69a610 connect, pending phase 0xc through 0x595c90 ([0xd85db4]) and 0x820c40(1). Same server: 0x5133a0(1) (channel window
 *    of the current phase, no phase change). Phase 0xc = PhaseChannelList [INFERIDO: the enum-to-class table 0x79a55c not decoded].
 * Card kind: the card name 0x81ec40 takes the same byte +0x54 (0x81f053). Its switch (arg = byte; 0 no name, 1 / 2 NORMAL, 3 BEGIN,
 * 4 CLAN, 5 EXPERT, 6 COMBINATION, 7 CHAMPIONSHIP, 8 NATIONAL) is the tab order of ServerListTab, but server sends SChannelType
 * (auth/packets.ts writeC(s.type): all 0, training 1, novice 2, public 3, expert 4, clan 5, combination 6, championship 7, nation 8).
 * CONFLICT: 3 / 4 / 5 differ (exe public = BEGIN, expert = CLAN, clan = EXPERT). SERVER_KIND below keeps the meaning map (seed
 * system_servers: Public / Clan); the exe switch is the reference if the server numbers change.
 */
export const SERVER_CARDS = 24, SERVER_CARD_COLS = 4;
export const SERVER_TABS = ["all", "normal", "begin", "clan", "expert", "combination", "championship", "nation"] as const;
export type ServerTab = (typeof SERVER_TABS)[number];
export const SERVER_TAB_TEXT: Record<ServerTab, [string, string]> = {
  all: ["STR_TBL_NETWORK_SERVER_TAB_ALL", "Todos"], normal: ["STR_TBL_NETWORK_SERVER_TAB_NORMAL", "Normal"],
  begin: ["STR_TBL_NETWORK_SERVER_TAB_BEGIN", "Iniciante"], clan: ["STR_TBL_NETWORK_SERVER_TAB_CLAN", "Clã"],
  expert: ["STR_TBL_NETWORK_SERVER_TAB_EXPERT", "Veterano"], combination: ["STR_TBL_NETWORK_SERVER_TAB_COMBINATION", "Combinação"],
  championship: ["STR_TBL_NETWORK_SERVER_TAB_CHAMPIONSHIP", "Campeonato"], nation: ["STR_TBL_NETWORK_SERVER_TAB_NATIONAL", "País"],
};
/** 2017 SChannelType -> Cross kind (tab) and card name */
export const SERVER_KIND: Record<number, { tab: ServerTab; name: [string, string] }> = {
  0: { tab: "normal", name: ["STR_TBL_NETWORK_SERVER_NORMAL", "Servidor Normal"] },
  1: { tab: "normal", name: ["STR_TBL_NETWORK_SERVER_NORMAL", "Servidor Normal"] },
  2: { tab: "begin", name: ["STR_TBL_NETWORK_SERVER_BEGIN", "Servidor Iniciante"] },
  3: { tab: "normal", name: ["STR_TBL_NETWORK_SERVER_NORMAL", "Servidor Normal"] },
  4: { tab: "expert", name: ["STR_TBL_NETWORK_SERVER_EXPERT", "Servidor Veterano"] },
  5: { tab: "clan", name: ["STR_TBL_NETWORK_SERVER_CLAN", "Servidor de Clãs"] },
  6: { tab: "combination", name: ["STR_TBL_NETWORK_SERVER_COMBINATION", "Servidor de Campeonato"] },
  7: { tab: "championship", name: ["STR_TBL_NETWORK_SERVER_CHAMPIONSHIP", "Servidor Combinado"] },
  8: { tab: "nation", name: ["STR_TBL_NETWORK_SERVER_NATIONAL", "Servidor nacional"] },
};
/** card text colours of 0x81efb0 (GUI colour table 0x791000 entries 0 / 15 / 21) */
export const SERVER_CARD_COLOR = { normal: "#adadad", full: "#d20000", closed: "#646464" } as const;
