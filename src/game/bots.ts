import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { MovementConfig } from "../config";
import { PB_CAPSULE, PB_CHARA } from "../gameplay/pbConfig";
import { touchedGround } from "../gameplay/kcc";
import { BOT_PEF, pbBotSpeed } from "./botMove";
import { bindWeaponAnim } from "./charAnimLib";
import { actorHasHelmet, actorHeadgearOn, noteBotEquip } from "./charEquip";
import { createCharVisual, spawnBlinkAlpha, type CharVisual } from "./charModel";
import { chestPoint, headPoint } from "./hitbox";
import type { NavGraph } from "./navGraph";
import { flashFor, onFlashbang, smokeField, type FlashBurst } from "../weapons/throwables";
import type { SpawnPoint } from "./spawns";
import { ACTOR_COLLISION_GROUPS, KCC_QUERY, WORLD_ONLY_QUERY, type Actor, type HitZone, type ObsState, type Team } from "./types";
import type { DeathHit } from "./ragdoll";
import { BOT_WEAPON, spreadDir, type WeaponDef } from "./weaponAdapter";
import aiTable from "./data/aiCharacter.json" with { type: "json" };
import { botPerf } from "./perf";
import type { PlayerState } from "./netAdapter";
import { BOT_NAMES, botNameOfSlot } from "./botNames";

/** One row of pef-2017 AICharacter.json (Level_1..10 x AI_1..8, pb-extract-tools pef/extract-config.mjs). */
interface AiRow { hp: number; dev: number; atk: number; pre: number; tot: number; ang: number; rng: number; resp: number }
/** Level 1..10 from the bot skill; the archetype AI_1..8 from the bot's index. */
function aiRowFor(skill: number, id: string): AiRow {
  const level = Math.max(1, Math.min(10, Math.round(skill * 10)));
  const rows = (aiTable as unknown as Record<string, AiRow[]>)[String(level)];
  return rows[(Number(id.replace(/\D/g, "")) || 0) % rows.length];
}

/** What a bot needs from the game loop. Implemented by Game. */
export interface BotHost {
  readonly world: RAPIER.World;
  readonly R: typeof RAPIER;
  readonly scene: THREE.Scene;
  readonly nav: NavGraph | null;
  now(): number;
  canAct(): boolean;
  actors(): Iterable<Actor>;
  /** Fire one bullet for `shooter` along `dir`; the game resolves hits/damage/effects. */
  botFire(shooter: Bot, weapon: WeaponDef, origin: THREE.Vector3, dir: THREE.Vector3): void;
  enemySpawns(team: Team): SpawnPoint[];
}

let nameIdx = 0;

type BotState = "patrol" | "combat" | "investigate";

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
// per-call scratch for perceive / fireLogic (never stored: botFire / shoot only read origin + dir)
const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _spread = new THREE.Vector3();
let _losRay: RAPIER.Ray | null = null;

function yawTo(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}
function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** [RECRIADO] how far a bot fires at a Destroy objective (the AI rows have no objective range; the rifle range of the bot weapons) */
const OBJECTIVE_RANGE = 40;

/** NOT ORIGINAL: bot KCC rate (perf). Hz of the fixed physics step; max steps folded into one frame after a hitch. */
export const BOT_PHYS_HZ = 30;
const BOT_PHYS_DT = 1 / BOT_PHYS_HZ;
const BOT_PHYS_MAX_STEPS = 3;
let physPhaseIdx = 0;

export class Bot implements Actor {
  readonly kind = "bot" as const;
  readonly id: string;
  name: string;
  hp = PB_CHARA.hp;
  maxHp = PB_CHARA.hp;
  armor = 100;
  /** popped off by HELMET PROTECTION this life (reset on respawn) */
  helmetLost = false;
  /** wears a helmet: a head item is equipped (charEquip.ts actorHasHelmet) and it has not popped off this life */
  get helmet(): boolean { return !this.helmetLost && actorHasHelmet(this.id); }
  set helmet(on: boolean) { this.helmetLost = !on; }
  alive = false;
  invulnUntil = 0;
  weaponName: string;
  readonly skill: number;
  /** AICharacter row of this bot (hp, aim deviation, attack timing, sight, respawn time) */
  readonly ai: AiRow;
  private burstT = 0;

  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  private controller: RAPIER.KinematicCharacterController;
  private visual: CharVisual;

  private yawV = 0;
  private pitchV = 0;
  private crouch = false;
  private crouchTimer = 0;
  /** aiming down sights (upper Zoom stance, MoveNormal_Zoom) */
  private zoom = false;
  private firingT = 0;
  private vel = new THREE.Vector3();
  private grounded = false;
  /** NOT ORIGINAL: 30 Hz KCC accumulator (phase spread per bot so the cost is flat) + the last two physics feet for the visual */
  private physAcc = (physPhaseIdx++ * 0.6180339887 % 1) * BOT_PHYS_DT;
  private prevFeet = new THREE.Vector3();
  private curFeet = new THREE.Vector3();

  private state: BotState = "patrol";
  /** Bomb Mission objective set by Game each frame (game.ts bombBots): walk here instead of patrolling; `holding` = stand still while the plant / defuse hold runs */
  objective: THREE.Vector3 | null = null;
  /** Destroy mode: the enemy objective this bot shoots when it is in front of it (game.ts destroyBots, perceive) [RECRIADO] */
  objTarget: Actor | null = null;
  holding = false;
  /** which hold it is (botBomb.ts): replicated as the torso action so the other peers play the C4 hold sound from the bot */
  holdKind: "plant" | "defuse" | null = null;
  /** shooting at somebody: the objective hold is broken */
  get inCombat(): boolean { return this.state === "combat"; }
  private path: number[] = [];
  private pathIdx = 0;
  private repathIn = 0;
  private navWarned = false;
  /** straight-line goal while no nav route exists (retried every 1.5 s) */
  private direct: THREE.Vector3 | null = null;
  private stuckCheck = 0;
  private stuckPos = new THREE.Vector3();
  private stuckCount = 0;

  private target: Actor | null = null;
  private targetVisible = false;
  private lastSeen = new THREE.Vector3();
  private lastSeenTime = -999;
  private perceiveIn = 0;
  private reaction = 0;
  private fireCd = 0;
  private burstPause = 0;
  private ammo: number;
  private reloadLeft = 0;
  private strafe = 1;
  private strafeTimer = 0;
  private aimHead = false;
  private weapon: WeaponDef;
  /** flashbang white time left (throwables.ts flashFor, same test as the player's) */
  private blindUntil = -1;
  private offFlash: () => void;

  private host: BotHost;
  readonly team: Team;

  // plain fields (no parameter properties) so Node's type stripping can load this file (scripts/dev/test-anim-states.mjs)
  constructor(host: BotHost, team: Team, id: string, skill = 0.6) {
    this.host = host;
    this.team = team;
    this.id = id;
    noteBotEquip(id); // no 5138 for an AI seat: no head item, whoever held the seat before
    const netSlot = /^slot(\d+)$/.exec(id); // online: the name follows the slot, so every peer shows the same one
    this.name = netSlot ? botNameOfSlot(Number(netSlot[1])) : `${BOT_NAMES[nameIdx++ % BOT_NAMES.length]}`;
    this.skill = skill;
    this.ai = aiRowFor(skill, id);
    this.maxHp = this.hp = this.ai.hp;
    this.weapon = BOT_WEAPON;
    this.weaponName = this.weapon.name;
    this.ammo = this.weapon.mag;

    const { world, R } = host;
    this.body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -1000, 0));
    this.collider = world.createCollider(
      R.ColliderDesc.capsule(MovementConfig.capsuleHalfHeightStand, MovementConfig.capsuleRadius).setCollisionGroups(ACTOR_COLLISION_GROUPS),
      this.body
    );
    this.collider.setEnabled(false);
    this.controller = world.createCharacterController(0.02);
    this.controller.setMaxSlopeClimbAngle((MovementConfig.maxSlopeClimbDeg * Math.PI) / 180);
    this.controller.enableAutostep(MovementConfig.maxStepHeight, 0.3, true);
    this.controller.enableSnapToGround(0.3);

    this.visual = createCharVisual(team);
    this.visual.root.visible = false;
    host.scene.add(this.visual.root);
    this.offFlash = onFlashbang((f) => this.onFlash(f));
  }

  /**
   * A flashbang went off: the exe blinds each client's own character (0x633e70); a bot runs that test for itself and,
   * [RECRIADO] (no PB AI reaction traced), sees nothing and holds fire for the white time.
   */
  private onFlash(f: FlashBurst): void {
    if (!this.alive) return;
    const eye = this.eye(new THREE.Vector3());
    const facing = new THREE.Vector3(-Math.sin(this.yawV), 0, -Math.cos(this.yawV));
    const { R, world } = this.host;
    const dur = flashFor(f, eye, facing, (o, d, len) =>
      world.castRay(new R.Ray({ x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z }), len, true, undefined, WORLD_ONLY_QUERY)?.timeOfImpact ?? null);
    if (dur > 0) this.blindUntil = Math.max(this.blindUntil, this.host.now() + dur);
  }

  /** flashed: nothing is seen */
  blind(now = this.host.now()): boolean { return now < this.blindUntil; }

  // ---- Actor ----
  feet(out: THREE.Vector3): THREE.Vector3 {
    const t = this.body.translation();
    return out.set(t.x, t.y - MovementConfig.capsuleHalfHeightStand - MovementConfig.capsuleRadius, t.z);
  }
  aimDir(out = new THREE.Vector3()): THREE.Vector3 {
    const cp = Math.cos(this.pitchV);
    return out.set(-Math.sin(this.yawV) * cp, Math.sin(this.pitchV), -Math.cos(this.yawV) * cp);
  }

  eye(out: THREE.Vector3): THREE.Vector3 {
    this.feet(out);
    out.y += this.crouch ? MovementConfig.eyeHeightCrouch : MovementConfig.eyeHeightStand;
    return out;
  }
  yaw(): number {
    return this.yawV;
  }
  isCrouching(): boolean {
    return this.crouch;
  }
  isNoisy(): boolean {
    return this.alive && !this.crouch && Math.hypot(this.vel.x, this.vel.z) > 2.5;
  }

  onDamaged(attacker: Actor | null, _dealt: number, _zone: HitZone): void {
    if (!attacker || attacker === this || !this.alive) return;
    // Turn toward whoever shot us.
    if (!this.target || !this.targetVisible) {
      this.target = attacker;
      attacker.feet(this.lastSeen);
      this.lastSeenTime = this.host.now();
      this.state = "investigate";
      this.path = [];
      this.reaction = Math.min(this.reaction, 0.2);
    }
  }

  spawn(sp: SpawnPoint, protectUntil: number): void {
    const c = sp.feet.y + MovementConfig.capsuleHalfHeightStand + MovementConfig.capsuleRadius + 0.05;
    this.body.setTranslation({ x: sp.feet.x, y: c, z: sp.feet.z }, true);
    this.body.setNextKinematicTranslation({ x: sp.feet.x, y: c, z: sp.feet.z });
    this.collider.setEnabled(true);
    this.prevFeet.set(sp.feet.x, c - MovementConfig.capsuleHalfHeightStand - MovementConfig.capsuleRadius, sp.feet.z);
    this.curFeet.copy(this.prevFeet);
    this.hp = this.maxHp;
    this.armor = 100;
    this.helmetLost = false;
    this.alive = true;
    this.invulnUntil = protectUntil;
    this.yawV = sp.yaw;
    this.pitchV = 0;
    this.crouch = false;
    this.vel.set(0, 0, 0);
    this.state = "patrol";
    this.objective = null;
    this.direct = null;
    this.holding = false;
    this.holdKind = null;
    this.path = [];
    this.target = null;
    this.targetVisible = false;
    this.ammo = this.weapon.mag;
    this.reloadLeft = 0;
    this.stuckCount = 0;
    this.zoom = false;
    this.reaction = this.ai.pre;
    this.burstT = 0;
    this.burstPause = 0;
    this.visual.root.visible = true;
    this.visual.respawn();
    this.visual.setWeapon(this.weapon.name);
    void bindWeaponAnim(this.visual.anim, this.weapon.id, undefined, this.visual.animSkel);
    this.syncVisual(0);
  }

  /** Host change: the bot goes on from the last replicated state of the old host (position, aim, hp) instead of a fresh spawn. */
  resumeAt(feet: THREE.Vector3, yaw: number, hp: number): void {
    this.spawn({ name: "resume", feet, yaw, team: this.team }, 0);
    this.hp = Math.max(1, Math.min(this.maxHp, hp));
  }

  /** What the match host replicates of this bot: the same PlayerState a player sends (net/battle.ts packs it into a slot record). */
  netState(): PlayerState {
    this.feet(_c);
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const moving = this.alive && speed > 0.15;
    const torsoAction: PlayerState["torsoAction"] = this.alive && this.holding && this.holdKind ? this.holdKind : this.firingT > 0 ? "fire" : this.reloadLeft > 0 ? "reload" : this.zoom ? "zoom" : "idle";
    return {
      id: this.id, name: this.name, team: this.team, pos: [_c.x, _c.y, _c.z], vel: [this.vel.x, this.vel.y, this.vel.z], yaw: this.yawV, pitch: this.pitchV,
      crouch: this.crouch, alive: this.alive, hp: this.alive ? this.hp : 0, weapon: this.weapon.name, weaponSlot: 0, // no weaponId: the net layer looks the item id up by name (battle.ts WEAPON_IDS)
      firing: this.firingT > 0, torsoAction, moving, running: moving && speed > 3.5, airborne: this.alive && !this.grounded,
      zoomType: this.zoom ? 2 : 0, bot: true, t: performance.now(),
    };
  }

  kill(): void {
    this.alive = false;
    this.collider.setEnabled(false);
    this.vel.set(0, 0, 0);
  }

  hide(): void {
    this.visual.root.visible = false;
  }

  dispose(): void {
    this.offFlash();
    this.host.scene.remove(this.visual.root);
    this.host.world.removeCharacterController(this.controller);
    this.host.world.removeRigidBody(this.body);
  }

  // ---- AI ----
  /** new Bomb Mission goal (null = patrol): the path is recomputed when it moves */
  setObjective(p: THREE.Vector3 | null): void {
    if (!p) { if (this.objective) { this.objective = null; this.path = []; } return; }
    if (!this.objective || this.objective.distanceTo(p) > 0.5) { this.objective = (this.objective ?? new THREE.Vector3()).copy(p); this.path = []; }
  }

  update(dt: number): void {
    const now = this.host.now();
    if (!this.alive) {
      this.driveVisual(dt, this.feet(_c));
      return;
    }
    if (!this.host.canAct()) {
      this.stepPhysics(dt, 0, 0, 0);
      this.syncVisual(dt);
      return;
    }

    this.perceiveIn -= dt;
    if (this.perceiveIn <= 0) {
      this.perceiveIn = 0.12 + Math.random() * 0.08;
      const t = performance.now();
      this.perceive(now);
      botPerf().perceive += performance.now() - t;
    }

    let wishX = 0, wishZ = 0;
    const me = this.feet(_a);
    this.firingT = Math.max(0, this.firingT - dt);

    if (this.state === "combat" && this.target) {
      const tp = this.target.feet(_b);
      const dist = Math.hypot(tp.x - me.x, tp.z - me.z);
      this.aimAt(dt, now);
      this.strafeTimer -= dt;
      if (this.strafeTimer <= 0) {
        this.strafeTimer = 0.5 + Math.random() * 1.0;
        this.strafe = Math.random() < 0.5 ? -1 : 1;
        if (Math.random() < 0.15 + this.skill * 0.15) this.strafe = 0;
      }
      this.crouchTimer -= dt;
      if (this.crouchTimer <= 0) {
        this.crouchTimer = 1 + Math.random() * 2;
        this.crouch = dist > 12 && Math.random() < 0.3;
      }
      const fx = -Math.sin(this.yawV), fz = -Math.cos(this.yawV);
      wishX = -fz * this.strafe;
      wishZ = fx * this.strafe;
      if (dist > 28) { wishX += fx; wishZ += fz; }
      else if (dist < 5) { wishX -= fx; wishZ -= fz; }
      // [RECRIADO] bots aim down sights at range (the PB AI bots' zoom rule is not decoded)
      this.zoom = dist > 20 && this.reloadLeft <= 0;
      this.fireLogic(dt, dist);
    } else {
      this.crouch = false;
      this.zoom = false;
      if (this.state === "investigate" && now - this.lastSeenTime > 7) this.state = "patrol";
      const wp = this.holding ? null : this.nextWaypoint(me, now, dt);
      if (wp) {
        wishX = wp.x - me.x;
        wishZ = wp.z - me.z;
        const want = yawTo(wishX, wishZ);
        this.yawV += angleDiff(this.yawV, want) * Math.min(1, dt * 6);
        this.pitchV *= 1 - Math.min(1, dt * 4);
      }
      this.reloadTick(dt);
      if (this.ammo < this.weapon.mag * 0.5 && this.reloadLeft <= 0 && this.state === "patrol") this.startReload();
      this.detectStuck(dt, me);
    }

    const wl = Math.hypot(wishX, wishZ);
    const ux = wl > 0 ? wishX / wl : 0, uz = wl > 0 ? wishZ / wl : 0;
    // wish direction in the actor frame (x right, z forward) -> PB direction type and speed
    const fwdX = -Math.sin(this.yawV), fwdZ = -Math.cos(this.yawV);
    const localZ = ux * fwdX + uz * fwdZ, localX = ux * -fwdZ + uz * fwdX;
    const speed = pbBotSpeed(localX, localZ, { crouch: this.crouch, zoom: this.zoom, firing: this.firingT > 0 });
    const P = botPerf(), t0 = performance.now();
    this.stepPhysics(dt, ux, uz, speed);
    const t1 = performance.now();
    this.syncVisual(dt);
    P.move += t1 - t0;
    P.visual += performance.now() - t1;
  }

  private perceive(now: number): void {
    const eye = this.eye(_eye);
    const fx = -Math.sin(this.yawV), fz = -Math.cos(this.yawV);
    let best: Actor | null = null;
    let bestD = Infinity;
    let heard: Actor | null = null;
    let heardD = Infinity;
    const blind = this.blind(now);
    for (const a of this.host.actors()) {
      if (blind) break;
      if (a === this || !a.alive || a.team === this.team) continue;
      const p = chestPoint(a, _c);
      const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > 90) continue;
      const facing = (dx * fx + dz * fz) / Math.max(1e-3, Math.hypot(dx, dz));
      const known = a === this.target && now - this.lastSeenTime < 3;
      // AICharacter SeeSight_Angle = cos of the view half-angle (-1 = all around), SeeSight_Range = sees anyone closer;
      // CGameCharaInputControlAI::FindTarget 0x97cd50 tests dot > [+0x40] or dist < [+0x44], then a world ray
      if ((facing > this.ai.ang || d < this.ai.rng || known) && d < bestD && this.los(eye, p, d)) {
        best = a;
        bestD = d;
      } else if (a.isNoisy?.() && d < 20 && d < heardD) {
        heard = a;
        heardD = d;
      }
    }
    // Destroy mode: no player in sight, so an enemy objective in front of the bot is the target (no sight ray: the bullet decides)
    if (!best && this.objTarget && !blind) {
      const p = chestPoint(this.objTarget, _c);
      const d = Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z);
      if (d <= OBJECTIVE_RANGE && (fx * (p.x - eye.x) + fz * (p.z - eye.z)) / Math.max(1e-3, Math.hypot(p.x - eye.x, p.z - eye.z)) > this.ai.ang) best = this.objTarget;
    }
    if (best) {
      if (!this.targetVisible || best !== this.target) {
        this.reaction = this.ai.pre; // AICharacter AttackTime_Pre: wait before the first shot
        this.aimHead = false; // no head aiming in the data: hits on the head come from Deviation only ([INFERIDO])
      }
      this.target = best;
      this.targetVisible = true;
      best.feet(this.lastSeen);
      this.lastSeenTime = now;
      this.state = "combat";
    } else {
      this.targetVisible = false;
      if (this.state === "combat") {
        this.state = "investigate";
        this.path = [];
      }
      if (heard && this.state === "patrol") {
        heard.feet(this.lastSeen);
        this.lastSeenTime = now;
        this.state = "investigate";
        this.path = [];
      }
    }
  }

  private los(from: THREE.Vector3, to: THREE.Vector3, dist: number): boolean {
    const { R, world } = this.host;
    const ray = (_losRay ??= new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }));
    ray.origin.x = from.x; ray.origin.y = from.y; ray.origin.z = from.z;
    ray.dir.x = (to.x - from.x) / dist; ray.dir.y = (to.y - from.y) / dist; ray.dir.z = (to.z - from.z) / dist;
    // a smoke cloud blocks the sight line like a wall (throwables.ts smokeField: the live Exp_Sm_01 particles)
    return !world.castRay(ray, dist - 0.1, true, undefined, WORLD_ONLY_QUERY) && !smokeField.blocks(from, to);
  }

  private aimAt(dt: number, now: number): void {
    if (!this.target) return;
    const eye = this.eye(_c);
    const p = this.aimHead ? headPoint(this.target, _b) : chestPoint(this.target, _b);
    // Slight sway so bots are not laser-accurate.
    const sway = (1 - this.skill) * 0.25;
    p.x += Math.sin(now * 1.7 + this.skill * 10) * sway;
    p.y += Math.sin(now * 2.3) * sway * 0.5;
    const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z;
    const wantYaw = yawTo(dx, dz);
    const wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
    const turn = (3 + this.skill * 5) * dt;
    const dyaw = angleDiff(this.yawV, wantYaw);
    this.yawV += Math.sign(dyaw) * Math.min(Math.abs(dyaw), turn * Math.max(0.3, Math.abs(dyaw)) * 2);
    this.pitchV += (wantPitch - this.pitchV) * Math.min(1, dt * (4 + this.skill * 6));
  }

  /** Character model root (for charModel.getBoneHitboxes). */
  /** the helmet on the head (world transform + model to copy) for the HELMET PROTECTION drop */
  helmetSource() {
    return this.visual.helmetSource();
  }
  /** Flinch on a bullet hit (DamageFrontLeftA / DamageBackA). Only seen in observer mode — the bot's 3PV model is
   *  hidden while it is a live opponent (bots.ts respawn/spawn hide it) — but it is driven so the death/kill cam
   *  does not show a mannequin that never reacts. */
  noteHit(h: DeathHit): void {
    this.visual.noteHit(h);
  }
  playHurt(shotDir?: THREE.Vector3): void {
    this.visual.hurt(shotDir);
  }
  /** Muzzle(s) of the last shot on the 3rd-person model: the firing hand, or both guns for a DualSMG. */
  muzzles(): THREE.Vector3[] {
    const v = this.visual;
    return v.dualMode === "both" ? [v.muzzleWorld(new THREE.Vector3(), false), v.muzzleWorld(new THREE.Vector3(), true)] : [v.muzzleWorld()];
  }
  get visualRoot(): THREE.Object3D {
    return this.visual.root;
  }

  private fireSeq = 0;
  private reloadSeq = 0;
  obsState(): ObsState {
    return { speed: Math.hypot(this.vel.x, this.vel.z), grounded: this.grounded, aiming: this.zoom, fireSeq: this.fireSeq, reloadSeq: this.reloadSeq, reloadSecs: BOT_PEF.reloadTime };
  }

  private startReload(): void {
    this.reloadSeq++;
    this.reloadLeft = BOT_PEF.reloadTime;
    this.zoom = false;
    this.visual.reload(BOT_PEF.reloadTime);
  }

  private reloadTick(dt: number): boolean {
    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 0) this.ammo = this.weapon.mag;
      return true;
    }
    return false;
  }

  private fireLogic(dt: number, dist: number): void {
    this.fireCd -= dt;
    this.reaction -= dt;
    if (this.reloadTick(dt)) return;
    if (!this.targetVisible || this.reaction > 0 || !this.target || this.blind()) return;
    // a spawn-protected target takes no damage: hold fire until its protection is over
    if (this.host.now() < this.target.invulnUntil) return;
    if (this.burstPause > 0) {
      this.burstPause -= dt;
      return;
    }
    // AICharacter AttackTime = how long a burst lasts; AttackTime_Total = the whole cycle, so the rest is Total - AttackTime
    if (this.burstT > 0) {
      this.burstT -= dt;
      if (this.burstT <= 0) {
        this.burstPause = Math.max(0, this.ai.tot - this.ai.atk);
        return;
      }
    }
    if (this.fireCd > 0) return;
    const eye = this.eye(_eye);
    const p = chestPoint(this.target, _b);
    const aimErr = Math.abs(angleDiff(this.yawV, yawTo(p.x - eye.x, p.z - eye.z)));
    if (aimErr > 0.12) return;
    // pitch lags the yaw: firing with the muzzle still at eye height (= a standing target's head) gave free headshots
    const flat = Math.hypot(p.x - eye.x, p.z - eye.z);
    if (Math.abs(this.pitchV - Math.atan2(p.y - eye.y, flat)) > 0.05) return;

    if (this.burstT <= 0) this.burstT = this.ai.atk;
    this.invulnUntil = Math.min(this.invulnUntil, this.host.now()); // firing drops spawn protection (same rule as the player)
    this.fireCd = this.weapon.fireDelay;
    this.firingT = Math.max(this.fireCd, 0.15);
    this.ammo--;
    if (this.ammo <= 0) this.startReload();

    const cp = Math.cos(this.pitchV);
    const dir = _dir.set(-Math.sin(this.yawV) * cp, Math.sin(this.pitchV), -Math.cos(this.yawV) * cp);
    // AICharacter Deviation as the cone half-angle in degrees: 45 at level 1 down to 0.5..5 at level 10 [INFERIDO unit]
    this.fireSeq++;
    this.visual.fire(); // first: a dual-wield visual picks the firing hand, botFire traces from its muzzle
    const tF = performance.now();
    this.host.botFire(this, this.weapon, eye, spreadDir(dir, this.ai.dev, _spread));
    botPerf().fire += performance.now() - tF;
  }

  private pickGoal(me: THREE.Vector3): number {
    const nav = this.host.nav;
    if (!nav) return -1;
    if (this.state === "investigate") return nav.nearest(this.lastSeen, 3);
    if (this.objective) return nav.nearest(this.objective, 3);
    const r = Math.random();
    if (r < 0.45) {
      const spawns = this.host.enemySpawns(this.team);
      if (spawns.length) return nav.nearest(spawns[Math.floor(Math.random() * spawns.length)].feet, 3);
    }
    // Random node, preferring ones not too close.
    for (let i = 0; i < 6; i++) {
      const n = nav.randomNode();
      if (n >= 0 && nav.pos(n, _c).distanceTo(me) > 15) return n;
    }
    return nav.randomNode();
  }

  private nextWaypoint(me: THREE.Vector3, now: number, dt: number): THREE.Vector3 | null {
    const nav = this.host.nav;
    if (!nav) {
      // No graph (test level): wander toward last-seen or enemy spawn directly.
      const sp = this.host.enemySpawns(this.team)[0];
      return this.state === "investigate" ? this.lastSeen : sp ? sp.feet : null;
    }
    // at the objective: nothing left to walk (Game starts the hold)
    if (this.objective && this.state !== "investigate" && Math.hypot(this.objective.x - me.x, this.objective.z - me.z) < 1.0) return null;
    this.repathIn -= dt;
    if (!this.path.length && this.direct && this.repathIn > 0) return this.direct;
    if (!this.path.length || this.pathIdx >= this.path.length || this.repathIn <= 0) {
      this.repathIn = this.state === "investigate" ? 2.5 : this.objective ? 3 : 12;
      // a spawn can sit farther than 3 cells from every node (or in a piece the graph does not link): look wider before giving up
      let start = nav.nearest(me, 3);
      if (start < 0) start = nav.nearest(me, 10);
      const goal = this.pickGoal(me);
      this.path = nav.path(start, goal) ?? [];
      this.pathIdx = 0;
      if (!this.path.length) {
        // no route: retry in 1.5 s (not every frame: the failed A* walks the whole graph) and head straight for the goal meanwhile,
        // instead of standing at the spawn for good
        this.repathIn = 1.5;
        if (!this.navWarned) { this.navWarned = true; console.warn(`[bot] ${this.id} (team ${this.team}) has no route: start node ${start}, goal node ${goal}`); }
        this.direct = goal >= 0 ? nav.pos(goal, new THREE.Vector3()) : this.objective ? this.objective.clone() : this.host.enemySpawns(this.team)[0]?.feet.clone() ?? null;
        return this.direct;
      }
      this.direct = null;
    }
    const wp = nav.pos(this.path[this.pathIdx], new THREE.Vector3());
    if (Math.hypot(wp.x - me.x, wp.z - me.z) < 0.7 && Math.abs(wp.y - me.y) < 1.4) {
      this.pathIdx++;
      if (this.pathIdx >= this.path.length) {
        if (this.state === "investigate") this.lastSeenTime = now - 5; // looked around, give up soon
        return null;
      }
      nav.pos(this.path[this.pathIdx], wp);
    }
    // Skip ahead when the node after is directly reachable (light string pulling).
    if (this.pathIdx + 1 < this.path.length) {
      const nxt = nav.pos(this.path[this.pathIdx + 1], _c);
      if (Math.abs(nxt.y - me.y) < 0.3 && Math.hypot(nxt.x - me.x, nxt.z - me.z) < 2.2) {
        this.pathIdx++;
        wp.copy(nxt);
      }
    }
    return wp;
  }

  private detectStuck(dt: number, me: THREE.Vector3): void {
    this.stuckCheck -= dt;
    if (this.stuckCheck > 0) return;
    this.stuckCheck = 1.2;
    if (me.distanceTo(this.stuckPos) < 0.4 && this.path.length) {
      this.stuckCount++;
      if (this.grounded) this.vel.y = 6; // hop over the lip
      if (this.stuckCount >= 2) {
        this.path = [];
        this.stuckCount = 0;
      }
    } else {
      this.stuckCount = 0;
    }
    this.stuckPos.copy(me);
  }

  /**
   * NOT ORIGINAL: the KCC runs at BOT_PHYS_HZ with a fixed step (staggered per bot by the
   * accumulator phase) instead of every render frame; the visual interpolates between the last two steps. AI / LOS / fire
   * keep running every frame. Speed per second is unchanged (velocity and gravity integrate with the step dt).
   */
  private stepPhysics(dt: number, wx: number, wz: number, speed: number): void {
    this.physAcc += dt;
    const n = Math.min(BOT_PHYS_MAX_STEPS, Math.floor(this.physAcc / BOT_PHYS_DT));
    if (n > 0) {
      this.physAcc = Math.min(this.physAcc - n * BOT_PHYS_DT, BOT_PHYS_DT); // a long hitch drops the rest instead of bursting
      this.prevFeet.copy(this.curFeet);
      this.move(n * BOT_PHYS_DT, wx, wz, speed);
      const nt = this.body.nextTranslation();
      this.curFeet.set(nt.x, nt.y - MovementConfig.capsuleHalfHeightStand - MovementConfig.capsuleRadius, nt.z);
    }
  }

  private move(dt: number, wx: number, wz: number, speed: number): void {
    const v = this.vel;
    // PB Movement.AccelerationTime: 0 -> full run speed in 0.2 s, linear (reduced air control kept from the old bot code)
    const maxDv = (PB_CHARA.run.front / PB_CHARA.accelerationTime) * dt * (this.grounded ? 1 : 0.2);
    const dx = wx * speed - v.x, dz = wz * speed - v.z, dl = Math.hypot(dx, dz);
    const k = dl > maxDv ? maxDv / dl : 1;
    v.x += dx * k;
    v.z += dz * k;
    v.y -= MovementConfig.gravity * dt;
    const desired = { x: v.x * dt, y: v.y * dt, z: v.z * dt };
    this.controller.computeColliderMovement(this.collider, desired, undefined, KCC_QUERY);
    const m = this.controller.computedMovement();
    this.grounded = this.controller.computedGrounded() || touchedGround(this.controller, PB_CAPSULE.maxSlopeClimbDeg);
    if (this.grounded && v.y < 0) v.y = 0;
    const t = this.body.nextTranslation();
    this.body.setNextKinematicTranslation({ x: t.x + m.x, y: t.y + m.y, z: t.z + m.z });
  }

  private syncVisual(dt: number): void {
    const root = this.visual.root;
    this.driveVisual(dt, _c.lerpVectors(this.prevFeet, this.curFeet, Math.min(1, this.physAcc / BOT_PHYS_DT)));
    // Spawn protection pulse (exe ProcessMaterial 0x8221d0)
    root.visible = true;
    this.visual.setAlpha(spawnBlinkAlpha(this.invulnUntil - this.host.now()));
  }

  private driveVisual(dt: number, feet: THREE.Vector3): void {
    this.visual.setHelmet(actorHeadgearOn(this.id, this.helmetLost));
    this.visual.update(dt, {
      pos: feet,
      yaw: this.yawV,
      pitch: this.pitchV,
      vel: this.vel,
      crouch: this.crouch,
      grounded: this.grounded,
      alive: this.alive,
      zoom: this.zoom,
    });
  }
}
