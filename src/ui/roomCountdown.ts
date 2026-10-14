// Ready room start countdown: BATTLE_START_COUNTDOWN_ACK 5126 (C, CountDownEnum: 5 Start, 254 StopByPlayer, 255 StopByHost; the
// server sends it in the countdown modes, server roomHandlers startCountDown / stopCountDown). Port of
// UIPhaseReadyRoom::_EventProcess_BattlCountDown(int) (PBKaybo 2017 PointBlank.exe 0x8f2de0 = event 0x8c of the phase's
// OnEvent switch 0x8f31c0; the byte arrives signed: 255 = -1, 254 = -2):
//   - a sub-phase (inventory / shop / profile / clan) open over the room: the event is dropped (0x8f2e0b, "GameSubPhase").
//   - 5: the leader locks the room (0x8f05f0 -> 0x8f0530(false)) and gets the red STR_TBL_GUI_READYROOM_STOP_GET_AWAY between two
//     "  " lines (0x804540 colour 255,0,0,255; 0x8f04d0); then STR_TBL_GUI_READY_NOTICE_START_COUNTDOWN; the count goes to +0x2f4
//     with a 1.0 s timer at +0x2f0 (0x8f3e90). OnUpdate 0x8f3f00 takes 1 off each second (0x8f40c0) and feeds the new count back
//     as event 0x8c (0x8f3ec0), so the steps below run for 5, 4, 3, 2, 1, 0.
//   - count > 0: STR_TBL_GUI_READY_NOTICE_PRE_GAME_START_ALARM with %d; count 0: STR_TBL_GUI_READY_NOTICE_START_GAME.
//   - 1..5: UI_Count_A..E.wav (UIPhaseReadyRoom::OnCreate 0x8f4100 loads them into +0x2a4.. in that order; played as +0x2a0 + count*4,
//     so 5 = E ... 1 = A; Sound_UI / Sound_Interface -> sfx/char, pb-extract-tools export-charsfx2017.mjs).
//   - count < 0: unlock (0x8f06a0), STR_TBL_GUI_READY_NOTICE_COUNTDOWN_ABORTED_BY_ROOM_MASTER (-1) or _COUNTDOWN_ABORTED (-2); the
//     count stops.
// Every text is a system line of the chat box (framework +0x1c8 -> 0x4d65b0), coloured by the string's own {col:} markup.
import { tOr } from "../lobby/ui/i18n.ts";

export type Rgba = [r: number, g: number, b: number, a: number];

/** CountDownEnum.Start: the server's only count; the client counts the rest by itself */
export const COUNTDOWN_START = 5;
/** 255 / 254 as the exe reads them (signed byte) */
export const COUNTDOWN_STOP_BY_HOST = -1;
export const COUNTDOWN_STOP_BY_PLAYER = -2;
/** index = count - 1 */
export const COUNTDOWN_SOUNDS = ["UI_Count_A.wav", "UI_Count_B.wav", "UI_Count_C.wav", "UI_Count_D.wav", "UI_Count_E.wav"].map((f) => `/assets/sfx/char/${f}`);

const STR = {
  // String_Brazil.lua texts as fallback
  stopGetAway: ["STR_TBL_GUI_READYROOM_STOP_GET_AWAY", "Não é possível mudar para outras funções ao iniciar jogo"],
  start: ["STR_TBL_GUI_READY_NOTICE_START_COUNTDOWN", "{col:255,120,0,255}Iniciando contagem regressiva.{/col}"],
  alarm: ["STR_TBL_GUI_READY_NOTICE_PRE_GAME_START_ALARM", "{col:255,120,0,255}Início do jogo em %dsegundos{/col}"],
  startGame: ["STR_TBL_GUI_READY_NOTICE_START_GAME", "{col:255,120,0,255}O jogo será iniciado.{/col}"],
  aborted: ["STR_TBL_GUI_READY_NOTICE_COUNTDOWN_ABORTED", "{col:255,120,0,255} Algum jogador não está pronto, a contagem regressiva foi cancelada.{/col}"],
  abortedByHost: ["STR_TBL_GUI_READY_NOTICE_COUNTDOWN_ABORTED_BY_ROOM_MASTER", "{col:255,120,0,255}O dono da sala cancelou a contagem regressiva.{/col}"],
} as const;
const str = (k: keyof typeof STR): string => tOr(STR[k][0], STR[k][1]);

/** 0x804540: the text wrapped in {col:255,0,0,255} */
const RED: Rgba = [255, 0, 0, 1];

/** The first {col:r,g,b,a} of a client string as the line colour (alpha 0..1), markup removed; no markup = null. */
export function parseCol(s: string): { text: string; color: Rgba | null } {
  const m = /\{col:\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\}/.exec(s);
  const text = s.replace(/\{col:[^}]*\}|\{\/col\}/g, "").trim();
  return { text, color: m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]) / 255] : null };
}

export interface CountdownSink {
  /** one system line of the chat box; color = the line's {col:} colour, null = the default system colour */
  notice(text: string, color: Rgba | null): void;
  /** 0x8f0530: input of the top menu (UIMainFrame +0x80 [INFERIDO: UITopMenu]), floats 2 (MyInfo) and 4 (ReadyRoomInfo) and
   * every named child of TeamSelect's i3UIFrameWnd2 except btnStart (list built in 0x8f0400) off (true) / back on (false) */
  lock(on: boolean): void;
  sound(file: string): void;
  /** a sub-phase is open over the room (UIMainFrame sub-phase != -1) */
  subPhase(): boolean;
}

export class RoomCountdown {
  /** +0x2f4: seconds left; <= 0 = not counting */
  count = 0;
  /** +0x2ec: a countdown is running (set on 5, cleared on a cancel) */
  running = false;
  /** the lock is on (leader only, see event) */
  private locked = false;
  /** +0x2f0: time to the next step */
  private timer = 0;

  constructor(private sink: CountdownSink, private isLeader: () => boolean) {}

  /** 5126 (signed) or the client's own next step. */
  event(n: number): void {
    if (this.sink.subPhase()) return;
    if (n < 0) {
      this.unlock();
      this.running = false;
      this.say(n === COUNTDOWN_STOP_BY_HOST ? str("abortedByHost") : str("aborted"));
      this.set(n);
      return;
    }
    if (n === COUNTDOWN_START) {
      // a guest locks too when context flag 0x2000 (+0x96c, 0x7e4560) is set; its meaning is not decoded, so guests stay free [INFERIDO]
      if (this.isLeader() && !this.running) {
        this.locked = true;
        this.sink.lock(true);
        this.sink.notice("  ", null);
        this.sink.notice(parseCol(str("stopGetAway")).text, RED);
        this.sink.notice("  ", null);
      }
      this.running = true;
      this.say(str("start"));
      this.set(n);
    }
    if (n > 0) this.say(str("alarm").replace("%d", String(n)));
    if (n === 0) this.say(str("startGame"));
    if (n > 0 && n <= COUNTDOWN_SOUNDS.length) this.sink.sound(COUNTDOWN_SOUNDS[n - 1]);
  }

  /** OnUpdate 0x8f3f00: one step per second while the count is above 0. */
  update(dt: number): void {
    if (this.count <= 0) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 1;
    this.count--;
    this.event(this.count);
  }

  /** The room goes away (START_GAME, leave): count stopped, lock released. */
  reset(): void {
    this.unlock();
    this.running = false;
    this.count = 0;
  }

  /** 0x8f3e90 */
  private set(n: number): void {
    this.timer = 1;
    this.count = n;
  }

  private unlock(): void {
    if (!this.locked) return;
    this.locked = false;
    this.sink.lock(false);
  }

  private say(s: string): void {
    const { text, color } = parseCol(s);
    this.sink.notice(text, color);
  }
}
