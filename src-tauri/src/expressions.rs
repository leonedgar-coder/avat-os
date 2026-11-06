// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Expresiones del avatar (emociones VRM) activadas con atajos de teclado
// globales (funcionan aunque avat-os no tenga el foco, p. ej. jugando) o con
// los botones del panel. Pulsar el atajo de la expresión activa vuelve a neutral.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::tracking_relay::TrackingState;

/// Avatar destino. Hoy hay uno solo; el diseño admite varios (modo dúo).
pub const MAIN_AVATAR: &str = "main";

/// Expresiones preestablecidas de VRM y su atajo (Ctrl+Shift+número).
/// No se usa Ctrl+Alt: en teclados en español equivale a AltGr (AltGr+2 = @).
const EXPRESSIONS: [(&str, Code, &str); 5] = [
    ("happy", Code::Digit1, "Ctrl+Shift+1"),
    ("angry", Code::Digit2, "Ctrl+Shift+2"),
    ("sad", Code::Digit3, "Ctrl+Shift+3"),
    ("surprised", Code::Digit4, "Ctrl+Shift+4"),
    ("relaxed", Code::Digit5, "Ctrl+Shift+5"),
];
const MODS: Modifiers = Modifiers::CONTROL.union(Modifiers::SHIFT);

/// Expresión activa (`None` = neutral).
#[derive(Default)]
pub struct ExpressionState(Mutex<Option<String>>);

#[derive(Serialize)]
pub struct ExpressionInfo {
    name: &'static str,
    shortcut: &'static str,
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

/// Pulsar la expresión activa vuelve a neutral. Leer y cambiar se hace con el
/// mismo bloqueo para que un atajo y un botón simultáneos no se pisen.
fn toggle<R: Runtime>(app: &AppHandle<R>, name: &str) {
    let state = app.state::<ExpressionState>();
    let next = {
        let mut current = state.0.lock().unwrap();
        let next = (current.as_deref() != Some(name)).then(|| name.to_owned());
        *current = next.clone();
        next
    };
    notify(app, next);
}

/// Plugin de atajos globales con el manejador de expresiones.
pub fn shortcuts_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            if let Some((name, _, _)) =
                EXPRESSIONS.iter().find(|(_, code, _)| *shortcut == Shortcut::new(Some(MODS), *code))
            {
                toggle(app, name);
            }
        })
        .build()
}

/// Registra los atajos. Si otro programa ya usa alguno, se avisa en el log y se sigue.
pub fn register_shortcuts<R: Runtime>(app: &AppHandle<R>) {
    for (name, code, label) in EXPRESSIONS {
        if let Err(e) = app.global_shortcut().register(Shortcut::new(Some(MODS), code)) {
            log::warn!("No se pudo registrar el atajo {label} ({name}): {e}");
        }
    }
}

/// Lista de expresiones con su atajo, para los botones del panel.
#[tauri::command]
pub fn expression_list() -> Vec<ExpressionInfo> {
    EXPRESSIONS
        .iter()
        .map(|(name, _, shortcut)| ExpressionInfo { name, shortcut })
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
        Some(n) if EXPRESSIONS.iter().any(|(e, _, _)| *e == n) => toggle(&app, &n),
        // Código de error: la interfaz lo traduce (errors.expression_unknown).
        Some(n) => return Err(format!("expression_unknown: {n}")),
    }
    Ok(())
}
