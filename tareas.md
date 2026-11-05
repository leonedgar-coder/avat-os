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

**Fuera de la v1 (después):** transmisión RTMP, cámara virtual, avatares 2D libres (Inochi2D), manos/cuerpo, eventos de chat, plugins.

---

## Arquitectura

```
┌──────────────────────── avat-os (Tauri) ────────────────────────┐
│  Interfaz (HTML/TS): escenas, fuentes, mezclador, avatar, atajos │
└───────────────▲──────────────────────────────┬───────────────────┘
                │ comandos / eventos Tauri      │
┌───────────────┴──────────── Núcleo Rust ─────▼───────────────────┐
│  Tracking:  webcam ─► detección facial (ONNX) ─► blendshapes      │
│  Lip-sync:  micrófono ─► volumen/vocales ─► boca                  │
│  Atajos:    teclado global ─► expresiones                         │
│                    │ datos del avatar (60 fps)                    │
│                    ▼                                              │
│  Avatar:    renderizador VRM ─► fuente "Avatar" dentro de libobs  │
│                                                                   │
│  libobs:    escenas · fuentes · audio · codificación · MP4        │
└───────────────────────────────────────────────────────────────────┘
```

- **Una sola dueña de la webcam:** el núcleo Rust abre la cámara, hace el tracking y además puede pasar la imagen a libobs como fuente "Cámara". Así no pelean dos módulos por el mismo dispositivo.
- **El avatar es una fuente más** de la escena: se mueve, escala y ordena igual que una imagen.

---

## Fase 0 — Base y pruebas de riesgo (spikes)

Antes de construir encima, comprobar que las piezas difíciles funcionan juntas.

- [x] Instalar herramientas: Rust (rustup), Node.js, Tauri CLI, Visual Studio Build Tools
- [x] `git init`, archivo `LICENSE` (GPL-3.0-or-later), `README.md` con el logo
- [x] Proyecto Tauri vacío con el tema de avat-os (oscuro + naranja/morado)
- [x] **Spike 1 — libobs desde Rust:** ✅ `libobs-wrapper` 10 + `libobs-simple` 9 (GPL-3.0). Graba 5 s de pantalla a MP4 híbrido con QuickSync → [spikes/obs-record](spikes/obs-record)
- [ ] **Spike 2 — vista previa dentro de Tauri:** mostrar el preview de libobs en la ventana de la app
- [ ] **Spike 3 — renderizar VRM:** elegir el camino (render nativo en Rust con `wgpu` vs. página web three-vrm como fuente de navegador) y mostrar un VRM en una escena
- [ ] **Spike 4 — tracking facial:** webcam + modelo de MediaPipe (ONNX) en Rust, imprimir rotación de cabeza y apertura de boca
- [ ] Decidir la arquitectura final según los resultados de los spikes
- [ ] Vectorizar el logo y corregir el texto del anillo

## Fase 1 — Avatar

- [ ] Cargar archivo `.vrm` (selector de archivo + avatares recientes)
- [ ] Postura idle: respiración, parpadeo automático, balanceo leve
- [ ] Tracking: rotación de cabeza, mirada, parpadeo, boca abierta/cerrada
- [ ] Calibración (pose neutra) y suavizado (filtro anti-temblor)
- [ ] Lip-sync por micrófono (volumen → boca; luego vocales A-I-U-E-O)
- [ ] Combinar tracking + lip-sync (prioridades / mezcla)
- [ ] Expresiones VRM (alegre, enojado, triste, sorpresa…) con atajos de teclado globales
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

- [ ] Asistente de primera ejecución (cámara, micrófono, avatar de ejemplo)
- [ ] Manejo de errores y logs
- [ ] Seguridad: activar la CSP en `tauri.conf.json` (hoy `csp: null`) y limitar permisos (quitar `opener` si no se usa)
- [ ] Instalador para Windows
- [ ] Prueba en Linux (solo si compila sin cambios grandes). Nota: en Linux libobs-rs pide compilar OBS desde el código fuente (en Ubuntu lo automatiza `cargo obs-build install`)
- [ ] Publicar v1.0 en GitHub

---

## Después de la v1.0

- [ ] Transmisión en vivo (RTMP: Twitch, YouTube, Kick)
- [ ] Cámara virtual (Discord, Zoom)
- [ ] Avatares 2D libres con **Inochi2D** (alternativa open source a Live2D)
- [ ] Seguimiento de manos y cuerpo
- [ ] Transiciones entre escenas
- [ ] Eventos de chat (follows, donaciones → reacciones del avatar)
- [ ] Sistema de plugins
