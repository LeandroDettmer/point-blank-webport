// Supervises the dev stack for local dev: npm run dev:all (from the repo root).
// Also handles `npm run status` via --status.
//
// - Step 0 starts Postgres via docker compose (idempotent `up -d`) and waits until pg_isready (TCP, inside the container) answers.
// - Before starting the node services, checks each port; if it's held by a stale dev process
//   (its cwd or command line points into this repo) it kills that process tree, otherwise it aborts.
// - server runs `node src/main.ts` directly (Auth 39290 + Game 39291-39293 + web front 8090 with
//   ws /tcp /signal and http /api, one process, five ports): this supervisor restarts it on crash and watches server/src and server/runtime/Config
//   with fs.watch to restart on change (main.ts only reads config at boot).
// - vite runs plain and relies on its own HMR.
// - Ctrl+C kills every process tree it started.
// - `--no-watch` starts the same stack with the dev-reload path off: no fs.watch (src changes no longer restart
//   server) and PB_VITE_HMR=0, which makes vite.config.ts set hmr:false + watch:null so editing src/
//   does not full-reload the browser either. Restart-on-crash stays on. Reload = F5 / re-run.
import { execFileSync, spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  belongsToRepo, color, cwdOf, ensurePortFree, killTree, pidOnPort, prefixedPipe,
} from './lib/procs.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptsDir, '..');
const repoKey = root.replace(/\\/g, '/').toLowerCase();
const dbDir = resolve(root, 'db');
const serverDir = resolve(root, 'server');

const POSTGRES_PORT = 5433;

const SERVICES = [
  {
    name: 'server', ports: [8090, 39290, 39291, 39292, 39293], cwd: serverDir,
    cmd: process.execPath, args: ['src/main.ts'], restart: true,
    watchDirs: [resolve(serverDir, 'src'), resolve(serverDir, 'runtime/Config')],
  },
  {
    name: 'vite', ports: [8000], cwd: root,
    cmd: process.execPath, args: [resolve(root, 'node_modules/vite/bin/vite.js')],
    restart: false,
  },
];

function tscBin(dir) {
  return resolve(dir, 'node_modules/typescript/bin/tsc');
}

async function statusCmd() {
  console.log('port   service    pid    command');
  const pgPid = pidOnPort(POSTGRES_PORT);
  console.log(`${String(POSTGRES_PORT).padEnd(6)} ${'postgres'.padEnd(10)} ${pgPid === null ? '-      (free)' : `${String(pgPid).padEnd(6)} docker`}`);
  for (const s of SERVICES) {
    for (const port of s.ports) {
      const pid = pidOnPort(port);
      if (pid === null) { console.log(`${String(port).padEnd(6)} ${s.name.padEnd(10)} -      (free)`); continue; }
      const inRepo = belongsToRepo(pid, repoKey);
      const desc = `cwd: ${cwdOf(pid) || '?'}`;
      console.log(`${String(port).padEnd(6)} ${s.name.padEnd(10)} ${String(pid).padEnd(6)} ${inRepo ? desc : `${desc}  [NOT this repo]`}`);
    }
  }
}

// The published port accepts TCP before postgres does: on the first start (empty volume) initdb runs a server that listens
// on the socket only, so a TCP connect to 5433 gets "Connection terminated unexpectedly". Ask postgres inside the container over TCP.
function pgReady() {
  try {
    execFileSync('docker', ['compose', '-p', 'pbwebport', '-f', 'docker-compose.yml', 'exec', '-T', 'postgres', 'pg_isready', '-h', '127.0.0.1', '-U', process.env.PB_DB_USER || 'postgres', '-d', process.env.PB_DB_NAME || 'pb'], { cwd: dbDir, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

async function waitPgReady(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (!pgReady()) {
    if (Date.now() > deadline) throw new Error(`postgres not ready after ${timeoutMs / 1000}s (see: docker compose -p pbwebport logs postgres)`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function startPostgres() {
  console.log(color('sup', '[sup] starting postgres (docker compose -p pbwebport up -d postgres)...'));
  try {
    execFileSync('docker', ['compose', '-p', 'pbwebport', '-f', 'docker-compose.yml', 'up', '-d', 'postgres'], {
      cwd: dbDir, stdio: 'inherit',
    });
  } catch (e) {
    console.error(color('sup', `[sup] docker compose failed: ${e.message}`));
    console.error(color('sup', '[sup] is Docker Desktop running?'));
    process.exit(1);
  }
  console.log(color('sup', `[sup] waiting for postgres on :${POSTGRES_PORT} (pg_isready in the container)...`));
  try {
    await waitPgReady();
  } catch (e) {
    console.error(color('sup', `[sup] ${e.message}`));
    process.exit(1);
  }
  console.log(color('sup', '[sup] postgres up'));
}

function startService(svc) {
  const child = spawn(svc.cmd, svc.args, { cwd: svc.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  prefixedPipe(child.stdout, svc.name, process.stdout);
  prefixedPipe(child.stderr, svc.name, process.stderr);
  return child;
}

async function main() {
  if (process.argv.includes('--status')) return statusCmd();

  const noWatch = process.argv.includes('--no-watch');
  // vite reloads through its own watcher + HMR websocket, NOT through the fs.watch below (which only ever covered
  // server). Without this, --no-watch still full-reloaded the browser on every src/ edit.
  // vite.config.ts reads it: hmr:false + watch:null.
  if (noWatch) process.env.PB_VITE_HMR = '0';
  // local stack only: opens the F2 test menu (5199) and the early leader TIMERSYNC 0; prod never sets it
  process.env.PB_DEV_OPS ??= '1';

  await startPostgres();

  for (const svc of SERVICES) for (const port of svc.ports) await ensurePortFree(svc.name, port, repoKey);

  console.log(color('sup', '[sup] starting dev services...'));
  console.log(color('sup', '[sup]   game:     http://localhost:8000/'));
  console.log(color('sup', '[sup]   web:      ws://localhost:8090/  (/tcp /signal, http /api)'));
  console.log(color('sup', '[sup]   auth ws:  :39290   game ws: :39291-39293   postgres: :5433'));
  if (noWatch) console.log(color('sup', '[sup] --no-watch: editing src/ will NOT reload anything (no vite HMR, no service restart). Reload = F5.'));

  let shuttingDown = false;
  const procs = new Map();
  const state = new Map(); // name -> { intentionalRestart }

  function launch(svc, attempt = 0) {
    if (shuttingDown) return;
    if (svc.build) {
      try {
        execFileSync(process.execPath, [tscBin(svc.cwd), '-p', '.'], { cwd: svc.cwd, stdio: 'inherit' });
      } catch {
        console.error(color('sup', `[sup] ${svc.name} build failed`));
        if (!svc.restart) return;
        const delay = Math.min(3000, 300 * 2 ** Math.min(attempt, 4));
        setTimeout(() => launch(svc, attempt + 1), delay);
        return;
      }
    }
    const child = startService(svc);
    procs.set(svc.name, child);
    state.set(svc.name, { intentionalRestart: false });
    child.on('exit', (code, signal) => {
      if (shuttingDown) return;
      const st = state.get(svc.name);
      if (st.intentionalRestart) {
        console.log(color('sup', `[sup] ${svc.name} restarting (src change)`));
        launch(svc, 0);
        return;
      }
      console.log(color('sup', `[sup] ${svc.name} exited (code=${code} signal=${signal})`));
      if (!svc.restart) return;
      const delay = Math.min(3000, 300 * 2 ** Math.min(attempt, 4));
      setTimeout(() => launch(svc, attempt + 1), delay);
    });
  }

  for (const svc of SERVICES) {
    launch(svc);
    if (noWatch) continue;
    for (const dir of svc.watchDirs ?? []) {
      let timer = null;
      watch(dir, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const child = procs.get(svc.name);
          const st = state.get(svc.name);
          if (!child || !st || child.exitCode !== null) return;
          st.intentionalRestart = true;
          killTree(child.pid);
        }, 200);
      });
    }
  }

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(color('sup', '\n[sup] shutting down...'));
    for (const child of procs.values()) if (child.pid) killTree(child.pid);
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
