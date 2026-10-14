// Web front with no Auth/Game targets: only /signal, /health and /api. Used by the p2p tests (src/p2p/test),
// which need the WebRTC signaling relay and no Postgres.
//   PB_WEB_HOST / PB_WEB_PORT as in web/webServer.ts
//   PB_SIGNAL_TICKET_SECRET: the /signal ticket secret the tests mint with (src/p2p/test/signalTickets.ts); the game server
//   never reads it (its secret is random per process, web/signalTicket.ts)
import { startWebServer } from "../src/web/webServer.ts";
import { setSignalTicketSecret } from "../src/web/signalTicket.ts";

if (process.env.PB_SIGNAL_TICKET_SECRET) setSignalTicketSecret(process.env.PB_SIGNAL_TICKET_SECRET);
await startWebServer({});
