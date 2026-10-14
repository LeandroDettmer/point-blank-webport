// Server.Auth ServerPacket ports for the account meta sent after login: 2317 GET_USER_INFO, 2319 GET_INVEN_INFO,
// 2321 GET_OPTION, 2453 GET_CHARA_INFO, 8451 SEASON_CHALLENGE_SEASON_CHANGE, 8450 SEASON_CHALLENGE_INFO.
import { PacketWriter } from "../../../src/net/packet.ts";
import type { Account } from "../shared/account.ts";
import type { ClanModel } from "../shared/dao.ts";
import { data, bpLevelInfo, visitEventById, visitEventEnabled, type EventVisitModel } from "../shared/data.ts";
import { ItemsModel } from "../shared/items.ts";
import { newStat, bcWinRatio, bcKDRatio, type PlayerInventory, type PlayerConfig, type PlayerMissions } from "../shared/models.ts";
import { isPackedGood } from "../shared/shop.ts";
import { missionCardFlags } from "../shared/data.ts";
import { convertDate, fmtDate } from "../shared/time.ts";
import { pointUp, expUp } from "../shared/playerUtils.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} [auth-ts] ${m}`);

/** PlayerInventory.EquipmentDataChara: [D itemId][D objectId], or [D id][D 0] when not owned. */
export function equipmentDataChara(inv: PlayerInventory, itemId: number): Uint8Array {
  const w = new PacketWriter(8);
  const it = inv.getItem(itemId);
  if (!it) w.writeD(itemId).writeD(0);
  else w.writeD(it.id).writeD(Number(BigInt.asUintN(32, it.objectId)));
  return w.toBytes();
}
/** PlayerInventory.EquipmentData: [D objectId][D itemId], or [D 0][D id]. */
export function equipmentData(inv: PlayerInventory, itemId: number): Uint8Array {
  const w = new PacketWriter(8);
  const it = inv.getItem(itemId);
  if (!it) w.writeD(0).writeD(itemId);
  else w.writeD(Number(BigInt.asUintN(32, it.objectId))).writeD(it.id);
  return w.toBytes();
}

/** C# BaseServerPacket.WriteU: UTF-16LE then (Count - 2*len) zeros; too long throws (packet not sent). */
export function csWriteU(w: PacketWriter, text: string, count: number): PacketWriter {
  if (text.length * 2 > count) throw new Error(`WriteU overflow: ${text.length * 2} > ${count}`);
  return w.writeU(text, count);
}
/** WriteN(text, count): all UTF-16 bytes, then (count - text.Length) zeros. */
export function csWriteN16(w: PacketWriter, text: string, count: number): PacketWriter {
  for (let i = 0; i < text.length; i++) w.writeH(text.charCodeAt(i));
  return w.zeros(count - text.length);
}

/** MissionWire.BuildQuestingInfo (89 bytes). */
export function questingInfo(m: PlayerMissions): Uint8Array {
  const w = new PacketWriter(89).writeC(m.actualMission);
  for (let i = 0; i < 4; i++) w.writeC(m.at(i).currentCard);
  for (let i = 0; i < 4; i++) w.writeB(missionCardFlags(m.at(i).cardSetId, m.at(i).progress));
  for (let i = 0; i < 4; i++) w.writeC(m.at(i).cardSetId);
  return w.toBytes();
}

/** The 185-byte USER_INFO_BASIC block shared by 2317 (Auth) and 2371 (Game). logoRaw: Auth writes clan.Logo as is;
 * Game writes (clan.Id == 0 ? -1 : Logo). */
export function writeUserInfoBasic(w: PacketWriter, a: Account, clan: ClanModel, gameLogo: boolean): void {
  csWriteU(w, a.nickname, 66);
  w.writeD(a.getDisplayRank()).writeD(a.getRank()).writeD(a.gold).writeD(0).writeQ(BigInt(a.exp)).writeD(0).writeC(0).writeQ(0n)
    .writeC(0).writeC(0).writeD(a.tags).writeH(0).writeD(0).writeH(a.inventoryPlus).writeD(0).writeD(a.cash).writeD(clan.id)
    .writeD(a.clanAccess).writeD(0).writeD(0).writeC(a.cafePC).writeC(0);
  csWriteU(w, clan.name, 34);
  w.writeC(clan.rank).writeC(clan.unit).writeD(gameLogo ? (clan.id === 0 ? 0xffffffff : clan.logo) : clan.logo).writeC(clan.nameColor).writeC(clan.effect);
}

function checkEventVisit(a: Account, ev: EventVisitModel | null, date: number): Uint8Array {
  const w = new PacketWriter(9);
  const pe = a.event;
  if (ev && pe && visitEventEnabled(ev)) {
    const n1 = Number(fmtDate(convertDate(String(date)), "yyMMdd"));
    const n2 = Number(fmtDate(convertDate(String(pe.lastVisitDate)), "yyMMdd"));
    w.writeD(ev.id).writeC(pe.lastVisitCheckDay).writeC(pe.lastVisitCheckDay - 1).writeC(n2 < n1 ? 1 : 2).writeC(pe.lastVisitSeqType).writeC(1);
  } else w.zeros(9);
  return w.toBytes();
}

function attendanceData(a: Account, ev: EventVisitModel | null): Uint8Array {
  const w = new PacketWriter(468);
  if (ev && visitEventEnabled(ev)) {
    const next = visitEventById(ev.id + 1);
    w.writeU(ev.title, 70); // SyncServerPacket.WriteU truncates/pads
    w.writeC(a.event.lastVisitCheckDay).writeC(ev.checks).writeD(ev.id).writeD(ev.beginDate).writeD(ev.endedDate)
      .writeD(next ? next.beginDate : 0).writeD(next ? next.endedDate : 0).writeD(0);
    for (let i = 0; i < 31; i++) {
      const box = ev.boxes[i];
      const rewards: number[] = [];
      for (const goodId of [box.reward1, box.reward2]) {
        if (goodId === 0) continue;
        if (!isPackedGood(goodId)) { log(`Attendance day ${i + 1}: skipped good ${goodId} (not in the packed client catalog)`); continue; }
        rewards.push(goodId);
      }
      w.writeC(box.isBothReward && rewards.length > 1 ? 1 : 0).writeC(rewards.length).writeH(0).writeD(rewards[0] ?? 0).writeD(rewards[1] ?? 0);
    }
  } else w.zeros(468);
  return w.toBytes();
}

/** PROTOCOL_BASE_GET_USER_INFO_ACK (2317). */
export function getUserInfoAck(a: Account, clan: ClanModel, eventVisit: EventVisitModel | null, enableBlood: boolean): Uint8Array {
  const w = new PacketWriter(2400).writeH(2317).writeH(0).writeD(0);
  const st = a.statistic;
  const basic = st.basic ?? newStat("basic"), season = st.season ?? newStat("season"), weapon = st.weapon ?? newStat("weapon");
  st.battlecup ??= newStat("battlecup");
  st.acemode ??= newStat("acemode");
  const bc = st.battlecup, ace = st.acemode;
  const date = Number(fmtDate(a.lastLoginDate, "yyMMddHHmm"));
  const now = new Date();
  w.writeD(0).writeD(0).writeC(0).zeros(127).writeC(0);
  w.writeD(0).writeD(1).writeH(0).writeD(now.getHours() * 60 + now.getMinutes()).writeC(0);
  w.zeros(21).zeros(152).zeros(152);
  w.writeD(bc.matches).writeD(bcWinRatio(bc)).writeD(bc.matchLoses).writeD(bc.killsCount).writeD(bc.deathsCount).writeD(bc.headshotsCount)
    .writeD(bc.assistsCount).writeD(bc.escapesCount).writeD(bcKDRatio(bc)).writeD(bc.matchWins).writeD(bc.averageDamage).writeD(bc.playTime);
  w.writeD(ace.matches).writeD(ace.matchWins).writeD(ace.matchLoses).writeD(ace.kills).writeD(ace.deaths).writeD(ace.headshots)
    .writeD(ace.assists).writeD(ace.escapes).writeD(ace.winstreaks);
  w.zeros(5).writeC(0).writeH(0).writeD(0).zeros(8).writeC(0).writeC(0);
  for (const [k, d] of [["assaultKills", "assaultDeaths"], ["smgKills", "smgDeaths"], ["sniperKills", "sniperDeaths"], ["shotgunKills", "shotgunDeaths"], ["machinegunKills", "machinegunDeaths"], ["shieldKills", "shieldDeaths"]]) {
    w.writeD(weapon[k] ?? 0).writeD(weapon[d] ?? 0).zeros(24);
  }
  w.writeC(0).writeC(0).writeC(0);
  const qs = a.quickjoins, n = Math.min(qs.length, 3);
  w.writeC(n);
  for (let i = 0; i < n; i++) w.writeC(qs[i].mapId).writeC(qs[i].rule).writeC(qs[i].stageOptions).writeC(qs[i].type);
  w.zeros(33).writeC(0).writeD(0).writeC(0).writeQ(0n).writeC(0);
  w.writeB(questingInfo(a.mission));
  w.writeD(0).writeD(0).writeD(0).writeD(0).zeros(9);
  const attendance = eventVisit != null && visitEventEnabled(eventVisit) && a.event != null;
  w.writeC(attendance ? 2 : 0);
  if (attendance) w.zeros(468).writeB(attendanceData(a, eventVisit));
  w.writeC(attendance ? 2 : 0);
  if (attendance) w.zeros(9).writeB(checkEventVisit(a, eventVisit, date));
  w.writeD(0).writeD(0);
  const chars = a.character.characters, eq = a.equipment, inv = a.inventory;
  const red = chars.length === 0 ? null : a.character.getCharacter(eq.charaRedId);
  const blue = chars.length === 0 ? null : a.character.getCharacter(eq.charaBlueId);
  w.writeC(red ? red.slot : 0).writeC(blue ? blue.slot : 1);
  w.writeB(equipmentDataChara(inv, eq.dinoItem)).writeB(equipmentDataChara(inv, eq.sprayId)).writeB(equipmentDataChara(inv, eq.nameCardId));
  w.writeD(0).writeD(0).writeD(0).writeC(0);
  w.writeT(pointUp(a)).writeT(expUp(a));
  w.writeC(0).writeC(a.nickColor).writeD(a.bonus.fakeRank).writeD(a.bonus.fakeRank);
  csWriteU(w, a.bonus.fakeNick, 66);
  w.writeH(a.bonus.crosshairColor).writeH(a.bonus.muzzleColor).writeC(a.bonus.nickBorderColor);
  for (const s of [season, basic]) {
    w.writeD(s.matches).writeD(s.matchWins).writeD(s.matchLoses).writeD(s.matchDraws).writeD(s.killsCount).writeD(s.headshotsCount)
      .writeD(s.deathsCount).writeD(s.totalMatchesCount).writeD(s.totalKillsCount).writeD(s.escapesCount).writeD(s.assistsCount).writeD(s.mvpCount);
  }
  writeUserInfoBasic(w, a, clan, false);
  w.writeC(enableBlood ? a.age : 42);
  return w.toBytes();
}

/** PROTOCOL_BASE_GET_INVEN_INFO_ACK (2319). */
export function getInvenInfoAck(items: ItemsModel[], templateCount: number): Uint8Array {
  const w = new PacketWriter(64 + items.length * 13).writeH(2319).writeH(0).writeD(0).writeH(items.length);
  for (const it of items) w.writeD(Number(BigInt.asUintN(32, it.objectId))).writeD(it.id).writeC(it.equip).writeD(it.count);
  return w.writeH(templateCount).writeH(items.length).writeH(items.length).writeH(items.length).writeH(0).toBytes();
}

/** PROTOCOL_BASE_GET_OPTION_ACK (2321). */
export function getOptionAck(c: PlayerConfig): Uint8Array {
  const w = new PacketWriter(320).writeH(2321).writeH(0).writeD(0).writeH(c.nations);
  for (const m of [c.macro5, c.macro4, c.macro3, c.macro2, c.macro1]) { w.writeH(m.length); csWriteN16(w, m, m.length); }
  w.writeH(49).writeB([0xda, 0x7f, 0x1b, 0x00]).writeB(c.keyboardKeys);
  return w.writeH(c.showBlood).writeC(c.crosshair).writeC(c.handPosition).writeD(c.config).writeD(c.audioEnable).writeH(0)
    .writeC(c.audioSFX).writeC(c.audioBGM).writeC(c.pointOfView).writeC(0).writeC(c.sensitivity).writeC(c.invertMouse).writeH(0)
    .writeC(c.enableInviteMsg).writeC(c.enableWhisperMsg).writeD(c.macro).toBytes();
}

/** PROTOCOL_BASE_GET_CHARA_INFO_ACK (2453), identical on Auth and Game. */
export function getCharaInfoAck(a: Account): Uint8Array {
  const w = new PacketWriter(256).writeH(2453).writeH(0).writeH(a.character.characters.length);
  for (const c of a.character.characters) w.writeC(c.slot).writeC(20).writeD(c.id).writeD(Number(BigInt.asUintN(32, c.objectId)));
  for (const b of charaBlock(a, a.equipment.charaRedId)) w.writeB(b);
  return w.toBytes();
}

/** The 18 x 8-byte equipment block of 2453 / 3082 (index 8 = the red character, or the given id). */
export function charaBlock(a: Account, chara: number): Uint8Array[] {
  const e = a.equipment, inv = a.inventory;
  const blocks: Uint8Array[] = Array.from({ length: 18 }, () => new Uint8Array(8));
  const ids: [number, number][] = [
    [0, e.weaponPrimary], [1, e.weaponSecondary], [2, e.weaponMelee], [3, e.weaponExplosive], [4, e.weaponSpecial], [8, chara],
    [9, e.partHead], [10, e.partFace], [11, e.partJacket], [12, e.partPocket], [13, e.partGlove], [14, e.partBelt], [15, e.partHolster],
    [16, e.partSkin], [17, e.beretItem],
  ];
  for (const [i, id] of ids) blocks[i] = equipmentDataChara(inv, id);
  return blocks;
}

/** PROTOCOL_SEASON_CHALLENGE_SEASON_CHANGE (8451). */
export const seasonChangeAck = () => new PacketWriter(8).writeH(8451).writeH(0).writeC(1).toBytes();

/** PROTOCOL_SEASON_CHALLENGE_INFO_ACK (8450): [21B user][1665B season info]. */
export function seasonChallengeInfoAck(a: Account | null): Uint8Array {
  const user = new Uint8Array(21), info = new Uint8Array(1665);
  const s = data.activeSeason, cards = data.bpCards;
  if (a && s && cards.length > 0) {
    const uv = new DataView(user.buffer), iv = new DataView(info.buffer);
    const lvl = bpLevelInfo(a.battlepass.earnedPoints);
    let seasonId = Number.parseInt(s.seasonId, 10);
    if (!Number.isFinite(seasonId)) seasonId = 1;
    if (seasonId === 0) seasonId = 1;
    const ordered = [...cards].sort((x, y) => x.number - y.number);
    const count = Math.min(ordered.length, 100);
    uv.setInt32(0, seasonId, true);
    user[4] = lvl.currentLevel & 0xff;
    uv.setInt32(5, a.battlepass.earnedPoints, true);
    user[9] = Math.max(0, Math.min(255, a.battlepass.battlepassNormalLevel));
    user[10] = Math.max(0, Math.min(255, a.battlepass.battlepassPremiumLevel));
    user[11] = a.battlepass.havePremium ? 1 : 0;
    iv.setInt32(0, seasonId, true);
    info[4] = s.seasonEnabled === 1 ? 1 : 2;
    const name = s.name.length > 20 ? s.name.slice(0, 20) : s.name;
    for (let i = 0; i < name.length && i * 2 + 1 < 42; i++) iv.setUint16(5 + i * 2, name.charCodeAt(i), true);
    info[47] = count;
    for (let i = 0; i < count; i++) {
      const c = ordered[i], off = 53 + 16 * i;
      iv.setInt32(off, i === 0 ? 0 : ordered[i - 1].requiredExp, true);
      iv.setInt32(off + 4, s.enabledForFree ? c.normalCard : 0, true);
      iv.setInt32(off + 8, s.enabledForPremium ? c.premiumCardA : 0, true);
      iv.setInt32(off + 12, s.enabledForPremium ? c.premiumCardB : 0, true);
    }
    iv.setUint16(1653, 1, true);
    iv.setUint32(1657, Number(s.startDate) >>> 0, true);
    iv.setUint32(1661, Number(s.endDate) >>> 0, true);
  } else log("SEASON_CHALLENGE_INFO_ACK: no active season/cards; sending empty (card hidden).");
  return new PacketWriter(1700).writeH(8450).writeH(0).writeB(user).writeB(info).toBytes();
}

/** PROTOCOL_SERVER_MESSAGE_ANNOUNCE_ACK (3079). */
export function announceAck(message: string): Uint8Array {
  const w = new PacketWriter(64).writeH(3079).writeH(0).writeD(0).writeH(message.length);
  return csWriteN16(w, message, message.length).writeD(2).toBytes();
}
