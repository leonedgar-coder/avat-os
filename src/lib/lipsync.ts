// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Lip-sync por micrófono: mide el volumen de la voz y lo convierte en un nivel
// de 0 a 1 para abrir la boca del avatar, y reconoce la vocal (A, I, U, E, O) para
// darle su forma (ver vowels.ts). Todo se procesa en el equipo: a Rust (y de ahí a
// la página del avatar) solo viajan esos números, nunca el audio.

import { VowelAnalyzer, type VowelResult, type VowelTemplates, type VowelWeights } from "./vowels";

/** Cada cuánto se mide y se envía el nivel (~30 por segundo, como el tracking). */
const INTERVAL_MS = 33;

/**
 * Rango de volumen (en dB) que se lleva a 0–1 con sensibilidad 0. Por debajo de
 * FLOOR_DB la boca queda cerrada (ruido de fondo, respiración); desde CEIL_DB,
 * abierta del todo. La sensibilidad (−1 a 1) baja o sube ambos límites.
 */
const FLOOR_DB = -48;
const CEIL_DB = -20;
const SENSITIVITY_DB = 10;

/** Desde qué nivel se considera que hay voz y se busca la vocal (por debajo, el ruido confunde). */
const VOWEL_MIN_LEVEL = 0.12;
/** Suavizado de las vocales por medición (0–1): evita que la forma salte entre sílabas. */
const VOWEL_SMOOTHING = 0.45;
/** Muestras por medición: ~43 ms a 48 kHz (las vocales necesitan algo más que el volumen). */
const BLOCK = 2048;
/** El volumen se mide sobre las últimas 1024 muestras (~21 ms), como antes: responde rápido. */
const LEVEL_SAMPLES = 1024;

export interface MicDevice {
  id: string;
  /** Nombre que da Windows (vacío hasta dar permiso: la interfaz muestra "Micrófono N"). */
  label: string;
}

export class LipSync {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private buffer = new Float32Array(BLOCK);
  private vowelAnalyzer: VowelAnalyzer | null = null;
  private vowelWeights: VowelWeights = [1, 0, 0, 0, 0];
  private timer: ReturnType<typeof setInterval> | undefined;
  private envelope = 0;
  /** Sensibilidad de −1 (menos) a 1 (más). */
  sensitivity = 0;
  /** Reconocer vocales (si no, `onLevel` recibe `null` y la boca solo se abre y cierra). */
  vowels = true;
  /**
   * Cada análisis de vocal (con voz), para la calibración de vocales: formantes medidos
   * (o `null` si no se encontraron) y el nivel. Funciona aunque `vowels` esté apagado.
   */
  onAnalysis: ((result: VowelResult | null, level: number) => void) | null = null;
  private templates: VowelTemplates | null = null;

  /** Calibración de vocales de la persona (plantillas), o `null` para los valores típicos. */
  setVowelTemplates(templates: VowelTemplates | null) {
    this.templates = templates;
    if (this.vowelAnalyzer) this.vowelAnalyzer.templates = templates;
  }

  /** `vowels`: peso de A, I, U, E, O (suman 1), o `null` si están apagadas. */
  constructor(private onLevel: (level: number, vowels: VowelWeights | null) => void) {}

  get running(): boolean {
    return this.timer !== undefined;
  }

  /** Micrófonos disponibles (los nombres aparecen después de dar permiso). */
  static async devices(): Promise<MicDevice[]> {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      // "default" y "communications" son alias que agrega el navegador: la interfaz ya
      // ofrece "Predeterminado de Windows", así que se omiten para no repetir.
      .filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications")
      .map((d) => ({ id: d.deviceId, label: d.label }));
  }

  async start(deviceId?: string) {
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        // Sin control automático de ganancia (sube el ruido en los silencios).
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: true,
      },
      video: false,
    });
    try {
      this.ctx = new AudioContext();
      // El navegador puede crear el contexto "suspendido" (política de reproducción
      // automática) si pasó tiempo desde el clic; suspendido, el analizador solo ve silencio.
      if (this.ctx.state === "suspended") await this.ctx.resume();
      const source = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.buffer.length;
      this.vowelAnalyzer = new VowelAnalyzer(this.ctx.sampleRate);
      this.vowelAnalyzer.templates = this.templates;
      source.connect(this.analyser); // solo se analiza: no se reproduce por los altavoces
      this.timer = setInterval(this.tick, INTERVAL_MS);
    } catch (e) {
      this.stop(); // no dejar el micrófono abierto si el análisis no arranca
      throw e;
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
    this.vowelAnalyzer = null;
    this.vowelWeights = [1, 0, 0, 0, 0];
    this.envelope = 0;
  }

  private tick = () => {
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (let n = this.buffer.length - LEVEL_SAMPLES; n < this.buffer.length; n++) sum += this.buffer[n] ** 2;
    const rms = Math.sqrt(sum / LEVEL_SAMPLES);
    const db = 20 * Math.log10(Math.max(rms, 1e-6));
    const shift = this.sensitivity * SENSITIVITY_DB;
    const floor = FLOOR_DB - shift;
    const ceil = CEIL_DB - shift;
    const target = Math.min(1, Math.max(0, (db - floor) / (ceil - floor)));
    // Envolvente: sube rápido (las sílabas son cortas) y baja más despacio (sin temblor).
    const k = target > this.envelope ? 0.6 : 0.25;
    this.envelope += (target - this.envelope) * k;
    // Solo con voz: en silencio se conserva la última vocal (la boca se está cerrando).
    if ((this.vowels || this.onAnalysis) && target >= VOWEL_MIN_LEVEL && this.vowelAnalyzer) {
      const found = this.vowelAnalyzer.analyze(this.buffer);
      this.onAnalysis?.(found, target);
      const weights = found?.weights;
      if (weights) {
        this.vowelWeights = this.vowelWeights.map(
          (w, i) => w + (weights[i] - w) * VOWEL_SMOOTHING,
        ) as VowelWeights;
      }
    }
    this.onLevel(this.envelope, this.vowels ? this.vowelWeights : null);
  };
}
