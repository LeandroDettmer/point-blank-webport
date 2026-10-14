// Room modes offered by "Criar Sala" and the ready-room settings: the Deathmatch family of server/runtime/Data/Maps/
// Rules.xml (Rule 0, Conditions 4 = roomType; StageOptions = stage) that the web battle can run. Sniper/Shotgun/Knuckle
// share Death Match's map list (Matches.xml has no separate Match for them). weaponsFlag = RoomWeaponsFlag (slot bits
// grenade 1 / melee 2 / secondary 4 / primary 8, then primary classes; src/game/respawnSelect.ts), Sniper/Shotgun from
// the server's own presets (Data/CommandHelper.JSON "WeaponsFlag": SniperRifle 79, ShotGun 143).
import { T } from "./strings.ts";

type ModeText =
  | "deathmatch" | "modeSniper" | "modeShotgun" | "modeKnife" | "modeHeadHunter" | "modeChaos" | "modeBots" | "modeBomb"
  | "modeBombSniper" | "modeBombShotgun" | "modeBombKnife" | "modeDestroy" | "modeDestroySniper" | "modeDestroyShotgun" | "modeDestroyKnife" | "modeDefence"
  | "modeAnnihilation" | "modeAce";

export interface RoomMode {
  /** key of T (strings.ts), resolved at draw time: T's getters see pt-BR.json only once it has loaded */
  text: ModeText;
  rule: number;
  stage: number;
  roomType: number;
  weaponsFlag: number;
  /** server rotation of this rule (system_map_matches of its Rules.xml Mode id); no list = the Deathmatch / Bomb list */
  mapIds?: readonly number[];
  /** AI room (RoomModel.IsBotMode): AiCount / AiLevel window instead of kills/time */
  ai?: true;
  /** round mode (Bomb Mission, Destroy): killTime's low nibble indexes the server ROUNDS [1,2,3,5,7,9], not the kill goals */
  rounds?: true;
  /** Destroy (Sabotagem, roomType 12): the maps are DESTROY_SERVER_MAP_IDS and the killTime default is 0x02 */
  destroy?: true;
  /** Defence (roomType 20): the maps are DEFENCE_SERVER_MAP_IDS */
  defence?: true;
  /** special-weapon battle: a btnSpecial button of the ModeSelect scene (특수무기전 block), not the Normal list */
  special?: true;
}

/** Rotation of Rule 32 (HeadHunter, Rules.xml Mode 8) and Rule 80 (Chaos, Mode 15): the server's system_map_matches after
 * the system_map_rules seed (db/init/001_init.sql). getMapLimit (server roomModel.ts) refuses the ready of any other map. */
export const HEADHUNTER_MAP_IDS: readonly number[] = [1, 2, 4, 5, 7, 9, 10, 23, 29, 67];
export const CHAOS_MAP_IDS: readonly number[] = [1, 2, 4, 7, 9, 10, 20, 23, 42, 67];
/** Rotation of Rule 0 Conditions 16 (Annihilation = Rules.xml Mode 4, "Eliminate" in system_map_matches; 067 removed no row of it).
 * Rule 128 (Mode 43 / 46 / 49 / 50) has no map row, so those variants are not creatable. */
export const ANNIHILATION_MAP_IDS: readonly number[] = [1, 2, 4, 9, 10, 18, 20, 28, 34, 41, 42, 65];
/** Rotation of Rule 128 Conditions 32 (Ace = Rules.xml Mode 55): the one map, Drain Tunnel 108 (system_map_matches, mode 55) */
export const ACE_MAP_IDS: readonly number[] = [108];

export const ROOM_MODES: RoomMode[] = [
  { text: "deathmatch", rule: 0, stage: 1, roomType: 4, weaponsFlag: 0x1ff },
  { text: "modeSniper", rule: 0, stage: 96, roomType: 4, weaponsFlag: 79, special: true },
  { text: "modeShotgun", rule: 0, stage: 128, roomType: 4, weaponsFlag: 143, special: true },
  // Knuckle mode ("Partida Clube" / "Clube da Luta", STR_TBL_GUI_LOBBY_KNUCKLEMODE_*, stage 224 = KNUCKLE_STAGE): [INFERIDO]
  // melee only, and the melee is the bare fist (BAREFIST_ID, enforceRoomWeapons); the server preset "Knuckle" (527) would
  // still allow pistols and grenades
  { text: "modeKnife", rule: 0, stage: 224, roomType: 4, weaponsFlag: 2, special: true },
  // HeadHunter / Chaos = Rules.xml Mode 8 (Rule 32, Conditions 4) and Mode 15 (Rule 80, Conditions 4): Deathmatch with
  // a rule bit, both stage 0 (the rule tells them apart, see modeIndex). Special-war rows of the Cross lbSpecialWarWin
  // window (HeadHunter flag 0x20, src/lobby/screensCross/crossMap.ts SPECIAL_WAR). Full loadout [INFERIDO].
  { text: "modeHeadHunter", rule: 32, stage: 0, roomType: 4, weaponsFlag: 0x1ff, special: true, mapIds: HEADHUNTER_MAP_IDS },
  { text: "modeChaos", rule: 80, stage: 0, roomType: 4, weaponsFlag: 0x1ff, special: true, mapIds: CHAOS_MAP_IDS },
  { text: "modeBots", rule: 0, stage: 2, roomType: 4, weaponsFlag: 0x1ff, ai: true },
  // Bomb Mission = Rules.xml Mode 2 (Rule 128, StageOptions 1, Conditions 8); the BR client calls it "Destruição" (STR_HEADER_MODE_EXPLOSION)
  { text: "modeBomb", rule: 128, stage: 1, roomType: 8, weaponsFlag: 0x1ff, rounds: true },
  // Bomb Mission with a special weapon = Rules.xml Modes 22 / 23 / 24 (Rule 128, StageOptions 96 / 128 / 224, Conditions 8):
  // the Deathmatch presets of the three rows above on the Bomb rotation (Rule 128 maps, server getMapLimit by rule)
  { text: "modeBombSniper", rule: 128, stage: 96, roomType: 8, weaponsFlag: 79, rounds: true, special: true },
  { text: "modeBombShotgun", rule: 128, stage: 128, roomType: 8, weaponsFlag: 143, rounds: true, special: true },
  { text: "modeBombKnife", rule: 128, stage: 224, roomType: 8, weaponsFlag: 2, rounds: true, special: true },
  // Destroy (Sabotagem) = Rules.xml Mode 3 (Rule 128, StageOptions 1, Conditions 12); the variants 25 / 26 / 27 only change the
  // StageOptions (96 / 128 / 224), as the Bomb ones. Matches Mode 3 = Breakdown 17, Helispot 51 (DESTROY_SERVER_MAP_IDS).
  { text: "modeDestroy", rule: 128, stage: 1, roomType: 12, weaponsFlag: 0x1ff, rounds: true, destroy: true },
  { text: "modeDestroySniper", rule: 128, stage: 96, roomType: 12, weaponsFlag: 79, rounds: true, destroy: true, special: true },
  { text: "modeDestroyShotgun", rule: 128, stage: 128, roomType: 12, weaponsFlag: 143, rounds: true, destroy: true, special: true },
  { text: "modeDestroyKnife", rule: 128, stage: 224, roomType: 12, weaponsFlag: 2, rounds: true, destroy: true, special: true },
  // Defence (Defesa) = Rules.xml Mode 5 (Rule 128, StageOptions 1, Conditions 20): the attackers destroy both tanks, the defenders
  // keep the round on the clock (server handleGeneratorInfo / handleTimerSync) [INFERIDO] loadout; Matches Mode 5 = Black Panther 52
  { text: "modeDefence", rule: 128, stage: 1, roomType: 20, weaponsFlag: 0x1ff, rounds: true, defence: true },
  // Annihilation (Mode 4, Conditions 16, ANNIHILATION_MAP_IDS) and Ace (Mode 55, Conditions 32, ACE_MAP_IDS) are off the list
  // (user, 2026-10-13): the room could not be created in game. Server rules (checkRoundWipe / checkAceRound) stay.
];

/** Matches.xml Mode 3 (Destroy) maps the web battle can run: Breakdown 17, Helispot 51. X-Mas Library (130) has no MapStructure
 * objects and no props, so the objectives would not exist there [RECRIADO exclusion]. */
export const DESTROY_SERVER_MAP_IDS: ReadonlySet<number> = new Set([17, 51]);

/** Matches.xml Mode 5 (Defence) maps: Black Panther 52, the one map with the tank objectives in the exported props */
export const DEFENCE_SERVER_MAP_IDS: ReadonlySet<number> = new Set([52]);

/** Index of the room's mode in ROOM_MODES (stage and type decide; the rule tells apart the modes that share them, HeadHunter
 * and Chaos are both stage 0 Deathmatch). Unknown stages fall back to Deathmatch. */
export function modeIndex(stage: number, roomType = 4, rule?: number): number {
  const i = ROOM_MODES.findIndex((m) => m.stage === stage && m.roomType === roomType && (rule === undefined || m.rule === rule));
  return i >= 0 ? i : 0;
}

export const modeText = (m: RoomMode): string => T[m.text];

/** the room's mode name: Bomb and Destroy share rule 128 and stage 1, so the room type tells them apart */
export function modeLabel(rule: number, stage: number, roomType?: number): string {
  const m = ROOM_MODES.find((x) => x.rule === rule && x.stage === stage && (roomType === undefined || x.roomType === roomType));
  return m ? modeText(m) : rule === 0 ? T.deathmatch : `${T.colMode} ${rule}`;
}

// killTime nibbles (roomClient.ts CreateRoomOptions.killTime): low = KILLS index, high = TIMES index.
export const KILLS = [15, 30, 50, 60, 80, 100, 120, 140, 160];
export const TIMES_MIN = [3, 3, 3, 5, 7, 5, 10, 15, 20, 25, 30];
/** [INFERIDO] options stepped by the combos: 60..160 kills, 5..30 min (the time indices of CommandHelper "PlayTime"). */
export const KILL_OPTS = [3, 4, 5, 6, 7, 8];
export const TIME_OPTS = [5, 6, 7, 8, 9, 10];
// Cross exe 0x7d2f10 (the mode arrows' condition reset, SetEvent 505): killTime byte of the stage-option struct (+0x47) by
// stage main type (stage >> 24 = Conditions / 4): type 1 Deathmatch -> 0x42 (50 kills / 7 min, KILLS[2] / TIMES[4]);
// type 2 Bomb -> 0x03 (rounds index 3 = 5 rounds, TIMES[0] = 3 min). Read from the 0x7d2f10 jump table, not from the web.
export const DEFAULT_KILLTIME = 0x42;
/** Server RoomModel.ROUNDS (killTime & 15 in round modes) */
export const ROUNDS = [1, 2, 3, 5, 7, 9];
/** Bomb Mission default (Cross exe 0x7d2f10, type 2): 5 rounds, 3 min. The type-3 Destroy case gives 0x02 (3 rounds). */
export const DEFAULT_ROUNDS_KILLTIME = 0x03;
/** Destroy (type 3) default: 3 rounds (Cross exe 0x7d2f10, the type-3 case) */
export const DEFAULT_DESTROY_KILLTIME = 0x02;
/** killTime a mode starts with when the arrows pick it */
export const defaultKillTimeOf = (md: RoomMode): number => (md.destroy ? DEFAULT_DESTROY_KILLTIME : md.rounds ? DEFAULT_ROUNDS_KILLTIME : DEFAULT_KILLTIME);
export const roundsText = (kt: number): string => `${ROUNDS[kt & 15] ?? 3} Rodadas`;

export const killsText = (kt: number): string => `${KILLS[kt & 15] ?? 60} Kills`;
export const timeText = (kt: number): string => `${TIMES_MIN[(kt >> 4) & 15] ?? 10} ${T.minutes}`;
export const conditionText = (kt: number, rounds = false): string =>
  `${rounds ? roundsText(kt) : `${KILLS[kt & 15] ?? 60} Kills`} / ${TIMES_MIN[(kt >> 4) & 15] ?? 10} min`;

/** Next kills (which = "kills") or time option after the current nibble; unknown values restart the list. */
export function stepKillTime(kt: number, which: "kills" | "time", rounds = false): number {
  if (which === "kills") {
    const opts = rounds ? [0, 1, 2, 3, 4, 5] : KILL_OPTS, cur = opts.indexOf(kt & 15);
    return (kt & 0xf0) | opts[(cur + 1) % opts.length];
  }
  const opts = rounds ? [0, 4, 5] : TIME_OPTS, cur = opts.indexOf((kt >> 4) & 15); // 3 / 7 / 5 min: the round clock
  return (opts[(cur + 1) % opts.length] << 4) | (kt & 15);
}
