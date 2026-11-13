// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Filtro "One Euro" (Casiez, Roussel y Vogel, CHI 2012): quita el temblor del tracking
// sin agregar retraso a los movimientos rápidos. Es un suavizado cuya fuerza depende de
// la velocidad: quieto, filtra mucho (el temblor es pequeño y rápido, y desaparece);
// en movimiento, filtra poco (lo que importa es seguir el gesto sin quedarse atrás).
// Frecuencia de corte = minCutoff + beta · |velocidad|.

export interface OneEuroParams {
  /** Frecuencia de corte en reposo (Hz). Más baja = menos temblor, más retraso al empezar a moverse. */
  minCutoff: number;
  /** Cuánto sube la frecuencia de corte con la velocidad. Más alta = menos retraso en movimientos rápidos. */
  beta: number;
  /** Frecuencia de corte para estimar la velocidad (Hz). */
  dCutoff?: number;
}

/** Peso de la muestra nueva en un suavizado exponencial con esa frecuencia de corte. */
function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private t = 0;
  private params: OneEuroParams;

  constructor(params: OneEuroParams) {
    this.params = params;
  }

  /** Filtra el valor `value` medido en el instante `time` (segundos). */
  filter(value: number, time: number): number {
    if (this.x === null) {
      this.x = value;
      this.t = time;
      return value;
    }
    const dt = time - this.t;
    if (dt <= 0) return this.x; // misma muestra o reloj hacia atrás: se mantiene
    this.t = time;
    const rawSpeed = (value - this.x) / dt;
    this.dx += (rawSpeed - this.dx) * alpha(this.params.dCutoff ?? 1, dt);
    const cutoff = this.params.minCutoff + this.params.beta * Math.abs(this.dx);
    this.x += (value - this.x) * alpha(cutoff, dt);
    return this.x;
  }

  /** Olvida lo anterior (por ejemplo, si se perdió el tracking y la cara reaparece en otro lado). */
  reset() {
    this.x = null;
    this.dx = 0;
  }
}

/** Un filtro por componente para vectores (rotación de la cabeza, posición, mirada). */
export class OneEuroVector {
  private filters: OneEuroFilter[];

  constructor(size: number, params: OneEuroParams) {
    this.filters = Array.from({ length: size }, () => new OneEuroFilter(params));
  }

  filter(values: readonly number[], time: number): number[] {
    return values.map((v, i) => this.filters[i].filter(v, time));
  }

  reset() {
    this.filters.forEach((f) => f.reset());
  }
}

/**
 * Zona muerta suave: los cambios más chicos que `band` no mueven el resultado; los más
 * grandes sí, siguiendo desde el borde de la zona (sin saltos). Va después del One Euro:
 * quita los "tirones" pequeños que quedan con la cabeza quieta (saltos de la profundidad o
 * del ángulo al parpadear) sin agregar retraso a los movimientos de verdad.
 */
export class SoftDeadband {
  private held: number[] | null = null;
  private band: number;

  constructor(band: number) {
    this.band = band;
  }

  filter(values: readonly number[]): number[] {
    if (!this.held || this.held.length !== values.length) {
      this.held = [...values];
      return [...this.held];
    }
    const held = this.held;
    values.forEach((v, i) => {
      const d = v - held[i];
      if (Math.abs(d) > this.band) held[i] = v - Math.sign(d) * this.band;
    });
    return [...held];
  }

  reset() {
    this.held = null;
  }
}
