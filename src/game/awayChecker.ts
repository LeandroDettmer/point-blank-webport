// In-battle away kick: CStageBattle's away input check (PointBlank.exe 2017, StageBattle.cpp).
//   0x76c360 (unnamed, called once per frame with dt), the members it drives are 0x1b8 rAwayInputTime / 0x1dc rCautionTime
//   (obfuscated floats) and the flags 0x200 (kicked) / 0x224 (caution shown):
//   - skipped entirely for a GM or a MOD (0x76c379..0x76c39c), the same pair CPlayer 0x6b4a30 gates the GM observer keys with
//     and that lets a GM / MOD past the room rank limits (0x59bf30 -> _IsValidRank). Not tutorial / training:
//       0x6b4a70 IsGM  = CPlayer+8 != 0 (a dword of the server's 0xa06 ack, stored at 0x9a2937 by 0x9aeba0), or rank 53
//                        (CGameContext 0x59d560 = my user info +0x25) with a nick that starts with STR_TBL_CHAT_GM_TEXT
//                        (0x800090: i3String::Contain(nick, gm) == 0)
//       0x6b4ae0 IsMOD = rank 54 (0x59cc50)
//   - if rAwayInputTime > 0: both timers -= dt
//   - re-arm: SetAwayInputTime(60, 55) (0x76c4ba..0x76c4d4) and the caution box closes (CMessageBoxManager 0x520e40), when
//       input = CGameFramework 0x51b3d0(0): mouse delta X/Y/Z != 0, a mouse button held, any of the 0x66 keys held
//       or CBattleGui+0x2dc != 0 (0x76c6a0, flag not identified)
//       or the stage type ((stageId >> 24) & 0x7f, 0x6eaba0) is 2 Bomb (0x5832f0) / 4 Annihilation (0x583320) and my slot
//         (0x4c7790) is not alive in the round (0x76d120: slot state 13, in the round's slots mask CGameContext+0x46a9c
//         (0x59b070), not getUserDeath, a chara not in state mask 0xb): dead or spectating time never counts there
//   - rAwayInputTime <= 0 (0x76c6c0): same exit as the ESC menu's CbGiveupBattle 0x76d280: SetEvent(0x98) (GIVEUPBATTLE)
//     and GotoNextStage("Ready") (0x524990): back to the room
//   - rCautionTime <= 0 (0x76c720): message box STBL_IDX_EP_GAME_AWAY_INPUT_BATTLE with "%d" = a 5 s countdown (0xb434d0),
//     its text redrawn every frame with the truncated rest (cvttss2si 0x76c62f)
//   Armed at battle start (ProcessGameContext 0x768d2c, after P2PPreStartBattleUser): SetAwayInputTime(60, 55).
// Timing = exe. Differences, project rules:
//   - the limit is the exe's 60 s (user decision 2026-10-01; also bounds the Cloud Run cost of a forgotten tab) and the
//     caution keeps the exe's offset (60 - 55 = 5 s before the kick).
//   - the dead re-arm (awayRearm) runs in Bomb only: the web has no Annihilation. As in the exe, an AFK player killed in
//     every round before the limit is re-armed and stays.
//   - the GM / MOD skip is Game.isGM (the slot's auth level, the chat GM notice) [INFERIDO: CPlayer+8 read as the server's
//     GM flag, its field in the 0xa06 ack is not decoded].
//   - round end and the result screen pause the clock (no kick there); the exe has no such pause.
//   - not ported: the CBattleGui +0x2dc re-arm (flag not identified).

/** seconds without input before the kick (exe 2017: SetAwayInputTime(60, 55) 0x76c4d4 / 0x768d2c, 60 = 0xb32d8c) */
export const AWAY_INPUT_SEC = 60;
/** local dev (vite dev server) only: 2 min, so testing / debugging a match is not cut every minute [RECRIADO] */
const AWAY_INPUT_SEC_DEV = 120;
const DEV = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
/** the caution box opens this long before the kick (exe: rAwayInputTime 60 - rCautionTime 55, 0xbd0014) */
export const AWAY_CAUTION_LEAD_SEC = 5;
/** the "%d" countdown of the caution box (exe 0xb434d0 = 5) */
export const AWAY_COUNTDOWN_SEC = 5;

/**
 * Re-arm condition of 0x76c360 (0x76c43a..0x76c4b8), fed to AwayTimer.update as `input`: input, or a round mode
 * (stage type 2 Bomb / 4 Annihilation) while the local slot is not alive in the round (0x76d120: dead, or sitting it out).
 */
export function awayRearm(input: boolean, roundMode: boolean, alive: boolean): boolean {
  return input || (roundMode && !alive);
}

export type AwayTick = {
  /** seconds shown in the caution box this frame, null = no box */
  warn: number | null;
  /** true once: the player leaves the battle */
  kick: boolean;
};

/** Pure clock of 0x76c360 (no DOM), driven by Game.update. */
export class AwayTimer {
  private away = 0;
  private caution = 0;
  private kicked = false;
  private cautioned = false;
  private countdown = 0;
  private boxOpen = false;

  constructor(readonly limit = DEV ? AWAY_INPUT_SEC_DEV : AWAY_INPUT_SEC, readonly lead = AWAY_CAUTION_LEAD_SEC) {
    this.reset();
  }

  /** SetAwayInputTime(limit, limit - lead): the full time again, the box closes */
  reset(): void {
    this.away = this.limit;
    this.caution = this.limit - this.lead;
    this.kicked = false;
    this.cautioned = false;
    this.boxOpen = false;
  }

  /**
   * One frame. `input`: the player touched the mouse or the keyboard since the last frame (or holds a key / button), or
   * another re-arm condition of the exe (awayRearm).
   * `paused`: round end / result screen, the clock stops and nothing fires (input still re-arms).
   */
  update(dt: number, input: boolean, paused: boolean): AwayTick {
    if (input) {
      this.reset();
      return { warn: null, kick: false };
    }
    if (paused || this.kicked) return { warn: this.boxOpen ? this.shown() : null, kick: false };
    if (this.away > 0) {
      this.away -= dt;
      this.caution -= dt;
    }
    if (this.away <= 0) {
      this.kicked = true;
      this.boxOpen = false;
      return { warn: null, kick: true };
    }
    if (!this.cautioned && this.caution <= 0) {
      this.cautioned = true;
      this.boxOpen = true;
      this.countdown = AWAY_COUNTDOWN_SEC;
    }
    if (!this.boxOpen) return { warn: null, kick: false };
    this.countdown -= dt;
    return { warn: this.shown(), kick: false };
  }

  private shown(): number {
    return Math.max(0, Math.trunc(this.countdown));
  }
}

