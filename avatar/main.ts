// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Renderizador del avatar. Esta página la carga OBS como "fuente de navegador"
// con fondo transparente. El modelo se sirve desde el servidor local de avat-os
// en /model.vrm.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { OneEuroVector, SoftDeadband } from "./one-euro";
import { SpikeFilter, WinkGate } from "./spike-filter";
import { FRAME_INTERPOLATION, GAZE_FILTER, HEAD_DEADBAND, HEAD_FILTER, POSITION_DEADBAND, POSITION_FILTER } from "./smoothing";

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

// Cámara: el encuadre (plano, zoom, altura, ángulo) lo deciden los efectos y se
// calcula con la altura real de la cabeza del avatar (ver updateCamera).
const CAMERA_FOV = 30;
const camera = new THREE.PerspectiveCamera(CAMERA_FOV, window.innerWidth / window.innerHeight, 0.1, 20);
camera.position.set(0, 1.35, 1.9);
const cameraTarget = new THREE.Vector3(0, 1.3, 0);
camera.lookAt(cameraTarget);

const scene = new THREE.Scene();
const light = new THREE.DirectionalLight(0xffffff, Math.PI);
light.position.set(1, 1, 1).normalize();
const ambient = new THREE.AmbientLight(0xffffff, 0.4);
scene.add(light, ambient);

let vrm: VRM | null = null;

/** Informa a avat-os el estado del avatar (se muestra en el panel de la interfaz). */
function reportStatus(state: "loading" | "loaded" | "error" | "bg_playing" | "bg_error", detail = "") {
  const q = new URLSearchParams({ state, detail: detail.slice(0, 300) });
  fetch(`/status?${q}`).catch(() => {
    /* sin servidor (p. ej. en pruebas): se ignora */
  });
}

async function loadModel(url: string) {
  reportStatus("loading");
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  try {
    const gltf = await loader.loadAsync(url);
    const loaded = gltf.userData.vrm as VRM | undefined;
    if (!loaded) throw new Error("El archivo no es un VRM válido");
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(loaded); // los VRM 0.x miran hacia el otro lado
    restPose(loaded);
    // La mirada la controla avat-os (tracking o reposo), no un objeto al que mirar.
    if (loaded.lookAt) loaded.lookAt.autoUpdate = false;
    scene.add(loaded.scene);
    vrm = loaded;
    measureAvatar(loaded);
    applyOutline(loaded);
    snapCamera = true; // al cambiar de avatar, encuadrar de inmediato (sin transición)
    const meta = loaded.meta;
    const name = meta && ("name" in meta ? meta.name : meta.title); // VRM 1.0 : VRM 0.x
    console.log(`[avat-os] Avatar cargado: ${name ?? "sin nombre"}`);
    reportStatus("loaded", name ?? "");
  } catch (e) {
    console.error(`[avat-os] No se pudo cargar el avatar: ${e}`);
    reportStatus("error", String(e));
  }
}

/** Ángulo de los brazos en reposo (rad): bajados desde la pose en T. */
const ARM_REST_Z = 1.2;

/** Baja los brazos desde la pose en T. */
function restPose(model: VRM) {
  const bone = (name: Parameters<NonNullable<VRM["humanoid"]>["getNormalizedBoneNode"]>[0]) =>
    model.humanoid?.getNormalizedBoneNode(name);
  const l = bone("leftUpperArm");
  const r = bone("rightUpperArm");
  if (l) l.rotation.z = -ARM_REST_Z;
  if (r) r.rotation.z = ARM_REST_Z;
}

// Animación en reposo: respiración, balanceo suave y parpadeo automático.
let nextBlink = 2;
let blinkStart = -1;
// Mirada. Cada VRM define cuántos grados de entrada equivalen a "mirar al máximo"
// (`inputMaxValue`, a menudo 90°) y cuánto giran sus ojos con eso (`outputScale`).
// Se usa ese rango para que tu mirada máxima lleve los ojos hasta el límite del autor:
// con un valor fijo (p. ej. 25°) y una entrada de 90°, los ojos casi no se movían.
// MediaPipe rara vez llega a 1 al mirar a un lado (suele dar 0,3–0,6): se amplifica.
const GAZE_GAIN = 1.6;
type RangeMap = { inputMaxValue: number } | undefined;
function gazeRange(model: VRM) {
  const ap = model.lookAt?.applier as
    | { rangeMapHorizontalInner?: RangeMap; rangeMapHorizontalOuter?: RangeMap; rangeMapVerticalUp?: RangeMap; rangeMapVerticalDown?: RangeMap }
    | undefined;
  return {
    horizontal: Math.max(ap?.rangeMapHorizontalInner?.inputMaxValue ?? 25, ap?.rangeMapHorizontalOuter?.inputMaxValue ?? 25),
    up: ap?.rangeMapVerticalUp?.inputMaxValue ?? 20,
    down: ap?.rangeMapVerticalDown?.inputMaxValue ?? 20,
  };
}
function applyGaze(model: VRM) {
  if (!model.lookAt) return;
  const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
  const range = gazeRange(model);
  const h = clamp1(smooth.gazeYaw * GAZE_GAIN);
  const v = clamp1(smooth.gazePitch * GAZE_GAIN);
  model.lookAt.yaw = h * range.horizontal;
  model.lookAt.pitch = v * (v >= 0 ? range.up : range.down);
}

function idle(model: VRM, t: number, delta: number) {
  // Sin tracking, los ojos vuelven despacio al frente.
  // Depende del tiempo (no de los FPS): ~0,3 s hasta casi el centro.
  const back = Math.exp(-delta * 10);
  smooth.gazeYaw *= back;
  smooth.gazePitch *= back;
  // Sin tracking, el avatar vuelve despacio a su lugar (~1 s).
  smooth.approach *= Math.exp(-delta * 3);
  applyGaze(model);
  const spine = model.humanoid?.getNormalizedBoneNode("spine");
  const neck = model.humanoid?.getNormalizedBoneNode("neck");
  const head = model.humanoid?.getNormalizedBoneNode("head");
  spine?.rotation.set(Math.sin(t * 1.6) * 0.015, 0, 0);
  model.humanoid?.getNormalizedBoneNode("chest")?.rotation.set(0, 0, 0); // limpiar lo del tracking
  neck?.rotation.set(0, 0, 0);
  head?.rotation.set(0, Math.sin(t * 0.5) * 0.05, Math.sin(t * 0.7) * 0.02);

  // Limpiar lo que haya dejado el tracking.
  const em = model.expressionManager;
  for (const name of ["blinkLeft", "blinkRight"]) em?.setValue(name, 0); // la boca la pone applyMouth

  if (blinkStart < 0 && t >= nextBlink) blinkStart = t;
  let blink = 0;
  if (blinkStart >= 0) {
    const k = (t - blinkStart) / 0.15; // un parpadeo dura ~150 ms
    blink = k < 1 ? Math.sin(k * Math.PI) : 0;
    if (k >= 1) {
      blinkStart = -1;
      nextBlink = t + 2 + Math.random() * 4;
    }
  }
  model.expressionManager?.setValue("blink", blink);
}

// --- Seguimiento facial -----------------------------------------------------
// La interfaz calcula el tracking y Rust lo reenvía por WebSocket (puerto `ws` en la URL).

interface TrackingFrame {
  head: [number, number, number];
  /** Posición de la cabeza en cm respecto de la cámara (opcional por compatibilidad). */
  headPos?: [number, number, number];
  /** Mirada [horizontal, vertical] de −1 a 1 (opcional por compatibilidad). */
  gaze?: [number, number];
  blinkLeft: number;
  blinkRight: number;
  jawOpen: number;
  mouthFunnel: number;
  smile: number;
  /** Cuándo se midió (segundos, reloj de la interfaz; opcional por compatibilidad). */
  time?: number;
  /** Calculados en filterFrame: cuánto está cerrado cada ojo (0–1). */
  closedLeft?: number;
  closedRight?: number;
}

/** Mensajes del canal en vivo (ver tracking_relay.rs). */
type ChannelMessage =
  | { type: "tracking"; avatar: string; frame: TrackingFrame }
  | { type: "expression"; avatar: string; name: string | null }
  | { type: "calibration"; avatar: string; values: Calibration | null }
  | { type: "lipsync"; avatar: string; level: number; mode: "combine" | "voice"; vowels?: number[] | null }
  | { type: "effects"; avatar: string; values: Effects }
  | { type: "gesture"; avatar: string; name: string }
  | { type: "background"; avatar: string; kind: "transparent" | "color" | "image"; color: string; fit: "cover" | "contain"; v: number; media?: "image" | "video" };

/** Calibración de la persona (calibration.rs). Ángulos en rad, posiciones en cm. */
interface Calibration {
  /** Ojo izquierdo (o los dos si no hay `eyeRight`). */
  eyeOpen: number;
  eyeClosed: number;
  /** Umbrales del ojo derecho [abierto, cerrado] (calibraciones antiguas: no). */
  eyeRight?: [number, number] | null;
  mouthClosed: number;
  mouthOpen: number;
  headOffset: [number, number, number];
  restPos: [number, number, number];
  /** Mirada al mirar la pantalla de frente (la cámara suele estar más arriba). */
  gazeOffset?: [number, number];
  /** Lo que midió el asistente (abierto y cerrado de cada ojo), para el margen mínimo. */
  levels?: { eyeOpen: number; eyeClosed: number; eyeRight?: [number, number] | null } | null;
}

/** Identificador de este avatar (`?id=` en la URL; hoy siempre "main"). */
const AVATAR_ID = new URLSearchParams(location.search).get("id") ?? "main";

// --- Gestos animados (atajos Ctrl+Shift+6…9 o botones) -------------------------
// Animaciones hechas en código (sin archivos externos) sobre huesos estándar de VRM.
// Se suman al tracking o al reposo y entran y salen con suavidad.
//
// Ejes de los huesos normalizados de VRM (avatar mirando a +Z, en pose en T):
// - brazo derecho hacia −X: rotation.z > 0 lo baja, < 0 lo sube (izquierdo, al revés)
// - cabeza: rotation.x > 0 la inclina hacia abajo, rotation.y la gira

const GESTURE_DURATION: Record<string, number> = { wave: 2.4, nod: 1.2, shake: 1.4, shrug: 1.6 };
let gesture: { name: string; start: number } | null = null;

function startGesture(name: string) {
  if (name in GESTURE_DURATION) gesture = { name, start: performance.now() / 1000 };
}

/** 0 → 1 → 0 con rampas suaves de `ramp` segundos al principio y al final. */
function envelope(time: number, duration: number, ramp = 0.25) {
  const smooth = (x: number) => x * x * (3 - 2 * x);
  return smooth(Math.min(1, time / ramp)) * smooth(Math.min(1, Math.max(0, (duration - time) / ramp)));
}

function applyGesture(model: VRM) {
  const bone = (name: "rightUpperArm" | "rightLowerArm" | "leftUpperArm" | "leftLowerArm" | "leftShoulder" | "rightShoulder" | "head" | "neck") =>
    model.humanoid?.getNormalizedBoneNode(name);
  const rUpper = bone("rightUpperArm");
  const rLower = bone("rightLowerArm");
  const lLower = bone("leftLowerArm");
  const lUpper = bone("leftUpperArm");
  const lShoulder = bone("leftShoulder");
  const rShoulder = bone("rightShoulder");
  const head = bone("head");

  // Sin gesto: brazos y hombros en reposo (lo escribimos siempre para volver exacto).
  let rUpperZ = ARM_REST_Z, lUpperZ = -ARM_REST_Z, rLowerZ = 0, rLowerY = 0, lLowerY = 0, shoulderUp = 0;
  let headX = 0, headY = 0, headZ = 0;

  if (gesture) {
    const time = performance.now() / 1000 - gesture.start;
    const duration = GESTURE_DURATION[gesture.name];
    if (time >= duration) {
      gesture = null;
    } else {
      const e = envelope(time, duration);
      const p = time / duration;
      const mix = (rest: number, pose: number) => rest + (pose - rest) * e;
      switch (gesture.name) {
        case "wave": // brazo al costado, antebrazo arriba, mano de lado a lado
          rUpperZ = mix(ARM_REST_Z, -0.25);
          rLowerZ = mix(0, -1.7 + Math.sin(time * 11) * 0.35);
          rLowerY = mix(0, -0.3);
          headZ = 0.06 * e;
          break;
        case "nod": // dos veces hacia abajo
          headX = 0.22 * e * (1 - Math.cos(p * Math.PI * 4)) / 2;
          break;
        case "shake": // girar la cabeza a los lados
          headY = 0.32 * e * Math.sin(p * Math.PI * 5);
          break;
        case "shrug": // hombros arriba, antebrazos hacia adelante, cabeza ladeada
          shoulderUp = 0.28 * e;
          rUpperZ = mix(ARM_REST_Z, 1.05);
          lUpperZ = mix(-ARM_REST_Z, -1.05);
          rLowerY = 0.9 * e; // antebrazo derecho hacia la cámara (+Z)
          lLowerY = -0.9 * e; // el izquierdo, en espejo
          headZ = 0.12 * e;
          break;
      }
    }
  }
  if (rUpper) rUpper.rotation.z = rUpperZ;
  if (lUpper) lUpper.rotation.z = lUpperZ;
  if (rLower) rLower.rotation.set(0, rLowerY, rLowerZ);
  if (lLower) lLower.rotation.set(0, lLowerY, 0);
  if (lShoulder) lShoulder.rotation.z = shoulderUp;
  if (rShoulder) rShoulder.rotation.z = -shoulderUp;
  // La cabeza ya la movió el tracking o el reposo en este cuadro: el gesto se suma.
  if (head) {
    head.rotation.x += headX;
    head.rotation.y += headY;
    head.rotation.z += headZ;
  }
}

// --- Efectos: cámara, luces y contorno (effects.rs) ---------------------------

interface Effects {
  shot: "close" | "medium" | "full";
  zoom: number;
  height: number;
  angle: number;
  lightIntensity: number;
  lightColor: string;
  lightAngle: number;
  ambient: number;
  outline: number;
}
let effects: Effects = {
  shot: "medium", zoom: 1, height: 0, angle: 0,
  lightIntensity: 1, lightColor: "#ffffff", lightAngle: 45, ambient: 0.4, outline: 1,
};
/** Altura de la cabeza del avatar (m), medida al cargarlo. Por defecto, la de un adulto. */
let headY = 1.45;
let snapCamera = true;
/** Distancia de la cámara al avatar (m), según el plano y el zoom de Efectos. */
let cameraDistance = 2;
/**
 * Cuánto puede acercarse o alejarse el avatar de su cámara (fracción de la distancia): más
 * cerca, en primer plano la cara se saldría del cuadro; más lejos, se vería diminuto.
 */
const APPROACH_MAX_IN = 0.3;
const APPROACH_MAX_OUT = 0.5;

const _face = new THREE.Vector3();
const _toCamera = new THREE.Vector3();
/**
 * Mueve al avatar hacia su cámara (o lo aleja) según `smooth.approach`, por la recta que
 * une **la cara** con la cámara: así la cara se queda en el mismo lugar de la pantalla y
 * solo crece o se achica, como al acercarte a tu cámara. (En horizontal, al acercarse la
 * cabeza "subía" y se salía del cuadro, porque la cámara mira más abajo.)
 */
function applyApproach(model: VRM) {
  _face.set(0, headY + 0.06, 0); // el hueso de la cabeza está en la mandíbula; la cara, más arriba
  _toCamera.copy(camera.position).sub(_face).normalize();
  model.scene.position.copy(_toCamera).multiplyScalar(smooth.approach);
}
const goalTarget = new THREE.Vector3();
const goalPos = new THREE.Vector3();

function measureAvatar(model: VRM) {
  model.scene.updateMatrixWorld(true);
  const head = model.humanoid?.getRawBoneNode("head");
  if (head) headY = head.getWorldPosition(new THREE.Vector3()).y;
}

function applyEffects(fx: Effects) {
  effects = fx;
  if (/^#[0-9a-f]{6}$/i.test(fx.lightColor)) light.color.set(fx.lightColor);
  light.intensity = Math.PI * fx.lightIntensity;
  const a = THREE.MathUtils.degToRad(fx.lightAngle);
  light.position.set(Math.sin(a), 0.8, Math.cos(a)).normalize();
  ambient.intensity = fx.ambient;
  if (vrm) applyOutline(vrm);
}

/** Contorno: multiplica el grosor original de los materiales MToon (0 = sin contorno). */
function applyOutline(model: VRM) {
  model.scene.traverse((obj) => {
    const mats = (obj as THREE.Mesh).material;
    for (const mat of Array.isArray(mats) ? mats : mats ? [mats] : []) {
      if (!("outlineWidthFactor" in mat)) continue; // solo materiales MToon
      const m = mat as THREE.Material & { outlineWidthFactor: number };
      m.userData.baseOutline ??= m.outlineWidthFactor;
      m.outlineWidthFactor = m.userData.baseOutline * effects.outline;
    }
  });
}

/**
 * Encuadre según el plano. La altura visible se calcula desde la cabeza del avatar y
 * de ahí la distancia de la cámara (campo de visión vertical fijo). Transición suave.
 */
function updateCamera(delta: number) {
  // Ojo: el hueso "head" de VRM está en la base de la cabeza (a la altura de la
  // mandíbula), no en el centro de la cara; la cara queda unos 8–10 cm más arriba.
  const frames = {
    close: { visible: 0.55, center: headY + 0.06 }, // cabeza y hombros
    medium: { visible: 1.05, center: headY - 0.25 }, // de la cintura para arriba
    full: { visible: headY + 0.35, center: (headY + 0.15) / 2 }, // cuerpo entero
  };
  const fr = frames[effects.shot] ?? frames.medium;
  const distance = fr.visible / 2 / Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2)) / effects.zoom;
  cameraDistance = distance;
  const a = THREE.MathUtils.degToRad(effects.angle);
  // Vectores reutilizados: esto corre en cada cuadro (evita basura para el recolector).
  goalTarget.set(0, fr.center + effects.height, 0);
  goalPos.set(Math.sin(a) * distance, 0, Math.cos(a) * distance).add(goalTarget);
  const k = snapCamera ? 1 : 1 - Math.exp(-delta * 6);
  snapCamera = false;
  camera.position.lerp(goalPos, k);
  cameraTarget.lerp(goalTarget, k);
  camera.lookAt(cameraTarget);
}

// --- Fondo -------------------------------------------------------------------
// Se dibuja como fondo de la página, detrás del lienzo transparente del avatar;
// la fuente de navegador de OBS captura los dos juntos. Los GIF/WebP animados se animan.

// Los videos (MP4/WebM) van en un <video> detrás del lienzo: en bucle y sin sonido (el
// audio será del mezclador, Fase 3; además, sin silencio el navegador no lo reproduce solo).
let bgVideo: HTMLVideoElement | null = null;

function backgroundVideo(): HTMLVideoElement {
  if (bgVideo) return bgVideo;
  const v = document.createElement("video");
  v.muted = true;
  v.loop = true;
  v.autoplay = true;
  v.playsInline = true;
  Object.assign(v.style, { position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: "-1" });
  // Avisar si se reproduce o no (la interfaz muestra el error, p. ej. un códec no soportado).
  // Una vez por video: "playing" se repite en cada vuelta del bucle.
  v.addEventListener("playing", () => {
    if (v.dataset.reported === v.getAttribute("src")) return;
    v.dataset.reported = v.getAttribute("src") ?? "";
    reportStatus("bg_playing");
  });
  v.addEventListener("error", () => reportStatus("bg_error", String(v.error?.code ?? 0)));
  document.body.prepend(v);
  return (bgVideo = v);
}

function applyBackground(bg: Extract<ChannelMessage, { type: "background" }>) {
  const style = document.body.style;
  style.background = "transparent";
  const video = bg.kind === "image" && bg.media === "video";
  if (!video && bgVideo) {
    bgVideo.removeAttribute("src");
    bgVideo.load(); // suelta el archivo
    bgVideo.remove();
    bgVideo = null;
  }
  if (bg.kind === "color" && /^#[0-9a-f]{6}$/i.test(bg.color)) {
    style.background = bg.color;
  } else if (video) {
    const v = backgroundVideo();
    v.style.objectFit = bg.fit === "contain" ? "contain" : "cover";
    const src = `/background?v=${Number(bg.v) || 0}`;
    if (v.getAttribute("src") !== src) {
      v.src = src;
      v.play().catch(() => {
        /* el evento "error" ya avisa */
      });
    }
  } else if (bg.kind === "image") {
    // `v` cambia con cada elección: evita que el navegador muestre la imagen anterior.
    const fit = bg.fit === "contain" ? "contain" : "cover";
    style.background = `url("/background?v=${Number(bg.v) || 0}") center / ${fit} no-repeat transparent`;
  }
}

// --- Lip-sync (voz) -----------------------------------------------------------
// La interfaz mide el micrófono y envía un nivel 0–1 (~30 por segundo) y, si está
// activado, el peso de cada vocal (A, I, U, E, O).
// "combine": la apertura es lo mayor entre cámara y voz; "voice": solo la voz.
let voice = { level: 0, mode: "combine" as "combine" | "voice", at: 0, vowels: null as number[] | null };
/** Expresiones VRM de las vocales, en el orden en que llegan los pesos. */
const VISEMES = ["aa", "ih", "ou", "ee", "oh"] as const;
const visemeWeight: Record<(typeof VISEMES)[number], number> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
/** Desde qué nivel de voz la boca toma la forma de la vocal (por debajo, forma de A). */
const VOICE_SHAPE_MIN = 0.1;
const VOICE_TIMEOUT_S = 0.5; // sin mensajes durante este tiempo → lip-sync apagado
const voiceActive = () => performance.now() / 1000 - voice.at < VOICE_TIMEOUT_S;

/**
 * Boca del avatar. `cameraJaw` = jawOpen del tracking y `cameraOu` = boca en "o" de la
 * cámara, o null si no hay tracking. Se usa con y sin tracking: así el lip-sync funciona
 * aunque la cámara esté apagada.
 *
 * La apertura (cámara y/o voz) se reparte entre las vocales que reconoce el lip-sync:
 * con 70 % de "A" y 30 % de "O", `aa` recibe el 70 % de la apertura y `oh` el 30 %.
 * Sin vocales (apagadas o sin micrófono) toda la apertura va a `aa`, como antes.
 */
function applyMouth(model: VRM, delta: number, cameraJaw: number | null, cameraOu: number | null) {
  const fromCamera = cameraJaw === null ? 0 : mouthOpen(cameraJaw);
  const fromVoice = voiceActive() ? voice.level : 0;
  const goal = voiceActive() && voice.mode === "voice" ? fromVoice : Math.max(fromCamera, fromVoice);
  // Abrir rápido (las sílabas son cortas) y cerrar un poco más suave (evita temblor).
  const speed = goal > smooth.aa ? 45 : 25;
  smooth.aa += (goal - smooth.aa) * (1 - Math.exp(-delta * speed));

  const em = model.expressionManager;
  // La forma de la vocal solo mientras se habla: en silencio, el lip-sync conserva la
  // última vocal, y si la cámara abre la boca (reír sin sonido) debe verse una A, no esa vocal.
  const speaking = voiceActive() && voice.vowels !== null && fromVoice >= VOICE_SHAPE_MIN;
  const shape = speaking && voice.vowels ? voice.vowels : [1, 0, 0, 0, 0];
  // Si el modelo no trae alguna vocal, su parte va a "aa" (todo VRM tiene aa).
  let toAa = 0;
  const goals = VISEMES.map((name, i) => {
    if (i > 0 && !em?.getExpression(name)) {
      toAa += shape[i];
      return 0;
    }
    return shape[i];
  });
  goals[0] += toAa;
  const kShape = 1 - Math.exp(-delta * 20); // cambio de vocal en ~50 ms
  VISEMES.forEach((name, i) => {
    visemeWeight[name] += (goals[i] - visemeWeight[name]) * kShape;
    let value = smooth.aa * visemeWeight[name];
    if (name === "ou" && cameraOu !== null) value = Math.max(value, cameraOu); // labios en "o" de la cámara
    em?.setValue(name, value);
  });
}

let target: TrackingFrame | null = null;
let lastTrackingAt = 0;
const TRACKING_TIMEOUT_S = 0.5; // sin datos durante este tiempo → animación en reposo
// Valores suavizados que se aplican al avatar.
const smooth = {
  pitch: 0, yaw: 0, roll: 0, leanSide: 0, leanFwd: 0, approach: 0,
  blinkL: 0, blinkR: 0, aa: 0, ou: 0, gazeYaw: 0, gazePitch: 0,
};

// Anti-temblor (One Euro) sobre cada muestra del tracking: cabeza, posición y mirada.
// Parpadeo y boca no: son movimientos rápidos que deben verse al instante. Los párpados
// solo pierden los picos sueltos (SpikeFilter): si no, se ven parpadeos falsos.
const headFilter = new OneEuroVector(3, HEAD_FILTER);
const positionFilter = new OneEuroVector(3, POSITION_FILTER);
const gazeFilter = new OneEuroVector(2, GAZE_FILTER);
const headDeadband = new SoftDeadband(HEAD_DEADBAND);
const positionDeadband = new SoftDeadband(POSITION_DEADBAND);
const blinkLeftFilter = new SpikeFilter();
const blinkRightFilter = new SpikeFilter();
const winkGate = new WinkGate();

/** Última marca de tiempo usada por los filtros. */
let lastSampleTime = -Infinity;

/** Filtra un cuadro del tracking recibido en el instante `now` (segundos). */
function filterFrame(frame: TrackingFrame, now: number): TrackingFrame {
  // Mejor la hora en que se midió que la de llegada: en el camino los mensajes se amontonan
  // o se separan, y el filtro calcularía velocidades falsas.
  const time = typeof frame.time === "number" && Number.isFinite(frame.time) ? frame.time : now;
  // Empezar de cero si el tracking se había cortado (la cara puede reaparecer en otro lado)
  // o si el reloj fue hacia atrás (la interfaz se recargó y su reloj volvió a 0).
  if (now - lastTrackingAt > TRACKING_TIMEOUT_S || time <= lastSampleTime) {
    headFilter.reset();
    positionFilter.reset();
    gazeFilter.reset();
    headDeadband.reset();
    positionDeadband.reset();
    blinkLeftFilter.reset();
    blinkRightFilter.reset();
    winkGate.reset();
  }
  lastSampleTime = time;
  const blinkLeft = blinkLeftFilter.filter(frame.blinkLeft);
  const blinkRight = blinkRightFilter.filter(frame.blinkRight);
  // Con los ojos cerrados la mirada de MediaPipe es al azar: no se le pasa al filtro, y
  // sin `gaze` applyTracking mantiene la última.
  // Cuánto está cerrado cada ojo; cerrar uno solo tiene que sostenerse (WinkGate).
  const [closedLeft, closedRight] = winkGate.filter(eyeClosed(blinkLeft, "left"), eyeClosed(blinkRight, "right"));
  const eyesClosed = Math.max(closedLeft, closedRight) >= 0.5;
  return {
    ...frame,
    blinkLeft,
    blinkRight,
    closedLeft,
    closedRight,
    head: headDeadband.filter(headFilter.filter(frame.head, time)) as TrackingFrame["head"],
    headPos: frame.headPos && (positionDeadband.filter(positionFilter.filter(frame.headPos, time)) as TrackingFrame["head"]),
    gaze: frame.gaze && !eyesClosed ? (gazeFilter.filter(frame.gaze, time) as [number, number]) : undefined,
  };
}

function connectTracking() {
  const port = new URLSearchParams(location.search).get("ws");
  if (!port) return;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  ws.onmessage = (ev) => {
    let msg: ChannelMessage;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return; // mensaje inválido: se ignora
    }
    if (msg.avatar !== AVATAR_ID) return; // es para otro avatar (modo dúo)
    if (msg.type === "tracking") {
      const now = performance.now() / 1000;
      target = filterFrame(msg.frame, now);
      lastTrackingAt = now;
    } else if (msg.type === "gesture") {
      startGesture(msg.name);
    } else if (msg.type === "effects") {
      applyEffects(msg.values);
    } else if (msg.type === "background") {
      applyBackground(msg);
    } else if (msg.type === "lipsync") {
      const vowels = Array.isArray(msg.vowels) && msg.vowels.length === 5 ? msg.vowels.map((v) => Number(v) || 0) : null;
      voice = { level: msg.level, mode: msg.mode, at: performance.now() / 1000, vowels };
    } else if (msg.type === "expression") {
      activeExpression = msg.name;
    } else if (msg.type === "calibration") {
      calibration = msg.values;
    }
  };
  ws.onclose = () => setTimeout(connectTracking, 1000); // reconectar
}
connectTracking();

// Valores por defecto, usados mientras la persona no se calibre (asistente de la interfaz).
// MediaPipe rara vez llega a 1.0 con el ojo cerrado (suele dar 0.5–0.7):
// por debajo de EYE_OPEN el ojo queda abierto y desde EYE_CLOSED, cerrado del todo.
const EYE_OPEN = 0.2;
const EYE_CLOSED = 0.55;
// Boca: por debajo de MOUTH_CLOSED queda cerrada (evita temblor) y desde MOUTH_OPEN, abierta del todo.
const MOUTH_CLOSED = 0.03;
const MOUTH_OPEN = 0.35;

let calibration: Calibration | null = null;

/** Lleva `v` del rango [from, to] a [0, 1]. */
const remap = (v: number, from: number, to: number) => Math.min(1, Math.max(0, (v - from) / (to - from)));
/** Cuánto está cerrado un ojo (0–1) según el valor de MediaPipe y los umbrales de ese ojo. */
/**
 * Margen mínimo entre el ojo abierto medido y donde el ojo empieza a cerrarse (y entre ese
 * punto y el cierre total). El asistente ya lo aplica al calibrar (EYE_MARGIN en
 * Calibration.svelte); aquí se aplica también a calibraciones guardadas antes, que con un
 * rango de ojos estrecho dejaban el umbral pegado al ojo abierto (parpadeos falsos).
 */
const EYE_MARGIN = 0.03;
function eyeClosed(score: number, eye: "left" | "right"): number {
  const right = eye === "right" ? calibration?.eyeRight : null;
  let [from, to] = right ?? [calibration?.eyeOpen ?? EYE_OPEN, calibration?.eyeClosed ?? EYE_CLOSED];
  const l = calibration?.levels;
  const [measuredOpen, measuredClosed] = (eye === "right" ? l?.eyeRight : null) ?? [l?.eyeOpen, l?.eyeClosed];
  if (typeof measuredOpen === "number" && typeof measuredClosed === "number") {
    // Nunca más del 40 % del rango del ojo: con un rango estrecho, si no, no se cerraría del todo.
    const margin = Math.min(EYE_MARGIN, 0.4 * Math.max(0, measuredClosed - measuredOpen));
    from = Math.max(from, measuredOpen + margin);
    to = Math.max(to, from + margin);
  }
  return remap(score, from, to);
}
function mouthOpen(jaw: number): number {
  return remap(jaw, calibration?.mouthClosed ?? MOUTH_CLOSED, calibration?.mouthOpen ?? MOUTH_OPEN);
}

/** Posición de reposo de la cabeza (cm) para calcular la inclinación del cuerpo. */
let restPos: { x: number; z: number } | null = null;

/** Aplica el tracking con suavizado exponencial. Devuelve false si no hay datos recientes. */
function applyTracking(model: VRM, delta: number, t: number): boolean {
  if (!target || performance.now() / 1000 - lastTrackingAt > TRACKING_TIMEOUT_S) {
    restPos = null; // al volver el tracking, tomar de nuevo la posición actual como reposo
    return false;
  }
  // Las muestras ya vienen sin temblor (filterFrame): esto solo las une entre cuadros.
  const k = 1 - Math.exp(-delta * FRAME_INTERPOLATION);
  const kEyes = 1 - Math.exp(-delta * 45); // los parpadeos duran ~150 ms: suavizado rápido
  const lerp = (a: number, b: number, f = k) => a + (b - a) * f;
  // Con calibración, "de frente" es la postura que tenía la persona al calibrar
  // (corrige una cámara colocada de costado o más alta).
  const [offPitch, offYaw, offRoll] = calibration?.headOffset ?? [0, 0, 0];
  const pitch = target.head[0] - offPitch;
  const yaw = target.head[1] - offYaw;
  const roll = target.head[2] - offRoll;
  smooth.pitch = lerp(smooth.pitch, pitch);
  smooth.yaw = lerp(smooth.yaw, yaw);
  smooth.roll = lerp(smooth.roll, roll);
  smooth.blinkL = lerp(smooth.blinkL, target.closedLeft ?? eyeClosed(target.blinkLeft, "left"), kEyes);
  smooth.blinkR = lerp(smooth.blinkR, target.closedRight ?? eyeClosed(target.blinkRight, "right"), kEyes);
  // Boca en "o" (la apertura `aa` la calcula applyMouth, combinando cámara y voz).
  smooth.ou = lerp(smooth.ou, Math.min(1, target.mouthFunnel * 1.5), kEyes);
  // Mirada: con los ojos casi cerrados MediaPipe da valores al azar → se mantiene la última.
  if (target.gaze && Math.max(smooth.blinkL, smooth.blinkR) < 0.5) {
    const [offX, offY] = calibration?.gazeOffset ?? [0, 0];
    smooth.gazeYaw = lerp(smooth.gazeYaw, target.gaze[0] - offX, kEyes);
    smooth.gazePitch = lerp(smooth.gazePitch, target.gaze[1] - offY, kEyes);
  }
  applyGaze(model);

  // Cuerpo que acompaña: inclinación según cuánto se movió la cabeza desde su
  // posición de reposo. Con calibración, el reposo es fijo; sin ella, se recalcula
  // despacio (~8 s) a partir de la postura actual.
  const [px, , pz] = target.headPos ?? [0, 0, 0];
  if (calibration) {
    restPos = { x: calibration.restPos[0], z: calibration.restPos[2] };
  } else {
    if (!restPos) restPos = { x: px, z: pz };
    const kRest = 1 - Math.exp(-delta / 8);
    restPos.x = lerp(restPos.x, px, kRest);
    restPos.z = lerp(restPos.z, pz, kRest);
  }
  const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
  smooth.leanSide = lerp(smooth.leanSide, clamp(-(px - restPos.x) * 0.012, 0.25)); // cm → rad
  smooth.leanFwd = lerp(smooth.leanFwd, clamp((pz - restPos.z) * 0.01, 0.2));
  // Acercarse / alejarse de la cámara: el avatar se acerca o se aleja de la suya en la misma
  // proporción (25 % más cerca de tu cámara → 25 % más cerca de la del avatar: se ve igual de
  // más grande). La inclinación de arriba casi no se ve de frente; esto sí.
  const restDistance = Math.max(15, Math.abs(restPos.z)); // cm (z es negativo: delante de la cámara)
  const closer = (pz - restPos.z) / restDistance; // fracción: + = más cerca
  smooth.approach = lerp(
    smooth.approach,
    Math.min(APPROACH_MAX_IN, Math.max(-APPROACH_MAX_OUT, closer)) * cameraDistance,
  );

  // El giro de la cabeza se reparte de la columna a la cabeza: se ve más natural.
  const bone = (name: "spine" | "chest" | "neck" | "head") => model.humanoid?.getNormalizedBoneNode(name);
  const breath = Math.sin(t * 1.6) * 0.015; // respirar también durante el tracking
  for (const [name, share] of [["spine", 0.15], ["chest", 0.15], ["neck", 0.3], ["head", 0.4]] as const) {
    const b = bone(name);
    if (!b) continue;
    let x = smooth.pitch * share;
    let z = smooth.roll * share;
    if (name === "spine") {
      x += smooth.leanFwd;
      z += smooth.leanSide;
    }
    if (name === "chest") x += breath;
    b.rotation.set(x, smooth.yaw * share, z, "YXZ");
  }
  const em = model.expressionManager;
  em?.setValue("blink", 0);
  em?.setValue("blinkLeft", smooth.blinkL);
  em?.setValue("blinkRight", smooth.blinkR);
  applyMouth(model, delta, target.jawOpen, smooth.ou);
  // La sonrisa NO se conecta a "happy": en muchos VRM las emociones bloquean el
  // parpadeo y la boca (overrideBlink/overrideMouth). Las emociones vendrán de los
  // atajos de teclado (Fase 1).
  return true;
}

// --- Expresiones (emociones) ------------------------------------------------
// Se activan con atajos de teclado o botones del panel; se mezclan con un fundido.
// Ojo: cada VRM decide si su emoción bloquea el parpadeo o la boca (overrideBlink/Mouth).

const EMOTIONS = ["happy", "angry", "sad", "surprised", "relaxed"] as const;
let activeExpression: string | null = null;
const emotionWeight: Record<string, number> = Object.fromEntries(EMOTIONS.map((e) => [e, 0]));

function applyExpressions(model: VRM, delta: number) {
  const k = 1 - Math.exp(-delta * 12); // fundido de ~0,2 s
  for (const name of EMOTIONS) {
    const goal = name === activeExpression ? 1 : 0;
    emotionWeight[name] += (goal - emotionWeight[name]) * k;
    if (emotionWeight[name] < 0.001) emotionWeight[name] = 0;
    model.expressionManager?.setValue(name, emotionWeight[name]);
  }
}

// Medidor de FPS para evaluar el rendimiento (sale en el log de OBS).
let frames = 0;
let fpsTimer = 0;

const timer = new THREE.Timer();
renderer.setAnimationLoop((timestamp) => {
  timer.update(timestamp);
  const delta = timer.getDelta();
  const t = timer.getElapsed();
  if (vrm) {
    if (!applyTracking(vrm, delta, t)) {
      idle(vrm, t, delta);
      applyMouth(vrm, delta, null, null);
    }
    applyExpressions(vrm, delta);
    applyGesture(vrm);
    applyApproach(vrm);
    vrm.update(delta);
  }
  updateCamera(delta);
  renderer.render(scene, camera);

  frames++;
  fpsTimer += delta;
  if (fpsTimer >= 10) {
    console.log(`[avat-os] FPS del avatar: ${(frames / fpsTimer).toFixed(1)}`);
    frames = 0;
    fpsTimer = 0;
  }
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// `?v=N` cambia cada vez que se elige otro avatar, para recargar la página.
// `v=0`: todavía no se eligió ninguno (no hay /model.vrm que cargar).
if (new URLSearchParams(location.search).get("v") !== "0") {
  loadModel(`/model.vrm${location.search}`);
}
