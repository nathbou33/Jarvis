// Petits utilitaires GPGPU au-dessus de Three.js : cibles de rendu flottantes,
// passes plein écran et lecture asynchrone des résultats.
import * as THREE from 'three';

export const QUAD_VERT = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export class GPU {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    const gl = renderer.getContext();
    gl.getExtension('EXT_color_buffer_float');
    this.maxDrawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS);
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.floatLinear = !!gl.getExtension('OES_texture_float_linear');
    this.max3D = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) || 256;
  }

  target(w, h, count = 1, { linear = false, type = THREE.FloatType } = {}) {
    const filter = linear ? THREE.LinearFilter : THREE.NearestFilter;
    const rt = new THREE.WebGLRenderTarget(w, h, {
      count,
      type,
      format: THREE.RGBAFormat,
      minFilter: filter,
      magFilter: filter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    for (const t of rt.textures) {
      t.minFilter = filter;
      t.magFilter = filter;
      t.generateMipmaps = false;
    }
    return rt;
  }

  material(fragmentShader, uniforms = {}, defines = {}) {
    return new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: QUAD_VERT,
      fragmentShader,
      uniforms,
      defines,
      depthTest: false,
      depthWrite: false,
    });
  }

  pass(material, target) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    this.quad.material = material;
    r.setRenderTarget(target);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
  }

  dataTexture(data, w, h, { linear = false } = {}) {
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;
    tex.magFilter = tex.minFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  readSync(rt, x, y, w, h, index = 0, out) {
    const buf = out || new Float32Array(w * h * 4);
    this.renderer.readRenderTargetPixels(rt, x, y, w, h, buf, undefined, index);
    return buf;
  }

  async readAsync(rt, x, y, w, h, index = 0, out) {
    const buf = out || new Float32Array(w * h * 4);
    try {
      await this.renderer.readRenderTargetPixelsAsync(rt, x, y, w, h, buf, undefined, index);
    } catch (e) {
      this.renderer.readRenderTargetPixels(rt, x, y, w, h, buf, undefined, index);
    }
    return buf;
  }
}

// Réduction (somme) GPU de 1 à 4 textures simultanément, par blocs R×R.
export class Reducer {
  constructor(gpu, w, h, n, R = 8) {
    this.gpu = gpu;
    this.n = n;
    this.levels = [];
    let cw = w, ch = h;
    do {
      cw = Math.ceil(cw / R);
      ch = Math.ceil(ch / R);
      this.levels.push({ w: cw, h: ch, rt: gpu.target(cw, ch, n) });
    } while (cw > 24 || ch > 24);
    const outs = [];
    const ins = [];
    const acc = [];
    const decl = [];
    for (let i = 0; i < n; i++) {
      ins.push(`uniform sampler2D uIn${i};`);
      outs.push(`layout(location=${i}) out vec4 o${i};`);
      decl.push(`vec4 a${i} = vec4(0.0);`);
      acc.push(`a${i} += texelFetch(uIn${i}, q, 0);`);
    }
    const fs = /* glsl */ `
precision highp float; precision highp int; precision highp sampler2D;
${ins.join('\n')}
uniform ivec2 uSize;
${outs.join('\n')}
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * ${R};
  ${decl.join('\n  ')}
  for (int j = 0; j < ${R}; j++) {
    for (int i = 0; i < ${R}; i++) {
      ivec2 q = base + ivec2(i, j);
      if (q.x < uSize.x && q.y < uSize.y) {
        ${acc.join('\n        ')}
      }
    }
  }
  ${Array.from({ length: n }, (_, i) => `o${i} = a${i};`).join('\n  ')}
}`;
    const uniforms = { uSize: { value: new THREE.Vector2(w, h) } };
    for (let i = 0; i < n; i++) uniforms[`uIn${i}`] = { value: null };
    this.mat = gpu.material(fs, uniforms);
    this.w = w;
    this.h = h;
    this.R = R;
  }

  // Lance la réduction, renvoie la cible finale (petite) à relire.
  run(textures) {
    let srcTex = textures;
    let sw = this.w, sh = this.h;
    for (const lv of this.levels) {
      for (let i = 0; i < this.n; i++) this.mat.uniforms[`uIn${i}`].value = srcTex[i];
      this.mat.uniforms.uSize.value.set(sw, sh);
      this.gpu.pass(this.mat, lv.rt);
      srcTex = lv.rt.textures;
      sw = lv.w;
      sh = lv.h;
    }
    return this.levels[this.levels.length - 1];
  }

  async sum(textures) {
    const lv = this.run(textures);
    const totals = [];
    for (let i = 0; i < this.n; i++) {
      const buf = await this.gpu.readAsync(lv.rt, 0, 0, lv.w, lv.h, i);
      const s = [0, 0, 0, 0];
      for (let k = 0; k < buf.length; k += 4) {
        s[0] += buf[k]; s[1] += buf[k + 1]; s[2] += buf[k + 2]; s[3] += buf[k + 3];
      }
      totals.push(s);
    }
    return totals;
  }

  dispose() {
    for (const lv of this.levels) lv.rt.dispose();
    this.mat.dispose();
  }
}
