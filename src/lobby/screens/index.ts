// Meta session API (stores + packet listeners) used by the 2017 lobby (core) and the plain web lobby (src/ui).
// State: session.player (PlayerStore: weaponLoadout(), teamCharas(), equipPairs(), items(), wallet),
// session.shop (ShopStore), session.lobby (LobbyStore).
import type { PbConnection } from "../../net/connection.ts";
import type { AuthMeta } from "../../net/metaAuth.ts";
import { parseCharaInfo, type EnterPushes } from "../../net/metaGame.ts";
import { PacketReader } from "../../net/packet.ts";
import { MetaSession } from "../state/MetaSession.ts";
import { IdbCatalogCache, ShopStore } from "../state/ShopStore.ts";
import { PlayerStore } from "../state/PlayerStore.ts";
import { LobbyStore } from "../state/LobbyStore.ts";

export { MetaSession, MetaError, Side, buyErrorText } from "../state/MetaSession.ts";
export { PlayerStore } from "../state/PlayerStore.ts";
export type { PlayerState, PlayerEvent, PlayerKey } from "../state/PlayerStore.ts";
export { ShopStore, MemoryCatalogCache, IdbCatalogCache } from "../state/ShopStore.ts";
export type { ShopOffer, ShopOption, Currency } from "../state/ShopStore.ts";
export { LobbyStore } from "../state/LobbyStore.ts";
export { setItemNameProvider, itemName } from "../state/itemNames.ts";

export interface SessionInit {
  /** fetchAuthMeta() result (Auth, before USER_LEAVE) */
  authMeta?: AuthMeta | null;
  /** collectEnterPushes().done (Game USER_ENTER) */
  enterPushes?: EnterPushes | null;
  /** Game connection: MetaSession listens to 3334/1059/1061/3082/2453/2371/2369/1051 on it */
  gameConn?: PbConnection | null;
  /** persist the packed shop lists in IndexedDB (default true in the browser) */
  persistCatalog?: boolean;
}

export function createMetaSession(o: SessionInit = {}): MetaSession {
  const cache = o.persistCatalog === false || typeof indexedDB === "undefined" ? undefined : new IdbCatalogCache();
  const s = new MetaSession(new PlayerStore(), new ShopStore(cache), new LobbyStore());
  const am = o.authMeta;
  if (am) {
    let charaInfo = null;
    try { charaInfo = am.charaInfoRaw ? parseCharaInfo(new PacketReader(am.charaInfoRaw)) : null; } catch { charaInfo = null; }
    s.player.dispatch({ type: "authMeta", userInfo: am.userInfo, inventory: am.inventory, wallet: am.wallet, charaInfo });
    if (s.player.state.unsavedCharas.length)
      console.warn("[lobby] Auth 2453 has unsaved characters (stock objectId): the Game will duplicate a character slot", s.player.state.unsavedCharas);
  }
  if (o.enterPushes) s.player.dispatch({ type: "enter", pushes: o.enterPushes });
  if (o.gameConn) s.attach(o.gameConn);
  return s;
}
