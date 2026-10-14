// Shared keyboard/mouse state. Edge-triggered sets are cleared by endFrame() once per tick.
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private mouse = new Set<number>();
  private mousePressed = new Set<number>();
  lookDX = 0;
  lookDY = 0;
  wheel = 0;
  /** any key, mouse move / button / wheel since the last endFrame(), locked or not (awayChecker.ts) */
  private activity = false;

  /**
   * The battle chat field (game/battleChat.ts) is open: WASD / fire / weapon keys / mouse buttons are ignored and Tab / Space
   * reach the text field. The chat releases the pointer itself (cursor shown for the tabs), so mouse look stops until it closes.
   * Set through setChatOpen().
   */
  chatOpen = false;

  private abort = new AbortController();

  constructor(private lockTarget: HTMLElement = document.body) {
    const signal = this.abort.signal;
    window.addEventListener("keydown", (e) => {
      if (this.chatOpen) return; // typing: no preventDefault (Space / Tab belong to the field), nothing reaches the game keys
      // game keys the browser also binds: Tab, Space, Ctrl+<n> (saved camera positions), F1 (help), F5 (HUD: the browser reloads the
      // page), F9 (GM seat badges), Backquote / = / - only while the game holds the mouse
      if (e.code === "Tab" || e.code === "Space" || (this.locked && (e.ctrlKey || /^F[159]$/.test(e.code)))) e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
      this.activity = true;
    }, { signal });
    window.addEventListener("keyup", (e) => this.down.delete(e.code), { signal });
    window.addEventListener("blur", () => {
      this.down.clear();
      this.mouse.clear();
    }, { signal });
    document.addEventListener("mousemove", (e) => {
      if (e.movementX || e.movementY) this.activity = true;
      if (!this.locked) return;
      this.lookDX += e.movementX;
      this.lookDY += e.movementY;
    }, { signal });
    document.addEventListener("mousedown", (e) => {
      this.activity = true;
      if (!this.locked || this.chatOpen) return;
      this.mouse.add(e.button);
      this.mousePressed.add(e.button);
    }, { signal });
    document.addEventListener("mouseup", (e) => this.mouse.delete(e.button), { signal });
    document.addEventListener("contextmenu", (e) => e.preventDefault(), { signal });
    document.addEventListener(
      "wheel",
      (e) => {
        this.activity = true;
        if (this.locked) this.wheel += Math.sign(e.deltaY);
      },
      { passive: true, signal }
    );
  }

  /** Opening drops every held key / button (a held W must not run on after the field closes). */
  setChatOpen(on: boolean): void {
    if (this.chatOpen === on) return;
    this.chatOpen = on;
    this.down.clear();
    this.pressed.clear();
    this.mouse.clear();
    this.mousePressed.clear();
  }

  /** Drops every listener (back to the lobby: Space/Tab must work in form fields again). */
  dispose(): void {
    this.abort.abort();
  }

  get locked(): boolean {
    return document.pointerLockElement === this.lockTarget;
  }

  key(code: string): boolean {
    return this.down.has(code);
  }
  keyPressed(code: string): boolean {
    return this.pressed.has(code);
  }
  button(b: number): boolean {
    return this.mouse.has(b);
  }
  buttonPressed(b: number): boolean {
    return this.mousePressed.has(b);
  }

  /** player input this frame, as the exe's away check reads it (0x51b3d0): a move / click / key since the last frame, or a
   *  key / button still held */
  get anyInput(): boolean {
    return this.activity || this.down.size > 0 || this.mouse.size > 0;
  }

  endFrame(): void {
    this.activity = false;
    this.pressed.clear();
    this.mousePressed.clear();
    this.lookDX = 0;
    this.lookDY = 0;
    this.wheel = 0;
  }
}
