// 3D preview of the selected item / team character [RECRIADO: the original's UI_Showroom_V12 is not analysed].
// Models come from src/lobby/assetLoader.ts with lod "lod" (256 px textures): one item at a time, released on
// change. Framing/lighting/rotation are this file's choice.
// Characters are skinned: cloned with SkeletonUtils (a plain clone(true) keeps the SkinnedMesh bound to the
// template's bones, which never get a world matrix -> collapsed/twisted body) and posed with the 3PV "idle" clip
// (ui_idle, the PB 2017 inventory/showroom pose baked by pb-extract-tools export-anim.mjs from Chara/*/UI/UI_IdleA.i3a,
// borrowed from the clipsFrom char for skins, falling back to the in-match idle if a char lacks it) until the
// weapon AI's UI_Idle* library loads (startShowroom: Stand loop + random UI_IdleA/B + Change); framed
// as a full 1.8 m body.
import * as THREE from "three";
import { setCompressedTextureSupport } from "../../render/compressedTex";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { loadCharaAsset, loadWeaponAsset, releaseAsset } from "../assetLoader.ts";
import { getSettings, onSettings, pixelRatioFor, type GameSettings } from "../../gameplay/settings.ts";
import { applyPbCharaLighting, createPbMtl, disposePbMtl, loadPbLighting, pbLighting } from "../../render/pbLighting";

/** the panel shows the body ~700 px tall: full textures, unless "Texturas leves" is on */
export const charaLod = (): "lod" | "full" => (getSettings().lowTextures ? "lod" : "full");
import { attachHeadgear, equipKey, type HeadEquip } from "../../game/charEquip.ts";

/** Stage whose lighting.json + env_ref.dds light the lobby body when no match has loaded one [RECRIADO: the original's showroom light is not analysed] */
const LOBBY_LIGHT_MAP = "nstation";

/** Idle clips in preference order (swat_male / swat_female model.glb). */
const IDLE_CLIPS = ["ui_idle", "idle", "pistol_idle", "Low_Stand_Idle"];
/** Standing body box used for framing (the bind pose is a T-pose, its bounds are 1.13 m wide). */
const BODY_H = 1.82;

/**
 * Character family whose own UI clips the original showroom plays (pb-extract-tools export-ui-idle.mjs): each Chara/<Folder> of the
 * clients has its own UI_IdleA/B (REBEL_Female(ViperRed) wears the weapon on her back, SWAT_Female holds it low...).
 * Skins have no packs of their own: they take their base character's [INFERIDO]. null = the swat_male/swat_female library.
 */
function uiFamilyOf(name: string): string | null {
  if (/^rebel_(viperred|female_viperred)/.test(name)) return "rebel_viperred";
  // Reinforced Bella: the client's Bella.I3CHR plays Chara/SWAT_Female clips, but the pose the user wants is the REBEL_Female one (Tarantula) [RECRIADO]
  if (/^rebel_(female|soccer)|^bella/.test(name)) return "rebel_female";
  const m = /^(rebel_male|hide|leopard|d_fox)/.exec(name);
  return m ? m[1] : null;
}

/** Head / face / beret worn by the previewed character (default helmet when it returns nothing): set by the lobby
 * controller from the equipped loadout (PlayerStore.equipPairs), the selected part item overriding its slot. */
let equipOf: ((charaItemId: number) => HeadEquip | undefined) | null = null;
export function setPreviewEquip(fn: ((charaItemId: number) => HeadEquip | undefined) | null): void { equipOf = fn; }

/** A 3D scene drawn around the previewed model (the Cross showroom, screensCross/showroom.ts): `root` joins the preview's
 * scene and `frame` places the camera and the model (holder) every frame, before the render. With a stage the canvas is
 * a background: it keeps drawing without a model and takes no pointer input. */
export interface PreviewStage {
  root: THREE.Object3D;
  frame(dt: number, camera: THREE.PerspectiveCamera, holder: THREE.Object3D): void;
}

const _feet = new THREE.Vector3();
let lightingAsked = false;
/** Match lighting is whatever the last map set; with none loaded (fresh lobby) borrow a real stage's, once. */
async function ensureLobbyLighting(): Promise<void> {
  if (lightingAsked || pbLighting()) return;
  lightingAsked = true;
  await loadPbLighting(`/assets/maps/${LOBBY_LIGHT_MAP}/lighting.json`);
}

export class ItemPreview {
  readonly el: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  private holder = new THREE.Group();
  private mixer: THREE.AnimationMixer | null = null;
  /** showroom idle state machine [INFERIDO: the exe's UI_Idle* sequencing is packed; the clips/durations are real] */
  private room: { stand: THREE.AnimationAction; variants: THREE.AnimationAction[]; cur: THREE.AnimationAction; wait: number } | null = null;
  private clock = new THREE.Clock();
  private spin = true;
  /** pointer x while the player drags the model around (null = not dragging) */
  private dragX: number | null = null;
  private dragY = 0;
  /** loose item: drag turns it on every axis (trackball) instead of only around Y */
  private free = false;
  private current: { itemId: number; chara: boolean; weaponId: number; equip: string } | null = null;
  private raf = 0;
  private token = 0;
  /** PB chara shader state (light-volume colour) shared by the previewed body and its weapon / headgear, like the match */
  private mtl = createPbMtl();
  private unsub: (() => void) | null = null;
  private lastLow = getSettings().lowTextures;
  /** sized in window px by resize() instead of design px */
  private screenPx = false;

  constructor(private w: number, private h: number, private stage: PreviewStage | null = null) {
    this.el = document.createElement("canvas");
    this.el.width = w * 2; // design px -> 2x backing for the scaled stage
    this.el.height = h * 2;
    this.el.style.cssText = `position:absolute;width:${w}px;height:${h}px;pointer-events:auto;cursor:grab;touch-action:none`;
    // hold and drag: turn the character / item a full 360 (the auto spin of loose items pauses meanwhile)
    // window-level move/up: the lobby view re-appends the canvas on every apply(), which drops pointer capture mid-drag
    const move = (e: PointerEvent) => {
      if (this.dragX === null) return;
      const dx = (e.clientX - this.dragX) * 0.012;
      if (this.free) {
        // loose items: trackball, every direction (world-axis turns premultiplied)
        const dy = (e.clientY - this.dragY) * 0.012;
        this.holder.quaternion.premultiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(dy, dx, 0)));
      } else this.holder.rotation.y += dx;
      this.dragX = e.clientX;
      this.dragY = e.clientY;
    };
    const release = () => {
      if (this.dragX === null) return;
      this.dragX = null;
      this.el.style.cursor = "grab";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
    this.el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.dragX = e.clientX;
      this.dragY = e.clientY;
      this.el.style.cursor = "grabbing";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", release);
      window.addEventListener("pointercancel", release);
    });
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 2.0));
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(1.5, 3, 4);
    const rim = new THREE.DirectionalLight(0x9fb4ff, 0.8);
    rim.position.set(-2, 2, -3);
    this.scene.add(key, rim, this.holder);
    if (stage) { this.scene.add(stage.root); this.el.style.pointerEvents = "none"; }
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.el, alpha: true, antialias: true });
      setCompressedTextureSupport(this.renderer);
      this.renderer.setClearColor(0x000000, 0);
      // Gráficos toggles + aniso follow settings by themselves (pbLighting / compressedTex); scale and LOD are this file's
      this.unsub = onSettings((s) => this.applySettings(s));
    } catch { this.renderer = null; this.el.hidden = true; } // no WebGL: the icon under it stays visible
  }

  /** canvas in window px (the Cross showroom behind the whole window): CSS size, aspect and backing follow (w, h) */
  resize(w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    this.screenPx = true;
    this.w = w;
    this.h = h;
    this.el.style.width = `${w}px`;
    this.el.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.applySettings(getSettings());
  }

  /** renderScale: backing = 2x the design size at "100" (the stage is scaled up); the other steps scale it like the match's pixel ratio.
   * A window-px canvas (resize()) takes the match's pixel ratio as is. */
  private applySettings(s: GameSettings): void {
    const r = this.renderer;
    if (!r) return;
    const dpr = window.devicePixelRatio || 1;
    const gl = r.getContext();
    const k = pixelRatioFor(s, dpr) / pixelRatioFor({ renderScale: "100" }, dpr);
    r.setPixelRatio(Math.min(this.screenPx ? pixelRatioFor(s, dpr) : 2 * k,(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number) / Math.max(this.w, this.h)));
    r.setSize(this.w, this.h, false); // false: keep the canvas CSS size
    // "Texturas leves" picks the LOD at load: reload the body with the other one, then drop the old reference
    if (s.lowTextures !== this.lastLow) {
      const c = this.current, old = this.lastLow ? "lod" : "full";
      this.lastLow = s.lowTextures;
      if (c?.chara) {
        this.current = null;
        void this.show(c.itemId, true, c.weaponId).finally(() => releaseAsset("chara", c.itemId, old));
      }
    }
  }

  /** `weaponId` (chara only): the equipped primary, held like the match does (WeaponPointDummyRight). Settles once the
   * model has drawn its first frame (and a character's showroom idle is set up): the heavy part (WebGL upload, shader
   * compile, clip parsing) is over, so a page can wait for it before showing. */
  async show(itemId: number, chara: boolean, weaponId = 0): Promise<void> {
    const eq = chara ? equipOf?.(itemId) : undefined;
    const ek = equipKey(eq);
    if (this.current?.itemId === itemId && this.current.chara === chara && this.current.weaponId === weaponId && this.current.equip === ek) return;
    const prev = this.current;
    this.current = { itemId, chara, weaponId, equip: ek };
    const tk = ++this.token;
    // the previous model stays on screen until the new one is ready (swap below): no blank frame on every reload;
    // its asset is released only then, never while it is still drawn
    let release = prev && (prev.itemId !== itemId || prev.chara !== chara) ? () => releaseAsset(prev.chara ? "chara" : "weapon", prev.itemId, prev.chara ? charaLod() : "lod") : null;
    const dropPrev = () => { release?.(); release = null; };
    const swap = (o: THREE.Object3D) => {
      dropPrev();
      this.holder.clear();
      this.holder.rotation.set(0, 0, 0);
      this.mixer?.stopAllAction();
      this.mixer = null;
      this.room = null;
      this.holder.add(o);
    };
    if (!this.renderer || !itemId) {
      dropPrev(); this.holder.clear(); this.mixer?.stopAllAction(); this.mixer = null;
      this.el.hidden = !this.stage;
      if (this.stage) this.loop();
      return;
    }
    let room: Promise<void> | null = null;
    try {
      if (chara) {
        const a = await loadCharaAsset(itemId, charaLod()); // the panel shows the body ~700 px tall: the 256 px LOD textures look blurry here
        if (tk !== this.token) return;
        const o = SkeletonUtils.clone(a.gltf);
        o.traverse((m) => { if ((m as THREE.Mesh).isMesh) m.frustumCulled = false; }); // skinned bounds = bind pose
        await attachHeadgear(o, a.name, eq); // helmet / mask / beret on HelmetPointDummy (src/game/charEquip.ts)
        if (tk !== this.token) return;
        const hand = o.getObjectByName("WeaponPointDummyRight") ?? o.getObjectByName("R_Hand");
        if (weaponId && hand) {
          // the match's 3PV weapon (grip already in hand space); lazy: keeps src/weapons out of the Node-run lobby graph
          const w = await import("../../weapons/worldModel.ts").then((m) => m.createWeaponModel(weaponId)).catch(() => null);
          if (tk !== this.token) return;
          if (w) hand.add(w.object);
        }
        void ensureLobbyLighting();
        applyPbCharaLighting(o, this.mtl); // the match's chara shader (Phong_D_Dir_ + Gráficos gates), weapon / headgear already attached
        swap(o);
        const clip = IDLE_CLIPS.map((n) => a.clips.find((c) => c.name === n)).find(Boolean);
        if (clip) {
          this.mixer = new THREE.AnimationMixer(o);
          this.mixer.clipAction(clip).play();
          this.mixer.update(0);
        } else console.warn(`[preview3d] chara ${itemId} (${a.name}): no idle clip, bind pose`);
        room = this.startShowroom(o, tk, weaponId, a.skeleton, a.name);
        // centre the posed body (pelvis) on the turn axis: the GLB origin is off the body, so it sat off-centre
        // and swung around when dragged
        o.updateMatrixWorld(true);
        const pelvis = o.getObjectByName("Pelvis") ?? o.getObjectByName("Root");
        if (pelvis && !this.stage) { const p = pelvis.getWorldPosition(new THREE.Vector3()); o.position.x -= p.x; o.position.z -= p.z; }
        // GLB faces +Z, feet at y = 0: camera in front, whole body in the vertical (or horizontal) field
        const fov = THREE.MathUtils.degToRad(this.camera.fov / 2);
        const halfW = 0.42, halfH = BODY_H / 2 + 0.06;
        const dist = Math.max(halfH / Math.tan(fov), halfW / (Math.tan(fov) * this.camera.aspect)) + 0.3;
        // aim a little below the body centre: the body sits high in the panel, clear of the nickname bar under it
        this.camera.position.set(0, BODY_H * 0.48, dist);
        this.camera.lookAt(0, BODY_H * 0.46, 0);
        // the idle pose already turns the body to the left of the screen: turn it back towards the viewer's right
        // [RECRIADO] (the showroom camera of CReadyBg is not ported)
        this.holder.rotation.y = 0.45;
        this.spin = false;
        this.free = false;
      } else {
        // the lobby asset index lacks most weapons: fall back to the match's own 3PV model (weapons/worldModel.ts)
        const lobby = await loadWeaponAsset(itemId).then((a) => a.gltf.clone(true)).catch(() => null);
        const o = lobby ?? await import("../../weapons/worldModel.ts")
          .then((m) => m.createWeaponModel(itemId, undefined, { grenade: true, projectile: true })).then((w) => w?.object ?? null).catch(() => null);
        if (tk !== this.token) return;
        if (!o) throw new Error("no lobby or match model");
        // a weapon lying along Y (barrel up) is laid down: the longest axis goes horizontal, the spin stays around Y
        const pivot = new THREE.Group();
        pivot.add(o);
        const measure = () => { pivot.updateMatrixWorld(true); const b = new THREE.Box3().setFromObject(pivot); return { box: b, size: b.getSize(new THREE.Vector3()) }; };
        const turn = (axis: THREE.Vector3, a: number) => pivot.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, a));
        let { box, size } = measure();
        // side view like the shop: length -> X (screen horizontal), height -> Y, thickness -> Z (towards the camera).
        // The GLBs come with any axis as "up" (some lie with the top facing +Z), so the axes are sorted by extent.
        const ax = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
        const order = [0, 1, 2].sort((a, b) => size.getComponent(b) - size.getComponent(a));
        const rows = [ax[order[0]], ax[order[1]], ax[order[2]].clone()];
        const m = new THREE.Matrix4();
        const setRows = () => m.set(rows[0].x, rows[0].y, rows[0].z, 0, rows[1].x, rows[1].y, rows[1].z, 0, rows[2].x, rows[2].y, rows[2].z, 0, 0, 0, 0, 1);
        if (setRows().determinant() < 0) { rows[2].negate(); setRows(); }
        pivot.quaternion.setFromRotationMatrix(m);
        ({ box, size } = measure());
        // muzzle to the left of the screen (-X) [INFERIDO: muzzle = node named muzzle/FXDummy; without one the model keeps its facing]
        let muzzle: THREE.Object3D | undefined;
        o.traverse((n) => { if (!muzzle && /muzzle|fxdummy/i.test(n.name)) muzzle = n; });
        const mz = muzzle as THREE.Object3D | undefined;
        if (mz && mz.getWorldPosition(new THREE.Vector3()).x > box.getCenter(new THREE.Vector3()).x) { turn(new THREE.Vector3(0, 1, 0), Math.PI); ({ box, size } = measure()); }
        // top up [INFERIDO]: stock / grip / magazine hang below the receiver, so behind the muzzle the geometry reaches
        // farther down than up; if it reaches farther up, the model is upside down: half turn around X (keeps the muzzle left)
        // measured from the median height of the vertices (the body line), not the box centre: the magazine drags the box down
        const ys: number[] = [];
        const p = new THREE.Vector3();
        pivot.traverse((n) => {
          const g = (n as THREE.Mesh).isMesh ? (n as THREE.Mesh).geometry.getAttribute("position") : null;
          if (!g) return;
          for (let i = 0; i < g.count; i++) ys.push(p.fromBufferAttribute(g, i).applyMatrix4(n.matrixWorld).y);
        });
        if (ys.length) {
          ys.sort((a, b) => a - b);
          const med = ys[ys.length >> 1];
          // reaches farther down than up = right way up; the opposite = upside down
          if (ys[ys.length - 1] - med > med - ys[0]) { turn(new THREE.Vector3(1, 0, 0), Math.PI); ({ box, size } = measure()); }
        }
        const c = box.getCenter(new THREE.Vector3());
        pivot.position.sub(c);
        const spinner = new THREE.Group();
        spinner.add(pivot);
        swap(spinner);
        const r = Math.max(size.x, size.y, size.z) || 1;
        this.camera.position.set(0, r * 0.15, r * 1.9);
        this.camera.lookAt(0, 0, 0);
        this.spin = false; // stays still: only the user turns it
        this.free = true;
      }
      this.el.hidden = false;
      this.clock.getDelta();
      this.loop();
      await room; // never throws (startShowroom keeps the baked idle on failure)
    } catch (e) {
      console.warn(`[preview3d] ${chara ? "chara" : "weapon"} ${itemId}: no model, icon only`, e);
      if (tk !== this.token) return;
      dropPrev();
      this.holder.clear();
      this.el.hidden = !this.stage; // model not in the index: icon only
      if (this.stage) this.loop();
    }
  }

  /**
   * The original showroom plays the weapon AI's UI states (I3CHR UI_IdleA / UI_IdleB,
   * pb-extract-tools export-anim3pv.mjs): UI_IdleA loops (the pose the preview always had), every few loops UI_IdleB (long gesture) plays once
   * and it returns to A. UI_Idle_Change (weapon swap) is not used: it looked wrong. The wait is random [INFERIDO]. The baked `ui_idle`
   * already playing stays when the library is missing.
   */
  private async startShowroom(o: THREE.Object3D, tk: number, weaponId: number, skeleton: string, charName: string): Promise<void> {
    try {
      const lib = await import("../../game/charAnimLib.ts");
      const ix = (await lib.loadAnim3pv(skeleton)) ?? (await lib.loadAnim3pv()); // chars without their own library: the male poses
      if (!ix || tk !== this.token) return;
      const ai = lib.aiForWeapon(ix, weaponId || "K-2", "assault");
      const ui = lib.uiIdleFor(ix, ai);
      if (!ui) return;
      const [base, ...gestures] = ui.variants; // base = UI_IdleA (the pose the preview always had), gestures = UI_IdleB
      if (!base) return;
      console.info(`[preview3d] showroom ${skeleton} ai=${ai} base=${base.clip} gestures=${gestures.map((g) => g.clip).join(",")}`);
      const clips = await lib.loadClips(ix, [base.clip, ...gestures.map((v) => v.clip)]);
      // the character family's own clips win over the swat_male / swat_female library
      const family = uiFamilyOf(charName);
      const own = family ? await lib.loadFamilyUiIdle(family, base.clip) : null;
      if (own?.size) for (const v of [base, ...gestures]) { const c = own.get(v.clip.toLowerCase()); if (c) clips.set(v.clip, c); }
      console.info(`[preview3d] showroom family=${family ?? "-"} own=${own?.size ?? 0}`);
      const stand = clips.get(base.clip);
      if (!stand || tk !== this.token) return;
      const mixer = new THREE.AnimationMixer(o);
      const once = (k: string) => {
        const c = clips.get(k);
        return c ? mixer.clipAction(c).setLoop(THREE.LoopOnce, 1) : null;
      };
      const standA = mixer.clipAction(stand).setLoop(THREE.LoopRepeat, Infinity);
      const variants = gestures.map((v) => once(v.clip)).filter((a): a is THREE.AnimationAction => !!a);
      for (const a of variants) a.clampWhenFinished = true;
      this.mixer?.stopAllAction();
      this.mixer = mixer;
      const room = { stand: standA, variants, cur: standA, wait: 0 };
      this.room = room;
      const back = () => {
        room.wait = stand.duration * (1 + Math.floor(Math.random() * 3));
        standA.reset().play();
        if (room.cur !== standA) standA.crossFadeFrom(room.cur, 0.3, false);
        room.cur = standA;
      };
      mixer.addEventListener("finished", (e) => {
        if ((e as unknown as { action: THREE.AnimationAction }).action === room.cur && room.cur !== standA) back();
      });
      back();
      mixer.update(0);
    } catch (e) {
      console.warn("[preview3d] showroom idle library unavailable, baked ui_idle stays", e);
    }
  }

  private loop = () => {
    cancelAnimationFrame(this.raf);
    if (!this.renderer || this.el.hidden || !this.el.isConnected) return;
    const dt = Math.min(0.1, this.clock.getDelta());
    this.mixer?.update(dt);
    if (this.current?.chara) this.mtl.update(_feet, dt); // light-volume colour (stage DefaultDiffuse in the lobby)
    const r = this.room;
    if (r && r.cur === r.stand && r.variants.length && (r.wait -= dt) <= 0) {
      const v = r.variants[Math.floor(Math.random() * r.variants.length)];
      v.reset().play();
      v.crossFadeFrom(r.stand, 0.3, false);
      r.cur = v;
    }
    if (this.spin && this.dragX === null) {
      if (this.free) this.holder.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.01));
      else this.holder.rotation.y += 0.01;
    }
    this.stage?.frame(dt, this.camera, this.holder);
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.loop);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.room = null;
    if (this.current) releaseAsset(this.current.chara ? "chara" : "weapon", this.current.itemId, this.current.chara ? charaLod() : "lod");
    this.current = null;
    this.unsub?.();
    this.unsub = null;
    disposePbMtl(this.mtl);
    this.renderer?.dispose();
    this.renderer?.forceContextLoss(); // dispose() alone keeps the GL context alive (Chrome caps ~16)
    this.renderer = null;
    this.el.remove();
  }
}
