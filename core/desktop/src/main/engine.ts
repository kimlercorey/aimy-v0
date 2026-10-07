/**
 * desktop/src/main/engine.ts — boots the AImy Effect engine for the desktop app.
 *
 * M10 Track 1. ZERO ENGINE FORK: this file reuses `core/chat/src/stack.ts`
 * `buildChatStack` and `core/chat/src/research.ts` `bootResearchModule`
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
 *      web-research module on the stack's `ModuleHost` (install + enable +
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
import { buildChatStack, type ChatStack } from "../../../chat/src/stack.js"
import { bootResearchModule } from "../../../chat/src/research.js"
import { HonestyService } from "../../../honesty/index.js"
import { InferencePool } from "../../../inference-pool/index.js"
import { MemoryService } from "../../../memory/index.js"
import { ModuleHost } from "../../../module-seam/src/index.js"
import { HttpClient } from "../../../web-research/src/http.js"

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
  readonly chatStream: (sessionId: string, input: string) => AsyncIterable<ChatChunk>
  readonly shutdown: () => Promise<void>
}

export interface DesktopConfig {
  readonly baseUrl: string
  readonly model: string
}

/** Splash (the local model server) + a placeholder model name. */
export const DEFAULT_DESKTOP_CONFIG: DesktopConfig = {
  baseUrl: "http://127.0.0.1:8000",
  model: "default"
}

export const desktopConfigPath = (): string => path.join(os.homedir(), ".aimy", "desktop.json")

/** Read the desktop config; missing/corrupt file degrades to defaults (never throws). */
export const readDesktopConfig = (configFile: string = desktopConfigPath()): DesktopConfig => {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, "utf8")) as Partial<DesktopConfig>
    return {
      baseUrl:
        typeof raw.baseUrl === "string" && raw.baseUrl !== "" ? raw.baseUrl : DEFAULT_DESKTOP_CONFIG.baseUrl,
      model: typeof raw.model === "string" && raw.model !== "" ? raw.model : DEFAULT_DESKTOP_CONFIG.model
    }
  } catch {
    return DEFAULT_DESKTOP_CONFIG
  }
}

/** Write the config (mode 0600 — it names the local endpoint; keep it private by habit). */
const writeDesktopConfig = (config: DesktopConfig, configFile: string): void => {
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
}

/**
 * Boot the desktop engine. Builds the layer ONCE (via `ManagedRuntime`),
 * registers the provider, boots the research module — then hands back the
 * runner surface. Any boot failure rejects the returned promise.
 */
export const bootDesktopEngine = async (opts?: {
  readonly baseUrl?: string | undefined
  readonly model?: string | undefined
  readonly configFile?: string | undefined
}): Promise<DesktopEngine> => {
  const configFile = opts?.configFile ?? desktopConfigPath()
  const fromDisk = readDesktopConfig(configFile)
  const config: DesktopConfig = {
    baseUrl: opts?.baseUrl ?? fromDisk.baseUrl,
    model: opts?.model ?? fromDisk.model
  }
  // Create on first run; onboarding (Track 3) collects the real model name.
  writeDesktopConfig(config, configFile)

  const stack: ChatStack = buildChatStack({ baseUrl: config.baseUrl, model: config.model })
  const { layer, provider } = stack

  // The layer builds ONCE here (memoized by the runtime); every `run` and
  // `chatStream` below shares it — the same build the boot step uses.
  const runtime = ManagedRuntime.make(layer)

  // Boot step (mirrors chat/src/index.ts): register once, boot research.
  await runtime.runPromise(
    Effect.gen(function* () {
      const pool = yield* InferencePool
      yield* pool.register(provider)
      const host = yield* ModuleHost
      yield* bootResearchModule(host)
    })
  )

  return {
    run: <A, E>(effect: Effect.Effect<A, E, EngineRequirements>): Promise<A> =>
      runtime.runPromise(effect),
    chatStream: (sessionId: string, input: string): AsyncIterable<ChatChunk> =>
      Stream.toAsyncIterable(
        Stream.provide(
          Stream.unwrap(Effect.map(AgentLoop, (loop) => loop.chat(sessionId, input))),
          layer
        )
      ),
    shutdown: (): Promise<void> => runtime.dispose()
  }
}
