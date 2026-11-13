// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Compara el suavizado del tracking de la cabeza: el anterior (exponencial fijo por cuadro)
// contra el filtro One Euro (avatar/one-euro.ts) + interpolación entre muestras.
// Simula el tracking real: muestras a 30 por segundo con temblor (ruido), dibujadas a
// 60 cuadros por segundo. Mide el temblor que queda con la cabeza quieta y el retraso
// en un giro rápido.
// Uso: npm run test:smoothing   (Node 22.18 o más nuevo)

import { OneEuroFilter, SoftDeadband, type OneEuroParams } from "../avatar/one-euro.ts";

const SAMPLE_HZ = 30;
const FRAME_HZ = 60;
/** Temblor del tracking con la cabeza quieta (rad): ~0,6°, como MediaPipe con poca luz. */
const NOISE = 0.01;

/** Ruido gaussiano reproducible (misma secuencia en cada ejecución). */
function noise(seed: number) {
  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  return () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
}

interface Result {
  jitter: number; // desviación del resultado con la cabeza quieta (rad)
  lag: number; // segundos hasta llegar al 90 % de un giro rápido
  overshoot: number; // cuánto se pasa del destino (rad)
}

/**
 * `perSample`: filtro aplicado a cada muestra que llega (o identidad).
 * `frameRate`: suavizado exponencial por cuadro (como hacía applyTracking).
 */
function simulate(perSample: ((x: number, t: number) => number) | null, frameRate: number, motion: (t: number) => number, seed: number) {
  const gauss = noise(seed);
  let target = motion(0);
  let shown = target;
  let nextSample = 0;
  const out: [number, number][] = [];
  for (let frame = 0; frame < FRAME_HZ * 4; frame++) {
    const t = frame / FRAME_HZ;
    while (nextSample <= t) {
      const measured = motion(nextSample) + gauss() * NOISE;
      target = perSample ? perSample(measured, nextSample) : measured;
      nextSample += 1 / SAMPLE_HZ;
    }
    shown += (target - shown) * (1 - Math.exp(-frameRate / FRAME_HZ));
    out.push([t, shown]);
  }
  return out;
}

function measure(make: () => ((x: number, t: number) => number) | null, frameRate: number): Result {
  // Quieto: desviación del resultado después de estabilizarse.
  const still = simulate(make(), frameRate, () => 0, 7).filter(([t]) => t > 1);
  const mean = still.reduce((s, [, y]) => s + y, 0) / still.length;
  const jitter = Math.sqrt(still.reduce((s, [, y]) => s + (y - mean) ** 2, 0) / still.length);
  // Giro rápido: 0,5 rad (~30°) en 0,2 s, empezando en t = 1 s.
  const turn = (t: number) => (t < 1 ? 0 : t > 1.2 ? 0.5 : 0.5 * ((t - 1) / 0.2));
  let lag = Infinity;
  let overshoot = 0;
  for (const seed of [11, 12, 13]) {
    const run = simulate(make(), frameRate, turn, seed);
    const reached = run.find(([t, y]) => t >= 1 && y >= 0.45);
    lag = Math.min(lag, reached ? reached[0] - 1.2 : Infinity);
    overshoot = Math.max(overshoot, ...run.map(([, y]) => y - 0.5));
  }
  return { jitter, lag: Math.max(0, lag), overshoot: Math.max(0, overshoot) };
}

const oneEuro = (p: OneEuroParams) => () => {
  const f = new OneEuroFilter(p);
  return (x: number, t: number) => f.filter(x, t);
};

const fmt = (r: Result) =>
  `temblor ${(r.jitter * 57.3).toFixed(2)}°  retraso ${(r.lag * 1000).toFixed(0)} ms  se pasa ${(r.overshoot * 57.3).toFixed(1)}°`;

const before = measure(() => null, 18);
console.log(`anterior (exponencial 18/s):        ${fmt(before)}`);

if (process.env.SWEEP) {
  for (const minCutoff of [0.5, 0.8, 1, 1.5, 2]) {
    for (const beta of [0.3, 0.6, 1, 2, 4]) {
      for (const frame of [30, 45]) {
        console.log(`one euro mc ${minCutoff} β ${beta} cuadro ${frame}/s: ${fmt(measure(oneEuro({ minCutoff, beta }), frame))}`);
      }
    }
  }
}

// Parámetros elegidos (los mismos que usa avatar/main.ts para la cabeza).
const { HEAD_FILTER, FRAME_INTERPOLATION, HEAD_DEADBAND } = await import("../avatar/smoothing.ts");
// Lo que usa avatar/main.ts: One Euro y después la zona muerta suave.
const pipeline = () => {
  const f = new OneEuroFilter(HEAD_FILTER);
  const d = new SoftDeadband(HEAD_DEADBAND);
  return (x: number, t: number) => d.filter([f.filter(x, t)])[0];
};
const after = measure(pipeline, FRAME_INTERPOLATION);
console.log(`One Euro (${HEAD_FILTER.minCutoff} Hz, β ${HEAD_FILTER.beta}) + zona muerta ${(HEAD_DEADBAND * 57.3).toFixed(1)}° + ${FRAME_INTERPOLATION}/s: ${fmt(after)}`);

// "Tirones" con la cabeza quieta (lo que veía el usuario): 60 s de ruido normal y, cada
// ~7 s, un salto de 1° durante 2 muestras (p. ej. el ángulo estimado cambia al parpadear).
// Se cuentan los cuadros en que el avatar se aparta más de 0,2° de su posición de reposo.
function twitches(make: () => ((x: number, t: number) => number) | null, frameRate: number): number {
  const gauss = noise(21);
  const per = make();
  let target = 0, shown = 0, next = 0, visible = 0;
  for (let frame = 0; frame < FRAME_HZ * 60; frame++) {
    const t = frame / FRAME_HZ;
    while (next <= t) {
      const k = Math.round(next * SAMPLE_HZ);
      const jump = k % 210 === 100 || k % 210 === 101 ? 1 / 57.3 : 0;
      const measured = gauss() * NOISE + jump;
      target = per ? per(measured, next) : measured;
      next += 1 / SAMPLE_HZ;
    }
    shown += (target - shown) * (1 - Math.exp(-frameRate / FRAME_HZ));
    if (t > 2 && Math.abs(shown) > 0.2 / 57.3) visible++;
  }
  return visible;
}
const twBefore = twitches(() => null, 18);
const twEuro = twitches(oneEuro(HEAD_FILTER), FRAME_INTERPOLATION);
const twAfter = twitches(pipeline, FRAME_INTERPOLATION);
console.log(`tirones en 60 s quieto (cuadros con más de 0,2° de movimiento): anterior ${twBefore} · One Euro ${twEuro} · One Euro + zona muerta ${twAfter}`);

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "ok " : "✗  "} ${name}`);
  if (!ok) failures++;
};
check("temblor con la cabeza quieta: menos de la mitad que antes", after.jitter < before.jitter / 2);
check("retraso en un giro rápido: no mayor que antes (+10 ms)", after.lag <= before.lag + 0.01);
check("no se pasa del destino más de 1°", after.overshoot < 1 / 57.3);
check("tirones con la cabeza quieta: menos de la mitad que solo con One Euro", twAfter < twEuro / 2);
const db = new SoftDeadband(1);
check("zona muerta: cambios chicos no mueven, grandes siguen desde el borde", db.filter([0])[0] === 0 && db.filter([0.8])[0] === 0 && db.filter([3])[0] === 2);
// El filtro solo, con valores puntuales.
const f = new OneEuroFilter({ minCutoff: 1, beta: 0 });
check("la primera muestra pasa tal cual", f.filter(3, 0) === 3);
check("misma marca de tiempo: mantiene el valor", f.filter(10, 0) === 3);
f.reset();
check("después de reset, empieza de nuevo", f.filter(-2, 5) === -2);
if (failures) {
  console.error(`\n${failures} comprobaciones fallaron`);
  process.exit(1);
}
console.log("\nOK");
