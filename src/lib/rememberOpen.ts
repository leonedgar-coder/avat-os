// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Acción de Svelte para los desplegables (<details>): recuerda si se dejaron abiertos
// o cerrados, en este equipo. Uso: <details use:rememberOpen={"efectos"}>.
// Es solo una comodidad: si no se puede guardar (almacenamiento bloqueado), se ignora.

const PREFIX = "avatos.open.";

export function rememberOpen(node: HTMLDetailsElement, key: string) {
  try {
    const saved = localStorage.getItem(PREFIX + key);
    if (saved !== null) node.open = saved === "1";
  } catch {
    /* sin almacenamiento: queda como está en el HTML */
  }
  const onToggle = () => {
    try {
      localStorage.setItem(PREFIX + key, node.open ? "1" : "0");
    } catch {
      /* no se pudo guardar: se olvidará al cerrar */
    }
  };
  node.addEventListener("toggle", onToggle);
  return {
    destroy() {
      node.removeEventListener("toggle", onToggle);
    },
  };
}
