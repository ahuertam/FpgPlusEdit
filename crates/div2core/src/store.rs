//! Documentos abiertos en memoria y su representación JSON.

use crate::{jstr, Resp};
use div2fmt::{Animation, ControlPoint, Fnt, Fpg, FpgMap, Map, Palette};
use std::collections::HashMap;

/// Documento abierto. Guarda la ruta (o el nombre lógico, en la versión web)
/// para poder mostrarla y para saber dónde se guardó la última vez.
pub enum Doc {
    Fpg {
        fpg: Fpg,
        path: String,
        size: u64,
        gzip: bool,
    },
    Map {
        map: Map,
        path: String,
        size: u64,
        gzip: bool,
    },
    Pal {
        pal: Palette,
        path: String,
        size: u64,
        gzip: bool,
    },
    Fnt {
        fnt: Fnt,
        path: String,
        size: u64,
        gzip: bool,
    },
}

impl Doc {
    /// Tipo de documento, tal y como lo espera la interfaz (`fpg`, `map`…).
    pub fn kind(&self) -> &'static str {
        match self {
            Doc::Fpg { .. } => "fpg",
            Doc::Map { .. } => "map",
            Doc::Pal { .. } => "pal",
            Doc::Fnt { .. } => "fnt",
        }
    }

    pub fn path(&self) -> &str {
        match self {
            Doc::Fpg { path, .. }
            | Doc::Map { path, .. }
            | Doc::Pal { path, .. }
            | Doc::Fnt { path, .. } => path,
        }
    }

    pub fn set_path(&mut self, p: String) {
        match self {
            Doc::Fpg { path, .. }
            | Doc::Map { path, .. }
            | Doc::Pal { path, .. }
            | Doc::Fnt { path, .. } => *path = p,
        }
    }

    pub fn size(&self) -> u64 {
        match self {
            Doc::Fpg { size, .. }
            | Doc::Map { size, .. }
            | Doc::Pal { size, .. }
            | Doc::Fnt { size, .. } => *size,
        }
    }

    pub fn set_size(&mut self, v: u64) {
        match self {
            Doc::Fpg { size, .. }
            | Doc::Map { size, .. }
            | Doc::Pal { size, .. }
            | Doc::Fnt { size, .. } => *size = v,
        }
    }

    pub fn gzip(&self) -> bool {
        match self {
            Doc::Fpg { gzip, .. }
            | Doc::Map { gzip, .. }
            | Doc::Pal { gzip, .. }
            | Doc::Fnt { gzip, .. } => *gzip,
        }
    }

    pub fn set_gzip(&mut self, v: bool) {
        match self {
            Doc::Fpg { gzip, .. }
            | Doc::Map { gzip, .. }
            | Doc::Pal { gzip, .. }
            | Doc::Fnt { gzip, .. } => *gzip = v,
        }
    }
}

/// Almacén de documentos abiertos, con identificadores crecientes.
///
/// No lleva cerrojo: el frontal que lo use decide cómo protegerlo (el servidor
/// local lo envuelve en un `Mutex` porque atiende conexiones en paralelo).
#[derive(Default)]
pub struct Store {
    next: u64,
    docs: HashMap<u64, Doc>,
}

impl Store {
    pub fn new() -> Store {
        Store {
            next: 1,
            docs: HashMap::new(),
        }
    }

    pub fn insert(&mut self, doc: Doc) -> u64 {
        let id = self.next;
        self.next += 1;
        self.docs.insert(id, doc);
        id
    }

    pub fn get(&self, id: u64) -> Option<&Doc> {
        self.docs.get(&id)
    }

    pub fn get_mut(&mut self, id: u64) -> Option<&mut Doc> {
        self.docs.get_mut(&id)
    }

    pub fn remove(&mut self, id: u64) {
        self.docs.remove(&id);
    }

    /// Respuesta con el estado completo de un documento.
    pub fn doc_response(&self, id: u64) -> Resp {
        match self.get(id) {
            Some(doc) => Resp::json(200, doc_json(id, doc)),
            None => Resp::err(404, "documento no encontrado (¿se cerró la pestaña?)"),
        }
    }

    /// Igual que [`Store::doc_response`], pero añade campos extra justo después
    /// de «ok».
    ///
    /// Lo usan la importación (que devuelve el id del mapa recién añadido) y el
    /// arrastre (que marca el documento como copia temporal).
    pub fn doc_response_extra(&self, id: u64, extra: &str) -> Resp {
        match self.get(id) {
            Some(doc) => {
                let j = doc_json(id, doc);
                Resp::json(200, j.replacen("\"ok\":true,", &format!("\"ok\":true,{extra},"), 1))
            }
            None => Resp::err(404, "documento no encontrado (¿se cerró la pestaña?)"),
        }
    }
}

// ---------------------------------------------------------------------------
// representación JSON
// ---------------------------------------------------------------------------

pub fn palette_json(p: &Palette) -> String {
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

/// Estado completo de un documento, con la misma forma que espera la interfaz.
pub fn doc_json(id: u64, doc: &Doc) -> String {
    let path = doc.path().to_string();
    let name = crate::base_name(&path);
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
                doc.size(),
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
                doc.size(),
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
            doc.size(),
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
                doc.size(),
                gzip,
                fnt.flags,
                palette_json(&fnt.palette),
                glyphs.join(",")
            )
        }
    }
}
