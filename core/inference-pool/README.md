# @aimy/inference-pool

The single manager every token routes through. The agent loop, review forks,
curator, compaction summarizer, verification judges, and modules all submit
inference requests here — none holds its own provider client.

## Public interface

```ts
import { Effect } from "effect"
import {
  InferencePool, InferencePoolLive,   // Context.Service tag + Layer
  StubProvider,                        // deterministic fake for tests/demos
  InferenceError                       // typed error (see SHIM note below)
} from "./index.js"

// Provide once at the edge:
const program = Effect.gen(function* () {
  const pool = yield* InferencePool
  yield* pool.register(new StubProvider("local-main"))          // local: no opt-in needed
  yield* pool.setAuxProvider("local-main")                      // aux lane designation
  const res = yield* pool.generate(
    { messages: [{ role: "user", content: "hi" }], params: {}, maxTokens: 128 },
    { mode: "powerhouse" }
  )
  return res.text
})
Effect.runPromise(program.pipe(Effect.provide(InferencePoolLive)))
```

### `Provider` (`provider.ts`)

```ts
interface Provider {
  name: string
  kind: "local" | "cloud"
  egress: "local" | "first-party" | "vendor"
  capabilities: { reasoningTokens: boolean; tools: boolean }
  generate(request: GenerateRequest): Effect.Effect<GenerateResponse, InferenceError>
  stream?(request: GenerateRequest): Stream.Stream<Token, InferenceError>
}
```

`GenerateResponse.usage` **always** includes `reasoningTokens` (Pi #9409).
Where a runtime doesn't expose a reasoning count, the provider reports a named
estimate via `reasoningTokensEstimatedBy` — never a silent zero.

### `InferencePool` service (`pool.ts`)

| Method | Notes |
|---|---|
| `register(provider, { optIn? })` | `cloud`-kind providers **require** `{ optIn: true }` — without it, `InferenceError`. No silent cloud. |
| `generate(request, routing)` | Dispatch per `routing`. See below. |
| `generateAux(request)` | Aux lane: routes **only** to the designated aux provider. Never touches the foreground provider, never falls back to it. Fails with `InferenceError` if no aux provider is designated. |
| `setAuxProvider(name)` | Designates the cheap/local model for background cognition (Hermes `auxiliary_client` pattern). |
| `switchProvider(name, { confirmed })` | Requires `{ confirmed: true }`. Without it, `InferenceError` and no switch. |
| `describeSwitch(name)` | Returns the switch cost as a first-class value: `{ from, to, cacheInvalidated, behaviorDeltaClass }`. |
| `egressOf(name)` | The provider's declared egress class — input to the future NetworkPolicy gate (module-seam contract S8). |
| `registeredProviders()` | Names in registration order. |

**Routing** (`{ mode, task?, providers?, merge? }`):

- `powerhouse` — one logical engine: explicit `providers` chain (tried in
  order) → confirmed active provider → first registered local.
- `parallel` — fan-out to `providers` (default: all registered). Merge policy:
  `first-complete` (default; first success wins, losers interrupted, all-fail
  surfaces the last provider's `InferenceError`) or `merged` (all run,
  texts concatenated in fan-out order, usage summed including reasoning tokens).
- `task: "aux"` on `generate()` takes the aux lane, same as `generateAux()`.

### Guarantees

1. **No keyless fallbacks.** If the chosen provider fails, the pool returns a
   typed `InferenceError` naming the provider and reason. It NEVER silently
   retries a different provider — especially not a cloud one. Fallback chains
   must be explicit in the request (`routing.providers`).
2. **No telemetry.** This module makes zero network calls. The ONLY
   network-touching code allowed in this phase lives inside provider
   implementations, against their own declared inference endpoint. Proven by
   the zero-socket test (`pool.test.ts`).
3. **Cloud strictly opt-in.** Registering a cloud provider without
   `{ optIn: true }` is an `InferenceError` at registration time.
4. **Switches are explicit, costed, confirmed.** `switchProvider` needs
   `{ confirmed: true }`; `describeSwitch` exposes cache-invalidation and
   behavior-delta class before you decide.
5. **Aux never competes with foreground.** Separate named lane with its own
   provider preference; first-complete interruption keeps background work off
   the foreground GPU lease.

### `StubProvider` (`local-stub.ts`)

Deterministic fake: canned text + canned reasoning trace, honest whitespace
token counts (`capabilities.reasoningTokens: true` — it really counts the
trace), per-call log in `calls`, `failNextWith(reason)` to arm one typed
failure, optional `latencyMs` for deterministic race tests. No network.

### `LocalHttpProvider` (`local-http.ts`)

Real HTTP provider for the OpenAI-ish `/v1/chat/completions` shape — one
module covers both llama.cpp-server and Ollama, which share the shape.

```ts
import { LocalHttpProvider } from "./index.js"

const provider = new LocalHttpProvider({
  name: "local-main",            // required
  baseUrl: "http://127.0.0.1:11434", // optional, this is the default
  model: "qwen3.8-27b",         // required, sent as `model`
  timeoutMs: 120000             // optional, this is the default
})
```

- **baseUrl default:** `http://127.0.0.1:11434` (Ollama's default).
  Point it at llama.cpp-server's port (e.g. `http://127.0.0.1:8080`)
  for a llama.cpp backend. `kind: "local"`, `egress: "local"`.
- **Params passthrough:** the POST body is
  `{ model, messages, max_tokens: request.maxTokens, ...request.params }`,
  so the loop can pass through extras (`temperature`, `stop`, …) — params
  merge last and may override `max_tokens`.
- **Capabilities (honest):** `reasoningTokens: false` — this endpoint shape
  does not report reasoning tokens in M1, so usage carries
  `reasoningTokensEstimatedBy: "local-http:no-reasoning-channel"` instead of
  a silent zero; `tools: false` — M1 uses a text tool-call convention, not
  native `tool_calls`.
- **Streaming:** `stream()` posts with `stream: true`, parses SSE
  (`data: {...}` lines, `[DONE]` terminator), yields `Token { delta }`.
  A mid-stream connection drop terminates the stream with a typed
  `InferenceError` — never a hang, never a raw throw.
- **Boot guarantee:** constructing and registering the provider opens zero
  sockets; the endpoint is only touched per `generate`/`stream` call (proven
  by the zero-socket boot test).
- **No telemetry, no cloud, no fallbacks, no retries.** A failure is a typed
  `InferenceError` naming the provider, full stop.

**Error taxonomy** (`reason` strings on `InferenceError`):

| Cause | `reason` |
|---|---|
| Connection refused | `connection refused: <baseUrl>` |
| Timeout (AbortController, default 120s) | `request timed out after <timeoutMs>ms (<baseUrl>)` |
| HTTP 4xx/5xx | `HTTP <status>: <body snippet>` |
| Invalid JSON body / unexpected shape (incl. missing `choices`, non-string content, missing `usage`) | `malformed response: …` |
| SSE chunk fails to parse | `malformed response: invalid SSE JSON chunk: …` |
| Socket destroyed before `[DONE]` | `truncated stream: connection ended before [DONE]` |
| Other transport failure (reset, DNS, …) | `transport failure [<errno>]: <baseUrl>: …` |

## SHIM note

`errors-shim.ts` provides `InferenceError { provider: string; reason: string }`
until `../substrate/errors.ts` lands (parallel build). The name and fields are
identical to the shared contract; the swap is a one-line import change, noted
in the shim header. No other file may change.
