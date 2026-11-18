// Les trois modèles de voiture, construits aux cotes réelles de leur catégorie.
// Repère voiture : x vers l'arrière (sens de l'écoulement), y vers le haut (sol en y = 0),
// z latéral. Toutes les pièces « solides » sont des maillages fermés voxelisables.
import * as THREE from 'three';
import {
  curve, smoothstep, smax, dome, clamp, loftGeometry, stations, wingElement, plate, hplate,
  ellipsoid, rod, wheelVisual, cylinderZ, applyColors, mergeGeoms,
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

function paintMaterial() {
  return new THREE.MeshPhysicalMaterial({
    vertexColors: true, metalness: 0.45, roughness: 0.34, clearcoat: 1, clearcoatRoughness: 0.09,
  });
}

// Assemblage commun : carrosserie suspendue (hauteurs de caisse) + roues au sol.
function assemble({ id, name, short, parts, visuals = [], wheels, dims, rideNominal, ride, catNames, rimColor, spokes }) {
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

  const mat = paintMaterial();
  const solids = [];
  for (const p of parts) {
    const mesh = new THREE.Mesh(p.geometry, p.material || mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.cat = p.cat;
    body.add(mesh);
    if (p.solid !== false) {
      const g = p.voxel || p.geometry;
      solids.push({ geometry: g, matrix: M.clone(), cat: p.cat, thin: !!p.thin, priority: p.priority ?? PRIO.body });
    }
  }
  for (const v of visuals) {
    v.castShadow = true;
    body.add(v);
  }
  const wheelGroups = [];
  wheels.forEach((w, i) => {
    const wg = wheelVisual({ R: w.R, B: w.B, rimR: w.rimR, rimColor, spokes });
    wg.position.set(...w.c);
    group.add(wg);
    wheelGroups.push(wg);
    solids.push({ geometry: cylinderZ(w.R, w.B, w.c[0], w.c[1], w.c[2]), matrix: null, cat: CAT.WHEEL0 + i, thin: false, priority: PRIO.wheel });
  });
  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
  dims.ground = Math.min(ride.front, ride.rear);
  return { id, name, short, group, body, solids, wheels, wheelGroups, dims, catNames, bodyMatrix: M };
}

// ============================================================================
// FORMULE 1 — monoplace à effet de sol (empattement 3,40 m, largeur 1,90 m)
// ============================================================================
export function buildF1(P = {}) {
  const fw = P.frontWing ?? 0;
  const rw = P.rearWing ?? 0;
  const xmode = P.activeAero === 'X';
  const xF = 0.95, xR = 4.35;
  const Rf = 0.3525, Rr = 0.355, Bf = 0.28, Br = 0.375, zF = 0.81, zR = 0.76;
  const h0 = 0.03;

  // --- fond plat & tunnels Venturi ---
  const Wf = curve([[1.25, 0.35], [1.45, 0.72], [1.7, 0.8], [3.4, 0.8], [3.75, 0.7], [3.95, 0.555], [4.55, 0.53]]);
  const tun = curve([[1.25, 0.2], [1.6, 0.13], [2.2, 0.06], [2.9, 0.04], [3.4, 0.06], [4.0, 0.16], [4.55, 0.3]]);
  const cen = curve([[3.7, 0], [4.1, 0.05], [4.55, 0.15]]);
  const floorBot = (x, z) => {
    const a = Math.abs(z);
    let b = h0 + cen(x) + (tun(x) - cen(x)) * smoothstep(0.09, 0.16, a);
    const edge = h0 + 0.025;
    b = b + (edge - b) * smoothstep(0.62, 0.72, a);
    return b;
  };
  const floorTop = (x, z) => {
    if (x < 1.25 || x > 4.55 || Math.abs(z) > Wf(x)) return -Infinity;
    return floorBot(x, z) + 0.022;
  };
  const floorG = loftGeometry((x) => ({
    W: Wf(x), top: (z) => floorBot(x, z) + 0.022, bot: (z) => floorBot(x, z), rt: 0.008, rb: 0.008,
  }), stations(1.25, 4.55, 70), { nTop: 44, nSide: 3 });

  // --- châssis, nez, pontons, capot moteur ---
  const Wm = curve([[0.04, 0.02], [0.08, 0.05], [0.3, 0.085], [0.6, 0.11], [0.95, 0.15], [1.25, 0.24], [1.6, 0.28], [2.0, 0.3], [2.5, 0.29], [3.0, 0.25], [3.6, 0.19], [4.2, 0.14], [4.6, 0.12], [4.98, 0.07]]);
  const ytc = curve([[0.04, 0.25], [0.08, 0.27], [0.3, 0.31], [0.6, 0.38], [0.95, 0.48], [1.3, 0.6], [1.65, 0.66], [2.4, 0.67], [2.7, 0.74], [3.0, 0.72], [3.5, 0.62], [4.0, 0.52], [4.5, 0.45], [4.98, 0.4]]);
  const ybc = curve([[0.04, 0.22], [0.08, 0.2], [0.3, 0.205], [0.6, 0.215], [0.95, 0.2], [1.2, 0.12], [1.45, 0.075], [4.0, 0.08], [4.3, 0.2], [4.55, 0.33], [4.98, 0.34]]);
  const Wsp = curve([[1.7, 0.0], [1.85, 0.62], [2.05, 0.74], [2.5, 0.76], [3.0, 0.66], [3.5, 0.46], [3.9, 0.3], [4.2, 0.16]]);
  const ysp = curve([[1.85, 0.56], [2.1, 0.6], [2.6, 0.58], [3.1, 0.5], [3.6, 0.42], [4.1, 0.36]]);
  const ysb = curve([[1.85, 0.32], [2.2, 0.28], [2.7, 0.2], [3.2, 0.12], [3.6, 0.09], [4.2, 0.08]]);
  const abW = curve([[2.2, 0.0], [2.4, 0.13], [2.7, 0.13], [3.1, 0.08], [3.6, 0.03]]);
  const abH = curve([[2.2, 0.68], [2.45, 0.94], [2.65, 0.95], [3.0, 0.82], [3.6, 0.62]]);
  const rtF = curve([[0.04, 0.03], [0.95, 0.08], [1.6, 0.1], [3.0, 0.12], [4.2, 0.08], [4.98, 0.04]]);
  const rbF = curve([[0.04, 0.03], [1.2, 0.05], [2.0, 0.06], [4.98, 0.04]]);

  const bodySection = (x) => {
    const wm = Wm(x);
    const wsp = x > 1.7 && x < 4.2 ? Wsp(x) : 0;
    const W = Math.max(wm, wsp);
    const top = (z) => {
      let t = dome(z, 0, wm * 1.0001, ytc(x) - 0.11, ytc(x), 2.4);
      if (wsp > 0.02 && Math.abs(z) < wsp) t = smax(t, ysp(x), 0.05);
      const aw = abW(x);
      if (x > 2.2 && x < 3.6 && aw > 0.02) t = smax(t, dome(z, 0, aw, ytc(x) - 0.04, abH(x), 2.2), 0.04);
      if (!isFinite(t)) t = ytc(x) - 0.11;
      return t;
    };
    const bot = (z) => {
      const a = Math.abs(z);
      let b = ybc(x);
      if (wsp > wm) b = b + (ysb(x) - b) * smoothstep(wm - 0.03, wm + 0.03, a);
      const ft = floorTop(x, z);
      if (isFinite(ft)) b = Math.max(b, ft + 0.002);
      return b;
    };
    return { W, top, bot, rt: rtF(x), rb: rbF(x) };
  };
  const C = { carbon: '#15171b', dark: '#16233d', accent: '#18a0ff' };
  const bodyG = loftGeometry(bodySection, stations(0.04, 4.98, 110, [1.7, 1.85, 2.2, 2.45, 4.2]), { nTop: 48, nSide: 6 });
  const bodyMat = liveryMaterial({
    curves: [ytc, ysp, (x) => (x > 1.7 && x < 4.2 ? Wsp(x) : 0), Wm], x0: 0, x1: 5,
    palette: ['#eef1f5', '#141619', '#18a0ff', '#152447', '#f6c400'],
    glsl: `vec3 livery(vec3 p, vec3 n) {
  vec4 c = cv(p.x);
  float a = abs(p.z);
  if (p.y < 0.165 || n.y < -0.55) { gR = 0.38; gM = 0.25; return uPal[1]; }
  float sweep = 0.27 + 0.11 * (p.x - 1.8);
  if (p.x > 1.75 && p.y < sweep && a > 0.2) {
    if (p.y > sweep - 0.035) return uPal[2];
    return uPal[3];
  }
  if (p.x > 3.55 && p.y > 0.3) return uPal[3];
  if (a < 0.045 && n.y > 0.35 && p.x < 3.55) return uPal[2];
  if (p.x < 0.42) return uPal[2];
  if (p.x > 2.3 && p.x < 2.95 && p.y > c.x + 0.02) return uPal[3];
  return uPal[0];
}`,
  });
  applyColors(floorG, () => C.carbon);

  // --- aileron avant (3 éléments) ---
  const wingCol = (x, y, z) => (Math.abs(z) > 0.7 ? C.accent : C.carbon);
  const fwEls = [
    { chord: 0.3, x: 0.0, y: 0.085, aoa: 2 + fw * 0.5, m: 0.05, p: 0.4, t: 0.09, z: [-0.86, 0.86] },
    { chord: 0.17, x: 0.255, y: 0.115, aoa: (xmode ? 4 : 14) + fw * 1.3, m: 0.06, p: 0.4, t: 0.1, z: [0.22, 0.86] },
    { chord: 0.13, x: 0.39, y: 0.175, aoa: (xmode ? 10 : 28) + fw * 1.6, m: 0.06, p: 0.4, t: 0.1, z: [0.26, 0.86] },
  ];
  const fwGeoms = [];
  for (const el of fwEls) {
    if (el.z[0] < 0) fwGeoms.push(wingElement(el, el.z[0], el.z[1], { nSpan: 12 }));
    else {
      fwGeoms.push(wingElement(el, el.z[0], el.z[1], { nSpan: 8 }));
      fwGeoms.push(wingElement(el, -el.z[1], -el.z[0], { nSpan: 8 }));
    }
  }
  const fwEnd = [[-0.03, 0.05], [0.58, 0.05], [0.62, 0.12], [0.55, 0.3], [0.3, 0.31], [0.0, 0.2], [-0.04, 0.1]];
  for (const s of [-1, 1]) fwGeoms.push(plate(fwEnd, s * 0.872, 0.012));
  for (const s of [-1, 1]) fwGeoms.push(plate([[0.07, 0.1], [0.26, 0.1], [0.26, 0.215], [0.1, 0.215]], s * 0.075, 0.014));
  const fwG = applyColors(mergeGeoms(fwGeoms), wingCol);

  // --- aileron arrière (plan principal + volet) ---
  const rwEls = [
    { chord: 0.25, x: 4.66, y: 0.8, aoa: (xmode ? 2 : 9) + rw, m: 0.07, p: 0.4, t: 0.11 },
    { chord: 0.19, x: 4.89, y: 0.865, aoa: (xmode ? 6 : 34) + rw * 1.3, m: 0.07, p: 0.4, t: 0.1 },
  ];
  const rwGeoms = rwEls.map((el) => wingElement(el, -0.47, 0.47, { nSpan: 10 }));
  const rwEnd = [[4.58, 0.42], [5.12, 0.42], [5.17, 0.98], [4.62, 0.98], [4.56, 0.7]];
  for (const s of [-1, 1]) rwGeoms.push(plate(rwEnd, s * 0.482, 0.012));
  rwGeoms.push(plate([[4.7, 0.36], [4.86, 0.36], [4.86, 0.81], [4.74, 0.8]], 0, 0.02));
  const rwG = applyColors(mergeGeoms(rwGeoms), (x, y, z) => (Math.abs(z) > 0.46 ? C.accent : C.carbon));

  // --- pilote, rétroviseurs ---
  const helmet = applyColors(ellipsoid(2.18, 0.735, 0, 0.15, 0.13, 0.12, 20), (x, y) => (x < 2.1 && y > 0.7 && y < 0.79 ? '#111' : '#f4c430'));
  const mirrors = [];
  for (const s of [-1, 1]) {
    mirrors.push(ellipsoid(1.66, 0.675, s * 0.42, 0.06, 0.035, 0.09, 12));
    mirrors.push(rod([1.68, 0.64, s * 0.3], [1.66, 0.67, s * 0.4], 0.012, 6));
  }
  const mirrorG = applyColors(mergeGeoms(mirrors), () => C.dark);

  // --- éléments visuels seuls (sous la résolution de la grille) ---
  const visuals = [];
  const susMat = new THREE.MeshPhysicalMaterial({ color: 0x1b1d21, roughness: 0.45, metalness: 0.3 });
  const arms = [];
  for (const s of [-1, 1]) {
    const uf = [xF, 0.43, s * (zF - 0.12)], lf = [xF, 0.22, s * (zF - 0.12)];
    arms.push(rod([xF - 0.17, 0.42, s * 0.17], uf, 0.016), rod([xF + 0.22, 0.44, s * 0.2], uf, 0.016));
    arms.push(rod([xF - 0.2, 0.2, s * 0.14], lf, 0.016), rod([xF + 0.28, 0.22, s * 0.15], lf, 0.016));
    arms.push(rod([xF + 0.08, 0.33, s * 0.16], [xF + 0.06, 0.34, s * (zF - 0.12)], 0.012));
    const ur = [xR, 0.45, s * (zR - 0.16)], lr = [xR, 0.2, s * (zR - 0.16)];
    arms.push(rod([xR - 0.28, 0.42, s * 0.14], ur, 0.016), rod([xR + 0.12, 0.44, s * 0.12], ur, 0.016));
    arms.push(rod([xR - 0.3, 0.18, s * 0.13], lr, 0.016), rod([xR + 0.15, 0.2, s * 0.12], lr, 0.016));
  }
  visuals.push(new THREE.Mesh(mergeGeoms(arms), susMat));
  // halo
  const haloPts = [
    new THREE.Vector3(1.78, 0.665, 0), new THREE.Vector3(1.92, 0.82, 0), new THREE.Vector3(2.12, 0.86, 0.16),
    new THREE.Vector3(2.38, 0.83, 0.23), new THREE.Vector3(2.5, 0.72, 0.24),
  ];
  const haloL = new THREE.CatmullRomCurve3(haloPts);
  const haloR = new THREE.CatmullRomCurve3(haloPts.map((p) => new THREE.Vector3(p.x, p.y, -p.z)));
  const haloMat = new THREE.MeshPhysicalMaterial({ color: 0x0f1013, roughness: 0.35, metalness: 0.5 });
  visuals.push(new THREE.Mesh(new THREE.TubeGeometry(haloL, 24, 0.024, 8), haloMat));
  visuals.push(new THREE.Mesh(new THREE.TubeGeometry(haloR, 24, 0.024, 8), haloMat));

  const parts = [
    { geometry: bodyG, material: bodyMat, cat: CAT.BODY, priority: PRIO.body },
    { geometry: floorG, cat: CAT.FLOOR, thin: true, priority: PRIO.floor },
    { geometry: fwG, cat: CAT.FRONT, thin: true, priority: PRIO.front },
    { geometry: rwG, cat: CAT.REAR, thin: true, priority: PRIO.rear },
    { geometry: helmet, cat: CAT.BODY, priority: PRIO.body + 1 },
    { geometry: mirrorG, cat: CAT.BODY, thin: true, priority: PRIO.body + 1 },
  ];
  const wheels = [
    { c: [xF, Rf, zF], R: Rf, B: Bf, rimR: 0.23 },
    { c: [xF, Rf, -zF], R: Rf, B: Bf, rimR: 0.23 },
    { c: [xR, Rr, zR], R: Rr, B: Br, rimR: 0.23 },
    { c: [xR, Rr, -zR], R: Rr, B: Br, rimR: 0.23 },
  ];
  return assemble({
    id: 'f1', name: 'Formule 1', short: 'F1', parts, visuals, wheels,
    dims: { L: 5.17, W: 1.9, H: 0.98, wheelbase: xR - xF, xF, xR, x0: -0.04, x1: 5.17 },
    rideNominal: { front: h0, rear: h0 },
    ride: { front: (P.rideF ?? 35) / 1000, rear: (P.rideR ?? 80) / 1000 },
    catNames: { 1: 'Carrosserie', 2: 'Fond plat & diffuseur', 3: 'Aileron avant', 4: 'Aileron arrière' },
    rimColor: 0x1c1e22, spokes: 10,
  });
}

// ============================================================================
// HYPERCAR — prototype d'endurance à roues couvertes (L 4,95 m, l 2,00 m, h 1,06 m)
// ============================================================================
export function buildHypercar(P = {}) {
  const rw = P.rearWing ?? 0;
  const canards = P.canards ?? true;
  const xF = 1.0, xR = 4.1, R = 0.355, Bf = 0.31, Br = 0.34, zW = 0.8;
  const h0 = 0.05;

  const Wf = curve([[0.3, 0.75], [0.5, 0.57], [1.45, 0.57], [1.62, 0.95], [3.52, 0.95], [3.68, 0.57], [4.55, 0.57], [4.72, 0.9], [4.95, 0.92]]);
  const diff = curve([[3.6, 0], [4.2, 0.1], [4.95, 0.27]]);
  const floorBot = (x, z) => h0 + (x > 3.6 ? diff(x) * (1 - smoothstep(0.5, 0.6, Math.abs(z))) : 0);
  const floorTop = (x, z) => (x < 0.3 || x > 4.95 || Math.abs(z) > Wf(x) ? -Infinity : floorBot(x, z) + 0.025);
  const floorG = loftGeometry((x) => ({ W: Wf(x), top: (z) => floorBot(x, z) + 0.025, bot: (z) => floorBot(x, z), rt: 0.008, rb: 0.008 }),
    stations(0.3, 4.95, 70, [1.45, 1.62, 3.52, 3.68, 4.55, 4.72]), { nTop: 40, nSide: 3 });

  const W = curve([[0.06, 0.78], [0.14, 0.88], [0.35, 0.93], [0.6, 0.98], [0.9, 1.0], [4.3, 1.0], [4.7, 0.99], [4.95, 0.97]]);
  const D = curve([[0.06, 0.19], [0.15, 0.26], [0.4, 0.37], [0.8, 0.46], [1.2, 0.51], [1.5, 0.55], [2.2, 0.6], [3.2, 0.66], [3.8, 0.71], [4.4, 0.76], [4.95, 0.8]]);
  const F = curve([[0.1, 0.24], [0.4, 0.53], [0.75, 0.75], [1.0, 0.82], [1.25, 0.8], [1.6, 0.7], [2.1, 0.63], [2.8, 0.66], [3.5, 0.78], [4.1, 0.86], [4.6, 0.84], [4.95, 0.81]]);
  const FW = curve([[0.1, 0.18], [0.5, 0.25], [1.0, 0.27], [1.6, 0.27], [2.5, 0.3], [4.1, 0.3], [4.95, 0.28]]);
  const Cn = curve([[1.35, 0.5], [1.6, 0.7], [1.9, 0.92], [2.2, 1.03], [2.5, 1.06], [2.85, 1.02], [3.2, 0.9], [3.6, 0.78], [4.0, 0.72]]);
  const CW = curve([[1.35, 0.3], [1.7, 0.5], [2.2, 0.58], [2.8, 0.55], [3.3, 0.38], [3.8, 0.22], [4.0, 0.15]]);
  const baseBot = curve([[0.06, 0.1], [0.3, h0 + 0.03], [4.95, h0 + 0.03]]);
  const Ra = 0.42;
  const well = (x, z, b) => {
    for (const [xa, B] of [[xF, Bf], [xR, Br]]) {
      const dx = x - xa;
      if (Math.abs(dx) < Ra) {
        const arch = R + Math.sqrt(Ra * Ra - dx * dx) * 0.98;
        const zin = zW - B / 2 - 0.05;
        const t = smoothstep(zin - 0.04, zin, Math.abs(z));
        b = b + (Math.max(b, arch) - b) * t;
      }
    }
    return b;
  };
  const section = (x) => ({
    W: W(x),
    top: (z) => {
      let t = D(x) - 0.03 * (z / W(x)) ** 2;
      if (x > 0.1) t = smax(t, dome(Math.abs(z), zW, FW(x), D(x) - 0.05, F(x), 2.3), 0.08);
      if (x > 1.35 && x < 4.0) t = smax(t, dome(z, 0, CW(x), D(x) - 0.02, Cn(x), 2.4), 0.07);
      return t;
    },
    bot: (z) => {
      let b = baseBot(x);
      const ft = floorTop(x, z);
      if (isFinite(ft)) b = Math.max(b, ft + 0.002);
      return well(x, z, b);
    },
    rt: x < 0.3 ? 0.06 : 0.09,
    rb: 0.04,
  });
  const C = { base: '#f1f3f6', dark: '#16181c', accent: '#00a99d' };
  const bodyG = loftGeometry(section, stations(0.06, 4.95, 120, [xF - Ra, xF + Ra, xR - Ra, xR + Ra, 1.35, 4.0]), { nTop: 56, nSide: 6 });
  const bodyMat = liveryMaterial({
    curves: [D, (x) => (x > 1.35 && x < 4.0 ? Cn(x) : 0), (x) => (x > 1.35 && x < 4.0 ? CW(x) : 0), F], x0: 0, x1: 5,
    palette: ['#f1f3f6', '#16181c', '#0a0e13', '#00a99d', '#e9f4ff', '#c0161f'],
    glsl: `vec3 livery(vec3 p, vec3 n) {
  vec4 c = cv(p.x);
  float a = abs(p.z);
  if (p.y < 0.19 || n.y < -0.5) { gR = 0.45; gM = 0.2; return uPal[1]; }
  if (p.x > 1.42 && p.x < 2.42 && a < c.z - 0.07 && p.y > c.x + 0.09 && n.y < 0.985) { gR = 0.03; gM = 0.0; return uPal[2]; }
  if (p.x > 2.2 && p.x < 3.05 && p.y > c.x + 0.07 && p.y < c.y - 0.08 && a > 0.22 && n.y < 0.75) { gR = 0.03; gM = 0.0; return uPal[2]; }
  if (p.x < 0.62 && a > 0.52 && a < 0.93 && n.y > 0.25 && p.y > c.w - 0.07) { gR = 0.05; return uPal[4]; }
  if (p.x > 4.88 && p.y > 0.6) { gR = 0.2; return uPal[5]; }
  if (p.y < 0.3 && a > 0.9) return uPal[1];
  if (a > 0.95 && abs(p.y - 0.42 - 0.04 * sin(p.x * 1.3)) < 0.025) return uPal[3];
  if (a < 0.05 && n.y > 0.5) return uPal[3];
  return uPal[0];
}`,
  });
  applyColors(floorG, () => C.dark);

  // séparateur avant (splitter) + plongeurs (canards)
  const front = [hplate([[0.0, -0.78], [0.0, 0.78], [0.12, 0.88], [0.62, 0.88], [0.62, -0.88], [0.12, -0.88]], h0 + 0.004, 0.02)];
  if (canards) {
    for (const s of [-1, 1]) {
      for (const [y, x] of [[0.27, 0.26], [0.37, 0.33]]) {
        const z0 = s > 0 ? 0.88 : -0.995, z1 = s > 0 ? 0.995 : -0.88;
        front.push(wingElement({ chord: 0.16, x, y, aoa: 12, m: 0.06, t: 0.1 }, z0, z1, { nSpan: 3 }));
      }
    }
  }
  const frontG = applyColors(mergeGeoms(front), () => C.dark);

  // aileron arrière à cols de cygne + dérive
  const rearParts = [
    wingElement({ chord: 0.3, x: 4.42, y: 0.95, aoa: 7 + rw, m: 0.07, p: 0.4, t: 0.12 }, -0.9, 0.9, { nSpan: 14 }),
    wingElement({ chord: 0.15, x: 4.69, y: 1.005, aoa: 24 + rw * 1.2, m: 0.07, p: 0.4, t: 0.1 }, -0.9, 0.9, { nSpan: 14 }),
  ];
  for (const s of [-1, 1]) rearParts.push(plate([[4.35, 0.82], [4.92, 0.8], [4.92, 1.08], [4.45, 1.08]], s * 0.912, 0.012));
  for (const s of [-1, 1]) rearParts.push(plate([[4.5, 0.74], [4.62, 0.74], [4.6, 1.04], [4.52, 1.04]], s * 0.3, 0.015));
  const rearG = applyColors(mergeGeoms(rearParts), (x, y, z) => (Math.abs(z) > 0.9 ? C.accent : C.dark));
  const finG = applyColors(plate([[2.85, 1.0], [3.3, 0.86], [4.55, 0.76], [4.6, 0.98], [3.4, 1.03]], 0, 0.012), () => C.base);

  const parts = [
    { geometry: bodyG, material: bodyMat, cat: CAT.BODY, priority: PRIO.body },
    { geometry: floorG, cat: CAT.FLOOR, thin: true, priority: PRIO.floor },
    { geometry: frontG, cat: CAT.FRONT, thin: true, priority: PRIO.front },
    { geometry: rearG, cat: CAT.REAR, thin: true, priority: PRIO.rear },
    { geometry: finG, cat: CAT.BODY, thin: true, priority: PRIO.body + 1 },
  ];
  const wheels = [
    { c: [xF, R, zW], R, B: Bf, rimR: 0.23 },
    { c: [xF, R, -zW], R, B: Bf, rimR: 0.23 },
    { c: [xR, R, zW], R, B: Br, rimR: 0.23 },
    { c: [xR, R, -zW], R, B: Br, rimR: 0.23 },
  ];
  return assemble({
    id: 'hyper', name: 'Hypercar', short: 'LMH', parts, wheels,
    dims: { L: 4.95, W: 2.0, H: 1.07, wheelbase: xR - xF, xF, xR, x0: 0, x1: 4.95 },
    rideNominal: { front: h0, rear: h0 },
    ride: { front: (P.rideF ?? 50) / 1000, rear: (P.rideR ?? 65) / 1000 },
    catNames: { 1: 'Carrosserie', 2: 'Fond plat & diffuseur', 3: 'Splitter & canards', 4: 'Aileron arrière' },
    rimColor: 0x24262b, spokes: 6,
  });
}

// ============================================================================
// VOITURE DE TOUS LES JOURS — compacte 5 portes (L 4,28 m, l 1,79 m, h 1,45 m)
// ============================================================================
export function buildRoadCar(P = {}) {
  const spoiler = P.spoiler ?? 0;
  const withMirrors = P.mirrors ?? true;
  const xF = 0.86, xR = 3.48, R = 0.316, B = 0.205, zW = 0.775;
  const h0 = 0.14;

  const Wf = curve([[0.45, 0.6], [1.22, 0.6], [1.32, 0.8], [3.02, 0.8], [3.12, 0.6], [3.9, 0.6]]);
  const floorTop = (x, z) => (x < 0.45 || x > 3.9 || Math.abs(z) > Wf(x) ? -Infinity : h0 + 0.025);
  const floorG = loftGeometry((x) => ({ W: Wf(x), top: () => h0 + 0.025, bot: () => h0, rt: 0.008, rb: 0.008 }), stations(0.45, 3.9, 40, [1.22, 1.32, 3.02, 3.12]), { nTop: 20, nSide: 3 });

  const W = curve([[0.0, 0.62], [0.04, 0.76], [0.12, 0.84], [0.35, 0.885], [0.86, 0.895], [3.5, 0.895], [3.95, 0.885], [4.18, 0.85], [4.28, 0.78]]);
  const D = curve([[0.0, 0.58], [0.05, 0.66], [0.15, 0.73], [0.45, 0.8], [0.86, 0.86], [1.3, 0.92], [1.6, 0.96], [2.6, 0.99], [3.6, 1.02], [4.0, 1.03], [4.28, 1.0]]);
  const Ct = curve([[1.5, 0.96], [1.65, 1.04], [2.0, 1.27], [2.3, 1.41], [2.55, 1.45], [3.25, 1.44], [3.6, 1.41], [3.85, 1.33], [4.05, 1.17], [4.2, 1.04], [4.24, 1.02]]);
  const CB = curve([[1.5, 0.74], [1.8, 0.79], [2.4, 0.8], [3.4, 0.8], [3.9, 0.77], [4.2, 0.72]]);
  const CR = curve([[1.5, 0.5], [2.2, 0.58], [3.4, 0.58], [3.9, 0.55], [4.2, 0.5]]);
  const baseBot = curve([[0.0, 0.36], [0.05, 0.25], [0.15, 0.19], [0.45, h0 + 0.03], [3.85, h0 + 0.03], [4.05, 0.22], [4.28, 0.36]]);
  const Ra = 0.36;
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
      let t = D(x) - 0.05 * (z / W(x)) ** 2;
      if (x > 1.5 && x < 4.22) t = smax(t, mesa(z, CR(x), CB(x), D(x) - 0.01, Ct(x), 0.4), 0.05);
      return t;
    },
    bot: (z) => {
      let b = baseBot(x);
      const ft = floorTop(x, z);
      if (isFinite(ft)) b = Math.max(b, ft + 0.002);
      return well(x, z, b);
    },
    rt: x < 0.1 ? 0.1 : 0.15,
    rb: 0.07,
  });
  const C = { paint: '#24476b', plastic: '#202429', chrome: '#9aa3ad' };
  const bodyG = loftGeometry(section, stations(0.0, 4.28, 120, [xF - Ra, xF + Ra, xR - Ra, xR + Ra, 1.5, 4.22]), { nTop: 56, nSide: 7 });
  const bodyMat = liveryMaterial({
    curves: [D, (x) => (x > 1.5 && x < 4.22 ? Ct(x) : 0), CB, CR], x0: 0, x1: 4.3,
    palette: ['#24476b', '#1d2126', '#0a0e14', '#e9f1fa', '#0a0c0f', '#b3121f', '#aab2bc'],
    glsl: `vec3 livery(vec3 p, vec3 n) {
  vec4 c = cv(p.x);
  float a = abs(p.z);
  if (p.x > 1.53 && p.x < 4.2 && p.y > c.x + 0.035) {
    bool roof = n.y > 0.88 && p.y > c.y - 0.07;
    if (!roof) {
      if (p.y < c.x + 0.05) { gR = 0.15; gM = 0.9; return uPal[6]; }
      if (p.x > 2.62 && p.x < 2.71) { gR = 0.55; gM = 0.0; return uPal[1]; }
      gR = 0.03; gM = 0.0; return uPal[2];
    }
  }
  if (p.y < 0.25 || (p.y < 0.33 && (p.x < 0.42 || p.x > 3.95))) { gR = 0.7; gM = 0.0; return uPal[1]; }
  if (p.x < 0.32 && p.y > 0.61 && p.y < 0.72 && a > 0.43 && a < 0.83 && n.x < -0.15) { gR = 0.05; gM = 0.0; return uPal[3]; }
  if (p.x < 0.12 && p.y > 0.37 && p.y < 0.54 && a < 0.44) { gR = 0.6; gM = 0.0; return uPal[4]; }
  if (p.x > 4.1 && p.y > 0.95 && p.y < 1.06 && a > 0.38) { gR = 0.15; gM = 0.0; return uPal[5]; }
  return uPal[0];
}`,
  });
  applyColors(floorG, () => C.plastic);

  const parts = [
    { geometry: bodyG, material: bodyMat, cat: CAT.BODY, priority: PRIO.body },
    { geometry: floorG, cat: CAT.FLOOR, thin: true, priority: PRIO.floor },
  ];
  if (withMirrors) {
    const m = [];
    for (const s of [-1, 1]) {
      m.push(ellipsoid(1.72, 1.03, s * 0.965, 0.1, 0.065, 0.1, 14));
      m.push(rod([1.74, 1.0, s * 0.85], [1.73, 1.02, s * 0.93], 0.02, 6));
    }
    parts.push({ geometry: applyColors(mergeGeoms(m), (x, y, z, nx) => (nx > 0.4 ? C.chrome : C.paint)), cat: CAT.FRONT, priority: PRIO.front });
  }
  const sp = wingElement({ chord: 0.2, x: 3.66, y: 1.415, aoa: spoiler - 8, m: 0.03, p: 0.4, t: 0.07 }, -0.62, 0.62, { nSpan: 10 });
  parts.push({ geometry: applyColors(sp, () => C.paint), cat: CAT.REAR, thin: true, priority: PRIO.rear });

  const wheels = [
    { c: [xF, R, zW], R, B, rimR: 0.2 },
    { c: [xF, R, -zW], R, B, rimR: 0.2 },
    { c: [xR, R, zW], R, B, rimR: 0.2 },
    { c: [xR, R, -zW], R, B, rimR: 0.2 },
  ];
  return assemble({
    id: 'road', name: 'Citadine compacte', short: 'Route', parts, wheels,
    dims: { L: 4.28, W: 1.79, H: 1.45, wheelbase: xR - xF, xF, xR, x0: 0, x1: 4.28 },
    rideNominal: { front: h0, rear: h0 },
    ride: { front: (P.rideF ?? 140) / 1000, rear: (P.rideR ?? 140) / 1000 },
    catNames: { 1: 'Carrosserie', 2: 'Soubassement', 3: 'Rétroviseurs', 4: 'Becquet' },
    rimColor: 0xb7bdc6, spokes: 5,
  });
}

export const CARS = {
  f1: {
    build: buildF1, name: 'Formule 1', short: 'F1',
    blurb: 'Monoplace à effet de sol, aéro active (modes Z / X).',
    speed: 300,
    setup: [
      { key: 'frontWing', label: 'Incidence aileron avant', unit: '°', min: -4, max: 6, step: 0.5, def: 0, rebuild: true },
      { key: 'rearWing', label: 'Incidence aileron arrière', unit: '°', min: -6, max: 8, step: 0.5, def: 0, rebuild: true },
      { key: 'activeAero', label: 'Aéro active', type: 'choice', options: [['Z', 'Mode Z · appui'], ['X', 'Mode X · ligne droite']], def: 'Z', rebuild: true },
      { key: 'rideF', label: 'Hauteur de caisse avant', unit: 'mm', min: 15, max: 70, step: 1, def: 35, rebuild: true },
      { key: 'rideR', label: 'Hauteur de caisse arrière', unit: 'mm', min: 30, max: 140, step: 1, def: 80, rebuild: true },
    ],
  },
  hyper: {
    build: buildHypercar, name: 'Hypercar', short: 'LMH',
    blurb: 'Prototype d\'endurance à roues couvertes, aileron à cols de cygne.',
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
    blurb: 'Compacte 5 portes du quotidien.',
    speed: 130,
    setup: [
      { key: 'spoiler', label: 'Angle du becquet', unit: '°', min: 0, max: 20, step: 1, def: 0, rebuild: true },
      { key: 'mirrors', label: 'Rétroviseurs', type: 'toggle', def: true, rebuild: true },
      { key: 'rideF', label: 'Garde au sol avant', unit: 'mm', min: 90, max: 200, step: 1, def: 140, rebuild: true },
      { key: 'rideR', label: 'Garde au sol arrière', unit: 'mm', min: 90, max: 200, step: 1, def: 140, rebuild: true },
    ],
  },
};
