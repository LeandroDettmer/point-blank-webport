// Auth meta requests the original client sends between LOGIN_ACK and USER_LEAVE, and their ACKs
//. Called by AuthClient; nothing here touches the socket except the
// `fetch*` helpers, which only use PbConnection.send/on.
//
// Order matters on the server:
// - 2316 GET_USER_INFO runs only while `Inventory.Items.Count == 0` and is what LOADS the inventory
//   (AllUtils.LoadPlayerInventory + ValidatePlayerInventoryStatus, which also creates the
//   player_characters rows for character items). It pushes 1061, 2317, 2321 (GET_OPTION_ACK when
//   configs are not loaded yet), 2453, 8451, 8450.
// - 2318 GET_INVEN_INFO sends nothing when the inventory is empty, so it must come after 2316.
// - 2320 GET_OPTION pushes 1810 friends / 1925 notes only when there are any (no ACK of its own).
import type { PbConnection } from "./connection.ts";
import { PacketReader, PacketWriter } from "./packet.ts";
import { FriendOp, friendList, readFriendList } from "./friendClient.ts";
import { NoteOp, noteList, readNoteList } from "./noteClient.ts";
import type {
  EquipPair, InvItemData, InventoryItem, InventoryPage, PlayerRecord, RecordStats, UserInfo,
  UserInfoBasic, Wallet,
} from "../lobby/types.ts";

export const AuthMetaOp = {
  GET_USER_INFO_REQ: 2316,
  GET_USER_INFO_ACK: 2317,
  GET_INVEN_INFO_REQ: 2318,
  GET_INVEN_INFO_ACK: 2319,
  GET_OPTION_REQ: 2320,
  GET_OPTION_ACK: 2321,
  GET_CHARA_INFO_ACK: 2453,
  GET_POINT_CASH_REQ: 1060,
  GET_POINT_CASH_ACK: 1061,
} as const;

// ---- builders (all four REQs have an empty body: Read() {} on the server)

export function buildGetUserInfo(): PacketWriter {
  return new PacketWriter(0);
}
export function buildGetInvenInfo(): PacketWriter {
  return new PacketWriter(0);
}
export function buildGetOption(): PacketWriter {
  return new PacketWriter(0);
}
export function buildGetPointCash(): PacketWriter {
  return new PacketWriter(0);
}

// ---- shared blocks (also used by metaGame.ts)

export function readItemRow(r: PacketReader): InventoryItem {
  return { objectId: r.readD(), itemId: r.readD(), equip: r.readC(), count: r.readD() };
}

export function readPair(r: PacketReader): EquipPair {
  return { itemId: r.readD(), objectId: r.readD() };
}

/** 12 dwords, order of PROTOCOL_BASE_GET_MYINFO_RECORD_ACK.Write(). */
export function readRecordStats(r: PacketReader): RecordStats {
  return {
    matches: r.readD(), wins: r.readD(), loses: r.readD(), draws: r.readD(), kills: r.readD(),
    headshots: r.readD(), deaths: r.readD(), totalMatches: r.readD(), totalKills: r.readD(),
    escapes: r.readD(), assists: r.readD(), mvp: r.readD(),
  };
}

export function readRecord(r: PacketReader): PlayerRecord {
  return { season: readRecordStats(r), total: readRecordStats(r) };
}

/** USER_INFO_BASIC, 185 bytes (GET_USER_INFO_ACK block 47 == GET_MYINFO_BASIC_ACK body). */
export function readUserInfoBasic(r: PacketReader): UserInfoBasic {
  const nickname = r.readU(66);
  const rank = r.readD();
  const rankHigh = r.readD();
  const gold = r.readD();
  r.skip(4); // core
  const exp = BigInt.asUintN(64, r.readQ());
  r.skip(4 + 1 + 8 + 1 + 1);
  const tags = r.readD();
  r.skip(2 + 4);
  const inventoryPlus = r.readH();
  r.skip(4);
  const cash = r.readD();
  const clanId = r.readD();
  const clanAccess = r.readD();
  r.skip(8);
  const cafePC = r.readC();
  r.skip(1);
  const clanName = r.readU(34);
  return {
    nickname, rank, rankHigh, gold, exp, tags, inventoryPlus, cash, clanId, clanAccess, cafePC, clanName,
    clanRank: r.readC(), clanUnit: r.readC(), clanLogo: r.readD(), clanNameColor: r.readC(), clanEffect: r.readC(),
  };
}

/** USER_INFO_INVITEM_DATA, 81 bytes (2317 block 45 == 2395 body). */
export function readInvItemData(r: PacketReader): InvItemData {
  const tag = r.readC();
  const nickColor = r.readC();
  const fakeRank = r.readD();
  r.readD(); // FakeRank duplicate
  return { tag, nickColor, fakeRank, fakeNick: r.readU(66), crosshairColor: r.readH(), muzzleColor: r.readH(), nickBorderColor: r.readC() };
}

// ---- ACK parsers (reader positioned after the opcode, as PbConnection delivers it)

/**
 * 2317 PROTOCOL_BASE_GET_USER_INFO_ACK: 48 S2MO blocks, written in the order of the server's
 * Write(). Arrays the server always sends empty (count 0) have unknown element sizes, so a
 * non-zero count there throws instead of guessing.
 */
export function parseUserInfo(r: PacketReader): UserInfo {
  r.readH();
  const error = r.readD();
  const empty = (): EquipPair => ({ itemId: 0, objectId: 0 });
  const out: UserInfo = {
    error, basic: null, record: null, invItem: null, redSlot: 0, blueSlot: 1,
    dino: empty(), spray: empty(), namecard: empty(), pointUp: 0, expUp: 0, age: 0,
  };
  if (error !== 0) return out;
  const zeroCount = (what: string) => {
    const n = r.readC();
    if (n !== 0) throw new Error(`2317: ${what} count ${n} (element size not known)`);
  };
  r.skip(8); // 01, 02
  zeroCount("P_QUEST_VERSION_INFO");
  r.skip(127); // 04 USER_INFO_P_QUEST
  zeroCount("ITEM_INFO[6]");
  r.skip(15 + 21 + 152 + 152 + 48 + 36 + 5 + 1 + 2 + 4 + 8); // 06..16
  zeroCount("LADDER_RECORD a");
  zeroCount("LADDER_RECORD b");
  r.skip(6 * 32 + 3); // 19 WEAPON_RECORD, 20..22
  r.skip(4 * r.readC()); // 23 QUICKJOIN_INFO
  r.skip(33); // 24 USER_INFO_DAILY
  zeroCount("NOTIFY_MEDAL");
  r.skip(4);
  zeroCount("uchar[3]");
  r.skip(8);
  zeroCount("uchar[160]");
  out.questing = r.readB(89); // 30 QUESTING_INFO (net/missionClient.ts parseQuesting)
  r.skip(16 + 9); // 31..34, 35 USER_INFO_LTS
  r.skip(468 * r.readC()); // 36 ATTENDANCE_INFO
  r.skip(9 * r.readC()); // 37 ATTENDANCE_USER
  r.skip(8); // 38, 39
  out.redSlot = r.readC(); // 40 S2_MULTI_SLOT_INFO
  out.blueSlot = r.readC();
  out.dino = readPair(r);
  out.spray = readPair(r);
  out.namecard = readPair(r);
  r.skip(8 + 4 + 1); // +26/+30, 41, 42
  out.pointUp = new DataView(r.readB(4).buffer).getFloat32(0, true);
  out.expUp = new DataView(r.readB(4).buffer).getFloat32(0, true);
  out.invItem = readInvItemData(r);
  out.record = readRecord(r);
  out.basic = readUserInfoBasic(r);
  out.age = r.readC();
  return out;
}

/**
 * 2319 PROTOCOL_BASE_GET_INVEN_INFO_ACK. The active Write() puts `Count` in the three trailing H
 * fields (the commented 100-item chunking variant sends total/offset/total there); only
 * `basicCount` is read. One ACK carries the whole list (LimitationIndex caps it).
 */
export function parseInvenInfo(r: PacketReader): InventoryPage {
  r.readH();
  const error = r.readD();
  if (error !== 0) return { error, items: [], basicCount: 0 };
  const n = r.readH();
  const items: InventoryItem[] = [];
  for (let i = 0; i < n; i++) items.push(readItemRow(r));
  const basicCount = r.readH();
  r.skip(8);
  return { error, items, basicCount };
}

/** 1061 PROTOCOL_AUTH_GET_POINT_CASH_ACK (same writer on Auth and Game): D err, D cash, D gold, D tags. */
export function parsePointCash(r: PacketReader): Wallet & { error: number } {
  const error = r.readD();
  const cash = r.readD();
  const gold = r.readD();
  return { error, cash, gold, tags: r.readD() };
}

// ---- helpers for AuthClient

export interface AuthMeta {
  userInfo: UserInfo;
  inventory: InventoryPage | null;
  wallet: Wallet | null;
  /** Raw 2453 pushed by Auth after 2316 (same layout as Game, parse with metaGame.parseCharaInfo). */
  charaInfoRaw: Uint8Array | null;
}

/**
 * Runs 2316 -> 2318 -> 2320 -> 1060 on a logged-in Auth connection (before USER_LEAVE).
 * *Not verified*: the original client's exact order; this is the order the
 * server needs (2316 loads the inventory 2318 reads).
 */
export async function fetchAuthMeta(conn: PbConnection, timeoutMs = 5000): Promise<AuthMeta> {
  let charaInfoRaw: Uint8Array | null = null;
  const off = conn.on((op, r) => {
    if (op === AuthMetaOp.GET_CHARA_INFO_ACK) charaInfoRaw = r.data.slice(r.pos);
    // 1810 friend list: pushed by 2320 when the player has friends; kept for the Comunidade window (friendClient.ts)
    else if (op === FriendOp.LIST_ACK) friendList.set(readFriendList(new PacketReader(r.data.slice(r.pos))));
    // 1925 notes: pushed by 2320 with the first 25 notes (server noteListAck); kept for the Msg. tab (pages/notes.ts)
    else if (op === NoteOp.LIST_ACK) noteList.set(readNoteList(new PacketReader(r.data.slice(r.pos))));
  });
  try {
    const ui = conn.waitFor(AuthMetaOp.GET_USER_INFO_ACK, timeoutMs);
    conn.send(AuthMetaOp.GET_USER_INFO_REQ, buildGetUserInfo());
    const userInfo = parseUserInfo(await ui);
    const inv = conn.waitFor(AuthMetaOp.GET_INVEN_INFO_ACK, 2000).catch(() => null);
    conn.send(AuthMetaOp.GET_INVEN_INFO_REQ, buildGetInvenInfo());
    const invR = await inv;
    conn.send(AuthMetaOp.GET_OPTION_REQ, buildGetOption());
    const pc = conn.waitFor(AuthMetaOp.GET_POINT_CASH_ACK, timeoutMs);
    conn.send(AuthMetaOp.GET_POINT_CASH_REQ, buildGetPointCash());
    const w = parsePointCash(await pc);
    return {
      userInfo,
      inventory: invR ? parseInvenInfo(invR) : null,
      wallet: w.error === 0 ? { gold: w.gold, cash: w.cash, tags: w.tags } : null,
      charaInfoRaw,
    };
  } finally {
    off();
  }
}
