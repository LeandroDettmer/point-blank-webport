// The C4's LCD: WeaponC4::_SetBombTimerTextureCoord 0x6377f0 rewrites the 6 UVs of the timer geometry ("C4_Lcd_Material" in c4.glb) to one of the
// 6 rows of c4_01_lcd (64x128 texture, rows 20 px tall: v = ((step - 1) * 20 + 0.5) / 128 .. + 20 / 128), step 1..6 (BOMB_TIMER_STEP).
// Row 1 = the display off ("88888" dim), the next rows light up with the install progress (the step comes from the install timer,
// 0x6379a0, thresholds not decoded: [INFERIDO] 6 equal slices of the hold); a planted C4 stays on the last row.
import * as THREE from "three";

const ROW = 20, TEX_H = 128;

// The display is self-lit: under the PB chara shader (Phong_D_Dir, viewmodel / 3rd person) the red digits were multiplied by the
// light and read as switched off, so the LCD mesh gets an unlit material on its first use [INFERIDO: the i3 material flags are not decoded].
const LCD_VS = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const LCD_FS = `uniform sampler2D map; varying vec2 vUv; void main() { vec4 t = texture2D(map, vUv); gl_FragColor = vec4(t.rgb, 1.0); }`;

function unlit(src: THREE.Material): THREE.Material {
  const sh = src as THREE.ShaderMaterial;
  if (sh.isShaderMaterial && sh.uniforms?.map?.value) {
    // raw texel out, like the DX9 fixed function LCD: the chara material already holds the raw (non-sRGB) texture
    // keep the source's queue/depth state: the viewmodel pass marks its materials transparent (depth clear runs in the transparent
    // queue), an opaque LCD would draw before that clear and the C4 body would paint over it
    return new THREE.ShaderMaterial({
      uniforms: { map: { value: sh.uniforms.map.value } }, vertexShader: LCD_VS, fragmentShader: LCD_FS,
      transparent: sh.transparent, depthWrite: sh.depthWrite, depthTest: sh.depthTest, side: sh.side, toneMapped: false,
    });
  }
  const s = src as THREE.MeshStandardMaterial;
  return new THREE.MeshBasicMaterial({ map: s.map ?? null, toneMapped: false, transparent: s.transparent, side: s.side });
}

/** show row `step` (1..6) of the LCD on every "C4_Lcd_Material" mesh under `root` (its geometry is cloned once: the GLB is shared) */
export function setC4Lcd(root: THREE.Object3D, step: number): void {
  const s = Math.max(1, Math.min(6, Math.round(step)));
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !/lcd/i.test(o.name + (Array.isArray(m.material) ? "" : (m.material as THREE.Material).name))) return;
    if (!m.userData.lcdCloned) {
      m.geometry = m.geometry.clone();
      // which vertices are the quad's top ones, taken before the first rewrite (afterwards v is a row coordinate, not -1 / -0.8454)
      const u0 = m.geometry.getAttribute("uv") as THREE.BufferAttribute | undefined;
      if (u0) m.userData.lcdTop = Array.from({ length: u0.count }, (_, i) => u0.getY(i) < -0.92);
      m.material = Array.isArray(m.material) ? m.material.map(unlit) : unlit(m.material);
      m.userData.lcdCloned = true;
    }
    const uv = m.geometry.getAttribute("uv") as THREE.BufferAttribute;
    if (!uv) return;
    const v0 = ((s - 1) * ROW + 0.5) / TEX_H, v1 = v0 + ROW / TEX_H;
    // the exported quad: the two top vertices sit at v = -1, the bottom ones at v = -0.8454 (i3 v flipped): keep that pairing
    const top = m.userData.lcdTop as boolean[];
    for (let i = 0; i < uv.count; i++) uv.setY(i, top[i] ? v0 : v1);
    uv.needsUpdate = true;
  });
}
