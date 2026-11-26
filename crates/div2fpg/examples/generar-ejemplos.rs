//! Genera los recursos de ejemplo que se reparten con el proyecto.
//!
//! La escena es la de un circuito: un mapa de 320x200 con doce puntos de
//! control y un triángulo que lo recorre. Sirve para probar el editor de
//! verdad (pintar, colocar puntos, cambiar la paleta) y para ver cómo un
//! programa de DIV lee lo que se ha hecho aquí.
//!
//! Se genera con el propio núcleo, así que lo que sale es exactamente lo
//! que DIV espera:
//!
//! ```
//! cargo run --example generar-ejemplos -p div2fpg
//! ```

use div2fmt::{ControlPoint, Fpg, FpgMap, Palette};
use std::path::{Path, PathBuf};

/// Colores de la escena. Los componentes van de 0 a 63, como en DIV.
mod color {
    pub const TRANSPARENTE: usize = 0;
    pub const CIELO: usize = 1;
    pub const CIELO_ALTO: usize = 2;
    pub const NUBE: usize = 3;
    pub const SOL: usize = 4;
    pub const ASFALTO: usize = 5;
    pub const CENTRO: usize = 6;
    pub const CENTRO_CLARO: usize = 7;
    pub const BORDE: usize = 8;
    pub const VERDE: usize = 9;
    pub const VERDE_OSCURO: usize = 10;
}

/// Los doce puntos de control del circuito, en el orden en que se recorren.
const PUNTOS: [(i16, i16); 12] = [
    (160, 30),
    (250, 48),
    (285, 105),
    (250, 158),
    (160, 172),
    (70, 158),
    (35, 105),
    (70, 48),
    (110, 80),
    (160, 100),
    (210, 80),
    (160, 60),
];

/// La escena completa: ancho y alto del mapa.
const W: i32 = 320;
const H: i32 = 200;

fn main() {
    let dir: PathBuf = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("ejemplos/DIV"));
    if let Err(e) = generar(&dir) {
        eprintln!("no se pudieron generar los ejemplos: {e}");
        std::process::exit(1);
    }
}

fn generar(dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::create_dir_all(dir)?;

    let paleta = paleta();
    let mut fpg = Fpg::new(8, Some(paleta.clone()));

    // 1. El circuito: el fondo, con sus doce puntos de control.
    let mut circuito = FpgMap::new(1, W, H, 8);
    circuito.set_name("Circuito");
    circuito.set_filename("circuito.png");
    circuito.pixels = pixeles_circuito();
    circuito.points = PUNTOS
        .iter()
        .map(|&(x, y)| ControlPoint { x, y })
        .collect();
    fpg.maps.push(circuito);

    // 2. El triángulo que recorre el circuito.
    let mut triangulo = FpgMap::new(2, 12, 12, 8);
    triangulo.set_name("Triangulo");
    triangulo.set_filename("triangulo.png");
    triangulo.pixels = pixeles_triangulo();
    triangulo.points = vec![ControlPoint { x: 6, y: 6 }];
    fpg.maps.push(triangulo);

    // 3. El sol y la nube, para probar el resto de herramientas.
    let mut sol = FpgMap::new(3, 24, 24, 8);
    sol.set_name("Sol");
    sol.set_filename("sol.png");
    sol.pixels = pixeles_sol();
    fpg.maps.push(sol);

    let mut nube = FpgMap::new(4, 40, 16, 8);
    nube.set_name("Nube");
    nube.set_filename("nube.png");
    nube.pixels = pixeles_nube();
    fpg.maps.push(nube);

    let fpg_path = dir.join("ejemplo.fpg");
    std::fs::write(&fpg_path, fpg.write())?;
    println!("escrito {}", fpg_path.display());

    let pal_path = dir.join("ejemplo.pal");
    std::fs::write(&pal_path, paleta.write_pal_file())?;
    println!("escrito {}", pal_path.display());

    Ok(())
}

/// La paleta de la escena.
fn paleta() -> Palette {
    let mut p = Palette::new();
    // El 0 es transparente: en DIV siempre lo es.
    p.set_rgb(color::TRANSPARENTE, 0, 0, 0);
    p.set_rgb(color::CIELO, 30, 50, 63);
    p.set_rgb(color::CIELO_ALTO, 45, 60, 63);
    p.set_rgb(color::NUBE, 63, 63, 63);
    p.set_rgb(color::SOL, 63, 55, 10);
    p.set_rgb(color::ASFALTO, 20, 20, 22);
    p.set_rgb(color::CENTRO, 40, 40, 44);
    p.set_rgb(color::CENTRO_CLARO, 55, 55, 58);
    p.set_rgb(color::BORDE, 63, 63, 63);
    p.set_rgb(color::VERDE, 10, 45, 14);
    p.set_rgb(color::VERDE_OSCURO, 6, 28, 8);
    p
}

/// Distancia mínima de un punto a los lados del circuito.
fn distancia_al_circuito(x: f32, y: f32) -> f32 {
    let mut mejor = f32::MAX;
    for i in 0..PUNTOS.len() {
        let (x0, y0) = (PUNTOS[i].0 as f32, PUNTOS[i].1 as f32);
        let (x1, y1) = (
            PUNTOS[(i + 1) % PUNTOS.len()].0 as f32,
            PUNTOS[(i + 1) % PUNTOS.len()].1 as f32,
        );
        mejor = mejor.min(distancia_al_segmento(x, y, x0, y0, x1, y1));
    }
    mejor
}

fn distancia_al_segmento(px: f32, py: f32, x0: f32, y0: f32, x1: f32, y1: f32) -> f32 {
    let dx = x1 - x0;
    let dy = y1 - y0;
    let largo = dx * dx + dy * dy;
    let t = if largo == 0.0 {
        0.0
    } else {
        (((px - x0) * dx + (py - y0) * dy) / largo).clamp(0.0, 1.0)
    };
    let cx = x0 + t * dx;
    let cy = y0 + t * dy;
    ((px - cx) * (px - cx) + (py - cy) * (py - cy)).sqrt()
}

/// Los píxeles del circuito: cielo, un sol, nubes, verde y la pista.
fn pixeles_circuito() -> Vec<u8> {
    let mut px = vec![color::CIELO as u8; (W * H) as usize];
    for y in 0..H {
        for x in 0..W {
            // El cielo se aclara un poco hacia arriba, a bandas.
            let banda = (y / 24) % 2;
            px[(y * W + x) as usize] = if banda == 0 {
                color::CIELO_ALTO as u8
            } else {
                color::CIELO as u8
            };
        }
    }

    // El sol, en la esquina de arriba a la izquierda.
    for y in 0..24 {
        for x in 0..24 {
            let dx = x as f32 - 12.0;
            let dy = y as f32 - 12.0;
            if dx * dx + dy * dy <= 10.0 * 10.0 {
                px[(y * W + x) as usize] = color::SOL as u8;
            }
        }
    }

    // Nubes.
    for (cx, cy) in [(250.0f32, 30.0f32), (95.0, 22.0), (190.0, 18.0)] {
        for y in 0..16 {
            for x in 0..40 {
                let dx = (x as f32 - 20.0) / 20.0;
                let dy = (y as f32 - 8.0) / 6.0;
                if dx * dx + dy * dy <= 1.0 {
                    px[((cy as i32 + y) * W + cx as i32 + x) as usize] = color::NUBE as u8;
                }
            }
        }
    }

    // Verde alrededor de la pista, y la pista encima.
    for y in 0..H {
        for x in 0..W {
            let d = distancia_al_circuito(x as f32, y as f32);
            px[(y * W + x) as usize] = if d > 13.0 {
                if (x + y) % 11 == 0 {
                    color::VERDE_OSCURO as u8
                } else {
                    color::VERDE as u8
                }
            } else if d > 9.0 {
                color::ASFALTO as u8
            } else {
                // La línea central, discontinua.
                if (x / 6) % 2 == 0 {
                    color::CENTRO_CLARO as u8
                } else {
                    color::CENTRO as u8
                }
            };
        }
    }

    px
}

/// El triángulo que recorre el circuito: 12x12, mirando a la derecha.
fn pixeles_triangulo() -> Vec<u8> {
    let mut px = vec![color::TRANSPARENTE as u8; 12 * 12];
    for y in 0..12i32 {
        for x in 0..12i32 {
            // Un triángulo con el vértice a la derecha, en el centro (6,6).
            let dx = x - 6;
            let dy = y - 6;
            if dx >= 0 && dy.abs() <= dx / 2 + 1 && dx <= 5 {
                px[(y * 12 + x) as usize] = color::BORDE as u8;
            }
        }
    }
    px
}

/// El sol: un disco con el borde más oscuro.
fn pixeles_sol() -> Vec<u8> {
    let mut px = vec![color::TRANSPARENTE as u8; 24 * 24];
    for y in 0..24i32 {
        for x in 0..24i32 {
            let dx = x as f32 - 11.5;
            let dy = y as f32 - 11.5;
            let d = (dx * dx + dy * dy).sqrt();
            if d <= 11.0 {
                px[(y * 24 + x) as usize] = if d > 9.0 {
                    color::CENTRO_CLARO as u8
                } else {
                    color::SOL as u8
                };
            }
        }
    }
    px
}

/// Una nube: tres círculos solapados.
fn pixeles_nube() -> Vec<u8> {
    let mut px = vec![color::TRANSPARENTE as u8; 40 * 16];
    for (cx, cy, r) in [(12.0f32, 9.0f32, 6.0f32), (20.0, 7.0, 8.0), (29.0, 9.0, 6.0)] {
        for y in 0..16i32 {
            for x in 0..40i32 {
                let dx = x as f32 - cx;
                let dy = y as f32 - cy;
                if dx * dx + dy * dy <= r * r {
                    px[(y * 40 + x) as usize] = color::NUBE as u8;
                }
            }
        }
    }
    px
}
