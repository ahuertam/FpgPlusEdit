/* FPG+ Edit — editor de recursos gráficos de DIV Games Studio 2.
   Interfaz sin dependencias. No habla directamente con nadie: todo pasa por
   `Backend` (backend.js), que decide si las peticiones las atiende el servidor
   local o el núcleo WebAssembly. Aquí no hace falta saber cuál de los dos es,
   salvo en los pocos sitios donde la versión web no puede hacer lo mismo (no
   hay carpetas que listar), y esos van marcados con `enWeb()`. */

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
  pendingEdit: null,  // última edición en curso, para esperarla antes de cambiar de documento

  // Editor de pintura
  tool: 'view',       // herramienta activa
  brush: 1,           // grosor del pincel y la goma
  brushShape: 'round',// forma de la punta: redonda o cuadrada
  fillShape: false,   // rectángulos y elipses rellenos
  dither: false,      // barra de punteado: los trazos van a cuadros
  text: 'TEXTO',      // texto que estampa la herramienta de texto
  textSize: 14,       // cuerpo del texto, en píxeles
  brushFpg: 0,        // mapa de BRUSH.FPG elegido como punta; 0 = la punta de siempre
  brushImg: null,     // píxeles de esa punta, ya traídos del núcleo
  texMap: 0,          // mapa del documento usado como textura; 0 = ninguna
  texImg: null,       // píxeles de esa textura
  texTile: null,      // esa textura ya convertida a lienzo, para verla repetida
  texPaint: false,    // pintar con la textura (U)
  texView: false,     // enseñar la textura sobre el lienzo (X)
  sel565: 0xffcc00,   // colores nativos, cuando se edita un FPG de 16 bits
  buf: null,          // búfer local de píxeles del mapa activo
  off: null,          // lienzo fuera de pantalla con el búfer ya en RGBA
  clip: null,         // portapapeles de trozos (persiste entre mapas)
  sel: null,          // rectángulo de selección, en coordenadas de imagen
  float: null,        // trozo flotante a la espera de anclarse
  drag: null,         // gesto en curso
  path: null,         // trazo en curso de multilínea, bézier o multicurva
  airTimer: null,     // temporizador del aerógrafo, mientras se mantiene pulsado
  layers: null,       // capas de edición; null = mapa de una sola capa
  layer: 0,           // índice de la capa activa
};

/* ------------------------------------------------------------------ apoyo */

/** Una llamada al editor. Devuelve el JSON ya comprobado, o lanza el error. */
const api = (path, params, opts) => Backend.api(path, params, opts);

/** `true` cuando no hay servidor detrás y todo lo resuelve el navegador. */
const enWeb = () => Backend.mode === 'web';

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

/** Índice del punto de control que queda bajo el cursor, o -1 si no hay
    ninguno cerca. El margen se mide en píxeles de pantalla, de modo que vale
    lo mismo con cualquier aumento. */
function controlPointAt(p) {
  const m = currentMap();
  if (!m || !m.points) return -1;
  const z = state.zoom;
  let mejor = -1;
  let margen = 7;
  for (let i = 0; i < m.points.length; i++) {
    const [x, y] = m.points[i];
    if (x < 0 || y < 0) continue;
    const d = Math.hypot((x - p.x) * z, (y - p.y) * z);
    if (d <= margen) { margen = d; mejor = i; }
  }
  return mejor;
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

/* La versión web no tiene carpetas que listar: el fichero lo elige el propio
   navegador. Estas dos ayudas envuelven sus selectores y devuelven lo mismo que
   el diálogo de arriba, un nombre de fichero, para que las funciones de abrir y
   guardar no tengan que enterarse de dónde ha salido. */

/** Nombre del fichero elegido para abrir, ya «a la vista» del núcleo. */
async function elegirOrigen(exts, title, readOnly) {
  try {
    return await Backend.pickOpen({ exts, title, readOnly });
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

/** Destino elegido para guardar; con él se llama a `then`. */
async function elegirDestino(name, exts, title, then) {
  let chosen = null;
  try {
    chosen = await Backend.pickSave({ name, exts, title });
  } catch (e) {
    toast(e.message, true);
    return;
  }
  if (chosen) await then(withExt(chosen, exts));
}

/** Los selectores del navegador no siempre añaden la extensión: si el usuario
    escribe el nombre sin ella, se pone aquí, para que el fichero se reconozca. */
function withExt(name, exts) {
  const low = name.toLowerCase();
  return exts.some((x) => low.endsWith(x)) ? name : name + (exts[0] || '');
}

/** Extensión propia de un tipo de documento, para el filtro del diálogo. */
const extOf = (kind) => ({ fpg: '.fpg', map: '.map', pal: '.pal', fnt: '.fnt' })[kind] || '';

/** Carpeta del fichero abierto, o el último directorio visitado. */
function currentDir() {
  if (state.info && state.info.path) return state.info.path.replace(/[\\/][^\\/]*$/, '');
  return state.dir || state.home || '';
}

/* --------------------------------------------------------------- apertura */

/** Espera a que cuaje la última edición lanzada, si aún está en el aire. */
async function waitEdits() {
  while (state.pendingEdit) {
    const p = state.pendingEdit;
    state.pendingEdit = null;
    await p;
  }
}

async function openPath(p) {
  await waitEdits();
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
    await waitEdits();
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

  // La textura es un mapa del documento que se está editando: al cambiar de
  // fichero, la copia que había ya no vale. La punta de BRUSH.FPG, en cambio,
  // es de otro fichero y se conserva.
  if (state.doc !== j.doc) {
    state.texMap = 0;
    state.texImg = null;
    state.texTile = null;
  }

  if (reset) {
    state.undoStack = [];
    state.redoStack = [];
    state.pickPoint = false;
    // Un documento nuevo arranca siempre desde su primer mapa y su primer
    // fotograma. Si aquí quedase el fotograma del recurso anterior, al crear un
    // MAP nuevo podría intentarse cargar un índice que ya no existe.
    state.selected = null;
    state.frame = 0;
    state.dirty = false;
  }

  state.doc = j.doc;
  state.kind = j.kind;
  state.info = j;
  state.dropped = !!j.dropped;
  state.palette = j.palette || [];
  state.maps = [];

  // Los PNG de las miniaturas anteriores ya no valen: puede ser otro documento
  // o el mismo con la paleta retocada, y en la versión web son URLs de objeto
  // que hay que soltar. A partir de aquí se vuelven a pedir al núcleo.
  releaseThumbs();
  releaseMural();

  if (j.kind === 'fnt') {
    state.maps = (j.glyphs || [])
      .filter((g) => g.w > 0 && g.h > 0)
      .map((g) => ({
        id: g.ch,
        name: labelGlyph(g.ch),
        width: g.w,
        height: g.h,
        frames: 1,
      }));
  } else if (j.maps) {
    state.maps = j.maps.map((m) => ({ ...m }));
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
  loadCanvas();
}

function labelGlyph(ch) {
  const c = String.fromCharCode(ch);
  const printable = ch >= 32 && ch < 127 ? `«${c}»` : '(control)';
  return `${ch} ${printable}`;
}

/* ------------------------------------------------------------- lista mapas */

/* Las miniaturas de la tira de mapas (y el glifo del lienzo) son las únicas
   imágenes que pide la interfaz. En la versión local el navegador las cachea
   por URL; en la web cada una es un PNG que devuelve el núcleo y que hay que
   envolver en una URL de objeto, que alguien tiene que soltar. De eso se
   encarga esta caché: se pide una vez por documento y mapa, y se suelta cuando
   el PNG que representaba deja de ser válido (otro documento, un cambio de
   paleta, píxeles editados). */

const thumbCache = new Map(); // «doc:id» → URL

/** Clave de la miniatura de un mapa o glifo. */
const thumbKey = (doc, id) => `${doc}:${id}`;

/** Suelta la URL de una miniatura para que se vuelva a pedir. */
function releaseThumb(doc, id) {
  const key = thumbKey(doc, id);
  const url = thumbCache.get(key);
  if (!url) return;
  URL.revokeObjectURL(url);
  thumbCache.delete(key);
}

/** Suelta todas: el documento o su aspecto han cambiado de golpe. */
function releaseThumbs() {
  for (const url of thumbCache.values()) URL.revokeObjectURL(url);
  thumbCache.clear();
}

/* La vista previa del mural es otra imagen que en la web vive en una URL de
   objeto. Solo se pide cuando el usuario pulsa «Ver tapiz», pero se suelta en
   cuanto el documento cambia, que es cuando esa previsualización deja de valer. */
let muralUrl = null;

function releaseMural() {
  const img = $('muralImg');
  if (img) img.removeAttribute('src');
  const box = $('muralPreview');
  if (box) box.classList.remove('has-mural');
  if (muralUrl) {
    URL.revokeObjectURL(muralUrl);
    muralUrl = null;
  }
}

/** Dirección de la miniatura, pidiéndola al núcleo solo la primera vez. */
async function thumbUrl(doc, id) {
  const key = thumbKey(doc, id);
  const cached = thumbCache.get(key);
  if (cached) return cached;
  const url = state.kind === 'fnt'
    ? await Backend.imageUrl('/api/glyph', { doc, ch: id })
    : await Backend.imageUrl('/api/image', { doc, id });
  if (url) thumbCache.set(key, url);
  return url;
}

/** Pinta la miniatura cuando llega. Si para entonces ya se está viendo otro
    documento, o la tira de mapas se ha vuelto a dibujar, se descarta. */
async function fillThumb(img, id) {
  const doc = state.doc;
  let url = '';
  try {
    url = await thumbUrl(doc, id);
  } catch {
    return;
  }
  if (!url || state.doc !== doc || !img.isConnected) return;
  img.src = url;
}

function renderMaps() {
  const list = $('mapList');
  list.innerHTML = '';
  $('mapsCount').textContent = state.maps.length ? `(${state.maps.length})` : '';

  for (const m of state.maps) {
    const li = document.createElement('li');
    if (m.id === state.selected) li.classList.add('sel');

    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    fillThumb(img, m.id);

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
  // La lista de texturas sigue a la de mapas: si se añade, se borra o se
  // renombra uno, aquí tiene que enterarse.
  renderBrush();
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
  // Cada recarga del lienzo (otro fotograma, otro mapa, otro id) deja atrás las
  // capas, la selección y el trozo flotante: todo eso pertenece a la imagen que
  // salía antes, no a la que viene ahora.
  resetPaintState();
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
    // El mismo glifo que enseña su miniatura en la tira, así que se aprovecha
    // la URL que ya esté pedida.
    const url = await thumbUrl(state.doc, state.selected ?? 0);
    state.image = url ? await loadImageEl(url) : null;
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
    drawTexture(ctx, buf.w, buf.h, z);
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

/** Superficie sobre la que actúan los gestos: la capa activa, o el mapa entero. */
function activeBuf() {
  const buf = state.buf;
  if (!buf) return null;
  if (!state.layers) return buf;
  return { w: buf.w, h: buf.h, depth: buf.depth, bpp: buf.bpp, data: state.layers[state.layer].data };
}

/** Mezcla las capas visibles en `state.buf.data`, que es lo que se ve y se guarda.
    El valor 0 es transparente, así que una capa nunca tapa lo de abajo con él. */
function composite() {
  const buf = state.buf;
  if (!buf || !state.layers) return;
  const bpp = bppOf(buf.depth);
  buf.data.fill(0);
  for (const l of state.layers) {
    if (!l.visible) continue;
    const d = l.data;
    for (let i = 0; i < buf.w * buf.h; i++) {
      const o = i * bpp;
      let empty = true;
      for (let k = 0; k < bpp; k++) if (d[o + k]) { empty = false; break; }
      if (empty) continue;
      for (let k = 0; k < bpp; k++) buf.data[o + k] = d[o + k];
    }
  }
}

/** Copia de las capas, para poder deshacer. `null` si se edita un mapa liso. */
function layersSnapshot() {
  return state.layers
    ? state.layers.map((l) => ({ name: l.name, visible: l.visible, data: l.data.slice() }))
    : null;
}

function restoreLayers(snap) {
  if (!snap) return;
  state.layers = snap.map((l) => ({ name: l.name, visible: l.visible, data: l.data.slice() }));
  state.layer = clamp(state.layer, 0, state.layers.length - 1);
}

/** Actualiza el lienzo fuera de pantalla del búfer activo. */
function renderBuf() {
  const buf = state.buf;
  if (!buf) return;
  if (state.layers) composite();
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

/* ---------------------------------------------------- pinceles y texturas */

/* `SYSTEM\BRUSH.FPG` guarda las puntas del taller original, casi todas de
   varios colores y con un dibujo propio. Se abre como un documento aparte, de
   modo que no estorba al que se está editando, y solo se piden sus píxeles
   cuando se elige una punta. */
let brushLib = null;   // { doc, maps, palette, depth }

/** Trae los píxeles de un mapa, para usarlo de punta o de textura. */
async function readMapImage(doc, meta, depth) {
  const bpp = bppOf(depth);
  const raw = await Backend.raw('/api/pixels', { doc, id: meta.id, frame: 0 });
  const need = Math.max(0, meta.width) * Math.max(0, meta.height) * bpp;
  const data = new Uint8Array(need);
  data.set(raw.subarray(0, Math.min(need, raw.length)));
  return { w: meta.width, h: meta.height, depth, data };
}

/** Color (0-255 por canal) de un valor, según la profundidad y la paleta. */
function colorOfValue(v, depth, palette) {
  if (depth === 16) {
    return [
      (((v >> 11) & 31) * 255 / 31) | 0,
      (((v >> 5) & 63) * 255 / 63) | 0,
      ((v & 31) * 255 / 31) | 0,
    ];
  }
  const c = (palette && palette[v]) || [0, 0, 0];
  return [to8(c[0]), to8(c[1]), to8(c[2])];
}

/** Pasa un valor de una imagen a la profundidad y la paleta del mapa que se
    está editando. Devuelve 0 si el original era transparente. */
function valueForTarget(v, srcDepth, srcPalette, buf) {
  if (!v) return 0;
  if (srcDepth === buf.depth) {
    // Mismo formato y misma paleta: el valor vale tal cual.
    if (buf.depth === 16 || srcPalette === state.palette) return v;
  }
  const [r, g, b] = colorOfValue(v, srcDepth, srcPalette);
  return buf.depth === 16 ? encode565(r, g, b) : nearestIndex(r, g, b);
}

/** Valor con el que se pinta en (px, py): el de siempre, o el que marque la
    textura. Devuelve null donde la textura es transparente, para que el trazo
    salga calado en vez de con agujeros negros. */
function texValue(px, py, v) {
  const t = state.texImg;
  // Borrar no se texturiza: el valor 0 es «nada», y ahí no hay color que sacar.
  if (!t || !state.texPaint || !v) return v;
  const sx = ((px % t.w) + t.w) % t.w;
  const sy = ((py % t.h) + t.h) % t.h;
  const v2 = getPx(t, sx, sy);
  return v2 === 0 ? null : v2;
}

/** Sella una punta cargada de BRUSH.FPG: cada píxel lleva su color y los
    transparentes no pintan nada. */
function stampBitmap(buf, cx, cy, touch) {
  const bmp = state.brushImg;
  const ox = Math.floor((bmp.w - 1) / 2);
  const oy = Math.floor((bmp.h - 1) / 2);
  for (let by = 0; by < bmp.h; by++) {
    const py = cy - oy + by;
    if (py < 0 || py >= buf.h) continue;
    for (let bx = 0; bx < bmp.w; bx++) {
      const px = cx - ox + bx;
      if (px < 0 || px >= buf.w) continue;
      const v = valueForTarget(getPx(bmp, bx, by), bmp.depth, brushLib && brushLib.palette, buf);
      if (!v) continue;
      if (state.dither && ((px + py) & 1)) continue;
      setPx(buf, px, py, v);
      if (touch) touch(px, py);
    }
  }
}

/** Pinta un píxel de un trazo, aplicando la textura si toca. `false` si la
    textura era transparente en ese punto y no hay que pintar. */
function paintPx(buf, px, py, v, touch) {
  const pv = texValue(px, py, v);
  if (pv === null) return false;
  setPx(buf, px, py, pv);
  if (touch) touch(px, py);
  return true;
}

/* -------------------------------------------- puntas y estampas: interfaz */

/** Abre BRUSH.FPG. En la web lo elige el navegador; en local, el diálogo. */
function openBrushLib() {
  if (enWeb()) {
    elegirOrigen(['.fpg'], 'Abrir BRUSH.FPG').then((name) => { if (name) loadBrushLib(name); });
    return;
  }
  openDialog({
    mode: 'open',
    title: 'Abrir BRUSH.FPG (puntas del taller)',
    confirm: 'Abrir',
    exts: ['.fpg'],
    onPick: loadBrushLib,
  });
}

/** Deja BRUSH.FPG abierto como documento aparte, solo para sacarle las puntas.
    Así el fichero que se está editando no se toca. */
async function loadBrushLib(path) {
  let j;
  try {
    j = await api('/api/open', { path });
  } catch (e) {
    toast(e.message, true);
    return;
  }
  if (j.kind !== 'fpg') {
    closeDoc(j.doc);
    toast('Las puntas del taller vienen en un FPG (BRUSH.FPG)', true);
    return;
  }
  if (brushLib) closeDoc(brushLib.doc);
  brushLib = { doc: j.doc, maps: j.maps, palette: j.palette, depth: j.depth, name: j.name };
  state.brushFpg = 0;
  state.brushImg = null;
  $('brushLibSel').dataset.sig = '';
  renderBrush();
  toast(`Puntas de «${j.name}» · elige una en la lista`);
}

/** Elige la punta activa y trae sus píxeles, que son los que se sellarán. */
async function chooseBrushPunta(id) {
  state.brushFpg = Number(id) || 0;
  state.brushImg = null;
  const meta = brushLib && brushLib.maps.find((m) => m.id === state.brushFpg);
  if (meta) {
    try {
      state.brushImg = await readMapImage(brushLib.doc, meta, brushLib.depth);
    } catch (e) {
      toast(e.message, true);
      state.brushFpg = 0;
    }
  }
  renderBrush();
}

/** Elige el mapa que hace de textura. Se copia tal como esté ahora: retocarlo
    después no cambia lo que ya se haya dado con él. */
async function chooseTex(id) {
  state.texMap = Number(id) || 0;
  state.texImg = null;
  state.texTile = null;
  const m = state.maps.find((x) => x.id === state.texMap);
  if (m && state.buf) {
    try {
      if (m.id === state.selected) {
        // El mapa que se está editando ya está aquí; no hay que ir a buscarlo.
        const b = state.buf;
        state.texImg = { w: b.w, h: b.h, depth: b.depth, data: b.data.slice() };
      } else {
        state.texImg = await readMapImage(state.doc, m, state.info.depth);
      }
      state.texTile = blockToCanvas(state.texImg.w, state.texImg.h, state.texImg.depth, state.texImg.data);
    } catch (e) {
      toast(e.message, true);
      state.texMap = 0;
    }
  }
  draw();
  renderBrush();
}

/** Refresca la barra de puntas y textura. */
function renderBrush() {
  const bar = $('brushbar');
  if (!bar) return;
  const hasBuf = !!state.buf;
  bar.hidden = !hasBuf;
  if (!hasBuf) return;

  const lib = $('brushLibSel');
  const puntas = brushLib ? brushLib.maps : [];
  const lsig = puntas.map((m) => m.id).join(',');
  if (lib.dataset.sig !== lsig) {
    const prev = state.brushFpg;
    lib.innerHTML = '';
    lib.append(new Option('Normal (grosor)', '0'));
    for (const m of puntas) lib.append(new Option(`${m.id} · ${m.name || 'mapa'}`, String(m.id)));
    lib.dataset.sig = lsig;
    lib.value = String(prev);
  }

  const tex = $('texSel');
  const tsig = state.maps.map((m) => m.id).join(',');
  if (tex.dataset.sig !== tsig) {
    const prev = state.texMap;
    tex.innerHTML = '';
    tex.append(new Option('Ninguna', '0'));
    for (const m of state.maps) {
      tex.append(new Option(`${m.id} · ${m.name || 'mapa'} (${m.width}×${m.height})`, String(m.id)));
    }
    tex.dataset.sig = tsig;
    tex.value = String(prev);
  }

  lib.value = String(state.brushFpg);
  tex.value = String(state.texMap);
  lib.disabled = !puntas.length;
  tex.disabled = !state.maps.length;
  $('texPaintChk').checked = state.texPaint;
  $('texViewChk').checked = state.texView;
  $('brushLibBtn').textContent = brushLib ? 'Cambiar BRUSH.FPG…' : 'Abrir BRUSH.FPG…';
  $('brushHint').textContent = state.brushImg
    ? 'La punta manda sobre el grosor.'
    : brushLib
      ? `${puntas.length} puntas de «${brushLib.name}»`
      : 'Abre SYSTEM\\BRUSH.FPG para pintar con sus puntas.';
}

/** Repite la textura sobre el lienzo para imaginar la estampa (X). */
function drawTexture(ctx, w, h, z) {
  const tile = state.texTile;
  if (!tile || !state.texView) return;
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.setTransform(z, 0, 0, z, 0, 0);
  ctx.fillStyle = ctx.createPattern(tile, 'repeat');
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** Sella la punta del pincel, de `size` píxeles, centrada en (x, y).
    Con la barra de punteado activa solo se marca uno de cada dos píxeles, en
    damero, que es como se hacen las medias tintas en 8 bits. */
function stamp(buf, x, y, v, size, erase, touch) {
  // Una punta traída de BRUSH.FPG trae su forma y sus colores: manda ella, y
  // el grosor del pincel se deja a un lado. Al borrar se sigue usando la punta
  // de siempre, que es la que sabe vaciar.
  if (state.brushImg && !erase) { stampBitmap(buf, x, y, touch); return; }
  const half = Math.floor((size - 1) / 2);
  const off = (size - 1) / 2;
  const round = state.brushShape === 'round';
  // El radio deja fuera las esquinas del cuadro salvo en las tallas más
  // pequeñas, donde no hay esquina que recortar.
  const r2 = (off + 0.25) * (off + 0.25);
  for (let dy = 0; dy < size; dy++) {
    const py = y - half + dy;
    if (py < 0 || py >= buf.h) continue;
    const oy = dy - off;
    for (let dx = 0; dx < size; dx++) {
      if (round) {
        const ox = dx - off;
        if (ox * ox + oy * oy > r2) continue;
      }
      const px = x - half + dx;
      if (px < 0 || px >= buf.w) continue;
      if (state.dither && ((px + py) & 1)) continue;
      paintPx(buf, px, py, erase ? 0 : v, touch);
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
      if (state.dither && ((x + y) & 1)) continue;
      paintPx(buf, x, y, v, touch);
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
    if (state.dither && ((x + y) & 1)) return;
    paintPx(buf, x, y, v, touch);
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

/* ------------------------------------------------- trazos de varios puntos */

/** Separación entre dos puntos, para decidir en cuántos tramos se pinta una curva. */
const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Pinta una curva de Bézier cúbica (p0 y p3 son los extremos) sellando el pincel. */
function drawBezier(buf, p0, p1, p2, p3, v, size, touch) {
  const steps = clamp(Math.round((gap(p0, p1) + gap(p1, p2) + gap(p2, p3)) / 3), 8, 512);
  let px = p0.x;
  let py = p0.y;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    const x = Math.round(a * p0.x + b * p1.x + c * p2.x + d * p3.x);
    const y = Math.round(a * p0.y + b * p1.y + c * p2.y + d * p3.y);
    drawLine(buf, px, py, x, y, v, size, false, touch);
    px = x;
    py = y;
  }
}

/** Multilínea: un tramo recto entre cada par de puntos consecutivos. */
function drawPolyline(buf, pts, v, size, touch) {
  for (let i = 1; i < pts.length; i++) {
    drawLine(buf, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, v, size, false, touch);
  }
}

/**
 * Bézier y multicurva: grupos de cuatro puntos, donde cada grupo reaprovecha
 * el último del anterior, de modo que las curvas quedan encadenadas. Si aún no
 * hay puntos suficientes, los que faltan se repiten sobre el último: así el
 * trazo enseña una recta mientras se colocan los controles, en vez de saltar.
 */
function drawCurves(buf, pts, v, size, touch, single) {
  const last = pts[pts.length - 1];
  for (let i = 0; i + 1 < pts.length; i += 3) {
    const a = pts[i];
    const b = pts[i + 1];
    const c = pts[i + 2] || last;
    const d = pts[i + 3] || last;
    drawBezier(buf, a, b, c, d, v, size, touch);
    if (single || i + 3 >= pts.length) break;
  }
}

/** Rectángulo que engloba unos puntos, con margen para el grosor del pincel. */
function ptsBounds(pts, size) {
  const pad = Math.ceil(size / 2) + 1;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x - pad);
    y0 = Math.min(y0, p.y - pad);
    x1 = Math.max(x1, p.x + pad);
    y1 = Math.max(y1, p.y + pad);
  }
  return { x0, y0, x1, y1 };
}

/* ----------------------------------------------------------------- texto */

const TEXT_FONT = '"Cascadia Mono", "Consolas", "DejaVu Sans Mono", monospace';

/**
 * Dibuja el texto en un lienzo oculto y devuelve solo su máscara: qué píxeles
 * caen dentro de cada letra. Se guarda la silueta y no el color porque en 8
 * bits el resultado tiene que ser un índice de paleta plano, sin tonalidades
 * intermedias de suavizado.
 */
function textMask(str, size) {
  const font = `${size}px ${TEXT_FONT}`;
  const medir = document.createElement('canvas').getContext('2d');
  medir.font = font;
  const w = Math.max(1, Math.ceil(medir.measureText(str).width) + 2);
  const h = Math.ceil(size * 1.4) + 2;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.font = font;
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#fff';
  ctx.fillText(str, 1, 1);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = rgba[i * 4 + 3] >= 128 ? 1 : 0;
  return { w, h, mask };
}

/** Estampa una máscara de texto con la esquina superior izquierda en (x, y). */
function stampMask(buf, mask, x0, y0, v, touch) {
  for (let y = 0; y < mask.h; y++) {
    const py = y0 + y;
    if (py < 0 || py >= buf.h) continue;
    for (let x = 0; x < mask.w; x++) {
      if (!mask.mask[y * mask.w + x]) continue;
      const px = x0 + x;
      if (px < 0 || px >= buf.w) continue;
      setPx(buf, px, py, v);
      if (touch) touch(px, py);
    }
  }
}

/* -------------------------------------------------------------- difuminar */

let blurCache = null;   // sig: paleta de la que salió; map: 5:5:5 -> índice

/**
 * Índice de paleta más parecido a un color. Se cuantiza la consulta a 5 bits
 * por canal y se guarda la respuesta: difuminar pide esto para cada píxel, y
 * un barrido de 256 colores por píxel se notaría en el arrastre.
 */
function nearestIndex(r, g, b) {
  const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  if (!blurCache || blurCache.sig !== state.palette) {
    blurCache = { sig: state.palette, map: new Map() };
  }
  const hit = blurCache.map.get(key);
  if (hit !== undefined) return hit;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < state.palette.length; i++) {
    const c = state.palette[i];
    if (!c) continue;
    if (i === 0 && state.palette.length > 1) continue;  // el 0 es transparencia
    const dr = to8(c[0]) - r;
    const dg = to8(c[1]) - g;
    const db = to8(c[2]) - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = i; }
  }
  blurCache.map.set(key, best);
  return best;
}

/**
 * Difumina una zona: cada píxel pasa a ser la media de su vecindad de 3×3. Se
 * promedia en color, no en el valor guardado, porque en 8 bits los índices de
 * paleta no se pueden mezclar sin más. La transparencia no entra en la media ni
 * se rellena, de modo que un sprite no se mancha por los bordes.
 */
function blurAt(buf, cx, cy, radius, touch) {
  const r = Math.max(1, radius);
  const x0 = Math.max(0, cx - r);
  const y0 = Math.max(0, cy - r);
  const x1 = Math.min(buf.w - 1, cx + r);
  const y1 = Math.min(buf.h - 1, cy + r);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w <= 0 || h <= 0) return;
  const depth16 = buf.depth === 16;
  const src = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) src[y * w + x] = getPx(buf, x0 + x, y0 + y);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const here = src[y * w + x];
      if (!here) continue;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const v = src[yy * w + xx];
          if (!v) continue;
          if (depth16) {
            sr += (((v >> 11) & 31) * 255) / 31;
            sg += (((v >> 5) & 63) * 255) / 63;
            sb += ((v & 31) * 255) / 31;
          } else {
            const c = state.palette[v];
            if (!c) continue;
            sr += to8(c[0]);
            sg += to8(c[1]);
            sb += to8(c[2]);
          }
          n++;
        }
      }
      if (!n) continue;
      const nr = sr / n;
      const ng = sg / n;
      const nb = sb / n;
      setPx(buf, x0 + x, y0 + y, depth16 ? encode565(nr, ng, nb) : nearestIndex(nr, ng, nb));
      if (touch) touch(x0 + x, y0 + y);
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
    // De cada fila vecina solo se apila el primer píxel de cada tramo. Si se
    // apilara cada columna, una zona grande y lisa llenaría la pila con miles
    // de entradas repetidas y el relleno acabaría atascando la interfaz.
    for (const ny of [py - 1, py + 1]) {
      if (ny < 0 || ny >= buf.h) continue;
      let run = false;
      for (let i = lx; i <= rx; i++) {
        if (getPx(buf, i, ny) === target) {
          if (!run) { stack.push([i, ny]); run = true; }
        } else {
          run = false;
        }
      }
    }
  }
}

/* --------------------------------------------------------------- aerógrafo */

/** Radio del pulverizado: crece con el grosor elegido. */
const sprayRadius = () => Math.max(1, state.brush * 2);

/**
 * Pulveriza color alrededor de (x, y) con motas al azar. Se reparte en disco
 * (raíz de la distancia) para que la densidad sea uniforme y no se acumule en
 * el centro, y el grosor marca el radio del cerco.
 */
function spray(buf, x, y, v, touch) {
  const radius = sprayRadius();
  const dots = Math.max(1, Math.round((radius * radius) / 6));
  for (let i = 0; i < dots; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.sqrt(Math.random()) * radius;
    const px = Math.round(x + Math.cos(angle) * dist);
    const py = Math.round(y + Math.sin(angle) * dist);
    if (px < 0 || py < 0 || px >= buf.w || py >= buf.h) continue;
    paintPx(buf, px, py, v, touch);
  }
}

/** Arranca el chorro continuo del aerógrafo, si no está ya en marcha. */
function startAir() {
  if (state.airTimer !== null) return;
  state.airTimer = setInterval(() => {
    const d = state.drag;
    const buf = activeBuf();
    if (!d || d.tool !== 'air' || !buf) { stopAir(); return; }
    spray(buf, d.last.x, d.last.y, paintValue(), touchDrag);
    draw();
  }, 40);
}

function stopAir() {
  if (state.airTimer === null) return;
  clearInterval(state.airTimer);
  state.airTimer = null;
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
  const raw = await Backend.raw('/api/pixels', { doc: state.doc, id: m.id, frame: state.frame });
  const need = Math.max(0, m.width) * Math.max(0, m.height) * bpp;
  const data = new Uint8Array(need);
  data.set(raw.subarray(0, Math.min(need, raw.length)));
  state.buf = { w: m.width, h: m.height, depth, bpp, data };
}

/** Envía un rectángulo del búfer al núcleo de edición. */
async function sendRect(doc, mapId, frame, r, bytes) {
  return api(
    '/api/pixels',
    { doc, id: mapId, frame, x: r.x, y: r.y, w: r.w, h: r.h },
    { method: 'POST', body: bytes },
  );
}

/** Refresca la miniatura de un mapa tras editarlo. */
function refreshThumb(mapId) {
  const i = state.maps.findIndex((x) => x.id === mapId);
  if (i < 0) return;
  releaseThumb(state.doc, mapId);
  const li = $('mapList').children[i];
  const img = li && li.querySelector('img');
  if (img) fillThumb(img, mapId);
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
  refreshThumb(mapId);
}

/** Entrada de historial para un cambio de píxeles, con las capas al lado. */
function pixelEntry(label, doc, mapId, frame, rect, before, after, layersBefore, layersAfter) {
  const apply = async (bytes, layers) => {
    await sendRect(doc, mapId, frame, rect, bytes);
    // Las capas solo se tocan si el cambio es del mapa y fotograma que se está
    // viendo; si no, se devolverían a la pantalla las de otro sitio.
    if (state.doc === doc && state.selected === mapId && state.frame === frame) restoreLayers(layers);
    state.dirty = true;
    await reloadPixelsIfCurrent(doc, mapId, frame);
  };
  return { label, do: () => apply(after, layersAfter), undo: () => apply(before, layersBefore), layers: !!(layersBefore || layersAfter) };
}

/**
 * Valida el cambio, lo envía al servidor y lo apunta en el historial.
 * `snapshot` es la mezcla anterior (lo que veía el usuario); `layersBefore` y
 * `force` solo entran en juego cuando se trabaja por capas.
 *
 * Se apunta la promesa en `state.pendingEdit`: abrir o crear un fichero la
 * espera antes de cambiar de documento, para no cruzarse con un commit a medio
 * camino (el gesto del ratón no espera a que el núcleo confirme).
 */
function commitPixels(label, bbox, snapshot, layersBefore, force) {
  const p = runCommitPixels(label, bbox, snapshot, layersBefore, force);
  state.pendingEdit = p.then(() => {}, () => {});
  return p;
}

async function runCommitPixels(label, bbox, snapshot, layersBefore, force) {
  const buf = state.buf;
  if (!buf || state.historyBusy) return;
  const doc = state.doc;
  const mapId = state.selected;
  const frame = state.frame;
  const r = clipRect(bbox, buf);
  if (!r) return;
  const after = extractRect(buf.data, buf, r);
  const before = extractRect(snapshot, buf, r);
  // Un cambio que solo toca la estructura de capas deja la mezcla igual, pero
  // también hay que poder deshacerlo, de ahí el `force`.
  if (sameBytes(before, after) && !force) return;

  state.historyBusy = true;
  try {
    await sendRect(doc, mapId, frame, r, after);
  } catch (e) {
    // Si el servidor rechaza el cambio, el búfer local vuelve a su sitio: si no,
    // lo que se ve en pantalla no sería lo que hay guardado.
    buf.data.set(snapshot);
    restoreLayers(layersBefore);
    draw();
    toast(e.message, true);
    return;
  } finally {
    state.historyBusy = false;
  }

  state.undoStack.push(pixelEntry(label, doc, mapId, frame, r, before, after, layersBefore, layersSnapshot()));
  state.redoStack = [];
  state.dirty = true;
  refreshThumb(mapId);
  renderToolbar();
}

/** Ejecuta una edición sobre el mapa completo y la registra. */
async function withBufferEdit(label, fn) {
  const buf = state.buf;
  if (!buf || state.historyBusy) return;
  const compSnap = buf.data.slice();
  const layerSnap = layersSnapshot();
  fn(activeBuf());
  composite();
  draw();
  await commitPixels(label, { x0: 0, y0: 0, x1: buf.w - 1, y1: buf.h - 1 }, compSnap, layerSnap);
}

/** Cambia la estructura de capas y lo registra, aunque la mezcla no varíe. */
async function withLayers(label, fn) {
  const buf = state.buf;
  if (!buf || state.historyBusy) return;
  const compSnap = buf.data.slice();
  const layerSnap = layersSnapshot();
  fn();
  composite();
  draw();
  renderLayers();
  await commitPixels(label, { x0: 0, y0: 0, x1: buf.w - 1, y1: buf.h - 1 }, compSnap, layerSnap, true);
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
    snap: activeBuf().data.slice(),  // superficie activa, para rehacer la vista previa
    comp: state.buf.data.slice(),    // mezcla anterior, para el historial
    layerSnap: layersSnapshot(),
    bbox: { x0: p.x, y0: p.y, x1: p.x, y1: p.y },
    rect: null,
  };
}

function endDrag(label) {
  const d = state.drag;
  state.drag = null;
  if (!d) return;
  composite();
  draw();
  return commitPixels(label, d.bbox, d.comp, d.layerSnap);
}

/* ------------------------------------------- trazos que piden varios clics */

/**
 * La multilínea, la bézier y la multicurva no caben en un solo gesto: se van
 * pidiendo puntos, uno por clic, y el trazo se ve en el aire hasta que se
 * cierra. Mientras dura, `state.path` guarda los puntos ya fijados y una copia
 * de la capa de partida, que es lo que permite rehacer la vista previa en cada
 * movimiento sin que los trazos se vayan acumulando.
 */
const PATH_LABELS = { multiline: 'multilínea', bezier: 'bézier', multicurve: 'multicurva' };
const isPathTool = (t) => t === 'multiline' || t === 'bezier' || t === 'multicurve';

function startPath(p) {
  state.path = {
    tool: state.tool,
    pts: [p],
    base: activeBuf().data.slice(),
    comp: state.buf.data.slice(),
    layerSnap: layersSnapshot(),
  };
  previewPath(p);
  renderPaint();
}

function addPathPoint(p) {
  const path = state.path;
  path.pts.push(p);
  // La bézier son cuatro puntos y se cierra sola; las otras dos esperan a que
  // el usuario diga basta.
  if (path.tool === 'bezier' && path.pts.length >= 4) { finishPath(); return; }
  previewPath(p);
}

/** Redibuja el trazo: los puntos fijados y, si hay, el que sigue al cursor. */
function previewPath(hover) {
  const path = state.path;
  const buf = activeBuf();
  if (!path || !buf) return;
  const pts = hover ? path.pts.concat([hover]) : path.pts;
  buf.data.set(path.base);
  const v = paintValue();
  if (path.tool === 'multiline') drawPolyline(buf, pts, v, state.brush, null);
  else drawCurves(buf, pts, v, state.brush, null, path.tool === 'bezier');
  draw();
}

/** Fija el trazo en el mapa y lo apunta en el historial. */
function finishPath() {
  const path = state.path;
  if (!path) return;
  state.path = null;
  const buf = activeBuf();
  if (!buf) { renderPaint(); return; }
  buf.data.set(path.base);
  // Un solo punto no es un trazo: se descarta sin ensuciar el historial.
  if (path.pts.length >= 2) {
    const v = paintValue();
    if (path.tool === 'multiline') drawPolyline(buf, path.pts, v, state.brush, null);
    else drawCurves(buf, path.pts, v, state.brush, null, path.tool === 'bezier');
    composite();
    draw();
    commitPixels(PATH_LABELS[path.tool] || 'trazo', ptsBounds(path.pts, state.brush), path.comp, path.layerSnap);
  } else {
    composite();
    draw();
  }
  renderPaint();
}

/** Descarta el trazo en curso sin tocar el mapa. */
function cancelPath() {
  const path = state.path;
  if (!path) return;
  state.path = null;
  const buf = activeBuf();
  if (buf) { buf.data.set(path.base); composite(); }
  draw();
  renderPaint();
}

function updateShapePreview(p) {
  const d = state.drag;
  const buf = activeBuf();
  buf.data.set(d.snap);
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
  const buf = activeBuf();
  const r = clipRect({ x0: state.sel.x, y0: state.sel.y, x1: state.sel.x + state.sel.w - 1, y1: state.sel.y + state.sel.h - 1 }, buf);
  if (!r) return false;
  const data = extractRect(buf.data, buf, r);
  // Se apunta cómo estaba el mapa antes de levantar el recorte: el origen se
  // vacía justo debajo, así que si el trozo acaba descartándose hay que poder
  // devolverlo a su sitio.
  setFloat(r.x, r.y, r.w, r.h, data, { comp: state.buf.data.slice(), layers: layersSnapshot(), rect: r });
  // Se vacía el origen: así arrastrar se comporta como mover, no como copiar.
  for (let y = r.y; y < r.y + r.h && y < buf.h; y++) {
    for (let x = r.x; x < r.x + r.w && x < buf.w; x++) setPx(buf, x, y, 0);
  }
  composite();
  state.sel = null;
  return true;
}

/**
 * Crea el trozo flotante a partir de un recorte y lo deja sin girar.
 * `restore`, si viene, guarda el mapa tal y como estaba antes de levantar el
 * recorte, para poder deshacer el hueco si el trozo se descarta.
 */
function setFloat(x, y, w, h, data, restore) {
  const buf = state.buf;
  if (!buf) return;
  state.float = {
    x,
    y,
    w,
    h,
    depth: buf.depth,
    angle: 0,                              // grados, en el sentido de las agujas
    src: { w, h, depth: buf.depth, data }, // recorte original, del que se parte siempre
    data: data.slice(),
    canvas: blockToCanvas(w, h, buf.depth, data),
    restore: restore || null,
  };
  $('rotDeg').value = '0';
}

/** Normaliza un ángulo a (−180, 180]. */
function normAngle(a) {
  a = a % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

/** Gira el trozo flotante. `absolute` fija el ángulo total; si no, se suma. */
function rotateFloat(delta, absolute) {
  const f = state.float;
  if (!f) return;
  f.angle = normAngle(absolute ? delta : f.angle + delta);
  renderFloatBitmap();
  $('rotDeg').value = String(f.angle);
  draw();
}

/**
 * Rehace el recorte girado píxel a píxel, tomando siempre el vecino más
 * próximo del recorte original: así los colores se conservan exactos y no hay
 * que volver a buscar el índice de paleta. La caja crece hasta contener el
 * rectángulo girado y el centro se mantiene en su sitio.
 */
function renderFloatBitmap() {
  const f = state.float;
  if (!f) return;
  const src = f.src;
  const bpp = bppOf(src.depth);
  if (!f.angle) {
    f.w = src.w;
    f.h = src.h;
    f.data = src.data.slice();
    f.canvas = blockToCanvas(f.w, f.h, src.depth, f.data);
    return;
  }
  const a = (f.angle * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const nw = Math.max(1, Math.round(Math.abs(src.w * cos) + Math.abs(src.h * sin)));
  const nh = Math.max(1, Math.round(Math.abs(src.w * sin) + Math.abs(src.h * cos)));
  const out = new Uint8Array(nw * nh * bpp);
  const cx = (src.w - 1) / 2;
  const cy = (src.h - 1) / 2;
  const ncx = (nw - 1) / 2;
  const ncy = (nh - 1) / 2;
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const dx = x - ncx;
      const dy = y - ncy;
      // Rotación inversa: de la caja nueva al recorte original.
      const sx = Math.round(dx * cos + dy * sin + cx);
      const sy = Math.round(-dx * sin + dy * cos + cy);
      if (sx < 0 || sy < 0 || sx >= src.w || sy >= src.h) continue;
      const si = (sy * src.w + sx) * bpp;
      const di = (y * nw + x) * bpp;
      for (let k = 0; k < bpp; k++) out[di + k] = src.data[si + k];
    }
  }
  const pcx = f.x + (f.w - 1) / 2;
  const pcy = f.y + (f.h - 1) / 2;
  f.w = nw;
  f.h = nh;
  f.x = Math.round(pcx - (nw - 1) / 2);
  f.y = Math.round(pcy - (nh - 1) / 2);
  f.data = out;
  f.canvas = blockToCanvas(nw, nh, src.depth, out);
}

/** Plasta el trozo sobre el mapa. El valor 0 es transparente y no tapa nada. */
function blitFloat(buf, f) {
  const bpp = bppOf(buf.depth);
  for (let y = 0; y < f.h; y++) {
    const py = f.y + y;
    if (py < 0 || py >= buf.h) continue;
    for (let x = 0; x < f.w; x++) {
      const px = f.x + x;
      if (px < 0 || px >= buf.w) continue;
      const si = (y * f.w + x) * bpp;
      let empty = true;
      for (let k = 0; k < bpp; k++) if (f.data[si + k]) { empty = false; break; }
      if (empty) continue;
      const di = (py * buf.w + px) * bpp;
      for (let k = 0; k < bpp; k++) buf.data[di + k] = f.data[si + k];
    }
  }
}

/** Rectángulo que hay que enviar al fijar el trozo. Cubre el pegado y, si el
    trozo venía de levantar un recorte, también el hueco que dejó en su origen:
    ese hueco solo existe en local y sin enviarlo el servidor conservaría los
    píxeles viejos donde estaba el recorte. */
function floatCommitRect(f) {
  const bb = { x0: f.x, y0: f.y, x1: f.x + f.w - 1, y1: f.y + f.h - 1 };
  const s = f.restore && f.restore.rect;
  if (s) {
    bb.x0 = Math.min(bb.x0, s.x);
    bb.y0 = Math.min(bb.y0, s.y);
    bb.x1 = Math.max(bb.x1, s.x + s.w - 1);
    bb.y1 = Math.max(bb.y1, s.y + s.h - 1);
  }
  return bb;
}

async function anchorFloat() {
  const f = state.float;
  const buf = state.buf;
  if (!f || !buf) return;
  const compSnap = buf.data.slice();
  const layerSnap = layersSnapshot();
  const target = activeBuf();
  const bb = floatCommitRect(f);
  blitFloat(target, f);
  state.float = null;
  state.sel = clipRect({ x0: f.x, y0: f.y, x1: f.x + f.w - 1, y1: f.y + f.h - 1 }, buf);
  composite();
  draw();
  renderPaint();
  await commitPixels('trozo pegado', bb, compSnap, layerSnap);
}

function cancelFloat() {
  const f = state.float;
  if (!f) return;
  state.float = null;
  // Un recorte levantado del mapa dejó el hueco de su sitio original: al
  // descartarlo hay que devolver el mapa a como estaba antes de levantarlo. Si
  // entretanto se han activado o cerrado las capas, el estado apuntado ya no
  // describe la pantalla y es mejor no tocar nada.
  if (f.restore && !!state.layers === !!f.restore.layers) {
    state.buf.data.set(f.restore.comp);
    restoreLayers(f.restore.layers);
    composite();
  }
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

/** Empaqueta un color de 0..255 por canal en RGB565, como lo guarda el mapa. */
const encode565 = (r, g, b) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);

/* ----------------------------------------------------- interfaz de pintura */

function setTool(name) {
  // Cambiar de herramienta con un trazo de varios clics a medias lo fija, en
  // vez de tirarlo: es lo que menos sorprende a quien va encadenando curvas.
  if (state.path) finishPath();
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
  $('ditherChk').disabled = !hasBuf;
  $('brushShape').disabled = !hasBuf;
  $('btnToWindow').disabled = !hasBuf;
  $('brushSize').value = String(state.brush);
  $('brushShape').value = state.brushShape;
  $('fillChk').checked = state.fillShape;
  $('ditherChk').checked = state.dither;
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
  $('textActions').hidden = !(hasBuf && state.tool === 'text');
  $('pathActions').hidden = !state.path;
  renderLayers();
  renderBrush();

  const cv = $('view');
  const pintan = ['pencil', 'brush', 'eraser', 'air', 'fill', 'blur', 'line', 'rect', 'ellipse'];
  // Con los puntos de control a la vista, el clic los coloca a ellos: el cursor
  // de pintar sobra y confundiría.
  const punteando = hasBuf && !state.pickPoint;
  cv.classList.toggle('painting', punteando && (pintan.includes(state.tool) || isPathTool(state.tool) || state.tool === 'text'));
  cv.classList.toggle('selecting', punteando && state.tool === 'select');
}

function resetPaintState() {
  stopAir();
  state.sel = null;
  state.float = null;
  state.drag = null;
  state.path = null;
  closeLayers();
}

/* -------------------------------------------------------------- capas */

let layerSeq = 1;

/**
 * Cierra la sesión de capas. Se descartan y con ellas el historial que iba
 * apuntado a su estructura: al no haber ya capas, esas entradas no tendrían
 * dónde volver. Las entradas de píxeles sueltos se conservan.
 */
function closeLayers() {
  if (!state.layers) return;
  state.layers = null;
  state.layer = 0;
  layerSeq = 1;
  state.undoStack = state.undoStack.filter((e) => !e.layers);
  state.redoStack = state.redoStack.filter((e) => !e.layers);
  renderToolbar();
}

/** Pinta la barra de capas y refleja el estado actual. */
function renderLayers() {
  const bar = $('layerbar');
  if (!bar) return;
  bar.hidden = !state.buf;
  if (!state.buf) return;
  const sel = $('layerSel');
  const has = !!state.layers;
  if (has) {
    if (sel.options.length !== state.layers.length) {
      sel.innerHTML = '';
      for (let i = 0; i < state.layers.length; i++) sel.append(new Option('', String(i)));
    }
    state.layers.forEach((l, i) => {
      sel.options[i].textContent = (l.visible ? '' : '· ') + l.name;
    });
    sel.value = String(state.layer);
    sel.disabled = false;
    $('layerHint').textContent = `${state.layers.length} capa${state.layers.length === 1 ? '' : 's'}`;
  } else {
    if (sel.options.length !== 1) { sel.innerHTML = ''; sel.append(new Option('', '0')); }
    sel.options[0].textContent = 'Fondo (sin capas)';
    sel.value = '0';
    sel.disabled = true;
    $('layerHint').textContent = 'Añade una capa para separar los trazos.';
  }
  $('layerAdd').disabled = false;
  $('layerDup').disabled = !has;
  $('layerUp').disabled = !has || state.layer <= 0;
  $('layerDown').disabled = !has || state.layer >= state.layers.length - 1;
  $('layerEye').disabled = !has;
  $('layerEye').textContent = has && !state.layers[state.layer].visible ? 'Mostrar' : 'Ocultar';
  $('layerDel').disabled = !has || state.layers.length <= 1;
  $('layerFlat').disabled = !has;
}

/** Convierte el mapa liso en una primera capa, sin tocar los píxeles. */
function enterLayers() {
  if (state.layers || !state.buf) return;
  state.layers = [{ name: 'Capa 1', visible: true, data: state.buf.data.slice() }];
  state.layer = 0;
  layerSeq = 2;
  // Las entradas de historial anteriores son del mapa liso y, al deshacerlas,
  // las capas volverían a tapar el resultado. Se empieza de cero.
  state.undoStack = [];
  state.redoStack = [];
  renderToolbar();
  toast('Capas activadas: el historial de deshacer empieza de cero');
}

function newLayer() {
  if (!state.buf) return;
  enterLayers();
  const data = new Uint8Array(state.buf.data.length);
  state.layers.splice(state.layer + 1, 0, { name: `Capa ${layerSeq++}`, visible: true, data });
  state.layer++;
  renderLayers();
}

function duplicateLayer() {
  if (!state.layers) return;
  withLayers('duplicar capa', () => {
    const src = state.layers[state.layer];
    state.layers.splice(state.layer + 1, 0, { name: `${src.name} copia`, visible: src.visible, data: src.data.slice() });
    state.layer++;
  });
}

function moveLayer(delta) {
  const j = state.layers ? state.layer + delta : -1;
  if (!state.layers || j < 0 || j >= state.layers.length) return;
  withLayers('mover capa', () => {
    const [l] = state.layers.splice(state.layer, 1);
    state.layers.splice(j, 0, l);
    state.layer = j;
  });
}

function toggleLayer() {
  if (!state.layers) return;
  withLayers('mostrar u ocultar capa', () => {
    const l = state.layers[state.layer];
    l.visible = !l.visible;
  });
}

function deleteLayer() {
  if (!state.layers || state.layers.length <= 1) return;
  withLayers('borrar capa', () => {
    state.layers.splice(state.layer, 1);
    state.layer = Math.max(0, state.layer - 1);
  });
}

function flattenLayers() {
  if (!state.layers) return;
  withLayers('fusionar capas', () => {
    composite();
    state.layers = [{ name: 'Fondo', visible: true, data: state.buf.data.slice() }];
    state.layer = 0;
  });
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

  // Editar los puntos de control tiene prioridad sobre cualquier herramienta.
  if (state.pickPoint && (state.kind === 'fpg' || state.kind === 'map')) {
    const buf = state.buf;
    if (!buf) return;
    const i = controlPointAt(p);
    if (i >= 0) {
      // Hay un punto justo debajo: se agarra y se arrastra, como en el editor
      // original, en vez de colocar otro encima. Se guarda la lista tal y como
      // estaba, que es lo que necesita el deshacer después de moverlo.
      const m = currentMap();
      state.pointIndex = i;
      state.drag = {
        tool: 'point',
        start: { ...p },
        last: { ...p },
        index: i,
        points0: (m.points || []).map((q) => [q[0], q[1]]),
      };
      capturePointer(ev);
      draw();
      renderEditor();
      return;
    }
    // Lejos de cualquier punto: el clic coloca el punto activo donde se pulse.
    if (p.x < 0 || p.y < 0 || p.x >= buf.w || p.y >= buf.h) return;
    const m = currentMap();
    if (!m.points || !m.points.length) {
      // Un sprite recién hecho no tiene punto ninguno que colocar, así que el
      // primer clic crea el primero en vez de quedarse sin hacer nada.
      $('ptCount').value = 1;
      $('ptIndex').value = 0;
    }
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
      state.drag = { tool: 'moveFloat', start: { ...p }, last: { ...p }, snap: null, comp: null, layerSnap: null, bbox: null, rect: null };
      capturePointer(ev);
      draw();
      renderPaint();
      return;
    }
    state.drag = { tool: 'selectRect', start: { ...p }, last: { ...p }, snap: null, comp: null, layerSnap: null, bbox: null, rect: { x: p.x, y: p.y, w: 1, h: 1 } };
    capturePointer(ev);
    draw();
    return;
  }

  if (tool === 'fill') {
    beginDrag('fill', p);
    floodFill(activeBuf(), p.x, p.y, paintValue(), touchDrag);
    await endDrag('relleno');
    return;
  }

  // Los trazos de varios clics no usan gesto: cada pulsación es un punto más.
  if (isPathTool(tool)) {
    if (state.path && state.path.tool === tool) {
      // El doble clic cierra el trazo, como en cualquier editor de dibujo.
      if (ev.detail >= 2) finishPath();
      else addPathPoint(p);
    } else {
      startPath(p);
    }
    return;
  }

  if (tool === 'text') {
    const str = state.text.trim();
    if (!str) { toast('Escribe antes el texto que quieres estampar', true); return; }
    const mask = textMask(str, state.textSize);
    beginDrag('text', p);
    state.drag.bbox = { x0: p.x, y0: p.y, x1: p.x + mask.w - 1, y1: p.y + mask.h - 1 };
    stampMask(activeBuf(), mask, p.x, p.y, paintValue());
    await endDrag('texto');
    return;
  }

  beginDrag(tool, p);
  capturePointer(ev);
  if (tool === 'pencil' || tool === 'brush' || tool === 'eraser') {
    const size = tool === 'pencil' ? 1 : state.brush;
    stamp(activeBuf(), p.x, p.y, tool === 'eraser' ? 0 : paintValue(), size, tool === 'eraser', touchDrag);
    draw();
  } else if (tool === 'air') {
    // El aerógrafo no dibuja de una vez: suelta un chorro mientras se mantenga
    // pulsado, así que aquí solo hay que abrir el grifo.
    spray(activeBuf(), p.x, p.y, paintValue(), touchDrag);
    draw();
    startAir();
  } else if (tool === 'blur') {
    blurAt(activeBuf(), p.x, p.y, state.brush, touchDrag);
    draw();
  } else {
    updateShapePreview(p);
  }
}

function onCanvasMove(ev) {
  const p = canvasPoint(ev);
  $('readout').textContent = readout(p);
  // Con un trazo de varios clics a medias, el cursor estira el último tramo.
  if (state.path && !state.drag && p) { previewPath(p); return; }
  const d = state.drag;
  const buf = state.buf;
  if (!d || !buf) return;

  if (d.tool === 'point') {
    // Se mueve el punto en la lista local, que es la que dibuja los mandos;
    // al soltar se restaura la original y se manda el cambio al núcleo.
    const m = currentMap();
    if (m && m.points) {
      const x = clamp(p.x, 0, buf.w - 1);
      const y = clamp(p.y, 0, buf.h - 1);
      m.points[d.index] = [x, y];
      d.last = { x, y };
      $('ptX').value = x;
      $('ptY').value = y;
      draw();
    }
    return;
  }
  if (d.tool === 'pencil' || d.tool === 'brush' || d.tool === 'eraser') {
    const size = d.tool === 'pencil' ? 1 : state.brush;
    const erase = d.tool === 'eraser';
    drawLine(activeBuf(), d.last.x, d.last.y, p.x, p.y, erase ? 0 : paintValue(), size, erase, touchDrag);
    d.last = { x: p.x, y: p.y };
    draw();
    return;
  }
  if (d.tool === 'air') {
    // Solo se mueve el punto de pulverizado: el chorro lo suelta el temporizador.
    d.last = { x: p.x, y: p.y };
    return;
  }
  if (d.tool === 'blur') {
    blurAt(activeBuf(), p.x, p.y, state.brush, touchDrag);
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
    // Si el trozo se fijó a media pulsación (Intro), el arrastre ya no tiene
    // destino: se descarta el gesto en vez de tropezar con un flotante nulo.
    if (!state.float) { state.drag = null; return; }
    state.float.x += p.x - d.last.x;
    state.float.y += p.y - d.last.y;
    d.last = { x: p.x, y: p.y };
    draw();
  }
}

async function onCanvasUp(ev) {
  releasePointer(ev);
  const d = state.drag;
  if (!d) return;
  if (d.tool === 'point') {
    state.drag = null;
    const m = currentMap();
    // El núcleo recibe el antes y el después; el «antes» vuelve a ser la lista
    // original, que es la que se apuntó al agarrar el punto.
    if (m && d.points0) m.points = d.points0;
    draw();
    renderEditor();
    if (m) await applyPointsChange(m.points.length, d.index, d.last.x, d.last.y, 'mover punto');
    return;
  }
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
  if (d.tool === 'air') {
    stopAir();
    await endDrag('aerógrafo');
    return;
  }
  const labels = { pencil: 'lápiz', brush: 'pincel', eraser: 'goma', line: 'línea', rect: 'rectángulo', ellipse: 'elipse', blur: 'difuminado' };
  await endDrag(labels[d.tool] || 'trazo');
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
      ? 'Clic para colocar el punto activo; para moverlo, arrástralo.'
      : 'Puedes escribir X/Y o activar «Usar clic» (Shift+F2) para situarlo sobre el sprite.';

  renderMapTools(m, canPoints);
  renderPickCursor();
}

/** Habilita y rellena los controles de crear y transformar mapas.
    «Nuevo» sirve incluso con un FPG recién creado (que aún no tiene mapas), de
    ahí que dependa del tipo de documento y no de que haya uno seleccionado. */
function renderMapTools(m, canPoints) {
  const esFpg = state.kind === 'fpg';

  $('mapNewBtn').disabled = !esFpg;
  $('mapDupBtn').disabled = !(esFpg && m);
  $('mapResizeBtn').disabled = !(canPoints && m);
  $('mapSplitBtn').disabled = !(esFpg && m);
  $('mapW').disabled = !canPoints;
  $('mapH').disabled = !canPoints;
  $('mapAnchor').disabled = !(canPoints && m);
  $('muralGroup').hidden = !esFpg;
  $('muralViewBtn').disabled = !esFpg;
  $('muralMakeBtn').disabled = !esFpg;

  // El tamaño de partida es el del mapa activo; sin mapa, uno razonable, que es
  // el que usará «Nuevo» para el primer mapa de un FPG vacío.
  $('mapW').value = canPoints ? (m ? m.width : 32) : '';
  $('mapH').value = canPoints ? (m ? m.height : 32) : '';

  $('mapStructHint').textContent = !canPoints
    ? 'Selecciona un mapa para transformarlo.'
    : m
      ? `${m.width}×${m.height}. «Nuevo» y «Trocear» usan el tamaño de arriba.`
      : 'FPG vacío: «Nuevo» creará el primer mapa con el tamaño de arriba.';
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
    renderLayers();
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
    renderLayers();
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

/* ------------------------------------------------- crear y transformar mapas */

/* Estas operaciones cambian la estructura del documento (cuántos mapas hay y de
   qué tamaño), no los píxeles de un mapa concreto; por eso no entran en el
   historial de deshacer, que cubre el dibujo —igual que en el editor de DIV—.
   Eso sí: todo queda en memoria y el fichero de disco no se toca hasta guardar,
   así que un cambio a peor siempre se puede deshacer volviendo a abrir. */

/** Aplica un cambio estructural y deja seleccionado el mapa resultante. */
async function mapStructure(path, query, selectId, msg) {
  try {
    const j = await api(path, { doc: state.doc, ...query }, { method: 'POST' });
    const id = selectId !== undefined && selectId !== null ? selectId : j.new_id;
    await applyDocSelection(j, id, msg);
    state.dirty = true;
    renderToolbar();
  } catch (e) {
    toast(e.message, true);
  }
}

/** Ancho y alto escritos en el inspector, ya acotados a lo que admite el motor. */
function mapSizeFields() {
  return {
    w: clamp(parseInt($('mapW').value, 10) || 0, 1, 4096),
    h: clamp(parseInt($('mapH').value, 10) || 0, 1, 4096),
  };
}

function mapNew() {
  if (state.kind !== 'fpg') return;
  const { w, h } = mapSizeFields();
  mapStructure('/api/map_add', { w, h }, undefined, `Mapa ${w}×${h} añadido (sin guardar)`);
}

function mapDuplicate() {
  const m = currentMap();
  if (!m || state.kind !== 'fpg') return;
  mapStructure('/api/map_add', { from: m.id }, undefined, `Mapa ${m.id} duplicado (sin guardar)`);
}

function mapResize() {
  const m = currentMap();
  if (!m) return;
  const { w, h } = mapSizeFields();
  if (w === m.width && h === m.height) { toast('Ese ya es el tamaño del mapa'); return; }
  const recorta = w < m.width || h < m.height;
  mapStructure('/api/map_resize', { id: m.id, w, h, anchor: $('mapAnchor').value }, m.id,
    recorta ? `Recortado a ${w}×${h}: lo que sobra se ha perdido` : `Ampliado a ${w}×${h}`);
}

function mapSplit() {
  const m = currentMap();
  if (!m || state.kind !== 'fpg') return;
  const { w, h } = mapSizeFields();
  mapStructure('/api/map_split', { id: m.id, w, h }, undefined,
    `Mapa ${m.id} troceado en baldosas de ${w}×${h} (sin guardar)`);
}

/** Compone el tapiz y lo enseña; lo monta el núcleo, así que sale igual que el
    mapa que crearía «Crear mapa del mural». */
async function muralView() {
  if (state.kind !== 'fpg') return;
  releaseMural();
  try {
    const url = await Backend.imageUrl('/api/mural', { doc: state.doc });
    if (!url) throw new Error('no se ha podido componer el mural');
    muralUrl = url;
    $('muralImg').src = url;
    $('muralPreview').classList.add('has-mural');
  } catch (e) {
    toast(e.message, true);
  }
}

function muralMake() {
  if (state.kind !== 'fpg') return;
  mapStructure('/api/mural_new', {}, undefined, 'Mural creado como mapa nuevo (sin guardar)');
}

/**
 * Copia a una ventana el gráfico que se está viendo, que es lo que hace la tecla
 * K del editor de DIV. La ventana lleva la imagen a tamaño real para poder
 * arrastrarla fuera o guardarla; de paso se intenta dejarla en el portapapeles.
 */
function copyToWindow() {
  const m = currentMap();
  const buf = state.buf;
  if (!m || !buf) return;

  // La ventana se abre ya, dentro del propio clic. Si se dejara para después de
  // preparar la imagen, el navegador la tomaría por una ventana emergente
  // nacida sola y la bloquearía.
  const w = window.open('', 'fpgplus-grafico', 'width=560,height=480,resizable=yes');
  if (!w) { toast('El navegador ha bloqueado la ventana emergente', true); return; }

  // La imagen se saca del lienzo fuera de pantalla, que ya lleva la mezcla de
  // capas al día, en vez de volver a pedírsela al núcleo.
  renderBuf();
  const src = state.off.canvas.toDataURL('image/png');
  const rotulo = `${m.name ? `${m.name} · ` : ''}mapa ${m.id} · ${m.width}×${m.height}`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  w.document.open();
  w.document.write(
    `<!doctype html><meta charset="utf-8"><title>FPG+ · ${esc(rotulo)}</title>` +
    '<body style="margin:0;background:#211f1c;color:#cfc9bf;font:12px system-ui">' +
    `<div style="padding:6px 10px">${esc(rotulo)}</div>` +
    `<img alt="" style="display:block;image-rendering:pixelated" src="${src}">`,
  );
  w.document.close();

  // El portapapeles es un extra: si el navegador lo niega o la ventana nueva se
  // ha llevado el foco, la ventana ya ha cumplido su parte.
  window.focus();
  state.off.canvas.toBlob((blob) => {
    if (!blob || !navigator.clipboard || !window.ClipboardItem) {
      toast('Gráfico abierto en una ventana aparte');
      return;
    }
    navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })])
      .then(() => toast('Gráfico abierto en una ventana y copiado al portapapeles'))
      .catch(() => toast('Gráfico abierto en una ventana aparte'));
  }, 'image/png');
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
  // El selector visual ya se limitaba al rango válido, pero el estado interno
  // podía conservar un fotograma antiguo hasta la próxima interacción. Se deja
  // clamped aquí antes de que `loadCanvas()` lo use.
  state.frame = clamp(state.frame, 0, Math.max(0, frames - 1));
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
  sel.value = String(state.frame);

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
  const suggested = `mapa_${tag}.png`;
  if (enWeb()) {
    // El navegador no lista carpetas: el destino lo elige su propio diálogo.
    elegirDestino(suggested, EXT_IMAGES, 'Exportar mapa', exportTo);
    return;
  }
  openDialog({
    mode: 'export',
    title: 'Exportar mapa',
    confirm: 'Exportar',
    exts: EXT_IMAGES,
    path: `${currentDir()}\\${suggested}`,
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
  if (enWeb()) {
    // Sin diálogo de carpetas no hay dónde preguntar el id; se importa con el
    // que le toque y, si no cuadra, se cambia luego en el inspector.
    elegirOrigen(EXT_IMAGES, 'Importar imagen', true).then((name) => {
      if (name) importFrom(name, '');
    });
    return;
  }
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

/* Qué se puede crear, con su extensión, si pide medidas y si admite nombre.
   Las pistas son las que se enseñan al lado de la elección de tipo. */
const NEW_KINDS = {
  fpg: { ext: '.fpg', file: 'NUEVO.FPG', label: 'FPG', size: true, mapName: false,
    hint: 'Un FPG es la caja de gráficos de DIV. Nace con un primer mapa del tamaño indicado.' },
  f16: { ext: '.f16', file: 'NUEVO.F16', label: 'FPG de 16 bits', size: true, mapName: false,
    hint: 'Como el FPG normal, pero en color directo (sin paleta). Nace con un mapa del tamaño indicado.' },
  map: { ext: '.map', file: 'NUEVO.MAP', label: 'MAP', size: true, mapName: true,
    hint: 'Un gráfico suelto, el que carga load_map. Se crea en blanco con estas medidas.' },
  m16: { ext: '.m16', file: 'NUEVO.M16', label: 'MAP de 16 bits', size: true, mapName: true,
    hint: 'Un gráfico suelto en color directo. Se crea en blanco con estas medidas.' },
  pal: { ext: '.pal', file: 'NUEVA.PAL', label: 'PAL', size: false, mapName: false,
    hint: 'Una paleta de 256 colores, vacía, para colorear en el dock de abajo.' },
  fnt: { ext: '.fnt', file: 'NUEVA.FNT', label: 'FNT', size: false, mapName: false,
    hint: 'Una fuente de 256 caracteres, todavía sin dibujar.' },
};

/** Tipo marcado en el diálogo de creación. */
const newKind = () => (document.querySelector('input[name="newKind"]:checked') || {}).value || 'fpg';

/** Abre el diálogo de creación, siempre con el FPG como opción de partida. */
function newDialog() {
  for (const r of document.querySelectorAll('input[name="newKind"]')) r.checked = r.value === 'fpg';
  $('newName').value = '';
  $('newModal').hidden = false;
  newKindChanged();
}

/** Ajusta el diálogo al tipo elegido: unos piden medidas y otros no. */
function newKindChanged() {
  const k = NEW_KINDS[newKind()];
  $('newSizeWrap').hidden = !k.size;
  $('newNameWrap').hidden = !k.mapName;
  $('newSizeHint').textContent = k.hint;
}

function closeNewDialog() {
  $('newModal').hidden = true;
}

/** Recoge lo elegido y pide el destino: primero se sabe el qué, luego el dónde. */
function newConfirm() {
  const kind = newKind();
  const k = NEW_KINDS[kind];
  const opts = { kind };
  if (k.size) {
    opts.w = clamp(parseInt($('newW').value, 10) || 64, 1, 4096);
    opts.h = clamp(parseInt($('newH').value, 10) || 64, 1, 4096);
  }
  if (k.mapName) opts.name = $('newName').value.trim() || null;
  closeNewDialog();

  if (enWeb()) {
    elegirDestino(k.file, [k.ext], `Nuevo ${k.label}`, (p) => createFile(p, opts));
    return;
  }
  openDialog({
    mode: 'new',
    title: `Nuevo ${k.label}`,
    confirm: 'Crear',
    exts: [k.ext],
    path: `${state.dir || state.home}\\${k.file}`,
    onPick: (p) => createFile(p, opts),
  });
}

/** Crea el fichero en el destino elegido con lo que se decidió en el diálogo. */
async function createFile(p, opts) {
  const params = { path: p, kind: opts.kind };
  if (opts.w) params.w = opts.w;
  if (opts.h) params.h = opts.h;
  if (opts.name) params.name = opts.name;
  try {
    await waitEdits();
    const j = await api('/api/new', params, { method: 'POST' });
    applyDoc(j, { reset: true });
    $('pathInput').value = j.path;
    toast(`Creado ${j.name}`);
  } catch (e) {
    toast(e.message, true);
  }
}

/* ------------------------------------------------------------- la ayuda */

function openHelp() { $('helpModal').hidden = false; }
function closeHelp() { $('helpModal').hidden = true; }
function toggleHelp() { $('helpModal').hidden ? openHelp() : closeHelp(); }

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
  if (enWeb()) {
    elegirOrigen(SUPPORTED, 'Abrir recurso de DIV').then((name) => {
      if (name) openPath(name);
    });
    return;
  }
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
  if (enWeb()) {
    // Aquí no hay rutas: lo que se guarda con «Guardar» queda en el fichero que
    // se elija ahora, y a partir de ahí Ctrl+S escribe ahí sin preguntar.
    elegirDestino(state.info.path, [extOf(state.kind)], 'Guardar como', (p) => saveDoc(p));
    return;
  }
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
    if (!$('newModal').hidden) { closeNewDialog(); return; }
    if (!$('helpModal').hidden) { closeHelp(); return; }
    if (state.path) { cancelPath(); return; }
    if (state.float) { cancelFloat(); return; }
    if (state.sel) { clearSelection(); return; }
    if (state.pickPoint) { state.pickPoint = false; renderEditor(); }
    return;
  }

  // La ayuda es lo primero que se ofrece en un editor: siempre a mano con F1.
  if (ev.key === 'F1') { ev.preventDefault(); toggleHelp(); return; }

  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey) {
    const k = ev.key.toLowerCase();
    if (k === 's') { ev.preventDefault(); ev.shiftKey ? saveAsDialog() : saveDoc(null); return; }
    if (k === 'o') { ev.preventDefault(); openFileDialog(); return; }
    if (k === 'n') { ev.preventDefault(); newDialog(); return; }
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
    // Shift+F2 es la tecla de los puntos de control en el editor de DIV.
    if (ev.key === 'F2' && ev.shiftKey) {
      ev.preventDefault();
      state.pickPoint = !state.pickPoint;
      renderEditor();
      return;
    }
    if (ev.key.toLowerCase() === 'k') { ev.preventDefault(); copyToWindow(); return; }
    // U y X son las teclas de la textura en el taller de DIV: pintar con ella y
    // verla repetida sobre el lienzo.
    if (ev.key.toLowerCase() === 'u') { $('texPaintChk').click(); return; }
    if (ev.key.toLowerCase() === 'x') { $('texViewChk').click(); return; }
    const tools = {
      v: 'view', p: 'pencil', b: 'brush', e: 'eraser', a: 'air', f: 'fill', i: 'pick',
      l: 'line', r: 'rect', o: 'ellipse', s: 'select',
      // Las teclas de los trazos largos siguen la costumbre de DIV en la medida
      // de lo posible: la D de difuminar y la T de texto. Las funciones F4, F5 y
      // F6 que usa el editor original no valen aquí: el navegador se las queda.
      m: 'multiline', z: 'bezier', c: 'multicurve', t: 'text', d: 'blur',
    };
    const t = tools[ev.key.toLowerCase()];
    if (t) { setTool(t); return; }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (state.sel) { ev.preventDefault(); doDelete(); }
      return;
    }
    if (ev.key === 'Enter') {
      if (state.path) { ev.preventDefault(); finishPath(); return; }
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
    if (enWeb()) {
      openFileDialog();
      return;
    }
    const p = $('pathInput').value.trim();
    if (p) openPath(p);
    else openFileDialog();
  };
  $('pathInput').onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('btnOpen').click();
    }
  };

  $('btnBrowse').onclick = openFileDialog;
  $('btnNew').onclick = newDialog;
  $('btnHelp').onclick = toggleHelp;
  $('btnSave').onclick = () => saveDoc(null);
  $('btnSaveAs').onclick = saveAsDialog;
  $('btnUndo').onclick = undoAction;
  $('btnRedo').onclick = redoAction;
  $('btnExport').onclick = exportDialog;
  $('btnImport').onclick = importDialog;
  $('btnPanel').onclick = toggleInspector;
  $('btnToWindow').onclick = copyToWindow;

  // Puntas de BRUSH.FPG y pintura con textura.
  $('brushLibBtn').onclick = openBrushLib;
  $('brushLibSel').onchange = (e) => chooseBrushPunta(e.target.value);
  $('texSel').onchange = (e) => chooseTex(e.target.value);
  $('texPaintChk').onchange = (e) => {
    state.texPaint = e.target.checked;
    renderBrush();
  };
  $('texViewChk').onchange = (e) => {
    state.texView = e.target.checked;
    draw();
    renderBrush();
  };

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

  // Diálogo de creación: tipo, medidas y nombre.
  $('newClose').onclick = closeNewDialog;
  $('newCancel').onclick = closeNewDialog;
  $('newOk').onclick = newConfirm;
  $('newModal').onclick = (e) => {
    if (e.target === $('newModal')) closeNewDialog();
  };
  for (const r of document.querySelectorAll('input[name="newKind"]')) r.onchange = newKindChanged;

  // Guía de ayuda.
  $('helpClose').onclick = closeHelp;
  $('helpOk').onclick = closeHelp;
  $('helpModal').onclick = (e) => {
    if (e.target === $('helpModal')) closeHelp();
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
  $('mapNewBtn').onclick = mapNew;
  $('mapDupBtn').onclick = mapDuplicate;
  $('mapResizeBtn').onclick = mapResize;
  $('mapSplitBtn').onclick = mapSplit;
  $('muralViewBtn').onclick = muralView;
  $('muralMakeBtn').onclick = muralMake;
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
  $('brushShape').onchange = () => { state.brushShape = $('brushShape').value; };
  $('fillChk').onchange = () => { state.fillShape = $('fillChk').checked; };
  $('ditherChk').onchange = () => { state.dither = $('ditherChk').checked; };
  $('textInput').value = state.text;
  $('textInput').oninput = () => { state.text = $('textInput').value; };
  $('textSize').value = String(state.textSize);
  $('textSize').oninput = () => {
    state.textSize = clamp(+$('textSize').value || 14, 6, 72);
  };
  $('pathOk').onclick = finishPath;
  $('pathCancel').onclick = cancelPath;
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
  $('rotCcw').onclick = () => rotateFloat(-90);
  $('rotCw').onclick = () => rotateFloat(90);
  $('rotDeg').oninput = () => rotateFloat(+$('rotDeg').value || 0, true);

  $('layerSel').onchange = () => {
    if (!state.layers) return;
    state.layer = clamp(+$('layerSel').value || 0, 0, state.layers.length - 1);
    renderLayers();
  };
  $('layerAdd').onclick = newLayer;
  $('layerDup').onclick = duplicateLayer;
  $('layerUp').onclick = () => moveLayer(1);
  $('layerDown').onclick = () => moveLayer(-1);
  $('layerEye').onclick = toggleLayer;
  $('layerDel').onclick = deleteLayer;
  $('layerFlat').onclick = flattenLayers;

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
  renderToolbar();
  renderPaint();

  // Primero se decide quién va a atender las peticiones: el servidor local, si
  // está escuchando en esta misma dirección, o el núcleo WebAssembly.
  try {
    await Backend.init();
  } catch (e) {
    toast('No he podido arrancar el editor: ' + e.message, true);
    return;
  }

  if (enWeb()) {
    // La caja de ruta no sirve para escribir rutas del disco, porque no las hay.
    document.body.classList.add('mode-web');
    $('pathInput').readOnly = true;
    $('pathInput').placeholder = 'Ningún fichero abierto · «Examinar…» para elegirlo';
    $('pathInput').title = 'En la versión web, «Abrir» y «Examinar…» usan el selector del navegador';
    $('pathInput').onclick = openFileDialog;
  }

  try {
    const st = await api('/api/state');
    state.home = st.home;
  } catch (e) {
    toast('No he podido hablar con el núcleo: ' + e.message, true);
  }
}

boot();
