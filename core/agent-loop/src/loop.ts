/**
 * loop.ts — `AgentLoop`: one single-step chat turn, streamed.
 *
 * Turn flow (M1):
 *   1. Read session history from `MemoryService`; append the user message.
 *   2. Build the inference request (system prompt + history + input) and
 *      dispatch via `InferencePool.generate` with powerhouse routing.
 *      Providers offering `Provider.stream` stream live `Token` chunks
 *      through the loop-owned adapter (`streaming.ts`); otherwise the full
 *      text arrives as one chunk.
 *   3. Parse ```aimy-tool blocks from the assistant text. Malformed blocks
 *      become typed `parseFailures` in the report — never a crash.
 *   4. Execute parsed calls through `ModuleHooks.runTurn` with `executeTool`
 *      wired to the built-in registry. The loop never executes tools
 *      itself — hooks own the gate.
 *   5. Append the assistant message (+ tool-call/tool-result entries) to
 *      the session. Emit `Done` with the `TurnReport`.
 *
 * Agentic multi-step (feed tool results back for another model turn) is
 * explicitly OUT of scope for M1: `chat()` performs exactly one model call
 * per invocation. The extension point is step 5 — loop on `report` until
 * no tool calls remain, with a turn budget.
 */
import { Cause, Context, Effect, Layer, Ref, Stream } from "effect"
import { randomUUID } from "node:crypto"
import { InferencePool } from "../../inference-pool/index.js"
import type {
  GenerateRequest,
  InferenceError,
  InferencePoolService,
  Message,
  Provider
} from "../../inference-pool/index.js"
import {
  HookError,
  ModuleHooks,
  PermissionDenied,
  TurnTerminated,
  ioErrorOutcome,
  okOutcome,
  type ChatMessage,
  type ModuleHooksApi,
  type ToolCall,
  type ToolOutcome,
  type TurnSpec
} from "../../module-seam/src/index.js"
import { SandboxViolation } from "../../substrate/errors.js"
import { MemoryService } from "../../memory/index.js"
import type { MemoryOpError, MemoryServiceShape, NewEntry } from "../../memory/index.js"
import { parseToolBlocks, type ToolBlockParseFailure } from "./tool-call-format.js"
import { makeStreamSource } from "./streaming.js"
import {
  SYSTEM_PROMPT,
  builtinToolTier,
  runBuiltinTool,
  type BuiltinToolContext
} from "./tools.js"

/** The honest error union of the stack this turn drives. Real types only. */
export type AgentLoopError =
  | InferenceError
  | HookError
  | PermissionDenied
  | TurnTerminated
  | SandboxViolation
  | MemoryOpError

/** One streamed unit of a turn. */
export type ChatChunk =
  | { readonly _tag: "Token"; readonly delta: string }
  | { readonly _tag: "ToolCall"; readonly tool: string; readonly result: unknown }
  | { readonly _tag: "Done"; readonly report: TurnReport }

export interface ExecutedToolCall {
  readonly id: string
  readonly tool: string
  /** `Ok` value, or `{ _tag: "IoError", reason }` for tool I/O failures. */
  readonly result: unknown
}

export interface BlockedToolCall {
  readonly tool: string
  readonly reason: string
}

export interface TurnReport {
  readonly turnId: string
  /** Full assistant text for the turn (streamed as Token chunks first). */
  readonly text: string
  readonly executed: ReadonlyArray<ExecutedToolCall>
  readonly blocked: ReadonlyArray<BlockedToolCall>
  readonly terminated: boolean
  /** Malformed ```aimy-tool blocks: typed, surfaced, never a crash. */
  readonly parseFailures: ReadonlyArray<ToolBlockParseFailure>
  readonly steeringMessages: ReadonlyArray<ChatMessage>
  readonly followUpMessages: ReadonlyArray<ChatMessage>
}

export interface AgentLoopService {
  /**
   * Run one single-step turn for `sessionId`: stream tokens, execute any
   * tool calls the model emitted, persist the turn, emit `Done`.
   */
  readonly chat: (sessionId: string, input: string) => Stream.Stream<ChatChunk, AgentLoopError>
}

export class AgentLoop extends Context.Service<AgentLoop, AgentLoopService>()(
  "aimy/agent-loop/AgentLoop"
) {}

const MODULE = "agent-loop"

const toChatMessage = (role: string, content: string): Message => ({
  role: role === "assistant" ? "assistant" : role === "system" ? "system" : "user",
  content
})

/** History for the model: first-class "message" entries only. */
const historyMessages = (
  entries: ReadonlyArray<{ readonly kind: string; readonly payload: Readonly<Record<string, unknown>> }>
): Array<Message> => {
  const out: Array<Message> = []
  for (const e of entries) {
    if (e.kind !== "message") continue
    const { role, text } = e.payload
    if ((role === "user" || role === "assistant") && typeof text === "string") {
      out.push(toChatMessage(role, text))
    }
  }
  return out
}

const outcomeToJson = (outcome: ToolOutcome): unknown =>
  outcome._tag === "Ok" ? outcome.value : { _tag: "IoError", reason: outcome.reason }

interface Deps {
  readonly pool: InferencePoolService
  readonly hooks: ModuleHooksApi
  readonly memory: MemoryServiceShape
  readonly streamProviders: ReadonlyArray<Provider>
}

const makeAgentLoop = ({ pool, hooks, memory, streamProviders }: Deps): AgentLoopService => {
  const streamSource = makeStreamSource(streamProviders)

  const chat = (sessionId: string, input: string): Stream.Stream<ChatChunk, AgentLoopError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        // 1. History + user message.
        const tree = yield* memory.read(sessionId)
        const history = historyMessages(tree.entries)
        const parentId =
          tree.entries.length > 0 ? tree.entries[tree.entries.length - 1]!.id : null
        const userEntry = yield* memory.append(sessionId, {
          parentId,
          kind: "message",
          payload: { role: "user", text: input }
        } satisfies NewEntry)
        const turnCount = history.filter((m) => m.role === "assistant").length

        const request: GenerateRequest = {
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            ...history,
            { role: "user", content: input }
          ],
          params: {},
          maxTokens: 2048
        }

        // 2. Token deltas: live stream when a provider offers it, else one chunk.
        const streamed = streamSource(request)
        const deltas: Stream.Stream<string, InferenceError> =
          streamed ??
          Stream.fromEffect(pool.generate(request, { mode: "powerhouse" }).pipe(Effect.map((r) => r.text)))

        const acc = yield* Ref.make("")
        const tokenPart: Stream.Stream<ChatChunk, AgentLoopError> = deltas.pipe(
          Stream.mapEffect((delta) =>
            Ref.update(acc, (s) => s + delta).pipe(
              Effect.as<ChatChunk>({ _tag: "Token", delta })
            )
          )
        )

        // 3–5. Parse, gate + execute through hooks, persist, report.
        const tailPart: Stream.Stream<ChatChunk, AgentLoopError> = Stream.unwrap(
          Effect.gen(function* () {
            const text = yield* Ref.get(acc)
            const { calls, failures } = parseToolBlocks(text)
            const turnId = randomUUID()
            const toolCtx: BuiltinToolContext = { sessionId, turnCount }

            // Raw executor for the hooks dispatcher. Results are recorded
            // here so the loop can report them; the gate decision itself
            // stays inside `runTurn` — this never runs on a deny.
            const results = yield* Ref.make<ReadonlyMap<string, ToolOutcome>>(new Map())
            const record = (id: string, outcome: ToolOutcome) =>
              Ref.update(results, (m) => new Map(m).set(id, outcome))
            const executeTool = (call: ToolCall): Effect.Effect<unknown, unknown> =>
              runBuiltinTool(call.tool, call.args, toolCtx).pipe(
                Effect.tap((value) => record(call.id, okOutcome(value))),
                Effect.tapCause((cause) =>
                  record(call.id, ioErrorOutcome(Cause.pretty(cause)))
                )
              )

            const spec: TurnSpec = {
              turn: { turnId, module: MODULE },
              contextMessages: request.messages.map((m) => ({
                role: m.role,
                content: m.content
              })),
              toolCalls: calls.map((c, i) => ({
                id: `${turnId}:call:${i}`,
                tool: c.tool,
                args: c.args,
                tier: builtinToolTier(c.tool),
                truncated: false
              })),
              executeTool
            }
            const hookReport = yield* hooks.runTurn(spec)
            const outcomes = yield* Ref.get(results)

            const executed: Array<ExecutedToolCall> = []
            const blocked: Array<BlockedToolCall> = []
            let terminatorSeen = false
            calls.forEach((c, i) => {
              const id = `${turnId}:call:${i}`
              const outcome = outcomes.get(id)
              if (outcome !== undefined) {
                executed.push({ id, tool: c.tool, result: outcomeToJson(outcome) })
                return
              }
              if (hookReport.terminated && terminatorSeen) {
                blocked.push({ tool: c.tool, reason: "not reached: turn terminated" })
              } else if (hookReport.terminated) {
                terminatorSeen = true
                blocked.push({ tool: c.tool, reason: "denied by gate; turn terminated" })
              } else {
                blocked.push({ tool: c.tool, reason: "denied by gate" })
              }
            })

            // 5. Persist the turn: assistant message, then tool-call/result entries.
            let parent: string | null = userEntry.id
            const appendEntry = (entry: NewEntry) =>
              Effect.gen(function* () {
                const written = yield* memory.append(sessionId, { ...entry, parentId: parent })
                parent = written.id
              })
            yield* appendEntry({
              parentId: parent,
              kind: "message",
              payload: { role: "assistant", text }
            })
            for (let i = 0; i < calls.length; i++) {
              const c = calls[i]!
              const id = `${turnId}:call:${i}`
              const outcome = outcomes.get(id)
              yield* appendEntry({
                parentId: parent,
                kind: "tool-call",
                payload: { tool: c.tool, args: c.args, id }
              })
              yield* appendEntry({
                parentId: parent,
                kind: "tool-result",
                payload:
                  outcome !== undefined
                    ? { tool: c.tool, id, outcome: outcomeToJson(outcome) }
                    : {
                        tool: c.tool,
                        id,
                        blocked: true,
                        reason:
                          blocked.find((b) => b.tool === c.tool)?.reason ?? "denied by gate"
                      }
              })
            }

            const report: TurnReport = {
              turnId,
              text,
              executed,
              blocked,
              terminated: hookReport.terminated,
              parseFailures: failures,
              steeringMessages: hookReport.steeringMessages,
              followUpMessages: hookReport.followUpMessages
            }
            const chunks: Array<ChatChunk> = executed.map((e) => ({
              _tag: "ToolCall",
              tool: e.tool,
              result: e.result
            }))
            chunks.push({ _tag: "Done", report })
            return Stream.fromIterable(chunks)
          })
        )

        return Stream.concat(tokenPart, tailPart)
      })
    )

  return { chat }
}

/**
 * Build the loop layer. The wiring step passes the same provider objects
 * it registered with the pool so the streaming adapter can use
 * `Provider.stream` when offered; omit for generate-only operation.
 */
export const layerAgentLoop = (opts?: {
  readonly streamProviders?: ReadonlyArray<Provider>
}): Layer.Layer<AgentLoop, never, InferencePool | ModuleHooks | MemoryService> =>
  Layer.effect(
    AgentLoop,
    Effect.gen(function* () {
      const pool = yield* InferencePool
      const hooks = yield* ModuleHooks
      const memory = yield* MemoryService
      return makeAgentLoop({
        pool,
        hooks,
        memory,
        streamProviders: opts?.streamProviders ?? []
      })
    })
  )

/**
 * Default live layer: composes from `InferencePool + ModuleHooks +
 * MemoryService`. Streaming-capable wiring uses `layerAgentLoop` with
 * `streamProviders` instead.
 */
export const AgentLoopLive: Layer.Layer<
  AgentLoop,
  never,
  InferencePool | ModuleHooks | MemoryService
> = layerAgentLoop()
