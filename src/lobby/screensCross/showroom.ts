// The Point Blank Cross showroom (CReadyBg): the 3D room behind every classic screen of the ready stage (server / channel
// list, lobby, room, inventory, shop, profile), with the player's character standing in it. Assets from
// pb-extract-tools export-cross-showroom.mjs (UI_Showroom.i3Pack); "Personagem 3D das telas clássicas".
// The room is a PreviewStage of the lobby's ItemPreview (screens/preview3d.ts): one WebGL canvas draws room + character.
//
// - CStageReady::OnCreate creates it (0x511fb4) for the whole stage: no phase hides it, the server list has no 2D
//   background of its own (UI_Project_ServerList only has its windows).
// - Camera: the seven Camera_*.I3S animations, FOV forced to 0.6021386 rad by _InitCamera (0x509e72), the screen aspect,
//   near / far of the i3Camera. CStageReady::OnUpdate calls MoveCamera(look) every frame (0x511809) with the look the
//   step asked for (+0x376c); MoveCamera (0x509010) starts the next move only once the current animation is over.
// - Character: at (0.453, 0, 0) (_CreateViewChara 0x508e10), turned every frame to the camera + 0.65 rad
//   (CReadyBg::OnUpdate 0x5084d9).
// - Light: Stage.pef [Stage/Lobby] (_InitLight 0x509370) as the PB lighting of the character shader (lighting.json).
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { jsonOnce } from "../../jsonOnce.ts";
import { loadPbLighting, pbLighting, pbWorldMaterial } from "../../render/pbLighting.ts";
import type { PreviewStage } from "../screens/preview3d.ts";

const BASE = "/assets/ui/cross/showroom";

/** CReadyBg CameraLook: 0 Idle, 1 Left, 2 Right */
export type CameraLook = 0 | 1 | 2;

/** _InitCamera SetFOV(0.6021386) (float 0xb34d24) on every camera; vertical like D3DXMatrixPerspectiveFov [INFERIDO] */
export const FOV = 0.6021386;
/**
 * Vertical FOV (degrees) of the full-window canvas: FOV at every window aspect, the horizontal one follows the aspect, as
 * the exe's camera over the whole viewer. The UI is stretched over the same window (Stage stretch, i3GuiRoot::SetViewer
 * (viewer, 1)), so on a wide window the character keeps its height in the UI and sits closer to the centre in design px:
 * where the camera projects it, not pinned to a 4:3 box (smoke: 1920x1080). Vertical FOV = [INFERIDO] (as FOV).
 */
export const FOV_DEG = THREE.MathUtils.radToDeg(FOV);
/** _CreateViewChara SetPos (0xb34d00) */
export const CHARA_POS = new THREE.Vector3(0.453, 0, 0);
/** OnUpdate: yaw = atan2(cam - chara) + 0.65 (double 0xb34cf8); i3 theta = three rotation.y [INFERIDO] */
export const CHARA_YAW_OFFSET = 0.65;
/** animation index -> look it ends at (Camera_Idle, IdleToLeft, IdleToRight, LeftToIdle, LeftToRight, RightToIdle, RightToLeft) */
export const ENDS_AT: CameraLook[] = [0, 1, 2, 0, 2, 0, 1];
/** MoveCamera jump table 0x5092bc: [look the current animation ends at][wanted look] -> next animation (-1 = stay) */
export const MOVE = [[-1, 1, 2], [3, -1, 4], [5, 6, -1]];

interface CamKey { t: number; pos: THREE.Vector3; quat: THREE.Quaternion }
interface CamAnim { duration: number; near: number; far: number; keys: CamKey[] }
interface CamerasJson { cameras: { name: string; duration: number; near: number; far: number; keys: { t: number; m: number[] }[] }[] }

export class CrossShowroom implements PreviewStage {
  readonly root = new THREE.Group();
  private cams: CamAnim[] = [];
  private anim = 0;
  private time = 0;
  private look: CameraLook = 0;
  private lightAsked = false;

  constructor() {
    void this.load().catch((e) => console.warn("[cross] showroom", e));
  }

  private async load(): Promise<void> {
    const [j, gltf] = await Promise.all([
      jsonOnce<CamerasJson>(`${BASE}/cameras.json`),
      new GLTFLoader().loadAsync(`${BASE}/showroom.glb`),
    ]);
    const m = new THREE.Matrix4(), s = new THREE.Vector3();
    this.cams = j.cameras.map((c) => ({
      duration: c.duration, near: c.near, far: c.far,
      keys: c.keys.map((k) => { const pos = new THREE.Vector3(), quat = new THREE.Quaternion(); m.fromArray(k.m).decompose(pos, quat, s); return { t: k.t, pos, quat }; }),
    }));
    // lightmapped meshes: the map's world shader (Phong_DLX_Dir_); the backdrop plane has lighting off in the scene: texture only
    const done = new Map<THREE.Material, THREE.Material>();
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.material as THREE.MeshStandardMaterial;
      let dst = done.get(src);
      if (!dst) {
        dst = src.userData?.lightMap && src.aoMap
          ? pbWorldMaterial(src)
          : new THREE.MeshBasicMaterial({ map: src.map, alphaTest: src.alphaTest, transparent: src.transparent });
        done.set(src, dst);
      }
      mesh.material = dst;
    });
    this.root.add(gltf.scene);
  }

  /** the look the current step wants (CStageReady +0x376c) */
  setLook(look: CameraLook): void {
    this.look = look;
  }

  frame(dt: number, camera: THREE.PerspectiveCamera, holder: THREE.Object3D): void {
    // the match leaves its map's lighting behind: put the showroom's back
    if (pbLighting()?.map !== "showroom" && !this.lightAsked) {
      this.lightAsked = true;
      void loadPbLighting(`${BASE}/lighting.json`).finally(() => { this.lightAsked = false; });
    }
    const cams = this.cams;
    if (!cams.length) return;
    this.time += dt;
    // MoveCamera: a new move only when the current one has played through (playTime > duration, 0x50911f)
    const next = MOVE[ENDS_AT[this.anim]][this.look];
    if (next >= 0 && this.time > cams[this.anim].duration) { this.anim = next; this.time = 0; }
    const c = cams[this.anim], keys = c.keys;
    // SetPlayMode(2) (0x509e08): the move holds its last key; keys interpolated linearly [INFERIDO]
    const t = Math.min(this.time, keys[keys.length - 1].t);
    let i = 0;
    while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
    const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
    const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    camera.position.lerpVectors(a.pos, b.pos, f);
    camera.quaternion.slerpQuaternions(a.quat, b.quat, f);
    const fov = FOV_DEG;
    if (camera.fov !== fov || camera.near !== c.near || camera.far !== c.far) {
      camera.fov = fov;
      camera.near = c.near;
      camera.far = c.far;
      camera.updateProjectionMatrix();
    }
    holder.position.copy(CHARA_POS);
    holder.rotation.set(0, Math.atan2(camera.position.x - CHARA_POS.x, camera.position.z - CHARA_POS.z) + CHARA_YAW_OFFSET, 0);
  }
}
