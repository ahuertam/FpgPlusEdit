//! CLI `div2fpg`: lista, extrae, crea y modifica ficheros FPG/MAP/PAL/FNT de
//! DIV Games Studio 2, además de convertir mapas a PNG.

use clap::{Parser, Subcommand};
use div2fmt::imageio::{self, IndexedImage, RgbaImage};
use div2fmt::{gzip, render, Error, Fnt, Fpg, FpgMap, Map, Palette, Result};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    name = "div2fpg",
    version,
    about = "Herramienta para ficheros FPG/MAP/PAL/FNT de DIV Games Studio 2",
    long_about = None
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Lista los mapas de un FPG
    List { file: PathBuf },
    /// Extrae mapas de un FPG a imágenes
    Extract {
        file: PathBuf,
        /// Directorio de salida (por defecto el actual)
        #[arg(long)]
        out: Option<PathBuf>,
        /// Formato de salida: png o bmp
        #[arg(long, default_value = "png")]
        format: String,
        /// Extrae solo el mapa con este id
        #[arg(long)]
        id: Option<u32>,
    },
    /// Crea un FPG a partir de imágenes
    Create {
        output: PathBuf,
        #[arg(required = true)]
        images: Vec<PathBuf>,
        /// Comprime el FPG resultante con GZIP
        #[arg(long)]
        gzip: bool,
    },
    /// Añade mapas a un FPG existente
    Add {
        file: PathBuf,
        #[arg(required = true)]
        images: Vec<PathBuf>,
    },
    /// Elimina mapas por id
    Remove {
        file: PathBuf,
        #[arg(required = true)]
        ids: Vec<u32>,
    },
    /// Extrae la paleta de un fichero
    Palette {
        file: PathBuf,
        /// Escribe la paleta como fichero .pal
        #[arg(long)]
        out: Option<PathBuf>,
        /// Escribe la paleta como imagen PNG (rejilla 16x16)
        #[arg(long)]
        png: Option<PathBuf>,
    },
    /// Convierte un MAP a PNG
    Map2png { map: PathBuf, output: PathBuf },
    /// Muestra información del fichero y su formato detectado
    Info { file: PathBuf },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli.command) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(command: Command) -> Result<()> {
    match command {
        Command::List { file } => cmd_list(&file),
        Command::Extract {
            file,
            out,
            format,
            id,
        } => cmd_extract(&file, out.as_deref(), &format, id),
        Command::Create {
            output,
            images,
            gzip,
        } => cmd_create(&output, &images, gzip),
        Command::Add { file, images } => cmd_add(&file, &images),
        Command::Remove { file, ids } => cmd_remove(&file, &ids),
        Command::Palette { file, out, png } => cmd_palette(&file, out.as_deref(), png.as_deref()),
        Command::Map2png { map, output } => cmd_map2png(&map, &output),
        Command::Info { file } => cmd_info(&file),
    }
}

// ---------------------------------------------------------------------------
// utilidades
// ---------------------------------------------------------------------------

/// Lee un fichero y lo descomprime si está en GZIP.
fn read_maybe_gzip(path: &Path) -> Result<Vec<u8>> {
    let bytes = std::fs::read(path)?;
    gzip::maybe_decompress(&bytes)
}

fn load_fpg(path: &Path) -> Result<Fpg> {
    let bytes = read_maybe_gzip(path)?;
    Fpg::read(&bytes)
}

fn save_fpg(path: &Path, fpg: &Fpg, compress: bool) -> Result<()> {
    let mut bytes = fpg.write();
    if compress {
        bytes = gzip::compress(&bytes)?;
    }
    std::fs::write(path, bytes)?;
    Ok(())
}

fn file_name_str(p: &Path) -> String {
    p.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string()
}

/// Convierte los píxeles de un mapa FPG a una imagen indexada.
fn fpgmap_to_indexed(fpg: &Fpg, m: &FpgMap) -> Result<IndexedImage> {
    render::fpgmap_to_indexed(fpg, m, 0)
}

/// Convierte los píxeles de un MAP a una imagen indexada.
fn map_to_indexed(m: &Map) -> Result<IndexedImage> {
    render::map_to_indexed(m, 0)
}

/// Obtiene la paleta contenida en cualquier contenedor soportado.
fn load_palette(path: &Path) -> Result<Palette> {
    let bytes = read_maybe_gzip(path)?;
    if bytes.len() < 3 {
        return Err(Error::InvalidData("fichero demasiado corto".to_string()));
    }
    match &bytes[0..3] {
        b"pal" => Palette::read_pal_file(&bytes),
        b"fpg" | b"f16" => {
            let f = Fpg::read(&bytes)?;
            f.palette
                .ok_or_else(|| Error::InvalidData("el FPG no tiene paleta (16 bits)".to_string()))
        }
        b"map" | b"m16" => {
            let m = Map::read(&bytes)?;
            m.palette
                .ok_or_else(|| Error::InvalidData("el MAP no tiene paleta (16 bits)".to_string()))
        }
        b"fnt" => Ok(Fnt::read(&bytes)?.palette),
        other => Err(Error::InvalidMagic(format!(
            "no se puede extraer paleta de {:?}",
            String::from_utf8_lossy(other)
        ))),
    }
}

// ---------------------------------------------------------------------------
// subcomandos
// ---------------------------------------------------------------------------

fn cmd_list(file: &Path) -> Result<()> {
    let fpg = load_fpg(file)?;
    println!(
        "{}: {} bits, {} mapas",
        file.display(),
        fpg.depth,
        fpg.maps.len()
    );
    for m in &fpg.maps {
        println!(
            "id={:<4} {:>4}x{:<4} {} bits  puntos={:<3} nombre=\"{}\"",
            m.code,
            m.width,
            m.height,
            m.depth,
            m.points.len(),
            m.name()
        );
    }
    Ok(())
}

fn cmd_extract(file: &Path, out: Option<&Path>, format: &str, id: Option<u32>) -> Result<()> {
    let fpg = load_fpg(file)?;
    let out_dir = out.unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(out_dir)?;

    let fmt = format.to_ascii_lowercase();
    if fmt != "png" && fmt != "bmp" {
        return Err(Error::Unsupported(format!(
            "formato de salida desconocido: {format} (usa png o bmp)"
        )));
    }

    let targets: Vec<&FpgMap> = match id {
        Some(want) => fpg.maps.iter().filter(|m| m.code == want).collect(),
        None => fpg.maps.iter().collect(),
    };
    if targets.is_empty() {
        return Err(Error::InvalidData(match id {
            Some(w) => format!("no existe ningún mapa con id {w}"),
            None => "el FPG no contiene mapas".to_string(),
        }));
    }

    for m in targets {
        let img = fpgmap_to_indexed(&fpg, m)?;
        let path = out_dir.join(format!("map_{:04}.{}", m.code, fmt));
        if fmt == "png" {
            imageio::write_indexed_png(&path, &img)?;
        } else {
            imageio::write_bmp(&path, &img)?;
        }
        println!("escrito {}", path.display());
    }
    Ok(())
}

fn cmd_create(output: &Path, images: &[PathBuf], compress: bool) -> Result<()> {
    let mut rgs: Vec<RgbaImage> = Vec::with_capacity(images.len());
    for p in images {
        rgs.push(imageio::read_rgba(p)?);
    }
    let refs: Vec<&RgbaImage> = rgs.iter().collect();
    let pal = imageio::build_palette(&refs);

    let mut fpg = Fpg::new(8, Some(pal.clone()));
    for (i, img) in rgs.iter().enumerate() {
        let indices = imageio::map_to_palette(img, &pal);
        let mut m = FpgMap::new(i as u32 + 1, img.width as i32, img.height as i32, 8);
        m.pixels = indices;
        m.set_name(&format!("Mapa {}", i + 1));
        m.set_filename(&file_name_str(&images[i]));
        fpg.maps.push(m);
    }

    save_fpg(output, &fpg, compress)?;
    println!(
        "creado {} con {} mapas{}",
        output.display(),
        fpg.maps.len(),
        if compress { " (GZIP)" } else { "" }
    );
    Ok(())
}

fn cmd_add(file: &Path, images: &[PathBuf]) -> Result<()> {
    let mut fpg = load_fpg(file)?;
    if fpg.depth != 8 {
        return Err(Error::Unsupported(
            "solo se pueden añadir mapas a FPG de 8 bits".to_string(),
        ));
    }
    let pal = fpg.palette.clone().unwrap_or_default();
    let mut next = fpg.maps.iter().map(|m| m.code).max().unwrap_or(0) + 1;

    for p in images {
        let rgba = imageio::read_rgba(p)?;
        let indices = imageio::map_to_palette(&rgba, &pal);
        let mut m = FpgMap::new(next, rgba.width as i32, rgba.height as i32, 8);
        m.pixels = indices;
        m.set_name(&format!("Mapa {}", next));
        m.set_filename(&file_name_str(p));
        fpg.maps.push(m);
        next += 1;
    }

    save_fpg(file, &fpg, false)?;
    println!("{}: ahora tiene {} mapas", file.display(), fpg.maps.len());
    Ok(())
}

fn cmd_remove(file: &Path, ids: &[u32]) -> Result<()> {
    let mut fpg = load_fpg(file)?;
    let before = fpg.maps.len();
    fpg.maps.retain(|m| !ids.contains(&m.code));
    let removed = before - fpg.maps.len();
    if removed == 0 {
        return Err(Error::InvalidData(
            "ningún id coincide con los mapas del FPG".to_string(),
        ));
    }
    save_fpg(file, &fpg, false)?;
    println!(
        "{}: eliminados {} mapas, quedan {}",
        file.display(),
        removed,
        fpg.maps.len()
    );
    Ok(())
}

fn cmd_palette(file: &Path, out: Option<&Path>, png: Option<&Path>) -> Result<()> {
    if out.is_none() && png.is_none() {
        return Err(Error::InvalidData(
            "indica al menos --out <salida.pal> o --png <salida.png>".to_string(),
        ));
    }
    let pal = load_palette(file)?;

    if let Some(o) = out {
        std::fs::write(o, pal.write_pal_file())?;
        println!("escrito {}", o.display());
    }
    if let Some(p) = png {
        let indices: Vec<u8> = (0..256).map(|i| i as u8).collect();
        let img = IndexedImage {
            width: 16,
            height: 16,
            indices,
            palette: pal.clone(),
        };
        imageio::write_indexed_png(p, &img)?;
        println!("escrito {}", p.display());
    }
    Ok(())
}

fn cmd_map2png(map: &Path, output: &Path) -> Result<()> {
    let bytes = read_maybe_gzip(map)?;
    let m = Map::read(&bytes)?;
    let img = map_to_indexed(&m)?;
    imageio::write_indexed_png(output, &img)?;
    println!("escrito {}", output.display());
    Ok(())
}

fn cmd_info(file: &Path) -> Result<()> {
    let raw = std::fs::read(file)?;
    let compressed = gzip::is_gzip(&raw);
    let bytes = gzip::maybe_decompress(&raw)?;

    println!("fichero:    {}", file.display());
    println!("tamaño:     {} bytes", raw.len());
    println!(
        "comprimido: {}",
        if compressed { "sí (GZIP)" } else { "no" }
    );
    if bytes.len() < 3 {
        return Err(Error::InvalidData("fichero demasiado corto".to_string()));
    }

    match &bytes[0..3] {
        b"fpg" | b"f16" => {
            let f = Fpg::read(&bytes)?;
            println!("tipo:       FPG");
            println!("bits:       {}", f.depth);
            println!("mapas:      {}", f.maps.len());
            println!(
                "paleta:     {}",
                if f.palette.is_some() { "sí" } else { "no" }
            );
        }
        b"map" | b"m16" => {
            let m = Map::read(&bytes)?;
            println!("tipo:       MAP");
            println!("bits:       {}", m.depth);
            println!("tamaño:     {}x{}", m.width, m.height);
            println!("code:       {}", m.code);
            println!("puntos:     {}", m.points.len());
            println!("píxeles en: offset {}", m.pixel_offset());
        }
        b"pal" => {
            let p = Palette::read_pal_file(&bytes)?;
            println!("tipo:       PAL");
            println!("colores:    256 (6 bits por componente)");
            println!("bloque:     {} bytes", p.to_bytes().len());
        }
        b"fnt" => {
            let f = Fnt::read(&bytes)?;
            println!("tipo:       FNT");
            println!("caracteres: {}", f.glyphs.len());
            println!("flags:      {}", f.flags);
        }
        other => {
            return Err(Error::InvalidMagic(format!(
                "formato no reconocido: {:?}",
                String::from_utf8_lossy(other)
            )))
        }
    }
    Ok(())
}
