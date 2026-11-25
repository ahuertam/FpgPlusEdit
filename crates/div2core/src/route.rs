//! Enrutado de las operaciones del editor.
//!
//! Es el mismo conjunto de endpoints que expone el servidor local por `/api/`,
//! pero aquí no se habla HTTP ni se toca el disco: se recibe una [`Request`] ya
//! descompuesta y se devuelve una [`Resp`]. Todo lo que necesita leer o
//! escribir ficheros pasa por el [`Fs`] que entrega el frontal.

use crate::store::{Doc, Store};
use crate::{base_name, jstr, Entry, Env, Fs, Request, Resp};
use div2fmt::imageio::{self};
use div2fmt::{gzip, render, ControlPoint, Fnt, Fpg, FpgMap, Map, Palette};

/// Máximo de puntos de control admitido por un mapa (índices 0..=0x0FFE).
pub const MAX_POINTS: usize = 0x0FFF;

/// Máximo de baldosas que puede generar un troceado de mapa.
const MAX_SPLIT_TILES: usize = 4096;

/// Tope de bytes del búfer de un mapa (todos los fotogramas juntos).
const MAX_MAP_BYTES: usize = 256 * 1024 * 1024;

/// Atiende una petición. El `fs` solo se usa en los endpoints que lo necesitan.
pub fn route(store: &mut Store, req: &Request, env: &Env, fs: &mut dyn Fs) -> Resp {
    // La interfaz llama con la ruta completa (`/api/open`); el puente de
    // WebAssembly pasa solo el nombre (`open`). Aquí valen las dos formas.
    let op = req.path.trim_start_matches("/api/").trim_start_matches('/');
    match op {
        "state" => state(env),
        "fs" => fs_list(req, fs),
        "open" | "reload" => open(req, store, fs),
        "drop" => drop_file(req, store, fs),
        "new" => new_file(req, store, fs),
        "save" => save(req, store, fs),
        "image" => image(req, store),
        "glyph" => glyph(req, store),
        "pixels" => pixels(req, store),
        "map" => map_meta(req, store),
        "map_add" => map_add(req, store),
        "map_resize" => map_resize(req, store),
        "map_split" => map_split(req, store),
        "mural" => mural(req, store),
        "mural_new" => mural_new(req, store),
        "points" => points(req, store),
        "move" => move_map(req, store),
        "palette" => set_palette(req, store),
        "import" => import(req, store, fs),
        "remove" => remove(req, store),
        "rename" => rename(req, store),
        "export" => export(req, store, fs),
        "close" => close(req, store),
        _ => Resp::err(404, "endpoint desconocido"),
    }
}

fn fmt_err(e: div2fmt::Error) -> String {
    e.to_string()
}

fn needs_doc(req: &Request) -> Result<u64, Resp> {
    req.qnum::<u64>("doc")
        .ok_or_else(|| Resp::err(400, "falta el parámetro doc"))
}

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

fn state(env: &Env) -> Resp {
    Resp::json(
        200,
        format!(
            "{{\"ok\":true,\"version\":{},\"home\":{}}}",
            jstr(&env.version),
            jstr(&env.home)
        ),
    )
}

fn fs_list(req: &Request, fs: &mut dyn Fs) -> Resp {
    let dir = req.q("dir").unwrap_or("");
    let entries = match fs.list(dir) {
        Ok(e) => e,
        Err(e) => return Resp::err(400, &e.to_string()),
    };
    let parent_json = match parent_of(dir) {
        Some(x) => jstr(&x),
        None => "null".to_string(),
    };
    let items: Vec<String> = entries.iter().map(Entry::json).collect();
    Resp::json(
        200,
        format!(
            "{{\"ok\":true,\"dir\":{},\"parent\":{},\"entries\":[{}]}}",
            jstr(dir),
            parent_json,
            items.join(",")
        ),
    )
}

/// Carpeta contenedora, o `None` si ya estamos en la raíz del selector.
fn parent_of(dir: &str) -> Option<String> {
    let d = dir.trim_end_matches(['/', '\\']);
    if d.is_empty() {
        return None;
    }
    // En Windows, «G:\» no tiene padre útil: se vuelve al listado de unidades.
    if d.len() == 2 && d.ends_with(':') {
        return Some(String::new());
    }
    match d.rfind(['/', '\\']) {
        Some(i) if i >= 2 => Some(d[..i].to_string()),
        _ => Some(String::new()),
    }
}

/// Carga bytes ya descomprimidos y los registra como documento abierto.
fn open_bytes(bytes: &[u8], raw: &[u8], path: String, store: &mut Store) -> Result<u64, String> {
    if bytes.len() < 3 {
        return Err("fichero demasiado corto".to_string());
    }
    let gz = gzip::is_gzip(raw);
    let size = raw.len() as u64;
    let doc = match &bytes[0..3] {
        b"fpg" | b"f16" => Doc::Fpg {
            fpg: Fpg::read(bytes).map_err(fmt_err)?,
            path,
            size,
            gzip: gz,
        },
        b"map" | b"m16" => Doc::Map {
            map: Map::read(bytes).map_err(fmt_err)?,
            path,
            size,
            gzip: gz,
        },
        b"pal" => Doc::Pal {
            pal: Palette::read_pal_file(bytes).map_err(fmt_err)?,
            path,
            size,
            gzip: gz,
        },
        b"fnt" => Doc::Fnt {
            fnt: Fnt::read(bytes).map_err(fmt_err)?,
            path,
            size,
            gzip: gz,
        },
        other => {
            return Err(format!(
                "formato no reconocido: {:?}",
                String::from_utf8_lossy(other)
            ))
        }
    };
    Ok(store.insert(doc))
}

fn open(req: &Request, store: &mut Store, fs: &mut dyn Fs) -> Resp {
    let path = match req.q("path") {
        Some(p) => p.to_string(),
        None => return Resp::err(400, "falta el parámetro path"),
    };
    let raw = match fs.read(&path) {
        Ok(b) => b,
        Err(e) => return Resp::err(400, &format!("no se puede leer {path}: {e}")),
    };
    let bytes = match gzip::maybe_decompress(&raw) {
        Ok(b) => b,
        Err(e) => return Resp::err(400, &fmt_err(e)),
    };
    match open_bytes(&bytes, &raw, path, store) {
        Ok(id) => store.doc_response(id),
        Err(e) => Resp::err(400, &e),
    }
}

/// Abre un recurso soltado sobre la ventana.
///
/// El navegador no revela la ruta original de un fichero arrastrado, solo su
/// contenido; así que este llega en el cuerpo de la petición y es [`Fs`] quien
/// decide dónde dejarlo (en el editor local, una carpeta temporal; en la
/// versión web, en ningún sitio, porque el documento vive en memoria). La
/// interfaz marca el documento como «copia», de modo que el primer guardado
/// pida destino real.
fn drop_file(req: &Request, store: &mut Store, fs: &mut dyn Fs) -> Resp {
    let name = match req.q("name") {
        Some(n) => n.to_string(),
        None => return Resp::err(400, "falta el parámetro name"),
    };
    if req.body.is_empty() {
        return Resp::err(400, "la petición no trae ningún fichero");
    }
    // Solo se conserva el nombre, nunca la ruta: así una cabecera mal formada
    // no puede hacer que se escriba fuera de la carpeta temporal.
    let safe = base_name(&name);
    if safe.is_empty() || safe == "." || safe == ".." {
        return Resp::err(400, "nombre de fichero no válido");
    }
    let path = match fs.place_dropped(&safe, &req.body) {
        Ok(p) => p,
        Err(e) => return Resp::err(500, &format!("no se puede dejar {safe}: {e}")),
    };
    let bytes = match gzip::maybe_decompress(&req.body) {
        Ok(b) => b,
        Err(e) => return Resp::err(400, &fmt_err(e)),
    };
    match open_bytes(&bytes, &req.body, path, store) {
        Ok(id) => store.doc_response_extra(id, "\"dropped\":true"),
        Err(e) => Resp::err(400, &e),
    }
}

/// Serializa el documento tal y como se guardaría en disco.
fn doc_write_bytes(doc: &Doc) -> Vec<u8> {
    match doc {
        Doc::Fpg { fpg, .. } => fpg.write(),
        Doc::Map { map, .. } => map.write(),
        Doc::Pal { pal, .. } => pal.write_pal_file(),
        Doc::Fnt { fnt, .. } => fnt.write(),
    }
}

/// Lee la paleta indicada en `palette` (una ruta), si la hay.
fn palette_param(req: &Request, fs: &mut dyn Fs) -> Result<Option<Palette>, Resp> {
    match req.q("palette") {
        Some(pp) => match fs.read(pp).ok().and_then(|b| {
            gzip::maybe_decompress(&b)
                .ok()
                .and_then(|d| Palette::read_pal_file(&d).ok())
        }) {
            Some(p) => Ok(Some(p)),
            None => Err(Resp::err(400, "no se ha podido leer la paleta indicada")),
        },
        None => Ok(None),
    }
}

/// Ancho y alto pedidos, con los mismos límites que el editor gráfico.
fn dims(req: &Request) -> Result<(i32, i32), Resp> {
    let w = req.qnum::<i32>("w").unwrap_or(0);
    let h = req.qnum::<i32>("h").unwrap_or(0);
    if w < 1 || h < 1 {
        return Err(Resp::err(400, "indica un ancho y un alto de al menos 1×1"));
    }
    if w > 4096 || h > 4096 {
        return Err(Resp::err(400, "el tamaño máximo es 4096×4096"));
    }
    Ok((w, h))
}

/// Crea un fichero en blanco: un FPG, un MAP suelto, una PAL o un FNT.
///
/// `kind` decide qué se crea (`fpg` por defecto, `f16`, `map`, `m16`, `pal`,
/// `fnt`). Para MAP hacen falta el ancho y el alto; para FPG son opcionales,
/// pero si vienen el FPG nace con un primer mapa de ese tamaño, que es lo
/// cómodo para empezar a pintar. La paleta es opcional y, si no se indica, se
/// usa una vacía (o la que traiga el propio MAP de 8 bits).
fn new_file(req: &Request, store: &mut Store, fs: &mut dyn Fs) -> Resp {
    let path = match req.q("path") {
        Some(p) => p.to_string(),
        None => return Resp::err(400, "falta el parámetro path"),
    };
    let kind = req.q("kind").unwrap_or("fpg").to_ascii_lowercase();
    let pal = match palette_param(req, fs) {
        Ok(p) => p,
        Err(r) => return r,
    };

    let mut doc = match kind.as_str() {
        "fpg" | "f16" => {
            let depth = if kind == "f16" { 16 } else { 8 };
            let mut fpg = Fpg::new(depth, pal);
            // Con medidas, el FPG arranca con un mapa en blanco: así «Nuevo FPG»
            // deja un lienzo listo para pintar en vez de una lista vacía.
            if let Ok((w, h)) = dims(req) {
                fpg.maps.push(FpgMap::new(1, w, h, depth));
            }
            Doc::Fpg {
                fpg,
                path: path.clone(),
                size: 0,
                gzip: false,
            }
        }
        "map" | "m16" => {
            let depth = if kind == "m16" { 16 } else { 8 };
            let (w, h) = match dims(req) {
                Ok(v) => v,
                Err(r) => return r,
            };
            let mut map = Map::new(
                w as i16,
                h as i16,
                req.qnum::<u32>("id").unwrap_or(0),
                depth,
                pal,
            );
            if let Some(n) = req.q("name") {
                map.set_name(n);
            }
            Doc::Map {
                map,
                path: path.clone(),
                size: 0,
                gzip: false,
            }
        }
        "pal" => Doc::Pal {
            pal: pal.unwrap_or_else(Palette::new),
            path: path.clone(),
            size: 0,
            gzip: false,
        },
        "fnt" => Doc::Fnt {
            fnt: Fnt::new(pal.unwrap_or_else(Palette::new)),
            path: path.clone(),
            size: 0,
            gzip: false,
        },
        other => return Resp::err(400, &format!("tipo de fichero desconocido: {other}")),
    };

    let bytes = doc_write_bytes(&doc);
    if let Err(e) = fs.write(&path, &bytes) {
        return Resp::err(400, &format!("no se puede escribir {path}: {e}"));
    }
    doc.set_size(bytes.len() as u64);
    let id = store.insert(doc);
    store.doc_response(id)
}

fn save(req: &Request, store: &mut Store, fs: &mut dyn Fs) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let target = req.q("path").map(|s| s.to_string());
    let gz_flag = req.q("gzip").map(|v| v == "1" || v == "true");

    let g = store.get(id);
    let doc = match g {
        Some(d) => d,
        None => return Resp::err(404, "documento no encontrado"),
    };
    let out_path = target.unwrap_or_else(|| doc.path().to_string());
    let compress = gz_flag.unwrap_or_else(|| doc.gzip());

    let plain = doc_write_bytes(doc);
    let bytes = if compress {
        match gzip::compress(&plain) {
            Ok(b) => b,
            Err(e) => return Resp::err(500, &e.to_string()),
        }
    } else {
        plain
    };

    if let Err(e) = fs.write(&out_path, &bytes) {
        return Resp::err(400, &format!("no se puede escribir {out_path}: {e}"));
    }
    let n = bytes.len() as u64;
    if let Some(doc) = store.get_mut(id) {
        doc.set_path(out_path.clone());
        doc.set_gzip(compress);
        doc.set_size(n);
    }

    Resp::json(
        200,
        format!(
            "{{\"ok\":true,\"path\":{},\"bytes\":{},\"gzip\":{}}}",
            jstr(&out_path),
            n,
            compress
        ),
    )
}

fn image(req: &Request, store: &Store) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let want = req.qnum::<u32>("id");
    let frame = req.qnum::<usize>("frame").unwrap_or(0);

    let rgba = match store.get(id) {
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

    match imageio::encode_png(&rgba) {
        Ok(b) => Resp::png(b),
        Err(e) => Resp::err(500, &e.to_string()),
    }
}

fn glyph(req: &Request, store: &Store) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let ch = req.qnum::<usize>("ch").unwrap_or(0);

    let rgba = match store.get(id) {
        Some(Doc::Fnt { fnt, .. }) => render::glyph_to_rgba(fnt, ch),
        Some(_) => return Resp::err(400, "este fichero no es un FNT"),
        None => return Resp::err(404, "documento no encontrado"),
    };

    match imageio::encode_png(&rgba) {
        Ok(b) => Resp::png(b),
        Err(e) => Resp::err(500, &e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// píxeles (editor de pintura)
// ---------------------------------------------------------------------------

/// Acceso común a los píxeles de un mapa, sea de un FPG o de un MAP suelto.
///
/// El búfer guarda los fotogramas uno tras otro: `w · h · bpp` bytes por
/// fotograma, donde `bpp` es 1 en mapas de 8 bits (un índice de paleta por
/// píxel) y 2 en los de 16 (RGB565 little-endian).
trait PixAccess {
    fn width(&self) -> i32;
    fn height(&self) -> i32;
    fn depth(&self) -> u8;
    fn frames(&self) -> usize;
    fn pixels(&self) -> &Vec<u8>;
    fn pixels_mut(&mut self) -> &mut Vec<u8>;
    /// Fija las dimensiones tras rehacer el búfer (redimensionar, trocear).
    fn set_size(&mut self, w: i32, h: i32);
}

impl PixAccess for FpgMap {
    fn width(&self) -> i32 {
        self.width
    }
    fn height(&self) -> i32 {
        self.height
    }
    fn depth(&self) -> u8 {
        self.depth
    }
    fn frames(&self) -> usize {
        FpgMap::frames(self)
    }
    fn pixels(&self) -> &Vec<u8> {
        &self.pixels
    }
    fn pixels_mut(&mut self) -> &mut Vec<u8> {
        &mut self.pixels
    }
    fn set_size(&mut self, w: i32, h: i32) {
        self.width = w;
        self.height = h;
    }
}

impl PixAccess for Map {
    fn width(&self) -> i32 {
        self.width as i32
    }
    fn height(&self) -> i32 {
        self.height as i32
    }
    fn depth(&self) -> u8 {
        self.depth
    }
    fn frames(&self) -> usize {
        Map::frames(self)
    }
    fn pixels(&self) -> &Vec<u8> {
        &self.pixels
    }
    fn pixels_mut(&mut self) -> &mut Vec<u8> {
        &mut self.pixels
    }
    fn set_size(&mut self, w: i32, h: i32) {
        self.width = w as i16;
        self.height = h as i16;
    }
}

fn bpp_of(depth: u8) -> usize {
    if depth == 16 {
        2
    } else {
        1
    }
}

/// Longitud en bytes de un fotograma.
fn frame_len<T: PixAccess>(m: &T) -> usize {
    (m.width().max(0) as usize) * (m.height().max(0) as usize) * bpp_of(m.depth())
}

/// Copia el fotograma `frame` (relleno a cero si el búfer se queda corto).
fn read_frame<T: PixAccess>(m: &T, frame: usize) -> Vec<u8> {
    let len = frame_len(m);
    let start = frame.saturating_mul(len);
    let mut out = m.pixels().get(start..start + len).unwrap_or(&[]).to_vec();
    out.resize(len, 0);
    out
}

/// Escribe un rectángulo dentro del fotograma `frame`.
///
/// `rect` es `(x, y, ancho, alto)` y `data` trae los píxeles por filas
/// (`ancho · alto · bpp` bytes). El resto del fotograma no se toca.
fn write_rect<T: PixAccess>(
    m: &mut T,
    frame: usize,
    rect: (usize, usize, usize, usize),
    data: &[u8],
) -> Result<(), Resp> {
    let (x, y, w, h) = rect;
    let (mw, mh) = (m.width().max(0) as usize, m.height().max(0) as usize);
    if w == 0 || h == 0 {
        return Ok(());
    }
    if x.checked_add(w).map_or(true, |end| end > mw)
        || y.checked_add(h).map_or(true, |end| end > mh)
    {
        return Err(Resp::err(
            400,
            &format!("el rectángulo {w}×{h} en {x},{y} se sale del mapa {mw}×{mh}"),
        ));
    }
    if frame >= m.frames() {
        return Err(Resp::err(
            400,
            &format!("el fotograma {frame} no existe (hay {})", m.frames()),
        ));
    }
    let bpp = bpp_of(m.depth());
    let row = w * bpp;
    if data.len() != row * h {
        return Err(Resp::err(
            400,
            &format!("se esperaban {} bytes y han llegado {}", row * h, data.len()),
        ));
    }
    let flen = frame_len(m);
    let base = frame * flen;
    let px = m.pixels_mut();
    // Por si el búfer venía corto (ficheros truncados): se completa a cero.
    if px.len() < base + flen {
        px.resize(base + flen, 0);
    }
    for r in 0..h {
        let dst = base + ((y + r) * mw + x) * bpp;
        px[dst..dst + row].copy_from_slice(&data[r * row..(r + 1) * row]);
    }
    Ok(())
}

/// Localiza el mapa al que se refiere la petición (`id` = código del mapa).
macro_rules! with_map {
    ($doc:expr, $want:expr, $code:ident => $body:expr) => {{
        let want = $want;
        match $doc {
            Doc::Fpg { fpg, .. } => {
                let code = match want {
                    Some(c) => c,
                    None => return Resp::err(400, "falta el parámetro id"),
                };
                match fpg.maps.iter_mut().find(|m| m.code == code) {
                    Some($code) => $body,
                    None => return Resp::err(404, "ese id de mapa no existe"),
                }
            }
            Doc::Map { map, .. } => {
                let $code = map;
                $body
            }
            _ => return Resp::err(400, "este tipo de fichero no contiene mapas"),
        }
    }};
}

fn pixels(req: &Request, store: &mut Store) -> Resp {
    if req.method.eq_ignore_ascii_case("GET") {
        pixels_read(req, store)
    } else {
        pixels_write(req, store)
    }
}

fn pixels_read(req: &Request, store: &Store) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let frame = req.qnum::<usize>("frame").unwrap_or(0);
    let want = req.qnum::<u32>("id");

    match store.get(id) {
        Some(Doc::Fpg { fpg, .. }) => {
            let m = match want {
                Some(c) => fpg.maps.iter().find(|m| m.code == c),
                None => fpg.maps.first(),
            };
            match m {
                Some(m) => Resp::bytes("application/octet-stream", read_frame(m, frame)),
                None => Resp::err(404, "ese id de mapa no existe"),
            }
        }
        Some(Doc::Map { map, .. }) => {
            Resp::bytes("application/octet-stream", read_frame(map, frame))
        }
        Some(_) => Resp::err(400, "este tipo de fichero no contiene mapas"),
        None => Resp::err(404, "documento no encontrado"),
    }
}

fn pixels_write(req: &Request, store: &mut Store) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let frame = req.qnum::<usize>("frame").unwrap_or(0);
    let want = req.qnum::<u32>("id");

    let doc = match store.get_mut(id) {
        Some(d) => d,
        None => return Resp::err(404, "documento no encontrado"),
    };

    let res = with_map!(doc, want, m => {
        let (mw, mh) = (m.width().max(0) as usize, m.height().max(0) as usize);
        // Sin rectángulo se sustituye el fotograma completo. Si se indica uno,
        // tienen que venir los cuatro valores: así un parámetro suelto mal
        // formado no acaba reemplazando el fotograma entero sin avisar.
        let rect = match (
            req.qnum::<usize>("x"),
            req.qnum::<usize>("y"),
            req.qnum::<usize>("w"),
            req.qnum::<usize>("h"),
        ) {
            (None, None, None, None) => (0, 0, mw, mh),
            (Some(x), Some(y), Some(w), Some(h)) => (x, y, w, h),
            _ => return Resp::err(400, "para escribir un rectángulo hacen falta x, y, w y h"),
        };
        write_rect(m, frame, rect, &req.body)
    });

    match res {
        Ok(()) => Resp::ok(),
        Err(r) => r,
    }
}

fn set_palette(req: &Request, store: &mut Store) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };

    // Dos modos: cuerpo de 768 bytes (paleta completa) o parámetros r/g/b/índice.
    {
        let doc = match store.get_mut(id) {
            Some(d) => d,
            None => return Resp::err(404, "documento no encontrado"),
        };
        let pal = match doc {
            Doc::Fpg { fpg, .. } => fpg.palette.as_mut(),
            Doc::Map { map, .. } => map.palette.as_mut(),
            Doc::Pal { pal, .. } => Some(pal),
            Doc::Fnt { fnt, .. } => Some(&mut fnt.palette),
        };
        let pal = match pal {
            Some(p) => p,
            None => return Resp::err(400, "este fichero no tiene paleta (16 bits)"),
        };

        if req.body.len() == 768 {
            pal.colors.copy_from_slice(&req.body);
        } else {
            let index = match req.qnum::<usize>("index") {
                Some(i) if i < 256 => i,
                _ => return Resp::err(400, "falta el parámetro index (0..255)"),
            };
            let r = req.qnum::<u8>("r").unwrap_or(0).min(63);
            let g = req.qnum::<u8>("g").unwrap_or(0).min(63);
            let b = req.qnum::<u8>("b").unwrap_or(0).min(63);
            pal.set_rgb(index, r, g, b);
        }
    }

    store.doc_response(id)
}

fn import(req: &Request, store: &mut Store, fs: &mut dyn Fs) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let img_path = req.q("path").map(|s| s.to_string());
    let force_id = req.qnum::<u32>("id");
    let name = req.q("name").map(|s| s.to_string());

    // La imagen puede venir en el cuerpo (versión web, que no tiene rutas) o
    // como ruta en el disco (editor local).
    let (data, label) = match (req.body.is_empty(), img_path.clone()) {
        (false, _) => (req.body.clone(), name.clone().unwrap_or_default()),
        (true, Some(p)) => match fs.read(&p) {
            Ok(b) => (b, base_name(&p)),
            Err(e) => return Resp::err(400, &format!("no se puede leer la imagen: {e}")),
        },
        (true, None) => return Resp::err(400, "falta la imagen que importar"),
    };
    let rgba = match imageio::decode_image_rgba(&data, &label) {
        Ok(r) => r,
        Err(e) => return Resp::err(400, &format!("no se puede leer la imagen: {e}")),
    };
    if rgba.width == 0 || rgba.height == 0 {
        return Resp::err(400, "la imagen no tiene tamaño");
    }
    if rgba.width > 4096 || rgba.height > 4096 {
        return Resp::err(
            400,
            &format!(
                "la imagen {}×{} supera el tamaño máximo de 4096×4096",
                rgba.width, rgba.height
            ),
        );
    }

    let doc = match store.get_mut(id) {
        Some(d) => d,
        None => return Resp::err(404, "documento no encontrado"),
    };
    let fpg = match doc {
        Doc::Fpg { fpg, .. } => fpg,
        _ => return Resp::err(400, "solo se pueden importar imágenes en un FPG"),
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
    m.set_filename(&label);
    fpg.maps.push(m);

    // Se devuelve el documento entero: el mapa vive en memoria hasta que se
    // guarde, así que recargarlo desde disco lo haría desaparecer.
    store.doc_response_extra(id, &format!("\"new_id\":{code}"))
}

fn remove(req: &Request, store: &mut Store) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let code = match req.qnum::<u32>("id") {
        Some(c) => c,
        None => return Resp::err(400, "falta el parámetro id"),
    };
    let fpg = match store.get_mut(id) {
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

fn rename(req: &Request, store: &mut Store) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let code = match req.qnum::<u32>("id") {
        Some(c) => c,
        None => return Resp::err(400, "falta el parámetro id"),
    };
    let fpg = match store.get_mut(id) {
        Some(Doc::Fpg { fpg, .. }) => fpg,
        Some(_) => return Resp::err(400, "solo se pueden renombrar mapas de un FPG"),
        None => return Resp::err(404, "documento no encontrado"),
    };
    let m = match fpg.maps.iter_mut().find(|m| m.code == code) {
        Some(m) => m,
        None => return Resp::err(404, &format!("no existe el mapa {code}")),
    };
    if let Some(n) = req.q("name") {
        m.set_name(n);
    }
    if let Some(f) = req.q("filename") {
        m.set_filename(f);
    }
    Resp::ok()
}

fn map_meta(req: &Request, store: &mut Store) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let code = match req.qnum::<u32>("id") {
        Some(c) => c,
        None => return Resp::err(400, "falta el parámetro id"),
    };
    let new_id = req.qnum::<u32>("new_id");
    let name = req.q("name").map(|s| s.to_string());
    let filename = req.q("filename").map(|s| s.to_string());

    {
        let fpg = match store.get_mut(id) {
            Some(Doc::Fpg { fpg, .. }) => fpg,
            Some(_) => return Resp::err(400, "solo se pueden editar mapas de un FPG"),
            None => return Resp::err(404, "documento no encontrado"),
        };
        let pos = match fpg.maps.iter().position(|m| m.code == code) {
            Some(i) => i,
            None => return Resp::err(404, &format!("no existe el mapa {code}")),
        };
        if let Some(next) = new_id {
            if next == 0 {
                return Resp::err(400, "el id debe ser mayor que cero");
            }
            if next != code && fpg.maps.iter().any(|m| m.code == next) {
                return Resp::err(400, &format!("ya existe un mapa con el id {next}"));
            }
            fpg.maps[pos].code = next;
        }
        if let Some(v) = name {
            fpg.maps[pos].set_name(&v);
        }
        if let Some(v) = filename {
            fpg.maps[pos].set_filename(&v);
        }
    }

    store.doc_response(id)
}

/// Añade un mapa a un FPG: en blanco o copiando otro (que es lo que hace
/// «duplicar» y «copiar el gráfico a otra ventana»).
///
/// Con `from` se clona el mapa indicado (píxeles, puntos y animación); sin él,
/// se crea vacío del tamaño que pidan `w` y `h`. El id nuevo es el de `id` o,
/// si no se indica, el siguiente libre.
fn map_add(req: &Request, store: &mut Store) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let from = req.qnum::<u32>("from");
    let want_id = req.qnum::<u32>("id");
    let name = req.q("name").map(|s| s.to_string());

    let code = {
        let fpg = match store.get_mut(id) {
            Some(Doc::Fpg { fpg, .. }) => fpg,
            Some(_) => return Resp::err(400, "solo se pueden añadir mapas a un FPG"),
            None => return Resp::err(404, "documento no encontrado"),
        };

        let mut m = match from {
            Some(src) => match fpg.maps.iter().find(|m| m.code == src) {
                Some(m) => m.clone(),
                None => return Resp::err(404, &format!("no existe el mapa {src}")),
            },
            None => {
                let (w, h) = match dims(req) {
                    Ok(v) => v,
                    Err(r) => return r,
                };
                FpgMap::new(0, w, h, fpg.depth)
            }
        };

        let code = match want_id {
            Some(c) => c,
            None => fpg
                .maps
                .iter()
                .map(|m| m.code)
                .max()
                .unwrap_or(0)
                .saturating_add(1),
        };
        if code == 0 {
            return Resp::err(400, "el id debe ser mayor que cero");
        }
        if fpg.maps.iter().any(|m| m.code == code) {
            return Resp::err(400, &format!("ya existe un mapa con el id {code}"));
        }
        m.code = code;
        if let Some(n) = name {
            m.set_name(&n);
        }
        fpg.maps.push(m);
        code
    };

    store.doc_response_extra(id, &format!("\"new_id\":{code}"))
}

/// Cambia el tamaño de un mapa (recorta o rellena con 0), conservando el
/// contenido según el ancla (`tl`, `mc`, `br`…; por defecto la esquina
/// superior izquierda, que es como recortan los editores de siempre).
fn map_resize(req: &Request, store: &mut Store) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let (w, h) = match dims(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let anchor = req.q("anchor").unwrap_or("tl").to_string();
    let want = req.qnum::<u32>("id");

    let res = {
        let doc = match store.get_mut(id) {
            Some(d) => d,
            None => return Resp::err(404, "documento no encontrado"),
        };
        with_map!(doc, want, m => resize_pixels(m, w as usize, h as usize, &anchor))
    };

    match res {
        Ok(()) => store.doc_response(id),
        Err(r) => r,
    }
}

/// Trocea un mapa del FPG en baldosas de `w`×`h` y las añade como mapas
/// nuevos. Es la vuelta de «transferir un FPG completo a un mapa».
fn map_split(req: &Request, store: &mut Store) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let (tw, th) = match dims(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let src_code = req.qnum::<u32>("id");

    let first = {
        let fpg = match store.get_mut(id) {
            Some(Doc::Fpg { fpg, .. }) => fpg,
            Some(_) => return Resp::err(400, "solo se puede trocear dentro de un FPG"),
            None => return Resp::err(404, "documento no encontrado"),
        };
        let src = match src_code {
            Some(c) => match fpg.maps.iter().find(|m| m.code == c) {
                Some(m) => m.clone(),
                None => return Resp::err(404, &format!("no existe el mapa {c}")),
            },
            None => match fpg.maps.first() {
                Some(m) => m.clone(),
                None => return Resp::err(400, "el FPG no tiene mapas"),
            },
        };

        let (sw, sh) = (src.width.max(0) as usize, src.height.max(0) as usize);
        let (tw, th) = (tw as usize, th as usize);
        let bpp = bpp_of(src.depth);
        let mut next = fpg.maps.iter().map(|m| m.code).max().unwrap_or(0);
        let mut first = None;
        let cols = sw.div_ceil(tw);
        let rows = sh.div_ceil(th);
        let tiles = cols.saturating_mul(rows);
        if tiles > MAX_SPLIT_TILES {
            return Resp::err(
                400,
                &format!(
                    "el troceado daría {tiles} baldosas (máximo {MAX_SPLIT_TILES}); usa baldosas mayores"
                ),
            );
        }

        for ry in 0..rows {
            for rx in 0..cols {
                next += 1;
                let mut m = FpgMap::new(next, tw as i32, th as i32, src.depth);
                for y in 0..th {
                    let sy = ry * th + y;
                    if sy >= sh {
                        break;
                    }
                    for x in 0..tw {
                        let sx = rx * tw + x;
                        if sx >= sw {
                            continue;
                        }
                        let s = (sy * sw + sx) * bpp;
                        if s + bpp > src.pixels.len() {
                            continue;
                        }
                        let d = (y * tw + x) * bpp;
                        m.pixels[d..d + bpp].copy_from_slice(&src.pixels[s..s + bpp]);
                    }
                }
                m.set_name(&format!("{} {}_{}", src.name(), rx, ry));
                if first.is_none() {
                    first = Some(next);
                }
                fpg.maps.push(m);
            }
        }
        match first {
            Some(f) => f,
            None => return Resp::err(400, "no hay nada que trocear"),
        }
    };

    store.doc_response_extra(id, &format!("\"new_id\":{first}"))
}

/// Mural: todos los mapas del FPG colocados en filas, sin solaparse.
struct Mural {
    width: usize,
    height: usize,
    pixels: Vec<u8>,
}

/// Reparte los mapas en filas, con salto cuando la fila pasa de 1024 píxeles
/// (o del mapa más ancho, si alguno es mayor). El reparto es determinista:
/// así la previsualización y el mapa que se cree salen iguales.
fn mural_layout(fpg: &Fpg) -> Option<(usize, usize, Vec<(usize, usize)>)> {
    if fpg.maps.is_empty() {
        return None;
    }
    let widest = fpg
        .maps
        .iter()
        .map(|m| m.width.max(0) as usize)
        .max()
        .unwrap_or(0);
    let max_w = widest.max(1024);

    let mut pos = Vec::with_capacity(fpg.maps.len());
    let (mut x, mut y, mut row_h, mut total_w) = (0usize, 0usize, 0usize, 0usize);
    for m in &fpg.maps {
        let w = m.width.max(0) as usize;
        let h = m.height.max(0) as usize;
        if x > 0 && x + w > max_w {
            total_w = total_w.max(x);
            x = 0;
            y += row_h;
            row_h = 0;
        }
        pos.push((x, y));
        x += w;
        row_h = row_h.max(h);
    }
    total_w = total_w.max(x);
    Some((total_w.max(1), (y + row_h).max(1), pos))
}

/// Compone el mural tomando el primer fotograma de cada mapa.
fn compose_mural(fpg: &Fpg) -> Option<Mural> {
    let (mw, mh, pos) = mural_layout(fpg)?;
    let bpp = bpp_of(fpg.depth);
    let mut pixels = vec![0u8; mw * mh * bpp];
    for (m, &(ox, oy)) in fpg.maps.iter().zip(pos.iter()) {
        let w = m.width.max(0) as usize;
        let h = m.height.max(0) as usize;
        for y in 0..h {
            let s = y * w * bpp;
            if s + w * bpp > m.pixels.len() {
                break;
            }
            let d = ((oy + y) * mw + ox) * bpp;
            pixels[d..d + w * bpp].copy_from_slice(&m.pixels[s..s + w * bpp]);
        }
    }
    Some(Mural {
        width: mw,
        height: mh,
        pixels,
    })
}

/// Vista previa del mural (PNG) para enseñarlo antes de decidir.
fn mural(req: &Request, store: &Store) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let fpg = match store.get(id) {
        Some(Doc::Fpg { fpg, .. }) => fpg,
        Some(_) => return Resp::err(400, "el mural solo tiene sentido en un FPG"),
        None => return Resp::err(404, "documento no encontrado"),
    };
    let mu = match compose_mural(fpg) {
        Some(v) => v,
        None => return Resp::err(400, "el FPG no tiene mapas"),
    };

    let mut tmp = FpgMap::new(1, mu.width as i32, mu.height as i32, fpg.depth);
    tmp.pixels = mu.pixels;
    let rgba = render::fpgmap_to_rgba(fpg, &tmp, 0);
    match imageio::encode_png(&rgba) {
        Ok(b) => Resp::png(b),
        Err(e) => Resp::err(500, &e.to_string()),
    }
}

/// Crea un mapa nuevo con el mural entero («transferir un FPG a un mapa»).
fn mural_new(req: &Request, store: &mut Store) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let want_id = req.qnum::<u32>("id");
    let name = req.q("name").map(|s| s.to_string());

    let code = {
        let fpg = match store.get_mut(id) {
            Some(Doc::Fpg { fpg, .. }) => fpg,
            Some(_) => return Resp::err(400, "el mural solo tiene sentido en un FPG"),
            None => return Resp::err(404, "documento no encontrado"),
        };
        let mu = match compose_mural(fpg) {
            Some(v) => v,
            None => return Resp::err(400, "el FPG no tiene mapas"),
        };
        let code = match want_id {
            Some(c) => c,
            None => fpg
                .maps
                .iter()
                .map(|m| m.code)
                .max()
                .unwrap_or(0)
                .saturating_add(1),
        };
        if code == 0 {
            return Resp::err(400, "el id debe ser mayor que cero");
        }
        if fpg.maps.iter().any(|m| m.code == code) {
            return Resp::err(400, &format!("ya existe un mapa con el id {code}"));
        }
        let mut m = FpgMap::new(code, mu.width as i32, mu.height as i32, fpg.depth);
        m.pixels = mu.pixels;
        m.set_name(&name.unwrap_or_else(|| format!("Mural {code}")));
        fpg.maps.push(m);
        code
    };

    store.doc_response_extra(id, &format!("\"new_id\":{code}"))
}

/// Desplazamiento del contenido antiguo dentro del lienzo nuevo, según el ancla.
fn anchor_offset(anchor: &str, ow: usize, oh: usize, nw: usize, nh: usize) -> (i32, i32) {
    let a = anchor.to_ascii_lowercase();
    let dx = match a.chars().next_back() {
        Some('l') => 0,
        Some('r') => nw as i32 - ow as i32,
        _ => (nw as i32 - ow as i32) / 2,
    };
    let dy = match a.chars().next() {
        Some('t') => 0,
        Some('b') => nh as i32 - oh as i32,
        _ => (nh as i32 - oh as i32) / 2,
    };
    (dx, dy)
}

/// Rehace el búfer del mapa al tamaño pedido, conservando lo que quepa.
fn resize_pixels<T: PixAccess>(m: &mut T, nw: usize, nh: usize, anchor: &str) -> Result<(), Resp> {
    if nw == 0 || nh == 0 {
        return Err(Resp::err(400, "el tamaño mínimo es 1×1"));
    }
    if nw > 4096 || nh > 4096 {
        return Err(Resp::err(400, "el tamaño máximo es 4096×4096"));
    }
    let ow = m.width().max(0) as usize;
    let oh = m.height().max(0) as usize;
    let bpp = bpp_of(m.depth());
    let frames = m.frames().max(1);
    // Las dimensiones van acotadas, pero los fotogramas vienen del fichero: sin
    // este tope, un mapa de 1×1 con miles de fotogramas desbordaría al agrandarlo.
    let total = nw
        .checked_mul(nh)
        .and_then(|v| v.checked_mul(bpp))
        .and_then(|v| v.checked_mul(frames));
    if total.map_or(true, |v| v > MAX_MAP_BYTES) {
        return Err(Resp::err(400, "el mapa resultante sería demasiado grande"));
    }
    let (dx, dy) = anchor_offset(anchor, ow, oh, nw, nh);

    let old = std::mem::take(m.pixels_mut());
    let mut out = vec![0u8; nw * nh * bpp * frames];
    for f in 0..frames {
        let sb = f * ow * oh * bpp;
        let db = f * nw * nh * bpp;
        for y in 0..oh {
            let ty = y as i32 + dy;
            if ty < 0 || ty >= nh as i32 {
                continue;
            }
            for x in 0..ow {
                let tx = x as i32 + dx;
                if tx < 0 || tx >= nw as i32 {
                    continue;
                }
                let s = sb + (y * ow + x) * bpp;
                if s + bpp > old.len() {
                    continue;
                }
                let d = db + (ty as usize * nw + tx as usize) * bpp;
                out[d..d + bpp].copy_from_slice(&old[s..s + bpp]);
            }
        }
    }
    *m.pixels_mut() = out;
    m.set_size(nw as i32, nh as i32);
    Ok(())
}

fn points(req: &Request, store: &mut Store) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let want = req.qnum::<u32>("id");
    let pts = req.q("pts").map(|s| s.to_string());
    let count = req.qnum::<usize>("count");
    let index = req.qnum::<usize>("index");
    let px = req.qnum::<i16>("x");
    let py = req.qnum::<i16>("y");

    if pts.is_none() && count.is_none() && index.is_none() {
        return Resp::err(400, "falta pts, count o index para editar los puntos");
    }

    let res = match store.get_mut(id) {
        Some(Doc::Fpg { fpg, .. }) => {
            let code = match want {
                Some(v) => v,
                None => return Resp::err(400, "falta el parámetro id"),
            };
            match fpg.maps.iter_mut().find(|m| m.code == code) {
                Some(m) => update_points(m, pts.as_deref(), count, index, px, py),
                None => return Resp::err(404, &format!("no existe el mapa {code}")),
            }
        }
        Some(Doc::Map { map, .. }) => update_points(map, pts.as_deref(), count, index, px, py),
        Some(_) => return Resp::err(400, "este fichero no tiene puntos de control"),
        None => return Resp::err(404, "documento no encontrado"),
    };
    if let Err(r) = res {
        return r;
    }

    store.doc_response(id)
}

fn move_map(req: &Request, store: &mut Store) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let code = match req.qnum::<u32>("id") {
        Some(c) => c,
        None => return Resp::err(400, "falta el parámetro id"),
    };
    let dir = match req.q("dir") {
        Some(v) => v.to_string(),
        None => return Resp::err(400, "falta el parámetro dir"),
    };

    {
        let fpg = match store.get_mut(id) {
            Some(Doc::Fpg { fpg, .. }) => fpg,
            Some(_) => return Resp::err(400, "solo se pueden reordenar mapas en un FPG"),
            None => return Resp::err(404, "documento no encontrado"),
        };
        let pos = match fpg.maps.iter().position(|m| m.code == code) {
            Some(i) => i,
            None => return Resp::err(404, &format!("no existe el mapa {code}")),
        };
        match dir.as_str() {
            "up" => {
                if pos > 0 {
                    fpg.maps.swap(pos, pos - 1);
                }
            }
            "down" => {
                if pos + 1 < fpg.maps.len() {
                    fpg.maps.swap(pos, pos + 1);
                }
            }
            _ => return Resp::err(400, "dir debe ser up o down"),
        }
    }

    store.doc_response(id)
}

/// Modifica los puntos de control de un mapa.
///
/// Modos, por orden de precedencia:
///   * `pts`   — sustituye la lista completa («x,y;x,y;…», `-1,-1` = indefinido);
///   * `count` — redimensiona la lista;
///   * `index` + `x` + `y` — fija un punto concreto.
///
/// El modo `pts` existe para que el cliente pueda restaurar el vector entero al
/// deshacer: redimensionar a secas perdería los puntos recortados.
fn update_points<T>(
    m: &mut T,
    pts: Option<&str>,
    count: Option<usize>,
    index: Option<usize>,
    px: Option<i16>,
    py: Option<i16>,
) -> Result<(), Resp>
where
    T: PointAccess,
{
    if let Some(spec) = pts {
        *m.points_mut() = parse_points(spec)?;
        return Ok(());
    }

    if let Some(n) = count {
        if n > MAX_POINTS {
            return Err(Resp::err(400, "el número máximo de puntos es 4095"));
        }
        m.points_mut().resize(n, ControlPoint { x: -1, y: -1 });
    }

    if let Some(i) = index {
        if i > 0x0FFE {
            return Err(Resp::err(400, "índice de punto fuera de rango"));
        }
        let x = match px {
            Some(v) => v,
            None => return Err(Resp::err(400, "falta el parámetro x")),
        };
        let y = match py {
            Some(v) => v,
            None => return Err(Resp::err(400, "falta el parámetro y")),
        };
        if m.points_mut().len() <= i {
            m.points_mut().resize(i + 1, ControlPoint { x: -1, y: -1 });
        }
        m.points_mut()[i] = ControlPoint { x, y };
    }

    Ok(())
}

/// Lee una lista de puntos «x,y;x,y;…». Las entradas vacías se ignoran.
fn parse_points(spec: &str) -> Result<Vec<ControlPoint>, Resp> {
    let mut out = Vec::new();
    for item in spec.split(';') {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        if out.len() >= MAX_POINTS {
            return Err(Resp::err(400, "el número máximo de puntos es 4095"));
        }
        let (xs, ys) = item
            .split_once(',')
            .ok_or_else(|| Resp::err(400, &format!("punto mal formado: {item}")))?;
        let x: i16 = xs
            .trim()
            .parse()
            .map_err(|_| Resp::err(400, &format!("coordenada x no válida: {xs}")))?;
        let y: i16 = ys
            .trim()
            .parse()
            .map_err(|_| Resp::err(400, &format!("coordenada y no válida: {ys}")))?;
        out.push(ControlPoint { x, y });
    }
    Ok(out)
}

trait PointAccess {
    fn points_mut(&mut self) -> &mut Vec<ControlPoint>;
}

impl PointAccess for FpgMap {
    fn points_mut(&mut self) -> &mut Vec<ControlPoint> {
        &mut self.points
    }
}

impl PointAccess for Map {
    fn points_mut(&mut self) -> &mut Vec<ControlPoint> {
        &mut self.points
    }
}

/// Serializa un mapa a PNG, BMP, PCX o JPEG.
fn export_bytes(doc: &Doc, want: Option<u32>, frame: usize, fmt: &str) -> Result<Vec<u8>, Resp> {
    let indexed = match doc {
        Doc::Fpg { fpg, .. } => {
            let m = match want {
                Some(c) => fpg.maps.iter().find(|m| m.code == c),
                None => fpg.maps.first(),
            };
            match m {
                Some(m) => render::fpgmap_to_indexed(fpg, m, frame).ok(),
                None => return Err(Resp::err(404, "ese id de mapa no existe")),
            }
        }
        Doc::Map { map, .. } => render::map_to_indexed(map, frame).ok(),
        _ => return Err(Resp::err(400, "este fichero no contiene mapas")),
    };

    let rgba = || match doc {
        Doc::Fpg { fpg, .. } => {
            let m = fpg
                .maps
                .iter()
                .find(|m| Some(m.code) == want)
                .or_else(|| fpg.maps.first());
            m.map(|m| render::fpgmap_to_rgba(fpg, m, frame))
        }
        Doc::Map { map, .. } => Some(render::map_to_rgba(map, frame)),
        _ => None,
    };

    let res = match fmt {
        "png" => indexed.map(|i| imageio::encode_indexed_png(&i)),
        "bmp" => indexed.map(|i| Ok(imageio::encode_bmp(&i))),
        "pcx" => indexed.map(|i| Ok(imageio::encode_pcx(&i))),
        "jpeg" | "jpg" => rgba().map(|r| imageio::encode_jpeg(&r, 90)),
        other => return Err(Resp::err(400, &format!("formato de salida desconocido: {other}"))),
    };

    match res {
        Some(Ok(b)) => Ok(b),
        Some(Err(e)) => Err(Resp::err(500, &e.to_string())),
        None => Err(Resp::err(400, "no hay imagen que exportar")),
    }
}

fn export(req: &Request, store: &Store, fs: &mut dyn Fs) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let out = match req.q("path") {
        Some(p) => p.to_string(),
        None => return Resp::err(400, "falta el parámetro path (destino)"),
    };
    let fmt = req.q("format").unwrap_or("png").to_ascii_lowercase();
    let want = req.qnum::<u32>("id");
    let frame = req.qnum::<usize>("frame").unwrap_or(0);

    let doc = match store.get(id) {
        Some(d) => d,
        None => return Resp::err(404, "documento no encontrado"),
    };
    let bytes = match export_bytes(doc, want, frame, &fmt) {
        Ok(b) => b,
        Err(r) => return r,
    };
    if let Err(e) = fs.write(&out, &bytes) {
        return Resp::err(400, &format!("no se puede escribir {out}: {e}"));
    }
    Resp::json(200, format!("{{\"ok\":true,\"path\":{}}}", jstr(&out)))
}

fn close(req: &Request, store: &mut Store) -> Resp {
    let id = match needs_doc(req) {
        Ok(v) => v,
        Err(r) => return r,
    };
    store.remove(id);
    Resp::ok()
}
