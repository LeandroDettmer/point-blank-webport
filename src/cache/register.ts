// Registers public/sw.js (asset cache) and asks for persistent storage. Prod build with an asset store only: dev (vite
// :8000) and `vite preview` without VITE_ASSET_BASE never register it, so a dev session cannot be served a stale file.
import { startCacheGuard } from "./cacheProbe.ts";

const WARNED = "pb-cache-warned";

export function installAssetCache(): void {
  const base = import.meta.env.VITE_ASSET_BASE;
  if (!import.meta.env.PROD || !base || !("serviceWorker" in navigator)) return;
  const origin = new URL(base, location.href).origin;
  navigator.serviceWorker.register(`/sw.js?base=${encodeURIComponent(origin)}`).catch((e) => console.warn("[cache] service worker failed:", e));
  // persist(): Chrome decides alone; Firefox asks the player, so wait for the first click
  addEventListener("pointerdown", () => { void navigator.storage?.persist?.().catch(() => false); }, { once: true });
  let warned = false;
  try { warned = sessionStorage.getItem(WARNED) === "1"; } catch { /* storage blocked */ }
  if (warned) return;
  startCacheGuard((reasons) => {
    console.warn("[cache] browser does not keep the assets:", reasons.join(", "));
    try { sessionStorage.setItem(WARNED, "1"); } catch { /* storage blocked */ }
    void import("../game/cacheNotice.ts").then((m) => m.showCacheNotice(document.getElementById("app") ?? document.body));
  });
}
