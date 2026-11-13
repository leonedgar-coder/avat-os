// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Efectos del avatar: cámara (plano, zoom, altura, ángulo), iluminación y contorno.
// Se guardan en `<config>/efectos.json` y la página del avatar los recibe por el
// canal en vivo (mensaje pegajoso `effects`).

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::expressions::MAIN_AVATAR;
use crate::tracking_relay::TrackingState;

const FILE_NAME: &str = "efectos.json";
/// Código de error para la interfaz (`errors.effects_invalid`).
const ERR_INVALID: &str = "effects_invalid";

/// Encuadre de la cámara del avatar.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Shot {
    /// Cabeza y hombros.
    Close,
    /// De la cintura para arriba (el típico de VTuber).
    Medium,
    /// Cuerpo entero.
    Full,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Effects {
    pub shot: Shot,
    /// Acercar (> 1) o alejar (< 1): 0,5 a 2.
    pub zoom: f32,
    /// Subir o bajar el encuadre, en metros: −0,5 a 0,5.
    pub height: f32,
    /// Girar la cámara alrededor del avatar, en grados: −60 a 60.
    pub angle: f32,
    /// Intensidad de la luz principal: 0 a 2 (1 = normal).
    pub light_intensity: f32,
    /// Color de la luz principal (`#rrggbb`).
    pub light_color: String,
    /// Desde dónde llega la luz, en grados: −90 (izquierda) a 90 (derecha).
    pub light_angle: f32,
    /// Luz ambiente (rellena las sombras): 0 a 1,5.
    pub ambient: f32,
    /// Grosor del contorno respecto del original del avatar: 0 (sin contorno) a 4.
    pub outline: f32,
}

impl Default for Effects {
    fn default() -> Self {
        Self {
            shot: Shot::Medium,
            zoom: 1.0,
            height: 0.0,
            angle: 0.0,
            light_intensity: 1.0,
            light_color: "#ffffff".into(),
            light_angle: 45.0,
            ambient: 0.4,
            outline: 1.0,
        }
    }
}

fn is_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

impl Effects {
    fn is_valid(&self) -> bool {
        let within = |v: f32, lo: f32, hi: f32| v.is_finite() && (lo..=hi).contains(&v);
        within(self.zoom, 0.5, 2.0)
            && within(self.height, -0.5, 0.5)
            && within(self.angle, -60.0, 60.0)
            && within(self.light_intensity, 0.0, 2.0)
            && within(self.light_angle, -90.0, 90.0)
            && within(self.ambient, 0.0, 1.5)
            && within(self.outline, 0.0, 4.0)
            && is_hex_color(&self.light_color)
    }
}

pub struct EffectsState {
    current: Mutex<Effects>,
    file: Option<PathBuf>,
}

impl EffectsState {
    /// Carga los efectos guardados (si el archivo es inválido, valores por defecto).
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Self {
        let file = app.path().app_config_dir().ok().map(|d| d.join(FILE_NAME));
        let current = file
            .as_ref()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|s| serde_json::from_str::<Effects>(&s).ok())
            .filter(Effects::is_valid)
            .unwrap_or_default();
        Self { current: Mutex::new(current), file }
    }

    fn save(&self, fx: &Effects) -> std::io::Result<()> {
        let Some(file) = &self.file else { return Ok(()) };
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(file, serde_json::to_string_pretty(fx)?)
    }
}

/// Envía los efectos a la página del avatar.
pub fn apply<R: Runtime>(app: &AppHandle<R>) {
    let fx = app.state::<EffectsState>().current.lock().unwrap().clone();
    let msg = serde_json::json!({ "type": "effects", "avatar": MAIN_AVATAR, "values": fx });
    app.state::<TrackingState>()
        .0
        .set_sticky(&format!("effects:{MAIN_AVATAR}"), &msg.to_string());
}

/// Efectos actuales.
#[tauri::command]
pub fn effects_get(state: tauri::State<'_, EffectsState>) -> Effects {
    state.current.lock().unwrap().clone()
}

/// Cambia los efectos, los guarda y los aplica.
#[tauri::command]
pub fn effects_set(app: AppHandle, values: Effects) -> Result<(), String> {
    if !values.is_valid() {
        return Err(ERR_INVALID.into());
    }
    let state = app.state::<EffectsState>();
    state.save(&values).map_err(|e| format!("internal: {e}"))?;
    *state.current.lock().unwrap() = values;
    apply(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valores_por_defecto_validos() {
        assert!(Effects::default().is_valid());
    }

    #[test]
    fn rechaza_fuera_de_rango() {
        let ok = Effects::default();
        for bad in [
            Effects { zoom: 3.0, ..ok.clone() },
            Effects { angle: -90.0, ..ok.clone() },
            Effects { outline: f32::NAN, ..ok.clone() },
            Effects { light_color: "red".into(), ..ok.clone() },
        ] {
            assert!(!bad.is_valid(), "{bad:?}");
        }
    }

    #[test]
    fn completa_campos_que_faltan() {
        // Un archivo de una versión anterior (o editado a mano) con pocos campos.
        let fx: Effects = serde_json::from_str(r#"{"shot":"close","zoom":1.5}"#).unwrap();
        assert_eq!(fx.shot, Shot::Close);
        assert_eq!(fx.zoom, 1.5);
        assert_eq!(fx.light_color, "#ffffff");
        assert!(fx.is_valid());
    }
}
