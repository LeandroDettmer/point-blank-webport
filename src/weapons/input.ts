import type { SlotIndex, WeaponInput } from "./types";

/**
 * Optional helper: tracks LMB/RMB/R/1-4/wheel on the document and produces a WeaponInput per frame.
 * Movement state (speed/grounded/crouching) comes from the player controller.
 */
export class WeaponInputTracker {
  private fire = false;
  private aim = false;
  private reload = false;
  private slot: SlotIndex | null = null;
  private scroll = 0;
  private last = false;
  private off: (() => void)[] = [];

  constructor(target: Document | HTMLElement = document, private requirePointerLock = true) {
    const active = () => !this.requirePointerLock || !!document.pointerLockElement;
    const md = (e: MouseEvent) => {
      if (!active()) return;
      if (e.button === 0) this.fire = true;
      if (e.button === 2) this.aim = true;
    };
    const mu = (e: MouseEvent) => {
      if (e.button === 0) this.fire = false;
      if (e.button === 2) this.aim = false;
    };
    const kd = (e: KeyboardEvent) => {
      if (e.code === "KeyR") this.reload = true;
      const n = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6"].indexOf(e.code);
      if (n >= 0 && !e.repeat) this.slot = n as SlotIndex;
      if (e.code === "KeyQ" && !e.repeat) this.last = true; // last weapon (PB game-key 19)
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === "KeyR") this.reload = false;
    };
    const wh = (e: WheelEvent) => {
      if (active()) this.scroll += Math.sign(e.deltaY);
    };
    const cm = (e: Event) => e.preventDefault();
    const blur = () => {
      this.fire = this.aim = this.reload = false;
    };
    const t = target as HTMLElement;
    t.addEventListener("mousedown", md as EventListener);
    window.addEventListener("mouseup", mu);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    t.addEventListener("wheel", wh as EventListener, { passive: true });
    t.addEventListener("contextmenu", cm);
    window.addEventListener("blur", blur);
    this.off.push(
      () => t.removeEventListener("mousedown", md as EventListener),
      () => window.removeEventListener("mouseup", mu),
      () => window.removeEventListener("keydown", kd),
      () => window.removeEventListener("keyup", ku),
      () => t.removeEventListener("wheel", wh as EventListener),
      () => t.removeEventListener("contextmenu", cm),
      () => window.removeEventListener("blur", blur)
    );
  }

  sample(move: { speed?: number; grounded?: boolean; crouching?: boolean } = {}): WeaponInput {
    const out: WeaponInput = { fire: this.fire, aim: this.aim, reload: this.reload, slot: this.slot, lastWeapon: this.last, scroll: this.scroll, ...move };
    this.slot = null;
    this.last = false;
    this.scroll = 0;
    return out;
  }

  dispose(): void {
    this.off.forEach((f) => f());
  }
}
