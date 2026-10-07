/**
 * desktop/vite.config.ts — builds the desktop renderer bundle.
 *
 * - root: `desktop/src/renderer` (index.html lives at the bundle root).
 * - outDir: `dist/desktop/src/renderer` — exactly where the main process
 *   loads it (`main.ts` `rendererIndexPath()`).
 * - base './': relative asset URLs, so the bundle works over `file://`.
 * - dev server: 127.0.0.1:5173 — the main process loads it ONLY when
 *   AIMY_DEV=1 is set (see main.ts); never in a shipped build.
 */
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

const HERE = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.join(HERE, "src", "renderer"),
  base: "./",
  build: {
    outDir: path.join(HERE, "..", "dist", "desktop", "src", "renderer"),
    emptyOutDir: true,
    sourcemap: false,
    minify: "esbuild",
    target: "es2022"
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
})
