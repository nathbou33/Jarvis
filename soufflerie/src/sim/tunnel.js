// Pilotage de la soufflerie : domaine de calcul, voxelisation de la voiture,
// passage unités physiques ↔ unités réseau, mesure et dépouillement des efforts.
import * as THREE from 'three';
import { LBM, WHEEL_CAT0 } from './lbm.js';
import { D2Q9, D3Q19 } from './lattice.js';
import { trianglesOf, voxelize3D, voxelizeSection, voxelizeSilhouette, projectedArea } from '../geometry/voxelize.js';

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
    const solids = car.solids.map((s) => {
      const m = new THREE.Matrix4().copy(this.yawMatrix);
      if (s.matrix) m.multiply(s.matrix);
      return { tris: trianglesOf(s.geometry, m), cat: s.cat, thin: s.thin, priority: s.priority };
    });
    this.solids = solids;
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
    if (opts.mode === '3d') cat = voxelize3D(solids, grid);
    else if (opts.mode === 'side') {
      if (opts.silhouette) cat = voxelizeSilhouette(solids, grid, box.min.z, box.max.z, Math.min(grid.dx, 0.02));
      else cat = voxelizeSection(solids, grid, 'side', opts.section ?? 0);
    } else cat = voxelizeSection(solids, grid, 'top', opts.section ?? 0.3);
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
    this.sim.setSolid(cat, this._latticeWheels());
    this.applyFlow();
    if (!keep) this.restart();
    else this.resetHistory(0.6);
    return { rebuilt: !keep };
  }

  _layoutKey(o) {
    return [o.car.id, o.mode, o.quality, o.mode === 'side' ? 0 : o.yaw, o.mode === '3d' ? !o.yaw : 0].join('|');
  }
  _geomKey(o) {
    return [o.car.id, o.yaw, JSON.stringify(o.carParams || {})].join('|');
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
      const r = await sim.measureForces(refLB, this.mode === '3d', 8);
      if (sim !== this.sim) return null;
      const s = this._process(r, stepAt);
      this.last = s;
      this.history.push(s);
      if (this.history.length > 4000) this.history.splice(0, this.history.length - 4000);
      return s;
    } finally {
      this.busy = false;
    }
  }

  _process(r, stepAt) {
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
