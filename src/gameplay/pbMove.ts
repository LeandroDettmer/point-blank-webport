// Point Blank ground / air movement and jump, disassembled from the 2017 PointBlank.exe (VAs inline, 
//). Pure math, no three / rapier, so tools and Node smokes can run it (src/game/dev/pbMove.smoke.node.ts).
// type-only import: scripts/dev/test-stairs.mjs loads this file directly with Node type stripping (no extensionless value imports)
import type { PbCharacter } from "./pbConfig";

const HALF_PI = Math.PI / 2;
const EPS = 2e-5; // I3_EPS (0xb399c0)
/** The exe integrates per frame; per-frame terms are normalised to 60 fps like the horizontal recoil recovery. */
const REF_FPS = 60;

/** Horizontal move state (CGameCharaMoveContext +0x164 displacement, +0x178 accel timer). */
export interface PbAccelState {
  vx: number;
  vz: number;
  /** accel timer in [0, AccelerationTime] (+0x178) */
  t: number;
}

export function newAccelState(): PbAccelState {
  return { vx: 0, vz: 0, t: 0 };
}

/**
 * One frame of the velocity integrator that follows ProcessAccel (unnamed, 0x7eee20-0x7ef44a; AccelerationTime getter
 * 0x7fbbc0 = max(0.001, AccelerationTime + equip)):
 *   input d (unit), current v:  dot = v^ . d
 *     on the ground: moving ? t += (dot - AccelRateBackVsFront)*dt, and t -= dt more when dot < 0 : t += dt
 *     t = clamp(t, 0, T);  dir = normalize(v*dt + d*dt)   (the new input only bends the old direction)
 *     speed = sin(pi/2 * t/T) * maxSpeed * (hit slowdown rate while its timer runs, +0x184/+0x188)
 *   no input, on the ground: t -= dt; t > 0 ? v *= sin(pi/2 * t/T), |v| <= maxSpeed : v = 0, t = 0
 *   in the air (move state 3): t is frozen and, with no input, v is kept (momentum); ProcessAccel 0x7f3785 also stops
 *   refreshing maxSpeed (+0x180), so the caller passes the take-off speed.
 * Frame-rate: the exe blends the direction and multiplies the release decay once per frame; both are applied here
 * with a weight of dt*60 so 60 fps matches the exe exactly and other rates keep its timing.
 * Not modelled: the reverse-direction cap min(prevMaxSpeed +0x17c, maxSpeed) and the dino double release rate.
 */
export function pbAccelStep(
  s: PbAccelState, inX: number, inZ: number, maxSpeed: number, dt: number, airborne: boolean,
  c: PbCharacter, speedMul = 1,
): void {
  const T = Math.max(0.001, c.accelerationTime);
  const L = Math.hypot(s.vx, s.vz);
  const il = Math.hypot(inX, inZ);
  const k = dt * REF_FPS;
  if (il > EPS) {
    const dx = inX / il, dz = inZ / il;
    const dot = L > EPS ? (s.vx * dx + s.vz * dz) / L : 0;
    if (!airborne) {
      if (L > EPS) {
        s.t += (dot - c.accelRateBackVsFront) * dt;
        if (dot < 0) s.t -= dt;
      } else s.t += dt;
    }
    s.t = Math.min(T, Math.max(0, s.t));
    let ox = s.vx + dx * k, oz = s.vz + dz * k;
    const ol = Math.hypot(ox, oz);
    if (ol > EPS) { ox /= ol; oz /= ol; } else { ox = dx; oz = dz; }
    const speed = Math.sin(HALF_PI * (s.t / T)) * maxSpeed * speedMul;
    s.vx = ox * speed;
    s.vz = oz * speed;
  } else if (!airborne) {
    s.t -= dt;
    if (s.t > 0) {
      const f = Math.pow(Math.sin(HALF_PI * (s.t / T)), k);
      s.vx *= f;
      s.vz *= f;
      const l = Math.hypot(s.vx, s.vz);
      if (l > maxSpeed && l > EPS) { s.vx *= maxSpeed / l; s.vz *= maxSpeed / l; }
    } else {
      s.vx = s.vz = 0;
      s.t = 0;
    }
  }
}

/**
 * CGameCharaActionControl::OnActionJumpStart 0xa0a670. r = time since landing (chara+0x578, zeroed by the landing
 * handler 0xa1b2e5, += dt 0xa07990) / JumpPenaltyTime; f scales both the height and the time:
 *   r < 0.3: 1 - 3*Rate    0.3 <= r < 0.6: 1 - 2*Rate    r > 1: 1 - Rate    0.6 <= r <= 1: 1     (each clamped [0.1, 1])
 * The last two tiers are what the compiled comparisons do (0xa0a960: skip when r <= 1), so a jump after a long rest is
 * 0.85x and the full jump is the one 0.3-0.5 s after a landing.
 */
export function pbJumpFactor(sinceLanding: number, c: PbCharacter): number {
  const r = sinceLanding / Math.max(EPS, c.jumpPenaltyTime), R = c.jumpPenaltyRate;
  const cl = (x: number) => Math.min(1, Math.max(0.1, x));
  if (r < 0.3) return cl(1 - 3 * R);
  if (r < 0.6) return cl(1 - 2 * R);
  if (r > 1) return cl(1 - R);
  return 1;
}

/** OnActionJumpStart 0xa0a746-0xa0a769: no jump while JumpDelay (CCharaInfo +0x16d8) > time since landing. */
export function pbCanJump(sinceLanding: number, c: PbCharacter): boolean {
  return !(c.jumpDelay > sinceLanding);
}

export interface PbJump {
  /** MoveContext +0x1a0: apex height above the take-off point */
  height: number;
  /** MoveContext +0x1a4: rise time (JumpTime * f / 2) */
  halfTime: number;
  crouchJump: boolean;
}

/**
 * Jump start. Crouch jump (ClunchJumpHeight, CCharaInfo +0x1570) when crouched (posture +0x3c == 1, 0x72ea00) or when
 * the player stood up less than ClunchJumpCheckTime (+0x1594) ago (stand-up 0xa0a250 stores the game time at
 * ActionControl+0x2c; a crouch jump clears it). Equip jump bonus (chara+0xcbc) = 0.
 */
export function pbJumpStart(sinceLanding: number, crouched: boolean, sinceStandUp: number, c: PbCharacter): PbJump {
  const f = pbJumpFactor(sinceLanding, c);
  const crouchJump = crouched || sinceStandUp < c.crouchJumpCheckTime;
  return { height: (crouchJump ? c.crouchJumpHeight : c.jumpHeight) * f, halfTime: c.jumpTime * f * 0.5, crouchJump };
}

/** Rise, UpdateJumping 0x7ef9ac / 0x7efac6: y(t) = y0 + H * sin(pi/2 * t / halfTime). The apex (0x7ef570) is at t = halfTime. */
export function pbJumpRiseY(j: PbJump, t: number): number {
  return j.height * Math.sin(HALF_PI * Math.min(1, t / Math.max(EPS, j.halfTime)));
}

/**
 * Fall, 0x7ef6d0: drop(t) = K * t^2 from the apex or from the last ground point, with K = MoveContext +0x1a8 =
 * JumpHeight / (JumpTime/2)^2, set once by OnReset 0x7ee29c from the unscaled pef values (the jump start never updates
 * it): 13.22 m/s^2 for AcidPol, i.e. a constant 26.4 m/s^2 fall.
 */
export function pbFallK(c: PbCharacter): number {
  const th = c.jumpTime * 0.5;
  return c.jumpHeight / (th * th);
}

/** Ground push while standing on the floor: UpdateJumping 0x7efaa6 sets the move Y to -0.1 per frame. The web player
 * uses gameplay/kcc.ts KCC_GROUND_PUSH instead: Rapier sweeps the push and the side move together (PhysX splits them),
 * and 0.1 m down per frame blocked the autostep on every stair riser. */
export const PB_GROUND_PUSH = -0.1;

/** Fall damage needs more than 0.1 s of fall (0x7ef615) besides the height rule (_CalcFallingDamage 0x7f0ec0). */
export const PB_FALL_DAMAGE_MIN_TIME = 0.1;

export type PbHitPart = "body" | "arm" | "hand" | "leg" | "foot" | "head";

/**
 * Hit slowdown, CalcHitPoint 0x542cee -> 0x78c310 -> 0x7efc80(part) -> 0x7efc50(rate, time):
 *   rate = (100 - SpeedReduction<Part>) / 100 for SpeedReduction<Part>Time s; the integrator multiplies maxSpeed by it
 *   while the timer (+0x184) is > 0. Part slots 0x7efd00: Body, Arm, Hand, Leg, Foot; the head (and weapon/other
 *   parts) have none. AcidPol has every value 0 (pef-3.123 and pef-2017), so the default soldier is never slowed.
 * The globals SpeedReductionTime / SpeedReductionMaxRate are not read by this path.
 */
export function pbHitSlow(part: PbHitPart, c: PbCharacter): { rate: number; time: number } | null {
  if (part === "head") return null;
  const e = c.speedReduction[part];
  if (!e || !(e.time > 0) || !(e.pct > 0)) return null;
  return { rate: (100 - e.pct) / 100, time: e.time };
}
