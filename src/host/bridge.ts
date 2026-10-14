// Server.Game <-> the leader-hosted match. Server.Match gets its room state from Server.Game
// over the internal sync UDP (MatchSync: RespawnSync / RemovePlayerSync / MatchRoundSync) and reports back with
// SendMatchInfo. A browser has neither link, but the leader's own Server.Game session sees the same facts:
//   RESPAWN_ACK 5138 (broadcast to the battle, every slot)  -> RespawnSync (slot, SpawnsCount, weapons, character)
//   STARTBATTLE_ACK 5132                                    -> the room's StartTick
//   ENDBATTLE_ACK 5140                                      -> the match is over: every peer closed (1001)
//   Match -> Game "death" with the leader as killer         -> BATTLE_DEATH_REQ (Server.Game takes kills from the
//                                                              killer only; other killers report their own, battle.ts)
// Exp / gold stay Server.Game's: it ends the battle on the kill goal (DEATH_REQs) or the leader's TIMERSYNC 0 and pays
// out in ENDBATTLE as with the dedicated server.
import { parseRespawnAck, type RespawnAck } from "../net/metaGame.ts";
import type { RoomClient } from "../net/roomClient.ts";
import type { MatchSession } from "../net/matchUdpLink.ts";
import type { GameSyncOut } from "./matchCore.ts";
import type { LocalHost } from "./local.ts";

const OP_STARTBATTLE_ACK = 5132;
const OP_RESPAWN_ACK = 5138;
const OP_ENDBATTLE_ACK = 5140;
const HEADSHOT = 3;

export interface BridgeOptions {
  /** DEATH_REQ for a kill the core saw (dedup with battle.ts's kill marks) */
  reportKill?: (victimSlot: number, weaponId: number, headshot: boolean, killerPos: [number, number, number], victimPos: [number, number, number]) => void;
  onEnd?: () => void;
  /** host handoff: the old bridge's exportState().spawned, slots that already had their first respawn */
  spawned?: number[];
}

export class HostBridge {
  private readonly off: () => void;
  private startTick = 0;
  private readonly spawned = new Set<number>();
  /** slots the core was restored with (host handoff): their guests register again, the state they come back to is the
   * restored one, so no RESPAWN_ACK may re-arm them (that is a full respawn: life back to max) */
  private readonly restored = new Set<number>();
  private readonly sync: (a: RespawnAck, type?: number) => void;
  private readonly room: RoomClient;

  /** Host takeover: feed the new match core the last RESPAWN_ACK of every slot. Call it
   * once the room exists in the core (the takeover host's own link has registered). */
  replay(): void {
    for (const a of this.room.respawnAcks.values()) if (this.inBattle(a.slot) && !this.restored.has(a.slot)) this.sync(a, 2);
  }

  /** what a new host's bridge needs of this one (host handoff) */
  exportState(): { spawned: number[] } {
    return { spawned: [...this.spawned] };
  }

  /** a slot that left / gave up keeps its last RESPAWN_ACK in the cache: never re-arm it */
  private inBattle(slot: number): boolean {
    const st = this.room.slots[slot]?.state;
    return st === undefined || st >= 14; // unknown (tests) or LOAD..BATTLE
  }

  /** A guest's link (re)connected: its slot in the core was reset when the old link dropped (peerClosed), and the RESPAWN_ACK
   * that armed it will not come again, so the slot stayed dead / unvalidated: its packets were dropped (a ghost to the
   * others) and nobody's hits on it, or from it, counted. Re-arm it from the last RESPAWN_ACK; the core parks it until
   * the slot's REGISTER lands. */
  replaySlot(slot: number): void {
    if (this.restored.delete(slot)) return; // restored by a handoff: the core already holds this slot's battle state
    const a = this.room.respawnAcks.get(slot);
    if (a && this.inBattle(slot)) this.sync(a, 2);
  }

  constructor(room: RoomClient, host: LocalHost, session: MatchSession, opts: BridgeOptions = {}) {
    // a core restored from a handoff already has a room StartTick; a later one would reset its room (MatchCore.resyncTick)
    if (host.restored) {
      this.startTick = host.restored.startTick;
      for (const slot of host.restored.slots) this.restored.add(slot);
      for (const slot of opts.spawned ?? []) this.spawned.add(slot);
    }
    const tick = () => (this.startTick ||= Date.now());
    this.sync = (a, type) => {
      host.respawn({
        uniqueRoomId: session.uniqueRoomId, roomSeed: session.roomSeed, startTick: tick(),
        // EquipmentSync type: 0 on the slot's first respawn of the battle, 2 afterwards
        type: type ?? (this.spawned.has(a.slot) ? 2 : 0),
        round: 1,
        slot: a.slot,
        respawnCount: a.slotSpawns & 0xff,
        // only our own PlayerId is known here; the others are held to what they registered with
        accountId: a.slot === session.slot ? session.accountId : undefined,
        charaId: a.chara,
        weapons: { primary: a.weapons.primary, secondary: a.weapons.secondary, melee: a.weapons.melee, explosive: a.weapons.grenade, special: a.weapons.special },
        accessory: a.accessory ?? 0,
      });
      this.spawned.add(a.slot);
    };
    this.room = room;
    this.off = room.game.conn.on((op, r) => {
      if (op === OP_STARTBATTLE_ACK) tick();
      else if (op === OP_RESPAWN_ACK) {
        let a;
        try { a = parseRespawnAck(r); } catch { return; }
        this.sync(a);
      } else if (op === OP_ENDBATTLE_ACK) {
        host.end("ENDBATTLE");
        opts.onEnd?.();
      }
    });
    host.onGame = (m) => this.fromMatch(m, room, opts);
  }

  private fromMatch(m: GameSyncOut, room: RoomClient, opts: BridgeOptions): void {
    if (m.t === "death") {
      if (m.killerSlot !== room.mySlot) return; // that killer's own client reports it
      for (const d of m.deaths) opts.reportKill?.(d.slot, m.weaponId, d.deathType === HEADSHOT, m.killerPos, d.pos);
    } else if (m.t === "sabotage") {
      // Destroy: the leader reports the objectives' bars and the slots' damage to the server (5166 -> 5167 to the battle)
      if (room.isLeader) room.generatorInfo(m.bar1, m.bar2, m.slotDamage);
    } else if (m.t !== "ping") {
      // bomb / hit marker / portal: modes the web build does not run yet; no client TCP op carries them
      console.debug("[p2p host] match -> game", m);
    }
  }

  dispose(): void {
    this.off();
  }
}
