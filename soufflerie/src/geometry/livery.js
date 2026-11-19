// Livrée calculée au pixel (frontières nettes), à partir de la position locale
// et de courbes de forme de la voiture échantillonnées dans une petite texture.
import * as THREE from 'three';

export function liveryMaterial({ curves = [], x0 = 0, x1 = 5, palette, glsl, base = {} }) {
  const N = 512;
  const data = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const x = x0 + ((x1 - x0) * i) / (N - 1);
    for (let k = 0; k < 4; k++) data[i * 4 + k] = curves[k] ? curves[k](x) : 0;
  }
  const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat, THREE.FloatType);
  tex.needsUpdate = true;
  const pal = palette.map((c) => new THREE.Color(c));
  while (pal.length < 8) pal.push(new THREE.Color(0xffffff));
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0.45, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08, ...base,
  });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uCurve = { value: tex };
    sh.uniforms.uPal = { value: pal };
    sh.uniforms.uCX = { value: new THREE.Vector2(x0, x1) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLP;\nvarying vec3 vLN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLP = position;\nvLN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vLP;
varying vec3 vLN;
uniform sampler2D uCurve;
uniform vec3 uPal[8];
uniform vec2 uCX;
float gR = -1.0;
float gM = -1.0;
// tissage carbone procédural (sergé 2/2)
float weave(vec3 p, vec3 n) {
  vec3 an = abs(n);
  vec2 uv = an.x > an.y && an.x > an.z ? p.yz : (an.y > an.z ? p.xz : p.xy);
  uv *= 70.0;
  vec2 cell = floor(uv);
  float dir = mod(cell.x + cell.y, 2.0);
  vec2 f = fract(uv);
  float band = dir < 0.5 ? f.x : f.y;
  return mix(0.78, 1.22, (0.5 + 0.5 * sin(band * 3.14159)) * (dir < 0.5 ? 1.0 : 0.82));
}
// trait fin anti-crénelé (lignes d'ouvrants, liserés)
float lineMask(float d, float w) { float fw = fwidth(d) + 1e-5; return 1.0 - smoothstep(w, w + fw, abs(d)); }
vec4 cv(float x) {
  float t = clamp((x - uCX.x) / (uCX.y - uCX.x), 0.0, 1.0) * ${N - 1}.0;
  int i0 = int(floor(t));
  int i1 = min(i0 + 1, ${N - 1});
  return mix(texelFetch(uCurve, ivec2(i0, 0), 0), texelFetch(uCurve, ivec2(i1, 0), 0), fract(t));
}
${glsl}
`)
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb = livery(vLP, normalize(vLN));')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  if (gR >= 0.0) roughnessFactor = gR;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  if (gM >= 0.0) metalnessFactor = gM;');
  };
  mat.customProgramCacheKey = () => 'livery-' + glsl.length + '-' + x0 + '-' + x1;
  return mat;
}
