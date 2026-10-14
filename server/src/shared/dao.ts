// Plugin.Core/SQL/DaoManagerSQL.cs + ComDiv.UpdateDB/DeleteDB, the part shared by Auth and Game: the account row and
// the Account.GetAccountInfos(LoadType) sub-loaders. Each loader mirrors AllUtils.LoadPlayerX: Get...DB, and when
// there is no row Create...DB (INSERT defaults) while the in-memory model keeps its C# constructor defaults.
import { pool } from "../db.ts";
import { Account } from "./account.ts";
import { ItemsModel } from "./items.ts";
import {
  PlayerEquipment, PlayerBonus, PlayerConfig, PlayerEvent, PlayerTitles, PlayerBattlepass, PlayerCompetitive, PlayerReport,
  PlayerMissions, MISSION_SLOTS, MISSION_PROGRESS_SIZE, statFields, type Stat, type StatKind, type CharacterModel,
  type FriendModel, type QuickstartModel,
} from "./models.ts";

const int = (v: unknown) => (v == null ? 0 : Number(v));
const u32 = (v: unknown) => int(v) >>> 0;
const str = (v: unknown) => (v == null ? "" : String(v));
const id = (pid: bigint) => String(pid);

const log = (m: string) => console.log(`${new Date().toISOString()} [dao] ${m}`);

/** ComDiv.UpdateDB(table, keyCol, keyVal, cols[], vals[]) / UpdateDB(table, col, val, keyCol, keyVal). */
export async function updateDB(table: string, keyCol: string, keyVal: unknown, cols: string[], vals: unknown[]): Promise<boolean> {
  if (cols.length === 0) return false;
  try {
    const set = cols.map((c, i) => `${c}=$${i + 1}`).join(", ");
    await pool.query(`UPDATE ${table} SET ${set} WHERE ${keyCol}=$${cols.length + 1}`, [...vals.map(dbVal), dbVal(keyVal)]);
    return true;
  } catch (e) {
    log(`UpdateDB ${table}: ${(e as Error).message}`);
    return false;
  }
}
export const update1 = (table: string, col: string, val: unknown, keyCol: string, keyVal: unknown) => updateDB(table, keyCol, keyVal, [col], [val]);

type Wallet = Pick<Account, "playerId" | "gold" | "cash" | "tags">;

/**
 * [web] Every gold / cash / tags change: one conditional UPDATE by delta, never the absolute balance of
 * the in-memory copy (the C# ComDiv.UpdateDB wrote `p.Gold - price`, so two writers of one account made the last write win and
 * a purchase free). A debit passes only while the row still holds it, so two packets / sessions spending the same balance cannot
 * both pass. The row's balance is read back into `a` either way. false = not enough (nothing written) or a DB error.
 */
export async function addMoney(a: Wallet, gold: number, cash = 0, tags = 0): Promise<boolean> {
  if (!gold && !cash && !tags) return true;
  try {
    const r = await pool.query(
      `UPDATE accounts SET gold = gold + $1::int, cash = cash + $2::int, tags = tags + $3::int
        WHERE player_id = $4 AND ($1::int >= 0 OR gold >= -$1::int) AND ($2::int >= 0 OR cash >= -$2::int) AND ($3::int >= 0 OR tags >= -$3::int)
        RETURNING gold, cash, tags`, [gold, cash, tags, id(a.playerId)]);
    const x = r.rows[0] ?? (await one(`SELECT gold, cash, tags FROM accounts WHERE player_id = $1`, [id(a.playerId)]));
    if (x) { a.gold = int(x.gold); a.cash = int(x.cash); a.tags = int(x.tags); }
    return r.rows.length > 0;
  } catch (e) {
    log(`addMoney ${a.playerId} (${gold}/${cash}/${tags}): ${(e as Error).message}`);
    return false;
  }
}

/** ComDiv.DeleteDB(table, col, values[], col2, val2). */
export async function deleteDB(table: string, col: string, values: unknown[], col2: string, val2: unknown): Promise<boolean> {
  try {
    await pool.query(`DELETE FROM ${table} WHERE ${col} = ANY($1) AND ${col2}=$2`, [values.map(dbVal), dbVal(val2)]);
    return true;
  } catch (e) {
    log(`DeleteDB ${table}: ${(e as Error).message}`);
    return false;
  }
}

function dbVal(v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

async function one(sql: string, args: unknown[]): Promise<Record<string, unknown> | null> {
  const r = await pool.query(sql, args);
  return r.rows[0] ?? null;
}

async function tryExec(what: string, sql: string, args: unknown[]): Promise<boolean> {
  try {
    await pool.query(sql, args);
    return true;
  } catch (e) {
    log(`${what}: ${(e as Error).message}`);
    return false;
  }
}

// ---- account row -------------------------------------------------------------------------------------------------

/** AccountManager.GetAccountDB field copy (both servers read the same columns). */
export function applyAccountRow(a: Account, x: Record<string, unknown>): void {
  a.playerId = BigInt(x.player_id as string);
  a.username = str(x.username);
  a.password = str(x.password);
  a.email = str(x.email);
  a.age = int(x.age);
  a.ip4Address = str(x.ip4_address);
  a.macAddress = str(x.mac_address);
  a.nickname = str(x.nickname);
  a.nickColor = int(x.nick_color);
  a.rank = int(x.rank);
  a.exp = int(x.experience);
  a.gold = int(x.gold);
  a.cash = int(x.cash);
  a.cafePC = int(x.pc_cafe);
  a.access = int(x.access_level);
  a.isOnline = !!x.online;
  a.clanId = int(x.clan_id);
  a.clanAccess = int(x.clan_access);
  a.clanDate = u32(x.clan_date);
  a.effects = BigInt(str(x.coupon_effect) || "0");
  a.status.setData(u32(x.status));
  a.lastRankUpDate = u32(x.last_rank_update);
  a.banObjectId = BigInt(str(x.ban_object_id) || "0");
  a.ribbon = int(x.ribbon);
  a.ensign = int(x.ensign);
  a.medal = int(x.medal);
  a.masterMedal = int(x.master_medal);
  a.tags = int(x.tags);
  a.inventoryPlus = int(x.inventory_plus);
  a.countryFlags = int(x.country_flags);
  a.token = str(x.token);
}

/** AccountManager.GetAccountDB(value, type, searchFlag): type 0 token, 1/2 player_id (Game uses 2 for the id). */
export async function getAccountDB(by: "token" | "player_id" | "nickname", value: string | bigint, searchFlag: number, authSide = false): Promise<Account | null> {
  if ((by !== "player_id" && !value) || (by === "player_id" && BigInt(value) === 0n)) return null;
  const x = await one(`SELECT * FROM accounts WHERE ${by}=$1 LIMIT 1`, [dbVal(value)]);
  if (!x) return null;
  const a = new Account();
  a.authSide = authSide;
  a.playerId = BigInt(x.player_id as string);
  await getAccountInfos(a, searchFlag);
  applyAccountRow(a, x);
  return a;
}

/** Account.SetPlayerId(id, LoadType) -> GetAccountInfos: one sub-loader per bit; 4096 set = skip competitive. */
export async function getAccountInfos(a: Account, loadType: number): Promise<void> {
  if (!(loadType > 0 || a.playerId > 0n)) return;
  if (loadType & 1) await loadPlayerEquipments(a);
  if (loadType & 2) await loadPlayerCharacters(a);
  if (loadType & 4) await loadPlayerStatistic(a);
  if (loadType & 8) await loadPlayerTitles(a);
  if (loadType & 16) await loadPlayerBonus(a);
  if (loadType & 32) await loadPlayerFriend(a);
  if (loadType & 64) await loadPlayerEvent(a);
  if (loadType & 128) await loadPlayerConfig(a);
  if (loadType & 256) await loadPlayerFriend(a);
  if (loadType & 512) await loadPlayerQuickstarts(a);
  if (loadType & 1024) await loadPlayerReport(a);
  if (loadType & 2048) await loadPlayerBattlepass(a);
  if ((loadType & 4096) !== 4096) await loadPlayerCompetitive(a);
}

// ---- sub-loaders ---------------------------------------------------------------------------------------------------

async function getOrCreate(table: string, owner: bigint, what: string, insert = `INSERT INTO ${table}(owner_id) VALUES($1)`): Promise<Record<string, unknown> | null> {
  const x = await one(`SELECT * FROM ${table} WHERE owner_id=$1`, [id(owner)]);
  if (x) return x;
  if (!(await tryExec(`Create ${table}`, insert, [id(owner)]))) log(`There was an error when creating ${what}!`);
  return null;
}

export async function loadPlayerEquipments(a: Account): Promise<void> {
  const x = await getOrCreate("player_equipments", a.playerId, "Player Equipment");
  if (!x) return;
  const e = new PlayerEquipment();
  e.weaponPrimary = int(x.weapon_primary); e.weaponSecondary = int(x.weapon_secondary); e.weaponMelee = int(x.weapon_melee);
  e.weaponExplosive = int(x.weapon_explosive); e.weaponSpecial = int(x.weapon_special);
  e.charaRedId = int(x.chara_red_side); e.charaBlueId = int(x.chara_blue_side); e.dinoItem = int(x.dino_item_chara);
  e.partHead = int(x.part_head); e.partFace = int(x.part_face); e.partJacket = int(x.part_jacket); e.partPocket = int(x.part_pocket);
  e.partGlove = int(x.part_glove); e.partBelt = int(x.part_belt); e.partHolster = int(x.part_holster); e.partSkin = int(x.part_skin);
  e.beretItem = int(x.beret_item_part); e.accessoryId = int(x.accesory_id); e.sprayId = int(x.spray_id); e.nameCardId = int(x.namecard_id);
  e.emoticons = [0, 1, 2, 3, 4, 5].map((i) => int(x[`emoticon_${i}`]));
  a.equipment = e;
}

/** DaoManagerSQL.GetPlayerCharactersDB: ORDER BY slot ASC; an empty result keeps the current list. */
export async function loadPlayerCharacters(a: Account): Promise<void> {
  const r = await pool.query(`SELECT * FROM player_characters WHERE owner_id=$1 ORDER BY slot ASC`, [id(a.playerId)]);
  if (r.rows.length <= 0) return;
  a.character.characters = r.rows.map((x): CharacterModel => ({
    objectId: BigInt(x.object_id), id: int(x.id), slot: int(x.slot), name: str(x.name), createDate: u32(x.create_date), playTime: u32(x.playtime),
  }));
}

const statTables: Record<StatKind, [string, Record<string, string>]> = {
  basic: ["player_stat_basics", { matches: "matches", matchWins: "match_wins", matchLoses: "match_loses", matchDraws: "match_draws", killsCount: "kills_count", deathsCount: "deaths_count", headshotsCount: "headshots_count", assistsCount: "assists_count", escapesCount: "escapes_count", mvpCount: "mvp_count", totalMatchesCount: "total_matches", totalKillsCount: "total_kills" }],
  season: ["player_stat_seasons", { matches: "matches", matchWins: "match_wins", matchLoses: "match_loses", matchDraws: "match_draws", killsCount: "kills_count", deathsCount: "deaths_count", headshotsCount: "headshots_count", assistsCount: "assists_count", escapesCount: "escapes_count", mvpCount: "mvp_count", totalMatchesCount: "total_matches", totalKillsCount: "total_kills" }],
  clan: ["player_stat_clans", { matches: "clan_matches", matchWins: "clan_match_wins", matchLoses: "clan_match_loses" }],
  daily: ["player_stat_dailies", { matches: "matches", matchWins: "match_wins", matchLoses: "match_loses", matchDraws: "match_draws", killsCount: "kills_count", deathsCount: "deaths_count", headshotsCount: "headshots_count", expGained: "exp_gained", pointGained: "point_gained", playtime: "playtime" }],
  weapon: ["player_stat_weapons", { assaultKills: "assault_rifle_kills", assaultDeaths: "assault_rifle_deaths", smgKills: "sub_machine_gun_kills", smgDeaths: "sub_machine_gun_deaths", sniperKills: "sniper_rifle_kills", sniperDeaths: "sniper_rifle_deaths", machinegunKills: "machine_gun_kills", machinegunDeaths: "machine_gun_deaths", shotgunKills: "shot_gun_kills", shotgunDeaths: "shot_gun_deaths" }],
  acemode: ["player_stat_acemodes", { matches: "matches", matchWins: "match_wins", matchLoses: "match_loses", kills: "kills_count", deaths: "deaths_count", headshots: "headshots_count", assists: "assists_count", escapes: "escapes_count", winstreaks: "winstreaks_count" }],
  battlecup: ["player_stat_battlecups", { matches: "matches", matchWins: "match_wins", matchLoses: "match_loses", killsCount: "kills_count", deathsCount: "deaths_count", headshotsCount: "headshots_count", assistsCount: "assists_count", escapesCount: "escapes_count" }],
  mercenary: ["player_stat_mercenaries", { matches: "matches", matchWins: "match_wins", matchLoses: "match_loses", dropsCount: "drops_count", killsCount: "kills_count", deathsCount: "deaths_count", headshotsCount: "headshots_count", assistsCount: "assists_count" }],
};
export const statTable = (k: StatKind) => statTables[k][0];
export const statColumn = (k: StatKind, field: string) => statTables[k][1][field];

/** AllUtils.LoadPlayerStatistic: basic, season, clan, daily, weapon, acemode, mercenary, battlecup (in this order). */
export async function loadPlayerStatistic(a: Account): Promise<void> {
  for (const k of ["basic", "season", "clan", "daily", "weapon", "acemode", "mercenary", "battlecup"] as StatKind[]) {
    const [table, cols] = statTables[k];
    const x = await getOrCreate(table, a.playerId, `Player ${k} Statistic`);
    if (!x) continue;
    const s: Stat = Object.fromEntries(statFields[k].map((f) => [f, 0]));
    for (const [f, c] of Object.entries(cols)) s[f] = int(x[c]);
    if (k === "daily") s.playtime = u32(x.playtime);
    a.statistic[k] = s;
  }
}

export async function loadPlayerTitles(a: Account): Promise<void> {
  const x = await getOrCreate("player_titles", a.playerId, "Player Title");
  if (!x) return;
  const t = new PlayerTitles();
  t.equiped1 = int(x.equip_slot1); t.equiped2 = int(x.equip_slot2); t.equiped3 = int(x.equip_slot3);
  t.flags = BigInt(str(x.flags) || "0"); t.slots = int(x.slots);
  a.title = t;
}

export async function loadPlayerBonus(a: Account): Promise<void> {
  const x = await getOrCreate("player_bonus", a.playerId, "Player Bonus");
  if (!x) return;
  const b = new PlayerBonus();
  b.bonuses = int(x.bonuses); b.crosshairColor = int(x.crosshair_color); b.freePass = int(x.free_pass);
  b.fakeRank = int(x.fake_rank); b.fakeNick = str(x.fake_nick); b.muzzleColor = int(x.muzzle_color); b.nickBorderColor = int(x.nick_border_color);
  a.bonus = b;
}

/** AllUtils.LoadPlayerFriend (the LoadFullDatabase account lookup of each friend is F5). */
export async function loadPlayerFriend(a: Account): Promise<void> {
  const r = await pool.query(`SELECT * FROM player_friends WHERE owner_id=$1 ORDER BY id`, [id(a.playerId)]);
  if (r.rows.length <= 0) return;
  a.friends = r.rows.map((x): FriendModel => ({ playerId: BigInt(x.id), objectId: BigInt(x.object_id), state: int(x.state), removed: !!x.removed }));
}

export async function loadPlayerEvent(a: Account): Promise<void> {
  const x = await one(
    `SELECT owner_id, last_visit_check_day, last_visit_seq_type, last_visit_date, last_xmas_date, last_playtime_date, last_playtime_value,
            last_playtime_finish, last_login_date, last_quest_date, last_quest_finish, current_playtime_event_id, playtime_completed_levels,
            last_visit_reward_day FROM player_events WHERE owner_id = $1`, [id(a.playerId)]);
  if (!x) {
    if (!(await tryExec("CreatePlayerEventDB", `INSERT INTO player_events (owner_id) VALUES ($1)`, [id(a.playerId)]))) log("There was an error when creating Player Event!");
    return;
  }
  const e = new PlayerEvent();
  e.lastVisitCheckDay = int(x.last_visit_check_day); e.lastVisitSeqType = int(x.last_visit_seq_type);
  e.lastVisitDate = u32(x.last_visit_date); e.lastXmasDate = u32(x.last_xmas_date); e.lastPlaytimeDate = u32(x.last_playtime_date);
  e.lastPlaytimeValue = int(x.last_playtime_value); e.lastPlaytimeFinish = int(x.last_playtime_finish); e.lastLoginDate = u32(x.last_login_date);
  e.lastQuestDate = u32(x.last_quest_date); e.lastQuestFinish = int(x.last_quest_finish); e.currentPlaytimeEventId = int(x.current_playtime_event_id);
  e.playtimeCompletedLevels = str(x.playtime_completed_levels); e.lastVisitRewardDay = int(x.last_visit_reward_day);
  a.event = e;
}

export async function loadPlayerConfig(a: Account): Promise<void> {
  const x = await getOrCreate("player_configs", a.playerId, "Player Config");
  if (!x) return;
  const c = new PlayerConfig();
  c.config = int(x.configs); c.showBlood = int(x.show_blood); c.crosshair = int(x.crosshair); c.handPosition = int(x.hand_pos);
  c.audioSFX = int(x.audio_sfx); c.audioBGM = int(x.audio_bgm); c.audioEnable = int(x.audio_enable); c.sensitivity = int(x.sensitivity);
  c.pointOfView = int(x.pov_size); c.invertMouse = int(x.invert_mouse); c.enableInviteMsg = int(x.enable_invite);
  c.enableWhisperMsg = int(x.enable_whisper); c.macro = int(x.macro_enable);
  c.macro1 = str(x.macro1); c.macro2 = str(x.macro2); c.macro3 = str(x.macro3); c.macro4 = str(x.macro4); c.macro5 = str(x.macro5);
  c.nations = int(x.nations);
  const keys = x.keyboard_keys as Buffer | null;
  if (keys) c.keyboardKeys.set(keys.subarray(0, 240));
  a.config = c;
}

export async function loadPlayerQuickstarts(a: Account): Promise<void> {
  const x = await getOrCreate("player_quickstarts", a.playerId, "Player Quickstarts");
  if (!x) return;
  const q: QuickstartModel[] = [];
  for (let i = 0; i < 3; i++) {
    q.push({ mapId: int(x[`list${i}_map_id`]) & 0xff, rule: int(x[`list${i}_map_rule`]) & 0xff, stageOptions: int(x[`list${i}_map_stage`]) & 0xff, type: int(x[`list${i}_map_type`]) & 0xff });
  }
  a.quickjoins = q;
}

export async function loadPlayerReport(a: Account): Promise<void> {
  const x = await getOrCreate("player_reports", a.playerId, "Player Report");
  if (!x) return;
  const r = new PlayerReport();
  r.ticketCount = int(x.ticket_count); r.reportedCount = int(x.reported_count);
  a.report = r;
}

export async function loadPlayerBattlepass(a: Account): Promise<void> {
  const x = await getOrCreate("player_battlepass", a.playerId, "Player Battlepass", `INSERT INTO player_battlepass VALUES($1)`);
  if (!x) return;
  const b = new PlayerBattlepass();
  b.battlepassId = int(x.battlepass_id); b.battlepassPremiumLevel = int(x.battlepass_premium_levels);
  b.battlepassNormalLevel = int(x.battlepass_normal_levels); b.havePremium = !!x.battlepass_premium;
  b.earnedPoints = int(x.earned_points); b.dailyPoints = int(x.points); b.lastRecord = u32(x.last_record);
  a.battlepass = b;
}

export async function loadPlayerCompetitive(a: Account): Promise<void> {
  const x = await getOrCreate("player_competitive", a.playerId, "Player Competitive", `INSERT INTO player_competitive VALUES($1)`);
  if (!x) return;
  const c = new PlayerCompetitive();
  c.level = int(x.level); c.points = int(x.points);
  a.competitive = c;
}

// ---- inventory, characters, missions --------------------------------------------------------------------------------

/** DaoManagerSQL.GetPlayerInventoryItems. */
export async function getPlayerInventoryItems(owner: bigint): Promise<ItemsModel[]> {
  if (owner === 0n) return [];
  const r = await pool.query(`SELECT * FROM player_items WHERE owner_id=$1 ORDER BY object_id ASC`, [id(owner)]);
  return r.rows.map((x) => {
    const it = new ItemsModel(int(x.id));
    it.objectId = BigInt(x.object_id);
    it.name = str(x.name);
    it.count = u32(x.count);
    it.equip = int(x.equip);
    return it;
  });
}

/** DaoManagerSQL.CreatePlayerCharacter: INSERT ... RETURNING object_id (player_characters_seq owns the key). */
export async function createPlayerCharacter(c: CharacterModel, owner: bigint): Promise<boolean> {
  if (owner === 0n) return false;
  try {
    const r = await pool.query(
      `INSERT INTO player_characters(owner_id, id, slot, name, create_date, playtime) VALUES($1, $2, $3, $4, $5, $6) RETURNING object_id`,
      [id(owner), c.id, c.slot, c.name, c.createDate, c.playTime]);
    c.objectId = BigInt(r.rows[0].object_id);
    return true;
  } catch (e) {
    log(`CreatePlayerCharacter: ${(e as Error).message}`);
    return false;
  }
}

export const updatePlayerCharacter = (slot: number, objectId: bigint, owner: bigint) =>
  tryExec("UpdatePlayerCharacter", `UPDATE player_characters SET slot=$1 WHERE object_id=$2 AND owner_id=$3`, [slot, id(objectId), id(owner)]);
export const deletePlayerCharacter = (objectId: bigint, owner: bigint) =>
  tryExec("DeletePlayerCharacter", `DELETE FROM player_characters WHERE object_id=$1 AND owner_id=$2`, [id(objectId), id(owner)]);

/** DaoManagerSQL.GetPlayerMissionsDB: null when there is no player_missions row. */
export async function getPlayerMissionsDB(owner: bigint): Promise<PlayerMissions | null> {
  if (owner === 0n) return null;
  const head = await one(`SELECT current_mission FROM player_missions WHERE owner_id=$1`, [id(owner)]);
  if (!head) return null;
  const m = new PlayerMissions();
  m.actualMission = int(head.current_mission);
  const r = await pool.query(`SELECT slot, card_set_id, current_card, progress FROM player_mission_slots WHERE owner_id=$1`, [id(owner)]);
  for (const x of r.rows) {
    const slot = int(x.slot);
    if (slot < 0 || slot >= MISSION_SLOTS) continue;
    const t = m.at(slot);
    t.cardSetId = int(x.card_set_id);
    t.currentCard = int(x.current_card);
    t.progress = new Uint8Array(MISSION_PROGRESS_SIZE);
    if (x.progress) t.progress.set((x.progress as Buffer).subarray(0, MISSION_PROGRESS_SIZE));
  }
  if (m.current.isEmpty) m.actualMission = m.firstOwnedSlot(); // NormalizeActiveSlot
  return m;
}

/** DaoManagerSQL.UpdatePlayerMissionSlotProgress (+ current_card): the 40-byte task counters of one slot. Upsert: the event set (13)
 * is granted in memory at login with no row, so its first save must create it (card_set_id kept on conflict). */
export const updatePlayerMissionSlotProgress = (owner: bigint, slot: number, progress: Uint8Array, currentCard: number, cardSetId: number) =>
  tryExec("UpdatePlayerMissionSlotProgress", `INSERT INTO player_mission_slots(owner_id, slot, card_set_id, current_card, progress) VALUES($3, $4, $5, $2, $1)
    ON CONFLICT (owner_id, slot) DO UPDATE SET progress=EXCLUDED.progress, current_card=EXCLUDED.current_card`, [Buffer.from(progress), currentCard, id(owner), slot, cardSetId]);

export const createPlayerMissionsDB = (owner: bigint) =>
  tryExec("CreatePlayerMissionsDB", `INSERT INTO player_missions(owner_id) VALUES($1)`, [id(owner)]);

/** DaoManagerSQL.GetPlayerVIP. */
export async function getPlayerVIP(owner: bigint): Promise<{ address: string; benefit: string; expirate: number } | null> {
  const x = await one(`SELECT * FROM player_vip WHERE owner_id=$1`, [id(owner)]);
  return x ? { address: str(x.registered_ip), benefit: str(x.last_benefit), expirate: u32(x.expirate) } : null;
}

export const updatePlayerBonus = (owner: bigint, bonuses: number, freePass: number) =>
  tryExec("UpdatePlayerBonus", `UPDATE player_bonus SET bonuses=$1, free_pass=$2 WHERE owner_id=$3`, [bonuses, freePass, id(owner)]);

/** DaoManagerSQL.GetClanPlayers(ClanId): 0 for clan 0. */
export async function getClanPlayers(clanId: number): Promise<number> {
  if (clanId === 0) return 0;
  const x = await one(`SELECT COUNT(*) AS n FROM accounts WHERE clan_id=$1`, [clanId]);
  return int(x?.n);
}

export interface ClanModel { id: number; rank: number; exp: number; name: string; ownerId: bigint; logo: number; nameColor: number; effect: number; unit: number }
/** ClanManager.GetClanDB(id, 1) + ClanModel.GetClanUnit(). */
export async function getClanDB(clanId: number): Promise<ClanModel> {
  const def: ClanModel = { id: 0, rank: 0, exp: 0, name: "", ownerId: 0n, logo: 0xffffffff, nameColor: 0, effect: 0, unit: 0 };
  if (clanId <= 0) return def;
  const x = await one(`SELECT * FROM system_clan WHERE id=$1`, [clanId]);
  if (!x || int(x.id) === 0) return def;
  const n = await getClanPlayers(int(x.id));
  const unit = n >= 250 ? 7 : n >= 200 ? 6 : n >= 150 ? 5 : n >= 100 ? 4 : n >= 50 ? 3 : n >= 30 ? 2 : n >= 10 ? 1 : 0;
  return { id: int(x.id), rank: int(x.rank) & 0xff, exp: int(x.exp), name: str(x.name), ownerId: BigInt(str(x.owner_id) || "0"), logo: u32(x.logo), nameColor: int(x.name_color) & 0xff, effect: int(x.effects) & 0xff, unit };
}
