// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Parpadeos falsos: simula el valor de párpado de MediaPipe con los ojos abiertos (ruido
// y picos sueltos) y parpadeos de verdad, con umbrales de una calibración real de rango
// estrecho (abierto 0,176; empieza a cerrar en 0,196 y cierra del todo en 0,247).
// Compara sin y con SpikeFilter (avatar/spike-filter.ts).
// Uso: npm run test:blink   (Node 22.18 o más nuevo)

import { SpikeFilter, WinkGate } from "../avatar/spike-filter.ts";

const OPEN_LEVEL = 0.176;
const CLOSED_LEVEL = 0.268;
const THRESHOLDS: [number, number] = [0.196, 0.247];
const NOISE = 0.008; // ruido normal con el ojo abierto
const SPIKE_EVERY = 25; // un pico suelto cada ~0,8 s (30 muestras por segundo)
const SPIKE = 0.045;

let seed = 3;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const closedness = (v: number) => Math.min(1, Math.max(0, (v - THRESHOLDS[0]) / (THRESHOLDS[1] - THRESHOLDS[0])));

/** 30 s de ojos abiertos con ruido, picos sueltos y un parpadeo real (4 muestras) cada 3 s. */
function signal(): { v: number; blink: boolean }[] {
  const out: { v: number; blink: boolean }[] = [];
  for (let i = 0; i < 900; i++) {
    const inBlink = i % 90 >= 45 && i % 90 < 49;
    let v = OPEN_LEVEL + gauss() * NOISE;
    if (!inBlink && i % SPIKE_EVERY === 7) v += SPIKE;
    if (inBlink) v = CLOSED_LEVEL + gauss() * NOISE;
    out.push({ v, blink: inBlink });
  }
  return out;
}

function run(useFilter: boolean) {
  const f = new SpikeFilter();
  let falseFrames = 0;
  let blinksSeen = 0;
  let inBlinkMax = 0;
  const s = signal();
  s.forEach(({ v, blink }, i) => {
    const c = closedness(useFilter ? f.filter(v) : v);
    // Con filtro, el parpadeo llega una muestra después: se mira hasta 1 muestra más tarde.
    const nearBlink = blink || s[i - 1]?.blink;
    if (!nearBlink && c > 0.3) falseFrames++;
    if (nearBlink) inBlinkMax = Math.max(inBlinkMax, c);
    if (blink && !s[i + 1]?.blink) {
      if (inBlinkMax > 0.9) blinksSeen++;
      inBlinkMax = 0;
    }
  });
  return { falseFrames, blinksSeen, blinks: s.filter((x, i) => x.blink && !s[i + 1]?.blink).length };
}

const before = run(false);
const after = run(true);
console.log(`sin filtro: ${before.falseFrames} cuadros con el ojo medio cerrado sin parpadear; parpadeos reales completos ${before.blinksSeen}/${before.blinks}`);
console.log(`con filtro: ${after.falseFrames} cuadros con el ojo medio cerrado sin parpadear; parpadeos reales completos ${after.blinksSeen}/${after.blinks}`);

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "ok " : "✗  "} ${name}`);
  if (!ok) failures++;
};
check("sin filtro se reproducen los parpadeos falsos", before.falseFrames > 10);
check("con filtro, ningún parpadeo falso por picos sueltos", after.falseFrames === 0);
check("con filtro, todos los parpadeos reales se ven completos", after.blinksSeen === after.blinks);
// --- Guiños (WinkGate): ruido en un solo ojo frente a parpadeos y guiños de verdad ---
// Secuencias de "cuánto está cerrado" cada ojo (0–1), una muestra cada ~33 ms.
function gate(seq: [number, number][]): [number, number][] {
  const g = new WinkGate();
  return seq.map(([l, r]) => g.filter(l, r));
}
const open: [number, number] = [0, 0];
const rep_ = (v: [number, number], n: number) => Array.from({ length: n }, () => v);
// Ruido de 2 y de 3 muestras en un solo ojo (lo que veía el usuario): no debe verse.
const noise = gate([...rep_(open, 5), ...rep_([0.8, 0], 2), ...rep_(open, 5), ...rep_([0, 0.9], 3), ...rep_(open, 5)]);
check("ruido de 2–3 muestras en un ojo: no se ve", noise.every(([l, r]) => l === 0 && r === 0));
// Parpadeo real: los dos ojos a la vez, se ve al instante (aunque un ojo se adelante una muestra).
const blink = gate([...rep_(open, 3), [1, 0], ...rep_([1, 1], 3), ...rep_(open, 3)]);
check("parpadeo de los dos ojos: se ve al instante", blink[4][0] === 1 && blink[4][1] === 1);
// Guiño a propósito (~300 ms): se ve después de 4 muestras y mientras dure.
const wink = gate([...rep_(open, 3), ...rep_([1, 0], 10), ...rep_(open, 3)]);
check("guiño sostenido: se ve (desde la 4.ª muestra)", wink[5][0] === 0 && wink[6][0] === 1 && wink[12][0] === 1 && wink.every(([, r]) => r === 0));

// Guiño con la señal débil del usuario (rango de ojos estrecho y la cámara "mezcla" los ojos):
// el ojo cerrado no llega a 1 y el abierto se cierra un poco. Debe verse como guiño.
const weak = gate([...rep_(open, 3), ...rep_([0.6, 0.35], 10), ...rep_(open, 3)]);
check("guiño con señal débil (0,6 frente a 0,35): se ve el guiño", weak[8][0] >= 0.6 && weak[8][1] <= 0.15);
const strongMix = gate([...rep_(open, 3), ...rep_([1, 0.6], 10), ...rep_(open, 3)]);
check("guiño con mezcla (1 frente a 0,6): el ojo abierto queda abierto", strongMix[8][0] === 1 && strongMix[8][1] <= 0.25);
// Una asimetría chica y sostenida (un ojo un poco más cerrado de natural) no cierra el otro ojo.
const natural = gate(rep_([0.15, 0.05], 12));
check("asimetría natural chica: se muestra tal cual, sin exagerarla", Math.abs(natural[10][0] - 0.15) < 0.06 && natural[10][1] >= 0);

const f = new SpikeFilter();
check("mediana de 3", [0.1, 0.9, 0.2].map((v) => f.filter(v)).at(-1) === 0.2);
f.reset();
check("después de reset, la primera muestra pasa tal cual", f.filter(0.7) === 0.7);
if (failures) {
  console.error(`\n${failures} comprobaciones fallaron`);
  process.exit(1);
}
console.log("\nOK");
