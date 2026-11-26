# Ficheros de prueba

Estos cuatro ficheros son el oráculo de las pruebas: son los ficheros del
sistema de **DIV Games Studio 2** (la carpeta `SYSTEM`), sin tocar ni un
byte.

| Fichero | Qué es | Tamaño |
|---|---|---|
| `BRUSH.FPG` | Las puntas del pincel del taller original: 20 mapas de 1×1 a 16×16 | 6026 bytes |
| `DIV.PAL` | La paleta por defecto de DIV | 1352 bytes |
| `HELP.FNT` | La fuente del sistema | 10822 bytes |
| `HELP.MAP` | El gráfico de la pantalla de ayuda, 320×200 | 65394 bytes |

## Por qué están aquí

El proyecto promete que abre, edita y vuelve a escribir estos ficheros sin
tocarlos ni un byte. Eso solo se puede comprobar contra los ficheros
reales, no contra unos inventados: son los que tienen los rarezas del
formato (el `regsize` que cuenta puntos de control y animación, la
compresión GZIP, los nombres con su relleno de espacios) y los que hay que
saber leer igual que DIV.

Las pruebas de
[`crates/div2fmt/tests/integration.rs`](../../crates/div2fmt/tests/integration.rs)
comprueban, entre otras cosas, que al releer y volver a escribir cada uno de
ellos sale un fichero idéntico byte a byte.

## Dónde vienen y qué licencia tienen

Son extractos de la carpeta `SYSTEM` de **DIV Games Studio 2**, el editor
que se repartía con la revista *El Poder de DIV* (Hobby Press, 1998-2001).
DIV Games Studio es *freeware*: se puede usar y copiar libremente, pero no
es software libre ni dominio público, y sus ficheros de datos son obra de
sus autores.

Están aquí sin modificar, solo como datos de prueba, y el proyecto entero
está bajo GPL-3.0-or-later.

**Si prefieres que el repositorio no redistribuya nada de DIV**, se pueden
sustituir por equivalentes generados con el propio núcleo
(`cargo run --example generar-ejemplos -p div2fpg` produce ficheros del
mismo formato). Se perdería una cosa: las pruebas dejarían de comprobar
contra los ficheros de verdad y pasarían a comprobar contra ficheros
parecidos, que es una comprobación más débil.
