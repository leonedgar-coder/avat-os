// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Parámetros del suavizado del tracking (ver one-euro.ts). `npm run test:smoothing` los
// compara con el suavizado anterior (exponencial fijo de 18/s): con la cabeza quieta queda
// ~60 % menos temblor y en un giro rápido el avatar llega antes (67 frente a 83 ms).

import type { OneEuroParams } from "./one-euro";

/** Giro de la cabeza (radianes). */
export const HEAD_FILTER: OneEuroParams = { minCutoff: 0.5, beta: 2 };
/** Posición de la cabeza (cm), para la inclinación del cuerpo: se mueve más despacio. */
export const POSITION_FILTER: OneEuroParams = { minCutoff: 0.5, beta: 0.1 };
/** Mirada (−1 a 1): los ojos saltan rápido de un punto a otro, así que filtra menos en movimiento. */
export const GAZE_FILTER: OneEuroParams = { minCutoff: 1, beta: 4 };
/**
 * Interpolación por cuadro (1/s): el tracking llega ~30 veces por segundo y se dibuja a
 * ~60; esto solo une las muestras ya filtradas para que el movimiento no vaya a saltos.
 */
export const FRAME_INTERPOLATION = 45;
/**
 * Zona muerta después del filtro (ver SoftDeadband): cambios más chicos se ignoran.
 * Cabeza: 0,5° (en radianes). Posición: 0,6 cm (la profundidad de MediaPipe salta más).
 */
export const HEAD_DEADBAND = 0.0087;
export const POSITION_DEADBAND = 0.6;
