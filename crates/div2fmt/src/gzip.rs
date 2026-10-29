//! Compresión GZIP transparente para FPG/MAP/PAL/FNT.
//!
//! DIV Games Studio 2 (y Fenix) aceptan estos ficheros comprimidos con GZIP
//! sin necesidad de marcarlos con la extensión `.gz`. Al leer comprobamos los
//! dos primeros bytes (`1F 8B`) y descomprimimos si es necesario.

use crate::Result;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::{Read, Write};

/// Devuelve `true` si los datos empiezan por el magic de GZIP (`1F 8B`).
pub fn is_gzip(data: &[u8]) -> bool {
    data.len() >= 2 && data[0] == 0x1F && data[1] == 0x8B
}

/// Descomprime un flujo GZIP completo.
pub fn decompress(data: &[u8]) -> Result<Vec<u8>> {
    let mut decoder = GzDecoder::new(data);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out)?;
    Ok(out)
}

/// Comprime los datos en GZIP.
pub fn compress(data: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data)?;
    Ok(encoder.finish()?)
}

/// Devuelve los datos descomprimidos si están en GZIP, o los mismos bytes si no.
pub fn maybe_decompress(data: &[u8]) -> Result<Vec<u8>> {
    if is_gzip(data) {
        decompress(data)
    } else {
        Ok(data.to_vec())
    }
}
