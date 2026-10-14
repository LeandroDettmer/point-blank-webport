// First import of the entry point (boot.ts). With VITE_ASSET_BASE (a production build whose /assets/ tree lives on
// Cloudflare R2,: load the asset map and hook every URL sink before any other module
// asks for a file, so no call site has to know (port of the reference port
//  - fetch() / XMLHttpRequest: JSON, glb, wav for WebAudio, three's FileLoader / ImageBitmapLoader (GLTFLoader,
//    AudioLoader). GLTFLoader resolves a glb's external files against the logical URL, so they get remapped too;
//  - <img>.src: three's ImageLoader / TextureLoader, new Image(), DOM icons. No crossOrigin is added: three's loaders
//    set their own, the 2D canvases (HUD, scope) only draw, never read pixels back;
//  - <audio>.src and new Audio(url);
//  - src= / href= / url() in markup (innerHTML, outerHTML, insertAdjacentHTML);
//  - url(...) in CSS text: el.style.<prop> = / el.style.cssText = (through a Proxy of the declaration),
//    style.setProperty, el.style = '...', and <style>.textContent (the lobby's @font-face).
// index.html is rewritten at build time instead (vite.config.ts hashedAssets). Without VITE_ASSET_BASE (dev, the
// Node tests never load this file): nothing is installed.
import { assetUrl, cssUrls, installFetchHooks, loadAssetMap } from "./assetMap.ts";

const assetCss = (css: string): string => cssUrls(css, assetUrl);

const HTML_SRC = /\b(src|href)=(["'])(\/[^"']*)\2/g;
const assetHtml = (html: string): string => assetCss(html.includes("src=") || html.includes("href=")
  ? html.replace(HTML_SRC, (m, a: string, q: string, u: string) => { const to = assetUrl(u); return to === u ? m : `${a}=${q}${to}${q}`; })
  : html);

function wrapSetter<T extends object>(proto: T, prop: string, map: (this: T, v: string) => string): void {
  for (let p: object | null = proto; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, prop);
    if (!d) continue;
    if (!d.set || !d.get) return;
    const { get, set } = d;
    Object.defineProperty(proto, prop, {
      configurable: true, enumerable: d.enumerable,
      get() { return get.call(this); },
      set(v: unknown) { set.call(this, typeof v === "string" ? map.call(this as T, v) : v); },
    });
    return;
  }
}

function installDomHooks(): void {
  wrapSetter(HTMLImageElement.prototype, "src", assetUrl);
  wrapSetter(HTMLMediaElement.prototype, "src", assetUrl);
  const A = window.Audio;
  window.Audio = new Proxy(A, { construct: (t, a: unknown[]) => (typeof a[0] === "string" ? new t(assetUrl(a[0])) : new t()) });

  const style = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "style")!;
  const proxies = new WeakMap<CSSStyleDeclaration, CSSStyleDeclaration>();
  const proxyOf = (s: CSSStyleDeclaration): CSSStyleDeclaration => {
    const fns = new Map<PropertyKey, unknown>();
    return new Proxy(s, {
      // methods called on the proxy need the real declaration as `this`
      get(t, k) {
        const v: unknown = Reflect.get(t, k, t);
        if (typeof v !== "function") return v;
        let f = fns.get(k);
        if (!f) fns.set(k, (f = v.bind(t)));
        return f;
      },
      set: (t, k, v: unknown) => Reflect.set(t, k, typeof v === "string" && v.includes("url(") ? assetCss(v) : v, t),
    });
  };
  Object.defineProperty(HTMLElement.prototype, "style", {
    configurable: true, enumerable: style.enumerable,
    get(this: HTMLElement) {
      const s = style.get!.call(this) as CSSStyleDeclaration;
      let p = proxies.get(s);
      if (!p) proxies.set(s, (p = proxyOf(s)));
      return p;
    },
    set(this: HTMLElement, v: unknown) { style.set!.call(this, typeof v === "string" ? assetCss(v) : v); },
  });
  const setProperty = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function (this: CSSStyleDeclaration, name: string, value: string | null, priority?: string) {
    setProperty.call(this, name, typeof value === "string" ? assetCss(value) : value, priority);
  };
  for (const k of ["innerHTML", "outerHTML"]) wrapSetter(Element.prototype, k, assetHtml);
  const adjacent = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function (this: Element, where: InsertPosition, html: string) { adjacent.call(this, where, assetHtml(html)); };
  const text = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")!;
  Object.defineProperty(HTMLStyleElement.prototype, "textContent", {
    configurable: true,
    get() { return text.get!.call(this); },
    set(v: string | null) { text.set!.call(this, typeof v === "string" ? assetCss(v) : v); },
  });
}

const base = import.meta.env.VITE_ASSET_BASE;
if (base) {
  const ready = loadAssetMap(base, import.meta.env.VITE_ASSET_MAP ?? "", fetch.bind(globalThis));
  installFetchHooks(ready);
  installDomHooks();
  await ready;
}
