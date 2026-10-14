import type RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { boneHitboxWorld, getBoneHitboxes, hitboxGameZone, type BoneHitbox } from "./charModel";
import { HITBOX_CROUCH, HITBOX_STAND, type ZoneShape } from "./hitbox";
import { HITBOX_COLLISION_GROUPS, type Actor, type HitZone } from "./types";

/** Shape handed to src/weapons resolveTarget (structurally its HitTarget). */
export interface ActorHitTarget {
  hitzone: HitZone;
  id: string;
  hasHelmet: boolean;
  data: Actor;
}

function toHitZone(z: ReturnType<typeof hitboxGameZone>): HitZone {
  return z === "head" ? "head" : z === "body" ? "torso" : "limb"; // arm/leg -> limb (game/types has no separate limb split)
}

interface BoneEntry {
  kind: "bones";
  actor: Actor;
  cols: RAPIER.Collider[];
  hbs: BoneHitbox[];
  enabled: boolean;
}

interface CapsuleEntry {
  kind: "capsule";
  actor: Actor;
  body: RAPIER.RigidBody;
  cols: RAPIER.Collider[];
  crouch: boolean;
  enabled: boolean;
}

type Entry = BoneEntry | CapsuleEntry;

/**
 * Rapier sensor mirrors of the character hitboxes so src/weapons, which raycasts colliders, can
 * resolve head/torso/limb. When the actor has a loaded GLB visual (bots/remotes), one standalone
 * (body-less) sensor cuboid per bone hitbox (charModel.getBoneHitboxes) tracks that bone's world
 * transform every frame, so crouch/lean/animation all move the hitboxes for free. Placeholder
 * visuals (no GLB) fall back to the old 3-capsule analytic shape (hitbox.ts), one kinematic body
 * per actor. Sensors on bit 2: invisible to the KCC (KCC_QUERY) and to world-only rays.
 */
export class HitColliders {
  private byHandle = new Map<number, { actor: Actor; zone: HitZone }>();
  private entries = new Map<string, Entry>();
  private _q = new THREE.Quaternion();
  private _e = new THREE.Euler();
  private _f = new THREE.Vector3();
  private _c = new THREE.Vector3();
  private _half = new THREE.Vector3();
  private _t = { x: 0, y: 0, z: 0 };
  private _r = { x: 0, y: 0, z: 0, w: 1 };

  constructor(private world: RAPIER.World, private R: typeof RAPIER) {}

  add(actor: Actor): void {
    if (this.entries.has(actor.id)) return;
    const hbs = actor.visualRoot ? getBoneHitboxes(actor.visualRoot) : [];
    if (hbs.length) {
      const cols = hbs.map((hb) => {
        boneHitboxWorld(hb, this._c, this._q, this._half);
        const desc = this.R.ColliderDesc.cuboid(
          Math.max(0.02, this._half.x), Math.max(0.02, this._half.y), Math.max(0.02, this._half.z)
        )
          .setSensor(true)
          .setCollisionGroups(HITBOX_COLLISION_GROUPS)
          .setTranslation(this._c.x, this._c.y, this._c.z)
          .setRotation({ x: this._q.x, y: this._q.y, z: this._q.z, w: this._q.w });
        const c = this.world.createCollider(desc);
        this.byHandle.set(c.handle, { actor, zone: toHitZone(hitboxGameZone(hb.zone)) });
        return c;
      });
      this.entries.set(actor.id, { kind: "bones", actor, cols, hbs, enabled: true });
      return;
    }
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -1000, 0));
    const cols = HITBOX_STAND.map((s) => {
      const desc = (s.a === s.b ? this.R.ColliderDesc.ball(s.r) : this.R.ColliderDesc.capsule((s.b - s.a) / 2, s.r))
        .setSensor(true)
        .setCollisionGroups(HITBOX_COLLISION_GROUPS);
      const c = this.world.createCollider(desc, body);
      this.byHandle.set(c.handle, { actor, zone: s.zone });
      return c;
    });
    const e: CapsuleEntry = { kind: "capsule", actor, body, cols, crouch: true, enabled: true };
    this.applyShapes(e, false);
    this.entries.set(actor.id, e);
  }

  remove(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    for (const c of e.cols) this.byHandle.delete(c.handle);
    if (e.kind === "bones") {
      for (const c of e.cols) this.world.removeCollider(c, true);
    } else {
      this.world.removeRigidBody(e.body);
    }
    this.entries.delete(id);
  }

  private applyShapes(e: CapsuleEntry, crouch: boolean): void {
    if (e.crouch === crouch) return;
    e.crouch = crouch;
    const table: ZoneShape[] = crouch ? HITBOX_CROUCH : HITBOX_STAND;
    table.forEach((s, i) => {
      const c = e.cols[i];
      if (s.a !== s.b) c.setHalfHeight((s.b - s.a) / 2);
      c.setRadius(s.r);
      // Body faces -Z at yaw 0, so "forward" is local -Z.
      c.setTranslationWrtParent({ x: 0, y: (s.a + s.b) / 2, z: -(s.forward ?? 0) });
    });
  }

  sync(): void {
    for (const e of this.entries.values()) {
      const on = e.actor.alive;
      if (on !== e.enabled) {
        e.enabled = on;
        for (const c of e.cols) c.setEnabled(on);
      }
      if (!on) continue;
      if (e.kind === "bones") {
        // one matrix refresh of the visual's whole hierarchy per actor (was: ancestors of every hitbox bone)
        e.actor.visualRoot?.updateWorldMatrix(true, true);
        const t = this._t, r = this._r;
        for (let i = 0; i < e.hbs.length; i++) {
          boneHitboxWorld(e.hbs[i], this._c, this._q, undefined, false);
          t.x = this._c.x; t.y = this._c.y; t.z = this._c.z;
          r.x = this._q.x; r.y = this._q.y; r.z = this._q.z; r.w = this._q.w;
          e.cols[i].setTranslation(t);
          e.cols[i].setRotation(r);
        }
        continue;
      }
      this.applyShapes(e, e.actor.isCrouching());
      const f = e.actor.feet(this._f);
      this._q.setFromEuler(this._e.set(0, e.actor.yaw(), 0));
      e.body.setNextKinematicTranslation({ x: f.x, y: f.y, z: f.z });
      e.body.setNextKinematicRotation({ x: this._q.x, y: this._q.y, z: this._q.z, w: this._q.w });
    }
  }

  resolve(collider: RAPIER.Collider): ActorHitTarget | null {
    const m = this.byHandle.get(collider.handle);
    if (!m || !m.actor.alive) return null;
    return { hitzone: m.zone, id: m.actor.id, hasHelmet: m.actor.helmet, data: m.actor };
  }
}
