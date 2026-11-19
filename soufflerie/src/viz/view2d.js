// Vue 2D : champ (fumée, vitesse, pression, vorticité, pertes de charge), lignes de courant,
// sonde, distribution de Cp et profil de sillage.
import * as THREE from 'three';
import { COLORMAPS, BILINEAR } from './glsl.js';

export const MODES_2D = [
  { id: 'smoke', label: 'Fumée' },
  { id: 'speed', label: 'Vitesse |V|/V∞' },
  { id: 'cp', label: 'Pression Cp' },
  { id: 'vort', label: 'Vorticité ω·L/V∞' },
  { id: 'loss', label: 'Pertes de pression totale' },
  { id: 'ux', label: 'Vitesse axiale u/V∞' },
];

export class View2D {
  constructor(gpu, overlay) {
    this.gpu = gpu;
    this.overlay = overlay;
    this.ctx = overlay.getContext('2d');
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.view = { cx: 0, cy: 0, ppc: 1 }; // centre (cellules), pixels par cellule
    this.settings = { mode: 'smoke', mean: false, cmap: 0, smokeOverlay: false, streamlines: false, range: { speed: 1.6, cp: 1.2, vort: 60, loss: 1, ux: 1.4 }, rakeCount: 32, rakeSpan: 1.0, rakeY: 0.5 };
    this.belt = 0;
    this.readback = null;
    this.readbackAt = 0;
    this.stream = [];
    this.probe = null;
  }

  attach(tunnel) {
    this.tunnel = tunnel;
    const g = tunnel.grid;
    if (this.dims && this.dims[0] === g.nx && this.dims[1] === g.ny) {
      this.clearDye();
      return;
    }
    this.dispose();
    this.dims = [g.nx, g.ny];
    const nx = g.nx, ny = g.ny;
    this.dye = [0, 1, 2, 3].map(() => this.gpu.target(nx, ny, 1));
    const header = /* glsl */ `precision highp float; precision highp int; precision highp sampler2D;
const ivec2 N = ivec2(${nx}, ${ny});
${BILINEAR}`;
    this.advectMat = this.gpu.material(`${header}
uniform sampler2D uPhi;
uniform sampler2D uMacro;
uniform float uDt;
out vec4 o;
void main() {
  vec2 x = gl_FragCoord.xy;
  vec2 u1 = bsample(uMacro, x, N).xy * uDt;
  vec2 u2 = bsample(uMacro, x - 0.5 * u1, N).xy * uDt;
  o = vec4(bsample(uPhi, x - u2, N).r, 0.0, 0.0, 1.0);
}`, { uPhi: { value: null }, uMacro: { value: null }, uDt: { value: 1 } });
    this.combineMat = this.gpu.material(`${header}
uniform sampler2D uPhi;
uniform sampler2D uHat;
uniform sampler2D uTil;
uniform sampler2D uMacro;
uniform sampler2D uSolid;
uniform float uDt;
uniform vec4 uRake;
uniform float uRakeW;
uniform float uDecay;
out vec4 o;
void main() {
  vec2 x = gl_FragCoord.xy;
  ivec2 ip = ivec2(x);
  if (texelFetch(uSolid, ip, 0).r > 0.5) { o = vec4(0.0); return; }
  float hat = texelFetch(uHat, ip, 0).r;
  float til = texelFetch(uTil, ip, 0).r;
  float phi = texelFetch(uPhi, ip, 0).r;
  float v = hat + 0.5 * (phi - til);
  // limiteur : borne par les voisins du point de départ
  vec2 u1 = bsample(uMacro, x, N).xy * uDt;
  vec2 src = x - u1 - 0.5;
  ivec2 b = ivec2(floor(src));
  float a0 = bfetch(uPhi, b, N).r, a1 = bfetch(uPhi, b + ivec2(1, 0), N).r;
  float a2 = bfetch(uPhi, b + ivec2(0, 1), N).r, a3 = bfetch(uPhi, b + ivec2(1, 1), N).r;
  v = clamp(v, min(min(a0, a1), min(a2, a3)), max(max(a0, a1), max(a2, a3)));
  v *= uDecay;
  // injection par le peigne à fumée
  if (abs(x.x - uRake.x) < 1.6 && uRake.w > 0.0) {
    float k = floor((x.y - uRake.y) / uRake.z + 0.5);
    if (k >= 0.0 && k < uRake.w && abs(x.y - (uRake.y + k * uRake.z)) < uRakeW) v = 1.0;
  }
  o = vec4(v, 0.0, 0.0, 1.0);
}`, {
      uPhi: { value: null }, uHat: { value: null }, uTil: { value: null }, uMacro: { value: null }, uSolid: { value: null },
      uDt: { value: 1 }, uRake: { value: new THREE.Vector4() }, uRakeW: { value: 1 }, uDecay: { value: 0.9995 },
    });
    this.displayMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: `in vec3 position; void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `${header}
${COLORMAPS}
uniform sampler2D uMacro;
uniform sampler2D uDye;
uniform sampler2D uSolid;
uniform vec2 uRes;
uniform vec3 uView;
uniform int uMode;
uniform float uRange;
uniform bool uSmokeOver;
uniform bool uGround;
uniform float uBelt;
uniform float uLcells;
out vec4 outColor;
vec3 carColor(float cat) {
  if (cat > 4.5) return vec3(0.15, 0.16, 0.18);
  if (cat > 3.5) return vec3(0.62, 0.66, 0.72);
  if (cat > 2.5) return vec3(0.62, 0.66, 0.72);
  if (cat > 1.5) return vec3(0.45, 0.49, 0.55);
  return vec3(0.80, 0.83, 0.87);
}
void main() {
  vec2 c = (gl_FragCoord.xy - 0.5 * uRes) / uView.z + uView.xy;
  vec3 bg = vec3(0.035, 0.047, 0.063);
  if (c.y < 0.0 && uGround) {
    if (-c.y * uView.z > 34.0 * uRes.y / 900.0 + 6.0) { outColor = vec4(bg * 0.7, 1.0); return; }
    float s = fract((c.x - uBelt) / 14.0 + c.y / 28.0);
    vec3 g = mix(vec3(0.10, 0.11, 0.125), vec3(0.13, 0.14, 0.16), step(0.5, s));
    g *= 1.0 - smoothstep(0.0, -60.0, c.y) * 0.4;
    float edge = smoothstep(-1.2 / uView.z - 0.6, 0.0, c.y);
    outColor = vec4(mix(g, vec3(0.55, 0.6, 0.68), edge * 0.6), 1.0);
    return;
  }
  if (c.x < 0.0 || c.y < 0.0 || c.x > float(N.x) || c.y > float(N.y)) { outColor = vec4(bg * 0.7, 1.0); return; }
  vec4 m = bsample(uMacro, c, N);
  float dye = bsample(uDye, c, N).r;
  vec3 col;
  if (uMode == 0) {
    col = bg + vec3(0.02, 0.03, 0.05) * (1.0 - length(m.xy));
    float d = smoothstep(0.0, 0.85, dye);
    col = mix(col, vec3(0.93, 0.96, 1.0), d * 0.95);
  } else if (uMode == 1) {
    col = cmSeq(length(m.xy) / uRange);
  } else if (uMode == 2) {
    col = cmDiverge(0.5 + 0.5 * m.w / uRange);
  } else if (uMode == 3) {
    vec2 ex = vec2(1.0, 0.0), ey = vec2(0.0, 1.0);
    float dvdx = (bsample(uMacro, c + ex, N).y - bsample(uMacro, c - ex, N).y) * 0.5;
    float dudy = (bsample(uMacro, c + ey, N).x - bsample(uMacro, c - ey, N).x) * 0.5;
    float w = (dvdx - dudy) * uLcells;
    col = cmDiverge(0.5 + 0.5 * w / uRange);
  } else if (uMode == 4) {
    float cp0 = m.w + dot(m.xy, m.xy);
    col = cmSeq(clamp((1.0 - cp0) / uRange, 0.0, 1.0));
  } else {
    col = cmDiverge(0.5 + 0.5 * m.x / uRange);
  }
  if (uSmokeOver && uMode != 0) col = mix(col, vec3(1.0), smoothstep(0.05, 0.9, dye) * 0.7);
  // voiture
  vec2 q = c - 0.5;
  ivec2 i0 = ivec2(floor(q));
  vec2 f = q - floor(q);
  float s00 = step(0.5, bfetch(uSolid, i0, N).r), s10 = step(0.5, bfetch(uSolid, i0 + ivec2(1, 0), N).r);
  float s01 = step(0.5, bfetch(uSolid, i0 + ivec2(0, 1), N).r), s11 = step(0.5, bfetch(uSolid, i0 + ivec2(1, 1), N).r);
  float sm = mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
  float aa = 0.5 / max(uView.z, 0.5);
  float cover = smoothstep(0.5 - aa - 0.02, 0.5 + aa + 0.02, sm);
  if (cover > 0.0) {
    float cat = texelFetch(uSolid, clamp(ivec2(floor(c)), ivec2(0), N - 1), 0).r;
    if (cat < 0.5) cat = max(max(bfetch(uSolid, i0, N).r, bfetch(uSolid, i0 + ivec2(1, 1), N).r), max(bfetch(uSolid, i0 + ivec2(1, 0), N).r, bfetch(uSolid, i0 + ivec2(0, 1), N).r));
    vec3 cc = carColor(cat);
    float rim = 1.0 - smoothstep(0.5, 0.5 + 3.0 * aa + 0.08, sm);
    cc = mix(cc, cc * 0.45, rim);
    col = mix(col, cc, cover);
  }
  outColor = vec4(pow(col, vec3(1.0)), 1.0);
}`,
      uniforms: {
        uMacro: { value: null }, uDye: { value: null }, uSolid: { value: null },
        uRes: { value: new THREE.Vector2(1, 1) }, uView: { value: new THREE.Vector3(0, 0, 1) },
        uMode: { value: 0 }, uRange: { value: 1 }, uSmokeOver: { value: false }, uGround: { value: true },
        uBelt: { value: 0 }, uLcells: { value: 100 }, uCmap: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad.material = this.displayMat;
    this.clearDye();
  }

  clearDye() {
    const r = this.gpu.renderer;
    const prev = r.getRenderTarget();
    for (const rt of this.dye) {
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 0);
      r.clear();
    }
    r.setRenderTarget(prev);
    this.dyeIdx = 0;
  }

  fit(width, height) {
    const t = this.tunnel;
    const g = t.grid;
    const b = t.bounds;
    const L = t.Lref;
    // cadrage par défaut : la voiture et son sillage proche
    const x0 = (b.min.x - 0.35 * L - g.x0) / g.dx, x1 = (b.max.x + 0.95 * L - g.x0) / g.dx;
    let y0, y1;
    if (t.mode === 'side') { y0 = -0.07 * (b.max.y * 2.8) / g.dx; y1 = (b.max.y * 2.8) / g.dx; }
    else { const hw = Math.max(1.7 * (b.max.z - b.min.z) / 2, 0.45 * L); y0 = (-hw - g.y0) / g.dx; y1 = (hw - g.y0) / g.dx; }
    const ppc = Math.min(width / (x1 - x0), height / (y1 - y0));
    this.view.ppc = ppc;
    this.view.cx = (x0 + x1) / 2;
    this.view.cy = (y0 + y1) / 2;
    this.fitted = { width, height };
  }

  // Avance la fumée de `steps` pas LBM
  advect(steps) {
    const t = this.tunnel;
    const sim = t.sim;
    const g = t.grid;
    const disp = steps * t.U; // déplacement max (cellules) pour |u|/U = 1
    const nSub = Math.max(1, Math.ceil(disp / 1.5));
    const dt = disp / nSub;
    const s = this.settings;
    // peigne à fumée
    const car = t.bounds;
    const rakeX = Math.max(3, (car.min.x - g.x0) / g.dx - 0.18 * t.Lref / g.dx);
    const span = s.rakeSpan * g.ny;
    const count = s.rakeCount;
    const yMid = s.rakeY * g.ny;
    const y0 = Math.max(1.5, yMid - span / 2);
    const spacing = Math.max(2, span / Math.max(1, count - 1));
    this.combineMat.uniforms.uRake.value.set(rakeX, y0, spacing, count);
    this.combineMat.uniforms.uRakeW.value = Math.max(0.9, g.nx / 900);
    this.combineMat.uniforms.uSolid.value = sim.solidTex;
    for (let k = 0; k < nSub; k++) {
      const [phi, hat, til, out] = [0, 1, 2, 3].map((j) => this.dye[(this.dyeIdx + j) % 4]);
      const am = this.advectMat.uniforms;
      am.uMacro.value = sim.fast.texture;
      am.uPhi.value = phi.texture;
      am.uDt.value = dt;
      this.gpu.pass(this.advectMat, hat);
      am.uPhi.value = hat.texture;
      am.uDt.value = -dt;
      this.gpu.pass(this.advectMat, til);
      const cm = this.combineMat.uniforms;
      cm.uPhi.value = phi.texture;
      cm.uHat.value = hat.texture;
      cm.uTil.value = til.texture;
      cm.uMacro.value = sim.fast.texture;
      cm.uDt.value = dt;
      this.gpu.pass(this.combineMat, out);
      this.dyeIdx = (this.dyeIdx + 3) % 4;
    }
    if (t.opts.rollingRoad) this.belt += disp;
  }

  render(renderer, width, height) {
    if (!this.fitted || this.fitted.width !== width || this.fitted.height !== height) this.fit(width, height);
    const t = this.tunnel;
    const u = this.displayMat.uniforms;
    const s = this.settings;
    const modeIdx = MODES_2D.findIndex((m) => m.id === s.mode);
    u.uMacro.value = t.field(this.settings.mean).texture;
    u.uDye.value = this.dye[this.dyeIdx].texture;
    u.uSolid.value = t.sim.solidTex;
    const dpr = renderer.getPixelRatio();
    u.uRes.value.set(width * dpr, height * dpr);
    u.uView.value.set(this.view.cx, this.view.cy, this.view.ppc * dpr);
    u.uMode.value = modeIdx;
    u.uRange.value = s.range[s.mode] ?? 1;
    u.uSmokeOver.value = s.smokeOverlay;
    u.uGround.value = t.mode === 'side';
    u.uBelt.value = this.belt;
    u.uLcells.value = t.Lref / t.grid.dx;
    u.uCmap.value = s.cmap;
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }

  // --- Transformations écran ↔ cellules ---
  toCell(px, py, height) {
    return [(px - this.fitted.width / 2) / this.view.ppc + this.view.cx, (height - py - this.fitted.height / 2) / this.view.ppc + this.view.cy];
  }
  toScreen(cx, cy) {
    return [(cx - this.view.cx) * this.view.ppc + this.fitted.width / 2, this.fitted.height - ((cy - this.view.cy) * this.view.ppc + this.fitted.height / 2)];
  }
  zoomAt(px, py, factor) {
    const [cx, cy] = this.toCell(px, py, this.fitted.height);
    const g = this.tunnel.grid;
    const minPpc = Math.min(this.fitted.width / g.nx, this.fitted.height / g.ny) * 0.8;
    this.view.ppc = Math.min(Math.max(this.view.ppc * factor, minPpc), 40);
    const [nx, ny] = this.toCell(px, py, this.fitted.height);
    this.view.cx += cx - nx;
    this.view.cy += cy - ny;
  }
  pan(dx, dy) {
    this.view.cx -= dx / this.view.ppc;
    this.view.cy += dy / this.view.ppc;
  }

  // --- Relecture CPU du champ (lignes de courant, sonde, Cp, sillage) ---
  async refreshReadback() {
    const t = this.tunnel;
    const g = t.grid;
    const sim = t.sim;
    const buf = await this.gpu.readAsync(t.field(this.settings.mean), 0, 0, g.nx, g.ny, 0, this.readback && this.readback.length === g.nx * g.ny * 4 ? this.readback : undefined);
    if (sim !== this.tunnel.sim) return;
    this.readback = buf;
    this.readbackAt = performance.now();
    if (this.settings.streamlines) this.computeStreamlines();
  }

  sampleCPU(x, y) {
    const g = this.tunnel.grid;
    const b = this.readback;
    if (!b) return null;
    const qx = Math.min(Math.max(x - 0.5, 0), g.nx - 1.001), qy = Math.min(Math.max(y - 0.5, 0), g.ny - 1.001);
    const i = Math.floor(qx), j = Math.floor(qy), fx = qx - i, fy = qy - j;
    const at = (a, bb, k) => b[(a + g.nx * bb) * 4 + k];
    const out = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) {
      out[k] = (at(i, j, k) * (1 - fx) + at(i + 1, j, k) * fx) * (1 - fy) + (at(i, j + 1, k) * (1 - fx) + at(i + 1, j + 1, k) * fx) * fy;
    }
    return out;
  }

  computeStreamlines() {
    const g = this.tunnel.grid;
    const cat = this.tunnel.cat;
    const lines = [];
    const n = 34;
    const ground = this.tunnel.mode === 'side';
    const h = 1.4;
    for (let s = 0; s < n; s++) {
      const y0 = ground ? 1 + ((g.ny * 0.92 - 1) * (s + 0.5)) / n * (s < n * 0.45 ? 1 : 1) : (g.ny * (s + 0.5)) / n;
      let x = 2, y = ground ? 1 + Math.pow((s + 0.5) / n, 1.6) * g.ny * 0.95 : y0;
      const pts = [[x, y]];
      for (let k = 0; k < g.nx * 2.5; k++) {
        const a = this.sampleCPU(x, y);
        if (!a) break;
        const sp = Math.hypot(a[0], a[1]);
        if (sp < 0.02) break;
        const mx = x + (0.5 * h * a[0]) / sp, my = y + (0.5 * h * a[1]) / sp;
        const b = this.sampleCPU(mx, my);
        const sb = Math.hypot(b[0], b[1]) || 1;
        x += (h * b[0]) / sb;
        y += (h * b[1]) / sb;
        if (x < 0 || x >= g.nx - 1 || y < 0.3 || y >= g.ny - 0.5) break;
        if (cat[Math.floor(x) + g.nx * Math.floor(y)]) break;
        if (k % 2 === 0) pts.push([x, y]);
      }
      lines.push(pts);
    }
    this.stream = lines;
  }

  // Cp le long des surfaces supérieure et inférieure (coupe longitudinale)
  cpDistribution() {
    const t = this.tunnel;
    const g = t.grid;
    const b = this.readback;
    if (!b || t.mode === 'top') return null;
    const cat = t.cat;
    const isCar = (i, j) => { const c = cat[i + g.nx * j]; return c > 0 && c < 5; };
    const upper = [], lower = [];
    const x0 = t.bounds.min.x, L = t.Lref;
    for (let i = 0; i < g.nx; i++) {
      let top = -1;
      for (let j = g.ny - 1; j >= 0; j--) if (isCar(i, j)) { top = j; break; }
      if (top < 0) continue;
      const xm = g.x0 + (i + 0.5) * g.dx;
      const xs = (xm - x0) / L;
      if (top + 1 < g.ny) upper.push([xs, b[(i + g.nx * (top + 1)) * 4 + 3]]);
      let bot = -1;
      for (let j = 0; j < g.ny; j++) if (isCar(i, j)) { bot = j; break; }
      if (bot > 0) lower.push([xs, b[(i + g.nx * (bot - 1)) * 4 + 3]]);
    }
    return { upper, lower };
  }

  wakeProfile(xFrac = 0.35) {
    const t = this.tunnel;
    const g = t.grid;
    const b = this.readback;
    if (!b) return null;
    const xw = t.bounds.max.x + xFrac * t.Lref;
    const i = Math.min(g.nx - 1, Math.max(0, Math.round((xw - g.x0) / g.dx - 0.5)));
    const pts = [];
    for (let j = 0; j < g.ny; j++) {
      const yv = g.y0 + (j + 0.5) * g.dx;
      pts.push([yv, b[(i + g.nx * j) * 4]]);
    }
    return { x: xw, i, pts };
  }

  drawOverlay(width, height) {
    const ctx = this.ctx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.overlay.width !== Math.round(width * dpr)) {
      this.overlay.width = Math.round(width * dpr);
      this.overlay.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const t = this.tunnel;
    if (!t || !this.fitted) return;
    // lignes de courant
    if (this.settings.streamlines && this.stream.length) {
      ctx.lineWidth = 1.1;
      ctx.strokeStyle = this.settings.mode === 'smoke' ? 'rgba(140,200,255,0.55)' : 'rgba(255,255,255,0.62)';
      for (const line of this.stream) {
        ctx.beginPath();
        line.forEach(([x, y], k) => {
          const [sx, sy] = this.toScreen(x, y);
          if (k) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy);
        });
        ctx.stroke();
      }
    }
    // échelle (1 m)
    const g = t.grid;
    const m1 = this.view.ppc / g.dx;
    let len = 1;
    if (m1 * len > 160) len = 0.5;
    if (m1 * len < 40) len = 2;
    const px = m1 * len;
    ctx.fillStyle = 'rgba(232,238,245,0.85)';
    ctx.fillRect(16, height - 22, px, 2);
    ctx.fillRect(16, height - 27, 1.5, 10);
    ctx.fillRect(16 + px - 1.5, height - 27, 1.5, 10);
    ctx.font = '500 11px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillText(`${len} m`, 22 + px, height - 18);
    // sonde
    if (this.probe) {
      const [sx, sy] = this.toScreen(this.probe.x, this.probe.y);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx, sy, 6, 0, Math.PI * 2);
      ctx.moveTo(sx - 11, sy); ctx.lineTo(sx - 3, sy);
      ctx.moveTo(sx + 3, sy); ctx.lineTo(sx + 11, sy);
      ctx.moveTo(sx, sy - 11); ctx.lineTo(sx, sy - 3);
      ctx.moveTo(sx, sy + 3); ctx.lineTo(sx, sy + 11);
      ctx.stroke();
    }
    // station de sillage
    if (this.showWake) {
      const w = this.wakeProfile(this.wakeX ?? 0.35);
      if (w) {
        const [sx] = this.toScreen(w.i + 0.5, 0);
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(255,190,90,0.8)';
        ctx.beginPath();
        ctx.moveTo(sx, this.toScreen(0, g.ny)[1]);
        ctx.lineTo(sx, this.toScreen(0, 0)[1]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  dispose() {
    if (this.dye) for (const rt of this.dye) rt.dispose();
    for (const m of [this.advectMat, this.combineMat, this.displayMat]) if (m) m.dispose();
    this.dye = null;
    this.dims = null;
    this.fitted = null;
  }
}
