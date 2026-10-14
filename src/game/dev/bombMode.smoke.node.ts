// node --experimental-transform-types src/game/dev/bombMode.smoke.node.ts
import assert from "node:assert/strict";
import { BOMB, BombMode, sitesFromMap, type BombInput, type Vec3 } from "../bombMode.ts";

const sites = sitesFromMap([[10, 0, 10]]);
assert.equal(sitesFromMap([[0, 0, 0], [1, 2, 3]]).length, 1); // (0,0,0) = no such area
assert.equal(sitesFromMap([[0, 0, 0], [1, 2, 3]])[0].area, 1);

const log: string[] = [];
const b = new BombMode(sites, {
  onPlantDone: (s, p) => { log.push(`plant${s}`); b.plant(s, p); },
  onDefuseDone: () => { log.push("defuse"); b.defuse(); },
  onExplode: () => log.push("boom"),
});
const fr = (over: Partial<BombInput> = {}): BombInput => ({ team: 0, alive: true, pos: [10, 0, 10.5], plantHeld: true, defuseHeld: false, hasC4: true, ...over });
const ct = (over: Partial<BombInput> = {}): BombInput => ({ team: 1, alive: true, pos: [10, 0, 10.5], plantHeld: false, defuseHeld: true, hasC4: false, ...over });
const run = (secs: number, i: () => BombInput) => { for (let t = 0; t < secs; t += 0.05) b.update(0.05, i()); };

// releasing before the hold ends restarts it
run(3, () => fr());
assert.ok(b.progress > 0.5 && b.state === "idle");
run(0.1, () => fr({ plantHeld: false }));
assert.equal(b.progress, 0);
// too far from the site: no hold
run(1, () => fr({ pos: [20, 0, 20] }));
assert.equal(b.action, null);
// defenders cannot plant, attackers without the C4 cannot
run(1, () => fr({ team: 1 }));
run(1, () => fr({ hasC4: false }));
assert.equal(b.state, "idle");
// full hold plants at site 0 and starts the fuse
run(BOMB.plantTime + 0.2, () => fr());
assert.deepEqual(log, ["plant0"]);
assert.equal(b.state, "planted");
assert.ok(Math.abs(b.fuseLeft - (BOMB.fuse - 0.1)) < 0.2);
// attackers cannot defuse; a defender out of reach cannot either
run(2, () => fr({ plantHeld: false, defuseHeld: true }));
assert.equal(b.action, null);
run(2, () => ct({ pos: [30, 0, 30] }));
assert.equal(b.action, null);
// defuse before the fuse ends
run(BOMB.defuseTime + 0.2, () => ct());
assert.deepEqual(log, ["plant0", "defuse"]);
assert.equal(b.state, "defused");

// fuse: explodes after 42 s
b.reset(0);
b.plant(0, [10, 0, 10]);
run(BOMB.fuse + 0.5, () => ct({ defuseHeld: false }));
assert.equal(log.at(-1), "boom");
assert.equal(b.state, "exploded");

// speed kit: defuse 5 s (Cross exe 0x584600)
b.reset(0); b.speedKit = true; b.plant(0, [10, 0, 10]);
run(BOMB.defuseTimeKit + 0.2, () => ct());
assert.equal(b.state, "defused");

// exe area rule: 3D < 2 m and |dy| < 0.2
const b3 = new BombMode(sitesFromMap([[10, 5, 10]]));
assert.equal(b3.siteAt([11, 5.1, 10]), 0);
assert.equal(b3.siteAt([11, 5.3, 10]), -1); // 0.3 m above the site
assert.equal(b3.siteAt([12.1, 5, 10]), -1); // 2.1 m away
// side swap: CT plants
const b2 = new BombMode(sitesFromMap([[55, 3, -20]]));
b2.reset(1);
b2.update(0.1, { team: 1, alive: true, pos: [55, 3, -20] as Vec3, plantHeld: true, defuseHeld: false, hasC4: true });
assert.equal(b2.action, "plant");
console.log("bombMode smoke ok");
