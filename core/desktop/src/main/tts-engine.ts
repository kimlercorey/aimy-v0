/**
 * desktop/src/main/tts-engine.ts — the TTS engine holder.
 *
 * Owns the Chatterbox runtime lifecycle in the desktop app:
 *
 * - **install**: creates `~/.aimy/tts-engine/venv`, pip-installs
 *   `chatterbox-tts` + `torch` into it. Cross-platform: pip resolves the
 *   right torch wheel per OS (CUDA on Linux/Windows, MPS/CPU on macOS).
 *   Runs in the background; progress streams back via callback.
 * - **status**: `ready` iff the install marker exists; `missing` otherwise.
 *   A half-finished install leaves no marker, so retry is always clean.
 * - **server**: spawns `tts-server.py` under the venv's Python and
 *   health-polls it. Stops on app quit.
 *
 * Why not bundle torch in the installer: the CUDA wheel alone is ~2.5 GB
 * and platform-specific. The engine downloads once, on the user's explicit
 * opt-in (voice toggle), into app data — the standard pattern.
 */
import { spawn, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { makeTtsService } from "../../../tts/src/index.js"
import type { TtsServiceShape } from "../../../tts/src/types.js"
import type { HttpClientShape } from "../../../web-retrieval/src/http.js"

export type TtsEngineState = "missing" | "installing" | "ready" | "failed"

export interface TtsEngineStatus {
  readonly state: TtsEngineState
  /** Human-readable detail for failed/missing states. */
  readonly detail?: string | undefined
}

export interface TtsInstallProgress {
  readonly phase: "python" | "venv" | "deps" | "verify" | "done" | "error"
  readonly message: string
}

export interface TtsEngine {
  readonly status: () => TtsEngineStatus
  readonly install: (onProgress: (p: TtsInstallProgress) => void) => Promise<void>
  readonly ensureServer: () => Promise<void>
  readonly stopServer: () => void
  readonly venvPython: () => string
  /** Disk-persisted voice selection — survives restarts and IPC calls. */
  readonly activeVoiceId: () => string | undefined
  readonly setActiveVoice: (id: string) => void
  /** A TtsService with the persisted voice pre-applied (best-effort). */
  readonly ttsService: (http: HttpClientShape) => Effect.Effect<TtsServiceShape, never>
}

const ENGINE_DIRNAME = "tts-engine"
const MARKER = ".installed.json"
const SERVER_PORT = 8001
const HEALTH_URL = `http://127.0.0.1:${SERVER_PORT}/health`

/** Pure: the engine's home. Overridable for tests via AIMY_TTS_ENGINE_DIR. */
export const ttsEngineDir = (): string =>
  process.env["AIMY_TTS_ENGINE_DIR"] ??
  path.join(os.homedir(), ".aimy", ENGINE_DIRNAME)

/** Pure: venv python path for a platform. */
export const venvPythonFor = (engineDir: string, platform: NodeJS.Platform = process.platform): string =>
  platform === "win32"
    ? path.join(engineDir, "venv", "Scripts", "python.exe")
    : path.join(engineDir, "venv", "bin", "python")

/** Pure: candidate system pythons, most-preferred first. */
export const systemPythonCandidates = (
  platform: NodeJS.Platform = process.platform
): ReadonlyArray<ReadonlyArray<string>> =>
  platform === "win32"
    ? [["py", "-3"], ["python"]]
    : [["python3"], ["python"]]

const markerPath = (engineDir: string): string => path.join(engineDir, MARKER)

const runCapture = (cmd: string, args: ReadonlyArray<string>): { ok: boolean; out: string } => {
  try {
    const r = spawnSync(cmd, [...args], { encoding: "utf8", timeout: 15000 })
    return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
  } catch {
    return { ok: false, out: "" }
  }
}

/** Find a working system Python. Returns argv-prefix or undefined. */
export const findSystemPython = (
  platform: NodeJS.Platform = process.platform,
  probe: (cmd: string, args: ReadonlyArray<string>) => { ok: boolean; out: string } = runCapture
): ReadonlyArray<string> | undefined => {
  for (const cand of systemPythonCandidates(platform)) {
    const r = probe(cand[0]!, [...cand.slice(1), "--version"])
    if (r.ok && /python 3/i.test(r.out)) return cand
  }
  return undefined
}

const runStreaming = (
  cmd: string,
  args: ReadonlyArray<string>,
  onLine: (line: string) => void
): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"] })
    let buf = ""
    const feed = (chunk: Buffer): void => {
      buf += chunk.toString("utf8")
      let idx = buf.indexOf("\n")
      while (idx >= 0) {
        const line = buf.slice(0, idx).trim()
        if (line !== "") onLine(line)
        buf = buf.slice(idx + 1)
        idx = buf.indexOf("\n")
      }
    }
    child.stdout?.on("data", feed)
    child.stderr?.on("data", feed)
    child.on("error", () => resolve(-1))
    child.on("close", (code) => {
      const tail = buf.trim()
      if (tail !== "") onLine(tail)
      resolve(code ?? -1)
    })
  })

const rmDir = (dir: string): void => {
  fs.rmSync(dir, { recursive: true, force: true })
}

const waitForHealth = async (timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL)
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 750))
  }
  return false
}

export const makeTtsEngine = (opts?: {
  readonly engineDir?: string | undefined
  readonly serverPy?: string | undefined
}): TtsEngine => {
  const engineDir = opts?.engineDir ?? ttsEngineDir()
  const serverPy = opts?.serverPy
  let installing = false
  let lastError: string | undefined
  let serverChild: ReturnType<typeof spawn> | undefined

  const status = (): TtsEngineStatus => {
    if (installing) return { state: "installing" }
    if (lastError !== undefined) return { state: "failed", detail: lastError }
    try {
      const raw = fs.readFileSync(markerPath(engineDir), "utf8")
      const marker = JSON.parse(raw) as { v: number }
      if (marker.v === 1 && fs.existsSync(venvPythonFor(engineDir))) {
        return { state: "ready" }
      }
    } catch {
      // no marker → missing
    }
    return { state: "missing" }
  }

  const install = async (onProgress: (p: TtsInstallProgress) => void): Promise<void> => {
    if (installing) return
    const cur = status()
    if (cur.state === "ready") {
      onProgress({ phase: "done", message: "Voice engine already installed." })
      return
    }
    installing = true
    lastError = undefined
    const prog = (phase: TtsInstallProgress["phase"], message: string): void =>
      onProgress({ phase, message })
    try {
      // 1. system python
      prog("python", "Looking for Python 3…")
      const py = findSystemPython()
      if (py === undefined) {
        throw new Error(
          "No Python 3 found. Install Python 3.10+ from python.org (Windows: enable 'Add python to PATH'), then retry."
        )
      }
      prog("python", `Using ${py.join(" ")}`)

      // 2. fresh venv (wipe any partial earlier attempt)
      prog("venv", "Creating isolated environment…")
      rmDir(path.join(engineDir, "venv"))
      fs.mkdirSync(engineDir, { recursive: true })
      const venvCode = await runStreaming(py[0]!, [...py.slice(1), "-m", "venv", path.join(engineDir, "venv")], (l) =>
        prog("venv", l.slice(0, 160))
      )
      if (venvCode !== 0) throw new Error(`python -m venv failed (exit ${venvCode})`)
      const vpy = venvPythonFor(engineDir)
      if (!fs.existsSync(vpy)) throw new Error("venv created but its Python is missing — check disk space and permissions.")

      // 3. deps — the big download. CUDA wheel on linux/win, MPS/CPU on macOS.
      prog("deps", "Downloading voice engine (~1–2.5 GB, one time)…")
      const pipCode = await runStreaming(
        vpy,
        ["-m", "pip", "install", "--upgrade", "pip", "chatterbox-tts", "torch"],
        (l) => {
          const clean = l.slice(0, 160)
          // pip's own progress lines are noise; surface the meaningful ones.
          if (/Successfully installed|Downloading|Collecting chatterbox|Collecting torch/i.test(l)) {
            prog("deps", clean)
          }
        }
      )
      if (pipCode !== 0) throw new Error(`pip install failed (exit ${pipCode}) — check network and disk space.`)

      // 4. verify the import actually works
      prog("verify", "Verifying installation…")
      const verifyCode = await runStreaming(vpy, ["-c", "import chatterbox, torch; print('ok')"], () => undefined)
      if (verifyCode !== 0) throw new Error("Install finished but `import chatterbox` fails — retry or install manually.")

      fs.writeFileSync(markerPath(engineDir), JSON.stringify({ v: 1, at: new Date().toISOString() }) + "\n")
      prog("done", "Voice engine installed.")
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      prog("error", lastError)
      throw e
    } finally {
      installing = false
    }
  }

  const ensureServer = async (): Promise<void> => {
    if (serverChild !== undefined && serverChild.exitCode === null) {
      if (await waitForHealth(5000)) return
      // child alive but not answering — restart it
      try { serverChild.kill() } catch { /* ignore */ }
      serverChild = undefined
    }
    const st = status()
    if (st.state !== "ready") {
      throw new Error("Voice engine not installed — install it first.")
    }
    if (serverPy === undefined || !fs.existsSync(serverPy)) {
      throw new Error("tts-server.py not found in the app bundle — reinstall the app.")
    }
    if (await waitForHealth(2000)) return // already running (e.g. manual)
    serverChild = spawn(venvPythonFor(engineDir), [serverPy], {
      stdio: "ignore",
      detached: process.platform !== "win32",
    })
    serverChild.on("error", () => { serverChild = undefined })
    serverChild.on("exit", () => { serverChild = undefined })
    const up = await waitForHealth(60_000)
    if (!up) {
      try { serverChild.kill() } catch { /* ignore */ }
      serverChild = undefined
      throw new Error("Voice server started but never answered health checks.")
    }
  }

  const stopServer = (): void => {
    if (serverChild !== undefined) {
      try { serverChild.kill() } catch { /* ignore */ }
      serverChild = undefined
    }
  }

  const voiceFile = path.join(engineDir, "active-voice.json")

  const activeVoiceId = (): string | undefined => {
    try {
      const raw = fs.readFileSync(voiceFile, "utf8")
      const parsed = JSON.parse(raw) as { voiceId?: unknown }
      return typeof parsed.voiceId === "string" && parsed.voiceId !== "" ? parsed.voiceId : undefined
    } catch {
      return undefined
    }
  }

  const setActiveVoice = (id: string): void => {
    fs.mkdirSync(engineDir, { recursive: true })
    fs.writeFileSync(voiceFile, JSON.stringify({ voiceId: id }) + "\n", { mode: 0o600 })
  }

  const ttsService = (http: HttpClientShape): Effect.Effect<TtsServiceShape, never> =>
    Effect.gen(function* () {
      const svc = makeTtsService({ http })
      const id = activeVoiceId()
      if (id !== undefined) {
        // Best-effort: the voice may have been removed server-side.
        yield* svc.setVoice(id).pipe(Effect.ignore)
      }
      return svc
    })

  return { status, install, ensureServer, stopServer, venvPython: () => venvPythonFor(engineDir), activeVoiceId, setActiveVoice, ttsService }
}
