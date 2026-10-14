// Plugin.Core/Models player sub-models (PlayerEquipment, PlayerBonus, PlayerConfig, PlayerEvent, PlayerTitles,
// PlayerMissions, PlayerCharacters, PlayerInventory, PlayerStatistic, ...) with the same C# constructor defaults.
// The default values matter: a sub-loader that finds no DB row creates one but keeps these in-memory defaults.
import { ItemsModel } from "./items.ts";
import { NO_FAKE_RANK, csFloorInt } from "./rank.ts";

export class PlayerEquipment {
  weaponPrimary = 103004;
  weaponSecondary = 202022;
  weaponMelee = 301012;
  weaponExplosive = 407001;
  weaponSpecial = 508002;
  charaRedId = 601001;
  charaBlueId = 602002;
  partHead = 0;
  partFace = 0;
  partJacket = 0;
  partPocket = 0;
  partGlove = 0;
  partBelt = 0;
  partHolster = 0;
  partSkin = 0;
  dinoItem = 1500511;
  beretItem = 0;
  accessoryId = 0;
  sprayId = 0;
  nameCardId = 0;
  emoticons = [0, 0, 0, 0, 0, 0];
}

export class PlayerBonus {
  bonuses = 0;
  crosshairColor = 4;
  freePass = 0;
  fakeRank = NO_FAKE_RANK;
  fakeNick = "";
  muzzleColor = 0;
  nickBorderColor = 0;
}

export class PlayerConfig {
  config = 55;
  showBlood = 11;
  crosshair = 2;
  handPosition = 0;
  audioSFX = 100;
  audioBGM = 60;
  audioEnable = 7;
  sensitivity = 50;
  pointOfView = 80;
  invertMouse = 0;
  enableInviteMsg = 0;
  enableWhisperMsg = 0;
  macro = 31;
  macro1 = "";
  macro2 = "";
  macro3 = "";
  macro4 = "";
  macro5 = "";
  nations = 0;
  keyboardKeys: Uint8Array = new Uint8Array(240);
}

export class PlayerEvent {
  lastVisitCheckDay = 0;
  lastVisitSeqType = 0;
  lastVisitDate = 0;
  lastXmasDate = 0;
  lastPlaytimeDate = 0;
  lastPlaytimeValue = 0;
  lastPlaytimeFinish = 0;
  lastLoginDate = 0;
  lastQuestDate = 0;
  lastQuestFinish = 0;
  currentPlaytimeEventId = 0;
  playtimeCompletedLevels = "";
  lastVisitRewardDay = 0;
}

export class PlayerTitles {
  equiped1 = 0;
  equiped2 = 0;
  equiped3 = 0;
  flags = 0n;
  slots = 1;
}

export interface QuickstartModel { mapId: number; rule: number; stageOptions: number; type: number }

export class PlayerBattlepass {
  battlepassId = 0;
  battlepassPremiumLevel = 0;
  battlepassNormalLevel = 0;
  havePremium = false;
  earnedPoints = 0;
  dailyPoints = 0;
  lastRecord = 0;
}

export class PlayerCompetitive { level = 0; points = 0 }
export class PlayerReport { ticketCount = 0; reportedCount = 0 }

export const MISSION_SLOTS = 4;
export const MISSION_PROGRESS_SIZE = 40;
export class MissionSlot {
  cardSetId = 0;
  currentCard = 0;
  progress: Uint8Array = new Uint8Array(MISSION_PROGRESS_SIZE);
  get isEmpty(): boolean { return this.cardSetId === 0; }
  clone(): MissionSlot { const m = new MissionSlot(); m.cardSetId = this.cardSetId; m.currentCard = this.currentCard; m.progress = this.progress.slice(); return m; }
}
export class PlayerMissions {
  actualMission = 0;
  selectedCard = false;
  readonly slots = Array.from({ length: MISSION_SLOTS }, () => new MissionSlot());
  /** this[index]: out-of-range indexes read slot 0. */
  at(i: number): MissionSlot { return this.slots[i < 0 || i >= MISSION_SLOTS ? 0 : i]; }
  get current(): MissionSlot { return this.at(this.actualMission); }
  ownsCardSet(id: number): boolean { return id > 0 && this.slots.some((s) => s.cardSetId === id); }
  findFreeSlot(): number { return this.slots.findIndex((s) => s.isEmpty); }
  firstOwnedSlot(): number { const i = this.slots.findIndex((s) => !s.isEmpty); return i < 0 ? 0 : i; }
  /** PlayerMissions.Clone (SlotModel.SetMissionsClone): deep copy, so a battle never touches the live cards. */
  clone(): PlayerMissions {
    const m = new PlayerMissions();
    m.actualMission = this.actualMission; m.selectedCard = this.selectedCard;
    this.slots.forEach((s, i) => { m.slots[i] = s.clone(); });
    return m;
  }
}

export interface CharacterModel { objectId: bigint; id: number; slot: number; name: string; createDate: number; playTime: number }

export class PlayerCharacters {
  characters: CharacterModel[] = [];
  getCharacter(id: number): CharacterModel | null { return this.characters.find((c) => c.id === id) ?? null; }
  getCharacterSlot(slot: number): CharacterModel | null { return this.characters.find((c) => c.slot === slot) ?? null; }
}

export class PlayerInventory {
  items: ItemsModel[] = [];
  getItem(id: number): ItemsModel | null { return this.items.find((i) => i.id === id) ?? null; }
  getItemByObject(objectId: bigint): ItemsModel | null { return this.items.find((i) => i.objectId === objectId) ?? null; }
}

export interface FriendModel { playerId: bigint; objectId: bigint; state: number; removed: boolean }

export type Stat = Record<string, number>;
export const statFields = {
  basic: ["matches", "matchWins", "matchLoses", "matchDraws", "killsCount", "deathsCount", "headshotsCount", "assistsCount", "escapesCount", "mvpCount", "totalMatchesCount", "totalKillsCount"],
  season: ["matches", "matchWins", "matchLoses", "matchDraws", "killsCount", "deathsCount", "headshotsCount", "assistsCount", "escapesCount", "mvpCount", "totalMatchesCount", "totalKillsCount"],
  clan: ["matches", "matchWins", "matchLoses"],
  daily: ["matches", "matchWins", "matchLoses", "matchDraws", "killsCount", "deathsCount", "headshotsCount", "expGained", "pointGained", "playtime"],
  weapon: ["assaultKills", "assaultDeaths", "smgKills", "smgDeaths", "sniperKills", "sniperDeaths", "machinegunKills", "machinegunDeaths", "shotgunKills", "shotgunDeaths", "shieldKills", "shieldDeaths"],
  acemode: ["matches", "matchWins", "matchLoses", "kills", "deaths", "headshots", "assists", "escapes", "winstreaks"],
  battlecup: ["matches", "matchWins", "matchLoses", "killsCount", "deathsCount", "headshotsCount", "assistsCount", "escapesCount", "averageDamage", "playTime"],
  mercenary: ["matches", "matchWins", "matchLoses", "dropsCount", "killsCount", "deathsCount", "headshotsCount", "assistsCount"],
} as const;
export type StatKind = keyof typeof statFields;
export const newStat = (k: StatKind): Stat => Object.fromEntries(statFields[k].map((f) => [f, 0]));

export class PlayerStatistic {
  basic: Stat | null = null;
  season: Stat | null = null;
  clan: Stat | null = null;
  daily: Stat | null = null;
  weapon: Stat | null = null;
  acemode: Stat | null = null;
  battlecup: Stat | null = null;
  mercenary: Stat | null = null;
}

/** PlayerStatistic.GetBCWinRatio / GetBCKDRatio (C# int math incl. the odd guards). */
export function bcWinRatio(b: Stat): number {
  return b.matchWins <= 0 && b.matches <= 0 ? 0 : csFloorInt((b.matchWins * 100 + 0.5) / (b.matchWins + b.matchLoses));
}
export function bcKDRatio(b: Stat): number {
  return b.headshotsCount <= 0 && b.killsCount <= 0 ? 0 : csFloorInt((b.killsCount * 100 + 0.5) / (b.killsCount + b.deathsCount));
}
