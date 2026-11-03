//! Implementación de [`Fs`] sobre el disco del equipo.
//!
//! Es la única pieza que diferencia al editor local de la versión web: aquí se
//! lee y se escribe con `std::fs`, y el selector de ficheros puede recorrer
//! unidades y carpetas reales.

use div2core::{Entry, Fs};
use std::path::{Path, PathBuf};

/// Acceso al sistema de ficheros del equipo.
pub struct LocalFs {
    /// Carpeta del editor, usada como alternativa para los ficheros soltados.
    pub home: PathBuf,
}

impl LocalFs {
    pub fn new(home: impl Into<PathBuf>) -> LocalFs {
        LocalFs { home: home.into() }
    }
}

/// Carpeta donde se copian los ficheros soltados sobre la ventana.
///
/// Se prefiere el directorio temporal del sistema; si está en un volumen sin
/// espacio (habitual cuando el disco del sistema va al límite) se usa una
/// subcarpeta junto a la aplicación, que puede estar en otra unidad.
fn drop_dir(home: &Path) -> PathBuf {
    let sys = std::env::temp_dir().join("FPGPlusEdit");
    if std::fs::create_dir_all(&sys).is_ok() {
        // El sondeo reserva 1 MiB: un disco casi lleno deja pasar unos pocos
        // bytes y luego falla a mitad de la copia, que es lo que hay que evitar.
        let probe = sys.join(".probe");
        if std::fs::write(&probe, vec![0u8; 1024 * 1024]).is_ok() {
            let _ = std::fs::remove_file(&probe);
            return sys;
        }
        let _ = std::fs::remove_file(&probe);
    }
    let alt = home.join(".fpgplusedit-drops");
    let _ = std::fs::create_dir_all(&alt);
    alt
}

impl Fs for LocalFs {
    fn read(&mut self, path: &str) -> std::io::Result<Vec<u8>> {
        std::fs::read(path)
    }

    fn write(&mut self, path: &str, data: &[u8]) -> std::io::Result<()> {
        std::fs::write(path, data)
    }

    fn list(&mut self, dir: &str) -> std::io::Result<Vec<Entry>> {
        // Sin carpeta se listan las unidades montadas, que es la raíz del
        // selector de ficheros en Windows.
        if dir.is_empty() {
            let mut out = Vec::new();
            for c in b'A'..=b'Z' {
                let p = format!("{}:\\", c as char);
                if Path::new(&p).exists() {
                    out.push(Entry {
                        name: p.clone(),
                        path: p,
                        dir: true,
                        size: 0,
                    });
                }
            }
            return Ok(out);
        }

        let mut dirs = Vec::new();
        let mut files = Vec::new();
        for ent in std::fs::read_dir(dir)?.flatten() {
            let md = match ent.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let item = Entry {
                name: ent.file_name().to_string_lossy().into_owned(),
                path: ent.path().to_string_lossy().into_owned(),
                dir: md.is_dir(),
                size: md.len(),
            };
            if item.dir {
                dirs.push(item);
            } else {
                files.push(item);
            }
        }
        dirs.sort_by(|a, b| a.name.cmp(&b.name));
        files.sort_by(|a, b| a.name.cmp(&b.name));
        let mut all = dirs;
        all.extend(files);
        Ok(all)
    }

    fn place_dropped(&mut self, name: &str, data: &[u8]) -> std::io::Result<String> {
        let path = drop_dir(&self.home).join(name);
        std::fs::write(&path, data)?;
        Ok(path.to_string_lossy().into_owned())
    }
}
