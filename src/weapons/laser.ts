import * as THREE from "three";
import { fxTexture, type WeaponEffects } from "./effects";
import { laserDotWhileScoped, weaponFx, weaponFxInfo } from "./sights";

/**
 * Laser sight of the WeaponDotLaser class (pef ClassMeta; CDotLazer at weapon +0xa540, 2017 exe):
 *  - beam  (CDotLazer::CreateLazerSight 0x9f1cc0): two crossed quads under FXLaserSightDummy, 0.5 long along the
 *          dummy's +Y (0x9f1fe7), half width 0.004 (0x9f1a34), Effect/Tex_LaserBeam01.i3i, blend SRCALPHA/ONE,
 *          alpha test ref 50. Seen by everyone (other players: always on their current weapon, 0x64c778).
 *  - dot   (CDotLazer::CreateLazerDot 0x9f1af0): effect Env_TargetLaser_01, own client only. WeaponDotLaser 0x64c1f6
 *          places it on the weapon's target point (vf+0x18c -> 0x623180 -> 0x9f1c90), the point the shot aims at: the
 *          aim bone, so it carries the full vertical recoil R.v while the camera only shows R.v * CamSyncRate (the dot
 *          climbs on the screen during a spray and settles back with the recoil). Ray over the weapon range (1000
 *          while firing, 0x9f26c0), nearest hit, pulled back to 1 unit from the ray origin when the hit is farther
 *          (0x9f2a14..0x9f2aa2), no hit = no dot. The effect is a 0.01 red Glow_alpha quad with z-test off, so it reads
 *          as a fixed-size red point over whatever the ray hits. The web used the hidden viewmodel muzzle while firing,
 *          whose Attack clip made the dot jump under the scope overlay; the caller now passes the aim ray.
 *  - when  (WeaponDotLaser::OnUpdate 0x64c4f0): own player: laser option ON (g_d80ba8+0x804; key B, key-map slot 40
 *          0x4cd7e9, STBL_IDX_DOTLAZER_ACTIVATE/DEACTIVATE) OR scoped; a weapon outside the toggle list 0x618590 is
 *          forced on (0x64c68f). Cross (WeaponDotLaser::OnUpdate 0x6457e0): while zoomed (weapon flag 0x10000) the dot hides
 *          only for ScopeType 0 (0x64582a; sights.ts laserDotWhileScoped), overlay or not; any other enum keeps it.
 *  - crosshair: CGameCharaHUDControl::OnApplyCrosshair 0xa6585f turns the screen crosshair off for a laser weapon while
 *          the laser is on (option, zoom, or forced), so the red dot is the only reticle (LaserSight.active).
 * Starts ON: forced-on laser weapons ignore the option, and the web keeps B as a toggle for every laser weapon.
 */
export type LaserRay = (origin: THREE.Vector3, dir: THREE.Vector3, max: number) => THREE.Vector3 | null;

const BEAM_LEN = 0.5;
const BEAM_HALF = 0.004;

/** crossed-quad beam in the dummy's space (+Y forward) */
export function createLaserBeam(): THREE.Mesh {
  const tex = weaponFx()?.globals.tex.Tex_LaserBeam01;
  const L = BEAM_LEN, w = BEAM_HALF;
  // quad 1 in the XY plane, quad 2 in the ZY plane; u runs along the beam (0.0078125 -> 1, 0x9f23e1)
  const pos = [-w, 0, 0, w, 0, 0, w, L, 0, -w, L, 0, 0, 0, -w, 0, 0, w, 0, L, w, 0, L, -w];
  const u0 = 0.0078125;
  const uv = [u0, 0, u0, 1, 1, 1, 1, 0, u0, 0, u0, 1, 1, 1, 1, 0];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  const m = new THREE.MeshBasicMaterial({
    color: tex ? 0xffffff : 0xff2020, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    side: THREE.DoubleSide, forceSinglePass: true, alphaTest: 50 / 255,
  });
  if (tex) m.map = fxTexture(tex);
  const mesh = new THREE.Mesh(g, m);
  mesh.name = "LaserBeam";
  mesh.frustumCulled = false;
  mesh.renderOrder = 7;
  return mesh;
}

export class LaserSight {
  /** the global laser option (key B) */
  enabled = true;
  /** laser shown this frame (beam / dot): the screen crosshair hides while true (OnApplyCrosshair 0xa6585f) */
  active = false;
  private weaponId = 0;
  private beam: THREE.Mesh | null = null;
  private dot: THREE.Group | null = null;
  private offKey: (() => void) | null = null;
  /** the beam mesh factory (tests / headless inject a material with their own texture) */
  beamFactory: () => THREE.Mesh = createLaserBeam;

  constructor(private effects: WeaponEffects, private ray: LaserRay) {}

  /** listen for the laser key (default B) on the document */
  bindKey(code = "KeyB", target: Document | undefined = typeof document !== "undefined" ? document : undefined): void {
    if (!target) return;
    const f = (e: KeyboardEvent) => { if (e.code === code && !e.repeat && this.has) this.enabled = !this.enabled; };
    target.addEventListener("keydown", f);
    this.offKey = () => target.removeEventListener("keydown", f);
  }

  get has(): boolean {
    const info = weaponFxInfo(this.weaponId);
    return !!(info?.laser || info?.laserDummy);
  }

  /** weapon in hand + its FXLaserSightDummy (null when the model lacks it: dot only) */
  setWeapon(id: number, dummy: THREE.Object3D | null): void {
    if (id !== this.weaponId || this.beam?.parent !== dummy) {
      this.beam?.removeFromParent();
      this.beam = null;
      this.weaponId = id;
      if (this.has && dummy) {
        this.beam = this.beamFactory();
        dummy.add(this.beam);
      }
    }
  }

  /**
   * @param camera   ray origin / direction (virtual camera)
   * @param scoped   scope or zoom extension active
   * @param range    weapon range (m)
   * @param firing   ray length 1000 while firing (0x9f26c0)
   * @param aim      the shot's aim ray (eye + camera forward with the aim-bone recoil); camera forward when omitted
   */
  update(camera: THREE.Camera, scoped: boolean, range: number, firing = false, aim?: { origin: THREE.Vector3; dir: THREE.Vector3 } | null): void {
    const has = this.has;
    const on = has && (this.enabled || scoped);
    this.active = on;
    if (this.beam) this.beam.visible = on;
    const dotOn = on && (!scoped || laserDotWhileScoped(this.weaponId));
    if (!dotOn) {
      if (this.dot) this.dot.visible = false;
      return;
    }
    const o = new THREE.Vector3(), d = new THREE.Vector3();
    const max = firing ? 1000 : range;
    if (aim) {
      o.copy(aim.origin);
      d.copy(aim.dir).normalize();
    } else {
      camera.getWorldPosition(o);
      camera.getWorldDirection(d);
    }
    const hit = this.ray(o, d, max);
    if (!hit) {
      if (this.dot) this.dot.visible = false;
      return;
    }
    const t = hit.distanceTo(o);
    const p = t > 1 ? o.clone().addScaledVector(d, 1) : hit;
    if (!this.dot || !this.dot.parent) this.dot = this.effects.play("Env_TargetLaser_01", p);
    if (this.dot) {
      this.dot.visible = true;
      this.dot.position.copy(p);
    }
  }

  dispose(): void {
    this.offKey?.();
    this.beam?.removeFromParent();
    this.dot?.removeFromParent();
  }
}
