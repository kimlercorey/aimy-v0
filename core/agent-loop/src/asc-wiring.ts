/**
 * asc-wiring.ts — Track 4: wire the ASC per-turn pipeline into the agent loop.
 *
 * Additive wiring, mirroring the M3 honesty pattern (`layerAgentLoopWithHonesty`
 * in loop.ts): nothing in the loop's turn flow is restructured. Two integration
 * points, mapped onto the canonical hook sequence
 * (prepareNextTurn -> prepareRequest -> transformContext -> tool calls ->
 * finishTurn -> follow-ups):
 *
 *   - prepareRequest point: `runPreTurnAsc` runs `AscSelfMonitor.preTurn`
 *     after the user message is appended and before the inference request is
 *     dispatched.
 *   - finishTurn point: `runPostTurnAsc` runs `AscSelfMonitor.postTurn`
 *     after the turn body completes and BEFORE the `Done` chunk is emitted —
 *     the loop never emits completion before the audit settles (settled =
 *     post-turn audit complete + DialComputation archived by preTurn).
 *
 * Abort discipline: the stream carries an `ensuring` finalizer (see loop.ts).
 * If the turn ends before the finishTurn audit ran (interrupt, generation
 * failure), the finalizer runs the audit marked `partial` — the loop never
 * skips the post-turn audit on abort.
 *
 * Seam contracts honored: the loop NEVER writes dials directly. The only
 * dial writer is `AscSelfMonitor.preTurn` via `DialState.applyPipelineDials`
 * (seam S7); the loop only READS pipeline results onto the turn report.
 */
import { Effect } from "effect"

import {
  type AscSelfMonitorShape,
  type ContentAnalysis,
  type PostTurnInput,
  type PreTurnResult,
  type PostTurnResult,
  type ProxyReadings,
  AscError
} from "../../asc-engine/index.js"

/**
 * What the loop attaches to the turn's `Done` chunk when wired with ASC.
 * Pure data — the Foldkit UI renders it in M8; no UI code here.
 */
export interface TurnAscReport {
  readonly pre: PreTurnResult
  readonly post: PostTurnResult
}

/** M5 ASC wiring options for `layerAgentLoopWithAsc` (Track 4). */
export interface AgentLoopAscOpts {
  /**
   * Override the baseline proxy readings (tests/demos — e.g. simulate a
   * session with recent tool failures). Defaults: all quiet
   * (`contextPressurePct: 0, selfCorrectionCount: 0, toolFailureRate: 0`;
   * `turnCount` always comes from the session history).
   */
  readonly proxyOverrides?: Partial<ProxyReadings> | undefined
}

/**
 * Heuristic content analysis: user text -> the `ContentAnalysis` the L2
 * pipeline needs. Deterministic and deliberately simple — keyword-driven,
 * documented as a heuristic (like `estimateRegisterFromText`). A real
 * deployment routes this through the aux model; the shape stays the same.
 */
export const analyzeContent = (input: string): ContentAnalysis => {
  const lower = input.toLowerCase()
  const has = (...words: ReadonlyArray<string>): boolean =>
    words.some((w) => lower.includes(w))

  let domain = "general"
  if (/(keyerror|traceback|stack trace|segfault|null ?pointer|panic:|debug(ging)?)/.test(lower)) {
    domain = "debugging"
  } else if (/(build|compil(e|ing|er)|linker|webpack|bundl)/.test(lower)) {
    domain = "build"
  } else if (/(regex|regular expression)/.test(lower)) {
    domain = "regex"
  } else if (/(how do you feel|how are you|your dials|show me your)/.test(lower)) {
    domain = "meta"
  }

  const isMetaQuestion = /(how (do you|you) feel|how are you feeling|show me your dials|what are your dials)/.test(lower)

  const urgency = has("urgent", "asap", "crash", "production is down", "blocking", "right now")
    ? 0.9
    : has("quick", "routine", "curious", "just wondering")
      ? 0.2
      : 0.4
  const costOfError = has("production", "deploy", "data loss", "irreversible", "money")
    ? 0.85
    : has("routine", "curious", "just wondering", "toy")
      ? 0.25
      : 0.5

  return {
    domain,
    summary: input.slice(0, 80),
    urgency,
    costOfError,
    cues: {
      personal: has("i feel", "my wife", "my team", "personal", "going through") ? 0.7 : 0.1,
      playful: has("haha", "fun", "playful", "joke") ? 0.7 : 0.1,
      urgent: urgency,
      uncertain: /(\bnot sure\b|\bunsure\b|\bmaybe\b|\bmight\b|\bcould be\b)/.test(lower) ? 0.6 : 0.1
    },
    isMetaQuestion
  }
}

/** Baseline proxy readings for a loop turn; `turnCount` comes from history. */
export const proxiesForTurn = (
  turnCount: number,
  overrides?: Partial<ProxyReadings> | undefined
): ProxyReadings => ({
  contextPressurePct: overrides?.contextPressurePct ?? 0,
  selfCorrectionCount: overrides?.selfCorrectionCount ?? 0,
  turnCount,
  toolFailureRate: overrides?.toolFailureRate ?? 0
})

export interface PreTurnAscOpts {
  readonly turn: number
  readonly input: string
  readonly proxyOverrides?: Partial<ProxyReadings> | undefined
}

export interface PreTurnAscResult {
  readonly pre: PreTurnResult
  readonly analysis: ContentAnalysis
}

/**
 * The prepareRequest point: analyze the input, run the L2 pre-turn pipeline.
 * The pipeline (and only the pipeline) writes the live dial vector.
 */
export const runPreTurnAsc = (
  monitor: AscSelfMonitorShape,
  opts: PreTurnAscOpts
): Effect.Effect<PreTurnAscResult, AscError> =>
  Effect.gen(function* () {
    const analysis = analyzeContent(opts.input)
    const pre = yield* monitor.preTurn({
      turn: opts.turn,
      content: analysis,
      proxies: proxiesForTurn(opts.turn - 1, opts.proxyOverrides)
    })
    return { pre, analysis }
  })

export interface PostTurnAscOpts {
  readonly pre: PreTurnResult
  readonly analysis: ContentAnalysis
  readonly turn: number
  readonly outputText: string
  readonly partial?: boolean | undefined
  readonly abortNote?: string | undefined
}

/**
 * The finishTurn point: run the post-turn audit over the turn's output.
 * Returns the `{ pre, post }` report the loop attaches to `Done`.
 */
export const runPostTurnAsc = (
  monitor: AscSelfMonitorShape,
  opts: PostTurnAscOpts
): Effect.Effect<TurnAscReport, AscError> =>
  Effect.gen(function* () {
    const postInput: PostTurnInput = {
      turn: opts.turn,
      domain: opts.pre.computation.inputs.domain,
      contentSummary: opts.pre.computation.inputs.contentSummary,
      outputText: opts.outputText,
      computation: opts.pre.computation,
      stake: opts.pre.stake,
      isMetaQuestion: opts.analysis.isMetaQuestion,
      partial: opts.partial ?? false,
      abortNote: opts.abortNote
    }
    const post: PostTurnResult = yield* monitor.postTurn(postInput)
    return { pre: opts.pre, post }
  })
