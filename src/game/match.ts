import type { Actor, KillInfo, Team } from "./types";

export interface MatchConfig {
  /** TDM: kill limit; BOMB: rounds;
   * DESTROY: rounds, the server ends each one by a bar at 0 or the clock;
   * ANNIHILATION / ACE: rounds the server ends by a side wiped (Annihilation) or a kill (Ace), no objectives */
  mode: "TDM" | "BOMB" | "DESTROY" | "DEFENCE" | "ANNIHILATION" | "ACE";
  /** BOMB: rounds to win (ROUNDS[killTime & 15]); 0 = no limit (offline) */
  roundLimit?: number;
  killLimit: number;
  timeLimit: number; // seconds
  countdown: number; // freeze before each round
  respawnDelay: number;
  spawnProtect: number;
  endScreen: number; // seconds the result screen stays up before the next round
}

export type MatchPhase = "countdown" | "live" | "ended";

export interface ScoreRow {
  id: string;
  /** room slot of a net player ("slotN" id); undefined = bot / offline */
  slot?: number;
  name: string;
  team: Team;
  kills: number;
  deaths: number;
  headshots: number;
  /** damage dealt (result screen "Damage") and objectives done (plant / defuse: "Mission") */
  damage: number;
  objects: number;
  alive: boolean;
  local: boolean;
  /** room leader = the P2P host (net/roomClient leaderSlot); Tab shows a tag next to the nick */
  leader?: boolean;
  /** patente of the player's room slot (Tab icon); undefined = unknown */
  rank?: number;
  /** clan emblem logo of the player's room slot (Tab, clan match); undefined = no clan / bots */
  clanLogo?: number;
  /** nick colour index of the player's room slot (NICK_COLORS); undefined = no slot (bots) */
  nickColor?: number;
}

function num(params: URLSearchParams, key: string, def: number): number {
  const v = Number(params.get(key));
  return Number.isFinite(v) && v > 0 ? v : def;
}

/**
 * Server RoomModel (Server.Game/Data/Models/RoomModel.cs): room KillTime = (time index << 4) | kill index, TIMES (min)
 * [3,3,3,5,7,5,10,15,20,25,30] and KILLS [15,30,50,60,80,100,120,140,160]. The room screen creates 0x63 = 10 min /
 * 60 kills (src/lobby/core/controller.ts), the offline default here.
 */
export const PB_ROOM_TIMES_MIN = [3, 3, 3, 5, 7, 5, 10, 15, 20, 25, 30] as const;
export const PB_ROOM_KILLS = [15, 30, 50, 60, 80, 100, 120, 140, 160] as const;

export function matchConfigFromUrl(): MatchConfig {
  const p = new URLSearchParams(location.search);
  return {
    mode: p.get("mode")?.toLowerCase() === "bomb" ? "BOMB" : "TDM", // ?mode=bomb: offline Bomb Mission on the ?map= map
    roundLimit: num(p, "rounds", 0), // ?rounds=N: offline Bomb Mission ends after N rounds won (0 = endless)
    killLimit: num(p, "kills", PB_ROOM_KILLS[0x63 & 15]),
    timeLimit: num(p, "time", PB_ROOM_TIMES_MIN[0x63 >> 4]) * 60,
    countdown: 3,
    respawnDelay: 5, // Character.pef 3.123 Character.RespawnTime
    spawnProtect: 4, // Character.pef 3.123 Character.InvincibleTime (4vs4 rooms use InvincibleTime_4vs4 = 1)
    endScreen: 8,
  };
}

/** Team Deathmatch state: phases, score, per-actor stats, kill feed. Pure logic, no three/rapier. */
export class Match {
  phase: MatchPhase = "countdown";
  round = 1;
  phaseTime = 0; // seconds spent in current phase
  readonly score: [number, number] = [0, 0];
  readonly feed: KillInfo[] = [];
  private stats = new Map<string, ScoreRow>();
  private actors = new Map<string, Actor>();
  private killCbs = new Set<(k: KillInfo) => void>();
  /** enemy kills of each actor this life (server KillsOnLife): the victim's count feeds Chain Stopper */
  private life = new Map<string, number>();
  private phaseCbs = new Set<(p: MatchPhase, m: Match) => void>();
  winner: Team | null = null;
  /** BOMB: the round clock stops while a bomb is planted (the fuse decides) */
  paused = false;
  /** BOMB: rounds to win (Server ROUNDS[killTime & 15]); the server's own count wins online */
  roundLimit = 0;
  /** BOMB: team that wins when the round clock runs out with no bomb planted (the defenders: CT, FR after the side swap) */
  defenders: Team = 1;
  /** BOMB: the last end() came from the round clock (Game asks the server / counts the round) */
  timedOut = false;

  constructor(readonly cfg: MatchConfig) {
    this.roundLimit = cfg.roundLimit ?? 0;
  }

  addActor(a: Actor): void {
    this.actors.set(a.id, a);
    if (!this.stats.has(a.id)) {
      this.stats.set(a.id, { id: a.id, name: a.name, team: a.team, kills: 0, deaths: 0, headshots: 0, damage: 0, objects: 0, alive: a.alive, local: a.kind === "player" });
    }
  }

  removeActor(id: string): void {
    this.actors.delete(id);
    this.stats.delete(id);
  }

  onKill(cb: (k: KillInfo) => void): () => void {
    this.killCbs.add(cb);
    return () => this.killCbs.delete(cb);
  }

  onPhase(cb: (p: MatchPhase, m: Match) => void): () => void {
    this.phaseCbs.add(cb);
    return () => this.phaseCbs.delete(cb);
  }

  /** Movement + shooting allowed. */
  get live(): boolean {
    return this.phase === "live";
  }

  timeLeft(): number {
    if (this.phase === "countdown") return this.cfg.timeLimit;
    if (this.phase === "ended") return 0;
    return Math.max(0, this.cfg.timeLimit - this.phaseTime);
  }

  update(dt: number): void {
    if (this.paused && this.phase === "live") return;
    this.phaseTime += dt;
    if (this.phase === "countdown" && this.phaseTime >= this.cfg.countdown) this.setPhase("live");
    else if (this.phase === "live" && this.phaseTime >= this.cfg.timeLimit) this.end();
    else if (this.phase === "ended" && this.phaseTime >= this.cfg.endScreen) this.nextRound();
  }

  /**
   * Server RoomDeath (Data/Sync/Client/RoomDeath.cs): every death counts for the victim; the killer's kill and the team
   * score only when the killer is on the other team (suicides, falls and team kills score nothing). The battle ends
   * when a team reaches the kill limit (AllUtils.CheckBattleEndByKills, >=) or on time out; more kills wins, equal = draw
   * (AllUtils.GetWinnerTeam).
   */
  registerKill(info: KillInfo): void {
    const v = this.stats.get(info.victim.id);
    if (v) v.deaths++;
    info.victimStreak = this.life.get(info.victim.id) ?? 0;
    this.life.set(info.victim.id, 0);
    const enemyKill = !!info.killer && info.killer !== info.victim && info.killer.team !== info.victim.team;
    if (enemyKill && info.killer) {
      const k = this.stats.get(info.killer.id);
      if (k) {
        k.kills++;
        if (info.headshot) k.headshots++;
      }
      this.life.set(info.killer.id, (this.life.get(info.killer.id) ?? 0) + 1);
      if (this.phase === "live" && this.cfg.mode === "TDM") this.score[info.killer.team]++;
    }
    this.feed.push(info);
    if (this.feed.length > 30) this.feed.shift();
    this.killCbs.forEach((cb) => cb(info));
    if (this.phase === "live" && this.cfg.mode === "TDM" && Math.max(...this.score) >= this.cfg.killLimit) this.end();
  }

  /** BOMB: the round is over for `winner` (null = draw). Server-ts sends the counts (5155); offline the caller counts. */
  endRound(winner: Team | null): void {
    if (this.phase !== "live") return;
    this.winner = winner;
    this.setPhase("ended");
  }

  /** BOMB: next round (5153): counts set, everybody respawns through the countdown phase. */
  beginRound(round: number, red: number, blue: number): void {
    this.round = round;
    this.score[0] = red;
    this.score[1] = blue;
    this.winner = null;
    this.paused = false;
    this.feed.length = 0;
    this.life.clear();
    this.setPhase("countdown");
  }

  rows(): ScoreRow[] {
    for (const [id, row] of this.stats) {
      const a = this.actors.get(id);
      if (a) {
        row.alive = a.alive;
        row.name = a.name;
        row.team = a.team;
      }
    }
    return [...this.stats.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  }

  /** Public so game.ts can force a match end when the opposing team disconnects (1v1 quit). */
  end(): void {
    if (this.cfg.mode === "BOMB") { this.winner = this.defenders; this.timedOut = true; } // clock out, nothing planted
    else this.winner = this.score[0] === this.score[1] ? null : this.score[0] > this.score[1] ? 0 : 1;
    this.setPhase("ended");
  }

  addDamage(id: string, n: number): void {
    const s = this.stats.get(id);
    if (s && n > 0) s.damage += n;
  }

  addObject(id: string): void {
    const s = this.stats.get(id);
    if (s) s.objects++;
  }

  /** the end screen was confirmed (offline): a new match starts */
  restart(): void {
    this.nextRound();
  }

  private nextRound(): void {
    this.round++;
    this.score[0] = this.score[1] = 0;
    this.winner = null;
    for (const s of this.stats.values()) s.kills = s.deaths = s.headshots = s.damage = s.objects = 0;
    this.feed.length = 0;
    this.life.clear();
    this.setPhase("countdown");
  }

  private setPhase(p: MatchPhase): void {
    this.phase = p;
    this.phaseTime = 0;
    this.phaseCbs.forEach((cb) => cb(p, this));
  }
}
