import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { jsonOnce } from "../jsonOnce";

/*
 * Death ragdoll, exe-2017 CGameCharaManager::DeathHuman 0x5734d0: with the PhysX option on (env +0x74 "PhysXEnable",
 * Option opCapacityPhysX / STR_POPUP_PHYSICS_EFFECT) the death goes to _SetPhysixValue 0x572aa0 and NO death clip
 * plays; option off -> _SetDeathAnimation 0x573090 (the Stand_/Sit_Death clips, charAnim.die).
 *
 * Bodies / joints: the character's own i3PhysixShapeSet + i3PhysixJointInfoD6 (pb-extract-tools export-ragdoll.mjs ->
 * chars/<name>/ragdoll.json): 20 convex hulls with their pack mass, 19 D6 joints (anchors, axes, locked / limited axes).
 * _SetPhysixValue zeroes every body's velocities, then by CHARA_DEATH_TYPE (jump table 0x572ebc):
 *   BOOM 2 / OBJECT_EXPLOSION 5 -> _ProcessPhysixValueByExplosion 0x571eb0, FALLING 4 / POISON 7 -> no push,
 *   DEFAULT 1 / HEADSHOT 3 / FAST_OBJECT 6 -> _ProcessPhysixValueByDefault 0x572340.
 * Numbers: Basic.pef Physix (CPhysixInfo::ReadInfo 0x69248f): Character_Death LinearForce 0.32 (+0x84), AngularForce 0.16
 * (+0x88), Weapon_<class> (+0x68.. via 0x615c80); scene Gravity -9.81, SimTime 1.2 (i3PhysixContext::simulate scales dt).
 *
 * [INFERIDO]: Rapier has no per-joint frames in JS, so every body's local space is the character's bind space (the joint
 * frames of both actors coincide at bind, checked on the packs) and a generic joint takes the twist axis; its swing axes
 * are Rapier's, matched to swing1 / swing2 by the nearest one. PhysX soft limits (spring) become hard limits; a range under
 * LOCK_EPS is locked. SimTime 1.2 = velocities x 1.2 and gravity x 1.44 (same ballistic path). Self collision is off (the
 * exe masks most part pairs, setActorPairFlags 0x53fc10, not decoded per pair).
 */

type V3 = [number, number, number];
interface Limit { 0: number; 1: number; 2: number; 3: number }
interface RagdollJoint { axis: [V3, V3]; normal: [V3, V3]; anchor: [V3, V3]; motion: number[]; swing1: Limit; swing2: Limit; twistLow: Limit; twistHigh: Limit }
interface RagdollBody { bone: string; shape: string; part: number; parent: string | null; mass: number; restitution: number; friction: [number, number]; hull: V3[]; joint: RagdollJoint | null }
interface RagdollData { bodies: RagdollBody[] }

/** what killed the character, for the death push (noteHit on the visual) */
export interface DeathHit {
  /** world direction the bullet / blast travelled (normalized) */
  dir: THREE.Vector3;
  /** world hit point (bullet) / blast centre (explosion) */
  point: THREE.Vector3;
  head: boolean;
  /** weapon.pef Damage of the weapon (0x5833e0) */
  damage: number;
  /** WEAPON_CLASS_TYPE (weapons.json classType) */
  classType: number;
  explosion: boolean;
}

/** Character_Death Weapon_<class> factor by WEAPON_CLASS_TYPE (0x615c80, byte table 0x615dcc); others 1 */
const CLASS_FORCE: Record<number, number> = { 1: 0.75 * 2.5, 2: 2.7, 3: 3.8, 4: 3.6, 5: 1.3, 6: 5, 10: 3.8, 14: 2.7, 15: 0.75 * 2.5, 23: 0.75 * 2.5, 26: 3.8, 34: 3.8, 35: 5 };
/** ByDefault force per CHARA_HIT_PART (0x572340, byte table 0x572870 / jump table 0x572844); others 0.8 */
const PART_FORCE: Record<number, number> = { 1: 0.61, 2: 0.8, 3: 0.77, 4: 0.67, 5: 0.51, 9: 1.2, 13: 0.9, 14: 0.9, 15: 0.9, 16: 0.9, 17: 0.9, 18: 0.9, 19: 0.71, 20: 0.71, 21: 0.51, 23: 0.051, 24: 0.51, 26: 0.051, 34: 1.2 };
const LINEAR_FORCE = 0.32, ANGULAR_FORCE = 0.16, WEAPON_GRENADE = 3;
const SIM_TIME = 1.2;
const LOCK_EPS = 0.02; // rad [INFERIDO]
/** [INFERIDO] Rapier stability: the pack's 0.05 kg head / 0.1 kg hands next to 4-10 kg bodies jitter on their limits and never sleep */
const MIN_MASS = 0.5;
/** CGameCharaManager keeps one ragdoll per slot (iDeathIdx < 16) */
const MAX_RAGDOLLS = 16;
/** member of bit 3, sees the world only: not hit by world / KCC / bullet queries (types.ts groups), no self collision */
const RAGDOLL_GROUPS = (0x0008 << 16) | 0x0001;
const HEAD_PART = 34, ROOT_PART = 1;

const data = new Map<string, Promise<RagdollData | null>>();
export function loadRagdoll(charaName: string): Promise<RagdollData | null> {
  let p = data.get(charaName);
  if (!p) data.set(charaName, (p = jsonOnce<RagdollData>(`/assets/chars/${charaName}/ragdoll.json`).catch(() => null)));
  return p;
}

interface Part { def: RagdollBody; bone: THREE.Object3D; body: RAPIER.RigidBody; bind: THREE.Quaternion;
  /** the bone's local pose at death: put back on release (the clips may not key every bone's position) */
  rest: [THREE.Vector3, THREE.Quaternion] }
export interface Ragdoll { parts: Part[]; meshes: THREE.Object3D[]; done: boolean }

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _w = new THREE.Vector3(), _body = new THREE.Quaternion();

export class RagdollSystem {
  private live: Ragdoll[] = [];
  constructor(private world: RAPIER.World, private R: typeof RAPIER) {}

  /**
   * Hands the posed skeleton under `model` to PhysX-like bodies. Synchronous: `rd` must be loaded (loadRagdoll). The
   * bones keep their current pose as the start; `hit` = the killing shot (null: no push, like FALLING / POISON).
   */
  spawn(model: THREE.Object3D, rd: RagdollData, hit: DeathHit | null): Ragdoll | null {
    const R = this.R;
    model.updateWorldMatrix(true, true);
    // bind rotation of each bone in the mesh's bind space (inverse of the skin's inverse bind matrix)
    const bind = new Map<THREE.Object3D, THREE.Quaternion>();
    const meshes: THREE.Object3D[] = [];
    model.traverse((o) => {
      const sk = (o as THREE.SkinnedMesh).skeleton;
      if (!sk) return;
      meshes.push(o);
      sk.bones.forEach((b, i) => { if (!bind.has(b)) bind.set(b, new THREE.Quaternion().setFromRotationMatrix(_m.copy(sk.boneInverses[i]).invert())); });
    });
    const byName = new Map<string, Part>();
    const parts: Part[] = [];
    for (const def of rd.bodies) {
      const bone = model.getObjectByName(def.bone) ?? model.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(def.bone));
      const g = bone && bind.get(bone);
      if (!bone || !g) return null;
      bone.matrixWorld.decompose(_p, _q, _s);
      const s = _s.x;
      // body frame = bone frame without its bind rotation: bone-local v -> body-local g * (s v)
      const rot = _q.clone().multiply(g.clone().invert());
      const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(_p.x, _p.y, _p.z).setRotation(rot)
        .setAngularDamping(0.05).setGravityScale(SIM_TIME * SIM_TIME).setAdditionalSolverIterations(4).setCcdEnabled(true));
      const pts = new Float32Array(def.hull.length * 3);
      def.hull.forEach((h, i) => { _v.set(h[0], h[1], h[2]).multiplyScalar(s).applyQuaternion(g); pts.set([_v.x, _v.y, _v.z], i * 3); });
      const cd = R.ColliderDesc.convexHull(pts);
      if (cd) this.world.createCollider(cd.setMass(Math.max(MIN_MASS, def.mass)).setFriction(def.friction[1]).setRestitution(def.restitution).setCollisionGroups(RAGDOLL_GROUPS), body);
      const part = { def, bone, body, bind: g, rest: [bone.position.clone(), bone.quaternion.clone()] as [THREE.Vector3, THREE.Quaternion] };
      parts.push(part);
      byName.set(def.bone, part);
      // joint: actor 0 = parent body, actor 1 = this one (CreateJoint 0x100ceb30)
      const j = def.joint, par = def.parent ? byName.get(def.parent) : undefined;
      if (j && par) this.joint(par, part, j, s);
    }
    this.push(parts, hit);
    for (const m of meshes) m.frustumCulled = false; // the body leaves the skin's bind bounds
    const r: Ragdoll = { parts, meshes, done: false };
    this.live.push(r);
    if (this.live.length > MAX_RAGDOLLS) this.release(this.live[0]);
    return r;
  }

  private joint(par: Part, ch: Part, j: RagdollJoint, s: number): void {
    const R = this.R, A = R.JointAxesMask;
    const a1 = _v.set(...j.anchor[0]).multiplyScalar(s).applyQuaternion(par.bind).clone();
    const a2 = _v.set(...j.anchor[1]).multiplyScalar(s).applyQuaternion(ch.bind).clone();
    const axis = new THREE.Vector3(...j.axis[0]).applyQuaternion(par.bind).normalize();
    const normal = new THREE.Vector3(...j.normal[0]).applyQuaternion(par.bind).normalize();
    // Rapier's frame: X = axis, Y = shortest-arc image of +Y; swing1 (PhysX: about the normal) goes on the closer one
    const y = _w.set(0, 1, 0).applyQuaternion(_q.setFromUnitVectors(_p.set(1, 0, 0), axis));
    const swapSwing = Math.abs(y.dot(normal)) < Math.SQRT1_2;
    const lim: { axis: number; mask: number; motion: number; min: number; max: number }[] = [
      { axis: 3, mask: A.AngX, motion: j.motion[5], min: j.twistLow[0], max: j.twistHigh[0] },
      { axis: 4, mask: A.AngY, motion: swapSwing ? j.motion[4] : j.motion[3], min: -(swapSwing ? j.swing2[0] : j.swing1[0]), max: swapSwing ? j.swing2[0] : j.swing1[0] },
      { axis: 5, mask: A.AngZ, motion: swapSwing ? j.motion[3] : j.motion[4], min: -(swapSwing ? j.swing1[0] : j.swing2[0]), max: swapSwing ? j.swing1[0] : j.swing2[0] },
    ];
    let locked = A.LinX | A.LinY | A.LinZ;
    for (const l of lim) if (l.motion === 0 || (l.motion === 1 && l.max - l.min < LOCK_EPS)) locked |= l.mask;
    const jt = this.world.createImpulseJoint(R.JointData.generic(a1, a2, axis, locked), par.body, ch.body, true);
    const raw = (this.world.impulseJoints as unknown as { raw: { jointSetLimits(h: number, axis: number, min: number, max: number): void } }).raw;
    for (const l of lim) if (l.motion === 1 && !(locked & l.mask)) raw.jointSetLimits(jt.handle, l.axis, l.min, l.max);
  }

  /** start velocities (setFBLinearVelocity / addFBLinearVelocity), x SimTime */
  private push(parts: Part[], hit: DeathHit | null): void {
    if (!hit) return;
    const pos = (p: Part) => { const t = p.body.translation(); return new THREE.Vector3(t.x, t.y, t.z); };
    const d = hit.dir.clone().normalize();
    const vel = new Map<Part, THREE.Vector3>();
    const add = (p: Part, v: THREE.Vector3) => (vel.get(p) ?? vel.set(p, new THREE.Vector3()).get(p)!).add(v);
    const set = (p: Part, v: THREE.Vector3) => vel.set(p, v.clone());
    if (hit.explosion) {
      // 0x571eb0: v = dir * Grenade + up Grenade * 1.4; the hit part x 1.7, every other part v
      // [INFERIDO]: the blast's hit part = the root; dir = centre -> victim (the 0x5276c0 sign test is not decoded)
      const g = WEAPON_GRENADE;
      const v = d.clone().multiplyScalar(g).add(_v.set(0, g * 1.4, 0));
      for (const p of parts) if (p.def.part) set(p, p.def.part === ROOT_PART ? v.clone().multiplyScalar(1.7) : v);
      // the head's lever (hit point - head) x dir spins the rest: + ((pos - hit) x T) * Grenade * 3
      const head = parts.find((p) => p.def.part === HEAD_PART);
      if (head) {
        const T = hit.point.clone().sub(pos(head)).cross(d);
        for (const p of parts) if (p.def.part && p.def.part !== ROOT_PART) add(p, pos(p).sub(hit.point).cross(T).multiplyScalar(g * 3));
      }
    } else {
      // 0x572340: the shot body = the head on a head hit, else the body nearest the hit point
      const hitPart = hit.head ? parts.find((p) => p.def.part === HEAD_PART) ?? parts[0]
        : parts.reduce((a, b) => (pos(a).distanceToSquared(hit.point) <= pos(b).distanceToSquared(hit.point) ? a : b));
      const part = hitPart.def.part;
      let F = hit.damage * (PART_FORCE[part] ?? 0.8) * 0.3 + hit.damage * 0.1 + 30;
      // x Weapon_<class> x PhysixForceRate (pef default 1.0, ctor 0x5b358d; 4 on the CIC dual pistols, class 13)
      F *= (CLASS_FORCE[hit.classType] ?? 1) * (hit.classType === 13 ? 4 : 1);
      let v = d.clone().multiplyScalar(F * LINEAR_FORCE);
      set(hitPart, v);
      if (part !== ROOT_PART) {
        // 0x571e20: every ancestor body gets half of its child's velocity
        let p: Part | undefined = hitPart;
        while ((p = p.def.parent ? parts.find((x) => x.def.bone === p!.def.parent) : undefined)) set(p, (v = v.clone().multiplyScalar(0.5)));
        const T = hit.point.clone().sub(pos(hitPart)).cross(d);
        for (const q of parts) if (q.def.part && q.def.part !== part && q.def.part !== ROOT_PART) add(q, pos(q).sub(hit.point).cross(T).multiplyScalar(F * ANGULAR_FORCE));
      }
    }
    for (const [p, v] of vel) p.body.setLinvel(v.multiplyScalar(SIM_TIME), true);
  }

  /** bones follow the bodies (parents first: the export keeps the skeleton order) */
  update(): void {
    for (const r of this.live) {
      if (r.done) continue;
      if (r.parts.every((p) => p.body.isSleeping())) continue;
      for (const p of r.parts) {
        const t = p.body.translation(), q = p.body.rotation();
        if (t.y < -100) { r.done = true; break; } // fell out of the map
        const parent = p.bone.parent!;
        parent.matrixWorld.decompose(_p, _q, _s);
        // world bone rotation = body rotation x bind rotation
        const wq = _q.invert().multiply(_body.set(q.x, q.y, q.z, q.w).multiply(p.bind));
        p.bone.quaternion.copy(wq);
        p.bone.position.copy(parent.worldToLocal(_v.set(t.x, t.y, t.z)));
        p.bone.updateMatrixWorld(true);
      }
    }
  }

  release(r: Ragdoll | null | undefined): void {
    if (!r) return;
    const i = this.live.indexOf(r);
    if (i < 0) return;
    this.live.splice(i, 1);
    for (const p of r.parts) {
      this.world.removeRigidBody(p.body);
      p.bone.position.copy(p.rest[0]);
      p.bone.quaternion.copy(p.rest[1]);
    }
    for (const m of r.meshes) m.frustumCulled = true;
  }

  clear(): void {
    for (const r of [...this.live]) this.release(r);
  }

  get count(): number {
    return this.live.length;
  }
}

/** set by game.ts with the match's physics world (null between matches = the death clip) */
export let ragdolls: RagdollSystem | null = null;
export function setRagdollSystem(s: RagdollSystem | null): void {
  ragdolls?.clear();
  ragdolls = s;
}
