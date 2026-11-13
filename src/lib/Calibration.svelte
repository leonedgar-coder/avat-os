<!--
  avat-os — Copyright (C) 2026 avat-os contributors
  SPDX-License-Identifier: GPL-3.0-or-later

  Asistente de calibración del tracking facial.
    1. de frente, ojos abiertos, boca cerrada → postura y nivel de reposo
    2. ojos cerrados (guiado por pitidos, porque no se puede leer) → nivel de ojo cerrado
    3. boca muy abierta → nivel de boca abierta
    4. prueba y ajuste: medidores en vivo + deslizadores de sensibilidad, con vista
       previa en el avatar (sin guardar hasta pulsar Guardar)
  Con `initial` (una calibración guardada que tenga sus medidas) empieza directo en el
  paso 4 ("Ajustar"). Va dentro del panel lateral: una ventana emergente quedaría tapada
  por la vista previa (ventana nativa de OBS encima de la web).
-->
<script lang="ts" module>
  /** Medidas de MediaPipe en cada paso (0–1). */
  export interface Levels {
    /** Ojo izquierdo (o los dos, en calibraciones antiguas sin `eyeRight`). */
    eyeOpen: number;
    eyeClosed: number;
    jawRest: number;
    jawMax: number;
    /** Ojo derecho [abierto, cerrado]. */
    eyeRight?: [number, number] | null;
    /** Temblor del valor de cada ojo abierto [izq., der.] (paso 1). */
    eyeNoise?: [number, number] | null;
  }
  /** Lo que se guarda (calibration.rs). */
  export interface CalibrationValues {
    eyeOpen: number;
    eyeClosed: number;
    /** Umbrales del ojo derecho [abierto, cerrado] (sin esto, los mismos que el izquierdo). */
    eyeRight?: [number, number] | null;
    mouthClosed: number;
    mouthOpen: number;
    headOffset: [number, number, number];
    restPos: [number, number, number];
    gazeOffset?: [number, number];
    levels?: Levels | null;
    eyeSensitivity?: number;
    mouthSensitivity?: number;
  }
</script>

<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { onDestroy, untrack } from "svelte";
  import { t, tError, type MessageKey } from "$lib/i18n/index.svelte";
  import { tooltip } from "$lib/tooltip";
  import type { TrackingFrame } from "$lib/tracking";

  interface Props {
    /** Se suscribe a los cuadros del tracking; devuelve la función para desuscribirse. */
    subscribe: (fn: (frame: TrackingFrame) => void) => () => void;
    /** Se llama al terminar (guardado o cancelado). */
    onclose: () => void;
    /** Calibración guardada: si tiene medidas, se abre directo en "Prueba y ajuste". */
    initial?: CalibrationValues | null;
  }
  let { subscribe, onclose, initial = null }: Props = $props();
  // El asistente parte de la calibración recibida al abrirse y luego trabaja con su
  // propia copia (no debe reiniciarse si el panel cambia la suya mientras tanto).
  const opened = untrack(() => initial);
  const listen = untrack(() => subscribe);

  type Step = "intro" | "neutral" | "eyes" | "mouth" | "adjust";
  const STEP_TEXT: Record<Exclude<Step, "adjust">, MessageKey> = {
    intro: "calibration.intro",
    neutral: "calibration.neutral",
    eyes: "calibration.eyes",
    mouth: "calibration.mouth",
  };
  const COUNTDOWN_S = 3;
  const REACTION_MS = 400; // se descartan: es lo que tarda una persona en reaccionar
  const CAPTURE_MS = 1500; // lo que se mide después de la reacción
  const MIN_RANGE = 0.08; // boca: diferencia mínima entre cerrada y abierta para aceptar la medición
  /**
   * Ojos: la diferencia entre abiertos y cerrados (promedio de los dos) tiene que ser al menos
   * NOISE_FACTOR veces lo que tiembla el valor con los ojos abiertos, y nunca menos de
   * MIN_EYE_DIFF. Antes era un 0,08 fijo: a personas cuyo "parpadeo" de MediaPipe cambia poco
   * (p. ej. 0,18 → 0,27) les fallaba aunque cerraran bien los ojos, y con una señal limpia
   * una diferencia chica sí se distingue.
   */
  const NOISE_FACTOR = 4;
  const MIN_EYE_DIFF = 0.03;
  /** Por ojo: menos que esto (o que el ruido de ese ojo × NOISE_FACTOR) → usa el promedio. */
  const MIN_EYE_RANGE = 0.02;
  /** Desde aquí hacia abajo la señal de los ojos es pequeña: se guarda, pero con un aviso. */
  const SMALL_EYE_SIGNAL = 0.06;
  /** Suelo del temblor medido (la señal de MediaPipe tiene esta resolución en la práctica). */
  const NOISE_FLOOR = 0.002;
  const FACE_TIMEOUT_MS = 500;

  let step = $state<Step>(opened?.levels ? "adjust" : "intro");
  /**
   * Cada paso espera a que la persona pulse "Empezar el paso N": así tiene tiempo de leer
   * la instrucción (antes los 3 pasos seguían solos y no se alcanzaba a leer).
   */
  let waiting = $state(false);
  let go: (() => void) | null = null;
  function waitForGo(): Promise<void> {
    waiting = true;
    return new Promise((resolve) => {
      go = () => {
        waiting = false;
        go = null;
        resolve();
      };
    });
  }
  let countdown = $state(0);
  let capturing = $state(false);
  let error = $state<unknown>(null);
  let saving = $state(false);

  // Resultado: medidas + postura (del asistente o de la calibración guardada).
  let levels = $state<Levels | null>(opened?.levels ?? null);
  /**
   * La señal de los ojos es pequeña (aviso en "Prueba y ajuste"): se calcula de las medidas,
   * así también aparece al abrir directo en el ajuste con una calibración guardada.
   */
  const smallEyeSignal = $derived.by(() => {
    if (!levels) return false;
    const right = levels.eyeRight ?? [levels.eyeOpen, levels.eyeClosed];
    return (levels.eyeClosed - levels.eyeOpen + right[1] - right[0]) / 2 < SMALL_EYE_SIGNAL;
  });
  let headOffset = $state<[number, number, number]>(opened?.headOffset ?? [0, 0, 0]);
  let restPos = $state<[number, number, number]>(opened?.restPos ?? [0, 0, -50]);
  let gazeOffset = $state<[number, number]>(opened?.gazeOffset ?? [0, 0]);
  let eyeSensitivity = $state(opened?.eyeSensitivity ?? 0);

  let mouthSensitivity = $state(opened?.mouthSensitivity ?? 0);

  // --- Lectura en vivo (para los medidores y el indicador "te veo") ---------
  let live = $state<TrackingFrame | null>(null);
  let lastFrameAt = 0;
  let now = $state(performance.now());
  const stopLive = listen((f) => {
    live = f;
    lastFrameAt = performance.now();
  });
  const ticker = setInterval(() => (now = performance.now()), 100);
  const faceVisible = $derived(live !== null && now - lastFrameAt < FACE_TIMEOUT_MS);
  const liveEyeL = $derived(live?.blinkLeft ?? 0);
  const liveEyeR = $derived(live?.blinkRight ?? 0);
  const liveJaw = $derived(live?.jawOpen ?? 0);

  // --- Cálculo de umbrales ---------------------------------------------------
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  /**
   * Umbrales a partir de las medidas y la sensibilidad (−1 a 1).
   * Ojos: empieza a cerrarse al 25 % del camino y se cierra del todo al 85 % (más
   * sensibilidad = antes). Boca: abierta del todo al 60 % de tu máximo (al hablar casi
   * nunca se abre del todo; más sensibilidad = con menos apertura).
   */
  /**
   * Margen mínimo (en valores de MediaPipe) entre el ojo abierto medido y donde empieza a
   * cerrarse, y entre ese punto y el cierre total. Con un rango de ojos estrecho, el 25 %
   * quedaba a 0,02 del ojo abierto y el ruido de la cámara lo cruzaba (parpadeos falsos).
   */
  const EYE_MARGIN = 0.03;
  function eyeThresholds(open: number, closed: number, eyeSens: number, noise = 0): [number, number] {
    const range = closed - open;
    // Margen: lo que tiembla el ojo abierto (×3) o EYE_MARGIN, lo mayor; pero nunca más del
    // 40 % del rango: con un rango estrecho, el "cerrado del todo" quedaría más allá de lo que
    // ese ojo llega y el avatar no lo cerraría nunca.
    const margin = Math.min(Math.max(EYE_MARGIN, 3 * noise), 0.4 * range);
    const start = Math.max(open + (0.25 - 0.1 * eyeSens) * range, open + margin);
    const end = Math.max(open + (0.85 - 0.25 * eyeSens) * range, start + margin);
    return [clamp01(start), clamp01(end)];
  }
  function thresholds(l: Levels, eyeSens: number, mouthSens: number) {
    const [noiseL, noiseR] = l.eyeNoise ?? [0, 0];
    const [eyeOpen, eyeClosed] = eyeThresholds(l.eyeOpen, l.eyeClosed, eyeSens, noiseL);
    const jawRange = l.jawMax - l.jawRest;
    return {
      eyeOpen,
      eyeClosed,
      // Cada ojo con sus umbrales: la cámara suele ver uno más cerrado que el otro.
      eyeRight: l.eyeRight ? eyeThresholds(l.eyeRight[0], l.eyeRight[1], eyeSens, noiseR) : null,
      mouthClosed: clamp01(l.jawRest + 0.02),
      mouthOpen: clamp01(l.jawRest + (0.6 - 0.25 * mouthSens) * jawRange),
    };
  }
  const values = $derived<CalibrationValues | null>(
    levels && {
      ...thresholds(levels, eyeSensitivity, mouthSensitivity),
      headOffset,
      restPos,
      gazeOffset,
      levels,
      eyeSensitivity,
      mouthSensitivity,
    },
  );

  // Vista previa en el avatar mientras se ajusta (sin guardar).
  let previewing = false;
  $effect(() => {
    if (step !== "adjust" || !values) return;
    previewing = true;
    invoke("calibration_preview", { values: $state.snapshot(values) }).catch((e) => (error = e));
  });

  onDestroy(() => {
    stopLive();
    clearInterval(ticker);
    if (previewing) invoke("calibration_preview_end").catch(() => {});
  });

  // --- Asistente -------------------------------------------------------------
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Pitido corto (guía para el paso de ojos cerrados). */
  function beep(freq = 880) {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
      osc.onended = () => ctx.close();
    } catch {
      /* sin audio: el paso sigue funcionando con la cuenta atrás */
    }
  }

  /** Cuenta atrás + captura. Descarta los primeros REACTION_MS (tiempo de reacción). */
  async function capture(withBeeps: boolean): Promise<TrackingFrame[]> {
    for (countdown = COUNTDOWN_S; countdown > 0; countdown--) await sleep(1000);
    const frames: { at: number; f: TrackingFrame }[] = [];
    const start = performance.now();
    const unsubscribe = listen((f) => frames.push({ at: performance.now() - start, f }));
    capturing = true;
    if (withBeeps) beep(880);
    await sleep(REACTION_MS + CAPTURE_MS);
    unsubscribe();
    capturing = false;
    if (withBeeps) beep(660);
    return frames.filter((x) => x.at >= REACTION_MS).map((x) => x.f);
  }

  const percentile = (v: number[], p: number) => {
    const s = [...v].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN;
  };
  const median = (v: number[]) => percentile(v, 0.5);
  /** Desvío robusto (mediana de las desviaciones × 1,4826): un pestañeo suelto no lo infla. */
  const robustSigma = (v: number[]) => {
    const m = median(v);
    return Math.max(NOISE_FLOOR, 1.4826 * median(v.map((x) => Math.abs(x - m))));
  };
  const n2 = (v: number) => v.toFixed(2);
  /** Error del paso de los ojos con lo medido: el texto se arma al mostrarlo (idioma actual). */
  interface EyesError {
    code: "calibration_eyes";
    numbers: Record<string, string>;
  }
  function errorText(e: unknown): string {
    const ee = e as Partial<EyesError> | null;
    if (ee && typeof ee === "object" && ee.code === "calibration_eyes" && ee.numbers) {
      return t("errors.calibration_eyes", { detail: t("calibration.eyesNumbers", ee.numbers) });
    }
    return tError(e);
  }
  const n3 = (v: number) => v.toFixed(3);

  async function run() {
    error = null;
    if (step === "adjust") invoke("calibration_preview_end").catch(() => {}); // repetir: sin vista previa
    try {
      step = "neutral";
      await waitForGo();
      const neutral = await capture(false);
      step = "eyes";
      await waitForGo();
      const eyes = await capture(true);
      step = "mouth";
      await waitForGo();
      const mouth = await capture(false);
      if (neutral.length < 5 || eyes.length < 5 || mouth.length < 5) throw "calibration_no_face";

      // Cada ojo por separado. Abierto: un valor alto pero no el máximo (un pestañeo
      // suelto no lo arruina).
      const eyeOpenL = percentile(neutral.map((f) => f.blinkLeft), 0.9);
      const eyeOpenR = percentile(neutral.map((f) => f.blinkRight), 0.9);
      const eyeClosedL = median(eyes.map((f) => f.blinkLeft));
      const eyeClosedR = median(eyes.map((f) => f.blinkRight));
      // Cuánto tiembla cada ojo abierto (paso 1).
      const noiseL = robustSigma(neutral.map((f) => f.blinkLeft));
      const noiseR = robustSigma(neutral.map((f) => f.blinkRight));
      // El paso vale si el promedio de los dos ojos cambia claramente más que su temblor.
      const avgOpen = (eyeOpenL + eyeOpenR) / 2;
      const avgClosed = (eyeClosedL + eyeClosedR) / 2;
      const avgNoise = (noiseL + noiseR) / 2;
      const needed = Math.max(MIN_EYE_DIFF, NOISE_FACTOR * avgNoise);
      const diff = avgClosed - avgOpen;
      if (diff < needed) {
        // Con los números: así se sabe qué midió (y se puede ajustar sin adivinar).
        throw {
          code: "calibration_eyes",
          numbers: {
            lo: n2(eyeOpenL), lc: n2(eyeClosedL), ld: n2(eyeClosedL - eyeOpenL),
            ro: n2(eyeOpenR), rc: n2(eyeClosedR), rd: n2(eyeClosedR - eyeOpenR),
            diff: n3(diff), needed: n3(needed), noise: n3(avgNoise),
          },
        } satisfies EyesError;
      }
      // Un ojo con muy poco cambio propio (frente a su temblor) usa el promedio de los dos.
      const own = (open: number, closed: number, noise: number): [number, number] =>
        closed - open >= Math.max(MIN_EYE_RANGE, NOISE_FACTOR * noise) ? [open, closed] : [avgOpen, avgClosed];
      const [openL, closedL] = own(eyeOpenL, eyeClosedL, noiseL);
      const measured: Levels = {
        eyeOpen: openL,
        eyeClosed: closedL,
        eyeRight: own(eyeOpenR, eyeClosedR, noiseR),
        eyeNoise: [noiseL, noiseR],
        jawRest: percentile(neutral.map((f) => f.jawOpen), 0.9),
        jawMax: percentile(mouth.map((f) => f.jawOpen), 0.95),
      };
      if (measured.jawMax - measured.jawRest < MIN_RANGE) throw "calibration_mouth";

      levels = measured;
      headOffset = [0, 1, 2].map((i) => median(neutral.map((f) => f.head[i]))) as [number, number, number];
      restPos = [0, 1, 2].map((i) => median(neutral.map((f) => f.headPos[i]))) as [number, number, number];
      // Mirada al mirar la pantalla (la cámara suele estar más arriba): se resta después.
      gazeOffset = [0, 1].map((i) => Math.max(-1, Math.min(1, median(neutral.map((f) => f.gaze?.[i] ?? 0))))) as [number, number];
      eyeSensitivity = 0;
      mouthSensitivity = 0;
      step = "adjust";
    } catch (e) {
      error = e;
      step = "intro";
    }
  }

  async function save() {
    if (!values) return;
    saving = true;
    try {
      // $state.snapshot: enviar un objeto normal, no el proxy reactivo de Svelte
      // (la comunicación con Rust no puede copiar un proxy).
      await invoke("calibration_set", { values: $state.snapshot(values) });
      previewing = false;
      onclose();
    } catch (e) {
      error = e;
    } finally {
      saving = false;
    }
  }

  function cancel() {
    // onDestroy termina la vista previa (el avatar vuelve a la calibración guardada).
    onclose();
  }
</script>

{#snippet meter(label: string, value: number, from: number, to: number)}
  <!-- Barra 0–1 con el valor en vivo; las marcas son los umbrales (empieza / del todo). -->
  <div class="meter-row">
    <span class="meter-label">{label}</span>
    <div class="meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={1} aria-valuenow={value}>
      <div class="fill" class:full={value >= to} style="width: {clamp01(value) * 100}%"></div>
      <div class="mark" style="left: {from * 100}%"></div>
      <div class="mark strong" style="left: {to * 100}%"></div>
    </div>
    <span class="meter-value">{value.toFixed(2)}</span>
  </div>
{/snippet}

<div class="calibration" role="region" aria-label={t("calibration.title")} aria-live="polite">
  <div class="head">
    <strong>{t(step === "adjust" ? "calibration.adjustTitle" : "calibration.title")}</strong>
    <span class="face" class:ok={faceVisible}>{faceVisible ? t("calibration.faceOk") : t("calibration.faceLost")}</span>
  </div>

  {#if step === "adjust" && values}
    <p>{t("calibration.adjustHelp")}</p>
    {@render meter(t("calibration.eyeLeftMeter"), liveEyeL, values.eyeOpen, values.eyeClosed)}
    {@render meter(t("calibration.eyeRightMeter"), liveEyeR, values.eyeRight?.[0] ?? values.eyeOpen, values.eyeRight?.[1] ?? values.eyeClosed)}
    {@render meter(t("calibration.mouthMeter"), liveJaw, values.mouthClosed, values.mouthOpen)}
    <p class="legend">{t("calibration.legend")}</p>

    <label class="slider">
      <span>{t("calibration.eyeSensitivity")}</span>
      <span class="range">
        <small>{t("calibration.less")}</small>
        <input type="range" min="-1" max="1" step="0.1" bind:value={eyeSensitivity} use:tooltip={t("tooltips.eyeSensitivity")} />
        <small>{t("calibration.more")}</small>
      </span>
    </label>
    <label class="slider">
      <span>{t("calibration.mouthSensitivity")}</span>
      <span class="range">
        <small>{t("calibration.less")}</small>
        <input type="range" min="-1" max="1" step="0.1" bind:value={mouthSensitivity} use:tooltip={t("tooltips.mouthSensitivity")} />
        <small>{t("calibration.more")}</small>
      </span>
    </label>

    {#if smallEyeSignal}<p class="warn">{t("calibration.smallEyeSignal")}</p>{/if}
    {#if error}<p class="error">{errorText(error)}</p>{/if}
    <div class="actions three">
      <button class="btn" onclick={save} disabled={saving}>{t("calibration.save")}</button>
      <button class="btn ghost" onclick={run} use:tooltip={t("tooltips.calibrationRepeat")}>{t("calibration.repeat")}</button>
      <button class="btn ghost" onclick={cancel}>{t("calibration.cancel")}</button>
    </div>
  {:else}
    <p>{t(STEP_TEXT[step === "adjust" ? "intro" : step])}</p>
    {#if step === "eyes"}
      {@render meter(t("calibration.eyeLeftMeter"), liveEyeL, 0, 1)}
      {@render meter(t("calibration.eyeRightMeter"), liveEyeR, 0, 1)}
    {:else if step === "mouth"}
      {@render meter(t("calibration.mouthMeter"), liveJaw, 0, 1)}
    {/if}
    {#if step !== "intro" && !waiting}
      <p class="status">
        {capturing ? t("calibration.capturing") : t("calibration.countdown", { n: countdown })}
      </p>
    {/if}
    {#if error}<p class="error">{errorText(error)}</p>{/if}
    {#if step === "intro"}
      <div class="actions">
        <button class="btn" onclick={run} disabled={!faceVisible} use:tooltip={t("tooltips.calibrationStart")}>
          {t("calibration.start")}
        </button>
        <button class="btn ghost" onclick={cancel}>{t("calibration.cancel")}</button>
      </div>
    {:else if waiting}
      <!-- Sin ver la cara no se puede medir: el botón espera a que la cámara te vea. -->
      <div class="actions">
        <button class="btn" onclick={() => go?.()} disabled={!faceVisible}>
          {t("calibration.startStep")}
        </button>
        <button class="btn ghost" onclick={cancel}>{t("calibration.cancel")}</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .calibration {
    margin: 8px 0;
    padding: 10px;
    border: 1px solid var(--purple);
    border-radius: 8px;
    background: var(--panel-2);
    font-size: 13px;
  }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  .face { font-size: 11px; color: var(--danger); }
  .face.ok { color: #4ade80; }
  p { margin: 6px 0; line-height: 1.4; }
  .status { color: var(--orange); font-weight: 600; }
  .legend { font-size: 11px; color: var(--muted); }

  .meter-row { display: grid; grid-template-columns: 52px 1fr 34px; align-items: center; gap: 6px; margin: 6px 0; }
  .meter-label { font-size: 12px; color: var(--muted); }
  .meter-value { font-size: 11px; color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
  .meter { position: relative; height: 10px; border-radius: 5px; background: var(--bg); overflow: hidden; }
  .fill { height: 100%; background: var(--purple); transition: width 0.08s linear; }
  .fill.full { background: var(--orange); }
  .mark { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--muted); }
  .mark.strong { background: var(--text); }

  .slider { display: block; margin: 8px 0 4px; font-size: 12px; }
  .range { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 6px; }
  .range small { color: var(--muted); font-size: 10px; }
  input[type="range"] { width: 100%; accent-color: var(--orange); }

  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; }
  .actions.three { grid-template-columns: 1fr 1fr 1fr; }
  .btn {
    padding: 7px 6px; border: 1px solid transparent; border-radius: 6px;
    background: linear-gradient(90deg, var(--orange), var(--purple));
    color: #fff; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .btn.ghost { background: transparent; border-color: var(--border); color: var(--text); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .error { color: var(--danger); font-size: 12px; }
  .warn {
    margin: 6px 0; padding: 6px 8px; border: 1px solid #b45309; border-radius: 6px;
    background: rgba(251, 191, 36, 0.12); color: #fcd34d; font-size: 11px; line-height: 1.4;
  }
</style>
