// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tooltips accesibles para explicar opciones que no son obvias.
//
//   <button use:tooltip={t("tooltips.loadAvatar")}>…</button>
//
// - Aparece al pasar el mouse (tras ~0,4 s) y al enfocar con el teclado; se cierra
//   al salir, al perder el foco o con Esc.
// - Accesible: el texto se enlaza con `aria-describedby` (los lectores de pantalla
//   lo leen) y el elemento tiene `role="tooltip"`.
// - Nunca se coloca encima de la vista previa: es una ventana nativa de OBS que está
//   por encima de la web y lo taparía. Esa zona se marca con `data-native-overlay`.
// - Si el texto cambia (p. ej. al cambiar de idioma), se actualiza solo.

import type { Action } from "svelte/action";

const SHOW_DELAY_MS = 400;
const GAP = 8; // separación entre el control y el tooltip (px)
const MARGIN = 6; // margen mínimo con los bordes de la ventana (px)

let counter = 0;

type Rect = { left: number; top: number; right: number; bottom: number };

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Zonas tapadas por ventanas nativas (la vista previa de OBS). */
function nativeOverlays(): Rect[] {
  return [...document.querySelectorAll<HTMLElement>("[data-native-overlay]")].map((e) => e.getBoundingClientRect());
}

/** Elige abajo, arriba, izquierda o derecha: la primera que cabe y no pisa la vista previa. */
function place(anchor: DOMRect, tip: DOMRect): { x: number; y: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampX = (x: number) => Math.min(Math.max(x, MARGIN), vw - tip.width - MARGIN);
  const clampY = (y: number) => Math.min(Math.max(y, MARGIN), vh - tip.height - MARGIN);
  const cx = anchor.left + anchor.width / 2 - tip.width / 2;
  const cy = anchor.top + anchor.height / 2 - tip.height / 2;
  const candidates = [
    { x: clampX(cx), y: anchor.bottom + GAP }, // abajo
    { x: clampX(cx), y: anchor.top - GAP - tip.height }, // arriba
    { x: anchor.left - GAP - tip.width, y: clampY(cy) }, // izquierda
    { x: anchor.right + GAP, y: clampY(cy) }, // derecha
  ];
  const overlays = nativeOverlays();
  type Pos = { x: number; y: number };
  const fits = (c: Pos) =>
    c.x >= MARGIN && c.y >= MARGIN && c.x + tip.width <= vw - MARGIN && c.y + tip.height <= vh - MARGIN;
  const covered = (c: Pos) =>
    overlays.some((o) => intersects({ left: c.x, top: c.y, right: c.x + tip.width, bottom: c.y + tip.height }, o));
  // Si una posición apenas pisa la vista previa, probar a correrla hacia un costado de ella.
  const nudged = candidates.flatMap((c) =>
    overlays.flatMap((o) => [
      { x: o.right + MARGIN, y: c.y },
      { x: o.left - MARGIN - tip.width, y: c.y },
      { x: c.x, y: o.bottom + MARGIN },
      { x: c.x, y: o.top - MARGIN - tip.height },
    ]),
  );
  return (
    candidates.find((c) => fits(c) && !covered(c)) ??
    nudged.find((c) => fits(c) && !covered(c)) ??
    // Sin opción perfecta: mejor dentro de la ventana (aunque lo tape la vista previa)
    // que fuera de ella, donde nunca se vería.
    candidates.find(fits) ??
    candidates[0]
  );
}

export const tooltip: Action<HTMLElement, string | null | undefined> = (node, initial) => {
  let text = initial ?? "";
  const tip = document.createElement("div");
  tip.id = `avatos-tooltip-${++counter}`;
  tip.className = "avatos-tooltip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  tip.textContent = text;
  document.body.append(tip);
  // Enlazado siempre (aunque esté oculto): así el lector de pantalla lo lee al enfocar.
  if (text) node.setAttribute("aria-describedby", tip.id);

  let timer: ReturnType<typeof setTimeout> | undefined;

  function show() {
    clearTimeout(timer);
    if (!text) return;
    tip.style.visibility = "hidden";
    // Medir desde (0,0): si no, el navegador calcula el ancho desde una posición
    // provisional y al moverlo cambia de tamaño (podía salirse de la ventana).
    tip.style.left = "0px";
    tip.style.top = "0px";
    tip.hidden = false;
    const pos = place(node.getBoundingClientRect(), tip.getBoundingClientRect());
    tip.style.left = `${Math.round(pos.x)}px`;
    tip.style.top = `${Math.round(pos.y)}px`;
    tip.style.visibility = "";
    document.addEventListener("keydown", onKeydown, true);
  }
  function hide() {
    clearTimeout(timer);
    tip.hidden = true;
    document.removeEventListener("keydown", onKeydown, true);
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") hide();
  }
  const onEnter = () => {
    clearTimeout(timer);
    timer = setTimeout(show, SHOW_DELAY_MS);
  };
  // Con el teclado se muestra al instante; con un clic del mouse, no (evita parpadeos).
  const onFocus = () => {
    if (node.matches(":focus-visible")) show();
  };

  node.addEventListener("pointerenter", onEnter);
  node.addEventListener("pointerleave", hide);
  node.addEventListener("pointerdown", hide);
  node.addEventListener("focus", onFocus);
  node.addEventListener("blur", hide);

  return {
    update(next) {
      text = next ?? "";
      tip.textContent = text;
      if (!text) {
        node.removeAttribute("aria-describedby");
        hide();
        return;
      }
      node.setAttribute("aria-describedby", tip.id);
      if (!tip.hidden) show(); // el texto cambió de largo (p. ej. otro idioma): recolocar
    },
    destroy() {
      hide();
      node.removeEventListener("pointerenter", onEnter);
      node.removeEventListener("pointerleave", hide);
      node.removeEventListener("pointerdown", hide);
      node.removeEventListener("focus", onFocus);
      node.removeEventListener("blur", hide);
      node.removeAttribute("aria-describedby");
      tip.remove();
    },
  };
};
