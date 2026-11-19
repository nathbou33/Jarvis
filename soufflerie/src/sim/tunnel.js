// Pilotage de la soufflerie : domaine de calcul, voxelisation de la voiture,
// passage unités physiques ↔ unités réseau, mesure et dépouillement des efforts.
import * as THREE from 'three';
import { LBM, WHEEL_CAT0 } from './lbm.js';
import { D2Q9, D3Q19 } from './lattice.js';
import { trianglesOf, voxelize3D, voxelizeSection, voxelizeSilhouette, projectedArea } from '../geometry/voxelize.js';
import { buildSDF, meshTriangles } from '../geometry/sdf.js';

// --- Air (atmosphère standard + loi de Sutherland) ---
export function airProps(tempC, altitude) {
  const T = tempC + 273.15;
  const p = 101325 * Math.pow(1 - 2.25577e-5 * altitude, 5.25588);
  const rho = p / (287.058 * T);
  const mu = (1.716e-5 * Math.pow(T / 273.15, 1.5) * (273.15 + 110.4)) / (T + 110.4);
  const a = Math.sqrt(1.4 * 287.058 * T);
  return { T, p, rho, mu, nu: mu / rho, a };
}

export const QUALITY = {
  low: { label: 'Rapide', cells3d: 170e3, nx2d: 720 },
  medium: { label: 'Standard', cells3d: 380e3, nx2d: 1100 },
  high: { label: 'Fine', cells3d: 800e3, nx2d: 1500 },
  ultra: { label: 'Très fine', cells3d: 1.5e6, nx2d: 2000 },
};

export class Tunnel {
  constructor(gpu) {
    this.gpu = gpu;
    this.sim = null;
    this.history = [];
    this.busy = false;
    this.cs = 0.17; // constante de Smagorinsky
  }

  /**
   * Prépare un essai.
   * opts: { car, mode: '3d' | 'side' | 'top', quality, yaw (deg), section (m), silhouette,
   *         speed (km/h), tempC, altitude, rollingRoad, rotatingWheels, turbulence (%) }
   */
  setup(opts) {
    const keep = this.sim && this.layoutKey === this._layoutKey(opts);
    this.opts = { ...opts };
    const car = opts.car;
    // Transformation lacet (plateau tournant centré à mi-empattement)
    const cx = (car.dims.xF + car.dims.xR) / 2;
    const yaw = ((opts.mode === 'side' ? 0 : opts.yaw) * Math.PI) / 180;
    this.yawMatrix = new THREE.Matrix4()
      .makeTranslation(cx, 0, 0)
      .multiply(new THREE.Matrix4().makeRotationY(-yaw))
      .multiply(new THREE.Matrix4().makeTranslation(-cx, 0, 0));
    this.turntable = new THREE.Vector3(cx, 0, 0);

    // Triangles en repère soufflerie
    // les plaques minces situées dans le plan de symétrie (dérive, mât central) sont exclues
    // d'une coupe longitudinale 2D, où elles deviendraient des murs pleins
    // (en 3D aussi : sur une maille de plusieurs centimètres, une plaque de 1 à 2 cm dans le plan
    // de symétrie deviendrait un mur de deux cellules d'épaisseur)
    const sectionCut = (opts.mode === 'side' && !opts.silhouette) || opts.mode === '3d';
    // en 3D, les éléments d'ailerons sont remplacés par le modèle de profil (forces volumiques)
    this.useActuators = opts.mode === '3d' && !!(car.aero && car.aero.length);
    // les petits éléments minces (déflecteurs, ailettes, volutes, rétroviseurs de F1) ne sont gardés
    // dans la grille 3D que si la maille fait moins de 3 cm ; ils restent visibles et calculés en 2D
    const dropDetails = opts.mode === '3d';
    const solids = car.solids.filter((s) => !(sectionCut && s.noSection) && !(dropDetails && s.detail)).map((s) => {
      const m = new THREE.Matrix4().copy(this.yawMatrix);
      if (s.matrix) m.multiply(s.matrix);
      const tris = s.prebaked ? transformTris(s.tris, m) : trianglesOf(s.geometry, m);
      return { tris, cat: s.cat, thin: s.thin, priority: s.priority, actuator: !!s.actuator };
    });
    this.solids = this.useActuators ? solids.filter((s) => !s.actuator) : solids;
    const box = new THREE.Box3();
    for (const s of solids) {
      for (let i = 0; i < s.tris.length; i += 3) box.expandByPoint(new THREE.Vector3(s.tris[i], s.tris[i + 1], s.tris[i + 2]));
    }
    this.bounds = box;
    const L = car.dims.L, H = box.max.y, W = box.max.z - box.min.z;
    this.Lref = L;

    // Maître-couple (surface frontale) calculé sur la géométrie fine
    if (!keep || !this.area || this.areaKey !== this._geomKey(opts)) {
      this.area = projectedArea(solids, 0, { min: [box.min.x, 0, box.min.z], max: [box.max.x, box.max.y, box.max.z] }, 0.01);
      this.areaKey = this._geomKey(opts);
    }

    const q = QUALITY[opts.quality] || QUALITY.medium;
    let grid;
    if (opts.mode === '3d') {
      // demi-modèle avec plan de symétrie quand le lacet est nul (deux fois moins de cellules)
      const sym = !opts.yaw;
      const x0 = box.min.x - 0.45 * L, x1 = box.max.x + 1.05 * L;
      const Ly = Math.max(2.3 * H, 0.42 * L);
      const Lz = Math.max(2.9 * W, 0.7 * L) / (sym ? 2 : 1);
      const dx = Math.cbrt(((x1 - x0) * Ly * Lz) / q.cells3d);
      const nx = Math.round((x1 - x0) / dx), ny = Math.round(Ly / dx), nz = Math.round(Lz / dx);
      grid = { nx, ny, nz, x0, y0: 0, z0: sym ? 0 : -(nz * dx) / 2, dx, sym };
      this.lattice = D3Q19;
      this.U = 0.08;
    } else if (opts.mode === 'side') {
      const x0 = box.min.x - 0.5 * L, x1 = box.max.x + 1.5 * L;
      const Ly = Math.max(6 * H, 1.0 * L);
      const nx = q.nx2d, dx = (x1 - x0) / nx, ny = Math.round(Ly / dx);
      grid = { nx, ny, nz: 1, x0, y0: 0, z0: 0, dx };
      this.lattice = D2Q9;
      this.U = 0.1;
    } else {
      const x0 = box.min.x - 0.5 * L, x1 = box.max.x + 1.5 * L;
      const Lz = Math.max(6 * W, 1.2 * L);
      const nx = q.nx2d, dx = (x1 - x0) / nx, ny = Math.round(Lz / dx);
      grid = { nx, ny, nz: 1, x0, y0: -(ny * dx) / 2, z0: 0, dx };
      this.lattice = D2Q9;
      this.U = 0.1;
    }
    this.grid = grid;
    this.mode = opts.mode;
    // taux de blocage (information : frontières ouvertes, pas de correction appliquée)
    if (opts.mode === '3d') this.blockage = this.area / (grid.ny * grid.dx * grid.nz * grid.dx * (grid.sym ? 2 : 1));
    else if (opts.mode === 'side') this.blockage = H / (grid.ny * grid.dx);
    else this.blockage = W / (grid.ny * grid.dx);

    // Voxelisation
    let cat;
    const vs = this.solids;
    if (car.occupancy) cat = this._voxelizeOccupancy(car.occupancy, grid, opts);
    else if (opts.mode === '3d') cat = voxelize3D(vs, grid);
    else if (opts.mode === 'side') {
      if (opts.silhouette) cat = voxelizeSilhouette(vs, grid, box.min.z, box.max.z, Math.min(grid.dx, 0.02));
      else cat = voxelizeSection(vs, grid, 'side', opts.section ?? 0);
    } else cat = voxelizeSection(vs, grid, 'top', opts.section ?? 0.3);
    // retire les cellules au contact direct du sol fixe ? non : le pneu touche le sol (réaliste)
    this.cat = cat;
    let nSolid = 0;
    const catCount = new Array(9).fill(0);
    for (const c of cat) if (c) { nSolid++; catCount[c]++; }
    this.catCount = catCount;
    this.nSolid = nSolid;

    // Roues : centre et vitesse angulaire en unités réseau
    this.wheels = car.wheels.map((w, i) => {
      const c = new THREE.Vector3(...w.c).applyMatrix4(this.yawMatrix);
      const axis = new THREE.Vector3(0, 0, 1).transformDirection(this.yawMatrix);
      return { i, c, axis, R: w.R, cat: WHEEL_CAT0 + i };
    });

    // (Re)création du solveur si la grille change
    if (!keep) {
      if (this.sim) this.sim.dispose();
      this.sim = new LBM(this.gpu, {
        lattice: this.lattice, nx: grid.nx, ny: grid.ny, nz: grid.nz,
        bottom: opts.mode === 'top' ? 'farfield' : 'ground',
        symmetry: !!grid.sym,
        slipGround: opts.mode === '3d',
      });
      this.layoutKey = this._layoutKey(opts);
    }
    // champ de distance fin de la forme visible (fumée 3D : contourne ailerons et petites pièces)
    if (opts.mode === '3d') {
      const key = `${this._geomKey(opts)}|${!!grid.sym}`;
      if (this.sdfKey !== key || !this.sdf) {
        const t0 = performance.now();
        const tris = meshTriangles(car.group, this.yawMatrix);
        const vb = new THREE.Box3();
        const v = new THREE.Vector3();
        for (const tr of tris) for (let i = 0; i < tr.length; i += 3) vb.expandByPoint(v.set(tr[i], tr[i + 1], tr[i + 2]));
        this.sdf = buildSDF(tris, vb, { sym: !!grid.sym, maxDim: Math.min(512, this.gpu.max3D || 256) });
        this.sdf.ms = performance.now() - t0;
        this.sdf.version = (this.sdfVersion = (this.sdfVersion || 0) + 1);
        this.sdfKey = key;
      }
    } else {
      this.sdf = null;
      this.sdfKey = null;
    }
    this.sim.setSolid(cat, this._latticeWheels());
    this._buildActuators();
    this.applyFlow();
    if (!keep) this.restart();
    else this.resetHistory(0.6);
    return { rebuilt: !keep };
  }

  // Modèle importé : échantillonnage de la grille d'occupation fine (maillages non fermés acceptés)
  _voxelizeOccupancy(occ, grid, opts) {
    const inv = this.yawMatrix.clone().invert();
    const e = inv.elements;
    const smp = (x, y, z) => occ.sample(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
    const { nx, ny, nz = 1, x0, y0, z0, dx } = grid;
    const q = dx / 4;
    const cell = (x, y, z, dims) => {
      if (smp(x, y, z)) return 1;
      // pièces plus fines que la cellule : au moins 3 des 8 sous-points (ou 2 sur 4 en 2D)
      let n = 0;
      if (dims === 3) { for (const a of [-q, q]) for (const b of [-q, q]) for (const c of [-q, q]) n += smp(x + a, y + b, z + c); return n >= 3 ? 1 : 0; }
      if (dims === 2) { for (const a of [-q, q]) for (const b of [-q, q]) n += smp(x + a, y + b, z); return n >= 2 ? 1 : 0; }
      for (const a of [-q, q]) for (const b of [-q, q]) n += smp(x + a, y, z + b);
      return n >= 2 ? 1 : 0;
    };
    const cat = new Uint8Array(nx * ny * nz);
    if (opts.mode === '3d') {
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        cat[i + nx * (j + ny * k)] = cell(x0 + (i + 0.5) * dx, y0 + (j + 0.5) * dx, z0 + (k + 0.5) * dx, 3);
      }
    } else if (opts.mode === 'side' && opts.silhouette) {
      // silhouette : union sur toute la largeur
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        let hit = 0;
        for (let z = occ.z0 + occ.h / 2; z < occ.z0 + occ.nz * occ.h && !hit; z += occ.h) hit = smp(x0 + (i + 0.5) * dx, y0 + (j + 0.5) * dx, z);
        cat[i + nx * j] = hit;
      }
    } else if (opts.mode === 'side') {
      const zs = opts.section ?? 0;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) cat[i + nx * j] = cell(x0 + (i + 0.5) * dx, y0 + (j + 0.5) * dx, zs, 2);
    } else {
      const ys = opts.section ?? 0.3;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) cat[i + nx * j] = cell(x0 + (i + 0.5) * dx, ys, y0 + (j + 0.5) * dx, 1);
    }
    return cat;
  }

  _layoutKey(o) {
    return [o.car.id, o.mode, o.quality, o.mode === 'side' ? 0 : o.yaw, o.mode === '3d' ? !o.yaw : 0].join('|');
  }
  _geomKey(o) {
    return [o.car.id, o.car.importInfo?.serial ?? '', o.yaw, JSON.stringify(o.carParams || {})].join('|');
  }

  get wheelsResolved() {
    return this.wheels.length && this.wheels[0].R / this.grid.dx >= 6;
  }
  get floorGapCells() {
    const car = this.opts.car;
    return (car.dims.ground ?? 0.1) / this.grid.dx;
  }

  _latticeWheels() {
    const g = this.grid;
    const spin = this.opts.rotatingWheels && this.mode !== 'top';
    return this.wheels.map((w) => {
      let c;
      if (this.mode === '3d') c = [(w.c.x - g.x0) / g.dx, (w.c.y - g.y0) / g.dx, (w.c.z - g.z0) / g.dx];
      else c = [(w.c.x - g.x0) / g.dx, (w.c.y - g.y0) / g.dx, 0];
      // la rotation n'est imposée que si la roue est résolue (≥ 6 cellules par rayon)
      const om = spin && w.R / g.dx >= 6 ? this.U / (w.R / g.dx) : 0;
      const wv = this.mode === '3d' ? [w.axis.x * om, w.axis.y * om, w.axis.z * om] : [0, 0, om];
      return { c, w: wv };
    });
  }

  // Paramètres d'écoulement (sans reconstruire la géométrie)
  applyFlow(partial) {
    if (partial) Object.assign(this.opts, partial);
    const o = this.opts;
    this.air = airProps(o.tempC ?? 20, o.altitude ?? 0);
    this.V = Math.max(o.speed, 1) / 3.6;
    this.q = 0.5 * this.air.rho * this.V * this.V;
    this.Re = (this.V * this.Lref) / this.air.nu;
    this.mach = this.V / this.air.a;
    const Llb = this.Lref / this.grid.dx;
    const nuPhys = (this.U * Llb) / this.Re;
    // 3D : LES à très faible viscosité. 2D : Reynolds de grille plafonné (~2·10⁴), car la
    // turbulence 2D (cascade inverse) produirait sinon des tourbillons géants non physiques.
    const nuMin = this.mode === '3d' ? 4e-5 : (this.U * Llb) / 2e4;
    this.nuLB = Math.max(nuPhys, nuMin);
    this.ReGrid = (this.U * Llb) / this.nuLB;
    this.dt = (this.grid.dx * this.U) / this.V; // secondes réelles par pas
    this._pushParams(1);
  }

  // Démarrage progressif : écoulement initialement au repos, vitesse d'entrée montée en
  // douceur avec une viscosité élevée qui amortit les ondes acoustiques du démarrage.
  _pushParams(ramp) {
    const o = this.opts;
    const r = ramp * ramp * (3 - 2 * ramp);
    const nuWarm = 0.06;
    const nu = this.nuLB + (nuWarm - this.nuLB) * (1 - ramp) ** 2;
    const Ue = this.U * Math.max(r, 0.02);
    this.sim.setParams({
      U: Ue,
      tau0: 0.5 + 3 * nu,
      cs: this.cs * Math.min(1, ramp),
      groundU: o.rollingRoad && this.mode !== 'top' ? Ue : 0,
      turb: ramp < 1 ? 0 : (o.turbulence ?? 0) / 100,
      sponge: 0.9,
    });
    const scale = Ue / this.U;
    this.sim.setWheels(this._latticeWheels().map((w) => ({ c: w.c, w: w.w.map((v) => v * scale) })));
    this.rampNow = ramp;
  }

  restart() {
    const Llb = this.Lref / this.grid.dx;
    this.warmSteps = Math.max(300, Math.round((0.45 * Llb) / this.U));
    this.sim.reset(0);
    this.startStep = this.sim.steps;
    this._pushParams(0);
    this.resetHistory(1.6);
  }

  get warming() {
    return this.sim && this.sim.steps - this.startStep < this.warmSteps;
  }

  // skip : durée de transitoire (t*) exclue des moyennes après ce changement
  resetHistory(skip = 0.4) {
    if (this.sim) this.sim.resetMean();
    this.history = [];
    this.t0Steps = this.sim ? this.sim.steps : 0;
    this.skipT = Math.max(skip, this.skipT && this.warming ? this.skipT : 0);
    this.last = null;
  }

  // temps convectif t* = t·U/L depuis la dernière modification
  get tStar() {
    if (!this.sim) return 0;
    return ((this.sim.steps - this.t0Steps) * this.U * this.grid.dx) / this.Lref;
  }
  get tStarTotal() {
    if (!this.sim) return 0;
    return (this.sim.steps * this.U * this.grid.dx) / this.Lref;
  }

  // Avance de n pas en tenant à jour la vitesse filtrée (par paquets de `chunk` pas)
  stepFiltered(n, chunk = 5) {
    for (let done = 0; done < n; done += chunk) {
      const k = Math.min(chunk, n - done);
      this.step(k);
      this.sim.computeMacro();
      this.sim.updateFast(k, 12);
    }
  }

  step(n) {
    if (this.warming) {
      const s = this.sim.steps - this.startStep;
      this._pushParams(Math.min(1, (s + n) / this.warmSteps));
    } else if (this.rampNow !== 1) this._pushParams(1);
    this.sim.step(n);
  }

  // Mesure asynchrone des efforts et conversion en unités réelles
  async measure() {
    if (this.busy || !this.sim) return null;
    this.busy = true;
    const sim = this.sim;
    const g = this.grid;
    try {
      const car = this.opts.car;
      // point de référence : contact de l'essieu avant au sol, dans le plan médian
      const ref = new THREE.Vector3(car.dims.xF, 0, 0).applyMatrix4(this.yawMatrix);
      const refLB = this.mode === 'top'
        ? [(ref.x - g.x0) / g.dx, (ref.z - g.y0) / g.dx, 0]
        : [(ref.x - g.x0) / g.dx, (ref.y - g.y0) / g.dx, this.mode === '3d' ? (ref.z - g.z0) / g.dx : 0];
      const stepAt = sim.steps;
      const act = await this._updateActuators();
      if (sim !== this.sim) return null;
      const r = await sim.measureForces(refLB, this.mode === '3d', 8);
      if (sim !== this.sim) return null;
      const s = this._process(r, stepAt, act, refLB);
      this.last = s;
      this.history.push(s);
      if (this.history.length > 4000) this.history.splice(0, this.history.length - 4000);
      return s;
    } finally {
      this.busy = false;
    }
  }

  // ---- Ailerons modélisés (3D) : éléments de profil couplés à l'écoulement ----
  _buildActuators() {
    this.act = null;
    if (!this.useActuators || !this.sim) { if (this.sim) this.sim.setBodyMap(null); return; }
    const car = this.opts.car;
    const g = this.grid;
    const sim = this.sim;
    const M = new THREE.Matrix4().copy(this.yawMatrix).multiply(car.bodyMatrix);
    const inv = M.clone().invert();
    const sides = g.sym ? [1] : [1, -1];
    const segs = [];
    for (const w of car.aero) for (const sd of sides) for (let k = 0; k < w.segs; k++) {
      const za = w.box.z0 + ((w.box.z1 - w.box.z0) * k) / w.segs, zb = w.box.z0 + ((w.box.z1 - w.box.z0) * (k + 1)) / w.segs;
      segs.push({ w, side: sd, k, za, zb, n: 0 });
    }
    const segIndex = (w, sd, k) => segs.findIndex((t) => t.w === w && t.side === sd && t.k === k);
    const data = new Float32Array(sim.texW * sim.texH * 4);
    const pixOf = (i, j, k) => sim.pixIndex(i, j, k);
    const v = new THREE.Vector3();
    // répartition gaussienne de la force autour du quart avant de l'aile (σx ≈ 0,35 c, σy ≈ 0,5 c)
    const wsum = new Float64Array(segs.length);
    for (const w of car.aero) {
      const b = w.box;
      const xc = w.xLE + 0.45 * w.chord, yc = w.yRef;
      const sx = Math.max(0.35 * w.chord, 1.5 * g.dx), sy = Math.max(0.5 * w.chord, 2 * g.dx);
      w._k = { xc, yc, sx, sy };
      const xa = xc - 2.2 * sx, xb = xc + 2.2 * sx, ya = Math.max(0, yc - 2.2 * sy), yb = yc + 2.2 * sy;
      const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      for (const x of [xa, xb]) for (const y of [ya, yb]) for (const z of [b.z1, -b.z1]) {
        v.set(x, y, z).applyMatrix4(M);
        lo.min(v); hi.max(v);
      }
      const i0 = Math.max(0, Math.floor((lo.x - g.x0) / g.dx)), i1 = Math.min(g.nx - 1, Math.ceil((hi.x - g.x0) / g.dx));
      const j0 = Math.max(0, Math.floor((lo.y - g.y0) / g.dx)), j1 = Math.min(g.ny - 1, Math.ceil((hi.y - g.y0) / g.dx));
      const k0 = Math.max(0, Math.floor((lo.z - g.z0) / g.dx)), k1 = Math.min(g.nz - 1, Math.ceil((hi.z - g.z0) / g.dx));
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        if (this.cat[i + g.nx * (j + g.ny * k)]) continue;
        v.set(g.x0 + (i + 0.5) * g.dx, g.y0 + (j + 0.5) * g.dx, g.z0 + (k + 0.5) * g.dx).applyMatrix4(inv);
        const a = Math.abs(v.z);
        if (a < b.z0 || a > b.z1 || v.y < 0) continue;
        const ex = (v.x - xc) / sx, ey = (v.y - yc) / sy;
        const r2 = ex * ex + ey * ey;
        if (r2 > 4.84) continue;
        const sd = g.sym ? 1 : v.z >= 0 ? 1 : -1;
        const kk = Math.min(w.segs - 1, Math.floor(((a - b.z0) / (b.z1 - b.z0)) * w.segs));
        const si = segIndex(w, sd, kk);
        if (si < 0 || si >= 32) continue;
        const pi = pixOf(i, j, k) * 4;
        if (data[pi] > 0) continue;
        const wt = Math.exp(-0.5 * r2);
        data[pi] = si + 1;
        data[pi + 1] = wt;
        wsum[si] += wt;
        segs[si].n++;
      }
    }
    for (let p = 0; p < data.length; p += 4) if (data[p] > 0) data[p + 1] /= wsum[data[p] - 1];
    const toCell = (x, y, z) => {
      v.set(x, y, z).applyMatrix4(M);
      return [(v.x - g.x0) / g.dx, (v.y - g.y0) / g.dx, (v.z - g.z0) / g.dx];
    };
    // sondes d'écoulement amont, juste hors de la zone de forçage
    // trois sondes par segment (hauteurs décalées de ±0,4 corde) pour une vitesse d'entrée moyenne
    const probes = [];
    for (const sg of segs) for (const dy of [-0.4, 0, 0.4]) probes.push(toCell(sg.w._k.xc - 2.3 * sg.w._k.sx, Math.max(0.03, sg.w.yRef + dy * sg.w.chord), sg.side * (sg.za + sg.zb) / 2));
    const centers = segs.map((sg) => toCell(sg.w._k.xc, sg.w.yRef, sg.side * (sg.za + sg.zb) / 2));
    this.act = { segs, probes, centers };
    sim.setBodyMap(data);
    sim.setBodyForces([]);
  }

  async _updateActuators() {
    const a = this.act;
    if (!a) return null;
    const sim = this.sim;
    const g = this.grid;
    sim.computeMacro();
    const buf = await sim.probe(a.probes);
    const Uc = sim.params.U;
    const fluid = [];
    const out = [];
    a.segs.forEach((sg, i) => {
      const w = sg.w;
      let ux = 0, uy = 0;
      for (let k = 0; k < 3; k++) { ux += buf[(3 * i + k) * 4] * Uc / 3; uy += buf[(3 * i + k) * 4 + 1] * Uc / 3; }
      const phi = Math.atan2(uy, Math.max(ux, 1e-6));
      const alpha = w.dAlpha - (phi * 180) / Math.PI;
      const Cl = Math.min(w.Clmax, Math.max(-0.5, w.Cl0 + w.slope * alpha));
      const ARe = w.AR * 1.6;
      const CL = (Cl * ARe) / (ARe + 2);
      const CD = w.Cd0 + w.k * Cl * Cl + (CL * CL) / (Math.PI * ARe);
      const area = (w.chord / g.dx) * ((sg.zb - sg.za) / g.dx);
      const q = 0.5 * (ux * ux + uy * uy);
      const F = sg.n ? [q * area * (CL * Math.sin(phi) + CD * Math.cos(phi)), q * area * (-CL * Math.cos(phi) + CD * Math.sin(phi)), 0] : [0, 0, 0];
      fluid.push([-F[0], -F[1], 0]);
      out.push({ cat: w.cat, F, c: a.centers[i], CL, CD, alpha });
    });
    sim.setBodyForces(fluid);
    return out;
  }

  _process(r, stepAt, act = null, refLB = [0, 0, 0]) {
    const g = this.grid;
    const U = this.U;
    const rho = this.air.rho;
    const symF = g.sym ? 2 : 1; // demi-modèle : efforts du véhicule complet
    const scale = this.mode === '3d'
      ? rho * (this.V / U) ** 2 * g.dx * g.dx * symF // N
      : rho * (this.V / U) ** 2 * g.dx; // N/m
    const mScale = scale * g.dx;
    const comps = [];
    let Fx = 0, Fy = 0, Fz = 0, Mz = 0;
    for (let c = 1; c <= 8; c++) {
      const v = r.cats[c - 1] || [0, 0, 0, 0];
      let fx = v[0], fy = v[1], fz = v[2];
      if (this.mode === 'top') { fz = fy; fy = 0; }
      if (g.sym) fz = 0;
      comps.push({ cat: c, Fx: fx * scale, Fy: fy * scale, Fz: fz * scale, M: v[3] * mScale });
      Fx += fx; Fy += fy; Fz += fz; Mz += v[3];
    }
    if (act) {
      for (const e of act) {
        const m = (e.c[0] - refLB[0]) * e.F[1] - (e.c[1] - refLB[1]) * e.F[0];
        const cp = comps[e.cat - 1];
        cp.Fx += e.F[0] * scale; cp.Fy += e.F[1] * scale; cp.M += m * mScale;
        Fx += e.F[0]; Fy += e.F[1]; Mz += m;
      }
    }
    const kb = 1;
    const F = { x: Fx * scale * kb, y: Fy * scale * kb, z: Fz * scale * kb };
    const M = Mz * mScale * kb; // tangage (side/3d) ou lacet (top) autour du contact avant
    const refLen = this.mode === '3d' ? this.area : this.Lref;
    const qA = this.q * refLen;
    const out = {
      step: stepAt,
      tStar: ((stepAt - this.t0Steps) * U * g.dx) / this.Lref,
      drag: F.x,
      lift: F.y,
      side: F.z,
      Cx: F.x / qA,
      Cz: F.y / qA,
      Cy: F.z / qA,
      comps,
      M,
    };
    if (this.mode !== 'top') {
      const wb = this.opts.car.dims.wheelbase * (this.mode === '3d' ? Math.cos(((this.opts.yaw || 0) * Math.PI) / 180) : 1);
      const Rr = -M / wb;
      const Rf = -F.y - Rr;
      out.loadFront = Rf;
      out.loadRear = Rr;
      out.balance = Math.abs(F.y) > 1e-9 ? Rf / (Rf + Rr) : 0.5;
    }
    if (this.mode === '3d') {
      out.moments = r.moment.map((m, k) => (g.sym && k < 2 ? 0 : m * mScale));
    }
    return out;
  }

  // Moyenne glissante sur une fenêtre de temps convectif (exclut le transitoire)
  stats(windowT = 1.6, skipT = this.skipT ?? 0.6) {
    const h = this.history;
    if (!h.length) return null;
    const tEnd = h[h.length - 1].tStar;
    if (tEnd < skipT) return { transient: true, tEnd, n: 0, mean: {}, std: {} };
    const sel = h.filter((s) => s.tStar >= Math.max(skipT, tEnd - windowT));
    const use = sel.length >= 3 ? sel : h.slice(-Math.min(h.length, 3));
    const keys = ['drag', 'lift', 'side', 'Cx', 'Cz', 'Cy', 'M', 'loadFront', 'loadRear', 'balance'];
    const mean = {}, std = {};
    for (const k of keys) {
      const vals = use.map((s) => s[k]).filter((v) => v !== undefined && isFinite(v));
      if (!vals.length) continue;
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      mean[k] = m;
      std[k] = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
    }
    const comps = [];
    for (let c = 0; c < 8; c++) {
      const fx = use.reduce((a, s) => a + s.comps[c].Fx, 0) / use.length;
      const fy = use.reduce((a, s) => a + s.comps[c].Fy, 0) / use.length;
      const fz = use.reduce((a, s) => a + s.comps[c].Fz, 0) / use.length;
      comps.push({ cat: c + 1, Fx: fx, Fy: fy, Fz: fz });
    }
    mean.comps = comps;
    // convergence : écart entre les deux moitiés de la fenêtre
    let converged = false;
    if (tEnd > skipT + windowT * 0.8 && use.length > 8) {
      const half = Math.floor(use.length / 2);
      const a = use.slice(0, half), b = use.slice(half);
      const ma = a.reduce((s, v) => s + v.drag, 0) / a.length;
      const mb = b.reduce((s, v) => s + v.drag, 0) / b.length;
      converged = Math.abs(ma - mb) < 0.05 * Math.abs(mean.drag || 1);
    }
    return { mean, std, n: use.length, tEnd, converged };
  }

  // Champ affiché : instantané ou moyenne temporelle
  field(mean) {
    return mean ? this.sim.mean : this.sim.macro;
  }
  updateMean(steps) {
    // constante de temps ≈ 0,5 t* (en pas de calcul)
    this.sim.updateMean(steps, (0.5 * this.Lref) / (this.grid.dx * this.U));
  }

  // Coordonnées cellule (flottantes) d'un point du monde
  worldToCell(p) {
    const g = this.grid;
    if (this.mode === 'top') return [(p.x - g.x0) / g.dx, (p.z - g.y0) / g.dx, 0];
    return [(p.x - g.x0) / g.dx, (p.y - g.y0) / g.dx, this.mode === '3d' ? (p.z - g.z0) / g.dx : 0];
  }

  dispose() {
    if (this.sim) this.sim.dispose();
    this.sim = null;
  }
}

function transformTris(src, m) {
  const out = new Float32Array(src.length);
  const e = m.elements;
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    out[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    out[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    out[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  return out;
}
