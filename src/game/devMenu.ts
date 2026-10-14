// F2 test menu (offline / local matches only): keys 1-9 / 0 run an action, F2 toggles. Keeps the pointer lock, so it never opens the ESC menu.
export interface DevAction { label: () => string; run: () => void }

const CSS = `#pbdev{position:fixed;left:12px;top:12px;z-index:60;min-width:330px;background:rgba(8,12,20,.88);border:1px solid #3a6ea5;color:#dfe8f5;font:13px/1.55 Arial,sans-serif;padding:10px 14px;border-radius:4px;pointer-events:none}#pbdev b{color:#ffd75a}#pbdev h4{margin:0 0 6px;font-size:14px;color:#7fb8ff}#pbdev small{color:#8fa0b8}`;

export class DevMenu {
  private el: HTMLElement | null = null;
  private off: () => void;

  constructor(private title: string, private actions: DevAction[], private note = "") {
    const kd = (e: KeyboardEvent) => {
      if (e.code === "F2") { e.preventDefault(); e.stopPropagation(); this.toggle(); return; }
      if (!this.el) return;
      const i = e.code === "Digit0" ? 9 : /^Digit[1-9]$/.test(e.code) ? Number(e.code.slice(5)) - 1 : -1;
      if (i < 0) return;
      e.preventDefault();
      e.stopImmediatePropagation(); // the weapon slots share the digit keys: the menu takes them while open
      this.actions[i]?.run();
      this.render();
    };
    window.addEventListener("keydown", kd, true);
    this.off = () => window.removeEventListener("keydown", kd, true);
  }

  toggle(): void {
    if (this.el) { this.el.remove(); this.el = null; return; }
    if (!document.getElementById("pbdev-css")) {
      const s = document.createElement("style");
      s.id = "pbdev-css";
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    this.el = document.createElement("div");
    this.el.id = "pbdev";
    document.body.appendChild(this.el);
    this.render();
  }

  private render(): void {
    if (!this.el) return;
    const rows = this.actions.map((a, i) => `<div><b>${i === 9 ? 0 : i + 1}</b> ${a.label()}</div>`).join("");
    this.el.innerHTML = `<h4>${this.title} <small>(F2 fecha)</small></h4>${rows}${this.note ? `<small>${this.note}</small>` : ""}`;
  }

  dispose(): void {
    this.off();
    this.el?.remove();
    this.el = null;
  }
}
