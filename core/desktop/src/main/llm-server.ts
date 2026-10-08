/**
 * desktop/src/main/llm-server.ts — local LLM server lifecycle management.
 *
 * At desktop boot, health-checks the configured LLM backend. If it's not
 * responding, offers the user a restart (via dialog). Supports multiple
 * backends; v1 implements Splash, with LM Studio and Ollama as stubs.
 *
 * The start command is user-configured (stored in desktop.json) because
 * the actual invocation varies by machine (venv paths, model args, etc.).
 */
import { spawn, type ChildProcess } from "node:child_process"

/** Supported LLM backends. */
export type LlmBackendId = "splash" | "lmstudio" | "ollama"

export interface LlmBackend {
  readonly id: LlmBackendId
  readonly name: string
  readonly defaultBaseUrl: string
  /** Health check endpoint path (appended to baseUrl). */
  readonly healthPath: string
}

/** Backend definitions. Only Splash is fully wired in v1. */
export const LLM_BACKENDS: Record<LlmBackendId, LlmBackend> = {
  splash: {
    id: "splash",
    name: "Splash",
    defaultBaseUrl: "http://127.0.0.1:8000",
    healthPath: "/"
  },
  lmstudio: {
    id: "lmstudio",
    name: "LM Studio",
    defaultBaseUrl: "http://127.0.0.1:1234",
    healthPath: "/v1/models"
  },
  ollama: {
    id: "ollama",
    name: "Ollama",
    defaultBaseUrl: "http://127.0.0.1:11434",
    healthPath: "/api/tags"
  }
}

/** User-configured LLM server settings (persisted in desktop.json). */
export interface LlmServerConfig {
  readonly backend: LlmBackendId
  readonly baseUrl: string
  /** Shell command to start the server. Empty = no restart offered. */
  readonly startCommand: string
}

export const defaultLlmServerConfig = (): LlmServerConfig => ({
  backend: "splash",
  baseUrl: LLM_BACKENDS.splash.defaultBaseUrl,
  startCommand: "/opt/homebrew/bin/splash serve --model incoai/Qwen3.8-27B-Splash --default-reasoning-effort none --max-context 64K"
})

/**
 * Health-check the LLM server. Returns true if it responds with 2xx
 * within the timeout. Never throws.
 */
export const checkLlmHealth = async (
  baseUrl: string,
  healthPath: string,
  timeoutMs = 5000
): Promise<boolean> => {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${baseUrl}${healthPath}`, {
        signal: controller.signal,
        method: "GET"
      })
      return res.ok
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}

/**
 * Manages a spawned LLM server process. `start` kills any existing
 * process first (clean restart). `stop` terminates it.
 */
export class LlmServerManager {
  private child: ChildProcess | undefined

  constructor(private readonly config: LlmServerConfig) {}

  /** Is a server process currently managed by us? */
  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null
  }

  /**
   * Start the server via the configured shell command.
   * Throws if no start command is configured.
   */
  async start(): Promise<void> {
    if (this.config.startCommand.trim() === "") {
      throw new Error("No LLM start command configured — set it in Settings")
    }
    this.stop()
    const child = spawn(this.config.startCommand, {
      shell: true,
      detached: false,
      stdio: "ignore"
    })
    this.child = child
    // Wait briefly, then health-check to confirm it came up.
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const backend = LLM_BACKENDS[this.config.backend]
    const healthy = await checkLlmHealth(this.config.baseUrl, backend.healthPath, 10000)
    if (!healthy) {
      this.stop()
      throw new Error(`LLM server started but not responding at ${this.config.baseUrl}`)
    }
  }

  /** Stop the managed server process, if any. */
  stop(): void {
    const child = this.child
    this.child = undefined
    if (child !== undefined && child.exitCode === null) {
      try {
        child.kill("SIGTERM")
      } catch {
        // Already dead — nothing to do.
      }
    }
  }
}
