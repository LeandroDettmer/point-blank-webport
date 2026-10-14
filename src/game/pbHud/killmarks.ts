// Kill marks (banner + announce voice) for the LOCAL player's own kills. Pure state machine, no DOM, so the
// browser runtime (PbHud.ts) and a Node smoke test run the same rules.
//
// IDs, banner grouping and voice clips are exe-verified (PBKaybo 2017 PointBlank.exe string table):
//   CChainKills::_PushKillMessage / _SetSpriteKillMessage (streak banner), CRevengeManager::AddKillDeath (revenge),
//   CGameSoundManager::StartAnnounceMessage (bb6e.. block: MV_Ann_Kill/HeadShot/Piercing/Double_Kill/Triple_Kill/
//   MassKill/Chain_Killer/Chain_Slugger/Chain_Stopper/Chain_HeadShot/HelmetProtection.wav, UI_HUD_Revenge_Effect.wav),
//   STR_HEADER_DO_HEADSHOT/_DOUBLE_KILL/_PIERCING/_TRIPLE_KILL/_MASS_KILL/_CHAINKILLER/_CHAINSLUGGER/_CHAINSTOPPER/
//   _CHAINHEADSHOT (bf0620..bf08cc) name the banner ids; STR_INGAME_HUD_REVENGE_* (bd4908..) name 6 flavoured
//   revenge captions. Clips are extracted for real by pb-extract-tools export-announce2017.mjs -> public/assets/sfx/announce.
// Banners themselves ARE the real Gui/Ingame/kill_message.i3i cells (UI_Ingame.i3Pack -> kill_message.png, 1024x1024,
// 2 columns x 10 rows; bounds measured from the texture's own alpha), same asset as HelmetProtection. `caption` is
// only a text fallback for marks with no cell in that sheet.
// RULES (exe-verified): CChainKills::Kill 0x7baab0 (called by CHud::SetChainKills 0x750b80 from CStageBattle's death event
// 0x774900; Cross exe: Kill 0x7b05c0 <- SetChainKills 0x745fc0 <- death event 0x76a840, same order: flags 0x100 Piercing,
// 0x200 Mass, 0x1000 Chain HS, 0x800 HS, 0x2000 Chain Slugger, 0x400 Chain Stopper, then tier arg >= 3 / 2 / 1 at
// 0x7b05fa..0x7b06db) picks ONE message per death packet from the kill flags the server sends (KillingMessage << 8, 
// Plugin.Core/Enums/KillingMessage.cs) in this fixed order: Piercing, Mass Kill, Chain Headshot, Headshot, Chain Slugger,
// Chain Stopper, then the kills-this-life tier the server adds to the death packet (roomPackets.ts deathAck: 2nd kill of
// the life = Double, 3rd = Triple, 4th and later = Chain Killer), else only the plain-kill voice. The flags themselves are
// the server's (RoomDeath.RegistryFragInfos): see onKill. There is NO time window: Double/Triple/Chain Killer count the kills
// of the current life.
// Plain kill (first kill of the life, no descriptor) has no cell in kill_message.i3i: voice only. [PENDENTE]
export type KillMarkId =
  | "kill" | "headshot" | "piercing"
  | "doubleKill" | "tripleKill" | "massKill"
  | "chainKiller" | "chainStopper" | "chainHeadshot" | "chainSlugger"
  | "revenge" | "helmetProtection"
  | "missionStart" | "missionSuccess" | "gameOver"
  | "bombPlanted" | "bombExploded" | "bombRemoved"
  | "taskCompleted";

/** a cell of Gui/Ingame/kill_message.i3i (UI_Ingame.i3Pack -> public/assets/ui/hud/kill_message.png, 1024x1024), px */
export interface KillSprite { x: number; y: number; w: number; h: number; /** 1 = kill_message1.png (mission banners); "cross" = kill_message.png (Point Blank Cross) */ sheet?: 1 | "cross" }

/** file under assets/ui/hud/ of a sprite's sheet */
// Cross sheets: kill_message.png (the Cross Gui/Ingame cell sheet, also the chain-kill banner) and kill_message1.png (mission banners)
export const killSheetFile = (sheet: KillSprite["sheet"]): string => (sheet === 1 ? "kill_message1.png" : "kill_message.png");

/** `duration` only times the caption fallback (killBanner): every sprite, kill_message or kill_message1, follows ChainBanners (0x7b17b1 is the same node) */
export interface KillMarkDef { id: KillMarkId; caption: string; sound: KillMarkId; duration: number; sprite?: KillSprite }

export const KILL_MARKS: Record<KillMarkId, KillMarkDef> = {
  kill: { id: "kill", caption: "", sound: "kill", duration: 1.0 },
  headshot: { id: "headshot", caption: "HEADSHOT", sound: "headshot", duration: 1.4, sprite: { x: 532, y: 202, w: 485, h: 89 } },
  piercing: { id: "piercing", caption: "PIERCING KILL", sound: "piercing", duration: 1.4, sprite: { x: 532, y: 303, w: 485, h: 90 } },
  doubleKill: { id: "doubleKill", caption: "DOUBLE KILL", sound: "doubleKill", duration: 1.6, sprite: { x: 16, y: 104, w: 486, h: 90 } },
  tripleKill: { id: "tripleKill", caption: "TRIPLE KILL", sound: "tripleKill", duration: 1.8, sprite: { x: 17, y: 202, w: 485, h: 90 } },
  massKill: { id: "massKill", caption: "MASS KILL", sound: "massKill", duration: 2.0, sprite: { x: 532, y: 4, w: 485, h: 83 } },
  chainKiller: { id: "chainKiller", caption: "CHAIN KILLER", sound: "chainKiller", duration: 1.8, sprite: { x: 15, y: 5, w: 485, h: 82 } },
  chainStopper: { id: "chainStopper", caption: "CHAIN STOPPER", sound: "chainStopper", duration: 2.2, sprite: { x: 532, y: 103, w: 485, h: 90 } },
  // kill_message.i3i cell 6 (col 0, row 3): CChainKills::_SetSpriteKillMessage 0x7bb1f0, ckType 3
  chainSlugger: { id: "chainSlugger", caption: "CHAIN SLUGGER", sound: "chainSlugger", duration: 1.8, sprite: { x: 16, y: 306, w: 486, h: 90 } },
  chainHeadshot: { id: "chainHeadshot", caption: "CHAIN HEADSHOT", sound: "chainHeadshot", duration: 2.0, sprite: { x: 17, y: 410, w: 485, h: 90 } },
  // no sprite cell in kill_message.i3i, and the exe's 6 flavoured STR_INGAME_HUD_REVENGE_* caption strings were
  // never dumped (no real text to show) — voice only (UI_HUD_Revenge_Effect.wav IS exe-verified), no banner.
  revenge: { id: "revenge", caption: "", sound: "revenge", duration: 1.8 },
  // the VICTIM's mark (STR_HEADER_HELMET_PROTECTION =): the original "Helmet
  // Protection" cell of kill_message.i3i (right column, 5th row; 1px transparent margin, see helmet.smoke.node.ts)
  helmetProtection: { id: "helmetProtection", caption: "", sound: "helmetProtection", duration: 1.0, sprite: { x: 540, y: 428, w: 472, h: 52 } },
  // mission flow banners (kill_message1.i3i) — these are played by game.ts on match start/end, not by killmarks logic
  missionStart: { id: "missionStart", caption: "MISSION START", sound: "missionStart", duration: 2.0, sprite: { x: 558, y: 21, w: 433, h: 59, sheet: 1 } },
  missionSuccess: { id: "missionSuccess", caption: "MISSION SUCCESS", sound: "missionSuccess", duration: 2.0, sprite: { x: 27, y: 123, w: 433, h: 59, sheet: 1 } },
  gameOver: { id: "gameOver", caption: "GAME OVER", sound: "gameOver", duration: 2.0, sprite: { x: 551, y: 120, w: 433, h: 59, sheet: 1 } },
  // Bomb Mission (MV_Ann_Bomb_Plated / _Exploded / _Removed, exe string table): voice only, no text (no banner cell is known and the
  // STBL_IDX_BOMB_MISSION_* strings are not confirmed as on-screen banners)
  bombPlanted: { id: "bombPlanted", caption: "", sound: "bombPlanted", duration: 2.0 },
  bombExploded: { id: "bombExploded", caption: "", sound: "bombExploded", duration: 2.0 },
  bombRemoved: { id: "bombRemoved", caption: "", sound: "bombRemoved", duration: 2.0 },
  // a task of the active mission card done (2359 with +240): CQuestManager::AddQuestFinishToHud 0x58c8b0 -> CChainKills::_PushKillMessage
  // ckType 10 -> _SetSpriteKillMessage 0x7bb1f0 cell 10 (col 0, row 5) of kill_message.i3i =, the whole 512x102 cell.
  // Played by game.ts (mission watch), not by onKill. Voice and duration of ckType 10 not read: no announce clip [INFERIDO], 1.8 s like
  // the chain banners [INFERIDO]
  taskCompleted: { id: "taskCompleted", caption: "", sound: "taskCompleted", duration: 1.8, sprite: { x: 0, y: 510, w: 512, h: 102 } },
};

/**
 * Banner art = Point Blank Cross (Clients/PBCross UI_Ingame.i3Pack kill_message.i3i -> kill_message.png, pb-extract-tools ui-export/hud-2017.mjs):
 * same 2 x 10 grid and the same cell per banner as 2017 (the Cross exe's _SetSpriteKillMessage 0x7b0cf0 has the 2017 ckType -> cell table),
 * new art. Its kill_message1.i3i is byte-identical to 2017, so the mission banners keep sheet 1. The 2017 / Portable TH art choice was removed
 * (user choice 2026-10-12: the Cross art only).
 */
/** sprite to draw for a mark: kill_message cells on the Cross sheet, kill_message1 cells as they are */
export const markSprite = (def: KillMarkDef): KillSprite | undefined =>
  def.sprite && def.sprite.sheet === undefined ? { ...def.sprite, sheet: "cross" } : def.sprite;

/**
 * CChainKills kill-message banner, exe-verified (Cross PointBlank.exe update 0x7b1280 + fade 0x7b1bc0 + _PushKillMessage 0x7b1030; the 2017 exe
 * has the same code and constants at 0x7bb780 / 0x7bc0c0):
 *   - _PushKillMessage queues the banner (ring of 16, refused when 5 are already waiting).
 *   - every frame the show timer (+0x66c) drops by dt; at <= 0 the shown banner fades (alpha -= dt * 255 / (1/3), truncated, hidden at 0)
 *     and the next queued one, if any, replaces it at once: alpha 255, scale (+0x6bc) 2.5, timer 1.0 s. So a banner holds 1 s, then fades
 *     in 1/3 s unless another one is waiting.
 *   - while shown, the scale falls dt * 2.5 / 0.1 per second down to 1 (2.5 -> 1 in 0.06 s).
 *   - the sprite is the whole 512 x 102 cell, drawn at 512 s x 102 s px, scaled around the box whose top-left is (W/2 - 490/2, H/2 - 512/2)
 *     (0x5224b0 centres a 490 x 512 box; 490 x 412 when the stage type is 10, not reproduced): x = X0 - (512 s - 512) / 2, y = Y0 - (102 s - 102) / 2.
 *     The exe works in screen px with no HUD scale; here W x H is the HUD design box (H = 768) [INFERIDO].
 */
export const CHAIN_BANNER = { cellW: 512, cellH: 102, hold: 1.0, fade: 1 / 3, scale0: 2.5, shrinkPerS: 2.5 / 0.1, maxQueued: 5, boxW: 490, boxH: 512 } as const;

export interface ChainBannerFrame {
  sheet: KillSprite["sheet"];
  /** full cell of the sheet, px */
  cellX: number; cellY: number;
  /** on screen (HUD box px) */
  x: number; y: number; w: number; h: number;
  /** 0..255 */
  alpha: number;
}

export class ChainBanners {
  private queue: KillSprite[] = [];
  private cur: KillSprite | null = null;
  private timer = 0;
  private alpha = 0;
  private scale = 1;

  /** _PushKillMessage: false when 5 are already waiting */
  push(s: KillSprite): boolean {
    if (this.queue.length >= CHAIN_BANNER.maxQueued) return false;
    this.queue.push(s);
    return true;
  }

  reset(): void {
    this.queue.length = 0;
    this.cur = null;
    this.timer = 0;
  }

  update(dt: number, W: number, H: number): ChainBannerFrame | null {
    const B = CHAIN_BANNER;
    this.timer -= dt;
    if (this.timer <= 0) {
      if (this.cur) {
        if (this.alpha > 0) this.alpha = Math.max(0, Math.trunc(this.alpha - (dt * 255) / B.fade));
        else { this.cur = null; this.timer = 0; }
      }
      const next = this.queue.shift();
      if (next) {
        this.cur = next;
        this.alpha = 255;
        this.scale = B.scale0;
        this.timer = B.hold;
      }
    }
    if (!this.cur) return null;
    const s = this.scale, c = this.cur;
    const x0 = W / 2 - B.boxW / 2, y0 = H / 2 - B.boxH / 2;
    const f: ChainBannerFrame = {
      sheet: c.sheet,
      // the cell holding the (alpha-trimmed) rect: its centre's 512 x 102 grid cell
      cellX: Math.floor((c.x + c.w / 2) / B.cellW) * B.cellW, cellY: Math.floor((c.y + c.h / 2) / B.cellH) * B.cellH,
      x: x0 - (B.cellW * s - B.cellW) / 2, y: y0 - (B.cellH * s - B.cellH) / 2, w: B.cellW * s, h: B.cellH * s,
      alpha: this.alpha,
    };
    this.scale = Math.max(1, this.scale - dt * B.shrinkPerS);
    return f;
  }
}

/** KillingMessage bits of the death packet. */
export const KM = { Piercing: 1, MassKill: 2, ChainStopper: 4, Headshot: 8, ChainHeadshot: 16, ChainSlugger: 32 } as const;

/**
 * What the server keeps per slot and life (RoomDeath.RegistryFragInfos: KillsOnLife, LastKillState >> 12, RepeatLastState).
 * Reset on the owner's death (and on a new round: a new life).
 */
export interface StreakState {
  /** enemy kills this life (server KillsOnLife) */
  kills: number;
  /** kind of the previous single-victim kill: 4 headshot, 6 melee, 0 anything else */
  lastType: 0 | 4 | 6;
  repeat: boolean;
}

export function initStreak(): StreakState {
  return { kills: 0, lastType: 0, repeat: false };
}

/** Own death: a new life starts empty. */
export function onDeath(s: StreakState): void {
  s.kills = 0;
  s.lastType = 0;
  s.repeat = false;
}

export interface KillEvent {
  headshot: boolean;
  /** the killing weapon is a knife (ItemClass Melee) */
  melee: boolean;
  /** one of several victims of the same shot or blast (server KillsCount > 1): Piercing Shot / Mass Kill */
  multi: boolean;
  /** with `multi`: a blast (death type BOOM / OBJECT_EXPLOSION) or a shotgun = Mass Kill, else Piercing Shot (RegistryFragInfos) */
  mass: boolean;
  /** kills the victim had this life when it died (ChainStopper: RoomDeath `victimSlot.KillsOnLife > 3`) */
  victimStreak: number;
  /** the id of the player who last killed us, still alive as our victim now (CRevengeManager) */
  isRevenge: boolean;
}

export interface KillResult {
  /** KM bits of this kill, as the server would have set them */
  flags: number;
  /** ONE banner per kill (CChainKills::Kill): the first of the exe's fixed order */
  marks: KillMarkDef[];
  /** Hud.i3i star variant 0..7 of the kill star (killStars.ts starVariant) */
  star: number;
}

/**
 * One enemy kill of ours: mutates `s`. The flags are RoomDeath.RegistryFragInfos: for a single victim, a headshot or a
 * knife kill extends the run of the same kind (2nd headshot in a row = Chain Headshot, 2nd knife kill in a row = Chain
 * Slugger, both need a kill earlier in this life); any other kind breaks the run. Several victims at once = Mass Kill
 * (blast / shotgun) or Piercing Shot. A victim with more than 3 kills adds Chain Stopper. The banner is then
 * CChainKills::Kill 0x7baab0's pick (see the header), and the kills-this-life tier comes from `s.kills` AFTER this kill.
 */
export function onKill(s: StreakState, ev: KillEvent): KillResult {
  let flags = 0;
  if (!ev.multi) {
    const type: 0 | 4 | 6 = ev.headshot ? 4 : ev.melee ? 6 : 0;
    if (type) {
      const prev = s.lastType;
      s.lastType = type;
      if (s.repeat && prev === type) {
        if (s.kills >= 1) flags |= type === 4 ? KM.ChainHeadshot : KM.ChainSlugger;
        else if (type === 4) flags |= KM.Headshot;
      } else {
        if (type === 4) flags |= KM.Headshot;
        s.repeat = true;
      }
    } else {
      s.lastType = 0;
      s.repeat = false;
    }
  } else flags |= ev.mass ? KM.MassKill : KM.Piercing;
  if (ev.victimStreak > 3) flags |= KM.ChainStopper;
  s.kills++;

  const id: KillMarkId =
    flags & KM.Piercing ? "piercing"
    : flags & KM.MassKill ? "massKill"
    : flags & KM.ChainHeadshot ? "chainHeadshot"
    : flags & KM.Headshot ? "headshot"
    : flags & KM.ChainSlugger ? "chainSlugger"
    : flags & KM.ChainStopper ? "chainStopper"
    : s.kills >= 4 ? "chainKiller"
    : s.kills === 3 ? "tripleKill"
    : s.kills === 2 ? "doubleKill"
    : ev.isRevenge ? "revenge"
    : "kill";
  return { flags, marks: [KILL_MARKS[id]], star: starVariant(flags, ev.melee) };
}

/**
 * Which of our kills share one shot or blast (KillEvent.multi / mass). The original sends every victim of one bullet or one
 * explosion in ONE death packet (PROTOCOL_BATTLE_DEATH_ACK: KillsCount + frags); the server flags all of them when
 * KillsCount (minus the killer's own frag) >= 2: MassKill for death type BOOM / OBJECT_EXPLOSION (any blast) or a shotgun,
 * else PiercingShot, and the Cross client calls CChainKills::Kill 0x7b05c0 ONCE per
 * packet (CStageBattle death event 0x76a840 -> CHud::SetChainKills 0x745fc0 at 0x76b02a) with the flags and the victim
 * count. Here the kills arrive one by one (a remote victim confirms its own death), so the hits remember their shot id and
 * the 2nd kill of the same id on is the multi kill (hud.ts holds the 1st kill's banner so the Mass/Piercing one replaces it).
 */
export class ShotKills {
  private lastOn = new Map<string, { shot: number | string; boom: boolean }>();
  private kills = new Map<number | string, number>();

  /** our hit on `victim`: `shot` = bullet / blast id (undefined = knife or anything without one: drops the old id) */
  hit(victim: string, shot: number | string | undefined, boom = false): void {
    if (shot === undefined) this.lastOn.delete(victim);
    else this.lastOn.set(victim, { shot, boom });
  }

  /** our kill of `victim`: `multi` when the shot / blast that last hit it already killed someone, `boom` when it was a blast */
  kill(victim: string): { multi: boolean; boom: boolean } {
    const last = this.lastOn.get(victim);
    this.lastOn.delete(victim);
    if (!last) return { multi: false, boom: false };
    const n = (this.kills.get(last.shot) ?? 0) + 1;
    this.kills.delete(last.shot);
    this.kills.set(last.shot, n);
    // insertion order = oldest first: forget the old shots
    if (this.kills.size > 64) this.kills.delete(this.kills.keys().next().value!);
    return { multi: n >= 2, boom: last.boom };
  }
}

/**
 * Kill star cell of Hud.i3i (CChainKills::Kill 0x7baab0, then _SetKillStarUV 0x7bd960 puts it at x 199 + 52 * (v & 3), y 337 + 56 * (v >> 2)):
 * bit 0 = headshot (hollow star), 2/3 = knife (hollow + 1 knife / plain + 2 crossed knives), +4 = gold row for Chain Stopper.
 * The Chain Slugger flag sets the knife pair; so does the exe's 4th argument == 2 (the killing weapon's class digit, read here
 * as "melee" [INFERIDO]: the sprite is a knife, and the server only flags the 2nd knife kill in a row).
 */
export function starVariant(flags: number, melee = false): number {
  let v = flags & (KM.Headshot | KM.ChainHeadshot) ? 1 : 0;
  if (flags & KM.ChainSlugger) v = v === 1 ? 2 : 3;
  if (melee) v = v === 1 ? 2 : v === 0 ? 3 : v;
  if (flags & KM.ChainStopper) v += 4;
  return v;
}
