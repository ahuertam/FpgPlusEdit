/* Capa de transporte del editor FPG+ Edit.
 *
 * La interfaz (app.js) no sabe —ni tiene por qué saber— si corre junto al
 * servidor local o dentro de una pestaña sin servidor. Siempre habla con
 * `Backend`, que tiene dos implementaciones con las mismas operaciones:
 *
 *   · «local» — hay un servidor (fpgplusedit.exe) atendiendo /api/ en esta
 *     misma dirección. Las peticiones van por `fetch` y los ficheros los toca
 *     el servidor en el disco del equipo.
 *
 *   · «web» — la página se sirve como estática (GitHub Pages y similares) y no
 *     hay nadie al otro lado. Se carga `div2wasm.wasm`, que es el mismo núcleo
 *     de edición compilado a WebAssembly, y los ficheros los pone y los recoge
 *     el navegador: File System Access API si está, y si no, descargas y un
 *     `<input type="file">`.
 *
 * La detección es automática: si `/api/state` responde con un JSON válido, es
 * la versión local; en cualquier otro caso, la web.
 *
 * Cómo se guardan los ficheros en la versión web: el núcleo no escribe en un
 * disco, deja los bytes en una tabla. Antes de llamar se le «deja a la vista»
 * lo que tenga que leer (`stage`) y después se recogen los ficheros que haya
 * escrito, que se llevan a su destino (el «sumidero» registrado para ese
 * nombre, o una descarga si no lo hay).
 */
'use strict';

const Backend = (() => {
  const WASM_URL = 'div2wasm.wasm';

  const MIMES = {
    '.fpg': 'application/octet-stream',
    '.f16': 'application/octet-stream',
    '.map': 'application/octet-stream',
    '.m16': 'application/octet-stream',
    '.pal': 'application/octet-stream',
    '.fnt': 'application/octet-stream',
    '.txt': 'text/plain',
    '.png': 'image/png',
    '.bmp': 'image/bmp',
    '.pcx': 'image/x-pcx',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
  };

  const enc = (s) => new TextEncoder().encode(s);
  const dec = (b) => new TextDecoder().decode(b);

  let mode = null;   // 'local' | 'web'
  let wasm = null;   // exports del módulo WebAssembly
  let ready = null;  // promesa de init(), para no repetir la detección
  let webLane = Promise.resolve(); // cola de llamadas al núcleo WASM
  let webSeq = 1;    // id lógico de cada fichero abierto/guardado en la web

  /** Sumideros de escritura por nombre lógico: a dónde va lo que guarda el núcleo. */
  const sinks = new Map();
  /** Nombre visible por ruta lógica: evita colisiones entre ficheros con igual nombre. */
  const displayNames = new Map();

  // --------------------------------------------------------------- consultas

  function queryOf(params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== null && v !== undefined && v !== '') q.set(k, v);
    }
    return q;
  }

  function urlOf(path, params) {
    const q = queryOf(params).toString();
    return new URL(`${path}${q ? `?${q}` : ''}`, location.origin).toString();
  }

  const baseName = (p) => String(p || '').split(/[\\/]/).pop() || 'sin_titulo';
  const isLogicalPath = (p) => String(p || '').startsWith('__web__/');

  /** Ruta lógica interna para el núcleo WASM.
   *
   * El nombre visible se conserva al final para que `base_name()` siga sacando
   * algo útil, pero el prefijo único evita que dos `SPRITE.MAP` distintos se
   * pisen entre sí dentro de la sesión web.
   */
  function makeLogicalPath(display) {
    return `__web__/${webSeq++}/${baseName(display)}`;
  }

  function rememberDisplay(logical, display) {
    displayNames.set(logical, baseName(display));
    return logical;
  }

  function shownPath(path) {
    return isLogicalPath(path) ? (displayNames.get(path) || baseName(path)) : path;
  }

  // ------------------------------------------------------- versión local: HTTP

  async function localApi(path, params, opts) {
    const res = await fetch(urlOf(path, params), opts);
    let j;
    try {
      j = await res.json();
    } catch {
      throw new Error(`respuesta no válida del servidor (HTTP ${res.status})`);
    }
    if (!j.ok) throw new Error(j.error || `error HTTP ${res.status}`);
    return j;
  }

  async function localRaw(path, params, opts) {
    const res = await fetch(urlOf(path, params), opts);
    if (!res.ok) throw new Error(`no se han podido leer los datos (HTTP ${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  // ------------------------------------------------------- versión web: WASM

  /** Copia `bytes` a la memoria lineal y devuelve `{p, n}` para pasarlos. */
  function pass(bytes) {
    if (!bytes || !bytes.length) return { p: 0, n: 0 };
    const p = wasm.alloc(bytes.length);
    new Uint8Array(wasm.memory.buffer).set(bytes, p);
    return { p, n: bytes.length };
  }

  function free(a) {
    if (a.p) wasm.dealloc(a.p, a.n);
  }

  /** Reserva `n` bytes, deja que el núcleo escriba y devuelve lo escrito. */
  function pull(fn, n) {
    const size = n || 1;
    const p = wasm.alloc(size);
    const got = fn(p, size);
    // Se copia antes de liberar: a partir de `dealloc` ese trozo ya no es nuestro.
    const out = new Uint8Array(wasm.memory.buffer).slice(p, p + got);
    wasm.dealloc(p, size);
    return out;
  }

  /** Como el núcleo WebAssembly es único y comparte búferes de respuesta,
      todas las llamadas web pasan por una cola. Así no se pisan una miniatura,
      la lectura de píxeles y el cierre de otro documento. */
  function serialWeb(fn) {
    const run = webLane.then(fn, fn);
    webLane = run.catch(() => {});
    return run;
  }

  /** Ejecuta una petición contra el núcleo y devuelve la respuesta en crudo. */
  async function webCall(path, params, opts) {
    const r = await serialWeb(async () => {
      const method = ((opts && opts.method) || 'GET').toUpperCase();
      const body = opts && opts.body
        ? (opts.body instanceof Uint8Array ? opts.body : new Uint8Array(opts.body))
        : new Uint8Array(0);

      const m = enc(method);
      const op = enc(path.replace(/^\/api\//, ''));
      const q = enc(queryOf(params).toString());
      const md = pass(m);
      const od = pass(op);
      const qd = pass(q);
      const bd = pass(body);

      const rc = wasm.call(md.p, md.n, od.p, od.n, qd.p, qd.n, bd.p, bd.n);
      free(md); free(od); free(qd); free(bd);
      if (!rc) throw new Error('el núcleo ha rechazado la petición');

      const status = wasm.resp_status();
      const ctypeLen = wasm.resp_ctype_len();
      const ctype = ctypeLen ? dec(pull((p, c) => wasm.resp_ctype(p, c), ctypeLen)) : '';
      const bodyLen = wasm.resp_body_len();
      const data = bodyLen ? pull((p, c) => wasm.resp_body(p, c), bodyLen) : new Uint8Array(0);

      // Lo que el núcleo haya escrito (un guardado, una exportación) se copia
      // aquí, aún dentro de la cola: los bytes viven en su búfer compartido.
      const out = collectOutputs();

      return { status, ctype, bytes: data, out };
    });

    // La entrega va fuera de la cola: escribir en disco (o pedir permisos) no
    // debe congelar la edición mientras el núcleo queda libre para el siguiente
    // trazo.
    if (r.out.length) await deliverAll(r.out);

    return { status: r.status, ctype: r.ctype, bytes: r.bytes };
  }

  /** Recoge y vacía lo que el núcleo ha escrito. Devuelve `{name, data}`. */
  function collectOutputs() {
    const n = wasm.out_count();
    const out = [];
    for (let i = 0; i < n; i++) {
      const pl = wasm.out_path_len(i);
      const name = pl ? dec(pull((p, c) => wasm.out_path(i, p, c), pl)) : '';
      const dl = wasm.out_data_len(i);
      const data = dl ? pull((p, c) => wasm.out_data(i, p, c), dl) : new Uint8Array(0);
      out.push({ name, data });
    }
    if (n) wasm.clear_outputs();
    return out;
  }

  /** Lleva a su destino cada salida recogida. */
  async function deliverAll(out) {
    for (const o of out) await deliver(o.name, o.data);
  }

  async function deliver(name, data) {
    const blob = new Blob([data]);
    const sink = sinks.get(name);
    if (sink) {
      await sink(blob);
      return;
    }
    download(shownPath(name), blob);
  }

  /** Descarga de reserva: cuando no hay ningún sumidero para ese nombre. */
  function download(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'descarga';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function webApi(path, params, opts) {
    const r = await webCall(path, params, opts);
    let j;
    try {
      j = JSON.parse(dec(r.bytes));
    } catch {
      throw new Error(`respuesta no válida del núcleo (HTTP ${r.status})`);
    }
    if (!j.ok) throw new Error(j.error || `error del núcleo (HTTP ${r.status})`);
    if (j && typeof j.path === 'string') {
      j.path = shownPath(j.path);
      if (typeof j.name === 'string' && j.name === '') j.name = baseName(j.path);
    }
    return j;
  }

  async function webRaw(path, params, opts) {
    const r = await webCall(path, params, opts);
    if (r.status >= 400) {
      // Un error llega en JSON; se traduce a excepción como en la versión local.
      let msg = `error del núcleo (HTTP ${r.status})`;
      try { msg = JSON.parse(dec(r.bytes)).error || msg; } catch { /* se queda el genérico */ }
      throw new Error(msg);
    }
    return r.bytes;
  }

  /** Deja unos bytes a la vista del núcleo, como si estuvieran en el disco. */
  function stage(name, bytes, display) {
    if (mode !== 'web') return;
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (display) rememberDisplay(name, display);
    const d = pass(data);
    const nm = pass(enc(name));
    wasm.put_input(nm.p, nm.n, d.p, d.n);
    free(d); free(nm);
  }

  // -------------------------------------------------------- imágenes / miniaturas

  async function webImageUrl(path, params) {
    const p = { ...params };
    delete p.t; // el anti-caché del editor local aquí no pinta nada
    const r = await webCall(path, p, { method: 'GET' });
    if (r.status >= 400) return '';
    // La URL es de objeto: quien la pida tendrá que soltarla con
    // `URL.revokeObjectURL` cuando el PNG deje de valer. De eso se encarga
    // app.js, que es quien sabe cuándo cambia lo que hay en pantalla.
    return URL.createObjectURL(new Blob([r.bytes], { type: 'image/png' }));
  }

  // ------------------------------------------------------------ diálogo nativo

  const hasFsa = () => typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';

  function acceptOf(exts) {
    const acc = {};
    for (const e of exts) {
      const m = MIMES[e.toLowerCase()] || 'application/octet-stream';
      (acc[m] = acc[m] || []).push(e.toLowerCase());
    }
    return acc;
  }

  function typesOf(exts, description) {
    if (!exts || !exts.length) return undefined;
    return [{ description: description || 'Recursos', accept: acceptOf(exts) }];
  }

  /** Sumidero que escribe en un fichero elegido por el usuario. */
  function fileSink(handle) {
    return async (blob) => {
      if (handle.queryPermission) {
        let perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') throw new Error(`sin permiso para escribir en «${handle.name}»`);
      }
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
    };
  }

  /** Selector de apertura del navegador. Devuelve el nombre, ya «a la vista».
   *
   * Con `cfg.readOnly` no se recuerda el fichero como destino de escritura: es
   * lo que quiere una importación, que lee la imagen pero no guarda en ella. */
  async function pickOpen(cfg) {
    const exts = cfg.exts || [];
    if (hasFsa()) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: typesOf(exts, cfg.title),
          multiple: false,
        });
        const file = await handle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        const logical = makeLogicalPath(file.name);
        stage(logical, bytes, file.name);
        // Se recuerda el fichero para que Ctrl+S escriba ahí sin preguntar.
        if (!cfg.readOnly) sinks.set(logical, fileSink(handle));
        return logical;
      } catch (e) {
        if (e && e.name === 'AbortError') return null;
        throw e;
      }
    }

    // Reserva para navegadores sin File System Access API: <input type="file">.
    const file = await inputFile(exts);
    if (!file) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const logical = makeLogicalPath(file.name);
    stage(logical, bytes, file.name);
    return logical;
  }

  /** Selector de guardado del navegador. Devuelve el nombre, con destino listo. */
  async function pickSave(cfg) {
    const name = cfg.name || 'sin_titulo';
    const exts = cfg.exts || [];
    if (hasFsa()) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: typesOf(exts, cfg.title),
        });
        const chosen = handle.name || name;
        const logical = rememberDisplay(makeLogicalPath(chosen), chosen);
        sinks.set(logical, fileSink(handle));
        return logical;
      } catch (e) {
        if (e && e.name === 'AbortError') return null;
        throw e;
      }
    }
    // Sin FS Access API no hay fichero que recordar: al guardar se descargará.
    const logical = rememberDisplay(makeLogicalPath(name), name);
    sinks.set(logical, (blob) => download(shownPath(logical), blob));
    return logical;
  }

  function inputFile(exts) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (exts && exts.length) input.accept = exts.join(',');
      input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
      input.oncancel = () => resolve(null);
      input.click();
    });
  }

  // ------------------------------------------------------------------ arranque

  async function serverPresent() {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (!res.ok) return false;
      const j = await res.json();
      return !!(j && j.ok);
    } catch {
      return false;
    }
  }

  async function loadWasm() {
    const res = await fetch(WASM_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`no he podido cargar ${WASM_URL} (HTTP ${res.status})`);
    // Se instancia desde el búfer, no con `instantiateStreaming`: hay servidores
    // estáticos que no mandan el tipo MIME correcto para .wasm.
    const bytes = await res.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    wasm = instance.exports;
  }

  async function init() {
    if (ready) return ready;
    ready = (async () => {
      if (await serverPresent()) {
        mode = 'local';
      } else {
        mode = 'web';
        await loadWasm();
      }
      return mode;
    })();
    return ready;
  }

  // ------------------------------------------------------------------- fachada

  return {
    /** `'local'` o `'web'`; solo tiene valor después de `init()`. */
    get mode() { return mode; },

    init,

    async api(path, params, opts) {
      return mode === 'web' ? webApi(path, params, opts) : localApi(path, params, opts);
    },

    async raw(path, params, opts) {
      return mode === 'web' ? webRaw(path, params, opts) : localRaw(path, params, opts);
    },

    /** URL utilizable en `<img src>`. En la web es una URL de objeto temporal. */
    async imageUrl(path, params) {
      return mode === 'web' ? webImageUrl(path, params) : urlOf(path, params);
    },

    /** Selector de apertura del navegador. Devuelve el nombre ya «a la vista». */
    pickOpen,

    /** Selector de guardado del navegador. Devuelve el nombre con destino listo. */
    pickSave,
  };
})();
