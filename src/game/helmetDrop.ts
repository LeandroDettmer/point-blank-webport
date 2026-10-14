import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { loadHelmetModel, type HeadEquip } from "./charEquip";
import { applyPbCharaLighting, createPbMtl, disposePbMtl, type PbMtl } from "../render/pbLighting";
import { WORLD_ONLY_QUERY } from "./types";

/*
 * HELMET PROTECTION pop-off: the helmet the victim wears (its own equip GLB, public/assets/equip/<helmet>/<family>.glb,
 * charEquip.ts helmetFile) leaves HelmetPointDummy and falls to the floor, seen by everyone who sees the hit.
 * The exe hands the helmet to a PhysX body (not decoded here); [RECRIADO]: it starts at the helmet's world transform,
 * is knocked along the shot with a tumble, falls under gravity and bounces on the level collision (ray per step, like
 * drops.ts), then lies there until LIFE runs out.
 */

const GRAVITY = 9.8;
const KNOCK = 1.4; // m/s along the shot [RECRIADO]
const POP_UP = 2.0; // m/s up [RECRIADO]
const SPIN = 9; // rad/s tumble [RECRIADO]
const BOUNCE = 0.35; // restitution on the floor [RECRIADO]
const FRICTION = 0.6; // horizontal speed kept per bounce
const REST = 0.08; // helmet half-height above the floor
const LIFE = 10; // s on the floor before it is gone [RECRIADO]

interface Falling {
  root: THREE.Group;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  resting: boolean;
  t: number;
  bounces: number;
  mtl: PbMtl;
}

export interface HelmetSource {
  charaName: string;
  equip: HeadEquip | undefined;
  /** the helmet's world matrix on the head */
  matrix: THREE.Matrix4;
}

export class HelmetDrops {
  private live = new Set<Falling>();
  private _p = new THREE.Vector3();
  private _d = new THREE.Vector3();
  private _q = new THREE.Quaternion();

  constructor(private scene: THREE.Scene, private world: RAPIER.World, private R: typeof RAPIER) {}

  /** Pops the helmet off `src` (its world transform), knocked along `shotDir` (attacker -> victim; null = straight up). */
  spawn(src: HelmetSource, shotDir: THREE.Vector3 | null): void {
    const root = new THREE.Group();
    src.matrix.decompose(root.position, root.quaternion, root.scale);
    const dir = shotDir ? this._d.set(shotDir.x, 0, shotDir.z).normalize() : this._d.set(0, 0, 0);
    const f: Falling = {
      root,
      vel: new THREE.Vector3(dir.x * KNOCK, POP_UP, dir.z * KNOCK),
      spin: new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(SPIN).add(new THREE.Vector3(0, (Math.random() - 0.5) * SPIN, 0)),
      resting: false,
      t: 0,
      bounces: 0,
      mtl: createPbMtl(),
    };
    this.scene.add(root);
    this.live.add(f);
    void loadHelmetModel(src.charaName, src.equip).then((m) => {
      if (!m || !this.live.has(f)) return;
      applyPbCharaLighting(m, f.mtl);
      root.add(m);
    });
  }

  /** (pos, surfaceCode) on each floor bounce loud enough (game.ts plays OB_Helmet_Bound_<terrain>) */
  onBounce: ((pos: THREE.Vector3, handle: number) => void) | null = null;

  update(dt: number): void {
    for (const f of this.live) {
      f.t += dt;
      if (!f.resting) this.fall(f, dt);
      f.mtl.update(f.root.position, dt);
      if (f.t >= LIFE) this.remove(f);
    }
  }

  private fall(f: Falling, dt: number): void {
    f.vel.y -= GRAVITY * dt;
    const p = f.root.position;
    const step = this._p.copy(f.vel).multiplyScalar(dt);
    const len = step.length();
    if (len > 1e-6) {
      const dir = step.divideScalar(len);
      const hit = this.world.castRayAndGetNormal(new this.R.Ray(p, dir), len + REST, true, undefined, WORLD_ONLY_QUERY);
      if (hit) {
        p.addScaledVector(dir, Math.max(0, hit.timeOfImpact - REST));
        const n = hit.normal;
        // reflect off the surface, lose energy
        const vn = f.vel.x * n.x + f.vel.y * n.y + f.vel.z * n.z;
        f.vel.set(f.vel.x - (1 + BOUNCE) * vn * n.x, f.vel.y - (1 + BOUNCE) * vn * n.y, f.vel.z - (1 + BOUNCE) * vn * n.z);
        if (n.y > 0.5) {
          if (Math.abs(vn) > 1.2 && f.root.children.length > 0 && f.bounces++ < 2) this.onBounce?.(p, hit.collider.handle);
          f.vel.x *= FRICTION;
          f.vel.z *= FRICTION;
          f.spin.multiplyScalar(0.5);
          if (Math.abs(f.vel.y) < 0.6) f.resting = true;
        }
      } else p.addScaledVector(dir, len);
    }
    const w = f.spin.length();
    if (!f.resting && w > 1e-4) f.root.quaternion.premultiply(this._q.setFromAxisAngle(this._d.copy(f.spin).divideScalar(w), w * dt));
    if (f.vel.y < -40) f.resting = true; // fell out of the map
  }

  private remove(f: Falling): void {
    f.root.removeFromParent();
    disposePbMtl(f.mtl);
    this.live.delete(f);
  }

  clear(): void {
    for (const f of [...this.live]) this.remove(f);
  }

  /** debug / smoke: positions of the helmets in the scene */
  debugState(): { pos: [number, number, number]; resting: boolean; t: number; loaded: boolean }[] {
    return [...this.live].map((f) => ({ pos: [f.root.position.x, f.root.position.y, f.root.position.z], resting: f.resting, t: f.t, loaded: f.root.children.length > 0 }));
  }
}
