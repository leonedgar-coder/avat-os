# Pruebas de avat-os

Lista de pruebas a mano en la app real, por fase. Cada fase se da por terminada cuando todas
sus pruebas pasan. Las pruebas automáticas (las que corren solas) están en la
[guía del programador](docs/GUIA-DEL-PROGRAMADOR.md#9-pruebas-y-verificación).

**Cómo usar este documento**

- Marca cada prueba con `[x]` cuando pase.
- Si una falla, déjala sin marcar y escribe debajo, en **Notas**, qué hiciste y qué viste
  (por ejemplo: _"1.3 — el ojo derecho no se cierra del todo"_).
- Si una prueba no aplica (por ejemplo, no tienes micrófono), márcala y anota _"no aplica"_.

**Antes de empezar cada ronda de pruebas:** cierra avat-os si está abierto y ábrelo con
`npm run tauri dev` (así se usa la versión más reciente).

---

## Fase 1 — Avatar

### 1.1 Inicio y logo

- [x] **Logo nuevo.** Mira el ícono de avat-os en la barra de tareas y el logo arriba a la izquierda del panel.
  - Debe pasar: se ve el dragón con el anillo que dice «avat-os · código abierto».
- [ ] **Último avatar al abrir.** Con un avatar ya usado antes, cierra avat-os y vuelve a abrirlo.
  - Debe pasar: el avatar aparece solo, sin elegirlo de nuevo, y junto a su nombre dice _listo_. El avatar no aparece solo pero aparece el historial de avatars usados, asi esta bien, no es necesario que aparezca solo el avatar, revisa y corrige si hay algun error en el codigo pero si aun no has implementado que aparezca automaticamente el avatar no lo hagas, si ya lo implementaste no lo modifiques tampoco, solo revisa el codigo
  - **Revisión (2026-11-11):** la carga automática ya estaba hecha y funciona. Probada con tu configuración: el avatar se carga solo, pero tarda unos 30 s en aparecer (el navegador interno de OBS tarda en arrancar). No se modificó. Se corrigió un detalle: el panel podía perderse el aviso de _listo_ y quedarse en _cargando…_.
- [x] **Una sola copia.** Con avat-os abierto, intenta abrirlo otra vez.
  - Debe pasar: no se abre una segunda ventana; vuelve al frente la que ya estaba. parece correcto pero revisa por si acaso
  - **Revisión (2026-11-11):** correcto. Se corrigió un caso: si se abría avat-os justo mientras se estaba cerrando, la ventana reaparecía un instante sin vista previa; ahora se ignora. Probado en la app real.

Notas: estoy agregando las notas en cada punto para que las revises en orden

### 1.2 Idioma y ayudas

- [x] **Cambiar de idioma.** Cambia entre _Español_ e _English_ con el selector de arriba a la derecha.
  - Debe pasar: todo el panel cambia de idioma, sin textos a medio traducir. **todo parece correcto**
- [x] **Ayudas (tooltips).** Deja el mouse medio segundo sobre varias opciones (y sobre los ⓘ). **todo parece correcto**
  - Debe pasar: aparece una explicación corta; no tapa otras partes ni se sale de la ventana.

Notas:

### 1.3 Avatar y avatares recientes

- [x] **Cargar un avatar.** Pulsa **Cargar avatar .vrm** y elige otro.
  - Debe pasar: _cargando…_ y luego _listo_; el avatar aparece en la vista previa.
- [x] **Avatares recientes.** Abre **Avatares recientes** y pulsa el avatar anterior.
  - Debe pasar: se carga; el que está cargado dice _en uso_.
- [x] **Quitar de la lista.** Pulsa **Quitar** en uno que no esté en uso.
  - Debe pasar: desaparece de la lista (el archivo no se borra).

Notas:

### 1.4 Tracking facial y calibración

- [x] **Encender el tracking.** Pulsa **Tracking facial**.
  - Debe pasar: se enciende la luz de la cámara y el avatar sigue tu cabeza.
- [x] **Recalibrar.** Pulsa **Recalibrar** y sigue los 3 pasos.
  - Debe pasar: llegas a **Prueba y ajuste** con tres barras: **Ojo izq.**, **Ojo der.** y **Boca**, cada una con sus marcas. **las instrucciones para recalibrar son buenas pero el proceso es muy rapido, agrega un boton para que el usuario tenga tiempo de leer y selecciones cuando iniciar cada una de las pruebas, boton para prueba para mirar directo a la camara, boton para cuando se inicia la prueba de ojos y boton para la prueba de la boca, la calibración es correcta pero va muy rapido y no alcanzas a leer cuando ya tienes que ejercutar**
  - **Revisión (2026-11-11):** hecho. Cada paso espera a que pulses **Empezar** (con la cámara viéndote) y solo entonces hace la cuenta de 3 y mide. **Cancelar** está disponible mientras espera. Para probar: recalibra y comprueba que puedes leer cada paso con calma.
- [x] **Parpadeos.** Parpadea normal, y luego guiña un ojo y después el otro.
  - Debe pasar: los dos ojos del avatar se cierran parejo al parpadear; cada guiño cierra solo ese ojo.
- [ ] **Sin parpadeos falsos.** Mira a la cámara con los ojos abiertos unos 30 segundos. **si hay parpadeos cortos unilaterales, es decir solo parpadea un ojo**
  - **Revisión (2026-11-11):** tu calibración guardada seguía siendo la antigua (sin ojos por separado; la nueva no se guardó: hay que terminar con **Guardar**). Corregido en el código: cerrar **un solo** ojo tiene que durar ~0,1 s para mostrarse (el ruido de la cámara dura menos; un guiño a propósito, más); los parpadeos con los dos ojos siguen al instante; y el margen mínimo se aplica también a calibraciones viejas. Para probar: recalibra, pulsa **Guardar** y repite esta prueba; prueba también un guiño a propósito.
  - Debe pasar: el avatar no hace parpadeos cortos que tú no hiciste.
- [ ] **Sin temblor.** Quédate quieto, mejor con poca luz.
  - Debe pasar: la cabeza del avatar no tiembla. **llega a suceder pero es muy poco, tuve que decarme un minuto para que se moviera**
  - **Revisión (2026-11-11):** corregido con una zona muerta suave después del anti-temblor: movimientos de menos de 0,5° (cabeza) o 0,6 cm (posición) se ignoran. En la simulación, los tirones con la cabeza quieta bajan unas 11 veces y el avatar no responde más lento al girar. Para probar: quédate quieto un par de minutos y luego haz movimientos pequeños y lentos (deben verse).
- [x] **Sin retraso.** Gira la cabeza rápido a un lado y al otro.
  - Debe pasar: el avatar te sigue sin quedarse atrás. \_\_
- [ ] **Cuerpo que acompaña.** Inclínate hacia los lados y acércate y aléjate de la cámara.
  - Debe pasar: el torso se inclina contigo. Anota si se mueve de más o de menos. **el tronco se mueve conmigo, el movimiento parece correcto, pero si me alejo o acerco a la camara el avatar no se mueve,**
  - **Revisión (2026-11-11):** antes, al acercarte solo se inclinaba el torso hacia adelante, y de frente casi no se ve. Ahora el avatar se acerca o se aleja de su cámara en la misma proporción que tú (se ve más grande o más chico) y su cara se queda en el mismo lugar de la pantalla; hasta 30 % más cerca y 50 % más lejos. Para probar: acércate y aléjate de la cámara; con calibración, la distancia normal es la del paso 1 (sin calibrar, se adapta en unos segundos).
- [x] **Mirada.** Sin mover la cabeza, mira a la izquierda, a la derecha, arriba y abajo.
  - Debe pasar: los ojos del avatar miran hacia el mismo lado; al mirar la pantalla, mira al frente.

Notas:

### 1.5 Lip-sync y vocales

- [x] **Encender el lip-sync.** Pulsa **Lip-sync** y habla.
  - Debe pasar: la barra **Voz** se mueve, junto a ella aparece la letra de la vocal y la boca del avatar se mueve.
- [x] **Calibrar las vocales.** Abre **Ajustes del lip-sync** → **Vocales** → **Calibrar** y di A, E, I, O, U cuando se pidan.
  - Debe pasar: al final se muestran tus valores y, tras **Guardar**, dice _calibradas para tu voz_.
- [ ] **Vocales al hablar.** Di despacio «a, e, i, o, u» y luego «mamá», «mesa», «pipa», «moto», «mudo». **la letra u tiende a fallar un poco**
  - **Revisión (2026-11-11):** tu calibración guardada mostraba el problema: con tu micrófono, la F2 de la A, la O y la U llegaba débil y se medía la F3, y tu U (669/3046 Hz) y tu O (637/2738) quedaron casi iguales. Cambiado el método: la calibración ahora guarda la **forma completa del sonido** de cada vocal (no solo dos resonancias). En la prueba con una voz así: 16 % de aciertos antes → 100 % ahora; con la entonación 15 % más aguda, 99 %. **Tu calibración vieja ya no se usa: hay que recalibrar las vocales** (Ajustes del lip-sync → Vocales → Calibrar → Guardar) y repetir esta prueba.
  - Debe pasar: la letra junto a **Voz** coincide y la boca toma la forma de cada vocal. Anota cuál falla, si alguna.
- [x] **Solo abrir y cerrar.** Cambia **Forma** a _Solo abrir y cerrar_.
  - Debe pasar: la boca solo se abre y se cierra (forma de A), sin letra junto a **Voz**.
- [x] **Cámara + voz.** Con tracking y lip-sync encendidos, ríete sin hacer ruido.
  - Debe pasar: la boca se abre con la cámara (en forma de A).

Notas:

### 1.6 Expresiones, gestos y atajos

- [x] **Botones.** Abre **Expresiones y gestos** y pulsa cada expresión y cada gesto.
  - Debe pasar: el avatar cambia de expresión (el nombre aparece junto al título del desplegable) y hace cada gesto.
- [x] **Atajos con otra ventana al frente.** Con un juego u otro programa en primer plano, usa `Ctrl+Shift+1` a `Ctrl+Shift+9`.
  - Debe pasar: el avatar cambia de expresión (1 a 5) y hace gestos (6 a 9).
- [ ] **Cambiar un atajo.** En **Atajos de teclado**, pulsa **Cambiar** en una acción y presiona otra combinación.
  - Debe pasar: queda guardada y funciona; **Esc** cancela; una combinación que no sirve muestra el motivo. **funciona mas o menos bien pero no funciona con algunas teclas, por ejemplo probre el ctrl+shift+0 y no funciono pero con el ctrl+shift+e si funciona, con las letras si funciona, con algunos numeros o simbolos especiales no**
  - **Revisión (2026-11-11):** dos causas. 1) **Ctrl+Shift+0** está reservada a propósito (Windows la usa para cambiar el idioma del teclado); ahora el mensaje lo explica. 2) **Símbolos** (ñ, +, ´…): la biblioteca de atajos traducía las teclas como si el teclado fuera de EE. UU. y el atajo quedaba en otra tecla. Corregido: se guarda la tecla real de tu teclado y el editor muestra su carácter ("Ctrl+Shift+Ñ"). Probado en la app real con tu teclado: Ctrl+Shift+ñ queda registrado en la ñ. La tecla **<** no se puede usar (avisa). Los números 1–9 con Ctrl+Shift ya los usan expresiones y gestos (el editor dice cuál). Para probar: asigna Ctrl+Shift+ñ y algún símbolo y úsalos con otra ventana al frente.
- [x] **Atajos de tracking y lip-sync.** Asigna atajos a _Encender/apagar tracking_ y _Encender/apagar lip-sync_.
  - Debe pasar: encienden y apagan cada uno, también con otra ventana al frente. **parecen funcionar correctamente**
- [x] **Restablecer atajos.**
  - Debe pasar: vuelven los de fábrica.

Notas:

### 1.7 Fondo y efectos

- [x] **Color.** Fondo → _Color_ y elige un color.
  - Debe pasar: el fondo del avatar cambia a ese color.
- [x] **Imagen.** Fondo → _Imagen o video_ y elige una imagen de `recursos\fondos`; prueba **Cubrir** y **Ajustar**.
  - Debe pasar: la imagen se ve detrás del avatar y cambia el ajuste.
- [x] **Video.** Elige `recursos\fondos\fondo-prueba.mp4` (y luego `fondo-prueba.webm`); prueba **Cubrir** y **Ajustar**.
  - Debe pasar: el video se repite en bucle, sin sonido; cambiar el ajuste **no** lo reinicia desde el principio.
- [x] **Efectos.** Abre **Efectos** y prueba el plano de cámara, la luz y el contorno.
  - Debe pasar: cada cambio se ve al instante en el avatar; **Restablecer** vuelve a lo normal.

Notas:

### 1.8 Panel

- [x] **Desplegables recordados.** Abre algunos desplegables (por ejemplo **Expresiones y gestos** y **Efectos**), cierra avat-os y vuelve a abrirlo.
  - Debe pasar: siguen abiertos o cerrados como los dejaste.
- [x] **Todo se recuerda.** Después de reabrir: fondo, efectos, calibración, atajos, idioma y ajustes del lip-sync.
  - Debe pasar: todo está como lo dejaste.

Notas:

---

## Fase 1 — Segunda ronda (correcciones)

Pruebas de lo que se corrigió después de la primera ronda (2026-11-11). Primero comprueba
lo nuevo y después repite lo que podría haberse afectado. Entre paréntesis, la prueba de la
primera ronda que motivó cada corrección.

**Antes de empezar:** cierra avat-os y ábrelo con `npm run tauri dev` (hubo cambios en Rust).

### R1 Inicio y una sola copia (1.1)

- [x] **Avatar al abrir.** Cierra avat-os con un avatar cargado, ábrelo y espera sin tocar nada.
  - Debe pasar: en unos 30 s el avatar aparece en la vista previa y junto a su nombre dice _listo_ (no se queda en _cargando…_).
- [x] **Abrir mientras se cierra.** Cierra avat-os e inmediatamente intenta abrirlo otra vez.
  - Debe pasar: la ventana que se cerraba **no** vuelve a aparecer. Después de unos segundos, avat-os se abre normalmente.

Notas:

### R2 Calibración paso a paso (1.4)

- [x] **Cada paso espera.** Pulsa **Recalibrar** (o **Calibrar**) → **Empezar**.
  - Debe pasar: cada paso muestra su instrucción con **Empezar** y **Cancelar**, y no mide nada hasta que pulses **Empezar**. Puedes leer con calma.
- [x] **Sin cara, no empieza.** En un paso, sal del cuadro de la cámara.
  - Debe pasar: el botón **Empezar** se desactiva hasta que la cámara te vuelve a ver (**● te veo**).
- [ ] **Guardar.** Termina los 3 pasos y pulsa **Guardar** (importante: la calibración anterior no se había guardado).
  - **Revisión (2026-11-12):** el paso de los ojos exigía una diferencia fija de 0,08 y tus ojos dan ~0,09 (al límite: fallaba según la luz). Ahora se acepta si la diferencia supera varias veces lo que tiembla la medida de tus ojos (mínimo 0,03). Si falla, **el mensaje muestra tus números**: anótalos aquí. Si se acepta con una señal pequeña, aparece un aviso amarillo (se puede guardar igual).
  - Debe pasar: junto a **Calibración** dice _calibrado_; en **Prueba y ajuste** hay barras para **Ojo izq.** y **Ojo der.**, cada una con sus marcas.

Notas:

### R3 Ojos: parpadeos falsos y guiños (1.4)

- [x] **Sin parpadeos falsos.** Con la calibración nueva guardada, mira a la cámara con los ojos abiertos unos 30 segundos.
  - Debe pasar: el avatar no parpadea con un solo ojo ni hace parpadeos cortos que tú no hiciste.
- [x] **Parpadeo normal.** Parpadea varias veces.
  - Debe pasar: los dos ojos del avatar se cierran a la vez y al instante.
- [ ] **Guiño a propósito.** Guiña un ojo y mantenlo cerrado medio segundo; luego el otro.
  - Debe pasar: el avatar guiña ese ojo (aparece un instante después, unos 0,1 s: es a propósito) y el otro ojo queda abierto. **se cierran los dos ojos, tengo que mantener mucho tiempo cerrado un ojo para que detecte el guiño**
  - **Revisión (2026-11-12):** los guiños no se veían: el filtro de parpadeos falsos exigía una diferencia grande entre los ojos y, con tu señal de ojos (débil y "mezclada" entre los dos ojos al guiñar), nunca la alcanzaba. Corregido: ahora protege por duración (no por diferencia) y, en un guiño, mantiene abierto el otro ojo. Además: la calibración nunca se había guardado porque el paso de los ojos fallaba (corregido antes); comprobado en la app real que **Guardar** funciona.

Notas:

### R4 Cabeza quieta y cuerpo (1.4)

- [x] **Sin tirones.** Quédate quieto un par de minutos, mejor con poca luz.
  - Debe pasar: la cabeza y el torso del avatar no dan saltos.
- [x] **Movimientos chicos.** Mueve la cabeza despacio y poco (asentir apenas, girar un poco).
  - Debe pasar: el avatar también los hace (no se queda "congelado").
- [x] **Giros rápidos.** Gira la cabeza rápido a los lados.
  - Debe pasar: el avatar te sigue sin quedarse atrás.
- [x] **Acercarte y alejarte.** Acércate a la cámara y luego aléjate.
  - Debe pasar: el avatar se ve más grande al acercarte y más chico al alejarte; su cara se queda en el mismo lugar de la pantalla y no se corta. Con calibración, a tu distancia del paso 1 vuelve a su tamaño normal.
- [x] **Inclinarte.** Inclínate hacia los lados.
  - Debe pasar: el torso se inclina contigo, como antes.

Notas:

### R5 Vocales con la calibración nueva (1.5)

- [x] **Recalibrar las vocales.** Abre **Ajustes del lip-sync**: debe decir _valores típicos_ (la calibración anterior ya no se usa). Pulsa **Calibrar**, di A, E, I, O, U y pulsa **Guardar**.
  - Debe pasar: al final dice _calibradas para tu voz_. Si aparece un aviso de dos vocales parecidas, repítelo pronunciándolas bien distintas.
- [x] **La U.** Di despacio «u, o, u, o» y luego «mudo», «pupú», «uno».
  - **Revisión (2026-11-12):** tu calibración dejó la U y la O casi iguales (separación 1,4; las demás vocales entre 7,8 y 27,7): la forma medida tenía poco detalle en los graves, justo donde se distinguen. Cambiada a escala mel (más detalle en los graves): en simulación la U y la O se separan 4–5 veces más y no se confunden. **Hay que recalibrar las vocales otra vez** (dirá _valores típicos_) y repetir R5.
  - Debe pasar: la letra junto a **Voz** muestra la U (y la O cuando corresponde), y la boca toma su forma.
- [ ] **Las cinco.** Di «a, e, i, o, u» y «mamá», «mesa», «pipa», «moto».
  - Debe pasar: cada vocal se reconoce. Anota cuál falla, si alguna.
- [ ] **Al hablar normal.** Habla un rato como lo harías en una transmisión.
  - Debe pasar: la letra junto a **Voz** cambia mientras hablas (si se queda pegada en una vocal, anótalo: habría que ajustar un umbral).

Notas:

### R6 Atajos con símbolos (1.6)

- [x] **Ctrl+Shift+ñ.** En **Atajos de teclado**, pulsa **Cambiar** en una acción (por ejemplo _Encender/apagar lip-sync_) y presiona Ctrl+Shift+ñ.
  - Debe pasar: el editor muestra **Ctrl+Shift+Ñ** y el atajo funciona, también con otra ventana al frente.
- [x] **Otros símbolos.** Prueba con Ctrl+Shift++ (la tecla +) y Alt+´.
  - Debe pasar: se muestran con su símbolo y funcionan.
- [ ] **Ctrl+Shift+0.** Intenta asignarlo.
  - Debe pasar: no se acepta y el mensaje explica que Windows lo usa para cambiar el idioma del teclado. **no aparece el mensaje**
- [x] **Tecla <.** Intenta asignar Ctrl+Shift+< (a la izquierda de la Z).
  - Debe pasar: no se acepta y el mensaje dice que esa tecla no se puede usar en un atajo.
- [x] **Los de antes.** Usa `Ctrl+Shift+1` a `Ctrl+Shift+9` con otra ventana al frente.
  - Debe pasar: siguen funcionando (expresiones y gestos).

Notas:

### R7 Repaso rápido (que nada se haya roto)

- [x] **Lip-sync y cámara.** Con tracking y lip-sync encendidos, habla y ríete sin sonido.
  - Debe pasar: la boca se mueve con la voz y se abre al reír (forma de A).
- [x] **Expresiones y gestos.** Prueba un par desde el panel.
  - Debe pasar: funcionan como antes.
- [ ] **Fondo de video.** Elige `recursos\fondos\fondo-prueba.mp4` y cambia entre **Cubrir** y **Ajustar**.
  - Debe pasar: el video se ve detrás del avatar y no se reinicia al cambiar el ajuste. **aparecen los fondos tanto de video como imagen pero no se redimensiona la imagen ni pasa nada con el tamaño del fondo**
- [x] **Todo se recuerda.** Cierra y abre avat-os.
  - Debe pasar: la calibración, las vocales calibradas, los atajos nuevos y los desplegables siguen como los dejaste.

Notas:

---

## Fase 1 — Tercera ronda (cierre)

> ✅ **Fase 1 terminada el 2026-11-13.** Pasaron todas las pruebas de esta ronda. Las que
> quedaron sin marcar en la primera y la segunda ronda se corrigieron y se repitieron aquí o
> en la segunda ronda. Inclinarse hacia el frente queda para la Fase 1B.

Última ronda de la fase 1 (2026-11-12). Son las tres fallas de la segunda ronda y lo que
quedó sin confirmar. Se corrigen **de una en una**, en este orden; cada punto dice qué falló.
Cuando todo pase, la fase 1 queda terminada y se sube a GitHub.

**Antes de empezar:** cierra avat-os y ábrelo con `npm run tauri dev`.

**Fuera de esta ronda (no cuenta como falla):** al inclinarte **hacia el frente**, el avatar
se acerca a la cámara en vez de solo inclinar la cabeza. Es una limitación conocida: la
cámara solo ve la cara y no distingue inclinarse de acercarse. Se resuelve en la
**Fase 1B (hombros)**, justo después de subir la fase 1.

### T1 Guiños (falló R3)

En la segunda ronda: _"se cierran los dos ojos, tengo que mantener mucho tiempo cerrado un
ojo para que detecte el guiño"_.

- [x] **Guiño izquierdo y derecho.** Guiña un ojo medio segundo; luego el otro.
  - Debe pasar: se cierra solo ese ojo, casi al instante, y el otro queda abierto.
- [x] **Sin parpadeos falsos.** Mira a la cámara con los ojos abiertos unos 30 segundos.
  - Debe pasar: el avatar no parpadea con un solo ojo (que no vuelva lo que ya estaba corregido).
- [x] **Parpadeo normal.** Parpadea varias veces.
  - Debe pasar: los dos ojos se cierran a la vez y al instante.

Notas:

### T2 Ctrl+Shift+0 (falló R6)

En la segunda ronda: _"no aparece el mensaje"_.

- [x] **Ctrl+Shift+0.** En **Atajos de teclado**, pulsa **Cambiar** e intenta asignar Ctrl+Shift+0.
  - **Revisión (2026-11-13):** en tu equipo, Windows tiene Ctrl+Shift+0 como atajo de idioma del teclado y se queda la pulsación del 0 antes de que llegue a cualquier ventana: el editor nunca la recibía y no podía avisar. Ahora, al soltar Ctrl y Shift sin que haya llegado ninguna tecla, avisa que Windows u otro programa se queda esa combinación (y si llega solo el «soltar» del 0, muestra el mensaje del idioma del teclado).
  - Debe pasar: no se acepta y aparece un mensaje en rojo: o el del idioma del teclado, o _"Con Ctrl+Shift no llegó ninguna tecla…"_ (que nombra Ctrl+Shift+0 como ejemplo). **no aparece el mensaje**
- [x] **Los demás siguen igual.** Asigna Ctrl+Shift+ñ e intenta Ctrl+Shift+<.
  - Debe pasar: Ctrl+Shift+Ñ se acepta y funciona; Ctrl+Shift+< se rechaza con su mensaje.

Notas:

### T3 Cubrir y Ajustar del fondo (falló R7)

En la segunda ronda: _"aparecen los fondos tanto de video como imagen pero no se redimensiona
la imagen ni pasa nada con el tamaño del fondo"_.

- **Revisión (2026-11-13):** el programa funcionaba; la prueba no servía. Todos los fondos de prueba eran 16:9, igual que la pantalla del avatar (1920×1080), y con esa forma **Cubrir** y **Ajustar** se ven idénticos (no hay nada que recortar ni franjas). Agregados `fondo-cuadrado.png` y `fondo-cuadrado.mp4`: cuadrados y con un marco rojo para que la diferencia se note.
- [x] **Imagen.** Fondo → _Imagen o video_, elige `recursos\fondos\fondo-cuadrado.png` y cambia entre **Cubrir** y **Ajustar**.
  - Debe pasar: con **Ajustar** se ve el cuadrado entero, con su marco rojo completo, y franjas a los lados; con **Cubrir** llena todo el ancho y se pierde el marco rojo de arriba y de abajo.
- [x] **Video.** Lo mismo con `recursos\fondos\fondo-cuadrado.mp4`.
  - Debe pasar: cambia igual que la imagen y el video **no** se reinicia al cambiar el ajuste (las figuras que se mueven siguen donde iban, no saltan al principio).

Notas:

### T4 Lo que quedó sin marcar

- [x] **Guardar la calibración (R2).** Pulsa **Recalibrar**, termina los 3 pasos y pulsa **Guardar**.
  - Debe pasar: junto a **Calibración** dice _calibrado_; en **Prueba y ajuste** hay barras para **Ojo izq.**, **Ojo der.** y **Boca**, cada una con sus marcas.
- [x] **Las cinco vocales (R5).** Di «a, e, i, o, u» y «mamá», «mesa», «pipa», «moto».
  - Debe pasar: cada vocal se reconoce. Las más parecidas en tu voz son la **I** y la **E**: fíjate en ellas.
- [x] **Al hablar normal (R5).** Habla un rato como en una transmisión.
  - Debe pasar: la letra junto a **Voz** cambia mientras hablas y no se queda pegada.

Notas:

### T5 Repaso final

- [x] **Todo se recuerda.** Con todo lo anterior hecho, cierra y abre avat-os.
  - Debe pasar: calibración, vocales, atajos, fondo (con su ajuste), efectos, idioma y desplegables siguen como los dejaste.

Notas:

---

## Fase 1B — Cuerpo base (hombros)

_(Se agregarán cuando se programe esta fase.)_

## Fase 2 — Escenas y fuentes

_(Se agregarán cuando se programe esta fase.)_

## Fase 3 — Audio

_(Se agregarán cuando se programe esta fase.)_

## Fase 4 — Grabación

_(Se agregarán cuando se programe esta fase.)_

## Fase 5 — Movimiento del cuerpo

_(Se agregarán cuando se programe esta fase.)_

## Fase 6 — Pulido de la v1.0

_(Se agregarán cuando se programe esta fase.)_
