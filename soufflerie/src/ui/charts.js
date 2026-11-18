// Graphiques canvas légers : traits fins, grille discrète, réticule + info-bulle au survol.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function niceTicks(min, max, n = 4) {
  if (!isFinite(min) || !isFinite(max)) return [];
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const err = step0 / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return ticks;
}

export const fmt = (v, d = 2) => (isFinite(v) ? v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');

export class LineChart {
  /**
   * opts: { height, series: [{ name, color }], xLabel, yLabel, invertY, swap (x vertical), xFmt, yFmt, yPad }
   */
  constructor(container, opts) {
    this.opts = { height: 150, yPad: 0.08, ...opts };
    this.wrap = document.createElement('div');
    this.wrap.className = 'chart';
    this.canvas = document.createElement('canvas');
    this.canvas.style.height = this.opts.height + 'px';
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    this.tip.hidden = true;
    this.wrap.append(this.canvas, this.tip);
    container.append(this.wrap);
    this.data = [];
    this.hover = null;
    this.canvas.addEventListener('pointermove', (e) => { this.hover = this._local(e); this.draw(); });
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.tip.hidden = true; this.draw(); });
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.canvas);
  }

  _local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  setData(data, extra = {}) {
    this.data = data;
    this.extra = extra;
    this.draw();
  }

  draw() {
    const cv = this.canvas;
    const w = cv.clientWidth, h = this.opts.height;
    if (!w) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const o = this.opts;
    const ink2 = css('--ink-2'), ink3 = css('--ink-3'), line = css('--line');
    const pad = { l: 46, r: 10, t: 10, b: 24 };
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    // bornes
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const s of this.data) for (const [x, y] of s) {
      if (!isFinite(x) || !isFinite(y)) continue;
      xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
    }
    if (this.extra?.yFixed) [ymin, ymax] = this.extra.yFixed;
    if (this.extra?.xFixed) [xmin, xmax] = this.extra.xFixed;
    for (const hl of this.extra?.hlines || []) { ymin = Math.min(ymin, hl.y); ymax = Math.max(ymax, hl.y); }
    if (!isFinite(xmin)) {
      ctx.fillStyle = ink3;
      ctx.font = '500 12.5px Barlow, system-ui, sans-serif';
      ctx.fillText(o.empty || 'En attente de mesures…', pad.l, pad.t + ph / 2);
      return;
    }
    if (ymax - ymin < 1e-9) { ymax += 0.5; ymin -= 0.5; }
    const yp = (ymax - ymin) * o.yPad;
    ymin -= yp; ymax += yp;
    if (xmax - xmin < 1e-9) xmax = xmin + 1;
    const X = (x) => pad.l + ((x - xmin) / (xmax - xmin)) * pw;
    const Y = (y) => (o.invertY ? pad.t + ((y - ymin) / (ymax - ymin)) * ph : pad.t + ph - ((y - ymin) / (ymax - ymin)) * ph);
    // grille + axes
    ctx.font = '500 11px "JetBrains Mono", ui-monospace, monospace';
    ctx.lineWidth = 1;
    const yt = niceTicks(ymin, ymax, 4);
    for (const v of yt) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = v === 0 ? css('--line-2') : line;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
      ctx.fillStyle = ink3;
      ctx.textAlign = 'right';
      ctx.fillText((o.yFmt || ((a) => fmt(a, 2)))(v), pad.l - 6, y + 3.5);
    }
    const xt = niceTicks(xmin, xmax, Math.max(2, Math.floor(pw / 70)));
    ctx.textAlign = 'center';
    for (const v of xt) {
      const x = X(v);
      if (x < pad.l - 1 || x > pad.l + pw + 1) continue;
      ctx.fillStyle = ink3;
      ctx.fillText((o.xFmt || ((a) => fmt(a, 1)))(v), x, h - 8);
    }
    if (o.xLabel) { ctx.textAlign = 'right'; ctx.fillStyle = ink3; ctx.fillText(o.xLabel, pad.l + pw, h - 8 - 0); }
    // lignes horizontales de référence (moyennes)
    for (const hl of this.extra?.hlines || []) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = hl.color;
      ctx.globalAlpha = 0.8;
      ctx.beginPath(); ctx.moveTo(pad.l, Y(hl.y)); ctx.lineTo(pad.l + pw, Y(hl.y)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    // séries
    ctx.save();
    ctx.beginPath(); ctx.rect(pad.l, pad.t - 2, pw, ph + 4); ctx.clip();
    this.data.forEach((s, k) => {
      const col = o.series[k]?.color || css('--series-1');
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let started = false;
      for (const [x, y] of s) {
        if (!isFinite(y)) { started = false; continue; }
        if (started) ctx.lineTo(X(x), Y(y)); else { ctx.moveTo(X(x), Y(y)); started = true; }
      }
      ctx.stroke();
      // point final mis en valeur
      const last = s[s.length - 1];
      if (last && o.endDot !== false && isFinite(last[1])) {
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(X(last[0]), Y(last[1]), 3.2, 0, Math.PI * 2); ctx.fill();
      }
    });
    ctx.restore();
    // réticule
    if (this.hover && this.hover.x >= pad.l && this.hover.x <= pad.l + pw) {
      const xv = xmin + ((this.hover.x - pad.l) / pw) * (xmax - xmin);
      ctx.strokeStyle = ink2;
      ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.moveTo(this.hover.x + 0.5, pad.t); ctx.lineTo(this.hover.x + 0.5, pad.t + ph); ctx.stroke();
      ctx.globalAlpha = 1;
      const rows = [];
      this.data.forEach((s, k) => {
        if (!s.length) return;
        let best = s[0], bd = Infinity;
        for (const p of s) { const d = Math.abs(p[0] - xv); if (d < bd) { bd = d; best = p; } }
        const col = o.series[k]?.color;
        ctx.fillStyle = col;
        ctx.strokeStyle = css('--panel');
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(X(best[0]), Y(best[1]), 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        rows.push(`<span style="color:${col}">●</span> ${o.series[k]?.name || ''} ${(o.yFmt || ((a) => fmt(a, 3)))(best[1])}`);
        if (k === 0) rows.unshift(`${o.xName || 'x'} ${(o.xFmt || ((a) => fmt(a, 2)))(best[0])}`);
      });
      this.tip.innerHTML = rows.join('<br>');
      this.tip.hidden = false;
      this.tip.style.left = Math.min(Math.max(this.hover.x, 70), w - 70) + 'px';
      this.tip.style.top = pad.t + 4 + 'px';
    }
  }
}
