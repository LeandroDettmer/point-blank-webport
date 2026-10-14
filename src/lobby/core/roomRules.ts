// Room rules of the create window's "Mais" panel that ride in ROOM_CREATE_REQ / ROOM_CHANGE_ROOMINFO_REQ next to the
// mode: weapon restriction (weaponsFlag), observer rules (watchRule byte), entry restriction (limit byte), the random-map
// list and the player count. Pure data helpers, shared by the controller, the game (observer camera) and the smokes.

// ---- weapon restriction ----------------------------------------------------------------------------------------------
// The checkboxes of the scene (i3UICheckBox_MainWpn / SubWpn / MeleeWpn / ThrowWpn / RPG7) pack into RoomWeaponsFlag
// (server Plugin.Core/Enums/RoomWeaponsFlag.cs): Grenade 1, Melee 2, Secondary 4, primary 8 + the primary classes
// (Assault 16 .. Machinegun 256), RPG7 1024. "Arma especial" (i3UICheckBox_SpecialWpn) is always checked and locked in
// the client's script (setLimitWeapon sets it to 1), so it has no bit. RPG7 needs the primary slot (the script links the
// two checkboxes).
export interface WeaponChecks { primary: boolean; secondary: boolean; melee: boolean; throw: boolean; rpg7: boolean }
export const ALL_WEAPONS: WeaponChecks = { primary: true, secondary: true, melee: true, throw: true, rpg7: false };
export const PRIMARY_CLASSES = 0x1f0;

export function weaponsFlagOf(w: WeaponChecks): number {
  let f = 0;
  if (w.throw) f |= 1;
  if (w.melee) f |= 2;
  if (w.secondary) f |= 4;
  if (w.primary) f |= 8 | PRIMARY_CLASSES;
  if (w.primary && w.rpg7) f |= 1024;
  return f;
}

export function weaponChecksOf(flag: number): WeaponChecks {
  return { throw: (flag & 1) !== 0, melee: (flag & 2) !== 0, secondary: (flag & 4) !== 0, primary: (flag & 8) !== 0, rpg7: (flag & 1024) !== 0 };
}

// ---- observer rules --------------------------------------------------------------------------------------------------
// watchRule byte, decoded from PointBlank.exe 2017. The create-room window packs it at 0x923ce0 (Lua isLimitObserver3 /
// isLimitObserver / isLimitObserverEnemy / isLimitObserverHP / isLimitObserver1only set bits 0x01 / 0x02 / 0x04 / 0x08 /
// 0x10) and the battle reads it back through 0x59d0b0: 0x10 forces the first-person view (CStageBattle::ProcessObserverMode
// 0x76ab80, the Space key 0x76bfc0), 0x01 adds the second third-person camera (CAMERA_TYPE 6, Observer2), 0x02 the free
// FLY camera (type 2), 0x04 lets the observer watch the enemy team (0x76b5d0), 0x08 shows the enemy HP list
// (CHUD_ObserverHPGauge::UpdateGauge 0x7147c0). The exe never tests 0x80; the server's Ace preset 142 (0x8E) = 0x02|0x04|0x08.
// The checkbox <-> bit map: ObsTPS = THIRD, ObsOnOff = ON, ObsEnemy = ENEMY, ObsHP = ENEMY_HP, ObsTPS_2 = FIRST_ONLY.
export const WATCH = { THIRD: 0x01, ON: 0x02, ENEMY: 0x04, ENEMY_HP: 0x08, FIRST_ONLY: 0x10 } as const;
/** default of a new room [INFERIDO]: the exe's initial checkbox state comes from C++ (0x924930), not from the Lua: only the FLY camera on */
export const DEFAULT_WATCH: number = WATCH.ON;

export interface ObserverRules { on: boolean; enemy: boolean; enemyHp: boolean; third: boolean; firstOnly: boolean }
export function observerRules(watch: number): ObserverRules {
  return {
    on: (watch & WATCH.ON) !== 0, enemy: (watch & WATCH.ENEMY) !== 0, enemyHp: (watch & WATCH.ENEMY_HP) !== 0,
    // 0x76bfc0: "third" only counts while the first-person-only bit is clear
    third: (watch & WATCH.THIRD) !== 0 && (watch & WATCH.FIRST_ONLY) === 0, firstOnly: (watch & WATCH.FIRST_ONLY) !== 0,
  };
}

// ---- random map ------------------------------------------------------------------------------------------------------
// RoomStageFlag.RANDOM_MAP = 2 in the stage flag; `randomMaps` (24 bytes) is a bit mask indexed by mapId (bit i of byte
// i >> 3) [INFERIDO]; the server picks one of the valid maps when the battle starts (server roomModel.ts pickRandomMap).
export const STAGE_RANDOM_MAP = 2;
/** RoomModel StageFlag.PASSWORD: the room has a password (the server derives it from the password itself) */
export const STAGE_PASSWORD = 4;
export const RANDOM_MAPS_BYTES = 24;

export function randomMapMask(ids: number[]): Uint8Array {
  const m = new Uint8Array(RANDOM_MAPS_BYTES);
  for (const id of ids) if (id >= 0 && id < RANDOM_MAPS_BYTES * 8) m[id >> 3] |= 1 << (id & 7);
  return m;
}

export function randomMapIds(mask: Uint8Array | undefined): number[] {
  const out: number[] = [];
  if (mask) for (let id = 0; id < mask.length * 8; id++) if ((mask[id >> 3] >> (id & 7)) & 1) out.push(id);
  return out;
}

// ---- player count ----------------------------------------------------------------------------------------------------
/** slots offered by the "Users" combo (ROOM_CREATE_REQ slots; the server clamps to the map's limit) */
export const PEOPLE_OPTS = [2, 4, 6, 8, 10, 12, 14, 16];
export const DEFAULT_PEOPLE = 16;

/** Matches.xml (server/runtime/Data/Maps) `Limit` of the maps below 16 players: Death Match (Rule 1) and Bomb Mission (Rule 2).
 * The server clamps to it (RoomModel.SetSlotCount); the Users combo only offers what fits. */
const MAP_LIMIT_DM: Record<number, number> = { 9: 8, 10: 8, 41: 8, 105: 8, 106: 8 };
const MAP_LIMIT_BOMB: Record<number, number> = { 89: 10 };
export function mapPlayerLimit(mapId: number, bomb = false): number {
  return (bomb ? MAP_LIMIT_BOMB : MAP_LIMIT_DM)[mapId] ?? DEFAULT_PEOPLE;
}
/** the Users combo options of a map: the steps that fit, plus the limit itself when it is not a step */
export function peopleOptions(limit: number): number[] {
  const o = PEOPLE_OPTS.filter((n) => n <= limit);
  return o.includes(limit) ? o : [...o, limit];
}
