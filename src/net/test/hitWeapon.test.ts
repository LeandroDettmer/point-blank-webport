// A kill / hit by a projectile must carry the projectile's item id, not the weapon in hand (grenade kill with the knife out).
import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ weapons: [{ id: 303001001, name: "K-400" }, { id: 702001001, name: "M-7" }] }) });
const { weaponIdOfName, hitWeaponId } = await import("../battle.ts");

test("hitWeaponId: a barrel blown by a grenade credits the grenade, a bullet-broken one the weapon in hand", async () => {
  weaponIdOfName("K-400");
  await new Promise((r) => setTimeout(r, 10));
  const knifeInHand = 200004001;
  assert.equal(hitWeaponId("K-400", knifeInHand), 303001001); // propBlast weapon = the grenade, not the knife in hand
  assert.equal(hitWeaponId("K-2", knifeInHand), 100003001); // bullet: the breaker's weapon name
  assert.equal(hitWeaponId("nope", knifeInHand), knifeInHand);
  assert.equal(hitWeaponId("nope", -1), 0);
});

test("weaponIdOfName resolves a name outside WEAPON_IDS from weapons.json", async () => {
  weaponIdOfName("K-400"); // starts the fetch
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(weaponIdOfName("K-400"), 303001001); // grenade: was 0 -> fell back to the knife in hand
  assert.equal(weaponIdOfName("K-2"), 100003001);
  assert.equal(weaponIdOfName("123456"), 123456);
  assert.equal(weaponIdOfName("nope"), 0);
});
