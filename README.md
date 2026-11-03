# FPG+ Edit

Editor y herramientas libres para los recursos gráficos de **DIV Games Studio 2**
(FPG, MAP, PAL y FNT). Se compone de un núcleo en Rust que lee y escribe los
formatos byte a byte, un editor gráfico que se abre en el navegador y una
pequeña CLI para automatizar tareas.

El editor existe en **dos versiones** que salen del mismo código y la misma
interfaz. Conviven en el repositorio y se eligen al compilar:

| | versión local | versión web |
|---|---|---|
| Arranque | `fpgplusedit.exe` (servidor HTTP en `127.0.0.1`) | se sube a un alojamiento estático |
| Núcleo | `div2serve` | `div2wasm.wasm` (WebAssembly) |
| Ficheros | los abre y guarda el servidor en el disco | los abre y guarda el navegador |
| Instalación | ninguna (Windows) | ninguna (solo un navegador) |
| Para qué | trabajar con ficheros del equipo | probar sin instalar nada, o publicar |

La interfaz (`web/`) es la misma en ambos casos. Al arrancar se pregunta a sí
misma si tiene un servidor detrás: si `/api/state` responde, va en modo local;
si no, carga el `.wasm` y pasa a modo web. De ahí que la misma carpeta `web/`
valga para las dos.

Se compone de cinco crates:

- **`div2fmt`** — librería con los parsers/serializadores, el renderizado a
  imágenes y la conversión a/desde PNG, BMP, PCX y JPEG. Soporta GZIP
  transparente (los ficheros pueden estar comprimidos sin extensión `.gz`).
- **`div2core`** — la lógica de edición (abrir, editar, guardar, exportar,
  importar…) sin saber dónde están los ficheros. Habla con el almacenamiento a
  través del rasgo `Fs`, y es lo que comparten las dos versiones.
- **`div2serve`** — versión local: servidor HTTP (solo `std`) que sirve la
  interfaz y expone la API sobre `div2core`, leyendo y escribiendo en el disco.
  Binario `fpgplusedit`.
- **`div2wasm`** — versión web: el mismo `div2core` compilado a WebAssembly,
  sin `wasm-bindgen` ni pegamento generado.
- **`div2fpg`** — herramienta de línea de comandos (usa `clap`).

## Compilar

Requiere una toolchain GNU de Rust. Con `cargo` en el PATH:

```
cargo build --release
cargo test
```

Los binarios quedan en `target/release/` (`fpgplusedit.exe`, `div2fpg.exe`). La
versión web necesita además el destino de WebAssembly:

```
rustup target add wasm32-unknown-unknown --toolchain stable-x86_64-pc-windows-gnu
```

## Empaquetado release reproducible

### Versión local (Windows)

Para generar siempre la misma carpeta de distribución, con el editor ya listo y
su `web/` al lado del ejecutable:

```powershell
.\build_release.ps1
```

Si además quieres validar el workspace antes de empaquetar:

```powershell
.\build_release.ps1 -RunTests
```

El script compila con `--release --locked` y deja el paquete en
`target\package\FPGPlusEdit-<version>-windows-gnu\`, con estos ficheros:

- `fpgplusedit.exe`
- `div2fpg.exe`
- `web\index.html`
- `web\style.css`
- `web\app.js`
- `web\backend.js`
- `README.md`
- `LICENSE`
- `SHA256SUMS.txt`

### Versión web (estática)

```powershell
.\build_web.ps1
```

Compila `div2wasm` a `wasm32-unknown-unknown` y monta una carpeta **estática** en
`target\package\FPGPlusEdit-<version>-web\` que se puede publicar tal cual, sin
servidor de aplicaciones:

- `index.html`
- `style.css`
- `app.js`
- `backend.js`
- `div2wasm.wasm`
- `LICENSE`

El script imprime el tamaño y el SHA256 del `.wasm`.

## La versión web

No hace falta instalar nada: la página lleva dentro el núcleo de edición
compilado a WebAssembly, así que los ficheros no pasan por ningún servidor.

**Probarla en local.** Hay que servirla por HTTP; una URL `file://` no vale,
porque el navegador no deja leer el `.wasm` desde el disco:

```powershell
cd target\package\FPGPlusEdit-0.1.0-web
python -m http.server 8000     # y abre http://localhost:8000/
```

**Publicarla.** Se copia el contenido de esa carpeta a cualquier alojamiento de
ficheros estáticos (GitHub Pages, Netlify, Cloudflare Pages, un Apache
cualquiera…). No necesita nada más: ni PHP, ni Node, ni base de datos.

**Cómo abre y guarda los ficheros.** Con la File System Access API
(`showOpenFilePicker`/`showSaveFilePicker`), que da acceso de escritura al
fichero elegido, de modo que `Ctrl+S` guarda encima sin preguntar. En los
navegadores que no la tienen (Firefox, Safari) se recurre a un
`<input type="file">` para abrir y a una descarga para guardar.

**Comprobación automática.** `tools/check-web.mjs` carga `web/backend.js` tal
cual lo carga la página, se queda en modo web y hace contra el núcleo
WebAssembly el mismo recorrido que haría alguien con el ratón: abrir
`BRUSH.FPG`, mirar sus mapas, pintar un píxel, guardar, exportar un PNG, soltar
un fichero y crear un FPG nuevo. Lo que más se vigila es que el fichero que
sale vuelva a ser idéntico al que entró.

```
cargo +stable-x86_64-pc-windows-gnu build --release --locked --target wasm32-unknown-unknown -p div2wasm
node tools/check-web.mjs
```

## El editor local (`fpgplusedit`)

```
fpgplusedit [--port <n>] [--web <dir>] [--no-open]
```

Arranca un servidor en `127.0.0.1` (puerto 4711 por defecto) y abre el navegador
con la interfaz. Aquí la interfaz va contra el servidor, así que los ficheros se
leen y se escriben en el disco del equipo. La carpeta `web/` se busca junto al
ejecutable o en `web/` del proyecto; con `--web` se puede indicar otra
ubicación.

Qué permite hacer:

- Abrir FPG (`fpg`/`f16`), MAP (`map`/`m16`), PAL y FNT del disco, con
  explorador de ficheros integrado o soltando el fichero sobre la ventana.
- Ver los mapas/sprites del FPG con zoom entero (1×–8×), rejilla y lectura del
  píxel bajo el cursor (coordenada, RGB e índice de paleta).
- Dibujar sobre el mapa como en un editor de píxeles: lápiz, aerógrafo, bote de
  pintura, formas, selección con recortes que se mueven y se fijan con Intro,
  capas y rotación libre, con deshacer y rehacer. Vale igual para mapas de 8 y
  de 16 bits.
- Trazos largos, como los del taller original: multilínea, curva de Bézier y
  multicurva se van marcando con clics y se cierran con Intro; el texto se
  estampa sobre el lienzo y la barra de punteado deja los trazos a cuadros.
- Puntas y estampas: se abre `BRUSH.FPG` de `SYSTEM` y sus puntas de varios
  colores se sellan tal cual; además, cualquier mapa del FPG puede hacer de
  textura repetida al pintar, con la opción de verla antes sobre el lienzo.
- Puntos de control del sprite sobre el propio lienzo (`Shift+F2`): se colocan
  con un clic y se mueven arrastrándolos, con X/Y a la vista. `K` abre el
  gráfico en una ventana aparte y lo copia al portapapeles.
- Crear y transformar mapas: mapa nuevo (en blanco, duplicado o añadido al FPG),
  redimensionar y recortar con anclaje, trocear en baldosas y convertir el FPG
  entero en un mural y al revés, con vista previa.
- Editar la paleta de 256 colores (componentes de 0 a 63) con vista previa.
- Navegar los fotogramas de los mapas animados y los glifos de las fuentes.
- Importar imágenes (PNG, BMP, PCX, JPEG) como nuevos mapas de un FPG.
- Exportar mapas y fotogramas a PNG, BMP, PCX y JPEG.
- Crear FPG nuevos, guardar (conservando el GZIP original) y guardar como.

La interfaz está en `web/` (`index.html`, `style.css`, `app.js` y `backend.js`),
sin dependencias externas. `backend.js` es la pieza que decide entre servidor y
WebAssembly; `app.js` no sabe en cuál de los dos está.

## Uso de la CLI

```
div2fpg list    <fichero>                     # lista los mapas de un FPG
div2fpg extract <fichero> [--out <dir>] [--format png|bmp] [--id <id>]
div2fpg create  <salida.fpg> <imagen...> [--gzip]
div2fpg add     <fichero.fpg> <imagen...>     # añade mapas
div2fpg remove  <fichero.fpg> <id...>         # elimina mapas por id
div2fpg palette <fichero> [--out <salida.pal>] [--png <salida.png>]
div2fpg map2png <fichero.map> <salida.png>
div2fpg info    <fichero>                     # cabecera y formato detectado
```

Ejemplos:

```
div2fpg info BRUSH.FPG
div2fpg extract BRUSH.FPG --out salida --format png
div2fpg create MI_FPG.fpg sprite1.png sprite2.png --gzip
div2fpg map2png HELP.MAP help.png
div2fpg palette DIV.PAL --out copia.pal --png paleta.png
```

En caso de error cada subcomando imprime un mensaje claro y sale con código
distinto de cero.

## Formatos

- **FPG**: contenedor de mapas/sprites (`fpg` a 8 bits con paleta común, `f16`
  a 16 bits sin paleta). Los bloques de mapa se leen hasta EOF.
- **MAP**: mapa individual (`map`/`m16`).
- **PAL**: paleta de 256 colores (6 bits por componente) + tabla de gamas.
- **FNT**: fuente de 256 caracteres con paleta y descriptores por carácter.

Los enteros son little-endian. El índice 0 de la paleta es transparente.

## Licencia

GPL-3.0-or-later. Ver [`LICENSE`](LICENSE).
