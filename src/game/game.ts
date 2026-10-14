import { lockPointer } from "../lockPointer.ts";
import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { Player } from "../player";
import { titleFxLive } from "../gameplay/titleFx";
import { Hud, type MinimapBlip } from "../hud";
import { NameTags } from "./nameTags";
import { Bot, type BotHost } from "./bots";
import { bindWeaponAnim } from "./charAnimLib";
import { createCharVisual, preloadChara, type CharVisual } from "./charModel";
import { DEAD_BODY_STATE, DEATH_BLEND_S, deathBone } from "./deathCam";
import { actorHasBeret, actorHasHelmet, actorHeadgearOn, watchRespawnEquip, type RespawnAckSource } from "./charEquip";
import { HelmetDrops } from "./helmetDrop";
import { RagdollSystem, ragdolls, setRagdollSystem } from "./ragdoll";
import { computeDamage, rangeFalloff, type RoomRule } from "./damage";
import { PB_CAMERA_SHAKE, PB_CHARA, PB_FPS_CAMERA } from "../gameplay/pbConfig";
import { DEFAULT_WATCH, WATCH, observerRules, type ObserverRules } from "../lobby/core/roomRules";
import { DEAD_TARGET_HOLD, FLY_SPEED, OBS_CAM, entryView, flyMove, hpColumns, hpFill, hpRowY, nextAfterDead, nextView, observeList, observedNickText, stepTarget, type ObsView } from "./observer";
import { ObserverHud } from "./pbHud/observerHud";
import { chat } from "../net/chatClient";
import { NICK_SIZE, PosSlots, flySpeedStep, gmAction, gmNickView, nickSizeStep } from "./observerGm";
import { KILL_MARKS, ShotKills } from "./pbHud/killmarks";
import { EscMenu } from "./escMenu";
import { BattleSocial } from "./battleSocial";
import { AwayTimer, awayRearm } from "./awayChecker";
import { AwayNotice } from "./awayNotice";
import { charaIsFemale, radioVoiceOf } from "./charGender";
import { HitColliders } from "./hitColliders";
import { blastPoints, rayVsActor } from "./hitbox";
import { explosionHits } from "../weapons/explosion";
import { botPerf } from "./perf";
import type { Input } from "./input";
import { Match, matchConfigFromUrl, type MatchConfig, type MatchPhase } from "./match";
import { NavGraph } from "./navGraph";
import { LocalNetAdapter, type DroppedSyncEvent, type HitEvent, type KillEvent, type NetAdapter, type PlayerState, type ThrowEvent, type WeaponDropEvent } from "./netAdapter";
import type { LiveGrenade } from "../weapons/grenade";
import { DropVisuals } from "./drops";
import { RadioHud } from "./radioHud";
import { PB_KEYS, pressed, slotPressed } from "./keymap";
import { findPickup, type DroppedWeapon } from "../gameplay/pbDrop";
import { radioId } from "../gameplay/pbRadio";
import { RemoteActor } from "./remoteActor";
import { CharSfx } from "./charSfx";
import { AmbientAudio } from "./audio3d";
import { soundTerrainOf } from "../weapons/terrainSound";
import { currentMapProps, propBreakInfo, propBreakSound, propSoundInfo, type MapProp } from "./mapProps";
import { loadMapMeta, type SpawnPoint } from "./spawns";
import { WEAPON_QUERY, WORLD_ONLY_QUERY, type Actor, type HitZone, type Team } from "./types";
import { BOT_WEAPON, loadWeaponSystem, PbWeaponsBridge, type ShotResult, type WeaponDef, type WeaponInput, type WeaponSystem } from "./weaponAdapter";
import { pbHelmetProtection } from "./pbSound";
import type { WeaponSystem as PbWeaponSystem } from "../weapons/WeaponSystem";
import { RespawnMenu } from "./respawnMenu";
import { charaMaxHp, loadCharaHp } from "../gameplay/charaHp";
import { jsonOnce } from "../jsonOnce";
import { RESPAWN_SLOTS, type RespawnInventory, type RespawnLoadout } from "./respawnSelect";
import { TEST_EQUIPPED } from "./testLoadout";
import { setViewmodelChara } from "../weapons/viewmodel";
import { getSettings, lookScale, onSettings } from "../gameplay/settings";
import { tOr } from "../lobby/ui/i18n";
import type { PbItemEffects } from "../weapons/types";
import type { Tint } from "../weapons/effects";
import { NICK_COLORS } from "./battleChatModel.ts";
import { isMissionWeapon } from "../weapons/mission";
import { DevMenu } from "./devMenu";
import { BOMB, BombMode, type BombInput, type Vec3 as BombVec3 } from "./bombMode";
import { barOf, isEnemyObjective, type ObjectiveSide } from "./objectives.ts";
import { BombVisual } from "./bombVisual";
import { BotBombDriver } from "./botBomb";
import { CurrentMap, MAP_LABELS } from "../config";

/** the end screen's own leave countdown (GameResult OK_Btn caption) */
const FINAL_SECONDS = 46;
/** a spawn point is blocked with another actor this close (m, horizontal: two capsules + margin) */
const SPAWN_CLEAR = 2;
/** a spawn point just handed out stays blocked this long (s) */
const SPAWN_HOLD = 4;
/** weapon.pef Bomb/C4 (2017 and 3.123): Damage, Explosion_Range, Explosion_EffectiveSlope */
const C4_BLAST = { damage: 100, range: 10, slope: 0.01 };
import { held as keyHeld } from "./keymap";
import type { RoomClient, RoundEndInfo } from "../net/roomClient";
import type { MissionClient } from "../net/missionClient";
import { missionLines, newlyDone, taskSnapshot, type TaskSnapshot } from "./pbHud/missionHud";
import { FONTS } from "../lobby/ui/assets.ts";

export interface GameDeps {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  world: RAPIER.World;
  R: typeof RAPIER;
  input: Input;
  levelName: string;
  /** Capsule-centre spawn from the level loader (fallback when collision.json has no respawns). */
  levelSpawn: THREE.Vector3;
  collisionJsonUrl: string;
  net?: NetAdapter;
  /** Net mode: team/nick come from the room slot (slot % 2), not from ?team=/?name=. */
  localTeam?: Team;
  localName?: string;
  /** patente of the local account (profile.rank): the Tab icon of the local row */
  localRank?: number;
  /** Overrides on top of matchConfigFromUrl() (net: room kill/time limits, no local round loop). */
  match?: Partial<MatchConfig>;
  /** Local round clock / kill limit ran out (net: the room leader turns this into TIMERSYNC 0). */
  onMatchEnd?: () => void;
  /** ESC menu "Sair" button (BattlePopup_Exit, same target as main.ts's #pbleave); "away" = the away kick left, not the player */
  onLeave?: (reason?: "away") => void;
  /** Respawn weapon change (T): owned items + equipped loadout (online: inventoryFromPlayer(PlayerStore)).
   *  Omitted: offline = default loadout + every weapon with a model; net = equipped loadout only. */
  respawnInventory?: RespawnInventory;
  /**
   * Equipped character itemId of the local side (chara_red_side / chara_blue_side, the RESPAWN pair 8): body shadow +
   * 1PV arms (loadout.ts resolveChara; no model -> the side's basic character). Omitted: the team default.
   */
  localChara?: number;
  /** Battle item effects of the local player (Quick Change / Quick Change Reload; loadout.ts itemEffectsOf). */
  itemEffects?: PbItemEffects;
  /** Bot room config (core bot-room step) [RECRIADO]. Omitted: ?bots=/?skill= URL params, else net.mode
   *  === "local" default of 7 bots at skill 0.6 (below). */
  botCount?: number;
  botSkill?: number;
  /** How many of the bots join the local player's team (default: half). AI rooms: 0, bots are the other team. */
  botAllies?: number;
  /** The lobby's mission cards client (one per Game connection: a second one would register its own `conn.on`): 2359 / 2361
   *  during the match feed the mission panel, the Tab list and the "Task Completed" banner. Omitted offline. */
  missions?: MissionClient;
  /** The room's mode has the left mission panel (pbHud/missionHud.ts missionPanelOn); default true. */
  missionPanel?: boolean;
  /** Clan vs clan match (boot.ts isClanMatch), passed to the HUD (hud.clanMatch). Default false. */
  clanMatch?: boolean;
  /** The room's stage type (roomType >> 2): the mission HUD's Y0 (crossScore.ts stageY0). Default 0. */
  stageType?: number;
  /** The room's rule and type (boot.ts, room info): HeadHunter / Chaos damage. Default none (no rule). */
  room?: RoomRule;
}

/**
 * 1PV vertical FOV = PB's option-menu FOV (default 70, range 35..80, exe-2017 0x68d0e7 / 0x4cec5f; the pef
 * Camera.FPS.FOV 80 is never read). ?fov=<deg> plays the option slider.
 */
const URL_FOV = (() => {
  const q = typeof location !== "undefined" ? Number(new URLSearchParams(location.search).get("fov")) : NaN;
  const P = PB_FPS_CAMERA;
  return Number.isFinite(q) && q > 0 ? Math.min(P.fovMax, Math.max(P.fovMin, q)) : null;
})();
/** ?fov=<deg> overrides the ESC menu / lobby FOV slider (gameplay/settings.ts) for quick testing. */
const baseFovNow = (): number => URL_FOV ?? getSettings().fov;

/** keys the radio menu reads (Z / X / C open a menu, digits pick an entry) */
const RADIO_MENU_CODES: readonly string[] = PB_KEYS.radio;
const RADIO_INPUT_CODES = [...RADIO_MENU_CODES, ...Array.from({ length: 10 }, (_, i) => "Digit" + i), ...Array.from({ length: 10 }, (_, i) => "Numpad" + i)];

/** 8-way move direction relative to facing (0=fwd,2=right,4=back,6=left), matching net/battle.ts moveDirFromVel
 *  (the fallback the receiving client uses when this field is absent) so the wire and the fallback never disagree. */
function moveDir8(vel: THREE.Vector3, yaw: number): number {
  if (Math.hypot(vel.x, vel.z) < 1e-3) return 0;
  const worldAngle = Math.atan2(-vel.x, -vel.z); // three.js forward = (-sin(yaw), 0, -cos(yaw))
  const rel = worldAngle - yaw;
  // yaw grows counter-clockwise, so a move to the RIGHT is a negative rel: index = -rel in 45 degree steps
  const norm = (((-rel) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return Math.round(norm / (Math.PI / 4)) % 8;
}

/** The local player as an Actor. */
class PlayerActor implements Actor {
  readonly kind = "player" as const;
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
  /** Defense Up coupons (PbItemEffects.defense) */
  defense = 0;
  weaponName = "K-2";
  lastAttacker: Actor | null = null;
  deathWeapon = "";
  deathHeadshot = false;
  deathEye = new THREE.Vector3();
  onHurt: ((attacker: Actor | null, dealt: number) => void) | null = null;

  constructor(readonly id: string, public name: string, public team: Team, readonly player: Player) {}

  feet(out: THREE.Vector3) { return this.player.getFeet(out); }
  eye(out: THREE.Vector3) { return this.player.eyePosition(out); }
  yaw() { return this.player.yaw; }
  isCrouching() { return this.player.isCrouching(); }
  isNoisy() { return this.alive && !this.player.isSilent() && this.player.speedRatio() > 0.55; }
  onDamaged(attacker: Actor | null, dealt: number, zone: HitZone) {
    this.lastAttacker = attacker;
    // CalcHitPoint 0x542cee: per-part SpeedReduction (limb = Arm, as in damage.ts)
    if (dealt > 0) this.player.onHitPart(zone === "head" ? "head" : zone === "torso" ? "body" : "arm");
    // a hit that stopped at the helmet still sprays blood on the local screen, so the blood goes before the
    // shake's `dealt <= 0` bail-out: the client paints the red frame on being shot, not on losing HP
    this.onHurt?.(attacker, dealt);
  }
}

export class Game implements BotHost {
  readonly scene: THREE.Scene;
  readonly world: RAPIER.World;
  readonly R: typeof RAPIER;
  nav: NavGraph | null = null;

  readonly camera: THREE.PerspectiveCamera;
  readonly input: Input;
  readonly hud: Hud;
  private nameTags = new NameTags();
  readonly match: Match;
  readonly net: NetAdapter;
  readonly player: Player;
  readonly me: PlayerActor;
  readonly bots: Bot[] = [];
  readonly remotes = new Map<string, RemoteActor>();
  /** net: local throws (net index per grenade) and the other players' replicated ones */
  private throwSeq = 0;
  private localThrowIdx = new WeakMap<LiveGrenade, number>();
  private remoteThrows = new Map<string, LiveGrenade>();
  /** net: own drops whose position is still streamed (SubHead.DroppedWeapon) until they come to rest */
  private dropStream = new Map<number, { x: number; y: number; z: number; at: number }>();
  weapons!: WeaponSystem;
  weaponSource: "weapons" | "adapter" = "adapter";

  private spawns: SpawnPoint[] = [];
  private bounds: { min: THREE.Vector3; max: THREE.Vector3 } | null = null;
  private hitColliders: HitColliders;
  /** Shadow-only 3rd-person body of the local player (no first-person model casts a shadow otherwise). */
  private shadowVisual!: CharVisual;
  private levelName: string;
  private time = 0;
  private respawnAt = new Map<string, number>();
  /** Respawn HUD + weapon change panel (respawnMenu.ts); null until its scenes load. */
  respawnMenu: RespawnMenu | null = null;
  private appliedLoadout: RespawnLoadout | null = null;
  private lastFire = new Map<string, number>();
  /** our hits by bullet / blast id (WeaponHitEvent.shot): Piercing Shot / Mass Kill (killmarks.ts ShotKills) */
  private shotKills = new ShotKills();
  private propBlastSeq = 0;
  private netSendIn = 0;
  private firing = false;
  private onMatchEnd: (() => void) | null;
  private onLeave: ((reason?: "away") => void) | null;
  /** respawn coupon of the local player (PbItemEffects.respawnCut) */
  private respawnCut = 0;
  /** Invincible coupon of the local player (PbItemEffects.invincibleExtra, s) */
  private invincibleExtra = 0;
  /** The battle room's rule and type: HeadHunter / Chaos damage on every hit (damage.ts ruleDamage) */
  private room: RoomRule | undefined;
  private unsubSettings: (() => void) | null = null;
  private escMenu: EscMenu | null = null;
  /** room battle chat / votes / report / bug popups (battleSocial.ts); null offline */
  private social: BattleSocial | null = null;
  private escAbort = new AbortController();
  /** in-battle away kick (awayChecker.ts): only with a leave path (onLeave), the offline ?playtest has none */
  private away = new AwayTimer();
  private awayNotice: AwayNotice | null = null;
  private awayGone = false;
  private _v = new THREE.Vector3();
  private _w = new THREE.Vector3();
  /** death camera: the look angles, driven by the mouse; the camera itself sits on the corpse's neck (deathCam) */
  private deathYaw = 0;
  private deathPitch = -0.35;
  /** the local body after death (3PV, same visual as the remotes): falls with the death clip, removed on respawn; null while alive */
  private corpse: CharVisual | null = null;
  private corpseAt = new THREE.Vector3();
  private corpseYaw = 0;
  /** camera pose of the last death-camera frame: the start of the 0.1 s blend into an observer view (DEATH_BLEND_S) */
  private deathPose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  private deathBlendT = DEATH_BLEND_S;
  private _shadowFeet = new THREE.Vector3();
  /** per-frame temporaries (callees only read them: WeaponSystem ignores origin/forward, CharSfx.playAt clones pos) */
  private _eye = new THREE.Vector3();
  private _fwd = new THREE.Vector3();
  private _stepFeet = new THREE.Vector3();
  private _botFeet = new THREE.Vector3();
  /** weapon the shadow's upper-body AI is bound to (setWeapon/bindWeaponAnim, mirrors RemoteActor.apply) */
  private shadowWeaponName = "";
  private wasReloading = false;
  private charSfx: CharSfx | null = null;
  private ambient: AmbientAudio | null = null;
  private stepDist = 0;
  private stepLeft = false;
  private wasGrounded = true;
  /** per-actor footstep tracker (bots/remotes): last feet position + accumulated distance */
  private actorSteps = new Map<string, { prev: THREE.Vector3; dist: number; left: boolean }>();
  private wasThrowReady = false;
  /** ADS (right click held): the weapon input */
  private localAiming = false;
  /** the weapon's own zoom state (sniper scope = toggle, the rest = hold): drives the shadow's Zoom stance and the wire
   *  zoomType / torsoAction "zoom". The raw button flickered the observed scope on every click of a scoped sniper. */
  private netAiming = false;
  /** torsoAction "change" window after a weapon switch (net/battle.ts torsoAction bits, ~ the Up_Change clip) */
  private changeUntil = 0;
  /** equipped character itemId (RESPAWN 5138), replicated as PlayerState.chara */
  private localChara?: number;
  /** Gender of our own character, for the voice takes that are gender-split (charSfx: MV_ / WV_ death, CH_Critical).
   *  Same resolveChara fallback the arms / model / radio voice use, so the take always matches what is drawn. */
  private myCharaIsFemale(): boolean {
    return charaIsFemale(this.localChara, this.me.team);
  }
  /** weapons on the floor (G / death drop, automatic pick-up; gameplay/pbDrop.ts) */
  drops!: DropVisuals;
  /** helmets knocked off by HELMET PROTECTION, falling / lying on the floor (helmetDrop.ts) */
  private helmetDrops!: HelmetDrops;
  /** Z / X / C radio menus + radio chat lines (gameplay/pbRadio.ts) */
  radio!: RadioHud;
  /** Bomb Mission (match.cfg.mode): plant / defuse / fuse machine + the planted C4 */
  private bomb: BombMode | null = null;
  private bombVis: BombVisual | null = null;
  private bombRoom: RoomClient | null = null;
  /** offline: game time of the next round start after a round ended */
  private nextRoundAt = 0;
  private bombFeet = new THREE.Vector3();
  /** Bomb Mission: this player sits the round out (joined after it started) and watches; the dead watch too */
  private spectating = false;
  /** end-of-match screen (GameResult): up while finalOn, leaves by itself after FINAL_SECONDS */
  /** the end-of-match screen is up: the game is frozen (no look / move / shooting), the mouse is free */
  finalOn = false;
  private finalT = 0;
  private finalTab: 0 | 1 = 0;
  private finalData: { winner: 0 | 1 | null; red: number; blue: number; slotExp: number[] | null; slotGold: number[] | null; clan: { name: string; rank: number; logo: number; points: number | null } | null } | null = null;
  private finalDone: (() => void) | null = null;
  private finalEndScreen = 8;
  private specTarget: Actor | null = null;
  private obsHud: ObserverHud | null = null;
  /** C4 hint box (CHud 0x74a300 text, shown 5 s per text): the text now, and its time left */
  private bombHint: string | null = null;
  private bombHintT = 0;
  private noSiteShown = false;
  /** the observed player's weapon shown on the first-person arms (id or name) */
  private specWeapon: string | number = "";
  /** id of the player `specWeapon` belongs to */
  private specWeaponOwner = "";
  /** index of the watched player in the observe list of the last frame (-1 = none / not listed) */
  private obsIdx = -1;
  private specFireSeq = -1;
  private specPlanting = false;
  private specPlantT = 0;
  private specReloadSeq = -1; // -1 = the watched player's counter is not known yet: the first value is taken as is, not as a reload
  private specReloadEnd = 0;
  private specReloading = false;
  private specReady = false;
  /** the last local shot was a heavy knife attack (sent with the torso "fire" window) */
  private lastHeavy = false;
  private specReloadLen = 1;
  /** observer view (Space walks them, game/observer.ts nextView), the first frame of an observing spell, and the 3 s hold on a dead target */
  private obsView: ObsView = "fps";
  private obsFirstFrame = true;
  private obsDeadT = 0;
  /** nobody of the own team is left alive: the enemy team is watchable whatever the room rule (0x76af80) */
  private obsAllyLatch = false;
  private localRank: number | undefined;
  /** ?spectate=1 (F2 launcher, offline): the local player only watches; the enemy team and its HP are watchable (test aid) */
  private offlineSpectate = false;
  /** Bomb Mission bots (bombBots): the site the carrier walks to this round, the carrier / defuser and the running hold */
  private botBomb: BotBombDriver<Bot> | null = null;
  private disposed = false;
  private unhookRoom: (() => void) | null = null;
  /** mission cards (deps.missions): the subscription and the done flags of the active card's tasks at the last push */
  private unwatchMissions: (() => void) | null = null;
  private missionTasks: TaskSnapshot | null = null;
  private obsEquipT = 0;
  /** what the PbHud hides while observing (spectateCam sets it, endObserver clears it) */
  private obsHudMode: "view" | "fly" | null = null;
  private obsYaw = 0;
  private obsPitch = 0;
  private obsSeq = new Map<string, number>();
  private flyYaw = 0;
  /** GM observer shortcuts (observerGm.ts): ?gm=1 offline, the account authLevel online; saved FLY positions, FLY speed, F5 HUD switch */
  private gmParam = false;
  private gmPos = new PosSlots();
  private flySpeed = FLY_SPEED;
  private gmHudOff = false;
  /** GM [ / ] + 1..8: the player to watch next frame (observerGm.ts pickPlayer) */
  private gmPick: string | null = null;
  /** CHud+0xddc: GM nick font size, back to 12 with every HUD (CreateHUD 0x745a2e) */
  private gmNickSize: number = NICK_SIZE.gm;
  private flyPitch = 0;
  /** FLY camera position, kept apart from the camera: the death camera rewrites camera.position every frame before the observer runs */
  private flyPos = new THREE.Vector3();
  private bombSites: { area: number; pos: BombVec3 }[] = [];
  private bombRingsOn = false;
  private devMenu: DevMenu | null = null;

  private constructor(d: GameDeps) {
    this.scene = d.scene;
    this.world = d.world;
    this.R = d.R;
    this.camera = d.camera;
    // PB FPS camera projection (PB_FPS_CAMERA): vertical FOV, pef Camera.FPS Near 0.1 / Far 300. Set before the weapon
    // system reads camera.fov as its base FOV.
    this.camera.fov = baseFovNow();
    this.camera.near = PB_FPS_CAMERA.near;
    this.camera.far = PB_FPS_CAMERA.far;
    this.camera.updateProjectionMatrix();
    this.input = d.input;
    this.levelName = d.levelName;
    this.net = d.net ?? new LocalNetAdapter();
    this.hud = new Hud();
    this.match = new Match({ ...matchConfigFromUrl(), ...d.match });
    this.onMatchEnd = d.onMatchEnd ?? null;
    this.onLeave = d.onLeave ?? null;
    this.respawnCut = d.itemEffects?.respawnCut ?? 0;
    this.invincibleExtra = d.itemEffects?.invincibleExtra ?? 0;
    this.room = d.room;
    if (d.missions) this.watchMissions(d.missions, d.missionPanel ?? true);
    this.hud.clanMatch(d.clanMatch === true);
    this.hud.setStageType(d.stageType ?? 0);
    EscMenu.create(document.getElementById("app") ?? document.body).then((m) => {
      if (this.escAbort.signal.aborted) { m.dispose(); return; } // the match ended while the scene loaded
      m.onLeave = () => this.onLeave?.();
      this.escMenu = m;
      this.wireSocialMenu();
    }).catch((err) => console.error("[game] esc menu failed to load", err));
    const netRoom = this.net.mode === "net" ? (this.net as unknown as { room?: RoomClient | null }).room ?? null : null;
    if (netRoom) {
      this.social = new BattleSocial({
        host: document.getElementById("app") ?? document.body, input: d.input, room: netRoom,
        canOpenChat: () => d.input.locked && !this.escMenu?.isOpen && !this.respawnMenu?.isOpen && !this.finalOn,
        radioMenuOpen: () => this.radio?.menu.open != null,
        onKicked: () => this.onLeave?.(), // the vote already removed the slot on the server: the normal leave path
      });
      this.wireSocialMenu();
    }
    if (this.onLeave) {
      AwayNotice.create(document.getElementById("app") ?? document.body).then((n) => {
        if (this.escAbort.signal.aborted) { n.dispose(); return; }
        this.awayNotice = n;
      }).catch((err) => console.error("[game] away notice failed to load", err));
    }
    // ESC menu open/close: real pointerlockchange + keydown listeners (not polled from update()), matching sa_web's
    // approach — a poll reads the key a tick after the browser's own Escape-exits-lock action already ran, and by
    // then the original keydown's user-activation is gone, so a poll-driven requestPointerLock() on close silently
    // fails (leaves the "Clique para jogar" blocker up forever). Doing both inline in the real event keeps it.
    document.addEventListener("pointerlockchange", () => {
      const locked = document.pointerLockElement === document.body;
      // locked again by any other path (blocker click...) while the menu is up: the menu goes away with it
      if (locked && this.escMenu?.isOpen) this.escMenu.close();
      // openMenu() first: the blocker-hide check right after must see the POST-open isOpen, not the stale false
      // from before this call (that ordering bug left the blocker covering the menu on every unlock).
      // the Escape that closed the chat field, or a report / vote / bug popup (they free the pointer): no ESC menu for those
      const modal = !!this.social?.modalOpen || !!this.social?.escConsumed();
      if (!locked && !this.escMenu?.isOpen && !this.respawnMenu?.isOpen && !this.finalOn && !modal) this.escMenu?.openMenu();
      if (!locked && this.social?.escConsumed() && !this.social.modalOpen) try { void lockPointer(); } catch { /* no gesture: the blocker click re-locks */ }
      document.getElementById("blocker")?.classList.toggle("hidden", locked || !!this.escMenu?.isOpen || !!this.respawnMenu?.isOpen || this.finalOn || modal);
    }, { signal: this.escAbort.signal });
    document.addEventListener("keydown", (e) => {
      if (this.finalOn) { // end screen: Enter / Space / Esc leave like the button
        if (e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Space" || e.code === "Escape") { e.preventDefault(); this.endFinal(); }
        return;
      }
      if (e.code !== "Escape" || this.respawnMenu?.isOpen || this.social?.chatOpen || this.social?.modalOpen || this.social?.escConsumed()) return;
      if (this.escMenu?.isOpen) this.escMenu.close();
      else if (document.pointerLockElement) document.exitPointerLock(); // -> pointerlockchange above opens it
    }, { signal: this.escAbort.signal });
    this.hitColliders = new HitColliders(d.world, d.R);
    d.scene.add(d.camera); // camera children (view model) must be in the scene graph

    this.localChara = d.localChara;
    const p = new URLSearchParams(location.search);
    const team: Team = d.localTeam ?? (p.get("team")?.toLowerCase().startsWith("b") ? 1 : 0);
    this.player = new Player(d.world, d.R, d.camera, d.levelSpawn, d.input);
    // title character families, applied once at battle start like CStageBattle::_ApplyDesignation 0x7709b0
    this.player.titleMove = { move: titleFxLive.move, jump: titleFxLive.jump, accel: titleFxLive.accel, fall: titleFxLive.fall };
    this.localRank = d.localRank;
    this.me = new PlayerActor(this.net.localId, d.localName ?? p.get("name") ?? "Você", team, this.player);
    this.me.onHurt = (attacker, dealt) => {
      this.onPlayerHurt(attacker);
      // exe 2017: hits (bullets, explosions) go through CalcHitPoint 0x542d1d (local HP dropped): SetShake(2, 2, 0, 0.1).
      // Cmd_Damage 0x78caa0 is only world / suicide damage (fall 0x7ef69a, GAMEINFO_SUICIDEDAMAGE 0xa0105a); it shakes
      // SetShake(2.5 + dmg/fullHP, 1, 0.2, 0.5) when the attacker is 0xffff and the damage is not lethal (0x78cb4d).
      if (dealt <= 0) return;
      if (attacker && attacker !== this.me) this.weapons?.hurtView?.(this.hurtFrom(attacker));
      const shake = attacker ? PB_CAMERA_SHAKE.hitPoint : this.me.hp > 0 ? PB_CAMERA_SHAKE.damage(dealt, this.me.maxHp) : null;
      this.weapons?.cameraShake?.(shake);
    };
  }

  static async create(d: GameDeps): Promise<Game> {
    const g = new Game(d);
    // Chain onto room.onRespawnAck before any await below: BATTLE_RESPAWN_ACK (5138) for the match's first spawns
    // can already be in flight once `g.net`/`room` exist, and a respawnAck that arrives before this is wired is
    // dropped silently (RoomClient only invokes a handler if one is set) - the local map/weapon loads used to run
    // first, so round 1 systematically missed every actor's head/face/beret AND the local `head` flag itself,
    // leaving the HUD helmet icon off and Helmet Protection never rolling until a resync (leave + rejoin).
    watchRespawnEquip((g.net as unknown as { room?: RespawnAckSource | null }).room);
    setViewmodelChara(d.localChara, g.me.team); // before the Viewmodel (WeaponSystem) loads its arms
    const [meta, ws] = await Promise.all([loadMapMeta(d.collisionJsonUrl, d.levelSpawn), loadWeaponSystem({
        scene: d.scene,
        camera: d.camera,
        world: d.world,
        R: d.R,
        filterGroups: WEAPON_QUERY,
        resolveTarget: (c) => g.hitColliders.resolve(c),
        damageProp: (c, dmg) => g.damageMapProp(c.handle, dmg, g.me),
        blastProps: (pos, radius, dmg, local, weapon) => g.blastMapProps(pos, radius, dmg, local ? g.me : null, undefined, weapon),
        ownCollider: () => g.player.collider,
        selfTarget: () => (g.me.alive ? { hitzone: "torso", id: g.me.id, hasHelmet: g.me.helmet, data: g.me } : null),
        // Claymore trigger (WeaponSystem.updateMines): living characters of the other team; bots and remotes are Actors too
        isEnemy: (t) => { const a = t.data as Actor | undefined; return !!a && a.alive && a.team !== g.me.team; },
        // recoil reaches the camera in the same frame (the player posed it before the weapons ran): no 1-frame lag
        // between the kick, the scope overlay and the laser dot
        applyLook: (dp, dy) => { g.player.addLook(dp, dy); g.player.updateCamera(); },
        getYaw: () => g.player.yaw,
        isFemale: () => g.myCharaIsFemale(),
      }),
      preloadChara(d.localChara, g.me.team),
    ]);
    g.spawns = meta.spawns;
    g.bounds = meta.bounds;
    g.weapons = ws.system;
    g.weaponSource = ws.source;
    // ESC menu / lobby FOV slider: re-anchor the non-aiming FOV live (URL_FOV keeps overriding for dev testing).
    g.unsubSettings = onSettings((s) => { if (URL_FOV === null) g.weapons.setBaseFov?.(s.fov); });
    if (ws.system instanceof PbWeaponsBridge) {
      ws.system.ws.setItemEffects(d.itemEffects ?? {});
      ws.system.ws.ownMuzzleTint = () => g.muzzleTintOfId(g.net.localId);
      // offline ?play: first life with the test loadout (testLoadout.ts, same list as the respawn panel)
      if (g.net.mode === "local" && !d.respawnInventory) {
        const { primary, secondary, melee, grenade, special } = TEST_EQUIPPED;
        ws.system.ws.setLoadout({ primary, secondary, melee, grenade, special });
      }
    }
    g.shadowVisual = createCharVisual(g.me.team, { shadowOnly: true, itemId: d.localChara, equipActor: g.net.localId });
    d.scene.add(g.shadowVisual.root);
    const pbw = g.pbWeapons();
    if (pbw) {
      g.charSfx = new CharSfx(d.scene, pbw.audio.listener);
      // map ambient zones (pb-extract-tools export-ambient2017.mjs); Madness clips off: the web has no Madness mode yet
      g.ambient = new AmbientAudio(d.scene, pbw.audio.listener, "/assets", false);
      void g.ambient.loadMap(CurrentMap);
    }
    console.info(`[game] weapons: ${ws.source}, spawns: ${g.spawns.length} (red ${g.spawns.filter((s) => s.team === 0).length})`);

    g.drops = new DropVisuals(d.scene, d.world, d.R, true, g.net.dropMaxIndex);
    g.helmetDrops = new HelmetDrops(d.scene, d.world, d.R);
    setRagdollSystem(new RagdollSystem(d.world, d.R));
    g.helmetDrops.onBounce = (p, handle) => g.charSfx?.helmetBounce(p, soundTerrainOf(handle));
    g.radio = new RadioHud(document.getElementById("app") ?? document.body);
    g.wireWeapons();
    g.wireNet();
    g.match.onKill((k) => {
      g.hud.killfeed(k, g.me.id);
      if (k.killer === g.me && k.victim !== g.me && k.killer.team !== k.victim.team) {
        g.hud.registerOwnKill({ headshot: k.headshot, victimId: k.victim.id, weapon: k.weapon, ...g.shotKills.kill(k.victim.id), victimStreak: k.victimStreak ?? 0 });
      }
    });
    g.match.onPhase((ph) => g.onPhase(ph));
    const mapProps = currentMapProps();
    if (mapProps) mapProps.onAmbient = (p, s) => g.pbWeapons()?.audio.playAt(`objects/${s.clip}`, p.center, { info: propSoundInfo(s) });
    if (mapProps) mapProps.onBreak = (p, remote) => { g.propBroken(p); if (!remote) g.net.sendPropBreak?.(p.index); if (!remote && g.propBreaker) g.propExplosionHurt(g.propBreaker, p); };
    g.match.addActor(g.me);

    const params = new URLSearchParams(location.search);
    const botParam = params.get("bots");
    g.offlineSpectate = g.net.mode === "local" && params.has("spectate");
    g.gmParam = params.has("gm");
    if (g.offlineSpectate) g.spectating = true;
    if ((g.net as unknown as { room?: { gmObserver?: boolean } | null }).room?.gmObserver) g.spectating = true; // joined as a GM observer (room checkbox)
    const maxBots = g.offlineSpectate ? 16 : 15; // spectator: 8 v 8 without the local player
    const total = d.botCount !== undefined ? Math.max(0, Math.min(maxBots, d.botCount))
      : botParam !== null ? Math.max(0, Math.min(maxBots, Number(botParam) || 0)) : g.net.mode === "local" ? 7 : 0;
    const skill = d.botSkill !== undefined ? Math.max(0.1, Math.min(1, d.botSkill))
      : Math.max(0.1, Math.min(1, Number(params.get("skill") ?? "0.6") || 0.6));
    const alliesUrl = params.get("allies"); // ?allies=N: how many of the bots are on your team (0 = all enemies)
    const allies = Math.max(0, Math.min(total, d.botAllies ?? (alliesUrl !== null ? Number(alliesUrl) || 0 : Math.floor(total / 2))));
    // only bots read g.nav (bots.ts) and they are only created here: no bots = no graph (outpost 23 s, s_twotowers 136 s)
    if (total > 0 && meta.bounds) {
      // Let the physics query pipeline see the freshly created trimesh before probing.
      d.world.step();
      // baked offline (pb-extract-tools bake-navgraph.mjs): the same graph NavGraph.build makes, in ms instead of 1.6-136 s; builds live when there is none
      g.nav = await NavGraph.load(d.collisionJsonUrl.replace(/collision\.json$/, "navgraph.bin"), d.world, d.R, meta.bounds, g.spawns.map((s) => s.feet));
      if (g.nav.size < 20) g.nav = null;
    } else console.info(`[nav] skipped (${total} bots)`);
    g.botSkill = skill;
    // Online AI room: the bots exist ONCE, in the P2P match host (its AI, its RNG), and reach the others as slot records
    // (net/battle.ts sendBotStates -> RemoteActor); a guest builds none, only the nav graph above so it can take over on a host change.
    // Offline: `bot<i>` ids, all local as before.
    const online = g.net.mode === "net";
    if (!online || g.net.isBotHost) {
      const teams = Array.from({ length: total }, (_, i) => (i < allies ? g.me.team : 1 - g.me.team) as Team);
      const slots = online ? g.net.allocBotSlots?.(teams) ?? [] : null;
      if (slots && slots.length < total) console.warn(`[bots] only ${slots.length} of ${total} bot slots free in the room`);
      for (let i = 0; i < (slots ? slots.length : total); i++) {
        const team = slots ? ((slots[i] % 2) as Team) : teams[i];
        g.addBot(new Bot(g, team, slots ? `slot${slots[i]}` : `bot${i}`, skill * (0.8 + Math.random() * 0.4)));
      }
    }
    // max HP of the equipped character (server CharaStructure table, same as the P2P host): Reinforced ones get more
    await loadCharaHp();
    // HP Up coupons: + 5% / 10% of the character's max HP [INFERIDO rounding]
    g.me.maxHp = Math.round(charaMaxHp(d.localChara) * (1 + (d.itemEffects?.hpUp ?? 0)));
    g.me.defense = d.itemEffects?.defense ?? 0;
    if (g.match.cfg.mode === "BOMB") await g.initBomb();
    if (g.match.cfg.mode === "DESTROY" || g.match.cfg.mode === "DEFENCE") g.initDestroy();
    if (g.match.cfg.mode === "ANNIHILATION" || g.match.cfg.mode === "ACE") g.initRounds();
    g.initDevMenu(); // [TEMP] open to everyone while testing; later GM only
    g.spawnEveryone();
    void RespawnMenu.create(document.getElementById("app") ?? document.body, {
      inventory: d.respawnInventory,
      equippedOnly: g.net.mode === "net",
      weaponsFlag: g.net.weaponsFlag,
      stage: g.net.stage,
    }).then((m) => {
      if (g.escAbort.signal.aborted) { m.dispose(); return; } // the match ended while it loaded
      g.respawnMenu = m;
    }).catch((err) => console.warn("[game] respawn menu", err));
    return g;
  }

  /** skill the room's AI runs at (the bots built here, and the ones adopted after a host change) */
  private botSkill = 0.6;
  private botHostUnsub: (() => void) | null = null;

  private addBot(bot: Bot): void {
    this.bots.push(bot);
    this.match.addActor(bot);
    this.hitColliders.remove(bot.id); // a RemoteActor copy of the same slot (host change)
    this.hitColliders.add(bot);
  }

  /**
   * This client became the match host mid-battle (the old one left / handed the room over): take the room's bots over from the
   * last states the old host replicated (position, aim, hp, dead or alive). A dead bot respawns on its normal timer.
   */
  private adoptBots(): void {
    const snaps = (this.net.botSnapshot?.() ?? []).filter((s) => !this.bots.some((b) => b.id === s.id));
    this.net.claimBots?.(snaps.map((s) => Number(s.id.slice(4))));
    for (const st of snaps) {
      const copy = this.remotes.get(st.id);
      if (copy) { copy.dispose(); this.remotes.delete(st.id); } // the match keeps its score row (addBot only replaces the actor)
      const bot = new Bot(this, st.team, st.id, this.botSkill);
      this.addBot(bot);
      if (st.alive) bot.resumeAt(new THREE.Vector3(st.pos[0], st.pos[1], st.pos[2]), st.yaw, st.hp);
      else this.respawnAt.set(bot.id, this.time + this.respawnDelayOf(bot));
    }
    // Bomb Mission: carry on the plant / defuse the old host's bots were holding (the bomb itself lives on the server and every peer)
    this.botBomb = this.bomb ? this.makeBotBomb(this.bomb) : null;
    console.info(`[bots] host change: adopted ${snaps.length} bot(s)`);
  }

  /** The match host moved elsewhere: our bots stop (their states now come from the new host and become RemoteActors). */
  private releaseBots(): void {
    for (const b of this.bots) {
      this.hitColliders.remove(b.id);
      this.respawnAt.delete(b.id);
      b.dispose();
    }
    if (this.bots.length) console.info(`[bots] host change: released ${this.bots.length} bot(s)`);
    this.bots.length = 0;
    this.botBomb = null;
    this.net.releaseBots?.();
  }

  // ---- BotHost ----
  now(): number {
    return this.time;
  }
  canAct(): boolean {
    return this.match.live;
  }
  *actors(): Iterable<Actor> {
    yield this.me;
    yield* this.bots;
    yield* this.remotes.values();
  }
  enemySpawns(team: Team): SpawnPoint[] {
    return this.spawns.filter((s) => s.team !== team);
  }
  /** the raw PB WeaponSystem (PbWeaponsBridge.ws), for audio hooks that don't fit the WeaponSystem interface. */
  private pbWeapons(): PbWeaponSystem | null {
    return this.weapons instanceof PbWeaponsBridge ? this.weapons.ws : null;
  }

  botFire(shooter: Bot, w: WeaponDef, origin: THREE.Vector3, dir: THREE.Vector3): void {
    this.lastFire.set(shooter.id, this.time);
    const hit = this.shoot(shooter, origin, dir, w.range * 1.5);
    if (hit.colliderHandle !== undefined && !hit.actorId && hit.distance <= w.range) this.damageMapProp(hit.colliderHandle, w.damage, shooter);
    // tracer(s) from the 3rd-person gun that fired (dual wield: that hand, DualSMG: both guns)
    const muzzles = shooter.muzzles();
    const muzzle = this._w.copy(muzzles[0]);
    const pbw = this.pbWeapons();
    const def = pbw?.db.def(w.id);
    if (def) pbw?.audio.fireAt(def, muzzle, shooter.id);
    if (def && def.family !== "KNIFE" && def.family !== "GRENADE") this.grazeMe(shooter, origin, dir, w.range);
    // the PB effects of a 3rd-person shot (flash / tracer / impact or blood); a bot watched in FPS: from the arms' muzzle, no 3PV flash
    const fps = pbw && this.watchedInFps(shooter) ? pbw.observedMuzzle(new THREE.Vector3()) : null;
    if (pbw && def) (fps ? [fps] : muzzles).forEach((m, i) => pbw.worldShot(def.id, m, hit.point, i === 0 && hit.distance < Infinity
      ? { normal: hit.normal, actor: !!hit.actorId, colliderHandle: hit.colliderHandle } : null, { flash: !fps }));
    if (hit.actorId) {
      const target = this.actorById(hit.actorId);
      if (target) this.applyHit(shooter, target, w.name, w.damage, w.helmetPenetrate, hit.zone ?? "torso", rangeFalloff(hit.distance, w.range, w.dpdRate), hit.point);
    }
  }

  /**
   * Bullet whiz past the local character (Cross exe fire collision 0x603e20): a bullet weapon's ray (0x5b2150) that meets the local
   * character (g_pPlayer 0xd85d7c) within the weapon range (0x6040fe) plays WM_Hit_GrazeBullet_1..3 at that point (0x6048b1), once
   * per shot (+0xe10). The shape is the movement capsule [INFERIDO: the exe raycasts collision group 4 / 3, not decoded].
   */
  private grazeMe(shooter: Actor, origin: THREE.Vector3, dir: THREE.Vector3, range: number): void {
    if (shooter === this.me || !this.me.alive) return;
    const ray = new this.R.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z });
    const t = this.me.player.collider.castRay(ray, range, true);
    if (t >= 0) this.pbWeapons()?.audio.graze(origin.clone().addScaledVector(dir, t));
  }

  // ---- Breakable map objects (mapProps.ts) ----
  /** a bullet hit the map collider `handle`: hurt the breakable prop it belongs to; true when it just broke (bullet goes on) */
  /** who is breaking props right now: an exploding barrel / car hurts actors only from the breaker's own client (like a grenade) */
  private propBreaker: Actor | null = null;
  /** weapon that broke the prop: a grenade / C5 blast names its own item, a bullet is the breaker's weapon (null) */
  private propWeapon: string | null = null;

  /** `by` = whose bullet: me or a bot (both simulated here); null = a remote player's mirrored shot (their client does the damage) */
  private damageMapProp(handle: number, dmg: number, by: Actor | null): boolean {
    this.propBreaker = by;
    try { return currentMapProps()?.damage(handle, dmg)?.broke ?? false; } finally { this.propBreaker = null; }
  }

  private blastMapProps(pos: THREE.Vector3, radius: number, dmg: number, by: Actor | null, slope?: number, weapon?: string): void {
    this.propBreaker = by;
    this.propWeapon = weapon ?? null;
    try { currentMapProps()?.blast(pos, radius, dmg, slope); } finally { this.propBreaker = null; this.propWeapon = null; }
  }

  /**
   * i3ActionExplosion of a barrel / car that just broke: actors within its range take damage * (1 - d / range) with a line of
   * sight check, through applyHit like a grenade (a remote victim's own client applies it). Field order and range are [INFERIDO].
   * Kill feed weapon = the one that broke the prop (grenade / C5 by name, else the breaker's weapon): the reference server
   * credits the WeaponId of the hit packet on CharaDeath.OBJECT_EXPLOSION;
   * the exe's own pick is not decoded [INFERIDO]. The name rides the HitEvent (battle.ts hitWeaponId) to the victim's client.
   */
  private propExplosionHurt(by: Actor, p: MapProp): void {
    const ex = p.def.explosion;
    if (!ex || ex.damage <= 0 || ex.range <= 0) return;
    const at = p.center, chest = new THREE.Vector3(), dir = new THREE.Vector3();
    const weapon = this.propWeapon ?? by.weaponName;
    const blast = `prop${++this.propBlastSeq}`; // OBJECT_EXPLOSION: one blast, Mass Kill for 2+ victims (ShotKills)
    for (const a of [...this.actors()]) {
      if (!a.alive) continue;
      a.feet(chest).y += 1;
      const d = chest.distanceTo(at);
      if (d >= ex.range) continue;
      dir.copy(chest).sub(at).normalize();
      const wall = this.world.castRay(new this.R.Ray({ x: at.x, y: at.y, z: at.z }, { x: dir.x, y: dir.y, z: dir.z }), d, true, undefined, WORLD_ONLY_QUERY);
      if (wall && wall.timeOfImpact < d - 0.3) continue; // the prop's own broken colliders are gone; the map blocks
      const dmg = Math.round(ex.damage * (1 - d / ex.range));
      if (dmg <= 0) continue;
      if (by === this.me) this.shotKills.hit(a.id, blast, true);
      this.applyHit(by, a, weapon, dmg, 0, "torso", 1, chest.clone(), true);
    }
  }

  /**
   * i3ActionEmitEffect + i3ActionPlaySound of the object's .i3Obj. Effect names are Effect_High stems (weaponfx.json),
   * sounds Sound_Object_* wavs (pb-extract-tools export-break-sfx.mjs). Glass objects carry no i3Sound: OB_Glass_Big_Explosion [INFERIDO].
   */
  private propBroken(p: MapProp): void {
    const pbw = this.pbWeapons();
    if (!pbw) return;
    const up = new THREE.Vector3(0, 1, 0);
    for (const n of p.def.breakEffects ?? []) if (pbw.effects.play(n, p.center, up)) break;
    const snd = propBreakSound(p.def);
    if (snd) pbw.audio.playAt(`objects/${snd}`, p.center, { info: propBreakInfo(p.def) });
  }

  // ---- Shooting / damage ----
  actorById(id: string): Actor | null {
    if (id === this.me.id) return this.me;
    return this.bots.find((b) => b.id === id) ?? this.remotes.get(id) ?? null;
  }

  /** World ray + analytic hitboxes; closest wins. Shooter is excluded. */
  shoot(shooter: Actor, origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): ShotResult {
    const ray = new this.R.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z });
    const wh = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, WORLD_ONLY_QUERY);
    let dist = wh ? wh.timeOfImpact : Infinity;
    let normal: THREE.Vector3 | null = wh ? new THREE.Vector3(wh.normal.x, wh.normal.y, wh.normal.z) : null;
    let colliderHandle: number | undefined = wh?.collider.handle;
    let actorId: string | null = null;
    let zone: HitZone | null = null;
    for (const a of this.actors()) {
      if (a === shooter || !a.alive) continue;
      const h = rayVsActor(origin, dir, Math.min(dist, maxDist), a);
      if (h && h.distance < dist) {
        dist = h.distance;
        actorId = a.id;
        zone = h.zone;
        normal = null;
        colliderHandle = undefined;
      }
    }
    const point = origin.clone().addScaledVector(dir, Number.isFinite(dist) ? dist : maxDist);
    return { point, normal, distance: dist, actorId, zone, colliderHandle };
  }

  /**
   * The hit `target` may die of, for its ragdoll push and death clip (charModel.noteHit, ragdoll.ts): a bullet goes from
   * `from` (the shooter's eye when not given) to `point`; a blast from its centre to the victim.
   */
  private noteDeathHit(attacker: Actor | null, target: Actor, weapon: string, base: number, zone: HitZone, point: THREE.Vector3, from?: THREE.Vector3 | null, explosion?: boolean): void {
    if (!target.noteHit) return;
    const st = this.pbWeapons()?.db.find(weapon);
    const src = from ?? (attacker && attacker !== target ? attacker.eye(new THREE.Vector3()) : null);
    if (!src) return;
    const dir = point.clone().sub(src);
    if (dir.lengthSq() < 1e-8) return;
    target.noteHit({ dir: dir.normalize(), point: point.clone(), head: zone === "head", damage: st?.damage ?? base, classType: st?.classType ?? 0,
      explosion: explosion ?? (st?.family === "GRENADE" || weapon === "C4") });
  }

  private applyHit(attacker: Actor, target: Actor, weapon: string, base: number, pen: number, zone: HitZone, falloff: number, point: THREE.Vector3, preScaled = false, from?: THREE.Vector3, explosion?: boolean): void {
    this.noteDeathHit(attacker, target, weapon, base, zone, point, from, explosion);
    if (target.kind === "remote") {
      // Client-authoritative: tell the victim's client; it applies damage and reports the kill.
      const now = this.time;
      const wasAlive = target.alive;
      const res = computeDamage({ target, attacker, base, zone, helmetPenetrate: pen, falloff, preScaled, now, room: this.room }); this.match.addDamage(attacker.id, res.dealt);
      // the victim's own state decides death: a predicted kill here would flip alive false -> true on the next state,
      // which RemoteActor.apply reads as a respawn (spawn-protection blink + helmet back on the head next to the dropped one)
      target.alive = wasAlive;
      const ev: HitEvent = { attackerId: attacker.id, victimId: target.id, weapon, zone, baseDamage: base, preScaled, helmetPenetrate: pen, falloff, point: [point.x, point.y, point.z], t: now, helmetBlocked: res.helmetBlocked };
      this.net.sendHit(ev);
      // shooter side: the remote victim's helmet flies off here too; its banner + voice are the victim's own
      if (res.helmetBlocked) this.popHelmet(target, attacker);
      else this.popBeret(target, attacker, zone, res.blocked);
      // The victim is client-authoritative, so nothing downstream reports the hit back to us: the flinch and the
      // hurt grunt have to be played HERE or the target stands there stiff while the blood sprays. Its state (hp,
      // alive) is the victim's to decide, but the reaction to a bullet we ourselves landed is ours to draw.
      if (res.dealt > 0) {
        target.playHurt?.(this.hitDir(attacker, target));
        this.charSfx?.hurt(target.feet(new THREE.Vector3()), zone === "head", target === this.me);
      }
      if (attacker === this.me) this.hud.hitmarker(zone === "head" ? "head" : "hit");
      return;
    }
    this.applyHitLocal(attacker, target, weapon, base, pen, zone, falloff, point, preScaled, false);
  }

  /** The damage of a hit lands on an actor this client owns (itself, or a bot it hosts). `fromNet`: a remote player's hit on our bot. */
  private applyHitLocal(attacker: Actor, target: Actor, weapon: string, base: number, pen: number, zone: HitZone, falloff: number, point: THREE.Vector3, preScaled: boolean, fromNet: boolean): void {
    const res = computeDamage({ target, attacker, base, zone, helmetPenetrate: pen, falloff, preScaled, now: this.time, room: this.room }); this.match.addDamage(attacker.id, res.dealt);
    // online AI room: the other peers see a hit of ours on a bot as a hit on its slot (helmet pop, kill-feed weapon)
    if (!fromNet && target.kind === "bot" && this.net.mode === "net") {
      this.net.sendHit({ attackerId: attacker.id, victimId: target.id, weapon, zone, baseDamage: base, preScaled, helmetPenetrate: pen, falloff, point: [point.x, point.y, point.z], t: this.time, helmetBlocked: res.helmetBlocked });
    }
    if (res.blocked) return;
    // a head hit on a helmet knocks it off; HELMET PROTECTION (banner + voice) only for the local victim it saved
    if (res.helmetBlocked) {
      this.popHelmet(target, attacker);
      if (target === this.me && res.dealt === 0) this.helmetProtection(attacker);
    }
    if (!res.helmetBlocked) this.popBeret(target, attacker, zone, false);
    target.onDamaged?.(attacker, res.dealt, zone);
    // the 3PV flinch (Damage* upper state) — the victim's own client cannot send it back, so whoever lands the hit
    // plays it on the model it sees. Local player has no 3PV body (first-person viewmodel), hence the optional call.
    if (res.dealt > 0) target.playHurt?.(this.hitDir(attacker, target));
    // head grunt for any victim; CH_Critical + MV_Heart_Beat only for the local victim (0x78cd2d / 0x78cd67)
    if (res.dealt > 0) this.charSfx?.hurt(target.feet(new THREE.Vector3()), zone === "head", target === this.me);
    if (target === this.me) this.charSfx?.ownHurt(target.feet(new THREE.Vector3()), this.myCharaIsFemale(), target.hp, res.dealt);
    if (target === this.me && res.dealt > 0) this.pbWeapons()?.blastHurt(weapon);
    if (attacker === this.me) this.hud.hitmarker(res.killed ? "kill" : res.headshot ? "head" : "hit");
    if (res.killed) this.onDeath(target, attacker, weapon, res.headshot);
  }

  /** Respawn time of an actor: RespawnTime, cut by the local player's respawn coupon (loadout.ts RESPAWN_CUT_ITEMS). */
  private respawnDelayOf(a: Actor): number {
    if (a instanceof Bot) return a.ai.resp; // AICharacter RespawnTime (3 s at levels 1-5, 2 s above)
    const cut = a === this.me ? this.respawnCut : 0;
    return this.match.cfg.respawnDelay * Math.max(0, 1 - cut);
  }

  /** I3_TERRAIN_TYPE under a point (ray down 1.8 m), for the footstep / jump / land sound; CONCRETE = unknown (terrainSound.ts) */
  private surfaceUnder(feet: THREE.Vector3): number {
    const ray = new this.R.Ray({ x: feet.x, y: feet.y + 0.2, z: feet.z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, 1.8, true, undefined, WORLD_ONLY_QUERY);
    return soundTerrainOf(hit?.collider.handle);
  }

  private onDeath(victim: Actor, killer: Actor | null, weapon: string, headshot: boolean): void {
    victim.alive = false;
    victim.hp = 0;
    this.match.registerKill({ killer, victim, weapon, headshot, time: this.time });
    // Bomb Mission: nobody respawns inside a round (the next round spawns everyone)
    if (!this.bomb) this.respawnAt.set(victim.id, this.time + this.respawnDelayOf(victim));
    this.deathDrop(victim);
    // Death voice by gender: MV_Hit_Death / WV_Hit_Death (Sound_voice_{Man,Woman}.i3Pack), the fall variant
    // MV/WV_Hit_Downfall for a fall to the death (weapon). Was disabled on the grounds that MV_Hit_Death is
    // the 2017 Kaybo take and not the 3.123 BR one — but this whole folder comes from the 2017 packs, so the rule
    // only ever silenced a file that had no 3.123 counterpart to be more faithful to.
    this.charSfx?.death(victim.feet(new THREE.Vector3()), weapon === "Queda",
      victim === this.me ? this.myCharaIsFemale() : charaIsFemale(victim.chara, victim.team), victim === this.me);
    if (victim === this.me) {
      this.me.deathWeapon = weapon;
      this.me.deathHeadshot = headshot;
      this.me.lastAttacker = killer;
      this.hud.ownDeath(killer && killer !== this.me ? killer.id : null);
      this.player.eyePosition(this.me.deathEye);
      this.player.setCollisionEnabled(false);
      this.deathYaw = this.player.yaw;
      this.deathPitch = -0.35;
      this.spawnCorpse(killer, weapon, headshot);
      this.deathBlendT = 0;
      const ev: KillEvent = { killerId: killer?.id ?? null, victimId: victim.id, weapon, headshot, t: performance.now() };
      this.net.sendKill(ev);
    } else if (victim instanceof Bot) {
      victim.kill();
      // online: the dead state of the slot carries the killer, every peer turns it into the kill
      if (this.net.mode === "net") this.net.sendBotKill?.({ killerId: killer?.id ?? null, victimId: victim.id, weapon, headshot, t: performance.now() });
    }
  }

  /**
   * The local body after death: a 3PV character of the local loadout, dying with the clip of the shot that killed it, the same
   * way the remotes die (RemoteActor.playDeath). Its bones carry the death camera (deathCam). Killed by nobody (fall, C4,
   * debug): the clip picks the front.
   */
  private spawnCorpse(killer: Actor | null, weapon: string, headshot: boolean): void {
    this.dropCorpse();
    const feet = this.me.feet(new THREE.Vector3());
    const c = createCharVisual(this.me.team, { itemId: this.localChara, equipActor: this.net.localId });
    this.corpseAt.copy(feet);
    this.corpseYaw = this.player.yaw;
    c.update(0, { pos: feet, yaw: this.corpseYaw, pitch: 0, crouch: false, grounded: true, alive: true });
    const point = this.me.eye(new THREE.Vector3());
    let dir: THREE.Vector3 | null = killer && killer !== this.me ? point.clone().sub(killer.eye(new THREE.Vector3())) : null;
    if (dir && dir.lengthSq() > 1e-8) dir.normalize();
    else dir = null;
    if (dir) {
      const st = this.pbWeapons()?.db.find(weapon);
      c.noteHit({ dir, point, head: headshot, damage: st?.damage ?? 0, classType: st?.classType ?? 0, explosion: st?.family === "GRENADE" || weapon === "C4" });
    }
    c.die(dir ?? undefined, false);
    this.scene.add(c.root);
    this.corpse = c;
  }

  private dropCorpse(): void {
    this.corpse?.dispose();
    this.corpse = null;
  }

  /**
   * Death drop (CGameCharaManager::DeathHuman 0x57364e): the weapon in hand falls when it is a primary / secondary, written
   * by the dying player's own client (online the remote's drop arrives as its DropWeapon event). Offline bots drop their
   * rifle too (the host writes the drop for AI characters in the same function).
   */
  private deathDrop(victim: Actor): void {
    if (victim === this.me) {
      const d = this.pbWeapons()?.dropCurrent(true);
      if (d) this.localDrop(d.def.id, d.slot, d.ammo, d.reserve, true);
    } else if (victim instanceof Bot && this.net.mode === "local" && this.drops) {
      this.drops.spawn({ weaponId: BOT_WEAPON.id, slot: 0, ammo: BOT_WEAPON.mag, extra: 0, reserve: BOT_WEAPON.reserve, owner: victim.id, local: true, death: true },
        victim.feet(new THREE.Vector3()), victim.yaw());
    }
  }

  /** A drop by the local player (G or death): on the floor here + DropWeapon to the room. */
  private localDrop(weaponId: number, slot: number, ammo: number, reserve: number, death: boolean): void {
    if (slot > 1 || !this.drops) return;
    const feet = this.me.feet(new THREE.Vector3());
    const d = this.drops.spawn({ weaponId, slot: slot as 0 | 1, ammo, extra: 0, reserve, owner: this.me.id, local: true, death }, feet, this.player.yaw);
    this.net.sendDrop?.({ actorId: this.me.id, weaponId, slot: d.slot, ammo, extra: 0, reserve, death, idx: d.idx, pos: [feet.x, feet.y, feet.z], yaw: this.player.yaw });
    if (this.net.sendDropped) this.dropStream.set(d.idx, { x: NaN, y: NaN, z: NaN, at: -1 });
  }

  /** A head hit knocks a worn beret off (no helmet item, so no roll and no damage change); once per life. */
  private popBeret(target: Actor, attacker: Actor | null, zone: HitZone, blocked: boolean): void {
    if (blocked || zone !== "head" || target.helmetLost || target.helmet) return;
    if (!actorHasBeret(target.id)) return;
    target.helmetLost = true;
    this.popHelmet(target, attacker);
  }

  /** The helmet `target` wore flies off its head (its own equip GLB) along the shot and falls (helmetDrop.ts). */
  private popHelmet(target: Actor, attacker: Actor | null): void {
    const src = target === this.me ? this.shadowVisual.helmetSource() : target.helmetSource?.();
    if (!src) return;
    const dir = attacker ? target.feet(new THREE.Vector3()).sub(attacker.feet(this._v)) : null;
    this.helmetDrops.spawn(src, dir);
    // AddEquipHitEffect 0x68ff30: the victim's own client hears the Defence take, everyone else the Attack one
    const at = new THREE.Vector3().setFromMatrixPosition(src.matrix);
    if (target === this.me) this.charSfx?.helmetDefence(at); else this.charSfx?.helmetAttack(at);
  }

  /**
   * Our helmet stopped a headshot: the kill_message.i3i "Helmet Protection" sprite (killmarks.ts helmetProtection,
   * STR_HEADER_HELMET_PROTECTION "O capacete lhe salvou de um Headshot" = the victim's message) + MV_Ann_HelmetProtection.
   */
  private helmetProtection(attacker: Actor | null): void {
    this.hud.helmetProtection();
    pbHelmetProtection(attacker ? attacker.feet(new THREE.Vector3()) : this.me.feet(new THREE.Vector3()));
  }

  /** Owner's DroppedWeapon stream (the exe host streams its drops): every 0.1 s while falling, once more at rest. */
  private streamDrops(): void {
    for (const [idx, last] of this.dropStream) {
      const d = this.drops.field.drops.get(idx);
      if (!d || d.owner !== this.me.id) {
        this.dropStream.delete(idx);
        continue;
      }
      if (this.time - last.at < 0.1) continue;
      const resting = Math.hypot(d.pos.x - last.x, d.pos.y - last.y, d.pos.z - last.z) < 0.005;
      this.net.sendDropped?.({ actorId: this.me.id, idx, weaponId: d.weaponId, slot: d.slot, death: d.death, ammo: d.ammo, extra: d.extra,
        reserve: d.reserve, pos: [d.pos.x, d.pos.y, d.pos.z], resting });
      if (resting) this.dropStream.delete(idx);
      else this.dropStream.set(idx, { x: d.pos.x, y: d.pos.y, z: d.pos.z, at: this.time });
    }
  }

  /** The remote drop a DropWeapon / DroppedWeapon of `actorId` refers to: same index + weapon, else the owner's nearest same weapon. */
  private findRemoteDrop(idx: number, weaponId: number, actorId: string, at: THREE.Vector3): DroppedWeapon | null {
    const d = this.drops.field.drops.get(idx);
    if (d && d.weaponId === weaponId && d.owner === actorId) return d;
    let best: DroppedWeapon | null = null, bd = Infinity;
    for (const x of this.drops.field.drops.values()) {
      if (x.weaponId !== weaponId || x.owner !== actorId) continue;
      const dist = Math.hypot(x.pos.x - at.x, x.pos.y - at.y, x.pos.z - at.z);
      if (dist < bd) { bd = dist; best = x; }
    }
    return best;
  }

  /** Another player's throwable (SubHead.Grenade): the object flies here with the same physics, and goes off on its explode record. */
  private remoteThrow(e: ThrowEvent): void {
    const ws = this.pbWeapons();
    if (!ws) return;
    const key = `${e.actorId}:${e.idx}`;
    const g = this.remoteThrows.get(key);
    const pos = new THREE.Vector3(...e.pos);
    const def = ws.db.def(e.weaponId);
    const fuse = def?.params.fuse ?? 2.5;
    if (e.state === "throw") {
      // no fuse of its own: the owner's explode record sets it off where it really stopped (fallback if that is lost)
      const ng = ws.spawnGrenade(e.weaponId, pos, new THREE.Vector3(...e.vel), fuse + 2, false);
      if (ng) {
        ng.owner = e.actorId; // the HUD warning skips allies' throws (Cross 0x744ac0)
        if (ng.sticky) ng.fuse = Infinity; // C5: waits for the trigger record
        this.remoteThrows.set(key, ng);
      }
      return;
    }
    const live = g && g.mesh.parent ? g : null;
    if (e.state === "trigger") {
      if (live) {
        live.fuse = fuse + 2;
        ws.audio.fireAt(live.weapon, live.mesh.position);
      }
      return;
    }
    // explode
    if (g && !live) return; // already went off here
    this.remoteThrows.delete(key);
    if (live) {
      live.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
      live.mesh.position.copy(pos);
      live.fuse = 0;
    } else {
      const ng = ws.spawnGrenade(e.weaponId, pos, new THREE.Vector3(), 0, false); // throw record lost: the blast alone
      if (ng) ng.fuse = 0;
    }
  }

  /** 0xa11f40: every 0.25 s, alive, into an empty primary / secondary, within 1 m. */
  private searchPickup(): void {
    const ws = this.pbWeapons();
    if (!ws || !this.me.alive) return;
    const feet = this.me.feet(this._v);
    const d: DroppedWeapon | null = findPickup(this.drops.field.drops.values(), feet, (s) => ws.slotEmpty(s));
    if (!d || !ws.pickUp(d.weaponId, d.ammo, d.reserve)) return;
    this.drops.remove(d.idx);
    this.net.sendPickup?.({ actorId: this.me.id, weaponId: d.weaponId, slot: d.slot, ammo: d.ammo, extra: d.extra, reserve: d.reserve, death: false, idx: d.idx });
  }

  /** Local radio: own chat line + voice (the sender hears it too), RadioChat to the room. */
  private sendRadio(id: number): void {
    this.radio.receive(id, this.me.name, this.me.team, this.me.team, radioVoiceOf(this.localChara, this.me.team));
    this.net.sendRadio?.({ actorId: this.me.id, id, area: 0 });
  }

  /** world direction a bullet travelled from `attacker` to `target` (charModel.hurt picks the Damage* clip from it); undefined without an attacker */
  private hitDir(attacker: Actor | null, target: Actor): THREE.Vector3 | undefined {
    if (!attacker || attacker === target) return undefined;
    const d = target.feet(this._v).sub(attacker.feet(this._w));
    d.y = 0;
    return d.lengthSq() > 1e-6 ? d.normalize().clone() : undefined;
  }

  /** side a hit on the local player came from, for the 1PV arms' Damage* clip. [INFERIDO] like charAnim.hurt */
  private hurtFrom(attacker: Actor): "FrontLeft" | "FrontRight" | "Back" {
    const f = this.me.feet(this._v);
    const a = attacker.feet(this._w);
    let rel = this.player.yaw - Math.atan2(-(a.x - f.x), -(a.z - f.z)); // positive = attacker to the right
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    return Math.abs(rel) >= Math.PI * 0.75 ? "Back" : rel > 0 ? "FrontRight" : "FrontLeft";
  }

  private onPlayerHurt(attacker: Actor | null): void {
    if (!attacker || attacker === this.me) {
      this.hud.damageFrom(Math.PI); // fall damage: show "from below/behind"
      return;
    }
    const f = this.me.feet(this._v);
    const a = attacker.feet(this._w);
    const bearing = Math.atan2(-(a.x - f.x), -(a.z - f.z)); // yaw that would face the attacker
    let rel = this.player.yaw - bearing; // positive = attacker to the right
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    this.hud.damageFrom(rel);
  }

  // ---- Spawning ----
  /**
   * Spawn for `who`. Teammates spread over the team's points: each picks by its rank among the team (ids sorted, the
   * same order on every client), shifted by how many times it already spawned, so two players respawning together
   * (round start, nobody visible yet) do not both take "the point farthest from the enemy". A point is blocked when
   * another actor stands within SPAWN_CLEAR of it, or was given it in the last SPAWN_HOLD s (covers a body whose state
   * has not arrived yet). Enemy distance only breaks ties and keeps the spawn out of sight of the enemy.
   */
  private pickSpawn(who: Actor): SpawnPoint {
    const team = who.team;
    const own = this.spawns.filter((s) => s.team === team);
    const pool = [...(own.length ? own : this.spawns)].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const all = [...this.actors()];
    // Online: rank among the room's slots, not among actors() (`remotes` fills as packets arrive, so at round start
    // every human sees itself alone = rank 0 = the same point). Slot id = `slot<N>`, team = slot % 2.
    const room = (this.net as unknown as { room?: RoomClient | null }).room;
    // Bot slots are not room slots (state 0, no nick): they come from the actors known here (`slot<N>` on every peer). Numeric
    // order keeps the humans (low seats) ranked the same on a peer that has not seen the bots yet (allocBotSlots: top-down from 15).
    const slotNo = (id: string) => Number(id.replace(/\D/g, "")) || 0;
    const mates = this.net.mode === "net" && room
      ? [...new Set([...room.slots.filter((s) => s.state >= 12 && s.slot % 2 === team).map((s) => `slot${s.slot}`),
          ...all.filter((a) => a.team === team).map((a) => a.id)])].sort((a, b) => slotNo(a) - slotNo(b))
      : all.filter((a) => a.team === team).map((a) => a.id).sort();
    // Bomb Mission: everybody spawns at the same instant on every peer, so the shift must be the same everywhere = the round
    // number (a late joiner / a spectator has another spawnCount and would land on a teammate's point in round 2+)
    const shift = this.bomb ? Math.max(0, this.match.round - 1) : (this.spawnCount.get(who.id) ?? 0);
    const preferred = (Math.max(0, mates.indexOf(who.id)) + shift) % pool.length;
    const enemies = all.filter((a) => a.alive && a.team !== team).map((a) => a.feet(new THREE.Vector3()));
    const others = all.filter((a) => a.alive && a !== who).map((a) => a.feet(new THREE.Vector3()));
    for (const [id, t] of this.spawnTaken) if (id !== who.id && this.time - t.at < SPAWN_HOLD) others.push(t.feet);
    const scored = pool.map((s, i) => {
      const nearEnemy = enemies.reduce((m, e) => Math.min(m, e.distanceTo(s.feet)), 1e9);
      const occupied = others.some((o) => Math.hypot(o.x - s.feet.x, o.z - s.feet.z) < SPAWN_CLEAR && Math.abs(o.y - s.feet.y) < 2);
      const score = (occupied ? -1000 : 0) + (nearEnemy < 15 ? -50 : 0) + Math.min(nearEnemy, 40) * 0.5 + (i === preferred ? 100 : 0) + Math.random() * 8; // the rank wins over distance / jitter: every peer must resolve the same point
      return { s, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].s;
  }
  private spawnTaken = new Map<string, { feet: THREE.Vector3; at: number }>();
  private spawnCount = new Map<string, number>();

  private spawnActor(a: Actor): void {
    if (a === this.me && this.spectating) { // sits the round out: no body, the observer camera
      this.dropCorpse();
      this.me.alive = false;
      this.player.setCollisionEnabled(false);
      const sp0 = this.pickSpawn(a);
      this.me.deathEye.copy(sp0.feet).y += 1.7; // never seen the map from a body: watch from the team's spawn
      this.camera.position.copy(this.me.deathEye);
      return;
    }
    const sp = this.pickSpawn(a);
    this.spawnTaken.set(a.id, { feet: sp.feet.clone(), at: this.time });
    this.spawnCount.set(a.id, (this.spawnCount.get(a.id) ?? 0) + 1);
    // "Invisible +1 Seconds" coupon: the local player's spawn protection lasts longer
    const protect = this.time + this.match.cfg.spawnProtect + (a === this.me ? this.invincibleExtra : 0);
    this.respawnAt.delete(a.id);
    if (a === this.me) {
      this.dropCorpse(); // the body is gone with the death camera: the new life has its own
      this.player.setCollisionEnabled(true);
      this.player.teleportFeet(sp.feet, sp.yaw);
      this.bombTestSpawn();
      this.me.hp = this.me.maxHp;
      this.me.armor = 100;
      this.me.helmetLost = false; // the equipped helmet (if any) is back
      this.me.alive = true;
      this.me.invulnUntil = protect;
      this.applyRespawnLoadout();
      this.weapons.reset();
      if (this.bomb) this.pbWeapons()?.setMission(this.me.team === this.bomb.attackers);
    } else if (a instanceof Bot) {
      a.spawn(sp, protect);
    }
  }

  /** Respawn weapon change: equip the confirmed choice (WeaponSystem.equip) and put it in the next RESPAWN_REQ. */
  private applyRespawnLoadout(): void {
    const sel = this.respawnMenu?.sel;
    if (!sel) return;
    const pick = sel.takeForRespawn();
    const ws = this.weapons instanceof PbWeaponsBridge ? this.weapons.ws : null;
    RESPAWN_SLOTS.forEach((slot, i) => {
      if (pick[slot] && pick[slot] !== this.appliedLoadout?.[slot]) ws?.equip(pick[slot]); // 5 usage slots (key 5 = special)
      else if (!pick[slot] && sel.enforcing()) ws?.clearSlot(i as 0 | 1 | 2 | 3 | 4); // room mode bars the slot (e.g. no primary in knife mode)
    });
    this.appliedLoadout = pick;
    this.net.setRespawnWeapons?.(RESPAWN_SLOTS.map((s) => ({ itemId: pick[s], objectId: sel.objectIdOf(pick[s]) })));
  }

  private spawnEveryone(): void {
    // Spawn one at a time so pickSpawn sees earlier arrivals as occupied.
    for (const a of [this.me, ...this.bots]) {
      a.alive = false;
      if (a instanceof Bot) a.kill();
    }
    for (const a of [this.me, ...this.bots]) this.spawnActor(a);
  }

  // ---- Bomb Mission ----
  private async initBomb(): Promise<void> {
    const params = new URLSearchParams(location.search);
    const folder = CurrentMap; // map folder id ("downtown"); levelName is the display string ("Downtown (real assets)")
    // the Cross Stage config only (pb-extract-tools export-bombsites.mjs -> cross maps/bombsites.json). No server fallback: a stage the
    // Cross config lacks has no bomb mode (Cross or nothing)
    const cfg = await jsonOnce("/assets/cross/maps/bombsites.json").catch(() => null) as { maps: Record<string, { sites: ({ area: number; pos: BombVec3 } | null)[] }> } | null;
    const sites: { area: number; pos: BombVec3 }[] = cfg?.maps[folder]?.sites.filter((s): s is { area: number; pos: BombVec3 } => !!s) ?? [];
    if (sites.length === 0) console.warn(`[bomb] no bomb sites for ${folder}: nobody can plant`);
    const room = (this.net as unknown as { room?: RoomClient | null }).room ?? null;
    this.bombRoom = this.net.mode === "net" ? room : null;
    const serverFuse = this.bombRoom !== null;
    this.bomb = new BombMode(sites, {
      onPlantDone: (site, pos) => {
        if (this.bombRoom) this.bombRoom.bombInstall(site, pos); // the ACK (5157) plants for everyone, us included
        else this.onBombPlanted(site, pos, true);
      },
      onDefuseDone: () => {
        if (this.bombRoom) this.bombRoom.bombUninstall();
        else this.onBombDefused();
      },
      onExplode: () => this.onBombExploded(),
    });
    this.bomb.serverFuse = serverFuse;
    this.bombSites = sites;
    this.hud.setModeName(tOr("STR_HEADER_MODE_EXPLOSION", "Destruição"));
    this.match.defenders = 1;
    const pbw = this.pbWeapons();
    if (pbw) {
      this.bombVis = new BombVisual(this.scene, pbw.audio.listener, pbw.effects);
      if (params.has("bombrings")) { this.bombRingsOn = true; this.bombVis.showSites(sites); } // test aid only: the original draws no ring (?bombrings)
    }
    const r = this.bombRoom;
    if (r) {
      // joined a running round: the server left our slot out of the round's slots flag (Room.SpawnReadyPlayers: Spectator = true)
      // (sitsOutRound: a GM observer sits every round out too; the flag carries its seat like any other, C# GetSlotsFlag)
      if (r.lastRoundStart) this.spectating = r.sitsOutRound(r.lastRoundStart.slotsFlag);
      const prev = { bomb: r.onBomb, start: r.onRoundStart, end: r.onRoundEnd };
      // the RoomClient outlives the match: a Game that was disposed (world freed) must not answer the next match's 5153 / 5155
      // ("Cannot read properties of undefined (reading 'coSetEnabled')" left the new round never starting)
      this.unhookRoom = () => { r.onBomb = prev.bomb; r.onRoundStart = prev.start; r.onRoundEnd = prev.end; };
      r.onBomb = (e) => {
        prev.bomb?.(e);
        if (this.disposed) return;
        if (e.kind === "planted") {
          if (e.fuse !== undefined) this.syncFuse(e.zone, e.pos, e.fuse); // the server's 1 s resync
          else this.onBombPlanted(e.zone, e.pos, e.slot === r.mySlot);
        }
        else this.onBombDefused();
      };
      r.onRoundStart = (e) => {
        prev.start?.(e);
        if (this.disposed) return;
        this.spectating = r.sitsOutRound(e.slotsFlag);
        this.bomb?.reset(e.swap ? 1 : 0);
        this.match.defenders = e.swap ? 0 : 1;
        this.bombVis?.clear();
        this.match.beginRound(e.round, e.frRounds, e.ctRounds);
      };
      r.onRoundEnd = (e) => {
        prev.end?.(e);
        if (this.disposed) return;
        if (e.motive === 2 && this.bomb?.state === "planted") this.onBombExploded(); // fuse ran out on the server first
        if (e.motive === 1) this.missionNotice("STBL_IDX_BOMB_MISSION_DEFENCE", "O objetivo foi protegido"); // _ProcessEvent_RoundEnd 0x773cb0 (TimeOut)
        // motive 4 = all dead (team wiped): winner 0 ->, 1 -> red [INFERIDO team mapping, exe 0x769f1c]
        if (e.motive === 4 && (e.winner === 0 || e.winner === 1)) this.missionNotice(e.winner === 0 ? "STBL_IDX_MISSION_BLUE_ELEMENATE" : "STBL_IDX_MISSION_RED_ELEMENATE", e.winner === 0 ? "Time azul foi totalmente derrotado" : "Time vermelho foi totalmente derrotado");
        this.match.score[0] = e.fr;
        this.match.score[1] = e.ct;
        const winner = e.winner === 0 || e.winner === 1 ? e.winner : null;
        if (this.match.phase === "live") this.hud.roundEnd(winner); // _ProcessEvent_RoundEnd 0x769bc0 -> CHud 0x73ffb0
        this.match.endRound(winner);
      };
    }
  }

  /** ?bombplanted=A|B (offline Bomb Mission test): the C4 is already down on that site when the round goes live, to test the defuse */
  private bombTestPlanted(): void {
    const q = new URLSearchParams(location.search).get("bombplanted")?.toUpperCase();
    if (!this.bomb || !q || this.bombRoom) return;
    const site = this.bomb.sites.find((s) => s.area === "AB".indexOf(q));
    if (site && this.bomb.state === "idle") this.onBombPlanted(site.area, site.pos);
  }

  /** ?bombspawn=A|B (Bomb Mission test): spawn 1 m from that site, inside its 2 m area */
  private bombTestSpawn(): void {
    const q = new URLSearchParams(location.search).get("bombspawn")?.toUpperCase();
    if (!this.bomb || !q) return;
    const site = this.bomb.sites.find((s) => s.area === "AB".indexOf(q));
    if (site) this.player.teleportFeet(new THREE.Vector3(site.pos[0] + 1, site.pos[1], site.pos[2]), this.player.yaw);
  }

  // ---- Destroy mission ----
  /** TEAM_SWAP of the round: the teams play the other colour (objectives.ts sideOf) */
  private destroySwap = false;
  /** the target HP panel: the bars from 5167 and the full life (the map's objective life, 6000 / 12000); null = not a Destroy match */
  private objBars: { bar: [number, number]; max: [number, number] } | null = null;
  /** Defence (Matches Mode 5, Black Panther): the attackers are FR (CT with the swap) and hit both objectives; the defenders hit none */
  private defenceMode = false;

  /** the objectives are the map's props with `objective` (mapProps.ts). A bullet of ours on an enemy objective goes to the host
   * (ObjectType.Object, server object id); the bars come back in 5167 (onGenerator) and set the objective's life. */
  private initDestroy(): void {
    this.hud.setModeName(tOr("STR_HEADER_MODE_DESTROY", "Sabotagem"));
    const props = currentMapProps();
    this.defenceMode = this.match.cfg.mode === "DEFENCE";
    // full life of each objective: the server's MapStructure life (Breakdown 6000, Helispot 12000; Defence normal_Tank 6000, armerd_Tank 9000)
    const life = (colour: "red" | "blue") => props?.props.find((p) => p.objective === colour && p.net)?.net?.life ?? 12000;
    const max: [number, number] = [life("red"), life("blue")];
    this.objBars = { bar: [...max], max };
    if (props) props.onObjectiveHit = (pr, dmg) => {
      // a remote player's shot is damaged by their own client; ours and the bots' (the host simulates them) go to the host
      const by = this.propBreaker;
      if (!by || !pr.objective || !pr.net) return;
      if (!this.canHitObjective(pr.objective, by.team)) return;
      const point: [number, number, number] = [pr.center.x, pr.center.y, pr.center.z];
      if (by === this.me) this.net.sendObjectiveHit?.(pr.net.index, dmg, point);
      else if (by.kind === "bot" && this.net.isBotHost) this.net.sendBotObjectiveHit?.(Number(by.id.slice(4)), pr.net.index, dmg, point);
    };
    const r = (this.net as unknown as { room?: RoomClient | null }).room ?? null;
    if (!r || this.net.mode !== "net") return;
    const prev = { start: r.onRoundStart, end: r.onRoundEnd, gen: r.onGenerator };
    this.unhookRoom = () => { r.onRoundStart = prev.start; r.onRoundEnd = prev.end; r.onGenerator = prev.gen; };
    r.onGenerator = (e) => {
      prev.gen?.(e);
      if (this.disposed) return;
      if (this.objBars) this.objBars.bar = [e.bar1, e.bar2];
      const pm = currentMapProps();
      if (pm) for (const pr of pm.props) if (pr.objective && pr.net) pm.setObjectiveLife(pr.index, pr.objective === "red" ? e.bar1 : e.bar2);
    };
    r.onRoundStart = (e) => {
      prev.start?.(e);
      if (this.disposed) return;
      this.spectating = r.sitsOutRound(e.slotsFlag);
      this.destroySwap = e.swap;
      // the server resets its bars at each round start (roundRestart -> setGameModeSpecificBars): the panel starts full too
      if (this.objBars) this.objBars.bar = [...this.objBars.max];
      this.match.beginRound(e.round, e.frRounds, e.ctRounds);
    };
    r.onRoundEnd = (e) => {
      prev.end?.(e);
      if (this.disposed) return;
      this.serverRoundEnd(e);
    };
  }

  /** Annihilation / Ace (match.cfg.mode "ANNIHILATION" /): the server's rounds (5153 / 5155) with no objectives. The round
   * ends by a side wiped out (Annihilation) or a kill (Ace); the round counter comes from 5153 / 5155 like Destroy's. */
  private initRounds(): void {
    this.hud.setModeName(this.match.cfg.mode === "ACE" ? tOr("STR_HEADER_DO_TCH_DN_ACE_ATTACKER", "Ace Attacker") : tOr("STR_HEADER_MODE_ANNIHILATION", "Supressão"));
    const r = (this.net as unknown as { room?: RoomClient | null }).room ?? null;
    if (!r || this.net.mode !== "net") return;
    const prev = { start: r.onRoundStart, end: r.onRoundEnd };
    this.unhookRoom = () => { r.onRoundStart = prev.start; r.onRoundEnd = prev.end; };
    r.onRoundStart = (e) => {
      prev.start?.(e);
      if (this.disposed) return;
      this.spectating = r.sitsOutRound(e.slotsFlag);
      this.match.beginRound(e.round, e.frRounds, e.ctRounds);
    };
    r.onRoundEnd = (e) => {
      prev.end?.(e);
      if (this.disposed) return;
      this.serverRoundEnd(e);
    };
  }

  /** 5155 ROUND_END: the score is the server's counts, the round goes to the winner (null = draw) */
  private serverRoundEnd(e: RoundEndInfo): void {
    this.match.score[0] = e.fr;
    this.match.score[1] = e.ct;
    const winner = e.winner === 0 || e.winner === 1 ? e.winner : null;
    if (this.match.phase === "live") this.hud.roundEnd(winner);
    this.match.endRound(winner);
  }

  private bombDebug(feet: THREE.Vector3): string {
    const b = this.bomb!, n = b.nearest(feet.toArray() as BombVec3);
    const near = n ? `${"AB"[n.area]} ${n.dist.toFixed(1)} m (dy ${n.dy.toFixed(2)}; precisa < 2 m e |dy| < 0,2)` : "sem locais";
    return `\nbomba: ${b.state} · time ${this.me.team} (atacam ${b.attackers}) · ${this.c4InHand() ? "C4 na mão" : "sem C4 na mão"} · área ${near}`;
  }

  private c4InHand(): boolean {
    return isMissionWeapon(this.pbWeapons()?.getHudState().id);
  }

  // ---- F1 test menu (offline) ----
  private initDevMenu(): void {
    const b = () => this.bomb;
    const site = (area: number) => this.bombSites.find((s) => s.area === area);
    const A: { label: () => string; run: () => void }[] = [
      { label: () => `Trocar de time (agora: ${this.me.team === 0 ? "TR / vermelho" : "CT / azul"})`, run: () => { this.me.team = (1 - this.me.team) as 0 | 1; this.spawnActor(this.me); } },
      { label: () => "Vida cheia", run: () => { this.me.hp = this.me.maxHp; } },
      { label: () => "Matar todos os bots", run: () => { for (const x of this.bots) if (x.alive) this.onDeath(x, this.me, "Debug", false); } },
    ];
    if (this.bomb) {
      const bm = () => b()!;
      A.push(
        { label: () => "Ir ao ponto A da bomba", run: () => { const s = site(0); if (s) this.player.teleportFeet(new THREE.Vector3(s.pos[0] + 1, s.pos[1], s.pos[2]), this.player.yaw); } },
        { label: () => "Ir ao ponto B da bomba", run: () => { const s = site(1); if (s) this.player.teleportFeet(new THREE.Vector3(s.pos[0] + 1, s.pos[1], s.pos[2]), this.player.yaw); } },
        { label: () => "Plantar bomba no ponto A (instantâneo)", run: () => { const s = site(0); if (s && bm().state === "idle") this.devPlant(0, s.pos); } },
        { label: () => "Plantar bomba no ponto B (instantâneo)", run: () => { const s = site(1); if (s && bm().state === "idle") this.devPlant(1, s.pos); } },
        { label: () => "Explodir a bomba agora", run: () => { if (bm().state !== "planted") return; if (this.bombRoom) this.bombRoom.devBomb(1); else bm().fuseLeft = 0.05; } },
        { label: () => "Nova rodada (limpa a bomba)", run: () => { if (this.bombRoom) { this.bombRoom.devBomb(2); return; } bm().reset(0); this.bombVis?.clear(); this.match.beginRound(this.match.round + 1, this.match.score[0], this.match.score[1]); } },
        { label: () => `Anéis dos pontos: ${this.bombRingsOn ? "ligados" : "desligados"}`, run: () => { this.bombRingsOn = !this.bombRingsOn; if (this.bombRingsOn) this.bombVis?.showSites(this.bombSites); else this.bombVis?.hideSites(); } },
      );
    }
    this.devMenu = new DevMenu(this.bomb ? "Testes — Bomba" : "Testes", A.slice(0, 10), "Testes locais (online só afetam este cliente; depois só GM). O C4 fica no slot 6 (tecla 6) do TR.");
  }

  /** F2 plant: online it goes through the server (5156 -> ACK 5157 to everyone); offline it plants directly */
  private devPlant(site: number, pos: BombVec3): void {
    if (this.bombRoom) this.bombRoom.bombInstall(site, pos);
    else this.onBombPlanted(site, pos);
  }

  /**
   * CHud::SetMissionNoticeString (0x73f7a0, text node +0x2a0, lifetime 3 s = [0xb228e4]): the STBL_IDX_BOMB_MISSION_* / MISSION_* strings,
   * shown by the HUD's notice slot (pbHud/PbHud.ts notice).
   */
  private missionNotice(key: string, fallback: string, sec = 3): void {
    this.hud.missionNotice(tOr(key, fallback), sec);
  }

  /** C4 hint (CHud::UpdateMissionNotice 0x74b1e0): a new text is shown for 5 s (hint timer +0x5cc, 0x740312), then hidden until it changes; null clears it */
  private setBombHint(text: string | null): void {
    if (text === this.bombHint) return;
    this.bombHint = text;
    this.bombHintT = 5;
  }

  /** server fuse clock: a late joiner plants the bomb with the time already burnt; everyone else snaps to the server when the drift passes 0.25 s */
  private syncFuse(site: number, pos: BombVec3, left: number): void {
    const b = this.bomb;
    if (!b) return;
    if (b.state === "idle") this.onBombPlanted(site, pos, false, BOMB.fuse - left);
    else if (b.state === "planted" && Math.abs(b.fuseLeft - left) > 0.25) b.fuseLeft = left;
  }

  /**
   * Mission cards during the match: every push of the lobby's MissionClient (2359 task step, 2361 card / set
   * done) redraws the panel and the Tab list (CQuestManager::Update 0x58c780 -> UpdateQuestStateBoard 0x58c7d0, not per frame) and a
   * task that turned done shows "Task Completed" (AddQuestFinishToHud 0x58c8b0). The 2361 prize itself is the lobby's: its popup opens
   * in the room after the match (controller onMissionPush), never here.
   */
  private watchMissions(m: MissionClient, panel: boolean): void {
    const push = () => {
      const st = m.state, snap = taskSnapshot(st);
      const done = newlyDone(this.missionTasks, snap);
      this.missionTasks = snap;
      const lines = missionLines(st);
      this.hud.missions(lines.length ? { lines, panel } : null);
      // one 2359 = one task; a spectator is not in the round (no banner, as the round start ones)
      if (done.length && !this.spectating) this.hud.taskCompleted();
    };
    push();
    this.unwatchMissions = m.subscribe(push);
  }

  private onBombPlanted(site: number, pos: BombVec3, mine = false, burnt = 0): void {
    if (!this.bomb || this.bomb.state !== "idle") return;
    this.bomb.plant(site, pos, burnt);
    // the planter's C4 is used up: it leaves the hand (the slot empties, the hand goes back to the first armed slot)
    // the C4 is gone for every attacker once planted (one bomb per round), not only for the planter
    this.pbWeapons()?.setMission(false);
    if (mine) { this.pbWeapons()?.plantHold(false); this.match.addObject(this.me.id); }
    this.bombVis?.plant(pos);
    this.match.paused = true; // the round clock stops: the fuse decides
    this.hud.killMark([KILL_MARKS.bombPlanted]);
    this.missionNotice("STBL_IDX_BOMB_MISSION_ATTACH", "A bomba foi ativada");
  }

  private onBombDefused(): void {
    if (!this.bomb || this.bomb.state !== "planted") return;
    this.bomb.defuse();
    this.bombVis?.defuse();
    this.match.paused = false;
    this.hud.killMark([KILL_MARKS.bombRemoved]);
    this.missionNotice("STBL_IDX_BOMB_MISSION_DETTACH", "A bomba foi desarmada");
    if (!this.bombRoom) this.offlineRoundOver(this.match.defenders);
  }

  private onBombExploded(): void {
    if (!this.bomb) return;
    this.bomb.state = "exploded";
    if (this.bomb.planted) this.bombBlast(this.bomb.planted.pos);
    this.bombVis?.explode();
    this.hud.killMark([KILL_MARKS.bombExploded]);
    this.missionNotice("STBL_IDX_BOMB_MISSION_EXPLOSION", "O objetivo foi destruído"); // _ProcessEvent_RoundEnd 0x773d26 (BombFire)
    if (!this.bombRoom) this.offlineRoundOver(1 - this.match.defenders);
  }

  /**
   * The C4 blast, exe-2017 WeaponC4::_OnCheckCollisionByExplosion 0x6375f0 (src/weapons/explosion.ts), weapon.pef C4
   * Damage 100, Explosion_Range 10, Explosion_EffectiveSlope 0.01: every character whose IK bone is within 10 m, no team
   * filter, gets the grenade's per-character lines 0x60ed10 twice (team loop 0x637664): an exposed head takes the raw 100,
   * an exposed IK bone 100 * (1 - 0.01 * |Root - C4| / 10); with both lines blocked by the map or a prop it takes nothing.
   * Each client hurts what it owns: itself (and the bots offline).
   */
  private bombBlast(pos: BombVec3): void {
    const c = new THREE.Vector3(pos[0], pos[1], pos[2]);
    // windows, boards, barrels... (every client breaks its own map objects, like a grenade): 0x6377e2 ->
    // _CheckExplosionObjectCollision 0x60d660, rate clamp01(1 - d / R) at 0x60de73 (linear, the slope is not read)
    this.blastMapProps(c, C4_BLAST.range, C4_BLAST.damage, null);
    const ws = this.pbWeapons();
    for (const a of this.actors()) {
      if (!a.alive || a.kind === "remote") continue;
      const pts = blastPoints(a);
      const o = { ...C4_BLAST, passes: 2, hp: a.hp };
      // without the WeaponSystem (?weapons=adapter dev mode) there is no world cast to block the lines
      const hits = ws ? ws.blastHits(pts, c, o)
        : explosionHits(o, { ikDist: pts.ik.distanceTo(c), rootDist: pts.root.distanceTo(c), headClear: true, ikClear: true });
      if (hits.length) this.noteDeathHit(null, a, "C4", C4_BLAST.damage, "torso", pts.root, c, true);
      for (const h of hits) {
        if (!a.alive) break;
        a.hp = Math.max(0, a.hp - h.damage);
        a.onDamaged?.(null, h.damage, "torso");
        if (a.hp <= 0) this.onDeath(a, null, "C4", false);
      }
    }
  }

  /** Offline the game is its own server: count the round, then start the next one after the result banner. */
  private offlineRoundOver(winner: number | null): void {
    if (this.match.phase !== "live") return;
    if (winner === 0 || winner === 1) this.match.score[winner]++;
    this.hud.roundEnd(winner === 0 || winner === 1 ? winner : null); // _ProcessEvent_RoundEnd 0x769bc0 -> CHud 0x73ffb0
    this.match.endRound(winner === 0 || winner === 1 ? winner : null);
    this.nextRoundAt = this.time + 6;
    // the round limit (?rounds=N): the match is over, the end screen instead of another round
    const lim = this.match.roundLimit;
    if (lim > 0 && (winner === 0 || winner === 1) && this.match.score[winner] >= lim) {
      this.nextRoundAt = 0;
      const [red, blue] = this.match.score;
      this.showFinal({ winner, red, blue }, () => {
        if (this.onLeave) { this.onLeave(); return; }
        this.bomb?.reset(0);
        this.bombVis?.clear();
        this.match.beginRound(1, 0, 0);
      });
    }
  }

  private updateBomb(dt: number): void {
    const b = this.bomb;
    if (!b) return;
    if (this.bombHintT > 0) this.bombHintT = Math.max(0, this.bombHintT - dt);
    if (this.bombRoom === null && this.match.phase === "ended" && this.nextRoundAt > 0 && this.time >= this.nextRoundAt) {
      this.nextRoundAt = 0;
      b.reset(0); // TEAM_SWAP is not offered offline: the sides stay
      this.bombVis?.clear();
      this.match.beginRound(this.match.round + 1, this.match.score[0], this.match.score[1]);
    }
    if (!this.match.live) return;
    this.bombBots(dt);
    this.destroyBots();
    const ok = this.input.locked && !this.escMenu?.isOpen;
    // plant = the C4 in hand (key 5) + the fire button held (STBL_IDX_BOMB_MISSION_AREA); defuse = the action key (E) [RECRIADO key]
    const c4InHand = this.c4InHand();
    const inp: BombInput = {
      team: this.me.team, alive: this.me.alive, pos: this.me.feet(this.bombFeet).toArray() as BombVec3,
      plantHeld: ok && c4InHand && this.input.button(0), defuseHeld: ok && keyHeld(this.input, "action"),
      hasC4: this.me.team === b.attackers,
    };
    const before = b.action;
    b.update(dt, inp);
    this.bombHints(b, inp, dt);
    if (b.action && b.action !== before) this.bombVis?.button(b.action);
    // the C4 Install arm clip follows the hold (5.667 s in the pack: it ends with the plant); a release / cancel drops it
    if (b.action === "plant" && before !== "plant") this.pbWeapons()?.plantHold(true);
    else if (b.action !== "plant" && before === "plant") this.pbWeapons()?.plantHold(false);
    if (!b.action && before) this.bombVis?.stopInstall(); // released / moved away / done: the install sound ends with the hold
    if (b.action === "plant") this.pbWeapons()?.plantProgress(b.progress);
    if (b.state === "planted") this.bombVis?.update(dt, b.fuseLeft, b.beepInterval());
    // offline: the round also ends when a side is wiped out (online the server decides, 5155)
    if (this.bombRoom === null && this.match.phase === "live") {
      const alive = [0, 0];
      let total = 0;
      for (const a of this.actors()) { total++; if (a.alive) alive[a.team]++; }
      if (total > 1) {
        if (alive[b.attackers] === 0 && b.state !== "planted") this.offlineRoundOver(1 - b.attackers);
        else if (alive[1 - b.attackers] === 0) this.offlineRoundOver(b.attackers);
      }
    }
  }

  /** Destroy mode (online, the host's bots): each bot walks to the nearest enemy objective still standing and shoots it when it
   * is in front of the bot (bots.ts perceive). [RECRIADO]: the AI rows (AICharacter) have no objective field, so the walk and the
   * range are ours. The objective is an Actor-shaped stand-in (its chest = the prop centre), cached per prop so the reaction timer holds. */
  private destroyBots(): void {
    if (!this.objBars || this.bots.length === 0 || this.net.mode !== "net" || !this.net.isBotHost) return;
    const props = currentMapProps()?.props.filter((p) => p.objective && p.net) ?? [];
    for (const bot of this.bots) {
      bot.objTarget = null;
      if (!bot.alive) continue;
      const me = bot.feet(this.bombFeet);
      let best: MapProp | null = null, bestD = Infinity;
      for (const pr of props) {
        if (!this.canHitObjective(pr.objective!, bot.team) || this.objBars.bar[barOf(pr.objective!) - 1] <= 0) continue;
        const d = Math.hypot(pr.center.x - me.x, pr.center.z - me.z);
        if (d < bestD) { best = pr; bestD = d; }
      }
      if (!best) { bot.setObjective(null); continue; }
      bot.setObjective(best.center);
      bot.objTarget = this.objectiveStandIn(best);
    }
  }
  /** may `team` damage this objective: Destroy = the other colour (objectives.ts); Defence = the attackers, both objectives [INFERIDO] */
  private canHitObjective(objective: ObjectiveSide, team: number): boolean {
    return this.defenceMode ? team === (this.destroySwap ? 1 : 0) : isEnemyObjective(objective, team, this.destroySwap);
  }
  private objectiveStandIns = new Map<number, Actor>();
  private objectiveStandIn(pr: MapProp): Actor {
    let a = this.objectiveStandIns.get(pr.index);
    if (!a) {
      const c = pr.center;
      // a stand-in for bots.ts (chestPoint = feet + 1.25 m): only the members the bot reads
      a = { id: `obj${pr.index}`, alive: true, invulnUntil: 0, feet: (out: THREE.Vector3) => out.set(c.x, c.y - 1.25, c.z), isCrouching: () => false } as unknown as Actor;
      this.objectiveStandIns.set(pr.index, a);
    }
    return a;
  }

  /**
   * Bomb Mission bots (botBomb.ts). Offline the bots plant / defuse directly. Online only the match host has bots and it asks
   * Server.Game in the bot's slot (5156 / 5158, as a human does): the ACK plants / defuses on every peer, the host included.
   * A bot that dies takes the C4 hold with it: the next attacker alive picks the bomb up (the C4 is not dropped in this mode).
   */
  private bombBots(dt: number): void {
    const b = this.bomb;
    if (!b || !this.match.live) return;
    if (this.bombRoom && !this.net.isBotHost) return; // a guest has no bots: it only renders the host's
    this.botBomb ??= this.makeBotBomb(b);
    this.botBomb.update(dt, this.bots, this.match.round);
  }

  private makeBotBomb(b: BombMode): BotBombDriver<Bot> {
    const goal = new THREE.Vector3();
    const slotOf = (bot: Bot) => Number(bot.id.slice(4)); // "slotN"
    const drv = new BotBombDriver<Bot>(b, {
      feet: (bot) => bot.feet(this.bombFeet).toArray() as BombVec3,
      goto: (bot, p) => bot.setObjective(p ? goal.set(p[0], p[1], p[2]) : null),
      install: (bot, site, pos) => {
        if (this.bombRoom) this.bombRoom.bombInstall(site, pos, slotOf(bot));
        else this.onBombPlanted(site, pos, false);
      },
      uninstall: (bot) => {
        if (this.bombRoom) this.bombRoom.bombUninstall(slotOf(bot));
        else this.onBombDefused();
      },
    });
    // a host change in the middle of a hold: the bots that were holding in the old host's last records keep the job
    const snap = this.net.botSnapshot?.() ?? [];
    drv.prefer(snap.find((s) => s.torsoAction === "plant" && s.alive)?.id ?? null, snap.find((s) => s.torsoAction === "defuse" && s.alive)?.id ?? null);
    return drv;
  }

  /**
   * CHud::UpdateMissionNotice (0x74b1e0): attacker inside a site with the bomb not planted -> STBL_IDX_BOMB_MISSION_AREA; defender near the
   * planted bomb -> "<action key> " + STBL_IDX_BOMB_MISSION_DETTACH_EXPLAIN (key name first); while defusing -> DETTACH_ING (notice);
   * the hint goes away while the hold runs (the progress bar takes over). Firing the C4 outside a site: STBL_IDX_BOMB_MISSION_NONAREA
   * (CGameCharaWeaponControl::OnFire 0xa143ee).
   */
  private bombHints(b: BombMode, inp: BombInput, dt: number): void {
    let hint: string | null = null;
    if (inp.alive && !b.action && this.match.live && !this.finalOn) {
      if (b.canDefuse(inp)) {
        const k = (PB_KEYS.action[0] ?? "KeyE").replace(/^Key/, "");
        hint = `${k} ${tOr("STBL_IDX_BOMB_MISSION_DETTACH_EXPLAIN", "Segure o botão para desarmar a bomba")}`;
      } else if (b.state === "idle" && inp.hasC4 && b.siteAt(inp.pos) >= 0) hint = tOr("STBL_IDX_BOMB_MISSION_AREA", "Local de alvo para destruir.");
    }
    this.setBombHint(hint);
    if (b.action === "defuse") this.missionNotice("STBL_IDX_BOMB_MISSION_DETTACH_ING", "A bomba está sendo desarmada", 3);
    const wrongPlace = inp.alive && inp.hasC4 && b.state === "idle" && this.c4InHand() && this.input.locked && this.input.button(0) && b.siteAt(inp.pos) < 0;
    if (wrongPlace && !this.noSiteShown) this.missionNotice("STBL_IDX_BOMB_MISSION_NONAREA", "A bomba só pode ser instalada no local apropriado");
    this.noSiteShown = wrongPlace;
  }

  private onBombPhase(ph: MatchPhase): void {
    if (ph === "countdown") {
      // _ProcessEvent_RoundStart 0x769040, stage type 2 (Bomb): the attackers get, the defenders "Domine áreas-alvo" (3 s; [INFERIDO] side = 0x6da420 & 2)
      const attacker = this.me.team === this.bomb?.attackers;
      if (attacker) this.missionNotice("STBL_IDX_MISSION_DESTROY_OBJECT", "Missão : Destrua áreas-alvo");
      else this.missionNotice("STBL_IDX_MISSION_HOLDON_OBJECT", "Missão : Domine áreas-alvo");
      this.setBombHint(null);
      this.hud.clearFeed();
      this.drops?.clear();
      this.bombVis?.clear();
      // PreStartRound 0x66fa00 (thrown items) + i3EffectManager::Reset at RoundStart 0x7690c9 (the last round's C4 smoke, holes...)
      this.pbWeapons()?.resetRound();
      this.remoteThrows.clear();
      this.hud.newRound(); // kill stars / streak: the new round is a new life
      this.spawnEveryone();
    } else if (ph === "live") {
      if (!this.spectating) this.hud.killMark([KILL_MARKS.missionStart]); // a spectator is not in the round: no banner / voice
      this.bombTestPlanted();
    } else if (ph === "ended") {
      const w = this.match.winner;
      if (w !== null && !this.spectating) this.hud.killMark([w === this.me.team ? KILL_MARKS.missionSuccess : KILL_MARKS.gameOver]);
      // the round clock ran out (match.end): online the leader asks the server to end the round (TIMERSYNC 0), offline we count it
      if (this.match.timedOut) {
        this.match.timedOut = false;
        if (this.bombRoom) this.onMatchEnd?.();
        else { this.match.phase = "live"; this.offlineRoundOver(this.match.defenders); }
      }
    }
  }

  private onPhase(ph: MatchPhase): void {
    if (ph === "countdown") currentMapProps()?.reset(); // broken glass / crates come back every round
    if (this.bomb) {
      this.onBombPhase(ph);
      return;
    }
    if (ph === "countdown") {
      this.hud.clearFeed();
      this.drops?.clear();
      this.spawnEveryone();
    } else if (ph === "live") {
      // kill_message1.i3i MISSION START + MV_Ann_Start_Mission_1 (which of _1/_2/_3 the exe picks is [INFERIDO])
      if (!this.spectating) this.hud.killMark([KILL_MARKS.missionStart]);
    } else if (ph === "ended") {
      const [red, blue] = this.match.score;
      const myTeamWon = this.me.team === 0 ? red > blue : blue > red;
      if (!this.spectating) this.hud.killMark([myTeamWon ? KILL_MARKS.missionSuccess : KILL_MARKS.gameOver]);
      this.onMatchEnd?.();
      // offline: the game is its own server, the end screen comes from here (online: boot.ts on the server's ENDBATTLE)
      if (this.net.mode === "local") {
        this.showFinal({ winner: red === blue ? 2 : red > blue ? 0 : 1, red, blue }, () => (this.onLeave ? this.onLeave() : this.match.restart()));
      }
    }
  }

  /**
   * Away kick (awayChecker.ts, CStageBattle 0x76c360): no mouse / keyboard input for AWAY_INPUT_SEC -> the caution box,
   * then the same exit as the ESC menu's "Sair" (onLeave: GIVEUPBATTLE, back to the room). Real time (clockDt), so a hidden
   * tab stepping at ~1 Hz (main.ts stepOnly) still leaves. Round end and the result screen pause it. A GM / MOD is never
   * checked (0x6b4a70 / 0x6b4ae0); in Bomb a dead or spectating player is re-armed every frame (0x76d120).
   */
  private updateAway(dt: number): void {
    if (!this.onLeave || this.awayGone || this.isGM()) return;
    const rearm = awayRearm(this.input.anyInput, this.match.cfg.mode === "BOMB", this.me.alive);
    const t = this.away.update(dt, rearm, this.match.phase === "ended" || this.finalOn);
    this.awayNotice?.show(t.warn);
    if (!t.kick) return;
    this.awayGone = true;
    console.info("[game] no input for the away limit: leaving the battle (awayChecker.ts)");
    // after this frame: onLeave disposes the game and frees the world that main.ts steps right after update()
    setTimeout(() => { if (!this.disposed) this.onLeave?.("away"); }, 0);
  }

  /**
   * End-of-match screen (GameResult scene): team scores, the user lists, the Score / Reward tabs, the leave button with its countdown.
   * `done` runs on the button or when the time is up (online: back to the room; offline: the lobby, or a new match).
   */
  showFinal(r: { winner: number; red: number; blue: number; exp?: number[] | null; gold?: number[] | null; clan?: { name: string; rank: number; logo: number } | null }, done: () => void): void {
    if (this.finalOn) return;
    this.finalOn = true;
    this.finalT = 0;
    this.finalTab = 0;
    this.finalDone = done;
    // no 5155 before the ENDBATTLE (kill goal / clock): the server counts arrive as 0, the death acks kept the real score in the match
    const none = r.red === 0 && r.blue === 0 && this.match.score[0] + this.match.score[1] > 0;
    this.finalData = { winner: r.winner === 0 || r.winner === 1 ? r.winner : null, red: none ? this.match.score[0] : r.red, blue: none ? this.match.score[1] : r.blue, slotExp: r.exp ?? null, slotGold: r.gold ?? null, clan: r.clan ? { ...r.clan, points: null } : null };
    this.finalEndScreen = this.match.cfg.endScreen;
    this.match.cfg.endScreen = Infinity; // the offline match must not restart under the screen
    this.radio.menu.close();
    // the start / click-to-play blocker (#blocker) shows whenever the pointer is free: the lock may already be off here, and then
    // no pointerlockchange comes to hide it (the handler hides it only on that event)
    document.getElementById("blocker")?.classList.add("hidden");
    this.hud.finalHandlers.ok = () => this.endFinal();
    this.hud.finalHandlers.tab = (i) => { this.finalTab = i; };
    if (document.pointerLockElement) document.exitPointerLock(); // the mouse is needed for the button
  }

  private endFinal(): void {
    if (!this.finalOn) return;
    this.finalOn = false;
    this.finalData = null;
    this.match.cfg.endScreen = this.finalEndScreen;
    this.hud.final(null);
    const d = this.finalDone;
    this.finalDone = null;
    d?.();
  }

  /** clan points of the end screen (clan detail 801, asked after the match by boot.ts): the GameResult clan line shows them once here */
  setFinalClanPoints(points: number): void {
    if (this.finalData?.clan) this.finalData.clan.points = points;
  }

  /** Server-side team score (BATTLE_DEATH_ACK) wins over the locally counted one. */
  setScore(red: number, blue: number): void {
    if (this.bomb) return; // Bomb Mission: the score is rounds (5155 / 5153), not the kill counts of BATTLE_DEATH_ACK
    this.match.score[0] = red;
    this.match.score[1] = blue;
  }

  /** ESC menu buttons of the battle social layer (Denunciar / Votar para expulsar / Reportar bug); both the menu and the social part load async */
  private wireSocialMenu(): void {
    const m = this.escMenu, s = this.social;
    if (!m || !s) return;
    m.setSocial({ report: () => s.openReport(), banVote: () => s.openBanVote(), leaderVote: () => s.openLeaderVote(), bug: () => s.openBug() });
  }

  /** Removes everything this Game added to the scene/page; the caller drops the renderer/world. */
  dispose(): void {
    this.disposed = true;
    setRagdollSystem(null);
    this.unhookRoom?.();
    this.unhookRoom = null;
    this.unwatchMissions?.();
    this.unwatchMissions = null;
    this.botHostUnsub?.();
    this.botHostUnsub = null;
    for (const r of this.remotes.values()) r.dispose();
    this.remotes.clear();
    this.shadowVisual?.dispose();
    this.dropCorpse();
    this.ambient?.dispose();
    this.drops?.clear();
    this.bombVis?.dispose();
    this.devMenu?.dispose();
    this.obsHud?.dispose();
    this.radio?.dispose();
    this.weapons?.dispose?.();
    this.input.dispose();
    this.hud.dispose();
    this.nameTags.dispose();
    document.getElementById("pbhud")?.remove();
    this.onMatchEnd = null;
    this.unsubSettings?.();
    this.unsubSettings = null;
    this.social?.dispose();
    this.social = null;
    this.escMenu?.dispose();
    this.awayNotice?.dispose();
    this.awayNotice = null;
    // the respawn HUD / T panel lived on after the match: its notice stayed on screen and its T key listener opened
    // a stale panel over the next match
    this.respawnMenu?.dispose();
    this.respawnMenu = null;
    this.escAbort.abort();
  }

  // ---- Weapons / net wiring ----
  private wireWeapons(): void {
    this.weapons.onFire((e) => {
      this.firing = true;
      this.lastFire.set(this.me.id, this.time);
      this.lastHeavy = !!e.heavy;
      this.me.invulnUntil = Math.min(this.me.invulnUntil, this.time); // firing drops spawn protection
      this.player.addRecoil(e.recoilPitch, e.recoilYaw);
      // WeaponGrenade::Throw 0x62ebb3: the thrower's own "Granada!" (AUTO 1: voice only) + radio 0x1f to the team
      if (e.thrown) this.sendRadio(radioId(3, 1));
      this.shadowVisual.fire();
    });
    this.weapons.onHit((e) => {
      const target = e.hit.actorId ? this.actorById(e.hit.actorId) : null;
      if (target && e.hit.zone) {
        // a hit without a bullet id (knife) must drop the old bullet, else a later kill reads as Piercing Shot
        this.shotKills.hit(target.id, e.shot, !!e.explosion);
        const falloff = e.final ? 1 : rangeFalloff(e.hit.distance, e.range, e.dpdRate);
        this.applyHit(this.me, target, e.weapon, e.damage, e.helmetPenetrate, e.hit.zone, falloff, e.hit.point, !!e.final, e.from, e.explosion);
      }
    });
  }

  private wireNet(): void {
    if (this.net.mode === "local") return;
    // AI rooms: the match host owns the bots; a host change moves them (adoptBots / releaseBots)
    this.botHostUnsub = this.net.onBotHost?.((host) => { if (host) this.adoptBots(); else this.releaseBots(); }) ?? null;
    const unYield = this.net.onBotYield?.((id) => {
      const i = this.bots.findIndex((b) => b.id === id);
      if (i < 0) return;
      const [bot] = this.bots.splice(i, 1);
      this.hitColliders.remove(id);
      this.respawnAt.delete(id);
      bot.dispose();
      this.match.removeActor(id);
    });
    if (unYield) { const prev = this.botHostUnsub; this.botHostUnsub = () => { prev?.(); unYield(); }; }
    this.net.onRemoteState((s: PlayerState) => {
      if (s.id === this.me.id) return;
      if (this.bots.some((b) => b.id === s.id)) return; // a late buffered state of a bot we adopted
      // WeaponSync carries the item id: its weapons.json name (HUD / kill feed / fire sound by name)
      const held = s.weaponId ? this.pbWeapons()?.db.def(s.weaponId) : undefined;
      if (held && held.name !== s.weapon) s = { ...s, weapon: held.name };
      let r = this.remotes.get(s.id);
      if (r) {
        r.fireGap = held?.fireDelay ?? 0;
        r.fireHeld = !held || held.fireMode === "auto" || held.fireMode === "burst";
      }
      if (!r) {
        r = new RemoteActor(s.id, s, this.scene);
        r.protectTime = this.match.cfg.spawnProtect;
        const ra = r;
        // scratch for the remote fire/silencer events: every consumer (audio.start, effects, shoot) copies what it keeps
        const tMuzzle = new THREE.Vector3(), tEye = new THREE.Vector3(), tDir = new THREE.Vector3();
        // the equipped character arrived / loaded (RESPAWN 5138): the bone hitboxes belong to the new model
        ra.onVisualChanged = () => {
          this.hitColliders.remove(ra.id);
          this.hitColliders.add(ra);
        };
        // positional weapon-fire sound (net torsoAction "fire" edge, RemoteActor.playFire)
        ra.onFire = () => {
          const db = this.pbWeapons()?.db;
          const def = (ra.weaponId && db?.def(ra.weaponId)) || (db && db.find(ra.weaponName) && db.def(db.find(ra.weaponName)!.id));
          if (!def) return;
          const muzzle = ra.muzzle(tMuzzle);
          this.pbWeapons()?.audio.fireAt(def, muzzle, ra.id, { silencer: ra.silencerOn, zoom: ra.aiming });
          // flash + tracer + impact from the replicated aim (eye ray; the shot itself is the shooter's own client). The ray takes
          // the last replicated angles (viewDir), not the body's smoothed aim: the packet that carries the "fire" edge holds the
          // angles of that shot, the lerped aim lags behind it and put the wall mark beside where he was looking
          if (def.family === "KNIFE" || def.family === "GRENADE") return;
          const hit = this.shoot(ra, ra.eye(tEye), ra.viewDir(tDir), def.range * 1.5 || 200);
          if (hit.colliderHandle !== undefined && !hit.actorId && hit.distance <= def.range) this.damageMapProp(hit.colliderHandle, def.params.damage, null);
          this.grazeMe(ra, tEye, tDir, def.range);
          // watched in FPS: his body is hidden, the tracer starts at the arms' muzzle and the flash is observeFire's
          const fps = this.watchedInFps(ra) ? this.pbWeapons()?.observedMuzzle(tMuzzle) : null;
          this.pbWeapons()?.worldShot(def.id, fps ?? muzzle, hit.point, hit.distance < Infinity
            ? { normal: hit.normal, actor: !!hit.actorId, colliderHandle: hit.colliderHandle } : null, { flash: !fps, tint: this.muzzleTintOfId(ra.id) });
        };
        // the others hear the plant / defuse hold (WM_C4_Take / disarm clip) from the holder's position
        ra.onBombHold = (kind) => {
          if (kind) this.bombVis?.remoteHold(ra.id, kind, ra.feet(new THREE.Vector3()));
          else this.bombVis?.remoteStop(ra.id);
        };
        ra.onSilencer = (on) => {
          const db = this.pbWeapons()?.db;
          const def = ra.weaponId ? db?.def(ra.weaponId) : undefined;
          if (def) this.pbWeapons()?.audio.silencerAt(def, on, ra.muzzle(tMuzzle));
        };
        this.remotes.set(s.id, r);
        // a player who starts the battle after us (the round-start burst is over): CStageBattle::_ProcessEvent_StartBattle 0x776680
        if (this.time > 6) this.hud.notice(s.name, tOr("STBL_IDX_GAME_INTRODUCE_PLAYER", " Entrou no combate."));
        this.match.addActor(r);
        this.hitColliders.add(r);
      } else r.apply(s);
      if (s.firing) r.lastFire = this.time;
    });
    this.net.onRemoteLeave((id) => {
      const left = this.remotes.get(id);
      if (left) this.hud.notice(left.name, tOr("STBL_IDX_GAME_BYE_PLAYER", " Deixou o combate.")); // ProcessGameContext 0x768fa5
      this.remotes.get(id)?.dispose();
      this.remotes.delete(id);
      this.match.removeActor(id);
      this.hitColliders.remove(id);
      // 1v1 (and any match with no bots): the opponent quitting leaves no enemy left, so end the
      // round instead of leaving the remaining player stuck in a "live" match that never finishes.
      // Offline only: online the server ends it (GIVEUP -> 5140 ENDBATTLE to the stayer, boot.ts shows the result). A local end
      // here ran after that (the slot update follows the 5140) and, in Bomb, sent the leader's TIMERSYNC 0 into a finished round.
      if (this.match.live && left && this.net.mode === "local") {
        const enemyLeft = [...this.actors()].some((a) => a.team !== left.team);
        if (!enemyLeft) this.match.end();
      }
    });
    this.net.onRemoteHit((e) => {
      // a remote player's hit on a bot WE host: the bot is ours, so its hp is ours to take
      const bot = this.bots.find((b) => b.id === e.victimId);
      if (bot) {
        const attacker = this.actorById(e.attackerId);
        const at = new THREE.Vector3(e.point[0], e.point[1], e.point[2]);
        if (attacker && bot.alive) this.noteDeathHit(attacker, bot, e.weapon, e.baseDamage, e.zone, at);
        if (attacker && bot.alive) this.applyHitLocal(attacker, bot, e.weapon, e.baseDamage, e.helmetPenetrate, e.zone, e.falloff, at, !!e.preScaled, true);
        return;
      }
      if (e.victimId !== this.me.id) {
        // third-party: this remote may die of it (its ragdoll push / death clip side)
        const victim = this.actorById(e.victimId);
        if (victim && e.attackerId !== this.me.id) this.noteDeathHit(this.actorById(e.attackerId), victim, e.weapon, e.baseDamage, e.zone, new THREE.Vector3(e.point[0], e.point[1], e.point[2]));
        // third-party: not the shooter (already popped locally in applyHit) and not the victim (handled below) —
        // original PB shows the drop to everyone in the room, so pop the same visual here too, exactly once.
        if (e.helmetBlocked && e.attackerId !== this.me.id) {
          const target = this.actorById(e.victimId);
          if (target && target.kind === "remote" && target.helmet) {
            target.helmet = false;
            this.popHelmet(target, this.actorById(e.attackerId));
          }
        } else if (e.zone === "head" && e.attackerId !== this.me.id) {
          const target = this.actorById(e.victimId);
          if (target && target.kind === "remote") this.popBeret(target, this.actorById(e.attackerId), e.zone, false);
        }
        return;
      }
      if (!this.me.alive) return;
      const attacker = this.actorById(e.attackerId);
      const res = computeDamage({ target: this.me, attacker, base: e.baseDamage, zone: e.zone, helmetPenetrate: e.helmetPenetrate, falloff: e.falloff, preScaled: e.preScaled, now: this.time, room: this.room });
      if (res.blocked) return;
      // victim side: our own helmet state decides (computeDamage pops it); the attacker's helmet roll is already in
      // the damage (src/weapons), so 0 dealt = the helmet saved us -> HELMET PROTECTION is ours
      if (res.helmetBlocked) {
        this.popHelmet(this.me, attacker);
        if (res.dealt === 0) this.helmetProtection(attacker);
      } else this.popBeret(this.me, attacker, e.zone, false);
      this.me.onDamaged(attacker, res.dealt, e.zone);
      if (res.dealt > 0) {
        this.pbWeapons()?.blastHurt(e.weapon);
        this.charSfx?.hurt(this.me.feet(new THREE.Vector3()), e.zone === "head", true);
        this.charSfx?.ownHurt(this.me.feet(new THREE.Vector3()), this.myCharaIsFemale(), this.me.hp, res.dealt);
      }
      if (res.killed) this.onDeath(this.me, attacker, e.weapon, res.headshot);
    });
    const pw = this.pbWeapons();
    // medical kit (WeaponSystem.updateHeal): the local character is a target while hurt, a hit heals it up to max HP
    if (pw) {
      pw.healBody = () => (this.me.hp > 0 && this.me.hp < this.me.maxHp
        ? { feet: this.me.feet(new THREE.Vector3()), headY: blastPoints(this.me).head.y } : null);
      pw.onHeal = (amount) => {
        if (this.me.hp > 0) this.me.hp = Math.min(this.me.maxHp, this.me.hp + amount);
      };
    }
    if (pw && this.net.sendThrow) {
      const mySlot = /^slot(\d+)$/.exec(this.net.localId) ? Number(this.net.localId.slice(4)) : 0;
      pw.onThrowNet = ({ state, g, pos, vel }) => {
        let idx = this.localThrowIdx.get(g);
        if (idx === undefined) {
          idx = ((mySlot & 0x0f) << 4) | (this.throwSeq++ & 0x0f);
          this.localThrowIdx.set(g, idx);
        }
        this.net.sendThrow?.({ actorId: this.me.id, idx, state, weaponId: g.weapon.id, pos: [pos.x, pos.y, pos.z], vel: [vel.x, vel.y, vel.z] });
      };
    }
    this.net.onRemoteThrow?.((e) => this.remoteThrow(e));
    this.net.onRemoteDropped?.((e: DroppedSyncEvent) => {
      const at = new THREE.Vector3(...e.pos);
      let d = this.findRemoteDrop(e.idx, e.weaponId, e.actorId, at);
      // its DropWeapon event was lost (UDP): the stream carries enough to put the weapon down anyway
      if (!d) d = this.drops.spawn({ idx: e.idx, weaponId: e.weaponId, slot: e.slot, ammo: e.ammo, extra: e.extra, reserve: e.reserve, owner: e.actorId, local: false, death: e.death }, at, 0);
      this.drops.place(d.idx, at, e.resting);
    });
    this.net.onRemoteDrop?.((e: WeaponDropEvent) => {
      const a = this.actorById(e.actorId);
      const feet = e.pos ? new THREE.Vector3(...e.pos) : a?.feet(new THREE.Vector3()) ?? new THREE.Vector3();
      this.drops.spawn({ idx: e.idx, weaponId: e.weaponId, slot: e.slot, ammo: e.ammo, extra: e.extra, reserve: e.reserve, owner: e.actorId, local: false, death: e.death },
        feet, e.yaw ?? a?.yaw() ?? 0);
    });
    this.net.onRemotePickup?.((e: WeaponDropEvent) => {
      const d = this.drops.field.drops.get(e.idx);
      if (d && d.weaponId === e.weaponId) this.drops.remove(e.idx);
      else {
        // our predicted index of our own drop can differ from the server counter: the same weapon nearest to the picker
        const at = e.pos ? new THREE.Vector3(...e.pos) : this.actorById(e.actorId)?.feet(new THREE.Vector3());
        let best: DroppedWeapon | null = null, bd = Infinity;
        for (const x of this.drops.field.drops.values()) {
          if (x.weaponId !== e.weaponId) continue;
          const dist = at ? Math.hypot(x.pos.x - at.x, x.pos.y - at.y, x.pos.z - at.z) : 0;
          if (dist < bd) { bd = dist; best = x; }
        }
        if (best) this.drops.remove(best.idx);
      }
    });
    this.net.onRemotePropBreak?.((i) => currentMapProps()?.breakIndex(i));
    this.net.onRemoteRadio?.((e) => {
      const a = this.actorById(e.actorId);
      if (a && !this.social?.isBlockedNick(a.name)) this.radio.receive(e.id, a.name, a.team, this.me.team, radioVoiceOf(a.chara, a.team)); // /bloquear also mutes the radio
    });
    this.net.onRemoteKill((e) => {
      const victim = this.actorById(e.victimId);
      if (!victim || victim === this.me) return;
      victim.alive = false;
      this.match.registerKill({ killer: e.killerId ? this.actorById(e.killerId) : null, victim, weapon: e.weapon, headshot: e.headshot, time: this.time });
    });
  }

  private sendState(): void {
    if (this.spectating) return; // sits the round out: no state, so the others never create a (dead) body for us
    const f = this.me.feet(this._v);
    const v = this.player.velocity;
    const ws = this.weapons.getState();
    const speed = Math.hypot(v.x, v.z);
    const moving = this.me.alive && speed > 0.15;
    // real client priority (net/battle.ts torsoAction): fire/reload/change are transient one-shots, zoom is the
    // sustained ADS stance; recentlyFired matches the minimap's own "recently fired" window (updateHud) so a shot
    // between two sendState ticks (every 50 ms) still lands in at least one packet.
    const recentlyFired = this.time - (this.lastFire.get(this.me.id) ?? -999) < 0.15;
    const torsoAction: PlayerState["torsoAction"] = this.bomb?.action === "plant"
      ? "plant"
      : this.bomb?.action === "defuse"
      ? "defuse"
      : recentlyFired
      ? "fire"
      : ws.reloading
        ? "reload"
        : this.time < this.changeUntil
          ? "change"
          : this.pbWeapons()?.isThrowReady()
            ? "ready"
            : this.netAiming
              ? "zoom"
              : "idle";
    this.net.sendState({
      id: this.me.id,
      name: this.me.name,
      team: this.me.team,
      pos: [f.x, f.y, f.z],
      vel: [v.x, v.y, v.z],
      yaw: this.player.yaw,
      pitch: this.player.pitch,
      crouch: this.player.isCrouching(),
      alive: this.me.alive,
      hp: this.me.hp,
      weapon: ws.name,
      weaponId: this.pbWeapons()?.getHudState().id || undefined,
      weaponSlot: ws.slot,
      silencer: this.pbWeapons()?.getHudState().silencer,
      firing: this.firing,
      torsoAction,
      heavy: torsoAction === "fire" && this.lastHeavy,
      moving,
      running: moving && !this.player.isSilent(),
      moveDir: moveDir8(v, this.player.yaw),
      airborne: this.me.alive && !this.player.isGrounded(),
      zoomType: this.netAiming && (this.shadowVisual.anim?.zoomCapable ?? false) ? 2 : 0,
      chara: this.localChara,
      t: performance.now(),
    });
  }

  // ---- Frame ----
  /** dt = clamped step (physics/animation); wallDt = real elapsed, so the match clock (spawn protection, timers) keeps
   *  real time when the tab is occluded/throttled (rAF paused, ~1 Hz timer) instead of running ~20x slow. */
  update(dt: number, wallDt = dt): void {
    const clockDt = Math.min(Math.max(wallDt, dt), 10);
    this.time += clockDt;
    this.match.update(clockDt);
    this.updateAway(clockDt);
    this.updateBomb(dt);
    this.ambient?.update(dt, this.me.alive ? this.me.feet(this._w) : null);
    const inp = this.input;
    const live = this.match.live;
    this.firing = false;

    // Player
    if (this.me.alive) {
      const landing = this.player.update(dt, {
        move: live && !this.escMenu?.isOpen && !this.finalOn, look: inp.locked && !this.finalOn, aiming: !!this.weapons.getState().zoomFov,
        hold: !!this.bomb?.action, // plant / defuse hold: forced crouch, no walk / jump (Cmd_Install 0x78ade0, Cmd_Uninstall 0x78ee00)
      });
      const fd = this.player.fallDamage(landing); // title FallDown_Damage raises the min height (player.titleMove.fall)
      if (fd > 0 && live) {
        this.me.hp = Math.max(0, this.me.hp - fd);
        this.me.onDamaged(null, fd, "limb");
        if (this.me.hp <= 0) this.onDeath(this.me, null, "Queda", false);
      }
      const feetY = this.me.feet(this._v).y;
      // footsteps / jump / land (CH_<terrain>_*): terrain from a ray under the feet
      const grounded = this.player.isGrounded();
      if (this.charSfx) {
        const feet = this.me.feet(this._stepFeet);
        const surf = this.surfaceUnder(feet);
        const v = this.player.velocity, hs = Math.hypot(v.x, v.z);
        const crouch = this.player.isCrouching();
        if (this.wasGrounded && !grounded) this.charSfx.jump(feet, surf, true);
        else if (!this.wasGrounded && grounded) { this.charSfx.land(feet, surf, true); this.stepDist = 0; }
        else if (grounded && hs > 0.3 && !this.player.isSilent()) {
          this.stepDist += hs * dt;
          // PB step cadence: ~4.5 steps/s at run (6.5 m/s) -> ~1.4 m per step; crouch is quieter and slower
          const stride = crouch ? 1.8 : 1.4;
          if (this.stepDist >= stride) {
            this.stepDist = 0; this.stepLeft = !this.stepLeft;
            this.charSfx.step(feet, surf, this.stepLeft, true, crouch);
          }
        }
      }
      this.wasGrounded = grounded;
      if (this.bounds && feetY < this.bounds.min.y - 10 && this.me.alive) this.onDeath(this.me, null, "Queda", false);
      this.player.updateCamera();
      this.endObserver();
    } else {
      // death camera first (the corpse's bone pose); a round observer then takes over with a 0.1 s blend from it
      this.deathCam(dt);
      if (!((this.bomb || this.spectating) && this.spectateCam(dt))) this.endObserver();
      else this.blendDeathCam(dt);
    }
    // Weapons (always ticked so reloads progress; input only while alive + live + locked)
    const canShoot = this.me.alive && live && inp.locked && !this.finalOn;
    const canSwap = this.me.alive && inp.locked && !this.finalOn;
    this.localAiming = canShoot && inp.button(2);
    this.netAiming = this.me.alive && (this.pbWeapons()?.getHudState().aiming ?? this.localAiming); // last frame's weapon state
    this.shadowVisual.setHelmet(actorHeadgearOn(this.me.id, this.me.helmetLost));
    this.shadowVisual.update(dt, {
      pos: this.me.feet(this._shadowFeet),
      yaw: this.player.yaw,
      pitch: this.player.pitch,
      vel: this.player.velocity,
      crouch: this.player.isCrouching(),
      grounded: this.player.isGrounded(),
      alive: this.me.alive,
      zoom: this.netAiming,
    });

    // Radio (key map slots 32-34 Z / X / C): an open menu takes the digit keys from the weapon slots
    let radioDigits = false;
    if (canShoot) {
      for (const code of RADIO_INPUT_CODES) {
        if (!inp.keyPressed(code)) continue;
        const r = this.radio.press(code);
        if (r.consumed && !RADIO_MENU_CODES.includes(code)) radioDigits = true;
        if (r.send !== null) this.sendRadio(r.send);
      }
    } else this.radio.menu.close();
    // G = drop (key map slot 22 -> ProcessDropWeapon 0xa21070)
    if (canShoot && pressed(inp, "drop") && this.drops.field.canDrop() && !this.c4InHand()) {
      const d = this.pbWeapons()?.dropCurrent();
      if (d) this.localDrop(d.def.id, d.slot, d.ammo, d.reserve, false);
    }
    const wi: WeaponInput = {
      fire: canShoot && inp.button(0),
      firePressed: canShoot && inp.buttonPressed(0),
      aim: this.localAiming,
      cancelZoom: this.match.phase === "ended" || this.finalOn,
      reload: canShoot && pressed(inp, "reload"),
      switchSlot: radioDigits || !this.me.alive || this.finalOn ? null : slotPressed(inp),
      // Q = last weapon (exe key map slot 19 -> stroke 0x20000 -> ProcessWeapon 0xa23639); QQ cancels a bolt / pump cycle
      // swapping is not tied to the live phase: the digit keys already worked in the countdown / round-end result; Q and the wheel
      // were the ones dead there [INFERIDO]: no exe gate on the round-end state was found (no disassembler/dump; ProcessWeapon 0xa21c00 reads only the stroke bits)
      lastWeapon: canSwap && pressed(inp, "lastWeapon"),
      extension2: canShoot && pressed(inp, "extension2"),
      cycle: canSwap ? inp.wheel : 0,
    };
    this.hitColliders.sync();
    const eye = this.player.eyePosition(this._eye);
    const fwd = this.camera.getWorldDirection(this._fwd);
    this.weapons.update(dt, wi, {
      now: this.time,
      origin: eye,
      forward: fwd,
      camera: this.camera,
      crouching: this.player.isCrouching(),
      grounded: this.player.isGrounded(),
      moveRatio: this.player.speedRatio(),
      shoot: (o, d, max) => {
        const r = this.shoot(this.me, o, d, max);
        return r;
      },
    });
    const ws = this.weapons.getState();
    this.me.weaponName = ws.name;
    if (ws.name && ws.name !== this.shadowWeaponName) {
      // the weapon's own PB upper-body AI (reload/change/attack clips), same as RemoteActor.apply
      const first = !this.shadowWeaponName;
      this.shadowWeaponName = ws.name;
      this.shadowVisual.setWeapon(ws.name);
      void bindWeaponAnim(this.shadowVisual.anim, ws.name, undefined, this.shadowVisual.animSkel).then(() => {
        if (!first) this.shadowVisual.change();
      });
      if (!first) this.changeUntil = this.time + 0.35;
    }
    if (ws.reloading && !this.wasReloading) this.shadowVisual.reload();
    this.wasReloading = ws.reloading;
    const ready = !!this.pbWeapons()?.isThrowReady();
    if (ready && !this.wasThrowReady) this.shadowVisual.throwReady(); // own shadow: the pin-out pose too
    this.wasThrowReady = ready;

    // Bots / remotes
    const perfBots = botPerf();
    const tBots = performance.now();
    for (const b of this.bots) {
      b.update(dt);
      if (b.alive && this.bounds && b.feet(this._v).y < this.bounds.min.y - 10) this.onDeath(b, null, "Queda", false);
      // bot footsteps (same cadence as the local player, heard by everyone — the exe plays them too)
      if (b.alive && this.charSfx) {
        const feet = b.feet(this._botFeet);
        let s = this.actorSteps.get(b.id);
        if (!s) { s = { prev: feet.clone(), dist: 0, left: false }; this.actorSteps.set(b.id, s); }
        const moved = feet.distanceTo(s.prev);
        if (moved < 3) s.dist += moved; // skip teleports (respawn)
        s.prev.copy(feet);
        const crouch = b.isCrouching();
        const stride = crouch ? 1.8 : 1.4;
        if (s.dist >= stride) {
          s.dist = 0; s.left = !s.left;
          const tS = performance.now();
          this.charSfx.step(feet, this.surfaceUnder(feet), s.left, false, crouch);
          perfBots.steps += performance.now() - tS;
        }
      }
    }
    for (const r of this.remotes.values()) r.update(dt);
    perfBots.loop += performance.now() - tBots;

    // Dropped weapons: lifetime / fall, and the automatic pick-up search (0xa11f40, every 0.25 s)
    if (this.drops.update(dt) && live) this.searchPickup();
    this.helmetDrops.update(dt);
    ragdolls?.update();
    currentMapProps()?.update(dt);
    if (this.dropStream.size) this.streamDrops();
    this.radio.update(dt, this.match.phase !== "ended");
    this.social?.update(clockDt);

    // Respawns
    for (const [id, t] of this.respawnAt) {
      if (this.time < t || this.match.phase === "ended") continue;
      // weapon change panel (T) open: the respawn waits for its OK / Cancel, so the pick applies to this life
      // [INFERIDO from STR_TBL_BATTLEGUI_NOTICE_LEAVEROOM: the original can hold it]
      if (id === this.me.id && this.respawnMenu?.isOpen) continue;
      const a = this.actorById(id);
      if (a && a.kind !== "remote") this.spawnActor(a);
      else this.respawnAt.delete(id);
    }

    // Net
    this.netSendIn -= dt;
    if (this.netSendIn <= 0) {
      this.netSendIn = 0.05;
      this.sendState();
    }
    // the room's bots (this client is the match host): one record each, 25 Hz, a hit or a death goes out at once
    if (this.bots.length && this.net.botSendDue?.()) this.net.sendBotStates?.(this.bots.map((b) => b.netState()));

    // Camera FOV (ADS)
    const wantFov = this.me.alive && ws.zoomFov ? ws.zoomFov : baseFovNow();
    if (!this.weapons.ownsCamera && Math.abs(this.camera.fov - wantFov) > 0.05) {
      this.camera.fov += (wantFov - this.camera.fov) * Math.min(1, dt * 14);
      this.camera.updateProjectionMatrix();
    }

    this.weapons.setVisible?.(this.me.alive || (!!this.specTarget && this.obsView === "fps")); // the observer sees the target's arms + weapon in his first-person view only
    this.updateHud(dt, ws.spreadDeg);
    inp.endFrame();
  }

  /**
   * Observer of the round modes (CStageBattle::ProcessObserverMode 0x76ab80, rules and camera math in game/observer.ts): the
   * dead and the late joiners watch a living teammate; the room's observer rules pick the views (Space walks them:
   * OBSERVER third person, OBSERVER2 orbit, FLY, FPS = his own eyes), the mouse buttons pick the target, the HUD shows the
   * help band, his nick with " (HP nnn)" and the HP list. False = nobody to watch (the free death camera takes over).
   */
  private spectateCam(dt: number): boolean {
    const inp = this.input, me = this.me;
    const rules = observerRules(this.net.watchRule ?? (this.offlineSpectate ? WATCH.ON | WATCH.ENEMY | WATCH.ENEMY_HP | WATCH.THIRD : DEFAULT_WATCH));
    const gm = this.isGM();
    // the GM block ignores the room watch rules: FLY, both teams and their HP list, every view; before the target list is built [INFERIDO, 6.3]
    if (gm) Object.assign(rules, { on: true, enemy: true, enemyHp: true, third: true, firstOnly: false });
    const others = [...this.actors()].filter((a) => a !== me);
    // 0x76af80: nobody of the own team is left alive -> the enemy team can be watched even when the room forbids it
    if (!this.obsAllyLatch && !others.some((a) => a.alive && a.team === me.team)) this.obsAllyLatch = true;
    const list = observeList(others.map((a) => ({ id: a.id, team: a.team, slot: this.slotOf(a), alive: a.alive })), me.team, rules.enemy || this.obsAllyLatch);
    const byId = (id: string) => others.find((a) => a.id === id) ?? null;

    if (this.obsFirstFrame) { this.obsView = entryView(rules); this.obsFirstFrame = false; this.applyObsFov(); }
    if (inp.locked && inp.keyPressed("Space")) this.setObsView(nextView(this.obsView, rules));
    if (this.obsView === "fly" && !rules.on) this.setObsView("fps"); // the room forbids the FLY camera
    const fly = this.obsView === "fly";

    // target: keep the watched player while he lives, hold on his body 3 s after he dies (0x76b04b), then move on
    let t = this.specTarget && byId(this.specTarget.id) ? this.specTarget : null;
    if (t && !t.alive) {
      this.obsDeadT += dt;
      if (this.obsDeadT > DEAD_TARGET_HOLD) t = null;
    } else this.obsDeadT = 0;
    if (!t) {
      // the target left the list (died): the next one in the old order; a first pick / a target that is still listed steps normally
      const s = this.specTarget && !list.some((x) => x.id === this.specTarget!.id) && this.obsIdx >= 0 ? nextAfterDead(list, this.obsIdx) : stepTarget(list, this.specTarget?.id ?? null, 1);
      t = s ? byId(s.id) : null;
    }
    let gmDir: -1 | 0 | 1 = 0;
    if (gm && inp.locked) gmDir = this.gmKeys();
    if (inp.locked && !fly) {
      const dir = gmDir || (inp.buttonPressed(0) ? -1 : inp.buttonPressed(2) ? 1 : 0); // left = NEXT, right = PREV (0x76b810 / 0x76b970)
      if (dir) { const s = stepTarget(list, t?.id ?? null, dir); if (s) t = byId(s.id); }
    }
    if (this.gmPick) { const p = byId(this.gmPick); if (p && list.some((x) => x.id === p.id)) t = p; this.gmPick = null; }
    if (t !== this.specTarget) this.setSpecTarget(t);
    this.obsIdx = t ? list.findIndex((x) => x.id === t!.id) : -1;

    this.obsAskEquip(others, dt);
    const hud = this.obsHudGet();
    if (!t && !fly) {
      if (!rules.on) { hud.setVisible(false); return false; }
      this.setObsView("fly"); // nobody to watch and the FLY camera is allowed: free flight from where the view was
    }
    hud.setVisible(this.obsView !== "fly" && !this.gmHudOff);
    hud.setHelpImage(inp.key("F1"), gm); // F1 held: help_observer.i3i for a GM, else help.i3i (0x73f1a0)
    this.obsHudMode = this.obsView === "fly" ? "fly" : "view";
    if (this.obsView === "fly") return this.flyCam(dt);
    if (!t) return false;

    if (this.obsView === "fps") this.fpsObserveCam(t);
    else this.thirdObserveCam(t, this.obsView === "third2");
    this.observeArms(t, dt);
    hud.setNick(observedNickText(t.name, t.hp), t.team, gm);
    hud.setBadge(gm && gmNickView.ids ? this.slotOf(t) : null); // F9: the target's seat badge (0x7628e6)
    this.obsRows(hud, rules);
    return true;
  }

  private isGM(): boolean {
    return this.gmParam || chat.isGM || !!(this.net as unknown as { room?: { isGM?: boolean } | null }).room?.isGM; // chat.isGM: the server's GM notice in the lobby
  }

  /** GM keyboard block (observerGm.ts): returns a target step (-1 / 1) for Shift+1 / Shift+2; the view, saved positions and F5 act here */
  private gmKeys(): -1 | 0 | 1 {
    const inp = this.input, shift = inp.key("ShiftLeft") || inp.key("ShiftRight"), ctrl = inp.key("ControlLeft") || inp.key("ControlRight");
    let step: -1 | 0 | 1 = 0;
    const bracket = inp.key("BracketLeft") ? 0 : inp.key("BracketRight") ? 1 : null;
    for (const code of ["F5", "F9", "Backquote", "Equal", "Minus", ...Array.from({ length: 10 }, (_, i) => `Digit${i}`)]) {
      if (!inp.keyPressed(code)) continue;
      const a = gmAction(code, shift, ctrl, bracket);
      if (!a) continue;
      switch (a.t) {
        case "prevTarget": step = -1; break;
        case "nextTarget": step = 1; break;
        case "viewFly": this.setObsView("fly"); break;
        case "toggleHud": this.gmHudOff = !this.gmHudOff; break;
        case "pickPlayer": { // 0x760360(team, n): the n-th player of that team by slot
          const p = [...this.actors()].filter((x) => x !== this.me && x.team === a.team).sort((x, y) => this.slotOf(x) - this.slotOf(y))[a.n - 1];
          if (p) this.gmPick = p.id;
          break;
        }
        case "toggleNicks": gmNickView.nicks = !gmNickView.nicks; break;
        case "toggleIds": gmNickView.ids = !gmNickView.ids; break;
        case "nickSize": this.gmNickSize = nickSizeStep(this.gmNickSize, a.d); break;
        case "savePos": if (this.obsView === "fly") { const p = this.flyPos; this.gmPos.save(a.n, { x: p.x, y: p.y, z: p.z, yaw: this.flyYaw, pitch: this.flyPitch }); } break;
        case "gotoPos": {
          const p = this.gmPos.get(a.n);
          if (!p) break;
          this.setObsView("fly");
          this.flyPos.set(p.x, p.y, p.z); this.flyYaw = p.yaw; this.flyPitch = p.pitch;
          break;
        }
      }
    }
    return step;
  }

  /** a player joined mid-round never saw the others' 5138: ask the server (3666) for every remote whose character is still unknown, every 3 s */
  private obsAskEquip(others: Actor[], dt: number): void {
    this.obsEquipT -= dt;
    if (this.obsEquipT > 0) return;
    this.obsEquipT = 3;
    const room = (this.net as unknown as { room?: { requestEquip?(slot: number): void } | null }).room;
    for (const a of others) if (a instanceof RemoteActor && !a.chara) room?.requestEquip?.(this.slotOf(a));
  }

  /** patente of a "slotN" actor from the room's slot list (SlotInfo.rank); undefined offline / for bots */
  private rankOfId(id: string): number | undefined {
    // the local row: the account's profile rank (the room only holds a placeholder 0 for our own slot after ROOM_CREATE)
    if (id === this.me.id && this.localRank !== undefined) return this.localRank;
    const bot = this.bots.find((b) => b.id === id);
    // bots have no account: rank from their AI level (1..10 -> 4..40) [RECRIADO]
    if (bot) return Math.max(1, Math.min(10, Math.round(bot.skill * 10))) * 4;
    const m = /^slot(\d+)$/.exec(id);
    const room = (this.net as unknown as { room?: { slots?: { rank: number; nick: string }[] } | null }).room;
    const s = m ? room?.slots?.[Number(m[1])] : undefined;
    return s?.nick ? s.rank : undefined;
  }

  /** clan emblem logo of a "slotN" actor from the room's slot list (SlotInfo.clanLogo, roomClient.ts); undefined offline / bots / no clan */
  private clanLogoOfId(id: string): number | undefined {
    const m = /^slot(\d+)$/.exec(id);
    const room = (this.net as unknown as { room?: { slots?: { clanLogo?: number; clan?: string; nick: string }[] } | null }).room;
    const s = m ? room?.slots?.[Number(m[1])] : undefined;
    return s?.nick && s.clan ? s.clanLogo : undefined;
  }

  /** 1600187 muzzle colour of a player's flash: NICK_COLORS[room slot muzzle index] [RECRIADO palette]; 0 / bots / no slot = the weapon's own colour */
  private muzzleTintOfId(id: string): Tint | undefined {
    const m = /^slot(\d+)$/.exec(id);
    const room = (this.net as unknown as { room?: { slots?: { muzzleColor?: number }[] } | null }).room;
    const k = m ? room?.slots?.[Number(m[1])]?.muzzleColor ?? 0 : 0;
    return k > 0 ? NICK_COLORS[k] : undefined;
  }

  /** Tab nick colour: the room slot's nick colour (0x73aeb2 CHUD_Score reads the table at the row's colour byte); bots have no slot */
  private nickColorOfId(id: string): number | undefined {
    const m = /^slot(\d+)$/.exec(id);
    const room = (this.net as unknown as { room?: { slots?: { nick: string; nickColor?: number }[] } | null }).room;
    const s = m ? room?.slots?.[Number(m[1])] : undefined;
    return s?.nick ? s.nickColor ?? 0 : undefined;
  }

  /** slot number of an actor (net actors are); bots / others follow in the order they were first seen */
  private slotOf(a: Actor): number {
    const m = /^slot(\d+)$/.exec(a.id);
    if (m) return Number(m[1]);
    let i = this.obsSeq.get(a.id);
    if (i === undefined) { i = this.obsSeq.size; this.obsSeq.set(a.id, i); }
    return 100 + i;
  }

  /** the observer HUD: help band + lines + HP list (CHud::CreateHUD 0x744790, CHUD_ObserverHPGauge) */
  private obsHudGet(): ObserverHud {
    if (!this.obsHud) {
      const hud = this.obsHud = new ObserverHud();
      const key = (PB_KEYS.changeWeapon[0] ?? "KeyT").replace(/^Key/, "");
      hud.setHelp({
        title: tOr("STR_TBL_INGAME_HUD_LIFE_COUNT_TEXT", "Sobreviventes:"),
        next: tOr("STBL_IDX_OBSERVER_NEXT", "Próximo jogador: botão esquerdo do mouse"),
        prev: tOr("STBL_IDX_OBSERVER_PREV", "Jogador anterior: botão direito do mouse"),
        weapon: `${tOr("STBL_IDX_OBSERVER_WEAPON", "Trocar de arma:")} ${key}`, // "%s %s" with the weapon-change key (0x748312)
        view: tOr("STBL_IDX_OBSERVER_VIEW", "Mudar visão: barra de espaço"),
      });
    }
    return this.obsHud;
  }

  /** HP list (0x7147c0): one row per present player, red slots left, blue right; the enemy column needs room rule 0x08 */
  private obsRows(hud: ObserverHud, rules: ObserverRules): void {
    const cols = hpColumns(rules, this.me.team);
    const kills = new Map(this.match.rows().map((r) => [r.id, r.kills]));
    const rows = [...this.actors()]
      .filter((a) => !(a === this.me && this.spectating) && (a.team === 0 ? cols.red : cols.blue))
      .sort((a, b) => a.team - b.team || this.slotOf(a) - this.slotOf(b))
      .map((a) => ({ team: a.team, nick: a.name, score: kills.get(a.id) ?? 0, weapon: a.weaponName, fill: hpFill(a.hp, a.maxHp, a.alive), seat: this.slotOf(a) }));
    hud.setRows(rows, (n, i) => hpRowY(hud.height, n, i), this.isGM());
  }

  /** FPS view: his own eyes (CAMERA_TYPE 0, the option FOV) */
  private fpsObserveCam(t: Actor): void {
    const eye = t.eye(this._w);
    // a remote's aimDir is the body's smoothed aim (lerp k = 15/s over the interpolated states): his recoil kick never reached
    // the eye. Through his eyes the view takes the last replicated angles as they are, like his own camera does.
    const dir = t instanceof RemoteActor ? t.viewDir(this._v) : t.aimDir ? t.aimDir(this._v) : this._v.set(-Math.sin(t.yaw()), 0, -Math.cos(t.yaw()));
    this.camera.position.copy(eye).addScaledVector(dir, 0.08);
    this.camera.lookAt(eye.x + dir.x, eye.y + dir.y, eye.z + dir.z);
    this.camera.updateMatrixWorld(); // the arms hang from the camera: their muzzle (flash / tracer start) must follow this frame's eye
    this.hideBody(t, true);
  }

  /**
   * OBSERVER (type 4, 0x68b290): behind the watched player, turned with him, only a tenth of his pitch; OBSERVER2 (type 6,
   * 0x68c1e0): the same distance, orbit turned with the mouse (pitch +-80 degrees). Both stop 0.9 of the way to a wall.
   */
  private thirdObserveCam(t: Actor, orbit: boolean): void {
    const inp = this.input, st = getSettings(), k = lookScale(st);
    this.hideBody(t, false);
    const pivot = t.eye(this._w);
    let yaw: number, pitch: number;
    const aimed = !orbit && !!t.obsState?.().aiming; // OBSERVER only: the watched player aims (0x54dd50)
    if (orbit) {
      if (inp.locked) {
        this.obsYaw -= inp.lookDX * k;
        this.obsPitch = Math.max(-OBS_CAM.orbitPitchMax, Math.min(OBS_CAM.orbitPitchMax, this.obsPitch - inp.lookDY * k * (st.invertMouse ? -1 : 1)));
      }
      yaw = this.obsYaw; pitch = this.obsPitch;
    } else {
      const d = t.aimDir ? t.aimDir(this._v) : this._v.set(-Math.sin(t.yaw()), 0, -Math.cos(t.yaw()));
      yaw = Math.atan2(-d.x, -d.z); pitch = Math.asin(Math.max(-1, Math.min(1, d.y))) * OBS_CAM.pitchShare + (aimed ? OBS_CAM.aimPitch : 0);
      this.obsYaw = yaw; this.obsPitch = 0; // OBSERVER2 starts behind whoever was watched
    }
    const cp = Math.cos(pitch);
    const f = this._v.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
    let dist: number = OBS_CAM.distance + (aimed ? OBS_CAM.aimPush : 0);
    const hit = this.world.castRay(new this.R.Ray({ x: pivot.x, y: pivot.y, z: pivot.z }, { x: -f.x, y: -f.y, z: -f.z }), dist, true, undefined, WORLD_ONLY_QUERY);
    if (hit) dist = Math.max(0.1, hit.timeOfImpact * OBS_CAM.wallShare);
    this.camera.position.copy(pivot).addScaledVector(f, -dist);
    this.camera.lookAt(this.camera.position.x + f.x, this.camera.position.y + f.y, this.camera.position.z + f.z);
  }

  /** the target's weapon + motion on the first-person arms (only the FPS view shows them) */
  private observeArms(t: Actor, dt: number): void {
    const ws = this.pbWeapons();
    if (this.obsView !== "fps") { if (this.specWeapon) { this.specWeapon = ""; ws?.observe(null); } return; }
    const rw = t as Actor & { weaponId?: number };
    // no weapon known yet (the target has not sent a state / WeaponSync while standing still): the default rifle keeps the
    // arms on screen until the real one arrives [INFERIDO fallback]
    const wname = t.weaponName || "K-2";
    const wkey = rw.weaponId || wname;
    if (wkey !== this.specWeapon) {
      // a real swap = the same player changed weapon while watched; a new target / view (specWeapon cleared) just shows what he holds
      const swap = this.specWeapon !== "" && this.specWeaponOwner === t.id;
      this.specWeapon = wkey;
      this.specWeaponOwner = t.id;
      if (swap) { this.specReloadEnd = 0; this.specReloading = false; } // the swap cancels his reload (0xa0c3d0): a leftover reload clip would block the Change clip
      ws?.observe(rw.weaponId ? { id: rw.weaponId, chara: t.chara, team: t.team } : { name: wname, chara: t.chara, team: t.team }, { swap });
    }
    // his motion / shots / reloads drive the arms (walk, run, jump, zoom, Attack, LoadMagazine); his plant hold is not networked
    const os = t.obsState?.();
    if (os && ws) {
      // reload: the replicated torsoAction "reload" is the truth (start / end / cut by a swap or a shot); bots only count reloads.
      // Length = the watched weapon's ReloadTime (the remote's own is not networked; his Quick Change Reload scale is [INFERIDO] 1)
      const secs = ws.observedReloadSecs() ?? os.reloadSecs, first = this.specReloadSeq < 0, seqNew = os.reloadSeq !== this.specReloadSeq;
      this.specReloadSeq = os.reloadSeq;
      if (os.reloading !== undefined ? os.reloading && !this.specReloading : seqNew && !first) { this.specReloadEnd = this.time + secs; this.specReloadLen = secs; }
      if (os.reloading !== undefined) { if (!os.reloading) this.specReloadEnd = 0; this.specReloading = os.reloading; }
      if (!!os.ready !== this.specReady) { this.specReady = !!os.ready; ws.observeReady(this.specReady); } // grenade pin out / released
      if (os.fireSeq !== this.specFireSeq) { if (this.specFireSeq >= 0) ws.observeFire(!!os.heavy, this.muzzleTintOfId(t.id)); this.specFireSeq = os.fireSeq; }
      // held fire of an automatic weapon: the arms keep cycling at the weapon's rate (single-shot guns only fire on the shot events)
      if (os.firing) { const m = ws.observedFireMode(); if (m === "auto" || m === "burst") ws.observeFire(false, this.muzzleTintOfId(t.id)); }
      if (!!os.planting !== this.specPlanting) { this.specPlanting = !!os.planting; this.specPlantT = 0; }
      if (this.specPlanting) this.specPlantT += dt;
      ws.observePlant(this.specPlanting, this.specPlantT / BOMB.plantTime);
      const left = this.specReloadEnd - this.time;
      ws.observeState({ speed: os.speed, grounded: os.grounded, aiming: os.aiming, reloadT: left > 0 ? 1 - left / Math.max(0.001, this.specReloadLen) : os.reloading ? 0.999 : -1 }); // still reloading past the estimate: hold the end
    }
  }

  /** Space (0x76bfc0): the next view. Entering FLY starts behind the watched player (0x76bde0: local offset 0, 1.5, 2) */
  private setObsView(v: ObsView): void {
    if (v === this.obsView) return;
    const prev = this.obsView;
    this.obsView = v;
    if (v === "fly") {
      const c = this.camera, d = c.getWorldDirection(this._v);
      this.flyYaw = Math.atan2(-d.x, -d.z);
      this.flyPitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
      this.flyPos.copy(c.position);
      if (prev === "fps" && this.specTarget) this.flyPos.addScaledVector(d, -2).y += 1.5;
      if (this.specTarget) this.hideBody(this.specTarget, false);
    }
    if (v !== "fps") { this.specWeapon = ""; this.pbWeapons()?.observe(null); } else { this.specFireSeq = -1; this.specReloadSeq = -1; this.specReloadEnd = 0; this.specReloading = false; this.specReady = false; }
    this.applyObsFov();
  }

  /** every camera but FPS uses the literal FOV 70 (CGameCameraManager::Create 0x68d11f); FPS the option FOV */
  private applyObsFov(): void {
    this.weapons.setBaseFov?.(this.obsView === "fps" ? getSettings().fov : OBS_CAM.fov);
  }

  /**
   * FLY camera (CGameCamera_FLY, ChangeCamera type 2; Cross OnUpdate 0x67e270, observer.ts flyMove): free flight through the
   * level, mouse look, the bound move keys along the view, R / F up / down, wheel = speed. Space is the view key. Integrates
   * flyPos, not camera.position: deathCam puts the camera back on the corpse every frame before this runs.
   */
  private flyCam(dt: number): boolean {
    const inp = this.input, st = getSettings(), k = lookScale(st);
    if (inp.locked) {
      this.flyYaw -= inp.lookDX * k;
      this.flyPitch = Math.max(-1.5, Math.min(1.5, this.flyPitch - inp.lookDY * k * (st.invertMouse ? -1 : 1)));
      this.flySpeed = flySpeedStep(this.flySpeed, inp.wheel);
      flyMove(this.flyPos, this.flyYaw, this.flyPitch, {
        forward: keyHeld(inp, "forward"), back: keyHeld(inp, "back"), left: keyHeld(inp, "left"), right: keyHeld(inp, "right"),
        up: inp.key("KeyR"), down: inp.key("KeyF"),
      }, this.flySpeed, dt);
    }
    const cam = this.camera;
    cam.position.copy(this.flyPos);
    cam.rotation.order = "YXZ";
    cam.rotation.set(this.flyPitch, this.flyYaw, 0);
    return true;
  }

  /** leaves the observer (alive again / round over): body visible, arms off, option FOV, HUD off */
  private endObserver(): void {
    if (this.specTarget) this.setSpecTarget(null);
    const wasThird = this.obsView !== "fps";
    this.obsView = "fps"; this.obsFirstFrame = true; this.obsAllyLatch = false; this.obsDeadT = 0;
    if (wasThird) this.applyObsFov();
    this.obsHud?.setVisible(false);
    this.obsHud?.setBadge(null);
    this.obsHud?.setHelpImage(false);
    this.obsHudMode = null;
  }

  /** The observed player's own body (helmet, cap...) stays out of his first-person view: layer 1 is not rendered by the camera (actors reset root.visible every frame). */
  private hideBody(t: Actor, hide: boolean): void {
    t.visualRoot?.traverse((o) => { if (o.layers.mask !== (hide ? 2 : 1)) o.layers.set(hide ? 1 : 0); });
  }

  /** `a` is the player watched through his own eyes right now (body hidden, the arms on screen are his) */
  private watchedInFps(a: Actor): boolean {
    return this.specTarget === a && this.obsView === "fps" && !this.me.alive;
  }

  /** the watched player: his body is hidden only in the FPS view (it is his own first-person view) */
  private setSpecTarget(t: Actor | null): void {
    if (this.specTarget) this.hideBody(this.specTarget, false);
    const changed = this.specTarget !== t;
    this.specTarget = t;
    if (changed) { this.specWeapon = ""; this.specFireSeq = -1; this.specReloadSeq = -1; this.specReloadEnd = 0; this.specReloading = false; this.specReady = false; this.obsDeadT = 0; if (!t) this.pbWeapons()?.observe(null); }
  }

  /**
   * Death camera: the camera
   * sits on the corpse's Neck bone and turns with the mouse. The mouse look after death is [INFERIDO] (not decoded). With
   * no body (sits the round out) it watches from deathEye.
   */
  private deathCam(dt: number): void {
    const cam = this.camera, inp = this.input;
    this.corpse?.update(dt, { pos: this.corpseAt, yaw: this.corpseYaw, pitch: 0, crouch: false, grounded: true, alive: false });
    if (inp.locked && !this.respawnMenu?.isOpen) {
      const st = getSettings(), k = lookScale(st);
      this.deathYaw -= inp.lookDX * k;
      this.deathPitch -= inp.lookDY * k * (st.invertMouse ? -1 : 1);
      this.deathPitch = Math.max(-1.3, Math.min(0.9, this.deathPitch));
    }
    // 1PV local body, dead (state 0xb): the bone is Neck (deathBone)
    const eye = this.corpse?.boneWorld(deathBone(false, DEAD_BODY_STATE), this._w) ?? this._w.copy(this.me.deathEye);
    cam.position.copy(eye);
    cam.rotation.order = "YXZ";
    cam.rotation.set(this.deathPitch, this.deathYaw, 0);
    this.deathPose.pos.copy(cam.position);
    this.deathPose.quat.copy(cam.quaternion);
  }

  /** Round observer after death: 0.1 s from the death camera's pose into the observer view (CGameCameraManager::SetType 0x68d9d0). */
  private blendDeathCam(dt: number): void {
    if (this.deathBlendT >= DEATH_BLEND_S) return;
    this.deathBlendT += dt;
    const k = Math.min(1, this.deathBlendT / DEATH_BLEND_S);
    const cam = this.camera, to = cam.quaternion.clone();
    cam.position.lerpVectors(this.deathPose.pos, cam.position, k);
    cam.quaternion.slerpQuaternions(this.deathPose.quat, to, k);
  }

  private updateHud(dt: number, spread: number): void {
    const h = this.hud;
    const m = this.match;
    const ws = this.weapons.getState();
    h.tickFps();
    h.matchState({ phase: m.phase, tab: this.input.key("Tab"), crouch: this.me.isCrouching() });
    h.observing(this.obsHudMode);
    h.vitals(this.me.hp, this.me.maxHp, this.me.armor, this.me.helmet, this.me.alive ? this.me.invulnUntil - this.time : 0);
    h.weapon(ws, this.weaponSource === "weapons" ? "weapons" : "adapter");
    // src/weapons/scope.ts full-screen overlay (sniper scope and DotSight _ZoomType 3, data.ts params.scope):
    // ws.zoomFov is non-null exactly while that overlay is up (WeaponSystem.scoped), so the 2D crosshair must hide.
    // laser weapons: OnApplyCrosshair 0xa6585f turns the crosshair off while the laser is on (only the red dot)
    // snipers (SR) never draw the 2D crosshair, scoped or not: its spread grows huge unscoped [user request, not from the exe]
    const sniper = ws.family === "SR";
    h.hideCrosshair = !!ws.zoomFov || !!ws.laserOn || sniper;
    h.crosshair(spread, this.camera.fov, this.me.alive && !ws.zoomFov && !sniper && m.phase !== "ended");
    h.update(dt); // renders: after the crosshair flags, or the first scoped frame drew the crosshair over the overlay
    // Minimap enlarge/reduce (hud.ts zoomMinimap, exe 0x749994/0x709960). [RECRIADO] key mapping: the exact
    // key-map slot wasn't found in the available RE notes, so "+"/"-" (both the top row and numpad) are bound,
    // matching the scene's own on-screen +/- minimap buttons (PBRe_HUD_Classic).
    if (this.input.keyPressed("Equal") || this.input.keyPressed("NumpadAdd")) h.zoomMinimap(1);
    else if (this.input.keyPressed("Minus") || this.input.keyPressed("NumpadSubtract")) h.zoomMinimap(-1);
    if (this.finalOn && this.finalData) {
      this.finalT += dt;
      if (this.finalT >= FINAL_SECONDS) this.endFinal();
      else h.final({ ...this.finalData, mapName: MAP_LABELS[CurrentMap] ?? CurrentMap, modeName: this.bomb ? tOr("STR_HEADER_MODE_EXPLOSION", "Destruição") : tOr("STR_HEADER_MODE_TEAM_DEATH_MATCH", "Deathmatch"), tab: this.finalTab, leaveIn: FINAL_SECONDS - this.finalT });
    }
    h.helpImage(this.input.key("F1") && !this.obsHudMode); // F1 held (0x73f1a0); observing: obsUpdate draws it
    h.topBar(m.score, m.timeLeft(), m.cfg.mode !== "TDM" ? m.roundLimit : m.cfg.killLimit, m.round);
    // grey C4 (exe 0x740620 gate = CGameMissionManager+0x14, set per frame by 0x580880 in the pre-plant state): shown only while
    // the local chara stands in a site area (same test as the exe, BombMode.siteAt); any team, no carrier check
    if (this.bomb) h.bomb(this.bomb.state === "planted" ? this.bomb.fuseLeft : null, this.bomb.progress, this.bomb.state === "idle" && this.bomb.siteAt(this.me.feet(this.bombFeet).toArray() as BombVec3) >= 0, this.bombHintT > 0 ? this.bombHint : null);
    if (this.objBars) h.objectives(this.objBars);

    const showSb = this.input.key("Tab") || m.phase === "ended";
    const leaderSlot = (this.net as unknown as { room?: { leaderSlot: number } | null } | null)?.room?.leaderSlot ?? -1;
    h.scoreboard(showSb, m.rows().map((r) => { const rank = this.rankOfId(r.id), clanLogo = this.clanLogoOfId(r.id), nickColor = this.nickColorOfId(r.id); return { ...r, ...(leaderSlot >= 0 && r.id === `slot${leaderSlot}` ? { leader: true } : {}), ...(/^slot\d+$/.test(r.id) ? { slot: Number(r.id.slice(4)) } : {}), ...(rank !== undefined ? { rank } : {}), ...(clanLogo !== undefined ? { clanLogo } : {}), ...(nickColor !== undefined ? { nickColor } : {}) }; }), m.score, `Rodada ${m.round} · limite ${m.cfg.killLimit}`);

    // Before the spawn: the exe's own notice (STR_TBL_INGAME_HUD_READY_FOR_GAME), as one line under the crosshair
    // [INFERIDO placement]. The old "3, 2, 1 / LUTE! / X VENCEU / Próxima rodada em" texts were ours, not PB's: the
    // end of the match is the Cross result window (pbHud/crossFinal.ts, forced up by hud.matchState).
    if (m.phase === "countdown" && !this.spectating) h.banner("", tOr("STR_TBL_INGAME_HUD_READY_FOR_GAME", "Prepare-se, a partida já vai começar"));
    else h.banner("");

    // dead = killed and waiting to respawn; before the first spawn (me.alive still false, no respawnAt) the death HUDs
    // (respawn notice) must not stack on the match HUD
    const dead = !this.me.alive && m.phase !== "ended" && this.respawnAt.has(this.me.id);
    this.respawnMenu?.update({
      dead,
      respawnLeft: Math.max(0, (this.respawnAt.get(this.me.id) ?? this.time) - this.time),
      respawnTotal: this.respawnDelayOf(this.me),
      invincibleSec: m.cfg.spawnProtect + this.invincibleExtra,
      // Bomb round end (Mission Success/Failed mini scoreboard): T stays open, the pick equips at the next round's
      // spawn (spawnActor -> applyRespawnLoadout) [INFERIDO]; the final result screen still closes it
      canOpen: m.phase !== "ended" || (!!this.bomb && !this.finalOn),
    });
    if (dead) {
      const k = this.me.lastAttacker;
      const left = (this.respawnAt.get(this.me.id) ?? this.time) - this.time;
      h.death(true, k && k !== this.me ? k.name : "", this.me.deathWeapon, this.me.deathHeadshot, Math.max(0, left), k?.id);
    } else h.death(false);

    const blips: MinimapBlip[] = [];
    for (const a of this.actors()) {
      if (a === this.me) continue;
      const enemy = a.team !== this.me.team;
      const recentlyFired = this.time - (this.lastFire.get(a.id) ?? (a instanceof RemoteActor ? a.lastFire : -999)) < 1.5;
      if (enemy && (!a.alive || !recentlyFired)) continue; // PB radar: enemies show when they shoot
      const f = a.feet(this._w); // x/z copied into the blip right away; _w is rewritten by the eye() call below
      blips.push({ x: f.x, z: f.z, team: a.team, alive: a.alive });
    }
    // a GM observing: every other chara while ` is on (0x7507e0), "%s -%dHP" or the F9 seat badge (nameTags.ts)
    const gmObs = this.obsHudMode !== null && this.isGM();
    this.nameTags.update(dt, this.camera, this.me, this.actors(), (gmObs ? gmNickView.nicks : this.me.alive) && m.phase !== "ended", () => {
      const eye = this.player.eyePosition(new THREE.Vector3());
      const db = this.pbWeapons()?.db, found = db?.find(ws.name);
      const range = (found && db?.def(found.id)?.range) || 100;
      const hit = this.shoot(this.me, eye, this.camera.getWorldDirection(new THREE.Vector3()), range);
      const t = hit.actorId ? this.actorById(hit.actorId) : null;
      return t && t.team !== this.me.team ? t : null;
    }, gmObs ? { ids: gmNickView.ids, size: this.gmNickSize, slotOf: (a) => this.slotOf(a) } : null);
    const myFeet = this.me.feet(this._v);
    h.minimap(myFeet, this.player.yaw, blips, this.me.team);
    // thrown grenade near: Cross CHud 0x7443c0 warning badge, arrow and distance (pbHud layout.ts GRENADE_WARN)
    // [INFERIDO] the alive gate: the exe draws the list only while 0x53f870 (local character +0x710 state == 1) holds
    const near = this.me.alive ? this.pbWeapons()?.grenadesNear(myFeet, (owner) => {
      const a = this.actorById(owner);
      return !!a && a !== this.me && a.team === this.me.team;
    }) ?? [] : [];
    h.grenadeAlerts(near.map((n) => {
      const bearing = Math.atan2(-(n.pos.x - myFeet.x), -(n.pos.z - myFeet.z));
      let rel = this.player.yaw - bearing;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      return { rel, dist: n.dist, indicatorType: n.indicatorType };
    }));

    const bots = this.bots.filter((b) => b.alive).length;
    h.debug(
      `FPS ${h.fps} · ${this.levelName}\n` +
        `pos ${myFeet.x.toFixed(1)} ${myFeet.y.toFixed(1)} ${myFeet.z.toFixed(1)} ${this.player.isGrounded() ? "G" : "air"}${this.player.isSilent() ? " silent" : ""}\n` +
        `nav ${this.nav?.size ?? 0} · bots ${bots}/${this.bots.length} · net ${this.net.mode}` +
        (this.bomb ? this.bombDebug(myFeet) : "")
    );
  }
}
