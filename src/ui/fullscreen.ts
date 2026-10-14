// Fullscreen for the whole page (lobby and battle) [RECRIADO: PB is a fullscreen client; Alt+Enter is the usual
// window/fullscreen toggle of i3 games]. Alt+Enter toggles it. While fullscreen, Escape is captured with the Keyboard
// Lock API where the browser has it (Chrome / Edge), so Escape reaches the game (ESC menu, closing popups) instead of
// leaving fullscreen; Alt+Enter (or F11) leaves it. Without the API the browser's own Escape behaviour stays.
// [RECRIADO: the original is a native exe, no such problem] In windowed mode Ctrl+W (crouch + walk) closes the tab and
// no page can block it (browser-reserved). Only protection: the native "Leave site?" dialog via beforeunload (text is
// the browser's, not customizable). Intentional reloads call allowLeave() first so they skip it.

interface KeyboardLock { lock?(codes?: string[]): Promise<void>; unlock?(): void }
const keyboard = (): KeyboardLock | undefined => (navigator as unknown as { keyboard?: KeyboardLock }).keyboard;

export function isFullscreen(): boolean {
  return !!document.fullscreenElement;
}

export async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: "hide" });
  } catch (e) {
    console.warn("[fullscreen]", e);
  }
}

let installed = false;
let leaving = false;
/** Call right before an intentional page reload/exit so the beforeunload confirmation is skipped. */
export function allowLeave(): void {
  leaving = true;
}
/** Alt+Enter toggle + Escape capture while fullscreen + beforeunload guard. Idempotent. */
export function installFullscreen(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  window.addEventListener("beforeunload", (e) => {
    if (leaving) return;
    e.preventDefault();
    e.returnValue = ""; // native confirm dialog: only defense against Ctrl+W closing the tab in windowed mode
  });
  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyW" && e.ctrlKey) e.preventDefault(); // no effect in windowed mode (browser reserves it): see beforeunload above
    if (e.code === "Enter" && e.altKey && !e.repeat) {
      e.preventDefault();
      e.stopPropagation();
      void toggleFullscreen();
    }
  }, { capture: true });
  document.addEventListener("fullscreenchange", () => {
    const kb = keyboard();
    // KeyW + Ctrl: Ctrl+W (crouch) otherwise closes the tab; locked, it reaches the page.
    if (document.fullscreenElement) void kb?.lock?.(["Escape", "KeyW", "ControlLeft", "ControlRight"]).catch(() => {});
    else kb?.unlock?.();
  });
}
