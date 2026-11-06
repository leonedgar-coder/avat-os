// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Renderizador del avatar. Esta página la carga OBS como "fuente de navegador"
// con fondo transparente. El modelo se sirve desde el servidor local de avat-os
// en /model.vrm.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

// Cámara a la altura del pecho/cabeza (plano medio, típico de VTuber).
const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 20);
camera.position.set(0, 1.35, 1.9);
camera.lookAt(0, 1.3, 0);

const scene = new THREE.Scene();
const light = new THREE.DirectionalLight(0xffffff, Math.PI);
light.position.set(1, 1, 1).normalize();
scene.add(light, new THREE.AmbientLight(0xffffff, 0.4));

let vrm: VRM | null = null;

async function loadModel(url: string) {
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
    scene.add(loaded.scene);
    vrm = loaded;
    const meta = loaded.meta;
    const name = meta && ("name" in meta ? meta.name : meta.title); // VRM 1.0 : VRM 0.x
    console.log(`[avat-os] Avatar cargado: ${name ?? "sin nombre"}`);
  } catch (e) {
    console.error(`[avat-os] No se pudo cargar el avatar: ${e}`);
  }
}

/** Baja los brazos desde la pose en T. */
function restPose(model: VRM) {
  const bone = (name: Parameters<NonNullable<VRM["humanoid"]>["getNormalizedBoneNode"]>[0]) =>
    model.humanoid?.getNormalizedBoneNode(name);
  const l = bone("leftUpperArm");
  const r = bone("rightUpperArm");
  if (l) l.rotation.z = -1.2;
  if (r) r.rotation.z = 1.2;
}

// Animación en reposo: respiración, balanceo suave y parpadeo automático.
let nextBlink = 2;
let blinkStart = -1;
function idle(model: VRM, t: number) {
  const spine = model.humanoid?.getNormalizedBoneNode("spine");
  const neck = model.humanoid?.getNormalizedBoneNode("neck");
  const head = model.humanoid?.getNormalizedBoneNode("head");
  spine?.rotation.set(Math.sin(t * 1.6) * 0.015, 0, 0);
  model.humanoid?.getNormalizedBoneNode("chest")?.rotation.set(0, 0, 0); // limpiar lo del tracking
  neck?.rotation.set(0, 0, 0);
  head?.rotation.set(0, Math.sin(t * 0.5) * 0.05, Math.sin(t * 0.7) * 0.02);

  // Limpiar lo que haya dejado el tracking.
  const em = model.expressionManager;
  for (const name of ["blinkLeft", "blinkRight", "aa", "ou"]) em?.setValue(name, 0);

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
  blinkLeft: number;
  blinkRight: number;
  jawOpen: number;
  mouthFunnel: number;
  smile: number;
}

/** Mensajes del canal en vivo (ver tracking_relay.rs). */
type ChannelMessage =
  | { type: "tracking"; avatar: string; frame: TrackingFrame }
  | { type: "expression"; avatar: string; name: string | null };

/** Identificador de este avatar (`?id=` en la URL; hoy siempre "main"). */
const AVATAR_ID = new URLSearchParams(location.search).get("id") ?? "main";

let target: TrackingFrame | null = null;
let lastTrackingAt = 0;
const TRACKING_TIMEOUT_S = 0.5; // sin datos durante este tiempo → animación en reposo
// Valores suavizados que se aplican al avatar.
const smooth = {
  pitch: 0, yaw: 0, roll: 0, leanSide: 0, leanFwd: 0,
  blinkL: 0, blinkR: 0, aa: 0, ou: 0,
};

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
      target = msg.frame;
      lastTrackingAt = performance.now() / 1000;
    } else if (msg.type === "expression") {
      activeExpression = msg.name;
    }
  };
  ws.onclose = () => setTimeout(connectTracking, 1000); // reconectar
}
connectTracking();

// MediaPipe rara vez llega a 1.0 con el ojo cerrado (suele dar 0.5–0.7):
// por debajo de EYE_OPEN el ojo queda abierto y desde EYE_CLOSED, cerrado del todo.
// TODO(Fase 1 · calibración): ajustar estos umbrales por usuario.
const EYE_OPEN = 0.2;
const EYE_CLOSED = 0.55;
function eyeClosed(score: number): number {
  return Math.min(1, Math.max(0, (score - EYE_OPEN) / (EYE_CLOSED - EYE_OPEN)));
}
// Boca: por debajo de MOUTH_CLOSED queda cerrada (evita temblor) y desde MOUTH_OPEN, abierta del todo.
const MOUTH_CLOSED = 0.03;
const MOUTH_OPEN = 0.35;
function mouthOpen(jaw: number): number {
  return Math.min(1, Math.max(0, (jaw - MOUTH_CLOSED) / (MOUTH_OPEN - MOUTH_CLOSED)));
}

/** Posición de reposo de la cabeza (cm) para calcular la inclinación del cuerpo. */
let restPos: { x: number; z: number } | null = null;

/** Aplica el tracking con suavizado exponencial. Devuelve false si no hay datos recientes. */
function applyTracking(model: VRM, delta: number, t: number): boolean {
  if (!target || performance.now() / 1000 - lastTrackingAt > TRACKING_TIMEOUT_S) {
    restPos = null; // al volver el tracking, tomar de nuevo la posición actual como reposo
    return false;
  }
  const k = 1 - Math.exp(-delta * 18); // más alto = responde más rápido, tiembla más
  const kEyes = 1 - Math.exp(-delta * 45); // los parpadeos duran ~150 ms: suavizado rápido
  const lerp = (a: number, b: number, f = k) => a + (b - a) * f;
  const [pitch, yaw, roll] = target.head;
  smooth.pitch = lerp(smooth.pitch, pitch);
  smooth.yaw = lerp(smooth.yaw, yaw);
  smooth.roll = lerp(smooth.roll, roll);
  smooth.blinkL = lerp(smooth.blinkL, eyeClosed(target.blinkLeft), kEyes);
  smooth.blinkR = lerp(smooth.blinkR, eyeClosed(target.blinkRight), kEyes);
  // Al hablar, MediaPipe da jawOpen de ~0.1–0.3: se amplifica para que la boca se note.
  // La boca responde tan rápido como los ojos (las sílabas también son cortas).
  smooth.aa = lerp(smooth.aa, mouthOpen(target.jawOpen), kEyes);
  smooth.ou = lerp(smooth.ou, Math.min(1, target.mouthFunnel * 1.5), kEyes);

  // Cuerpo que acompaña: inclinación según cuánto se movió la cabeza desde su
  // posición de reposo (que se recalcula despacio, ~8 s, mientras no haya calibración).
  const [px, , pz] = target.headPos ?? [0, 0, 0];
  if (!restPos) restPos = { x: px, z: pz };
  const kRest = 1 - Math.exp(-delta / 8);
  restPos.x = lerp(restPos.x, px, kRest);
  restPos.z = lerp(restPos.z, pz, kRest);
  const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
  smooth.leanSide = lerp(smooth.leanSide, clamp(-(px - restPos.x) * 0.012, 0.25)); // cm → rad
  smooth.leanFwd = lerp(smooth.leanFwd, clamp((pz - restPos.z) * 0.01, 0.2));

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
  em?.setValue("aa", smooth.aa);
  em?.setValue("ou", smooth.ou);
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
    if (!applyTracking(vrm, delta, t)) idle(vrm, t);
    applyExpressions(vrm, delta);
    vrm.update(delta);
  }
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
loadModel(`/model.vrm${location.search}`);
