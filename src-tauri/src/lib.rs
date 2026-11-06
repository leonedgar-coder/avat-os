// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later

mod avatar_server;
mod expressions;
mod obs;
mod tracking_relay;

use tauri::Manager;

/// Versión de la app, mostrada en la barra superior.
#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Carpeta de recursos de prueba (`recursos/avatares`, `fondos`, `objetos`).
// TODO(Fase 5): en la app instalada, usar Documentos\avat-os.
#[tauri::command]
fn resources_dir(kind: &str) -> Option<String> {
    if !matches!(kind, "avatares" | "fondos" | "objetos") {
        return None;
    }
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../recursos").join(kind);
    Some(dir.canonicalize().ok()?.to_string_lossy().trim_start_matches(r"\\?\").to_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(expressions::shortcuts_plugin())
        .manage(obs::ObsState::default())
        .manage(expressions::ExpressionState::default())
        .setup(|app| {
            let relay = tracking_relay::TrackingRelay::start()?;
            let tracking_port = relay.port();
            app.manage(tracking_relay::TrackingState(relay));
            expressions::register_shortcuts(app.handle());
            obs::init(app, tracking_port);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Quitar la vista previa de libobs antes de que se destruya la ventana.
            // La ventana se oculta primero: apagar OBS y su navegador tarda unos
            // segundos y así el cierre se siente inmediato.
            if window.label() == "main" && matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let _ = window.hide();
                obs::shutdown(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            resources_dir,
            obs::preview_set_bounds,
            obs::avatar_load,
            obs::avatar_current,
            obs::obs_status,
            tracking_relay::tracking_update,
            expressions::expression_list,
            expressions::expression_current,
            expressions::expression_set
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar avat-os");
}
