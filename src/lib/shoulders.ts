// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Ancho de los hombros a partir de los puntos de MediaPipe Pose (Fase 1B). Separado de
// tracking.ts para poder probarlo sin cámara ni MediaPipe (npm run test:body).

import type { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";

/** Hombros en los puntos de MediaPipe Pose. */
const LEFT_SHOULDER = 11;
const RIGHT_SHOULDER = 12;
/** Por debajo de esta confianza, el hombro se considera tapado o fuera del cuadro. */
const MIN_VISIBILITY = 0.6;
/** Distancia mínima al borde de la imagen: un hombro cortado por el borde da un ancho falso. */
const EDGE_MARGIN = 0.02;
/** Con el torso más girado que esto (coseno), el ancho corregido ya no es fiable. */
const MIN_FACING = 0.6;

/**
 * Ancho de los hombros en la imagen, en altos de imagen (no cambia con la resolución),
 * dividido por el coseno del giro del torso (los puntos 3D de Pose): al girarte los hombros
 * se ven más angostos, y sin esto parecería que te alejas. `null` si no se ven bien.
 */
export function shoulderWidth(
  image: NormalizedLandmark[] | undefined,
  world: Landmark[] | undefined,
  aspect: number,
): number | null {
  const l = image?.[LEFT_SHOULDER];
  const r = image?.[RIGHT_SHOULDER];
  const wl = world?.[LEFT_SHOULDER];
  const wr = world?.[RIGHT_SHOULDER];
  if (!l || !r || !wl || !wr || !Number.isFinite(aspect) || aspect <= 0) return null;
  const visible = (p: NormalizedLandmark) =>
    (p.visibility ?? 1) >= MIN_VISIBILITY &&
    p.x > EDGE_MARGIN && p.x < 1 - EDGE_MARGIN && p.y > EDGE_MARGIN && p.y < 1 - EDGE_MARGIN;
  if (!visible(l) || !visible(r)) return null;
  const width = Math.hypot((l.x - r.x) * aspect, l.y - r.y);
  const flat = Math.hypot(wl.x - wr.x, wl.y - wr.y);
  const full = Math.hypot(flat, wl.z - wr.z);
  const facing = full > 0 ? flat / full : 0;
  if (facing < MIN_FACING || width <= 0) return null;
  return width / facing;
}
