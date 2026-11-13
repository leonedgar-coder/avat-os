// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Atajos de teclado globales (funcionan aunque avat-os no tenga el foco) y su editor.
// Cada **acción** (una expresión, un gesto, encender el tracking…) puede tener un atajo.
// Los atajos se guardan en `<config>/atajos.json`; lo que falte se completa con los de
// fábrica. Para sumar una acción nueva: agregarla a `ACTIONS`, a `default_binding` y a
// `dispatch` (o manejarla en la interfaz con el evento `shortcut-action`).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::expressions;

const FILE_NAME: &str = "atajos.json";
/// Cada cuánto se reintentan los atajos que fallaron.
const RETRY_EVERY: std::time::Duration = std::time::Duration::from_secs(15);

/// Todas las acciones que admiten atajo, en el orden en que se muestran.
pub const ACTIONS: [&str; 11] = [
    "expression.happy",
    "expression.angry",
    "expression.sad",
    "expression.surprised",
    "expression.relaxed",
    "gesture.wave",
    "gesture.nod",
    "gesture.shake",
    "gesture.shrug",
    "tracking.toggle",
    "lipsync.toggle",
];

/// Atajos de fábrica. Las acciones nuevas (tracking, lip-sync) vienen **sin** atajo: un atajo
/// global le quita la combinación a todos los programas (p. ej. Ctrl+Shift+T a los navegadores).
/// No se usa Ctrl+Alt: en teclados en español equivale a AltGr (AltGr+2 = @).
fn default_binding(action: &str) -> Option<&'static str> {
    Some(match action {
        "expression.happy" => "control+shift+Digit1",
        "expression.angry" => "control+shift+Digit2",
        "expression.sad" => "control+shift+Digit3",
        "expression.surprised" => "control+shift+Digit4",
        "expression.relaxed" => "control+shift+Digit5",
        "gesture.wave" => "control+shift+Digit6",
        "gesture.nod" => "control+shift+Digit7",
        "gesture.shake" => "control+shift+Digit8",
        "gesture.shrug" => "control+shift+Digit9",
        _ => return None,
    })
}

fn defaults() -> BTreeMap<String, Option<Shortcut>> {
    ACTIONS
        .iter()
        .map(|a| (a.to_string(), default_binding(a).and_then(|s| Shortcut::from_str(s).ok())))
        .collect()
}

/**
 * Teclas de símbolos ("OEM"). `global-hotkey` las registra con la tecla virtual que tienen
 * en un teclado de EE. UU. (p. ej. `Backquote` → VK_OEM_3), así que la interfaz guarda el
 * nombre que corresponde a la tecla virtual **real** de la persona (en un teclado
 * latinoamericano la ñ es VK_OEM_3 → `Backquote`); ver ShortcutEditor.svelte.
 */
const OEM_KEYS: [(Code, u32); 11] = [
    (Code::Semicolon, 0xBA),
    (Code::Equal, 0xBB),
    (Code::Comma, 0xBC),
    (Code::Minus, 0xBD),
    (Code::Period, 0xBE),
    (Code::Slash, 0xBF),
    (Code::Backquote, 0xC0),
    (Code::BracketLeft, 0xDB),
    (Code::Backslash, 0xDC),
    (Code::BracketRight, 0xDD),
    (Code::Quote, 0xDE),
];

/// Carácter que escribe una tecla de símbolos en el teclado actual (p. ej. "Ñ"), si se sabe.
#[cfg(windows)]
fn oem_char(code: Code) -> Option<String> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{MapVirtualKeyW, MAPVK_VK_TO_CHAR};
    let vk = OEM_KEYS.iter().find(|(c, _)| *c == code)?.1;
    // SAFETY: función de Windows sin punteros; solo traduce una tecla virtual.
    let ch = unsafe { MapVirtualKeyW(vk, MAPVK_VK_TO_CHAR) } & 0xFFFF; // el bit alto marca las teclas "muertas" (´)
    char::from_u32(ch).filter(|c| !c.is_control()).map(|c| c.to_uppercase().to_string())
}
#[cfg(not(windows))]
fn oem_char(_code: Code) -> Option<String> {
    None
}

/// ¿La puede registrar `global-hotkey`? (su tabla de teclas de Windows; p. ej. la tecla
/// `<` de los teclados en español, `IntlBackslash`, no está).
fn is_supported_key(code: Code) -> bool {
    use Code::*;
    let name = code.to_string();
    name.starts_with("Key")
        || name.starts_with("Digit")
        || name.starts_with("Numpad")
        || is_function_key(code)
        || OEM_KEYS.iter().any(|(c, _)| *c == code)
        || matches!(
            code,
            Backspace | Tab | Space | Enter | Escape | PageUp | PageDown | End | Home | ArrowLeft | ArrowUp
                | ArrowRight | ArrowDown | PrintScreen | Insert | Delete
        )
}

/// Error al leer un atajo (`HotKeyParseError` de `global-hotkey`, que el plugin no reexporta).
type ParseError = <Shortcut as FromStr>::Err;

/// Lee un atajo guardado o capturado. Una tecla que `global-hotkey` no conoce (p. ej. la `<`
/// de los teclados en español, `IntlBackslash`) tiene su propio mensaje.
fn parse(text: &str) -> Result<Shortcut, String> {
    Shortcut::from_str(text).map_err(|e| match e {
        ParseError::UnsupportedKey(_) => "shortcut_unsupported_key".to_string(),
        _ => "shortcut_invalid".to_string(),
    })
}

/// Texto para mostrar: "Ctrl+Shift+1", "Alt+F5", "Ctrl+Num 3", "Ctrl+Shift+Ñ"…
pub fn label(hk: &Shortcut) -> String {
    let mut parts: Vec<String> = Vec::new();
    if hk.mods.contains(Modifiers::CONTROL) {
        parts.push("Ctrl".into());
    }
    if hk.mods.contains(Modifiers::ALT) {
        parts.push("Alt".into());
    }
    if hk.mods.contains(Modifiers::SHIFT) {
        parts.push("Shift".into());
    }
    if hk.mods.contains(Modifiers::SUPER) {
        parts.push("Win".into());
    }
    let key = hk.key.to_string();
    let pretty = if let Some(ch) = oem_char(hk.key) {
        ch
    } else if let Some(d) = key.strip_prefix("Digit") {
        d.to_string()
    } else if let Some(k) = key.strip_prefix("Key") {
        k.to_string()
    } else if let Some(n) = key.strip_prefix("Numpad") {
        format!("Num {n}")
    } else {
        key
    };
    parts.push(pretty);
    parts.join("+")
}

fn is_function_key(code: Code) -> bool {
    use Code::*;
    matches!(
        code,
        F1 | F2 | F3 | F4 | F5 | F6 | F7 | F8 | F9 | F10 | F11 | F12 | F13 | F14 | F15 | F16 | F17 | F18 | F19 | F20 | F21
            | F22 | F23 | F24
    )
}

/// Reglas para que un atajo global no estorbe. Devuelve un código de error (`errors.*`).
fn validate(hk: &Shortcut) -> Result<(), &'static str> {
    use Code::*;
    let m = hk.mods;
    if matches!(
        hk.key,
        ShiftLeft | ShiftRight | ControlLeft | ControlRight | AltLeft | AltRight | MetaLeft | MetaRight
    ) {
        return Err("shortcut_invalid");
    }
    if !is_supported_key(hk.key) {
        return Err("shortcut_unsupported_key");
    }
    if m.contains(Modifiers::SUPER) {
        return Err("shortcut_reserved"); // la tecla Windows es del sistema
    }
    if m.contains(Modifiers::CONTROL) && m.contains(Modifiers::ALT) {
        return Err("shortcut_altgr");
    }
    if !m.intersects(Modifiers::CONTROL | Modifiers::ALT) && !is_function_key(hk.key) {
        // Sin Ctrl ni Alt, una letra o número dejaría de escribirse en todos los programas.
        return Err("shortcut_needs_modifier");
    }
    if m == Modifiers::CONTROL.union(Modifiers::SHIFT) && hk.key == Digit0 {
        return Err("shortcut_reserved_layout"); // Windows: cambiar el idioma del teclado
    }
    let reserved = [
        (Modifiers::ALT, Tab),
        (Modifiers::ALT, F4),
        (Modifiers::ALT, Escape),
        (Modifiers::ALT, Space),
        (Modifiers::CONTROL, Escape),
        (Modifiers::CONTROL.union(Modifiers::SHIFT), Escape),
        (Modifiers::ALT.union(Modifiers::SHIFT), Tab),
    ];
    if reserved.iter().any(|(mods, key)| m == *mods && hk.key == *key) {
        return Err("shortcut_reserved");
    }
    Ok(())
}

/// Archivo `atajos.json`: acción → atajo (`null` = sin atajo).
#[derive(Serialize, Deserialize, Default)]
struct Saved {
    #[serde(default)]
    bindings: BTreeMap<String, Option<String>>,
}

pub struct ShortcutsState {
    bindings: Mutex<BTreeMap<String, Option<Shortcut>>>,
    /// Acciones cuyo atajo no se pudo registrar (otro programa ya lo usa).
    failed: Mutex<Vec<String>>,
    retrying: Mutex<bool>,
    /// Mientras el editor captura una combinación, los atajos se liberan (si no, Windows
    /// se queda la pulsación y la ventana nunca la recibe).
    paused: Mutex<bool>,
    file: Option<PathBuf>,
}

impl ShortcutsState {
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Self {
        let file = app.path().app_config_dir().ok().map(|d| d.join(FILE_NAME));
        let mut bindings = defaults();
        let saved = file
            .as_ref()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|s| serde_json::from_str::<Saved>(&s).ok())
            .unwrap_or_default();
        for (action, value) in saved.bindings {
            if !bindings.contains_key(&action) {
                continue; // acción que ya no existe
            }
            match value {
                None => {
                    bindings.insert(action, None);
                }
                Some(text) => match Shortcut::from_str(&text) {
                    Ok(hk) if validate(&hk).is_ok() => {
                        bindings.insert(action, Some(hk));
                    }
                    _ => log::warn!("Atajo guardado inválido para {action}: {text}; se usa el de fábrica"),
                },
            }
        }
        Self {
            bindings: Mutex::new(bindings),
            failed: Mutex::new(Vec::new()),
            retrying: Mutex::new(false),
            paused: Mutex::new(false),
            file,
        }
    }

    fn save(&self) -> std::io::Result<()> {
        let Some(file) = &self.file else { return Ok(()) };
        let saved = Saved {
            bindings: self
                .bindings
                .lock()
                .unwrap()
                .iter()
                .map(|(a, hk)| (a.clone(), hk.map(|h| h.into_string())))
                .collect(),
        };
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(file, serde_json::to_string_pretty(&saved)?)
    }
}

/// Ejecuta la acción de un atajo.
fn dispatch<R: Runtime>(app: &AppHandle<R>, action: &str) {
    if let Some(name) = action.strip_prefix("expression.") {
        expressions::toggle(app, name);
    } else if let Some(name) = action.strip_prefix("gesture.") {
        expressions::play_gesture(app, name);
    } else {
        // Acciones que maneja la interfaz (encender el tracking, el lip-sync…).
        let _ = app.emit("shortcut-action", action);
    }
}

/// Plugin de atajos globales: busca qué acción tiene el atajo pulsado.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let state = app.state::<ShortcutsState>();
            if *state.paused.lock().unwrap() {
                return;
            }
            let action = state
                .bindings
                .lock()
                .unwrap()
                .iter()
                .find(|(_, hk)| hk.as_ref().is_some_and(|h| h.id() == shortcut.id()))
                .map(|(a, _)| a.clone());
            if let Some(action) = action {
                dispatch(app, &action);
            }
        })
        .build()
}

/// Etiquetas de los atajos que fallaron (para el aviso del panel).
fn failed_labels<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    let state = app.state::<ShortcutsState>();
    let bindings = state.bindings.lock().unwrap();
    state
        .failed
        .lock()
        .unwrap()
        .iter()
        .filter_map(|a| bindings.get(a).copied().flatten().map(|h| label(&h)))
        .collect()
}

/// Registra los atajos que falten. Devuelve cuántos fallaron.
fn try_register<R: Runtime>(app: &AppHandle<R>) -> usize {
    let state = app.state::<ShortcutsState>();
    let mut failed = Vec::new();
    for (action, hk) in state.bindings.lock().unwrap().iter() {
        let Some(hk) = hk else { continue };
        if app.global_shortcut().is_registered(*hk) {
            continue;
        }
        if let Err(e) = app.global_shortcut().register(*hk) {
            log::warn!("No se pudo registrar el atajo {} ({action}): {e}", label(hk));
            failed.push(action.clone());
        }
    }
    let count = failed.len();
    *state.failed.lock().unwrap() = failed;
    let _ = app.emit("shortcuts-status", failed_labels(app));
    count
}

/// Registra los atajos. Los que fallen se avisan en la interfaz y se reintentan solos.
pub fn register_all<R: Runtime>(app: &AppHandle<R>) {
    if try_register(app) == 0 {
        return;
    }
    let state = app.state::<ShortcutsState>();
    let mut retrying = state.retrying.lock().unwrap();
    if *retrying {
        return;
    }
    *retrying = true;
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(RETRY_EVERY);
            if *app.state::<ShortcutsState>().paused.lock().unwrap() {
                continue; // el editor está capturando: no tocar
            }
            if try_register(&app) == 0 {
                log::info!("Todos los atajos quedaron registrados");
                break;
            }
        }
        *app.state::<ShortcutsState>().retrying.lock().unwrap() = false;
    });
}

fn unregister_all<R: Runtime>(app: &AppHandle<R>) {
    for hk in app.state::<ShortcutsState>().bindings.lock().unwrap().values().flatten() {
        if app.global_shortcut().is_registered(*hk) {
            let _ = app.global_shortcut().unregister(*hk);
        }
    }
}

/// Atajo actual de una acción, para mostrar en los botones (`None` = sin atajo).
pub fn label_for<R: Runtime>(app: &AppHandle<R>, action: &str) -> Option<String> {
    app.state::<ShortcutsState>()
        .bindings
        .lock()
        .unwrap()
        .get(action)
        .copied()
        .flatten()
        .map(|h| label(&h))
}

#[derive(Serialize)]
pub struct ShortcutInfo {
    action: String,
    /// Formato guardado (`control+shift+Digit1`) o `null`.
    binding: Option<String>,
    /// Para mostrar (`Ctrl+Shift+1`) o `null`.
    label: Option<String>,
    /// No se pudo registrar (otro programa lo usa).
    failed: bool,
}

/// Todas las acciones con su atajo.
#[tauri::command]
pub fn shortcuts_get(state: tauri::State<'_, ShortcutsState>) -> Vec<ShortcutInfo> {
    let bindings = state.bindings.lock().unwrap();
    let failed = state.failed.lock().unwrap();
    ACTIONS
        .iter()
        .map(|a| {
            let hk = bindings.get(*a).copied().flatten();
            ShortcutInfo {
                action: a.to_string(),
                binding: hk.map(|h| h.into_string()),
                label: hk.map(|h| label(&h)),
                failed: failed.iter().any(|f| f == a),
            }
        })
        .collect()
}

/// Cambia (o quita, con `null`) el atajo de una acción.
/// Errores: `shortcut_unknown_action`, `shortcut_invalid`, `shortcut_needs_modifier`,
/// `shortcut_altgr`, `shortcut_reserved`, `shortcut_duplicate: <acción>`, `shortcut_taken`.
#[tauri::command]
pub fn shortcuts_set(app: AppHandle, action: String, binding: Option<String>) -> Result<(), String> {
    if !ACTIONS.contains(&action.as_str()) {
        return Err(format!("shortcut_unknown_action: {action}"));
    }
    let new = match &binding {
        None => None,
        Some(text) => {
            let hk = parse(text)?;
            validate(&hk)?;
            Some(hk)
        }
    };
    let state = app.state::<ShortcutsState>();
    if let Some(hk) = new {
        let bindings = state.bindings.lock().unwrap();
        if let Some((other, _)) = bindings.iter().find(|(a, h)| **a != action && h.is_some_and(|h| h.id() == hk.id())) {
            return Err(format!("shortcut_duplicate: {other}"));
        }
    }
    let old = state.bindings.lock().unwrap().get(&action).copied().flatten();
    let paused = *state.paused.lock().unwrap();
    if paused {
        // El editor guarda en pausa (todos los nuestros están liberados): probar la
        // combinación ahora, así un "otro programa la usa" se avisa en el momento.
        if let Some(hk) = new {
            if app.global_shortcut().register(hk).is_err() {
                return Err("shortcut_taken".into());
            }
            let _ = app.global_shortcut().unregister(hk);
        }
    } else {
        if let Some(old) = old {
            if app.global_shortcut().is_registered(old) {
                let _ = app.global_shortcut().unregister(old);
            }
        }
        if let Some(hk) = new {
            if app.global_shortcut().register(hk).is_err() {
                // Otro programa ya la usa: dejar el atajo anterior como estaba.
                if let Some(old) = old {
                    let _ = app.global_shortcut().register(old);
                }
                return Err("shortcut_taken".into());
            }
        }
    }
    state.bindings.lock().unwrap().insert(action.clone(), new);
    state.failed.lock().unwrap().retain(|a| *a != action);
    state.save().map_err(|e| format!("internal: {e}"))?;
    let _ = app.emit("shortcuts-changed", ());
    let _ = app.emit("shortcuts-status", failed_labels(&app));
    Ok(())
}

/// Vuelve a los atajos de fábrica.
#[tauri::command]
pub fn shortcuts_reset(app: AppHandle) -> Result<(), String> {
    unregister_all(&app);
    let state = app.state::<ShortcutsState>();
    *state.bindings.lock().unwrap() = defaults();
    state.save().map_err(|e| format!("internal: {e}"))?;
    if !*state.paused.lock().unwrap() {
        register_all(&app);
    }
    let _ = app.emit("shortcuts-changed", ());
    Ok(())
}

/// El editor captura una combinación: liberar los atajos (`true`) y volver a registrarlos (`false`).
#[tauri::command]
pub fn shortcuts_pause(app: AppHandle, paused: bool) {
    *app.state::<ShortcutsState>().paused.lock().unwrap() = paused;
    if paused {
        unregister_all(&app);
    } else {
        register_all(&app);
    }
}

/// Etiquetas de los atajos que no se pudieron registrar (vacío = todos funcionan).
#[tauri::command]
pub fn shortcuts_status(app: AppHandle) -> Vec<String> {
    failed_labels(&app)
}

/// Reintentar ahora (botón del panel). Devuelve los que siguen fallando.
#[tauri::command]
pub fn shortcuts_retry(app: AppHandle) -> Vec<String> {
    if try_register(&app) > 0 {
        register_all(&app); // asegura el reintento automático
    }
    failed_labels(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hk(s: &str) -> Shortcut {
        Shortcut::from_str(s).unwrap()
    }

    #[test]
    fn atajos_de_fabrica_validos_y_sin_repetir() {
        let d = defaults();
        let ids: Vec<u32> = d.values().flatten().map(|h| h.id()).collect();
        assert_eq!(ids.len(), 9);
        let mut unique = ids.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), ids.len());
        assert!(d.values().flatten().all(|h| validate(h).is_ok()));
    }

    #[test]
    fn reglas_de_validacion() {
        assert_eq!(validate(&hk("control+shift+KeyA")), Ok(()));
        assert_eq!(validate(&hk("alt+Digit1")), Ok(()));
        assert_eq!(validate(&hk("F9")), Ok(())); // tecla de función sola
        assert_eq!(validate(&hk("shift+KeyA")), Err("shortcut_needs_modifier"));
        assert_eq!(validate(&hk("KeyA")), Err("shortcut_needs_modifier"));
        assert_eq!(validate(&hk("control+alt+Digit2")), Err("shortcut_altgr"));
        assert_eq!(validate(&hk("super+KeyD")), Err("shortcut_reserved"));
        assert_eq!(validate(&hk("alt+F4")), Err("shortcut_reserved"));
        assert_eq!(validate(&hk("control+shift+Escape")), Err("shortcut_reserved"));
        assert_eq!(validate(&hk("control+shift+Digit0")), Err("shortcut_reserved_layout"));
        assert_eq!(parse("control+shift+IntlBackslash").err().as_deref(), Some("shortcut_unsupported_key"));
        assert_eq!(parse("control+shift+Nada").err().as_deref(), Some("shortcut_unsupported_key"));
        assert_eq!(parse("control+shift+").err().as_deref(), Some("shortcut_invalid"));
        assert_eq!(validate(&hk("control+shift+Backquote")), Ok(())); // la ñ en un teclado latinoamericano
        assert_eq!(validate(&hk("alt+Semicolon")), Ok(()));
    }

    #[test]
    fn etiquetas_legibles() {
        assert_eq!(label(&hk("control+shift+Digit1")), "Ctrl+Shift+1");
        assert_eq!(label(&hk("alt+KeyT")), "Alt+T");
        assert_eq!(label(&hk("control+Numpad3")), "Ctrl+Num 3");
        assert_eq!(label(&hk("F9")), "F9");
        // Teclas de símbolos: el carácter del teclado actual (en uno latinoamericano, "Ñ").
        let oem = label(&hk("control+shift+Backquote"));
        assert!(oem.starts_with("Ctrl+Shift+") && oem.len() > "Ctrl+Shift+".len(), "{oem}");
        assert!(!oem.contains("Backquote") || !cfg!(windows), "{oem}");
    }

    #[test]
    fn el_formato_guardado_se_vuelve_a_leer() {
        let h = hk("control+shift+Digit6");
        assert_eq!(Shortcut::from_str(&h.into_string()).unwrap().id(), h.id());
    }
}
