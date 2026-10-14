// /signal tickets for the P2P tests: there is no Server.Game to hand them out, so the signal-only
// server (server/tools/signal-server.ts) gets this secret through PB_SIGNAL_TICKET_SECRET and the tests mint with it.
import { randomBytes } from "node:crypto";
import { mintSignalTicket, setSignalTicketSecret } from "../../../server/src/web/signalTicket.ts";
import { signalRoomKey } from "../signaling.ts";

const secret = randomBytes(16).toString("hex");
setSignalTicketSecret(secret);

/** spread into the env of the spawned signal-server.ts */
export const signalTicketEnv = { PB_SIGNAL_TICKET_SECRET: secret };

/** the ticket Server.Game would give the account of `slot` at PRESTARTBATTLE */
export const testTicket = (uniqueRoomId: number, roomSeed: number, slot: number): string =>
  mintSignalTicket(signalRoomKey(uniqueRoomId, roomSeed), slot, BigInt(100 + slot));
