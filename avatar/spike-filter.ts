// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Quita picos sueltos de una medición (mediana de las últimas 3 muestras). Para los
// párpados: un parpadeo de verdad dura 100–150 ms (3 a 5 muestras del tracking); un
// pico de ruido de la cámara, una sola. Sin esto, con un rango de ojos estrecho, cada
// pico cierra el ojo del avatar un instante y se ve como un parpadeo falso.
// Retrasa los parpadeos una muestra (~33 ms).

export class SpikeFilter {
  private last: number[] = [];

  filter(value: number): number {
    this.last.push(value);
    if (this.last.length > 3) this.last.shift();
    if (this.last.length < 3) return value;
    const [a, b, c] = this.last;
    return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c)); // mediana de 3
  }

  reset() {
    this.last = [];
  }
}

/**
 * Guiños. Un parpadeo de verdad cierra **los dos** ojos a la vez y se muestra al instante.
 * Que un ojo esté más cerrado que el otro tiene que **durar** al menos `minSamples` muestras
 * (~130 ms a 30 por segundo) para mostrarse: el ruido de la cámara en un ojo dura 2–3 muestras
 * (se veía como parpadeos de un solo ojo); un guiño a propósito dura más.
 *
 * Además, en un guiño la cámara "mezcla" los ojos: el que está abierto se ve algo cerrado
 * (y, con un rango de ojos estrecho, el cerrado no llega a 1). Cuando un ojo se cierra de
 * verdad (más de 0,4–0,6) y el otro bastante menos, el menos cerrado se abre en proporción a
 * la diferencia. Trabaja con cuánto está cerrado cada ojo (0–1, ya con los umbrales).
 */
export class WinkGate {
  private run = 0;
  private side: "left" | "right" | null = null;
  private minSamples: number;
  /** Diferencia entre los ojos desde la que uno cuenta como más cerrado. */
  private threshold: number;

  constructor(minSamples = 4, threshold = 0.08) {
    this.minSamples = minSamples;
    this.threshold = threshold;
  }

  filter(left: number, right: number): [number, number] {
    const both = Math.min(left, right); // lo que cierran los dos juntos: se muestra siempre
    const diff = Math.abs(left - right);
    const side = diff > this.threshold ? (left > right ? "left" : "right") : null;
    this.run = side && side === this.side ? this.run + 1 : side ? 1 : 0;
    this.side = side;
    if (!side || this.run < this.minSamples) return [both, both];
    // Guiño sostenido: el ojo más cerrado tal cual; el otro, abierto en proporción a la
    // diferencia si el primero se cerró de verdad (la cámara mezcla los ojos al guiñar).
    const hi = Math.max(left, right);
    const strength = Math.min(1, Math.max(0, (hi - 0.4) / 0.2));
    const lo = both * (1 - strength * Math.min(1, diff / 0.4));
    return side === "left" ? [left, lo] : [lo, right];
  }

  reset() {
    this.run = 0;
    this.side = null;
  }
}
