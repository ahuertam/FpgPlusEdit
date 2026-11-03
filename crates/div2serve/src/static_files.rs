//! Servido de los ficheros estáticos de la interfaz (`web/`).

use crate::http::{mime_for, percent_decode, Resp};
use std::path::{Component, Path, PathBuf};

/// Devuelve un fichero de la carpeta de la interfaz. Solo acepta rutas
/// relativas y «normales»: ni `..`, ni rutas absolutas o con prefijo de unidad
/// (que en Windows harían que `join` saltase fuera de `web/`).
pub fn serve(web: &Path, path: &str) -> Resp {
    let rel = percent_decode(path.trim_start_matches('/'));
    let rel = if rel.is_empty() { "index.html" } else { rel.as_str() };

    let candidate = Path::new(rel);
    let inside = !candidate.is_absolute()
        && candidate
            .components()
            .all(|c| matches!(c, Component::Normal(_)));
    if !inside {
        return Resp::err(403, "ruta no permitida");
    }

    let full: PathBuf = web.join(candidate);
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
