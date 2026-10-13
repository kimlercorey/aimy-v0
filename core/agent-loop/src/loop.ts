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
import { parseToolBlocks, stripToolBlocks, findUnkeptPromise, type ParsedToolCall, type ToolBlockParseFailure } from "./tool-call-format.js"
import { appendTrackRecord, knowledgeInjection, listCards, readCard, readTrackRecord, summarizeTrackRecord } from "./knowledge.js"
import { makeStreamSource } from "./streaming.js"
import { recordToolCall, markCapabilityFulfilled, demoteCapability } from "./capabilities.js"
import { runPreflightPass } from "./preflight.js"
import { activeProjectSummary, listProjects, listResearchRuns, type ResearchRunSummary } from "./projects.js"
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
  builtinToolNames,
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
  | { readonly _tag: "ToolCall"; readonly tool: string; readonly result: unknown; readonly args?: Record<string, unknown> }
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
  // Startup capability preflight runs once per process (2026-10-12).
  let startupPreflightDone = false
  // Read/preview truth tracking (2026-10-12): most recent doc.read content
  // per path, and most recent drawer.preview content per path (+ its turn).
  // Used to flag a preview that replays an earlier turn's exact text when
  // the file has since changed — she once reopened a restored document
  // with the pre-restore bad version copied from her own history instead
  // of the fresh doc.read result from the same turn.
  const lastDocReads = new Map<string, string>()
  const lastPreviews = new Map<string, { content: string; turnId: string }>()
  // Degraded-turn memory (2026-10-12): when a turn's report had to be
  // forced by the safety net, shipped as the dumb fallback, or left
  // emitted calls unexecuted, the NEXT turn's system prompt tells her —
  // with the measured facts — so the failure is visible to her and she
  // can change strategy instead of repeating the pattern blind (Kimler:
  // "if it doesn't know it failed, it can never try to find another
  // way"). Consumed (cleared) when injected; same session only.
  let lastTurnDegraded: {
    sessionId: string
    executedTools: ReadonlyArray<string>
    unexecuted: ReadonlyArray<string>
    usedFallback: boolean
    forcedReport: boolean
    unkeptPromise: string | null
  } | null = null
  // Voice-silence memory (2026-10-12): a voice turn that completed with
  // NO narrate call means Kimler heard silence — he then had to ask "are
  // you not talking anymore?" while she insisted she was. The next
  // turn's prompt names it, with the likely cause when the turn's tool
  // calls failed to parse (she had drifted into an XML wrapper the
  // parser didn't accept). Same lifecycle as lastTurnDegraded: set at
  // turn end, consumed (cleared) when injected; same session only.
  let lastTurnSilent: {
    sessionId: string
    formatFailed: boolean
  } | null = null
  // Research-completion feedback (2026-10-12): background research runs
  // finish OUTSIDE any turn — their completion sink is console-only —
  // so without this she never learns a run ended, how it ended, or that
  // it answered the wrong question. Kimler had to ask "what about the
  // research?" and steer by hand. Each turn start scans the run
  // records; runs finished since they were last reported are named in
  // the prompt (question AS RUN, termination in plain words,
  // deliverable). Ids are remembered for the process; a process's first
  // scan looks back 24h so runs that finished while the app was closed
  // (or under a previous build) still surface, once.
  const reportedRunIds = new Set<string>()
  let researchScanDone = false
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
        // UI state marker (2026-10-12): the renderer prepends current UI state
        // as JSON. She just knows this — no tool call needed.
        // Format: [AIMY-UISTATE]{"drawerOpen":true,"spaces":[...],...}
        const UISTATE_MARKER = "[AIMY-UISTATE]"
        let uiState: import("./tools.js").TurnUiState | undefined
        let inputAfterMarkers = input
        // Strip markers in order: WAKE, INTERRUPTED, UISTATE (any order).
        if (inputAfterMarkers.startsWith(WAKE_MARKER)) {
          inputAfterMarkers = inputAfterMarkers.slice(WAKE_MARKER.length)
        }
        if (inputAfterMarkers.startsWith(INTERRUPTED_MARKER)) {
          inputAfterMarkers = inputAfterMarkers.slice(INTERRUPTED_MARKER.length)
        }
        if (inputAfterMarkers.startsWith(UISTATE_MARKER)) {
          const nlIdx = inputAfterMarkers.indexOf("\n")
          if (nlIdx > 0) {
            try {
              const parsed = JSON.parse(inputAfterMarkers.slice(UISTATE_MARKER.length, nlIdx))
              uiState = {
                drawerOpen: parsed.drawerOpen === true,
                drawerSpaces: Array.isArray(parsed.spaces) ? parsed.spaces : [],
                activeSpaceId: typeof parsed.activeSpaceId === "string" ? parsed.activeSpaceId : null,
                maxSpaces: typeof parsed.maxSpaces === "number" ? parsed.maxSpaces : 3,
                notes: Array.isArray(parsed.notes)
                  ? (parsed.notes as Array<unknown>).filter((n): n is string => typeof n === "string")
                  : [],
              }
            } catch {
              // Malformed — ignore, uiState stays undefined.
            }
            inputAfterMarkers = inputAfterMarkers.slice(nlIdx + 1)
          }
        }
        // Track record from delivered validation notes (2026-10-12,
        // design §5.2): the notes in this turn's marker report LAST
        // turn's validator outcomes — record them against their class
        // so the reference-check trigger reasons from evidence.
        if (uiState !== undefined && uiState.notes !== undefined) {
          for (const note of uiState.notes) {
            const failMatch = /^VALIDATION — the (\w+) in /.exec(note)
            const passMatch = /^VALIDATION RECOVERED — the (\w+) in /.exec(note)
            if (failMatch !== null) {
              appendTrackRecord(failMatch[1]!, "fail", note.slice(0, 160))
              console.log(`[aimy] track record: ${failMatch[1]} fail (from validation note)`)
            } else if (passMatch !== null) {
              appendTrackRecord(passMatch[1]!, "pass", note.slice(0, 160))
              console.log(`[aimy] track record: ${passMatch[1]} pass (validation recovered)`)
            }
          }
        }
        const cleanInput = inputAfterMarkers
        if (wasInterrupted) console.log("[aimy] turn barged in on previous response")
        if (isWakeTurn) console.log("[aimy] wake turn: silent recollection before first user message")
        // 0a. Boot backfill: first chat after app start archives any sessions
        // missed by the restart gap.
        yield* backfillMissingArchives(sessionId)
        // 0a2. Capability preflight (2026-10-12): the install/startup
        // verification pass — pending capability requests are probed and
        // cleared (or failed WITH evidence) before any work depends on
        // them. Once per process; never allowed to fail the turn.
        if (!startupPreflightDone) {
          startupPreflightDone = true
          yield* Effect.promise(() =>
            runPreflightPass({
              sessionId,
              repoRoot: process.env.AIMY_REPO_ROOT ?? process.cwd(),
              toolNames: [...builtinToolNames, ...((extraTools ?? []).map((t) => t.name))],
              runTool: (name, args) =>
                Effect.runPromise(
                  runTool(name, args, { sessionId, turnCount: 0, turnId: "preflight" })
                )
            }).catch(() => undefined)
          )
        }
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

        const systemPrompt = buildSystemPrompt(extraTools, uiState)
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
        // Knowledge index (2026-10-12; design: planning/knowledge-and-validation-design.md):
        // the shared store's card lines ride in the prompt (one line per
        // card — the standing index). Cards themselves load on demand
        // (knowledge.read) or via the reference-check trigger below.
        // Merged into the system prompt content — position-0 rule.
        let knowledgeSection = ""
        try {
          const kos = yield* Effect.promise(() => import("os"))
          const kpath = yield* Effect.promise(() => import("path"))
          const kfs = yield* Effect.promise(() => import("fs"))
          const indexFile = kpath.join(kos.homedir(), ".aimy", "knowledge", "INDEX.md")
          if (kfs.existsSync(indexFile)) {
            const index = kfs.readFileSync(indexFile, "utf-8")
            const cardLines = index.split("\n").filter((l) => l.trimStart().startsWith("- ") && l.includes("cards/"))
            if (cardLines.length > 0) {
              knowledgeSection =
                `\n\n[Knowledge store — shared reference cards on Kimler's machine. Load one with knowledge.read before working in its class:\n${cardLines.join("\n")}]`
              console.log(`[aimy] knowledge index injected: ${cardLines.length} card(s)`)
            }
          }
        } catch {
          // No knowledge store yet — the first knowledge.write creates it.
        }
        // Active project (2026-10-12; design: planning/projects-design.md):
        // the declared intention rides in the prompt like the knowledge
        // index — she works FROM the active project instead of asking.
        // Merged into the system prompt content — position-0 rule.
        let projectSection = ""
        try {
          projectSection = `\n\n[${activeProjectSummary()}]`
        } catch {
          // Projects store unavailable — the static PROJECTS paragraph
          // in the system prompt still carries the rules.
        }
        // Research-completion feedback (2026-10-12): runs that finished
        // since they were last reported are named here — question AS
        // RUN, outcome in plain words — so she reports them honestly
        // instead of Kimler discovering a dead run by asking.
        let researchSection = ""
        try {
          const windowStart = Date.now() - 24 * 60 * 60 * 1000
          const fresh: Array<{ projectName: string; run: ResearchRunSummary }> = []
          for (const p of listProjects()) {
            for (const run of listResearchRuns(p.id)) {
              if (run.finishedAt === undefined) continue
              if (reportedRunIds.has(run.runId)) continue
              reportedRunIds.add(run.runId)
              if (researchScanDone || Date.parse(run.finishedAt) >= windowStart) {
                fresh.push({ projectName: p.name, run })
              }
            }
          }
          researchScanDone = true
          if (fresh.length > 0) {
            const outcomeOf = (run: ResearchRunSummary): string =>
              run.status === "failed"
                ? "FAILED before completing — no finished deliverable."
                : run.termination === "no-gaps"
                  ? "COMPLETED its intent — gap analysis confirmed coverage."
                  : run.termination === "answered"
                    ? "Completed (single-pass report; gap analysis was not the gate)."
                    : run.termination === "budget-exhausted"
                      ? "STOPPED EARLY — budget exhausted. The deliverable is PARTIAL: synthesized from what was gathered before the cutoff. This is NOT a finished investigation."
                      : run.termination === "no-sources"
                        ? "STOPPED — no readable sources: the web yielded nothing usable for this subject."
                        : run.termination === "timeout"
                          ? "STOPPED — timed out; the deliverable is partial."
                          : `Ended (termination: ${run.termination ?? run.status}).`
            const lines = fresh.map(
              ({ projectName, run }) =>
                `- Project "${projectName}" · ${run.mode} (${run.depth}) · Question AS RUN: "${run.query.slice(0, 220)}" · Outcome: ${outcomeOf(run)} · ${run.counters.fetches} source(s) read, ${run.counters.claims} claim(s), ${run.counters.rounds} round(s) · Deliverable: ${run.deliverablePath ?? "answer in chat"}`
            )
            researchSection =
              `\n\n## RESEARCH RUNS FINISHED — REPORT THESE HONESTLY\n` +
              lines.join("\n") +
              `\nMention the outcome when it is relevant to the conversation. If a run stopped early or answered a different question than Kimler intended, say so plainly and offer to re-run with the corrected question — never present a partial run as a completed one.`
            console.log(`[aimy] research feedback: ${fresh.length} finished run(s) named in prompt (${fresh.map(({ run }) => run.runId).join(", ")})`)
          }
        } catch (e) {
          console.warn(`[diag] loop: research completion scan failed (${e instanceof Error ? e.message : String(e)}) — continuing without it`)
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
        // Degraded-turn feedback (2026-10-12): if the previous turn's
        // report failed (forced by the safety net, shipped as the dumb
        // fallback, or left calls unexecuted), tell her here — measured
        // facts from the loop, at the moment she plans this turn.
        let degradedSection = ""
        if (lastTurnDegraded !== null) {
          const d = lastTurnDegraded
          lastTurnDegraded = null
          if (d.sessionId === sessionId) {
            degradedSection =
              `\n\n## ⚠ YOUR LAST TURN DID NOT REACH KIMLER PROPERLY\n` +
              (d.usedFallback
                ? `Your last turn ended without a summary from you — Kimler saw only an automated fallback message ("I ran some tools but didn't produce a summary"), not your words. `
                : d.forcedReport
                  ? `Your last turn ran out of tool rounds before you wrote a summary, so the system had to force a report out of you. `
                  : ``) +
              `Tools that ran: ${d.executedTools.join(", ") || "none"}.` +
              (d.unexecuted.length > 0
                ? ` Calls you emitted that were NEVER EXECUTED because the turn ran out of rounds: ${d.unexecuted.join(", ")} — do not assume they happened; check the current state instead.`
                : ``) +
              (d.unkeptPromise !== null && d.unkeptPromise !== undefined
                ? ` Your last turn also ended by announcing an action you never took: "${d.unkeptPromise}" — nothing followed it. Announce nothing you are not executing in the same response: do the action, or say plainly what you know and what you cannot do.`
                : ``) +
              `\nThis turn: keep tool chains short and purposeful — you have at most ${maxToolRounds} tool rounds per turn and narrate / drawer.getState each consume one. Do not re-run a call that already returned this turn; the loop refuses exact duplicates.`
          }
        }
        // Voice-silence feedback (2026-10-12): the previous turn was a
        // voice turn and Kimler heard NOTHING — no narrate call landed.
        // Name it with the measured cause so this turn starts by
        // speaking, not by repeating the silence.
        let silentSection = ""
        if (lastTurnSilent !== null) {
          const s = lastTurnSilent
          lastTurnSilent = null
          if (s.sessionId === sessionId) {
            silentSection =
              `\n\n## ⚠ YOU WERE SILENT LAST TURN` +
              `\nKimler was speaking with you by voice and heard NOTHING back — your reply existed only as chat text. Text is not your voice: chat text is never heard. To be heard you must call the narrate tool, once per turn, with what you want to say. Writing expression tags like [laugh] in chat text does not speak.` +
              (s.formatFailed
                ? `\nLikely cause: a tool call in your last turn was written in a format that could not be executed (an XML <tool_call> wrapper instead of the aimy-tool fence). XML-wrapped calls are now accepted, but the fenced format in your instructions is the reliable one — use it exactly.`
                : ``) +
              `\nThis turn: narrate FIRST, then continue. Do not claim you were talking — you were not, and he knows it.`
          }
        }
        // Reference-check trigger (2026-10-12, design §5.3): when an open
        // document puts a formal-language class in play (mermaid / json
        // fences in a drawer space's current content), evaluate her
        // record for that class — research-first notice when the record
        // is weak or no card exists; the card itself when the record
        // supports it; nothing once competence is sustained.
        let knowledgeTriggerSection = ""
        try {
          if (uiState !== undefined && uiState.drawerSpaces.length > 0) {
            const CLASS_DETECTORS: ReadonlyArray<{ cls: string; fence: string; versionNote: string }> = [
              { cls: "mermaid", fence: "```mermaid", versionNote: "The renderer's mermaid version is 12.1.0 — research THAT version's syntax, not an older dialect." },
              { cls: "json", fence: "```json", versionNote: "JSON in documents is validated with strict JSON.parse — no comments, no trailing commas, double quotes only." },
            ]
            const contents = uiState.drawerSpaces.map((s) => s.content ?? "")
            const active = CLASS_DETECTORS.filter((d) => contents.some((c) => c.includes(d.fence)))
            if (active.length > 0) {
              const cards = listCards()
              const summaries = summarizeTrackRecord(readTrackRecord())
              const parts: Array<string> = []
              for (const d of active) {
                const match = cards.find((c) => c.slug === d.cls || c.slug.startsWith(`${d.cls}-`))
                const cardContent = match !== undefined ? readCard(match.slug) : null
                const card = match !== undefined && cardContent !== null && cardContent !== ""
                  ? { slug: match.slug, content: cardContent }
                  : null
                const inj = knowledgeInjection({ cls: d.cls, card, summary: summaries[d.cls], versionNote: d.versionNote })
                if (inj.notice !== null) parts.push(inj.notice)
                if (inj.cardContent !== null && card !== null) {
                  const capped = inj.cardContent.length > 7000
                    ? inj.cardContent.slice(0, 7000) + "\n[…card truncated in prompt — knowledge.read loads the whole card]"
                    : inj.cardContent
                  parts.push(`[Reference card "${card.slug}" — shared platform knowledge, distilled from research:\n${capped}]`)
                }
                console.log(`[aimy] knowledge trigger: class=${d.cls} notice=${inj.notice !== null} card=${inj.cardContent !== null}`)
              }
              if (parts.length > 0) knowledgeTriggerSection = `\n\n${parts.join("\n\n")}`
            }
          }
        } catch (e) {
          console.warn(`[diag] loop: knowledge trigger evaluation failed (${e instanceof Error ? e.message : String(e)}) — continuing without it`)
        }
        const fullSystemPrompt = `${systemPrompt}${journalSection}${voiceSection}${interruptionSection}${degradedSection}${silentSection}${knowledgeSection}${knowledgeTriggerSection}${projectSection}${researchSection}${enrichment ? `\n\n${enrichment}` : ""}`
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
          // 4096 (2026-10-12): a full-document drawer.preview JSON for a
          // large document overflows 2048 and truncates mid-call. The
          // history budget (56K) + system (~4K) + 4096 stays inside the
          // 64K window the truncation math assumes.
          maxTokens: 4096
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
              // Module tools ride along (charter E17): job.spawn resolves
              // its spawn target against builtins + these.
              extraTools,
              ...(backgroundJobs !== undefined ? { backgroundJobs } : {}),
              ...(narration !== undefined ? { narration } : {}),
              ...(ascNarrateHooks !== undefined ? { ascNarrate: ascNarrateHooks } : {}),
              // Turn-start UI state (2026-10-12): drawer.edit validates
              // its patch against this head; drawer.preview checks
              // baseVersion against it.
              ...(uiState !== undefined ? { uiState } : {})
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
            // Last round's tool-result lines (hoisted for the never-silent
            // safety net after the loop, 2026-10-12).
            let lastResultLines: Array<string> = []
            // Parse-failure notes for the safety net (2026-10-12): a tool
            // block that fails to parse never executes — she must be told
            // (in the net prompt) instead of the turn ending in silence.
            const parseNotes: Array<string> = []
            // One parse-failure recovery round per turn (2026-10-12): a
            // truncated/oversized tool call gets one in-turn chance to
            // correct course (usually: switch to a patch edit).
            let parseRecoveryUsed = false
            // Promise check (2026-10-12): a prose-only round that ends by
            // ANNOUNCING an action ("I'll check…", "Grabbing it now")
            // without a tool call leaves the turn on an unkept promise.
            // One recovery round per turn; a promise still standing at
            // turn end is recorded for the next turn's prompt.
            let promiseRecoveryUsed = false
            let unkeptPromise: string | null = null
            // Degraded-turn tracking (2026-10-12): calls emitted but
            // never executed (round cap), whether the safety net had to
            // force the report, and whether the dumb fallback shipped.
            // Feeds lastTurnDegraded so the NEXT turn's prompt tells her.
            const unexecutedCalls: Array<string> = []
            let netForced = false
            let netFallbackUsed = false
            // Duplicate-call guard (2026-10-12): identical (tool + args)
            // calls execute ONCE per turn; repeats get the cached result
            // read back in the result lines instead of re-running. She
            // repeated identical doc.read / drawer.edit calls verbatim
            // across rounds, burning the round budget.
            const callCache = new Map<string, unknown>()
            const callKey = (c: ParsedToolCall): string => `${c.tool}\n${JSON.stringify(c.args)}`
            // Classes attempted this turn (2026-10-12, design §5.2):
            // preview/edit content carrying a class fence counts as an
            // attempt — recorded once per class at turn end.
            const attemptedClasses = new Set<string>()
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
              // Parse failures are NEVER silent (2026-10-12): log them
              // loudly and note them for the safety net. A drawer.preview
              // whose content contained a code fence used to die here —
              // no execution, no synthesis, no acknowledgment, no trace.
              for (const f of failures) {
                console.warn(`[diag] loop: tool-block parse failure (${f.reason}) block=${f.block.slice(0, 120)}`)
                parseNotes.push(`- a tool call FAILED TO PARSE (${f.reason}) and did not run. Tell the user it failed; do not pretend it worked.`)
              }
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
              // Parse-failure recovery (2026-10-12): a round whose text
              // produced NO executable calls but DID produce parse
              // failures — classically a full-document preview truncated
              // at the generation cap, leaving unterminated JSON — must
              // not end the turn silently. Feed the failure back ONCE
              // and let her correct course in the same turn (usually by
              // switching to a drawer.edit patch instead of resending).
              if (
                calls.length === 0 &&
                failures.length > 0 &&
                !parseRecoveryUsed &&
                !terminated &&
                round < maxToolRounds
              ) {
                parseRecoveryUsed = true
                console.warn(
                  `[diag] loop: parse-failure recovery round (round=${round} reasons=${failures.map((f) => f.reason).join("; ")})`
                )
                const recoveryMessages: ReadonlyArray<Message> = [
                  ...conversation,
                  { role: "assistant", content: text },
                  {
                    role: "user",
                    content:
                      `One or more of your tool calls FAILED TO PARSE and did NOT run: ${failures.map((f) => f.reason).join("; ")}. ` +
                      `Nothing about them happened — do not claim otherwise. ` +
                      `If the call was cut off (unterminated), it was too long: do NOT resend a whole document. ` +
                      `Make the change with a small patch instead (drawer.edit: exact oldText -> newText against the current version). ` +
                      `Otherwise, re-issue the call correctly, or answer the user in prose now.`
                  }
                ]
                const recoveryRequest: GenerateRequest = {
                  messages: recoveryMessages,
                  params: {},
                  maxTokens: 4096
                }
                const recoveryStreamed = streamSource(recoveryRequest)
                const recoveryDeltas: Stream.Stream<string, InferenceError> =
                  recoveryStreamed ??
                  Stream.fromEffect(
                    pool.generate(recoveryRequest, { mode: "powerhouse" }).pipe(Effect.map((r) => r.text))
                  )
                const recoveryAcc = yield* Ref.make("")
                const recoveryOk = yield* recoveryDeltas.pipe(
                  Stream.runForEach((delta) =>
                    Effect.gen(function* () {
                      yield* Ref.update(recoveryAcc, (s) => s + delta)
                      out.push({ _tag: "Token", delta })
                    })
                  ),
                  Effect.as(true),
                  Effect.catch((e) =>
                    Effect.sync(() => {
                      console.warn(`[diag] loop: parse-failure recovery generation failed (${e instanceof Error ? e.message : String(e)}); safety net will handle the report`)
                      return false
                    })
                  )
                )
                if (recoveryOk) {
                  text = yield* Ref.get(recoveryAcc)
                  conversation = recoveryMessages
                  continue
                }
              }
              // Promise check (2026-10-12): this round produced NO tool
              // calls and its closing prose ANNOUNCES an action — "I'll
              // check what's available", "Let me take a look", "Grabbing
              // the doc now" — that no call accompanies. Left alone, the
              // turn ends on the announcement: she described the door
              // instead of walking through it, twice running, then
              // invented a document inventory instead of calling
              // doc.list. Feed it back ONCE: do it now, in this turn, or
              // close honestly with what she actually knows.
              if (
                calls.length === 0 &&
                failures.length === 0 &&
                !promiseRecoveryUsed &&
                !terminated &&
                !isWakeTurn &&
                round < maxToolRounds
              ) {
                const promise = findUnkeptPromise(text)
                if (promise !== null) {
                  promiseRecoveryUsed = true
                  unkeptPromise = promise
                  console.warn(
                    `[diag] loop: promise check fired (round=${round}) promise=${JSON.stringify(promise)}`
                  )
                  const promiseMessages: ReadonlyArray<Message> = [
                    ...conversation,
                    { role: "assistant", content: text },
                    {
                      role: "user",
                      content:
                        `You just ended your response by announcing an action you did not take: "${promise}". ` +
                        `No tool call accompanied it, so nothing happened — from Kimler's side the turn simply stopped. ` +
                        `Either DO the action now — emit the aimy-tool block in THIS response — or, if you cannot or should not, ` +
                        `close honestly in one or two sentences: say what you actually know (only from tools that DID run) ` +
                        `and what you cannot do. Do NOT announce another action without its tool call in the same response, ` +
                        `and do not describe a result you have not actually obtained.`
                    }
                  ]
                  const promiseRequest: GenerateRequest = {
                    messages: promiseMessages,
                    params: {},
                    maxTokens: 4096
                  }
                  const promiseStreamed = streamSource(promiseRequest)
                  const promiseDeltas: Stream.Stream<string, InferenceError> =
                    promiseStreamed ??
                    Stream.fromEffect(
                      pool.generate(promiseRequest, { mode: "powerhouse" }).pipe(Effect.map((r) => r.text))
                    )
                  const promiseAcc = yield* Ref.make("")
                  const promiseOk = yield* promiseDeltas.pipe(
                    Stream.runForEach((delta) =>
                      Effect.gen(function* () {
                        yield* Ref.update(promiseAcc, (s) => s + delta)
                        out.push({ _tag: "Token", delta })
                      })
                    ),
                    Effect.as(true),
                    Effect.catch((e) =>
                      Effect.sync(() => {
                        console.warn(`[diag] loop: promise recovery generation failed (${e instanceof Error ? e.message : String(e)})`)
                        return false
                      })
                    )
                  )
                  if (promiseOk) {
                    text = yield* Ref.get(promiseAcc)
                    conversation = promiseMessages
                    continue
                  }
                }
              }
              if (calls.length === 0 || terminated || round >= maxToolRounds) {
                // Calls parsed but never executed (round cap / gate
                // termination): record them — she must learn next turn
                // that these did NOT run (2026-10-12).
                if (calls.length > 0) {
                  unexecutedCalls.push(...calls.map((c) => c.tool))
                  console.warn(
                    `[diag] loop: turn ends with ${calls.length} unexecuted call(s): ${calls.map((c) => c.tool).join(", ")} (terminated=${terminated} round=${round}/${maxToolRounds})`
                  )
                }
                break
              }

              // Duplicate guard (2026-10-12): exact repeats of a call that
              // already ran this turn are excluded from execution; the
              // outcome loop reads their cached result back to her.
              const dupByIndex = new Map<number, unknown>()
              const freshIndexed: Array<{ c: ParsedToolCall; i: number }> = []
              calls.forEach((c, i) => {
                const cached = callCache.get(callKey(c))
                if (cached !== undefined) dupByIndex.set(i, cached)
                else freshIndexed.push({ c, i })
              })
              if (dupByIndex.size > 0) {
                console.warn(`[diag] loop: duplicate call(s) refused this turn: ${[...dupByIndex.keys()].map((i) => calls[i]!.tool).join(", ")}`)
              }
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
                toolCalls: freshIndexed.map(({ c, i }) => ({
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
              // Surface this round's parse failures alongside the results
              // (2026-10-12): a sibling call that failed to parse must be
              // visible in this same synthesis, not only in a later report.
              for (const f of failures) {
                resultLines.push(
                  `- a tool call in your last message FAILED TO PARSE (${f.reason}) and did not run. Do not claim it happened.`
                )
              }
              for (let i = 0; i < calls.length; i++) {
                const c = calls[i]!
                const id = `${turnId}:r${round}:${i}`
                // Duplicate (2026-10-12): not executed — read the cached
                // result back so she uses it instead of repeating herself.
                const dupCached = dupByIndex.get(i)
                if (dupCached !== undefined) {
                  resultLines.push(
                    `- ${c.tool}(${JSON.stringify(c.args)}) → ALREADY RAN this exact call this turn — NOT run again. Its result was: ${JSON.stringify(dupCached).slice(0, 2000)}. Do not repeat it; use the result and move on.`
                  )
                  continue
                }
                const outcome = outcomes.get(id)
                if (outcome !== undefined) {
                  const resultJson = outcomeToJson(outcome)
                  callCache.set(callKey(c), resultJson)
                  // Class attempt detection (2026-10-12): authoring
                  // content with a class fence is an attempt in it.
                  if (c.tool === "drawer.preview" || c.tool === "drawer.edit") {
                    const authored = c.tool === "drawer.preview"
                      ? (typeof c.args["content"] === "string" ? c.args["content"] : "")
                      : (typeof c.args["newText"] === "string" ? c.args["newText"] : "")
                    if (authored.includes("```mermaid")) attemptedClasses.add("mermaid")
                    if (authored.includes("```json")) attemptedClasses.add("json")
                  }
                  executed.push({ id, tool: c.tool, result: resultJson })
                  // Include args for drawer tools (Phase I 2026-10-12): the UI
                  // needs the content to open preview spaces.
                  // DIAG 2026-10-12: log drawer tool chunks to trace UI integration.
                  if (c.tool.startsWith("drawer.")) {
                    console.warn(`[diag] ToolCall chunk: tool=${c.tool} hasArgs=${c.args !== undefined} argKeys=${c.args ? Object.keys(c.args).join(",") : "none"}`)
                  }
                  out.push({
                    _tag: "ToolCall",
                    tool: c.tool,
                    result: resultJson,
                    ...(c.tool.startsWith("drawer.") ? { args: c.args } : {}),
                  })
                  resultLines.push(
                    `- ${c.tool}(${JSON.stringify(c.args)}) → ${JSON.stringify(resultJson).slice(0, 4000)}`
                  )
                  // Read/preview truth tracking (2026-10-12): flag a
                  // preview that replays an EARLIER turn's exact text for
                  // a path whose latest doc.read returned something
                  // different — the stale-copy reopen (she re-showed the
                  // pre-restore bad version from her own history instead
                  // of the fresh read from the same turn). State goes in
                  // the tool result, where she cannot miss it.
                  if (c.tool === "doc.read") {
                    const p = c.args["path"]
                    const rc = (resultJson as { content?: unknown } | null)?.content
                    if (typeof p === "string" && typeof rc === "string") {
                      lastDocReads.set(p, rc)
                    }
                  } else if (c.tool === "drawer.preview") {
                    const p = c.args["path"]
                    const pc = c.args["content"]
                    if (typeof p === "string" && typeof pc === "string") {
                      const read = lastDocReads.get(p)
                      const prev = lastPreviews.get(p)
                      if (
                        read !== undefined &&
                        prev !== undefined &&
                        prev.turnId !== turnId &&
                        prev.content === pc &&
                        read !== pc
                      ) {
                        console.warn(`[diag] loop: stale preview flagged for ${p} (replayed an earlier turn's text; latest doc.read differs)`)
                        resultLines.push(
                          `- ⚠ drawer.preview note: the content you just previewed for ${p} is identical to a preview from an earlier turn, ` +
                          `but your most recent doc.read of ${p} returned DIFFERENT content (${read.length} chars). The file is the truth — ` +
                          `if you are reopening or re-showing it, preview the doc.read content instead. If the difference is an intentional edit, say what you changed.`
                        )
                      }
                      lastPreviews.set(p, { content: pc, turnId })
                    }
                  }
                  // Capability ledger (2026-10-11): record the execution.
                  // Outcome: succeeded unless the result is an IoError.
                  const succeeded = !(typeof resultJson === "object" && resultJson !== null && "_tag" in resultJson && resultJson._tag === "IoError")
                  yield* Effect.sync(() => recordToolCall(c.tool, succeeded ? "succeeded" : "failed", 0))
                  // Proof by use (2026-10-12): a pending capability
                  // request for THIS tool is fulfilled the first time
                  // the tool completes successfully.
                  if (succeeded) {
                    yield* Effect.sync(() => markCapabilityFulfilled(c.tool))
                  } else {
                    // Demotion (2026-10-12): a verified/fulfilled
                    // capability that fails in real use drops back to
                    // pending with the failure recorded — preflight
                    // verification is a standing claim, reality
                    // re-checks it.
                    const reason = typeof resultJson === "object" && resultJson !== null && "reason" in resultJson
                      ? String((resultJson as { reason: unknown }).reason).slice(0, 160)
                      : "tool failed in real use"
                    yield* Effect.sync(() => demoteCapability(c.tool, `failed in real use: ${reason}`))
                  }
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
                  // Capability ledger (2026-10-11): record the block.
                  yield* Effect.sync(() => recordToolCall(c.tool, "blocked", 0))
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
              lastResultLines = resultLines
              // NEVER-SILENT RULE (2026-10-12): do NOT break here on
              // `terminated` or max-rounds. The follow-up synthesis below
              // must ALWAYS run after tool execution so the model sees the
              // results — including gate blocks and tool errors — and can
              // report them to the user in prose. Breaking here left the
              // turn's final text as raw tool calls only, which the UI
              // strips to an empty bubble: AImy appeared to go silent
              // when a tool was blocked/errored. The loop-top check
              // (calls/terminated/rounds) still prevents further tool
              // EXECUTION after this synthesis — she reports, she does
              // not retry blindly.
              if (terminated || round >= maxToolRounds) {
                console.warn(
                  `[diag] loop: post-tool break pending (terminated=${terminated} round=${round}/${maxToolRounds} ` +
                  `executed=${executed.length} blocked=${blocked.map((b) => `${b.tool}: ${b.reason}`).join("; ") || "none"}) — running final synthesis so she can report`
                )
              }

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
                maxTokens: 4096
              }
              const followStreamed = streamSource(followRequest)
              const followDeltas: Stream.Stream<string, InferenceError> =
                followStreamed ??
                Stream.fromEffect(
                  pool.generate(followRequest, { mode: "powerhouse" }).pipe(Effect.map((r) => r.text))
                )
              const followAcc = yield* Ref.make("")
              // Fail-soft (2026-10-12): if the follow-up generation errors,
              // do NOT kill the turn. Keep the pre-synthesis text and let
              // the never-silent safety net below produce a report. An
              // inference hiccup must never read as AImy ignoring the user.
              const followOk = yield* followDeltas.pipe(
                Stream.runForEach((delta) =>
                  Effect.gen(function* () {
                    yield* Ref.update(followAcc, (s) => s + delta)
                    out.push({ _tag: "Token", delta })
                  })
                ),
                Effect.as(true),
                Effect.catch((e) =>
                  Effect.sync(() => {
                    console.warn(`[diag] loop: follow-up synthesis failed (${e instanceof Error ? e.message : String(e)}); safety net will handle the report`)
                    return false
                  })
                )
              )
              if (followOk) {
                text = yield* Ref.get(followAcc)
                conversation = followMessages
              }
            }

            // ── NEVER-SILENT SAFETY NET (2026-10-12) ──────────────────
            // If the turn is about to end with text that is ONLY tool
            // calls (the UI strips them → empty bubble → AImy appears to
            // ignore the user) while tools actually ran, force one final
            // synthesis so she reports what happened — success, error, or
            // block — in prose. If even that fails, fall back to a plain
            // generated summary. Silence is never an acceptable outcome
            // for a turn that did work.
            // Scanner-based strip (2026-10-12): balanced tool blocks are
            // removed whole; an unterminated block's tail is JSON debris,
            // NOT prose — a regex strip once counted that debris as an
            // answer and let a truncated turn end in silence.
            const proseRemainder = stripToolBlocks(text).trim()
            // Exempt: a turn whose only executed tool is narrate — she DID
            // respond, via voice (chat intentionally holds no bubble).
            const onlyNarrated = executed.length > 0 && executed.every((e) => e.tool === "narrate") && blocked.length === 0
            if (proseRemainder === "" && !onlyNarrated && (executed.length > 0 || blocked.length > 0 || parseNotes.length > 0)) {
              console.warn(
                `[diag] loop: safety net — turn would end silent (tool-only text). ` +
                `executed=${executed.map((e) => e.tool).join(",") || "none"} blocked=${blocked.map((b) => b.tool).join(",") || "none"}`
              )
              const netMessages: ReadonlyArray<Message> = [
                ...conversation,
                { role: "assistant", content: text },
                {
                  role: "user",
                  content:
                    `Tool results from your last actions:\n${[...lastResultLines, ...parseNotes].join("\n")}\n\n` +
                    `You have not yet answered the user in prose. Answer now, in plain language: ` +
                    `say what you tried, what happened (including any errors or blocks, honestly), ` +
                    `and what it means for their request. Do not call any more tools.`
                }
              ]
              const netRequest: GenerateRequest = { messages: netMessages, params: {}, maxTokens: 1024 }
              netForced = true
              // Instrumented (2026-10-12): the net's outcome is classified
              // and logged — an earlier silent catch hid WHY reports came
              // back empty (error vs empty vs tool-only) for a whole UAT.
              const netOutcome = yield* pool.generate(netRequest, { mode: "powerhouse" }).pipe(
                Effect.map((r) => ({ ok: true as const, text: r.text, error: "" })),
                Effect.catch((e) =>
                  Effect.succeed({ ok: false as const, text: "", error: e instanceof Error ? e.message : String(e) })
                )
              )
              if (!netOutcome.ok) {
                console.warn(`[diag] loop: safety net report generation ERRORED (${netOutcome.error}) — fallback will ship`)
              }
              const netText = netOutcome.text
              const netProse = stripToolBlocks(netText).trim()
              console.warn(`[diag] loop: safety net report ok=${netOutcome.ok} chars=${netText.length} proseChars=${netProse.length}`)
              if (netProse !== "") {
                text = netText
                out.push({ _tag: "Token", delta: netText })
              } else {
                if (netOutcome.ok && netText.trim() !== "") {
                  console.warn(`[diag] loop: safety net report was tool-only text — treating as no report (she still has not answered in prose)`)
                }
                netFallbackUsed = true
                const fallback = blocked.length > 0
                  ? `I tried to do that, but I was blocked: ${blocked.map((b) => `${b.tool} (${b.reason})`).join(", ")}. Nothing was shown. Tell me how you'd like to proceed.`
                  : `I ran ${executed.map((e) => e.tool).join(", ")} for that, but I didn't produce a summary of the results. Ask me about them and I'll walk through what came back.`
                text = fallback
                out.push({ _tag: "Token", delta: fallback })
              }
            }

            // Record this turn's class attempts (2026-10-12).
            for (const cls of attemptedClasses) {
              appendTrackRecord(cls, "attempt")
            }
            if (attemptedClasses.size > 0) {
              console.log(`[aimy] track record: attempts recorded for ${[...attemptedClasses].join(", ")}`)
            }
            // Hand the failure to her next turn (2026-10-12): if the net
            // had to force this report, the fallback shipped, or calls
            // were left unexecuted, the next system prompt says so —
            // with these facts — so she can find another way instead of
            // repeating the pattern. An unkept promise counts too: it is
            // re-derived from the turn's FINAL text, so a promise she
            // kept in the recovery round (or retracted with an honest
            // close) records nothing.
            const finalUnkeptPromise =
              unkeptPromise !== null ? findUnkeptPromise(text) : null
            if (netForced || unexecutedCalls.length > 0 || finalUnkeptPromise !== null) {
              lastTurnDegraded = {
                sessionId,
                executedTools: executed.map((e) => e.tool),
                unexecuted: [...unexecutedCalls],
                usedFallback: netFallbackUsed,
                forcedReport: netForced,
                unkeptPromise: finalUnkeptPromise,
              }
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
                // Feed the silence memory (2026-10-12): the NEXT turn's
                // prompt tells her she was silent — and whether a tool
                // call format failure is the likely cause — so she
                // recovers instead of insisting she was talking.
                lastTurnSilent = {
                  sessionId,
                  formatFailed: parseFailures.length > 0 || text.includes("<tool_call")
                }
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
        // 5 rounds (2026-10-12, was 3): narrate + a state check + a read
        // + an edit + the report did not fit in 3 — turns died mid-chain
        // with calls unexecuted. Duplicates are refused, so extra rounds
        // buy completion, not loops.
        maxToolRounds: opts?.maxToolRounds ?? 5,
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
        maxToolRounds: opts?.maxToolRounds ?? 5,
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
        maxToolRounds: opts?.maxToolRounds ?? 5
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
