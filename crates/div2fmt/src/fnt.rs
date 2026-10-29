//! Formato FNT: fuente de mapa de bits de 256 caracteres.
//!
//! Basado en la especificación del formato FNT de DIV/Fenix:
//! cabecera de 8 bytes, paleta de 1344 bytes, 4 bytes de flags, 256
//! descriptores de 16 bytes (ancho, alto, desplazamiento vertical y
//! desplazamiento de los datos) y, por último, el conjunto de datos de los
//! gráficos de los caracteres (`width * height` bytes cada uno).

use crate::palette::{Palette, PALETTE_SIZE};
use crate::{make_header, need, parse_header, rd_i32, rd_u32, Error, Result};

/// Número de caracteres (ASCII).
pub const FNT_GLYPHS: usize = 256;
/// Tamaño de cada descriptor de carácter.
pub const FNT_DESC_SIZE: usize = 16;
/// Offset donde empiezan los datos de píxeles: 8 + 1344 + 4 + 256*16 = 5452.
pub const FNT_DATA_OFFSET: usize = 8 + PALETTE_SIZE + 4 + FNT_GLYPHS * FNT_DESC_SIZE;

/// Descriptor de un carácter.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct FntGlyph {
    pub width: u32,
    pub height: u32,
    /// Desplazamiento vertical sobre la línea base (con signo).
    pub v_offset: i32,
    /// Offset absoluto del gráfico dentro del fichero.
    pub data_offset: u32,
}

/// Fuente completa.
#[derive(Clone, Debug)]
pub struct Fnt {
    pub palette: Palette,
    /// 4 bytes de flags (ignorados por DIV/Fenix, se conservan).
    pub flags: u32,
    /// Los 256 descriptores de carácter.
    pub glyphs: Vec<FntGlyph>,
    /// Bloque de datos de los gráficos, tal cual (a partir del offset 5452).
    pub data: Vec<u8>,
}

impl Fnt {
    /// Lee una fuente FNT a partir de sus bytes ya descomprimidos.
    pub fn read(bytes: &[u8]) -> Result<Fnt> {
        let magic = parse_header(bytes)?;
        if &magic != b"fnt" {
            return Err(Error::InvalidMagic(format!(
                "no es un FNT ({:?})",
                String::from_utf8_lossy(&magic)
            )));
        }

        let palette = Palette::from_bytes(need(bytes, 8, PALETTE_SIZE)?)?;
        let flags = rd_u32(bytes, 8 + PALETTE_SIZE)?;

        let mut glyphs = Vec::with_capacity(FNT_GLYPHS);
        let base = 8 + PALETTE_SIZE + 4;
        for i in 0..FNT_GLYPHS {
            let o = base + i * FNT_DESC_SIZE;
            glyphs.push(FntGlyph {
                width: rd_u32(bytes, o)?,
                height: rd_u32(bytes, o + 4)?,
                v_offset: rd_i32(bytes, o + 8)?,
                data_offset: rd_u32(bytes, o + 12)?,
            });
        }

        let data = bytes.get(FNT_DATA_OFFSET..).unwrap_or(&[]).to_vec();
        Ok(Fnt {
            palette,
            flags,
            glyphs,
            data,
        })
    }

    /// Serializa la fuente completa (round-trip byte a byte).
    pub fn write(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&make_header(b"fnt"));
        out.extend_from_slice(&self.palette.to_bytes());
        out.extend_from_slice(&self.flags.to_le_bytes());
        for g in self.glyphs.iter().take(FNT_GLYPHS) {
            out.extend_from_slice(&g.width.to_le_bytes());
            out.extend_from_slice(&g.height.to_le_bytes());
            out.extend_from_slice(&g.v_offset.to_le_bytes());
            out.extend_from_slice(&g.data_offset.to_le_bytes());
        }
        // Si por alguna razón hubiera menos de 256 descriptores, se rellena a cero.
        for _ in self.glyphs.len()..FNT_GLYPHS {
            out.extend_from_slice(&[0u8; FNT_DESC_SIZE]);
        }
        out.extend_from_slice(&self.data);
        out
    }

    /// Píxeles (índices de paleta) del carácter `index`, si los tiene.
    pub fn glyph_pixels(&self, index: usize) -> Option<&[u8]> {
        let g = self.glyphs.get(index)?;
        if g.width == 0 || g.height == 0 {
            return Some(&[]);
        }
        let rel = (g.data_offset as usize).checked_sub(FNT_DATA_OFFSET)?;
        let len = g.width as usize * g.height as usize;
        self.data.get(rel..rel + len)
    }
}
