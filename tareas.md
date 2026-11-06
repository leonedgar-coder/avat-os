# avat-os — Plan de trabajo

> Avatar 3D + producción de video en una sola app. Open source: **GPL-3.0-or-later** (GPL 3, la versión más reciente, y cualquier versión futura).
> Stack: **Rust + Tauri** (interfaz) · **libobs** (motor de video/audio/grabación) · **VRM** (avatares 3D).
> Plataforma: **Windows** (oficial). Linux solo si sale "gratis" (código portable, sin prometerlo).

---

## Alcance de la versión 1.0

| Avatar (tipo Animaze) | Producción (tipo OBS) |
|---|---|
| Cargar avatar 3D (VRM 0.x y 1.0) | Escenas y fuentes: cámara, pantalla, ventana, imagen, texto |
| Seguimiento facial por webcam (cabeza, ojos, boca, parpadeo) | Mezclador de audio: micrófono + sonido del escritorio |
| Lip-sync con la voz | Grabar a archivo MP4 |
| Expresiones y gestos con atajos de teclado | Chroma key (fondo verde/azul/color) en cualquier fuente |
| Fondos y efectos del avatar | |

**Fuera de la v1 (después):** transmisión RTMP, cámara virtual, avatares 2D libres (Inochi2D), manos/cuerpo, modo dúo (dos avatares conversando), eventos de chat, plugins.

---

## Arquitectura

```
┌──────────────────── Interfaz (Tauri · SvelteKit) ────────────────────┐
│  Escenas, fuentes, mezclador, avatar, atajos                          │
│  Tracking: webcam ─► MediaPipe Face Landmarker ─► cabeza + expresiones│
└───────────────┬───────────────────────────────────────────────────────┘
                │ comandos Tauri (preview, avatar, tracking a 30 fps)
┌───────────────▼──────────────── Núcleo Rust ─────────────────────────┐
│  Servidor local 127.0.0.1: página del avatar + modelo .vrm            │
│  Canal WebSocket 127.0.0.1: reenvía el tracking a la página del avatar│
│  libobs: escenas · fuentes · audio · codificación · MP4 · vista previa│
│     └─ fuente "Avatar" = navegador de OBS con three-vrm (transparente)│
└───────────────────────────────────────────────────────────────────────┘
```

- **Todo es local:** la cámara, el avatar y el tracking nunca salen del equipo; los servidores internos solo aceptan conexiones de `127.0.0.1`.
- **El avatar es una fuente más** de la escena: se mueve, escala y ordena igual que una imagen.
- **Regla de diseño — varios avatares:** aunque la v1 use uno solo, todo se diseña para **N avatares** (pensando en el *modo dúo*): cada fuente "Avatar" tiene un identificador, los mensajes de tracking, expresiones y lip-sync llevan el identificador del avatar destino, y la configuración guarda una lista de avatares, no uno solo.
- **Pendiente:** si se usa la webcam a la vez para el tracking y como fuente "Cámara" de libobs, comprobar que Windows permite compartirla.

---

## Fase 0 — Base y pruebas de riesgo (spikes)

Antes de construir encima, comprobar que las piezas difíciles funcionan juntas.

- [x] Instalar herramientas: Rust (rustup), Node.js, Tauri CLI, Visual Studio Build Tools
- [x] `git init`, archivo `LICENSE` (GPL-3.0-or-later), `README.md` con el logo
- [x] Proyecto Tauri vacío con el tema de avat-os (oscuro + naranja/morado)
- [x] **Spike 1 — libobs desde Rust:** ✅ `libobs-wrapper` 10 + `libobs-simple` 9 (GPL-3.0). Graba 5 s de pantalla a MP4 híbrido con QuickSync → [spikes/obs-record](spikes/obs-record)
- [x] **Spike 2 — vista previa dentro de Tauri:** ✅ ventana nativa hija de libobs sobre el recuadro web, se reacomoda con `ResizeObserver` y se cierra limpio → [src-tauri/src/obs.rs](src-tauri/src/obs.rs)
- [x] **Spike 3 — renderizar VRM:** ✅ opción A: página web three-vrm ([avatar/](avatar)) servida por un servidor local (`127.0.0.1`) y cargada como fuente de navegador transparente → [src-tauri/src/avatar_server.rs](src-tauri/src/avatar_server.rs). Medido en Iris Xe: ~8 % CPU, GPU 33 % total, navegador ~720 MB RAM
  - Nota: `cargo-obs-build` borra Qt6 y `obs-frontend-api.dll`, que obs-browser necesita; `build.rs` las repone del paquete oficial de OBS (con verificación SHA-256). Reportar el fallo a libobs-rs
  - [x] Cerrar más rápido: la ventana se oculta en ~35 ms; OBS y CEF terminan de apagarse en segundo plano (~10 s)
  - [x] La interfaz muestra el nombre del avatar también si se cargó con `AVATOS_VRM` (variable solo para desarrollo)
- [x] **Spike 4 — tracking facial:** ✅ MediaPipe Face Landmarker (Apache-2.0) en la interfaz → [src/lib/tracking.ts](src/lib/tracking.ts); Rust lo reenvía por WebSocket local → [src-tauri/src/tracking_relay.rs](src-tauri/src/tracking_relay.rs); el avatar aplica cabeza, parpadeo y boca
  - Cambio de plan: en lugar de ONNX en Rust se usa MediaPipe (da directamente 52 expresiones + rotación de la cabeza). El motor y el modelo se guardan en local (`npm run fetch:tracking`), sin internet
  - [x] Código listo y compilando
  - [x] Probado con cámara real: giro como espejo ✅, ~56 FPS en Iris Xe (a veces 45). El parpadeo no cerraba del todo → se reescaló (umbrales 0.2–0.55) y se suavizan los ojos más rápido; falta confirmar
  - [x] El tracking sigue con otra ventana encima de avat-os ✅
- [x] Decidir la arquitectura final según los resultados de los spikes → ver el diagrama de **Arquitectura** (avatar web three-vrm en libobs + tracking MediaPipe en la interfaz)
- [ ] Vectorizar el logo y corregir el texto del anillo

## Fase 1 — Avatar

### Interfaz: idiomas y ayuda (hacerlo pronto: cuesta poco mientras la interfaz es pequeña)

- [x] **Idiomas — español e inglés**, con la estructura lista para N idiomas → [src/lib/i18n/](src/lib/i18n)
  - [x] Un archivo de textos por idioma (`es.json`, `en.json`); ningún texto escrito directamente en la interfaz. Se eligió un **sistema propio mínimo** (sin dependencias; JSON estándar compatible con Weblate/Crowdin; TypeScript avisa si falta una clave o una traducción) en lugar de Paraglide JS
  - [x] Idioma inicial = el de Windows (si no existe, inglés) + selector que se recuerda (por ahora en la barra superior; se moverá a Ajustes cuando exista esa ventana)
  - [x] Migrar todos los textos actuales de la interfaz
  - [x] Errores de Rust como **códigos** que la interfaz traduce (`engine_not_running`, `avatar_invalid_file`, `expression_unknown`, `internal: …`)
  - [ ] Arrancar libobs con el mismo idioma (OBS ya trae traducidas sus opciones, p. ej. chroma key) → se hará en la Fase 2, cuando se muestren opciones de OBS
  - [ ] Probar con el usuario el cambio de idioma en la app real
- [x] **Tooltips** en las opciones y selectores de archivos que no sean obvios para un usuario medio → [src/lib/tooltip.ts](src/lib/tooltip.ts)
  - [x] Componente propio (no `title`): aparece con el mouse (~0,4 s) y con el teclado, se cierra con Esc, accesible para lectores de pantalla (`role="tooltip"` + `aria-describedby`)
  - [x] Que nunca se abra encima de la vista previa (es una ventana nativa de OBS y lo taparía): elige abajo/arriba/izquierda/derecha o se corre a un costado
  - [x] Texto corto (qué hace, qué archivos acepta); botón ⓘ en opciones complejas y en las partes "en construcción"
  - [ ] Enlace "Más info" a la guía: un tooltip no puede tener enlaces (no se pueden pulsar ni los anuncia el lector de pantalla). Hacerlo con un botón "?" que abra la sección de la guía cuando esté publicada
  - [x] Textos de los tooltips en los archivos de idioma
  - [ ] Probar con el usuario en la app real
- **Regla desde entonces:** todo texto nuevo nace en español e inglés y toda opción no obvia nace con su tooltip

### Avatar

- [ ] Cargar archivo `.vrm` (selector de archivo ✅ + avatares recientes)
  - [x] Estado del avatar en el panel (*cargando…* / *listo* / error con el motivo), informado por la página del avatar
  - [ ] Revisar la doble carga de la página al cargar el avatar justo al arrancar
- [ ] Postura idle: respiración, parpadeo automático, balanceo leve (versión básica ✅ en [avatar/main.ts](avatar/main.ts))
- [ ] Tracking: rotación de cabeza, mirada, parpadeo, boca abierta/cerrada
- [ ] **Cuerpo que acompaña a la cabeza** (con la misma cámara, sin tracking de cuerpo): el torso comparte los giros de la cabeza, se inclina cuando te inclinas o te acercas a la cámara (posición de la cabeza que da MediaPipe) y respira también durante el tracking; así se luce la física de pelo y ropa del VRM
  - [x] Primera versión en [avatar/main.ts](avatar/main.ts): giro repartido columna 15 % · pecho 15 % · cuello 30 % · cabeza 40 %; inclinación lateral y hacia adelante según la posición de la cabeza (el reposo se recalcula solo en ~8 s hasta que exista la calibración)
  - [ ] Probar con cámara y ajustar intensidades
- [x] Calibración desde la interfaz: asistente de 3 pasos (de frente · ojos cerrados guiado por pitidos · boca abierta) que calcula los umbrales de ojos y boca, la postura "de frente" (corrige una cámara de costado) y el reposo del cuerpo; se guarda en `%APPDATA%\com.avatos.app\calibracion.json` → [src/lib/Calibration.svelte](src/lib/Calibration.svelte), [src-tauri/src/calibration.rs](src-tauri/src/calibration.rs)
  - [ ] Probar con el usuario y su cámara
  - [x] Mejoras: descarta el tiempo de reacción (0,4 s), indicador "te veo", medidores en vivo, pantalla **Prueba y ajuste** con vista previa en el avatar sin guardar, y deslizadores de sensibilidad de ojos y boca; botón **Ajustar** para retocar sin repetir los pasos (se guardan las medidas originales)
  - [ ] Calibración por ojo (izquierdo y derecho por separado) si los guiños se detectan desparejos
- [ ] Suavizado avanzado (filtro anti-temblor tipo One Euro) si el tracking tiembla con poca luz
  - Hoy, fijos en [avatar/main.ts](avatar/main.ts): ojos 0.20 → 0.55, boca 0.03 → 0.35. El panel muestra los valores reales de MediaPipe para ajustarlos
  - La sonrisa ya **no** activa la expresión "alegre": en muchos VRM las emociones bloquean el parpadeo y la boca (`overrideBlink`/`overrideMouth`); las emociones irán por atajos
- [ ] Lip-sync por micrófono (volumen → boca; luego vocales A-I-U-E-O)
- [ ] Combinar tracking + lip-sync (prioridades / mezcla)
- [x] Expresiones VRM (alegre, enojado, triste, sorpresa, relajado) con atajos de teclado globales **Ctrl+Shift+1…5** y botones en el panel; pulsar de nuevo vuelve a neutral; fundido de ~0,2 s → [src-tauri/src/expressions.rs](src-tauri/src/expressions.rs)
  - [ ] Probar con el usuario (atajos mientras se juega)
- [ ] Gestos/animaciones simples con atajos (saludar, asentir)
- [ ] Editor de atajos en la interfaz
- [ ] Fondos: transparente, color, imagen
- [ ] Efectos: iluminación, contorno (outline), cámara del avatar (zoom/ángulo)

## Fase 2 — Escenas y fuentes

- [ ] Crear / renombrar / borrar / cambiar escenas
- [ ] Fuentes: Avatar, Cámara, Captura de pantalla, Captura de ventana, Imagen, Texto
- [ ] Mover, escalar, rotar, recortar y ordenar capas en el preview
- [ ] Mostrar/ocultar y bloquear fuentes
- [ ] Filtros por fuente: **chroma key** (verde, azul, magenta o color personalizado; similitud, suavidad, reducción de derrame de color)
- [ ] Filtros extra por fuente: color key, corrección de color, recorte/máscara
- [ ] Guardar y cargar la configuración (colección de escenas en JSON)

## Fase 3 — Audio

- [ ] Fuentes: micrófono y sonido del escritorio (elegir dispositivo)
- [ ] Mezclador: medidores de nivel, volumen, silencio
- [ ] Filtros básicos: puerta de ruido, supresión de ruido, ganancia

## Fase 4 — Grabación

- [ ] Ajustes de salida: resolución, FPS, carpeta, calidad
- [ ] Codificador por hardware (NVENC / AMF / QuickSync) con x264 como respaldo
- [ ] Grabar MP4 (usar MP4 "híbrido"/fragmentado para no perder el video si se cierra mal)
- [ ] Botón grabar/detener, tiempo de grabación, atajo de teclado

## Fase 5 — Pulido de la v1.0

- [ ] Asistente de primera ejecución (cámara, micrófono, avatar de ejemplo, **idioma**)
- [ ] Revisar que no quede ningún texto sin traducir ni opción no obvia sin tooltip
- [ ] Manejo de errores y logs
- [ ] Seguridad: activar la CSP en `tauri.conf.json` (hoy `csp: null`) y limitar permisos (quitar `opener` si no se usa)
- [ ] Instalador para Windows (empaquetar `avatar/dist` como recurso de Tauri y los binarios de OBS)
- [ ] Avisos de licencias de terceros (OBS GPL-2.0+, Qt LGPL-3.0, CEF BSD, three.js y three-vrm MIT)
- [ ] Prueba en Linux (solo si compila sin cambios grandes). Nota: en Linux libobs-rs pide compilar OBS desde el código fuente (en Ubuntu lo automatiza `cargo obs-build install`)
- [ ] Publicar v1.0 en GitHub

---

## Después de la v1.0

- [ ] **Más idiomas (objetivo: los ~60 de OBS):** conectar el repositorio a una plataforma de traducción colaborativa (Weblate, libre, o Crowdin, gratis para open source, la que usa OBS) para que voluntarios traduzcan sin programar; revisar idiomas de derecha a izquierda (árabe, hebreo)
- [ ] Documentación en inglés (`docs/en/`)
- [ ] Transmisión en vivo (RTMP: Twitch, YouTube, Kick)
- [ ] Cámara virtual (Discord, Zoom)
- [ ] Avatares 2D libres con **Inochi2D** (alternativa open source a Live2D)
- [ ] Seguimiento de manos y cuerpo (MediaPipe Pose/Hand Landmarker; medir el costo en GPU integradas)
- [ ] **Modo dúo: dos avatares conversando** (ver la regla de diseño en *Arquitectura*)
  - [ ] Dos avatares en la misma escena, cada uno con su propia fuente "Avatar"
  - [ ] Dos personas frente a la misma cámara (MediaPipe detecta hasta N caras; cada cara se asigna a un avatar, p. ej. izquierda/derecha) o una cámara por persona
  - [ ] Lip-sync independiente: cada avatar mueve la boca con su propio micrófono
  - [ ] Que se miren entre sí al hablar (mirada y giro hacia el otro avatar)
  - [ ] Cámara virtual "director": encuadra a los dos y acerca o resalta a quien está hablando (detección de voz por micrófono), con transiciones suaves
  - [ ] Más adelante: invitado remoto (el otro avatar se controla desde otra computadora por red)
- [ ] Transiciones entre escenas
- [ ] Eventos de chat (follows, donaciones → reacciones del avatar)
- [ ] Sistema de plugins
- [ ] **Tracking facial nativo en Rust (ONNX):** mover MediaPipe a Rust para no depender de la interfaz web (complementa a la opción B)
- [ ] **Render nativo del avatar en Rust (opción B):** renderizador VRM propio (wgpu o gráficos de libobs) como fuente nativa, para complementar a la fuente web (three-vrm): menos memoria, menos latencia y sin depender del navegador integrado (CEF)
