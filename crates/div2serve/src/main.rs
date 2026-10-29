//! Editor local para los recursos gráficos de DIV Games Studio 2.
//!
//! Arranca un servidor HTTP en `127.0.0.1` que sirve la interfaz de `web/` y
//! expone una pequeña API para abrir, editar y guardar ficheros FPG, MAP, PAL
//! y FNT. Al arrancar abre el navegador en la página del editor.

mod api;
mod http;
mod static_files;

use http::{Resp, Request};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};

const DEFAULT_PORT: u16 = 4711;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut port = DEFAULT_PORT;
    let mut open_browser = true;
    let mut web_override: Option<PathBuf> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--port" | "-p" => {
                if let Some(v) = args.get(i + 1).and_then(|s| s.parse().ok()) {
                    port = v;
                    i += 1;
                }
            }
            "--web" => {
                if let Some(v) = args.get(i + 1) {
                    web_override = Some(PathBuf::from(v));
                    i += 1;
                }
            }
            "--no-open" => open_browser = false,
            "--help" | "-h" => {
                print_help();
                return;
            }
            other => eprintln!("aviso: opción ignorada «{other}»"),
        }
        i += 1;
    }

    let web = resolve_web(web_override);
    if !web.join("index.html").is_file() {
        eprintln!("error: no encuentro la interfaz en {}", web.display());
        eprintln!("       indica la carpeta con --web <ruta>");
        std::process::exit(1);
    }
    let home = web.parent().unwrap_or(&web).to_path_buf();

    let (listener, port) = match bind(port) {
        Some(v) => v,
        None => {
            eprintln!("error: no he podido abrir ningún puerto a partir de {DEFAULT_PORT}");
            std::process::exit(1);
        }
    };
    let url = format!("http://127.0.0.1:{port}/");

    println!("FPG+ Edit {} — editor de recursos de DIV Games Studio 2", env!("CARGO_PKG_VERSION"));
    println!("  interfaz: {}", web.display());
    println!("  carpeta : {}", home.display());
    println!("  dirección: {url}");
    println!("  (Ctrl+C para detener el servidor)\n");

    if open_browser {
        if let Err(e) = open_url(&url) {
            eprintln!("aviso: no he podido abrir el navegador automáticamente ({e})");
            eprintln!("       abre manualmente {url}");
        }
    }

    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                let web = web.clone();
                let home = home.clone();
                std::thread::spawn(move || handle(s, &web, &home));
            }
            Err(_) => continue,
        }
    }
}

fn print_help() {
    println!(
        "fpgplusedit — editor de FPG/MAP/PAL/FNT de DIV Games Studio 2\n\n\
         Uso: fpgplusedit [opciones]\n\n\
         Opciones:\n\
         \x20 -p, --port <n>   puerto local (por defecto {DEFAULT_PORT})\n\
         \x20     --web <dir>  carpeta con la interfaz (por defecto la que acompaña al ejecutable)\n\
         \x20     --no-open    no abrir el navegador al arrancar\n\
         \x20 -h, --help       muestra esta ayuda"
    );
}

/// Localiza la carpeta `web/`: junto al ejecutable o en el árbol del proyecto.
fn resolve_web(override_: Option<PathBuf>) -> PathBuf {
    if let Some(p) = override_ {
        return p;
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        let candidate = dir.join("web");
        if candidate.join("index.html").is_file() {
            return candidate;
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web");
    dev.canonicalize().unwrap_or(dev)
}

/// Enlaza en `port`; si está ocupado prueba los siguientes hasta diez.
fn bind(port: u16) -> Option<(TcpListener, u16)> {
    for p in port..port.saturating_add(10) {
        if let Ok(l) = TcpListener::bind(("127.0.0.1", p)) {
            return Some((l, p));
        }
    }
    None
}

fn handle(mut stream: TcpStream, web: &Path, home: &Path) {
    let req: Request = match http::read_request(&mut stream) {
        Ok(Some(r)) => r,
        _ => return,
    };

    let resp: Resp = if req.path.starts_with("/api/") {
        if req.method != "GET" && req.method != "POST" {
            Resp::err(405, "método no permitido")
        } else {
            api::route(&req, home)
        }
    } else if req.method == "GET" {
        static_files::serve(web, &req.path)
    } else {
        Resp::err(405, "método no permitido")
    };

    http::send(&mut stream, &resp);
}

/// Abre el navegador predeterminado en la URL indicada.
fn open_url(url: &str) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::process::Command;
        Command::new("cmd").args(["/C", "start", "", url]).spawn()?;
    }
    #[cfg(not(windows))]
    {
        use std::process::Command;
        let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        Command::new(opener).arg(url).spawn()?;
    }
    Ok(())
}
