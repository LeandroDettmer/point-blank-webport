// In-battle text chat, code-drawn for the Cross client (no Kaybo scene). Everything from the Cross exe (PointBlank.exe, PBCross),
// CBattleChatBox (ctor 0x8c03f0, Create 0x8c07f0, Update 0x8c1b70), scale H/768 (getHeightRatioBy768), left anchored, positions
// below relative to the window origin (11, 768 - 195):
//  - art: HUD texture 0 = Gui/Ingame/Hud.i3i (0x8c07fe push 0; call 0x7647b0) = ui/cross/atlas/ingame_hud.png.
//    History set (8 sprites, _GetTextrueRect 0x8c24e0 / _GetSpriteRect 0x8c26e0, switched as a whole by SetHistoryMode 0x8c2169):
//    header (0,0,403,21), body (0,21,403,114) = a 1 px strip stretched, footer (0,135,403,22), up arrow (388,4) and down arrow
//    (388,145) 11x8 (two sprites each at one place: both drawn), scroll thumb (386,y) 15x23.
//    Input set (+0x70, SetInputMode 0x8c2200): bar (-1,157) 405x28, language icon (378,161) 21x21; tabs (+0x78) 41x18 at
//    x 1 + 42 i, y 139, shown with the field or the history. Two 5x5 dots at (39,161/175) are not drawn (texture not read).
//  - text nodes (Arial 10 pt, 0x8c1227..0x8c18db): log (1,-3) 370x152, bottom aligned, line space +5 (0x8c1527..0x8c167b);
//    field (49,166); combo (7,164); tabs colour (204,204,204).
//  - idle log (0x8c33a0): the closed box shows the newest 8 lines with no background; one shared timer drops the oldest line every
//    5.0 s (0x8c3414), no fade; history shows 8 of the 100-line ring.
// Strings: Cross strings.json (STR_TBL_CHAT_CHANNEL_TYPE_*, STBL_IDX_CHAT_TARGET_*, STBL_IDX_CHATMESSAGE_*), colours from the same
// {col:r,g,b,a} markup.
// Behaviour from the exe:
//  - the closed box shows the last 8 lines; with no new line the oldest goes away every 5 s, no fade (battleChatModel.ts ChatAging)
//  - Enter opens the input bar (tab = mode), F2 / F3 / F4 = general / team / clan mode, Enter sends, an empty Enter closes
//  - L (STBL_IDX_GAMEKEY_CHAT_HISTORY) toggles the history view: the framed log with up to 100 lines, wheel / PageUp / PageDown scroll
//  - "/pm /w", "/resp /r", "/time /t", "/apagar /c", "/ajuda /help" (parseChatCommand)
// While the field is open Input.chatOpen is set (WASD / fire / weapon keys ignored) and the pointer is released: exe SetInputMode(1)
// 0x8c2200 calls 0x5222c0(0), which clears the game's mouse-capture flag (+0xf8, read by 0x521c90 / 0x521d00 = ShowCursor +
// ClipCursor), so the cursor shows. Close (0x5222c0(1)) takes it back. Mouse clicks on the tabs and the combo work only then:
// the open-field mouse handler 0x8c3930 hit-tests the 4 tab rects (+0x78) and the bar sprites (+0x70).
// [INFERIDO] Escape closes the field, but a browser re-lock needs a user gesture: Escape is not one, so the next click re-locks.
// Every text goes in with textContent (never innerHTML): other players' lines are untrusted.
import { UI_BASE } from "../lobby/ui/assets.ts";
import { guiFont } from "../lobby/ui/i3Gui.ts";
import { Stage } from "../lobby/ui/LayoutRenderer.ts";
import { loadStrings, tOr } from "../lobby/ui/i18n.ts";
import { CHAT_MAX, ChatType, type ChatClient, type ChatLine } from "../net/chatClient.ts";
import {
  backAt, CHAT_COLORS, ChatAging, chatLayout, comboNext, HISTORY_LINES, IDLE_LINES, formatLine, maxBack, parseChatCommand, rgb, TAB_MODES,
  tabX, thumbTop,
  type ChatMode, type Span,
} from "./battleChatModel.ts";
import { lockPointer } from "../lockPointer.ts";
import type { Input } from "./input.ts";
import { CHAT_KEYS } from "./keymap.ts";

/** window size in design px (exe 0x8c26e0 table) */
const WIN_W = 403, WIN_H = 157;
const BODY_Y = 21, BODY_H = 114;
/** Gui/Ingame/Hud.i3i (1024 x 512) and the texture rects (left, top, right, bottom) of the exe */
const HUD_TEX = `${UI_BASE}/cross/atlas/ingame_hud.png`, TEX_W = 1024, TEX_H = 512;
type Rect = readonly [number, number, number, number];
/** history set, _GetTextrueRect 0x8c251e..0x8c26b1 + _GetSpriteRect 0x8c26e0: [x, y, w, h] in the window, texture rect */
const HISTORY_SPRITES: readonly (readonly [number, number, number, number, Rect])[] = [
  [0, 0, 403, 21, [516, 65, 918, 85]], [0, 21, 403, 114, [516, 87, 918, 88]], [0, 135, 403, 22, [516, 90, 918, 111]],
  [388, 4, 11, 8, [573, 3, 584, 11]], [388, 4, 11, 8, [585, 3, 596, 11]],
  [388, 145, 11, 8, [573, 13, 584, 21]], [388, 145, 11, 8, [585, 13, 596, 21]],
];
const THUMB: Rect = [555, 2, 570, 26], THUMB_X = 386, THUMB_W = 15, THUMB_H = 23;
/** input set (+0x70): bar 10r, H - 38r, 405 x 28; language icon (389r, bar + 4r) 21 x 21 in its "ENG" state 578,26..600,48 (the web
 *  field is always Latin [INFERIDO]: the exe swaps KOR / ENG by IME mode, 0x8c4127) */
const BAR: Rect = [514, 115, 919, 143], BAR_Y = 157, LANG: Rect = [578, 26, 600, 48];
/** tabs (+0x78): 41 x 18 at x (12 + 42 i)r, y H - 56r, all four on 861,38..902,56; text (204,204,204) */
const TAB: Rect = [861, 38, 902, 56], TAB_Y = 139, TAB_W = 41, TAB_H = 18;
/** Cross font of all 4 CBattleChatBox text nodes (tabs 0x8c1227, log 0x8c14d2, field 0x8c16e3, combo 0x8c18db): the default font
 *  (Arial, FONTS.chat) at 10 pt x getHeightRatioBy768 (0xb2af20 = 10.0), weight 0 = FW_DONTCARE (normal); GDI-measured like the lobby
 *  (guiFont). Log node 370 x 152 holds 8 lines with SetTextSpace(0, 5r): pitch 152 / 8 = 19 [INFERIDO: GDI line height + 5] */
const CHAT_FONT = guiFont(10, 400).css;
const LOG_X = 1, LOG_Y = -3, LOG_W = 370, LOG_H = 152;
const LINE_PX = LOG_H / IDLE_LINES;
const SHADOW = "text-shadow:1px 1px 0 rgba(31,31,31,.78);";
/** how long after an Escape that closed the field the game must not treat that Escape as "open the ESC menu" */
const ESC_GRACE_MS = 400;
/** history arrows: a held arrow repeats after this long (exe 0x8c2970, double 0.3 at 0xb46420) */
const HOLD_S = 0.3;

/** header tabs in order: Todos / Time / Clã / PM (STR_TBL_CHAT_CHANNEL_TYPE_*; TAB_MODES in battleChatModel.ts) */
const TAB_KEYS = ["ALL", "TEAM", "CLAN", "WHISPER"] as const;
const TAB_FALLBACK = ["Todos", "Time", "Clã", "PM"];

export interface BattleChatDeps {
  host: HTMLElement;
  input: Input;
  chat: ChatClient;
  /** field may open now (pointer locked, no menu / final screen) */
  canOpen: () => boolean;
  /** "/..." line the page handles (block, report...): true = handled here, nothing is sent */
  command: (line: string) => boolean;
  /** the account is in a clan (the room slot carries the clan name): the Clã channel is open to it */
  inClan: () => boolean;
}

const modeColor = (m: ChatMode) => rgb(CHAT_COLORS[m === "clan" ? "clan" : m]);

/** a Hud.i3i sprite: texture rect `r` stretched over (x, y, w, h) like i3Sprite2D */
function sprite(parent: HTMLElement, x: number, y: number, w: number, h: number, r: Rect): HTMLDivElement {
  const sx = w / (r[2] - r[0]), sy = h / (r[3] - r[1]);
  return box(parent, x, y, w, h,
    `background:url(${HUD_TEX}) ${-r[0] * sx}px ${-r[1] * sy}px/${TEX_W * sx}px ${TEX_H * sy}px no-repeat;`);
}

function box(parent: HTMLElement, x: number, y: number, w: number, h: number, css = ""): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;box-sizing:border-box;${css}`;
  parent.appendChild(el);
  return el;
}

export class BattleChat {
  private stage: Stage;
  private root: HTMLDivElement;
  private logBox: HTMLElement;
  private field: HTMLInputElement;
  private bar: HTMLElement;
  private hist: HTMLElement;
  private thumb: HTMLElement;
  private tabBox: HTMLElement;
  private tabs: HTMLElement[] = [];
  private comboLabel: HTMLElement;
  private lines: ChatLine[] = [];
  private aging = new ChatAging();
  private openFlag = false;
  private historyOn = false;
  private mode: ChatMode = "all";
  private escAt = -1e9;
  private abort = new AbortController();
  private offLine: () => void;
  private dirty = true;
  private lastN = -1;
  /** history view: lines scrolled back from the newest (wheel / PageUp / PageDown / arrows / thumb); 0 = pinned to the bottom */
  private back = 0;
  /** an arrow held with the cursor free: dir +1 = up (older), -1 = down; t = seconds held */
  private press: { dir: number; t: number } | null = null;
  /** thumb dragged: grab = pointer Y (design px) minus the thumb top at the press */
  private drag: { grab: number } | null = null;

  private constructor(private d: BattleChatDeps) {
    this.stage = new Stage(d.host);
    this.stage.el.style.cssText = "background:transparent;pointer-events:none;z-index:31;";
    // same scale / left anchor as the HUD box (battleChatModel.chatLayout), not the centred letterbox fit
    this.stage.fit = () => {
      const l = chatLayout(this.stage.el.clientWidth || window.innerWidth, this.stage.el.clientHeight || window.innerHeight);
      this.stage.scale = l.scale;
      this.stage.design.style.transformOrigin = "0 0";
      this.stage.design.style.transform = `translate(${l.x}px,${l.y}px) scale(${l.scale})`;
    };
    this.stage.fit();
    this.root = box(this.stage.design, 0, 0, WIN_W, WIN_H, "pointer-events:none;");

    // history set: header, body, footer, arrows, thumb (all 8 on or off together)
    this.hist = box(this.root, 0, 0, WIN_W, WIN_H, "pointer-events:none;");
    for (const [x, y, w, h, r] of HISTORY_SPRITES) sprite(this.hist, x, y, w, h, r);
    this.thumb = sprite(this.hist, THUMB_X, BODY_Y + BODY_H - THUMB_H, THUMB_W, THUMB_H, THUMB);
    this.thumb.style.pointerEvents = "auto";
    this.thumb.style.cursor = "grab";
    this.thumb.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || !this.historyOn) return;
      e.preventDefault();
      this.drag = { grab: this.winY(e) - thumbTop(this.back, maxBack(this.lines.length)) };
    }, { signal: this.abort.signal });
    // up (older) and down (newer) arrows: sprites 3 and 5 of the set, 11 x 8 at (388, 4) and (388, 145); a press scrolls one line
    for (const [y, dir] of [[4, 1], [145, -1]] as const) {
      const arrow = box(this.hist, 388, y, 11, 8, "pointer-events:auto;cursor:pointer;");
      arrow.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || !this.historyOn) return;
        e.preventDefault();
        this.press = { dir, t: 0 };
        this.scrollBy(dir);
      }, { signal: this.abort.signal });
    }
    this.hist.hidden = true;

    // input set: bar + language icon, the combo (target name in the mode colour) and the field; only while the field is open
    this.bar = box(this.root, 0, 0, WIN_W, WIN_H, "pointer-events:none;");
    this.bar.hidden = true;
    sprite(this.bar, -1, BAR_Y, 405, 28, BAR);
    sprite(this.bar, 378, BAR_Y + 4, 21, 21, LANG);
    // combo: 0xa508e0 STBL_IDX_CHAT_TARGET_ALL / _TEAM / _CLAN, text node at (18r, H - 31r)
    this.comboLabel = box(this.bar, 7, 164, 40, 16, `white-space:nowrap;font:${CHAT_FONT};line-height:16px;${SHADOW}pointer-events:auto;cursor:pointer;`);
    // click cycles the channel (comboNext); the bar is hidden while closed, so no hit then
    this.comboLabel.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.setMode(comboNext(this.mode));
      this.field.focus({ preventScroll: true });
    }, { signal: this.abort.signal });
    // the real text field at the field text node (60r, H - 29r)
    this.field = document.createElement("input");
    this.field.type = "text";
    this.field.maxLength = CHAT_MAX;
    this.field.autocomplete = "off";
    this.field.spellcheck = false;
    this.field.style.cssText = `position:absolute;left:49px;top:${BAR_Y + 4}px;width:${378 - 49 - 4}px;height:20px;box-sizing:border-box;`
      + `border:0;outline:0;background:transparent;padding:0;font:${CHAT_FONT};color:#fff;${SHADOW}pointer-events:auto;`;
    this.bar.appendChild(this.field);

    // channel tabs: Todos / Time / Clã / PM (STR_TBL_CHAT_CHANNEL_TYPE_*; PM is shown, not wired), with the field or the history
    this.tabBox = box(this.root, 0, 0, WIN_W, WIN_H, "pointer-events:none;");
    this.tabBox.hidden = true;
    TAB_KEYS.forEach((key, i) => {
      const tab = sprite(this.tabBox, tabX(i), TAB_Y, TAB_W, TAB_H, TAB);
      tab.style.cssText += `display:flex;align-items:center;justify-content:center;white-space:nowrap;color:rgb(204,204,204);font:${CHAT_FONT};${SHADOW}`;
      tab.textContent = tOr(`STR_TBL_CHAT_CHANNEL_TYPE_${key}`, TAB_FALLBACK[i]);
      // clickable with the field or the history open (sets(); exe 0x8c2970 and 0x8c3930 both hit-test them); focus only with the field
      tab.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || !(this.openFlag || this.historyOn)) return;
        e.preventDefault();
        this.setMode(TAB_MODES[i]);
        if (this.openFlag) this.field.focus({ preventScroll: true });
      }, { signal: this.abort.signal });
      this.tabs.push(tab);
    });

    // the log: bottom aligned, oldest line first (no background while closed: sprite 1 belongs to the history set)
    this.logBox = box(this.root, LOG_X, LOG_Y, LOG_W, LOG_H,
      `display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden;font:${CHAT_FONT};line-height:${LINE_PX}px;color:#fff;${SHADOW}word-break:break-word;`);

    this.setMode("all");
    this.wire();
    this.offLine = d.chat.onLine((l) => this.add(l));
    // lines that arrived before this window existed (a battle entered with chat already running)
    for (const l of d.chat.history().slice(-HISTORY_LINES)) this.add(l, true);
  }

  static async create(d: BattleChatDeps): Promise<BattleChat> {
    await loadStrings();
    return new BattleChat(d);
  }

  get isOpen(): boolean { return this.openFlag; }
  get historyOpen(): boolean { return this.historyOn; }

  /** The game's Escape handler asks first: an Escape that just closed the field must not open the ESC menu */
  escConsumed(): boolean { return performance.now() - this.escAt < ESC_GRACE_MS; }

  private wire(): void {
    const sig = this.abort.signal;
    // capture on window: runs before Input's and the game's listeners
    window.addEventListener("keydown", (e) => {
      if (this.openFlag) {
        const eat = () => { e.preventDefault(); e.stopImmediatePropagation(); };
        if (e.code === "Escape") { e.preventDefault(); this.escAt = performance.now(); this.close(); return; }
        if (CHAT_KEYS.modeAll.includes(e.code as never)) { eat(); this.setMode("all"); return; }
        if (CHAT_KEYS.modeTeam.includes(e.code as never)) { eat(); this.setMode("team"); return; }
        if (CHAT_KEYS.modeClan.includes(e.code as never)) { eat(); this.setMode("clan"); return; }
        if (CHAT_KEYS.open.includes(e.code as never)) { e.preventDefault(); this.submit(); return; }
        if (e.code === "PageUp" || e.code === "PageDown") { e.preventDefault(); this.scrollBy(e.code === "PageUp" ? IDLE_LINES - 1 : 1 - IDLE_LINES); return; }
        return; // typing
      }
      if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      if (CHAT_KEYS.history.includes(e.code as never)) {
        if (!this.historyOn && !this.d.canOpen()) return;
        e.preventDefault();
        this.toggleHistory();
        return;
      }
      const team = CHAT_KEYS.openTeam.includes(e.code as never);
      if (!team && !CHAT_KEYS.open.includes(e.code as never)) return;
      if (!this.historyOn && !this.d.canOpen()) return;
      e.preventDefault();
      this.open(team || e.shiftKey ? "team" : this.mode);
    }, { signal: sig, capture: true });
    // wheel with the field or the history open: 3 lines per notch (UIScrollBar tick 10 in the exe: [INFERIDO] 3), down = newer
    window.addEventListener("wheel", (e) => {
      if (!this.openFlag && !this.historyOn) return;
      e.preventDefault();
      this.scrollBy(-Math.sign(e.deltaY) * 3);
    }, { signal: sig, capture: true, passive: false });
    // the field frees the pointer on purpose (exe 0x5222c0): no auto-close on unlock. Alt-tab / window blur still closes it
    window.addEventListener("blur", () => { if (this.openFlag) this.close(); }, { signal: sig });
    // capture: a click while the field is open never reaches main.ts' body listener, which would take the pointer back
    window.addEventListener("click", (e) => { if (this.openFlag || this.historyOn) e.stopPropagation(); }, { signal: sig, capture: true });
    // the thumb drag follows the pointer with the button held; any release ends a press or a drag
    window.addEventListener("mousemove", (e) => {
      if (!this.drag) return;
      this.back = backAt(this.winY(e) - this.drag.grab, maxBack(this.lines.length));
      this.dirty = true;
    }, { signal: sig });
    window.addEventListener("mouseup", () => { this.press = null; this.drag = null; }, { signal: sig });
  }

  /** pointer Y in window design px: the stage is scaled H/768 and left anchored, the root sits at its origin */
  private winY(e: MouseEvent): number { return (e.clientY - this.root.getBoundingClientRect().top) / this.stage.scale; }

  private scrollBy(n: number): void {
    this.back = Math.max(0, Math.min(maxBack(this.lines.length), this.back + n));
    this.dirty = true;
  }

  /** what each sprite set shows: history set with the history, input set with the field, tabs with either */
  private sets(): void {
    this.hist.hidden = !this.historyOn;
    this.bar.hidden = !this.openFlag;
    this.tabBox.hidden = !this.historyOn && !this.openFlag;
    // tabs take the mouse only with the field open (the exe hit-tests them in the open-field handler only)
    for (const t of this.tabs) t.style.pointerEvents = this.openFlag || this.historyOn ? "auto" : "none";
  }

  /** STBL_IDX_GAMEKEY_CHAT_HISTORY (0xa53740): shows the framed log with the whole history; a second press hides it */
  toggleHistory(): void {
    this.historyOn = !this.historyOn;
    this.back = 0;
    this.press = null;
    this.drag = null;
    this.sets();
    if (this.historyOn) {
      // exe 0x8c2970 calls 0x5222c0(0): the cursor shows so the arrows, the thumb and the tabs can be clicked
      if (document.pointerLockElement) document.exitPointerLock();
      const key = CHAT_KEYS.history[0].replace("Key", "");
      this.system(`{col:${CHAT_COLORS.history.join(",")},255}${tOr("STBL_IDX_CHATMESSAGE_HISTORY_ENABLE1", "Histórico de conversa ativado.")}{/col}`);
      this.system(`{col:${CHAT_COLORS.history.join(",")},255}'${key}'${tOr("STBL_IDX_CHATMESSAGE_HISTORY_ENABLE2", "Ativa e desativa histórico de conversa.")}{/col}`);
    } else if (!this.openFlag) this.relock();
    this.dirty = true;
  }

  open(mode: ChatMode = this.mode): void {
    if (this.openFlag) return;
    this.openFlag = true;
    this.back = 0;
    this.d.input.setChatOpen(true);
    // exe 0x5222c0(0): the cursor shows so the tabs and the combo can be clicked
    if (document.pointerLockElement) document.exitPointerLock();
    this.sets();
    this.field.value = "";
    this.setMode(mode);
    this.dirty = true;
    this.field.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    this.back = 0;
    this.field.blur();
    this.field.value = "";
    this.sets();
    this.d.input.setChatOpen(false);
    if (!this.historyOn) this.relock();
    this.dirty = true;
  }

  /** exe 0x5222c0(1): the pointer goes back to the game. Enter (submit) is a user gesture; Escape is not, so after Escape
   *  the lock may fail and the next click on the game re-locks it (main.ts body listener) */
  private relock(): void {
    if (document.pointerLockElement !== document.body) {
      lockPointer().catch(() => { /* no user gesture: the next click re-locks */ });
    }
  }

  private setMode(m: ChatMode): void {
    if (m === "clan" && !this.d.inClan()) {
      // 0xa4f7b8: no clan chat for a player outside a clan: the notice and back to general
      this.system(tOr("STR_TBL_CHAT_INGAME_NOTICE_NO_JOIN_CLAN", "<Não está cadastrado em Clã>"));
      m = "all";
    }
    if (m === "whisper" && !this.d.chat.lastWhisper) {
      // no PM target yet (the last /pm or whisper received): the exe's notice, the channel stays
      this.system(tOr("STR_TBL_CHAT_NOTICE_WARNING_WHISPER", "Não é possível enviar mensagem pessoal ao usuário."));
      return;
    }
    this.mode = m;
    this.field.style.color = modeColor(m);
    // combo text: STBL_IDX_CHAT_TARGET_ALL / _TEAM in the mode colour (0xa508e0); PM shows its target [INFERIDO: the exe's PM label]
    const label = m === "team" ? tOr("STBL_IDX_CHAT_TARGET_TEAM", "Equipe")
      : m === "clan" ? tOr("STBL_IDX_CHAT_TARGET_CLAN", "Clã")
      : m === "whisper" ? this.d.chat.lastWhisper
        : tOr("STBL_IDX_CHAT_TARGET_ALL", "Todos");
    this.comboLabel.textContent = label;
    this.comboLabel.style.color = modeColor(m);
  }

  private system(text: string): void { this.d.chat.system(text); }

  private submit(): void {
    const text = this.field.value.trim();
    this.close();
    if (!text) return;
    if (text.startsWith("/")) {
      const c = parseChatCommand(text);
      if (c) { this.run(c); return; }
      if (this.d.command(text)) return;
    }
    if (this.mode === "whisper") { this.d.chat.whisper(this.d.chat.lastWhisper, text); return; }
    if (this.mode === "clan") { this.d.chat.sendClan(text); return; }
    this.d.chat.send(this.mode === "team" ? ChatType.TEAM : ChatType.ROOM, text);
  }

  private run(c: NonNullable<ReturnType<typeof parseChatCommand>>): void {
    const chat = this.d.chat;
    switch (c.kind) {
      case "help": // CGameChatBox 0x4d5bb0: STBL_IDX_CHATMESSAGE_HELP1..6 (+ the clan-mode line)
        for (const k of ["HELP1", "HELP2", "HELP3", "HELP4", "HELP5", "HELP6"]) this.system(tOr(`STBL_IDX_CHATMESSAGE_${k}`, ""));
        return;
      case "clear": this.lines = []; this.aging.clear(); this.dirty = true; return;
      case "team": if (c.text) chat.send(ChatType.TEAM, c.text); else this.setMode("team"); return;
      case "reply":
        if (!chat.lastWhisper) { this.system(tOr("STR_TBL_CHAT_NOTICE_WARNING_WHISPER", "Não é possível enviar mensagem pessoal ao usuário.")); return; }
        if (c.text) chat.whisper(chat.lastWhisper, c.text);
        return;
      case "whisper":
        if (!c.nick || !c.text) { this.system(tOr("STR_TBL_CHAT_NOTICE_WARNING_WHISPER", "Não é possível enviar mensagem pessoal ao usuário.")); return; }
        chat.whisper(c.nick, c.text);
        return;
    }
  }

  private add(l: ChatLine, quiet = false): void {
    this.lines.push(l);
    while (this.lines.length > HISTORY_LINES) this.lines.shift();
    if (!quiet) this.aging.push(); // lines from before the window existed only go to the history
    if (this.historyOn && this.back > 0) this.back = Math.min(this.back + 1, maxBack(this.lines.length)); // keep the lines being read in place
    this.dirty = true;
  }

  private lineEl(spans: Span[]): HTMLElement {
    const el = document.createElement("div");
    for (const s of spans) {
      const sp = document.createElement("span");
      if (s.color) sp.style.color = s.color;
      sp.textContent = s.text; // textContent only
      el.appendChild(sp);
    }
    return el;
  }

  /** every frame (dt in seconds, real time) */
  update(dt: number): void {
    if (!this.historyOn) this.aging.tick(dt);
    // an arrow held past HOLD_S scrolls every frame [INFERIDO: the exe repeats its hit test each frame with the flag set]
    if (this.press) { this.press.t += dt; if (this.press.t > HOLD_S) this.scrollBy(this.press.dir); }
    this.back = Math.min(this.back, maxBack(this.lines.length)); // the ring can shrink (/apagar)
    const full = this.historyOn;
    const n = full ? IDLE_LINES : this.aging.shown();
    if (!this.dirty && n === this.lastN) return;
    this.lastN = n;
    this.dirty = false;
    const end = this.lines.length - (full ? this.back : 0);
    const from = Math.max(0, end - n);
    // scroll thumb: bottom of the body = newest page [INFERIDO: the exe centres it at body bottom - scroll x 111r, 0x8c3394]
    this.thumb.style.top = `${thumbTop(this.back, maxBack(this.lines.length))}px`;
    const gm = tOr("STR_TBL_CHAT_GM_TEXT", "GM");
    this.logBox.replaceChildren(...this.lines.slice(from, end).map((l) => this.lineEl(formatLine(l, { gm }))));
  }

  dispose(): void {
    this.abort.abort();
    this.offLine();
    if (this.openFlag) this.d.input.setChatOpen(false);
    this.root.remove();
    this.stage.destroy();
  }
}
