# Guía del programador de avat-os

> **Versión:** 0.1.0 · **Estado:** Fase 0 completada, Fase 1 en curso ([plan](../tareas.md)).
> Este documento se actualiza en el mismo cambio que modifica el código. Si encuentras algo desfasado, corrígelo en tu PR.

avat-os es una aplicación de escritorio **open source (GPL-3.0-or-later)** que combina un avatar 3D controlado por la cara (tipo Animaze) con un motor de producción de video (tipo OBS).

---

## Contenido

1. [Stack tecnológico](#1-stack-tecnológico)
2. [Arquitectura](#2-arquitectura)
3. [Preparar el entorno](#3-preparar-el-entorno)
4. [Estructura del repositorio](#4-estructura-del-repositorio)
5. [Módulos en detalle](#5-módulos-en-detalle)
6. [Protocolos internos](#6-protocolos-internos)
7. [Parámetros ajustables](#7-parámetros-ajustables)
8. [Seguridad y privacidad](#8-seguridad-y-privacidad)
9. [Pruebas y verificación](#9-pruebas-y-verificación)
10. [Licencias y dependencias](#10-licencias-y-dependencias)
11. [Convenciones](#11-convenciones)
12. [Problemas conocidos](#12-problemas-conocidos)
13. [Registro de decisiones](#13-registro-de-decisiones)

---

## 1. Stack tecnológico

| Capa | Tecnología | Versión |
|---|---|---|
| Aplicación de escritorio | [Tauri](https://tauri.app/) (Rust + WebView2) | 2.x |
| Backend | Rust (edición 2024) | rustc 1.94 |
| Interfaz | [SvelteKit](https://svelte.dev/) + Svelte 5 (runas) + TypeScript, `adapter-static` (SPA, sin SSR) | Kit 2 · Svelte 5.56 · TS 6 |
| Bundler | Vite | 8 |
| Motor de video/audio | **libobs** (núcleo de OBS Studio) vía [`libobs-wrapper`](https://github.com/libobs-rs/libobs-rs) / `libobs-simple` | wrapper 10 · simple 9 · OBS 32.1.2 |
| Render del avatar | [three.js](https://threejs.org/) + [`@pixiv/three-vrm`](https://github.com/pixiv/three-vrm), dentro de la fuente de navegador de OBS (obs-browser, CEF 127) | three 0.187 · three-vrm 3.5.5 |
| Tracking facial | [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) (`@mediapipe/tasks-vision`, WASM + GPU) | 1.2.2 |
| Servidor local | `tiny_http` (HTTP) · `tungstenite` (WebSocket) | 0.12 · 0.30 |
| Atajos globales | `tauri-plugin-global-shortcut` | 2.4 |
| Plataforma | Windows 10/11 x64 (oficial). Linux: código portable, sin soporte oficial | |

---

## 2. Arquitectura

```
┌──────────────────────── Interfaz (WebView2 · SvelteKit) ─────────────────────────┐
│  src/routes/+page.svelte   escenas, fuentes, mezclador, panel del avatar          │
│  src/lib/tracking.ts       webcam → MediaPipe → TrackingFrame (30 Hz)             │
│  src/lib/lipsync.ts        micrófono → volumen → nivel 0–1 (30 Hz)                │
│  src/lib/vowels.ts         audio → formantes (LPC) → peso de A, I, U, E, O         │
└──────────────┬───────────────────────────────────────────────────────────────────┘
               │ invoke(): preview_set_bounds · avatar_load · tracking_update · …
┌──────────────▼──────────────────────── Núcleo Rust (src-tauri) ──────────────────┐
│  lib.rs              arranque, comandos Tauri, cierre                              │
│  expressions.rs      emociones y gestos del avatar                                 │
│  shortcuts.rs        atajos globales por acción + editor (atajos.json)             │
│  calibration.rs      calibración de la persona (guardada en calibracion.json)      │
│  background.rs       fondo del avatar: transparente / color / imagen (fondo.json)  │
│  effects.rs          cámara, luz y contorno del avatar (efectos.json)              │
│  obs.rs              libobs: escena, fuentes, vista previa (ventana nativa hija)   │
│  recent_avatars.rs   avatares recientes; el último se carga al arrancar            │
│  avatar_server.rs    HTTP 127.0.0.1:<aleatorio> → avatar/dist + /model.vrm         │
│  tracking_relay.rs   WebSocket 127.0.0.1:<aleatorio> → mensajes tracking/expression│
└──────────────┬──────────────────────────────────────┬────────────────────────────┘
               │ libobs (C)                           │ ws://  (mensajes JSON)
┌──────────────▼──────────────────────────┐   ┌───────▼──────────────────────────────┐
│ Escena "Escena principal"               │   │ avatar/main.ts (en obs-browser/CEF)  │
│  ├─ Pantalla  (monitor_capture, DXGI)   │◄──┤ three-vrm: carga /model.vrm, aplica  │
│  └─ Avatar    (browser_source 1920×1080)│   │ tracking, idle, render transparente  │
│ Vista previa → HWND hijo sobre la web   │   └──────────────────────────────────────┘
└─────────────────────────────────────────┘
```

### Flujo de un cuadro de tracking

1. `FaceTracker.loop()` (rAF) llama a `FaceLandmarker.detectForVideo()` con el cuadro de la webcam (640×480).
2. `toFrame()` convierte 52 *blendshapes* + matriz 4×4 en un `TrackingFrame` (ángulos en radianes, posición en cm).
3. Como máximo cada 33 ms la interfaz hace `invoke("tracking_update", { frame })`.
4. `tracking_update` (Rust) lo envuelve como `{type:"tracking", avatar:"main", frame}` y lo envía a todos los clientes WebSocket.
5. `avatar/main.ts` lo recibe, lo suaviza (`applyTracking`) y lo aplica a huesos y expresiones VRM.
6. obs-browser renderiza la página (30 FPS, fondo transparente) como fuente de la escena; libobs compone y muestra la vista previa.

### Reglas de diseño

- **Todo local:** ningún dato de cámara, avatar o tracking sale del equipo. Los servidores escuchan solo en `127.0.0.1` y validan la cabecera `Host`.
- **Varios avatares (N):** aunque la v1 usa uno, el diseño debe soportar N (*modo dúo*): cada fuente Avatar tendrá un id y cada mensaje (tracking, expresiones, lip-sync) llevará el id de destino. **No introducir estado global de "el avatar".**
- **El avatar es una fuente más** de libobs: se transforma, filtra y ordena igual que cualquier otra.
- **La interfaz no bloquea:** si libobs falla al iniciar, la app sigue abierta (`obs_status() == false`) y muestra el aviso.

---

## 3. Preparar el entorno

### Requisitos

| Herramienta | Versión probada |
|---|---|
| Windows | 11 (x64) |
| Rust (rustup) | 1.94 |
| Node.js | 24 (mínimo 20) |
| Visual Studio Build Tools | 2026, carga de trabajo "Desarrollo de escritorio con C++" |
| WebView2 Runtime | incluido en Windows 11 |
| Git | 2.5x |

### Primer arranque

```sh
npm install
npm run tauri dev
```

`tauri dev` ejecuta, en orden (`beforeDevCommand` en `src-tauri/tauri.conf.json`):

1. `npm run fetch:tracking` → copia el WASM de MediaPipe y descarga `face_landmarker.task` (verificado por SHA-256) a `static/mediapipe/`.
2. `npm run build:avatar` → compila `avatar/` a `avatar/dist/`.
3. `npm run dev` → servidor Vite de la interfaz en `http://localhost:1420`.
4. `cargo run` → `build.rs` descarga los binarios de OBS 32.1.2 (con obs-browser) a `src-tauri/target/<perfil>/` y repone las DLL que necesita obs-browser.

> ⏱️ **La primera compilación tarda ~30–40 min** (descarga de OBS ~350 MB + compilación de libobs-rs). Las siguientes, 3–8 min.
> La caché de OBS queda en `obs-build/` (ignorada por git) y se comparte con `spikes/obs-record`.

### Scripts

| Comando | Qué hace |
|---|---|
| `npm run tauri dev` | App en modo desarrollo (recarga la interfaz en caliente) |
| `npm run tauri build` | Compila la versión de producción (el instalador aún no está listo, ver Fase 6) |
| `npm run check` | `svelte-check` (tipos de la interfaz) |
| `npm run build:avatar` | Recompila solo la página del avatar |
| `npm run fetch:tracking` | Prepara los archivos de MediaPipe |
| `cargo build` (en `src-tauri/`) | Compila solo el backend |

### Variables de entorno de desarrollo

| Variable | Efecto |
|---|---|
| `AVATOS_VRM=C:\ruta\avatar.vrm` | Carga ese avatar al arrancar (sin usar el diálogo) |
| `RUST_LOG=debug` | Log más detallado (por defecto `info`) |

---

## 4. Estructura del repositorio

```
avat-os/
├── assets/logo.svg              Logo vectorial (README, guías; de aquí salen los iconos)
├── assets/logo.png              Logo original en imagen (fuente del SVG)
├── avatar/                      Página del avatar (la carga OBS como fuente de navegador)
│   ├── index.html
│   ├── main.ts                  three-vrm: carga, idle, tracking, render
│   └── vite.config.js           → avatar/dist/ (ignorado)
├── docs/                        Documentación (esta guía y la de usuario)
├── recursos/                    Archivos de prueba del usuario (avatares, fondos, objetos)
│                                → solo los LEEME.md están en git
├── scripts/fetch-tracking.mjs   Descarga/copia de MediaPipe a static/mediapipe/
├── spikes/obs-record/           Prueba aislada de libobs (graba 5 s a MP4)
├── src/                         Interfaz SvelteKit
│   ├── app.html
│   ├── lib/tracking.ts          FaceTracker (MediaPipe) y TrackingFrame
│   ├── lib/lipsync.ts           Lip-sync: micrófono → nivel de voz
│   ├── lib/vowels.ts            Reconocimiento de vocales (formantes)
│   ├── lib/VowelCalibration.svelte Calibración de vocales por persona
│   ├── lib/tooltip.ts           Tooltips accesibles (use:tooltip)
│   ├── lib/rememberOpen.ts      Desplegables que recuerdan si quedaron abiertos
│   ├── lib/Calibration.svelte   Asistente de calibración (3 pasos)
│   ├── lib/ShortcutEditor.svelte Editor de atajos
│   ├── lib/i18n/                Idiomas: index.svelte.ts (t, tError, i18n) + es.json, en.json
│   └── routes/+page.svelte      Pantalla principal
├── src-tauri/                   Backend Rust
│   ├── build.rs                 Descarga OBS + repone DLL de obs-browser
│   ├── capabilities/default.json  Permisos de la ventana (core, opener, dialog:allow-open)
│   ├── tauri.conf.json          Ventana, comandos previos, argumentos de WebView2
│   └── src/
│       ├── main.rs              Punto de entrada (llama a lib::run)
│       ├── lib.rs               Builder de Tauri, comandos, cierre
│       ├── obs.rs               Motor libobs y vista previa
│       ├── recent_avatars.rs    Avatares recientes
│       ├── avatar_server.rs     Servidor HTTP local del avatar
│       ├── background.rs        Fondo del avatar (transparente, color o imagen)
│       ├── calibration.rs       Calibración (umbrales y postura de frente)
│       ├── effects.rs           Efectos: cámara, luz y contorno
│       ├── expressions.rs       Emociones VRM y gestos
│       ├── shortcuts.rs         Atajos globales y su editor
│       ├── tracking_relay.rs    WebSocket local (tracking + expresiones)
│       └── win_icon.rs          Ícono grande de la ventana (barra de tareas)
├── static/                      Archivos estáticos de la interfaz (logo, mediapipe/ ignorado)
├── tareas.md                    Plan de trabajo por fases
└── LICENSE                      GPL-3.0
```

---

## 5. Módulos en detalle

### `src-tauri/src/lib.rs` — arranque

- **Instancia única** (`tauri-plugin-single-instance`, el primer plugin): una segunda copia no arranca y trae al frente la ventana de la primera. Dos copias pelearían por los atajos globales, la cámara y el motor de OBS. Mientras la primera se cierra (`CLOSING`: la ventana ya está oculta y OBS tarda unos segundos en apagarse), el pedido se ignora: si no, la ventana reaparecería un instante sin vista previa. Prueba en la app real: abrir otra copia con la app abierta (se cierra sola, log *se trae al frente esta*) y abrir otra 0,3 s después de cerrar (log *mientras se cerraba: se ignora*; no queda ninguna copia abierta).
- **Para las pruebas automáticas:** con avat-os abierto por el usuario, una copia de prueba **no arranca** (y eso protege su sesión); hay que pedirle que la cierre o probar sin la app.

### `src-tauri/src/obs.rs` — motor de video

- `Obs::start(window, config_dir, tracking_port, initial_avatar)`:
  - Arranca libobs con lienzo `CANVAS_WIDTH × CANVAS_HEIGHT` (1920×1080) y `module_config_path` en `%APPDATA%\com.avatos.app\obs` (para que los plugins no escriban en el directorio de trabajo).
  - Crea la escena de prueba: captura del monitor principal (DXGI) + fuente `browser_source` "Avatar" apuntando a `AvatarServer::url()`. Si hay `initial_avatar` (`AVATOS_VRM` o el último reciente que exista), el modelo se fija **antes** de crear la fuente y la URL ya es la versión 1: la página carga una sola vez (antes cargaba vacía y se recargaba con el modelo).
  - Crea la vista previa con `ObsDisplayCreationData` sobre el HWND de la ventana principal. libobs-wrapper crea una **ventana nativa hija** (`WS_CHILD`) encima del WebView2.
- `set_bounds()`: la interfaz envía la posición del recuadro "Vista previa" en **píxeles físicos** (CSS × `devicePixelRatio`) mediante un `ResizeObserver`.
- **Orden de liberación:** `context` es el **último** campo del struct; Rust libera en orden de declaración y libobs debe apagarse después de soltar la vista previa y las fuentes.
- Estado compartido: `ObsState(Mutex<Option<Obs>>)`; `None` si libobs no arrancó o la app se está cerrando.

- `avatar_load` valida el archivo, recarga la página (sube `avatar_version`) y lo anota en los recientes (`recent_avatars::remember`, después de soltar el lock de OBS).

### `src-tauri/src/recent_avatars.rs` — avatares recientes

- `<config>/avatares-recientes.json` (`{"avatars": [ruta, …]}`), del más nuevo al más viejo, hasta `MAX_RECENT` (8). Se lee en `setup` **antes** de `obs::init`; un archivo dañado se toma como lista vacía.
- `push_front`: sin repetir, comparando rutas **sin distinguir mayúsculas** (Windows). `last_existing()` da el primero que todavía existe (`is_vrm_file`).
- Comandos `avatar_recent` (`{ path, name, exists }[]`) y `avatar_recent_remove(path)` (no borra el archivo); evento `recent-avatars-changed`. En la interfaz, desplegable **Avatares recientes**: el primero, si coincide con el nombre cargado, es *en uso*; los que no existen van tachados y deshabilitados.
- Pruebas: `cargo test --lib recent_avatars`.

### `src-tauri/src/avatar_server.rs` — servidor HTTP local

- Escucha en `127.0.0.1:0` (puerto aleatorio), un hilo `avatar-server`.
- Rutas: `/background` → fondo elegido (imagen o video; `serve_background` acepta **un** rango de bytes `Range: bytes=…` → 206 con `Content-Range`, y responde `Accept-Ranges: bytes`: el `<video>` pide por partes para el bucle y para saltar; rango fuera del archivo → 416; varios rangos → archivo entero); `/model.vrm` → archivo elegido por el usuario; cualquier otra → archivos de `avatar/dist/` (con `canonicalize` + `starts_with` para impedir `../`).
- Rechaza (404) peticiones cuyo `Host` no sea exactamente `127.0.0.1:<puerto>` (anti *DNS rebinding*) y métodos distintos de GET.
- `/background` (GET, mismo control de `Host`): **solo** la imagen elegida, y solo si su extensión es PNG, JPG/JPEG, WebP o GIF (`background_mime()`).
- `/status?state=loading|loaded|error&detail=…` (GET, mismo control de `Host`): la página informa su estado; `parse_status()` solo acepta esos tres estados y recorta el detalle a 300 caracteres. `obs.rs` lo guarda en `AvatarStatusState`, lo registra en el log (`Avatar listo…` / `El avatar no se pudo cargar…`) y emite el evento `avatar-status`. Prueba unitaria: `cargo test --lib avatar_server`.
- URL de la fuente: `http://127.0.0.1:<puerto>/?v=<versión>&ws=<puerto_tracking>&id=<avatar>`; `v` cambia al cargar otro avatar para forzar la recarga; `id` es el identificador del avatar (hoy `main`).

### `src-tauri/src/tracking_relay.rs` — canal en vivo (WebSocket)

- Escucha en `127.0.0.1:0`, hilo `tracking-relay`. Valida `Host` en el *handshake* (403 si no coincide).
- Tiempos límite por socket: lectura 2 s (handshake), escritura 100 ms. Un cliente que no lee se desconecta y la página se reconecta sola en 1 s.
- `broadcast()` envía el JSON a todos los clientes y descarta los cerrados.
- `set_sticky(clave, json)`: como `broadcast`, pero guarda el último mensaje de esa clave y lo **reenvía a cada página que se conecta** (así la expresión activa sobrevive a la recarga de la página al cambiar de avatar). Orden de bloqueo: `clients` → `sticky`, igual en ambos sitios para evitar interbloqueos.

### `src-tauri/src/expressions.rs` — expresiones y gestos

- Tablas `EXPRESSIONS` (`happy`, `angry`, `sad`, `surprised`, `relaxed`) y `GESTURES` (`wave`, `nod`, `shake`, `shrug`).
- En la interfaz, los botones van en el desplegable **Expresiones y gestos** (`<details class="expressions">` en `+page.svelte`); el aviso de atajos que fallaron queda fuera para verse aunque esté cerrado.
- Los atajos ya **no** están aquí: ver `shortcuts.rs`. `toggle()` y `play_gesture()` son públicas para que los atajos las llamen; `expression_list` / `gesture_list` devuelven el atajo actual (o `null`).

### `src-tauri/src/shortcuts.rs` — atajos globales y editor

- **Acciones** (`ACTIONS`): `expression.*`, `gesture.*`, `tracking.toggle`, `lipsync.toggle`. `default_binding()` da los de fábrica (expresiones Ctrl+Shift+1…5, gestos 6…9; tracking y lip-sync **sin atajo** para no robarle combinaciones comunes a otros programas). `dispatch()` ejecuta una acción; las que maneja la interfaz se emiten como evento `shortcut-action`. **Para sumar una acción:** agregarla a `ACTIONS`, `default_binding`, `dispatch` (o al manejador de `shortcut-action` en la interfaz) y su nombre en el editor.
- **Formato:** el de `global-hotkey` (`control+shift+Digit1`), que usa los mismos nombres de tecla que `KeyboardEvent.code`. `label()` lo convierte en "Ctrl+Shift+1". Se guarda en `<config>/atajos.json` (`{"bindings": {acción: atajo | null}}`): lo que falta se completa con los de fábrica; atajos inválidos o acciones desconocidas se ignoran (con aviso en el log).
- **Teclados que no son de EE. UU.:** `global-hotkey` registra letras y símbolos con la tecla virtual de un teclado de EE. UU. (tabla fija: `Backquote` → VK_OEM_3, etc.). En un teclado latinoamericano la ñ está en la posición de `Semicolon` pero su tecla virtual es VK_OEM_3: con `KeyboardEvent.code` el atajo quedaba en otra tecla y no funcionaba. Por eso el editor (`hotkeyCode()`) usa `keyCode` (la tecla virtual real de Windows con la distribución de la persona) y guarda el nombre que `global-hotkey` asocia a esa tecla virtual (ñ → `Backquote`; también letras en AZERTY). `label()` muestra el carácter real con `MapVirtualKeyW(vk, MAPVK_VK_TO_CHAR)` ("Ctrl+Shift+Ñ"; el bit alto marca teclas muertas como ´). Teclas que `global-hotkey` no conoce (p. ej. `IntlBackslash`, la `<` de los teclados en español) → `shortcut_unsupported_key` (al leer, `parse()`, o al validar, `is_supported_key`). Probado en la app real con teclado es-MX: con `control+shift+Backquote` guardado, `RegisterHotKey(Ctrl+Shift, VK_OEM_3)` desde fuera falla con 1409 (avat-os tiene Ctrl+Shift+ñ).
- **`validate()`:** exige Ctrl o Alt (o una tecla F1–F24); rechaza Ctrl+Alt (= AltGr), la tecla Windows, las teclas modificadoras solas, teclas no soportadas, Ctrl+Shift+0 (`shortcut_reserved_layout`: Windows cambia el idioma del teclado) y combinaciones de Windows (Alt+Tab, Alt+F4, Ctrl+Shift+Esc…). `shortcuts_set` además rechaza duplicados (`shortcut_duplicate: <acción>`) y, si otro programa la usa, deja el atajo anterior (`shortcut_taken`); en pausa (el editor siempre guarda así) lo comprueba registrando y liberando la combinación al momento.
- **Combinaciones que Windows se queda antes de la ventana** (p. ej. Ctrl+Shift+0 cuando es el atajo de idioma del teclado, `HKCU\Control Panel\Input Method\Hot Keys`): el `keydown` de la tecla principal no llega al WebView, así que `validate()` nunca se ejecuta. `ShortcutEditor.svelte` lo detecta: si se sueltan todos los modificadores sin que llegue ninguna tecla, muestra `shortcutsEditor.swallowed`; y si llega solo el `keyup` de una tecla (con modificadores) que no se vio presionar, la toma como la tecla. Sin modificadores no se usa el `keyup` (sería el Enter/Espacio que abrió la captura).
- **Captura en el editor:** `shortcuts_pause(true)` libera todos los atajos mientras se espera la combinación (si no, Windows se queda las ya registradas y la ventana no recibe la pulsación) y `shortcuts_pause(false)` los vuelve a registrar; el reintento automático no actúa en pausa. Cancela con Esc o a los 10 s.
- Eventos: `shortcuts-changed` (cambió algún atajo: la interfaz recarga etiquetas), `shortcuts-status`, `shortcut-action`.
- Pruebas: `cargo test --lib shortcuts` (fábrica válida y sin repetir, reglas de validación, etiquetas, formato guardado).
- **Registro de atajos:** `try_register()` registra los que falten y guarda en `ShortcutStatus` los que fallaron (otro programa u otra copia ya los tiene); emite `shortcuts-status` y, si falta alguno, un hilo reintenta cada `RETRY_EVERY` (15 s) hasta lograrlo. Comandos `shortcuts_status` / `shortcuts_retry`; la interfaz muestra un aviso con **Reintentar**. Antes el fallo solo quedaba en el log: una copia de prueba abierta dejó al usuario sin atajos sin ningún aviso.
- **Gestos:** tabla `GESTURES` (`wave`, `nod`, `shake`, `shrug` con `Ctrl+Shift+6…9`), en el mismo plugin de atajos. `play_gesture()` envía `{type:"gesture"}` con `broadcast` (**no** pegajoso: es momentáneo) y emite `gesture-played`. Comandos `gesture_list` / `gesture_play` (error `gesture_unknown`).
- `toggle()`: pulsar la expresión activa vuelve a neutral; lee y cambia el estado con un solo bloqueo (un atajo y un botón simultáneos no se pisan). `notify()` envía el resultado; `apply()` guarda el estado (`ExpressionState`), envía `{type:"expression"}` con `set_sticky("expression:<avatar>")` y emite el evento `expression-changed` a la interfaz.
- Los botones del panel llaman a `expression_set`; la interfaz escucha `expression-changed` para reflejar también los atajos.

### `src/lib/tracking.ts` — tracking facial

- `FaceTracker.start()`: crea el `FaceLandmarker` (GPU, con *fallback* a CPU), abre la webcam (640×480, 30 fps ideal).
- `loop()`: un `detectForVideo` por cuadro nuevo; envía como máximo cada `SEND_INTERVAL_MS` (33 ms).
- `toFrame()`: descompone la matriz (`Matrix4.decompose`) para separar rotación de escala; Euler en orden `YXZ`. Mirada: horizontal = (`eyeLookOutLeft` + `eyeLookInRight` − `eyeLookInLeft` − `eyeLookOutRight`) / 2; vertical = (arriba − abajo de los dos ojos) / 2.
- `onStats()` (1 Hz): FPS, cara detectada y último cuadro (el panel muestra boca y ojos para calibrar).
- WebView2 se lanza con `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows` (`additionalBrowserArgs` en `tauri.conf.json`) para que el tracking no se pause si la ventana queda tapada.

### `src-tauri/src/calibration.rs` + `src/lib/Calibration.svelte` — calibración

- **Asistente (interfaz):** cada paso espera a que la persona pulse **Empezar** (`waitForGo()`; antes seguían solos y no se alcanzaba a leer la instrucción) y el botón se desactiva si la cámara no ve la cara. Luego, 3 capturas de `REACTION_MS + CAPTURE_MS` (0,4 + 1,5 s; los primeros 0,4 s se descartan como tiempo de reacción) tras una cuenta atrás de 3 s: de frente → ojos cerrados (entre dos pitidos de `AudioContext`, porque la persona no ve la pantalla) → boca abierta. Recibe los cuadros con `subscribe()` (`frameListeners` de `+page.svelte`).
- **Margen mínimo de los ojos** (`EYE_MARGIN` = 0,03): el punto donde el ojo empieza a cerrarse queda al menos 0,03 por encima del ojo abierto medido, y el cierre total al menos 0,03 más arriba. Con un rango estrecho (una calibración real: abierto 0,176, cerrado 0,268) el 25 % del rango quedaba a solo 0,02 del ojo abierto y el ruido de la cámara lo cruzaba.
- **Medidas (`Levels`):** **cada ojo por separado**: abierto = percentil 90 del paso 1, cerrado = mediana del paso 2 (`eyeOpen`/`eyeClosed` = ojo izquierdo, `blinkLeft`; `eyeRight` = [abierto, cerrado] del derecho); el paso vale si el **promedio** de los dos ojos cambia claramente más que su temblor: al menos `NOISE_FACTOR` (4) veces el desvío robusto del valor con los ojos abiertos en el paso 1 (`robustSigma`: mediana de las desviaciones × 1,4826, para que un pestañeo suelto no lo infle; mínimo `NOISE_FLOOR` 0,002), y nunca menos de `MIN_EYE_DIFF` (0,03). Antes era un 0,08 fijo: a personas cuyo "parpadeo" de MediaPipe cambia poco (p. ej. 0,18 → 0,27) les fallaba aunque cerraran bien los ojos, y con una señal limpia una diferencia chica sí se distingue. Si falla, el error muestra los números de cada ojo, el promedio, lo que se necesitaba y el temblor: se guarda como `{ code: "calibration_eyes", numbers }` y el texto se arma **al mostrarlo** (`errorText()`), así cambia de idioma completo si se cambia el idioma con el mensaje a la vista. El aviso de señal pequeña (menos de `SMALL_EYE_SIGNAL`, 0,06, en promedio) se **deriva de las medidas** (`levels`), así también aparece al abrir directo en "Prueba y ajuste" con una calibración guardada. Un ojo que cambia menos que `max(MIN_EYE_RANGE 0,02, 4 × su temblor)` usa el promedio de los dos. El temblor de cada ojo se guarda (`levels.eyeNoise`) y el margen de los umbrales es `max(EYE_MARGIN, 3 × temblor)`, sin pasar del 40 % del rango (así el temblor normal no entrecierra el ojo y un parpadeo real llega a cerrarlo del todo). Los umbrales también son por ojo (`eyeRight` en `Calibration`; en la página del avatar, `eyeClosed(score, "left" | "right")`). Calibraciones antiguas sin `eyeRight` usan los mismos umbrales para los dos. Motivo: con un ojo que la cámara ve más cerrado, el umbral compartido (calculado con los dos) dejaba al otro sin cerrarse del todo (medido: un parpadeo cerraba el ojo del avatar al 15 %); boca en reposo = percentil 90 del paso 1; boca máxima = percentil 95 del paso 3. Se guardan para poder recalcular.
- **Umbrales (`thresholds()`)** con sensibilidad `s` de −1 a 1: `eyeOpen = abierto + (0,25 − 0,1·s)·rango`, `eyeClosed = abierto + (0,85 − 0,25·s)·rango`; `mouthClosed = reposo + 0,02`, `mouthOpen = reposo + (0,6 − 0,25·s)·rango`.
- **Prueba y ajuste:** medidores en vivo (`{#snippet meter}`, con marcas en los dos umbrales) y deslizadores; cada cambio llama a `calibration_preview` (aplica al avatar **sin guardar**). Cancelar o cerrar el asistente sin guardar llama a `calibration_preview_end` (vuelve a lo guardado). "Ajustar" abre el asistente con `initial` = la calibración guardada (si tiene `levels`) directo en este paso. Indicador "te veo" si llegó un cuadro en los últimos 500 ms; **Empezar** se desactiva sin cara.
- `initial` y `subscribe` se leen una sola vez (`untrack`): el asistente trabaja con su propia copia. `headOffset` y `restPos` = medianas del paso 1. Rango mínimo `MIN_RANGE` (0,08): si no, error `calibration_eyes` / `calibration_mouth`; menos de 5 cuadros → `calibration_no_face`.
- **Va dentro del panel lateral**, no en un modal: un modal centrado quedaría bajo la vista previa nativa.
- Se envía con `$state.snapshot()`: un proxy reactivo de Svelte no se puede copiar por la comunicación con Rust.
- **Formato:** `levels`, `eyeSensitivity` y `mouthSensitivity` son opcionales (`#[serde(default)]`): los `calibracion.json` anteriores siguen siendo válidos. Pruebas: `cargo test --lib calibration`.
- **Rust:** `CalibrationState::load()` lee `<app_config_dir>/calibracion.json` al arrancar (si es válido); `calibration_set` valida (valores 0–1, `eyeOpen < eyeClosed`, `mouthClosed < mouthOpen`, números finitos), guarda y publica; `calibration_reset` borra el archivo. `publish()` envía el mensaje pegajoso `calibration`.
- **Página del avatar:** sin calibración usa `EYE_*`/`MOUTH_*`; con ella, sus umbrales, resta `headOffset` a la rotación de la cabeza y usa `restPos` fijo (sin el recentrado de 8 s).

### `src-tauri/src/background.rs` — fondo del avatar

- `Background { kind: transparent | color | image, color: "#rrggbb", image?: ruta, fit: cover | contain }`; color e imagen se recuerdan aunque el modo sea otro. Por defecto: transparente, color `#00b140` (verde de croma).
- **Versión del archivo** (`next_version`): `v` de la URL sube **solo cuando cambia el archivo**; si subiera con cada cambio, cambiar Cubrir/Ajustar reiniciaría el video. (Si se edita el archivo y se vuelve a elegir el mismo, no se recarga hasta elegir otro o reiniciar.) Prueba: `cargo test --lib background`.
- **Videos:** `background_mime` acepta además `mp4` y `webm` (`is_video`). El mensaje `background` lleva `media: "image" | "video"` (la página no ve el nombre del archivo). La página pone un `<video>` (silenciado, en bucle, `object-fit` según el ajuste) detrás del lienzo y avisa por `/status`: `bg_playing` **una vez** por video (el evento `playing` se repite en cada vuelta) o `bg_error` con el código de `MediaError` (4 = formato o códec no soportado). `obs.rs` los registra y emite `background-status`; la interfaz muestra `errors.background_video_unsupported` (4) o `background_video_failed`. El navegador de OBS (CEF 127) reproduce **MP4 H.264 y WebM VP9** (probado en la app real).
- `BackgroundState::load()` lee `<config>/fondo.json`; si el modo es `image` y el archivo ya no existe, vuelve a `transparent` (con aviso en el log).
- `background_set` valida (color hexadecimal estricto; en modo imagen, archivo existente con extensión aceptada), guarda y llama a `apply()`: entrega la ruta al servidor del avatar (`Obs::set_background_image`) y publica el mensaje pegajoso `background` con un `v` que sube en cada cambio (evita la caché de la imagen anterior).
- Se aplica en `setup` **después** de `obs::init` (hace falta el servidor del avatar). Pruebas: `cargo test --lib background` (incluye un intento de inyectar CSS por el color).
- **Página del avatar:** `applyBackground()` pone el fondo como `background` del `body` (detrás del lienzo WebGL transparente); la fuente de navegador de OBS captura los dos juntos, y así los GIF/WebP animados se animan solos. Vuelve a validar el color.
- **Interfaz:** lista Transparente / Color / Imagen; elegir "Imagen" sin imagen abre el diálogo (en `recursos\fondos`) y, si se cancela, la lista vuelve a mostrar el modo real.

### `src-tauri/src/effects.rs` — efectos del avatar

- `Effects { shot: close | medium | full, zoom 0,5–2, height ±0,5 m, angle ±60°, lightIntensity 0–2, lightColor "#rrggbb", lightAngle ±90°, ambient 0–1,5, outline 0–4 }`. `#[serde(default)]`: un `efectos.json` con campos de menos se completa con los valores por defecto; uno inválido se ignora. `effects_set` valida rangos, guarda y publica el mensaje pegajoso `effects`. Pruebas: `cargo test --lib effects`.
- **Página del avatar:**
  - `measureAvatar()`: al cargar, toma la altura **del hueso `head`** (que en VRM está en la base de la cabeza, a la altura de la mandíbula: la cara queda ~8–10 cm más arriba).
  - `updateCamera()` (cada cuadro): por plano, altura visible y centro (`close` 0,55 m centrado en cabeza + 0,06; `medium` 1,05 m en cabeza − 0,25; `full` cabeza + 0,35 m); distancia = (visible / 2) / tan(FOV / 2) / zoom, con el FOV vertical fijo de 30°; órbita según `angle`; transición exponencial (6 s⁻¹) y encuadre inmediato al cambiar de avatar.
  - `applyEffects()`: color, intensidad (× π) y dirección de la luz direccional, intensidad de la luz ambiente.
  - `applyOutline()`: multiplica `outlineWidthFactor` de los materiales MToon por `outline`, guardando el original en `userData.baseOutline`. Sin contorno en el modelo, no hace nada.
- **Interfaz:** sección plegable (`<details class="fx">`, cerrada por defecto). Los deslizadores envían como máximo cada 100 ms el **último** valor (temporizador); el avatar suaviza entre valores.

### `src/lib/lipsync.ts` — lip-sync por micrófono

- `LipSync.start(deviceId?)`: `getUserMedia` de audio (sin control automático de ganancia, con supresión de ruido) + `AnalyserNode`; **no se conecta a la salida** (no se oye). Si el `AudioContext` nace *suspendido* (política de reproducción automática), se llama a `resume()`: suspendido, el analizador solo ve silencio. Si el análisis falla, se cierra el micrófono.
- Lee bloques de `BLOCK` = 2048 muestras (~43 ms, para las vocales); el volumen se mide sobre las últimas `LEVEL_SAMPLES` = 1024 (~21 ms).
- Cada `INTERVAL_MS` (33 ms): RMS → dB → nivel 0–1 entre `FLOOR_DB` y `CEIL_DB` (−48 / −20 dB), desplazados `sensitivity × SENSITIVITY_DB` (±10 dB). Envolvente asimétrica: sube con factor 0,6 y baja con 0,25 por paso.
- `LipSync.devices()` lista los micrófonos sin los alias `default` / `communications` (la interfaz ya ofrece "Predeterminado de Windows"); sin permiso, Windows no da los nombres y la interfaz muestra "Micrófono N".
- `onAnalysis(result, level)`: cada análisis con voz (formantes o `null`), para la calibración; funciona aunque `vowels` esté apagado. `setVowelProfile(profile)` aplica el perfil personal (también al analizador que se crea al encender).
- **Vocales** (`vowels = true`, por defecto): con nivel ≥ `VOWEL_MIN_LEVEL` (0,12) se analiza el bloque con `VowelAnalyzer`; el resultado se suaviza (`VOWEL_SMOOTHING` 0,45 por medición). Si no hay voz o el análisis no encuentra formantes, se conserva la última vocal. `onLevel(level, vowels)` recibe `[A, I, U, E, O]` (suman 1) o `null` si están apagadas.
- La interfaz envía cada nivel con `invoke("lipsync_update", { level, mode, vowels })`, muestra la vocal dominante junto a **Voz** (con nivel > 0,15) y guarda micrófono, modo, forma y sensibilidad en `localStorage["avatos.lipsync"]` (preferencia de este equipo).
- **Página del avatar:** `applyMouth(model, delta, cameraJaw, cameraOu)` decide la boca **con y sin tracking**. Apertura: `combine` = `max(cámara, voz)`, `voice` = solo voz; sin mensajes `lipsync` durante `VOICE_TIMEOUT_S` (0,5 s), la voz cuenta como 0. Abre con velocidad 45 s⁻¹ y cierra con 25 s⁻¹. Esa apertura se reparte entre `aa`, `ih`, `ou`, `ee`, `oh` según los pesos de las vocales (cambio de forma a 20 s⁻¹); sin vocales, todo va a `aa`. Si el modelo no trae alguna, su parte va a `aa`. `ou` es además `max(…, labios en "o" de la cámara)`.

### `src/lib/vowels.ts` — reconocimiento de vocales

- `VowelAnalyzer(sampleRate)`: filtro pasa bajos FIR (31 coeficientes) y diezmado a ~11 kHz (48 kHz → 12 kHz) → **tono** → preénfasis 0,97 → ventana de Hamming → LPC de orden `LPC_ORDER` = 10 (autocorrelación + Levinson-Durbin) → **raíces** del polinomio (Durand-Kerner) → resonancias (frecuencia y ancho de banda) → F1 y F2 → `classify`. ~0,2 ms por bloque.
- **Tono** (`pitch`): autocorrelación normalizada entre `MIN_F0` y `MAX_F0` (70–400 Hz), con corrección de octava. Si el parecido entre periodos es menor que `VOICED_MIN` (0,45), el sonido no es sonoro (s, f, j, ruido) y no hay resultado.
- **Ajuste a la voz** (`speakerScale`): los formantes suben con el tono, como `(tono medio / REFERENCE_F0) ^ SCALE_EXPONENT` (100 Hz, 0,32; medido con las voces de Windows Raúl ≈ 100 Hz y Sabina ≈ 210 Hz: la segunda tiene los formantes ~27 % más altos), limitado a 0,92–1,5. El tono **medio** empieza en `INITIAL_F0` (150 Hz), es un promedio simple al principio y luego uno lento (`F0_AVERAGE_RATE` 0,03: ~1 s de voz); se reinicia al encender el lip-sync. `PROTOTYPES` son los formantes de una voz grave (~100 Hz), entre los de Quilis y los medidos.
- **F1 y F2** (`findFormants`): las resonancias con banda < `MAX_BANDWIDTH` (500 Hz) son "nítidas". F1 = primera nítida entre 200 y `MAX_F1` (1250 Hz); F2 = la siguiente nítida por encima de 1,15·F1 y hasta `MAX_F2` (3600 Hz). Correcciones, cada una por un caso medido:
  - **F2 débil de la U y la O:** su F2 a veces sale ancha (600–900 Hz de banda), se descarta y la F3 (~2,7 kHz) pasa por F2: la U parecía una I. Si F2 queda por encima de `FRONT_F2` (1800 Hz) **sin ser nítida** (banda > `SHARP_BANDWIDTH`, 250 Hz: la F2 de una I de verdad es nítida) y hay una resonancia de banda < `WEAK_MAX_BANDWIDTH` (1000 Hz) por debajo de `BACK_F2_MAX` (1500 Hz), esa es la F2. Solo con tono ≤ `WEAK_F2_MAX_F0` (240 Hz): en voces más agudas, los armónicos forman resonancias anchas parecidas y la I se volvía U.
  - **F1 partida o falsa en voces agudas:** LPC "imita" los armónicos. Dos resonancias borrosas casi juntas (proporción < `SPLIT_RATIO` 1,5) son una F1 partida (se usa la media); una muy borrosa (> `BLURRY_BANDWIDTH`, 400 Hz) con una nítida justo encima es falsa.
- `classify(f1, f2, scale)`: distancia **logarítmica** a `PROTOTYPES × scale` con tolerancias `SIGMA_F1` = `SIGMA_F2` = 0,22 (con F2 más estricta, la O y la U, que se distinguen sobre todo por F1, se confundían) → pesos que suman 1. Si la más cercana queda a más de `MAX_DISTANCE` (4), devuelve `null`: una "m" da 4,5–8 y los cortes entre sílabas 8–19 (antes esos casos daban "A").
- Se eligió por raíces y no por picos de la envolvente: con picos, la U y la O (F1 y F2 muy juntos) se veían como un solo pico y el ruido de fondo formaba picos falsos; con raíces, el ruido da resonancias anchas que se descartan y el analizador responde "no sé" (la boca mantiene la forma) en lugar de equivocarse. Orden 10: con 12, las voces agudas confundían un armónico con F1; con 8, se perdía la U. Una ventana de retardo en la autocorrelación empeoraba los resultados.
- Limitación conocida: la "m" y las vocales muy cortas o pegadas a consonantes a veces muestran la vocal vecina un instante.
- **Plantillas de la persona** (calibración; `VowelTemplates`): en cada bloque sonoro se calcula la **forma del espectro** `shape` (`melShape()`): el logaritmo de la envolvente del filtro LPC evaluada en `MEL_POINTS` (32) frecuencias en **escala mel** entre 60 y 5000 Hz, resumido con una DCT en `SHAPE_COUNT` = 12 números (sin el 0, que es el volumen). Con `analyzer.templates`, la vocal sale de comparar esa forma con la media de cada vocal de la persona (`classifyTemplates`): distancia media al cuadrado en desvíos de su propia voz (`scale`), pesos `exp(−12·(d − dmín)/2)`; si la más cercana está a más de `MAX_TEMPLATE_DISTANCE` (6), `null` (una "m", un corte, mucho más ruido que al calibrar: la boca mantiene la forma). Sin plantillas, formantes típicos ajustados al tono, como antes. `analyze` devuelve `shape` aunque no encuentre formantes (`weights: null`), para poder calibrar una U cuya F2 se pierde. `buildTemplates` (media por vocal + desvío dentro de las vocales), `closeTemplates` (pares a menos de `MIN_TEMPLATE_SEPARATION`, 1,5) e `isVowelTemplates` (valida lo guardado).
- **Por qué plantillas y no formantes:** la calibración guardaba F1/F2, pero con un micrófono real la F2 de la A, la O y la U llegaba débil y se tomaba la F3: en el perfil real del usuario la U (669/3046 Hz) y la O (637/2738) quedaron casi iguales y la U fallaba. La forma completa no depende de encontrar dos resonancias exactas. Medido en `npm run test:vowels` con una voz grave y F2 débil en A/O/U (como ese micrófono): formantes típicos 16 % → plantillas 100 %; con el tono 15 % más alto que al calibrar, 99 %. Se eligió la **envolvente LPC** (y no el espectro directo, MFCC) porque aguanta mejor los cambios de tono de la entonación (+15 %: 100 % frente a 95 %), y en **escala mel** (y no el cepstrum LPC lineal, LPCC) porque la U y la O se distinguen sobre todo por debajo de ~500 Hz: con LPCC, la calibración real del usuario dejó su U y su O a 1,4 (se confundían); con mel se separan 4–5 veces más en simulación (voz normal 8,0 → 32,1; U y O cercanas 2,2 → 12,0; también con un micrófono que recorta graves). Con mel, `MAX_TEMPLATE_DISTANCE` pasó de 4 a 6: con 4, la entonación (+15 %) daba "no sé" en 7 de 100 vocales; con 6 en ninguna, sin equivocarse más, y una "m" o una "n" siguen quedando a 8 o más (rechazadas). Con mucho más ruido que al calibrar ningún método acierta bien: el analizador devuelve `null` en vez de equivocarse; recalibrar si cambia el ruido del lugar.

### `src/lib/VowelCalibration.svelte` — calibración de vocales

- Se muestra en el panel del lip-sync cuando **Forma → Vocales** está activa. Pide A, E, I, O, U (orden natural) y guarda en el orden de `VOWEL_LETTERS`.
- Por vocal: `PREPARE_MS` (1,2 s) para prepararse → escucha con `lipsync.onAnalysis`: descarta las primeras `SKIP` (4) mediciones (la transición) y junta `NEEDED` (30, ~1 s de voz); se guardan todas las formas (`shape`) y, para mostrar, la mediana de F1 y de F2 (o "—" si no se encontraron). Sin suficientes mediciones en `VOWEL_TIMEOUT_MS` (8 s) → aviso y **Reintentar**. Muestra en vivo F1, F2 y tono.
- Al final: `buildTemplates(shapes)`, tabla de F1/F2 (solo como referencia), aviso por cada par de `closeTemplates`, **Guardar** / **Repetir** / **Cancelar**. Se guarda en `localStorage["avatos.vowelProfile"]` (`{ version: 3, templates, formants }`); `loadVowelProfile()` (exportada desde el `<script module>`) ignora lo inválido y **las versiones anteriores** (1: formantes; 2: cepstrum LPC lineal; hay que recalibrar). Se aplica con `lipsync.setVowelTemplates()`.
- Prueba: `npm run test:vowels` (Node 22.18+; ejecuta TypeScript directo) sintetiza las 5 vocales con 6 tonos (110–300 Hz), cada uno con los formantes esperados para ese tono y un 6 % más bajos y más altos, en 28 ventanas; un analizador por voz. Falla si en un adulto más de 1 ventana de cada 10 sale equivocada o la vocal se reconoce en menos de la mitad.

### `src/lib/rememberOpen.ts` — desplegables

- Acción `use:rememberOpen={"clave"}` para `<details>`: guarda abierto/cerrado en `localStorage["avatos.open.<clave>"]` (comodidad de este equipo; si el almacenamiento falla, se ignora). Claves: `expresiones`, `atajos`, `recientes`, `lipsync` (**Ajustes del lip-sync**: la barra **Voz** queda fuera, a la vista), `efectos`. El contenido de un `<details>` cerrado sigue montado: por eso `VowelCalibration` aplica el perfil aunque **Ajustes del lip-sync** esté cerrado.

### `src/lib/tooltip.ts` — tooltips

- Acción de Svelte: `use:tooltip={texto}`. Si el texto cambia (idioma), se actualiza solo; con texto vacío no se muestra.
- Crea un `<div role="tooltip" class="avatos-tooltip">` en `body`, enlazado **siempre** con `aria-describedby` (aunque esté oculto), para que el lector de pantalla lo lea al enfocar.
- Mouse: aparece tras `SHOW_DELAY_MS` (400 ms); al hacer clic se oculta. Teclado: aparece al instante si el foco es `:focus-visible`. `Esc`, `blur` y `pointerleave` lo cierran.
- Posición (`place()`): abajo → arriba → izquierda → derecha; descarta las que salen de la ventana o pisan un elemento `[data-native-overlay]` (la vista previa de OBS es una ventana nativa **encima** de la web y lo taparía). Si todas pisan, prueba a correrlo a un costado de la zona tapada.
- Se mide en `(0,0)` antes de colocarlo: un elemento `fixed` sin `left` calcula su ancho desde su posición provisional. El estilo (`.avatos-tooltip`, `box-sizing: border-box`, 260 px máx.) está en `+page.svelte` como `:global`.
- No poner enlaces ni botones dentro de un tooltip (no se pueden pulsar).

### `src/lib/i18n/` — idiomas de la interfaz

- **Sistema propio, sin dependencias.** `es.json` es el idioma fuente y el respaldo; cada idioma es un JSON con la misma estructura (formato estándar que aceptan Weblate y Crowdin).
- `t(clave, parámetros?)`: devuelve el texto en el idioma activo; `{nombre}` se reemplaza con `parámetros.nombre`. Es **reactivo**: al cambiar `i18n.locale`, toda la interfaz se actualiza sin recargar.
- `MessageKey` se genera a partir de `es.json`: **una clave inexistente es un error de tipos**, y `DICTS: Record<Locale, Dict>` hace fallar la compilación si a una traducción le falta una clave.
- `tError(error)`: traduce los errores de los comandos de Rust. Rust devuelve un **código** (`avatar_invalid_file`) o `código: detalle` (`internal: …`), que se buscan en `errors.*`; si el código no existe, se muestra como `errors.internal` con el texto original.
- Idioma inicial: el guardado (`localStorage["avatos.locale"]`), si no el primero de `navigator.languages` que exista (WebView2 informa el idioma de Windows), si no inglés. También actualiza `<html lang>`.
- **Agregar un idioma:** copiar `es.json` como `<código>.json`, traducir los valores (no las claves), importarlo y añadirlo a `LOCALES` y `DICTS` en `index.svelte.ts`.
- Datos de ejemplo de la interfaz (escenas, fuentes, mezclador) guardan la **clave**, no el texto, para cambiar con el idioma.
- **Pendiente:** arrancar libobs con el mismo idioma (Fase 2, al mostrar opciones de OBS). Los nombres internos de la escena y las fuentes de libobs (`"Escena principal"`, `"Pantalla"`, `"Avatar"`) aún no se traducen.

### `avatar/main.ts` — avatar

- Renderer WebGL con `alpha: true` y fondo transparente; cámara a 30° de FOV en plano medio.
- Carga VRM con `GLTFLoader` + `VRMLoaderPlugin`; `VRMUtils.rotateVRM0` para modelos 0.x; brazos bajados desde la pose en T (`restPose`).
- Solo procesa mensajes cuyo `avatar` coincide con su `id` (regla de N avatares).
- **Acercarse / alejarse:** la fracción `(z − z de reposo) / distancia de reposo` de la persona (más cerca = positivo) se aplica a la distancia de la cámara del avatar (`cameraDistance`, según plano y zoom), con topes `APPROACH_MAX_IN` / `APPROACH_MAX_OUT`. `applyApproach()` mueve al avatar por la recta que une **la cara** con la cámara: la cara queda en el mismo punto de la pantalla y solo cambia de tamaño (en horizontal, al acercarse la cabeza se salía del cuadro por arriba). Sin tracking vuelve a su lugar (~1 s). Prueba: con una calibración real (reposo a 41 cm), a 30 cm el avatar se ve un 18 % más ancho y a 55 cm un 18 % más angosto; reposo, sin tracking y antes del tracking miden igual.
- **Anti-temblor** (`one-euro.ts`, parámetros en `smoothing.ts`): cada cuadro de tracking que llega pasa por `filterFrame()`: filtro One Euro (Casiez y otros, 2012; corte = `minCutoff + beta·|velocidad|`) en giro de la cabeza (`HEAD_FILTER` 0,5 Hz / β 2), posición (`POSITION_FILTER` 0,5 / 0,1) y mirada (`GAZE_FILTER` 1 / 4). Los filtros usan `time` (cuándo se midió, lo pone `tracking.ts`), no la hora de llegada: en el camino interfaz → Rust → avatar los mensajes se amontonan o se separan y darían velocidades falsas (sin `time`, se usa la de llegada). Se reinician si el tracking estuvo cortado más de `TRACKING_TIMEOUT_S` o si `time` va hacia atrás (la interfaz se recargó y su reloj volvió a 0; si no, el filtro se quedaría congelado). Con los ojos cerrados la mirada no entra al filtro (MediaPipe la da al azar) y `gaze` queda vacío para que se mantenga la última. La boca no se filtra; los párpados solo pierden los **picos sueltos** (`spike-filter.ts`: mediana de las últimas 3 muestras, ~33 ms de retraso): un parpadeo real dura 3–5 muestras y un pico de ruido 1, y con un rango de ojos estrecho cada pico cerraba el ojo del avatar un instante (parpadeos falsos). Después, `WinkGate` (mismo archivo): lo que cierran **los dos** ojos juntos se muestra al instante; que un ojo esté más cerrado que el otro (más de 0,08 de diferencia, siempre del mismo lado) tiene que durar 4 muestras (~130 ms) para mostrarse: el ruido de la cámara en un ojo dura 2–3 muestras y se veía como parpadeos de un solo ojo; un guiño a propósito dura más. **La duración es la protección**, no la diferencia: con 0,3 de diferencia mínima, los guiños de alguien con rango de ojos estrecho no se veían (el ojo cerrado no llega a 1 y el abierto se cierra un poco porque MediaPipe "mezcla" los ojos). Además, en un guiño sostenido cuyo ojo más cerrado pasa de 0,4–0,6, el otro se abre en proporción a la diferencia (`lo × (1 − fuerza·mín(1, dif/0,4))`), para que la mezcla no lo deje entrecerrado. `filterFrame` deja en el cuadro cuánto está cerrado cada ojo (`closedLeft` / `closedRight`). Además, `eyeClosed()` aplica el margen mínimo `EYE_MARGIN` (0,03) sobre el ojo abierto medido (`levels`) también a calibraciones guardadas antes de que existiera. Después del One Euro, cabeza y posición pasan por una **zona muerta suave** (`SoftDeadband`, `HEAD_DEADBAND` 0,5°, `POSITION_DEADBAND` 0,6 cm): cambios más chicos se ignoran y los grandes siguen desde el borde, sin saltos ni retraso; quita los "tirones" que quedaban con la cabeza quieta (saltos de la profundidad de MediaPipe o del ángulo al parpadear). Después, `applyTracking` solo interpola entre muestras (`FRAME_INTERPOLATION` 45 s⁻¹: el tracking llega a ~30/s y se dibuja a ~60/s).
- **Gestos:** `applyGesture()` corre cada cuadro **después** del tracking o del reposo: escribe siempre brazos y hombros (reposo `ARM_REST_Z` = 1,2 rad, así vuelven exactos) y **suma** a la cabeza. Animación por código con `envelope()` (rampas suaves de 0,25 s); duraciones en `GESTURE_DURATION`. Ejes de los huesos normalizados (avatar mirando a +Z): brazo derecho hacia −X, `rotation.z` > 0 lo baja; antebrazo `rotation.y` > 0 hacia la cámara; cabeza `rotation.x` > 0 hacia abajo.
- **Mirada:** `vrm.lookAt.autoUpdate = false` al cargar; `applyGaze()` fija `lookAt.yaw` / `pitch` (grados) = mirada suavizada (menos `gazeOffset` de la calibración) × `GAZE_GAIN` × el `inputMaxValue` del *rangeMap* del propio VRM (`gazeRange()`), para que la mirada máxima lleve los ojos al límite que definió el autor. **No usar un ángulo fijo:** con `inputMaxValue` de 90° (habitual), 25° movían los ojos del avatar de pixiv solo ~2,8°. Con los ojos casi cerrados (> 0,5) se mantiene la última mirada (MediaPipe da valores al azar). three-vrm aplica la mirada según el tipo de *lookAt* del VRM (huesos o expresiones) y limita el rango con su `rangeMap`. Sin tracking, los ojos vuelven al frente.
- `reportStatus()` informa `loading` / `loaded` / `error` (con el mensaje) a `/status`. Con `v=0` (todavía no se eligió avatar) no intenta cargar `/model.vrm`.
- `applyTracking()` si hubo datos en los últimos `TRACKING_TIMEOUT_S` (0,5 s); si no, `idle()` (respiración, balanceo, parpadeo automático) y limpia los valores del tracking.
- `applyExpressions()` (cada cuadro, con o sin tracking): fundido exponencial (`delta * 12`, ~0,2 s) hacia la emoción activa. Cada VRM decide con `overrideBlink`/`overrideMouth` si su emoción bloquea parpadeo o boca.
- Bucle con `THREE.Timer` (no `Clock`, obsoleto en three 0.187).

---

## 6. Protocolos internos

### Comandos Tauri (`invoke`)

| Comando | Parámetros | Devuelve | Módulo |
|---|---|---|---|
| `app_version` | — | `string` | `lib.rs` |
| `resources_dir` | `kind: "avatares" \| "fondos" \| "objetos"` | `string \| null` (ruta absoluta) | `lib.rs` |
| `obs_status` | — | `boolean` | `obs.rs` |
| `preview_set_bounds` | `x, y: i32; width, height: u32` (px físicos) | `()` / error | `obs.rs` |
| `avatar_load` | `path: string` (`.vrm`) | `()` / error | `obs.rs` |
| `avatar_current` | — | `string \| null` (nombre de archivo) | `obs.rs` |
| `avatar_recent` | — | `{ path, name, exists }[]` | `recent_avatars.rs` |
| `avatar_recent_remove` | `path: string` | `()` | `recent_avatars.rs` |
| `avatar_status` | — | `{ state, detail } \| null` (último estado informado por la página) | `obs.rs` |
| `tracking_update` | `frame: TrackingFrame` | `()` | `tracking_relay.rs` |
| `effects_get` | — | `Effects` | `effects.rs` |
| `effects_set` | `values: Effects` | `()` / `effects_invalid` | `effects.rs` |
| `background_get` | — | `Background` | `background.rs` |
| `background_set` | `value: Background` | `()` / `background_invalid` / `background_invalid_file` | `background.rs` |
| `lipsync_update` | `level: f32` (se limita a 0–1), `mode: "combine" \| "voice"`, `vowels: f32[5] \| null` (A, I, U, E, O; cada uno se limita a 0–1; otro largo → `null`) | `()` | `tracking_relay.rs` |
| `expression_list` | — | `{ name, shortcut: string \| null }[]` | `expressions.rs` |
| `expression_current` | — | `string \| null` | `expressions.rs` |
| `calibration_get` | — | `Calibration | null` | `calibration.rs` |
| `calibration_set` | `values: Calibration` | `()` / `calibration_invalid` | `calibration.rs` |
| `calibration_preview` | `values: Calibration` | `()` / `calibration_invalid` — aplica al avatar sin guardar | `calibration.rs` |
| `calibration_preview_end` | — | `()` — vuelve a la calibración guardada | `calibration.rs` |
| `calibration_reset` | — | `()` | `calibration.rs` |
| `gesture_list` | — | `{ name, shortcut: string \| null }[]` | `expressions.rs` |
| `shortcuts_get` | — | `{ action, binding, label, failed }[]` | `shortcuts.rs` |
| `shortcuts_set` | `action`, `binding: string \| null` | `()` / `shortcut_*` | `shortcuts.rs` |
| `shortcuts_reset` | — | `()` | `shortcuts.rs` |
| `shortcuts_pause` | `paused: boolean` | `()` | `shortcuts.rs` |
| `shortcuts_status` | — | `string[]` (atajos que no se pudieron registrar) | `shortcuts.rs` |
| `shortcuts_retry` | — | `string[]` (los que siguen fallando) | `shortcuts.rs` |
| `gesture_play` | `name: string` | `()` / `gesture_unknown` | `expressions.rs` |
| `expression_set` | `name: string \| null`: un nombre **alterna** esa expresión (como su atajo); `null` = neutral | `()` / error si el nombre no existe | `expressions.rs` |

**Eventos Rust → interfaz:** `background-status` (`{ state: "playing" | "error", detail }`); `recent-avatars-changed`; `shortcuts-changed`; `shortcut-action` (payload: acción, p. ej. `tracking.toggle`); `shortcuts-status` (payload `string[]`, atajos que fallan); `gesture-played` (payload: nombre del gesto); `expression-changed` (payload `string | null`), emitido tanto por los atajos como por `expression_set`; `avatar-status` (payload `{ state: "loading" | "loaded" | "error", detail }`), cuando la página del avatar informa su estado. **Regla:** para un estado que también se consulta con un comando (`avatar_status`, `shortcuts_status`), registrar primero el `listen` y consultar después; al revés, un aviso que llega en medio se pierde (el avatar del arranque se quedaba en *cargando…*).

### Mensajes del canal en vivo (JSON por WebSocket)

Todos llevan `type` y `avatar` (id de destino; la página ignora los de otro id):

```jsonc
{ "type": "tracking",   "avatar": "main", "frame": { /* TrackingFrame */ } }   // ~30 por segundo
{ "type": "expression", "avatar": "main", "name": "happy" }                    // null = neutral; "pegajoso"
{ "type": "gesture", "avatar": "main", "name": "wave" }                        // momentáneo (no pegajoso)
{ "type": "calibration", "avatar": "main", "values": { /* Calibration */ } }   // null = por defecto; "pegajoso"
{ "type": "lipsync", "avatar": "main", "level": 0.42, "mode": "combine", "vowels": [0.8, 0, 0, 0.1, 0.1] }  // ~30 por segundo mientras está encendido; vowels = A, I, U, E, O o null
{ "type": "background", "avatar": "main", "kind": "image", "color": "#00b140", "fit": "cover", "v": 3, "media": "video" }  // "pegajoso"; media = image | video
{ "type": "effects", "avatar": "main", "values": { "shot": "medium", "zoom": 1, … } }            // "pegajoso"
```

### `Calibration` (camelCase)

```jsonc
{ "eyeOpen": 0.2, "eyeClosed": 0.51, "mouthClosed": 0.05, "mouthOpen": 0.32,
  "headOffset": [pitch, yaw, roll],   // rad: rotación "de frente" de la persona
  "restPos": [x, y, z],                // cm: posición de reposo de la cabeza
  "gazeOffset": [h, v],                // opcional: mirada al mirar la pantalla de frente (−1..1)
  "levels": { "eyeOpen": 0.07, "eyeClosed": 0.59, "jawRest": 0.03, "jawMax": 0.51 },  // opcional
  "eyeSensitivity": 0, "mouthSensitivity": 0 }                                     // opcionales, −1 a 1
```

### `TrackingFrame`

```jsonc
{
  "time":    12.345,               // s, cuándo se midió (reloj de la interfaz): lo usa el anti-temblor
  "head":    [pitch, yaw, roll],   // radianes; positivos según three.js (Y arriba, Z hacia la cámara)
  "headPos": [x, y, z],            // cm respecto de la cámara (z negativo = delante de la cámara)
  "gaze":    [h, v],               // mirada ~−1..1: h > 0 = hacia tu izquierda (mismo sentido que girar la cabeza), v > 0 = arriba
  "blinkLeft": 0.0,                // 0–1, valor bruto de MediaPipe (eyeBlinkLeft)
  "blinkRight": 0.0,
  "jawOpen": 0.0,                  // 0–1
  "mouthFunnel": 0.0,              // 0–1
  "smile": 0.0                     // 0–1 (promedio mouthSmileLeft/Right; hoy no se aplica)
}
```

> Para el *modo dúo* basta con crear más fuentes Avatar con otro `id` y enviar sus mensajes con ese `avatar`; hoy todo usa `MAIN_AVATAR = "main"` (`expressions.rs`).

---

## 7. Parámetros ajustables

Valores que hoy están fijos en el código y que la **calibración** (Fase 1) pasará a la interfaz. La [guía de usuario](GUIA-DE-USUARIO.md#8-calibración-y-ajustes-de-ojos-boca-y-cuerpo) explica cómo elegirlos.

| Constante / expresión | Archivo | Valor | Efecto |
|---|---|---|---|
| `EYE_OPEN` / `EYE_CLOSED` | `avatar/main.ts` | 0.20 / 0.55 | Rango del parpadeo que se mapea a 0–1 (**solo sin calibración**) |
| `MOUTH_CLOSED` / `MOUTH_OPEN` | `avatar/main.ts` | 0.03 / 0.35 | Rango de `jawOpen` que se mapea a `aa` (**solo sin calibración**) |
| `COUNTDOWN_S`, `REACTION_MS`, `CAPTURE_MS`, `MIN_RANGE` | `src/lib/Calibration.svelte` | 3 s · 0,4 s · 1,5 s · 0,08 | Asistente de calibración (`MIN_RANGE`: boca) |
| `NOISE_FACTOR`, `MIN_EYE_DIFF`, `MIN_EYE_RANGE`, `SMALL_EYE_SIGNAL` | `src/lib/Calibration.svelte` | 4 · 0,03 · 0,02 · 0,06 | Ojos: cuántas veces el temblor debe superar la diferencia abierto/cerrado, mínimos y aviso de señal pequeña |
| Fórmulas de `thresholds()` | `src/lib/Calibration.svelte` | ver la sección del módulo | Umbrales según medidas y sensibilidad |
| `mouthFunnel * 1.5` | `avatar/main.ts` | 1.5 | Ganancia de la expresión `ou` |
| `HEAD_FILTER` / `POSITION_FILTER` / `GAZE_FILTER` | `avatar/smoothing.ts` | 0,5 Hz β 2 · 0,5 β 0,1 · 1 β 4 | Anti-temblor One Euro (cabeza, posición, mirada) |
| `HEAD_DEADBAND` / `POSITION_DEADBAND` | `avatar/smoothing.ts` | 0,0087 rad (0,5°) · 0,6 cm | Zona muerta suave después del One Euro (sin tirones con la cabeza quieta) |
| `FRAME_INTERPOLATION` | `avatar/smoothing.ts` | 45 s⁻¹ | Interpolación entre muestras (antes: suavizado fijo de 18 s⁻¹) |
| `delta * 45` | `avatar/main.ts` | 45 s⁻¹ | Suavizado de ojos y boca |
| `* 0.012`, tope `0.25` | `avatar/main.ts` | rad/cm | Inclinación lateral del torso |
| `* 0.01`, tope `0.2` | `avatar/main.ts` | rad/cm | Inclinación frontal del torso |
| `APPROACH_MAX_IN` / `APPROACH_MAX_OUT` | `avatar/main.ts` | 0,3 / 0,5 de la distancia de la cámara | Acercamiento del avatar a su cámara |
| Reparto del giro | `avatar/main.ts` | spine 0.15 · chest 0.15 · neck 0.3 · head 0.4 | Debe sumar 1 |
| `delta / 8` | `avatar/main.ts` | 8 s | Recentrado de la postura de reposo (solo sin calibración) |
| `TRACKING_TIMEOUT_S` | `avatar/main.ts` | 0.5 s | Sin datos → animación de reposo |
| `GESTURE_DURATION`, `ARM_REST_Z` | `avatar/main.ts` | 1,2–2,4 s · 1,2 rad | Duración de cada gesto y ángulo de reposo de los brazos |
| `GAZE_GAIN` | `avatar/main.ts` | 1,6 | Amplificación de la mirada de MediaPipe (al mirar a un lado suele dar 0,3–0,6) |
| `VOICE_TIMEOUT_S`, velocidades 45 / 25 s⁻¹ (`applyMouth`) | `avatar/main.ts` | 0,5 s | Lip-sync: tiempo sin mensajes y suavizado al abrir / cerrar la boca |
| Planos de `updateCamera()` (altura visible y centro), `CAMERA_FOV` | `avatar/main.ts` | ver la sección del módulo · 30° | Encuadre de la cámara del avatar |
| `FLOOR_DB` / `CEIL_DB` / `SENSITIVITY_DB` | `src/lib/lipsync.ts` | −48 / −20 / ±10 dB | Rango de volumen del lip-sync |
| `VOWEL_MIN_LEVEL` / `VOWEL_SMOOTHING` | `src/lib/lipsync.ts` | 0,12 / 0,45 | Desde qué nivel se buscan vocales y cuánto se suavizan |
| `PROTOTYPES`, `SIGMA_F1` / `SIGMA_F2`, `MAX_DISTANCE` | `src/lib/vowels.ts` | ver el módulo · 0,22 / 0,22 · 4 | Formantes típicos (voz grave), tolerancia y cuándo "no es una vocal" |
| `REFERENCE_F0` / `SCALE_EXPONENT`, `INITIAL_F0`, `F0_AVERAGE_RATE` | `src/lib/vowels.ts` | 100 Hz / 0,32 · 150 Hz · 0,03 | Ajuste de los formantes al tono de quien habla |
| `SHAPE_COUNT`, `MEL_POINTS`, `MAX_TEMPLATE_DISTANCE`, `MIN_TEMPLATE_SEPARATION` | `src/lib/vowels.ts` | 12 · 32 · 6 · 1,5 | Plantillas de la calibración: coeficientes LPCC, cuándo un sonido no es ninguna vocal, cuándo dos vocales calibradas se confundirían |
| `LPC_ORDER` / `MAX_BANDWIDTH` / `PRE_EMPHASIS` | `src/lib/vowels.ts` | 10 / 500 Hz / 0,97 | Análisis de formantes (ver por qué en el módulo) |
| `SHARP_BANDWIDTH`, `WEAK_F2_MAX_F0`, `SPLIT_RATIO`, `BLURRY_BANDWIDTH` | `src/lib/vowels.ts` | 250 Hz, 240 Hz, 1,5, 400 Hz | Correcciones de F1 y F2 (ver el módulo) |
| `WinkGate` (4 muestras, 0,08) | `avatar/spike-filter.ts` | ~130 ms | Cuánto tiene que durar que un ojo esté más cerrado que el otro para mostrarse (guiño); ayuda al ojo abierto en un guiño |
| `VOICE_SHAPE_MIN` | `avatar/main.ts` | 0,1 | Nivel de voz desde el que la boca toma la forma de la vocal |
| `delta * 12` (`applyExpressions`) | `avatar/main.ts` | 12 s⁻¹ | Fundido entre expresiones (~0,2 s) |
| `default_binding()` | `src-tauri/src/shortcuts.rs` | Ctrl+Shift+1…9 | Atajos de fábrica de expresiones y gestos |
| `SEND_INTERVAL_MS` | `src/lib/tracking.ts` | 33 ms | Frecuencia de envío del tracking |
| `CANVAS_WIDTH/HEIGHT` | `src-tauri/src/obs.rs` | 1920×1080 | Lienzo de libobs y tamaño de la fuente Avatar |
| `"fps", 30` | `src-tauri/src/obs.rs` | 30 | FPS de la fuente de navegador del avatar |
| `PREVIEW_BACKGROUND` | `src-tauri/src/obs.rs` | `0xFF160D0E` | Color fuera del lienzo en la vista previa (AABBGGRR) |

**Decisión importante:** la sonrisa **no** se conecta a la expresión `happy`. En muchos VRM las emociones tienen `overrideBlink`/`overrideMouth` (`block` o `blend`) y, si son `isBinary`, cualquier peso > 0.5 bloquea el parpadeo o la boca (lo comprobamos con Seed-san). Las emociones se activarán por atajos.

---

## 8. Seguridad y privacidad

| Medida | Dónde |
|---|---|
| Servidores solo en `127.0.0.1` + validación de `Host` (anti DNS rebinding) | `avatar_server.rs`, `tracking_relay.rs` |
| Protección contra `../` al servir archivos | `avatar_server.rs` (`canonicalize` + `starts_with`) |
| Solo se aceptan archivos `.vrm` existentes | `obs.rs::load_avatar` |
| Descargas verificadas por SHA-256 (OBS y modelo de MediaPipe) | `build.rs`, `scripts/fetch-tracking.mjs` |
| MediaPipe 100 % local (sin CDN) | `static/mediapipe/` |
| Permisos mínimos de Tauri | `capabilities/default.json` |
| Archivos personales fuera de git | `.gitignore` (`recursos/*/*`, `*.vrm`, `*.mp4`…) |

**Pendiente** (Fase 6): activar la CSP (`"csp": null` hoy) y quitar el plugin `opener` si no se usa.

> ⚠️ **El repositorio es público.** Antes de cada commit revisa `git status`: nunca subas avatares, grabaciones, logs, `.env`, tokens ni documentos personales.

---

## 9. Pruebas y verificación

Las **pruebas a mano** en la app real, por fase, están en [pruebas.md](../pruebas.md) (agregar las de cada fase nueva al programarla). Pruebas automáticas en el repositorio: `cargo test --lib` en `src-tauri/` (atajos, avatares recientes), `npm run test:vowels` (vocales) `npm run test:smoothing` (anti-temblor) y `npm run test:blink` (parpadeos falsos). El resto se verifica así:

| Qué | Cómo |
|---|---|
| Tipos de la interfaz | `npm run check` (también detecta claves de idioma inexistentes y traducciones incompletas) |
| Gestos | Página del avatar con el WebSocket envuelto (para inyectar mensajes) y **`performance.now()` congelado** en el instante a capturar (una captura de Edge *headless* tarda ~1 s, más que un gesto): saludar a 0,7 y 1,3 s, asentir 0,3 s, negar 0,14 y 0,42 s, no sé 0,8 s, un gesto para otro `avatar` (se ignora) y vuelta exacta al reposo, en los dos avatares de prueba. App real: `Ctrl+Shift+6…9` emiten los cuatro gestos |
| Mirada | Página del avatar con miradas simuladas **realistas (0,4)** (centro, izquierda, derecha, arriba, abajo) comparadas con un giro de cabeza a la izquierda: los ojos van hacia el mismo lado que la cabeza en Seed-san (*lookAt* por expresiones) y en el avatar de pixiv (por huesos, con menos recorrido por su configuración). Calibración: `gazeOffset` se mide en el paso 1 |
| Efectos | Página del avatar con mensajes simulados en los dos avatares de prueba (alturas distintas): primer plano, primer plano con zoom 2×, plano medio, cuerpo entero, ángulo 40° con luz roja desde la izquierda, contorno 0 y 4×. Interfaz con Tauri simulado: sección cerrada al inicio; 10 movimientos de un deslizador → **un** envío con el último valor; plano y color; Restablecer. App real: al arrancar llegan `effects`, `background` y `calibration` |
| Anti-temblor | `npm run test:smoothing`: simula el tracking (30 muestras/s con ~0,6° de ruido, dibujado a 60 cuadros/s) y compara con el suavizado anterior (exponencial 18 s⁻¹): con la cabeza quieta, temblor 0,11° frente a 0,29°; en un giro de 30° en 0,2 s llega al 90 % en 67 ms frente a 83 ms; se pasa 0,3° frente a 0,8°. Con la zona muerta: temblor 0,01° y, en 60 s quieto con saltos de 1° cada ~7 s, 63 cuadros con movimiento visible (más de 0,2°) frente a 715 solo con One Euro y 1710 antes; el retraso sigue en 67 ms. Con `SWEEP=1` recorre otros parámetros. Página del avatar con tracking ruidoso: sigue un giro, ojos cerrados con mirada al azar sin saltos, y tras un corte vuelve en otra postura sin arrastrar la anterior; con `time` que vuelve a 0 (interfaz recargada) sigue la postura nueva |
| Avatares recientes | `cargo test --lib recent_avatars` (sin repetir, mayúsculas, límite de 8). App real con un `avatares-recientes.json` de prueba (uno que no existe primero, luego Seed-san dos veces con distintas mayúsculas): salta el que falta, carga Seed-san al arrancar y la página carga **una vez** (un *cargando* y un *listo*); el archivo no se reescribe al arrancar; un JSON dañado se ignora. Interfaz con Tauri simulado: lista cerrada al inicio, *en uso*, tachado *no se encuentra*, cargar uno lo sube al principio, Quitar |
| Fondos de video | `cargo test --lib avatar_server` (rangos de bytes, formatos). Videos de prueba generados en el navegador (animación de un canvas grabada con `MediaRecorder`: WebM VP9 y MP4 H.264). App real con un `fondo.json` de prueba (y el del usuario respaldado y restaurado): el navegador de OBS reproduce los dos (`Video de fondo reproduciéndose` en el log). Página del avatar: se ve detrás del avatar, avisa una sola vez aunque dé la vuelta, Cubrir → Ajustar sin reiniciar, al pasar a color se quita el video; un archivo dañado da `bg_error:4`. Interfaz: textos, aviso por códec (4) o archivo dañado, y se borra al reproducirse |
| Fondos | Página del avatar con mensajes simulados (color, imagen con Cubrir y con Ajustar en ventana ancha). App real con un `fondo.json` de prueba: el canal recibe `background`, `/background` entrega la imagen (200 `image/png`) y la rechaza con `Host` falso; con la imagen borrada vuelve a transparente. Interfaz con Tauri simulado (diálogo incluido): color, imagen, ajuste, cancelar el diálogo sin guardar y mensaje de archivo no válido |
| Lip-sync | Página del avatar con mensajes simulados: voz sin cámara → boca abierta; cámara cerrada + voz ("combine") → abierta; cámara abierta + silencio ("combine") → abierta; lo mismo en "voice" → cerrada. Interfaz con el micrófono simulado de Edge (`--use-fake-device-for-media-stream`): ~27 niveles/s entre 0 y 0,84, lista de micrófonos sin duplicados, modo y preferencias guardados, al apagar deja de enviar |
| Guardar la calibración (app real) | La app compilada abierta con depuración remota del WebView2 (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`) y manejada con puppeteer (`puppeteer.connect`), cara simulada con `window.__avatosTest`: asistente completo y **Guardar** → `calibracion.json` con `eyeRight` y medidas por ojo, el panel dice *calibrado*. El archivo del usuario se respalda antes y se restaura después |
| Umbral de ojos según el temblor | Interfaz con Tauri simulado: señal limpia y pequeña (dif. 0,05, temblor ±0,004) → se guarda con aviso, parpadeo 100 % cerrado y temblor 0 %; pequeña y ruidosa (dif. 0,06, ±0,04) → avisa con los números (necesita 0,102); como la del usuario (0,18→0,27) → se guarda sin aviso; casi plana → avisa con los números. `cargo test --lib calibration`: `eyeNoise` se guarda y se vuelve a leer |
| Calibración con ojos de rango estrecho | Interfaz con Tauri simulado y una persona con ojos desparejos: izq. 0,18→0,30 y der. 0,18→0,23 (antes fallaba con *no se notó la diferencia*) → se guarda con umbrales propios por ojo; der. casi sin cambio (0,18→0,20) → usa el promedio; ninguno cambia lo suficiente → avisa |
| Parpadeos falsos | `npm run test:blink`: 30 s de ojo abierto con ruido y un pico suelto cada ~0,8 s, más un parpadeo real cada 3 s, con los umbrales de una calibración real de rango estrecho (0,196 / 0,247): sin filtro, 32 cuadros con el ojo medio cerrado sin parpadear; con `SpikeFilter`, 0, y los 10 parpadeos reales completos. Página del avatar con esa calibración: con un pico cada 3 muestras los ojos quedan abiertos; un cierre sostenido los cierra |
| Calibración por ojo | Interfaz con Tauri simulado y una "persona" cuyo ojo derecho la cámara ve más cerrado (izq. 0,05 → 0,45; der. 0,35 → 0,80): umbrales distintos por ojo, dos medidores con sus marcas, `eyeRight` guardado. Con el umbral compartido anterior, el parpadeo del ojo izquierdo cerraba el del avatar al 15 %; ahora del todo. Página del avatar: guiño del ojo izquierdo con umbrales por ojo, y casi nada con el compartido. `cargo test --lib calibration` (formato `eyeRight`, validación) |
| Calibración mejorada | Misma técnica: una "persona" que tarda 350 ms en reaccionar no altera la medida (ojo cerrado medido 0,589 de 0,59 real); el medidor en vivo se pone naranja; deslizador de ojos a +1 → vista previa con `eyeClosed` 0,511 → 0,38; Guardar incluye `levels` y sensibilidad; "Ajustar" abre directo en el ajuste; Cancelar → `calibration_preview_end` |
| Calibración | Vite + Edge *headless* + Tauri simulado + gancho de prueba `window.__avatosTest` (**solo en modo desarrollo**, `import.meta.env.DEV`: `setTrackingOn`, `emitFrame`) con cuadros sintéticos: escenarios correcto (guarda valores y postura), ojos sin cerrar y sin cara (mensajes de error), Restablecer. En la página del avatar: una cabeza girada con `headOffset` igual se ve de frente |
| Tooltips | Misma técnica (Vite + Edge *headless* + Tauri simulado): no aparece a los 150 ms y sí a los 550 ms, `aria-describedby` presente, Tab lo muestra y Esc lo cierra, ninguno sale de la ventana ni pisa `[data-native-overlay]`, y cambia de texto al cambiar de idioma |
| Idiomas | Interfaz servida por Vite y abierta en Edge *headless* con la API de Tauri simulada (`window.__TAURI_INTERNALS__`); capturas en `es`/`en` y detección con `--lang=en-US`, `es-MX`, `fr-FR` (→ en, es, en) |
| Tipos estrictos de avatar y tracking | `npx tsc --ignoreConfig --noEmit --strict --target es2022 --module esnext --moduleResolution bundler --skipLibCheck --lib es2022,dom avatar/main.ts src/lib/tracking.ts` |
| Backend | `cargo build` en `src-tauri/` (sin advertencias) |
| Servidor local | `curl -H "Host: atacante.com:<puerto>" http://127.0.0.1:<puerto>/model.vrm` → 404 |
| Expresiones del avatar | Página del avatar en Edge *headless* (puppeteer) con un WebSocket que envía mensajes simulados; capturas por escenario (boca 0.15/0.30, parpadeo 0.40, sonrisa + parpadeo, cada emoción y un mensaje para otro `avatar`, que debe ignorarse). **Pendiente:** llevar este arnés al repositorio |
| Calibración de vocales | `npm run test:vowels` incluye las plantillas (también U y O cercanas: 100 % y ninguna confundida): voz normal y voz grave con F2 débil en A/O/U (formantes típicos 41 % y 16 % → plantillas 100 %), tono 15 % más alto que al calibrar (99 %), aviso cuando la U se dice igual que la O, plantillas dañadas ignoradas. Interfaz con Tauri simulado y el audio del micrófono reemplazado por vocales sintéticas de ese hablante (`AnalyserNode.prototype.getFloatTimeDomainData`; la prueba "dice" la vocal que pide la pantalla): sin calibrar E→I; calibrado, las 5 bien; se recuerda al recargar; Restablecer; silencio → aviso; Cancelar |
| Vocales | `npm run test:vowels`. **Voces reales:** palabras con vocales conocidas ("mamá, mesa, misa, moto, mudo, papá, pepe, pipa, popó, pupú") grabadas con las voces de Windows Raúl y Sabina (`Windows.Media.SpeechSynthesis`, SSML lento), analizadas directo y como micrófono simulado de la interfaz; para ver lo que recibe el analizador, la prueba envuelve `AnalyserNode.prototype.getFloatTimeDomainData` y guarda los bloques. (Las vocales sueltas "aaa" no sirven: la voz las deletrea.) Así se encontró que la O de una voz grave salía U (faltaba el ajuste al tono) y que los cortes entre sílabas salían A. De punta a punta: un WAV con A, E, I, O, U sintéticas como micrófono simulado de Edge (`--use-file-for-fake-audio-capture`) en la interfaz con Tauri simulado, con 5 voces (110–260 Hz): cada tramo envía su vocal (24 de 25 mediciones; la otra es la transición) y la letra aparece junto a **Voz**; con **Solo abrir y cerrar**, `vowels` es `null`. Página del avatar: las 5 formas en los dos avatares de prueba, un mensaje para otro `avatar` se ignora y la boca se cierra al dejar de llegar mensajes (al capturar, **seguir enviando** mensajes: una captura tarda más que `VOICE_TIMEOUT_S`) |
| Editor de atajos | Interfaz con Tauri simulado y teclas reales: Cambiar + Ctrl+Shift+T guarda `control+shift+KeyT` con pausa → reanudación; Esc cancela; Ctrl+Alt da el aviso de AltGr; un duplicado muestra el **nombre** de la acción; Quitar; Restablecer. App real con un `atajos.json` de prueba: un atajo quitado queda libre, uno nuevo se registra, uno inválido vuelve al de fábrica y una acción desconocida se ignora |
| Atajos registrados | Con avat-os abierto, intentar `RegisterHotKey(Ctrl+Shift+1…9)` desde PowerShell: debe **fallar** (error 1409) si la app los tiene; si se pudo, la app no los registró (y se liberan al instante) |
| Atajos globales | App real + cliente WebSocket en el canal; `SendKeys("^+1")` debe producir `{type:"expression",name:"happy"}`, repetir el atajo → `name:null`; un cliente que se conecta después recibe la expresión activa |

Al inyectar mensajes en la página del avatar, el servidor de prueba **no debe enviar su propio tracking** (escenario sin tracking): si no, sus cuadros se intercalan con los inyectados y el resultado se ve a medias.

Al usar Edge headless, **no uses `--virtual-time-budget`**: el reloj virtual avanza más rápido que los mensajes reales del WebSocket y el avatar cree que se perdió el tracking.

---

## 10. Licencias y dependencias

avat-os se distribuye bajo **GPL-3.0-or-later**. Todas las dependencias son compatibles:

| Dependencia | Licencia |
|---|---|
| OBS Studio / libobs | GPL-2.0-or-later |
| libobs-rs (`libobs-wrapper`, `libobs-simple`) | GPL-3.0 |
| Qt 6 (DLL que necesita obs-browser) | LGPL-3.0 |
| CEF (Chromium Embedded Framework) | BSD |
| Tauri, tiny_http, tungstenite, anyhow, serde | MIT / Apache-2.0 |
| three.js, @pixiv/three-vrm, Svelte, Vite | MIT |
| MediaPipe Tasks Vision + modelo `face_landmarker` | Apache-2.0 (compatible con GPL-3, no con GPL-2 solo) |
| DejaVu Sans Mono (contornos de las letras del logo) | Licencia de Bitstream Vera / dominio público (libre, permite modificar y redistribuir) |

**Logo** (`assets/logo.svg`): el dragón, el fondo y los brillos son un trazado del logo original (`assets/logo.png`) hecho con [vtracer](https://github.com/visioncortex/vtracer) (`--colormode color --mode spline --color_precision 6 --gradient_step 16 --filter_speckle 4`) después de borrar el anillo de la imagen; el anillo (arcos, puntos y conectores) y el texto «avat-os · código abierto» están redibujados, con las letras convertidas en contornos (no dependen de la fuente instalada). `static/logo.png` (cabecera e ícono de la interfaz) y `src-tauri/icons/` (`npx tauri icon`) salen de un render del SVG a 1024 px. Para cambiar el texto del anillo hay que volver a generar el SVG.

**Avatares de prueba** (no se distribuyen con el código): Seed-san (VirtualCast, VRM Public License 1.0, requiere crédito) y VRM1_Constraint_Twist_Sample (pixiv, VRM Public License 1.0).

---

## 11. Convenciones

- **Idioma:** comentarios, logs y documentación en **español**; identificadores de código en inglés.
- **Interfaz multilingüe (obligatorio):** **ningún texto visible se escribe directamente en el código**; todo texto nuevo se agrega a `es.json` **y** `en.json` y se usa con `t("clave")`. Los comandos de Rust devuelven **códigos de error** (constantes `ERR_*` o `"código: detalle"`), con su traducción en `errors.*`. Los logs y los comentarios siguen en español. Más idiomas después de la v1 con Weblate/Crowdin.
- **Tooltips (obligatorio):** toda opción o selector de archivos no obvio lleva `use:tooltip={t("tooltips.…")}` (nunca el atributo `title`). Si el elemento no es un botón o un campo, se agrega un `<button type="button" class="info">ⓘ</button>` con el tooltip (no hacer enfocables `span` o `div`). Las partes que todavía no funcionan llevan ⓘ con `tooltips.comingSoon`. Toda zona tapada por una ventana nativa lleva `data-native-overlay`.
- **Cabecera de licencia** en cada archivo fuente:
  ```
  // avat-os — Copyright (C) 2026 avat-os contributors
  // SPDX-License-Identifier: GPL-3.0-or-later
  ```
- **Rust:** sin advertencias de `cargo build`; errores con `anyhow` y contexto en español; comandos Tauri devuelven `Result<_, String>`.
- **TypeScript:** debe pasar `--strict`.
- **Documentación:** todo cambio visible para el usuario actualiza [GUIA-DE-USUARIO.md](GUIA-DE-USUARIO.md); todo cambio de arquitectura, comandos, protocolos o parámetros actualiza esta guía; y se marca el avance en [tareas.md](../tareas.md).

---

## 12. Problemas conocidos

| Problema | Causa / estado |
|---|---|
| `cargo-obs-build` borra Qt6 y `obs-frontend-api.dll`, que obs-browser necesita (error 126 al cargar `obs-browser.dll`) | Fallo de la herramienta. `build.rs` las extrae del zip oficial de OBS 32.1.2 (SHA-256 fijado). Si cambia la versión de OBS, actualizar `OBS_VERSION`, `OBS_ZIP_URL` y `OBS_ZIP_SHA256`. Pendiente reportarlo a libobs-rs |
| El avatar tarda en aparecer con el equipo muy cargado | Sin carga, la página del avatar dentro de OBS se conecta en 1–3 s; justo después de una compilación larga (con el analizador de Rust del editor también compilando) se midieron **73 s** hasta que CEF arrancó. El panel muestra *cargando…* mientras tanto |
| Al cargar un avatar justo al arrancar, la página se abre dos veces seguidas | Se ven dos *Cargando* / *Avatar listo* en el log. No afecta a lo que se ve; pendiente revisar si queda un segundo renderizador de CEF activo |
| Ícono genérico en la barra de tareas (resuelto) | Tauri solo asigna el ícono **pequeño** de la ventana; sin el grande, Windows usa el del .exe a través de su caché, que con las recompilaciones de `tauri dev` puede quedar genérica. `win_icon.rs` carga el recurso **32512** del .exe (el que incrusta tauri-build desde `icons/icon.ico`) y lo asigna con `WM_SETICON` / `ICON_BIG` al arrancar. Si cambia el identificador del recurso, actualizar `APP_ICON_ID` |
| La app tarda ~10 s en terminar el proceso | Apagado de CEF. La ventana se oculta en ~35 ms y el apagado ocurre en segundo plano |
| En el log: `Failed to get NVVideoEffects.dll` y `obs_frontend_add_event_callback with no callbacks` | Inofensivos: plugin de NVIDIA sin GPU NVIDIA y obs-browser sin la interfaz de OBS |
| La RAM del navegador del avatar ronda 720 MB | Costo de CEF. Motiva la "opción B" (render nativo en Rust) |
| `npm audit` muestra 5 avisos *low* de SvelteKit | Afectan a funciones de servidor que no usamos (app estática) |
| La página del avatar en producción | `avatar_site_dir()` apunta a `CARGO_MANIFEST_DIR/../avatar/dist`; falta empaquetarla como recurso de Tauri (Fase 6) |

---

## 13. Registro de decisiones

| Fecha | Decisión | Motivo |
|---|---|---|
| 2026-11-05 | Licencia GPL-3.0-or-later | Proyecto 100 % open source; compatible con libobs y Apache-2.0 |
| 2026-11-05 | Rust + Tauri; Windows primero | Preferencia del proyecto; Linux solo si no cuesta trabajo extra |
| 2026-11-05 | libobs vía libobs-rs | Captura, codificación por hardware y MP4 ya resueltos |
| 2026-11-05 | Avatar como página web three-vrm en obs-browser (opción A) | Soporte VRM maduro y rápido de implementar. La opción B (render nativo) queda para después de la v1 |
| 2026-11-06 | Tracking con MediaPipe en la interfaz en lugar de ONNX en Rust | Da directamente 52 expresiones y la pose de la cabeza. El tracking nativo en Rust queda para después |
| 2026-11-06 | La sonrisa no activa `happy` | Las emociones bloquean el parpadeo y la boca en muchos VRM |
| 2026-11-06 | Diseño para N avatares | Preparar el *modo dúo* sin rehacer la arquitectura |
| 2026-11-06 | Mensajes del canal con `type` + `avatar` y mensajes "pegajosos" | Un solo canal para tracking y expresiones; la expresión sobrevive a la recarga de la página |
| 2026-11-06 | Atajos `Ctrl+Shift+1…5`, no `Ctrl+Alt` | `Ctrl+Alt` = AltGr en teclados en español |
| 2026-11-06 | Respetar siempre `overrideMouth`/`overrideBlink` del autor del VRM (sin opción para ignorarlos) | Es lo que pide el estándar VRM; evita caras deformadas al mezclar formas de boca |
| 2026-11-06 | Idiomas (es/en primero) y tooltips propios en Fase 1 | Barato mientras la interfaz es pequeña; más idiomas con Weblate/Crowdin tras la v1 |
| 2026-11-06 | i18n con un sistema propio mínimo en lugar de Paraglide JS | Interfaz pequeña; sin dependencias ni paso de compilación extra; JSON estándar; tipos que detectan claves y traducciones faltantes. Migrar a Paraglide más adelante es sencillo |
| 2026-11-06 | Errores de Rust como códigos traducidos por la interfaz | Los mensajes deben salir en el idioma del usuario |
| 2026-11-06 | Tooltips propios con acción de Svelte, sin librería (Floating UI, Tippy) | Una sola regla especial (evitar la vista previa nativa) y pocas líneas; sin dependencias |
| 2026-11-06 | Calibración guardada por Rust en un archivo (no `localStorage`) y enviada como mensaje pegajoso | Persistencia fiable y una sola fuente de verdad para todas las páginas de avatar |
| 2026-11-07 | Vocales por formantes (raíces de LPC) en la interfaz, sin dependencias ni entrenamiento | Funciona para cualquier persona sin calibrar; solo viajan 5 números; ante la duda (ruido) mantiene la forma anterior en vez de equivocarse |
| 2026-11-07 | Fondos de video en la página del avatar (`<video>` silenciado) con rangos de bytes en el servidor | Lo más simple que funciona en la fuente de navegador; sin rangos, el video se leería entero en cada vuelta. El sonido queda para el mezclador (Fase 3) |
| 2026-11-07 | Logo vectorial: dragón trazado + anillo y texto redibujados («avat-os · código abierto») | El texto del anillo original estaba mal escrito ("codiga", "codiles", letras al revés); el anillo nuevo es nítido a cualquier tamaño y las letras no dependen de la fuente instalada |
| 2026-11-07 | Filtro de picos (mediana de 3) en los párpados y margen mínimo de 0,03 en la calibración | El usuario vio parpadeos falsos: su rango de ojos es estrecho y cada pico de ruido cruzaba el umbral; la mediana de 3 quita picos de 1 muestra sin perder parpadeos reales (3–5 muestras) |
| 2026-11-07 | Umbrales de los ojos por ojo (mismo paso del asistente) | La cámara ve un ojo más cerrado que el otro; un umbral compartido no cerraba del todo el ojo "más abierto" |
| 2026-11-07 | Anti-temblor One Euro sobre cada muestra + interpolación por cuadro, en lugar de un suavizado fijo por cuadro | Un suavizado fijo obliga a elegir entre temblor y retraso; One Euro suaviza mucho quieto y poco en movimiento: menos temblor **y** menos retraso (medido) |
| 2026-11-07 | El último avatar se carga solo al arrancar, ya en la URL inicial de la fuente | Es lo que se espera de un programa de VTuber y evita la doble carga de la página (vacía → con modelo) |
| 2026-11-12 | Plantillas de vocales en **escala mel** (perfil versión 3) | En la calibración real del usuario la U y la O quedaron casi iguales con el cepstrum lineal y se confundían; la escala mel da más detalle en los graves, donde se distinguen |
| 2026-11-11 | El editor de atajos guarda la tecla según la tecla virtual real (`keyCode`), no la posición física (`code`) | `global-hotkey` traduce con una tabla de teclado de EE. UU.: en teclados en español los símbolos (ñ, +, ´…) quedaban registrados en otra tecla |
| 2026-11-11 | La calibración de vocales guarda **plantillas de la forma del espectro** (cepstrum LPC) en vez de F1/F2 (perfil versión 2) | Con el micrófono real del usuario la F2 de A/O/U se perdía y su U y su O calibradas quedaron casi iguales; la forma completa no depende de encontrar dos resonancias. LPCC en vez de MFCC por aguantar mejor la entonación |
| 2026-11-07 | Calibración de vocales por persona (opcional), guardada en este equipo | Con voces reales, la E de una persona caía en la I típica y la O en la E: ningún valor típico sirve para todas las voces. Sin calibrar sigue funcionando con los típicos ajustados por tono |
| 2026-11-07 | Valores típicos ajustados al **tono medio** de quien habla, en vez de unos fijos "entre voces graves y agudas" | Con valores fijos, la O de una voz grave caía en la U y la U de una voz aguda en la O (se solapan: ~430 frente a ~400 Hz) |
| 2026-11-07 | Atajos por acción con editor; tracking y lip-sync sin atajo de fábrica | Cambiar combinaciones que chocan con juegos u otros programas; un atajo global le quita la combinación a todos los programas |
| 2026-11-06 | Una sola copia de avat-os y aviso + reintento de los atajos que fallen | Un atajo ocupado fallaba en silencio (solo en el log) |
| 2026-11-06 | Gestos animados por código (sin archivos de animación) | Sin licencias de terceros y funcionan en cualquier VRM con huesos estándar; importar animaciones queda para después de la v1 |
| 2026-11-06 | Encuadre calculado con la altura de la cabeza de cada avatar | Con una cámara fija, los avatares más bajos o más altos quedaban mal encuadrados |
| 2026-11-06 | Secciones avanzadas del panel plegables | El panel ya necesita desplazamiento; lo menos usado queda cerrado |
| 2026-11-06 | Fondo del avatar como fondo CSS de su página (no como textura de three.js) | Los GIF/WebP animados funcionan sin código extra y el lienzo del avatar sigue transparente |
| 2026-11-06 | Lip-sync por volumen en la interfaz; la boca combina cámara y voz con `max()` | Funciona sin cámara y no apaga la boca de la cámara cuando ríes en silencio; las vocales quedan para después |
| 2026-11-06 | Asignar el ícono grande de la ventana con `windows-sys` | La barra de tareas no debe depender de la caché de íconos de Windows |
| 2026-11-06 | Calibración: guardar las medidas originales + sensibilidad, y vista previa sin guardar | Ajustar sin repetir los pasos y ver el efecto antes de confirmar |
| 2026-11-06 | Asistente dentro del panel y con pitidos | Un modal quedaría bajo la vista previa nativa; con los ojos cerrados no se puede leer |
| 2026-11-06 | Sin enlaces dentro de los tooltips | Un tooltip no se puede pulsar ni lo recorre el lector de pantalla; la ayuda extendida irá en un botón "?" |
