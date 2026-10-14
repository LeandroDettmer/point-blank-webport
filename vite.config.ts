import { defineConfig, loadEnv, type Plugin } from "vite";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { assetResolver, cssUrls, type AssetMap } from "./src/assetMap.ts";

// PB_VITE_HMR=0 kills the dev-reload path completely: hmr:false stops the client from connecting to the HMR
// websocket, watch:null stops chokidar from invalidating the module graph. Set by scripts/dev-all.mjs --no-watch,
// so editing src/ leaves the running game alone (the supervisor's own fs.watch only ever covered server;
// vite reloads are a separate system and were unaffected by it). Manual reload = browser F5.
const noHmr = process.env.PB_VITE_HMR === "0";

/** `npm run build:prod`: dist gets the bundle and the small public
 *  files (the cursor) but not public/assets (4 GB, published to the R2 asset store by the deploy scripts),
 *  plus noindex + robots.txt (the assets are Zepetto's). */
function publicWithoutAssets(): Plugin {
  const pub = "public";
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
  });
  return {
    name: "pb-public-without-assets",
    apply: "build",
    generateBundle() {
      for (const e of readdirSync(pub, { withFileTypes: true })) {
        if (e.name === "assets") continue;
        for (const f of e.isDirectory() ? walk(join(pub, e.name)) : [join(pub, e.name)]) {
          this.emitFile({ type: "asset", fileName: relative(pub, f).split("\\").join("/"), source: readFileSync(f) });
        }
      }
      this.emitFile({ type: "asset", fileName: "robots.txt", source: "User-agent: *\nDisallow: /\n" });
    },
    transformIndexHtml: (html) => html.replace("<head>", '<head>\n    <meta name="robots" content="noindex, nofollow" />'),
  };
}

/** Build-time half of src/assetMap.ts (port of the reference port with VITE_ASSET_BASE,
 *  index.html preloads the asset map (src/assetBoot.ts awaits it before the app runs: fetch it alongside the bundle,
 *  same mode + credentials as loadAssetMap's fetch so the browser reuses the preload); with PB_ASSET_MAP_FILE (local
 *  copy of that map) too, its src="/assets/..." / url(/assets/...) point straight at the hashed files. Everything the
 *  code builds at run time goes through the runtime hooks (src/assetBoot.ts). */
function hashedAssets(): Plugin {
  const base = process.env.VITE_ASSET_BASE, file = process.env.PB_ASSET_MAP_FILE;
  if (!base) return { name: "pb-hashed-assets" };
  const resolve = file ? assetResolver(base, JSON.parse(readFileSync(file, "utf8")) as AssetMap, "http://page.invalid/") : (u: string) => u;
  const local = (u: string) => (u.startsWith("/") ? resolve(u) : u);
  const map = `${base.replace(/\/+$/, "")}/${process.env.VITE_ASSET_MAP || "asset-map.json"}`;
  return {
    name: "pb-hashed-assets",
    apply: "build",
    transformIndexHtml: (html) => cssUrls(html, local)
      .replace("<head>", `<head>\n    <link rel="preload" as="fetch" crossorigin href="${map}">`)
      .replace(/\b(src|href)="(\/[^"]+)"/g, (m, a: string, u: string) => { const to = resolve(u); return to === u ? m : `${a}="${to}"`; }),
  };
}

/**a VITE_* value lands in the public bundle (import.meta.env), so a static TURN credential must never be
 *  one. The client no longer reads VITE_TURN_* (src/p2p/ice.ts: TURN only comes from /signal); a build that still sets them fails. */
function noStaticTurn(): Plugin {
  return {
    name: "pb-no-static-turn",
    apply: "build",
    configResolved(c) {
      const set = Object.keys(loadEnv(c.mode, c.envDir || c.root, "VITE_TURN_"));
      if (set.length) throw new Error(`vite build: ${set.join(", ")} would put a TURN credential in the public bundle; set TURN on server (TURN_* / CF_TURN_*) instead`);
    },
  };
}

export default defineConfig(({ mode }) => ({
  root: ".",
  publicDir: mode === "prod" ? false : "public",
  plugins: mode === "prod" ? [noStaticTurn(), publicWithoutAssets(), hashedAssets()] : [noStaticTurn(), hashedAssets()],
  server: {
    host: "0.0.0.0",
    port: 8000,
    strictPort: false,
    ...(noHmr ? { hmr: false, watch: null } : {}),
  },
  // es2022: src/assetBoot.ts awaits the asset map at the top level. assetsDir: the bundle must stay out of /assets/,
  // the tree the asset map sends to the asset store
  // manualChunks: three and rapier (compat: wasm inlined as base64, 2 MB) change only on a dependency bump, so they get
  // their own hashed files and stay cached across deploys (app code in index/main re-hashes on every deploy). Same
  // rapier3d-compat 0.14 as before: the KCC/movement is unchanged. Rapier is still only imported by main.ts (the game chunk).
  build: {
    target: "es2022",
    assetsDir: "bundle",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/three/")) return "vendor-three";
          if (id.includes("/node_modules/@dimforge/rapier3d-compat/")) return "vendor-rapier";
        },
      },
    },
  },
  optimizeDeps: {
    exclude: ["@dimforge/rapier3d-compat"],
  },
}));
