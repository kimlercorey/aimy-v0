/**
 * desktop/src/main/engine.ts — boots the AImy Effect engine for the desktop app.
 *
 * M10 Track 1. ZERO ENGINE FORK: this file reuses `core/chat/src/stack.ts`
 * `buildChatStack` and `core/chat/src/retrieval.ts` `bootRetrievalModule`
 * verbatim — the same layer composition the CLI chat (`npm run chat`) boots.
 * Anything the desktop needs that the chat stack doesn't provide is a
 * *consumer* of this file's `DesktopEngine` interface (Track 2's IPC
 * handlers), never a second stack.
 *
 * Boot sequence mirrors `core/chat/src/index.ts` `main()`:
 *   1. Read `~/.aimy/desktop.json` (`{ baseUrl, model }`); create it with
 *      defaults on first run (defaults: local Splash endpoint, model
 *      "default" — onboarding, Track 3, collects the real model name).
 *   2. `buildChatStack({ baseUrl, model })`, then `ManagedRuntime.make` —
 *      the layer builds ONCE here, lazily on first `runPromise`.
 *   3. Register the `LocalHttpProvider` with the `InferencePool`; boot the
 *      web-retrieval module on the stack's `ModuleHost` (install + enable +
 *      start, tier T1, from its real SKILL.md — same as the CLI).
 *
 * The preflight check from the CLI is NOT repeated here: the CLI warns and
 * keeps trying; the desktop surfaces endpoint reachability through the UI
 * (Track 2/3). Boot failures reject — they never hang.
 */
import { Effect, ManagedRuntime, Stream } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { AgentLoop, type ChatChunk } from "../../../agent-loop/src/index.js"
import { makeBackgroundJobRegistry } from "../../../agent-loop/src/background-job.js"
import { buildChatStack, type ChatStack } from "../../../chat/src/stack.js"
import {
  bootRetrievalModule,
  braveSearchConfigured,
  makeBraveMediaAgentTools,
  makeBraveMediaToolsForChat,
  makeRetrievalAgentTool,
  makeRetrievalToolForChat,
  type BraveMediaTool,
  type RetrievalTool
} from "../../../chat/src/retrieval.js"
import {
  bootResearchModule,
  makePoolPlanModel,
  makeResearchAgentTool,
  makeResearchToolForChat,
  type ResearchToolFactory
} from "../../../chat/src/research.js"
import { HonestyService } from "../../../honesty/index.js"
import { InferencePool } from "../../../inference-pool/index.js"
import { MemoryService } from "../../../memory/index.js"
import { ModuleHost } from "../../../module-seam/src/index.js"
import { HttpClient } from "../../../web-retrieval/src/http.js"

/**
 * The exact service union `ChatStack`'s layer provides
 * (`core/chat/src/stack.ts`). Copied verbatim — if `stack.ts` changes this
 * union, this type must change with it (tsc will fail, which is the point).
 */
export type EngineRequirements =
  | AgentLoop
  | InferencePool
  | MemoryService
  | HonestyService
  | ModuleHost
  | HttpClient

/**
 * The desktop engine surface. Track 2 builds on this — do not change the
 * shape without reason.
 *
 * - `run`: execute any Effect against the boot-built layer. Failures reject
 *   the promise with the typed error — never hang, never swallow.
 * - `chatStream`: one `AgentLoop.chat` turn as an `AsyncIterable<ChatChunk>`
 *   (via `Stream.toAsyncIterable`). Cancellation: call `return()` on the
 *   iterator (what Track 2's `chat.cancel` does) — the underlying fiber is
 *   interrupted and the iterator ends cleanly, with no post-cancel side
 *   effects. Stream errors are thrown from `next()` — never swallowed.
 * - `shutdown`: dispose the runtime (releases any layer-scoped resources).
 */
export interface DesktopEngine {
  readonly run: <A, E>(effect: Effect.Effect<A, E, EngineRequirements>) => Promise<A>
  readonly chatStream: (
    sessionId: string,
    input: string,
    images?: ReadonlyArray<{ dataUrl: string; mimeType: string; name: string }>
  ) => AsyncIterable<ChatChunk>
  readonly shutdown: () => Promise<void>
  /**
   * Wire the voice narration sink. Called by IPC handlers once the TTS
   * engine is ready. Before this is called, `narrate` tool calls degrade
   * gracefully (no-op with a reason, not an error).
   */
  readonly setNarrationSink: (fn: (text: string) => string) => void
}

export interface DesktopConfig {
  readonly baseUrl: string
  readonly model: string
  /** LLM backend selection and server lifecycle (v1: splash). */
  readonly llmBackend?: "splash" | "lmstudio" | "ollama" | undefined
  /** Shell command to start the LLM server. Empty = no restart offered. */
  readonly llmStartCommand?: string | undefined
  /**
   * Debug trace mode (2026-10-11): when true, the app writes a JSONL
   * session trace to ~/.aimy/traces/ (last 5 kept) capturing turn
   * lifecycle, IPC, tool calls, TTS/audio timing, state snapshots,
   * and renderer console errors. For troubleshooting with Zen.
   */
  readonly debugTrace?: boolean | undefined
}

/** Splash (the local model server) + a placeholder model name. */
export const DEFAULT_DESKTOP_CONFIG: DesktopConfig = {
  baseUrl: "http://127.0.0.1:8000",
  model: "default",
  llmBackend: "splash",
  llmStartCommand: "/opt/homebrew/bin/splash serve --model incoai/Qwen3.8-27B-Splash --default-reasoning-effort none --max-context 64K"
}

export const desktopConfigPath = (): string => path.join(os.homedir(), ".aimy", "desktop.json")

/** Read the desktop config; missing/corrupt file degrades to defaults (never throws). */
export const readDesktopConfig = (configFile: string = desktopConfigPath()): DesktopConfig => {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, "utf8")) as Partial<DesktopConfig>
    const llmBackend = raw.llmBackend
    return {
      baseUrl:
        typeof raw.baseUrl === "string" && raw.baseUrl !== "" ? raw.baseUrl : DEFAULT_DESKTOP_CONFIG.baseUrl,
      model: typeof raw.model === "string" && raw.model !== "" ? raw.model : DEFAULT_DESKTOP_CONFIG.model,
      llmBackend:
        llmBackend === "splash" || llmBackend === "lmstudio" || llmBackend === "ollama"
          ? llmBackend
          : DEFAULT_DESKTOP_CONFIG.llmBackend,
      llmStartCommand:
        typeof raw.llmStartCommand === "string" ? raw.llmStartCommand : DEFAULT_DESKTOP_CONFIG.llmStartCommand,
      debugTrace:
        typeof raw.debugTrace === "boolean" ? raw.debugTrace : undefined
    }
  } catch {
    return DEFAULT_DESKTOP_CONFIG
  }
}

/**
 * Write the config (mode 0600 — it names the local endpoint; keep it private by habit).
 * Merge over the existing file (2026-10-11): a blind overwrite dropped the
 * `debugTrace` flag when an older code path saved. Unknown fields survive.
 */
const writeDesktopConfig = (config: DesktopConfig, configFile: string): void => {
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  let merged: Record<string, unknown> = {}
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, "utf8"))
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) merged = raw as Record<string, unknown>
  } catch {
    // No existing file — write fresh.
  }
  // Drop keys the new config explicitly leaves undefined so stale values
  // can't linger, but keep anything the new config doesn't mention.
  for (const [k, v] of Object.entries(config)) {
    if (v === undefined) delete merged[k]
    else merged[k] = v
  }
  fs.writeFileSync(configFile, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 })
}

/**
 * Read the active LLM provider from the registry (~/.aimy/providers.json).
 * Returns its endpoint and model, or undefined if none is active/enabled.
 * This wires the Settings → Providers UI into the inference path.
 */
const readActiveLlmProvider = (): { endpoint: string; model: string; streaming: boolean } | undefined => {
  try {
    const registryPath = path.join(os.homedir(), ".aimy", "providers.json")
    if (!fs.existsSync(registryPath)) return undefined
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"))
    const activeId = registry?.activeId?.llm
    if (!activeId) return undefined
    const provider = (registry.providers ?? []).find((p: any) => p.id === activeId)
    if (!provider || !provider.enabled) return undefined
    const endpoint = provider.endpoint
    const model = provider.config?.model
    if (typeof endpoint !== "string" || endpoint === "") return undefined
    if (typeof model !== "string" || model === "") return undefined
    // Streaming defaults to true; provider can opt out via config.streaming="false"
    // (e.g. OMA llama-server returns empty SSE streams — use non-streaming).
    const streaming = provider.config?.streaming !== "false"
    return { endpoint, model, streaming }
  } catch {
    return undefined
  }
}

/**
 * Boot the desktop engine. Builds the layer ONCE (via `ManagedRuntime`),
 * registers the provider, boots the retrieval module — then hands back the
 * runner surface. Any boot failure rejects the returned promise.
 */
export const bootDesktopEngine = async (opts?: {
  readonly baseUrl?: string | undefined
  readonly model?: string | undefined
  readonly configFile?: string | undefined
}): Promise<DesktopEngine> => {
  const configFile = opts?.configFile ?? desktopConfigPath()
  const fromDisk = readDesktopConfig(configFile)
  // Prefer the active provider from the registry (2026-10-10: wires
  // Settings → Providers into the inference path; previously the registry
  // was UI-only and inference always used desktop.json).
  const activeProvider = readActiveLlmProvider()
  const config: DesktopConfig = {
    baseUrl: opts?.baseUrl ?? activeProvider?.endpoint ?? fromDisk.baseUrl,
    model: opts?.model ?? activeProvider?.model ?? fromDisk.model
  }
  // Streaming defaults to true; provider can disable via config.streaming=false.
  const streaming = activeProvider?.streaming ?? true
  // Create on first run; onboarding (Track 3) collects the real model name.
  writeDesktopConfig(config, configFile)

  // The retrieval tool as a MODEL-CALLABLE agent tool — the same factory the
  // CLI chat uses, so the desktop model sees the identical `retrieval.query`
  // contract. Closes over the boot-stashed tool ref (set below); the loop
  // only runs tools during chat, after boot.
  let retrievalTool: RetrievalTool | undefined
  const retrievalAgentTool = makeRetrievalAgentTool(() => retrievalTool)

  // Brave media tools (2026-10-13): news / images / videos. Registered
  // ONLY when a Brave key is configured — the endpoints exist only on
  // the keyed API, and a listed tool that cannot work is a lie.
  let braveMediaTools: ReadonlyArray<BraveMediaTool> | undefined
  const braveMediaAgentTools = makeBraveMediaAgentTools(() => braveMediaTools)

  // Same pattern for deep-research (2026-10-12): the model-callable
  // research.query tool, closing over a boot-stashed FACTORY (each run
  // builds its tool with that run's stage sink for the run record).
  let researchToolFactory: ResearchToolFactory | undefined
  const researchAgentTool = makeResearchAgentTool((onStage) => researchToolFactory?.(onStage))

  // Background job registry: process-lifetime, shared across turns.
  // Spawned jobs (via `job.spawn` tool) outlive the turn that created them.
  const backgroundJobs = await Effect.runPromise(makeBackgroundJobRegistry())

  // Narration sink: mutable ref populated by IPC handlers once the TTS
  // engine is ready. Before that, `narrate` calls degrade gracefully
  // (the tool reports "no narration sink" instead of failing).
  let narrationEnqueue: ((text: string) => string) | undefined
  const narrationSink = {
    enqueue: (text: string): string => {
      const fn = narrationEnqueue
      if (fn === undefined) return ""
      return fn(text)
    }
  }
  // Exposed for handlers.ts to wire up once TTS is available.
  const setNarrationSink = (fn: (text: string) => string): void => {
    narrationEnqueue = fn
    console.log("[aimy] narration sink wired")
  }

  const stack: ChatStack = buildChatStack({
    baseUrl: config.baseUrl,
    model: config.model,
    streaming,
    extraTools: [retrievalAgentTool, researchAgentTool, ...(braveSearchConfigured() ? braveMediaAgentTools : [])],
    backgroundJobs,
    narration: narrationSink
  })
  const { layer, provider } = stack

  // The layer builds ONCE here (memoized by the runtime); every `run` and
  // `chatStream` below shares it — the same build the boot step uses.
  const runtime = ManagedRuntime.make(layer)

  // Boot step (mirrors chat/src/index.ts): register once, boot retrieval.
  await runtime.runPromise(
    Effect.gen(function* () {
      const pool = yield* InferencePool
      yield* pool.register(provider)
      const host = yield* ModuleHost
      const honesty = yield* HonestyService
      const http = yield* HttpClient
      yield* bootRetrievalModule(host)
      retrievalTool = makeRetrievalToolForChat(http, honesty)
      braveMediaTools = makeBraveMediaToolsForChat(http)
      yield* bootResearchModule(host)
      researchToolFactory = (onStage) => makeResearchToolForChat(http, honesty, makePoolPlanModel(pool), onStage)
    })
  )

  return {
    run: <A, E>(effect: Effect.Effect<A, E, EngineRequirements>): Promise<A> =>
      runtime.runPromise(effect),
    chatStream: (
      sessionId: string,
      input: string,
      images?: ReadonlyArray<{ dataUrl: string; mimeType: string; name: string }>
    ): AsyncIterable<ChatChunk> =>
      Stream.toAsyncIterable(
        Stream.provide(
          Stream.unwrap(Effect.map(AgentLoop, (loop) => loop.chat(sessionId, input, images))),
          layer
        )
      ),
    shutdown: (): Promise<void> => runtime.dispose(),
    setNarrationSink
  }
}
