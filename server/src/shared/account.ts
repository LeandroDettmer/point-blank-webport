// Server.Auth/Data/Models/Account.cs + Server.Game/Data/Models/Account.cs (the fields both servers read from
// `accounts` plus the sub-models). One class serves both TS servers.
import {
  PlayerEquipment, PlayerBonus, PlayerConfig, PlayerEvent, PlayerTitles, PlayerBattlepass, PlayerCompetitive,
  PlayerReport, PlayerMissions, PlayerCharacters, PlayerInventory, PlayerStatistic, type FriendModel, type QuickstartModel,
} from "./models.ts";
import { resolveRank, isStaffRank } from "./rank.ts";
import type { ClanModel } from "./dao.ts";

export const AccessLevel = { BANNED: -1, NORMAL: 0, VIP: 2, MODERATOR: 50, GAMEMASTER: 100 } as const;
export const isDefinedAccess = (v: number) => v === -1 || v === 0 || v === 2 || v === 50 || v === 100;

/** Plugin.Core/Models/AccountStatus.cs: u32 [channel, room, server, clanMatch]. */
export class AccountStatus {
  channelId = 0;
  roomId = 0;
  serverId = 0;
  clanMatchId = 0;
  get buffer(): number {
    return ((this.channelId & 0xff) | ((this.roomId & 0xff) << 8) | ((this.serverId & 0xff) << 16) | ((this.clanMatchId & 0xff) << 24)) >>> 0;
  }
  /** ResetData: SetData(uint.MaxValue); returns whether anything changed (the caller writes accounts.status). */
  reset(): boolean { const before = this.buffer; this.setData(0xffffffff); return before !== 0xffffffff; }
  setData(v: number): void {
    this.channelId = v & 0xff;
    this.roomId = (v >>> 8) & 0xff;
    this.serverId = (v >>> 16) & 0xff;
    this.clanMatchId = (v >>> 24) & 0xff;
  }
}

export class Account {
  playerId = 0n;
  username = "";
  password = "";
  email = "";
  age = 0;
  nickname = "";
  nickColor = 0;
  rank = 0;
  exp = 0;
  gold = 0;
  cash = 0;
  cafePC = 0;
  access = 0;
  isOnline = false;
  clanId = 0;
  clanAccess = 0;
  clanDate = 0;
  effects = 0n;
  lastRankUpDate = 0;
  banObjectId = 0n;
  ribbon = 0;
  ensign = 0;
  medal = 0;
  masterMedal = 0;
  tags = 0;
  inventoryPlus = 0;
  countryFlags = 0;
  ip4Address = "";
  macAddress = "";
  token = "";
  status = new AccountStatus();

  // Game-side runtime state (Server.Game Account): channel/room/slot and the session.
  serverId = -1;
  channelId = -1;
  slotId = -1;
  /** RoomModel (typed in the game module; kept opaque here to avoid a shared -> game import) */
  room: object | null = null;
  session: { sessionId: number; playerId: bigint } | null = null;
  /** GameClient (opaque here) */
  connection: object | null = null;
  lastRoomPage = 0;
  lastPlayerPage = 0;
  missionCardBootstrap = 0;
  loadedShop = false;
  findClanId = 0;
  findPlayer = "";
  /** ClanManager.GetClan(ClanId) cache (default ClanModel when no clan) */
  clan: ClanModel = { id: 0, rank: 0, exp: 0, name: "", ownerId: 0n, logo: 0xffffffff, nameColor: 0, effect: 0, unit: 0 };
  hideGMcolor = false;
  antiKickGM = false;
  refreshLobbyInfo = false;
  updateSeasonpass = false;
  /** Last* throttles (ms epoch), all start at construction like the C# ctor */
  last: Record<string, number> = {};
  lastAt(k: string): number { return this.last[k] ?? this.createdAt.getTime(); }
  durationSince(k: string): number { return (Date.now() - this.lastAt(k)) / 1000; }

  /** Account() ctor: every Last* throttle timestamp starts at construction time. */
  readonly createdAt = new Date();
  lastLoginDate = this.createdAt;

  config = new PlayerConfig();
  myConfigsLoaded = false;
  bonus = new PlayerBonus();
  event = new PlayerEvent();
  title = new PlayerTitles();
  inventory = new PlayerInventory();
  statistic = new PlayerStatistic();
  character = new PlayerCharacters();
  equipment = new PlayerEquipment();
  friends: FriendModel[] = [];
  quickjoins: QuickstartModel[] = [];
  mission = new PlayerMissions();
  report = new PlayerReport();
  battlepass = new PlayerBattlepass();
  competitive = new PlayerCompetitive();

  getRank(): number { return resolveRank(this.rank, this.bonus ? this.bonus.fakeRank : 255); }
  getDisplayRank(): number { return this.getRank(); }

  /** Account.AuthLevel(). Game: ranks 53/58 GM, 54/59 MOD; Auth (authSide): only 58 GM, 59 MOD. */
  authSide = false;
  authLevel(): number {
    if (this.access === AccessLevel.BANNED) return AccessLevel.BANNED;
    if (this.access >= AccessLevel.GAMEMASTER) return AccessLevel.GAMEMASTER;
    if (this.access >= AccessLevel.MODERATOR) return AccessLevel.MODERATOR;
    switch (this.rank) {
      case 53: return this.authSide ? AccessLevel.NORMAL : AccessLevel.GAMEMASTER;
      case 54: return this.authSide ? AccessLevel.NORMAL : AccessLevel.MODERATOR;
      case 58: return AccessLevel.GAMEMASTER;
      case 59: return AccessLevel.MODERATOR;
      default: return AccessLevel.NORMAL;
    }
  }
  isGM(): boolean { return this.authLevel() > AccessLevel.NORMAL; }
  useChatGM(hideGMcolor = false): boolean {
    return !hideGMcolor && (this.rank === 53 || this.rank === 54 || this.rank === 58 || this.rank === 59 || isStaffRank(this.rank));
  }
}
