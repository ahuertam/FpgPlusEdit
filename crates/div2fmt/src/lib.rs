//! Núcleo de lectura/escritura de los formatos de DIV Games Studio 2.
//!
//! Soporta los contenedores FPG (mapas/sprites), MAP (mapa individual),
//! PAL (paleta) y FNT (fuente de caracteres), además de utilidades de
//! conversión entre imágenes indexadas/paleta y PNG/BMP/PCX/JPEG.
//!
//! Todos los enteros del formato son little-endian. Los ficheros pueden
//! venir comprimidos con GZIP de forma transparente (ver [`gzip`]).

pub mod error;
pub mod fnt;
pub mod fpg;
pub mod gzip;
pub mod imageio;
pub mod map;
pub mod palette;
pub mod render;

pub use error::{Error, Result};
pub use fnt::{Fnt, FntGlyph};
pub use fpg::{Animation, ControlPoint, Fpg, FpgMap};
pub use map::Map;
pub use palette::{Palette, PALETTE_SIZE};

/// Cola común de las cabeceras de 8 bytes: los 4 bytes `1Ah 0Dh 0Ah 00h`
/// (fin de fichero lógico para MS-DOS) más el byte de versión `00h`.
pub(crate) const HEADER_TAIL: [u8; 5] = [0x1A, 0x0D, 0x0A, 0x00, 0x00];

/// Devuelve la subrebanada `data[off..off+len]` o un error de truncamiento.
pub(crate) fn need(data: &[u8], off: usize, len: usize) -> Result<&[u8]> {
    data.get(off..off + len).ok_or(Error::UnexpectedEof {
        expected: off + len,
        got: data.len(),
    })
}

pub(crate) fn rd_u16(data: &[u8], off: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(need(data, off, 2)?.try_into().unwrap()))
}

pub(crate) fn rd_i16(data: &[u8], off: usize) -> Result<i16> {
    Ok(i16::from_le_bytes(need(data, off, 2)?.try_into().unwrap()))
}

pub(crate) fn rd_u32(data: &[u8], off: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(need(data, off, 4)?.try_into().unwrap()))
}

pub(crate) fn rd_i32(data: &[u8], off: usize) -> Result<i32> {
    Ok(i32::from_le_bytes(need(data, off, 4)?.try_into().unwrap()))
}

/// Comprueba la cabecera de 8 bytes y devuelve el magic de 3 caracteres.
pub(crate) fn parse_header(data: &[u8]) -> Result<[u8; 3]> {
    let magic = need(data, 0, 3)?;
    if need(data, 3, 5)? != HEADER_TAIL {
        return Err(Error::InvalidMagic(
            "falta la terminación 1A 0D 0A 00 00 tras el magic".to_string(),
        ));
    }
    Ok([magic[0], magic[1], magic[2]])
}

/// Construye la cabecera de 8 bytes a partir del magic de 3 caracteres.
pub(crate) fn make_header(magic: &[u8; 3]) -> [u8; 8] {
    let mut h = [0u8; 8];
    h[0..3].copy_from_slice(magic);
    h[3..8].copy_from_slice(&HEADER_TAIL);
    h
}

/// Recorta un campo de nombre/fichero por el primer NUL. Si no hay NUL,
/// se devuelve el campo completo convertido de forma tolerante.
pub(crate) fn name_str(raw: &[u8]) -> String {
    let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
    String::from_utf8_lossy(&raw[..end]).into_owned()
}

/// Copia un nombre a un campo de tamaño fijo, rellenando el resto con ceros.
pub(crate) fn write_name(dst: &mut [u8], name: &str) {
    dst.fill(0);
    let bytes = name.as_bytes();
    let n = bytes.len().min(dst.len());
    dst[..n].copy_from_slice(&bytes[..n]);
}
