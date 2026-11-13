// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Canal en vivo hacia la página del avatar (dentro de la fuente de navegador
// de OBS) por WebSocket. Lleva mensajes JSON con `type` y `avatar` (destino):
//   - `tracking`: cada cuadro del seguimiento facial (lo calcula la interfaz)
//   - `expression`: la emoción activa (atajos de teclado o botones)
// Seguridad: escucha solo en 127.0.0.1 y rechaza conexiones cuyo Host no sea
// 127.0.0.1:<puerto> (protección contra "DNS rebinding").

use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::StatusCode;
use tungstenite::{Message, WebSocket};

use crate::expressions::MAIN_AVATAR;

type Clients = Arc<Mutex<Vec<WebSocket<TcpStream>>>>;
/// Último mensaje de cada clave "pegajosa" (p. ej. la expresión activa): se reenvía
/// a cada página que se conecta, para que no pierda el estado al recargarse.
type Sticky = Arc<Mutex<HashMap<String, String>>>;

pub struct TrackingRelay {
    port: u16,
    clients: Clients,
    sticky: Sticky,
}

impl TrackingRelay {
    pub fn start() -> anyhow::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let clients: Clients = Arc::default();
        let sticky: Sticky = Arc::default();

        let clients_for_thread = clients.clone();
        let sticky_for_thread = sticky.clone();
        let expected_host = format!("127.0.0.1:{port}");
        thread::Builder::new().name("tracking-relay".into()).spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = stream.set_nodelay(true);
                // Tiempos límite: un cliente lento no puede trabar el saludo inicial
                // ni el envío de cuadros (si no lee, se le desconecta).
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let _ = stream.set_write_timeout(Some(Duration::from_millis(100)));
                let check_host = |req: &Request, resp: Response| {
                    let host = req.headers().get("host").and_then(|h| h.to_str().ok());
                    if host == Some(expected_host.as_str()) {
                        Ok(resp)
                    } else {
                        let mut err = ErrorResponse::new(Some("Host no permitido".into()));
                        *err.status_mut() = StatusCode::FORBIDDEN;
                        Err(err)
                    }
                };
                match tungstenite::accept_hdr(stream, check_host) {
                    Ok(mut ws) => {
                        log::info!("Página del avatar conectada al canal de tracking");
                        // Mismo orden de bloqueo que `set_sticky` (clientes → pegajosos).
                        let mut clients = clients_for_thread.lock().unwrap();
                        let sent = sticky_for_thread
                            .lock()
                            .unwrap()
                            .values()
                            .all(|msg| ws.send(Message::text(msg.as_str())).is_ok());
                        if sent {
                            clients.push(ws);
                        }
                    }
                    Err(e) => log::debug!("Conexión de tracking rechazada: {e}"),
                }
            }
        })?;

        log::info!("Canal de tracking en ws://127.0.0.1:{port}/");
        Ok(Self { port, clients, sticky })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Envía un mensaje (JSON) a todas las páginas conectadas; descarta las cerradas.
    pub fn broadcast(&self, json: &str) {
        let mut clients = self.clients.lock().unwrap();
        clients.retain_mut(|ws| ws.send(Message::text(json)).is_ok());
    }

    /// Como `broadcast`, pero además lo guarda para las páginas que se conecten después.
    pub fn set_sticky(&self, key: &str, json: &str) {
        let mut clients = self.clients.lock().unwrap();
        self.sticky.lock().unwrap().insert(key.to_owned(), json.to_owned());
        clients.retain_mut(|ws| ws.send(Message::text(json)).is_ok());
    }
}

/// Estado de Tauri con el canal de tracking.
pub struct TrackingState(pub TrackingRelay);

/// Deja un valor en 0–1 (lo que no es un número, en 0).
fn unit(v: f32) -> f32 {
    if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 }
}

/// La interfaz envía aquí el nivel de voz del lip-sync (~30 por segundo).
/// `level` se limita a 0–1; `mode`: `combine` (lo mayor entre cámara y voz) o `voice`;
/// `vowels`: peso de A, I, U, E, O (5 valores 0–1) o `null` si el reconocimiento está apagado.
#[tauri::command]
pub fn lipsync_update(state: tauri::State<'_, TrackingState>, level: f32, mode: &str, vowels: Option<Vec<f32>>) {
    let mode = if mode == "voice" { "voice" } else { "combine" };
    let vowels: Option<Vec<f32>> = vowels.filter(|v| v.len() == 5).map(|v| v.into_iter().map(unit).collect());
    let msg = serde_json::json!({
        "type": "lipsync", "avatar": MAIN_AVATAR, "level": unit(level), "mode": mode, "vowels": vowels,
    });
    state.0.broadcast(&msg.to_string());
}

/// La interfaz envía aquí cada cuadro del seguimiento facial.
#[tauri::command]
pub fn tracking_update(state: tauri::State<'_, TrackingState>, frame: serde_json::Value) {
    let msg = serde_json::json!({ "type": "tracking", "avatar": MAIN_AVATAR, "frame": frame });
    state.0.broadcast(&msg.to_string());
}
