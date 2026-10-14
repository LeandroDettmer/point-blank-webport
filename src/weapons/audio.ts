import * as THREE from "three";
import { sfxGain } from "../gameplay/settings";
import { loadClip } from "../audioUrl";
import {
  PbPositionalAudio, claimVoice, effectsBus, gain3D, listenerDistance, namedInfo, releaseVoice, routeListener, soundInfo,
  type SoundInfo,
} from "../gameplay/soundMix";
import { jsonOnce } from "../jsonOnce";
import { throwableBaseId, throwKind } from "./throwables";
import { weaponFxInfo } from "./sights";
import { terrainSuffix, type SoundTerrain } from "./terrainSound";
import type { Family, WeaponDef } from "./types";

// Clips extracted by pb-extract-tools export-weapons.mjs from Sound_Weapon_*.i3Pack. Roles (fire/reload/...)
// are guessed from clip length/attack because the pack file names are still encrypted.
interface SfxPack {
  family: string;
  clips: string[];
  fire: string[];
  reload: string[];
  swing: string[];
  explode: string[];
  other: string[];
}
interface SfxIndex {
  packs: Record<string, SfxPack>;
  common: Record<string, string[]>;
}
/**
 * pb-extract-tools export-sfx2017.mjs: the 2017 client's weapon WAVs by name. weapons: weapon.pef _FireSound / _SwapSound per item;
 * ai: the weapon pack's i3AIState sound events (LoadMag / LoadBullet: Remove, Load, ReLoad, ReLoadC ... at state time t
 * of a state lasting dur). Checked before the Cross packs of sfx/index.json, whose roles are guessed.
 */
interface Sfx2017 {
  files: Record<string, string>;
  weapons: Record<string, { fire?: string; swap?: string }>;
  ai: Record<string, Record<string, { dur: number; ev: [number, string][] }>>;
}
/** which _LoadFireSound slot a shot plays (WeaponAudio.fireClip) */
export interface FireVariant { silencer?: boolean; zoom?: boolean; remote?: boolean }
export interface StateSounds { dur: number; ev: [number, string][] }

/** sfx/char lives next to the weapons asset folder (WeaponAudio.base = <assets>/weapons) */
const CHAR_SFX = "../../sfx";
const GENERIC: Record<Family, string> = {
  AR: "AssaultRifle_AK-47", SMG: "SMG_MP7", MG: "MachineGun_MK46", SR: "SniperRiffle_SSG69",
  SG: "ShotGun_870MCS", HG: "HandGun_K5", KNIFE: "Melee_M-7", GRENADE: "Throw_K-400", OTHER: "AssaultRifle_AK-47",
};
/** most common weapon.pef _SwapSound per family (weapons without one, or with a clip outside the Common pack) */
const SWAP_BY_FAMILY: Record<Family, string> = {
  AR: "WM_Change_Assault", SMG: "WM_Change_SMG", MG: "WM_Change_Assault", SR: "WM_Change_Rifle", SG: "WM_Change_Shotgun",
  HG: "WM_Change_Handgun", KNIFE: "WM_Change_Melee", GRENADE: "WM_Change_Throw", OTHER: "WM_Change_Assault",
};
/** the GENERIC pack's own fire clip per family: its list data stands in for a fire clip guessed from a Cross pack */
const GENERIC_FIRE: Record<Family, string> = {
  AR: "wm_ak47_fire", SMG: "wm_mp7_fire", MG: "wm_mk46_fire", SR: "wm_ssg69_fire", SG: "wm_870mcs_fire", HG: "wm_k5_fire",
  KNIFE: "wm_m7_fire", GRENADE: "wm_throw_fire", OTHER: "wm_ak47_fire",
};
/**
 * Decoded clips by URL, shared by every WeaponAudio (one per match) and the match preload (preloadMatch): THREE.AudioLoader
 * decodes into three's global AudioContext, the one every AudioListener plays on. A clip decoded before the match is not
 * fetched on its first play.
 */
const buffers = new Map<string, Promise<AudioBuffer | null>>();
const loader = new THREE.AudioLoader();
/** how long a failed clip load stays cached as "no sound" before a play tries it again */
const RETRY_MS = 2000;

/** Which file each weapon sound event plays (sfx/index.json Cross packs + pb2017.json) and the shared decoded clips. No playback. */
export class SfxCatalog {
  protected index: SfxIndex | null = null;
  protected pb17: Sfx2017 | null = null;
  protected readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  async load(): Promise<void> {
    this.index = await jsonOnce<SfxIndex>(`${this.base}/sfx/index.json`);
    this.pb17 = await jsonOnce<Sfx2017>(`${this.base}/sfx/pb2017.json`).catch(() => null);
  }
  protected named(n: string | undefined): string | undefined {
    return n ? this.pb17?.files[n] : undefined;
  }
  /** Sound_Weapon_Throw_Common WM_Throw_Hold: pin pulled when a throwable is readied (pb-extract-tools export-sfx2017.mjs) */
  throwPin(): string | undefined {
    return this.named("wm_throw_hold");
  }
  /**
   * weapon.pef _FireSound of the item (2017 pack, by name), else the guessed fire clip of its Cross pack / class.
   * _LoadFireSound 0x605150 builds 6 slots from that name: 0 = "<n>.wav", 1 = "_Secondary", 2 = "_Muffler", 3 = the last 4 chars
   * replaced by "Zoom_Fire" (WM_AUG_Fire -> WM_AUG_Zoom_Fire), 4 = _FireSoundExt, 5 = "_3pv"; _PlayFireSound 0x605b30 plays slot idx
   * and falls back to slot 0 when that slot has no clip. Slot 5 is forced for a remote shooter of the SVU (0x605bbd..0x605c06:
   * owner flag +0x528 == 1, class 5, name SNIPER_SVU). Which caller passes idx 2 / 3 is not decoded: silencer on = Muffler,
   * zoom open = Zoom_Fire [INFERIDO].
   */
  protected fireClip(w: WeaponDef, v: FireVariant = {}): string | undefined {
    const f = this.pb17?.weapons[w.id]?.fire;
    const alts = f ? [v.remote && `${f}_3pv`, v.silencer && `${f}_muffler`, v.zoom && f.replace(/fire$/, "zoom_fire")] : [];
    const clip = alts.map((n) => this.named(n || undefined)).find(Boolean) ?? this.named(f);
    // the pef names a clip that no client ships (SCAR-H LB sniper 103088 WM_SCAR_LB_Fire, SCAR-H Std Sil 103070 WM_SCAR_STD_Fire:
    // not in any Cross pack, Weapon.RSC or the 2017 packs; no base weapon in the pef): silent, not the AK-47 clip. Cross exe:
    // _LoadFireSound 0x5fe7d0 reads the name only from the item's own info (+0x520, 0x5b1050) and leaves a slot null when the
    // RSC lookup (0x5fea6f) misses; _PlayFireSound 0x5ff1ac takes slot idx, else slot 0 (0x5ff283..0x5ff29c), and with both
    // null only formats the "[_PlayFireSound] %s (TYPE %d)" log (0x5ff3b6) and returns (0x5ff3be): no class or base fallback
    if (!clip && w.pb?.fireSound) return undefined;
    return clip ?? this.pick(w, "fire");
  }

  /**
   * Sound events of a weapon AI state (WeaponAnimSet.ai + the state key the animator runs, e.g. Weapon_Cheytac /
   * LoadMag1PVMale): [state time, file]; null when the pack has none (callers keep the reloadClips() schedule).
   */
  stateSounds(ai: string | undefined, state: string | null | undefined): StateSounds | null {
    const s = ai && state ? this.pb17?.ai[ai]?.[state] : undefined;
    if (!s) return null;
    const ev = s.ev.map(([t, n]) => [t, this.named(n)] as [number, string | undefined]).filter((e): e is [number, string] => !!e[1]);
    return ev.length && s.dur > 0 ? { dur: s.dur, ev } : null;
  }

  protected pack(w: WeaponDef): SfxPack | undefined {
    const p = this.index?.packs;
    if (!p) return undefined;
    const own = w.sfx ? p[w.sfx] : undefined;
    const gen = p[GENERIC[w.family]];
    // own pack may lack a role (e.g. no fire clip guessed) -> fall back per role in pick()
    return own ?? gen;
  }

  protected pick(w: WeaponDef, role: keyof Omit<SfxPack, "family" | "clips">, i = 0): string | undefined {
    const p = this.index?.packs;
    if (!p) return undefined;
    for (const pk of [this.pack(w), p[GENERIC[w.family]]]) {
      const list = pk?.[role];
      if (list && list.length) return list[Math.min(i, list.length - 1)];
    }
    return undefined;
  }

  reloadClips(w: WeaponDef): string[] {
    const own = this.pack(w)?.reload ?? [];
    return (own.length ? own : this.index?.packs[GENERIC[w.family]]?.reload ?? []).slice(0, 4);
  }

  /**
   * Swap sound, one per weapon change (WeaponBase::_PlaySwapSound 0x606084): weapon.pef _SwapSound "<name>.wav" from
   * Sound/Weapon/Common/Change; names only in a weapon's own pack (WM_CheyTac M200_Chage...) fall back to the class
   * clip. The old code played Change[0] (= WM_Change_Assault) for every weapon, knife and grenade included.
   */
  swap(w: WeaponDef): string | undefined {
    const have = this.index?.common.change ?? [];
    const f = (n: string | undefined) => (n && have.includes(`Common/change/${n}.wav`) ? `Common/change/${n}.wav` : undefined);
    // names only in the weapon's own 2017 pack (WM_CheyTac M200_Chage) come from pb2017.json
    return f(w.pb?.swapSound) ?? this.named(this.pb17?.weapons[w.id]?.swap) ?? f(SWAP_BY_FAMILY[w.family]) ?? have[0];
  }

  common(group: "change" | "emptybullet" | "emptycatridge" | "hit" | "zoom", random = false): string | undefined {
    const list = this.index?.common[group];
    if (!list || !list.length) return undefined;
    return random ? list[(Math.random() * Math.min(list.length, 12)) | 0] : list[0];
  }

  /**
   * Zoom in / out clip (the weapon zoom handler 0x823830; CGameSoundManager table at +0x1928, 0x2c names x 3 variants, stride
   * 0xb0: variant 0 = In at 0xd5ac60, variant 2 = Out at 0xd5adc0, idx 0 / 1 / 2 = WM_Zoom / WM_Scope / WM_AssaultScope; idx 0x12
   * variants 1 / 2 = WM_RPG7_Zoom_In / Out for class 0x10, not shipped here: silent): class 5 (sniper) or the byte +5 of the
   * weapon's table record (0x5fce20) set = WM_Scope_*, any other = WM_AssaultScope_*. That byte is read as "the Scope
   * extension" (pef Extension Type "Scope": G36C, AN-94, AK SOPMOD, F2000...) [INFERIDO]; the DotSight rifles (AUG, M4A1, SG550,
   * HK417, TAR-21, P90, MP7) and the SteadyAim ones (K-2, FAMAS) take the assault clip. `params.scope` (zoomType 3 + FovOnScope)
   * is true for the DotSight guns too, so it gave the AUG the sniper click.
   */
  zoomFile(w: WeaponDef, on: boolean): string | undefined {
    if (w.classType === 0x10) return undefined;
    const n = w.classType === 5 || w.params.ext?.type === "Scope" ? "Scope" : "AssaultScope";
    return this.index?.common.zoom?.find((f) => f.toLowerCase().endsWith(`/wm_${n}_${on ? "in" : "out"}.wav`.toLowerCase()));
  }
  /**
   * Casing that lands: WM_Bullet_<Terrain>_1 (terrain table idx 0xa; idx 0xb WM_SG_Bullet_<T> for class 6 / 0x23, a clip this
   * build does not ship: WM_Bullet instead [INFERIDO]) of Common/emptycatridge, terrain = the I3_TERRAIN_TYPE under the shooter
   * (terrainSound.ts); a terrain without its clip falls back to the Concrete one.
   */
  casingFile(terrain?: number): string | undefined {
    const find = (t: string) => this.index?.common.emptycatridge?.find((f) => f.toLowerCase().endsWith(`/wm_bullet_${t.toLowerCase()}_1.wav`));
    return find(terrainSuffix(terrain)) ?? find("Concrete");
  }

  protected buffer(file: string): Promise<AudioBuffer | null> {
    const url = `${this.base}/sfx/${file}`;
    let b = buffers.get(url);
    if (!b) {
      const p: Promise<AudioBuffer | null> = loadClip(loader, url).then(
        (x) => x,
        () => {
          // a failed fetch / decode (dev server restart, a burst of requests) must not silence the clip for the whole session:
          // forget it after RETRY_MS so the next play loads it again
          setTimeout(() => { if (buffers.get(url) === p) buffers.delete(url); }, RETRY_MS);
          return null;
        }
      );
      b = p;
      buffers.set(url, p);
    }
    return b;
  }

  preload(w: WeaponDef): void {
    for (const f of [this.fireClip(w), this.pick(w, "swing"), this.pick(w, "explode"), ...this.reloadClips(w)])
      if (f) void this.buffer(f);
  }

  /**
   * Knife swing: weapon.pef _FireSound (M-7: WM_M7_Fire) for LMB, the pack's "<fire>_Secondary" (WM_M7_Fire_Secondary)
   * for RMB; the Cross guessed swing clips when the 2017 pack has none. `pos` = remote attacker (3D).
   */
  swingFile(w: WeaponDef, heavy: boolean): string | undefined {
    const f = this.pb17?.weapons[w.id]?.fire;
    return (heavy ? this.named(f && `${f}_secondary`) : undefined) ?? this.named(f) ?? this.pick(w, "swing", heavy ? 1 : 0);
  }
  /**
   * Blast of a throwable, by name (exe-2017): the explosion manager plays sound table row 1 idx 0xB = WM_K400_Explosion
   * (0x9910ee, string table 0xd5ad3c); the K-413 / smoke / C5 blasts are the sound nodes of their Effect_High
   * explosion effects. The Throw_K-400 pack's other long clip, WM_K400_Explosion_Damage (row 0 idx 9), is NOT the blast:
   * it is the hit-by-explosion sound of a damaged character (explosionHurt). The old guessed "explode" role picked it.
   */
  explodeFile(w: WeaponDef, kind: string | null): string | undefined {
    // the blast is the sound node of the item's pef _FireEffect i3s (Effect_High; 2017 pef: K-413 = Exp_Gr_K413_01 only)
    const fx = (weaponFxInfo(w.id) ?? weaponFxInfo(throwableBaseId(w.id)))?.fire;
    const n = (fx && BLAST_BY_FX[fx]) ?? (kind === "c5" ? "wm_c5_explosion" : kind === "smoke" ? "wm_smoke_explosion"
      : kind === "flash" ? "wm_flash_explosion" : kind === "grenade" ? "wm_k400_explosion" : undefined);
    return this.named(n) ?? this.pick(w, "explode");
  }
  /**
   * Knife hit (WeaponKnife::_OnHit -> terrain sound WM_Knife_Hit_<T>, Sound/Weapon/Melee/Common): `terrain` = I3_TERRAIN_TYPE
   * of the shape (terrainSound.ts), "Human" / "Head" for a character. Falls back to the bullet-hit clip of the terrain.
   */
  knifeHitFile(terrain: SoundTerrain): string | undefined {
    const t = terrain === "Human" || terrain === "Head" ? terrain : terrainSuffix(terrain, "knife");
    return this.named(`wm_knife_hit_${t.toLowerCase()}`) ?? this.named("wm_knife_hit_concrete") ?? this.hitFile(terrain);
  }
  /** bullet hit on a surface (WM_Hit_<T>_1/_2 of Common/hit) or a character ("Human"/"Head" -> WM_Hit_Human_1..3) */
  hitFile(terrain: SoundTerrain): string | undefined {
    const t = terrain === "Human" || terrain === "Head" ? "Human" : terrainSuffix(terrain);
    const have = this.index?.common.hit ?? [];
    const list = have.filter((f) => f.toLowerCase().includes(`/wm_hit_${t.toLowerCase()}_`));
    return list.length ? list[(Math.random() * list.length) | 0] : this.common("hit", true);
  }
  /**
   * Bullet whiz past the local character: WM_Hit_GrazeBullet_1..3 (Common/Hit), CGameSoundManager table 0xd60958 slot 3, the row
   * picked by rand() % 3 (Cross exe 0x604899..0x6048b1).
   */
  grazeFile(): string | undefined {
    return this.named(`wm_hit_grazebullet_${1 + ((Math.random() * 3) | 0)}`);
  }
  /** grenade bounce (WeaponGrenade::_PlayBoundSound(I3_TERRAIN_TYPE)): WM_Throw_Bound_<T>, Throw/Common */
  boundFile(terrain?: number, w?: WeaponDef): string | undefined {
    // CandyGrenade: the exe's own bound clips WM_Recovery_Candy_Throw_Bound_1..4 (exe strings), one at random [INFERIDO: pick rule]
    if (w && /candy/i.test(w.name)) return this.named(`wm_recovery_candy_throw_bound_${1 + ((Math.random() * 4) | 0)}`) ?? this.boundFile(terrain);
    const t = terrainSuffix(terrain, "bound").toLowerCase();
    return this.named(`wm_throw_bound_${t}`) ?? this.named("wm_throw_bound");
  }

  /**
   * Every clip a match with these weapons can play, so none is fetched on its first play: per weapon the fire / swing /
   * blast / swap clips, the Cross reload clips and every event of its weapon AI states (`ais`: WeaponAnimSet.ai of the
   * weapons' models, the 2017 reload / change sounds stateSounds plays); then the clips every weapon shares (bullet hit and
   * casing per terrain, dry fire, scope, knife hit, grenade bounce, pin, blasts and blast hurt).
   */
  matchFiles(defs: WeaponDef[], ais: string[] = []): string[] {
    const out = new Set<string>();
    const add = (f: string | undefined) => { if (f) out.add(f); };
    for (const w of defs) {
      for (const f of [this.fireClip(w), this.fireClip(w, { silencer: true }), this.fireClip(w, { zoom: true }), this.fireClip(w, { remote: true }),
        this.zoomFile(w, true), this.zoomFile(w, false), this.swingFile(w, false), this.swingFile(w, true), this.swap(w), ...this.reloadClips(w)]) add(f);
      if (/mk23|mp5k/i.test(w.name)) for (const on of ["on", "off"]) add(this.named(`wm_${/mp5k/i.test(w.name) ? "mp5k" : "mk23"}_silencer${on}`));
      const kind = throwKind(w);
      if (!kind) continue;
      // a throwable: the pin, its own blast (K-413: any of the 3), and what its blast plays on the local character / ground
      add(this.throwPin());
      add(this.explodeFile(w, kind));
      if (kind === "grenade" || kind === "c5" || kind === "mine" || kind === "wpsmoke") add(this.named("wm_k400_explosion_damage"));
      if (kind === "flash") add(this.named("wm_flash_explosion_damage"));
      if (kind === "heal") add(this.named("wm_medickit_recovery"));
      if (kind === "c5") for (const n of ["wm_c5_stick", "wm_c5_count_a"]) add(this.named(n));
      if (/candy/i.test(w.name)) for (let i = 1; i <= 4; i++) add(this.named(`wm_recovery_candy_throw_bound_${i}`));
    }
    for (const ai of ais) for (const st of Object.values(this.pb17?.ai[ai] ?? {})) for (const [, n] of st.ev) add(this.named(n));
    for (const g of ["hit", "emptycatridge", "emptybullet", "zoom"] as const) for (const f of this.index?.common[g] ?? []) add(f);
    for (const f of ["char/MV_Zoom_Breath.wav", "char/WV_Zoom_Breath.wav"]) add(`${CHAR_SFX}/${f}`);
    for (let t = 0; t < 39; t++) { add(this.knifeHitFile(t)); add(this.boundFile(t)); add(this.hitFile(t)); add(this.casingFile(t)); }
    for (const t of ["Human", "Head"] as const) add(this.knifeHitFile(t));
    for (let i = 1; i <= 3; i++) add(this.named(`wm_hit_grazebullet_${i}`));
    return [...out];
  }

  /** fetch + decode clips by file (relative to `<base>/sfx/`), e.g. the break sounds of the map's props */
  async preloadFiles(files: Iterable<string>): Promise<void> {
    await Promise.all([...files].map((f) => this.buffer(f)));
  }

  /** fetch + decode every matchFiles clip into the shared buffers (a missing file resolves null, never rejects) */
  async preloadMatch(defs: WeaponDef[], ais: string[] = []): Promise<void> {
    await Promise.all(this.matchFiles(defs, ais).map((f) => this.buffer(f)));
  }
}

/** blast clip = the sound node inside each throwable _FireEffect i3s (Effect_High, read from the files' strings) */
const BLAST_BY_FX: Record<string, string> = {
  Exp_Gr_01: "wm_k400_explosion", Exp_C5_01: "wm_c5_explosion", Exp_Fl_01: "wm_flash_explosion",
  Exp_Gr_K413_01: "wm_k413_explosion_1", Exp_Gr_K413_02: "wm_k413_explosion_2", Exp_Gr_K413_03: "wm_k413_explosion_3",
  Exp_Sm_01: "wm_smoke_explosion", Exp_Sm_02: "wm_smoke_explosion", Exp_Sm_CS: "wm_smoke_explosion",
  Exp_WPSm_01: "wm_wp_smoke_explosion", Exp_WPSm_02: "wm_wp_smoke_explosion",
  Exp_Gr_CandyGrenade: "wm_recovery_candy_boom", Exp_Snowman_Grenade: "wm_k201_explosion", Exp_Water_Bomb: "wm_waterbomb_fire",
  "Exp_Gr_K-479": "wm_m14_explosion",
};

/** what a play call may add to the clip's own list data */
export interface PlayOpts {
  /** the weapon's fire channel (WeaponBase +0x638): a new shot of the same clip restarts that channel, cutting the last
   *  one (_PlayFireSound 0x605f36 -> i3SoundContext::RePlay -> System::playSound(FMOD_CHANNEL_REUSE = -2, 0x100164c4));
   *  another clip (_Secondary / _Muffler ...) gets a channel of its own (0x605d73) */
  key?: string;
  /** list data for a clip the lists do not name */
  fallback?: SoundInfo;
  /** the data of the playing object's own i3SoundPlayInfo (map objects): wins over the lists */
  info?: SoundInfo;
}

/** gain of a clip (volume 0..100) under the effects gauge: FMOD Ex clamps the channel volume to 1, and a few clips are
 *  above 100 (WM_Ultimax-100_Fire 200), so such a clip keeps full volume under a lowered gauge [INFERIDO clamp] */
const clipLevel = (v100: number): number => {
  const c = v100 / 100, s = sfxGain();
  return c <= 1 ? c : Math.min(c, s > 0 ? 1 / s : c);
};

export class WeaponAudio extends SfxCatalog {
  readonly listener: THREE.AudioListener;
  private scene: THREE.Scene;
  /** the live fire channel per key (PlayOpts.key) */
  private keyed = new Map<string, { file: string; stop: () => void }>();
  /** CGameSoundManager::ReserveSoundPlay (exe 0x699d70): this frame's bullet-hit sounds, one per terrain (the nearest) */
  private reserved = new Map<string, { file: string; pos: THREE.Vector3; d: number }>();

  constructor(scene: THREE.Scene, camera: THREE.Camera, base: string, listener?: THREE.AudioListener) {
    super(base);
    this.scene = scene;
    this.listener = listener ?? new THREE.AudioListener();
    if (!listener) camera.add(this.listener);
    // Configuração "Volume: Efeitos sonoros" = the effects group every game sound of this listener goes through
    // (soundMix.effectsBus); the listener's own gain is left to the flash duck (FlashTinnitus)
    routeListener(this.listener);
    // browsers start the AudioContext suspended until a user gesture
    window.addEventListener("pointerdown", this.resume);
    window.addEventListener("keydown", this.resume);
  }

  private resume = (): void => {
    if (this.listener.context.state !== "running") void this.listener.context.resume();
  };

  /** Drops the window listeners (a new match builds a new WeaponAudio). */
  dispose(): void {
    window.removeEventListener("pointerdown", this.resume);
    window.removeEventListener("keydown", this.resume);
  }

  /** WM_C5_Stick (exe string table row 1 idx 0x10, 0x7b4eec): a thrown C5 attaches to a surface */
  c5Stick(pos: THREE.Vector3): void {
    this.playAt(this.named("wm_c5_stick"), pos);
  }
  /** WM_C5_Count_A (row 0 idx 0x10, 0x7b4a64): "sound 0x10" a planted C5 plays when the bomb trigger is pressed (0x6425ff) */
  c5Count(pos: THREE.Vector3): void {
    this.playAt(this.named("wm_c5_count_a"), pos);
  }
  /** Sound_Weapon_Throw_Medical_Kit WM_MedicKit_Recovery: the sound node of the kit's pef _FireEffect (buff.i3s) at the kit */
  medicRecovery(pos: THREE.Vector3): void {
    this.playAt(this.named("wm_medickit_recovery"), pos);
  }
  /** a silencer on / off (WM_MK23_SilencerOn ... : the weapon pack's ExtensionActivate sound event): 3D at a remote player, 2D without `pos` (own) */
  silencerAt(w: WeaponDef, on: boolean, pos?: THREE.Vector3): void {
    const f = this.named(`wm_${/mp5k/i.test(w.name) ? "mp5k" : "mk23"}_silencer${on ? "on" : "off"}`);
    if (pos) this.playAt(f, pos);
    else this.play(f);
  }
  /** own zoom in / out (0x823830), 2D */
  zoom(w: WeaponDef, on: boolean): void {
    this.play(this.zoomFile(w, on));
  }
  /**
   * MV_Zoom_Breath / WV_Zoom_Breath (gender of the own character): StartCharacterActionSnd idx 0xb, 2D, from the per-frame 0x7412f0
   * once the scope has been open 2 s (the timer crosses 2.0, one sound, not a loop)
   */
  breath(female: boolean): void {
    this.play(`${CHAR_SFX}/char/${female ? "WV" : "MV"}_Zoom_Breath.wav`);
  }
  /** a casing hitting the floor (0x617bb0 -> 0x610200 -> 0x60fc40): 2D for the own weapon */
  casing(terrain?: number): void {
    this.play(this.casingFile(terrain));
  }

  /**
   * Starts a clip once decoded: 2D (`pos` null, listener volume) or 3D at `pos` (volume, min / max distance), list data
   * from soundMix.soundInfo. A 3D clip past its max distance does not start (i3SoundPlayStateFMOD::Play 0x10016268).
   */
  private start(file: string | undefined, pos: THREE.Vector3 | null, o: PlayOpts, out?: AudioNode): void {
    if (!file) return;
    const p = pos?.clone() ?? null;
    void this.buffer(file).then((buf) => {
      if (!buf) return;
      const info = o.info ?? soundInfo(file, o.fallback);
      const aud = p ? gain3D(info, listenerDistance(this.listener, p)) : info.lvol / 100;
      const prev = o.key ? this.keyed.get(o.key) : undefined;
      if (prev && prev.file === file) prev.stop();
      let a: THREE.Audio<GainNode | PannerNode>;
      if (p) {
        const pa = new PbPositionalAudio(this.listener, info);
        pa.setLevel(clipLevel(info.vol));
        pa.position.copy(p);
        a = pa;
      } else {
        a = new THREE.Audio(this.listener);
        a.setVolume(clipLevel(info.lvol));
        if (out) { a.gain.disconnect(); a.gain.connect(out); }
      }
      const entry = { file, stop: () => {} };
      let voice: ReturnType<typeof claimVoice> = null;
      const end = () => {
        releaseVoice(voice);
        if (o.key && this.keyed.get(o.key) === entry) this.keyed.delete(o.key);
        a.parent?.remove(a);
        // three never disconnects a finished voice: its gain (and panner) would stay wired into the listener's graph
        try { a.gain.disconnect(); if (a instanceof THREE.PositionalAudio) a.panner.disconnect(); } catch { /* already gone */ }
      };
      entry.stop = () => {
        if (a.isPlaying) { a.onEnded = () => {}; a.stop(); }
        end();
      };
      voice = claimVoice(aud, entry.stop);
      if (!voice) return;
      a.setBuffer(buf);
      if (p) this.scene.add(a);
      a.onEnded = () => { a.isPlaying = false; end(); };
      a.play();
      if (o.key) this.keyed.set(o.key, entry);
    });
  }

  /** 2D (listener) clip: the own weapon, own character */
  play(file: string | undefined, o: PlayOpts = {}): void {
    this.start(file, null, o);
  }
  /** 3D clip at a world point (impacts, explosions, remote shots) */
  playAt(file: string | undefined, pos: THREE.Vector3, o: PlayOpts = {}): void {
    this.start(file, pos, o);
  }

  /** a reload clip of the Cross packs (reloadClips, nameless): the most common data of the lists' Load / Remove
   *  clips, 1 / 10 / 25 / 40 (140 clips, WM_K2_Load among them) [INFERIDO] */
  playReload(file: string | undefined): void {
    this.play(file, { fallback: namedInfo("wm_k2_load") });
  }

  /** the class pack's fire clip data (GENERIC[family] weapon) for a fire clip guessed from a Cross pack [INFERIDO] */
  private fireFallback(w: WeaponDef): SoundInfo | undefined {
    return namedInfo(GENERIC_FIRE[w.family]);
  }
  /** own 1PV shot: 2D at the clip's listener volume (_PlayFireSound 0x605f99: set3DMode(0x1000000) when the owner is in
   *  1PV, 0x54d900, else 0x3000000), one channel per weapon. No pitch change (no SetPitch on the fire path). */
  fire(w: WeaponDef, v: FireVariant = {}): void {
    if (throwKind(w) === "heal") return; // Medical_Kit pef has no _FireSound: the GRENADE fallback was a bomb throw
    this.play(this.fireClip(w, v), { key: `own:${w.id}`, fallback: this.fireFallback(w) });
  }
  /** another character's shot: 3D at its weapon, one channel per (owner, weapon) when `owner` is given */
  fireAt(w: WeaponDef, pos: THREE.Vector3, owner?: string | number, v: FireVariant = {}): void {
    if (throwKind(w) === "heal") return; // remote / bot kit throw: no fire sound (same as the local press)
    this.playAt(this.fireClip(w, { remote: true, ...v }), pos, { key: owner === undefined ? undefined : `${owner}:${w.id}`, fallback: this.fireFallback(w) });
  }
  /** knife swing = the knife's fire sound (_FireSound), same channel rule as a shot */
  swing(w: WeaponDef, heavy: boolean, pos?: THREE.Vector3, owner?: string | number): void {
    const fallback = namedInfo(GENERIC_FIRE.KNIFE);
    if (!pos) return this.play(this.swingFile(w, heavy), { key: `own:${w.id}`, fallback });
    this.playAt(this.swingFile(w, heavy), pos, { key: owner === undefined ? undefined : `${owner}:${w.id}`, fallback });
  }
  explode(w: WeaponDef, pos: THREE.Vector3, kind: string | null = null): void {
    this.playAt(this.explodeFile(w, kind), pos, { fallback: namedInfo(kind === "flash" ? "wm_flash_explosion" : "wm_k400_explosion") });
  }
  /**
   * Local character hurt by a blast (0x60ef90, after the explosion's OnHit vf+0x10c): table row 0 idx 9 =
   * WM_K400_Explosion_Damage at the character. FlashBang: row 1 idx 9 = WM_Flash_Explosion_Damage when blinded (0x6340bf).
   */
  explosionHurt(flash = false): void {
    const file = this.named(flash ? "wm_flash_explosion_damage" : "wm_k400_explosion_damage");
    // the ring is not under the flash's own duck (FlashTinnitus lowers the listener gain): straight to the effects group
    this.start(file, null, { fallback: namedInfo("wm_flash_explosion_damage") }, flash ? effectsBus(this.listener.context) : undefined);
  }
  knifeHit(terrain: SoundTerrain, pos: THREE.Vector3): void {
    this.playAt(this.knifeHitFile(terrain), pos);
  }
  graze(pos: THREE.Vector3): void {
    this.playAt(this.grazeFile(), pos);
  }
  /**
   * Bullet hit on a surface or a character ("Human" / "Head"): reserved, not played. DoLineCollision / _CalcHitWorld
   * (0x60fc40 / 0x609a30) call ReserveSoundPlay 0x699d70, which keeps one reservation per (sound type, terrain) a frame,
   * the one nearest the listener; the manager's flush 0x699f70 plays them. Web: the flush runs once the current frame's
   * code is done (microtask).
   */
  hitAt(terrain: SoundTerrain, pos: THREE.Vector3): void {
    const file = this.hitFile(terrain);
    if (!file) return;
    const key = terrain === "Human" || terrain === "Head" ? "Human" : `${terrain}`; // one reservation per terrain type
    const d = listenerDistance(this.listener, pos);
    const r = this.reserved.get(key);
    if (r) {
      if (d < r.d) { r.file = file; r.pos.copy(pos); r.d = d; }
      return;
    }
    if (!this.reserved.size) queueMicrotask(() => this.flushHits());
    this.reserved.set(key, { file, pos: pos.clone(), d });
  }
  private flushHits(): void {
    for (const r of this.reserved.values()) this.playAt(r.file, r.pos);
    this.reserved.clear();
  }
  bounce(w: WeaponDef, pos: THREE.Vector3, terrain?: number): void {
    const own = this.boundFile(terrain, w);
    if (own) return this.playAt(own, pos);
    const list = this.pack(w)?.other;
    const f = list && list.length ? list[(Math.random() * list.length) | 0] : this.index?.packs["Throw_Common"]?.other?.[0];
    this.playAt(f, pos, { fallback: namedInfo("wm_throw_bound") });
  }
}
