// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Deja en static/mediapipe/ todo lo que necesita el seguimiento facial, para
// que funcione sin internet y sin enviar nada a servidores externos:
//   - el motor WASM de @mediapipe/tasks-vision (copiado de node_modules)
//   - el modelo face_landmarker.task oficial de Google (Apache-2.0), verificado por SHA-256

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "static", "mediapipe");

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const MODEL_SHA256 = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

mkdirSync(outDir, { recursive: true });
cpSync(join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm"), join(outDir, "wasm"), {
  recursive: true,
});

const modelPath = join(outDir, "face_landmarker.task");
if (existsSync(modelPath) && sha256(readFileSync(modelPath)) === MODEL_SHA256) {
  console.log("[tracking] Modelo ya presente.");
} else {
  console.log("[tracking] Descargando modelo de seguimiento facial...");
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Descarga fallida: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = sha256(buf);
  if (hash !== MODEL_SHA256) throw new Error(`SHA-256 incorrecto del modelo: ${hash}`);
  writeFileSync(`${modelPath}.part`, buf);
  renameSync(`${modelPath}.part`, modelPath);
}
console.log("[tracking] Listo: static/mediapipe/");
