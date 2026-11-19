// Champ de distance signé fin de la voiture, pour la fumée 3D.
// La grille de calcul (4 à 7 cm) ne voit ni les ailerons (modélisés par des forces), ni les
// petites pièces : la fumée suivrait l'air au travers. On construit donc, sur une grille fine
// (1,5 à 3 cm) qui couvre la voiture, la distance à la surface visible de TOUTES les pièces.
//  1. marquage des cellules traversées par la surface (rayons selon les 3 axes + sommets),
//     valable aussi pour des maillages non fermés ;
//  2. remplissage de l'extérieur depuis les bords ; ce qui n'est pas atteint est solide ;
//  3. transformée de distance de chanfrein 3-4-5, extérieur et intérieur, puis distance signée.
import * as THREE from 'three';
import { trianglesOf } from './voxelize.js';

const AXES = [[0, 1, 2], [1, 0, 2], [2, 0, 1]]; // [axe du rayon, u, v]

/** Marque dans occ (Uint8Array nx·ny·nz) les cellules traversées par les triangles. */
export function markSurface(tris, g, occ) {
  const dims = [g.nx, g.ny, g.nz], org = [g.x0, g.y0, g.z0], h = g.h;
  const strides = [1, g.nx, g.nx * g.ny];
  const nt = tris.length / 9;
  for (const [ia, iu, iv] of AXES) {
    const nu = dims[iu], nv = dims[iv], na = dims[ia];
    const u0 = org[iu], v0 = org[iv], a0 = org[ia];
    const su = strides[iu], sv = strides[iv], sa = strides[ia];
    const eu = h * 1.37e-4 + 1.1e-7, ev = h * 2.71e-4 + 1.9e-7;
    for (let t = 0; t < nt; t++) {
      const o = t * 9;
      const au = tris[o + iu], av = tris[o + iv], aa = tris[o + ia];
      const bu = tris[o + 3 + iu], bv = tris[o + 3 + iv], ba = tris[o + 3 + ia];
      const cu = tris[o + 6 + iu], cv = tris[o + 6 + iv], ca = tris[o + 6 + ia];
      const i0 = Math.max(0, Math.ceil((Math.min(au, bu, cu) - u0 - eu) / h - 0.5));
      const i1 = Math.min(nu - 1, Math.floor((Math.max(au, bu, cu) - u0 - eu) / h - 0.5));
      if (i0 > i1) continue;
      const j0 = Math.max(0, Math.ceil((Math.min(av, bv, cv) - v0 - ev) / h - 0.5));
      const j1 = Math.min(nv - 1, Math.floor((Math.max(av, bv, cv) - v0 - ev) / h - 0.5));
      if (j0 > j1) continue;
      for (let j = j0; j <= j1; j++) {
        const pv = v0 + (j + 0.5) * h + ev;
        for (let i = i0; i <= i1; i++) {
          const pu = u0 + (i + 0.5) * h + eu;
          const w0 = (bu - pu) * (cv - pv) - (bv - pv) * (cu - pu);
          const w1 = (cu - pu) * (av - pv) - (cv - pv) * (au - pu);
          const w2 = (au - pu) * (bv - pv) - (av - pv) * (bu - pu);
          if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) {
            const s = w0 + w1 + w2;
            if (s === 0) continue;
            const ka = Math.floor(((w0 * aa + w1 * ba + w2 * ca) / s - a0) / h);
            if (ka >= 0 && ka < na) occ[i * su + j * sv + ka * sa] = 1;
          }
        }
      }
    }
  }
  // petits triangles qu'aucun rayon ne touche : on marque au moins la cellule de leurs sommets
  for (let v = 0; v < tris.length; v += 3) {
    const i = Math.floor((tris[v] - g.x0) / h), j = Math.floor((tris[v + 1] - g.y0) / h), k = Math.floor((tris[v + 2] - g.z0) / h);
    if (i >= 0 && i < g.nx && j >= 0 && j < g.ny && k >= 0 && k < g.nz) occ[i + g.nx * (j + g.ny * k)] = 1;
  }
}

/**
 * Solide = cellules non atteintes depuis l'extérieur (6-connexité).
 * openZmin : la face z = z0 coupe la voiture (demi-modèle) et ne sert pas de point de départ.
 */
export function fillSolid(occ, g, openZmin = false) {
  const { nx, ny, nz } = g;
  const N = nx * ny * nz;
  const ext = new Uint8Array(N);
  const queue = new Int32Array(N);
  let qh = 0, qt = 0;
  const seed = (id) => { if (!occ[id] && !ext[id]) { ext[id] = 1; queue[qt++] = id; } };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const b = i === 0 || i === nx - 1 || j === 0 || j === ny - 1 || k === nz - 1 || (k === 0 && !openZmin);
    if (b) seed(i + nx * (j + ny * k));
  }
  const sy = nx, sz = nx * ny;
  while (qh < qt) {
    const id = queue[qh++];
    const i = id % nx, j = ((id - i) / nx) % ny, k = (id - i - nx * j) / sz;
    if (i > 0) seed(id - 1);
    if (i < nx - 1) seed(id + 1);
    if (j > 0) seed(id - sy);
    if (j < ny - 1) seed(id + sy);
    if (k > 0) seed(id - sz);
    if (k < nz - 1) seed(id + sz);
  }
  const solid = new Uint8Array(N);
  for (let id = 0; id < N; id++) solid[id] = ext[id] ? 0 : 1;
  return solid;
}

// transformée de distance de chanfrein 3-4-5 (distance × 3 aux cellules où seed = 1)
function chamfer(seedMask, g, cap) {
  const { nx, ny, nz } = g;
  const N = nx * ny * nz;
  const d = new Uint16Array(N).fill(cap);
  for (let id = 0; id < N; id++) if (seedMask[id]) d[id] = 0;
  const offs = [];
  for (let dk = -1; dk <= 0; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    if (dk === 0 && (dj > 0 || (dj === 0 && di >= 0))) continue;
    const n = Math.abs(di) + Math.abs(dj) + Math.abs(dk);
    offs.push([di, dj, dk, n === 1 ? 3 : n === 2 ? 4 : 5]);
  }
  const sy = nx, sz = nx * ny;
  const pass = (sgn) => {
    const k0 = sgn > 0 ? 0 : nz - 1, k1 = sgn > 0 ? nz : -1;
    const j0 = sgn > 0 ? 0 : ny - 1, j1 = sgn > 0 ? ny : -1;
    const i0 = sgn > 0 ? 0 : nx - 1, i1 = sgn > 0 ? nx : -1;
    for (let k = k0; k !== k1; k += sgn) for (let j = j0; j !== j1; j += sgn) for (let i = i0; i !== i1; i += sgn) {
      const id = i + sy * j + sz * k;
      let best = d[id];
      if (best === 0) continue;
      for (const [di, dj, dk, w] of offs) {
        const a = i + sgn * di, b = j + sgn * dj, c = k + sgn * dk;
        if (a < 0 || a >= nx || b < 0 || b >= ny || c < 0 || c >= nz) continue;
        const v = d[a + sy * b + sz * c] + w;
        if (v < best) best = v;
      }
      d[id] = best;
    }
  };
  pass(1);
  pass(-1);
  return d;
}

/**
 * Collecte les triangles de tous les maillages visibles d'un groupe, dans le repère soufflerie.
 * root : groupe de la voiture ; pre : matrice appliquée au groupe (lacet).
 */
export function meshTriangles(root, pre) {
  const out = [];
  const walk = (o, parent) => {
    if (o.visible === false) return;
    if (o.matrixAutoUpdate) o.updateMatrix();
    const m = parent.clone().multiply(o.matrix);
    if (o.isMesh && o.geometry?.getAttribute('position')) out.push(trianglesOf(o.geometry, m));
    for (const c of o.children) walk(c, m);
  };
  if (root.matrixAutoUpdate) root.updateMatrix();
  const m0 = pre.clone().multiply(root.matrix);
  for (const c of root.children) walk(c, m0);
  return out;
}

/**
 * Champ de distance signé (m) sur une grille fine couvrant `box` (Box3) + marge.
 * sym : demi-modèle (z ≥ 0 seulement). maxDim : taille maximale d'une texture 3D.
 * Renvoie { nx, ny, nz, x0, y0, z0, h, data: Float32Array }.
 */
export function buildSDF(trisList, box, { sym = false, cells = 1.2e6, maxDim = 256, hMin = 0.012, hMax = 0.035 } = {}) {
  const size = new THREE.Vector3().subVectors(box.max, box.min);
  const zLo = sym ? 0 : box.min.z;
  let h = Math.cbrt(((size.x + 0.16) * (size.y + 0.16) * (box.max.z - zLo + 0.16)) / cells);
  h = Math.min(hMax, Math.max(hMin, h));
  const pad = 4 * h;
  const ext = Math.max(size.x, size.y, box.max.z - zLo) + 2 * pad;
  if (ext / h > maxDim - 2) h = ext / (maxDim - 2);
  const x0 = box.min.x - pad, y0 = Math.max(-2 * h, box.min.y - pad), z0 = sym ? -2 * h : box.min.z - pad;
  const nx = Math.ceil((box.max.x + pad - x0) / h), ny = Math.ceil((box.max.y + pad - y0) / h), nz = Math.ceil((box.max.z + pad - z0) / h);
  const g = { nx, ny, nz, x0, y0, z0, h };
  const N = nx * ny * nz;
  const occ = new Uint8Array(N);
  for (const tris of trisList) markSurface(tris, g, occ);
  const solid = fillSolid(occ, g, sym);
  const cap = 3 * 12;
  const dOut = chamfer(solid, g, cap); // distance à la paroi pour les cellules d'air
  const ext2 = new Uint8Array(N);
  for (let id = 0; id < N; id++) ext2[id] = solid[id] ? 0 : 1;
  const dIn = chamfer(ext2, g, cap); // profondeur dans la matière
  const data = new Float32Array(N);
  for (let id = 0; id < N; id++) data[id] = solid[id] ? -(dIn[id] / 3 - 0.5) * h : (dOut[id] / 3 - 0.5) * h;
  let nSolid = 0;
  for (let id = 0; id < N; id++) nSolid += solid[id];
  return { ...g, data, nSolid };
}
