// Compila la página del avatar (la que OBS carga como fuente de navegador).
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
