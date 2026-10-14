// Radio messages, exe-2017. Pure logic: src/game/radioHud.ts draws
// the menu / chat lines and plays the sounds.
//
//  - Keys: game-key slots 32-34 = Z / X / C (stroke 0x4000000 / 0x8000000 / 0x10000000) open the three menus
//    (RADIOCHAT_TYPE 0 CMD "Mensagem de time", 1 REQ "Mensagem de pedido", 2 STT "Mensagem de informação"); type 3 AUTO
//    is sent by the game itself (WeaponGrenade::Throw 0x62ebb3: PlayRadioMessageSound(3, 1) + radio 0x1f "Granada!").
//  - Wire: WriteGameEvent_RadioChat 0x9fba70 -> CharaInfo +0x1c = id = type * 10 + index (menu 0x753874), +0x1d = portal
//    (map sector) id, event flag 0x20. Server.Match relays the 2 bytes (RadioChat.cs) to every slot.
//  - Receive (_ProcessRecvPacket_Chara_RadioChat 0xa004d0): only when the sender is on the local player's team; type < 3
//    -> chat line "[Radio] %s" (+ " {col:98,180,253}[sector]" when the map has a sector name), type 3 -> chat line unless
//    index 1 (the grenade call is voice only); then PlayRadioMessageSound(type, index, sender).
//  - Text: CGameContext::GetRadioMessage 0x593b30 = string table STBL_IDX_RADIOMSG_{CMD,REQ,STT,AUTO}_KR<index> (voice
//    option 1) or _US<index>. Sound: PlayRadioMessageSound 0x5939e0 -> table index = base + index, base KR 0 / 20 / 40 /
//    120 (US 60 / 80 / 100 / 123), table 0xd5b150 (12 bytes per entry: Man, Women, Dino file) loaded by 0x698ca0;
//    StartRadioMessage 0x699850 picks column 1 for a female character, 2 for a dino, else 0.

export type RadioType = 0 | 1 | 2 | 3;
export const RADIO_TYPE_KEYS: Record<0 | 1 | 2, string> = { 0: "CMD", 1: "REQ", 2: "STT" };

/** Menu entries per type: index 1..n (KR strings present in pt-BR.json); 0 = the menu title, 10 = "Cancelar" */
export const RADIO_ITEMS: Record<0 | 1 | 2, number> = { 0: 8, 1: 8, 2: 9 };

/** game-key slots 32-34 -> KeyboardEvent.code (default binding, server player_configs.keyboard_keys) */
export const RADIO_KEYS: Record<string, 0 | 1 | 2> = { KeyZ: 0, KeyX: 1, KeyC: 2 };

export const radioId = (type: RadioType, index: number) => (type * 10 + index) & 0xff;
export const parseRadioId = (id: number): { type: RadioType; index: number } => ({ type: Math.floor(id / 10) as RadioType, index: id % 10 });
export const radioValid = (id: number) => {
  const { type, index } = parseRadioId(id);
  return type === 3 ? index === 1 : type <= 2 && index >= 1 && index <= RADIO_ITEMS[type as 0 | 1 | 2];
};

export function radioStringKey(type: RadioType, index: number, kr = true): string {
  const t = type === 3 ? "AUTO" : RADIO_TYPE_KEYS[type];
  return `STBL_IDX_RADIOMSG_${t}_${kr ? "KR" : "US"}${index}`;
}

/** Sound file (voice KR = the locale voice: Cross Sound_voice_Radio_*.i3Pack, PT-BR) for the 0xd5b150 table entry. */
export function radioSoundFile(type: RadioType, index: number, voice: "Man" | "Women" = "Man"): string | null {
  if (!radioValid(radioId(type, index))) return null;
  const p = voice === "Women" ? "WV" : "MV";
  // KR bases 0 / 20 / 40 / 120 -> entries MV_Radio_K<n>, MV_Radio_Group_K<n>, MV_Radio_Answer_K<n>, MV_Auto_K<n>
  const stem = type === 0 ? "Radio_K" : type === 1 ? "Radio_Group_K" : type === 2 ? "Radio_Answer_K" : "Auto_K";
  return `${voice}/${p}_${stem}${index}.wav`;
}

/** Receiver filter + chat rule of 0xa004d0 */
export function radioRule(id: number, senderTeam: number, localTeam: number): { show: boolean; chat: boolean; sound: boolean } {
  if (!radioValid(id) || senderTeam !== localTeam) return { show: false, chat: false, sound: false };
  const { type, index } = parseRadioId(id);
  return { show: true, chat: type < 3 || index !== 1, sound: true };
}

/**
 * Z / X / C menu. [RECRIADO] interaction: the key opens its menu (the same key again or 0 closes it, another radio key
 * switches menus), a digit 1..n sends that entry and closes the menu. The menu handler (0x752ad0) builds the id the same
 * way (type * 10 + entry); its exact key handling and auto-close time were not decoded.
 */
export class RadioMenu {
  open: 0 | 1 | 2 | null = null;

  /** Feeds one key press (KeyboardEvent.code). Returns the radio id to send, or null. `consumed` = digit eaten. */
  press(code: string): { send: number | null; consumed: boolean } {
    const t = RADIO_KEYS[code];
    if (t !== undefined) {
      this.open = this.open === t ? null : t;
      return { send: null, consumed: true };
    }
    if (this.open === null) return { send: null, consumed: false };
    const m = /^(Digit|Numpad)(\d)$/.exec(code);
    if (!m) return { send: null, consumed: false };
    const n = Number(m[2]);
    const type = this.open;
    if (n === 0) {
      this.open = null;
      return { send: null, consumed: true };
    }
    if (n > RADIO_ITEMS[type]) return { send: null, consumed: true };
    this.open = null;
    return { send: radioId(type, n), consumed: true };
  }

  close(): void {
    this.open = null;
  }
}
