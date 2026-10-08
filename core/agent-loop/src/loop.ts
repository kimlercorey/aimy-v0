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
import { Cause, Context, Effect, Layer, Option, Ref, Stream } from "effect"

import { AscSelfMonitor, type AscSelfMonitorShape, AscError } from "../../asc-engine/index.js"
import { HonestyService, type HonestyServiceShape } from "../../honesty/src/service.js"
import { runPostTurnHonesty, type TurnHonestyReport } from "../../honesty/wiring.js"
import type { HonestyError } from "../../honesty/src/errors.js"
import type { JudgeError } from "../../honesty/judges/src/contracts.js"
import type { JudgeRegistry } from "../../honesty/judges/src/registry.js"
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
  type TurnReport as SeamTurnReport,
  type TurnSpec
} from "../../module-seam/src/index.js"
import { SandboxViolation } from "../../substrate/errors.js"
import { MemoryService } from "../../memory/index.js"
import type { MemoryOpError, MemoryServiceShape, NewEntry } from "../../memory/index.js"
import { parseToolBlocks, type ToolBlockParseFailure } from "./tool-call-format.js"
import { makeStreamSource } from "./streaming.js"
import {
  runPreTurnAsc,
  runPostTurnAsc,
  type AgentLoopAscOpts,
  type PreTurnAscResult,
  type TurnAscReport
} from "./asc-wiring.js"
import {
  buildSystemPrompt,
  resolveToolTier,
  runTool,
  type AgentToolDef,
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
  // M3 honesty wiring (additive): a judge *infrastructure* failure
  // (JudgeNotFound, JudgeInputInvalid, JudgeThrew, JudgeVerdictInvalid) is a
  // typed error on the stream — distinct from a FAIL verdict, which is data
  // on the report, never an error.
  | HonestyError
  | JudgeError
  // M5 ASC wiring (additive, Track 4): the L2 pipeline's typed failure.
  // An AscError is an infrastructure failure of the self-monitoring
  // pipeline — distinct from anything the pipeline *reports* (gates,
  // firings, audits are all data on `report.asc`, never errors).
  | AscError

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
  /** Tool rounds used this turn (1 = first pass called tools and got a synthesis; 0 = no tools). */
  readonly toolRounds: number
  /** Malformed ```aimy-tool blocks: typed, surfaced, never a crash. */
  readonly parseFailures: ReadonlyArray<ToolBlockParseFailure>
  readonly steeringMessages: ReadonlyArray<ChatMessage>
  readonly followUpMessages: ReadonlyArray<ChatMessage>
  /**
   * M3 post-turn honesty (additive): present when the layer was composed
   * with `HonestyService`. Carries the per-claim badges and judge verdicts —
   * including failures (`honesty.failedVerdicts`), which are surfaced here
   * and never swallowed.
   */
  readonly honesty?: TurnHonestyReport
  /**
   * M5 ASC wiring (additive, Track 4): present when the layer was composed
   * with `AscSelfMonitor` (see `layerAgentLoopWithAsc`). Carries the L2
   * pre-turn computation and the post-turn audit — dials, stake, gate,
   * guard, error-term firings, audit record. The `Done` chunk is only
   * constructed after the post-turn audit settles, so `report.asc` is
   * always complete when present.
   */
  readonly asc?: TurnAscReport
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
  /**
   * M3 honesty wiring (additive): `Some` when the layer was composed with
   * `HonestyService`, `None` otherwise (the Done path then skips the
   * pipeline). Resolved via `Effect.serviceOption` so the layer's
   * requirements are unchanged.
   */
  readonly honesty: Option.Option<HonestyServiceShape>
  readonly honestyOpts: AgentLoopHonestyOpts | undefined
  /**
   * M5 ASC wiring (additive, Track 4): `Some` when the layer was composed
   * with `AscSelfMonitor` (see `layerAgentLoopWithAsc`), `None` otherwise.
   * The loop READS the pipeline (pre-turn dials, post-turn audit) and never
   * writes dials — the only dial writer stays `AscSelfMonitor.preTurn`
   * (seam S7).
   */
  readonly asc: Option.Option<AscSelfMonitorShape>
  readonly ascOpts: AgentLoopAscOpts | undefined
  /**
   * Registered module tools (additive): tools beyond the built-ins that the
   * model may call, e.g. `retrieval.query` from the web-retrieval module.
   * They appear in the system prompt and are gated at their declared tier
   * through the same `runTurn` hook dispatch as built-ins.
   */
  readonly extraTools: ReadonlyArray<AgentToolDef>
  /**
   * Tool-result feedback (additive): after tools execute, their results feed
   * back to the model for a follow-up synthesis pass, so the turn's answer
   * actually uses what the tools returned. Capped at this many tool rounds
   * (a round = parse + gate + execute + synthesize). Default 3.
   */
  readonly maxToolRounds: number
}

/**
 * M3 post-turn honesty wiring options for `layerAgentLoop` (Track 3).
 * Everything is optional; `AgentLoopLive` passes none of it.
 */
export interface AgentLoopHonestyOpts {
  /**
   * Demo-only: record one evidence-less claim per turn so the `unverified`
   * badge is exhibited. Never set in production wiring.
   */
  readonly recordUnverifiedDemoClaim?: boolean | undefined
  /** Judge registry override (tests). Defaults to the M3 reference judges. */
  readonly registry?: JudgeRegistry | undefined
  /** Runner clock override (tests): stamps `ranAt` only; judges never see it. */
  readonly now?: string | undefined
}

const makeAgentLoop = ({
  pool,
  hooks,
  memory,
  streamProviders,
  honesty,
  honestyOpts,
  asc,
  ascOpts,
  extraTools,
  maxToolRounds
}: Deps): AgentLoopService => {
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
        // Turns, not messages: a multi-round turn persists several assistant
        // messages (one per synthesis pass), but every turn begins with
        // exactly one user message.
        const turnCount = history.filter((m) => m.role === "user").length
        const turnNumber = turnCount + 1

        // M5 ASC prepareRequest point (additive, Track 4). Runs after the
        // user message is appended and before the inference request is
        // dispatched — the slot `prepareRequest` occupies in the canonical
        // hook sequence. The pipeline (and only the pipeline) writes the
        // live dial vector here; the loop keeps only the read result.
        const ascCtx: PreTurnAscResult | undefined = Option.isSome(asc)
          ? yield* runPreTurnAsc(asc.value, {
              turn: turnNumber,
              input,
              proxyOverrides: ascOpts?.proxyOverrides
            })
          : undefined
        // Set once the finishTurn audit has run; the abort finalizer below
        // consults it so the audit runs exactly once per turn.
        const auditDoneRef = yield* Ref.make(false)

        const request: GenerateRequest = {
          messages: [
            { role: "system", content: buildSystemPrompt(extraTools) },
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
        //
        // Multi-round tool feedback: after a round's tools execute, their
        // results feed back to the model for a follow-up synthesis pass, so
        // the turn's answer actually uses what the tools returned. Without
        // this the model emits a tool call, the results land in the ledger,
        // and the user never gets an answer built from them. Capped at
        // maxToolRounds; a round with no tool calls ends the loop.
        const tailPart: Stream.Stream<ChatChunk, AgentLoopError> = Stream.unwrap(
          Effect.gen(function* () {
            const turnId = crypto.randomUUID()
            const toolCtx: BuiltinToolContext = { sessionId, turnCount, turnId }
            const out: Array<ChatChunk> = []
            const executed: Array<ExecutedToolCall> = []
            const blocked: Array<BlockedToolCall> = []
            const parseFailures: Array<ToolBlockParseFailure> = []
            let terminated = false
            let toolRounds = 0
            // Neutral hook report when the loop never reaches runTurn
            // (round 0 emitted no tool calls) — mirrors a clean dispatch.
            let hookReport: SeamTurnReport = {
              turnId,
              executed: 0,
              blocked: 0,
              terminated: false,
              steeringMessages: [],
              followUpMessages: []
            }

            // Persistence chain for this turn.
            let parent: string | null = userEntry.id
            const appendEntry = (entry: NewEntry) =>
              Effect.gen(function* () {
                const written = yield* memory.append(sessionId, { ...entry, parentId: parent })
                parent = written.id
              })

            // Raw executor for the hooks dispatcher. Results are recorded
            // here so the loop can report them; the gate decision itself
            // stays inside `runTurn` — this never runs on a deny.
            const results = yield* Ref.make<ReadonlyMap<string, ToolOutcome>>(new Map())
            const record = (id: string, outcome: ToolOutcome) =>
              Ref.update(results, (m) => new Map(m).set(id, outcome))
            const executeTool = (call: ToolCall): Effect.Effect<unknown, unknown> =>
              runTool(call.tool, call.args, toolCtx, extraTools).pipe(
                Effect.tap((value) => record(call.id, okOutcome(value))),
                Effect.tapCause((cause) =>
                  record(call.id, ioErrorOutcome(Cause.pretty(cause)))
                )
              )

            // Round 0 text is the streamed first pass; later rounds stream
            // their own Token chunks into `out` as they generate.
            let text = yield* Ref.get(acc)
            let conversation: ReadonlyArray<Message> = request.messages
            let round = 0
            for (;;) {
              // Persist this round's assistant text first, so the session
              // tree reads in the order the user experienced it.
              yield* appendEntry({
                parentId: parent,
                kind: "message",
                payload: { role: "assistant", text }
              })

              const { calls, failures } = parseToolBlocks(text)
              parseFailures.push(...failures)
              if (calls.length === 0 || terminated || round >= maxToolRounds) break

              const spec: TurnSpec = {
                turn: { turnId, module: MODULE },
                contextMessages: conversation.map((m) => ({
                  role: m.role,
                  content: m.content
                })),
                toolCalls: calls.map((c, i) => ({
                  id: `${turnId}:r${round}:${i}`,
                  tool: c.tool,
                  args: c.args,
                  tier: resolveToolTier(c.tool, extraTools),
                  truncated: false
                })),
                executeTool
              }
              hookReport = yield* hooks.runTurn(spec)
              const outcomes = yield* Ref.get(results)
              if (hookReport.terminated) terminated = true

              let terminatorSeen = false
              const resultLines: Array<string> = []
              for (let i = 0; i < calls.length; i++) {
                const c = calls[i]!
                const id = `${turnId}:r${round}:${i}`
                const outcome = outcomes.get(id)
                if (outcome !== undefined) {
                  const resultJson = outcomeToJson(outcome)
                  executed.push({ id, tool: c.tool, result: resultJson })
                  out.push({ _tag: "ToolCall", tool: c.tool, result: resultJson })
                  resultLines.push(
                    `- ${c.tool}(${JSON.stringify(c.args)}) → ${JSON.stringify(resultJson).slice(0, 4000)}`
                  )
                } else {
                  const reason =
                    hookReport.terminated && terminatorSeen
                      ? "not reached: turn terminated"
                      : hookReport.terminated
                        ? "denied by gate; turn terminated"
                        : "denied by gate"
                  if (hookReport.terminated) terminatorSeen = true
                  blocked.push({ tool: c.tool, reason })
                  resultLines.push(
                    `- ${c.tool}(${JSON.stringify(c.args)}) → BLOCKED: ${reason} (do not retry this call)`
                  )
                }
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
              toolRounds++
              round++
              if (terminated || round >= maxToolRounds) break

              // Follow-up synthesis: the model sees what its tools returned
              // and answers the user. This is the pass that was missing —
              // without it, tool results land in the ledger but the reply
              // never uses them.
              const followMessages: ReadonlyArray<Message> = [
                ...conversation,
                { role: "assistant", content: text },
                {
                  role: "user",
                  content:
                    `Tool results for your last message. Answer the user's original question directly using these results — do not re-call a tool that already returned, and do not claim you lack a capability these results prove you have:\n${resultLines.join("\n")}`
                }
              ]
              const followRequest: GenerateRequest = {
                messages: followMessages,
                params: {},
                maxTokens: 2048
              }
              const followStreamed = streamSource(followRequest)
              const followDeltas: Stream.Stream<string, InferenceError> =
                followStreamed ??
                Stream.fromEffect(
                  pool.generate(followRequest, { mode: "powerhouse" }).pipe(Effect.map((r) => r.text))
                )
              const followAcc = yield* Ref.make("")
              yield* followDeltas.pipe(
                Stream.runForEach((delta) =>
                  Effect.gen(function* () {
                    yield* Ref.update(followAcc, (s) => s + delta)
                    out.push({ _tag: "Token", delta })
                  })
                )
              )
              text = yield* Ref.get(followAcc)
              conversation = followMessages
            }

            const report: TurnReport = {
              turnId,
              text,
              executed,
              blocked,
              terminated,
              toolRounds,
              parseFailures,
              steeringMessages: hookReport.steeringMessages,
              followUpMessages: hookReport.followUpMessages
            }

            // 6. M3 post-turn honesty (Track 3). Runs only when the layer
            // was composed with HonestyService. A FAIL verdict is DATA on
            // the report (`report.honesty.failedVerdicts`) — never an
            // exception, never hidden. A judge *infrastructure* error
            // (JudgeNotFound, …) is a typed error on the stream, distinct
            // from a FAIL verdict.
            const honestyReport = Option.isSome(honesty)
              ? yield* runPostTurnHonesty(honesty.value, {
                  sessionId,
                  input,
                  report,
                  recordUnverifiedDemoClaim: honestyOpts?.recordUnverifiedDemoClaim,
                  registry: honestyOpts?.registry,
                  now: honestyOpts?.now
                })
              : undefined
            const honestReport: TurnReport =
              honestyReport === undefined ? report : { ...report, honesty: honestyReport }

            // 7. M5 ASC finishTurn point (additive, Track 4). The post-turn
            // audit runs here — BEFORE the Done chunk is constructed, so the
            // loop never emits completion before the audit settles (settled
            // = post-turn audit complete + DialComputation archived by
            // preTurn). Gate/firings/audit are data on `report.asc`, never
            // errors; only a pipeline *infrastructure* failure (AscError)
            // travels the error channel.
            let ascReport: TurnAscReport | undefined
            if (ascCtx !== undefined && Option.isSome(asc)) {
              ascReport = yield* runPostTurnAsc(asc.value, {
                pre: ascCtx.pre,
                analysis: ascCtx.analysis,
                turn: turnNumber,
                outputText: text
              })
              yield* Ref.set(auditDoneRef, true)
            }
            const fullReport: TurnReport =
              ascReport === undefined ? honestReport : { ...honestReport, asc: ascReport }
            // `out` carries the turn's chunks in experience order: each
            // round's ToolCall chunks, then the follow-up synthesis Token
            // chunks, ending here with Done.
            out.push({ _tag: "Done", report: fullReport })
            return Stream.fromIterable(out)
          })
        )

        // Abort discipline (Track 4): if the stream ends before the
        // finishTurn audit ran — interrupt, generation failure — run the
        // audit marked partial. Finalizers run uninterruptibly, so the
        // audit cannot be skipped by the abort that triggered it. An
        // interrupt landing exactly mid-audit may leave a second, partial
        // audit record; both stay in the log, auditable, never silent.
        //
        // The finalizer cannot fail the stream (Stream.ensuring requires
        // Effect<_, never, _>): an audit *infrastructure* failure on the
        // abort path is swallowed here — the stream is already tearing
        // down, and the archived DialComputation preserves the pre-abort
        // state. (On the normal path the same failure IS a typed AscError.)
        const abortAudit: Effect.Effect<void, never, never> = Effect.gen(function* () {
          if (ascCtx === undefined || Option.isNone(asc)) return
          const done = yield* Ref.get(auditDoneRef)
          if (done) return
          yield* Ref.set(auditDoneRef, true)
          const text = yield* Ref.get(acc)
          yield* Effect.ignore(
            runPostTurnAsc(asc.value, {
              pre: ascCtx.pre,
              analysis: ascCtx.analysis,
              turn: turnNumber,
              outputText: text,
              partial: true,
              abortNote: "turn stream ended before completion"
            })
          )
        })

        return Stream.concat(tokenPart, tailPart).pipe(Stream.ensuring(abortAudit))
      })
    )

  return { chat }
}

/**
 * Build the loop layer. The wiring step passes the same provider objects
 * it registered with the pool so the streaming adapter can use
 * `Provider.stream` when offered; omit for generate-only operation.
 *
 * M3 honesty (additive, opt-in): when the composed layer provides
 * `HonestyService` (e.g. merged with `HonestyServiceInMemory`), the post-turn
 * honesty pipeline runs in the `Done` path and the report carries
 * `report.honesty`. `opts.honesty` tunes the pipeline (demo claim, judge
 * registry override, runner clock). `AgentLoopLive` passes no honesty
 * options and its requirements are unchanged.
 */
export const layerAgentLoop = (opts?: {
  readonly streamProviders?: ReadonlyArray<Provider> | undefined
  readonly honesty?: AgentLoopHonestyOpts | undefined
  readonly extraTools?: ReadonlyArray<AgentToolDef> | undefined
  readonly maxToolRounds?: number | undefined
}): Layer.Layer<AgentLoop, never, InferencePool | ModuleHooks | MemoryService> =>
  Layer.effect(
    AgentLoop,
    Effect.gen(function* () {
      const pool = yield* InferencePool
      const hooks = yield* ModuleHooks
      const memory = yield* MemoryService
      const honesty = yield* Effect.serviceOption(HonestyService)
      return makeAgentLoop({
        pool,
        hooks,
        memory,
        streamProviders: opts?.streamProviders ?? [],
        honesty,
        honestyOpts: opts?.honesty,
        asc: Option.none(),
        ascOpts: undefined,
        extraTools: opts?.extraTools ?? [],
        maxToolRounds: opts?.maxToolRounds ?? 3
      })
    })
  )

/**
 * M3 honesty variant of `layerAgentLoop`: `HonestyService` is a declared
 * requirement, so the post-turn pipeline is guaranteed to run in the `Done`
 * path. Prefer this over the ambient `serviceOption` pickup in
 * `layerAgentLoop` when the wiring must hold by construction rather than by
 * composition accident.
 */
export const layerAgentLoopWithHonesty = (opts?: {
  readonly streamProviders?: ReadonlyArray<Provider> | undefined
  readonly honesty?: AgentLoopHonestyOpts | undefined
  readonly extraTools?: ReadonlyArray<AgentToolDef> | undefined
  readonly maxToolRounds?: number | undefined
}): Layer.Layer<AgentLoop, never, InferencePool | ModuleHooks | MemoryService | HonestyService> =>
  Layer.effect(
    AgentLoop,
    Effect.gen(function* () {
      const pool = yield* InferencePool
      const hooks = yield* ModuleHooks
      const memory = yield* MemoryService
      const honestyService = yield* HonestyService
      return makeAgentLoop({
        pool,
        hooks,
        memory,
        streamProviders: opts?.streamProviders ?? [],
        honesty: Option.some(honestyService),
        honestyOpts: opts?.honesty,
        asc: Option.none(),
        ascOpts: undefined,
        extraTools: opts?.extraTools ?? [],
        maxToolRounds: opts?.maxToolRounds ?? 3
      })
    })
  )

/**
 * M5 ASC variant of `layerAgentLoop` (Track 4): `AscSelfMonitor` is a declared
 * requirement, so the per-turn pipeline is guaranteed to run — `preTurn` at
 * the prepareRequest point, the post-turn audit at the finishTurn point,
 * attached to the turn's `Done` chunk as `report.asc`. On abort the audit
 * still runs, marked partial (see the abort finalizer in `chat`).
 *
 * The loop never writes dials: the only dial writer stays
 * `AscSelfMonitor.preTurn` via `DialState.applyPipelineDials` (seam S7).
 */
export const layerAgentLoopWithAsc = (opts?: {
  readonly streamProviders?: ReadonlyArray<Provider> | undefined
  readonly asc?: AgentLoopAscOpts | undefined
  readonly extraTools?: ReadonlyArray<AgentToolDef> | undefined
  readonly maxToolRounds?: number | undefined
}): Layer.Layer<AgentLoop, never, InferencePool | ModuleHooks | MemoryService | AscSelfMonitor> =>
  Layer.effect(
    AgentLoop,
    Effect.gen(function* () {
      const pool = yield* InferencePool
      const hooks = yield* ModuleHooks
      const memory = yield* MemoryService
      const ascMonitor = yield* AscSelfMonitor
      return makeAgentLoop({
        pool,
        hooks,
        memory,
        streamProviders: opts?.streamProviders ?? [],
        honesty: Option.none(),
        honestyOpts: undefined,
        asc: Option.some(ascMonitor),
        ascOpts: opts?.asc,
        extraTools: opts?.extraTools ?? [],
        maxToolRounds: opts?.maxToolRounds ?? 3
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
