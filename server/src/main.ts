// PB TypeScript server entry. Runs beside the .NET servers until F6:
//   node src/main.ts            -> Auth on PB_TS_AUTH_PORT (39290), Game servers on PB_TS_GAME_PORT_BASE+id (39291..),
//                                  web front (ws /tcp /signal, http /api) on PB_WEB_PORT (8090)
import { startAuthServer, accept as acceptAuth } from "./auth/authServer.ts";
import { startGameServers, acceptGame } from "./game/gameServer.ts";
import { startWebServer, ensureAccountSchema, type Acceptors } from "./web/webServer.ts";
import { pool } from "./db.ts";
import { loadStaticData } from "./shared/data.ts";
import { loadShop } from "./shared/shop.ts";
import { startBugRetention } from "./game/bugReports.ts";

await loadStaticData();
await loadShop();
const servers = [await startAuthServer(), ...(await startGameServers())];
const acceptors: Acceptors = { auth: acceptAuth };
for (let id = 1; id < servers.length; id++) acceptors[`game${id}`] = (sock) => acceptGame(id, sock);
await ensureAccountSchema();
servers.push(await startWebServer(acceptors));
startBugRetention();
// a stray exception / rejection in a timer or a DB call must not take every session down with the process
process.on("uncaughtException", (e) => console.error("[server] uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("[server] unhandledRejection:", e));
const stop = () => { for (const s of servers) s.close(); void pool.end().finally(() => process.exit(0)); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
