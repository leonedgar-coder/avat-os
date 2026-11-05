<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { onMount } from "svelte";

  // Datos de ejemplo: se reemplazan cuando conectemos libobs (Fase 2).
  let scenes = $state(["Escena principal", "Pantalla de inicio"]);
  let activeScene = $state(0);
  let sources = $state([
    { name: "Avatar", kind: "avatar", visible: true },
    { name: "Cámara", kind: "camera", visible: false },
    { name: "Pantalla", kind: "display", visible: true },
  ]);
  let mixer = $state([
    { name: "Micrófono", level: 0.62, muted: false },
    { name: "Escritorio", level: 0.35, muted: false },
  ]);
  let recording = $state(false);
  let version = $state("");

  onMount(async () => {
    try {
      version = await invoke<string>("app_version");
    } catch {
      version = "dev";
    }
  });
</script>

<div class="app">
  <header class="topbar">
    <img src="/logo.png" alt="" class="logo" />
    <span class="brand">avat<span class="accent">-os</span></span>
    <span class="version">v{version}</span>
  </header>

  <main class="workspace">
    <section class="preview" aria-label="Vista previa">
      <div class="canvas">
        <p>Vista previa de la escena</p>
        <small>(se conecta a libobs en la Fase 0 · Spike 2)</small>
      </div>
    </section>

    <aside class="side" aria-label="Avatar">
      <h2>Avatar</h2>
      <button class="btn">Cargar avatar .vrm</button>
      <div class="field"><span>Tracking facial</span><span class="pill off">apagado</span></div>
      <div class="field"><span>Lip-sync</span><span class="pill off">apagado</span></div>
      <div class="field"><span>Fondo</span><span>Transparente</span></div>
    </aside>
  </main>

  <footer class="docks">
    <section class="dock">
      <h2>Escenas</h2>
      <ul>
        {#each scenes as scene, i}
          <li>
            <button class="row" class:active={i === activeScene} onclick={() => (activeScene = i)}>
              {scene}
            </button>
          </li>
        {/each}
      </ul>
    </section>

    <section class="dock">
      <h2>Fuentes</h2>
      <ul>
        {#each sources as source}
          <li class="row static">
            <span>{source.name}</span>
            <button class="icon" onclick={() => (source.visible = !source.visible)} aria-label="Mostrar u ocultar">
              {source.visible ? "👁" : "—"}
            </button>
          </li>
        {/each}
      </ul>
    </section>

    <section class="dock wide">
      <h2>Mezclador de audio</h2>
      {#each mixer as ch}
        <div class="channel">
          <span class="ch-name">{ch.name}</span>
          <div class="meter"><div class="meter-fill" style="width: {ch.muted ? 0 : ch.level * 100}%"></div></div>
          <button class="icon" onclick={() => (ch.muted = !ch.muted)} aria-label="Silenciar">
            {ch.muted ? "🔇" : "🔊"}
          </button>
        </div>
      {/each}
    </section>

    <section class="dock controls">
      <h2>Controles</h2>
      <button class="btn rec" class:on={recording} onclick={() => (recording = !recording)}>
        {recording ? "Detener grabación" : "Iniciar grabación"}
      </button>
      <button class="btn ghost">Ajustes</button>
    </section>
  </footer>
</div>

<style>
  :root {
    --bg: #0e0d16;
    --panel: #171528;
    --panel-2: #1f1c36;
    --border: #2d2950;
    --text: #ece9ff;
    --muted: #9a94c4;
    --orange: #ff8a2a;
    --purple: #a24dff;
    --danger: #ff4d6d;
    font-family: "Segoe UI", Inter, system-ui, sans-serif;
    font-size: 14px;
    color: var(--text);
    background: var(--bg);
  }
  :global(body) {
    margin: 0;
    background: var(--bg);
    overflow: hidden;
  }
  .app {
    display: grid;
    grid-template-rows: 44px 1fr 220px;
    height: 100vh;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  .logo { width: 28px; height: 28px; border-radius: 50%; }
  .brand { font-weight: 700; font-size: 16px; letter-spacing: 0.3px; }
  .accent { color: var(--orange); }
  .version { color: var(--muted); font-size: 12px; margin-left: auto; }

  .workspace {
    display: grid;
    grid-template-columns: 1fr 260px;
    min-height: 0;
  }
  .preview {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    min-height: 0;
  }
  .canvas {
    aspect-ratio: 16 / 9;
    max-height: 100%;
    max-width: 100%;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: #000;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--muted);
  }
  .canvas p { margin: 0 0 4px; font-size: 16px; }

  .side, .dock {
    background: var(--panel);
    border-left: 1px solid var(--border);
    padding: 12px;
    overflow: auto;
  }
  h2 {
    margin: 0 0 10px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--purple);
  }
  .field {
    display: flex;
    justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .pill { font-size: 12px; padding: 1px 8px; border-radius: 99px; background: var(--panel-2); color: var(--muted); }

  .docks {
    display: grid;
    grid-template-columns: 1fr 1fr 1.6fr 220px;
    border-top: 1px solid var(--border);
    min-height: 0;
  }
  ul { list-style: none; margin: 0; padding: 0; }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    margin-bottom: 2px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row:hover, .row.static:hover { background: var(--panel-2); }
  .row.static { cursor: default; }
  .row.active { background: linear-gradient(90deg, rgba(255, 138, 42, 0.25), rgba(162, 77, 255, 0.2)); }

  .channel { display: grid; grid-template-columns: 90px 1fr 32px; align-items: center; gap: 8px; margin-bottom: 12px; }
  .ch-name { color: var(--muted); }
  .meter { height: 8px; background: var(--panel-2); border-radius: 4px; overflow: hidden; }
  .meter-fill { height: 100%; background: linear-gradient(90deg, var(--orange), var(--purple)); transition: width 0.2s; }

  .btn {
    display: block;
    width: 100%;
    padding: 9px 12px;
    margin-bottom: 8px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: linear-gradient(90deg, var(--orange), var(--purple));
    color: #fff;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .btn.ghost { background: transparent; border-color: var(--border); color: var(--text); }
  .btn.rec.on { background: var(--danger); }
  .icon { border: 0; background: transparent; color: var(--text); cursor: pointer; font-size: 14px; }
</style>
