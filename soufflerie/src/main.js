// Soufflerie numérique — contrôleur principal.
import * as THREE from 'three';
import { GPU } from './sim/gpgpu.js';
import { Tunnel, QUALITY } from './sim/tunnel.js';
import { CARS } from './geometry/cars.js';
import { View2D, MODES_2D } from './viz/view2d.js';
import { View3D, SMOKE_MODES, SLICE_FIELDS } from './viz/view3d.js';
import { LineChart, fmt } from './ui/charts.js';
import { el, group, slider, toggle, chips, select, toast } from './ui/controls.js';
import { infoHTML } from './ui/info.js';

const $ = (id) => document.getElementById(id);
const nf = (v, d = 0) => (isFinite(v) ? v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
const inIframe = (() => { try { return window.self !== window.top; } catch { return true; } })();
const coarse = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 700;

// ---------------------------------------------------------------------------
// État
const state = {
  carId: 'f1',
  dim: '3d',
  plane: 'side', // side | silhouette | top
  sectionZ: 0,
  sectionH: { f1: 0.3, hyper: 0.4, road: 0.55 },
  speed: CARS.f1.speed,
  yaw: 0,
  rollingRoad: true,
  rotatingWheels: true,
  tempC: 20,
  altitude: 0,
  turbulence: 0,
  quality: coarse ? 'medium' : 'high',
  running: true,
  carParams: Object.fromEntries(Object.entries(CARS).map(([id, c]) => [id, Object.fromEntries(c.setup.map((s) => [s.key, s.def]))])),
  tab: 'essai',
};
// paramètres d'URL (liens directs) : ?car=hyper&dim=2d&q=low&v=250
try {
  const u = new URLSearchParams(location.search);
  if (CARS[u.get('car')]) { state.carId = u.get('car'); state.speed = CARS[state.carId].speed; }
  if (['2d', '3d'].includes(u.get('dim'))) state.dim = u.get('dim');
  if (QUALITY[u.get('q')]) state.quality = u.get('q');
  if (u.get('v')) state.speed = Math.min(400, Math.max(20, Number(u.get('v')) || state.speed));
  if (['side', 'silhouette', 'top'].includes(u.get('plane'))) state.plane = u.get('plane');
  if (u.get('z')) state.sectionZ = Number(u.get('z')) || 0;
} catch { /* sans effet */ }

// ---------------------------------------------------------------------------
// Rendu
const canvas = $('gl');
const overlay = $('overlay');
const viewport = $('viewport');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  const gl = renderer.getContext();
  if (!(gl instanceof WebGL2RenderingContext) || !gl.getExtension('EXT_color_buffer_float')) throw new Error('float');
} catch (e) {
  fatal('Votre appareil ne prend pas en charge le calcul GPU requis', 'La soufflerie a besoin de WebGL 2 avec rendu en virgule flottante (EXT_color_buffer_float). Essayez un navigateur récent (Chrome, Edge, Safari 15+, Firefox) ou un autre appareil.');
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); fatal('Le contexte graphique a été perdu', 'Le GPU a interrompu le calcul (mémoire insuffisante ou mise en veille). Rechargez la page, éventuellement en qualité « Rapide ».'); });

const gpu = new GPU(renderer);
const tunnel = new Tunnel(gpu);
const view2d = new View2D(gpu, overlay);
const view3d = new View3D(gpu, canvas);
let car = null;
let busy = false;

function fatal(title, text) {
  const f = $('fatal');
  f.innerHTML = `<div><h2>${title}</h2><p>${text}</p></div>`;
  f.hidden = false;
  $('busy').hidden = true;
}

// ---------------------------------------------------------------------------
// Construction de l'essai
function setupOpts() {
  const mode = state.dim === '3d' ? '3d' : state.plane === 'top' ? 'top' : 'side';
  return {
    car, mode, quality: state.quality, yaw: state.yaw,
    section: mode === 'top' ? state.sectionH[state.carId] : state.sectionZ,
    silhouette: state.plane === 'silhouette',
    speed: state.speed, tempC: state.tempC, altitude: state.altitude,
    rollingRoad: state.rollingRoad, rotatingWheels: state.rotatingWheels, turbulence: state.turbulence,
    carParams: state.carParams[state.carId],
  };
}

let rebuildQueued = null;
function rebuild({ newCar = false } = {}) {
  if (rebuildQueued) { rebuildQueued.newCar ||= newCar; return; }
  rebuildQueued = { newCar };
  busy = true;
  $('busy').hidden = false;
  $('busyText').textContent = newCar ? 'Construction de la géométrie…' : 'Voxelisation du modèle…';
  setTimeout(() => {
    const q = rebuildQueued;
    rebuildQueued = null;
    try {
      if (q.newCar || !car || car.id !== state.carId) {
        car = CARS[state.carId].build(state.carParams[state.carId]);
      }
      const res = tunnel.setup(setupOpts());
      if (state.dim === '3d') {
        view3d.setCar(car, tunnel.yawMatrix);
        view3d.attach(tunnel);
        view3d.setSurfaceCp(view3d.settings.surfaceCp);
        view3d.controls.enabled = true;
      } else {
        view3d.controls.enabled = false;
        view2d.attach(tunnel);
        if (res.rebuilt) view2d.fitted = null;
        view2d.probe = null;
        view2d.readback = null;
      }
      spf = state.dim === '3d' ? 3 : 10;
      stepsSinceMeasure = 0;
      lastResults = null;
      renderAllPanels();
    } catch (e) {
      console.error(e);
      fatal('Impossible de préparer la simulation', String(e.message || e));
    }
    busy = false;
    $('busy').hidden = true;
  }, 30);
}

function applyFlow() {
  if (!tunnel.sim) return;
  tunnel.applyFlow({
    speed: state.speed, tempC: state.tempC, altitude: state.altitude,
    rollingRoad: state.rollingRoad, rotatingWheels: state.rotatingWheels, turbulence: state.turbulence,
  });
  tunnel.resetHistory();
  lastResults = null;
}

// ---------------------------------------------------------------------------
// Boucle de calcul
let spf = 3;
let lastT = performance.now();
let frameMs = 16;
let stepsSinceMeasure = 0;
let lastResults = null;
let lastUi = 0, lastCharts = 0, lastReadback = 0;
let stepRate = 0, stepAcc = 0, stepClock = performance.now();
let size = { w: 0, h: 0 };

function resize() {
  const r = viewport.getBoundingClientRect();
  const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
  if (w !== size.w || h !== size.h) {
    size = { w, h };
    renderer.setSize(w, h, false);
    view2d.fitted = null;
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = now - lastT;
  lastT = now;
  if (busy || !tunnel.sim || !$('fatal').hidden) return;
  resize();
  frameMs = frameMs * 0.92 + Math.min(dt, 200) * 0.08;
  let steps = 0;
  if (state.running) {
    steps = Math.max(1, Math.round(spf));
    if (state.dim === '2d') tunnel.stepFiltered(steps, 5);
    else tunnel.step(steps);
    stepsSinceMeasure += steps;
    stepAcc += steps;
  }
  tunnel.sim.computeMacro();
  tunnel.updateMean(steps);
  if (state.dim === '2d') {
    if (steps) view2d.advect(steps);
    view2d.render(renderer, size.w, size.h);
    view2d.drawOverlay(size.w, size.h);
  } else {
    view3d.update(steps);
    view3d.render(renderer, size.w, size.h);
  }
  // pas de calcul adaptatifs (≈ 30 images/s visées)
  if (state.running) {
    const maxSpf = state.dim === '3d' ? 24 : 60;
    if (frameMs > 40 && spf > 1) spf = Math.max(1, spf * 0.9);
    else if (frameMs < 26) spf = Math.min(maxSpf, spf * 1.05 + 0.05);
  }
  // mesures
  const measureEvery = state.dim === '3d' ? 12 : 30;
  if (state.running && stepsSinceMeasure >= measureEvery && !tunnel.busy) {
    stepsSinceMeasure = 0;
    tunnel.measure().then((r) => { if (r) lastResults = r; }).catch((e) => console.warn(e));
  }
  if (now - stepClock > 1000) {
    stepRate = (stepAcc * 1000) / (now - stepClock);
    stepAcc = 0;
    stepClock = now;
  }
  // relecture CPU (2D)
  if (state.dim === '2d' && now - lastReadback > 700 && (view2d.settings.streamlines || view2d.probe || state.tab === 'mesures')) {
    lastReadback = now;
    view2d.refreshReadback().then(() => { updateProbe(); if (state.tab === 'mesures') updateProfileCharts(); }).catch(() => {});
  }
  if (now - lastUi > 250) { lastUi = now; updateHud(); if (state.tab === 'mesures') updateMeasures(); }
  if (now - lastCharts > 600 && state.tab === 'mesures') { lastCharts = now; updateHistoryCharts(); }
  updateLegend();
}

// ---------------------------------------------------------------------------
// Barre supérieure
function buildTopbar() {
  const seg = $('carSeg');
  seg.innerHTML = '';
  for (const [id, c] of Object.entries(CARS)) {
    const b = el('button', { type: 'button', role: 'radio', 'aria-checked': String(id === state.carId) }, c.name === 'Citadine compacte' ? 'Citadine' : c.name);
    b.addEventListener('click', () => {
      if (state.carId === id) return;
      state.carId = id;
      state.speed = CARS[id].speed;
      for (const o of seg.children) o.setAttribute('aria-checked', String(o === b));
      rebuild({ newCar: true });
    });
    seg.append(b);
  }
  const dimSeg = $('dimSeg');
  for (const b of dimSeg.children) {
    b.setAttribute('aria-checked', String(b.dataset.v === state.dim));
    b.addEventListener('click', () => {
      if (state.dim === b.dataset.v) return;
      state.dim = b.dataset.v;
      for (const o of dimSeg.children) o.setAttribute('aria-checked', String(o === b));
      overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
      $('camPresets').hidden = state.dim !== '3d';
      $('probeCard').hidden = true;
      rebuild();
    });
  }
  $('playBtn').addEventListener('click', () => {
    state.running = !state.running;
    $('playBtn').classList.toggle('paused', !state.running);
    $('playBtn').setAttribute('aria-label', state.running ? 'Pause' : 'Reprendre');
  });
  $('resetBtn').addEventListener('click', () => {
    if (!tunnel.sim) return;
    tunnel.restart();
    lastResults = null;
    if (state.dim === '2d') view2d.clearDye(); else view3d.resetParticles();
    toast('Écoulement réinitialisé');
  });
  $('infoBtn').addEventListener('click', () => { $('infoBody').innerHTML = infoHTML(tunnel); $('infoSheet').hidden = false; $('infoClose').focus(); });
  $('infoClose').addEventListener('click', () => { $('infoSheet').hidden = true; });
  $('infoSheet').addEventListener('click', (e) => { if (e.target === $('infoSheet')) $('infoSheet').hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('infoSheet').hidden = true;
    if (e.key === ' ' && e.target === document.body) { e.preventDefault(); $('playBtn').click(); }
  });
  // onglets
  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      for (const o of document.querySelectorAll('.tabs button')) o.setAttribute('aria-selected', String(o === b));
      for (const t of ['essai', 'mesures', 'visu']) $(`tab-${t}`).hidden = t !== state.tab;
      if (state.tab === 'mesures') { updateMeasures(); updateHistoryCharts(); updateProfileCharts(); }
    });
  }
  // caméras
  const cp = $('camPresets');
  for (const [k, t] of [['iso', '3/4'], ['side', 'Profil'], ['front', 'Face'], ['rear', 'Arrière'], ['top', 'Dessus'], ['low', 'Ras du sol']]) {
    cp.append(el('button', { type: 'button', onclick: () => view3d.setCameraPreset(k) }, t));
  }
}

// ---------------------------------------------------------------------------
// Panneau « Essai »
function renderEssai() {
  const root = $('tab-essai');
  root.innerHTML = '';
  const c = CARS[state.carId];
  const d = car?.dims;
  root.append(el('div', { class: 'car-card' },
    el('h3', {}, c.name),
    el('p', {}, c.blurb),
    d ? el('div', { class: 'dims' },
      el('span', {}, el('b', {}, 'L'), `${nf(d.L, 2)} m`),
      el('span', {}, el('b', {}, 'l'), `${nf(d.W, 2)} m`),
      el('span', {}, el('b', {}, 'h'), `${nf(d.H, 2)} m`),
      el('span', {}, el('b', {}, 'Emp.'), `${nf(d.wheelbase, 2)} m`),
      d.mass ? el('span', {}, el('b', {}, 'Masse'), `${nf(d.mass)} kg`) : null,
      tunnel.area ? el('span', {}, el('b', {}, 'S'), `${nf(tunnel.area, 2)} m²`) : null) : null));

  // vitesse
  const ms = el('span', { class: 'ms' });
  const num = el('span', { class: 'num' });
  const showSpeed = () => {
    num.textContent = nf(state.speed);
    ms.innerHTML = `${nf(state.speed / 3.6, 1)} m/s<br>q = ${nf(tunnel.q || 0)} Pa`;
  };
  const sp = slider({
    label: 'Vitesse du vent', min: 20, max: 400, step: 5, value: state.speed, unit: 'km/h',
    onInput: (v) => { state.speed = v; showSpeed(); applyFlow(); presets.set(String(v)); showSpeed(); },
  });
  sp.querySelector('.field-head').hidden = true;
  const presets = chips({
    options: [['90', '90'], ['130', '130'], ['200', '200'], ['300', '300'], ['350', '350']].map(([v, t]) => [v, `${t} km/h`]),
    value: String(state.speed),
    onChange: (v) => { state.speed = Number(v); sp.set(state.speed); applyFlow(); showSpeed(); },
  });
  presets.className = 'presets';
  showSpeed();
  root.append(group('Vitesse', el('div', { class: 'speed-block' }, el('div', { class: 'speed-readout' }, num, el('span', { class: 'u' }, 'km/h'), ms), sp, presets)));

  // plan d'étude (2D) ou lacet (3D)
  if (state.dim === '2d') {
    const box = tunnel.bounds;
    const half = box ? (box.max.z - box.min.z) / 2 : 1;
    const zSl = slider({
      label: 'Position latérale de la coupe', min: -Math.round(half * 100) / 100, max: Math.round(half * 100) / 100, step: 0.01, value: state.sectionZ, unit: 'm',
      format: (v) => nf(Number(v), 2), onChange: (v) => { state.sectionZ = v; rebuild(); },
    });
    const hSl = slider({
      label: 'Hauteur de la coupe', min: 0.04, max: Math.round((box ? box.max.y : 1) * 100) / 100, step: 0.01, value: state.sectionH[state.carId], unit: 'm',
      format: (v) => nf(Number(v), 2), onChange: (v) => { state.sectionH[state.carId] = v; rebuild(); },
    });
    const yawSl = slider({ label: 'Lacet (vent de travers)', min: -15, max: 15, step: 1, value: state.yaw, unit: '°', onChange: (v) => { state.yaw = v; rebuild(); } });
    zSl.hidden = state.plane !== 'side';
    hSl.hidden = yawSl.hidden = state.plane !== 'top';
    root.append(group('Plan d\'étude',
      chips({
        options: [['side', 'Coupe longitudinale'], ['silhouette', 'Silhouette'], ['top', 'Vue de dessus']], value: state.plane,
        onChange: (v) => { state.plane = v; rebuild(); },
      }),
      el('p', { class: 'hint' }, state.plane === 'side' ? 'Coupe verticale dans le plan choisi (0 = plan de symétrie). Une coupe 2D ne laisse pas l\'air contourner la voiture par les côtés : les valeurs sont des coefficients de section, à comparer entre eux.' : state.plane === 'silhouette' ? 'Profil complet projeté, roues comprises : le dessous de caisse est fermé au droit des roues.' : 'Coupe horizontale : contournement latéral, effet du lacet.'),
      zSl, hSl, yawSl));
  } else {
    root.append(group('Plateau tournant',
      slider({ label: 'Lacet (vent de travers)', min: -15, max: 15, step: 1, value: state.yaw, unit: '°', onChange: (v) => { state.yaw = v; rebuild(); } })));
  }

  // réglages de la voiture
  const setupCtl = c.setup.map((s) => {
    const p = state.carParams[state.carId];
    const commit = (v) => { p[s.key] = v; rebuild({ newCar: true }); };
    if (s.type === 'choice') return el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('label', {}, s.label)), chips({ options: s.options, value: p[s.key], onChange: commit }));
    if (s.type === 'toggle') return toggle({ label: s.label, checked: p[s.key], onChange: commit });
    return slider({ label: s.label, min: s.min, max: s.max, step: s.step, value: p[s.key], unit: s.unit, format: (v) => nf(Number(v), s.step < 1 ? 1 : 0), onChange: commit });
  });
  root.append(group('Réglages de la voiture', ...setupCtl,
    el('div', { class: 'btn-row' }, el('button', { type: 'button', class: 'btn', onclick: () => { state.carParams[state.carId] = Object.fromEntries(c.setup.map((s) => [s.key, s.def])); rebuild({ newCar: true }); } }, 'Réglages d\'origine'))));

  // conditions de soufflerie
  const g = tunnel.grid;
  const res = [];
  if (g && car) {
    const perL = tunnel.Lref / g.dx;
    const gap = car.dims.ground / g.dx;
    const rCells = car.wheels[0].R / g.dx;
    res.push(`Maille ${nf(g.dx * 1000)} mm · ${nf(perL)} cellules sur la longueur · garde au sol ${nf(gap, 1)} cellule${gap >= 2 ? 's' : ''}`);
    if (state.dim === '3d') res.push(g.sym ? 'Demi-modèle avec plan de symétrie (lacet nul).' : 'Modèle complet (lacet non nul).');
    res.push(`Taux de blocage ${nf((tunnel.blockage || 0) * 100, 1)} % (veine à frontières ouvertes).`);
    if (tunnel.useActuators) res.push('Ailerons : modèle de profil couplé à l\'écoulement calculé (polaire d\'aile multi-éléments, incidence de réglage, vitesse et angle d\'attaque locaux).');
    if (gap < 2 && state.plane !== 'top') res.push('<b style="color:var(--warn)">Soubassement non résolu</b> : l\'effet de sol est sous-estimé. Augmentez la finesse dans « Avancé ».');
    if (state.rotatingWheels && rCells < 6 && state.plane !== 'top') res.push(`Roues : ${nf(rCells, 1)} cellules par rayon, rotation non imposée sous 6 cellules (roues fixes).`);
  }
  root.append(group('Veine d\'essai',
    toggle({
      label: 'Sol roulant',
      sub: state.dim === '3d' ? 'Pas de couche limite au sol (paroi glissante)' : 'Tapis à la vitesse du vent, comme sur route',
      checked: state.rollingRoad, onChange: (v) => { state.rollingRoad = v; applyFlow(); },
    }),
    toggle({ label: 'Roues en rotation', sub: 'Vitesse périphérique = vitesse du vent', checked: state.rotatingWheels, onChange: (v) => { state.rotatingWheels = v; applyFlow(); renderEssai(); } }),
    res.length ? el('p', { class: 'hint', html: res.join('<br>') }) : null));

  const adv = el('details', { class: 'adv' }, el('summary', {}, 'Avancé'), el('div', { class: 'inner' },
    slider({ label: 'Température de l\'air', min: -10, max: 45, step: 1, value: state.tempC, unit: '°C', onInput: (v) => { state.tempC = v; applyFlow(); } }),
    slider({ label: 'Altitude', min: 0, max: 3000, step: 50, value: state.altitude, unit: 'm', onInput: (v) => { state.altitude = v; applyFlow(); } }),
    slider({ label: 'Turbulence d\'entrée', min: 0, max: 5, step: 0.1, value: state.turbulence, unit: '%', format: (v) => nf(Number(v), 1), onInput: (v) => { state.turbulence = v; applyFlow(); } }),
    select({
      label: 'Finesse du maillage', value: state.quality,
      options: Object.entries(QUALITY).map(([k, q]) => [k, `${q.label} · ${state.dim === '3d' ? `${nf(q.cells3d / 1000)} k cellules` : `${q.nx2d} cellules de long`}`]),
      onChange: (v) => { state.quality = v; rebuild(); },
    }),
    el('p', { class: 'hint', id: 'airInfo' })));
  root.append(adv);
  updateAirInfo();
}

function updateAirInfo() {
  const a = tunnel.air;
  const n = $('airInfo');
  if (!a || !n) return;
  n.innerHTML = `ρ = ${nf(a.rho, 3)} kg/m³ · μ = ${nf(a.mu * 1e5, 3)}·10⁻⁵ Pa·s · Mach ${nf(tunnel.mach, 3)}`;
}

// ---------------------------------------------------------------------------
// Panneau « Mesures »
let charts = {};
function renderMesures() {
  const root = $('tab-mesures');
  root.innerHTML = '';
  charts = {};
  const two = state.dim === '2d';
  root.append(el('div', { class: 'group' },
    el('div', { class: 'status-line', id: 'mStatus' }),
    el('div', { class: 'progress' }, el('i', { id: 'mProgress' }))));
  root.append(el('div', { class: 'kpis', id: 'kpis' }));
  if (!(two && state.plane === 'top')) {
    root.append(group('Équilibre aérodynamique', el('div', { id: 'balance' })));
  }
  root.append(group('Répartition par composant', el('table', { class: 'table', id: 'compTable' })));
  const hist = group(two ? 'Historique des coefficients 2D' : 'Historique des coefficients');
  const lg = el('div', { class: 'chart-legend' }, el('span', {}, el('i', { style: 'background:var(--series-1)' }), 'Instantané'), el('span', {}, el('i', { style: 'background:var(--ink-2);height:0;border-top:2px dashed var(--ink-2)' }), 'Moyenne'));
  hist.append(lg);
  const cxBox = el('div'), czBox = el('div');
  hist.append(el('div', { class: 'hint' }, 'Cx en fonction de t* = t·V/L'), cxBox, el('div', { class: 'hint' }, two && state.plane === 'top' ? 'Cy (force latérale)' : 'Cz (négatif = appui)'), czBox);
  root.append(hist);
  charts.cx = new LineChart(cxBox, { height: 120, series: [{ name: 'Cx', color: getVar('--series-1') }], xName: 't*', yFmt: (v) => fmt(v, 2), xFmt: (v) => fmt(v, 1) });
  charts.cz = new LineChart(czBox, { height: 120, series: [{ name: 'Cz', color: getVar('--series-2') }], xName: 't*', yFmt: (v) => fmt(v, 2), xFmt: (v) => fmt(v, 1) });
  if (two && state.plane !== 'top') {
    const cpBox = el('div');
    const g = group('Distribution de pression pariétale', el('div', { class: 'chart-legend' },
      el('span', {}, el('i', { style: 'background:var(--series-1)' }), 'Dessus'),
      el('span', {}, el('i', { style: 'background:var(--series-2)' }), 'Dessous')), el('div', { class: 'hint' }, 'Cp en fonction de x/L (axe inversé, convention aéronautique)'), cpBox);
    root.append(g);
    charts.cp = new LineChart(cpBox, { height: 170, invertY: true, endDot: false, series: [{ name: 'Dessus', color: getVar('--series-1') }, { name: 'Dessous', color: getVar('--series-2') }], xName: 'x/L', yFmt: (v) => fmt(v, 1), xFmt: (v) => fmt(v, 1) });
  }
  if (two) {
    const wBox = el('div');
    const wake = group('Profil de sillage',
      el('div', { class: 'hint' }, `u/V∞ en fonction de ${state.plane === 'top' ? 'la position latérale z' : 'la hauteur y'} (m), derrière la voiture`),
      slider({ label: 'Station derrière la voiture', min: 0.05, max: 1.5, step: 0.05, value: view2d.wakeX ?? 0.35, unit: '× L', format: (v) => nf(Number(v), 2), onInput: (v) => { view2d.wakeX = v; updateProfileCharts(); } }),
      toggle({ label: 'Afficher la station sur la vue', checked: !!view2d.showWake, onChange: (v) => { view2d.showWake = v; } }),
      wBox);
    root.append(wake);
    charts.wake = new LineChart(wBox, { height: 150, endDot: false, series: [{ name: 'u/V∞', color: getVar('--series-3') }], xName: state.plane === 'top' ? 'z (m)' : 'y (m)', yFmt: (v) => fmt(v, 2), xFmt: (v) => fmt(v, 1) });
  }
  root.append(group('Conditions', el('div', { class: 'hint', id: 'conditions' })));
  const btns = el('div', { class: 'btn-row' },
    el('button', { type: 'button', class: 'btn primary', onclick: copyResults }, 'Copier les résultats'));
  if (!inIframe) {
    btns.append(el('button', { type: 'button', class: 'btn', onclick: exportCSV }, 'Exporter CSV'));
    btns.append(el('button', { type: 'button', class: 'btn', onclick: screenshot }, 'Capture'));
  }
  root.append(group('Export', btns));
  updateMeasures();
}

const getVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function liftWord(lift) { return lift > 0 ? 'Portance' : 'Appui'; }

function updateMeasures() {
  if (!$('kpis')) return;
  const st = tunnel.stats();
  const two = state.dim === '2d';
  const top = two && state.plane === 'top';
  const unitF = two ? 'N/m' : 'N';
  const tS = tunnel.tStar;
  $('mStatus').innerHTML = st && !st.transient
    ? `<span class="dot ${st.converged ? 'ok' : ''} ${state.running ? '' : 'paused'}"></span> ${st.converged ? 'Stabilisé' : 'Établissement de l\'écoulement'} · t* = <span class="num">${nf(tS, 2)}</span> · moyenne sur <span class="num">${st.n}</span> mesures`
    : `<span class="dot"></span> Établissement de l'écoulement · t* = <span class="num">${nf(tS, 2)}</span>`;
  $('mProgress').style.width = `${Math.min(100, (tS / 2.2) * 100)}%`;
  const m = st && !st.transient ? st.mean : {};
  const sd = st && !st.transient ? st.std : {};
  const k = [];
  const kpi = (label, value, unit, sub, wide) => el('div', { class: `kpi${wide ? ' wide' : ''}` }, el('div', { class: 'k' }, label), el('div', { class: 'v', html: `${value}<span class="u">${unit}</span>` }), sub ? el('div', { class: 's', html: sub }) : null);
  const lift = m.lift ?? NaN;
  k.push(kpi('Traînée', nf(m.drag), unitF, `± ${nf(sd.drag)} ${unitF}${two ? '' : ` · SCx ${nf((m.Cx ?? NaN) * tunnel.area, 3)} m²`}`));
  if (!top) k.push(kpi(liftWord(lift), nf(Math.abs(lift)), unitF, two ? `${nf(Math.abs(lift) / 9.81, 1)} kg/m` : `${nf(Math.abs(lift) / 9.81)} kg · SCz ${nf((m.Cz ?? NaN) * tunnel.area, 3)} m²`));
  else k.push(kpi('Force latérale', nf(m.side), unitF, `Cy ${nf(m.Cy, 3)}`));
  k.push(kpi(two ? 'Cx (2D, réf. L)' : 'Cx', nf(m.Cx, 3), '', `± ${nf(sd.Cx, 3)}${two ? '' : ` · S = ${nf(tunnel.area, 2)} m²`}`));
  if (!top) k.push(kpi(two ? 'Cz (2D, réf. L)' : 'Cz', nf(m.Cz, 3), '', `Finesse L/D ${nf(Math.abs((m.lift ?? 0) / (m.drag || 1)), 2)}`));
  else k.push(kpi('Moment de lacet', nf(m.M), two ? 'N·m/m' : 'N·m', 'autour du contact avant'));
  if (!two) {
    const P = (m.drag ?? 0) * tunnel.V;
    k.push(kpi('Puissance absorbée', nf(P / 1000, 1), 'kW', `${nf(P / 735.5)} ch à ${nf(state.speed)} km/h`));
    if (car.dims.mass) {
      const ratio = -(m.lift ?? NaN) / (car.dims.mass * 9.81);
      k.push(kpi(ratio >= 0 ? 'Appui / poids' : 'Portance / poids', nf(Math.abs(ratio) * 100), '%', `masse ${nf(car.dims.mass)} kg`));
    }
    if (state.yaw !== 0) k.push(kpi('Force latérale', nf(m.side), 'N', `Cy ${nf(m.Cy, 3)}`));
    else k.push(kpi('Pression dynamique', nf(tunnel.q), 'Pa', `½ρV² · ρ = ${nf(tunnel.air.rho, 3)} kg/m³`));
  }
  $('kpis').replaceChildren(...k);
  if ($('balance')) {
    const down = -(m.lift ?? NaN);
    const b = m.balance;
    const okPct = isFinite(b) && down > 0 && b > -0.2 && b < 1.2;
    const word = (v) => (v >= 0 ? 'd\'appui' : 'de portance');
    const kids = [
      el('div', { class: 'kpis' },
        kpi('Essieu avant', okPct ? nf(b * 100, 1) : nf(Math.abs(m.loadFront ?? NaN)), okPct ? '%' : unitF, okPct ? `${nf(Math.abs(m.loadFront))} ${unitF} ${word(m.loadFront)}` : word(m.loadFront ?? 0)),
        kpi('Essieu arrière', okPct ? nf((1 - b) * 100, 1) : nf(Math.abs(m.loadRear ?? NaN)), okPct ? '%' : unitF, okPct ? `${nf(Math.abs(m.loadRear))} ${unitF} ${word(m.loadRear)}` : word(m.loadRear ?? 0))),
    ];
    if (okPct) kids.push(el('div', { class: 'balance-bar', 'aria-hidden': 'true' }, el('i', { style: `width:${Math.max(0, Math.min(100, b * 100))}%` }), el('b')));
    kids.push(el('p', { class: 'hint' }, okPct ? 'Part de l\'appui reprise par chaque essieu (moment de tangage compris).' : 'Effort vertical aérodynamique sur chaque essieu (moment de tangage compris). Le pourcentage d\'équilibre n\'a de sens qu\'avec de l\'appui.'));
    $('balance').replaceChildren(...kids);
  }
  // composants
  const names = car.catNames;
  const rows = [];
  if (m.comps) {
    const comps = [1, 2, 3, 4].map((c) => ({ name: names[c], ...m.comps[c - 1] }));
    const wh = m.comps.slice(4).reduce((a, c) => ({ Fx: a.Fx + c.Fx, Fy: a.Fy + c.Fy, Fz: a.Fz + c.Fz }), { Fx: 0, Fy: 0, Fz: 0 });
    comps.push({ name: 'Roues', ...wh });
    const present = comps.filter((c, i) => (i < 4 ? tunnel.catCount[i + 1] > 0 : tunnel.catCount.slice(5).some((n) => n > 0)));
    const maxD = Math.max(...present.map((c) => Math.abs(c.Fx)), 1e-9);
    const maxL = Math.max(...present.map((c) => Math.abs(c.Fy)), 1e-9);
    const totD = m.drag || 1, totL = m.lift || 1;
    for (const c of present) {
      rows.push(el('tr', {},
        el('td', {}, c.name),
        el('td', { class: 'n' }, `${nf(c.Fx)}`, el('div', { class: 'bar', style: `width:${(Math.abs(c.Fx) / maxD) * 100}%` }), el('div', { class: 's', style: 'color:var(--ink-3);font-size:11px' }, `${nf((c.Fx / totD) * 100)} %`)),
        el('td', { class: 'n' }, `${nf(-c.Fy)}`, el('div', { class: 'bar b2', style: `width:${(Math.abs(c.Fy) / maxL) * 100}%` }), el('div', { class: 's', style: 'color:var(--ink-3);font-size:11px' }, `${nf((c.Fy / totL) * 100)} %`))));
    }
  }
  $('compTable').replaceChildren(
    el('thead', {}, el('tr', {}, el('th', {}, 'Composant'), el('th', { class: 'n' }, `Traînée (${unitF})`), el('th', { class: 'n' }, top ? `Latéral (${unitF})` : `Appui (${unitF})`))),
    el('tbody', {}, ...rows));
  if (top && m.comps) {
    // en vue de dessus, colonne « latéral »
    const tds = $('compTable').querySelectorAll('tbody tr td:nth-child(3)');
    tds.forEach((td, i) => { const c = m.comps[i]; if (c) td.firstChild.textContent = nf(c.Fz); });
  }
  const t = tunnel;
  const g = t.grid;
  $('conditions').innerHTML = [
    `Re réel = <b class="m">${t.Re.toExponential(2).replace('.', ',')}</b> (L = ${nf(t.Lref, 2)} m) · Mach ${nf(t.mach, 3)}`,
    `ρ = ${nf(t.air.rho, 3)} kg/m³ · ν = ${nf(t.air.nu * 1e5, 3)}·10⁻⁵ m²/s · q = ${nf(t.q)} Pa`,
    `Grille ${g.nx}×${g.ny}${g.nz > 1 ? '×' + g.nz : ''} · Δx = ${nf(g.dx * 1000, 1)} mm · Re de grille ${t.ReGrid.toExponential(1).replace('.', ',')}${state.dim === '2d' ? ' (plafonné en 2D)' : ''}`,
    `Taux de blocage ${nf((t.blockage || 0) * 100, 1)} % · frontières haute et latérales ouvertes`,
    `${nf(stepRate)} pas/s · ${nf(stepRate * t.dt * 1000, 2)} ms de temps réel simulé par seconde`,
  ].join('<br>');
}

function updateHistoryCharts() {
  if (!charts.cx) return;
  const h = tunnel.history;
  const st = tunnel.stats();
  const top = state.dim === '2d' && state.plane === 'top';
  const ok = st && !st.transient;
  const hs = h.filter((s) => s.tStar >= Math.min(0.5, (tunnel.skipT ?? 0.6) * 0.4));
  charts.cx.setData([hs.map((s) => [s.tStar, s.Cx])], ok ? { hlines: [{ y: st.mean.Cx, color: getVar('--ink-2') }] } : {});
  charts.cz.setData([hs.map((s) => [s.tStar, top ? s.Cy : s.Cz])], ok ? { hlines: [{ y: top ? st.mean.Cy : st.mean.Cz, color: getVar('--ink-2') }] } : {});
}

function updateProfileCharts() {
  if (charts.cp) {
    const d = view2d.cpDistribution();
    if (d) charts.cp.setData([d.upper, d.lower], { xFixed: [-0.02, 1.02] });
  }
  if (charts.wake) {
    const w = view2d.wakeProfile(view2d.wakeX ?? 0.35);
    if (w) charts.wake.setData([w.pts]);
  }
}

// ---------------------------------------------------------------------------
// Panneau « Visualisation »
function renderVisu() {
  const root = $('tab-visu');
  root.innerHTML = '';
  if (state.dim === '2d') {
    const s = view2d.settings;
    const rangeSl = slider({ label: 'Plage de l\'échelle', min: 0.2, max: 3, step: 0.05, value: 1, unit: '×', format: (v) => nf(Number(v), 2), onInput: (v) => { s.range[s.mode] = baseRange2D[s.mode] * v; } });
    const smokeOver = toggle({ label: 'Superposer la fumée', checked: s.smokeOverlay, onChange: (v) => { s.smokeOverlay = v; } });
    const refresh = () => { rangeSl.hidden = s.mode === 'smoke'; smokeOver.hidden = s.mode === 'smoke'; rangeSl.set(s.range[s.mode] / baseRange2D[s.mode]); };
    root.append(group('Champ affiché',
      chips({ options: MODES_2D.map((m) => [m.id, m.label]), value: s.mode, onChange: (v) => { s.mode = v; refresh(); } }),
      toggle({ label: 'Champ moyen', sub: 'Moyenne temporelle glissante (≈ 0,5 t*) au lieu de l\'instantané', checked: s.mean, onChange: (v) => { s.mean = v; lastReadback = 0; } }),
      rangeSl, smokeOver,
      toggle({ label: 'Lignes de courant', sub: 'Calculées sur le champ instantané', checked: s.streamlines, onChange: (v) => { s.streamlines = v; if (v) view2d.computeStreamlines(); } }),
      select({ label: 'Palette séquentielle', value: String(s.cmap), options: [['0', 'Viridis (perceptuelle)'], ['1', 'Turbo (arc-en-ciel CFD)']], onChange: (v) => { s.cmap = Number(v); } })));
    refresh();
    root.append(group('Peigne à fumée',
      slider({ label: 'Nombre de filets', min: 4, max: 48, step: 1, value: s.rakeCount, onInput: (v) => { s.rakeCount = v; } }),
      slider({ label: 'Hauteur du peigne', min: 0.05, max: 0.95, step: 0.01, value: s.rakeY, format: (v) => `${nf(v * 100)} %`, onInput: (v) => { s.rakeY = v; } }),
      slider({ label: 'Étendue', min: 0.05, max: 1, step: 0.01, value: s.rakeSpan, format: (v) => `${nf(v * 100)} %`, onInput: (v) => { s.rakeSpan = v; } }),
      el('div', { class: 'btn-row' }, el('button', { type: 'button', class: 'btn', onclick: () => view2d.clearDye() }, 'Effacer la fumée'))));
    root.append(group('Navigation',
      el('p', { class: 'hint' }, 'Glisser pour déplacer, molette ou pincement pour zoomer, toucher pour placer la sonde.'),
      el('div', { class: 'btn-row' },
        el('button', { type: 'button', class: 'btn', onclick: () => { view2d.fitted = null; } }, 'Recadrer'),
        el('button', { type: 'button', class: 'btn', onclick: () => { view2d.probe = null; $('probeCard').hidden = true; } }, 'Retirer la sonde'))));
  } else {
    const s = view3d.settings;
    const posY = slider({ label: 'Hauteur de la fumée', min: 0.02, max: 1, step: 0.01, value: s.rakeY, format: (v) => `${nf(v * 100)} %`, onInput: (v) => { s.rakeY = v; view3d.resetParticles(); } });
    const posZ = slider({ label: 'Position latérale', min: -1, max: 1, step: 0.01, value: s.rakeZ, format: (v) => nf(Number(v), 2), onInput: (v) => { s.rakeZ = v; view3d.resetParticles(); } });
    const refreshSmoke = () => { posY.hidden = !(s.smoke === 'rake-h' || s.smoke === 'wand'); posZ.hidden = !(s.smoke === 'rake-v' || s.smoke === 'wand'); };
    root.append(group('Fumée',
      chips({ options: SMOKE_MODES.map((m) => [m.id, m.label]), value: s.smoke, onChange: (v) => { s.smoke = v; refreshSmoke(); view3d.resetParticles(); } }),
      posY, posZ,
      slider({ label: 'Densité', min: 0.2, max: 2.5, step: 0.05, value: s.smokeDensity, format: (v) => nf(Number(v), 2), onInput: (v) => { s.smokeDensity = v; } }),
      chips({ options: [['white', 'Fumée blanche'], ['speed', 'Colorée par la vitesse']], value: s.smokeColor, onChange: (v) => { s.smokeColor = v; } })));
    refreshSmoke();
    const fieldSel = select({ label: 'Grandeur', value: s.sliceField, options: SLICE_FIELDS.map((f) => [f.id, f.label]), onChange: (v) => { s.sliceField = v; } });
    const posLabel = () => (s.sliceAxis === 'x' ? 'Position (0 = nez, 1 = arrière)' : s.sliceAxis === 'y' ? 'Hauteur relative' : 'Position latérale relative');
    const posSl = slider({ label: posLabel(), min: s.sliceAxis === 'x' ? -0.2 : 0, max: s.sliceAxis === 'x' ? 2.2 : 1, step: 0.01, value: s.slicePos, format: (v) => nf(Number(v), 2), onInput: (v) => { s.slicePos = v; } });
    root.append(group('Plan de coupe',
      toggle({ label: 'Afficher le plan de coupe', checked: s.slice, onChange: (v) => { s.slice = v; } }),
      chips({
        options: [['x', 'Transversal'], ['y', 'Horizontal'], ['z', 'Longitudinal']], value: s.sliceAxis,
        onChange: (v) => {
          s.sliceAxis = v;
          s.slicePos = v === 'x' ? 1.15 : v === 'y' ? 0.25 : 0.5;
          if (!s.slice) s.slice = true;
          renderVisu();
        },
      }),
      posSl, fieldSel,
      slider({ label: 'Plage de l\'échelle', min: 0.2, max: 3, step: 0.05, value: s.range[s.sliceField] / baseRange3D[s.sliceField], unit: '×', format: (v) => nf(Number(v), 2), onInput: (v) => { s.range[s.sliceField] = baseRange3D[s.sliceField] * v; } }),
      slider({ label: 'Opacité', min: 0.2, max: 1, step: 0.01, value: s.sliceOpacity, format: (v) => `${nf(v * 100)} %`, onInput: (v) => { s.sliceOpacity = v; } })));
    root.append(group('Moyenne',
      toggle({ label: 'Champ moyen', sub: 'Plan de coupe et pression pariétale moyennés dans le temps (≈ 0,5 t*)', checked: s.mean, onChange: (v) => { s.mean = v; } })));
    root.append(group('Carrosserie',
      toggle({ label: 'Pression pariétale Cp', sub: 'Colore la voiture selon la pression locale', checked: s.surfaceCp, onChange: (v) => { s.surfaceCp = v; view3d.setSurfaceCp(v); } }),
      select({ label: 'Palette séquentielle', value: String(s.cmap), options: [['0', 'Viridis (perceptuelle)'], ['1', 'Turbo (arc-en-ciel CFD)']], onChange: (v) => { s.cmap = Number(v); } })));
  }
}
const baseRange2D = { speed: 1.6, cp: 1.2, vort: 60, loss: 1, ux: 1.4 };
const baseRange3D = { speed: 1.6, cp: 1.2, vort: 40, loss: 1, ux: 1.4 };

function renderAllPanels() {
  renderEssai();
  renderMesures();
  renderVisu();
}

// ---------------------------------------------------------------------------
// Affichage tête haute
function updateHud() {
  const t = tunnel;
  if (!t.sim) return;
  const st = t.stats();
  const m = st?.mean;
  const two = state.dim === '2d';
  const top = two && state.plane === 'top';
  const conv = st && !st.transient && st.converged;
  const chip = (k, v, u = '', cls = '') => `<span class="chip ${cls}"><span class="k">${k}</span><span class="v">${v}</span>${u ? `<span class="u">${u}</span>` : ''}</span>`;
  const status = !state.running ? 'En pause' : conv ? 'Stabilisé' : 'Calcul en cours';
  $('hudTop').innerHTML =
    `<span class="chip state"><span class="dot ${conv ? 'ok' : ''} ${state.running ? '' : 'paused'}"></span><span class="v" style="font-family:var(--font-label);font-weight:600">${status}</span></span>` +
    chip('V', nf(state.speed), 'km/h') +
    chip('t*', nf(t.tStar, 2)) +
    chip('Re', t.Re.toExponential(1).replace('.', ','), '', 'opt') +
    chip('Calcul', nf(stepRate), 'pas/s', 'opt');
  if (!st || st.transient) { $('hudBottom').innerHTML = chip('Mesures', 'établissement de l\'écoulement…'); return; }
  const unitF = two ? 'N/m' : 'N';
  let html = chip('Traînée', nf(m.drag), unitF, 'big');
  if (!top) {
    html += chip(liftWord(m.lift), nf(Math.abs(m.lift)), unitF, 'big');
    if (!two) html += chip('', `${nf(Math.abs(m.lift) / 9.81)}`, 'kg', 'opt');
  } else html += chip('Latéral', nf(m.side), unitF, 'big');
  html += chip('Cx', nf(m.Cx, 3));
  html += top ? chip('Cy', nf(m.Cy, 3)) : chip('Cz', nf(m.Cz, 3));
  if (!top && isFinite(m.balance) && m.lift < 0 && m.balance > -0.2 && m.balance < 1.2) html += chip('Équilibre AV', nf(m.balance * 100, 1), '%', 'opt');
  $('hudBottom').innerHTML = html;
}

// ---------------------------------------------------------------------------
// Légende des couleurs
function cmapJS(name, t) {
  t = Math.min(1, Math.max(0, t));
  if (name === 'div') {
    const st = [[0.12, 0.33, 0.78], [0.45, 0.66, 0.93], [0.86, 0.86, 0.84], [0.95, 0.58, 0.46], [0.75, 0.12, 0.15]];
    const k = Math.min(3, Math.floor(t * 4)), f = t * 4 - k;
    return st[k].map((a, i) => a + (st[k + 1][i] - a) * f);
  }
  if (name === 'turbo') {
    const kr = [0.13572138, 4.6153926, -42.66032258, 132.13108234, -152.94239396, 59.28637943];
    const kg = [0.09140261, 2.19418839, 4.84296658, -14.18503333, 4.27729857, 2.82956604];
    const kb = [0.1066733, 12.64194608, -60.58204836, 110.36276771, -89.90310912, 27.34824973];
    const p = (k) => k.reduce((a, c, i) => a + c * t ** i, 0);
    return [p(kr), p(kg), p(kb)];
  }
  const c = [[0.2777, 0.0054, 0.3341], [0.105, 1.4046, 1.3846], [-0.3309, 0.2148, 0.0951], [-4.6342, -5.7991, -19.3324], [6.2283, 14.1799, 56.6906], [4.7764, -13.7451, -65.353], [-5.4355, 4.6459, 26.3124]];
  return [0, 1, 2].map((i) => c.reduce((a, cc, k) => a + cc[i] * t ** k, 0));
}
let legendKey = '';
function updateLegend() {
  const lg = $('legend');
  let spec = null;
  if (state.dim === '2d') {
    const s = view2d.settings;
    const r = s.range[s.mode];
    const seq = s.cmap === 1 ? 'turbo' : 'vir';
    spec = {
      speed: ['Vitesse |V|/V∞', seq, 0, r],
      cp: ['Coefficient de pression Cp', 'div', -r, r],
      vort: ['Vorticité ω·L/V∞', 'div', -r, r],
      loss: ['Pertes 1 − Cp₀', seq, 0, r],
      ux: ['Vitesse axiale u/V∞', 'div', -r, r],
    }[s.mode];
  } else {
    const s = view3d.settings;
    const seq = s.cmap === 1 ? 'turbo' : 'vir';
    if (s.surfaceCp) spec = ['Cp pariétal', 'div', -s.range.cp, s.range.cp];
    else if (s.slice) {
      const r = s.range[s.sliceField];
      spec = { speed: ['Vitesse |V|/V∞', seq, 0, r], cp: ['Cp', 'div', -r, r], vort: ['Vorticité |ω|·L/V∞', seq, 0, r], loss: ['Pertes 1 − Cp₀', seq, 0, r], ux: ['Vitesse axiale u/V∞', 'div', -r, r] }[s.sliceField];
    }
  }
  if (!spec) { lg.hidden = true; legendKey = ''; return; }
  const key = spec.join('|');
  lg.hidden = false;
  if (key === legendKey) return;
  legendKey = key;
  const [title, cm, a, b] = spec;
  const cv = el('canvas', { width: 200, height: 10 });
  const ctx = cv.getContext('2d');
  for (let x = 0; x < 200; x++) {
    const c = cmapJS(cm, x / 199);
    ctx.fillStyle = `rgb(${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(',')})`;
    ctx.fillRect(x, 0, 1, 10);
  }
  const d = Math.abs(b) >= 10 ? 0 : 1;
  lg.replaceChildren(el('div', { class: 't' }, title), cv, el('div', { class: 'ticks' }, el('span', {}, nf(a, d)), el('span', {}, nf((a + b) / 2, d)), el('span', {}, nf(b, d))));
}

// ---------------------------------------------------------------------------
// Interactions 2D (déplacement, zoom, sonde)
const pointers = new Map();
let dragMoved = false;
let pinchDist = 0;
viewport.addEventListener('pointerdown', (e) => {
  if (state.dim !== '2d') return;
  viewport.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  dragMoved = false;
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinchDist = Math.hypot(a.x - b.x, a.y - b.y); }
});
viewport.addEventListener('pointermove', (e) => {
  if (state.dim !== '2d' || !pointers.has(e.pointerId)) return;
  const p = pointers.get(e.pointerId);
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  if (pointers.size === 1) {
    if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
    if (dragMoved) view2d.pan(dx, dy);
  }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const r = viewport.getBoundingClientRect();
    if (pinchDist > 0) view2d.zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, d / pinchDist);
    pinchDist = d;
    dragMoved = true;
  }
});
const endPointer = (e) => {
  if (state.dim !== '2d' || !pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (!dragMoved && pointers.size === 0 && e.type === 'pointerup') {
    const r = viewport.getBoundingClientRect();
    const [cx, cy] = view2d.toCell(e.clientX - r.left, e.clientY - r.top, view2d.fitted.height);
    const g = tunnel.grid;
    if (cx >= 0 && cy >= 0 && cx < g.nx && cy < g.ny) {
      view2d.probe = { x: cx, y: cy };
      lastReadback = 0;
    }
  }
  if (pointers.size < 2) pinchDist = 0;
};
viewport.addEventListener('pointerup', endPointer);
viewport.addEventListener('pointercancel', endPointer);
viewport.addEventListener('wheel', (e) => {
  if (state.dim !== '2d') return;
  e.preventDefault();
  const r = viewport.getBoundingClientRect();
  view2d.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });

function updateProbe() {
  const card = $('probeCard');
  const p = view2d.probe;
  if (!p || state.dim !== '2d') { card.hidden = true; return; }
  const v = view2d.sampleCPU(p.x, p.y);
  if (!v) return;
  const t = tunnel;
  const g = t.grid;
  const sp = Math.hypot(v[0], v[1]);
  const xw = g.x0 + p.x * g.dx, yw = g.y0 + p.y * g.dx;
  const solid = t.cat[Math.floor(p.x) + g.nx * Math.floor(p.y)];
  card.hidden = false;
  card.innerHTML = solid
    ? `<b>Sonde</b><br>Point situé dans la voiture`
    : `<b>Sonde</b> x ${nf(xw, 2)} m · ${state.plane === 'top' ? 'z' : 'y'} ${nf(yw, 2)} m<br>V = ${nf(sp * state.speed)} km/h (${nf(sp, 2)} V∞)<br>Angle ${nf((Math.atan2(v[1], v[0]) * 180) / Math.PI, 1)}° · Cp ${nf(v[3], 2)}<br>Δp = ${nf(v[3] * t.q)} Pa`;
}

// ---------------------------------------------------------------------------
// Export
function resultsText() {
  const st = tunnel.stats();
  if (!st || st.transient) return 'Pas encore de mesure stabilisée.';
  const m = st.mean;
  const two = state.dim === '2d';
  const u = two ? 'N/m' : 'N';
  const lines = [
    `Soufflerie numérique — ${car.name} — ${two ? (state.plane === 'top' ? 'Vue de dessus 2D' : state.plane === 'silhouette' ? 'Silhouette 2D' : 'Coupe longitudinale 2D') : 'Essai 3D'}`,
    `Vitesse ${nf(state.speed)} km/h · lacet ${state.yaw}° · ρ ${nf(tunnel.air.rho, 3)} kg/m³ · Re ${tunnel.Re.toExponential(2)}`,
    `Réglages : ${Object.entries(state.carParams[state.carId]).map(([k, v]) => `${CARS[state.carId].setup.find((s) => s.key === k).label} ${v}`).join(' · ')}`,
    `Traînée ${nf(m.drag)} ${u} (Cx ${nf(m.Cx, 3)})`,
    `Effort vertical ${nf(m.lift)} ${u} (Cz ${nf(m.Cz, 3)})`,
  ];
  if (!two) lines.push(`S = ${nf(tunnel.area, 3)} m² · SCx ${nf(m.Cx * tunnel.area, 3)} m² · SCz ${nf(m.Cz * tunnel.area, 3)} m²`);
  if (isFinite(m.balance)) lines.push(`Équilibre avant ${nf(m.balance * 100, 1)} %`);
  for (let c = 1; c <= 4; c++) if (tunnel.catCount[c]) lines.push(`  ${car.catNames[c]} : traînée ${nf(m.comps[c - 1].Fx)} ${u}, vertical ${nf(m.comps[c - 1].Fy)} ${u}`);
  lines.push(`Moyenne sur ${st.n} mesures, t* = ${nf(st.tEnd, 2)}${st.converged ? ' (stabilisé)' : ''}`);
  return lines.join('\n');
}
async function copyResults() {
  const txt = resultsText();
  try { await navigator.clipboard.writeText(txt); toast('Résultats copiés'); } catch {
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = txt;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Résultats copiés'); } catch { toast('Copie impossible'); }
    ta.remove();
  }
}
function download(name, blob) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function exportCSV() {
  const h = tunnel.history;
  const head = ['t_star', 'trainee_N', 'vertical_N', 'lateral_N', 'Cx', 'Cz', 'Cy', 'equilibre_av'];
  for (let c = 1; c <= 4; c++) head.push(`${car.catNames[c]}_Fx`, `${car.catNames[c]}_Fy`);
  head.push('roues_Fx', 'roues_Fy');
  const rows = h.map((s) => {
    const r = [s.tStar, s.drag, s.lift, s.side, s.Cx, s.Cz, s.Cy, s.balance ?? ''];
    for (let c = 0; c < 4; c++) r.push(s.comps[c].Fx, s.comps[c].Fy);
    r.push(s.comps.slice(4).reduce((a, c) => a + c.Fx, 0), s.comps.slice(4).reduce((a, c) => a + c.Fy, 0));
    return r.map((v) => (typeof v === 'number' ? v.toFixed(5) : v)).join(';');
  });
  const meta = resultsText().split('\n').map((l) => `# ${l}`).join('\n');
  download(`soufflerie_${state.carId}_${state.dim}_${state.speed}kmh.csv`, new Blob([`${meta}\n${head.join(';')}\n${rows.join('\n')}`], { type: 'text/csv;charset=utf-8' }));
}
function screenshot() {
  if (state.dim === '2d') view2d.render(renderer, size.w, size.h); else view3d.render(renderer, size.w, size.h);
  canvas.toBlob((b) => b && download(`soufflerie_${state.carId}.png`, b));
}

// ---------------------------------------------------------------------------
// Démarrage
buildTopbar();
$('camPresets').hidden = state.dim !== '3d';
rebuild({ newCar: true });
requestAnimationFrame(frame);
window.addEventListener('resize', () => { view2d.fitted = null; });
new ResizeObserver(() => resize()).observe(viewport);

// Application installable (PWA) : uniquement hors cadre et en contexte sécurisé
if ('serviceWorker' in navigator && !inIframe && window.isSecureContext && !import.meta.env?.DEV) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
// accès de débogage
window.__souf = { state, tunnel, view2d, view3d, gpu, renderer };
