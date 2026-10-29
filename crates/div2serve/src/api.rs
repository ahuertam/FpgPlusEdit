//! API del editor: abre, consulta, modifica y guarda los ficheros.
//!
//! El servidor mantiene en memoria los documentos abiertos (`Doc`) y los
//! identifica con un número (`doc`). Cada operación de escritura vuelve a
//! serializar con el núcleo `div2fmt`, que conserva el contenido byte a byte
//! cuando no se ha tocado nada.

use crate::http::{jstr, Request, Resp};
use div2fmt::imageio::{self, IndexedImage};
use div2fmt::{gzip, render, Animation, ControlPoint, Fnt, Fpg, FpgMap, Map, Palette};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

/// Documento abierto en memoria.
pub enum Doc {
    Fpg {
        fpg: Fpg,
        path: PathBuf,
        gzip: bool,
    },
    Map {
        map: Map,
        path: PathBuf,
        gzip: bool,
    },
    Pal {
        pal: Palette,
        path: PathBuf,
        gzip: bool,
    },
    Fnt {
        fnt: Fnt,
        path: PathBuf,
        gzip: bool,
    },
}

impl Doc {
    fn path(&self) -> &Path {
        match self {
            Doc::Fpg { path, .. }
            | Doc::Map { path, .. }
            | Doc::Pal { path, .. }
            | Doc::Fnt { path, .. } => path,
        }
    }

    fn set_path(&mut self, p: PathBuf) {
        match self {
            Doc::Fpg { path, .. }
            | Doc::Map { path, .. }
            | Doc::Pal { path, .. }
            | Doc::Fnt { path, .. } => *path = p,
        }
    }

    fn gzip(&self) -> bool {
        match self {
            Doc::Fpg { gzip, .. }
            | Doc::Map { gzip, .. }
            | Doc::Pal { gzip, .. }
            | Doc::Fnt { gzip, .. } => *gzip,
        }
    }

    fn set_gzip(&mut self, v: bool) {
        match self {
            Doc::Fpg { gzip, .. }
            | Doc::Map { gzip, .. }
            | Doc::Pal { gzip, .. }
            | Doc::Fnt { gzip, .. } => *gzip = v,
        }
    }
}

static NEXT: AtomicU64 = AtomicU64::new(1);

fn store() -> &'static Mutex<HashMap<u64, Doc>> {
    static S: OnceLock<Mutex<HashMap<u64, Doc>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// utilidades
// ---------------------------------------------------------------------------

fn q<'a>(req: &'a Request, k: &str) -> Option<&'a str> {
    req.query.get(k).map(|s| s.as_str()).filter(|s| !s.is_empty())
}

fn qnum<T: std::str::FromStr>(req: &Request, k: &str) -> Option<T> {
    req.query.get(k).and_then(|v| v.parse::<T>().ok())
}

fn needs_doc(req: &Request) -> Result<u64, Resp> {
    qnum::<u64>(req, "doc").ok_or_else(|| Resp::err(400, "falta el parámetro doc"))
}

fn fmt_err(e: div2fmt::Error) -> String {
    e.to_string()
}

// ---------------------------------------------------------------------------
// representación JSON
// ---------------------------------------------------------------------------

fn palette_json(p: &Palette) -> String {
    let mut s = String::with_capacity(256 * 12);
    s.push('[');
    for i in 0..256usize {
        if i > 0 {
            s.push(',');
        }
        let (r, g, b) = p.rgb(i);
        s.push('[');
        s.push_str(&r.to_string());
        s.push(',');
        s.push_str(&g.to_string());
        s.push(',');
        s.push_str(&b.to_string());
        s.push(']');
    }
    s.push(']');
    s
}

fn points_json(pts: &[ControlPoint]) -> String {
    let v: Vec<String> = pts.iter().map(|p| format!("[{},{}]", p.x, p.y)).collect();
    format!("[{}]", v.join(","))
}

fn anim_json(a: &Option<Animation>) -> String {
    match a {
        None => "null".to_string(),
        Some(a) => {
            let seq: Vec<String> = a.sequence.iter().map(|v| v.to_string()).collect();
            format!(
                "{{\"frames\":{},\"length\":{},\"speed\":{},\"sequence\":[{}]}}",
                a.frames,
                a.length,
                a.speed,
                seq.join(",")
            )
        }
    }
}

fn fpgmap_json(m: &FpgMap) -> String {
    format!(
        "{{\"id\":{},\"name\":{},\"filename\":{},\"width\":{},\"height\":{},\"frames\":{},\"points\":{},\"animation\":{}}}",
        m.code,
        jstr(&m.name()),
        jstr(&m.filename()),
        m.width,
        m.height,
        m.frames(),
        points_json(&m.points),
        anim_json(&m.animation)
    )
}

fn size_of(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

fn base_name(p: &Path) -> String {
    p.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn doc_json(id: u64, doc: &Doc) -> String {
    let path = doc.path().to_string_lossy().into_owned();
    let name = base_name(doc.path());
    match doc {
        Doc::Fpg { fpg, gzip, .. } => {
            let maps: Vec<String> = fpg.maps.iter().map(fpgmap_json).collect();
            let pal = match &fpg.palette {
                Some(p) => palette_json(p),
                None => "null".to_string(),
            };
            format!(
                "{{\"ok\":true,\"doc\":{},\"kind\":\"fpg\",\"path\":{},\"name\":{},\"size\":{},\"gzip\":{},\"depth\":{},\"palette\":{},\"maps\":[{}]}}",
                id,
                jstr(&path),
                jstr(&name),
                size_of(doc.path()),
                gzip,
                fpg.depth,
                pal,
                maps.join(",")
            )
        }
        Doc::Map { map, gzip, .. } => {
            let pal = match &map.palette {
                Some(p) => palette_json(p),
                None => "null".to_string(),
            };
            let anim = anim_json(&map.animation);
            let maps = format!(
                "[{{\"id\":{},\"name\":{},\"filename\":\"\",\"width\":{},\"height\":{},\"frames\":{},\"points\":{},\"animation\":{}}}]",
                map.code,
                jstr(&map.name()),
                map.width,
                map.height,
                map.frames(),
                points_json(&map.points),
                anim
            );
            format!(
                "{{\"ok\":true,\"doc\":{},\"kind\":\"map\",\"path\":{},\"name\":{},\"size\":{},\"gzip\":{},\"depth\":{},\"code\":{},\"width\":{},\"height\":{},\"points\":{},\"animation\":{},\"palette\":{},\"maps\":{}}}",
                id,
                jstr(&path),
                jstr(&name),
                size_of(doc.path()),
                gzip,
                map.depth,
                map.code,
                map.width,
                map.height,
                points_json(&map.points),
                anim,
                pal,
                maps
            )
        }
        Doc::Pal { pal, gzip, .. } => format!(
            "{{\"ok\":true,\"doc\":{},\"kind\":\"pal\",\"path\":{},\"name\":{},\"size\":{},\"gzip\":{},\"palette\":{},\"maps\":[]}}",
            id,
            jstr(&path),
            jstr(&name),
            size_of(doc.path()),
            gzip,
            palette_json(pal)
        ),
        Doc::Fnt { fnt, gzip, .. } => {
            let glyphs: Vec<String> = fnt
                .glyphs
                .iter()
                .enumerate()
                .map(|(i, g)| {
                    format!(
                        "{{\"ch\":{},\"w\":{},\"h\":{},\"v\":{},\"off\":{}}}",
                        i, g.width, g.height, g.v_offset, g.data_offset
                    )
                })
                .collect();
            format!(
                "{{\"ok\":true,\"doc\":{},\"kind\":\"fnt\",\"path\":{},\"name\":{},\"size\":{},\"gzip\":{},\"flags\":{},\"palette\":{},\"glyphs\":[{}],\"maps\":[]}}",
                id,
                jstr(&path),
                jstr(&name),
                size_of(doc.path()),
                gzip,
                fnt.flags,
                palette_json(&fnt.palette),
                glyphs.join(",")
            )
        }
    }
}

fn doc_response(id: u64) -> Resp {
    let g = store().lock().unwrap();
    match g.get(&id) {
        Some(doc) => Resp::json(200, doc_json(id, doc)),
        None => Resp::err(404, "documento no encontrado (¿se cerró la pestaña?)"),
    }
}

// ---------------------------------------------------------------------------
// enrutado
// ---------------------------------------------------------------------------

pub fn route(req: &Request, home: &Path) -> Resp {
    match req.path.as_str() {
        "/api/state" => state(home),
        "/api/fs" => fs_list(req),
        "/api/open" | "/api/reload" => open(req),
        "/api/new" => new_file(req),
        "/api/save" => save(req),
        "/api/image" => image(req),
        "/api/glyph" => glyph(req),
        "/api/palette" => set_palette(req),
        "/api/import" => import(req),
        "/api/remove" => remove(req),
        "/api/rename" => rename(req),
        "/api/export" => export(req),
        "/api/close" => close(req),
        _ => Resp::err(404, "endpoint desconocido"),
    }
}

fn state(home: &Path) -> Resp {
    Resp::json(
        200,
        format!(
            "{{\"ok\":true,\"version\":{},\"home\":{}}}",
            jstr(env!("CARGO_PKG_VERSION")),
            jstr(&home.to_string_lossy())
        ),
    )
}

fn fs_list(req: &Request) -> Resp {
    let dir = q(req, "dir").unwrap_or("");
    if dir.is_empty() {
        let mut entries = Vec::new();
        for c in b'A'..=b'Z' {
            let p = format!("{}:\\", c as char);
            if Path::new(&p).exists() {
                entries.push(format!(
                    "{{\"name\":{},\"path\":{},\"dir\":true,\"size\":0}}",
                    jstr(&p),
                    jstr(&p)
                ));
            }
        }
        return Resp::json(
            200,
            format!(
                "{{\"ok\":true,\"dir\":\"\",\"parent\":null,\"entries\":[{}]}}",
                entries.join(",")
            ),
        );
    }

    let p = PathBuf::from(dir);
    let rd = match std::fs::read_dir(&p) {
        Ok(r) => r,
        Err(e) => return Resp::err(400, &format!("no se puede leer {dir}: {e}")),
    };

    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        let md = match ent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let item = format!(
            "{{\"name\":{},\"path\":{},\"dir\":{},\"size\":{}}}",
            jstr(&name),
            jstr(&ent.path().to_string_lossy()),
            md.is_dir(),
            md.len()
        );
        if md.is_dir() {
            dirs.push(item);
        } else {
            files.push(item);
        }
    }
    dirs.sort();
    files.sort();

    let parent_json = match p.parent() {
        Some(x) => jstr(&x.to_string_lossy()),
        None => "null".to_string(),
    };
    let mut all = dirs;
    all.extend(files);
    Resp::json(
        200,
        format!(
            "{{\"ok\":true,\"dir\":{},\"parent\":{},\"entries\":[{}]}}",
            jstr(dir),
            parent_json,
            all.join(",")
        ),
    )
}

/// Carga un fichero de disco y lo registra como documento abierto.
fn load_doc(path: &Path) -> Result<u64, String> {
    let raw = std::fs::read(path).map_err(|e| format!("no se puede leer {}: {e}", path.display()))?;
    let gz = gzip::is_gzip(&raw);
    let bytes = gzip::maybe_decompress(&raw).map_err(fmt_err)?;
    if bytes.len() < 3 {
        return Err("fichero demasiado corto".to_string());
    }
    let doc = match &bytes[0..3] {
        b"fpg" | b"f16" => Doc::Fpg {
            fpg: Fpg::read(&bytes).map_err(fmt_err)?,
            path: path.to_path_buf(),
            gzip: gz,
        },
        b"map" | b"m16" => Doc::Map {
            map: Map::read(&bytes).map_err(fmt_err)?,
            path: path.to_path_buf(),
            gzip: gz,
        },
        b"pal" => Doc::Pal {
            pal: Palette::read_pal_file(&bytes).map_err(fmt_err)?,
            path: path.to_path_buf(),
            gzip: gz,
        },
        b"fnt" => Doc::Fnt {
            fnt: Fnt::read(&bytes).map_err(fmt_err)?,
            path: path.to_path_buf(),
            gzip: gz,
        },
        other => {
            return Err(format!(
                "formato no reconocido: {:?}",
                String::from_utf8_lossy(other)
            ))
        }
    };
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    store().lock().unwrap().insert(id, doc);
    Ok(id)
}

fn open(req: &Request) -> Resp {
    let path = match q(req, "path") {
        Some(p) => p.to_string(),
        None => return Resp::err(400, "falta el parámetro path"),
    };
    match load_doc(Path::new(&path)) {
        Ok(id) => doc_response(id),
        Err(e) => Resp::err(400, &e),
    }
}

fn new_file(req: &Request) -> Resp {
    let path = match q(req, "path") {
        Some(p) => PathBuf::from(p),
        None => return Resp::err(400, "falta el parámetro path"),
    };
    let pal = match q(req, "palette") {
        Some(pp) => match std::fs::read(pp).ok().and_then(|b| {
            gzip::maybe_decompress(&b)
                .ok()
                .and_then(|d| Palette::read_pal_file(&d).ok())
        }) {
            Some(p) => p,
            None => return Resp::err(400, "no se ha podido leer la paleta indicada"),
        },
        None => Palette::new(),
    };
    let fpg = Fpg::new(8, Some(pal));
    let bytes = fpg.write();
    if let Err(e) = std::fs::write(&path, &bytes) {
        return Resp::err(400, &format!("no se puede escribir {}: {e}", path.display()));
    }
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    store().lock().unwrap().insert(
        id,
        Doc::Fpg {
            fpg,
            path,
            gzip: false,
        },
    );
    doc_response(id)
}

fn image(req: &Request) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let want = qnum::<u32>(req, "id");
    let frame = qnum::<usize>(req, "frame").unwrap_or(0);

    let g = store().lock().unwrap();
    let rgba = match g.get(&id) {
        Some(Doc::Fpg { fpg, .. }) => {
            let m = match want {
                Some(c) => fpg.maps.iter().find(|m| m.code == c),
                None => fpg.maps.first(),
            };
            match m {
                Some(m) => render::fpgmap_to_rgba(fpg, m, frame),
                None => return Resp::err(404, "ese id de mapa no existe"),
            }
        }
        Some(Doc::Map { map, .. }) => render::map_to_rgba(map, frame),
        Some(_) => return Resp::err(400, "este tipo de fichero no contiene mapas"),
        None => return Resp::err(404, "documento no encontrado"),
    };
    drop(g);

    match imageio::encode_png(&rgba) {
        Ok(b) => Resp::png(b),
        Err(e) => Resp::err(500, &e.to_string()),
    }
}

fn glyph(req: &Request) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let ch = qnum::<usize>(req, "ch").unwrap_or(0);

    let g = store().lock().unwrap();
    let rgba = match g.get(&id) {
        Some(Doc::Fnt { fnt, .. }) => render::glyph_to_rgba(fnt, ch),
        Some(_) => return Resp::err(400, "este fichero no es un FNT"),
        None => return Resp::err(404, "documento no encontrado"),
    };
    drop(g);

    match imageio::encode_png(&rgba) {
        Ok(b) => Resp::png(b),
        Err(e) => Resp::err(500, &e.to_string()),
    }
}

fn save(req: &Request) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let target = q(req, "path").map(PathBuf::from);
    let gz_flag = q(req, "gzip").map(|v| v == "1" || v == "true");

    let mut g = store().lock().unwrap();
    let doc = match g.get_mut(&id) {
        Some(d) => d,
        None => return Resp::err(404, "documento no encontrado"),
    };
    let out_path = target.clone().unwrap_or_else(|| doc.path().to_path_buf());
    let compress = gz_flag.unwrap_or_else(|| doc.gzip());

    let plain = match doc {
        Doc::Fpg { fpg, .. } => fpg.write(),
        Doc::Map { map, .. } => map.write(),
        Doc::Pal { pal, .. } => pal.write_pal_file(),
        Doc::Fnt { fnt, .. } => fnt.write(),
    };
    let bytes = if compress {
        match gzip::compress(&plain) {
            Ok(b) => b,
            Err(e) => return Resp::err(500, &e.to_string()),
        }
    } else {
        plain
    };

    if let Err(e) = std::fs::write(&out_path, &bytes) {
        return Resp::err(400, &format!("no se puede escribir {}: {e}", out_path.display()));
    }
    doc.set_path(out_path.clone());
    doc.set_gzip(compress);

    Resp::json(
        200,
        format!(
            "{{\"ok\":true,\"path\":{},\"bytes\":{},\"gzip\":{}}}",
            jstr(&out_path.to_string_lossy()),
            bytes.len(),
            compress
        ),
    )
}

fn set_palette(req: &Request) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };

    // Dos modos: cuerpo de 768 bytes (paleta completa) o parámetros r/g/b/índice.
    {
        let mut g = store().lock().unwrap();
        let pal = match g.get_mut(&id) {
            Some(Doc::Fpg { fpg, .. }) => fpg.palette.as_mut(),
            Some(Doc::Map { map, .. }) => map.palette.as_mut(),
            Some(Doc::Pal { pal, .. }) => Some(pal),
            Some(Doc::Fnt { fnt, .. }) => Some(&mut fnt.palette),
            None => return Resp::err(404, "documento no encontrado"),
        };
        let pal = match pal {
            Some(p) => p,
            None => return Resp::err(400, "este fichero no tiene paleta (16 bits)"),
        };

        if req.body.len() == 768 {
            pal.colors.copy_from_slice(&req.body);
        } else {
            let index = match qnum::<usize>(req, "index") {
                Some(i) if i < 256 => i,
                _ => return Resp::err(400, "falta el parámetro index (0..255)"),
            };
            let r = qnum::<u8>(req, "r").unwrap_or(0).min(63);
            let gg = qnum::<u8>(req, "g").unwrap_or(0).min(63);
            let b = qnum::<u8>(req, "b").unwrap_or(0).min(63);
            pal.set_rgb(index, r, gg, b);
        }
    }

    doc_response(id)
}

fn import(req: &Request) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let img_path = match q(req, "path") {
        Some(p) => PathBuf::from(p),
        None => return Resp::err(400, "falta el parámetro path (imagen a importar)"),
    };
    let force_id = qnum::<u32>(req, "id");
    let name = q(req, "name").map(|s| s.to_string());

    // Decodifica la imagen antes de bloquear el almacén.
    let rgba = match imageio::read_rgba(&img_path) {
        Ok(r) => r,
        Err(e) => return Resp::err(400, &format!("no se puede leer la imagen: {e}")),
    };

    let mut g = store().lock().unwrap();
    let fpg = match g.get_mut(&id) {
        Some(Doc::Fpg { fpg, .. }) => fpg,
        Some(_) => return Resp::err(400, "solo se pueden importar imágenes en un FPG"),
        None => return Resp::err(404, "documento no encontrado"),
    };
    if fpg.depth != 8 {
        return Resp::err(400, "la importación solo está implementada para FPG de 8 bits");
    }

    let pal = fpg.palette.clone().unwrap_or_default();
    let indices = imageio::map_to_palette(&rgba, &pal);
    let code = force_id.unwrap_or_else(|| fpg.maps.iter().map(|m| m.code).max().unwrap_or(0) + 1);
    if fpg.maps.iter().any(|m| m.code == code) {
        return Resp::err(400, &format!("ya existe un mapa con el id {code}"));
    }

    let mut m = FpgMap::new(code, rgba.width as i32, rgba.height as i32, 8);
    m.pixels = indices;
    m.set_name(&name.unwrap_or_else(|| format!("Mapa {code}")));
    m.set_filename(&base_name(&img_path));
    fpg.maps.push(m);
    Resp::json(200, format!("{{\"ok\":true,\"id\":{code}}}"))
}

fn remove(req: &Request) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let code = match qnum::<u32>(req, "id") {
        Some(c) => c,
        None => return Resp::err(400, "falta el parámetro id"),
    };
    let mut g = store().lock().unwrap();
    let fpg = match g.get_mut(&id) {
        Some(Doc::Fpg { fpg, .. }) => fpg,
        Some(_) => return Resp::err(400, "solo se pueden eliminar mapas de un FPG"),
        None => return Resp::err(404, "documento no encontrado"),
    };
    let before = fpg.maps.len();
    fpg.maps.retain(|m| m.code != code);
    if fpg.maps.len() == before {
        return Resp::err(404, &format!("no existe el mapa {code}"));
    }
    Resp::ok()
}

fn rename(req: &Request) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let code = match qnum::<u32>(req, "id") {
        Some(c) => c,
        None => return Resp::err(400, "falta el parámetro id"),
    };
    let mut g = store().lock().unwrap();
    let fpg = match g.get_mut(&id) {
        Some(Doc::Fpg { fpg, .. }) => fpg,
        Some(_) => return Resp::err(400, "solo se pueden renombrar mapas de un FPG"),
        None => return Resp::err(404, "documento no encontrado"),
    };
    let m = match fpg.maps.iter_mut().find(|m| m.code == code) {
        Some(m) => m,
        None => return Resp::err(404, &format!("no existe el mapa {code}")),
    };
    if let Some(n) = q(req, "name") {
        m.set_name(n);
    }
    if let Some(f) = q(req, "filename") {
        m.set_filename(f);
    }
    Resp::ok()
}

fn export(req: &Request) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let out = match q(req, "path") {
        Some(p) => PathBuf::from(p),
        None => return Resp::err(400, "falta el parámetro path (destino)"),
    };
    let fmt = q(req, "format").unwrap_or("png").to_ascii_lowercase();
    let want = qnum::<u32>(req, "id");
    let frame = qnum::<usize>(req, "frame").unwrap_or(0);

    let g = store().lock().unwrap();
    let doc = match g.get(&id) {
        Some(d) => d,
        None => return Resp::err(404, "documento no encontrado"),
    };

    // Imagen indexada (BMP/PCX) e imagen RGBA (PNG/JPEG) según el formato.
    let indexed: Option<IndexedImage> = match doc {
        Doc::Fpg { fpg, .. } => {
            let m = match want {
                Some(c) => fpg.maps.iter().find(|m| m.code == c),
                None => fpg.maps.first(),
            };
            match m {
                Some(m) => render::fpgmap_to_indexed(fpg, m, frame).ok(),
                None => return Resp::err(404, "ese id de mapa no existe"),
            }
        }
        Doc::Map { map, .. } => render::map_to_indexed(map, frame).ok(),
        _ => return Resp::err(400, "este fichero no contiene mapas"),
    };

    let res = match fmt.as_str() {
        "png" => indexed.map(|i| imageio::write_indexed_png(&out, &i)),
        "bmp" => indexed.map(|i| imageio::write_bmp(&out, &i)),
        "pcx" => indexed.map(|i| imageio::write_pcx(&out, &i)),
        "jpeg" | "jpg" => {
            let rgba = match doc {
                Doc::Fpg { fpg, .. } => {
                    let m = fpg.maps.iter().find(|m| Some(m.code) == want).or_else(|| fpg.maps.first());
                    m.map(|m| render::fpgmap_to_rgba(fpg, m, frame))
                }
                Doc::Map { map, .. } => Some(render::map_to_rgba(map, frame)),
                _ => None,
            };
            rgba.map(|r| imageio::write_jpeg(&out, &r, 90))
        }
        other => return Resp::err(400, &format!("formato de salida desconocido: {other}")),
    };

    match res {
        Some(Ok(())) => Resp::json(
            200,
            format!("{{\"ok\":true,\"path\":{}}}", jstr(&out.to_string_lossy())),
        ),
        Some(Err(e)) => Resp::err(500, &e.to_string()),
        None => Resp::err(400, "no hay imagen que exportar"),
    }
}

fn close(req: &Request) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    store().lock().unwrap().remove(&id);
    Resp::ok()
}
