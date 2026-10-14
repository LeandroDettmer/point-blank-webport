import type { RespawnInventory, RespawnLoadout, RespawnSlot } from "./respawnSelect";

/**
 * Offline test inventory (?play local match and its respawn weapon change, T): ONE weapon per type, all with a
 * textured model (weapons/models/index.json), their own 1PV AI (chars/<arms>/anim1pv, no class fallback) and, for
 * guns, their own weapon clips (weapons/anim) - i.e. complete in 2017 (weapons/complete-cross.json, pb-extract-tools audit-weapons-cross.mjs).
 * The only place the offline weapons are listed. Barrett M82A1 (no 2017 sounds), RPD (no weapon clips/sounds) and
 * SmokeGrenade 508001 (untextured model) are out until they are complete.
 */
export const TEST_WEAPONS: Record<RespawnSlot, readonly { id: number; kind: string }[]> = {
  primary: [
    { id: 103037, kind: "AR: AUG-A3 Gold (DotSight overlay)" },
    { id: 103015, kind: "AR: AK-47 SOPMOD" },
    { id: 103001, kind: "AR: SG550 (dot sight)" },
    { id: 103013, kind: "AR: G36C" },
    { id: 103049, kind: "AR: FAMAS G2" },
    { id: 104013, kind: "SMG: Kriss Super V" },
    { id: 104033, kind: "SMG: AKS74U (zoom pose)" },
    { id: 104001, kind: "SMG: MP5K" },
    { id: 104008, kind: "SMG: UMP45" },
    { id: 104010, kind: "SMG: P90 MC" },
    { id: 104002, kind: "SMG: Spectre" },
    { id: 105030, kind: "SR: Cheytac M200 (scope, bolt, left-hand reload)" },
    { id: 105005, kind: "SR: L115A1" },
    { id: 106001, kind: "SG: 870MCS (pump, shell reload)" },
    { id: 106003, kind: "SG: SPAS-15" },
    { id: 106005, kind: "SG: M1887" },
    { id: 110011, kind: "MG: Ultimax-100" },
  ],
  secondary: [
    { id: 202022, kind: "HG: Colt45" },
    { id: 202001, kind: "HG: Desert Eagle" },
    { id: 202007, kind: "HG: Colt Python" },
    { id: 202024, kind: "HG: Kriss Vector SDP" },
  ],
  melee: [{ id: 301001, kind: "Knife: M-7" }],
  grenade: [{ id: 407001, kind: "Grenade: K-400" }],
  special: [{ id: 527001, kind: "Special: SmokeGrenade WP" }],
};

/** first entry of each slot: the first life of ?play and the respawn panel's starting choice */
export const TEST_EQUIPPED: RespawnLoadout = {
  primary: TEST_WEAPONS.primary[0].id,
  secondary: TEST_WEAPONS.secondary[0].id,
  melee: TEST_WEAPONS.melee[0].id,
  grenade: TEST_WEAPONS.grenade[0].id,
  special: TEST_WEAPONS.special[0].id,
};

export function testInventory(): RespawnInventory {
  const ids = Object.values(TEST_WEAPONS).flatMap((l) => l.map((w) => w.id));
  return { items: ids.map((itemId) => ({ itemId, objectId: 0 })), equipped: { ...TEST_EQUIPPED } };
}

/**
 * ?play=all: keep only the weapons complete in Cross (public/assets/weapons/complete-cross.json `complete`); an equipped
 * weapon that is not complete falls back to the first complete item of the list for that loadout slot (0 if none).
 */
export function completeOnly(inv: RespawnInventory, complete: readonly number[], slotOf: (itemId: number) => RespawnSlot | null): RespawnInventory {
  const ok = new Set(complete);
  const items = inv.items.filter((i) => ok.has(i.itemId));
  const equipped = { ...inv.equipped };
  for (const s of Object.keys(equipped) as RespawnSlot[]) {
    if (!equipped[s] || ok.has(equipped[s])) continue;
    equipped[s] = items.find((i) => slotOf(i.itemId) === s)?.itemId ?? 0;
  }
  return { items, equipped };
}
