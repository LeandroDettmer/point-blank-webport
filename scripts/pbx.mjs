#!/usr/bin/env node
// Runs the asset CLI from the external pb-extract-tools repo. Exists only so npm scripts work on Windows (no ${VAR:-default}).
// Default checkout: sibling folder ../pb-extract-tools (next to this repo). PB_TOOLS overrides it.
// Points the CLI at this checkout's clients, assets and src unless the environment already sets them.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const inherited = process['env'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const REPO = WEB; // the client and the repo are one folder now
const TOOLS = path.resolve(inherited.PB_TOOLS ?? path.join(REPO, '../pb-extract-tools'));
const vars = {
  PB_CLIENTS: path.join(REPO, 'Clients'),
  PB_ASSETS: path.join(WEB, 'public/assets'),
  PB_WEB: WEB,
  PB_SERVER: REPO,
  PB_EXTRACTED: path.join(WEB, 'extracted'),
  PB_SNAPSHOTS: path.join(REPO, '.asset-snapshots'),
  ...inherited,
};
const r = spawnSync(process.execPath, [path.join(TOOLS, 'pbx.mjs'), ...process.argv.slice(2)], { stdio: 'inherit', env: vars });
if (r.error) { console.error(`pbx: cannot run ${TOOLS} (set PB_TOOLS): ${r.error.message}`); process.exit(1); }
process.exit(r.status ?? 1);
