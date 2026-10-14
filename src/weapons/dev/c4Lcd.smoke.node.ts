// node --experimental-transform-types src/weapons/dev/c4Lcd.smoke.node.ts  (or npx --no-install tsx)
import * as THREE from "three";
import { setC4Lcd } from "../c4Lcd.ts";

const tex = new THREE.Texture();
const mat = new THREE.ShaderMaterial({ uniforms: { map: { value: tex } }, transparent: true });
mat.name = "c4_01_lcd";
const g = new THREE.BufferGeometry();
g.setAttribute("uv", new THREE.Float32BufferAttribute([1, -1, 0, -1, 0, -0.8454, 0, -0.8454, 1, -0.8454, 1, -1], 2));
const mesh = new THREE.Mesh(g, mat);
mesh.name = "C4_Lcd_Material";
const root = new THREE.Group(); root.add(mesh);

setC4Lcd(root, 1);
const m = mesh.material as THREE.ShaderMaterial;
console.assert(m !== mat && m.transparent === true, "LCD material must keep transparent (viewmodel pass)");
console.assert((m.uniforms.map.value as THREE.Texture) === tex, "LCD material must sample the chara map");
setC4Lcd(root, 6);
const uv = mesh.geometry.getAttribute("uv");
const v0 = (5 * 20 + 0.5) / 128;
console.assert(Math.abs(uv.getY(0) - v0) < 1e-6 && Math.abs(uv.getY(2) - (v0 + 20 / 128)) < 1e-6, "step 6 row");
console.log(process.exitCode ? "FAIL" : "c4Lcd smoke ok");
