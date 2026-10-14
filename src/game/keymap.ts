// Default PB key map, exe-2017 GAME_KEY_STRUCT[48]: the real client's saved row in
// the server DB seed (player_configs.keyboard_keys), slot -> stroke bit from the jump table 0x51f6b0. The only place the
// in-battle keys are named: player.ts (movement), game.ts (weapons, drop, radio, scoreboard), main.ts (help text).
// PB has no lean slot; C is the third radio menu, not crouch.

export const PB_KEYS = {
  /** slots 1-4, stroke 0x1 / 0x4 / 0x8 / 0x2 */
  left: ["KeyA"],
  right: ["KeyD"],
  forward: ["KeyW"],
  back: ["KeyS"],
  /** slot 5, 0x10 */
  jump: ["Space"],
  /** slot 6 = LCtrl (I3I_KEY 40), 0x80 */
  crouch: ["ControlLeft", "ControlRight"],
  /** slot 7 = LShift (38), 0x40: walk (silent) */
  walk: ["ShiftLeft", "ShiftRight"],
  /** slot 11, 0x20 */
  reload: ["KeyR"],
  /** slot 12 (T): respawn weapon change (respawnSelect.ts CHANGE_WEAPON_KEY) */
  changeWeapon: ["KeyT"],
  /** slots 13-18 = 1-6, 0x800 .. 0x10000: usage slots primary, secondary, melee, throw, special (5 = smoke / flash) */
  slots: ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6"],
  /** slot 19, 0x20000: last weapon (ProcessWeapon 0xa23639) */
  lastWeapon: ["KeyQ"],
  /** slot 22, hi 0x100: drop weapon (ProcessDropWeapon 0xa21070) */
  drop: ["KeyG"],
  /** slots 32-34, 0x4000000 / 0x8000000 / 0x10000000: radio menus (see gameplay/pbRadio.ts RADIO_KEYS) */
  radio: ["KeyZ", "KeyX", "KeyC"],
  /** slot 35, 0x400: mode action (bomb install / defuse only, 0xa23742) — no bomb mode in the web client */
  action: ["KeyE"],
  /** slot 40, hi 0x8000: extension toggle (laser, WeaponDotLaser; bound in weapons/laser.ts) */
  extension: ["KeyB"],
  /** slot 8, hi 0x400 (F, "not traced" in the key map): Dual extension, single <-> dual item (pef Extension2 Type, WeaponSystem.toggleDual) [INFERIDO: the slot's use is not decoded] */
  extension2: ["KeyF"],
  /** scoreboard (Tab is not a game-key slot: the HUD reads it directly) */
  scoreboard: ["Tab"],
} as const;

export type PbKeyAction = keyof typeof PB_KEYS;

export interface KeySource {
  key(code: string): boolean;
  keyPressed(code: string): boolean;
}

export const held = (inp: KeySource, a: PbKeyAction) => PB_KEYS[a].some((c) => inp.key(c));
export const pressed = (inp: KeySource, a: PbKeyAction) => PB_KEYS[a].some((c) => inp.keyPressed(c));

/** Slot index 0..4 pressed this frame (keys 1-5), or null. */
export function slotPressed(inp: KeySource): number | null {
  const i = PB_KEYS.slots.findIndex((c) => inp.keyPressed(c));
  return i >= 0 ? i : null;
}

/**
 * In-battle chat and vote keys (not part of the 48-slot GAME_KEY_STRUCT row above).
 * - F2 / F3 switch the chat mode (all / team): client text STBL_IDX_CHATCOMBOBOX_TT "F2 chat geral / F3 chat do time"
 *   and STBL_IDX_CHATMESSAGE_HELP1/2. CONFIRMED by the strings.
 * - 9 / 0 vote Yes / No: client text STR_HUD_FORCIBLYREMOVE_KEY_AGREE "Aceitar (Key #9)" / KEY_REVERSE "Negar (Key #0)".
 *   CONFIRMED by the strings.
 * - Enter opens the chat field for everybody, Shift+Enter or Y for the team: [INFERIDO] (the exe's chat key handler was not
 * read; phase 0). Y is the team shortcut of many FPS games, not from the client.
 */
export const CHAT_KEYS = {
  /** [INFERIDO] open the field in the current mode (all unless Shift is held = team) */
  open: ["Enter", "NumpadEnter"],
  /** [INFERIDO] open the field in team mode */
  openTeam: ["KeyY"],
  /** field open: mode all / team (client strings) */
  modeAll: ["F2"],
  modeTeam: ["F3"],
  /** F4 clan chat (STBL_IDX_CHATCOMBOBOX_TT): a player outside a clan gets STR_TBL_CHAT_INGAME_NOTICE_NO_JOIN_CLAN (0xa4f7b8) and stays in all */
  modeClan: ["F4"],
  /** slot 30 (hi 0x10, STBL_IDX_GAMEKEY_CHAT_HISTORY): default binding I3I_KEY 21 = L; toggles the history view (0xa53740) */
  history: ["KeyL"],
  voteYes: ["Digit9", "Numpad9"],
  voteNo: ["Digit0", "Numpad0"],
} as const;
