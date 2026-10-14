import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { DropField, type DroppedWeapon, type Vec3 } from "../gameplay/pbDrop";
import { createWeaponModel } from "../weapons/worldModel";
import { WORLD_ONLY_QUERY } from "./types";

/*
 * Dropped weapons in the scene: the weapon's own GLB (weapons/worldModel.ts), lying on its side, falling to the floor.
 * Rules (index ring, lifetime, pick-up) are gameplay/pbDrop.ts. The exe drops a PhysX body placed at the character with
 * the chara matrix turned 90 / 180 / 90 deg (GAMEINFO_DROPWEAPON init 0x982070) and the host streams its position
 * (subHead DroppedWeapon); [RECRIADO] here: a small toss along the facing + gravity, stopped by a ray on the level
 * collision, computed the same way on every client (no position stream).
 */

const GRAVITY = 9.8;
const TOSS_SPEED = 1.6; // m/s forward [RECRIADO]
const TOSS_UP = 1.2;
const HAND_HEIGHT = 1.0; // m above the feet [RECRIADO]
const REST = 0.04; // model half-thickness above the floor

interface Visual {
  root: THREE.Group;
  vel: THREE.Vector3;
  resting: boolean;
  mats: THREE.Material[];
}

export class DropVisuals {
  readonly field: DropField;
  private vis = new Map<number, Visual>();
  private gen = new Map<number, number>();

  constructor(private scene: THREE.Scene, private world: RAPIER.World, private R: typeof RAPIER, timedMode = true, maxIndex?: number) {
    this.field = new DropField(maxIndex, timedMode);
  }

  /** Spawns the weapon at the dropper (feet + yaw) and returns the drop record. */
  spawn(d: Omit<DroppedWeapon, "t" | "pickable" | "alpha" | "idx" | "pos"> & { idx?: number }, feet: Vec3, yaw: number): DroppedWeapon {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const pos = { x: feet.x + fx * 0.3, y: feet.y + HAND_HEIGHT, z: feet.z + fz * 0.3 };
    const w = this.field.add({ ...d, pos });
    this.removeVisual(w.idx); // a reused ring index replaces the old weapon
    const root = new THREE.Group();
    root.position.set(pos.x, pos.y, pos.z);
    root.rotation.set(0, yaw + Math.PI / 2, 0);
    this.scene.add(root);
    const v: Visual = { root, vel: new THREE.Vector3(fx * TOSS_SPEED, TOSS_UP, fz * TOSS_SPEED), resting: false, mats: [] };
    this.vis.set(w.idx, v);
    const g = (this.gen.get(w.idx) ?? 0) + 1;
    this.gen.set(w.idx, g);
    void createWeaponModel(d.weaponId).then((m) => {
      if (!m || this.gen.get(w.idx) !== g || !this.vis.has(w.idx)) return;
      const axis = new THREE.Group();
      axis.matrixAutoUpdate = false;
      axis.matrix.copy(m.axis);
      axis.add(m.object);
      const side = new THREE.Group();
      side.rotation.z = Math.PI / 2; // on its side (the exe turns the chara matrix 90 deg twice, 0x982186 / 0x9821b0)
      side.add(axis);
      root.add(side);
      m.object.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        const mm = Array.isArray(mesh.material) ? mesh.material.map((x) => x.clone()) : mesh.material.clone();
        mesh.material = mm;
        v.mats.push(...(Array.isArray(mm) ? mm : [mm]));
      });
    });
    return w;
  }

  /** The owner's position stream (SubHead.DroppedWeapon): moves the drop there; at rest it stops falling here too. */
  place(idx: number, pos: Vec3, resting: boolean): void {
    const d = this.field.drops.get(idx), v = this.vis.get(idx);
    if (!d || !v) return;
    v.root.position.set(pos.x, pos.y, pos.z);
    d.pos.x = pos.x;
    d.pos.y = pos.y;
    d.pos.z = pos.z;
    if (resting) {
      v.resting = true;
      v.vel.set(0, 0, 0);
    }
  }

  /** Removes a drop (picked up / expired) from the field and the scene. */
  remove(idx: number): DroppedWeapon | null {
    this.removeVisual(idx);
    return this.field.remove(idx);
  }

  private removeVisual(idx: number): void {
    const v = this.vis.get(idx);
    if (!v) return;
    this.scene.remove(v.root);
    for (const m of v.mats) m.dispose();
    this.vis.delete(idx);
  }

  /** Physics + fade; returns true when a pick-up search is due (every 0.25 s). */
  update(dt: number): boolean {
    const { removed, search } = this.field.update(dt);
    for (const d of removed) this.removeVisual(d.idx);
    for (const d of this.field.drops.values()) {
      const v = this.vis.get(d.idx);
      if (!v) continue;
      if (!v.resting) this.fall(d, v, dt);
      if (d.alpha < 1) for (const m of v.mats) {
        m.transparent = true;
        m.opacity = d.alpha;
      }
    }
    return search;
  }

  private fall(d: DroppedWeapon, v: Visual, dt: number): void {
    v.vel.y -= GRAVITY * dt;
    const p = v.root.position;
    const step = v.vel.clone().multiplyScalar(dt);
    const len = step.length();
    if (len > 1e-6) {
      const dir = step.clone().divideScalar(len);
      const hit = this.world.castRayAndGetNormal(new this.R.Ray(p, dir), len + REST, true, undefined, WORLD_ONLY_QUERY);
      if (hit) {
        p.addScaledVector(dir, Math.max(0, hit.timeOfImpact - REST));
        if (hit.normal.y > 0.5) v.resting = true;
        else v.vel.set(0, Math.min(0, v.vel.y), 0); // hit a wall: drop straight down
      } else p.add(step);
    }
    if (v.vel.y < -40) v.resting = true; // fell out of the map
    d.pos.x = p.x;
    d.pos.y = p.y;
    d.pos.z = p.z;
  }

  clear(): void {
    for (const idx of [...this.vis.keys()]) this.removeVisual(idx);
    this.field.clear();
  }
}
