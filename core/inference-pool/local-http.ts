/**
 * local-http.ts — `LocalHttpProvider`: real HTTP provider for the OpenAI-ish
 * `/v1/chat/completions` shape.
 *
 * One module covers both llama.cpp-server and Ollama (they share the request/
 * response shape); `baseUrl` selects the endpoint. Loopback only by default —
 * this provider is `kind: "local"` / `egress: "local"`, and it performs no
 * cloud, telemetry, retry, or fallback behavior. A failure is a typed
 * `InferenceError`, full stop.
 *
 * Honesty discipline (mirrors `local-stub.ts`):
 * - `capabilities.reasoningTokens: false` — this endpoint shape does not
 *   report reasoning tokens in M1, so usage carries
 *   `reasoningTokensEstimatedBy: "local-http:no-reasoning-channel"` instead
 *   of a silent zero.
 * - `capabilities.tools: false` — the loop uses a text tool-call convention
 *   in M1, not native `tool_calls`; this provider does not claim otherwise.
 */
import { Effect, Stream } from "effect"
import { InferenceError } from "./errors-shim.js"
import type {
  GenerateRequest,
  GenerateResponse,
  Provider,
  Token
} from "./provider.js"

/** Constructor opts. Kept exactly: `{ name, baseUrl?, model, timeoutMs? }`. */
export interface LocalHttpProviderOptions {
  readonly name: string
  readonly baseUrl?: string
  readonly model: string
  readonly timeoutMs?: number
}

export const DEFAULT_BASE_URL = "http://127.0.0.1:11434"
export const DEFAULT_TIMEOUT_MS = 120000
/** Estimator name carried on every usage report (never a silent zero). */
export const NO_REASONING_CHANNEL = "local-http:no-reasoning-channel"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const summarizeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const causeCode = (error: unknown): string | undefined => {
  if (!isRecord(error)) return undefined
  const cause = error["cause"]
  return isRecord(cause) && typeof cause["code"] === "string" ? cause["code"] : undefined
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")

/** Transport-level failures -> typed `InferenceError`. Never returns raw. */
const transportError = (
  name: string,
  baseUrl: string,
  timeoutMs: number,
  error: unknown
): InferenceError => {
  if (error instanceof InferenceError) return error
  if (isAbortError(error)) {
    return new InferenceError({
      provider: name,
      reason: `request timed out after ${timeoutMs}ms (${baseUrl})`
    })
  }
  const code = causeCode(error)
  if (code === "ECONNREFUSED") {
    return new InferenceError({ provider: name, reason: `connection refused: ${baseUrl}` })
  }
  if (code !== undefined) {
    return new InferenceError({
      provider: name,
      reason: `transport failure [${code}]: ${baseUrl}: ${summarizeError(error)}`
    })
  }
  return new InferenceError({
    provider: name,
    reason: `request failed: ${baseUrl}: ${summarizeError(error)}`
  })
}

const bodySnippet = async (response: Response, maxChars = 512): Promise<string> => {
  try {
    const text = await response.text()
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
  } catch {
    return "<unreadable body>"
  }
}

const httpStatusError = async (name: string, response: Response): Promise<InferenceError> => {
  const snippet = await bodySnippet(response)
  return new InferenceError({
    provider: name,
    reason: `HTTP ${response.status}: ${snippet}`
  })
}

interface ChatBody {
  readonly model: string
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>
  readonly max_tokens: number
  readonly stream?: boolean
  readonly [key: string]: unknown
}

/** Parse a non-streaming chat-completions response; throws typed errors only. */
const parseGenerateResponse = async (name: string, response: Response): Promise<GenerateResponse> => {
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    throw new InferenceError({
      provider: name,
      reason: `malformed response: invalid JSON: ${summarizeError(error)}`
    })
  }
  if (!isRecord(payload)) {
    throw new InferenceError({ provider: name, reason: "malformed response: expected a JSON object" })
  }
  const choices = payload["choices"]
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new InferenceError({ provider: name, reason: "malformed response: missing choices" })
  }
  const message = isRecord(choices[0]) ? choices[0]["message"] : undefined
  const content = isRecord(message) ? message["content"] : undefined
  if (typeof content !== "string") {
    throw new InferenceError({ provider: name, reason: "malformed response: choices[0].message.content is not a string" })
  }
  // llama.cpp and Ollama both report usage by default; absent/malformed usage
  // is a shape violation, not a zero.
  const usage = payload["usage"]
  if (
    !isRecord(usage) ||
    typeof usage["prompt_tokens"] !== "number" ||
    typeof usage["completion_tokens"] !== "number"
  ) {
    throw new InferenceError({ provider: name, reason: "malformed response: usage.prompt_tokens/completion_tokens missing or not numbers" })
  }
  return {
    text: content,
    usage: {
      inputTokens: usage["prompt_tokens"],
      outputTokens: usage["completion_tokens"],
      // This endpoint shape has no reasoning-token channel in M1: named
      // estimate, never a silent zero (Pi #9409).
      reasoningTokens: 0,
      reasoningTokensEstimatedBy: NO_REASONING_CHANNEL
    }
  }
}

/** Parse one SSE `data:` payload; `[DONE]` returns `undefined`. Throws typed errors only. */
const parseSsePayload = (name: string, payload: string): Token | undefined => {
  const trimmed = payload.trim()
  if (trimmed === "[DONE]") return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    throw new InferenceError({
      provider: name,
      reason: `malformed response: invalid SSE JSON chunk: ${summarizeError(error)}`
    })
  }
  if (!isRecord(parsed)) {
    throw new InferenceError({ provider: name, reason: "malformed response: SSE chunk is not a JSON object" })
  }
  const choices = parsed["choices"]
  const delta = Array.isArray(choices) && isRecord(choices[0]) ? (choices[0] as Record<string, unknown>)["delta"] : undefined
  const content = isRecord(delta) ? delta["content"] : undefined
  if (content === undefined || content === null) return undefined
  if (typeof content !== "string") {
    throw new InferenceError({ provider: name, reason: "malformed response: SSE delta.content is not a string" })
  }
  return { delta: content }
}

export class LocalHttpProvider implements Provider {
  readonly kind = "local" as const
  readonly egress = "local" as const
  readonly capabilities = { reasoningTokens: false, tools: false } as const

  private readonly baseUrl: string
  private readonly model: string
  private readonly timeoutMs: number
  readonly name: string

  /** Construction performs zero network I/O — the endpoint is only touched per call. */
  constructor(opts: LocalHttpProviderOptions) {
    this.name = opts.name
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
    this.model = opts.model
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private requestBody(request: GenerateRequest, stream: boolean): ChatBody {
    // `params` merges into the body so the loop can pass through extras
    // (temperature, stop, …); it may also override max_tokens explicitly.
    return {
      model: this.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: request.maxTokens,
      ...(stream ? { stream: true } : {}),
      ...request.params
    }
  }

  private async postChat(request: GenerateRequest, stream: boolean): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(this.requestBody(request, stream)),
        signal: controller.signal
      })
    } catch (error) {
      throw transportError(this.name, this.baseUrl, this.timeoutMs, error)
    } finally {
      clearTimeout(timer)
    }
  }

  generate(request: GenerateRequest): Effect.Effect<GenerateResponse, InferenceError> {
    return Effect.tryPromise({
      try: async () => {
        const response = await this.postChat(request, false)
        if (!response.ok) throw await httpStatusError(this.name, response)
        return await parseGenerateResponse(this.name, response)
      },
      // Defensive: every throw above is already an InferenceError; this keeps
      // the contract airtight if a future code path ever leaks one.
      catch: (error) => (error instanceof InferenceError ? error : transportError(this.name, this.baseUrl, this.timeoutMs, error))
    })
  }

  /** SSE stream of token deltas. A connection drop mid-stream surfaces a typed `InferenceError`. */
  stream(request: GenerateRequest): Stream.Stream<Token, InferenceError> {
    const self = this
    const iterable: AsyncIterable<Token> = {
      [Symbol.asyncIterator]() {
        return self.sseIterator(request)
      }
    }
    return Stream.fromAsyncIterable(iterable, (error: unknown) =>
      error instanceof InferenceError
        ? error
        : transportError(self.name, self.baseUrl, self.timeoutMs, error)
    )
  }

  private async *sseIterator(request: GenerateRequest): AsyncGenerator<Token> {
    const response = await this.postChat(request, true)
    if (!response.ok) throw await httpStatusError(this.name, response)
    if (response.body === null) {
      throw new InferenceError({ provider: this.name, reason: "streaming response had no body" })
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let sawDone = false
    try {
      for (;;) {
        let readResult: Awaited<ReturnType<typeof reader.read>>
        try {
          readResult = await reader.read()
        } catch (error) {
          // Connection drop mid-stream: typed error, never a hang, never raw.
          throw transportError(this.name, this.baseUrl, this.timeoutMs, error)
        }
        if (readResult.done) break
        buffer += decoder.decode(readResult.value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith("data:")) continue
          const token = parseSsePayload(this.name, trimmed.slice("data:".length))
          if (token === undefined) {
            sawDone = true
            return
          }
          // Skip empty deltas (role-only or usage chunks); emit real text.
          if (token.delta.length > 0) yield token
        }
      }
      if (!sawDone) {
        throw new InferenceError({
          provider: this.name,
          reason: "truncated stream: connection ended before [DONE]"
        })
      }
    } finally {
      reader.releaseLock()
    }
  }
}
