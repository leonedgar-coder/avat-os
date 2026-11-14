// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Seguimiento facial con MediaPipe Face Landmarker y, para los hombros, Pose Landmarker
// (modelo lite). Corre en la interfaz (WebView2), todo en local: el video de la cámara
// nunca sale del equipo.
// Cada cuadro produce un `TrackingFrame` que se envía a Rust, y Rust lo
// reenvía a la página del avatar.

import { FaceLandmarker, FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import { shoulderWidth } from "./shoulders";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";

/** Datos que recibe el avatar. Ángulos en radianes, el resto de 0 a 1. */
export interface TrackingFrame {
  /** Rotación de la cabeza: [pitch (arriba/abajo), yaw (izq/der), roll (inclinación)]. */
  head: [number, number, number];
  /** Posición de la cabeza respecto de la cámara, en cm: [x (derecha), y (arriba), z (hacia la cámara)]. */
  headPos: [number, number, number];
  /**
   * Mirada: [horizontal, vertical], aproximadamente de −1 a 1. Horizontal positivo =
   * mirar hacia tu izquierda (el mismo sentido que girar la cabeza hacia tu izquierda);
   * vertical positivo = mirar hacia arriba.
   */
  gaze: [number, number];
  blinkLeft: number;
  blinkRight: number;
  jawOpen: number;
  mouthFunnel: number;
  smile: number;
  /**
   * Ancho de los hombros en la imagen (en altos de imagen), corregido por el giro del torso;
   * `null` si no se ven bien. Sirve para distinguir inclinarse de acercarse (avatar/body.ts).
   */
  shoulders?: number | null;
  /**
   * Cuándo se midió (segundos, reloj de la interfaz). El anti-temblor del avatar lo usa
   * en lugar de la hora de llegada, que se desordena en el camino interfaz → Rust → avatar.
   */
  time: number;
}

export interface TrackerStats {
  fps: number;
  faceFound: boolean;
  /** Si se ven los hombros (si no, inclinarse y acercarse se distinguen solo por el tiempo). */
  shouldersFound: boolean;
  /** Último cuadro medido (para ver los valores reales y calibrar). */
  last: TrackingFrame | null;
}

const SEND_INTERVAL_MS = 1000 / 30;
/** Los hombros se mueven despacio: basta medirlos ~15 veces por segundo (ahorra CPU/GPU). */
const POSE_INTERVAL_MS = 1000 / 15;
/** Una medida de hombros más vieja que esto ya no se usa. */
const POSE_MAX_AGE_MS = 300;

export class FaceTracker {
  private landmarker: FaceLandmarker | null = null;
  /** `null` = todavía no se cargó; `false` = no se pudo cargar (se sigue sin hombros). */
  private pose: PoseLandmarker | null | false = null;
  private poseLoading: Promise<void> | null = null;
  private lastPose = 0;
  private shoulders: { width: number; at: number } | null = null;
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
    // Los hombros se cargan aparte, sin esperar: la cara empieza enseguida y, mientras tanto
    // (o si el detector no carga), el avatar usa el plan B de avatar/body.ts.
    if (this.pose === null && !this.poseLoading) {
      this.poseLoading = createPoseLandmarker().then(
        (p) => {
          this.pose = p;
        },
        (e) => {
          console.warn("[tracking] sin detector de hombros:", e);
          this.pose = false;
        },
      );
    }
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
    this.shoulders = null;
    this.onStats({ fps: 0, faceFound: false, shouldersFound: false, last: null });
  }

  private loop = () => {
    if (!this.running || !this.landmarker) return;
    const now = performance.now();
    let faceFound = false;

    if (this.video.readyState >= 2 && this.video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.video.currentTime;
      const result = this.landmarker.detectForVideo(this.video, now);
      if (this.pose && now - this.lastPose >= POSE_INTERVAL_MS) {
        this.lastPose = now;
        try {
          const pose = this.pose.detectForVideo(this.video, now);
          const width = shoulderWidth(pose.landmarks?.[0], pose.worldLandmarks?.[0], this.video.videoWidth / this.video.videoHeight);
          this.shoulders = width === null ? null : { width, at: now };
        } catch (e) {
          // Un error del detector de hombros no puede cortar el tracking de la cara.
          console.warn("[tracking] detector de hombros desactivado:", e);
          try {
            this.pose.close();
          } catch {
            /* ya estaba roto: basta con dejar de usarlo */
          }
          this.pose = false;
          this.shoulders = null;
        }
      }
      const shoulders = this.shoulders && now - this.shoulders.at <= POSE_MAX_AGE_MS ? this.shoulders.width : null;
      const shapes = result.faceBlendshapes?.[0]?.categories;
      const matrix = result.facialTransformationMatrixes?.[0]?.data;
      if (shapes && matrix) {
        faceFound = true;
        this.frames++;
        if (now - this.lastSent >= SEND_INTERVAL_MS) {
          this.lastSent = now;
          this.lastFrame = { ...toFrame(shapes, matrix, now / 1000), shoulders };
          this.onFrame(this.lastFrame);
        }
      }
    }

    if (now - this.statsTimer >= 1000) {
      this.onStats({
        fps: (this.frames * 1000) / (now - this.statsTimer),
        faceFound: this.frames > 0 || faceFound,
        shouldersFound: this.lastFrame?.shoulders != null,
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

/** Crea el detector de cuerpo (solo se usan los hombros), con GPU y si no, con CPU. */
async function createPoseLandmarker(): Promise<PoseLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
  const options = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: "/mediapipe/pose_landmarker_lite.task", delegate },
    runningMode: "VIDEO" as const,
    numPoses: 1,
    outputSegmentationMasks: false,
  });
  try {
    return await PoseLandmarker.createFromOptions(fileset, options("GPU"));
  } catch (e) {
    console.warn("[tracking] Pose: GPU no disponible, usando CPU:", e);
    return PoseLandmarker.createFromOptions(fileset, options("CPU"));
  }
}

const _m = new Matrix4();
const _p = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const _e = new Euler();

function toFrame(shapes: { categoryName: string; score: number }[], matrix: number[], time: number): TrackingFrame {
  const s: Record<string, number> = {};
  for (const c of shapes) s[c.categoryName] = c.score;

  // La matriz es 4x4 en orden de columnas (rotación + traslación + escala);
  // separamos solo la rotación de la cabeza.
  _m.fromArray(matrix).decompose(_p, _q, _s);
  const e = _e.setFromQuaternion(_q, "YXZ");

  return {
    time,
    head: [e.x, e.y, e.z],
    headPos: [_p.x, _p.y, _p.z],
    // Hacia tu izquierda: el ojo izquierdo mira "afuera" y el derecho "adentro".
    gaze: [
      ((s.eyeLookOutLeft ?? 0) + (s.eyeLookInRight ?? 0) - (s.eyeLookInLeft ?? 0) - (s.eyeLookOutRight ?? 0)) / 2,
      ((s.eyeLookUpLeft ?? 0) + (s.eyeLookUpRight ?? 0) - (s.eyeLookDownLeft ?? 0) - (s.eyeLookDownRight ?? 0)) / 2,
    ],
    blinkLeft: s.eyeBlinkLeft ?? 0,
    blinkRight: s.eyeBlinkRight ?? 0,
    jawOpen: s.jawOpen ?? 0,
    mouthFunnel: s.mouthFunnel ?? 0,
    smile: ((s.mouthSmileLeft ?? 0) + (s.mouthSmileRight ?? 0)) / 2,
  };
}
