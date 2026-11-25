/* Comprueba la versión web del editor sin abrir un navegador.
 *
 * Carga `web/backend.js` tal cual lo carga la página, se queda en el modo
 * «web» (el que no tiene servidor detrás) y hace contra el núcleo WebAssembly
 * el mismo recorrido que haría alguien con el ratón: abrir BRUSH.FPG, mirar sus
 * mapas, pintar un píxel, guardar, exportar un PNG, soltar un fichero y crear
 * un FPG nuevo.
 *
 * Lo que se comprueba con más ganas es que el fichero que sale vuelve a ser
 * idéntico al que entró: si esto pasa, el puente entre JavaScript y el núcleo
 * no se está dejando ningún byte por el camino.
 *
 * Necesita el módulo compilado antes:
 *
 *     cargo +stable-x86_64-pc-windows-gnu build --release --target wasm32-unknown-unknown -p div2wasm
 *     node tools/check-web.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');
const WEB = path.join(RAIZ, 'web');
const FIXTURES = path.join(RAIZ, 'tests', 'fixtures');
const WASM = path.join(RAIZ, 'target', 'wasm32-unknown-unknown', 'release', 'div2wasm.wasm');

let fallos = 0;
const ok = (nombre, cond, extra) => {
  if (cond) console.log('  ok   ' + nombre);
  else { fallos++; console.log('  FALLO ' + nombre + (extra !== undefined ? '  -> ' + extra : '')); }
};

/* Un fallo sin recoger (una promesa rechazada) volcaría la pila entera, y la
   pila incluye el `data:` URL con todo backend.js en base64. Se queda solo el
   mensaje, que es lo que sirve para arreglarlo. */
process.on('unhandledRejection', (e) => {
  console.error('\nFALLO inesperado: ' + (e && e.message ? e.message : e) + '\n');
  process.exit(1);
});
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const firma = (bytes) => Array.from(bytes.slice(0, 4)).join(' ');

if (!fs.existsSync(WASM)) {
  console.error(`No encuentro ${WASM}\nCompílalo primero (ver la cabecera de este fichero).`);
  process.exit(2);
}

/* ------------------------------------------------------------ disco de mentira */

/* Un `Map` nombre → bytes hace de disco duro: los selectores del navegador
   leen y escriben ahí, y así se puede mirar luego qué ha quedado escrito. */
const disco = new Map();

/* En el navegador los dos selectores devuelven un `FileSystemFileHandle`, que
   sabe leerse (`getFile`) y escribirse (`createWritable`). Aquí se imita esa
   misma pieza: la de apertura también puede escribir, porque `pickOpen` la
   recuerda como destino para que Ctrl+S guarde sin volver a preguntar. */

function escritor(nombre) {
  return async () => ({
    async write(blob) { disco.set(nombre, new Uint8Array(await blob.arrayBuffer())); },
    async close() {},
  });
}

function handleLectura(nombre) {
  return {
    name: nombre,
    async getFile() {
      // El `Blob` de Node no lleva nombre, así que se devuelve un objeto con la
      // misma forma que un `File` para que `pickOpen` lo trate igual.
      const bytes = disco.get(nombre);
      return {
        name: nombre,
        size: bytes.length,
        async arrayBuffer() { return bytes.slice().buffer; },
      };
    },
    createWritable: escritor(nombre),
  };
}

function handleEscritura(nombre) {
  return {
    name: nombre,
    createWritable: escritor(nombre),
  };
}

/** Nombre que devolverá el próximo selector de apertura. */
let proximo = null;
let destinos = 0;

globalThis.window = {
  async showOpenFilePicker() { return [handleLectura(proximo)]; },
  async showSaveFilePicker(opciones) { destinos++; return handleEscritura(opciones.suggestedName); },
};

/* El DOM que toca backend.js, reducido a lo imprescindible. */
globalThis.document = {
  createElement(tag) {
    if (tag === 'input') return { type: '', accept: '', click() {}, files: null };
    return { href: '', download: '', click() {}, remove() {} };
  },
  body: { append() {} },
};

/* Node no da URLs de objeto para `Blob` sin pasar por `node:buffer`; aquí solo
   hace falta que existan, porque lo que se comprueba es el PNG, no la URL. */
let objetos = 0;
URL.createObjectURL = () => `blob:memoria/${++objetos}`;
URL.revokeObjectURL = () => {};

/* `fetch` solo sirve el .wasm. Para cualquier otra dirección falla, que es justo
   lo que se encuentra la versión web: nadie atendiendo /api/. */
globalThis.fetch = async (url) => {
  if (String(url).endsWith('div2wasm.wasm')) {
    const bytes = fs.readFileSync(WASM);
    return { ok: true, status: 200, arrayBuffer: async () => bytes };
  }
  throw new TypeError('fetch failed');
};

/* ------------------------------------------------------------------- backend */

/* `backend.js` es un guion clásico (usa `<script src>`), así que se le añade la
   exportación y se importa como módulo, sin tocar el fichero original. */
const fuente = fs.readFileSync(path.join(WEB, 'backend.js'), 'utf8');
const modulo = await import(
  'data:text/javascript;base64,' + Buffer.from(`${fuente}\nexport { Backend };\n`, 'utf8').toString('base64')
);
const Backend = modulo.Backend;

const abrir = (nombre) => {
  disco.set(nombre, new Uint8Array(fs.readFileSync(path.join(FIXTURES, nombre))));
  return nombre;
};

/* -------------------------------------------------------------- las pruebas */

console.log('\n== 1. el editor se decide por la versión web ==');
const modo = await Backend.init();
ok('sin servidor que responda, arranca en modo web', modo === 'web', modo);

console.log('\n== 2. abrir BRUSH.FPG con el selector del navegador ==');
abrir('BRUSH.FPG');
proximo = 'BRUSH.FPG';
const elegido = await Backend.pickOpen({ exts: ['.fpg'], title: 'Abrir' });
ok('el selector da una ruta lógica para el nombre elegido', elegido.endsWith('/BRUSH.FPG'), elegido);
const elegido2 = await Backend.pickOpen({ exts: ['.fpg'], title: 'Abrir' });
ok('dos ficheros con el mismo nombre no comparten ruta lógica', elegido2 !== elegido, `${elegido} / ${elegido2}`);

const fpg = await Backend.api('/api/open', { path: elegido });
ok('el FPG se abre', fpg.ok === true && fpg.kind === 'fpg', fpg.error);
ok('trae los 20 mapas', fpg.maps.length === 20, fpg.maps.length);

const png = await Backend.raw('/api/image', { doc: fpg.doc, id: fpg.maps[5].id });
ok('la miniatura llega como PNG', firma(png) === '137 80 78 71', firma(png));

const url = await Backend.imageUrl('/api/image', { doc: fpg.doc, id: fpg.maps[5].id });
ok('la miniatura da una URL utilizable en un <img>', typeof url === 'string' && url.startsWith('blob:'), url);

console.log('\n== 3. guardar sin tocar nada devuelve el mismo fichero ==');
const antes = disco.get('BRUSH.FPG');
await Backend.api('/api/save', { doc: fpg.doc }, { method: 'POST' });
const despues = disco.get('BRUSH.FPG');
ok('los bytes son idénticos', sha(antes) === sha(despues), `${antes.length} → ${despues.length}`);
ok('y no se ha preguntado ningún destino nuevo', destinos === 0, destinos);

console.log('\n== 4. soltar un fichero (arrastrar y soltar) ==');
abrir('HELP.MAP');
const mapa = await Backend.api('/api/drop', { name: 'HELP.MAP' }, {
  method: 'POST',
  body: disco.get('HELP.MAP'),
});
ok('el MAP se abre por arrastre', mapa.ok === true && mapa.kind === 'map', mapa.error);
ok('queda marcado como copia (el primer guardado pedirá destino)', mapa.dropped === true);

const ALTO = 200, ANCHO = 320, X = 3, Y = 4;
const pixeles = await Backend.raw('/api/pixels', { doc: mapa.doc, id: 0, frame: 0 });
ok('llegan los 320×200 píxeles', pixeles.length === ANCHO * ALTO, pixeles.length);

const original = pixeles[Y * ANCHO + X];
const pintado = original === 7 ? 9 : 7;
await Backend.api('/api/pixels', { doc: mapa.doc, id: 0, frame: 0, x: X, y: Y, w: 1, h: 1 }, {
  method: 'POST',
  body: Uint8Array.of(pintado),
});
const releidos = await Backend.raw('/api/pixels', { doc: mapa.doc, id: 0, frame: 0 });
ok('el píxel pintado se vuelve a leer', releidos[Y * ANCHO + X] === pintado, releidos[Y * ANCHO + X]);

console.log('\n== 5. guardar el MAP editado cambia un solo byte ==');
proximo = null;
const destino = await Backend.pickSave({ name: 'SALIDA.MAP', exts: ['.map'] });
ok('el selector de guardado da un destino', destino.endsWith('/SALIDA.MAP'), destino);
await Backend.api('/api/save', { doc: mapa.doc, path: destino }, { method: 'POST' });

const guardado = disco.get('SALIDA.MAP');
const fuenteMap = disco.get('HELP.MAP');
let distintos = 0;
for (let i = 0; i < guardado.length; i++) if (guardado[i] !== fuenteMap[i]) distintos++;
ok('el fichero guardado mide lo mismo', guardado.length === fuenteMap.length,
  `${guardado.length} vs ${fuenteMap.length}`);
ok('solo ha cambiado el píxel pintado', distintos === 1, distintos);

console.log('\n== 6. exportar a PNG ==');
const salida = await Backend.pickSave({ name: 'mapa_0000.png', exts: ['.png', '.bmp', '.pcx', '.jpg'] });
await Backend.api('/api/export', { doc: mapa.doc, id: 0, path: salida, format: 'png' }, { method: 'POST' });
ok('el PNG exportado tiene cabecera de PNG', firma(disco.get('mapa_0000.png')) === '137 80 78 71',
  firma(disco.get('mapa_0000.png')));

console.log('\n== 7. los otros tipos de documento ==');
abrir('DIV.PAL');
proximo = 'DIV.PAL';
const pal = await Backend.api('/api/open', { path: await Backend.pickOpen({ exts: ['.pal'] }) });
ok('el PAL se abre', pal.ok === true && pal.kind === 'pal', pal.error);
await Backend.api('/api/save', { doc: pal.doc }, { method: 'POST' });
ok('el PAL vuelve a salir idéntico', sha(disco.get('DIV.PAL')) === sha(new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'DIV.PAL')))));

abrir('HELP.FNT');
proximo = 'HELP.FNT';
const fnt = await Backend.api('/api/open', { path: await Backend.pickOpen({ exts: ['.fnt'] }) });
ok('el FNT se abre', fnt.ok === true && fnt.kind === 'fnt', fnt.error);
const glifo = await Backend.raw('/api/glyph', { doc: fnt.doc, ch: 65 });
ok('el glifo llega como PNG', firma(glifo) === '137 80 78 71', firma(glifo));

console.log('\n== 8. crear un FPG nuevo y volver a abrirlo ==');
const nuevoNombre = await Backend.pickSave({ name: 'NUEVO.FPG', exts: ['.fpg'] });
const nuevo = await Backend.api('/api/new', {
  path: nuevoNombre, kind: 'fpg', w: 32, h: 32,
}, { method: 'POST' });
ok('el FPG se crea', nuevo.ok === true && nuevo.kind === 'fpg', nuevo.error);
ok('con un primer mapa del tamaño pedido',
  nuevo.maps.length === 1 && nuevo.maps[0].width === 32 && nuevo.maps[0].height === 32,
  nuevo.maps && nuevo.maps[0] && `${nuevo.maps[0].width}×${nuevo.maps[0].height}`);
ok('y se ha escrito en el destino elegido', disco.has('NUEVO.FPG'));

proximo = 'NUEVO.FPG';
const reabierto = await Backend.api('/api/open', { path: await Backend.pickOpen({ exts: ['.fpg'] }) });
ok('el recién creado se vuelve a abrir con los mismos mapas',
  reabierto.ok === true && reabierto.maps.length === nuevo.maps.length,
  `${reabierto.maps && reabierto.maps.length} vs ${nuevo.maps.length}`);

console.log('\n== 9. crear un MAP suelto en blanco ==');
const mapDestino = await Backend.pickSave({ name: 'BLANCO.MAP', exts: ['.map'] });
const blanco = await Backend.api('/api/new', {
  path: mapDestino, kind: 'map', w: 32, h: 24, name: 'BLANCO',
}, { method: 'POST' });
ok('el MAP se crea', blanco.ok === true && blanco.kind === 'map', blanco.error);
ok('sale con las medidas pedidas', blanco.width === 32 && blanco.height === 24,
  `${blanco.width}×${blanco.height}`);
ok('y queda escrito en el destino', disco.has('BLANCO.MAP'));

console.log('\n== 9b. el resto de tipos de «Nuevo»: PAL, FNT, 16 bits ==');
const palDestino = await Backend.pickSave({ name: 'NUEVA.PAL', exts: ['.pal'] });
const palNueva = await Backend.api('/api/new', { path: palDestino, kind: 'pal' }, { method: 'POST' });
ok('la PAL en blanco se crea', palNueva.ok === true && palNueva.kind === 'pal', palNueva.error);
ok('y queda escrita en el destino', disco.has('NUEVA.PAL'));

const fntDestino = await Backend.pickSave({ name: 'NUEVA.FNT', exts: ['.fnt'] });
const fntNueva = await Backend.api('/api/new', { path: fntDestino, kind: 'fnt' }, { method: 'POST' });
ok('el FNT en blanco se crea', fntNueva.ok === true && fntNueva.kind === 'fnt', fntNueva.error);
proximo = 'NUEVA.FNT';
const fntReabierta = await Backend.api('/api/open', { path: await Backend.pickOpen({ exts: ['.fnt'] }) });
ok('el FNT en blanco se vuelve a abrir', fntReabierta.ok === true && fntReabierta.kind === 'fnt',
  fntReabierta.error);

const f16Destino = await Backend.pickSave({ name: 'NUEVO16.F16', exts: ['.f16'] });
const f16Nuevo = await Backend.api('/api/new', {
  path: f16Destino, kind: 'f16', w: 16, h: 16,
}, { method: 'POST' });
ok('el FPG de 16 bits nace con su primer mapa',
  f16Nuevo.ok === true && f16Nuevo.kind === 'fpg' && f16Nuevo.maps.length === 1, f16Nuevo.error);

const m16Destino = await Backend.pickSave({ name: 'NUEVO16.M16', exts: ['.m16'] });
const m16Nuevo = await Backend.api('/api/new', {
  path: m16Destino, kind: 'm16', w: 16, h: 16,
}, { method: 'POST' });
ok('el MAP de 16 bits sale con sus medidas',
  m16Nuevo.ok === true && m16Nuevo.kind === 'map' && m16Nuevo.width === 16 && m16Nuevo.height === 16,
  m16Nuevo.error);

console.log('\n== 10. duplicar y añadir mapas dentro de un FPG ==');
const antesAdd = fpg.maps.length;
const orig = fpg.maps[5].id;
const dup = await Backend.api('/api/map_add', { doc: fpg.doc, from: orig, name: 'COPIA' }, { method: 'POST' });
ok('la copia se añade', dup.ok === true, dup.error);
ok('el FPG tiene ahora un mapa más', dup.maps.length === antesAdd + 1, dup.maps.length);
const copia = dup.maps.find((m) => m.id === dup.new_id);
ok('el mapa clonado conserva el tamaño del original',
  copia && copia.width === fpg.maps[5].width && copia.height === fpg.maps[5].height,
  copia ? `${copia.width}×${copia.height}` : 'no encontrado');

const vacio = await Backend.api('/api/map_add', { doc: fpg.doc, w: 8, h: 8 }, { method: 'POST' });
ok('también se puede añadir un mapa vacío 8×8',
  vacio.ok === true && vacio.maps.find((m) => m.id === vacio.new_id)?.width === 8,
  vacio.error);

console.log('\n== 11. redimensionar un mapa (recorte con ancla) ==');
const nuevoId = vacio.new_id;
const redim = await Backend.api('/api/map_resize', { doc: fpg.doc, id: nuevoId, w: 16, h: 12, anchor: 'mc' }, { method: 'POST' });
const redimMap = redim.maps.find((m) => m.id === nuevoId);
ok('el mapa cambia de tamaño', redim.ok === true && redimMap && redimMap.width === 16 && redimMap.height === 12,
  redimMap ? `${redimMap.width}×${redimMap.height}` : redim.error);

console.log('\n== 12. trocear un mapa en baldosas ==');
const antesSplit = redim.maps.length;
const split = await Backend.api('/api/map_split', { doc: fpg.doc, id: nuevoId, w: 8, h: 6 }, { method: 'POST' });
ok('el troceado añade mapas nuevos', split.ok === true && split.maps.length > antesSplit,
  `${antesSplit} → ${split.maps && split.maps.length}`);
ok('y devuelve el id de la primera baldosa', typeof split.new_id === 'number' && split.new_id > 0, split.new_id);

console.log('\n== 13. mural: FPG entero a un mapa ==');
const muralPng = await Backend.raw('/api/mural', { doc: fpg.doc });
ok('la vista previa del mural llega como PNG', firma(muralPng) === '137 80 78 71', firma(muralPng));

const antesMural = split.maps.length;
const mural = await Backend.api('/api/mural_new', { doc: fpg.doc, name: 'MURAL' }, { method: 'POST' });
ok('el mural se añade como mapa nuevo', mural.ok === true && mural.maps.length === antesMural + 1,
  mural.error);
const muralMap = mural.maps.find((m) => m.id === mural.new_id);
ok('el mapa del mural cubre todos los originales',
  muralMap && muralMap.width >= Math.max(...fpg.maps.map((m) => m.width)),
  muralMap ? `${muralMap.width}×${muralMap.height}` : 'no encontrado');

console.log('\n== 14. el FPG tocado se guarda y se vuelve a abrir ==');
const tocaDestino = await Backend.pickSave({ name: 'TOCADO.FPG', exts: ['.fpg'] });
await Backend.api('/api/save', { doc: fpg.doc, path: tocaDestino }, { method: 'POST' });
ok('el FPG modificado se escribe', disco.has('TOCADO.FPG'));
proximo = 'TOCADO.FPG';
const recargado = await Backend.api('/api/open', { path: await Backend.pickOpen({ exts: ['.fpg'] }) });
ok('y al reabrirlo siguen estando todos los mapas',
  recargado.ok === true && recargado.maps.length === mural.maps.length,
  `${recargado.maps && recargado.maps.length} vs ${mural.maps.length}`);

console.log('');
if (fallos) {
  console.log(`HAN FALLADO ${fallos} COMPROBACIONES\n`);
  process.exit(1);
}
console.log('Todo correcto: la versión web funciona de punta a punta.\n');
