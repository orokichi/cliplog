/* ClipLog — app.js
 * Vanilla ES module. No build step. Data lives in IndexedDB on the user's browser.
 */

// ---------- constants ----------
const BACKGROUNDS = [
  { id: 'aurora',   stops: ['#7cc4ff', '#b18cff'] },
  { id: 'mesh',     mesh: true },
  { id: 'sunset',   stops: ['#ff9a8b', '#ff6a88', '#ff99ac'] },
  { id: 'mint',     stops: ['#43e97b', '#38f9d7'] },
  { id: 'lilac',    stops: ['#e0c3fc', '#8ec5fc'] },
  { id: 'peach',    stops: ['#ffecd2', '#fcb69f'] },
  { id: 'candy',    stops: ['#f6d365', '#fda085'] },
  { id: 'ocean',    stops: ['#2b5876', '#4e4376'] },
  { id: 'night',    stops: ['#0f2027', '#203a43', '#2c5364'] },
  { id: 'graphite', stops: ['#232526', '#414345'] },
  { id: 'paper',    solid: '#f3f3f5' },
  { id: 'ink',      solid: '#111216' },
];

const DEFAULTS = {
  frame: 'mac', bg: 'aurora', bgCustom: null, transparent: false,
  ratio: 'auto', padding: 72, radius: 14, shadow: 45, tilt: 0, scale: 100,
  showCaption: true, showDate: true, grain: false, darkFrame: false,
  windowTitle: '', exportScale: 2,
};

const MAX_LOGICAL = 1400; // logical width cap for the screenshot
const MAX_CANVAS = 8000;

// ---------- tiny helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmtDate = (t) => {
  const d = new Date(t), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}  ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const parseTags = (s) => [...new Set((s || '').split(/[\s,、]+/).map(t => t.replace(/^#/, '').trim()).filter(Boolean))].slice(0, 12);
const tagsToStr = (a) => (a || []).map(t => '#' + t).join(' ');

function toast(msg, icon = '✓') {
  const el = document.createElement('div');
  el.className = 'toast glass';
  el.innerHTML = `<span>${icon}</span><span></span>`;
  el.lastChild.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 2200);
}

// ---------- IndexedDB ----------
const DB = (() => {
  let dbp;
  const open = () => dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('cliplog', 2);
    r.onupgradeneeded = (e) => {
      const db = r.result;
      if (!db.objectStoreNames.contains('logs')) db.createObjectStore('logs', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    put: (v) => tx('logs', 'readwrite', s => s.put(v)),
    del: (id) => tx('logs', 'readwrite', s => s.delete(id)),
    all: () => tx('logs', 'readonly', s => s.getAll()),
    get: (id) => tx('logs', 'readonly', s => s.get(id)),
    kvGet: (k) => tx('kv', 'readonly', s => s.get(k)),
    kvSet: (k, v) => tx('kv', 'readwrite', s => s.put(v, k)),
    kvDel: (k) => tx('kv', 'readwrite', s => s.delete(k)),
  };
})();

// ---------- state ----------
const state = {
  tray: [],          // {id,name,blob,img,url,settings,title,tags,savedId}
  activeId: null,
  logs: [],
  filterTag: null,
};
let lastSettings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('cliplog:settings') || '{}') };
const active = () => state.tray.find(t => t.id === state.activeId);

// ---------- image loading (incl. HEIC) ----------
const ACCEPT = /^image\/(png|jpe?g|webp|gif|heic|heif)$/i;
const isHeic = (f) => /heic|heif/i.test(f.type) || /\.(heic|heif)$/i.test(f.name || '');

let heicLib;
function loadHeicLib() {
  return heicLib ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
    s.onload = () => res(window.heic2any);
    s.onerror = () => rej(new Error('HEIC変換ライブラリを読み込めませんでした'));
    document.head.appendChild(s);
  });
}

function blobToImage(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => res({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
    img.src = url;
  });
}

async function fileToImage(file) {
  try {
    return { ...(await blobToImage(file)), blob: file };
  } catch (e) {
    if (!isHeic(file)) throw e;
    const heic2any = await loadHeicLib();
    let out = await heic2any({ blob: file, toType: 'image/png' });
    if (Array.isArray(out)) out = out[0];
    return { ...(await blobToImage(out)), blob: out };
  }
}

async function importFiles(files, source = '') {
  const list = [...files].filter(f => ACCEPT.test(f.type) || isHeic(f));
  if (!list.length) { toast('対応していない形式です（PNG/JPEG/WebP/GIF/HEIC）', '!'); return; }
  let added = 0, firstId = null;
  for (const f of list) {
    try {
      if (isHeic(f)) toast('HEICを変換しています…', '⟳');
      const { img, url, blob } = await fileToImage(f);
      const item = {
        id: uid(), name: f.name || `clip-${Date.now()}.png`, blob, img, url,
        settings: { ...lastSettings },
        title: (f.name || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 80) || '',
        tags: [], savedId: null,
      };
      state.tray.push(item);
      firstId ||= item.id;
      added++;
    } catch (e) {
      console.error(e);
      toast(`${f.name || '画像'} を読み込めませんでした`, '!');
    }
  }
  if (added) {
    renderTray();
    selectItem(firstId);
    toast(`${added}枚を${source}取り込みました`);
  }
}

// ---------- rendering ----------
function bgLuminance(s) {
  const hex = s.transparent ? '#ffffff' : s.bgCustom || (BACKGROUNDS.find(b => b.id === s.bg)?.solid) ||
    (BACKGROUNDS.find(b => b.id === s.bg)?.stops?.[0]) || '#7cc4ff';
  if (s.bg === 'mesh' && !s.bgCustom) return 0.35;
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function paintBackground(ctx, W, H, s) {
  if (s.transparent) return;
  if (s.bgCustom) { ctx.fillStyle = s.bgCustom; ctx.fillRect(0, 0, W, H); return; }
  const bg = BACKGROUNDS.find(b => b.id === s.bg) || BACKGROUNDS[0];
  if (bg.solid) { ctx.fillStyle = bg.solid; ctx.fillRect(0, 0, W, H); return; }
  if (bg.mesh) {
    ctx.fillStyle = '#1a1f3a'; ctx.fillRect(0, 0, W, H);
    const blobs = [[.15, .2, '#3d7bff'], [.85, .15, '#a35cff'], [.75, .9, '#ff6fb1'], [.2, .85, '#19d3c5'], [.5, .5, '#7cc4ff']];
    const R = Math.max(W, H) * .6;
    for (const [x, y, c] of blobs) {
      const g = ctx.createRadialGradient(x * W, y * H, 0, x * W, y * H, R);
      g.addColorStop(0, c + 'cc'); g.addColorStop(1, c + '00');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    return;
  }
  const g = ctx.createLinearGradient(0, 0, W, H);
  bg.stops.forEach((c, i) => g.addColorStop(i / (bg.stops.length - 1), c));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}

function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : (ctx.moveTo(x + r, y), ctx.arcTo(x + w, y, x + w, y + h, r), ctx.arcTo(x + w, y + h, x, y + h, r), ctx.arcTo(x, y + h, x, y, r), ctx.arcTo(x, y, x + w, y, r));
  ctx.closePath();
}

function grain(ctx, W, H, k) {
  const size = 160, c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d'), d = g.createImageData(size, size);
  for (let i = 0; i < d.data.length; i += 4) {
    const v = Math.random() * 255;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 22;
  }
  g.putImageData(d, 0, 0);
  ctx.save(); ctx.globalCompositeOperation = 'overlay';
  ctx.fillStyle = ctx.createPattern(c, 'repeat'); ctx.fillRect(0, 0, W, H); ctx.restore();
}

/** Compute layout in logical px, then draw at `mult`. */
function render(item, mult = 1, canvas = document.createElement('canvas')) {
  const s = item.settings, img = item.img;
  const iw0 = img.naturalWidth, ih0 = img.naturalHeight;
  const lw = Math.min(iw0, MAX_LOGICAL), lh = ih0 * (lw / iw0);
  const k = Math.max(lw, lh * .8) / 1000; // chrome unit
  const dark = s.darkFrame;

  // frame geometry
  let top = 0, side = 0, bottom = 0, rad = s.radius * k * 1.6;
  const f = s.frame;
  if (f === 'mac') top = 38 * k;
  if (f === 'browser') top = 54 * k;
  if (f === 'phone') { side = 22 * k; top = bottom = 22 * k; rad = Math.max(rad, 46 * k); }
  if (f === 'polaroid') { side = top = 26 * k; bottom = (s.showCaption && item.title ? 110 : 80) * k; rad = Math.min(rad, 6 * k); }
  if (f === 'glass') { side = top = bottom = 20 * k; rad = Math.max(rad, 22 * k); }
  const FW = lw + side * 2, FH = lh + top + bottom;

  const captionH = s.showCaption && item.title && f !== 'polaroid' ? 76 * k : 0;
  const pad = s.padding * k * 1.4;
  let CW = FW + pad * 2, CH = FH + captionH + pad * 2;
  if (s.ratio !== 'auto') {
    const [a, b] = s.ratio.split(':').map(Number), r = a / b;
    if (CW / CH > r) CH = CW / r; else CW = CH * r;
  }
  const dateH = s.showDate && f !== 'polaroid' ? 34 * k : 0;
  if (dateH && s.ratio === 'auto' && pad < dateH * 1.6) CH += dateH;

  let m = mult;
  if (Math.max(CW, CH) * m > MAX_CANVAS) m = MAX_CANVAS / Math.max(CW, CH);
  canvas.width = Math.round(CW * m); canvas.height = Math.round(CH * m);
  const ctx = canvas.getContext('2d');
  ctx.scale(m, m);
  ctx.imageSmoothingQuality = 'high';

  paintBackground(ctx, CW, CH, s);
  const lum = bgLuminance(s);
  const ink = lum > .6 ? 'rgba(15,18,28,.86)' : 'rgba(255,255,255,.92)';
  const inkDim = lum > .6 ? 'rgba(15,18,28,.5)' : 'rgba(255,255,255,.62)';

  // block (frame + caption) centered
  const sc = s.scale / 100;
  const blockH = FH + captionH;
  const cx = CW / 2, cy = (CH - (dateH && s.ratio === 'auto' && pad < dateH * 1.6 ? dateH : 0)) / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(s.tilt * Math.PI / 180);
  ctx.scale(sc, sc);
  const fx = -FW / 2, fy = -blockH / 2;

  // shadow
  const sh = s.shadow / 100;
  if (sh > 0) {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${.18 + sh * .4})`;
    ctx.shadowBlur = 90 * k * sh;
    ctx.shadowOffsetY = 36 * k * sh;
    rr(ctx, fx, fy, FW, FH, rad);
    ctx.fillStyle = '#000'; ctx.fill();
    ctx.restore();
  }

  // frame body
  ctx.save();
  rr(ctx, fx, fy, FW, FH, rad);
  ctx.clip();
  if (f === 'glass') {
    // frosted: blurred copy of the screenshot behind
    ctx.filter = `blur(${24 * k}px) saturate(160%)`;
    ctx.drawImage(img, fx - 40 * k, fy - 40 * k, FW + 80 * k, FH + 80 * k);
    ctx.filter = 'none';
    ctx.fillStyle = dark ? 'rgba(10,12,20,.35)' : 'rgba(255,255,255,.28)';
    ctx.fillRect(fx, fy, FW, FH);
  } else if (f === 'phone') {
    ctx.fillStyle = dark ? '#0d0e12' : '#1c1d22'; ctx.fillRect(fx, fy, FW, FH);
  } else if (f === 'polaroid') {
    ctx.fillStyle = dark ? '#1b1c20' : '#fbfaf7'; ctx.fillRect(fx, fy, FW, FH);
  } else if (f === 'mac' || f === 'browser') {
    ctx.fillStyle = dark ? '#1e1f24' : '#f2f2f5'; ctx.fillRect(fx, fy, FW, FH);
  }

  // screenshot
  const ix = fx + side, iy = fy + top;
  if (f === 'phone' || f === 'glass') {
    ctx.save(); rr(ctx, ix, iy, lw, lh, Math.max(rad - side, 4 * k)); ctx.clip();
    ctx.drawImage(img, ix, iy, lw, lh); ctx.restore();
  } else if (f === 'polaroid') {
    ctx.drawImage(img, ix, iy, lw, lh);
    ctx.strokeStyle = 'rgba(0,0,0,.08)'; ctx.lineWidth = k; ctx.strokeRect(ix, iy, lw, lh);
  } else {
    ctx.drawImage(img, ix, iy, lw, lh);
  }

  // chrome details
  const fontUI = (px, w = 500) => `${w} ${px}px Inter, "Noto Sans JP", system-ui, sans-serif`;
  if (f === 'mac' || f === 'browser') {
    const cyb = fy + (f === 'mac' ? 19 : 27) * k;
    ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
      ctx.beginPath(); ctx.arc(fx + (22 + i * 20) * k, cyb, 6.2 * k, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill();
    });
    ctx.fillStyle = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.08)';
    ctx.fillRect(fx, fy + top - k, FW, k);
    if (f === 'mac' && s.windowTitle) {
      ctx.font = fontUI(13 * k, 600); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = dark ? 'rgba(255,255,255,.7)' : 'rgba(0,0,0,.6)';
      ctx.fillText(s.windowTitle, fx + FW / 2, cyb);
    }
    if (f === 'browser') {
      const uw = Math.min(FW * .55, 560 * k), ux = fx + FW / 2 - uw / 2;
      rr(ctx, ux, cyb - 14 * k, uw, 28 * k, 9 * k);
      ctx.fillStyle = dark ? 'rgba(255,255,255,.08)' : '#ffffff'; ctx.fill();
      ctx.font = fontUI(12.5 * k); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = dark ? 'rgba(255,255,255,.65)' : 'rgba(0,0,0,.55)';
      ctx.fillText('🔒 ' + (s.windowTitle || 'cliplog.app'), ux + uw / 2, cyb + .5 * k);
    }
  }
  if (f === 'phone') {
    const nw = 110 * k, nh = 30 * k;
    rr(ctx, fx + FW / 2 - nw / 2, iy + 12 * k, nw, nh, nh / 2);
    ctx.fillStyle = '#000'; ctx.fill();
  }
  if (f === 'polaroid') {
    ctx.textBaseline = 'middle';
    const by = fy + top + lh + bottom / 2;
    if (s.showCaption && item.title) {
      ctx.font = `500 ${30 * k}px "Noto Sans JP", Inter, sans-serif`; ctx.textAlign = 'left';
      ctx.fillStyle = dark ? 'rgba(255,255,255,.85)' : 'rgba(20,20,24,.82)';
      ctx.fillText(item.title, ix + 4 * k, by - (s.showDate ? 10 * k : 0), lw * .9);
    }
    if (s.showDate) {
      ctx.font = `500 ${15 * k}px "JetBrains Mono", monospace`; ctx.textAlign = 'right';
      ctx.fillStyle = '#e8784a';
      ctx.fillText(fmtDate(item.createdAt || Date.now()), ix + lw - 4 * k, by + (s.showCaption && item.title ? 22 * k : 0));
    }
  }
  ctx.restore(); // clip

  // glass specular rim
  if (f === 'glass' || f === 'phone') {
    rr(ctx, fx + .75 * k, fy + .75 * k, FW - 1.5 * k, FH - 1.5 * k, rad);
    const g = ctx.createLinearGradient(fx, fy, fx + FW, fy + FH);
    g.addColorStop(0, 'rgba(255,255,255,.75)'); g.addColorStop(.35, 'rgba(255,255,255,.08)');
    g.addColorStop(.7, 'rgba(255,255,255,.04)'); g.addColorStop(1, 'rgba(255,255,255,.4)');
    ctx.strokeStyle = g; ctx.lineWidth = 1.5 * k; ctx.stroke();
  } else if (f !== 'none') {
    rr(ctx, fx, fy, FW, FH, rad);
    ctx.strokeStyle = dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.08)'; ctx.lineWidth = k; ctx.stroke();
  }

  // caption under the frame
  if (captionH) {
    ctx.font = `600 ${30 * k}px Inter, "Noto Sans JP", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = ink;
    ctx.fillText(item.title, 0, fy + FH + captionH * .62, FW);
    if (item.tags?.length) {
      ctx.font = `500 ${15 * k}px "JetBrains Mono", monospace`; ctx.fillStyle = inkDim;
      ctx.fillText(tagsToStr(item.tags), 0, fy + FH + captionH * .62 + 30 * k, FW);
    }
  }
  ctx.restore(); // transform

  // date stamp
  if (s.showDate && f !== 'polaroid') {
    ctx.font = `500 ${15 * k}px "JetBrains Mono", monospace`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = inkDim;
    ctx.fillText('ClipLog · ' + fmtDate(item.createdAt || Date.now()), CW - 24 * k, CH - 20 * k);
  }
  if (s.grain && !s.transparent) grain(ctx, CW, CH, k);
  return canvas;
}

// ---------- editor UI ----------
const canvasEl = $('#canvas');
let raf = 0;
function draw() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    const it = active();
    const has = !!it;
    $('#dropHint').classList.toggle('hidden', has);
    canvasEl.classList.toggle('hidden', !has);
    ['#saveBtn', '#copyBtn', '#downloadBtn'].forEach(s => $(s).disabled = !has);
    if (!has) return;
    it.createdAt ||= Date.now();
    render(it, Math.min(window.devicePixelRatio || 1, 2), canvasEl);
    // fit in stage (CSS size)
    const st = $('#stage').getBoundingClientRect();
    const maxW = st.width - 48, maxH = st.height - 48;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = Math.min(maxW / canvasEl.width, maxH / canvasEl.height, 1 / dpr);
    const cssW = canvasEl.width * r, cssH = canvasEl.height * r;
    canvasEl.style.width = cssW + 'px'; canvasEl.style.height = cssH + 'px';
  });
}

function renderTray() {
  const list = $('#trayList');
  list.innerHTML = '';
  for (const it of state.tray) {
    const el = document.createElement('div');
    el.className = 'tray-item' + (it.id === state.activeId ? ' active' : '');
    el.innerHTML = `<img alt="" /><button class="x" title="外す">✕</button>${it.savedId ? '<span class="saved">保存済</span>' : ''}`;
    el.firstChild.src = it.url;
    el.onclick = () => selectItem(it.id);
    el.querySelector('.x').onclick = (e) => { e.stopPropagation(); removeTrayItem(it.id); };
    list.appendChild(el);
  }
  $('#trayCount').textContent = `${state.tray.length} 枚`;
  $('#trayEmpty').classList.toggle('hidden', state.tray.length > 0);
}

function removeTrayItem(id) {
  const i = state.tray.findIndex(t => t.id === id);
  if (i < 0) return;
  URL.revokeObjectURL(state.tray[i].url);
  state.tray.splice(i, 1);
  if (state.activeId === id) state.activeId = state.tray[Math.max(0, i - 1)]?.id || null;
  renderTray(); syncControls(); draw();
}

function selectItem(id) {
  state.activeId = id;
  renderTray(); syncControls(); draw();
}

// controls <-> settings
const sliderIds = ['padding', 'radius', 'shadow', 'tilt', 'scale'];
const units = { padding: 'px', radius: 'px', shadow: '%', tilt: '°', scale: '%' };
const toggleMap = { showCaption: 'showCaption', showDate: 'showDate', showGrain: 'grain', darkFrame: 'darkFrame', bgTransparent: 'transparent' };

function settingsTarget() { return active()?.settings || lastSettings; }

function syncControls() {
  const s = settingsTarget(), it = active();
  $$('#frameChips button').forEach(b => b.classList.toggle('on', b.dataset.frame === s.frame));
  $$('#ratioChips button').forEach(b => b.classList.toggle('on', b.dataset.ratio === s.ratio));
  $$('#exportChips button').forEach(b => b.classList.toggle('on', +b.dataset.scale === s.exportScale));
  $$('.swatch').forEach(b => b.classList.toggle('on', !s.bgCustom && b.dataset.bg === s.bg));
  for (const id of sliderIds) { const el = $('#' + id); el.value = s[id]; paintRange(el); }
  for (const [el, key] of Object.entries(toggleMap)) $('#' + el).checked = !!s[key];
  $('#windowTitle').value = s.windowTitle || '';
  if (s.bgCustom) $('#bgCustom').value = s.bgCustom;
  $('#logTitle').value = it?.title || '';
  $('#logTags').value = tagsToStr(it?.tags);
}

function paintRange(el) {
  const p = (el.value - el.min) / (el.max - el.min) * 100;
  el.style.setProperty('--fill', p + '%');
  const v = $('#v-' + el.id); if (v) v.textContent = el.value + units[el.id];
}

function update(patch) {
  const s = settingsTarget();
  Object.assign(s, patch);
  lastSettings = { ...lastSettings, ...patch };
  localStorage.setItem('cliplog:settings', JSON.stringify(lastSettings));
  syncControls(); draw();
}

function buildSwatches() {
  const host = $('#bgSwatches');
  for (const b of BACKGROUNDS) {
    const el = document.createElement('button');
    el.className = 'swatch'; el.dataset.bg = b.id; el.title = b.id;
    el.style.background = b.solid || (b.mesh
      ? 'radial-gradient(circle at 20% 20%,#3d7bff,transparent 60%),radial-gradient(circle at 80% 20%,#a35cff,transparent 60%),radial-gradient(circle at 70% 90%,#ff6fb1,transparent 60%),#1a1f3a'
      : `linear-gradient(135deg,${b.stops.join(',')})`);
    el.onclick = () => update({ bg: b.id, bgCustom: null, transparent: false });
    host.appendChild(el);
  }
}

function bindControls() {
  $$('#frameChips button').forEach(b => b.onclick = () => update({ frame: b.dataset.frame }));
  $$('#ratioChips button').forEach(b => b.onclick = () => update({ ratio: b.dataset.ratio }));
  $$('#exportChips button').forEach(b => b.onclick = () => update({ exportScale: +b.dataset.scale }));
  for (const id of sliderIds) $('#' + id).addEventListener('input', e => update({ [id]: +e.target.value }));
  for (const [el, key] of Object.entries(toggleMap)) $('#' + el).addEventListener('change', e => update({ [key]: e.target.checked }));
  $('#bgCustom').addEventListener('input', e => update({ bgCustom: e.target.value, transparent: false }));
  $('#windowTitle').addEventListener('input', e => update({ windowTitle: e.target.value }));
  $('#resetStyle').onclick = () => { update({ ...DEFAULTS }); toast('スタイルをリセットしました'); };
  $('#logTitle').addEventListener('input', e => { const it = active(); if (it) { it.title = e.target.value; draw(); } });
  $('#logTags').addEventListener('input', e => { const it = active(); if (it) { it.tags = parseTags(e.target.value); draw(); } });
}

// ---------- export / save ----------
const canvasToBlob = (c, type = 'image/png', q) => new Promise(r => c.toBlob(r, type, q));
const safeName = (s) => (s || 'cliplog').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 60) || 'cliplog';

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function copyBlob(blob) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('クリップボードにコピーしました');
  } catch { toast('このブラウザではコピーできません', '!'); }
}

async function exportActive() {
  const it = active(); if (!it) return null;
  return canvasToBlob(render(it, it.settings.exportScale));
}

async function makeThumb(canvas) {
  const t = document.createElement('canvas'), w = 640, r = w / canvas.width;
  t.width = w; t.height = Math.round(canvas.height * r);
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/webp', .82);
}

async function saveItem(it, quiet = false) {
  it.createdAt ||= Date.now();
  const c = render(it, it.settings.exportScale);
  const record = {
    id: it.savedId || uid(),
    title: it.title?.trim() || '無題のログ',
    tags: it.tags || [],
    createdAt: it.createdAt,
    updatedAt: Date.now(),
    settings: { ...it.settings },
    src: it.blob,
    render: await canvasToBlob(c),
    thumb: await makeThumb(c),
    w: c.width, h: c.height,
  };
  const prev = it.savedId ? await DB.get(it.savedId) : null;
  if (prev?.filePath) record.filePath = prev.filePath;
  let wrote = false;
  if (Folder.autoReady()) {
    try { record.filePath = await Folder.writeLog(record); wrote = true; } catch (e) { console.warn(e); }
  }
  await DB.put(record);
  it.savedId = record.id;
  if (!quiet) toast(wrote ? `保存してフォルダに書き出しました` : 'ログに保存しました');
  await loadLogs();
  renderTray();
}

// ---------- library ----------
async function loadLogs() {
  state.logs = await DB.all();
  $('#libCount').textContent = state.logs.length;
  renderLibrary();
}

function renderLibrary() {
  const q = $('#search').value.trim().toLowerCase();
  const sort = $('#sort').value;
  let logs = state.logs.filter(l =>
    (!q || l.title.toLowerCase().includes(q) || l.tags.some(t => t.toLowerCase().includes(q.replace(/^#/, '')))) &&
    (!state.filterTag || l.tags.includes(state.filterTag)));
  logs.sort((a, b) => sort === 'old' ? a.createdAt - b.createdAt : sort === 'title' ? a.title.localeCompare(b.title, 'ja') : b.createdAt - a.createdAt);

  // tags
  const counts = {};
  state.logs.forEach(l => l.tags.forEach(t => counts[t] = (counts[t] || 0) + 1));
  const tb = $('#tagBar'); tb.innerHTML = '';
  Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 24).forEach(([t, n]) => {
    const el = document.createElement('button');
    el.className = 'tag' + (state.filterTag === t ? ' on' : '');
    el.textContent = `#${t} ${n}`;
    el.onclick = () => { state.filterTag = state.filterTag === t ? null : t; renderLibrary(); };
    tb.appendChild(el);
  });

  const grid = $('#libGrid'); grid.innerHTML = '';
  logs.forEach((l, i) => {
    const el = document.createElement('article');
    el.className = 'card glass';
    el.style.animationDelay = Math.min(i * 40, 400) + 'ms';
    el.innerHTML = `<div class="thumb"><img alt="" loading="lazy" /></div>
      <div class="meta"><h3></h3><div class="sub"><span class="tags"></span><span>${fmtDate(l.createdAt).split('  ')[0]}</span></div></div>`;
    el.querySelector('img').src = l.thumb;
    el.querySelector('h3').textContent = l.title;
    el.querySelector('.tags').textContent = tagsToStr(l.tags) || '—';
    el.onclick = () => openModal(l.id);
    grid.appendChild(el);
  });
  $('#libEmpty').style.display = state.logs.length ? 'none' : '';
  $('#libSummary').textContent = state.logs.length
    ? `${state.logs.length}件のログ${logs.length !== state.logs.length ? `（${logs.length}件を表示）` : ''} · このブラウザ内に保存`
    : '保存したログはこのブラウザに保存されます。';
}

let modalId = null, modalUrl = null;
async function openModal(id) {
  const l = await DB.get(id); if (!l) return;
  modalId = id;
  if (modalUrl) URL.revokeObjectURL(modalUrl);
  modalUrl = URL.createObjectURL(l.render);
  $('#modalImg').src = modalUrl;
  $('#modalTitle').value = l.title;
  $('#modalTags').value = tagsToStr(l.tags);
  $('#modalDate').textContent = `${fmtDate(l.createdAt)} · ${l.w}×${l.h}px`;
  $('#modal').classList.add('open');
  $('#modal').setAttribute('aria-hidden', 'false');
}
function closeModal() {
  $('#modal').classList.remove('open');
  $('#modal').setAttribute('aria-hidden', 'true');
  modalId = null;
}
async function commitModalMeta() {
  if (!modalId) return;
  const l = await DB.get(modalId); if (!l) return;
  l.title = $('#modalTitle').value.trim() || '無題のログ';
  l.tags = parseTags($('#modalTags').value);
  await DB.put(l); await loadLogs();
}

function bindLibrary() {
  $('#search').addEventListener('input', renderLibrary);
  $('#sort').addEventListener('change', renderLibrary);
  $('#modalClose').onclick = closeModal;
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  $('#modalTitle').addEventListener('change', commitModalMeta);
  $('#modalTags').addEventListener('change', commitModalMeta);
  $('#modalDelete').onclick = async () => {
    if (!modalId || !confirm('このログを削除しますか？')) return;
    const id = modalId;
    const rec = await DB.get(id);
    if (rec?.filePath && Folder.ready() && confirm('フォルダ内の画像ファイルも削除しますか？')) {
      try { await Folder.remove(rec.filePath); } catch (e) { console.warn(e); }
    }
    await DB.del(id);
    state.tray.forEach(t => { if (t.savedId === id) t.savedId = null; });
    closeModal(); await loadLogs(); renderTray(); toast('削除しました');
  };
  $('#modalDownload').onclick = async () => { const l = await DB.get(modalId); downloadBlob(l.render, safeName(l.title) + '.png'); };
  $('#modalCopy').onclick = async () => { const l = await DB.get(modalId); copyBlob(l.render); };
  $('#modalEdit').onclick = async () => {
    const l = await DB.get(modalId); if (!l) return;
    let it = state.tray.find(t => t.savedId === l.id);
    if (!it) {
      const { img, url } = await blobToImage(l.src);
      it = { id: uid(), name: l.title, blob: l.src, img, url, settings: { ...DEFAULTS, ...l.settings }, title: l.title, tags: l.tags, savedId: l.id, createdAt: l.createdAt };
      state.tray.push(it);
    }
    closeModal(); switchView('editor'); selectItem(it.id);
  };
}

// ---------- views ----------
function switchView(v) {
  $$('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + v));
  $$('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  movePill();
  if (v === 'editor') draw(); else renderLibrary();
  history.replaceState(null, '', v === 'library' ? '#library' : '#editor');
}
function movePill() {
  const a = $('.seg-btn.active'), pill = $('.seg-pill');
  if (!a) return;
  pill.style.width = a.offsetWidth + 'px';
  pill.style.transform = `translateX(${a.offsetLeft - 4}px)`;
}

// ---------- input: D&D / paste / picker ----------
function bindInputs() {
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return; e.preventDefault(); depth++;
    if ($('#view-library').classList.contains('active')) switchView('editor');
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return; e.preventDefault(); depth = 0;
    document.body.classList.remove('dragging');
    importFiles(e.dataTransfer.files, 'ドロップで');
  });
  document.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => {
      const f = i.getAsFile();
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      return new File([f], f.name && f.name !== 'image.png' ? f.name : `paste-${Date.now()}.${ext}`, { type: f.type });
    });
    if (!files.length) return;
    e.preventDefault();
    if ($('#view-library').classList.contains('active')) switchView('editor');
    importFiles(files, '貼り付けで');
  });
  $$('input[type=file]').forEach(inp => inp.addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; }));

  $$('[data-view]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); switchView(b.dataset.view); }));
  $('#clearTray').onclick = () => { if (state.tray.length && confirm('取り込み中の画像をすべて外しますか？（保存済みログは残ります）')) { state.tray.forEach(t => URL.revokeObjectURL(t.url)); state.tray = []; state.activeId = null; renderTray(); syncControls(); draw(); } };
  $('#saveAll').onclick = async () => {
    if (!state.tray.length) return;
    if (Folder.needsPermission()) await Folder.reconnect();
    for (const it of state.tray) await saveItem(it, true);
    toast(`${state.tray.length}件をログに保存しました`);
  };
  $('#saveBtn').onclick = async () => { if (!active()) return; if (Folder.needsPermission()) await Folder.reconnect(); saveItem(active()); };
  $('#downloadBtn').onclick = async () => { const b = await exportActive(); if (b) downloadBlob(b, safeName(active().title) + '.png'); };
  $('#copyBtn').onclick = async () => { const b = await exportActive(); if (b) copyBlob(b); };

  document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); active() && saveItem(active()); }
    if (e.key === 'Escape') { closeModal(); if ($('#news').classList.contains('open')) closeNews(); }
    if (!typing && e.key === '/') { e.preventDefault(); switchView('library'); $('#search').focus(); }
    if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && state.tray.length > 1 && $('#view-editor').classList.contains('active')) {
      const i = state.tray.findIndex(t => t.id === state.activeId);
      const n = clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, state.tray.length - 1);
      selectItem(state.tray[n].id); e.preventDefault();
    }
  });
  window.addEventListener('resize', () => { movePill(); draw(); });
}

// ---------- Kinetics-style magnetic buttons ----------
function magnets() {
  const PULL = 0.25;
  document.addEventListener('pointermove', e => {
    const el = e.target.closest?.('.magnet');
    $$('.magnet').forEach(m => { if (m !== el) m.style.transform = ''; });
    if (!el || e.pointerType !== 'mouse') return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left - r.width / 2) * PULL, y = (e.clientY - r.top - r.height / 2) * PULL;
    el.style.transform = `translate(${x}px, ${y}px)`;
  });
}

// ---------- folder sync (File System Access API) ----------
const FS_SUPPORTED = 'showDirectoryPicker' in window;
const IMG_RE = /\.(png|jpe?g|webp|gif|heic|heif)$/i;
const Folder = (() => {
  let handle = null, perm = 'none', files = [], thumbUrls = [], scanTimer = 0;
  const o = { auto: true, organize: 'month', originals: false, ...JSON.parse(localStorage.getItem('cliplog:folder') || '{}') };
  const saveOpts = () => localStorage.setItem('cliplog:folder', JSON.stringify(o));
  const ready = () => FS_SUPPORTED && !!handle && perm === 'granted';
  const autoReady = () => ready() && o.auto;

  async function check(request = false) {
    if (!handle) return (perm = 'none');
    const q = { mode: 'readwrite' };
    let p = await handle.queryPermission(q);
    if (p !== 'granted' && request) p = await handle.requestPermission(q);
    return (perm = p);
  }
  async function init() {
    bindUI();
    if (FS_SUPPORTED) {
      const h = await DB.kvGet('dir').catch(() => null);
      handle = h && typeof h.queryPermission === 'function' ? h : null;
      if (handle) await check(false).catch(() => (perm = 'prompt'));
    }
    renderUI();
    if (ready()) scan();
  }
  async function pick() {
    try {
      handle = await window.showDirectoryPicker({ id: 'cliplog', mode: 'readwrite', startIn: 'pictures' });
      await DB.kvSet('dir', handle);
      perm = 'granted';
      renderUI(); toast(`「${handle.name}」と連携しました`); scan();
    } catch (e) { if (e.name !== 'AbortError') toast('フォルダを開けませんでした', '!'); }
  }
  async function reconnect() {
    try { if (await check(true) === 'granted') { toast('フォルダへのアクセスを許可しました'); scan(); } } catch { }
    renderUI();
  }
  async function disconnect() {
    if (!confirm('フォルダとの連携を解除しますか？（フォルダ内のファイルは消えません）')) return;
    handle = null; perm = 'none'; files = [];
    await DB.kvDel('dir'); renderUI(); renderGrid();
  }
  async function getDir(parts, create = true) {
    let d = handle;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create });
    return d;
  }
  function subdirFor(rec) {
    if (o.organize === 'month') { const d = new Date(rec.createdAt); return [`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`]; }
    if (o.organize === 'tag') return [safeName(rec.tags?.[0] || '未分類')];
    return [];
  }
  async function uniqueName(dir, base, ext) {
    let n = `${base}.${ext}`, i = 2;
    for (;;) { try { await dir.getFileHandle(n); n = `${base} (${i++}).${ext}`; } catch { return n; } }
  }
  async function writeFile(dir, name, blob) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable(); await w.write(blob); await w.close();
  }
  async function writeLog(rec) {
    const parts = subdirFor(rec), dir = await getDir(parts);
    const d = new Date(rec.createdAt), p = (n) => String(n).padStart(2, '0');
    const base = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}_${safeName(rec.title)}`;
    let name;
    if (rec.filePath) {
      const old = rec.filePath.split('/'), oldName = old.pop();
      if (old.join('/') === parts.join('/') && oldName.includes(safeName(rec.title))) name = oldName;
      else { try { await remove(rec.filePath, true); } catch { } }
    }
    name ||= await uniqueName(dir, base, 'png');
    await writeFile(dir, name, rec.render);
    if (o.originals && rec.src) {
      const od = await getDir([...parts, 'originals']);
      const ext = ((rec.src.type || 'image/png').split('/')[1] || 'png').replace('jpeg', 'jpg');
      await writeFile(od, name.replace(/\.png$/, '') + '.' + ext, rec.src);
    }
    scanSoon();
    return [...parts, name].join('/');
  }
  async function remove(path, quiet) {
    const parts = path.split('/'), name = parts.pop();
    const dir = await getDir(parts, false);
    await dir.removeEntry(name);
    if (!quiet) scanSoon();
  }
  async function walk(dir, prefix, depth, out) {
    for await (const [name, h] of dir.entries()) {
      if (out.length >= 600) return;
      if (h.kind === 'file' && IMG_RE.test(name)) out.push({ name, path: prefix + name, handle: h });
      else if (h.kind === 'directory' && depth < 3 && !name.startsWith('.') && name !== 'originals') await walk(h, prefix + name + '/', depth + 1, out);
    }
  }
  async function scan() {
    if (!ready()) return;
    const out = [];
    try { await walk(handle, '', 0, out); } catch (e) { console.warn(e); await check(false).catch(() => {}); }
    await Promise.all(out.map(async f => { try { f.file = await f.handle.getFile(); } catch { } }));
    files = out.filter(f => f.file).sort((a, b) => b.file.lastModified - a.file.lastModified);
    renderUI(); renderGrid();
  }
  function scanSoon() { clearTimeout(scanTimer); scanTimer = setTimeout(scan, 500); }
  async function exportAll() {
    if (!ready()) return;
    const logs = await DB.all(); let n = 0;
    for (const l of logs) { try { l.filePath = await writeLog(l); await DB.put(l); n++; } catch (e) { console.warn(e); } }
    await loadLogs(); toast(`${n}件をフォルダに書き出しました`);
  }
  async function importList(list) {
    if (!list.length) return;
    switchView('editor');
    await importFiles(list.map(f => f.file), 'フォルダから');
  }

  function renderUI() {
    const sup = FS_SUPPORTED;
    $('#folderUnsupported').hidden = sup;
    $('#folderPick').hidden = !sup || !!handle;
    $('#folderReconnect').hidden = !(handle && perm !== 'granted');
    $('#folderOpts').hidden = !ready();
    const icon = $('#folderIcon');
    icon.classList.toggle('ok', ready()); icon.classList.toggle('warn', !!handle && perm !== 'granted');
    if (!handle) {
      $('#folderName').textContent = 'フォルダ未接続';
      $('#folderState').textContent = sup ? 'パソコンのフォルダを選ぶと、保存したログを画像ファイルとして自動で整理します。' : '';
    } else if (perm !== 'granted') {
      $('#folderName').textContent = handle.name;
      $('#folderState').textContent = 'ブラウザを再起動したため、もう一度アクセスの許可が必要です。';
    } else {
      $('#folderName').textContent = handle.name;
      const orgLabel = { none: 'そのまま', month: '月別フォルダ', tag: 'タグ別フォルダ' }[o.organize];
      $('#folderState').textContent = `${files.length}枚の画像 · ${o.auto ? `保存時に自動書き出し（${orgLabel}）` : '自動書き出しはオフ'}`;
    }
    $('#folderAuto').checked = o.auto;
    $('#folderOriginals').checked = o.originals;
    $$('#folderOrganize button').forEach(b => b.classList.toggle('on', b.dataset.org === o.organize));
    const fc = $('#folderCount'); fc.hidden = !ready(); fc.textContent = files.length;
  }
  function renderGrid() {
    thumbUrls.forEach(u => URL.revokeObjectURL(u)); thumbUrls = [];
    const grid = $('#folderGrid'); grid.innerHTML = '';
    if (!ready()) return;
    files.slice(0, 300).forEach((f, i) => {
      const el = document.createElement('article');
      el.className = 'card glass';
      el.style.animationDelay = Math.min(i * 30, 300) + 'ms';
      el.innerHTML = `<div class="thumb"><img alt="" loading="lazy" /></div>
        <div class="meta"><h3></h3><div class="sub"><span class="path"></span><span>${(f.file.size / 1024 / 1024).toFixed(1)}MB</span></div></div>`;
      const img = el.querySelector('img');
      if (!/heic|heif/i.test(f.name)) { const u = URL.createObjectURL(f.file); thumbUrls.push(u); img.src = u; }
      el.querySelector('h3').textContent = f.name;
      el.querySelector('.path').textContent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '/';
      el.title = 'クリックでエディタに取り込み';
      el.onclick = () => importList([f]);
      grid.appendChild(el);
    });
  }
  function bindUI() {
    $('#folderPick').onclick = pick;
    $('#folderChange').onclick = pick;
    $('#folderReconnect').onclick = reconnect;
    $('#folderDisconnect').onclick = disconnect;
    $('#folderRescan').onclick = async () => { await scan(); toast('フォルダを読み込み直しました'); };
    $('#folderExport').onclick = exportAll;
    $('#folderImportAll').onclick = () => importList(files.slice(0, 50));
    $('#folderAuto').onchange = (e) => { o.auto = e.target.checked; saveOpts(); renderUI(); };
    $('#folderOriginals').onchange = (e) => { o.originals = e.target.checked; saveOpts(); };
    $$('#folderOrganize button').forEach(b => b.onclick = () => { o.organize = b.dataset.org; saveOpts(); renderUI(); });
  }
  return { init, ready, autoReady, writeLog, remove, scan, needsPermission: () => !!handle && perm !== 'granted', reconnect };
})();

function bindLibTabs() {
  $$('#libTabs button').forEach(b => b.onclick = () => showLibTab(b.dataset.tab));
}
function showLibTab(tab) {
  $$('#libTabs button').forEach(x => x.classList.toggle('on', x.dataset.tab === tab));
  $('#pane-logs').classList.toggle('hidden', tab !== 'logs');
  $('#pane-folder').classList.toggle('hidden', tab !== 'folder');
  if (tab === 'folder' && Folder.ready()) Folder.scan();
}

// ---------- PWA: install, updates, file launch ----------
const APP_VERSION = '1.2.0';
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function setupPWA() {
  let deferred = null;
  const btn = $('#installBtn');
  if (!isStandalone() && isIOS()) btn.hidden = false;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; btn.hidden = isStandalone(); });
  window.addEventListener('appinstalled', () => { btn.hidden = true; deferred = null; toast('ClipLogをインストールしました'); });
  btn.onclick = async () => {
    if (!deferred) { openNews(); return; }
    deferred.prompt();
    await deferred.userChoice.catch(() => {});
    deferred = null; btn.hidden = true;
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      const waiting = () => showUpdateBar(reg);
      if (reg.waiting && navigator.serviceWorker.controller) waiting();
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) waiting(); });
      });
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(err => console.warn('SW', err));
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded || !sessionStorage.getItem('cliplog:updating')) return;
      reloaded = true; sessionStorage.removeItem('cliplog:updating'); location.reload();
    });
  }

  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files?.length) return;
      const fs = await Promise.all(params.files.map(h => h.getFile()));
      switchView('editor'); importFiles(fs, 'アプリから');
    });
  }
}

function showUpdateBar(reg) {
  const bar = $('#updateBar');
  bar.hidden = false;
  $('#updateLater').onclick = () => { bar.hidden = true; };
  $('#updateNow').onclick = () => {
    const unsaved = state.tray.some(t => !t.savedId);
    if (unsaved && !confirm('保存していない画像は消えます。更新しますか？')) return;
    sessionStorage.setItem('cliplog:updating', '1');
    (reg.waiting || reg.installing)?.postMessage('SKIP_WAITING');
    bar.hidden = true;
  };
}

function openNews() {
  $('#newsVersion').textContent = `Version ${APP_VERSION}`;
  $('#newsIos').hidden = !(isIOS() && !isStandalone());
  $('#news').classList.add('open'); $('#news').setAttribute('aria-hidden', 'false');
  $('#newsDot').hidden = true;
}
function closeNews() {
  $('#news').classList.remove('open'); $('#news').setAttribute('aria-hidden', 'true');
  localStorage.setItem('cliplog:seenVersion', APP_VERSION);
}
function showWhatsNew() {
  $('#newsBtn').onclick = openNews;
  $('#newsOk').onclick = closeNews;
  $('#newsFolder').onclick = () => { closeNews(); switchView('library'); showLibTab('folder'); };
  $('#news').addEventListener('click', (e) => { if (e.target.id === 'news') closeNews(); });
  if (localStorage.getItem('cliplog:seenVersion') !== APP_VERSION) {
    $('#newsDot').hidden = false;
    setTimeout(openNews, 700);
  }
}

// ---------- theme (follows browser, overridable) ----------
function setupTheme() {
  const modes = ['auto', 'light', 'dark'];
  const label = { auto: 'ブラウザに合わせる', light: 'ライト', dark: 'ダーク' };
  const mq = matchMedia('(prefers-color-scheme: dark)');
  let mode = localStorage.getItem('cliplog:theme') || 'auto';
  const apply = () => {
    if (mode === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = mode;
    const bar = getComputedStyle(document.documentElement).getPropertyValue('--sc').trim();
    $$('meta[name=theme-color]').forEach(m => { if (mode === 'auto') m.removeAttribute('data-x'); m.content = mode === 'auto' ? (m.media.includes('dark') ? '#211F26' : '#F3EDF7') : bar; });
    $('#themeBtn').title = 'テーマ：' + label[mode];
  };
  $('#themeBtn').onclick = () => {
    mode = modes[(modes.indexOf(mode) + 1) % 3];
    localStorage.setItem('cliplog:theme', mode); apply(); toast('テーマ：' + label[mode]);
  };
  mq.addEventListener?.('change', apply);
  apply();
}

// ---------- boot ----------
buildSwatches();
bindControls();
bindInputs();
bindLibrary();
magnets();
syncControls();
setupTheme();
Folder.init();
bindLibTabs();
setupPWA();
showWhatsNew();
loadLogs().catch(err => { console.error(err); toast('ストレージを開けませんでした', '!'); });
switchView(location.hash === '#library' ? 'library' : 'editor');
requestAnimationFrame(movePill);
document.fonts?.ready.then(() => { movePill(); draw(); });
