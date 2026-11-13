// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Expresiones del avatar (emociones VRM) y gestos animados. Se activan con los
// botones del panel o con atajos de teclado globales (ver shortcuts.rs).
// - Expresión: se queda activa; activarla otra vez vuelve a neutral.
// - Gesto: una animación corta (saludar, asentir…) que termina sola.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::shortcuts;
use crate::tracking_relay::TrackingState;

/// Avatar destino. Hoy hay uno solo; el diseño admite varios (modo dúo).
pub const MAIN_AVATAR: &str = "main";

/// Expresiones preestablecidas de VRM.
const EXPRESSIONS: [&str; 5] = ["happy", "angry", "sad", "surprised", "relaxed"];
/// Gestos animados.
const GESTURES: [&str; 4] = ["wave", "nod", "shake", "shrug"];

/// Reproduce un gesto en la página del avatar. No es "pegajoso": es momentáneo.
pub fn play_gesture<R: Runtime>(app: &AppHandle<R>, name: &str) {
    if !GESTURES.contains(&name) {
        return;
    }
    let msg = serde_json::json!({ "type": "gesture", "avatar": MAIN_AVATAR, "name": name });
    app.state::<TrackingState>().0.broadcast(&msg.to_string());
    let _ = app.emit("gesture-played", name);
}

/// Expresión activa (`None` = neutral).
#[derive(Default)]
pub struct ExpressionState(Mutex<Option<String>>);

#[derive(Serialize)]
pub struct ExpressionInfo {
    name: &'static str,
    /// Atajo actual para mostrar (`Ctrl+Shift+1`) o `null` si no tiene.
    shortcut: Option<String>,
}

/// Activa una expresión (o neutral) y la envía a la página del avatar y a la interfaz.
fn apply<R: Runtime>(app: &AppHandle<R>, name: Option<String>) {
    *app.state::<ExpressionState>().0.lock().unwrap() = name.clone();
    notify(app, name);
}

/// Envía la expresión ya guardada a la página del avatar y a la interfaz.
fn notify<R: Runtime>(app: &AppHandle<R>, name: Option<String>) {
    let msg = serde_json::json!({ "type": "expression", "avatar": MAIN_AVATAR, "name": name });
    // "Pegajoso": una página que se conecta después (p. ej. al cambiar de avatar) la recibe igual.
    app.state::<TrackingState>()
        .0
        .set_sticky(&format!("expression:{MAIN_AVATAR}"), &msg.to_string());
    let _ = app.emit("expression-changed", name);
}

/// Activar la expresión activa vuelve a neutral. Leer y cambiar se hace con el
/// mismo bloqueo para que un atajo y un botón simultáneos no se pisen.
pub fn toggle<R: Runtime>(app: &AppHandle<R>, name: &str) {
    if !EXPRESSIONS.contains(&name) {
        return;
    }
    let state = app.state::<ExpressionState>();
    let next = {
        let mut current = state.0.lock().unwrap();
        let next = (current.as_deref() != Some(name)).then(|| name.to_owned());
        *current = next.clone();
        next
    };
    notify(app, next);
}

/// Lista de expresiones con su atajo, para los botones del panel.
#[tauri::command]
pub fn expression_list(app: AppHandle) -> Vec<ExpressionInfo> {
    EXPRESSIONS
        .iter()
        .map(|name| ExpressionInfo { name, shortcut: shortcuts::label_for(&app, &format!("expression.{name}")) })
        .collect()
}

/// Expresión activa (`null` = neutral).
#[tauri::command]
pub fn expression_current(state: tauri::State<'_, ExpressionState>) -> Option<String> {
    state.0.lock().ok()?.clone()
}

/// Desde la interfaz: `name` alterna esa expresión (como su atajo); `null` = neutral.
#[tauri::command]
pub fn expression_set(app: AppHandle, name: Option<String>) -> Result<(), String> {
    match name {
        None => apply(&app, None),
        Some(n) if EXPRESSIONS.contains(&n.as_str()) => toggle(&app, &n),
        // Código de error: la interfaz lo traduce (errors.expression_unknown).
        Some(n) => return Err(format!("expression_unknown: {n}")),
    }
    Ok(())
}

/// Lista de gestos con su atajo, para los botones del panel.
#[tauri::command]
pub fn gesture_list(app: AppHandle) -> Vec<ExpressionInfo> {
    GESTURES
        .iter()
        .map(|name| ExpressionInfo { name, shortcut: shortcuts::label_for(&app, &format!("gesture.{name}")) })
        .collect()
}

/// Reproduce un gesto desde la interfaz.
#[tauri::command]
pub fn gesture_play(app: AppHandle, name: String) -> Result<(), String> {
    if !GESTURES.contains(&name.as_str()) {
        // Código de error: la interfaz lo traduce (errors.gesture_unknown).
        return Err(format!("gesture_unknown: {name}"));
    }
    play_gesture(&app, &name);
    Ok(())
}
