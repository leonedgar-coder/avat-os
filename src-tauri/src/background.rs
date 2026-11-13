// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Fondo detrás del avatar: transparente, un color o una imagen o video (PNG, JPG, WebP o
// GIF, también animados; MP4 o WebM, en bucle y sin sonido). Se guarda en `<config>/fondo.json`, el servidor del
// avatar entrega la imagen en `/background` y la página recibe la configuración
// por el canal en vivo (mensaje pegajoso `background`).

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::avatar_server::{background_mime, is_video};
use crate::expressions::MAIN_AVATAR;
use crate::obs::ObsState;
use crate::tracking_relay::TrackingState;

const FILE_NAME: &str = "fondo.json";
/// Códigos de error para la interfaz (`errors.*`).
const ERR_INVALID: &str = "background_invalid";
const ERR_INVALID_FILE: &str = "background_invalid_file";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Transparent,
    Color,
    Image,
}

/// Cómo se ajusta la imagen: `cover` llena (puede recortar), `contain` se ve entera.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fit {
    Cover,
    Contain,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Background {
    pub kind: Kind,
    /// Color en formato `#rrggbb` (se recuerda aunque el modo no sea `color`).
    pub color: String,
    /// Imagen elegida (se recuerda aunque el modo no sea `image`).
    #[serde(default)]
    pub image: Option<PathBuf>,
    pub fit: Fit,
}

impl Default for Background {
    fn default() -> Self {
        // Verde de croma: el color más útil si se quiere recortar el avatar en otro programa.
        Self { kind: Kind::Transparent, color: "#00b140".into(), image: None, fit: Fit::Cover }
    }
}

fn is_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn valid_image(path: &PathBuf) -> bool {
    path.is_file() && background_mime(path).is_some()
}

impl Background {
    fn check(&self) -> Result<(), &'static str> {
        if !is_hex_color(&self.color) {
            return Err(ERR_INVALID);
        }
        if self.kind == Kind::Image && !self.image.as_ref().is_some_and(valid_image) {
            return Err(ERR_INVALID_FILE);
        }
        Ok(())
    }
}

pub struct BackgroundState {
    current: Mutex<Background>,
    /// Sube cuando cambia el archivo, para que la página lo vuelva a pedir (sin caché).
    /// Solo entonces: con un video, una versión nueva lo reinicia desde el principio, y
    /// cambiar el ajuste (Cubrir/Ajustar) o el modo no debe hacerlo.
    version: Mutex<u64>,
    /// Archivo de la última versión entregada.
    shown: Mutex<Option<PathBuf>>,
    file: Option<PathBuf>,
}

impl BackgroundState {
    /// Carga el fondo guardado. Si la imagen ya no existe, vuelve a transparente.
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Self {
        let file = app.path().app_config_dir().ok().map(|d| d.join(FILE_NAME));
        let mut current = file
            .as_ref()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|s| serde_json::from_str::<Background>(&s).ok())
            .filter(|b| is_hex_color(&b.color))
            .unwrap_or_default();
        if current.kind == Kind::Image && !current.image.as_ref().is_some_and(valid_image) {
            log::warn!("La imagen de fondo guardada ya no existe; se usa fondo transparente");
            current.kind = Kind::Transparent;
        }
        Self { current: Mutex::new(current), version: Mutex::new(0), shown: Mutex::new(None), file }
    }

    fn save(&self, bg: &Background) -> std::io::Result<()> {
        let Some(file) = &self.file else { return Ok(()) };
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(file, serde_json::to_string_pretty(bg)?)
    }
}

/// Versión del archivo de fondo: sube solo si el archivo es otro que el último entregado.
fn next_version(state: &BackgroundState, image: Option<&PathBuf>) -> u64 {
    let mut shown = state.shown.lock().unwrap();
    let mut v = state.version.lock().unwrap();
    if *v == 0 || shown.as_ref() != image {
        *v += 1;
        *shown = image.cloned();
    }
    *v
}

/// Entrega la imagen al servidor del avatar y envía el fondo a la página.
pub fn apply<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<BackgroundState>();
    let bg = state.current.lock().unwrap().clone();
    let version = next_version(&state, bg.image.as_ref());
    if let Ok(obs) = app.state::<ObsState>().0.lock() {
        if let Some(obs) = obs.as_ref() {
            obs.set_background_image((bg.kind == Kind::Image).then(|| bg.image.clone()).flatten());
        }
    }
    // `media`: la página no ve el nombre del archivo (lo pide a /background) y necesita saber
    // si es una imagen o un video.
    let media = if bg.image.as_deref().is_some_and(is_video) { "video" } else { "image" };
    let msg = serde_json::json!({
        "type": "background", "avatar": MAIN_AVATAR,
        "kind": bg.kind, "color": bg.color, "fit": bg.fit, "v": version, "media": media,
    });
    app.state::<TrackingState>()
        .0
        .set_sticky(&format!("background:{MAIN_AVATAR}"), &msg.to_string());
}

/// Fondo actual.
#[tauri::command]
pub fn background_get(state: tauri::State<'_, BackgroundState>) -> Background {
    state.current.lock().unwrap().clone()
}

/// Cambia el fondo, lo guarda y lo aplica.
#[tauri::command]
pub fn background_set(app: AppHandle, value: Background) -> Result<(), String> {
    value.check().map_err(String::from)?;
    let state = app.state::<BackgroundState>();
    state.save(&value).map_err(|e| format!("internal: {e}"))?;
    *state.current.lock().unwrap() = value;
    apply(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valida_colores() {
        assert!(is_hex_color("#00b140"));
        assert!(is_hex_color("#ABCDEF"));
        assert!(!is_hex_color("00b140"));
        assert!(!is_hex_color("#00b14"));
        assert!(!is_hex_color("#00b14g"));
        assert!(!is_hex_color("#00b140; background: url(x)"));
    }

    #[test]
    fn imagen_requerida_en_modo_imagen() {
        let mut bg = Background { kind: Kind::Image, ..Default::default() };
        assert_eq!(bg.check(), Err(ERR_INVALID_FILE));
        bg.image = Some(PathBuf::from("no-existe.png"));
        assert_eq!(bg.check(), Err(ERR_INVALID_FILE));
        bg.kind = Kind::Color;
        assert_eq!(bg.check(), Ok(())); // en modo color la imagen guardada no importa
    }

    #[test]
    fn la_version_sube_solo_si_cambia_el_archivo() {
        let state = BackgroundState {
            current: Mutex::new(Background::default()),
            version: Mutex::new(0),
            shown: Mutex::new(None),
            file: None,
        };
        let a = PathBuf::from("a.mp4");
        let b = PathBuf::from("b.mp4");
        assert_eq!(next_version(&state, None), 1); // la primera vez siempre
        assert_eq!(next_version(&state, Some(&a)), 2);
        assert_eq!(next_version(&state, Some(&a)), 2); // otro ajuste, mismo video: no se reinicia
        assert_eq!(next_version(&state, Some(&b)), 3);
        assert_eq!(next_version(&state, Some(&a)), 4); // volver al anterior: se vuelve a pedir
    }

    #[test]
    fn lee_el_formato_guardado() {
        let bg: Background = serde_json::from_str(r##"{"kind":"color","color":"#112233","fit":"contain"}"##).unwrap();
        assert_eq!(bg.kind, Kind::Color);
        assert_eq!(bg.fit, Fit::Contain);
        assert!(bg.image.is_none());
    }
}
