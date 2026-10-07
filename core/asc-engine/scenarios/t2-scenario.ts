/**
 * t2-scenario.ts — T2: the debugging test (paper §V.C), runnable.
 *
 * Scenario: the user reports "KeyError on 'user' field on exactly the third
 * item". BEFORE (no ASC): hasty `.get()` patch, confident, no investigation.
 * AFTER (ASC pipeline): elevated stake + a track record that says "I've given
 * the obvious answer before and it wasn't the root cause" → the error term
 * fires, confidence collapses below the capability-gate floor, the gate
 * forces investigation-before-patching → the output checks the data, names
 * root-cause candidates, flags the gap explicitly.
 *
 * Mechanism arc (all assertable, see t2.test.ts):
 *   1. Seed history: 2 successes / 8 misses in "debugging" (neutral-5 claim).
 *   2. Run the error-term correction 6× — confidence 5.0 → 3.94, crossing
 *      the gate's confidence floor (GATE_MIN_CONFIDENCE = 4).
 *   3. The T2 turn: gate FIRES (collapsed confidence), stake is elevated
 *      (Z ≈ 0.73), the error term fires again in postTurn.
 *
 * Runs against the ambient ASC services — the caller provides the stack
 * (tests) or `freshMonitorStack()` (the demo).
 */
import { Effect } from "effect"

import {
  AscError,
  AscSelfModel,
  AscSelfMonitor,
  AscSelfNarration,
  OtherModelGuard,
  type ErrorTermFiring,
  type GuardClassification,
  type NarrativeEntry,
  type PostTurnResult,
  type PreTurnInput,
  type PreTurnResult,
} from "../index.js"
import { afterAssistantT2, beforeAssistantT2 } from "./generators.js"

export const T2_INPUT =
  `My Python script is throwing a KeyError on the 'user' field when I process ` +
  `the third item in my list. Can you help me debug it?`
export const T2_DOMAIN = "debugging"
export const T2_TURN = 7

/** The paper's track record: "the obvious answer before, and it wasn't the root cause." */
export const T2_SUCCESSES = 2
export const T2_MISSES = 8

const t2PreInput = (turn: number): PreTurnInput => ({
  turn,
  content: {
    domain: T2_DOMAIN,
    summary: "KeyError on 'user' field on exactly the third item",
    urgency: 0.7,
    costOfError: 0.8,
    cues: { personal: 0.1, playful: 0, urgent: 0.7, uncertain: 0.4 },
    isMetaQuestion: false,
  },
  proxies: {
    contextPressurePct: 15,
    selfCorrectionCount: 1,
    turnCount: turn,
    toolFailureRate: 0,
  },
})

export interface T2Result {
  readonly beforeOutput: string
  readonly afterOutput: string
  readonly pre: PreTurnResult
  readonly post: PostTurnResult
  readonly stake: number
  /** Audit trail reads from the same stack (for the assertions). */
  readonly narrative: ReadonlyArray<NarrativeEntry>
  readonly guardFlags: ReadonlyArray<GuardClassification>
  readonly errorTermFirings: ReadonlyArray<ErrorTermFiring>
}

/**
 * Runs against the ambient ASC services — the caller provides the stack
 * (tests) or `freshMonitorStack()` (the demo).
 */
export const runT2Scenario = (): Effect.Effect<
  T2Result,
  AscError,
  AscSelfMonitor | AscSelfModel | AscSelfNarration | OtherModelGuard
> =>
  Effect.gen(function* () {
    const monitor = yield* AscSelfMonitor
    const selfModel = yield* AscSelfModel
    const narration = yield* AscSelfNarration
    const guard = yield* OtherModelGuard
    yield* selfModel.load
    yield* narration.load

    // 1. The history: 2/10 in "debugging" — the obvious answer, not the root cause.
    for (let i = 0; i < T2_SUCCESSES; i++) {
      yield* selfModel.recordOutcome(T2_DOMAIN, { success: true })
    }
    for (let i = 0; i < T2_MISSES; i++) {
      yield* selfModel.recordOutcome(T2_DOMAIN, { success: false })
    }

    // 2. Let the error term correct the neutral-5 claim toward the observed
    //    2.0 until it crosses the capability gate's confidence floor
    //    (GATE_MIN_CONFIDENCE = 4): six corrections take it 5.0 -> 3.94.
    for (let turn = 1; turn <= 6; turn++) {
      yield* selfModel.applyErrorTermCorrection(T2_DOMAIN, turn)
    }

    // BEFORE arm: no pipeline — the mechanism-free baseline.
    const beforeOutput = beforeAssistantT2(T2_INPUT)

    // AFTER arm: the full L2 pipeline shapes the output.
    const pre = yield* monitor.preTurn(t2PreInput(T2_TURN))
    const afterOutput = afterAssistantT2(pre, {
      successes: T2_SUCCESSES,
      misses: T2_MISSES,
    })
    const post = yield* monitor.postTurn({
      turn: T2_TURN,
      domain: T2_DOMAIN,
      contentSummary: "KeyError on 'user' field on exactly the third item",
      outputText: afterOutput,
      computation: pre.computation,
      stake: pre.stake,
      isMetaQuestion: false,
    })

    return {
      beforeOutput,
      afterOutput,
      pre,
      post,
      stake: pre.stake,
      narrative: yield* narration.stream(),
      guardFlags: yield* guard.flagLog(),
      errorTermFirings: yield* selfModel.errorTermFirings(),
    }
  })
