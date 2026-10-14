// Room battle start -> match preload hook. ui/roomScreen.ts runs it between LOADING_START (+ RENDEZVOUS) and PRESTARTBATTLE,
// boot.ts registers what it does (main.ts prepareGame with the room's match set). Kept apart so the room screen does not
// import the game modules. The original client loads the stage in that same window, behind its loading screen: the slot
// states 16 PRESTART / 17 BATTLE_LOAD / 18 BATTLE_READY and the server's 90 s kick after LOADING_START vs 30 s after
// PRESTART [INFERIDO: no exe address shows the load itself].
import type { RoomClient } from "../net/roomClient.ts";

export interface BattlePrep {
  run(room: RoomClient): Promise<void>;
  /** the battle did not start after run(): drop what it built */
  discard(): void;
}

let prep: BattlePrep | null = null;

export function setBattlePrep(p: BattlePrep | null): void {
  prep = p;
}

/**
 * Runs the registered prepare, waiting `capMs` at most: past it the handshake goes on (a slow download must not hold the
 * other players at PRESTART / STARTBATTLE) and the startGame after RESPAWN awaits the rest. Never rejects.
 */
export async function runBattlePrep(room: RoomClient, capMs: number): Promise<void> {
  if (!prep) return;
  const p = prep.run(room).catch((e) => console.warn("[battle] match preload failed", e));
  let t: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p, new Promise<void>((r) => { t = setTimeout(r, capMs); })]);
  clearTimeout(t);
}

export function discardBattlePrep(): void {
  prep?.discard();
}
