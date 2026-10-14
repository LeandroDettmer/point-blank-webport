import * as THREE from "three";
import { aimLookScale, getSettings, lookScale } from "./gameplay/settings";
import type RAPIER from "@dimforge/rapier3d-compat";
import {
  PB_CAPSULE, PB_CHARA, PB_CHARA_GLOBAL, PB_FPS_CAMERA, jumpBallistics, moveDirType, pbFallDamage,
  pbLive, type PbCharacter,
} from "./gameplay/pbConfig";
import {
  PB_FALL_DAMAGE_MIN_TIME, newAccelState, pbAccelStep, pbCanJump, pbFallK, pbHitSlow, pbJumpRiseY,
  pbJumpFactor, pbJumpStart, type PbHitPart, type PbJump,
} from "./gameplay/pbMove";
import { PB_NECK, type NeckBob, type NeckTable } from "./gameplay/pbFpsCam.generated";
import { CLIP_STRIDE } from "./game/charAnim";
import { KCC_GROUND_PUSH, configurePbKcc, slideOffWalls, touchedGround } from "./gameplay/kcc";
import type { Input } from "./game/input";
import { held, pressed } from "./game/keymap";
import { ACTOR_COLLISION_GROUPS, KCC_QUERY, WORLD_ONLY_QUERY } from "./game/types";

// Movement from Character.pef 3.123 (src/gameplay/pbConfig.ts): default gait is RUN, Shift walks silently, speed per
// direction type (_GetMoveVelocity 0x7f0db0) x the held weapon's MoveNormal_* %, the exe-2017 accel / jump / fall
// curves of src/gameplay/pbMove.ts, fall damage from the fall height (_CalcFallingDamage 0x7f0ec0).
const CHARA: PbCharacter = PB_CHARA;
const FALL_K = pbFallK(CHARA);
export const PBMove = {
  /** constant fall acceleration 2K (exe-2017 0x7ef6d0), exported for code that only needs a gravity */
  gravity: jumpBallistics(CHARA).gravity,
};

const DEG = Math.PI / 180;
/** Character.AimingAngleMax / Min (pef-3.123): pitch limit of the view */
const PITCH_MAX = PB_CHARA_GLOBAL.aimingAngleMax * DEG;
const PITCH_MIN = PB_CHARA_GLOBAL.aimingAngleMin * DEG;
/** [RECRIADO] cross-fade between Neck bob curves (the lower-body blend time is not decoded) */
const BOB_FADE = 0.2;
type BobKey = keyof NeckTable["bob"];

/** Linear sample of a looping Neck curve at cycle phase u in [0, 1). */
function bobAt(b: NeckBob, u: number, out: THREE.Vector3, w: number): void {
  const n = b.up.length, f = (((u % 1) + 1) % 1) * n, i = Math.floor(f) % n, j = (i + 1) % n, a = f - Math.floor(f);
  out.x += (b.right[i] + (b.right[j] - b.right[i]) * a) * w;
  out.y += (b.up[i] + (b.up[j] - b.up[i]) * a) * w;
  out.z += (b.fwd[i] + (b.fwd[j] - b.fwd[i]) * a) * w;
}

export interface PlayerTickFlags {
  move: boolean; // WASD / jump / crouch
  look: boolean; // mouse look
  /** C4 install / uninstall hold: Cmd_Install 0x78ade0 / Cmd_Uninstall 0x78ee00 force the crouch (0x80ec80), zero the move vectors
   *  (+0x134 / +0x158 / +0x164), set chara flag +0x524 |= 0xc (blocks crouch toggle 0x78aa80 / 0x78c360 and jump 0x78b100) and the
   *  frame handler 0x78c9e3 drops the move input while state bit 0x17 / 0x18 is set. The mouse look 0xa23e80 is not touched. */
  hold?: boolean;
  aiming?: boolean; // zoomed/ADS: applies the settings' separate aim sensitivity on top of the base one
}

export class Player {
  camera: THREE.PerspectiveCamera;
  body: RAPIER.RigidBody;
  controller: RAPIER.KinematicCharacterController;
  collider: RAPIER.Collider;

  private world: RAPIER.World;
  private RAPIER: typeof RAPIER;
  private input: Input;

  yaw = 0;
  pitch = 0;
  private recoilPitch = 0; // visual kick that recovers

  readonly velocity = new THREE.Vector3();
  private grounded = false;
  private crouching = false;
  private silent = false;
  private skipMove = false;
  /** 0 stand .. 1 crouch, linear over PB_FPS_CAMERA.postureTimeDown / Up */
  private posture = 0;
  private bobPhase: Record<BobKey, number> = { idle: 0, run: 0, walk: 0, sitIdle: 0, sitMove: 0 };
  private bobW: Record<BobKey, number> = { idle: 1, run: 0, walk: 0, sitIdle: 0, sitMove: 0 };
  private _neck = new THREE.Vector3();
  private _off = new THREE.Vector3();
  private _q = new THREE.Quaternion();
  private _e = new THREE.Euler(0, 0, 0, "YXZ");
  private takeoffY = 0; // feet Y at the apex / last ground point (MoveContext +0x18c, fall height reference 0x7f0ec0)
  private accel = newAccelState();
  /**
   * Designation (title) battle effects, family sums already added over the 3 title slots, signed (
   *). move = Move_Ability (chara +0xc98, added to GetMoveSpeed), jump = Jump_Ability (+0xcbc,
   * added to JumpHeight 0xa0ebd0), accel = AddSpeed_Ability (+0xcc0, added to AccelerationTime 0x7fbbc0), fall =
   * FallDown_Damage (+0xcc4, added to the fall-damage min height 0x544720). All 0 = the plain character.
   */
  titleMove = { move: 0, jump: 0, accel: 0, fall: 0 };
  private accelChara: PbCharacter = CHARA;
  /** maxSpeed (MoveContext +0x180): ProcessAccel stops refreshing it in the air */
  private maxSpeed = 0;
  /** time since landing (chara +0x578): JumpDelay gate and JumpPenalty tiers */
  private sinceLanding = 0;
  /** time since standing up (ActionControl +0x2c): crouch-jump window */
  private sinceStandUp = Infinity;
  /** active jump rise, null when not rising (MoveContext state 3) */
  private jump: PbJump | null = null;
  private jumpT = 0;
  private jumpY0 = 0;
  /** fall timer (+0x19c) and the previous drop (+0x198) */
  private fallT = 0;
  private fallPrev = 0;
  /** hit slowdown (+0x184 timer, +0x188 rate) */
  private slowLeft = 0;
  private slowRate = 1;

  constructor(
    world: RAPIER.World,
    RAPIER_MOD: typeof RAPIER,
    camera: THREE.PerspectiveCamera,
    spawn: THREE.Vector3,
    input: Input
  ) {
    this.world = world;
    this.RAPIER = RAPIER_MOD;
    this.camera = camera;
    this.input = input;

    const bodyDesc = RAPIER_MOD.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y, spawn.z);
    this.body = world.createRigidBody(bodyDesc);

    const colDesc = RAPIER_MOD.ColliderDesc.capsule(PB_CAPSULE.halfHeightStand, PB_CAPSULE.radius)
      .setCollisionGroups(ACTOR_COLLISION_GROUPS);
    this.collider = world.createCollider(colDesc, this.body);

    this.controller = world.createCharacterController(0.02);
    configurePbKcc(this.controller, PB_CAPSULE);
  }

  private halfHeight(): number {
    return this.crouching ? PB_CAPSULE.halfHeightCrouch : PB_CAPSULE.halfHeightStand;
  }

  /** Capsule centre (legacy HUD readout). */
  getPosition(): THREE.Vector3 {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  getFeet(out: THREE.Vector3): THREE.Vector3 {
    const t = this.body.translation();
    return out.set(t.x, t.y - this.halfHeight() - PB_CAPSULE.radius, t.z);
  }

  /**
   * PB FPS camera (CGameCamera_FPS 0x689980): eye = Neck.worldPos + R(yaw, pitch) * FPSCamPos. The Neck comes from the
   * baked lower-body clips (stand / sit height + walk / run bob, src/gameplay/pbFpsCam.generated.ts).
   */
  eyePosition(out: THREE.Vector3, pitch = this.pitch): THREE.Vector3 {
    return this.eyeAt(this.getFeet(out), pitch);
  }

  private eyeAt(feet: THREE.Vector3, pitch: number): THREE.Vector3 {
    const fam = pbLive.fpsFamily, T = PB_NECK[fam];
    // Neck in the character frame: right, up, forward (the table's model space has right = -x, forward = +z)
    const n = this._neck.set(0, 0, 0);
    const s = this.posture;
    n.x = -(T.neckStand[0] + (T.neckSit[0] - T.neckStand[0]) * s);
    n.y = T.neckStand[1] + (T.neckSit[1] - T.neckStand[1]) * s;
    n.z = T.neckStand[2] + (T.neckSit[2] - T.neckStand[2]) * s;
    for (const k of Object.keys(this.bobW) as BobKey[]) if (this.bobW[k] > 1e-3) bobAt(T.bob[k], this.bobPhase[k], n, this.bobW[k]);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    // three camera: forward (-sin yaw, 0, -cos yaw), right (cos yaw, 0, -sin yaw)
    feet.x += n.x * cy - n.z * sy;
    feet.z += -n.x * sy - n.z * cy;
    feet.y += n.y;
    const c = PB_FPS_CAMERA.fpsCamPos[fam];
    this._q.setFromEuler(this._e.set(pitch, this.yaw, 0, "YXZ"));
    return feet.add(this._off.set(c[0], c[1], c[2]).applyQuaternion(this._q));
  }

  /** Advances the stand/crouch height and the Neck bob cycles. */
  private updateNeck(dt: number): void {
    const P = PB_FPS_CAMERA;
    const want = this.crouching ? 1 : 0;
    if (this.posture < want) this.posture = Math.min(want, this.posture + dt / P.postureTimeDown);
    else if (this.posture > want) this.posture = Math.max(want, this.posture - dt / P.postureTimeUp);
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const moving = this.grounded && speed > 0.3;
    const key: BobKey = this.crouching ? (moving ? "sitMove" : "sitIdle") : !moving ? "idle" : this.silent ? "walk" : "run";
    const T = PB_NECK[pbLive.fpsFamily].bob;
    const k = Math.min(1, dt / BOB_FADE);
    for (const b of Object.keys(this.bobW) as BobKey[]) {
      this.bobW[b] += ((b === key ? 1 : 0) - this.bobW[b]) * k;
      // cycles/s: moving curves keep the stance foot at the real speed (charAnim lowerCadence, [RECRIADO] rate rule)
      const dur = T[b].dur, nat = 1 / dur;
      const stride = b === "run" ? CLIP_STRIDE.run.Front : b === "walk" ? CLIP_STRIDE.walk.Front : b === "sitMove" ? CLIP_STRIDE.sit.Front : 0;
      const rate = stride > 0 ? THREE.MathUtils.clamp(speed / stride, nat * 0.4, nat * 2.5) : nat;
      if (this.bobW[b] > 1e-3 || b === key) this.bobPhase[b] = (this.bobPhase[b] + dt * rate) % 1;
    }
  }

  isGrounded(): boolean {
    return this.grounded;
  }
  isCrouching(): boolean {
    return this.crouching;
  }
  /** Shift-walk: no footstep noise for bots to hear. */
  isSilent(): boolean {
    return this.silent || this.crouching;
  }
  speedRatio(): number {
    return Math.hypot(this.velocity.x, this.velocity.z) / CHARA.run.front;
  }

  /** Permanent look delta (recoil from src/weapons via applyLook). */
  addLook(dPitch: number, dYaw: number): void {
    this.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.pitch + dPitch));
    this.yaw += dYaw;
  }

  addRecoil(pitch: number, yaw: number): void {
    this.pitch = Math.min(PITCH_MAX, this.pitch + pitch);
    this.yaw += yaw;
    this.recoilPitch += pitch * 0.5;
  }

  teleportFeet(feet: THREE.Vector3, yaw: number): void {
    if (this.crouching) {
      this.crouching = false;
      this.collider.setHalfHeight(PB_CAPSULE.halfHeightStand);
    }
    const c = feet.y + PB_CAPSULE.halfHeightStand + PB_CAPSULE.radius + 0.05;
    this.body.setTranslation({ x: feet.x, y: c, z: feet.z }, true);
    this.body.setNextKinematicTranslation({ x: feet.x, y: c, z: feet.z });
    this.velocity.set(0, 0, 0);
    // respawn / reset (0x53e31d, 0x540c98) zero the landing timer; OnReset 0x7ee0a0 clears the move context
    this.accel = newAccelState();
    this.jump = null;
    this.fallT = this.fallPrev = 0;
    this.sinceLanding = 0;
    this.sinceStandUp = Infinity;
    this.slowLeft = 0;
    this.takeoffY = feet.y;
    this.yaw = yaw;
    this.pitch = 0;
    this.recoilPitch = 0;
    this.posture = 0;
    this.skipMove = true;
  }

  setCollisionEnabled(on: boolean): void {
    this.collider.setEnabled(on);
  }

  private headroomFor(dh: number): boolean {
    const t = this.body.translation();
    const top = t.y + this.halfHeight() + PB_CAPSULE.radius;
    const ray = new this.RAPIER.Ray({ x: t.x, y: top - 0.02, z: t.z }, { x: 0, y: 1, z: 0 });
    return !this.world.castRay(ray, dh * 2 + 0.05, true, undefined, WORLD_ONLY_QUERY);
  }

  /** Returns the fall height (m, |takeoff.y - landing.y|) on the frame the player touches down, else 0. */
  update(dt: number, flags: PlayerTickFlags): number {
    const inp = this.input;
    if (flags.look) {
      // lobby Configuração: sensitivity / invert mouse (gameplay/settings.ts; exe formula rad = sens * 0.005 per count)
      const st = getSettings(), k = lookScale(st) * (flags.aiming ? aimLookScale(st) : 1);
      this.yaw -= inp.lookDX * k;
      this.pitch -= inp.lookDY * k * (st.invertMouse ? -1 : 1);
      this.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.pitch));
    }
    this.recoilPitch = Math.max(0, this.recoilPitch - dt * 0.25);

    const pos = this.body.translation();
    const dh = PB_CAPSULE.halfHeightStand - PB_CAPSULE.halfHeightCrouch;

    // Crouch toggles resize the capsule and shift its centre so the feet stay put. Key map slot 6 = LCtrl (C is radio).
    const wantCrouch = !!flags.hold || (flags.move && held(inp, "crouch"));
    this.sinceLanding += dt;
    this.sinceStandUp += dt;
    if (wantCrouch !== this.crouching && (wantCrouch || this.headroomFor(dh))) {
      if (!wantCrouch) this.sinceStandUp = 0; // stand-up 0xa0a250 stores the game time (ActionControl +0x2c)
      this.crouching = wantCrouch;
      this.collider.setHalfHeight(this.halfHeight());
      // Standing up always keeps the feet; crouching mid-air keeps the head (legs tuck up).
      const shift = wantCrouch ? (this.grounded ? -dh : 0) : dh;
      this.body.setNextKinematicTranslation({ x: pos.x, y: pos.y + shift, z: pos.z });
      this.skipMove = true;
    }

    let landing = 0;
    if (this.skipMove) {
      this.skipMove = false;
    } else {
      // three.js cameras look down -Z, so forward at yaw is (-sin, 0, -cos).
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const rx = -fz, rz = fx;
      let wx = 0, wz = 0;
      let localX = 0, localZ = 0;
      if (flags.hold) this.accel = newAccelState();
      if (flags.move && !flags.hold) {
        const W = held(inp, "forward"), S = held(inp, "back"), D = held(inp, "right"), A = held(inp, "left");
        localZ = (W ? 1 : 0) - (S ? 1 : 0);
        localX = (D ? 1 : 0) - (A ? 1 : 0);
        if (W) { wx += fx; wz += fz; }
        if (S) { wx -= fx; wz -= fz; }
        if (D) { wx += rx; wz += rz; }
        if (A) { wx -= rx; wz -= rz; }
      }
      const wl = Math.hypot(wx, wz);
      if (wl > 0) { wx /= wl; wz /= wl; }

      this.silent = flags.move && held(inp, "walk");
      pbLive.walking = this.silent;
      const airborne = !this.grounded || this.jump !== null;
      // ProcessAccel 0x7f3600: maxSpeed from the gait / direction / MoveNormal chain, not refreshed in the air (0x7f3785)
      if (!airborne && wl > 0) this.maxSpeed = this.moveSpeed(localX, localZ);
      this.slowLeft = Math.max(0, this.slowLeft - dt); // 0x7efda0
      const a = this.accel;
      pbAccelStep(a, wx, wz, this.maxSpeed, dt, airborne, this.accelCharaNow(), this.slowLeft > 0 ? this.slowRate : 1);
      const v = this.velocity;
      v.x = a.vx;
      v.z = a.vz;

      // Jump start (OnActionJumpStart 0xa0a670): on the press, on the floor, JumpDelay after the last landing. A crouch
      // jump keeps the crouch.
      const feetNow = pos.y - this.halfHeight() - PB_CAPSULE.radius;
      if (this.grounded && !this.jump && flags.move && !flags.hold && pressed(inp, "jump") && pbCanJump(this.sinceLanding, CHARA)) {
        this.jump = pbJumpStart(this.sinceLanding, this.crouching, this.sinceStandUp, CHARA);
        // Jump_Ability: (JumpHeight + sum) * f (0xa0a670); the fall K and the rise time stay unscaled. [INFERIDO] the sum
        // also applies to the crouch-jump height (the getter 0xa0ebd0 is not seen split by posture).
        if (this.titleMove.jump !== 0) {
          this.jump.height = Math.max(0, this.jump.height + this.titleMove.jump * pbJumpFactor(this.sinceLanding, CHARA));
        }
        if (this.jump.crouchJump) this.sinceStandUp = Infinity;
        this.jumpT = 0;
        this.jumpY0 = feetNow;
      }
      // Vertical move of this frame (UpdateJumping 0x7ef780): sine rise to the apex, then drop = K t^2
      let dy = 0;
      let apex = false;
      if (this.jump) {
        if (this.jumpT > 0 && this.jumpT + dt > this.jump.halfTime) apex = true;
        else {
          this.jumpT += dt;
          dy = Math.max(0, this.jumpY0 + pbJumpRiseY(this.jump, this.jumpT) - feetNow);
        }
      }
      if (apex) this.toApex(feetNow);
      if (!this.jump) {
        if (this.grounded && !apex) dy = KCC_GROUND_PUSH * dt * 60; // exe -0.1: see KCC_GROUND_PUSH
        else {
          this.fallT += dt;
          const drop = FALL_K * this.fallT * this.fallT;
          dy = this.fallPrev - drop;
          this.fallPrev = drop;
        }
      }
      v.y = dy / dt;

      const wasGrounded = this.grounded;
      const desired = { x: v.x * dt, y: dy, z: v.z * dt };
      this.controller.computeColliderMovement(this.collider, desired, undefined, KCC_QUERY);
      let corrected = this.controller.computedMovement();
      const rising = this.jump !== null && desired.y > 0;
      const onGround = () => this.controller.computedGrounded() || touchedGround(this.controller, PB_CAPSULE.maxSlopeClimbDeg);
      this.grounded = onGround() && !rising;
      if (rising && corrected.y < desired.y * 0.5) this.toApex(feetNow + corrected.y); // bonked the ceiling

      // Descent-only fallback: the exe's -0.1 ground push (`dy` above) is too short to reliably re-touch the next
      // tread on a fast-running descent when enableSnapToGround(0.3) alone misses it, which briefly dropped
      // `grounded` and fired the K t^2 fall / fall damage / jump-penalty path on ordinary stairs. Only retried when
      // the primary query (which enableAutostep needs intact to climb) actually lost the ground, re-querying from
      // the same start with the already-resolved x/z but a full step-height search down; only the collision probe
      // widens, `dy`/v.y (the exe-accurate push/fall speed) stay untouched so jump/fall fidelity is unaffected.
      if (!this.grounded && wasGrounded && !this.jump) {
        this.controller.computeColliderMovement(
          this.collider, { x: corrected.x, y: -PB_CAPSULE.maxStepHeight, z: corrected.z }, undefined, KCC_QUERY
        );
        if (onGround()) {
          corrected = this.controller.computedMovement();
          this.grounded = true;
        }
      }

      // Kill velocity into walls (not stair edges) so we slide instead of sticking.
      slideOffWalls(this.controller, v, feetNow, PB_CAPSULE.maxStepHeight);
      a.vx = v.x;
      a.vz = v.z;
      const feetY = feetNow + corrected.y;
      if (this.grounded) {
        // landing 0x7ef5e0: fall damage needs more than 0.1 s of fall; the landing handler zeroes chara +0x578
        if (!wasGrounded && this.fallT > PB_FALL_DAMAGE_MIN_TIME) landing = Math.max(1e-3, Math.abs(this.takeoffY - feetY));
        if (!wasGrounded) this.sinceLanding = 0;
        this.takeoffY = feetY; // 0x7ef570 keeps +0x18c at the ground position on every grounded frame
        this.fallT = this.fallPrev = 0;
        v.y = 0;
      }

      this.body.setNextKinematicTranslation({ x: pos.x + corrected.x, y: pos.y + corrected.y, z: pos.z + corrected.z });
    }

    this.updateNeck(dt);
    return landing;
  }

  /** Apex (0x7ef570): the rise ends, the fall starts here and the fall height is measured from it. */
  private toApex(feetY: number): void {
    this.jump = null;
    this.takeoffY = feetY;
    this.fallT = this.fallPrev = 0;
  }

  /** CCharaInfo with AccelerationTime + AddSpeed_Ability (0x7fbbc0); the plain CHARA when the sum is 0. */
  private accelCharaNow(): PbCharacter {
    const add = this.titleMove.accel;
    if (add === 0) return CHARA;
    if (this.accelChara.accelerationTime !== CHARA.accelerationTime + add) {
      this.accelChara = { ...CHARA, accelerationTime: CHARA.accelerationTime + add };
    }
    return this.accelChara;
  }

  /** Fall damage with the Designation FallDown_Damage sum on the min height (0x544720); same as {@link fallDamage} at 0. */
  fallDamage(fallHeight: number): number {
    return fallDamage(fallHeight, this.titleMove.fall);
  }

  /** Hit on a body part: SpeedReduction<Part> slowdown (exe-2017 0x7efc80; every value is 0 for the default soldier). */
  onHitPart(part: PbHitPart): void {
    const r = pbHitSlow(part, CHARA);
    if (!r) return;
    this.slowRate = r.rate;
    this.slowLeft = r.time;
  }

  /**
   * Speed for a local input direction, CGameCharaMoveContext::ProcessAccel 0x7f3600-0x7f376c:
   *   v = GetMoveSpeed(RUN|WALK, dirType) x MoveNormal_(crouch ? Sit : Stand)% x (zoomed ? MoveNormal_Zoom%) x (firing ? MoveNormal_Fire%)
   * (WeaponBase::GetMoveSpeed 0x615ea0; factors stack). MoveNormal_Zoom 0 means "no zoom mode" and is skipped.
   * JumpPenaltyRate / JumpPenaltyTime do not slow the run: they only scale the next jump (pbMove.ts pbJumpFactor).
   */
  moveSpeed(localX: number, localZ: number): number {
    const table = this.silent ? CHARA.walk : CHARA.run;
    // Move_Ability: GetMoveSpeed + chara[+0xc98] (0x544560), before the weapon MoveNormal % (0x615ea0).
    // [INFERIDO] unit (m/s) and the order with MoveNormal_* (the exe order was not followed call by call).
    let v = table[moveDirType(localX, localZ)] + this.titleMove.move;
    const mn = pbLive.moveNormal;
    if (mn) {
      v *= (this.crouching ? mn.sit : mn.stand) / 100;
      if (pbLive.aiming && mn.zoom > 0) v *= mn.zoom / 100;
      if (pbLive.firing) v *= mn.fire / 100;
    }
    return v;
  }

  /** Places the first-person camera at the eye (uses the next kinematic position). */
  updateCamera(): void {
    const t = this.body.nextTranslation();
    const feetY = t.y - this.halfHeight() - PB_CAPSULE.radius;
    const pitch = this.pitch + this.recoilPitch * 0.3;
    this.eyeAt(this.camera.position.set(t.x, feetY, t.z), pitch);
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = pitch;
    this.camera.rotation.z = 0;
  }
}

/** Fall damage for a fall height in meters (CGameCharaMoveContext::_CalcFallingDamage 0x7f0ec0). */
export function fallDamage(fallHeight: number, minHeightAdd = 0): number {
  if (minHeightAdd === 0) return pbFallDamage(fallHeight, CHARA.hp);
  // FallDown_Damage: min height = FallDamageMinHeight + sum (0x544720); damage curve as pbFallDamage (0x7f0fc4)
  const g = PB_CHARA_GLOBAL;
  if (!(fallHeight > g.fallDamageMinHeight + minHeightAdd)) return 0;
  return Math.min(CHARA.hp, Math.max(g.fallMinDamage, g.fallMinDamage + Math.trunc(g.fallDamageSlope * fallHeight)));
}
