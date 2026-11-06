<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { open } from "@tauri-apps/plugin-dialog";
  import { FaceTracker, type TrackingFrame } from "$lib/tracking";
  import { i18n, LOCALES, t, tError, type Locale, type MessageKey } from "$lib/i18n/index.svelte";
  import { tooltip } from "$lib/tooltip";
  import Calibration, { type CalibrationValues } from "$lib/Calibration.svelte";
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
  let expressions = $state<{ name: string; shortcut: string }[]>([]);
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

  async function loadAvatar() {
    const defaultPath = (await invoke<string | null>("resources_dir", { kind: "avatares" }).catch(() => null)) ?? undefined;
    const path = await open({
      title: t("avatar.dialogTitle"),
      defaultPath,
      multiple: false,
      directory: false,
      filters: [{ name: t("avatar.dialogFilter"), extensions: ["vrm"] }],
    });
    if (typeof path !== "string") return;
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
    invoke<typeof avatarStatus>("avatar_status")
      .then((st) => st && (avatarStatus = st))
      .catch(() => {});
    const unlistenStatus = listen<NonNullable<typeof avatarStatus>>("avatar-status", (e) => (avatarStatus = e.payload))
      .catch(() => () => {});
    invoke<{ name: string; shortcut: string }[]>("expression_list")
      .then((list) => (expressions = list))
      .catch((e) => console.error("expression_list:", e));
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

    const observer = new ResizeObserver(syncPreview);
    observer.observe(canvas);
    window.addEventListener("resize", syncPreview);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncPreview);
      unlistenExpression.then((off) => off());
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
      <button class="btn" onclick={loadAvatar} disabled={!obsActive} use:tooltip={t("tooltips.loadAvatar")}>
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
      <div class="field">
        <span>
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
        <span>{t("lipsync.label")} <button type="button" class="info" aria-label={t("app.moreInfo")} use:tooltip={t("tooltips.lipsync")}>ⓘ</button></span>
        <span class="pill off">{t("lipsync.off")}</span>
      </div>
      <div class="expressions">
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
              aria-keyshortcuts={expr.shortcut.replaceAll("Ctrl", "Control")}
              use:tooltip={t("tooltips.expression", { shortcut: expr.shortcut })}
            >
              {EXPRESSION_KEYS[expr.name] ? t(EXPRESSION_KEYS[expr.name]) : expr.name}
              <kbd>{expr.shortcut.replace("Ctrl+Shift+", "⌃⇧")}</kbd>
            </button>
          {/each}
        </div>
      </div>
      <div class="field">
        <span>{t("background.label")} <button type="button" class="info" aria-label={t("app.moreInfo")} use:tooltip={t("tooltips.background")}>ⓘ</button></span>
        <span>{t("background.transparent")}</span>
      </div>
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
  .cal-actions { display: flex; gap: 8px; }
  .link {
    border: 0; background: transparent; padding: 0; color: var(--purple);
    font: inherit; font-size: 12px; cursor: pointer; text-decoration: underline;
  }
  .link:hover { color: var(--orange); }
  .link:disabled { color: var(--muted); cursor: not-allowed; text-decoration: none; }
  .expressions { padding: 8px 0; border-bottom: 1px solid var(--border); }
  .expressions .label { display: block; margin-bottom: 6px; }
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
