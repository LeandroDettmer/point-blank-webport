// Match preload: every asset the players of a match can show or play, loaded and decoded
// into the shared caches before the first match frame. Measured before it (prod, cold cache): ~110 requests / 7.7 MB in the
// first 60 s of a match, 0.18-0.5 s each from the asset bucket, so the first shot / reload / swap / impact / casing / kill of
// each kind came late. Online the set comes from the room (USER_EQUIPMENT 3667 of every slot, sent at LOADING_START), offline
// from the test loadout and the bots.
import * as THREE from "three";
import { CurrentMap } from "../config";
import { jsonOnce } from "../jsonOnce";
import { keepImage, UI_BASE } from "../lobby/ui/assets";
import { loadStrings } from "../lobby/ui/i18n";
import { loadItemNames } from "../lobby/state/itemNames";
import { WeaponDb } from "../weapons/data";
import { SfxCatalog } from "../weapons/audio";
import { fxUrl, loadWeaponFx, sightInfo } from "../weapons/sights";
import { preloadFx } from "../weapons/effects";
import { createWeaponModel } from "../weapons/worldModel";
import { loadWeaponAnimSet } from "../weapons/weaponAnim";
import { preloadViewmodel, setViewmodelChara } from "../weapons/viewmodel";
import type { WeaponDef } from "../weapons/types";
import { applyPbCharaLighting, createPbMtl, disposePbMtl } from "../render/pbLighting";
import { animSkelFor, createCharVisual, preloadChara, preloadCharacters, type CharVisual } from "./charModel";
import { preloadHeadgear, type HeadEquip } from "./charEquip";
import { preloadWeaponAnim3pv } from "./charAnimLib";
import { upperClassOf } from "./charAnim";
import { preloadCharSfx } from "./charSfx";
import { preloadHudArt } from "./pbHud/PbHud";
import { preloadAmbient } from "./audio3d";
import { loadCharaHp } from "../gameplay/charaHp";
import { currentMapProps, propSoundFiles } from "./mapProps";
import { radioVoiceOf } from "./charGender";
import { preloadBomb } from "./bombVisual";
import { ClassicOptionWindow } from "./classicOptionWindow";
import { EscMenu } from "./escMenu";
import { preloadRadioVoices } from "./radioHud";
import type { Team } from "./types";

const W = "/assets/weapons";

export interface MatchSet {
  /** item ids of every weapon in the match: each player's equipped ones, the bots' K-2 */
  weapons: number[];
  /** every player's character (null = the side's basic one) and head equipment */
  charas: { itemId?: number | null; team: Team; equip?: HeadEquip }[];
  /** the local player: 1PV arms of `chara` on `team`, 1PV clips of `weapons` */
  local: { chara?: number | null; team: Team; weapons: number[] };
  /** bomb mode: the C4 model and clips, bombsites.json (BombVisual / Game.initBomb) */
  bomb?: boolean;
}

/** held so the scope textures stay decoded until the first zoom draws them */
const scopeArt: HTMLImageElement[] = [];
/** the in-battle UI that Game.create mounts without waiting (ESC menu, T menu, chat, vote), their sheets and data */
async function preloadBattleUi(localDefs: WeaponDef[]): Promise<void> {
  // Cross weapon icon index (ui/cross/icons, 1.3 MB): the T menu's weapon icons; sheet paths are under UI_BASE
  const icons = await jsonOnce<{ icons: Record<string, { sheet: string; status: string }> }>(`${UI_BASE}/cross/icons/index.json`).catch(() => null);
  for (const d of localDefs) { // the T menu opens on the local loadout: its weapon icons
    const ic = icons?.icons[String(d.id)];
    if (ic && ic.status !== "missing") keepImage(`${UI_BASE}/${ic.sheet}`);
  }
  await Promise.all([
    loadStrings(), loadItemNames(), ClassicOptionWindow.preload(), EscMenu.preload(),
  ]);
}

/** ScopeOverlay draws the HUD texture of the weapon (an Image on the first zoom): decode the ones of the match's scoped weapons now */
function preloadScopes(defs: WeaponDef[]): Promise<void> {
  const urls = new Set<string>();
  for (const d of defs) { const hud = sightInfo(d.id)?.hud; if (hud) urls.add(fxUrl(hud)); }
  return Promise.all([...urls].map((u) => new Promise<void>((ok) => {
    const i = new Image();
    i.onload = i.onerror = () => ok();
    i.src = u;
    scopeArt.push(i);
  }))).then(() => {});
}

/** Objects for the shader / texture warm-up (render/warmup.ts warmScene); dispose() after it. */
export interface WarmSet {
  objects: THREE.Object3D[];
  dispose(): void;
}

/** Loads `set` into the shared caches (sounds decoded, models parsed, textures decoded). Never rejects: a missing file is skipped. */
export async function preloadMatch(set: MatchSet): Promise<WarmSet> {
  const t0 = performance.now();
  const db = new WeaponDb();
  const sfx = new SfxCatalog(W);
  setViewmodelChara(set.local.chara, set.local.team); // the arms preloadViewmodel loads (Game.create sets the same pair again)
  await Promise.all([
    db.load("/assets/cross/weapons/weapons.json").catch((e) => console.warn("[preload] weapons.json", e)),
    sfx.load().catch((e) => console.warn("[preload] sfx index", e)),
    loadWeaponFx(W),
    preloadCharacters(),
  ]);
  const defOf = (id: number) => (id > 0 ? db.def(id) : undefined);
  // the default knife too: a Ballistic Knife out of blades turns into it (WeaponSystem dropBallistic)
  const ids = [...new Set([...set.weapons, ...set.local.weapons, db.defaultLoadout.melee ?? 0])];
  const defs = ids.map(defOf).filter((d): d is WeaponDef => !!d);
  const localDefs = set.local.weapons.map(defOf).filter((d): d is WeaponDef => !!d);

  const mtl = createPbMtl();
  const objects: THREE.Object3D[] = [];
  const visuals: CharVisual[] = [];
  const ais: string[] = [];
  const pb = (o: THREE.Object3D) => { applyPbCharaLighting(o, mtl); objects.push(o); };
  const models = Promise.all(defs.map(async (d) => {
    const grenade = d.family === "GRENADE";
    // hand / 3PV model; a throwable also its projectile (C5: the brick that flies, worldModel projectile)
    const [inst, thrown] = await Promise.all([
      createWeaponModel(d.id, d.family, { grenade }).catch(() => null),
      grenade ? createWeaponModel(d.id, d.family, { grenade, projectile: true }).catch(() => null) : null,
    ]);
    if (inst) pb(inst.object);
    if (thrown && thrown.entry !== inst?.entry) pb(thrown.object);
    const anims = inst ? await loadWeaponAnimSet(inst.entry.id) : null; // the weapon's own clips (1PV / 3PV animator)
    if (anims) ais.push(anims.ai);
  }));
  const charas = new Map<string, { itemId: number | null; team: Team; equip?: HeadEquip }>();
  for (const c of [...set.charas, { team: 0 as Team }, { team: 1 as Team }]) charas.set(`${c.itemId ?? 0}/${c.team}/${c.equip?.head ?? 0}/${c.equip?.face ?? 0}/${c.equip?.beret ?? 0}`, { ...c, itemId: c.itemId ?? null });
  // the room map's breakable props (buildRealLevel ran before): their break effect + sound, played by Game.propBroken
  const breakFx = new Set<string>(), breakSnd = new Set<string>();
  for (const p of currentMapProps()?.props ?? []) {
    for (const s of propSoundFiles(p.def)) breakSnd.add(`objects/${s}`); // break + the intact state's ambient loops (Game.onAmbient)
    if (!p.def.breakable) continue;
    for (const n of p.def.breakEffects ?? []) breakFx.add(n);
  }
  // radio voices of the match's characters (RadioHud.receive: the sender's gender)
  const voices = new Set<"Man" | "Women">();
  for (const c of charas.values()) voices.add(radioVoiceOf(c.itemId, c.team));
  const skels = new Set<string>();
  for (const c of charas.values()) skels.add(animSkelFor(c.itemId, c.team));
  await Promise.all([
    models.then(() => sfx.preloadMatch(defs, ais)),
    ...[...charas.values()].map(async (c) => {
      const name = await preloadChara(c.itemId, c.team);
      if (name) for (const g of await preloadHeadgear(name, c.equip)) pb(g.clone(true));
    }),
    preloadCharSfx(),
    preloadAmbient("/assets", CurrentMap),
    preloadHudArt(ids, CurrentMap),
    preloadBattleUi(localDefs),
    preloadScopes(defs),
    ...(set.bomb ? [preloadBomb(), jsonOnce("/assets/cross/maps/bombsites.json").catch(() => null)] : []),
    preloadViewmodel(localDefs),
    // 3PV clips of each skeleton family present (female bundle only when a female character is in the match)
    ...[...skels].flatMap((skel) => defs.map((d) => preloadWeaponAnim3pv(d.id, upperClassOf(d.family), skel))),
    preloadFx(defs, breakFx).then((o) => { objects.push(...o); }),
    sfx.preloadFiles(breakSnd),
    preloadRadioVoices(voices),
    loadCharaHp(),
  ]);
  // one visual per character model of the match (skinned PB shader + its textures)
  const seen = new Set<string | null>();
  for (const c of charas.values()) {
    const v = createCharVisual(c.team, { itemId: c.itemId ?? undefined });
    if (seen.has(v.charaName)) { v.dispose(); continue; }
    seen.add(v.charaName);
    visuals.push(v);
    objects.push(v.root);
  }
  console.info(`[preload] ${defs.length} weapons, ${visuals.length} characters: ${Math.round(performance.now() - t0)} ms`);
  return {
    objects,
    dispose() {
      for (const v of visuals) v.dispose();
      disposePbMtl(mtl);
    },
  };
}
