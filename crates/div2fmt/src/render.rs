//! Conversión de mapas y fuentes al modelo de imagen, compartida por la CLI
//! y por la interfaz gráfica.
//!
//! Un mapa puede ser de 8 bits (índices sobre la paleta del contenedor) o de
//! 16 bits (RGB565 little-endian). En ambos casos el valor 0 se trata como
//! transparente, igual que hace DIV.

use crate::fnt::Fnt;
use crate::fpg::{Fpg, FpgMap};
use crate::imageio::{self, IndexedImage, RgbaImage};
use crate::map::Map;
use crate::Result;

/// Interpreta píxeles de 16 bits (RGB565 little-endian) como RGBA8.
/// El valor 0 se considera transparente, igual que el índice 0 en 8 bits.
pub fn rgb565_to_rgba(pixels: &[u8], w: usize, h: usize) -> RgbaImage {
    let mut data = vec![0u8; w * h * 4];
    for i in 0..w * h {
        let lo = pixels.get(i * 2).copied().unwrap_or(0) as u16;
        let hi = pixels.get(i * 2 + 1).copied().unwrap_or(0) as u16;
        let v = lo | (hi << 8);
        let r = ((v >> 11) & 0x1F) as u32;
        let g = ((v >> 5) & 0x3F) as u32;
        let b = (v & 0x1F) as u32;
        data[i * 4] = (r * 255 / 31) as u8;
        data[i * 4 + 1] = (g * 255 / 63) as u8;
        data[i * 4 + 2] = (b * 255 / 31) as u8;
        data[i * 4 + 3] = if v == 0 { 0 } else { 255 };
    }
    RgbaImage {
        width: w as u32,
        height: h as u32,
        data,
    }
}

/// Recorta de `pixels` el plano del fotograma indicado y lo rellena a cero.
fn frame_slice(pixels: &[u8], w: usize, h: usize, bpp: usize, frame: usize) -> Vec<u8> {
    let len = w * h * bpp;
    let start = frame * len;
    let mut out = pixels.get(start..start + len).unwrap_or(&[]).to_vec();
    out.resize(len, 0);
    out
}

/// Imagen indexada de un mapa de FPG (fotograma `frame`). Los mapas de 16 bits
/// se cuantizan a 256 colores, que es lo que permite escribir BMP/PCX.
pub fn fpgmap_to_indexed(fpg: &Fpg, m: &FpgMap, frame: usize) -> Result<IndexedImage> {
    let w = m.width.max(0) as usize;
    let h = m.height.max(0) as usize;
    if m.depth == 8 {
        Ok(IndexedImage {
            width: w as u32,
            height: h as u32,
            indices: frame_slice(&m.pixels, w, h, 1, frame),
            palette: fpg.palette.clone().unwrap_or_default(),
        })
    } else {
        let rgba = rgb565_to_rgba(&frame_slice(&m.pixels, w, h, 2, frame), w, h);
        Ok(imageio::rgba_to_indexed(&rgba, None))
    }
}

/// Imagen indexada de un MAP (fotograma `frame`).
pub fn map_to_indexed(m: &Map, frame: usize) -> Result<IndexedImage> {
    let w = m.width.max(0) as usize;
    let h = m.height.max(0) as usize;
    if m.depth == 8 {
        Ok(IndexedImage {
            width: w as u32,
            height: h as u32,
            indices: frame_slice(&m.pixels, w, h, 1, frame),
            palette: m.palette.clone().unwrap_or_default(),
        })
    } else {
        let rgba = rgb565_to_rgba(&frame_slice(&m.pixels, w, h, 2, frame), w, h);
        Ok(imageio::rgba_to_indexed(&rgba, None))
    }
}

/// Dibuja un mapa de FPG en RGBA8 (fotograma `frame`).
pub fn fpgmap_to_rgba(fpg: &Fpg, m: &FpgMap, frame: usize) -> RgbaImage {
    let w = m.width.max(0) as usize;
    let h = m.height.max(0) as usize;
    if m.depth == 8 {
        let img = IndexedImage {
            width: w as u32,
            height: h as u32,
            indices: frame_slice(&m.pixels, w, h, 1, frame),
            palette: fpg.palette.clone().unwrap_or_default(),
        };
        imageio::indexed_to_rgba(&img)
    } else {
        rgb565_to_rgba(&frame_slice(&m.pixels, w, h, 2, frame), w, h)
    }
}

/// Dibuja un MAP en RGBA8 (fotograma `frame`).
pub fn map_to_rgba(m: &Map, frame: usize) -> RgbaImage {
    let w = m.width.max(0) as usize;
    let h = m.height.max(0) as usize;
    if m.depth == 8 {
        let img = IndexedImage {
            width: w as u32,
            height: h as u32,
            indices: frame_slice(&m.pixels, w, h, 1, frame),
            palette: m.palette.clone().unwrap_or_default(),
        };
        imageio::indexed_to_rgba(&img)
    } else {
        rgb565_to_rgba(&frame_slice(&m.pixels, w, h, 2, frame), w, h)
    }
}

/// Dibuja el carácter `index` de una fuente FNT en RGBA8.
pub fn glyph_to_rgba(f: &Fnt, index: usize) -> RgbaImage {
    let g = match f.glyphs.get(index) {
        Some(g) => *g,
        None => return RgbaImage { width: 0, height: 0, data: Vec::new() },
    };
    let w = g.width as usize;
    let h = g.height as usize;
    if w == 0 || h == 0 {
        return RgbaImage { width: 0, height: 0, data: Vec::new() };
    }
    let mut indices = f.glyph_pixels(index).unwrap_or(&[]).to_vec();
    indices.resize(w * h, 0);
    imageio::indexed_to_rgba(&IndexedImage {
        width: w as u32,
        height: h as u32,
        indices,
        palette: f.palette.clone(),
    })
}
