// Static game assets served from another origin under content-hashed names (Cloudflare R2 behind a Worker,
//; port of the reference port The code keeps asking for the logical
// same-origin paths it always used ('/assets/maps/nstation/visual.glb'); with an asset base configured, the fetch /
// XHR hooks here (and the DOM ones in assetBoot.ts) turn such a URL into '<base>/<dir>/<stem>.<hash8><.ext>' through
// the asset map of the deploy scripts. No base (dev, Node tests): nothing is installed, every URL stays as it is.
//
// Map format: { v: 1, dirs: {: {: "<hash8>" | "<published file name>" } } }, <dir> being the
// logical path without the leading '/'. A bare hash means '<stem>.<hash8><.ext>' in the
// same dir; a value with a dot is the whole published name. Only the /assets/ tree is remapped (the cursor and
// the bundle stay on the page's origin).

export interface AssetMap { v: 1; dirs: Record<string, Record<string, string>> }

/** the same-origin tree that lives in the asset store */
const TREE = /^assets\//;

/** Resolver from logical URLs to the asset store. `page`: the URL relative paths resolve against (whose origin
 * counts as). URLs outside the tree come back unchanged; a tree file the map does not have (a probe
 *  for an optional file, assetProbe.ts) goes to the store unhashed: the same 404, and the page's origin never sees it.
 *  The dev server on Windows answers paths in any case, so a miss retries case-insensitively. */
export function assetResolver(base: string, map: AssetMap, page: string): ((url: string) => string) & { has: (url: string) => boolean } {
  const root = base.replace(/\/+$/, "");
  const origin = new URL(page).origin;
  let folded: Map<string, string> | null = null;
  const published = (dir: string, name: string, v: string): string => {
    if (v.includes(".")) return `${dir}/${v}`;
    const e = name.lastIndexOf(".");
    return e > 0 ? `${dir}/${name.slice(0, e)}.${v}${name.slice(e)}` : `${dir}/${name}.${v}`;
  };
  const lookup = (p: string): string | null => {
    const i = p.lastIndexOf("/");
    const dir = p.slice(0, i), name = p.slice(i + 1);
    const v = map.dirs[dir]?.[name];
    if (v) return published(dir, name, v);
    if (!folded) {
      folded = new Map();
      for (const [d, names] of Object.entries(map.dirs)) for (const [n, h] of Object.entries(names)) folded.set(`${d}/${n}`.toLowerCase(), published(d, n, h));
    }
    return folded.get(p.toLowerCase()) ?? null;
  };
  const resolve = (url: string): string => {
    if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url;
    let u: URL;
    try { u = new URL(url, page); } catch { return url; }
    if (u.origin !== origin) return url;
    let p: string;
    try { p = decodeURIComponent(u.pathname.slice(1)); } catch { return url; }
    if (!TREE.test(p)) return url;
    const hit = lookup(p) ?? p;
    return `${root}/${hit.split("/").map(encodeURIComponent).join("/")}`;
  };
  /** false only for a tree file the map does not list (it does not exist in the store) */
  const has = (url: string): boolean => {
    try {
      const p = decodeURIComponent(new URL(url, page).pathname.slice(1));
      return !TREE.test(p) || lookup(p) !== null;
    } catch { return true; }
  };
  return Object.assign(resolve, { has });
}

/** url(...) in CSS text: double-quoted, single-quoted (a path may hold parentheses) or bare */
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'"()\s]+))\s*\)/g;
/** every url(...) of `css` through `resolve`; a changed one is written double-quoted (a resolved store URL has its
 *  segments percent-encoded, so no '"' in it) */
export const cssUrls = (css: string, resolve: (url: string) => string): string => (css.includes("url(")
  ? css.replace(CSS_URL, (m, dq?: string, sq?: string, bare?: string) => {
    const u = (dq ?? sq ?? bare ?? "").trim();
    const to = resolve(u);
    return to === u ? m : `url("${to}")`;
  })
  : css);

let resolver: ReturnType<typeof assetResolver> | null = null;

/** logical URL -> asset store URL (unchanged when no asset base is configured) */
export const assetUrl = (url: string): string => (resolver ? resolver(url) : url);

/** Does the file exist? Only the prod asset map knows; without it (dev, tests) every URL counts as present. */
export const assetKnown = (url: string): boolean => (resolver ? resolver.has(url) : true);

export function configureAssets(base: string, map: AssetMap): void {
  resolver = assetResolver(base, map, self.location.href);
}

/** Fetch `<base>/<mapName>` and configure the resolver. Failure is logged: the URLs then stay same-origin. */
export async function loadAssetMap(base: string, mapName: string, get: typeof fetch = fetch): Promise<void> {
  const url = `${base.replace(/\/+$/, "")}/${mapName || "asset-map.json"}`;
  try {
    const r = await get(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    configureAssets(base, (await r.json()) as AssetMap);
  } catch (e) {
    console.error(`[assets] asset map ${url} failed to load (${String(e)}): assets stay on this origin`);
  }
}

/** fetch() and XMLHttpRequest.open() go through assetUrl; fetches made before `ready` wait for it */
export function installFetchHooks(ready: Promise<unknown> = Promise.resolve()): void {
  const orig = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    await ready;
    if (typeof input === "string" || input instanceof URL) return orig(assetUrl(String(input)), init);
    const to = assetUrl(input.url);
    return orig(to === input.url ? input : new Request(to, input), init);
  };
  if (typeof XMLHttpRequest === "undefined") return;
  const open = XMLHttpRequest.prototype.open as (this: XMLHttpRequest, ...a: unknown[]) => void;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    open.call(this, method, assetUrl(String(url)), ...rest);
  } as typeof XMLHttpRequest.prototype.open;
}
