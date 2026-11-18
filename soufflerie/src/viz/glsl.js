// Fragments GLSL partagés : palettes de couleurs et échantillonnage des champs.

export const COLORMAPS = /* glsl */ `
// Palette séquentielle perceptuelle (type « viridis »)
vec3 cmViridis(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec3 c0 = vec3(0.2777273272234177, 0.005407344544966578, 0.3340998053353061);
  const vec3 c1 = vec3(0.1050930431085774, 1.404613529898575, 1.384590162594685);
  const vec3 c2 = vec3(-0.3308618287255563, 0.214847559468213, 0.09509516302823659);
  const vec3 c3 = vec3(-4.634230498983486, -5.799100973351585, -19.33244095627987);
  const vec3 c4 = vec3(6.228269936347081, 14.17993336680509, 56.69055260068105);
  const vec3 c5 = vec3(4.776384997670288, -13.74514537774601, -65.35303263337234);
  const vec3 c6 = vec3(-5.435455855934631, 4.645852612178535, 26.3124352495832);
  return c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6)))));
}
// « Turbo » : arc-en-ciel amélioré, habituel en CFD
vec3 cmTurbo(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec4 kr = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
  const vec4 kg = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
  const vec4 kb = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
  const vec2 kr2 = vec2(-152.94239396, 59.28637943);
  const vec2 kg2 = vec2(4.27729857, 2.82956604);
  const vec2 kb2 = vec2(-89.90310912, 27.34824973);
  vec4 v4 = vec4(1.0, t, t * t, t * t * t);
  vec2 v2 = v4.zw * v4.z;
  return vec3(dot(v4, kr) + dot(v2, kr2), dot(v4, kg) + dot(v2, kg2), dot(v4, kb) + dot(v2, kb2));
}
// Divergente bleu ↔ gris ↔ rouge (pression, vorticité)
vec3 cmDiverge(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 cold = vec3(0.12, 0.33, 0.78);
  vec3 coldL = vec3(0.45, 0.66, 0.93);
  vec3 mid = vec3(0.86, 0.86, 0.84);
  vec3 warmL = vec3(0.95, 0.58, 0.46);
  vec3 warm = vec3(0.75, 0.12, 0.15);
  if (t < 0.25) return mix(cold, coldL, t / 0.25);
  if (t < 0.5) return mix(coldL, mid, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(mid, warmL, (t - 0.5) / 0.25);
  return mix(warmL, warm, (t - 0.75) / 0.25);
}
uniform int uCmap;
vec3 cmSeq(float t) { return uCmap == 1 ? cmTurbo(t) : cmViridis(t); }
`;

// Échantillonnage trilinéaire d'un champ 3D stocké en atlas (cellules : centres en i+0.5)
export function atlasSampler(nx, ny, nz, tx) {
  return /* glsl */ `
const int ANX = ${nx};
const int ANY = ${ny};
const int ANZ = ${nz};
const int ATX = ${tx};
ivec2 apix(ivec3 p) {
  p = clamp(p, ivec3(0), ivec3(ANX - 1, ANY - 1, ANZ - 1));
  int ty = p.z / ATX; int tx = p.z - ty * ATX;
  return ivec2(tx * ANX + p.x, ty * ANY + p.y);
}
vec4 afetch(sampler2D t, ivec3 p) { return texelFetch(t, apix(p), 0); }
vec4 asample(sampler2D t, vec3 c) {
  vec3 q = c - 0.5;
  vec3 f0 = floor(q);
  ivec3 i = ivec3(f0);
  vec3 f = q - f0;
  vec4 a = mix(afetch(t, i), afetch(t, i + ivec3(1, 0, 0)), f.x);
  vec4 b = mix(afetch(t, i + ivec3(0, 1, 0)), afetch(t, i + ivec3(1, 1, 0)), f.x);
  vec4 c2 = mix(afetch(t, i + ivec3(0, 0, 1)), afetch(t, i + ivec3(1, 0, 1)), f.x);
  vec4 d = mix(afetch(t, i + ivec3(0, 1, 1)), afetch(t, i + ivec3(1, 1, 1)), f.x);
  return mix(mix(a, b, f.y), mix(c2, d, f.y), f.z);
}
`;
}

// Échantillonnage bilinéaire 2D (textures flottantes sans filtrage matériel)
export const BILINEAR = /* glsl */ `
vec4 bfetch(sampler2D t, ivec2 p, ivec2 n) { return texelFetch(t, clamp(p, ivec2(0), n - 1), 0); }
vec4 bsample(sampler2D t, vec2 c, ivec2 n) {
  vec2 q = c - 0.5;
  vec2 f0 = floor(q);
  ivec2 i = ivec2(f0);
  vec2 f = q - f0;
  return mix(mix(bfetch(t, i, n), bfetch(t, i + ivec2(1, 0), n), f.x),
             mix(bfetch(t, i + ivec2(0, 1), n), bfetch(t, i + ivec2(1, 1), n), f.x), f.y);
}
`;
