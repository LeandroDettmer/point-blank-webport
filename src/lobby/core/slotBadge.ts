// Ready-room slot states as the server sends them (3595 slot list).

/** Wire slot state (server SlotModel.GetClientState: internal state, + 3 from NORMAL up). */
export const WIRE_SLOT = { SHOP: 3, INFO: 4, CLAN: 5, INVENTORY: 6, GACHA: 7, GIFTSHOP: 8, NORMAL: 12, READY: 13, LOAD: 14 } as const;
