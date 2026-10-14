// GM observer shortcuts: the keyboard block of CStageBattle::ProcessObserverMode
// (Cross 0x76091e; 2017 0x76ab80) that only runs for a GM observer (Cross 0x6aa770, 2017 CPlayer 0x6b4a30; [INFERIDO] gate names).
// Key list = the client's help window help_observer.i3i. I3I key codes 44 / 94 / 95 (Space, [, ]) come from the 2017 table [INFERIDO]. Pure logic (no three / DOM), shared by game.ts and
// dev/observerGm.smoke.node.ts. What the help image does not give (saved-position contents, wheel step and limits) is [INFERIDO].

export type GmAction =
  | { t: "prevTarget" } | { t: "nextTarget" } | { t: "viewFly" }
  | { t: "savePos"; n: number } | { t: "gotoPos"; n: number }
  | { t: "toggleHud" } | { t: "toggleNicks" } | { t: "nickSize"; d: 1 | -1 } | { t: "toggleIds" }
  | { t: "pickPlayer"; team: 0 | 1; n: number };

const DIGIT = /^(?:Digit|Numpad)(\d)$/;

/**
 * Shift+1 previous character, Shift+2 next, Shift+3 Flying View, Ctrl+0..9 save the camera position, 0..9 go to it, F5 HUD on / off.
 * Without Shift / Ctrl (the GM block 0x76b124 skips the rest when one is held): ` (I3I_KEY 0x65 = VK_OEM_3) nicks on / off (0x77ed50),
 * = / - (I3I_KEY 0x5c VK_OEM_PLUS / 0x5b VK_OEM_MINUS, not the numpad) nick size (CHud 0x7445c0). F9 (I3I_KEY 0x47) is read by
 * CHud::OnUpdate 0x7493aa (Cross 0x73e7f2) for a GM whatever the modifiers. [ (94) / ] (95) held + 1..8 = the n-th red / blue player
 * (Cross 0x760b6e / 0x760be3 -> 0x760360(team, n)), read before the plain digits. (Shift+4 Top View: camera not decoded; M, Tab,
 * Ctrl+Alt+P: not ported.)
 */
export function gmAction(code: string, shift: boolean, ctrl: boolean, bracket: 0 | 1 | null = null): GmAction | null {
  if (code === "F5") return { t: "toggleHud" };
  if (code === "F9") return { t: "toggleIds" };
  if (!shift && !ctrl) {
    if (code === "Backquote") return { t: "toggleNicks" };
    if (code === "Equal") return { t: "nickSize", d: 1 };
    if (code === "Minus") return { t: "nickSize", d: -1 };
  }
  const m = DIGIT.exec(code);
  if (!m) return null;
  const n = Number(m[1]);
  if (bracket !== null && !shift && !ctrl) return n >= 1 && n <= 8 ? { t: "pickPlayer", team: bracket, n } : null;
  if (shift && !ctrl) return n === 1 ? { t: "prevTarget" } : n === 2 ? { t: "nextTarget" } : n === 3 ? { t: "viewFly" } : null;
  if (ctrl && !shift) return { t: "savePos", n };
  if (!ctrl && !shift) return { t: "gotoPos", n };
  return null;
}

/** a saved FLY camera: position + look angles [INFERIDO: the exe slot contents are not decoded] */
export interface CamPos { x: number; y: number; z: number; yaw: number; pitch: number }

/** the 10 slots of Ctrl+0..9, kept in the client for the whole match */
export class PosSlots {
  private v: (CamPos | null)[] = Array.from({ length: 10 }, () => null);
  save(n: number, p: CamPos): boolean { if (n < 0 || n > 9) return false; this.v[n] = { ...p }; return true; }
  get(n: number): CamPos | null { return this.v[n] ? { ...this.v[n]! } : null; }
  clear(): void { this.v.fill(null); }
}

/** mouse wheel = FLY speed, read by the FLY camera itself for every observer (Cross 0x67e627..0x67e7a3): up +0.1, down -0.1,
 *  within 0.1..30 (constants 0xb22a70 / 0xb24310 / 0xb20b38). Wheel with walk (stroke 0x40) held steps the turn speed +0x14c
 *  by 0.05 instead (not ported: the port turns with the mouse only). */
export const FLY_SPEED_LIMITS = { min: 0.1, max: 30, step: 0.1 } as const;
export function flySpeedStep(cur: number, wheel: number): number {
  if (!wheel) return cur;
  const L = FLY_SPEED_LIMITS;
  return Math.max(L.min, Math.min(L.max, cur - Math.sign(wheel) * L.step)); // wheel up (deltaY < 0) = faster
}

/**
 * GM nick toggles. ` = flag 0x40 of the game context ([0xd80174]+0x96c, getter 0x758ec0), cleared only by its constructor 0x590ea0;
 * F9 = CPlayer dword 0 (0x6b4a00 / 0x6b49e0). Both live for the whole client session (not per match) and start off
 * [INFERIDO for F9: the CPlayer instance is not traced to its zero fill].
 */
export const gmNickView = { nicks: false, ids: false };

/** CHud+0xddc (Cross +0xdd8), the font size of the 16 nick text nodes: 12 for a GM, 11 otherwise (CreateHUD 0x745a2e), = / - step 1
 *  within 6..18 (2017 0x7445c0, Cross CHud 0x739a00) */
export const NICK_SIZE = { gm: 12, normal: 11, min: 6, max: 18 } as const;
export function nickSizeStep(cur: number, d: number): number {
  return Math.max(NICK_SIZE.min, Math.min(NICK_SIZE.max, cur + d));
}

/** GM nick text, ShowCharacterNick 0x826240 (Cross nick tags CHud 0x745240): "%s -%dHP" (nick, HP truncated) */
export const gmNickText = (name: string, hp: number) => `${name} -${Math.trunc(hp)}HP`;

/**
 * F9 seat badge (CHud+0x3f4 sprite, Gui/Ingame/hud4.i3i of PBCross -> public/assets/ui/cross-hud/hud/HUD4.png, CreateHUD 0x748551): 24x24 cell of the
 * seat, red column (u 5) for even seats, blue (u 35) for odd, row seat >> 1 (v 5 + 27 * row) = number 1..8 inside the team.
 */
export function idBadgeCell(slot: number): { x: number; y: number } | null {
  if (!Number.isInteger(slot) || slot < 0 || slot > 15) return null;
  return { x: slot & 1 ? 35 : 5, y: 5 + 27 * (slot >> 1) };
}
