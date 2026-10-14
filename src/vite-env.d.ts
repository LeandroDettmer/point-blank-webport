/// <reference types="vite/client" />

/** Production build env; all unset in dev, where the defaults point at this host. */
interface ImportMetaEnv {
  /** server web front as wss origin (wss://<service>.run.app): /tcp and /signal (src/net/connection.ts) */
  readonly VITE_GW_URL?: string;
  /** server web front as https origin: /api/register, /api/login (src/net/accountApi.ts) */
  readonly VITE_API_URL?: string;
  /** asset store origin (the R2 Worker) the /assets/ tree is served from (src/assetBoot.ts) */
  readonly VITE_ASSET_BASE?: string;
  /** asset map file name under VITE_ASSET_BASE (asset-map.<hash8>.json; default asset-map.json) */
  readonly VITE_ASSET_MAP?: string;
}
