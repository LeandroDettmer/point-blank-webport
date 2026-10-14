// Weapon system of the PB web client.
//
//   const weapons = new WeaponSystem({ scene, camera, world, RAPIER, resolveTarget: (c) => hitboxes.get(c.handle) ?? null,
//                                      ownCollider: () => player.collider });
//   const input = new WeaponInputTracker();
//   // per frame, after player.update():
//   weapons.update(dt, input.sample({ speed, grounded, crouching }));
//   weapons.onHit((h) => h.target && applyDamage(h.target.data, h.damage, h.zone));
//
// Data: public/assets/weapons/weapons.json (pb-extract-tools export-weapons.mjs from server ItemStatistics.xml),
// sfx: public/assets/weapons/sfx/, models: public/assets/weapons/models/<id>.glb (optional).
export { WeaponSystem } from "./WeaponSystem";
export { WeaponInputTracker } from "./input";
export { WeaponDb, DEFAULT_HITZONE } from "./data";
export type {
  ClassParams, Family, FireEvent, FireMode, HitEvent, HitTarget, HitZone, LoadoutIds, RecoilParams, ReloadEvent,
  SlotIndex, SpreadParams, SwitchEvent, WeaponContext, WeaponDef, WeaponHudSlot, WeaponHudState, WeaponInput, WeaponStat,
} from "./types";
