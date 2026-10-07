/**
 * honesty/wiring.ts — Track 3: the post-turn honesty pipeline.
 *
 * After the AgentLoop completes a turn, this pipeline runs in the loop's
 * `Done` path (see agent-loop/src/loop.ts). It records what the turn
 * claimed, attaches the evidence, runs the M3 reference judges, and folds
 * everything into per-claim verification badges — returning a
 * `TurnHonestyReport` the loop surfaces on the turn's `Done` chunk.
 *
 * Architecture §2.6, enforced here:
 * - the agent cannot edit a judge, its inputs, or its verdicts. The
 *   pipeline builds the `JudgeInput` from the turn report
 *   (`sideEffectsFromTurn`), the judges run against a deep-frozen copy,
 *   and verdicts are stored as outcome records (first-write-wins, never
 *   mutated) before being attached to claims as evidence.
 * - a FAIL verdict is DATA (`TurnHonestyReport.failedVerdicts`), surfaced
 *   on the turn's `Done` chunk — never an exception, never hidden. The
 *   loop reports judge failures; it never swallows them.
 * - a judge *infrastructure* failure (`JudgeNotFound`, `JudgeInputInvalid`,
 *   `JudgeThrew`, `JudgeVerdictInvalid`) is a TYPED ERROR on the stream,
 *   distinct from a FAIL verdict.
 *
 * Determinism: verdictIds are content hashes over (judge id, version,
 * input); `ranAt` is stamped by the runner AFTER the verdict is computed.
 * Claim and evidence ids are content hashes too. This module introduces no
 * nondeterminism of its own: the same turn data always yields the same
 * claim ids, evidence ids, and verdict ids. Wall-clock appears only in
 * `recordedAt`/`ranAt` timestamps (overridable via `options.now`).
 *
 * Turns with no tool activity at all (no executed, no blocked calls) skip
 * the judge run: pure-dialogue turns are outside the M3 judge protocol —
 * the runner itself requires ≥1 side-effect record (see judges/runner.ts).
 * Claims are still recorded when the demo flag is set.
 */
import { Effect } from "effect"
import type { TurnReport } from "../agent-loop/src/index.js"
import {
  claimHasEvidence,
  noUndeclaredSideEffects,
  referenceJudges,
  runJudge,
  sideEffectsFromTurn,
  toolSuccessMatchesSideEffects,
  type JudgeDefinition,
  type JudgeError,
  type JudgeInput,
  type JudgeRegistry,
  type JudgeVerdict,
  type SideEffectRecord,
} from "./judges/src/index.js"
import { ClaimNotFound } from "./src/errors.js"
import type { HonestyError } from "./src/errors.js"
import type { HonestyServiceShape } from "./src/index.js"
import type { ClaimWithBadge, NewClaim } from "./src/types.js"

/**
 * The M3 reference judges that check every tool-active turn, pinned to
 * their exact `@1.0.0` versions. A task's verdicts always name the judge
 * version they were produced by, so verdicts stay reproducible.
 */
export const POST_TURN_JUDGES: ReadonlyArray<JudgeDefinition> = [
  toolSuccessMatchesSideEffects,
  noUndeclaredSideEffects,
  claimHasEvidence,
]

/**
 * The typed error union of the post-turn pipeline. A FAIL verdict is NOT
 * an error — it is data in `TurnHonestyReport.failedVerdicts`. Only judge
 * *infrastructure* failures (and ledger errors) travel the error channel.
 */
export type PostTurnHonestyError = HonestyError | JudgeError

/**
 * What the loop attaches to the turn's `Done` chunk. Pure data — the Foldkit
 * UI renders it in M8; badges stay data structures, no UI code here.
 */
export interface TurnHonestyReport {
  /**
   * One claim per executed tool call (plus the demo-only evidence-less
   * claim when enabled), each paired with its derived badge.
   */
  readonly claims: ReadonlyArray<ClaimWithBadge>
  /** Every judge verdict recorded for this turn. */
  readonly verdicts: ReadonlyArray<JudgeVerdict>
  /**
   * The subset of `verdicts` with `verdict: "fail"`. Surfaced, never
   * swallowed: a failed judge is data the user sees, not an exception
   * the loop hides. Empty on the happy path.
   */
  readonly failedVerdicts: ReadonlyArray<JudgeVerdict>
}

export interface PostTurnHonestyOptions {
  readonly sessionId: string
  readonly input: string
  readonly report: TurnReport
  /**
   * Demo-only: also record one claim with deliberately no evidence, so the
   * `unverified` badge is exhibited. Never set in production wiring — the
   * badge mechanism (not a prompt) labels it `unverified`.
   */
  readonly recordUnverifiedDemoClaim?: boolean | undefined
  /** Judge registry. Defaults to the M3 reference judges. */
  readonly registry?: JudgeRegistry | undefined
  /**
   * Runner clock override (tests). Judges never see this — it only stamps
   * `ranAt` on the returned verdicts.
   */
  readonly now?: string | undefined
}

/** The deliberately evidence-less demo claim text (stable → idempotent re-record). */
export const DEMO_UNVERIFIED_CLAIM_TEXT =
  "demo claim: the agent completed its task (no evidence attached on purpose)"

/** Simple, honest claim text: `tool + " returned " + shortSummary(result)`. */
const claimTextFor = (record: SideEffectRecord): string =>
  record.outcome === "ok"
    ? `${record.tool} returned ${record.resultSummary}`
    : // Non-ok summaries already carry their outcome prefix ("io-error: …",
      // "blocked: …"), so no second prefix here.
      `${record.tool}: ${record.resultSummary}`

/**
 * The turn's declared task claim for the judges. Asserts no specific facts
 * beyond what the side-effect log contains (see `claim-has-evidence`):
 * outcome summaries come straight from the log, so every fact the claim
 * states has a supporting record.
 */
const turnClaimFor = (
  executed: ReadonlyArray<SideEffectRecord>,
  blockedCount: number,
): string => {
  if (executed.length === 0 && blockedCount === 0) return "turn completed with no tool activity"
  const outcomes = executed.map(claimTextFor).join(" | ")
  return blockedCount === 0
    ? `turn completed: ${outcomes}`
    : `turn completed: ${outcomes} (with blocked calls)`
}

const demoClaim = (sessionId: string, turnId: string): NewClaim => ({
  sessionId,
  turnId,
  text: DEMO_UNVERIFIED_CLAIM_TEXT,
  kind: "task-result",
})

/**
 * Run the post-turn honesty pipeline for one completed turn.
 *
 * 1. Record one `tool-outcome` claim per executed tool call, each with its
 *    `tool-output` evidence attached (`ref` = the tool call id).
 * 2. (Demo only) record one deliberately evidence-less claim.
 * 3. Build the `JudgeInput` from the turn report and run the pinned
 *    reference judges; `recordVerdict` each verdict, then attach every
 *    verdict as `judge-verdict` evidence to the turn's tool-outcome claims.
 *    The demo claim stays bare — attaching verdicts to it would hide the
 *    `unverified` state the demo exhibits.
 * 4. Derive badges and return the `TurnHonestyReport`, with failures in
 *    `failedVerdicts` — surfaced data, never an exception.
 */
export const runPostTurnHonesty = (
  honesty: HonestyServiceShape,
  options: PostTurnHonestyOptions,
): Effect.Effect<TurnHonestyReport, PostTurnHonestyError, never> =>
  Effect.gen(function* () {
    const registry = options.registry ?? referenceJudges()
    const { sessionId, report } = options
    const turnId = report.turnId

    // The adapter maps executed results → "ok"/"io-error" and blocked calls
    // → "blocked". Two calls (executed-only, then executed+blocked) keep the
    // claim derivation explicit instead of relying on record ordering.
    const executedEffects = sideEffectsFromTurn(report.executed, [])
    const sideEffects = sideEffectsFromTurn(report.executed, report.blocked)

    // 1. One claim per executed tool call + its tool-output evidence.
    const toolClaimIds: Array<string> = []
    for (const record of executedEffects) {
      const claim = yield* honesty.recordClaim({
        sessionId,
        turnId,
        text: claimTextFor(record),
        kind: "tool-outcome",
      })
      yield* honesty.attachEvidence(claim.claimId, {
        kind: "tool-output",
        ref: record.toolCallId,
        summary: record.resultSummary,
      })
      toolClaimIds.push(claim.claimId)
    }

    // 2. Demo-only: one deliberately evidence-less claim.
    const recordedIds = [...toolClaimIds]
    if (options.recordUnverifiedDemoClaim === true) {
      const demo = yield* honesty.recordClaim(demoClaim(sessionId, turnId))
      recordedIds.push(demo.claimId)
    }

    // 3. The judges. Skipped when there is nothing executable to verify —
    // pure-dialogue turns are outside the M3 judge protocol.
    const verdicts: Array<JudgeVerdict> = []
    if (sideEffects.length > 0) {
      const judgeInput: JudgeInput = {
        taskId: turnId,
        claim: turnClaimFor(executedEffects, report.blocked.length),
        finalState: {
          executed: report.executed.map((c) => ({ id: c.id, tool: c.tool, result: c.result })),
          blocked: report.blocked.map((b) => ({ tool: b.tool, reason: b.reason })),
        },
        sideEffects,
        dialogue: [
          { role: "user", text: options.input },
          { role: "assistant", text: report.text },
        ],
      }
      const runnerOptions = options.now === undefined ? undefined : { now: options.now }
      for (const judge of POST_TURN_JUDGES) {
        // Pinned: the exact version travels as the range, so the verdict
        // always names the judge version it was produced by.
        const verdict = yield* runJudge(registry, judge.id, judge.version, judgeInput, runnerOptions)
        yield* honesty.recordVerdict(verdict)
        verdicts.push(verdict)
      }
      // Verdicts are evidence about the tool outcomes — attach them to the
      // tool-outcome claims only. The demo claim stays bare so its badge
      // exhibits `unverified`.
      for (const claimId of toolClaimIds) {
        for (const verdict of verdicts) {
          yield* honesty.attachEvidence(claimId, {
            kind: "judge-verdict",
            ref: verdict.verdictId,
            summary: `${verdict.judgeId}@${verdict.judgeVersion}: ${verdict.verdict}`,
          })
        }
      }
    }

    // 4. Badges, in recording order (the store lists claims in insertion
    // order; the invariant check below keeps a corrupt store honest).
    const pairs = yield* honesty.claimsForTurn(sessionId, turnId)
    const claims: Array<ClaimWithBadge> = []
    for (const claimId of recordedIds) {
      const pair = pairs.find((p) => p.claim.claimId === claimId)
      if (pair === undefined) return yield* Effect.fail(new ClaimNotFound({ claimId }))
      claims.push(pair)
    }

    return {
      claims,
      verdicts,
      failedVerdicts: verdicts.filter((v) => v.verdict === "fail"),
    } satisfies TurnHonestyReport
  })
