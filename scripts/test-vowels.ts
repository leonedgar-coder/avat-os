// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Prueba del reconocimiento de vocales (src/lib/vowels.ts) con vocales sintéticas:
// pulsos de la "voz" filtrados por resonadores en los formantes típicos del español
// (Quilis), de voces graves a agudas, analizadas en muchas ventanas distintas.
// Uso: npm run test:vowels   (Node 22.18 o más nuevo: ejecuta TypeScript directamente)

import { VOWEL_LETTERS, VowelAnalyzer, buildTemplates, closeTemplates, isVowelTemplates } from "../src/lib/vowels.ts";

const RATE = 48000;
/** F1, F2, F3 (Hz) de una voz grave. */
const VOWELS: Record<string, [number, number, number]> = {
  A: [700, 1300, 2500],
  E: [450, 1900, 2550],
  I: [300, 2300, 3000],
  O: [500, 900, 2450],
  U: [325, 700, 2400],
};
/**
 * Voces: tono (Hz) y cuánto más altos son sus formantes que los de la tabla. Los
 * formantes suben con el tono como (tono / 120) ^ 0,32 (medido en voces de Windows:
 * a 210 Hz, ~27 % más altos que a 100 Hz). Cada voz se prueba además con formantes
 * un 6 % más bajos y más altos de lo esperado: no hay dos personas iguales.
 */
const VOICES: [f0: number, scale: number, adult: boolean][] = [];
for (const [f0, adult] of [[110, true], [130, true], [180, true], [220, true], [260, true], [300, false]] as const) {
  for (const dev of [0.94, 1, 1.06]) VOICES.push([f0, (f0 / 120) ** 0.32 * dev, adult]);
}

function synth([f1, f2, f3]: [number, number, number], f0: number, scale: number, f2Bandwidth = 110, noise = 0): Float64Array {
  const n = RATE;
  let x = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    phase += (f0 * (1 + 0.03 * Math.sin(i / 2000))) / RATE; // un poco de vibrato
    if (phase >= 1) {
      phase -= 1;
      x[i] = 1;
    }
  }
  for (const p of [0.97, 0.97]) {
    // pulso glotal suavizado (los agudos de la voz caen ~12 dB por octava)
    let y = 0;
    for (let i = 0; i < n; i++) x[i] = y = x[i] + p * y;
  }
  for (const [fc, bw] of [[f1 * scale, 90], [f2 * scale, f2Bandwidth], [f3 * scale, 160]]) {
    const r = Math.exp((-Math.PI * bw) / RATE);
    const c = 2 * r * Math.cos((2 * Math.PI * fc) / RATE);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = x[i] + c * (y[i - 1] ?? 0) - r * r * (y[i - 2] ?? 0);
    x = y;
  }
  if (noise) {
    let peak = 0;
    for (const v of x) peak = Math.max(peak, Math.abs(v));
    let seed = 9;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      x[i] += (seed / 4294967296 - 0.5) * 2 * noise * peak;
    }
  }
  return x;
}

let failures = 0;
for (const [f0, scale, adult] of VOICES) {
  // Un analizador por voz: el tono medio es el de una persona (en la app no cambia de golpe).
  const analyzer = new VowelAnalyzer(RATE);
  const row: string[] = [];
  for (const [vowel, formants] of Object.entries(VOWELS)) {
    const x = synth(formants, f0, scale);
    const counts: Record<string, number> = {};
    let windows = 0;
    for (let off = 4800; off + 2048 < x.length; off += 1500, windows++) {
      const r = analyzer.analyze(Float32Array.from(x.subarray(off, off + 2048)));
      const got = r?.weights ? VOWEL_LETTERS[r.weights.indexOf(Math.max(...r.weights))] : "-";
      counts[got] = (counts[got] ?? 0) + 1;
    }
    const wrong = Object.entries(counts).filter(([k]) => k !== vowel && k !== "-").reduce((s, [, n]) => s + n, 0);
    const right = counts[vowel] ?? 0;
    // Adultos: a lo sumo 1 ventana de cada 10 equivocada (una medición suelta casi no se
    // ve: el lip-sync y el avatar suavizan) y reconocida en al menos la mitad (en las demás
    // no hay resultado y la boca mantiene la forma anterior).
    const ok = !adult || (wrong <= windows / 10 && right >= windows / 2);
    if (!ok) failures++;
    row.push(`${vowel}:${right}/${windows}${wrong ? ` (${Object.entries(counts).filter(([k]) => k !== vowel && k !== "-").map(([k, n]) => `${n}→${k}`).join(",")})` : ""}${ok ? "" : " ✗"}`);
  }
  console.log(`${adult ? "adulto" : "niño  "} ${String(f0).padStart(3)} Hz ×${scale.toFixed(2)}  ${row.join("  ")}`);
}
// --- Calibración de vocales (plantillas: forma del espectro en escala mel) ---
function check(name: string, ok: boolean) {
  console.log(`${ok ? "ok " : "✗  "} ${name}`);
  if (!ok) failures++;
}
/**
 * Una persona "como la del usuario": voz grave (115 Hz) y un micrófono con el que la F2 de
 * la A, la O y la U llega débil (banda ancha) y con algo de ruido. Con los formantes, esa F2
 * se perdía y se tomaba la F3: la U y la O quedaban casi iguales (medido en un perfil real).
 */
function personBlocks(vowel: string, wideF2: boolean, from: number, count: number): Float32Array[] {
  const back = vowel === "A" || vowel === "O" || vowel === "U";
  const x = synth(VOWELS[vowel], 115, 1, back && wideF2 ? 450 : 110, 0.03);
  return Array.from({ length: count }, (_, k) => Float32Array.from(x.subarray(4800 + (from + k) * 700, 4800 + (from + k) * 700 + 2048)));
}
for (const wideF2 of [false, true]) {
  const an = new VowelAnalyzer(RATE);
  // Calibrar: 25 bloques de cada vocal.
  const shapes = VOWEL_LETTERS.map((v) => personBlocks(v, wideF2, 0, 25).map((b) => an.analyze(b)?.shape).filter((m): m is number[] => !!m));
  const templates = buildTemplates(shapes);
  // Reconocer otros 25 bloques de cada vocal, sin plantillas (formantes típicos) y con ellas.
  const score = (useTemplates: boolean) => {
    const a2 = new VowelAnalyzer(RATE);
    a2.templates = useTemplates ? templates : null;
    let ok = 0, total = 0;
    for (const v of VOWEL_LETTERS) {
      for (const b of personBlocks(v, wideF2, 25, 25)) {
        const r = a2.analyze(b);
        total++;
        if (r?.weights && VOWEL_LETTERS[r.weights.indexOf(Math.max(...r.weights))] === v) ok++;
      }
    }
    return ok / total;
  };
  const before = score(false);
  const after = score(true);
  const label = wideF2 ? "F2 débil en A/O/U (como el micrófono del usuario)" : "voz normal";
  console.log(`plantillas, ${label}: formantes típicos ${(before * 100).toFixed(0)} % → plantillas ${(after * 100).toFixed(0)} %`);
  check(`con plantillas, ${label}: al menos 95 % bien`, after >= 0.95);
  check(`plantillas bien separadas (${label}): sin avisos`, closeTemplates(templates).length === 0);
  if (wideF2) check("con F2 débil, las plantillas aciertan más que los formantes", after > before);
}
// La entonación cambia el tono todo el tiempo: calibrar a 115 Hz y hablar a 132 Hz (+15 %).
{
  const pitched = (v: string, f0: number, from: number, count: number) => {
    const back = v === "A" || v === "O" || v === "U";
    const x = synth(VOWELS[v], f0, 1, back ? 450 : 110, 0.03);
    return Array.from({ length: count }, (_, k) => Float32Array.from(x.subarray(4800 + (from + k) * 700, 4800 + (from + k) * 700 + 2048)));
  };
  const an = new VowelAnalyzer(RATE);
  const t = buildTemplates(VOWEL_LETTERS.map((v) => pitched(v, 115, 0, 25).map((b) => an.analyze(b)?.shape).filter((m): m is number[] => !!m)));
  const a2 = new VowelAnalyzer(RATE);
  a2.templates = t;
  let ok = 0, total = 0;
  for (const v of VOWEL_LETTERS) for (const b of pitched(v, 132, 25, 20)) {
    const r = a2.analyze(b);
    total++;
    if (r?.weights && VOWEL_LETTERS[r.weights.indexOf(Math.max(...r.weights))] === v) ok++;
  }
  console.log(`plantillas con el tono 15 % más alto que al calibrar: ${((ok / total) * 100).toFixed(0)} %`);
  check("tono 15 % más alto que al calibrar: al menos 95 % bien", ok / total >= 0.95);
}
// U y O cercanas (como en la voz del usuario: con el cepstrum lineal quedaron a 1,4 y se
// confundían). Con la forma en escala mel deben separarse y reconocerse.
{
  const near: Record<string, [number, number, number]> = { ...VOWELS, O: [430, 830, 2450], U: [370, 780, 2400] };
  const blocksOf = (v: string, f0: number, from: number, count: number) => {
    const x = synth(near[v], f0, 1, v === "A" || v === "O" || v === "U" ? 300 : 110, 0.02);
    return Array.from({ length: count }, (_, k) => Float32Array.from(x.subarray(4800 + (from + k) * 700, 4800 + (from + k) * 700 + 2048)));
  };
  const an = new VowelAnalyzer(RATE);
  const t = buildTemplates(VOWEL_LETTERS.map((v) => blocksOf(v, 120, 0, 25).map((b) => an.analyze(b)?.shape).filter((m): m is number[] => !!m)));
  const a2 = new VowelAnalyzer(RATE);
  a2.templates = t;
  let ok = 0, mixed = 0, total = 0;
  for (const v of ["U", "O"]) for (const f0 of [120, 132]) for (const b of blocksOf(v, f0, 25, 20)) {
    const r = a2.analyze(b);
    total++;
    const got = r?.weights ? VOWEL_LETTERS[r.weights.indexOf(Math.max(...r.weights))] : "-";
    if (got === v) ok++;
    else if (got === "U" || got === "O") mixed++;
  }
  console.log(`U y O cercanas: bien ${((ok / total) * 100).toFixed(0)} %, confundidas entre sí ${((mixed / total) * 100).toFixed(0)} %`);
  check("U y O cercanas: no se avisan como parecidas (quedan separadas)", closeTemplates(t).length === 0);
  check("U y O cercanas: al menos 95 % bien y ninguna confundida", ok / total >= 0.95 && mixed === 0);
}
// Aviso de vocales parecidas: dos plantillas casi iguales.
{
  const an = new VowelAnalyzer(RATE);
  const sameAsO = VOWEL_LETTERS.map((v) => personBlocks(v === "U" ? "O" : v, false, 0, 25).map((b) => an.analyze(b)?.shape).filter((m): m is number[] => !!m));
  const pairs = closeTemplates(buildTemplates(sameAsO));
  check("U dicha igual que la O: avisa ese par", pairs.some(([i, j]) => [VOWEL_LETTERS[i], VOWEL_LETTERS[j]].sort().join("") === "OU"));
}
{
  const an = new VowelAnalyzer(RATE);
  const t = buildTemplates(VOWEL_LETTERS.map((v) => personBlocks(v, false, 0, 10).map((b) => an.analyze(b)!.shape!)));
  check("plantillas válidas", isVowelTemplates(t));
  check("plantillas dañadas o de otra versión: se ignoran", !isVowelTemplates(null) && !isVowelTemplates({ means: [[1]], scale: [1] }) && !isVowelTemplates({ ...t, scale: t.scale.map(() => 0) }));
}

if (failures) {
  console.error(`\n${failures} vocales fallaron`);
  process.exit(1);
}
console.log("\nOK");
