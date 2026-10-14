// Bomb Mission C4: weapons.json slot 5 (special), class Mission. 5009001 "C4" (pef Bomb/C4) has no exported model, 5009002 (C4_ShuttleX) does.
export const MISSION_IDS: ReadonlySet<number> = new Set([5009001, 5009002]);
export const isMissionWeapon = (id: number | undefined): boolean => id !== undefined && MISSION_IDS.has(id);
/** the C4 an attacker carries in Bomb Mission (the one with a model) */
export const C4_ITEM_ID = 5009002;
