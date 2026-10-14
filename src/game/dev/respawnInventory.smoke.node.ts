// Online T menu inventory (respawnSelect.ts inventoryFromPlayer): owned items only, and an equipped weapon the account
// does not own shows the server's default kit (server checkEquipedItems), never the unowned id.
// Run: node --experimental-transform-types src/game/dev/respawnInventory.smoke.node.ts
import { inventoryFromPlayer } from "../respawnSelect.ts";
import { setWeaponSupport } from "../../lobby/state/weaponSupport.ts";

let fails = 0;
const check = (name: string, ok: boolean, info = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? ` (${info})` : ""}`);
  if (!ok) fails++;
};

// owner 34 of the local DB (teste3) shape: 103188 owned + equipped; 103028 owned, not equipped; 407003 durable (equip 1)
const owned = (ids: [number, number?][]) => ids.map(([itemId, equip = 2]) => ({ itemId, objectId: itemId * 10, equip }));
const player = (items: ReturnType<typeof owned>, loadout: Record<string, number>) => ({
  items: () => items,
  weaponLoadout: () => ({ primary: 0, secondary: 0, melee: 0, grenade: 0, special: 0, ...loadout }),
});

const a = inventoryFromPlayer(player(owned([[103188], [103028], [202018], [301064], [407003, 1]]), { primary: 103188, secondary: 202018, melee: 301064, grenade: 407001, special: 508002 }));
check("owned equipped weapons kept", a.equipped.primary === 103188 && a.equipped.secondary === 202018 && a.equipped.melee === 301064 && a.equipped.special === 508002, JSON.stringify(a.equipped));
check("default grenade 407001 kept (not owned, default kit)", a.equipped.grenade === 407001);
check("items = usable only (durable 407003 left out)", a.items.map((i) => i.itemId).join() === "103188,103028,202018,301064", a.items.map((i) => i.itemId).join());

const b = inventoryFromPlayer(player(owned([[103037]]), { primary: 104006, secondary: 202018, melee: 0, grenade: 0, special: 0 }));
check("unowned primary 104006 -> default 103004", b.equipped.primary === 103004, `${b.equipped.primary}`);
check("unowned secondary 202018 -> default 202022", b.equipped.secondary === 202022, `${b.equipped.secondary}`);
check("unowned zero slots -> default kit", b.equipped.melee === 301012 && b.equipped.special === 508002, JSON.stringify(b.equipped));

const c = inventoryFromPlayer(player(owned([]), { primary: 105025, secondary: 0, melee: 323001, grenade: 0, special: 0 }));
check("battle-rule primary 105025 and fist 323001 stay without inventory", c.equipped.primary === 105025 && c.equipped.melee === 323001, JSON.stringify(c.equipped));

const d = inventoryFromPlayer(player(owned([[103037, 1]]), { primary: 103037, secondary: 0, melee: 0, grenade: 0, special: 0 }));
check("durable (never activated) equipped item still counts as owned for the loadout", d.equipped.primary === 103037 && d.items.length === 0, JSON.stringify(d.equipped));

// the Cross lobby gate (weaponSupport isItemShown): an item the Cross client does not ship is absent here too (not offered,
// and an equipped one resets to the default kit like an unowned one)
setWeaponSupport({ complete: [103188, 202018, 301064, 103004, 202022, 301012, 407001, 508002] });
const e = inventoryFromPlayer(player(owned([[103188], [103028], [202018], [301064]]), { primary: 103028, secondary: 202018, melee: 301064, grenade: 407001, special: 508002 }));
check("absent (not complete in Cross) item not offered", e.items.map((i) => i.itemId).join() === "103188,202018,301064", e.items.map((i) => i.itemId).join());
check("absent equipped primary 103028 -> default 103004", e.equipped.primary === 103004, `${e.equipped.primary}`);
setWeaponSupport(null);

console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
