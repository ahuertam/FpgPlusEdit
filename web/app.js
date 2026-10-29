/* FPG+ Edit — editor de recursos gráficos de DIV Games Studio 2.
   Interfaz sin dependencias: habla con el servidor local por /api/. */

'use strict';

const $ = (id) => document.getElementById(id);

const SUPPORTED = ['.fpg', '.f16', '.map', '.m16', '.pal', '.fnt'];
const KINDS = { fpg: 'FPG · 8 bits', f16: 'FPG · 16 bits', map: 'MAP', pal: 'PAL', fnt: 'FNT' };

const state = {
  doc: null,
  kind: null,
  info: null,
  maps: [],
  selected: null,
  frame: 0,
  zoom: 2,
  grid: false,
  palette: [],
  selColor: 0,
  image: null,
  offData: null,
  indexByRgb: new Map(),
  dir: '',
  home: '',
};

/* ------------------------------------------------------------------ apoyo */

async function api(path, params, opts) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url, opts);
  let j;
  try {
    j = await res.json();
  } catch {
    throw new Error(`respuesta no válida del servidor (HTTP ${res.status})`);
  }
  if (!j.ok) throw new Error(j.error || `error HTTP ${res.status}`);
  return j;
}

let toastTimer = null;
function toast(msg, bad) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('bad', !!bad);
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), bad ? 6000 : 2600);
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

const to8 = (v) => Math.floor((v * 255) / 63); // igual que el núcleo en Rust
const cssColor = (c) => `rgb(${to8(c[0])},${to8(c[1])},${to8(c[2])})`;

/* ------------------------------------------------------- explorador de disco */

function makeBrowser(listEl, pathEl, upBtn) {
  let parent = null;

  async function go(dir) {
    let j;
    try {
      j = await api('/api/fs', { dir });
    } catch (e) {
      toast(e.message, true);
      return;
    }
    parent = j.dir ? (j.parent ?? '') : null;
    pathEl.textContent = j.dir || 'Unidades';
    listEl.innerHTML = '';

    for (const e of j.entries) {
      if (!e.dir && !SUPPORTED.some((x) => e.name.toLowerCase().endsWith(x))) continue;
      const li = document.createElement('li');
      const ico = document.createElement('span');
      ico.className = 'ico';
      ico.textContent = e.dir ? '▸' : '·';
      const nm = document.createElement('span');
      nm.className = 'fname';
      nm.textContent = e.name;
      li.append(ico, nm);
      if (!e.dir) {
        const sz = document.createElement('span');
        sz.className = 'fsize';
        sz.textContent = fmtSize(e.size);
        li.append(sz);
      }
      li.title = e.path;
      li.onclick = () => (e.dir ? go(e.path) : openPath(e.path));
      listEl.append(li);
    }
  }

  upBtn.onclick = () => go(parent === null ? '' : parent);
  return { go, current: () => state.dir };
}

/* --------------------------------------------------------------- apertura */

async function openPath(p) {
  try {
    const j = await api('/api/open', { path: p });
    applyDoc(j, { reset: true });
    $('pathInput').value = j.path;
    toast(`Abierto ${j.name}`);
  } catch (e) {
    toast(e.message, true);
  }
}

function applyDoc(j, opts) {
  const reset = !!(opts && opts.reset);
  const keepSel = !reset && state.doc === j.doc;

  state.doc = j.doc;
  state.kind = j.kind;
  state.info = j;
  state.palette = j.palette || [];
  state.maps = [];

  if (j.kind === 'fnt') {
    state.maps = (j.glyphs || [])
      .filter((g) => g.w > 0 && g.h > 0)
      .map((g) => ({
        id: g.ch,
        name: labelGlyph(g.ch),
        width: g.w,
        height: g.h,
        frames: 1,
        thumb: `/api/glyph?doc=${j.doc}&ch=${g.ch}`,
      }));
  } else if (j.maps) {
    state.maps = j.maps.map((m) => ({
      ...m,
      thumb: `/api/image?doc=${j.doc}&id=${m.id}`,
    }));
  }

  if (!keepSel || state.selected === null || !state.maps.some((m) => m.id === state.selected)) {
    state.selected = state.maps.length ? state.maps[0].id : null;
    state.frame = 0;
  }

  buildIndexByRgb();
  renderMaps();
  renderPalette();
  renderProps();
  renderToolbar();
  loadImage();
}

function labelGlyph(ch) {
  const c = String.fromCharCode(ch);
  const printable = ch >= 32 && ch < 127 ? `«${c}»` : '(control)';
  return `${ch} ${printable}`;
}

/* ------------------------------------------------------------- lista mapas */

function renderMaps() {
  const list = $('mapList');
  list.innerHTML = '';
  $('mapsCount').textContent = state.maps.length ? `(${state.maps.length})` : '';

  for (const m of state.maps) {
    const li = document.createElement('li');
    if (m.id === state.selected) li.classList.add('sel');

    const img = document.createElement('img');
    img.src = m.thumb;
    img.alt = '';
    img.loading = 'lazy';

    const box = document.createElement('div');
    box.className = 'minfo';
    const id = document.createElement('span');
    id.className = 'mid';
    id.textContent = state.kind === 'fnt' ? `carácter ${m.id}` : `id ${m.id}`;
    const nm = document.createElement('span');
    nm.className = 'mname';
    nm.textContent = m.name || '';
    const sz = document.createElement('span');
    sz.className = 'msize';
    sz.textContent = `${m.width}×${m.height}${m.frames > 1 ? ` · ${m.frames} fot.` : ''}`;
    box.append(id, nm, sz);

    li.append(img, box);
    li.onclick = () => selectMap(m.id);
    list.append(li);
  }
}

function selectMap(id) {
  if (state.selected === id) return;
  state.selected = id;
  state.frame = 0;
  renderMaps();
  renderProps();
  renderToolbar();
  loadImage();
}

/* ------------------------------------------------------------------ lienzo */

function loadImage() {
  if (!state.doc) {
    state.image = null;
    draw();
    return;
  }
  if (state.kind === 'pal') {
    state.image = null;
    drawPaletteCanvas();
    return;
  }

  const t = Date.now();
  let url;
  if (state.kind === 'fnt') {
    url = `/api/glyph?doc=${state.doc}&ch=${state.selected ?? 0}&t=${t}`;
  } else {
    const idPart = state.selected !== null ? `&id=${state.selected}` : '';
    url = `/api/image?doc=${state.doc}${idPart}&frame=${state.frame}&t=${t}`;
  }

  const img = new Image();
  img.onload = () => {
    state.image = img;
    prepareOffscreen();
    draw();
  };
  img.onerror = () => {
    state.image = null;
    draw();
  };
  img.src = url;
}

function prepareOffscreen() {
  const img = state.image;
  state.offData = null;
  if (!img || !img.width || !img.height) return;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const cx = c.getContext('2d');
  cx.drawImage(img, 0, 0);
  try {
    state.offData = cx.getImageData(0, 0, c.width, c.height);
  } catch {
    state.offData = null;
  }
}

function draw() {
  const cv = $('view');
  const ctx = cv.getContext('2d');
  const img = state.image;

  $('emptyMsg').style.display = img ? 'none' : 'block';
  if (!img) {
    cv.width = 16;
    cv.height = 16;
    ctx.clearRect(0, 0, 16, 16);
    return;
  }

  const z = state.zoom;
  cv.width = Math.max(1, img.width * z);
  cv.height = Math.max(1, img.height * z);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(img, 0, 0, cv.width, cv.height);

  if (state.grid && z >= 3) {
    ctx.strokeStyle = 'rgba(50,40,30,.22)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= img.width; x++) {
      const px = x * z + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, cv.height);
      ctx.stroke();
    }
    for (let y = 0; y <= img.height; y++) {
      const py = y * z + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(cv.width, py);
      ctx.stroke();
    }
  }
}

/** Para ficheros PAL: dibuja la rejilla 16×16 de colores. */
function drawPaletteCanvas() {
  const cv = $('view');
  const ctx = cv.getContext('2d');
  const cell = 16;
  const z = state.zoom;
  $('emptyMsg').style.display = 'none';

  cv.width = cell * 16 * z;
  cv.height = cell * 16 * z;
  ctx.clearRect(0, 0, cv.width, cv.height);

  for (let i = 0; i < 256; i++) {
    const c = state.palette[i] || [0, 0, 0];
    ctx.fillStyle = i === 0 ? 'rgba(0,0,0,0)' : cssColor(c);
    const x = (i % 16) * cell * z;
    const y = Math.floor(i / 16) * cell * z;
    ctx.fillRect(x, y, cell * z, cell * z);
  }
  if (state.grid) {
    ctx.strokeStyle = 'rgba(50,40,30,.22)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 16; i++) {
      const p = i * cell * z + 0.5;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, cv.height); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(cv.width, p); ctx.stroke();
    }
  }
}

/* ------------------------------------------------------------------ paleta */

function buildIndexByRgb() {
  state.indexByRgb.clear();
  state.palette.forEach((c, i) => {
    if (i === 0) return;
    const key = `${to8(c[0])},${to8(c[1])},${to8(c[2])}`;
    if (!state.indexByRgb.has(key)) state.indexByRgb.set(key, i);
  });
}

function renderPalette() {
  const box = $('palette');
  box.innerHTML = '';
  if (!state.palette.length) return;

  state.palette.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.background = i === 0
      ? 'repeating-conic-gradient(#dedad2 0 25%, #f0ede7 0 50%) 0 0 / 8px 8px'
      : cssColor(c);
    b.title = `Índice ${i} · ${c[0]},${c[1]},${c[2]}`;
    if (i === state.selColor) b.classList.add('sel');
    b.onclick = () => selectColor(i);
    box.append(b);
  });
  syncPaletteFields();
}

function selectColor(i) {
  state.selColor = i;
  renderPalette();
}

function syncPaletteFields() {
  const c = state.palette[state.selColor] || [0, 0, 0];
  $('palIndex').textContent = state.selColor;
  $('palR').value = c[0];
  $('palG').value = c[1];
  $('palB').value = c[2];
  $('palRv').textContent = c[0];
  $('palGv').textContent = c[1];
  $('palBv').textContent = c[2];
  $('palPreview').style.background = state.selColor === 0
    ? 'repeating-conic-gradient(#dedad2 0 25%, #f0ede7 0 50%) 0 0 / 12px 12px'
    : cssColor(c);
}

async function applyColor() {
  if (!state.doc || !state.palette.length) return;
  const r = +$('palR').value;
  const g = +$('palG').value;
  const b = +$('palB').value;
  try {
    const j = await api('/api/palette', { doc: state.doc, index: state.selColor, r, g, b }, { method: 'POST' });
    applyDoc(j, {});
    toast(`Color ${state.selColor} actualizado (sin guardar)`);
  } catch (e) {
    toast(e.message, true);
  }
}

/* --------------------------------------------------------------- propiedades */

function renderProps() {
  const dl = $('props');
  dl.innerHTML = '';
  const j = state.info;
  if (!j) {
    dl.innerHTML = '<dt>—</dt><dd>Nada abierto</dd>';
    return;
  }

  const rows = [];
  rows.push(['Tipo', j.kind.toUpperCase() + (j.depth ? ` · ${j.depth} bits` : '')]);
  rows.push(['Fichero', j.name]);
  rows.push(['Ruta', j.path]);
  rows.push(['Tamaño', `${fmtSize(j.size)} (${j.size} B)`]);
  rows.push(['GZIP', j.gzip ? 'sí' : 'no']);

  if (j.kind === 'fpg') {
    rows.push(['Mapas', String(j.maps.length)]);
    rows.push(['Paleta', j.palette ? '256 colores' : '—']);
  } else if (j.kind === 'map') {
    rows.push(['Tamaño', `${j.width}×${j.height}`]);
    rows.push(['Id', String(j.code)]);
  } else if (j.kind === 'fnt') {
    rows.push(['Flags', String(j.flags)]);
    rows.push(['Caracteres', `${state.maps.length} con glifo`]);
  } else if (j.kind === 'pal') {
    rows.push(['Paleta', '256 colores']);
  }

  const m = state.maps.find((x) => x.id === state.selected);
  if (m) {
    rows.push(['—', '']);
    rows.push(['Selección', state.kind === 'fnt' ? `carácter ${m.id}` : `mapa ${m.id}`]);
    if (m.name) rows.push(['Nombre', m.name]);
    rows.push(['Dimensiones', `${m.width}×${m.height}`]);
    if (m.frames > 1) rows.push(['Fotogramas', String(m.frames)]);
    if (m.points) {
      const defined = m.points.filter((p) => !(p[0] === -1 && p[1] === -1));
      rows.push(['Puntos ctrl.', `${m.points.length} (${defined.length} definidos)`]);
    }
    if (m.animation) {
      rows.push(['Animación', `${m.animation.frames} fot. · ${m.animation.length} pasos · vel. ${m.animation.speed}`]);
    }
  }

  for (const [k, v] of rows) {
    if (v === '') { continue; }
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
}

/* ------------------------------------------------------------------ barra */

function renderToolbar() {
  const j = state.info;
  $('docKind').textContent = j ? (j.kind === 'fpg' ? `FPG ${j.depth} bits` : KINDS[j.kind] || j.kind) : 'sin fichero';

  const has = !!j;
  $('btnSave').disabled = !has;
  $('btnSaveAs').disabled = !has;
  $('btnExport').disabled = !(has && (j.kind === 'fpg' || j.kind === 'map'));
  $('btnImport').disabled = !(has && j.kind === 'fpg' && j.depth === 8);

  const m = state.maps.find((x) => x.id === state.selected);
  const frames = m ? m.frames || 1 : 1;
  const sel = $('frameSel');
  if (sel.options.length !== frames) {
    sel.innerHTML = '';
    for (let i = 0; i < frames; i++) {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = String(i);
      sel.append(o);
    }
  }
  sel.disabled = frames <= 1;
  sel.value = String(Math.min(state.frame, frames - 1));
}

/* --------------------------------------------------------------- acciones */

async function saveDoc(target) {
  if (!state.doc) return;
  try {
    const j = await api('/api/save', { doc: state.doc, path: target || null }, { method: 'POST' });
    $('pathInput').value = j.path;
    toast(`Guardado ${j.path} (${fmtSize(j.bytes)})`);
    // Releer para reflejar el tamaño real en pantalla.
    const fresh = await api('/api/open', { path: j.path });
    applyDoc(fresh, {});
  } catch (e) {
    toast(e.message, true);
  }
}

async function exportDoc() {
  if (!state.doc) return;
  const dir = state.info.path.replace(/[\\/][^\\/]*$/, '');
  const m = state.maps.find((x) => x.id === state.selected);
  const tag = m ? String(m.id).padStart(4, '0') : 'mapa';
  const def = `${dir}\\mapa_${tag}.png`;
  const out = prompt('Fichero de salida (.png, .bmp, .pcx, .jpg):', def);
  if (!out) return;
  const fmt = (out.split('.').pop() || 'png').toLowerCase();
  try {
    const j = await api('/api/export', { doc: state.doc, id: state.selected, path: out, format: fmt }, { method: 'POST' });
    toast(`Exportado ${j.path}`);
  } catch (e) {
    toast(e.message, true);
  }
}

async function importImage() {
  if (!state.doc) return;
  const dir = state.info.path.replace(/[\\/][^\\/]*$/, '');
  const p = prompt('Imagen a importar (.png, .bmp, .pcx, .jpg):', `${dir}\\`);
  if (!p) return;
  const idTxt = prompt('Id para el nuevo mapa (vacío = el siguiente libre):', '');
  try {
    const j = await api('/api/import', { doc: state.doc, path: p, id: idTxt || null }, { method: 'POST' });
    toast(`Importado como mapa ${j.id}`);
    const fresh = await api('/api/reload', { path: state.info.path });
    applyDoc(fresh, {});
    selectMap(j.id);
  } catch (e) {
    toast(e.message, true);
  }
}

async function newFpg() {
  const def = `${state.dir || state.home}\\NUEVO.FPG`;
  const p = prompt('Ruta del nuevo FPG:', def);
  if (!p) return;
  try {
    const j = await api('/api/new', { path: p }, { method: 'POST' });
    applyDoc(j, { reset: true });
    $('pathInput').value = j.path;
    toast(`Creado ${j.name}`);
  } catch (e) {
    toast(e.message, true);
  }
}

/* --------------------------------------------------------------- arranque */

const browserPanel = makeBrowser($('fileList'), $('crumbPath'), $('btnUp'));
const browserModal = makeBrowser($('mList'), $('mPath'), $('mUp'));

function wire() {
  $('btnOpen').onclick = () => {
    const p = $('pathInput').value.trim();
    if (p) openPath(p);
  };
  $('pathInput').onkeydown = (e) => {
    if (e.key === 'Enter') $('btnOpen').click();
  };

  $('btnBrowse').onclick = () => {
    $('modal').hidden = false;
    browserModal.go(state.dir || state.home || '');
  };
  $('modalClose').onclick = () => ($('modal').hidden = true);
  $('modal').onclick = (e) => {
    if (e.target === $('modal')) $('modal').hidden = true;
  };
  $('mOpen').onclick = () => {
    const p = $('mManual').value.trim();
    if (p) { $('modal').hidden = true; openPath(p); }
  };

  $('btnNew').onclick = newFpg;
  $('btnSave').onclick = () => saveDoc(null);
  $('btnSaveAs').onclick = () => {
    const p = prompt('Guardar como:', state.info ? state.info.path : '');
    if (p) saveDoc(p);
  };
  $('btnExport').onclick = exportDoc;
  $('btnImport').onclick = importImage;

  $('zoomSel').onchange = () => {
    state.zoom = +$('zoomSel').value;
    if (state.kind === 'pal') drawPaletteCanvas();
    else draw();
  };
  $('frameSel').onchange = () => {
    state.frame = +$('frameSel').value;
    loadImage();
  };
  $('gridChk').onchange = () => {
    state.grid = $('gridChk').checked;
    if (state.kind === 'pal') drawPaletteCanvas();
    else draw();
  };

  for (const id of ['palR', 'palG', 'palB']) {
    $(id).oninput = () => {
      $('palRv').textContent = $('palR').value;
      $('palGv').textContent = $('palG').value;
      $('palBv').textContent = $('palB').value;
      $('palPreview').style.background = `rgb(${to8(+$('palR').value)},${to8(+$('palG').value)},${to8(+$('palB').value)})`;
    };
  }
  $('palApply').onclick = applyColor;

  const cv = $('view');
  cv.onmousemove = (ev) => {
    const img = state.image;
    if (!img || !state.offData) return;
    const r = cv.getBoundingClientRect();
    const x = Math.floor((ev.clientX - r.left) / state.zoom);
    const y = Math.floor((ev.clientY - r.top) / state.zoom);
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) {
      $('readout').textContent = '—';
      return;
    }
    const d = state.offData.data;
    const i = (y * img.width + x) * 4;
    if (d[i + 3] === 0) {
      $('readout').textContent = `${x}, ${y}  ·  índice 0 (transparente)`;
      return;
    }
    const key = `${d[i]},${d[i + 1]},${d[i + 2]}`;
    const idx = state.indexByRgb.get(key);
    const hex = '#' + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    $('readout').textContent =
      `${x}, ${y}  ·  ${key}  ${hex}` + (idx !== undefined ? `  ·  índice ${idx}` : '');
  };
  cv.onmouseleave = () => ($('readout').textContent = '—');
}

async function boot() {
  wire();
  try {
    const st = await api('/api/state');
    state.home = st.home;
    browserPanel.go(st.home);
    browserModal.go(st.home);
  } catch (e) {
    toast('No he podido hablar con el servidor: ' + e.message, true);
  }
  renderToolbar();
}

boot();
