/**
 * provider.ts — the Provider contract every inference backend implements.
 *
 * One canonical message model; per-provider `generate` (+ optional `stream`).
 * Providers are installable modules, not in-tree core: the pool ships local
 * runtimes (Ollama/llama.cpp-shaped local endpoints) and a LiteLLM-style
 * abstraction for opt-in cloud endpoints. Adding a provider = declaring an
 * egress class at registration.
 */
import type { Effect, Stream } from "effect"
import type { InferenceError } from "./errors-shim.js"

/** Local-first classification. `cloud` requires explicit opt-in at registration. */
export type ProviderKind = "local" | "cloud"

/**
 * Egress class, declared per provider. Consumed by the future NetworkPolicy
 * gate (module-seam contract S8):
 * - `local` — no bytes leave the machine (loopback IPC, local runtime).
 * - `first-party` — traffic to the user's own paired instances (UUID identity).
 * - `vendor` — traffic to a third-party vendor (always opt-in, keyed).
 */
export type EgressClass = "local" | "first-party" | "vendor"

export interface Message {
  readonly role: "system" | "user" | "assistant"
  readonly content: string
}

export interface GenerateRequest {
  readonly messages: ReadonlyArray<Message>
  readonly params: Readonly<Record<string, unknown>>
  readonly maxTokens: number
}

/**
 * Token accounting. `reasoningTokens` is ALWAYS present (architecture §4.10,
 * Pi #9409): where a runtime does not expose a reasoning count, the pool or
 * provider reports a named estimate instead of a silent zero —
 * `reasoningTokensEstimatedBy` names the estimator used.
 */
export interface Usage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  /** Present only when `reasoningTokens` is an estimate; names the estimator. */
  readonly reasoningTokensEstimatedBy?: string
}

export interface GenerateResponse {
  readonly text: string
  readonly usage: Usage
}

/** A single streamed token delta. */
export interface Token {
  readonly delta: string
}

export interface ProviderCapabilities {
  /** True when the provider reports real reasoning-token counts. */
  readonly reasoningTokens: boolean
  /** True when the provider supports tool calling. */
  readonly tools: boolean
}

/**
 * A `Provider` is `Context.Tag`-able: service keys are created per
 * implementation with `Context.Service<Provider>()(name)` where needed.
 */
export interface Provider {
  readonly name: string
  readonly kind: ProviderKind
  readonly egress: EgressClass
  readonly capabilities: ProviderCapabilities
  generate(request: GenerateRequest): Effect.Effect<GenerateResponse, InferenceError>
  stream?(request: GenerateRequest): Stream.Stream<Token, InferenceError>
}
