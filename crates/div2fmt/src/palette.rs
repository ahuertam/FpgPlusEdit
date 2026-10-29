//! Paleta de color de 256 entradas (formato DIV de 6 bits por componente)
//! y lectura/escritura del fichero PAL.

use crate::{make_header, need, parse_header, Error, Result};

/// 256 colores × 3 componentes (R, G, B), cada componente en 0..=63.
pub const PAL_COLORS: usize = 768;
/// 256 entradas de tabla de gamas (256 × ~2.25 bytes; bloque opaco de 576).
pub const PAL_GAMMAS: usize = 576;
/// Tamaño total del bloque de paleta: 768 + 576 = 1344 bytes.
pub const PALETTE_SIZE: usize = PAL_COLORS + PAL_GAMMAS;

/// Paleta de 256 colores con su tabla de gamas.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Palette {
    /// Componentes RGB de 6 bits empaquetados como 3 bytes por color.
    pub colors: [u8; PAL_COLORS],
    /// Tabla de gamas conservada tal cual (no se interpreta).
    pub gammas: [u8; PAL_GAMMAS],
}

impl Default for Palette {
    /// Escala de grises neutra (útil como paleta de partida).
    fn default() -> Self {
        let mut colors = [0u8; PAL_COLORS];
        for i in 0..256usize {
            let v = (i as u32 * 63 / 255) as u8;
            colors[i * 3] = v;
            colors[i * 3 + 1] = v;
            colors[i * 3 + 2] = v;
        }
        Palette {
            colors,
            gammas: [0u8; PAL_GAMMAS],
        }
    }
}

impl Palette {
    pub fn new() -> Self {
        Self::default()
    }

    /// Componente lineal del formato (0..=63) -> 0..=255.
    #[inline]
    pub fn scale_to_8(v: u8) -> u8 {
        ((v as u16 * 255) / 63) as u8
    }

    /// Componente de 8 bits (0..=255) -> 0..=63.
    #[inline]
    pub fn scale_to_6(v: u8) -> u8 {
        ((v as u16 * 63 + 127) / 255) as u8
    }

    /// Componentes crudos (0..=63) de la entrada `index`.
    pub fn rgb(&self, index: usize) -> (u8, u8, u8) {
        let i = index * 3;
        (self.colors[i], self.colors[i + 1], self.colors[i + 2])
    }

    /// Fija los componentes crudos (0..=63) de la entrada `index`.
    pub fn set_rgb(&mut self, index: usize, r: u8, g: u8, b: u8) {
        let i = index * 3;
        self.colors[i] = r;
        self.colors[i + 1] = g;
        self.colors[i + 2] = b;
    }

    /// Componentes RGB ya escalados a 0..=255 (para conversión a imágenes).
    pub fn rgb8(&self, index: usize) -> [u8; 3] {
        let (r, g, b) = self.rgb(index);
        [
            Self::scale_to_8(r),
            Self::scale_to_8(g),
            Self::scale_to_8(b),
        ]
    }

    /// Paleta a partir de una lista RGB de 8 bits. La entrada 0 siempre
    /// queda transparente, así que `colors` se coloca a partir del índice
    /// indicado por `start`.
    pub fn from_rgb_list(colors: &[[u8; 3]], start: usize) -> Palette {
        let mut p = Palette {
            colors: [0u8; PAL_COLORS],
            gammas: [0u8; PAL_GAMMAS],
        };
        for (i, c) in colors.iter().enumerate() {
            let idx = start + i;
            if idx >= 256 {
                break;
            }
            p.set_rgb(
                idx,
                Self::scale_to_6(c[0]),
                Self::scale_to_6(c[1]),
                Self::scale_to_6(c[2]),
            );
        }
        p
    }

    /// Lee los 1344 bytes de un bloque de paleta.
    pub fn from_bytes(data: &[u8]) -> Result<Palette> {
        let block = need(data, 0, PALETTE_SIZE)?;
        let mut p = Palette {
            colors: [0u8; PAL_COLORS],
            gammas: [0u8; PAL_GAMMAS],
        };
        p.colors.copy_from_slice(&block[..PAL_COLORS]);
        p.gammas.copy_from_slice(&block[PAL_COLORS..]);
        Ok(p)
    }

    /// Serializa el bloque de paleta de 1344 bytes.
    pub fn to_bytes(&self) -> [u8; PALETTE_SIZE] {
        let mut out = [0u8; PALETTE_SIZE];
        out[..PAL_COLORS].copy_from_slice(&self.colors);
        out[PAL_COLORS..].copy_from_slice(&self.gammas);
        out
    }

    /// Vista RGBA8 de la paleta: 256 × 4 bytes. El índice 0 es transparente.
    pub fn to_rgba(&self) -> Vec<u8> {
        let mut out = vec![0u8; 256 * 4];
        for i in 0..256usize {
            let [r, g, b] = self.rgb8(i);
            out[i * 4] = r;
            out[i * 4 + 1] = g;
            out[i * 4 + 2] = b;
            out[i * 4 + 3] = if i == 0 { 0 } else { 255 };
        }
        out
    }

    /// Lee un fichero PAL completo (cabecera de 8 bytes + 1344 de paleta).
    pub fn read_pal_file(data: &[u8]) -> Result<Palette> {
        let magic = parse_header(data)?;
        if &magic != b"pal" {
            return Err(Error::InvalidMagic(format!(
                "se esperaba \"pal\" y se encontró {:?}",
                String::from_utf8_lossy(&magic)
            )));
        }
        Palette::from_bytes(&data[8..])
    }

    /// Serializa un fichero PAL completo (1352 bytes).
    pub fn write_pal_file(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(8 + PALETTE_SIZE);
        out.extend_from_slice(&make_header(b"pal"));
        out.extend_from_slice(&self.to_bytes());
        out
    }
}
