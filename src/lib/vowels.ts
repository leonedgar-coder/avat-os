// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Reconoce la vocal que se está diciendo (A, I, U, E, O) a partir del audio del
// micrófono, para darle a la boca del avatar la forma de esa vocal.
//
// Cómo: cada vocal se distingue por sus dos primeras resonancias de la voz
// (formantes F1 y F2). Con LPC (predicción lineal) se obtiene un filtro que "imita"
// la garganta y la boca; las raíces de ese filtro son las resonancias, cada una con
// su frecuencia y su ancho de banda (el método de Praat y otros programas de fonética).
// Las raíces muy anchas son ruido y se descartan. Luego se compara (F1, F2) con los
// valores típicos de cada vocal del español, ajustados a la voz de quien habla: las
// voces más agudas tienen todos los formantes más altos (ver `speakerScale`).
// Todo es local; solo sale de aquí el peso de cada vocal (0–1).
//
// Con la calibración de vocales se usa otro método, más robusto: la **forma del espectro**
// de cada vocal medida en tu voz y con tu micrófono: la envolvente del filtro LPC evaluada en
// frecuencias repartidas en **escala mel** (como el oído: más detalle en los graves) y resumida
// en 12 números (DCT). No necesita encontrar dos resonancias exactas (con micrófonos reales la
// F2 de la A, la O y la U se pierde a menudo y se toma la F3): compara la forma completa.
//  - Envolvente LPC y no el espectro directo (MFCC): aguanta mejor los cambios de tono de la
//    entonación (medido: tono 15 % más alto que al calibrar, 100 % frente a 95 %).
//  - Escala mel y no el cepstrum LPC lineal (LPCC): la U y la O se distinguen sobre todo por
//    debajo de ~500 Hz; con LPCC quedaban casi iguales en una calibración real (separación 1,4)
//    y se confundían; con mel se separan 4–5 veces más (medido, también con un micrófono que
//    recorta los graves).

/** Pesos de las vocales en el orden de las expresiones VRM: aa, ih, ou, ee, oh. */
export type VowelWeights = [a: number, i: number, u: number, e: number, o: number];
export const VOWEL_LETTERS = ["A", "I", "U", "E", "O"] as const;
/** Formantes (F1, F2 en Hz) de cada vocal en el orden de `VOWEL_LETTERS` (valores típicos). */
export type VowelProfile = [f1: number, f2: number][];

/**
 * Formantes típicos (Hz) de las vocales del español para una voz grave (tono ~100 Hz),
 * entre los de los estudios de fonética (Quilis) y los medidos en voces de Windows.
 * La O y la U están cerca (F1 420 frente a 310): por eso hace falta ajustar a la voz.
 */
const PROTOTYPES: VowelProfile = [
  [650, 1300], // A
  [280, 2250], // I
  [310, 740], // U
  [420, 1850], // E
  [420, 880], // O
];
/**
 * Ajuste a la voz: los formantes suben con el tono, aproximadamente como
 * (tono / REFERENCE_F0) ^ SCALE_EXPONENT (medido: una voz de 210 Hz tiene los
 * formantes ~27 % más altos que una de 100 Hz). Se usa el tono **medio** de quien
 * habla, no el de cada instante (la entonación lo mueve todo el tiempo).
 */
const REFERENCE_F0 = 100;
const SCALE_EXPONENT = 0.32;
const MIN_SCALE = 0.92;
const MAX_SCALE = 1.5;
/** Tono medio con el que se empieza, antes de oír a la persona (voz intermedia). */
const INITIAL_F0 = 150;
/** Peso mínimo de cada medición en el tono medio (~1 s de voz a 30 mediciones por segundo). */
const F0_AVERAGE_RATE = 0.03;
/**
 * Tolerancia (en logaritmo natural) de F1 y F2: cuánto puede alejarse una voz del típico.
 * Iguales: con F2 más estricta, la O y la U (que se distinguen sobre todo por F1) se confundían.
 */
const SIGMA_F1 = 0.22;
const SIGMA_F2 = 0.22;
/**
 * Distancia máxima (en tolerancias al cuadrado, sumando F1 y F2) a la vocal más cercana.
 * Más lejos no es una vocal: una "m" (labios cerrados, suena por la nariz) da 4,5–8 y
 * los cortes entre sílabas 8–19; las vocales, 0–3,6. Entonces no hay resultado y la
 * boca mantiene la forma anterior.
 */
const MAX_DISTANCE = 4;

/** Frecuencia de trabajo (Hz): los dos primeros formantes están por debajo de ~3,5 kHz. */
const TARGET_RATE = 11000;
const LPC_ORDER = 10;
const LOWPASS_TAPS = 31;
/** Una resonancia más ancha que esto (Hz) no es un formante (ruido, tendencia del espectro). */
const MAX_BANDWIDTH = 500;
/**
 * En la U y la O, F2 es débil y a veces sale ancho (hasta ~900 Hz de banda) y se descarta;
 * entonces la "F2" encontrada es en realidad F3 y la vocal parece una I. Se corrige así:
 * si F2 cae por encima de FRONT_F2 (zona de la I y la E) **y no es nítida** (banda mayor
 * que SHARP_BANDWIDTH: la F2 de una I de verdad es nítida, una F3 poco excitada no), y hay
 * una resonancia de hasta WEAK_MAX_BANDWIDTH por debajo de BACK_F2_MAX, esa es la F2 real.
 */
const WEAK_MAX_BANDWIDTH = 1000;
/**
 * Solo con voces de hasta este tono (Hz): en las más agudas, los armónicos de la voz
 * forman resonancias anchas parecidas y la regla convertía la I en U.
 */
const WEAK_F2_MAX_F0 = 240;
const SHARP_BANDWIDTH = 250;
/** Dos resonancias borrosas tan juntas (proporción) son una sola F1 partida por los armónicos. */
const SPLIT_RATIO = 1.5;
/** Más borrosa que esto, y con una nítida justo encima, es una resonancia falsa. */
const BLURRY_BANDWIDTH = 400;
const FRONT_F2 = 1800;
const BACK_F2_MAX = 1500;
/** F1 más alta posible: la A de una voz aguda pasa de 1 kHz. */
const MAX_F1 = 1250;
/** F2 más alta posible: la I de una voz aguda llega a ~3,3 kHz. */
const MAX_F2 = 3600;
const PRE_EMPHASIS = 0.97;

/** Coeficientes de la forma del espectro (sin el 0, que es el volumen). */
export const SHAPE_COUNT = 12;
/** Puntos de la envolvente en escala mel, y entre qué frecuencias (Hz). */
const MEL_POINTS = 32;
const MEL_LOW = 60;
const MEL_HIGH = 5000;
/**
 * Plantillas: distancia media (en desvíos de tu propia voz, al cuadrado, por coeficiente)
 * desde la que un sonido no se parece a ninguna vocal: la boca mantiene la forma anterior.
 * Medido con la forma en escala mel: una "m" o una "n" quedan a 8 o más; con 4, el tono de la
 * entonación (+15 %) daba "no sé" en 7 de 100 vocales; con 6, en ninguna, sin equivocarse más.
 */
const MAX_TEMPLATE_DISTANCE = 6;
/** Por debajo de esto, dos plantillas están tan cerca que esas vocales se confundirían. */
const MIN_TEMPLATE_SEPARATION = 1.5;

/**
 * Calibración de vocales: la forma media del espectro (escala mel) de cada vocal de la persona,
 * en el orden de `VOWEL_LETTERS`, y cuánto varía su voz en cada coeficiente (`scale`).
 */
export interface VowelTemplates {
  means: number[][];
  scale: number[];
}

/** Tono posible de la voz (Hz): de una voz muy grave a una infantil. */
const MIN_F0 = 70;
const MAX_F0 = 400;
/** Desde qué parecido entre periodos (autocorrelación normalizada) el sonido es "sonoro". */
const VOICED_MIN = 0.45;

export interface VowelResult {
  /** Formantes (Hz), o `null` si no se encontraron (con plantillas no hacen falta). */
  f1: number | null;
  f2: number | null;
  /** Forma del espectro (12 coeficientes en escala mel), o `null` si no se pudo calcular. */
  shape: number[] | null;
  /** Tono de la voz en este bloque (Hz). */
  f0: number;
  /** Ajuste a la voz que se usó (1 = voz grave de referencia o perfil personal). */
  scale: number;
  /** Peso de cada vocal, o `null` si no se parece a ninguna (una "m", un corte entre sílabas). */
  weights: VowelWeights | null;
}

export class VowelAnalyzer {
  private factor: number;
  private rate: number;
  private taps: Float32Array;
  private work = new Float32Array(0);
  /** Tono medio de quien habla (logaritmo) y cuántas mediciones sonoras van. */
  private logF0 = Math.log(INITIAL_F0);
  private voiced = 0;
  /** Calibración de la persona (plantillas de la forma del espectro). Sin ella, formantes típicos ajustados al tono. */
  templates: VowelTemplates | null = null;

  constructor(sampleRate: number) {
    this.factor = Math.max(1, Math.floor(sampleRate / TARGET_RATE));
    this.rate = sampleRate / this.factor;
    this.taps = lowpass(0.8 * (this.rate / 2), sampleRate, LOWPASS_TAPS);
  }

  /**
   * Analiza un bloque de audio (unos 40 ms). `null` si no es sonoro; si no se parece a
   * ninguna vocal, `weights` es `null`.
   */
  analyze(samples: Float32Array): VowelResult | null {
    const x = this.decimate(samples);
    if (x.length < LPC_ORDER * 4) return null;
    // Las vocales son sonoras (vibran las cuerdas vocales); una "s", "f" o "j" no:
    // sin tono no hay vocal y la boca mantiene la forma anterior.
    const f0 = pitch(x, this.rate);
    if (!f0) return null;
    // Al principio, promedio simple (se adapta rápido); después, uno que sigue cambios lentos.
    this.voiced++;
    this.logF0 += (Math.log(f0) - this.logF0) * Math.max(1 / this.voiced, F0_AVERAGE_RATE);
    // Preénfasis (realza los agudos, como hace el oído) + ventana de Hamming.
    for (let n = x.length - 1; n > 0; n--) x[n] -= PRE_EMPHASIS * x[n - 1];
    for (let n = 0; n < x.length; n++) x[n] *= 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (x.length - 1));
    const a = lpc(x, LPC_ORDER);
    if (!a) return null;
    const shape = melShape(a, this.rate);
    const formants = findFormants(resonances(a, this.rate), f0);
    const [f1, f2] = formants ?? [null, null];
    if (this.templates) {
      return { f1, f2, shape, f0, scale: 1, weights: classifyTemplates(shape, this.templates) };
    }
    // Sin formantes no hay vocal con el método típico, pero la forma del espectro sí sirve
    // (p. ej. para calibrar una U cuya F2 se pierde): se devuelve sin pesos.
    const scale = this.speakerScale();
    if (f1 === null || f2 === null) return { f1, f2, shape, f0, scale, weights: null };
    return { f1, f2, shape, f0, scale, weights: classify(f1, f2, scale, PROTOTYPES) };
  }

  /** Cuánto más altos que los de referencia son los formantes de esta voz. */
  speakerScale(): number {
    const scale = Math.exp(SCALE_EXPONENT * (this.logF0 - Math.log(REFERENCE_F0)));
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  }

  /** Filtro pasa bajos + quedarse con 1 de cada `factor` muestras. */
  private decimate(samples: Float32Array): Float32Array {
    const half = (LOWPASS_TAPS - 1) / 2;
    const len = Math.max(0, Math.floor((samples.length - LOWPASS_TAPS) / this.factor));
    if (this.work.length !== len) this.work = new Float32Array(len);
    for (let m = 0; m < len; m++) {
      const center = m * this.factor + half;
      let acc = 0;
      for (let k = 0; k < LOWPASS_TAPS; k++) acc += this.taps[k] * samples[center - half + k];
      this.work[m] = acc;
    }
    return this.work;
  }
}

/**
 * Tono (Hz) por autocorrelación normalizada, o `null` si el sonido no es sonoro.
 * Para no confundir el tono con su mitad (error de octava), si el pico en la mitad del
 * periodo es casi igual de alto, se elige ese.
 */
function pitch(x: Float32Array, rate: number): number | null {
  const minLag = Math.floor(rate / MAX_F0);
  const maxLag = Math.min(Math.ceil(rate / MIN_F0), Math.floor(x.length / 2));
  if (maxLag <= minLag + 2) return null;
  const corr = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let n = 0; n + lag < x.length; n++) {
      xy += x[n] * x[n + lag];
      xx += x[n] * x[n];
      yy += x[n + lag] * x[n + lag];
    }
    corr[lag] = xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0;
  }
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1] && (best < 0 || corr[lag] > corr[best])) best = lag;
  }
  if (best < 0 || corr[best] < VOICED_MIN) return null;
  const half = Math.round(best / 2);
  if (half >= minLag) {
    let h = half;
    for (const d of [-1, 1]) if (corr[half + d] > corr[h]) h = half + d;
    if (corr[h] > 0.85 * corr[best]) best = h;
  }
  return rate / best;
}

/**
 * Forma del espectro: el logaritmo de la envolvente del filtro LPC (|1/A|²) en MEL_POINTS
 * frecuencias repartidas en escala mel, resumido en SHAPE_COUNT coeficientes con una DCT
 * (sin el 0, que es el volumen). Escala mel = más puntos en los graves, donde se distinguen
 * la U y la O.
 */
function melShape(a: Float64Array, rate: number): number[] {
  const toMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
  const toHz = (mel: number) => 700 * (10 ** (mel / 2595) - 1);
  const lo = toMel(MEL_LOW);
  const hi = toMel(Math.min(MEL_HIGH, rate / 2 - 100));
  const logE: number[] = [];
  for (let i = 0; i < MEL_POINTS; i++) {
    const w = (2 * Math.PI * toHz(lo + ((hi - lo) * (i + 0.5)) / MEL_POINTS)) / rate;
    let re = 0;
    let im = 0;
    for (let k = 0; k < a.length; k++) {
      re += a[k] * Math.cos(w * k);
      im -= a[k] * Math.sin(w * k);
    }
    logE.push(-Math.log(re * re + im * im + 1e-12));
  }
  const out: number[] = [];
  for (let c = 1; c <= SHAPE_COUNT; c++) {
    let acc = 0;
    for (let m = 0; m < MEL_POINTS; m++) acc += logE[m] * Math.cos((Math.PI * c * (m + 0.5)) / MEL_POINTS);
    out.push(acc * Math.sqrt(2 / MEL_POINTS));
  }
  return out;
}

/** Distancia media al cuadrado (en desvíos de la persona) entre una forma y una plantilla. */
function templateDistance(x: number[], mean: number[], scale: number[]): number {
  let d = 0;
  for (let i = 0; i < mean.length; i++) d += ((x[i] - mean[i]) / scale[i]) ** 2;
  return d / mean.length;
}

/** Pesos 0–1 de cada vocal con las plantillas de la persona; `null` si no se parece a ninguna. */
export function classifyTemplates(shape: number[], t: VowelTemplates): VowelWeights | null {
  const d = t.means.map((m) => templateDistance(shape, m, t.scale));
  const nearest = Math.min(...d);
  if (nearest > MAX_TEMPLATE_DISTANCE) return null;
  // Verosimilitud gaussiana: exp(−N·d/2), relativa a la más cercana.
  const w = d.map((v) => Math.exp((-(v - nearest) * SHAPE_COUNT) / 2));
  const total = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / total) as VowelWeights;
}

/**
 * Plantillas a partir de las mediciones de la calibración (`samples[i]` = las formas de la
 * vocal `VOWEL_LETTERS[i]`): la media de cada vocal y el desvío de la voz dentro de cada
 * vocal (promediado entre las cinco), con un mínimo para no dividir por casi cero.
 */
export function buildTemplates(samples: number[][][]): VowelTemplates {
  const means = samples.map((vs) => vs[0].map((_, i) => vs.reduce((acc, v) => acc + v[i], 0) / vs.length));
  const scale = means[0].map((_, i) => {
    let sum = 0;
    let n = 0;
    samples.forEach((vs, k) => vs.forEach((v) => ((sum += (v[i] - means[k][i]) ** 2), n++)));
    return Math.max(Math.sqrt(sum / n), 0.005);
  });
  const round = (v: number) => Math.round(v * 1e4) / 1e4;
  return { means: means.map((m) => m.map(round)), scale: scale.map(round) };
}

/** Pares de vocales cuyas plantillas quedaron demasiado parecidas (índices de `VOWEL_LETTERS`). */
export function closeTemplates(t: VowelTemplates): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < t.means.length; i++) {
    for (let j = i + 1; j < t.means.length; j++) {
      if (templateDistance(t.means[i], t.means[j], t.scale) < MIN_TEMPLATE_SEPARATION) out.push([i, j]);
    }
  }
  return out;
}

/** ¿Son plantillas válidas? (lo guardado puede venir de otra versión o estar dañado) */
export function isVowelTemplates(v: unknown): v is VowelTemplates {
  const vec = (x: unknown) => Array.isArray(x) && x.length === SHAPE_COUNT && x.every((n) => typeof n === "number" && Number.isFinite(n));
  const t = v as VowelTemplates;
  return (
    !!t && Array.isArray(t.means) && t.means.length === VOWEL_LETTERS.length && t.means.every(vec) &&
    vec(t.scale) && t.scale.every((n) => n > 0)
  );
}

/** Filtro FIR pasa bajos (sinc con ventana de Hamming). */
function lowpass(cutoff: number, rate: number, taps: number): Float32Array {
  const h = new Float32Array(taps);
  const fc = cutoff / rate;
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let k = 0; k < taps; k++) {
    const n = k - mid;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    h[k] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * k) / (taps - 1)));
    sum += h[k];
  }
  for (let k = 0; k < taps; k++) h[k] /= sum;
  return h;
}

/** Coeficientes LPC (autocorrelación + Levinson-Durbin). a[0] = 1. */
function lpc(x: Float32Array, order: number): Float64Array | null {
  const r = new Float64Array(order + 1);
  for (let lag = 0; lag <= order; lag++) {
    let s = 0;
    for (let n = lag; n < x.length; n++) s += x[n] * x[n - lag];
    r[lag] = s;
  }
  if (r[0] <= 1e-10) return null; // silencio
  r[0] *= 1.0001; // un poco de "ruido blanco": evita inestabilidad numérica
  const a = new Float64Array(order + 1);
  a[0] = 1;
  let err = r[0];
  const prev = new Float64Array(order + 1);
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / err;
    prev.set(a);
    for (let j = 1; j < i; j++) a[j] = prev[j] + k * prev[i - j];
    a[i] = k;
    err *= 1 - k * k;
    if (err <= 0) return null;
  }
  return a;
}

/** Resonancias del filtro LPC: frecuencia y ancho de banda (Hz), de grave a agudo. */
function resonances(a: Float64Array, rate: number): { f: number; bw: number }[] {
  const out: { f: number; bw: number }[] = [];
  for (const [re, im] of roots(a)) {
    if (im <= 0) continue; // las raíces vienen en pares conjugados: basta con una
    const f = (Math.atan2(im, re) * rate) / (2 * Math.PI);
    const bw = (-Math.log(Math.hypot(re, im)) * rate) / Math.PI;
    if (f > 90 && bw > 0 && bw < WEAK_MAX_BANDWIDTH) out.push({ f, bw });
  }
  return out.sort((x, y) => x.f - y.f);
}

/**
 * Raíces de z^p + a1·z^(p-1) + … + ap (método de Durand-Kerner: todas a la vez,
 * con aritmética compleja). Para p = 10 converge en unas decenas de vueltas.
 */
function roots(a: Float64Array): [number, number][] {
  const p = a.length - 1;
  const re = new Float64Array(p);
  const im = new Float64Array(p);
  // Puntos de partida distintos y no simétricos (potencias de 0,4 + 0,9i).
  let zr = 1;
  let zi = 0;
  for (let k = 0; k < p; k++) {
    re[k] = zr;
    im[k] = zi;
    [zr, zi] = [zr * 0.4 - zi * 0.9, zr * 0.9 + zi * 0.4];
  }
  for (let iter = 0; iter < 200; iter++) {
    let moved = 0;
    for (let k = 0; k < p; k++) {
      // Valor del polinomio en la raíz k (Horner).
      let vr = 1;
      let vi = 0;
      for (let j = 1; j <= p; j++) {
        [vr, vi] = [vr * re[k] - vi * im[k] + a[j], vr * im[k] + vi * re[k]];
      }
      // Producto de (raíz k − raíz j).
      let dr = 1;
      let di = 0;
      for (let j = 0; j < p; j++) {
        if (j === k) continue;
        const xr = re[k] - re[j];
        const xi = im[k] - im[j];
        [dr, di] = [dr * xr - di * xi, dr * xi + di * xr];
      }
      const den = dr * dr + di * di;
      if (den === 0) continue;
      const sr = (vr * dr + vi * di) / den;
      const si = (vi * dr - vr * di) / den;
      re[k] -= sr;
      im[k] -= si;
      moved = Math.max(moved, Math.abs(sr) + Math.abs(si));
    }
    if (moved < 1e-10) break;
  }
  return Array.from(re, (r, k) => [r, im[k]]);
}

/**
 * F1 = primera resonancia definida (banda < MAX_BANDWIDTH) entre 200 y 1000 Hz;
 * F2 = la siguiente definida, hasta MAX_F2 (o la débil de la U y la O, ver arriba).
 */
function findFormants(res: { f: number; bw: number }[], f0: number): [number, number] | null {
  const clear = res.filter((r) => r.bw < MAX_BANDWIDTH);
  const i1 = clear.findIndex((r) => r.f >= 200 && r.f <= MAX_F1);
  if (i1 < 0) return null;
  let first = clear[i1];
  let f1 = first.f;
  // Con voces agudas, LPC a veces "imita" los armónicos: aparecen resonancias borrosas
  // de más alrededor de F1 (las de verdad son nítidas).
  const next = clear[i1 + 1];
  if (next && next.f <= MAX_F1 && first.bw > SHARP_BANDWIDTH) {
    if (next.bw > SHARP_BANDWIDTH && next.f / first.f < SPLIT_RATIO) {
      f1 = Math.sqrt(first.f * next.f); // una F1 partida en dos
      first = next;
    } else if (first.bw > BLURRY_BANDWIDTH && next.bw <= SHARP_BANDWIDTH) {
      first = next; // una resonancia falsa debajo de la F1 real
      f1 = first.f;
    }
  }
  const after = (r: { f: number }) => r.f > first.f * 1.15 && r.f > f1 * 1.15;
  const second = clear.find((r) => after(r) && r.f <= MAX_F2);
  if (f0 <= WEAK_F2_MAX_F0 && (!second || (second.f > FRONT_F2 && second.bw > SHARP_BANDWIDTH))) {
    const weak = res.find((r) => after(r) && r.f <= BACK_F2_MAX);
    if (weak) return [f1, weak.f];
  }
  return second ? [f1, second.f] : null;
}

/**
 * Pesos 0–1 de cada vocal (suman 1) según la distancia a los valores típicos,
 * multiplicados por `scale` (el ajuste a la voz). `null` si no se parece a ninguna.
 */
export function classify(f1: number, f2: number, scale = 1, prototypes: VowelProfile = PROTOTYPES): VowelWeights | null {
  const distances = prototypes.map(([p1, p2]) => {
    const d1 = Math.log(f1 / (p1 * scale)) / SIGMA_F1;
    const d2 = Math.log(f2 / (p2 * scale)) / SIGMA_F2;
    return d1 * d1 + d2 * d2;
  });
  const nearest = Math.min(...distances);
  if (nearest > MAX_DISTANCE) return null;
  // Relativo a la más cercana: evita que todos los pesos se vuelvan 0 por redondeo.
  const scores = distances.map((d) => Math.exp(-(d - nearest)));
  const total = scores.reduce((s, v) => s + v, 0);
  return scores.map((s) => s / total) as VowelWeights;
}

