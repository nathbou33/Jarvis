// Voxelisation de maillages fermés par lancer de rayons axiaux et comptage de parité.
//  - pièces épaisses : test du centre de cellule (ray-casting selon x)
//  - pièces minces (ailerons, plaques, fond plat) : marquage conservatif selon les 3 axes,
//    pour qu'un élément plus fin qu'une cellule ne disparaisse pas de la grille.
import * as THREE from 'three';

export function trianglesOf(geometry, matrix = null) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const p = g.getAttribute('position');
  const out = new Float32Array(p.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    if (matrix) v.applyMatrix4(matrix);
    out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
  }
  return out;
}

const AX = [[0, 1, 2], [1, 0, 2], [2, 0, 1]]; // [axe du rayon, u, v]

/**
 * Intersections de rayons parallèles à `axis` avec un ensemble de triangles.
 * Les rayons passent par u = u0 + (i+0.5)du, v = v0 + (j+0.5)dv.
 * Renvoie un tableau (nu*nv) de listes triées de coordonnées d'intersection.
 */
export function rayHits(tris, axis, { u0, du, nu, v0, dv, nv }) {
  const [ia, iu, iv] = AX[axis];
  const hits = new Array(nu * nv);
  const eu = du * 1.37e-4 + 1.1e-7, ev = dv * 2.71e-4 + 1.9e-7; // décalage anti-dégénérescence
  const nt = tris.length / 9;
  for (let t = 0; t < nt; t++) {
    const o = t * 9;
    const au = tris[o + iu], av = tris[o + iv], aa = tris[o + ia];
    const bu = tris[o + 3 + iu], bv = tris[o + 3 + iv], ba = tris[o + 3 + ia];
    const cu = tris[o + 6 + iu], cv = tris[o + 6 + iv], ca = tris[o + 6 + ia];
    const area = (bu - au) * (cv - av) - (bv - av) * (cu - au);
    if (Math.abs(area) < 1e-14) continue;
    const umin = Math.min(au, bu, cu), umax = Math.max(au, bu, cu);
    const vmin = Math.min(av, bv, cv), vmax = Math.max(av, bv, cv);
    const i0 = Math.max(0, Math.ceil((umin - u0 - eu) / du - 0.5));
    const i1 = Math.min(nu - 1, Math.floor((umax - u0 - eu) / du - 0.5));
    const j0 = Math.max(0, Math.ceil((vmin - v0 - ev) / dv - 0.5));
    const j1 = Math.min(nv - 1, Math.floor((vmax - v0 - ev) / dv - 0.5));
    if (i0 > i1 || j0 > j1) continue;
    for (let j = j0; j <= j1; j++) {
      const pv = v0 + (j + 0.5) * dv + ev;
      for (let i = i0; i <= i1; i++) {
        const pu = u0 + (i + 0.5) * du + eu;
        const w0 = (bu - pu) * (cv - pv) - (bv - pv) * (cu - pu);
        const w1 = (cu - pu) * (av - pv) - (cv - pv) * (au - pu);
        const w2 = (au - pu) * (bv - pv) - (av - pv) * (bu - pu);
        if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) {
          const s = w0 + w1 + w2;
          if (s === 0) continue;
          const ta = (w0 * aa + w1 * ba + w2 * ca) / s;
          const k = i + nu * j;
          (hits[k] || (hits[k] = [])).push(ta);
        }
      }
    }
  }
  for (const h of hits) if (h) h.sort((a, b) => a - b);
  return hits;
}

function intervals(h, fn) {
  for (let m = 0; m + 1 < h.length; m += 2) fn(h[m], h[m + 1]);
}

// Pièce mince : une épaisseur inférieure à la cellule donne au moins la cellule qui contient
// son milieu ; au-delà, les cellules couvertes à plus de 50 %.
function thinCells(a, b, o, dx, fn) {
  if (b - a < dx) {
    fn(Math.floor(((a + b) / 2 - o) / dx));
    return;
  }
  for (let i = Math.ceil((a - o) / dx - 0.5); i <= Math.floor((b - o) / dx - 0.5); i++) fn(i);
}

/**
 * Voxelisation 3D. grid: { nx, ny, nz, x0, y0, z0, dx }
 * solids: [{ tris, cat, thin, priority }]
 */
export function voxelize3D(solids, grid) {
  const { nx, ny, nz, x0, y0, z0, dx } = grid;
  const cat = new Uint8Array(nx * ny * nz);
  const prio = new Int8Array(nx * ny * nz).fill(-1);
  const set = (i, j, k, s) => {
    if (i < 0 || i >= nx || j < 0 || j >= ny || k < 0 || k >= nz) return;
    const id = i + nx * (j + ny * k);
    if (s.priority >= prio[id]) { prio[id] = s.priority; cat[id] = s.cat; }
  };
  const sorted = [...solids].sort((a, b) => a.priority - b.priority);
  for (const s of sorted) {
    if (!s.thin) {
      const hits = rayHits(s.tris, 0, { u0: y0, du: dx, nu: ny, v0: z0, dv: dx, nv: nz });
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
        const h = hits[j + ny * k];
        if (!h) continue;
        intervals(h, (a, b) => {
          const i0 = Math.ceil((a - x0) / dx - 0.5), i1 = Math.floor((b - x0) / dx - 0.5);
          for (let i = i0; i <= i1; i++) set(i, j, k, s);
        });
      }
    } else {
      // x
      let hits = rayHits(s.tris, 0, { u0: y0, du: dx, nu: ny, v0: z0, dv: dx, nv: nz });
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
        const h = hits[j + ny * k];
        if (h) intervals(h, (a, b) => thinCells(a, b, x0, dx, (i) => set(i, j, k, s)));
      }
      // y
      hits = rayHits(s.tris, 1, { u0: x0, du: dx, nu: nx, v0: z0, dv: dx, nv: nz });
      for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        const h = hits[i + nx * k];
        if (h) intervals(h, (a, b) => thinCells(a, b, y0, dx, (j) => set(i, j, k, s)));
      }
      // z
      hits = rayHits(s.tris, 2, { u0: x0, du: dx, nu: nx, v0: y0, dv: dx, nv: ny });
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const h = hits[i + nx * j];
        if (h) intervals(h, (a, b) => thinCells(a, b, z0, dx, (k) => set(i, j, k, s)));
      }
    }
  }
  return cat;
}

/**
 * Coupe 2D.
 *  plane 'side' : plan vertical z = zs, grille (x, y)
 *  plane 'top'  : plan horizontal y = ys, grille (x, z) (j ↔ z)
 * grid: { nx, ny, x0, y0, dx } (y0 = origine de l'axe vertical de la grille 2D)
 */
export function voxelizeSection(solids, grid, plane, at, out = null, prioArr = null) {
  const { nx, ny, x0, y0, dx } = grid;
  const cat = out || new Uint8Array(nx * ny);
  const prio = prioArr || new Int8Array(nx * ny).fill(-1);
  const set = (i, j, s) => {
    if (i < 0 || i >= nx || j < 0 || j >= ny) return;
    const id = i + nx * j;
    if (s.priority >= prio[id]) { prio[id] = s.priority; cat[id] = s.cat; }
  };
  const sorted = [...solids].sort((a, b) => a.priority - b.priority);
  // axes monde : side → (x, y) avec z fixe ; top → (x, z) avec y fixe
  for (const s of sorted) {
    let hx;
    if (plane === 'side') hx = rayHits(s.tris, 0, { u0: y0, du: dx, nu: ny, v0: at - 0.5, dv: 1, nv: 1 });
    else hx = rayHits(s.tris, 0, { u0: at - 0.5, du: 1, nu: 1, v0: y0, dv: dx, nv: ny });
    for (let j = 0; j < ny; j++) {
      const h = hx[j];
      if (!h) continue;
      intervals(h, (a, b) => {
        if (s.thin) thinCells(a, b, x0, dx, (i) => set(i, j, s));
        else for (let i = Math.ceil((a - x0) / dx - 0.5); i <= Math.floor((b - x0) / dx - 0.5); i++) set(i, j, s);
      });
    }
    if (s.thin) {
      let hv;
      if (plane === 'side') hv = rayHits(s.tris, 1, { u0: x0, du: dx, nu: nx, v0: at - 0.5, dv: 1, nv: 1 });
      else hv = rayHits(s.tris, 2, { u0: x0, du: dx, nu: nx, v0: at - 0.5, dv: 1, nv: 1 });
      for (let i = 0; i < nx; i++) {
        const h = hv[i];
        if (h) intervals(h, (a, b) => thinCells(a, b, y0, dx, (j) => set(i, j, s)));
      }
    }
  }
  return cat;
}

// Silhouette latérale : union des coupes sur toute la largeur.
export function voxelizeSilhouette(solids, grid, zMin, zMax, dz) {
  const { nx, ny } = grid;
  const cat = new Uint8Array(nx * ny);
  const prio = new Int8Array(nx * ny).fill(-1);
  for (let z = zMin + dz / 2; z < zMax; z += dz) voxelizeSection(solids, grid, 'side', z, cat, prio);
  return cat;
}

// Surface projetée selon un axe (m²) — maître-couple si axis = 0.
export function projectedArea(solids, axis, bounds, res = 0.01) {
  const [, iu, iv] = AX[axis];
  const u0 = bounds.min[iu], v0 = bounds.min[iv];
  const nu = Math.ceil((bounds.max[iu] - u0) / res), nv = Math.ceil((bounds.max[iv] - v0) / res);
  const covered = new Uint8Array(nu * nv);
  for (const s of solids) {
    const h = rayHits(s.tris, axis, { u0, du: res, nu, v0, dv: res, nv });
    for (let k = 0; k < h.length; k++) if (h[k] && h[k].length >= 2) covered[k] = 1;
  }
  let n = 0;
  for (const c of covered) n += c;
  return n * res * res;
}
