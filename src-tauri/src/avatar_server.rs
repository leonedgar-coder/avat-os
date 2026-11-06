// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Servidor HTTP local para la fuente de navegador del avatar.
// - Escucha solo en 127.0.0.1 (no es accesible desde la red) y rechaza
//   peticiones cuyo Host no sea 127.0.0.1:<puerto>.
// - Sirve los archivos de la página compilada (`avatar/dist`) y el modelo
//   elegido por el usuario en `/model.vrm`. Cualquier otra ruta devuelve 404.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::thread;

use anyhow::Context;
use tiny_http::{Header, Method, Response, Server};

pub struct AvatarServer {
    port: u16,
    /// Puerto del canal de tracking (WebSocket), que la página recibe en la URL.
    tracking_port: u16,
    model: Arc<RwLock<Option<PathBuf>>>,
}

impl AvatarServer {
    /// Arranca el servidor en un puerto libre, sirviendo los archivos de `site_dir`.
    pub fn start(site_dir: PathBuf, tracking_port: u16) -> anyhow::Result<Self> {
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
                let response = if host_ok && *request.method() == Method::Get {
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
