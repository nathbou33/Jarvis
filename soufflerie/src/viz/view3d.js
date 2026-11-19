// Vue 3D : veine d'essai, voiture, fumée (particules advectées par le champ calculé),
// plan de coupe coloré, pression pariétale (Cp) sur la carrosserie.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { COLORMAPS, atlasSampler } from './glsl.js';

export const SMOKE_MODES = [
  { id: 'multi', label: 'Multi-flux' },
  { id: 'rake-v', label: 'Peigne vertical' },
  { id: 'rake-h', label: 'Peigne horizontal' },
  { id: 'grid', label: 'Nappe complète' },
  { id: 'wand', label: 'Sonde à fumée' },
  { id: 'off', label: 'Aucune' },
];
export const SLICE_FIELDS = [
  { id: 'speed', label: 'Vitesse |V|/V∞' },
  { id: 'cp', label: 'Pression Cp' },
  { id: 'vort', label: 'Vorticité |ω|·L/V∞' },
  { id: 'loss', label: 'Pertes de pression totale' },
  { id: 'ux', label: 'Vitesse axiale u/V∞' },
];

export class View3D {
  constructor(gpu, canvas) {
    this.gpu = gpu;
    const r = gpu.renderer;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0d12);
    const pm = new THREE.PMREMGenerator(r);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 40;

    const hemi = new THREE.HemisphereLight(0xc4d2e6, 0x1a1d22, 0.55);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-4, 9, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -8; sc.right = 8; sc.top = 6; sc.bottom = -6; sc.near = 1; sc.far = 30;
    sun.shadow.bias = -0.0004;
    sun.shadow.radius = 3;
    this.sun = sun;
    this.scene.add(sun);
    this.scene.add(sun.target);

    // sol de la veine
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0x14181e, roughness: 0.92, metalness: 0.0 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.002;
    floor.receiveShadow = true;
    this.scene.add(floor);
    // tapis roulant
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 256;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#2a2f37';
    cx.fillRect(0, 0, 64, 256);
    cx.fillStyle = '#323843';
    for (let y = 0; y < 256; y += 32) cx.fillRect(0, y, 64, 14);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    this.beltTex = tex;
    this.belt = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, metalness: 0.1 }));
    this.belt.rotation.x = -Math.PI / 2;
    this.belt.receiveShadow = true;
    this.scene.add(this.belt);
    this.turntable = new THREE.Mesh(new THREE.RingGeometry(1, 1.04, 96), new THREE.MeshBasicMaterial({ color: 0x3b4656, transparent: true, opacity: 0.8 }));
    this.turntable.rotation.x = -Math.PI / 2;
    this.turntable.position.y = 0.001;
    this.scene.add(this.turntable);

    this.domainBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0x2c3949, transparent: true, opacity: 0.9 }));
    this.scene.add(this.domainBox);
    this.inlet = this._grillePlane(0x7fb6ff);
    this.scene.add(this.inlet);

    this.carRoot = new THREE.Group();
    this.scene.add(this.carRoot);

    this.settings = {
      smoke: 'multi', smokeColor: 'white', smokeDensity: 1, rakeY: 0.45, rakeZ: 0.0, rakeSpan: 1,
      slice: false, sliceAxis: 'x', slicePos: 0.6, sliceField: 'vort', sliceOpacity: 0.92, mean: false,
      surfaceCp: false, cmap: 0, range: { speed: 1.6, cp: 1.2, vort: 40, loss: 1, ux: 1.4 },
    };
    this.wheelAngle = 0;
    this.beltOffset = 0;
  }

  _grillePlane(color) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const c = cv.getContext('2d');
    c.strokeStyle = 'rgba(160,200,255,0.55)';
    c.lineWidth = 2;
    for (let i = 0; i <= 128; i += 16) {
      c.beginPath(); c.moveTo(i, 0); c.lineTo(i, 128); c.stroke();
      c.beginPath(); c.moveTo(0, i); c.lineTo(128, i); c.stroke();
    }
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.18, color, side: THREE.DoubleSide, depthWrite: false }));
    m.rotation.y = Math.PI / 2;
    return m;
  }

  setCar(car, yawMatrix) {
    this.carRoot.clear();
    this.car = car;
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    holder.matrix.copy(yawMatrix);
    holder.add(car.group);
    this.carRoot.add(holder);
    this.carHolder = holder;
    this.originalMats = new Map();
    car.group.traverse((o) => { if (o.isMesh) this.originalMats.set(o, o.material); });
    this.cpMatDirty = true;
  }

  attach(tunnel) {
    this.tunnel = tunnel;
    const g = tunnel.grid;
    const sim = tunnel.sim;
    const W = g.nx * g.dx, H = g.ny * g.dx, D = g.nz * g.dx * (g.sym ? 2 : 1);
    const zc = g.sym ? 0 : g.z0 + D / 2;
    this.domainBox.scale.set(W, H, D);
    this.domainBox.position.set(g.x0 + W / 2, H / 2, zc);
    this.inlet.scale.set(D, H, 1);
    this.inlet.position.set(g.x0, H / 2, zc);
    this.inlet.material.map.repeat.set(D / 0.25, H / 0.25);
    const car = tunnel.opts.car;
    const L = car.dims.L;
    this.belt.scale.set(L + 1.6, car.dims.W + 0.5, 1);
    this.belt.position.set(car.dims.x0 + L / 2, 0.0005, 0);
    this.beltTex.repeat.set(1, (L + 1.6) / 0.5);
    this.beltTex.rotation = Math.PI / 2;
    const rr = Math.hypot(L / 2, car.dims.W / 2) * 0.82;
    this.turntable.scale.set(rr, rr, 1);
    this.turntable.position.set(tunnel.turntable.x, 0.001, 0);
    const box = tunnel.bounds;
    const c = new THREE.Vector3((box.min.x + box.max.x) / 2, 0.3, 0);
    this.sun.target.position.copy(c);
    this.sun.position.set(c.x - 4, 9, 5);
    if (!this.cameraSet || this.cameraCar !== car.id) {
      this.setCameraPreset('iso');
      this.cameraSet = true;
      this.cameraCar = car.id;
    }
    // ressources dépendant de la grille
    const key = `${g.nx}x${g.ny}x${g.nz}`;
    if (this.gridKey !== key) {
      this._disposeGrid();
      this.gridKey = key;
      this._buildGridResources(sim);
    }
    this._updateUniforms();
    this.resetParticles();
  }

  _buildGridResources(sim) {
    const g = this.tunnel.grid;
    const sampler = atlasSampler(g.nx, g.ny, g.nz, sim.tx);
    this.derived = this.gpu.target(sim.texW, sim.texH, 1);
    // champ dérivé : |ω|, critère Q, Cp prolongé dans les parois, Cp0
    this.derivedMat = this.gpu.material(`precision highp float; precision highp int; precision highp sampler2D;
${sampler}
uniform sampler2D uMacro;
uniform sampler2D uSolid;
uniform float uL;
out vec4 o;
void main() {
  ivec2 pix = ivec2(gl_FragCoord.xy);
  int tx = pix.x / ANX; int ty = pix.y / ANY;
  ivec3 p = ivec3(pix.x - tx * ANX, pix.y - ty * ANY, ty * ATX + tx);
  if (p.z >= ANZ) { o = vec4(0.0); return; }
  vec4 m = texelFetch(uMacro, pix, 0);
  bool solid = texelFetch(uSolid, pix, 0).r > 0.5;
  vec4 xp = afetch(uMacro, p + ivec3(1, 0, 0)), xm = afetch(uMacro, p - ivec3(1, 0, 0));
  vec4 yp = afetch(uMacro, p + ivec3(0, 1, 0)), ym = afetch(uMacro, p - ivec3(0, 1, 0));
  vec4 zp = afetch(uMacro, p + ivec3(0, 0, 1)), zm = afetch(uMacro, p - ivec3(0, 0, 1));
  if (solid) {
    float s = 0.0, n = 0.0;
    vec4 nb[6] = vec4[6](xp, xm, yp, ym, zp, zm);
    ivec3 off[6] = ivec3[6](ivec3(1,0,0), ivec3(-1,0,0), ivec3(0,1,0), ivec3(0,-1,0), ivec3(0,0,1), ivec3(0,0,-1));
    for (int k = 0; k < 6; k++) {
      if (afetch(uSolid, p + off[k]).r < 0.5) { s += nb[k].w; n += 1.0; }
    }
    o = vec4(0.0, 0.0, n > 0.0 ? s / n : 0.0, 1.0);
    return;
  }
  vec3 dx = (xp.xyz - xm.xyz) * 0.5, dy = (yp.xyz - ym.xyz) * 0.5, dz = (zp.xyz - zm.xyz) * 0.5;
  vec3 w = vec3(dy.z - dz.y, dz.x - dx.z, dx.y - dy.x) * uL;
  mat3 G = mat3(dx, dy, dz) * uL;
  mat3 S = 0.5 * (G + transpose(G));
  mat3 R = 0.5 * (G - transpose(G));
  float s2 = 0.0, r2 = 0.0;
  for (int i = 0; i < 3; i++) for (int j = 0; j < 3; j++) { s2 += S[i][j] * S[i][j]; r2 += R[i][j] * R[i][j]; }
  o = vec4(length(w), 0.5 * (r2 - s2), m.w, m.w + dot(m.xyz, m.xyz));
}`, { uMacro: { value: null }, uSolid: { value: null }, uL: { value: 1 } });

    // particules
    const PW = 256, PH = this.particleRows();
    this.PW = PW; this.PH = PH;
    this.pState = [this.gpu.target(PW, PH, 1), this.gpu.target(PW, PH, 1)];
    this.pIdx = 0;
    this.pUpdate = this.gpu.material(`precision highp float; precision highp int; precision highp sampler2D;
${sampler}
uniform sampler2D uState;
uniform sampler2D uMacro;
uniform sampler2D uSolid;
uniform vec3 uEmit[64];
uniform int uNEmit;
uniform float uDt;
uniform float uSteps;
uniform float uMaxAge;
uniform float uJitter;
uniform int uReset;
uniform float uSeed;
uniform bool uSym;
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed) * 43758.5453); }
void main() {
  ivec2 pix = ivec2(gl_FragCoord.xy);
  int id = pix.y * ${PW} + pix.x;
  int e = id - (id / max(uNEmit, 1)) * max(uNEmit, 1);
  int slot = id / max(uNEmit, 1);
  int perE = ${PW * PH} / max(uNEmit, 1);
  vec4 s = texelFetch(uState, pix, 0);
  if (uReset == 1) {
    // naissances échelonnées → filets continus dès le départ
    float delay = float(slot) / float(max(perE, 1)) * uMaxAge;
    o = vec4(uEmit[e], -delay);
    return;
  }
  float age = s.w + uSteps;
  vec3 p = s.xyz;
  if (age < 0.0) { o = vec4(uEmit[e], age); return; }
  bool reborn = s.w < 0.0 && age >= 0.0;
  float ulb = uDt / max(uSteps, 1e-6);
  if (reborn) {
    vec2 r = vec2(hash(vec2(float(id), age)), hash(vec2(age, float(id) * 1.7)));
    float a = r.x * 6.2831853, rad = sqrt(r.y) * uJitter;
    p = uEmit[e] + vec3(0.0, cos(a) * rad, sin(a) * rad);
    // particule née au cours du sous-pas : avance de l'âge excédentaire (filets continus)
    p += asample(uMacro, p).xyz * ulb * age;
    o = vec4(p, age);
    return;
  }
  vec3 u1 = asample(uMacro, p).xyz * uDt;
  vec3 u2 = asample(uMacro, p + 0.5 * u1).xyz * uDt;
  p += u2;
  if (uSym) p.z = abs(p.z);
  bool dead = age > uMaxAge || p.x < 0.0 || p.x > float(ANX) - 1.0 || p.y < 0.3 || p.y > float(ANY) || p.z < (uSym ? -1.0 : 0.0) || p.z > float(ANZ)
    || afetch(uSolid, ivec3(floor(p))).r > 0.5 || (age > 40.0 && length(u2) < 0.0004 * uSteps);
  if (dead) {
    vec2 r = vec2(hash(vec2(float(id), age + 3.1)), hash(vec2(age * 0.37, float(id))));
    float a = r.x * 6.2831853, rad = sqrt(r.y) * uJitter;
    float ex = age > uMaxAge ? clamp(age - uMaxAge, 0.0, uSteps) : 0.0;
    vec3 q = uEmit[e] + vec3(0.0, cos(a) * rad, sin(a) * rad);
    q += asample(uMacro, q).xyz * ulb * ex;
    o = vec4(q, ex);
    return;
  }
  o = vec4(p, age);
}`, {
      uState: { value: null }, uMacro: { value: null }, uSolid: { value: null },
      uEmit: { value: Array.from({ length: 64 }, () => new THREE.Vector3()) }, uNEmit: { value: 1 },
      uDt: { value: 1 }, uSteps: { value: 1 }, uMaxAge: { value: 1000 }, uJitter: { value: 0.3 }, uReset: { value: 1 }, uSeed: { value: 0 }, uSym: { value: false },
    });

    const N = PW * PH;
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3));
    this.pN = N;
    pg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.pMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uState: { value: null }, uMacro: { value: null }, uOrigin: { value: new THREE.Vector3() }, uDx: { value: 0.05 },
        uMaxAge: { value: 1000 }, uSize: { value: 1 }, uColorMode: { value: 0 }, uAlpha: { value: 0.2 }, uPx: { value: 800 }, uCmap: { value: 0 }, uSym: { value: false },
      },
      vertexShader: `precision highp float; precision highp int; precision highp sampler2D;
${sampler}
uniform sampler2D uState;
uniform sampler2D uMacro;
uniform vec3 uOrigin;
uniform float uDx;
uniform float uMaxAge;
uniform float uSize;
uniform float uPx;
uniform bool uSym;
out float vAlpha;
out float vSpeed;
void main() {
  int id = gl_VertexID;
  float mir = 1.0;
  if (id >= ${PW * PH}) { if (!uSym) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; vSpeed = 0.0; return; } id -= ${PW * PH}; mir = -1.0; }
  vec4 s = texelFetch(uState, ivec2(id - (id / ${PW}) * ${PW}, id / ${PW}), 0);
  if (s.w < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; vSpeed = 0.0; return; }
  vec3 wp = uOrigin + s.xyz * uDx;
  if (mir < 0.0) wp.z = uOrigin.z - s.z * uDx;
  vec4 mv = modelViewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  float t = s.w / uMaxAge;
  vAlpha = smoothstep(0.0, 0.04, t) * (1.0 - smoothstep(0.7, 1.0, t));
  vSpeed = length(asample(uMacro, s.xyz).xyz);
  gl_PointSize = clamp(uSize * uPx / -mv.z, 1.0, 24.0);
}`,
      fragmentShader: `precision highp float;
${COLORMAPS}
uniform int uColorMode;
uniform float uAlpha;
in float vAlpha;
in float vSpeed;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float a = exp(-r2 * 14.0) * vAlpha * uAlpha;
  vec3 c = uColorMode == 0 ? vec3(0.9, 0.95, 1.0) : cmTurbo(clamp(vSpeed / 1.6, 0.0, 1.0));
  outColor = vec4(c * a, a);
}`,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.points = new THREE.Points(pg, this.pMat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.scene.add(this.points);

    // plan de coupe
    this.sliceMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uMacro: { value: null }, uDerived: { value: null }, uSolid: { value: null },
        uOrigin: { value: new THREE.Vector3() }, uDx: { value: 0.05 }, uField: { value: 0 }, uRange: { value: 1 }, uOpacity: { value: 0.9 }, uCmap: { value: 0 }, uSym: { value: false },
      },
      vertexShader: `out vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `precision highp float; precision highp int; precision highp sampler2D;
${sampler}
${COLORMAPS}
uniform sampler2D uMacro;
uniform sampler2D uDerived;
uniform sampler2D uSolid;
uniform vec3 uOrigin;
uniform float uDx;
uniform int uField;
uniform float uRange;
uniform float uOpacity;
uniform bool uSym;
in vec3 vW;
out vec4 outColor;
void main() {
  vec3 c = (vW - uOrigin) / uDx;
  if (uSym) c.z = abs(c.z);
  if (afetch(uSolid, ivec3(floor(c))).r > 0.5) discard;
  vec4 m = asample(uMacro, c);
  vec4 d = asample(uDerived, c);
  vec3 col;
  if (uField == 0) col = cmSeq(length(m.xyz) / uRange);
  else if (uField == 1) col = cmDiverge(0.5 + 0.5 * m.w / uRange);
  else if (uField == 2) col = cmSeq(d.x / uRange);
  else if (uField == 3) col = cmSeq(clamp((1.0 - d.w) / uRange, 0.0, 1.0));
  else col = cmDiverge(0.5 + 0.5 * m.x / uRange);
  outColor = vec4(col, uOpacity);
}`,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.slice = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.sliceMat);
    this.slice.renderOrder = 5;
    this.scene.add(this.slice);

    // pression pariétale
    this.cpMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uDerived: { value: null }, uOrigin: { value: new THREE.Vector3() }, uDx: { value: 0.05 }, uRange: { value: 1.2 }, uCmap: { value: 0 }, uSym: { value: false } },
      vertexShader: `out vec3 vW; out vec3 vN;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `precision highp float; precision highp int; precision highp sampler2D;
${sampler}
${COLORMAPS}
uniform sampler2D uDerived;
uniform vec3 uOrigin;
uniform float uDx;
uniform float uRange;
uniform bool uSym;
in vec3 vW;
in vec3 vN;
out vec4 outColor;
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 c = (vW + n * uDx * 0.8 - uOrigin) / uDx;
  if (uSym) c.z = abs(c.z);
  float cp = asample(uDerived, c).z;
  vec3 col = cmDiverge(0.5 + 0.5 * cp / uRange);
  float l = 0.55 + 0.45 * max(dot(n, normalize(vec3(-0.4, 0.9, 0.5))), 0.0);
  outColor = vec4(col * l, 1.0);
}`,
      side: THREE.DoubleSide,
    });
  }

  particleRows() {
    const q = this.tunnel?.opts?.quality;
    return q === 'low' ? 192 : q === 'high' || q === 'ultra' ? 384 : 256;
  }

  _updateUniforms() {
    const t = this.tunnel;
    const g = t.grid;
    const origin = new THREE.Vector3(g.x0, g.y0, g.z0);
    for (const m of [this.pMat, this.sliceMat, this.cpMat]) {
      m.uniforms.uOrigin.value.copy(origin);
      m.uniforms.uDx.value = g.dx;
    }
    this.derivedMat.uniforms.uL.value = t.Lref / g.dx;
    for (const m of [this.pMat, this.sliceMat, this.cpMat, this.pUpdate]) m.uniforms.uSym.value = !!g.sym;
    this.points.geometry.setDrawRange(0, this.pN * (g.sym ? 2 : 1));
  }

  emitters() {
    const t = this.tunnel;
    const g = t.grid;
    const s = this.settings;
    const box = t.bounds;
    const H = box.max.y, W = box.max.z - box.min.z;
    const xr = (box.min.x - 0.25 - g.x0) / g.dx;
    const pts = [];
    const toC = (y, z) => new THREE.Vector3(xr, (y - g.y0) / g.dx, ((g.sym ? Math.abs(z) : z) - g.z0) / g.dx);
    const span = s.rakeSpan;
    if (s.smoke === 'multi') {
      // plusieurs peignes verticaux répartis sur la largeur + un flux au ras du sol (soubassement)
      const lanes = g.sym ? [0, 0.35, 0.62, 0.95] : [0, 0.35, -0.35, 0.62, -0.62, 0.95, -0.95];
      const nPer = g.sym ? 12 : 8;
      for (const zl of lanes) for (let k = 0; k < nPer; k++) pts.push(toC(0.05 + (k / (nPer - 1)) * H * 1.12, zl * W * 0.5 * span));
      const nLow = g.sym ? 12 : 8;
      const yLow = Math.min(0.09, 0.06 * H + 0.02);
      for (let k = 0; k < nLow; k++) pts.push(toC(yLow, g.sym ? ((k + 0.5) / nLow) * W * 0.5 : ((k + 0.5) / nLow - 0.5) * W));
    } else if (s.smoke === 'rake-v') {
      const n = 15;
      for (let k = 0; k < n; k++) pts.push(toC(0.03 + (k / (n - 1)) * H * 1.15 * span, s.rakeZ * W * 0.6));
    } else if (s.smoke === 'rake-h') {
      const n = g.sym ? 16 : 30;
      for (let k = 0; k < n; k++) pts.push(toC(s.rakeY * H * 1.2, g.sym ? ((k + 0.5) / n) * W * 0.62 * span : (k / (n - 1) - 0.5) * W * 1.25 * span));
    } else if (s.smoke === 'grid') {
      const nb = g.sym ? 5 : 9;
      for (let a = 0; a < 7; a++) for (let b = 0; b < nb; b++) pts.push(toC(0.04 + (a / 6) * H * 1.15, g.sym ? ((b + 0.5) / nb) * W * 0.65 : (b / 8 - 0.5) * W * 1.3));
    } else if (s.smoke === 'wand') {
      pts.push(toC(s.rakeY * H * 1.2, s.rakeZ * W * 0.6));
    }
    return pts;
  }

  resetParticles() {
    if (!this.pUpdate) return;
    const pts = this.emitters();
    const u = this.pUpdate.uniforms;
    for (let k = 0; k < 64; k++) u.uEmit.value[k].copy(pts[k] || pts[0] || new THREE.Vector3());
    u.uNEmit.value = Math.max(1, pts.length);
    const g = this.tunnel.grid;
    u.uMaxAge.value = (1.25 * g.nx) / this.tunnel.U;
    u.uJitter.value = this.settings.smoke === 'wand' ? 0.9 : 0.16;
    u.uReset.value = 1;
    u.uState.value = this.pState[this.pIdx].texture;
    this.gpu.pass(this.pUpdate, this.pState[1 - this.pIdx]);
    this.pIdx = 1 - this.pIdx;
    u.uReset.value = 0;
    this.points.visible = this.settings.smoke !== 'off';
  }

  update(steps) {
    const t = this.tunnel;
    const sim = t.sim;
    // dérivées (coupe et Cp pariétal)
    if (this.settings.slice || this.settings.surfaceCp) {
      this.derivedMat.uniforms.uMacro.value = t.field(this.settings.mean).texture;
      this.derivedMat.uniforms.uSolid.value = sim.solidTex;
      this.gpu.pass(this.derivedMat, this.derived);
    }
    // particules
    if (this.settings.smoke !== 'off' && steps > 0) {
      const u = this.pUpdate.uniforms;
      const disp = steps * t.U;
      const nSub = Math.max(1, Math.ceil(disp / 0.8));
      u.uMacro.value = sim.macro.texture;
      u.uSolid.value = sim.solidTex;
      u.uMaxAge.value = (1.25 * t.grid.nx) / t.U;
      for (let k = 0; k < nSub; k++) {
        u.uState.value = this.pState[this.pIdx].texture;
        u.uDt.value = disp / nSub;
        u.uSteps.value = steps / nSub;
        u.uSeed.value = Math.random() * 100;
        this.gpu.pass(this.pUpdate, this.pState[1 - this.pIdx]);
        this.pIdx = 1 - this.pIdx;
      }
    }
    // roues et tapis (ralenti cohérent avec la fumée)
    const g = t.grid;
    const vScene = steps * t.U * g.dx; // m parcourus par l'air dans la scène pendant cette image
    if (t.opts.rotatingWheels) {
      for (let i = 0; i < this.car.wheelGroups.length; i++) { const wg = this.car.wheelGroups[i]; (wg.userData.spin || wg).rotation.z -= vScene / this.car.wheels[i].R; }
    }
    if (t.opts.rollingRoad) {
      this.beltOffset += vScene / 0.5;
      this.beltTex.offset.y = -this.beltOffset;
    }
  }

  setSurfaceCp(on) {
    if (!this.car) return;
    this.car.group.traverse((o) => {
      if (!o.isMesh) return;
      if (on) o.material = this.cpMat;
      else if (this.originalMats.has(o)) o.material = this.originalMats.get(o);
    });
  }

  layoutSlice() {
    const t = this.tunnel;
    const g = t.grid;
    const s = this.settings;
    const W = g.nx * g.dx, H = g.ny * g.dx, D = g.nz * g.dx * (g.sym ? 2 : 1);
    const zc = g.sym ? 0 : g.z0 + D / 2;
    const box = t.bounds;
    const sl = this.slice;
    sl.visible = s.slice;
    sl.rotation.set(0, 0, 0);
    if (s.sliceAxis === 'x') {
      // plan transversal : position relative le long de la voiture (0 = nez, 1 = arrière, >1 = sillage)
      const x = box.min.x + s.slicePos * (box.max.x - box.min.x);
      sl.scale.set(D, H, 1);
      sl.rotation.y = Math.PI / 2;
      sl.position.set(Math.min(Math.max(x, g.x0 + g.dx), g.x0 + W - g.dx), H / 2, zc);
    } else if (s.sliceAxis === 'y') {
      const y = Math.max(0.01, s.slicePos * (box.max.y));
      sl.scale.set(W, D, 1);
      sl.rotation.x = -Math.PI / 2;
      sl.position.set(g.x0 + W / 2, y, zc);
    } else {
      const z = (s.slicePos - 0.5) * (box.max.z - box.min.z) * 1.2;
      sl.scale.set(W, H, 1);
      sl.position.set(g.x0 + W / 2, H / 2, z);
    }
    const fi = SLICE_FIELDS.findIndex((f) => f.id === s.sliceField);
    this.sliceMat.uniforms.uField.value = fi;
    this.sliceMat.uniforms.uRange.value = s.range[s.sliceField];
    this.sliceMat.uniforms.uOpacity.value = s.sliceOpacity;
    this.sliceMat.uniforms.uCmap.value = s.cmap;
  }

  setCameraPreset(name) {
    const t = this.tunnel;
    const car = t ? t.opts.car : this.car;
    const L = car.dims.L;
    const c = new THREE.Vector3(car.dims.x0 + L / 2, Math.min(0.45, car.dims.H * 0.4), 0);
    const d = L * 1.55;
    const p = {
      iso: [c.x - d * 0.75, d * 0.42, d * 0.85],
      side: [c.x, c.y + 0.1, d * 1.35],
      front: [c.x - d * 1.4, c.y + 0.25, 0.001],
      rear: [c.x + d * 1.15, d * 0.35, d * 0.5],
      top: [c.x, d * 1.6, 0.001],
      low: [c.x - d * 0.6, 0.18, d * 0.7],
    }[name] || [c.x - d * 0.75, d * 0.42, d * 0.85];
    this.camera.position.set(...p);
    this.controls.target.copy(c);
    this.controls.update();
  }

  render(renderer, width, height) {
    const t = this.tunnel;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    const sim = t.sim;
    if (this.points) {
      const pu = this.pMat.uniforms;
      pu.uState.value = this.pState[this.pIdx].texture;
      pu.uMacro.value = sim.macro.texture;
      pu.uMaxAge.value = (1.25 * t.grid.nx) / t.U;
      const fovPx = (height * renderer.getPixelRatio()) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
      pu.uPx.value = fovPx;
      const dens = this.settings.smokeDensity;
      const nPerEmitter = (this.PW * this.PH) / Math.max(1, this.pUpdate.uniforms.uNEmit.value);
      pu.uSize.value = 0.036 * Math.max(0.7, Math.min(1.5, Math.sqrt(t.grid.dx / 0.06)));
      pu.uAlpha.value = Math.min(0.9, (this.settings.smoke === 'wand' ? 0.14 : 0.3) * dens * Math.sqrt(1500 / nPerEmitter + 0.15));
      pu.uColorMode.value = this.settings.smokeColor === 'speed' ? 1 : 0;
      this.points.visible = this.settings.smoke !== 'off';
    }
    if (this.slice) {
      this.layoutSlice();
      this.sliceMat.uniforms.uMacro.value = t.field(this.settings.mean).texture;
      this.sliceMat.uniforms.uDerived.value = this.derived.texture;
      this.sliceMat.uniforms.uSolid.value = sim.solidTex;
      this.cpMat.uniforms.uDerived.value = this.derived.texture;
      this.cpMat.uniforms.uRange.value = this.settings.range.cp;
    }
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }

  _disposeGrid() {
    if (this.points) { this.scene.remove(this.points); this.points.geometry.dispose(); this.pMat.dispose(); this.points = null; }
    if (this.slice) { this.scene.remove(this.slice); this.slice.geometry.dispose(); this.sliceMat.dispose(); this.slice = null; }
    if (this.pState) for (const rt of this.pState) rt.dispose();
    if (this.derived) this.derived.dispose();
    for (const m of [this.derivedMat, this.pUpdate, this.cpMat]) if (m) m.dispose();
    this.pState = null;
    this.derived = null;
    this.pUpdate = null;
  }

  dispose() {
    this._disposeGrid();
    this.gridKey = null;
  }
}
