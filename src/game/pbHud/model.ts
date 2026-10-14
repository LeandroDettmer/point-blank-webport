// Pure HUD model: the game data the battle HUD draws (game.ts -> hud.ts -> PbHud.ts and the Cross panels crossScore.ts,
// crossFinal.ts, charaPanel.ts). No DOM, so Node smokes read the same rules.
import { missionIcon, type Rect } from "./layout.ts";

export type Team = 0 | 1;

export interface HudRow { name: string; team: Team; /** room slot of a net player ("slotN" actor); undefined = bot / offline */ slot?: number; kills: number; deaths: number; assists?: number; headshots: number; damage?: number; objects?: number; alive: boolean; local: boolean; leader?: boolean; /** patente (room slot rank); undefined = unknown (bots / offline) */ rank?: number; /** clan emblem of the room slot (logo D; CLAN_MARK_DEFAULT / undefined = no mark, bots never have one) */ clanLogo?: number; /** nick colour index (NICK_COLORS) of the room slot; undefined = white */ nickColor?: number }

/** what the end-of-match screen shows (null on the fly = not up) */
export interface FinalData {
  /** 0 FR / 1 CT / null draw */
  winner: Team | null;
  /** team scores: kills (Deathmatch) or rounds won (round modes) */
  red: number;
  blue: number;
  mapName: string;
  modeName: string;
  /** 0 = Score, 1 = Reward */
  tab: 0 | 1;
  /** seconds left before the screen leaves by itself */
  leaveIn: number;
  /** exp / gold earned per room slot (server 5140, 18 entries; roomClient.ts); null offline */
  slotExp: number[] | null;
  slotGold: number[] | null;
  /** clan vs clan match (boot.ts isClanMatch): the account's clan from 5140 (emblem = logo, grade = rank); points from the clan detail (801) after the match, null until it arrives */
  clan?: FinalClan | null;
}

export interface FinalClan { name: string; rank: number; logo: number; points: number | null }

export interface HudData {
  hp: number; maxHp: number; armor: number; helmet: boolean;
  /** `dual` = dual-wield gun (2nd ammo gauge, charaPanel.ts); left = the left gun is the bright one (next shot) */
  weapon: { name: string; slot: number; ammo: number; reserve: number; melee: boolean; reloading: boolean; reloadProgress: number; family?: string; id?: number; dual?: { left: boolean } };
  /** crouching (portrait pose) */
  crouch?: boolean;
  /** grenades left in slot 3 (null = no grenade) */
  grenades: number | null;
  myTeam: Team;
  score: [number, number];
  killLimit: number;
  round: number;
  timeLeft: number;
  kills: number; deaths: number; assists: number;
  phase: "countdown" | "live" | "ended";
  showBoard: boolean;
  dead: boolean;
  rows: HudRow[];
  mapName: string;
  modeName: string;
  /** stage type of the room (RoomCondition >> 2, = STAGE_ID >> 24): 4 / 13 / 45 shift the mission HUD down 18 px (stageY0) */
  stageType?: number;
  /** Bomb Mission: fuse left (null = no bomb down), the current plant / defuse hold (0..1, 0 = none) and before = nothing is planted
   *  yet and the local chara stands in a site area (grey C4 of crossScore.ts BombPanel; exe gate mgr+0x14). hint = the C4 hint box text (null = hidden) */
  bomb?: { fuseLeft: number | null; progress: number; before: boolean; hint: string | null };
  /** Destroy mission: the two objectives' bars (bar[0] = red objective = server bar1, bar[1] = blue = bar2) and their full life (max) */
  objectives?: { bar: [number, number]; max: [number, number] } | null;
  final?: FinalData | null;
  /** the local player watches somebody (game/observer.ts): "view" = observer HUD mode 3 (CHud::SetMode 0x749fb0: no own HP / weapon / bullets, the minimap stays), "fly" = mode 4 (nothing but the observer help) */
  observing?: "view" | "fly";
  /** tasks of the active mission card (missionHud.ts missionLines), absent / empty = no card: the left panel (CChallengeBoard) */
  missions?: HudMissions;
  /** clan vs clan match (boot.ts isClanMatch); no Cross panel draws a clan banner yet */
  clanMatch?: boolean;
}

/** one task of the active mission card: `text` = OnQueryDesc with newline (left panel), `tab` = without (Tab list); state = vtbl+0x18 */
export interface HudMissionLine { text: string; tab: string; state: 0 | 1 | 2 }
export interface HudMissions {
  lines: HudMissionLine[];
  /** the mode has the left panel (CHud::CreateHUD 0x744790 skips CHud+0x600 in some modes, missionHud.ts missionPanelOn) */
  panel: boolean;
}

// ---- mission panel (code-drawn, layout.ts MISSION_PANEL)

export interface MissionPanelState {
  show: boolean;
  /** one row per task: its text (with the newline) and the Hud.i3i cell of its state icon */
  rows: { text: string; icon: Rect }[];
}
/** CHud+0x600 Update 0x706ad0: no card / no task -> the whole panel is disabled. Shown while the match HUD is up; the exe does not
 * hide it on death (only Update without a card does); the Tab board / result / observer hide it [INFERIDO: the match HUD frames do] */
export function missionPanelState(d: HudData): MissionPanelState {
  const m = d.missions;
  const inMatch = !d.showBoard && d.phase !== "ended" && !d.final;
  const rows = m?.panel ? m.lines.map((l) => ({ text: l.text, icon: missionIcon(l.state) })) : [];
  return { show: inMatch && !d.observing && rows.length > 0, rows };
}

/** rows per team the Tab board and the result list show */
export const TAB_ROWS = 8;
/** Rows of a team as the boards list them: kills desc, deaths asc [INFERIDO sort]. */
export function sortedRows(rows: HudRow[], team: Team): HudRow[] {
  return rows.filter((r) => r.team === team).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths).slice(0, TAB_ROWS);
}
