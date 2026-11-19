// Import d'un modèle 3D de l'utilisateur (GLB / glTF, STL, OBJ).
//  - orientation automatique : longueur = plus grande dimension, hauteur = axe « haut » du format
//    (Y pour glTF et OBJ, Z pour STL) sauf incohérence, avant/arrière deviné (le haut de la voiture,
//    habitacle ou aileron, est en arrière du milieu) et inversable ;
//  - échelle : unité devinée (m, cm, mm, pouces) puis longueur réelle réglable ;
//  - voxelisation robuste, valable pour des maillages non fermés : surface marquée selon 3 axes,
//    extérieur rempli depuis les bords, le reste est solide.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { markSurface, fillSolid } from './sdf.js';

let current = null;
let serial = 0; // { name, format, meshes: [{ geometry, material }] } en repère « brut » orienté

export const importedModel = () => current;

/** Lit un fichier et renvoie un objet Three.js. */
export async function loadModelFile(file) {
  const name = file.name || 'modele';
  const ext = name.split('.').pop().toLowerCase();
  let root, format;
  if (ext === 'glb' || ext === 'gltf') {
    const data = ext === 'glb' ? await file.arrayBuffer() : await file.text();
    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(data, '', res, (e) => rej(new Error(ext === 'gltf'
      ? 'Fichier glTF illisible. S\'il dépend de fichiers annexes (.bin, textures), exportez-le plutôt en .glb (un seul fichier).'
      : `Fichier GLB illisible (${e?.message || e}).`))));
    root = gltf.scene;
    format = 'gltf';
  } else if (ext === 'stl') {
    const g = new STLLoader().parse(await file.arrayBuffer());
    root = new THREE.Mesh(g, null);
    format = 'stl';
  } else if (ext === 'obj') {
    root = new OBJLoader().parse(await file.text());
    format = 'obj';
  } else {
    throw new Error('Format non pris en charge. Formats acceptés : .glb, .gltf, .stl, .obj');
  }
  current = prepare(root, format, name);
  current.serial = ++serial;
  current.autoL = current.size[current.axes[0]] * guessScale(current.size[current.axes[0]]);
  return current;
}

const paint = () => new THREE.MeshPhysicalMaterial({ color: 0xc9ced6, metalness: 0.35, roughness: 0.38, clearcoat: 0.7, clearcoatRoughness: 0.2 });

// Cuit les transformations, choisit les axes, renvoie des géométries (x = longueur, y = haut, z = largeur)
function prepare(root, format, name) {
  root.updateMatrixWorld(true);
  const meshes = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.getAttribute('position')) return;
    let g = o.geometry.clone();
    // seules les positions, normales, UV et couleurs sont utiles (morphs et os ignorés)
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
    g.morphAttributes = {};
    g.applyMatrix4(o.matrixWorld);
    let mat = o.material;
    if (Array.isArray(mat)) mat = mat.map((m) => m || paint());
    if (!mat || (format !== 'gltf' && !Array.isArray(mat) && (mat.type === 'MeshPhongMaterial' || mat.type === 'MeshBasicMaterial') && !mat.map)) mat = paint();
    meshes.push({ geometry: g, material: mat });
  });
  if (!meshes.length) throw new Error('Aucun maillage trouvé dans le fichier.');
  let nTri = 0;
  const box = new THREE.Box3();
  for (const m of meshes) {
    m.geometry.computeBoundingBox();
    box.union(m.geometry.boundingBox);
    const p = m.geometry.getAttribute('position');
    nTri += (m.geometry.index ? m.geometry.index.count : p.count) / 3;
  }
  const size = box.getSize(new THREE.Vector3()).toArray();
  if (!(size[0] + size[1] + size[2] > 0)) throw new Error('Modèle vide ou dégénéré.');
  // axes
  const order = [0, 1, 2].sort((a, b) => size[b] - size[a]);
  const lenAx = order[0];
  let upAx = format === 'stl' ? 2 : 1;
  if (upAx === lenAx || size[upAx] > 1.6 * size[order[2]] && size[upAx] > size[order[1]]) upAx = order[2];
  const widAx = 3 - lenAx - upAx;
  return { name, format, meshes, box, size, axes: [lenAx, upAx, widAx], nTri: Math.round(nTri) };
}

function guessScale(Lraw) {
  if (Lraw >= 1.2 && Lraw <= 9) return 1; // mètres
  if (Lraw >= 120 && Lraw <= 900) return 0.01; // centimètres
  if (Lraw >= 1200 && Lraw <= 9000) return 0.001; // millimètres
  if (Lraw >= 48 && Lraw < 120) return 0.0254; // pouces
  return 4.5 / Lraw;
}

/**
 * Construit la voiture importée au format attendu par la soufflerie.
 * P : { length (m, 0 = auto), flip (avant/arrière), upside (retourner), mass }
 */
export function buildImported(P = {}) {
  const m = current;
  if (!m) throw new Error('Aucun modèle importé.');
  const [la, ua, wa] = m.axes;
  // matrice de passage : axe longueur → x, haut → y, largeur → z (repère direct)
  const e = (i) => new THREE.Vector3().setComponent(i, 1);
  const ex = e(la), ey = e(ua), ez = e(wa);
  if (new THREE.Vector3().crossVectors(ex, ey).dot(ez) < 0) ez.negate();
  const R = new THREE.Matrix4().makeBasis(ex, ey, ez).transpose(); // monde brut → voiture
  if (P.upside) R.premultiply(new THREE.Matrix4().makeRotationX(Math.PI));
  const Lraw = m.size[la];
  const unit = guessScale(Lraw);
  const autoL = Lraw * unit;
  const L = P.length > 0.5 ? P.length : autoL;
  const k = L / Lraw;
  // orientation avant/arrière automatique : le point haut (habitacle, aileron) est en arrière
  const tmp = new THREE.Box3();
  const geoms = m.meshes.map((x) => x.geometry.clone().applyMatrix4(new THREE.Matrix4().makeScale(k, k, k).multiply(R)));
  for (const g of geoms) { g.computeBoundingBox(); tmp.union(g.boundingBox); }
  const H0 = tmp.max.y - tmp.min.y;
  let sx = 0, sw = 0;
  for (const g of geoms) {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i += Math.max(1, Math.floor(p.count / 4000))) {
      const y = p.getY(i);
      if (y > tmp.min.y + 0.75 * H0) { sx += p.getX(i); sw++; }
    }
  }
  const xc = (tmp.min.x + tmp.max.x) / 2;
  let flip = sw > 0 && sx / sw < xc; // le haut est à l'avant → l'avant est vers +x : on retourne
  if (P.flip) flip = !flip;
  const T = new THREE.Matrix4();
  if (flip) T.makeRotationY(Math.PI);
  const box = new THREE.Box3();
  for (const g of geoms) { g.applyMatrix4(T); g.computeBoundingBox(); box.union(g.boundingBox); }
  const shift = new THREE.Matrix4().makeTranslation(-box.min.x, -box.min.y, -(box.min.z + box.max.z) / 2);
  for (const g of geoms) { g.applyMatrix4(shift); g.computeBoundingBox(); if (!g.getAttribute('normal')) g.computeVertexNormals(); }
  box.applyMatrix4(shift);
  const W = box.max.z - box.min.z, H = box.max.y;

  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  geoms.forEach((g, i) => {
    const mesh = new THREE.Mesh(g, m.meshes[i].material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.cat = 1;
    body.add(mesh);
  });

  // occupation robuste sur une grille fine (cellules ≤ 4 M)
  const pad = 0.04;
  let h = Math.cbrt(((L + 2 * pad) * (H + 2 * pad) * (W + 2 * pad)) / 4e6);
  h = Math.max(0.008, Math.min(0.03, h));
  const og = { x0: -pad, y0: -pad, z0: box.min.z - pad, h };
  og.nx = Math.ceil((L + 2 * pad) / h); og.ny = Math.ceil((H + 2 * pad) / h); og.nz = Math.ceil((W + 2 * pad) / h);
  const occ = new Uint8Array(og.nx * og.ny * og.nz);
  const trisList = geoms.map((g) => trisOf(g));
  for (const t of trisList) markSurface(t, og, occ);
  // le sol (y < 0) est hors voiture : les pneus posés dessus ne ferment pas le dessous
  const solid = fillSolid(occ, og, false);
  const sample = (x, y, z) => {
    const i = Math.floor((x - og.x0) / h), j = Math.floor((y - og.y0) / h), kk = Math.floor((z - og.z0) / h);
    if (i < 0 || j < 0 || kk < 0 || i >= og.nx || j >= og.ny || kk >= og.nz) return 0;
    return solid[i + og.nx * (j + og.ny * kk)];
  };
  // garde au sol : bas de caisse dans la moitié centrale
  let ground = 0.12;
  {
    const ys = [];
    for (let x = 0.3 * L; x <= 0.7 * L; x += L / 20) for (let z = -W / 8; z <= W / 8; z += W / 16) {
      for (let y = 0; y < H; y += h) if (sample(x, y, z)) { ys.push(y); break; }
    }
    if (ys.length) { ys.sort((a, b) => a - b); ground = Math.max(0.01, ys[Math.floor(ys.length / 2)]); }
  }
  const occupancy = { ...og, solid, sample };
  const xF = 0.2 * L, xR = 0.8 * L;
  const solids = trisList.map((tris) => ({ tris, prebaked: true, cat: 1, thin: false, priority: 1 }));
  return {
    id: 'import', name: m.name, short: 'Import', group, body, solids, occupancy,
    wheels: [], wheelGroups: [],
    dims: { L, W, H, wheelbase: xR - xF, xF, xR, x0: 0, x1: L, mass: P.mass || 0, ground },
    catNames: { 1: 'Carrosserie', 2: '—', 3: '—', 4: '—' },
    bodyMatrix: new THREE.Matrix4(), aero: null,
    importInfo: { file: m.name, nTri: m.nTri, unit, autoL, flipped: flip, h, serial: m.serial, format: m.format },
  };
}

function trisOf(g) {
  const p = g.getAttribute('position');
  const idx = g.index;
  const n = idx ? idx.count : p.count;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = idx ? idx.getX(i) : i;
    out[i * 3] = p.getX(v); out[i * 3 + 1] = p.getY(v); out[i * 3 + 2] = p.getZ(v);
  }
  return out;
}
