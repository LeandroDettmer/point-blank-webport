import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import type { WeaponDef } from "./types";
import { createWeaponModel } from "./worldModel";
import { terrainOfCollider } from "./effects";
import { soundTerrainOf } from "./terrainSound";
import { CLAYMORE_BACK_OFFSET, throwKind } from "./throwables";

/** position handle kept for callers that relocate a grenade (net explode record) */
export interface GrenadeBody {
  translation(): { x: number; y: number; z: number };
  setTranslation(p: { x: number; y: number; z: number }, wake?: boolean): void;
}

export interface LiveGrenade {
  weapon: WeaponDef;
  body: GrenadeBody;
  /** visual: the thrown weapon's own model (models/<grenade>.glb, e.g. K-400 -> k_400.glb) once loaded, a sphere until then */
  mesh: THREE.Object3D;
  /** seconds left on the fuse; it only runs while the grenade is armed (speed < 0.2, see GRENADE) */
  fuse: number;
  /** thrown by the local player (explosion damage reported) or replicated (visual only) */
  local: boolean;
  /** actor id of the thrower of a replicated throw (game.ts remoteThrow); undefined for the local player's own */
  owner?: string;
  /** C5 (AttachableItem): freezes on its first contact */
  sticky: boolean;
  /** WeaponMedicalKit: lands (stops dead) on a hit instead of bouncing, see kitLands */
  kit: boolean;
  stuck: boolean;
  /** current segment (WeaponGrenade::Throw 0x62ed14): start, unit direction, scalar speed (+0xa584), time on it (+0xa544) */
  p0: THREE.Vector3;
  dir: THREE.Vector3;
  speed: number;
  t: number;
  /** settled (_ProcessTakeObject 0x62ef00): no more motion */
  resting: boolean;
}

/**
 * WeaponGrenade flight, exe-2017 (custom analytic integration, not PhysX):
 *  - launch (0x631330 -> slot 0x200 0x630bf0): start = the camera position (getVirtualCamPosition 0x815cd0, no offset),
 *    direction = camera forward (target 0x6092c0 = cam - At * Range), speed = Throw_Speed (0x631410; player velocity
 *    not inherited).
 *  - per frame (0x62f860 -> 0x62fc60): dt > 0.5 -> 0.016; P(t) = P0 + D*s*t + (0, -5 t^2, 0) (g = 10, 0xb79e38); the
 *    model spins about its local X at 360 deg/s; a ray prev -> new against the world (and characters but the thrower).
 *  - bounce: chord c = unit(H - prev), r = unit(reflect(c, n)), d = dot(r, D); floor (n.y > 0.5)
 *    s' = s * (0.1 (d + 1) + 0.165), wall s' = s * (0.11 (d + 1) + 0.165); P0 = H - 0.05 c + 0.05 n, D = r, t = 0.
 *    WM_Throw_Bound_<terrain> only when s' > 0.5 (0x6312b6, _PlayBoundSound 0x630cb0).
 *  - s < 0.15: settles, dropped 0.05 onto the surface below (0x62ef00).
 *  - fuse: +0xa540 += dt only while s < 0.2 (flag 2, 0x630889 / 0x6308ce), explode past Explosion_Time; t > 15 s on
 *    one segment also explodes (0xb73560).
 */
export const GRENADE = {
  gravity: 10,
  floorK: 0.1,
  wallK: 0.11,
  bounceBase: 0.165,
  backOff: 0.05,
  stopSpeed: 0.15,
  armSpeed: 0.2,
  boundSoundSpeed: 0.5,
  maxSegment: 15,
  spinDegPerSec: 360,
} as const;

/**
 * WeaponMedicalKit collision (0x669540, own vf 0x2d4 instead of the grenade's 0x62fc60): the kit lands where it hits (speed 0, no
 * roll, 0x669f81) when the surface test passes: for the terrain types 13 / 19 / 20 / 3 / 29 (STEEL_THIN, RUBBER, CLOTH, GROUND,
 * 0x669d2c..0x669d57) dot(normal, up) must be > 0.1 (0x669d7e), every other terrain counts as 1.0 (0x669d0a) so it lands on walls too.
 * A failed test bounces it like a grenade (wall branch 0x66a014, same 0.11 / 0.165 formula). The exe also bounces when the path
 * flown (+0xa5e4) reaches the weapon info's vf 0xa8 value (core +0x44, field not named) [INFERIDO: not ported].
 */
const KIT_TERRAIN_NORMAL = new Set([13, 19, 20, 3, 29]);
export const KIT_LAND_MIN_UP = 0.1;
/** landed kit rests this far off the surface along its normal (0x669dde: hit + n * 0.03) */
export const KIT_LAND_LIFT = 0.03;
export function kitLands(terrainType: number | undefined, normalY: number): boolean {
  return (terrainType !== undefined && KIT_TERRAIN_NORMAL.has(terrainType) ? normalY : 1) > KIT_LAND_MIN_UP;
}

/** the thrown object is (nearly) still: speed < 0.2, bomb-state flag 2 (grenade 0x630889 / Cross 0x62a2bc, C5 Cross
 *  0x63f9ce); a C5 stuck to a wall has speed 0. The grenade fuse only runs while this holds. */
export const grenadeArmed = (g: Pick<LiveGrenade, "resting" | "stuck" | "speed">): boolean =>
  g.resting || g.stuck || g.speed < GRENADE.armSpeed;

/** position on a segment (pure) */
export function grenadeSegmentPos(p0: THREE.Vector3, dir: THREE.Vector3, speed: number, t: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(p0).addScaledVector(dir, speed * t).setY(p0.y + dir.y * speed * t - 0.5 * GRENADE.gravity * t * t);
}

/** bounce response of 0x62fc60 (pure): new segment start / direction / speed */
export function grenadeBounce(prev: THREE.Vector3, hit: THREE.Vector3, n: THREE.Vector3, dir: THREE.Vector3, speed: number):
  { p0: THREE.Vector3; dir: THREE.Vector3; speed: number; floor: boolean } {
  const c = hit.clone().sub(prev);
  if (c.lengthSq() < 1e-12) c.copy(dir);
  c.normalize();
  const r = c.clone().addScaledVector(n, -2 * c.dot(n)).normalize();
  const d = r.dot(dir);
  const floor = n.y > 0.5;
  const s = speed * ((floor ? GRENADE.floorK : GRENADE.wallK) * (d + 1) + GRENADE.bounceBase);
  const p0 = hit.clone().addScaledVector(c, -GRENADE.backOff).addScaledVector(n, GRENADE.backOff);
  return { p0, dir: r, speed: s, floor };
}

export interface GrenadeRayFilter {
  groups?: number;
  exclude?: RAPIER.Collider;
  pred?: (c: RAPIER.Collider) => boolean;
}

/**
 * Live grenades: the exe's segment integration above, collision by Rapier rays against the level. The world is
 * stepped by main.ts; this only moves meshes and fires onExplode when the (armed) fuse ends.
 */
/** half the C5 brick thickness (models/c5_bomb.glb bounds Y +-0.0356): it sits with its back face on the surface */
const C5_HALF_THICK = 0.0356;

export class GrenadePhysics {
  private list: LiveGrenade[] = [];
  /** set by WeaponSystem: the thrower's collider is not hit (0x62fc60 skips the owner and dead charas) */
  rayFilter: (g: LiveGrenade) => GrenadeRayFilter = () => ({});

  constructor(
    private scene: THREE.Scene,
    private world: RAPIER.World,
    private R: typeof RAPIER,
    private onExplode: (g: LiveGrenade, pos: THREE.Vector3) => void,
    private onBounce: (g: LiveGrenade, pos: THREE.Vector3, terrain: number) => void,
    /** a medical kit came to rest on a surface (landing branch of 0x669540): effect + sound go here */
    private onLand?: (g: LiveGrenade, pos: THREE.Vector3) => void
  ) {}

  spawn(weapon: WeaponDef, origin: THREE.Vector3, velocity: THREE.Vector3, fuse: number, local: boolean,
    _groups?: number, sticky = false, kit = false): LiveGrenade {
    const mesh = new THREE.Group();
    mesh.position.copy(origin);
    this.scene.add(mesh);
    // original grenade model (i3 space under its AxisRotate matrix, pivot = GunDummy)
    void createWeaponModel(weapon.id, "GRENADE", { grenade: true, projectile: true }).then((inst) => {
      if (!inst || !mesh.parent) return;
      const ax = new THREE.Group();
      ax.matrixAutoUpdate = false;
      ax.matrix.copy(inst.axis);
      ax.add(inst.object);
      mesh.add(ax);
    });
    const speed = velocity.length();
    const dir = speed > 1e-6 ? velocity.clone().divideScalar(speed) : new THREE.Vector3(0, -1, 0);
    const g: LiveGrenade = {
      weapon, mesh, fuse, local, sticky, kit, stuck: false, p0: origin.clone(), dir, speed, t: 0, resting: speed < GRENADE.stopSpeed,
      body: {
        translation: () => ({ x: mesh.position.x, y: mesh.position.y, z: mesh.position.z }),
        setTranslation: (p) => {
          mesh.position.set(p.x, p.y, p.z);
          g.p0.copy(mesh.position);
          g.t = 0;
        },
      },
    };
    this.list.push(g);
    return g;
  }

  private cast(g: LiveGrenade, from: THREE.Vector3, to: THREE.Vector3) {
    const d = to.clone().sub(from);
    const len = d.length();
    if (len < 1e-6) return null;
    d.divideScalar(len);
    const f = this.rayFilter(g);
    const ray = new this.R.Ray({ x: from.x, y: from.y, z: from.z }, { x: d.x, y: d.y, z: d.z });
    const hit = this.world.castRayAndGetNormal(ray, len, true, undefined, f.groups, f.exclude, undefined, f.pred);
    if (!hit) return null;
    return { point: from.clone().addScaledVector(d, hit.timeOfImpact), n: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      collider: hit.collider };
  }

  /**
   * C5 brick flat on the surface: its firing-device face (+Y of the exported model, pb-extract-tools export-c5-bomb.mjs) points out
   * along the normal, the long side (Z) runs along the wall / the throw direction on a floor. The pef also carries
   * AttachedWall_RotateX/Y 6/4 and AttachedFloor_RotateX/Y 4/0 [INFERIDO: extra tilt in degrees, not applied].
   */
  private plant(g: LiveGrenade, n: THREE.Vector3): void {
    const up = new THREE.Vector3(0, 1, 0);
    const z = Math.abs(n.y) > 0.7 ? g.dir.clone().addScaledVector(n, -g.dir.dot(n)) : up.clone().cross(n);
    if (z.lengthSq() < 1e-6) z.set(1, 0, 0).addScaledVector(n, -n.x);
    z.normalize();
    const x = new THREE.Vector3().crossVectors(n, z);
    g.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, n.clone(), z));
  }

  /** 0x62ef00: drop onto the surface below (0.05 m search) and stop */
  private settle(g: LiveGrenade): void {
    g.resting = true;
    g.speed = 0;
    const p = g.mesh.position;
    const below = this.cast(g, p, p.clone().add(new THREE.Vector3(0, -(GRENADE.backOff + 0.1), 0)));
    if (below && below.n.y > 0.5) p.y = below.point.y + 0.045;
    g.p0.copy(p);
  }

  private step(g: LiveGrenade, dt: number): void {
    if (g.resting || g.stuck) return;
    const prev = g.mesh.position.clone();
    g.t += dt;
    const next = grenadeSegmentPos(g.p0, g.dir, g.speed, g.t);
    const hit = this.cast(g, prev, next);
    if (!hit) {
      g.mesh.position.copy(next);
      g.mesh.rotateX(-dt * GRENADE.spinDegPerSec * (Math.PI / 180));
      return;
    }
    const terrain = soundTerrainOf(hit.collider.handle);
    if (g.sticky) {
      // C5 (WeaponC5::_BoundObject 0x643c90): attaches where it hits (AttachedWall/Floor_Rotate* orientation not modelled).
      // Claymore (AttachableItem too) sits on the surface by its back face instead of the brick's half thickness
      g.stuck = true;
      g.speed = 0;
      const lift = throwKind(g.weapon) === "mine" ? CLAYMORE_BACK_OFFSET : C5_HALF_THICK;
      g.mesh.position.copy(hit.point).addScaledVector(hit.n, lift);
      g.p0.copy(g.mesh.position);
      this.plant(g, hit.n);
      this.onBounce(g, g.mesh.position, terrain);
      return;
    }
    if (g.kit && kitLands(terrainOfCollider(hit.collider.handle)?.type, hit.n.y)) {
      g.stuck = true;
      g.speed = 0;
      g.mesh.position.copy(hit.point).addScaledVector(hit.n, KIT_LAND_LIFT);
      g.p0.copy(g.mesh.position);
      g.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), hit.n); // lies along the surface normal (0x669e3c..) [INFERIDO: axes]
      this.onLand?.(g, g.mesh.position);
      return;
    }
    const b = grenadeBounce(prev, hit.point, hit.n, g.dir, g.speed);
    g.p0.copy(b.p0);
    g.dir.copy(b.dir);
    g.speed = b.speed;
    g.t = 0;
    g.mesh.position.copy(b.p0);
    if (b.speed > GRENADE.boundSoundSpeed) this.onBounce(g, g.mesh.position, terrain);
    if (b.speed < GRENADE.stopSpeed) this.settle(g);
  }

  update(dt: number): void {
    const fdt = dt > 0.5 ? 0.016 : dt;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const g = this.list[i];
      this.step(g, fdt);
      if (grenadeArmed(g)) g.fuse -= fdt;
      const lost = !g.resting && !g.stuck && g.t > GRENADE.maxSegment;
      if (g.fuse <= 0 || lost) {
        const pos = g.mesh.position.clone();
        this.remove(i);
        this.onExplode(g, pos);
      }
    }
  }

  private remove(i: number) {
    const g = this.list[i];
    this.scene.remove(g.mesh);
    this.list.splice(i, 1);
  }

  /** grenades have no collider (the exe moves them by rays): nothing to exclude from other rays */
  isGrenade(_c: RAPIER.Collider): boolean {
    return false;
  }

  /** live grenades (tests / HUD) */
  get live(): readonly LiveGrenade[] {
    return this.list;
  }

  clear(): void {
    while (this.list.length) this.remove(this.list.length - 1);
  }
}
