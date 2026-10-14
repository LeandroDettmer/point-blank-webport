// PT-BR labels of the meta screens, by STBL/STR key of String_Brazil, resolved through src/lobby/ui/i18n.ts
// (public/assets/ui/cross/strings.json). The second value is the same text copied verbatim from the string table, used
// before loadStrings() resolves and in Node. Keys without a known control binding were chosen by hand [INFERIDO] from the
// original design-time caption (e.g. "장비하기" = equip). Colour tags are stripped; `line: true` keeps line breaks.
import { tOr } from "../ui/i18n.ts";

type Entry = readonly [key: string | null, fallback: string, multiline?: boolean];
const K = {
  shop: ["STBL_IDX_SHOP_CAPTION", "Loja"],
  inventory: ["STR_INVEN_INVENTORY", "Inventário"],
  buy: ["STR_SHOP_BUY", "Comprar"],
  equip: ["STR_INVEN_DO_EQUIP", "Equipar"],
  equipped: ["STR_INVEN_EQUIPPED", "Equipado"],
  // no STBL id recovered for this caption (cosmetic-slot clear was never dumped) [RECRIADO]
  unequip: [null, "Desequipar"],
  use: ["STR_INVEN_DO_USE", "Usar"],
  leave: ["STR_POPUP_LEAVE", "Sair"],
  confirm: ["STR_POPUP_OK", "Confirmar"],
  cancel: ["STR_POPUP_CANCEL", "Cancelar"],
  gold: ["STR_SHOP_INFO_POINT", "Gold"],
  cash: ["STR_SHOP_INFO_CASH", "Cash"],
  tag: [null, "TAG"], // design-time caption of StaticText_Money_Title2 (Latin; no BR key found)
  viewAll: ["STR_SHOP_MENU_ALLITEM", "Ver Tudo"],
  tabWeapon: ["STR_SHOP_MENU_NEWHOT_WEAPON", "Arma"],
  tabChara: ["STR_SHOP_MENU_NEWHOT_CHARACTER", "Personagem"],
  tabItem: ["STR_SHOP_MENU_NEWHOT_ITEM", "Item"],
  primary: ["STR_INVEN_PRIMARY_WEAPON", "Arma primária"],
  secondary: ["STR_INVEN_SECONDARY_WEAPON", "Arma secundária"],
  melee: ["STR_INVEN_MELEE_WEAPON", "Arma branca"],
  throwing: ["STR_INVEN_THROWING_WEAPON", "Granada"],
  special: ["STR_INVEN_SPECIAL_WEAPON", "Arma especial"],
  chara: ["STR_INVEN_CHRACTER", "Personagem"],
  head: ["STR_INVEN_HEAD", "Cabeça"],
  mask: ["STR_SHOP_MENU_CHARACTER_MASK", "Máscara"],
  beret: ["STR_INVEN_BERET", "Boina"],
  redChara: ["STR_INVEN_RED_CHARA", "Personagem Rebelde"],
  blueChara: ["STR_INVEN_BLUE_CHARA", "Personagem da OTP"],
  usedEquip: ["STR_INVEN_USED_EQUIP", "Equipamento usado"],
  notUsed: ["STR_INVEN_NOTUSED", "Não usado"],
  unlimited: ["STBL_IDX_ITEM_UNLIMITED", "ilimitado"],
  days: ["STBL_IDX_ITEM_TERM_UNIT", "dias"],
  units: ["STBL_IDX_ITEM_COUNT_UNIT", "und."],
  pcRoom: ["STR_INVEN_ONLY_PC_ROOM", "Apenas para Lan House parceira"],
  startingAuth: ["STR_INVEN_STARTING_AUTH", "Ainda não iniciou uso do item.\nSerá possível utilizar por tempo limitado \na partir do momento de uso.\nDeseja equipar?", true],
  buySuccess: ["STBL_IDX_EP_SHOP_BUY_SUCCESS", "O item foi comprado com sucesso."],
  confirmBuy: ["STR_POPUP_CAPTION_CONFIRM_BUY", "Confirmação da compra"],
  cannotEquip: ["STR_INVEN_CANNOT_EQUIP", "Não é possível equipar "],
  unknownItem: ["STR_SHOP_UNKNOWNITEM", "Item desconhecido"],
  createRoom: ["STR_TBL_GUI_LOBBY_CREATE_ROOM_TEXT", "Criar sala"],
  quickStart: ["STR_TBL_GUI_LOBBY_QUICK_START_TEXT", "Início rápido"],
  enterRoom: ["STR_TBL_GUI_LOBBY_ENTER_ROOM_TEXT", "Entrar"],
  refresh: ["STR_TBL_GUI_LOBBY_REFRESH_TEXT", "Atualizar"],
  userList: ["STR_TBL_GUI_LOBBY_USER_LIST", "Lista de espera"],
  loadingRooms: ["STR_TBL_GUI_LOBBY_NOTICE_LOADING_ROOM_LIST", "Está carregando a lista de salas"],
  // room list header: keys of PointBlankRe_Lobby_RoomList's Lua SetHeader
  colNumber: ["STR_TBL_GUI_SERVER_NUMBER", "Número"],
  colRoomName: ["STR_TBL_GUI_LOBBY_ROOMNAME_TEXT2", "Nome da sala"],
  colMode: ["STR_TBL_GUI_READY_GAME_MODE", "Modo"],
  colStage: ["STR_TBL_PROFILE_STAGE_TEXT", "Estágio"],
  colMember: ["STR_TBL_GUI_LOBBY_PEOPLE_COUNT_TEXT", "Users"],
  colState: ["STR_TBL_GUI_LOBBY_STATE_TEXT", "Status"],
  colPing: ["STR_TBL_GUI_LOBBY_PING_TEXT", "Ping"],
  stateWait: ["STBL_IDX_ROOM_STATE_WAIT", "Em espera"],
  statePlay: ["STBL_IDX_ROOM_STATE_PLAY", "Jogando"],
  modeDeathmatch: ["STR_HEADER_MODE_TEAM_DEATH_MATCH", "Deathmatch"],
  notExistRoom: ["STBL_IDX_EP_LOBBY_NOT_EXIST_ROOM", "Sala inexistente."],
  waitState: ["STR_TBL_GUI_LOBBY_WAIT_STATE_TEXT", "Aguarde..."],
  noPoint: ["STBL_IDX_CLAN_NO_POINT", "Gold insuficiente."],
  noCash: ["STBL_IDX_COUPON_USE_FAIL_REASON_LIMIT_MONEY", "Cash insuficiente."],
  cannotBuyItem: ["STR_SHOP_CANNOT_ITEM_BUYING", "Não é possível comprar este item "],
  buyFail: ["STBL_IDX_EP_SHOP_BUY_FAIL_CAPTION_E", "Falha na compra"],
} as const satisfies Record<string, Entry>;

/** Removes the client's {col:...}{/col} markup; single-line labels also fold line breaks. */
export function cleanLabel(s: string, multiline = false): string {
  const t = s.replace(/\{col:[^}]*\}|\{\/col\}/g, "");
  return multiline ? t.replace(/\\n/g, "\n") : t.replace(/\\n|\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}

/** Hangul never reaches the screen (design-time captions / unresolved bindings). */
export const hasHangul = (s: string): boolean => /[ᄀ-ᇿ㄰-㆏가-힯]/.test(s);

type Labels = { readonly [k in keyof typeof K]: string };
export const S = {} as Labels;
for (const [name, e] of Object.entries(K) as [keyof typeof K, Entry][]) {
  Object.defineProperty(S, name, { enumerable: true, get: () => cleanLabel(e[0] ? tOr(e[0], e[1]) : e[1], e[2] === true) });
}
