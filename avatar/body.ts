// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Cuerpo base (Fase 1B): separa **inclinarse hacia el frente** de **acercarse a la cámara**.
//
// Con solo la cara no se distinguen: en los dos casos la cara se acerca. Los hombros sí:
//  - al acercarte, la cara se acerca y los hombros se ven más anchos en la misma proporción;
//  - al inclinarte, la cara se acerca pero los hombros casi no cambian.
// Por eso «distancia de la cara × ancho de los hombros» (la *proporción*) no cambia al
// acercarte ni al alejarte, y baja al inclinarte. Es una medida de tu cuerpo, no de la
// distancia: se guarda al calibrar (paso 1, de frente) o, sin calibración, se aprende sola.
// Con ella: distancia del cuerpo = proporción ÷ ancho de los hombros, e inclinación = cuánto
// está la cara por delante del cuerpo.
//
// Plan B, cuando no se ven los hombros (fuera del cuadro, tapados, poca luz): un movimiento
// de la cara es inclinación al principio y, si se mantiene, pasa poco a poco a acercamiento.

export interface BodyResult {
  /** Distancia del cuerpo a la cámara (cm). */
  bodyDistance: number;
  /** Cuánto está la cara por delante del cuerpo (cm; + = inclinado hacia la cámara). */
  lean: number;
  /** De dónde salió: de los hombros o del plan B. */
  source: "shoulders" | "face";
}

/** Plan B: en cuánto tiempo (s) una inclinación mantenida pasa a ser acercamiento. */
export const FACE_ONLY_SETTLE_S = 3;
/**
 * Sin calibración, la proporción se aprende de la postura: sube rápido (al enderezarte) y
 * baja muy despacio (una inclinación larga no debe tomarse como tu postura normal).
 */
export const RATIO_RISE_S = 2;
export const RATIO_FALL_S = 30;
/** Al cambiar de fuente (hombros ↔ plan B), la distancia del cuerpo pasa de una a otra en este tiempo (s). */
export const SOURCE_BLEND_S = 0.4;
/** Límites de la inclinación (cm): hacia atrás casi no hay; hacia adelante, una inclinación grande. */
export const LEAN_MIN = -8;
export const LEAN_MAX = 35;

export class BodyEstimator {
  /** Proporción calibrada (paso 1); si no hay, se aprende. */
  private calibrated: number | null = null;
  private learned: number | null = null;
  /** Plan B: distancia del cuerpo que sigue despacio a la de la cara. */
  private slow: number | null = null;
  private output: number | null = null;
  private lastTime: number | null = null;

  /** Proporción de la calibración (`null` = aprenderla). */
  setCalibration(ratio: number | null) {
    this.calibrated = ratio !== null && Number.isFinite(ratio) && ratio > 0 ? ratio : null;
  }

  /**
   * Al cortarse el tracking. La proporción aprendida se conserva: es una medida de tu cuerpo
   * y no cambia porque salgas un momento del cuadro.
   */
  reset() {
    this.slow = null;
    this.output = null;
    this.lastTime = null;
  }

  /** Proporción en uso, o `null` si todavía no hay. */
  get ratio(): number | null {
    return this.calibrated ?? this.learned;
  }

  /**
   * @param faceDistance distancia de la cara a la cámara (cm, positiva)
   * @param shoulders ancho de los hombros (en altos de imagen, corregido por el giro del torso), o `null`
   * @param time segundos
   */
  update(faceDistance: number, shoulders: number | null, time: number): BodyResult {
    const dt = this.lastTime === null ? 0 : Math.max(0, Math.min(0.5, time - this.lastTime));
    this.lastTime = time;
    const follow = (from: number, to: number, tau: number) => from + (to - from) * (1 - Math.exp(-dt / tau));

    let target: number;
    let source: BodyResult["source"];
    if (shoulders !== null && shoulders > 0) {
      const r = faceDistance * shoulders;
      if (this.calibrated === null) {
        if (this.learned === null) this.learned = r;
        else this.learned = follow(this.learned, r, r > this.learned ? RATIO_RISE_S : RATIO_FALL_S);
      }
      target = this.ratio! / shoulders;
      this.slow = target; // si se dejan de ver los hombros, el plan B sigue desde aquí
      source = "shoulders";
    } else {
      this.slow = this.slow === null ? faceDistance : follow(this.slow, faceDistance, FACE_ONLY_SETTLE_S);
      target = this.slow;
      source = "face";
    }
    // Pasar suave de una fuente a otra (y suavizar el ruido de la medida de los hombros).
    this.output = this.output === null ? target : follow(this.output, target, SOURCE_BLEND_S / 4);
    const lean = Math.max(LEAN_MIN, Math.min(LEAN_MAX, this.output - faceDistance));
    return { bodyDistance: faceDistance + lean, lean, source };
  }
}
