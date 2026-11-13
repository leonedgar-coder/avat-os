<!--
  avat-os — Copyright (C) 2026 avat-os contributors
  SPDX-License-Identifier: GPL-3.0-or-later

  Editor de atajos de teclado globales (ver src-tauri/src/shortcuts.rs).
  Al pulsar "Cambiar", los atajos se liberan (shortcuts_pause): si no, Windows se
  queda las combinaciones ya registradas y esta ventana nunca recibiría la pulsación.
-->
<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { onDestroy, onMount } from "svelte";
  import { t, tError, type MessageKey } from "$lib/i18n/index.svelte";
  import { tooltip } from "$lib/tooltip";
  import { rememberOpen } from "$lib/rememberOpen";

  interface ShortcutInfo {
    action: string;
    binding: string | null;
    label: string | null;
    failed: boolean;
  }

  let shortcuts = $state<ShortcutInfo[]>([]);
  let capturing = $state<string | null>(null);
  let preview = $state(""); // modificadores que se están pulsando
  let error = $state<{ action: string; text: string } | null>(null);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const CAPTURE_TIMEOUT_MS = 10000;

  const GROUPS: { title: MessageKey; prefix: string }[] = [
    { title: "shortcutsEditor.groupExpressions", prefix: "expression." },
    { title: "shortcutsEditor.groupGestures", prefix: "gesture." },
    { title: "shortcutsEditor.groupAvatar", prefix: "" },
  ];
  const inGroup = (s: ShortcutInfo, prefix: string) =>
    prefix ? s.action.startsWith(prefix) : !s.action.startsWith("expression.") && !s.action.startsWith("gesture.");

  /** Nombre visible de una acción (en el idioma activo). */
  function actionLabel(action: string): string {
    const [kind, name] = action.split(".");
    if (kind === "expression") return t(`expression.${name}` as MessageKey);
    if (kind === "gesture") return t(`gesture.${name}` as MessageKey);
    if (action === "tracking.toggle") return t("shortcutsEditor.trackingToggle");
    if (action === "lipsync.toggle") return t("shortcutsEditor.lipsyncToggle");
    return action;
  }

  /** Error de Rust → texto; "ya lo usa X" muestra el nombre de la acción, no su id. */
  function errorText(e: unknown): string {
    const raw = String(e);
    if (raw.startsWith("shortcut_duplicate:")) {
      return t("errors.shortcut_duplicate", { detail: actionLabel(raw.split(":")[1].trim()) });
    }
    return tError(e);
  }

  async function refresh() {
    shortcuts = await invoke<ShortcutInfo[]>("shortcuts_get").catch(() => shortcuts);
  }

  /**
   * Tecla para el atajo. `global-hotkey` registra las letras y los símbolos con la tecla
   * virtual de un teclado de EE. UU.; en otros teclados (español, francés…) esa tecla está en
   * otro lugar y el atajo quedaba en otra tecla. `keyCode` es la tecla virtual **real** de
   * Windows con la distribución de la persona: se traduce al nombre que `global-hotkey`
   * asocia a esa misma tecla virtual (p. ej. la ñ latinoamericana, VK_OEM_3 → `Backquote`).
   */
  const VK_TO_CODE: Record<number, string> = {
    186: "Semicolon", 187: "Equal", 188: "Comma", 189: "Minus", 190: "Period", 191: "Slash",
    192: "Backquote", 219: "BracketLeft", 220: "Backslash", 221: "BracketRight", 222: "Quote",
  };
  function hotkeyCode(e: KeyboardEvent): string {
    const vk = e.keyCode;
    if (vk >= 65 && vk <= 90) return `Key${String.fromCharCode(vk)}`;
    if (vk >= 48 && vk <= 57 && e.code.startsWith("Digit")) return `Digit${vk - 48}`;
    return VK_TO_CODE[vk] ?? e.code; // el resto (F1–F24, teclado numérico, flechas…) no cambia de lugar
  }

  const MODIFIER_CODES = new Set(["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"]);

  function modifiersText(e: KeyboardEvent) {
    return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Win"].filter(Boolean).join("+");
  }

  /**
   * Combinación que Windows (u otro programa) se queda antes de que llegue a la ventana: por
   * ejemplo Ctrl+Shift+0 cuando es el atajo de idioma del teclado. La tecla principal nunca
   * llega (ni a Rust, que la rechazaría con su motivo); solo llegan Ctrl, Shift…
   * Se detecta así: se soltaron todos los modificadores sin que llegara ninguna tecla.
   */
  let swallowed = $state<string | null>(null); // los modificadores que se soltaron sin tecla
  let heldMods = ""; // mayor combinación de modificadores desde la última tecla
  const downCodes = new Set<string>(); // teclas principales cuyo "presionar" sí llegó

  function capture(e: KeyboardEvent) {
    const mods = [e.ctrlKey && "control", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "super"].filter(Boolean);
    void save(capturing!, [...mods, hotkeyCode(e)].join("+"));
  }

  function onKey(e: KeyboardEvent) {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      void stopCapture();
      return;
    }
    if (MODIFIER_CODES.has(e.code)) {
      preview = modifiersText(e); // todavía falta la tecla principal
      if (preview.length > heldMods.length) heldMods = preview;
      return;
    }
    downCodes.add(e.code);
    capture(e);
  }
  function onKeyUp(e: KeyboardEvent) {
    if (!capturing) return;
    if (MODIFIER_CODES.has(e.code)) {
      preview = modifiersText(e);
      if (!preview && heldMods) {
        swallowed = heldMods; // se soltó todo y no llegó ninguna tecla
        heldMods = "";
      }
      return;
    }
    // Algunos atajos del sistema se quedan solo el "presionar": si llega el "soltar" de una
    // tecla que no se vio presionar, esa era la tecla. Solo con modificadores: si no, el
    // "soltar" del Enter o Espacio que abrió la captura desde el teclado se tomaría como atajo.
    const withMods = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey;
    if (withMods && !downCodes.has(e.code)) {
      e.preventDefault();
      e.stopPropagation();
      capture(e);
    }
  }

  async function startCapture(action: string) {
    error = null;
    preview = "";
    swallowed = null;
    heldMods = "";
    downCodes.clear();
    capturing = action;
    await invoke("shortcuts_pause", { paused: true }).catch(() => {});
    clearTimeout(timeout);
    timeout = setTimeout(() => void stopCapture(), CAPTURE_TIMEOUT_MS);
  }

  async function stopCapture() {
    clearTimeout(timeout);
    if (!capturing) return;
    capturing = null;
    preview = "";
    await invoke("shortcuts_pause", { paused: false }).catch(() => {});
    await refresh();
  }

  async function save(action: string, binding: string | null) {
    try {
      await invoke("shortcuts_set", { action, binding });
      error = null;
    } catch (e) {
      error = { action, text: errorText(e) };
    }
    await stopCapture();
    await refresh(); // también al "Quitar", que no pasa por una captura
  }

  async function reset() {
    error = null;
    await invoke("shortcuts_reset").catch((e) => (error = { action: "", text: errorText(e) }));
    await refresh();
  }

  let unlisten: Promise<() => void> | undefined;
  onMount(() => {
    refresh();
    unlisten = listen("shortcuts-changed", refresh).catch(() => () => {});
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
  });
  onDestroy(() => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKeyUp, true);
    unlisten?.then((off) => off());
    if (capturing) invoke("shortcuts_pause", { paused: false }).catch(() => {});
  });
</script>

<details class="editor" use:rememberOpen={"atajos"}>
  <summary use:tooltip={t("tooltips.shortcutsEditor")}>{t("shortcutsEditor.title")}</summary>
  <div class="body">
    {#each GROUPS as group}
      <span class="group">{t(group.title)}</span>
      {#each shortcuts.filter((s) => inGroup(s, group.prefix)) as s (s.action)}
        <div class="row" class:capturing={capturing === s.action}>
          <span class="name">{actionLabel(s.action)}</span>
          {#if capturing === s.action}
            <span class="keys live" role="status">{preview ? `${preview}+…` : t("shortcutsEditor.capturing")}</span>
          {:else}
            <kbd class:failed={s.failed} title={s.failed ? t("shortcutsEditor.failed") : ""}>
              {s.label ?? t("shortcutsEditor.none")}
            </kbd>
          {/if}
          <span class="buttons">
            {#if capturing === s.action}
              <button class="link" onclick={stopCapture}>{t("shortcutsEditor.cancel")}</button>
            {:else}
              <button class="link" onclick={() => startCapture(s.action)} disabled={capturing !== null} use:tooltip={t("tooltips.shortcutChange")}>
                {t("shortcutsEditor.change")}
              </button>
              {#if s.binding}
                <button class="link" onclick={() => save(s.action, null)} disabled={capturing !== null} use:tooltip={t("tooltips.shortcutRemove")}>
                  {t("shortcutsEditor.remove")}
                </button>
              {/if}
            {/if}
          </span>
        </div>
        {#if error?.action === s.action}<p class="error">{error.text}</p>{/if}
      {/each}
    {/each}
    {#if capturing && swallowed}<p class="error" role="status">{t("shortcutsEditor.swallowed", { detail: swallowed })}</p>{/if}
    {#if capturing}<p class="hint">{t("shortcutsEditor.capturingHint")}</p>{/if}
    {#if error?.action === ""}<p class="error">{error.text}</p>{/if}
    <button class="link reset" onclick={reset} disabled={capturing !== null} use:tooltip={t("tooltips.shortcutsReset")}>
      {t("shortcutsEditor.reset")}
    </button>
  </div>
</details>

<style>
  .editor { padding: 8px 0; border-bottom: 1px solid var(--border); }
  summary { cursor: pointer; user-select: none; }
  summary:hover { color: var(--orange); }
  .body { padding-top: 4px; font-size: 12px; }
  .group { display: block; margin: 8px 0 2px; color: var(--purple); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .row { display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto; align-items: center; column-gap: 6px; padding: 3px 4px; border-radius: 4px; }
  .row.capturing { background: rgba(255, 138, 42, 0.12); outline: 1px solid var(--orange); }
  .name { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  kbd, .keys { font-family: inherit; font-size: 11px; color: var(--muted); justify-self: end; }
  kbd.failed { color: #fcd34d; text-decoration: underline wavy; }
  .keys.live { color: var(--orange); font-weight: 600; }
  .buttons { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 10px; }
  .link {
    border: 0; background: transparent; padding: 0; color: var(--purple);
    font: inherit; font-size: 11px; cursor: pointer; text-decoration: underline;
  }
  .link:hover { color: var(--orange); }
  .link:disabled { color: var(--muted); cursor: not-allowed; text-decoration: none; }
  .hint { color: var(--muted); font-size: 11px; margin: 6px 0; }
  .error { color: var(--danger); font-size: 11px; margin: 2px 4px 4px; }
  .reset { display: block; margin: 8px 0 0 auto; }
</style>
