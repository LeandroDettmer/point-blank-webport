import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { registerModelCompressedTextures } from "../render/compressedTex";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { assetExists } from "../assetProbe";
import { jsonOnce } from "../jsonOnce";
import { loadLodFirst } from "../assetLod";
import type { Family } from "../weapons/types";
import { createWeaponModel, weaponDualFire, weaponFamily } from "../weapons/worldModel";
import { setC4Lcd } from "../weapons/c4Lcd";
import type { WeaponAnimator } from "../weapons/weaponAnim";
import { CharAnimator, upperClassOf, type CharAnimInput, type Dir8 } from "./charAnim";
import type { Team } from "./types";
import { applyPbCharaLighting, createPbMtl, disposePbMtl } from "../render/pbLighting";
import { resolveChara } from "./loadout";
import { actorEquip, attachHeadgear, equipKey, keepCharaCulling, type HeadEquip } from "./charEquip";
import { loadRagdoll, ragdolls, type DeathHit, type Ragdoll } from "./ragdoll";
import { getSettings } from "../gameplay/settings";

/*
 * Character visuals: original PB characters from public/assets/chars/index.json (pb-extract-tools export-model.mjs):
 *   { chars: [{ name, team: "red"|"blue", model: "<name>/model.glb", hitboxes, attach, arms1pv, clips }] }
 * (legacy {red,blue} / string[] manifests still work). Per team: ?charRed=<name> / ?charBlue=<name> > first char of
 * that team > any char (tinted for the red team when both teams share one model) > capsule placeholder.
 * Team default = the side's basic character (Basic.xml, loadout.ts resolveChara). A visual created with
 * { itemId } (equipped chara_red_side / chara_blue_side, RESPAWN 5138) uses that character once preloadChara(itemId)
 * resolved; until then, or with no model for the itemId, the team default.
 *
 * The GLB faces +Z with feet at y=0 (metres); CharVisual.root is in the game's actor frame (feet at origin, yaw 0 looks
 * down -Z), the model sits under a 180° flip. Animation = CharAnimator (charAnim.ts), weapon = worldModel.ts attached
 * to WeaponPointDummyRight (GunDummy grip).
 *
 * Game-side usage (bots / remotes / local shadow):
 *   const v = createCharVisual(team);            scene.add(v.root);
 *   v.setWeapon("AK-47 SOPMOD", "AR");           // name or numeric id; family optional (looked up in weapons.json)
 *   v.update(dt, { pos: feet, yaw, pitch, vel, crouch, grounded, alive });   // every frame
 *   v.fire(); v.reload(seconds); v.change(); v.hurt(); v.die(shotDir); v.respawn();
 *   getBoneHitboxes(v.root) -> per-bone OBBs for hitColliders.ts (see below).
 */

export interface CharDriveState {
  /** feet position, world */
  pos: THREE.Vector3;
  yaw: number;
  /** look pitch, + = up (optional, default 0) */
  pitch?: number;
  /** world velocity m/s (optional: derived from pos deltas when omitted) */
  vel?: THREE.Vector3;
  crouch: boolean;
  grounded?: boolean;
  alive: boolean;
  zoom?: boolean;
  /** legs in motion (net remotes / local shadow: the replicated `moving` bit). Omitted: inferred from vel */
  moving?: boolean;
  /** MST WALK vs run (net remotes / local shadow: `!running`). Omitted: inferred from speed */
  walking?: boolean;
  /** 8-way lower-body direction, actor frame (net remotes: replicated `moveDir`). Omitted: inferred from vel */
  dir8?: Dir8;
}

export interface CharVisualOptions {
  /** invisible body that only casts shadows (local player's own shadow in 1st person) */
  shadowOnly?: boolean;
  /** equipped character itemId: its chars/index.json entry (preloadChara first), else the team default */
  itemId?: number;
  /** equipped head / face / beret (charEquip.ts); omitted = default helmet only */
  equip?: HeadEquip;
  /** match actor id whose BATTLE_RESPAWN_ACK equipment (charEquip.ts actorEquip) is followed every update */
  equipActor?: string;
}

export type HitboxZone = "head" | "body" | "arm" | "hand" | "leg" | "foot";

interface HitboxDef {
  bone: string;
  shape: string;
  zone: string;
  min: [number, number, number];
  max: [number, number, number];
}

/** One per-bone hitbox of the original model: an oriented box in the bone's local frame (metres). */
export interface BoneHitbox {
  bone: THREE.Object3D;
  boneName: string;
  /** original i3 shape name (H_Head, B_Spine1, AU_R UpperArm ...) */
  shape: string;
  zone: HitboxZone;
  /** box in bone-local space */
  min: THREE.Vector3;
  max: THREE.Vector3;
  center: THREE.Vector3;
  halfSize: THREE.Vector3;
}

interface CharEntry {
  name: string;
  /** "female" | "male" (chars/index.json) */
  family?: string;
  team?: string;
  itemId?: number | null;
  itemIds?: number[] | null;
  model?: string;
  hitboxes?: HitboxDef[];
  arms1pv?: { model: string };
  /** skins without their own animations borrow the clips of this char (same 63-bone skeleton) */
  clipsFrom?: string | null;
}

interface Template {
  name: string;
  scene: THREE.Object3D;
  clips: THREE.AnimationClip[];
  hitboxes: HitboxDef[];
}

const RED_TINT = new THREE.Color(1.0, 0.72, 0.66);
const templates: (Template | null)[] = [null, null];
let entries: CharEntry[] = [];
let loaded: Promise<void> | null = null;
/** templates by chars/index.json name (team defaults and itemId characters share them) */
const byName = new Map<string, Promise<Template | null>>();
const readyByName = new Map<string, Template | null>();
let loadTemplate: (name: string) => Promise<Template | null> = async () => null;
const live = new Set<CharVisual>();
const animLog = typeof location !== "undefined" && new URLSearchParams(location.search).has("animlog");

async function readManifest(): Promise<{ names: [string, string]; list: CharEntry[] }> {
  const p = new URLSearchParams(location.search);
  let names: [string, string] = ["red", "blue"];
  let list: CharEntry[] = [];
  try {
    // jsonOnce rejects HTTP errors and non-JSON bodies (vite's index.html for a missing file)
    const j = await jsonOnce<any>("/assets/chars/index.json");
    if (j && Array.isArray(j.chars) && j.chars.length) {
      list = j.chars as CharEntry[];
      const pick = (team: Team) => resolveChara(list, null, team).entry!.name;
      names = [pick(0), pick(1)];
    } else if (Array.isArray(j) && j.length) names = [String(j[0]), String(j[1] ?? j[0])];
    else if (j && typeof j === "object") names = [String(j.red ?? names[0]), String(j.blue ?? names[1])];
  } catch {
    /* no manifest */
  }
  return { names: [p.get("charRed") ?? names[0], p.get("charBlue") ?? names[1]], list };
}

function tintClone(scene: THREE.Object3D, tint: THREE.Color): THREE.Object3D {
  const c = SkeletonUtils.clone(scene);
  const done = new Map<THREE.Material, THREE.Material>();
  c.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const out = mats.map((mat) => {
      let n = done.get(mat);
      if (!n) {
        n = mat.clone();
        (n as THREE.MeshStandardMaterial).color?.multiply(tint);
        done.set(mat, n);
      }
      return n;
    });
    m.material = Array.isArray(m.material) ? out : out[0];
  });
  return c;
}

export function preloadCharacters(): Promise<void> {
  loaded ??= (async () => {
    const { names, list } = await readManifest();
    entries = list;
    const loader = registerModelCompressedTextures(new GLTFLoader());
    const clipCache = new Map<string, Promise<THREE.AnimationClip[]>>();
    const clipsOf = (name: string): Promise<THREE.AnimationClip[]> => {
      let p = clipCache.get(name);
      if (!p) {
        const e = list.find((c) => c.name === name);
        p = loadLodFirst(loader, `/assets/chars/${e?.model ?? `${name}/model.glb`}`).then((g) => g.animations, () => []);
        clipCache.set(name, p);
      }
      return p;
    };
    const load = (name: string) => {
      let p = byName.get(name);
      if (!p) {
        const entry = list.find((c) => c.name === name);
        const url = `/assets/chars/${entry?.model ?? `${name}/model.glb`}`;
        p = (async () => {
          if (!(await assetExists(url))) return null;
          try {
            const gltf = await loadLodFirst(loader, url);
            const scene = gltf.scene;
            let clips = gltf.animations;
            if (!clips.length && entry?.clipsFrom && entry.clipsFrom !== name) clips = await clipsOf(entry.clipsFrom);
            const skinned = clips.length > 0 && CharAnimator.hasLayers(clips);
            if (!skinned) {
              // legacy/static models: normalise to 1.8 m, feet at 0
              const box = new THREE.Box3().setFromObject(scene);
              const h = box.max.y - box.min.y;
              if (h > 0.01) {
                const s = 1.8 / h;
                scene.scale.setScalar(s);
                scene.position.y = -box.min.y * s;
              }
            }
            scene.updateMatrixWorld(true);
            scene.traverse((o) => {
              if ((o as THREE.Mesh).isMesh) {
                o.castShadow = true;
                keepCharaCulling(o); // skinned bind-pose sphere grown by 2 m (death clips move that far)
              }
            });
            const extras = (gltf.userData ?? {}) as { hitboxes?: HitboxDef[] };
            const hitboxes = entry?.hitboxes ?? extras.hitboxes ?? [];
            console.info(`[chars] ${name}: ${url} (${clips.length} clips${gltf.animations.length ? "" : ` from ${entry?.clipsFrom}`}, ${hitboxes.length} hitboxes)`);
            return { name, scene, clips, hitboxes };
          } catch (err) {
            console.warn(`[chars] failed to load ${url}`, err);
            return null;
          }
        })();
        byName.set(name, p);
        void p.then((t) => readyByName.set(name, t));
      }
      return p;
    };
    loadTemplate = load;
    let [red, blue] = await Promise.all(names.map(load));
    // fall back to any available character so both teams get the real model
    if (!red && blue) red = blue;
    if (!blue && red) blue = red;
    if (red && red === blue) red = { ...red, scene: tintClone(red.scene, RED_TINT) };
    templates[0] = red;
    templates[1] = blue;
  })();
  return loaded;
}

/** chars/<skel>/anim3pv library of an equipped itemId's character (same rule as CharVisual.animSkel); needs preloadCharacters. */
export function animSkelFor(itemId: number | null | undefined, team: Team): string {
  return resolveChara(entries, itemId, team).entry?.family === "female" ? "swat_female" : "swat_male";
}

/** Loads the character of an equipped itemId (resolveChara) so createCharVisual(team, { itemId }) can use it. */
export async function preloadChara(itemId: number | null | undefined, team: Team): Promise<string | null> {
  await preloadCharacters();
  const r = resolveChara(entries, itemId, team);
  if (!r.entry) return null;
  const t = await loadTemplate(r.entry.name);
  if (itemId && r.source !== "itemId") console.info(`[chars] item ${itemId}: no model, ${r.source} fallback ${r.entry.name}`);
  return t ? r.entry.name : null;
}

function templateFor(team: Team, itemId?: number): Template | null {
  if (itemId) {
    const r = resolveChara(entries, itemId, team);
    const t = r.entry ? readyByName.get(r.entry.name) : undefined;
    if (t) return t;
  }
  return templates[team];
}

/** No GLB for this character (yet): draw nothing rather than an invented capsule body. */
function placeholder(_team: Team): THREE.Object3D {
  return new THREE.Group();
}

function makeShadowOnly(o: THREE.Object3D): void {
  o.traverse((n) => {
    const m = n as THREE.Mesh;
    if (!m.isMesh) return;
    const conv = (mat: THREE.Material) => {
      const c = mat.clone();
      c.colorWrite = false;
      c.depthWrite = false;
      return c;
    };
    m.material = Array.isArray(m.material) ? m.material.map(conv) : conv(m.material);
    m.castShadow = true;
    m.receiveShadow = false;
    // shadowMap is off and colorWrite=false: never drawn. Hidden meshes keep the node graph, animation and matrixWorld
    // (updateMatrixWorld ignores visible); helmetSource / muzzleWorld only read matrices.
    m.visible = false;
  });
}

const _v = new THREE.Vector3();

/** Mission/C4 3PV Attack = Up_Install (2017 I3CHR), 5 s */
const C4_INSTALL_S = 5;

export class CharVisual {
  /** actor frame: feet at origin, rotation.y = game yaw (0 looks down -Z) */
  readonly root = new THREE.Group();
  /** skinned GLB instance (null = placeholder) */
  readonly model: THREE.Object3D | null;
  readonly anim: CharAnimator | null;
  private body: THREE.Object3D;
  private hand: THREE.Object3D | null = null;
  /** WeaponPointDummyLeft: the weapon's parent during left-hand LoadMag / LoadBullet (weaponAnim.ts leftGrip) */
  private handL: THREE.Object3D | null = null;
  private weaponObj: THREE.Object3D | null = null;
  /** the weapon's own 3PV clips (magazine / slide / pump, weaponAnim.ts) */
  private weaponAnim: WeaponAnimator | null = null;
  private muzzleNode: THREE.Object3D | null = null;
  /**
   * Dual-wield gun (worldModel dualFire): a 2nd instance of the model on WeaponPointDummyLeft (WeaponDual::AttachNode
   * 0x648440, same model, not mirrored). "alt" = the hands take turns, right first (WeaponDualHandGun +0xa550, reset by
   * the reload 0x649c60); "both" = both guns each shot (DualSMG). The upper body plays AttackLeft / AttackBoth.
   */
  private dual: "alt" | "both" | "melee" | null = null;
  private weaponObjL: THREE.Object3D | null = null;
  private weaponAnimL: WeaponAnimator | null = null;
  private muzzleNodeL: THREE.Object3D | null = null;
  private nextLeft = false;
  /** hand of the last shot ("alt" dual): muzzleWorld() follows it */
  private side: "R" | "L" = "R";
  /** FXLaserSightDummy of the 3rd-person weapon model (laser.ts createLaserBeam parent), null when absent */
  laserDummy: THREE.Object3D | null = null;
  private weaponKey = "";
  private weaponTok = 0;
  private lastPos = new THREE.Vector3();
  private hasLast = false;
  private vel = new THREE.Vector3();
  private deadT = -1;
  private wasAlive = true;
  readonly shadowOnly: boolean;
  /** chars/index.json name of the model in use (null = placeholder) */
  readonly charaName: string | null;
  /** chars/<skel>/anim3pv library of this character's family (charAnimLib.bindWeaponAnim): female chars have their own poses */
  get animSkel(): string { return entries.find((e) => e.name === this.charaName)?.family === "female" ? "swat_female" : "swat_male"; }
  /** i3MaterialAttr state of this chara (light-volume colour), shared by body and 3rd-person weapon */
  private readonly pbMtl = createPbMtl();
  /** head accessories on HelmetPointDummy (charEquip.ts) and the equipment they were built for */
  private equipObjs: THREE.Object3D[] = [];
  private equipKey: string | null = null;
  private equipTok = 0;
  private readonly equipActor: string | undefined;
  /** the helmet-slot accessory is on the head (false: not equipped / popped off by HELMET PROTECTION) */
  private helmetOn = true;
  private equip: HeadEquip | undefined;

  constructor(readonly team: Team, opts: CharVisualOptions = {}) {
    this.shadowOnly = !!opts.shadowOnly;
    const t = templateFor(team, opts.itemId);
    this.charaName = t?.name ?? null;
    if (t) {
      const inner = SkeletonUtils.clone(t.scene);
      inner.userData.hitboxDefs = t.hitboxes;
      const flip = new THREE.Group();
      flip.rotation.y = Math.PI; // GLB faces +Z, actor frame faces -Z
      flip.add(inner);
      this.root.add(flip);
      this.model = inner;
      this.body = flip;
      this.hand = inner.getObjectByName("WeaponPointDummyRight") ?? inner.getObjectByName("R_Hand") ?? null;
      this.handL = inner.getObjectByName("WeaponPointDummyLeft") ?? null;
      this.anim = CharAnimator.hasLayers(t.clips) ? new CharAnimator(inner, t.clips) : null;
      if (this.anim) {
        this.anim.aimFrame = this.root;
        if (animLog) this.anim.onState = (layer, clip) => console.info(`[anim] ${team ? "blue" : "red"}#${this.id} ${layer}: ${clip}`);
      }
    } else {
      this.model = null;
      this.anim = null;
      this.body = placeholder(team);
      this.root.add(this.body);
    }
    this.root.userData.charVisual = this;
    if (this.shadowOnly) makeShadowOnly(this.root);
    else applyPbCharaLighting(this.root, this.pbMtl);
    live.add(this);
    this.equipActor = opts.equipActor;
    this.setEquip(opts.equip ?? (this.equipActor ? actorEquip(this.equipActor) : undefined));
    if (this.model && this.charaName && !this.shadowOnly && getSettings().ragdoll) void loadRagdoll(this.charaName).then((d) => (this.ragdollData = d));
  }

  /** Head accessories (default helmet + head / face / beret items) on HelmetPointDummy; no-op for the same set. */
  setEquip(eq: HeadEquip | undefined): void {
    const k = equipKey(eq);
    if (!this.model || !this.charaName || k === this.equipKey) return;
    this.equipKey = k;
    this.equip = eq;
    const tok = ++this.equipTok;
    void attachHeadgear(this.model, this.charaName, eq).then((objs) => {
      if (tok !== this.equipTok || !live.has(this)) { for (const o of objs) o.removeFromParent(); return; }
      for (const o of this.equipObjs) o.removeFromParent();
      this.equipObjs = objs;
      for (const o of objs) {
        if (o.userData.helmet) o.visible = this.helmetOn;
        if (this.shadowOnly) { makeShadowOnly(o); if ((o as THREE.Mesh).isMesh) o.visible = false; }
        else applyPbCharaLighting(o, this.pbMtl);
      }
    });
  }

  /** Shows / hides the helmet-slot accessory (the actor's Actor.helmet: equipped and not popped off this life). */
  setHelmet(on: boolean): void {
    if (on === this.helmetOn) return;
    this.helmetOn = on;
    for (const o of this.equipObjs) if (o.userData.helmet) o.visible = on && !(this.shadowOnly && (o as THREE.Mesh).isMesh);
  }

  /** What a dropped helmet copies: the chara, its equipment and the helmet's current world matrix (null = none drawn). */
  helmetSource(): { charaName: string; equip: HeadEquip | undefined; matrix: THREE.Matrix4 } | null {
    const h = this.equipObjs.find((o) => o.userData.helmet);
    if (!h || !this.charaName) return null;
    h.updateWorldMatrix(true, false);
    return { charaName: this.charaName, equip: this.equip, matrix: h.matrixWorld.clone() };
  }

  private static seq = 0;
  readonly id = ++CharVisual.seq;

  /** legacy access (bots used visual.mixer) */
  get mixer(): THREE.AnimationMixer | null {
    return this.anim?.mixer ?? null;
  }

  /** Active clip names (debug / headless validation). */
  activeClips(): string[] {
    return this.anim ? [...this.anim.active] : [];
  }

  /** Equip a weapon: switches the upper-body class and attaches the 3rd-person model to the right hand. */
  setWeapon(key: string | number, family?: Family): void {
    const k = `${key}|${family ?? ""}`;
    if (k === this.weaponKey) return;
    this.weaponKey = k;
    const tok = ++this.weaponTok;
    void (async () => {
      const fam = family ?? (await weaponFamily(key));
      if (tok !== this.weaponTok) return;
      this.anim?.setClass(upperClassOf(fam));
      // no hand (placeholder body) or a failed model load: forget the key so the next setWeapon mounts it, instead
      // of treating the weapon as already in hand (the hand stayed empty for the rest of the life)
      if (!this.hand) { this.weaponKey = ""; return; }
      const [inst, dual] = await Promise.all([createWeaponModel(key, fam), weaponDualFire(key)])
        .catch((e) => { console.warn(`[charModel] weapon ${key}`, e); return [null, null] as const; });
      if (tok !== this.weaponTok) return;
      if (!inst) this.weaponKey = "";
      if (this.weaponObj) this.weaponObj.removeFromParent();
      this.weaponObjL?.removeFromParent();
      this.weaponObjL = this.muzzleNodeL = this.weaponAnimL = null;
      this.dual = inst && this.handL ? dual : null;
      this.nextLeft = false;
      this.side = "R";
      if (this.dual) this.mountLeft(key, fam, tok);
      this.weaponObj = inst?.object ?? null;
      this.muzzleNode = inst?.muzzle ?? null;
      this.laserDummy = inst?.object.getObjectByName("FXLaserSightDummy") ?? null;
      this.weaponAnim = null;
      void inst?.animator("3pv").then((a) => {
        if (tok !== this.weaponTok) return;
        this.weaponAnim = a;
        a?.syncExt(this.silencerOn);
      });
      if (this.weaponObj) {
        if (this.shadowOnly) makeShadowOnly(this.weaponObj);
        else applyPbCharaLighting(this.weaponObj, this.pbMtl);
        this.hand.add(this.weaponObj);
      }
    })();
  }

  /** Dual wield: the left gun, its muzzle and its own clips (slide / magazine) on WeaponPointDummyLeft. */
  private mountLeft(key: string | number, fam: Family, tok: number): void {
    void createWeaponModel(key, fam).then((l) => {
      if (!l || tok !== this.weaponTok || !this.handL || !live.has(this)) return;
      if (this.shadowOnly) makeShadowOnly(l.object);
      else applyPbCharaLighting(l.object, this.pbMtl);
      this.handL.add(l.object);
      this.weaponObjL = l.object;
      this.muzzleNodeL = l.muzzle;
      void l.animator("3pv").then((a) => {
        if (a) a.hand = "L"; // DualKnife: Idle_Male_Left / Change_Left ...
        if (tok === this.weaponTok) this.weaponAnimL = a;
      });
    });
  }

  /** One shot: upper Attack (dual: the hand whose turn it is, or both) + the firing gun's own Fire clip. */
  fire(heavy = false): void {
    let hand: "L" | "both" | undefined;
    if (this.dual === "both") hand = "both";
    else if (this.dual === "alt") {
      hand = this.nextLeft ? "L" : undefined;
      this.nextLeft = !this.nextLeft;
    }
    this.side = hand === "L" ? "L" : "R";
    this.anim?.fire(heavy, hand);
    if (this.dual === "melee") {
      const k = heavy ? "attackB" : "attackA";
      this.weaponAnim?.play(k);
      this.weaponAnimL?.play(k);
    }
    if (hand !== "L") this.weaponAnim?.fire();
    if (hand) this.weaponAnimL?.fire();
  }
  reload(duration?: number): void {
    this.nextLeft = false; // WeaponDualHandGun reload 0x649c60: the right gun fires first again
    this.anim?.reload(duration);
    this.weaponAnim?.play("reload", duration); // LoadMag over ReloadTime, like the upper LoadMagazine (exe 0x611980)
    this.weaponAnimL?.play("reload", duration);
  }
  change(): void {
    this.anim?.change();
    this.weaponAnim?.play("change");
    this.weaponAnimL?.play("change");
  }
  /** Bomb Mission C4 held plant: the upper Install clip (Mission/C4 Attack, 5 s) until released; the LCD on the C4 types along */
  private plantT = -1;
  plant(on: boolean): void {
    if (on) { this.anim?.hold("Attack"); this.plantT = 0; } else { this.anim?.release(); this.plantT = -1; if (this.weaponObj) setC4Lcd(this.weaponObj, 1); }
  }
  /** RMB silencer extension of the held weapon: the silencer mesh + ExtensionActivate / Deactivate of the weapon model (the upper body keeps AttackIdle) */
  private silencerOn = false;
  setSilencer(on: boolean, animate: boolean): void {
    this.silencerOn = on;
    const a = this.weaponAnim;
    if (!a) return;
    if (animate) a.setExt(on, true, a.set.states.ExtensionActivate?.dur ?? 2);
    else a.syncExt(on);
  }
  /** grenade pin out: the upper AttackReady, held until the throw (fire) or a swap replaces it */
  throwReady(): void {
    this.anim?.ready();
  }
  /** dual-wield mode of the held weapon (null = one gun) */
  get dualMode(): "alt" | "both" | "melee" | null {
    return this.dual;
  }
  /** `shotDir` = world direction the bullet travelled (same frame as die): picks DamageFrontLeftA / FrontRightA / BackA */
  hurt(shotDir?: THREE.Vector3): void {
    let from: "FrontLeft" | "FrontRight" | "Back" | undefined;
    if (shotDir) {
      const yaw = this.root.rotation.y;
      const f = shotDir.x * -Math.sin(yaw) + shotDir.z * -Math.cos(yaw);
      const r = shotDir.x * Math.cos(yaw) + shotDir.z * -Math.sin(yaw);
      // travelling along our forward = hit in the back; travelling to our right = came from the left
      from = f > 0 && f >= Math.abs(r) ? "Back" : r > 0 ? "FrontLeft" : "FrontRight";
    }
    this.anim?.hurt(from);
  }

  /** The shot / blast that may kill this character (game.ts, every hit it sees): the death push and the clip direction. */
  noteHit(h: DeathHit): void {
    this.lastHit = { ...h, at: performance.now() };
  }
  private lastHit: (DeathHit & { at: number }) | null = null;
  private ragdollData: Awaited<ReturnType<typeof loadRagdoll>> = null;
  private ragdoll: Ragdoll | null = null;

  /**
   * Death. `shotDir` = world direction the killing bullet travelled (picks front/back/left/right); without one the last
   * noted hit gives it. Gráficos > "Efeitos de física" on (exe PhysXEnable, DeathHuman 0x5738fa): the ragdoll of the
   * character's pack takes the current pose instead of a Death clip (ragdoll.ts).
   */
  die(shotDir?: THREE.Vector3, crouch = false): void {
    this.deadT = 0;
    this.wasAlive = false;
    if (!this.anim) return;
    // the noted hit is the killing one when it is recent [INFERIDO window: the death state follows the hit by a few frames]
    const hit = this.lastHit && performance.now() - this.lastHit.at < 1500 ? this.lastHit : null;
    this.lastHit = null;
    shotDir ??= hit?.dir;
    let dir: "Front" | "Back" | "Left" | "Right" = "Front";
    if (shotDir) {
      const yaw = this.root.rotation.y;
      const f = shotDir.x * -Math.sin(yaw) + shotDir.z * -Math.cos(yaw);
      const r = shotDir.x * Math.cos(yaw) + shotDir.z * -Math.sin(yaw);
      // bullet travelling along our forward = hit in the back
      dir = Math.abs(f) >= Math.abs(r) ? (f > 0 ? "Back" : "Front") : r > 0 ? "Left" : "Right";
    }
    this.anim.die(dir, crouch);
    if (ragdolls && this.ragdollData && this.model && getSettings().ragdoll) {
      ragdolls.release(this.ragdoll);
      this.ragdoll = ragdolls.spawn(this.model, this.ragdollData, hit);
    }
  }

  respawn(): void {
    ragdolls?.release(this.ragdoll);
    this.ragdoll = null;
    this.deadT = -1;
    this.wasAlive = true;
    this.hasLast = false;
    this.body.rotation.x = 0;
    this.anim?.respawn();
  }

  /** World position of a skeleton bone by its GLB node name (Neck, Spine3, IK...); null when the model has no such bone. */
  boneWorld(name: string, out: THREE.Vector3): THREE.Vector3 | null {
    const b = this.model?.getObjectByName(name);
    return b ? b.getWorldPosition(out) : null;
  }

  /** Muzzle of the gun that fired last (dual "alt": that hand; "both": `left` picks the left gun). */
  muzzleWorld(out = new THREE.Vector3(), left = this.side === "L"): THREE.Vector3 {
    if (left && this.muzzleNodeL) return this.muzzleNodeL.getWorldPosition(out);
    if (this.muzzleNode) return this.muzzleNode.getWorldPosition(out);
    return this.root.localToWorld(out.set(0.2, 1.4, -0.7));
  }

  update(dt: number, s: CharDriveState): void {
    const r = this.root;
    if (this.equipActor) {
      const eq = actorEquip(this.equipActor);
      if (eq) this.setEquip(eq);
    }
    this.weaponAnim?.syncExt(this.silencerOn);
    this.weaponAnim?.update(dt);
    this.weaponAnimL?.update(dt);
    if (this.plantT >= 0 && this.weaponObj) {
      this.plantT += dt;
      setC4Lcd(this.weaponObj, 1 + Math.min(5, Math.floor((this.plantT / C4_INSTALL_S) * 6)));
    }
    // ChangeAttachHand 0x613f00 (weaponAnim.ts leftGrip): sniper LoadMag / LoadBullet 3PV run on the left hand
    const w = this.weaponObj, want = this.weaponAnim?.leftHand && this.handL ? this.handL : this.hand;
    if (w && want && w.parent !== want) want.add(w);
    if (s.vel) this.vel.copy(s.vel);
    else if (this.hasLast && dt > 0) this.vel.lerp(_v.subVectors(s.pos, this.lastPos).divideScalar(dt), Math.min(1, dt * 10));
    else this.vel.set(0, 0, 0);
    this.lastPos.copy(s.pos);
    this.hasLast = true;
    r.position.copy(s.pos);
    r.rotation.set(0, s.yaw, 0);
    this.pbMtl.update(s.pos, dt);
    if (!s.alive && this.wasAlive) this.die();
    else if (s.alive && !this.wasAlive) this.respawn();
    if (this.anim) {
      r.scale.set(1, 1, 1);
      if (s.alive) {
        const inp: CharAnimInput = {
          vel: this.vel,
          yaw: s.yaw,
          pitch: s.pitch ?? 0,
          crouch: s.crouch,
          grounded: s.grounded ?? true,
          zoom: s.zoom,
          moving: s.moving,
          walking: s.walking,
          dir8: s.dir8,
        };
        this.anim.update(dt, inp);
      } else if (!this.ragdoll) this.anim.update(dt, { vel: this.vel, yaw: s.yaw, pitch: 0, crouch: false, grounded: true });
      return;
    }
    // placeholder: crouch squash + fall over
    if (s.alive) {
      r.scale.y += ((s.crouch ? 0.66 : 1) - r.scale.y) * Math.min(1, dt * 12);
      this.body.rotation.x = 0;
    } else {
      this.deadT += dt;
      this.body.rotation.x = -Math.min(1, this.deadT / 0.45) * (Math.PI / 2) * 0.95;
    }
  }

  /**
   * i3MaterialAttr diffuse alpha of the chara (CGameCharaMaterialContext::SetAlpha 0x8219a0): the PB shader multiplies
   * it into the fragment alpha; blend is on while < 1 (SetBlendEnable 0x821790). Body, head gear and 3rd-person weapon.
   */
  setAlpha(a: number): void {
    this.pbMtl.diffuse.value.w = a;
    const on = a < 1;
    if (on === this.alphaOn) return;
    this.alphaOn = on;
    this.root.traverse((o) => {
      const mats = (o as THREE.Mesh).material;
      for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
        if (!m.userData.pb) continue;
        m.userData.baseTransparent ??= m.transparent;
        m.transparent = on || m.userData.baseTransparent;
        m.needsUpdate = true;
      }
    });
  }
  private alphaOn = false;

  dispose(): void {
    ragdolls?.release(this.ragdoll);
    this.ragdoll = null;
    this.root.removeFromParent();
    this.anim?.mixer.stopAllAction();
    // SkeletonUtils.clone gives each visual its own skeletons; the sweep never sees them once root is detached (boneTexture leak)
    this.root.traverse((o) => (o as THREE.SkinnedMesh).skeleton?.dispose());
    live.delete(this);
    disposePbMtl(this.pbMtl);
  }
}

/**
 * Spawn protection look, exe CGameCharaMaterialContext::ProcessMaterial 0x8221d0: while the chara's invincible time T
 * (chara +0x5c0, the same one that blocks __DeathObject damage) is > 0, alpha = 1 - |sin(6 T)| (sin table 0x52a710,
 * fabs 0x4bb9d0); otherwise 1. A smooth ~1.9 Hz pulse, not an on/off blink. Applies to every chara (local, remote, AI).
 */
export function spawnBlinkAlpha(left: number): number {
  return left > 0 ? 1 - Math.abs(Math.sin(6 * left)) : 1;
}

export function createCharVisual(team: Team, opts?: CharVisualOptions): CharVisual {
  return new CharVisual(team, opts);
}

/** All live visuals (debug / headless validation). */
export function debugCharVisuals(): CharVisual[] {
  return [...live];
}
if (animLog && typeof window !== "undefined") (window as unknown as { __pbChars: () => CharVisual[] }).__pbChars = debugCharVisuals;

/**
 * Per-bone hitboxes of an original character (20 on swat_male: Head, Neck, Spine1-3, Root, clavicles, arms, hands,
 * thighs, calves, feet). `model` = CharVisual.root / CharVisual.model or any object containing the skeleton.
 * Boxes are in bone-local space and follow the animation; use boneHitboxWorld() each frame (or parent a collider
 * proxy to hb.bone). Empty array for placeholder visuals -> keep the capsule hitboxes.
 *
 *   for (const hb of getBoneHitboxes(v.root)) {
 *     boneHitboxWorld(hb, pos, quat, half);   // world center, orientation, half extents (bone scale applied)
 *     collider.setTranslation(pos); collider.setRotation(quat);   // cuboid(half.x, half.y, half.z)
 *     // zone: head -> "head", body -> "body", arm/hand -> "arm", leg/foot -> "leg"
 *   }
 */
export function getBoneHitboxes(model: THREE.Object3D): BoneHitbox[] {
  let holder: THREE.Object3D | null = null;
  model.traverse((o) => {
    if (!holder && Array.isArray(o.userData.hitboxDefs)) holder = o;
  });
  if (!holder) return [];
  const h = holder as THREE.Object3D;
  const cached = h.userData.boneHitboxes as BoneHitbox[] | undefined;
  if (cached) return cached;
  const out: BoneHitbox[] = [];
  for (const d of h.userData.hitboxDefs as HitboxDef[]) {
    // GLTFLoader sanitizes node names ("R UpperArm" -> "R_UpperArm")
    const bone = h.getObjectByName(d.bone) ?? h.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(d.bone));
    if (!bone) continue;
    const min = new THREE.Vector3(...d.min), max = new THREE.Vector3(...d.max);
    out.push({
      bone,
      boneName: d.bone,
      shape: d.shape,
      zone: (["head", "body", "arm", "hand", "leg", "foot"].includes(d.zone) ? d.zone : "body") as HitboxZone,
      min,
      max,
      center: min.clone().add(max).multiplyScalar(0.5),
      halfSize: max.clone().sub(min).multiplyScalar(0.5),
    });
  }
  h.userData.boneHitboxes = out;
  return out;
}

const _s = new THREE.Vector3();
/**
 * World-space OBB of a bone hitbox (call after the visual's update()). `refresh` = false: the caller already ran
 * updateWorldMatrix(true, true) on the actor's visual root this frame (HitColliders.sync does it once per actor).
 */
export function boneHitboxWorld(hb: BoneHitbox, outCenter: THREE.Vector3, outQuat: THREE.Quaternion, outHalf?: THREE.Vector3, refresh = true): void {
  if (refresh) hb.bone.updateWorldMatrix(true, false);
  outCenter.copy(hb.center).applyMatrix4(hb.bone.matrixWorld);
  hb.bone.matrixWorld.decompose(_v, outQuat, _s);
  outHalf?.copy(hb.halfSize).multiply(_s);
}

/** Game hit zone for a bone hitbox zone. */
export function hitboxGameZone(z: HitboxZone): "head" | "body" | "arm" | "leg" {
  return z === "head" ? "head" : z === "arm" || z === "hand" ? "arm" : z === "leg" || z === "foot" ? "leg" : "body";
}
