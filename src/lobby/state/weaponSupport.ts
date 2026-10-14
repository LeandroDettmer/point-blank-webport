// Which weapons the web client exposes: only those COMPLETE in the PBCross export (public/assets/weapons/complete-cross.json,
// pb-extract-tools audit-weapons-cross.mjs: Cross pef block + textured Cross model + own 1PV/3PV AI + weapon clips + sounds + icon).
// Display filter only: incomplete weapons are hidden from the shop, the inventory and ?play=all; the DB, the server and
// the player's loadout are untouched. Re-enable a weapon by exporting what it lacks and re-running the audit.
import { tabOf } from "./itemInfo.ts";
import { isCharaComplete, isItemComplete } from "./charaSupport.ts";

let complete: Set<number> | null = null;
let loading: Promise<void> | null = null;

/** Tests/Node: the parsed complete-cross.json (null = no filter). */
export function setWeaponSupport(json: { complete: number[] } | null): void {
  complete = json ? new Set(json.complete) : null;
}

/** Browser: fetch once; a failed fetch leaves the filter off (every weapon shown) rather than hiding them all. */
export function loadWeaponSupport(base = "/assets/weapons"): Promise<void> {
  return (loading ??= fetch(`${base}/complete-cross.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { complete?: number[] } | null) => { if (Array.isArray(j?.complete)) setWeaponSupport({ complete: j.complete }); })
    .catch(() => {}));
}

/**
 * false = a weapon, chara/part or Item-tab good that is not complete in 2017 (hidden). Everything before the lists load,
 * and `keep` items (equipped or a server stock/basic, model.ts inventoryItems) are always shown.
 */
export function isItemShown(itemId: number, keep = false): boolean {
  if (keep) return true;
  const tab = tabOf(itemId);
  if (tab === "weapon") return !complete || complete.has(itemId);
  if (tab === "chara") return isCharaComplete(itemId);
  return isItemComplete(itemId);
}
