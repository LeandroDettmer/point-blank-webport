// Max HP of a character item: Server.Match CharaStructureXML.GetCharaHP, the same table the P2P host's match core
// uses (src/host/data/matchData.json charaHp, pb-extract-tools match-data.mjs): 100 for the basic characters, 110 / 120 for the
// Reinforced ones, more for bosses. Loaded lazily (the file also carries every map's objects).
import { PB_CHARA } from "./pbConfig.ts";

let table: Record<string, number> | null = null;
let loading: Promise<void> | null = null;

export function loadCharaHp(): Promise<void> {
  return (loading ??= import("../host/data/matchData.json")
    .then((m) => { table = (((m as { default?: unknown }).default ?? m) as { charaHp?: Record<string, number> }).charaHp ?? {}; })
    .catch((e) => { loading = null; console.warn("[charaHp] matchData.json", e); }));
}

/** No character (offline test loadout) or table not loaded: the default soldier (PB_CHARA, Cross SWAT_Male 100). An id the
 * table lacks: 100, the match core's own default (matchCore.ts `charaHp[charaId] ?? 100`). */
export function charaMaxHp(charaId?: number): number {
  if (!charaId || !table) return PB_CHARA.hp;
  return table[String(charaId)] ?? 100;
}
