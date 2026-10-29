//! Servidor HTTP mínimo (solo biblioteca estándar) para la interfaz local.
//!
//! Atiende peticiones HTTP/1.1 una a una por conexión, cierra el socket tras
//! responder y no usa `chunked`: las respuestas siempre llevan
//! `Content-Length`, y las peticiones del navegador llegan con `Content-Length`
//! al enviar binario con `fetch`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;

/// Petición ya leída y descompuesta.
pub struct Request {
    pub method: String,
    pub path: String,
    pub query: HashMap<String, String>,
    pub body: Vec<u8>,
}

/// Respuesta lista para enviar.
pub struct Resp {
    pub status: u16,
    pub ctype: String,
    pub body: Vec<u8>,
}

impl Resp {
    pub fn json(status: u16, body: String) -> Resp {
        Resp {
            status,
            ctype: "application/json; charset=utf-8".to_string(),
            body: body.into_bytes(),
        }
    }

    pub fn png(body: Vec<u8>) -> Resp {
        Resp {
            status: 200,
            ctype: "image/png".to_string(),
            body,
        }
    }

    pub fn ok() -> Resp {
        Resp::json(200, "{\"ok\":true}".to_string())
    }

    pub fn err(status: u16, msg: &str) -> Resp {
        Resp::json(
            status,
            format!("{{\"ok\":false,\"error\":{}}}", jstr(msg)),
        )
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        _ => "OK",
    }
}

/// Lee una petición completa; `None` si el cliente cerró sin enviar nada.
pub fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<Request>> {
    let mut reader = BufReader::new(stream.try_clone()?);

    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    let mut parts = line.trim_end().split(' ');
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    if method.is_empty() || target.is_empty() {
        return Ok(None);
    }

    let mut headers: HashMap<String, String> = HashMap::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 {
            break;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; len];
    if len > 0 {
        reader.read_exact(&mut body)?;
    }

    let (path, query) = parse_target(&target);
    Ok(Some(Request {
        method,
        path,
        query,
        body,
    }))
}

/// Envía la respuesta y cierra la conexión.
pub fn send(stream: &mut TcpStream, r: &Resp) {
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        r.status,
        reason(r.status),
        r.ctype,
        r.body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(&r.body);
    let _ = stream.flush();
}

/// Separa el objetivo en ruta y parámetros de consulta ya decodificados.
fn parse_target(target: &str) -> (String, HashMap<String, String>) {
    let (raw_path, raw_query) = match target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (target, ""),
    };
    let mut query = HashMap::new();
    for pair in raw_query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        query.insert(percent_decode(k), percent_decode(v));
    }
    (percent_decode(raw_path), query)
}

/// Decodifica `%XX` y `+` de una cadena de URL.
pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(h), Some(l)) => {
                        out.push((h * 16 + l) as u8);
                        i += 3;
                    }
                    _ => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Escapa una cadena para incrustarla en JSON entre comillas.
pub fn jstr(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// Tipo MIME por extensión (los que sirve la interfaz).
pub fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}
