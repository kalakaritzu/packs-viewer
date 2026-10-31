const $ = (s) => document.querySelector(s);
const ROW = 46;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

let ALL = [];
let VIEW = [];
let selPath = null;
const f = { terms: [], pack: null, types: new Set(), kind: 'all', key: '', bmin: null, bmax: null, fav: false };
let bpmBounds = [60, 200];
f.fuzzy = [];
f.shape = null;
f.sim = null;                         // { path, name, bands, shape, dur } while ranking by "similar to this sample"
let multi = new Set(), anchor = -1;  // multi-selection (ctrl/shift click) for dragging several samples at once
let sort = { col: 'pack', dir: 1 };
const SORTS = [['name', 'Name'], ['pack', 'Pack'], ['type', 'Type'], ['bpm', 'BPM'], ['key', 'Key'], ['dur', 'Length']];
let favs = new Set();
try { favs = new Set(JSON.parse(localStorage.getItem('favs') || '[]')); } catch {}
const saveFavs = () => { try { localStorage.setItem('favs', JSON.stringify([...favs])); } catch {} };
const pref = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDur = (d) => (d == null ? '' : d < 60 ? d.toFixed(2) + 's' : Math.floor(d / 60) + ':' + String(Math.floor(d % 60)).padStart(2, '0'));
const fmtTime = (d) => { d = Math.max(0, d || 0); return Math.floor(d / 60) + ':' + (d % 60).toFixed(2).padStart(5, '0'); };
const prettyPack = (p) => p.replace(/_/g, ' ').replace(/^\[(.+?)\]\s*/, '$1 – ');

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 1600);
}

// ---------- filtering ----------
function matches(it, skip) {
  if (skip !== 'pack' && f.pack && it.pack !== f.pack) return false;
  if (skip !== 'type' && f.types.size && !f.types.has(it.type)) return false;
  if (f.fav && !favs.has(it.path)) return false;
  if (f.kind === 'loop' && !it.loop) return false;
  if (f.kind === 'shot' && it.loop) return false;
  if (skip !== 'key' && f.key && it.key !== f.key) return false;
  if (f.bmin != null && (it.bpm == null || it.bpm < f.bmin)) return false;
  if (f.bmax != null && (it.bpm == null || it.bpm > f.bmax)) return false;
  for (let k = 0; k < f.terms.length; k++) {
    const t = f.terms[k];
    if (f.fuzzy[k] ? !fuzzyHit(it.words, t) : !it.hay.includes(t)) return false;
  }
  return true;
}

// A term that matches nothing literally falls back to typo / abbreviation matching per word ("kck" -> kick, "snaer" -> snare).
function editDist(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let min = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1); // swapped letters
      if (cur[j] < min) min = cur[j];
    }
    if (min > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[b.length];
}
function fuzzyHit(words, t) {
  const max = t.length >= 7 ? 2 : t.length >= 4 ? 1 : 0;
  for (const w of words) {
    if (max && editDist(t, w, max) <= max) return true;
    if (t.length >= 3 && w[0] === t[0] && w.length > t.length && w.length <= t.length * 2 + 2) {
      let i = 0; for (const c of w) if (c === t[i]) i++;
      if (i === t.length) return true;
    }
  }
  return false;
}
function compare(a, b) {
  const { col, dir } = sort;
  const va = a[col], vb = b[col];
  if (va == null && vb != null) return 1;
  if (vb == null && va != null) return -1;
  let r = 0;
  if (va != null) r = typeof va === 'number' ? va - vb : collator.compare(va, vb);
  if (r) return r * dir;
  return collator.compare(a.pack, b.pack) || collator.compare(a.rel, b.rel);
}
const activeCount = () => f.types.size + (f.kind !== 'all') + (f.bmin != null || f.bmax != null) + (f.key ? 1 : 0);

function refresh(keepScroll) {
  f.fuzzy = f.terms.map((t) => !ALL.some((i) => i.hay.includes(t)));
  VIEW = ALL.filter((it) => matches(it));
  if (f.shape) rankByShape(); else if (f.sim) rankBySimilar(); else VIEW.sort(compare);
  renderSide(); renderTags();
  $('#empty').hidden = VIEW.length > 0;
  $('#rows').style.height = VIEW.length * ROW + 'px';
  if (!keepScroll) $('#list').scrollTop = 0;
  renderRows();
  $('#count').textContent = `${VIEW.length.toLocaleString()} ${f.shape || f.sim ? 'closest ' : ''}sample${VIEW.length === 1 ? '' : 's'}${selCount() > 1 ? ' · ' + selCount() + ' selected' : ''}`;
  $('#sortLabel').textContent = sort.col === 'match' ? 'Best match' : SORTS.find((s) => s[0] === sort.col)[1] + (sort.dir > 0 ? ' ↑' : ' ↓');
  $('#btnShape').classList.toggle('lit', !!f.shape);
  if (popFor === $('#btnShape')) drawSketch();
  $('#qClear').hidden = !$('#q').value;
  const n = activeCount();
  $('#fBadge').hidden = !n; $('#fBadge').textContent = n;
  if (popFor === $('#btnFilters')) updateFilterPop();
}

// ---------- sidebar & tags ----------
function renderSide() {
  const counts = new Map();
  for (const it of ALL) if (matches(it, 'pack')) counts.set(it.pack, (counts.get(it.pack) || 0) + 1);
  const packs = [...new Set(ALL.map((i) => i.pack))].sort(collator.compare);
  $('#packs').innerHTML = packs.map((p) => {
    const n = counts.get(p) || 0;
    return `<button class="pack ${f.pack === p ? 'on' : ''} ${n ? '' : 'zero'}" data-pack="${esc(p)}" title="${esc(p)}"><span>${esc(prettyPack(p))}</span><em>${n}</em></button>`;
  }).join('');
  $('#navAll').classList.toggle('on', !f.pack && !f.fav);
  $('#navFav').classList.toggle('on', f.fav);
  $('#cntAll').textContent = ALL.length;
  $('#cntFav').textContent = ALL.reduce((n, i) => n + (favs.has(i.path) ? 1 : 0), 0);
}
function renderTags() {
  const t = [];
  const add = (id, label) => t.push(`<span class="tag">${esc(label)}<b data-rm="${esc(id)}">×</b></span>`);
  if (f.pack) add('pack', prettyPack(f.pack));
  for (const ty of f.types) add('type:' + ty, ty);
  if (f.kind !== 'all') add('kind', f.kind === 'loop' ? 'Loops' : 'One-shots');
  if (f.bmin != null || f.bmax != null) add('bpm', `${f.bmin ?? bpmBounds[0]}–${f.bmax ?? bpmBounds[1]} BPM`);
  if (f.key) add('key', 'Key ' + f.key);
  if (f.shape) add('shape', 'Shape match');
  if (f.sim) add('sim', 'Similar to ' + f.sim.name);
  $('#tags').innerHTML = t.join('');
}
$('#tags').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rm]'); if (!b) return;
  const id = b.dataset.rm;
  if (id === 'pack') f.pack = null;
  else if (id.startsWith('type:')) f.types.delete(id.slice(5));
  else if (id === 'kind') f.kind = 'all';
  else if (id === 'bpm') { f.bmin = f.bmax = null; bpmSlider.set(bpmBounds); }
  else if (id === 'key') f.key = '';
  else if (id === 'shape') { clearSketch(); return; }
  else if (id === 'sim') { clearSimilar(); return; }
  refresh();
});

// ---------- popovers ----------
const pop = $('#pop');
let popFor = null;
function closePop() { pop.hidden = true; if (popFor) popFor.classList.remove('open'); popFor = null; }
function openPop(anchor, { width, above, align = 'right' }) {
  if (popFor === anchor) { closePop(); return false; }
  closePop();
  popFor = anchor; anchor.classList.add('open'); pop.onclick = null;
  pop.hidden = false; pop.style.width = width + 'px';
  const r = anchor.getBoundingClientRect();
  let left = align === 'right' ? r.right - width : r.left;
  left = Math.max(8, Math.min(left, innerWidth - width - 8));
  pop.style.left = left + 'px';
  if (above) { pop.style.top = ''; pop.style.bottom = innerHeight - r.top + 8 + 'px'; }
  else { pop.style.bottom = ''; pop.style.top = r.bottom + 8 + 'px'; }
  return true;
}
document.addEventListener('mousedown', (e) => {
  if (!popFor || pop.contains(e.target) || popFor.contains(e.target)) return;
  closePop();
});

// custom slider: one value or a [lo, hi] range
function makeSlider(el, { min, max, values, step = 1, onInput }) {
  el.classList.add('slider');
  el.innerHTML = '<div class="track"><div class="fill"></div></div>';
  const track = el.firstChild, fill = track.firstChild;
  const thumbs = values.map(() => { const t = document.createElement('div'); t.className = 'thumb'; el.appendChild(t); return t; });
  let vals = values.slice(), range = max - min;
  const place = () => {
    const w = el.clientWidth - 16;
    thumbs.forEach((t, i) => { t.style.left = ((vals[i] - min) / range) * w + 'px'; });
    const lo = thumbs.length > 1 ? vals[0] : min;
    fill.style.left = ((lo - min) / range) * w + 'px';
    fill.style.right = (1 - (vals[vals.length - 1] - min) / range) * w + 'px';
  };
  const valAt = (x) => {
    const r = track.getBoundingClientRect();
    const v = min + Math.min(1, Math.max(0, (x - r.left) / r.width)) * range;
    return Math.round(v / step) * step;
  };
  let drag = -1;
  el.addEventListener('pointerdown', (e) => {
    const v = valAt(e.clientX);
    drag = thumbs.length === 1 ? 0 : (Math.abs(v - vals[0]) <= Math.abs(v - vals[1]) && !(v >= vals[1] && vals[0] === vals[1]) ? 0 : 1);
    el.setPointerCapture(e.pointerId); move(e);
  });
  const move = (e) => {
    if (drag < 0) return;
    let v = valAt(e.clientX);
    if (thumbs.length > 1) v = drag === 0 ? Math.min(v, vals[1]) : Math.max(v, vals[0]);
    vals[drag] = v; place(); onInput(vals.slice());
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', () => { drag = -1; });
  return { set(v) { vals = v.slice(); place(); }, place };
}

// ----- filters popover (built once, updated in place)
const filterPop = document.createElement('div');
filterPop.innerHTML = `
  <div class="pop-sec"><div class="pop-title">Type</div><div class="chips" id="fpTypes"></div></div>
  <div class="pop-sec"><div class="pop-title">Kind</div><div class="seg" id="fpKind"><button data-k="all">All</button><button data-k="shot">One-shots</button><button data-k="loop">Loops</button></div></div>
  <div class="pop-sec"><div class="pop-title">BPM <i id="fpBpmLbl">Any</i></div><div id="fpBpm"></div></div>
  <div class="pop-sec"><div class="pop-title">Key</div><div class="chips" id="fpKeys"></div></div>
  <div class="pop-sec" style="text-align:right"><button class="link" id="fpClear">Clear all filters</button></div>`;
const bpmSlider = makeSlider(filterPop.querySelector('#fpBpm'), {
  min: 60, max: 200, values: [60, 200],
  onInput: ([lo, hi]) => {
    f.bmin = lo <= bpmBounds[0] ? null : lo;
    f.bmax = hi >= bpmBounds[1] ? null : hi;
    bpmLabel(); refresh(true);
  },
});
function bpmLabel() {
  const l = filterPop.querySelector('#fpBpmLbl');
  l.textContent = f.bmin == null && f.bmax == null ? 'Any' : `${f.bmin ?? bpmBounds[0]} – ${f.bmax ?? bpmBounds[1]}`;
}
function updateFilterPop() {
  const tc = new Map(), kc = new Map();
  for (const it of ALL) {
    if (matches(it, 'type')) tc.set(it.type, (tc.get(it.type) || 0) + 1);
    if (it.key && matches(it, 'key')) kc.set(it.key, (kc.get(it.key) || 0) + 1);
  }
  const types = [...new Set(ALL.map((i) => i.type))].sort((a, b) => (a === 'Other') - (b === 'Other') || collator.compare(a, b));
  filterPop.querySelector('#fpTypes').innerHTML = types.map((t) =>
    `<button class="chip ${f.types.has(t) ? 'on' : ''} ${tc.get(t) ? '' : 'zero'}" data-type="${esc(t)}">${esc(t)}<em>${tc.get(t) || 0}</em></button>`).join('');
  const keys = [...new Set(ALL.map((i) => i.key).filter(Boolean))].sort(collator.compare);
  filterPop.querySelector('#fpKeys').innerHTML = keys.length
    ? keys.map((k) => `<button class="chip ${f.key === k ? 'on' : ''} ${kc.get(k) ? '' : 'zero'}" data-key="${esc(k)}">${esc(k)}</button>`).join('')
    : '<span class="sub">No keys detected</span>';
  filterPop.querySelectorAll('#fpKind button').forEach((b) => b.classList.toggle('on', b.dataset.k === f.kind));
  bpmLabel();
}
filterPop.addEventListener('click', (e) => {
  const t = e.target.closest('[data-type]'), k = e.target.closest('[data-key]'), kd = e.target.closest('[data-k]');
  if (t) { f.types.has(t.dataset.type) ? f.types.delete(t.dataset.type) : f.types.add(t.dataset.type); refresh(); }
  else if (k) { f.key = f.key === k.dataset.key ? '' : k.dataset.key; refresh(); }
  else if (kd) { f.kind = kd.dataset.k; refresh(); }
  else if (e.target.id === 'fpClear') clearFilters();
});
$('#btnFilters').onclick = () => {
  if (!openPop($('#btnFilters'), { width: 400 })) return;
  pop.replaceChildren(filterPop); updateFilterPop(); bpmSlider.place();
};

// ----- sort popover
$('#btnSort').onclick = () => {
  if (!openPop($('#btnSort'), { width: 190 })) return;
  const draw = () => {
    pop.innerHTML = (f.shape || f.sim ? [['match', 'Best match'], ...SORTS] : SORTS).map(([c, l]) => `<button class="menu-item ${sort.col === c ? 'on' : ''}" data-sort="${c}">${l}<i>${sort.col === c && c !== 'match' ? (sort.dir > 0 ? '↑' : '↓') : ''}</i></button>`).join('');
  };
  draw();
  pop.onclick = (e) => {
    const b = e.target.closest('[data-sort]'); if (!b) return;
    const c = b.dataset.sort;
    sort = sort.col === c && c !== 'match' ? { col: c, dir: -sort.dir } : { col: c, dir: 1 };
    if (c !== 'match') { setPref('sort', sort); prevSort = null; }
    refresh(); draw();
  };
};

// ----- sketch search: draw a volume-over-time shape, rank samples by how closely their outline matches
const SN = 48;
const SHAPES = new Map();               // path -> Float32Array(SN), peak-normalised volume outline per WAV
let shapeProg = null;                   // { done, total } while the backend is still reading files
let prevSort = null;
let sk = new Float32Array(SN).fill(-1); // -1 = column not drawn (matches anything)

const sketchPop = document.createElement('div');
sketchPop.innerHTML = `
  <div class="pop-sec"><div class="pop-title">Sketch a shape <i id="skStatus"></i></div>
    <canvas id="skCv"></canvas>
  </div>
  <div class="pop-sec"><div class="chips" id="skPresets"></div></div>
  <div class="pop-sec sk-row"><button class="chip" id="skSel">Match selected sample</button><button class="link" id="skClear">Clear</button></div>`;
const PRESETS = [
  ['Kick', (t) => Math.exp(-t * 7)],
  ['Pluck', (t) => Math.exp(-t * 3.5) * Math.min(1, t * 40)],
  ['Swell', (t) => t * t],
  ['Pad', (t) => Math.pow(Math.sin(Math.PI * t), 0.8)],
  ['Sustain', (t) => Math.min(1, t * 25, (1 - t) * 25) * 0.85],
  ['Gate', (t) => (t < 0.4 ? 1 : 0.03)],
  ['Beat', (t) => Math.exp(-((t * 4) % 1) * 5)],
];
sketchPop.querySelector('#skPresets').innerHTML = PRESETS.map(([n], i) => `<button class="chip" data-pre="${i}">${n}</button>`).join('');
const skCv = sketchPop.querySelector('#skCv');

// Curve height is "perceptual": position p maps to volume p*p, so the quiet end is not squashed into a sliver.
const SK_PAD = 0.07; // bottom/top strip that snaps to silence / full volume
function drawSketch() {
  const dpr = window.devicePixelRatio || 1, W = skCv.clientWidth, H = skCv.clientHeight;
  if (!W) return;
  if (skCv.width !== Math.round(W * dpr)) { skCv.width = Math.round(W * dpr); skCv.height = Math.round(H * dpr); }
  const g = skCv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const base = H * (1 - SK_PAD), span = H * (1 - 2 * SK_PAD), cw = W / SN;
  const y = (p) => base - p * span, x = (k) => (k + 0.5) * cw;
  const best = f.shape && VIEW[0] && SHAPES.get(VIEW[0].path);   // outline of the current best match
  const ghost = () => {
    if (!best) return;
    g.strokeStyle = 'rgba(38,255,133,.6)'; g.lineWidth = 1.5; g.beginPath();
    for (let i = 0; i < SN; i++) i ? g.lineTo(x(i), y(Math.sqrt(best[i]))) : g.moveTo(x(i), y(Math.sqrt(best[i])));
    g.stroke();
  };
  if (!sk.some((v) => v >= 0)) {
    g.fillStyle = '#8f8c9e'; g.font = '500 13px Inter, sans-serif'; g.textAlign = 'center';
    g.fillText('Draw a volume curve here, or pick a preset', W / 2, H / 2); return;
  }
  g.fillStyle = '#806cf5';
  for (let i = 0; i < SN;) {
    if (sk[i] < 0) { i++; continue; }
    let j = i; while (j + 1 < SN && sk[j + 1] >= 0) j++;
    g.beginPath(); g.moveTo(x(i) - cw / 2, base); g.lineTo(x(i) - cw / 2, y(sk[i]));
    for (let k = i; k <= j; k++) g.lineTo(x(k), y(sk[k]));
    g.lineTo(x(j) + cw / 2, y(sk[j])); g.lineTo(x(j) + cw / 2, base); g.closePath(); g.fill();
    i = j + 1;
  }
  ghost();
}
function skStatus() {
  const el = sketchPop.querySelector('#skStatus');
  el.textContent = shapeProg ? `Indexing ${shapeProg.done.toLocaleString()} / ${shapeProg.total.toLocaleString()}` : `${SHAPES.size.toLocaleString()} searchable`;
}

function shapeDist(s, d) {
  let best = 9;
  for (let sh = -1; sh <= 1; sh++) {   // tolerate the outline being a bin early or late
    let sum = 0, n = 0;
    for (let i = 0; i < SN; i++) {
      if (d[i] < 0) continue;
      const j = i + sh;
      sum += Math.abs((j < 0 || j >= SN ? 0 : Math.sqrt(s[j])) - d[i]); n++;
    }
    const v = sum / n + (sh ? 0.015 : 0);
    if (v < best) best = v;
  }
  return best;
}
function rankByShape() {
  const scored = [];
  for (const it of VIEW) { const s = SHAPES.get(it.path); if (s) scored.push([shapeDist(s, f.shape), it]); }
  scored.sort((a, b) => a[0] - b[0]);
  scored.length = Math.min(scored.length, 300);
  VIEW = sort.col === 'match' ? scored.map((x) => x[1]) : scored.map((x) => x[1]).sort(compare);
}
// ----- find similar: rank by average spectrum (timbre) + volume outline + length against the selected sample
const SOUNDS = new Map();               // path -> Float32Array(16), log-spaced band levels per WAV
let soundsReady = false;
function simDist(it, bands, shape, r) {
  let b = 0;
  for (let i = 0; i < bands.length; i++) b += Math.abs(bands[i] - r.bands[i]);
  b /= bands.length;
  const d = it.dur && r.dur ? Math.min(1, Math.abs(Math.log(it.dur / r.dur)) / Math.log(8)) : 0.5;
  return 0.5 * b + 0.35 * shapeDist(shape, r.shape) + 0.15 * d;
}
function rankBySimilar() {
  const r = f.sim, scored = [];
  for (const it of VIEW) {
    const b = SOUNDS.get(it.path), s = SHAPES.get(it.path);
    if (b && s) scored.push([simDist(it, b, s, r), it]);
  }
  scored.sort((a, b) => a[0] - b[0]);
  scored.length = Math.min(scored.length, 300);
  VIEW = sort.col === 'match' ? scored.map((x) => x[1]) : scored.map((x) => x[1]).sort(compare);
}
function startSimilar(it) {
  if (!it) { toast('Select a sample first'); return; }
  if (!soundsReady) { toast('Still analysing sounds…'); return; }
  const bands = SOUNDS.get(it.path), shape = SHAPES.get(it.path);
  if (!bands || !shape) { toast('Only WAV samples can be matched'); return; }
  const first = !f.shape && !f.sim;
  if (f.shape) { f.shape = null; sk.fill(-1); drawSketch(); }
  if (first) prevSort = sort;
  f.sim = { path: it.path, name: it.name, bands, shape: Float32Array.from(shape, Math.sqrt), dur: it.dur };
  sort = { col: 'match', dir: 1 };
  refresh();
}
function clearSimilar() {
  f.sim = null;
  if (prevSort) { sort = prevSort; prevSort = null; } else if (sort.col === 'match') sort = pref('sort', { col: 'pack', dir: 1 });
  refresh();
}
async function loadSounds() {
  if (!api.sounds) return;
  soundsReady = false; SOUNDS.clear();
  try {
    const m = await api.sounds();
    for (const [p, v] of Object.entries(m)) SOUNDS.set(p, Float32Array.from(v, (x) => x / 255));
    soundsReady = true;
  } catch {}
  if (f.sim) refresh(true);
}
function applySketch() {
  const set = [...sk].filter((v) => v >= 0);
  if (set.length < 3) { if (f.shape) clearSketch(true); return; }
  const top = Math.max(...set, 0.02);
  const first = !f.shape && !f.sim;
  f.sim = null;
  f.shape = Float32Array.from(sk, (v) => (v < 0 ? -1 : Math.min(1, v / top)));
  if (first) { prevSort = sort; sort = { col: 'match', dir: 1 }; }
  refresh();
}
function clearSketch(keepDrawing) {
  if (!keepDrawing) sk.fill(-1);
  f.shape = null;
  if (prevSort) { sort = prevSort; prevSort = null; } else if (sort.col === 'match') sort = pref('sort', { col: 'pack', dir: 1 });
  drawSketch(); refresh();
}
let skT;
const skSoon = () => { clearTimeout(skT); skT = setTimeout(applySketch, 90); };

(() => {
  let last = -1, erase = false;
  const at = (e) => {
    const r = skCv.getBoundingClientRect();
    const v = (r.bottom - e.clientY) / r.height;
    let p = (v - SK_PAD) / (1 - 2 * SK_PAD);
    p = p < 0.02 ? 0 : p > 0.98 ? 1 : p;
    return [Math.min(SN - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * SN))), Math.min(1, Math.max(0, p))];
  };
  const paint = (e) => {
    const [i, v] = at(e), val = erase ? -1 : v;
    const a = last < 0 ? i : last, lo = Math.min(a, i), hi = Math.max(a, i);
    const from = last < 0 || sk[a] < 0 ? val : sk[a];
    for (let k = lo; k <= hi; k++) {
      const t = i === a ? 1 : (k - a) / (i - a);
      sk[k] = erase ? -1 : from + (val - from) * t;
    }
    last = i; drawSketch(); skSoon();
  };
  skCv.addEventListener('pointerdown', (e) => { erase = e.button === 2; skCv.setPointerCapture(e.pointerId); last = -1; paint(e); });
  skCv.addEventListener('pointermove', (e) => { if (skCv.hasPointerCapture(e.pointerId)) paint(e); });
  skCv.addEventListener('pointerup', () => { last = -1; });
  skCv.addEventListener('contextmenu', (e) => e.preventDefault());
})();
sketchPop.addEventListener('click', (e) => {
  const p = e.target.closest('[data-pre]');
  if (p) { const fn = PRESETS[+p.dataset.pre][1]; for (let i = 0; i < SN; i++) sk[i] = Math.sqrt(Math.min(1, Math.max(0, fn((i + 0.5) / SN)))); drawSketch(); applySketch(); }
  else if (e.target.id === 'skClear') clearSketch();
  else if (e.target.id === 'skSel') {
    const s = cur && SHAPES.get(cur.path);
    if (!s) { toast(cur ? 'No shape data for this sample yet' : 'Select a sample first'); return; }
    sk = Float32Array.from(s, Math.sqrt); drawSketch(); applySketch();
  }
});
$('#btnShape').onclick = () => {
  if (!openPop($('#btnShape'), { width: 520, align: 'left' })) return;
  pop.replaceChildren(sketchPop); skStatus(); drawSketch();
};
async function loadShapes() {
  if (!api.shapes) return;
  SHAPES.clear(); shapeProg = { done: 0, total: 0 };
  try {
    const m = await api.shapes();
    for (const [p, v] of Object.entries(m)) SHAPES.set(p, Float32Array.from(v, (x) => x / 255));
  } catch {}
  shapeProg = null; skStatus();
  if (f.shape) refresh(true);
  loadSounds();
}
if (api.shapes) {
  $('#btnShape').hidden = false;
  if (api.sounds) $('#btnSimilar').hidden = false;
  api.onShapeProgress((p) => { shapeProg = p; if (popFor === $('#btnShape')) skStatus(); });
}

// ----- library menu & volume popovers
$('#btnMenu').onclick = () => {
  if (!openPop($('#btnMenu'), { width: 180 })) return;
  pop.innerHTML = '<button class="menu-item" data-a="folder">Change folder…</button><button class="menu-item" data-a="rescan">Rescan library</button>';
  pop.onclick = async (e) => {
    const a = e.target.closest('[data-a]'); if (!a) return;
    closePop(); stop();
    if (a.dataset.a === 'rescan') load(true);
    else { const p = await api.pickFolder(); if (p) load(true); }
  };
};
let volSlider;
$('#btnVol').onclick = () => {
  if (!openPop($('#btnVol'), { width: 170, above: true })) return;
  const box = document.createElement('div');
  pop.replaceChildren(box); pop.onclick = null;
  volSlider = makeSlider(box, { min: 0, max: 100, values: [Math.round(gain.gain.value * 100)], onInput: ([v]) => { gain.gain.value = v / 100; setPref('vol', gain.gain.value); } });
  volSlider.place();
};

// ---------- virtual list ----------
function renderRows() {
  const list = $('#list');
  const top = list.scrollTop, h = list.clientHeight;
  const start = Math.max(0, Math.floor(top / ROW) - 4);
  const end = Math.min(VIEW.length, Math.ceil((top + h) / ROW) + 4);
  let html = '';
  for (let i = start; i < end; i++) {
    const it = VIEW[i];
    const fav = favs.has(it.path);
    html += `<div class="trow ${it.path === selPath ? 'sel' : ''} ${multi.has(it.path) ? 'msel' : ''}" data-i="${i}" draggable="true" style="top:${i * ROW}px">
      <div class="star ${fav ? 'on' : ''}" data-star><svg viewBox="0 0 24 24"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2 6.3 20.3l1.2-6.4L2.8 9.5l6.4-.8z" stroke-linejoin="round"/></svg></div>
      <div title="${esc(it.rel)}"><div class="nm">${esc(it.name)}${it.loop ? '<span class="lp">LOOP</span>' : ''}</div><div class="sub">${esc(prettyPack(it.pack))} · ${esc(it.type)}</div></div>
      <div class="c-bpm">${it.bpm ? it.bpm + ' bpm' : ''}</div>
      <div class="c-key">${it.key ?? ''}</div>
      <div class="c-len">${fmtDur(it.dur)}</div>
    </div>`;
  }
  $('#rows').innerHTML = html;
  $('#rows').querySelectorAll('.trow.sel, .trow:hover').forEach(marquee);
}

// Names too long for the row slide sideways on hover / while selected so the full text can be read.
function marquee(row) {
  const cell = row.children[1];
  if (!cell || cell._anims) return;
  const items = [...cell.querySelectorAll('.nm, .sub')].map((el) => [el, el.scrollWidth - cell.clientWidth]).filter(([, d]) => d > 1);
  if (!items.length) return;
  const dur = Math.max(...items.map(([, d]) => d)) * 28 + 2400;
  cell.classList.add('scrolling');
  cell._anims = items.map(([el, d]) => el.animate(
    [{ transform: 'translateX(0)' }, { transform: 'translateX(0)', offset: 0.15 }, { transform: `translateX(${-d - 4}px)`, offset: 0.65 }, { transform: `translateX(${-d - 4}px)`, offset: 0.85 }, { transform: 'translateX(0)' }],
    { duration: dur, iterations: Infinity, easing: 'ease-in-out' }));
}
function unmarquee(row) {
  const cell = row.children[1];
  if (!cell || !cell._anims) return;
  cell._anims.forEach((a) => a.cancel());
  cell._anims = null; cell.classList.remove('scrolling');
}
$('#rows').addEventListener('mouseover', (e) => {
  const row = e.target.closest('.trow');
  if (row && !row.contains(e.relatedTarget)) { marquee(row); clearTimeout(prefetchT); prefetchT = setTimeout(() => prefetch(VIEW[+row.dataset.i]), 120); }
});
let prefetchT;
$('#rows').addEventListener('mouseout', (e) => {
  const row = e.target.closest('.trow');
  if (row && !row.contains(e.relatedTarget) && !row.classList.contains('sel')) unmarquee(row);
});
$('#list').addEventListener('scroll', renderRows);
window.addEventListener('resize', () => { renderRows(); drawWave(); closePop(); });
function ensureVisible(i) {
  const list = $('#list'), y = i * ROW;
  if (y < list.scrollTop) list.scrollTop = y;
  else if (y + ROW > list.scrollTop + list.clientHeight) list.scrollTop = y + ROW - list.clientHeight;
}
const selCount = () => { let n = 0; for (const v of VIEW) if (multi.has(v.path)) n++; return n; };
const updateCount = () => {
  const n = selCount();
  $('#count').textContent = `${VIEW.length.toLocaleString()} ${f.shape || f.sim ? 'closest ' : ''}sample${VIEW.length === 1 ? '' : 's'}${n > 1 ? ' · ' + n + ' selected' : ''}`;
};
const rowIndexOf = (path) => VIEW.findIndex((v) => v.path === path);

// ---------- audio engine ----------
const ctx = new AudioContext();
const gain = ctx.createGain();
gain.connect(ctx.destination);
gain.gain.value = pref('vol', 0.85);
let loopOn = pref('loop', false), autoOn = pref('auto', true);
$('#optLoop').classList.toggle('on', loopOn);
$('#optAuto').classList.toggle('on', autoOn);

const bufCache = new Map();
let cur = null, buf = null, src = null, startT = 0, playing = false, paused = 0, loadTok = 0, wavePeaks = null;

const inflight = new Map();
function loadBuf(it) {
  if (bufCache.has(it.path)) { const b = bufCache.get(it.path); bufCache.delete(it.path); bufCache.set(it.path, b); return Promise.resolve(b); }
  let p = inflight.get(it.path);
  if (!p) {
    p = (async () => {
      const u8 = await api.readFile(it.path);
      const b = await ctx.decodeAudioData(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
      bufCache.set(it.path, b);
      if (bufCache.size > 40) bufCache.delete(bufCache.keys().next().value);
      return b;
    })().finally(() => inflight.delete(it.path));
    inflight.set(it.path, p);
  }
  return p;
}
// Warm the cache for samples you are likely to click next (hovered row, neighbours of the selection).
function prefetch(it) {
  if (!it || bufCache.has(it.path) || inflight.has(it.path) || inflight.size >= 2 || it.size > 40e6) return;
  loadBuf(it).catch(() => {});
}
function stopSrc() {
  if (src) { src.onended = null; try { src.stop(); } catch {} src.disconnect(); src = null; }
  playing = false;
}
function play(from = 0) {
  if (!buf) return;
  if (ctx.state === 'suspended') ctx.resume();
  stopSrc(); paused = 0;
  const s = ctx.createBufferSource();
  s.buffer = buf; s.loop = loopOn;
  s.connect(gain);
  s.onended = () => { if (src === s) { src = null; playing = false; updateBtn(); drawWave(); } };
  s.start(0, Math.min(from, buf.duration - 0.001));
  src = s; startT = ctx.currentTime - from; playing = true;
  updateBtn(); tick();
}
function stop() { stopSrc(); paused = 0; updateBtn(); drawWave(); }
function pause() { paused = position(); stopSrc(); updateBtn(); drawWave(); }
const toggle = () => { if (buf) playing ? pause() : play(paused); };
function position() {
  if (!buf) return 0;
  if (!playing) return paused;
  const t = ctx.currentTime - startT;
  return loopOn ? t % buf.duration : Math.min(t, buf.duration);
}
function updateBtn() {
  $('#icoPlay').toggleAttribute('hidden', playing); $('#icoStop').toggleAttribute('hidden', !playing);
  $('#time').textContent = fmtTime(playing || paused ? position() : buf ? buf.duration : 0);
}
function tick() { if (!playing) return; drawWave(); updateBtn(); requestAnimationFrame(tick); }

// ---------- waveform ----------
const cv = $('#cv');
function computePeaks() {
  const w = Math.max(1, Math.floor(cv.clientWidth));
  const n = buf.length, ch = buf.numberOfChannels;
  const peaks = new Float32Array(w * 2);
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  const step = n / w;
  for (let x = 0; x < w; x++) {
    const a = Math.floor(x * step), b = Math.max(a + 1, Math.floor((x + 1) * step));
    const stride = Math.max(1, Math.floor((b - a) / 64));
    let mn = 0, mx = 0;
    for (let i = a; i < b && i < n; i += stride) for (let c = 0; c < ch; c++) { const v = data[c][i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    peaks[x * 2] = mn; peaks[x * 2 + 1] = mx;
  }
  return { peaks, w };
}
function drawWave() {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); wavePeaks = null; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  if (!buf) return;
  if (!wavePeaks || wavePeaks.w !== Math.floor(W)) wavePeaks = computePeaks();
  const { peaks, w } = wavePeaks;
  const prog = position() / buf.duration, mid = H / 2;
  // Smoothed envelope drawn as one filled curve (played part clipped on top in the accent color).
  const R = 2, top = new Float32Array(w), bot = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let a = 0, b = 0, n = 0;
    for (let k = Math.max(0, x - R); k <= Math.min(w - 1, x + R); k++) { a += peaks[k * 2 + 1]; b += peaks[k * 2]; n++; }
    top[x] = Math.min(mid - 0.75, mid - (a / n) * mid * 0.95); bot[x] = Math.max(mid + 0.75, mid - (b / n) * mid * 0.95);
  }
  const shape = () => {
    g.beginPath(); g.moveTo(0, top[0]);
    for (let x = 1; x < w; x++) g.quadraticCurveTo(x - 1, top[x - 1], (x - 1 + x) / 2, (top[x - 1] + top[x]) / 2);
    g.lineTo(w - 1, top[w - 1]); g.lineTo(w - 1, bot[w - 1]);
    for (let x = w - 2; x >= 0; x--) g.quadraticCurveTo(x + 1, bot[x + 1], (x + 1 + x) / 2, (bot[x + 1] + bot[x]) / 2);
    g.closePath(); g.fill();
  };
  g.fillStyle = '#524f66'; shape();
  if (playing || paused) {
    g.save(); g.beginPath(); g.rect(0, 0, prog * w, H); g.clip();
    g.fillStyle = '#806cf5'; shape(); g.restore();
    g.fillStyle = '#fff'; g.fillRect(Math.floor(prog * w), 0, 1.5, H);
  }
}
$('#wave').addEventListener('mousedown', (e) => {
  if (!buf) return;
  const r = $('#wave').getBoundingClientRect();
  play(((e.clientX - r.left) / r.width) * buf.duration);
});

// ---------- selection ----------
async function select(i, opts = {}) {
  const it = VIEW[i];
  if (!it) return;
  selPath = it.path; cur = it;
  ensureVisible(i); renderRows();
  const tok = ++loadTok;
  stopSrc(); paused = 0; buf = null; wavePeaks = null; updateBtn(); drawWave();
  $('#waveMsg').textContent = 'Loading…';
  try {
    const b = await loadBuf(it);
    if (tok !== loadTok) return;
    buf = b; wavePeaks = null; $('#waveMsg').textContent = '';
    drawWave();
    if (opts.play || (opts.play !== false && autoOn)) play(0); else updateBtn();
    setTimeout(() => { if (tok === loadTok) { prefetch(VIEW[i + 1]); prefetch(VIEW[i - 1]); } }, 60);
  } catch {
    if (tok !== loadTok) return;
    $('#waveMsg').textContent = 'Preview not available for this file';
    drawWave();
  }
}
function move(delta) {
  if (!VIEW.length) return;
  let i = rowIndexOf(selPath);
  i = i < 0 ? (delta > 0 ? 0 : VIEW.length - 1) : Math.max(0, Math.min(VIEW.length - 1, i + delta));
  select(i);
}

// ---------- events ----------
$('#rows').addEventListener('click', (e) => {
  const row = e.target.closest('.trow'); if (!row) return;
  const it = VIEW[+row.dataset.i];
  if (e.target.closest('[data-star]')) {
    favs.has(it.path) ? favs.delete(it.path) : favs.add(it.path);
    saveFavs(); if (f.fav) refresh(true); else { renderRows(); renderSide(); }
    return;
  }
  const i = +row.dataset.i;
  if (e.shiftKey) {
    const a = anchor >= 0 && anchor < VIEW.length ? anchor : Math.max(0, rowIndexOf(selPath));
    multi = new Set(VIEW.slice(Math.min(a, i), Math.max(a, i) + 1).map((v) => v.path));
    renderRows(); updateCount(); return;
  }
  if (e.ctrlKey || e.metaKey) {
    if (!multi.size && selPath) multi.add(selPath);
    multi.has(it.path) ? multi.delete(it.path) : multi.add(it.path);
    anchor = i; renderRows(); updateCount(); return;
  }
  if (multi.size) { multi.clear(); updateCount(); }
  anchor = i;
  select(i);
});
$('#rows').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.trow'); if (!row || e.target.closest('[data-star]')) return;
  if (VIEW[+row.dataset.i].path === selPath && buf) play(0);
});
$('#rows').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.trow'); if (!row) return;
  e.preventDefault(); api.copyPath(VIEW[+row.dataset.i].path); toast('Path copied');
});
$('#rows').addEventListener('dragstart', (e) => {
  const row = e.target.closest('.trow'); if (!row) return;
  e.preventDefault();
  const it = VIEW[+row.dataset.i];
  const group = multi.size > 1 && multi.has(it.path) ? VIEW.filter((v) => multi.has(v.path)).map((v) => v.path) : [it.path];
  api.dragStart(group);
});

$('#packs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pack]'); if (!b) return;
  f.pack = f.pack === b.dataset.pack ? null : b.dataset.pack; f.fav = false; refresh();
});
$('#navAll').onclick = () => { f.pack = null; f.fav = false; refresh(); };
$('#navFav').onclick = () => { f.fav = !f.fav; if (f.fav) f.pack = null; refresh(); };

let qT;
$('#q').addEventListener('input', () => {
  $('#qClear').hidden = !$('#q').value;
  clearTimeout(qT);
  qT = setTimeout(() => { f.terms = $('#q').value.toLowerCase().split(/\s+/).filter(Boolean); refresh(); }, 80);
});
$('#qClear').onclick = () => { $('#q').value = ''; f.terms = []; refresh(); $('#q').focus(); };
function clearFilters() {
  Object.assign(f, { terms: [], pack: null, kind: 'all', key: '', bmin: null, bmax: null, fav: false });
  f.types.clear();
  $('#q').value = '';
  bpmSlider.set(bpmBounds);
  refresh();
}

$('#btnPlay').onclick = toggle;
$('#optLoop').onclick = () => { loopOn = !loopOn; setPref('loop', loopOn); $('#optLoop').classList.toggle('on', loopOn); if (src) src.loop = loopOn; };
$('#optAuto').onclick = () => { autoOn = !autoOn; setPref('auto', autoOn); $('#optAuto').classList.toggle('on', autoOn); };
let pinOn = pref('pin', false);
const applyPin = () => { $('#btnPin').classList.toggle('on', pinOn); api.pinWin && api.pinWin(pinOn); };
$('#btnPin').onclick = () => { pinOn = !pinOn; setPref('pin', pinOn); applyPin(); toast(pinOn ? 'Kept on top' : 'Not on top'); };
applyPin();
$('#btnClose').onclick = () => api.closeWin();
$('#btnMin').onclick = () => api.minWin();
$('#btnSimilar').onclick = () => startSimilar(cur);
$('#btnReveal').onclick = () => { if (cur) api.reveal(cur.path); };

document.addEventListener('keydown', (e) => {
  const inField = e.target.matches('#q');
  if (e.key === 'Escape') {
    if (popFor) closePop();
    else if (multi.size) { multi.clear(); renderRows(); updateCount(); }
    else if (inField && $('#q').value) $('#qClear').click();
    else document.activeElement.blur();
  }
  else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (e.key === 'PageDown') { e.preventDefault(); move(10); }
  else if (e.key === 'PageUp') { e.preventDefault(); move(-10); }
  else if ((e.key === '/' && !inField) || (e.ctrlKey && e.key.toLowerCase() === 'f')) { e.preventDefault(); $('#q').focus(); $('#q').select(); }
  else if (e.key === 'Enter' && inField) { $('#q').blur(); if (selPath == null && VIEW.length) select(0); }
  else if (e.key === ' ' && !inField) { e.preventDefault(); toggle(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'a' && !inField) { e.preventDefault(); multi = new Set(VIEW.map((v) => v.path)); renderRows(); updateCount(); }
  else if (e.key.toLowerCase() === 's' && !inField && !e.ctrlKey && cur) startSimilar(cur);
  else if (e.key.toLowerCase() === 'f' && !inField && !e.ctrlKey && cur) {
    favs.has(cur.path) ? favs.delete(cur.path) : favs.add(cur.path);
    saveFavs(); renderRows(); renderSide();
  }
});

// ---------- loading ----------
async function load(force) {
  $('#loading').classList.remove('hide');
  $('#loadBar').style.width = '0';
  $('#loadMsg').textContent = 'Scanning packs…';
  const root = await api.getRoot();
  const items = await api.scan(force);
  for (const it of items) it.hay = (it.name + ' ' + it.rel + ' ' + it.type + ' ' + (it.key || '') + ' ' + (it.bpm ? it.bpm + 'bpm' : '') + (it.loop ? ' loop' : ' oneshot one-shot')).toLowerCase();
  for (const it of items) it.words = it.hay.split(/[^a-z0-9#]+/).filter(Boolean);
  ALL = items;
  const bpms = items.map((i) => i.bpm).filter(Boolean);
  bpmBounds = bpms.length ? [Math.min(...bpms), Math.max(...bpms)] : [60, 200];
  filterPop.querySelector('#fpBpm').remove();
  const holder = document.createElement('div'); holder.id = 'fpBpm';
  filterPop.querySelector('#fpBpmLbl').closest('.pop-sec').appendChild(holder);
  rebuildBpm();
  sort = pref('sort', sort);
  clearFilters();
  $('#loading').classList.add('hide');
  loadShapes();
  if (!items.length) $('#empty').textContent = 'No audio files found in ' + root;
}
function rebuildBpm() {
  const holder = filterPop.querySelector('#fpBpm');
  holder.innerHTML = '';
  Object.assign(bpmSlider, makeSlider(holder, {
    min: bpmBounds[0], max: Math.max(bpmBounds[1], bpmBounds[0] + 1), values: [...bpmBounds],
    onInput: ([lo, hi]) => {
      f.bmin = lo <= bpmBounds[0] ? null : lo;
      f.bmax = hi >= bpmBounds[1] ? null : hi;
      bpmLabel(); refresh(true);
    },
  }));
}
api.onProgress(({ done, total }) => {
  $('#loadMsg').textContent = `Scanning packs… ${done.toLocaleString()} / ${total.toLocaleString()}`;
  $('#loadBar').style.width = (total ? (done / total) * 100 : 0) + '%';
});

load(false);

// Fade the list edges into the background, but only where there is more to scroll to.
(() => {
  const list = $('#list');
  const fade = () => {
    list.style.setProperty('--ft', list.scrollTop > 2 ? '28px' : '0px');
    list.style.setProperty('--fb', list.scrollHeight - list.scrollTop - list.clientHeight > 2 ? '28px' : '0px');
  };
  list.addEventListener('scroll', fade, { passive: true });
  new MutationObserver(fade).observe($('#rows'), { childList: true, attributes: true });
  new ResizeObserver(fade).observe(list);
  fade();
})();

// ---------- update check ----------
(async () => {
  if (!api.appVersion || !api.installUpdate) return;
  try {
    const cur = (await api.appVersion()).split('.').map(Number);
    const r = await fetch('https://api.github.com/repos/kalakaritzu/packs-viewer/releases/latest', { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return;
    const rel = await r.json();
    const v = String(rel.tag_name || '').replace(/^v/, '').split('.').map(Number);
    const gt = (a, b) => { for (let i = 0; i < 3; i++) { const x = a[i] || 0, y = b[i] || 0; if (x !== y) return x > y; } return false; };
    const newer = gt(v, cur);
    const asset = (rel.assets || []).find((a) => /setup.*\.exe$/i.test(a.name));
    if (!newer || !asset) return;
    const b = $('#btnUpdate');
    b.textContent = 'Update to v' + v.join('.'); b.title = 'Download and install the new version (the app restarts)'; b.hidden = false;
    b.onclick = async () => {
      b.disabled = true; b.textContent = 'Downloading…';
      try { await api.installUpdate(asset.browser_download_url); b.textContent = 'Installing…'; }
      catch { b.disabled = false; b.textContent = 'Update failed, retry'; }
    };
  } catch {}
})();
