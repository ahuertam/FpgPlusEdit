use std::fmt;

/// Error único del núcleo de formatos.
#[derive(Debug)]
pub enum Error {
    /// Error de entrada/salida (lectura/escritura de ficheros).
    Io(std::io::Error),
    /// El magic de cabecera no es el esperado.
    InvalidMagic(String),
    /// El fichero termina antes de lo que la estructura requiere.
    UnexpectedEof { expected: usize, got: usize },
    /// Los datos existen pero no son coherentes con el formato.
    InvalidData(String),
    /// Formato no soportado por esta implementación.
    Unsupported(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Io(e) => write!(f, "error de E/S: {e}"),
            Error::InvalidMagic(m) => write!(f, "magic de cabecera inválido: {m}"),
            Error::UnexpectedEof { expected, got } => write!(
                f,
                "fichero truncado: se esperaban al menos {expected} bytes pero solo hay {got}"
            ),
            Error::InvalidData(m) => write!(f, "datos inválidos: {m}"),
            Error::Unsupported(m) => write!(f, "formato no soportado: {m}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}
