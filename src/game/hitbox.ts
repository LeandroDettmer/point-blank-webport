import * as THREE from "three";
import type { Actor, HitZone } from "./types";

// Analytic hitboxes (not Rapier colliders) so hitscan zones never disturb the KCC capsules.
// Heights are metres above the feet; crouch squashes everything down.
export interface ZoneShape {
  zone: HitZone;
  a: number; // segment bottom height
  b: number; // segment top height (== a for a sphere)
  r: number;
  forward?: number; // offset along facing (head sits slightly forward)
}

export const HITBOX_STAND: ZoneShape[] = [
  { zone: "head", a: 1.63, b: 1.63, r: 0.15, forward: 0.03 },
  { zone: "torso", a: 0.98, b: 1.42, r: 0.24 },
  { zone: "limb", a: 0.1, b: 0.9, r: 0.19 },
];
export const HITBOX_CROUCH: ZoneShape[] = [
  { zone: "head", a: 1.08, b: 1.08, r: 0.15, forward: 0.08 },
  { zone: "torso", a: 0.62, b: 0.9, r: 0.25 },
  { zone: "limb", a: 0.1, b: 0.5, r: 0.22 },
];

const _feet = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();

export interface ZoneHit {
  zone: HitZone;
  distance: number;
}

/** Closest zone hit along the ray within maxDist, or null. `dir` must be normalized. */
export function rayVsActor(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  maxDist: number,
  actor: Actor
): ZoneHit | null {
  actor.feet(_feet);
  const yaw = actor.yaw();
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  let best: ZoneHit | null = null;
  for (const s of actor.isCrouching() ? HITBOX_CROUCH : HITBOX_STAND) {
    const off = s.forward ?? 0;
    _p.set(_feet.x + fx * off, _feet.y + s.a, _feet.z + fz * off);
    _q.set(_p.x, _feet.y + s.b, _p.z);
    const t = s.a === s.b ? raySphere(origin, dir, _p, s.r) : rayCapsule(origin, dir, _p, _q, s.r);
    if (t !== null && t <= maxDist && (!best || t < best.distance)) {
      best = { zone: s.zone, distance: t };
    }
  }
  return best;
}

/** Aim point for bots (chest height). */
export function chestPoint(actor: Actor, out: THREE.Vector3): THREE.Vector3 {
  actor.feet(out);
  out.y += actor.isCrouching() ? 0.78 : 1.25;
  return out;
}

export function headPoint(actor: Actor, out: THREE.Vector3): THREE.Vector3 {
  actor.feet(out);
  out.y += actor.isCrouching() ? 1.08 : 1.63;
  return out;
}

/** The bones an explosion tests (src/weapons/explosion.ts): Head (7, 0x5428f0), IK (2, 0x559d10), Root (B_Root shape). */
export interface BlastPoints {
  head: THREE.Vector3;
  ik: THREE.Vector3;
  root: THREE.Vector3;
}

/** stand heights of those bones in the bind pose of the 2017 skeleton (chars/<name>/model.glb: Root 0.99, IK 1.125, Head 1.597) */
const BLAST_STAND = { root: 0.99, ik: 1.125, head: 1.597 };

/**
 * World positions of the blast bones: the actor's own skeleton when it has a model (bots, remote players), else the bind
 * pose heights over the feet (the local player has no 3PV body); crouching scales them by the crouch head height
 * (headPoint 1.08 / 1.63) [INFERIDO].
 */
export function blastPoints(actor: Actor): BlastPoints {
  const root = actor.visualRoot;
  const bone = (name: string) => root?.getObjectByName(name);
  const h = bone("Head"), k = bone("IK"), r = bone("Root");
  if (h && k && r) return { head: h.getWorldPosition(new THREE.Vector3()), ik: k.getWorldPosition(new THREE.Vector3()), root: r.getWorldPosition(new THREE.Vector3()) };
  const f = actor.feet(new THREE.Vector3());
  const s = actor.isCrouching() ? 1.08 / 1.63 : 1;
  return {
    head: f.clone().setY(f.y + BLAST_STAND.head * s),
    ik: f.clone().setY(f.y + BLAST_STAND.ik * s),
    root: f.clone().setY(f.y + BLAST_STAND.root * s),
  };
}

const _oc = new THREE.Vector3();
function raySphere(o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, r: number): number | null {
  _oc.subVectors(o, c);
  const b = _oc.dot(d);
  const cc = _oc.lengthSq() - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  if (t0 >= 0) return t0;
  const t1 = -b + s;
  return t1 >= 0 ? 0 : null;
}

// Vertical capsule (a below b, same x/z): infinite cylinder test clipped to [a.y, b.y], then caps.
function rayCapsule(o: THREE.Vector3, d: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number): number | null {
  let best: number | null = null;
  const ox = o.x - a.x;
  const oz = o.z - a.z;
  const A = d.x * d.x + d.z * d.z;
  if (A > 1e-8) {
    const B = ox * d.x + oz * d.z;
    const C = ox * ox + oz * oz - r * r;
    const disc = B * B - A * C;
    if (disc >= 0) {
      const t = (-B - Math.sqrt(disc)) / A;
      if (t >= 0) {
        const y = o.y + d.y * t;
        if (y >= a.y && y <= b.y) best = t;
      }
    }
  }
  const ta = raySphere(o, d, a, r);
  if (ta !== null && (best === null || ta < best)) best = ta;
  const tb = raySphere(o, d, b, r);
  if (tb !== null && (best === null || tb < best)) best = tb;
  return best;
}
