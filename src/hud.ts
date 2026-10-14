// Match HUD facade used by game.ts. Drawing is the Point Blank Cross battle HUD (src/game/pbHud: PbHud.ts with the Cross exe
// panels charaPanel.ts / crossScore.ts / crossFinal.ts, crosshair, kill feed and radar).
import type * as THREE from "three";
import { CurrentMap, MAP_LABELS } from "./config";
import type { ScoreRow } from "./game/match";
import { KILL_MARKS, initStreak, onDeath, onKill as onKillMark, type StreakState } from "./game/pbHud/killmarks";
import { PbHud, type Blip } from "./game/pbHud/PbHud";
import type { HudData, HudRow } from "./game/pbHud/model";
import type { KillInfo, Team } from "./game/types";
import type { WeaponHudState } from "./game/weaponAdapter";
import { onCrosshair, onCrosshairType, setCrosshairIndex } from "./gameplay/settings";

export interface MinimapBlip {
  x: number;
  z: number;
  team: Team;
  self?: boolean;
  alive: boolean;
}

/** Extra fields the real WeaponSystem state carries (src/weapons/types.ts WeaponHudState). */
type WeaponState = WeaponHudState & {
  id?: number;
  family?: string;
  scoped?: boolean;
  dual?: "alt" | "both" | null;
  dualLeft?: boolean;
  slots?: { slot: number; id: number; ammo?: number }[];
};


export class Hud {
  private pb: PbHud;
  private frames = 0;
  private lastFpsTime = performance.now();
  fps = 0;
  /** Set by anything that covers the view (scope overlay, sights): the crosshair is not drawn. */
  hideCrosshair = false;

  private d: HudData = {
    hp: 100, maxHp: 100, armor: 0, helmet: false,
    weapon: { name: "", slot: 0, ammo: 0, reserve: 0, melee: false, reloading: false, reloadProgress: 0 },
    grenades: null, myTeam: 0, score: [0, 0], killLimit: 0, round: 1, timeLeft: 0, kills: 0, deaths: 0, assists: 0,
    phase: "live", showBoard: false, dead: false, rows: [], mapName: "", modeName: "Team Deathmatch", stageType: 0,
  };
  private phaseKnown = false;
  private xh = { spread: 0, visible: false, scoped: false };
  private mm: { feet: [number, number, number] | null; yaw: number; blips: Blip[] } = { feet: null, yaw: 0, blips: [] };
  private bannerText = "";
  /** frames left until the post-switch centre-overlay check */
  private switchCheck = 0;
  private bannerSub = "";
  /** own kill/streak state (double/triple/mass kill, chain killer, revenge): src/game/pbHud/killmarks.ts */
  private streak: StreakState = initStreak();
  /** id of the actor who last killed us, cleared once avenged (CRevengeManager) */
  private lastKillerId: string | null = null;
  /** banner of the newest own kill, held briefly: a 2nd victim of the same shot replaces it (ONE event in the exe) */
  private pendingMark: { marks: ReturnType<typeof onKillMark>["marks"]; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor() {
    const app = document.getElementById("app") ?? document.body;
    document.getElementById("crosshair")?.remove();
    document.getElementById("hud")?.style.setProperty("display", "none");
    this.pb = new PbHud(app);
    // Configuração (lobby or ESC menu) crosshair colour, applied live
    this.unsubCross = onCrosshair((i) => this.pb.setCrosshairColor(i));
    this.unsubCrossType = onCrosshairType((t) => (this.pb.crosshairType = t));
  }

  private unsubCross: () => void;
  private unsubCrossType: () => void;

  dispose(): void {
    this.unsubCross();
    this.unsubCrossType();
    this.pb.dispose();
  }

  setVisible(on: boolean): void {
    this.pb.setVisible(on);
  }

  tickFps(): void {
    this.frames++;
    const now = performance.now();
    if (now - this.lastFpsTime >= 500) {
      this.fps = Math.round((this.frames * 1000) / (now - this.lastFpsTime));
      this.frames = 0;
      this.lastFpsTime = now;
    }
  }

  debug(text: string): void {
    this.pb.debug(text);
  }

  /** Match phase + Tab key (game.ts updateHud): the board is forced up on the result screen even without Tab held. */
  matchState(s: { phase: HudData["phase"]; tab: boolean; crouch?: boolean }): void {
    this.phaseKnown = true;
    this.d.phase = s.phase;
    this.d.showBoard = s.tab || s.phase === "ended";
    this.d.crouch = s.crouch;
  }

  /** ColorCrosshair cash item: index 0..10 of the client colour table, null = default green. Persisted per browser. */
  setCrosshairColor(index: number | null): void {
    setCrosshairIndex(index); // the subscription recolours the PbHud
  }

  /** Minimap enlarge (+1) / reduce (-1) keys: zoom 0.5..1.1 in 0.1 steps (exe 0x749994 / 0x709960). */
  zoomMinimap(dir: 1 | -1): void {
    this.pb.zoomMinimap(dir);
  }

  vitals(hp: number, maxHp: number, armor: number, helmet: boolean, _protectLeft: number): void {
    Object.assign(this.d, { hp, maxHp, armor, helmet });
  }

  /** "<nick> Entrou no combate." / " Deixou o combate." in the kill list */
  notice(nick: string, suffix: string): void {
    this.pb.addNotice(nick, suffix);
  }

  /** observer HUD mode (game.ts spectateCam): hides the own HP / weapon panels */
  observing(mode: "view" | "fly" | null): void {
    this.d.observing = mode ?? undefined;
  }

  weapon(s: WeaponState, _source: string): void {
    if (s.slot !== this.d.weapon.slot) this.switchCheck = 2;
    this.d.weapon = { name: s.name, slot: s.slot, ammo: s.ammo, reserve: s.reserve, melee: s.melee, reloading: s.reloading, reloadProgress: s.reloadProgress, family: s.family, id: s.id, dual: s.dual ? { left: !!s.dualLeft } : undefined };
    const g = s.slots?.find((x) => x.slot === 3);
    this.d.grenades = g ? g.ammo ?? 0 : null;
    this.xh.scoped = !!s.scoped;
  }

  /** Crosshair_Cross (exe 0xa3f860): gap = tan(spread) * H/2, independent of the FOV (see pbHud/layout.ts). */
  crosshair(spreadDeg: number, _fovDeg: number, visible: boolean): void {
    this.xh.spread = spreadDeg;
    this.xh.visible = visible;
  }

  hitmarker(_kind: "hit" | "head" | "kill"): void {
    this.pb.hit();
  }

  /** `rel` = attacker bearing relative to view (0 = in front, +π/2 = right). */
  damageFrom(rel: number): void {
    this.pb.damage(rel);
  }

  /** bearings (same convention as damageFrom) of the frag grenades about to hurt the local player */
  grenadeAlerts(list: { rel: number; dist: number; indicatorType?: string }[]): void {
    this.pb.grenadeAlerts(list);
  }

  killfeed(k: KillInfo, localId: string): void {
    const killer = k.killer && k.killer !== k.victim ? { name: k.killer.name, team: k.killer.team } : null;
    this.pb.addKill(killer, { name: k.victim.name, team: k.victim.team }, k.weapon, k.headshot, k.killer?.id === localId || k.victim.id === localId);
    // CHud 0x741210: a kill with another player where the local player is killer (+1) or victim (-1); suicide is no record
    if (k.killer && k.killer.id !== k.victim.id) {
      if (k.killer.id === localId) this.pb.recordRevenge(k.victim, k.killer.name, 1);
      else if (k.victim.id === localId) this.pb.recordRevenge(k.killer, k.victim.name, -1);
    }
  }

  /**
   * Our own enemy kill: the kill-mark banner + announce voice (src/game/pbHud/killmarks.ts) and the kill star
   * (killStars.ts). `multi` = another victim of the same shot (the exe gets all victims in ONE event: one star with the
   * count, Piercing Shot; Mass Kill when `boom` = a blast or a shotgun), `victimStreak` = the victim's kills this life before it died (Chain Stopper when > 3).
   */
  registerOwnKill(k: { headshot: boolean; victimId: string; weapon: string; multi: boolean; boom?: boolean; victimStreak: number }): void {
    const isRevenge = k.victimId !== "" && k.victimId === this.lastKillerId;
    const cls = this.pb.weaponClassOf(k.weapon);
    const r = onKillMark(this.streak, {
      headshot: k.headshot, melee: cls.itemClass === 3, multi: k.multi,
      mass: !!k.boom || cls.itemClass === 4 || cls.classType === 6, victimStreak: k.victimStreak, isRevenge,
    });
    // the exe gets every victim of a shot in ONE event and shows ONE banner (Piercing/Mass): hold this kill's banner a moment
    // so the 2nd victim (its kill arrives later, one by one) replaces it instead of both being announced
    if (k.multi && this.pendingMark) clearTimeout(this.pendingMark.timer);
    else this.flushMark();
    const marks = r.marks;
    this.pendingMark = { marks, timer: setTimeout(() => this.flushMark(), 350) };
    if (!(k.multi && this.pb.bumpKillStar())) this.pb.addKillStar(r.star);
    if (isRevenge) this.lastKillerId = null;
  }

  private flushMark(): void {
    const p = this.pendingMark;
    if (!p) return;
    clearTimeout(p.timer);
    this.pendingMark = null;
    this.pb.killMark(p.marks);
  }

  /** Fire kill-mark banners + announce voice (e.g., mission start/success/game over). */
  killMark(marks: (typeof KILL_MARKS)[keyof typeof KILL_MARKS][]): void {
    this.pb.killMark(marks);
  }

  /** active mission card's tasks (game/pbHud/missionHud.ts): left panel + Tab list; null = no card */
  missions(m: HudData["missions"] | null): void {
    this.d.missions = m ?? undefined;
  }

  /** clan vs clan match flag (HudData.clanMatch). No Cross panel reads it yet: the v12 Clan_On banner went with the V12 HUD. */
  clanMatch(on: boolean): void {
    this.d.clanMatch = on;
  }

  /** a task of the active card got done: CQuestManager::AddQuestFinishToHud 0x58c8b0 -> the kill_message "Task Completed" banner */
  taskCompleted(): void {
    this.pb.killMark([KILL_MARKS.taskCompleted]);
  }

  /** Our helmet stopped a headshot (we are the victim): the kill_message.i3i "Helmet Protection" sprite. The voice
   *  (MV_Ann_HelmetProtection.wav) is played by the caller (pbSound.ts pbHelmetProtection). */
  helmetProtection(): void {
    this.pb.spriteMark(KILL_MARKS.helmetProtection, false);
  }

  /** round end banner (Cross CHud 0x73ffb0): winner 0 red / 1 blue / null draw. Caller: the round-end handler of game.ts */
  roundEnd(winner: 0 | 1 | null): void {
    this.pb.roundEnd(winner);
  }

  /** F1 held, not observing: the key help image (help.i3i, CHud 0x73f1a0) */
  helpImage(on: boolean): void {
    this.pb.helpImage(on);
  }

  clearFeed(): void {
    this.pb.clearFeed();
  }

  topBar(score: [number, number], timeLeft: number, killLimit: number, round: number): void {
    Object.assign(this.d, { score: [score[0], score[1]], timeLeft, killLimit, round });
  }

  /** End-of-match screen (GameResult scene): data, or null to take it down */
  final(f: HudData["final"]): void {
    this.d.final = f;
  }

  /** leave button / tab clicks of the end-of-match screen */
  get finalHandlers(): { ok?: () => void; tab?: (i: 0 | 1) => void } {
    return this.pb.onFinal;
  }

  /** Bomb Mission HUD: fuse left (null = nothing planted), the hold progress 0..1, before = nothing planted yet, hint = C4 hint box (null = hidden). */
  bomb(fuseLeft: number | null, progress: number, before = false, hint: string | null = null): void {
    this.d.bomb = { fuseLeft, progress, before, hint };
  }

  /** Destroy mission target HP: null = hidden */
  objectives(o: { bar: [number, number]; max: [number, number] } | null): void {
    this.d.objectives = o;
  }

  /** mode label of the scoreboard ("Team Deathmatch" by default) */
  setModeName(name: string): void {
    this.d.modeName = name;
  }

  /** stage type of the room (RoomCondition >> 2): the mission HUD's Y0 (stageY0) */
  setStageType(type: number): void {
    this.d.stageType = type;
  }

  banner(text: string, sub = ""): void {
    this.bannerText = text;
    this.bannerSub = sub;
  }

  /** mission notice (CHud::SetMissionNoticeString 0x73f7a0): one line at the top, replaces the last one, hidden after sec s (0 clears) */
  missionNotice(text: string, sec = 3): void {
    this.pb.notice(text, sec);
  }

  /**
   * Our own death, at the moment it happens: resets the no-death streaks and remembers the killer (revenge). Not left
   * to death()'s per-frame "just died" edge: with a 0 s respawn (Instant Respawn coupon) the player is back before the
   * HUD ever sees the death, and the next kill still counted the old streak (Chain Killer on the first kill).
   */
  ownDeath(killerId?: string | null): void {
    onDeath(this.streak);
    this.pb.resetKillStars();
    this.lastKillerId = killerId ?? null;
  }

  /** Round modes: a new round is a new life, the per-life kill stars start empty (the streak state is per life too). */
  newRound(): void {
    this.pb.resetKillStars();
    onDeath(this.streak);
  }

  death(visible: boolean, _killer = "", _weapon = "", _headshot = false, _respawnIn = 0, _killerId?: string): void {
    this.d.dead = visible;
  }

  scoreboard(visible: boolean, rows: ScoreRow[], score: [number, number], _info: string): void {
    this.d.rows = rows.map((r): HudRow => ({ name: r.name, team: r.team, slot: r.slot, kills: r.kills, deaths: r.deaths, headshots: r.headshots, damage: r.damage, objects: r.objects, alive: r.alive, local: r.local, leader: r.leader, rank: r.rank, clanLogo: r.clanLogo, nickColor: r.nickColor }));
    const me = rows.find((r) => r.local);
    if (me) Object.assign(this.d, { kills: me.kills, deaths: me.deaths, myTeam: me.team });
    this.d.score = [score[0], score[1]];
    if (!this.phaseKnown) this.d.showBoard = visible;
  }

  /** Radar centred on the player (2017 mini_<Map> image, rotated with the view). */
  minimap(center: THREE.Vector3, yaw: number, blips: MinimapBlip[], myTeam: Team, _range = 40): void {
    this.d.myTeam = myTeam;
    this.mm.feet = [center.x, center.y, center.z];
    this.mm.yaw = yaw;
    this.mm.blips = blips.filter((b) => !b.self);
  }

  update(dt: number): void {
    const d = this.d;
    d.mapName = MAP_LABELS[CurrentMap] ?? CurrentMap;
    // countdown / "LUTE!" banner [RECRIADO text layout]; hidden on the result screen
    this.pb.setBanner(d.phase === "ended" ? "" : this.bannerText, d.phase === "ended" ? "" : this.bannerSub);
    this.pb.render(d, dt, {
      crosshair: this.xh.visible && !this.xh.scoped && !this.hideCrosshair && !d.dead && !d.showBoard,
      spreadDeg: this.xh.spread,
      feet: this.mm.feet,
      yaw: this.mm.yaw,
      blips: this.mm.blips,
      map: CurrentMap,
    });
    if (this.switchCheck > 0 && --this.switchCheck === 0) {
      const hits = this.pb.centerOverlays();
      if (hits.length) console.warn("[hud] switch overlay", hits);
    }
  }
}
