// Node smoke test for the respawn weapon change (respawnSelect.ts + WeaponSystem.equip + RESPAWN_REQ 5137), no browser:
// local death -> T -> pick primary/secondary -> OK -> respawn -> real WeaponSystem slots; then online the RoomClient
// RESPAWN_REQ body carries the chosen itemIds at Server.Game PROTOCOL_BATTLE_RESPAWN_REQ.Read offsets.
//
//   npx esbuild src/game/dev/respawnMenu.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/rm.mjs && node <tmp>/rm.mjs
import fs from "node:fs";
import path from "node:path";
import {
  BAREFIST_ID, CHANGE_WEAPON_KEY, KNUCKLE_STAGE, RESPAWN_SLOTS, RespawnSelection, WEAPONS_FLAG, catalogFromWeapons,
  enforceRoomWeapons, localTestInventory,
} from "../respawnSelect";
import { WeaponSystem } from "../../weapons/WeaponSystem";
import { WeaponDb } from "../../weapons/data";
import { RoomClient, RoomOp } from "../../net/roomClient";
import { PacketReader, type PacketWriter } from "../../net/packet";

let fails = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`);
};

const PUB = path.resolve("public");
const readJson = (p: string) => JSON.parse(fs.readFileSync(path.join(PUB, p), "utf8"));
// WeaponSystem loads /assets/cross/weapons/weapons.json with fetch: serve it from public/
(globalThis as { fetch: unknown }).fetch = async (url: string) => {
  const f = path.join(PUB, String(url).replace(/^\//, ""));
  return fs.existsSync(f) ? new Response(fs.readFileSync(f)) : new Response("", { status: 404 });
};

const weapons = readJson("assets/cross/weapons/weapons.json");
const models = readJson("assets/weapons/models/index.json");
const catalog = catalogFromWeapons(weapons.weapons);
const inv = localTestInventory(weapons.defaultLoadout, models);
const sel = new RespawnSelection(catalog, inv);

check("key = T (key map 12 default 0x1d)", CHANGE_WEAPON_KEY.code === "KeyT" && CHANGE_WEAPON_KEY.name === "T");
check("5 slots", RESPAWN_SLOTS.length === 5);
check("equipped = weapons.json defaultLoadout", sel.current().primary === 103037 && sel.current().secondary === 202022 &&
  sel.current().melee === 301001 && sel.current().grenade === 407001, JSON.stringify(sel.current()));
check("primary carousel = inventory primaries (models)", sel.view(0).list.length > 1, `n=${sel.view(0).list.length}`);
check("every listed item is in the inventory", RESPAWN_SLOTS.every((_, i) => sel.view(i).list.every((id) => id === 0 || inv.items.some((it) => it.itemId === id))));

// ---- Clube da Luta (stage 224): melee = the bare fist only, guns / grenades barred, the server's loadout the same
const kc = new RespawnSelection(catalog, inv, WEAPONS_FLAG.melee, BAREFIST_ID);
check("knuckle: melee row = the bare fist only", kc.view(2).list.length === 1 && kc.current().melee === BAREFIST_ID, JSON.stringify(kc.view(2).list));
check("knuckle: primary / secondary / grenade barred", !kc.view(0).enabled && !kc.view(1).enabled && !kc.view(3).enabled);
const kl = enforceRoomWeapons(
  [{ itemId: 103037 }, { itemId: 202022 }, { itemId: 301001 }, { itemId: 407001 }, { itemId: 0 }], [], WEAPONS_FLAG.melee, { itemId: 0 }, KNUCKLE_STAGE);
check("knuckle loadout: melee fist, others empty", kl.map((p) => p.itemId).join() === `0,0,${BAREFIST_ID},0,0`, kl.map((p) => p.itemId).join());

// ---- real WeaponSystem.equip/setLoadout/refill (the ctor needs window/document/WebAudio: build the instance
// from the prototype with only the fields those methods touch)
const ws = Object.create(WeaponSystem.prototype) as WeaponSystem;
Object.assign(ws, {
  db: new WeaponDb(), slots: [null, null, null, null], owned: [null, null, null, null], cur: 0, prev: 1, switchL: [], viewmodel: null,
  audio: { preload() {} }, switchTarget: null, reloading: false, pending: [], itemFx: {},
});
await ws.db.load("/assets/cross/weapons/weapons.json");
ws.setLoadout({});
const slotIds = () => [0, 1, 2, 3].map((i) => (ws as unknown as { slots: ({ def: { id: number } } | null)[] }).slots[i]?.def.id ?? 0);

// ---- local: die -> T -> change primary + secondary -> OK
sel.open();
check("panel open", sel.isOpen);
sel.key("ArrowRight"); // primary -> next
sel.key("ArrowDown");
sel.key("ArrowRight"); // secondary -> next
const chosen = sel.current();
check("choice differs from equipped", chosen.primary !== 103037 && chosen.secondary !== 202022, `${chosen.primary}/${chosen.secondary}`);
sel.key("Enter");
check("OK closes + pending for next respawn", !sel.isOpen && sel.hasPending());
// reopening shows the pending choice, cancel keeps it
sel.open();
check("reopen shows pending", sel.current().primary === chosen.primary);
sel.key("Escape");
check("cancel keeps pending", sel.hasPending());

// respawn (Game.applyRespawnLoadout)
const pick = sel.takeForRespawn();
check("respawn loadout = choice", pick.primary === chosen.primary && pick.secondary === chosen.secondary && pick.melee === 301001);
{
  const before = slotIds();
  RESPAWN_SLOTS.forEach((s, i) => { if (i < 4 && pick[s]) ws.equip(pick[s]); });
  ws.refill();
  ws.switchTo(0);
  const after = slotIds();
  check("WeaponSystem.equip -> slots", after[0] === pick.primary && after[1] === pick.secondary && after[2] === pick.melee && after[3] === pick.grenade,
    `before ${before.join(",")} after ${after.join(",")}`);
}
check("no pending after respawn", !sel.hasPending());

// unconfirmed panel at respawn time -> discarded
sel.open(); sel.key("ArrowRight");
const p2 = sel.takeForRespawn();
check("open+unconfirmed at respawn is discarded", p2.primary === pick.primary && !sel.isOpen);

// room weapon limit: knife only (melee bit)
const knife = new RespawnSelection(catalog, inv, WEAPONS_FLAG.melee);
check("limit: primary locked to equipped", !knife.view(0).enabled && knife.view(0).list.length === 1 && knife.limited());
check("limit: melee still changeable", knife.view(2).enabled);
const sniperOnly = new RespawnSelection(catalog, inv, WEAPONS_FLAG.all & ~(16 | 32 | 128 | 256));
check("limit: sniper-only primary list", sniperOnly.view(0).list.slice(1).every((id) => catalog(id)?.className === "Sniper"),
  `n=${sniperOnly.view(0).list.length}`);

// ---- online: RESPAWN_REQ 5137 with the chosen itemIds (battle.ts setRespawnWeapons -> RoomClient.respawn)
const sent: { op: number; body: Uint8Array }[] = [];
const listeners = new Set<(op: number, r: PacketReader) => void>();
const fakeGame = { conn: { on: (fn: (op: number, r: PacketReader) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
  send: (op: number, w?: PacketWriter) => { sent.push({ op, body: w ? w.toBytes() : new Uint8Array() }); } } };
const room = new RoomClient(fakeGame as never);
room.mySlot = 3;
const objIds = [11, 12, 13, 14, 0];
const weaponsPairs = RESPAWN_SLOTS.map((s, i) => ({ itemId: pick[s], objectId: objIds[i] }));
const equip = Array.from({ length: 18 }, (_, i) => (i < 5 ? weaponsPairs[i] : { itemId: 0, objectId: 0 }));
const ack = room.respawn(0x1ff, equip);
// the server answers RESPAWN_ACK {slot, roomSpawns, slotSpawns}; feed it through every registered listener
const ackBody = new Uint8Array(12); new DataView(ackBody.buffer).setInt32(0, 3, true); new DataView(ackBody.buffer).setInt32(8, 7, true);
for (const l of [...listeners]) l(RoomOp.BATTLE_RESPAWN_ACK, new PacketReader(ackBody));
const spawns = await Promise.race([ack, new Promise<number>((r) => setTimeout(() => r(-1), 300))]).catch(() => -2);
const req = sent.find((s) => s.op === RoomOp.BATTLE_RESPAWN_REQ);
check("RESPAWN_REQ opcode 5137 sent", !!req && RoomOp.BATTLE_RESPAWN_REQ === 5137);
if (req) {
  const r = new PacketReader(req.body);
  const ids: number[] = [], objs: number[] = [];
  for (let i = 0; i < 5; i++) { ids.push(r.readD()); objs.push(r.readD()); }
  r.skip(2 * 8 + 8 + 10 * 8);
  const flag = r.readH();
  check("5137 body 154 bytes", req.body.length === 154, `len=${req.body.length}`);
  check("5137 Field0[0..4] = chosen itemIds", ids.join() === RESPAWN_SLOTS.map((s) => pick[s]).join(), ids.join(","));
  check("5137 objectIds", objs.join() === objIds.join());
  check("5137 weapons flag = room flag", flag === 0x1ff, `0x${flag.toString(16)}`);
  console.log("5137 hex:", Buffer.from(req.body.subarray(0, 40)).toString("hex"), "...");
}
console.log("RESPAWN_ACK slotSpawns:", spawns);

console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
