// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Motor de video: arranca libobs, crea la escena y dibuja la vista previa
// en una ventana nativa hija colocada encima del recuadro "Vista previa"
// de la interfaz web.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, anyhow};
use libobs_simple::sources::windows::{MonitorCaptureSourceBuilder, ObsDisplayCaptureMethod};
use libobs_wrapper::context::ObsContext;
use libobs_wrapper::data::object::ObsObjectTrait;
use libobs_wrapper::data::video::ObsVideoInfoBuilder;
use libobs_wrapper::data::{ObsData, ObsDataSetters};
use libobs_wrapper::display::{
    ObsDisplayCreationData, ObsDisplayRef, ObsWindowHandle, PreviewScaleMode, PreviewTarget,
    ShowHideTrait, WindowPositionTrait,
};
use libobs_wrapper::scenes::SceneItemTrait;
use libobs_wrapper::sources::{ObsSourceBuilder, ObsSourceRef};
use libobs_wrapper::utils::{ObsPath, StartupInfo};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tauri::{Manager, WebviewWindow};

use crate::avatar_server::AvatarServer;

// Códigos de error para la interfaz (los traduce `errors.*` en src/lib/i18n/*.json).
// Los demás errores se envían como `internal: <detalle>`.
const ERR_ENGINE_NOT_RUNNING: &str = "engine_not_running";
const ERR_AVATAR_INVALID_FILE: &str = "avatar_invalid_file";

/// Resolución base del lienzo (lo que se graba).
const CANVAS_WIDTH: u32 = 1920;
const CANVAS_HEIGHT: u32 = 1080;
/// Color de fondo del preview fuera del lienzo (0xAABBGGRR) — igual al tema.
const PREVIEW_BACKGROUND: u32 = 0xFF16_0D0E;

// Rust libera los campos en orden de declaración: `context` va al final para
// que libobs se apague después de soltar la vista previa y las fuentes.
pub struct Obs {
    display: ObsDisplayRef,
    avatar: ObsSourceRef,
    avatar_server: AvatarServer,
    /// Sube cada vez que se carga otro avatar, para que la página se recargue.
    avatar_version: u64,
    context: ObsContext,
}

/// Carpeta con la página compilada del avatar (`npm run build:avatar`).
fn avatar_site_dir() -> PathBuf {
    // TODO(Fase 5): empaquetarla como recurso de Tauri para el instalador.
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../avatar/dist")
}

/// Estado compartido con los comandos de Tauri. `None` si libobs no arrancó
/// o si la app se está cerrando.
#[derive(Default)]
pub struct ObsState(pub Mutex<Option<Obs>>);

impl Obs {
    /// Arranca libobs y crea la vista previa dentro de `window`.
    /// `config_dir` es donde los plugins de OBS guardan sus datos (fuera del proyecto).
    /// `tracking_port` es el canal por el que la página del avatar recibe el tracking.
    pub fn start(window: &WebviewWindow, config_dir: &Path, tracking_port: u16) -> anyhow::Result<Self> {
        let video = ObsVideoInfoBuilder::new()
            .base_width(CANVAS_WIDTH)
            .base_height(CANVAS_HEIGHT)
            .output_width(CANVAS_WIDTH)
            .output_height(CANVAS_HEIGHT)
            .build();
        std::fs::create_dir_all(config_dir)?;
        let config_dir = config_dir.to_str().context("Ruta de configuración no válida")?;
        let mut context = StartupInfo::new()
            .set_video_info(video)
            .set_module_config_path(ObsPath::new(config_dir))
            .start()?;

        // Escena de prueba: captura del monitor principal.
        let mut scene = context.scene("Escena principal", Some(0))?;
        let monitors = MonitorCaptureSourceBuilder::get_monitors()?;
        let item = context
            .source_builder::<MonitorCaptureSourceBuilder, _>("Pantalla")?
            .set_monitor(monitors.first().context("No se encontró ningún monitor")?)
            .set_capture_method(ObsDisplayCaptureMethod::MethodDXGI)
            .add_to_scene(&mut scene)?;
        item.fit_source_to_screen()?;

        // Avatar: página web (three-vrm) como fuente de navegador transparente
        // del tamaño del lienzo, encima de la pantalla.
        let avatar_server = AvatarServer::start(avatar_site_dir(), tracking_port)?;
        let browser = context
            .source_type("browser_source")?
            .context("OBS no tiene la fuente de navegador (obs-browser)")?;
        let mut settings = browser.default_settings_mut()?;
        settings
            .set_string("url", avatar_server.url(0).as_str())?
            .set_bool("is_local_file", false)?
            .set_int("width", CANVAS_WIDTH as i64)?
            .set_int("height", CANVAS_HEIGHT as i64)?
            .set_int("fps", 30)?
            .set_bool("reroute_audio", false)?
            .set_bool("shutdown", false)?;
        let avatar = context.create_source(&browser, "Avatar", Some(settings))?;
        scene.add(avatar.clone())?;

        let handle = match window.window_handle()?.as_raw() {
            // SAFETY: el HWND pertenece a la ventana principal, que vive más que
            // la vista previa: la quitamos en `shutdown` antes de cerrarla.
            RawWindowHandle::Win32(h) => unsafe {
                ObsWindowHandle::new_from_handle(h.hwnd.get() as *mut _)
            },
            other => return Err(anyhow!("Ventana no soportada: {other:?}")),
        };

        // Tamaño inicial provisional; la interfaz manda el real con `preview_set_bounds`.
        let data = ObsDisplayCreationData::new(handle, 0, 0, 640, 360)
            .set_background_color(PREVIEW_BACKGROUND);
        // SAFETY: la vista previa se quita (`remove_display`) antes de soltar el contexto.
        #[allow(unused_unsafe)]
        let mut display = unsafe { context.display(data)? };
        display.set_target(PreviewTarget::Scene(scene))?;
        display.set_scale_mode(PreviewScaleMode::Fit)?;
        display.hide()?;

        Ok(Self {
            display,
            avatar,
            avatar_server,
            avatar_version: 0,
            context,
        })
    }

    fn load_avatar(&mut self, path: PathBuf) -> anyhow::Result<()> {
        let is_vrm = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("vrm"));
        if !is_vrm || !path.is_file() {
            anyhow::bail!(ERR_AVATAR_INVALID_FILE);
        }
        self.avatar_server.set_model(path);
        self.avatar_version += 1;
        let mut settings = ObsData::new(self.context.runtime().clone())?;
        settings.set_string("url", self.avatar_server.url(self.avatar_version).as_str())?;
        self.avatar.update_settings(settings)?;
        Ok(())
    }

    fn set_bounds(&mut self, x: i32, y: i32, width: u32, height: u32) -> anyhow::Result<()> {
        if width == 0 || height == 0 {
            self.display.hide()?;
            return Ok(());
        }
        self.display.set_pos(x, y)?;
        self.display.set_size(width, height)?;
        if !self.display.is_visible()? {
            self.display.show()?;
        }
        Ok(())
    }

    /// Quita la vista previa y apaga libobs. Debe llamarse antes de cerrar la ventana.
    pub fn shutdown(mut self) {
        if let Err(e) = self.context.remove_display(&self.display) {
            log::warn!("No se pudo quitar la vista previa: {e}");
        }
    }
}

/// Coloca la vista previa (en píxeles físicos, relativos al área cliente de la ventana).
#[tauri::command]
pub fn preview_set_bounds(
    state: tauri::State<'_, ObsState>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| format!("internal: {e}"))?;
    match guard.as_mut() {
        Some(obs) => obs.set_bounds(x, y, width, height).map_err(|e| format!("internal: {e:#}")),
        None => Err(ERR_ENGINE_NOT_RUNNING.into()),
    }
}

/// Carga un avatar `.vrm` en la fuente "Avatar".
#[tauri::command]
pub fn avatar_load(state: tauri::State<'_, ObsState>, path: PathBuf) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| format!("internal: {e}"))?;
    match guard.as_mut() {
        Some(obs) => obs.load_avatar(path).map_err(|e| {
            let msg = format!("{e:#}");
            if msg == ERR_AVATAR_INVALID_FILE { msg } else { format!("internal: {msg}") }
        }),
        None => Err(ERR_ENGINE_NOT_RUNNING.into()),
    }
}

/// Nombre del avatar cargado (o `None`).
#[tauri::command]
pub fn avatar_current(state: tauri::State<'_, ObsState>) -> Option<String> {
    state.0.lock().ok()?.as_ref()?.avatar_server.model_name()
}

/// ¿Arrancó libobs?
#[tauri::command]
pub fn obs_status(state: tauri::State<'_, ObsState>) -> bool {
    state.0.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Arranca libobs para la ventana principal. Si falla, la app sigue abierta
/// sin vista previa y el error queda en el log.
pub fn init(app: &tauri::App, tracking_port: u16) {
    let Some(window) = app.get_webview_window("main") else {
        log::error!("No existe la ventana principal");
        return;
    };
    let config_dir = match app.path().app_config_dir() {
        Ok(dir) => dir.join("obs"),
        Err(e) => {
            log::error!("No se encontró la carpeta de configuración: {e}");
            return;
        }
    };
    match Obs::start(&window, &config_dir, tracking_port) {
        Ok(mut obs) => {
            // Desarrollo: `AVATOS_VRM=ruta\al\avatar.vrm` lo carga al arrancar.
            if let Some(path) = std::env::var_os("AVATOS_VRM") {
                if let Err(e) = obs.load_avatar(PathBuf::from(path)) {
                    log::error!("AVATOS_VRM: {e:#}");
                }
            }
            *app.state::<ObsState>().0.lock().unwrap() = Some(obs);
        }
        Err(e) => log::error!("No se pudo iniciar libobs: {e:#}"),
    }
}

/// Apaga libobs (al cerrar la ventana principal).
pub fn shutdown(app: &tauri::AppHandle) {
    let obs = app.state::<ObsState>().0.lock().ok().and_then(|mut g| g.take());
    if let Some(obs) = obs {
        obs.shutdown();
    }
}
