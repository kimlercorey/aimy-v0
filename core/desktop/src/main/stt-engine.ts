/**
 * desktop/src/main/stt-engine.ts — STT engine lifecycle (install + status).
 *
 * Mirrors tts-engine.ts: the STT engine lives in a venv under
 * `~/.aimy/stt-engine/`, installed on demand via the Voice Settings panel.
 * Currently supports Parakeet MLX (Apple Silicon) as the recommended engine.
 *
 * Install flow:
 * 1. Create venv at `~/.aimy/stt-engine/venv`
 * 2. pip install parakeet-mlx (or whisper-cpp, etc. based on engine ID)
 * 3. Download the model (happens lazily on first transcribe)
 */
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export type SttEngineState = "unknown" | "missing" | "installing" | "ready" | "failed"

export interface SttEngineStatus {
  readonly state: SttEngineState
  readonly detail?: string | undefined
  readonly engine?: string | undefined
}

const STT_DIR = path.join(os.homedir(), ".aimy", "stt-engine")
const VENV_DIR = path.join(STT_DIR, "venv")
const MARKER_FILE = path.join(STT_DIR, "installed.json")

const venvPython = (): string =>
  process.platform === "win32"
    ? path.join(VENV_DIR, "Scripts", "python.exe")
    : path.join(VENV_DIR, "bin", "python")

export interface SttInstallProgress {
  readonly phase: string
  readonly message: string
  readonly downloadedMb?: number | undefined
  readonly totalMb?: number | undefined
  readonly percent?: number | undefined
}

/** Engine ID -> pip package + model info. */
const ENGINE_SPECS: Record<string, { pip: string; model: string; description: string }> = {
  "parakeet-mlx-0.6b-v2": {
    pip: "parakeet-mlx",
    model: "mlx-community/parakeet-tdt-0.6b-v2",
    description: "Parakeet MLX 0.6B v2 (streaming, full-duplex capable)",
  },
  "parakeet-mlx-0.6b-v3": {
    pip: "parakeet-mlx",
    model: "mlx-community/parakeet-tdt-0.6b-v3",
    description: "Parakeet MLX 0.6B v3 (streaming, full-duplex capable)",
  },
  "mlx-whisper-tiny": {
    pip: "mlx-whisper",
    model: "mlx-community/whisper-tiny",
    description: "MLX Whisper tiny (~75 MB)",
  },
  "mlx-whisper-base": {
    pip: "mlx-whisper",
    model: "mlx-community/whisper-base",
    description: "MLX Whisper base (~140 MB)",
  },
  "whistle-16mb": {
    pip: "whistle-stt",
    model: "cactus-compute/whistle-16mb",
    description: "Whistle 16.9 MB (Cactus Compute)",
  },
}

export const sttStatus = (): SttEngineStatus => {
  try {
    if (fs.existsSync(MARKER_FILE)) {
      const data = JSON.parse(fs.readFileSync(MARKER_FILE, "utf-8")) as { engine?: string }
      return { state: "ready", engine: data.engine }
    }
  } catch { /* ignore */ }
  if (fs.existsSync(VENV_DIR)) {
    return { state: "missing", detail: "Install incomplete — try again." }
  }
  return { state: "missing" }
}

let installing = false

/** Download an STT model with progress callbacks. */
const downloadSttModel = async (
  modelId: string,
  onProgress: (downloadedMb: number, totalMb: number, percent: number) => void
): Promise<void> => {
  console.log(`[stt-engine] downloadSttModel: ${modelId}`)
  // Try multiple locations: compiled dist, source tree.
  const candidates = [
    path.join(__dirname, "..", "..", "..", "tts", "server", "download-stt-model.py"),
    path.join(__dirname, "..", "..", "..", "..", "tts", "server", "download-stt-model.py"),
    "/Users/kc/aimy-v0/core/tts/server/download-stt-model.py",
  ]
  let script: string | undefined
  for (const c of candidates) {
    if (fs.existsSync(c)) { script = c; break }
  }
  if (!script) {
    console.error(`[stt-engine] download-stt-model.py not found, tried: ${candidates.join(", ")}`)
    throw new Error(`download-stt-model.py not found`)
  }
  console.log(`[stt-engine] downloadSttModel: using ${script}`)
  return new Promise((resolve, reject) => {
    const proc = spawn(venvPython(), [script, modelId], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    // Hard timeout: kill the process if it hangs (e.g., network stall).
    // The Python script has its own 30s alarm, but that doesn't fire if
    // blocked in a C extension. This is the backstop.
    const timeout = setTimeout(() => {
      console.error(`[stt-engine] downloadSttModel: timed out after 600s, killing`)
      try { proc.kill("SIGKILL") } catch { /* ignore */ }
      done(() => reject(new Error("Model download timed out after 10 minutes (network too slow or stalled)")))
    }, 600_000)
    // No-output timeout: if Python produces zero output in 30s, it's hung
    // during import/startup (not downloading). Fail fast.
    const noOutputTimeout = setTimeout(() => {
      console.error(`[stt-engine] downloadSttModel: no output in 30s, killing (hung on startup?)`)
      try { proc.kill("SIGKILL") } catch { /* ignore */ }
      done(() => reject(new Error("Model download produced no output in 30s — Python hung on startup. Check venv integrity.")))
    }, 30_000)
    // Stall timeout: if no PROGRESS in 60s (output but 0MB), network is stalled.
    let lastProgressMb = 0
    let lastProgressTime = Date.now()
    const stallTimeout = setInterval(() => {
      if (Date.now() - lastProgressTime > 60_000) {
        console.error(`[stt-engine] downloadSttModel: no progress in 60s (stuck at ${lastProgressMb}MB), killing`)
        try { proc.kill("SIGKILL") } catch { /* ignore */ }
        clearInterval(stallTimeout)
        done(() => reject(new Error(`Model download stalled at ${lastProgressMb}MB for 60s — network to huggingface.co is blocked or too slow. Check VPN/firewall, or try again later.`)))
      }
    }, 10_000)
    let buffer = ""
    let completed = false
    const done = (fn: () => void) => {
      if (completed) return
      completed = true
      clearTimeout(timeout)
      clearTimeout(noOutputTimeout)
      clearInterval(stallTimeout)
      fn()
    }
    proc.stdout?.on("data", (data: Buffer) => {
      clearTimeout(noOutputTimeout) // got output, Python is alive
      buffer += data.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.error) {
            done(() => reject(new Error(`Model download failed: ${msg.error}`)))
            proc.kill()
            return
          }
          if (msg.done) {
            console.log(`[stt-engine] downloadSttModel: done -> ${msg.path}`)
            done(() => resolve())
            return
          }
          if (msg.downloaded_mb !== undefined) {
            lastProgressMb = msg.downloaded_mb
            lastProgressTime = Date.now()
            onProgress(msg.downloaded_mb, msg.total_mb ?? 0, msg.percent ?? 0)
          }
        } catch { /* not JSON, ignore */ }
      }
    })
    proc.stderr?.on("data", (data: Buffer) => {
      clearTimeout(noOutputTimeout) // got output, Python is alive
      console.error(`[stt-engine] download stderr: ${data.toString().slice(0, 200)}`)
    })
    proc.on("close", (code) => {
      if (code !== 0) done(() => reject(new Error(`Model download exited with code ${code}`)))
      else done(() => resolve()) // process exited 0 but no "done" message; treat as success
    })
    proc.on("error", (e) => done(() => reject(e)))
  })
}

export const installSttEngine = async (
  engineId: string,
  onProgress: (p: SttInstallProgress) => void
): Promise<void> => {
  if (installing) throw new Error("STT install already in progress.")
  const spec = ENGINE_SPECS[engineId]
  if (!spec) throw new Error(`Unknown STT engine: ${engineId}`)
  
  installing = true
  try {
    const prog = (phase: string, message: string) => onProgress({ phase, message })
    
    // 0. Clean up any stale state from a previous failed install.
    prog("cleanup", "Cleaning up previous install…")
    try {
      fs.rmSync(VENV_DIR, { recursive: true, force: true })
      fs.rmSync(MARKER_FILE, { force: true })
    } catch { /* ignore */ }
    
    // 1. Create venv
    prog("venv", "Creating Python virtual environment…")
    fs.mkdirSync(STT_DIR, { recursive: true })
    await runCmd("python3", ["-m", "venv", VENV_DIR], prog)
    
    // 2. Install the engine package + audio deps.
    prog("deps", `Installing ${spec.pip}…`)
    await runCmd(venvPython(), ["-m", "pip", "install", "-q", spec.pip, "soundfile", "numpy", "huggingface_hub"], prog)
    
    // 3. Download the model with progress (not lazily on first use).
    // Skip if already in HF cache.
    if (spec.model) {
      const cacheDir = path.join(os.homedir(), ".cache", "huggingface", "hub",
        `models--${spec.model.replace("/", "--")}`)
      if (fs.existsSync(cacheDir)) {
        console.log(`[stt-engine] Model already cached at ${cacheDir}, skipping download`)
        prog("model", "Model already cached, skipping download.")
      } else {
        prog("model", `Downloading model ${spec.model}…`)
        await downloadSttModel(spec.model, (downloadedMb, totalMb, percent) => {
          onProgress({
            phase: "downloading",
            message: `Downloading model: ${downloadedMb}MB / ${totalMb}MB (${percent}%)`,
            downloadedMb,
            totalMb,
            percent,
          })
        })
      }
    }
    
    // 4. Write marker
    prog("done", "STT engine installed.")
    fs.writeFileSync(MARKER_FILE, JSON.stringify({ engine: engineId, model: spec.model, at: Date.now() }))
  } finally {
    installing = false
  }
}

const runCmd = (
  cmd: string,
  args: ReadonlyArray<string>,
  prog: (phase: string, message: string) => void
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"] })
    let stderr = ""
    child.stdout?.on("data", (d: Buffer) => prog("output", d.toString().trim()))
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Command failed (${code}): ${stderr.slice(-500)}`))
    })
  })

// ── Server lifecycle (mirrors tts-engine.ts) ───────────────────────────────

const STT_PORT = 8002
let serverChild: ReturnType<typeof spawn> | undefined

const serverPyPath = (): string => {
  // stt-engine.ts is at core/desktop/src/main/; server is at core/tts/server/.
  // Also check the dist layout (core/dist/tts/server/) for packaged builds.
  const candidates = [
    path.join(__dirname, "..", "..", "..", "tts", "server", "stt-server.py"),
    path.join(__dirname, "..", "..", "..", "dist", "tts", "server", "stt-server.py"),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  throw new Error(`stt-server.py not found (tried: ${candidates.join(", ")})`)
}

const waitForHealth = async (
  timeoutMs: number,
  onProgress?: (msg: string) => void
): Promise<boolean> => {
  const start = Date.now()
  let lastProgress = 0
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${STT_PORT}/health`)
      if (res.ok) return true
    } catch { /* retry */ }
    // Report download progress every 5s while waiting.
    if (onProgress && Date.now() - lastProgress > 5000) {
      lastProgress = Date.now()
      const elapsed = Math.round((Date.now() - start) / 1000)
      onProgress(`Downloading STT model (~600MB, first run only)... ${elapsed}s elapsed`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

export const ensureSttServer = async (onProgress?: (msg: string) => void): Promise<void> => {
  console.log("[stt-engine] ensureSttServer: checking health...")
  if (await waitForHealth(2000)) {
    console.log("[stt-engine] ensureSttServer: already running")
    return
  }
  const status = sttStatus()
  console.log(`[stt-engine] ensureSttServer: status=${status.state}, starting server`)
  if (status.state !== "ready") throw new Error("STT engine not installed")

  const marker = JSON.parse(fs.readFileSync(MARKER_FILE, "utf-8")) as {
    engine: string
    model: string
  }
  console.log(`[stt-engine] ensureSttServer: engine=${marker.engine}, model=${marker.model}`)
  const serverPath = serverPyPath()
  console.log(`[stt-engine] ensureSttServer: server=${serverPath}, port=${STT_PORT}`)
  const logPath = "/tmp/aimy-stt-server.log"
  const logFd = fs.openSync(logPath, "a")
  serverChild = spawn(venvPython(), [serverPath], {
    stdio: ["ignore", logFd, logFd],
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      AIMY_STT_ENGINE: marker.engine,
      AIMY_STT_MODEL: marker.model,
      AIMY_STT_PORT: String(STT_PORT),
      // Ensure parakeet-mlx uses the HF cache where we downloaded the model.
      HF_HUB_CACHE: path.join(os.homedir(), ".cache", "huggingface", "hub"),
    },
  })
  console.log(`[stt-engine] ensureSttServer: spawned pid=${serverChild.pid}`)
  serverChild.on("error", (e) => {
    console.error(`[stt-engine] server error: ${e.message}`)
    serverChild = undefined
  })
  serverChild.on("exit", (code) => {
    console.log(`[stt-engine] server exited (code=${code}), see ${logPath}`)
    serverChild = undefined
  })
  const up = await waitForHealth(600_000, onProgress) // 10min for first model download
  if (!up) {
    console.error(`[stt-engine] server failed health check after 600s, see ${logPath}`)
    try { serverChild.kill() } catch { /* ignore */ }
    serverChild = undefined
    throw new Error("STT server started but never answered health checks. See /tmp/aimy-stt-server.log")
  }
  console.log("[stt-engine] ensureSttServer: healthy")
}

export const stopSttServer = (): void => {
  try { serverChild?.kill() } catch { /* ignore */ }
  serverChild = undefined
}

export const transcribeAudio = async (
  audioBase64: string,
  sampleRate = 16000
): Promise<{ text: string; latencyMs: number }> => {
  const t0 = Date.now()
  // Calculate audio duration from base64 length (for timing diagnostics).
  // base64: 4 chars = 3 bytes. 16kHz 16-bit mono = 32000 bytes/sec.
  const audioBytes = Math.floor(audioBase64.length * 3 / 4)
  const audioSec = (audioBytes / (sampleRate * 2)).toFixed(2)
  console.log(`[aimy] STT timing: audio received t0=${t0} size=${audioBytes}b duration≈${audioSec}s`)

  // Check provider registry: use OMA if active (2026-10-10).
  let useOma = false
  try {
    const regPath = path.join(os.homedir(), ".aimy", "providers.json")
    const reg = JSON.parse(fs.readFileSync(regPath, "utf8")) as {
      activeId?: { stt?: string },
      providers?: Array<{ id: string; kind: string; endpoint?: string }>
    }
    const active = reg.providers?.find((p) => p.id === reg.activeId?.stt)
    useOma = active?.kind === "remote"
    console.log(`[aimy] STT timing: provider=${active?.id ?? "none"} kind=${active?.kind ?? "?"} useOma=${useOma}`)
  } catch (e) {
    console.log(`[aimy] STT timing: registry read failed, using local (${e instanceof Error ? e.message : e})`)
  }

  if (useOma) {
    // OMA faster-whisper via tunnel (2026-10-10 verified contract).
    const { omaTranscribe } = await import("./oma-stt-client.js")
    const tOma0 = Date.now()
    console.log(`[aimy] STT timing: OMA request start t=${tOma0 - t0}ms`)
    try {
      const bytes = Buffer.from(audioBase64, "base64")
      const result = await omaTranscribe(new Uint8Array(bytes), "recording.wav")
      const tOma1 = Date.now()
      const totalMs = tOma1 - t0
      console.log(`[aimy] STT timing: OMA done t=${totalMs}ms (oma=${tOma1 - tOma0}ms) text="${result.text.slice(0, 60)}" no_speech=${result.no_speech ?? false}`)
      // Treat no_speech as empty (caller should re-listen, not fail).
      return { text: result.no_speech === true ? "" : result.text, latencyMs: totalMs }
    } catch (e) {
      const tErr = Date.now()
      console.log(`[aimy] STT timing: OMA failed t=${tErr - t0}ms (${e instanceof Error ? e.message : e}), falling back to local`)
      // Fall through to local.
    }
  }

  // Local path (parakeet-mlx via :8002).
  console.log(`[stt-engine] transcribe: ${audioBase64.length} chars base64 @ ${sampleRate}Hz`)
  const tLocal0 = Date.now()
  await ensureSttServer()
  const tServerOk = Date.now()
  console.log(`[aimy] STT timing: local server ready t=${tServerOk - t0}ms (ensure=${tServerOk - tLocal0}ms)`)
  const res = await fetch(`http://127.0.0.1:${STT_PORT}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio_base64: audioBase64, sample_rate: sampleRate }),
  })
  const tResp = Date.now()
  if (!res.ok) {
    console.error(`[stt-engine] transcribe failed: HTTP ${res.status}`)
    throw new Error(`STT transcribe failed: ${res.status}`)
  }
  const data = (await res.json()) as { text: string; latency_ms: number }
  const tDone = Date.now()
  console.log(`[stt-engine] transcribe ok: ${data.latency_ms.toFixed(0)}ms, "${data.text.slice(0, 60)}"`)
  console.log(`[aimy] STT timing: local done t=${tDone - t0}ms (http=${tResp - tServerOk}ms parse=${tDone - tResp}ms)`)
  return { text: data.text, latencyMs: data.latency_ms }
}

export const testSttLatency = async (
  onProgress?: (msg: string) => void
): Promise<{
  latencyMs: number
  modelSizeMb: number
}> => {
  console.log("[stt-engine] test: starting latency check")
  await ensureSttServer(onProgress)
  const res = await fetch(`http://127.0.0.1:${STT_PORT}/test`, { method: "POST" })
  if (!res.ok) {
    console.error(`[stt-engine] test failed: HTTP ${res.status}`)
    throw new Error(`STT test failed: ${res.status}`)
  }
  const data = (await res.json()) as { latency_ms: number; model_size_mb: number }
  console.log(`[stt-engine] test ok: ${data.latency_ms.toFixed(0)}ms, ${data.model_size_mb}MB`)
  return { latencyMs: data.latency_ms, modelSizeMb: data.model_size_mb }
}
