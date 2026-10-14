// Runs the game's .ts sources under plain node (no vite): re-execs with --experimental-transform-types (NavGraph uses
// parameter properties) and resolves the extensionless relative imports the sources use for vite.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (!process.execArgv.includes('--experimental-transform-types')) {
  const r = spawnSync(process.execPath, ['--experimental-transform-types', ...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('.') && ctx.parentURL && !/\.\w+$/.test(spec)) {
      const f = new URL(spec + '.ts', ctx.parentURL);
      if (existsSync(fileURLToPath(f))) return next(f.href, ctx);
    }
    return next(spec, ctx);
  },
});
