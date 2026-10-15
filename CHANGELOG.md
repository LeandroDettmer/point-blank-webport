# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-14

First public release: the browser client and the TypeScript server, running from a clean clone with your own Point Blank Cross client for the assets.

### Added

- Browser client (TypeScript, Vite, three.js, Rapier) with the lobby, room, shop, profile and battle screens on the Point Blank Cross base.
- TypeScript server in `server/`: auth and game servers, WebSocket front, account API and WebRTC signalling for peer-to-peer battles.
- Peer-to-peer battle core (host match logic and the 2-peer, failover, hand-off and bot tests).
- PostgreSQL schema and game/system data in `db/init/001_init.sql`, with `db/docker-compose.yml` to start it. No accounts and no seed data are included.
- Match data read by the asset tools (`server/runtime/Data/Match`: character health, item statistics, map structure).
- `docs/ARCHITECTURE.md`, an English `README.md` and a Portuguese `README.pt-BR.md`.
- `CLAUDE.md` with the rules for people and coding assistants working on the code.
- MIT license.

### Changed

- `npm run dev:all` waits for Postgres to accept connections (`pg_isready`) before it starts the server, so a clean first start works.
- The README covers getting the client, the other Point Blank clients, export time and disk use.

### Fixed

- Dev and preview servers answer 404 for a missing `/assets` file instead of the SPA page.
- Lobby showroom plays `UI_IdleA` when a weapon has no `UI_Idle_Stand`, so male characters no longer show the female idle pose.

### Notes

- Game assets are not in the repository. Generate them from your own Point Blank Cross client with [pb-extract-tools-public](https://github.com/LeandroDettmer/pb-extract-tools-public).
- Game assets, protocol and data belong to Zepetto. The code is MIT; the game content is not.
