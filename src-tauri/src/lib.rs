// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/// Versión de la app, mostrada en la barra superior.
#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![app_version])
        .run(tauri::generate_context!())
        .expect("error al iniciar avat-os");
}
