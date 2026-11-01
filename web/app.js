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
  pointIndex: 0,
  pickPoint: false,
  pane: 'map',
  inspectorOpen: true,
  dirty: false,
  dropped: false,
  undoStack: [],
  redoStack: [],
  historyBusy: false,

  // Editor de pintura
  tool: 'view',       // herramienta activa
  brush: 1,           // grosor del pincel y la goma
  fillShape: false,   // rectángulos y elipses rellenos
  sel565: 0xffcc00,   // colores nativos, cuando se edita un FPG de 16 bits
  buf: null,          // búfer local de píxeles del mapa activo
  off: null,          // lienzo fuera de pantalla con el búfer ya en RGBA
  clip: null,         // portapapeles de trozos (persiste entre mapas)
  sel: null,          // rectángulo de selección, en coordenadas de imagen
  float: null,        // trozo flotante a la espera de anclarse
  drag: null,         // gesto en curso
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
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Suelta un documento en el servidor. Es best-effort: si falla, da igual. */
function closeDoc(id) {
  if (id === null || id === undefined) return;
  api('/api/close', { doc: id }, { method: 'POST' }).catch(() => {});
}

/** Serializa una lista de puntos al formato que espera /api/points (`x,y;…`). */
const pointsToParam = (list) => (list || []).map(([x, y]) => `${x},${y}`).join(';');

function currentMap() {
  return state.maps.find((m) => m.id === state.selected) || null;
}

function currentPoint() {
  const m = currentMap();
  if (!m || !m.points || !m.points.length) return [-1, -1];
  const i = clamp(state.pointIndex, 0, m.points.length - 1);
  return m.points[i] || [-1, -1];
}

/* ------------------------------------------------------- diálogo de fichero */

const EXT_IMAGES = ['.png', '.bmp', '.pcx', '.jpg', '.jpeg'];

/** Estado del diálogo, que sirve para abrir, guardar, exportar, importar y
    crear: solo cambian el título, el filtro y qué se hace al aceptar. */
const dialog = { mode: 'open', exts: SUPPORTED, onPick: null, dir: '', parent: null };

async function dialogGo(dir) {
  let j;
  try {
    j = await api('/api/fs', { dir });
  } catch (e) {
    toast(e.message, true);
    return;
  }
  state.dir = j.dir;
  dialog.dir = j.dir;
  dialog.parent = j.dir ? (j.parent ?? '') : null;
  $('mPath').textContent = j.dir || 'Unidades';

  const list = $('mList');
  list.innerHTML = '';
  for (const e of j.entries) {
    if (!e.dir && !dialog.exts.some((x) => e.name.toLowerCase().endsWith(x))) continue;
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
    li.onclick = () => {
      if (e.dir) { dialogGo(e.path); return; }
      $('mPath2').value = e.path;
      if (dialog.mode === 'open') confirmDialog();
    };
    list.append(li);
  }
}

function openDialog(cfg) {
  dialog.mode = cfg.mode;
  dialog.exts = cfg.exts || SUPPORTED;
  dialog.onPick = cfg.onPick;
  $('modalTitle').textContent = cfg.title;
  $('mOk').textContent = cfg.confirm || 'Aceptar';
  $('mPath2').value = cfg.path || '';
  $('mPath2').placeholder = cfg.placeholder || '…o escribe una ruta';
  $('mExtraWrap').hidden = !cfg.extra;
  if (cfg.extra) {
    $('mExtraLabel').textContent = cfg.extra.label;
    $('mExtra').value = cfg.extra.value || '';
  }
  $('modal').hidden = false;
  dialogGo(cfg.dir || currentDir());
}

function closeDialog() {
  $('modal').hidden = true;
  dialog.onPick = null;
}

async function confirmDialog() {
  if ($('modal').hidden) return;
  const path = $('mPath2').value.trim();
  if (!path) { toast('Escribe una ruta o elige un fichero', true); return; }
  const extra = $('mExtraWrap').hidden ? null : $('mExtra').value.trim();
  const pick = dialog.onPick;
  closeDialog();
  if (pick) await pick(path, extra);
}

/** Extensión propia de un tipo de documento, para el filtro del diálogo. */
const extOf = (kind) => ({ fpg: '.fpg', map: '.map', pal: '.pal', fnt: '.fnt' })[kind] || '';

/** Carpeta del fichero abierto, o el último directorio visitado. */
function currentDir() {
  if (state.info && state.info.path) return state.info.path.replace(/[\\/][^\\/]*$/, '');
  return state.dir || state.home || '';
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

/* ------------------------------------------------------ arrastrar y soltar */

/** Extensión en minúsculas de un nombre de fichero, incluido el punto. */
const fileExt = (name) => ('.' + (name.split('.').pop() || '')).toLowerCase();

/** `true` si quien arrastra trae ficheros (y no, por ejemplo, texto o un enlace). */
const hasFiles = (ev) => Array.from(ev.dataTransfer?.types || []).includes('Files');

/** Abre un recurso soltado sobre la ventana.
    El navegador no entrega su ruta, así que los bytes van al servidor, que los
    copia a una carpeta temporal y abre esa copia; de ahí que el primer
    guardado pida destino. */
async function dropFile(file) {
  const ext = fileExt(file.name);
  if (!SUPPORTED.includes(ext)) {
    toast(`«${file.name}» no es un recurso de DIV (${SUPPORTED.join(' ')})`, true);
    return;
  }
  try {
    const buf = await file.arrayBuffer();
    const j = await api('/api/drop', { name: file.name }, { method: 'POST', body: buf });
    if (!$('modal').hidden) closeDialog();
    applyDoc(j, { reset: true });
    $('pathInput').value = j.path;
    toast(`«${file.name}» abierto por arrastre · Guardar como… para conservarlo`);
  } catch (e) {
    toast(e.message, true);
  }
}

function applyDoc(j, opts) {
  const reset = !!(opts && opts.reset);
  const keepSel = !reset && state.doc === j.doc;

  // El servidor guarda cada documento abierto en su almacén en memoria y solo
  // lo suelta si se lo pedimos. Sin esto, cada fichero abierto o guardado
  // dejaría el anterior ocupando sitio hasta cerrar la aplicación.
  if (state.doc !== null && state.doc !== j.doc) closeDoc(state.doc);

  if (reset) {
    state.undoStack = [];
    state.redoStack = [];
    state.pickPoint = false;
    state.dirty = false;
  }

  state.doc = j.doc;
  state.kind = j.kind;
  state.info = j;
  state.dropped = !!j.dropped;
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
  const m = currentMap();
  if (!m || !m.points || !m.points.length) {
    state.pointIndex = 0;
  } else {
    state.pointIndex = clamp(state.pointIndex, 0, m.points.length - 1);
  }

  buildIndexByRgb();
  renderMaps();
  renderPalette();
  renderEditor();
  renderProps();
  renderToolbar();
  resetPaintState();
  loadCanvas();
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
  state.pickPoint = false;
  const m = currentMap();
  state.pointIndex = m && m.points && m.points.length ? clamp(state.pointIndex, 0, m.points.length - 1) : 0;
  renderMaps();
  renderEditor();
  renderProps();
  renderToolbar();
  resetPaintState();
  loadCanvas();
}

/* ------------------------------------------------------------------ lienzo */

/** Carga una imagen y la resuelve cuando está lista (o `null` si falla). */
function loadImageEl(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Prepara el lienzo del mapa o glifo activo. */
async function loadCanvas() {
  if (!state.doc) {
    state.image = null;
    state.buf = null;
    draw();
    renderPaint();
    return;
  }
  if (state.kind === 'pal') {
    state.image = null;
    state.buf = null;
    drawPaletteCanvas();
    renderPaint();
    return;
  }
  if (state.kind === 'fnt') {
    state.buf = null;
    state.image = await loadImageEl(`/api/glyph?doc=${state.doc}&ch=${state.selected ?? 0}&t=${Date.now()}`);
    prepareOffscreen();
    draw();
    renderPaint();
    return;
  }
  // FPG y MAP se editan sobre un búfer de píxeles propio, no sobre un PNG.
  state.image = null;
  try {
    await loadPixels();
  } catch (e) {
    state.buf = null;
    toast(e.message, true);
  }
  draw();
  renderPaint();
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

/** Rejilla de píxeles sobre el lienzo. */
function drawGrid(ctx, w, h, z) {
  ctx.strokeStyle = 'rgba(50,40,30,.22)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= w; x++) {
    const px = x * z + 0.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h * z);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y++) {
    const py = y * z + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(w * z, py);
    ctx.stroke();
  }
}

function draw() {
  const cv = $('view');
  const ctx = cv.getContext('2d');
  const buf = state.buf;
  const img = state.image;
  const z = state.zoom;

  // Mapas y sprites: se pintan desde el búfer local, de modo que los trazos
  // aparecen al instante sin pedir nada al servidor.
  if (buf) {
    renderBuf();
    cv.width = Math.max(1, buf.w * z);
    cv.height = Math.max(1, buf.h * z);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(state.off.canvas, 0, 0, cv.width, cv.height);
    $('emptyMsg').style.display = 'none';
    if (state.grid && z >= 3) drawGrid(ctx, buf.w, buf.h, z);
    drawFloat(ctx, z);
    drawSelection(ctx, z);
    drawControlPoints(ctx, z);
    return;
  }

  $('emptyMsg').style.display = img ? 'none' : 'block';
  if (!img) {
    cv.width = 16;
    cv.height = 16;
    ctx.clearRect(0, 0, 16, 16);
    return;
  }

  cv.width = Math.max(1, img.width * z);
  cv.height = Math.max(1, img.height * z);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(img, 0, 0, cv.width, cv.height);

  if (state.grid && z >= 3) drawGrid(ctx, img.width, img.height, z);

  drawControlPoints(ctx, z);
}

/* ------------------------------------------------------- editor de píxeles */

/** Bytes por píxel según la profundidad del mapa. */
const bppOf = (depth) => (depth === 16 ? 2 : 1);

/** Lee un píxel como número: índice de paleta (8 bits) o RGB565 (16 bits). */
function getPx(buf, x, y) {
  const i = y * buf.w + x;
  return buf.depth === 16 ? buf.data[i * 2] | (buf.data[i * 2 + 1] << 8) : buf.data[i];
}

function setPx(buf, x, y, v) {
  const i = y * buf.w + x;
  if (buf.depth === 16) {
    buf.data[i * 2] = v & 0xff;
    buf.data[i * 2 + 1] = (v >> 8) & 0xff;
  } else {
    buf.data[i] = v & 0xff;
  }
}

/** Color con el que se pinta: índice de paleta o valor RGB565. */
const paintValue = () => (state.buf && state.buf.depth === 16 ? state.sel565 : state.selColor);

/** Vuelca `count` píxeles a un búfer RGBA (índice 0 / valor 0 = transparente). */
function fillRgba(out, count, depth, data) {
  if (depth === 16) {
    for (let i = 0; i < count; i++) {
      const v = data[i * 2] | (data[i * 2 + 1] << 8);
      if (!v) { out[i * 4 + 3] = 0; continue; }
      out[i * 4] = (((v >> 11) & 31) * 255 / 31) | 0;
      out[i * 4 + 1] = (((v >> 5) & 63) * 255 / 63) | 0;
      out[i * 4 + 2] = ((v & 31) * 255 / 31) | 0;
      out[i * 4 + 3] = 255;
    }
    return;
  }
  for (let i = 0; i < count; i++) {
    const idx = data[i];
    if (idx === 0) { out[i * 4 + 3] = 0; continue; }
    const c = state.palette[idx] || [0, 0, 0];
    out[i * 4] = to8(c[0]);
    out[i * 4 + 1] = to8(c[1]);
    out[i * 4 + 2] = to8(c[2]);
    out[i * 4 + 3] = 255;
  }
}

/** Lienzo con los píxeles de un bloque ya convertidos a RGBA. */
function blockToCanvas(w, h, depth, data) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const cx = c.getContext('2d');
  const img = cx.createImageData(w, h);
  fillRgba(img.data, w * h, depth, data);
  cx.putImageData(img, 0, 0);
  return c;
}

/** Actualiza el lienzo fuera de pantalla del búfer activo. */
function renderBuf() {
  const buf = state.buf;
  if (!buf) return;
  if (!state.off || state.off.canvas.width !== buf.w || state.off.canvas.height !== buf.h) {
    const canvas = document.createElement('canvas');
    canvas.width = buf.w;
    canvas.height = buf.h;
    state.off = { canvas, ctx: canvas.getContext('2d') };
  }
  const img = state.off.ctx.createImageData(buf.w, buf.h);
  fillRgba(img.data, buf.w * buf.h, buf.depth, buf.data);
  state.off.ctx.putImageData(img, 0, 0);
}

/** Recorta un rectángulo de un búfer de píxeles a un vector de bytes. */
function extractRect(data, buf, r) {
  const bpp = bppOf(buf.depth);
  const row = r.w * bpp;
  const out = new Uint8Array(row * r.h);
  for (let y = 0; y < r.h; y++) {
    const src = ((r.y + y) * buf.w + r.x) * bpp;
    out.set(data.subarray(src, src + row), y * row);
  }
  return out;
}

function blitRect(buf, r, bytes) {
  const bpp = bppOf(buf.depth);
  const row = r.w * bpp;
  for (let y = 0; y < r.h; y++) {
    const dst = ((r.y + y) * buf.w + r.x) * bpp;
    buf.data.set(bytes.subarray(y * row, (y + 1) * row), dst);
  }
}

/** Ajusta un rectángulo (coordenadas inclusivas) a los límites del búfer. */
function clipRect(bb, buf) {
  const x0 = Math.max(0, Math.floor(bb.x0));
  const y0 = Math.max(0, Math.floor(bb.y0));
  const x1 = Math.min(buf.w - 1, Math.ceil(bb.x1));
  const y1 = Math.min(buf.h - 1, Math.ceil(bb.y1));
  if (x1 < x0 || y1 < y0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Sella un cuadrado de `size` píxeles centrado en (x, y). */
function stamp(buf, x, y, v, size, erase, touch) {
  const half = Math.floor((size - 1) / 2);
  for (let dy = 0; dy < size; dy++) {
    const py = y - half + dy;
    if (py < 0 || py >= buf.h) continue;
    for (let dx = 0; dx < size; dx++) {
      const px = x - half + dx;
      if (px < 0 || px >= buf.w) continue;
      setPx(buf, px, py, erase ? 0 : v);
      if (touch) touch(px, py);
    }
  }
}

/** Línea de Bresenham sellando el pincel en cada paso. */
function drawLine(buf, x0, y0, x1, y1, v, size, erase, touch) {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    stamp(buf, x, y, v, size, erase, touch);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

function drawRectShape(buf, x0, y0, x1, y1, v, fill, touch) {
  const xa = Math.min(x0, x1);
  const xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1);
  const yb = Math.max(y0, y1);
  for (let y = ya; y <= yb; y++) {
    if (y < 0 || y >= buf.h) continue;
    for (let x = xa; x <= xb; x++) {
      if (x < 0 || x >= buf.w) continue;
      if (!fill && x > xa && x < xb && y > ya && y < yb) continue;
      setPx(buf, x, y, v);
      touch(x, y);
    }
  }
}

/** Elipse por barrido de filas y columnas, de modo que el contorno no se corte. */
function drawEllipseShape(buf, x0, y0, x1, y1, v, fill, touch) {
  const xa = Math.min(x0, x1);
  const xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1);
  const yb = Math.max(y0, y1);
  const cx = (xa + xb) / 2;
  const cy = (ya + yb) / 2;
  const rx = Math.max(0.5, (xb - xa) / 2 + 0.5);
  const ry = Math.max(0.5, (yb - ya) / 2 + 0.5);
  const plot = (x, y) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= buf.w || y >= buf.h) return;
    setPx(buf, x, y, v);
    touch(x, y);
  };
  for (let y = ya; y <= yb; y++) {
    const t = 1 - ((y - cy) / ry) ** 2;
    if (t < 0) continue;
    const dx = rx * Math.sqrt(t);
    const l = Math.round(cx - dx);
    const r = Math.round(cx + dx);
    if (fill) {
      for (let x = l; x <= r; x++) plot(x, y);
    } else {
      plot(l, y);
      plot(r, y);
    }
  }
  if (!fill) {
    for (let x = xa; x <= xb; x++) {
      const t = 1 - ((x - cx) / rx) ** 2;
      if (t < 0) continue;
      const dy = ry * Math.sqrt(t);
      plot(x, cy - dy);
      plot(x, cy + dy);
    }
  }
}

/** Relleno por propagación (scanline): cambia la zona contigua del mismo valor. */
function floodFill(buf, x, y, v, touch) {
  const target = getPx(buf, x, y);
  if (target === v) return;
  const stack = [[x, y]];
  while (stack.length) {
    const [px, py] = stack.pop();
    if (px < 0 || py < 0 || px >= buf.w || py >= buf.h) continue;
    if (getPx(buf, px, py) !== target) continue;
    let lx = px;
    while (lx - 1 >= 0 && getPx(buf, lx - 1, py) === target) lx--;
    let rx = px;
    while (rx + 1 < buf.w && getPx(buf, rx + 1, py) === target) rx++;
    for (let i = lx; i <= rx; i++) {
      setPx(buf, i, py, v);
      touch(i, py);
    }
    for (let i = lx; i <= rx; i++) {
      if (py - 1 >= 0 && getPx(buf, i, py - 1) === target) stack.push([i, py - 1]);
      if (py + 1 < buf.h && getPx(buf, i, py + 1) === target) stack.push([i, py + 1]);
    }
  }
}

/* --------------------------------------------------- enlace con el servidor */

/** Trae el plano de píxeles del mapa activo. */
async function loadPixels() {
  const m = currentMap();
  if (!state.doc || !m) {
    state.buf = null;
    return;
  }
  const depth = state.info.depth === 16 ? 16 : 8;
  const bpp = bppOf(depth);
  const url = `/api/pixels?doc=${state.doc}&id=${m.id}&frame=${state.frame}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`no se han podido leer los píxeles (HTTP ${res.status})`);
  const raw = new Uint8Array(await res.arrayBuffer());
  const need = Math.max(0, m.width) * Math.max(0, m.height) * bpp;
  const data = new Uint8Array(need);
  data.set(raw.subarray(0, Math.min(need, raw.length)));
  state.buf = { w: m.width, h: m.height, depth, bpp, data };
}

/** Envía un rectángulo del búfer al servidor. */
async function sendRect(doc, mapId, frame, r, bytes) {
  const url = new URL('/api/pixels', location.origin);
  url.searchParams.set('doc', doc);
  url.searchParams.set('id', mapId);
  url.searchParams.set('frame', frame);
  url.searchParams.set('x', r.x);
  url.searchParams.set('y', r.y);
  url.searchParams.set('w', r.w);
  url.searchParams.set('h', r.h);
  const res = await fetch(url, { method: 'POST', body: bytes });
  let j;
  try {
    j = await res.json();
  } catch {
    throw new Error(`respuesta no válida del servidor (HTTP ${res.status})`);
  }
  if (!j.ok) throw new Error(j.error || `error HTTP ${res.status}`);
  return j;
}

/** Refresca la miniatura de un mapa tras editarlo. */
function refreshThumb(doc, mapId) {
  const i = state.maps.findIndex((x) => x.id === mapId);
  if (i < 0) return;
  state.maps[i].thumb = `/api/image?doc=${doc}&id=${mapId}&t=${Date.now()}`;
  const li = $('mapList').children[i];
  const img = li && li.querySelector('img');
  if (img) img.src = state.maps[i].thumb;
}

/** Si el mapa afectado sigue a la vista, vuelve a leer sus píxeles. */
async function reloadPixelsIfCurrent(doc, mapId, frame) {
  if (state.doc !== doc || state.selected !== mapId || state.frame !== frame) return;
  try {
    await loadPixels();
  } catch {
    return;
  }
  draw();
  refreshThumb(doc, mapId);
}

/** Entrada de historial para un cambio de píxeles. */
function pixelEntry(label, doc, mapId, frame, rect, before, after) {
  const apply = async (bytes) => {
    await sendRect(doc, mapId, frame, rect, bytes);
    state.dirty = true;
    await reloadPixelsIfCurrent(doc, mapId, frame);
  };
  return { label, do: () => apply(after), undo: () => apply(before) };
}

/** Valida el cambio, lo envía al servidor y lo apunta en el historial. */
async function commitPixels(label, bbox, snapshot) {
  const buf = state.buf;
  if (!buf || state.historyBusy) return;
  const doc = state.doc;
  const mapId = state.selected;
  const frame = state.frame;
  const r = clipRect(bbox, buf);
  if (!r) return;
  const after = extractRect(buf.data, buf, r);
  const before = extractRect(snapshot, buf, r);
  if (sameBytes(before, after)) return;

  state.historyBusy = true;
  try {
    await sendRect(doc, mapId, frame, r, after);
  } catch (e) {
    // Si el servidor rechaza el cambio, el búfer local vuelve a su sitio: si no,
    // lo que se ve en pantalla no sería lo que hay guardado.
    buf.data.set(snapshot);
    draw();
    toast(e.message, true);
    return;
  } finally {
    state.historyBusy = false;
  }

  state.undoStack.push(pixelEntry(label, doc, mapId, frame, r, before, after));
  state.redoStack = [];
  state.dirty = true;
  refreshThumb(doc, mapId);
  renderToolbar();
}

/** Ejecuta una edición sobre el mapa completo y la registra. */
async function withBufferEdit(label, fn) {
  const buf = state.buf;
  if (!buf || state.historyBusy) return;
  const snapshot = buf.data.slice();
  fn(buf);
  draw();
  await commitPixels(label, { x0: 0, y0: 0, x1: buf.w - 1, y1: buf.h - 1 }, snapshot);
}

/* -------------------------------------------------- gestos sobre el lienzo */

function touchDrag(x, y) {
  const b = state.drag.bbox;
  if (x < b.x0) b.x0 = x;
  if (y < b.y0) b.y0 = y;
  if (x > b.x1) b.x1 = x;
  if (y > b.y1) b.y1 = y;
}

function beginDrag(tool, p) {
  state.drag = {
    tool,
    start: { x: p.x, y: p.y },
    last: { x: p.x, y: p.y },
    snapshot: state.buf.data.slice(),
    bbox: { x0: p.x, y0: p.y, x1: p.x, y1: p.y },
    rect: null,
  };
}

function endDrag(label) {
  const d = state.drag;
  state.drag = null;
  if (!d) return;
  commitPixels(label, d.bbox, d.snapshot);
}

function updateShapePreview(p) {
  const d = state.drag;
  const buf = state.buf;
  buf.data.set(d.snapshot);
  d.bbox = {
    x0: Math.min(d.start.x, p.x),
    y0: Math.min(d.start.y, p.y),
    x1: Math.max(d.start.x, p.x),
    y1: Math.max(d.start.y, p.y),
  };
  const v = paintValue();
  if (d.tool === 'line') drawLine(buf, d.start.x, d.start.y, p.x, p.y, v, state.brush, false, touchDrag);
  else if (d.tool === 'rect') drawRectShape(buf, d.start.x, d.start.y, p.x, p.y, v, state.fillShape, touchDrag);
  else drawEllipseShape(buf, d.start.x, d.start.y, p.x, p.y, v, state.fillShape, touchDrag);
  draw();
}

const pointInRect = (p, r) => r && p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;

/** Convierte el rectángulo de selección en un trozo flotante que se puede mover. */
function liftSelection() {
  const buf = state.buf;
  const r = clipRect({ x0: state.sel.x, y0: state.sel.y, x1: state.sel.x + state.sel.w - 1, y1: state.sel.y + state.sel.h - 1 }, buf);
  if (!r) return false;
  const data = extractRect(buf.data, buf, r);
  setFloat(r.x, r.y, r.w, r.h, data);
  // Se vacía el origen: así arrastrar se comporta como mover, no como copiar.
  for (let y = r.y; y < r.y + r.h && y < buf.h; y++) {
    for (let x = r.x; x < r.x + r.w && x < buf.w; x++) setPx(buf, x, y, 0);
  }
  state.sel = null;
  return true;
}

function setFloat(x, y, w, h, data) {
  if (!state.buf) return;
  state.float = { x, y, w, h, depth: state.buf.depth, data, canvas: blockToCanvas(w, h, state.buf.depth, data) };
}

function blitFloat(buf, f) {
  const bpp = bppOf(buf.depth);
  for (let y = 0; y < f.h; y++) {
    const py = f.y + y;
    if (py < 0 || py >= buf.h) continue;
    for (let x = 0; x < f.w; x++) {
      const px = f.x + x;
      if (px < 0 || px >= buf.w) continue;
      const si = (y * f.w + x) * bpp;
      const di = (py * buf.w + px) * bpp;
      for (let k = 0; k < bpp; k++) buf.data[di + k] = f.data[si + k];
    }
  }
}

async function anchorFloat() {
  const f = state.float;
  const buf = state.buf;
  if (!f || !buf) return;
  const snapshot = buf.data.slice();
  blitFloat(buf, f);
  state.float = null;
  state.sel = clipRect({ x0: f.x, y0: f.y, x1: f.x + f.w - 1, y1: f.y + f.h - 1 }, buf);
  draw();
  renderPaint();
  await commitPixels('trozo pegado', { x0: 0, y0: 0, x1: buf.w - 1, y1: buf.h - 1 }, snapshot);
}

function cancelFloat() {
  if (!state.float) return;
  state.float = null;
  draw();
  renderPaint();
}

function drawFloat(ctx, z) {
  const f = state.float;
  if (!f) return;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(f.canvas, f.x * z, f.y * z, f.w * z, f.h * z);
  ctx.save();
  ctx.strokeStyle = '#a8531f';
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(f.x * z + 0.5, f.y * z + 0.5, f.w * z - 1, f.h * z - 1);
  ctx.restore();
}

function drawSelection(ctx, z) {
  const d = state.drag;
  const r = d && d.tool === 'selectRect' ? d.rect : state.sel;
  if (!r) return;
  ctx.save();
  ctx.strokeStyle = '#a8531f';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(r.x * z + 0.5, r.y * z + 0.5, r.w * z - 1, r.h * z - 1);
  ctx.restore();
}

/* ------------------------------------------------- acciones de selección */

function selectionRect() {
  return state.sel ? { x: state.sel.x, y: state.sel.y, w: state.sel.w, h: state.sel.h } : null;
}

function selExtract() {
  const buf = state.buf;
  const r = state.sel;
  if (!buf || !r) return null;
  const cr = clipRect({ x0: r.x, y0: r.y, x1: r.x + r.w - 1, y1: r.y + r.h - 1 }, buf);
  if (!cr) return null;
  return { w: cr.w, h: cr.h, depth: buf.depth, data: extractRect(buf.data, buf, cr) };
}

function doCopy() {
  const c = selExtract();
  if (!c) return;
  state.clip = c;
  renderPaint();
  toast('Trozo copiado');
}

function doCut() {
  const c = selExtract();
  if (!c) return;
  state.clip = c;
  clearSelectionPixels('trozo cortado');
}

function doDelete() {
  if (!state.sel) return;
  clearSelectionPixels('trozo borrado');
}

function clearSelectionPixels(label) {
  const sel = state.sel;
  if (!sel) return;
  withBufferEdit(label, (buf) => {
    const r = clipRect({ x0: sel.x, y0: sel.y, x1: sel.x + sel.w - 1, y1: sel.y + sel.h - 1 }, buf);
    if (!r) return;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) setPx(buf, x, y, 0);
  });
}

function doPaste() {
  const c = state.clip;
  const buf = state.buf;
  if (!c || !buf) return;
  if (c.depth !== buf.depth) {
    toast('El trozo copiado es de otra profundidad de color', true);
    return;
  }
  const x = state.sel ? state.sel.x : 0;
  const y = state.sel ? state.sel.y : 0;
  setFloat(x, y, c.w, c.h, c.data.slice());
  state.sel = null;
  state.tool = 'select';
  draw();
  renderPaint();
  toast('Trozo pegado: arrástralo y pulsa Intro para fijarlo');
}

function doDuplicate() {
  const c = selExtract();
  if (!c) return;
  state.clip = c;
  setFloat(state.sel.x + 2, state.sel.y + 2, c.w, c.h, c.data.slice());
  state.tool = 'select';
  state.sel = null;
  draw();
  renderPaint();
  toast('Duplicado: arrástralo y pulsa Intro para fijarlo');
}

function doFlip(horizontal) {
  const sel = state.sel;
  if (!sel) return;
  withBufferEdit(horizontal ? 'voltear horizontal' : 'voltear vertical', (buf) => {
    const r = clipRect({ x0: sel.x, y0: sel.y, x1: sel.x + sel.w - 1, y1: sel.y + sel.h - 1 }, buf);
    if (!r) return;
    const bpp = bppOf(buf.depth);
    const tmp = extractRect(buf.data, buf, r);
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const sx = horizontal ? r.w - 1 - x : x;
        const sy = horizontal ? y : r.h - 1 - y;
        const si = (sy * r.w + sx) * bpp;
        const di = ((r.y + y) * buf.w + (r.x + x)) * bpp;
        for (let k = 0; k < bpp; k++) buf.data[di + k] = tmp[si + k];
      }
    }
  });
}

function selectAll() {
  const buf = state.buf;
  if (!buf) return;
  state.sel = { x: 0, y: 0, w: buf.w, h: buf.h };
  state.tool = 'select';
  draw();
  renderPaint();
}

function clearSelection() {
  state.sel = null;
  draw();
  renderPaint();
}

function pickColor(p) {
  const buf = state.buf;
  const v = getPx(buf, p.x, p.y);
  if (buf.depth === 16) {
    state.sel565 = v;
    $('color565').value = value565ToHex(v);
    toast(`Color nativo ${v}`);
  } else {
    state.selColor = v;
    renderPalette();
  }
}

const value565ToHex = (v) => '#' + [
  (((v >> 11) & 31) * 255 / 31) | 0,
  (((v >> 5) & 63) * 255 / 63) | 0,
  ((v & 31) * 255 / 31) | 0,
].map((n) => n.toString(16).padStart(2, '0')).join('');

function hexTo565(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (((n >> 16) & 255) >> 3) << 11 | (((n >> 8) & 255) >> 2) << 5 | ((n & 255) >> 3);
}

/* ----------------------------------------------------- interfaz de pintura */

function setTool(name) {
  if (state.float && name !== 'select') anchorFloat();
  state.tool = name;
  if (name !== 'select') state.sel = null;
  draw();
  renderPaint();
}

function renderPaint() {
  const buf = state.buf;
  const hasBuf = !!buf;
  for (const b of document.querySelectorAll('.tool')) {
    const t = b.dataset.tool;
    b.classList.toggle('on', t === state.tool);
    b.disabled = t !== 'view' && !hasBuf;
  }
  $('brushSize').disabled = !hasBuf;
  $('fillChk').disabled = !hasBuf;
  $('brushSize').value = String(state.brush);
  $('fillChk').checked = state.fillShape;
  const f16 = hasBuf && buf.depth === 16;
  $('color565Wrap').hidden = !f16;
  if (f16) {
    const hex = value565ToHex(state.sel565);
    if ($('color565').value !== hex) $('color565').value = hex;
  }
  $('selActions').hidden = !(hasBuf && state.tool === 'select');
  $('selCopy').disabled = !state.sel;
  $('selCut').disabled = !state.sel;
  $('selPaste').disabled = !state.clip;
  $('selDup').disabled = !state.sel;
  $('selFlipH').disabled = !state.sel;
  $('selFlipV').disabled = !state.sel;
  $('selDel').disabled = !state.sel;
  $('selNone').disabled = !state.sel;
  $('floatActions').hidden = !state.float;

  const cv = $('view');
  cv.classList.toggle('painting', hasBuf && ['pencil', 'brush', 'eraser', 'fill', 'line', 'rect', 'ellipse'].includes(state.tool));
  cv.classList.toggle('selecting', hasBuf && state.tool === 'select');
}

function resetPaintState() {
  state.sel = null;
  state.float = null;
  state.drag = null;
}

/* -------------------------------------------------- puntero del lienzo */

function readout(p) {
  const buf = state.buf;
  if (buf) {
    if (!p || p.x < 0 || p.y < 0 || p.x >= buf.w || p.y >= buf.h) return '—';
    const v = getPx(buf, p.x, p.y);
    if (buf.depth === 16) {
      if (v === 0) return `${p.x}, ${p.y}  ·  0 (transparente)`;
      return `${p.x}, ${p.y}  ·  565 ${v}  ${value565ToHex(v)}`;
    }
    if (v === 0) return `${p.x}, ${p.y}  ·  índice 0 (transparente)`;
    const c = state.palette[v] || [0, 0, 0];
    return `${p.x}, ${p.y}  ·  índice ${v}  ·  ${c[0]},${c[1]},${c[2]}`;
  }
  // Fuentes: se mira el PNG ya convertido.
  const img = state.image;
  if (!img || !state.offData || !p || p.x < 0 || p.y < 0 || p.x >= img.width || p.y >= img.height) return '—';
  const d = state.offData.data;
  const i = (p.y * img.width + p.x) * 4;
  if (d[i + 3] === 0) return `${p.x}, ${p.y}  ·  índice 0 (transparente)`;
  const key = `${d[i]},${d[i + 1]},${d[i + 2]}`;
  const idx = state.indexByRgb.get(key);
  return `${p.x}, ${p.y}  ·  ${key}` + (idx !== undefined ? `  ·  índice ${idx}` : '');
}

async function onCanvasDown(ev) {
  if (ev.button !== 0) return;
  const p = canvasPoint(ev);
  if (!p) return;

  // Colocar un punto de control tiene prioridad sobre cualquier herramienta.
  if (state.pickPoint && (state.kind === 'fpg' || state.kind === 'map')) {
    const buf = state.buf;
    if (!buf || p.x < 0 || p.y < 0 || p.x >= buf.w || p.y >= buf.h) return;
    $('ptX').value = p.x;
    $('ptY').value = p.y;
    await applyPointForm(false);
    return;
  }

  const buf = state.buf;
  if (!buf || state.historyBusy) return;

  // Un trozo flotante pendiente se arrastra hasta que se fija o se descarta.
  if (state.float) {
    if (pointInRect(p, state.float)) {
      beginDrag('moveFloat', p);
      capturePointer(ev);
    }
    return;
  }
  if (p.x < 0 || p.y < 0 || p.x >= buf.w || p.y >= buf.h) return;

  const tool = state.tool;
  if (tool === 'view') return;
  if (tool === 'pick') { pickColor(p); return; }

  if (tool === 'select') {
    if (state.sel && pointInRect(p, state.sel) && liftSelection()) {
      state.drag = { tool: 'moveFloat', start: { ...p }, last: { ...p }, snapshot: null, bbox: null, rect: null };
      capturePointer(ev);
      draw();
      renderPaint();
      return;
    }
    state.drag = { tool: 'selectRect', start: { ...p }, last: { ...p }, snapshot: null, bbox: null, rect: { x: p.x, y: p.y, w: 1, h: 1 } };
    capturePointer(ev);
    draw();
    return;
  }

  if (tool === 'fill') {
    beginDrag('fill', p);
    floodFill(buf, p.x, p.y, paintValue(), touchDrag);
    endDrag('relleno');
    return;
  }

  beginDrag(tool, p);
  capturePointer(ev);
  if (tool === 'pencil' || tool === 'brush' || tool === 'eraser') {
    const size = tool === 'pencil' ? 1 : state.brush;
    stamp(buf, p.x, p.y, tool === 'eraser' ? 0 : paintValue(), size, tool === 'eraser', touchDrag);
    draw();
  } else {
    updateShapePreview(p);
  }
}

function onCanvasMove(ev) {
  const p = canvasPoint(ev);
  $('readout').textContent = readout(p);
  const d = state.drag;
  const buf = state.buf;
  if (!d || !buf) return;

  if (d.tool === 'pencil' || d.tool === 'brush' || d.tool === 'eraser') {
    const size = d.tool === 'pencil' ? 1 : state.brush;
    const erase = d.tool === 'eraser';
    drawLine(buf, d.last.x, d.last.y, p.x, p.y, erase ? 0 : paintValue(), size, erase, touchDrag);
    d.last = { x: p.x, y: p.y };
    draw();
    return;
  }
  if (d.tool === 'line' || d.tool === 'rect' || d.tool === 'ellipse') {
    updateShapePreview(p);
    return;
  }
  if (d.tool === 'selectRect') {
    d.rect = {
      x: Math.min(d.start.x, p.x),
      y: Math.min(d.start.y, p.y),
      w: Math.abs(p.x - d.start.x) + 1,
      h: Math.abs(p.y - d.start.y) + 1,
    };
    draw();
    return;
  }
  if (d.tool === 'moveFloat') {
    state.float.x += p.x - d.last.x;
    state.float.y += p.y - d.last.y;
    d.last = { x: p.x, y: p.y };
    draw();
  }
}

function onCanvasUp(ev) {
  releasePointer(ev);
  const d = state.drag;
  if (!d) return;
  if (d.tool === 'selectRect') {
    state.sel = clipRect({ x0: d.rect.x, y0: d.rect.y, x1: d.rect.x + d.rect.w - 1, y1: d.rect.y + d.rect.h - 1 }, state.buf);
    state.drag = null;
    draw();
    renderPaint();
    return;
  }
  if (d.tool === 'moveFloat') {
    state.drag = null;
    renderPaint();
    return;
  }
  const labels = { pencil: 'lápiz', brush: 'pincel', eraser: 'goma', line: 'línea', rect: 'rectángulo', ellipse: 'elipse' };
  endDrag(labels[d.tool] || 'trazo');
}

function capturePointer(ev) {
  try { $('view').setPointerCapture(ev.pointerId); } catch { /* sin captura */ }
}

function releasePointer(ev) {
  try { $('view').releasePointerCapture(ev.pointerId); } catch { /* sin captura */ }
}

function drawControlPoints(ctx, z) {
  const m = currentMap();
  if (!m || !m.points || !m.points.length || state.kind === 'pal' || state.kind === 'fnt') return;
  ctx.save();
  ctx.textBaseline = 'top';
  ctx.font = `${Math.max(11, Math.floor(z * 0.9))}px ${getComputedStyle(document.body).fontFamily}`;
  for (let i = 0; i < m.points.length; i++) {
    const [x, y] = m.points[i];
    if (x < 0 || y < 0) continue;
    const cx = x * z + z / 2;
    const cy = y * z + z / 2;
    ctx.strokeStyle = i === state.pointIndex ? '#a8531f' : '#ffffff';
    ctx.fillStyle = i === state.pointIndex ? '#a8531f' : 'rgba(33,31,28,.82)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 6, cy);
    ctx.lineTo(cx + 6, cy);
    ctx.moveTo(cx, cy - 6);
    ctx.lineTo(cx, cy + 6);
    ctx.stroke();
    ctx.fillRect(cx + 5, cy + 5, 14 + String(i).length * 7, 14);
    ctx.fillStyle = '#fff';
    ctx.fillText(String(i), cx + 9, cy + 7);
  }
  ctx.restore();
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

/* --------------------------------------------------------------- edición */

function renderEditor() {
  const m = currentMap();
  const canMap = !!m && state.kind === 'fpg';
  const canPoints = !!m && (state.kind === 'fpg' || state.kind === 'map');
  const points = m && m.points ? m.points : [];
  const point = currentPoint();

  $('mapId').disabled = !canMap;
  $('mapName').disabled = !canMap;
  $('mapFile').disabled = !canMap;
  $('mapApply').disabled = !canMap;
  $('mapUp').disabled = !canMap || state.maps.findIndex((x) => x.id === m.id) <= 0;
  $('mapDown').disabled = !canMap || state.maps.findIndex((x) => x.id === m.id) >= state.maps.length - 1;

  $('mapId').value = canMap ? m.id : '';
  $('mapName').value = canMap ? (m.name || '') : '';
  $('mapFile').value = canMap ? (m.filename || '') : '';

  $('ptCount').disabled = !canPoints;
  $('ptIndex').disabled = !canPoints;
  $('ptX').disabled = !canPoints;
  $('ptY').disabled = !canPoints;
  $('ptApply').disabled = !canPoints;
  $('ptUndefined').disabled = !canPoints;
  $('ptPick').disabled = !canPoints;

  $('ptCount').value = canPoints ? points.length : '';
  $('ptIndex').value = canPoints ? state.pointIndex : 0;
  $('ptIndex').max = canPoints && points.length ? String(points.length - 1) : '0';
  $('ptX').value = canPoints ? point[0] : '';
  $('ptY').value = canPoints ? point[1] : '';
  $('ptPick').textContent = state.pickPoint ? 'Cancelar clic' : 'Usar clic';
  $('ptHint').textContent = !canPoints
    ? 'Selecciona un mapa para editar sus puntos de control.'
    : state.pickPoint
      ? 'Haz clic en el lienzo para colocar el punto activo.'
      : 'Puedes escribir X/Y o activar “Usar clic” para colocarlo sobre el sprite.';

  renderPickCursor();
}

async function applyDocSelection(j, selectId, msg) {
  applyDoc(j, {});
  if (selectId !== undefined && selectId !== null && state.maps.some((m) => m.id === selectId)) {
    state.selected = selectId;
    renderMaps();
    renderEditor();
    renderProps();
    renderToolbar();
    loadCanvas();
  }
  if (msg) toast(msg);
}

async function withHistory(entry) {
  if (state.historyBusy) return;
  state.historyBusy = true;
  try {
    await entry.do();
    state.undoStack.push(entry);
    state.redoStack = [];
  } catch (e) {
    // Sin esto la excepción se quedaría en una promesa rechazada y el usuario
    // no vería nada: la edición parecería aplicada sin serlo.
    toast(e.message, true);
  } finally {
    state.historyBusy = false;
    renderToolbar();
  }
}

async function undoAction() {
  const entry = state.undoStack.pop();
  if (!entry || state.historyBusy) return;
  state.historyBusy = true;
  try {
    await entry.undo();
    state.redoStack.push(entry);
    toast(`Deshecho: ${entry.label}`);
  } catch (e) {
    state.undoStack.push(entry);
    toast(e.message, true);
  } finally {
    state.historyBusy = false;
    renderToolbar();
  }
}

async function redoAction() {
  const entry = state.redoStack.pop();
  if (!entry || state.historyBusy) return;
  state.historyBusy = true;
  try {
    await entry.do();
    state.undoStack.push(entry);
    toast(`Rehecho: ${entry.label}`);
  } catch (e) {
    state.redoStack.push(entry);
    toast(e.message, true);
  } finally {
    state.historyBusy = false;
    renderToolbar();
  }
}

async function changeMapMeta(currentId, next, label) {
  const prev = currentMap();
  if (!prev) return;
  const before = { id: prev.id, name: prev.name || '', filename: prev.filename || '' };
  const after = {
    id: next.id ?? before.id,
    name: next.name ?? before.name,
    filename: next.filename ?? before.filename,
  };
  await withHistory({
    label,
    do: async () => {
      const j = await api('/api/map', {
        doc: state.doc,
        id: currentId,
        new_id: after.id,
        name: after.name,
        filename: after.filename,
      }, { method: 'POST' });
      await applyDocSelection(j, after.id, `${label} aplicado`);
    },
    undo: async () => {
      const j = await api('/api/map', {
        doc: state.doc,
        id: after.id,
        new_id: before.id,
        name: before.name,
        filename: before.filename,
      }, { method: 'POST' });
      await applyDocSelection(j, before.id);
    },
  });
}

async function moveSelected(dir) {
  const m = currentMap();
  if (!m) return;
  await withHistory({
    label: dir === 'up' ? 'subir mapa' : 'bajar mapa',
    do: async () => {
      const j = await api('/api/move', { doc: state.doc, id: m.id, dir }, { method: 'POST' });
      await applyDocSelection(j, m.id, dir === 'up' ? 'Mapa subido' : 'Mapa bajado');
    },
    undo: async () => {
      const inv = dir === 'up' ? 'down' : 'up';
      const j = await api('/api/move', { doc: state.doc, id: m.id, dir: inv }, { method: 'POST' });
      await applyDocSelection(j, m.id);
    },
  });
}

async function applyPointsChange(nextCount, nextIndex, nextX, nextY, label) {
  const m = currentMap();
  if (!m) return;

  // El deshacer necesita el vector completo, no solo el punto que se toca: al
  // reducir el número de puntos, los que se recortan desaparecerían para
  // siempre si solo guardásemos el punto activo.
  const before = (m.points || []).map((p) => [p[0], p[1]]);
  const after = before.slice(0, nextCount);
  while (after.length < nextCount) after.push([-1, -1]);
  if (nextCount > 0 && nextIndex >= 0 && nextIndex < nextCount) {
    after[nextIndex] = [nextX, nextY];
  }

  const pointsParams = (list) => {
    const spec = pointsToParam(list);
    // Una lista vacía no se puede expresar con `pts`, así que se usa count=0.
    return spec === '' ? { count: 0 } : { pts: spec };
  };

  await withHistory({
    label,
    do: async () => {
      const j = await api('/api/points', { doc: state.doc, id: m.id, ...pointsParams(after) }, { method: 'POST' });
      state.pointIndex = after.length ? clamp(nextIndex, 0, after.length - 1) : 0;
      await applyDocSelection(j, m.id, `${label} aplicado`);
    },
    undo: async () => {
      const j = await api('/api/points', { doc: state.doc, id: m.id, ...pointsParams(before) }, { method: 'POST' });
      state.pointIndex = before.length ? clamp(state.pointIndex, 0, before.length - 1) : 0;
      await applyDocSelection(j, m.id);
    },
  });
}

async function applyMapForm() {
  const m = currentMap();
  if (!m || state.kind !== 'fpg') return;
  const nextId = +$('mapId').value;
  const nextName = $('mapName').value.trim();
  const nextFile = $('mapFile').value.trim();
  await changeMapMeta(m.id, { id: nextId, name: nextName, filename: nextFile }, 'cambios del mapa');
}

async function applyPointForm(undefinedPoint) {
  const m = currentMap();
  if (!m || !(state.kind === 'fpg' || state.kind === 'map')) return;
  const nextCount = clamp(+$('ptCount').value || 0, 0, 4095);
  const nextIndex = clamp(+$('ptIndex').value || 0, 0, Math.max(0, nextCount - 1));
  const nextX = undefinedPoint ? -1 : (+$('ptX').value || 0);
  const nextY = undefinedPoint ? -1 : (+$('ptY').value || 0);
  await applyPointsChange(nextCount, nextIndex, nextX, nextY, undefinedPoint ? 'punto indefinido' : 'punto de control');
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

/* -------------------------------------------------- barra y estado */

function renderToolbar() {
  const j = state.info;

  const has = !!j;
  $('btnSave').disabled = !has;
  $('btnSaveAs').disabled = !has;
  $('btnExport').disabled = !(has && (j.kind === 'fpg' || j.kind === 'map'));
  $('btnImport').disabled = !(has && j.kind === 'fpg' && j.depth === 8);
  $('btnUndo').disabled = !state.undoStack.length || state.historyBusy;
  $('btnRedo').disabled = !state.redoStack.length || state.historyBusy;

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

  renderStatus();
}

function renderStatus() {
  const j = state.info;
  $('docKind').textContent = !j
    ? 'sin fichero'
    : j.kind === 'fpg' ? `FPG ${j.depth} bits` : KINDS[j.kind] || j.kind;

  const m = state.maps.find((x) => x.id === state.selected);
  if (!m) {
    $('statusSel').textContent = '—';
  } else {
    const nombre = m.name ? ` «${m.name}»` : '';
    $('statusSel').textContent = state.kind === 'fnt'
      ? `carácter ${m.id} · ${m.width}×${m.height}`
      : `mapa ${m.id}${nombre} · ${m.width}×${m.height}`;
  }

  $('statusDirty').textContent = state.dirty
    ? '● sin guardar'
    : state.dropped ? 'copia temporal · Guardar como…' : '';

  const nombreFichero = j ? j.path : '';
  $('pathInput').title = nombreFichero;
}

/** El lienzo deja claro cuándo el clic coloca un punto de control. */
function renderPickCursor() {
  $('view').classList.toggle('picking', !!state.pickPoint);
}

/* --------------------------------------------------------------- acciones */

async function saveDoc(target) {
  if (!state.doc) return;
  // Una copia llegada por arrastre vive en una carpeta temporal: guardarla ahí
  // en silencio sería engañoso, así que el primer guardado pide destino.
  if (!target && state.dropped) { saveAsDialog(); return; }
  try {
    const j = await api('/api/save', { doc: state.doc, path: target || null }, { method: 'POST' });
    // Basta con refrescar los datos en pantalla: el servidor ya tiene el
    // documento actualizado y reabrirlo dejaría huérfano el anterior.
    state.info.path = j.path;
    state.info.name = j.path.split(/[\\/]/).pop() || '';
    state.info.size = j.bytes;
    state.info.gzip = j.gzip;
    state.dirty = false;
    state.dropped = false;
    $('pathInput').value = j.path;
    renderProps();
    renderToolbar();
    toast(`Guardado ${j.path} (${fmtSize(j.bytes)})`);
  } catch (e) {
    toast(e.message, true);
  }
}

function exportDialog() {
  if (!state.doc) return;
  const m = state.maps.find((x) => x.id === state.selected);
  const tag = m ? String(m.id).padStart(4, '0') : 'mapa';
  openDialog({
    mode: 'export',
    title: 'Exportar mapa',
    confirm: 'Exportar',
    exts: EXT_IMAGES,
    path: `${currentDir()}\\mapa_${tag}.png`,
    placeholder: 'Fichero de salida (.png .bmp .pcx .jpg)',
    onPick: exportTo,
  });
}

async function exportTo(out) {
  const fmt = (out.split('.').pop() || 'png').toLowerCase();
  try {
    const j = await api('/api/export', { doc: state.doc, id: state.selected, path: out, format: fmt }, { method: 'POST' });
    toast(`Exportado ${j.path}`);
  } catch (e) {
    toast(e.message, true);
  }
}

function importDialog() {
  if (!state.doc) return;
  openDialog({
    mode: 'import',
    title: 'Importar imagen',
    confirm: 'Importar',
    exts: EXT_IMAGES,
    path: `${currentDir()}\\`,
    placeholder: 'Imagen (.png .bmp .pcx .jpg)',
    extra: { label: 'Id del nuevo mapa', value: '' },
    onPick: importFrom,
  });
}

async function importFrom(p, idTxt) {
  try {
    const j = await api('/api/import', { doc: state.doc, path: p, id: idTxt || null }, { method: 'POST' });
    // El mapa recién importado solo existe en memoria: si recargásemos el
    // fichero desde disco desaparecería. La respuesta ya trae el FPG entero.
    applyDoc(j, {});
    selectMap(j.new_id);
    state.dirty = true;
    renderToolbar();
    toast(`Importado como mapa ${j.new_id} (sin guardar)`);
  } catch (e) {
    toast(e.message, true);
  }
}

function newFpgDialog() {
  openDialog({
    mode: 'new',
    title: 'Nuevo FPG',
    confirm: 'Crear',
    exts: ['.fpg'],
    path: `${state.dir || state.home}\\NUEVO.FPG`,
    onPick: newFpg,
  });
}

async function newFpg(p) {
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

/** Posición del puntero en píxeles de imagen, compensando el zoom y el
    reescalado que el CSS aplica cuando la ventana no da para tanto. */
function canvasPoint(ev) {
  const cv = $('view');
  const r = cv.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return {
    x: Math.floor((((ev.clientX - r.left) * cv.width) / r.width) / state.zoom),
    y: Math.floor((((ev.clientY - r.top) * cv.height) / r.height) / state.zoom),
  };
}

function redraw() {
  if (state.kind === 'pal') drawPaletteCanvas();
  else draw();
}

function selectPane(name) {
  state.pane = name;
  for (const b of document.querySelectorAll('.tab')) {
    b.classList.toggle('on', b.dataset.pane === name);
  }
  for (const p of document.querySelectorAll('.pane')) {
    p.classList.toggle('on', p.dataset.pane === name);
  }
}

function toggleInspector() {
  state.inspectorOpen = !state.inspectorOpen;
  document.body.classList.toggle('no-inspector', !state.inspectorOpen);
  $('btnPanel').textContent = state.inspectorOpen ? 'Inspector ▸' : '◂ Inspector';
}

const ZOOMS = [1, 2, 3, 4, 6, 8];

function stepZoom(delta) {
  const next = ZOOMS[clamp(ZOOMS.indexOf(state.zoom) + delta, 0, ZOOMS.length - 1)];
  if (next === state.zoom) return;
  state.zoom = next;
  $('zoomSel').value = String(next);
  redraw();
}

function stepSelection(delta) {
  if (!state.maps.length) return;
  const i = clamp(state.maps.findIndex((m) => m.id === state.selected) + delta, 0, state.maps.length - 1);
  selectMap(state.maps[i].id);
  const li = $('mapList').children[i];
  if (li) li.scrollIntoView({ block: 'nearest' });
}

function openFileDialog() {
  openDialog({
    mode: 'open',
    title: 'Abrir fichero',
    confirm: 'Abrir',
    exts: SUPPORTED,
    onPick: openPath,
  });
}

function saveAsDialog() {
  if (!state.doc) return;
  openDialog({
    mode: 'save',
    title: 'Guardar como',
    confirm: 'Guardar',
    exts: [extOf(state.kind)],
    path: state.info.path,
    onPick: (p) => saveDoc(p),
  });
}

/** Atajos de teclado. Se ignoran mientras se escribe en un campo. */
function onKey(ev) {
  const tag = (ev.target.tagName || '').toLowerCase();
  const escribiendo = tag === 'input' || tag === 'select' || tag === 'textarea';

  if (ev.key === 'Escape') {
    if (!$('modal').hidden) { closeDialog(); return; }
    if (state.float) { cancelFloat(); return; }
    if (state.sel) { clearSelection(); return; }
    if (state.pickPoint) { state.pickPoint = false; renderEditor(); }
    return;
  }

  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey) {
    const k = ev.key.toLowerCase();
    if (k === 's') { ev.preventDefault(); ev.shiftKey ? saveAsDialog() : saveDoc(null); return; }
    if (k === 'o') { ev.preventDefault(); openFileDialog(); return; }
    if (k === 'n') { ev.preventDefault(); newFpgDialog(); return; }
    if (k === 'z') { ev.preventDefault(); ev.shiftKey ? redoAction() : undoAction(); return; }
    if (k === 'y') { ev.preventDefault(); redoAction(); return; }
    if (!escribiendo && k === 'c') { if (state.sel) { ev.preventDefault(); doCopy(); } return; }
    if (!escribiendo && k === 'x') { if (state.sel) { ev.preventDefault(); doCut(); } return; }
    if (!escribiendo && k === 'v') { if (state.clip) { ev.preventDefault(); doPaste(); } return; }
    if (!escribiendo && k === 'd') { if (state.sel) { ev.preventDefault(); doDuplicate(); } return; }
    if (!escribiendo && k === 'a') { if (state.buf) { ev.preventDefault(); selectAll(); } return; }
    return;
  }

  if (escribiendo) return;

  if (state.buf && $('modal').hidden) {
    const tools = { v: 'view', p: 'pencil', b: 'brush', e: 'eraser', f: 'fill', i: 'pick', l: 'line', r: 'rect', o: 'ellipse', s: 'select' };
    const t = tools[ev.key.toLowerCase()];
    if (t) { setTool(t); return; }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (state.sel) { ev.preventDefault(); doDelete(); }
      return;
    }
    if (ev.key === 'Enter') {
      if (state.float) { ev.preventDefault(); anchorFloat(); }
      return;
    }
  }

  if (ev.key === '+' || ev.key === '=') { stepZoom(1); return; }
  if (ev.key === '-' || ev.key === '_') { stepZoom(-1); return; }
  if (ev.key.toLowerCase() === 'g') {
    $('gridChk').checked = !$('gridChk').checked;
    $('gridChk').onchange();
    return;
  }
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') { stepSelection(1); return; }
  if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') { stepSelection(-1); }
}

function wire() {
  $('btnOpen').onclick = () => {
    const p = $('pathInput').value.trim();
    if (p) openPath(p);
    else openFileDialog();
  };
  $('pathInput').onkeydown = (e) => {
    if (e.key === 'Enter') $('btnOpen').click();
  };

  $('btnBrowse').onclick = openFileDialog;
  $('btnNew').onclick = newFpgDialog;
  $('btnSave').onclick = () => saveDoc(null);
  $('btnSaveAs').onclick = saveAsDialog;
  $('btnUndo').onclick = undoAction;
  $('btnRedo').onclick = redoAction;
  $('btnExport').onclick = exportDialog;
  $('btnImport').onclick = importDialog;
  $('btnPanel').onclick = toggleInspector;

  $('tabs').onclick = (e) => {
    const b = e.target.closest('.tab');
    if (b) selectPane(b.dataset.pane);
  };

  $('modalClose').onclick = closeDialog;
  $('mUp').onclick = () => dialogGo(dialog.parent === null ? '' : dialog.parent);
  $('mOk').onclick = confirmDialog;
  $('mPath2').onkeydown = (e) => { if (e.key === 'Enter') confirmDialog(); };
  $('mExtra').onkeydown = (e) => { if (e.key === 'Enter') confirmDialog(); };
  $('modal').onclick = (e) => {
    if (e.target === $('modal')) closeDialog();
  };
  document.onkeydown = onKey;

  // Arrastrar un recurso desde el explorador y soltarlo en cualquier punto de
  // la ventana. Se cuenta la profundidad porque `dragleave` salta al cruzar
  // cada elemento hijo, y el resaltado no debe parpadear.
  let dragDepth = 0;
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    stop(e);
    dragDepth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) stop(e); });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    stop(e);
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    stop(e);
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const file = e.dataTransfer.files[0];
    if (file) dropFile(file);
  });

  $('mapApply').onclick = applyMapForm;
  $('mapUp').onclick = () => moveSelected('up');
  $('mapDown').onclick = () => moveSelected('down');
  $('ptApply').onclick = () => applyPointForm(false);
  $('ptUndefined').onclick = () => applyPointForm(true);
  $('ptPick').onclick = () => {
    state.pickPoint = !state.pickPoint;
    renderEditor();
  };
  $('ptIndex').oninput = () => {
    const m = currentMap();
    const max = m && m.points && m.points.length ? m.points.length - 1 : 0;
    state.pointIndex = clamp(+$('ptIndex').value || 0, 0, Math.max(0, max));
    renderEditor();
    draw();
  };
  $('ptCount').oninput = () => {
    const nextCount = clamp(+$('ptCount').value || 0, 0, 4095);
    $('ptIndex').max = nextCount ? String(nextCount - 1) : '0';
    if (nextCount === 0) state.pointIndex = 0;
    else state.pointIndex = clamp(state.pointIndex, 0, nextCount - 1);
    $('ptIndex').value = state.pointIndex;
  };

  $('zoomSel').onchange = () => {
    state.zoom = +$('zoomSel').value;
    redraw();
  };
  $('frameSel').onchange = () => {
    state.frame = +$('frameSel').value;
    loadCanvas();
  };
  $('gridChk').onchange = () => {
    state.grid = $('gridChk').checked;
    redraw();
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

  // --- editor de pintura ---
  document.querySelectorAll('.tool').forEach((b) => {
    b.onclick = () => setTool(b.dataset.tool);
  });
  $('brushSize').oninput = () => {
    state.brush = clamp(+$('brushSize').value || 1, 1, 16);
  };
  $('fillChk').onchange = () => { state.fillShape = $('fillChk').checked; };
  $('color565').oninput = () => { state.sel565 = hexTo565($('color565').value); };
  $('selCopy').onclick = doCopy;
  $('selCut').onclick = doCut;
  $('selPaste').onclick = doPaste;
  $('selDup').onclick = doDuplicate;
  $('selFlipH').onclick = () => doFlip(true);
  $('selFlipV').onclick = () => doFlip(false);
  $('selDel').onclick = doDelete;
  $('selNone').onclick = clearSelection;
  $('floatOk').onclick = anchorFloat;
  $('floatCancel').onclick = cancelFloat;

  const cv = $('view');
  cv.addEventListener('pointerdown', onCanvasDown);
  cv.addEventListener('pointermove', onCanvasMove);
  cv.addEventListener('pointerup', onCanvasUp);
  cv.addEventListener('pointercancel', onCanvasUp);
  cv.addEventListener('pointerleave', () => {
    if (!state.drag) $('readout').textContent = '—';
  });
}

async function boot() {
  wire();
  selectPane(state.pane);
  try {
    const st = await api('/api/state');
    state.home = st.home;
  } catch (e) {
    toast('No he podido hablar con el servidor: ' + e.message, true);
  }
  renderToolbar();
  renderPaint();
}

boot();
