// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Avatares recientes: los últimos `.vrm` cargados, del más nuevo al más viejo. Se guardan
// en `<config>/avatares-recientes.json`. El primero que todavía exista se carga solo al
// arrancar (así la página del avatar se crea ya con el modelo y carga una sola vez).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

const FILE_NAME: &str = "avatares-recientes.json";
/// Cuántos se recuerdan.
const MAX_RECENT: usize = 8;

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    #[serde(default)]
    avatars: Vec<PathBuf>,
}

pub struct RecentAvatarsState {
    list: Mutex<Vec<PathBuf>>,
    file: Option<PathBuf>,
}

/// ¿Es un `.vrm` que existe?
pub fn is_vrm_file(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("vrm")) && path.is_file()
}

/// En Windows las rutas no distinguen mayúsculas: `C:\A.vrm` y `c:\a.VRM` son el mismo archivo.
fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

/// Agrega `path` al principio (sin repetir) y deja como mucho `MAX_RECENT`.
fn push_front(list: &mut Vec<PathBuf>, path: PathBuf) {
    list.retain(|p| !same_path(p, &path));
    list.insert(0, path);
    list.truncate(MAX_RECENT);
}

impl RecentAvatarsState {
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Self {
        let file = app.path().app_config_dir().ok().map(|d| d.join(FILE_NAME));
        let saved = file
            .as_ref()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|s| serde_json::from_str::<Saved>(&s).ok())
            .unwrap_or_default();
        let mut list = Vec::new();
        // Al revés: así push_front deja el orden original y quita repetidos.
        for path in saved.avatars.into_iter().rev() {
            push_front(&mut list, path);
        }
        Self { list: Mutex::new(list), file }
    }

    /// El avatar más reciente que todavía existe (para cargarlo al arrancar).
    pub fn last_existing(&self) -> Option<PathBuf> {
        self.list.lock().unwrap().iter().find(|p| is_vrm_file(p)).cloned()
    }

    fn save(&self) {
        let Some(file) = &self.file else { return };
        let saved = Saved { avatars: self.list.lock().unwrap().clone() };
        let result = file
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|_| std::fs::write(file, serde_json::to_string_pretty(&saved).unwrap_or_default()));
        if let Err(e) = result {
            log::warn!("No se pudo guardar {FILE_NAME}: {e}");
        }
    }
}

/// Anota un avatar recién cargado.
pub fn remember<R: Runtime>(app: &AppHandle<R>, path: &Path) {
    let state = app.state::<RecentAvatarsState>();
    push_front(&mut state.list.lock().unwrap(), path.to_path_buf());
    state.save();
    let _ = app.emit("recent-avatars-changed", ());
}

#[derive(Serialize)]
pub struct RecentAvatar {
    path: PathBuf,
    /// Nombre del archivo, para mostrar.
    name: String,
    /// `false` si el archivo ya no está (se movió o se borró).
    exists: bool,
    /// Es el avatar cargado ahora.
    current: bool,
}

/// Avatares recientes, del más nuevo al más viejo.
#[tauri::command]
pub fn avatar_recent(app: AppHandle) -> Vec<RecentAvatar> {
    // Se compara la ruta completa: dos avatares pueden llamarse igual en carpetas distintas,
    // y el cargado no siempre es el primero (si el primero ya no existe, se cargó el siguiente).
    // El lock de OBS se suelta antes de tomar el de la lista.
    let loaded = crate::obs::current_avatar_path(&app);
    let state = app.state::<RecentAvatarsState>();
    let list = state
        .list
        .lock()
        .unwrap()
        .iter()
        .map(|p| RecentAvatar {
            path: p.clone(),
            name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            exists: is_vrm_file(p),
            current: loaded.as_ref().is_some_and(|l| same_path(l, p)),
        })
        .collect();
    list
}

/// Quita un avatar de la lista (el archivo no se toca).
#[tauri::command]
pub fn avatar_recent_remove(app: AppHandle, path: PathBuf) {
    let state = app.state::<RecentAvatarsState>();
    state.list.lock().unwrap().retain(|p| !same_path(p, &path));
    state.save();
    let _ = app.emit("recent-avatars-changed", ());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recientes_sin_repetir_y_con_limite() {
        let mut list = Vec::new();
        for i in 0..10 {
            push_front(&mut list, PathBuf::from(format!("C:\\avatares\\a{i}.vrm")));
        }
        assert_eq!(list.len(), MAX_RECENT);
        assert_eq!(list[0], PathBuf::from("C:\\avatares\\a9.vrm"));
        // Volver a cargar uno lo sube al principio sin duplicarlo (aunque cambien mayúsculas).
        push_front(&mut list, PathBuf::from("c:\\AVATARES\\a5.VRM"));
        assert_eq!(list.len(), MAX_RECENT);
        assert_eq!(list[0], PathBuf::from("c:\\AVATARES\\a5.VRM"));
        assert_eq!(list.iter().filter(|p| same_path(p, Path::new("C:\\avatares\\a5.vrm"))).count(), 1);
    }

    #[test]
    fn solo_archivos_vrm_existentes() {
        assert!(!is_vrm_file(Path::new("C:\\no\\existe.vrm")));
        assert!(!is_vrm_file(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml").as_path()));
    }
}
