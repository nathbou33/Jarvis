// Solveur Lattice Boltzmann sur GPU (WebGL2 via Three.js).
//  - D2Q9 (2D) ou D3Q19 (3D, grille 3D stockée en atlas de tranches 2D)
//  - Collision BGK régularisée + modèle de turbulence LES de Smagorinsky
//  - Rebond à mi-chemin (bounce-back) avec parois mobiles (sol roulant, roues en rotation)
//  - Entrée à vitesse imposée (turbulence d'entrée optionnelle), sortie à gradient nul
//    avec zone éponge, limites hautes/latérales en champ lointain
//  - Efforts par échange de quantité de mouvement, ventilés par composant
import * as THREE from 'three';
import { Reducer } from './gpgpu.js';

const COMP = ['x', 'y', 'z', 'w'];
const f = (v) => {
  const s = Number(v).toPrecision(9);
  return s.includes('.') || s.includes('e') ? s : s + '.0';
};

export const WHEEL_CAT0 = 5;
export const NUM_CATS = 8;

export class LBM {
  /**
   * @param {GPU} gpu
   * @param {object} o { lattice, nx, ny, nz, bottom: 'ground' | 'farfield' }
   */
  constructor(gpu, o) {
    this.gpu = gpu;
    this.L = o.lattice;
    this.nx = o.nx;
    this.ny = o.ny;
    this.nz = o.nz || 1;
    this.dim3 = this.nz > 1;
    this.bottom = o.bottom || 'ground';
    this.sym = !!o.symmetry && (o.nz || 1) > 1; // plan de symétrie en z = 0 (demi-modèle)
    this.slipGround = !!o.slipGround; // sol roulant modélisé par une paroi glissante partout
    const L = this.L;

    // Disposition en atlas
    if (this.dim3) {
      const maxW = Math.min(gpu.maxTextureSize, 8192);
      let tx = Math.max(1, Math.ceil(Math.sqrt((this.nz * this.ny) / this.nx)));
      while (tx * this.nx > maxW) tx--;
      const ty = Math.ceil(this.nz / tx);
      if (ty * this.ny > gpu.maxTextureSize) throw new Error('Grille trop grande pour ce GPU');
      this.tx = tx;
      this.ty = ty;
    } else {
      this.tx = 1;
      this.ty = 1;
    }
    this.texW = this.nx * this.tx;
    this.texH = this.ny * this.ty;

    // Mode 1 passe si le GPU accepte assez de cibles simultanées, sinon 2 passes.
    const nTex = L.nTex;
    this.groups = gpu.maxDrawBuffers >= nTex ? [[...Array(nTex).keys()]] : [[0, 1, 2], [...Array(nTex).keys()].slice(3)];

    const makeSet = () => {
      const rts = this.groups.map((g) => gpu.target(this.texW, this.texH, g.length));
      return { rts, textures: rts.flatMap((rt) => rt.textures) };
    };
    this.A = makeSet();
    this.B = makeSet();
    this.macro = gpu.target(this.texW, this.texH, 1);
    this.meanRT = [gpu.target(this.texW, this.texH, 1), gpu.target(this.texW, this.texH, 1)];
    this.meanIdx = 0;
    this.meanFresh = true;
    this.force = gpu.target(this.texW, this.texH, 4);
    this.reducer = new Reducer(gpu, this.texW, this.texH, 4, 8);

    this.solidData = new Float32Array(this.texW * this.texH * 4);
    this.solidTex = gpu.dataTexture(this.solidData, this.texW, this.texH);
    this.cat = new Uint8Array(this.nx * this.ny * this.nz);

    this.params = {
      U: 0.1,
      tau0: 0.5 + 3 * 1e-4,
      cs: 0.16,
      groundU: 0.1,
      turb: 0,
      sponge: 0.9,
    };
    this.wheels = [];
    this.time = 0;
    this.steps = 0;

    this._buildMaterials();
  }

  get atlasHeader() {
    return /* glsl */ `
precision highp float; precision highp int; precision highp sampler2D;
#define NX ${this.nx}
#define NY ${this.ny}
#define NZ ${this.nz}
#define TX ${this.tx}
${this.dim3 ? `
ivec3 cellOf(ivec2 pix) { int tx = pix.x / NX; int ty = pix.y / NY; return ivec3(pix.x - tx * NX, pix.y - ty * NY, ty * TX + tx); }
ivec2 pixOf(ivec3 p) { int ty = p.z / TX; int tx = p.z - ty * TX; return ivec2(tx * NX + p.x, ty * NY + p.y); }
` : `
ivec3 cellOf(ivec2 pix) { return ivec3(pix, 0); }
ivec2 pixOf(ivec3 p) { return p.xy; }
`}
`;
  }

  _wheelFns() {
    return /* glsl */ `
uniform vec3 uWheelC[4];
uniform vec3 uWheelW[4];
uniform sampler2D uSolid;
vec3 wallVel(ivec3 q) {
  bool mir = q.z < 0;
  if (mir) q.z = -q.z - 1;
  vec4 sq = texelFetch(uSolid, pixOf(q), 0);
  int cat = int(sq.r + 0.5);
  if (cat >= ${WHEEL_CAT0}) {
    int wi = cat - ${WHEEL_CAT0};
    vec3 r = vec3(q) + 0.5 - uWheelC[wi];
    vec3 v = cross(uWheelW[wi], r);
    if (mir) v.z = -v.z;
    return v;
  }
  return vec3(0.0);
}
`;
  }

  _buildMaterials() {
    const L = this.L;
    const Q = L.Q;
    const nTex = L.nTex;
    const own = (i) => `o${i >> 2}.${COMP[i & 3]}`;
    const samplers = Array.from({ length: nTex }, (_, t) => `uniform sampler2D uF${t};`).join('\n');
    const ownFetch = Array.from({ length: nTex }, (_, t) => `vec4 o${t} = texelFetch(uF${t}, pix, 0);`).join('\n  ');
    const dot3 = (c, v) => {
      const t = [];
      for (let a = 0; a < 3; a++) {
        if (c[a] === 1) t.push(`${v}.${COMP[a]}`);
        else if (c[a] === -1) t.push(`-${v}.${COMP[a]}`);
      }
      return t.length ? `(${t.join(' + ').replace(/\+ -/g, '- ')})` : '0.0';
    };

    // ---- streaming (pull) ----
    const stream = [];
    stream.push(`float f0 = o0.x;`);
    for (let i = 1; i < Q; i++) {
      const [cx, cy, cz] = L.c[i];
      const t = i >> 2, comp = COMP[i & 3];
      const oi = L.opp[i];
      const w6 = f(6 * L.w[i]);
      const branches = [];
      // entrée : populations entrantes à l'équilibre de l'écoulement amont (V∞, ρ = 1)
      const fe = `feq(${f(L.w[i])}, ${dot3(L.c[i], 'uin')}, uin2, 1.0)`;
      branches.push(`if ((mask & ${1 << i}) != 0) { f${i} = ${own(oi)} + ${w6} * dot(wallVel(q), vec3(${cx}.0, ${cy}.0, ${cz}.0)); }`);
      // sol (paroi fixe ou roulante) ; en vue de dessus : frontière ouverte
      if (cy > 0 && this.bottom === 'ground') {
        // sol : paroi mobile (sol roulant) là où le soubassement est résolu (s.b = 1),
        // paroi glissante sinon ; paroi fixe adhérente quand le sol roulant est coupé.
        const d = L.c.findIndex((e) => e[0] === cx && e[1] === 0 && e[2] === cz);
        const m = L.c.findIndex((e) => e[0] === cx && e[1] === -cy && e[2] === cz);
        const slipSrc = d === 0 ? 'p' : `(p - ivec3(${cx}, 0, ${cz}))`;
        // Réflexion spéculaire conservative : on ne prend la population de la cellule source
        // que si elle est fluide, dans le domaine et elle-même en mode glissant ; sinon rebond.
        const slipOk = d === 0 ? 'true' : `(mask & ${1 << d}) == 0 && ${slipSrc}.x >= 0 && ${slipSrc}.x < NX && ${slipSrc}.z >= 0 && ${slipSrc}.z < NZ && texelFetch(uSolid, pixOf(${slipSrc}), 0).b < 0.5`;
        branches.push(`else if (q.y < 0) {
      if (uGroundU > 0.0 && s.b < 0.5) {
        if (${slipOk}) f${i} = texelFetch(uF${m >> 2}, pixOf(${slipSrc}), 0).${COMP[m & 3]};
        else f${i} = ${own(oi)};
      } else f${i} = ${own(oi)} + ${f(6 * L.w[i] * cx)} * uGroundU;
    }`);
      }
      // entrée : vitesse imposée
      if (cx > 0) branches.push(`else if (q.x < 0) { f${i} = ${fe}; }`);
      // sortie : pression imposée (ρ = 1), vitesse extrapolée depuis la cellule
      if (cx < 0) branches.push(`else if (q.x >= NX) { f${i} = feq(${f(L.w[i])}, ${dot3(L.c[i], 'uOut')}, uOut2, 1.0); }`);
      // plan de symétrie (demi-modèle) : réflexion spéculaire en z = 0
      if (this.sym && cz > 0) {
        const m = L.c.findIndex((d) => d[0] === cx && d[1] === cy && d[2] === -cz);
        branches.push(`else if (q.z < 0) { f${i} = texelFetch(uF${m >> 2}, pixOf(ivec3(q.x, min(q.y, NY - 1), 0)), 0).${COMP[m & 3]}; }`);
      }
      // dessus, côtés (et dessous en vue de dessus) : frontières ouvertes à gradient nul
      const open = [];
      if (cy < 0) open.push('q.y >= NY');
      if (cy > 0 && this.bottom !== 'ground') open.push('q.y < 0');
      if (cz < 0) open.push('q.z >= NZ');
      if (cz > 0 && !this.sym) open.push('q.z < 0');
      if (open.length) branches.push(`else if (${open.join(' || ')}) { f${i} = texelFetch(uF${t}, pixOf(clamp(q, ivec3(0), ivec3(NX - 1, NY - 1, NZ - 1))), 0).${comp}; }`);
      branches.push(`else { f${i} = texelFetch(uF${t}, pixOf(q), 0).${comp}; }`);
      stream.push(`float f${i}; { ivec3 q = p - ivec3(${cx}, ${cy}, ${cz});\n    ${branches.join('\n    ')} }`);
    }

    // ---- moments ----
    const rhoExpr = Array.from({ length: Q }, (_, i) => `f${i}`).join(' + ');
    const momExpr = [0, 1, 2].map((a) => {
      const t = [];
      for (let i = 1; i < Q; i++) {
        if (L.c[i][a] === 1) t.push(`+ f${i}`);
        else if (L.c[i][a] === -1) t.push(`- f${i}`);
      }
      return t.length ? t.join(' ').replace(/^\+ /, '') : '0.0';
    });

    const momOwn = momExpr.map((e) => e.replace(/f(\d+)/g, (_, i) => own(Number(i)))).join(', ');

    // ---- collision régularisée + LES ----
    const pairs = this.dim3 ? [['xx', 0, 0], ['yy', 1, 1], ['zz', 2, 2], ['xy', 0, 1], ['xz', 0, 2], ['yz', 1, 2]] : [['xx', 0, 0], ['yy', 1, 1], ['xy', 0, 1]];
    const coll = [];
    for (let i = 0; i < Q; i++) {
      coll.push(`float e${i} = feq(${f(L.w[i])}, ${dot3(L.c[i], 'u')}, uu, rho); float n${i} = f${i} - e${i};`);
    }
    for (const [nm, a, b] of pairs) {
      const t = [];
      for (let i = 0; i < Q; i++) {
        const v = L.c[i][a] * L.c[i][b];
        if (v === 1) t.push(`+ n${i}`);
        else if (v === -1) t.push(`- n${i}`);
      }
      coll.push(`float P${nm} = ${t.join(' ').replace(/^\+ /, '') || '0.0'};`);
    }
    const qn = this.dim3
      ? 'sqrt(Pxx*Pxx + Pyy*Pyy + Pzz*Pzz + 2.0*(Pxy*Pxy + Pxz*Pxz + Pyz*Pyz))'
      : 'sqrt(Pxx*Pxx + Pyy*Pyy + 2.0*Pxy*Pxy)';
    const post = [];
    for (let i = 0; i < Q; i++) {
      const c = L.c[i];
      const terms = [];
      for (const [nm, a, b] of pairs) {
        let coef;
        if (a === b) coef = c[a] * c[a] - 1 / 3;
        else coef = 2 * c[a] * c[b];
        if (Math.abs(coef) > 1e-9) terms.push(`${f(coef)} * P${nm}`);
      }
      // partie isotrope (volumique) relaxée à part : amortit les ondes acoustiques
      const D = this.dim3 ? 3 : 2;
      const c2 = c[0] * c[0] + c[1] * c[1] + c[2] * c[2];
      const iso = c2 - D / 3;
      const isoTerm = Math.abs(iso) > 1e-9 ? ` + omd * trD * ${f(iso)}` : '';
      post.push(`float g${i} = e${i} + ${f(4.5 * L.w[i])} * (om * (${terms.join(' + ') || '0.0'})${isoTerm});`);
    }

    const outDecl = (group) => group.map((t, k) => `layout(location=${k}) out vec4 out${t};`).join('\n');
    const outWrite = (group, v) => group.map((t) => {
      const vals = [0, 1, 2, 3].map((k) => (4 * t + k < Q ? v(4 * t + k) : '0.0'));
      return `out${t} = vec4(${vals.join(', ')});`;
    }).join('\n  ');

    const feqFn = /* glsl */ `
float feq(float w, float cu, float uu, float rho) { return w * rho * (1.0 + 3.0 * cu + 4.5 * cu * cu - 1.5 * uu); }
`;
    const inletFn = /* glsl */ `
uniform vec3 uUin;
uniform float uTurb;
uniform float uTime;
vec3 inletVel(ivec3 p) {
  if (uTurb <= 0.0) return uUin;
  vec3 q = vec3(p) * 0.21;
  float t = uTime * 0.013;
  vec3 n = vec3(
    sin(q.y * 1.3 + t * 1.7) * cos(q.z * 0.9 - t * 1.1) + 0.5 * sin(q.y * 2.9 - t * 2.3 + q.z * 1.7),
    cos(q.y * 1.1 - t * 1.3 + 1.2) * sin(q.z * 1.4 + t * 0.7 + 0.4),
    sin(q.z * 1.2 + t * 1.9 + 2.1) * cos(q.y * 0.8 + t * 0.5));
  return uUin + uTurb * length(uUin) * 0.9 * n;
}
`;

    this.stepMats = this.groups.map((group) => {
      const fs = `${this.atlasHeader}
${samplers}
uniform float uTau0;
uniform float uCs2;
uniform float uGroundU;
uniform float uSponge;
${outDecl(group)}
${feqFn}
${inletFn}
${this._wheelFns()}
uniform float uAbsorb;
uniform float uTauBulk;
uniform float uAbsorbOut;
// couches absorbantes : relaxation vers l'écoulement amont (amortit les ondes acoustiques)
float absorb(ivec3 p) {
  float xi = (float(p.x) + 0.5) / float(NX);
  float a = 1.0 - smoothstep(0.0, 0.05, xi);
  return a * a * uAbsorb;
}
void main() {
  ivec2 pix = ivec2(gl_FragCoord.xy);
  ivec3 p = cellOf(pix);
  ${this.dim3 ? `if (p.z >= NZ) { ${outWrite(group, () => '0.0')} return; }` : ''}
  vec4 s = texelFetch(uSolid, pix, 0);
  if (s.r > 0.5) { ${outWrite(group, () => '0.0')} return; }
  int mask = int(s.g + 0.5);
  ${ownFetch}
  vec3 uin = inletVel(p);
  float uin2 = dot(uin, uin);
  float rhoOwn = ${Array.from({ length: Q }, (_, i) => own(i)).join(' + ')};
  if (rhoOwn < 0.05) {
    ${outWrite(group, (i) => f(L.w[i]))}
    return;
  }
  vec3 uOut = uin;
  if (p.x == NX - 1) {
    float ro = max(rhoOwn, 0.2);
    uOut = vec3(${momOwn}) / ro;
    float lo = length(uOut);
    if (lo > 0.3) uOut *= 0.3 / lo;
  }
  float uOut2 = dot(uOut, uOut);
  ${stream.join('\n  ')}
  float rho = ${rhoExpr};
  vec3 u = vec3(${momExpr.join(', ')}) / rho;
  bool bad = !(rho > 0.25 && rho < 4.0) || isnan(u.x) || isnan(u.y) || isnan(u.z);
  if (bad) { rho = 1.0; u = uin; }
  float uu = dot(u, u);
  if (uu > 0.12) { u *= sqrt(0.12 / uu); uu = 0.12; }
  ${coll.join('\n  ')}
  float Qn = bad ? 0.0 : ${qn};
  float tau = 0.5 * (uTau0 + sqrt(uTau0 * uTau0 + 25.4558441 * uCs2 * Qn / rho));
  float sp = clamp((float(p.x) - float(NX) * 0.86) / (float(NX) * 0.14), 0.0, 1.0);
  tau += uSponge * sp * sp;
  float om = bad ? 0.0 : 1.0 - 1.0 / tau;
  float omd = (bad ? 0.0 : 1.0 - 1.0 / uTauBulk) - om;
  float trD = (${this.dim3 ? 'Pxx + Pyy + Pzz) / 3.0' : 'Pxx + Pyy) / 2.0'};
  ${post.join('\n  ')}
  // éponge de sortie : ramène progressivement la pression à l'ambiante (absorbe les ondes)
  float abo = sp * sp * uAbsorbOut;
  if (abo > 0.0) {
    ${Array.from({ length: Q }, (_, i) => `g${i} = mix(g${i}, feq(${f(L.w[i])}, ${dot3(L.c[i], 'u')}, uu, 1.0), abo);`).join('\n    ')}
  }
  float ab = absorb(p);
  if (ab > 0.0) {
    ${Array.from({ length: Q }, (_, i) => `g${i} = mix(g${i}, feq(${f(L.w[i])}, ${dot3(L.c[i], 'uin')}, uin2, 1.0), ab);`).join('\n    ')}
  }
  ${outWrite(group, (i) => `g${i}`)}
}`;
      const uniforms = {
        uSolid: { value: this.solidTex },
        uTau0: { value: this.params.tau0 },
        uCs2: { value: this.params.cs ** 2 },
        uGroundU: { value: this.params.groundU },
        uSponge: { value: this.params.sponge },
        uAbsorb: { value: 0.06 },
        uTauBulk: { value: 1.0 },
        uAbsorbOut: { value: 0.08 },
        uUin: { value: new THREE.Vector3(this.params.U, 0, 0) },
        uTurb: { value: 0 },
        uTime: { value: 0 },
        uWheelC: { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) },
        uWheelW: { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) },
      };
      for (let t = 0; t < nTex; t++) uniforms[`uF${t}`] = { value: null };
      return this.gpu.material(fs, uniforms);
    });

    // ---- initialisation (un matériau par groupe de textures) ----
    this.initMats = this.groups.map((group) => {
      const fs = `${this.atlasHeader}
uniform sampler2D uSolid;
uniform vec3 uU0;
${outDecl(group)}
${feqFn}
void main() {
  ivec2 pix = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uSolid, pix, 0);
  vec3 u = s.r > 0.5 ? vec3(0.0) : uU0;
  float rho = s.r > 0.5 ? 0.0 : 1.0;
  float uu = dot(u, u);
  ${Array.from({ length: Q }, (_, i) => `float e${i} = feq(${f(L.w[i])}, ${dot3(L.c[i], 'u')}, uu, rho);`).join('\n  ')}
  ${outWrite(group, (i) => `e${i}`)}
}`;
      return this.gpu.material(fs, { uSolid: { value: this.solidTex }, uU0: { value: new THREE.Vector3() } });
    });

    // ---- grandeurs macroscopiques : (u/U, v/U, w/U, Cp) ----
    {
      const fs = `${this.atlasHeader}
${samplers}
uniform sampler2D uSolid;
uniform float uInvU;
uniform float uCpScale;
out vec4 outM;
void main() {
  ivec2 pix = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uSolid, pix, 0);
  if (s.r > 0.5) { outM = vec4(0.0); return; }
  ${ownFetch}
  ${Array.from({ length: Q }, (_, i) => `float f${i} = ${own(i)};`).join(' ')}
  float rho = ${rhoExpr};
  vec3 u = vec3(${momExpr.join(', ')}) / max(rho, 1e-6);
  outM = vec4(u * uInvU, (rho - 1.0) * uCpScale);
}`;
      const uniforms = { uSolid: { value: this.solidTex }, uInvU: { value: 10 }, uCpScale: { value: 1 } };
      for (let t = 0; t < nTex; t++) uniforms[`uF${t}`] = { value: null };
      this.macroMat = this.gpu.material(fs, uniforms);
    }

    // ---- moyenne temporelle glissante du champ macroscopique ----
    this.meanMat = this.gpu.material(`precision highp float; precision highp sampler2D;
uniform sampler2D uCur;
uniform sampler2D uPrev;
uniform float uA;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  o = mix(texelFetch(uPrev, p, 0), texelFetch(uCur, p, 0), uA);
}`, { uCur: { value: null }, uPrev: { value: null }, uA: { value: 1 } });

    // ---- efforts (échange de quantité de mouvement) ----
    const makeForce = (moments) => {
      const terms = [];
      for (let j = 1; j < Q; j++) {
        const c = L.c[j];
        const bit = 1 << L.opp[j];
        terms.push(`if ((mask & ${bit}) != 0${this.sym && c[2] < 0 ? ' && p.z > 0' : ''}) {
    ivec3 q = p + ivec3(${c[0]}, ${c[1]}, ${c[2]});
    int cat = int(texelFetch(uSolid, pixOf(q), 0).r + 0.5);
    vec3 cj = vec3(${c[0]}.0, ${c[1]}.0, ${c[2]}.0);
    float uwc = cat >= ${WHEEL_CAT0} ? dot(wallVel(q), cj) : 0.0;
    vec3 F = cj * (2.0 * (${own(j)} - ${f(L.w[j])} * uRho0) - ${f(6 * L.w[j])} * uwc);
    vec3 r = vec3(p) + 0.5 + 0.5 * cj - uRef;
    ${moments ? 'acc(cat, F, r);' : 'acc(cat - uCatBase, F, r);'}
  }`);
      }
      const accFn = moments
        ? `void acc(int cat, vec3 F, vec3 r) { a0.xyz += cross(r, F); a1.xyz += F; a1.w += 1.0; }`
        : `void acc(int k, vec3 F, vec3 r) {
  vec4 v = vec4(F, r.x * F.y - r.y * F.x);
  if (k == 0) a0 += v; else if (k == 1) a1 += v; else if (k == 2) a2 += v; else if (k == 3) a3 += v;
}`;
      const fs = `${this.atlasHeader}
${samplers}
uniform vec3 uRef;
uniform int uCatBase;
uniform float uRho0;
layout(location=0) out vec4 r0;
layout(location=1) out vec4 r1;
layout(location=2) out vec4 r2;
layout(location=3) out vec4 r3;
${this._wheelFns()}
vec4 a0 = vec4(0.0), a1 = vec4(0.0), a2 = vec4(0.0), a3 = vec4(0.0);
${accFn}
void main() {
  ivec2 pix = ivec2(gl_FragCoord.xy);
  ivec3 p = cellOf(pix);
  r0 = vec4(0.0); r1 = vec4(0.0); r2 = vec4(0.0); r3 = vec4(0.0);
  ${this.dim3 ? 'if (p.z >= NZ) return;' : ''}
  vec4 s = texelFetch(uSolid, pix, 0);
  if (s.r > 0.5) return;
  int mask = int(s.g + 0.5);
  if (mask == 0) return;
  ${ownFetch}
  ${terms.join('\n  ')}
  r0 = a0; r1 = a1; r2 = a2; r3 = a3;
}`;
      const uniforms = {
        uSolid: { value: this.solidTex },
        uRef: { value: new THREE.Vector3() },
        uCatBase: { value: 1 },
        uRho0: { value: 1 },
        uWheelC: { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) },
        uWheelW: { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) },
      };
      for (let t = 0; t < nTex; t++) uniforms[`uF${t}`] = { value: null };
      return this.gpu.material(fs, uniforms);
    };
    this.forceMat = makeForce(false);
    this.momentMat = makeForce(true);
  }

  // ---------------------------------------------------------------------
  index(i, j, k) {
    return i + this.nx * (j + this.ny * k);
  }
  pixIndex(i, j, k) {
    const ty = Math.floor(k / this.tx), tx = k - ty * this.tx;
    return (ty * this.ny + j) * this.texW + tx * this.nx + i;
  }

  /**
   * Charge la géométrie voxelisée.
   * @param {Uint8Array} cat catégorie par cellule (0 = fluide)
   * @param {Array} wheels [{c:[x,y,z] (cellules), w:[wx,wy,wz] (rad/pas)}] (indices 0..3 → catégories 5..8)
   */
  setSolid(cat, wheels = []) {
    this.cat = cat;
    const { nx, ny, nz, L } = this;
    const data = this.solidData;
    data.fill(0);
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const id = this.index(i, j, k);
          const pi = this.pixIndex(i, j, k) * 4;
          const cc = cat[id];
          data[pi] = cc;
          if (cc) continue;
          let mask = 0;
          for (let d = 1; d < L.Q; d++) {
            const qi = i - L.c[d][0], qj = j - L.c[d][1];
            let qk = k - L.c[d][2];
            if (this.sym && qk < 0) qk = -qk - 1;
            if (qi < 0 || qi >= nx || qj < 0 || qj >= ny || qk < 0 || qk >= nz) continue;
            if (cat[this.index(qi, qj, qk)]) mask |= 1 << d;
          }
          data[pi + 1] = mask;
        }
      }
    }
    // indicateur « soubassement résolu » pour le sol roulant (canal b des cellules du sol)
    if (this.bottom === 'ground') {
      const minGap = 3;
      const lowSolid = new Int16Array(nx * nz).fill(32767);
      for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        for (let j = 0; j < Math.min(ny, minGap); j++) if (cat[this.index(i, j, k)]) { lowSolid[i + nx * k] = j; break; }
      }
      for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        let covered = false;
        for (let dk = -1; dk <= 1 && !covered; dk++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, kk = k + dk;
          if (ii < 0 || ii >= nx || kk < 0 || kk >= nz) continue;
          if (lowSolid[ii + nx * kk] < minGap) { covered = true; break; }
        }
        data[this.pixIndex(i, 0, k) * 4 + 2] = covered || this.slipGround ? 0 : 1;
      }
    }
    this.solidTex.needsUpdate = true;
    this.setWheels(wheels);
  }

  setWheels(wheels) {
    this.wheels = wheels;
    const mats = [...this.stepMats, this.forceMat, this.momentMat];
    for (const m of mats) {
      for (let w = 0; w < 4; w++) {
        const wh = wheels[w];
        m.uniforms.uWheelC.value[w].set(...(wh ? wh.c : [0, 0, 0]));
        m.uniforms.uWheelW.value[w].set(...(wh ? wh.w : [0, 0, 0]));
      }
    }
  }

  setParams(p) {
    Object.assign(this.params, p);
    const P = this.params;
    for (const m of this.stepMats) {
      m.uniforms.uTau0.value = P.tau0;
      m.uniforms.uCs2.value = P.cs * P.cs;
      m.uniforms.uGroundU.value = P.groundU;
      m.uniforms.uSponge.value = P.sponge;
      m.uniforms.uAbsorb.value = P.absorb ?? 0.06;
      m.uniforms.uUin.value.set(P.U, 0, 0);
      m.uniforms.uTurb.value = P.turb;
    }
    this.macroMat.uniforms.uInvU.value = 1 / P.U;
    this.macroMat.uniforms.uCpScale.value = 1 / (3 * 0.5 * P.U * P.U);
  }

  reset(u0 = this.params.U) {
    for (let g = 0; g < this.groups.length; g++) {
      const m = this.initMats[g];
      m.uniforms.uU0.value.set(u0, 0, 0);
      this.gpu.pass(m, this.A.rts[g]);
      this.gpu.pass(m, this.B.rts[g]);
    }
    this.time = 0;
    this.steps = 0;
  }

  step(n = 1) {
    for (let s = 0; s < n; s++) {
      for (let g = 0; g < this.stepMats.length; g++) {
        const m = this.stepMats[g];
        for (let t = 0; t < this.L.nTex; t++) m.uniforms[`uF${t}`].value = this.A.textures[t];
        m.uniforms.uTime.value = this.time;
        this.gpu.pass(m, this.B.rts[g]);
      }
      const tmp = this.A;
      this.A = this.B;
      this.B = tmp;
      this.time += 1;
      this.steps += 1;
    }
  }

  computeMacro() {
    const m = this.macroMat;
    for (let t = 0; t < this.L.nTex; t++) m.uniforms[`uF${t}`].value = this.A.textures[t];
    this.gpu.pass(m, this.macro);
    return this.macro;
  }

  // Moyenne exponentielle sur ~tauSteps pas (à appeler après computeMacro)
  updateMean(steps, tauSteps) {
    if (steps <= 0 && !this.meanFresh) return;
    const a = this.meanFresh ? 1 : 1 - Math.exp(-steps / Math.max(1, tauSteps));
    this.meanFresh = false;
    const u = this.meanMat.uniforms;
    u.uCur.value = this.macro.texture;
    u.uPrev.value = this.meanRT[this.meanIdx].texture;
    u.uA.value = a;
    this.gpu.pass(this.meanMat, this.meanRT[1 - this.meanIdx]);
    this.meanIdx = 1 - this.meanIdx;
  }
  resetMean() {
    this.meanFresh = true;
  }
  get mean() {
    return this.meanRT[this.meanIdx];
  }

  /**
   * Mesure des efforts (unités réseau). ref = point de référence des moments (cellules).
   * Renvoie { cats: [ [Fx,Fy,Fz,Mz] x8 ], moment: [Mx,My,Mz], total: [Fx,Fy,Fz] }
   */
  async measureForces(ref, withMoments = true, nCats = NUM_CATS) {
    const fm = this.forceMat;
    for (let t = 0; t < this.L.nTex; t++) {
      fm.uniforms[`uF${t}`].value = this.A.textures[t];
      this.momentMat.uniforms[`uF${t}`].value = this.A.textures[t];
    }
    fm.uniforms.uRef.value.set(ref[0], ref[1], ref[2]);
    this.momentMat.uniforms.uRef.value.set(ref[0], ref[1], ref[2]);
    const cats = [];
    for (let base = 1; base <= nCats; base += 4) {
      fm.uniforms.uCatBase.value = base;
      this.gpu.pass(fm, this.force);
      const sums = await this.reducer.sum(this.force.textures);
      cats.push(...sums);
    }
    let moment = [0, 0, 0], total = [0, 0, 0];
    if (withMoments) {
      this.gpu.pass(this.momentMat, this.force);
      const sums = await this.reducer.sum(this.force.textures);
      moment = sums[0].slice(0, 3);
      total = sums[1].slice(0, 3);
    }
    return { cats, moment, total };
  }

  dispose() {
    for (const rt of [...this.A.rts, ...this.B.rts]) rt.dispose();
    this.macro.dispose();
    for (const rt of this.meanRT) rt.dispose();
    this.meanMat.dispose();
    this.force.dispose();
    this.reducer.dispose();
    this.solidTex.dispose();
    for (const m of [...this.stepMats, ...this.initMats, this.macroMat, this.forceMat, this.momentMat]) m.dispose();
  }
}
