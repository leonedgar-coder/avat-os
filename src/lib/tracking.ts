// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Seguimiento facial con MediaPipe Face Landmarker. Corre en la interfaz
// (WebView2), todo en local: el video de la cámara nunca sale del equipo.
// Cada cuadro produce un `TrackingFrame` que se envía a Rust, y Rust lo
// reenvía a la página del avatar.

import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";

/** Datos que recibe el avatar. Ángulos en radianes, el resto de 0 a 1. */
export interface TrackingFrame {
  /** Rotación de la cabeza: [pitch (arriba/abajo), yaw (izq/der), roll (inclinación)]. */
  head: [number, number, number];
  /** Posición de la cabeza respecto de la cámara, en cm: [x (derecha), y (arriba), z (hacia la cámara)]. */
  headPos: [number, number, number];
  blinkLeft: number;
  blinkRight: number;
  jawOpen: number;
  mouthFunnel: number;
  smile: number;
}

export interface TrackerStats {
  fps: number;
  faceFound: boolean;
  /** Último cuadro medido (para ver los valores reales y calibrar). */
  last: TrackingFrame | null;
}

const SEND_INTERVAL_MS = 1000 / 30;

export class FaceTracker {
  private landmarker: FaceLandmarker | null = null;
  private stream: MediaStream | null = null;
  private video = document.createElement("video");
  private running = false;
  private lastVideoTime = -1;
  private lastSent = 0;
  private lastFrame: TrackingFrame | null = null;
  private frames = 0;
  private statsTimer = performance.now();

  constructor(
    private onFrame: (frame: TrackingFrame) => void,
    private onStats: (stats: TrackerStats) => void,
  ) {
    this.video.muted = true;
    this.video.playsInline = true;
  }

  async start() {
    if (this.running) return;
    if (!this.landmarker) this.landmarker = await createLandmarker();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, frameRate: { ideal: 30 } },
      audio: false,
    });
    try {
      this.video.srcObject = this.stream;
      await this.video.play();
    } catch (e) {
      this.stop(); // no dejar la cámara encendida si el video no arranca
      throw e;
    }
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.lastFrame = null;
    this.onStats({ fps: 0, faceFound: false, last: null });
  }

  private loop = () => {
    if (!this.running || !this.landmarker) return;
    const now = performance.now();
    let faceFound = false;

    if (this.video.readyState >= 2 && this.video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.video.currentTime;
      const result = this.landmarker.detectForVideo(this.video, now);
      const shapes = result.faceBlendshapes?.[0]?.categories;
      const matrix = result.facialTransformationMatrixes?.[0]?.data;
      if (shapes && matrix) {
        faceFound = true;
        this.frames++;
        if (now - this.lastSent >= SEND_INTERVAL_MS) {
          this.lastSent = now;
          this.lastFrame = toFrame(shapes, matrix);
          this.onFrame(this.lastFrame);
        }
      }
    }

    if (now - this.statsTimer >= 1000) {
      this.onStats({
        fps: (this.frames * 1000) / (now - this.statsTimer),
        faceFound: this.frames > 0 || faceFound,
        last: this.lastFrame,
      });
      this.frames = 0;
      this.statsTimer = now;
    }
    requestAnimationFrame(this.loop);
  };
}

/** Crea el detector con GPU y, si la GPU no está disponible, con CPU. */
async function createLandmarker(): Promise<FaceLandmarker> {
  // Archivos locales copiados por `npm run fetch:tracking`.
  const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
  const options = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: "/mediapipe/face_landmarker.task", delegate },
    runningMode: "VIDEO" as const,
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  try {
    return await FaceLandmarker.createFromOptions(fileset, options("GPU"));
  } catch (e) {
    console.warn("[tracking] GPU no disponible, usando CPU:", e);
    return FaceLandmarker.createFromOptions(fileset, options("CPU"));
  }
}

const _m = new Matrix4();
const _p = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const _e = new Euler();

function toFrame(shapes: { categoryName: string; score: number }[], matrix: number[]): TrackingFrame {
  const s: Record<string, number> = {};
  for (const c of shapes) s[c.categoryName] = c.score;

  // La matriz es 4x4 en orden de columnas (rotación + traslación + escala);
  // separamos solo la rotación de la cabeza.
  _m.fromArray(matrix).decompose(_p, _q, _s);
  const e = _e.setFromQuaternion(_q, "YXZ");

  return {
    head: [e.x, e.y, e.z],
    headPos: [_p.x, _p.y, _p.z],
    blinkLeft: s.eyeBlinkLeft ?? 0,
    blinkRight: s.eyeBlinkRight ?? 0,
    jawOpen: s.jawOpen ?? 0,
    mouthFunnel: s.mouthFunnel ?? 0,
    smile: ((s.mouthSmileLeft ?? 0) + (s.mouthSmileRight ?? 0)) / 2,
  };
}
