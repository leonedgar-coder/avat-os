// avat-os — Copyright (C) 2026 avat-os contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Idiomas de la interfaz. Los textos viven en un JSON por idioma (es.json es el
// idioma fuente y el respaldo). Para agregar un idioma: copiar es.json como
// <código>.json, traducirlo y registrarlo en LOCALES y DICTS.
//
//   import { t, i18n } from "$lib/i18n/index.svelte";
//   t("tracking.fps", { fps: 30 })   → "30 FPS"
//   i18n.locale = "en"               → cambia el idioma (se recuerda)

import es from "./es.json";
import en from "./en.json";

type Dict = typeof es;

/** Todas las claves válidas ("avatar.load", "tracking.fps", …): un error de tipos avisa si no existe. */
type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];
export type MessageKey = Leaves<Dict>;

/** Idiomas disponibles, con su nombre en su propio idioma (para el selector). */
export const LOCALES = { es: "Español", en: "English" } as const;
export type Locale = keyof typeof LOCALES;

// Cada traducción debe tener todas las claves de es.json (si falta una, falla la compilación).
const DICTS: Record<Locale, Dict> = { es, en };

const STORAGE_KEY = "avatos.locale";

/** Idioma guardado; si no hay, el de Windows (WebView2 lo informa); si no está disponible, inglés. */
function detect(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved in LOCALES) return saved as Locale;
  } catch {
    /* almacenamiento no disponible: se ignora */
  }
  for (const lang of navigator.languages ?? [navigator.language]) {
    const base = lang.toLowerCase().split("-")[0];
    if (base in LOCALES) return base as Locale;
  }
  return "en";
}

let current = $state<Locale>(detect());
document.documentElement.lang = current;

export const i18n = {
  get locale(): Locale {
    return current;
  },
  set locale(value: Locale) {
    current = value;
    document.documentElement.lang = value;
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* no se pudo guardar: se usará el idioma detectado la próxima vez */
    }
  },
};

function lookup(dict: unknown, key: string): string | undefined {
  let node: unknown = dict;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** Texto traducido. `{nombre}` se reemplaza con `params.nombre`. Reactivo al cambiar de idioma. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const text = lookup(DICTS[current], key) ?? lookup(es, key) ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

/**
 * Traduce un error de un comando de Rust. Rust envía un código (`avatar_invalid_file`)
 * o `código: detalle` (`internal: …`); los códigos están en `errors.*`.
 */
export function tError(error: unknown): string {
  const raw = String(error);
  const sep = raw.indexOf(":");
  const code = (sep >= 0 ? raw.slice(0, sep) : raw).trim();
  const detail = sep >= 0 ? raw.slice(sep + 1).trim() : "";
  const key = `errors.${code}`;
  return lookup(DICTS[current], key) || lookup(es, key)
    ? t(key as MessageKey, { detail })
    : t("errors.internal", { detail: raw });
}
