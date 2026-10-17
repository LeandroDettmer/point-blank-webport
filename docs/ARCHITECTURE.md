# Architecture

Overview of how the parts talk to each other. To run the project, see the [README](../README.md).

## Parts

```
browser (client, src)
   │  WebSocket  ws://<host>:8090/tcp?target=auth|game1|game2|game3   (PB protocol bytes)
   │  WebSocket  ws://<host>:8090/signal?...                          (WebRTC signaling)
   │  HTTP       /api/register, /api/login                            (account, no PB protocol)
   ▼
server (server)  ──── Postgres 16 (db/)
   ├─ Auth   (TCP 39290; also via /tcp?target=auth)
   ├─ Game   (TCP 39291-39293, one per channel; also via /tcp?target=game1..3)
   └─ web front (8090): /tcp, /signal, /api, /health

P2P match (one of the players is the host)
   host: Web Worker in the tab of the room leader (src/host) + one RTCPeerConnection per guest
   guest: one RTCPeerConnection to the host
```

The browser cannot open TCP. All PB traffic goes through a WebSocket on the web front. The TCP server stays available for native clients.

## Client (`src`)

| Folder | Contents |
|---|---|
| `boot.ts`, `main.ts`, `game/game.ts` | start-up, game loop, lobby and battle screens |
| `game/`, `weapons/`, `gameplay/` | character, weapons, grenades, damage, movement (character controller) |
| `game/pbHud/` | match HUD (scoreboard, ammo, radar, warnings) |
| `lobby/` | lobby: screens (`screens`, `screensCross`), state (`state`), room rules (`core`) |
| `net/` | WebSocket connection, framing and cipher of the protocol (`cmess.ts`, `packet.ts`), one client per topic (login, room, clan, friends, shop, missions) |
| `p2p/`, `host/` | P2P match: signaling, data channels, host (`matchCore.ts`, `worker.ts`) |
| `render/` | three.js: materials, compressed textures, lighting |
| `ui/` | account and room screens in web mode |

The assets (models, textures, sounds, maps) are not in the repository. The `pbx` export generates them in `public/assets/`.

## Server (`server/src`)

| File or folder | Contents |
|---|---|
| `main.ts` | starts Auth, Game and the web front in one process |
| `config.ts` | reads `server/runtime/Config/Settings.ini`, `server/runtime/Data/ServerConfig.json` and `server/.env.local` / environment variables |
| `auth/` | Auth: login, server and channel list, entry token |
| `game/` | Game: channels, lobby, rooms (`roomModel.ts`, `roomHandlers.ts`), inventory, shop, clan, missions, votes, chat and reports |
| `web/` | web front: `/tcp` (WebSocket to TCP), `/signal`, `/api` (accounts, with bcrypt), `/health` |
| `net/tcpSession.ts` | framing and cipher of one PB session, same for Auth and Game |
| `shared/` | Postgres access (`db.ts`, `dao.ts`), static data (`data.ts`, `shop.ts`, `items.ts`) |

The game data the server reads at start-up lives in `server/runtime/`. The database stores accounts, characters, inventory and progress. The `system_*` tables store configuration (shop, missions, titles, channels) and come from `db/init/001_init.sql`.

## Protocol

The protocol is the original Point Blank binary protocol. Each packet has an opcode header and a sequence number. The cipher and framing are in `src/net/cmess.ts` (client) and `server/src/net/tcpSession.ts` (server). Both use the same cipher code, and the vector tests in `src/net/test/` check that they stay compatible. The opcodes are in `src/net/opcodes.ts`.

Login flow: connection, `CONNECT_ACK` (session key), login on Auth, switch to Game, channel choice, lobby. After that: room, match and result.

## Database

- Postgres 16 in Docker (`db/docker-compose.yml`), port 5433 on `127.0.0.1`.
- `db/init/001_init.sql` loads when the volume is empty (first start). It contains the schema and game data (shop, maps, missions, titles, channels), with no accounts or progress. To change the schema or the data, generate a new init from the database and test it on a clean start. To reset, run `docker compose down -v`.
- The database has no test user. Accounts are created through registration.

## P2P

The room and the result stay on the server (Game). Only the match datagrams travel between the players:

1. When the battle starts, Game issues a signaling ticket to each player (`server/src/web/signalTicket.ts`).
2. The room leader runs the match core (`src/host/matchCore.ts`) in a Web Worker in its own tab.
3. Each guest opens an `RTCPeerConnection` to the leader. The SDP and ICE exchange goes through the server's `/signal` route, which only relays messages. Without a valid ticket, nothing is delivered.
4. If the leader leaves, the host role passes to another player chosen by Game. If the old tab is still open (vote or hand-over), it sends its match core snapshot to the new host through `/signal` (`src/p2p/handoff.ts`); otherwise the new host starts a fresh core.

Each guest has two data channels: `state` (unordered, no retransmit: position, actions, HP, ping) and `rel` (ordered, reliable: registration, hits, grenades, drops, radio, mission and object events).

The host runs only the match datagrams. Respawn, death, round end, match end, score, EXP and gold stay on Game. Bomb Mission: Game owns the 42 s C4 fuse and resends the time left every second (a web addition, not in the original protocol), so late joiners and spectators get the planted bomb. Sabotage and Defence: objective hits go to the host, which reports the objectives' HP to Game; Game sends the bars to every player.

Without TURN configured, only public STUN is used. Players behind a strict NAT may not connect. See `TURN_URLS` in `server/.env.example`.
