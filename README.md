# FPG+ Edit

Editor y herramientas libres para los recursos gráficos de **DIV Games Studio 2**
(FPG, MAP, PAL y FNT). Se compone de un núcleo en Rust que lee y escribe los
formatos byte a byte, un editor de escritorio que se abre en el navegador y una
pequeña CLI para automatizar tareas.

Se compone de tres crates:

- **`div2fmt`** — librería con los parsers/serializadores, el renderizado a
  imágenes y la conversión a/desde PNG, BMP, PCX y JPEG. Soporta GZIP
  transparente (los ficheros pueden estar comprimidos sin extensión `.gz`).
- **`div2serve`** — editor: servidor HTTP local (solo `std`) que sirve la
  interfaz web y expone la API sobre el núcleo. Binario `fpgplusedit`.
- **`div2fpg`** — herramienta de línea de comandos (usa `clap`).

## Compilar

Requiere una toolchain GNU de Rust. Con `cargo` en el PATH:

```
cargo build --release
cargo test
```

Los binarios quedan en `target/release/` (`fpgplusedit.exe`, `div2fpg.exe`).

## Empaquetado release reproducible

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
- `README.md`
- `LICENSE`
- `SHA256SUMS.txt`

## El editor (`fpgplusedit`)

```
fpgplusedit [--port <n>] [--web <dir>] [--no-open]
```

Arranca un servidor en `127.0.0.1` (puerto 4711 por defecto) y abre el navegador
con la interfaz. La carpeta `web/` (interfaz) se busca junto al ejecutable o en
`web/` del proyecto; con `--web` se puede indicar otra ubicación.

Qué permite hacer:

- Abrir FPG (`fpg`/`f16`), MAP (`map`/`m16`), PAL y FNT del disco, con
  explorador de ficheros integrado.
- Ver los mapas/sprites del FPG con zoom entero (1×–8×), rejilla y lectura del
  píxel bajo el cursor (coordenada, RGB e índice de paleta).
- Editar la paleta de 256 colores (componentes de 0 a 63) con vista previa.
- Navegar los fotogramas de los mapas animados y los glifos de las fuentes.
- Importar imágenes (PNG, BMP, PCX, JPEG) como nuevos mapas de un FPG.
- Exportar mapas y fotogramas a PNG, BMP, PCX y JPEG.
- Crear FPG nuevos, guardar (conservando el GZIP original) y guardar como.

La interfaz está en `web/` (`index.html`, `style.css`, `app.js`), sin
dependencias externas.

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
