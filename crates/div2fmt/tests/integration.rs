//! Tests de integración contra los ficheros reales de DIV Games Studio 2.
//!
//! Los fixtures viven en `tests/fixtures` de la raíz del workspace; desde
//! este crate se accede mediante `CARGO_MANIFEST_DIR/../../tests/fixtures`.

use div2fmt::{Animation, ControlPoint, Fnt, Fpg, FpgMap, Map, Palette, PALETTE_SIZE};
use std::path::PathBuf;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures")
        .join(name)
}

/// 1. BRUSH.FPG: 8 bits, 20 mapas, primer mapa con code 1, 1x1 y nombre "Mapa 1…".
#[test]
fn brush_fpg_estructura() {
    let bytes = std::fs::read(fixture("BRUSH.FPG")).unwrap();
    let fpg = Fpg::read(&bytes).unwrap();
    assert_eq!(fpg.depth, 8);
    assert_eq!(fpg.maps.len(), 20, "se esperaban 20 bloques en BRUSH.FPG");
    let m = &fpg.maps[0];
    assert_eq!(m.code, 1);
    assert_eq!(m.width, 1);
    assert_eq!(m.height, 1);
    assert!(m.name().starts_with("Mapa 1"), "nombre = {:?}", m.name());
}

/// 2. HELP.MAP: 320×200, 8 bits, píxeles a partir del offset 1394.
#[test]
fn help_map_layout() {
    let bytes = std::fs::read(fixture("HELP.MAP")).unwrap();
    assert_eq!(bytes.len(), 65394);
    let map = Map::read(&bytes).unwrap();
    assert_eq!(map.width, 320);
    assert_eq!(map.height, 200);
    assert_eq!(map.depth, 8);
    assert_eq!(map.pixel_offset(), 1394);
    assert_eq!(map.pixels.len(), 320 * 200);
}

/// 3. DIV.PAL: 1352 bytes y cabecera "pal".
#[test]
fn div_pal() {
    let bytes = std::fs::read(fixture("DIV.PAL")).unwrap();
    assert_eq!(bytes.len(), 1352);
    assert_eq!(&bytes[0..3], b"pal");
    let pal = Palette::read_pal_file(&bytes).unwrap();
    assert_eq!(pal.to_bytes().len(), PALETTE_SIZE);
    // Round-trip byte a byte del fichero PAL.
    assert_eq!(pal.write_pal_file(), bytes);
}

/// 4. Round-trip en memoria: crear un FPG con 2 mapas de 8×8 y una paleta.
#[test]
fn fpg_roundtrip_memoria() {
    let mut pal = Palette::new();
    pal.set_rgb(1, 63, 0, 0);
    pal.set_rgb(2, 0, 63, 0);
    pal.set_rgb(3, 0, 0, 63);
    pal.set_rgb(4, 63, 63, 63);

    let mut m1 = FpgMap::new(1, 8, 8, 8);
    m1.set_name("Uno");
    m1.set_filename("uno.png");
    for (i, p) in m1.pixels.iter_mut().enumerate() {
        *p = (i % 5) as u8;
    }

    let mut m2 = FpgMap::new(2, 8, 8, 8);
    m2.set_name("Dos");
    m2.set_filename("dos.pcx");
    for (i, p) in m2.pixels.iter_mut().enumerate() {
        *p = (i % 3) as u8;
    }
    m2.points.push(ControlPoint { x: 3, y: -1 });
    m2.points.push(ControlPoint { x: 7, y: 2 });
    m2.animation = Some(Animation {
        frames: 1,
        length: 1,
        speed: 100,
        sequence: vec![0],
    });

    let fpg = Fpg {
        depth: 8,
        palette: Some(pal.clone()),
        maps: vec![m1, m2],
    };
    let bytes = fpg.write();
    let parsed = Fpg::read(&bytes).unwrap();

    assert_eq!(parsed.depth, 8);
    assert_eq!(parsed.maps.len(), 2);
    assert_eq!(parsed.palette.as_ref().unwrap().colors, pal.colors);
    assert_eq!(parsed.palette.as_ref().unwrap().gammas, pal.gammas);

    assert_eq!(parsed.maps[0].code, 1);
    assert_eq!(parsed.maps[0].width, 8);
    assert_eq!(parsed.maps[0].height, 8);
    assert_eq!(parsed.maps[0].name(), "Uno");
    assert_eq!(parsed.maps[0].filename(), "uno.png");
    assert_eq!(parsed.maps[0].pixels, fpg.maps[0].pixels);

    assert_eq!(parsed.maps[1].code, 2);
    assert_eq!(parsed.maps[1].name(), "Dos");
    assert_eq!(parsed.maps[1].filename(), "dos.pcx");
    assert_eq!(parsed.maps[1].points, fpg.maps[1].points);
    assert_eq!(parsed.maps[1].animation, fpg.maps[1].animation);
    assert_eq!(parsed.maps[1].pixels, fpg.maps[1].pixels);
}

/// 5. Round-trip byte a byte de BRUSH.FPG: 6026 bytes y estructura idéntica.
#[test]
fn brush_roundtrip_byte_a_byte() {
    let bytes = std::fs::read(fixture("BRUSH.FPG")).unwrap();
    let fpg = Fpg::read(&bytes).unwrap();
    let out = fpg.write();
    assert_eq!(out.len(), 6026, "BRUSH.FPG debe medir 6026 bytes");

    let re = Fpg::read(&out).unwrap();
    assert_eq!(re.maps.len(), fpg.maps.len());
    for (a, b) in fpg.maps.iter().zip(re.maps.iter()) {
        assert_eq!(a.code, b.code);
        assert_eq!(a.width, b.width);
        assert_eq!(a.height, b.height);
        assert_eq!(a.name_raw, b.name_raw);
        assert_eq!(a.filename_raw, b.filename_raw);
        assert_eq!(a.pixels, b.pixels);
    }

    // La re-serialización reproduce el fichero original byte a byte.
    assert_eq!(out, bytes);
}

/// Comprobación extra del parser FNT contra el fichero real.
#[test]
fn fnt_help() {
    let bytes = std::fs::read(fixture("HELP.FNT")).unwrap();
    assert_eq!(&bytes[0..3], b"fnt");
    let fnt = Fnt::read(&bytes).unwrap();
    assert_eq!(fnt.glyphs.len(), 256);

    // 'A' (65) mide 16×15 y sus datos empiezan justo tras los 256 descriptores.
    let g = fnt.glyphs[65];
    assert_eq!(g.width, 16);
    assert_eq!(g.height, 15);
    assert_eq!(g.data_offset as usize, 8 + PALETTE_SIZE + 4 + 256 * 16);
    assert_eq!(fnt.glyph_pixels(65).unwrap().len(), 16 * 15);

    // Round-trip byte a byte.
    assert_eq!(fnt.write(), bytes);
}
