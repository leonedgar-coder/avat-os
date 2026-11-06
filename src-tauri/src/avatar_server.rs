// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Servidor HTTP local para la fuente de navegador del avatar.
// - Escucha solo en 127.0.0.1 (no es accesible desde la red) y rechaza
//   peticiones cuyo Host no sea 127.0.0.1:<puerto>.
// - Sirve los archivos de la página compilada (`avatar/dist`) y el modelo
//   elegido por el usuario en `/model.vrm`. Cualquier otra ruta devuelve 404.
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

        let model_for_thread = model.clone();
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
                let response = if is_get {
                    respond(&site_dir, &model_for_thread, request.url())
                } else {
                    None
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
        Ok(Self { port, tracking_port, model })
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

    /// Nombre del archivo del avatar cargado, para mostrarlo en la interfaz.
    pub fn model_name(&self) -> Option<String> {
        let model = self.model.read().ok()?;
        Some(model.as_ref()?.file_name()?.to_string_lossy().into_owned())
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
    let state = state.filter(|s| matches!(s.as_str(), "loading" | "loaded" | "error"))?;
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
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
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
