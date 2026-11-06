// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Ícono grande de la ventana (el que usa la barra de tareas de Windows).
// Tauri solo asigna el ícono pequeño (barra de título); sin el grande, Windows
// toma el del .exe a través de su caché de íconos, que con las recompilaciones de
// `tauri dev` puede quedarse con uno genérico. Aquí se carga el ícono incrustado en
// el propio .exe (recurso 32512, el que genera tauri-build desde icons/icon.ico).

/// Asigna el ícono grande (`WM_SETICON` / `ICON_BIG`) a la ventana. Si algo falla,
/// solo se registra en el log: la ventana sigue funcionando con el ícono de Windows.
#[cfg(windows)]
pub fn set_taskbar_icon(window: &tauri::WebviewWindow) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, ICON_BIG, IMAGE_ICON, LR_DEFAULTCOLOR, LoadImageW, SM_CXICON, SM_CYICON,
        SendMessageW, WM_SETICON,
    };

    /// Identificador del ícono principal que incrusta tauri-build en el .exe.
    const APP_ICON_ID: u16 = 32512;

    let hwnd = match window.window_handle().map(|h| h.as_raw()) {
        Ok(RawWindowHandle::Win32(h)) => h.hwnd.get() as *mut core::ffi::c_void,
        _ => {
            log::warn!("No se pudo obtener la ventana para asignar el ícono de la barra de tareas");
            return;
        }
    };
    // SAFETY: llamadas a la API de Windows con un HWND vivo (la ventana principal) y el
    // módulo del propio proceso. `APP_ICON_ID as *const u16` es MAKEINTRESOURCE: Windows
    // interpreta un puntero menor que 0x10000 como identificador numérico de recurso.
    unsafe {
        let module = GetModuleHandleW(core::ptr::null());
        let icon = LoadImageW(
            module,
            APP_ICON_ID as usize as *const u16,
            IMAGE_ICON,
            GetSystemMetrics(SM_CXICON),
            GetSystemMetrics(SM_CYICON),
            LR_DEFAULTCOLOR,
        );
        if icon.is_null() {
            log::warn!("No se encontró el ícono de la app en el ejecutable");
            return;
        }
        SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, icon as isize);
    }
}

#[cfg(not(windows))]
pub fn set_taskbar_icon(_window: &tauri::WebviewWindow) {}
