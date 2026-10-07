/**
 * desktop/src/main/main.ts — Electron main process for AImy.
 *
 * M10 Track 1. Boots the Effect engine (`./engine.ts`), opens one window,
 * wires the IPC surface (`../ipc/handlers.ts`).
 *
 * ── SECURITY POSTURE (locked; see desktop/DECISION.md) ────────────────────
 * - `contextIsolation: true` — renderer and preload run in separate worlds;
 *   the only bridge is the explicit `contextBridge` API Track 2 defines in
 *   `src/preload.ts` against `src/ipc/protocol.ts`.
 * - `nodeIntegration: false` — the renderer never gets Node. Not negotiable.
 * - `sandbox: true` — the renderer is an OS-sandboxed process; even a full
 *   renderer compromise gets no filesystem, no process spawn, no network
 *   beyond what the preload bridge allows.
 * - `webSecurity: true` — same-origin policy enforced, always.
 * - The preload script is the ONLY code the renderer process loads with
 *   privileges; it exposes nothing but the IPC contract (command/event tags
 *   allowlisted in `protocol.ts`).
 * - NO remote content: prod loads the bundled `file://` renderer only; a
 *   Content-Security-Policy is forced on every response via
 *   `onHeadersReceived` (`default-src 'none'` — local `file:`/bundle
 *   resources are explicitly allowed, nothing else is).
 * - NO auto-updater: `electron-updater` is deliberately not installed.
 *   Updates are staged, explicit, user-initiated (architecture §2.2).
 * - NO telemetry: this process makes zero network calls. The only network
 *   the app ever makes is the model endpoint and declared module egress —
 *   both user-configured, local by default, never to us.
 * - The dev server (`http://127.0.0.1:5173`) loads ONLY when `AIMY_DEV=1`
 *   is explicitly set in the environment. It is never the default and never
 *   reachable in a shipped build.
 * ──────────────────────────────────────────────────────────────────────────
 */
import { app, BrowserWindow, dialog, ipcMain, session } from "electron"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { bootDesktopEngine, type DesktopEngine } from "./engine.js"
import { registerIpc } from "../ipc/handlers.js"

/** ESM has no `__dirname`; derive it from the module URL. */
const hereDir = (): string => path.dirname(fileURLToPath(import.meta.url))

/**
 * Preload location contract with Track 2: `src/preload.ts` bundles to
 * `dist/preload.cjs`. NOTE the `.cjs`: Electron does not support ESM
 * imports in *sandboxed* preload scripts, so the preload is bundled to a
 * single CJS file (see the PACKAGING NOTE in `src/preload.ts` and the
 * `desktop:preload` build step) — raw tsc ESM output will not load under
 * `sandbox: true`. This file compiles to `dist/main/main.js`.
 */
const preloadPath = (): string => path.join(hereDir(), "..", "preload.cjs")

/**
 * Renderer bundle contract with Track 3: the Foldkit/vite build emits
 * `dist/renderer/index.html` (Track 3 owns the npm scripts + builder config).
 */
const rendererIndexPath = (): string => path.join(hereDir(), "..", "renderer", "index.html")

const DEV_URL = "http://127.0.0.1:5173"

/**
 * Force a no-remote-content CSP on every loaded resource. `default-src
 * 'none'` + explicit allowances for the bundled renderer (`file:`) and, in
 * dev, the loopback dev server. No `https:`, no `wss:`, no `data:` images
 * beyond what the bundle needs — remote content simply cannot load.
 */
const enforceCsp = (): void => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const dev = process.env.AIMY_DEV === "1"
    const policy = dev
      ? "default-src 'none'; script-src 'self' http://127.0.0.1:5173; style-src 'self' 'unsafe-inline' http://127.0.0.1:5173; img-src 'self' data: http://127.0.0.1:5173; connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173"
      : "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'self'"
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy]
      }
    })
  })
}

const createWindow = (): BrowserWindow => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    // SECURITY: see the posture block at the top of this file.
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: preloadPath()
    },
    show: false
  })
  win.once("ready-to-show", () => win.show())

  if (process.env.AIMY_DEV === "1") {
    // DEV ONLY: loopback dev server, never the default, never in shipped builds.
    void win.loadURL(DEV_URL)
  } else {
    // PROD: the local bundled renderer. No remote content, ever.
    void win.loadFile(rendererIndexPath())
  }
  return win
}

let engine: DesktopEngine | undefined

/** Present only in `--smoke-test` runs (M10 Track 3 acceptance). */
const SMOKE = process.argv.includes("--smoke-test")
const SMOKE_STUB_URL = "http://127.0.0.1:18000"

/**
 * Smoke-test flow (Track 3): drives the real renderer through the DOM
 * against the real engine + real IPC handlers, model endpoint pointed at
 * the stub server. Writes `smoke-results.json` + `smoke.png` to
 * `AIMY_SMOKE_DIR` (default `<cwd>/desktop/smoke`), then quits with the
 * pass/fail exit code. A watchdog quits the app if the flow hangs.
 */
const runSmokeFlow = async (win: BrowserWindow): Promise<void> => {
  const outDir = process.env.AIMY_SMOKE_DIR ?? path.resolve("desktop", "smoke")
  const tmpRoot = path.join(os.tmpdir(), "aimy-smoke")
  const configFile = path.join(tmpRoot, "desktop.json")
  console.log("smoke: runSmokeFlow started")
  const watchdog = setTimeout(() => {
    console.error("smoke: watchdog fired — flow hung")
    process.exitCode = 1
    app.quit()
  }, 8 * 60 * 1000)
  watchdog.unref()
  try {
    console.log("smoke: importing driver…")
    const { runSmokeTestSafe } = await import("../../smoke/driver.js")
    console.log("smoke: driver imported, running…")
    const results = await runSmokeTestSafe(win, {
      outDir,
      configFile,
      stubUrl: SMOKE_STUB_URL,
      exportDestDir: path.join(tmpRoot, "export-dest")
    })
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, "smoke-results.json"), JSON.stringify(results, null, 2))
    for (const check of results.checks) {
      console.log(`smoke: ${check.pass ? "ok  " : "FAIL"} - ${check.name}${check.detail !== undefined ? ` (${check.detail})` : ""}`)
    }
    process.exitCode = results.pass ? 0 : 1
  } catch (error) {
    console.error(`smoke: flow failed: ${String(error)}`)
    process.exitCode = 1
  } finally {
    clearTimeout(watchdog)
    app.quit()
  }
}

const boot = async (): Promise<void> => {
  enforceCsp()
  try {
    engine = SMOKE
      ? await bootDesktopEngine({
          baseUrl: SMOKE_STUB_URL,
          model: "smoke-test-model",
          configFile: path.join(os.tmpdir(), "aimy-smoke", "desktop.json")
        })
      : await bootDesktopEngine()
  } catch (error) {
    // Fail loudly: a desktop that silently shows an empty window is a lie.
    // In --smoke-test there is no user to dismiss a dialog — log and quit
    // instead of blocking on showErrorBox forever.
    if (SMOKE) {
      console.error(`smoke: engine failed to boot: ${String(error)}`)
      process.exitCode = 1
      app.quit()
      return
    }
    await dialog.showErrorBox(
      "AImy failed to start",
      `The engine failed to boot:\n\n${String(error)}\n\nCheck ~/.aimy/desktop.json (baseUrl, model).`
    )
    app.quit()
    return
  }
  registerIpc(ipcMain, engine)
  console.log(`smoke: boot complete, SMOKE=${SMOKE}`)
  const win = createWindow()
  console.log("smoke: window created")
  if (SMOKE) await runSmokeFlow(win)
}

void app.whenReady().then(boot)

app.on("window-all-closed", () => {
  // macOS convention: keep the app alive until explicit quit.
  if (process.platform !== "darwin") void app.quit()
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on("before-quit", () => {
  const e = engine
  engine = undefined
  if (e !== undefined) void e.shutdown()
})
