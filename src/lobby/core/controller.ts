// PB 2017 lobby flow without DOM: Auth login (account-api token) -> server/channel list -> USER_ENTER -> lobby
// (2588 rooms/players) -> create/join room (the existing src/ui/roomScreen.ts RoomScreen, only called) -> battle
// (boot.ts playBattle via deps.onBattle) -> room -> lobby; inventory (6149/6150) and shop (1029/1045) through // MetaSession. No drawing here: every state change calls deps.render and the Point Blank Cross shell (screensCross/app.ts)
// repaints its i3Gui windows from this state; clicks come back by the original control names (click(placement, control)).
import { AuthClient, gameTargetForServer, type ChannelListInfo, type GameServerInfo, type LoginResult } from "../../net/authClient.ts";
import { GameClient } from "../../net/gameClient.ts";
import type { AuthMeta } from "../../net/metaAuth.ts";
import type { PbBattleNet } from "../../net/battle.ts";
import { RoomOp, WIRE_READY, type RoomClient, type RoomPlayerInfo } from "../../net/roomClient.ts";
import { hideBattleLoading, showBattleLoading } from "../../game/battleLoading.ts";
import { RoomScreen, type RoomScreenHost } from "../../ui/roomScreen.ts";
import type { Rgba } from "../../ui/roomCountdown.ts";
import { UI_CLICK_SELECT, UI_ITEM_EQUIP, UI_SERVER_CONNECT, UI_SERVER_ENTER, playUiSound } from "../../ui/uiClick.ts";
import { respawnEquipFor, respawnWithLoadout } from "../../ui/lobbyScreen.ts";
import { enforceRoomWeapons } from "../../game/respawnSelect.ts";
import { AVAILABLE_MAPS, loadMapIndex, mapFromRoomMapId, mapIndexEntry, type MapId } from "../../config.ts";
import { createMetaSession, type MetaSession } from "../screens/index.ts";
import type { PlayerStore } from "../state/PlayerStore.ts";
import { parseCharaInfo } from "../../net/metaGame.ts";
import { PacketReader } from "../../net/packet.ts";
import { friendLocation } from "../../net/friendClient.ts";
import { chat, splitArgs, ChatType, type ChatLine } from "../../net/chatClient.ts";
import { sendBugReport, setBugContext, setBugOpener, startFpsProbe } from "../../net/bugReport.ts";
import { defaultMenuUi, inventoryData, inventoryItems, isUnequippableSlot, shopData, shopOffers, type MenuUi } from "../screens/model.ts";
import { WIRE_SLOT } from "./slotBadge.ts";
import { S } from "../screens/strings.ts";
import { UI_BASE } from "../ui/assets.ts";
import { loadStrings, tOr } from "../ui/i18n.ts";
import { loadItemNames, itemName } from "../state/itemNames.ts";
import { loadWeaponSupport } from "../state/weaponSupport.ts";
import { loadCharaSupport } from "../state/charaSupport.ts";
import { loadCharaStats } from "../state/charaStats.ts";
import { equipSlotOf } from "../state/itemInfo.ts";
import { GM_KEY, GmPanel } from "../../game/gmPanel.ts";
import { priceIn } from "../state/ShopStore.ts";
import { iconOf, loadIconIndex } from "../screens/icons.ts";
import { setPreviewEquip } from "../screens/preview3d.ts";
import { BuyType, EquipSlot, type InventoryItem } from "../types.ts";
import {
  EMPTY_CHROME, GRID_PAGE, INV_SUBS, INV_TABS, MAIN_BUTTONS, SHOP_SUBS, SHOP_TABS, MAP_ROWS,
  sortRooms, stageName, DEFAULT_ROOM_SORT, type RoomSort,
  CHAT_COLOR, CHAT_TABS, type ChatRow, type ChatTab, type Chrome, type MapChoice, type Page,
} from "./model.ts";
import { T } from "./strings.ts";
import { loadCharaHp } from "../../gameplay/charaHp.ts";
import { TitleClient } from "../../net/titleClient.ts";
import { TREE_NODES } from "./titleData.ts";
import { TS, emptyTitleState, equipBlock, titleSlotOf, getBlock, hasTitle, titleDef } from "./titleLogic.ts";
import { confirmMode, type ProfileData, type ProfileTab } from "./profile.ts";
import { MissionClient, MissionErr, emptyMissionState, type MissionState } from "../../net/missionClient.ts";
import { detailPrize, stepPrize, type MissionPopup } from "./missions.ts";
import { ClanClient, type ClanRoomInvite } from "../../net/clanClient.ts";
import { MISSION_TABS, MS, buyBlock, cardSelectable, completeInfo, missionSet, rankBlock, rankBlockText, slotOfSet, tabSets } from "./missionLogic.ts";
import { ALL_WEAPONS, DEFAULT_PEOPLE, DEFAULT_WATCH, STAGE_PASSWORD, STAGE_RANDOM_MAP, mapPlayerLimit, peopleOptions, WATCH, randomMapIds, randomMapMask, weaponChecksOf, weaponsFlagOf, type WeaponChecks } from "./roomRules.ts";
import { DEFAULT_KILLTIME, DEFENCE_SERVER_MAP_IDS, DESTROY_SERVER_MAP_IDS, KILL_OPTS, ROOM_MODES, TIME_OPTS, conditionText, defaultKillTimeOf, modeIndex, modeLabel, type RoomMode } from "./roomModes.ts";

export interface Lobby2017Deps {
  serverUrl: string;
  /** account-api session (src/ui/accountScreen.ts) */
  username: string;
  token: Uint8Array;
  mac?: Uint8Array;
  render(): void;
  /** room battle went live (boot.ts playBattle) */
  onBattle(net: PbBattleNet, room: RoomClient): void;
  /** Main's Finalizar / lost connection acknowledged */
  onExit(): void;
  /** "Treino com bots (offline)" [RECRIADO]: local match on the chosen map, no server room (boot.ts playLocal).
   * botCount/botSkill come from the bot-room config step (BOT_DIFF_SKILL). */
  onLocalPlay(map: MapId, bots: { botCount: number; botSkill: number }): void;
  /** Opções button: the shell opens the classic Option window (game/classicOptionWindow.ts) */
  onOptions?(): void;
  persistCatalog?: boolean;
}

export { conditionText };

/** Copy of src/ui/roomScreen.ts TDM_SERVER_MAP_IDS (Matches.xml Match Rule=; not exported there). */
export const TDM_SERVER_MAP_IDS = new Set([
  1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 18, 20, 21, 22, 23, 26, 27, 28, 29, 32, 33, 34, 35, 36, 37, 41, 42, 65, 67, 69,
  105, 106, 107, 118, 119, 134, 136, 123, 139,
]);

/** Matches.xml Match Rule="2" (Bomb Mission). */
export const BOMB_SERVER_MAP_IDS = new Set([131, 138, 135, 88, 91, 12, 13, 14, 15, 19, 24, 25, 43, 44, 45, 46, 47, 48, 89, 109, 111, 112, 117]);

/** Maps of the stage selector: exported 2017 maps valid for TDM (or Bomb Mission with `bomb`), deduped by server mapId, M. Station first (as RoomScreen's picker). */
export function stageChoices(bomb = false, universe: ReadonlySet<number> = bomb ? BOMB_SERVER_MAP_IDS : TDM_SERVER_MAP_IDS): MapChoice[] {
  const seen = new Set<number>();
  const out: MapChoice[] = [];
  const ids = AVAILABLE_MAPS.includes("nstation") ? ["nstation", ...AVAILABLE_MAPS.filter((id) => id !== "nstation")] : AVAILABLE_MAPS;
  for (const id of ids) {
    const e = mapIndexEntry(id);
    if (e?.mapId == null || !universe.has(e.mapId) || seen.has(e.mapId)) continue;
    seen.add(e.mapId);
    out.push({ mapId: e.mapId, name: stageName(e.mapId) });
  }
  return out;
}

/** stageChoices of a room mode: the Deathmatch / Bomb list, narrowed to the mode's own rotation (RoomMode.mapIds) when it has one.
 * Destroy has its own list (Matches Mode 3, DESTROY_SERVER_MAP_IDS), Defence its (Matches Mode 5, DEFENCE_SERVER_MAP_IDS). */
export function modeStageChoices(md: RoomMode): MapChoice[] {
  const all = md.destroy ? stageChoices(true, DESTROY_SERVER_MAP_IDS) : md.defence ? stageChoices(true, DEFENCE_SERVER_MAP_IDS) : stageChoices(!!md.rounds);
  return md.mapIds ? all.filter((m) => md.mapIds!.includes(m.mapId)) : all;
}

/** Server mapIds the Cross exe leaves out of the default random list (0xa57cf0 skips a stage whose sub byte, bits 16..23, is 1):
 * Crackdown 0x01010009, SaintMansion 0x0101000a, WestStation 0x01010052, RampartTown 0x0101005d (names -> Matches.xml ids via the map index). */
export const RANDOM_SKIP_MAP_IDS = new Set([9, 10, 41, 70]);

/** Default random-map list of a mode (Cross exe 0x7c0910 -> 0xa57cf0): the mode's maps minus RANDOM_SKIP_MAP_IDS.
 * [INFERIDO] the exe also drops stages with flag 0x400 (0x6e1b40), whose per-stage flags are not decoded. */
export const randomDefaultMaps = (maps: MapChoice[]): MapChoice[] => maps.filter((m) => !RANDOM_SKIP_MAP_IDS.has(m.mapId));

/** Loads what the lobby needs before the first page: strings, item names, weapon / character gates, icon index, map index. */
export async function loadLobbyData(): Promise<void> {
  await Promise.all([
    loadStrings().catch(() => null),
    loadItemNames().catch(() => null),
    loadWeaponSupport(),
    loadCharaSupport(),
    loadIconIndex(),
    loadMapIndex(),
  ]);
}

/** `ai`: the 2017 AI mode was picked (CreatRoom SetAIModeWindow): botCount = AiCount, aiLevel = AiLevel 1..10.
 * botAllies [RECRIADO]: bots added to the player's own team (PB IA room style, Matches.xml Limit=16: up to 8v8,
 * player counted in their team), leader-local only (never sent to the server, see roomClient.ts CreateRoomOptions.ai). */
/** `mode` = index in; `modeList` = the indices offered; `modePick` = the index marked
 * in the ModeSelect window (becomes `mode` on its OK);
 * `edit` = the ready room's "Configurar sala" (OK sends ROOM_CHANGE_ROOMINFO_REQ instead of creating a room). */
type CreateState = {
  name: string; map: MapChoice | null; maps: MapChoice[]; pick: number; top: number; busy: boolean;
  /** open dropdown of the Mais panel (hit id of its field: opt:kills / opt:time / opt:balance / ai:count / ai:allies / ai:level) */
  dd: string | null;
  mode: number; modeList: number[]; killTime: number; edit: boolean; botCount: number; aiLevel: number; botAllies: number;
  /** TeamBalance 0 None / 1 Count / 2 Rank */
  balance: number;
  /** Mais panel rules (roomRules.ts): room password (4 chars) + its checkbox, Restrição de entrada, slot count, weapon checkboxes,
   * observer rules byte, Mapa aleatório (+ the mapIds it may pick and its open configuration window) */
  password: string; passwordOn: boolean; limitEnter: boolean; people: number; weapons: WeaponChecks; watch: number;
  /** settings window: the room already had a password when it was opened (it can't be read back) */
  hadPassword?: boolean;
  randomMap: boolean; randomIds: number[]; rm: { picked: number[]; warn: boolean } | null;
};
/** RoomWeaponsFlag of the window: the mode's preset (special-weapon / AI modes), else the weapon checkboxes */
/** ROOM_JOIN_ACK error -> text [RECRIADO]: the original strings for these codes were not traced (server handleJoinRoom). */
const JOIN_FAIL: Record<number, string> = {
  0x80001003: "A sala está lotada.",
  0x80001004: "A sala não existe mais.",
  0x80001005: "Senha incorreta.",
  0x8000100c: "Você foi expulso desta sala.",
  0x80001013: "Não é possível entrar: a partida já começou e o líder bloqueou a entrada no meio da partida.",
};
/** Users limit of the picked map (Matches.xml Limit; Bomb Mission has its own list); AI rooms are fixed server-side */
const playerLimit = (cr: CreateState): number => mapPlayerLimit(cr.map?.mapId ?? 0, !!ROOM_MODES[cr.mode].rounds);
/** slot count that goes on the wire / on screen: the picked number never exceeds the map's limit */
const peopleOf = (cr: CreateState): number => Math.min(cr.people, playerLimit(cr));
/** special-weapon mode with a primary (sniper / shotgun): pistol + grenade bits follow the checkboxes, the rest is the preset */
const optionalBits = (md: { weaponsFlag: number }): boolean => (md.weaponsFlag & 8) !== 0;
const weaponsFlagFor = (cr: CreateState): number => {
  const md = ROOM_MODES[cr.mode];
  if (md.ai) return md.weaponsFlag;
  if (md.special) return optionalBits(md) ? (md.weaponsFlag & ~5) | (cr.weapons.secondary ? 4 : 0) | (cr.weapons.throw ? 1 : 0) : md.weaponsFlag;
  return weaponsFlagOf({ ...cr.weapons, melee: true }); // knife box is locked on
};
/** stage flag + mask of Mapa aleatório (off when it has no map picked, and in AI rooms) */
const randomFields = (cr: CreateState): { flag: number; randomMaps: Uint8Array } => {
  const on = cr.randomMap && !ROOM_MODES[cr.mode].ai && cr.randomIds.length > 0;
  return { flag: on ? STAGE_RANDOM_MAP : 0, randomMaps: randomMapMask(on ? cr.randomIds : []) };
};
export const isAiCreate = (cr: Pick<CreateState, "mode">): boolean => !!ROOM_MODES[cr.mode]?.ai;
/** The offered modes split like the ModeSelect scene: Normal list vs the special-weapon buttons (indices). */
export const modeGroups = (cr: Pick<CreateState, "modeList">) => ({
  normal: cr.modeList.filter((i) => !ROOM_MODES[i].special), special: cr.modeList.filter((i) => ROOM_MODES[i].special),
});
// AI room enemy count [INFERIDO]: server bot rooms are 8 slots and bots take the other team's slots
// (PROTOCOL_BATTLE_RESPAWN_FOR_AI_REQ slot), so 1..8; the exe's combo item list isn't decoded.
export const AI_COUNT_MAX = 8;
export const AI_LEVEL_MAX = 10;
// Ally bots [RECRIADO]: the player already fills one of the 8 team slots, so up to 7 more (0..7); the total (up to
// 15 bots + the player = 16) matches game.ts's own bot cap (Math.min(15, ...)).
export const AI_ALLY_MAX = 7;
/** AI level -> game.ts Bot skill (0.1-1 accuracy/reaction scalar) [RECRIADO]: the exe's per-level AI table isn't decoded. */
export const aiSkill = (level: number): number => Math.max(0.1, Math.min(1, level / AI_LEVEL_MAX));
/** waits before each reconnect attempt (Lobby2017.reconnect), ~2 min in all: a Cloud Run cold start or redeploy */
/** server -> client: this account is being disconnected (server gmCommands.ts kickAck; also a ban) */
const ACCOUNT_KICK_ACK = 2009;
const SERVER_MESSAGE_ERROR_ACK = 3078;
/** 3078 error that rides with the 2009 of a duplicate login (authServer.ts / gameServer.ts kick: 0x80001000) */
const KICK_DUPLICATE_LOGIN = 0x80001000;
const RECONNECT_DELAYS_MS = [5500, 10000, 20000, 30000, 60000];
/** a lost session reconnects by itself only with player input this recent (server restart, Cloud Run 60 min cap); the server's
 *  idle kick (PB_IDLE_KICK_MIN) closes with "idle" and never reconnects by itself (Lobby2017.lost) */
const RECONNECT_IDLE_MS = 10 * 60000;
type BuyState = { currency: "gold" | "cash"; option: number; busy: boolean };
type Msg = { text: string; onOk?: () => void; onCancel?: () => void };

export class Lobby2017 {
  page: Page = "channels";
  auth: AuthClient | null = null;
  game: GameClient | null = null;
  login: LoginResult | null = null;
  authMeta: AuthMeta | null = null;
  /**
   * Player data before a channel is entered (server / channel pages): the Auth meta (2316/2318/2320/2453) already has
   * the profile, wallet, record and the 2453 loadout (18 equip pairs + characters); the Game session (3082) only
   * exists after enterChannel. Built once, read-only.
   */
  private peekCache: { player: PlayerStore; chara: number; weapon: number; gear: { head: number; face: number; beret: number } } | null | undefined;
  private peek(): { player: PlayerStore; chara: number; weapon: number; gear: { head: number; face: number; beret: number } } | null {
    if (this.peekCache !== undefined) return this.peekCache;
    if (!this.authMeta) return null; // not cached: fetchMeta may still land
    try {
      const player = createMetaSession({ authMeta: this.authMeta, persistCatalog: false }).player;
      // the authMeta reducer keeps only the unsaved characters: parse the 2453 itself (as createMetaSession does)
      const ci = this.authMeta.charaInfoRaw ? parseCharaInfo(new PacketReader(this.authMeta.charaInfoRaw)) : null, u = this.authMeta.userInfo;
      const bySlot = ci?.charas.find((c) => c.slot === u.redSlot)?.itemId;
      const chara = ci?.equip[EquipSlot.Chara]?.itemId || bySlot || ci?.charas[0]?.itemId || 0;
      this.peekCache = { player, chara, weapon: ci?.equip[EquipSlot.Primary]?.itemId ?? 0, gear: { head: ci?.equip[EquipSlot.Head]?.itemId ?? 0, face: ci?.equip[EquipSlot.Face]?.itemId ?? 0, beret: ci?.equip[EquipSlot.Beret]?.itemId ?? 0 } };
    } catch { this.peekCache = null; }
    return this.peekCache;
  }
  session: MetaSession | null = null;
  /** Perfil / Títulos: the Game connection's title state (2383 / 2363 pushes, 2376-2381 requests) and the page's own picks */
  titles: TitleClient | null = null;
  profile: { selected: number; slotSel: number; busy: boolean } = { selected: 0, slotSel: -1, busy: false };
  /** Perfil / Missão: the Game connection's mission cards (2355 / 2359 / 2361 pushes, 2360 / 2364 / 2366 requests), the tab shown and the
   * Missão tab's own picks (sub-tab, set in the list, Comprar / Info+ popup) */
  missions: MissionClient | null = null;
  /** Clã: ClanClient on the Game connection (joinChannel); the Cross shell draws the page (screensCross/pages/clan.ts) */
  clanNet: ClanClient | null = null;
  profileTab: ProfileTab = "designation";
  mission: { tab: number; sel: number; popup: MissionPopup; busy: boolean } = { tab: 0, sel: 0, popup: null, busy: false };
  /** Complete popup of the last finished card / set (2361), shown over any lobby page until OK */
  missionDone: ReturnType<typeof completeInfo> = null;
  roomScreen: RoomScreen | null = null;
  /** "Usar" of a cosmetic use item (name / nick colour / emblem / effect popups) set by the Cross shell (pages/index.ts): true = handled */
  cosmeticUse: ((it: InventoryItem) => boolean) | null = null;
  /** start countdown lock of the ready room (RoomCountdown, exe 0x8f0530), see roomLocked */
  private roomLock = false;
  servers: GameServerInfo[] = [];
  server: GameServerInfo | null = null;
  channels: ChannelListInfo | null = null;
  channelId = 0;
  /** the room in use came from the clan-war pairing (adoptClanRoom): its battle is a clan match (boot.ts isClanMatch) */
  clanPairing = false;
  /** type of the channel the session is in (ChannelType, authClient CHANNEL_TYPE_CLAN); null outside a channel */
  get channelType(): number | null { return this.server?.channelTypes[this.channelId] ?? null; }
  log: string[] = [];
  chSelected = 0;
  roomSel = -1;
  /** Cross: lobby user picked by Buscar (community.ts findFriend, exe 0x885b70); by nick, null = none. app.ts paintLobby shows it */
  lobbyPick: string | null = null;
  /** room list order (header column clicks) */
  roomSort: RoomSort = { ...DEFAULT_ROOM_SORT };
  loadingRooms = true;
  busy = false;
  /** loading screen caption while a long step runs (login, server / channel entry, room join); null = none */
  loading: string | null = null;
  create: CreateState | null = null;
  /** password asked before joining a locked room */
  pwdPrompt: { roomId: number; text: string } | null = null;
  menu: MenuUi = defaultMenuUi();
  menuFrom: "lobby" | "room" = "lobby";
  buy: BuyState | null = null;
  msg: Msg | null = null;
  /** ready room: another player picked in the team list (ROOM_GET_PLAYERINFO 3597); the left panel shows them */
  inspect: RoomPlayerInfo | null = null;
  /** ready room left column: MapInfo scene's two tabs, map info or the character (mine, or `inspect`'s) */
  roomTab: "map" | "chara" = "map";
  /** chat: active tab, lines shown (chat history + this client's own messages, 100) */
  chatTab: ChatTab = "all";
  private lines: ChatLine[] = [];
  private poll: ReturnType<typeof setTimeout> | null = null;
  private offs: (() => void)[] = [];
  private disposed = false;

  readonly deps: Lobby2017Deps;

  constructor(deps: Lobby2017Deps) {
    this.deps = deps;
    setPreviewEquip(() => this.previewEquip());
    startFpsProbe();
    setBugOpener(() => this.openBug());
    // what the bug report says about the room (p2p_role / ping come from the battle shell through sendBugReport's `extra`)
    setBugContext(() => {
      const info = this.roomScreen?.room?.room;
      return { room_id: info?.roomId ?? null, map: info ? stageName(info.mapId) : null, mode: info ? modeLabel(info.rule, info.stage, info.roomType) : null, p2p_role: "none" };
    });
  }

  /** Head / face / beret on the chara preview: the equipped ones, the selected part item (inventory / shop) in its slot. */
  private previewEquip(): { head: number; face: number; beret: number } | undefined {
    const s = this.session;
    if (!s) return this.page === "channels" ? this.peek()?.gear : undefined; // server / channel pages: the 2453 loadout
    const ins = this.page === "room" ? this.inspect : null;
    if (ins) return { head: ins.equip[EquipSlot.Head] ?? 0, face: ins.equip[EquipSlot.Face] ?? 0, beret: ins.equip[EquipSlot.Beret] ?? 0 };
    const eq = s.player.equipPairs();
    const out = { head: eq[EquipSlot.Head]?.itemId ?? 0, face: eq[EquipSlot.Face]?.itemId ?? 0, beret: eq[EquipSlot.Beret]?.itemId ?? 0 };
    const sel = this.menu.selected;
    const id = sel === null ? 0 : this.page === "inventory" ? s.player.state.inventory.get(sel)?.itemId ?? 0 : this.page === "shop" ? sel : 0;
    const slot = id ? equipSlotOf(id) : null;
    if (slot === EquipSlot.Head) out.head = id;
    else if (slot === EquipSlot.Face) out.face = id;
    else if (slot === EquipSlot.Beret) out.beret = id;
    return out;
  }

  get player() { return this.session?.player ?? null; }

  // ------------------------------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    await loadLobbyData();
    this.page = "channels";
    this.busy = true;
    this.loading = T.loadConnect;
    this.say(`${S.waitState} (${this.deps.username})`);
    try {
      await this.loginAuth();
      this.busy = false;
      if (this.servers.length === 1) await this.pickServer(this.servers[0]);
      else { this.loading = null; this.channels = null; this.server = null; this.chSelected = 0; this.draw(); }
    } catch (e) {
      this.busy = false;
      this.fail(e, () => this.deps.onExit());
    }
  }

  /** Auth login with the account-api token, then its meta and the server list (start, reconnect). */
  private async loginAuth(): Promise<void> {
    const auth = (this.auth = new AuthClient(this.deps.serverUrl));
    const res = await auth.connectAndLogin({ token: this.deps.token, mac: this.deps.mac, width: 1024, height: 768 });
    if (!res.ok) throw new Error(`Login recusado: ${res.errorName}`);
    this.login = res;
    try { this.authMeta = await auth.fetchMeta(); } catch (e) { this.authMeta = null; console.warn("[lobby2017] Auth meta failed", e); }
    this.peekCache = undefined; // a reconnect brings a fresh 2316..2453
    this.servers = (await auth.getServers()).filter((s) => s.index > 0);
    auth.conn.onClose = (why) => this.lost(why);
  }

  dispose(): void {
    this.disposed = true;
    this.teardown();
  }

  /** Chat on the Game connection (src/net/chatClient.ts, shared with the battle HUD): lines land in `lines`, /bug opens the popup. */
  private attachChat(game: GameClient): void {
    chat.myNick = this.nick();
    chat.nickOfSlot = (slot) => this.roomScreen?.room?.slots[slot]?.nick ?? "";
    chat.nickColorOfSlot = (slot) => this.roomScreen?.room?.slots[slot]?.nickColor ?? 0;
    chat.attach(game.conn);
    this.offs.push(chat.onLine((l) => this.onChatLine(l)), chat.onBugPopup(() => this.openBug()), chat.onGm(() => this.mountGm()), () => chat.detach());
  }

  /** GM account (the server's GM_MARK line): GM_KEY (F8) opens / closes the GM panel (game/gmPanel.ts) [RECRIADO] */
  private mountGm(): void {
    if (this.disposed || this.gmMounted) return;
    this.gmMounted = true;
    const panel = new GmPanel({
      host: document.body, input: null,
      roster: () => (this.roomScreen?.room?.slots ?? []).filter((x) => x.nick).map((x) => ({ slot: x.slot, nick: x.nick, rank: x.rank })),
      send: (t) => chat.send(ChatType.ALL, t), onLine: (cb) => chat.onLine(cb),
      stealth: { get: () => chat.gmStealth, set: (v) => { chat.gmStealth = v; this.draw(); } },
    });
    const key = (e: KeyboardEvent) => { if (e.code === GM_KEY) { e.preventDefault(); e.stopPropagation(); if (panel.isOpen) panel.close(); else panel.open(); } };
    window.addEventListener("keydown", key, true);
    this.offs.push(() => { window.removeEventListener("keydown", key, true); panel.dispose(); this.gmMounted = false; });
  }
  private gmMounted = false;


  private onChatLine(l: ChatLine): void {
    if (l.kind === "clan") return; // clan lines go to the clan page (ClanClient) and the battle chat, not the lobby log
    this.lines.push(l);
    if (this.lines.length > 100) this.lines.splice(0, this.lines.length - 100);
    if (this.page === "lobby" || this.page === "room") this.draw();
  }

  private teardown(): void {
    this.stopPolling();
    this.roomScreen?.dispose();
    this.roomScreen = null;
    this.clanPairing = false;
    this.offs.forEach((f) => f());
    this.offs = [];
    this.session?.detach();
    this.session = null;
    if (this.auth) this.auth.conn.onClose = null;
    this.auth?.conn.close();
    this.auth = null;
    if (this.game) this.game.conn.onClose = null;
    this.game?.close();
    this.game = null;
  }

  // ------------------------------------------------------------------------------------------ servers / channels

  private async pickServer(s: GameServerInfo): Promise<void> {
    if (!this.auth) return;
    this.busy = true;
    this.loading = T.loadServer;
    this.server = s;
    this.draw();
    const info = await this.auth.getChannels(s.index).catch(() => null);
    const n = info?.channelPlayers.length || s.channelTypes.length || 10;
    this.channels = info ?? { channelPlayers: new Array(n).fill(0), maxPerChannel: 0 };
    this.chSelected = 0;
    this.busy = false;
    this.loading = null;
    this.draw();
  }

  async enterChannel(channelId: number): Promise<void> {
    if (!this.server || !this.login || !this.auth || this.busy) return;
    this.busy = true;
    try {
      await this.joinChannel(this.server, this.login, channelId);
    } catch (e) {
      this.busy = false;
      this.teardown();
      this.fail(e, () => this.deps.onExit());
    }
  }

  /** Auth USER_LEAVE -> Game USER_ENTER on `s` -> channel -> lobby. Throws; the caller tears down. */
  private async joinChannel(s: GameServerInfo, login: LoginResult, channelId: number): Promise<void> {
    this.loading = T.loadMyInfo;
    this.draw();
    if (this.auth) {
      this.auth.conn.onClose = null; // the server closes the Auth session after USER_LEAVE
      await this.auth.leave();
    }
    this.auth = null;
    const game = (this.game = new GameClient(gameTargetForServer(s), this.deps.serverUrl));
    await game.enter(login.username, login.playerId, s.index);
    await game.selectChannel(channelId);
    await game.enterLobby();
    // only now: a close while entering fails the step above (its caller handles it), not a second time through lost()
    game.conn.onClose = (why) => this.lost(why);
    // 2009 = the server kicks this account (GM :player kick / ban): the close that follows must not reconnect by itself
    this.kickedByServer = false; this.kickDuplicate = false;
    this.offs.push(game.conn.on((op, r) => {
      if (op === ACCOUNT_KICK_ACK) this.kickedByServer = true;
      else if (op === SERVER_MESSAGE_ERROR_ACK && this.kickedByServer && r.readD() === KICK_DUPLICATE_LOGIN) this.kickDuplicate = true;
    }));
    this.attachChat(game);
    // the server pushes 2383 / 2363 right after the lobby ack: listen from this tick on
    const titles = (this.titles = new TitleClient(game.conn));
    this.offs.push(titles.subscribe(() => { if (this.page === "profile") this.draw(); }), () => { titles.dispose(); if (this.titles === titles) this.titles = null; });
    // mission cards: the Auth 2317 carried the questing block; 2355 / 2359 / 2361 / 2365 / 2367 keep it current
    const missions = (this.missions = new MissionClient(game.conn));
    missions.seed(this.authMeta?.userInfo.questing);
    this.offs.push(missions.subscribe(() => this.onMissionPush()), () => { missions.dispose(); if (this.missions === missions) this.missions = null; });
    // Clã: the clan pushes (824 / 832 / 845..) reach the clan page at any time, like the missions above
    const clan = (this.clanNet = new ClanClient(game.conn));
    this.offs.push(clan.on((ev) => (ev.type === "room-invite" ? this.onRoomInvite(ev.invite) : undefined)), () => { clan.dispose(); if (this.clanNet === clan) this.clanNet = null; });
    const session = (this.session = createMetaSession({ authMeta: this.authMeta, enterPushes: game.enterPushes, gameConn: game.conn, persistCatalog: this.deps.persistCatalog }));
    this.offs.push(session.player.subscribe("*", () => this.draw()), session.shop.subscribe("*", () => this.draw()),
      session.lobby.subscribe("*", () => { this.loadingRooms = false; if (this.page === "lobby") this.draw(); }));
    this.channelId = channelId;
    this.busy = false;
    this.loading = null;
    this.page = "lobby";
    this.say(`${T.welcome} ${T.server} ${s.index} - ${T.channel} ${channelId + 1}`);
    this.startPolling();
  }

  /** Main's Back in the lobby: new Auth login (the server throttles connects per IP) and the server/channel list. */
  private async changeServer(): Promise<void> {
    this.teardown();
    this.page = "channels";
    this.channels = null;
    this.busy = true;
    this.loading = T.loadConnect;
    this.say(S.waitState);
    await new Promise((r) => setTimeout(r, 5500));
    if (!this.disposed) await this.start();
  }

  /** The Auth (server list) or Game (lobby, room, battle) session closed under us. */
  private lost(why: string): void {
    console.error(`[lobby] connection lost: ${why}`);
    if (this.disposed || this.reconnecting) return;
    if (this.kickedByServer) {
      this.teardown();
      // [RECRIADO] texts (no original string for the kicked side; the new login sees STBL_IDX_EP_LOGIN_ALREADY_LOGIN_Q); OK goes back to the login
      this.fail(new Error(this.kickDuplicate ? "Sua conta foi conectada em outro lugar." : "Você foi desconectado do servidor por um GM."), () => this.deps.onExit());
      return;
    }
    const to = this.session && this.server ? { server: this.server.index, channel: this.channelId, page: this.page } : null;
    this.teardown();
    // the server dropped the session for inactivity (TcpSession.closeIdle, WS close 4000): never reconnect, even with
    // recent page input (mouse moves send no packet); OK goes back to the login, which asks for the account again
    if (why === "idle") { this.fail(new Error("Desconectado por inatividade."), () => this.deps.onExit()); return; } // [RECRIADO] text
    if (Date.now() - this.lastInput < RECONNECT_IDLE_MS) { void this.reconnect(to); return; }
    // idle tab (the server's PB_IDLE_KICK_MIN, or nobody there): a timeout, not a hiccup: no reconnect, OK goes back to the login.
    // "upstream closed" = the server closed the session: an idle timeout there, or the server restarting
    const hint = /upstream closed/i.test(why) ? "\nTempo de conexão esgotado ou servidor reiniciado." : "";
    this.fail(new Error(`Conexão com o servidor de jogo fechada: ${why}${hint}`), () => this.deps.onExit());
  }

  /**
   * Cloud Run closes every WebSocket at 60 min, and on a redeploy / scale-to-zero: log in again
   * with the same account-api token and go back to the server + channel (and inventory / shop page) the player was
   * on. A room or a match is not resumed: the server already dropped the player from it, so they land in the lobby.
   * Not in the original client, which only shows the disconnect popup. Gives up after RECONNECT_DELAYS_MS with
   * the original "could not connect" text, whose OK goes back to the account screen.
   */
  private async reconnect(to: { server: number; channel: number; page: Page } | null): Promise<void> {
    if (this.reconnecting || this.disposed) return;
    this.reconnecting = true;
    try {
      for (const ms of RECONNECT_DELAYS_MS) {
        this.page = "channels";
        this.channels = null;
        this.msg = null;
        this.create = null;
        this.pwdPrompt = null;
        this.inspect = null;
        this.buy = null;
        this.busy = true;
        this.loading = T.loadConnect;
        this.say(S.waitState);
        await new Promise((r) => setTimeout(r, ms)); // > the server's 5 s connect throttle per IP
        if (this.disposed) return;
        try {
          await this.loginAuth();
          const s = to ? this.servers.find((x) => x.index === to.server) : undefined;
          if (s && to) {
            this.server = s;
            await this.joinChannel(s, this.login!, to.channel);
            if (to.page === "inventory" || to.page === "shop") this.openMenu(to.page);
          } else {
            this.busy = false;
            if (this.servers.length === 1) await this.pickServer(this.servers[0]);
            else { this.loading = null; this.server = null; this.chSelected = 0; this.draw(); }
          }
          return;
        } catch (e) {
          console.warn("[lobby] reconnect failed", e);
          this.teardown();
        }
      }
      this.busy = false;
      this.fail(new Error(T.loginNoServer), () => this.deps.onExit());
    } finally {
      this.reconnecting = false;
    }
  }

  /** a key / pointer / wheel event of the page (app.ts): a lost session reconnects by itself only shortly after one */
  touch(): void { this.lastInput = Date.now(); }
  private lastInput = Date.now();
  private reconnecting = false;

  // ------------------------------------------------------------------------------------------ lobby

  startPolling(): void {
    this.stopPolling();
    const gen = ++this.pollGen; // an in-flight tick of an older loop must not reschedule (two loops = requests < 1s apart = server drops them)
    const tick = async () => {
      const g = this.game;
      if (gen !== this.pollGen || !g || !g.conn.isOpen || this.page !== "lobby" || this.roomScreen) return;
      // The server ignores requests < 1s after connect/last request (no reply): short timeout, retry right after it
      const page = await g.getRoomList(1200).catch(() => null);
      if (gen !== this.pollGen || this.game !== g || this.page !== "lobby" || this.roomScreen) return;
      if (page) this.session?.lobby.applyPage(page);
      this.poll = setTimeout(() => void tick(), page ? 1500 : 200);
    };
    // first request: the server throttle counts from the connect (< 1s => dropped)
    this.poll = setTimeout(() => void tick(), 1000);
  }
  private pollGen = 0;
  private stopPolling(): void { this.pollGen++; if (this.poll) clearTimeout(this.poll); this.poll = null; }

  private async openRoom(kind: "create" | "join", roomId = 0, password = ""): Promise<boolean> {
    const game = this.game, session = this.session;
    if (!game || !session || this.roomScreen || this.busy) return false;
    this.busy = true;
    this.loading = T.wait;
    this.stopPolling();
    this.say(S.waitState);
    try {
      // AI room = Rules.xml Mode 16 (DEATHMATCH_AIC): Rule 0, StageOptions 2, Conditions 4 + AiCount/AiLevel.
      const cr = this.create;
      const md = ROOM_MODES[cr?.mode ?? 0];
      const rs = kind === "create"
        ? await RoomScreen.create(game, this.roomHost(), cr?.name.trim() || `sala de ${this.nick()}`, {
          mapId: cr!.map!.mapId, mapName: cr!.map!.name, rule: md.rule, stage: md.stage, roomType: md.roomType, weaponsFlag: weaponsFlagFor(cr!),
          killTime: cr!.killTime, ai: md.ai ? { count: cr!.botCount, level: cr!.aiLevel, allies: cr!.botAllies } : undefined,
          password: cr!.passwordOn ? cr!.password : "", limit: cr!.limitEnter ? 1 : 0, watchRule: cr!.watch, slots: md.ai ? undefined : peopleOf(cr!),
          ...randomFields(cr!),
        })
        : await RoomScreen.join(game, this.roomHost(), roomId, password, chat.isGM && chat.gmStealth);
      respawnWithLoadout(rs.room, session.player);
      // ROOM_CREATE_REQ always ends as TeamBalance.None on the server (PROTOCOL_ROOM_CREATE_REQ.cs forces it):
      // the picked balance goes in right after through ROOM_CHANGE_ROOMINFO_REQ, which keeps it
      if (kind === "create" && cr?.balance && !md.ai) rs.room.changeRoomInfo({ balanceType: cr.balance });
      rs.room.onRoomKicked = () => this.roomKicked(rs);
      this.roomScreen = rs;
      this.create = null;
      this.busy = false;
      this.loading = null;
      this.page = "room";
      this.draw();
      return true;
    } catch (e) {
      this.busy = false;
      this.loading = null;
      if (this.create) this.create.busy = false;
      const joinMsg = kind === "join" ? JOIN_FAIL[(e as { code?: number }).code! >>> 0] : undefined;
      this.say(joinMsg ?? (e instanceof Error ? e.message : String(e)), true);
      this.startPolling();
      return false;
    }
  }

  /** Clan-war pairing (ClanBattle, 6930 push): the server already seated this account in the battle room and sends its join ACK
   *  (3586) right after the push. The wait starts here at once, so that ACK is caught. Opens the room the way openRoom does. The clan
   *  page is left by the page change; its polling is already off. */
  async adoptClanRoom(): Promise<void> {
    const game = this.game, session = this.session;
    if (!game || !session || this.roomScreen) return;
    let rs: RoomScreen;
    try {
      const ack = await game.conn.waitFor(RoomOp.ROOM_JOIN_ACK, 5000);
      rs = RoomScreen.adopt(game, this.roomHost(), ack);
    } catch (e) {
      console.warn("[lobby] clan battle room", e);
      this.say("Não conseguiu entrar na sala da partida do clã.", true);
      return;
    }
    respawnWithLoadout(rs.room, session.player);
    rs.room.onRoomKicked = () => this.roomKicked(rs);
    this.roomScreen = rs;
    this.clanPairing = true;
    this.page = "room";
    this.draw();
  }

  private roomHost(): RoomScreenHost {
    return {
      render: () => { if (this.roomScreen) this.draw(); },
      status: (m, err) => this.say(m, !!err),
      loading: (caption) => this.battleLoading(caption),
      onLeave: () => this.backToLobby(),
      popup: (text) => this.say(text, true),
      onBattle: (net, room) => { this.battleLoading(null, true); this.page = "room"; this.buy = null; this.msg = null; this.inspect = null; this.roomTab = "map"; this.deps.onBattle(net, room); },
      serverUrl: this.deps.serverUrl,
      playerId: this.login!.playerId,
      notice: (text, color) => this.roomNotice(text, color),
      lockRoom: (on) => { this.roomLock = on; this.draw(); },
      subPhase: () => this.page === "inventory" || this.page === "shop" || this.page === "profile",
    };
  }

  /** A start-countdown line of the ready room (RoomCountdown): a system line of the chat box in its {col} colour. The "  "
   * lines around the red lock notice stay, like the exe (0x8f04d0). */
  private roomNotice(text: string, color: Rgba | null): void {
    this.lines.push({ kind: "system", nick: "", gm: false, color: 0, text, time: Date.now(), rgba: color ?? undefined });
    if (this.lines.length > 100) this.lines.splice(0, this.lines.length - 100);
    if (text.trim()) { this.log.push(text); if (this.log.length > 40) this.log.splice(0, this.log.length - 40); }
    this.draw();
  }

  /** Countdown lock (0x8f0530 from 0x8f05f0): the top menu (UIMainFrame +0x80 [INFERIDO: UITopMenu]), MyInfo (float 2), the room
   * info (float 4) and every child of the TeamSelect frame but btnStart (team lists, team / ready / invite buttons, GM box) take no
   * input; the chat stays live. btnStart stays: the leader's second READYBATTLE stops the countdown. */
  private roomLocked(p: string, c: string): boolean {
    return this.roomLock && this.page === "room"
      && (p === "main" || p === "myinfo" || p === "mapinfo" || (p === "team" && c !== "btnStart") || (p === "hit" && c === "gmobs"));
  }

  /** Curtain of the battle start (game/battleLoading.ts, the Cross SetLoadingSpr screen): from START until the game
   * takes over (boot.ts hides it once startGame resolved; `keep` = leave it up, onBattle) or the start fails. A guard clears it
   * if the server never answers, since the curtain takes every click. */
  private battleLoadingGuard: ReturnType<typeof setTimeout> | null = null;
  private battleLoading(caption: string | null, keep = false): void {
    if (this.battleLoadingGuard) { clearTimeout(this.battleLoadingGuard); this.battleLoadingGuard = null; }
    if (caption) {
      const r = this.roomScreen?.room;
      showBattleLoading({ map: mapFromRoomMapId(r?.room?.mapId ?? 4), mapId: r?.room?.mapId ?? 4, ai: !!r?.isBotRoom, team: ((r?.mySlot ?? 0) % 2) as 0 | 1 }, caption);
      this.battleLoadingGuard = setTimeout(() => {
        this.battleLoadingGuard = null;
        hideBattleLoading();
        this.say("A partida não iniciou (tempo esgotado).", true);
        this.draw();
      }, 60000);
    } else if (!keep) hideBattleLoading();
    this.draw();
  }

  private backToLobby(): void {
    this.battleLoading(null);
    this.roomScreen = null;
    this.clanPairing = false;
    this.roomLock = false;
    this.inspect = null;
    this.roomTab = "map";
    this.page = "lobby";
    this.roomSel = -1;
    this.draw();
    this.startPolling();
  }

  async leaveRoom(): Promise<void> {
    const rs = this.roomScreen;
    if (!rs) return;
    try { await rs.room.leave(); } finally { rs.dispose(); this.backToLobby(); }
  }

  /** Kicked by the leader (3075). 2017 exe 0x8f54e0: once (kicked flag 8 at +0x96c), the message box STBL_IDX_EP_ROOM_KICKED (OK
   * only, 0xa60ca0), UI input off, then 0x59a9f0(1) back to the lobby [INFERIDO: event 1 = LOBBY_ENTER, the same request as Sair].
   * No sound in that path. Re-entry is blocked server side (intervalEnterRoomAfterKickSeconds). */
  private roomKicked(rs: RoomScreen): void {
    if (this.roomScreen !== rs) return;
    void this.leaveRoom().then(() => { this.msg = { text: T.roomKicked }; this.draw(); });
  }

  private async quickStart(): Promise<void> {
    for (const r of this.session?.lobby.quickStartCandidates().slice(0, 3) ?? []) if (await this.openRoom("join", r.roomId)) return;
    this.openCreate();
    if (this.create?.map) await this.openRoom("create");
  }

  /** Cross lbSpecialWarWin row: the create window on `mode` (a text); with `name` the room is created at once
   * (AI room: 8 enemies, level 1 = openCreate's defaults, like 0x8315a0). Map = the mode's first map [INFERIDO]. */
  specialWar(mode: string, name?: string): void {
    const i = ROOM_MODES.findIndex((m) => m.text === mode);
    if (this.busy || i < 0) return;
    this.openCreate();
    const cr = this.create!;
    this.setMode(cr, i);
    if (!name) return this.draw();
    cr.name = name;
    if (cr.map) void this.openRoom("create");
  }

  private openCreate(): void {
    const maps = stageChoices();
    const modeList = ROOM_MODES.map((_, i) => i);
    this.create = {
      name: `sala de ${this.nick()}`, map: maps[0] ?? null, maps, pick: 0, top: 0, busy: false, dd: null,
      mode: 0, modeList, killTime: DEFAULT_KILLTIME, edit: false, botCount: AI_COUNT_MAX, aiLevel: 1, botAllies: 0, balance: 0,
      password: "", passwordOn: false, limitEnter: false, people: DEFAULT_PEOPLE, weapons: { ...ALL_WEAPONS }, watch: DEFAULT_WATCH,
      randomMap: false, randomIds: [], rm: null,
    };
    this.draw();
  }

  /** Ready room "Configurar sala" (leader, READY room): the create window prefilled with the room; the mode list
   * keeps to the room's kind (an AI room stays AI: its 8 bot slots are fixed server-side at creation). */
  private openRoomSettings(): void {
    const r = this.roomScreen?.room, info = r?.room;
    if (!r || !info || !r.isLeader || info.state > 1 || this.busy) return;
    const mode = modeIndex(info.stage, info.roomType, info.rule);
    const maps = modeStageChoices(ROOM_MODES[mode]);
    const ai = !!ROOM_MODES[mode].ai;
    const modeList = ROOM_MODES.map((m, i) => (!!m.ai === ai ? i : -1)).filter((i) => i >= 0);
    const known = maps.find((m) => m.mapId === info.mapId);
    this.create = {
      name: info.name, map: known ?? { mapId: info.mapId, name: stageName(info.mapId) }, maps, pick: 0, top: 0, busy: false, dd: null,
      mode, modeList, killTime: info.killTime || DEFAULT_KILLTIME, edit: true,
      botCount: r.ai?.count ?? AI_COUNT_MAX, aiLevel: r.ai?.level ?? 1, botAllies: r.ai?.allies ?? 0, balance: info.opts?.balanceType ?? 0,
      password: "", passwordOn: ((info.opts?.flag ?? 0) & STAGE_PASSWORD) !== 0, hadPassword: ((info.opts?.flag ?? 0) & STAGE_PASSWORD) !== 0, limitEnter: info.opts?.limit === 1, people: info.slotCount || DEFAULT_PEOPLE, weapons: weaponChecksOf(info.weaponsFlag),
      watch: info.opts?.watchRuleFlag ?? DEFAULT_WATCH, randomMap: ((info.opts?.flag ?? 0) & STAGE_RANDOM_MAP) !== 0, randomIds: randomMapIds(info.opts?.randomMaps), rm: null,
    };
    this.draw();
  }

  /** OK of the settings window: ROOM_CHANGE_ROOMINFO_REQ with the picked map / mode / kills-time / AI (server echoes 3601). */
  private applyRoomSettings(cr: CreateState): void {
    const r = this.roomScreen?.room;
    const md = ROOM_MODES[cr.mode];
    if (!r || !cr.map) return;
    if (r.ai && md.ai) r.ai.allies = cr.botAllies;
    r.changeRoomInfo({
      name: cr.name.trim() || r.room?.name, mapId: cr.map.mapId, rule: md.rule, stage: md.stage, roomType: md.roomType,
      weaponsFlag: weaponsFlagFor(cr), killTime: cr.killTime, ai: md.ai ? { count: cr.botCount, level: cr.aiLevel } : undefined,
      balanceType: md.ai ? 0 : cr.balance, slots: md.ai ? undefined : peopleOf(cr), limit: cr.limitEnter ? 1 : 0, watchRuleFlag: cr.watch,
      flag: ((r.room?.opts?.flag ?? 0) & ~STAGE_RANDOM_MAP) | randomFields(cr).flag, randomMaps: randomFields(cr).randomMaps,
      // the password can't be read back: unticked = clear it, ticked with a new one = set it, ticked and empty = keep the room's
      password: !cr.passwordOn ? (cr.hadPassword ? "" : undefined) : cr.password ? cr.password : undefined,
    });
    this.create = null;
    this.draw();
  }

  // ------------------------------------------------------------------------------------------ input

  /** Click on an original control (placement id + control name) or on a hit region (placement). */
  click(p: string, c: string): void {
    const modal = this.modal();
    if (modal && !(p === "hit" ? modal.some((m) => c.startsWith(`${m}:`)) : modal.includes(p))) return;
    if (this.roomLocked(p, c)) return;
    if (p === "hit" && c === "gmobs") { this.gmObserve = !this.gmObserve; this.draw(); return; }
    if (p === "popup") return this.onPopup(c);
    if (p === "myinfo" && c === "i3UIButton") return this.openProfile();
    if (p === "mdone") { if (c === "i3UIButtonOK") { this.missionDone = null; this.draw(); } return; }
    if (p === "chat") return this.onChatTab(c);
    if (p === "pwd") return this.onPwd(c);
    if (p === "main") return this.onMain(c);
    if (p === "create" || p === "randommap" || /^map\d+$/.test(p) || (p === "hit" && (c.startsWith("chk:") || c.startsWith("rmap:") || c.startsWith("rm:") || c.startsWith("bal:") || c.startsWith("pick:") || c.startsWith("dd:") || c.startsWith("stage:") || c.startsWith("ai:") || c.startsWith("opt:")))) return this.onCreate(p, c);
    if (p === "buy") return this.onBuy(c);
    if (p === "hit" && c.startsWith("buy:")) return this.onBuy(`i3UIRadio_SBN_0${Number(c.slice(4)) + 1}`);
    switch (this.page) {
      case "channels":
        if (p === "list" && c === "i3UIButtonComposed30") this.activate(this.chSelected);
        else if (p === "list" && c === "i3UIButtonComposed3") void (this.channels && this.server ? this.pickServer(this.server) : this.start());
        return;
      case "lobby":
        if (p === "hit" && c.startsWith("sort:")) {
          const key = c.slice(5) as RoomSort["key"];
          this.roomSort = { key, desc: this.roomSort.key === key ? !this.roomSort.desc : false };
          this.roomSel = -1;
          this.draw();
          return;
        }
        if (p !== "roomlist" || this.busy) return;
        if (c === "btn02") void this.quickStart();
        else if (c === "btn03") { this.loadingRooms = true; this.session?.lobby.clear(); this.startPolling(); this.draw(); }
        else if (c === "btn04") this.openCreate();
        else if (c === "btn05") this.joinSelected();
        return;
      case "room": return this.onRoom(p, c);
      case "inventory": return this.onInventory(p, c);
      case "shop": return this.onShop(p, c);
      case "profile": return this.onProfile(p, c);
    }
  }

  /** Grid slot double-click: PB 2017 equips (inventory) / opens the buy popup (shop) instead of requiring the button. */
  dblclick(p: string, c: string): void {
    if (p !== "hit" || !c.startsWith("slot")) return;
    if (this.page === "profile") return this.onTitleSlotDbl(Number(c.slice(4)));
    if (this.page === "inventory") {
      const s = this.session!;
      const it = inventoryItems(s.player, this.menu)[this.menu.top + Number(c.slice(4))];
      if (it) { this.set({ selected: it.objectId, confirming: false }); void this.equip(); }
    } else if (this.page === "shop") {
      const o = shopOffers(this.session!.shop, this.menu)[this.menu.top + Number(c.slice(4))];
      if (o) { this.set({ selected: o.itemId, option: 0, confirming: false }); this.openBuy(); }
    }
  }

  listSelect(list: string, i: number): void {
    if (list === "channels") { this.chSelected = i; this.draw(); }
    else if (list === "rooms") { this.roomSel = i; this.draw(); }
    else if (list === "modes" && this.create && !this.create.busy) { this.create.dd = null; this.setMode(this.create, modeGroups(this.create).normal[i]); this.draw(); }
    else if (list === "red" || list === "blue") this.pickTeamSlot(list, i);
    else if (list === "msets" && this.page === "profile" && this.profileTab === "mission") this.pickMissionSet(tabSets(this.missionState(), this.mission.tab)[i] ?? 0);
  }

  listActivate(list: string, i: number): void {
    if (list === "channels") this.activate(i);
    else if (list === "rooms") { this.roomSel = i; this.joinSelected(); }
    else if (list === "modes") this.listSelect(list, i);
    else if (list === "red" || list === "blue") this.pickTeamSlot(list, i);
  }

  /** Click on a team-list row (ReadyRoom TeamSelect): an empty slot = move there, like the original's row click;
   * another player = show their character and records in the left panel (again / own row = back to mine). */
  private pickTeamSlot(list: "red" | "blue", i: number): void {
    const r = this.roomScreen?.room;
    if (!r || this.busy || this.roomLock) return;
    const t = list === "red" ? 0 : 1;
    const slot = t + i * 2;
    const other = r.slots[slot];
    if (slot === r.mySlot) { this.inspect = null; this.roomTab = "chara"; this.draw(); return; }
    if (this.inspect?.slot === slot) { this.roomTab = "chara"; this.draw(); return; }
    if (other && (other.state >= 12 || other.nick)) { playUiSound(UI_CLICK_SELECT); void this.inspectSlot(r, slot); return; }
    if (!r.changeTeamSlot(slot)) this.say(r.slots[r.mySlot]?.state === WIRE_READY ? T.noChangeSlot : T.full, true);
  }

  private async inspectSlot(r: RoomClient, slot: number): Promise<void> {
    const info = await r.getPlayerInfo(slot);
    if (this.roomScreen?.room !== r) return;
    if (!info) { this.say(T.noPlayerInfo); return; }
    this.inspect = info;
    this.roomTab = "chara";
    this.draw();
  }

  input(id: string, value: string): void {
    if (id === "roomName" && this.create) this.create.name = value;
    else if (id === "roomPassword" && this.create) this.create.password = value.slice(0, 4);
    else if (id === "joinPassword" && this.pwdPrompt) this.pwdPrompt.text = value.slice(0, 4);
    else if (id === "search") { this.menu = { ...this.menu, search: value, top: 0, selected: null }; this.draw(); }
  }

  /** Enter inside an input: the chat line. true = sent / handled locally, the field is cleared. */
  submit(id: string, value: string): boolean {
    return id === "chat" ? this.submitChat(value) : false;
  }

  private activate(i: number): void {
    if (this.busy) return;
    if (this.channels) { playUiSound(UI_SERVER_ENTER); void this.enterChannel(i); }
    else if (this.servers[i]) { playUiSound(UI_SERVER_CONNECT); void this.pickServer(this.servers[i]); }
  }

  /** Visitar (exe 0x884d70 -> fila 0x78fb50 -> executor 0x515250, sala do amigo, estado 6; ver community.ts). Mesmo canal:
   * entra pela lista da lobby. Outro canal ou servidor: sai do canal e entra no do amigo pelo caminho do reconnect
   * (loginAuth + joinChannel), depois entra na sala. [INFERIDO] o exe troca de canal dentro do vtable+0x104 da tela
   * (0x515250), não decodificado. */
  visitRoom(status: number): void {
    if (this.busy || this.page !== "lobby") return;
    const { server, channel, room } = friendLocation(status);
    if (server === this.server?.index && channel === this.channelId) return this.joinRoomById(room);
    void this.visitOtherChannel(server, channel, room);
  }

  /** Visitar em outro canal/servidor: teardown (sai do canal), reconnect no canal do amigo, espera a sala aparecer na lista
   * da lobby (polling, ~1 s após a entrada) e entra nela. */
  private async visitOtherChannel(server: number, channel: number, roomId: number): Promise<void> {
    if (!this.servers.some((s) => s.index === server)) return this.say(T.notExistRoom, true);
    this.teardown();
    await this.reconnect({ server, channel, page: "lobby" });
    const end = Date.now() + 6000;
    while (this.page === "lobby" && !this.roomScreen && !this.disposed && Date.now() < end) {
      if (this.sortedRooms().some((r) => r.roomId === roomId)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (this.page === "lobby") this.joinRoomById(roomId);
  }

  /** entra na sala de id `roomId` da lista da lobby (joinSelected: pede a senha se a sala tem); sem ela, aviso */
  private joinRoomById(roomId: number): void {
    const i = this.sortedRooms().findIndex((r) => r.roomId === roomId);
    if (i < 0) return this.say(T.notExistRoom, true);
    this.roomSel = i;
    this.joinSelected();
  }

  private joinSelected(): void {
    const r = this.sortedRooms()[this.roomSel];
    if (!r) { this.say(T.notExistRoom, true); return; }
    // STAGE flag PASSWORD (4): the room asks for its password first (PBRe_PopUp_PasswordRoom)
    // a GM account skips the prompt: the server lets a GM into password rooms (roomHandlers.ts handleJoinRoom)
    if (r.flag & 4 && !chat.isGM) { this.pwdPrompt = { roomId: r.roomId, text: "" }; this.draw(); return; }
    void this.openRoom("join", r.roomId);
  }

  private onPwd(c: string): void {
    const q = this.pwdPrompt;
    if (!q || this.busy) return;
    if (c === "i3UIButtonComposed3") { this.pwdPrompt = null; this.draw(); return; }
    if (c !== "i3UIButtonOK") return;
    this.pwdPrompt = null;
    this.draw();
    void this.openRoom("join", q.roomId, q.text);
  }

  private onMain(c: string): void {
    const B = MAIN_BUTTONS;
    if (c === B.exit) { this.teardown(); this.deps.onExit(); return; }
    if (this.busy) return;
    if (c === B.back) {
      if (this.page === "channels") { if (this.channels && this.servers.length > 1) { this.channels = null; this.chSelected = 0; this.draw(); } }
      else if (this.page === "lobby") void this.changeServer();
      else if (this.page === "room") void this.leaveRoom();
      else this.closeMenu();
      return;
    }
    if (c === B.options) { this.deps.onOptions?.(); return; }
    if (c === B.clan) { this.openClan(); return; }
    if (c === B.inventory && this.page !== "channels") this.openMenu("inventory");
    else if (c === B.shop && this.page !== "channels") this.openMenu("shop");
  }

  private onPopup(c: string): void {
    const m = this.msg;
    this.msg = null;
    if (c === "btnOK") m?.onOk?.();
    else m?.onCancel?.();
    this.draw();
  }

  private pickOption(cr: CreateState, i: number): void {
    const rounds = !!ROOM_MODES[cr.mode].rounds;
    switch (cr.dd) {
      case "opt:special": this.setMode(cr, modeGroups(cr).special[i]); break;
      case "opt:kills": { const o = (rounds ? [0, 1, 2, 3, 4, 5] : KILL_OPTS)[i]; if (o !== undefined) cr.killTime = (cr.killTime & 0xf0) | o; break; }
      case "opt:time": { const o = (rounds ? [0, 4, 5] : TIME_OPTS)[i]; if (o !== undefined) cr.killTime = (o << 4) | (cr.killTime & 15); break; }
      case "opt:people": { const n = peopleOptions(playerLimit(cr))[i]; if (n !== undefined) cr.people = n; break; }
      case "opt:balance": if (i >= 0 && i < 3) cr.balance = i; break;
      case "ai:count": if (i >= 0 && i < AI_COUNT_MAX) cr.botCount = i + 1; break;
      case "ai:allies": if (i >= 0 && i <= AI_ALLY_MAX) cr.botAllies = i; break;
      case "ai:level": if (i >= 0 && i < AI_LEVEL_MAX) cr.aiLevel = i + 1; break;
    }
  }

  /** Rows the map list can scroll to: the last window of MAP_ROWS maps. */
  private static maxTop(cr: CreateState): number { return Math.max(0, cr.maps.length - MAP_ROWS); }

  /** Picks a mode of the create window; Bomb Mission has its own map list and its killTime is a round count. */
  private setMode(cr: CreateState, now: number | undefined): void {
    if (now === undefined) return;
    const was = ROOM_MODES[cr.mode], md = ROOM_MODES[now];
    cr.mode = now;
    // special-weapon modes show their preset (locked); leaving one restores every weapon
    if (md.special) cr.weapons = weaponChecksOf(md.weaponsFlag);
    else if (was.special) cr.weapons = { ...ALL_WEAPONS };
    if (was.mapIds !== md.mapIds || !!was.rounds !== !!md.rounds || !!was.destroy !== !!md.destroy) {
      cr.maps = modeStageChoices(md);
      cr.map = cr.maps.find((m) => m.mapId === cr.map?.mapId) ?? cr.maps[0] ?? null;
      cr.top = 0;
    }
    if (was.roomType !== md.roomType) cr.killTime = defaultKillTimeOf(md);
  }

  /** Checkboxes of the create window (hit `chk:<key>`): password, entry restriction, Mapa aleatório, observer rules, weapons. */
  private onCheck(cr: CreateState, key: string): void {
    const w = cr.weapons;
    const flip = (bit: number) => { cr.watch ^= bit; };
    switch (key) {
      case "pwd": cr.passwordOn = !cr.passwordOn; if (!cr.passwordOn) cr.password = ""; break;
      case "inter": cr.limitEnter = !cr.limitEnter; break;
      case "rand":
        if (cr.randomMap) cr.randomMap = false;
        else { cr.randomMap = true; cr.rm = { picked: cr.randomIds.length ? [...cr.randomIds] : randomDefaultMaps(cr.maps).map((m) => m.mapId), warn: false }; }
        break;
      case "obsOn": flip(WATCH.ON); break;
      case "obsEnemy": flip(WATCH.ENEMY); break;
      case "obsHp": flip(WATCH.ENEMY_HP); break;
      // 1st-person-only (ObsTPS_2, Lua isLimitObserver1only) clears and locks "3ª pessoa livre" (OnClicked / SetLockObserver3PV)
      case "obsFirst": flip(WATCH.FIRST_ONLY); cr.watch &= ~WATCH.THIRD; break;
      case "obsThird": if (!(cr.watch & WATCH.FIRST_ONLY)) flip(WATCH.THIRD); break;
      // RPG7 needs the primary slot [INFERIDO: the script links the two checkboxes]
      case "wMain": w.primary = !w.primary; if (!w.primary) w.rpg7 = false; break;
      case "wSub": w.secondary = !w.secondary; break;
      case "wThrow": w.throw = !w.throw; break;
      case "wRpg": w.rpg7 = !w.rpg7; if (w.rpg7) w.primary = true; break;
    }
    const md = ROOM_MODES[cr.mode];
    if (md.special && key.startsWith("w")) {
      const { secondary, throw: thr } = cr.weapons;
      cr.weapons = weaponChecksOf(md.weaponsFlag);
      if (optionalBits(md) && (key === "wSub" || key === "wThrow")) { cr.weapons.secondary = secondary; cr.weapons.throw = thr; }
    }
    this.draw();
  }

  /** Mapa aleatório configuration window: `rm:<i>` toggles map i, OK needs one map (STR_POPUP_RANDOMMAP_CHECK_COUNT). */
  private onRandomMap(cr: CreateState, c: string): void {
    const rm = cr.rm!;
    if (c === "rm:ok") {
      if (!rm.picked.length) rm.warn = true;
      else { cr.randomIds = [...rm.picked]; cr.randomMap = true; cr.rm = null; }
    } else if (c === "rm:cancel") {
      cr.rm = null;
      if (!cr.randomIds.length) cr.randomMap = false;
    } else if (c.startsWith("rm:")) {
      const m = cr.maps[Number(c.slice(3))];
      if (m) { rm.picked = rm.picked.includes(m.mapId) ? rm.picked.filter((x) => x !== m.mapId) : [...rm.picked, m.mapId]; rm.warn = false; }
    }
    this.draw();
  }

  private onCreate(p: string, c: string): void {
    const cr = this.create;
    if (!cr || cr.busy) return;
    if (cr.rm) return this.onRandomMap(cr, c);
    if (p === "hit" && c.startsWith("chk:")) return this.onCheck(cr, c.slice(4));
    if (p === "hit" && c === "rmap:cfg") { cr.rm = { picked: cr.randomIds.length ? [...cr.randomIds] : randomDefaultMaps(cr.maps).map((m) => m.mapId), warn: false }; this.draw(); return; }
    if (p === "hit" && c.startsWith("bal:")) { if (!isAiCreate(cr)) cr.balance = Number(c.slice(4)); this.draw(); }
    else if (p === "hit" && c.startsWith("stage:")) {
      const k = c.slice(6);
      if (k === "up") cr.top = Math.max(0, cr.top - 1);
      else if (k === "down") cr.top = Math.min(Lobby2017.maxTop(cr), cr.top + 1);
      else { const m = cr.maps[cr.top + Number(k)]; if (m) cr.map = m; }
      this.draw();
    } else if (c === "i3UIButtonComposed30_LCR") { this.create = null; this.draw(); }
    else if (c === "i3UIButtonComposed3_LCR" && cr.map && cr.edit) this.applyRoomSettings(cr);
    else if (c === "i3UIButtonComposed3_LCR" && cr.map) { cr.busy = true; this.draw(); void this.openRoom("create"); }
    // AI combos (ChangeAICount / ally count / ChangeAILevel) and kills / time / balance: each click steps to the next option
    // Mais fields open a dropdown (option list under the field); an option applies and closes it, any other click closes it
    else if (p === "hit" && c === "dd:close") { cr.dd = null; this.draw(); }
    else if (p === "hit" && c.startsWith("pick:")) { this.pickOption(cr, Number(c.slice(5))); cr.dd = null; this.draw(); }
    else if (p === "hit" && (c.startsWith("ai:") ? isAiCreate(cr) : c.startsWith("opt:") && !isAiCreate(cr))) { cr.dd = cr.dd === c ? null : c; this.draw(); }
  }

  // ------------------------------------------------------------------------------------------ room

  private onRoom(p: string, c: string): void {
    const r = this.roomScreen?.room;
    if (!r || this.busy) return;
    if (p === "mapinfo" && c === "i3UIButtonRoomSet") return this.openRoomSettings();
    if (p === "mapinfo" && (c === "i3UITab_MapInfo" || c === "i3UITab_MissionCard")) { this.roomTab = c === "i3UITab_MapInfo" ? "map" : "chara"; this.draw(); return; }
    if (p !== "team") return;
    if (c === "btnReady") r.ready(chat.isGM && (this.gmObserve || r.mySlot >= 16) ? 2 : 0);
    else if (c === "btnStart" && this.roomScreen?.countdown.running) r.ready(); // the leader's READYBATTLE in the countdown stops it (255)
    else if (c === "btnStart") void this.startBattle(r);
    else if (c === "i3UIButton" || c === "i3UIButton_BlueTeam") {
      const t = c === "i3UIButton" ? 0 : 1;
      if (r.mySlot % 2 !== t && !r.changeTeam(t)) this.say(r.slots[r.mySlot]?.state === WIRE_READY ? T.noChangeSlot : T.full, true);
    }
  }

  private async startBattle(r: RoomClient): Promise<void> {
    // 2017 AI mode start check (STBL_IDX_EP_ROOM_NO_TRAINIG_TEAM_S): every player on the same team; the bots are the other one.
    if (r.isBotRoom && r.slots.some((x) => x.state >= 12 && x.slot % 2 !== r.mySlot % 2)) { this.say(T.noTrainingTeam, true); return; }
    this.busy = true;
    try {
      // no curtain before the server answers: a countdown room (5126) keeps the ready room up while it counts (RoomCountdown) and
      // the curtain shown here flicked on and off; START_GAME (5127) raises it through RoomScreen.bootstrapBattle, as for every guest
      await r.start();
    } catch (e) {
      this.battleLoading(null);
      this.say(`${e instanceof Error ? e.message : String(e)}\n${T.startNeedsReady}`, true);
    } finally {
      this.busy = false;
      this.draw();
    }
  }

  // ------------------------------------------------------------------------------------------ inventory / shop

  private openMenu(mode: "inventory" | "shop"): void {
    const s = this.session;
    if (!s) return;
    if (this.page === "inventory" || this.page === "shop") s.notifyScreen(this.page, false);
    else if (this.page === "profile") s.notifyScreen("info", false);
    else this.menuFrom = this.page === "room" ? "room" : "lobby";
    this.stopPolling();
    this.menu = defaultMenuUi();
    this.buy = null;
    this.page = mode;
    void loadCharaHp().then(() => this.draw());
    void loadCharaStats(`${UI_BASE.replace(/\/ui$/, "")}/config`).then(() => this.draw());
    s.notifyScreen(mode, true);
    if (mode === "shop" && (s.shop.status === "idle" || s.shop.status === "error")) void s.loadShop().catch((e) => this.say(e instanceof Error ? e.message : String(e), true));
    this.draw();
  }

  // ------------------------------------------------------------------------------------------ Perfil / Títulos

  /** "Minha informação" (MyInfo's INFO button, ClickInfo): UIMainFrame opens the Perfil sub-phase over the lobby / ready room (0x7a52a0) */
  /** Clã (main button i3UIButton18, the Game session needed): PBRe_ClanMenu over the lobby / ready room; the page reads membership first */
  private openClan(): void {
    if (!this.session || !this.clanNet || this.busy || (this.page !== "lobby" && this.page !== "room")) return;
    this.menuFrom = this.page === "room" ? "room" : "lobby";
    this.stopPolling();
    this.page = "clan";
    this.draw();
  }

  private openProfile(): void {
    if (!this.session || !this.titles || this.busy || (this.page !== "lobby" && this.page !== "room")) return;
    this.menuFrom = this.page === "room" ? "room" : "lobby";
    this.stopPolling();
    this.profile = { selected: 0, slotSel: -1, busy: false };
    this.profileTab = "designation";
    this.mission = { tab: 0, sel: 0, popup: null, busy: false };
    this.page = "profile";
    this.session.notifyScreen("info", true); // the room's slot row goes to INFO (server SlotState 4)
    this.draw();
  }

  private profileData(): ProfileData {
    return { state: this.titles?.state ?? emptyTitleState(), rank: this.chrome().rank, ...this.profile };
  }

  private onProfile(p: string, c: string): void {
    // the frame's tabs (ChangeTab 0 / 1) and the Missão tab's controls
    if (p === "profile" && (c === "i3UIButton_MIM" || c === "i3UIButton0_MID")) return this.changeProfileTab(c === "i3UIButton_MIM" ? "mission" : "designation");
    if (this.profileTab === "mission") return this.onMission(p, c);
    if (!this.titles || this.profile.busy) return;
    if (p === "hit" && c.startsWith("node:")) return this.pickTitle(Number(c.slice(5)));
    if (p === "hit" && c.startsWith("slot")) return this.pickSlot(Number(c.slice(4)));
    if (p === "hit" && c.startsWith("unequip")) return this.askRelease(Number(c.slice(7)));
    if (p !== "designation") return;
    const node = /^i3UIButtonImageSet(\d\d)$/.exec(c);
    if (node) return this.pickTitle(TREE_NODES[Number(node[1])] ?? 0);
    if (c === "i3UIButtonConfirm") return this.confirmTitle();
  }

  private pickTitle(id: number): void {
    if (!titleDef(id)) return;
    this.profile = { ...this.profile, selected: id };
    this.draw();
  }

  /** ClickMyDesigSlot(i): picks the slot (a locked one does nothing); a slot with a title also shows that title */
  private pickSlot(i: number): void {
    const t = this.titles;
    if (!t || i < 0 || i >= t.state.slots) return;
    this.profile = { ...this.profile, slotSel: i, selected: t.state.equiped[i] || this.profile.selected };
    this.draw();
  }

  /** D_ClickMyDesigSlot(i) [INFERIDO: the exe handler was not decoded]: a filled slot asks to release, an empty one to equip the picked title */
  private onTitleSlotDbl(i: number): void {
    const t = this.titles;
    if (!t || this.profile.busy || i < 0 || i >= t.state.slots) return;
    this.profile = { ...this.profile, slotSel: i };
    if (t.state.equiped[i]) return this.askRelease(i);
    this.draw();
    if (hasTitle(t.state, this.profile.selected)) this.askEquip(i, this.profile.selected);
  }

  private askTitle(text: string, run: () => Promise<void>): void {
    this.msg = { text, onOk: () => void run(), onCancel: () => {} };
    this.draw();
  }

  /** the confirm button: GET / USE / RELEASE of the picked title (Lua SetDesignationSetCaption) */
  private confirmTitle(): void {
    const t = this.titles;
    if (!t) return;
    const d = this.profileData(), mode = confirmMode(d), def = titleDef(d.selected);
    if (!def) return;
    if (mode === "get") {
      if (getBlock(t.state, d.rank, def)) return this.say(TS.notMatch, true);
      return this.askTitle(TS.getAsk, () => this.doTitle(() => t.change(def.id), TS.gotIt, TS.notMatch));
    }
    if (mode === "release") return this.askRelease(titleSlotOf(t.state, def.id));
    if (d.slotSel < 0) return this.say(TS.noSlot, true);
    this.askEquip(d.slotSel, def.id);
  }

  private askEquip(slot: number, id: number): void {
    const t = this.titles;
    if (!t) return;
    const block = equipBlock(t.state, id, slot);
    if (block === "sameClass") return this.say(TS.sameClass, true);
    if (block === "notOwned") return this.say(TS.noEquipYet, true);
    if (block === "already") return this.say(TS.dupSlot, true);
    if (block) return this.say(TS.noSlot, true);
    this.askTitle(TS.equipAsk, () => this.doTitle(() => t.equip(slot, id), TS.registered, TS.sameClass));
  }

  private askRelease(slot: number): void {
    const t = this.titles, id = t?.state.equiped[slot] ?? 0;
    if (!t || !id) return;
    this.askTitle(TS.releaseAsk, () => this.doTitle(() => t.release(slot, id), null, TS.releaseFail));
  }

  /** one title request: the page is locked while it runs; `ok` / `fail` are the client's own result messages */
  private async doTitle(run: () => Promise<{ ok: boolean }>, ok: string | null, fail: string): Promise<void> {
    this.profile = { ...this.profile, busy: true };
    this.draw();
    try {
      const r = await run();
      if (r.ok) { if (ok) this.say(ok, true); } else this.say(fail, true);
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), true);
    } finally {
      this.profile = { ...this.profile, busy: false };
      this.draw();
    }
  }

  // ------------------------------------------------------------------------------------------ Perfil / Missões

  private missionState(): MissionState { return this.missions?.state ?? emptyMissionState(); }

  /** ChangeTab(0 / 1). The Missão tab opens on the active card set (and its sub-tab), else the sub-tab's first set */
  private changeProfileTab(tab: ProfileTab): void {
    if (this.profileTab === tab || this.profile.busy || this.mission.busy) return;
    this.profileTab = tab;
    if (tab === "mission") {
      const st = this.missionState(), active = st.slots[st.active]?.setId ?? 0;
      const sub = MISSION_TABS.findIndex((t) => (t.sets as readonly number[]).includes(active));
      this.mission = { tab: Math.max(0, sub), sel: 0, popup: null, busy: false };
      const sets = tabSets(st, this.mission.tab);
      this.mission.sel = sets.includes(active) ? active : sets[0] ?? 0;
    }
    this.draw();
  }

  private onMission(p: string, c: string): void {
    const m = this.mission;
    if (p === "mbuy") {
      if (c === "i3UIButtonComposed310") void this.buyMissionSet();
      else if (c === "i3UIButtonComposed313" && !m.busy) { this.mission = { ...m, popup: null }; this.draw(); }
      return;
    }
    if (p === "mdetail") {
      const pp = m.popup;
      if (c === "Button_Close") this.mission = { ...m, popup: null };
      // CardInfo_Next / CardInfo_Prev (0x92b3e0 / 0x92b400): the set's final prize items, wrapping (0x92b6d0); disabled below 2 items
      else if (pp && (c === "i3UIButtonComposed3" || c === "i3UIButtonComposed30") && detailPrize(pp.setId, 0).count > 1) {
        this.mission = { ...m, popup: { ...pp, item: stepPrize(pp.setId, pp.item ?? 0, c === "i3UIButtonComposed3" ? 1 : -1) } };
      }
      this.draw();
      return;
    }
    if (m.busy || !this.missions) return;
    if (p === "profile") {
      const sub = MISSION_TABS.findIndex((t) => t.btn === c);
      if (sub >= 0 && sub !== m.tab) { this.mission = { ...m, tab: sub, sel: tabSets(this.missionState(), sub)[0] ?? 0 }; this.draw(); }
      return;
    }
    if (p === "hit" && c.startsWith("mcard:")) return this.pickMissionCard(Number(c.slice(6)));
    if (p !== "missioncard") return;
    if (c === "i3UIButton3_MIM" && missionSet(m.sel)) { this.mission = { ...m, popup: { kind: "detail", setId: m.sel } }; this.draw(); }
    else if (c === "i3UIButton4_MIM") this.askBuyMissionSet();
    else if (c === "i3UIButton5_MIM") this.askDeleteMissionSet();
  }

  /** list row (SelectCard / OnSelectList 0x954a90): an owned set becomes the active one, with its current card (2360) */
  private pickMissionSet(id: number): void {
    const t = this.missions, set = missionSet(id);
    if (!t || !set || this.mission.busy) return;
    this.mission = { ...this.mission, sel: id };
    const st = t.state, slot = slotOfSet(st, id);
    if (slot >= 0 && slot !== st.active && cardSelectable(set, st.slots[slot], st.slots[slot].card)) t.setActive(slot, st.slots[slot].card);
    this.draw();
  }

  /** card button (OnEvent 0x954160 -> 0x9549c0): an open card of the active set becomes the active card (2360) */
  private pickMissionCard(card: number): void {
    const t = this.missions, set = missionSet(this.mission.sel);
    if (!t || !set) return;
    const st = t.state, slot = slotOfSet(st, set.id), s = st.slots[slot];
    if (slot < 0 || !cardSelectable(set, s, card) || (slot === st.active && s.card === card)) return;
    t.setActive(slot, card);
  }

  /** Comprar (CardBuy 0x955cf0): rank / duplicate / 3-set checks, then the BuyNow popup */
  private askBuyMissionSet(): void {
    const set = missionSet(this.mission.sel);
    if (!set) return this.say(MS.selectCard, true);
    const block = buyBlock(this.missionState(), set.id, this.chrome().rank);
    if (block === "rank") return this.say(rankBlockText(rankBlock(set.id, this.chrome().rank)!), true);
    if (block === "duplicate") return this.say(MS.duplicate, true);
    if (block === "limit") return this.say(MS.limit, true);
    if (block) return;
    this.mission = { ...this.mission, popup: { kind: "buy", setId: set.id } };
    this.draw();
  }

  /** BuyNow confirm: 2364 -> 2365 (messages of the ack handler 0x955760) */
  private async buyMissionSet(): Promise<void> {
    const t = this.missions, setId = this.mission.popup?.setId ?? 0;
    if (!t || !setId || this.mission.busy) return;
    this.mission = { ...this.mission, busy: true };
    this.draw();
    try {
      const r = await t.buy(setId);
      if (r.ok) {
        const w = this.player?.state.wallet;
        this.player?.dispatch({ type: "wallet", wallet: { gold: r.gold ?? w?.gold ?? 0, cash: r.cash ?? w?.cash ?? 0, tags: w?.tags ?? 0 } });
        this.mission = { ...this.mission, popup: null, sel: setId };
        this.say(MS.buyOk, true);
      } else {
        this.mission = { ...this.mission, popup: null };
        this.say(r.err === MissionErr.NO_POINT ? MS.noPoint : r.err === MissionErr.LIMIT ? MS.limit : r.err === MissionErr.NOT_TUTORIAL ? MS.notTutorial : MS.noCardInfo, true);
      }
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), true);
    } finally {
      this.mission = { ...this.mission, busy: false };
      this.draw();
    }
  }

  /** Excluir (0x955de0): confirmation, then 2366 -> 2367 */
  private askDeleteMissionSet(): void {
    const slot = slotOfSet(this.missionState(), this.mission.sel);
    if (slot < 0) return;
    this.msg = { text: MS.deleteAsk, onOk: () => void this.deleteMissionSet(slot), onCancel: () => {} };
    this.draw();
  }

  private async deleteMissionSet(slot: number): Promise<void> {
    const t = this.missions;
    if (!t || this.mission.busy) return;
    this.mission = { ...this.mission, busy: true };
    this.draw();
    try {
      const r = await t.remove(slot);
      this.say(r.ok ? MS.deleteOk : r.err === MissionErr.DELETE_NO_INFO ? MS.deleteNoInfo : MS.deleteNetwork, true);
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), true);
    } finally {
      this.mission = { ...this.mission, busy: false };
      this.draw();
    }
  }

  /** 3077 (877 from the room owner, server clanHandlers handleRoomInvited): the invite popup of the exe (STR_TBL_GUI_LOBBY_INVITE_MESSAGE1,
   *); OK joins the room with the password the push carries */
  private onRoomInvite(inv: ClanRoomInvite): void {
    const name = this.session?.lobby.roomList().find((r) => r.roomId === inv.roomId)?.name ?? String(inv.roomId);
    const text = tOr("STR_TBL_GUI_LOBBY_INVITE_MESSAGE1","%2% da sala %1% te convidou.\nDeseja aceitar?").replace("%2%", inv.nick).replace("%1%", name);
    this.msg = { text, onOk: () => void this.openRoom("join", inv.roomId, inv.password) };
    this.draw();
  }

  /** a mission push (2355 / 2359 / 2361): a 2361 (card / set finished) opens the Complete popup and carries the account's new gold.
   * The server sends the 2361 at the end of the match (progress.ts, after calculateResult): the lobby is hidden then (boot.ts playBattle
   * screen.hide) and only shows again after the GameResult screen, in the room (READY), with the popup up, as the 2017 opens it there
   * (CPhaseReadyRoom::_OpenFinalPrizeWindow 0x7e1050); the match only reads the tasks (game.ts watchMissions) */
  private onMissionPush(): void {
    const t = this.missions, p = t?.prize;
    if (t && p) {
      t.prize = null;
      const w = this.player?.state.wallet;
      if ((p.flag & 1) === 1 && w) this.player?.dispatch({ type: "wallet", wallet: { ...w, gold: p.gold } });
      const done = completeInfo(p);
      // set items without an icon in the web tables (2017 ids) are left out instead of a placeholder
      if (done) this.missionDone = { ...done, items: done.items.filter((id) => !!iconOf(id)) };
      if (this.page !== "profile") this.draw();
    }
    if (this.page === "profile") this.draw();
  }

  private closeMenu(): void {
    if (this.page === "clan") void this.clanNet?.leave().catch(() => {}); // clan page left (771); the Cross page drops its own state
    if (this.page === "inventory" || this.page === "shop") this.session?.notifyScreen(this.page, false);
    else if (this.page === "profile") this.session?.notifyScreen("info", false);
    this.buy = null;
    if (this.menuFrom === "room" && this.roomScreen) { this.page = "room"; this.draw(); }
    else this.backToLobby();
  }

  private set(p: Partial<MenuUi>): void { this.menu = { ...this.menu, ...p }; this.draw(); }

  private menuTotal(): number {
    const s = this.session!;
    return this.page === "inventory" ? inventoryItems(s.player, this.menu).length : shopOffers(s.shop, this.menu).length;
  }

  /** Continuous scroll clamp: any top in [0, total - GRID_PAGE] is valid, like a real listview (not page-quantised). */
  private clampGridTop(top: number): number {
    return Math.max(0, Math.min(Math.max(0, this.menuTotal() - GRID_PAGE), top));
  }

  private scrollGrid(delta: number): void {
    const top = this.clampGridTop(this.menu.top + delta);
    if (top !== this.menu.top) this.set({ top });
  }

  /** Clicking the scrollbar track above/below the thumb (pageUp/pageDown hits): jumps a full page. */
  private pageMenu(dir: number): void { this.scrollGrid(Math.sign(dir) * GRID_PAGE); }

  private onInventory(p: string, c: string): void {
    const s = this.session!;
    if (p === "hit") {
      if (c === "pageUp" || c === "pageDown") return this.pageMenu(c === "pageUp" ? -1 : 1);
      if (c.startsWith("slot")) { const it = inventoryItems(s.player, this.menu)[this.menu.top + Number(c.slice(4))]; if (it) this.set({ selected: it.objectId, confirming: false }); return; }
      if (c.startsWith("mount") && this.menu.tab === "chara" && Number(c.slice(5)) < 2) this.set({ team: Number(c.slice(5)), confirming: false });
      return;
    }
    if (p === "tabs") {
      const tab = INV_TABS.find(([n]) => n === c)?.[1];
      if (tab) return this.set({ tab, filter: "all", top: 0, selected: null, confirming: false });
      const f = INV_SUBS[this.menu.tab].find(([n]) => n === c)?.[1];
      if (f) this.set({ filter: f, top: 0, selected: null, confirming: false });
      return;
    }
    if (p === "list" && c === "i3UIButtonComposed31") void this.equip();
  }

  async equip(): Promise<void> {
    const s = this.session!;
    const it = this.menu.selected !== null ? s.player.state.inventory.get(this.menu.selected) : undefined;
    if (!it || this.menu.busy) return;
    // an equipped cosmetic item (head/face/beret/...) re-clicked: clear the slot instead of re-equipping it
    const slot = equipSlotOf(it.itemId);
    if (slot !== null && isUnequippableSlot(slot) && s.player.isEquipped(it)) return this.unequip(slot, it.itemId);
    if (s.player.needsActivation(it) && !this.menu.confirming) {
      this.menu.confirming = true;
      this.msg = { text: S.startingAuth, onOk: () => void this.equip(), onCancel: () => { this.menu.confirming = false; } };
      this.draw();
      return;
    }
    this.set({ busy: true, confirming: false });
    try {
      playUiSound(UI_ITEM_EQUIP); // exe plays it before the request leaves (0x8ffcbf), not after the reply
      await s.equip(it, this.menu.team);
      this.say(`${S.equipped}: ${itemName(it.itemId).name}`);
    } catch (e) {
      this.say(`${S.cannotEquip}\n${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      this.set({ busy: false });
    }
  }

  /** "use now" after a purchase: the cosmetic use items take the inventory's Usar (their popup, 1052); the rest equip (the 1050 activation). */
  private async useBought(it: InventoryItem): Promise<void> {
    if (this.cosmeticUse?.(it)) return;
    const s = this.session!;
    if (this.menu.busy) return;
    this.set({ busy: true });
    try {
      await s.equip(it, this.menu.team);
      this.say(`${S.equipped}: ${itemName(it.itemId).name}`);
    } catch (e) {
      this.say(`${S.cannotEquip}\n${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      this.set({ busy: false });
    }
  }

  private async unequip(slot: number, itemId: number): Promise<void> {
    const s = this.session!;
    if (this.menu.busy) return;
    this.set({ busy: true, confirming: false });
    try {
      await s.unequip(slot);
      this.say(`${S.unequip}: ${itemName(itemId).name}`);
    } catch (e) {
      this.say(`${S.cannotEquip}\n${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      this.set({ busy: false });
    }
  }

  private onShop(p: string, c: string): void {
    const s = this.session!;
    if (p === "hit") {
      if (c === "pageUp" || c === "pageDown") return this.pageMenu(c === "pageUp" ? -1 : 1);
      if (c.startsWith("slot")) { const o = shopOffers(s.shop, this.menu)[this.menu.top + Number(c.slice(4))]; if (o) this.set({ selected: o.itemId, option: 0, confirming: false }); }
      return;
    }
    if (p === "menu") {
      if (c === "i3UIButton_NewHot") return this.set({ hot: true, filter: "all", top: 0, selected: null });
      const tab = SHOP_TABS.find(([n]) => n === c)?.[1];
      if (tab) return this.set({ tab, hot: false, filter: "all", top: 0, selected: null });
      const f = SHOP_SUBS[this.menu.tab].buttons.find(([n]) => n === c)?.[1];
      if (f) this.set({ filter: f, top: 0, selected: null });
      return;
    }
    if (p === "list") {
      if (c === "i3UIButton_ClearKeyword") this.set({ search: "", top: 0 });
      else if (c === "i3UIButton_Buy_SLB") this.openBuy();
    }
  }

  openBuy(): void {
    const offer = this.menu.selected !== null ? this.session?.shop.offer(this.menu.selected) : undefined;
    if (!offer) return;
    const currency = offer.options.some((o) => priceIn(o, "gold") > 0) ? "gold" : "cash";
    const option = Math.max(0, offer.options.slice(0, 4).findIndex((o) => priceIn(o, currency) > 0));
    this.menu = { ...this.menu, currency, option };
    this.buy = { currency, option, busy: false };
    this.draw();
  }

  private onBuy(c: string): void {
    const b = this.buy;
    if (!b || b.busy) return;
    if (c === "SBN_Cancel") { this.buy = null; this.draw(); return; }
    if (c === "i3UITab" || c === "i3UITab0") { b.currency = c === "i3UITab" ? "gold" : "cash"; this.menu = { ...this.menu, currency: b.currency }; this.draw(); return; }
    const radio = /^i3UIRadio_SBN_0(\d)$/.exec(c);
    if (radio) { b.option = Number(radio[1]) - 1; this.menu = { ...this.menu, option: b.option }; this.draw(); return; }
    if (c === "SBN_Buy") void this.doBuy();
  }

  async doBuy(): Promise<void> {
    const s = this.session!, b = this.buy;
    const offer = this.menu.selected !== null ? s.shop.offer(this.menu.selected) : undefined;
    const opt = offer?.options[b?.option ?? 0];
    if (!b || !offer || !opt || priceIn(opt, b.currency) <= 0) return;
    b.busy = true;
    this.draw();
    try {
      await s.buy([{ goodId: opt.goodId, buyType: b.currency === "gold" ? BuyType.Gold : BuyType.Cash }]);
      this.buy = null;
      // bought: ask to use it now; OK equips the new inventory entry [RECRIADO: no STBL string for the question]
      const bought = [...s.player.state.inventory.values()].find((i) => i.itemId === opt.itemId);
      const text = `${S.buySuccess}\n${itemName(offer.itemId).name}`;
      if (bought) {
        this.log.push(text.replace("\n", " "));
        this.msg = { text: `${text}\nDeseja usar este item agora?`, onOk: () => void this.useBought(bought), onCancel: () => {} };
        this.draw();
      } else this.say(`${S.buySuccess} ${itemName(offer.itemId).name}`, true);
    } catch (e) {
      const code = (e as { code?: number }).code ?? 0;
      b.busy = false;
      this.say((code >>> 0) === 0x80001018 ? (b.currency === "cash" ? S.noCash : S.noPoint) : e instanceof Error ? e.message : String(e), true);
    }
  }

  // ------------------------------------------------------------------------------------------ chat

  /** The log lines of the active tab: Geral = general + server + whispers, Time = team only, Sussurro = whispers only (also read by screensCross/app.ts). */
  chatRows(): ChatRow[] {
    const tab = this.page === "room" || this.chatTab !== "team" ? this.chatTab : "all";
    const out: ChatRow[] = [];
    for (const l of this.lines) {
      if (tab === "all" ? l.kind === "team" : l.kind !== tab) continue;
      const color = l.rgba ?? (l.kind === "system" ? CHAT_COLOR.system : l.gm ? CHAT_COLOR.gm : CHAT_COLOR[l.kind]);
      const text = l.kind === "system" ? (l.nick && l.nick !== "Server" ? `${l.nick}: ${l.text}` : l.text)
        : l.kind === "whisper" ? (l.to ? `[PM] > ${l.to}: ${l.text}` : `[PM] ${l.nick}: ${l.text}`)
        : `${l.nick}: ${l.text}`;
      out.push({ text, color, nick: l.kind === "system" ? undefined : l.kind === "whisper" ? (l.to ?? l.nick) : l.nick });
    }
    return out;
  }

  /** Geral / Time / Sussurro tab of the chat window. */
  private onChatTab(c: string): void {
    const tab = (Object.keys(CHAT_TABS) as ChatTab[]).find((k) => CHAT_TABS[k] === c);
    if (!tab || (tab === "team" && this.page !== "room")) return;
    this.chatTab = tab;
    this.draw();
  }

  /** Enter in the chat line: "/" = command, else a line of the active tab. Returns false (keeps the text) when nothing was sent. */
  private submitChat(raw: string): boolean {
    const t = raw.trim();
    if (!t) return true;
    if (!chat.connected) { this.say(T.chatOffline); return false; }
    chat.myNick = this.nick();
    const inRoom = this.page === "room" && !!this.roomScreen;
    const general = inRoom ? ChatType.ROOM : ChatType.ALL;
    if (t.startsWith("/")) return this.chatCommand(t, general, inRoom);
    if (this.chatTab === "whisper") {
      if (!chat.lastWhisper) { this.say(T.chatNoWhisper); return false; }
      return chat.whisper(chat.lastWhisper, t);
    }
    return chat.send(this.chatTab === "team" && inRoom ? ChatType.TEAM : general, t);
  }

  /** Client-side commands (bloquear, desbloquear, c, t, bug, denunciar without arguments); every other "/..." goes to the server as chat. */
  private chatCommand(t: string, general: number, inRoom: boolean): boolean {
    const a = splitArgs(t);
    const cmd = a[0].toLowerCase();
    if (cmd === "/bloquear" || cmd === "/desbloquear") {
      const nick = a[1];
      if (!nick) {
        const l = chat.blockedNicks();
        this.say(cmd === "/bloquear" ? (l.length ? `${T.chatBlockList} ${l.join(", ")}` : T.chatBlockNone) : T.chatBlockUsage);
      } else if (cmd === "/bloquear") { chat.block(nick); this.say(`${T.chatBlocked} ${nick}`); }
      else { chat.unblock(nick); this.say(`${T.chatUnblocked} ${nick}`); }
      return true;
    }
    if (cmd === "/c") { this.lines = []; this.draw(); return true; } // original: "/c apagar histórico de chat" (STBL_IDX_CHATMESSAGE_HELP6)
    if (cmd === "/t") { // original: "/t chat do time" (HELP5)
      const text = t.slice(2).trim();
      if (!inRoom) { this.say(T.chatNoTeam); return true; }
      return !text || chat.send(ChatType.TEAM, text);
    }
    if (cmd === "/bug") { this.openBug(t.slice(4).trim()); return true; }
    return chat.send(general, t);
  }

  /** Bug window (/bug, the server's "BUG" line, the options menu): the battle's BugPopup (game/reportPopup.ts), the text goes
   *  with the client meta through 9001. [RECRIADO] the Cross client has no bug window. */
  private bugPopup: Promise<import("../../game/reportPopup.ts").BugPopup> | null = null;
  openBug(text = ""): void {
    this.bugPopup ??= import("../../game/reportPopup.ts").then((m) => m.BugPopup.create({ host: document.body, input: null, send: async (t) => (await sendBugReport(t)).message }));
    void this.bugPopup.then((b) => b.open(text)).catch((e) => { this.bugPopup = null; console.warn("[lobby] bug popup", e); });
  }


  // ------------------------------------------------------------------------------------------ view

  /** the lobby list as shown (list indices, Entrar and double-click all go through this order) */
  private sortedRooms() { return sortRooms(this.session?.lobby.roomList() ?? [], this.roomSort); }

  private nick(): string { return this.player?.state.profile?.nickname || this.login?.username || "web"; }

  /** Adds a line to the chat log / bottom ticker; `popup` also shows it in the original message box. */
  say(text: string, popup = false): void {
    for (const l of text.split("\n")) if (l.trim()) { this.log.push(l.trim()); this.lines.push({ kind: "system", nick: "", gm: false, color: 0, text: l.trim(), time: Date.now() }); }
    if (this.lines.length > 100) this.lines.splice(0, this.lines.length - 100);
    if (this.log.length > 40) this.log.splice(0, this.log.length - 40);
    if (popup) this.msg = { text };
    this.draw();
  }

  /**
   * The room's "Observador GM" box: READY goes out with mode 2, the GM watches the match without a body. Distinct from the GM panel's
   * hidden entry (chat.gmStealth): with this box the GM stays visible in the room; the hidden entry (observer seat 16 / 17) is always mode 2.
   */
  private gmObserve = false;
  /** the GM observer box of the room (2017 CkGMObserver / Cross chkObserver): shown to a GM who is not the leader; on = READY goes out with mode 2 */
  get gmObserverBox(): { can: boolean; on: boolean } {
    const r = this.roomScreen?.room;
    return { can: chat.isGM && !!r && !r.isLeader, on: this.gmObserve || (r?.mySlot ?? -1) >= 16 };
  }

  /** the server sent ACCOUNT_KICK (2009) on this Game session */
  private kickedByServer = false;
  private kickDuplicate = false;

  private fail(e: unknown, onOk: () => void): void {
    this.loading = null;
    const text = e instanceof Error ? e.message : String(e);
    this.log.push(text);
    this.msg = { text, onOk };
    this.draw();
  }

  chrome(): Chrome {
    const p = this.player ?? (this.page === "channels" ? this.peek()?.player : null) ?? null, pr = p?.state.profile, w = p?.state.wallet, rec = p?.state.record?.season;
    const kills = rec?.kills ?? 0, deaths = rec?.deaths ?? 0;
    return {
      ...EMPTY_CHROME,
      page: this.page,
      nickname: pr?.nickname ?? this.login?.username ?? this.deps.username,
      rank: pr?.rank ?? 0,
      expText: pr ? `${pr.exp}` : "",
      gold: w?.gold ?? pr?.gold ?? 0,
      cash: w?.cash ?? pr?.cash ?? 0,
      clan: pr?.clanName ?? "",
      record: rec ? `${rec.wins}V ${rec.loses}D` : "",
      kd: rec ? `${kills}/${deaths}` : "",
      headshot: rec && kills ? `${Math.round((rec.headshots / kills) * 100)}%` : "",
      serverLabel: this.server ? `${T.server} ${this.server.index}${this.game ? ` - ${T.channel} ${this.channelId + 1}` : ""}` : "",
      canBack: this.page !== "channels" || (!!this.channels && this.servers.length > 1),
    };
  }

  /** the page's showroom character (screensCross/preview.ts): character item + the primary in its hands; itemId 0 = none */
  showroom(): { itemId: number; weaponId: number } {
    const s = this.session, none = { itemId: 0, weaponId: 0 };
    switch (this.page) {
      case "channels": {
        // the 2453 loadout of the Auth meta; [RECRIADO] basic character / K-2 when it has none; nothing until the Auth meta is in (no default-then-real flicker)
        const pk = this.peek();
        return pk ? { itemId: pk.chara || 601005, weaponId: pk.weapon || 103004 } : none;
      }
      case "lobby":
        return s ? { itemId: s.player.teamCharas().red, weaponId: s.player.weaponLoadout().primary } : none;
      case "room": {
        if (this.roomTab !== "chara") return none;
        const r = this.roomScreen?.room, info = r?.room, ins = this.inspect, t = s?.player.teamCharas();
        const itemId = ins?.equip[EquipSlot.Chara] || (t ? ((r?.mySlot ?? 0) % 2 === 0 ? t.red : t.blue) : 0);
        const weaponId = ins ? enforceRoomWeapons(ins.equip.slice(0, 5).map((id) => ({ itemId: id })), [], info?.weaponsFlag ?? 0x1ff, { itemId: 0 }, info?.stage)[0].itemId
          : s ? respawnEquipFor(s.player, r?.mySlot ?? 0, undefined, info?.weaponsFlag, info?.stage)[0]?.itemId ?? 0 : 0;
        return { itemId, weaponId };
      }
      case "inventory":
        return s ? { itemId: inventoryData(s.player, this.menu).charaItemId, weaponId: s.player.weaponLoadout().primary } : none;
      case "shop": {
        if (!s) return none;
        // a selected primary / secondary goes straight into the character's hands
        const sel = this.menu.selected, slot = sel !== null ? equipSlotOf(sel) : null;
        return { itemId: shopData(s.player, s.shop, this.menu).charaItemId, weaponId: slot === EquipSlot.Primary || slot === EquipSlot.Secondary ? sel! : s.player.weaponLoadout().primary };
      }
      default:
        return none;
    }
  }

  /** while a popup or the loading curtain is up, only these placement ids (and "hit" ids prefixed with one) take clicks */
  private modal(): string[] | null {
    if (this.loading ?? (this.loadingRooms && this.page === "lobby" && !this.roomScreen)) return ["loading"];
    if (this.msg) return ["popup"];
    if (this.missionDone) return ["mdone"];
    if (this.pwdPrompt) return ["pwd"];
    const cr = this.create;
    if (cr) return cr.rm ? ["randommap", "rm"] : ["create", "opt", "ai", "stage", "bal", "chk", "rmap", "dd", "pick"];
    if (this.buy && this.session && this.page === "shop") return ["buy"];
    if (this.page === "profile" && this.profileTab === "mission" && this.mission.popup) return [this.mission.popup.kind === "buy" ? "mbuy" : "mdetail"];
    return null;
  }

  /** every state change: the shell (screensCross/app.ts) repaints from the controller's state */
  draw(): void {
    if (this.disposed) return;
    // the inspected player left the slot: the room's left panel goes back to mine
    const ins = this.inspect, r = this.roomScreen?.room;
    if (ins && this.page === "room" && !r?.slots.some((x) => x.slot === ins.slot && (x.state >= WIRE_SLOT.SHOP || !!x.nick))) this.inspect = null;
    this.deps.render();
  }
}
