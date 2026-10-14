// Perfil / Missão tab (UITabProfileMissionCard, PointBlankRe_MyInfomation_MissionCard): mission card rules and texts, no DOM.
// Tables and text builders decoded from the 2017 PointBlank.exe:
//  - task text = the quest class's OnQueryDesc (vtable +0x14, CQuestManager::GetQuestQueryHUDDesc 0x58bf80 passes newline = 1);
//    the class is the task's reqType (factory 0x589790): 1 CQuestBase_Map_Count_Accm_Team 0x99af30, 2 _Weapon_Accm 0x99ba70,
//    3 _Weapon_Cont 0x99c7d0. Quest args: 0 action (MissionType), 1 stage, 2 count, 3 weapon class (Accm_Team: "accumulated"),
//    4 weapon number, 5 progress.
//  - action names: s_szActionName (char[64] x 56 at 0xd5df18, filled by 0x800460; getActionName 0x8000c0) = STR_HEADER_* keys.
//  - weapon class names: WeaponInfoDataBase::GetWeaponClass 0x5fb600 (STBL_IDX_WEAPON_CLASS_*).
//  - card buttons, notices, prize, buttons: UITabProfileMissionCard 0x9552b0 / 0x955050 / 0x9544f0 / 0x954ee0; buy checks 0x955630.
// Texts are the client's own pt-BR strings; set names come from MissionCardFix.dat (missionData.ts).
import { tOr } from "../ui/i18n.ts";
import { cleanLabel } from "../screens/strings.ts";
import { MISSION_SETS, type MissionCardDef, type MissionSetDef, type MissionTaskDef } from "./missionData.ts";
import { CARDS_PER_SET, TASKS_PER_CARD, cardDone, taskDone, type MissionSlotState, type MissionState } from "../../net/missionClient.ts";

export const missionSet = (id: number): MissionSetDef | undefined => MISSION_SETS.find((s) => s.id === id);
export const EVENT_SET = 13;
export const TUTORIAL_SET = 1;
/** "Missão disponível n / 3" (0x9543f0: "%d / 3"); the server's 4th slot holds the event set */
export const MAX_BOUGHT_SETS = 3;

const S = (key: string, fb: string): string => cleanLabel(tOr(key, fb));
/** a text piece the exe concatenates as is: only the {col} markup goes (cleanLabel would trim the separating spaces) */
const R = (key: string, fb: string): string => tOr(key, fb).replace(/\{col:[^}]*\}|\{\/col\}/g, "");

/** ACTION_ID (= server MissionType) -> STR_HEADER_* (exe 0x800460, in table order) */
export const ACTION_KEYS: readonly string[] = [
  "NO_CONDITION", "ACTIVE_BOMB", "DISAM_BOMB", "HIT_RATE_HEAD_20", "HIT_RATE_HEAD_30", "HIT_CHEST_20", "HIT_CHEST_30", "HIT_ARM_20",
  "HIT_ARM_30", "HIT_LEG_20", "HIT_LEG_30", "DO_ENTERANCE", "STAGE_INTERCEPT", "DO_WIN", "DO_DEFEAT", "DO_KILL", "DO_DEATH",
  "DO_KILL_SELF", "DO_OUT", "DO_RANK_1", "DO_RANK_2", "DO_RANK_3", "DO_RANK_4", "DO_RANK_5", "DO_RANK_6", "DO_RANK_7",
  "DO_RANK_WORST", "DO_HEADSHOT", "DO_DOUBLE_KILL", "DO_PIERCING", "DO_TRIPLE_KILL", "DO_MASS_KILL", "HIT_RATE_40", "HIT_RATE_50",
  "HIT_RATE_60", "KILL_RATE_40", "KILL_RATE_50", "KILL_RATE_60", "HELMET_PROTECTION", "DO_DESTROY_ENEMY", "DO_KILL_ENEMY",
  "_DO_DOUBLE_KILL", "DO_TRIPLE_KILL_ENEMY", "DO_USE", "DO_CHAINKILLER", "DO_CHAINSLUGGER", "DO_CHAINSTOPPER", "DO_CHAINHEADSHOT",
  "DO_PROTECT_OBJECT", "DO_DEATHBLOW", "DO_TCH_DN", "DO_TCH_DN_ACE_ATTACKER", "DO_TCH_DN_HATTRICK", "DO_TCH_DN_GAME_MAKER",
  "DO_KILL_ASSIST", "DO_KILL_MAN",
].map((k) => `STR_HEADER_${k}`);
export const actionName = (type: number): string => {
  const k = ACTION_KEYS[type];
  return k ? S(k, "") : "";
};

/** WEAPON_CLASS_TYPE -> STBL_IDX_WEAPON_CLASS_* (exe 0x5fb600 switch; 18 = the dual SMG reads SMG, 26 / 34 ASSAULT, 35 SHOTGUN) */
const CLASS_KEYS: Readonly<Record<number, string>> = {
  1: "KNIFE", 2: "HANDGUN", 3: "ASSAULT", 4: "SMG", 5: "SNIPER", 6: "SHOTGUN", 7: "THROWING", 8: "ITEM", 9: "MISSION", 10: "MG",
  11: "GRENADESHELL", 12: "BOMBTRIGGER", 13: "CIC", 14: "DUALHANDGUN", 15: "DUALKNIFE", 16: "ROCKET_LAUNCHER", 17: "OBJECT_GUN", 18: "SMG",
  19: "DINO", 23: "KNUCKLE", 26: "ASSAULT", 34: "ASSAULT", 35: "SHOTGUN",
};
export const weaponClassName = (cls: number): string => S(`STBL_IDX_WEAPON_CLASS_${CLASS_KEYS[cls] ?? "UNKNOWN"}`, "DESCONHECIDO");
/** slot digit of the 6-digit item ids by weapon class (itemNames: 1xx primaries, 2 handguns, 3 melee, 4 throwing, 5 items) */
const CLASS_SLOT: Readonly<Record<number, number>> = { 1: 3, 2: 2, 7: 4, 8: 5, 13: 2, 14: 2, 15: 3, 23: 3 };
/** class / number -> item id (slot * 100000 + class * 1000 + number; the exe asks its weapon table, 0x5f9940) */
export const weaponItemId = (cls: number, num: number): number => (CLASS_SLOT[cls] ?? 1) * 100000 + cls * 1000 + num;

export interface TaskTextOpts {
  /** item name of an item id ("" = unknown) */
  nameOf: (itemId: number) => string;
  /** display name of a quest stage ordinal: getStageDisplayName after the ordinal -> STAGE_ID step (0x9c6df0), not decoded;
   * no 2017 BR card uses a stage (every task has map 0) [INFERIDO] */
  stageName?: (ord: number) => string;
}

/** "(Rifle) " / "(K-400) " / "(Unknown) " of the weapon classes (0x99bcb9: the class, overwritten by the weapon when arg4 != 0) */
function weaponPart(t: MissionTaskDef, o: TaskTextOpts): string {
  const [, , , , cls, num] = t;
  if (!cls) return "";
  if (!num) return `(${weaponClassName(cls)}) `;
  return `(${o.nameOf(weaponItemId(cls, num)) || "Unknown"}) `;
}

/** progress line: STR_TBL_QUEST_*_ETC9 / ETC12 "{col:..} %d/%dvezes{/col}" (the colour, 0x589360, is dropped like every lobby {col}) */
function countLine(key: string, progress: number, limit: number): string {
  return R(key, " %d/%dvezes").replace("%d", String(progress)).replace("%d", String(limit));
}

/** text of one task with `progress` done: the quest class's OnQueryDesc for a non-Korean code page (no 0x3b5 branch) */
export function taskText(t: MissionTaskDef, progress: number, o: TaskTextOpts): string {
  const [req, type, map, limit, cls] = t;
  const stage = map ? (o.stageName?.(map) ?? "") : "";
  const action = actionName(type);
  const classKill = type >= 40 && type <= 42; // KILL_WEAPONCLASS, DOUBLE_ / TRIPLE_KILL_WEAPONCLASS
  if (req === 1) {
    // Accm_Team 0x99af30 (Cross 0x98ef50): "(Cumulativa) " (arg3 != 0) / "(Em 1 Round) ", stage name, action
    const head = cls ? R("STR_TBL_QUEST_ACCM_TEAM_ETC11", "(Cumulativa) ") : R("STR_TBL_QUEST_ACCM_TEAM_ETC10", "(Em 1 Round) ");
    return `${head}${stage}${action}\n${countLine("STR_TBL_QUEST_ACCM_TEAM_ETC9", progress, limit)}`;
  }
  if (req === 3) {
    // Weapon_Cont 0x99c7d0 (Cross 0x990800, ETC6 + action with no space between): "(Em 1 Round) ", "para %s " (STAGE_ENTER / INTERCEPT) / "no %s ", weapon, "Está em uso" for the class kills, action
    const loc = stage ? R(type === 11 || type === 12 ? "STR_TBL_QUEST_WEAPON_COUNT_ETC15" : "STR_TBL_QUEST_WEAPON_COUNT_ETC14", "%s ").replace("%s", stage) : "";
    const use = classKill ? R("STR_TBL_QUEST_WEAPON_COUNT_ETC6", "Está em uso") : "";
    return `${R("STR_TBL_QUEST_WEAPON_COUNT_ETC13", "(Em 1 Round) ")}${loc}${weaponPart(t, o)}${use}${action}\n${countLine("STR_TBL_QUEST_WEAPON_COUNT_ETC12", progress, limit)}`;
  }
  // Weapon_Accm 0x99ba70 (reqType 2 and anything else): "(Cumulativa) ", stage name, weapon, "Usar e " for the class kills, " ", action.
  // Cross 0x98fa90 builds it the same way: strcat ETC13 (Cross ""), the stage name, "(%s) " of the class / weapon, ETC6 (Cross "Usar e",
  // no trailing space) for 40..42, the literal " " (0xc69bdc), the action, a newline when asked (0xc69be0), then ETC12. So a task with no
  // stage / weapon starts with that space (" Entre!") and a weapon task has two ("(Rifle)  Conseguir Kill"): the exe draws them too.
  const use = classKill ? R("STR_TBL_QUEST_WEAPON_ACCM_ETC6", "Usar e ") : "";
  return `${R("STR_TBL_QUEST_WEAPON_ACCM_ETC13", "(Cumulativa) ")}${stage}${weaponPart(t, o)}${use} ${action}\n${countLine("STR_TBL_QUEST_WEAPON_ACCM_ETC12", progress, limit)}`;
}

// ------------------------------------------------------------------------------------------------ state helpers

/** slot holding set `setId` (-1 = not owned) */
export const slotOfSet = (st: MissionState, setId: number): number => st.slots.findIndex((s) => s.setId === setId && setId > 0);
/** "Missão disponível": owned sets except the event one (the exe counts the card-set items it finds, 0x9543f0) [INFERIDO] */
export const boughtCount = (st: MissionState): number => st.slots.filter((s) => s.setId > 0 && s.setId !== EVENT_SET).length;
export const possibleText = (st: MissionState): string => `${boughtCount(st)} / ${MAX_BOUGHT_SETS}`;

/** progress shown for a task: the limit once its flag is set, else the live 2359 count (0 before any) */
export function taskProgress(st: MissionState, slot: number, card: number, task: number, limit: number): number {
  const s = st.slots[slot];
  if (!s) return 0;
  if (taskDone(s, card, task)) return limit;
  return Math.min(limit, st.counts[slot]?.get(card * TASKS_PER_CARD + task) ?? 0);
}

/** card button alpha (0x9552b0): done 255, open 165 (the tutorial set opens card by card), locked / not owned 51 */
export function cardAlpha(set: MissionSetDef, s: MissionSlotState | undefined, card: number): number {
  if (!s || s.setId !== set.id) return 51;
  if (cardDone(s, card)) return 255;
  if (set.id === TUTORIAL_SET) return card === 0 || cardDone(s, card - 1) ? 165 : 51;
  return 165;
}
/** a card the player can make active (0x953d30 -> CCardSet 0x58c5d0, read as: the tutorial needs the previous card done) [INFERIDO] */
export const cardSelectable = (set: MissionSetDef, s: MissionSlotState | undefined, card: number): boolean =>
  card >= 0 && card < CARDS_PER_SET && cardAlpha(set, s, card) > 51;

/** list colour of a set (Lua AddElement: 255,211,3 / 155,155,155 / 255,255,255); state 0 owned, 1 tutorial not owned, 2 other (0x954bb0) */
export function setListState(st: MissionState, setId: number): 0 | 1 | 2 {
  if (slotOfSet(st, setId) >= 0) return 0;
  return setId >= 1 && setId <= 3 ? 1 : 2;
}

/** badge kind of a card prize (0x7e1980): 1-50 ribbon 0, 51-100 ensign 1, 101-116 medal 2, 117-239 master 3, else -1 = none.
 * Also the shape of ButtonImageSet_Medal_Icon_hs (SetBadgeType). */
export function badgeType(badge: number): -1 | 0 | 1 | 2 | 3 {
  if (badge >= 1 && badge <= 50) return 0;
  if (badge >= 51 && badge <= 100) return 1;
  if (badge >= 101 && badge <= 116) return 2;
  if (badge >= 117 && badge < 240) return 3;
  return -1;
}
/** prize name of a badge kind (UpdatePrize 0x9544f0: RIBBON / ENSIGN / MEDALS / MEDALS _TEXT2) */
export function badgeName(type: number): string {
  if (type === 0) return S("STR_TBL_PROFILE_RIBBON_TEXT2", "Broche");
  if (type === 1) return S("STR_TBL_PROFILE_ENSIGN_TEXT2", "Insígnia");
  if (type === 2 || type === 3) return S("STR_TBL_PROFILE_MEDALS_TEXT2", "Medalha");
  return "";
}

/** reason the client refuses the purchase before sending 2364 (null = send): CardBuy 0x955cf0 (rank 0x955630, duplicate),
 * the 3-set cap (the exe leaves it to the server's 0x8000104E; server has 4 slots, so the client keeps the original 3) [INFERIDO] */
export type BuyBlock = "rank" | "duplicate" | "limit" | "free";
export function buyBlock(st: MissionState, setId: number, rank: number): BuyBlock | null {
  const set = missionSet(setId);
  if (!set || setId === TUTORIAL_SET || setId === EVENT_SET) return "free";
  if (rankBlock(setId, rank)) return "rank";
  if (slotOfSet(st, setId) >= 0) return "duplicate";
  if (boughtCount(st) >= MAX_BOUGHT_SETS) return "limit";
  return null;
}
/** 0x955630: Commissioned (10) needs rank 5, Company (11) 17, Field (12) 31; the popup key of the refusal */
export function rankBlock(setId: number, rank: number): string | null {
  if (setId === 10 && rank < 5) return "STR_POPUP_MESSAGE_QEUST_ERROR_COMMISSIONED";
  if (setId === 11 && rank < 17) return "STR_POPUP_MESSAGE_QEUST_ERROR_COMPANY";
  if (setId === 12 && rank < 31) return "STR_POPUP_MESSAGE_QEUST_ERROR_FIELD";
  return null;
}

/** popup text of a rankBlock key (the exe shows it in a message box, 0x955630) */
export const rankBlockText = (key: string): string => S(key, "");

/** buttons of the tab (0x954ee0): tutorial / event -> only Info+; others Comprar + Info+, Excluir when owned */
export function buttonState(st: MissionState, setId: number): { info: boolean; buy: boolean; del: boolean } {
  if (!missionSet(setId)) return { info: true, buy: false, del: false };
  if (setId === TUTORIAL_SET || setId === EVENT_SET) return { info: true, buy: false, del: false };
  return { info: true, buy: true, del: slotOfSet(st, setId) >= 0 };
}

// ------------------------------------------------------------------------------------------------ texts

/** set name: MissionCardFix.dat; the event set has none in the BR data -> STR_PROFILE_CARD_EVENT [INFERIDO] */
export const setName = (set: MissionSetDef): string => set.name || S("STR_PROFILE_CARD_EVENT", "Evento");
export const goldText = (n: number): string => `${n} ${S("STBL_IDX_SHOP_MONEY", "Gold")}`;
export const expText = (n: number): string => `${n} EXP`;
/** the card shown in the prize / notices: the active card of an owned set (UpdatePrize / UpdateNotices only describe it) */
export const cardOf = (set: MissionSetDef, card: number): MissionCardDef | undefined => set.cards[card];

/** Complete popup of a 2361 (PBRe_PopUp_missionCard_Complete): the finished card's exp / gold / badge from the data the server pays
 * (MissionCardAwards); a finished set (type 4) adds the set bonus (Quest.pef BonusExp / BonusPoint / BonusBadgeMaster = system_mission_awards)
 * and its items. Line format "+Exp : n" / "+Gold : n" (STR_UI_MISSION_EXP / _POINT; the native SetBasicInfo caller was not decoded) [INFERIDO] */
export function completeInfo(p: { type: number; setId: number; card: number }): { exp: string; point: string; badges: boolean[]; items: number[]; whole: boolean } | null {
  const set = missionSet(p.setId), c = set?.cards[p.card];
  if (!set || !c) return null;
  const whole = p.type === 4, type = badgeType(c.badge);
  const exp = c.exp + (whole ? set.bonusExp : 0), gold = c.gold + (whole ? set.bonusPoint : 0);
  return {
    exp: `${S("STR_UI_MISSION_EXP", "+Exp :")} ${exp}`, point: `${S("STR_UI_MISSION_POINT", "+Gold :")} ${gold}`,
    badges: [type === 0, type === 1, type === 2, whole && set.bonusMaster > 0], items: whole ? set.bonusItems : [], whole,
  };
}

/** Sub-tabs of the Missão tab (i3UIButtonComposed3*_MIM, Lua captions). Which set sits under which button is read from the server's
 * card set list (+0xD68 of the game context) in the exe, which server never sends: grouped here by kind [INFERIDO]. The
 * Realistamento / Dia 1 / Clã buttons have no 2017 BR set and stay hidden. */
export const MISSION_TABS = [
  { btn: "i3UIButtonComposed3_MIM", sets: [1, 5, 6, 7, 8, 9, 10, 11, 12] },
  { btn: "i3UIButtonComposed31_MIM", sets: [2, 3, 14, 15, 16, 17] },
  { btn: "i3UIButtonComposed32_MIM", sets: [EVENT_SET] },
] as const;
/** sets listed under sub-tab `tab`: the event set only while the server gave it (slot) */
export function tabSets(st: MissionState, tab: number): number[] {
  const t = MISSION_TABS[tab] ?? MISSION_TABS[0];
  return t.sets.filter((id) => !!missionSet(id) && (id !== EVENT_SET || slotOfSet(st, id) >= 0));
}

export const MS = {
  get tabName() { return S("STR_TBL_PROFILE_CHALLENGE_CARD_TEXT1", "Missões"); },
  get notDetected() { return "Mission card's not detected."; }, // the exe's own empty-list row (0x954d38), not a string table key
  get challenge() { return S("STR_TBL_PROFILE_CHALLENGE_TEXT", "Missão"); },
  get complete() { return S("STR_TBL_PROFILE_COMPLETE_TEXT", "Concluir"); },
  get buyOk() { return S("STR_TBL_GUI_BASE_BUY_CARD", "Cartões de missão comprados com sucesso."); },
  get deleteOk() { return S("STR_TBL_GUI_BASE_DELETE_CARD", "Excluiu pacote de cartão."); },
  get deleteAsk() { return S("STR_TBL_PROFILE_DELETE_CARD_MESSAGE", "Deseja excluir?"); },
  get duplicate() { return S("STR_TBL_PROFILE_CARDSET_DUPLICATE", "Já existe cartão."); },
  get limit() { return S("STR_TBL_GUI_BASE_LIMIT_CARD_COUNT", "O número de cartão de missão está restrito a 3 tipos."); },
  get noPoint() { return S("STR_TBL_GUI_BASE_NO_POINT_TO_GET_ITEM", "Não possúi Gold suficiente."); },
  get noCardInfo() { return S("STR_TBL_GUI_BASE_FAIL_BUY_CARD_BY_NO_CARD_INFO", "Compra não concluída."); },
  get notTutorial() { return S("STR_TBL_GUI_BASE_DID_NOT_TUTORIAL_MISSION_CARD", "Necessário completar baralho de missões tutorial"); },
  get deleteNoInfo() { return S("STR_TBL_GUI_BASE_FAIL_DELETE_CARD_BY_NOT_INFO", "Exclusão falhou."); },
  get deleteNetwork() { return S("STR_TBL_GUI_BASE_FAIL_DELETE_ITEM_BY_NETWORK_PROBLEM", "Não é possível excluir item por problema de rede."); },
  get selectCard() { return S("STR_TBL_PROFILE_PLEASE_SELETE_CARD", "Escolha um cartão para comprar."); },
  get detailTitle() { return S("STR_TBL_PROFILE_CHALLENGE_CARD_INFO", "Informação do cartão de missão"); },
  get cardName() { return S("STR_TBL_PROFILE_COMPENSATE_CARDNAME_TEXT", "Nome de cartão de missão:"); },
  get price() { return S("STR_TBL_PROFILE_CARD_PRICE", "Preço:"); },
  get totalPoint() { return S("STR_TBL_PROFILE_TOTAL_GET_POINT", "Total de Gold adquirido:"); },
  get totalExp() { return S("STR_TBL_PROFILE_TOTAL_GET_EXT", "Total de experiência adquirida:"); },
  get lastPoint() { return S("STR_TBL_PROFILE_LAST_REWARD_POINT1", "Último Gold adquirido"); },
  get lastExp() { return S("STR_TBL_PROFILE_LAST_REWARD_EXT1", "Última EXP adquirida"); },
  get prize() { return S("STR_TBL_PROFILE_PRIZE_NAME", "Prêmio:"); },
  get master() { return S("STR_TBL_PROFILE_MASTER_MEDALS_TEXT", "Ordem Azul"); },
  /** Detail: the Lua binds STR_TBL_PROFILE_LAST_REWARD_ITEM, which pt-BR lacks: STR_TBL_TUTORIAL_RESULT_GET_ITEM [INFERIDO] */
  get lastItem() { return S("STR_TBL_TUTORIAL_RESULT_GET_ITEM", "Item obtido"); },
};
