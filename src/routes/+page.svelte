<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { open } from "@tauri-apps/plugin-dialog";
  import { FaceTracker, type TrackingFrame } from "$lib/tracking";
  import { i18n, LOCALES, t, tError, type Locale, type MessageKey } from "$lib/i18n/index.svelte";
  import { tooltip } from "$lib/tooltip";
  import { rememberOpen } from "$lib/rememberOpen";
  import Calibration, { type CalibrationValues } from "$lib/Calibration.svelte";
  import ShortcutEditor from "$lib/ShortcutEditor.svelte";
  import VowelCalibration from "$lib/VowelCalibration.svelte";
  import { LipSync, type MicDevice } from "$lib/lipsync";
  import { VOWEL_LETTERS } from "$lib/vowels";
  import { onMount } from "svelte";

  // Datos de ejemplo: se reemplazan cuando conectemos libobs (Fase 2).
  // Guardan la clave del texto (no el texto) para que cambien con el idioma.
  let scenes = $state<MessageKey[]>(["scenes.main", "scenes.start"]);
  let activeScene = $state(0);
  let sources = $state<{ name: MessageKey; visible: boolean }[]>([
    { name: "sources.avatar", visible: true },
    { name: "sources.camera", visible: false },
    { name: "sources.display", visible: true },
  ]);
  let mixer = $state<{ name: MessageKey; level: number; muted: boolean }[]>([
    { name: "mixer.mic", level: 0.62, muted: false },
    { name: "mixer.desktop", level: 0.35, muted: false },
  ]);
  let recording = $state(false);
  let version = $state("");
  let obsActive = $state(false);
  let canvas: HTMLDivElement;
  let avatarName = $state<string | null>(null);
  // Se guarda el error original y se traduce al mostrarlo (así sigue el idioma activo).
  let avatarError = $state<unknown>(null);
  // Estado que informa la página del avatar (dentro de OBS): cargando, listo o error.
  let avatarStatus = $state<{ state: "loading" | "loaded" | "error"; detail: string } | null>(null);

  // Expresiones: atajos globales Ctrl+Shift+1…5 (en Rust) o estos botones.
  const EXPRESSION_KEYS: Record<string, MessageKey> = {
    happy: "expression.happy",
    angry: "expression.angry",
    sad: "expression.sad",
    surprised: "expression.surprised",
    relaxed: "expression.relaxed",
  };
  let expressions = $state<{ name: string; shortcut: string | null }[]>([]);
  // Gestos animados: atajos globales Ctrl+Shift+6…9 (en Rust) o estos botones.
  const GESTURE_KEYS: Record<string, MessageKey> = {
    wave: "gesture.wave",
    nod: "gesture.nod",
    shake: "gesture.shake",
    shrug: "gesture.shrug",
  };
  let gestures = $state<{ name: string; shortcut: string | null }[]>([]);
  let gestureError = $state<unknown>(null);
  // Atajos globales que no se pudieron registrar (otro programa ya los usa).
  let failedShortcuts = $state<string[]>([]);
  function loadShortcutLabels() {
    invoke<{ name: string; shortcut: string | null }[]>("expression_list")
      .then((list) => (expressions = list))
      .catch((e) => console.error("expression_list:", e));
    invoke<{ name: string; shortcut: string | null }[]>("gesture_list")
      .then((list) => (gestures = list))
      .catch((e) => console.error("gesture_list:", e));
  }
  async function retryShortcuts() {
    failedShortcuts = await invoke<string[]>("shortcuts_retry").catch(() => failedShortcuts);
  }
  function playGesture(name: string) {
    invoke("gesture_play", { name })
      .then(() => (gestureError = null))
      .catch((e) => (gestureError = e));
  }
  let activeExpression = $state<string | null>(null);

  function setExpression(name: string | null) {
    // Rust alterna (pulsar la activa vuelve a neutral, igual que el atajo); null = neutral.
    invoke("expression_set", { name }).catch((e) => console.error("expression_set:", e));
  }

  // Seguimiento facial: la cámara se procesa aquí y los datos van a Rust → avatar.
  let trackingOn = $state(false);
  let trackingBusy = $state(false);
  let trackingFps = $state(0);
  let faceFound = $state(false);
  let trackingError = $state<unknown>(null);
  let lastFrame = $state<TrackingFrame | null>(null);
  // Otros interesados en cada cuadro (el asistente de calibración).
  const frameListeners = new Set<(frame: TrackingFrame) => void>();
  function subscribeFrames(fn: (frame: TrackingFrame) => void) {
    frameListeners.add(fn);
    return () => frameListeners.delete(fn);
  }
  const tracker = new FaceTracker(
    (frame: TrackingFrame) => {
      invoke("tracking_update", { frame }).catch(() => {});
      for (const fn of frameListeners) fn(frame);
    },
    (stats) => {
      trackingFps = stats.fps;
      faceFound = stats.faceFound;
      lastFrame = stats.last;
    },
  );

  // Solo en desarrollo (Vite lo elimina de la versión final): permite a las pruebas
  // automáticas simular el tracking sin cámara ni cara real.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__avatosTest = {
      setTrackingOn: (on: boolean) => (trackingOn = on),
      emitFrame: (frame: TrackingFrame) => frameListeners.forEach((fn) => fn(frame)),
    };
  }

  // Calibración: el asistente necesita el tracking encendido (lo enciende si hace falta).
  let calibrating = $state(false);
  let savedCalibration = $state<CalibrationValues | null>(null);
  const calibrated = $derived(savedCalibration !== null);
  // "Ajustar" abre el asistente directo en "Prueba y ajuste" (solo si tiene sus medidas).
  let adjusting = $state(false);
  let calibrationError = $state<unknown>(null);
  async function refreshCalibration() {
    savedCalibration = await invoke<CalibrationValues | null>("calibration_get").catch(() => null);
  }
  async function startCalibration(adjust = false) {
    calibrationError = null;
    if (!trackingOn) await toggleTracking();
    if (trackingOn) {
      adjusting = adjust;
      calibrating = true;
    }
  }
  async function resetCalibration() {
    try {
      await invoke("calibration_reset");
      savedCalibration = null;
    } catch (e) {
      calibrationError = e;
    }
  }

  // Lip-sync: el micrófono se analiza aquí y a Rust → avatar solo viaja el nivel (0–1).
  // Preferencias del usuario (micrófono, modo, sensibilidad): se recuerdan en este equipo.
  const LIPSYNC_PREFS = "avatos.lipsync";
  type LipsyncMode = "combine" | "voice";
  function loadLipsyncPrefs(): { deviceId: string; mode: LipsyncMode; sensitivity: number; vowels: boolean } {
    try {
      const p = JSON.parse(localStorage.getItem(LIPSYNC_PREFS) ?? "{}");
      return {
        deviceId: typeof p.deviceId === "string" ? p.deviceId : "",
        mode: p.mode === "voice" ? "voice" : "combine",
        sensitivity: typeof p.sensitivity === "number" ? Math.min(1, Math.max(-1, p.sensitivity)) : 0,
        vowels: p.vowels !== false, // activadas salvo que se hayan apagado
      };
    } catch {
      return { deviceId: "", mode: "combine", sensitivity: 0, vowels: true };
    }
  }
  const lipsyncPrefs = loadLipsyncPrefs();
  let lipsyncOn = $state(false);
  let lipsyncBusy = $state(false);
  let lipsyncLevel = $state(0);
  let lipsyncError = $state<unknown>(null);
  let micDevices = $state<MicDevice[]>([]);
  let micId = $state(lipsyncPrefs.deviceId);
  let lipsyncMode = $state<LipsyncMode>(lipsyncPrefs.mode);
  let lipsyncSensitivity = $state(lipsyncPrefs.sensitivity);
  let lipsyncVowels = $state(lipsyncPrefs.vowels);
  /** Vocal que se está diciendo (para mostrarla junto al nivel), o "" en silencio. */
  let currentVowel = $state("");
  const lipsync = new LipSync((level, vowels) => {
    lipsyncLevel = level;
    if (vowels && level > 0.15) {
      currentVowel = VOWEL_LETTERS[vowels.indexOf(Math.max(...vowels))];
    } else currentVowel = "";
    invoke("lipsync_update", { level, mode: lipsyncMode, vowels }).catch(() => {});
  });
  $effect(() => {
    lipsync.sensitivity = lipsyncSensitivity;
    lipsync.vowels = lipsyncVowels;
    try {
      localStorage.setItem(
        LIPSYNC_PREFS,
        JSON.stringify({ deviceId: micId, mode: lipsyncMode, sensitivity: lipsyncSensitivity, vowels: lipsyncVowels }),
      );
    } catch {
      /* no se pudo guardar: se usarán los valores por defecto la próxima vez */
    }
  });

  async function startLipsync() {
    lipsyncBusy = true;
    lipsyncError = null;
    try {
      await lipsync.start(micId || undefined);
      lipsyncOn = true;
      micDevices = await LipSync.devices(); // con permiso, Windows ya da los nombres
    } catch (e) {
      lipsyncOn = false;
      lipsyncError = e;
    } finally {
      lipsyncBusy = false;
    }
  }
  async function toggleLipsync() {
    if (lipsyncBusy) return;
    if (lipsyncOn) {
      lipsync.stop();
      lipsyncOn = false;
      lipsyncLevel = 0;
      return;
    }
    await startLipsync();
  }
  /** Cambiar de micrófono con el lip-sync encendido lo reinicia con el nuevo. */
  async function changeMic(id: string) {
    micId = id;
    if (lipsyncOn) await startLipsync();
  }
  function micErrorText(e: unknown): string {
    const name = e instanceof DOMException ? e.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") return t("lipsync.micDenied");
    if (name === "NotFoundError" || name === "OverconstrainedError") return t("lipsync.micNotFound");
    if (name === "NotReadableError" || name === "AbortError") return t("lipsync.micBusy");
    return t("lipsync.micError", { error: String(e) });
  }

  // Fondo del avatar (lo guarda Rust en fondo.json y lo aplica la página del avatar).
  type BackgroundValue = {
    kind: "transparent" | "color" | "image";
    color: string;
    image: string | null;
    fit: "cover" | "contain";
  };
  let background = $state<BackgroundValue>({ kind: "transparent", color: "#00b140", image: null, fit: "cover" });
  let backgroundError = $state<unknown>(null);
  const backgroundName = $derived(background.image?.split(/[\\/]/).pop() ?? null);
  async function saveBackground(next: BackgroundValue) {
    backgroundError = null;
    try {
      await invoke("background_set", { value: next });
      background = next;
    } catch (e) {
      backgroundError = e;
    }
  }
  async function chooseBackgroundImage() {
    const defaultPath = (await invoke<string | null>("resources_dir", { kind: "fondos" }).catch(() => null)) ?? undefined;
    const path = await open({
      title: t("background.dialogTitle"),
      defaultPath,
      multiple: false,
      directory: false,
      filters: [{ name: t("background.dialogFilter"), extensions: ["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm"] }],
    });
    if (typeof path === "string") await saveBackground({ ...background, kind: "image", image: path });
  }
  async function setBackgroundKind(select: HTMLSelectElement) {
    const kind = select.value as BackgroundValue["kind"];
    // Elegir "Imagen" sin imagen todavía: abrir el selector en lugar de guardar algo inválido.
    if (kind === "image" && !background.image) await chooseBackgroundImage();
    else await saveBackground({ ...background, kind });
    // Si se canceló o falló, la lista debe volver a mostrar el modo real.
    select.value = background.kind;
  }

  // Efectos del avatar (cámara, luz, contorno). Se guardan en efectos.json (Rust).
  type EffectsValue = {
    shot: "close" | "medium" | "full";
    zoom: number;
    height: number;
    angle: number;
    lightIntensity: number;
    lightColor: string;
    lightAngle: number;
    ambient: number;
    outline: number;
  };
  const DEFAULT_EFFECTS: EffectsValue = {
    shot: "medium", zoom: 1, height: 0, angle: 0,
    lightIntensity: 1, lightColor: "#ffffff", lightAngle: 45, ambient: 0.4, outline: 1,
  };
  let effects = $state<EffectsValue>({ ...DEFAULT_EFFECTS });
  let effectsError = $state<unknown>(null);
  // Los deslizadores cambian muchas veces por segundo: se envía el último valor
  // cada ~100 ms (el avatar ya se mueve con suavidad entre valores).
  let effectsTimer: ReturnType<typeof setTimeout> | undefined;
  function saveEffects(next: EffectsValue) {
    effects = next;
    clearTimeout(effectsTimer);
    effectsTimer = setTimeout(() => {
      invoke("effects_set", { values: $state.snapshot(effects) })
        .then(() => (effectsError = null))
        .catch((e) => (effectsError = e));
    }, 100);
  }
  function setEffect<K extends keyof EffectsValue>(key: K, value: EffectsValue[K]) {
    saveEffects({ ...effects, [key]: value });
  }

  /** Errores comunes de getUserMedia con un mensaje claro; los demás, con el texto técnico. */
  function cameraErrorText(e: unknown): string {
    const name = e instanceof DOMException ? e.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") return t("tracking.cameraDenied");
    if (name === "NotFoundError" || name === "OverconstrainedError") return t("tracking.cameraNotFound");
    if (name === "NotReadableError" || name === "AbortError") return t("tracking.cameraBusy");
    return t("tracking.cameraError", { error: String(e) });
  }

  async function toggleTracking() {
    if (trackingBusy) return;
    trackingError = null;
    if (trackingOn) {
      tracker.stop();
      trackingOn = false;
      return;
    }
    trackingBusy = true;
    try {
      await tracker.start();
      trackingOn = true;
    } catch (e) {
      trackingError = e;
    } finally {
      trackingBusy = false;
    }
  }

  // Avatares recientes (recent_avatars.rs): del más nuevo al más viejo.
  interface RecentAvatar {
    path: string;
    name: string;
    exists: boolean;
    /** Es el avatar cargado ahora. */
    current: boolean;
  }
  let recentAvatars = $state<RecentAvatar[]>([]);
  function loadRecentAvatars() {
    invoke<RecentAvatar[]>("avatar_recent")
      .then((list) => (recentAvatars = list ?? []))
      .catch((e) => console.error("avatar_recent:", e));
  }
  function forgetRecentAvatar(path: string) {
    invoke("avatar_recent_remove", { path }).catch((e) => console.error("avatar_recent_remove:", e));
  }

  async function chooseAvatar() {
    const defaultPath = (await invoke<string | null>("resources_dir", { kind: "avatares" }).catch(() => null)) ?? undefined;
    const path = await open({
      title: t("avatar.dialogTitle"),
      defaultPath,
      multiple: false,
      directory: false,
      filters: [{ name: t("avatar.dialogFilter"), extensions: ["vrm"] }],
    });
    if (typeof path === "string") await loadAvatar(path);
  }

  async function loadAvatar(path: string) {
    try {
      avatarStatus = { state: "loading", detail: "" };
      await invoke("avatar_load", { path });
      avatarName = path.split(/[\\/]/).pop() ?? path;
      avatarError = null;
    } catch (e) {
      avatarError = e;
    }
  }

  // La vista previa de libobs es una ventana nativa encima de la web:
  // le enviamos la posición y el tamaño del recuadro en píxeles físicos.
  function syncPreview() {
    if (!obsActive || !canvas) return;
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    invoke("preview_set_bounds", {
      x: Math.round(r.left * dpr),
      y: Math.round(r.top * dpr),
      width: Math.round(r.width * dpr),
      height: Math.round(r.height * dpr),
    }).catch((e) => console.error("preview_set_bounds:", e));
  }

  onMount(() => {
    invoke<string>("app_version").then((v) => (version = v)).catch(() => (version = "dev"));
    refreshCalibration();
    invoke<EffectsValue>("effects_get")
      .then((fx) => fx && (effects = fx))
      .catch(() => {});
    invoke<BackgroundValue>("background_get")
      .then((bg) => bg && (background = bg))
      .catch(() => {});
    // El video de fondo avisa si se reproduce o no (códec que el navegador de OBS no tiene).
    const unlistenBgStatus = listen<{ state: string; detail: string }>("background-status", (e) => {
      if (e.payload.state === "error") {
        backgroundError = e.payload.detail === "4" ? "background_video_unsupported" : "background_video_failed";
      } else if (backgroundError === "background_video_unsupported" || backgroundError === "background_video_failed") {
        backgroundError = null;
      }
    }).catch(() => () => {});
    // Primero escuchar y después preguntar el estado: al revés, un aviso que llegara justo
    // entre las dos cosas se perdería (p. ej. el avatar del arranque quedaba en "cargando…").
    // Rust guarda el último estado antes de avisar, así que la respuesta siempre está al día.
    const unlistenStatus = listen<NonNullable<typeof avatarStatus>>("avatar-status", (e) => (avatarStatus = e.payload))
      .then((off) => {
        invoke<typeof avatarStatus>("avatar_status")
          .then((st) => st && (avatarStatus = st))
          .catch(() => {});
        return off;
      })
      .catch(() => () => {});
    const unlistenShortcuts = listen<string[]>("shortcuts-status", (e) => (failedShortcuts = e.payload))
      .then((off) => {
        invoke<string[]>("shortcuts_status")
          .then((list) => (failedShortcuts = list ?? []))
          .catch(() => {});
        return off;
      })
      .catch(() => () => {});
    loadShortcutLabels();
    // Si se cambia un atajo, actualizar lo que muestran los botones.
    const unlistenChanged = listen("shortcuts-changed", loadShortcutLabels).catch(() => () => {});
    // Atajos de acciones que maneja la interfaz.
    const unlistenAction = listen<string>("shortcut-action", (e) => {
      if (e.payload === "tracking.toggle") toggleTracking();
      else if (e.payload === "lipsync.toggle") toggleLipsync();
    }).catch(() => () => {});
    invoke<string | null>("expression_current")
      .then((name) => (activeExpression = name))
      .catch((e) => console.error("expression_current:", e));
    const unlistenExpression = listen<string | null>("expression-changed", (e) => (activeExpression = e.payload))
      .catch((e) => {
        console.error("listen expression-changed:", e);
        return () => {};
      });
    invoke<boolean>("obs_status")
      .then((ok) => {
        obsActive = ok;
        syncPreview();
        return invoke<string | null>("avatar_current");
      })
      .then((name) => {
        if (name) avatarName = name;
      })
      .catch(() => (obsActive = false));
    loadRecentAvatars();
    const unlistenRecent = listen("recent-avatars-changed", loadRecentAvatars).catch(() => () => {});

    const observer = new ResizeObserver(syncPreview);
    observer.observe(canvas);
    window.addEventListener("resize", syncPreview);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncPreview);
      unlistenExpression.then((off) => off());
      unlistenShortcuts.then((off) => off());
      unlistenChanged.then((off) => off());
      unlistenRecent.then((off) => off());
      unlistenBgStatus.then((off) => off());
      unlistenAction.then((off) => off());
      unlistenStatus.then((off) => off());
    };
  });
</script>

<div class="app">
  <header class="topbar">
    <img src="/logo.png" alt="" class="logo" />
    <span class="brand">avat<span class="accent">-os</span></span>
    <label class="lang">
      <span class="sr-only">{t("app.language")}</span>
      <select
        value={i18n.locale}
        onchange={(e) => (i18n.locale = (e.currentTarget as HTMLSelectElement).value as Locale)}
        aria-label={t("app.language")}
      >
        {#each Object.entries(LOCALES) as [code, name]}
          <option value={code}>{name}</option>
        {/each}
      </select>
    </label>
    <span class="version">v{version}</span>
  </header>

  <main class="workspace">
    <section class="preview" aria-label={t("preview.label")}>
      <!-- data-native-overlay: aquí va la ventana nativa de OBS; los tooltips la evitan -->
      <div class="canvas" bind:this={canvas} data-native-overlay>
        {#if !obsActive}
          <p>{t("preview.unavailable")}</p>
          <small>{t("preview.engineDown")}</small>
        {/if}
      </div>
    </section>

    <aside class="side" aria-label={t("avatar.title")}>
      <h2>{t("avatar.title")}</h2>
      <button class="btn" onclick={chooseAvatar} disabled={!obsActive} use:tooltip={t("tooltips.loadAvatar")}>
        {t("avatar.load")}
      </button>
      <div class="field">
        <span>{t("avatar.current")}</span>
        <span class="avatar-value">
          {#if avatarName}
            {@const st = avatarStatus?.state ?? "loading"}
            {#if st !== "error"}
              <span class="pill" class:on-pill={st === "loaded"} use:tooltip={t("tooltips.avatarStatus")}>
                {st === "loaded" ? t("avatar.ready") : t("avatar.loading")}
              </span>
            {/if}
          {/if}
          <span class="name" title={avatarName ?? ""}>{avatarName ?? t("avatar.none")}</span>
        </span>
      </div>
      {#if avatarStatus?.state === "error"}
        <p class="error">{t("errors.avatar_load_failed", { detail: avatarStatus.detail })}</p>
      {/if}
      {#if avatarError}<p class="error">{tError(avatarError)}</p>{/if}
      <!-- Recientes: Rust marca el cargado (`current`) comparando la ruta completa. -->
      {#if recentAvatars.length}
        <details class="fx recent" use:rememberOpen={"recientes"}>
          <summary use:tooltip={t("tooltips.recentAvatars")}>{t("avatar.recent")}</summary>
          <ul>
            {#each recentAvatars as r (r.path)}
              {@const current = r.current}
              <li class:missing={!r.exists}>
                <button
                  class="recent-name"
                  title={r.path}
                  disabled={!r.exists || current || !obsActive}
                  onclick={() => loadAvatar(r.path)}
                >
                  {r.name}
                </button>
                {#if current}
                  <span class="recent-tag">{t("avatar.inUse")}</span>
                {:else if !r.exists}
                  <span class="recent-tag">{t("avatar.notFound")}</span>
                {/if}
                {#if !current}
                  <button class="link" onclick={() => forgetRecentAvatar(r.path)} use:tooltip={t("tooltips.recentRemove")}>
                    {t("avatar.forget")}
                  </button>
                {/if}
              </li>
            {/each}
          </ul>
        </details>
      {/if}
      <div class="field">
        <span>{t("tracking.label")}</span>
        <button
          class="pill toggle"
          class:on={trackingOn}
          onclick={toggleTracking}
          disabled={trackingBusy}
          use:tooltip={t("tooltips.tracking")}
        >
          {trackingBusy ? t("tracking.starting") : trackingOn ? t("tracking.on") : t("tracking.off")}
        </button>
      </div>
      {#if trackingOn}
        <div class="field sub">
          <span>{faceFound ? t("tracking.faceFound") : t("tracking.searching")}</span>
          <span>
            {t("tracking.fps", { fps: trackingFps.toFixed(0) })}
            <button type="button" class="info" aria-label={t("app.moreInfo")} use:tooltip={t("tooltips.fps")}>ⓘ</button>
          </span>
        </div>
        {#if lastFrame}
          <!-- Valores reales de MediaPipe (0 a 1), para calibrar -->
          <div class="field sub">
            <span>{t("tracking.mouth", { value: lastFrame.jawOpen.toFixed(2) })}</span>
            <span>
              {t("tracking.eyes", { left: lastFrame.blinkLeft.toFixed(2), right: lastFrame.blinkRight.toFixed(2) })}
              <button type="button" class="info" aria-label={t("app.moreInfo")} use:tooltip={t("tooltips.values")}>ⓘ</button>
            </span>
          </div>
        {/if}
      {/if}
      {#if trackingError}<p class="error">{cameraErrorText(trackingError)}</p>{/if}
      <!-- Las acciones van en su propia línea: con tres enlaces no caben junto al título. -->
      <div class="field cal">
        <span class="cal-title">
          {t("calibration.title")}
          <span class="pill" class:on-pill={calibrated}>
            {calibrated ? t("calibration.calibrated") : t("calibration.notCalibrated")}
          </span>
        </span>
        <span class="cal-actions">
          {#if savedCalibration?.levels}
            <button
              class="link"
              onclick={() => startCalibration(true)}
              disabled={calibrating || trackingBusy}
              use:tooltip={t("tooltips.calibrationAdjust")}
            >
              {t("calibration.adjust")}
            </button>
          {/if}
          {#if calibrated}
            <button class="link" onclick={resetCalibration} use:tooltip={t("tooltips.calibrationReset")}>
              {t("calibration.reset")}
            </button>
          {/if}
          <button
            class="link"
            onclick={() => startCalibration(false)}
            disabled={calibrating || trackingBusy}
            use:tooltip={t("tooltips.calibrate")}
          >
            {calibrated ? t("calibration.recalibrate") : t("calibration.button")}
          </button>
        </span>
      </div>
      {#if calibrating}
        <Calibration
          subscribe={subscribeFrames}
          initial={adjusting ? savedCalibration : null}
          onclose={() => {
            calibrating = false;
            refreshCalibration();
          }}
        />
      {/if}
      {#if calibrationError}<p class="error">{tError(calibrationError)}</p>{/if}
      <div class="field">
        <span>{t("lipsync.label")}</span>
        <button
          class="pill toggle"
          class:on={lipsyncOn}
          onclick={toggleLipsync}
          disabled={lipsyncBusy}
          use:tooltip={t("tooltips.lipsync")}
        >
          {lipsyncBusy ? t("lipsync.starting") : lipsyncOn ? t("lipsync.on") : t("lipsync.off")}
        </button>
      </div>
      {#if lipsyncOn}
        <div class="lipsync">
          <div class="ls-row">
            <!-- La letra de la vocal reconocida va junto a "Voz" (la barra es muy fina). -->
            <span>{t("lipsync.level")} <b class="ls-vowel" aria-hidden="true">{currentVowel}</b></span>
            <div
              class="ls-meter"
              role="meter"
              aria-label={t("lipsync.level")}
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={lipsyncLevel}
              tabindex="-1"
            >
              <div class="ls-fill" style="width: {lipsyncLevel * 100}%"></div>
            </div>
            <button type="button" class="info" aria-label={t("app.moreInfo")} use:tooltip={t("tooltips.lipsyncLevel")}>ⓘ</button>
          </div>
          <!-- Plegable: la barra de voz queda a la vista; las opciones, adentro. La calibración
               de vocales sigue montada aunque esté cerrado (aplica el perfil guardado). -->
          <details class="fx ls-opts" use:rememberOpen={"lipsync"}>
          <summary use:tooltip={t("tooltips.lipsyncOptions")}>{t("lipsync.options")}</summary>
          <label class="ls-row">
            <span>{t("lipsync.mic")}</span>
            <select value={micId} onchange={(e) => changeMic(e.currentTarget.value)} use:tooltip={t("tooltips.lipsyncMic")}>
              <option value="">{t("lipsync.micDefault")}</option>
              {#each micDevices as mic, i (mic.id)}
                <option value={mic.id}>{mic.label || t("lipsync.micN", { n: i + 1 })}</option>
              {/each}
            </select>
          </label>
          <label class="ls-row">
            <span>{t("lipsync.mode")}</span>
            <select bind:value={lipsyncMode} use:tooltip={t("tooltips.lipsyncMode")}>
              <option value="combine">{t("lipsync.modeCombine")}</option>
              <option value="voice">{t("lipsync.modeVoice")}</option>
            </select>
          </label>
          <label class="ls-row">
            <span>{t("lipsync.shape")}</span>
            <select bind:value={lipsyncVowels} use:tooltip={t("tooltips.lipsyncShape")}>
              <option value={true}>{t("lipsync.shapeVowels")}</option>
              <option value={false}>{t("lipsync.shapeOpen")}</option>
            </select>
          </label>
          {#if lipsyncVowels}<VowelCalibration {lipsync} />{/if}
          <label class="ls-row">
            <span>{t("lipsync.sensitivity")}</span>
            <span class="ls-range">
              <small>{t("lipsync.less")}</small>
              <input
                type="range"
                min="-1"
                max="1"
                step="0.1"
                bind:value={lipsyncSensitivity}
                use:tooltip={t("tooltips.lipsyncSensitivity")}
              />
              <small>{t("lipsync.more")}</small>
            </span>
          </label>
          </details>
        </div>
      {/if}
      {#if lipsyncError}<p class="error">{micErrorText(lipsyncError)}</p>{/if}
      <!-- Fuera del plegable: el aviso se ve aunque esté cerrado. -->
      {#if failedShortcuts.length}
        <div class="warn" role="status">
          <span>{t("shortcuts.unavailable", { list: failedShortcuts.join(", ") })}</span>
          <button class="link" onclick={retryShortcuts} use:tooltip={t("tooltips.shortcutsRetry")}>{t("shortcuts.retry")}</button>
        </div>
      {/if}
      <!-- Plegable, como Atajos y Efectos; la expresión activa se ve en el título. -->
      <details class="expressions" use:rememberOpen={"expresiones"}>
        <summary use:tooltip={t("tooltips.expressionsSection")}>
          {t("expression.section")}
          {#if activeExpression}
            <span class="summary-value">{EXPRESSION_KEYS[activeExpression] ? t(EXPRESSION_KEYS[activeExpression]) : activeExpression}</span>
          {/if}
        </summary>
        <span class="label">{t("expression.label")}</span>
        <div class="expr-grid">
          <button
            class="expr"
            class:active={activeExpression === null}
            onclick={() => setExpression(null)}
            use:tooltip={t("tooltips.neutral")}
          >
            {t("expression.neutral")}
          </button>
          {#each expressions as expr}
            <button
              class="expr"
              class:active={activeExpression === expr.name}
              onclick={() => setExpression(expr.name)}
              aria-keyshortcuts={expr.shortcut?.replaceAll("Ctrl", "Control")}
              use:tooltip={t("tooltips.expression", { shortcut: expr.shortcut ?? t("shortcutsEditor.none") })}
            >
              {EXPRESSION_KEYS[expr.name] ? t(EXPRESSION_KEYS[expr.name]) : expr.name}
              {#if expr.shortcut}<kbd>{expr.shortcut.replace("Ctrl+Shift+", "⌃⇧")}</kbd>{/if}
            </button>
          {/each}
        </div>
        <span class="label gestures-label">{t("gesture.label")}</span>
        <div class="expr-grid">
          {#each gestures as g (g.name)}
            <button
              class="expr"
              onclick={() => playGesture(g.name)}
              aria-keyshortcuts={g.shortcut?.replaceAll("Ctrl", "Control")}
              use:tooltip={t("tooltips.gesture", { shortcut: g.shortcut ?? t("shortcutsEditor.none") })}
            >
              {GESTURE_KEYS[g.name] ? t(GESTURE_KEYS[g.name]) : g.name}
              {#if g.shortcut}<kbd>{g.shortcut.replace("Ctrl+Shift+", "⌃⇧")}</kbd>{/if}
            </button>
          {/each}
        </div>
        {#if gestureError}<p class="error">{tError(gestureError)}</p>{/if}
      </details>
      <ShortcutEditor />
      <div class="field">
        <span>{t("background.label")}</span>
        <select
          class="bg-select"
          value={background.kind}
          onchange={(e) => setBackgroundKind(e.currentTarget)}
          use:tooltip={t("tooltips.background")}
        >
          <option value="transparent">{t("background.transparent")}</option>
          <option value="color">{t("background.color")}</option>
          <option value="image">{t("background.image")}</option>
        </select>
      </div>
      {#if background.kind === "color"}
        <label class="ls-row bg-row">
          <span>{t("background.color")}</span>
          <input
            type="color"
            value={background.color}
            onchange={(e) => saveBackground({ ...background, color: e.currentTarget.value })}
            use:tooltip={t("tooltips.backgroundColor")}
          />
        </label>
      {:else if background.kind === "image"}
        <div class="ls-row bg-row">
          <span>{t("background.image")}</span>
          <span class="bg-file" title={background.image ?? ""}>{backgroundName ?? t("background.noImage")}</span>
          <button class="link" onclick={chooseBackgroundImage} use:tooltip={t("tooltips.backgroundImage")}>
            {t("background.changeImage")}
          </button>
        </div>
        <label class="ls-row bg-row">
          <span>{t("background.fit")}</span>
          <select
            value={background.fit}
            onchange={(e) => saveBackground({ ...background, fit: e.currentTarget.value as BackgroundValue["fit"] })}
            use:tooltip={t("tooltips.backgroundFit")}
          >
            <option value="cover">{t("background.cover")}</option>
            <option value="contain">{t("background.contain")}</option>
          </select>
        </label>
      {/if}
      {#if backgroundError}<p class="error">{tError(backgroundError)}</p>{/if}
      <!-- Plegable: el panel ya es largo; cerrado por defecto. -->
      <details class="fx" use:rememberOpen={"efectos"}>
        <summary use:tooltip={t("tooltips.effects")}>{t("effects.title")}</summary>
        <div class="fx-body">
          <span class="fx-group">{t("effects.camera")}</span>
          <label class="ls-row">
            <span>{t("effects.shot")}</span>
            <select
              value={effects.shot}
              onchange={(e) => setEffect("shot", e.currentTarget.value as EffectsValue["shot"])}
              use:tooltip={t("tooltips.effectsShot")}
            >
              <option value="close">{t("effects.close")}</option>
              <option value="medium">{t("effects.medium")}</option>
              <option value="full">{t("effects.full")}</option>
            </select>
          </label>
          <label class="ls-row">
            <span>{t("effects.zoom")}</span>
            <input
              type="range" min="0.5" max="2" step="0.05"
              value={effects.zoom}
              oninput={(e) => setEffect("zoom", Number(e.currentTarget.value))}
              use:tooltip={t("tooltips.effectsZoom")}
            />
          </label>
          <label class="ls-row">
            <span>{t("effects.height")}</span>
            <input
              type="range" min="-0.5" max="0.5" step="0.02"
              value={effects.height}
              oninput={(e) => setEffect("height", Number(e.currentTarget.value))}
              use:tooltip={t("tooltips.effectsHeight")}
            />
          </label>
          <label class="ls-row">
            <span>{t("effects.angle")}</span>
            <input
              type="range" min="-60" max="60" step="1"
              value={effects.angle}
              oninput={(e) => setEffect("angle", Number(e.currentTarget.value))}
              use:tooltip={t("tooltips.effectsAngle")}
            />
          </label>
          <span class="fx-group">{t("effects.light")}</span>
          <label class="ls-row">
            <span>{t("effects.lightIntensity")}</span>
            <input
              type="range" min="0" max="2" step="0.05"
              value={effects.lightIntensity}
              oninput={(e) => setEffect("lightIntensity", Number(e.currentTarget.value))}
              use:tooltip={t("tooltips.effectsLightIntensity")}
            />
          </label>
          <label class="ls-row bg-row">
            <span>{t("effects.lightColor")}</span>
            <input
              type="color"
              value={effects.lightColor}
              onchange={(e) => setEffect("lightColor", e.currentTarget.value)}
              use:tooltip={t("tooltips.effectsLightColor")}
            />
          </label>
          <label class="ls-row">
            <span>{t("effects.lightAngle")}</span>
            <input
              type="range" min="-90" max="90" step="5"
              value={effects.lightAngle}
              oninput={(e) => setEffect("lightAngle", Number(e.currentTarget.value))}
              use:tooltip={t("tooltips.effectsLightAngle")}
            />
          </label>
          <label class="ls-row">
            <span>{t("effects.ambient")}</span>
            <input
              type="range" min="0" max="1.5" step="0.05"
              value={effects.ambient}
              oninput={(e) => setEffect("ambient", Number(e.currentTarget.value))}
              use:tooltip={t("tooltips.effectsAmbient")}
            />
          </label>
          <label class="ls-row">
            <span>{t("effects.outline")}</span>
            <input
              type="range" min="0" max="4" step="0.1"
              value={effects.outline}
              oninput={(e) => setEffect("outline", Number(e.currentTarget.value))}
              use:tooltip={t("tooltips.effectsOutline")}
            />
          </label>
          <button class="link fx-reset" onclick={() => saveEffects({ ...DEFAULT_EFFECTS })} use:tooltip={t("tooltips.effectsReset")}>
            {t("effects.reset")}
          </button>
          {#if effectsError}<p class="error">{tError(effectsError)}</p>{/if}
        </div>
      </details>
    </aside>
  </main>

  <footer class="docks">
    <section class="dock">
      <h2>{t("scenes.title")} <button type="button" class="info" aria-label={t("app.moreInfo")} use:tooltip={t("tooltips.comingSoon")}>ⓘ</button></h2>
      <ul>
        {#each scenes as scene, i}
          <li>
            <button class="row" class:active={i === activeScene} onclick={() => (activeScene = i)}>
              {t(scene)}
            </button>
          </li>
        {/each}
      </ul>
    </section>

    <section class="dock">
      <h2>{t("sources.title")} <button type="button" class="info" aria-label={t("app.moreInfo")} use:tooltip={t("tooltips.comingSoon")}>ⓘ</button></h2>
      <ul>
        {#each sources as source}
          <li class="row static">
            <span>{t(source.name)}</span>
            <button class="icon" onclick={() => (source.visible = !source.visible)} aria-label={t("sources.toggleVisible")}>
              {source.visible ? "👁" : "—"}
            </button>
          </li>
        {/each}
      </ul>
    </section>

    <section class="dock wide">
      <h2>{t("mixer.title")} <button type="button" class="info" aria-label={t("app.moreInfo")} use:tooltip={t("tooltips.comingSoon")}>ⓘ</button></h2>
      {#each mixer as ch}
        <div class="channel">
          <span class="ch-name">{t(ch.name)}</span>
          <div class="meter"><div class="meter-fill" style="width: {ch.muted ? 0 : ch.level * 100}%"></div></div>
          <button class="icon" onclick={() => (ch.muted = !ch.muted)} aria-label={t("mixer.mute")}>
            {ch.muted ? "🔇" : "🔊"}
          </button>
        </div>
      {/each}
    </section>

    <section class="dock controls">
      <h2>{t("controls.title")} <button type="button" class="info" aria-label={t("app.moreInfo")} use:tooltip={t("tooltips.comingSoon")}>ⓘ</button></h2>
      <button class="btn rec" class:on={recording} onclick={() => (recording = !recording)}>
        {recording ? t("controls.stopRecording") : t("controls.startRecording")}
      </button>
      <button class="btn ghost">{t("controls.settings")}</button>
    </section>
  </footer>
</div>

<style>
  :root {
    --bg: #0e0d16;
    --panel: #171528;
    --panel-2: #1f1c36;
    --border: #2d2950;
    --text: #ece9ff;
    --muted: #9a94c4;
    --orange: #ff8a2a;
    --purple: #a24dff;
    --danger: #ff4d6d;
    font-family: "Segoe UI", Inter, system-ui, sans-serif;
    font-size: 14px;
    color: var(--text);
    background: var(--bg);
  }
  :global(body) {
    margin: 0;
    background: var(--bg);
    overflow: hidden;
  }
  .app {
    display: grid;
    grid-template-rows: 44px 1fr 220px;
    height: 100vh;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  .logo { width: 28px; height: 28px; border-radius: 50%; }
  .brand { font-weight: 700; font-size: 16px; letter-spacing: 0.3px; }
  .accent { color: var(--orange); }
  .version { color: var(--muted); font-size: 12px; }
  .lang { margin-left: auto; }
  .lang select {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 3px 6px; font: inherit; font-size: 12px; cursor: pointer;
  }
  .info {
    border: 0; background: transparent; padding: 0 2px; margin-left: 2px;
    color: var(--muted); cursor: help; font: inherit; font-size: 12px; line-height: 1; border-radius: 50%;
  }
  .info:hover, .info:focus-visible { color: var(--orange); outline: none; }
  :global(.avatos-tooltip) {
    position: fixed; z-index: 1000; box-sizing: border-box; max-width: 260px; padding: 7px 10px;
    background: #26224a; color: var(--text); border: 1px solid var(--purple); border-radius: 6px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45); font-size: 12px; line-height: 1.4;
    text-transform: none; letter-spacing: normal; font-weight: 400; pointer-events: none;
  }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  .workspace {
    display: grid;
    grid-template-columns: 1fr 260px;
    min-height: 0;
  }
  .preview {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    min-height: 0;
  }
  .canvas {
    aspect-ratio: 16 / 9;
    max-height: 100%;
    max-width: 100%;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: #000;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--muted);
  }
  .canvas p { margin: 0 0 4px; font-size: 16px; }

  .side, .dock {
    background: var(--panel);
    border-left: 1px solid var(--border);
    padding: 12px;
    overflow: auto;
  }
  h2 {
    margin: 0 0 10px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--purple);
  }
  .field {
    display: flex;
    justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .pill { font-size: 12px; padding: 1px 8px; border-radius: 99px; background: var(--panel-2); color: var(--muted); }
  .pill.toggle { border: 1px solid var(--border); font: inherit; font-size: 12px; cursor: pointer; }
  .pill.toggle.on { background: linear-gradient(90deg, var(--orange), var(--purple)); color: #fff; border-color: transparent; }
  .field.sub { font-size: 12px; color: var(--muted); padding-top: 4px; }
  .pill.on-pill { color: var(--orange); }
  .field.cal { flex-wrap: wrap; row-gap: 4px; }
  .cal-title { white-space: nowrap; }
  .cal-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px 12px; margin-left: auto; }
  .link {
    border: 0; background: transparent; padding: 0; color: var(--purple);
    font: inherit; font-size: 12px; cursor: pointer; text-decoration: underline;
  }
  .link:hover { color: var(--orange); }
  .link:disabled { color: var(--muted); cursor: not-allowed; text-decoration: none; }
  .lipsync { padding: 6px 0 8px; border-bottom: 1px solid var(--border); font-size: 12px; }
  .ls-row { display: grid; grid-template-columns: 74px 1fr auto; align-items: center; gap: 6px; margin: 5px 0; color: var(--muted); }
  label.ls-row { grid-template-columns: 74px 1fr; }
  .ls-meter { height: 8px; border-radius: 4px; background: var(--bg); overflow: hidden; }
  .ls-vowel { display: inline-block; min-width: 1ch; color: var(--orange); }
  .ls-fill { height: 100%; background: linear-gradient(90deg, var(--orange), var(--purple)); transition: width 0.05s linear; }
  .ls-row select {
    min-width: 0; background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 2px 4px; font: inherit; font-size: 12px;
  }
  .ls-range { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 4px; }
  .ls-range small { font-size: 10px; }
  .ls-range input { width: 100%; accent-color: var(--orange); min-width: 0; }
  .bg-select {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 2px 4px; font: inherit; font-size: 12px;
  }
  .bg-row { font-size: 12px; }
  .bg-row input[type="color"] { width: 100%; height: 22px; padding: 0; border: 1px solid var(--border); border-radius: 4px; background: none; cursor: pointer; }
  .bg-file { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
  .fx { padding: 8px 0; border-bottom: 1px solid var(--border); }
  .ls-opts { padding: 4px 0 0; border-bottom: 0; }
  .ls-opts summary { font-size: 12px; color: var(--muted); }
  .recent ul { list-style: none; margin: 6px 0 0; padding: 0; font-size: 12px; }
  .recent li { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 8px; padding: 2px 0; }
  .recent-name {
    border: 0; background: transparent; padding: 2px 0; text-align: left; font: inherit; font-size: 12px;
    color: var(--text); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .recent-name:hover:not(:disabled) { color: var(--orange); text-decoration: underline; }
  .recent-name:disabled { cursor: default; }
  .recent li.missing .recent-name { color: var(--muted); text-decoration: line-through; }
  .recent-tag { color: var(--muted); font-size: 11px; }
  .fx summary { cursor: pointer; user-select: none; }
  .fx summary:hover { color: var(--orange); }
  .fx-body { padding-top: 4px; font-size: 12px; }
  .fx-group { display: block; margin: 8px 0 2px; color: var(--purple); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .fx-body label.ls-row input[type="range"] { width: 100%; accent-color: var(--orange); min-width: 0; }
  .fx-reset { display: block; margin: 8px 0 0 auto; }
  .expressions { padding: 8px 0; border-bottom: 1px solid var(--border); }
  .expressions summary { cursor: pointer; user-select: none; margin-bottom: 4px; }
  .expressions summary:hover { color: var(--orange); }
  .expressions:not([open]) summary { margin-bottom: 0; }
  .summary-value { float: right; color: var(--orange); font-size: 12px; }
  .expressions .label { display: block; margin: 6px 0; font-size: 12px; color: var(--muted); }
  .warn {
    margin: 8px 0; padding: 6px 8px; border: 1px solid #b45309; border-radius: 6px;
    background: rgba(251, 191, 36, 0.12); color: #fcd34d; font-size: 11px; line-height: 1.4;
  }
  .warn .link { display: block; margin-top: 4px; color: #fcd34d; }
  .expressions .gestures-label { margin-top: 10px; }
  .expr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
  .expr {
    display: flex; justify-content: space-between; align-items: center;
    padding: 5px 6px; border: 1px solid var(--border); border-radius: 6px;
    background: var(--panel-2); color: var(--text); font: inherit; font-size: 12px; cursor: pointer;
  }
  .expr:hover { border-color: var(--purple); }
  .expr.active { background: linear-gradient(90deg, rgba(255, 138, 42, 0.35), rgba(162, 77, 255, 0.35)); border-color: var(--orange); }
  .expr kbd { font-family: inherit; font-size: 10px; color: var(--muted); }

  .docks {
    display: grid;
    grid-template-columns: 1fr 1fr 1.6fr 220px;
    border-top: 1px solid var(--border);
    min-height: 0;
  }
  ul { list-style: none; margin: 0; padding: 0; }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    margin-bottom: 2px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row:hover, .row.static:hover { background: var(--panel-2); }
  .row.static { cursor: default; }
  .row.active { background: linear-gradient(90deg, rgba(255, 138, 42, 0.25), rgba(162, 77, 255, 0.2)); }

  .channel { display: grid; grid-template-columns: 90px 1fr 32px; align-items: center; gap: 8px; margin-bottom: 12px; }
  .ch-name { color: var(--muted); }
  .meter { height: 8px; background: var(--panel-2); border-radius: 4px; overflow: hidden; }
  .meter-fill { height: 100%; background: linear-gradient(90deg, var(--orange), var(--purple)); transition: width 0.2s; }

  .btn {
    display: block;
    width: 100%;
    padding: 9px 12px;
    margin-bottom: 8px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: linear-gradient(90deg, var(--orange), var(--purple));
    color: #fff;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .avatar-value { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .name { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .error { color: var(--danger); font-size: 12px; margin: 6px 0; }
  .btn.ghost { background: transparent; border-color: var(--border); color: var(--text); }
  .btn.rec.on { background: var(--danger); }
  .icon { border: 0; background: transparent; color: var(--text); cursor: pointer; font-size: 14px; }
</style>
