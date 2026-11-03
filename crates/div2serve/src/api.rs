//! Puente entre el servidor HTTP local y el núcleo de edición.
//!
//! Toda la lógica de lectura, edición y escritura de los recursos vive en
//! [`div2core`], compartida con la versión web. Aquí solo queda lo propio del
//! frontal local: el almacén de documentos abiertos (protegido con un cerrojo,
//! porque el servidor atiende varias conexiones a la vez) y el [`LocalFs`] que
//! lee y escribe en el disco.

use crate::fs::LocalFs;
use div2core::{Env, Request, Resp, Store};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

fn store() -> &'static Mutex<Store> {
    static S: OnceLock<Mutex<Store>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Store::new()))
}

/// Atiende una petición de la interfaz local.
pub fn route(req: &Request, home: &Path) -> Resp {
    let env = Env::new(home.to_string_lossy().into_owned(), env!("CARGO_PKG_VERSION"));
    let mut fs = LocalFs::new(home.to_path_buf());
    let mut store = store().lock().unwrap();
    div2core::route(&mut store, req, &env, &mut fs)
}
