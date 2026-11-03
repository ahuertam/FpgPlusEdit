//! Contenedor FPG: colección de mapas/sprites con una paleta común (8 bits)
//! o sin paleta (16 bits).

use crate::palette::{Palette, PALETTE_SIZE};
use crate::{make_header, name_str, need, parse_header, rd_i32, rd_u16, rd_u32, write_name, Error, Result};

/// Longitud del campo `name` de un bloque FPG.
pub const FPG_NAME_LEN: usize = 32;
/// Longitud del campo `filename` de un bloque FPG.
pub const FPG_FILENAME_LEN: usize = 12;
/// Tamaño de la cabecera de bloque: 4+4+32+12+4+4+4 = 64 bytes.
pub const FPG_BLOCK_HEADER: usize = 64;

/// Punto de control de un mapa. El valor -1/-1 significa "no definido".
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ControlPoint {
    pub x: i16,
    pub y: i16,
}

/// Animación de un mapa (presente solo si el flag 0x1000 está activo).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Animation {
    pub frames: u16,
    pub length: u16,
    pub speed: u16,
    pub sequence: Vec<i16>,
}

/// Un mapa (sprite) dentro de un FPG.
#[derive(Clone, Debug)]
pub struct FpgMap {
    pub code: u32,
    /// Nombre en crudo (puede contener basura de relleno tras el NUL).
    pub name_raw: [u8; FPG_NAME_LEN],
    /// Nombre de fichero en crudo.
    pub filename_raw: [u8; FPG_FILENAME_LEN],
    pub width: i32,
    pub height: i32,
    pub points: Vec<ControlPoint>,
    pub animation: Option<Animation>,
    /// Datos de píxel en crudo (índices o valores de 16 bits little-endian).
    pub pixels: Vec<u8>,
    /// Profundidad de color del contenedor: 8 o 16.
    pub depth: u8,
}

impl FpgMap {
    /// Crea un mapa vacío (píxeles a cero) de las dimensiones indicadas.
    pub fn new(code: u32, width: i32, height: i32, depth: u8) -> FpgMap {
        let bpp = if depth == 16 { 2 } else { 1 };
        let len = (width.max(0) as usize) * (height.max(0) as usize) * bpp;
        FpgMap {
            code,
            name_raw: [0u8; FPG_NAME_LEN],
            filename_raw: [0u8; FPG_FILENAME_LEN],
            width,
            height,
            points: Vec::new(),
            animation: None,
            pixels: vec![0u8; len],
            depth,
        }
    }

    /// Nombre recortado en el primer NUL.
    pub fn name(&self) -> String {
        name_str(&self.name_raw)
    }

    /// Nombre de fichero recortado en el primer NUL.
    pub fn filename(&self) -> String {
        name_str(&self.filename_raw)
    }

    /// Actualiza el nombre (String + campo crudo, rellenando con 0).
    pub fn set_name(&mut self, name: &str) {
        write_name(&mut self.name_raw, name);
    }

    /// Actualiza el nombre de fichero (String + campo crudo).
    pub fn set_filename(&mut self, filename: &str) {
        write_name(&mut self.filename_raw, filename);
    }

    /// Número de fotogramas de la animación (1 si no hay animación).
    pub fn frames(&self) -> usize {
        self.animation.as_ref().map(|a| a.frames as usize).unwrap_or(1)
    }

    /// Tamaño del bloque completo: cabecera + puntos + animación + píxeles.
    ///
    /// Coincide con el `regsize` que escriben las herramientas originales (los
    /// puntos y la animación forman parte del registro), de modo que guardar un
    /// FPG sin cambios reproduce el fichero byte a byte.
    pub fn regsize(&self) -> u32 {
        let mut len = FPG_BLOCK_HEADER + self.pixels.len() + self.points.len() * 4;
        if let Some(a) = &self.animation {
            len += 6 + a.sequence.len() * 2;
        }
        len as u32
    }

    /// Valor de `n_flags` (4 bytes en FPG) reconstruido desde los componentes.
    fn flags(&self) -> u16 {
        (self.points.len() as u16 & 0x0FFF) | if self.animation.is_some() { 0x1000 } else { 0 }
    }
}

/// Contenedor FPG completo.
#[derive(Clone, Debug)]
pub struct Fpg {
    /// 8 u 16 bits.
    pub depth: u8,
    /// Paleta común; solo presente en FPG de 8 bits.
    pub palette: Option<Palette>,
    pub maps: Vec<FpgMap>,
}

impl Fpg {
    /// Crea un FPG vacío de 8 bits con la paleta indicada.
    pub fn new(depth: u8, palette: Option<Palette>) -> Fpg {
        Fpg {
            depth,
            palette: if depth == 8 { palette.or_else(|| Some(Palette::new())) } else { None },
            maps: Vec::new(),
        }
    }

    /// Lee un FPG a partir de sus bytes ya descomprimidos.
    pub fn read(data: &[u8]) -> Result<Fpg> {
        let magic = parse_header(data)?;
        let depth = match &magic {
            b"fpg" => 8u8,
            b"f16" => 16u8,
            other => {
                return Err(Error::InvalidMagic(format!(
                    "no es un FPG ({:?}); se esperaba \"fpg\" o \"f16\"",
                    String::from_utf8_lossy(other)
                )))
            }
        };

        let mut off = 8;
        let palette = if depth == 8 {
            let p = Palette::from_bytes(need(data, off, PALETTE_SIZE)?)?;
            off += PALETTE_SIZE;
            Some(p)
        } else {
            None
        };

        let mut maps = Vec::new();
        // No hay contador de mapas: se leen bloques hasta llegar a EOF.
        while off < data.len() {
            let (map, next) = read_block(data, off, depth)?;
            maps.push(map);
            off = next;
        }

        Ok(Fpg { depth, palette, maps })
    }

    /// Serializa el FPG completo.
    pub fn write(&self) -> Vec<u8> {
        let mut out = Vec::new();
        let magic: &[u8; 3] = if self.depth == 16 { b"f16" } else { b"fpg" };
        out.extend_from_slice(&make_header(magic));
        if self.depth == 8 {
            let pal = self.palette.clone().unwrap_or_default();
            out.extend_from_slice(&pal.to_bytes());
        }
        for m in &self.maps {
            write_block(m, &mut out);
        }
        out
    }
}

/// Lee un bloque de mapa a partir de `off`; devuelve el mapa y el offset siguiente.
fn read_block(data: &[u8], off: usize, depth: u8) -> Result<(FpgMap, usize)> {
    let code = rd_u32(data, off)?;
    // `regsize` es informativo: NO se usa para saltar.
    let _regsize = rd_u32(data, off + 4)?;

    let mut name_raw = [0u8; FPG_NAME_LEN];
    name_raw.copy_from_slice(need(data, off + 8, FPG_NAME_LEN)?);
    let mut filename_raw = [0u8; FPG_FILENAME_LEN];
    filename_raw.copy_from_slice(need(data, off + 40, FPG_FILENAME_LEN)?);

    let width = rd_i32(data, off + 52)?;
    let height = rd_i32(data, off + 56)?;
    let n_flags = rd_i32(data, off + 60)? as u32;

    let mut cur = off + FPG_BLOCK_HEADER;

    let n_points = (n_flags & 0x0FFF) as usize;
    let mut points = Vec::with_capacity(n_points);
    for _ in 0..n_points {
        let x = crate::rd_i16(data, cur)?;
        let y = crate::rd_i16(data, cur + 2)?;
        points.push(ControlPoint { x, y });
        cur += 4;
    }

    let mut animation = None;
    if n_flags & 0x1000 != 0 {
        let frames = rd_u16(data, cur)?;
        let length = rd_u16(data, cur + 2)?;
        let speed = rd_u16(data, cur + 4)?;
        cur += 6;
        let mut sequence = Vec::with_capacity(length as usize);
        for _ in 0..length {
            sequence.push(crate::rd_i16(data, cur)?);
            cur += 2;
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
    let pixels = need(data, cur, px_len)?.to_vec();
    cur += px_len;

    Ok((
        FpgMap {
            code,
            name_raw,
            filename_raw,
            width,
            height,
            points,
            animation,
            pixels,
            depth,
        },
        cur,
    ))
}

/// Serializa un bloque de mapa (cabecera de 64 bytes + puntos + animación + píxeles).
fn write_block(m: &FpgMap, out: &mut Vec<u8>) {
    out.extend_from_slice(&m.code.to_le_bytes());
    out.extend_from_slice(&m.regsize().to_le_bytes());
    out.extend_from_slice(&m.name_raw);
    out.extend_from_slice(&m.filename_raw);
    out.extend_from_slice(&m.width.to_le_bytes());
    out.extend_from_slice(&m.height.to_le_bytes());
    out.extend_from_slice(&(m.flags() as i32).to_le_bytes());
    for p in &m.points {
        out.extend_from_slice(&p.x.to_le_bytes());
        out.extend_from_slice(&p.y.to_le_bytes());
    }
    if let Some(a) = &m.animation {
        out.extend_from_slice(&a.frames.to_le_bytes());
        out.extend_from_slice(&a.length.to_le_bytes());
        out.extend_from_slice(&a.speed.to_le_bytes());
        for s in &a.sequence {
            out.extend_from_slice(&s.to_le_bytes());
        }
    }
    out.extend_from_slice(&m.pixels);
}
