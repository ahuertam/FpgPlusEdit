//! Conversión entre imágenes y el modelo indexado+paleta de DIV.
//!
//! - Exportación: una imagen indexada + paleta se escribe como PNG en RGBA8
//!   (el índice 0 se exporta transparente).
//! - Importación: se leen PNG (indexado o truecolor), BMP (8 bits indexado y
//!   24/32 bits), PCX (8 bits con RLE) y JPEG. Si la imagen trae paleta propia
//!   se usa directamente; si es truecolor se cuantiza a 256 colores con un
//!   median-cut simple, respetando la transparencia (alpha < 128 -> índice 0).

use crate::palette::Palette;
use crate::{Error, Result};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Cursor, Write};
use std::path::Path;

/// Imagen en RGBA8 (4 bytes por píxel).
#[derive(Clone, Debug)]
pub struct RgbaImage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

/// Imagen indexada con su paleta.
#[derive(Clone, Debug)]
pub struct IndexedImage {
    pub width: u32,
    pub height: u32,
    pub indices: Vec<u8>,
    pub palette: Palette,
}

/// Formatos de imagen soportados.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ImageFormat {
    Png,
    Bmp,
    Pcx,
    Jpeg,
}

/// Formato decodificado: indexado (con paleta propia) o truecolor.
enum Decoded {
    Indexed(IndexedImage),
    Rgba(RgbaImage),
}

// ---------------------------------------------------------------------------
// Conversiones básicas
// ---------------------------------------------------------------------------

/// Vista RGBA de una imagen indexada (índice 0 transparente).
pub fn indexed_to_rgba(img: &IndexedImage) -> RgbaImage {
    let pal = img.palette.to_rgba();
    let mut data = vec![0u8; img.indices.len() * 4];
    for (i, &idx) in img.indices.iter().enumerate() {
        let s = idx as usize * 4;
        data[i * 4..i * 4 + 4].copy_from_slice(&pal[s..s + 4]);
    }
    RgbaImage {
        width: img.width,
        height: img.height,
        data,
    }
}

/// `true` si algún píxel tiene alpha < 128.
pub fn has_transparency(img: &RgbaImage) -> bool {
    img.data.chunks_exact(4).any(|p| p[3] < 128)
}

fn collect_opaque(img: &RgbaImage) -> Vec<[u8; 3]> {
    img.data
        .chunks_exact(4)
        .filter(|p| p[3] >= 128)
        .map(|p| [p[0], p[1], p[2]])
        .collect()
}

/// Construye una paleta común a partir de varias imágenes RGBA.
pub fn build_palette(images: &[&RgbaImage]) -> Palette {
    let mut all = Vec::new();
    let mut transparent = false;
    for img in images {
        if has_transparency(img) {
            transparent = true;
        }
        all.extend(collect_opaque(img));
    }
    let max = if transparent { 255 } else { 256 };
    let colors = median_cut(&all, max);
    // Si hay transparencia, el índice 0 se reserva para ella.
    Palette::from_rgb_list(&colors, if transparent { 1 } else { 0 })
}

/// Mapea una imagen RGBA a índices de la paleta indicada.
pub fn map_to_palette(img: &RgbaImage, pal: &Palette) -> Vec<u8> {
    let pal8: Vec<[u8; 3]> = (0..256).map(|i| pal.rgb8(i)).collect();
    let skip0 = has_transparency(img);
    let mut cache: HashMap<u32, u8> = HashMap::new();
    let mut out = vec![0u8; img.width as usize * img.height as usize];
    for (i, px) in img.data.chunks_exact(4).enumerate() {
        if px[3] < 128 {
            // Regla de transparencia: alpha < 128 -> índice 0.
            out[i] = 0;
            continue;
        }
        let key = ((px[0] as u32) << 16) | ((px[1] as u32) << 8) | px[2] as u32;
        let idx = *cache
            .entry(key)
            .or_insert_with(|| nearest(&pal8, [px[0], px[1], px[2]], skip0));
        out[i] = idx;
    }
    out
}

/// Convierte una imagen RGBA a indexada, reutilizando `hint` si se indica.
pub fn rgba_to_indexed(img: &RgbaImage, hint: Option<&Palette>) -> IndexedImage {
    let pal = match hint {
        Some(p) => p.clone(),
        None => build_palette(&[img]),
    };
    let indices = map_to_palette(img, &pal);
    IndexedImage {
        width: img.width,
        height: img.height,
        indices,
        palette: pal,
    }
}

fn nearest(pal: &[[u8; 3]], c: [u8; 3], skip0: bool) -> u8 {
    let mut best = if skip0 { 1u8 } else { 0u8 };
    let mut best_d = u32::MAX;
    for (i, p) in pal.iter().enumerate() {
        if skip0 && i == 0 {
            continue;
        }
        let dr = c[0] as i32 - p[0] as i32;
        let dg = c[1] as i32 - p[1] as i32;
        let db = c[2] as i32 - p[2] as i32;
        let d = (dr * dr + dg * dg + db * db) as u32;
        if d < best_d {
            best_d = d;
            best = i as u8;
            if d == 0 {
                break;
            }
        }
    }
    best
}

/// Rango del canal dominante de un conjunto de píxeles.
fn channel_range(px: &[[u8; 3]]) -> (u8, usize) {
    let mut lo = [255u8; 3];
    let mut hi = [0u8; 3];
    for p in px {
        for c in 0..3 {
            if p[c] < lo[c] {
                lo[c] = p[c];
            }
            if p[c] > hi[c] {
                hi[c] = p[c];
            }
        }
    }
    let r = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    let (max, ch) = if r[0] >= r[1] && r[0] >= r[2] {
        (r[0], 0)
    } else if r[1] >= r[2] {
        (r[1], 1)
    } else {
        (r[2], 2)
    };
    (max, ch)
}

fn average(bucket: &[[u8; 3]]) -> [u8; 3] {
    if bucket.is_empty() {
        return [0, 0, 0];
    }
    let mut sum = [0u64; 3];
    for p in bucket {
        for c in 0..3 {
            sum[c] += p[c] as u64;
        }
    }
    let n = bucket.len() as u64;
    [(sum[0] / n) as u8, (sum[1] / n) as u8, (sum[2] / n) as u8]
}

/// Median-cut simple: divide recursivamente el conjunto de colores.
fn median_cut(pixels: &[[u8; 3]], max: usize) -> Vec<[u8; 3]> {
    if pixels.is_empty() {
        return vec![[0, 0, 0]];
    }
    let mut buckets: Vec<Vec<[u8; 3]>> = vec![pixels.to_vec()];
    while buckets.len() < max {
        let mut target: Option<usize> = None;
        let mut best = 0u8;
        for (i, b) in buckets.iter().enumerate() {
            if b.len() < 2 {
                continue;
            }
            let (r, _) = channel_range(b);
            if target.is_none() || r > best {
                best = r;
                target = Some(i);
            }
        }
        let Some(i) = target else { break };
        if best == 0 {
            break; // todos los colores son idénticos
        }
        let mut b = buckets.swap_remove(i);
        let (_, ch) = channel_range(&b);
        b.sort_unstable_by_key(|p| p[ch]);
        let mid = b.len() / 2;
        let right = b.split_off(mid);
        buckets.push(b);
        buckets.push(right);
    }
    buckets.iter().map(|b| average(b)).collect()
}

// ---------------------------------------------------------------------------
// Detección de formato
// ---------------------------------------------------------------------------

fn detect_from_bytes(bytes: &[u8], path: &Path) -> Result<ImageFormat> {
    if bytes.len() >= 8 && &bytes[0..8] == b"\x89PNG\r\n\x1a\n" {
        return Ok(ImageFormat::Png);
    }
    if bytes.len() >= 2 && &bytes[0..2] == b"BM" {
        return Ok(ImageFormat::Bmp);
    }
    if bytes.len() >= 1 && bytes[0] == 0x0A {
        return Ok(ImageFormat::Pcx);
    }
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xD8 {
        return Ok(ImageFormat::Jpeg);
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => Ok(ImageFormat::Png),
        "bmp" => Ok(ImageFormat::Bmp),
        "pcx" => Ok(ImageFormat::Pcx),
        "jpg" | "jpeg" => Ok(ImageFormat::Jpeg),
        _ => Err(Error::Unsupported(format!(
            "no se reconoce el formato de {}",
            path.display()
        ))),
    }
}

/// Detecta el formato de un fichero de imagen por su firma (y extensión).
pub fn detect_format(path: &Path) -> Result<ImageFormat> {
    let bytes = std::fs::read(path)?;
    detect_from_bytes(&bytes, path)
}

fn decode_file(path: &Path) -> Result<Decoded> {
    let bytes = std::fs::read(path)?;
    match detect_from_bytes(&bytes, path)? {
        ImageFormat::Png => decode_png(&bytes),
        ImageFormat::Bmp => decode_bmp(&bytes),
        ImageFormat::Pcx => decode_pcx(&bytes),
        ImageFormat::Jpeg => decode_jpeg(&bytes),
    }
}

/// Lee cualquier imagen soportada y la devuelve en RGBA8.
pub fn read_rgba(path: &Path) -> Result<RgbaImage> {
    match decode_file(path)? {
        Decoded::Rgba(r) => Ok(r),
        Decoded::Indexed(ix) => Ok(indexed_to_rgba(&ix)),
    }
}

/// Lee una imagen indexada. Si trae paleta propia se usa; si es truecolor se
/// cuantiza a 256 colores (`hint` permite reutilizar una paleta existente).
pub fn read_indexed(path: &Path, hint: Option<&Palette>) -> Result<IndexedImage> {
    match decode_file(path)? {
        Decoded::Indexed(ix) => Ok(ix),
        Decoded::Rgba(r) => Ok(rgba_to_indexed(&r, hint)),
    }
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

fn decode_png(bytes: &[u8]) -> Result<Decoded> {
    let decoder = png::Decoder::new(Cursor::new(bytes));
    let mut reader = decoder
        .read_info()
        .map_err(|e| Error::InvalidData(format!("PNG: {e}")))?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut buf)
        .map_err(|e| Error::InvalidData(format!("PNG: {e}")))?;
    let w = info.width as usize;
    let h = info.height as usize;

    match (info.color_type, info.bit_depth) {
        (png::ColorType::Indexed, png::BitDepth::Eight) => {
            let pal_bytes = reader
                .info()
                .palette
                .clone()
                .ok_or_else(|| Error::InvalidData("PNG indexado sin paleta".to_string()))?;
            let mut pal = Palette {
                colors: [0u8; crate::palette::PAL_COLORS],
                gammas: [0u8; crate::palette::PAL_GAMMAS],
            };
            let n = (pal_bytes.len() / 3).min(256);
            for i in 0..n {
                pal.set_rgb(
                    i,
                    Palette::scale_to_6(pal_bytes[i * 3]),
                    Palette::scale_to_6(pal_bytes[i * 3 + 1]),
                    Palette::scale_to_6(pal_bytes[i * 3 + 2]),
                );
            }
            let indices = buf[..w * h].to_vec();
            Ok(Decoded::Indexed(IndexedImage {
                width: w as u32,
                height: h as u32,
                indices,
                palette: pal,
            }))
        }
        (png::ColorType::Rgb, png::BitDepth::Eight) => {
            let mut data = vec![0u8; w * h * 4];
            for i in 0..w * h {
                data[i * 4] = buf[i * 3];
                data[i * 4 + 1] = buf[i * 3 + 1];
                data[i * 4 + 2] = buf[i * 3 + 2];
                data[i * 4 + 3] = 255;
            }
            Ok(Decoded::Rgba(RgbaImage {
                width: w as u32,
                height: h as u32,
                data,
            }))
        }
        (png::ColorType::Rgba, png::BitDepth::Eight) => Ok(Decoded::Rgba(RgbaImage {
            width: w as u32,
            height: h as u32,
            data: buf[..w * h * 4].to_vec(),
        })),
        (png::ColorType::Grayscale, png::BitDepth::Eight) => {
            let mut data = vec![0u8; w * h * 4];
            for i in 0..w * h {
                let v = buf[i];
                data[i * 4] = v;
                data[i * 4 + 1] = v;
                data[i * 4 + 2] = v;
                data[i * 4 + 3] = 255;
            }
            Ok(Decoded::Rgba(RgbaImage {
                width: w as u32,
                height: h as u32,
                data,
            }))
        }
        (png::ColorType::GrayscaleAlpha, png::BitDepth::Eight) => {
            let mut data = vec![0u8; w * h * 4];
            for i in 0..w * h {
                let v = buf[i * 2];
                data[i * 4] = v;
                data[i * 4 + 1] = v;
                data[i * 4 + 2] = v;
                data[i * 4 + 3] = buf[i * 2 + 1];
            }
            Ok(Decoded::Rgba(RgbaImage {
                width: w as u32,
                height: h as u32,
                data,
            }))
        }
        _ => Err(Error::Unsupported(format!(
            "PNG {:?} de {:?} bits",
            info.color_type, info.bit_depth
        ))),
    }
}

/// Codifica una imagen RGBA como PNG (RGBA8, índice 0 ya transparente) en memoria.
pub fn encode_png(img: &RgbaImage) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, img.width, img.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| Error::InvalidData(format!("PNG: {e}")))?;
        writer
            .write_image_data(&img.data)
            .map_err(|e| Error::InvalidData(format!("PNG: {e}")))?;
    }
    Ok(out)
}

/// Escribe una imagen RGBA como PNG (RGBA8, índice 0 ya transparente).
pub fn write_png(path: &Path, img: &RgbaImage) -> Result<()> {
    let bytes = encode_png(img)?;
    let file = File::create(path)?;
    let mut w = BufWriter::new(file);
    w.write_all(&bytes)?;
    Ok(())
}

/// Escribe una imagen indexada como PNG en RGBA8.
pub fn write_indexed_png(path: &Path, img: &IndexedImage) -> Result<()> {
    write_png(path, &indexed_to_rgba(img))
}

// ---------------------------------------------------------------------------
// BMP (implementado a mano)
// ---------------------------------------------------------------------------

fn decode_bmp(bytes: &[u8]) -> Result<Decoded> {
    if bytes.len() < 54 || &bytes[0..2] != b"BM" {
        return Err(Error::InvalidData("BMP: firma inválida".to_string()));
    }
    let data_off = crate::rd_u32(bytes, 10)? as usize;
    let hdr_size = crate::rd_u32(bytes, 14)? as usize;
    let width = crate::rd_i32(bytes, 18)?;
    let height = crate::rd_i32(bytes, 22)?;
    let bpp = crate::rd_u16(bytes, 28)?;
    let compression = crate::rd_u32(bytes, 30)?;
    if compression != 0 {
        return Err(Error::Unsupported("BMP comprimido".to_string()));
    }
    let w = width.unsigned_abs() as usize;
    let h = height.unsigned_abs() as usize;
    let bottom_up = height > 0;

    if bpp == 8 {
        let pal_off = 14 + hdr_size;
        let mut pal = Palette {
            colors: [0u8; crate::palette::PAL_COLORS],
            gammas: [0u8; crate::palette::PAL_GAMMAS],
        };
        for i in 0..256usize {
            let o = pal_off + i * 4;
            let b = crate::need(bytes, o, 4)?[0];
            let g = bytes[o + 1];
            let r = bytes[o + 2];
            pal.set_rgb(
                i,
                Palette::scale_to_6(r),
                Palette::scale_to_6(g),
                Palette::scale_to_6(b),
            );
        }
        let row_size = (w + 3) / 4 * 4;
        let mut indices = vec![0u8; w * h];
        for row in 0..h {
            let src_row = if bottom_up { h - 1 - row } else { row };
            let src = data_off + src_row * row_size;
            indices[row * w..row * w + w].copy_from_slice(crate::need(bytes, src, w)?);
        }
        Ok(Decoded::Indexed(IndexedImage {
            width: w as u32,
            height: h as u32,
            indices,
            palette: pal,
        }))
    } else if bpp == 24 || bpp == 32 {
        let bpp_bytes = bpp as usize / 8;
        let row_size = ((w * bpp as usize + 31) / 32) * 4;
        let mut data = vec![0u8; w * h * 4];
        for row in 0..h {
            let src_row = if bottom_up { h - 1 - row } else { row };
            let src = data_off + src_row * row_size;
            for x in 0..w {
                let p = src + x * bpp_bytes;
                let px = crate::need(bytes, p, bpp_bytes)?;
                let d = (row * w + x) * 4;
                data[d] = px[2];
                data[d + 1] = px[1];
                data[d + 2] = px[0];
                data[d + 3] = if bpp == 32 { px[3] } else { 255 };
            }
        }
        Ok(Decoded::Rgba(RgbaImage {
            width: w as u32,
            height: h as u32,
            data,
        }))
    } else {
        Err(Error::Unsupported(format!("BMP de {bpp} bits")))
    }
}

/// Escribe BMP de 8 bits indexado (256 colores, filas alineadas a 4 bytes, bottom-up).
pub fn write_bmp(path: &Path, img: &IndexedImage) -> Result<()> {
    let w = img.width as usize;
    let h = img.height as usize;
    let row_size = (w + 3) / 4 * 4;
    let pix_size = row_size * h;
    let pal_size = 256 * 4;
    let data_off = 14 + 40 + pal_size;
    let file_size = data_off + pix_size;

    let mut out = Vec::with_capacity(file_size);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&(file_size as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&(data_off as u32).to_le_bytes());
    // BITMAPINFOHEADER (40 bytes)
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(w as i32).to_le_bytes());
    out.extend_from_slice(&(h as i32).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&8u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // sin compresión
    out.extend_from_slice(&(pix_size as u32).to_le_bytes());
    out.extend_from_slice(&2835u32.to_le_bytes()); // resolución X
    out.extend_from_slice(&2835u32.to_le_bytes()); // resolución Y
    out.extend_from_slice(&256u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    // Paleta (BGRA)
    for i in 0..256usize {
        let [r, g, b] = img.palette.rgb8(i);
        out.push(b);
        out.push(g);
        out.push(r);
        out.push(0);
    }
    // Píxeles bottom-up con relleno a 4 bytes
    for row in (0..h).rev() {
        out.extend_from_slice(&img.indices[row * w..row * w + w]);
        out.extend(std::iter::repeat(0u8).take(row_size - w));
    }
    std::fs::write(path, out)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// PCX (implementado a mano, 8 bits con RLE)
// ---------------------------------------------------------------------------

fn decode_pcx(bytes: &[u8]) -> Result<Decoded> {
    if bytes.len() < 128 || bytes[0] != 0x0A {
        return Err(Error::InvalidData("PCX: firma inválida".to_string()));
    }
    let bpp = bytes[3];
    let xmax = crate::rd_u16(bytes, 8)?;
    let ymax = crate::rd_u16(bytes, 10)?;
    let planes = bytes[65];
    let bytes_per_line = crate::rd_u16(bytes, 66)? as usize;
    if bpp != 8 || planes != 1 {
        return Err(Error::Unsupported(format!(
            "PCX de {bpp} bits y {planes} planos"
        )));
    }
    let w = xmax as usize + 1;
    let h = ymax as usize + 1;

    let total = bytes_per_line * h;
    let mut raw = Vec::with_capacity(total);
    let mut i = 128;
    while raw.len() < total && i < bytes.len() {
        let b = bytes[i];
        i += 1;
        if b & 0xC0 == 0xC0 {
            let count = (b & 0x3F) as usize;
            let val = *crate::need(bytes, i, 1)?.first().unwrap();
            i += 1;
            for _ in 0..count {
                raw.push(val);
            }
        } else {
            raw.push(b);
        }
    }

    if bytes.len() < 769 {
        return Err(Error::InvalidData(
            "PCX sin paleta de 256 colores".to_string(),
        ));
    }
    let pal_start = bytes.len() - 768;
    let mut pal = Palette {
        colors: [0u8; crate::palette::PAL_COLORS],
        gammas: [0u8; crate::palette::PAL_GAMMAS],
    };
    for c in 0..256usize {
        let o = pal_start + c * 3;
        pal.set_rgb(
            c,
            Palette::scale_to_6(bytes[o]),
            Palette::scale_to_6(bytes[o + 1]),
            Palette::scale_to_6(bytes[o + 2]),
        );
    }

    let mut indices = vec![0u8; w * h];
    for row in 0..h {
        let src = row * bytes_per_line;
        crate::need(&raw, src, w)?;
        indices[row * w..row * w + w].copy_from_slice(&raw[src..src + w]);
    }
    Ok(Decoded::Indexed(IndexedImage {
        width: w as u32,
        height: h as u32,
        indices,
        palette: pal,
    }))
}

fn pcx_rle(data: &[u8], out: &mut Vec<u8>) {
    let mut i = 0;
    while i < data.len() {
        let v = data[i];
        let mut run = 1;
        while i + run < data.len() && data[i + run] == v && run < 63 {
            run += 1;
        }
        // Los bytes 0xC0..0xFF marcan repetición y deben escaparse siempre.
        if run > 1 || v >= 0xC0 {
            out.push(0xC0 | run as u8);
            out.push(v);
        } else {
            out.push(v);
        }
        i += run;
    }
}

/// Escribe PCX de 8 bits con RLE y paleta de 256 colores.
pub fn write_pcx(path: &Path, img: &IndexedImage) -> Result<()> {
    let w = img.width as usize;
    let h = img.height as usize;
    let bytes_per_line = (w + 1) / 2 * 2;

    let mut out = vec![0u8; 128];
    out[0] = 0x0A; // manufacturer
    out[1] = 5; // version
    out[2] = 1; // codificación RLE
    out[3] = 8; // bits por píxel
    let xmax = (w - 1) as u16;
    let ymax = (h - 1) as u16;
    out[4..6].copy_from_slice(&0u16.to_le_bytes()); // xmin
    out[6..8].copy_from_slice(&0u16.to_le_bytes()); // ymin
    out[8..10].copy_from_slice(&xmax.to_le_bytes());
    out[10..12].copy_from_slice(&ymax.to_le_bytes());
    out[12..14].copy_from_slice(&72u16.to_le_bytes()); // hres
    out[14..16].copy_from_slice(&72u16.to_le_bytes()); // vres
    out[65] = 1; // planos
    out[66..68].copy_from_slice(&(bytes_per_line as u16).to_le_bytes());
    out[68..70].copy_from_slice(&1u16.to_le_bytes()); // palette_info

    let mut row = vec![0u8; bytes_per_line];
    for y in 0..h {
        row.iter_mut().for_each(|b| *b = 0);
        row[..w].copy_from_slice(&img.indices[y * w..y * w + w]);
        pcx_rle(&row, &mut out);
    }

    // Marcador 0x0C + paleta de 256 colores (RGB).
    out.push(0x0C);
    for i in 0..256usize {
        let [r, g, b] = img.palette.rgb8(i);
        out.push(r);
        out.push(g);
        out.push(b);
    }
    std::fs::write(path, out)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

fn decode_jpeg(bytes: &[u8]) -> Result<Decoded> {
    use jpeg_decoder::{Decoder, PixelFormat};
    let mut decoder = Decoder::new(Cursor::new(bytes));
    let pixels = decoder
        .decode()
        .map_err(|e| Error::InvalidData(format!("JPEG: {e}")))?;
    let info = decoder
        .info()
        .ok_or_else(|| Error::InvalidData("JPEG sin cabecera".to_string()))?;
    let w = info.width as usize;
    let h = info.height as usize;
    let mut data = vec![0u8; w * h * 4];
    match info.pixel_format {
        PixelFormat::RGB24 => {
            for i in 0..w * h {
                data[i * 4] = pixels[i * 3];
                data[i * 4 + 1] = pixels[i * 3 + 1];
                data[i * 4 + 2] = pixels[i * 3 + 2];
                data[i * 4 + 3] = 255;
            }
        }
        PixelFormat::L8 => {
            for i in 0..w * h {
                let v = pixels[i];
                data[i * 4] = v;
                data[i * 4 + 1] = v;
                data[i * 4 + 2] = v;
                data[i * 4 + 3] = 255;
            }
        }
        PixelFormat::CMYK32 => {
            for i in 0..w * h {
                let c = pixels[i * 4] as f32 / 255.0;
                let m = pixels[i * 4 + 1] as f32 / 255.0;
                let y = pixels[i * 4 + 2] as f32 / 255.0;
                let k = pixels[i * 4 + 3] as f32 / 255.0;
                data[i * 4] = ((1.0 - c) * (1.0 - k) * 255.0) as u8;
                data[i * 4 + 1] = ((1.0 - m) * (1.0 - k) * 255.0) as u8;
                data[i * 4 + 2] = ((1.0 - y) * (1.0 - k) * 255.0) as u8;
                data[i * 4 + 3] = 255;
            }
        }
        other => {
            return Err(Error::Unsupported(format!("JPEG color {other:?}")));
        }
    }
    Ok(Decoded::Rgba(RgbaImage {
        width: w as u32,
        height: h as u32,
        data,
    }))
}

/// Escribe una imagen RGBA como JPEG con la calidad indicada (0..=100).
pub fn write_jpeg(path: &Path, img: &RgbaImage, quality: u8) -> Result<()> {
    use jpeg_encoder::{ColorType, Encoder};
    let mut rgb = vec![0u8; img.width as usize * img.height as usize * 3];
    for (i, px) in img.data.chunks_exact(4).enumerate() {
        rgb[i * 3] = px[0];
        rgb[i * 3 + 1] = px[1];
        rgb[i * 3 + 2] = px[2];
    }
    let mut out = Vec::new();
    let encoder = Encoder::new(&mut out, quality);
    encoder
        .encode(
            &rgb,
            img.width as u16,
            img.height as u16,
            ColorType::Rgb,
        )
        .map_err(|e| Error::InvalidData(format!("JPEG: {e}")))?;
    std::fs::write(path, out)?;
    Ok(())
}
