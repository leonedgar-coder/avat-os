<!--
  avat-os — Copyright (C) 2026 avat-os contributors
  SPDX-License-Identifier: GPL-3.0-or-later

  Calibración de vocales: la persona dice A, E, I, O, U y se mide la forma del espectro
  (envolvente en escala mel) de cada una con su voz y su micrófono. Desde entonces el lip-sync compara con
  SUS plantillas en lugar de los formantes típicos (ver src/lib/vowels.ts). Los formantes
  (F1, F2) se siguen mostrando como referencia.
  Se guarda en este equipo (localStorage), como el resto de las preferencias del lip-sync.
-->
<script module lang="ts">
  import { isVowelTemplates, type VowelTemplates } from "$lib/vowels";

  const STORAGE_KEY = "avatos.vowelProfile";
  /**
   * Versión del perfil: subirla si cambia cómo se mide (vowels.ts), así una calibración hecha
   * con la medición anterior no se usa con la nueva (hay que recalibrar).
   * 1 = formantes F1/F2 (fallaban con micrófonos reales); 2 = plantillas con cepstrum LPC
   * (la U y la O quedaban casi iguales); 3 = plantillas en escala mel.
   */
  const PROFILE_VERSION = 3;

  /** Plantillas guardadas, o `null` (valores típicos). */
  export function loadVowelProfile(): VowelTemplates | null {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
      return saved?.version === PROFILE_VERSION && isVowelTemplates(saved.templates) ? saved.templates : null;
    } catch {
      return null;
    }
  }

  function storeVowelProfile(templates: VowelTemplates | null, formants: (number | null)[][] = []) {
    try {
      if (templates) localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: PROFILE_VERSION, templates, formants }));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* no se pudo guardar: se usará solo en esta sesión */
    }
  }
</script>

<script lang="ts">
  import { onDestroy } from "svelte";
  import { t } from "$lib/i18n/index.svelte";
  import type { LipSync } from "$lib/lipsync";
  import { tooltip } from "$lib/tooltip";
  import { VOWEL_LETTERS, buildTemplates, closeTemplates, type VowelResult } from "$lib/vowels";

  let { lipsync }: { lipsync: LipSync } = $props();

  /** Orden en que se piden (el natural en español); se guardan en el de VOWEL_LETTERS. */
  const ORDER = ["A", "E", "I", "O", "U"] as const;
  /** Mediciones con voz necesarias por vocal (~1 s a 30 por segundo). */
  const NEEDED = 30;
  /** Mediciones que se descartan al empezar cada vocal (la transición desde la anterior). */
  const SKIP = 4;
  /** Si en este tiempo no se juntaron las mediciones, se avisa. */
  const VOWEL_TIMEOUT_MS = 8000;
  /** Pausa entre vocales para prepararse. */
  const PREPARE_MS = 1200;

  let profile = $state<VowelTemplates | null>(loadVowelProfile());
  type Phase = "idle" | "prepare" | "listen" | "failed" | "review";
  let phase = $state<Phase>("idle");
  let step = $state(0);
  let collected = $state(0);
  let live = $state<{ f1: string; f2: string; f0: number } | null>(null);
  /** Formantes medianos de cada vocal (solo para mostrar; `null` si no se encontraron). */
  let measured = $state<(number | null)[][]>([]);
  /** Formas del espectro de cada vocal (en el orden de VOWEL_LETTERS). */
  let shapes: number[][][] = [];
  let candidate = $state<VowelTemplates | null>(null);
  let samples: { f1: number[]; f2: number[]; shape: number[][] } = { f1: [], f2: [], shape: [] };
  let seen = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const letter = $derived(ORDER[step]);
  const close = $derived(phase === "review" && candidate ? closeTemplates(candidate) : []);

  // El perfil se aplica al lip-sync al cargar y cada vez que cambia.
  $effect(() => {
    lipsync.setVowelTemplates($state.snapshot(profile) as VowelTemplates | null);
  });

  const median = (v: number[]) => {
    if (!v.length) return null;
    const s = [...v].sort((a, b) => a - b);
    return Math.round(s[Math.floor(s.length / 2)]);
  };

  function start() {
    measured = Array.from({ length: VOWEL_LETTERS.length }, () => [null, null]);
    shapes = Array.from({ length: VOWEL_LETTERS.length }, () => []);
    candidate = null;
    lipsync.onAnalysis = onAnalysis;
    beginVowel(0);
  }

  function beginVowel(i: number) {
    step = i;
    phase = "prepare";
    collected = 0;
    live = null;
    clearTimeout(timer);
    timer = setTimeout(() => {
      samples = { f1: [], f2: [], shape: [] };
      seen = 0;
      phase = "listen";
      timer = setTimeout(() => (phase = "failed"), VOWEL_TIMEOUT_MS);
    }, PREPARE_MS);
  }

  function onAnalysis(result: VowelResult | null) {
    const show = (v: number | null) => (v === null ? "—" : String(Math.round(v)));
    if (result) live = { f1: show(result.f1), f2: show(result.f2), f0: Math.round(result.f0) };
    if (phase !== "listen" || !result) return;
    if (++seen <= SKIP) return;
    if (!result.shape) return;
    samples.shape.push(result.shape);
    if (result.f1 !== null) samples.f1.push(result.f1);
    if (result.f2 !== null) samples.f2.push(result.f2);
    collected = samples.shape.length;
    if (collected < NEEDED) return;
    clearTimeout(timer);
    const i = VOWEL_LETTERS.indexOf(letter);
    shapes[i] = samples.shape;
    // Mediana (solo para mostrar): una medición rara no mueve el resultado.
    measured[i] = [median(samples.f1), median(samples.f2)];
    if (step + 1 < ORDER.length) beginVowel(step + 1);
    else {
      lipsync.onAnalysis = null;
      candidate = buildTemplates(shapes);
      phase = "review";
    }
  }

  function stop() {
    clearTimeout(timer);
    lipsync.onAnalysis = null;
    phase = "idle";
    live = null;
  }

  function save() {
    if (!candidate) return;
    profile = $state.snapshot(candidate) as VowelTemplates;
    storeVowelProfile(profile, $state.snapshot(measured) as (number | null)[][]);
    stop();
  }

  function reset() {
    profile = null;
    storeVowelProfile(null);
  }

  onDestroy(() => {
    clearTimeout(timer);
    if (lipsync.onAnalysis === onAnalysis) lipsync.onAnalysis = null;
  });
</script>

<div class="vcal">
  {#if phase === "idle"}
    <div class="row">
      <span>{t("vowelCal.label")}</span>
      <span class="state">{profile ? t("vowelCal.personal") : t("vowelCal.standard")}</span>
      <span class="actions">
        <button class="link" onclick={start} use:tooltip={t("tooltips.vowelCal")}>
          {profile ? t("vowelCal.recalibrate") : t("vowelCal.calibrate")}
        </button>
        {#if profile}
          <button class="link" onclick={reset} use:tooltip={t("tooltips.vowelCalReset")}>{t("vowelCal.reset")}</button>
        {/if}
      </span>
    </div>
  {:else if phase === "review"}
    <p class="title">{t("vowelCal.result")}</p>
    <div class="table">
      {#each ORDER as v}
        {@const [f1, f2] = measured[VOWEL_LETTERS.indexOf(v)]}
        <span class="big">{v}</span><span>{f1 ?? "—"} / {f2 ?? "—"}</span>
      {/each}
    </div>
    {#each close as [a, b]}
      <p class="warn">{t("vowelCal.tooClose", { a: VOWEL_LETTERS[a], b: VOWEL_LETTERS[b] })}</p>
    {/each}
    <div class="buttons">
      <button class="primary" onclick={save}>{t("vowelCal.save")}</button>
      <button class="link" onclick={start}>{t("vowelCal.repeat")}</button>
      <button class="link" onclick={stop}>{t("vowelCal.cancel")}</button>
    </div>
  {:else}
    <p class="title">{t("vowelCal.step", { n: step + 1, total: ORDER.length })}</p>
    <div class="prompt" class:listening={phase === "listen"} aria-live="polite">
      <span class="letter">{letter}</span>
      <span>
        {#if phase === "prepare"}
          {t("vowelCal.prepare", { v: letter })}
        {:else if phase === "listen"}
          {t("vowelCal.say", { v: letter, long: letter.toLowerCase().repeat(5) })}
        {:else}
          <span class="error">{t("vowelCal.noVoice", { v: letter })}</span>
        {/if}
      </span>
    </div>
    <div class="meter" role="progressbar" aria-valuemin={0} aria-valuemax={NEEDED} aria-valuenow={collected}>
      <div class="fill" style="width: {(collected / NEEDED) * 100}%"></div>
    </div>
    <!-- Lo que se mide en vivo: útil para ver si una vocal se parece a otra. -->
    <p class="live">{live ? t("vowelCal.live", live) : " "}</p>
    <div class="buttons">
      {#if phase === "failed"}
        <button class="link" onclick={() => beginVowel(step)}>{t("vowelCal.retry")}</button>
      {/if}
      <button class="link" onclick={stop}>{t("vowelCal.cancel")}</button>
    </div>
  {/if}
</div>

<style>
  .vcal { margin: 6px 0 2px; color: var(--muted); font-size: 12px; }
  .row { display: grid; grid-template-columns: 74px 1fr auto; align-items: center; gap: 6px; }
  .state { color: var(--text); }
  .actions { display: flex; gap: 10px; }
  .title { margin: 6px 0 4px; color: var(--purple); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .prompt { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; color: var(--text); line-height: 1.35; }
  .prompt.listening { border-color: var(--orange); }
  .letter { font-size: 28px; font-weight: 700; color: var(--orange); min-width: 1.2ch; text-align: center; }
  .meter { height: 6px; margin-top: 6px; border-radius: 3px; background: var(--bg); overflow: hidden; }
  .fill { height: 100%; background: linear-gradient(90deg, var(--orange), var(--purple)); transition: width 0.1s linear; }
  .live { margin: 4px 0 0; font-size: 11px; font-variant-numeric: tabular-nums; }
  .table { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-items: baseline; color: var(--text); font-variant-numeric: tabular-nums; }
  .big { font-weight: 700; color: var(--orange); }
  .warn { margin: 6px 0 0; padding: 5px 7px; border: 1px solid #b45309; border-radius: 6px; background: rgba(251, 191, 36, 0.12); color: #fcd34d; font-size: 11px; }
  .error { color: var(--danger); }
  .buttons { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 6px; }
  .link { border: 0; background: transparent; padding: 0; color: var(--purple); font: inherit; font-size: 11px; cursor: pointer; text-decoration: underline; }
  .link:hover { color: var(--orange); }
  .primary {
    border: 0; border-radius: 6px; padding: 4px 12px; font: inherit; font-size: 12px; cursor: pointer;
    color: #fff; background: linear-gradient(90deg, var(--orange), var(--purple));
  }
</style>
