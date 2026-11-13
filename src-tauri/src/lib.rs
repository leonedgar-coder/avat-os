// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later

mod avatar_server;
mod background;
mod calibration;
mod effects;
mod expressions;
mod obs;
mod recent_avatars;
mod shortcuts;
mod tracking_relay;
mod win_icon;

use tauri::Manager;

/// Versión de la app, mostrada en la barra superior.
#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Carpeta de recursos de prueba (`recursos/avatares`, `fondos`, `objetos`).
// TODO(Fase 6): en la app instalada, usar Documentos\avat-os.
#[tauri::command]
fn resources_dir(kind: &str) -> Option<String> {
    if !matches!(kind, "avatares" | "fondos" | "objetos") {
        return None;
    }
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../recursos").join(kind);
    Some(dir.canonicalize().ok()?.to_string_lossy().trim_start_matches(r"\\?\").to_owned())
}

/// avat-os se está cerrando (ventana ya oculta, OBS apagándose: tarda unos segundos).
static CLOSING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        // Una sola copia de avat-os: dos copias pelearían por los atajos globales, la
        // cámara y el motor de OBS. Abrir otra trae al frente la que ya está abierta.
        // (Debe ser el primer plugin.)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Si esta copia se está cerrando, no volver a mostrar la ventana (aparecería un
            // instante sin vista previa y se cerraría igual); se podrá abrir en unos segundos.
            if CLOSING.load(std::sync::atomic::Ordering::SeqCst) {
                log::info!("Se intentó abrir avat-os mientras se cerraba: se ignora");
                return;
            }
            log::info!("Se intentó abrir otra copia de avat-os: se trae al frente esta");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(shortcuts::plugin())
        .manage(obs::ObsState::default())
        .manage(obs::AvatarStatusState::default())
        .manage(expressions::ExpressionState::default())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                win_icon::set_taskbar_icon(&window);
            }
            let relay = tracking_relay::TrackingRelay::start()?;
            let tracking_port = relay.port();
            app.manage(tracking_relay::TrackingState(relay));
            app.manage(calibration::CalibrationState::load(app.handle()));
            calibration::publish(app.handle());
            app.manage(shortcuts::ShortcutsState::load(app.handle()));
            shortcuts::register_all(app.handle());
            // Antes de OBS: el último avatar se carga al crear la fuente.
            app.manage(recent_avatars::RecentAvatarsState::load(app.handle()));
            obs::init(app, tracking_port);
            // El fondo se aplica después de arrancar OBS (el servidor del avatar entrega la imagen).
            app.manage(background::BackgroundState::load(app.handle()));
            background::apply(app.handle());
            app.manage(effects::EffectsState::load(app.handle()));
            effects::apply(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Quitar la vista previa de libobs antes de que se destruya la ventana.
            // La ventana se oculta primero: apagar OBS y su navegador tarda unos
            // segundos y así el cierre se siente inmediato.
            if window.label() == "main" && matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                CLOSING.store(true, std::sync::atomic::Ordering::SeqCst);
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
            recent_avatars::avatar_recent,
            recent_avatars::avatar_recent_remove,
            obs::avatar_status,
            obs::obs_status,
            tracking_relay::tracking_update,
            tracking_relay::lipsync_update,
            expressions::expression_list,
            expressions::expression_current,
            expressions::expression_set,
            expressions::gesture_list,
            shortcuts::shortcuts_get,
            shortcuts::shortcuts_set,
            shortcuts::shortcuts_reset,
            shortcuts::shortcuts_pause,
            shortcuts::shortcuts_status,
            shortcuts::shortcuts_retry,
            expressions::gesture_play,
            calibration::calibration_get,
            calibration::calibration_set,
            calibration::calibration_preview,
            calibration::calibration_preview_end,
            calibration::calibration_reset,
            background::background_get,
            background::background_set,
            effects::effects_get,
            effects::effects_set
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar avat-os");
}
