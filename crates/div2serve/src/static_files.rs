//! Servido de los ficheros estáticos de la interfaz (`web/`).

use crate::http::{mime_for, percent_decode, Resp};
use std::path::{Path, PathBuf};

/// Devuelve un fichero de la carpeta de la interfaz. Rechaza rutas con `..`.
pub fn serve(web: &Path, path: &str) -> Resp {
    let rel = percent_decode(path.trim_start_matches('/'));
    if rel.contains("..") {
        return Resp::err(403, "ruta no permitida");
    }
    let rel = if rel.is_empty() { "index.html" } else { rel.as_str() };

    let full: PathBuf = web.join(rel);
    let target = if full.is_dir() {
        full.join("index.html")
    } else {
        full
    };

    match std::fs::read(&target) {
        Ok(body) => Resp {
            status: 200,
            ctype: mime_for(target.to_string_lossy().as_ref()).to_string(),
            body,
        },
        Err(_) => Resp::err(404, &format!("no se encuentra {rel}")),
    }
}
