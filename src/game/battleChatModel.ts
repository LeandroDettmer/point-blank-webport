// Pure part of the in-battle chat (no DOM, so src/game/dev/battleChat.smoke.node.ts can run it): line text / colours, the "/"
// commands and the idle aging of the 2017 client's CGameChatBox. Addresses are PointBlank.exe 2017 VAs (
//).
import type { ChatLine } from "../net/chatClient.ts";

export type RGB = readonly [number, number, number];
/** Get_ColorCashItemString 0x4ac1c0: the 11 nick colours (table 0xb2fe2c, index = the account's nick colour, 0 = white) */
export const NICK_COLORS: readonly RGB[] = [
  [255, 255, 255], [121, 23, 0], [227, 96, 0], [255, 211, 3], [196, 213, 0], [128, 217, 0], [32, 171, 0], [3, 181, 255], [0, 96, 227], [0, 35, 107], [115, 37, 117],
];
/** CGameChatBox::PutUserChat 0x4d5cb0 / PutWhisper 0x4d6280 text colours */
export const CHAT_COLORS = {
  all: [255, 255, 255] as RGB,
  team: [98, 180, 253] as RGB,
  clan: [80, 255, 60] as RGB,
  whisper: [237, 86, 250] as RGB,
  /** nick of a GM line (flag byte of PutUserChat): "247,200,60,255" at 0xb37208; of a GM whisper "255,128,64,255" at 0xb372fc */
  gm: [247, 200, 60] as RGB,
  gmWhisper: [255, 128, 64] as RGB,
  /** history on / key help lines: "{col:255,120,0,255}%s{/col}" (0xa53740) */
  history: [255, 120, 0] as RGB,
};
export const rgb = (c: RGB): string => `rgb(${c[0]},${c[1]},${c[2]})`;

/** Cross CBattleChatBox idle log (0x8c33a0): 100-line rings (wrap 0x63/0x64); the closed box shows 8 (count > 8 drops the oldest at once, 0x8c345a; build loop bound 8, 0x8c354a); one shared timer drops the oldest shown line every 5.0 s without a new line (0x8c3414, 0x4d7f50), no fade (the log node stays 255,255,255,255). Same values as the 2017 CGameChatBox (0xa52860 / 0xa527c0). */
export const HISTORY_LINES = 100;
export const IDLE_LINES = 8;
export const AGE_S = 5;

/** how many of the newest lines the closed box still shows */
export class ChatAging {
  count = 0;
  private t = 0;
  push(): void { this.count = Math.min(HISTORY_LINES, this.count + 1); }
  /** 0xa527c0: the timer runs while there is a line; at > 5 s a line is dropped and the timer restarts */
  tick(dt: number): void {
    if (this.count <= 0) return;
    this.t += dt;
    if (this.t > AGE_S) { this.t = 0; this.count--; }
  }
  clear(): void { this.count = 0; this.t = 0; }
  /** lines drawn when the box is closed */
  shown(): number { return Math.min(IDLE_LINES, this.count); }
}

/** channel of the input bar (the combo and the field colour follow it) */
export type ChatMode = "all" | "team" | "clan" | "whisper";
/** header tabs left to right: Todos / Time / Clã / PM (STR_TBL_CHAT_CHANNEL_TYPE_*). Tab i selects [i]: exe CBattleChatBox
 *  tab hit-test 0x8c3d6d..0x8c3e15 -> SetChannel 0x8c7f60(i) (i = 0 all, 1 team, 2 clan, 3 whisper) */
export const TAB_MODES: readonly ChatMode[] = ["all", "team", "clan", "whisper"];
/** tab i left edge in window px: first tab at x 12 r of the screen = 1 px inside the window, 42 px pitch (exe 0x8c3d6d sprite rects) */
export const tabX = (i: number): number => 1 + 42 * i;
/** history scroll (exe 0x8c2970): lines back from the newest, the top page is `lines - IDLE_LINES` back */
export const maxBack = (lines: number): number => Math.max(0, lines - IDLE_LINES);
/** scroll thumb track: top at the body top (21), bottom at body bottom - thumb height (114 - 23 = 91); the exe centres the thumb
 *  on the scroll position (0x8c3394 [INFERIDO]) and maps the mouse Y to it while dragged (0x8c32c4, 114 = body height) */
export const THUMB_TOP = 21, THUMB_RANGE = 91;
/** thumb top for `back` lines back (0 = newest page, at the bottom); max = maxBack */
export function thumbTop(back: number, max: number): number {
  const f = max > 0 ? Math.min(1, back / max) : 0;
  return THUMB_TOP + THUMB_RANGE * (1 - f);
}
/** lines back for a thumb dragged to `top` (clamped to the track) */
export function backAt(top: number, max: number): number {
  const f = Math.min(1, Math.max(0, (top - THUMB_TOP) / THUMB_RANGE));
  return Math.round((1 - f) * max);
}

/** click on the input bar's left sprite cycles the channel: all -> team -> clan -> all (exe 0x8c3cf0..0x8c3d36: 1 -> team, 4 -> clan, 5 -> all)
 *  [INFERIDO] which bar sprite owns this hit: the other bar hit (0x8c3ba3, sprite 0x70 index 2/3) cycles in another order */
export const comboNext = (m: ChatMode): ChatMode => (m === "all" ? "team" : m === "team" ? "clan" : "all");

export interface Span { text: string; color: string | null }

/** "{col:r,g,b,a}text{/col}" (the client's markup in its strings): spans with their colour, textContent-safe */
export function parseMarkup(s: string): Span[] {
  const out: Span[] = [];
  const re = /\{col:\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*\d+\s*\}|\{\/col\}/g;
  let cur: string | null = null, last = 0, m: RegExpExecArray | null;
  const put = (t: string) => { if (t) out.push({ text: t, color: cur }); };
  while ((m = re.exec(s))) {
    put(s.slice(last, m.index));
    cur = m[1] !== undefined ? `rgb(${+m[1]},${+m[2]},${+m[3]})` : null;
    last = m.index + m[0].length;
  }
  put(s.slice(last));
  return out;
}

export interface LineTexts { gm: string }

/**
 * One chat line as the client prints it. Player lines: "[nick] text" (0xb372c8, 0xb372cc), nick in the account's nick
 * colour (all) / team blue (team) / GM gold, text in the channel colour (all white, team blue, clan green). A whisper from another
 * player is all {237,86,250} (GM nick {255,128,64}); the echo of my own is "[To:nick] text" (0xa508a0). A server
 * line has no nick and keeps the markup of its string (GameUI::PrintSystemChat 0xa60fd0 = _PutStringBuffer type 0).
 */
export function formatLine(l: ChatLine, tr: LineTexts = { gm: "GM" }): Span[] {
  if (l.kind === "system") return parseMarkup(l.text);
  if (l.kind === "whisper") {
    if (l.to) return [{ text: `[To:${l.to}] ${l.text}`, color: rgb(CHAT_COLORS.whisper) }];
    return [{ text: `[${l.nick}] ${l.text}`, color: rgb(l.gm ? CHAT_COLORS.gmWhisper : CHAT_COLORS.whisper) }];
  }
  const text = rgb(l.kind === "team" ? CHAT_COLORS.team : l.kind === "clan" ? CHAT_COLORS.clan : CHAT_COLORS.all);
  const nick = l.gm ? CHAT_COLORS.gm : l.kind === "team" ? CHAT_COLORS.team : NICK_COLORS[l.color] ?? NICK_COLORS[0];
  return [
    { text: `[${l.gm ? `${tr.gm} ` : ""}${l.nick}] `, color: rgb(nick) },
    { text: l.text, color: text },
  ];
}

export type ChatCommand =
  | { kind: "whisper"; nick: string; text: string }
  | { kind: "reply"; text: string }
  | { kind: "team"; text: string }
  | { kind: "clear" }
  | { kind: "help" };

const WHISPER = ["/pm", "/w"], REPLY = ["/resp", "/r"], TEAM = ["/time", "/t"], CLEAR = ["/apagar", "/c"], HELP = ["/ajuda", "/help"];

/**
 * Commands of UIHUDIngameChat 0xa508e0 (STR_TBL_CHAT_HOTKEY_*, BR table): /pm /w whisper, /resp /r reply to the last whisper, /time /t team
 * line, /apagar /c clear the history, /ajuda /help the key help. Upper-case twins (/W /R /T /C) match too. The "/?" aliases of the
 * table are the Korean ones turned into "?" by the BR export and are not matched. null = not a client command.
 */
export function parseChatCommand(line: string): ChatCommand | null {
  const m = /^(\/\S+)(?:\s+(.*))?$/.exec(line.trim());
  if (!m) return null;
  const cmd = m[1].toLowerCase(), rest = (m[2] ?? "").trim();
  if (HELP.includes(cmd)) return { kind: "help" };
  if (CLEAR.includes(cmd)) return { kind: "clear" };
  if (REPLY.includes(cmd)) return { kind: "reply", text: rest };
  if (TEAM.includes(cmd)) return { kind: "team", text: rest };
  if (WHISPER.includes(cmd)) {
    const q = /^"([^"]*)"\s*(.*)$/.exec(rest);
    if (q) return { kind: "whisper", nick: q[1], text: q[2].trim() };
    const i = rest.search(/\s/);
    return i < 0 ? { kind: "whisper", nick: rest, text: "" } : { kind: "whisper", nick: rest.slice(0, i), text: rest.slice(i).trim() };
  }
  return null;
}

/**
 * Where the chat window sits on screen, from the Cross exe (PBCross PointBlank.exe, CBattleChatBox layout 0x8c26e0 / 0x8c2970):
 * x = 11 * H/768 (ratio of getHeightRatioBy768), y = viewH - 195 * H/768, so the 403 x 157 window ends 38 design px above the bottom.
 * Scale H/768, left anchored, never letterboxed (the HUD box rule). The open input bar (SetInputMode 0x8c2200: y H - 38, 28 tall)
 * sits below the window, over the bottom-left HUD block.
 */
export const CHAT_X = 11;
export const CHAT_Y = 768 - 195;
export function chatLayout(W: number, H: number): { scale: number; x: number; y: number } {
  const scale = H / 768;
  return { scale, x: CHAT_X * scale, y: CHAT_Y * scale };
}
