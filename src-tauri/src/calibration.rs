// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Calibración del tracking facial: umbrales de ojos y boca de la persona y su
// postura "de frente". La calcula el asistente de la interfaz, se guarda en
// `<config>/calibracion.json` y se envía a la página del avatar por el canal en
// vivo (mensaje pegajoso `calibration`). Sin calibración, la página usa sus
// valores por defecto.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::expressions::MAIN_AVATAR;
use crate::tracking_relay::TrackingState;

/// Código de error para la interfaz (`errors.calibration_invalid`).
const ERR_INVALID: &str = "calibration_invalid";
const FILE_NAME: &str = "calibracion.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Calibration {
    /// Valor de MediaPipe por debajo del cual el ojo queda abierto (0–1). Con `eye_right`,
    /// es el del ojo izquierdo (`blinkLeft`); sin él, el de los dos.
    pub eye_open: f32,
    /// Valor desde el cual el ojo queda cerrado del todo (0–1). Igual que `eye_open`.
    pub eye_closed: f32,
    /// Umbrales propios del ojo derecho (`blinkRight`) [abierto, cerrado]: la cámara suele
    /// ver un ojo más cerrado que el otro. `None` en calibraciones antiguas (= los mismos).
    #[serde(default)]
    pub eye_right: Option<[f32; 2]>,
    /// Valor de `jawOpen` por debajo del cual la boca queda cerrada (0–1).
    pub mouth_closed: f32,
    /// Valor de `jawOpen` desde el cual la boca queda abierta del todo (0–1).
    pub mouth_open: f32,
    /// Rotación de la cabeza cuando la persona mira de frente [pitch, yaw, roll] (rad).
    pub head_offset: [f32; 3],
    /// Posición de la cabeza en reposo [x, y, z] (cm).
    pub rest_pos: [f32; 3],
    /// Mirada [horizontal, vertical] al mirar la pantalla de frente (la cámara suele
    /// estar más arriba que la pantalla). `[0, 0]` en calibraciones antiguas.
    #[serde(default)]
    pub gaze_offset: [f32; 2],
    /// Medidas originales del asistente, para recalcular los umbrales al cambiar la
    /// sensibilidad sin repetir los pasos. `None` en calibraciones antiguas.
    #[serde(default)]
    pub levels: Option<Levels>,
    /// Sensibilidad de ojos y boca elegida con los deslizadores (−1 a 1; 0 = normal).
    #[serde(default)]
    pub eye_sensitivity: f32,
    #[serde(default)]
    pub mouth_sensitivity: f32,
}

/// Valores que midió MediaPipe en cada paso del asistente (0–1).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Levels {
    pub eye_open: f32,
    pub eye_closed: f32,
    pub jaw_rest: f32,
    pub jaw_max: f32,
    /// Medidas del ojo derecho [abierto, cerrado]; con ellas, `eye_open` / `eye_closed` son
    /// las del izquierdo. `None` en calibraciones antiguas.
    #[serde(default)]
    pub eye_right: Option<[f32; 2]>,
    /// Cuánto tiembla el valor de cada ojo abierto [izq., der.] (desvío robusto del paso 1):
    /// los umbrales quedan por encima de ese temblor. `None` en calibraciones antiguas.
    #[serde(default)]
    pub eye_noise: Option<[f32; 2]>,
}

impl Calibration {
    fn is_valid(&self) -> bool {
        let unit = |v: f32| (0.0..=1.0).contains(&v);
        let sens = |v: f32| (-1.0..=1.0).contains(&v);
        let finite = self.head_offset.iter().chain(&self.rest_pos).all(|v| v.is_finite())
            && self.gaze_offset.iter().all(|v| v.is_finite() && (-1.0..=1.0).contains(v));
        let levels_ok = self.levels.as_ref().is_none_or(|l| {
            [l.eye_open, l.eye_closed, l.jaw_rest, l.jaw_max].into_iter().all(unit)
                && l.eye_right.is_none_or(|[o, c]| unit(o) && unit(c))
                && l.eye_noise.is_none_or(|[a, b]| unit(a) && unit(b))
        });
        let right_ok = self.eye_right.is_none_or(|[o, c]| unit(o) && unit(c) && o < c);
        unit(self.eye_open)
            && unit(self.eye_closed)
            && right_ok
            && unit(self.mouth_closed)
            && unit(self.mouth_open)
            && self.eye_open < self.eye_closed
            && self.mouth_closed < self.mouth_open
            && sens(self.eye_sensitivity)
            && sens(self.mouth_sensitivity)
            && levels_ok
            && finite
    }
}

/// Calibración activa (`None` = valores por defecto de la página del avatar).
pub struct CalibrationState {
    current: Mutex<Option<Calibration>>,
    file: Option<PathBuf>,
}

impl CalibrationState {
    /// Carga la calibración guardada (si existe y es válida).
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Self {
        let file = app.path().app_config_dir().ok().map(|d| d.join(FILE_NAME));
        let current = file
            .as_ref()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|s| serde_json::from_str::<Calibration>(&s).ok())
            .filter(Calibration::is_valid);
        if current.is_some() {
            log::info!("Calibración cargada");
        }
        Self { current: Mutex::new(current), file }
    }

    fn save(&self, cal: Option<&Calibration>) -> std::io::Result<()> {
        let Some(file) = &self.file else { return Ok(()) };
        match cal {
            Some(c) => {
                if let Some(dir) = file.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                std::fs::write(file, serde_json::to_string_pretty(c)?)
            }
            None if file.exists() => std::fs::remove_file(file),
            None => Ok(()),
        }
    }
}

/// Envía la calibración guardada (o `null` = por defecto) a la página del avatar.
pub fn publish<R: Runtime>(app: &AppHandle<R>) {
    let cal = app.state::<CalibrationState>().current.lock().unwrap().clone();
    publish_values(app, cal.as_ref());
}

fn publish_values<R: Runtime>(app: &AppHandle<R>, cal: Option<&Calibration>) {
    let msg = serde_json::json!({ "type": "calibration", "avatar": MAIN_AVATAR, "values": cal });
    app.state::<TrackingState>()
        .0
        .set_sticky(&format!("calibration:{MAIN_AVATAR}"), &msg.to_string());
}

/// Calibración guardada (`null` si no hay).
#[tauri::command]
pub fn calibration_get(state: tauri::State<'_, CalibrationState>) -> Option<Calibration> {
    state.current.lock().ok()?.clone()
}

/// Guarda y aplica una calibración nueva.
#[tauri::command]
pub fn calibration_set(app: AppHandle, values: Calibration) -> Result<(), String> {
    if !values.is_valid() {
        return Err(ERR_INVALID.into());
    }
    let state = app.state::<CalibrationState>();
    state.save(Some(&values)).map_err(|e| format!("internal: {e}"))?;
    *state.current.lock().unwrap() = Some(values);
    publish(&app);
    Ok(())
}

/// Vista previa: aplica unos valores al avatar **sin guardarlos** (deslizadores de ajuste).
#[tauri::command]
pub fn calibration_preview(app: AppHandle, values: Calibration) -> Result<(), String> {
    if !values.is_valid() {
        return Err(ERR_INVALID.into());
    }
    publish_values(&app, Some(&values));
    Ok(())
}

/// Termina la vista previa sin guardar: el avatar vuelve a la calibración guardada.
#[tauri::command]
pub fn calibration_preview_end(app: AppHandle) {
    publish(&app);
}

/// Borra la calibración y vuelve a los valores por defecto.
#[tauri::command]
pub fn calibration_reset(app: AppHandle) -> Result<(), String> {
    let state = app.state::<CalibrationState>();
    state.save(None).map_err(|e| format!("internal: {e}"))?;
    *state.current.lock().unwrap() = None;
    publish(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD_FILE: &str = r#"{"eyeOpen":0.2,"eyeClosed":0.5,"mouthClosed":0.04,"mouthOpen":0.3,
        "headOffset":[0.1,-0.2,0.05],"restPos":[3,-2,-55]}"#;

    #[test]
    fn lee_calibraciones_antiguas() {
        let cal: Calibration = serde_json::from_str(OLD_FILE).expect("formato antiguo");
        assert!(cal.is_valid());
        assert!(cal.levels.is_none());
        assert_eq!(cal.eye_sensitivity, 0.0);
        assert_eq!(cal.gaze_offset, [0.0, 0.0]);
        assert!(cal.eye_right.is_none());
    }

    /// Lo que envía el asistente nuevo al pulsar Guardar (umbrales y medidas por ojo).
    #[test]
    fn acepta_lo_que_envia_el_asistente() {
        let json = r#"{"eyeOpen":0.209,"eyeClosed":0.281,"eyeRight":[0.202,0.223],"mouthClosed":0.04,"mouthOpen":0.16,
            "headOffset":[0.1,0.03,0.002],"restPos":[1.2,-3.5,-40.8],"gazeOffset":[0.01,-0.2],
            "levels":{"eyeOpen":0.176,"eyeClosed":0.3,"jawRest":0.0195,"jawMax":0.42,"eyeRight":[0.18,0.23],"eyeNoise":[0.004,0.005]},
            "eyeSensitivity":0.3,"mouthSensitivity":1}"#;
        let cal: Calibration = serde_json::from_str(json).expect("formato del asistente");
        assert!(cal.is_valid());
        // El ruido se guarda y se vuelve a leer (lo usan los deslizadores de "Prueba y ajuste").
        let again: Calibration = serde_json::from_str(&serde_json::to_string(&cal).unwrap()).unwrap();
        assert_eq!(again.levels.unwrap().eye_noise, Some([0.004, 0.005]));
    }

    #[test]
    fn umbrales_por_ojo() {
        let mut cal: Calibration = serde_json::from_str(OLD_FILE).unwrap();
        cal.eye_right = Some([0.3, 0.7]);
        assert!(cal.is_valid());
        // Se guarda y se vuelve a leer con el nombre que usa la interfaz.
        let json = serde_json::to_string(&cal).unwrap();
        assert!(json.contains("\"eyeRight\":[0.3,0.7]"));
        cal.eye_right = Some([0.7, 0.3]); // abierto por encima de cerrado
        assert!(!cal.is_valid());
        cal.eye_right = Some([0.2, 1.4]);
        assert!(!cal.is_valid());
    }

    #[test]
    fn rechaza_valores_fuera_de_rango() {
        let mut cal: Calibration = serde_json::from_str(OLD_FILE).unwrap();
        cal.eye_sensitivity = 1.5;
        assert!(!cal.is_valid());
        cal.eye_sensitivity = 0.0;
        cal.eye_open = 0.6; // abierto por encima de cerrado
        assert!(!cal.is_valid());
        cal.eye_open = 0.2;
        cal.levels = Some(Levels { eye_open: 0.1, eye_closed: 2.0, jaw_rest: 0.0, jaw_max: 0.5, eye_right: None, eye_noise: None });
        assert!(!cal.is_valid());
    }
}
