// Character gender by equipped character family (chars/index.json, same source viewmodel.ts uses for
// pbLive.fpsFamily): resolveChara() picks the entry for an itemId, falling back to the team's basic character, same
// as the visual model already does — so the voice always matches what's drawn.
//
// Two consumers:
//   - radioVoiceOf: the radio voice set (Man/Women wav, gameplay/pbRadio.ts).
//   - charaIsFemale: the character *voice* gender (charSfx.ts) — Sound_voice_Man.i3Pack (MV_*) vs
//     Sound_voice_Woman.i3Pack (WV_*), the same prefix convention. The client's female pack has no WV_Heart_Beat,
//     so the concussion loop is shared; every other MV_ take has a WV_ twin.
import { jsonOnce } from "../jsonOnce";
import { resolveChara, type CharaLike } from "./loadout";
import type { Team } from "./types";

interface CharaEntry extends CharaLike {
  family?: string;
}

let list: CharaEntry[] = [];
let loading: Promise<void> | null = null;

function ensureLoaded(): void {
  loading ??= jsonOnce<{ chars?: CharaEntry[] }>("/assets/chars/index.json")
    .then((j) => { list = j.chars ?? []; })
    .catch(() => { list = []; });
}

// start the fetch at import: a lazy first call answered "Man" (male voice on the first grenade of a female character)
ensureLoaded();

/** Sync (chars/index.json loads in the background; male until it does — same default the visual model starts with). */
export function charaIsFemale(itemId: number | null | undefined, team: Team): boolean {
  ensureLoaded();
  return resolveChara(list, itemId, team).entry?.family === "female";
}

/** Sync (chars/index.json loads in the background; "Man" until it does — same default the visual model starts with). */
export function radioVoiceOf(itemId: number | null | undefined, team: Team): "Man" | "Women" {
  return charaIsFemale(itemId, team) ? "Women" : "Man";
}
