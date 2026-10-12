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
import { app, BrowserWindow, dialog, ipcMain, Menu, session } from "electron"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { bootDesktopEngine, type DesktopEngine } from "./engine.js"
import { registerIpc } from "../ipc/handlers.js"
import type { TraceWriter } from "./trace.js"

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
      ? "default-src 'none'; script-src 'self' http://127.0.0.1:5173; style-src 'self' 'unsafe-inline' http://127.0.0.1:5173; img-src 'self' data: http://127.0.0.1:5173; media-src 'self' data: blob: http://127.0.0.1:5173; connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173"
      : "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'self' data: blob:"
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
let ipcCleanupHandle: { readonly stop: () => void; readonly trace: TraceWriter } | undefined

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
  // User-defined startup hooks (2026-10-10): run executables from
  // ~/.aimy/hooks/startup.d/ before the engine boots. The app provides
  // the hook paradigm; the user provides the scripts (e.g. SSH tunnel
  // setup for remote providers).
  if (!SMOKE) {
    try {
      const { runStartupHooks } = await import("./hooks.js")
      await runStartupHooks()
    } catch (error) {
      console.error(`[hooks] startup hooks failed (non-fatal): ${String(error)}`)
    }
  }
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
    //
    // 2026-10-11: Surface full error details. String(error) on a TaggedError
    // only shows the tag (e.g. "ModuleError"); the `module` and `reason`
    // fields have the actual diagnosis. AIMY_DEBUG=1 adds stack/cause.
    const formatBootError = (e: unknown): string => {
      if (e !== null && typeof e === "object") {
        const o = e as Record<string, unknown>
        const tag = typeof o["_tag"] === "string" ? (o["_tag"] as string) : "Error"
        const module = typeof o["module"] === "string" ? ` [${o["module"]}]` : ""
        const reason = typeof o["reason"] === "string" ? `: ${o["reason"]}` : ""
        let detail = `${tag}${module}${reason}`
        if (process.env["AIMY_DEBUG"] === "1") {
          const stack = typeof o["stack"] === "string" ? `\n\nStack:\n${o["stack"]}` : ""
          const cause = o["cause"] !== undefined ? `\n\nCause: ${JSON.stringify(o["cause"], null, 2)}` : ""
          const extra = JSON.stringify(o, null, 2)
          detail += `${stack}${cause}\n\nFull: ${extra}`
        }
        return detail
      }
      return String(e)
    }
    const bootErrorDetail = formatBootError(error)
    console.error(`[aimy] engine failed to boot: ${bootErrorDetail}`)
    if (SMOKE) {
      console.error(`smoke: engine failed to boot: ${bootErrorDetail}`)
      process.exitCode = 1
      app.quit()
      return
    }
    await dialog.showErrorBox(
      "AImy failed to start",
      `The engine failed to boot:\n\n${bootErrorDetail}\n\nCheck ~/.aimy/desktop.json (baseUrl, model).\nSet AIMY_DEBUG=1 for full error details.`
    )
    app.quit()
    return
  }
  ipcCleanupHandle = registerIpc(ipcMain, engine)
  console.log(`smoke: boot complete, SMOKE=${SMOKE}`)

  // LLM server health check (skip in smoke test — stub has no health endpoint).
  // If the model server isn't responding, offer a restart before opening the window.
  if (!SMOKE) {
    const { checkLlmHealth, LLM_BACKENDS, LlmServerManager } = await import("./llm-server.js")
    const { readDesktopConfig } = await import("./engine.js")
    const cfg = readDesktopConfig()
    const backend = LLM_BACKENDS[cfg.llmBackend ?? "splash"]
    const healthy = await checkLlmHealth(cfg.baseUrl, backend.healthPath)
    if (!healthy) {
      const startCommand = cfg.llmStartCommand ?? ""
      const buttons = startCommand.trim() !== "" ? ["Restart server", "Continue offline"] : ["Continue offline"]
      const { response } = await dialog.showMessageBox({
        type: "warning",
        title: "LLM server not responding",
        message: `${backend.name} isn't answering at ${cfg.baseUrl}.`,
        detail: startCommand.trim() !== ""
          ? "You can restart it now, or continue offline (chat won't work until it's back)."
          : "Set a start command in ~/.aimy/desktop.json (llmStartCommand) to enable one-click restart.\n\nChat won't work until the server is back.",
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1
      })
      if (response === 0 && startCommand.trim() !== "") {
        // User chose "Restart server".
        const manager = new LlmServerManager({
          backend: cfg.llmBackend ?? "splash",
          baseUrl: cfg.baseUrl,
          startCommand
        })
        try {
          await manager.start()
          await dialog.showMessageBox({
            type: "info",
            title: "LLM server restarted",
            message: `${backend.name} is responding at ${cfg.baseUrl}.`,
            buttons: ["OK"]
          })
        } catch (error) {
          await dialog.showErrorBox(
            "LLM server restart failed",
            `Could not restart the server:\n\n${String(error)}\n\nStart it manually, then chat.`
          )
        }
      }
      // "Continue offline" — the window opens; chat will fail honestly until the server is back.
    }
  }

  const win = createWindow()
  console.log("smoke: window created")
  // Debug trace (2026-10-11): forward renderer console messages into the
  // session trace. Errors/warnings carry the most signal; info/debug are
  // captured only when they look like [aimy] diagnostics.
  const trace = ipcCleanupHandle?.trace
  if (trace !== undefined && trace.enabled) {
    win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
      const isError = level === 2
      const isWarn = level === 1
      const isAimyLog = message.includes("[aimy]")
      if (isError || isWarn || isAimyLog) {
        trace.log("renderer", "session", isError ? "console.error" : isWarn ? "console.warn" : "console.log", {
          message: message.slice(0, 2000),
          line,
          source: sourceId?.split("/").pop(),
        })
      }
    })
    // Uncaught renderer exceptions also land here.
    win.webContents.on("render-process-gone", (_e, details) => {
      trace.log("main", "session", "renderer.crashed", { reason: details.reason })
    })
  }
  if (SMOKE) await runSmokeFlow(win)
}

/**
 * Standard application menu (2026-10-11): macOS requires a menu with
 * Edit > Copy for Cmd+C to work on selected text. Without it, keyboard
 * shortcuts for copy/paste/select-all are dead even though text selects.
 */
const setupMenu = (): void => {
  const template: Array<Electron.MenuItemConstructorOptions> = [
    ...(process.platform === "darwin"
      ? [{ role: "appMenu" as const }]
      : []),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

void app.whenReady().then(() => {
  setupMenu()
  return boot()
})

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
  try { ipcCleanupHandle?.stop() } catch { /* ignore */ }
  // Debug trace: flush synchronously so the session file is complete.
  try { ipcCleanupHandle?.trace.flushSync() } catch { /* ignore */ }
  ipcCleanupHandle = undefined
  // User-defined shutdown hooks (2026-10-10): run executables from
  // ~/.aimy/hooks/shutdown.d/. Best-effort; the app quits regardless.
  void import("./hooks.js").then(({ runShutdownHooks }) =>
    runShutdownHooks().catch((err: unknown) =>
      console.error(`[hooks] shutdown hooks error: ${String(err)}`)
    )
  ).catch(() => { /* ignore — hooks are optional */ })
})
