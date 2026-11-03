//! Servidor HTTP mínimo (solo biblioteca estándar) para la interfaz local.
//!
//! Atiende peticiones HTTP/1.1 una a una por conexión, cierra el socket tras
//! responder y no usa `chunked`: las respuestas siempre llevan
//! `Content-Length`, y las peticiones del navegador llegan con `Content-Length`
//! al enviar binario con `fetch`.
//!
//! La petición y la respuesta son las mismas que usa el núcleo ([`div2core`]),
//! para que el enrutado sea idéntico al de la versión web.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;

pub use div2core::percent_decode;
pub use div2core::{Request, Resp};

/// Tope del cuerpo admitido. Sin él, un `Content-Length` desmedido haría que
/// el servidor intentase reservar esa memoria de golpe.
const MAX_BODY: usize = 512 * 1024 * 1024;

/// ¿Es un `Host` al que tiene sentido responder?
///
/// El servidor escucha solo en `127.0.0.1`, así que un `Host` de otro dominio
/// delata un *DNS rebinding*: una página ajena que resuelve su propio nombre a
/// la dirección local para hablar con la API como si fuera de su origen.
fn host_allowed(host: &str) -> bool {
    let h = host.trim();
    if h.is_empty() {
        // Sin cabecera `Host` (cliente antiguo): un navegador siempre la manda,
        // así que por aquí no llega un rebinding.
        return true;
    }
    let name = match h.rsplit_once(':') {
        Some((n, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => n,
        _ => h,
    };
    let name = name.trim_start_matches('[').trim_end_matches(']');
    matches!(name, "127.0.0.1" | "localhost" | "::1")
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

    if let Some(host) = headers.get("host") {
        if !host_allowed(host) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!("host no permitido: {host}"),
            ));
        }
    }

    let len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if len > MAX_BODY {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("cuerpo de {len} bytes: supera el máximo de {MAX_BODY}"),
        ));
    }
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
