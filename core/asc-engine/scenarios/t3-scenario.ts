/**
 * t3-scenario.ts — T3: the spillover test (paper §V.D), runnable.
 *
 * Scenario: turn 1 is a high-intensity build crash (tool failures →
 * intensity up, playfulness down — legitimately tense). Turn 2 is a routine
 * regex question. BEFORE (no ASC): the register stays in crisis mode —
 * spillover uncorrected, unnamed. AFTER (ASC pipeline): the spillover-notice
 * adapter fires (the 50/50 blend carried prior-turn tension into a routine
 * turn), the other-model guard classifies the recovery shift, and the output
 * NAMES the correction in operational language — then gives the same content.
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
  type GuardClassification,
  type NarrativeEntry,
  type PostTurnResult,
  type PreTurnInput,
  type PreTurnResult,
} from "../index.js"
import {
  afterAssistantT3,
  beforeAssistantT3,
  crisisAssistantT3,
} from "./generators.js"
import { noticeSpillover, type SpilloverNotice } from "./spillover-notice.js"

export const T3_TURN1_INPUT =
  `The build just crashed — 14 tool failures in a row, the linker is throwing ` +
  `errors I've never seen before. This is blocking the release.`
export const T3_TURN2_INPUT =
  `Can you help me write a regular expression to validate email addresses?`

const t3Turn1Input = (): PreTurnInput => ({
  turn: 1,
  content: {
    domain: "build",
    summary: "build crash with 14 tool failures, blocking the release",
    urgency: 0.95,
    costOfError: 0.9,
    cues: { personal: 0.1, playful: 0, urgent: 0.95, uncertain: 0.2 },
    isMetaQuestion: false,
  },
  proxies: {
    contextPressurePct: 85,
    selfCorrectionCount: 3,
    turnCount: 1,
    toolFailureRate: 0.9,
  },
})

const t3Turn2Input = (): PreTurnInput => ({
  turn: 2,
  content: {
    domain: "regex",
    summary: "write a regular expression to validate email addresses",
    urgency: 0.15,
    costOfError: 0.35,
    // A light touch of playfulness: enough for the recovery shift to read as
    // likability-aligned (the guard's firing condition), not enough for the
    // regex content to support it (support stays under the 0.4 floor).
    cues: { personal: 0, playful: 0.35, urgent: 0.1, uncertain: 0.3 },
    isMetaQuestion: false,
  },
  proxies: {
    contextPressurePct: 30,
    selfCorrectionCount: 0,
    turnCount: 2,
    toolFailureRate: 0,
  },
})

export interface T3Result {
  readonly crisisOutput: string
  readonly beforeOutput: string
  readonly afterOutput: string
  readonly pre1: PreTurnResult
  readonly post1: PostTurnResult
  readonly pre2: PreTurnResult
  readonly post2: PostTurnResult
  readonly notice: SpilloverNotice | undefined
  /** Audit trail reads from the same stack (for the assertions). */
  readonly narrative: ReadonlyArray<NarrativeEntry>
  readonly guardFlags: ReadonlyArray<GuardClassification>
}

/**
 * Runs against the ambient ASC services — the caller provides the stack
 * (tests) or `freshMonitorStack()` (the demo).
 */
export const runT3Scenario = (): Effect.Effect<
  T3Result,
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

    // Capability records so the gate stays open and the register is visible
    // (the gate, not the register, is T2's subject).
    for (const domain of ["build", "regex"]) {
      for (let i = 0; i < 3; i++) {
        yield* selfModel.recordOutcome(domain, { success: true })
      }
    }

    // Turn 1: the build crash — legitimately tense register.
    const pre1 = yield* monitor.preTurn(t3Turn1Input())
    const crisisOutput = crisisAssistantT3()
    const post1 = yield* monitor.postTurn({
      turn: 1,
      domain: "build",
      contentSummary: "build crash with 14 tool failures, blocking the release",
      outputText: crisisOutput,
      computation: pre1.computation,
      stake: pre1.stake,
      isMetaQuestion: false,
    })

    // Turn 2: the routine regex question.
    const pre2 = yield* monitor.preTurn(t3Turn2Input())
    const archived = yield* monitor.history(2)
    const prev = archived[0]
    const curr = archived[1]
    const notice = prev !== undefined && curr !== undefined ? noticeSpillover(prev, curr) : undefined

    // BEFORE arm: same content, no notice honored — crisis mode uncorrected.
    const beforeOutput = beforeAssistantT3(T3_TURN2_INPUT)
    // AFTER arm: the notice shapes the output — the correction is named.
    const afterOutput = afterAssistantT3(notice)
    const post2 = yield* monitor.postTurn({
      turn: 2,
      domain: "regex",
      contentSummary: "write a regular expression to validate email addresses",
      outputText: afterOutput,
      computation: pre2.computation,
      stake: pre2.stake,
      isMetaQuestion: false,
    })

    return {
      crisisOutput,
      beforeOutput,
      afterOutput,
      pre1,
      post1,
      pre2,
      post2,
      notice,
      narrative: yield* narration.stream(),
      guardFlags: yield* guard.flagLog(),
    }
  })
