// Les trois modèles de voiture, construits aux cotes réelles de leur catégorie.
// Repère voiture : x vers l'arrière (sens de l'écoulement), y vers le haut (sol en y = 0),
// z latéral. Toutes les pièces « solides » sont des maillages fermés voxelisables ;
// les éléments plus fins qu'une cellule (suspensions, halo…) sont purement visuels.
import * as THREE from 'three';
import {
  curve, smoothstep, smax, dome, loftGeometry, superLoft, stations, wingElement, plate, hplate,
  ellipsoid, rod, blade, wheelVisual, cylinderZ, applyColors, mergeGeoms, carbonMaterial,
} from './builders.js';
import { liveryMaterial } from './livery.js';

export const CAT = { BODY: 1, FLOOR: 2, FRONT: 3, REAR: 4, WHEEL0: 5 };

const PRIO = { body: 1, floor: 3, front: 5, rear: 5, wheel: 9 };

function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
}
// Section « mesa » : pavillon plat de demi-largeur wTop qui retombe jusqu'à wBase.
function mesa(z, wTop, wBase, base, top, k = 0.35) {
  const lin = (wBase - Math.abs(z)) / Math.max(wBase - wTop, 1e-3);
  if (lin <= 0) return -Infinity;
  return base + (top - base) * smin(lin, 1, k);
}
const both = (fn) => [fn(1), fn(-1)];
const sym = (pts) => pts.map(([x, y, z]) => [x, y, -z]);

// Assemblage commun : carrosserie suspendue (hauteurs de caisse) + roues au sol.
function assemble({ id, name, short, parts, visuals = [], wheels, dims, rideNominal, ride, catNames, wheelStyle, aero = null }) {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  // transformation de caisse : translation + tangage autour de l'essieu avant
  const dF = ride.front - rideNominal.front, dR = ride.rear - rideNominal.rear;
  const theta = Math.atan2(dR - dF, dims.xR - dims.xF);
  const M = new THREE.Matrix4()
    .makeTranslation(dims.xF, dF, 0)
    .multiply(new THREE.Matrix4().makeRotationZ(theta))
    .multiply(new THREE.Matrix4().makeTranslation(-dims.xF, 0, 0));
  body.matrixAutoUpdate = false;
  body.matrix.copy(M);

  const fallback = carbonMaterial({ vertexColors: true });
  const solids = [];
  for (const p of parts) {
    const mesh = new THREE.Mesh(p.geometry, p.material || fallback);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.cat = p.cat;
    body.add(mesh);
    if (p.solid !== false) {
      solids.push({ geometry: p.voxel || p.geometry, matrix: M.clone(), cat: p.cat, thin: !!p.thin, priority: p.priority ?? PRIO.body, noSection: !!p.noSection, actuator: !!p.actuator, detail: !!p.detail });
    }
  }
  for (const v of visuals) {
    v.castShadow = true;
    body.add(v);
  }
  const wheelGroups = [];
  wheels.forEach((w, i) => {
    const wg = wheelVisual({ R: w.R, B: w.B, rimR: w.rimR, inner: -Math.sign(w.c[2]), ...wheelStyle });
    wg.position.set(...w.c);
    group.add(wg);
    wheelGroups.push(wg);
    solids.push({ geometry: cylinderZ(w.R, w.B, w.c[0], w.c[1], w.c[2]), matrix: null, cat: CAT.WHEEL0 + i, thin: false, priority: PRIO.wheel });
  });
  group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  dims.ground = Math.min(ride.front, ride.rear);
  return { id, name, short, group, body, solids, wheels, wheelGroups, dims, catNames, bodyMatrix: M, aero };
}

const tableSection = (t, nu, nl) => (x) => {
  const yb = t.yb(x), yt = t.yt(x);
  return { zc: t.zc ? t.zc(x) : 0, cy: (yb + yt) / 2, hw: t.hw(x), hu: (yt - yb) / 2, hl: (yt - yb) / 2, nu, nl };
};

// ============================================================================
// FORMULE 1 — règlement technique FIA 2026
//   empattement 3 400 mm (maxi), largeur hors-tout 1 900 mm, hauteur 950 mm,
//   pneus 18" : AV 280 mm × Ø 705, AR 375 mm × Ø 710,
//   aileron avant plus étroit (1 800 mm) et aileron arrière à deux éléments, tous deux mobiles
//   (mode virage / mode ligne droite), plus de « beam wing », fond plus plat à tunnels réduits.
// ============================================================================
export function buildF1(P = {}) {
  const fw = P.frontWing ?? 0;
  const rw = P.rearWing ?? 0;
  const straight = P.activeAero === 'X';
  const xF = 0.98, xR = 4.38;
  const Rf = 0.3525, Rr = 0.355, Bf = 0.28, Br = 0.375;
  const zF = 0.95 - Bf / 2, zR = 0.95 - Br / 2;
  const h0 = 0.03;
  const ss = smoothstep;

  // ---------- fond plat (tunnels réduits 2026), plancher, bord de fond, ailettes ----------
  const Wf = curve([[1.45, 0.42], [1.62, 0.74], [3.55, 0.75], [3.85, 0.66], [4.0, 0.555], [4.62, 0.53]]);
  const tun = curve([[1.45, 0.15], [1.75, 0.1], [2.3, 0.05], [2.9, 0.035], [3.5, 0.05], [4.0, 0.12], [4.62, 0.21]]);
  const cen = curve([[3.8, 0], [4.2, 0.05], [4.62, 0.13]]);
  const floorBot = (x, z) => {
    const a = Math.abs(z);
    const b = h0 + cen(x) + (tun(x) - cen(x)) * ss(0.12, 0.2, a);
    return b + (h0 + 0.02 - b) * ss(0.6, 0.7, a);
  };
  const floorMain = loftGeometry((x) => ({ W: Wf(x), top: (z) => floorBot(x, z) + 0.02, bot: (z) => floorBot(x, z), rt: 0.006, rb: 0.006 }),
    stations(1.45, 4.62, 80), { nTop: 52, nSide: 3 });
  const floorParts = [];
  for (const s of [1, -1]) {
    floorParts.push(hplate([[2.0, s * 0.725], [3.5, s * 0.725], [3.55, s * 0.775], [2.05, s * 0.78]], h0 + 0.045, 0.008));
    floorParts.push(plate([[1.75, h0 + 0.02], [3.5, h0 + 0.02], [3.5, h0 + 0.06], [1.9, h0 + 0.075]], s * 0.752, 0.008)); // volute de bord de fond
    for (const zf of [0.24, 0.33, 0.42]) floorParts.push(plate([[1.45, h0 + 0.02], [1.92, h0 + 0.02], [2.12, h0 + 0.07], [1.96, 0.21], [1.5, 0.18]], s * zf, 0.008));
    for (const zd of [0.22, 0.42]) floorParts.push(plate([[3.95, h0 + 0.1], [4.62, h0 + 0.22], [4.62, h0 + 0.07], [4.1, h0 + 0.045]], s * zd, 0.008));
  }

  // ---------- coque ----------
  const nose = superLoft(tableSection({
    yb: curve([[0.05, 0.2], [0.1, 0.188], [0.35, 0.192], [0.65, 0.215], [0.9, 0.25], [1.02, 0.27]]),
    yt: curve([[0.05, 0.222], [0.1, 0.238], [0.35, 0.28], [0.65, 0.345], [0.9, 0.43], [1.02, 0.47]]),
    hw: curve([[0.05, 0.01], [0.1, 0.04], [0.3, 0.064], [0.6, 0.09], [0.85, 0.118], [1.02, 0.14]]),
  }, 2.3, 2.8), stations(0.05, 1.02, 40));
  const chassis = superLoft(tableSection({
    yb: curve([[0.95, 0.26], [1.12, 0.17], [1.32, 0.1], [1.5, 0.058], [2.45, 0.058]]),
    yt: curve([[0.95, 0.48], [1.15, 0.555], [1.45, 0.62], [1.72, 0.655], [2.45, 0.665]]),
    hw: curve([[0.95, 0.15], [1.15, 0.2], [1.45, 0.24], [1.72, 0.265], [2.0, 0.28], [2.45, 0.285]]),
  }, 3.2, 1.7), stations(0.95, 2.45, 34));
  const cover = superLoft(tableSection({
    yb: curve([[2.3, 0.058], [3.85, 0.058], [4.15, 0.12], [4.45, 0.2]]),
    yt: curve([[2.3, 0.665], [2.75, 0.635], [3.25, 0.56], [3.75, 0.47], [4.15, 0.4], [4.45, 0.35]]),
    hw: curve([[2.3, 0.285], [2.75, 0.255], [3.25, 0.2], [3.75, 0.14], [4.15, 0.1], [4.45, 0.08]]),
  }, 2.3, 1.7), stations(2.3, 4.45, 40));
  const airbox = superLoft(tableSection({
    yb: () => 0.5,
    yt: curve([[2.3, 0.665], [2.4, 0.85], [2.5, 0.94], [2.68, 0.95], [2.95, 0.885], [3.3, 0.77], [3.85, 0.6]]),
    hw: curve([[2.3, 0.12], [2.42, 0.118], [2.68, 0.108], [2.95, 0.082], [3.3, 0.05], [3.85, 0.018]]),
  }, 2.6, 2.0), stations(2.3, 3.85, 34));
  const gearbox = superLoft(tableSection({
    yb: curve([[4.3, 0.16], [4.6, 0.21], [5.14, 0.26]]),
    yt: curve([[4.3, 0.4], [4.6, 0.375], [5.14, 0.33]]),
    hw: curve([[4.3, 0.105], [4.6, 0.085], [5.0, 0.055], [5.14, 0.032]]),
  }, 2.4, 2.4), stations(4.3, 5.14, 18));
  const spT = {
    zc: curve([[1.86, 0.5], [2.0, 0.505], [2.5, 0.485], [3.0, 0.42], [3.5, 0.32], [3.9, 0.235], [4.18, 0.16]]),
    hw: curve([[1.86, 0.17], [1.98, 0.205], [2.5, 0.205], [3.0, 0.18], [3.5, 0.135], [3.9, 0.09], [4.18, 0.05]]),
    yb: curve([[1.86, 0.38], [2.0, 0.35], [2.45, 0.26], [2.9, 0.17], [3.4, 0.11], [3.9, 0.08], [4.18, 0.08]]),
    yt: curve([[1.86, 0.575], [2.0, 0.605], [2.45, 0.59], [2.9, 0.52], [3.4, 0.43], [3.9, 0.36], [4.18, 0.32]]),
  };
  const sidepods = both((s) => superLoft((x) => {
    const t = tableSection(spT, 6, 3)(x);
    t.zc *= s;
    return t;
  }, stations(1.86, 4.18, 44)));
  const fin = plate([[3.05, 0.86], [4.55, 0.62], [4.66, 0.62], [4.62, 0.74], [3.6, 0.84]], 0, 0.01);
  // formes « calcul » des pontons et de la boîte à air : nez arrondi à la place des bouches
  // (le débit de refroidissement n'étant pas modélisé, une entrée plate décollerait l'écoulement)
  const spProxy = both((s) => superLoft((x) => {
    const t = tableSection(spT, 6, 3)(Math.max(x, 1.86));
    const r = Math.sqrt(Math.max(0, Math.min(1, (x - 1.66) / 0.32)));
    const mid = (2 * t.cy + t.hu - t.hl) / 2;
    return { zc: s * t.zc, cy: mid + (t.cy - mid) * r, hw: Math.max(0.01, t.hw * r), hu: Math.max(0.01, t.hu * r), hl: Math.max(0.01, t.hl * r), nu: t.nu, nl: t.nl };
  }, stations(1.66, 4.18, 44)));
  const airboxProxy = superLoft((x) => {
    const t = tableSection({
      yb: () => 0.5,
      yt: curve([[2.3, 0.665], [2.4, 0.85], [2.5, 0.94], [2.68, 0.95], [2.95, 0.885], [3.3, 0.77], [3.85, 0.6]]),
      hw: curve([[2.3, 0.12], [2.42, 0.118], [2.68, 0.108], [2.95, 0.082], [3.3, 0.05], [3.85, 0.018]]),
    }, 2.6, 2.0)(x);
    const r = Math.sqrt(Math.max(0.05, Math.min(1, (x - 2.18) / 0.3)));
    return { ...t, hw: t.hw * r, hu: t.hu * r };
  }, stations(2.18, 3.85, 30));

  // ---------- aileron avant 1 800 mm : plan principal + 2 volets actifs, bords relevés ----------
  const inner = (z) => 1 - ss(0.17, 0.38, Math.abs(z));
  const tipF = (z) => ss(0.62, 0.88, Math.abs(z));
  const mainplane = wingElement({
    chord: (z) => 0.31 - 0.05 * inner(z) + 0.02 * tipF(z), x: (z) => 0.03 * inner(z) - 0.02 * tipF(z),
    y: (z) => 0.08 + 0.085 * inner(z) + 0.015 * tipF(z), aoa: (z) => (2.5 + fw * 0.5) * (1 - inner(z)) + inner(z), m: 0.05, p: 0.4, t: 0.09,
  }, -0.9, 0.9, { nSpan: 36 });
  const flapDefs = [
    { chord: (z) => 0.13 + 0.04 * ss(0.25, 0.7, Math.abs(z)), x: (z) => 0.275 - 0.03 * tipF(z), y: (z) => 0.112 + 0.03 * tipF(z) + 0.02 * (1 - ss(0.3, 0.55, Math.abs(z))), aoa: (z) => (straight ? 5 : 16) + fw * 1.3 + 6 * tipF(z), m: 0.06, p: 0.4, t: 0.1, z: [0.22, 0.885], accent: false },
    { chord: (z) => 0.105 + 0.035 * ss(0.3, 0.7, Math.abs(z)), x: (z) => 0.41 - 0.04 * tipF(z), y: (z) => 0.172 + 0.06 * tipF(z), aoa: (z) => (straight ? 12 : 30) + fw * 1.6 + 8 * tipF(z), m: 0.06, p: 0.4, t: 0.1, z: [0.27, 0.885], accent: true },
  ];
  const fwGeoms = [applyColors(mainplane, () => '#202329')];
  for (const el of flapDefs) for (const s of [1, -1]) {
    const g = wingElement(el, s > 0 ? el.z[0] : -el.z[1], s > 0 ? el.z[1] : -el.z[0], { nSpan: 16 });
    // liseré jaune fluo au bord de fuite du volet supérieur
    fwGeoms.push(applyColors(g, (x, y, z) => (el.accent && x > el.x(z) + 0.75 * el.chord(z) ? '#e4ff3c' : '#202329')));
  }
  for (const s of [1, -1]) fwGeoms.push(applyColors(hplate([[0.0, s * 0.86], [0.62, s * 0.86], [0.64, s * 0.95], [0.02, s * 0.94]], 0.03, 0.008), () => '#202329'));
  const fwG = mergeGeoms(fwGeoms);
  const fwEnds = mergeGeoms(both((s) => plate([[-0.03, 0.035], [0.56, 0.035], [0.66, 0.08], [0.66, 0.22], [0.58, 0.33], [0.38, 0.345], [0.16, 0.27], [0.0, 0.17], [-0.04, 0.08]], s * 0.895, 0.012)));

  // ---------- aileron arrière : 2 éléments actifs en cuillère, bouts arrondis, sans beam wing ----------
  const cR = (z) => 1 - ss(0, 0.4, Math.abs(z));
  const tipR = (z) => ss(0.36, 0.48, Math.abs(z));
  const rwG = mergeGeoms([
    applyColors(wingElement({ chord: (z) => 0.28 + 0.03 * cR(z), x: (z) => 4.68 - 0.02 * cR(z), y: (z) => 0.785 - 0.03 * cR(z) + 0.045 * tipR(z), aoa: (straight ? 3 : 10) + rw, m: 0.07, p: 0.4, t: 0.11 }, -0.475, 0.475, { nSpan: 24 }), () => '#202329'),
    applyColors(wingElement({ chord: (z) => 0.2 + 0.02 * cR(z), x: 4.93, y: (z) => 0.86 - 0.02 * cR(z) + 0.035 * tipR(z), aoa: (straight ? 7 : 36) + rw * 1.3, m: 0.07, p: 0.4, t: 0.1 }, -0.475, 0.475, { nSpan: 24 }),
      (x, y) => (x > 5.06 && y > 0.94 ? '#1e88ff' : '#202329')),
  ]);
  const rwEnds = mergeGeoms(both((s) => plate([[4.62, 0.6], [5.04, 0.6], [5.2, 0.72], [5.21, 0.96], [5.0, 0.985], [4.7, 0.975], [4.6, 0.83]], s * 0.487, 0.012)));
  const pylonG = applyColors(plate([[4.8, 0.36], [4.97, 0.36], [4.99, 0.8], [4.85, 0.79]], 0, 0.02), () => '#202329');

  // ---------- livrée (peinture satinée + carbone + décalques) ----------
  const bodyMat = liveryMaterial({
    palette: ['#0c1830', '#1e88ff', '#f3f6fa', '#050607', '#1a1c21', '#ff2a2a', '#e4ff3c', '#8a99ad'],
    decals: ['AÉROLAB', '26', 'VENTURI', 'SOUFFLERIE'],
    base: { metalness: 0.3, roughness: 0.42, clearcoat: 0.55, clearcoatRoughness: 0.28 },
    glsl: `vec3 livery(vec3 p, vec3 n) {
  float a = abs(p.z);
  float side = n.z >= 0.0 ? 1.0 : -1.0; // sens de lecture selon la face vue
  // plaques d'extrémité d'aileron avant : bleu électrique + inscription
  if (p.x < 0.75 && a > 0.88) {
    float u = (p.x - 0.06) / 0.52;
    if (decal(0.0, vec2(side > 0.0 ? u : 1.0 - u, (p.y - 0.12) / 0.13)) > 0.5) return uPal[2];
    if (p.y < 0.07) { gR = 0.4; return uPal[4] * weave(p, n); }
    return uPal[1];
  }
  // dérives d'aileron arrière : bleu nuit + inscription + filet fluo
  if (p.x > 4.55 && a > 0.47 && p.y > 0.55) {
    float u = (p.x - 4.66) / 0.5;
    if (decal(2.0, vec2(side > 0.0 ? u : 1.0 - u, (p.y - 0.79) / 0.13)) > 0.5) return uPal[2];
    if (lineMask(p.y - 0.735, 0.01) > 0.5) return uPal[6];
    return uPal[0];
  }
  float wl = 0.17 + 0.05 * smoothstep(1.2, 2.2, p.x);
  if (p.y < wl || n.y < -0.55) { gR = 0.42; gM = 0.2; return uPal[4] * weave(p, n); }
  // ouvertures : cockpit, prise d'air, bouches de pontons, ouïes latérales, sortie de refroidissement
  if (p.x > 1.8 && p.x < 2.36 && a < 0.2 && n.y > 0.55 && p.y > 0.6) { gR = 0.95; gM = 0.0; return uPal[3]; }
  if (p.x < 2.43 && p.x > 2.2 && p.y > 0.72 && n.x < -0.3) { gR = 0.95; gM = 0.0; return uPal[3]; }
  if (p.x < 1.9 && a > 0.31 && n.x < -0.45) { gR = 0.95; gM = 0.0; return uPal[3]; }
  if (p.x > 2.46 && p.x < 2.62 && p.y > 0.7 && p.y < 0.8 && abs(n.z) > 0.6) { gR = 0.95; return uPal[3]; }
  if (p.x > 4.25 && p.x < 4.45 && p.y > 0.3 && n.x > 0.4) { gR = 0.95; return uPal[3]; }
  if (p.x > 5.08) { gR = 0.2; return uPal[5]; }
  // numéro sur le nez (lisible de face)
  if (n.y > 0.55 && p.x > 0.34 && p.x < 0.62 && a < 0.08) {
    if (decal(1.0, vec2((p.z + 0.075) / 0.15, (p.x - 0.34) / 0.28)) > 0.5) return uPal[2];
  }
  // numéro sur les flancs du capot, inscription sur les pontons
  if (abs(n.z) > 0.4 && a < 0.3 && p.x > 2.72 && p.x < 3.08 && p.y > 0.55) {
    float u = (p.x - 2.72) / 0.36;
    if (decal(1.0, vec2(side > 0.0 ? u : 1.0 - u, (p.y - 0.555) / 0.1)) > 0.5) return uPal[6];
  }
  if (abs(n.z) > 0.55 && a > 0.5 && p.x > 2.0 && p.x < 2.72) {
    float u = (p.x - 2.0) / 0.72;
    if (decal(3.0, vec2(side > 0.0 ? u : 1.0 - u, (p.y - 0.385) / 0.09)) > 0.5) return uPal[2];
  }
  // composition : nez bleu, flèche bleue sur les pontons avec filet blanc, arête blanche
  if (p.x < 0.5) return uPal[1];
  float sweep = 0.355 + 0.085 * (p.x - 1.85);
  if (p.x > 1.8 && a > 0.29 && lineMask(p.y - sweep, 0.011) > 0.5) return uPal[2];
  if (p.x > 1.8 && a > 0.29 && p.y < sweep) return uPal[1];
  if (a < 0.03 && n.y > 0.4 && p.x < 2.3) return uPal[2];
  if (p.x > 2.3 && p.y > 0.8) return uPal[1];
  if (p.x > 3.7 && p.y > 0.25) return mix(uPal[0], uPal[1], 0.7);
  return uPal[0];
}`,
  });

  // ---------- pilote, cockpit, rétroviseurs ----------
  const helmet = applyColors(ellipsoid(2.1, 0.735, 0, 0.15, 0.13, 0.12, 28), (x, y, z) => (x < 2.03 && y > 0.7 && y < 0.79 ? '#0a0a0a' : Math.abs(z) < 0.03 && y > 0.75 ? '#1e88ff' : y > 0.82 ? '#e4ff3c' : '#f4f6f8'));
  const pads = mergeGeoms(both((s) => superLoft(() => ({ zc: s * 0.14, cy: 0.665, hw: 0.04, hu: 0.032, hl: 0.03, nu: 2.5, nl: 2.5 }), stations(2.06, 2.38, 6))));
  const mirrors = [];
  for (const s of [1, -1]) {
    mirrors.push(superLoft((x) => ({ zc: s * 0.5, cy: 0.69, hw: 0.11 * Math.sqrt(Math.max(0, 1 - ((x - 1.96) / 0.06) ** 2)) + 0.002, hu: 0.035, hl: 0.03, nu: 3, nl: 3 }), stations(1.9, 2.02, 8)));
    mirrors.push(blade([1.98, 0.6, s * 0.42], [1.97, 0.67, s * 0.47], 0.05, 0.012));
    mirrors.push(blade([1.97, 0.69, s * 0.39], [1.97, 0.69, s * 0.41], 0.04, 0.012));
  }
  const mirrorG = applyColors(mergeGeoms(mirrors), (x, y, z, nx) => (nx > 0.6 ? '#c9d4df' : '#0c1830'));

  // ---------- éléments visuels (sous la résolution de la grille) ----------
  const susp = [];
  for (const s of [1, -1]) {
    const uF = [xF + 0.01, 0.47, s * (zF - 0.11)], lF = [xF, 0.2, s * (zF - 0.12)];
    susp.push(blade([xF - 0.22, 0.47, s * 0.18], uF, 0.06, 0.016), blade([xF + 0.24, 0.49, s * 0.2], uF, 0.06, 0.016));
    susp.push(blade([xF - 0.26, 0.24, s * 0.14], lF, 0.06, 0.016), blade([xF + 0.3, 0.26, s * 0.16], lF, 0.06, 0.016));
    susp.push(blade([xF + 0.02, 0.21, s * (zF - 0.13)], [xF + 0.12, 0.5, s * 0.2], 0.04, 0.014));
    susp.push(blade([xF + 0.08, 0.33, s * 0.22], [xF + 0.09, 0.33, s * (zF - 0.12)], 0.035, 0.012));
    const uR = [xR, 0.46, s * (zR - 0.15)], lR = [xR, 0.19, s * (zR - 0.15)];
    susp.push(blade([xR - 0.32, 0.45, s * 0.12], uR, 0.06, 0.016), blade([xR + 0.1, 0.45, s * 0.11], uR, 0.06, 0.016));
    susp.push(blade([xR - 0.35, 0.2, s * 0.12], lR, 0.06, 0.016), blade([xR + 0.12, 0.22, s * 0.1], lR, 0.06, 0.016));
    susp.push(blade([xR + 0.05, 0.42, s * 0.12], [xR + 0.04, 0.22, s * (zR - 0.16)], 0.04, 0.014));
    susp.push(rod([xR, 0.33, s * 0.12], [xR, 0.33, s * (zR - 0.15)], 0.022, 10));
    // ailettes d'écope de frein au-dessus des moyeux
    susp.push(blade([xF - 0.12, 0.5, s * (zF - 0.13)], [xF + 0.14, 0.5, s * (zF - 0.13)], 0.05, 0.008));
  }
  const visuals = [new THREE.Mesh(mergeGeoms(susp), carbonMaterial({ color: 0x17191d }))];
  const haloMat = new THREE.MeshPhysicalMaterial({ color: 0x0c1830, metalness: 0.3, roughness: 0.42, clearcoat: 0.55, clearcoatRoughness: 0.28 });
  const haloPts = (s) => [
    new THREE.Vector3(1.93, 0.865, 0), new THREE.Vector3(2.1, 0.87, s * 0.17), new THREE.Vector3(2.32, 0.845, s * 0.235),
    new THREE.Vector3(2.43, 0.74, s * 0.25), new THREE.Vector3(2.45, 0.665, s * 0.25),
  ];
  for (const s of [1, -1]) visuals.push(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(haloPts(s)), 40, 0.027, 12), haloMat));
  visuals.push(new THREE.Mesh(blade([1.74, 0.665, 0], [1.94, 0.87, 0], 0.06, 0.03), haloMat));
  const wheelS = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.12, 0.26), new THREE.MeshPhysicalMaterial({ color: 0x15171a, roughness: 0.5 }));
  wheelS.position.set(1.93, 0.62, 0);
  wheelS.rotation.z = -0.35;
  visuals.push(wheelS);
  visuals.push(new THREE.Mesh(pads, new THREE.MeshPhysicalMaterial({ color: 0x2b3a52, roughness: 0.9 })));
  const tcam = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.022, 0.07), new THREE.MeshPhysicalMaterial({ color: 0xe4ff3c, roughness: 0.4 }));
  tcam.position.set(2.56, 0.962, 0);
  visuals.push(tcam);
  for (const s of [1, -1]) {
    const light = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.18, 0.012), new THREE.MeshBasicMaterial({ color: 0xff2020 }));
    light.position.set(5.21, 0.85, s * 0.494);
    visuals.push(light);
  }
  const actuator = new THREE.Mesh(ellipsoid(4.99, 0.93, 0, 0.06, 0.028, 0.022, 12), new THREE.MeshPhysicalMaterial({ color: 0x1e88ff, roughness: 0.4, clearcoat: 0.6 }));
  visuals.push(actuator);

  const carbonV = carbonMaterial({ vertexColors: true, color: 0xffffff });
  const parts = [
    ...[nose, chassis, cover, gearbox].map((g) => ({ geometry: g, material: bodyMat, cat: CAT.BODY, priority: PRIO.body })),
    { geometry: airbox, voxel: airboxProxy, material: bodyMat, cat: CAT.BODY, priority: PRIO.body },
    ...sidepods.map((g, i) => ({ geometry: g, voxel: spProxy[i], material: bodyMat, cat: CAT.BODY, priority: PRIO.body })),
    { geometry: fin, material: bodyMat, cat: CAT.BODY, thin: true, priority: PRIO.body, noSection: true },
    { geometry: pylonG, material: carbonV, cat: CAT.REAR, thin: true, priority: PRIO.rear, noSection: true },
    { geometry: floorMain, material: carbonMaterial({ color: 0x1b1d22 }), cat: CAT.FLOOR, thin: true, priority: PRIO.floor },
    { geometry: mergeGeoms(floorParts), material: carbonMaterial({ color: 0x1b1d22 }), cat: CAT.FLOOR, thin: true, priority: PRIO.floor, detail: true },
    { geometry: fwG, material: carbonV, cat: CAT.FRONT, thin: true, priority: PRIO.front, actuator: true },
    { geometry: fwEnds, material: bodyMat, cat: CAT.FRONT, thin: true, priority: PRIO.front },
    { geometry: rwG, material: carbonV, cat: CAT.REAR, thin: true, priority: PRIO.rear, actuator: true },
    { geometry: rwEnds, material: bodyMat, cat: CAT.REAR, thin: true, priority: PRIO.rear },
    { geometry: helmet, material: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.25, clearcoat: 1 }), cat: CAT.BODY, priority: PRIO.body + 1 },
    { geometry: mirrorG, material: new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: 0.5, roughness: 0.3, clearcoat: 0.6 }), cat: CAT.BODY, thin: true, priority: PRIO.body + 1, detail: true },
  ];
  const wheels = [
    { c: [xF, Rf, zF], R: Rf, B: Bf, rimR: 0.229 },
    { c: [xF, Rf, -zF], R: Rf, B: Bf, rimR: 0.229 },
    { c: [xR, Rr, zR], R: Rr, B: Br, rimR: 0.229 },
    { c: [xR, Rr, -zR], R: Rr, B: Br, rimR: 0.229 },
  ];
  return assemble({
    id: 'f1', name: 'Formule 1 (2026)', short: 'F1', parts, visuals, wheels,
    dims: { L: 5.24, W: 1.9, H: 0.95, wheelbase: xR - xF, xF, xR, x0: -0.04, x1: 5.22, mass: 768 },
    rideNominal: { front: h0, rear: h0 },
    ride: { front: (P.rideF ?? 35) / 1000, rear: (P.rideR ?? 75) / 1000 },
    catNames: { 1: 'Carrosserie', 2: 'Fond plat & diffuseur', 3: 'Aileron avant', 4: 'Aileron arrière' },
    wheelStyle: { style: 'f1', rimColor: 0x16181b, compound: 0xf7c600 },
    // modèle de profil des ailerons (3D) : polaires d'ailes multi-éléments, incidence de réglage
    aero: [
      { cat: CAT.FRONT, box: { x0: -0.05, x1: 0.62, y0: 0.05, y1: 0.34, z0: 0.24, z1: 0.88 }, segs: 4, chord: 0.55, xLE: 0.0, yRef: 0.17, AR: 3.3,
        Cl0: straight ? 0.8 : 1.8, Clmax: 2.7, slope: 0.07, dAlpha: 1.2 * fw, Cd0: straight ? 0.05 : 0.09, k: 0.02 },
      { cat: CAT.REAR, box: { x0: 4.62, x1: 5.2, y0: 0.72, y1: 0.99, z0: 0.0, z1: 0.475 }, segs: 3, chord: 0.48, xLE: 4.66, yRef: 0.84, AR: 2.0,
        Cl0: straight ? 0.55 : 2.0, Clmax: 2.7, slope: 0.07, dAlpha: 1.15 * rw, Cd0: straight ? 0.05 : 0.12, k: 0.015 },
    ],
  });
}

// ============================================================================
// HYPERCAR — prototype d'endurance LMH (L 4,95 m, l 2,00 m, h 1,06 m, empattement 3,10 m)
// ============================================================================
export function buildHypercar(P = {}) {
  const rw = P.rearWing ?? 0;
  const canards = P.canards ?? true;
  const xF = 1.0, xR = 4.1, R = 0.355, Bf = 0.29, Br = 0.34;
  const zF = 0.83, zR = 0.81;
  const h0 = 0.05;

  // fond plat pleine largeur, rétréci au droit des roues, diffuseur entre les roues arrière
  const Wf = curve([[0.3, 0.75], [0.5, 0.6], [1.42, 0.6], [1.6, 0.95], [3.55, 0.95], [3.7, 0.59], [4.55, 0.59], [4.72, 0.9], [4.95, 0.92]]);
  const diff = curve([[3.6, 0], [4.2, 0.1], [4.95, 0.27]]);
  const floorBot = (x, z) => h0 + (x > 3.6 ? diff(x) * (1 - smoothstep(0.5, 0.6, Math.abs(z))) : 0);
  const floorTop = (x, z) => (x < 0.3 || x > 4.95 || Math.abs(z) > Wf(x) ? -Infinity : floorBot(x, z) + 0.025);
  const floorMain = loftGeometry((x) => ({ W: Wf(x), top: (z) => floorBot(x, z) + 0.025, bot: (z) => floorBot(x, z), rt: 0.008, rb: 0.008 }),
    stations(0.3, 4.95, 70, [1.42, 1.6, 3.55, 3.7, 4.55, 4.72]), { nTop: 40, nSide: 3 });
  const floorParts = [];
  for (const s of [1, -1]) for (const zd of [0.18, 0.38]) floorParts.push(plate([[3.75, h0 + 0.025], [4.95, h0 + 0.27], [4.95, h0 + 0.05], [3.9, h0 + 0.025]], s * zd, 0.01));

  // carrosserie : taille de guêpe entre les ailes avant et arrière (signature LMH)
  const W = curve([[0.04, 0.8], [0.15, 0.92], [0.35, 0.97], [0.7, 1.0], [1.35, 1.0], [1.62, 0.93], [1.95, 0.8], [2.9, 0.78], [3.3, 0.86], [3.6, 0.98], [4.6, 1.0], [4.95, 0.98]]);
  const D = curve([[0.04, 0.17], [0.15, 0.25], [0.4, 0.36], [0.8, 0.45], [1.3, 0.5], [1.6, 0.52], [2.4, 0.56], [3.2, 0.64], [3.8, 0.7], [4.4, 0.76], [4.95, 0.8]]);
  const F = curve([[0.08, 0.22], [0.35, 0.52], [0.7, 0.76], [1.0, 0.85], [1.3, 0.82], [1.6, 0.68], [2.0, 0.56], [2.6, 0.58], [3.2, 0.72], [3.7, 0.85], [4.1, 0.9], [4.5, 0.88], [4.95, 0.84]]);
  const FZ = curve([[0.1, 0.72], [1.0, 0.8], [1.8, 0.74], [2.9, 0.72], [3.6, 0.8], [4.95, 0.8]]);
  const FW = curve([[0.1, 0.18], [0.5, 0.26], [1.0, 0.28], [1.6, 0.25], [2.5, 0.22], [3.6, 0.28], [4.1, 0.3], [4.95, 0.28]]);
  const Cn = curve([[1.35, 0.5], [1.6, 0.7], [1.9, 0.92], [2.2, 1.03], [2.5, 1.06], [2.85, 1.02], [3.2, 0.9], [3.6, 0.78], [4.0, 0.72]]);
  const CW = curve([[1.35, 0.3], [1.7, 0.5], [2.2, 0.58], [2.8, 0.55], [3.3, 0.38], [3.8, 0.22], [4.0, 0.15]]);
  const baseBot = curve([[0.04, 0.1], [0.3, h0 + 0.03], [4.95, h0 + 0.03]]);
  const Ra = 0.42;
  const well = (x, z, b) => {
    for (const [xa, B, zw] of [[xF, Bf, zF], [xR, Br, zR]]) {
      const dx = x - xa;
      if (Math.abs(dx) < Ra) {
        const arch = R + Math.sqrt(Ra * Ra - dx * dx) * 0.98;
        const zin = zw - B / 2 - 0.05;
        const t = smoothstep(zin - 0.04, zin, Math.abs(z));
        b = b + (Math.max(b, arch) - b) * t;
      }
    }
    return b;
  };
  const section = (x) => ({
    W: W(x),
    top: (z) => {
      let t = D(x) - 0.04 * (z / W(x)) ** 2;
      if (x > 0.1) t = smax(t, dome(Math.abs(z), FZ(x), FW(x), D(x) - 0.05, F(x), 2.4), 0.07);
      if (x > 1.35 && x < 4.0) t = smax(t, dome(z, 0, CW(x), D(x) - 0.02, Cn(x), 2.4), 0.07);
      return t;
    },
    bot: (z) => {
      let b = baseBot(x);
      const ft = floorTop(x, z);
      if (isFinite(ft)) b = Math.max(b, ft + 0.002);
      return well(x, z, b);
    },
    rt: x < 0.3 ? 0.06 : 0.08,
    rb: 0.04,
    bulge: 0.012,
  });
  const bodyG = loftGeometry(section, stations(0.04, 4.95, 140, [xF - Ra, xF + Ra, xR - Ra, xR + Ra, 1.35, 1.62, 1.95, 2.9, 3.3, 4.0]), { nTop: 64, nSide: 7 });
  const bodyMat = liveryMaterial({
    curves: [D, (x) => (x > 1.35 && x < 4.0 ? Cn(x) : 0), (x) => (x > 1.35 && x < 4.0 ? CW(x) : 0), F], x0: 0, x1: 5,
    palette: ['#f1f3f6', '#16181c', '#090c11', '#00a99d', '#eaf6ff', '#e0141d', '#202329'],
    decals: ['12', 'AÉROLAB', 'ENDURANCE', 'VENTURI'],
    glsl: `vec3 livery(vec3 p, vec3 n) {
  vec4 c = cv(p.x);
  float side = n.z >= 0.0 ? 1.0 : -1.0;
  float a = abs(p.z);
  if (p.y < 0.19 || n.y < -0.5) { gR = 0.45; gM = 0.2; return uPal[1] * weave(p, n); }
  // verrière
  if (p.x > 1.42 && p.x < 2.42 && a < c.z - 0.07 && p.y > c.x + 0.09 && n.y < 0.985) { gR = 0.03; gM = 0.0; return uPal[2]; }
  if (p.x > 2.2 && p.x < 3.05 && p.y > c.x + 0.07 && p.y < c.y - 0.08 && a > 0.22 && n.y < 0.75) { gR = 0.03; gM = 0.0; return uPal[2]; }
  // rond de numéro, inscriptions sur les flancs, numéro sur le nez
  if (a > 0.7 && abs(n.z) > 0.4) {
    vec2 d = vec2(p.x - 3.42, p.y - 0.5);
    float r2 = dot(d, d);
    if (r2 < 0.0196) {
      float u = (p.x - 3.3) / 0.24;
      if (decal(0.0, vec2(side > 0.0 ? u : 1.0 - u, (p.y - 0.4) / 0.2)) > 0.5) return uPal[1];
      return r2 > 0.0165 ? uPal[1] : vec3(1.0);
    }
    if (p.x > 2.0 && p.x < 2.95 && p.y > 0.31 && p.y < 0.41) {
      float u = (p.x - 2.0) / 0.95;
      if (decal(2.0, vec2(side > 0.0 ? u : 1.0 - u, (p.y - 0.315) / 0.09)) > 0.5) return uPal[1];
    }
    if (p.x > 4.54 && p.x < 4.94 && p.y > 0.5 && p.y < 0.6) {
      float u = (p.x - 4.54) / 0.4;
      if (decal(1.0, vec2(side > 0.0 ? u : 1.0 - u, (p.y - 0.505) / 0.09)) > 0.5) return uPal[3];
    }
  }
  if (n.y > 0.6 && p.x > 0.5 && p.x < 0.9 && a < 0.12) {
    if (decal(0.0, vec2((p.z + 0.12) / 0.24, (p.x - 0.5) / 0.4)) > 0.5) return uPal[1];
  }
  // phares à LED (barres fines) et feux arrière pleine largeur
  if (p.x < 0.6 && a > 0.5 && a < 0.9 && n.x < -0.15 && p.y > c.w - 0.075 && p.y < c.w - 0.015) {
    float bar = lineMask(p.y - (c.w - 0.045), 0.006);
    if (bar > 0.5) { gR = 0.05; return uPal[4] * 1.6; }
    gR = 0.06; gM = 0.0; return uPal[2];
  }
  if (p.x > 4.88 && p.y > 0.6) { if (lineMask(p.y - 0.74, 0.012) > 0.5) { gR = 0.1; return uPal[5] * 1.4; } return uPal[1] * weave(p, n); }
  // persiennes sur les ailes et ouïes derrière les roues avant
  bool frontLouver = p.x > 0.92 && p.x < 1.32 && a > 0.62 && a < 0.95 && n.y > 0.55;
  bool rearLouver = p.x > 3.9 && p.x < 4.35 && a > 0.62 && a < 0.95 && n.y > 0.55;
  if ((frontLouver || rearLouver) && fract(p.x * 28.0) < 0.5) { gR = 0.6; gM = 0.0; return uPal[1]; }
  if (p.x > 1.36 && p.x < 1.7 && a > 0.84 && p.y > 0.3 && p.y < 0.72) { gR = 0.7; gM = 0.0; return uPal[1] * weave(p, n); }
  // déco : bandeau sarcelle, liseré noir, numéro de course (cercle blanc) sur l'aile arrière
  if (a > 0.95 && lineMask(p.y - 0.43 - 0.05 * sin(p.x * 1.2), 0.022) > 0.5) return uPal[3];
  if (a < 0.045 && n.y > 0.5) return uPal[3];
  if (p.y < 0.3 && a > 0.9) return uPal[6];
  // rond de numéro sur les flancs et sur le nez, inscriptions
  return uPal[0];
}`,
  });
  const scoop = superLoft(tableSection({ yb: () => 0.98, yt: curve([[2.55, 1.04], [2.7, 1.1], [3.15, 1.08]]), hw: curve([[2.55, 0.05], [2.7, 0.11], [3.15, 0.09]]) }, 3, 2), stations(2.55, 3.15, 10));

  // séparateur avant + canards
  const front = [hplate([[0.0, -0.78], [0.0, 0.78], [0.12, 0.88], [0.62, 0.88], [0.62, -0.88], [0.12, -0.88]], h0 + 0.004, 0.02)];
  if (canards) {
    for (const s of [-1, 1]) {
      for (const [y, x] of [[0.27, 0.26], [0.37, 0.33]]) {
        const z0 = s > 0 ? 0.88 : -0.995, z1 = s > 0 ? 0.995 : -0.88;
        front.push(wingElement({ chord: 0.16, x, y, aoa: 12, m: 0.06, t: 0.1 }, z0, z1, { nSpan: 3 }));
      }
    }
  }
  const frontG = applyColors(mergeGeoms(front), () => '#1d2025');

  // aileron arrière à cols de cygne + dérive réglementaire
  const rearG = applyColors(mergeGeoms([
    wingElement({ chord: 0.3, x: 4.42, y: 0.95, aoa: 7 + rw, m: 0.07, p: 0.4, t: 0.12 }, -0.9, 0.9, { nSpan: 16 }),
    wingElement({ chord: 0.15, x: 4.69, y: 1.005, aoa: 24 + rw * 1.2, m: 0.07, p: 0.4, t: 0.1 }, -0.9, 0.9, { nSpan: 16 }),
  ]), () => '#1d2025');
  const rearSup = [];
  for (const s of [-1, 1]) rearSup.push(plate([[4.35, 0.82], [4.95, 0.78], [4.96, 1.08], [4.45, 1.08]], s * 0.912, 0.014));
  for (const s of [-1, 1]) rearSup.push(plate([[4.48, 0.74], [4.6, 0.74], [4.64, 1.05], [4.5, 1.06], [4.55, 0.95]], s * 0.3, 0.016));
  const rearSupG = applyColors(mergeGeoms(rearSup), (x, y, z) => (Math.abs(z) > 0.9 ? '#00a99d' : '#1d2025'));
  const finG = applyColors(plate([[2.85, 1.0], [3.3, 0.86], [4.55, 0.76], [4.6, 0.98], [3.4, 1.03]], 0, 0.012), () => '#f1f3f6');
  const mirrors = [];
  for (const s of [1, -1]) {
    mirrors.push(ellipsoid(1.42, 0.9, s * 0.84, 0.09, 0.05, 0.11, 14));
    mirrors.push(blade([1.45, 0.8, s * 0.84], [1.43, 0.88, s * 0.84], 0.06, 0.015));
  }

  const parts = [
    { geometry: bodyG, material: bodyMat, cat: CAT.BODY, priority: PRIO.body },
    { geometry: scoop, material: bodyMat, cat: CAT.BODY, priority: PRIO.body },
    { geometry: applyColors(mergeGeoms(mirrors), () => '#16181c'), material: carbonMaterial({ vertexColors: true, color: 0xffffff }), cat: CAT.BODY, thin: true, priority: PRIO.body + 1 },
    { geometry: floorMain, material: carbonMaterial({ color: 0x1b1d22 }), cat: CAT.FLOOR, thin: true, priority: PRIO.floor },
    { geometry: mergeGeoms(floorParts), material: carbonMaterial({ color: 0x1b1d22 }), cat: CAT.FLOOR, thin: true, priority: PRIO.floor, detail: true },
    { geometry: frontG, material: carbonMaterial({ vertexColors: true, color: 0xffffff }), cat: CAT.FRONT, thin: true, priority: PRIO.front },
    { geometry: rearG, material: carbonMaterial({ vertexColors: true, color: 0xffffff }), cat: CAT.REAR, thin: true, priority: PRIO.rear, actuator: true },
    { geometry: rearSupG, material: carbonMaterial({ vertexColors: true, color: 0xffffff }), cat: CAT.REAR, thin: true, priority: PRIO.rear },
    { geometry: finG, material: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.3, clearcoat: 1 }), cat: CAT.BODY, thin: true, priority: PRIO.body + 1, noSection: true },
  ];
  const wheels = [
    { c: [xF, R, zF], R, B: Bf, rimR: 0.229 },
    { c: [xF, R, -zF], R, B: Bf, rimR: 0.229 },
    { c: [xR, R, zR], R, B: Br, rimR: 0.229 },
    { c: [xR, R, -zR], R, B: Br, rimR: 0.229 },
  ];
  return assemble({
    id: 'hyper', name: 'Hypercar', short: 'LMH', parts, wheels,
    dims: { L: 4.95, W: 2.0, H: 1.1, wheelbase: xR - xF, xF, xR, x0: 0, x1: 4.96, mass: 1030 },
    rideNominal: { front: h0, rear: h0 },
    ride: { front: (P.rideF ?? 50) / 1000, rear: (P.rideR ?? 65) / 1000 },
    catNames: { 1: 'Carrosserie', 2: 'Fond plat & diffuseur', 3: 'Splitter & canards', 4: 'Aileron arrière' },
    wheelStyle: { style: 'hyper', rimColor: 0x26282c },
    aero: [
      { cat: CAT.REAR, box: { x0: 4.38, x1: 4.88, y0: 0.9, y1: 1.1, z0: 0.0, z1: 0.9 }, segs: 4, chord: 0.45, xLE: 4.42, yRef: 0.99, AR: 4.0,
        Cl0: 1.4, Clmax: 2.3, slope: 0.07, dAlpha: 1.1 * rw, Cd0: 0.08, k: 0.015 },
    ],
  });
}

// ============================================================================
// VOITURE DE TOUS LES JOURS — compacte 5 portes (L 4,28 m, l 1,79 m, h 1,46 m)
// ============================================================================
export function buildRoadCar(P = {}) {
  const spoiler = P.spoiler ?? 0;
  const withMirrors = P.mirrors ?? true;
  const xF = 0.88, xR = 3.5, R = 0.323, B = 0.215, zW = 0.775; // 225/45 R17, empattement 2,62 m
  const h0 = 0.14;

  const Wf = curve([[0.45, 0.6], [1.22, 0.6], [1.32, 0.8], [3.04, 0.8], [3.14, 0.6], [3.9, 0.6]]);
  const floorTop = (x, z) => (x < 0.45 || x > 3.9 || Math.abs(z) > Wf(x) ? -Infinity : h0 + 0.025);
  const floorG = loftGeometry((x) => ({ W: Wf(x), top: () => h0 + 0.025, bot: () => h0, rt: 0.008, rb: 0.008 }), stations(0.45, 3.9, 40, [1.22, 1.32, 3.04, 3.14]), { nTop: 20, nSide: 3 });

  // plan : élargisseurs d'ailes au droit des roues
  const W = curve([[0.0, 0.6], [0.04, 0.77], [0.12, 0.85], [0.35, 0.885], [0.6, 0.9], [0.88, 0.905], [1.25, 0.893], [2.2, 0.888], [3.1, 0.895], [3.5, 0.905], [3.9, 0.893], [4.15, 0.86], [4.28, 0.79]]);
  // ligne de capot / ligne de ceinture montante
  const D = curve([[0.0, 0.52], [0.06, 0.64], [0.16, 0.74], [0.45, 0.83], [0.9, 0.89], [1.3, 0.94], [1.6, 0.97], [2.6, 1.0], [3.6, 1.05], [4.0, 1.08], [4.28, 1.04]]);
  // pavillon : pare-brise incliné, pavillon court, lunette arrière fuyante
  const Ct = curve([[1.32, 0.95], [1.5, 1.06], [1.9, 1.3], [2.2, 1.42], [2.45, 1.46], [3.05, 1.455], [3.45, 1.42], [3.8, 1.3], [4.05, 1.16], [4.2, 1.09], [4.25, 1.07]]);
  const CB = curve([[1.32, 0.74], [1.7, 0.78], [2.4, 0.79], [3.4, 0.79], [3.9, 0.76], [4.2, 0.71]]);
  const CR = curve([[1.32, 0.5], [2.1, 0.57], [3.3, 0.57], [3.9, 0.53], [4.2, 0.48]]);
  const baseBot = curve([[0.0, 0.34], [0.05, 0.24], [0.15, 0.19], [0.45, h0 + 0.03], [3.85, h0 + 0.03], [4.05, 0.22], [4.28, 0.35]]);
  const Ra = 0.37;
  const well = (x, z, b) => {
    for (const xa of [xF, xR]) {
      const dx = x - xa;
      if (Math.abs(dx) < Ra) {
        const arch = R + Math.sqrt(Ra * Ra - dx * dx) * 0.98;
        const zin = zW - B / 2 - 0.04;
        const t = smoothstep(zin - 0.04, zin, Math.abs(z));
        b = b + (Math.max(b, arch) - b) * t;
      }
    }
    return b;
  };
  const section = (x) => ({
    W: W(x),
    top: (z) => {
      // capot bombé avec deux nervures, épaulement marqué
      const zn = z / W(x);
      let t = D(x) - 0.05 * zn ** 2 + (x < 1.5 ? 0.012 * Math.exp(-(((Math.abs(zn) - 0.55) / 0.12) ** 2)) : 0);
      if (x > 1.32 && x < 4.24) t = smax(t, mesa(z, CR(x), CB(x), D(x) - 0.01, Ct(x), 0.42), 0.04);
      return t;
    },
    bot: (z) => {
      let b = baseBot(x);
      const ft = floorTop(x, z);
      if (isFinite(ft)) b = Math.max(b, ft + 0.002);
      return well(x, z, b);
    },
    rt: x < 0.1 ? 0.1 : 0.13,
    rb: 0.07,
    bulge: 0.022,
  });
  const bodyG = loftGeometry(section, stations(0.0, 4.28, 150, [xF - Ra, xF + Ra, xR - Ra, xR + Ra, 1.32, 4.24]), { nTop: 64, nSide: 9 });
  const bodyMat = liveryMaterial({
    curves: [D, (x) => (x > 1.32 && x < 4.24 ? Ct(x) : 0), CB, CR], x0: 0, x1: 4.3,
    palette: ['#24476b', '#1b1f24', '#0a0e14', '#eef4fb', '#0a0c0f', '#c2121f', '#b8c0c9', '#f4f4f0'],
    decals: ['AB-123-CD', 'F'],
    glsl: `vec3 plate(vec2 uv) {
  if (uv.x < 0.085) return decal(1.0, vec2(uv.x / 0.085 * 0.4 + 0.3, uv.y * 0.6)) > 0.5 ? vec3(1.0) : vec3(0.05, 0.2, 0.62);
  return decal(0.0, vec2((uv.x - 0.085) / 0.915, uv.y)) > 0.5 ? vec3(0.03) : uPal[7];
}
vec3 livery(vec3 p, vec3 n) {
  vec4 c = cv(p.x);
  float a = abs(p.z);
  // vitrages, montants, encadrement chromé
  if (p.x > 1.34 && p.x < 4.22 && p.y > c.x + 0.035) {
    bool roof = n.y > 0.88 && p.y > c.y - 0.07;
    bool side = a > 0.5 && n.y < 0.62;
    if (!roof) {
      if (side && p.y > c.y - 0.075 - 0.02 * (p.x - 2.5) && p.y < c.y - 0.03) { gR = 0.5; gM = 0.0; return uPal[1]; }
      if (p.y < c.x + 0.052) { gR = 0.12; gM = 0.95; return uPal[6]; }
      if (side && p.x > 2.5 && p.x < 2.6) { gR = 0.5; gM = 0.0; return uPal[1]; }
      if (side && p.x > 3.62 && p.x < 3.95) { gR = 0.32; gM = 0.45; return uPal[0]; }
      gR = 0.03; gM = 0.0; return uPal[2];
    }
  }
  // plaques d'immatriculation
  if (p.x < 0.06 && n.x < -0.5 && p.y > 0.355 && p.y < 0.435 && a < 0.25) { gR = 0.4; gM = 0.0; return plate(vec2((p.z + 0.25) / 0.5, (p.y - 0.355) / 0.08)); }
  if (p.x > 4.24 && p.y > 0.72 && p.y < 0.82 && a < 0.27) { gR = 0.4; gM = 0.0; return plate(vec2((0.27 - p.z) / 0.54, (p.y - 0.72) / 0.1)); }
  // boucliers et bas de caisse en plastique noir grainé
  if (p.y < 0.26 || (p.y < 0.34 && (p.x < 0.42 || p.x > 3.95))) { gR = 0.75; gM = 0.0; return uPal[1]; }
  // face avant : calandre nid d'abeille, optiques effilées, signature lumineuse
  if (p.x < 0.32 && p.y > 0.6 && p.y < 0.71 && a > 0.4 && a < 0.84 && n.x < -0.1) {
    if (lineMask(p.y - 0.62, 0.006) > 0.5) { gR = 0.05; return uPal[3] * 1.8; }
    gR = 0.05; gM = 0.6; return mix(uPal[2], uPal[3], 0.55);
  }
  if (p.x < 0.14 && p.y > 0.445 && p.y < 0.565 && a < 0.42) {
    vec2 h = vec2(p.z * 55.0, p.y * 55.0);
    float hex = step(0.25, abs(fract(h.x + 0.5 * floor(h.y)) - 0.5)) * step(0.25, abs(fract(h.y) - 0.5));
    gR = 0.5; gM = 0.2; return mix(uPal[4], uPal[1] * 1.6, hex);
  }
  // arrière : feux enveloppants, plaque, logo
  if (p.x > 4.08 && p.y > 0.94 && p.y < 1.07 && a > 0.36) { gR = 0.12; gM = 0.0; return uPal[5] * (lineMask(p.y - 1.0, 0.006) > 0.5 ? 1.7 : 1.0); }
  if (p.x > 4.24 && p.y > 0.72 && p.y < 0.82 && a < 0.27) { gR = 0.4; gM = 0.0; return plate(vec2((0.27 - p.z) / 0.54, (p.y - 0.72) / 0.1)); }
  // lignes d'ouvrants (portes, capot, hayon) et poignées
  float panel = 0.0;
  if (a > 0.8 && p.y > 0.32 && p.y < c.x) {
    panel = max(panel, lineMask(p.x - 1.42 - 0.12 * (p.y - 0.6), 0.0035));
    panel = max(panel, lineMask(p.x - 2.55, 0.0035));
    panel = max(panel, lineMask(p.x - 3.52 + 0.1 * (p.y - 0.6), 0.0035));
    if (p.x > 1.5 && p.x < 3.6) panel = max(panel, lineMask(p.y - 0.33, 0.0035));
  }
  if (n.y > 0.6 && p.x < 1.5) panel = max(panel, lineMask(p.x - 0.32 - 0.05 * (a / 0.9) * (a / 0.9), 0.0035));
  if (n.y > 0.6 && p.x < 1.4) panel = max(panel, lineMask(a - 0.72 + 0.1 * smoothstep(1.4, 0.3, p.x), 0.0035));
  if (panel > 0.5) { gR = 0.6; return uPal[0] * 0.35; }
  if (a > 0.86 && p.y > 0.87 && p.y < 0.91 && ((p.x > 2.2 && p.x < 2.34) || (p.x > 3.18 && p.x < 3.3))) { gR = 0.15; gM = 0.9; return uPal[6]; }
  // nervure latérale (reflet clair)
  if (a > 0.85 && lineMask(p.y - 0.78 - 0.04 * (p.x - 0.9) / 3.0, 0.004) > 0.5) return uPal[0] * 1.55;
  return uPal[0];
}`,
  });

  const parts = [
    { geometry: bodyG, material: bodyMat, cat: CAT.BODY, priority: PRIO.body },
    { geometry: applyColors(floorG, () => '#1b1f24'), material: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.8 }), cat: CAT.FLOOR, thin: true, priority: PRIO.floor },
  ];
  if (withMirrors) {
    const m = [];
    for (const s of [-1, 1]) {
      m.push(ellipsoid(1.58, 1.03, s * 0.965, 0.1, 0.065, 0.1, 16));
      m.push(blade([1.61, 1.0, s * 0.86], [1.59, 1.02, s * 0.93], 0.07, 0.025));
    }
    parts.push({ geometry: applyColors(mergeGeoms(m), (x, y, z, nx) => (nx > 0.4 ? '#1b1f24' : '#24476b')), material: new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: 0.45, roughness: 0.3, clearcoat: 1 }), cat: CAT.FRONT, priority: PRIO.front });
  }
  const sp = wingElement({ chord: 0.2, x: 3.44, y: 1.425, aoa: spoiler - 10, m: 0.03, p: 0.4, t: 0.07 }, -0.6, 0.6, { nSpan: 10 });
  parts.push({ geometry: applyColors(sp, () => '#24476b'), material: new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: 0.45, roughness: 0.3, clearcoat: 1 }), cat: CAT.REAR, thin: true, priority: PRIO.rear });

  const wheels = [
    { c: [xF, R, zW], R, B, rimR: 0.216 },
    { c: [xF, R, -zW], R, B, rimR: 0.216 },
    { c: [xR, R, zW], R, B, rimR: 0.216 },
    { c: [xR, R, -zW], R, B, rimR: 0.216 },
  ];
  return assemble({
    id: 'road', name: 'Citadine compacte', short: 'Route', parts, wheels,
    dims: { L: 4.28, W: 1.79, H: 1.46, wheelbase: xR - xF, xF, xR, x0: 0, x1: 4.28, mass: 1250 },
    rideNominal: { front: h0, rear: h0 },
    ride: { front: (P.rideF ?? 140) / 1000, rear: (P.rideR ?? 140) / 1000 },
    catNames: { 1: 'Carrosserie', 2: 'Soubassement', 3: 'Rétroviseurs', 4: 'Becquet' },
    wheelStyle: { style: 'road', rimColor: 0xc3c8cf },
  });
}

export const CARS = {
  f1: {
    build: buildF1, name: 'Formule 1', short: 'F1',
    blurb: 'Monoplace aux cotes du règlement FIA 2026 : 3,40 m d\'empattement, 1,90 m de large, aéro active avant et arrière.',
    speed: 300,
    setup: [
      { key: 'activeAero', label: 'Aéro active', type: 'choice', options: [['Z', 'Mode virage · appui'], ['X', 'Mode ligne droite']], def: 'Z', rebuild: true },
      { key: 'frontWing', label: 'Incidence aileron avant', unit: '°', min: -4, max: 6, step: 0.5, def: 0, rebuild: true },
      { key: 'rearWing', label: 'Incidence aileron arrière', unit: '°', min: -6, max: 8, step: 0.5, def: 0, rebuild: true },
      { key: 'rideF', label: 'Hauteur de caisse avant', unit: 'mm', min: 15, max: 70, step: 1, def: 35, rebuild: true },
      { key: 'rideR', label: 'Hauteur de caisse arrière', unit: 'mm', min: 30, max: 140, step: 1, def: 75, rebuild: true },
    ],
  },
  hyper: {
    build: buildHypercar, name: 'Hypercar', short: 'LMH',
    blurb: 'Prototype d\'endurance LMH à roues couvertes, aileron à cols de cygne et dérive.',
    speed: 280,
    setup: [
      { key: 'rearWing', label: 'Incidence aileron arrière', unit: '°', min: -6, max: 10, step: 0.5, def: 0, rebuild: true },
      { key: 'canards', label: 'Canards avant', type: 'toggle', def: true, rebuild: true },
      { key: 'rideF', label: 'Hauteur de caisse avant', unit: 'mm', min: 30, max: 90, step: 1, def: 50, rebuild: true },
      { key: 'rideR', label: 'Hauteur de caisse arrière', unit: 'mm', min: 35, max: 110, step: 1, def: 65, rebuild: true },
    ],
  },
  road: {
    build: buildRoadCar, name: 'Citadine compacte', short: 'Route',
    blurb: 'Compacte 5 portes du quotidien, jantes 17".',
    speed: 130,
    setup: [
      { key: 'spoiler', label: 'Angle du becquet', unit: '°', min: 0, max: 20, step: 1, def: 0, rebuild: true },
      { key: 'mirrors', label: 'Rétroviseurs', type: 'toggle', def: true, rebuild: true },
      { key: 'rideF', label: 'Garde au sol avant', unit: 'mm', min: 90, max: 200, step: 1, def: 140, rebuild: true },
      { key: 'rideR', label: 'Garde au sol arrière', unit: 'mm', min: 90, max: 200, step: 1, def: 140, rebuild: true },
    ],
  },
};
