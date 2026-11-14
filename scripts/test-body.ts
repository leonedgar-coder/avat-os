// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Cuerpo base (Fase 1B): inclinarse hacia el frente frente a acercarse a la cámara.
// Simula la distancia de la cara (cm) y el ancho de los hombros que darían MediaPipe Face y
// Pose (con su temblor), los pasa por los mismos filtros que la página del avatar y comprueba
// cuánto se acerca el avatar y cuánto se inclina. "Antes" = la versión de la Fase 1, donde todo
// acercamiento de la cara movía el avatar.
// Uso: npm run test:body   (Node 22.18 o más nuevo)

import { BodyEstimator, FACE_ONLY_SETTLE_S } from "../avatar/body.ts";
import { OneEuroFilter, OneEuroVector, SoftDeadband } from "../avatar/one-euro.ts";
import { POSITION_DEADBAND, POSITION_FILTER, SHOULDER_FILTER } from "../avatar/smoothing.ts";
import { shoulderWidth } from "../src/lib/shoulders.ts";

const RATE = 30;
const REST = 60; // cm: sentado frente a la cámara
const RATIO = 18; // distancia × ancho de hombros de esta persona (0,30 a 60 cm)

let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

/** Un instante de la escena: dónde está el cuerpo, cuánto se adelanta la cara, si se ven los hombros. */
interface Pose { body: number; lean: number; shoulders: boolean }

/** Pasa una escena por la cadena de la página del avatar; devuelve lo que vería en cada muestra. */
function run(scene: (t: number) => Pose, seconds: number, calibrated: number | null = RATIO) {
  const est = new BodyEstimator();
  est.setCalibration(calibrated);
  const faceFilter = new OneEuroVector(1, POSITION_FILTER);
  const shoulderFilter = new OneEuroFilter(SHOULDER_FILTER);
  const deadband = new SoftDeadband(POSITION_DEADBAND);
  const out: { t: number; body: number; lean: number; truth: Pose }[] = [];
  for (let i = 0; i < seconds * RATE; i++) {
    const t = i / RATE;
    const p = scene(t);
    const face = faceFilter.filter([p.body - p.lean + gauss() * 0.4], t)[0];
    let width: number | null = null;
    if (p.shoulders) width = shoulderFilter.filter((RATIO / p.body) * (1 + gauss() * 0.012), t);
    else shoulderFilter.reset();
    const r = est.update(face, width, t);
    const [body, lean] = deadband.filter([r.bodyDistance, r.lean]);
    out.push({ t, body, lean, truth: p });
  }
  return out;
}

let failures = 0;
function check(ok: boolean, text: string) {
  console.log(`${ok ? "ok " : "MAL"} ${text}`);
  if (!ok) failures++;
}
const f1 = (v: number) => v.toFixed(1);
/** Promedio de una medida entre dos instantes. */
const avg = (o: ReturnType<typeof run>, from: number, to: number, key: "body" | "lean") => {
  const s = o.filter((x) => x.t >= from && x.t < to);
  return s.reduce((a, x) => a + x[key], 0) / s.length;
};
/** Antes (Fase 1): el avatar se acercaba según la cara. */
const approachBefore = (lean: number) => (lean / REST) * 100;
const approachNow = (body: number) => ((REST - body) / REST) * 100;

console.log("--- Con los hombros a la vista ---");
{
  // Inclinarse 15 cm durante 4 s (de 1 a 5 s).
  const o = run((t) => ({ body: REST, lean: t >= 1 && t < 5 ? 15 : 0, shoulders: true }), 7);
  const body = avg(o, 2, 5, "body");
  const lean = avg(o, 2, 5, "lean");
  console.log(`   inclinarse 15 cm: el avatar se acerca ${f1(approachNow(body))} % (antes ${f1(approachBefore(15))} %) y se inclina ${f1(lean)} cm`);
  check(Math.abs(approachNow(body)) < 3, "inclinarse casi no acerca el avatar (menos de 3 %)");
  check(Math.abs(lean - 15) < 2, "la inclinación medida es la real (±2 cm)");
  check(Math.abs(avg(o, 6, 7, "lean")) < 1.5, "al enderezarse, la inclinación vuelve a 0");
}
{
  // Acercarse 15 cm (mover la silla) y quedarse.
  const o = run((t) => ({ body: t < 1 ? REST : t < 2 ? REST - 15 * (t - 1) : REST - 15, lean: 0, shoulders: true }), 6);
  const body = avg(o, 3, 6, "body");
  const lean = avg(o, 3, 6, "lean");
  console.log(`   acercarse 15 cm: el avatar se acerca ${f1(approachNow(body))} % (real ${f1(approachNow(REST - 15))} %) y se inclina ${f1(lean)} cm`);
  check(Math.abs(body - (REST - 15)) < 2, "acercarse sí acerca el avatar (±2 cm)");
  check(Math.abs(lean) < 2, "acercarse no se toma como inclinación (±2 cm)");
  // Durante el movimiento la inclinación falsa debe ser pequeña.
  const worst = Math.max(...o.filter((x) => x.t >= 1 && x.t < 3).map((x) => Math.abs(x.lean)));
  check(worst < 5, `mientras se acerca, inclinación falsa pequeña (máx. ${f1(worst)} cm)`);
}
{
  // Quieto: temblor de la distancia del avatar.
  const o = run(() => ({ body: REST, lean: 0, shoulders: true }), 10);
  const s = o.filter((x) => x.t > 2);
  const spread = Math.max(...s.map((x) => x.body)) - Math.min(...s.map((x) => x.body));
  const leanSpread = Math.max(...s.map((x) => x.lean)) - Math.min(...s.map((x) => x.lean));
  check(spread < 1.5 && leanSpread < 1.5, `quieto, sin temblor (distancia ±${f1(spread / 2)} cm, inclinación ±${f1(leanSpread / 2)} cm)`);
}

console.log(`--- Sin hombros (plan B: una inclinación mantenida pasa a acercamiento en ~${FACE_ONLY_SETTLE_S} s) ---`);
{
  // Inclinarse 15 cm 1 s: casi todo inclinación.
  const o = run((t) => ({ body: REST, lean: t >= 1 && t < 2 ? 15 : 0, shoulders: false }), 4);
  const peak = o.find((x) => x.t >= 1.5)!;
  console.log(`   inclinación corta (1 s): a los 0,5 s se inclina ${f1(peak.lean)} cm y se acerca ${f1(approachNow(peak.body))} % (antes ${f1(approachBefore(15))} %)`);
  check(peak.lean > 10, "una inclinación corta se ve como inclinación");
  check(approachNow(peak.body) < 7, "y acerca poco el avatar");
}
{
  // Acercarse 15 cm y quedarse: al final, acercamiento.
  const o = run((t) => ({ body: t < 1 ? REST : REST - 15, lean: 0, shoulders: false }), 16);
  const body = avg(o, 14, 16, "body");
  const lean = avg(o, 14, 16, "lean");
  console.log(`   acercarse 15 cm y quedarse: tras 13 s se acerca ${f1(approachNow(body))} % (real ${f1(approachNow(REST - 15))} %), inclinación ${f1(lean)} cm`);
  check(Math.abs(body - (REST - 15)) < 1.5 && Math.abs(lean) < 1.5, "al rato, acercamiento completo y sin inclinación");
}

console.log("--- Cambios entre hombros y plan B ---");
{
  // Inclinado 15 cm; los hombros desaparecen a los 3 s y vuelven a los 4 s.
  const o = run((t) => ({ body: REST, lean: t >= 1 ? 15 : 0, shoulders: !(t >= 3 && t < 4) }), 7);
  let jump = 0;
  for (let i = 1; i < o.length; i++) jump = Math.max(jump, Math.abs(o[i].body - o[i - 1].body));
  check(jump < 1.5, `sin saltos al perder o recuperar los hombros (máx. ${f1(jump)} cm por cuadro)`);
  check(Math.abs(avg(o, 5.5, 7, "body") - REST) < 2, "al volver los hombros, vuelve a la distancia real");
}

console.log("--- Sin calibración (la proporción se aprende) ---");
{
  // Empieza inclinado 10 cm 2 s, luego derecho; después se inclina 15 cm 3 s.
  const o = run((t) => ({ body: REST, lean: t < 2 ? 10 : t >= 10 && t < 13 ? 15 : 0, shoulders: true }), 14, null);
  const upright = avg(o, 7, 10, "lean");
  const leaning = avg(o, 11, 13, "lean");
  console.log(`   derecho tras empezar inclinado: inclinación ${f1(upright)} cm; luego inclinado 15 cm: ${f1(leaning)} cm, se acerca ${f1(approachNow(avg(o, 11, 13, "body")))} %`);
  check(Math.abs(upright) < 2, "aprende tu postura aunque empieces inclinado");
  check(leaning > 11, "y después distingue la inclinación");
}

console.log("--- Hombros girados (shoulderWidth) ---");
{
  // Hombros a 36 cm de ancho y 60 cm de la cámara (cámara de 60° vertical, imagen 4:3).
  const focal = 0.5 / Math.tan((30 * Math.PI) / 180); // en altos de imagen
  const widthAt = (yawDeg: number) => {
    const a = (yawDeg * Math.PI) / 180;
    const half = 0.18;
    const pts = [-1, 1].map((s) => ({ x: s * half * Math.cos(a), z: s * half * Math.sin(a) }));
    const image = pts.map((p) => ({ x: 0.5 + (focal * p.x) / (0.6 + p.z) / (4 / 3), y: 0.6, z: 0, visibility: 0.99 }));
    const world = pts.map((p) => ({ x: p.x, y: 0, z: p.z, visibility: 0.99 }));
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0 }));
    const wm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
    // Pose: 11 = hombro izquierdo de la persona (a la derecha de la imagen), 12 = derecho.
    [lm[12], lm[11]] = image;
    [wm[12], wm[11]] = world;
    return shoulderWidth(lm, wm, 4 / 3);
  };
  const front = widthAt(0)!;
  const turned = widthAt(35)!;
  const rawTurned = front * Math.cos((35 * Math.PI) / 180);
  console.log(`   de frente ${front.toFixed(3)}; girado 35°: ${turned.toFixed(3)} (sin corregir sería ${rawTurned.toFixed(3)})`);
  check(Math.abs(turned / front - 1) < 0.05, "girar el torso 35° no cambia el ancho (no parece que te alejas)");
  check(widthAt(70) === null, "girado 70°: no se usa (poco fiable)");
  const hidden = (() => {
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.99 }));
    lm[11] = { x: 0.99, y: 0.6, z: 0, visibility: 0.99 }; // en el borde de la imagen
    lm[12] = { x: 0.3, y: 0.6, z: 0, visibility: 0.99 };
    return shoulderWidth(lm, lm, 4 / 3);
  })();
  check(hidden === null, "un hombro cortado por el borde no se usa");
}

console.log(failures ? `\n${failures} prueba(s) fallaron` : "\nOK");
if (failures) process.exit(1);
