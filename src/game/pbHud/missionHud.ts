// Mission card tasks in battle: MissionClient state (2355 / 2359 / 2361) -> HudData.missions (left panel
// CHud+0x600 and the Tab list of CHUD_Score) and the "Task Completed" banner edges. Pure, no DOM: missionsHud.smoke drives it.
// The task texts and progress are the lobby's (missionLogic.ts: the quest classes' OnQueryDesc); nothing is rebuilt here.
import { TASKS_PER_CARD, taskDone, type MissionState } from "../../net/missionClient.ts";
import { missionSet, taskProgress, taskText } from "../../lobby/core/missionLogic.ts";
import { itemName } from "../../lobby/state/itemNames.ts";
import type { HudMissionLine } from "./model.ts";

/** item name, "" when the web tables do not know the id (the quest text then says "(Unknown) ", as the exe) */
const nameOf = (id: number): string => { const n = itemName(id).name; return n.startsWith("#") ? "" : n; };

/** the active slot's card (CQuestManager 0x58bf60 "has an active card"); null = no card set there or no questing block yet */
function activeCard(st: MissionState) {
  const s = st.slots[st.active], set = s?.setId ? missionSet(s.setId) : undefined, def = set?.cards[s.card];
  return st.known && def ? { slot: st.active, setId: s.setId, card: s.card, def } : null;
}

/**
 * One line per task of the active card (getActiveQuest(i), i < 4): `text` = OnQueryDesc with newline 1 (the left panel's call,
 * 0x706d97), `tab` = newline 0 (CHUD_Score 0x73cd20: the "\n" before the count is the only difference, 0x99c186). State = the quest's
 * vtbl+0x18 (0x99b560 / 0x99c400): progress (arg 5) 0 -> 0, progress == count (arg 2) -> 2 (done), else 1.
 */
export function missionLines(st: MissionState): HudMissionLine[] {
  const a = activeCard(st);
  if (!a) return [];
  return a.def.tasks.slice(0, TASKS_PER_CARD).map((t, i) => {
    const limit = t[3], progress = taskProgress(st, a.slot, a.card, i, limit);
    const text = taskText(t, progress, { nameOf });
    return { text, tab: text.replace(/\n/g, ""), state: progress === 0 ? 0 : progress >= limit ? 2 : 1 };
  });
}

/** done flags of the active card's tasks; `key` = slot / set / card, so a card change is not read as tasks getting done */
export interface TaskSnapshot { key: string; done: boolean[] }
export function taskSnapshot(st: MissionState): TaskSnapshot | null {
  const a = activeCard(st);
  if (!a) return null;
  const s = st.slots[a.slot];
  return { key: `${a.slot}:${a.setId}:${a.card}`, done: Array.from({ length: TASKS_PER_CARD }, (_, i) => taskDone(s, a.card, i)) };
}

/**
 * Tasks that turned done between two snapshots of the same card. CQuestManager::ChangeQuest 0x58c1a0 calls AddQuestFinishToHud only
 * when the 2359 carries the +240 flag and the task was not done yet ([quest+0x18] == 0): the server sends the 2359 twice per step
 *, the second one finds the task done and shows nothing.
 */
export function newlyDone(prev: TaskSnapshot | null, next: TaskSnapshot | null): number[] {
  if (!prev || !next || prev.key !== next.key) return [];
  return next.done.flatMap((d, i) => (d && !prev.done[i] ? [i] : []));
}

/**
 * CHud::CreateHUD 0x744790 builds the left panel unless the stage mode is 6 (0x4c14e0), 9 (0x4c1580), 8 (0x4c1560) or the 0xb check
 * (0x4c1530); always in the tutorial stage (0x4e62b0, 0xa). The TapMinimap Lua names 6 SuddenDeath and 9 HeadKiller; 8 / 0xb unnamed.
 * Stage mode = the room's RoomCondition >> 2 (DeathMatch 4 -> 1, Bomb 8 -> 2, Tutorial 40 -> 0xa) [INFERIDO]. The Tab list and the
 * banner do not depend on it.
 */
export function missionPanelOn(roomType: number): boolean {
  const mode = roomType >> 2;
  return mode === 0xa || ![6, 8, 9, 0xb].includes(mode);
}
