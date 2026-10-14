// Point Blank Cross V-37 (PointBlank.exe, base 0x400000) screen transitions: every classic i3Gui phase / step / popup is a
// CGuiNotifyReceiver, whose slide (SlideIn 0x6fb9a0, SlideOut 0x6fb9d0, OnSliding 0x6fba10) gives an offset the size of
// the view; each class adds it to one window (OnSliding overrides, CROSS_SLIDE_WINDOWS). CStageReady swaps phases with the
// state machine of its OnUpdate (0x511250, state at +0x3724) and steps (inventory / shop / profile) with ChangeStep
// (0x5135d0). Pure, no DOM: the smoke (dev/slide.smoke.ts) runs it as is, app.ts moves the windows.
// Not the 2017 UISlide (removed with the 2017 lobby drawing): other states, offset = W / H * cos / sin (no ratio lerp toward a
// per-window "out" place), no WaitLoad, no delay; the durations (0.5 s in, 1/3 s out) match.

export type CrossPhase = "servers" | "channels" | "lobby" | "room";
export type CrossStep = "inventory" | "shop" | "profile";
export interface CrossTarget { phase: CrossPhase; step: CrossStep | null }
/** CGuiNotifyReceiver sound table 0xd617bc (PlaySound 0x6fb7e0 index): 0 UI_Scroll_In.wav, 1 UI_Scroll_Out.wav,
 * 2 UI_PopUp_Open.wav, 3 UI_PopUp_Close.wav */
export type CrossSound = "in" | "out";

/**
 * Which window each OnSliding override moves, by which axis (the window's .gui place + the offset):
 * CPhaseServerList 0x820550 ssServerListWin y (+0x74, base y +0x88), CPhaseChannelList 0x823070 ssServerWin x (+0x78, base
 * x +0x2ac), CPhaseLobby 0x831320 root "Lobby" x (+0xac), CPhaseReadyRoom 0x7c99b0 root "ReadyRoom" x (+0xac),
 * CStepInventory 0x842610 root "Inventory" y (+0x84), CStepShop 0x84d6a0 root "Shop" y (+0x88), CStepProfile 0x869100
 * root "Profile" y (+0x84) (members from the link functions: 0x81f9b1, 0x821e1e, 0x828f81, 0x7c5753, 0x840ab2,
 * 0x84d1dc, 0x868c2c). A root moves every window under it: the lists are the ones the web builds. The offsets are
 * positive: windows come in from the right / the bottom and leave the same way. The menu bar (CMenuBar keeps the base
 * OnSliding, nothing applied) and the popups (CPopupBase::OnOpenPopup 0x870ae0 = sound + SetEnable, no slide) do not move.
 */
export const CROSS_SLIDE_WINDOWS: Record<CrossPhase | CrossStep, { axis: "x" | "y"; names: string[] }> = {
  servers: { axis: "y", names: ["ssServerListWin"] },
  channels: { axis: "x", names: ["ssServerWin"] },
  // lbCreateWin is under "Lobby" too, but the web also opens it on the room page (room settings): left out, it is a modal
  // that the controller closes before any page change
  lobby: { axis: "x", names: ["lbInfoWin", "lbUserListWin", "lbRoomWin", "lbSpecialWarWin"] },
  room: { axis: "x", names: ["rrRoomWin", "rrRecordWin"] },
  inventory: { axis: "y", names: ["ivEquipmentWin", "ivCharacterWin", "ivInvenWin"] },
  shop: { axis: "y", names: ["shopWin"] },
  profile: { axis: "y", names: ["prProfileWin", "prCardShopWin", "prCardInfoWin", "prCardComplateWin"] },
};

/**
 * g_SinTable lookups (table at [0xdb5c9c]): sin 0x52bac0 / cos 0x691c90 = entry (trunc(x * 41721.51171875 (0xb3a2c8)) >> 9)
 * & 0x1ff, cos 0x80 entries later: 512 entries per turn. Entry i = sin(2 pi i / 512) [INFERIDO: the table is filled at
 * run time, not in the file].
 */
export function tableSin(x: number, cos = false): number {
  const i = ((Math.trunc(x * 41721.51171875) >> 9) + (cos ? 0x80 : 0)) & 0x1ff;
  return Math.sin((i * Math.PI) / 256);
}
/** pi / 2 as the float the exe multiplies by (double 0xb6a018 = 1.5707963705062866) */
const HALF_PI = 1.5707963705062866;

/** CGuiNotifyReceiver +0x64: 0 shown, 1 hidden (the ctor 0x6fb350 starts here), 2 sliding in, 3 sliding out */
export type SlideState = 0 | 1 | 2 | 3;

export class GuiSlide {
  /** +0x60: 0 -> 1 over the slide */
  t = 0;
  /** +0x64 */
  state: SlideState = 1;
  /** +0x68 / +0x6c: offset in view pixels (ctor 0, 0) */
  x = 0;
  y = 0;

  /** SlideIn 0x6fb9a0: unless shown, state 2 and t = 0 (the offset is kept until the next OnSliding) */
  slideIn(): void {
    if (this.state === 0) return;
    this.state = 2;
    this.t = 0;
  }

  /** SlideOut 0x6fb9d0: unless hidden, state 3 and t = 0. It also clears the menu bar's +0x110 flag (0x81dd50); the next
   * slide-in that ends sets it (0x6fbafb -> 0x81dd70). That flag only gates ESC (0x6fb630 in CPhaseBase 0x7bc900). */
  slideOut(): void {
    if (this.state === 1) return;
    this.state = 3;
    this.t = 0;
  }

  /**
   * OnSliding 0x6fba10 (dt in seconds, view = GetViewWidth / GetViewHeight 0xdb50a0 / 0xdb50a4). False when shown or
   * hidden (nothing changes). In: t += 2 dt (0.5 s), out: t += 3 dt (double 3.0 at 0xb22bc0: 1/3 s); t is clamped to 1
   * and t >= 1 ends the slide in that frame. Offset: shown 0, hidden the whole view, in view * cos(t pi/2) (fast, then
   * braking), out view * sin(t pi/2) (from rest, accelerating).
   */
  update(dt: number, viewW: number, viewH: number): boolean {
    if (this.state === 0 || this.state === 1) return false;
    this.t = Math.fround(this.state === 2 ? this.t + (dt + dt) : this.t + dt * 3);
    if (!(1 > this.t)) this.t = 1;
    if (this.t >= 1) this.state = this.state === 2 ? 0 : 1;
    const a = Math.fround(this.t * HALF_PI);
    switch (this.state) {
      case 0: this.x = 0; this.y = 0; break;
      case 1: this.x = viewW; this.y = viewH; break;
      case 2: this.x = viewW * tableSin(a, true); this.y = viewH * tableSin(a, true); break;
      case 3: this.x = viewW * tableSin(a); this.y = viewH * tableSin(a); break;
    }
    return true;
  }
}

/**
 * CStageReady phase / step swap. One state per frame, as the switch of OnUpdate 0x511250 (+0x3724):
 * 0 next queued phase (+0x3718) becomes the current one (+0x3714) -> 1; 1 OnEntranceStart (CPhaseBase 0x7bc7e0: SlideIn
 * + PlaySound(0)) -> 2; 2 OnEntrancing 0x7bc800 (OnSliding, done when shown) -> 3; 3 OnEntranceEnd + SetEnable(1)
 * (0x51155e) -> 4; 4 idle until a phase is queued (0x511618) -> 5; 5 SetEnable(0) (0x5116f7) + OnExitStart (0x7bc850:
 * SlideOut + PlaySound(1)) -> 6; 6 OnExiting 0x7bc870 (done when hidden) -> 7; 7 OnExitEnd -> 0.
 * So the old phase leaves (1/3 s) before the new one comes in (0.5 s), and a phase takes no input from its exit start to
 * its entrance end (disabled). After that the phase's own OnUpdate (CGuiNotifyReceiver 0x6fb500) runs OnSliding every
 * frame, which is what moves it when a step opens or closes.
 */
export class CrossStage {
  readonly slides: Record<CrossPhase | CrossStep, GuiSlide> = {
    servers: new GuiSlide(), channels: new GuiSlide(), lobby: new GuiSlide(), room: new GuiSlide(),
    inventory: new GuiSlide(), shop: new GuiSlide(), profile: new GuiSlide(),
  };
  /** +0x3714 */
  cur: CrossPhase | null = null;
  /** +0x3724 */
  state = 0;
  /** +0x3718: the exe queues every MovePhase; the web keeps the last one asked [INFERIDO: one pending phase is enough here] */
  next: CrossPhase | null = null;
  /** +0x3728 (-1 = null) */
  step: CrossStep | null = null;
  /** i3GameNode enable (0xdb50e4 isEnable): phases on at entrance end, off at exit start; steps on at OnStart, off when
   * their slide-out ends */
  readonly enabled = new Set<CrossPhase | CrossStep>();
  private viewW = 1024;
  private viewH = 768;

  constructor(private sound: (s: CrossSound) => void) {}

  /** the page the controller is on: queue a phase change, run ChangeStep for a step change */
  want(t: CrossTarget): void {
    const phaseMoves = t.phase !== (this.next ?? this.cur);
    if (t.step !== this.step) this.changeStep(t.step, !phaseMoves);
    if (phaseMoves) this.next = t.phase;
  }

  /**
   * ChangeStep 0x5135d0 (the exe toggles: the same step again closes it; the web passes the step it wants). The old step
   * runs OnEnd (CStepBase 0x83f780: SlideOut, no sound); with no step open the phase slides out instead (vf +0xf8 =
   * CPhaseBase 0x7bc8c0: SlideOut + PlaySound(1), called at 0x5139b6). The new step runs OnStart (0x83f720: SlideIn,
   * PlaySound(0) when it was disabled, SetEnable(1), OnUpdate(0)); closing the last step slides the phase back in (vf +0xfc
   * = 0x7bc8e0: SlideIn + PlaySound(0), at 0x513ad8). Both slides run in the same frames, nothing waits.
   * `phaseSlides` false: the step closes because the phase changes; the phase is not slid back in first [INFERIDO: the exe
   * path for a phase change with a step open was not decoded].
   */
  private changeStep(s: CrossStep | null, phaseSlides: boolean): void {
    const phase = this.cur ? this.slides[this.cur] : null;
    if (this.step) this.slides[this.step].slideOut();
    else if (phase) { phase.slideOut(); this.sound("out"); }
    if (s) {
      const st = this.slides[s];
      st.slideIn();
      if (!this.enabled.has(s)) this.sound("in");
      this.enabled.add(s);
      st.update(0, this.viewW, this.viewH);
    } else if (phase && phaseSlides) { phase.slideIn(); this.sound("in"); }
    this.step = s;
  }

  /** one frame: the CStageReady switch, then the OnUpdate of every enabled node (OnSliding) */
  frame(dt: number, viewW: number, viewH: number): void {
    this.viewW = viewW;
    this.viewH = viewH;
    const p = this.cur ? this.slides[this.cur] : null;
    switch (this.state) {
      case 0: if (this.next) { this.cur = this.next; this.next = null; this.state = 1; } break;
      case 1: p!.slideIn(); this.sound("in"); this.state = 2; break;
      case 2: p!.update(dt, viewW, viewH); if (p!.state === 0) this.state = 3; break;
      case 3: this.enabled.add(this.cur!); this.state = 4; break;
      case 4: if (this.next) this.state = 5; break;
      case 5: this.enabled.delete(this.cur!); p!.slideOut(); this.sound("out"); this.state = 6; break;
      case 6: p!.update(dt, viewW, viewH); if (p!.state === 1) this.state = 7; break;
      case 7: this.state = 0; break;
    }
    for (const k of this.enabled) {
      const s = this.slides[k];
      s.update(dt, viewW, viewH);
      // CStepBase::OnSliding 0x83f840: a step whose slide-out ended disables itself (SetEnable(0) at 0x83f89a)
      if (s.state === 1 && (k === "inventory" || k === "shop" || k === "profile")) this.enabled.delete(k);
    }
  }

  /** a phase takes input only while enabled (entrance ended, exit not started); a step while enabled */
  input(k: CrossPhase | CrossStep): boolean { return this.enabled.has(k) && this.slides[k].state !== 1; }
}
