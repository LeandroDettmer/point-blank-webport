// Node smoke test: helmet only on actors with a head item equipped (BATTLE_RESPAWN_ACK parts[0]), popped by a head hit
// (computeDamage), back on respawn; the helmet-slot GLB (charEquip.ts helmetFile) is the model that drops; HelmetDrops
// falls onto level collision and rests; the HELMET PROTECTION sprite cell lies on the texture's "Helmet Protection" art;
// every Cross character falls back to its family helmet (no costume exception in the Cross exe).
//   npx esbuild src/game/dev/helmet.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/hm.mjs && node <tmp>/hm.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { actorHasHelmet, clearActorEquip, headgearFiles, helmetFile, noteActorEquip, setEquipIndex, type EquipIndex } from "../charEquip";
import { actorHeadgearOn, actorHelmetDefense, helmetDefenseOf, noteBotEquip } from "../actorEquip";
import { computeDamage, helmetPenetrates } from "../damage";
import { HelmetDrops } from "../helmetDrop";
import { decodeHitPart, encodeHitPart } from "../../net/battle";
import { KILL_MARKS } from "../pbHud/killmarks";
import type { Actor, HitZone } from "../types";

let fails = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`);
};

const PUB = path.resolve("public");
const ix = JSON.parse(fs.readFileSync(path.join(PUB, "assets/equip/index.json"), "utf8")) as EquipIndex;
setEquipIndex(ix);

// ---- 1. helmet = equipped head item, not popped this life (same getter as PlayerActor / Bot / RemoteActor)
class TestActor {
  readonly kind = "bot" as const;
  hp = 110; maxHp = 110; armor = 100; alive = true; invulnUntil = 0; weaponName = "K-2"; name = "t";
  helmetLost = false;
  get helmet(): boolean { return !this.helmetLost && actorHasHelmet(this.id); }
  set helmet(on: boolean) { this.helmetLost = !on; }
  constructor(readonly id: string, public team: 0 | 1) {}
  feet(o: THREE.Vector3) { return o.set(0, 0, 0); }
  eye(o: THREE.Vector3) { return o.set(0, 1.6, 0); }
  yaw() { return 0; }
}
clearActorEquip();
const bare = new TestActor("slot1", 1), capped = new TestActor("slot2", 1), shooter = new TestActor("slot0", 0);
noteActorEquip("slot2", { head: 701002 });
check("no head item -> no helmet", !bare.helmet);
check("head item equipped -> helmet", capped.helmet);
const r0 = computeDamage({ target: bare as unknown as Actor, attacker: shooter as unknown as Actor, base: 30, zone: "head", helmetPenetrate: 0, falloff: 1, preScaled: true, now: 1 });
check("head hit on bare head: nothing pops", !r0.helmetBlocked && r0.dealt === 30);
const r1 = computeDamage({ target: capped as unknown as Actor, attacker: shooter as unknown as Actor, base: 0, zone: "head", helmetPenetrate: 0, falloff: 1, preScaled: true, now: 1 });
check("helmet stops the headshot (0 dealt) and pops", r1.helmetBlocked && r1.dealt === 0 && !capped.helmet, JSON.stringify(r1));
const r2 = computeDamage({ target: capped as unknown as Actor, attacker: shooter as unknown as Actor, base: 30, zone: "head", helmetPenetrate: 0, falloff: 1, preScaled: true, now: 1 });
check("second head hit: helmet already gone", !r2.helmetBlocked && r2.dealt === 30);
capped.helmetLost = false;
check("respawn: equipped helmet is back", capped.helmet);
// non-preScaled path keeps the exe roll (CalcHelmetPenetrate 0x5425e0): penetrate 0 -> always blocked
const r3 = computeDamage({ target: capped as unknown as Actor, attacker: shooter as unknown as Actor, base: 40, zone: "head", helmetPenetrate: 0, falloff: 1, now: 1 });
check("helmet roll (pen 0) blocks, 0 dealt", r3.helmetBlocked && r3.dealt === 0);

// ---- 1b. a default character (parts[0] 0) has no head item: no protection; a bot seat gets the empty loadout, not the
// head item of the player who held it; a head item protects with its own pef Defense (actorEquip.ts helmetDefenseOf)
const dflt = new TestActor("slot5", 1);
noteActorEquip("slot5", { head: 0, face: 0, beret: 0 });
const rd = computeDamage({ target: dflt as unknown as Actor, attacker: shooter as unknown as Actor, base: 30, zone: "head", helmetPenetrate: 0, falloff: 1, now: 1 });
check("default character: headshot not protected, full damage", !dflt.helmet && !rd.helmetBlocked && rd.dealt > 0 && actorHelmetDefense("slot5") === 0, JSON.stringify(rd));
const seat = new TestActor("slot6", 1);
noteActorEquip("slot6", { head: 700154 }); // the player who held the seat wore a protecting mask
check("seat held by a masked player: protected", seat.helmet && actorHelmetDefense("slot6") === 1.5);
noteBotEquip("slot6"); // a bot takes the seat: no 5138, so no head item
check("bot on that seat: no protection", !seat.helmet && actorHelmetDefense("slot6") === 0);
noteActorEquip("slot7", { head: 700160 }); // MOD Hat: a head item with no pef Defense
const hat = new TestActor("slot7", 1);
check("head item without pef Defense: no protection, still drawn", !hat.helmet && actorHeadgearOn("slot7", false) && helmetDefenseOf(700160) === 0);
check("per-item rate: helmet 1.3 stops a roll that helmet 0.75 lets through", !helmetPenetrates(0.5, 1.3, 0.5) && helmetPenetrates(0.5, 0.75, 0.5));
check("beret alone: no helmet protection", (() => { noteActorEquip("slot8", { beret: 2700010 }); return !new TestActor("slot8", 1).helmet; })());

// ---- 2. which GLB drops
const hf = helmetFile(ix, "swat_male", { head: 701002 });
check("default helmet file", hf === "helmet_default/SWAT_Male.glb" && headgearFiles(ix, "swat_male", { head: 701002 })[0] === hf, String(hf));
check("hat head item is the helmet slot", helmetFile(ix, "swat_male", { head: 700140 })?.startsWith("cowboyhat/") ?? false, String(helmetFile(ix, "swat_male", { head: 700140 })));
const beretId = Number(Object.entries(ix.items).find(([, v]) => v.slot === "beret")?.[0]);
// a beret holds the helmet slot and pops off like a helmet on a head hit (game.ts popBeret, charEquip.ts helmetFile)
const bf = helmetFile(ix, "swat_male", { head: 701002, beret: beretId });
check("beret holds the slot -> the beret model drops", !!bf && bf !== hf && bf === headgearFiles(ix, "swat_male", { head: 701002, beret: beretId })[0], String(bf));
check("helmet GLB exists on disk", !!hf && fs.existsSync(path.join(PUB, "assets/equip", hf)));

// ---- 2b. Cross rule: no costume exception. GetResNameHead 0x56b230 resolves the Helmet slot to the item's res name, else
// "Helmet" (0x56b318), and the equip preload 0x56b590 loads Equip/<Family>/<Family>_Helmet.I3CHR for every family, with no
// character flag in between; the Cross Character.pef has no PartsList / ResDftPartSkin (the 3.123 costume rule).
const crossChara = JSON.parse(fs.readFileSync(path.join(PUB, "assets/cross/config/character.json"), "utf8")).Character as Record<string, Record<string, unknown>>;
check("Cross Character.pef has no PartsList (no costume rule)", Object.values(crossChara).every((v) => !("PartsList" in v)));
const chars = JSON.parse(fs.readFileSync(path.join(PUB, "assets/chars/index.json"), "utf8")).chars as { id: string }[];
for (const { id } of chars) {
  const def = ix.charas[id] && headgearFiles(ix, id, { head: 700160 })[0]; // MOD Hat 700160: head item without a Cross GLB
  check(`${id}: unmapped head item -> family helmet`, !!def && def.startsWith(`${ix.charas[id].helmet}/`) && fs.existsSync(path.join(PUB, "assets/equip", def)), String(def));
}
const mask = Number(Object.entries(ix.items).find(([, v]) => v.slot === "face")?.[0]);
check("a face mask takes the default helmet off, mask drawn", headgearFiles(ix, "swat_male", { head: 701002, face: mask }).length === 1 && !headgearFiles(ix, "swat_male", { head: 701002, face: mask })[0].startsWith("helmet_default/"), String(headgearFiles(ix, "swat_male", { head: 701002, face: mask })));
check("ViperRed keeps its cap", headgearFiles(ix, "rebel_viperred", { head: 701020 }).join() === "helmet_default/ViperRed.glb");

// ---- 3. drop physics on a floor collider
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20).setTranslation(0, -0.5, 0));
world.step();
const scene = new THREE.Scene();
const drops = new HelmetDrops(scene, world, RAPIER);
const m = new THREE.Matrix4().makeTranslation(0, 1.75, 0);
drops.spawn({ charaName: "swat_male", equip: { head: 701002 }, matrix: m }, new THREE.Vector3(0, 0, -1));
const trace: string[] = [];
for (let i = 0; i < 180; i++) {
  drops.update(1 / 60);
  if (i % 20 === 0) { const s = drops.debugState()[0]; trace.push(`${(i / 60).toFixed(2)}s y=${s.pos[1].toFixed(2)} z=${s.pos[2].toFixed(2)}`); }
}
const st = drops.debugState()[0];
console.log("     " + trace.join(" | "));
check("helmet rests on the floor", !!st && st.resting && Math.abs(st.pos[1] - 0.08) < 0.05, JSON.stringify(st?.pos));
check("knocked along the shot (-z)", !!st && st.pos[2] < -0.3);
for (let i = 0; i < 60 * 8; i++) drops.update(1 / 60);
check("gone after its lifetime", drops.debugState().length === 0);

// ---- 4. banner sprite cell sits on the "Helmet Protection" art of kill_message.png
function decodePng(p: string) {
  const b = fs.readFileSync(p); let o = 8, w = 0, h = 0; const idat: Buffer[] = [];
  while (o < b.length) { const len = b.readUInt32BE(o), t = b.toString("ascii", o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len); if (t === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); } if (t === "IDAT") idat.push(d); o += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat)), st = w * 4, out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) { const f = raw[y * (st + 1)], r = raw.subarray(y * (st + 1) + 1, (y + 1) * (st + 1)); for (let x = 0; x < st; x++) { const a = x >= 4 ? out[y * st + x - 4] : 0, up = y ? out[(y - 1) * st + x] : 0, c = x >= 4 && y ? out[(y - 1) * st + x - 4] : 0; let v = r[x]; if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1; else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; } out[y * st + x] = v & 255; } }
  return { w, h, a: (x: number, y: number) => out[(y * w + x) * 4 + 3] };
}
const tex = decodePng(path.join(PUB, "assets/ui/hud/kill_message.png"));
const sp = KILL_MARKS.helmetProtection.sprite!;
let inside = 0, edge = 0;
for (let y = sp.y; y < sp.y + sp.h; y++) for (let x = sp.x; x < sp.x + sp.w; x++) {
  const on = tex.a(x, y) > 16;
  if (on) inside++;
  if (on && (y === sp.y || y === sp.y + sp.h - 1 || x === sp.x || x === sp.x + sp.w - 1)) edge++;
}
check("sprite cell has the art and does not clip it", inside > 2000 && edge === 0, `opaque=${inside} edge=${edge}`);

// ---- 5. helmet-drop-sync: HitData.part (net/battle.ts) round-trips helmetBlocked so a third client (neither
// shooter nor victim, who each pop locally already) can run the same popHelmet path off the relayed HitEvent.
for (const zone of ["head", "torso", "limb"] as HitZone[]) {
  for (const helmetBlocked of [true, false]) {
    const part = encodeHitPart(zone, helmetBlocked);
    const back = decodeHitPart(part);
    check(`part round-trip zone=${zone} helmetBlocked=${helmetBlocked}`, back.zone === zone && back.helmetBlocked === helmetBlocked, `part=${part}`);
  }
}
check("helmet flag doesn't alias PART_HEAD (14) into another zone", decodeHitPart(14).zone === "head" && !decodeHitPart(14).helmetBlocked);

console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
