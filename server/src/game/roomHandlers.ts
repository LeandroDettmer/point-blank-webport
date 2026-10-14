// Server.Game room + battle handlers (ROOM_CREATE/JOIN/team/slot, READYBATTLE, countdown, StartBattle, LOADING_START,
// GET_USER_EQUIPMENT, PRESTART, STARTBATTLE, SENDPING, RESPAWN, DEATH, TIMERSYNC, GIVEUP, room leave) and the end of
// match (AllUtils.EndBattle / CalculateBattleResults / ResetBattleInfo).
import { PacketReader, PacketWriter } from "../../../src/net/packet.ts";
import { BAREFIST_ID, KNUCKLE_STAGE } from "../../../src/game/respawnSelect.ts";
import { pool } from "../db.ts";
import { config } from "../config.ts";
import type { Account } from "../shared/account.ts";
import * as dao from "../shared/dao.ts";
import { getPCCafe, data, CouponEffects } from "../shared/data.ts";
import { checkEquipedItems, tryCreateItem } from "../shared/playerUtils.ts";
import { getGood } from "../shared/shop.ts";
import { inventoryGetInfoAck } from "./packets.ts";
import { createCharacterGame } from "./profileHandlers.ts";
import { nowNum } from "../shared/time.ts";
import { getLabel } from "../shared/translation.ts";
import { announceAck } from "../auth/metaPackets.ts";
import type { PlayerEquipment } from "../shared/models.ts";
import { PlayerEquipment as Equip } from "../shared/models.ts";
import {
  RoomModel, SlotModel, RoomState, SlotState, Team, RoomCondition, DeadEnum, KILLS, ROUNDS, SWAP_ROUNDS, StageFlag, getMapLimit, pickRandomMap,
  battleEndHooks, slotLeftHooks,
} from "./roomModel.ts";
import * as rp from "./roomPackets.ts";
import * as pg from "./progress.ts";
import { handoffLeader } from "./voteLeader.ts";
import { syncPlayerToFriends } from "./socialHandlers.ts"; // cycle: socialHandlers imports roomOf; both are call-time only
import { applyClanMatchResult, broadcastRosterOf, checkClanMatchRestrict, clanMatchCheck, loadClanRanks, releaseClanMatch, releaseClanMatchIfUnused } from "./clanWarHandlers.ts";
import type { GameClient } from "./gameServer.ts";
import { signalKey } from "../web/signal.ts";
import { mintSignalTicket } from "../web/signalTicket.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} [game-ts] ${m}`);
export const roomOf = (a: Account | null): RoomModel | null => (a?.room as RoomModel | null) ?? null;
const pct = (t: number, p: number) => Math.trunc((t * p) / 100);
const INT_MAX = 2147483647;

// ---- static data for rewards ---------------------------------------------------------------------------------------
const rewardData = {
  ranks: new Map<number, { onNextLevel: number; onGoldUp: number; onAllExp: number }>(),
  rankUpEvents: [] as { id: number; begin: number; end: number; bonuses: Map<number, [number, number, number]> }[],
  boostEvents: [] as { begin: number; end: number; boostType: string; bonusExp: number; bonusGold: number; percent: number }[],
};
export async function loadRewardData(): Promise<void> {
  await loadClanRanks();
  rewardData.ranks = new Map((await pool.query(`SELECT * FROM system_player_ranks`)).rows.map((x) => [Number(x.id), { onNextLevel: Number(x.on_next_level), onGoldUp: Number(x.on_gold_up), onAllExp: Number(x.on_all_exp) }]));
  const ev = (await pool.query(`SELECT id, begin_date, ended_date FROM system_event_rankup ORDER BY id`)).rows.map((x) => ({ id: Number(x.id), begin: Number(x.begin_date), end: Number(x.ended_date), bonuses: new Map<number, [number, number, number]>() }));
  for (const x of (await pool.query(`SELECT event_id, rank_id, bonus_exp, bonus_point, percent FROM system_event_rankup_bonuses ORDER BY event_id, rank_id`)).rows) {
    ev.find((e) => e.id === Number(x.event_id))?.bonuses.set(Number(x.rank_id), [Number(x.bonus_exp), Number(x.bonus_point), Number(x.percent)]);
  }
  rewardData.rankUpEvents = ev;
  rewardData.boostEvents = (await pool.query(`SELECT * FROM system_event_boost ORDER BY id`)).rows.map((x) => ({ begin: Number(x.begin_date), end: Number(x.ended_date), boostType: String(x.boost_type), bonusExp: Number(x.bonus_exp), bonusGold: Number(x.bonus_gold), percent: Number(x.percent) }));
}
const running = <T extends { begin: number; end: number }>(l: T[]) => { const n = nowNum("yyMMddHHmm"); return l.find((e) => e.begin <= n && n < e.end) ?? null; };

// ---- helpers ---------------------------------------------------------------------------------------------------------
function send(a: Account, b: Uint8Array): void { (a.connection as GameClient | null)?.session.send(b); }

// ---- battle guard ------------------------------------------------------------------
// The battle runs in the leader's tab (P2P): kills (DEATH_REQ), respawns and the end of the clock (TIMERSYNC 0) are what the clients
// declare. These checks are web-port deviations from Server.Game [desvio do C#]; an honest client never trips them. A rejected packet is
// dropped with a rate-limited log line and a strike on the sender's slot; `strikes` of them in one match drop the session.

/** env knobs, read here so config.ts stays untouched: PB_DEV_OPS=1 opens the F2 test menu (5199) and an early leader TIMERSYNC 0
 * (room screen); PB_BATTLE_STRIKES = rejected battle packets of one slot in one match before its session drops */
export const battleGuard = { devOps: process.env.PB_DEV_OPS === "1", strikes: Number(process.env.PB_BATTLE_STRIKES) || 10 };
/** Character.pef Character.RespawnTime: one value for every mode, the
 * 4vs4 rooms only change InvincibleTime */
const RESPAWN_MS = 5000;
/** respawn coupons (CouponEffects): share of RespawnTime cut, the biggest wins [INFERIDO: the client's rule, loadout.ts RESPAWN_CUT_ITEMS] */
const RESPAWN_CUTS = [["Respawn100", 1], ["Respawn50", 0.5], ["Respawn30", 0.3], ["Respawn20", 0.2]] as const;
/** [RECRIADO] slack of the respawn hold (the killer's DEATH_REQ reaches the server later than the victim died) and of the TIMERSYNC
 * clock (whole seconds); floor of the time between two deaths of one victim (Respawn100 has no wait and firing ends the spawn
 * protection, Character.pef InvincibleTime) */
const RESPAWN_SLACK_MS = 1500, TIMER_SLACK_S = 3, MIN_LIFE_MS = 1000;
/** CharaDeath (Plugin.Core/Enums/CharaDeath.cs): UNK .. MEDICAL_KIT */
const CHARA_DEATH_MAX = 10;

function respawnMs(r: RoomModel, s: SlotModel): number {
  const fx = r.svc.getAccount(s.playerId)?.effects ?? 0n;
  const cut = RESPAWN_CUTS.find(([n]) => fx & CouponEffects[n])?.[1] ?? 0;
  return RESPAWN_MS * (1 - cut);
}

function guardLog(r: RoomModel, s: SlotModel, why: string): void {
  const now = Date.now();
  if (now - s.guardLogAt < 5000) return;
  s.guardLogAt = now;
  console.warn(`${new Date().toISOString()} [game-ts] battle guard: room #${r.roomId} slot ${s.id}: ${why} (strikes ${s.strikes}/${battleGuard.strikes})`);
}

function strike(c: GameClient, r: RoomModel, s: SlotModel, why: string): void {
  s.strikes++;
  guardLog(r, s, why);
  if (s.strikes !== battleGuard.strikes) return;
  log(`battle guard: room #${r.roomId} slot ${s.id} dropped after ${s.strikes} rejected battle packets`);
  c.session?.close(true, 500);
}

/** Weapons of the match: every slot's respawn equipment and items used (a weapon picked up from the floor came from someone's) */
function matchWeapons(r: RoomModel): Set<number> {
  const out = new Set<number>();
  for (const s of r.slots) {
    const e = s.equipment;
    if (e) for (const id of [e.weaponPrimary, e.weaponSecondary, e.weaponMelee, e.weaponExplosive, e.weaponSpecial]) out.add(id);
    for (const id of s.itemUsages) out.add(id);
  }
  return out;
}

/**why a DEATH_REQ is refused, or null. The killer is the sender's own fighting slot in every room (honest clients report only
 * their own kills: an AI kill never comes as DEATH_REQ), each victim a live fighter of the other team (or the killer itself) with no
 * more deaths than its time in battle allows. Victims already dead are left to the caller (skipped). The weapon is not a reason:
 * see handleDeath's missionKill. */
function deathReqError(r: RoomModel, p: Account, ks: SlotModel, k: rp.FragInfo): string | null {
  if (ks.id !== p.slotId || ks.state < SlotState.BATTLE || ks.specGM) return `DEATH_REQ for killer slot ${k.killerIdx}`;
  for (const f of k.frags) {
    const v = r.getSlot(f.victim);
    if (v && v.deathState & DeadEnum.Dead) continue;
    if (!v || v.state !== SlotState.BATTLE || v.playerId === 0n || v.specGM || v.spectator) return `DEATH_REQ victim slot ${f.victim} not fighting`;
    if (v.id !== ks.id && r.roomType !== RoomCondition.FreeForAll && v.team === ks.team) return `DEATH_REQ victim slot ${v.id} on the killer's team`;
    const lives = 1 + Math.floor((v.inBattleTime() * 1000) / Math.max(MIN_LIFE_MS, respawnMs(r, v)));
    if (v.allDeaths >= lives) return `DEATH_REQ victim slot ${v.id}: death ${v.allDeaths + 1} in ${Math.round(v.inBattleTime())} s`;
  }
  return null;
}

/**[RECRIADO: the reference port deploy/firebase/functions/src/resolve.ts EARN, the original pays the same with 2 or 16 players]: x0.5 with
 * 2 humans, x0.75 with 3, x1 with 4+, nothing below 2; x0.5 more for a match under 3 min (server clock). A human counts when it killed,
 * died, assisted or planted / defused (r.actors), so an idle alt adds nothing. An AI room keeps only the length factor. */
const HUMANS_FACTOR = [0, 0, 0.5, 0.75], SHORT_MATCH_MS = 3 * 60000;
export function rewardScale(r: RoomModel, bot: boolean, now = Date.now()): number {
  const humans = bot ? 1 : (HUMANS_FACTOR[r.actors.size] ?? 1);
  return humans * (r.matchStart && now - r.matchStart >= SHORT_MATCH_MS ? 1 : 0.5);
}

/** AllUtils.GetReadyPlayers(room, out fr, out ct, out enemies). */
export function readyCounts(r: RoomModel): { fr: number; ct: number; enemies: number } {
  let fr = 0, ct = 0, ffa = 0;
  for (const s of r.slots) {
    if (s.state !== SlotState.READY) continue;
    if (r.roomType === RoomCondition.FreeForAll && s.id > 0) { ffa++; continue; }
    if (s.team === Team.FR) fr++; else ct++;
  }
  let enemies = r.roomType === RoomCondition.FreeForAll ? ffa : r.leader % 2 === 0 ? ct : fr;
  // the 2-ready shortcut is for versus rooms (1v1 start); an AI room has no enemy to wait for: its humans may all sit in one team
  // (the bots fill the other), so 2 ready humans must still start it [desvio do C#: GetReadyPlayers forced enemies = 1 there too,
  // which left an AI room with leader + 2 ready guests unable to start; [INFERIDO] no proof in the exe]
  if (fr + ct === 2 && enemies === 0 && !r.isBotMode()) enemies = 1;
  return { fr, ct, enemies };
}

/** AllUtils.Check4vs4. */
function check4vs4(r: RoomModel, leader: boolean, fr: number, ct: number): boolean {
  if (!leader) return fr + ct >= 8;
  let excess = fr + ct + 1 - 8;
  if (excess <= 0) return false;
  for (let i = 15; i >= 0 && excess > 0; i--) {
    if (i === r.leader) continue;
    if (r.slots[i].state === SlotState.READY) { r.slots[i].state = SlotState.NORMAL; excess--; }
  }
  r.updateSlotsInfo();
  return true;
}

// ---- create / join / leave -------------------------------------------------------------------------------------------

export function handleCreateRoom(c: GameClient, rd: PacketReader): void {
  rd.readD();
  const name = rd.readU(46), mapId = rd.readC(), rule = rd.readC(), stage = rd.readC(), roomType = rd.readC(), reqState = rd.readC();
  const countPlayers = rd.readC(), slotCount = rd.readC(), ping = rd.readC(), weaponsFlag = rd.readH(), stageFlag = rd.readD();
  rd.readH(); const newInt = rd.readD(); rd.readH(); rd.readU(66);
  const killTime = rd.readD(), limit = rd.readC(), watchRuleFlag = rd.readC(); rd.readH();
  const randomMaps = rd.readB(24), cd = rd.readC() === 0 ? 5 : 3, leaderAddr = rd.readB(4), killCam = rd.readC(); rd.readH();
  const password = rd.readS(4); rd.readB(68);
  const aiCount = rd.readC(), aiLevel = rd.readC(), aiType = rd.readC();
  const p = c.player;
  if (!p || p.durationSince("createRoom") < 4.0) return;
  const ch = c.channelOf(p);
  if (!(ch && p.nickname.length > 0 && !p.room)) return; // err 0x80000000 is set but never sent
  p.last.createRoom = Date.now();
  for (let i = 0; i < ch.maxRooms; i++) {
    if (ch.getRoom(i)) continue;
    const r = c.newRoom(i, ch);
    r.name = name; r.mapId = mapId; r.rule = rule; r.stage = stage; r.roomType = roomType;
    r.generateSeed();
    r.state = reqState < RoomState.READY ? RoomState.READY : reqState;
    r.leaderName = p.nickname;
    r.ping = ping; r.weaponsFlag = weaponsFlag; r.flag = stageFlag; r.newInt = newInt;
    const bot = r.isBotMode();
    // AI room in the clan channel: C# sets Field0 = 0x8000107D (EVENT_ERROR_EVENT_CREATE_TRAINING_WRONG_CHANNEL, in the client's
    // strings) and never sends it. Sent here as the CREATE_ACK error [INFERIDO]: the client has the text, the server did not use it.
    if (bot && r.channelType === 4) return c.session.send(rp.createRoomAck(0x8000107d, null));
    r.killTime = killTime; r.limit = ch.type === 4 ? 1 : limit;
    r.watchRuleFlag = roomType === RoomCondition.Ace ? 142 : watchRuleFlag;
    r.balanceType = 0; r.randomMaps = randomMaps; r.countdownIG = cd; r.leaderAddr = leaderAddr; r.killCam = killCam; r.password = password;
    if (bot) { r.aiCount = aiCount; r.aiLevel = aiLevel; r.aiType = aiType; }
    r.setSlotCount(slotCount, true, false);
    r.countPlayers = countPlayers; r.countMaxSlots = slotCount;
    if (r.addPlayer(p) >= 0) {
      p.lastRoomPage = 0; p.lastPlayerPage = 0;
      ch.rooms.push(r);
      void syncPlayerToFriends(p, false);
      c.session.send(rp.createRoomAck(0, r));
      if (bot) c.session.send(rp.slotInfoAck(r));
      log(`room #${r.roomId} "${r.name}" map ${r.mapId} type ${r.roomType} created by ${p.nickname}`);
      break;
    }
  }
}

export function handleJoinRoom(c: GameClient, rd: PacketReader): void {
  const roomId = rd.readD(), pwd = rd.readS(4);
  rd.readC(); // C# Field1 "bypass" (== 1 skipped the password), ignored: see the password check
  const stealth = rd.remaining >= 1 && rd.readC() === 1; // web extension: a GM joins hidden, in an observer seat (16 / 17); ignored for other accounts
  const p = c.player;
  if (!p) return;
  const ch = c.channelOf(p);
  if (!(p.nickname && !p.room && ch)) return c.session.send(rp.joinRoomAck(0x80001004, null, null));
  const r = ch.getRoom(roomId);
  if (!r || !r.getLeader()) return c.session.send(rp.joinRoomAck(0x80001004, null, null));
  if (r.roomType === RoomCondition.Tutorial) return c.session.send(rp.joinRoomAck(0x8000107c, null, null));
  // C# also had `&& Field1 != 1`: one byte of the request skipped the password for anyone. The web client always sends 0 and the server
  // cannot tell an invite from a forged packet, so it is dropped [desvio do C#,]
  if (r.password.length && pwd !== r.password && p.rank !== 53 && !p.isGM()) return c.session.send(rp.joinRoomAck(0x80001005, null, null));
  if (r.limit === 1 && r.state >= RoomState.COUNTDOWN && !p.isGM()) return c.session.send(rp.joinRoomAck(0x80001013, null, null));
  if (r.kickedPlayersVote.includes(p.playerId) && !p.isGM()) return c.session.send(rp.joinRoomAck(0x8000100c, null, null));
  const kicked = r.kickedPlayersHost.get(p.playerId);
  if (kicked !== undefined && !p.isGM() && (Date.now() - kicked) / 1000 < config.intervalEnterRoomAfterKickSeconds) {
    // C# sent only the announce, so the client waited for 3586 until its timeout; the join
    // is also refused with the kicked code the client already maps (STBL) [INFERIDO: C# never answered]
    c.session.send(announceAck(getLabel("KickByHostMessage", config.intervalEnterRoomAfterKickSeconds, Math.trunc((Date.now() - kicked) / 1000))));
    return c.session.send(rp.joinRoomAck(0x8000100c, null, null));
  }
  if ((stealth && p.isGM() ? r.addStealthPlayer(p) : r.addPlayer(p)) >= 0) {
    p.lastRoomPage = 0; p.lastPlayerPage = 0;
    r.sendAboutSlot(p.slotId, rp.slotOneInfoAck(p, r), r.getAllPlayersExceptPid(p.playerId));
    c.session.send(rp.joinRoomAck(0, p, r));
    void syncPlayerToFriends(p, false); // C# RoomModel.AddPlayer: friends see the new room (Visitar needs state 6)
  } else c.session.send(rp.joinRoomAck(0x80001003, null, null));
}

/** RoomModel.RemovePlayer -> InternalRemovePlayer. */
export function removePlayer(r: RoomModel, p: Account, warnAll: boolean, motive = 0): void {
  const slot = r.getSlot(p.slotId);
  if (!slot) return;
  for (const hook of slotLeftHooks) hook(r, slot.id); // votes: cancel when the target / creator leaves
  let flag = false, host = false;
  if (slot.state >= SlotState.LOAD) {
    if (slot.id < 16 && slot.playerId > 0n) r.lastSeat.set(slot.playerId, slot.id);
    if (r.leader === slot.id) {
      const floor = r.state === RoomState.BATTLE ? SlotState.BATTLE_READY : r.state >= RoomState.LOADING ? SlotState.READY : SlotState.CLOSE;
      if (r.getAllPlayers(undefined, undefined, slot.id).length >= 1) r.setNewLeader(-1, floor, r.leader, false);
      if (r.getPlayingPlayers(Team.DRAW, SlotState.READY, 1) >= 2) r.sendToPlayers(rp.leaveP2PAck(r.leader), r.getAllPlayers(SlotState.RENDEZVOUS, 1, slot.id));
      host = true;
    }
    const leaving = rp.giveUpBattleAck(p, motive), others = r.getAllPlayers(SlotState.READY, 1, ...(warnAll ? [] : [slot.id]));
    r.sendToPlayers(leaving, slot.stealth ? others.filter((a) => a.isGM()) : others); // a hidden GM observer leaves unseen
    slot.resetSlot();
  }
  slot.playerId = 0n; slot.equipment = null; slot.state = SlotState.EMPTY; slot.stealth = false; slot.specGM = false;
  if (r.state === RoomState.COUNTDOWN) {
    if (slot.id === r.leader) {
      r.state = RoomState.READY; flag = true;
      if (r.countdownTimer) clearTimeout(r.countdownTimer);
      r.countdownTimer = null;
      r.sendToPlayers(rp.countdownAck(255));
    } else if (r.getPlayingPlayers(slot.team, SlotState.READY, 0) === 0) {
      r.changeSlotState(r.leader, SlotState.NORMAL, false);
      stopCountDown(r, 254, false);
      flag = true;
    }
  } else if (r.isPreparing()) {
    battleEndPlayersCount(r, r.isBotMode());
    // [web] a player left mid-round while a spectator waits (1v1 + spectator): the spectator counts as a team member above, so the
    // match goes on; the round must still end with the leaver's side wiped, and the spectator plays the next one
    if (r.state === RoomState.BATTLE) checkRoundWipe(r);
  }
  if ([RoomState.COUNTDOWN, RoomState.LOADING, RoomState.RENDEZVOUS].includes(r.state as 2) && (host || r.slots[r.leader]?.state === SlotState.BATTLE_READY)) endBattle(r, r.isBotMode(), Team.DRAW, true);
  r.requestRoomMaster = r.requestRoomMaster.filter((x) => x !== p.playerId);
  p.room = null; p.slotId = -1;
  if (r.clanMatch) broadcastRosterOf(p); // C# RoomModel.cs:1835 match.BroadcastRoster() after the match slot goes Normal
  releaseClanMatchIfUnused(r);
  p.status.roomId = 255;
  void dao.update1("accounts", "status", p.status.buffer, "player_id", p.playerId);
  void syncPlayerToFriends(p, false); // C# RoomModel.InternalRemovePlayer
  if (!r.channel.lobbyPlayers.includes(p)) r.channel.lobbyPlayers.push(p);
  r.updateSlotsInfo();
  if (flag) r.updateRoomInfo();
}

// ---- team / slot -----------------------------------------------------------------------------------------------------

export function handlePersonalTeamChange(c: GameClient, rd: PacketReader): void {
  const team = rd.readSignedD(), target = rd.readC();
  const p = c.player, r = roomOf(p);
  if (!p || !r || team === -1 || r.changingSlots) return;
  const cur = r.getSlot(p.slotId);
  if (!cur || cur.state !== SlotState.NORMAL) return;
  r.changingSlots = true;
  try {
    const ns = r.getSlot(target);
    if (!ns || ns.team !== team || ns.playerId !== 0n || ns.state !== SlotState.EMPTY) return;
    if (ns.id >= 16 && !p.isGM()) return; // slots 16 / 17 are the GM observer seats: never for a normal account (they skip the round counts and see both teams)
    if (cur.stealth && ns.id < 16) return; // [web] a hidden GM stays on the observer seats: a team seat would make it an invisible combatant (rejoin without the hidden option to play)
    const before = { oldId: cur.id, newId: ns.id };
    const stealth = cur.stealth; // a hidden GM moving between the observer seats stays hidden
    ns.resetSlot(); ns.state = SlotState.NORMAL; ns.playerId = p.playerId; ns.equipment = p.equipment; ns.stealth = stealth;
    if (ns.id === 16 || ns.id === 17) { ns.specGM = true; ns.viewType = 2; }
    cur.resetSlot(); cur.stealth = false; cur.state = SlotState.EMPTY; cur.playerId = 0n; cur.equipment = null; cur.specGM = false; cur.viewType = 0;
    if (r.leader === cur.id) { r.leaderName = p.nickname; r.leader = ns.id; }
    p.slotId = ns.id;
    r.sendToPlayers(rp.teamBalanceAck([{ oldId: before.oldId, newId: before.newId, oldState: cur.clientState(), newState: ns.clientState() }], r.leader, 0));
    // [web] full resync after the move: a client whose copy of the old slot was stale (missed a 3588 / 3622) kept a ghost
    // player and a wrong leader, and the rooms of the 4 clients diverged (3v1 start failures)
    r.updateSlotsInfo();
  } finally { r.changingSlots = false; }
}

// ---- ready / countdown / start ---------------------------------------------------------------------------------------

export function handleReadyBattle(c: GameClient, rd: PacketReader): void {
  const mode = rd.readC();
  const p = c.player, r = roomOf(p);
  if (!p || p.durationSince("readyBattle") < 0.7) return;
  if (!r || !r.getLeader()) return;
  const s = r.getSlot(p.slotId);
  if (!s) return;
  s.specGM = s.stealth || (mode === 2 && p.isGM()) || (r.roomType === RoomCondition.Ace && (s.id < 0 || s.id > 1)); // before any early return: a stealth GM is never a combatant, whatever mode the client sent or when
  if (!s.equipment) return c.session.send(rp.readyBattleAck(0x800010ab));
  const ml = getMapLimit(r.mapId, r.rule);
  if (!ml) return;
  const bot = r.isBotMode();
  const { fr, ct, enemies } = readyCounts(r);
  if (r.leader !== p.slotId) {
    if (r.slots[r.leader].state >= SlotState.LOAD && r.isPreparing()) {
      if (s.state === SlotState.NORMAL) {
        if (ml.limit === 8 && check4vs4(r, false, fr, fr)) return c.session.send(rp.errAck(3624, 0));
        if (r.balanceType !== 0 && !bot) { const moved = tryBalancePlayer(r, p, true); if (moved) return handleJoinerLoad(c, r, moved, p); }
        r.changeSlotState(s, SlotState.LOAD, true);
        s.missions = p.mission.clone();
        c.session.send(rp.readyBattleAck(s.state));
        c.session.send(rp.startGameAck(r, p.isGM()));
        r.sendAboutSlot(s.id, rp.startGameTransAck(r, s, p), r.getAllPlayers(SlotState.READY, 1, s.id));
      }
    } else if (s.state === SlotState.NORMAL) r.changeSlotState(s, SlotState.READY, true);
    else if (s.state === SlotState.READY) {
      r.changeSlotState(s, SlotState.NORMAL, false);
      if (r.state === RoomState.COUNTDOWN && r.getPlayingPlayers(r.leader % 2 === 0 ? Team.CT : Team.FR, SlotState.READY, 0) === 0) {
        r.changeSlotState(r.leader, SlotState.NORMAL, false);
        stopCountDown(r, 254);
      }
      r.updateSlotsInfo();
    }
  } else {
    if (r.state !== RoomState.READY && r.state !== RoomState.COUNTDOWN) return;
    if (ml.limit === 8 && check4vs4(r, true, fr, ct)) return c.session.send(rp.errAck(3624, 0));
    // ClanMatchCheck (AllUtils.cs:2682): clan rooms need 2 clans, and with enemies both sides need players
    const clanErr = clanMatchCheck(r, enemies);
    if (clanErr) return c.session.send(rp.readyBattleAck(clanErr));
    // ClanMatchCheck is skipped with Settings.ini Test=True; CompetitiveMatchCheck only applies to competitive rooms
    const readyN = r.getAllPlayers(SlotState.READY, 1).length;
    if (enemies === 0 && (bot || r.roomType === RoomCondition.Tutorial)) {
      r.changeSlotState(s, SlotState.READY, false); startBattle(r, false); r.updateSlotsInfo();
    } else if (!bot && (enemies > 0 || readyN === 2)) {
      r.changeSlotState(s, SlotState.READY, false);
      if (r.balanceType !== 0) tryBalanceTeams(r);
      if (readyN === 2 && r.roomType !== RoomCondition.Ace) startBattle(r, false);
      else if (!r.thisModeHaveCD()) startBattle(r, false);
      else if (r.state === RoomState.READY) {
        if (r.roomType === RoomCondition.Ace && (r.slots[0].state !== SlotState.READY || r.slots[1].state !== SlotState.READY)) {
          c.session.send(rp.readyBattleAck(0x80001009)); r.changeSlotState(r.leader, SlotState.NORMAL, false); stopCountDown(r, 255);
        } else { r.state = RoomState.COUNTDOWN; r.updateRoomInfo(); startCountDown(r); }
      } else if (r.state === RoomState.COUNTDOWN) { r.changeSlotState(r.leader, SlotState.NORMAL, false); stopCountDown(r, 255); }
      r.updateSlotsInfo();
    } else if (enemies === 0 && !bot) c.session.send(rp.readyBattleAck(0x80001009));
  }
  p.last.readyBattle = Date.now();
}

/** The rest of the joiner path above, on the slot the balance moved them to. */
function handleJoinerLoad(c: GameClient, r: RoomModel, s: SlotModel, p: Account): void {
  r.changeSlotState(s, SlotState.LOAD, true);
  s.missions = p.mission.clone();
  c.session.send(rp.readyBattleAck(s.state));
  c.session.send(rp.startGameAck(r, p.isGM()));
  r.sendAboutSlot(s.id, rp.startGameTransAck(r, s, p), r.getAllPlayers(SlotState.READY, 1, s.id));
  p.last.readyBattle = Date.now();
}

// ---- team balance (AllUtils.TryBalancePlayer / GetBalanceTeamIdx / TryBalanceTeams, RoomModel.SwitchSlots) ----------
// Only the player count is balanced: BalanceType Rank takes the same path as Count in TryBalancePlayer and none in
// TryBalanceTeams (C# checks `!= TeamBalance.Count` there), so it is kept that way.

const TEAM_SLOTS = [[0, 2, 4, 6, 8, 10, 12, 14], [1, 3, 5, 7, 9, 11, 13, 15]] as const;

/** GetBalanceTeamIdx: the team that should receive a player, Team.ALL when already even. */
function balanceTeamIdx(r: RoomModel, inBattle: boolean, playerTeam: number): number {
  let fr = inBattle && playerTeam === Team.FR ? 1 : 0, ct = inBattle && playerTeam === Team.CT ? 1 : 0;
  for (const x of r.slots.slice(0, 16)) {
    if ((x.state === SlotState.NORMAL && !inBattle) || (x.state >= SlotState.LOAD && inBattle)) { if (x.team === Team.FR) fr++; else ct++; }
  }
  if (fr + 1 < ct) return Team.FR;
  return ct + 1 < fr + 1 ? Team.CT : Team.ALL;
}

/** RoomModel.SwitchSlots(changes, newId, oldId, false): the two slot objects trade places, states kept. */
function switchSlots(r: RoomModel, newId: number, oldId: number): rp.SlotChange {
  const a = r.slots[newId], b = r.slots[oldId];
  r.slots[newId] = Object.assign(b, { id: newId, team: newId % 2 });
  r.slots[oldId] = Object.assign(a, { id: oldId, team: oldId % 2 });
  return { oldId, newId, oldState: r.slots[oldId].clientState(), newState: r.slots[newId].clientState() };
}

/** TryBalancePlayer: moves `p` to the first free slot of the other team when theirs is ahead; returns the new slot. */
function tryBalancePlayer(r: RoomModel, p: Account, inBattle: boolean): SlotModel | null {
  const cur = r.getSlot(p.slotId);
  // [web] a GM observer is on no team: the hidden GM's READY landing after the leader's start (joiner path) moved it from
  // seat 16 / 17 into a combatant seat, announced by a 3622 to every account [desvio do C#: TryBalancePlayer has no such check]
  if (!cur || cur.specGM) return null;
  const want = balanceTeamIdx(r, inBattle, cur.team);
  if (want === cur.team || want === Team.ALL) return null;
  const target = TEAM_SLOTS[cur.team === Team.CT ? 0 : 1].map((i) => r.slots[i]).find((x) => x.state !== SlotState.CLOSE && x.playerId === 0n);
  if (!target) return null;
  const change = switchSlots(r, target.id, cur.id);
  p.slotId = change.newId;
  r.sendToPlayers(rp.teamBalanceAck([change], r.leader, 1));
  r.updateSlotsInfo();
  return r.slots[change.newId];
}

/** TryBalanceTeams (leader pressed start, BalanceType Count): the last READY non-leader of the bigger team moves. */
function tryBalanceTeams(r: RoomModel): void {
  if (r.balanceType !== 1 || r.isBotMode()) return;
  const want = balanceTeamIdx(r, false, Team.ALL);
  if (want === Team.ALL) return;
  const from = TEAM_SLOTS[want === Team.CT ? 0 : 1];
  for (let i = from.length - 1; i >= 0; i--) {
    const x = r.slots[from[i]];
    if (x.state !== SlotState.READY || x.id === r.leader) continue;
    const a = r.svc.getAccount(x.playerId);
    if (a) tryBalancePlayer(r, a, false);
    return;
  }
}

function startCountDown(r: RoomModel): void {
  r.sendToPlayers(rp.countdownAck(5));
  if (r.countdownTimer) clearTimeout(r.countdownTimer);
  r.countdownEnd = Date.now() + 5250;
  r.countdownTimer = setTimeout(() => {
    r.countdownTimer = null;
    if (r.state !== RoomState.COUNTDOWN) return;
    if (r.slots[r.leader].state !== SlotState.READY) return stopCountDown(r, 255);
    if (r.getCountPlayers() < 2 || r.getReadyPlayers() < 2) return stopCountDown(r, 254);
    if (r.roomType !== RoomCondition.FreeForAll && (r.getPlayingPlayers(Team.FR, SlotState.READY, 0) === 0 || r.getPlayingPlayers(Team.CT, SlotState.READY, 0) === 0)) return stopCountDown(r, 254);
    startBattle(r, true);
  }, 5250);
}

function stopCountDown(r: RoomModel, type: number, refresh = true): void {
  if (r.state !== RoomState.COUNTDOWN) return;
  r.state = RoomState.READY;
  if (refresh) r.updateRoomInfo();
  if (r.countdownTimer) clearTimeout(r.countdownTimer);
  r.countdownTimer = null;
  r.sendToPlayers(rp.countdownAck(type));
}

/** RoomModel.StopCountDown(int SlotId): a player opened the shop / inventory / profile / clan screen during the countdown
 * (SHOP_ENTER, INVENTORY_ENTER, ROOM_INFO_ENTER, CS_CLIENT_ENTER). Like the C#, the non-leader case counts the leader's own
 * team, which the READY leader keeps above 0: in practice only the leader stops it (255). */
export function stopCountDownBySlot(r: RoomModel, slotId: number): void {
  if (r.state !== RoomState.COUNTDOWN) return;
  if (slotId === r.leader) return stopCountDown(r, 255);
  if (r.getPlayingPlayers(r.slots[r.leader].team, SlotState.READY, 0) === 0) {
    r.changeSlotState(r.leader, SlotState.NORMAL, false);
    stopCountDown(r, 254);
  }
}

/** RoomModel.StartBattle. */
function startBattle(r: RoomModel, updInfo: boolean): void {
  if ((r.flag & StageFlag.RANDOM_MAP) && !r.isBotMode()) {
    const id = pickRandomMap(r.randomMaps, r.rule);
    if (id >= 0 && id !== r.mapId) { r.mapId = id; r.updateRoomInfo(); }
  }
  r.state = RoomState.LOADING;
  r.requestRoomMaster = [];
  checkClanMatchRestrict(r); // C# StartBattle: CheckClanMatchRestrict
  if (r.isBotMode()) { r.ingameAiLevel = r.aiLevel; for (const s of r.slots) s.aiLevel = r.ingameAiLevel; }
  r.startTick = BigInt(Date.now()) * 10000n + 621355968000000000n;
  r.startDate = nowNum("yyMMddHHmm");
  const bytes = rp.startGameAck(r), bytesGm = rp.startGameAck(r, true);
  for (const a of r.getAllPlayers(SlotState.READY, 0)) {
    const s = r.slots[a.slotId];
    s.withHost = true; s.state = SlotState.LOAD; s.missions = a.mission.clone();
    send(a, a.isGM() ? bytesGm : bytes);
  }
  if (updInfo) r.updateSlotsInfo();
  r.updateRoomInfo();
}

// ---- loading / prestart / start --------------------------------------------------------------------------------------

function startCounter(r: RoomModel, type: number, p: Account, s: SlotModel): void {
  s.stopTiming();
  s.timing = setTimeout(() => {
    s.timing = null;
    if (p.room !== r || p.slotId !== s.id) return;
    send(p, rp.kickBattlePlayerAck(type === 0 ? 0x8000100a : 0x8000100b));
    send(p, rp.giveUpBattleAck(p, 0));
    r.changeSlotState(s, SlotState.NORMAL, true);
    battleEndPlayersCount(r, r.isBotMode());
  }, type === 0 ? 90000 : 30000);
}

export function handleLoadingStart(c: GameClient, rd: PacketReader): void {
  const name = rd.readS(rd.readC());
  const p = c.player, r = roomOf(p);
  if (p && r && r.isPreparing()) {
    const s = r.getSlot(p.slotId);
    if (s && s.state === SlotState.LOAD) {
      s.preLoadDate = Date.now();
      startCounter(r, 0, p, s);
      r.changeSlotState(s, SlotState.RENDEZVOUS, true);
      r.mapName = name;
      if (s.id === r.leader) { r.udpServer = { host: "127.0.0.1", port: config.matchPort }; r.state = RoomState.RENDEZVOUS; r.updateRoomInfo(); }
    }
  }
  c.session.send(rp.loadingStartAck());
  if (p && r) for (const o of r.slots) if (o.id !== p.slotId && (!o.stealth || p.isGM()) && o.equipment && o.playerId > 0n && r.svc.getAccount(o.playerId)) c.session.send(rp.userEquipmentAck(r, o));
}

export function handleGetUserEquipment(c: GameClient, rd: PacketReader): void {
  const slot = rd.readC();
  const p = c.player, r = roomOf(p);
  if (p && r && slot !== p.slotId && r.getSlot(slot) && (!r.getSlot(slot)!.stealth || p.isGM())) c.session.send(rp.userEquipmentAck(r, r.getSlot(slot)));
}

export function handlePreStartBattle(c: GameClient, rd: PacketReader): void {
  const map = rd.readC(), rule = rd.readC(), stage = rd.readC(), rt = rd.readC();
  const p = c.player, r = roomOf(p);
  if (!p || !r) return;
  const bot = r.isBotMode();
  if (r.stage !== stage || r.roomType !== rt || r.mapId !== map || r.rule !== rule) {
    c.session.send(rp.kickBattlePlayerAck(0x8000100a)); c.session.send(rp.preStartBattleAck(null, null, true));
    r.changeSlotState(p.slotId, SlotState.NORMAL, true); battleEndPlayersCount(r, bot); return;
  }
  const s = r.getSlot(p.slotId);
  if (!(s && r.isPreparing() && r.udpServer && s.state >= SlotState.LOAD)) {
    r.changeSlotState(s, SlotState.NORMAL, true); battleEndPlayersCount(r, bot); s?.stopTiming(); return; // 5132() writes nothing
  }
  const L = r.getLeader();
  if (!L) {
    c.session.send(rp.kickBattlePlayerAck(0x8000100b)); c.session.send(rp.giveUpBattleAck(p, 0));
    r.changeSlotState(s, SlotState.NORMAL, true); battleEndPlayersCount(r, bot); s.stopTiming(); return;
  }
  s.preStartDate = Date.now();
  if (s.id === r.leader) { r.state = RoomState.PRE_BATTLE; r.updateRoomInfo(); }
  r.changeSlotState(s, SlotState.PRESTART, true);
  // [web] the /signal ticket of this account and slot, ahead of the 5130 that gives the client the room key
  c.session.sendText({ t: "signalTicket", ticket: mintSignalTicket(signalKey(r.uniqueRoomId, r.seed), s.id, p.playerId) });
  c.session.send(rp.preStartBattleAck(p, r, true));
  if (s.id !== r.leader) send(L, rp.preStartBattleAck(p, r, false));
  startCounter(r, 1, p, s);
}

export function handleStartBattle(c: GameClient): void {
  const p = c.player, r = roomOf(p);
  if (!p || !r || !r.getLeader()) return;
  const ch = r.channel;
  if (!r.isPreparing()) { c.session.send(rp.kickBattlePlayerAck(0x8000100b)); r.changeSlotState(p.slotId, SlotState.NORMAL, true); return; }
  const s = r.getSlot(p.slotId), bot = r.isBotMode();
  if (s?.state !== SlotState.PRESTART) {
    c.session.send(rp.kickBattlePlayerAck(0x8000100b)); c.session.send(rp.giveUpBattleAck(p, 0));
    r.changeSlotState(s, SlotState.NORMAL, true); battleEndPlayersCount(r, bot); return;
  }
  r.changeSlotState(s, SlotState.BATTLE_READY, true);
  s.stopTiming();
  c.session.send(r.buildRoomInfo());
  let total = 0, fr = 0, ctn = 0, rdy = 0, rFr = 0, rCt = 0;
  for (const x of r.slots) {
    if (x.state < SlotState.LOAD || x.specGM) continue; // a GM observer is never waited for (the others spawn without it)
    total++; if (x.team === Team.FR) fr++; else ctn++;
    if (x.state >= SlotState.BATTLE_READY) { rdy++; if (x.team === Team.FR) rFr++; else rCt++; }
  }
  const L = r.slots[r.leader], lFR = L && L.team === Team.FR;
  const inBattle = r.state === RoomState.BATTLE;
  const f2 = !!L && L.state >= SlotState.BATTLE_READY && bot && (total <= 1 || (lFR && rFr > Math.trunc(fr / 2)) || (!lFR && rCt > Math.trunc(ctn / 2)));
  const f3 = !!L && L.state >= SlotState.BATTLE_READY && rCt > Math.trunc(ctn / 2) && rFr > Math.trunc(fr / 2);
  const f4 = !!L && L.state >= SlotState.BATTLE_READY && r.roomType === RoomCondition.FreeForAll && rdy >= 2 && total >= 2;
  // C# PROTOCOL_BATTLE_STARTBATTLE_REQ.cs:74 flag5 = Clan && num1 == num3 + num2, but num1 is always num2 + num3 (each ready
  // slot adds to one team), so the C# test is always true and a clan room spawned on the first STARTBATTLE with the other
  // team still loading. Intent [INFERIDO]: num1 == num4 (every loaded player ready, num4 = `total` here).
  const f5 = ch.type === 4 && rdy === total;
  if (!(inBattle || f2 || f3 || f4 || f5)) return;
  spawnReadyPlayers(r);
}

function spawnReadyPlayers(r: RoomModel): void {
  const cdMode = r.thisModeHaveRounds() && [3, 5, 7, 9].includes(r.countdownIG);
  if (r.state === RoomState.PRE_BATTLE && !r.preMatchCD && cdMode && !r.isBotMode()) {
    r.preMatchCD = true;
    r.sendToPlayers(new Uint8Array([5275 & 0xff, 5275 >> 8, r.countdownIG]));
  }
  if (r.preMatchTimer) clearTimeout(r.preMatchTimer);
  r.preMatchTimer = setTimeout(() => { r.preMatchTimer = null; executeSpawnReadyPlayers(r); }, r.countdownIG === 0 ? 0 : r.countdownIG * 1000 + 250);
}

const SPECTATE_TYPES: number[] = [RoomCondition.Bomb, RoomCondition.Annihilation, RoomCondition.Convoy, RoomCondition.Ace, RoomCondition.Glass];

function getDinossaurs(r: RoomModel, force: boolean, idx: number): number[] {
  if (!r.isDinoMode()) return [];
  const team = r.rounds === 1 ? 0 : 1;
  const list = r.slots.filter((s) => s.id % 2 === team && s.state === SlotState.BATTLE && !s.specGM).map((s) => s.id);
  if ((r.tRex === -1 || r.slots[r.tRex].state <= SlotState.BATTLE_LOAD || force) && list.length > 1 && r.isDinoMode("DE")) {
    if (idx >= 0 && list.includes(idx)) r.tRex = idx;
    else if (idx === -2) r.tRex = list[Math.floor(Math.random() * list.length)];
  }
  return list;
}

function executeSpawnReadyPlayers(r: RoomModel): void {
  const now = Date.now();
  for (const s of r.slots) {
    if (s.state === SlotState.BATTLE_READY && s.isPlaying === 0 && s.playerId > 0n) {
      s.isPlaying = 1; s.startTime = now; s.state = SlotState.BATTLE;
      if (r.state === RoomState.BATTLE && SPECTATE_TYPES.includes(r.roomType)) s.spectator = true;
    }
  }
  r.updateSlotsInfo();
  const dinos = getDinossaurs(r, false, -1);
  if (r.state === RoomState.PRE_BATTLE) { r.battleStart = r.isDinoMode() ? now + 5 * 60000 : now; r.matchStart = now; setGameModeSpecificBars(r); }
  const b1 = rp.roundPreStartAck(r, dinos), b2 = rp.roundStartAck(r), b3 = rp.recordAck(r);
  let dinoFlag = false;
  for (const s of r.slots) {
    const P = s.playerId > 0n ? r.svc.getAccount(s.playerId) : null;
    if (!(s.state === SlotState.BATTLE && s.isPlaying === 1 && P)) continue;
    s.isPlaying = 2;
    if (r.state === RoomState.PRE_BATTLE) {
      r.sendAboutSlot(s.id, rp.startBattleAck(r, s, dinos), r.getAllPlayers(SlotState.READY, 1));
      send(P, b1);
      if (!r.isDinoMode()) send(P, b2); else dinoFlag = true;
    } else if (r.state === RoomState.BATTLE) {
      r.sendAboutSlot(s.id, rp.startBattleAck(r, s, dinos), r.getAllPlayers(SlotState.READY, 1));
      if (!SPECTATE_TYPES.includes(r.roomType)) send(P, b1);
      send(P, b2); send(P, b3);
    }
  }
  if (r.state === RoomState.PRE_BATTLE) { r.state = RoomState.BATTLE; r.updateRoomInfo(); }
  r.updateSlotsInfo();
  if (dinoFlag) r.roundTimer = setTimeout(() => { r.roundTimer = null; if (r.state === RoomState.BATTLE) r.sendToPlayers(rp.roundStartAck(r), r.getAllPlayers(SlotState.BATTLE, 0)); }, 5250);
}

export function handleSendPing(c: GameClient, rd: PacketReader): void {
  const b = rd.readB(16);
  const p = c.player, r = roomOf(p);
  if (!p || !r) return;
  const s = r.getSlot(p.slotId);
  if (!s || s.state < SlotState.BATTLE_READY) return;
  if (r.state === RoomState.BATTLE) r.ping = b[r.leader];
  r.pingReports.set(p.slotId, b.slice()); // voteLeader: best-ping candidate
  const pkt = rp.pingAck(b);
  let recipients = 0, notReady = 0;
  for (const a of r.getAllPlayers(SlotState.READY, 1)) {
    const x = r.slots[a.slotId];
    if (x && x.state >= SlotState.BATTLE_READY) { send(a, pkt); recipients++; } else notReady++;
  }
  if (recipients === 0) return;
  if (notReady === 0) spawnReadyPlayers(r);
}

// ---- in battle -------------------------------------------------------------------------------------------------------

export function handleRespawn(c: GameClient, rd: PacketReader): void {
  const f: number[] = [];
  for (let i = 0; i < 7; i++) { const id = rd.readD(); rd.readD(); if (i < 5) f.push(id); }
  rd.readD(); rd.readD();
  for (let i = 0; i < 10; i++) { f.push(rd.readD()); rd.readD(); }
  const wflags = rd.readH();
  f.push(rd.readD()); rd.readD();
  const p = c.player;
  if (p) respawnSlot(c, p, roomOf(p), f, wflags);
}

function respawnSlot(c: GameClient, p: Account, r: RoomModel | null, f: number[], wflags: number): void {
  if (!r || p.room !== r || (r.state !== RoomState.BATTLE && r.state !== RoomState.PRE_BATTLE)) return;
  const s = r.getSlot(p.slotId);
  if (!s || s.state !== SlotState.BATTLE) return;
  // after a DEATH_REQ death the respawn waits RespawnTime (coupon cut, minus the slack); an early one is served when due, not
  // dropped, so a late kill report never leaves an honest player dead on the server. The round restart (UseChat) respawns at once.
  const wait = s.deathState & DeadEnum.Dead && !(s.deathState & DeadEnum.UseChat) ? s.deathAt + respawnMs(r, s) - RESPAWN_SLACK_MS - Date.now() : 0;
  if (wait > 0) {
    if (s.respawnTimer) clearTimeout(s.respawnTimer);
    s.respawnTimer = setTimeout(() => { s.respawnTimer = null; respawnSlot(c, p, roomOf(p), f, wflags); }, wait);
    guardLog(r, s, `RESPAWN ${Math.round(wait)} ms early, held`);
    return;
  }
  if (s.deathState & DeadEnum.Dead) { if (s.specGM) return; s.deathState = DeadEnum.Alive; }
  else if (s.deathState & DeadEnum.UseChat) s.deathState = DeadEnum.Alive;
  const E = validateRespawnEQ(s, f);
  // Clube da Luta (stage 224): the bare fist only, the loadout the client builds (respawnEquipFor / enforceRoomWeapons)
  if (r.stage === KNUCKLE_STAGE) Object.assign(E, { weaponPrimary: 0, weaponSecondary: 0, weaponMelee: BAREFIST_ID, weaponExplosive: 0 });
  checkEquipedItems(E, p.inventory.items, true);
  s.equipment = E;
  if (wflags & 8) s.itemUsages.push(E.weaponPrimary);
  if (wflags & 4) s.itemUsages.push(E.weaponSecondary);
  if (wflags & 2) s.itemUsages.push(E.weaponMelee);
  if (wflags & 1) s.itemUsages.push(E.weaponExplosive);
  s.itemUsages.push(E.weaponSpecial, E.partHead, E.partFace, E.beretItem, E.accessoryId);
  const pkt = rp.respawnAck(r, s);
  if (s.specGM) { if (s.firstRespawn) c.session.send(pkt); }
  else r.sendToPlayers(pkt, r.getAllPlayers(SlotState.BATTLE, 0));
  s.firstRespawn = false; // EquipmentSync UDP to the .NET Match (type 0 / 2) is not sent: no sync link from TS (P2P host handles it)
}

/** AllUtils.ValidateRespawnEQ. */
function validateRespawnEQ(s: SlotModel, f: number[]): PlayerEquipment {
  const src = s.equipment ?? new Equip();
  const e: PlayerEquipment = Object.assign(new Equip(), src, { emoticons: [...src.emoticons] });
  [e.weaponPrimary, e.weaponSecondary, e.weaponMelee, e.weaponExplosive, e.weaponSpecial] = f.slice(0, 5);
  const id = f[5], cls = Math.trunc(id / 100000), side = Math.trunc((id % 100000) / 1000), sp = Math.trunc(id / 1000);
  if (cls === 6) { if (side === 1 || sp === 632) e.charaRedId = id; else if (side === 2 || sp === 664) e.charaBlueId = id; }
  else if (cls === 15) e.dinoItem = id;
  [e.partHead, e.partFace, e.partJacket, e.partPocket, e.partGlove, e.partBelt, e.partHolster, e.partSkin, e.beretItem] = f.slice(6, 15);
  e.accessoryId = f[15];
  return e;
}

const KM = { Piercing: 1, MassKill: 2, ChainStopper: 4, Headshot: 8, ChainHeadshot: 16, ChainSlugger: 32, Suicide: 64, ObjectDefense: 128 };
function killScore(flag: number): number {
  switch (flag) {
    case KM.Piercing: case KM.MassKill: return 6;
    case KM.ChainStopper: return 8;
    case KM.Headshot: return 10;
    case KM.ChainHeadshot: return 14;
    case KM.ChainSlugger: return 6;
    case KM.Suicide: return 0;
    case KM.ObjectDefense: return 7;
    default: return 5;
  }
}

export function handleDeath(c: GameClient, rd: PacketReader): void {
  const k: rp.FragInfo = {
    killingType: rd.readC(), killsCount: rd.readC(), killerIdx: rd.readC(), weapon: rd.readD(), x: rd.readT(), y: rd.readT(), z: rd.readT(),
    flag: rd.readC(), unk: rd.readC(), frags: [], score: 0,
  };
  for (let i = 0; i < k.killsCount; i++) {
    k.frags.push({ victim: rd.readC(), weaponClass: rd.readC(), hitspotInfo: rd.readC(), killFlag: rd.readH(), unk: rd.readC(), x: rd.readT(), y: rd.readT(), z: rd.readT(), assist: rd.readC(), unks: rd.readB(4) });
  }
  const suicide = k.frags.some((f) => f.victim === k.killerIdx);
  const p = c.player, r = roomOf(p);
  if (!p || !r || r.roundTimer || r.state < RoomState.BATTLE) return;
  const bot = r.isBotMode(), ks = r.getSlot(k.killerIdx), me = r.getSlot(p.slotId);
  if (!ks || !me) return;
  if (k.frags.length && k.frags.every((f) => (r.slots[f.victim]?.deathState ?? 0) & DeadEnum.Dead)) return;
  //(the C# only checked the killer slot, and not in AI rooms: `!bot && ...`)
  const bad = deathReqError(r, p, ks, k);
  if (bad) return strike(c, r, me, bad);
  let score = 0;
  const weaponClass = Math.trunc(k.weapon / 100000);
  for (const f of k.frags) {
    const v = r.getSlot(f.victim);
    // a death type past CharaDeath becomes DEFAULT (also in the 5136 echoed to everyone); the low nibble is left as sent
    if (f.hitspotInfo >> 4 > CHARA_DEATH_MAX) f.hitspotInfo = 0x10 | (f.hitspotInfo & 15);
    const dt = f.hitspotInfo >> 4;
    if (k.killsCount - (suicide ? 1 : 0) <= 1) {
      const type = dt === 1 && weaponClass === 3 ? 6 : dt === 3 ? 4 : 0;
      if (type === 4 || type === 6) {
        const chain = type === 4 ? KM.ChainHeadshot : KM.ChainSlugger, single = type === 4 ? KM.Headshot : 0;
        const prevType = ks.lastKillState >> 12;
        ks.lastKillState = (type << 12) | (ks.killsOnLife + 1);
        if (ks.repeatLastState && prevType === type) { if ((ks.lastKillState & 0x3fff) > 1) f.killFlag |= chain; else if (single) f.killFlag |= single; }
        else { if (single) f.killFlag |= single; ks.repeatLastState = true; }
      } else { ks.lastKillState = 0; ks.repeatLastState = false; }
    } else {
      f.killFlag |= [2, 5, 7, 9, 8].includes(dt) || weaponClass === 6 ? KM.MassKill : KM.Piercing;
    }
    if (!v || v.deathState & DeadEnum.Dead) continue;
    if (v.killsOnLife > 3) f.killFlag |= KM.ChainStopper;
    v.allDeaths++;
    if (f.assist !== k.killerIdx && r.getSlot(f.assist)) r.slots[f.assist].allAssists++;
    if (r.roomType !== RoomCondition.FreeForAll) {
      if (ks.team !== v.team) {
        score += killScore(f.killFlag);
        ks.allKills++;
        if (ks.deathState === DeadEnum.Alive) ks.killsOnLife++;
        if (v.team === Team.FR) { r.frDeaths++; r.ctKills++; } else { r.ctDeaths++; r.frKills++; }
        if (r.isDinoMode("DE")) { if (ks.team === Team.FR) r.frDino += 4; else r.ctDino += 4; }
      }
    } else { ks.allKills++; if (ks.deathState === DeadEnum.Alive) ks.killsOnLife++; }
    v.lastKillState = 0; v.killsOnLife = 0; v.passSequence = 0; v.repeatLastState = false; v.deathState = DeadEnum.Dead; v.deathAt = Date.now();
    r.actors.add(ks.playerId).add(v.playerId);
    if (f.assist !== k.killerIdx && r.slots[f.assist]?.playerId) r.actors.add(r.slots[f.assist].playerId);
    if (!bot) {
      const arr = { 1: "ar", 2: "smg", 4: "sr", 6: "sg", 5: "mg", 7: "shd" }[f.weaponClass] as "ar" | undefined;
      if (arr) { ks[arr][0]++; v[arr][1]++; }
      pg.completeMission(r, v, pg.MT.DEATH, 0);
    }
    if (dt === 3) ks.allHeadshots++;
  }
  if (!bot) {
    ks.score += score;
    // a weapon no slot of the match has equipped counts the kill but earns no weapon mission. Not refused: honest clients report
    // some kills by name (src/net/battle.ts weaponIdOfName: a 9-digit id for the default loadout, the first weapons.json variant of a name)
    const missionKill = k.weapon === 0 || matchWeapons(r).has(k.weapon) ? k : { ...k, weapon: 0 };
    pg.completeMissionKills(r, ks, missionKill, pg.MT.NA, 0);
    k.score = score;
  }
  else { ks.score = Math.min(65535, ks.score + ks.killsOnLife + r.ingameAiLevel + score); k.score = ks.score; }
  r.sendToPlayers(rp.deathAck(r, k, ks), r.getAllPlayers(SlotState.BATTLE, 0));
  if (isWipeMode(r.roomType)) checkRoundWipe(r);
  // AI rooms too: the P2P host reports the bots' kills as DEATH_REQ, so the kill goal ends the match here.
  // With `!bot` the goal was never checked, and the leader's TIMERSYNC 0 is refused while the round clock runs (handleTimerSync).
  else if (r.roomType === RoomCondition.DeathMatch) checkBattleEndByKills(r, bot);
  else if (r.roomType === RoomCondition.FreeForAll) checkBattleEndByKills(r, bot);
}

function checkBattleEndByKills(r: RoomModel, bot: boolean): void {
  const lim = KILLS[r.killTime & 15];
  if (r.frKills < lim && r.ctKills < lim) return;
  finishMatch(r, bot, getWinnerTeam(r), true);
}

export function handleTimerSync(c: GameClient, rd: PacketReader): void {
  const time = rd.readD() >>> 0; rd.readT();
  const round = rd.readC(), ping = rd.readC(); rd.readC();
  const latency = rd.readH();
  const p = c.player, r = roomOf(p);
  if (!p || !r) return;
  const s = r.getSlot(p.slotId);
  if (!s || s.state !== SlotState.BATTLE) return;
  const bot = r.isBotMode();
  if (!bot) {
    s.latency = latency; s.ping = ping;
    if (latency >= config.maxLatency) s.failLatencyTimes++; else s.failLatencyTimes = 0;
    if (s.failLatencyTimes >= config.maxRepeatLatency) { c.session.close(true, 500); return; }
    if (Date.now() - r.lastPingSync >= 7000) {
      r.lastPingSync = Date.now();
      r.sendToPlayers(rp.pingAck(new Uint8Array(r.slots.map((x) => x.ping))), r.getAllPlayers(SlotState.BATTLE, 0));
    }
  }
  const end = (time === 0 || time > 0x80000000) && r.rounds === round && r.state === RoomState.BATTLE;
  // the clock is the leader's (the match host's), and its 0 only once the server's own clock of the round is out too
  // (the client starts its clock on the server's round start, so an honest one is never ahead) [desvio do C#: any slot, any time]
  if (s.id !== r.leader) { if (end) strike(c, r, s, "TIMERSYNC 0 from a non-leader slot"); return; }
  if (end && !battleGuard.devOps && r.getInBattleTimeLeft() > TIMER_SLACK_S) return strike(c, r, s, `TIMERSYNC 0 with ${r.getInBattleTimeLeft()} s left`);
  r.timeRoom = time;
  if (!end) return;
  if (r.isDinoMode()) {
    if (r.rounds === 1) {
      r.rounds = 2;
      for (const x of r.slots) if (x.state === SlotState.BATTLE) { x.killsOnLife = 0; x.lastKillState = 0; x.repeatLastState = false; }
      const dinos = getDinossaurs(r, true, -2);
      const list = r.getAllPlayers(SlotState.BATTLE, 0);
      r.sendToPlayers(rp.roundEndAck(r, 2, 1), list);
      r.sendToPlayers(rp.roundPreStartAck(r, dinos), list);
      r.roundTimer = setTimeout(() => {}, 5250); // C#: empty callback, the timer never stops (quirk kept)
    } else endBattle(r, bot, getWinnerTeam(r));
  } else if (r.thisModeHaveRounds()) {
    let w: number = Team.CT;
    if (r.roomType === RoomCondition.Destroy) w = r.bar1 > r.bar2 ? Team.FR : r.bar1 < r.bar2 ? Team.CT : Team.DRAW;
    if (w === Team.FR) r.frRounds++; else if (w === Team.CT) r.ctRounds++;
    battleEndRound(r, w, 1);
  } else if (r.roomType === RoomCondition.Ace) {
    if (r.slots[0].state !== SlotState.BATTLE || r.slots[1].state !== SlotState.BATTLE) endBattle(r, bot, Team.DRAW, true);
  } else finishMatch(r, bot, getWinnerTeam(r), true);
}

/** round modes whose round ends when a side is wiped (checkBombWipe): Bomb Mission and Annihilation (no C4 there) */
const WIPE_MODES: number[] = [RoomCondition.Bomb, RoomCondition.Annihilation];
const isWipeMode = (roomType: number): boolean => WIPE_MODES.includes(roomType) || roomType === RoomCondition.Ace;

/** the round end of the death / leave paths, by mode */
function checkRoundWipe(r: RoomModel): void {
  if (WIPE_MODES.includes(r.roomType)) checkBombWipe(r);
  else if (r.roomType === RoomCondition.Ace) checkAceRound(r);
}

/**
 * Bomb Mission wipe (RoomDeath.EndBattleByDeath / AllUtils.BattleEndRoundPlayersCount, simplified): the defenders all dead = the attackers
 * win; the attackers all dead = the defenders win, unless the C4 is planted (then the defusers still have the fuse to play).
 * Annihilation (no C4) uses the same check: the side with no one left in the round loses it.
 */
function checkBombWipe(r: RoomModel): void {
  if (r.roundEnding || r.roundTimer) return;
  const alive = [0, 0];
  // a GM observer (seat 16 / 17) is on no team: it never spawns or dies, so counting it kept its seat's side (16 = FR) alive for good
  for (const s of r.slots) if (s.state === SlotState.BATTLE && s.playerId > 0n && !s.spectator && !s.specGM && !(s.deathState & DeadEnum.Dead)) alive[s.team]++;
  const att = r.isTeamSwap() && r.swapRound ? Team.CT : Team.FR, def = att === Team.FR ? Team.CT : Team.FR;
  let w: number;
  if (alive[def] === 0) w = att;
  else if (alive[att] === 0 && !r.activeC4) w = def;
  else return;
  r.roundEnding = true;
  if (w === Team.FR) r.frRounds++; else r.ctRounds++;
  battleEndRound(r, w, 4); // RoundEndType.AllDeath
}

/**
 * Ace (RoomDeath 290-313, HandleAceModeEnd): slots 0 and 1 are the two fighters. Slot 0 out (dead, or left) = CT takes the round,
 * slot 1 out = FR takes it. Both out = the room ends with no points (EndBattleNoPoints).
 */
function checkAceRound(r: RoomModel): void {
  if (r.roundEnding || r.roundTimer) return;
  const out = (s: SlotModel) => s.state !== SlotState.BATTLE || (s.deathState & DeadEnum.Dead) !== 0;
  const a = out(r.slots[0]), b = out(r.slots[1]);
  if (!a && !b) return;
  if (a && b) { endBattle(r, r.isBotMode(), Team.DRAW, true); return; }
  r.roundEnding = true;
  const w = a ? Team.CT : Team.FR;
  if (w === Team.FR) r.frRounds++; else r.ctRounds++;
  battleEndRound(r, w, 4); // RoundEndType.AllDeath: the fighter is out
}

/** C4 fuse (RoomModel.StartBomb): 42 s after the plant, the planting side (FR, CT after swap) wins the round. */
const BOMB_FUSE_MS = 42000;
function bombFire(r: RoomModel): void {
  r.bombTimer = null;
  if (!r.activeC4 || r.roundEnding) return;
  r.roundEnding = true;
  const w = r.isTeamSwap() && r.swapRound ? Team.CT : Team.FR;
  if (w === Team.CT) r.ctRounds++; else r.frRounds++;
  r.activeC4 = false;
  battleEndRound(r, w, 2); // RoundEndType.BombFire
}
function startBomb(r: RoomModel, site: number, pos: [number, number, number], slot: number): void {
  r.bombEndAt = Date.now() + BOMB_FUSE_MS;
  r.bombSite = site; r.bombPos = pos; r.bombSlot = slot;
  r.bombTimer = setTimeout(() => bombFire(r), BOMB_FUSE_MS);
  // fuse resync (web extension, NOT in the original protocol): the planted ACK again every second with the time left in tenths of a second
  // (0x8000 | tenths in the H field). Clients keep their fuse on the server clock and a player who loads in later still gets the bomb.
  r.bombSyncTimer = setInterval(() => {
    if (!r.activeC4) return;
    const left = Math.max(0, r.bombEndAt - Date.now());
    r.sendToPlayers(rp.bombInstallAck(r.bombSlot, r.bombSite, 0x8000 | Math.min(0x7fff, Math.round(left / 100)), r.bombPos[0], r.bombPos[1], r.bombPos[2]), r.getAllPlayers(SlotState.BATTLE, 0));
  }, 1000);
}

/**
 * 5199 (web-only, F2 test menu; NOT in the original protocol): C action. 1 = explode the planted C4 now, 2 = end the round for the defenders.
 * Everything goes through the server so every client sees it. Only with PB_DEV_OPS=1: otherwise ignored and logged.
 */
export function handleDevBomb(c: GameClient, rd: PacketReader): void {
  const action = rd.readC();
  const p = c.player, r = roomOf(p);
  if (!p || !r) return;
  if (!battleGuard.devOps) { const s = r.getSlot(p.slotId); if (s) guardLog(r, s, `5199 dev op ${action} (PB_DEV_OPS off)`); return; }
  if (r.roundTimer || r.state !== RoomState.BATTLE || r.roomType !== RoomCondition.Bomb || r.roundEnding) return;
  if (action === 1) {
    if (!r.activeC4) return;
    if (r.bombTimer) clearTimeout(r.bombTimer);
    bombFire(r);
  } else if (action === 2) {
    r.roundEnding = true;
    const w = r.isTeamSwap() && r.swapRound ? Team.FR : Team.CT;
    if (w === Team.CT) r.ctRounds++; else r.frRounds++;
    battleEndRound(r, w, 1); // RoundEndType.TimeOut
  }
}

/**
 * An AI seat (web front: the bots of an AI room live in the P2P match host, the leader's tab, and the server knows no AI slot): the room
 * leader may plant / defuse in the name of a seat nobody sits in, so a bot's C4 goes through the same 5156 / 5158 -> 5157 / 5159 path
 * (fuse clock, round end, ACK to everyone) as a human's. Only in an AI room, only the leader, never a seat a player holds.
 */
export function isBotSeat(r: RoomModel, p: { slotId: number }, s: { playerId: bigint; state: number } | null): boolean {
  return r.isBotMode() && p.slotId === r.leader && (!s || (s.playerId === 0n && s.state !== SlotState.BATTLE));
}

/** 5156 BATTLE_MISSION_BOMB_INSTALL_REQ: D slot, C zone, D flag, 3T pos. */
export function handleBombInstall(c: GameClient, rd: PacketReader): void {
  const slotId = rd.readD(), zone = rd.readC(), flag = rd.readD(), x = rd.readT(), y = rd.readT(), z = rd.readT();
  const p = c.player, r = roomOf(p);
  if (!p || !r || r.roundTimer || r.state !== RoomState.BATTLE || r.activeC4) return;
  const s = r.getSlot(slotId);
  const bot = isBotSeat(r, p, s);
  if (!bot && (!s || s.state !== SlotState.BATTLE)) return;
  r.sendToPlayers(rp.bombInstallAck(slotId, zone, flag === 0 ? 42 : 0, x, y, z), r.getAllPlayers(SlotState.BATTLE, 0));
  r.activeC4 = true;
  if (r.roomType === RoomCondition.Tutorial) return;
  if (s && !bot) { s.objects++; r.actors.add(s.playerId); pg.completeMission(r, s, pg.MT.C4_PLANT, 0); }
  startBomb(r, zone, [x, y, z], slotId);
}

/** 5158 BATTLE_MISSION_BOMB_UNINSTALL_REQ: D slot. Defuse ends the round for CT (FR after swap). */
export function handleBombUninstall(c: GameClient, rd: PacketReader): void {
  const slotId = rd.readD();
  const p = c.player, r = roomOf(p);
  if (!p || !r || r.roundTimer || r.state !== RoomState.BATTLE || !r.activeC4) return;
  const s = r.getSlot(slotId);
  const bot = isBotSeat(r, p, s);
  if (!bot && (!s || s.state !== SlotState.BATTLE)) return;
  r.sendToPlayers(rp.bombUninstallAck(slotId), r.getAllPlayers(SlotState.BATTLE, 0));
  if (r.roomType === RoomCondition.Tutorial) { r.stopBomb(); return; }
  if (s && !bot) { s.objects++; r.actors.add(s.playerId); pg.completeMission(r, s, pg.MT.C4_DEFUSE, 0); }
  if (r.swapRound) r.frRounds++; else r.ctRounds++;
  battleEndRound(r, r.swapRound ? Team.FR : Team.CT, 3); // RoundEndType.Uninstall
}

/** 5166 BATTLE_MISSION_GENERATOR_INFO_REQ: H bar1, H bar2, 18 x H damage (cumulative per slot this round). Server.Game
 * PROTOCOL_BATTLE_MISSION_GENERATOR_INFO_REQ.Run: bars set, slot DamageBar1 (EarnedEXP = /600), 5167 to the battle; bar1 0 → CT,
 * bar2 0 → FR, no swap flip (RoomSabotageSync flips it; this path does not). Destroy only [desvio: C# has no room-type check]. */
export function handleGeneratorInfo(c: GameClient, rd: PacketReader): void {
  const bar1 = rd.readH(), bar2 = rd.readH();
  const dmg = Array.from({ length: 18 }, () => rd.readH());
  const p = c.player, r = roomOf(p);
  if (!p || !r || r.roundTimer || r.state !== RoomState.BATTLE || (r.roomType !== RoomCondition.Destroy && r.roomType !== RoomCondition.Defense)) return;
  const s = r.getSlot(p.slotId);
  if (!s || s.state !== SlotState.BATTLE) return;
  r.bar1 = bar1; r.bar2 = bar2;
  for (const x of r.slots) if (x.playerId > 0n && x.state === SlotState.BATTLE) { x.damageBar1 = dmg[x.id]; x.earnedEXP = Math.trunc(x.damageBar1 / 600); }
  r.sendToPlayers(rp.generatorInfoAck(r), r.getAllPlayers(SlotState.BATTLE, 0));
  // Defence: the attackers (FR, CT with the swap) win only when both objectives are down; the defenders keep the round on time
  if (r.roomType === RoomCondition.Defense) { if (bar1 === 0 && bar2 === 0) sabotageEndRound(r, r.swapRound ? Team.CT : Team.FR); return; }
  if (bar1 === 0) sabotageEndRound(r, Team.CT);
  else if (bar2 === 0) sabotageEndRound(r, Team.FR);
}

/** RoomSabotageSync.EndRound: the winner's rounds +1, then AllUtils.BattleEndRound (RoundEndType.Normal = 5). */
function sabotageEndRound(r: RoomModel, w: number): void {
  if (w === Team.FR) r.frRounds++; else r.ctRounds++;
  battleEndRound(r, w, 5);
}

/** RoomModel.SetGameModeSpecificBars (C#): the objectives' life at the round start. Destroy: BreakDown 6000, Hospital 12000.
 * Helispot 12000 [desvio: C# leaves 0 until the first hit; MapStructure life of both helicopters is 12000, matchData.json]. */
const MAP_BREAKDOWN = 17, MAP_HOSPITAL = 44, MAP_HELISPOT = 51, MAP_BLACK_PANTHER = 52;
function setGameModeSpecificBars(r: RoomModel): void {
  // Defence (Black Panther): the two tanks' life from MapStructure (normal_Tank 6000 = bar1, armerd_Tank 9000 = bar2) [INFERIDO start]
  if (r.roomType === RoomCondition.Defense) { if (r.mapId === MAP_BLACK_PANTHER) { r.bar1 = 6000; r.bar2 = 9000; } return; }
  if (r.roomType !== RoomCondition.Destroy) return;
  if (r.mapId === MAP_BREAKDOWN) r.bar1 = r.bar2 = 6000;
  else if (r.mapId === MAP_HOSPITAL || r.mapId === MAP_HELISPOT) r.bar1 = r.bar2 = 12000;
}

/** AllUtils.BattleEndRound(room, winner, motive). */
function battleEndRound(r: RoomModel, w: number, motive: number): void {
  r.stopBomb();
  r.sendToPlayers(rp.roundEndAck(r, w, motive), r.getAllPlayers(SlotState.BATTLE, 0));
  const lim = ROUNDS[r.killTime & 15];
  if (r.frRounds < lim && r.ctRounds < lim) { r.rounds++; roundRestart(r); }
  else endBattle(r, r.isBotMode(), w);
}

function roundRestart(r: RoomModel): void {
  r.roundEnding = false; r.stopBomb();
  for (const s of r.slots) if (s.state === SlotState.BATTLE && s.playerId > 0n) {
    s.deathState |= DeadEnum.UseChat; s.spectator = false;
    if ((r.roomType === RoomCondition.Annihilation || r.roomType === RoomCondition.Ace) && s.killsOnLife >= 3) s.objects++;
    s.killsOnLife = 0; s.lastKillState = 0; s.repeatLastState = false;
    s.damageBar1 = 0; s.damageBar2 = 0;
  }
  r.roundTimer = setTimeout(() => {
    r.roundTimer = null;
    // [desvio: C# keeps Bar1/Bar2 from the last round; the host resets its bars at each round start, so the server mirrors that]
    setGameModeSpecificBars(r);
    for (const s of r.slots) if (s.playerId > 0n) { s.deathState |= DeadEnum.UseChat; s.spectator = false; }
    if (r.state === RoomState.BATTLE) r.battleStart = r.isDinoMode() ? Date.now() + 5000 : Date.now();
    const list = r.getAllPlayers(SlotState.BATTLE, 0);
    r.sendToPlayers(rp.roundPreStartAck(r, getDinossaurs(r, false, -1)), list);
    if (r.isTeamSwap() && !r.swapRound && r.frRounds + r.ctRounds === SWAP_ROUNDS[r.killTime & 15]) {
      r.swapRound = true;
      setTimeout(() => r.sendToPlayers(rp.roundStartAck(r), r.getAllPlayers(SlotState.BATTLE, 0)), 5250);
    } else r.sendToPlayers(rp.roundStartAck(r), list);
  }, 8000);
}

export function handleGiveUpBattle(c: GameClient): void {
  const p = c.player, r = roomOf(p);
  if (!p || !r || r.state < RoomState.LOADING) return;
  const s = r.getSlot(p.slotId);
  if (!s || s.state < SlotState.LOAD) return;
  for (const hook of slotLeftHooks) hook(r, s.id);
  const bot = r.isBotMode();
  // The C# handler counts the quitter too, so its own team is never empty and LeaveEndBattlePVP (winner = the team left
  // with 0) could never run: in a 1v1 the one who stayed was stuck in a battle with nobody (issue #4). Counted without it.
  let n1 = 0, n2 = 0, tFR = 0, tCT = 0;
  for (const x of r.slots) {
    if (x.state < SlotState.LOAD || x.id === s.id || x.specGM) continue; // a GM observer keeps no team alive
    if (x.team === Team.FR) n1++; else n2++;
    if (x.state === SlotState.BATTLE) { if (x.team === Team.FR) tFR++; else tCT++; }
  }
  const ok = (r.state !== RoomState.BATTLE || (tFR > 0 && tCT > 0)) && (r.state > RoomState.PRE_BATTLE || (n1 > 0 && n2 > 0));
  let fin = false;
  const others = () => r.getAllPlayers(SlotState.READY, 1);
  if (s.id !== r.leader) {
    if (bot || ok) r.sendAboutSlot(s.id, rp.giveUpBattleAck(p, 0), others()); // a hidden GM observer leaves unseen
    else fin = leaveEndBattlePVP(r, p, tFR, tCT);
  } else if (!bot) {
    if (ok) {
      r.setNewLeader(-1, r.state === RoomState.BATTLE ? SlotState.BATTLE_READY : SlotState.READY, r.leader, true);
      for (const a of others()) { if (r.slots[a.slotId].state >= SlotState.PRESTART) send(a, rp.leaveP2PAck(r.leader)); send(a, rp.giveUpBattleAck(p, 0)); }
    } else fin = leaveEndBattlePVP(r, p, tFR, tCT);
  } else {
    r.setNewLeader(-1, SlotState.BATTLE_READY, r.leader, true);
    for (const a of others()) { if (r.slots[a.slotId].state >= SlotState.PRESTART) send(a, rp.leaveP2PAck(r.leader)); send(a, rp.giveUpBattleAck(p, 0)); }
  }
  if (s.state >= SlotState.LOAD) r.changeSlotState(s, SlotState.NORMAL, true);
  s.resetSlot();
  c.session.send(rp.giveUpBattleAck(p, 0));
  // [web] nobody left in the battle (AI room whose only human quit, or every player gave up): the C# path only moves
  // the leadership, so the room stayed in BATTLE with no one in it and "Começar" was ignored for good (the ready
  // handler needs READY / COUNTDOWN). Close it like ResetBattleInfo does after a normal end.
  if (!fin && r.isPreparing() && !r.slots.some((x) => x.playerId > 0n && x.state >= SlotState.LOAD)) resetBattleInfo(r);
  // [web] same as removePlayer: with a spectator on the leaver's team the match goes on but the round is over
  else if (!fin && r.state === RoomState.BATTLE) checkRoundWipe(r);
}

function leaveEndBattlePVP(r: RoomModel, p: Account, tFR: number, tCT: number): boolean {
  const w = tFR === 0 ? Team.CT : tCT === 0 ? Team.FR : Team.DRAW;
  if (r.state === RoomState.BATTLE) calculateResult(r, w, false);
  const { slotFlag, missionFlag, data } = battleResult(r);
  for (const a of r.getAllPlayers(SlotState.READY, 1)) {
    send(a, rp.giveUpBattleAck(p, 0));
    send(a, rp.endBattleAck(a, r, w, slotFlag, missionFlag, false, data));
  }
  resetBattleInfo(r);
  return true;
}

/** AllUtils.BattleEndPlayersCount. */
function battleEndPlayersCount(r: RoomModel, bot: boolean): void {
  if (bot || !r.isPreparing()) return;
  let fr = 0, ct = 0, frL = 0, ctL = 0;
  for (const s of r.slots) {
    if (s.specGM) continue;
    if (s.state === SlotState.BATTLE) { if (s.team === Team.FR) fr++; else ct++; }
    else if (s.state >= SlotState.LOAD && s.state < SlotState.BATTLE) { if (s.team === Team.FR) frL++; else ctL++; }
  }
  if (((fr > 0 && ct > 0) || r.state !== RoomState.BATTLE) && ((frL > 0 && ctL > 0) || r.state > RoomState.PRE_BATTLE)) return;
  endBattle(r, bot, getWinnerTeam(r));
}

// ---- end of match ----------------------------------------------------------------------------------------------------

function getWinnerTeam(r: RoomModel): number {
  const cmp = (fr: number, ct: number) => (ct > fr ? Team.CT : fr > ct ? Team.FR : Team.DRAW);
  if ([RoomCondition.Bomb, RoomCondition.Destroy, RoomCondition.Annihilation, RoomCondition.Defense, RoomCondition.Convoy, RoomCondition.Ace].includes(r.roomType as 8)) return cmp(r.frRounds, r.ctRounds);
  if (r.isDinoMode("DE")) return cmp(r.frDino, r.ctDino);
  return cmp(r.frKills, r.ctKills);
}

/** AllUtils.EndBattle(room) (GM :endbattle). */
export function endBattleByCommand(r: RoomModel): void { endBattle(r, r.isBotMode(), getWinnerTeam(r)); }

/** AllUtils.EndBattle / EndBattleNoPoints (noPoints skips CalculateResult). */
function endBattle(r: RoomModel, bot: boolean, w: number, noPoints = false): void {
  finishMatch(r, bot, noPoints ? Team.DRAW : w, false, noPoints);
}

/** 5155 (to BATTLE slots, when roundEnd) + 5140 to every player in the match, then ResetBattleInfo. */
function finishMatch(r: RoomModel, bot: boolean, w: number, roundEnd: boolean, noPoints = false): void {
  const list = r.getAllPlayers(SlotState.READY, 1);
  if (list.length) {
    if (!noPoints) calculateResult(r, w, bot);
    const { slotFlag, missionFlag, data } = battleResult(r);
    const rb = rp.roundEndAck(r, w, 1);
    for (const a of list) {
      const s = r.slots[a.slotId];
      if (!s) continue;
      if (roundEnd && s.state === SlotState.BATTLE) send(a, rb);
      send(a, rp.endBattleAck(a, r, w, slotFlag, missionFlag, bot, data));
    }
  }
  resetBattleInfo(r);
}

/** AllUtils.GetBattleResult: slot flags + the 378-byte reward table. */
function battleResult(r: RoomModel): { slotFlag: number; missionFlag: number; data: Uint8Array } {
  let slotFlag = 0, missionFlag = 0;
  const d = new Uint8Array(378), v = new DataView(d.buffer);
  for (const s of r.slots) {
    if (s.state >= SlotState.LOAD) { slotFlag += s.flag; if (s.missionsCompleted) missionFlag += s.flag; }
    const i = s.id;
    v.setUint16(i * 2, s.exp & 0xffff, true);
    v.setUint16(36 + i * 2, s.gold & 0xffff, true);
    d[72 + i] = s.bonusFlags & 0xff;
    v.setUint16(90 + i * 8, s.bonusCafeExp & 0xffff, true); v.setUint16(92 + i * 8, s.bonusItemExp & 0xffff, true); v.setUint16(94 + i * 8, s.bonusEventExp & 0xffff, true);
    v.setUint16(234 + i * 8, s.bonusCafePoint & 0xffff, true); v.setUint16(236 + i * 8, s.bonusItemPoint & 0xffff, true); v.setUint16(238 + i * 8, s.bonusEventPoint & 0xffff, true);
  }
  return { slotFlag, missionFlag, data: d };
}

/** AllUtils.GetRewardData: MVP (score), AssistKing (assists), MultiKill (kills on life) -> 5140 reward slots/items. */
function getRewardData(r: RoomModel, slots: SlotModel[]): { slots: number[]; items: number[] } {
  const out = { slots: [0xff, 0xff, 0xff, 0xff, 0xff], items: [0, 0, 0, 0, 0] };
  if (r.isBotMode() || !slots.length) return out;
  let n = 0;
  const top = (k: (s: SlotModel) => number) => slots.filter((s) => k(s) > 0).reduce<SlotModel | null>((b, s) => (!b || k(s) > k(b) ? s : b), null);
  for (const [type, s] of [["MVP", top((s) => s.score)], ["AssistKing", top((s) => s.allAssists)], ["MultiKill", top((s) => s.killsOnLife)]] as const) {
    const P = s && n < 5 ? r.svc.getAccount(s.playerId) : null; // ProcessSlotReward: GetPlayerBySlot
    if (!s || !P) continue;
    out.slots[n] = s.id;
    out.items[n++] = generateRandomReward(P, type);
  }
  return out;
}

/** AllUtils.GenerateRandomReward: 2430 popup, then tags (class 29), a character (class 6) or the item (3334). */
function generateRandomReward(P: Account, type: string): number {
  const rw = data.battleRewards.find((b) => b.type === type);
  if (!rw || Math.floor(Math.random() * 100) >= rw.percentage) return 0;
  const good = getGood(rw.rewards[Math.floor(Math.random() * rw.rewards.length)]);
  if (!good) return 0;
  send(P, new PacketWriter(16).writeH(2430).writeH(0).writeH(P.inventory.items.length).writeC(1).writeD(good.item.id).toBytes());
  const cls = Math.trunc(good.item.id / 100000);
  if (cls === 29) {
    const dt = ({ 2900001: 1, 2900002: 2, 2900003: 3, 2900004: 4, 2900005: 5 } as Record<number, number>)[good.item.id] ?? 0;
    P.tags += dt;
    void dao.addMoney(P, 0, 0, dt); // by delta
    return good.item.id;
  }
  const c = P.connection as GameClient | null;
  if (cls === 6 && !P.character.getCharacter(good.item.id)) { if (c) void createCharacterGame(c, P, good.item); }
  else { const m = good.item.clone(); void tryCreateItem(m, P).then(() => send(P, inventoryGetInfoAck(0, P, [m]))); }
  return good.item.id;
}

/** RoomModel.CalculateBattleResults (clan results, competitive and playtime rewards are not ported). */
function calculateResult(r: RoomModel, w: number, bot: boolean): void {
  const processed: SlotModel[] = [];
  let mvpIdx = -1, best = -1;
  for (const s of r.slots) if (s.playerId > 0n && s.allKills > best) { best = s.allKills; mvpIdx = s.id; }
  const scale = rewardScale(r, bot);
  const rankUp = running(rewardData.rankUpEvents), boost = running(rewardData.boostEvents);
  for (const s of r.slots) {
    const P = s.playerId > 0n ? r.svc.getAccount(s.playerId) : null;
    if (s.check || s.state !== SlotState.BATTLE || !P) continue;
    s.check = true;
    const t = s.inBattleTime();
    const gold0 = P.gold, exp0 = P.exp, cash0 = P.cash;
    const kills = s.allKills, deaths = s.allDeaths;
    const bq: [string[], unknown[]] = [[], []], sq: [string[], unknown[]] = [[], []], q: [string[], unknown[]] = [[], []];
    if (!bot) {
      if (config.server.EnableMissions) pg.finishMissions(r, P, s, w, q);
      const n = kills || deaths ? Math.trunc(t) : Math.trunc(t / 3.0);
      const cs = Math.max(s.score * 15, kills * 100 + s.allHeadshots * 50 + s.allAssists * 25);
      let exp: number, gold: number, cash: number;
      if (![RoomCondition.Bomb, RoomCondition.Annihilation, RoomCondition.Ace].includes(r.roomType as 8)) {
        exp = cs + n / 2.5 + deaths * 1.8 + s.objects * 20; gold = cs + n / 3.0 + deaths * 1.8 + s.objects * 20; cash = cs / 1.5 + n / 4.5 + deaths * 1.1 + s.objects * 20;
      } else {
        exp = cs + n / 2.5 + deaths * 2.2 + s.objects * 20; gold = cs + n / 3.0 + deaths * 2.2 + s.objects * 20; cash = Math.trunc(s.score / 2) + n / 6.5 + deaths * 1.5 + s.objects * 10;
      }
      s.exp = exp > INT_MAX ? INT_MAX : exp < 0 ? Math.max(1000, Math.trunc(s.score * 0.2)) : Math.trunc(exp);
      s.gold = gold > INT_MAX ? INT_MAX : gold < 0 ? 2 : Math.trunc(gold);
      s.cash = cash > INT_MAX ? INT_MAX : cash < 0 ? 2 : Math.trunc(cash);
      if (r.rule !== 80 && r.rule !== 32) updatePlayerStatistics(P, s, w, r, mvpIdx, bq, sq);
      if (s.team === w || (r.roomType === RoomCondition.FreeForAll && w === mvpIdx)) { s.gold += pct(s.gold, 15); s.exp += pct(s.exp, 20); }
      if (s.earnedEXP > 0) s.exp += s.earnedEXP * 5;
    } else {
      const d = r.ingameAiLevel * (150 + deaths) || 1;
      const v = Math.trunc(s.score / d);
      s.gold += v; s.exp += v;
    }
    s.exp = Math.min(s.exp, config.maxExpReward); s.gold = Math.min(s.gold, config.maxGoldReward); s.cash = Math.min(s.cash, config.maxCashReward);
    if (r.roomType !== RoomCondition.Ace) { if (s.exp < 0) s.exp = Math.max(1000, Math.trunc(s.score * 0.2)); if (s.gold < 0) s.gold = 2; if (s.cash < 0) s.cash = 2; }
    else if (P.slotId < 0 || P.slotId > 1) { s.exp = 0; s.gold = 0; s.cash = 0; }
    // humans / length scale, under the Max*Reward caps (Settings.ini [Internal], server/runtime/Config/Settings.ini: 15000) and
    // before the event / PC cafe / item bonus percentages, which read the scaled value
    s.exp = Math.trunc(s.exp * scale); s.gold = Math.trunc(s.gold * scale); s.cash = Math.trunc(s.cash * scale);
    if (rankUp || boost?.boostType === "Mode") {
      let e7 = 0, e8 = 0;
      const b = rankUp?.bonuses.get(P.rank);
      if (b) { e7 += pct(b[0], b[2]); e8 += pct(b[1], b[2]); }
      if (boost?.boostType === "Mode") { e7 += pct(boost.bonusExp, boost.percent); e8 += pct(boost.bonusGold, boost.percent); }
      s.bonusFlags |= 8; s.bonusEventExp += e7; s.bonusEventPoint += e8;
    }
    const bn = P.bonus.bonuses;
    if (bn > 0) {
      let ie = 0, ip = 0, ib = 0;
      if (bn & 8) ie += 100; if (bn & 4) ie += 50; if (bn & 2) ie += 30; if (bn & 1) ie += 10;
      if (bn & 128) ip += 100; if (bn & 64) ip += 50; if (bn & 32) ip += 30; if (bn & 16) ip += 10;
      if (bn & 512) ib += 20; if (bn & 1024) ib += 30; if (bn & 2048) ib += 50; if (bn & 4096) ib += 100;
      s.bonusFlags |= 4; s.bonusItemExp += ie; s.bonusItemPoint += ip; s.bonusBattlePass += ib;
    }
    const pc = getPCCafe(P.cafePC);
    if (pc) { s.bonusCafeExp += pc.expUp; s.bonusCafePoint += pc.pointUp; s.bonusFlags |= P.cafePC === 1 ? 1 : 2; }
    if (bot) for (const k of ["bonusCafeExp", "bonusItemExp", "bonusEventExp", "bonusCafePoint", "bonusItemPoint", "bonusEventPoint"] as const) s[k] = Math.min(s[k], 300);
    const pe = s.bonusEventExp + s.bonusCafeExp + s.bonusItemExp, pp = s.bonusEventPoint + s.bonusCafePoint + s.bonusItemPoint;
    P.exp += s.exp + pct(s.exp, pe);
    P.gold += s.gold + pct(s.gold, pp);
    const seasonJob = pg.calculateSeasonExpPoints(P, s); // bonus/season points land on the slot synchronously (5140 reads them)
    if (config.winCashPerBattle) P.cash += s.cash;
    const rank = rewardData.ranks.get(P.rank);
    if (rank && P.exp >= rank.onNextLevel + rank.onAllExp && P.rank <= 50) {
      void pg.grantRankRewards(P, P.rank);
      P.gold += rank.onGoldUp; P.lastRankUpDate = nowNum("yyMMddHHmm");
      const prev = P.rank;
      P.rank++;
      send(P, new Uint8Array([2343 & 0xff, 2343 >> 8, ...u32(P.rank), ...u32(prev), ...u32(rank.onGoldUp), 0, 0, 0, 0, 0, 0]));
      q[0].push("last_rank_update", "rank"); q[1].push(P.lastRankUpDate, P.rank);
    }
    // PlayTimeEvent (Events/Play.json goods) and CalculateCompetitive are not ported (no competitive rooms on TS)
    if (data.activeSeason && data.activeSeason.seasonEnabled !== 0) void seasonJob.then(() => pg.updateSeasonPass(P));
    pg.discountBattleItems(s, P);
    if (exp0 !== P.exp) { q[0].push("experience"); q[1].push(P.exp); }
    void dao.updateDB("accounts", "player_id", P.playerId, q[0], q[1]);
    void dao.addMoney(P, P.gold - gold0, P.cash - cash0); // reward (incl. rank-up and mission gold) as an increment, never the absolute balance
    void dao.updateDB("player_stat_basics", "owner_id", P.playerId, bq[0], bq[1]);
    void dao.updateDB("player_stat_seasons", "owner_id", P.playerId, sq[0], sq[1]);
    if (config.winCashPerBattle && config.showCashReceiveWarn) {
      const msg = getLabel("CashReceived", s.cash);
      send(P, new Uint8Array([...le16(3079), 0, 0, 0, 0, 0, 0, ...le16(msg.length), ...[...msg].flatMap((ch) => le16(ch.charCodeAt(0))), 2, 0, 0, 0]));
    }
    processed.push(s);
  }
  if (processed.length) r.slotRewards = getRewardData(r, processed);
  if (processed.length && !bot) {
    const top = [...processed].sort((a, b) => b.score - a.score)[0];
    const P = top && top.score > 0 ? r.svc.getAccount(top.playerId) : null;
    if (P) {
      for (const [k, t] of [["basic", "player_stat_basics"], ["season", "player_stat_seasons"]] as const) {
        const st = P.statistic[k];
        if (st) { st.mvpCount++; void dao.update1(t, "mvp_count", st.mvpCount, "owner_id", P.playerId); }
      }
    }
  }
  applyClanMatchResult(r, w); // C# UpdateClanInformation (clan rooms only, not blocked)
  r.updateSlotsInfo();
}

function updatePlayerStatistics(P: Account, s: SlotModel, w: number, r: RoomModel, mvpIdx: number, bq: [string[], unknown[]], sq: [string[], unknown[]]): void {
  const k = s.allKills, d = s.allDeaths, hs = s.allHeadshots, as = s.allAssists;
  for (const [st, q] of [[P.statistic.basic, bq], [P.statistic.season, sq]] as const) {
    if (!st) continue;
    st.headshotsCount += hs; st.killsCount += k; st.totalKillsCount += k; st.deathsCount += d; st.assistsCount += as;
    if (k > 0) { q[0].push("kills_count", "total_kills"); q[1].push(st.killsCount, st.totalKillsCount); }
    if (as > 0) { q[0].push("assists_count"); q[1].push(st.assistsCount); }
    if (d > 0) { q[0].push("deaths_count"); q[1].push(st.deathsCount); }
    if (hs > 0) { q[0].push("headshots_count"); q[1].push(st.headshotsCount); }
    if (r.roomType !== RoomCondition.FreeForAll) {
      if (w === Team.DRAW) { q[0].push("match_draws"); q[1].push(++st.matchDraws); }
      else if (s.team === w) { q[0].push("match_wins"); q[1].push(++st.matchWins); }
      else { q[0].push("match_loses"); q[1].push(++st.matchLoses); }
    } else if (s.allKills !== mvpIdx) { q[0].push("match_loses"); q[1].push(++st.matchLoses); }
    else { q[0].push("match_wins"); q[1].push(++st.matchWins); }
    q[0].push("matches", "total_matches"); q[1].push(++st.matches, ++st.totalMatchesCount);
  }
}

const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];

/** AllUtils.ResetBattleInfo. */
function resetBattleInfo(r: RoomModel): void {
  for (const s of r.slots) {
    if (s.playerId > 0n && s.state >= SlotState.LOAD) { s.state = SlotState.NORMAL; s.resetSlot(); }
    if (!r.isBotMode() && s.state !== SlotState.EMPTY && s.state !== SlotState.CLOSE && s.playerId === 0n) s.state = SlotState.EMPTY;
  }
  r.preMatchCD = false; r.blockedClan = false; r.swapRound = false; r.rounds = 1; r.spawnsCount = 0;
  releaseClanMatch(r);
  r.frKills = r.frDeaths = r.frAssists = r.ctKills = r.ctDeaths = r.ctAssists = 0;
  r.frRounds = r.ctRounds = r.frDino = r.ctDino = 0;
  r.battleStart = 0; r.timeRoom = 0; r.bar1 = r.bar2 = 0; r.ingameAiLevel = 0; r.matchStart = 0; r.actors.clear();
  for (const hook of battleEndHooks) hook(r); // chat ring, votes and report dedupe live in memory only: gone with the match
  r.state = RoomState.READY;
  r.updateRoomInfo();
  r.udpServer = null;
  if (r.roundTimer) clearTimeout(r.roundTimer);
  r.roundTimer = null;
  r.updateSlotsInfo();
  for (const a of r.getAllPlayers()) a.refreshLobbyInfo = true;
}

export function ensureChangeSlotUnused(): void { void getMapLimit; }

// ---- slot management (leader) -----------------------------------------------------------------------------------------

/**
 * PROTOCOL_ROOM_CHANGE_ROOMINFO_REQ (3640): the leader edits the room from the ready room (name, map, mode =
 * rule/stage/roomType, weapon limit, kills/time, slots, AI count/level). Port of the C# Run(): applies everything,
 * resets READY players when the mode/weapons/slots changed, then 3601 (UpdateRoomInfo) + 3637 to the room.
 * Guarded to a READY room [INFERIDO: the C# has no state check, but changing the map mid-battle would desync].
 */
export function readChangeRoomInfo(rd: PacketReader) {
  rd.readD();
  const name = rd.readU(46), mapId = rd.readC(), rule = rd.readC(), stage = rd.readC(), roomType = rd.readC(), reqState = rd.readC();
  const countPlayers = rd.readC(), slotCount = rd.readC(), ping = rd.readC(), weaponsFlag = rd.readH(), stageFlag = rd.readD();
  rd.readH(); const newInt = rd.readD(); rd.readH(); const leaderName = rd.readU(66);
  const killTime = rd.readD(), limit = rd.readC(), watchRuleFlag = rd.readC(), balance = rd.readH();
  const randomMaps = rd.readB(24), countdownIG = rd.readC(), leaderAddr = rd.readB(4), killCam = rd.readC(); rd.readH();
  const aiCount = rd.readC(), aiLevel = rd.readC();
  // web extension (the C# request ends here): C apply + S(4) password, so the leader can set / clear it from the settings window
  const setPassword = rd.remaining >= 5 && rd.readC() === 1, password = setPassword ? rd.readS(4) : "";
  return { name, mapId, rule, stage, roomType, reqState, countPlayers, slotCount, ping, weaponsFlag, stageFlag, newInt, leaderName, killTime, limit, watchRuleFlag, balance, randomMaps, countdownIG, leaderAddr, killCam, aiCount, aiLevel, setPassword, password };
}

export function handleChangeRoomInfo(c: GameClient, rd: PacketReader): void {
  const { name, mapId, rule, stage, roomType, reqState, countPlayers, slotCount, ping, weaponsFlag, stageFlag, newInt, leaderName, killTime, limit,
    watchRuleFlag, balance, randomMaps, countdownIG, leaderAddr, killCam, aiCount, aiLevel, setPassword, password } = readChangeRoomInfo(rd);
  const p = c.player, r = roomOf(p);
  if (!p || !r || r.leader !== p.slotId || r.state !== RoomState.READY) return;
  const renamed = r.name !== name;
  const remoded = r.rule !== rule || r.stage !== stage || r.roomType !== roomType;
  r.name = name; r.mapId = mapId; r.rule = rule; r.stage = stage; r.roomType = roomType;
  r.ping = ping; r.flag = stageFlag; r.newInt = newInt; r.killTime = killTime; r.limit = limit;
  r.watchRuleFlag = roomType === RoomCondition.Ace ? 142 : watchRuleFlag;
  r.balanceType = balance; r.randomMaps = randomMaps; r.countdownIG = countdownIG; r.leaderAddr = leaderAddr; r.killCam = killCam;
  r.aiCount = aiCount; r.aiLevel = aiLevel;
  // PASSWORD (4) in the echoed flag is the old state: the password itself decides (GetFlag adds the bit back while it is set)
  if (setPassword) { r.password = password; r.flag &= ~StageFlag.PASSWORD; }
  r.setSlotCount(slotCount, false, true);
  r.countPlayers = countPlayers;
  if (reqState < RoomState.READY || !leaderName || leaderName !== p.nickname || renamed || remoded || weaponsFlag !== r.weaponsFlag || slotCount !== r.countMaxSlots) {
    r.state = reqState < RoomState.READY ? RoomState.READY : reqState;
    r.leaderName = !leaderName || leaderName !== p.nickname ? p.nickname : leaderName;
    r.weaponsFlag = weaponsFlag;
    r.countMaxSlots = slotCount;
    r.countdownIG = 0;
    let reset = 0;
    for (const s of r.slots) if (s.state === SlotState.READY) { s.state = SlotState.NORMAL; reset++; }
    if (reset) r.updateSlotsInfo();
  }
  r.updateRoomInfo();
  r.sendToPlayers(rp.roomOptionInfoAck(r));
  log(`room #${r.roomId} changed by ${p.nickname}: map ${r.mapId} rule ${r.rule} stage ${r.stage} weapons ${r.weaponsFlag} killTime 0x${r.killTime.toString(16)}`);
}

const lastChangeSlot = new Map<bigint, number>();

/** PROTOCOL_ROOM_CHANGE_SLOT_REQ (3604): close/open a slot or kick its player. Always answers 3605. */
export function handleChangeSlot(c: GameClient, rd: PacketReader): void {
  const req = rd.readD();
  const p = c.player, r = roomOf(p);
  const id = req & 0x0fffffff;
  if (!p || !r || r.leader !== p.slotId || r.changingSlots || id < 0 || id >= 18) return c.session.send(rp.changeSlotAck(0x80000401));
  const now = Date.now();
  if (now - (lastChangeSlot.get(p.playerId) ?? 0) < 500) return;
  lastChangeSlot.set(p.playerId, now);
  const s = r.slots[id];
  // a hidden GM observer is an EMPTY seat for a normal leader: no kick, no close (answered as done, so the seat gives nothing away)
  if (s.stealth && !p.isGM()) return c.session.send(rp.changeSlotAck(0));
  let err = 0;
  if (s.state === SlotState.EMPTY) r.changeSlotState(s, SlotState.CLOSE, true);
  else if (s.state === SlotState.CLOSE) {
    const ml = getMapLimit(r.mapId, r.rule);
    if (ml && (req & 0x10000000) !== 0 && s.id < ml.limit && (!r.isBotMode() || r.leader % 2 === s.id % 2)) r.changeSlotState(s, SlotState.EMPTY, true);
  } else if (s.state >= 2 && s.state <= 10) {
    const t = r.svc.getAccount(s.playerId);
    const clan = r.channelType === 4;
    if (t && !t.antiKickGM && ((s.state !== SlotState.READY && (!clan || r.state !== RoomState.COUNTDOWN)) || (s.state === SlotState.READY && (!clan || r.state === RoomState.READY)))) {
      send(t, new Uint8Array([3075 & 0xff, 3075 >> 8, 0]));
      r.kickedPlayersHost.set(t.playerId, now); // the kicked player's id (C# keyed the host's, so the rejoin wait never applied)
      removePlayer(r, t, false);
    }
  } else err = 0x80000401;
  c.session.send(rp.changeSlotAck(err));
}

/** PROTOCOL_ROOM_TOTAL_TEAM_CHANGE_REQ (3619). */
export function handleTotalTeamChange(c: GameClient): void {
  const p = c.player, r = roomOf(p);
  if (!p || !r || r.leader !== p.slotId || r.state !== RoomState.READY || (Date.now() - r.lastChangeTeam) / 1000 < 1.5 || r.changingSlots) return;
  r.changingSlots = true;
  const list: rp.SlotChange[] = [];
  try {
    for (let o = 0; o < 16; o += 2) {
      const n = o + 1;
      if (o === r.leader) r.leader = n; else if (n === r.leader) r.leader = o;
      const a = r.slots[n], b = r.slots[o];
      for (const x of [a, b]) if (x.state === SlotState.READY) x.state = SlotState.NORMAL;
      r.slots[n] = Object.assign(b, { id: n, team: n % 2 });
      r.slots[o] = Object.assign(a, { id: o, team: o % 2 });
      list.push({ oldId: r.slots[o].id, newId: r.slots[n].id, oldState: r.slots[o].clientState(), newState: r.slots[n].clientState() });
    }
    const pkt = rp.teamBalanceAck(list, r.leader, 2);
    for (const a of r.getAllPlayers()) { a.slotId = a.slotId % 2 ? a.slotId - 1 : a.slotId + 1; send(a, pkt); }
    r.lastChangeTeam = Date.now();
  } finally { r.changingSlots = false; }
}

/** PROTOCOL_ROOM_REQUEST_MAIN_CHANGE_WHO_REQ (3615): the leader hands over to a slot. */
export function handleChangeLeader(c: GameClient, rd: PacketReader): void {
  const slot = rd.readD();
  const p = c.player, r = roomOf(p);
  if (!p || !r || r.state !== RoomState.READY || r.leader !== p.slotId || !r.getSlot(slot) || r.slots[slot].playerId === 0n || (r.slots[slot].stealth && !p.isGM())) {
    return c.session.send(rp.errAck(3616, 0x80000000));
  }
  r.setNewLeader(slot, SlotState.EMPTY, r.leader, false);
  r.sendToPlayers(rp.errAck(3616, slot));
  r.updateSlotsInfo();
}

/**
 * PROTOCOL_ROOM_REQUEST_MAIN_REQ (3611): a player asks for the leadership. Majority (allPlayers / 2 + 1) of the room's votes takes it;
 * a GM takes it at once and in any room state. Each vote is announced with 3612 {slot}; the change with 3616 {slot} + SLOTINFO.
 * [web] a GM taking over a room in battle also moves the P2P host (voteLeader.handoffLeader), the C# has no P2P.
 */
export function handleRequestMain(c: GameClient): void {
  const p = c.player, r = roomOf(p);
  if (!p) return;
  if (!r) return c.session.send(rp.errAck(3612, 0x80000000));
  const gm = p.isGM();
  if ((r.state !== RoomState.READY && !gm) || r.leader === p.slotId || !r.getSlot(p.slotId)) return;
  const all = r.getAllPlayers();
  if (all.length === 0) return;
  const take = () => {
    if (r.state >= RoomState.LOADING) { handoffLeader(r, p.slotId); r.requestRoomMaster = []; return; }
    r.setNewLeader(p.slotId, SlotState.EMPTY, -1, false);
    r.sendToPlayers(rp.errAck(3616, p.slotId), all);
    r.updateSlotsInfo();
    r.requestRoomMaster = [];
  };
  if (gm) return take();
  const need = Math.trunc(all.length / 2) + 1;
  if (!r.requestRoomMaster.includes(p.playerId)) {
    r.requestRoomMaster.push(p.playerId);
    if (r.requestRoomMaster.length < need) r.sendToPlayers(rp.errAck(3612, p.slotId), all);
  }
  if (r.requestRoomMaster.length >= need) take();
}
