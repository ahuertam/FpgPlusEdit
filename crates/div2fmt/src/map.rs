//! Formato MAP: un único mapa (imagen) que puede ser de 8 o 16 bits.

use crate::fpg::{Animation, ControlPoint};
use crate::palette::{Palette, PALETTE_SIZE};
use crate::{make_header, name_str, need, parse_header, rd_i16, rd_u16, rd_u32, write_name, Error, Result};

/// Longitud del campo `name` de un MAP (igual que en FPG).
pub const MAP_NAME_LEN: usize = 32;

/// Un mapa individual con su paleta opcional.
#[derive(Clone, Debug)]
pub struct Map {
    pub width: i16,
    pub height: i16,
    pub code: u32,
    /// Nombre en crudo (padding tal cual estaba en el fichero).
    pub name_raw: [u8; MAP_NAME_LEN],
    /// Profundidad de color: 8 o 16.
    pub depth: u8,
    /// Paleta; solo en mapas de 8 bits.
    pub palette: Option<Palette>,
    pub points: Vec<ControlPoint>,
    pub animation: Option<Animation>,
    /// Datos de píxel en crudo.
    pub pixels: Vec<u8>,
}

impl Map {
    /// Nombre recortado en el primer NUL.
    pub fn name(&self) -> String {
        name_str(&self.name_raw)
    }

    /// Actualiza el nombre (String + campo crudo, rellenando con 0).
    pub fn set_name(&mut self, name: &str) {
        write_name(&mut self.name_raw, name);
    }

    /// Número de fotogramas de la animación (1 si no hay animación).
    pub fn frames(&self) -> usize {
        self.animation.as_ref().map(|a| a.frames as usize).unwrap_or(1)
    }

    /// Offset exacto donde empiezan los píxeles dentro del fichero.
    pub fn pixel_offset(&self) -> usize {
        let mut off = 8 + 2 + 2 + 4 + MAP_NAME_LEN; // magic + w + h + code + name
        if self.depth == 8 {
            off += PALETTE_SIZE;
        }
        off += 2; // n_flags
        off += self.points.len() * 4;
        if let Some(a) = &self.animation {
            off += 6 + a.length as usize * 2;
        }
        off
    }

    /// Valor de `n_flags` (2 bytes en MAP) reconstruido desde los componentes.
    fn flags(&self) -> u16 {
        (self.points.len() as u16 & 0x0FFF) | if self.animation.is_some() { 0x1000 } else { 0 }
    }

    /// Lee un MAP a partir de sus bytes ya descomprimidos.
    pub fn read(data: &[u8]) -> Result<Map> {
        let magic = parse_header(data)?;
        let depth = match &magic {
            b"map" => 8u8,
            b"m16" => 16u8,
            other => {
                return Err(Error::InvalidMagic(format!(
                    "no es un MAP ({:?}); se esperaba \"map\" o \"m16\"",
                    String::from_utf8_lossy(other)
                )))
            }
        };

        let width = rd_i16(data, 8)?;
        let height = rd_i16(data, 10)?;
        let code = rd_u32(data, 12)?;
        let mut name_raw = [0u8; MAP_NAME_LEN];
        name_raw.copy_from_slice(need(data, 16, MAP_NAME_LEN)?);

        let mut off = 48;
        let palette = if depth == 8 {
            let p = Palette::from_bytes(need(data, off, PALETTE_SIZE)?)?;
            off += PALETTE_SIZE;
            Some(p)
        } else {
            None
        };

        let n_flags = rd_u16(data, off)?;
        off += 2;

        let n_points = (n_flags & 0x0FFF) as usize;
        let mut points = Vec::with_capacity(n_points);
        for _ in 0..n_points {
            let x = rd_i16(data, off)?;
            let y = rd_i16(data, off + 2)?;
            points.push(ControlPoint { x, y });
            off += 4;
        }

        let mut animation = None;
        if n_flags & 0x1000 != 0 {
            let frames = rd_u16(data, off)?;
            let length = rd_u16(data, off + 2)?;
            let speed = rd_u16(data, off + 4)?;
            off += 6;
            let mut sequence = Vec::with_capacity(length as usize);
            for _ in 0..length {
                sequence.push(rd_i16(data, off)?);
                off += 2;
            }
            animation = Some(Animation {
                frames,
                length,
                speed,
                sequence,
            });
        }

        let frames_total = animation.as_ref().map(|a| a.frames as usize).unwrap_or(1);
        let bpp = if depth == 16 { 2 } else { 1 };
        let px_len = (width.max(0) as usize) * (height.max(0) as usize) * frames_total * bpp;
        let pixels = need(data, off, px_len)?.to_vec();

        Ok(Map {
            width,
            height,
            code,
            name_raw,
            depth,
            palette,
            points,
            animation,
            pixels,
        })
    }

    /// Serializa el MAP completo.
    pub fn write(&self) -> Vec<u8> {
        let mut out = Vec::new();
        let magic: &[u8; 3] = if self.depth == 16 { b"m16" } else { b"map" };
        out.extend_from_slice(&make_header(magic));
        out.extend_from_slice(&self.width.to_le_bytes());
        out.extend_from_slice(&self.height.to_le_bytes());
        out.extend_from_slice(&self.code.to_le_bytes());
        out.extend_from_slice(&self.name_raw);
        if self.depth == 8 {
            let pal = self.palette.clone().unwrap_or_default();
            out.extend_from_slice(&pal.to_bytes());
        }
        out.extend_from_slice(&self.flags().to_le_bytes());
        for p in &self.points {
            out.extend_from_slice(&p.x.to_le_bytes());
            out.extend_from_slice(&p.y.to_le_bytes());
        }
        if let Some(a) = &self.animation {
            out.extend_from_slice(&a.frames.to_le_bytes());
            out.extend_from_slice(&a.length.to_le_bytes());
            out.extend_from_slice(&a.speed.to_le_bytes());
            for s in &a.sequence {
                out.extend_from_slice(&s.to_le_bytes());
            }
        }
        out.extend_from_slice(&self.pixels);
        out
    }
}
