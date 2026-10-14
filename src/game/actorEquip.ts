// Head equipment of each match actor and its HELMET PROTECTION rate. Pure (no three): the weapon and damage code read it too.
// Equipment comes from BATTLE_RESPAWN_ACK 5138 (parts[0] head, parts[1] face, beret), recorded per actor id by
// charEquip.ts watchRespawnEquip(). Bots and AI seats get no 5138: they keep the empty loadout (noteBotEquip), never the
// head item of the player who held the seat before.

/** Equipped head/face/beret itemIds (0 / absent = none). */
export interface HeadEquip {
  head?: number;
  face?: number;
  beret?: number;
}

/**
 * HELMET PROTECTION rate per head-slot item: the item's pef Equipment.<Cat>.<Item>.Defense (CalcHelmetPenetrate 0x5425e0
 * divides the weapon's HelmetPenetrate by it). Only items with a Defense protect: helmets, hats (Event) and masks; berets
 * have none. Values from the 2017 pef (extracted/pef2017/raw/Equipment.json, pef names mapped to the item ids of
 * public/assets/equip/index.json) [INFERIDO] for the Cross pef, not extracted there yet. An item not listed = no protection.
 */
const HELMET_DEFENSE: Record<number, number> = {
  701002: 0.75, // HelmetDefault
  700038: 1.3, 700039: 1.3, 700122: 1.5, 700125: 1.3, 700126: 1.1, 700128: 1.3, 700129: 1.3, 700133: 1.1, 700134: 1.3,
  700135: 1.3, 700138: 1.3, 700139: 1.1, 700140: 1.1, 700141: 1.1, 700142: 1.3, 700148: 1.1, 700149: 1.5, 700150: 1.3,
  700152: 1.5, 700153: 1.5, 700154: 1.5, 700158: 1.1, 700167: 1.5, 700168: 1.5, 700170: 1.5, 700172: 1.1, 700175: 1.1,
  700179: 1.3, 700180: 1.3, 700195: 1.5, 700197: 1.5, 700206: 1.5, 800015: 1.1, 800016: 1.1, 800017: 1.1, 800019: 1.3,
  800020: 0.9, 800022: 0.9, 800032: 1.3, 800033: 1.1, 800131: 1.3, 800139: 1.3, 800140: 1.3, 800144: 1.3, 800145: 1.3,
  800146: 1.3, 800147: 1.3, 800148: 1.3, 800149: 1.3, 800150: 1.3, 800151: 1.3, 800154: 1.3, 800155: 1.3, 800156: 1.3,
  800157: 1.3, 800158: 1.3, 800159: 1.3, 800160: 1.3, 800161: 1.3, 800162: 1.3, 800163: 1.3, 800165: 1.3, 800168: 1.1,
  800202: 0.9, 800203: 0.9, 800213: 1.5, 800215: 1.3, 800217: 1.3, 800241: 1.5, 800257: 1.5, 800260: 1.5, 800261: 1.5,
  800263: 1.3, 800264: 1.3, 800265: 1.3, 800266: 1.3, 800269: 1.3, 800270: 1.5, 800273: 1.3, 800274: 1.5, 800275: 1.5,
  800276: 1.5, 800277: 1.3, 800278: 1.5, 800279: 1.5, 800282: 1.5, 800286: 1.5, 800287: 1.5, 800292: 1.3, 800293: 1.3,
  800294: 1.5, 800296: 1.3, 800297: 1.1, 800301: 1.5, 800302: 1.5, 800305: 1.5, 800306: 1.1, 800316: 1.5, 800319: 1.5,
  800322: 1.5, 800325: 1.5, 800328: 1.5, 800331: 1.5, 800332: 1.5, 800333: 1.5, 800334: 1.1, 800335: 1.1, 800336: 1.1,
  800337: 1.1, 800340: 1.5,
};

/** HELMET PROTECTION rate of a head item (0 = it protects nothing, or no item). */
export const helmetDefenseOf = (itemId: number | undefined): number => (itemId ? HELMET_DEFENSE[itemId] ?? 0 : 0);

const EMPTY: HeadEquip = { head: 0, face: 0, beret: 0 };
const actorEquipMap = new Map<string, HeadEquip>();

export function noteActorEquip(actorId: string, eq: HeadEquip): void { actorEquipMap.set(actorId, eq); }
export function actorEquip(actorId: string): HeadEquip | undefined { return actorEquipMap.get(actorId); }
export function clearActorEquip(): void { actorEquipMap.clear(); }
/** A bot / AI seat has no 5138: its loadout is the empty one, whoever held the seat before. */
export function noteBotEquip(actorId: string): void { actorEquipMap.set(actorId, EMPTY); }

/** The actor's head item gives HELMET PROTECTION this life (a head item with a pef Defense). No head item = no helmet, so no
 *  CalcHelmetPenetrate roll (0x5425e0) and nothing to pop off. */
export function actorHasHelmet(actorId: string): boolean { return actorHelmetDefense(actorId) > 0; }
/** Rate of the actor's head item for CalcHelmetPenetrate (0 = no helmet). */
export function actorHelmetDefense(actorId: string): number { return helmetDefenseOf(actorEquipMap.get(actorId)?.head); }
/** A head item is equipped (drawn, protecting or not). */
export function actorHasHeadItem(actorId: string): boolean { return !!actorEquipMap.get(actorId)?.head; }
/** A beret is equipped (no helmet roll: it only falls off on a head hit, damage unchanged). */
export function actorHasBeret(actorId: string): boolean { return !!actorEquipMap.get(actorId)?.beret; }
/** The helmet-slot accessory is drawn: head item or beret, and it has not popped off this life. */
export function actorHeadgearOn(actorId: string, lost: boolean): boolean { return !lost && (actorHasHeadItem(actorId) || actorHasBeret(actorId)); }
