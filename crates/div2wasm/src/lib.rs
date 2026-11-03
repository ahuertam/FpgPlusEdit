//! Versión web del editor: el núcleo de edición dentro del navegador.
//!
//! Este crate es el puente entre JavaScript y [`div2core`]. No hay
//! `wasm-bindgen` ni pegamento generado: el módulo expone unas pocas funciones
//! `extern "C"` y el llamante habla con ellas a través de la memoria lineal.
//!
//! La idea es que el enrutado del núcleo se use **tal cual**: la interfaz llama
//! a [`call`] con el mismo endpoint, los mismos parámetros y el mismo cuerpo
//! que usaría contra el servidor local, y recibe la misma respuesta (estado,
//! tipo de contenido y bytes). Lo único que cambia es de dónde salen los
//! ficheros y a dónde van, y eso lo resuelve [`WebFs`]:
//!
//! * antes de una llamada, la interfaz «deja» los ficheros que hagan falta con
//!   [`put_input`] (los bytes ya los tiene: vienen del selector o del arrastre);
//! * después de la llamada, recoge con `out_*` los ficheros que el núcleo ha
//!   escrito (un guardado, una exportación), que la interfaz lleva al disco con
//!   la File System Access API, o descarga, según el caso.
//!
//! Con esto, `div2core` no sabe si corre en un PC o en un pestaña del navegador.

use div2core::{Env, Entry, Fs, Request, Resp, Store};
use std::cell::RefCell;
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// estado del módulo
// ---------------------------------------------------------------------------

thread_local! {
    /// Documentos abiertos, igual que el `HashMap` del servidor local. En
    /// WebAssembly no hay hilos, así que basta con una copia por hilo.
    static STORE: RefCell<Store> = RefCell::new(Store::new());

    /// Ficheros «a la vista» del núcleo: lo que [`WebFs::read`] puede leer.
    /// La interfaz los deja ahí antes de llamar (bytes que ya tiene) y se
    /// actualizan cuando el núcleo escribe.
    static INPUTS: RefCell<HashMap<String, Vec<u8>>> = RefCell::new(HashMap::new());

    /// Ficheros que el núcleo ha escrito durante la última llamada, aún sin
    /// destino. La interfaz los recoge y decide qué hacer con ellos.
    static OUTPUTS: RefCell<Vec<(String, Vec<u8>)>> = RefCell::new(Vec::new());

    /// Última respuesta, lista para leer campo a campo.
    static RESP: RefCell<Option<Resp>> = const { RefCell::new(None) };
}

/// Almacenamiento de la versión web.
///
/// No hay disco: los ficheros viven en las tablas de arriba, que es lo poco
/// que el núcleo necesita para trabajar.
struct WebFs;

impl Fs for WebFs {
    fn read(&mut self, path: &str) -> std::io::Result<Vec<u8>> {
        INPUTS.with(|m| {
            m.borrow().get(path).cloned().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("«{path}» no está a la vista: ábrelo con el selector del navegador"),
                )
            })
        })
    }

    fn write(&mut self, path: &str, data: &[u8]) -> std::io::Result<()> {
        let bytes = data.to_vec();
        // Se deja también como entrada para que un `reload` posterior vea lo
        // mismo que vería el disco en el editor local.
        INPUTS.with(|m| {
            m.borrow_mut().insert(path.to_string(), bytes.clone());
        });
        OUTPUTS.with(|o| o.borrow_mut().push((path.to_string(), bytes)));
        Ok(())
    }

    fn list(&mut self, _dir: &str) -> std::io::Result<Vec<Entry>> {
        // El navegador no recorre carpetas: para abrir se usa su propio
        // selector de ficheros, así que este endpoint no llega a usarse.
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "la versión web abre los ficheros con el selector del navegador",
        ))
    }

    fn place_dropped(&mut self, name: &str, data: &[u8]) -> std::io::Result<String> {
        // No hay carpeta temporal donde copiar: el documento vive en memoria y
        // el primer guardado pedirá destino. Se deja a la vista por si acaso.
        INPUTS.with(|m| {
            m.borrow_mut().insert(name.to_string(), data.to_vec());
        });
        Ok(name.to_string())
    }
}

// ---------------------------------------------------------------------------
// memoria
// ---------------------------------------------------------------------------

/// Reserva `n` bytes y devuelve el puntero. Hay que liberarlos con `dealloc`.
#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    if n == 0 {
        return std::ptr::null_mut();
    }
    let mut v: Vec<u8> = Vec::with_capacity(n);
    let p = v.as_mut_ptr();
    // La capacidad se queda reservada a propósito: la libera `dealloc`.
    std::mem::forget(v);
    p
}

/// Libera un bloque pedido con `alloc` del mismo tamaño.
#[no_mangle]
pub extern "C" fn dealloc(p: *mut u8, n: usize) {
    if p.is_null() || n == 0 {
        return;
    }
    unsafe { drop(Vec::from_raw_parts(p, 0, n)) };
}

fn bytes_of(ptr: *const u8, len: usize) -> Vec<u8> {
    if ptr.is_null() || len == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec()
    }
}

fn str_of(ptr: *const u8, len: usize) -> String {
    String::from_utf8_lossy(&bytes_of(ptr, len)).into_owned()
}

/// Copia `data` en `out` (como mucho `cap` bytes) y devuelve lo copiado.
unsafe fn write_out(data: &[u8], out: *mut u8, cap: usize) -> usize {
    if out.is_null() {
        return 0;
    }
    let n = data.len().min(cap);
    if n > 0 {
        std::ptr::copy_nonoverlapping(data.as_ptr(), out, n);
    }
    n
}

// ---------------------------------------------------------------------------
// llamada al núcleo
// ---------------------------------------------------------------------------

/// Interpreta la consulta «k=v&k=v» tal y como la escribe la interfaz.
fn parse_query(s: &str) -> HashMap<String, String> {
    let mut q = HashMap::new();
    for pair in s.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        q.insert(div2core::percent_decode(k), div2core::percent_decode(v));
    }
    q
}

/// Ejecuta una petición contra el núcleo y deja la respuesta lista para leer.
///
/// Es el equivalente a una llamada a `/api/<op>` del editor local. Devuelve 1
/// si hay respuesta (aunque sea un error del núcleo, que se consulta con
/// [`resp_status`]) y 0 solo si los argumentos no tienen ni pies ni cabeza.
///
/// * `method` — `GET` o `POST`, que es lo que distingue leer de escribir en
///   `/api/pixels`;
/// * `op` — nombre del endpoint, con o sin el prefijo `/api/`;
/// * `query` — parámetros, ya codificados como en una URL;
/// * `body` — cuerpo binario (ficheros soltados, imágenes, rectángulos).
#[no_mangle]
pub extern "C" fn call(
    method_ptr: *const u8,
    method_len: usize,
    op_ptr: *const u8,
    op_len: usize,
    query_ptr: *const u8,
    query_len: usize,
    body_ptr: *const u8,
    body_len: usize,
) -> u32 {
    let op = str_of(op_ptr, op_len);
    if op.is_empty() {
        return 0;
    }
    let method = {
        let m = str_of(method_ptr, method_len);
        if m.is_empty() {
            "GET".to_string()
        } else {
            m
        }
    };
    let req = Request {
        method,
        path: op,
        query: parse_query(&str_of(query_ptr, query_len)),
        body: bytes_of(body_ptr, body_len),
    };
    let env = Env::new("", env!("CARGO_PKG_VERSION"));

    OUTPUTS.with(|o| o.borrow_mut().clear());
    let resp = STORE.with(|s| {
        let mut store = s.borrow_mut();
        div2core::route(&mut store, &req, &env, &mut WebFs)
    });
    RESP.with(|r| *r.borrow_mut() = Some(resp));
    1
}

/// Código de estado HTTP de la última respuesta (200, 400, 404…).
#[no_mangle]
pub extern "C" fn resp_status() -> u32 {
    RESP.with(|r| r.borrow().as_ref().map_or(0, |x| x.status as u32))
}

/// Longitud del tipo de contenido de la última respuesta.
#[no_mangle]
pub extern "C" fn resp_ctype_len() -> usize {
    RESP.with(|r| r.borrow().as_ref().map_or(0, |x| x.ctype.len()))
}

/// Copia el tipo de contenido en `out` y devuelve los bytes copiados.
#[no_mangle]
pub extern "C" fn resp_ctype(out: *mut u8, cap: usize) -> usize {
    RESP.with(|r| {
        let b = r.borrow();
        let Some(x) = b.as_ref() else { return 0 };
        unsafe { write_out(x.ctype.as_bytes(), out, cap) }
    })
}

/// Longitud del cuerpo de la última respuesta.
#[no_mangle]
pub extern "C" fn resp_body_len() -> usize {
    RESP.with(|r| r.borrow().as_ref().map_or(0, |x| x.body.len()))
}

/// Copia el cuerpo de la última respuesta en `out` y devuelve los bytes copiados.
///
/// Vale igual para JSON, PNG o un búfer de píxeles en crudo: manda el `ctype`.
#[no_mangle]
pub extern "C" fn resp_body(out: *mut u8, cap: usize) -> usize {
    RESP.with(|r| {
        let b = r.borrow();
        let Some(x) = b.as_ref() else { return 0 };
        unsafe { write_out(&x.body, out, cap) }
    })
}

// ---------------------------------------------------------------------------
// ficheros a la vista de la interfaz
// ---------------------------------------------------------------------------

/// Deja `data` accesible como `path` para las siguientes llamadas al núcleo.
///
/// Devuelve 1 si se ha guardado. La interfaz lo usa al abrir o arrastrar un
/// fichero: ya tiene los bytes, esto solo los pone donde el núcleo los busca.
#[no_mangle]
pub extern "C" fn put_input(
    path_ptr: *const u8,
    path_len: usize,
    data_ptr: *const u8,
    data_len: usize,
) -> u32 {
    let path = str_of(path_ptr, path_len);
    if path.is_empty() {
        return 0;
    }
    let data = bytes_of(data_ptr, data_len);
    INPUTS.with(|m| m.borrow_mut().insert(path, data));
    1
}

/// Olvida todo lo que había a la vista (al cerrar un documento, por ejemplo).
#[no_mangle]
pub extern "C" fn clear_inputs() {
    INPUTS.with(|m| m.borrow_mut().clear());
}

/// Número de ficheros que el núcleo ha escrito en la última llamada.
#[no_mangle]
pub extern "C" fn out_count() -> u32 {
    OUTPUTS.with(|o| o.borrow().len() as u32)
}

fn with_out<T>(idx: u32, f: impl FnOnce(&str, &[u8]) -> T) -> Option<T> {
    OUTPUTS.with(|o| {
        let b = o.borrow();
        b.get(idx as usize).map(|(p, d)| f(p.as_str(), d.as_slice()))
    })
}

/// Longitud de la ruta del fichero escrito número `idx`.
#[no_mangle]
pub extern "C" fn out_path_len(idx: u32) -> usize {
    with_out(idx, |p, _| p.len()).unwrap_or(0)
}

/// Copia la ruta del fichero escrito número `idx` y devuelve los bytes copiados.
#[no_mangle]
pub extern "C" fn out_path(idx: u32, out: *mut u8, cap: usize) -> usize {
    with_out(idx, |p, _| unsafe { write_out(p.as_bytes(), out, cap) }).unwrap_or(0)
}

/// Longitud del contenido del fichero escrito número `idx`.
#[no_mangle]
pub extern "C" fn out_data_len(idx: u32) -> usize {
    with_out(idx, |_, d| d.len()).unwrap_or(0)
}

/// Copia el contenido del fichero escrito número `idx` y devuelve lo copiado.
#[no_mangle]
pub extern "C" fn out_data(idx: u32, out: *mut u8, cap: usize) -> usize {
    with_out(idx, |_, d| unsafe { write_out(d, out, cap) }).unwrap_or(0)
}

/// Descarta los ficheros escritos (una vez la interfaz ya los ha colocado).
#[no_mangle]
pub extern "C" fn clear_outputs() {
    OUTPUTS.with(|o| o.borrow_mut().clear());
}
