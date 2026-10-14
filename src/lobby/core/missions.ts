// Perfil / Missão tab data (UITabProfileMissionCard): the shown card's task notices and prize box and the Detail popup's final prizes,
// from the exe's rules (missionLogic.ts). The Cross shell (screensCross/pages/profile.ts) draws them; lists what
// is [INFERIDO] / [RECRIADO].
import { itemName } from "../state/itemNames.ts";
import type { MissionPrizeDef } from "./missionData.ts";
import { badgeName, badgeType, cardOf, missionSet, slotOfSet, taskProgress, taskText, MS } from "./missionLogic.ts";
import { TASKS_PER_CARD, taskDone, type MissionState } from "../../net/missionClient.ts";

/** popup of the tab: Comprar (BuyNow) / Info+ (Detail) of set `setId`; `item` = Detail's shown final prize (index in set.prizes) */
export type MissionPopup = { kind: "buy" | "detail"; setId: number; item?: number } | null;

/** item name, "" when the web tables do not know the id (itemName answers) */
const nameOf = (id: number): string => { const n = itemName(id).name; return n.startsWith("#") ? "" : n; };

/** the four task notices + checks of the shown card (UpdateNotices 0x955050): an owned set's active card is described (OnQueryDesc);
 * another card of an owned set says "Missão" /; a set not owned shows nothing, checks off and disabled */
export function notices(st: MissionState, setId: number): { text: string; checked: boolean; enabled: boolean }[] {
  const set = missionSet(setId), slot = slotOfSet(st, setId);
  if (!set || slot < 0) return Array.from({ length: TASKS_PER_CARD }, () => ({ text: "", checked: false, enabled: false }));
  const s = st.slots[slot], card = set.cards[s.card];
  return Array.from({ length: TASKS_PER_CARD }, (_, i) => {
    const t = card?.tasks[i], done = taskDone(s, s.card, i);
    if (!t) return { text: done ? MS.complete : MS.challenge, checked: done, enabled: true };
    return { text: taskText(t, taskProgress(st, slot, s.card, i, t[3]), { nameOf }), checked: done, enabled: true };
  });
}

/** prize box of the shown card (UpdatePrize 0x9544f0): only an owned set's active card has one; else 0 / 0 and no badge */
export function prize(st: MissionState, setId: number): { name: string; exp: number; gold: number; shape: number } {
  const set = missionSet(setId), slot = slotOfSet(st, setId);
  const c = set && slot >= 0 ? cardOf(set, st.slots[slot].card) : undefined;
  if (!c) return { name: "", exp: 0, gold: 0, shape: -1 };
  const type = badgeType(c.badge);
  return { name: badgeName(type), exp: c.exp, gold: c.gold, shape: type };
}

/** Detail's final prize `item` of set `setId` (UIPopupMissionCardInfo: BonusItemID slot, count of non-zero slots) */
export function detailPrize(setId: number, item: number): { prize: MissionPrizeDef | undefined; count: number } {
  const prizes = missionSet(setId)?.prizes ?? [];
  return { prize: prizes[item], count: prizes.length };
}

/** CardInfo_Next (+1) / CardInfo_Prev (-1), 0x92b6d0: index + step, past the last -> 0, before 0 -> last (0x92cbc0) */
export function stepPrize(setId: number, item: number, step: number): number {
  const n = missionSet(setId)?.prizes.length ?? 0, i = item + step;
  return i > n - 1 ? 0 : i < 0 ? Math.max(0, n - 1) : i;
}
