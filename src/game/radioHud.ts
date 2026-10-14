import * as THREE from "three";
import {
  RADIO_ITEMS, RadioMenu, parseRadioId, radioRule, radioSoundFile, radioStringKey, type RadioType,
} from "../gameplay/pbRadio";
import { getSettings } from "../gameplay/settings";
import { effectsBus, soundInfo } from "../gameplay/soundMix";
import { loadClip } from "../audioUrl";
import { FONTS } from "../lobby/ui/assets.ts";
import { loadStrings } from "../lobby/ui/i18n.ts";
import { chat } from "../net/chatClient";

/*
 * Radio Z / X / C on screen (gameplay/pbRadio.ts has the exe rules). Texts from the Cross client string table
 * (public/assets/ui/cross/strings.json, STBL_IDX_RADIOMSG_*_KR<n>), voices from Cross Sound_voice_Radio_*.i3Pack (PT-BR)
 * (public/assets/sfx/radio/{Man,Women}, same file names as the exe table 0xd5b150). The 2017 client prints the radio in
 * the battle chat ("[Radio] %s"). The Cross exe menu (PointBlank.exe, CHud, RE 2026-10-13) is 12 i3TextNodeDX2 rows and
 * no sprite: CHud::<text create> 0x739bd0 (loop at 0x73af8f, nodes this+0x2a4) and the per-frame update 0x747ee0.
 */

const SOUND_BASE = "/assets/sfx/radio/";
const CHAT_LIFE = 8; // s [RECRIADO]
const CHAT_MAX = 6;

/** exe 0x739bd0 (Cross): 12 rows, this+0x2a4. Font: CreateFont "Arial" (0x69e8c0 SetFontName, 0xb21348), size 10 (push 0xa), weight 400 (0x190), colour RGBA (80,255,60,255) (SetColor 0x73b014) [INFERIDO: size 10 read as px] */
const ROW_COUNT = 12;
const ROW_X = 20; // exe setPos x = 0x14
/** row 0 (title) at viewer H-490; rows 1..11 at H-480+13*row (0x73b038..0x73b06f). The exe does not scale them: px from the bottom edge */
const rowTop = (i: number) => (i === 0 ? "calc(100% - 490px)" : `calc(100% - ${480 - 13 * i}px)`);
const ROW_CSS = `position:absolute;left:${ROW_X}px;font:400 10px/1 ${FONTS.hudText};color:rgb(80,255,60);white-space:nowrap;text-shadow:none;display:none`;

/** decoded voices by file, shared by every RadioHud and preloadRadioVoices (match preload): one fetch + decode per file, on three's AudioContext like the other match sounds */
const loader = new THREE.AudioLoader();
const clips = new Map<string, Promise<AudioBuffer | null>>();
function clip(f: string): Promise<AudioBuffer | null> {
  let p = clips.get(f);
  if (!p) clips.set(f, (p = loadClip(loader, SOUND_BASE + f).then((b) => b, () => null)));
  return p;
}

/** Match preload (game/matchPreload.ts): every radio voice (CMD / REQ / STT menus + AUTO "Granada!") of these voice sets. */
export async function preloadRadioVoices(voices: Iterable<"Man" | "Women">): Promise<void> {
  const files: string[] = [];
  for (const v of voices) {
    for (const t of [0, 1, 2] as const) for (let i = 1; i <= RADIO_ITEMS[t]; i++) files.push(radioSoundFile(t, i, v)!);
    files.push(radioSoundFile(3, 1, v)!);
  }
  await Promise.all(files.map(clip));
}

let stringsP: Promise<Record<string, string>> | null = null;
function loadRadioStrings(): Promise<Record<string, string>> {
  stringsP ??= loadStrings()
    .then((j: Record<string, string>) => {
      const out: Record<string, string> = {};
      for (const k of Object.keys(j)) if (k.startsWith("STBL_IDX_RADIOMSG_") || k === "STR_POPUP_RADIO_MESSAGE") out[k] = j[k];
      return out;
    })
    .catch(() => ({}));
  return stringsP;
}

export class RadioHud {
  readonly menu = new RadioMenu();
  private strings: Record<string, string> = {};
  private root: HTMLDivElement;
  private rows: HTMLDivElement[] = [];
  private chatEl: HTMLDivElement;
  private lines: { el: HTMLDivElement; t: number }[] = [];
  private shownMenu: 0 | 1 | 2 | null = null;
  private voices = new Set<AudioBufferSourceNode>();

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement("div");
    this.root.id = "pbradio";
    this.root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:30;font:bold 13px/1.35 " + FONTS.hudText + ";color:#fff;text-shadow:1px 1px 0 #000";
    for (let i = 0; i < ROW_COUNT; i++) {
      const el = document.createElement("div");
      el.style.cssText = ROW_CSS + ";top:" + rowTop(i);
      this.rows.push(el);
    }
    this.chatEl = document.createElement("div");
    this.chatEl.style.cssText = "position:absolute;left:12px;bottom:190px;max-width:50%";
    this.root.append(...this.rows, this.chatEl);
    parent.appendChild(this.root);
    void loadRadioStrings().then((s) => (this.strings = s));
  }

  text(type: RadioType, index: number): string {
    return this.strings[radioStringKey(type, index)] ?? this.strings[radioStringKey(type, index, false)] ?? `Radio ${type}-${index}`;
  }

  /** menu row text as the exe builds it (0x747ee0): row 0 = title, row n = "<n % 10>. " + string; empty string = row hidden */
  private rowText(type: RadioType, row: number): string {
    const s = this.strings[radioStringKey(type, row)] ?? this.strings[radioStringKey(type, row, false)] ?? "";
    return !s ? "" : row === 0 ? s : `${row % 10}. ${s}`;
  }

  /** Key press while alive in battle. Returns the id to send (the caller plays / sends it), or null; consumed = digit eaten. */
  press(code: string): { send: number | null; consumed: boolean } {
    return this.menu.press(code);
  }

  /** Incoming (or own) radio: 0xa004d0 team filter, chat line, voice. */
  receive(id: number, nick: string, senderTeam: number, localTeam: number, voice: "Man" | "Women" = "Man"): boolean {
    if (!getSettings().radioMessage) return false; // Option > Sound: Mensagem de rádio off
    const rule = radioRule(id, senderTeam, localTeam);
    if (!rule.show) return false;
    const { type, index } = parseRadioId(id);
    if (rule.chat) {
      // 0xa004d0: PutUserChat(nick, "[Radio] %s", type 0) = a line of the one battle chat box; the own list is only for offline (no chat connection)
      if (chat.connected) chat.push({ kind: "all", nick, gm: false, color: 0, text: `[Radio] ${this.text(type, index)}` });
      else this.chat(`${nick}: [Radio] ${this.text(type, index)}`);
    }
    if (rule.sound) this.play(type, index, voice);
    return true;
  }

  private play(type: RadioType, index: number, voice: "Man" | "Women"): void {
    const f = radioSoundFile(type, index, voice);
    if (!f) return;
    void clip(f).then((buf) => {
      if (!buf) return;
      try {
        const ctx = THREE.AudioContext.getContext();
        const src = ctx.createBufferSource(), gain = ctx.createGain();
        src.buffer = buf;
        // StartRadioMessage 0x699850: 2D (0x699c50 listener flag 1) at the clip's listener volume (Voice.RSC MV_Radio_*: 100),
        // under the effects group (live gauge), not under the flash duck of the battle listener
        gain.gain.value = soundInfo(f).lvol / 100;
        src.connect(gain).connect(effectsBus(ctx));
        src.onended = () => this.voices.delete(src);
        this.voices.add(src);
        src.start();
      } catch { /* no audio in this context */ }
    });
  }

  private chat(s: string): void {
    const el = document.createElement("div");
    el.style.color = "#62b4fd"; // the exe's radio colour {col:98,180,253}
    el.textContent = s;
    this.chatEl.appendChild(el);
    this.lines.push({ el, t: CHAT_LIFE });
    while (this.lines.length > CHAT_MAX) this.lines.shift()!.el.remove();
  }

  update(dt: number, visible: boolean): void {
    this.root.style.display = visible ? "" : "none";
    for (const l of this.lines) l.t -= dt;
    while (this.lines.length && this.lines[0].t <= 0) this.lines.shift()!.el.remove();
    const open = this.menu.open;
    if (open === this.shownMenu) return;
    this.shownMenu = open;
    for (let i = 0; i < ROW_COUNT; i++) {
      // exe 0x748082 / 0x748293: the Z and X menus skip row 9 (8 items); the C menu (0x748455) has no skip
      const s = open === null || (i === 9 && open !== 2) ? "" : this.rowText(open, i);
      this.rows[i].textContent = s;
      this.rows[i].style.display = s ? "" : "none";
    }
  }

  dispose(): void {
    this.root.remove();
    for (const v of this.voices) try { v.stop(); } catch { /* already ended */ }
    this.voices.clear();
  }
}
