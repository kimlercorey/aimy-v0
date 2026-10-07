/**
 * local-stub.ts — `StubProvider`: deterministic fake provider for tests and
 * offline demos.
 *
 * - No network. Ever. It has no transport code, no fetch, no sockets.
 * - Counts tokens honestly (naive whitespace tokenization) instead of
 *   returning zeros — `capabilities.reasoningTokens: true` because the stub
 *   reports a real (canned) reasoning trace and counts it.
 * - Records every `generate` call in `calls` so tests can assert exactly
 *   which lane/provider was hit (aux-lane isolation, no-fallback proof).
 * - `failNextWith(reason)` arms a single typed `InferenceError` failure;
 *   `latencyMs` makes one stub deterministically slower for race tests.
 */
import { Duration, Effect } from "effect"
import { InferenceError } from "./errors-shim.js"
import type {
  GenerateRequest,
  GenerateResponse,
  Provider,
  Usage
} from "./provider.js"

export interface StubCall {
  readonly request: GenerateRequest
  readonly at: number
}

const countTokens = (text: string): number =>
  text.split(/\s+/).filter((t) => t.length > 0).length

export class StubProvider implements Provider {
  readonly kind = "local" as const
  readonly egress = "local" as const
  readonly capabilities = { reasoningTokens: true, tools: false } as const

  /** Every generate call, in order. The assertion surface for lane tests. */
  readonly calls: Array<StubCall> = []

  private armedFailure: InferenceError | undefined = undefined
  /** Queued follow-up texts: each generate consumes one before falling back to cannedText. */
  private readonly queuedTexts: Array<string> = []

  constructor(
    readonly name: string,
    private readonly cannedText = `[${name}] canned response`,
    private readonly cannedThought = `[${name}] canned reasoning trace`,
    private readonly latencyMs = 0
  ) {}

  /**
   * Queue texts for the next generate calls, in order. Powers multi-round
   * loop tests: the first response can carry a tool block while the
   * follow-up synthesis returns plain text.
   */
  queueTexts(...texts: Array<string>): void {
    this.queuedTexts.push(...texts)
  }

  /** Arm the next `generate` call to fail with a typed `InferenceError`. */
  failNextWith(reason: string): void {
    this.armedFailure = new InferenceError({ provider: this.name, reason })
  }

  reset(): void {
    this.calls.length = 0
    this.armedFailure = undefined
  }

  generate(request: GenerateRequest): Effect.Effect<GenerateResponse, InferenceError> {
    const run: Effect.Effect<GenerateResponse, InferenceError> = Effect.suspend(() => {
      this.calls.push({ request, at: Date.now() })
      const failure = this.armedFailure
      this.armedFailure = undefined
      if (failure !== undefined) return Effect.fail(failure)
      const usage: Usage = {
        inputTokens: request.messages.reduce((n, m) => n + countTokens(m.content), 0),
        outputTokens: countTokens(this.cannedText),
        // Honestly counted: the stub "thinks" the canned trace.
        reasoningTokens: countTokens(this.cannedThought)
      }
      const text = this.queuedTexts.length > 0 ? this.queuedTexts.shift()! : this.cannedText
      return Effect.succeed({ text, usage })
    })
    return this.latencyMs > 0 ? Effect.delay(run, Duration.millis(this.latencyMs)) : run
  }
}
