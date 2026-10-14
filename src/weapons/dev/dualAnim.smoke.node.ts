// Node smoke: dual-pistol clip selection (stateKey DualGun before plain) + left slide on Viewmodel.fireKick.
//   npx esbuild src/weapons/dev/dualAnim.smoke.node.ts --bundle --platform=node --format=esm --outfile=<tmp>/da.mjs && node <tmp>/da.mjs
import * as THREE from "three";
import { WeaponAnimator } from "../weaponAnim";
import { Viewmodel } from "../viewmodel";

let fails = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? "  " + info : ""}`);
};

const clip = (n: string) => new THREE.AnimationClip(n, 1, []);
const st = (n: string) => ({ clip: clip(n), dur: 1 });
const set: any = {
  id: "t", ai: "t",
  states: { Idle: st("Idle"), LoadMag1PV: st("a"), LoadMag1PV_DualGun_Left: st("L"), LoadMag1PV_DualGun_Right: st("R") },
};
const a = new WeaponAnimator(new THREE.Object3D(), set, "1pv" as any);
check("right hand picks _DualGun_Right", a.stateKey("reload") === "LoadMag1PV_DualGun_Right", String(a.stateKey("reload")));
a.hand = "L";
check("left hand picks _DualGun_Left", a.stateKey("reload") === "LoadMag1PV_DualGun_Left", String(a.stateKey("reload")));
const single = new WeaponAnimator(new THREE.Object3D(), { ...set, states: { Idle: st("Idle"), LoadMag1PV: st("a") } }, "1pv" as any);
check("single gun keeps LoadMag1PV", single.stateKey("reload") === "LoadMag1PV");

const calls: string[] = [];
const fake: any = {
  dual: true, rigActive: false, kickVel: 0, side: "R", family: "HG", semi: true, burst: false,
  wAnim: { fire: () => calls.push("R") }, wAnimL: { fire: () => calls.push("L") }, fireCycle: () => undefined,
};
const kick = (l: boolean | "both") => { calls.length = 0; (Viewmodel.prototype as any).fireKick.call(fake, 1, l); return calls.join(""); };
check("fireKick right -> R only", kick(false) === "R", kick(false));
check("fireKick left -> L only", kick(true) === "L", kick(true));
check("fireKick both -> R+L", kick("both") === "RL", kick("both"));
process.exit(fails ? 1 : 0);
