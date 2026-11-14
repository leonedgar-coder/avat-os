// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Deja en static/mediapipe/ todo lo que necesita el seguimiento, para que funcione sin
// internet y sin enviar nada a servidores externos:
//   - el motor WASM de @mediapipe/tasks-vision (copiado de node_modules)
//   - los modelos oficiales de Google (Apache-2.0), verificados por SHA-256:
//     face_landmarker.task (cara) y pose_landmarker_lite.task (hombros, Fase 1B)

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "static", "mediapipe");

const MODELS = [
  {
    file: "face_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    sha256: "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff",
  },
  {
    file: "pose_landmarker_lite.task",
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    sha256: "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a",
  },
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

mkdirSync(outDir, { recursive: true });
cpSync(join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm"), join(outDir, "wasm"), {
  recursive: true,
});

for (const model of MODELS) {
  const path = join(outDir, model.file);
  if (existsSync(path) && sha256(readFileSync(path)) === model.sha256) {
    console.log(`[tracking] ${model.file}: ya presente.`);
    continue;
  }
  console.log(`[tracking] Descargando ${model.file}...`);
  const res = await fetch(model.url);
  if (!res.ok) throw new Error(`Descarga fallida (${model.file}): HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = sha256(buf);
  if (hash !== model.sha256) throw new Error(`SHA-256 incorrecto de ${model.file}: ${hash}`);
  writeFileSync(`${path}.part`, buf);
  renameSync(`${path}.part`, path);
}
console.log("[tracking] Listo: static/mediapipe/");
