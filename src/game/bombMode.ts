// Bomb Mission (Rule 2, RoomCondition.Bomb = 8): plant / defuse / fuse state machine. Pure logic, no three / rapier.
// Hold times from the Cross exe, the rest from the reference server:
//   - hold time: plant 5 s, defuse 7 s; with the speed kit plant 3 s, defuse 5 s. Cross exe 0x5845d0 (plant) / 0x584600 (defuse)
//     both test ability 14 of the slot (0x549210) and load 0xb35ae8 = 5 / 0xb228e4 = 3 and 0xb29998 = 7 / 0xb35ae8 = 5; the
//     CHud hold bar 0x740620 draws 1 - t/T with them. Ability 14 = the C4SpeedKit item: [INFERIDO]
//   - reach: 2 m from the site (or from the planted bomb); a site at (0,0,0) is "everywhere" (MapStructure.xml BombPositions)
//   - fuse: 42 s from the plant (RoomModel.StartBomb 42000 ms)
// The attackers (FR, or CT after the side swap) plant, the defenders defuse. Online the server owns the round: the local
// actor asks (5156 / 5158), the server answers (5157 / 5159) and 5155 ends the round; offline the same machine runs alone.

export const BOMB = {
  plantTime: 5,
  defuseTime: 7,
  /** with the speed kit (ability 14), Cross exe 0x5845d0 / 0x584600 */
  plantTimeKit: 3,
  defuseTimeKit: 5,
  fuse: 42,
  /**
   * Area test, exe 2017 CGameMissionManager 0x585470 (local chara vs the stage's BombPosition_A / _B): d = chara - site, in the area when
   * d.d < 4.0 (4bba60 is the SQUARED length: 3D distance < 2 m) and |d.y| < 0.2 (the site sits on the floor). Verified against the exported
   * floors of every map (pb-extract-tools export-bombsites.mjs: |site Y - floor| < 0.09).
   */
  reach: 2,
  reachY: 0.2,
} as const;

export type Vec3 = [number, number, number];
/** area 0 = A, 1 = B (BombPosition_A / _B of the stage config) */
export interface BombSite { pos: Vec3; area: number }
export type BombState = "idle" | "planted" | "exploded" | "defused";
export type BombAction = "plant" | "defuse" | null;

/** A / B positions -> sites. (0,0,0) = the stage has no such area (CStageBattle 0x76b570 tests all three components against 0). */
export function sitesFromMap(bombs: Vec3[] | undefined): BombSite[] {
  return (bombs ?? []).map((pos, area) => ({ pos, area })).filter((s) => !(s.pos[0] === 0 && s.pos[1] === 0 && s.pos[2] === 0));
}

export interface BombInput {
  /** 0 = FR (red), 1 = CT (blue) */
  team: number;
  alive: boolean;
  pos: Vec3;
  /** plant: C4 equipped and fire held; defuse: action key held */
  plantHeld: boolean;
  defuseHeld: boolean;
  /** attackers carry the C4 (FR first life of the round) */
  hasC4: boolean;
}

export interface BombEvents {
  /** the local actor finished the hold: the caller sends 5156 (online) or calls plant() (offline) */
  onPlantDone?: (site: number, pos: Vec3) => void;
  onDefuseDone?: () => void;
  /** fuse reached 0 */
  onExplode?: () => void;
}

const d3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** in the area of a site: squared 3D distance < 4 and |dy| < 0.2 (exe 0x585470) */
export const inReach = (p: Vec3, site: Vec3): boolean => {
  const dx = p[0] - site[0], dy = p[1] - site[1], dz = p[2] - site[2];
  return dx * dx + dy * dy + dz * dz < BOMB.reach * BOMB.reach && Math.abs(dy) < BOMB.reachY;
};

export class BombMode {
  state: BombState = "idle";
  /** attacking team: FR (0), or CT (1) after the TEAM_SWAP */
  attackers = 0;
  planted: { site: number; pos: Vec3 } | null = null;
  fuseLeft = 0;
  action: BombAction = null;
  /** 0..1 of the current hold */
  progress = 0;
  /** speed kit (C4SpeedKit, exe ability 14): plant 3 s, defuse 5 s */
  speedKit = false;
  private held = 0;
  private sent = false;

  readonly sites: BombSite[];
  readonly ev: BombEvents;

  // no parameter properties: the P2P tests load this file with node's strip-only TypeScript
  constructor(sites: BombSite[], ev: BombEvents = {}) {
    this.sites = sites;
    this.ev = ev;
  }

  get plantSeconds(): number { return this.speedKit ? BOMB.plantTimeKit : BOMB.plantTime; }
  get defuseSeconds(): number { return this.speedKit ? BOMB.defuseTimeKit : BOMB.defuseTime; }

  /** New round: bomb gone, holds cleared. */
  reset(attackers = this.attackers): void {
    this.state = "idle";
    this.attackers = attackers;
    this.planted = null;
    this.fuseLeft = 0;
    this.cancel();
  }

  /** nearest site for the debug HUD: area, 3D distance and dy (null: the stage has no site) */
  nearest(pos: Vec3): { area: number; dist: number; dy: number } | null {
    let best: { area: number; dist: number; dy: number } | null = null;
    for (const s of this.sites) {
      const dist = d3(pos, s.pos);
      if (!best || dist < best.dist) best = { area: s.area, dist, dy: pos[1] - s.pos[1] };
    }
    return best;
  }

  /** Area (0 A / 1 B) the position is in, or -1. */
  siteAt(pos: Vec3): number {
    let best = -1, bd = Infinity;
    for (const s of this.sites) {
      const d = d3(pos, s.pos);
      if (inReach(pos, s.pos) && d < bd) { best = s.area; bd = d; }
    }
    return best;
  }

  canPlant(i: BombInput): boolean {
    return this.state === "idle" && i.alive && i.hasC4 && i.team === this.attackers && this.siteAt(i.pos) >= 0;
  }

  canDefuse(i: BombInput): boolean {
    if (this.state !== "planted" || !this.planted || !i.alive || i.team === this.attackers) return false;
    // the chara must be in the area the bomb was planted in (the exe tests the stage's area for every chara)
    const site = this.sites.find((s) => s.area === this.planted!.site);
    return inReach(i.pos, site ? site.pos : this.planted.pos);
  }

  /** the server / the local plant confirmed: the bomb is down and the fuse starts */
  plant(site: number, pos: Vec3, fuseElapsed = 0): void {
    if (this.state === "planted") return;
    this.state = "planted";
    this.planted = { site, pos };
    this.fuseLeft = Math.max(0, BOMB.fuse - fuseElapsed);
    this.cancel();
  }

  defuse(): void {
    if (this.state !== "planted") return;
    this.state = "defused";
    this.fuseLeft = 0;
    this.cancel();
  }

  private cancel(): void {
    this.action = null;
    this.progress = 0;
    this.held = 0;
    this.sent = false;
  }

  /** online: the server owns the fuse (5155 motive 2 explodes the bomb); the local clock only counts down for the display and waits at 0 */
  serverFuse = false;

  update(dt: number, i: BombInput): void {
    if (this.state === "planted") {
      this.fuseLeft = Math.max(0, this.fuseLeft - dt);
      if (this.fuseLeft <= 0 && !this.serverFuse) {
        this.state = "exploded";
        this.cancel();
        this.ev.onExplode?.();
        return;
      }
    }
    const want: BombAction = i.plantHeld && this.canPlant(i) ? "plant" : i.defuseHeld && this.canDefuse(i) ? "defuse" : null;
    if (want !== this.action) { this.cancel(); this.action = want; } // released / moved away / died: the hold restarts
    if (!want) return;
    this.held += dt;
    const total = want === "plant" ? this.plantSeconds : this.defuseSeconds;
    this.progress = Math.min(1, this.held / total);
    if (this.progress < 1 || this.sent) return;
    this.sent = true; // one completion per hold; the state flips on plant() / defuse() (server ACK online)
    if (want === "plant") this.ev.onPlantDone?.(this.siteAt(i.pos), [...i.pos] as Vec3);
    else this.ev.onDefuseDone?.();
  }

  /** Beep clip for the fuse time left, from the C4 count sounds [RECRIADO schedule]: slow at first, then faster, last 5 s accelerating. */
  beepInterval(): number {
    const t = this.fuseLeft;
    return t > 30 ? 1.5 : t > 20 ? 1 : t > 10 ? 0.6 : t > 5 ? 0.35 : 0.15;
  }
}
