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
  analyzeContent,
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
  type BuiltinToolContext,
  type NarrateAscHooks,
  type NarrationSink
} from "./tools.js"
import type { BackgroundJobRegistry } from "./background-job.js"
import {
  stageCompaction,
  verifyStaged,
  accountUsage,
} from "../../memory/compaction.js"
import type { SessionTree, SessionEntry } from "../../memory/session-tree.js"

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
   * Images (2026-10-11): vision attachments as data URLs, sent as
   * OpenAI-style image_url content parts when the provider supports them.
   */
  readonly chat: (
    sessionId: string,
    input: string,
    images?: ReadonlyArray<{ dataUrl: string; mimeType: string; name: string }>
  ) => Stream.Stream<ChatChunk, AgentLoopError>
}

export class AgentLoop extends Context.Service<AgentLoop, AgentLoopService>()(
  "aimy/agent-loop/AgentLoop"
) {}

const MODULE = "agent-loop"

const toChatMessage = (role: string, content: string): Message => ({
  role: role === "assistant" ? "assistant" : role === "system" ? "system" : "user",
  content
})

/**
 * Extract narrated voice moments from session entries (2026-10-11).
 * Returns the texts the model spoke aloud via the narrate tool, in order.
 * The caller merges these into the system prompt content (NOT as separate
 * system messages — Jinja requires system at position 0 only).
 */
const extractVoiceMoments = (
  entries: ReadonlyArray<{ readonly kind: string; readonly payload: Readonly<Record<string, unknown>> }>
): ReadonlyArray<string> => {
  const moments: string[] = []
  for (const e of entries) {
    if (e.kind === "tool-call" && e.payload["tool"] === "narrate") {
      const args = e.payload["args"]
      const text = typeof args === "object" && args !== null
        ? (args as Record<string, unknown>)["text"]
        : undefined
      if (typeof text === "string" && text.trim().length > 0) {
        moments.push(text.trim())
      }
    }
  }
  return moments
}

/** History for the model: first-class "message" entries only. */
const historyMessages = (
  entries: ReadonlyArray<{ readonly kind: string; readonly payload: Readonly<Record<string, unknown>> }>
): Array<Message> => {
  const out: Array<Message> = []
  // Skip the wake exchange (2026-10-11): the silent wake turn's user prompt
  // (payload.wake=true) and ALL its assistant responses (one per tool round)
  // are internal — they must not appear in history, or the model repeats
  // the wake thoughts.
  let inWakeExchange = false
  for (const e of entries) {
    if (e.kind === "summary") {
      // Hierarchical summary: collapsed older messages. Include as a system
      // note so the model knows this is compressed context, not a live message.
      // NOTE: This creates a system message mid-history which may violate
      // Jinja templates requiring system at position 0. If crashes occur,
      // merge summaries into the main system prompt like voice moments.
      const { text } = e.payload
      if (typeof text === "string" && text.trim().length > 0) {
        out.push(toChatMessage("system", `[Summary of earlier conversation: ${text.trim()}]`))
      }
      continue
    }
    if (e.kind !== "message") continue
    const { role, text, wake } = e.payload as { role?: unknown; text?: unknown; wake?: unknown }
    if ((role === "user" || role === "assistant") && typeof text === "string") {
      // Wake user prompt: enter wake-exchange mode, skip it.
      if (role === "user" && wake === true) {
        inWakeExchange = true
        continue
      }
      // Non-wake user message: exit wake-exchange mode.
      if (role === "user") {
        inWakeExchange = false
      }
      // Skip all assistant messages inside the wake exchange.
      if (inWakeExchange) continue
      // Skip empty assistant messages — they're noise from failed turns and
      // teach the model to return empty. Only keep messages with content.
      if (role === "assistant" && text.trim().length === 0) continue
      out.push(toChatMessage(role, text))
    }
  }
  return out
}

/**
 * Rough token estimate: ~4 characters per token for English text.
 * Conservative (over-estimates) to avoid context overflow.
 * For multimodal content, sums text parts + estimates 1000 tokens per image.
 */
const estimateTokens = (content: string | ReadonlyArray<{ type: string; text?: string }>): number => {
  if (typeof content === "string") return Math.ceil(content.length / 4)
  let total = 0
  for (const part of content) {
    if (part.type === "text" && part.text) total += Math.ceil(part.text.length / 4)
    else if (part.type === "image_url") total += 1000 // rough vision token estimate
  }
  return total
}

/**
 * Truncate conversation history to fit within a token budget.
 * Keeps the most recent messages; drops oldest first.
 * The system prompt and current input are NOT counted here — the caller
 * reserves budget for them separately.
 *
 * Returns the truncated history and whether truncation occurred.
 */
const truncateHistory = (
  history: ReadonlyArray<Message>,
  maxHistoryTokens: number,
  maxMessages: number = 40
): { readonly messages: Array<Message>; readonly truncated: boolean; readonly dropped: number } => {
  // First, limit by message count (models choke on too many messages even if short).
  let working = history
  if (working.length > maxMessages) {
    working = working.slice(working.length - maxMessages)
  }
  // Then, estimate from the end (most recent) backwards by tokens.
  let tokens = 0
  let keepFrom = working.length
  for (let i = working.length - 1; i >= 0; i--) {
    const msg = working[i]!
    const msgTokens = estimateTokens(msg.content)
    if (tokens + msgTokens > maxHistoryTokens) break
    tokens += msgTokens
    keepFrom = i
  }
  const dropped = history.length - (working.length - keepFrom) - (history.length - working.length)
  const actualDropped = history.length - working.slice(keepFrom).length
  return {
    messages: working.slice(keepFrom),
    truncated: actualDropped > 0,
    dropped: actualDropped
  }
}

const outcomeToJson = (outcome: ToolOutcome): unknown =>
  outcome._tag === "Ok" ? outcome.value : { _tag: "IoError", reason: outcome.reason }

/**
 * Compaction result for indicators.
 */
export interface CompactionResult {
  readonly compacted: boolean
  readonly summarizedCount: number
  readonly summaryChars: number
}

/**
 * Automatic hierarchical compaction: when a session exceeds the threshold,
 * collapse the oldest messages into a summary entry. The originals are
 * preserved (append-only); the summary references them for crosswalk.
 */
const maybeCompactSession = (
  memory: MemoryServiceShape,
  sessionId: string,
  tree: SessionTree,
): Effect.Effect<CompactionResult, never, never> =>
  Effect.gen(function* () {
    const COMPACTION_THRESHOLD = 80
    const COMPACTION_WINDOW = 40
    if (tree.entries.length <= COMPACTION_THRESHOLD) {
      return { compacted: false, summarizedCount: 0, summaryChars: 0 }
    }
    const messageEntries = tree.entries.filter((e: SessionEntry) => e.kind === "message")
    if (messageEntries.length <= COMPACTION_WINDOW) {
      return { compacted: false, summarizedCount: 0, summaryChars: 0 }
    }
    const toCompact = messageEntries.slice(0, COMPACTION_WINDOW)
    const fromId = toCompact[0]!.id
    const toId = toCompact[toCompact.length - 1]!.id
    console.log(`[aimy] compaction: ${tree.entries.length} entries, collapsing oldest ${toCompact.length}`)
    const firstTs = toCompact[0]!.ts
    const firstUserMsg = toCompact.find((e) => (e.payload as { role?: string }).role === "user")
    const firstText = ((firstUserMsg?.payload as { text?: string })?.text ?? "").substring(0, 100)
    const summaryText = `Previous conversation (${toCompact.length} messages, ${new Date(firstTs).toLocaleDateString()}): started with "${firstText}...". See full history for details.`
    const usage = accountUsage({ promptText: "", completionText: summaryText })
    const staged = yield* stageCompaction(tree, { fromId, toId }, () => summaryText, usage).pipe(Effect.catch(() => Effect.succeed(null)))
    if (staged === null) {
      console.log("[aimy] compaction: staging failed, skipping")
      return { compacted: false, summarizedCount: 0, summaryChars: 0 }
    }
    const verifiedStaged = yield* verifyStaged(tree, staged).pipe(Effect.catch(() => Effect.succeed(null)))
    if (verifiedStaged === null) {
      console.log("[aimy] compaction: verification failed, skipping")
      return { compacted: false, summarizedCount: 0, summaryChars: 0 }
    }
    yield* memory.append(sessionId, {
      parentId: verifiedStaged.summaryInput.parentId,
      kind: "summary",
      payload: verifiedStaged.summaryInput.payload as unknown as Record<string, unknown>,
    } satisfies NewEntry).pipe(Effect.catch(() => Effect.succeed(undefined)))
    console.log(`[aimy] compaction: collapsed ${toCompact.length} messages into ${summaryText.length} chars`)
    return { compacted: true, summarizedCount: toCompact.length, summaryChars: summaryText.length }
  })

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
  /**
   * Background job registry (additive): when present, the `job.spawn` tool
   * can fork async work. Absent in hosts without background execution
   * (bare CLI harness). Threaded into BuiltinToolContext per turn.
   */
  readonly backgroundJobs?: BackgroundJobRegistry | undefined
  /**
   * Voice narration sink (additive): when present, the `narrate` tool
   * enqueues voice-only messages. Absent in hosts without voice.
   * Threaded into BuiltinToolContext per turn.
   */
  readonly narration?: NarrationSink | undefined
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
  maxToolRounds,
  backgroundJobs,
  narration
}: Deps): AgentLoopService => {
  const streamSource = makeStreamSource(streamProviders)

  // Auto-archive on session switch (2026-10-11): when the user starts a new
  // chat (different sessionId), the old thread is archived inline so its
  // summary lands in ~/.aimy/thread-history.json for prompt enrichment.
  // Fast local I/O only (no LLM); failures are caught inside (never=true).
  // Plain closure variable — session switches are sequential in practice.
  let lastSessionId: string | null = null
  let backfillDone = false
  /**
   * Boot backfill (2026-10-11): on first chat after app start, archive any
   * sessions with messages that aren't in thread-history.json. Covers the
   * restart gap — the in-memory lastSessionId is null, so session-switch
   * detection can't catch threads from the previous app run.
   */
  const backfillMissingArchives = (currentSessionId: string): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      if (backfillDone) return
      backfillDone = true
      try {
        const os = yield* Effect.promise(() => import("os"))
        const path = yield* Effect.promise(() => import("path"))
        const fs = yield* Effect.promise(() => import("fs"))
        const histPath = path.join(os.homedir(), ".aimy", "thread-history.json")
        let archivedIds = new Set<string>()
        try {
          if (fs.existsSync(histPath)) {
            const data = JSON.parse(fs.readFileSync(histPath, "utf-8"))
            if (Array.isArray(data)) {
              for (const h of data) {
                if (typeof h["sessionId"] === "string") archivedIds.add(h["sessionId"])
              }
            }
          }
        } catch { /* no history */ }
        const sessionIds = yield* memory.listSessions().pipe(
          Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>))
        )
        for (const sid of sessionIds) {
          if (sid === currentSessionId || archivedIds.has(sid)) continue
          // Quick check: does it have messages?
          const tree = yield* memory.read(sid).pipe(Effect.catch(() => Effect.succeed(null)))
          if (tree === null) continue
          const msgCount = tree.entries.filter((e) => e.kind === "message").length
          if (msgCount === 0) continue
          console.log(`[aimy] backfill: found unarchived session ${sid} (${msgCount} msgs)`)
          yield* archiveOldThread(sid)
        }
      } catch (e) {
        console.error(`[aimy] backfill failed (non-fatal): ${e instanceof Error ? e.message : e}`)
      }
    })
  const archiveOldThread = (oldSessionId: string): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      // Structural summary (2026-10-11): no LLM extraction yet — captures the
      // topic (first user message), message count, and key excerpts so the
      // thread is visible to prompt enrichment. Full meaning extraction
      // (via thread-archiver) is a follow-up once the trigger is proven.
      const tree = yield* memory.read(oldSessionId).pipe(
        Effect.catch(() => Effect.succeed(null))
      )
      if (tree === null) {
        console.log(`[aimy] auto-archive: cannot read ${oldSessionId}, skipping`)
        return
      }
      const messages = tree.entries
        .filter((e) => e.kind === "message")
        .map((e) => {
          const p = e.payload as { role?: string; text?: string }
          return {
            role: p.role === "assistant" ? ("assistant" as const) : ("user" as const),
            text: typeof p.text === "string" ? p.text : ""
          }
        })
        .filter((m) => m.text.trim().length > 0)
      if (messages.length === 0) {
        console.log(`[aimy] auto-archive: session ${oldSessionId} empty, skipping`)
        return
      }
      const firstUser = messages.find((m) => m.role === "user")
      const topic = firstUser ? firstUser.text.slice(0, 120) : "(no user messages)"
      // Key excerpts: first 3 user messages (the questions/topics).
      const userMessages = messages.filter((m) => m.role === "user").slice(0, 3)
      const excerpts = userMessages.map((m) => m.text.slice(0, 80)).join(" | ")
      const summary = `${topic}${excerpts ? ` — ${excerpts}` : ""}`
      console.log(`[aimy] auto-archive: ${messages.length} msgs from ${oldSessionId}: "${summary.slice(0, 60)}..."`)
      yield* Effect.tryPromise({
        try: async () => {
          const os = await import("os")
          const path = await import("path")
          const fs = await import("fs")
          const aimyDir = path.join(os.homedir(), ".aimy")
          const histPath = path.join(aimyDir, "thread-history.json")
          let history: Array<Record<string, unknown>> = []
          try {
            if (fs.existsSync(histPath)) {
              const data = JSON.parse(fs.readFileSync(histPath, "utf-8"))
              if (Array.isArray(data)) history = data
            }
          } catch { /* start fresh */ }
          // Replace existing entry for this session (don't duplicate).
          history = history.filter((h) => h["sessionId"] !== oldSessionId)
          history.push({
            sessionId: oldSessionId,
            summary,
            messageCount: messages.length,
            archivedAt: Date.now()
          })
          if (history.length > 50) history = history.slice(-50)
          fs.mkdirSync(aimyDir, { recursive: true })
          fs.writeFileSync(histPath, JSON.stringify(history, null, 2) + "\n")
        },
        catch: (e) => new Error(`auto-archive write failed: ${e instanceof Error ? e.message : e}`)
      }).pipe(
        Effect.catch((e) => Effect.sync(() => console.error(`[aimy] ${e.message} (non-fatal)`)))
      )
      console.log(`[aimy] auto-archive: done for ${oldSessionId}`)
    })

  const chat = (
    sessionId: string,
    input: string,
    images?: ReadonlyArray<{ dataUrl: string; mimeType: string; name: string }>
  ): Stream.Stream<ChatChunk, AgentLoopError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Interruption marker (2026-10-11): the renderer prepends
        // "[AIMY-INTERRUPTED]\n" when the user barged in mid-response.
        // Strip it here — it never reaches the model, the UI, or history.
        const INTERRUPTED_MARKER = "[AIMY-INTERRUPTED]\n"
        const wasInterrupted = input.startsWith(INTERRUPTED_MARKER)
        // Wake marker (2026-10-11): the main process runs a silent turn when
        // a new session starts and her journal has content. Strip it — it
        // never reaches the model. The turn persists like any other.
        const WAKE_MARKER = "[AIMY-WAKE]\n"
        const isWakeTurn = input.startsWith(WAKE_MARKER)
        const cleanInput = isWakeTurn
          ? input.slice(WAKE_MARKER.length)
          : wasInterrupted ? input.slice(INTERRUPTED_MARKER.length) : input
        if (wasInterrupted) console.log("[aimy] turn barged in on previous response")
        if (isWakeTurn) console.log("[aimy] wake turn: silent recollection before first user message")
        // 0a. Boot backfill: first chat after app start archives any sessions
        // missed by the restart gap.
        yield* backfillMissingArchives(sessionId)
        // 0b. Session switch: archive the old thread (fast local I/O, no LLM).
        // Runs inline — memory read + JSON write, milliseconds. Failures are
        // caught inside archiveOldThread (never=true), so this can't fail the turn.
        if (lastSessionId !== null && lastSessionId !== sessionId) {
          yield* archiveOldThread(lastSessionId)
        }
        lastSessionId = sessionId
        // 1. History + user message.
        const tree = yield* memory.read(sessionId)
        // Automatic hierarchical compaction: collapse oldest messages into
        // summaries when the session grows too large. Never blocks chat.
        const compaction = (yield* maybeCompactSession(memory, sessionId, tree).pipe(
          Effect.catch(() => Effect.succeed({ compacted: false, summarizedCount: 0, summaryChars: 0 } as CompactionResult)),
        )) as CompactionResult
        if (compaction.compacted) {
          console.log(`[aimy] compaction indicator: summarized ${compaction.summarizedCount} messages (${compaction.summaryChars} chars)`)
        }
        const liveTree = compaction.compacted ? yield* memory.read(sessionId) : tree
        const history = historyMessages(liveTree.entries)
        const parentId =
          liveTree.entries.length > 0 ? liveTree.entries[liveTree.entries.length - 1]!.id : null
        const userEntry = yield* memory.append(sessionId, {
          parentId,
          kind: "message",
          payload: {
            role: "user",
            text: cleanInput,
            // Mark wake turns so historyMessages filters the exchange out.
            // The wake is internal; it must not pollute the model's context.
            ...(isWakeTurn ? { wake: true } : {}),
            ...(images !== undefined && images.length > 0
              ? { images: images.map((i) => ({ name: i.name, mimeType: i.mimeType })) }
              : {}),
          }
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
              input: cleanInput,
              proxyOverrides: ascOpts?.proxyOverrides
            })
          : undefined
        // Set once the finishTurn audit has run; the abort finalizer below
        // consults it so the audit runs exactly once per turn.
        const auditDoneRef = yield* Ref.make(false)

        const systemPrompt = buildSystemPrompt(extraTools)
        // Enrichment (2026-10-10): thread history, ASC mood, curiosities from ~/.aimy/.
        // Best-effort: if no data, enrichment is empty and base prompt stands.
        let enrichment = ""
        try {
          const { buildEnrichmentBlock } = yield* Effect.promise(() => import("./prompt-enrichment.js"))
          const os = yield* Effect.promise(() => import("os"))
          const path = yield* Effect.promise(() => import("path"))
          const fs = yield* Effect.promise(() => import("fs"))
          const aimyDir = path.join(os.homedir(), ".aimy")
          // Thread history from ~/.aimy/thread-history.json
          let threadHistory: Array<{ sessionId: string; summary: string; messageCount: number; archivedAt: number }> = []
          try {
            const histPath = path.join(aimyDir, "thread-history.json")
            if (fs.existsSync(histPath)) {
              const data = JSON.parse(fs.readFileSync(histPath, "utf-8"))
              if (Array.isArray(data)) threadHistory = data
            }
          } catch { /* no history yet */ }
          // Dials: neutral defaults (ASC engine integration post-demo)
          const dials = { warmth: 5, playfulness: 5, intensity: 5, vulnerability: 5 }
          enrichment = buildEnrichmentBlock({ dials, threadHistory })
          if (enrichment) console.log(`[aimy] prompt enrichment: ${threadHistory.length} threads, ${enrichment.length} chars`)
        } catch (e) {
          console.log(`[aimy] prompt enrichment skipped: ${e instanceof Error ? e.message : e}`)
        }
        // Journal (2026-10-11): her own persistent identity space. She alone
        // writes it via the journal.write tool; the system never touches the
        // file. Injected every turn so she reads herself and knows what to
        // carry forward. Merged into the system prompt content — never a
        // separate system message (Jinja requires system at position 0 only).
        let journalSection = ""
        try {
          const jos = yield* Effect.promise(() => import("os"))
          const jpath = yield* Effect.promise(() => import("path"))
          const jfs = yield* Effect.promise(() => import("fs"))
          const journalFile = jpath.join(jos.homedir(), ".aimy", "journal.md")
          if (jfs.existsSync(journalFile)) {
            const journal = jfs.readFileSync(journalFile, "utf-8").trim()
            if (journal !== "") {
              journalSection =
                `\n\n[Your journal — written by you, in your words. This is your identity space; no one else writes here. ` +
                `Read it at the start of every session to remember who you are:\n${journal}]`
              console.log(`[aimy] journal injected: ${journal.length} chars`)
            }
          }
        } catch {
          // No journal yet — she'll write the first entry when she's ready.
        }
        // Voice moments (2026-10-11): things the model said aloud via narrate
        // in this session. Merged into the system prompt content — NOT as a
        // separate system message (Jinja requires system at position 0 only).
        const voiceMoments = extractVoiceMoments(liveTree.entries)
        const voiceSection = voiceMoments.length > 0
          ? `\n\n[Voice history — things you said aloud earlier in this session. The user heard these; remember them as shared moments: ${voiceMoments.map((t) => `"${t}"`).join("; ")}]`
          : ""
        // Interruption context (2026-10-11): the user barged in mid-response.
        // Tell the model what it didn't get to finish so it can weave the
        // unfinished thought into its reply instead of dropping it. Merged
        // into the system prompt content — never a separate system message
        // (Jinja requires system at position 0 only).
        let interruptionSection = ""
        if (wasInterrupted) {
          const lastAssistant = [...liveTree.entries]
            .reverse()
            .find((e) => e.kind === "message" && (e.payload as { role?: string }).role === "assistant")
          const unfinished = (((lastAssistant?.payload as { text?: string } | undefined)?.text ?? "") as string)
            .trim()
            .slice(0, 600)
          const wasSaying = unfinished !== ""
            ? ` What you were saying when they cut in: "${unfinished}${unfinished.length >= 600 ? "…" : ""}".`
            : ""
          interruptionSection =
            `\n\n[The user just interrupted you — read it as engagement, not rudeness. They're leaning in.${wasSaying}` +
            ` First, figure out what kind of interruption this is: clarification ("wait, what do you mean by…?"),` +
            ` steering ("no, focus on X"), a topic change ("anyway…"), or a rethink of the premise ("what if the opposite…?").` +
            ` Don't bulldoze through your planned response as if nothing happened — and don't just answer the new` +
            ` message in isolation either. Reconsider your position from both: where you were + what they just gave you.` +
            ` If the interruption changed the premise, let your unfinished thought go gracefully and say your view` +
            ` updated — that's honesty, not failure.]`
        }
        const fullSystemPrompt = `${systemPrompt}${journalSection}${voiceSection}${interruptionSection}${enrichment ? `\n\n${enrichment}` : ""}`
        // Truncate history to fit context: 64K total, reserve 4K for system
        // prompt, 4K for input+response, leaving ~56K for history. Conservative.
        // Without this, long sessions silently return empty (model chokes).
        const MAX_HISTORY_TOKENS = 56000
        const { messages: truncatedHistory, truncated, dropped } = truncateHistory(history, MAX_HISTORY_TOKENS)
        if (truncated) {
          console.log(`[aimy] history truncated: dropped ${dropped} oldest messages ` +
            `(${history.length} → ${truncatedHistory.length}) to fit context`)
        }

        // User message: multimodal when images are attached (2026-10-11).
        const userMessage: Message = images !== undefined && images.length > 0
          ? {
              role: "user",
              content: [
                { type: "text", text: cleanInput },
                ...images.map((img) => ({
                  type: "image_url" as const,
                  image_url: { url: img.dataUrl },
                })),
              ],
            }
          : { role: "user", content: cleanInput }
        if (images !== undefined && images.length > 0) {
          console.log(`[aimy] turn with ${images.length} image(s): ${images.map((i) => i.name).join(", ")}`)
        }
        const request: GenerateRequest = {
          messages: [
            { role: "system", content: fullSystemPrompt },
            ...truncatedHistory,
            userMessage,
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
            // ASC narrate hooks (2026-10-11): the voice channel is observed.
            // Pre-narrate analyzes the input; post-narrate accumulates what
            // was spoken so the post-turn audit sees voice output, not just
            // chat text. Hooks never block speech.
            const narratedTextsRef = yield* Ref.make<ReadonlyArray<string>>([])
            const narrateCallCountRef = yield* Ref.make(0)
            // Hooks are wired whenever voice is available (narration sink
            // present), not just when ASC is — the call count drives the
            // silence detector, and the ASC analysis is cheap. (2026-10-11)
            const ascNarrateHooks: NarrateAscHooks | undefined = narration !== undefined
              ? {
                  preNarrate: (text) =>
                    Effect.gen(function* () {
                      yield* Ref.update(narrateCallCountRef, (n) => n + 1)
                      const analysis = analyzeContent(text)
                      console.log(`[aimy] ASC pre-narrate: domain=${analysis.domain}, urgency=${analysis.urgency.toFixed(2)}`)
                    }),
                  postNarrate: (text, result) =>
                    Effect.gen(function* () {
                      if (result.narrated) {
                        yield* Ref.update(narratedTextsRef, (arr) => [...arr, text])
                        console.log(`[aimy] ASC post-narrate: captured ${text.length} chars (id=${result.narrationId})`)
                      }
                    })
                }
              : undefined
            const toolCtx: BuiltinToolContext = {
              sessionId,
              turnCount,
              turnId,
              ...(backgroundJobs !== undefined ? { backgroundJobs } : {}),
              ...(narration !== undefined ? { narration } : {}),
              ...(ascNarrateHooks !== undefined ? { ascNarrate: ascNarrateHooks } : {})
            }
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
            // Once-per-turn narrate guard (2026-10-11): the model sometimes
            // emits multiple narrate calls per turn (incl. across follow-up
            // rounds); only the first is voiced, the rest are dropped.
            let narrateFired = false
            for (;;) {
              // Persist this round's assistant text first, so the session
              // tree reads in the order the user experienced it.
              yield* appendEntry({
                parentId: parent,
                kind: "message",
                payload: { role: "assistant", text }
              })

              const { calls: rawCalls, failures } = parseToolBlocks(text)
              parseFailures.push(...failures)
              // Enforce once-per-turn narrate: keep the first, drop the rest.
              // Wake turns (2026-10-11): drop ALL narrate — the wake is
              // silent. Draining tokens doesn't stop tool execution, so the
              // wake was voicing its introspection on every reboot.
              const calls = rawCalls.filter((c) => {
                if (c.tool !== "narrate") return true
                if (isWakeTurn) {
                  console.log(`[aimy] voice: dropping narrate in wake turn ${turnId} (silent wake)`)
                  return false
                }
                if (narrateFired) {
                  console.log(`[aimy] voice: dropping duplicate narrate in turn ${turnId} (once-per-turn)`)
                  return false
                }
                narrateFired = true
                return true
              })
              if (calls.length === 0 || terminated || round >= maxToolRounds) break

              const spec: TurnSpec = {
                turn: { turnId, module: MODULE },
                contextMessages: conversation.map((m) => ({
                  role: m.role,
                  // TurnSpec is text-only (tool context); multimodal content
                  // becomes a placeholder. The model sees the full parts.
                  content: typeof m.content === "string"
                    ? m.content
                    : m.content.map((p) => p.type === "text" ? p.text : "[image]").join(" "),
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
                    `Tool results for your last message. CONTINUE your response from where you left off — do NOT restart, ` +
                    `do NOT repeat, and do NOT re-deliver anything you've already said (no second copy of a list, no restated points). ` +
                    `Incorporate these results naturally into the flow. Do not re-call a tool that already returned, ` +
                    `and do not claim you lack a capability these results prove you have:\n${resultLines.join("\n")}`
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
              // The audit sees what the user experienced: chat text plus
              // anything spoken via narrate (the voice channel). Without
              // this, ASC is blind to the relational layer (2026-10-11).
              const narratedTexts = yield* Ref.get(narratedTextsRef)
              const auditOutputText = narratedTexts.length > 0
                ? `${text}\n\n[Voice — spoken aloud via narrate:\n${narratedTexts.map((t) => `- ${t}`).join("\n")}]`
                : text
              ascReport = yield* runPostTurnAsc(asc.value, {
                pre: ascCtx.pre,
                analysis: ascCtx.analysis,
                turn: turnNumber,
                outputText: auditOutputText
              })
              yield* Ref.set(auditDoneRef, true)
              // TODO (2026-10-11): Write live dials to ~/.aimy/personality.json
              // for the presence tab dashboard. Reverted: dynamic imports
              // broke module loading at boot. Needs static imports instead.
            }
            // Voice silence detection (2026-10-11): if the narration sink was
            // available but the model never called narrate, the user heard
            // nothing this turn. Log it so we can tune the voice bias.
            if (narration !== undefined) {
              const narrateCalls = yield* Ref.get(narrateCallCountRef)
              if (narrateCalls === 0) {
                console.log(`[aimy] voice: turn ${turnNumber} completed with no narration — user heard silence`)
              }
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
  readonly backgroundJobs?: BackgroundJobRegistry | undefined
  readonly narration?: NarrationSink | undefined
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
        maxToolRounds: opts?.maxToolRounds ?? 3,
        backgroundJobs: opts?.backgroundJobs,
        narration: opts?.narration
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
  readonly backgroundJobs?: BackgroundJobRegistry | undefined
  readonly narration?: NarrationSink | undefined
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
        maxToolRounds: opts?.maxToolRounds ?? 3,
        backgroundJobs: opts?.backgroundJobs,
        narration: opts?.narration
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
