// Server.Game room/battle ServerPacket Write() ports (3593 3601 3586 3588 3595 3622 3659 3667 5124 5126 5127 5128
// 5130 5132 5134 5136 5138 5140 5147 5151 5153 5155 5163 3076 3605 5149).
import { PacketWriter } from "../../../src/net/packet.ts";
import type { Account } from "../shared/account.ts";
import { newStat, type Stat } from "../shared/models.ts";
import { equipmentDataChara } from "../auth/metaPackets.ts";
import { config } from "../config.ts";
import { RoomModel, SlotModel, SlotState, RoomCondition, SWAP_ROUNDS, Team } from "./roomModel.ts";

const W = (n = 128) => new PacketWriter(n);
const oid32 = (v: bigint) => Number(BigInt.asUintN(32, v));

/** BaseServerPacket.WriteU (exact size, throws when too long). */
function U(w: PacketWriter, s: string, n: number): PacketWriter {
  if (s.length * 2 > n) throw new Error(`WriteU overflow ${s}`);
  return w.writeU(s, n);
}

/** GameServerPacket RoomInfoBlock (246 bytes): basic (70) + option (176). */
export function roomInfoBlock(r: RoomModel): Uint8Array {
  const w = W(256).writeD(r.roomId);
  U(w, r.name, 46);
  w.writeC(r.mapId).writeC(r.rule).writeC(r.stage).writeC(r.roomType).writeC(r.state).writeC(r.getVisiblePlayers()).writeC(r.getSlotCount())
    .writeC(r.ping).writeH(r.weaponsFlag).writeD(r.getFlag()).writeH(0).writeD(r.newInt);
  w.writeH(0);
  U(w, r.leaderName, 66);
  w.writeD(r.killTime).writeC(r.limit).writeC(r.watchRuleFlag).writeH(r.balanceType).writeB(r.randomMaps).writeC(5).writeB(r.leaderAddr)
    .writeC(r.killCam).writeH(0).zeros(68);
  return w.toBytes();
}

export function createRoomAck(err: number, r: RoomModel | null): Uint8Array {
  const w = W(260).writeH(3593).writeD(err === 0 && r ? r.roomId : err);
  if (err !== 0 || !r) return w.toBytes();
  return w.writeB(roomInfoBlock(r)).toBytes();
}

export function changeRoomInfoAck(r: RoomModel): Uint8Array {
  const w = W(260).writeH(3601).writeB(roomInfoBlock(r));
  if (r.isBotMode()) w.writeC(r.aiCount).writeC(r.aiLevel);
  return w.toBytes();
}

/** PROTOCOL_ROOM_CHANGE_ROOM_OPTIONINFO_ACK (3637): the room's option half after a 3640/3636 change. */
export function roomOptionInfoAck(r: RoomModel): Uint8Array {
  const w = W(200).writeH(3637).writeC(0);
  U(w, r.leaderName, 66);
  w.writeD(r.killTime).writeC(r.limit).writeC(r.watchRuleFlag).writeH(r.balanceType).writeB(r.randomMaps).writeC(5).writeB(r.leaderAddr)
    .writeC(r.killCam).writeH(0).zeros(68);
  return w.toBytes();
}

/** PROTOCOL_LOBBY_GET_ROOMINFOADD_ACK (2568): the lobby's Info panel of the picked room (the Cross client asks on select). */
export function roomInfoAddAck(r: RoomModel): Uint8Array {
  const w = W(200).writeH(2568).writeC(0);
  U(w, r.leaderName, 66);
  w.writeC(r.killTime).writeC(r.rounds - 1).writeH(r.getInBattleTime()).writeC(r.limit).writeC(r.watchRuleFlag).writeH(r.balanceType)
    .writeB(r.randomMaps).writeC(5).writeB(r.leaderAddr).writeC(r.killCam).writeH(0).zeros(68);
  return w.toBytes();
}

/** The per-player fields of the slot records (3586 / 3588). */
function playerSlotFields(w: PacketWriter, a: Account, s: SlotModel, join: boolean): void {
  const c = a.clan;
  w.writeC(a.getRank()).writeD(c.id).writeD(a.clanAccess).writeC(c.rank).writeD(c.logo).writeC(a.cafePC).writeC(0 /* TourneyLevel */)
    .writeQ(a.effects).writeC(c.effect).writeC(join ? 0 : s.viewType).writeC(a.config.nations).writeC(0).writeD(a.equipment.nameCardId)
    .writeC(a.bonus.nickBorderColor).writeC(Math.max(0, a.authLevel())).writeC(0);
  U(w, c.name, 34);
  w.writeC(s.id);
  U(w, a.nickname, 66);
  w.writeC(a.nickColor).writeC(a.bonus.muzzleColor).writeC(0).writeC(0xff).writeC(0xff);
}

export function joinRoomAck(err: number, a: Account | null, r: RoomModel | null): Uint8Array {
  const w = W(3200).writeH(3586).writeH(0).writeD(err);
  if (err !== 0 || !a || !r) return w.toBytes();
  w.writeC(18);
  for (const s of r.slots) w.writeC(s.team);
  w.writeC(18);
  for (const s of r.slots) {
    const p = s.playerId > 0n ? r.svc.getAccount(s.playerId) : null;
    if (p && s.stealth && !a.isGM() && s.id !== a.slotId) { w.writeC(SlotState.EMPTY).zeros(10).writeD(0xffffffff).zeros(55).writeC(s.id).zeros(66).writeC(0).writeC(0).writeC(0).writeC(0xff).writeC(0xff); continue; } // hidden GM observer
    w.writeC(s.clientState());
    if (p) playerSlotFields(w, p, s, true);
    else w.zeros(10).writeD(0xffffffff).zeros(55).writeC(s.id).zeros(66).writeC(0).writeC(0).writeC(0).writeC(0xff).writeC(0xff);
  }
  w.writeC(r.killCam).writeC(0).writeC(0).writeC(r.getSlotCount()).writeC(r.leader).writeC(r.countdownTimeLeft()).writeC(4).zeros(4);
  const blob = new Uint8Array(246 + 1);
  blob.set(roomInfoBlock(r));
  w.writeB(blob.subarray(71, 246)).writeB(blob.subarray(0, 71));
  return w.writeC(a.slotId).toBytes();
}

export function slotOneInfoAck(a: Account, r: RoomModel): Uint8Array {
  const s = r.slots[a.slotId];
  const w = W(160).writeH(3588).writeH(0).writeC(s.team).writeC(s.clientState());
  playerSlotFields(w, a, s, false);
  return w.toBytes();
}

/** PROTOCOL_ROOM_GET_SLOTINFO_ACK (3595); the ctor hands the leader over when GetLeader() is null. */
export function slotInfoAck(r: RoomModel, hideStealth = false): Uint8Array {
  if (r.getLeader() == null) r.setNewLeader(-1, SlotState.EMPTY, r.leader, false);
  const w = W(1400).writeH(3595).writeC(r.leader);
  for (const s of r.slots) {
    const hidden = hideStealth && s.stealth;
    const a = s.playerId > 0n && !hidden ? r.svc.getAccount(s.playerId) : null;
    w.writeH(36).writeC(hidden ? SlotState.EMPTY : s.clientState());
    if (!a) { w.zeros(10).writeD(0xffffffff).zeros(22); continue; }
    const c = a.clan;
    w.writeC(a.getRank()).writeD(c.id).writeD(a.clanAccess).writeC(c.rank).writeD(c.logo).writeC(a.cafePC).writeC(0).writeQ(a.effects)
      .writeC(c.effect).writeC(s.viewType).writeC(a.config.nations).writeC(0).writeD(a.equipment.nameCardId).writeC(a.bonus.nickBorderColor)
      .writeC(a.countryFlags).writeC(0).writeC(c.name.length * 2);
    U(w, c.name, c.name.length * 2);
  }
  for (const s of r.slots) w.writeC(r.validateTeam(s.team, s.team));
  return w.toBytes();
}

export interface SlotChange { oldId: number; newId: number; oldState: number; newState: number }
export function teamBalanceAck(list: SlotChange[], leader: number, type: number): Uint8Array {
  const w = W(16 + list.length * 4).writeH(3622).writeC(type).writeC(leader).writeC(list.length);
  for (const c of list) w.writeC(c.oldId).writeC(c.newId).writeC(c.oldState).writeC(c.newState);
  return w.toBytes();
}

export const errAck = (op: number, err: number) => W(8).writeH(op).writeD(err).toBytes();
export const loadingStartAck = () => errAck(3659, 0);
export const kickBattlePlayerAck = (err: number) => errAck(3076, err);
export const changeSlotAck = (err: number) => errAck(3605, err);
export const readyBattleAck = (err: number) => W(10).writeH(5124).writeH(0).writeC(0).writeD(err).toBytes();
export const countdownAck = (type: number) => W(4).writeH(5126).writeC(type).toBytes();
export const leaveP2PAck = (leader: number) => errAck(5149, leader);
export const pingAck = (b: Uint8Array) => W(24).writeH(5147).writeB(b).toBytes();

export function userEquipmentAck(r: RoomModel, s: SlotModel | null): Uint8Array {
  const w = W(120).writeH(3667).writeH(0);
  const e = s?.equipment;
  if (!s || !e) return w.writeD(0x08000000).toBytes();
  w.writeD(0).writeQ(0n).writeD(0).writeC(10);
  const team = r.validateTeam(s.team, s.team);
  w.writeD(team === Team.FR ? e.charaRedId : e.charaBlueId);
  for (const v of [e.partHead, e.partFace, e.partJacket, e.partPocket, e.partGlove, e.partBelt, e.partHolster, e.partSkin, e.beretItem]) w.writeD(v);
  w.writeC(8);
  for (const v of [e.weaponPrimary, e.weaponSecondary, e.weaponMelee, e.weaponExplosive, e.weaponSpecial, 0, 0, 0]) w.writeD(v);
  return w.writeC(2).writeD(e.charaRedId).writeD(e.charaBlueId).writeC(s.id).toBytes();
}

const WEAPON_DEFAULTS = [103004, 202022, 301012, 407001, 508002];
const safeWeapon = (id: number, c: number) => (id && Math.trunc(id / 100000) % 100 === c ? id : WEAPON_DEFAULTS[c - 1]);
const safePart = (id: number, c: number) => (id && Math.trunc(id / 100000) % 100 === c ? id : 1000000000 + c * 100000);

function startGameEntry(w: PacketWriter, r: RoomModel, s: SlotModel): void {
  const e = s.equipment!;
  const chara = r.validateTeam(s.team, s.team) === Team.FR ? e.charaRedId : e.charaBlueId;
  w.writeD(chara).writeD(safeWeapon(e.weaponPrimary, 1)).writeD(safeWeapon(e.weaponSecondary, 2)).writeD(safeWeapon(e.weaponMelee, 3))
    .writeD(safeWeapon(e.weaponExplosive, 4)).writeD(safeWeapon(e.weaponSpecial, 5)).writeD(0).writeD(0).writeD(0).writeD(chara);
  [e.partHead, e.partFace, e.partJacket, e.partPocket, e.partGlove, e.partBelt, e.partHolster, e.partSkin].forEach((v, i) => w.writeD(safePart(v, 7 + i)));
  w.writeD(0).writeB([100, 100, 100, 100, 100, 100, 100, 100]).zeros(39);
}

/** `forGm`: the receiver is a GM account, the hidden GM observers are in the list (a normal account never gets them) */
export function startGameAck(r: RoomModel, forGm = false): Uint8Array {
  const w = W(2600).writeH(5127).writeH(0).writeC(18);
  for (const s of r.slots) w.writeD(s.allKills);
  w.writeC(18);
  for (const s of r.slots) w.writeC(s.team);
  const ready = r.slots.filter((s) => { if (s.state < SlotState.READY || !s.equipment || (s.stealth && !forGm)) return false; const a = r.svc.getAccount(s.playerId); return !!a && a.slotId === s.id; });
  w.writeC(ready.length);
  for (const s of ready) { w.writeC(s.id); startGameEntry(w, r, s); }
  return w.writeC(r.mapId).writeC(r.rule).writeC(r.stage).writeC(r.roomType).writeC(0).toBytes();
}

export function startGameTransAck(r: RoomModel, s: SlotModel, a: Account): Uint8Array {
  const w = W(140).writeH(5128).writeH(0).writeD(oid32(a.playerId)).writeC(2).writeC(s.id);
  startGameEntry(w, r, s);
  return w.toBytes();
}

const PRESTART_TAIL = [0x02, 0x14, 0x03, 0x15, 0x04, 0x16, 0x05, 0x17, 0x06, 0x18, 0x07, 0x19, 0x08, 0x1a, 0x09, 0x1b, 0x0a, 0x1c, 0x0b, 0x1d, 0x0c, 0x1e, 0x0d, 0x1f, 0x0e, 0x20, 0x0f, 0x21, 0x10, 0x22, 0x11, 0x00, 0x12, 0x01, 0x13];
function ip4(host: string): number[] { const p = host.split(".").map(Number); return p.length === 4 && p.every((x) => x >= 0 && x <= 255) ? p : [127, 0, 0, 1]; }

export function preStartBattleAck(a: Account | null, r: RoomModel | null, self: boolean): Uint8Array {
  const w = W(80).writeH(5130);
  if (!a || !r || !r.isPreparing()) return w.writeD(0).toBytes();
  const host = ip4(config.advertiseHost || "127.0.0.1");
  w.writeD(1).writeD(a.slotId).writeC(r.roomType === RoomCondition.Tutorial ? 1 : config.udpType).writeB(host).writeB(host).writeH(config.matchPort)
    .writeD(r.uniqueRoomId).writeD(r.seed);
  if (self) w.writeB(PRESTART_TAIL);
  return w.toBytes();
}

function dinoBlock(w: PacketWriter, r: RoomModel, dinos: number[], bot: boolean): void {
  if (bot) { w.writeB(new Array(10).fill(0xff)); return; }
  if (!r.isDinoMode()) { w.zeros(10); return; }
  const trex = dinos.length === 1 || r.isDinoMode("CC") ? 255 : r.tRex;
  w.writeC(trex).writeC(10);
  const listed = dinos.filter((i) => (i !== r.tRex && r.isDinoMode("DE")) || r.isDinoMode("CC"));
  for (const i of listed) w.writeC(i);
  const pad = 8 - listed.length - (trex === 255 ? 1 : 0);
  for (let i = 0; i < pad; i++) w.writeC(0xff);
  w.writeC(0xff);
}

export function startBattleAck(r: RoomModel, s: SlotModel, dinos: number[]): Uint8Array {
  const w = W(64).writeH(5132).writeH(0).writeD(0).writeC(0).writeC(0);
  dinoBlock(w, r, dinos, false);
  return w.writeC(0).writeD(0).writeC(2).writeH(r.frRounds).writeH(r.ctRounds).writeC(2).writeH(r.frRounds).writeH(r.ctRounds).writeD(0).writeC(0).writeC(s.id).toBytes();
}

function swapFlag(r: RoomModel): number {
  return r.isTeamSwap() && r.frRounds + r.ctRounds === SWAP_ROUNDS[r.killTime & 15] && !r.swapRound ? 3 : 0;
}
function charaList(w: PacketWriter, r: RoomModel): void {
  for (const s of r.slots) {
    const e = s.equipment, fr = s.team === Team.FR;
    if (e) w.writeD(fr ? (r.swapRound ? e.charaRedId : e.charaBlueId) : r.swapRound ? e.charaBlueId : e.charaRedId);
    else w.writeD(fr ? (r.swapRound ? 601001 : 602002) : r.swapRound ? 602002 : 601001);
  }
}

export function roundPreStartAck(r: RoomModel, dinos: number[]): Uint8Array {
  const w = W(128).writeH(5151).writeD(r.getSlotsFlag(false, false));
  dinoBlock(w, r, dinos, r.isBotMode());
  w.writeC(swapFlag(r));
  if (r.isTeamSwap()) charaList(w, r);
  return w.toBytes();
}

/** PROTOCOL_BATTLE_MISSION_GENERATOR_INFO_ACK (5167): H bar1, H bar2, 18 x H DamageBar1 (Server.Game ServerPacket, Write). */
export function generatorInfoAck(r: RoomModel): Uint8Array {
  const w = W(64).writeH(5167).writeH(r.bar1).writeH(r.bar2);
  for (const s of r.slots) w.writeH(s.damageBar1);
  return w.toBytes();
}

export function roundStartAck(r: RoomModel): Uint8Array {
  const w = W(128).writeH(5153).writeC(r.rounds).writeD(r.getInBattleTimeLeft()).writeD(r.getSlotsFlag(true, false)).writeC(swapFlag(r))
    .writeH(r.frRounds).writeH(r.ctRounds);
  charaList(w, r);
  return w.toBytes();
}

export function recordAck(r: RoomModel): Uint8Array {
  const w = W(128).writeH(5163).writeH(r.frKills).writeH(r.frDeaths).writeH(r.frAssists).writeH(r.ctKills).writeH(r.ctDeaths).writeH(r.ctAssists);
  for (const s of r.slots) w.writeH(s.allKills).writeH(s.allDeaths).writeH(s.allAssists);
  return w.toBytes();
}

/** PROTOCOL_BATTLE_RESPAWN_ACK (5138): Write() post-increments room.SpawnsCount and pre-increments slot.SpawnsCount. */
export function respawnAck(r: RoomModel, s: SlotModel): Uint8Array {
  const e = s.equipment!;
  const w = W(112).writeH(5138).writeD(s.id).writeD(r.spawnsCount++).writeD(++s.spawnsCount);
  for (const v of [e.weaponPrimary, e.weaponSecondary, e.weaponMelee, e.weaponExplosive, e.weaponSpecial]) w.writeD(v);
  w.writeD(0).writeD(0).writeD(0).writeB([0x64, 0x64, 0x64, 0x64, 0x64, 0, 0, 0]);
  w.writeD(r.validateTeam(s.team, s.team) === Team.FR ? e.charaRedId : e.charaBlueId);
  for (const v of [e.partHead, e.partFace, e.partJacket, e.partPocket, e.partGlove, e.partBelt, e.partHolster, e.partSkin, e.beretItem, e.accessoryId]) w.writeD(v);
  return w.toBytes();
}

export interface FragInfo {
  killingType: number; killsCount: number; killerIdx: number; weapon: number; x: number; y: number; z: number; flag: number; unk: number;
  frags: { victim: number; weaponClass: number; hitspotInfo: number; killFlag: number; unk: number; x: number; y: number; z: number; assist: number; unks: Uint8Array }[];
  score: number;
}
function teamStats(w: PacketWriter, r: RoomModel): void {
  w.writeH(r.frKills).writeH(r.frDeaths).writeH(r.frAssists).writeH(r.ctKills).writeH(r.ctDeaths).writeH(r.ctAssists);
  for (const s of r.slots) w.writeH(s.allKills).writeH(s.allDeaths).writeH(s.allAssists);
}
export function deathAck(r: RoomModel, k: FragInfo, ks: SlotModel): Uint8Array {
  const w = W(256).writeH(5136).writeC(k.killingType).writeC(k.killsCount).writeC(k.killerIdx).writeD(k.weapon).writeT(k.x).writeT(k.y).writeT(k.z).writeC(k.flag).writeC(k.unk);
  for (const f of k.frags) w.writeC(f.victim).writeC(f.weaponClass).writeC(f.hitspotInfo).writeH(f.killFlag).writeC(f.unk).writeT(f.x).writeT(f.y).writeT(f.z).writeC(f.assist).writeB(f.unks);
  teamStats(w, r);
  const kol = ks.killsOnLife;
  return w.writeC(kol === 2 ? 1 : kol === 3 ? 2 : kol > 3 ? 3 : 0).writeH(k.score).toBytes();
}

export function giveUpBattleAck(a: Account, motive: number): Uint8Array {
  const season = a.statistic.season ?? newStat("season"), basic = a.statistic.basic ?? newStat("basic");
  return W(48).writeH(5134).writeD(a.slotId).writeC(motive).writeQ(BigInt(a.exp)).writeD(a.rank).writeD(a.gold).writeD(season.escapesCount)
    .writeD(basic.escapesCount).writeD(0).writeC(0).toBytes();
}

export function roundEndAck(r: RoomModel, winner: number, motive: number): Uint8Array {
  const w = W(16).writeH(5155).writeC(winner).writeC(motive);
  if (r.isDinoMode("DE")) w.writeH(r.frDino).writeH(r.ctDino);
  else if (r.roomType !== RoomCondition.DeathMatch && r.roomType !== RoomCondition.FreeForAll) w.writeH(r.frRounds).writeH(r.ctRounds);
  else w.writeH(r.frKills).writeH(r.ctKills);
  for (const s of r.slots) if (s.specGM) s.firstRespawn = true;
  return w.toBytes();
}

/** AllUtils.InitBotRank (upper bound exclusive). */
export function initBotRank(level: number): number {
  if (level >= 1 && level <= 10) { const lo = (level - 1) * 5; return lo + Math.floor(Math.random() * 4); }
  return 52;
}

const recordFields = ["matches", "matchWins", "matchLoses", "matchDraws", "killsCount", "headshotsCount", "deathsCount", "totalMatchesCount", "totalKillsCount", "escapesCount", "assistsCount", "mvpCount"];

/** PROTOCOL_BATTLE_ENDBATTLE_ACK (5140). */
export function endBattleAck(a: Account, r: RoomModel, winner: number, slotFlag: number, missionFlag: number, bot: boolean, result: Uint8Array): Uint8Array {
  const s = r.slots[a.slotId];
  const mode = r.roomType === RoomCondition.BattleRoyale ? 11 : Math.trunc(r.roomType / 4);
  const w = W(1200).writeH(5140).writeD(slotFlag).writeC(winner).writeB(result).writeD(missionFlag);
  if ([2, 3, 4, 5, 7, 8, 12, 13, 15, 16, 17, 18, 19].includes(mode)) {
    const boss = r.isDinoMode("DE"), cc = r.isDinoMode("CC");
    w.writeH(boss ? r.frDino : cc ? r.frKills : r.frRounds).writeH(boss ? r.ctDino : cc ? r.ctKills : r.ctRounds).writeH(0).writeH(0).zeros(36);
  }
  if (![0, 7, 9, 10, 12].includes(mode)) w.zeros(36);
  w.zeros(5);
  const rw = r.slotRewards;
  for (let i = 0; i < 5; i++) w.writeC(rw ? rw.slots[i] : 0xff);
  for (let i = 0; i < 5; i++) w.writeD(rw ? rw.items[i] : 0);
  for (const x of r.slots) {
    const p = x.playerId > 0n ? r.svc.getAccount(x.playerId) : null;
    w.writeC(p ? p.getRank() : initBotRank(r.isStartingMatch() ? r.ingameAiLevel : r.aiLevel)).writeH(0).writeD(1); // Method2: any empty slot, 52 outside AI rooms
  }
  w.zeros(72).zeros(36);
  const c = a.clan;
  w.writeC(a.nickname.length * 2);
  U(w, a.nickname, a.nickname.length * 2);
  w.writeD(a.getDisplayRank()).writeD(a.getRank()).writeD(a.gold).writeQ(BigInt(a.exp)).writeD(0).writeC(0).writeQ(0n).writeC(0).writeC(0)
    .writeD(a.tags).writeD(a.cash).writeD(c.id).writeD(a.clanAccess).writeD(0).writeD(0).writeC(a.cafePC).writeC(0);
  w.writeC(c.name.length * 2);
  U(w, c.name, c.name.length * 2);
  w.writeC(c.rank).writeC(c.unit).writeD(c.logo).writeC(c.nameColor).writeC(c.effect);
  for (const st of [a.statistic.season ?? newStat("season"), a.statistic.basic ?? newStat("basic")] as Stat[]) for (const f of recordFields) w.writeD(st[f]);
  const red = a.character.getCharacter(a.equipment.charaRedId), blue = a.character.getCharacter(a.equipment.charaBlueId);
  w.writeC(red ? red.slot : 0).writeC(blue ? blue.slot : 1);
  w.writeB(equipmentDataChara(a.inventory, a.equipment.dinoItem)).writeB(equipmentDataChara(a.inventory, a.equipment.sprayId)).writeB(equipmentDataChara(a.inventory, a.equipment.nameCardId));
  w.writeD(0).zeros(3);
  w.writeC(a.event.lastPlaytimeFinish).writeD(a.event.lastPlaytimeValue);
  const ws = a.statistic.weapon ?? newStat("weapon");
  for (const [k, d] of [["assaultKills", "assaultDeaths"], ["smgKills", "smgDeaths"], ["sniperKills", "sniperDeaths"], ["shotgunKills", "shotgunDeaths"], ["machinegunKills", "machinegunDeaths"], ["shieldKills", "shieldDeaths"]]) {
    w.writeD(ws[k] ?? 0).writeD(ws[d] ?? 0).zeros(24);
  }
  w.writeC(0).writeC(0).writeH(0).writeH(0).writeH(0).writeC(0).zeros(16).writeC(0);
  if (mode === 11) { const b = a.statistic.battlecup ?? newStat("battlecup"); for (const f of ["matches", "matchWins", "matchLoses", "killsCount", "deathsCount", "headshotsCount", "assistsCount", "escapesCount", "matchWins", "averageDamage", "playTime", "matches"]) w.writeD(b[f] ?? 0); }
  if (mode === 8) { const b = a.statistic.acemode ?? newStat("acemode"); for (const f of ["matches", "matchWins", "matchLoses", "kills", "deaths", "headshots", "assists", "escapes", "winstreaks"]) w.writeD(b[f] ?? 0); }
  return w.writeH(s ? s.seasonPoint : 0).writeH(s ? s.bonusBattlePass : 0).zeros(21).writeD(0).writeH(600 + a.inventoryPlus + 8).toBytes();
}

export { U as writeUExact };

/** 5157 BATTLE_MISSION_BOMB_INSTALL_ACK. */
export function bombInstallAck(slot: number, zone: number, unk: number, x: number, y: number, z: number): Uint8Array {
  return W(32).writeH(5157).writeD(slot).writeC(zone).writeH(unk).writeT(x).writeT(y).writeT(z).toBytes();
}

/** 5159 BATTLE_MISSION_BOMB_UNINSTALL_ACK. */
export function bombUninstallAck(slot: number): Uint8Array {
  return W(8).writeH(5159).writeD(slot).toBytes();
}
