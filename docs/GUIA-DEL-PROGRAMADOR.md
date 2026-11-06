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
└──────────────┬───────────────────────────────────────────────────────────────────┘
               │ invoke(): preview_set_bounds · avatar_load · tracking_update · …
┌──────────────▼──────────────────────── Núcleo Rust (src-tauri) ──────────────────┐
│  lib.rs              arranque, comandos Tauri, cierre                              │
│  expressions.rs      emociones VRM: atajos globales Ctrl+Shift+1…5 y botones       │
│  calibration.rs      calibración de la persona (guardada en calibracion.json)      │
│  obs.rs              libobs: escena, fuentes, vista previa (ventana nativa hija)   │
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
| `npm run tauri build` | Compila la versión de producción (el instalador aún no está listo, ver Fase 5) |
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
├── assets/logo.png              Logo original (README, iconos)
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
│   ├── lib/tooltip.ts           Tooltips accesibles (use:tooltip)
│   ├── lib/Calibration.svelte   Asistente de calibración (3 pasos)
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
│       ├── avatar_server.rs     Servidor HTTP local del avatar
│       ├── calibration.rs       Calibración (umbrales y postura de frente)
│       ├── expressions.rs       Emociones VRM y atajos globales
│       ├── tracking_relay.rs    WebSocket local (tracking + expresiones)
│       └── win_icon.rs          Ícono grande de la ventana (barra de tareas)
├── static/                      Archivos estáticos de la interfaz (logo, mediapipe/ ignorado)
├── tareas.md                    Plan de trabajo por fases
└── LICENSE                      GPL-3.0
```

---

## 5. Módulos en detalle

### `src-tauri/src/obs.rs` — motor de video

- `Obs::start(window, config_dir, tracking_port)`:
  - Arranca libobs con lienzo `CANVAS_WIDTH × CANVAS_HEIGHT` (1920×1080) y `module_config_path` en `%APPDATA%\com.avatos.app\obs` (para que los plugins no escriban en el directorio de trabajo).
  - Crea la escena de prueba: captura del monitor principal (DXGI) + fuente `browser_source` "Avatar" apuntando a `AvatarServer::url()`.
  - Crea la vista previa con `ObsDisplayCreationData` sobre el HWND de la ventana principal. libobs-wrapper crea una **ventana nativa hija** (`WS_CHILD`) encima del WebView2.
- `set_bounds()`: la interfaz envía la posición del recuadro "Vista previa" en **píxeles físicos** (CSS × `devicePixelRatio`) mediante un `ResizeObserver`.
- **Orden de liberación:** `context` es el **último** campo del struct; Rust libera en orden de declaración y libobs debe apagarse después de soltar la vista previa y las fuentes.
- Estado compartido: `ObsState(Mutex<Option<Obs>>)`; `None` si libobs no arrancó o la app se está cerrando.

### `src-tauri/src/avatar_server.rs` — servidor HTTP local

- Escucha en `127.0.0.1:0` (puerto aleatorio), un hilo `avatar-server`.
- Rutas: `/model.vrm` → archivo elegido por el usuario; cualquier otra → archivos de `avatar/dist/` (con `canonicalize` + `starts_with` para impedir `../`).
- Rechaza (404) peticiones cuyo `Host` no sea exactamente `127.0.0.1:<puerto>` (anti *DNS rebinding*) y métodos distintos de GET.
- `/status?state=loading|loaded|error&detail=…` (GET, mismo control de `Host`): la página informa su estado; `parse_status()` solo acepta esos tres estados y recorta el detalle a 300 caracteres. `obs.rs` lo guarda en `AvatarStatusState`, lo registra en el log (`Avatar listo…` / `El avatar no se pudo cargar…`) y emite el evento `avatar-status`. Prueba unitaria: `cargo test --lib avatar_server`.
- URL de la fuente: `http://127.0.0.1:<puerto>/?v=<versión>&ws=<puerto_tracking>&id=<avatar>`; `v` cambia al cargar otro avatar para forzar la recarga; `id` es el identificador del avatar (hoy `main`).

### `src-tauri/src/tracking_relay.rs` — canal en vivo (WebSocket)

- Escucha en `127.0.0.1:0`, hilo `tracking-relay`. Valida `Host` en el *handshake* (403 si no coincide).
- Tiempos límite por socket: lectura 2 s (handshake), escritura 100 ms. Un cliente que no lee se desconecta y la página se reconecta sola en 1 s.
- `broadcast()` envía el JSON a todos los clientes y descarta los cerrados.
- `set_sticky(clave, json)`: como `broadcast`, pero guarda el último mensaje de esa clave y lo **reenvía a cada página que se conecta** (así la expresión activa sobrevive a la recarga de la página al cambiar de avatar). Orden de bloqueo: `clients` → `sticky`, igual en ambos sitios para evitar interbloqueos.

### `src-tauri/src/expressions.rs` — expresiones y atajos

- Tabla `EXPRESSIONS`: `happy`, `angry`, `sad`, `surprised`, `relaxed` con `Ctrl+Shift+1…5`. **No usar `Ctrl+Alt`**: en teclados en español equivale a AltGr.
- `shortcuts_plugin()` crea `tauri-plugin-global-shortcut` con el manejador; `register_shortcuts()` los registra en `setup` (si otro programa ya usa uno, `log::warn!` y sigue).
- `toggle()`: pulsar la expresión activa vuelve a neutral; lee y cambia el estado con un solo bloqueo (un atajo y un botón simultáneos no se pisan). `notify()` envía el resultado; `apply()` guarda el estado (`ExpressionState`), envía `{type:"expression"}` con `set_sticky("expression:<avatar>")` y emite el evento `expression-changed` a la interfaz.
- Los botones del panel llaman a `expression_set`; la interfaz escucha `expression-changed` para reflejar también los atajos.

### `src/lib/tracking.ts` — tracking facial

- `FaceTracker.start()`: crea el `FaceLandmarker` (GPU, con *fallback* a CPU), abre la webcam (640×480, 30 fps ideal).
- `loop()`: un `detectForVideo` por cuadro nuevo; envía como máximo cada `SEND_INTERVAL_MS` (33 ms).
- `toFrame()`: descompone la matriz (`Matrix4.decompose`) para separar rotación de escala; Euler en orden `YXZ`.
- `onStats()` (1 Hz): FPS, cara detectada y último cuadro (el panel muestra boca y ojos para calibrar).
- WebView2 se lanza con `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows` (`additionalBrowserArgs` en `tauri.conf.json`) para que el tracking no se pause si la ventana queda tapada.

### `src-tauri/src/calibration.rs` + `src/lib/Calibration.svelte` — calibración

- **Asistente (interfaz):** 3 capturas de `REACTION_MS + CAPTURE_MS` (0,4 + 1,5 s; los primeros 0,4 s se descartan como tiempo de reacción) tras una cuenta atrás de 3 s: de frente → ojos cerrados (entre dos pitidos de `AudioContext`, porque la persona no ve la pantalla) → boca abierta. Recibe los cuadros con `subscribe()` (`frameListeners` de `+page.svelte`).
- **Medidas (`Levels`):** ojo abierto = percentil 90 del paso 1; ojo cerrado = mediana del paso 2; boca en reposo = percentil 90 del paso 1; boca máxima = percentil 95 del paso 3. Se guardan para poder recalcular.
- **Umbrales (`thresholds()`)** con sensibilidad `s` de −1 a 1: `eyeOpen = abierto + (0,25 − 0,1·s)·rango`, `eyeClosed = abierto + (0,85 − 0,25·s)·rango`; `mouthClosed = reposo + 0,02`, `mouthOpen = reposo + (0,6 − 0,25·s)·rango`.
- **Prueba y ajuste:** medidores en vivo (`{#snippet meter}`, con marcas en los dos umbrales) y deslizadores; cada cambio llama a `calibration_preview` (aplica al avatar **sin guardar**). Cancelar o cerrar el asistente sin guardar llama a `calibration_preview_end` (vuelve a lo guardado). "Ajustar" abre el asistente con `initial` = la calibración guardada (si tiene `levels`) directo en este paso. Indicador "te veo" si llegó un cuadro en los últimos 500 ms; **Empezar** se desactiva sin cara.
- `initial` y `subscribe` se leen una sola vez (`untrack`): el asistente trabaja con su propia copia. `headOffset` y `restPos` = medianas del paso 1. Rango mínimo `MIN_RANGE` (0,08): si no, error `calibration_eyes` / `calibration_mouth`; menos de 5 cuadros → `calibration_no_face`.
- **Va dentro del panel lateral**, no en un modal: un modal centrado quedaría bajo la vista previa nativa.
- Se envía con `$state.snapshot()`: un proxy reactivo de Svelte no se puede copiar por la comunicación con Rust.
- **Formato:** `levels`, `eyeSensitivity` y `mouthSensitivity` son opcionales (`#[serde(default)]`): los `calibracion.json` anteriores siguen siendo válidos. Pruebas: `cargo test --lib calibration`.
- **Rust:** `CalibrationState::load()` lee `<app_config_dir>/calibracion.json` al arrancar (si es válido); `calibration_set` valida (valores 0–1, `eyeOpen < eyeClosed`, `mouthClosed < mouthOpen`, números finitos), guarda y publica; `calibration_reset` borra el archivo. `publish()` envía el mensaje pegajoso `calibration`.
- **Página del avatar:** sin calibración usa `EYE_*`/`MOUTH_*`; con ella, sus umbrales, resta `headOffset` a la rotación de la cabeza y usa `restPos` fijo (sin el recentrado de 8 s).

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
| `avatar_status` | — | `{ state, detail } \| null` (último estado informado por la página) | `obs.rs` |
| `tracking_update` | `frame: TrackingFrame` | `()` | `tracking_relay.rs` |
| `expression_list` | — | `{ name, shortcut }[]` | `expressions.rs` |
| `expression_current` | — | `string \| null` | `expressions.rs` |
| `calibration_get` | — | `Calibration | null` | `calibration.rs` |
| `calibration_set` | `values: Calibration` | `()` / `calibration_invalid` | `calibration.rs` |
| `calibration_preview` | `values: Calibration` | `()` / `calibration_invalid` — aplica al avatar sin guardar | `calibration.rs` |
| `calibration_preview_end` | — | `()` — vuelve a la calibración guardada | `calibration.rs` |
| `calibration_reset` | — | `()` | `calibration.rs` |
| `expression_set` | `name: string \| null`: un nombre **alterna** esa expresión (como su atajo); `null` = neutral | `()` / error si el nombre no existe | `expressions.rs` |

**Eventos Rust → interfaz:** `expression-changed` (payload `string | null`), emitido tanto por los atajos como por `expression_set`; `avatar-status` (payload `{ state: "loading" | "loaded" | "error", detail }`), cuando la página del avatar informa su estado.

### Mensajes del canal en vivo (JSON por WebSocket)

Todos llevan `type` y `avatar` (id de destino; la página ignora los de otro id):

```jsonc
{ "type": "tracking",   "avatar": "main", "frame": { /* TrackingFrame */ } }   // ~30 por segundo
{ "type": "expression", "avatar": "main", "name": "happy" }                    // null = neutral; "pegajoso"
{ "type": "calibration", "avatar": "main", "values": { /* Calibration */ } }   // null = por defecto; "pegajoso"
```

### `Calibration` (camelCase)

```jsonc
{ "eyeOpen": 0.2, "eyeClosed": 0.51, "mouthClosed": 0.05, "mouthOpen": 0.32,
  "headOffset": [pitch, yaw, roll],   // rad: rotación "de frente" de la persona
  "restPos": [x, y, z],                // cm: posición de reposo de la cabeza
  "levels": { "eyeOpen": 0.07, "eyeClosed": 0.59, "jawRest": 0.03, "jawMax": 0.51 },  // opcional
  "eyeSensitivity": 0, "mouthSensitivity": 0 }                                     // opcionales, −1 a 1
```

### `TrackingFrame`

```jsonc
{
  "head":    [pitch, yaw, roll],   // radianes; positivos según three.js (Y arriba, Z hacia la cámara)
  "headPos": [x, y, z],            // cm respecto de la cámara (z negativo = delante de la cámara)
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

Valores que hoy están fijos en el código y que la **calibración** (Fase 1) pasará a la interfaz. La [guía de usuario](GUIA-DE-USUARIO.md#7-calibración-y-ajustes-de-ojos-boca-y-cuerpo) explica cómo elegirlos.

| Constante / expresión | Archivo | Valor | Efecto |
|---|---|---|---|
| `EYE_OPEN` / `EYE_CLOSED` | `avatar/main.ts` | 0.20 / 0.55 | Rango del parpadeo que se mapea a 0–1 (**solo sin calibración**) |
| `MOUTH_CLOSED` / `MOUTH_OPEN` | `avatar/main.ts` | 0.03 / 0.35 | Rango de `jawOpen` que se mapea a `aa` (**solo sin calibración**) |
| `COUNTDOWN_S`, `REACTION_MS`, `CAPTURE_MS`, `MIN_RANGE` | `src/lib/Calibration.svelte` | 3 s · 0,4 s · 1,5 s · 0,08 | Asistente de calibración |
| Fórmulas de `thresholds()` | `src/lib/Calibration.svelte` | ver la sección del módulo | Umbrales según medidas y sensibilidad |
| `mouthFunnel * 1.5` | `avatar/main.ts` | 1.5 | Ganancia de la expresión `ou` |
| `delta * 18` | `avatar/main.ts` | 18 s⁻¹ | Suavizado de cabeza y cuerpo |
| `delta * 45` | `avatar/main.ts` | 45 s⁻¹ | Suavizado de ojos y boca |
| `* 0.012`, tope `0.25` | `avatar/main.ts` | rad/cm | Inclinación lateral del torso |
| `* 0.01`, tope `0.2` | `avatar/main.ts` | rad/cm | Inclinación frontal del torso |
| Reparto del giro | `avatar/main.ts` | spine 0.15 · chest 0.15 · neck 0.3 · head 0.4 | Debe sumar 1 |
| `delta / 8` | `avatar/main.ts` | 8 s | Recentrado de la postura de reposo (solo sin calibración) |
| `TRACKING_TIMEOUT_S` | `avatar/main.ts` | 0.5 s | Sin datos → animación de reposo |
| `delta * 12` (`applyExpressions`) | `avatar/main.ts` | 12 s⁻¹ | Fundido entre expresiones (~0,2 s) |
| `EXPRESSIONS` / `MODS` | `src-tauri/src/expressions.rs` | Ctrl+Shift+1…5 | Atajos globales de las emociones |
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

**Pendiente** (Fase 5): activar la CSP (`"csp": null` hoy) y quitar el plugin `opener` si no se usa.

> ⚠️ **El repositorio es público.** Antes de cada commit revisa `git status`: nunca subas avatares, grabaciones, logs, `.env`, tokens ni documentos personales.

---

## 9. Pruebas y verificación

Todavía no hay pruebas automáticas en el repositorio (pendiente). Verificación actual:

| Qué | Cómo |
|---|---|
| Tipos de la interfaz | `npm run check` (también detecta claves de idioma inexistentes y traducciones incompletas) |
| Calibración mejorada | Misma técnica: una "persona" que tarda 350 ms en reaccionar no altera la medida (ojo cerrado medido 0,589 de 0,59 real); el medidor en vivo se pone naranja; deslizador de ojos a +1 → vista previa con `eyeClosed` 0,511 → 0,38; Guardar incluye `levels` y sensibilidad; "Ajustar" abre directo en el ajuste; Cancelar → `calibration_preview_end` |
| Calibración | Vite + Edge *headless* + Tauri simulado + gancho de prueba `window.__avatosTest` (**solo en modo desarrollo**, `import.meta.env.DEV`: `setTrackingOn`, `emitFrame`) con cuadros sintéticos: escenarios correcto (guarda valores y postura), ojos sin cerrar y sin cara (mensajes de error), Restablecer. En la página del avatar: una cabeza girada con `headOffset` igual se ve de frente |
| Tooltips | Misma técnica (Vite + Edge *headless* + Tauri simulado): no aparece a los 150 ms y sí a los 550 ms, `aria-describedby` presente, Tab lo muestra y Esc lo cierra, ninguno sale de la ventana ni pisa `[data-native-overlay]`, y cambia de texto al cambiar de idioma |
| Idiomas | Interfaz servida por Vite y abierta en Edge *headless* con la API de Tauri simulada (`window.__TAURI_INTERNALS__`); capturas en `es`/`en` y detección con `--lang=en-US`, `es-MX`, `fr-FR` (→ en, es, en) |
| Tipos estrictos de avatar y tracking | `npx tsc --ignoreConfig --noEmit --strict --target es2022 --module esnext --moduleResolution bundler --skipLibCheck --lib es2022,dom avatar/main.ts src/lib/tracking.ts` |
| Backend | `cargo build` en `src-tauri/` (sin advertencias) |
| Servidor local | `curl -H "Host: atacante.com:<puerto>" http://127.0.0.1:<puerto>/model.vrm` → 404 |
| Expresiones del avatar | Página del avatar en Edge *headless* (puppeteer) con un WebSocket que envía mensajes simulados; capturas por escenario (boca 0.15/0.30, parpadeo 0.40, sonrisa + parpadeo, cada emoción y un mensaje para otro `avatar`, que debe ignorarse). **Pendiente:** llevar este arnés al repositorio |
| Atajos globales | App real + cliente WebSocket en el canal; `SendKeys("^+1")` debe producir `{type:"expression",name:"happy"}`, repetir el atajo → `name:null`; un cliente que se conecta después recibe la expresión activa |

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
| La página del avatar en producción | `avatar_site_dir()` apunta a `CARGO_MANIFEST_DIR/../avatar/dist`; falta empaquetarla como recurso de Tauri (Fase 5) |

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
| 2026-11-06 | Asignar el ícono grande de la ventana con `windows-sys` | La barra de tareas no debe depender de la caché de íconos de Windows |
| 2026-11-06 | Calibración: guardar las medidas originales + sensibilidad, y vista previa sin guardar | Ajustar sin repetir los pasos y ver el efecto antes de confirmar |
| 2026-11-06 | Asistente dentro del panel y con pitidos | Un modal quedaría bajo la vista previa nativa; con los ojos cerrados no se puede leer |
| 2026-11-06 | Sin enlaces dentro de los tooltips | Un tooltip no se puede pulsar ni lo recorre el lector de pantalla; la ayuda extendida irá en un botón "?" |
