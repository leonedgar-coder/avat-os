// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Servidor HTTP local para la fuente de navegador del avatar.
// - Escucha solo en 127.0.0.1 (no es accesible desde la red) y rechaza
//   peticiones cuyo Host no sea 127.0.0.1:<puerto>.
// - Sirve los archivos de la página compilada (`avatar/dist`) y el modelo
//   elegido por el usuario en `/model.vrm`. Cualquier otra ruta devuelve 404.
// - `/background`: la imagen o el video de fondo elegido (PNG, JPG, WebP, GIF, MP4 o WebM).
//   Acepta pedidos por partes (cabecera `Range`): el reproductor de video los usa para
//   repetir el video en bucle y para saltar dentro de él sin volver a leerlo entero.
// - `/status?state=…&detail=…`: la página informa si el avatar está cargando,
//   listo o falló; se reenvía a la interfaz (callback `on_status`).

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::thread;

use anyhow::Context;
use tiny_http::{Header, Method, Response, Server};

/// Recibe el estado que informa la página del avatar: (`loading` | `loaded` | `error`, detalle).
pub type StatusCallback = Box<dyn Fn(&str, &str) + Send + 'static>;

pub struct AvatarServer {
    port: u16,
    /// Puerto del canal de tracking (WebSocket), que la página recibe en la URL.
    tracking_port: u16,
    model: Arc<RwLock<Option<PathBuf>>>,
    /// Imagen de fondo elegida por el usuario (se sirve en `/background`).
    background: Arc<RwLock<Option<PathBuf>>>,
}

/// Formatos de fondo aceptados (imágenes y videos) y su tipo MIME.
pub fn background_mime(path: &Path) -> Option<&'static [u8]> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some(b"image/png"),
        "jpg" | "jpeg" => Some(b"image/jpeg"),
        "webp" => Some(b"image/webp"),
        "gif" => Some(b"image/gif"),
        "mp4" => Some(b"video/mp4"),
        "webm" => Some(b"video/webm"),
        _ => None,
    }
}

/// ¿El fondo es un video?
pub fn is_video(path: &Path) -> bool {
    background_mime(path).is_some_and(|m| m.starts_with(b"video/"))
}

/// Cabecera `Range: bytes=…` → (desde, hasta) inclusive, dentro de `total` bytes.
/// `None` si no hay un único rango válido (se responde el archivo entero);
/// `Some(Err(()))` si el rango empieza después del final (416).
fn parse_range(header: &str, total: u64) -> Option<Result<(u64, u64), ()>> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None; // varios rangos: no se usan para video
    }
    let (start, end) = spec.split_once('-')?;
    let (start, end) = match (start.trim(), end.trim()) {
        ("", "") => return None,
        ("", suffix) => {
            let n: u64 = suffix.parse().ok()?;
            (total.saturating_sub(n), total.checked_sub(1)?)
        }
        (a, "") => (a.parse().ok()?, total.checked_sub(1)?),
        (a, b) => (a.parse().ok()?, b.parse::<u64>().ok()?.min(total.checked_sub(1)?)),
    };
    if start >= total {
        return Some(Err(()));
    }
    (start <= end).then_some(Ok((start, end)))
}

impl AvatarServer {
    /// Arranca el servidor en un puerto libre, sirviendo los archivos de `site_dir`.
    pub fn start(site_dir: PathBuf, tracking_port: u16, on_status: StatusCallback) -> anyhow::Result<Self> {
        let site_dir = site_dir
            .canonicalize()
            .with_context(|| format!("No existe la página del avatar en {}", site_dir.display()))?;
        let server = Server::http("127.0.0.1:0").map_err(|e| anyhow::anyhow!(e))?;
        let port = server
            .server_addr()
            .to_ip()
            .context("El servidor no tiene dirección IP")?
            .port();
        let model: Arc<RwLock<Option<PathBuf>>> = Arc::default();
        let background: Arc<RwLock<Option<PathBuf>>> = Arc::default();

        let model_for_thread = model.clone();
        let background_for_thread = background.clone();
        let expected_host = format!("127.0.0.1:{port}");
        thread::Builder::new().name("avatar-server".into()).spawn(move || {
            for request in server.incoming_requests() {
                // Solo peticiones dirigidas exactamente a 127.0.0.1:<puerto>. Bloquea el
                // "DNS rebinding": una web maliciosa que apunta su dominio a 127.0.0.1
                // envía su propio dominio en la cabecera Host.
                let host_ok = request
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Host"))
                    .is_some_and(|h| h.value.as_str() == expected_host);
                let is_get = host_ok && *request.method() == Method::Get;
                if is_get && request.url().starts_with("/status?") {
                    if let Some((state, detail)) = parse_status(request.url()) {
                        on_status(&state, &detail);
                    }
                    let _ = request.respond(Response::empty(204));
                    continue;
                }
                if is_get && request.url().split(['?', '#']).next() == Some("/background") {
                    let path = background_for_thread.read().ok().and_then(|bg| bg.clone());
                    serve_background(request, path);
                    continue;
                }
                let response = if !is_get {
                    None
                } else {
                    respond(&site_dir, &model_for_thread, request.url())
                };
                let result = match response {
                    Some((file, mime)) => request.respond(
                        Response::from_file(file).with_header(
                            Header::from_bytes("Content-Type", mime).expect("cabecera válida"),
                        ),
                    ),
                    None => request.respond(Response::empty(404)),
                };
                if let Err(e) = result {
                    log::debug!("Respuesta del servidor del avatar interrumpida: {e}");
                }
            }
        })?;

        log::info!("Servidor del avatar en http://127.0.0.1:{port}/");
        Ok(Self { port, tracking_port, model, background })
    }

    pub fn url(&self, version: u64) -> String {
        format!(
            "http://127.0.0.1:{}/?v={version}&ws={}&id={}",
            self.port,
            self.tracking_port,
            crate::expressions::MAIN_AVATAR
        )
    }

    pub fn set_model(&self, path: PathBuf) {
        *self.model.write().unwrap() = Some(path);
    }

    /// Imagen de fondo que se sirve en `/background` (`None` = ninguna).
    pub fn set_background(&self, path: Option<PathBuf>) {
        *self.background.write().unwrap() = path;
    }

    /// Ruta del avatar cargado (o `None`).
    pub fn model_path(&self) -> Option<PathBuf> {
        self.model.read().ok()?.clone()
    }

    /// Nombre del archivo del avatar cargado, para mostrarlo en la interfaz.
    pub fn model_name(&self) -> Option<String> {
        let model = self.model.read().ok()?;
        Some(model.as_ref()?.file_name()?.to_string_lossy().into_owned())
    }
}

/// Responde `/background`: el archivo elegido (si es de un formato aceptado), entero o por partes.
fn serve_background(request: tiny_http::Request, path: Option<PathBuf>) {
    use std::io::{Read, Seek, SeekFrom};
    let found = path.and_then(|p| Some((background_mime(&p)?, File::open(&p).ok()?)));
    let Some((mime, mut file)) = found else {
        let _ = request.respond(Response::empty(404));
        return;
    };
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let header = |k: &str, v: &[u8]| Header::from_bytes(k, v).expect("cabecera válida");
    let range = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .and_then(|h| parse_range(h.value.as_str(), total));
    let result = match range {
        Some(Err(())) => request.respond(
            Response::empty(416).with_header(header("Content-Range", format!("bytes */{total}").as_bytes())),
        ),
        Some(Ok((start, end))) if file.seek(SeekFrom::Start(start)).is_ok() => {
            let len = end - start + 1;
            let body: Box<dyn Read + Send> = Box::new(file.take(len));
            request.respond(Response::new(
                tiny_http::StatusCode(206),
                vec![
                    header("Content-Type", mime),
                    header("Accept-Ranges", b"bytes"),
                    header("Content-Range", format!("bytes {start}-{end}/{total}").as_bytes()),
                ],
                body,
                Some(len as usize),
                None,
            ))
        }
        _ => request.respond(
            Response::from_file(file)
                .with_header(header("Content-Type", mime))
                .with_header(header("Accept-Ranges", b"bytes")),
        ),
    };
    if let Err(e) = result {
        log::debug!("Respuesta del fondo interrumpida: {e}");
    }
}

/// `/status?state=loaded&detail=…` → (estado, detalle). Solo estados conocidos; detalle ≤ 300 caracteres.
fn parse_status(url: &str) -> Option<(String, String)> {
    let query = url.split_once('?')?.1;
    let mut state = None;
    let mut detail = String::new();
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        match key {
            "state" => state = Some(percent_decode(value)),
            "detail" => detail = percent_decode(value).chars().take(300).collect(),
            _ => {}
        }
    }
    // Estados del avatar y del fondo de video (`bg_playing`: se reproduce; `bg_error`: no).
    let state = state.filter(|s| matches!(s.as_str(), "loading" | "loaded" | "error" | "bg_playing" | "bg_error"))?;
    Some((state, detail))
}

/// Decodifica `%XX` y `+` de una URL. Lo que no sea UTF-8 válido se reemplaza.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok());
        match (bytes[i], hex.and_then(|h| u8::from_str_radix(h, 16).ok())) {
            (b'%', Some(b)) => {
                out.push(b);
                i += 3;
            }
            (b'+', _) => {
                out.push(b' ');
                i += 1;
            }
            (b, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodifica_estado() {
        assert_eq!(
            parse_status("/status?state=error&detail=No%20es%20un%20VRM+v%C3%A1lido"),
            Some(("error".into(), "No es un VRM válido".into()))
        );
        assert_eq!(parse_status("/status?state=loaded"), Some(("loaded".into(), String::new())));
        assert_eq!(parse_status("/status?state=hackeado"), None);
        assert_eq!(parse_status("/status?state=bg_error&detail=4"), Some(("bg_error".into(), "4".into())));
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn rangos_de_bytes() {
        assert_eq!(parse_range("bytes=0-", 1000), Some(Ok((0, 999))));
        assert_eq!(parse_range("bytes=100-199", 1000), Some(Ok((100, 199))));
        assert_eq!(parse_range("bytes=900-5000", 1000), Some(Ok((900, 999)))); // se recorta al final
        assert_eq!(parse_range("bytes=-100", 1000), Some(Ok((900, 999)))); // los últimos 100
        assert_eq!(parse_range("bytes=1000-", 1000), Some(Err(()))); // empieza después del final
        assert_eq!(parse_range("bytes=5-2", 1000), None);
        assert_eq!(parse_range("bytes=0-1,5-9", 1000), None); // varios rangos: archivo entero
        assert_eq!(parse_range("items=0-1", 1000), None);
        assert_eq!(parse_range("bytes=0-", 0), None); // archivo vacío
    }

    #[test]
    fn formatos_de_fondo() {
        assert!(is_video(Path::new("a.MP4")) && is_video(Path::new("b.webm")));
        assert!(!is_video(Path::new("c.png")) && background_mime(Path::new("c.png")).is_some());
        assert!(background_mime(Path::new("d.mov")).is_none());
    }
}

fn respond(
    site_dir: &Path,
    model: &RwLock<Option<PathBuf>>,
    url: &str,
) -> Option<(File, &'static [u8])> {
    let path = url.split(['?', '#']).next().unwrap_or("/");

    if path == "/model.vrm" {
        let model = model.read().ok()?.clone()?;
        return File::open(model).ok().map(|f| (f, b"model/gltf-binary".as_slice()));
    }

    let relative = path.trim_start_matches('/');
    let relative = if relative.is_empty() { "index.html" } else { relative };
    // Evita salir de la carpeta de la página (por ejemplo con "../").
    let file = site_dir.join(relative).canonicalize().ok()?;
    if !file.starts_with(site_dir) || !file.is_file() {
        return None;
    }
    let mime: &[u8] = match file.extension().and_then(|e| e.to_str()) {
        Some("html") => b"text/html; charset=utf-8",
        Some("js") => b"text/javascript; charset=utf-8",
        Some("css") => b"text/css; charset=utf-8",
        Some("png") => b"image/png",
        Some("svg") => b"image/svg+xml",
        _ => b"application/octet-stream",
    };
    File::open(file).ok().map(|f| (f, mime))
}
