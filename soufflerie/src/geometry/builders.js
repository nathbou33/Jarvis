// Briques de modélisation procédurale : toutes produisent des maillages FERMÉS
// (étanches), indispensables pour la voxelisation par comptage de parité.
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Interpolation cubique monotone (PCHIP) d'une table [[x, y], ...]
export function curve(pts) {
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  if (n === 1) return () => ys[0];
  const h = [], d = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    d.push((ys[i + 1] - ys[i]) / h[i]);
  }
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

export const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const smax = (a, b, k) => {
  if (!isFinite(a)) return b;
  if (!isFinite(b)) return a;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + (h * h * k) / 4;
};
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Dôme superelliptique : hauteur en z d'une bosse centrée en zc.
export function dome(z, zc, hw, base, top, n = 2.5) {
  const t = Math.abs(z - zc) / hw;
  if (t >= 1) return -Infinity;
  return base + (top - base) * Math.pow(1 - Math.pow(t, n), 1 / n);
}

// ---------------------------------------------------------------------------
// Corps « lofté » : sections transversales (plan y-z) le long de x.
// section(x) → { W, top(z), bot(z), rt, rb }  (demi-largeur, surfaces haute/basse, rayons de coin)
export function loftGeometry(section, xs, { nTop = 36, nSide = 6, colorFn = null } = {}) {
  const loops = [];
  for (const x of xs) loops.push(sectionLoop(section(x), x, nTop, nSide));
  const M = loops[0].length;
  const pos = [];
  const idx = [];
  for (const loop of loops) for (const p of loop) pos.push(p[0], p[1], p[2]);
  for (let s = 0; s < loops.length - 1; s++) {
    for (let k = 0; k < M; k++) {
      const a = s * M + k, b = s * M + ((k + 1) % M), c = (s + 1) * M + k, d = (s + 1) * M + ((k + 1) % M);
      idx.push(a, c, b, b, c, d);
    }
  }
  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  body.setIndex(idx);
  body.computeVertexNormals();
  // bouchons
  const caps = [];
  for (const [li, flip] of [[0, false], [loops.length - 1, true]]) {
    const loop = loops[li];
    const c = [0, 0, 0];
    for (const p of loop) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    c[0] /= M; c[1] /= M; c[2] /= M;
    const cp = [], ci = [];
    cp.push(...c);
    for (const p of loop) cp.push(p[0], p[1], p[2]);
    for (let k = 0; k < M; k++) {
      const a = 1 + k, b = 1 + ((k + 1) % M);
      if (flip) ci.push(0, b, a); else ci.push(0, a, b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
    g.setIndex(ci);
    g.computeVertexNormals();
    caps.push(g);
  }
  const merged = mergeGeoms([body, ...caps]);
  if (colorFn) applyColors(merged, colorFn);
  return merged;
}

function sectionLoop(s, x, nTop, nSide) {
  const W = Math.max(s.W, 1e-3);
  const topE = s.top(W), botE = s.bot(W);
  const topW = s.top(-W), botW = s.bot(-W);
  const hgt = Math.max(Math.min(topE - botE, topW - botW), 2e-3);
  let rt = Math.min(s.rt ?? 0.05, W * 0.95, hgt * 0.48);
  let rb = Math.min(s.rb ?? 0.03, W * 0.95, hgt * 0.48);
  rt = Math.max(rt, 1e-4);
  rb = Math.max(rb, 1e-4);
  const topR = (z) => {
    const d = Math.abs(z) - (W - rt);
    let y = s.top(z);
    if (d > 0) y = y - rt + Math.sqrt(Math.max(rt * rt - d * d, 0));
    return y;
  };
  const botR = (z) => {
    const d = Math.abs(z) - (W - rb);
    let y = s.bot(z);
    if (d > 0) y = y + rb - Math.sqrt(Math.max(rb * rb - d * d, 0));
    return y;
  };
  const pts = [];
  // dessus : z de +W à -W
  for (let k = 0; k <= nTop; k++) {
    const z = W * Math.cos((Math.PI * k) / nTop);
    pts.push([x, topR(z), z]);
  }
  const bulge = s.bulge ?? 0;
  const bz = (t) => W + bulge * 4 * t * (1 - t);
  // flanc gauche (z = -W) : du haut vers le bas, légèrement galbé
  {
    const y0 = topR(-W), y1 = botR(-W);
    for (let k = 1; k < nSide; k++) pts.push([x, y0 + ((y1 - y0) * k) / nSide, -bz(k / nSide)]);
  }
  // dessous : z de -W à +W
  for (let k = 0; k <= nTop; k++) {
    const z = -W * Math.cos((Math.PI * k) / nTop);
    pts.push([x, botR(z), z]);
  }
  // flanc droit : du bas vers le haut
  {
    const y0 = botR(W), y1 = topR(W);
    for (let k = 1; k < nSide; k++) pts.push([x, y0 + ((y1 - y0) * k) / nSide, bz(k / nSide)]);
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Corps à sections superelliptiques (nez, châssis, pontons, capots…).
// section(x) → { zc, cy, hw, hu, hl, nu, nl } : centre latéral et vertical, demi-largeur,
// demi-hauteurs haute/basse, exposants (2 = ellipse, 4+ = section carrée arrondie).
const spow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);
export function superLoft(section, xs, { n = 56 } = {}) {
  const loops = xs.map((x) => {
    const s = section(x);
    const pts = [];
    for (let k = 0; k < n; k++) {
      const th = (2 * Math.PI * k) / n;
      const c = Math.cos(th), si = Math.sin(th);
      const up = si >= 0;
      const e = 2 / (up ? s.nu ?? 2.5 : s.nl ?? 2.5);
      const z = (s.zc ?? 0) + Math.max(s.hw, 1e-4) * spow(c, e);
      const y = s.cy + (up ? Math.max(s.hu, 1e-4) : Math.max(s.hl, 1e-4)) * spow(si, e);
      pts.push([x, y, z]);
    }
    return pts;
  });
  return loopsToGeometry(loops);
}

export function loopsToGeometry(loops) {
  const M = loops[0].length;
  const pos = [];
  const idx = [];
  for (const loop of loops) for (const p of loop) pos.push(p[0], p[1], p[2]);
  for (let s = 0; s < loops.length - 1; s++) {
    for (let k = 0; k < M; k++) {
      const a = s * M + k, b = s * M + ((k + 1) % M), c = (s + 1) * M + k, d = (s + 1) * M + ((k + 1) % M);
      idx.push(a, c, b, b, c, d);
    }
  }
  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  body.setIndex(idx);
  body.computeVertexNormals();
  const caps = [];
  for (const [li, flip] of [[0, false], [loops.length - 1, true]]) {
    const loop = loops[li];
    const c = [0, 0, 0];
    for (const p of loop) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    c[0] /= M; c[1] /= M; c[2] /= M;
    const cp = [...c];
    for (const p of loop) cp.push(p[0], p[1], p[2]);
    const ci = [];
    for (let k = 0; k < M; k++) {
      const a = 1 + k, b = 1 + ((k + 1) % M);
      if (flip) ci.push(0, b, a); else ci.push(0, a, b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
    g.setIndex(ci);
    g.computeVertexNormals();
    caps.push(g);
  }
  return mergeGeoms([body, ...caps]);
}

// Bras de suspension profilé (lame elliptique) entre deux points, corde orientée selon x.
export function blade(a, b, chord, thick, seg = 10) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const len = A.distanceTo(B);
  const g = new THREE.CylinderGeometry(1, 1, len, seg, 1, false);
  g.scale(chord / 2, 1, thick / 2);
  const dir = B.clone().sub(A).normalize();
  // repère : axe du bras = dir, corde au plus près de x
  const xAxis = new THREE.Vector3(1, 0, 0);
  let side = xAxis.clone().sub(dir.clone().multiplyScalar(xAxis.dot(dir)));
  if (side.lengthSq() < 1e-6) side = new THREE.Vector3(0, 1, 0);
  side.normalize();
  const third = new THREE.Vector3().crossVectors(side, dir);
  const m = new THREE.Matrix4().makeBasis(side, dir, third);
  g.applyMatrix4(m);
  const mid = A.clone().add(B).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return g;
}

// Matériau composite : tissage carbone procédural (sergé 2/2) modulant la couleur.
export function carbonMaterial({ color = 0x1a1c20, vertexColors = false, scale = 70, clearcoat = 0.9 } = {}) {
  const mat = new THREE.MeshPhysicalMaterial({ color, vertexColors, metalness: 0.25, roughness: 0.42, clearcoat, clearcoatRoughness: 0.12 });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCP;\nvarying vec3 vCN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCP = position;\nvCN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vCP;
varying vec3 vCN;
float weave(vec3 p, vec3 n) {
  vec3 an = abs(n);
  vec2 uv = an.x > an.y && an.x > an.z ? p.yz : (an.y > an.z ? p.xz : p.xy);
  uv *= ${scale.toFixed(1)};
  vec2 cell = floor(uv);
  float dir = mod(cell.x + cell.y, 2.0);
  vec2 f = fract(uv);
  float band = dir < 0.5 ? f.x : f.y;
  float sheen = 0.5 + 0.5 * sin(band * 3.14159);
  return mix(0.78, 1.22, sheen * (dir < 0.5 ? 1.0 : 0.82));
}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= weave(vCP, normalize(vCN));');
  };
  mat.customProgramCacheKey = () => `carbon-${scale}-${vertexColors}`;
  return mat;
}

// Répartition non uniforme de stations (plus dense aux extrémités)
export function stations(x0, x1, n, extra = []) {
  const xs = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 0.5 - 0.5 * Math.cos(Math.PI * t);
    xs.push(x0 + (x1 - x0) * (0.35 * t + 0.65 * u));
  }
  for (const e of extra) if (e > x0 && e < x1) xs.push(e);
  xs.sort((a, b) => a - b);
  return xs.filter((v, i) => i === 0 || v - xs[i - 1] > 1e-4);
}

// ---------------------------------------------------------------------------
// Profil NACA 4 chiffres (bord de fuite fermé). Renvoie {upper:[[x,y]], lower:[[x,y]]} pour corde 1.
export function naca4(m, p, t, n = 28) {
  const upper = [], lower = [];
  for (let i = 0; i <= n; i++) {
    const beta = (Math.PI * i) / n;
    const x = 0.5 * (1 - Math.cos(beta));
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    let yc = 0, dyc = 0;
    if (m > 0) {
      if (x < p) { yc = (m / (p * p)) * (2 * p * x - x * x); dyc = ((2 * m) / (p * p)) * (p - x); }
      else { yc = (m / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * x - x * x); dyc = ((2 * m) / ((1 - p) ** 2)) * (p - x); }
    }
    const th = Math.atan(dyc);
    upper.push([x - yt * Math.sin(th), yc + yt * Math.cos(th)]);
    lower.push([x + yt * Math.sin(th), yc - yt * Math.cos(th)]);
  }
  return { upper, lower };
}

/**
 * Élément d'aile extrudé en envergure (z0 → z1), profil inversé (appui).
 * el: { chord, x, y, aoa(deg, + = bord de fuite relevé = plus d'appui), m, p, t } ;
 * chaque grandeur peut être une fonction de z.
 */
export function wingElement(el, z0, z1, { nSpan = 10, inverted = true } = {}) {
  const val = (v, z) => (typeof v === 'function' ? v(z) : v);
  const prof = naca4(el.m ?? 0.06, el.p ?? 0.4, el.t ?? 0.1, 24);
  const n = prof.upper.length;
  const pos = [];
  const zs = [];
  for (let s = 0; s <= nSpan; s++) zs.push(z0 + ((z1 - z0) * s) / nSpan);
  for (const z of zs) {
    const c = val(el.chord, z), x0 = val(el.x, z), y0 = val(el.y, z);
    const a = (val(el.aoa, z) * Math.PI) / 180;
    const ca = Math.cos(a), sa = Math.sin(a);
    const tr = ([px, py]) => {
      const yy = inverted ? -py : py;
      const lx = px * c, ly = yy * c;
      return [x0 + lx * ca - ly * sa, y0 + lx * sa + ly * ca];
    };
    // boucle : extrados (pression, dessus pour une aile inversée) BA→BF puis intrados BF→BA
    for (let i = 0; i < n; i++) { const q = tr(prof.upper[i]); pos.push(q[0], q[1], z); }
    for (let i = n - 2; i >= 1; i--) { const q = tr(prof.lower[i]); pos.push(q[0], q[1], z); }
  }
  const M = 2 * n - 2;
  const idx = [];
  for (let s = 0; s < zs.length - 1; s++) {
    for (let k = 0; k < M; k++) {
      const a = s * M + k, b = s * M + ((k + 1) % M), c = (s + 1) * M + k, d = (s + 1) * M + ((k + 1) % M);
      idx.push(a, b, c, b, d, c);
    }
  }
  const side = new THREE.BufferGeometry();
  side.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  side.setIndex(idx);
  side.computeVertexNormals();
  // bouchons : bande entre extrados et intrados
  const caps = [];
  for (const [s, flip] of [[0, true], [zs.length - 1, false]]) {
    const base = s * M;
    const cp = pos.slice(base * 3, (base + M) * 3);
    const ci = [];
    // indices locaux : upper i = i (0..n-1), lower i (1..n-2) = M - i
    const up = (i) => i;
    const lo = (i) => (i === 0 ? 0 : i === n - 1 ? n - 1 : M - i);
    for (let i = 0; i < n - 1; i++) {
      const a = up(i), b = up(i + 1), c = lo(i + 1), d = lo(i);
      if (a !== d) { if (flip) ci.push(a, d, b); else ci.push(a, b, d); }
      if (b !== c) { if (flip) ci.push(b, d, c); else ci.push(b, c, d); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
    g.setIndex(ci);
    g.computeVertexNormals();
    caps.push(g);
  }
  return mergeGeoms([side, ...caps]);
}

// Plaque mince (dérive, plaque d'extrémité) : contour 2D (x,y) extrudé en z.
export function plate(outline, zc, thickness) {
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 4 });
  g.translate(0, 0, zc - thickness / 2);
  return g.toNonIndexed();
}

// Plaque horizontale : contour 2D (x,z) extrudé en y.
export function hplate(outline, y0, thickness) {
  const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 4 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  return g.toNonIndexed();
}

export function ellipsoid(cx, cy, cz, rx, ry, rz, seg = 16) {
  const g = new THREE.SphereGeometry(1, seg, Math.max(6, seg / 2));
  g.scale(rx, ry, rz);
  g.translate(cx, cy, cz);
  return g;
}

// Cylindre entre deux points (bras de suspension, mâts)
export function rod(a, b, r, seg = 8) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const len = A.distanceTo(B);
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  g.applyQuaternion(q);
  const m = A.clone().add(B).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z);
  return g;
}

// ---------------------------------------------------------------------------
// Roue : pneu (lathe fermé) + jante détaillée. Axe de rotation selon z.
// Roue : pneu (lathe fermé), jante détaillée selon le style, disque et étrier de frein.
// La partie tournante est dans userData.spin (l'étrier, lui, reste fixe).
export function wheelVisual({ R, B, rimR, style = 'road', rimColor = 0x2a2d33, tireColor = 0x111214, compound = 0xd8d8d8, inner = 1 }) {
  const grp = new THREE.Group();
  const spin = new THREE.Group();
  grp.add(spin);
  grp.userData.spin = spin;
  const sw = B / 2;
  // profil du pneu : flanc intérieur → épaule → bande de roulement → épaule → flanc extérieur
  const prof = [];
  const shoulder = (style === 'f1' ? 0.2 : 0.16) * B;
  prof.push(new THREE.Vector2(rimR * 1.02, -sw * 0.9));
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / n;
    const bulgeR = style === 'f1' ? 0.0 : 0.012;
    const rr = R - shoulder + shoulder * Math.cos(a) + bulgeR * Math.cos(a * 2);
    const zz = sw * Math.sin(a) * (1 + 0.03 * Math.cos(a));
    prof.push(new THREE.Vector2(rr, zz));
  }
  prof.push(new THREE.Vector2(rimR * 1.02, sw * 0.9));
  prof.push(new THREE.Vector2(rimR * 0.99, 0));
  prof.push(new THREE.Vector2(rimR * 1.02, -sw * 0.9));
  const tireG = new THREE.LatheGeometry(prof, 72);
  tireG.rotateX(Math.PI / 2);
  const tire = new THREE.Mesh(tireG, new THREE.MeshPhysicalMaterial({ color: tireColor, roughness: 0.82, metalness: 0.0, sheen: 0.3, sheenColor: new THREE.Color(0x30343a) }));
  spin.add(tire);
  // marquages de flanc : anneau de couleur (gomme) ou liseré
  const ringMat = new THREE.MeshBasicMaterial({ color: style === 'f1' ? compound : 0x4a4f58, side: THREE.DoubleSide, transparent: true, opacity: style === 'f1' ? 0.92 : 0.45 });
  const r0 = style === 'f1' ? R * 0.83 : R * 0.9, r1 = style === 'f1' ? R * 0.855 : R * 0.915;
  for (const sgn of [-1, 1]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 72), ringMat);
    ring.position.z = sgn * sw * 1.012;
    spin.add(ring);
  }
  const rimMat = new THREE.MeshPhysicalMaterial({ color: rimColor, metalness: style === 'road' ? 0.85 : 0.6, roughness: style === 'road' ? 0.22 : 0.38, clearcoat: style === 'road' ? 0.6 : 0.2 });
  // fût de jante
  const barrel = new THREE.CylinderGeometry(rimR, rimR, B * 0.86, 48, 1, true).rotateX(Math.PI / 2);
  spin.add(new THREE.Mesh(barrel, new THREE.MeshPhysicalMaterial({ color: 0x15171a, metalness: 0.5, roughness: 0.55, side: THREE.DoubleSide })));
  // disque de frein (au centre de la roue, visible à travers les branches)
  const discMat = new THREE.MeshPhysicalMaterial({ color: style === 'f1' ? 0x2b2622 : 0x8d9198, metalness: style === 'f1' ? 0.2 : 0.9, roughness: style === 'f1' ? 0.7 : 0.35 });
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.78, rimR * 0.78, 0.028, 40).rotateX(Math.PI / 2), discMat);
  disc.position.z = inner * B * 0.12;
  spin.add(disc);
  if (style === 'f1') {
    // tambour de frein / écope (fixe)
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.82, rimR * 0.86, B * 0.5, 32).rotateX(Math.PI / 2), carbonMaterial({ color: 0x1b1d21 }));
    drum.position.z = inner * B * 0.18;
    grp.add(drum);
  } else {
    const cal = new THREE.Mesh(new THREE.BoxGeometry(rimR * 0.42, rimR * 0.26, 0.07), new THREE.MeshPhysicalMaterial({ color: style === 'hyper' ? 0xd4a017 : 0xc0262d, metalness: 0.3, roughness: 0.35, clearcoat: 0.8 }));
    cal.position.set(rimR * 0.5, rimR * 0.5, inner * B * 0.12);
    cal.rotation.z = Math.PI / 4;
    grp.add(cal);
  }
  // faces de jante (les deux côtés)
  for (const sgn of [-1, 1]) {
    const face = new THREE.Group();
    face.position.z = sgn * B * 0.37;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.17, rimR * 0.2, B * 0.1, 24).rotateX(Math.PI / 2), rimMat);
    face.add(hub);
    if (style === 'f1' || style === 'hyper') {
      // écrou central de fixation
      const nut = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.09, rimR * 0.09, B * 0.16, 6).rotateX(Math.PI / 2), new THREE.MeshPhysicalMaterial({ color: style === 'f1' ? 0xff3b30 : 0xd4a017, metalness: 0.6, roughness: 0.3 }));
      face.add(nut);
    }
    const nSp = style === 'f1' ? 10 : style === 'hyper' ? 6 : 5;
    for (let k = 0; k < nSp; k++) {
      const a = (2 * Math.PI * k) / nSp;
      const mk = (off, w) => {
        const sp = new THREE.Mesh(new THREE.BoxGeometry(rimR * 0.82, rimR * w, B * 0.05), rimMat);
        const aa = a + off;
        sp.position.set(Math.cos(aa) * rimR * 0.56, Math.sin(aa) * rimR * 0.56, 0);
        sp.rotation.z = aa;
        face.add(sp);
      };
      if (style === 'road') { mk(-0.09, 0.075); mk(0.09, 0.075); } // branches doubles
      else if (style === 'hyper') { mk(0, 0.16); }
      else mk(0, 0.07);
    }
    const lip = new THREE.Mesh(new THREE.TorusGeometry(rimR * 0.975, rimR * 0.03, 8, 64), rimMat);
    face.add(lip);
    spin.add(face);
  }
  return grp;
}

export function cylinderZ(R, B, cx, cy, cz, seg = 28) {
  const g = new THREE.CylinderGeometry(R, R, B, seg, 1, false);
  g.rotateX(Math.PI / 2);
  g.translate(cx, cy, cz);
  return g;
}

// ---------------------------------------------------------------------------
export function mergeGeoms(geoms) {
  const parts = geoms.map((g0) => {
    const g = g0.index ? g0.toNonIndexed() : g0;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    return g;
  });
  const hasColor = parts.every((g) => g.getAttribute('color'));
  let n = 0;
  for (const g of parts) n += g.getAttribute('position').count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = hasColor ? new Float32Array(n * 3) : null;
  let o = 0;
  for (const g of parts) {
    const pa = g.getAttribute('position'), na = g.getAttribute('normal');
    for (let i = 0; i < pa.count; i++) {
      pos[(o + i) * 3] = pa.getX(i); pos[(o + i) * 3 + 1] = pa.getY(i); pos[(o + i) * 3 + 2] = pa.getZ(i);
      nrm[(o + i) * 3] = na.getX(i); nrm[(o + i) * 3 + 1] = na.getY(i); nrm[(o + i) * 3 + 2] = na.getZ(i);
    }
    if (hasColor) {
      const ca = g.getAttribute('color');
      for (let i = 0; i < ca.count; i++) { col[(o + i) * 3] = ca.getX(i); col[(o + i) * 3 + 1] = ca.getY(i); col[(o + i) * 3 + 2] = ca.getZ(i); }
    }
    o += pa.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  if (hasColor) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

export function applyColors(g, fn) {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const col = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const v = fn(p.getX(i), p.getY(i), p.getZ(i), n ? n.getX(i) : 0, n ? n.getY(i) : 0, n ? n.getZ(i) : 0);
    c.set(v);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
