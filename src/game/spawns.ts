import * as THREE from "three";
import type { Team } from "./types";
import { jsonOnce } from "../jsonOnce";

export interface SpawnPoint {
  name: string;
  feet: THREE.Vector3;
  yaw: number; // radians, three.js convention
  team: Team;
}

interface RawRespawn {
  name?: string;
  pos: [number, number, number];
  yawDeg?: number;
  floorY?: number;
  team?: number | string;
}

export interface MapMeta {
  spawns: SpawnPoint[];
  bounds: { min: THREE.Vector3; max: THREE.Vector3 } | null;
}

function parseTeam(t: RawRespawn["team"]): Team | null {
  if (t === undefined || t === null) return null;
  if (typeof t === "number") return (t % 2) as Team;
  const s = String(t).toLowerCase();
  if (s.startsWith("r") || s === "0") return 0;
  if (s.startsWith("b") || s === "1") return 1;
  return null;
}

/**
 * yawDeg = the GINS quaternion's rotation about +Y (export-collision.mjs quatYawDeg), a rigid rotation of the i3
 * character, whose front is its local +Z: front = (sin θ, cos θ). three.js front = (-sin yaw, -cos yaw), so yaw = θ + π.
 * The old `yaw = -θ` mirrored Z instead: equal for spawns facing ±X (Metro, where it was checked: θ = -90° faces -X)
 * but 180° off for every spawn facing ±Z (players spawned with their backs to the map, issue #9).
 * Respawn_*_generated points (export-collision.mjs generateFallbackSpawns) were solved for that old -θ formula.
 */
function spawnYaw(r: RawRespawn): number {
  const deg = r.yawDeg ?? 0;
  if (/_generated$/.test(r.name ?? "")) return THREE.MathUtils.degToRad(-deg);
  return THREE.MathUtils.degToRad(deg) + Math.PI;
}

/**
 * collision.json respawns carry no team field (Metro: 16 points in two clusters at x≈+55 / x≈-55),
 * so teams are split by 2-means clustering; alternating would mix both sides.
 */
export function assignTeams(raw: RawRespawn[]): SpawnPoint[] {
  const pts = raw.map((r) => ({
    name: r.name ?? "",
    feet: new THREE.Vector3(r.pos[0], r.floorY ?? r.pos[1], r.pos[2]),
    yaw: spawnYaw(r),
    team: parseTeam(r.team),
  }));
  if (pts.length && pts.every((p) => p.team !== null)) return pts as SpawnPoint[];

  if (pts.length >= 2) {
    // Seed with the farthest pair, then a few Lloyd iterations.
    let a = pts[0].feet.clone();
    let b = pts.reduce((best, p) => (p.feet.distanceToSquared(a) > best.distanceToSquared(a) ? p.feet : best), a).clone();
    a = pts.reduce((best, p) => (p.feet.distanceToSquared(b) > best.distanceToSquared(b) ? p.feet : best), b).clone();
    for (let it = 0; it < 5; it++) {
      const ca = new THREE.Vector3(), cb = new THREE.Vector3();
      let na = 0, nb = 0;
      for (const p of pts) {
        if (p.feet.distanceToSquared(a) <= p.feet.distanceToSquared(b)) { ca.add(p.feet); na++; p.team = 0; }
        else { cb.add(p.feet); nb++; p.team = 1; }
      }
      if (!na || !nb) break;
      a = ca.divideScalar(na);
      b = cb.divideScalar(nb);
    }
    const reds = pts.filter((p) => p.team === 0).length;
    if (reds > 0 && reds < pts.length) return pts as SpawnPoint[];
  }
  pts.forEach((p, i) => (p.team = (i % 2) as Team));
  return pts as SpawnPoint[];
}

export async function loadMapMeta(collisionJsonUrl: string, fallbackSpawn: THREE.Vector3): Promise<MapMeta> {
  let spawns: SpawnPoint[] = [];
  let bounds: MapMeta["bounds"] = null;
  try {
    const json = await jsonOnce<{ respawns?: RawRespawn[]; bounds?: { min?: [number, number, number]; max?: [number, number, number] } }>(collisionJsonUrl).catch(() => null);
    if (json) {
      if (Array.isArray(json.respawns) && json.respawns.length) spawns = assignTeams(json.respawns);
      if (json.bounds?.min && json.bounds?.max) {
        bounds = { min: new THREE.Vector3(...json.bounds.min), max: new THREE.Vector3(...json.bounds.max) };
      }
    }
  } catch (err) {
    console.warn("[spawns] collision.json unavailable", err);
  }
  if (!spawns.length) {
    // Test level: two small groups either side of the fallback spawn.
    const base = fallbackSpawn.clone();
    for (let i = 0; i < 8; i++) {
      const team = (i < 4 ? 0 : 1) as Team;
      const side = team === 0 ? -1 : 1;
      spawns.push({
        name: `Fallback${i}`,
        feet: new THREE.Vector3(base.x + side * 8, base.y - 1, base.z + (i % 4) * 2 - 3),
        yaw: team === 0 ? -Math.PI / 2 : Math.PI / 2,
        team,
      });
    }
  }
  return { spawns, bounds };
}
