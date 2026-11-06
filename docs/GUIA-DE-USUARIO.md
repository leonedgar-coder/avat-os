<p align="center"><img src="../assets/logo.png" width="140" alt="avat-os"></p>

# Guía de usuario de avat-os

> **Versión del programa:** 0.1.0 (en desarrollo, Fase 1). Esta guía se actualiza junto con cada cambio del programa.
> Si algo de lo que lees aquí no coincide con lo que ves en pantalla, avísanos abriendo un *issue* en GitHub.

avat-os es un estudio para VTubers: en un solo programa tienes **tu avatar 3D que copia tu cara** y la **producción del video** (escenas, audio y grabación), sin tener que juntar varios programas.

---

## Contenido

1. [Requisitos](#1-requisitos)
2. [Primeros pasos](#2-primeros-pasos)
3. [La ventana de avat-os](#3-la-ventana-de-avat-os)
4. [Avatares](#4-avatares)
5. [Seguimiento facial (tracking)](#5-seguimiento-facial-tracking)
6. [Expresiones y atajos de teclado](#6-expresiones-y-atajos-de-teclado)
7. [Calibración y ajustes de ojos, boca y cuerpo](#7-calibración-y-ajustes-de-ojos-boca-y-cuerpo)
8. [Fondos y objetos en pantalla](#8-fondos-y-objetos-en-pantalla)
9. [Privacidad](#9-privacidad)
10. [Solución de problemas](#10-solución-de-problemas)
11. [Qué viene después](#11-qué-viene-después)

---

## 1. Requisitos

| | Mínimo | Recomendado |
|---|---|---|
| Sistema | Windows 10/11 de 64 bits | Windows 11 |
| Gráficos | GPU integrada (Intel Iris Xe o similar) | GPU dedicada (NVIDIA / AMD) |
| Memoria | 8 GB de RAM | 16 GB de RAM |
| Cámara | Cualquier webcam (para el tracking facial) | Webcam 720p o superior, buena luz de frente |

En un portátil con Intel Iris Xe, avat-os usa aproximadamente **8 % de CPU** y el tracking facial funciona a **45–56 FPS**.

> Por ahora avat-os todavía no tiene instalador: se ejecuta en modo desarrollo. Los pasos están en la
> [Guía del programador](GUIA-DEL-PROGRAMADOR.md#3-preparar-el-entorno). El instalador llegará en la Fase 5.

---

## 2. Primeros pasos

1. Abre avat-os.
2. En el panel **AVATAR** (a la derecha), pulsa **Cargar avatar .vrm** y elige un avatar. Junto a su nombre verás **cargando…** y luego **listo** cuando aparezca en la vista previa.
   El selector se abre directamente en la carpeta de avatares de prueba ([sección 4](#4-avatares)).
3. Pulsa el botón **Tracking facial** (dice *apagado*). Se encenderá la luz de tu cámara.
4. Mira a la cámara: en el panel aparecerá **Cara detectada** y tu avatar empezará a copiar tu cabeza, ojos y boca.

**Ayuda en pantalla:** deja el mouse quieto un momento sobre un botón u opción (o llega a él con la tecla `Tab`) y aparece una explicación breve. Los íconos **ⓘ** también muestran ayuda; en las partes que todavía no funcionan, te avisan de que están en construcción. `Esc` cierra la ayuda.

**Idioma:** la primera vez, avat-os se abre en el idioma de tu Windows (español o inglés; si tu Windows está en otro idioma, en inglés). Puedes cambiarlo cuando quieras con el selector de la esquina superior derecha; el cambio es inmediato y se recuerda para la próxima vez.

Para cerrar, usa la **X** de la ventana. La ventana desaparece al instante y el programa termina de apagarse en segundo plano en unos segundos.

---

## 3. La ventana de avat-os

```
┌──────────────────────────────────────────────────────────┬──────────────┐
│  avat-os                                          v0.1.0 │              │
├──────────────────────────────────────────────────────────┤   AVATAR     │
│                                                          │  [Cargar]    │
│                    VISTA PREVIA                          │  Avatar      │
│           (lo que se va a grabar, 1920×1080)             │  Tracking    │
│                                                          │  Lip-sync    │
│                                                          │  Fondo       │
├──────────────┬──────────────┬────────────────────────────┼──────────────┤
│  ESCENAS     │  FUENTES     │  MEZCLADOR DE AUDIO        │  CONTROLES   │
└──────────────┴──────────────┴────────────────────────────┴──────────────┘
```

| Zona | Para qué sirve | Estado |
|---|---|---|
| **Selector de idioma** (arriba a la derecha) | Cambiar la interfaz entre **Español** e **English** | ✅ Funciona |
| **Vista previa** | Muestra la escena tal como se grabará | ✅ Funciona |
| **Avatar** | Cargar el avatar, encender el tracking facial y elegir la expresión | ✅ Funciona |
| **Escenas / Fuentes** | Organizar lo que aparece en pantalla | 🚧 Solo visual (Fase 2) |
| **Mezclador de audio** | Volumen del micrófono y del escritorio | 🚧 Solo visual (Fase 3) |
| **Controles** | Iniciar/detener la grabación | 🚧 Solo visual (Fase 4) |

---

## 4. Avatares

### Qué archivos sirven

avat-os usa avatares 3D en formato **VRM** (archivos `.vrm`), el estándar abierto para avatares de VTuber.

| Formato | ¿Funciona? |
|---|---|
| `.vrm` versión **1.0** | ✅ Sí |
| `.vrm` versión **0.x** (la más común en modelos antiguos) | ✅ Sí |
| `.fbx`, `.pmx` (MMD), `.glb` sin VRM | ❌ No. Hay que convertirlos a VRM primero (por ejemplo con Unity + UniVRM o Blender + VRM Add-on) |
| Avatares 2D (Live2D, PNG) | ❌ Todavía no (planeado después de la v1.0) |

### Dónde poner tus avatares

Copia tus avatares en la carpeta:

```
avat-os\recursos\avatares\
```

El botón **Cargar avatar .vrm** se abre en esa carpeta. También puedes elegir un `.vrm` desde cualquier otra carpeta de tu equipo.

> 🔒 **Tus archivos son privados.** Nada de lo que copies en `recursos\` se sube a GitHub: el proyecto está configurado para ignorar esos archivos.

### Avatares de prueba incluidos

| Archivo | Autor | Licencia |
|---|---|---|
| `Seed-san.vrm` | VirtualCast, Inc. | Libre, incluso comercial. **Pide crédito** si lo muestras: "Seed-san por VirtualCast, Inc." |
| `VRM1_Constraint_Twist_Sample.vrm` | pixiv Inc. | Libre, incluso comercial. No pide crédito |

Los detalles están en `recursos\avatares\CREDITOS.txt`.

### Conseguir más avatares

- **Crear el tuyo gratis:** [VRoid Studio](https://vroid.com/studio) → *Exportar → Exportar como VRM*.
- **Descargar:** [VRoid Hub](https://hub.vroid.com/).

> ⚠️ **Respeta la licencia de cada avatar.** Dentro de cada `.vrm` el autor indica si permite usarlo en streams, con fines comerciales o modificarlo. Algunos modelos lo prohíben.

### Qué necesita tener el avatar para funcionar bien

avat-os usa las **expresiones estándar de VRM**. Casi todos los avatares hechos con VRoid las traen:

| Expresión VRM | Para qué la usa avat-os |
|---|---|
| `blinkLeft` / `blinkRight` | Cerrar cada ojo según tu cara |
| `blink` | Parpadeo automático cuando el tracking está apagado |
| `happy`, `angry`, `sad`, `surprised`, `relaxed` | Expresiones de los atajos de teclado ([sección 6](#6-expresiones-y-atajos-de-teclado)) |
| `aa` | Abrir la boca |
| `ou` | Boca en forma de "o" |
| Huesos `spine`, `chest`, `neck`, `head` | Mover el cuerpo y la cabeza |

Si a tu avatar le falta alguna, esa parte simplemente no se moverá.

---

## 5. Seguimiento facial (tracking)

### Cómo usarlo

1. Pulsa **Tracking facial** → cambia a *encendido*.
2. La primera vez puede aparecer un aviso pidiendo permiso para usar la cámara: acéptalo.
3. Para apagarlo, pulsa de nuevo el botón (la cámara se apaga).

### Qué copia el avatar

| Tu movimiento | Lo que hace el avatar |
|---|---|
| Girar, inclinar o asentir con la cabeza | Gira la cabeza; el cuello, el pecho y la columna acompañan el giro |
| Inclinarte hacia un lado o acercarte a la cámara | Inclina el torso |
| Parpadear o guiñar un ojo | Cierra el ojo correspondiente (como un espejo) |
| Abrir la boca / hablar | Abre la boca |
| Poner la boca en "o" | Boca redonda |
| Dejar de estar frente a la cámara | Después de medio segundo vuelve a la animación de reposo (respiración y parpadeo automático) |

El avatar **siempre respira**, también con el tracking encendido. La sonrisa **no** activa la cara de "alegre": las emociones se activan con los atajos de teclado ([sección 6](#6-expresiones-y-atajos-de-teclado)).

### Lo que muestra el panel

| Texto | Significado |
|---|---|
| **Cara detectada** / **Buscando cara…** | Si la cámara te está viendo |
| **46 FPS** | Cuántas veces por segundo se analiza tu cara. Más de 25 es suficiente |
| **Boca 0.12** | Cuánto abres la boca según la cámara (0 = cerrada, 1 = muy abierta) |
| **Ojo izq. 0.05 · der. 0.04** | Cuánto cierras cada ojo según la cámara (0 = abierto, 1 = cerrado) |

Estos tres números te sirven para afinar los ajustes de la [sección 7](#7-calibración-y-ajustes-de-ojos-boca-y-cuerpo).

### Consejos para que funcione mejor

- **Luz de frente**, no detrás de ti (una ventana a tu espalda oscurece la cara).
- La cámara a la **altura de los ojos**, a 40–80 cm.
- Si usas lentes con reflejos, el parpadeo puede detectarse peor.
- El tracking sigue funcionando aunque pongas otra ventana encima de avat-os (por ejemplo, un juego).

---

## 6. Expresiones y atajos de teclado

Tu avatar puede poner cara de alegre, enojado, triste, sorpresa o relajado. Se activan de dos formas:

- **Con los botones** del panel AVATAR, en la sección **Expresión**.
- **Con atajos de teclado**, que funcionan **aunque avat-os no esté en primer plano** (por ejemplo, mientras juegas).

| Atajo | Expresión |
|---|---|
| `Ctrl` + `Shift` + `1` | 😄 Alegre |
| `Ctrl` + `Shift` + `2` | 😠 Enojado |
| `Ctrl` + `Shift` + `3` | 😢 Triste |
| `Ctrl` + `Shift` + `4` | 😲 Sorpresa |
| `Ctrl` + `Shift` + `5` | 😌 Relajado |

- **Para volver a la cara normal**, pulsa otra vez el atajo de la expresión activa, o el botón **😐 Neutral**.
- El cambio no es brusco: la cara pasa de una expresión a otra en unos 0,2 segundos.
- El tracking sigue funcionando con una expresión activa: tu cabeza, tus ojos y tu boca siguen moviendo al avatar.
- La expresión elegida se mantiene si cargas otro avatar.

> **¿Por qué a veces no parpadea o no mueve la boca con una expresión activa?** Lo decide el autor del avatar.
> El formato VRM permite que cada expresión **bloquee el parpadeo o la boca** mientras está puesta, porque esa
> expresión ya trae su propia forma de ojos o de boca (la sonrisa de "alegre", la "O" de "sorpresa") y mezclarlas
> podría deformar la cara. avat-os **respeta siempre la configuración del autor**. Por ejemplo:
>
> | Avatar | Expresiones que bloquean la boca |
> |---|---|
> | `VRM1_Constraint_Twist_Sample` (pixiv) | Alegre, Sorpresa, Triste |
> | `Seed-san` | Ninguna (la boca se mueve con todas) |

> 🚧 **Próximamente:** un editor para elegir tus propios atajos, y gestos animados (saludar, asentir).

---

## 7. Calibración y ajustes de ojos, boca y cuerpo

### Calibrar (recomendado)

La calibración adapta el tracking **a tu cara y a tu cámara**: cuánto cierras los ojos al parpadear, cuánto abres la boca al hablar y cuál es tu postura "de frente". Si tu cámara está a un costado o más alta que la pantalla, después de calibrar el avatar mirará al frente cuando tú mires a la pantalla.

1. Siéntate como cuando transmites, con buena luz de frente.
2. En el panel **AVATAR**, junto a **Calibración**, pulsa **Calibrar** (si el tracking está apagado, se enciende solo).
3. Arriba a la derecha del asistente verás **● te veo** (en verde) si la cámara te detecta; si dice **● no te veo**, mejora la luz o ponte de frente. **Empezar** solo se activa cuando te ve.
4. Pulsa **Empezar** y sigue los 3 pasos. Cada uno empieza con una cuenta atrás de 3 segundos y mide durante unos 2 segundos (no te preocupes si reaccionas un poco tarde: el primer momento no se cuenta):
   1. Mira la pantalla de frente, con los ojos abiertos y la boca cerrada.
   2. **Al oír el primer pitido, cierra los ojos** y mantenlos cerrados **hasta el segundo pitido** (no podrás leer la pantalla, por eso los pitidos).
   3. Abre la boca lo más que puedas. Una barra te muestra lo que mide la cámara.
5. Llegas a **Prueba y ajuste**: el avatar **ya usa** tu calibración, aunque todavía no esté guardada. Parpadea y habla para comprobarlo.
   - Las barras **Ojos** y **Boca** muestran lo que mide la cámara en este momento. La marca gris es donde el avatar empieza a cerrar los ojos (o a abrir la boca) y la blanca, donde lo hace del todo; la barra se pone **naranja** al pasarla.
   - Si no te convence, mueve **Sensibilidad de los ojos** o **Sensibilidad de la boca** hacia *más* o *menos*: el avatar cambia al instante.
6. Pulsa **Guardar**. **Repetir** vuelve a hacer los 3 pasos y **Cancelar** descarta los cambios (el avatar vuelve a lo que tenías).

| Si… | Mueve… |
|---|---|
| El avatar no cierra del todo los ojos al parpadear | Sensibilidad de los ojos → **más** |
| El avatar entrecierra los ojos cuando los tienes abiertos | Sensibilidad de los ojos → **menos** |
| Al hablar, la boca del avatar casi no se mueve | Sensibilidad de la boca → **más** |
| La boca se abre de forma exagerada | Sensibilidad de la boca → **menos** |

- La calibración **se guarda** y se aplica sola cada vez que abres avat-os. El panel muestra *calibrado*.
- Para retocar la sensibilidad más tarde **sin repetir los pasos**, pulsa **Ajustar**.
- Para volver a los valores de fábrica, pulsa **Restablecer**.
- Si cambias de cámara, de lugar o de lentes, vuelve a calibrar (**Recalibrar**).

| Mensaje | Qué hacer |
|---|---|
| "No se vio tu cara durante la calibración" | Mejora la luz, ponte de frente a la cámara y repite |
| "No se notó la diferencia entre ojos abiertos y cerrados" | Repite y mantén los ojos bien cerrados entre los dos pitidos |
| "No se notó la boca abierta" | Repite y abre la boca lo más que puedas |

### Ajustes avanzados (editando un archivo)

> Solo para usuarios avanzados. **Con una calibración guardada, los valores de ojos y boca de esta sección no se usan**
> (se usan los tuyos); siguen aplicándose los de cuerpo y suavizado. Pronto habrá deslizadores en la interfaz.

### Dónde se cambian

Todos están en el archivo **`avatar\main.ts`** (ábrelo con el Bloc de notas o VS Code). Busca el nombre del ajuste y cambia solo el número.

### Ojos

| Ajuste | Valor actual | Qué hace | Cuándo cambiarlo |
|---|---|---|---|
| `EYE_OPEN` | `0.2` | Por **debajo** de este valor el ojo del avatar queda **abierto** | Si el avatar entrecierra los ojos cuando tú los tienes abiertos → **súbelo** (por ejemplo a `0.3`) |
| `EYE_CLOSED` | `0.55` | Desde este valor el ojo del avatar queda **cerrado del todo** | Si al parpadear el avatar no cierra del todo → **bájalo** (por ejemplo a `0.45`) |

**Cómo elegir los números:** enciende el tracking y mira **Ojo izq./der.** en el panel.
- Con los ojos abiertos: pon `EYE_OPEN` un poco **por encima** de lo que marca.
- Con los ojos cerrados: pon `EYE_CLOSED` un poco **por debajo** de lo que marca.

### Boca

| Ajuste | Valor actual | Qué hace | Cuándo cambiarlo |
|---|---|---|---|
| `MOUTH_CLOSED` | `0.03` | Por debajo de este valor la boca queda **cerrada** | Si la boca tiembla con la boca cerrada → **súbelo** (por ejemplo a `0.06`) |
| `MOUTH_OPEN` | `0.35` | Desde este valor la boca queda **abierta del todo** | Si al hablar la boca se mueve poco → **bájalo** (por ejemplo a `0.25`) |

**Cómo elegir los números:** mira **Boca** en el panel mientras hablas normalmente y pon `MOUTH_OPEN` cerca del valor más alto que veas.

### Cuerpo y suavizado

Estos ajustes están dentro de la función `applyTracking` del mismo archivo:

| Ajuste (cómo aparece en el código) | Valor actual | Qué hace |
|---|---|---|
| `delta * 18` | `18` | Velocidad de la cabeza y el cuerpo. **Más alto** = responde más rápido pero tiembla más |
| `delta * 45` | `45` | Velocidad de ojos y boca (tienen que ser rápidos: un parpadeo dura ~150 ms) |
| `* 0.012` y `0.25` | `0.012` / `0.25` | Cuánto se inclina el torso hacia los lados al moverte, y el máximo permitido |
| `* 0.01` y `0.2` | `0.01` / `0.2` | Cuánto se inclina el torso hacia adelante al acercarte, y el máximo |
| `["spine", 0.15], ["chest", 0.15], ["neck", 0.3], ["head", 0.4]` | 15 % · 15 % · 30 % · 40 % | Cómo se reparte el giro de la cabeza entre columna, pecho, cuello y cabeza (deben sumar 1) |
| `delta / 8` | `8` segundos | Cada cuánto el programa vuelve a tomar tu postura como "normal" |

### Aplicar los cambios

1. Guarda el archivo.
2. Cierra avat-os y vuelve a abrirlo (al arrancar se recompila la página del avatar).

Si algo deja de funcionar, vuelve a poner los valores de la columna **Valor actual**.

---

## 8. Fondos y objetos en pantalla

> 🚧 **Todavía no se pueden mostrar en el programa** (llegan en la Fase 1 y Fase 2), pero ya puedes ir preparando tus imágenes.

| Carpeta | Qué va | Formatos | Tamaño recomendado |
|---|---|---|---|
| `recursos\fondos\` | Fondos de escena o detrás del avatar | `.png`, `.jpg`, `.webp`, `.gif` (animado) | **1920×1080** |
| `recursos\objetos\` | Stickers, marcos, logos, alertas | **`.png` o `.webp` con fondo transparente**, `.gif` | Libre (un marco de pantalla completa: 1920×1080) |

**Imágenes de prueba incluidas** (libres de uso): `fondo-galaxia.png`, `marco-neon.png`, `sticker-estrella.png` y `logo-avat-os.png`.

> 💡 Para un objeto, usa siempre PNG con transparencia: si guardas un sticker en JPG, se verá con un recuadro de fondo.

---

## 9. Privacidad

- **La cámara nunca sale de tu equipo.** El análisis de tu cara se hace en tu computadora; no se envía nada a internet.
- **Funciona sin internet.** El modelo de detección facial se descarga una sola vez al preparar el programa.
- Los servidores internos de avat-os solo aceptan conexiones de tu propia computadora (`127.0.0.1`).
- Tus avatares e imágenes en `recursos\` nunca se suben al repositorio público.

---

## 10. Solución de problemas

| Problema | Qué hacer |
|---|---|
| **La vista previa dice "Vista previa no disponible"** | El motor de video (OBS) no arrancó. Cierra avat-os y vuelve a abrirlo; si sigue igual, revisa el mensaje en la terminal ("No se pudo iniciar libobs") |
| **El botón Cargar avatar está gris** | Es lo mismo: el motor de video no arrancó |
| **"Elige un archivo .vrm válido"** | El archivo no es `.vrm` o no existe. Convierte el modelo a VRM ([sección 4](#4-avatares)) |
| **El avatar no aparece después de cargarlo** | Mira el estado junto al nombre del avatar en el panel: **cargando…** = espera (la primera vez, o con el equipo muy ocupado, por ejemplo justo después de compilar, puede tardar hasta un minuto); **listo** = ya está en la escena; si aparece un **mensaje en rojo**, el archivo está dañado o no es un VRM real: prueba con un avatar de prueba incluido |
| **"No se pudo iniciar la cámara"** | Cierra otros programas que usen la cámara (Zoom, Teams, la app Cámara) y revisa *Configuración de Windows → Privacidad → Cámara* |
| **Buscando cara… todo el tiempo** | Mejora la luz y ponte de frente a la cámara |
| **El avatar parpadea mal, la boca se mueve poco o mira de costado** | Calibra (o recalibra) desde el panel; si hace falta, ajusta los valores de la [sección 7](#7-calibración-y-ajustes-de-ojos-boca-y-cuerpo) |
| **El avatar gira hacia el lado contrario** | Avísanos con un *issue*: el comportamiento esperado es como un espejo |
| **En la barra de tareas aparece un ícono genérico en lugar del logo** | Ya está corregido en esta versión. Si aún lo ves, cierra y vuelve a abrir avat-os |
| **El programa tarda en cerrarse** | Es normal: la ventana se cierra al instante, pero el motor de video tarda ~10 s en apagarse en segundo plano |
| **Un atajo `Ctrl+Shift+número` no hace nada** | Otro programa ya usa esa combinación (avat-os lo indica en la terminal: "No se pudo registrar el atajo"). Cierra ese programa o usa los botones del panel; pronto podrás elegir otros atajos |
| **El avatar no parpadea con una expresión activa** | Lo decide el avatar: muchas expresiones bloquean el parpadeo ([sección 6](#6-expresiones-y-atajos-de-teclado)) |

---

## 11. Qué viene después

Resumen del [plan completo](../tareas.md):

- **Fase 1 – Avatar:** editor de atajos, deslizadores de sensibilidad, lip-sync con el micrófono, fondos y efectos.
- **Fase 2 – Escenas y fuentes:** cámara, captura de pantalla o ventana, imágenes, texto y **chroma key**.
- **Fase 3 – Audio:** mezclador con micrófono y sonido del escritorio.
- **Fase 4 – Grabación:** grabar en MP4.
- **Después de la v1.0:** transmisión en vivo, cámara virtual, avatares 2D, seguimiento de manos y cuerpo, y el **modo dúo** (dos avatares conversando).
