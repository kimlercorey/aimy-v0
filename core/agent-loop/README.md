# agent-loop — the M1 agent turn loop

One public method: `AgentLoop.chat(sessionId, input)` runs a single chat turn
and streams it as `Token` / `ToolCall` / `Done` chunks. TypeScript + Effect 4.
No network, no code execution, no filesystem writes beyond the session store.

## Turn flow

`chat()` drives exactly one turn through the module-seam hook taxonomy
(`ModuleHooks.runTurn`):

1. **History** — read the session tree from `MemoryService`; append the user
   message (chained to the last entry).
2. **Generate** — build the inference request (system prompt + history +
   input) and dispatch via `InferencePool.generate` with powerhouse routing
   (`{ mode: "powerhouse" }`).
3. **Stream** — when a provider handed to the loop offers `Provider.stream`,
   its deltas are re-emitted live as `Token` chunks through the loop-owned
   adapter (`src/streaming.ts`); otherwise the full text arrives as one
   `Token` chunk. `pool.ts` is untouched — the pool has no streaming surface.
4. **Parse** — extract `aimy-tool` blocks from the assistant text (below).
5. **Gate + execute** — run the parsed calls through `ModuleHooks.runTurn`
   with `executeTool` wired to the built-in registry. The loop never executes
   tools itself; `beforeToolCall` (module hooks + SafetyKernel) decides, the
   tool boundary normalizes I/O failures into `IoError` outcomes.
6. **Persist** — append the assistant message, then `tool-call` /
   `tool-result` entries (chained), to the session. Emit `Done` with the
   `TurnReport`.

## The `aimy-tool` wire format (M1 convention)

The model emits tool calls as fenced blocks, one JSON object per block:

````markdown
```aimy-tool
{ "tool": "clock.now", "args": {} }
```
````

- Multiple blocks per message are allowed; they execute in order.
- Shape: `{ "tool": "<name>", "args": { ... } }`. `args` may be omitted.
- A block that is not valid JSON, or not that shape, is a **typed parse
  failure**: it lands in `TurnReport.parseFailures` and the turn completes —
  it never crashes. Valid blocks still execute.

## Built-in tools (read-only, T0)

| Tool | Returns |
|---|---|
| `clock.now` | Current time as an ISO-8601 string. `args: {}` |
| `session.info` | `{ sessionId, turnCount }` — completed assistant turns before this one. `args: {}` |

Unknown tool names fail at execution and surface as an `IoError` tool
outcome in the `ToolCall` chunk and report — the turn records the mistake,
it does not crash. No code execution, no network, no filesystem writes:
that is M2/M4 territory and must not appear here.

Module-scoped hooks fire under the turn's module name, `"agent-loop"`:
a module's `beforeToolCall`/`afterToolCall` impls observe these calls only
when registered with `module: "agent-loop"`.

## Scope limit: single-step only

`chat()` performs **exactly one model call** per invocation. Agentic
multi-step (feed tool results back for another model turn) is explicitly out
of scope for M1. The extension point is step 6: loop on the `TurnReport`
until no tool calls remain, with a turn budget — and decide then whether
tool results re-enter the context (they are persisted as `tool-call` /
`tool-result` entries today, not fed back to the model).

## Error channel

`chat()` returns `Stream<ChatChunk, AgentLoopError>` where `AgentLoopError`
is the honest union of what the stack produces — real types, imported, not
invented:

```ts
type AgentLoopError =
  | InferenceError      // inference-pool: provider/endpoint failure (no silent fallback)
  | HookError           // module-seam: hook boundary held (defects become this)
  | PermissionDenied     // permission-kernel / memory: gate refused the operation
  | TurnTerminated       // module-seam: deny-with-terminate ended the turn
  | SandboxViolation     // module-seam: sandbox backend refused (fail closed)
  | MemoryOpError        // memory: MemoryStoreError | PermissionDenied
```

No throws across the boundary, ever. A malformed tool block is not an error-
channel event at all — it is data in `TurnReport.parseFailures`.

## Wiring

```ts
import { AgentLoopLive } from "./src/index.js" // or "../agent-loop/src/index.js"

// Default: generate-only (no streaming).
const program = Layer.provide(AgentLoopLive, Layer.mergeAll(InferencePoolLive, hooksLayer, memoryLayer))

// Streaming-capable: hand the loop the provider objects you registered
// with the pool; the adapter streams from the first offering Provider.stream.
import { layerAgentLoop } from "./src/index.js"
const streaming = Layer.provide(
  layerAgentLoop({ streamProviders: [localHttpProvider] }),
  Layer.mergeAll(InferencePoolLive, hooksLayer, memoryLayer)
)
```

## Layout

| File | Contents |
|---|---|
| `src/loop.ts` | `AgentLoop` service, `ChatChunk`, `TurnReport`, `AgentLoopError`, `layerAgentLoop` / `AgentLoopLive`. |
| `src/tool-call-format.ts` | `parseToolBlocks` — the `aimy-tool` wire format. Never throws. |
| `src/tools.ts` | `BuiltinTools` registry (`clock.now`, `session.info`), `SYSTEM_PROMPT`. |
| `src/streaming.ts` | Loop-owned streaming adapter over `Provider.stream`. |
| `src/index.ts` | Re-exports. |
| `test/loop.test.ts` | 13 tests against `StubProvider` only; the **real** `SafetyKernel` wires behind both the module-seam seam and memory's `PermissionGate`. |
