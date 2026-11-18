// Composants d'interface minimalistes (sans framework).

let uid = 0;
const nid = (p) => `${p}-${++uid}`;

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}

export function group(title, ...children) {
  return el('section', { class: 'group' }, title ? el('div', { class: 'group-title' }, title) : null, ...children);
}

const setFill = (input) => {
  const t = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min));
  input.style.setProperty('--fill', `${Math.max(0, Math.min(1, t)) * 100}%`);
};

/**
 * Curseur avec valeur affichée. onInput: pendant le glissement ; onChange: au relâchement.
 */
export function slider({ label, min, max, step = 1, value, unit = '', format, onInput, onChange, id }) {
  const iid = id || nid('rng');
  const out = el('output', { for: iid });
  const fmtV = (v) => (format ? format(v) : Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 3 }));
  const render = (v) => { out.innerHTML = `${fmtV(v)}${unit ? `<span class="u">${unit}</span>` : ''}`; };
  const input = el('input', { type: 'range', id: iid, min, max, step, value });
  render(value);
  setFill(input);
  input.addEventListener('input', () => { render(input.value); setFill(input); onInput && onInput(Number(input.value)); });
  input.addEventListener('change', () => onChange && onChange(Number(input.value)));
  const wrap = el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('label', { for: iid }, label), out), input);
  wrap.set = (v) => { input.value = v; render(v); setFill(input); };
  wrap.input = input;
  return wrap;
}

export function toggle({ label, sub, checked, onChange, id }) {
  const iid = id || nid('tgl');
  const input = el('input', { type: 'checkbox', id: iid, role: 'switch' });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange && onChange(input.checked));
  const lab = el('label', { class: 'toggle', for: iid }, el('span', {}, label, sub ? el('small', {}, sub) : null), input);
  lab.set = (v) => { input.checked = !!v; };
  return lab;
}

export function chips({ options, value, onChange, label }) {
  const wrap = el('div', { class: 'chips', role: 'group', 'aria-label': label || '' });
  const btns = options.map(([v, text]) => {
    const b = el('button', { type: 'button', 'aria-pressed': String(v === value) }, text);
    b.addEventListener('click', () => {
      for (const o of btns) o.setAttribute('aria-pressed', String(o === b));
      onChange && onChange(v);
    });
    b.dataset.v = v;
    return b;
  });
  wrap.append(...btns);
  wrap.set = (v) => { for (const b of btns) b.setAttribute('aria-pressed', String(b.dataset.v === String(v))); };
  return wrap;
}

export function select({ label, options, value, onChange, id }) {
  const iid = id || nid('sel');
  const s = el('select', { id: iid }, ...options.map(([v, t]) => el('option', { value: v }, t)));
  s.value = value;
  s.addEventListener('change', () => onChange && onChange(s.value));
  return el('div', { class: 'field' }, el('div', { class: 'field-head' }, el('label', { for: iid }, label)), s);
}

export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2200);
}
