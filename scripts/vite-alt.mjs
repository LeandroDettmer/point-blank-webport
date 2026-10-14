// A second vite for the game on another port (default 8001), with no reload (PB_VITE_HMR=0: no HMR socket, no file
// watch; refresh by hand with F5). It uses the server / Postgres the main stack (dev:all) already runs; the
// server web front allows the 8000 and 8001 origins (server/src/web/webServer.ts isAllowedOrigin).
//   npm run dev:alt            -> http://localhost:8001/
//   npm run dev:alt -- 8002    -> another port
import { spawn } from 'node:child_process';
const port = process.argv[2] ?? '8001';
spawn('npx', ['vite', '--port', port, '--strictPort'], {
  stdio: 'inherit', shell: true, env: { ...process.env, PB_VITE_HMR: '0' },
}).on('exit', (code) => process.exit(code ?? 0));
