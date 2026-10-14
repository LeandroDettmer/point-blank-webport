// Dev-only diagnostics (loaded by boot.ts when import.meta.env.DEV): reports as console.warn which element
// receives each click, so a preview that captures console warnings shows what blocks the UI.
function describe(el: Element | null): string {
  if (!el) return "null";
  const h = el as HTMLElement;
  const cs = getComputedStyle(h);
  const r = h.getBoundingClientRect();
  const name = h.dataset?.name ?? h.dataset?.ctl ?? h.getAttribute("data-control") ?? "";
  return `<${h.tagName.toLowerCase()} id="${h.id}" class="${h.className}" name="${name}"> z=${cs.zIndex} pe=${cs.pointerEvents} ` +
    `rect=${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)}`;
}

export function installClickDiag(): void {
  addEventListener("pointerdown", (e) => {
    const stack = document.elementsFromPoint(e.clientX, e.clientY).slice(0, 6).map(describe);
    const top = document.elementFromPoint(e.clientX, e.clientY);
    const screen = (top as HTMLElement | null)?.closest?.("[data-screen]")?.getAttribute("data-screen") ?? "-";
    console.warn(`[clickdiag] at ${e.clientX},${e.clientY} screen=${screen}\n  ` + stack.join("\n  "));
  }, true);
  addEventListener("error", (e) => console.warn(`[clickdiag] error: ${e.message} @ ${e.filename}:${e.lineno}`));
  addEventListener("unhandledrejection", (e) => console.warn(`[clickdiag] rejection: ${String((e as PromiseRejectionEvent).reason?.stack ?? (e as PromiseRejectionEvent).reason)}`));
  console.warn("[clickdiag] installed");
}
