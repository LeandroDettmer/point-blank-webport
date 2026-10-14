import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";

export interface LevelBuildResult {
  visualGroup: THREE.Group;
  colliderMeshes: THREE.Mesh[]; // for debug wireframe toggle
  spawn: THREE.Vector3;
}

// Procedural fallback level: floor + boxes + ramp. Used when real GLBs are absent.
export function buildTestLevel(
  world: RAPIER.World,
  RAPIER_MOD: typeof RAPIER
): LevelBuildResult {
  const visualGroup = new THREE.Group();
  const colliderMeshes: THREE.Mesh[] = [];

  const floorMat = new THREE.MeshStandardMaterial({ color: 0x555566 });
  const boxMat = new THREE.MeshStandardMaterial({ color: 0x8899aa });
  const rampMat = new THREE.MeshStandardMaterial({ color: 0x668877 });

  const addStaticBox = (
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    mat: THREE.Material,
    rotY = 0
  ) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotY;
    visualGroup.add(mesh);
    colliderMeshes.push(mesh);

    const bodyDesc = RAPIER_MOD.RigidBodyDesc.fixed()
      .setTranslation(x, y, z)
      .setRotation({
        x: 0,
        y: Math.sin(rotY / 2),
        z: 0,
        w: Math.cos(rotY / 2),
      });
    const body = world.createRigidBody(bodyDesc);
    const colDesc = RAPIER_MOD.ColliderDesc.cuboid(w / 2, h / 2, d / 2);
    world.createCollider(colDesc, body);
    return mesh;
  };

  // Floor
  addStaticBox(60, 1, 60, 0, -0.5, 0, floorMat);

  // Some crates
  addStaticBox(2, 2, 2, 5, 1, 5, boxMat);
  addStaticBox(2, 2, 2, 5, 1, 8, boxMat);
  addStaticBox(2, 4, 2, -6, 2, 3, boxMat);
  addStaticBox(1, 1, 1, -3, 0.5, -4, boxMat);

  // Ramp (rotated box acting as a slope)
  const rampMesh = new THREE.Mesh(new THREE.BoxGeometry(4, 0.3, 8), rampMat);
  rampMesh.position.set(10, 1.2, -5);
  rampMesh.rotation.x = -Math.PI / 8;
  visualGroup.add(rampMesh);
  colliderMeshes.push(rampMesh);
  {
    const bodyDesc = RAPIER_MOD.RigidBodyDesc.fixed()
      .setTranslation(10, 1.2, -5)
      .setRotation({
        x: Math.sin(-Math.PI / 16),
        y: 0,
        z: 0,
        w: Math.cos(-Math.PI / 16),
      });
    const body = world.createRigidBody(bodyDesc);
    const colDesc = RAPIER_MOD.ColliderDesc.cuboid(2, 0.15, 4);
    world.createCollider(colDesc, body);
  }

  // Simple sky-ish light handled by main scene; add a small step block to test stairs
  addStaticBox(1.5, 0.2, 1.5, -1, 0.1, 1, boxMat);
  addStaticBox(1.5, 0.4, 1.5, -1, 0.3, 2.2, boxMat);
  addStaticBox(1.5, 0.6, 1.5, -1, 0.5, 3.4, boxMat);

  const light = new THREE.HemisphereLight(0xffffff, 0x223344, 1.0);
  visualGroup.add(light);
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(10, 20, 10);
  visualGroup.add(sun);

  return {
    visualGroup,
    colliderMeshes,
    spawn: new THREE.Vector3(0, 2, 0),
  };
}
