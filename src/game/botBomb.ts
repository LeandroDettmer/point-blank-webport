// Bomb Mission bots: one attacker carries the C4 to a site and holds the plant (BOMB.plantTime), the defender nearest to the planted
// bomb walks there and holds the defuse (BOMB.defuseTime); a shot at them (combat) breaks the hold. [RECRIADO]: the PB AI has no
// decoded bomb behaviour; the reach for bots is looser than the player reach (2.5 m, |dy| < 1.2) because the path ends on the
// nearest nav node, not on the site. Pure logic (no three / rapier) so the P2P test can drive it.
//
// Online the bots belong to the match host, and the host asks Server.Game for the plant / defuse exactly as a human does
// (5156 / 5158 with the bot's slot, see roomHandlers.ts handleBombInstall): the ACK (5157 / 5159) then plants / defuses for every
// peer, the host included, and the server fuse + round end are the same for everybody. Offline `install` / `uninstall` act directly.
import { BOMB, type BombMode, type Vec3 } from "./bombMode.ts";

export interface BombBot {
  id: string;
  alive: boolean;
  team: number;
  inCombat: boolean;
  /** stand still while the hold runs */
  holding: boolean;
  /** what the hold is, replicated as the torso action (remote peers play the C4 hold sound from it) */
  holdKind: "plant" | "defuse" | null;
}

export interface BotBombIO<B extends BombBot> {
  feet(bot: B): Vec3;
  /** walk to p (null = back to patrol) */
  goto(bot: B, p: Vec3 | null): void;
  /** the carrier finished the plant hold */
  install(bot: B, site: number, pos: Vec3): void;
  /** the defuser finished the defuse hold */
  uninstall(bot: B): void;
}

/** a request the server may drop (round ending, C4 already down): ask again no sooner than this */
const RETRY_S = 2;

export class BotBombDriver<B extends BombBot> {
  private site: { area: number; pos: Vec3 } | null = null;
  private round = -1;
  carrier: B | null = null;
  defuser: B | null = null;
  private hold = 0;
  private askedAt = -Infinity;
  private clock = 0;

  private readonly bomb: BombMode;
  private readonly io: BotBombIO<B>;

  constructor(bomb: BombMode, io: BotBombIO<B>) {
    this.bomb = bomb;
    this.io = io;
  }

  /** a host change: the new host's driver prefers the bots that were holding when the old host's last records left */
  prefer(carrierId: string | null, defuserId: string | null): void {
    this.preferCarrier = carrierId;
    this.preferDefuser = defuserId;
  }
  private preferCarrier: string | null = null;
  private preferDefuser: string | null = null;

  /** hold progress of the running plant / defuse, 0..1 (tests, debug) */
  get progress(): number {
    const b = this.bomb;
    const total = b.state === "planted" ? b.defuseSeconds : BOMB.plantTime;
    return Math.min(1, this.hold / total);
  }

  update(dt: number, bots: readonly B[], round: number): void {
    const b = this.bomb;
    this.clock += dt;
    const reach = (bot: B, p: Vec3): boolean => {
      const f = this.io.feet(bot);
      return Math.hypot(f[0] - p[0], f[2] - p[2]) < 2.5 && Math.abs(f[1] - p[1]) < 1.2;
    };
    for (const bot of bots) if (bot !== this.carrier && bot !== this.defuser) { this.io.goto(bot, null); bot.holding = false; bot.holdKind = null; }
    if (this.round !== round) { this.round = round; this.site = null; this.carrier = null; this.defuser = null; this.hold = 0; this.askedAt = -Infinity; }

    if (b.state === "idle") {
      this.stopHold(this.defuser); this.defuser = null;
      if (b.sites.length === 0) return;
      if (!this.carrier?.alive) {
        this.stopHold(this.carrier);
        const pref = this.preferCarrier ? bots.find((x) => x.id === this.preferCarrier && x.alive && x.team === b.attackers) : undefined;
        this.carrier = pref ?? bots.find((x) => x.alive && x.team === b.attackers) ?? null;
        this.preferCarrier = null;
        this.hold = 0;
      }
      const c = this.carrier;
      if (!c) return;
      this.site ??= b.sites[Math.floor(Math.random() * b.sites.length)];
      const site = this.site;
      this.io.goto(c, site.pos);
      c.holding = !c.inCombat && reach(c, site.pos);
      c.holdKind = c.holding ? "plant" : null;
      if (c.holding) {
        this.hold += dt;
        if (this.hold >= BOMB.plantTime && this.clock - this.askedAt >= RETRY_S) {
          this.askedAt = this.clock;
          this.hold = 0;
          c.holding = false; c.holdKind = null;
          this.io.install(c, site.area, site.pos); // online the ACK flips the state; a dropped request retries after RETRY_S
        }
      } else this.hold = 0;
    } else if (b.state === "planted" && b.planted) {
      this.stopHold(this.carrier); this.carrier = null;
      const planted = b.planted;
      if (!this.defuser?.alive) {
        this.stopHold(this.defuser);
        const pref = this.preferDefuser ? bots.find((x) => x.id === this.preferDefuser && x.alive && x.team !== b.attackers) : undefined;
        let best: B | null = pref ?? null, bd = Infinity;
        if (!best) for (const x of bots) {
          if (!x.alive || x.team === b.attackers) continue;
          const f = this.io.feet(x);
          const d = Math.hypot(f[0] - planted.pos[0], f[1] - planted.pos[1], f[2] - planted.pos[2]);
          if (d < bd) { bd = d; best = x; }
        }
        this.preferDefuser = null;
        this.defuser = best; this.hold = 0;
      }
      const d = this.defuser;
      if (!d) return;
      this.io.goto(d, planted.pos);
      d.holding = !d.inCombat && reach(d, planted.pos);
      d.holdKind = d.holding ? "defuse" : null;
      if (d.holding) {
        this.hold += dt;
        if (this.hold >= b.defuseSeconds && this.clock - this.askedAt >= RETRY_S) {
          this.askedAt = this.clock;
          this.hold = 0;
          d.holding = false; d.holdKind = null;
          this.io.uninstall(d);
        }
      } else this.hold = 0;
    } else {
      // exploded / defused: the round is over, nobody holds anything
      this.stopHold(this.carrier); this.stopHold(this.defuser);
    }
  }

  private stopHold(bot: B | null): void {
    if (!bot) return;
    this.io.goto(bot, null);
    bot.holding = false; bot.holdKind = null;
  }
}
