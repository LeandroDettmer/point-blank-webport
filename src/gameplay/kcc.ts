import type RAPIER from "@dimforge/rapier3d-compat";

// Rapier KinematicCharacterController setup + wall slide shared by src/player.ts and the headless stair test
// (scripts/dev/test-stairs.mjs). No runtime imports, so Node can load it with native type stripping.

export interface KccShape {
  maxStepHeight: number;
  maxSlopeClimbDeg: number;
}

/**
 * Ground push of a grounded frame, per 1/60 s (callers scale it by dt*60). The exe moves the PhysX controller by -0.1 per
 * frame (pbMove.ts PB_GROUND_PUSH), but PhysX splits every move into up (step offset) / side / down passes, so that
 * push never blocks a step. Rapier sweeps the whole vector at once: 0.1 m down per frame against ~0.11 m forward made
 * the autostep fail on every riser and the capsule crawl over the nosing instead (6.5 -> 0.3 m/s for ~8 frames per
 * step: the "stumble" on stairs). A small push keeps the down contact (plus snap-to-ground and player.ts's step-height
 * re-query, the "down pass") without eating the side move. Measured with scripts/dev/test-stairs.mjs and a synthetic stair
 * / box harness at 30-240 Hz. [INFERIDO: value tuned for Rapier, the exe's own is -0.1]
 */
export const KCC_GROUND_PUSH = -0.01;

/** PLACEHOLDER values except maxStepHeight / maxSlopeClimbDeg (see PB_CAPSULE in pbConfig.ts). */
export function configurePbKcc(c: RAPIER.KinematicCharacterController, s: KccShape): void {
  c.setMaxSlopeClimbAngle((s.maxSlopeClimbDeg * Math.PI) / 180);
  c.setMinSlopeSlideAngle((60 * Math.PI) / 180);
  c.enableAutostep(s.maxStepHeight, 0.3, true);
  c.enableSnapToGround(0.3);
  c.setApplyImpulsesToDynamicBodies(true);
}

/**
 * After computeColliderMovement: remove the into-wall component of the horizontal velocity, only for near-vertical
 * contacts above step height, so the player slides along walls without storing speed into them. Stair edges
 * (risers <= maxStepHeight, which the capsule rides or autosteps over) are skipped: they shorten the horizontal move
 * for a few frames, and the old "v = corrected / dt" rule collapsed the speed to 0 there at high frame rates (small
 * per-frame accel), stalling the player on the first step.
 */
export function slideOffWalls(
  c: RAPIER.KinematicCharacterController, v: { x: number; z: number }, feetY: number, maxStepHeight: number
): void {
  for (let i = 0, n = c.numComputedCollisions(); i < n; i++) {
    const hit = c.computedCollision(i);
    if (!hit || Math.abs(hit.normal1.y) > 0.3 || hit.witness1.y - feetY <= maxStepHeight) continue;
    const nl = Math.hypot(hit.normal1.x, hit.normal1.z);
    if (nl < 1e-6) continue;
    const nx = hit.normal1.x / nl, nz = hit.normal1.z / nl;
    const into = v.x * nx + v.z * nz;
    if (into < 0) { v.x -= into * nx; v.z -= into * nz; }
  }
}

/**
 * computedGrounded() misses frames where the move did end on the floor (a collision whose normal points up is in the
 * list, yet the flag is false: seen on flat trimesh floors, one frame in a few dozen). Every such false "air" frame
 * froze the accel, and the next "landing" reset the JumpDelay timer. A walkable contact of this move counts as ground.
 */
export function touchedGround(c: RAPIER.KinematicCharacterController, maxSlopeClimbDeg: number): boolean {
  const minY = Math.cos((maxSlopeClimbDeg * Math.PI) / 180) - 1e-3;
  for (let i = 0, n = c.numComputedCollisions(); i < n; i++) {
    const hit = c.computedCollision(i);
    if (hit && hit.normal1.y >= minY) return true;
  }
  return false;
}
