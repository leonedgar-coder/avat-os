# avat-os — Plan de trabajo

> Avatar 3D + producción de video en una sola app. Open source: **GPL-3.0-or-later** (GPL 3, la versión más reciente, y cualquier versión futura).
> Stack: **Rust + Tauri** (interfaz) · **libobs** (motor de video/audio/grabación) · **VRM** (avatares 3D).
> Plataforma: **Windows** (oficial). Linux solo si sale "gratis" (código portable, sin prometerlo).
> Pruebas a mano de cada fase: [pruebas.md](pruebas.md). Una fase termina cuando pasan todas.

---

## Alcance de la versión 1.0

| Avatar (tipo Animaze) | Producción (tipo OBS) |
|---|---|
| Cargar avatar 3D (VRM 0.x y 1.0) | Escenas y fuentes: cámara, pantalla, ventana, imagen, texto |
| Seguimiento facial por webcam (cabeza, ojos, boca, parpadeo) | Mezclador de audio: micrófono + sonido del escritorio |
| Lip-sync con la voz | Grabar a archivo MP4 |
| Expresiones y gestos con atajos de teclado | Chroma key (fondo verde/azul/color) en cualquier fuente |
| Fondos y efectos del avatar | |
| **Movimiento del cuerpo**: pararse, sentarse, girar y moverse por la escena (una o varias cámaras) | |

**Fuera de la v1 (después):** opciones avanzadas de OBS (transmisión, cámara virtual, transiciones, filtros y audio avanzados…), avatar avanzado al estilo de Animaze (mirada, emotes, accesorios, luces, entornos, reacciones al chat), plugins (de OBS y propios), avatares 2D (Inochi2D) y modo dúo. Detalle en [Después de la v1.0](#después-de-la-v10).

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
- [x] Vectorizar el logo y corregir el texto del anillo (ahora «avat-os · código abierto») → [assets/logo.svg](assets/logo.svg); iconos de la app regenerados

## Fase 1 — Avatar ✅ (terminada el 2026-11-13)

### Interfaz: idiomas y ayuda (hacerlo pronto: cuesta poco mientras la interfaz es pequeña)

- [x] **Idiomas — español e inglés**, con la estructura lista para N idiomas → [src/lib/i18n/](src/lib/i18n)
  - [x] Un archivo de textos por idioma (`es.json`, `en.json`); ningún texto escrito directamente en la interfaz. Se eligió un **sistema propio mínimo** (sin dependencias; JSON estándar compatible con Weblate/Crowdin; TypeScript avisa si falta una clave o una traducción) en lugar de Paraglide JS
  - [x] Idioma inicial = el de Windows (si no existe, inglés) + selector que se recuerda (por ahora en la barra superior; se moverá a Ajustes cuando exista esa ventana)
  - [x] Migrar todos los textos actuales de la interfaz
  - [x] Errores de Rust como **códigos** que la interfaz traduce (`engine_not_running`, `avatar_invalid_file`, `expression_unknown`, `internal: …`)
  - [ ] Arrancar libobs con el mismo idioma (OBS ya trae traducidas sus opciones, p. ej. chroma key) → se hará en la Fase 2, cuando se muestren opciones de OBS
  - [x] Probar con el usuario el cambio de idioma en la app real → ✅ [pruebas.md](pruebas.md), 2026-11-13
- [x] **Tooltips** en las opciones y selectores de archivos que no sean obvios para un usuario medio → [src/lib/tooltip.ts](src/lib/tooltip.ts)
  - [x] Componente propio (no `title`): aparece con el mouse (~0,4 s) y con el teclado, se cierra con Esc, accesible para lectores de pantalla (`role="tooltip"` + `aria-describedby`)
  - [x] Que nunca se abra encima de la vista previa (es una ventana nativa de OBS y lo taparía): elige abajo/arriba/izquierda/derecha o se corre a un costado
  - [x] Texto corto (qué hace, qué archivos acepta); botón ⓘ en opciones complejas y en las partes "en construcción"
  - [ ] ~~Enlace "Más info" a la guía~~ → **movido a la Fase 6** (necesita la guía publicada o empaquetada con el instalador)
  - [x] Textos de los tooltips en los archivos de idioma
  - [x] Probar con el usuario en la app real → ✅ [pruebas.md](pruebas.md), 2026-11-13
- **Regla desde entonces:** todo texto nuevo nace en español e inglés y toda opción no obvia nace con su tooltip

### Avatar

- [x] Cargar archivo `.vrm`: selector de archivo + **avatares recientes** (los últimos 8; el último se carga solo al arrancar) → [src-tauri/src/recent_avatars.rs](src-tauri/src/recent_avatars.rs)
  - [x] Estado del avatar en el panel (*cargando…* / *listo* / error con el motivo), informado por la página del avatar
  - [x] Doble carga de la página al arrancar: resuelta, el avatar inicial va en la URL con la que se crea la fuente
  - [x] Probar con el usuario → ✅ [pruebas.md](pruebas.md), 2026-11-13
- [x] Postura idle: respiración, parpadeo automático, balanceo leve (versión básica en [avatar/main.ts](avatar/main.ts); una más elaborada queda para "Avatar avanzado")
- [x] Tracking: rotación de cabeza, **mirada** (ojos del avatar con el *lookAt* del VRM; la calibración guarda la mirada "de frente"), parpadeo, boca abierta/cerrada
  - [x] Confirmado con el usuario: los ojos se mueven bien (se corrigió el rango: se usa el `inputMaxValue` de cada VRM)
- [x] **Cuerpo que acompaña a la cabeza** (con la misma cámara, sin tracking de cuerpo): el torso comparte los giros de la cabeza, se inclina cuando te inclinas o te acercas a la cámara (posición de la cabeza que da MediaPipe) y respira también durante el tracking; así se luce la física de pelo y ropa del VRM
  - [x] Primera versión en [avatar/main.ts](avatar/main.ts): giro repartido columna 15 % · pecho 15 % · cuello 30 % · cabeza 40 %; inclinación lateral y hacia adelante según la posición de la cabeza (el reposo se recalcula solo en ~8 s hasta que exista la calibración)
  - [x] Probado con cámara: inclinación lateral y acercarse/alejarse bien → ✅ [pruebas.md](pruebas.md). Inclinarse **hacia el frente** todavía acerca el avatar → **Fase 1B**
- [x] Calibración desde la interfaz: asistente de 3 pasos (de frente · ojos cerrados guiado por pitidos · boca abierta) que calcula los umbrales de ojos y boca, la postura "de frente" (corrige una cámara de costado) y el reposo del cuerpo; se guarda en `%APPDATA%\com.avatos.app\calibracion.json` → [src/lib/Calibration.svelte](src/lib/Calibration.svelte), [src-tauri/src/calibration.rs](src-tauri/src/calibration.rs)
  - [x] Probar con el usuario y su cámara → ✅ [pruebas.md](pruebas.md), 2026-11-13
  - [x] Mejoras: descarta el tiempo de reacción (0,4 s), indicador "te veo", medidores en vivo, pantalla **Prueba y ajuste** con vista previa en el avatar sin guardar, y deslizadores de sensibilidad de ojos y boca; botón **Ajustar** para retocar sin repetir los pasos (se guardan las medidas originales)
  - [x] Calibración por ojo: umbrales propios para cada ojo, medidos en el mismo paso; un medidor por ojo en el ajuste; las calibraciones antiguas siguen valiendo
    - [x] Parpadeos falsos con rango de ojos estrecho: filtro de picos en los párpados + margen mínimo en la calibración → [avatar/spike-filter.ts](avatar/spike-filter.ts), prueba `npm run test:blink`
    - [x] Probar con el usuario (recalibrar para que se midan los dos ojos y se aplique el margen) → ✅ [pruebas.md](pruebas.md), 2026-11-13
- [x] Anti-temblor One Euro en cabeza, posición y mirada: ~60 % menos temblor quieto y menos retraso al girar (medido, `npm run test:smoothing`) → [avatar/one-euro.ts](avatar/one-euro.ts), [avatar/smoothing.ts](avatar/smoothing.ts)
  - [x] Probar con el usuario (con poca luz) → ✅ [pruebas.md](pruebas.md), 2026-11-13
  - Hoy, fijos en [avatar/main.ts](avatar/main.ts): ojos 0.20 → 0.55, boca 0.03 → 0.35. El panel muestra los valores reales de MediaPipe para ajustarlos
  - La sonrisa ya **no** activa la expresión "alegre": en muchos VRM las emociones bloquean el parpadeo y la boca (`overrideBlink`/`overrideMouth`); las emociones irán por atajos
- [x] Lip-sync por micrófono: volumen → boca, con elección de micrófono, medidor en vivo y sensibilidad → [src/lib/lipsync.ts](src/lib/lipsync.ts)
  - [x] Vocales A-I-U-E-O (forma de la boca según la voz): formantes con LPC, opción **Forma** y letra en vivo → [src/lib/vowels.ts](src/lib/vowels.ts), prueba `npm run test:vowels`
    - [x] Probar con el usuario → ✅ [pruebas.md](pruebas.md), 2026-11-13
    - [x] Revisión de la O y la U: ajuste al tono de quien habla, F2 débil, F1 partida en voces agudas, consonantes sin vocal; probado con voces de Windows
    - [x] Calibración de vocales por persona (A, E, I, O, U, ~15 s) con medidas en vivo → [src/lib/VowelCalibration.svelte](src/lib/VowelCalibration.svelte)
    - [x] Probar la calibración con el usuario → ✅ (plantillas en escala mel; la U y la O ya se distinguen). Revisar los valores típicos con más voces → Fase 6
  - [x] Probado con el usuario: el medidor de voz y la boca responden
- [x] Combinar tracking + lip-sync: modo **Cámara + voz** (lo mayor de los dos) o **Solo voz**; el lip-sync funciona también sin cámara
- [x] Expresiones VRM (alegre, enojado, triste, sorpresa, relajado) con atajos de teclado globales **Ctrl+Shift+1…5** y botones en el panel; pulsar de nuevo vuelve a neutral; fundido de ~0,2 s → [src-tauri/src/expressions.rs](src-tauri/src/expressions.rs)
  - [x] Probar con el usuario (atajos mientras se juega) → ✅ [pruebas.md](pruebas.md), 2026-11-13
- [x] Gestos animados con atajos **Ctrl+Shift+6…9** y botones: saludar, asentir, negar, encogerse de hombros; se suman al tracking
  - [x] Probar con el usuario → ✅ [pruebas.md](pruebas.md), 2026-11-13
- [x] Aviso en el panel de los atajos que no se pudieron registrar, con reintento automático (15 s) y botón **Reintentar**; una sola copia de avat-os a la vez
- [x] Editor de atajos: cambiar, quitar y restablecer, con validaciones (Ctrl o Alt, sin AltGr, sin combinaciones de Windows, sin duplicados, sin las que usan otros programas); se guarda en `atajos.json`; acciones nuevas **encender/apagar tracking y lip-sync** → [src-tauri/src/shortcuts.rs](src-tauri/src/shortcuts.rs), [src/lib/ShortcutEditor.svelte](src/lib/ShortcutEditor.svelte)
  - [x] Probar con el usuario → ✅ [pruebas.md](pruebas.md), 2026-11-13
- [x] Fondos: transparente, color o imagen (PNG, JPG, WebP o GIF, también animados) con ajuste Cubrir/Ajustar; se recuerda en `fondo.json` → [src-tauri/src/background.rs](src-tauri/src/background.rs)
  - [x] Probar con el usuario → ✅ [pruebas.md](pruebas.md), 2026-11-13
  - [x] Fondos de video (MP4 H.264 / WebM VP9) detrás del avatar, en bucle y sin sonido; aviso si el códec no es compatible
- [x] Efectos: cámara del avatar (primer plano / medio / cuerpo entero según la altura de cada avatar, zoom, altura, ángulo, transición suave), luz (intensidad, color, dirección, ambiente) y grosor del contorno; se guardan en `efectos.json` → [src-tauri/src/effects.rs](src-tauri/src/effects.rs)
  - [x] Probar con el usuario → ✅ [pruebas.md](pruebas.md), 2026-11-13
- [ ] ~~Revisar los valores por defecto de la calibración con más personas~~ → **movido a la Fase 6** (hacen falta otras personas que lo prueben)
- [x] Ordenar el panel lateral: plegables **Avatares recientes**, **Ajustes del lip-sync** (la barra de voz queda a la vista), **Expresiones y gestos**, **Atajos de teclado** y **Efectos**; recuerdan si quedaron abiertos → [src/lib/rememberOpen.ts](src/lib/rememberOpen.ts). La calibración no: es una fila corta y el asistente es un paso a paso que no conviene esconder

## Fase 1B — Cuerpo base (hombros) ✅ (2026-11-13)

Separar **inclinarse hacia el frente** (solo cabeza y cuello) de **acercarse a la cámara** (el
avatar se acerca). Con solo la cara no se distinguen: los hombros sí (al inclinarte, la cabeza
se adelanta y los hombros casi no; al acercarte, se agrandan los dos).

- [x] MediaPipe Pose (modelo *lite*, ~15/s) en la misma cámara: ancho de los hombros corregido por el giro del torso → [src/lib/shoulders.ts](src/lib/shoulders.ts), [src/lib/tracking.ts](src/lib/tracking.ts); modelo en `npm run fetch:tracking`
- [x] Proporción cara × hombros (calibración, paso 1, o aprendida): inclinarse → columna, pecho y cuello; acercarse → el avatar se acerca → [avatar/body.ts](avatar/body.ts)
- [x] Plan B cuando no se ven los hombros: una inclinación mantenida pasa a acercamiento en ~3 s; sin saltos al cambiar
- [x] Panel: *Hombros visibles* / *no se ven*, con ayuda
- [x] Prueba automática `npm run test:body` (simulación) y `cargo test` de `bodyRatio`
- [x] Medir el costo en la app real: ~40 FPS con hombros visibles (Iris Xe; con poca luz la webcam baja sola a ~11, sin culpa del detector)
- [x] Probado con el usuario → ✅ [pruebas.md](pruebas.md). Girar el torso: el avatar no se aleja (correcto); que el avatar **gire** el torso es de la Fase 5

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

## Fase 5 — Movimiento del cuerpo

El avatar sigue todo el cuerpo: se para y se sienta contigo, gira y se mueve por la escena.
Con una cámara funciona; con **dos o más** es más preciso (profundidad real, giros completos
sin confundir izquierda y derecha, partes que una cámara no ve).

**Por qué aquí:** después de la Fase 4 el núcleo de la v1 (avatar, escenas, audio y grabación)
ya está completo y se puede medir cuánto consume; el cuerpo es lo más pesado para el equipo.
Aprovecha la Fase 2 (elegir cámaras como fuente) y va antes del Pulido para que el asistente
de primera ejecución, el instalador y las pruebas finales ya lo incluyan.
(Los escenarios 3D no entran: el avatar se mueve sobre el fondo de siempre.)

### 5.1 Base: cuerpo con una cámara

- [ ] Detector de cuerpo local: MediaPipe **Pose Landmarker** (33 puntos con posición 3D), modelo descargado por `npm run fetch:tracking` con verificación SHA-256 (Apache-2.0, como el de la cara)
- [ ] Medir el costo de cara + cuerpo a la vez (FPS, GPU integrada); si no alcanza, el cuerpo a menos cuadros por segundo que la cara
- [ ] Modos: **Sentado** (como ahora: cara y torso estimado) y **Cuerpo completo**
- [ ] Del esqueleto de MediaPipe a los huesos del VRM (torso, brazos, piernas): calcular los ángulos (evaluar Kalidokit, MIT, o código propio)
- [ ] Detectar **parado / sentado** (altura de la cadera, ángulo de las rodillas) y el **giro** del cuerpo (línea de los hombros y de la cadera)
- [ ] Anti-temblor One Euro también para el cuerpo; partes que la cámara no ve (piernas bajo el escritorio): mantener la última pose o pasar a una pose de reposo

### 5.2 Varias cámaras

- [ ] Elegir **dos o más cámaras** para el tracking, con vista previa de cada una
- [ ] Calibrar las cámaras entre sí (dónde está cada una): asistente con un patrón impreso (tablero de ajedrez / ChArUco) o con la propia persona en pose de T
- [ ] Sincronizar los cuadros de las cámaras (marca de tiempo de captura, como el anti-temblor)
- [ ] **Triangular**: unir los puntos que ve cada cámara en una sola posición 3D (más precisa que la profundidad que estima una sola)
- [ ] Unir según la confianza: para cada parte manda la cámara que mejor la ve (para la cara, la que la ve de frente); seguir aunque una cámara pierda a la persona
- [ ] Giros completos (de espaldas) sin confundir izquierda y derecha

### 5.3 Movimiento en el espacio

- [ ] Piso y escala: calibrar dónde está el piso y la altura de la persona (de pie, en el asistente) para pasar de metros reales a la escena
- [ ] La cadera mueve al avatar por la escena (caminar, acercarse, alejarse), dentro de una zona con límites
- [ ] Pies sin patinar: fijar el pie que apoya en el piso (cinemática inversa de las piernas)
- [ ] Pararse y sentarse con transición suave; altura del asiento ajustable (silla virtual)
- [ ] La cámara del avatar lo sigue (los encuadres de **Efectos** adaptados a un avatar que se mueve)

### 5.4 Interfaz, ajustes y pruebas

- [ ] Panel **Cuerpo**: modo, cámaras, calibración, vista del esqueleto detectado (qué ve cada cámara) y botón **Recentrar**
- [ ] Guardar la configuración (cámaras y su calibración) y atajos (recentrar, cambiar de modo)
- [ ] Mensaje nuevo del canal en vivo para el cuerpo, con `avatar` (regla de N avatares, listo para el modo dúo)
- [ ] Pruebas automáticas (poses sintéticas, triangulación con cámaras simuladas) y pruebas a mano en [pruebas.md](pruebas.md)
- [ ] Documentación en las dos guías

## Fase 6 — Pulido de la v1.0

- [ ] Asistente de primera ejecución (cámara, micrófono, avatar de ejemplo, **idioma**)
- [ ] Botón "?" que abra la sección de la guía (un tooltip no puede tener enlaces: no se pueden pulsar ni los anuncia el lector de pantalla) — viene de la Fase 1
- [ ] Revisar los valores por defecto de la calibración con más personas (el usuario subió la sensibilidad de la boca al máximo y su rango de ojos es pequeño) — viene de la Fase 1
- [ ] Revisar que no quede ningún texto sin traducir ni opción no obvia sin tooltip
- [ ] Manejo de errores y logs
- [ ] Seguridad: activar la CSP en `tauri.conf.json` (hoy `csp: null`) y limitar permisos (quitar `opener` si no se usa)
- [ ] Instalador para Windows (empaquetar `avatar/dist` como recurso de Tauri y los binarios de OBS)
- [ ] Avisos de licencias de terceros (OBS GPL-2.0+, Qt LGPL-3.0, CEF BSD, three.js y three-vrm MIT)
- [ ] Prueba en Linux (solo si compila sin cambios grandes). Nota: en Linux libobs-rs pide compilar OBS desde el código fuente (en Ubuntu lo automatiza `cargo obs-build install`)
- [ ] Publicar v1.0 en GitHub

---

## Después de la v1.0

> Orden sugerido por versiones (se puede ajustar): **v1.1** transmisión y lo esencial de OBS · **v1.2** avatar avanzado ·
> **v1.3** plugins · después, el resto. Cada bloque sigue las mismas reglas: textos en los idiomas, tooltips, documentación
> al día y diseño para N avatares.

### A. Producción: opciones de OBS

OBS tiene muchísimas opciones; como avat-os usa **libobs** (el mismo motor), la mayoría ya existen por dentro y el trabajo es
sobre todo **exponerlas en la interfaz**. Se agregan por grupos, de lo más usado a lo más avanzado.

**A1. Transmisión y salidas** (v1.1)
- [ ] Transmisión en vivo por **RTMP/RTMPS** con servicios predefinidos (Twitch, YouTube, Kick, Facebook) y servidor personalizado
- [ ] Protocolos modernos: **SRT** y **WHIP** (WebRTC, baja latencia)
- [ ] Asistente de configuración automática (prueba de ancho de banda y sugerencia de calidad)
- [ ] **Multistream**: transmitir a varias plataformas a la vez
- [ ] **Cámara virtual** (Discord, Zoom, Meet)
- [ ] **Buffer de repetición** (*replay buffer*): guardar los últimos N segundos con un atajo
- [ ] Grabación en MKV/MOV y **remux** a MP4; grabación de **varias pistas de audio**; dividir la grabación por tiempo o tamaño
- [ ] Grabar y transmitir a la vez con ajustes distintos
- [ ] Ajustes avanzados de codificación: H.264 / HEVC / **AV1**, control de tasa (CBR, VBR, CQP), bitrate, intervalo de fotogramas clave, *presets*
- [ ] Estadísticas en vivo: FPS, cuadros perdidos o retrasados, CPU, uso de disco, bitrate, estado de la conexión

**A2. Escenas y fuentes avanzadas** (v1.1)
- [ ] **Grupos** de fuentes y **escenas anidadas** (una escena como fuente de otra)
- [ ] Fuentes: **captura de juego**, **captura de audio de una aplicación** (solo el audio de un programa), **medios** (video y audio en archivo o en bucle), **presentación de imágenes**, **color**, **navegador** (alertas web, chat), **dispositivo de captura** (capturadora), texto avanzado (contorno, sombra, desplazamiento, leer de archivo)
- [ ] Fuentes compartidas entre escenas, duplicar escenas y fuentes
- [ ] **Transformaciones** precisas: posición, tamaño, rotación, recorte y alineación con valores numéricos, ajustar a la pantalla, guías de alineación
- [ ] **Modo estudio**: vista previa y programa separados, con botón de transición
- [ ] **Transiciones**: corte, fundido, deslizar, barrido, *luma wipe* y **stinger** (video), con duración; transición distinta por escena
- [ ] **Multivista** (ver varias escenas a la vez) y **proyectores** (escena en pantalla completa o en otra ventana/monitor)
- [ ] Cambio automático de escena (por ejemplo, según la ventana activa)

**A3. Filtros de video** (v1.1)
- [ ] Color key / chroma key avanzado, **máscara de imagen / mezcla**, **LUT** (tablas de color), corrección de color, nitidez
- [ ] Recorte y relleno, escalado y relación de aspecto, desplazamiento (*scroll*), retraso de video
- [ ] Desenfoque, pixelado y otros efectos (algunos vienen de plugins)
- [ ] Ordenar, activar y desactivar filtros; copiar y pegar filtros entre fuentes

**A4. Audio avanzado** (v1.1)
- [ ] Filtros: **supresión de ruido** (RNNoise; NVIDIA en GPU compatibles), **compresor**, **limitador**, **expansor**, **ecualizador**, ganancia, retraso de sincronía
- [ ] **Plugins de audio VST** (los que ya usa la gente para su micrófono)
- [ ] **Monitorización** (escuchar una fuente por los auriculares), balance, volumen en dB
- [ ] **Pistas de audio** (hasta 6): elegir qué fuente va a cada pista de grabación y de transmisión
- [ ] Mezclador avanzado: sincronía de audio por fuente, bajar el volumen automáticamente cuando hablas (*ducking*)

**A5. Organización y control** (v1.2)
- [ ] **Perfiles** (ajustes de salida) y **colecciones de escenas**; exportar e importar
- [ ] **Importar escenas desde OBS** (archivos JSON de colecciones de OBS) para facilitar el cambio
- [ ] **Atajos de teclado para todo**: cambiar de escena, mostrar u ocultar fuentes, silenciar, empezar y detener, transiciones
- [ ] Paneles acoplables y reorganizables (*docks*), incluidos paneles web personalizados
- [ ] **Control remoto compatible con obs-websocket**: que funcionen Stream Deck, Touch Portal y otras apps que ya hablan con OBS
- [ ] Color y video avanzados: espacio de color, rango, HDR, FPS fraccionarios

### B. Avatar avanzado (inspirado en Animaze)

Las funciones típicas de las apps de VTuber, para manejar el avatar con más detalle.

**B1. Tracking más completo** (v1.2)
- [ ] **Mirada** (los ojos siguen hacia dónde miras), **cejas**, mejillas, lengua, guiños bien separados
- [ ] Ajuste por rasgo: sensibilidad, suavizado e intensidad de cada parte (cabeza, ojos, cejas, boca) desde la interfaz
- [ ] **Mapeo de expresiones**: asignar las 52 expresiones de MediaPipe (formato ARKit) a las del avatar, con soporte de avatares *Perfect Sync* (que traen las 52)
- [ ] Tracking desde el **iPhone** (Face ID / ARKit por red local) para más precisión
- [ ] Seguimiento de **manos** (dedos) con la webcam (MediaPipe Hand Landmarker; medir el costo en GPU integradas) y con dispositivos dedicados (p. ej. sensores de manos). El cuerpo está en la Fase 5
- [ ] Sensores de cuerpo opcionales (p. ej. SlimeVR, de código abierto) además de las cámaras de la Fase 5
- [ ] Animaciones automáticas cuando no hay cara: parpadeo, respiración, mirada aleatoria, pequeños movimientos

**B2. Expresiones, emotes y animaciones** (v1.2)
- [ ] **Emotes animados** con atajos: saludar, aplaudir, reír, asentir, negar, bailar…
- [ ] **Poses** y biblioteca de **animaciones de reposo** (*idle*) para elegir
- [ ] Importar animaciones (VRMA, BVH, FBX/GLB con animación)
- [ ] **Capas de animación**: combinar una animación de cuerpo con el tracking de la cara (máscaras por hueso)
- [ ] Expresiones combinadas y por tiempo (activar varias, mantener N segundos, alternar)
- [ ] Grabar y reproducir movimientos (*motion capture* sencillo)

**B3. Apariencia: accesorios, cámara, luces y entornos** (v1.2)
- [ ] **Accesorios** (sombreros, gafas, objetos en la mano) unidos a huesos del avatar, con posición y escala ajustables
- [ ] Variantes del avatar: ropa o peinados alternativos y cambio de colores
- [ ] **Cámara del avatar**: planos guardados (cuerpo entero, medio, primer plano), zoom, ángulo, transición suave entre planos y cámara que sigue al avatar
- [ ] **Iluminación**: luces principal, de relleno y de contorno, color, intensidad y sombras
- [ ] **Entornos 3D** y objetos en escena (mesa, micrófono), además de fondos de imagen o video
- [ ] **Postprocesado**: contorno de dibujo animado, brillo (*bloom*), profundidad de campo, filtros de color
- [ ] **Física** ajustable de pelo y ropa (gravedad, rigidez, viento)
- [ ] **Estudio de fotos**: poses fijas y captura de imágenes del avatar con fondo transparente

**B4. Interacción con la audiencia** (v1.3)
- [ ] Conexión con el **chat** de Twitch y YouTube (eventos: seguidores, suscripciones, donaciones, puntos de canal)
- [ ] **Reacciones** del avatar a eventos (expresión, emote, efecto) configurables
- [ ] **Objetos que se lanzan** al avatar con física (los activa el chat)
- [ ] Alertas en pantalla vinculadas a los eventos

**B5. Formatos y modos de avatar**
- [ ] Avatares 2D libres con **Inochi2D** (alternativa open source a Live2D)
- [ ] Importar otros formatos 3D (GLB/FBX) con un asistente que los convierta a VRM
- [ ] **Avatar en el escritorio**: el avatar flotando sobre el escritorio con fondo transparente, sin escena
- [ ] Modo de bajo consumo (FPS del avatar, calidad de sombras y física) para equipos con GPU integrada
- [ ] **Modo dúo: dos avatares conversando** (ver la regla de diseño en *Arquitectura*)
  - [ ] Dos avatares en la misma escena, cada uno con su propia fuente "Avatar"
  - [ ] Dos personas frente a la misma cámara (MediaPipe detecta hasta N caras; cada cara se asigna a un avatar, p. ej. izquierda/derecha) o una cámara por persona
  - [ ] Lip-sync independiente: cada avatar mueve la boca con su propio micrófono
  - [ ] Que se miren entre sí al hablar (mirada y giro hacia el otro avatar)
  - [ ] Cámara virtual "director": encuadra a los dos y acerca o resalta a quien está hablando (detección de voz por micrófono), con transiciones suaves
  - [ ] Más adelante: invitado remoto (el otro avatar se controla desde otra computadora por red)

### C. Plugins (v1.3)

- [ ] **Plugins de OBS existentes**: como avat-os usa libobs, puede cargar plugins nativos de OBS (fuentes, filtros, salidas) compilados para la misma versión de OBS
  - [ ] Carpeta de plugins y carga al arrancar, con lista de plugins activos y errores
  - [ ] Probar plugins populares de fuentes y filtros
  - [ ] Nota: los plugins que dependen de la interfaz de OBS (Qt / `obs-frontend-api`, p. ej. los que agregan menús o paneles) no funcionarán completos; documentar cuáles sí
- [ ] **Plugins propios de avat-os** (API estable y documentada):
  - [ ] Paneles para la interfaz (web) y comandos
  - [ ] Extensiones del avatar: nuevas fuentes de tracking, expresiones, animaciones, efectos y reacciones
  - [ ] Eventos: escena cambiada, grabación iniciada, expresión activada, mensajes del chat…
  - [ ] **Seguridad**: permisos declarados (cámara, red, archivos), aislamiento (sandbox) y aviso al instalar; nada se ejecuta sin que el usuario lo acepte
- [ ] **Gestor de plugins**: instalar, actualizar, activar o desactivar y desinstalar desde la interfaz; catálogo opcional
- [ ] Guía para crear plugins en `docs/` (con un plugin de ejemplo)

### D. Plataforma y otros

- [ ] **Más idiomas (objetivo: los ~60 de OBS):** conectar el repositorio a una plataforma de traducción colaborativa (Weblate, libre, o Crowdin, gratis para open source, la que usa OBS) para que voluntarios traduzcan sin programar; revisar idiomas de derecha a izquierda (árabe, hebreo)
- [ ] Documentación en inglés (`docs/en/`)
- [ ] Actualizaciones automáticas de la app
- [ ] **Tracking facial nativo en Rust (ONNX):** mover MediaPipe a Rust para no depender de la interfaz web (complementa a la opción B)
- [ ] **Render nativo del avatar en Rust (opción B):** renderizador VRM propio (wgpu o gráficos de libobs) como fuente nativa, para complementar a la fuente web (three-vrm): menos memoria, menos latencia y sin depender del navegador integrado (CEF)
- [ ] Prueba y soporte de Linux (si el costo es razonable) y, más adelante, macOS
