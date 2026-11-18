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
  // flanc gauche (z = -W) : du haut vers le bas
  {
    const y0 = topR(-W), y1 = botR(-W);
    for (let k = 1; k < nSide; k++) pts.push([x, y0 + ((y1 - y0) * k) / nSide, -W]);
  }
  // dessous : z de -W à +W
  for (let k = 0; k <= nTop; k++) {
    const z = -W * Math.cos((Math.PI * k) / nTop);
    pts.push([x, botR(z), z]);
  }
  // flanc droit : du bas vers le haut
  {
    const y0 = botR(W), y1 = topR(W);
    for (let k = 1; k < nSide; k++) pts.push([x, y0 + ((y1 - y0) * k) / nSide, W]);
  }
  return pts;
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
export function wheelVisual({ R, B, rimR, spokes = 10, rimColor = 0x2a2d33, tireColor = 0x111214 }) {
  const grp = new THREE.Group();
  const prof = [];
  const sw = B / 2;
  const n = 10;
  // profil fermé (rayon, axe) : flanc intérieur → bande de roulement → flanc extérieur → retour sur la jante
  prof.push(new THREE.Vector2(rimR, -sw * 0.92));
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / n;
    const shoulder = 0.18 * B;
    const rr = R - shoulder + shoulder * Math.cos(a);
    const zz = sw * Math.sin(a);
    prof.push(new THREE.Vector2(rr, zz));
  }
  prof.push(new THREE.Vector2(rimR, sw * 0.92));
  prof.push(new THREE.Vector2(rimR * 0.985, 0));
  prof.push(new THREE.Vector2(rimR, -sw * 0.92));
  const tireG = new THREE.LatheGeometry(prof, 56);
  tireG.rotateX(Math.PI / 2);
  const tireMat = new THREE.MeshPhysicalMaterial({ color: tireColor, roughness: 0.85, metalness: 0.0 });
  const tire = new THREE.Mesh(tireG, tireMat);
  tire.castShadow = true;
  grp.add(tire);
  // marquage latéral discret
  const ringG = new THREE.RingGeometry(R * 0.86, R * 0.9, 56);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x5b6270, side: THREE.DoubleSide, transparent: true, opacity: 0.55 });
  for (const s of [-1, 1]) {
    const ring = new THREE.Mesh(ringG, ringMat);
    ring.position.z = s * sw * 1.002;
    grp.add(ring);
  }
  // jante : disque creux + rayons
  const rimMat = new THREE.MeshPhysicalMaterial({ color: rimColor, metalness: 0.9, roughness: 0.3 });
  const dish = new THREE.CylinderGeometry(rimR, rimR, B * 0.86, 40, 1, true);
  dish.rotateX(Math.PI / 2);
  const dishMesh = new THREE.Mesh(dish, new THREE.MeshPhysicalMaterial({ color: 0x0b0c0e, metalness: 0.4, roughness: 0.6, side: THREE.DoubleSide }));
  grp.add(dishMesh);
  for (const s of [-1, 1]) {
    const face = new THREE.Group();
    face.position.z = s * B * 0.36;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(rimR * 0.2, rimR * 0.22, B * 0.08, 20).rotateX(Math.PI / 2), rimMat);
    face.add(hub);
    for (let k = 0; k < spokes; k++) {
      const a = (2 * Math.PI * k) / spokes;
      const sp = new THREE.Mesh(new THREE.BoxGeometry(rimR * 0.8, rimR * 0.09, B * 0.04), rimMat);
      sp.position.set(Math.cos(a) * rimR * 0.55, Math.sin(a) * rimR * 0.55, 0);
      sp.rotation.z = a;
      face.add(sp);
    }
    const lip = new THREE.Mesh(new THREE.TorusGeometry(rimR * 0.97, rimR * 0.035, 8, 48), rimMat);
    face.add(lip);
    grp.add(face);
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
