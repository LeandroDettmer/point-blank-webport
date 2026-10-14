// PT-BR strings for the exported UI.
//
// Source of truth: public/assets/ui/cross/strings.json, exported by pb-extract-tools export-classic-ui.mjs from
// Clients/PBCross String_Brazil.txt (STBL_IDX_KEY =, the client's real PT-BR translation table). The Cross windows get their
// texts by control name in their own tables (screensCross/app.ts CROSS_TEXT, the pages); everything else looks keys up here.
import { UI_BASE } from "./assets.ts";

export type StringsDict = Record<string, string>;

let dict: StringsDict | null = null;
let loading: Promise<StringsDict> | null = null;

/** Fetches public/assets/ui/cross/strings.json once. Call before the first t()/tOr() at boot. */
export function loadStrings(): Promise<StringsDict> {
  if (dict) return Promise.resolve(dict);
  if (!loading) {
    loading = fetch(`${UI_BASE}/cross/strings.json`)
      .then(res => { if (!res.ok) throw new Error(`cross/strings.json: HTTP ${res.status}`); return res.json() as Promise<StringsDict>; })
      .then(d => {
        // app rebrand: the client texts name the game "Point Blank"
        for (const k in d) if (typeof d[k] === "string") d[k] = d[k].replace(/Point Blank( Brasil)?/g, "Project Blackout");
        return (dict = d);
      });
  }
  return loading;
}

/** Synchronous lookup; returns the key itself (and warns once) if loadStrings() hasn't resolved yet or the key is missing. */
export function t(key: string): string {
  const v = dict?.[key];
  if (v === undefined) { console.warn(`[i18n] missing STBL key: ${key}`); return key; }
  return v;
}

/** Like t(), but returns `fallback` instead of the raw key when missing (e.g. the design-time caption). */
export function tOr(key: string, fallback: string): string {
  const v = dict?.[key];
  return v === undefined ? fallback : v;
}

/**
 * Builds a RenderOptions.texts map for LayoutRenderer from a control-name -> STBL key table, e.g.:
 *   texts(loadStrings.dict, { Btn_ClanMatch: "STBL_IDX_CLAN_MATCH_TITLE" })
 * Keys with no STBL entry are dropped (LayoutRenderer then falls back to the raw design caption).
 */
export function textsFor(keys: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, key] of Object.entries(keys)) {
    const v = dict?.[key];
    if (v !== undefined) out[name] = v;
  }
  return out;
}
