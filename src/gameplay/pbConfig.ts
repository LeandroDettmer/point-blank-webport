// Real Point Blank gameplay constants. Sources:
//   pef-cross  extracted/pef-cross/br/*.json (pb-extract-tools pef-cross.mjs, PBCross Script.i3Pack) and the Cross character
// table public/assets/cross/config/character.json. The ONLY value source (Cross or nothing, 
//: no 2017 and no 3.123 value is read. A Cross key that is missing is not invented: see the line.
//   exe-2017   formulas disassembled from the 2017 PointBlank.exe, VAs given inline.
//   PLACEHOLDER = no pef/exe source yet.
// Units: meters, seconds, m/s (PB world units are meters: Range 140 for an AR, FrontMoveSpeed 6.5, gravity -9.81).

/** MDT order used by CCharaInfo2::GetMoveSpeed (0x535e90): Front 0, Side 1, Diagonal 2, Back 3. */
export interface DirSpeeds { front: number; side: number; diagonal: number; back: number }

export interface PbCharacter {
  hp: number;
  /** Movement.{Front,Side,Diagonal,Back}MoveSpeed (MST RUN, the default gait) */
  run: DirSpeeds;
  /** Movement.Walk{Front,Side,Diagonal,Back}Move (MST WALK, Shift) */
  walk: DirSpeeds;
  /** Movement.AccelerationTime: seconds from 0 to full speed */
  accelerationTime: number;
  /** Movement.AccelRateBackVsFront (0 for the default soldiers) */
  accelRateBackVsFront: number;
  jumpHeight: number;
  jumpTime: number;
  jumpDelay: number;
  /** JumpPenaltyRate / JumpPenaltyTime: speed penalty after landing */
  jumpPenaltyRate: number;
  jumpPenaltyTime: number;
  /** ClunchJumpHeight / ClunchJumpCheckTime (crouch-jump) */
  crouchJumpHeight: number;
  crouchJumpCheckTime: number;
  /**
   * CamIKHeight vec4, indexed by the CameraContext state (0 stand, 1 crouch, ...): getVirtualCamPosition (0x815c40)
   * uses pos.y + CamIKHeight[state] for AI / non-1PV cameras. Not the 1PV eye (that is the Neck, see PB_FPS_CAMERA).
   */
  camIKHeight: [number, number, number, number];
  /** DamageRate per hit part (multiplier, see src/game/damage.ts) */
  damageRate: { head: number; body: number; arm: number; hand: number; leg: number; foot: number };
  /** Movement_ladder */
  ladder: { run: DirSpeeds; walk: DirSpeeds };
  /** SpeedReduction.<Part> (% of speed removed) / <Part>Time (s) after a hit on that part (pbMove.ts pbHitSlow) */
  speedReduction: Record<"body" | "arm" | "hand" | "leg" | "foot", { pct: number; time: number }>;
}

/**
 * pef-cross Character.SWAT_Male: the default male soldier, rendered with Chara/SWAT_Male/SWAT_Male.I3CHR (the swat_male
 * model the web client uses; DamageRate/HP read from the Cross pef). Was pef-3.123 AcidPol until 2026-10-13.
 */
export const PB_CHARA: PbCharacter = {
  // exe-2017 getFullHP 0x5454c0: default 100 (0x54550b), else CCharaInfo HP (+0x11ec, 0x534d10). Cross SWAT_Male HP 100.
  // Per-character HP of a real match comes from charaHp.ts.
  hp: 100,
  run: { front: 6.5, side: 6, diagonal: 6, back: 6 },
  // Cross SWAT_Male WalkFrontMove 4.2, WalkSideMove / WalkDiagonalMove / WalkBackMove 4 (was 3.123 4.15 / 3.95)
  walk: { front: 4.2, side: 4, diagonal: 4, back: 4 },
  accelerationTime: 0.2,
  accelRateBackVsFront: 0,
  jumpHeight: 1,
  jumpTime: 0.55,
  jumpDelay: 0.06,
  jumpPenaltyRate: 0.15,
  jumpPenaltyTime: 0.5,
  crouchJumpHeight: 1.15,
  crouchJumpCheckTime: 0.5,
  camIKHeight: [1.407, 1.062, 0.86, 1.407],
  // exe-2017 CCharaInfo::ReadDamageRateInfo 0x534a20 reads these raw (no scaling). Source: PBCross Character.pef Reinforced_SWAT_Male.DamageRate,
  // = cross/weapons/weapons.json charaDamageRate.SWAT_Male (checked 2026-10-13, identical). Constant, not read at runtime (sync value).
  // `head` is NOT a multiplier on a human target: see HEAD_HIT_DAMAGE.
  damageRate: { head: 35, body: 1.2, arm: 0.8, hand: 0.6, leg: 0.8, foot: 0.6 },
  // Movement_ladder: the Cross Character.pef has no ladder node, so CCharaInfo's 8 ladder floats (reader 0x534a1e -> +0x138c..+0x13a8)
  // keep the constructor 0.0 (0x53371a..0x53378c). Consumer: GetMoveSpeed 0x53fa20 returns, while chara state 0x10 (on a ladder),
  // GetLadderSpeed 0x53f940 (walk/run x front/side/diagonal/back getters 0x536620..0x536770) + the equipment bonus (+0xc98), with no
  // fallback to the ground speeds and no clamp; MoveContext stores it as maxSpeed (0x7e8ba5 -> +0x180) and the climb direction is the
  // ladder axes (0x7e8bc5..0x7e8c2b). So the Cross climb speed is 0 + bonus. Was the 3.123 run 5.5 / 5, walk 3.6 / 3.4.
  // Ladders do occur in Cross: CLadderTrigger boxes (GINS class 0xdedddfeb) only in FatalZone (Box16, Box17) and MarineWave
  // (Ladder01..03). CLadderTrigger update 0x98a8e0 sets chara state 0x10 (0x4ded60) while the climber is in the box with
  // forward input; on 0x10 the move update copies (0x7e4249, not adds) velocity = ladder axes x speed, clamped to the
  // maxSpeed +0x180 (0x7e4573). The bonus +0xc98 is only the title Move_Ability (0x766cbe -> 0x53f8d0), so without that
  // title the original Cross climber stands still: Cross ladders are not climbable, and 0 is the exe value, not a gap.
  // The web exports no ladder triggers and has no ladder state, so nothing reads this and nothing climbs a ladder (at a
  // Cross ladder the web capsule just walks into the wall, same height outcome). Not ported: the freeze in the box while
  // forward is held, and the slow climb at the title Move_Ability speed.
  ladder: {
    run: { front: 0, side: 0, diagonal: 0, back: 0 },
    walk: { front: 0, side: 0, diagonal: 0, back: 0 },
  },
  speedReduction: {
    body: { pct: 0, time: 0 }, arm: { pct: 0, time: 0 }, hand: { pct: 0, time: 0 }, leg: { pct: 0, time: 0 }, foot: { pct: 0, time: 0 },
  },
};

/** pef-2017 Character.SWAT_Male.DamageRate (now PB_CHARA.damageRate; 3.123 lowered Head 35 -> 5 and raised HP 100 -> 110). */
export const SWAT_MALE_2017_DAMAGE_RATE = { head: 35, body: 1.2, arm: 0.8, hand: 0.6, leg: 0.8, foot: 0.6 } as const;

/** pef-cross Character (globals; the same values as the 2017 pef). */
export const PB_CHARA_GLOBAL = {
  fallMinDamage: 2,
  fallDamageMinHeight: 5.8,
  fallDamageSlope: 5,
  dinoFallMinDamage: 3,
  dinoFallDamageMinHeight: 9.8,
  dinoFallDamageSlope: 6,
  /** SpeedReductionTime / SpeedReductionMaxRate (%): not read by the human hit path (it uses the per-part
   *  PbCharacter.speedReduction, exe-2017 0x7efc80), kept for reference */
  speedReductionTime: 0.5,
  speedReductionMaxRate: 20,
  invincibleTime: 4,
  respawnTime: 5,
  aimingAngleMin: -80,
  aimingAngleMax: 80,
} as const;

/** pef-cross Character.Mode.* part multipliers (SuddenDeath 3 everywhere; HeadHunter_Killer 0 everywhere in Cross, was
 *  head 150 / rest 0.01 in 3.123): no client code reads this table yet (the HeadHunter rule is in matchCore). The Cross exe
 *  loads HeadHunter_Killer (0x532a50 into 0xd86e80) but its per-part getter 0x532dc0 is a stub returning 1.0 (`fld1`), so the
 *  0 values are never used; MinDamage (0x532e00) only applies on stage type 7 and is 0. */
export const PB_MODE_RATES = {
  SuddenDeath: { head: 3, body: 3, arm: 3, hand: 3, leg: 3, foot: 3 },
  HeadHunter_Killer: { head: 0, body: 0, arm: 0, hand: 0, leg: 0, foot: 0 },
} as const;

/**
 * 1st-person camera. exe-2017 = PointBlank.exe 2017 VAs.
 *  - FOV: CGameCameraManager::Create (0x68d0e7) gives the FPS camera EnvSet+0x1d4 = the option-menu FOV, never the pef
 *    `Camera.FPS.FOV` 80 (no "FOV" key string exists in the exe); every other camera gets a literal 70. The option is
 *    clamped to [35, 80] (0x4cec5f load, 0x888af7 slider) and defaults to 70 (0x87d4fc, out-of-range load -> 70).
 *  - Vertical FOV, aspect = width / height (i3Camera::SetPerspective i3SceneDx 0x100bd5a0 -> 0x100bc630:
 *    m00 = cot(fov/2) / aspect, m11 = cot(fov/2)): 4:3 and 16:9 keep the same vertical FOV (Hor+), like three.js.
 *  - Near / Far: pef-cross Basic.json Camera.FPS Near 0.1 / Far 300 (read by FIND_REG_DATA at 0x68d04c). Height 0.519 /
 *    Distance 0.05 / SidePos go to CGameCamera+0x48, which the FPS update (0x689980) never reads.
 */
export const PB_FPS_CAMERA = {
  fov: 70,
  fovMin: 35,
  fovMax: 80,
  /** CGameCamera_Kill / Observer / Follow ... (0x68d11f) */
  otherCameraFov: 70,
  near: 0.1,
  far: 300,
  /**
   * FPSCamPos (Character.pef, CCharaInfo2::ReadInfo 0x53421b), in view space (x right, y up, z = -forward):
   * T(FPSCamPos) * RotY(yaw+pi) * RotAxis(right, -pitch) + Neck.worldPos (0x689980), so the offset turns with pitch
   * around the Neck. male = SWAT_Male group, female = Chou/Caimangrey group. [verificar] the Cross FPSCamPos values.
   */
  fpsCamPos: { male: [0.00565, 0.1392, -0.029], female: [0.01421, 0.0879, -0.026] } as Record<"male" | "female", readonly [number, number, number]>,
  /** CGameCamera zoom (0x5281d0 start, 0x528260 update): fov = from + (to - from) * sin(90deg * t / time) */
  zoomTime: 0.15,
  /**
   * CGameCharaCameraContext state change (0x816680): 0.1 s leaving stand (state 0), 0.3 s otherwise (crouch -> stand);
   * an interrupted transition keeps its remaining fraction. Applied here to the Neck stand <-> sit height (derived: the
   * 1PV eye itself follows the lower-body blend, whose time is not decoded).
   */
  postureTimeDown: 0.1,
  postureTimeUp: 0.3,
} as const;

/**
 * CGameCamera::SetShake(amp deg, freq, phase, time) (0x528570), applied per frame by 0x5285e0 to the camera matrix only:
 *   phi = t*freq*pi + phase; k = amp * (time - t) / time; pitch += sin(5 phi) * k; yaw += cos(2 phi) * k   (degrees)
 * Callers: Cmd_Damage 0x78cbf7 (world / suicide damage only - falls; non-lethal, attacker 0xffff), CalcHitPoint
 * 0x542d1d (local HP dropped by a hit: the only shake a bullet gives), explosion collision
 * 0x60ecc0 (k = 1 - d / (2 R), R = the explosion range read at [ebp-8] (inf.)). PlayFootStep 0x8233e8 shakes only for
 * T-Rex steps (0x54dd50), so a human's walk has no procedural shake: the bob is the Neck animation (pbFpsCam.generated).
 */
export const PB_CAMERA_SHAKE = {
  damage: (dealt: number, fullHp: number) => ({ amp: 2.5 + Math.min(dealt, fullHp) / fullHp, freq: 1, phase: 0.2, time: 0.5 }),
  hitPoint: { amp: 2, freq: 2, phase: 0, time: 0.1 },
  explosion: (dist: number, range: number) => {
    const k = 1 - dist / (2 * range);
    return k > 0 ? { amp: 15 * k * k, freq: 10 * k, phase: 0.2, time: k } : null;
  },
} as const;

/** pef-cross Basic.json Physix.Gravity -9.81 (PhysX scene: ragdolls, grenades, objects). */
export const PB_PHYSX_GRAVITY = 9.81;

/**
 * Ballistic summary of the jump for code that only needs a gravity (bots, scripts/dev/test-stairs.mjs). The player runs the
 * real curves from src/gameplay/pbMove.ts: a sine rise over JumpTime/2 and a fall drop = K t^2 with
 * K = JumpHeight / (JumpTime/2)^2 (exe-2017 OnReset 0x7ee29c / 0x7ef6d0), so gravity = 2K = 8h/T^2 exactly; v0 is the
 * take-off speed of a parabola with the same apex and rise time (the real rise is a sine, not a parabola).
 */
export function jumpBallistics(c: PbCharacter = PB_CHARA, crouch = false): { gravity: number; v0: number } {
  const h = crouch ? c.crouchJumpHeight : c.jumpHeight;
  const T = c.jumpTime;
  return { gravity: (8 * c.jumpHeight) / (T * T), v0: (4 * h) / T };
}

/** Direction type exactly as CGameCharaMoveContext::_GetMoveVelocity (0x7f0db0), local dir: z forward, x right. */
export function moveDirType(localX: number, localZ: number): keyof DirSpeeds {
  if (localZ > 0) return localX !== 0 ? "diagonal" : "front";
  if (localZ < 0) return localX !== 0 ? "diagonal" : "back";
  return "side";
}

/** Fall damage, CGameCharaMoveContext::_CalcFallingDamage (0x7f0ec0): h = |takeoff.y - landing.y|. */
export function pbFallDamage(height: number, fullHp = PB_CHARA.hp, dino = false): number {
  const g = PB_CHARA_GLOBAL;
  const minH = dino ? g.dinoFallDamageMinHeight : g.fallDamageMinHeight;
  const minD = dino ? g.dinoFallMinDamage : g.fallMinDamage;
  const slope = dino ? g.dinoFallDamageSlope : g.fallDamageSlope;
  if (!(height > minH)) return 0;
  return Math.min(fullHp, Math.max(minD, minD + Math.trunc(slope * height)));
}

/**
 * Helmet protection: pef-cross Equipment.Head.HelmetDefault.Defense = 0.75 (default helmet 701002; 2017 value the same). CalcHelmetPenetrate (0x5425e0) divides the weapon's
 * HelmetPenetrate by it.
 */
export const PB_DEFAULT_HELMET_PROTECTION = 0.75;

/**
 * Movement capsule = the PhysX character controller of exe-2017 CGameCharaMoveContext::CreateController (0x7ee470): a
 * local or AI human gets NxCapsuleControllerDesc radius 0.39 (0x7ee608) and height 0.65 (0x7ee615, the distance between
 * the hemisphere centres = 2 * halfHeight), skinWidth 0.085, stepOffset 0.4 (AI 0.25), slopeLimit cos 45 deg. The feet are
 * the capsule bottom (i3PhysixController::getPosition, i3SceneDx 0x1015e870: centre.y - height/2 - radius), so the body is
 * 1.43 m tall: it jumps standing through the 1.63 m Downtown windows next to bomb site A (a 1.9 m capsule never fit).
 * Kept equal to src/config.ts MovementConfig so bots (still on MovementConfig) and the player share one size.
 */
export const PB_CAPSULE = {
  radius: 0.39,
  halfHeightStand: 0.325,
  /**
   * [INFERIDO] crouching does not resize the controller: ChangeControllerHeight (0x7eecf0, the only caller of
   * i3PhysixController::SetCenterHeightAndHeight) is reached only through CGameCharaMoveControl vtable slot 5 (0xc91340)
   * and no virtual call of that slot lands on a move control (negative search of the 2017 exe).
   */
  halfHeightCrouch: 0.325,
  /**
   * MEASURED, not the exe's stepOffset 0.4 (Rapier's autostep is not PhysX's up / side / down passes). NStation 2017
   * collision stair risers are 0.17-0.22 m (treads 0.37-0.40 m); 0.30 = tallest riser + margin. Validated headless by
   * scripts/dev/test-stairs.mjs. The 2017 bots still use src/config.ts MovementConfig.maxStepHeight 0.35.
   */
  maxStepHeight: 0.3,
  /** exe-2017 slopeLimit = cos(pi/4) (0x7ee4c3) */
  maxSlopeClimbDeg: 45,
} as const;

/**
 * Mouse look, PointBlank.exe 2017 (re-read 2026-10-03). CGameCharaInputControlLocal 0xa23e80 turns the DirectInput delta
 * (i3InputMouse::Update 0x100ae220 in i3InputDx.dll: cvtsi2ss of DIMOUSESTATE lX/lY, raw counts, no accel) into radians:
 *   framework 0x51e2a0 (0x51ebe5..0x51ec71): d = (dx, dy, dz) * [g_d80ba8 + 0x1d0]   (the option's sensitivity)
 *   0xa23e80 (a23fed..a24098): yaw += -d.x * 0.005 (dbl 0xb84928); pitch += (inverted ? d.y : -d.y) * 0.005
 * so rad/px = sensitivity * 0.005. The same factor in battle, zoomed or not: no zoom term in either function.
 * Sensitivity: default 0.5 (option ctor 0x4cd0d0, store at 0x4cd2b6), valid 0.10..1.20 (clamps 0x4ce8d0 load, popup edit 0x88a1a0,
 * arrows 0x888970 step +-0.01), shown "%.2f". An out-of-range stored value resets to 0.5 (0x4cec2a). Saved as a signed
 * 16-bit * 0.01 in the account option field (0x4ceb8c..0x4ceb9d).
 * `Basic.Config.MouseSensivity 0.45` (basic.json) is a dev/config entry: the exe has no reader for it ([INFERIDO] unused).
 */
export const MOUSE_RAD_PER_COUNT = 0.005;
export const MOUSE_SENS_DEFAULT = 0.5;
export const MOUSE_SENS_MIN = 0.1;
export const MOUSE_SENS_MAX = 1.2;
export const MOUSE_SENS_STEP = 0.01;

/** MoveNormal_* of the held weapon, % of the character speed (Weapon.pef). */
export interface MoveNormalPct { stand: number; fire: number; sit: number; zoom: number; scope: number }

/**
 * Live link WeaponSystem <-> Player: the weapon system writes the held weapon's MoveNormal_* and fire/zoom state, the
 * player writes whether it walks (Shift). null moveNormal = no weapon info -> 100 %.
 */
export const pbLive: {
  moveNormal: MoveNormalPct | null; firing: boolean; aiming: boolean; scoped: boolean; walking: boolean;
  /** skeleton family of the 1PV arms (set by the viewmodel when they load): picks FPSCamPos and the Neck table */
  fpsFamily: "male" | "female";
} = {
  moveNormal: null, firing: false, aiming: false, scoped: false, walking: false, fpsFamily: "male",
};
