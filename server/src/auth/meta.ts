// Server.Auth account-meta handlers: PROTOCOL_BASE_GET_USER_INFO_REQ (2316), GET_INVEN_INFO_REQ (2318),
// GET_OPTION_REQ (2320).
import type { TcpSession } from "../net/tcpSession.ts";
import type { Account } from "../shared/account.ts";
import * as dao from "../shared/dao.ts";
import { data, runningVisitEvent, getPCCafe, getPCCafeRewards } from "../shared/data.ts";
import * as pu from "../shared/playerUtils.ts";
import { getLabel } from "../shared/translation.ts";
import { friendInfoAck, noteListAck } from "../game/socialHandlers.ts";
import { getUserInfoAck, getOptionAck, getCharaInfoAck, seasonChangeAck, seasonChallengeInfoAck, getInvenInfoAck, announceAck } from "./metaPackets.ts";

const log = (m: string) => console.log(`${new Date().toISOString()} [auth-ts] ${m}`);
const ENABLE_BLOOD = true; // ServerConfig.json EnableBlood (default true)

/** PROTOCOL_BASE_GET_USER_INFO_REQ.Run: only once per login (Inventory.Items.Count == 0). */
export async function handleGetUserInfo(c: TcpSession, p: Account): Promise<void> {
  try {
    if (p.inventory.items.length !== 0) return;
    await pu.validateAuthLevel(p);
    await pu.loadPlayerInventory(p);
    await pu.loadPlayerMissions(p);
    await pu.validatePlayerInventoryStatus(p);
    await pu.discountPlayerItems(p);
    const ev = await pu.checkGameEvents(p);
    if (ev.loginGiftAnnounce) c.send(announceAck(getLabel("LoginGiftMessage")));
    const clan = await dao.getClanDB(p.clanId);
    c.send(getUserInfoAck(p, clan, runningVisitEvent(), ENABLE_BLOOD));
    if (!p.myConfigsLoaded) c.send(getOptionAck(p.config));
    c.send(getCharaInfoAck(p));
    await pu.processBattlepass(p);
    c.send(seasonChangeAck());
    c.send(seasonChallengeInfoAck(p));
  } catch (e) {
    log(`PROTOCOL_BASE_GET_USER_INFO_REQ: ${(e as Error).stack ?? e}`);
  }
}

/** PROTOCOL_BASE_GET_INVEN_INFO_REQ.Run. */
export function handleGetInvenInfo(c: TcpSession, p: Account): void {
  const items = pu.limitationIndex(p, p.inventory.items);
  if (items.length <= 0) return;
  let count = data.basics.length;
  if (getPCCafe(p.cafePC) != null) count += getPCCafeRewards(p.cafePC).length;
  c.send(getInvenInfoAck(items, count));
}

/** PROTOCOL_BASE_GET_OPTION_REQ.Run: friend list (1810) and notes (1925) pushes. Both are F5 (messenger); this
 * port logs when a player has any so the gap is visible. */
export async function handleGetOption(c: TcpSession, p: Account): Promise<void> {
  if (!p.myConfigsLoaded && p.friends.length > 0) c.send(await friendInfoAck(p.friends, true));
  const notes = await noteListAck(p.playerId);
  if (notes) c.send(notes);
}
