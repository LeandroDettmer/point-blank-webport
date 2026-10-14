# Point Blank web port

Read this in Portuguese: [README.pt-BR.md](README.pt-BR.md).

A web port of Point Blank (the Point Blank Cross client) for the browser. The client is TypeScript + Vite + three.js + Rapier. The server (`server`) speaks the original binary protocol and uses Postgres. Matches run peer-to-peer (WebRTC). The server handles login, lobby, rooms, items and progression.

> **Legal notice.** This repository contains only our code: client, server, database schema and scripts. It has no assets, no executable and no extracted game data. The code of this project is licensed under the [MIT License](LICENSE).
>
> **Point Blank, its assets, its network protocol and its game data belong to Zepetto and are not covered by the MIT license.** This also applies to `server/runtime/Config/` and `server/runtime/Data/`, which contain game data kept as is.
>
> Use the project with a client you have the right to use. Do not publish extracted assets. This project is not affiliated with or endorsed by Zepetto.

## Requirements

| Item | Notes |
|---|---|
| Node.js 22.18 or newer | The server runs `.ts` files directly (type stripping). Tested with Node 24. |
| npm | Comes with Node. |
| Git | To clone the two repositories. |
| Docker | Docker Desktop (Windows/macOS) or Docker Engine. Runs Postgres 16 on `127.0.0.1:5433`. Must be running before `dev:all`. |
| Point Blank Cross client | A folder named `PBCross`, with `PointBlank.exe` and `Pack/`. You need your own copy of the client. |
| Python 3 + `capstone` | Only for the reverse-engineering tools in `pb-extract-tools`. Not needed to play. |

ffmpeg comes with `npm install` (the `ffmpeg-static` package). Do not install it separately.

## Folder layout

You need two folders side by side:

```
projects-folder/
├── point-blank-webport/     this repository
│   └── Clients/PBCross/     your client (created by you, git-ignored)
└── pb-extract-tools/        asset exporter (another repository)
```

Steps 1 and 2 run in `projects-folder/`. From step 3 on, the current directory is `point-blank-webport/`.

## Step by step, from scratch

**1. Clone both repositories**

```sh
git clone <url of this repository> point-blank-webport
git clone https://github.com/LeandroDettmer/pb-extract-tools-public pb-extract-tools
```

**2. Install the dependencies**

```sh
cd point-blank-webport
npm install
npm --prefix server install
npm --prefix ../pb-extract-tools install
```

**3. Place the client**

Copy your Point Blank Cross installation to `point-blank-webport/Clients/PBCross/`. The file `Clients/PBCross/PointBlank.exe` must exist. The folder name must be exactly `PBCross`. If the client is somewhere else, point the `PB_CLIENTS` variable to it (the folder that contains `PBCross`).

**4. Check the environment**

```sh
npm run pbx -- doctor
```

Shows Node, dependencies, ffmpeg, the client found, and which command groups can run. Check that Point Blank Cross shows as found.

**5. Generate the assets**

```sh
npm run pbx -- export all --client cross --dry-run   # lists the steps and writes nothing
npm run pbx -- export all --client cross             # runs the steps in order
npm run assets:ogg                  # OGG versions of the WAV sounds
```

- Time and size: the export takes hours and several GB. We have not measured the exact time. It depends on your machine and the client.
- Output: `public/assets/` and `extracted/`. Both are git-ignored. The client is only read, never modified.
- Steps that need a missing client are skipped and listed in the summary.
- If a step fails, `pbx` shows its name. Fix the cause and resume with `npm run pbx -- export all --client cross --from <step>`.
- Full help: `npm run pbx -- help`. Exporter documentation: the README of `pb-extract-tools`.

**6. Configure the server (optional)**

The defaults already work with the Docker setup in the next step. To change something, copy the template and edit it:

```sh
cp server/.env.example server/.env.local
```

The [Environment variables](#environment-variables) section explains each one.

**7. Start the stack**

```sh
npm run dev:all
```

The command:

- starts Postgres with Docker (`db/docker-compose.yml`). If the volume does not exist yet (first start), the database is created from `db/init/001_init.sql`: schema and game data, no accounts;
- starts the server (ports 39290, 39291-39293 and 8090);
- starts Vite (port 8000).

The server restarts by itself when `server/src` or `server/runtime/Config` changes. `Ctrl+C` stops everything. `npm run dev:all:nowatch` turns off this watching. `npm run status` shows which ports are in use.

**8. Enter the game**

1. Open http://localhost:8000.
2. Create an account on the game's registration screen. Or through the API:

   ```sh
   curl -X POST http://localhost:8090/api/register -H "content-type: application/json" -d '{"username":"player1","password":"secret1"}'
   curl -X POST http://localhost:8090/api/login    -H "content-type: application/json" -d '{"username":"player1","password":"secret1"}'
   ```

3. Username: 4 to 16 characters (letters, numbers and `_`). Password: 6 to 64 characters.
4. Create a room in bot mode (room with AI) and play against the bots.

The database starts with no accounts. There is no ready-made test user: the first account is the one you create.

**Resetting the database.** `db/init/001_init.sql` only runs when the volume `pbwebport_pb-postgres-data` (or the volume of the project name you use) is empty. To start from scratch, stop the server and remove the volume:

```sh
cd db
docker compose -p pbwebport down -v   # deletes the volume: accounts, characters and progress
cd ..
npm run dev:all                    # recreates the database from db/init/001_init.sql
```

If you started the compose file with another project name (`-p`), use the same name in `down -v`. `docker volume ls` lists the volumes.

## Environment variables

The server reads `server/.env.local` (if it exists) and then the environment variables. An environment variable wins over the file. All of them are optional. The full list with comments is in `server/.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `PB_DB_HOST` | `127.0.0.1` | Postgres host. |
| `PB_DB_PORT` | `5433` | Postgres port. Must match the port published by Docker. |
| `PB_DB_NAME` | `pb` | Database name. |
| `PB_DB_USER` / `PB_DB_PASS` | `postgres` / `postgres` | User and password. For local use only. |
| `PB_DB_URL` | empty | Full URL (`postgres://user:password@host:port/database`). Replaces host, port, name, user and password. |
| `PB_DB_SSL` / `PB_DB_SSL_STRICT` | `0` / `0` | `1` turns on TLS to Postgres (hosted databases). `PB_DB_SSL_STRICT=1` also checks the certificate. |
| `PB_WEB_PORT` | `8090` | Port of the web front (`/tcp`, `/signal`, `/api`, `/health`). |
| `PB_ADVERTISE_HOST` | empty | Host that the server list sends to the client. Empty uses the database host (`127.0.0.1`). Set your LAN IP if another machine will play. |
| `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` | empty | TURN server for P2P matches behind a strict NAT. Without it, the project uses only public STUN. |

To change the Postgres port, change it in both places: `PB_DB_PORT` in the Docker environment (`dev:all` runs the compose file from `db/`, so use a `db/.env` file or a shell variable) and `PB_DB_PORT` in `server/.env.local`.

Development variables used by the scripts (you do not need to set them):

- `PB_TOOLS`: path to `pb-extract-tools`. Default: the sibling folder `../pb-extract-tools`.
- `PB_CLIENTS`: folder that contains `PBCross`. Default: `Clients/` at the root of the repository.

## Common problems

- **Port in use** (8000, 8090, 39290-39293 or 5433). Run `npm run status` to see who uses it. `dev:all` stops old processes of this repository. If the port belongs to another program, it stops and warns you: close that program or change the port.
- **`docker compose failed`**. Docker is not running. Open Docker Desktop, wait for it to start, and run `npm run dev:all` again.
- **Postgres does not start on 5433** because another database uses the port. Change `PB_DB_PORT` (see above).
- **`pbx doctor` does not find Point Blank Cross**. The folder has another name or is outside `Clients/`. Rename it to `PBCross` or set `PB_CLIENTS`.
- **The game opens with empty screens or 404 files**. An export step failed or was skipped. Check the `pbx` summary and run again with `--from`.
- **`ffmpeg` missing or `ffmpeg-static` without a binary**. The package downloads the binary during `npm install`. If the download failed (network or proxy), run `npm install` again.
- **`ERR_UNKNOWN_FILE_EXTENSION` with `.ts`**. Your Node is older than 22.18. Update it.
- **`node-datachannel` fails to install**. It is a native module, used by the P2P tests. Check your Node version and the system build tools.

## Tests

```sh
npm run typecheck            # client types
npm --prefix server run typecheck  # server types
npm --prefix server test           # server tests (some need Postgres running)
npm run test:net             # client protocol tests
npm run test:p2p             # P2P match with a real server (starts test servers)
```

The smoke scripts in `scripts/dev/` and `src/**/dev/` import client code. Some of them need the generated assets.

## Repository layout

| Path | What it is |
|---|---|
| `package.json`, `index.html`, `vite.config.ts`, `tsconfig.json` | client: dependencies, scripts (`dev:all`, `pbx`, `status`, `test:net`) and build |
| `src/` | client: game, weapons, lobby, HUD, network, P2P host |
| `public/` | static files of the client. `public/assets/` is generated by `pbx` (git-ignored) |
| `scripts/` | `dev-all.mjs` (supervisor), `pbx.mjs` (starts the exporter), smoke scripts |
| `server/` | server (its own project): `src/` (Auth and Game TCP, WebSocket web front and `/api`, Postgres), `test/`, `tools/`, `package.json` |
| `server/runtime/` | configuration and data the server reads (`Config/`, `Data/`). Game data, see the legal notice |
| `server/.env.example` | template of the server environment variables |
| `db/` | `docker-compose.yml` (Postgres only) and `init/001_init.sql` (schema and game data, created on the first start of the volume) |
| `docs/ARCHITECTURE.md` | overview: client, server, database and P2P |

## Ports

| Port | What it is |
|---|---|
| 8000 | game (Vite, in development) |
| 8090 | web front: `/tcp` and `/signal` (WebSocket), `/api/register`, `/api/login`, `/health` (HTTP) |
| 39290 | Auth (client TCP protocol) |
| 39291-39293 | Game, one per channel (TCP) |
| 5433 | Postgres (Docker, `127.0.0.1` only) |

## License

The code of this project: MIT, see [LICENSE](LICENSE). Point Blank, its assets, protocol and game data: Zepetto, outside the MIT license (see the notice at the top).
