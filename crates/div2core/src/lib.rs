//! Lógica de edición de los recursos de DIV Games Studio 2.
//!
//! Este crate es el centro común de las dos versiones del editor:
//!
//! * el **editor local** (`div2serve` → `fpgplusedit.exe`), que lee y escribe
//!   ficheros del disco del usuario y sirve la interfaz por HTTP;
//! * la **versión web** (`div2wasm`), que hace lo mismo dentro del navegador
//!   con el mismo código compilado a WebAssembly.
//!
//! Todo lo que se puede resolver con bytes vive aquí. Lo único que se deja
//! fuera es el acceso al sistema de ficheros, que cada frontal resuelve con
//! su propio [`Fs`]: `div2serve` con `std::fs` y `div2wasm` con la File System
//! Access API del navegador.

pub mod route;
pub mod store;

pub use route::{route, MAX_POINTS};
pub use store::{Doc, Store};

use std::collections::HashMap;
use std::fmt::Display;
use std::str::FromStr;

/// Petición ya descompuesta, común a los dos frontales.
///
/// `path` es la ruta del endpoint tal y como la escribe la interfaz
/// (`/api/open`); [`route`] acepta también el nombre suelto (`open`), que es
/// lo cómodo cuando se llama desde WebAssembly.
pub struct Request {
    pub method: String,
    pub path: String,
    pub query: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl Request {
    /// Petición GET sin parámetros, a partir del nombre del endpoint.
    pub fn get(path: &str) -> Request {
        Request {
            method: "GET".to_string(),
            path: path.to_string(),
            query: HashMap::new(),
            body: Vec::new(),
        }
    }

    pub fn with_query(mut self, k: &str, v: impl Display) -> Request {
        self.query.insert(k.to_string(), v.to_string());
        self
    }

    /// Valor de un parámetro, tratando la cadena vacía como ausente.
    pub fn q(&self, k: &str) -> Option<&str> {
        self.query.get(k).map(|s| s.as_str()).filter(|s| !s.is_empty())
    }

    /// Parámetro numérico; `None` si falta o no encaja.
    pub fn qnum<T: FromStr>(&self, k: &str) -> Option<T> {
        self.query.get(k).and_then(|v| v.parse::<T>().ok())
    }
}

/// Respuesta lista para enviar (JSON, PNG o bytes en crudo).
pub struct Resp {
    pub status: u16,
    pub ctype: String,
    pub body: Vec<u8>,
}

impl Resp {
    pub fn json(status: u16, body: String) -> Resp {
        Resp {
            status,
            ctype: "application/json; charset=utf-8".to_string(),
            body: body.into_bytes(),
        }
    }

    pub fn png(body: Vec<u8>) -> Resp {
        Resp {
            status: 200,
            ctype: "image/png".to_string(),
            body,
        }
    }

    /// Respuesta binaria en crudo (búferes de píxeles, por ejemplo).
    pub fn bytes(ctype: &str, body: Vec<u8>) -> Resp {
        Resp {
            status: 200,
            ctype: ctype.to_string(),
            body,
        }
    }

    pub fn ok() -> Resp {
        Resp::json(200, "{\"ok\":true}".to_string())
    }

    pub fn err(status: u16, msg: &str) -> Resp {
        Resp::json(status, format!("{{\"ok\":false,\"error\":{}}}", jstr(msg)))
    }

    /// `true` si la respuesta es un error (para decidir si hay que recogerla).
    pub fn is_error(&self) -> bool {
        self.status >= 400
    }
}

/// Entrada de un directorio, tal y como la espera el diálogo de ficheros.
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub size: u64,
}

impl Entry {
    pub fn json(&self) -> String {
        format!(
            "{{\"name\":{},\"path\":{},\"dir\":{},\"size\":{}}}",
            jstr(&self.name),
            jstr(&self.path),
            self.dir,
            self.size
        )
    }
}

/// Acceso al almacenamiento, que cada frontal implementa a su manera.
///
/// El editor local lo resuelve con el disco; la versión web, con la File
/// System Access API del navegador (o, si no está disponible, dejando el
/// resultado en una bandeja para que la interfaz lo descargue).
pub trait Fs {
    fn read(&mut self, path: &str) -> std::io::Result<Vec<u8>>;
    fn write(&mut self, path: &str, data: &[u8]) -> std::io::Result<()>;
    fn list(&mut self, dir: &str) -> std::io::Result<Vec<Entry>>;

    /// Deja un fichero soltado donde corresponda y devuelve la ruta con la que
    /// queda registrado.
    ///
    /// En el editor local se copia a la carpeta temporal (el navegador nunca
    /// revela la ruta original de un fichero arrastrado). En la versión web no
    /// hay ninguna copia que hacer: el documento vive en memoria y el primer
    /// guardado pedirá destino, así que se devuelve el propio nombre.
    fn place_dropped(&mut self, name: &str, data: &[u8]) -> std::io::Result<String>;
}

/// Datos que el frontal aporta al enrutado y que no dependen de la edición.
pub struct Env {
    /// Carpeta del editor, que la interfaz usa para proponer rutas.
    pub home: String,
    /// Versión del editor, que se muestra en `/api/state`.
    pub version: String,
}

impl Env {
    pub fn new(home: impl Into<String>, version: impl Into<String>) -> Env {
        Env {
            home: home.into(),
            version: version.into(),
        }
    }
}

/// Escapa una cadena para incrustarla en JSON entre comillas.
pub fn jstr(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// Decodifica `%XX` y `+` de una cadena de URL.
pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(h), Some(l)) => {
                        out.push((h * 16 + l) as u8);
                        i += 3;
                    }
                    _ => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Último componente de una ruta, sea con separador de Windows o de Unix.
pub fn base_name(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}
